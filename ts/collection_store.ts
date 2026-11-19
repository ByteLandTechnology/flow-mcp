// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Bind and read the collection store through JavaScript objects.

import { isNgLViewMap, readOwn } from "./angular";
import type { FlowTile, StoreProbeCheck } from "./types";

/** Project tile rows in the Flow query cache. */
interface ProjectTileData {
  /** Tile rows from the project tile query. */
  Bb?: FlowTile[];
}

/** A Flow query for the tiles of one project. */
interface ProjectTileQuery {
  /** Key that includes the project ID. */
  queryKey: unknown;
  /** Most recent query status and result. */
  state: { status: string; data: unknown };
  /** Runs the query and returns the fetched result. */
  fetch: (options: undefined, settings: { cancelRefetch: boolean }) => Promise<unknown>;
}

/** The project-scoped state service in the Angular project shell. */
interface ProjectStore {
  /** Angular lifecycle controller. */
  Ca: { Wa: boolean };
  /** Signal that returns the active project ID. */
  va: () => string | undefined;
  /** Service that reads and changes project tiles. */
  na: {
    /** Builds the tile query key for a project. */
    queryKey: (projectId: string) => unknown;
    /** Sends a mutation for the given project. */
    VI: (projectId: string, payload: Record<string, unknown>) => Promise<unknown>;
    /** Client that owns the project tile query. */
    Xa: {
      /** Cache that holds queries by key. */
      queryCache: {
        /** Finds a query with the given key. */
        find: (filter: { queryKey: unknown; exact: boolean }) => ProjectTileQuery | undefined;
      };
    };
  };
}

/** A collection binding for one project in the current document. */
export interface CollectionStore {
  /** Project ID at the time of binding. */
  readonly projectId: string;
  /** Active Angular project store. */
  readonly service: ProjectStore;
}

/** Identifier of this runtime instance. Assign it when the collection path first uses this document. */
let session: string | null = null;
/** Store selected by the collection binder. */
let boundStore: CollectionStore | null = null;

