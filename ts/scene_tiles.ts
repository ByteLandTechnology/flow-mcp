// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read clips and workflow history from the native scene tile.

import { readOwn } from "./angular";
import { sceneTileFormats } from "./frontend_builds";
import type { FlowMediaPayload, FlowTile, SceneClipItem } from "./types";

/** Returns true when `value` is a workflow history map or plain record. */
function isHistoryRecord(value: unknown): boolean {
  return value instanceof Map || (Boolean(value) && typeof value === "object" && !Array.isArray(value));
}

/** Returns the clip list and history of a scene in the active build. */
export function sceneContents(tile: FlowTile) {
  let clips: unknown;
  let history: unknown;
  for (const format of sceneTileFormats()) {
    if (!Array.isArray(clips)) {
      const candidate = readOwn(tile, format.clips);
      if (Array.isArray(candidate)) clips = candidate;
    }
    if (!isHistoryRecord(history)) {
      const candidate = readOwn(tile, format.history);
      if (isHistoryRecord(candidate)) history = candidate;
    }
  }
  if (!Array.isArray(clips)) clips = tile.Oc;
  if (!isHistoryRecord(history)) history = tile.Yf;
  const entries: Iterable<[string, FlowMediaPayload[]]> = history instanceof Map
    ? history.entries()
    : history && typeof history === "object" ? Object.entries(history) : [];
  return {
    clips: Array.isArray(clips) ? clips as SceneClipItem[] : [],
    history: new Map(Array.from(entries, ([id, media]) => [String(id), media])),
  };
}
