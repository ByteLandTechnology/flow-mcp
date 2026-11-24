// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Move an asset to trash through the active project store.

import { readOwn } from "./angular";
import { isTrashedTile } from "./dom";
import { readBuildLabel } from "./frontend_builds";
import { assetTrashCompatibility } from "./frontend_compatibility";
import { mutateAndVerify, projectMutationPending, projectsToRefresh, projectStore, readProjectStore, refreshAfterUnknown } from "./project_store";
import { sceneContents } from "./scene_tiles";
import type { FlowTile } from "./types";

/** Returns true when a scene still refers to the clip workflow. */
function isSceneClip(tiles: Iterable<FlowTile>, id: string): boolean {
  for (const scene of tiles) {
    if (scene.type !== "SCENE") continue;
    const { clips, history } = sceneContents(scene);
    if (clips.some((clip) => String(clip.workflowId) === id) || history.has(id)) return true;
  }
  return false;
}

/** Asset types that Flow can move to trash through the tile store. */
const TRASHABLE_TYPES = new Set(["IMAGE", "VIDEO", "CHARACTER", "SCENE", "TEXT_TILE"]);

/** Sends one verified trash request and checks the result from Flow. */
export async function trashAssetOp(projectId: string, session: string, id: string) {
  const store = projectStore(projectId, session);
  let tiles = store && readProjectStore(store);
  if (!store || !tiles) return { ok: false, error: "project_store_changed" };
  const support = assetTrashCompatibility();
  if (!support.ok) return support;
  if (projectMutationPending) return { ok: false, error: "project_mutation_pending" };
  if (projectsToRefresh.has(projectId) || !tiles.has(id)) {
    tiles = await refreshAfterUnknown(store);
    if (!tiles) return { ok: false, error: "project_refresh_failed", project_id: projectId };
  }

  const { format } = support;
  const tile = tiles.get(id);
  if (tile?.type === "COLLECTION") return { ok: false, error: "collection_path_required" };
  if (tile && (isTrashedTile(tile) || readOwn(tile, format.trashed) === true)) {
    return { ok: true, method: "already_trashed", confirmed: true };
  }
  if (tile ? tile.isPending || !TRASHABLE_TYPES.has(tile.type ?? "") : !isSceneClip(tiles.values(), id)) {
    return { ok: false, error: "asset_not_found", id };
  }
  if (!tile && !format.sceneWorkflows) {
    return {
      ok: false,
      error: "unsupported_front_end",
      build: readBuildLabel(),
      operation: "asset_trash_store",
      failed_checks: [
        { name: "scene_clip_delete_shape", ok: false, detail: "no verified sceneWorkflows field" },
      ],
    };
  }

  const payload = tile ? {
    type: "batch_set_tiles_trashed",
    [format.date]: new Date(),
    [format.entries]: [{ [format.tile]: tile, [format.trashed]: true, [format.destination]: { mode: "root" } }],
  } : { type: "batch_delete_tiles", [format.sceneWorkflows]: [id] };
  const after = await mutateAndVerify(store, payload, (fresh) => {
    if (!tile) return !isSceneClip(fresh.values(), id);
    const state = fresh.get(id);
    return !state || isTrashedTile(state) || readOwn(state, format.trashed) === true;
  });
  const method = tile ? `batch_set_tiles_trashed:${format.entries}` : "batch_delete_tiles:scene_clip";
  return after
    ? { ok: true, method, confirmed: true }
    : { ok: false, error: "outcome_unknown", stage: method, project_id: projectId, id };
}
