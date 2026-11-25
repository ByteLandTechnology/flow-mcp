// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Create Google Flow scenes and append workflow clips via bound store state.

import { createScene } from "./angular";
import { delay, isTrashedTile } from "./dom";
import { activeProjectStoreFormat } from "./frontend_builds";
import { activeProjectStore, mutateAndVerify, refreshProjectStore } from "./project_store";
import { sceneContents } from "./scene_tiles";
import { clearStore, runtimeState } from "./state";
import type { FlowTile, SceneOpRequest } from "./types";

/** Counts occurrences of each workflow ID in `workflowIds`. */
function countWorkflows(workflowIds: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const wfId of workflowIds) {
    counts.set(wfId, (counts.get(wfId) ?? 0) + 1);
  }
  return counts;
}

/** Checks that `tile` is a settled `SCENE` tile whose `Uc` clips include `expectedCounts`. */
function sceneClipsContain(
  tile: FlowTile | undefined,
  minLength: number,
  expectedCounts: ReadonlyMap<string, number>,
  expectedSlice?: { start: number; workflows: readonly string[] },
): boolean {
  if (!tile || isTrashedTile(tile) || tile.isPending === true) return false;
  if (String(tile.type ?? "").toUpperCase() !== "SCENE") return false;
  const clipWorkflows = sceneContents(tile)
    .clips.map((clip) => String(clip?.workflowId ?? "").trim())
    .filter(Boolean);
  if (clipWorkflows.length < minLength) return false;
  const actualCounts = countWorkflows(clipWorkflows);
  for (const [wfId, needed] of expectedCounts.entries()) {
    if ((actualCounts.get(wfId) ?? 0) < needed) return false;
  }
  if (expectedSlice && clipWorkflows.length === minLength) {
    const { start, workflows } = expectedSlice;
    for (let i = 0; i < workflows.length; i++) {
      if (clipWorkflows[start + i] !== workflows[i]) return false;
    }
  }
  return true;
}

/** Resolves one requested asset ID to a non-trashed `VIDEO` tile in `tiles`. */
function lookupTileForClip(
  tiles: Map<string, FlowTile>,
  rawId: string,
): { ok: true; tile: FlowTile } | { ok: false; error: string } {
  const colon = rawId.indexOf(":");
  const lookupKey =
    colon > 0 && colon < rawId.length - 1 && !tiles.has(rawId)
      ? rawId.slice(colon + 1)
      : rawId;
  if (lookupKey !== rawId) {
    const sourceSceneId = rawId.slice(0, colon);
    const sourceScene = tiles.get(sourceSceneId);
    if (
      !sourceScene ||
      isTrashedTile(sourceScene) ||
      String(sourceScene.type ?? "").toUpperCase() !== "SCENE" ||
      !sceneContents(sourceScene).clips.some(
        (clip) => String(clip?.workflowId ?? "") === lookupKey,
      )
    ) {
      return { ok: false, error: `asset_not_found:${rawId}` };
    }
  }

  let matched = tiles.get(lookupKey);
  if (!matched || isTrashedTile(matched)) {
    matched = undefined;
    for (const candidate of tiles.values()) {
      if (
        candidate &&
        !isTrashedTile(candidate) &&
        (String(candidate.workflowId ?? "") === lookupKey ||
          String(candidate.id ?? "") === lookupKey)
      ) {
        matched = candidate;
        break;
      }
    }
  }
  if (!matched || isTrashedTile(matched)) {
    return { ok: false, error: `asset_not_found:${rawId}` };
  }
  const tileType = String(matched.type ?? "").toUpperCase();
  if (tileType !== "VIDEO") {
    return { ok: false, error: `asset_not_video:${rawId}:${tileType || "UNKNOWN"}` };
  }
  if (matched.isPending === true) {
    return { ok: false, error: `video_asset_pending:${rawId}` };
  }
  return { ok: true, tile: matched };
}

