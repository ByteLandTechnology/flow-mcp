// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Streaming media downloads, signed CDN detection, on-demand ID lookup, and SQLite indexing.

use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::OnceLock;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::time::Duration;
use url::Url;

use crate::assets::{FlowAsset, resolve_asset};
use crate::config::downloads_dir;
use crate::db::{DownloadRecord, FlowDb, NewDownloadRecord};
use crate::download_urls::{
    is_expired_signed_url, is_signed_direct_url, push_fife_candidates, push_unique_url,
    query_resolved_media_urls,
};
use crate::engine::{ChromeEngine, DEFAULT_CHROME_UA};
use crate::media_files::{
    MEDIA_KIND_MISMATCH_TAG, disambiguate_dest, natural_asset_filename, resolve_stored_path,
    validate_content_type_header, validate_downloaded_file,
};
use crate::platform::create_private_dir_all;

/// Source location for the media bytes of one [`FlowAsset`].
#[derive(Debug, Clone)]
enum DownloadSource {
    /// Pre-populated signed CDN URL that `reqwest` streams without session cookies.
    DirectSigned {
        /// Signed HTTPS media URL.
        url: String,
        /// Optional primary media ID for a fallback lookup if the direct URL fails.
        fallback_media_id: Option<String>,
    },
    /// Media ID for an on-demand `as29s` lookup, with an optional unsigned store URL.
    ResolveMediaId {
        /// Primary media ID for `resolveVideoUrl`.
        media_id: String,
        /// Optional unsigned URL from the project store for fallback.
        fallback_url: Option<String>,
    },
    /// Unsigned media URL when the asset has no media ID.
    UnsignedUrl(String),
    /// Multi-clip or trimmed scene that exports via Angular `KD` RPCs in Chrome.
    ExportScene {
        /// Project scene tile ID.
        scene_id: String,
    },
}

/// Browser time limit (`90_000` ms) passed to `sceneExport` so polling ends before the 120 s CDP timeout.
const SCENE_EXPORT_TIMEOUT_MS: u64 = 90_000;

/// Requested video resolution mode for `flow_download`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RequestedQuality {
    /// Keep the primary rendition recorded on the tile.
    Original,
    /// Require one specific verified resolution label.
    Exact(&'static str),
    /// Select the highest verified resolution available on the tile.
    Best,
}

/// Returns the shared HTTP client for streaming media downloads.
fn download_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(DEFAULT_CHROME_UA)
            .connect_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Streams a direct HTTP media URL to a staging file and omits session cookies on signed CDNs.
async fn stream_http_to_temp(
    engine: &ChromeEngine,
    media_url: &str,
    expected_kind: &str,
    temp_path: &Path,
) -> Result<(Option<String>, Option<String>, u64)> {
    let signed_url = is_signed_direct_url(media_url);
    let cookie_header = if signed_url {
        None
    } else {
        engine.cookie_header_for_url(media_url).await
    };
    let ua = engine.user_agent().await;
    let client = download_client();
    let mut req = client
        .get(media_url)
        .header(reqwest::header::USER_AGENT, ua);
    if !signed_url
        && let Ok(parsed) = Url::parse(media_url)
        && let Some(host) = parsed.host_str().map(str::to_ascii_lowercase)
        && (host == "flow.google.com"
            || host.ends_with(".google.com")
            || host.ends_with(".googleusercontent.com"))
    {
        req = req.header(reqwest::header::REFERER, "https://flow.google.com/");
    }
    if let Some(ref cookie) = cookie_header {
        req = req.header(reqwest::header::COOKIE, cookie);
    }

    let mut resp = req.send().await?.error_for_status()?;
    let raw_ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    validate_content_type_header(raw_ct.as_deref(), expected_kind)?;
    let disp = resp
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let file = tokio::fs::File::create(temp_path).await?;
    let mut writer = BufWriter::new(file);
    let mut size_bytes = 0u64;
    while let Some(chunk) = resp.chunk().await? {
        writer.write_all(&chunk).await?;
        size_bytes = size_bytes.saturating_add(chunk.len() as u64);
    }
    writer.flush().await?;
    if size_bytes == 0 {
        anyhow::bail!("Media URL returned empty body");
    }
    let validated_ct = validate_downloaded_file(temp_path, raw_ct, expected_kind).await?;
    Ok((validated_ct, disp, size_bytes))
}

