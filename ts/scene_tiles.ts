// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read clips and workflow history from the native scene tile.

import { readOwn } from "./angular";
import { frontendBuild, readBuildLabel } from "./frontend_builds";
import type { FlowMediaPayload, FlowTile, SceneClipItem } from "./types";

/** Returns true when `v` is a workflow history map or plain lookup object. */
function isHistoryLookup(
  v: unknown,
): v is Map<string, unknown> | Record<string, unknown> {
  return (
    v instanceof Map ||
    (Boolean(v) && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date))
  );
}

/** Extracts the workflow media array from a history map entry value. */
function toHistoryArray(val: unknown): FlowMediaPayload[] {
  if (Array.isArray(val)) return val as FlowMediaPayload[];
  const nested = readOwn(val, "history");
  return Array.isArray(nested) ? (nested as FlowMediaPayload[]) : [];
}

/** Returns the clip list and history of a scene in the active build. */
export function sceneContents(tile: FlowTile) {
  const format = frontendBuild(readBuildLabel())?.projectStore.scene;
  const ownValues = tile && typeof tile === "object" ? Object.values(tile) : [];
  const clips =
    [format && readOwn(tile, format.clips), tile.Uc, tile.Tc, tile.Oc].find(
      Array.isArray,
    ) ??
    ownValues.find(
      (v) =>
        Array.isArray(v) &&
        v.some(
          (item) =>
            Boolean(item) &&
            typeof item === "object" &&
            ("workflowId" in item || "primaryMediaId" in item),
        ),
    );
  const history =
    [format && readOwn(tile, format.history), tile.Cg, tile.tg, tile.Yf].find(
      isHistoryLookup,
    ) ??
    ownValues.find(
      (v): v is Map<string, unknown> =>
        v instanceof Map &&
        Array.from(v.values()).some(
          (item) => Array.isArray(item) || Array.isArray(readOwn(item, "history")),
        ),
    );
  const entries: Iterable<[unknown, unknown]> =
    history instanceof Map
      ? history.entries()
      : history
        ? Object.entries(history)
        : [];
  return {
    clips: Array.isArray(clips) ? (clips as SceneClipItem[]) : [],
    history: new Map(
      Array.from(entries, ([id, media]) => [String(id), toHistoryArray(media)]),
    ),
  };
}
