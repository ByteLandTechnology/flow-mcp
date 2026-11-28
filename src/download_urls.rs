// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Media URL signature checks, expiration parsing, FIFE expansion, and Chrome URL lookup.

use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

use crate::engine::ChromeEngine;

/// Ordered URL candidates and media kind from `resolveVideoUrl`.
pub(crate) struct ResolvedMediaUrls {
    /// Candidate URLs with signed direct URLs before unsigned URLs.
    pub(crate) urls: Vec<String>,
    /// Media family from the `as29s` wire message when present.
    pub(crate) media_kind: Option<String>,
    /// True when `as29s` case `11` returned raw 24 kHz PCM audio.
    pub(crate) pcm_audio: bool,
}

/// Returns `true` when `raw_url` carries signed GCS or Flow CDN hosts or V2/V4 query signatures.
pub(crate) fn is_signed_direct_url(raw_url: &str) -> bool {
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

/// Returns `true` when `raw_url` has a V4 or V2 GCS signature whose validity window has passed.
pub(crate) fn is_expired_signed_url(raw_url: &str) -> bool {
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
pub(crate) fn push_unique_url(out: &mut Vec<String>, raw: &str) {
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

/// Removes trailing `=...` FIFE resize or format suffixes from the final path segment.
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

/// Expands unsigned image or video FIFE URLs into prioritized original and download variants.
pub(crate) fn push_fife_candidates(out: &mut Vec<String>, raw_url: &str, expected_kind: &str) {
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

/// Gets the media URLs from Chrome within the optional browser request time limit.
pub(crate) async fn eval_resolve_media_url(
    engine: &ChromeEngine,
    media_id: &str,
    timeout_ms: Option<u64>,
) -> Option<Value> {
    eval_resolve_media_url_opts(engine, media_id, timeout_ms, false).await
}

/// Calls `resolveVideoUrl` in Chrome with optional time limit and cache bypass flags.
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
pub(crate) async fn query_resolved_media_urls(
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
