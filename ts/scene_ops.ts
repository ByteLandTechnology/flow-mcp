// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Create Google Flow scenes and append workflow clips via bound store state.

import { createScene } from "./angular";
import { delay, isTrashedTile } from "./dom";
import { activeProjectStoreFormat } from "./frontend_builds";
import { sceneContents } from "./scene_tiles";
import { clearStore, runtimeState } from "./state";
import type { FlowTile, SceneOpRequest } from "./types";

/** Maximum time in milliseconds to confirm clip workflows in `sceneContents(tile).clips`. */
const SCENE_CLIP_CONFIRM_MS = 6_000;

/** Returns true when `id` names an active clip workflow inside any live `SCENE` tile. */
function isActiveSceneClipWorkflow(tileMap: Map<string, FlowTile>, id: string): boolean {
  for (const tile of tileMap.values()) {
    if (!tile || isTrashedTile(tile) || tile.isPending) continue;
    if (String(tile.type ?? "").toUpperCase() !== "SCENE") continue;
    const { clips } = sceneContents(tile);
    if (clips.some((clip) => clip !== null && String(clip?.workflowId ?? "") === id)) {
      return true;
    }
  }
  return false;
}

/** Finds a tile in `tileMap` by direct key, `tile.id`, or `tile.workflowId`. */
function findTileByIdOrWorkflow(
  tileMap: Map<string, FlowTile>,
  id: string,
): FlowTile | undefined {
  const direct = tileMap.get(id);
  if (direct) return direct;
  for (const tile of tileMap.values()) {
    if (String(tile?.id ?? "") === id || String(tile?.workflowId ?? "") === id) {
      return tile;
    }
  }
  return undefined;
}

/** Checks that each entry in `rawIds` names a live `VIDEO` workflow and returns the workflow IDs. */
function resolveVideoWorkflowIds(
  tileMap: Map<string, FlowTile>,
  rawIds: string[],
): { ok: true; workflowIds: string[] } | { ok: false; error: string } {
  const workflowIds: string[] = [];
  for (const rawId of rawIds) {
    const id = String(rawId ?? "").trim();
    if (!id) {
      return { ok: false, error: "empty_video_asset_id" };
    }
    const tile = findTileByIdOrWorkflow(tileMap, id);
    if (tile) {
      if (isTrashedTile(tile) || tile.isPending) {
        return { ok: false, error: `video_asset_unavailable:${id}` };
      }
      const tileType = String(tile.type ?? "").toUpperCase();
      if (tileType !== "VIDEO") {
        return { ok: false, error: `non_video_asset:${id}:${tileType || "UNKNOWN"}` };
      }
      workflowIds.push(String(tile.workflowId || tile.id || id));
      continue;
    }
    if (isActiveSceneClipWorkflow(tileMap, id)) {
      workflowIds.push(id);
      continue;
    }
    return { ok: false, error: `video_asset_not_found:${id}` };
  }
  return { ok: true, workflowIds };
}

/** Polls `sceneContents(tile).clips` in `getMap()` for up to 6 seconds until all `workflowIds` appear. */
async function confirmSceneClips(
  getMap: () => Map<string, FlowTile> | null | undefined,
  sceneId: string,
  workflowIds: string[],
): Promise<{ ok: true; clipsCount: number } | { ok: false }> {
  const deadline = performance.now() + SCENE_CLIP_CONFIRM_MS;
  while (performance.now() < deadline) {
    const sceneTile = getMap()?.get(sceneId);
    if (
      sceneTile &&
      !isTrashedTile(sceneTile) &&
      !sceneTile.isPending &&
      String(sceneTile.type ?? "").toUpperCase() === "SCENE"
    ) {
      const { clips } = sceneContents(sceneTile);
      const activeClips = clips.filter((clip) => clip !== null);
      const present = new Set(
        activeClips.flatMap((clip) => (clip?.workflowId ? [String(clip.workflowId)] : [])),
      );
      if (workflowIds.every((wfId) => present.has(wfId))) {
        return { ok: true, clipsCount: activeClips.length };
      }
    }
    await delay(150);
  }
  return { ok: false };
}

