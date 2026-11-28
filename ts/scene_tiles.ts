// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read clips and workflow history from the native scene tile.

import { readOwn } from "./angular";
import { asHttpOrDataUrl, isExpiredSignedUrl, legacyMedia, readMediaUrl } from "./dom";
import { frontendBuild, readBuildLabel } from "./frontend_builds";
import {
  cleanVariantMediaId,
  collectReadyVideoVariants,
  selectPrimaryVideoMedia,
} from "./media_variants";
import type {
  FlowMediaPayload,
  FlowTile,
  SceneClipItem,
  SceneClipMediaEntry,
  VideoVariantEntry,
} from "./types";

/** Normalized scene download and clip metadata read from a `SCENE` tile. */
export interface SceneSnapshotInspection {
  /** Direct media ID for a single untrimmed clip scene, or null when export is required. */
  primaryMediaId: string | null;
  /** True when the scene has multiple clips or non-destructive clip trims. */
  requiresSceneExport: boolean;
  /** Non-expired direct URL for a single untrimmed clip scene when present. */
  singleUrl: string | null;
  /** Rendered width in pixels for a single untrimmed clip scene when known. */
  width: number | null;
  /** Rendered height in pixels for a single untrimmed clip scene when known. */
  height: number | null;
  /** Duration in seconds for a single untrimmed clip scene when known. */
  duration: number | null;
  /** Ready video variants on the underlying clip tile for a 1-clip untrimmed scene. */
  variants: VideoVariantEntry[];
  /** Active timeline clip workflow-to-media mappings for `<sceneId>:<wfId>` selectors. */
  sceneClips: SceneClipMediaEntry[];
}

/** Returns the clip list and history of a scene in the active build. */
export function sceneContents(tile: FlowTile) {
  const format = frontendBuild(readBuildLabel())?.projectStore.scene;
  const clips = (format && readOwn(tile, format.clips)) ?? tile.Oc;
  const history = (format && readOwn(tile, format.history)) ?? tile.Yf;
  const entries: Iterable<[string, FlowMediaPayload[]]> = history instanceof Map
    ? history.entries()
    : history && typeof history === "object" ? Object.entries(history) : [];
  return {
    clips: Array.isArray(clips) ? clips as SceneClipItem[] : [],
    history: new Map(Array.from(entries, ([id, media]) => [String(id), media])),
  };
}

/** Returns true when `clip` trims the start or end of its underlying video duration. */
export function isSceneClipTrimmed(
  clip: SceneClipItem | null | undefined,
  media: FlowMediaPayload | null | undefined,
): boolean {
  if (!clip) return false;
  const dur =
    typeof clip.nc === "number" && Number.isFinite(clip.nc) && clip.nc > 0
      ? clip.nc
      : typeof clip.rc === "number" && Number.isFinite(clip.rc) && clip.rc > 0
        ? clip.rc
        : typeof media?.durationSeconds === "number" && media.durationSeconds > 0
          ? media.durationSeconds
          : typeof media?.Lf === "number" && media.Lf > 0
            ? media.Lf
            : 8;
  const startRaw =
    typeof clip.Ji === "number" && Number.isFinite(clip.Ji)
      ? clip.Ji
      : typeof clip.Mh === "number" && Number.isFinite(clip.Mh)
        ? clip.Mh
        : typeof media?.Jc === "number" && Number.isFinite(media.Jc)
          ? media.Jc
          : 0;
  const start = Math.max(0, startRaw);
  const endRaw =
    typeof clip.Ci === "number" && Number.isFinite(clip.Ci) && clip.Ci > 0
      ? clip.Ci
      : typeof clip.Eh === "number" && Number.isFinite(clip.Eh) && clip.Eh > 0
        ? clip.Eh
        : typeof media?.Pc === "number" && Number.isFinite(media.Pc) && media.Pc > 0
          ? media.Pc
          : dur;
  const end = Math.min(endRaw, dur);
  return end > start && (start > 0 || end < dur - 0.01);
}

