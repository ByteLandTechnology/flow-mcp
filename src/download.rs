// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Streaming media downloads, FIFE URL candidate resolution, and SQLite indexing.

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
use crate::engine::{ChromeEngine, DEFAULT_CHROME_UA};
use crate::media_files::{
    MEDIA_KIND_MISMATCH_TAG, disambiguate_dest, natural_asset_filename, resolve_stored_path,
    validate_content_type_header, validate_downloaded_file,
};
use crate::platform::create_private_dir_all;

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

/// Streams a direct HTTP media URL to a staging file using Chrome cookies when unsigned.
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
    if let Ok(parsed) = Url::parse(media_url)
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
    temp_path: &Path,
) -> Result<(Option<String>, Option<String>, u64)> {
    let val = engine
        .call_flow_async("fetchMedia", json!([media_url, expected_kind]))
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

/// Returns `true` when `raw_url` carries its own GCS/CDN signature parameters or host.
fn is_signed_direct_url(raw_url: &str) -> bool {
    let Ok(parsed) = Url::parse(raw_url) else {
        return false;
    };
    let Some(host) = parsed.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    host == "storage.googleapis.com"
        || host == "flow-content.google"
        || host.ends_with(".flow-content.google")
        || host == "video-downloads.googleusercontent.com"
        || parsed.query_pairs().any(|(k, _)| {
            matches!(
                k.as_ref(),
                "Signature" | "X-Goog-Signature" | "GoogleAccessId"
            )
        })
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

/// Expands unsigned FIFE URLs into prioritized original/download variants.
fn push_fife_candidates(out: &mut Vec<String>, raw_url: &str, is_video: bool) {
    if is_signed_direct_url(raw_url) {
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
    let stripped_path = strip_fife_path_options(parsed.path());

    let mut flow_parsed = parsed.clone();
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

    if host != "flow.google.com" && !stripped_path.starts_with("/asb/") {
        let mut orig_parsed = parsed;
        let suffixes: &[&str] = if is_video {
            &["=mm,22,15", "=dv", "=d"]
        } else {
            &["=d"]
        };
        for suffix in suffixes {
            orig_parsed.set_path(&format!("{}{}", stripped_path, suffix));
            push_unique_url(out, orig_parsed.as_str());
        }
    }
}

/// Gets the media URLs from Chrome within the optional browser request budget.
pub(crate) async fn eval_resolve_media_url(
    engine: &ChromeEngine,
    media_id: &str,
    timeout_ms: Option<u64>,
) -> Option<Value> {
    let val = engine
        .call_flow_async("resolveVideoUrl", json!([media_id, timeout_ms]))
        .await
        .ok()?;
    (val.get("ok").and_then(|v| v.as_bool()) == Some(true)).then_some(val)
}

/// Expands `eval_resolve_media_url` output into prioritized download URLs.
async fn query_resolved_media_urls(
    engine: &ChromeEngine,
    media_id: &str,
    is_video: bool,
) -> Vec<String> {
    let mut out = Vec::new();
    let Some(val) = eval_resolve_media_url(engine, media_id, None).await else {
        return out;
    };
    if let Some(cands) = val.get("candidates").and_then(|v| v.as_array()) {
        for cand in cands.iter().filter_map(|v| v.as_str()) {
            push_unique_url(&mut out, cand);
            if !is_signed_direct_url(cand) {
                push_fife_candidates(&mut out, cand, is_video);
            }
        }
    }
    if let Some(dl_url) = val.get("download_url").and_then(|v| v.as_str()) {
        push_unique_url(&mut out, dl_url);
        if !is_signed_direct_url(dl_url) {
            push_fife_candidates(&mut out, dl_url, is_video);
        }
    }
    if let Some(url) = val.get("url").and_then(|v| v.as_str()) {
        if !is_signed_direct_url(url) {
            push_fife_candidates(&mut out, url, is_video);
        }
        push_unique_url(&mut out, url);
    }
    out
}

/// Builds the ordered URL candidates for `target` and reports whether RPC lookup already ran.
async fn resolve_download_candidates(
    engine: &ChromeEngine,
    target: &FlowAsset,
    raw_media_url: &str,
) -> (Vec<String>, bool) {
    let mut candidates = Vec::new();
    let mut queried_rpc = false;
    let is_video = target.kind == "video";
    if (is_video || !is_signed_direct_url(raw_media_url))
        && let Some(media_id) = target
            .primary_media_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    {
        queried_rpc = true;
        for cand in query_resolved_media_urls(engine, media_id, is_video).await {
            push_unique_url(&mut candidates, &cand);
        }
    }
    push_fife_candidates(&mut candidates, raw_media_url, is_video);
    push_unique_url(&mut candidates, raw_media_url);
    (candidates, queried_rpc)
}

/// Attempts direct HTTP streaming then in-browser fetch across `candidates`.
async fn try_download_candidates(
    engine: &ChromeEngine,
    candidates: &[String],
    expected_kind: &str,
    temp_path: &Path,
) -> Result<((Option<String>, Option<String>, u64), String)> {
    let mut attempts = Vec::new();
    for cand_url in candidates {
        let lower = cand_url.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            let _ = tokio::fs::remove_file(temp_path).await;
            match stream_http_to_temp(engine, cand_url, expected_kind, temp_path).await {
                Ok(res) => return Ok((res, cand_url.clone())),
                Err(http_err) => {
                    let _ = tokio::fs::remove_file(temp_path).await;
                    if http_err.to_string().contains(MEDIA_KIND_MISMATCH_TAG) {
                        attempts.push(format!("{} (HTTP: {})", cand_url, http_err));
                        continue;
                    }
                    match fetch_via_browser_to_temp(engine, cand_url, expected_kind, temp_path)
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
        } else {
            let _ = tokio::fs::remove_file(temp_path).await;
            match fetch_via_browser_to_temp(engine, cand_url, expected_kind, temp_path).await {
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
    let raw_media_url = target
        .url
        .clone()
        .with_context(|| format!("Asset '{}' has no media URL", label))?;
    let (candidates, queried_rpc) =
        resolve_download_candidates(engine, target, &raw_media_url).await;

    let raw_dir = downloads_dir();
    create_private_dir_all(&raw_dir)?;
    let stage_dir = std::fs::canonicalize(&raw_dir).unwrap_or(raw_dir);
    let temp_name = format!(".flow-mcp-{}.part", &uuid::Uuid::new_v4().to_string()[..8]);
    let temp_path = stage_dir.join(temp_name);

    let download_res =
        match try_download_candidates(engine, &candidates, &target.kind, &temp_path).await {
            Ok(res) => Ok(res),
            Err(first_err) if !queried_rpc => {
                if let Some(media_id) = target
                    .primary_media_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    let mut extra = Vec::new();
                    for cand in
                        query_resolved_media_urls(engine, media_id, target.kind == "video").await
                    {
                        if !candidates.iter().any(|seen| seen == &cand) {
                            push_unique_url(&mut extra, &cand);
                        }
                    }
                    if extra.is_empty() {
                        Err(first_err)
                    } else {
                        try_download_candidates(engine, &extra, &target.kind, &temp_path)
                            .await
                            .map_err(|extra_err| anyhow::anyhow!("{} | {}", first_err, extra_err))
                    }
                } else {
                    Err(first_err)
                }
            }
            Err(first_err) => Err(first_err),
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
        kind: target.kind.clone(),
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
