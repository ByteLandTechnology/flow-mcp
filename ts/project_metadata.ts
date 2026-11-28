// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Mutate project titles in ProjectStore and read project and dashboard query caches.

import { resolveQueryClient } from "./agent_settings";
import type { AgentInjector, QueryClient } from "./agent_settings";
import {
  buildProjectUrl,
  isLiveLView,
  readOwn,
  resolveLView,
  withMapCapture,
} from "./angular";
import { delay } from "./dom";
import {
  activeProjectMetadataFormat,
  activeProjectStoreFormat,
  frontendBuild,
  readBuildLabel,
  withMutationAliases,
} from "./frontend_builds";
import type { ProjectMetadataFormat } from "./frontend_builds";
import {
  clearProjectStore,
  currentProjectStore,
  findProjectStoreInView,
  isCurrent,
  projectInRoute,
  projectStore,
  resolveAsyncMutator,
  serializeStoreMutation,
} from "./project_store";
import type { ProjectStore } from "./project_store";
import { runtimeState } from "./state";
import type { NgLView, StoreProbeCheck } from "./types";

/** Maximum number of pagination requests allowed per dashboard query or sentinel loop. */
export const MAX_GRID_PAGES = 50;

/** Maximum wait in milliseconds for initial project metadata or grid queries to settle. */
const QUERY_SETTLE_TIMEOUT_MS = 8_000;

/** Polling interval in milliseconds while waiting on metadata or infinite-page queries. */
const QUERY_POLL_MS = 80;

/** Confirmation timeout in milliseconds after dispatching `set_project_title`. */
const TITLE_CONFIRM_TIMEOUT_MS = 6_000;

/** Strict UUID pattern used when reading plain `projectId` properties. */
const UUID_EXACT_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Request payload accepted by `projectMetadataOp`. */
export interface ProjectMetadataRequest {
  /** Action name (`"set_title"`). */
  action: string;
  /** Desired project title for `"set_title"`. */
  title?: string | null;
}

/** Normalized project summary read from cached dashboard card protobufs. */
export interface CachedProjectItem {
  /** Project ID read from the card protobuf. */
  id: string;
  /** Project title read from the card metadata protobuf, or null when unset. */
  title: string | null;
  /** Canonical workspace URL for the project. */
  url: string;
}

/** Infinite query signal surface exposed on `flow-projects-grid` (`Y7`). */
interface InfiniteQuerySignal {
  /** Returns cached infinite-query data (`{ pages: unknown[] }`). */
  data?: () => unknown;
  /** Returns true while any fetch is in flight. */
  isFetching?: () => boolean;
  /** Returns true while the query displays placeholder data. */
  isPlaceholderData?: () => boolean;
  /** Returns true when the query encountered an error. */
  isError?: () => boolean;
  /** Returns true when another page token is available. */
  hasNextPage?: () => boolean;
  /** Returns true while `fetchNextPage()` is in flight. */
  isFetchingNextPage?: () => boolean;
  /** Returns true when the most recent next-page fetch failed. */
  isFetchNextPageError?: () => boolean;
  /** Requests the next page from the backend. */
  fetchNextPage?: () => Promise<unknown>;
}

/** Resolved infinite-query handles for a mounted `flow-projects-grid` component. */
interface ResolvedGridQueries {
  /** Verified metadata format for the active build. */
  format: ProjectMetadataFormat;
  /** Owned `PROJECTS` infinite query signal. */
  ownedQuery: InfiniteQuerySignal | undefined;
  /** Shared `SHARED_PROJECTS` infinite query signal. */
  sharedQuery: InfiniteQuerySignal | undefined;
  /** True when the `SHARED_PROJECTS` query is enabled on the grid. */
  sharedEnabled: boolean;
}

/** Calls a zero-argument boolean method on `target` when present. */
function callBool(target: unknown, key: string): boolean {
  const fn = readOwn(target, key);
  if (typeof fn === "function") {
    try {
      return Boolean(fn.call(target));
    } catch {
      return false;
    }
  }
  return fn === true;
}

/** Calls a zero-argument getter method on `target` when present. */
function callGetter(target: unknown, key: string): unknown {
  const fn = readOwn(target, key);
  if (typeof fn !== "function") return undefined;
  try {
    return fn.call(target);
  } catch {
    return undefined;
  }
}

