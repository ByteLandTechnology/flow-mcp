// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Create Google Flow scenes and append workflow clips via bound store state.

import { createScene } from "./angular";
import { delay } from "./dom";
import { runtimeState } from "./state";
import type { FlowTile, SceneOpRequest } from "./types";

/** Creates a scene or adds workflow clips to an existing scene. */
export async function sceneOp(req: SceneOpRequest): Promise<unknown> {
  const helper = runtimeState.store;
  const getMap = (): Map<string, FlowTile> | null | undefined => helper?.getTileMap?.();
  const tileMap = getMap();
  if (!(tileMap instanceof Map) || !helper?.mutate) {
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
    if (req?.name && helper?.rename) {
      await helper.rename(created.id, String(req.name));
      await delay(400);
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
    let resolveDe: (v: unknown) => void = () => {};
    let rejectDe: (e: unknown) => void = () => {};
    const dePromise = new Promise<unknown>((res, rej) => {
      resolveDe = res;
      rejectDe = rej;
    });
    await helper.mutate({
      type: "add_workflows_to_scene",
      Lc: sceneId,
      Ic: sceneId,
      rg: resolveWfIds(assetIds),
      YWa: resolveWfIds(assetIds),
      position: typeof req.position === "number" ? req.position : undefined,
      Mh: undefined,
      Eh: undefined,
      De: { resolve: resolveDe, reject: rejectDe },
      ve: { resolve: resolveDe, reject: rejectDe },
    });
    await dePromise;
    await delay(400);
    return { ok: true, scene_id: sceneId, added: assetIds.length };
  }

  return { ok: false, error: `unknown_scene_action:${action}` };
}
