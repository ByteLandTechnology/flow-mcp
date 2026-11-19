// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Unified asset and collection rename and trash mutations via bound runtime state.

import { collectionIdOf } from "./dom";
import { destructiveGate, readBuildLabel } from "./probe";
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

  const gate = destructiveGate();
  if (gate) return gate;

  const mutate = (payload: Record<string, unknown>): Promise<unknown> =>
    helper.mutate(payload);
  /** Tries each mutation shape in order and reports every rejection when all fail. */
  const tryShapes = async (
    shapes: { method: string; payload: Record<string, unknown> }[],
  ): Promise<unknown> => {
    const attempts: { method: string; error: string }[] = [];
    for (const shape of shapes) {
      try {
        await mutate(shape.payload);
        return { ok: true, method: shape.method };
      } catch (e) {
        attempts.push({
          method: shape.method,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return {
      ok: false,
      error: "mutation_rejected_all_shapes",
      build: readBuildLabel(),
      attempts,
    };
  };
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
      return tryShapes([
        {
          method: "batch_delete_tiles:scene_clip",
          payload: { type: "batch_delete_tiles", rg: [id], fg: [id] },
        },
      ]);
    }
    return { ok: false, error: "asset_not_found" };
  }

  const tileType = String(tile.type || "").toUpperCase();
  if (tileType === "COLLECTION") {
    const members: FlowTile[] = [];
    for (const t of tileMap.values()) {
      if (t && collectionIdOf(t, (v) => v === id) === id) {
        members.push(t);
      }
    }
    return tryShapes([
      {
        method: "batch_move_and_delete_collection",
        payload: {
          type: "batch_move_and_delete_collection",
          Cb: members,
          Db: members,
          rj: undefined,
          rWa: id,
        },
      },
    ]);
  }

  const tileId = String(tile.id ?? id);
  return tryShapes([
    {
      // The 2026-11-15 front end trashes tiles in a batch with `Bv` entries. The 2026-11-19 front end uses `Kv` entries.
      method: "batch_set_tiles_trashed:Bv",
      payload: {
        type: "batch_set_tiles_trashed",
        jc: new Date(),
        Bv: [{ Oa: tile, Ab: true, um: { mode: "root" } }],
        Kv: [{ Oa: tile, Ab: true, Dm: { mode: "root" } }],
      },
    },
    {
      method: "single_tile:set_trashed",
      payload: {
        type: "single_tile",
        Xc: tileId,
        Uc: tileId,
        Ve: { type: "set_trashed", yb: true, jc: new Date(), fm: new Date() },
      },
    },
    {
      method: "batch_set_tiles_trashed",
      payload: {
        type: "batch_set_tiles_trashed",
        jc: new Date(),
        uu: [{ Oa: tile, yb: true }],
        nv: [{ Na: tile, yb: true }],
      },
    },
  ]);
}