/** Strips `"Google Flow - "` wrappers and generic `"Google Flow"` titles from `document.title`. */
export function cleanFlowDocumentTitle(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;
  if (/^google\s+flow\s*[-–|:—]\s*ai\s+creative\s+studio\b/i.test(trimmed)) {
    return null;
  }
  const stripped = trimmed
    .replace(/^google\s+flow\s*[-–|:—]\s*/i, "")
    .replace(/\s*[-–|:—]\s*google\s+flow$/i, "")
    .trim();
  if (!stripped || /^google\s+flow$/i.test(stripped)) {
    return null;
  }
  return stripped;
}

/** Checks the project metadata service, mutator, and title signal for `probeStore`. */
export function projectMetadataChecks(buildLabel: string | null): StoreProbeCheck[] {
  const format = frontendBuild(buildLabel)?.projectMetadata;
  if (!format) return [];
  const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
  const serviceClass = readOwn(namespace, format.metadataServiceClass);
  const pid = projectInRoute();
  const store = pid ? currentProjectStore(pid) : null;
  const metadataService = store ? readOwn(store.service, format.metadataService) : null;
  const mutator = store
    ? resolveAsyncMutator(store.service, readOwn(store.service, format.metadataMutator))
    : null;
  const dispatcher = readOwn(metadataService, format.metadataDispatcher);
  const titleSignal = store ? readOwn(store.service, format.titleSignal) : null;
  return [
    {
      name: "metadata_service",
      ok: typeof serviceClass === "function" && typeof dispatcher === "function",
      detail: typeof dispatcher === "function" ? "present" : "missing",
    },
    {
      name: "metadata_mutator",
      ok: typeof mutator === "function" || typeof dispatcher === "function",
      detail: typeof mutator === "function" ? "present" : "missing",
    },
    {
      name: "project_title_signal",
      ok: typeof titleSignal === "function",
      detail: typeof titleSignal === "function" ? "present" : "missing",
    },
  ];
}

/** Resolves the active `ProjectStore` for `projectId` from bound state or captured `LView`s. */
function resolveStoreForProject(projectId: string | null): ProjectStore | null {
  if (!projectId) return null;
  const direct = currentProjectStore(projectId);
  if (direct) return direct;
  const seen = new Set<object>();
  for (const view of runtimeState.ngLViewMap?.values() ?? []) {
    const hits = findProjectStoreInView(view, projectId, seen);
    if (hits.length > 0) return hits[0];
  }
  return null;
}

/** Checks whether `candidate` exposes `QueryClient.queryCache.find`. */
function asQueryClient(candidate: unknown): QueryClient | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const client = candidate as QueryClient;
  return typeof client.queryCache?.find === "function" ? client : undefined;
}

/** Resolves the shared `QueryClient` from `store`, Angular views, or page components. */
function findSharedQueryClient(store: ProjectStore | null): QueryClient | undefined {
  if (store) {
    const tilesClient = asQueryClient(
      readOwn(readOwn(store.service, store.format.tilesService), store.format.queryClient),
    );
    if (tilesClient) return tilesClient;
    const metaFormat = activeProjectMetadataFormat();
    if (metaFormat) {
      const metaService = readOwn(store.service, metaFormat.metadataService);
      const metaClient = asQueryClient(readOwn(metaService, store.format.queryClient));
      if (metaClient) return metaClient;
    }
  }
  for (const view of runtimeState.ngLViewMap?.values() ?? []) {
    if (!isLiveLView(view)) continue;
    for (const slot of view) {
      if (!slot || typeof slot !== "object" || slot instanceof Node) continue;
      const direct = asQueryClient(slot);
      if (direct) return direct;
      if (typeof (slot as AgentInjector).get === "function") {
        const resolved = resolveQueryClient(slot as AgentInjector);
        if (resolved) return resolved;
      }
      const viaPage = resolveQueryClient({}, slot as Record<string, unknown>);
      if (viaPage) return viaPage;
    }
  }
  return undefined;
}

/** Calls `getterName` on a protobuf message and returns a trimmed non-empty string, or `null`. */
function readProtoString(msg: unknown, getterName: string | undefined): string | null {
  if (!msg || typeof msg !== "object" || !getterName) return null;
  const val = callGetter(msg, getterName);
  return typeof val === "string" && val.trim() ? val.trim() : null;
}

