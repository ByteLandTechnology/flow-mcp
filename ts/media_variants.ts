// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Video upscale variant selection, signed URL expiry checks, and variant ID indexing.

import { readOwn } from "./angular";
import {
  characterLooksOf,
  findMediaContainer,
  legacyMedia,
  legacyTile,
  readMediaUrl,
  videoDimensions,
} from "./dom";
import { runtimeState } from "./state";
import type {
  CachedMediaInfo,
  FlowMediaPayload,
  FlowTile,
  SceneClipItem,
} from "./types";

/** Cache time-to-live for `as29s` media lookups in milliseconds (10 minutes). */
export const MEDIA_INFO_TTL_MS = 10 * 60 * 1000;

/** Clock-skew margin subtracted from signed URL expiry deadlines in milliseconds. */
const SIGNED_URL_SKEW_MS = 5 * 1000;

/** Priority score for each Flow video resolution code (`3` = 4K, `2` = 1080p, `1` = 720p, `4` = 360p). */
const RESOLUTION_PRIORITY: Readonly<Record<number, number>> = {
  3: 40,
  2: 30,
  1: 20,
  4: 10,
};

/** Selected video variant metadata from a project tile. */
export interface SelectedVideoVariant {
  /** Normalized media payload for the selected variant when present. */
  media: FlowMediaPayload | null;
  /** Primary media ID of the selected variant when known. */
  primaryMediaId: string | null;
  /** Non-expired inline media URL on the selected variant when available. */
  url: string | null;
  /** Pixel width of the selected variant when known. */
  width: number | null;
  /** Pixel height of the selected variant when known. */
  height: number | null;
  /** True when the selected variant comes from `tile.yn` upscales rather than the base container. */
  fromUpsample: boolean;
}

