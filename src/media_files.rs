// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Managed download file naming, media header sniffing, path safety, and chunked reads.

use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use url::Url;

use crate::assets::FlowAsset;
use crate::config::downloads_dir;
use crate::db::{DownloadRecord, FlowDb, effective_mime_type};

/// Error marker used when a candidate URL serves HTML, JSON, playlists, or the wrong media type.
pub(crate) const MEDIA_KIND_MISMATCH_TAG: &str = "[media_kind_mismatch]";

/// Default chunk size (`1 MiB`) returned by `flow_downloads` `read_chunk`.
const DEFAULT_CHUNK_BYTES: usize = 1_048_576;

/// Maximum chunk size (`4 MiB`) allowed by `flow_downloads` `read_chunk`.
const MAX_CHUNK_BYTES: usize = 4_194_304;

/// Clock-skew safety margin subtracted from signed URL deadlines in seconds.
const SIGNED_URL_SKEW_SECS: u64 = 5;

/// Returns `true` when `raw_url` carries signed GCS/Flow CDN hosts or V2/V4 query signatures.
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

/// Parses an `X-Goog-Date` basic UTC timestamp (`YYYYMMDDTHHMMSSZ`) into Unix epoch seconds.
fn parse_goog_date_epoch_secs(raw: &str) -> Option<u64> {
    let b = raw.trim().as_bytes();
    if b.len() != 16 || !matches!(b[8], b'T' | b't') || !matches!(b[15], b'Z' | b'z') {
        return None;
    }
    let s = std::str::from_utf8(b).ok()?;
    let year: i64 = s[0..4].parse().ok()?;
    let month: u64 = s[4..6].parse().ok()?;
    let day: u64 = s[6..8].parse().ok()?;
    let hour: u64 = s[9..11].parse().ok()?;
    let minute: u64 = s[11..13].parse().ok()?;
    let second: u64 = s[13..15].parse().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let y = year - i64::from(month <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + (doe as i64) - 719_468;
    if days < 0 {
        return None;
    }
    Some((days as u64) * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// Returns `true` when `raw_url` carries an expired GCS V4 (`X-Goog-Date` + `X-Goog-Expires`) or V2 (`Expires`) signature.
pub(crate) fn is_expired_signed_url(raw_url: &str) -> bool {
    let Ok(parsed) = Url::parse(raw_url.trim()) else {
        return false;
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

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

    if let Some(ref gd) = goog_date {
        let Some(issued_secs) = parse_goog_date_epoch_secs(gd) else {
            return true;
        };
        if let Some(ref ge) = goog_expires {
            let Ok(ttl_secs) = ge.trim().parse::<u64>() else {
                return true;
            };
            if ttl_secs == 0 {
                return true;
            }
            return now_secs.saturating_add(SIGNED_URL_SKEW_SECS)
                >= issued_secs.saturating_add(ttl_secs);
        }
    }

    if has_v2_sig && let Some(ref exp_str) = v2_expires {
        let Ok(raw_exp) = exp_str.trim().parse::<u64>() else {
            return true;
        };
        if raw_exp == 0 {
            return true;
        }
        let exp_secs = if raw_exp > 100_000_000_000 {
            raw_exp / 1_000
        } else {
            raw_exp
        };
        return now_secs.saturating_add(SIGNED_URL_SKEW_SECS) >= exp_secs;
    }

    false
}

/// Returns `true` when `err` represents an HTTP 400 or 403 signature rejection on a signed URL.
pub(crate) fn is_signed_url_auth_failure(err: &anyhow::Error) -> bool {
    err.downcast_ref::<reqwest::Error>()
        .and_then(reqwest::Error::status)
        .is_some_and(|status| matches!(status.as_u16(), 400 | 403))
}

/// Decodes one hexadecimal ASCII byte into its 4-bit integer value.
fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Decodes percent-escaped UTF-8 bytes in header and URL path strings.
fn percent_decode_utf8(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex_nibble(bytes[i + 1]), hex_nibble(bytes[i + 2]))
        {
            out.push((hi << 4) | lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Sanitizes a candidate file name down to a safe non-empty leaf file name.
fn sanitize_filename_leaf(raw: &str) -> Option<String> {
    let leaf = raw.rsplit(['/', '\\']).next()?.trim();
    let cleaned: String = leaf
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('.').trim();
    let name = Path::new(trimmed).file_name().and_then(|n| n.to_str())?;
    if name.is_empty() || name == "." || name == ".." {
        None
    } else {
        Some(name.to_string())
    }
}

/// Normalizes an asset ID into a bounded ASCII stem for file names.
fn sanitize_asset_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('_');
    if trimmed.is_empty() {
        "asset".to_string()
    } else {
        trimmed.chars().take(64).collect()
    }
}

/// Extracts a leaf file name from an HTTP `Content-Disposition` header.
fn extract_disposition_filename(disposition: &str) -> Option<String> {
    let mut plain_name: Option<String> = None;
    let mut ext_name: Option<String> = None;

    for part in disposition.split(';') {
        let trimmed = part.trim();
        let Some((raw_key, raw_val)) = trimmed.split_once('=') else {
            continue;
        };
        let key = raw_key.trim();
        let val = raw_val.trim();

        if key.eq_ignore_ascii_case("filename*") {
            let unquoted = val.trim_matches('"');
            // RFC 5987 ext-value syntax: `charset'language'value-chars`.
            let mut parts = unquoted.splitn(3, '\'');
            let encoded = match (parts.next(), parts.next(), parts.next()) {
                (Some(_), Some(_), Some(value_chars)) => value_chars,
                _ => unquoted,
            };
            let decoded = percent_decode_utf8(encoded);
            if let Some(name) = sanitize_filename_leaf(&decoded) {
                ext_name = Some(name);
            }
        } else if key.eq_ignore_ascii_case("filename") && plain_name.is_none() {
            let clean = val.trim_matches('"').trim_matches('\'');
            let decoded = percent_decode_utf8(clean);
            if let Some(name) = sanitize_filename_leaf(&decoded) {
                plain_name = Some(name);
            }
        }
    }

    ext_name.or(plain_name)
}

/// Picks the default file extension from `content_type` or `expected_kind`.
fn default_extension_for_asset(expected_kind: &str, content_type: Option<&str>) -> &'static str {
    match mime_essence(content_type).as_str() {
        "audio/mpeg" | "audio/mp3" => return "mp3",
        "audio/mp4" | "audio/x-m4a" | "audio/aac" => return "m4a",
        "audio/wav" | "audio/x-wav" | "audio/wave" | "audio/vnd.wave" => return "wav",
        "audio/ogg" | "application/ogg" | "audio/opus" => return "ogg",
        "audio/flac" | "audio/x-flac" => return "flac",
        "audio/webm" => return "webm",
        "audio/aiff" | "audio/x-aiff" => return "aiff",
        _ => {}
    }
    content_type
        .and_then(|ct| ct.parse::<mime_guess::Mime>().ok())
        .and_then(|m| mime_guess::get_mime_extensions(&m))
        .and_then(|exts| {
            exts.iter()
                .copied()
                .find(|&e| {
                    matches!(
                        e,
                        "mp4"
                            | "png"
                            | "jpg"
                            | "webp"
                            | "webm"
                            | "gif"
                            | "mp3"
                            | "m4a"
                            | "wav"
                            | "ogg"
                            | "flac"
                    )
                })
                .or_else(|| exts.first().copied())
        })
        .unwrap_or(match expected_kind {
            "video" => "mp4",
            "audio" => "m4a",
            _ => "png",
        })
}

/// Returns `true` when `ext` is a recognized image, video, or audio file extension.
fn is_allowed_media_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "mp4"
            | "webm"
            | "mov"
            | "avi"
            | "mkv"
            | "m4v"
            | "png"
            | "jpg"
            | "jpeg"
            | "webp"
            | "gif"
            | "avif"
            | "heic"
            | "heif"
            | "wav"
            | "mp3"
            | "m4a"
            | "aac"
            | "ogg"
            | "opus"
            | "flac"
            | "aif"
            | "aiff"
    )
}

/// Resolves the natural download file name from HTTP headers, URL path, or `<asset_id>.<ext>`.
pub(crate) fn natural_asset_filename(
    target: &FlowAsset,
    expected_kind: &str,
    media_url: &str,
    content_type: Option<&str>,
    disposition: Option<&str>,
) -> String {
    if let Some(name) = disposition.and_then(extract_disposition_filename) {
        if Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(is_allowed_media_extension)
        {
            return name;
        }
        let stem = Path::new(&name)
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(&name);
        return format!(
            "{}.{}",
            stem,
            default_extension_for_asset(expected_kind, content_type)
        );
    }

    if let Ok(parsed) = Url::parse(media_url)
        && let Some(raw_seg) = parsed.path_segments().and_then(|mut segs| segs.next_back())
        && let Some(clean) = sanitize_filename_leaf(&percent_decode_utf8(raw_seg))
        && Path::new(&clean)
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(is_allowed_media_extension)
    {
        return clean;
    }

    let ext = default_extension_for_asset(expected_kind, content_type);
    format!("{}.{}", sanitize_asset_id(&target.id), ext)
}

/// Returns `true` when `disposition` names a file with a recognized non-WAV media extension.
pub(crate) fn has_non_wav_disposition_extension(disposition: Option<&str>) -> bool {
    disposition
        .and_then(extract_disposition_filename)
        .and_then(|name| {
            Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_ascii_lowercase)
        })
        .is_some_and(|ext| is_allowed_media_extension(&ext) && ext != "wav")
}

/// Extracts the lowercased MIME essence (`type/subtype`) from a `Content-Type` header.
pub(crate) fn mime_essence(ct: Option<&str>) -> String {
    ct.and_then(|raw| raw.split(';').next())
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Rejects markup, JSON, playlist, or wrong-kind HTTP `Content-Type` headers.
pub(crate) fn validate_content_type_header(ct: Option<&str>, expected_kind: &str) -> Result<()> {
    let essence = mime_essence(ct);
    if essence.is_empty() {
        return Ok(());
    }
    if essence.starts_with("text/")
        || matches!(
            essence.as_str(),
            "application/json"
                | "application/xml"
                | "application/dash+xml"
                | "application/xhtml+xml"
                | "application/vnd.apple.mpegurl"
                | "application/x-mpegurl"
                | "audio/mpegurl"
        )
    {
        anyhow::bail!(
            "{} Media URL returned markup/text content-type '{}'",
            MEDIA_KIND_MISMATCH_TAG,
            essence
        );
    }
    match expected_kind {
        "video" => {
            if essence.starts_with("image/")
                || essence.starts_with("audio/")
                || essence == "application/ogg"
            {
                anyhow::bail!(
                    "{} Media URL returned '{}' instead of video",
                    MEDIA_KIND_MISMATCH_TAG,
                    essence
                );
            }
        }
        "audio" => {
            if essence.starts_with("image/") || essence.starts_with("video/") {
                anyhow::bail!(
                    "{} Media URL returned '{}' instead of audio",
                    MEDIA_KIND_MISMATCH_TAG,
                    essence
                );
            }
        }
        _ => {
            if essence.starts_with("video/")
                || essence.starts_with("audio/")
                || essence == "application/ogg"
            {
                anyhow::bail!(
                    "{} Media URL returned '{}' instead of image",
                    MEDIA_KIND_MISMATCH_TAG,
                    essence
                );
            }
        }
    }
    Ok(())
}

/// Sniffs leading magic bytes in `hdr` and returns the canonical container or codec MIME type.
fn sniff_media_magic(hdr: &[u8]) -> Option<&'static str> {
    if hdr.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if hdr.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if hdr.starts_with(b"GIF87a") || hdr.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if hdr.len() >= 12 && &hdr[0..4] == b"RIFF" {
        if &hdr[8..12] == b"WEBP" {
            return Some("image/webp");
        }
        if &hdr[8..12] == b"WAVE" {
            return Some("audio/wav");
        }
        if &hdr[8..12] == b"AVI " {
            return Some("video/x-msvideo");
        }
    }
    if hdr.len() >= 12 && &hdr[4..8] == b"ftyp" {
        if matches!(&hdr[8..12], b"avif" | b"avis") {
            return Some("image/avif");
        }
        if matches!(&hdr[8..12], b"heic" | b"heix" | b"mif1" | b"msf1") {
            return Some("image/heic");
        }
        if matches!(&hdr[8..12], b"M4A " | b"M4B " | b"M4P ") {
            return Some("audio/x-m4a");
        }
    }
    if hdr.starts_with(b"fLaC") {
        return Some("audio/flac");
    }
    if hdr.starts_with(b"OggS") {
        return Some("audio/ogg");
    }
    if hdr.len() >= 12 && &hdr[0..4] == b"FORM" && matches!(&hdr[8..12], b"AIFF" | b"AIFC") {
        return Some("audio/aiff");
    }
    if hdr.len() >= 8
        && matches!(
            &hdr[4..8],
            b"ftyp" | b"styp" | b"moov" | b"mdat" | b"wide" | b"free" | b"skip"
        )
    {
        return Some("video/mp4");
    }
    if hdr.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some("video/webm");
    }
    if hdr.starts_with(b"ID3")
        || (hdr.len() >= 4
            && hdr[0] == 0xFF
            && (hdr[1] & 0xE0) == 0xE0
            && (hdr[1] & 0x18) != 0x08
            && (hdr[1] & 0x06) != 0
            && (hdr[2] & 0xF0) != 0xF0
            && (hdr[2] & 0x0C) != 0x0C)
    {
        return Some("audio/mpeg");
    }
    if hdr.starts_with(b"ADIF")
        || (hdr.len() >= 4 && hdr[0] == 0xFF && (hdr[1] & 0xF6) == 0xF0 && (hdr[2] & 0x3C) != 0x3C)
    {
        return Some("audio/aac");
    }
    None
}