/** Extracts a project title from a cached `PROJECT` or `PROJECT_DETAILS` message. */
function extractProjectDetailTitle(
  data: unknown,
  format: ProjectMetadataFormat | undefined,
): string | null {
  if (!data || typeof data !== "object") return null;
  if (format) {
    const fromInfo = readProtoString(
      callGetter(data, format.projectInfoGetter),
      format.projectTitleGetter,
    );
    if (fromInfo !== null) return fromInfo;
    const fromMeta = readProtoString(
      callGetter(data, format.cardMetadataGetter),
      format.cardTitleGetter,
    );
    if (fromMeta !== null) return fromMeta;
  }
  const directTitle = readOwn(data, "title") ?? readOwn(data, "displayName");
  return typeof directTitle === "string" && directTitle.trim() ? directTitle.trim() : null;
}

/** Extracts `{ id, title }` from one owned or shared project card protobuf entry. */
function extractCardProtobuf(
  rawEntry: unknown,
  isShared: boolean,
  format: ProjectMetadataFormat,
): { id: string; title: string | null } | null {
  if (!rawEntry || typeof rawEntry !== "object") return null;
  const unwrapped = isShared ? callGetter(rawEntry, format.sharedProjectGetter) : rawEntry;
  if (!unwrapped || typeof unwrapped !== "object") return null;

  let id = readProtoString(unwrapped, format.cardIdGetter);
  if (!id) {
    const plain = readOwn(unwrapped, "projectId");
    if (typeof plain === "string" && UUID_EXACT_RE.test(plain.trim())) {
      id = plain.trim();
    }
  }
  if (!id) return null;

  const meta = callGetter(unwrapped, format.cardMetadataGetter);
  const title =
    readProtoString(meta, format.cardTitleGetter) ??
    extractProjectDetailTitle(unwrapped, format);
  return { id, title };
}

/** Reads cached project entries from an infinite-query `data` value (`{ pages: [...] }`). */
function collectPagesEntries(
  data: unknown,
  itemsKey: string,
  isShared: boolean,
  format: ProjectMetadataFormat,
  into: Map<string, CachedProjectItem>,
): void {
  const pages = readOwn(data, "pages");
  if (!Array.isArray(pages)) return;
  for (const page of pages) {
    const items = readOwn(page, itemsKey);
    if (!Array.isArray(items)) continue;
    for (const rawItem of items) {
      const parsed = extractCardProtobuf(rawItem, isShared, format);
      if (!parsed || into.has(parsed.id)) continue;
      into.set(parsed.id, {
        id: parsed.id,
        title: parsed.title,
        url: buildProjectUrl(parsed.id),
      });
    }
  }
}

/** Builds the candidate `QueryClient` keys for `projectId`. */
function buildCandidateProjectKeys(
  projectId: string,
  format: ProjectMetadataFormat | undefined,
): unknown[][] {
  const keys: unknown[][] = [
    ["PROJECT", projectId],
    ["PROJECT_DETAILS", projectId],
  ];
  if (format?.projectKey) {
    const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
    const keyFn = readOwn(namespace, format.projectKey);
    if (typeof keyFn === "function") {
      try {
        const built: unknown = keyFn(projectId);
        if (Array.isArray(built)) keys.unshift(built);
      } catch {
        // Ignore key builder error and inspect standard keys.
      }
    }
  }
  return keys;
}

/** Reads the title for `projectId` from `QueryClient` (`PROJECT`, `PROJECT_DETAILS`, or grid caches). */
function readTitleFromQueryClient(
  client: QueryClient | undefined,
  projectId: string,
  format: ProjectMetadataFormat | undefined,
): string | null {
  const cache = client?.queryCache;
  if (!cache) return null;

  for (const queryKey of buildCandidateProjectKeys(projectId, format)) {
    const direct = typeof client?.ha === "function" ? client.ha(queryKey) : undefined;
    const fromDirect = extractProjectDetailTitle(direct, format);
    if (fromDirect !== null) return fromDirect;

    const query = cache.find?.({ queryKey, exact: true });
    const fromFind = extractProjectDetailTitle(readOwn(query?.state, "data"), format);
    if (fromFind !== null) return fromFind;
  }

  if (!format) return null;
  const cached = collectProjectsFromQueryCache(client, format);
  return cached.items.get(projectId)?.title ?? null;
}

