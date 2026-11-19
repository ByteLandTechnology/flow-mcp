// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read and change collections in the active project without page controls.

import {
  collectionStore,
  readCollectionStore,
  refreshCollectionStore,
  submitCollectionMutation,
} from "./collection_store";
import type { CollectionStore } from "./collection_store";
import { delay, isTrashedTile } from "./dom";
import { collectionWriteCompatibility, readBuildLabel } from "./frontend_compatibility";
import type { CollectionWriteFormat } from "./frontend_compatibility";
import { readStoreTiles } from "./read_store_snapshot";
import type { FlowTile, SnapshotCollectionItem } from "./types";

/** Operation and arguments from the collection tool. */
export type CollectionRequest =
  | { action: "list" | "assets" }
  | { action: "inspect"; id: string }
  | { action: "check_assets"; ids: string[] }
  | { action: "create"; id: string; name: string }
  | { action: "rename"; id: string; name: string }
  | { action: "move"; target: string | null; ids: string[] }
  | { action: "delete"; id: string };

/** Project and request format for a verified collection write. */
interface CollectionWriter {
  /** Store bound to the active project. */
  store: CollectionStore;
  /** Format for the active build. */
  format: CollectionWriteFormat;
}

/** Time limit for one submission and its confirmation. */
const MUTATION_TIMEOUT_MS = 10_000;
/** True until the previous collection submission settles. */
let mutationPending = false;
/** Projects that need a new query result after a mutation. */
const projectsToRefresh = new Set<string>();

/** Returns a tile that is present, ready, and out of the trash. */
function available(tile: FlowTile | undefined): tile is FlowTile {
  return Boolean(tile && !tile.isPending && !isTrashedTile(tile));
}

/** Returns the tile when a collection operation can move it. */
function movable(tile: FlowTile | undefined): tile is FlowTile {
  if (!available(tile)) return false;
  switch (tile.type) {
    case "IMAGE":
    case "VIDEO":
      return Boolean(tile.workflowId);
    case "SCENE":
    case "CHARACTER":
    case "TEXT_TILE":
      return true;
    default:
      return false;
  }
}

/** Lists the active collections and counts the asset tiles in each collection. */
function summarize(tiles: Map<string, FlowTile>): SnapshotCollectionItem[] {
  const collections = new Map<string, SnapshotCollectionItem>();
  for (const [id, tile] of tiles) {
    if (available(tile) && tile.type === "COLLECTION") {
      collections.set(id, { id, name: tile.displayName ?? "", count: 0 });
    }
  }
  for (const tile of tiles.values()) {
    if (isTrashedTile(tile) || tile.type === "COLLECTION" ||
        (tile.type === "SCENE" && tile.isPending) || tile.Cc === undefined) continue;
    const parent = collections.get(tile.Cc);
    if (parent) parent.count++;
  }
  return [...collections.values()];
}

