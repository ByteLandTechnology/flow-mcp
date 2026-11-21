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
