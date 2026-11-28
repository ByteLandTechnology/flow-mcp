// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Managed download file naming, media header sniffing, path safety, and chunked reads.

use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
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

/// Returns `true` when `ext` matches a known image, video, or audio file extension.
fn is_allowed_media_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "mp4"
            | "webm"
            | "mov"
            | "m4v"
            | "avi"
            | "mkv"
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
            | "aiff"
            | "aif"
    )
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
                .or_else(|| {
                    exts.iter()
                        .copied()
                        .find(|&e| is_allowed_media_extension(e))
                })
        })
        .unwrap_or(match expected_kind {
            "video" => "mp4",
            "audio" => "m4a",
            _ => "png",
        })
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
        return format!(
            "{}.{}",
            name,
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

/// Extracts the lowercased MIME essence (`type/subtype`) from a `Content-Type` header.
fn mime_essence(ct: Option<&str>) -> String {
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

/// Returns `true` when `hdr` starts with an `ID3` tag or a valid 4-byte MPEG Layer II/III header.
fn has_valid_mp3_header(hdr: &[u8]) -> bool {
    if hdr.starts_with(b"ID3") {
        return true;
    }
    if hdr.len() < 4 || hdr[0] != 0xFF || (hdr[1] & 0xE0) != 0xE0 {
        return false;
    }
    let version_bits = (hdr[1] >> 3) & 0x03;
    let layer_bits = (hdr[1] >> 1) & 0x03;
    let bitrate_index = (hdr[2] >> 4) & 0x0F;
    let sample_rate_index = (hdr[2] >> 2) & 0x03;
    version_bits != 0x01
        && matches!(layer_bits, 0x01 | 0x02)
        && bitrate_index != 0
        && bitrate_index != 0x0F
        && sample_rate_index != 0x03
}

/// Returns `true` when `hdr` starts with a valid 7-byte ADTS AAC frame header.
fn has_valid_adts_header(hdr: &[u8]) -> bool {
    if hdr.len() < 7 || hdr[0] != 0xFF || (hdr[1] & 0xF6) != 0xF0 {
        return false;
    }
    let sample_rate_index = (hdr[2] >> 2) & 0x0F;
    let frame_len = ((usize::from(hdr[3] & 0x03)) << 11)
        | (usize::from(hdr[4]) << 3)
        | usize::from(hdr[5] >> 5);
    sample_rate_index < 13 && frame_len >= 7
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

    let after_bom = hdr.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(hdr);
    let start = after_bom
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(after_bom.len());
    let trimmed_lower: Vec<u8> = after_bom[start..]
        .iter()
        .take(16)
        .map(|b| b.to_ascii_lowercase())
        .collect();
    if trimmed_lower.starts_with(b"<!doctype")
        || trimmed_lower.starts_with(b"<html")
        || trimmed_lower.starts_with(b"<?xml")
        || trimmed_lower.starts_with(b"<mpd")
        || trimmed_lower.starts_with(b"<error")
        || trimmed_lower.starts_with(b"#extm3u")
        || trimmed_lower.starts_with(b")]}'")
        || trimmed_lower.starts_with(b"{")
        || trimmed_lower.starts_with(b"[")
    {
        anyhow::bail!(
            "{} Media URL returned markup or JSON bytes instead of media",
            MEDIA_KIND_MISMATCH_TAG
        );
    }

    let is_jpeg = hdr.starts_with(&[0xFF, 0xD8, 0xFF]);
    let is_png = hdr.starts_with(b"\x89PNG\r\n\x1a\n");
    let is_gif = hdr.starts_with(b"GIF87a") || hdr.starts_with(b"GIF89a");
    let is_webp = hdr.len() >= 12 && &hdr[0..4] == b"RIFF" && &hdr[8..12] == b"WEBP";
    let is_avif =
        hdr.len() >= 12 && &hdr[4..8] == b"ftyp" && matches!(&hdr[8..12], b"avif" | b"avis");
    let is_heic = hdr.len() >= 12
        && &hdr[4..8] == b"ftyp"
        && matches!(&hdr[8..12], b"heic" | b"heix" | b"mif1" | b"msf1");
    let is_wav = hdr.len() >= 12 && &hdr[0..4] == b"RIFF" && &hdr[8..12] == b"WAVE";
    let is_flac = hdr.starts_with(b"fLaC");
    let is_ogg = hdr.starts_with(b"OggS");
    let is_aiff =
        hdr.len() >= 12 && &hdr[0..4] == b"FORM" && matches!(&hdr[8..12], b"AIFF" | b"AIFC");
    let is_mp3 = !is_jpeg && has_valid_mp3_header(hdr);
    let is_aac = !is_jpeg && has_valid_adts_header(hdr);
    let is_m4a = hdr.len() >= 12
        && &hdr[4..8] == b"ftyp"
        && matches!(&hdr[8..12], b"M4A " | b"M4B " | b"M4P ");
    let is_mp4 = !is_avif
        && !is_heic
        && !is_m4a
        && hdr.len() >= 8
        && matches!(
            &hdr[4..8],
            b"ftyp" | b"styp" | b"moov" | b"mdat" | b"wide" | b"free" | b"skip"
        );
    let is_webm = hdr.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]);
    let is_avi = hdr.len() >= 12 && &hdr[0..4] == b"RIFF" && &hdr[8..12] == b"AVI ";
    let is_image = is_jpeg || is_png || is_gif || is_webp || is_avif || is_heic;
    let is_audio_only = is_wav || is_flac || is_ogg || is_aiff || is_mp3 || is_aac || is_m4a;

    let essence = mime_essence(ct.as_deref());
    let generic_ct = essence.is_empty()
        || matches!(
            essence.as_str(),
            "application/octet-stream" | "binary/octet-stream"
        );

    if expected_kind == "video" {
        if is_image || is_audio_only {
            anyhow::bail!(
                "{} Media URL returned image or audio bytes instead of video",
                MEDIA_KIND_MISMATCH_TAG
            );
        }
        if !(is_mp4 || is_webm || is_avi) {
            anyhow::bail!(
                "{} Media URL did not return a valid MP4/WebM/AVI video container",
                MEDIA_KIND_MISMATCH_TAG
            );
        }
        if generic_ct {
            let inferred = if is_mp4 {
                "video/mp4"
            } else if is_webm {
                "video/webm"
            } else {
                "video/x-msvideo"
            };
            return Ok(Some(inferred.to_string()));
        }
        return Ok(ct);
    }

    if expected_kind == "audio" {
        if is_image || is_avi {
            anyhow::bail!(
                "{} Media URL returned image or video bytes instead of audio",
                MEDIA_KIND_MISMATCH_TAG
            );
        }
        if !(is_audio_only || is_mp4 || is_webm) {
            anyhow::bail!(
                "{} Media URL did not return a valid audio container",
                MEDIA_KIND_MISMATCH_TAG
            );
        }
        if generic_ct {
            let inferred = if is_wav {
                "audio/wav"
            } else if is_flac {
                "audio/flac"
            } else if is_ogg {
                "audio/ogg"
            } else if is_aiff {
                "audio/aiff"
            } else if is_mp3 {
                "audio/mpeg"
            } else if is_aac {
                "audio/aac"
            } else if is_m4a || is_mp4 {
                "audio/mp4"
            } else {
                "audio/webm"
            };
            return Ok(Some(inferred.to_string()));
        }
        return Ok(ct);
    }

    if is_mp4 || is_webm || is_avi || is_audio_only {
        anyhow::bail!(
            "{} Media URL returned video or audio bytes instead of image",
            MEDIA_KIND_MISMATCH_TAG
        );
    }
    if generic_ct {
        if is_jpeg {
            return Ok(Some("image/jpeg".to_string()));
        }
        if is_png {
            return Ok(Some("image/png".to_string()));
        }
        if is_gif {
            return Ok(Some("image/gif".to_string()));
        }
        if is_webp {
            return Ok(Some("image/webp".to_string()));
        }
        if is_avif {
            return Ok(Some("image/avif".to_string()));
        }
        if is_heic {
            return Ok(Some("image/heic".to_string()));
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
