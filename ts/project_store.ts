// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Bind, validate, read, and mutate the active project store from verified build formats.

import { isAngularSignal, isNgLViewMap, readOwn } from "./angular";
import { delay } from "./dom";
import {
  activeProjectStoreFormat,
  projectStoreFormats,
  readBuildLabel,
  withMutationAliases,
} from "./frontend_builds";
import type { ProjectStoreFormat } from "./frontend_builds";
import { hasReadableCascadedTiles } from "./frontend_compatibility";
import { clearStore, runtimeState } from "./state";
import type { FlowStoreHandle, FlowTile, NgLView, StoreProbeCheck } from "./types";

/** A Flow query for the tiles of one project. */
interface ProjectTileQuery {
  /** Key that includes the project ID. */
  queryKey: unknown;
  /** Most recent query status and result. */
  state: { status: string; data: unknown };
  /** Runs the query and returns the fetched result. */
  fetch: (options: undefined, settings: { cancelRefetch: boolean }) => Promise<unknown>;
}

/** Status returned when probing or binding the active project store. */
export interface ProjectStoreStatus {
  /** True when the bound store has a ready tile map for the requested project. */
  ok: boolean;
  /** True when a live verified store instance is bound, including while loading. */
  bound?: boolean;
  /** Error code when the store is unbound, loading, or on an unverified build. */
  error?: string;
  /** Active front-end build label when compatibility fails. */
  build?: string | null;
  /** Identifier of the active runtime session when ready. */
  session?: string;
}

/** A project store binding for the current document. */
export interface ProjectStore {
  /** Project ID at the time of binding. */
  readonly projectId: string;
  /** Store service in the Angular project shell or sub-route component. */
  readonly service: object;
  /** Field names of the bound store and query. */
  readonly format: ProjectStoreFormat;
}

/** Identifier of this runtime instance. Assign it on first binding. */
let session: string | null = null;
/** Store selected for the active project. */
let boundStore: ProjectStore | null = null;
/** Runtime store handle paired with `boundStore`. */
let boundHandle: FlowStoreHandle | null = null;
/** Promise chain that serializes general store mutations in this document. */
let mutationChain: Promise<void> = Promise.resolve();