/// Returns `true` when `hdr` begins with any container or compressed format that `media_files` recognizes.
pub(crate) fn is_recognized_media_magic(hdr: &[u8]) -> bool {
    sniff_media_magic(hdr).is_some()
}

/// Checks leading file magic bytes to verify media type and infer generic MIME headers.
pub(crate) async fn validate_downloaded_file(
    path: &Path,
    ct: Option<String>,
    expected_kind: &str,
) -> Result<Option<String>> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut buf = [0u8; 64];
    let mut total = 0usize;
    while total < buf.len() {
        let n = file.read(&mut buf[total..]).await?;
        if n == 0 {
            break;
        }
        total += n;
    }
    let hdr = &buf[..total];

    let start = hdr
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(hdr.len());
    let trimmed_lower: Vec<u8> = hdr[start..]
        .iter()
        .take(16)
        .map(|b| b.to_ascii_lowercase())
        .collect();
    if trimmed_lower.starts_with(b"<!doctype")
        || trimmed_lower.starts_with(b"<html")
        || trimmed_lower.starts_with(b"<?xml")
        || trimmed_lower.starts_with(b"<mpd")
        || trimmed_lower.starts_with(b"#extm3u")
        || trimmed_lower.starts_with(b")]}'")
    {
        anyhow::bail!(
            "{} Media URL returned markup/playlist bytes instead of media",
            MEDIA_KIND_MISMATCH_TAG
        );
    }

    let sniffed = sniff_media_magic(hdr);
    let essence = mime_essence(ct.as_deref());
    let generic_ct = essence.is_empty()
        || matches!(
            essence.as_str(),
            "application/octet-stream" | "binary/octet-stream"
        );

    if expected_kind == "video" {
        match sniffed {
            Some(m) if m.starts_with("image/") || m.starts_with("audio/") => {
                anyhow::bail!(
                    "{} Media URL returned image or audio bytes instead of video",
                    MEDIA_KIND_MISMATCH_TAG
                );
            }
            Some(inferred @ ("video/mp4" | "video/webm" | "video/x-msvideo")) => {
                if generic_ct {
                    return Ok(Some(inferred.to_string()));
                }
                return Ok(ct);
            }
            _ => {
                anyhow::bail!(
                    "{} Media URL did not return a valid MP4/WebM/AVI video container",
                    MEDIA_KIND_MISMATCH_TAG
                );
            }
        }
    }

    if expected_kind == "audio" {
        match sniffed {
            Some(m) if m.starts_with("image/") || m == "video/x-msvideo" => {
                anyhow::bail!(
                    "{} Media URL returned image or video bytes instead of audio",
                    MEDIA_KIND_MISMATCH_TAG
                );
            }
            Some(raw_mime) => {
                if generic_ct {
                    let inferred = match raw_mime {
                        "audio/x-m4a" | "video/mp4" => "audio/mp4",
                        "video/webm" => "audio/webm",
                        other => other,
                    };
                    return Ok(Some(inferred.to_string()));
                }
                return Ok(ct);
            }
            None => {
                anyhow::bail!(
                    "{} Media URL did not return a valid audio container",
                    MEDIA_KIND_MISMATCH_TAG
                );
            }
        }
    }

    if let Some(raw_mime) = sniffed {
        if raw_mime.starts_with("video/") || raw_mime.starts_with("audio/") {
            anyhow::bail!(
                "{} Media URL returned video or audio bytes instead of image",
                MEDIA_KIND_MISMATCH_TAG
            );
        }
        if generic_ct {
            return Ok(Some(raw_mime.to_string()));
        }
    }
    Ok(ct)
}

