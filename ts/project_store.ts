// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Bind and update the active project store through JavaScript objects.

import { isNgLViewMap, readOwn } from "./angular";
import { delay } from "./dom";
import { projectStoreFormats } from "./frontend_builds";
import type { ProjectStoreFormat } from "./frontend_builds";
import type { FlowTile, StoreProbeCheck } from "./types";

/** A Flow query for the tiles of one project. */
interface ProjectTileQuery {
  /** Key that includes the project ID. */
  queryKey: unknown;
  /** Most recent query status and result. */
  state: { status: string; data: unknown };
  /** Runs the query and returns the fetched result. */
  fetch: (options: undefined, settings: { cancelRefetch: boolean }) => Promise<unknown>;
}

/** A project store binding for the current document. */
export interface ProjectStore {
  /** Project ID at the time of binding. */
  readonly projectId: string;
  /** Store service in the Angular project shell. */
  readonly service: object;
  /** Field names of the bound store and query. */
  readonly format: ProjectStoreFormat;
}

/** Identifier of this runtime instance. Assign it on first binding. */
let session: string | null = null;
/** Store selected for the active project. */
let boundStore: ProjectStore | null = null;

/** Returns the project ID in the current route. */
function projectInRoute(): string | null {
  return /\/project\/([^/?#]+)/.exec(location.pathname)?.[1] ?? null;
}

/** Checks the active route and the project that owns the store. */
function isCurrent({ projectId, service, format }: ProjectStore): boolean {
  const currentProject = readOwn(service, format.projectId);
  const lifecycle = readOwn(service, format.lifecycle);
  return projectInRoute() === projectId &&
    Boolean(lifecycle) && !readOwn(lifecycle, format.destroyed) &&
    typeof currentProject === "function" && currentProject.call(service) === projectId;
}

/** Finds the query by its full project key. */
function projectQuery({ projectId, service, format }: ProjectStore): ProjectTileQuery | undefined {
  const tiles = readOwn(service, format.tilesService);
  const queryKey = readOwn(tiles, "queryKey");
  const cache = readOwn(readOwn(tiles, format.queryClient), "queryCache");
  const find = readOwn(cache, "find");
  if (typeof queryKey !== "function" || typeof find !== "function") return undefined;
  const key: unknown = queryKey.call(tiles, projectId);
  if (!isProjectKey(key, projectId)) return undefined;
  const query = find.call(cache, { queryKey: key, exact: true }) as ProjectTileQuery | undefined;
  return isProjectKey(query?.queryKey, projectId) ? query : undefined;
}

/** Checks the project tile query key for an exact match. */
function isProjectKey(key: unknown, projectId: string): boolean {
  return Array.isArray(key) && key.length === 2 && key[0] === "PROJECT_TILES" && key[1] === projectId;
}

/** Indexes a complete result by tile ID. */
function tileMap(data: unknown, field: string): Map<string, FlowTile> | null {
  const rows = readOwn(data, field);
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
export function readProjectStore(store: ProjectStore): Map<string, FlowTile> | null {
  if (!isCurrent(store)) return null;
  const query = projectQuery(store);
  return query && query.state.status !== "pending" ? tileMap(query.state.data, store.format.rows) : null;
}

/** Returns the bound store only when the project and runtime session match. */
export function projectStore(projectId: string, expectedSession: string): ProjectStore | null {
  return boundStore?.projectId === projectId && session === expectedSession ? boundStore : null;
}

/** Reports whether the current runtime has a ready collection store for this project. */
export function projectStoreStatus(projectId: string): { ok: boolean; error?: string; session?: string } {
  if (projectInRoute() !== projectId) return { ok: false, error: "project_changed" };
  if (boundStore?.projectId !== projectId || !readProjectStore(boundStore)) {
    return { ok: false, error: "collection_store_not_bound" };
  }
  session ??= crypto.randomUUID();
  return { ok: true, session };
}

/** Binds one ready store found in the Angular view registry. */
export function bindProjectStore(maps: unknown[], projectId: string): ReturnType<typeof projectStoreStatus> {
  if (projectInRoute() !== projectId) return { ok: false, error: "project_changed" };
  const frontEnd = readOwn(window, "default_AiSandboxAngularFrontend");
  const layouts = projectStoreFormats().flatMap((format) => {
    const storeClass = readOwn(frontEnd, format.storeClass);
    return typeof storeClass === "function" ? [{ format, storeClass }] : [];
  });
  if (!layouts.length) {
    return { ok: false, error: "collection_store_not_bound" };
  }

  const seen = new Set<object>();
  const candidates: ProjectStore[] = [];
  const consider = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const { storeClass, format } of layouts) {
      if (!(value instanceof storeClass)) continue;
      const candidate = { projectId, service: value, format };
      if (readProjectStore(candidate)) {
        candidates.push(candidate);
        break;
      }
    }
  };

  for (const map of maps) {
    if (!isNgLViewMap(map)) continue;
    for (const view of map.values()) {
      if (!Array.isArray(view)) continue;
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
    : projectStoreStatus(projectId);
}

/** Checks the bound project store, dispatcher, and query. */
export function projectWriteChecks(scope: "collection" | "project"): StoreProbeCheck[] {
  const store = boundStore && isCurrent(boundStore) ? boundStore : null;
  const query = store && projectQuery(store);
  const ready = Boolean(store && query && query.state.status !== "pending" && tileMap(query.state.data, store.format.rows));
  const dispatcher = Boolean(store && typeof storeDispatcher(store) === "function");
  const refetch = typeof query?.fetch === "function";
  return [
    { name: `${scope}_store`, ok: ready, detail: ready ? "ready" : "not ready for the active project" },
    { name: `${scope}_dispatcher`, ok: dispatcher, detail: dispatcher ? "present" : "missing" },
    { name: `${scope}_refetch`, ok: refetch, detail: refetch ? "present" : "missing" },
  ];
}

/** Returns the dispatcher of the tile service. */
function storeDispatcher({ service, format }: ProjectStore): unknown {
  return readOwn(readOwn(service, format.tilesService), format.dispatcher);
}

/** Sends one mutation to the server with the bound project ID. */
async function submitProjectMutation(
  store: ProjectStore,
  payload: Record<string, unknown>,
): Promise<void> {
  const dispatch = storeDispatcher(store);
  if (!isCurrent(store) || boundStore !== store || typeof dispatch !== "function") {
    throw new Error("project_store_changed");
  }
  await dispatch.call(readOwn(store.service, store.format.tilesService), store.projectId, payload);
}

/** Fetches a new tile result for the bound project and checks that the project is still active. */
export async function refreshProjectStore(store: ProjectStore): Promise<Map<string, FlowTile> | null> {
  if (!isCurrent(store) || boundStore !== store) return null;
  const query = projectQuery(store);
  if (typeof query?.fetch !== "function") return null;
  const data = await query.fetch(undefined, { cancelRefetch: true });
  return isCurrent(store) && boundStore === store && projectQuery(store) === query ? tileMap(data, store.format.rows) : null;
}

/** Time limit for one submission and its confirmation. */
const MUTATION_TIMEOUT_MS = 10_000;
/** Time between checks for a submitted change. */
const MUTATION_CHECK_INTERVAL_MS = 250;
/** True until the previous project submission settles. */
export let projectMutationPending = false;
/** Projects that need a new query result after a mutation. */
export const projectsToRefresh = new Set<string>();

/** Sends one mutation and confirms it from a new server result. */
export async function mutateAndVerify(
  store: ProjectStore,
  payload: Record<string, unknown>,
  verified: (tiles: Map<string, FlowTile>) => boolean,
): Promise<Map<string, FlowTile> | null> {
  projectMutationPending = true;
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
      // A request can reach Flow even if the response does not reach this page.
      await submitProjectMutation(store, payload).catch(() => {});
      while (!timedOut && boundStore === store && isCurrent(store)) {
        const tiles = await refreshProjectStore(store).catch(() => null);
        if (timedOut) return null;
        if (tiles && verified(tiles)) {
          projectsToRefresh.delete(store.projectId);
          return tiles;
        }
        await Promise.race([delay(MUTATION_CHECK_INTERVAL_MS), timeout]);
      }
      return null;
    } catch {
      return null;
    } finally {
      projectMutationPending = false;
    }
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Refreshes the project before the next operation after an unknown result. */
export async function refreshAfterUnknown(store: ProjectStore): Promise<Map<string, FlowTile> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), MUTATION_TIMEOUT_MS);
  });
  try {
    const tiles = await Promise.race([refreshProjectStore(store), timeout]);
    if (tiles) projectsToRefresh.delete(store.projectId);
    return tiles;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
