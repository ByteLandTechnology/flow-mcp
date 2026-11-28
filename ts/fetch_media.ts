// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Fetch media bytes inside Chrome using credentials matched to same-origin proxies and CDNs.

import { fifeEnv } from "./dom";
import { consumeExportedBlobUrl } from "./scene_export";
import { runtimeState } from "./state";
import type { FetchedMediaPayload } from "./types";

/** Default sample rate in Hz for Flow custom voice PCM audio (`BXb`). */
const FLOW_PCM_SAMPLE_RATE = 24000;

/** Channel count for Flow custom voice PCM audio (`BXb`). */
const FLOW_PCM_CHANNELS = 1;

/** Bits per sample for Flow custom voice PCM audio (`BXb`). */
const FLOW_PCM_BITS_PER_SAMPLE = 16;

/** Returns true when `bytes` match `ascii` starting at `offset`. */
function hasAsciiAt(bytes: Uint8Array, ascii: string, offset = 0): boolean {
  if (bytes.byteLength < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i += 1) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

/** MPEG-1 Layer III bitrate table in kbps indexed by the 4-bit header index. */
const MPEG1_L3_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];

/** MPEG-1 Layer II bitrate table in kbps indexed by the 4-bit header index. */
const MPEG1_L2_BITRATES = [
  0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0,
];

/** MPEG-2 and MPEG-2.5 Layer II/III bitrate table in kbps indexed by the 4-bit header index. */
const MPEG2_L23_BITRATES = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];

/** Computes the exact byte length of an MPEG Layer II/III audio frame at `offset`, or 0 if invalid. */
function parseMpegFrameLength(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.byteLength) return 0;
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return 0;
  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  if (versionBits === 1 || (layerBits !== 1 && layerBits !== 2)) return 0;
  const bitrateIdx = (b2 >> 4) & 0x0f;
  const srIdx = (b2 >> 2) & 0x03;
  if (bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) return 0;

  const sampleRate =
    versionBits === 3
      ? [44100, 48000, 32000][srIdx]
      : versionBits === 2
        ? [22050, 24000, 16000][srIdx]
        : [11025, 12000, 8000][srIdx];
  const bitrateKbps =
    versionBits === 3
      ? layerBits === 1
        ? MPEG1_L3_BITRATES[bitrateIdx]
        : MPEG1_L2_BITRATES[bitrateIdx]
      : MPEG2_L23_BITRATES[bitrateIdx];
  if (!sampleRate || !bitrateKbps) return 0;
  const padding = (b2 >> 1) & 0x01;
  const coeff = layerBits === 1 && versionBits !== 3 ? 72000 : 144000;
  return Math.floor((coeff * bitrateKbps) / sampleRate) + padding;
}

/** Returns true when `bytes` carry two consecutive MPEG Layer II/III or ADTS AAC audio frames. */
function hasFramedMpegOrAdtsAudio(bytes: Uint8Array): boolean {
  const mpegFrameLen = parseMpegFrameLength(bytes, 0);
  if (
    mpegFrameLen >= 24 &&
    bytes.byteLength >= mpegFrameLen + 4 &&
    parseMpegFrameLength(bytes, mpegFrameLen) >= 24 &&
    (bytes[mpegFrameLen + 1] & 0x1e) === (bytes[1] & 0x1e) &&
    (bytes[mpegFrameLen + 2] & 0x0c) === (bytes[2] & 0x0c)
  ) {
    return true;
  }

  if (bytes.byteLength >= 14 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) {
    const srIdx = (bytes[2] >> 2) & 0x0f;
    const adtsLen =
      ((bytes[3] & 0x03) << 11) | (bytes[4] << 3) | ((bytes[5] >> 5) & 0x07);
    if (
      srIdx < 13 &&
      adtsLen >= 7 &&
      bytes.byteLength >= adtsLen + 7 &&
      bytes[adtsLen] === 0xff &&
      (bytes[adtsLen + 1] & 0xf6) === (bytes[1] & 0xf6) &&
      (bytes[adtsLen + 2] & 0xfc) === (bytes[2] & 0xfc)
    ) {
      return true;
    }
  }
  return false;
}