/** Reads the authoritative project title from `Jk()`, `QueryClient`, or cleaned `document.title`. */
export function readProjectTitle(projectId: string | null): string | null {
  const format = activeProjectMetadataFormat();
  const store = resolveStoreForProject(projectId);
  if (store && format) {
    const rawSignalTitle = callGetter(store.service, format.titleSignal);
    if (typeof rawSignalTitle === "string" && rawSignalTitle.trim()) {
      return rawSignalTitle.trim();
    }
  }
  const client = findSharedQueryClient(store);
  if (projectId) {
    const cachedTitle = readTitleFromQueryClient(client, projectId, format);
    if (cachedTitle !== null) return cachedTitle;
  }
  const onSubroute = /\/project\/[^/?#]+\/[^/?#]+/.test(location.pathname || "");
  if (onSubroute && store && format) {
    const querySignal = readOwn(store.service, format.metadataQuery);
    if (callGetter(querySignal, "data") !== undefined) {
      return null;
    }
  }
  return cleanFlowDocumentTitle(document.title);
}

/** Waits for the store's `PROJECT` metadata query (`Ag`) to populate initial data before mutating. */
async function ensureProjectMetadataLoaded(
  store: ProjectStore,
  format: ProjectMetadataFormat,
): Promise<void> {
  const querySignal = readOwn(store.service, format.metadataQuery);
  const client = findSharedQueryClient(store);
  const projectKeys = buildCandidateProjectKeys(store.projectId, format).filter(
    (key) => key[0] !== "PROJECT_DETAILS",
  );
  const hasMetadata = (): boolean => {
    if (callGetter(querySignal, "data") !== undefined) return true;
    for (const queryKey of projectKeys) {
      if (client?.ha?.(queryKey) !== undefined) return true;
      const query = client?.queryCache?.find?.({ queryKey, exact: true });
      if (readOwn(query?.state, "data") !== undefined) return true;
    }
    return false;
  };
  if (hasMetadata()) return;

  const refetch = readOwn(querySignal, "refetch");
  if (typeof refetch === "function" && !callBool(querySignal, "isFetching")) {
    void Promise.resolve(refetch.call(querySignal)).catch(() => null);
  }
  const deadline = Date.now() + QUERY_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (currentProjectStore(store.projectId) !== store || !isCurrent(store)) {
      clearProjectStore();
      throw new Error("project_store_changed");
    }
    if (hasMetadata()) return;
    if (callBool(querySignal, "isError") && !callBool(querySignal, "isFetching")) {
      throw new Error("project_metadata_load_failed");
    }
    await delay(QUERY_POLL_MS);
  }
  if (hasMetadata()) return;
  throw new Error("project_metadata_not_loaded");
}