/** Returns the project ID in the current route. */
function projectInRoute(): string | null {
  return /\/project\/([^/?#]+)/.exec(location.pathname)?.[1] ?? null;
}

/** Checks the active route and the project that owns the store. */
function isCurrent(store: CollectionStore): boolean {
  return projectInRoute() === store.projectId &&
    !store.service.Ca.Wa &&
    store.service.va() === store.projectId;
}

/** Finds the query by its full project key. */
function projectQuery(store: CollectionStore): ProjectTileQuery | undefined {
  const key = store.service.na.queryKey(store.projectId);
  if (!isProjectKey(key, store.projectId)) return undefined;
  const query = store.service.na.Xa.queryCache.find({ queryKey: key, exact: true });
  return isProjectKey(query?.queryKey, store.projectId) ? query : undefined;
}

/** Checks the project tile query key for an exact match. */
function isProjectKey(key: unknown, projectId: string): boolean {
  return Array.isArray(key) && key.length === 2 && key[0] === "PROJECT_TILES" && key[1] === projectId;
}

/** Indexes a complete result by tile ID. */
function tileMap(data: unknown): Map<string, FlowTile> | null {
  const rows = (data as ProjectTileData | null)?.Bb;
  if (!Array.isArray(rows)) return null;
  const tiles = new Map<string, FlowTile>();
  for (const tile of rows) {
    if (typeof tile?.id !== "string" || !tile.id || typeof tile.type !== "string" ||
        tiles.has(tile.id)) {
      return null;
    }
    tiles.set(tile.id, tile);
  }
  return tiles;
}

/** Reads the cached rows for the active project. */
export function readCollectionStore(store: CollectionStore): Map<string, FlowTile> | null {
  if (!isCurrent(store)) return null;
  const query = projectQuery(store);
  return query && query.state.status !== "pending" ? tileMap(query.state.data) : null;
}

/** Returns the bound store only when the project and runtime session match. */
export function collectionStore(projectId: string, expectedSession: string): CollectionStore | null {
  return boundStore?.projectId === projectId && session === expectedSession ? boundStore : null;
}

/** Reports whether the current runtime has a ready collection store for this project. */
export function collectionStoreStatus(projectId: string): { ok: boolean; error?: string; session?: string } {
  if (projectInRoute() !== projectId) return { ok: false, error: "project_changed" };
  if (boundStore?.projectId !== projectId || !readCollectionStore(boundStore)) {
    return { ok: false, error: "collection_store_not_bound" };
  }
  session ??= crypto.randomUUID();
  return { ok: true, session };
}

/** Binds one ready store found in the Angular view registry. */
export function bindCollectionStore(maps: unknown[], projectId: string): ReturnType<typeof collectionStoreStatus> {
  if (projectInRoute() !== projectId) return { ok: false, error: "project_changed" };
  const frontEnd = readOwn(window, "default_AiSandboxAngularFrontend");
  const storeClass = readOwn(frontEnd, "VN");
  if (typeof storeClass !== "function") {
    return { ok: false, error: "collection_store_not_bound" };
  }

  const seen = new Set<ProjectStore>();
  const candidates: CollectionStore[] = [];
  const consider = (value: unknown): void => {
    if (!(value instanceof storeClass)) return;
    const service = value as ProjectStore;
    if (seen.has(service)) return;
    seen.add(service);
    if (!service.Ca || typeof service.va !== "function" ||
        typeof service.na?.queryKey !== "function" ||
        typeof service.na.Xa?.queryCache?.find !== "function") return;
    const candidate = { projectId, service };
    if (readCollectionStore(candidate)) candidates.push(candidate);
  };

  for (const map of maps) {
    if (!isNgLViewMap(map)) continue;
    for (const view of map.values()) {
      for (const slot of view) {
        consider(slot);
        // The project shell holds the store in its component instance.
        if (!slot || typeof slot !== "object") continue;
        for (const key of ["ha", "Eu", "oa", "ka"]) {
          consider(Object.getOwnPropertyDescriptor(slot, key)?.value);
        }
      }
    }
  }

  boundStore = candidates.length === 1 ? candidates[0] : null;
  return candidates.length > 1
    ? { ok: false, error: "ambiguous_collection_store" }
    : collectionStoreStatus(projectId);
}

/** Checks the bound collection store, dispatcher, and project query. */
export function collectionWriteChecks(): StoreProbeCheck[] {
  const store = boundStore && isCurrent(boundStore) ? boundStore : null;
  const query = store && projectQuery(store);
  const ready = Boolean(query && query.state.status !== "pending" && tileMap(query.state.data));
  const dispatcher = typeof store?.service.na.VI === "function";
  const refetch = typeof query?.fetch === "function";
  return [
    { name: "collection_store", ok: ready, detail: ready ? "ready" : "not ready for the active project" },
    { name: "collection_dispatcher", ok: dispatcher, detail: dispatcher ? "present" : "missing" },
    { name: "collection_refetch", ok: refetch, detail: refetch ? "present" : "missing" },
  ];
}

/** Sends one mutation to the server with the bound project ID. */
export async function submitCollectionMutation(
  store: CollectionStore,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!isCurrent(store) || boundStore !== store) throw new Error("collection_project_changed");
  await store.service.na.VI(store.projectId, payload);
}

/** Fetches a new tile result for the bound project and checks that the project is still active. */
export async function refreshCollectionStore(store: CollectionStore): Promise<Map<string, FlowTile> | null> {
  if (!isCurrent(store) || boundStore !== store) return null;
  const query = projectQuery(store);
  if (!query) return null;
  const data = await query.fetch(undefined, { cancelRefetch: true });
  return isCurrent(store) && boundStore === store && projectQuery(store) === query ? tileMap(data) : null;
}
