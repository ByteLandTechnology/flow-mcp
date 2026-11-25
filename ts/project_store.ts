// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Bind, validate, read, and mutate the active project store from verified build formats.

import { isNgLViewMap, readOwn } from "./angular";
import { delay } from "./dom";
import { activeProjectStoreFormat, readBuildLabel, withMutationAliases } from "./frontend_builds";
import type { ProjectStoreFormat } from "./frontend_builds";
import { clearStore, runtimeState } from "./state";
import type {
  CustomVoiceItem,
  FlowStoreHandle,
  FlowTile,
  NgLView,
  StoreProbeCheck,
} from "./types";

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

/** Reads the raw settled query payload for `store` when available. */
function readStoreQueryData(store: ProjectStore): unknown {
  if (!isCurrent(store) || isProjectStorePending(store)) return null;
  const query = projectQuery(store);
  if (query && query.state.data != null) {
    return query.state.data;
  }
  const signalQuery = readOwn(store.service, store.format.tileQuery);
  if (!signalQuery || typeof signalQuery !== "object" || !("data" in signalQuery)) return null;
  const readData = readOwn(signalQuery, "data");
  return typeof readData === "function" ? readData.call(signalQuery) : readData;
}

/** Reads a 1-based field from a dense or sparse serialized JSPB array. */
function voiceProtoField(msg: unknown, field: number): unknown {
  if (!Array.isArray(msg) || field < 1) return undefined;
  const tail: unknown = msg[msg.length - 1];
  if (tail && typeof tail === "object" && !Array.isArray(tail)) {
    const mapped = readOwn(tail, String(field));
    if (mapped !== undefined) return mapped;
  }
  return msg[field - 1];
}

/** Iterates values from a `Map`, array, or plain record. */
function mapValues(source: unknown): unknown[] {
  if (source instanceof Map) return Array.from(source.values());
  if (Array.isArray(source)) return source;
  if (source && typeof source === "object") return Object.values(source);
  return [];
}

/** Builds a workflow and tile display-name lookup map from `lr` and `yb`. */
function buildVoiceNameMap(data: unknown, rowsField: string): Map<string, string> {
  const names = new Map<string, string>();
  const register = (key: unknown, title: unknown): void => {
    if (typeof key !== "string" || typeof title !== "string") return;
    const cleanKey = key.trim();
    const cleanTitle = title.trim();
    if (!cleanKey || !cleanTitle) return;
    names.set(cleanKey, cleanTitle);
    names.set(cleanKey.replace(/^(?:media|workflows)\//i, ""), cleanTitle);
  };

  const rows = readOwn(data, rowsField);
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const displayName = readOwn(row, "displayName");
      register(readOwn(row, "id"), displayName);
      register(readOwn(row, "workflowId"), displayName);
      register(readOwn(row, "primaryMediaId"), displayName);
    }
  }

  const lr = readOwn(data, "lr");
  const lrEntries: Array<[unknown, unknown]> =
    lr instanceof Map
      ? Array.from(lr.entries())
      : lr && typeof lr === "object" && !Array.isArray(lr)
        ? Object.entries(lr)
        : [];
  for (const [wfKey, wfVal] of lrEntries) {
    let wfId: unknown = wfKey;
    let wfTitle: unknown = readOwn(wfVal, "displayName") ?? readOwn(wfVal, "name");
    const getNameFn = readOwn(wfVal, "getName");
    if (typeof getNameFn === "function") {
      try {
        wfId = getNameFn.call(wfVal) ?? wfId;
      } catch {
        // Keep map key fallback.
      }
    }
    const getMetaFn = readOwn(wfVal, "getMetadata");
    if (!wfTitle && typeof getMetaFn === "function") {
      try {
        const meta: unknown = getMetaFn.call(wfVal);
        const qdFn = readOwn(meta, "Qd");
        if (typeof qdFn === "function") {
          wfTitle = qdFn.call(meta);
        }
      } catch {
        // Fall through to serialized JSON check.
      }
    }
    const toJsonFn = readOwn(wfVal, "toJSON");
    if (!wfTitle && typeof toJsonFn === "function") {
      try {
        const rawWf: unknown = toJsonFn.call(wfVal);
        wfId = voiceProtoField(rawWf, 1) ?? wfId;
        const rawMeta = voiceProtoField(rawWf, 4) ?? voiceProtoField(rawWf, 3);
        wfTitle = voiceProtoField(rawMeta, 1);
      } catch {
        // Ignore malformed workflow entry.
      }
    }
    register(wfId, wfTitle);
  }
  return names;
}