/** Validates that every ID in `assetIds` resolves to a `VIDEO` workflow ID. */
function resolveVerifiedVideoWorkflows(
  tiles: Map<string, FlowTile>,
  assetIds: readonly string[],
): { ok: true; workflowIds: string[] } | { ok: false; error: string } {
  const workflowIds: string[] = [];
  for (const raw of assetIds) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) {
      return { ok: false, error: "empty_asset_id" };
    }
    const found = lookupTileForClip(tiles, trimmed);
    if (!found.ok) return found;
    const wfId = String(found.tile.workflowId || found.tile.id || "").trim();
    if (!wfId) {
      return { ok: false, error: `video_workflow_id_missing:${trimmed}` };
    }
    workflowIds.push(wfId);
  }
  return { ok: true, workflowIds };
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
    const resolved = resolveVerifiedVideoWorkflows(tileMap, assetIds);
    if (!resolved.ok) return resolved;
    const { workflowIds } = resolved;

    const created = await createScene(helper, getMap, workflowIds);
    if (!created?.ok || !created.id) {
      return created || { ok: false, error: "created_scene_id_not_found" };
    }

    const expectedCounts = countWorkflows(workflowIds);
    const store = activeProjectStore();
    let confirmed = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const freshTiles = store
        ? await refreshProjectStore(store).catch(() => null)
        : getMap();
      if (
        freshTiles instanceof Map &&
        sceneClipsContain(freshTiles.get(created.id), workflowIds.length, expectedCounts, {
          start: 0,
          workflows: workflowIds,
        })
      ) {
        confirmed = true;
        break;
      }
      await delay(250);
    }
    if (!confirmed) {
      return { ok: false, error: "created_scene_clips_not_confirmed" };
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
      id: created.id,
      name: req?.name ? String(req.name) : null,
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
    if (!sceneTile || isTrashedTile(sceneTile)) {
      return { ok: false, error: `scene_not_found:${sceneId}` };
    }
    const sceneType = String(sceneTile.type ?? "").toUpperCase();
    if (sceneType !== "SCENE") {
      return { ok: false, error: `tile_not_scene:${sceneId}:${sceneType || "UNKNOWN"}` };
    }
    if (sceneTile.isPending === true) {
      return { ok: false, error: `scene_pending:${sceneId}` };
    }

    const resolved = resolveVerifiedVideoWorkflows(tileMap, assetIds);
    if (!resolved.ok) return resolved;
    const { workflowIds } = resolved;

    const store = activeProjectStore();
    if (!store) {
      return { ok: false, error: "store_not_bound" };
    }

    const beforeWorkflows = sceneContents(sceneTile)
      .clips.map((clip) => String(clip?.workflowId ?? "").trim())
      .filter(Boolean);
    const insertPos =
      typeof req.position === "number" && Number.isFinite(req.position)
        ? Math.max(0, Math.min(Math.trunc(req.position), beforeWorkflows.length))
        : beforeWorkflows.length;
    const expectedTotal = beforeWorkflows.length + workflowIds.length;
    const expectedCounts = countWorkflows([...beforeWorkflows, ...workflowIds]);

    let callbackErr: unknown = null;
    const completion = {
      resolve: () => {},
      reject: (err: unknown) => {
        callbackErr ??= err;
      },
    };
    const confirmedTiles = await mutateAndVerify(
      store,
      {
        type: "add_workflows_to_scene",
        Lc: sceneId,
        Ic: sceneId,
        rg: workflowIds,
        YWa: workflowIds,
        position: insertPos,
        Mh: undefined,
        Eh: undefined,
        De: completion,
        ve: completion,
      },
      (freshTiles) =>
        sceneClipsContain(freshTiles.get(sceneId), expectedTotal, expectedCounts, {
          start: insertPos,
          workflows: workflowIds,
        }),
    );
    if (!confirmedTiles) {
      const detail = callbackErr
        ? callbackErr instanceof Error
          ? callbackErr.message
          : String(callbackErr)
        : "add_clips_not_confirmed";
      return { ok: false, error: detail };
    }
    return { ok: true, scene_id: sceneId, added: workflowIds.length };
  }

  return { ok: false, error: `unknown_scene_action:${action}` };
}