/** Inspects a `SCENE` tile for 1-clip direct download, multi-clip export, and `<sceneId>:<wfId>` clip mappings. */
export function inspectSceneTileSnapshot(
  tile: FlowTile,
  tileMap: Map<string, FlowTile>,
  normalizeVideoUrl: (url: string) => string,
): SceneSnapshotInspection {
  const nonExpired = (raw: unknown): string | null => {
    const direct = asHttpOrDataUrl(raw);
    return direct && !isExpiredSignedUrl(direct) ? direct : null;
  };
  const { clips, history } = sceneContents(tile);
  const seenWf = new Set<string>();
  const sceneClips: SceneClipMediaEntry[] = [];

  for (const clip of clips) {
    const wfId = clip?.workflowId != null ? String(clip.workflowId).trim() : "";
    if (!wfId || seenWf.has(wfId)) continue;
    seenWf.add(wfId);
    const hist = history.get(wfId);
    const clipMid = cleanVariantMediaId(clip?.primaryMediaId);
    const rawClipMedia = Array.isArray(hist)
      ? hist.find((x) => x && cleanVariantMediaId(x.id) === clipMid) ?? hist[0] ?? null
      : null;
    const mObj = legacyMedia(rawClipMedia);
    const wfTile = tileMap.get(wfId);
    const wfPrimary = wfTile ? selectPrimaryVideoMedia(wfTile) : null;
    const primaryId =
      clipMid ??
      cleanVariantMediaId(mObj?.id) ??
      wfPrimary?.primaryMediaId ??
      null;
    const status = String(mObj?.Zc ?? clip?.Zc ?? clip?.od ?? "").toLowerCase();
    const notReady =
      status === "pending" ||
      status === "scheduled" ||
      status === "failed" ||
      status === "canceled" ||
      Boolean(mObj?.nf || clip?.nf || clip?.Bf);
    const rawUrl = notReady
      ? null
      : nonExpired(readMediaUrl(mObj, true)) ||
        nonExpired(readMediaUrl(clip, true)) ||
        nonExpired(readMediaUrl(mObj)) ||
        nonExpired(readMediaUrl(clip)) ||
        (wfPrimary && wfPrimary.primaryMediaId === primaryId ? wfPrimary.url : null);
    sceneClips.push({
      workflow_id: wfId,
      primary_media_id: primaryId,
      url: rawUrl ? normalizeVideoUrl(rawUrl) : null,
    });
  }

  if (clips.length === 1) {
    const c0 = clips[0];
    const wfId = c0?.workflowId != null ? String(c0.workflowId).trim() : "";
    const hist = wfId ? history.get(wfId) : undefined;
    const clipMid = cleanVariantMediaId(c0?.primaryMediaId);
    const rawClipMedia = Array.isArray(hist)
      ? hist.find((x) => x && cleanVariantMediaId(x.id) === clipMid) ?? hist[0] ?? null
      : null;
    const m0 = legacyMedia(rawClipMedia);
    if (isSceneClipTrimmed(c0, m0)) {
      return {
        primaryMediaId: null,
        requiresSceneExport: true,
        singleUrl: null,
        width: null,
        height: null,
        duration: null,
        variants: [],
        sceneClips,
      };
    }
    const wfTile = wfId ? tileMap.get(wfId) : undefined;
    const wfPrimary = wfTile ? selectPrimaryVideoMedia(wfTile) : null;
    const primaryMediaId =
      clipMid ??
      cleanVariantMediaId(m0?.id) ??
      wfPrimary?.primaryMediaId ??
      null;
    const m0Status = String(m0?.Zc ?? c0?.Zc ?? c0?.od ?? "").toLowerCase();
    const m0NotReady =
      m0Status === "pending" ||
      m0Status === "scheduled" ||
      m0Status === "failed" ||
      m0Status === "canceled" ||
      Boolean(m0?.nf || c0?.nf || c0?.Bf);
    const singleUrl = m0NotReady
      ? null
      : nonExpired(readMediaUrl(m0, true)) ||
        nonExpired(readMediaUrl(c0, true)) ||
        nonExpired(readMediaUrl(m0)) ||
        nonExpired(readMediaUrl(c0)) ||
        (wfPrimary && wfPrimary.primaryMediaId === primaryMediaId ? wfPrimary.url : null);
    const width =
      typeof m0?.width === "number"
        ? m0.width
        : typeof m0?.tc?.width === "number"
          ? m0.tc.width
          : wfPrimary?.width ?? null;
    const height =
      typeof m0?.height === "number"
        ? m0.height
        : typeof m0?.tc?.height === "number"
          ? m0.tc.height
          : wfPrimary?.height ?? null;
    const duration =
      typeof c0?.nc === "number"
        ? c0.nc
        : typeof c0?.rc === "number"
          ? c0.rc
          : typeof m0?.Lf === "number"
            ? m0.Lf
            : wfPrimary?.duration ?? null;
    const variants = wfTile ? collectReadyVideoVariants(wfTile, normalizeVideoUrl) : [];
    return {
      primaryMediaId,
      requiresSceneExport: false,
      singleUrl,
      width,
      height,
      duration,
      variants,
      sceneClips,
    };
  }

  return {
    primaryMediaId: null,
    requiresSceneExport: clips.length > 1,
    singleUrl: null,
    width: null,
    height: null,
    duration: null,
    variants: [],
    sceneClips,
  };
}
