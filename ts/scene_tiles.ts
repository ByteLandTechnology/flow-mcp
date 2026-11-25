// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read clips and workflow history from the native scene tile.

import { readOwn } from "./angular";
import { frontendBuild, readBuildLabel } from "./frontend_builds";
import type { FlowMediaPayload, FlowTile, SceneClipItem } from "./types";

/** Returns the clip list and history of a scene in the active build. */
export function sceneContents(tile: FlowTile) {
  const format = frontendBuild(readBuildLabel())?.projectStore.scene;
  const clips = (format && readOwn(tile, format.clips)) ?? readOwn(tile, "Uc") ?? tile.Oc;
  const history = (format && readOwn(tile, format.history)) ?? readOwn(tile, "Cg") ?? tile.Yf;
  const entries: Iterable<[string, FlowMediaPayload[]]> = history instanceof Map
    ? history.entries()
    : history && typeof history === "object" ? Object.entries(history) : [];
  return {
    clips: Array.isArray(clips) ? clips as SceneClipItem[] : [],
    history: new Map(Array.from(entries, ([id, media]) => [String(id), media])),
  };
}

/** Extracts ordered workflow clip IDs from a scene tile. */
export function sceneClipIds(tile: FlowTile): string[] {
  const { clips } = sceneContents(tile);
  const ids: string[] = [];
  for (const item of clips as unknown[]) {
    const raw =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? String(readOwn(item, "workflowId") ?? readOwn(item, "id") ?? "")
          : "";
    const trimmed = raw.trim();
    if (trimmed && !ids.includes(trimmed)) ids.push(trimmed);
  }
  return ids;
}
