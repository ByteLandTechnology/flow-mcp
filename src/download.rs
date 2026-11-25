// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Streaming media downloads, signed CDN detection, on-demand ID lookup, and SQLite indexing.

use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::time::Duration;
use url::Url;

use crate::assets::{FlowAsset, resolve_asset};
use crate::config::downloads_dir;
use crate::db::{DownloadRecord, FlowDb, NewDownloadRecord};
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

/// Ordered URL candidates and media kind from `resolveVideoUrl`.
struct ResolvedMediaUrls {
    /// Candidate URLs with signed direct URLs before unsigned URLs.
    urls: Vec<String>,
    /// Media family from the `as29s` wire message when present.
    media_kind: Option<String>,
    /// True when `as29s` case `11` returned raw 24 kHz PCM audio.
    pcm_audio: bool,
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

/// Returns `true` when `raw_url` carries signed GCS/Flow CDN hosts or V2/V4 query signatures.
fn is_signed_direct_url(raw_url: &str) -> bool {
    let Ok(parsed) = Url::parse(raw_url) else {
        return false;
    };
    let Some(host) = parsed.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    host == "storage.googleapis.com"
        || host.ends_with(".storage.googleapis.com")
        || host == "flow-content.google"
        || host.ends_with(".flow-content.google")
        || host == "labs-flow.dev"
        || host.ends_with(".labs-flow.dev")
        || host == "video-downloads.googleusercontent.com"
        || host.ends_with(".video-downloads.googleusercontent.com")
        || parsed.query_pairs().any(|(k, _)| {
            matches!(
                k.to_ascii_lowercase().as_str(),
                "signature"
                    | "googleaccessid"
                    | "x-goog-signature"
                    | "x-goog-algorithm"
                    | "x-goog-credential"
                    | "x-goog-date"
                    | "x-goog-expires"
                    | "x-goog-signedheaders"
            )
        })
}

/// Converts a proleptic Gregorian UTC date into days since `1970-01-01`.
fn civil_days_from_ymd(year: i64, month: u32, day: u32) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m = u64::from(month);
    let d = u64::from(day);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + (doe as i64) - 719_468
}

/// Parses a compact `YYYYMMDDTHHMMSSZ` timestamp into Unix epoch seconds.
fn parse_goog_date_secs(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    if trimmed.len() != 16 {
        return None;
    }
    let bytes = trimmed.as_bytes();
    if !matches!(bytes[8], b'T' | b't') || !matches!(bytes[15], b'Z' | b'z') {
        return None;
    }
    let year: i64 = trimmed.get(0..4)?.parse().ok()?;
    let month: u32 = trimmed.get(4..6)?.parse().ok()?;
    let day: u32 = trimmed.get(6..8)?.parse().ok()?;
    let hour: u64 = trimmed.get(9..11)?.parse().ok()?;
    let minute: u64 = trimmed.get(11..13)?.parse().ok()?;
    let second: u64 = trimmed.get(13..15)?.parse().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let days = civil_days_from_ymd(year, month, day);
    let day_secs = u64::try_from(days).ok()?.checked_mul(86_400)?;
    day_secs
        .checked_add(hour * 3_600)
        .and_then(|v| v.checked_add(minute * 60))
        .and_then(|v| v.checked_add(second))
}

/// Returns `true` when `raw_url` carries a V4 or V2 GCS signature whose validity window has elapsed.
fn is_expired_signed_url(raw_url: &str) -> bool {
    let Ok(parsed) = Url::parse(raw_url.trim()) else {
        return false;
    };
    let Ok(now_dur) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return false;
    };
    let now_secs = now_dur.as_secs();
    let mut goog_date: Option<String> = None;
    let mut goog_expires: Option<String> = None;
    let mut v2_expires: Option<String> = None;
    let mut has_v2_sig = false;
    for (k, v) in parsed.query_pairs() {
        match k.to_ascii_lowercase().as_str() {
            "x-goog-date" => goog_date = Some(v.into_owned()),
            "x-goog-expires" => goog_expires = Some(v.into_owned()),
            "expires" => v2_expires = Some(v.into_owned()),
            "signature" | "googleaccessid" => has_v2_sig = true,
            _ => {}
        }
    }
    if let (Some(date_str), Some(exp_str)) = (goog_date, goog_expires) {
        let Some(issued_secs) = parse_goog_date_secs(&date_str) else {
            return true;
        };
        let Ok(expires_secs) = exp_str.trim().parse::<u64>() else {
            return true;
        };
        return now_secs >= issued_secs.saturating_add(expires_secs);
    }
    if has_v2_sig && let Some(v2_str) = v2_expires {
        let Ok(exp_secs) = v2_str.trim().parse::<u64>() else {
            return true;
        };
        return now_secs >= exp_secs;
    }
    false
}

/// Appends `raw` to `out` when it uses an allowed scheme and is not already present.
fn push_unique_url(out: &mut Vec<String>, raw: &str) {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("blob:")
        || lower.starts_with("data:"))
    {
        return;
    }
    if !out.iter().any(|existing| existing == trimmed) {
        out.push(trimmed.to_string());
    }
}

