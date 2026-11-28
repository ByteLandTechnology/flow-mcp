// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Move an asset to trash through the active project store.

import { isTrashedTile } from "./dom";
import { assetTrashCompatibility } from "./frontend_compatibility";
import { mutateAndVerify, projectMutationPending, projectsToRefresh, projectStore, readProjectStore, refreshAfterUnknown } from "./project_store";
import { sceneContents, splitSceneClipId } from "./scene_tiles";
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

/** Counts active clip entries in `scene` that match `workflowId`, and returns the last index. */
function activeSceneClipState(
  scene: FlowTile | undefined,
  workflowId: string,
): { count: number; lastIndex: number } {
  if (!scene || isTrashedTile(scene) || scene.isPending || scene.type !== "SCENE") {
    return { count: 0, lastIndex: -1 };
  }
  const { clips } = sceneContents(scene);
  let count = 0;
  let lastIndex = -1;
  for (let i = 0; i < clips.length; i += 1) {
    if (String(clips[i]?.workflowId ?? "") === workflowId) {
      count += 1;
      lastIndex = i;
    }
  }
  return { count, lastIndex };
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
  const clipRef = splitSceneClipId(id);
  const lookupId = clipRef ? clipRef.sceneId : id;
  if (projectsToRefresh.has(projectId) || !tiles.has(lookupId)) {
    tiles = await refreshAfterUnknown(store);
    if (!tiles) return { ok: false, error: "project_refresh_failed", project_id: projectId };
  }

  const { format } = support;
  if (clipRef) {
    let state = activeSceneClipState(tiles.get(clipRef.sceneId), clipRef.workflowId);
    if (state.count === 0) return { ok: false, error: "asset_not_found", id };
    if (store.format.mutations?.clipIndex) {
      const method = "scene_delete_clip_mutation";
      while (state.count > 0 && state.lastIndex >= 0) {
        const expectedMax = state.count - 1;
        const after = await mutateAndVerify(
          store,
          {
            type: "single_tile",
            Xc: clipRef.sceneId,
            Ve: { type: "scene_delete_clip_mutation", ik: state.lastIndex },
          },
          (fresh) =>
            activeSceneClipState(fresh.get(clipRef.sceneId), clipRef.workflowId).count <= expectedMax,
        );
        if (!after) {
          return { ok: false, error: "outcome_unknown", stage: method, project_id: projectId, id };
        }
        state = activeSceneClipState(after.get(clipRef.sceneId), clipRef.workflowId);
      }
      return { ok: true, method, confirmed: true };
    }
    const method = "batch_delete_tiles:scene_clip";
    const after = await mutateAndVerify(
      store,
      { type: "batch_delete_tiles", [format.sceneWorkflows]: [clipRef.workflowId] },
      (fresh) => activeSceneClipState(fresh.get(clipRef.sceneId), clipRef.workflowId).count === 0,
    );
    return after
      ? { ok: true, method, confirmed: true }
      : { ok: false, error: "outcome_unknown", stage: method, project_id: projectId, id };
  }

  const tile = tiles.get(id);
  if (tile?.type === "COLLECTION") return { ok: false, error: "collection_path_required" };
  if (tile && isTrashedTile(tile)) return { ok: true, method: "already_trashed", confirmed: true };
  if (tile ? tile.isPending || !TRASHABLE_TYPES.has(tile.type ?? "") : !isSceneClip(tiles.values(), id)) {
    return { ok: false, error: "asset_not_found", id };
  }

  const payload = tile ? {
    type: "batch_set_tiles_trashed",
    [format.date]: new Date(),
    [format.entries]: [{ [format.tile]: tile, [format.trashed]: true, [format.destination]: { mode: "root" } }],
  } : { type: "batch_delete_tiles", [format.sceneWorkflows]: [id] };
  const after = await mutateAndVerify(store, payload, (fresh) => {
    if (!tile) return !isSceneClip(fresh.values(), id);
    const state = fresh.get(id);
    return !state || isTrashedTile(state);
  });
  const method = tile ? `batch_set_tiles_trashed:${format.entries}` : "batch_delete_tiles:scene_clip";
  return after
    ? { ok: true, method, confirmed: true }
    : { ok: false, error: "outcome_unknown", stage: method, project_id: projectId, id };
}