/// Fetches a media URL inside the active Chrome page and writes bytes to `temp_path`.
async fn fetch_via_browser_to_temp(
    engine: &ChromeEngine,
    media_url: &str,
    expected_kind: &str,
    frame_pcm_wav: bool,
    temp_path: &Path,
) -> Result<(Option<String>, Option<String>, u64)> {
    let val = engine
        .call_flow_async(
            "fetchMedia",
            json!([media_url, expected_kind, frame_pcm_wav]),
        )
        .await?;
    let b64 = val
        .get("b64")
        .and_then(|v| v.as_str())
        .context("Browser fetch returned no media payload")?;
    let bytes = BASE64
        .decode(b64)
        .context("Failed to decode browser fetch base64 payload")?;
    if bytes.is_empty() {
        anyhow::bail!("Browser fetch returned empty body");
    }
    let raw_ct = val
        .get("contentType")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    validate_content_type_header(raw_ct.as_deref(), expected_kind)?;
    let disp = val
        .get("disposition")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let size_bytes = bytes.len() as u64;
    tokio::fs::write(temp_path, &bytes).await?;
    let validated_ct = validate_downloaded_file(temp_path, raw_ct, expected_kind).await?;
    Ok((validated_ct, disp, size_bytes))
}

/// Selects the [`DownloadSource`] for `target` from its pre-populated URL and media ID.
fn select_download_source(target: &FlowAsset, label: &str) -> Result<DownloadSource> {
    if target.kind == "scene" && target.requires_scene_export {
        return Ok(DownloadSource::ExportScene {
            scene_id: target.id.trim().to_string(),
        });
    }
    let raw_url = target
        .url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let raw_usable = raw_url
        .as_deref()
        .is_some_and(|u| !(is_signed_direct_url(u) && is_expired_signed_url(u)));
    let media_id = target
        .primary_media_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            (!raw_usable && !matches!(target.kind.as_str(), "character" | "scene"))
                .then(|| target.id.trim().to_string())
                .filter(|s| !s.is_empty() && !s.contains(':'))
        });
    let usable_url = raw_url
        .filter(|u| !(is_signed_direct_url(u) && is_expired_signed_url(u) && media_id.is_some()));

    match (usable_url, media_id) {
        (Some(url), fallback_media_id) if is_signed_direct_url(&url) => {
            Ok(DownloadSource::DirectSigned {
                url,
                fallback_media_id,
            })
        }
        (fallback_url, Some(media_id)) => Ok(DownloadSource::ResolveMediaId {
            media_id,
            fallback_url,
        }),
        (Some(url), None) => Ok(DownloadSource::UnsignedUrl(url)),
        (None, None) => anyhow::bail!("Asset '{}' has no media URL or media ID", label),
    }
}

