// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Select ready 4K and 1080p video variants from tile.yn and collect tile media IDs.

import { readOwn } from "./angular";
import { isExpiredSignedUrl, legacyMedia, legacyTile, readMediaUrl } from "./dom";
import type { FlowMediaPayload, FlowTile } from "./types";

/** Selected media variant details for a video tile. */
export interface SelectedVideoVariant {
  /** Normalized media payload for the chosen variant or base video. */
  media: FlowMediaPayload | null;
  /** Primary media ID of the chosen variant when available. */
  primaryMediaId: string | null;
  /** Direct non-expired URL of the chosen variant when available on the tile. */
  url: string | null;
  /** Pixel width of the chosen variant when known. */
  width: number | null;
  /** Pixel height of the chosen variant when known. */
  height: number | null;
  /** Duration in seconds of the chosen variant when known. */
  duration: number | null;
  /** True when the chosen variant comes from `tile.yn`. */
  fromUpscale: boolean;
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

/** Reads the pixel width and height from a normalized media payload. */
function payloadDimensions(
  media: FlowMediaPayload | null | undefined,
): { width: number | null; height: number | null } {
  if (!media) return { width: null, height: null };
  const width =
    typeof media.width === "number" && media.width > 0
      ? media.width
      : typeof media.tc?.width === "number" && media.tc.width > 0
        ? media.tc.width
        : typeof media.xc?.width === "number" && media.xc.width > 0
          ? media.xc.width
          : null;
  const height =
    typeof media.height === "number" && media.height > 0
      ? media.height
      : typeof media.tc?.height === "number" && media.tc.height > 0
        ? media.tc.height
        : typeof media.xc?.height === "number" && media.xc.height > 0
          ? media.xc.height
          : null;
  return { width, height };
}

/** Reads the duration in seconds from a normalized media payload. */
function payloadDuration(media: FlowMediaPayload | null | undefined): number | null {
  if (!media) return null;
  if (typeof media.durationSeconds === "number") return media.durationSeconds;
  if (typeof media.duration === "number") return media.duration;
  if (typeof media.Lf === "number") return media.Lf;
  if (typeof media.xf === "number") return media.xf;
  return null;
}

/** Returns a resolution priority rank (`3` = 4K, `2` = 1080p, `1` = base or lower). */
export function variantResolutionRank(variant: FlowMediaPayload | null | undefined): number {
  if (!variant || typeof variant !== "object") return 0;
  const normalized = legacyMedia(variant);
  const rawRes = readOwn(variant, "resolution") ?? normalized.resolution;
  if (rawRes === 3) return 3;
  if (rawRes === 2) return 2;
  if (typeof rawRes === "string") {
    const lower = rawRes.trim().toLowerCase();
    if (lower === "4k" || lower === "2160p") return 3;
    if (lower === "1080p") return 2;
  }
  const { width, height } = payloadDimensions(normalized);
  if (width !== null && height !== null) {
    const shortEdge = Math.min(width, height);
    if (shortEdge > 1200) return 3;
    if (shortEdge > 800) return 2;
  }
  return 1;
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

/** Selects the highest ready variant in `tile.yn` (`4K`, then `1080p`, then base). */
export function selectBestVideoVariant(tile: FlowTile | null | undefined): SelectedVideoVariant {
  const t = legacyTile(tile);
  if (!t) {
    return {
      media: null,
      primaryMediaId: null,
      url: null,
      width: null,
      height: null,
      duration: null,
      fromUpscale: false,
    };
  }

  const upsampled = Array.isArray(t.yn) ? t.yn : [];
  let chosenUpscale: FlowMediaPayload | null = null;
  let chosenRank = 1;
  for (const item of upsampled) {
    if (!isReadyMediaVariant(item)) continue;
    const rank = variantResolutionRank(item);
    if (rank >= 2 && rank >= chosenRank) {
      chosenUpscale = legacyMedia(item);
      chosenRank = rank;
    }
  }

  if (chosenUpscale) {
    const variantId =
      cleanVariantMediaId(readOwn(chosenUpscale, "id")) ??
      cleanVariantMediaId(chosenUpscale.mediaId);
    const { width, height } = payloadDimensions(chosenUpscale);
    return {
      media: chosenUpscale,
      primaryMediaId: variantId,
      url: nonExpiredVariantUrl(chosenUpscale),
      width,
      height,
      duration: payloadDuration(chosenUpscale),
      fromUpscale: true,
    };
  }

  const baseMedia = t.Fb ?? t.fb ?? null;
  const baseId =
    cleanVariantMediaId(t.primaryMediaId) ??
    cleanVariantMediaId(baseMedia?.id) ??
    cleanVariantMediaId(baseMedia?.mediaId) ??
    cleanVariantMediaId(t.mediaId);
  const baseDims = payloadDimensions(baseMedia);
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
    payloadDuration(baseMedia) ??
    (typeof t.durationSeconds === "number"
      ? t.durationSeconds
      : typeof t.duration === "number"
        ? t.duration
        : typeof t.Lf === "number"
          ? t.Lf
          : null);
  const baseUrl =
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
    fromUpscale: false,
  };
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
