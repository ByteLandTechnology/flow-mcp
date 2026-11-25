// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read clips and workflow history from the native scene tile.

import { readOwn } from "./angular";
import { frontendBuild, readBuildLabel } from "./frontend_builds";
import type { FlowMediaPayload, FlowTile, SceneClipItem } from "./types";

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
