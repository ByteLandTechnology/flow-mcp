// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read clips and workflow history from the native scene tile.

import { readOwn } from "./angular";
import { frontendBuild, readBuildLabel } from "./frontend_builds";
import type { FlowMediaPayload, FlowTile, SceneClipItem } from "./types";

/** Finds a clip list array on `tile` by shape when build-specific field names drift. */
function findSceneClips(tile: FlowTile): SceneClipItem[] {
  for (const val of Object.values(tile as Record<string, unknown>)) {
    if (!Array.isArray(val) || val.length === 0) continue;
    const sample = val.find((item) => item && typeof item === "object");
    if (sample && ("workflowId" in sample || "primaryMediaId" in sample)) {
      return val as SceneClipItem[];
    }
  }
  return [];
}

/** Finds a workflow media history map on `tile` by shape when build-specific field names drift. */
function findSceneHistory(tile: FlowTile): Map<unknown, FlowMediaPayload[]> | null {
  for (const val of Object.values(tile as Record<string, unknown>)) {
    if (!(val instanceof Map) || val.size === 0) continue;
    for (const entry of val.values()) {
      if (!Array.isArray(entry)) break;
      const sample = entry.find((item) => item && typeof item === "object");
      if (!sample || "id" in sample || "workflowId" in sample) {
        return val as Map<unknown, FlowMediaPayload[]>;
      }
    }
  }
  return null;
}

/** Returns the clip list and history of a scene in the active build. */
export function sceneContents(tile: FlowTile): {
  clips: SceneClipItem[];
  history: Map<string, FlowMediaPayload[]>;
} {
  const format = frontendBuild(readBuildLabel())?.projectStore.scene;
  const knownClips = (format && readOwn(tile, format.clips)) ?? tile.Oc;
  const clips = Array.isArray(knownClips)
    ? (knownClips as SceneClipItem[])
    : findSceneClips(tile);
  const knownHistory = (format && readOwn(tile, format.history)) ?? tile.Yf;
  const historySource =
    knownHistory instanceof Map ||
    (knownHistory && typeof knownHistory === "object")
      ? knownHistory
      : findSceneHistory(tile);
  const entries: Iterable<[unknown, FlowMediaPayload[]]> =
    historySource instanceof Map
      ? historySource.entries()
      : historySource && typeof historySource === "object"
        ? Object.entries(historySource as Record<string, FlowMediaPayload[]>)
        : [];
  return {
    clips,
    history: new Map(Array.from(entries, ([id, media]) => [String(id), media])),
  };
}