/** Returns true when `bytes` already begin with a known audio, image, or video container header. */
function hasKnownMediaContainer(bytes: Uint8Array): boolean {
  if (
    hasAsciiAt(bytes, "RIFF") &&
    (hasAsciiAt(bytes, "WAVE", 8) || hasAsciiAt(bytes, "WEBP", 8) || hasAsciiAt(bytes, "AVI ", 8))
  ) {
    return true;
  }
  if (hasAsciiAt(bytes, "fLaC") || hasAsciiAt(bytes, "OggS") || hasAsciiAt(bytes, "ID3")) {
    return true;
  }
  if (hasAsciiAt(bytes, "FORM") && (hasAsciiAt(bytes, "AIFF", 8) || hasAsciiAt(bytes, "AIFC", 8))) {
    return true;
  }
  if (
    bytes.byteLength >= 8 &&
    (hasAsciiAt(bytes, "ftyp", 4) ||
      hasAsciiAt(bytes, "styp", 4) ||
      hasAsciiAt(bytes, "moov", 4) ||
      hasAsciiAt(bytes, "mdat", 4) ||
      hasAsciiAt(bytes, "wide", 4) ||
      hasAsciiAt(bytes, "free", 4) ||
      hasAsciiAt(bytes, "skip", 4))
  ) {
    return true;
  }
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return true;
  }
  return hasFramedMpegOrAdtsAudio(bytes);
}

/** Returns true when leading non-whitespace bytes match JSON, HTML, XML, playlist, or XSSI text. */
function looksLikeMarkupPayload(bytes: Uint8Array): boolean {
  let start =
    bytes.byteLength >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
      ? 3
      : 0;
  while (
    start < bytes.byteLength &&
    (bytes[start] === 0x20 || bytes[start] === 0x09 || bytes[start] === 0x0a || bytes[start] === 0x0d)
  ) {
    start += 1;
  }
  if (start < bytes.byteLength && (bytes[start] === 0x7b || bytes[start] === 0x5b)) {
    return true;
  }
  const head = Array.from(bytes.subarray(start, Math.min(bytes.byteLength, start + 16)))
    .map((b) => String.fromCharCode(b))
    .join("")
    .toLowerCase();
  return (
    head.startsWith("<!doctype") ||
    head.startsWith("<html") ||
    head.startsWith("<?xml") ||
    head.startsWith("<error") ||
    head.startsWith("<mpd") ||
    head.startsWith("#extm3u") ||
    head.startsWith(")]}'")
  );
}

/** Returns true when `u` matches a cached `as29s` entry flagged as raw PCM audio. */
function isCachedPcmUrl(u: string): boolean {
  for (const entry of runtimeState.mediaInfoCache.values()) {
    if (!entry.pcm_audio) continue;
    if (entry.url === u || entry.download_url === u || entry.candidates.includes(u)) {
      return true;
    }
  }
  return false;
}

/** Writes four ASCII characters into `view` at `offset`. */
function writeFourCc(view: DataView, offset: number, tag: string): void {
  for (let i = 0; i < 4; i += 1) {
    view.setUint8(offset + i, tag.charCodeAt(i));
  }
}

/** Wraps raw 24 kHz 16-bit mono PCM bytes in a 44-byte `RIFF`/`WAVE` container matching Flow `BXb`. */
function framePcm24kMonoWav(rawBytes: Uint8Array): Uint8Array {
  const blockAlign = (FLOW_PCM_BITS_PER_SAMPLE / 8) * FLOW_PCM_CHANNELS;
  const remainder = rawBytes.byteLength % blockAlign;
  const pcmBytes =
    remainder === 0 ? rawBytes : rawBytes.subarray(0, rawBytes.byteLength - remainder);
  if (pcmBytes.byteLength === 0) {
    throw new Error("Media URL returned empty PCM audio body");
  }
  const dataLen = pcmBytes.byteLength;
  const totalLen = 44 + dataLen;
  const byteRate = FLOW_PCM_SAMPLE_RATE * blockAlign;
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);
  writeFourCc(view, 0, "RIFF");
  view.setUint32(4, totalLen - 8, true);
  writeFourCc(view, 8, "WAVE");
  writeFourCc(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, FLOW_PCM_CHANNELS, true);
  view.setUint32(24, FLOW_PCM_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, FLOW_PCM_BITS_PER_SAMPLE, true);
  writeFourCc(view, 36, "data");
  view.setUint32(40, dataLen, true);
  out.set(pcmBytes, 44);
  return out;
}