/** Creates a scene or adds workflow clips to an existing scene. */
export async function sceneOp(req: SceneOpRequest): Promise<unknown> {
  if (!activeProjectStoreFormat()) {
    clearStore();
    return { ok: false, error: "unsupported_front_end" };
  }
  const helper = runtimeState.store;
  if (!helper || !helper.isCurrent()) {
    if (helper) clearStore();
    return { ok: false, error: "store_not_bound" };
  }
  if (!helper.isReady()) {
    return { ok: false, error: "store_loading" };
  }
  const getMap = (): Map<string, FlowTile> | null | undefined => helper.getTileMap();
  const tileMap = getMap();
  if (!(tileMap instanceof Map) || !helper.mutate) {
    return { ok: false, error: "store_not_bound" };
  }

  const action = String(req?.action || "").toLowerCase();

  if (action === "create") {
    const assetIds = Array.isArray(req?.asset_ids)
      ? req.asset_ids.map(String)
      : [];
    const resolved = resolveVideoWorkflowIds(tileMap, assetIds);
    if (!resolved.ok) {
      return resolved;
    }
    const created = await createScene(helper, getMap, resolved.workflowIds);
    if (!created?.ok || !created.id) {
      return created || { ok: false, error: "created_scene_id_not_found" };
    }
    const confirmed = await confirmSceneClips(getMap, created.id, resolved.workflowIds);
    if (!confirmed.ok) {
      return { ok: false, error: "scene_clips_not_confirmed", id: created.id };
    }
    if (req?.name && helper.rename) {
      try {
        await helper.rename(created.id, String(req.name));
        await delay(400);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err ?? "scene_rename_failed"),
        };
      }
    }
    return {
      ok: true,
      confirmed: true,
      id: created.id,
      name: req?.name ? String(req.name) : null,
      clips_count: confirmed.clipsCount,
    };
  }

  if (action === "add_clips") {
    const sceneId = String(req?.scene_id || "").trim();
    const assetIds = Array.isArray(req?.asset_ids)
      ? req.asset_ids.map(String)
      : [];
    if (!sceneId || !assetIds.length) {
      return { ok: false, error: "scene_id_and_asset_ids_required" };
    }
    const sceneTile = tileMap.get(sceneId);
    if (!sceneTile || isTrashedTile(sceneTile) || sceneTile.isPending) {
      return { ok: false, error: `scene_not_found:${sceneId}` };
    }
    const sceneType = String(sceneTile.type ?? "").toUpperCase();
    if (sceneType !== "SCENE") {
      return { ok: false, error: `non_scene_target:${sceneId}:${sceneType || "UNKNOWN"}` };
    }
    const resolved = resolveVideoWorkflowIds(tileMap, assetIds);
    if (!resolved.ok) {
      return resolved;
    }
    const { workflowIds } = resolved;
    let callbackErr: unknown = null;
    const completion = {
      resolve: () => {},
      reject: (err: unknown) => {
        callbackErr ??= err;
      },
    };
    try {
      await helper.mutate({
        type: "add_workflows_to_scene",
        Lc: sceneId,
        Ic: sceneId,
        rg: workflowIds,
        YWa: workflowIds,
        position: typeof req.position === "number" ? req.position : undefined,
        Mh: undefined,
        Eh: undefined,
        De: completion,
        ve: completion,
      });
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err ?? "add_workflows_failed"),
      };
    }
    if (callbackErr) {
      return {
        ok: false,
        error: callbackErr instanceof Error ? callbackErr.message : String(callbackErr),
      };
    }
    const confirmed = await confirmSceneClips(getMap, sceneId, workflowIds);
    if (!confirmed.ok) {
      return { ok: false, error: "scene_clips_not_confirmed", scene_id: sceneId };
    }
    return {
      ok: true,
      confirmed: true,
      scene_id: sceneId,
      added: workflowIds.length,
      clips_count: confirmed.clipsCount,
    };
  }

  return { ok: false, error: `unknown_scene_action:${action}` };
}
