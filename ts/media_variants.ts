// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Inspect primary video media, verified resolution variants in tile.yn, and tile media IDs.

import { readOwn } from "./angular";
import { isExpiredSignedUrl, legacyMedia, legacyTile, readMediaUrl } from "./dom";
import { snapshotFormat } from "./frontend_builds";
import type {
  FlowMediaPayload,
  FlowTile,
  VideoQualityLabel,
  VideoVariantEntry,
} from "./types";

/** Primary media details read from a video tile without forcing upscaled variants. */
export interface PrimaryVideoMedia {
  /** Normalized primary media payload when present. */
  media: FlowMediaPayload | null;
  /** Primary media ID of the tile's base video when available. */
  primaryMediaId: string | null;
  /** Direct non-expired URL of the tile's base video when available. */
  url: string | null;
  /** Pixel width of the base video when known. */
  width: number | null;
  /** Pixel height of the base video when known. */
  height: number | null;
  /** Duration in seconds of the base video when known. */
  duration: number | null;
}

/** Strips an optional leading `media/` prefix from a media identifier. */
export function cleanVariantMediaId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const cleaned = String(value).trim().replace(/^media\//i, "");
  return cleaned || null;
}

/** Returns true when `variant` has finished generating or uploading without errors. */
export function isReadyMediaVariant(variant: FlowMediaPayload | null | undefined): boolean {
  if (!variant || typeof variant !== "object") return false;
  const normalized = legacyMedia(variant);
  if (normalized.nf != null && normalized.nf !== "") return false;
  const uploaded = readOwn(variant, "vp");
  if (uploaded === false) return false;
  const source = readOwn(variant, "source");
  const status = normalized.Zc?.toLowerCase();
  if (
    status === "pending" ||
    status === "scheduled" ||
    status === "failed" ||
    status === "canceled"
  ) {
    return false;
  }
  if (source === "GENERATED") return status === "success";
  if (source === "UPLOADED" && typeof uploaded === "boolean" && !uploaded) return false;
  return status === undefined || status === "success";
}

/** Reads explicit pixel dimensions from `media` before synthetic resolution fallback. */
function explicitDimensions(
  media: FlowMediaPayload | null | undefined,
): { width: number | null; height: number | null } {
  if (!media || typeof media !== "object") return { width: null, height: null };
  const mappedKey = snapshotFormat()?.media.dimensions;
  const mapped = mappedKey
    ? (readOwn(media, mappedKey) as { width?: unknown; height?: unknown } | undefined)
    : undefined;
  for (const cand of [media, mapped, media.tc, media.xc]) {
    if (!cand || typeof cand !== "object") continue;
    const w = readOwn(cand, "width");
    const h = readOwn(cand, "height");
    if (typeof w === "number" && w > 0 && typeof h === "number" && h > 0) {
      return { width: w, height: h };
    }
  }
  return { width: null, height: null };
}

/** Reads pixel dimensions from a normalized media payload on verified builds or explicit fields. */
function payloadDimensions(
  rawMedia: FlowMediaPayload | null | undefined,
): { width: number | null; height: number | null } {
  const explicit = explicitDimensions(rawMedia);
  if (explicit.width !== null && explicit.height !== null) {
    return explicit;
  }
  if (!rawMedia || !snapshotFormat()?.media.resolutions) {
    return { width: null, height: null };
  }
  const normalized = legacyMedia(rawMedia);
  const w = normalized?.tc?.width;
  const h = normalized?.tc?.height;
  return typeof w === "number" && w > 0 && typeof h === "number" && h > 0
    ? { width: w, height: h }
    : { width: null, height: null };
}

/** Reads the duration in seconds from a normalized media payload. */
function payloadDuration(media: FlowMediaPayload | null | undefined): number | null {
  if (!media) return null;
  const normalized = legacyMedia(media);
  if (typeof normalized.durationSeconds === "number") return normalized.durationSeconds;
  if (typeof normalized.duration === "number") return normalized.duration;
  if (typeof normalized.Lf === "number") return normalized.Lf;
  if (typeof normalized.xf === "number") return normalized.xf;
  return null;
}

