// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Create Google Flow scenes and append workflow clips via bound store state.

import { createScene } from "./angular";
import { delay } from "./dom";
import { inferAddClipsShape, inferSingleTileShape } from "./mutation_shapes";
import { sceneContents } from "./scene_tiles";
import { runtimeState } from "./state";
import type { FlowTile, SceneOpRequest } from "./types";

/** Maximum wait for `add_workflows_to_scene` callback or store clip confirmation. */
const SCENE_ADD_CLIPS_TIMEOUT_MS = 15_000;
/** Maximum wait for optional post-create scene rename. */
const SCENE_RENAME_TIMEOUT_MS = 10_000;

/** Runs an async promise under a bounded timeout and clears its timer on settle. */
async function withBoundedTimeout<T>(work: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
    const assetIds = Array.isArray(req?.asset_ids) ? req.asset_ids.map(String) : [];
    const created = await createScene(helper, getMap, resolveWfIds(assetIds));
    if (!created?.ok || !created.id) {
      return created || { ok: false, error: "created_scene_id_not_found" };
    }
    if (req?.name && helper?.rename) {
      const singleCheck = inferSingleTileShape();
      if (singleCheck.ok) {
        await withBoundedTimeout(
          helper.rename(created.id, String(req.name)),
          SCENE_RENAME_TIMEOUT_MS,
          "scene_rename_timeout",
        );
        await delay(300);
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
    const assetIds = Array.isArray(req?.asset_ids) ? req.asset_ids.map(String) : [];
    if (!sceneId || !assetIds.length) {
      return { ok: false, error: "scene_id_and_asset_ids_required" };
    }
    const shape = inferAddClipsShape();
    if (!shape.ok) {
      return { ok: false, error: `${shape.reason}:${shape.check.name}:${shape.check.detail}` };
    }

    const wfIds = resolveWfIds(assetIds);
    const initialTile = getMap()?.get(sceneId);
    const beforeCount = initialTile ? sceneContents(initialTile).clips.length : 0;

    let callbackDone = false;
    let mutateSettled = false;
    let failure: string | undefined;
    const completion = {
      resolve: () => {
        callbackDone = true;
      },
      reject: (error: unknown) => {
        failure ??= error instanceof Error ? error.message : String(error ?? "add_clips_failed");
      },
    };

    const deadline = performance.now() + SCENE_ADD_CLIPS_TIMEOUT_MS;
    void Promise.resolve()
      .then(() =>
        helper.mutate({
          type: "add_workflows_to_scene",
          sceneId,
          workflows: wfIds,
          position: typeof req.position === "number" ? req.position : undefined,
          completion,
        }),
      )
      .then(() => {
        mutateSettled = true;
      }, completion.reject);

    while (performance.now() < deadline) {
      if (failure) return { ok: false, error: failure };
      const currentScene = getMap()?.get(sceneId);
      const nowClips = currentScene ? sceneContents(currentScene).clips.length : 0;
      if (
        callbackDone ||
        nowClips >= beforeCount + wfIds.length ||
        (!shape.format.completion && mutateSettled && nowClips > beforeCount)
      ) {
        await delay(200);
        return { ok: true, scene_id: sceneId, added: assetIds.length };
      }
      await delay(150);
    }
    return { ok: false, error: "scene_add_clips_timeout" };
  }

  return { ok: false, error: `unknown_scene_action:${action}` };
}