/** Runs `projectMetadataOp` (`set_title`) in the pinned `ProjectStore` session. */
export async function projectMetadataOp(
  projectId: string,
  session: string,
  req: ProjectMetadataRequest,
): Promise<unknown> {
  const label = readBuildLabel();
  const build = frontendBuild(label);
  if (!build) {
    return { ok: false, error: "unsupported_front_end", build: label };
  }
  const store = projectStore(projectId, session);
  if (!store) {
    return { ok: false, error: "project_changed" };
  }
  const format = build.projectMetadata;
  if (!format) {
    return { ok: false, error: "legacy_project_title", build: label };
  }

  const action = String(req?.action || "").toLowerCase();
  if (action !== "set_title") {
    return { ok: false, error: `unknown_project_metadata_action:${action}` };
  }
  const desired = String(req?.title ?? "").trim();
  if (!desired) {
    return { ok: false, error: "empty_title" };
  }

  let writeStarted = false;
  try {
    await serializeStoreMutation(async () => {
      if (!activeProjectStoreFormat()) {
        clearProjectStore();
        throw new Error("unsupported_front_end");
      }
      if (currentProjectStore(store.projectId) !== store || !isCurrent(store)) {
        clearProjectStore();
        throw new Error("project_store_changed");
      }
      await ensureProjectMetadataLoaded(store, format);
      const payload = withMutationAliases({
        type: "set_project_title",
        [format.titleField]: desired,
      });
      const mutator = resolveAsyncMutator(
        store.service,
        readOwn(store.service, format.metadataMutator),
      );
      if (mutator) {
        writeStarted = true;
        await mutator(payload);
        return;
      }
      const metadataService = readOwn(store.service, format.metadataService);
      const dispatcher = readOwn(metadataService, format.metadataDispatcher);
      if (typeof dispatcher === "function") {
        writeStarted = true;
        await dispatcher.call(metadataService, store.projectId, payload);
        const querySignal = readOwn(store.service, format.metadataQuery);
        const refetch = readOwn(querySignal, "refetch");
        if (typeof refetch === "function") {
          await Promise.resolve(refetch.call(querySignal)).catch(() => null);
        }
        return;
      }
      throw new Error("metadata_mutator_missing");
    });
  } catch (err) {
    if (!writeStarted) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    throw err;
  }

  const matchesDesired = (): boolean => {
    const signalVal = callGetter(store.service, format.titleSignal);
    if (typeof signalVal === "string" && signalVal.trim() === desired) return true;
    return readTitleFromQueryClient(findSharedQueryClient(store), projectId, format) === desired;
  };

  const deadline = Date.now() + TITLE_CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline && projectStore(projectId, session) === store && isCurrent(store)) {
    const mutating = callBool(readOwn(store.service, format.metadataMutator), "isPending");
    if (!mutating && matchesDesired()) {
      await delay(120);
      if (matchesDesired()) {
        return { ok: true, confirmed: true, project_id: projectId, title: desired };
      }
    }
    await delay(QUERY_POLL_MS);
  }
  return { ok: false, error: "project_title_not_confirmed" };
}

/** Checks whether `candidate` is a `flow-projects-grid` (`Y7`) component instance. */
function isProjectsGridComponent(
  candidate: unknown,
  gridClass: unknown,
  format: ProjectMetadataFormat,
): candidate is Record<string, unknown> {
  if (!candidate || typeof candidate !== "object" || candidate instanceof Node) return false;
  if (typeof gridClass === "function" && candidate instanceof gridClass) return true;
  const owned = readOwn(candidate, format.ownedQuery);
  const shared = readOwn(candidate, format.sharedQuery);
  return (
    typeof readOwn(owned, "fetchNextPage") === "function" &&
    typeof readOwn(shared, "fetchNextPage") === "function"
  );
}

/** Locates a mounted `flow-projects-grid` component synchronously without DOM events. */
function locateProjectsGridSync(
  format: ProjectMetadataFormat,
  extraMaps?: Iterable<Map<unknown, unknown>>,
): Record<string, unknown> | null {
  const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
  const gridClass = readOwn(namespace, format.gridClass);
  const host = document.querySelector("flow-projects-grid");
  if (host) {
    const directHit = resolveLView(host)?.find((slot) =>
      isProjectsGridComponent(slot, gridClass, format),
    );
    if (directHit) return directHit;
    const ctx = (host as unknown as { __ngContext__?: unknown }).__ngContext__;
    if (typeof ctx === "number" && extraMaps) {
      for (const map of extraMaps) {
        const view = map.get(ctx);
        const mappedHit = Array.isArray(view)
          ? view.find((slot) => isProjectsGridComponent(slot, gridClass, format))
          : undefined;
        if (mappedHit) {
          runtimeState.ngLViewMap = map as Map<number, NgLView>;
          return mappedHit;
        }
      }
    }
  }
  for (const view of runtimeState.ngLViewMap?.values() ?? []) {
    if (!isLiveLView(view)) continue;
    const hit = view.find((slot) => isProjectsGridComponent(slot, gridClass, format));
    if (hit) return hit;
  }
  return null;
}

