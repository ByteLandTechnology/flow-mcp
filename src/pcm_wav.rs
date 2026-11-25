// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Host RIFF WAVE framing for raw 24 kHz 16-bit mono PCM audio streams.

use anyhow::{Result, bail};
use std::path::Path;

/// Output sample rate in hertz for Google Flow case `11` PCM audio.
const PCM_SAMPLE_RATE: u32 = 24_000;

/// Channel count for Google Flow case `11` mono PCM audio.
const PCM_CHANNELS: u16 = 1;

/// Sample width in bits for signed 16-bit little-endian PCM audio.
const PCM_BITS_PER_SAMPLE: u16 = 16;

/// Bytes per sample frame across all channels.
const PCM_BLOCK_ALIGN: u16 = PCM_CHANNELS * (PCM_BITS_PER_SAMPLE / 8);

/// Average byte rate per second (`sample_rate * block_align`).
const PCM_BYTE_RATE: u32 = PCM_SAMPLE_RATE * (PCM_BLOCK_ALIGN as u32);

/// Fixed byte length of a standard canonical RIFF WAVE header.
const WAV_HEADER_LEN: usize = 44;

/// Returns `true` when `bytes` begins with HTML, XML, playlist, XSSI, or JSON error text.
fn is_text_or_playlist_prefix(bytes: &[u8]) -> bool {
    let start = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let trimmed = &bytes[start..];
    let lower: Vec<u8> = trimmed
        .iter()
        .take(16)
        .map(|b| b.to_ascii_lowercase())
        .collect();
    if lower.starts_with(b"<!doctype")
        || lower.starts_with(b"<html")
        || lower.starts_with(b"<?xml")
        || lower.starts_with(b"<mpd")
        || lower.starts_with(b"<error")
        || lower.starts_with(b"#extm3u")
        || lower.starts_with(b")]}'")
    {
        return true;
    }
    if matches!(trimmed.first(), Some(b'{' | b'['))
        && trimmed.len() <= 65_536
        && serde_json::from_slice::<serde_json::Value>(trimmed).is_ok()
    {
        return true;
    }
    false
}

/// Returns `true` when `hdr` starts with a recognized image, audio, or video container header.
fn is_known_media_container(hdr: &[u8]) -> bool {
    let is_jpeg = hdr.starts_with(&[0xFF, 0xD8, 0xFF]);
    let is_png = hdr.starts_with(b"\x89PNG\r\n\x1a\n");
    let is_gif = hdr.starts_with(b"GIF87a") || hdr.starts_with(b"GIF89a");
    let is_riff = hdr.len() >= 12
        && &hdr[0..4] == b"RIFF"
        && matches!(&hdr[8..12], b"WAVE" | b"WEBP" | b"AVI ");
    let is_iso_bmff = hdr.len() >= 8
        && matches!(
            &hdr[4..8],
            b"ftyp" | b"styp" | b"moov" | b"mdat" | b"wide" | b"free" | b"skip"
        );
    let is_flac = hdr.starts_with(b"fLaC");
    let is_ogg = hdr.starts_with(b"OggS");
    let is_aiff =
        hdr.len() >= 12 && &hdr[0..4] == b"FORM" && matches!(&hdr[8..12], b"AIFF" | b"AIFC");
    let is_id3 = hdr.starts_with(b"ID3");
    let is_webm = hdr.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]);
    is_jpeg
        || is_png
        || is_gif
        || is_riff
        || is_iso_bmff
        || is_flac
        || is_ogg
        || is_aiff
        || is_id3
        || is_webm
}

/// Builds a 44-byte canonical RIFF WAVE header for `pcm_byte_len` bytes of 24 kHz 16-bit mono PCM.
fn build_riff_wave_header(pcm_byte_len: u32) -> [u8; WAV_HEADER_LEN] {
    let riff_size = 36u32.saturating_add(pcm_byte_len);
    let mut hdr = [0u8; WAV_HEADER_LEN];
    hdr[0..4].copy_from_slice(b"RIFF");
    hdr[4..8].copy_from_slice(&riff_size.to_le_bytes());
    hdr[8..12].copy_from_slice(b"WAVE");
    hdr[12..16].copy_from_slice(b"fmt ");
    hdr[16..20].copy_from_slice(&16u32.to_le_bytes());
    hdr[20..22].copy_from_slice(&1u16.to_le_bytes());
    hdr[22..24].copy_from_slice(&PCM_CHANNELS.to_le_bytes());
    hdr[24..28].copy_from_slice(&PCM_SAMPLE_RATE.to_le_bytes());
    hdr[28..32].copy_from_slice(&PCM_BYTE_RATE.to_le_bytes());
    hdr[32..34].copy_from_slice(&PCM_BLOCK_ALIGN.to_le_bytes());
    hdr[34..36].copy_from_slice(&PCM_BITS_PER_SAMPLE.to_le_bytes());
    hdr[36..40].copy_from_slice(b"data");
    hdr[40..44].copy_from_slice(&pcm_byte_len.to_le_bytes());
    hdr
}

/// Frames raw non-text PCM bytes at `path` into a 24 kHz 16-bit mono RIFF WAVE file when needed.
pub(crate) async fn frame_raw_pcm_file(
    path: &Path,
    ct: Option<String>,
) -> Result<(Option<String>, u64)> {
    let bytes = tokio::fs::read(path).await?;
    if bytes.is_empty() {
        bail!("Media URL returned empty body");
    }
    if is_text_or_playlist_prefix(&bytes) || is_known_media_container(&bytes) {
        return Ok((ct, bytes.len() as u64));
    }

    let pcm_len = bytes.len() & !1usize;
    if pcm_len == 0 {
        bail!("PCM audio stream contains fewer than 2 bytes");
    }
    let data_len = u32::try_from(pcm_len)
        .map_err(|_| anyhow::anyhow!("PCM audio stream exceeds the 4 GiB WAV limit"))?;
    let header = build_riff_wave_header(data_len);

    let mut framed = Vec::with_capacity(WAV_HEADER_LEN.saturating_add(pcm_len));
    framed.extend_from_slice(&header);
    framed.extend_from_slice(&bytes[..pcm_len]);
    tokio::fs::write(path, &framed).await?;
    Ok((Some("audio/wav".to_string()), framed.len() as u64))
}
