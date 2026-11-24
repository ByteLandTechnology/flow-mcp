// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Create Google Flow scenes and append workflow clips via bound store state.

import { createScene } from "./angular";
import { delay } from "./dom";
import { runtimeState } from "./state";
import type { FlowTile, SceneOpRequest } from "./types";

/** Maximum time to wait for a scene clip addition callback to settle. */
const SCENE_ADD_CLIPS_TIMEOUT_MS = 10_000;

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
    const timeoutMs =
      typeof req?.timeout_ms === "number" && req.timeout_ms > 0
        ? Math.min(req.timeout_ms, SCENE_ADD_CLIPS_TIMEOUT_MS)
        : SCENE_ADD_CLIPS_TIMEOUT_MS;
    let resolveDe: (v: unknown) => void = () => {};
    let rejectDe: (e: unknown) => void = () => {};
    const dePromise = new Promise<unknown>((res, rej) => {
      resolveDe = res;
      rejectDe = rej;
    });
    void dePromise.catch(() => undefined);
    const workflows = resolveWfIds(assetIds);
    try {
      await helper.mutate({
        type: "add_workflows_to_scene",
        Lc: sceneId,
        Ic: sceneId,
        rg: workflows,
        YWa: workflows,
        position: typeof req.position === "number" ? req.position : undefined,
        Mh: undefined,
        Eh: undefined,
        De: { resolve: resolveDe, reject: rejectDe },
        ve: { resolve: resolveDe, reject: rejectDe },
      });
    } catch (error) {
      return {
        ok: false,
        error: "scene_add_clips_failed",
        scene_id: sceneId,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        dePromise.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({
            ok: false as const,
            error: "scene_add_clips_failed" as const,
            detail: error instanceof Error ? error.message : String(error),
          }),
        ),
        new Promise<{ ok: false; error: "scene_add_clips_timeout" }>((resolve) => {
          timer = setTimeout(
            () => resolve({ ok: false, error: "scene_add_clips_timeout" }),
            timeoutMs,
          );
        }),
      ]);
      if (!outcome.ok) {
        return { ...outcome, scene_id: sceneId };
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    await delay(400);
    return { ok: true, scene_id: sceneId, added: assetIds.length };
  }

  return { ok: false, error: `unknown_scene_action:${action}` };
}