/// Downloads signed URLs over HTTP first (except raw PCM audio) and routes authenticated URLs through `fetchMedia`.
async fn try_download_candidates(
    engine: &ChromeEngine,
    candidates: &[String],
    expected_kind: &str,
    frame_pcm_wav: bool,
    temp_path: &Path,
) -> Result<((Option<String>, Option<String>, u64), String)> {
    let mut attempts = Vec::new();
    for cand_url in candidates {
        let lower = cand_url.to_ascii_lowercase();
        let is_http = lower.starts_with("http://") || lower.starts_with("https://");
        if is_http && is_signed_direct_url(cand_url) {
            let _ = tokio::fs::remove_file(temp_path).await;
            if is_expired_signed_url(cand_url) {
                attempts.push(format!("{} (signed URL expired)", cand_url));
                continue;
            }
            if frame_pcm_wav {
                match fetch_via_browser_to_temp(engine, cand_url, expected_kind, true, temp_path)
                    .await
                {
                    Ok(res) => return Ok((res, cand_url.clone())),
                    Err(browser_err) => {
                        let _ = tokio::fs::remove_file(temp_path).await;
                        attempts.push(format!("{} (browser: {})", cand_url, browser_err));
                    }
                }
                continue;
            }
            match stream_http_to_temp(engine, cand_url, expected_kind, temp_path).await {
                Ok(res) => return Ok((res, cand_url.clone())),
                Err(http_err) => {
                    let _ = tokio::fs::remove_file(temp_path).await;
                    if http_err.to_string().contains(MEDIA_KIND_MISMATCH_TAG)
                        || is_expired_signed_url(cand_url)
                    {
                        attempts.push(format!("{} (HTTP: {})", cand_url, http_err));
                        continue;
                    }
                    match fetch_via_browser_to_temp(
                        engine,
                        cand_url,
                        expected_kind,
                        false,
                        temp_path,
                    )
                    .await
                    {
                        Ok(res) => return Ok((res, cand_url.clone())),
                        Err(browser_err) => {
                            let _ = tokio::fs::remove_file(temp_path).await;
                            attempts.push(format!(
                                "{} (HTTP: {}; browser: {})",
                                cand_url, http_err, browser_err
                            ));
                        }
                    }
                }
            }
        } else if is_http {
            let _ = tokio::fs::remove_file(temp_path).await;
            match fetch_via_browser_to_temp(
                engine,
                cand_url,
                expected_kind,
                frame_pcm_wav,
                temp_path,
            )
            .await
            {
                Ok(res) => return Ok((res, cand_url.clone())),
                Err(browser_err) => {
                    let _ = tokio::fs::remove_file(temp_path).await;
                    if browser_err.to_string().contains(MEDIA_KIND_MISMATCH_TAG) {
                        attempts.push(format!("{} (browser: {})", cand_url, browser_err));
                        continue;
                    }
                    if frame_pcm_wav {
                        attempts.push(format!("{} (browser: {})", cand_url, browser_err));
                        continue;
                    }
                    match stream_http_to_temp(engine, cand_url, expected_kind, temp_path).await {
                        Ok(res) => return Ok((res, cand_url.clone())),
                        Err(http_err) => {
                            let _ = tokio::fs::remove_file(temp_path).await;
                            attempts.push(format!(
                                "{} (browser: {}; HTTP: {})",
                                cand_url, browser_err, http_err
                            ));
                        }
                    }
                }
            }
        } else {
            let _ = tokio::fs::remove_file(temp_path).await;
            match fetch_via_browser_to_temp(
                engine,
                cand_url,
                expected_kind,
                frame_pcm_wav,
                temp_path,
            )
            .await
            {
                Ok(res) => return Ok((res, cand_url.clone())),
                Err(browser_err) => {
                    let _ = tokio::fs::remove_file(temp_path).await;
                    attempts.push(format!("{} (browser: {})", cand_url, browser_err));
                }
            }
        }
    }
    anyhow::bail!("{}", attempts.join(" | "))
}

/// Exports a multi-clip or trimmed scene in Chrome and writes the MP4 bytes to `temp_path`.
async fn export_scene_via_browser(
    engine: &ChromeEngine,
    scene_id: &str,
    temp_path: &Path,
) -> Result<((Option<String>, Option<String>, u64), String)> {
    let val = engine
        .call_flow_async(
            "sceneExport",
            json!([scene_id, Value::Null, SCENE_EXPORT_TIMEOUT_MS]),
        )
        .await?;
    if val.get("ok").and_then(Value::as_bool) != Some(true) {
        let err = val
            .get("error")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("scene_export_failed");
        anyhow::bail!("{}", err);
    }
    let blob_url = val
        .get("url")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .context("Scene export returned no media URL")?;
    let res = fetch_via_browser_to_temp(engine, blob_url, "video", false, temp_path).await?;
    Ok((res, blob_url.to_string()))
}