/** Resolves the mounted `flow-projects-grid` (`Y7`) infinite queries on the Flow home page. */
async function resolveProjectsGridQueries(waitMount: boolean): Promise<ResolvedGridQueries | null> {
  const format = activeProjectMetadataFormat();
  if (!format) return null;
  let grid = locateProjectsGridSync(format);
  if (!grid && waitMount) {
    for (let attempt = 0; attempt < 25 && !grid; attempt += 1) {
      const host = document.querySelector("flow-projects-grid");
      if (host) {
        const captured = new Set<Map<unknown, unknown>>();
        await withMapCapture(
          (map, _key, _value, write) => {
            if (!write) captured.add(map);
          },
          async () => {
            const card = host.querySelector("flow-project-card, button");
            if (card instanceof HTMLElement) {
              card.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
              card.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
            }
            await delay(40);
          },
        );
        grid = locateProjectsGridSync(format, captured);
        if (grid) break;
      }
      const loading = Boolean(
        document.querySelector("flow-loading-page, .projects-loading-container"),
      );
      if (!loading && !host && attempt >= 4) break;
      await delay(120);
    }
  }
  if (!grid) return null;
  const ownedQuery = readOwn(grid, format.ownedQuery) as InfiniteQuerySignal | undefined;
  const sharedQuery = readOwn(grid, format.sharedQuery) as InfiniteQuerySignal | undefined;
  const sharedEnabled =
    typeof readOwn(grid, "zf") === "function"
      ? callBool(grid, "zf")
      : Boolean(
          callGetter(sharedQuery, "data") !== undefined ||
            callBool(sharedQuery, "isFetching") ||
            callBool(sharedQuery, "hasNextPage"),
        );
  return { format, ownedQuery, sharedQuery, sharedEnabled };
}

/** Returns the number of loaded pages in an infinite query signal. */
function readPagesCount(query: InfiniteQuerySignal | undefined): number {
  const pages = readOwn(callGetter(query, "data"), "pages");
  return Array.isArray(pages) ? pages.length : 0;
}

/** Waits until an infinite query finishes its initial load or in-flight next-page fetch. */
async function waitInfiniteQueryIdle(
  query: InfiniteQuerySignal | undefined,
  waitInitial: boolean,
): Promise<void> {
  if (!query) return;
  const deadline = Date.now() + QUERY_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (callBool(query, "isError")) return;
    const fetchingNext = callBool(query, "isFetchingNextPage");
    const initialBusy =
      waitInitial &&
      readPagesCount(query) === 0 &&
      (callBool(query, "isFetching") || callBool(query, "isPlaceholderData"));
    if (!fetchingNext && !initialBusy) return;
    await delay(QUERY_POLL_MS);
  }
}

/** Fetches all remaining pages of `query` up to `MAX_GRID_PAGES` (`50`). */
async function fetchAllInfinitePages(
  query: InfiniteQuerySignal | undefined,
  enabled: boolean,
): Promise<void> {
  if (!query || !enabled || typeof query.fetchNextPage !== "function") return;
  await waitInfiniteQueryIdle(query, true);
  for (let page = 0; page < MAX_GRID_PAGES; page += 1) {
    await waitInfiniteQueryIdle(query, false);
    if (!callBool(query, "hasNextPage") || callBool(query, "isFetchNextPageError")) break;
    const beforePages = readPagesCount(query);
    try {
      await Promise.resolve(query.fetchNextPage());
    } catch {
      break;
    }
    await waitInfiniteQueryIdle(query, false);
    if (readPagesCount(query) <= beforePages && callBool(query, "hasNextPage")) break;
  }
}

/** Collects cached dashboard project cards from `QueryClient` without triggering fetches. */
function collectProjectsFromQueryCache(
  client: QueryClient | undefined,
  format: ProjectMetadataFormat,
): { sawProjectsQuery: boolean; items: Map<string, CachedProjectItem> } {
  const items = new Map<string, CachedProjectItem>();
  let sawProjectsQuery = false;
  const findAll = readOwn(client?.queryCache, "findAll");
  if (typeof findAll !== "function") return { sawProjectsQuery, items };
  const queries: unknown = findAll.call(client?.queryCache);
  if (!Array.isArray(queries)) return { sawProjectsQuery, items };
  for (const query of queries) {
    const key = readOwn(query, "queryKey");
    if (!Array.isArray(key) || typeof key[0] !== "string") continue;
    const data = readOwn(readOwn(query, "state"), "data");
    if (key[0] === "PROJECTS") {
      sawProjectsQuery = true;
      collectPagesEntries(data, format.ownedQuery, false, format, items);
    } else if (key[0] === "SHARED_PROJECTS") {
      sawProjectsQuery = true;
      collectPagesEntries(data, format.sharedQuery, true, format, items);
    }
  }
  return { sawProjectsQuery, items };
}

