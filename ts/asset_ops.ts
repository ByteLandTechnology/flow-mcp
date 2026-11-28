// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Rename assets through the bound store.

import { activeProjectStoreFormat, readBuildLabel } from "./frontend_builds";
import { clearStore, runtimeState } from "./state";
import type { AssetRenameExtra } from "./types";

/** Renames one asset, character, or scene tile. */
export async function assetOps(
  action: string,
  id: string,
  extra: AssetRenameExtra | null,
): Promise<unknown> {
  if (action !== "rename") return { ok: false, err: "unknown_asset_action" };
  if (!activeProjectStoreFormat()) {
    return { ok: false, err: "unsupported_front_end", build: readBuildLabel() };
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

  const tile = tileMap.get(id);
  if (String(tile?.type || "").toUpperCase() === "COLLECTION") {
    return { ok: false, err: "collection_path_required" };
  }

  const newName = String(extra?.name ?? "");
  if (extra?.resetOld && tile) {
    try {
      tile.displayName = `__tmp_${Date.now()}`;
    } catch {
      // Ignore immutable tile objects.
    }
  }
  try {
    if (helper.rename) {
      await helper.rename(id, newName);
    } else if (helper.mutate) {
      await helper.mutate({
        type: "single_tile",
        Xc: id,
        Uc: id,
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