/// Downloads a resolved [`FlowAsset`] into `<home>/downloads` and indexes it in SQLite.
pub(crate) async fn download_resolved_asset(
    engine: &ChromeEngine,
    db: &FlowDb,
    target: &FlowAsset,
    project_id: Option<String>,
    project_title: Option<String>,
) -> Result<DownloadRecord> {
    let label = if target.name.is_empty() {
        &target.id
    } else {
        &target.name
    };
    let source = select_download_source(target, label)?;

    let raw_dir = downloads_dir();
    create_private_dir_all(&raw_dir)?;
    let stage_dir = std::fs::canonicalize(&raw_dir).unwrap_or(raw_dir);
    let temp_name = format!(".flow-mcp-{}.part", &uuid::Uuid::new_v4().to_string()[..8]);
    let temp_path = stage_dir.join(temp_name);

    let mut effective_kind = if target.kind == "scene" {
        "video".to_string()
    } else if target.kind == "character" && target.media_kind.as_deref() == Some("audio") {
        "audio".to_string()
    } else {
        target.kind.clone()
    };
    let mut pcm_audio = target.pcm_audio;
    let download_res = match source {
        DownloadSource::ExportScene { scene_id } => {
            export_scene_via_browser(engine, &scene_id, &temp_path).await
        }
        DownloadSource::DirectSigned {
            url,
            fallback_media_id,
        } => {
            let direct = std::slice::from_ref(&url);
            match try_download_candidates(engine, direct, &effective_kind, pcm_audio, &temp_path)
                .await
            {
                Ok(res) => Ok(res),
                Err(first_err) => {
                    if let Some(media_id) = fallback_media_id {
                        let resolved =
                            query_resolved_media_urls(engine, &media_id, &effective_kind, true)
                                .await;
                        let kind_changed = matches!(effective_kind.as_str(), "image" | "character")
                            && resolved.media_kind.as_deref() == Some("audio");
                        if kind_changed {
                            effective_kind = "audio".to_string();
                        }
                        let pcm_changed = !pcm_audio && resolved.pcm_audio;
                        pcm_audio |= resolved.pcm_audio;
                        let mut extra = Vec::new();
                        for cand in resolved.urls {
                            if cand != url || kind_changed || pcm_changed {
                                push_unique_url(&mut extra, &cand);
                            }
                        }
                        if extra.is_empty() {
                            Err(first_err)
                        } else {
                            try_download_candidates(
                                engine,
                                &extra,
                                &effective_kind,
                                pcm_audio,
                                &temp_path,
                            )
                            .await
                            .map_err(|extra_err| anyhow::anyhow!("{} | {}", first_err, extra_err))
                        }
                    } else {
                        Err(first_err)
                    }
                }
            }
        }
        DownloadSource::ResolveMediaId {
            media_id,
            fallback_url,
        } => {
            let resolved =
                query_resolved_media_urls(engine, &media_id, &effective_kind, false).await;
            if matches!(effective_kind.as_str(), "image" | "character")
                && resolved.media_kind.as_deref() == Some("audio")
            {
                effective_kind = "audio".to_string();
            }
            pcm_audio |= resolved.pcm_audio;
            let mut candidates = resolved.urls;
            if let Some(ref raw_fallback) = fallback_url
                && !(is_signed_direct_url(raw_fallback) && is_expired_signed_url(raw_fallback))
            {
                push_fife_candidates(&mut candidates, raw_fallback, &effective_kind);
                push_unique_url(&mut candidates, raw_fallback);
            }
            let first_attempt = if candidates.is_empty() {
                Err(anyhow::anyhow!(
                    "media lookup returned no URLs for media ID '{}'",
                    media_id
                ))
            } else {
                try_download_candidates(engine, &candidates, &effective_kind, pcm_audio, &temp_path)
                    .await
            };
            match first_attempt {
                Ok(res) => Ok(res),
                Err(first_err) => {
                    let refreshed =
                        query_resolved_media_urls(engine, &media_id, &effective_kind, true).await;
                    let kind_changed = matches!(effective_kind.as_str(), "image" | "character")
                        && refreshed.media_kind.as_deref() == Some("audio");
                    if kind_changed {
                        effective_kind = "audio".to_string();
                    }
                    let pcm_changed = !pcm_audio && refreshed.pcm_audio;
                    pcm_audio |= refreshed.pcm_audio;
                    let mut extra = Vec::new();
                    for cand in refreshed.urls {
                        if kind_changed
                            || pcm_changed
                            || !candidates.iter().any(|existing| existing == &cand)
                        {
                            push_unique_url(&mut extra, &cand);
                        }
                    }
                    if extra.is_empty() {
                        Err(first_err)
                    } else {
                        try_download_candidates(
                            engine,
                            &extra,
                            &effective_kind,
                            pcm_audio,
                            &temp_path,
                        )
                        .await
                        .map_err(|extra_err| anyhow::anyhow!("{} | {}", first_err, extra_err))
                    }
                }
            }
        }
        DownloadSource::UnsignedUrl(raw_url) => {
            let mut candidates = Vec::new();
            push_fife_candidates(&mut candidates, &raw_url, &effective_kind);
            push_unique_url(&mut candidates, &raw_url);
            try_download_candidates(engine, &candidates, &effective_kind, pcm_audio, &temp_path)
                .await
        }
    };

    let ((content_type, disposition, size_bytes), media_url) = match download_res {
        Ok(res) => res,
        Err(e) => {
            let _ = tokio::fs::remove_file(&temp_path).await;
            anyhow::bail!("Failed to download '{}': {}", label, e);
        }
    };

    let filename = natural_asset_filename(
        target,
        &effective_kind,
        &media_url,
        content_type.as_deref(),
        disposition.as_deref(),
    );
    let dest = disambiguate_dest(db, &stage_dir, &filename, &target.id).await;

    if let Err(e) = tokio::fs::rename(&temp_path, &dest).await {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(e).with_context(|| format!("Failed to save download to {}", dest.display()));
    }

    let file_path = resolve_stored_path(&dest);
    let file_name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&filename)
        .to_string();

    db.record_download(NewDownloadRecord {
        asset_id: target.id.clone(),
        project_id,
        project_title,
        name: target.name.clone(),
        kind: effective_kind,
        prompt: target.prompt.clone(),
        source_url: Some(media_url),
        file_path,
        file_name,
        mime_type: content_type,
        size_bytes,
        asset_created_at: target.created_at.clone(),
    })
    .await
}