/** Inspects `flow-projects-grid` (`PROJECTS` and `SHARED_PROJECTS`), fetches all pages, and reads cached card protobufs. */
export async function listCachedProjects(): Promise<CachedProjectItem[] | null> {
  const resolved = await resolveProjectsGridQueries(true);
  if (resolved) {
    const { format, ownedQuery, sharedQuery, sharedEnabled } = resolved;
    await Promise.all([
      fetchAllInfinitePages(ownedQuery, true),
      fetchAllInfinitePages(sharedQuery, sharedEnabled),
    ]);
    const items = new Map<string, CachedProjectItem>();
    collectPagesEntries(callGetter(ownedQuery, "data"), format.ownedQuery, false, format, items);
    if (sharedEnabled) {
      collectPagesEntries(callGetter(sharedQuery, "data"), format.sharedQuery, true, format, items);
    }
    return [...items.values()];
  }
  const format = activeProjectMetadataFormat();
  if (!format) return null;
  const cached = collectProjectsFromQueryCache(findSharedQueryClient(null), format);
  return cached.sawProjectsQuery ? [...cached.items.values()] : null;
}

/** Reads currently loaded dashboard card protobufs without triggering additional pagination. */
export function snapshotLoadedGridProjects(): Map<string, CachedProjectItem> {
  const format = activeProjectMetadataFormat();
  if (!format) return new Map();
  const grid = locateProjectsGridSync(format);
  if (grid) {
    const items = new Map<string, CachedProjectItem>();
    const ownedQuery = readOwn(grid, format.ownedQuery);
    const sharedQuery = readOwn(grid, format.sharedQuery);
    collectPagesEntries(callGetter(ownedQuery, "data"), format.ownedQuery, false, format, items);
    collectPagesEntries(callGetter(sharedQuery, "data"), format.sharedQuery, true, format, items);
    return items;
  }
  return collectProjectsFromQueryCache(findSharedQueryClient(null), format).items;
}

/** Returns `true` when `flow-projects-grid` currently has an in-flight `PROJECTS` or `SHARED_PROJECTS` fetch. */
export function isProjectsGridFetching(): boolean {
  const format = activeProjectMetadataFormat();
  if (!format) return false;
  const grid = locateProjectsGridSync(format);
  if (!grid) return false;
  const ownedBusy = callBool(readOwn(grid, format.ownedQuery), "isFetching");
  const sharedBusy =
    callBool(grid, "zf") && callBool(readOwn(grid, format.sharedQuery), "isFetching");
  return ownedBusy || sharedBusy;
}

/** Advances `flow-projects-grid` by one page when `hasNextPage()` is true, returning whether a page was fetched. */
export async function advanceProjectsGridPage(): Promise<boolean> {
  const resolved = await resolveProjectsGridQueries(true);
  if (!resolved) return false;
  const { ownedQuery, sharedQuery, sharedEnabled } = resolved;

  await Promise.all([
    waitInfiniteQueryIdle(ownedQuery, true),
    sharedEnabled ? waitInfiniteQueryIdle(sharedQuery, true) : Promise.resolve(),
  ]);

  const tasks: Array<Promise<unknown>> = [];
  const beforeOwned = readPagesCount(ownedQuery);
  const beforeShared = readPagesCount(sharedQuery);

  if (
    ownedQuery &&
    typeof ownedQuery.fetchNextPage === "function" &&
    callBool(ownedQuery, "hasNextPage") &&
    !callBool(ownedQuery, "isFetchNextPageError")
  ) {
    tasks.push(Promise.resolve(ownedQuery.fetchNextPage()).catch(() => null));
  }
  if (
    sharedEnabled &&
    sharedQuery &&
    typeof sharedQuery.fetchNextPage === "function" &&
    callBool(sharedQuery, "hasNextPage") &&
    !callBool(sharedQuery, "isFetchNextPageError")
  ) {
    tasks.push(Promise.resolve(sharedQuery.fetchNextPage()).catch(() => null));
  }
  if (tasks.length === 0) return false;

  await Promise.all(tasks);
  await Promise.all([
    waitInfiniteQueryIdle(ownedQuery, false),
    sharedEnabled ? waitInfiniteQueryIdle(sharedQuery, false) : Promise.resolve(),
  ]);

  return readPagesCount(ownedQuery) > beforeOwned || readPagesCount(sharedQuery) > beforeShared;
}
