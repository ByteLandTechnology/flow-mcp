// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Create Google Flow scenes and append workflow clips via bound store state.

import { createScene } from "./angular";
import { delay } from "./dom";
import { sceneContents } from "./scene_tiles";
import { clearStore, runtimeState } from "./state";
import type { FlowTile, SceneOpRequest } from "./types";

/** Maximum wait in milliseconds for confirmation of clip additions to a scene. */
const SCENE_ADD_CLIPS_TIMEOUT_MS = 10_000;

/** Creates a scene or adds workflow clips to an existing scene. */
export async function sceneOp(req: SceneOpRequest): Promise<unknown> {
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
    const mutate = helper.mutate;
    const workflowIds = resolveWfIds(assetIds);
    const initialScene = tileMap.get(sceneId);
    const beforeClips = initialScene ? sceneContents(initialScene).clips.length : null;
    let mutateSettled = false;
    let callbackSettled = false;
    let failure: string | undefined;
    let notifyWake: (() => void) | undefined;
    const wake = (): void => {
      const fn = notifyWake;
      notifyWake = undefined;
      fn?.();
    };
    const recordFailure = (err: unknown, fallback: string): void => {
      failure ??= err instanceof Error ? err.message : String(err ?? fallback);
      wake();
    };
    const completion = {
      resolve: () => {
        callbackSettled = true;
        wake();
      },
      reject: (err: unknown) => recordFailure(err, "add_workflows_failed"),
    };
    void Promise.resolve()
      .then(() =>
        mutate.call(helper, {
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
        }),
      )
      .then(
        () => {
          mutateSettled = true;
          wake();
        },
        (err) => recordFailure(err, "add_workflows_failed"),
      );

    const deadline = performance.now() + SCENE_ADD_CLIPS_TIMEOUT_MS;
    while (performance.now() < deadline) {
      if (failure) return { ok: false, error: failure };
      const latestScene = getMap()?.get(sceneId);
      const clipsConfirmed =
        beforeClips !== null &&
        latestScene !== undefined &&
        sceneContents(latestScene).clips.length >= beforeClips + workflowIds.length;
      if (mutateSettled && (callbackSettled || clipsConfirmed)) {
        await delay(400);
        return { ok: true, scene_id: sceneId, added: assetIds.length };
      }
      const remaining = Math.max(1, Math.min(200, deadline - performance.now()));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (notifyWake === onSignal) notifyWake = undefined;
          resolve();
        }, remaining);
        const onSignal = (): void => {
          clearTimeout(timer);
          resolve();
        };
        notifyWake = onSignal;
      });
    }
    if (failure) return { ok: false, error: failure };
    return { ok: false, error: "scene_add_clips_timeout" };
  }

  return { ok: false, error: `unknown_scene_action:${action}` };
}