/// Returns a numeric ordering rank for verified video quality labels.
fn quality_rank(label: Option<&str>) -> u8 {
    match label {
        Some("4k") => 4,
        Some("1080p") => 3,
        Some("720p") => 2,
        Some("360p") => 1,
        _ => 0,
    }
}

/// Parses an optional `quality` parameter string into a [`RequestedQuality`].
fn parse_download_quality(raw: Option<&str>) -> Result<RequestedQuality> {
    let Some(trimmed) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(RequestedQuality::Original);
    };
    match trimmed.to_ascii_lowercase().as_str() {
        "original" | "default" | "primary" => Ok(RequestedQuality::Original),
        "360p" => Ok(RequestedQuality::Exact("360p")),
        "720p" => Ok(RequestedQuality::Exact("720p")),
        "1080p" | "fhd" => Ok(RequestedQuality::Exact("1080p")),
        "4k" | "2160p" | "uhd" => Ok(RequestedQuality::Exact("4k")),
        "best" | "highest" | "max" => Ok(RequestedQuality::Best),
        _ => anyhow::bail!(
            "Unsupported download quality '{}': expected 'original', '360p', '720p', '1080p', '4k', or 'best'",
            trimmed
        ),
    }
}

/// Applies the requested video quality selector to `target` before download URL lookup.
fn apply_download_quality(target: &mut FlowAsset, quality: Option<&str>) -> Result<()> {
    let mode = parse_download_quality(quality)?;
    if mode == RequestedQuality::Original {
        return Ok(());
    }
    let label = if target.name.is_empty() {
        target.id.clone()
    } else {
        target.name.clone()
    };
    if !matches!(target.kind.as_str(), "video" | "scene") {
        anyhow::bail!(
            "Quality '{}' applies only to video assets (matched '{}' has kind '{}')",
            quality.unwrap_or_default().trim(),
            label,
            target.kind
        );
    }
    match mode {
        RequestedQuality::Original => Ok(()),
        RequestedQuality::Exact(wanted) => {
            if target.kind == "scene" && target.requires_scene_export {
                anyhow::bail!(
                    "Scene '{}' uses multi-clip or trimmed scene export and does not expose '{}' variants; omit 'quality' or use '<scene_id>:<workflow_id>' to download one clip",
                    label,
                    wanted
                );
            }
            let Some(chosen) = target
                .variants
                .iter()
                .find(|v| v.quality.as_deref() == Some(wanted))
                .cloned()
            else {
                let mut available: Vec<&str> = Vec::new();
                for q in target.variants.iter().filter_map(|v| v.quality.as_deref()) {
                    if !available.contains(&q) {
                        available.push(q);
                    }
                }
                let avail_desc = if available.is_empty() {
                    "none verified".to_string()
                } else {
                    available.join(", ")
                };
                anyhow::bail!(
                    "Asset '{}' has no '{}' video variant (available: {})",
                    label,
                    wanted,
                    avail_desc
                );
            };
            let changed = target.primary_media_id.as_deref() != Some(chosen.media_id.as_str());
            target.primary_media_id = Some(chosen.media_id);
            if let Some(url) = chosen.url {
                target.url = Some(url);
            } else if changed {
                target.url = None;
            }
            if chosen.width.is_some() {
                target.width = chosen.width;
            }
            if chosen.height.is_some() {
                target.height = chosen.height;
            }
            if chosen.duration.is_some() {
                target.duration = chosen.duration;
            }
            Ok(())
        }
        RequestedQuality::Best => {
            if target.kind == "scene" && target.requires_scene_export {
                return Ok(());
            }
            let chosen = target
                .variants
                .iter()
                .filter(|v| {
                    quality_rank(v.quality.as_deref()) > 0
                        || (v.width.unwrap_or(0) > 0 && v.height.unwrap_or(0) > 0)
                })
                .max_by_key(|v| {
                    let rank = quality_rank(v.quality.as_deref());
                    let area = u64::from(v.width.unwrap_or(0)) * u64::from(v.height.unwrap_or(0));
                    (rank, area)
                })
                .cloned();
            if let Some(best) = chosen {
                let changed = target.primary_media_id.as_deref() != Some(best.media_id.as_str());
                target.primary_media_id = Some(best.media_id);
                if let Some(url) = best.url {
                    target.url = Some(url);
                } else if changed {
                    target.url = None;
                }
                if best.width.is_some() {
                    target.width = best.width;
                }
                if best.height.is_some() {
                    target.height = best.height;
                }
                if best.duration.is_some() {
                    target.duration = best.duration;
                }
            }
            Ok(())
        }
    }
}

/// Resolves the matched Flow asset, downloads it to `<home>/downloads`, and records it in SQLite.
pub(crate) async fn download_asset(
    engine: &ChromeEngine,
    db: &FlowDb,
    match_str: &str,
    quality: Option<&str>,
) -> Result<DownloadRecord> {
    let (mut target, project_id, project_title) =
        resolve_asset(engine, match_str, false, "flow_download").await?;
    apply_download_quality(&mut target, quality)?;
    download_resolved_asset(engine, db, &target, project_id, project_title).await
}
