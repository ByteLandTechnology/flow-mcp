// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Create Google Flow scenes and append workflow clips via bound store state.

import { createScene } from "./angular";
import { delay } from "./dom";
import { activeProjectStoreFormat } from "./frontend_builds";
import { clearStore, runtimeState } from "./state";
import type { FlowTile, SceneOpRequest } from "./types";

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
  const resolveWfIds = (ids: string[]): string[] =>
    ids.map((id) => String(getMap()?.get(id)?.workflowId || id));

  if (action === "create") {
    const assetIds = Array.isArray(req?.asset_ids)
      ? req.asset_ids.map(String)
      : [];
    const created = await createScene(helper, getMap, resolveWfIds(assetIds));
    if (!created?.ok || !created.id) {
      return created || { ok: false, error: "created_scene_id_not_found" };
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
    let callbackErr: unknown = null;
    const completion = {
      resolve: () => {},
      reject: (err: unknown) => {
        callbackErr ??= err;
      },
    };
    const workflowIds = resolveWfIds(assetIds);
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
    await delay(400);
    return { ok: true, scene_id: sceneId, added: assetIds.length };
  }

  return { ok: false, error: `unknown_scene_action:${action}` };
}