/** Sends one mutation and confirms it from a new server result. */
async function mutateAndVerify(
  store: CollectionStore,
  payload: Record<string, unknown>,
  verified: (tiles: Map<string, FlowTile>) => boolean,
): Promise<Map<string, FlowTile> | null> {
  mutationPending = true;
  projectsToRefresh.add(store.projectId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, MUTATION_TIMEOUT_MS);
  });
  const work = (async () => {
    try {
      await submitCollectionMutation(store, payload);
      for (let attempt = 0; attempt < 3 && !timedOut; attempt++) {
        const tiles = await refreshCollectionStore(store);
        if (!tiles || timedOut) return null;
        if (verified(tiles)) {
          projectsToRefresh.delete(store.projectId);
          return tiles;
        }
        await delay(250);
      }
      return null;
    } catch {
      return null;
    } finally {
      mutationPending = false;
    }
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Refreshes the project before the next operation after an unknown result. */
async function refreshAfterUnknown(store: CollectionStore): Promise<Map<string, FlowTile> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), MUTATION_TIMEOUT_MS);
  });
  try {
    const tiles = await Promise.race([refreshCollectionStore(store), timeout]);
    if (tiles) projectsToRefresh.delete(store.projectId);
    return tiles;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Reports a submission whose result the store did not confirm. */
function outcomeUnknown(
  store: CollectionStore,
  stage: string,
  ids: string[],
  collectionId?: string | null,
): unknown {
  return {
    ok: false, error: "outcome_unknown", project_id: store.projectId,
    stage, ids, collection_id: collectionId,
  };
}

/** Renames a collection by exact ID and confirms its name. */
async function rename(
  { store, format }: CollectionWriter,
  id: string,
  name: string,
): Promise<Map<string, FlowTile> | null> {
  if (!readCollectionStore(store)) return null;
  return mutateAndVerify(
    store,
    {
      type: "single_tile",
      [format.tileId]: id,
      [format.tileChange]: { type: "set_display_name", displayName: name },
    },
    (tiles) => {
      const tile = tiles.get(id);
      return available(tile) && tile.type === "COLLECTION" && tile.displayName === name;
    },
  );
}

/** Creates a collection with the request ID and sets its display name. */
async function create(writer: CollectionWriter, id: string, name: string): Promise<unknown> {
  // This build sets the server-side name to "Untitled collection" on creation.
  const created = await mutateAndVerify(writer.store, { type: "create_collection", id }, (tiles) => {
    const tile = tiles.get(id);
    return available(tile) && tile.type === "COLLECTION" && !tile.Cc;
  });
  if (!created) return outcomeUnknown(writer.store, "create_collection", [id]);

  const named = created.get(id)?.displayName === name ? created : await rename(writer, id, name);
  if (!named) return outcomeUnknown(writer.store, "name_created_collection", [id]);
  return { ok: true, created: true, id, method: "mutation", collections: summarize(named) };
}

/** Moves the requested tiles and confirms that each one is present in the target. */
async function move(
  { store, format }: CollectionWriter,
  tiles: Map<string, FlowTile>,
  ids: string[],
  target: string | null,
): Promise<unknown> {
  const destination = target === null ? undefined : tiles.get(target);
  if (target !== null && (!available(destination) || destination.type !== "COLLECTION")) {
    return { ok: false, error: "collection_not_found" };
  }
  const found: FlowTile[] = [];
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const tile = tiles.get(id);
    if (movable(tile)) found.push(tile);
    else missing.push(id);
  }
  if (!found.length) return { ok: false, error: "no_matching_assets", missing };

  const moving = found.filter((tile) => (tile.Cc || null) !== target);
  const after = moving.length === 0 ? tiles : await mutateAndVerify(
    store,
    { type: "batch_move_to_collection", [format.moveTarget]: target ?? undefined, [format.moveTiles]: moving },
    (fresh) => {
      if (target !== null) {
        const collection = fresh.get(target);
        if (!available(collection) || collection.type !== "COLLECTION") return false;
      }
      return found.every((asset) => {
        const tile = typeof asset.id === "string" ? fresh.get(asset.id) : undefined;
        return available(tile) && tile.type === asset.type && (tile.Cc || null) === target;
      });
    },
  );
  if (!after) {
    return outcomeUnknown(store, "batch_move_to_collection", found.map((tile) => String(tile.id)), target);
  }
  const collection = target === null ? undefined : summarize(after).find((item) => item.id === target);
  return {
    ok: true,
    ...(target === null ? { removed: found.length } : { moved: found.length, collection }),
    missing,
    confirmed: true,
    method: "batch_move_to_collection",
  };
}

/** Runs a read or a verified mutation for the pinned project and document. */
export async function collectionOps(
  projectId: string,
  session: string,
  request: CollectionRequest,
): Promise<unknown> {
  const store = collectionStore(projectId, session);
  let tiles = store && readCollectionStore(store);
  if (!store || !tiles) return { ok: false, error: "collection_project_changed" };
  if (projectsToRefresh.has(projectId) && request.action !== "delete") {
    if (mutationPending) return { ok: false, error: "collection_mutation_pending" };
    tiles = await refreshAfterUnknown(store);
    if (!tiles) return { ok: false, error: "collection_refresh_failed", project_id: projectId };
  }
  switch (request.action) {
    case "list":
      return { ok: true, collections: summarize(tiles) };
    case "assets":
      return { ok: true, assets: readStoreTiles(tiles).assets, collections: summarize(tiles) };
    case "inspect":
      return { ok: true, collection: tiles.get(request.id)?.type === "COLLECTION" };
    case "check_assets":
      return request.ids.some((id) => movable(tiles.get(id)))
        ? { ok: true }
        : { ok: false, error: "no_matching_assets", missing: request.ids };
    case "delete":
      // The known dispatcher moves members and deletes the collection in separate requests.
      return { ok: false, error: "collection_delete_unavailable", id: request.id, build: readBuildLabel() };
  }
  const support = collectionWriteCompatibility();
  if (!support.ok) return support;
  if (mutationPending) return { ok: false, error: "collection_mutation_pending" };
  const writer = { store, format: support.format };

  switch (request.action) {
    case "create":
      return create(writer, request.id, request.name);
    case "rename": {
      const tile = tiles.get(request.id);
      if (!available(tile) || tile.type !== "COLLECTION") {
        return { ok: false, error: "collection_not_found", id: request.id };
      }
      const after = tile.displayName === request.name ? tiles : await rename(writer, request.id, request.name);
      return after
        ? { ok: true, method: "mutation", collections: summarize(after) }
        : outcomeUnknown(store, "rename_collection", [request.id]);
    }
    case "move":
      return move(writer, tiles, request.ids, request.target);
  }
}