/// Removes trailing `=...` FIFE resize/format suffixes from the final path segment.
fn strip_fife_path_options(path: &str) -> String {
    match path.rsplit_once('/') {
        Some((dir, leaf)) => {
            let clean_leaf = match leaf.rfind('=') {
                Some(idx) => &leaf[..idx],
                None => leaf,
            };
            format!("{}/{}", dir, clean_leaf)
        }
        None => match path.rfind('=') {
            Some(idx) => path[..idx].to_string(),
            None => path.to_string(),
        },
    }
}

/// Expands unsigned image or video FIFE URLs into prioritized original/download variants.
fn push_fife_candidates(out: &mut Vec<String>, raw_url: &str, expected_kind: &str) {
    if expected_kind == "audio" || is_signed_direct_url(raw_url) {
        return;
    }
    let Ok(parsed) = Url::parse(raw_url) else {
        return;
    };
    let Some(host) = parsed.host_str().map(str::to_ascii_lowercase) else {
        return;
    };
    if !(host == "flow.google.com"
        || host.ends_with(".googleusercontent.com")
        || host.ends_with(".fife.usercontent.google.com"))
    {
        return;
    }
    let is_video = expected_kind == "video";
    let stripped_path = strip_fife_path_options(parsed.path());
    let use_proxy_first = host == "flow.google.com" || stripped_path.starts_with("/asb/");

    if !use_proxy_first {
        let mut orig_parsed = parsed.clone();
        let suffixes: &[&str] = if is_video {
            &["=mm,22,15", "=dv", "=d"]
        } else {
            &["=d", "=s0"]
        };
        for suffix in suffixes {
            orig_parsed.set_path(&format!("{}{}", stripped_path, suffix));
            push_unique_url(out, orig_parsed.as_str());
        }
    }

    let mut flow_parsed = parsed;
    if flow_parsed.set_host(Some("flow.google.com")).is_ok() {
        let suffixes: &[&str] = if is_video {
            &["=mm,22,15", "=mm,18,15", "=dv", "=d"]
        } else {
            &["=d", "=s0"]
        };
        for suffix in suffixes {
            flow_parsed.set_path(&format!("{}{}", stripped_path, suffix));
            push_unique_url(out, flow_parsed.as_str());
        }
    }
}

/// Gets the media URLs from Chrome within the optional browser request budget.
pub(crate) async fn eval_resolve_media_url(
    engine: &ChromeEngine,
    media_id: &str,
    timeout_ms: Option<u64>,
) -> Option<Value> {
    eval_resolve_media_url_opts(engine, media_id, timeout_ms, false).await
}

/// Calls `resolveVideoUrl` in Chrome with optional timeout and cache bypass flags.
async fn eval_resolve_media_url_opts(
    engine: &ChromeEngine,
    media_id: &str,
    timeout_ms: Option<u64>,
    bypass_cache: bool,
) -> Option<Value> {
    let val = engine
        .call_flow_async(
            "resolveVideoUrl",
            json!([media_id, timeout_ms, bypass_cache]),
        )
        .await
        .ok()?;
    (val.get("ok").and_then(|v| v.as_bool()) == Some(true)).then_some(val)
}

/// Expands `eval_resolve_media_url` output and puts signed direct URLs before unsigned URLs.
async fn query_resolved_media_urls(
    engine: &ChromeEngine,
    media_id: &str,
    fallback_kind: &str,
    bypass_cache: bool,
) -> ResolvedMediaUrls {
    let Some(val) = eval_resolve_media_url_opts(engine, media_id, None, bypass_cache).await else {
        return ResolvedMediaUrls {
            urls: Vec::new(),
            media_kind: None,
            pcm_audio: false,
        };
    };
    let media_kind = val
        .get("media_kind")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let pcm_audio = val
        .get("pcm_audio")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let effective_kind = if media_kind.as_deref() == Some("audio") {
        "audio"
    } else {
        fallback_kind
    };

    let mut signed = Vec::new();
    let mut unsigned = Vec::new();
    let mut record_cand = |raw: &str| {
        if is_signed_direct_url(raw) {
            push_unique_url(&mut signed, raw);
        } else {
            push_unique_url(&mut unsigned, raw);
            push_fife_candidates(&mut unsigned, raw, effective_kind);
        }
    };

    if let Some(dl_url) = val.get("download_url").and_then(|v| v.as_str()) {
        record_cand(dl_url);
    }
    if let Some(url) = val.get("url").and_then(|v| v.as_str()) {
        record_cand(url);
    }
    if let Some(cands) = val.get("candidates").and_then(|v| v.as_array()) {
        for cand in cands.iter().filter_map(|v| v.as_str()) {
            record_cand(cand);
        }
    }

    let mut urls = signed;
    for cand in unsigned {
        push_unique_url(&mut urls, &cand);
    }
    ResolvedMediaUrls {
        urls,
        media_kind,
        pcm_audio,
    }
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
                .filter(|s| !s.is_empty())
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
        .call_flow_async("sceneExport", json!([scene_id]))
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

/// Resolves the matched Flow asset, downloads it to `<home>/downloads`, and records it in SQLite.
pub(crate) async fn download_asset(
    engine: &ChromeEngine,
    db: &FlowDb,
    match_str: &str,
) -> Result<DownloadRecord> {
    let (target, project_id, project_title) =
        resolve_asset(engine, match_str, false, "flow_download").await?;
    download_resolved_asset(engine, db, &target, project_id, project_title).await
}
