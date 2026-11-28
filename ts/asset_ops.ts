// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Rename assets through the bound store.

import { isTrashedTile } from "./dom";
import { activeProjectStoreFormat } from "./frontend_builds";
import { findVideoTileByIdOrWorkflow, sceneContents, splitSceneClipId } from "./scene_tiles";
import { clearStore, runtimeState } from "./state";
import type { AssetRenameExtra, FlowTile } from "./types";

/** Renames one asset, character, or scene tile. */
export async function assetOps(
  action: string,
  id: string,
  extra: AssetRenameExtra | null,
): Promise<unknown> {
  if (action !== "rename") return { ok: false, err: "unknown_asset_action" };
  if (!activeProjectStoreFormat()) {
    clearStore();
    return { ok: false, err: "unsupported_front_end" };
  }
  const helper = runtimeState.store;
  if (!helper || !helper.isCurrent()) {
    if (helper) clearStore();
    return { ok: false, err: "store_not_bound" };
  }
  if (!helper.isReady()) {
    return { ok: false, err: "store_loading" };
  }
  const tileMap = helper.getTileMap();
  if (!(tileMap instanceof Map)) {
    return { ok: false, err: "store_not_bound" };
  }

  let targetId = id;
  let tile: FlowTile | undefined;
  const clipRef = splitSceneClipId(id);
  if (clipRef) {
    const sceneTile = tileMap.get(clipRef.sceneId);
    if (
      !sceneTile ||
      isTrashedTile(sceneTile) ||
      String(sceneTile.type ?? "").toUpperCase() !== "SCENE" ||
      !sceneContents(sceneTile).clips.some(
        (clip) => String(clip?.workflowId ?? "") === clipRef.workflowId,
      )
    ) {
      return { ok: false, err: "asset_not_found" };
    }
    tile = findVideoTileByIdOrWorkflow(tileMap, clipRef.workflowId);
    if (!tile) {
      return { ok: false, err: "scene_clip_has_no_tile_to_rename" };
    }
    targetId = String(tile.id ?? clipRef.workflowId);
  } else {
    tile = tileMap.get(id);
    if (!tile || isTrashedTile(tile)) {
      return { ok: false, err: "asset_not_found" };
    }
  }
  if (String(tile.type || "").toUpperCase() === "COLLECTION") {
    return { ok: false, err: "collection_path_required" };
  }

  const newName = String(extra?.name ?? "");
  if (extra?.resetOld) {
    try {
      tile.displayName = `__tmp_${Date.now()}`;
    } catch {
      // Ignore immutable tile objects.
    }
  }
  try {
    if (helper.rename) {
      await helper.rename(targetId, newName);
    } else if (helper.mutate) {
      await helper.mutate({
        type: "single_tile",
        Xc: targetId,
        Uc: targetId,
        Ve: { type: "set_display_name", displayName: newName },
      });
    } else {
      return { ok: false, err: "rename_method_missing" };
    }
  } catch (err) {
    return {
      ok: false,
      err: err instanceof Error ? err.message : String(err ?? "rename_failed"),
    };
  }
  return { ok: true };
}