/** Fetches `u`, checks `Content-Type` against `expectedKind`, and returns Base64 bytes. */
export async function fetchMedia(
  u: string,
  expectedKind: string,
  framePcmWav = false,
): Promise<FetchedMediaPayload> {
  const kind = expectedKind ? String(expectedKind).toLowerCase() : "";
  const parsed = ((): URL | null => {
    try {
      return new URL(u, location.href);
    } catch {
      return null;
    }
  })();

  const env = fifeEnv();
  const isDirectScheme =
    parsed?.protocol === "data:" || parsed?.protocol === "blob:";
  const isSignedCdn = Boolean(parsed && env.isSignedCdnHost(parsed));

  const modes: RequestCredentials[] =
    isSignedCdn || isDirectScheme
      ? ["omit"]
      : parsed && parsed.origin === location.origin
        ? ["same-origin", "include"]
        : ["include", "omit"];

  let r: Response | null = null;
  let lastErr: unknown = null;
  try {
    for (const mode of modes) {
      try {
        const resp = await fetch(
          u,
          isSignedCdn
            ? { credentials: mode, referrerPolicy: "no-referrer" }
            : { credentials: mode },
        );
        if (resp.ok) {
          r = resp;
          break;
        }
        lastErr = new Error(`HTTP ${resp.status}`);
      } catch (err) {
        lastErr = err;
      }
    }
    if (!r) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error(String(lastErr || "Media fetch failed"));
    }
    const ct = r.headers.get("content-type") || null;
    if (
      ct &&
      /^\s*(?:text\/|application\/(?:json|xml|dash\+xml|xhtml\+xml|vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl)\b/i.test(
        ct,
      )
    ) {
      throw new Error(`Media URL returned non-media content-type: ${ct}`);
    }
    if (ct && kind === "video" && /^\s*(?:image|audio)\//i.test(ct)) {
      throw new Error(`Media URL returned non-video content-type: ${ct}`);
    }
    if (ct && kind === "audio" && /^\s*(?:image|video)\//i.test(ct)) {
      throw new Error(`Media URL returned non-audio content-type: ${ct}`);
    }
    if (
      ct &&
      (kind === "image" || kind === "character") &&
      /^\s*(?:video|audio)\//i.test(ct)
    ) {
      throw new Error(`Media URL returned non-image content-type: ${ct}`);
    }
    const buf = await r.arrayBuffer();
    const rawBytes = new Uint8Array(buf);
    if (rawBytes.length === 0) {
      throw new Error("Media URL returned empty body");
    }
    if (looksLikeMarkupPayload(rawBytes)) {
      throw new Error("Media URL returned markup or JSON payload instead of media");
    }

    const explicitPcmMime = Boolean(
      ct && /^\s*audio\/(?:x-)?(?:pcm|l16|raw)\b/i.test(ct),
    );
    const explicitContainerAudioMime = Boolean(
      ct &&
        /^\s*(?:audio\/(?:mpeg|mp3|aac|mp4|x-m4a|wav|x-wav|wave|vnd\.wave|ogg|opus|flac|x-flac|webm|aiff|x-aiff)|application\/ogg)\b/i.test(
          ct,
        ),
    );
    const shouldFrameWav =
      kind === "audio" &&
      (framePcmWav || explicitPcmMime || isCachedPcmUrl(u)) &&
      !explicitContainerAudioMime &&
      !hasKnownMediaContainer(rawBytes);
    const bytes = shouldFrameWav ? framePcm24kMonoWav(rawBytes) : rawBytes;
    const finalCt = shouldFrameWav ? "audio/wav" : ct;

    const chunks: string[] = [];
    const chunk = 0x4000;
    for (let i = 0; i < bytes.length; i += chunk) {
      chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunk)));
    }
    return {
      b64: btoa(chunks.join("")),
      contentType: finalCt,
      disposition: r.headers.get("content-disposition") || null,
    };
  } finally {
    if (parsed?.protocol === "blob:") {
      consumeExportedBlobUrl(u);
    }
  }
}