/** Returns the project ID in the current route. */
export function projectInRoute(): string | null {
  return /\/project\/([^/?#]+)/.exec(location.pathname)?.[1] ?? null;
}

/** Checks the active route, lifecycle flag, and project signal of `store`. */
export function isCurrent({ projectId, service, format }: ProjectStore): boolean {
  const currentProject = readOwn(service, format.projectId);
  const lifecycle = readOwn(service, format.lifecycle);
  return projectInRoute() === projectId &&
    Boolean(lifecycle) && !readOwn(lifecycle, format.destroyed) &&
    typeof currentProject === "function" && currentProject.call(service) === projectId;
}

/** Clears both the direct store binding and `runtimeState.store`. */
export function clearProjectStore(): void {
  boundStore = null;
  boundHandle = null;
  clearStore();
}

/** Returns `boundStore` only while it stays paired with `runtimeState.store` and remains live. */
function activeBoundStore(): ProjectStore | null {
  if (!boundStore || runtimeState.store !== boundHandle || !isCurrent(boundStore)) {
    if (boundHandle && runtimeState.store === boundHandle) {
      clearProjectStore();
    } else {
      boundStore = null;
      boundHandle = null;
    }
    return null;
  }
  return boundStore;
}

/** Returns the live bound store when it matches `projectId`. */
export function currentProjectStore(projectId: string): ProjectStore | null {
  const active = activeBoundStore();
  return active?.projectId === projectId ? active : null;
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

/** Returns true while the verified tile query of `store` loads initial rows. */
export function isProjectStorePending(store: ProjectStore): boolean {
  if (!isCurrent(store)) return false;
  const signalQuery = readOwn(store.service, store.format.tileQuery);
  if (signalQuery && typeof signalQuery === "object" && "isPending" in signalQuery) {
    const isPending = readOwn(signalQuery, "isPending");
    if (typeof isPending === "function" ? Boolean(isPending.call(signalQuery)) : isPending === true) {
      return true;
    }
  }
  return projectQuery(store)?.state.status === "pending";
}

/** Indexes a validated tile row array by tile ID. */
function indexTileRows(rows: unknown): Map<string, FlowTile> | null {
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

/** Indexes a complete query result by tile ID. */
function tileMap(data: unknown, field: string): Map<string, FlowTile> | null {
  return indexTileRows(readOwn(data, field));
}

/** Reads the cached rows for the active project when the query settles. */
export function readProjectStore(store: ProjectStore): Map<string, FlowTile> | null {
  if (!isCurrent(store) || isProjectStorePending(store)) return null;
  const query = projectQuery(store);
  if (query) {
    const cached = tileMap(query.state.data, store.format.rows);
    if (cached) return cached;
  }
  const signalQuery = readOwn(store.service, store.format.tileQuery);
  if (!signalQuery || typeof signalQuery !== "object" || !("data" in signalQuery)) return null;
  const readData = readOwn(signalQuery, "data");
  const signalData: unknown = typeof readData === "function" ? readData.call(signalQuery) : readData;
  return indexTileRows(signalData) ?? tileMap(signalData, store.format.rows);
}

/** Returns the bound store only when the project and runtime session match. */
export function projectStore(projectId: string, expectedSession: string): ProjectStore | null {
  const active = currentProjectStore(projectId);
  return active && session === expectedSession ? active : null;
}

/** Resolves an async promise runner from the verified `mutator` field on the store. */
function resolveAsyncMutator(
  owner: object,
  mutator: unknown,
): ((payload: Record<string, unknown>) => Promise<unknown>) | null {
  if (typeof mutator === "function" && !isAngularSignal(mutator)) {
    return (payload) => Promise.resolve((mutator as (input: unknown) => unknown).call(owner, payload));
  }
  if (!mutator || typeof mutator !== "object") return null;
  const keys = Reflect.ownKeys(mutator);
  for (const key of ["mutateAsync", "oe", "re"]) {
    if (!keys.includes(key)) continue;
    const fn = readOwn(mutator, key);
    if (typeof fn === "function" && !isAngularSignal(fn)) {
      return (payload) => Promise.resolve((fn as (input: unknown) => unknown).call(mutator, payload));
    }
  }
  if (keys.includes("mutate") && keys.includes("reset")) {
    for (const key of keys) {
      if (typeof key !== "string" || key === "mutate" || key === "reset") continue;
      const fn = readOwn(mutator, key);
      if (typeof fn === "function" && !isAngularSignal(fn) && (fn as () => unknown).length >= 1) {
        return (payload) => Promise.resolve((fn as (input: unknown) => unknown).call(mutator, payload));
      }
    }
  }
  return null;
}

/** Dispatches a payload through the store queue while observing `format.errorStream`. */
async function dispatchThroughQueue(
  store: ProjectStore,
  queue: object,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const mutate = readOwn(queue, "mutate");
  if (typeof mutate !== "function") throw new Error("store_mutate_missing");
  const readItems = readOwn(queue, "ka");
  if (typeof readItems !== "function") {
    return await Promise.resolve(mutate.call(queue, payload));
  }
  let streamError: unknown = null;
  const stream = readOwn(queue, store.format.errorStream);
  const subscribe = readOwn(stream, "subscribe");
  const sub = typeof subscribe === "function"
    ? subscribe.call(stream, (event: unknown) => {
        const eventMutation = readOwn(event, "mutation");
        const error = readOwn(event, "error");
        if (error && (!eventMutation || eventMutation === payload)) {
          streamError = error;
        }
      }) as { unsubscribe?: () => void } | undefined
    : undefined;
  try {
    mutate.call(queue, payload);
    for (let i = 0; i < 400; i += 1) {
      if (streamError) {
        throw streamError instanceof Error ? streamError : new Error(String(streamError));
      }
      const snapshot = readItems.call(queue);
      const items = readOwn(snapshot, "items");
      const queued = Array.isArray(items) &&
        items.some((entry) => readOwn(entry, "mutation") === payload);
      if (!queued) {
        const readError = readOwn(queue, "error");
        const queueErr = typeof readError === "function" ? readError.call(queue) : undefined;
        if (queueErr) {
          throw queueErr instanceof Error ? queueErr : new Error(String(queueErr));
        }
        return undefined;
      }
      await delay(25);
    }
    throw new Error("mutation_timeout");
  } finally {
    sub?.unsubscribe?.();
  }
}

/** Dispatches one aliased mutation through the verified mutator or dispatcher of `store`. */
async function dispatchStoreMutation(
  store: ProjectStore,
  rawPayload: Record<string, unknown>,
): Promise<unknown> {
  if (!activeProjectStoreFormat()) {
    throw new Error("unsupported_front_end");
  }
  if (activeBoundStore() !== store || !isCurrent(store)) {
    clearProjectStore();
    throw new Error("project_store_changed");
  }
  const payload = withMutationAliases(rawPayload);
  const mutator = resolveAsyncMutator(store.service, readOwn(store.service, store.format.mutator));
  if (mutator) {
    return await mutator(payload);
  }
  const dispatch = storeDispatcher(store);
  if (typeof dispatch === "function") {
    const tilesService = readOwn(store.service, store.format.tilesService);
    const result: unknown = await dispatch.call(tilesService, store.projectId, payload);
    await refreshProjectStore(store).catch(() => null);
    return result;
  }
  const queue = readOwn(store.service, "ha");
  if (queue && typeof queue === "object") {
    return await dispatchThroughQueue(store, queue, payload);
  }
  throw new Error("store_mutate_missing");
}

/** Serializes general store mutations in the current page session. */
function mutateStore(store: ProjectStore, payload: Record<string, unknown>): Promise<unknown> {
  const run = mutationChain.then(() => dispatchStoreMutation(store, payload));
  mutationChain = run.then(() => undefined, () => undefined);
  return run;
}

/** Installs `store` into both `boundStore` and `runtimeState.store`. */
export function installProjectStore(store: ProjectStore, views?: Map<number, NgLView>): void {
  const handle: FlowStoreHandle = {
    projectId: store.projectId,
    isCurrent: () => isCurrent(store),
    getTileMap: () => readProjectStore(store),
    isReady: () => isCurrent(store) && !isProjectStorePending(store),
    mutate: (payload) => mutateStore(store, payload),
    rename: (id, displayName) =>
      mutateStore(store, {
        type: "single_tile",
        Xc: id,
        Uc: id,
        Ve: { type: "set_display_name", displayName },
      }),
  };
  boundStore = store;
  boundHandle = handle;
  if (views) runtimeState.ngLViewMap = views;
  runtimeState.projectId = store.projectId;
  runtimeState.routePath = location.pathname;
  runtimeState.storeFormat = store.format;
  runtimeState.store = handle;
}

/** Returns true when the loaded unverified front end exports none of the known store classes. */
export function hasNoCascadedStoreClasses(): boolean {
  return (
    !activeProjectStoreFormat() &&
    Boolean(readOwn(window, "default_AiSandboxAngularFrontend")) &&
    verifiedStoreLayouts().length === 0
  );
}

/** Resolves candidate store class constructors ordered from newest to oldest. */
function verifiedStoreLayouts(): Array<{ format: ProjectStoreFormat; storeClass: Function }> {
  const frontEnd = readOwn(window, "default_AiSandboxAngularFrontend");
  const layouts: Array<{ format: ProjectStoreFormat; storeClass: Function }> = [];
  for (const format of projectStoreFormats()) {
    const storeClass = readOwn(frontEnd, format.storeClass);
    if (typeof storeClass === "function") {
      layouts.push({ format, storeClass });
    }
  }
  return layouts;
}

/** Collects live `ProjectStore` candidates from one Angular `LView` array. */
export function findProjectStoreInView(
  view: unknown,
  projectId: string,
  seen = new Set<object>(),
): ProjectStore[] {
  if (!Array.isArray(view)) return [];
  const layouts = verifiedStoreLayouts();
  if (layouts.length === 0) return [];
  const matches: ProjectStore[] = [];
  const consider = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const { format, storeClass } of layouts) {
      if (!(value instanceof storeClass)) continue;
      const candidate: ProjectStore = { projectId, service: value, format };
      if (isCurrent(candidate)) matches.push(candidate);
      break;
    }
  };

  for (const slot of view) {
    consider(slot);
    if (!slot || typeof slot !== "object" || slot instanceof Node) continue;
    for (const { format } of layouts) {
      for (const key of format.componentSlots) {
        consider(Object.getOwnPropertyDescriptor(slot, key)?.value);
      }
    }
  }
  return matches;
}

/** Reports whether the current runtime has a bound and ready store for `projectId`. */
export function projectStoreStatus(projectId: string): ProjectStoreStatus {
  const build = readBuildLabel();
  if (projectInRoute() !== projectId) return { ok: false, error: "project_changed", build };
  if (hasNoCascadedStoreClasses()) {
    clearProjectStore();
    return { ok: false, error: "unsupported_front_end", build };
  }
  const store = currentProjectStore(projectId);
  if (!store) return { ok: false, error: "collection_store_not_bound", build };
  if (isProjectStorePending(store)) {
    return { ok: false, bound: true, error: "store_loading", build };
  }
  const tiles = readProjectStore(store);
  if (!tiles) {
    if (!activeProjectStoreFormat()) {
      clearProjectStore();
      return { ok: false, error: "unsupported_front_end", build };
    }
    return { ok: false, error: "collection_store_not_bound", build };
  }
  if (!activeProjectStoreFormat() && !hasReadableCascadedTiles(tiles)) {
    clearProjectStore();
    return { ok: false, error: "unsupported_front_end", build };
  }
  session ??= crypto.randomUUID();
  return { ok: true, bound: true, session, build };
}

/** Selects a store from the newest matching format, preferring the single ready store. */
export function selectProjectStoreCandidate(candidates: ProjectStore[]): ProjectStore | undefined {
  for (const format of projectStoreFormats()) {
    const matching = candidates.filter((store) => store.format === format);
    if (matching.length === 0) continue;
    if (matching.length === 1) return matching[0];
    const ready = matching.filter((store) => Boolean(readProjectStore(store)));
    return ready.length === 1 ? ready[0] : undefined;
  }
  return undefined;
}

/** Binds one live store found in the Angular view registry using the newest matching verified layout. */
export function bindProjectStore(maps: unknown[], projectId: string): ProjectStoreStatus {
  const build = readBuildLabel();
  if (projectInRoute() !== projectId) return { ok: false, error: "project_changed", build };
  if (hasNoCascadedStoreClasses()) {
    clearProjectStore();
    return { ok: false, error: "unsupported_front_end", build };
  }
  if (verifiedStoreLayouts().length === 0) {
    clearProjectStore();
    return { ok: false, error: "collection_store_not_bound", build };
  }

  const seen = new Set<object>();
  const candidates: Array<{ store: ProjectStore; views: Map<number, NgLView> }> = [];
  for (const map of maps) {
    if (!isNgLViewMap(map)) continue;
    for (const view of map.values()) {
      for (const store of findProjectStoreInView(view, projectId, seen)) {
        candidates.push({ store, views: map });
      }
    }
  }

  const selectedStore = selectProjectStoreCandidate(candidates.map(({ store }) => store));
  const selected = candidates.find(({ store }) => store === selectedStore);
  if (!selected) {
    clearProjectStore();
    return candidates.length > 1
      ? { ok: false, error: "ambiguous_collection_store", build }
      : { ok: false, error: "collection_store_not_bound", build };
  }
  installProjectStore(selected.store, selected.views);
  return projectStoreStatus(projectId);
}

/** Checks the bound project store, dispatcher, and query. */
export function projectWriteChecks(scope: "collection" | "project"): StoreProbeCheck[] {
  const store = activeBoundStore();
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
  if (!activeProjectStoreFormat()) {
    throw new Error("unsupported_front_end");
  }
  const dispatch = storeDispatcher(store);
  if (!isCurrent(store) || activeBoundStore() !== store || typeof dispatch !== "function") {
    throw new Error("project_store_changed");
  }
  await dispatch.call(readOwn(store.service, store.format.tilesService), store.projectId, payload);
}

/** Fetches a new tile result for the bound project and checks that the project is still active. */
export async function refreshProjectStore(store: ProjectStore): Promise<Map<string, FlowTile> | null> {
  if (!isCurrent(store) || activeBoundStore() !== store) return null;
  const query = projectQuery(store);
  if (typeof query?.fetch !== "function") return null;
  const data = await query.fetch(undefined, { cancelRefetch: true });
  return isCurrent(store) && activeBoundStore() === store && projectQuery(store) === query
    ? tileMap(data, store.format.rows)
    : null;
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
      while (!timedOut && activeBoundStore() === store && isCurrent(store)) {
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
