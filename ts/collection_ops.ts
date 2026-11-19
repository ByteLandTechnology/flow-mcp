// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Unified collection creation and tile assignment mutations via bound runtime state.

import { collectionIdOf, delay } from "./dom";
import { runtimeState } from "./state";
import type { FlowTile } from "./types";

/** Creates a collection or moves tile IDs between collections in the active project store. */
export async function collectionOps(
  action: string,
  arg1: string | null,
  arg2: string[] | null,
): Promise<unknown> {
  const helper = runtimeState.store;
  const getMap = (): Map<string, FlowTile> | null | undefined => helper?.getTileMap?.();

  if (action === "move") {
    const targetId = arg1;
    const assetIds = Array.isArray(arg2) ? arg2 : [];
    const tileMap = getMap();
    if (!(tileMap instanceof Map)) {
      return { ok: false, moved: 0, missing: assetIds, error: "store_not_bound" };
    }
    const objs: FlowTile[] = [];
    const missing: string[] = [];
    for (const id of assetIds) {
      const obj = tileMap.get(id);
      if (obj) objs.push(obj);
      else missing.push(id);
    }
    if (!objs.length) {
      return { ok: false, moved: 0, missing, error: "no_matching_assets" };
    }
    if (!helper?.mutate) {
      return { ok: false, moved: 0, missing: assetIds, error: "store_mutate_missing" };
    }
    // Each front-end build renames the keys. Target: `rj`/`Gj`, then `Nj` (2026-11-16), then `Sj` (2026-11-19).
    // Tiles: `Cb`/`Db`, then `Bb`. The front end ignores the keys that it does not know.
    await helper.mutate({
      type: "batch_move_to_collection",
      Sj: targetId || undefined,
      Bb: objs,
      Nj: targetId || undefined,
      rj: targetId || undefined,
      Gj: targetId || undefined,
      Cb: objs,
      Db: objs,
    });
    // The mutation resolves even when the front end ignores it. Read the store to see that each tile moved.
    const want = targetId || null;
    const isCollectionId = (v: string): boolean =>
      String(getMap()?.get(v)?.type || "").toUpperCase() === "COLLECTION";
    let verified = 0;
    for (let i = 0; i < 30; i++) {
      const m = getMap();
      verified = objs.filter((o) => {
        const cur = m instanceof Map ? m.get(String(o.id)) : null;
        return (collectionIdOf(cur, isCollectionId) || null) === want;
      }).length;
      if (verified === objs.length) break;
      await delay(100);
    }
    return {
      ok: true,
      moved: objs.length,
      verified,
      missing,
      method: "batch_move_to_collection",
    };
  }

  if (action !== "create") {
    throw new Error(`unknown_collection_action:${String(action)}`);
  }
  if (!helper?.mutate) {
    throw new Error("store_create_collection_missing");
  }

  const colName = String(arg1 ?? "");
  const beforeMap = getMap();
  const beforeIds = new Set<string>();
  if (beforeMap instanceof Map) {
    for (const [k, v] of beforeMap.entries()) {
      if (String(v?.type || "").toUpperCase() === "COLLECTION") {
        beforeIds.add(String(v?.id ?? k));
      }
    }
  }

  const fallbackUuid = (): string =>
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  const genId =
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID().toLowerCase()
      : fallbackUuid();
  const rawRes = await helper.mutate({
    type: "create_collection",
    id: genId,
    Fc: undefined,
    wc: undefined,
    displayName: colName,
  });
  const rawObj = rawRes as
    | { O2?: string | { id?: unknown }; M4?: string | { id?: unknown }; id?: unknown }
    | null
    | undefined;
  const created = rawObj?.M4 ?? rawObj?.O2;
  let createdId =
    typeof created === "string"
      ? created
      : created?.id
        ? String(created.id)
        : String(rawObj?.id || genId);

  let targetTile: FlowTile | null = null;
  for (let i = 0; i < 50; i++) {
    const m = getMap();
    if (m instanceof Map) {
      const t = createdId ? m.get(createdId) : null;
      if (t && !t.isPending) {
        targetTile = t;
        break;
      }
      for (const [k, v] of m.entries()) {
        if (String(v?.type || "").toUpperCase() === "COLLECTION" && !v?.isPending) {
          const cid = String(v?.id ?? k);
          if (!beforeIds.has(cid)) {
            createdId = cid;
            targetTile = v;
            break;
          }
        }
      }
      if (targetTile) break;
    }
    await delay(100);
  }

  if (!createdId) {
    throw new Error("created_collection_id_not_found");
  }

  if (!targetTile || targetTile.displayName !== colName) {
    if (helper?.rename) {
      await helper.rename(createdId, colName);
    } else {
      await helper.mutate({
        type: "single_tile",
        Xc: createdId,
        Uc: createdId,
        Ve: { type: "set_display_name", displayName: colName },
      });
    }
    for (let i = 0; i < 20; i++) {
      await delay(100);
      const t = getMap()?.get(createdId);
      if (t && !t.isPending && t.displayName === colName) break;
    }
  }
  return createdId;
}