/** Parses an explicit string resolution label into a canonical quality label. */
function parseQualityLabel(raw: unknown): VideoQualityLabel | null {
  if (typeof raw !== "string") return null;
  const lower = raw.trim().toLowerCase();
  if (lower === "4k" || lower === "2160p") return "4k";
  if (lower === "1080p") return "1080p";
  if (lower === "720p") return "720p";
  if (lower === "360p") return "360p";
  return null;
}

/** Classifies the video quality of `variant` using verified build codes, string labels, or pixel dimensions. */
export function classifyVideoQuality(
  variant: FlowMediaPayload | null | undefined,
): VideoQualityLabel | null {
  if (!variant || typeof variant !== "object") return null;
  const rawRes = readOwn(variant, "resolution") ?? variant.resolution;
  const stringLabel = parseQualityLabel(rawRes);
  if (stringLabel) return stringLabel;

  if (typeof rawRes === "number") {
    const mediaFmt = snapshotFormat()?.media;
    const codes = mediaFmt?.resolutions;
    if (codes) {
      if (rawRes === codes.p4k) return "4k";
      if (rawRes === codes.p1080) return "1080p";
      if (rawRes === codes.p720) return "720p";
      if (rawRes === codes.p360) return "360p";
      if (mediaFmt?.resolutionLabelFn) {
        const ns = readOwn(window, "default_AiSandboxAngularFrontend");
        const labelFn = readOwn(ns, mediaFmt.resolutionLabelFn);
        if (typeof labelFn === "function") {
          try {
            const mapped = parseQualityLabel(
              (labelFn as (code: number) => unknown).call(ns, rawRes),
            );
            if (mapped && mapped !== "720p") return mapped;
          } catch {
            // Fall through to pixel dimension check.
          }
        }
      }
    }
  }

  const { width, height } = explicitDimensions(variant);
  if (width !== null && height !== null) {
    const shortEdge = Math.min(width, height);
    if (shortEdge >= 1800) return "4k";
    if (shortEdge >= 960) return "1080p";
    if (shortEdge >= 540) return "720p";
    if (shortEdge > 0) return "360p";
  }
  return null;
}

/** Reads the first non-expired video or media URL from `source`. */
function nonExpiredVariantUrl(source: unknown): string | null {
  for (const cand of [readMediaUrl(source, true), readMediaUrl(source, false)]) {
    if (cand && !isExpiredSignedUrl(cand)) {
      return cand;
    }
  }
  return null;
}

/** Reads the tile's own primary video media without overriding it with `tile.yn` upscales. */
export function selectPrimaryVideoMedia(
  tile: FlowTile | null | undefined,
): PrimaryVideoMedia {
  const t = legacyTile(tile);
  if (!t) {
    return {
      media: null,
      primaryMediaId: null,
      url: null,
      width: null,
      height: null,
      duration: null,
    };
  }
  const rawContainer =
    (snapshotFormat()?.media.container
      ? (readOwn(tile, snapshotFormat()!.media.container) as FlowMediaPayload | undefined)
      : undefined) ??
    tile?.Kb ??
    tile?.Eb ??
    t.Fb ??
    t.fb ??
    null;
  const baseMedia = t.Fb ?? t.fb ?? legacyMedia(rawContainer);
  const baseId =
    cleanVariantMediaId(t.primaryMediaId) ??
    cleanVariantMediaId(rawContainer?.id) ??
    cleanVariantMediaId(baseMedia?.id) ??
    cleanVariantMediaId(baseMedia?.mediaId) ??
    cleanVariantMediaId(t.mediaId);
  const baseDims = payloadDimensions(rawContainer ?? baseMedia);
  const width =
    baseDims.width ??
    (typeof t.width === "number" && t.width > 0
      ? t.width
      : typeof t.tc?.width === "number" && t.tc.width > 0
        ? t.tc.width
        : null);
  const height =
    baseDims.height ??
    (typeof t.height === "number" && t.height > 0
      ? t.height
      : typeof t.tc?.height === "number" && t.tc.height > 0
        ? t.tc.height
        : null);
  const duration =
    payloadDuration(rawContainer ?? baseMedia) ??
    (typeof t.durationSeconds === "number"
      ? t.durationSeconds
      : typeof t.duration === "number"
        ? t.duration
        : typeof t.Lf === "number"
          ? t.Lf
          : null);
  const baseUrl =
    nonExpiredVariantUrl(rawContainer) ??
    nonExpiredVariantUrl(t.Fb) ??
    nonExpiredVariantUrl(t) ??
    nonExpiredVariantUrl(t.fb);

  return {
    media: baseMedia,
    primaryMediaId: baseId,
    url: baseUrl,
    width,
    height,
    duration,
  };
}

