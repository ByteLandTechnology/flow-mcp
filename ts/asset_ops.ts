// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Unified asset and collection rename and trash mutations via bound runtime state.

import { runtimeState } from "./state";
import type { AssetRenameExtra, FlowTile } from "./types";

/** Renames or moves an asset, character, scene, or collection tile to trash. */
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

  const mutate = (payload: Record<string, unknown>): Promise<unknown> =>
    helper.mutate(payload);
  const tile = tileMap.get(id);
  if (!tile) {
    let inSceneClip = false;
    for (const st of tileMap.values()) {
      if (!st || String(st.type || "").toUpperCase() !== "SCENE") continue;
      const inOc =
        Array.isArray(st.Oc) &&
        st.Oc.some((clip) => clip && String(clip.workflowId || "") === id);
      const inYf =
        st.Yf instanceof Map
          ? st.Yf.has(id)
          : Boolean(
              st.Yf &&
                typeof st.Yf === "object" &&
                Object.prototype.hasOwnProperty.call(st.Yf, id),
            );
      if (inOc || inYf) {
        inSceneClip = true;
        break;
      }
    }
    if (inSceneClip) {
      await mutate({ type: "batch_delete_tiles", rg: [id], fg: [id] });
      return { ok: true, method: "batch_delete_tiles:scene_clip" };
    }
    return { ok: false, error: "asset_not_found" };
  }

  const tileType = String(tile.type || "").toUpperCase();
  if (tileType === "COLLECTION") {
    const members: FlowTile[] = [];
    for (const t of tileMap.values()) {
      if (t && String(t.Fc || "") === id) {
        members.push(t);
      }
    }
    await mutate({
      type: "batch_move_and_delete_collection",
      Cb: members,
      Db: members,
      rj: undefined,
      rWa: id,
    });
    return { ok: true, method: "batch_move_and_delete_collection" };
  }

  // The 2026-11-15 front end trashes tiles in a batch with `Bv` entries.
  try {
    await mutate({
      type: "batch_set_tiles_trashed",
      jc: new Date(),
      Bv: [{ Oa: tile, Ab: true, um: { mode: "root" } }],
    });
    return { ok: true, method: "batch_set_tiles_trashed:Bv" };
  } catch {
    // Use the older mutation shapes below.
  }
  try {
    await mutate({
      type: "single_tile",
      Xc: String(tile.id ?? id),
      Uc: String(tile.id ?? id),
      Ve: {
        type: "set_trashed",
        yb: true,
        jc: new Date(),
        fm: new Date(),
      },
    });
    return { ok: true, method: "single_tile:set_trashed" };
  } catch {
    await mutate({
      type: "batch_set_tiles_trashed",
      jc: new Date(),
      uu: [{ Oa: tile, yb: true }],
      nv: [{ Na: tile, yb: true }],
    });
    return { ok: true, method: "batch_set_tiles_trashed" };
  }
}