/// Resolves an absolute path string for SQLite indexing.
pub(crate) fn resolve_stored_path(path: &Path) -> String {
    if path.is_absolute() {
        path.to_string_lossy().to_string()
    } else if let Ok(cwd) = std::env::current_dir() {
        cwd.join(path).to_string_lossy().to_string()
    } else {
        path.to_string_lossy().to_string()
    }
}

/// Disambiguates destination file paths in `dir` unless `asset_id` already owns that path.
pub(crate) async fn disambiguate_dest(
    db: &FlowDb,
    dir: &Path,
    filename: &str,
    asset_id: &str,
) -> PathBuf {
    let candidate = dir.join(filename);
    let abs_candidate = resolve_stored_path(&candidate);
    let exists = tokio::fs::try_exists(&candidate).await.unwrap_or(false);
    if !exists {
        return candidate;
    }

    if let Ok(Some(owner)) = db.find_owner_for_path(&abs_candidate).await
        && owner == asset_id
    {
        return candidate;
    }

    let path_obj = Path::new(filename);
    let stem = path_obj
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("asset");
    let ext = path_obj.extension().and_then(|s| s.to_str());
    let short_id = sanitize_asset_id(asset_id);
    let short_tag: String = short_id.chars().take(8).collect();
    let alt = match ext {
        Some(e) if !e.is_empty() => format!("{}-{}.{}", stem, short_tag, e),
        _ => format!("{}-{}", stem, short_tag),
    };
    let alt_path = dir.join(alt);
    if !tokio::fs::try_exists(&alt_path).await.unwrap_or(false) {
        return alt_path;
    }
    let uniq = match ext {
        Some(e) if !e.is_empty() => format!("{}-{}.{}", stem, short_id, e),
        _ => format!("{}-{}", stem, short_id),
    };
    dir.join(uniq)
}