/** Strips resource collection prefixes (`media/` or `workflows/`) from an ID value. */
export function cleanMediaIdKey(value: unknown): string {
  if (typeof value === "string") {
    return value.trim().replace(/^(?:media|workflows)\//i, "");
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

/** Parses an `X-Goog-Date` ISO-8601 basic UTC timestamp (`YYYYMMDDTHHMMSSZ`) into epoch milliseconds. */
function parseGoogDateMs(raw: string): number | null {
  const trimmed = raw.trim();
  const basic = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i.exec(trimmed);
  if (basic) {
    const year = Number(basic[1]);
    const month = Number(basic[2]);
    const day = Number(basic[3]);
    const hour = Number(basic[4]);
    const minute = Number(basic[5]);
    const second = Number(basic[6]);
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > 31 ||
      hour > 23 ||
      minute > 59 ||
      second > 60
    ) {
      return null;
    }
    const ms = Date.UTC(year, month - 1, day, hour, minute, second);
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Returns true when `rawUrl` carries an expired GCS V4 (`X-Goog-Date` + `X-Goog-Expires`) or V2 (`Expires`) signature. */
export function isExpiredSignedUrl(
  rawUrl: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  let googDate: string | null = null;
  let googExpires: string | null = null;
  let v2Expires: string | null = null;
  let hasV2Sig = false;
  for (const [k, v] of parsed.searchParams.entries()) {
    const lower = k.toLowerCase();
    if (lower === "x-goog-date") googDate = v;
    else if (lower === "x-goog-expires") googExpires = v;
    else if (lower === "expires") v2Expires = v;
    else if (lower === "signature" || lower === "googleaccessid") hasV2Sig = true;
  }

  if (googDate !== null) {
    const issuedMs = parseGoogDateMs(googDate);
    if (issuedMs === null) return true;
    if (googExpires !== null) {
      const ttlSec = Number(googExpires.trim());
      if (!Number.isFinite(ttlSec) || ttlSec <= 0) return true;
      return nowMs + SIGNED_URL_SKEW_MS >= issuedMs + ttlSec * 1000;
    }
  }

  if (v2Expires !== null && hasV2Sig) {
    const rawExp = Number(v2Expires.trim());
    if (!Number.isFinite(rawExp) || rawExp <= 0) return true;
    const expMs = rawExp > 1e11 ? rawExp : rawExp * 1000;
    return nowMs + SIGNED_URL_SKEW_MS >= expMs;
  }

  return false;
}

/** Returns `rawUrl` when it is a non-empty, non-expired URL string, or null otherwise. */
export function nonExpiredMediaUrl(
  rawUrl: string | null | undefined,
  nowMs = Date.now(),
): string | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  return isExpiredSignedUrl(rawUrl, nowMs) ? null : rawUrl;
}

/** Reads a fresh, non-expired entry from `runtimeState.mediaInfoCache` and evicts stale records. */
export function getFreshCachedMedia(
  rawKey: string | null | undefined,
  nowMs = Date.now(),
): CachedMediaInfo | undefined {
  if (!rawKey) return undefined;
  const exactKey = String(rawKey).trim();
  if (!exactKey) return undefined;
  const cleanKey = cleanMediaIdKey(exactKey);
  const matchedKey = runtimeState.mediaInfoCache.has(exactKey)
    ? exactKey
    : cleanKey && runtimeState.mediaInfoCache.has(cleanKey)
      ? cleanKey
      : null;
  if (!matchedKey) return undefined;

  const entry = runtimeState.mediaInfoCache.get(matchedKey);
  if (!entry) return undefined;

  if (
    typeof entry.cached_at === "number" &&
    (!Number.isFinite(entry.cached_at) || nowMs - entry.cached_at >= MEDIA_INFO_TTL_MS)
  ) {
    runtimeState.mediaInfoCache.delete(matchedKey);
    return undefined;
  }

  const validCandidates = Array.isArray(entry.candidates)
    ? entry.candidates.filter(
        (c) => typeof c === "string" && c.length > 0 && !isExpiredSignedUrl(c, nowMs),
      )
    : [];
  if (
    !entry.url ||
    isExpiredSignedUrl(entry.url, nowMs) ||
    (entry.download_url && isExpiredSignedUrl(entry.download_url, nowMs)) ||
    validCandidates.length === 0
  ) {
    runtimeState.mediaInfoCache.delete(matchedKey);
    return undefined;
  }

  return {
    ...entry,
    download_url: entry.download_url || entry.url,
    candidates: validCandidates,
  };
}

/** Returns true when `variant` represents a finished, non-failed media item. */
export function isReadyMediaVariant(
  variant: FlowMediaPayload | null | undefined,
): boolean {
  if (!variant || typeof variant !== "object") return false;
  const uploaded = readOwn(variant, "vp");
  if (uploaded === false) return false;
  const normalized = legacyMedia(variant);
  const status = normalized?.Zc?.toLowerCase();
  if (normalized?.nf != null && normalized.nf !== "") return false;
  if (
    status === "pending" ||
    status === "scheduled" ||
    status === "failed" ||
    status === "canceled"
  ) {
    return false;
  }
  const source = readOwn(variant, "source");
  if (source === "GENERATED") {
    return status === "success";
  }
  return status === undefined || status === "success";
}

/** Infers a Flow video resolution code from explicit code, dimensions, or upsample ID suffix. */
function inferResolutionCode(variant: FlowMediaPayload): number {
  if (typeof variant.resolution === "number" && RESOLUTION_PRIORITY[variant.resolution]) {
    return variant.resolution;
  }
  const norm = legacyMedia(variant);
  const w = typeof variant.width === "number" ? variant.width : norm?.tc?.width;
  const h = typeof variant.height === "number" ? variant.height : norm?.tc?.height;
  if (typeof w === "number" && w > 0 && typeof h === "number" && h > 0) {
    const shortEdge = Math.min(w, h);
    if (shortEdge >= 2000) return 3;
    if (shortEdge >= 1000) return 2;
    if (shortEdge >= 700) return 1;
    return 4;
  }
  const rawId = String(variant.id ?? variant.mediaId ?? "").toLowerCase();
  if (rawId.includes("4k") || rawId.includes("2160")) return 3;
  if (rawId.includes("1080")) return 2;
  return 1;
}

/** Resolves pixel width and height for `variant` using `fallbackAspectRatio` when needed. */
function resolveVariantDimensions(
  variant: FlowMediaPayload,
  resCode: number,
  fallbackAspectRatio: number,
): { width: number | null; height: number | null } {
  const aspect =
    typeof variant.aspectRatio === "number" && variant.aspectRatio > 0
      ? variant.aspectRatio
      : fallbackAspectRatio;
  const computed = videoDimensions(resCode, aspect);
  const norm = legacyMedia(variant);
  const explicitW =
    typeof variant.width === "number" && variant.width > 0
      ? variant.width
      : typeof norm?.tc?.width === "number" && norm.tc.width > 0
        ? norm.tc.width
        : null;
  const explicitH =
    typeof variant.height === "number" && variant.height > 0
      ? variant.height
      : typeof norm?.tc?.height === "number" && norm.tc.height > 0
        ? norm.tc.height
        : null;

  if (explicitW !== null && explicitH !== null) {
    const explicitCode = inferResolutionCode({ width: explicitW, height: explicitH });
    if (!computed || explicitCode === resCode || typeof variant.resolution !== "number") {
      return { width: explicitW, height: explicitH };
    }
  }
  if (computed) {
    return { width: computed.width, height: computed.height };
  }
  return { width: explicitW, height: explicitH };
}

/** Reads the upsampled variant array `yn` from `tile` when present. */
function readUpsampledVariants(tile: FlowTile | null | undefined): FlowMediaPayload[] {
  if (!tile || typeof tile !== "object") return [];
  const yn = readOwn(tile, "yn");
  return Array.isArray(yn) ? (yn as FlowMediaPayload[]) : [];
}

/** Selects the highest-resolution ready video variant (`4K` > `1080p` > `720p`) from `tile`. */
export function selectBestVideoVariant(
  rawTile: FlowTile | null | undefined,
  nowMs = Date.now(),
): SelectedVideoVariant {
  const t = legacyTile(rawTile);
  if (!t) {
    return {
      media: null,
      primaryMediaId: null,
      url: null,
      width: null,
      height: null,
      fromUpsample: false,
    };
  }

  const baseMedia = t.Fb ?? findMediaContainer(t)?.[1] ?? null;
  const baseW =
    typeof t.width === "number" && t.width > 0
      ? t.width
      : typeof baseMedia?.width === "number" && baseMedia.width > 0
        ? baseMedia.width
        : typeof baseMedia?.tc?.width === "number" && baseMedia.tc.width > 0
          ? baseMedia.tc.width
          : null;
  const baseH =
    typeof t.height === "number" && t.height > 0
      ? t.height
      : typeof baseMedia?.height === "number" && baseMedia.height > 0
        ? baseMedia.height
        : typeof baseMedia?.tc?.height === "number" && baseMedia.tc.height > 0
          ? baseMedia.tc.height
          : null;
  const fallbackAspect =
    typeof t.aspectRatio === "number" && t.aspectRatio > 0
      ? t.aspectRatio
      : typeof baseMedia?.aspectRatio === "number" && baseMedia.aspectRatio > 0
        ? baseMedia.aspectRatio
        : baseW !== null && baseH !== null
          ? baseW / baseH
          : 16 / 9;

  let bestUpsample: {
    media: FlowMediaPayload;
    priority: number;
    resCode: number;
    url: string | null;
  } | null = null;

  for (const item of readUpsampledVariants(rawTile ?? t)) {
    if (!isReadyMediaVariant(item)) continue;
    const resCode = inferResolutionCode(item);
    const priority = RESOLUTION_PRIORITY[resCode] ?? 0;
    const itemUrl = nonExpiredMediaUrl(
      readMediaUrl(item, true) || readMediaUrl(item),
      nowMs,
    );
    if (
      !bestUpsample ||
      priority > bestUpsample.priority ||
      (priority === bestUpsample.priority && itemUrl !== null && bestUpsample.url === null)
    ) {
      bestUpsample = { media: item, priority, resCode, url: itemUrl };
    }
  }

  const baseCode = baseMedia ? inferResolutionCode(baseMedia) : 1;
  const basePriority =
    baseMedia && isReadyMediaVariant(baseMedia) ? (RESOLUTION_PRIORITY[baseCode] ?? 20) : 0;

  if (bestUpsample && bestUpsample.priority >= basePriority && bestUpsample.priority > 20) {
    const norm = legacyMedia({
      ...bestUpsample.media,
      aspectRatio: bestUpsample.media.aspectRatio ?? fallbackAspect,
    });
    const dims = resolveVariantDimensions(bestUpsample.media, bestUpsample.resCode, fallbackAspect);
    const idRaw = bestUpsample.media.id ?? bestUpsample.media.mediaId ?? null;
    const mediaId = idRaw != null && String(idRaw).trim() ? String(idRaw).trim() : null;
    return {
      media: norm ?? bestUpsample.media,
      primaryMediaId: mediaId,
      url: bestUpsample.url,
      width: dims.width,
      height: dims.height,
      fromUpsample: true,
    };
  }

  if (bestUpsample && (!baseMedia || !isReadyMediaVariant(baseMedia))) {
    const norm = legacyMedia({
      ...bestUpsample.media,
      aspectRatio: bestUpsample.media.aspectRatio ?? fallbackAspect,
    });
    const dims = resolveVariantDimensions(bestUpsample.media, bestUpsample.resCode, fallbackAspect);
    const idRaw = bestUpsample.media.id ?? bestUpsample.media.mediaId ?? null;
    const mediaId = idRaw != null && String(idRaw).trim() ? String(idRaw).trim() : null;
    return {
      media: norm ?? bestUpsample.media,
      primaryMediaId: mediaId,
      url: bestUpsample.url,
      width: dims.width,
      height: dims.height,
      fromUpsample: true,
    };
  }

  const baseIdRaw =
    t.primaryMediaId ?? baseMedia?.id ?? baseMedia?.mediaId ?? t.fb?.mediaId ?? t.mediaId ?? null;
  const baseId = baseIdRaw != null && String(baseIdRaw).trim() ? String(baseIdRaw).trim() : null;
  const baseUrl = nonExpiredMediaUrl(
    readMediaUrl(baseMedia, true) ||
      readMediaUrl(t, true) ||
      readMediaUrl(t.fb, true) ||
      readMediaUrl(baseMedia) ||
      readMediaUrl(t) ||
      readMediaUrl(t.fb),
    nowMs,
  );
  const baseDims = baseMedia
    ? resolveVariantDimensions(baseMedia, baseCode, fallbackAspect)
    : { width: baseW, height: baseH };
  return {
    media: baseMedia,
    primaryMediaId: baseId,
    url: baseUrl,
    width: baseDims.width ?? baseW,
    height: baseDims.height ?? baseH,
    fromUpsample: false,
  };
}

/** Returns the highest-resolution non-expired inline URL among ready `tile.yn` variants, or null. */
export function pickUpsampledTileUrl(
  rawTile: FlowTile | null | undefined,
  nowMs = Date.now(),
): string | null {
  let bestUrl: string | null = null;
  let bestPriority = -1;
  for (const item of readUpsampledVariants(rawTile)) {
    if (!isReadyMediaVariant(item)) continue;
    const url = nonExpiredMediaUrl(readMediaUrl(item, true) || readMediaUrl(item), nowMs);
    if (!url) continue;
    const priority = RESOLUTION_PRIORITY[inferResolutionCode(item)] ?? 0;
    if (priority > bestPriority) {
      bestPriority = priority;
      bestUrl = url;
    }
  }
  return bestUrl;
}

/** Collects unique media and variant IDs from `primaryMediaId`, `yn`, `history`, and character looks. */
export function collectTileVariantIds(rawTile: FlowTile | null | undefined): string[] {
  if (!rawTile || typeof rawTile !== "object") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const addId = (val: unknown): void => {
    if (val == null) return;
    const raw = String(val).trim();
    if (!raw) return;
    if (!seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
    const clean = cleanMediaIdKey(raw);
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  };

  addId(rawTile.primaryMediaId);
  const container = findMediaContainer(rawTile)?.[1];
  addId(container?.id);
  addId(container?.mediaId);
  addId(rawTile.Fb?.id);
  addId(rawTile.Kb?.id);

  for (const item of readUpsampledVariants(rawTile)) {
    addId(item?.id);
    addId(item?.mediaId);
  }
  const history = readOwn(rawTile, "history");
  if (Array.isArray(history)) {
    for (const item of history) {
      if (item && typeof item === "object") {
        addId(readOwn(item, "id"));
        addId(readOwn(item, "mediaId"));
      }
    }
  }
  const looks = characterLooksOf(rawTile);
  if (looks) {
    for (const entry of looks.values()) {
      addId(entry?.primaryMediaId);
      addId(entry?.id);
      if (Array.isArray(entry?.history)) {
        for (const h of entry.history) {
          addId(h?.id);
        }
      }
    }
  }
  return out;
}

/** Returns trim start, trim end, full duration, and whether `clip` trims its source media. */
export function sceneClipTrimState(clip: SceneClipItem | null | undefined): {
  startSec: number;
  endSec: number;
  durationSec: number;
  trimmed: boolean;
} {
  const rawFull =
    typeof clip?.nc === "number" && Number.isFinite(clip.nc) && clip.nc > 0
      ? clip.nc
      : typeof clip?.rc === "number" && Number.isFinite(clip.rc) && clip.rc > 0
        ? clip.rc
        : 8;
  const rawStart =
    typeof clip?.Ji === "number" && Number.isFinite(clip.Ji)
      ? clip.Ji
      : typeof clip?.Mh === "number" && Number.isFinite(clip.Mh)
        ? clip.Mh
        : 0;
  const startSec = Math.max(0, rawStart);
  const rawEnd =
    typeof clip?.Ci === "number" && Number.isFinite(clip.Ci) && clip.Ci > 0
      ? clip.Ci
      : typeof clip?.Eh === "number" && Number.isFinite(clip.Eh) && clip.Eh > 0
        ? clip.Eh
        : rawFull;
  const endSec = Math.min(rawEnd, rawFull);
  const trimmed =
    endSec > startSec && (startSec > 0 || endSec < rawFull - 0.01);
  return {
    startSec,
    endSec: endSec > startSec ? endSec : rawFull,
    durationSec: rawFull,
    trimmed,
  };
}

/** Returns the sole clip when `clips` represents a single-clip untrimmed scene with a primary media ID. */
export function sceneSingleUntrimmedClip(clips: SceneClipItem[]): SceneClipItem | null {
  if (!Array.isArray(clips) || clips.length !== 1) return null;
  const first = clips[0];
  if (!first) return null;
  const mediaId = cleanMediaIdKey(first.primaryMediaId);
  if (!mediaId) return null;
  const { trimmed } = sceneClipTrimState(first);
  return trimmed ? null : first;
}
