// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Asset rename and trash mutations through the bound store.

import { readOwn } from "./angular";
import { assetTrashCompatibility, readBuildLabel } from "./frontend_compatibility";
import { runtimeState } from "./state";
import type { AssetTrashFormat } from "./frontend_compatibility";
import type { AssetRenameExtra, FlowTile } from "./types";

/** Returns true when a scene tile contains the given workflow. */
function isSceneClip(tiles: Iterable<FlowTile>, id: string, format: AssetTrashFormat): boolean {
  for (const scene of tiles) {
    if (String(scene?.type ?? "").toUpperCase() !== "SCENE") continue;
    const clips = readOwn(scene, format.sceneClips) ?? scene.Oc;
    if (Array.isArray(clips) && clips.some((clip) => String(readOwn(clip, "workflowId") ?? "") === id)) {
      return true;
    }
    const history = readOwn(scene, format.sceneHistory) ?? scene.Yf;
    if (history instanceof Map ? history.has(id) :
        history && Object.prototype.hasOwnProperty.call(history, id)) {
      return true;
    }
  }
  return false;
}

/** Renames or moves an asset, character, or scene tile to trash. */
export async function assetOps(
  action: string,
  id: string,
  extra: AssetRenameExtra | null,
): Promise<unknown> {
  const helper = runtimeState.store;
  const tileMap = helper?.getTileMap?.();
  if (!(tileMap instanceof Map)) {
    return action === "rename"
      ? { ok: false, err: "store_not_bound" }
      : { ok: false, error: "store_not_bound" };
  }

  const tile = tileMap.get(id);
  if (String(tile?.type || "").toUpperCase() === "COLLECTION") {
    return action === "rename"
      ? { ok: false, err: "collection_path_required" }
      : { ok: false, error: "collection_path_required" };
  }

  if (action === "rename") {
    const newName = String(extra?.name ?? "");
    const resetOld = Boolean(extra?.resetOld);
    if (resetOld) {
      try {
        const direct = tileMap.get(id);
        if (direct && typeof direct === "object") {
          direct.displayName = `__tmp_${Date.now()}`;
        }
      } catch {
        // Ignore immutable tile objects.
      }
    }
    if (helper?.rename) {
      await helper.rename(id, newName);
    } else if (helper?.mutate) {
      await helper.mutate({
        type: "single_tile",
        Xc: id,
        Uc: id,
        Ve: { type: "set_display_name", displayName: newName },
      });
    } else {
      return { ok: false, err: "rename_method_missing" };
    }
    return { ok: true };
  }

  if (action !== "trash") {
    return { ok: false, error: `unknown_asset_action:${String(action)}` };
  }
  if (!helper?.mutate) {
    return { ok: false, error: "store_mutate_missing" };
  }

  const support = assetTrashCompatibility(tileMap);
  if (!support.ok) return support;
  const { format } = support;

  let method: string;
  let payload: Record<string, unknown>;
  if (tile) {
    method = `batch_set_tiles_trashed:${format.entries}`;
    payload = {
      type: "batch_set_tiles_trashed",
      jc: new Date(),
      [format.entries]: [{ Oa: tile, Ab: true, [format.destination]: { mode: "root" } }],
    };
  } else {
    if (!isSceneClip(tileMap.values(), id, format)) {
      return { ok: false, error: "asset_not_found" };
    }
    method = "batch_delete_tiles:scene_clip";
    payload = { type: "batch_delete_tiles", [format.sceneWorkflows]: [id] };
  }

  try {
    await helper.mutate(payload);
    return { ok: true, method };
  } catch (error) {
    return {
      ok: false,
      error: "mutation_rejected",
      build: readBuildLabel(),
      attempts: [{ method, error: error instanceof Error ? error.message : String(error) }],
    };
  }
}