/// Returns the canonical path when `file_path` is an existing regular file inside `downloads_dir()`.
pub(crate) fn verified_managed_download_path(file_path: &str) -> Option<PathBuf> {
    let raw_dir = downloads_dir();
    let base = std::fs::canonicalize(&raw_dir).ok()?;
    let canon = std::fs::canonicalize(file_path).ok()?;
    if canon.starts_with(&base) && canon != base && canon.is_file() {
        Some(canon)
    } else {
        None
    }
}

/// Reads a Base64-encoded byte range from the managed download file in `rec`.
pub(crate) async fn read_download_chunk(
    rec: &DownloadRecord,
    offset: u64,
    length: Option<usize>,
) -> Result<Value> {
    let path = verified_managed_download_path(&rec.file_path).with_context(|| {
        format!(
            "Downloaded file does not exist in managed downloads directory: {}",
            rec.file_path
        )
    })?;
    let mut file = tokio::fs::File::open(&path)
        .await
        .with_context(|| format!("Failed to open downloaded file {}", path.display()))?;
    let total_bytes = file.metadata().await?.len();
    let chunk_len = length
        .unwrap_or(DEFAULT_CHUNK_BYTES)
        .clamp(1, MAX_CHUNK_BYTES);
    let mime_type = effective_mime_type(rec.mime_type.as_deref(), &rec.file_path);

    if offset >= total_bytes {
        return Ok(json!({
            "action": "read_chunk",
            "id": rec.id,
            "asset_id": rec.asset_id,
            "resource_uri": rec.resource_uri,
            "file_name": rec.file_name,
            "mime_type": mime_type,
            "offset": offset,
            "bytes_read": 0,
            "total_bytes": total_bytes,
            "eof": true,
            "next_offset": Value::Null,
            "data_base64": "",
        }));
    }

    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let to_read = (total_bytes - offset).min(chunk_len as u64);
    let mut buf = Vec::with_capacity(to_read as usize);
    file.take(to_read).read_to_end(&mut buf).await?;

    let next = offset + buf.len() as u64;
    let eof = next >= total_bytes;
    Ok(json!({
        "action": "read_chunk",
        "id": rec.id,
        "asset_id": rec.asset_id,
        "resource_uri": rec.resource_uri,
        "file_name": rec.file_name,
        "mime_type": mime_type,
        "offset": offset,
        "bytes_read": buf.len(),
        "total_bytes": total_bytes,
        "eof": eof,
        "next_offset": (!eof).then_some(next),
        "data_base64": BASE64.encode(&buf),
    }))
}