/** Extracts saved custom voices from `cj` and `lr` on `store` without changing `getTileMap()`. */
function readCustomVoices(store: ProjectStore): CustomVoiceItem[] {
  const data = readStoreQueryData(store);
  if (!data || typeof data !== "object") return [];
  const cj = readOwn(data, "cj");
  const candidates = mapValues(cj);
  if (candidates.length === 0) return [];

  const nameMap = buildVoiceNameMap(data, store.format.rows);
  const frontEnd = readOwn(window, "default_AiSandboxAngularFrontend");
  const hUbFn = readOwn(frontEnd, "hUb");
  const fvFn = readOwn(frontEnd, "fv");
  const brOneof = readOwn(frontEnd, "Br");

  const out: CustomVoiceItem[] = [];
  const seen = new Set<string>();
  const lookupTitle = (wfId: string | null, mediaId: string): string | null => {
    if (wfId) {
      const hit = nameMap.get(wfId) ?? nameMap.get(wfId.replace(/^workflows\//i, ""));
      if (hit) return hit;
    }
    return nameMap.get(mediaId) ?? nameMap.get(mediaId.replace(/^media\//i, "")) ?? null;
  };

  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;

    if (
      typeof hUbFn === "function" &&
      typeof fvFn === "function" &&
      Array.isArray(brOneof)
    ) {
      try {
        const isAudio = Boolean(
          (fvFn as (msg: unknown, field: number, oneof: unknown[]) => unknown).call(
            frontEnd,
            item,
            11,
            brOneof,
          ),
        );
        if (!isAudio) continue;
        const mapped = (
          hUbFn as (msg: unknown, names: Map<string, string>) => Record<string, unknown> | undefined
        ).call(frontEnd, item, nameMap);
        if (!mapped || mapped.Rv === true || mapped.Db === true) continue;
        const rawId = String(mapped.id ?? mapped.workflowId ?? mapped.mediaId ?? "").trim();
        if (!rawId || /^voices\//i.test(rawId)) continue;
        const mediaId = String(mapped.mediaId ?? rawId)
          .trim()
          .replace(/^(?:media|workflows)\//i, "");
        if (!mediaId || seen.has(mediaId)) continue;
        seen.add(mediaId);
        const wfId =
          typeof mapped.workflowId === "string" && mapped.workflowId.trim()
            ? mapped.workflowId.trim()
            : null;
        const assetId = rawId.replace(/^(?:media|workflows)\//i, "") || mediaId;
        const prompt =
          typeof mapped.description === "string" && mapped.description.trim()
            ? mapped.description.trim()
            : typeof mapped.f7 === "string" && mapped.f7.trim()
              ? mapped.f7.trim()
              : null;
        const rawUrl = typeof mapped.NU === "string" ? mapped.NU.trim() : "";
        const created =
          mapped.rm instanceof Date && mapped.rm.getTime() > 0
            ? mapped.rm.toISOString()
            : null;
        out.push({
          id: assetId,
          name:
            (typeof mapped.title === "string" && mapped.title.trim()) ||
            lookupTitle(wfId, mediaId) ||
            "Custom voice",
          mediaId,
          workflowId: wfId,
          prompt,
          url: /^https?:\/\//i.test(rawUrl) ? rawUrl : null,
          createdAt: created,
        });
        continue;
      } catch {
        // Fall through to structural JSPB and plain-object inspection.
      }
    }

    const toJsonFn = readOwn(item, "toJSON");
    const serialized: unknown =
      typeof toJsonFn === "function"
        ? (() => {
            try {
              return toJsonFn.call(item);
            } catch {
              return null;
            }
          })()
        : Array.isArray(item)
          ? item
          : null;

    if (Array.isArray(serialized)) {
      const audioBranch = voiceProtoField(serialized, 11);
      if (!audioBranch || typeof audioBranch !== "object") continue;
      const audioInner = Array.isArray(audioBranch)
        ? (voiceProtoField(audioBranch, 1) ?? audioBranch)
        : (readOwn(audioBranch, "1") ?? audioBranch);
      if (voiceProtoField(audioInner, 3) === true) continue;
      const rawName = voiceProtoField(serialized, 1);
      if (typeof rawName !== "string" || !rawName.trim() || /^voices\//i.test(rawName.trim())) {
        continue;
      }
      const mediaId = rawName.trim().replace(/^media\//i, "");
      if (!mediaId || seen.has(mediaId)) continue;
      const meta =
        voiceProtoField(serialized, 4) ??
        voiceProtoField(serialized, 5) ??
        voiceProtoField(serialized, 6);
      if (voiceProtoField(meta, 4) === true) continue;
      seen.add(mediaId);
      const wfRaw = voiceProtoField(serialized, 3);
      const wfId = typeof wfRaw === "string" && wfRaw.trim() ? wfRaw.trim() : null;
      const metaTitle = voiceProtoField(meta, 2);
      const audioName = voiceProtoField(audioInner, 1);
      const title =
        (typeof metaTitle === "string" && metaTitle.trim()) ||
        (typeof audioName === "string" && audioName.trim()) ||
        lookupTitle(wfId, mediaId) ||
        "Custom voice";
      const desc =
        voiceProtoField(audioInner, 8) ??
        voiceProtoField(audioInner, 2) ??
        voiceProtoField(audioInner, 5);
      const urlCand = voiceProtoField(audioInner, 4) ?? voiceProtoField(audioInner, 6);
      out.push({
        id: mediaId,
        name: title,
        mediaId,
        workflowId: wfId,
        prompt: typeof desc === "string" && desc.trim() ? desc.trim() : null,
        url:
          typeof urlCand === "string" && /^https?:\/\//i.test(urlCand.trim())
            ? urlCand.trim()
            : null,
        createdAt: null,
      });
      continue;
    }

    if (readOwn(item, "Rv") === true || readOwn(item, "Db") === true || readOwn(item, "trashed") === true) {
      continue;
    }
    const kindHint = String(readOwn(item, "type") ?? readOwn(item, "kind") ?? "").toUpperCase();
    const hasAudioField =
      kindHint === "VOICE" ||
      kindHint === "AUDIO" ||
      readOwn(item, "audio") != null ||
      typeof readOwn(item, "NU") === "string";
    if (!hasAudioField) continue;
    const rawId = String(readOwn(item, "mediaId") ?? readOwn(item, "id") ?? "").trim();
    if (!rawId || /^voices\//i.test(rawId)) continue;
    const mediaId = rawId.replace(/^media\//i, "");
    if (!mediaId || seen.has(mediaId)) continue;
    seen.add(mediaId);
    const wfRaw = readOwn(item, "workflowId");
    const wfId = typeof wfRaw === "string" && wfRaw.trim() ? wfRaw.trim() : null;
    const rawTitle = readOwn(item, "title") ?? readOwn(item, "displayName") ?? readOwn(item, "name");
    const rawPrompt = readOwn(item, "description") ?? readOwn(item, "prompt") ?? readOwn(item, "f7");
    const rawUrl = readOwn(item, "NU") ?? readOwn(item, "url");
    const rawCreated = readOwn(item, "rm") ?? readOwn(item, "createdAt") ?? readOwn(item, "createTime");
    out.push({
      id: mediaId,
      name:
        (typeof rawTitle === "string" && rawTitle.trim()) ||
        lookupTitle(wfId, mediaId) ||
        "Custom voice",
      mediaId,
      workflowId: wfId,
      prompt: typeof rawPrompt === "string" && rawPrompt.trim() ? rawPrompt.trim() : null,
      url:
        typeof rawUrl === "string" && /^https?:\/\//i.test(rawUrl.trim())
          ? rawUrl.trim()
          : null,
      createdAt:
        rawCreated instanceof Date
          ? rawCreated.toISOString()
          : typeof rawCreated === "string" && rawCreated.trim()
            ? rawCreated.trim()
            : null,
    });
  }

  return out;
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

/** Returns true when `fn` carries an Angular signal symbol. */
function isAngularSignal(fn: Function): boolean {
  return Object.getOwnPropertySymbols(fn).length > 0;
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
    clearProjectStore();
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
    getCustomVoices: () => readCustomVoices(store),
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
  runtimeState.store = handle;
}

/** Resolves the store class constructor for the active verified build. */
function verifiedStoreLayout(): { format: ProjectStoreFormat; storeClass: Function } | null {
  const format = activeProjectStoreFormat();
  if (!format) return null;
  const frontEnd = readOwn(window, "default_AiSandboxAngularFrontend");
  const storeClass = readOwn(frontEnd, format.storeClass);
  return typeof storeClass === "function" ? { format, storeClass } : null;
}

/** Collects live `ProjectStore` candidates from one Angular `LView` array. */
export function findProjectStoreInView(
  view: unknown,
  projectId: string,
  seen = new Set<object>(),
): ProjectStore[] {
  if (!Array.isArray(view)) return [];
  const layout = verifiedStoreLayout();
  if (!layout) return [];
  const { format, storeClass } = layout;
  const matches: ProjectStore[] = [];
  const consider = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (!(value instanceof storeClass)) return;
    const candidate: ProjectStore = { projectId, service: value, format };
    if (isCurrent(candidate)) matches.push(candidate);
  };

  for (const slot of view) {
    consider(slot);
    if (!slot || typeof slot !== "object" || slot instanceof Node) continue;
    for (const key of format.componentSlots) {
      consider(Object.getOwnPropertyDescriptor(slot, key)?.value);
    }
  }
  return matches;
}

/** Reports whether the current runtime has a bound and ready store for `projectId`. */
export function projectStoreStatus(projectId: string): ProjectStoreStatus {
  const build = readBuildLabel();
  if (!activeProjectStoreFormat()) {
    clearProjectStore();
    return { ok: false, error: "unsupported_front_end", build };
  }
  if (projectInRoute() !== projectId) return { ok: false, error: "project_changed" };
  const store = currentProjectStore(projectId);
  if (!store) return { ok: false, error: "collection_store_not_bound" };
  if (isProjectStorePending(store)) {
    return { ok: false, bound: true, error: "store_loading" };
  }
  if (!readProjectStore(store)) {
    return { ok: false, error: "collection_store_not_bound" };
  }
  session ??= crypto.randomUUID();
  return { ok: true, bound: true, session };
}

/** Selects a single verified store. If several stores match, selects the only ready store. */
export function selectProjectStoreCandidate(candidates: ProjectStore[]): ProjectStore | undefined {
  if (candidates.length === 1) return candidates[0];
  const ready = candidates.filter((store) => Boolean(readProjectStore(store)));
  return ready.length === 1 ? ready[0] : undefined;
}

/** Binds one live verified store found in the Angular view registry. */
export function bindProjectStore(maps: unknown[], projectId: string): ProjectStoreStatus {
  const build = readBuildLabel();
  if (!activeProjectStoreFormat()) {
    clearProjectStore();
    return { ok: false, error: "unsupported_front_end", build };
  }
  if (projectInRoute() !== projectId) return { ok: false, error: "project_changed" };
  if (!verifiedStoreLayout()) {
    clearProjectStore();
    return { ok: false, error: "collection_store_not_bound" };
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
      ? { ok: false, error: "ambiguous_collection_store" }
      : { ok: false, error: "collection_store_not_bound" };
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