/** Collects ready base and `tile.yn` video resolution variants for explicit quality selection. */
export function collectReadyVideoVariants(
  tile: FlowTile | null | undefined,
  normalizeUrl?: (url: string) => string,
): VideoVariantEntry[] {
  if (!tile || typeof tile !== "object") return [];
  const t = legacyTile(tile);
  const byMediaId = new Map<string, VideoVariantEntry>();
  const recordVariant = (
    rawItem: FlowMediaPayload | null | undefined,
    fallbackId: string | null,
    fallbackSource?: unknown,
  ): void => {
    if (!rawItem || !isReadyMediaVariant(rawItem)) return;
    const mediaId =
      cleanVariantMediaId(readOwn(rawItem, "id")) ??
      cleanVariantMediaId(rawItem.mediaId) ??
      fallbackId;
    if (!mediaId) return;
    const quality = classifyVideoQuality(rawItem);
    const rawUrl =
      nonExpiredVariantUrl(rawItem) ??
      (fallbackSource ? nonExpiredVariantUrl(fallbackSource) : null);
    const url = rawUrl ? (normalizeUrl ? normalizeUrl(rawUrl) : rawUrl) : null;
    const { width, height } = payloadDimensions(rawItem);
    const duration = payloadDuration(rawItem);
    const prev = byMediaId.get(mediaId);
    if (prev) {
      prev.quality ??= quality;
      prev.url ??= url;
      prev.width ??= width;
      prev.height ??= height;
      prev.duration ??= duration;
      return;
    }
    byMediaId.set(mediaId, {
      media_id: mediaId,
      quality,
      url,
      width,
      height,
      duration,
    });
  };

  const containerKey = snapshotFormat()?.media.container;
  const rawBase =
    (containerKey
      ? (readOwn(tile, containerKey) as FlowMediaPayload | undefined)
      : undefined) ??
    tile.Kb ??
    tile.Eb ??
    t?.Fb ??
    t?.fb ??
    null;
  recordVariant(rawBase, cleanVariantMediaId(tile.primaryMediaId), t);

  if (Array.isArray(tile.yn)) {
    for (const item of tile.yn) {
      recordVariant(item, null);
    }
  }
  return Array.from(byMediaId.values());
}

/** Collects all unique primary, history, and `tile.yn` media IDs from `tile`. */
export function collectTileMediaIds(
  tile: FlowTile | null | undefined,
  primaryMediaId: string | null,
): string[] {
  const out: string[] = [];
  const pushId = (raw: unknown): void => {
    const cleaned = cleanVariantMediaId(raw);
    if (cleaned && !out.includes(cleaned)) {
      out.push(cleaned);
    }
  };
  pushId(primaryMediaId);
  if (!tile || typeof tile !== "object") return out;
  pushId(tile.primaryMediaId);
  pushId(tile.Fb?.id);
  pushId(tile.Fb?.mediaId);
  pushId(tile.Kb?.id);
  pushId(tile.Eb?.id);
  pushId(tile.fb?.mediaId);
  pushId(tile.mediaId);
  if (Array.isArray(tile.history)) {
    for (const item of tile.history) {
      pushId(readOwn(item, "id"));
      pushId(readOwn(item, "mediaId"));
    }
  }
  if (Array.isArray(tile.yn)) {
    for (const item of tile.yn) {
      pushId(readOwn(item, "id"));
      pushId(readOwn(item, "mediaId"));
    }
  }
  return out;
}
