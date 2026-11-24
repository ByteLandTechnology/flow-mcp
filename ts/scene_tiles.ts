// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read clips and workflow history from the native scene tile.

import { readOwn } from "./angular";
import { sceneTileFormats } from "./frontend_builds";
import type { FlowMediaPayload, FlowTile, SceneClipItem } from "./types";

/** Returns true when `value` holds a workflow history map or plain object. */
function isSceneHistory(
  value: unknown,
): value is Map<unknown, FlowMediaPayload[]> | Record<string, FlowMediaPayload[]> {
  if (value instanceof Map) return true;
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date),
  );
}

/** Returns the clip list and history of a scene in the active build. */
export function sceneContents(tile: FlowTile) {
  const formats = sceneTileFormats();
  let clips: unknown;
  for (const format of formats) {
    const candidate = readOwn(tile, format.clips);
    if (Array.isArray(candidate)) {
      clips = candidate;
      break;
    }
  }
  let history: unknown;
  for (const format of formats) {
    const candidate = readOwn(tile, format.history);
    if (isSceneHistory(candidate)) {
      history = candidate;
      break;
    }
  }
  const entries: Iterable<[unknown, FlowMediaPayload[]]> = history instanceof Map
    ? history.entries()
    : isSceneHistory(history) ? Object.entries(history) : [];
  return {
    clips: Array.isArray(clips) ? clips as SceneClipItem[] : [],
    history: new Map(Array.from(entries, ([id, media]) => [String(id), media])),
  };
}
