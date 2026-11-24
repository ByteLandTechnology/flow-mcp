// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read and change collections in the active project without page controls.

import { collectionIdOf, isTrashedTile } from "./dom";
import { readBuildLabel } from "./frontend_builds";
import type { CollectionWriteFormat } from "./frontend_builds";
import { collectionWriteCompatibility } from "./frontend_compatibility";
import {
  mutateAndVerify,
  projectMutationPending,
  projectsToRefresh,
  projectStore,
  readProjectStore,
  refreshAfterUnknown,
} from "./project_store";
import type { ProjectStore } from "./project_store";
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
  store: ProjectStore;
  /** Format for the active build. */
  format: CollectionWriteFormat;
}

/** Returns a tile that is present, ready, and out of the trash. */
function available(tile: FlowTile | undefined): tile is FlowTile {
  return Boolean(tile && !tile.isPending && !isTrashedTile(tile));
}

/** Returns true when the tile has the fields that a move request needs. */
function supportsMove(tile: FlowTile): boolean {
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

/** Returns the available tile when a collection operation can move it. */
function movable(tile: FlowTile | undefined): tile is FlowTile {
  return available(tile) && supportsMove(tile);
}

/** Reads the parent collection ID of `tile` by known fields or live collection ID reference. */
function tileParentId(tile: FlowTile, tiles: Map<string, FlowTile>): string | null {
  return collectionIdOf(tile, (cid) => tiles.get(cid)?.type === "COLLECTION");
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
        (tile.type === "SCENE" && tile.isPending)) continue;
    const id = tileParentId(tile, tiles);
    const parent = id === null ? undefined : collections.get(id);
    if (parent) parent.count++;
  }
  return [...collections.values()];
}

/** Reports a submission whose result the store did not confirm. */
function outcomeUnknown(
  store: ProjectStore,
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
  if (!readProjectStore(store)) return null;
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
    return available(tile) && tile.type === "COLLECTION" && tileParentId(tile, tiles) === null;
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

  const moving = found.filter((tile) => tileParentId(tile, tiles) !== target);
  const after = moving.length === 0 ? tiles : await mutateAndVerify(
    store,
    moveRequest(format, target, moving),
    (fresh) => {
      if (target !== null) {
        const collection = fresh.get(target);
        if (!available(collection) || collection.type !== "COLLECTION") return false;
      }
      return found.every((asset) => {
        const tile = typeof asset.id === "string" ? fresh.get(asset.id) : undefined;
        return available(tile) && tile.type === asset.type && tileParentId(tile, fresh) === target;
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

/** Builds a native request to move project tiles to a collection or the root. */
function moveRequest(format: CollectionWriteFormat, target: string | null, tiles: FlowTile[]) {
  return { type: "batch_move_to_collection", [format.moveTarget]: target ?? undefined, [format.moveTiles]: tiles };
}

/** Returns each direct member of a collection. */
function collectionMembers(tiles: Map<string, FlowTile>, id: string) {
  return [...tiles.values()].filter((tile) => tileParentId(tile, tiles) === id);
}

/** Moves the members and confirms an empty collection before it sends the deletion. */
async function deleteCollection({ store, format }: CollectionWriter, id: string) {
  const deleteField = format.deleteCollections;
  if (!deleteField) return { ok: false, error: "collection_delete_unavailable", id, build: readBuildLabel() };

  const tiles = await refreshAfterUnknown(store);
  if (!tiles) return { ok: false, error: "collection_refresh_failed", project_id: store.projectId };
  const collection = tiles.get(id);
  if (!available(collection) || collection.type !== "COLLECTION") {
    return { ok: false, error: "collection_not_found", id };
  }
  const parent = tileParentId(collection, tiles);
  if (parent !== null && (parent === id || !available(tiles.get(parent)) || tiles.get(parent)?.type !== "COLLECTION")) {
    return { ok: false, error: "collection_parent_unavailable", id };
  }
  const members = collectionMembers(tiles, id);
  if (members.some((tile) => tile.isPending || (tile.type !== "COLLECTION" && !supportsMove(tile)))) {
    return { ok: false, error: "collection_members_unavailable", id };
  }
  const ids = members.map((tile) => String(tile.id));
  const moved = members.length ? await mutateAndVerify(store, moveRequest(format, parent, members), (fresh) =>
    ids.every((memberId) => {
      const member = fresh.get(memberId);
      return member !== undefined && tileParentId(member, fresh) === parent;
    })) : tiles;
  if (!moved) return outcomeUnknown(store, "move_collection_members", ids, parent);
  if (collectionMembers(moved, id).length) {
    return { ok: false, error: "collection_not_empty", id, moved_ids: ids };
  }
  const after = await mutateAndVerify(store, { type: "batch_delete_tiles", [deleteField]: [id] },
    (fresh) => !fresh.has(id) && collectionMembers(fresh, id).length === 0);
  if (!after) return outcomeUnknown(store, "delete_collection", [id]);
  return { ok: true, deleted: true, id, moved_ids: ids, method: "mutation", collections: summarize(after) };
}

/** Runs a read or a verified mutation for the pinned project and document. */
export async function collectionOps(
  projectId: string,
  session: string,
  request: CollectionRequest,
): Promise<unknown> {
  const store = projectStore(projectId, session);
  let tiles = store && readProjectStore(store);
  if (!store || !tiles) return { ok: false, error: "collection_project_changed" };
  if (projectsToRefresh.has(projectId) && request.action !== "delete") {
    if (projectMutationPending) return { ok: false, error: "collection_mutation_pending" };
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
  }
  const support = collectionWriteCompatibility();
  if (!support.ok) return support;
  if (projectMutationPending) return { ok: false, error: "collection_mutation_pending" };
  const writer = { store, format: support.format };

  switch (request.action) {
    case "delete":
      return deleteCollection(writer, request.id);
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