/// Removes managed files on disk for `records` and returns `(ids_to_delete, deleted_files, freed_bytes, items)`.
pub(crate) async fn remove_managed_download_files(
    records: &[DownloadRecord],
) -> Result<(Vec<i64>, usize, u64, Vec<Value>)> {
    let mut ids_to_delete = Vec::with_capacity(records.len());
    let mut deleted_files = 0usize;
    let mut freed_bytes = 0u64;
    let mut items = Vec::with_capacity(records.len());

    for rec in records {
        let mut file_deleted = false;
        if let Some(canon) = verified_managed_download_path(&rec.file_path) {
            let disk_size = tokio::fs::metadata(&canon)
                .await
                .map(|m| m.len())
                .unwrap_or(rec.size_bytes);
            match tokio::fs::remove_file(&canon).await {
                Ok(()) => {
                    file_deleted = true;
                    deleted_files += 1;
                    freed_bytes = freed_bytes.saturating_add(disk_size);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(e).with_context(|| {
                        format!("Failed to delete downloaded file {}", canon.display())
                    });
                }
            }
        }
        ids_to_delete.push(rec.id);
        items.push(json!({
            "id": rec.id,
            "asset_id": rec.asset_id,
            "file_name": rec.file_name,
            "file_deleted": file_deleted,
        }));
    }

    Ok((ids_to_delete, deleted_files, freed_bytes, items))
}
