// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Bind, validate, read, and mutate the active project store from verified build formats.

import { isNgLViewMap, readOwn } from "./angular";
import { delay } from "./dom";
import { activeProjectStoreFormat, readBuildLabel, withMutationAliases } from "./frontend_builds";
import type { ProjectStoreFormat } from "./frontend_builds";
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

/** Returns true when `val` is a plain JSPB sparse field map rather than a Closure message. */
function isSparsePivot(val: unknown): boolean {
  return (
    val !== null &&
    typeof val === "object" &&
    !Array.isArray(val) &&
    Object.getPrototypeOf(val) === Object.prototype &&
    toSerializedJspb(val) === null
  );
}

/** Reads a 1-based field from a dense or sparse serialized JSPB message or Closure instance. */
function protoField(rawMsg: unknown, fieldNumber: number): unknown {
  if (fieldNumber < 1 || !rawMsg || typeof rawMsg !== "object") return undefined;
  const msg = toSerializedJspb(rawMsg) ?? rawMsg;
  if (!Array.isArray(msg)) {
    return readOwn(msg, String(fieldNumber));
  }
  if (msg.length === 0) return undefined;
  const denseIdx = fieldNumber - 1;
  const lastIdx = msg.length - 1;
  const tail = msg[lastIdx];
  if (isSparsePivot(tail)) {
    if (denseIdx < lastIdx && msg[denseIdx] != null) {
      return msg[denseIdx];
    }
    return readOwn(tail, String(fieldNumber));
  }
  return denseIdx <= lastIdx ? msg[denseIdx] : undefined;
}

/** Extracts a serialized JSPB array from a Closure message instance or array. */
function toSerializedJspb(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  try {
    const toJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") {
      const res: unknown = toJson.call(value);
      if (Array.isArray(res)) return res;
    }
  } catch {
    // Fall through to internal array field inspection.
  }
  const qf = readOwn(value, "qf");
  return Array.isArray(qf) ? qf : null;
}

/** Trims a string value and returns null when empty or non-string. */
function trimmedStr(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return s ? s : null;
}

/** Strips `media/` or `workflows/` prefixes from a resource identifier. */
function stripResourcePrefix(raw: string): string {
  return raw.trim().replace(/^(?:media|workflows)\//i, "");
}

/** Converts a protobuf `Timestamp` `[seconds, nanos]` tuple into a `Date`. */
function parseProtoDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  const arr = toSerializedJspb(value);
  if (!arr) return undefined;
  const sec = Number(protoField(arr, 1) ?? 0);
  const nanos = Number(protoField(arr, 2) ?? 0);
  if (!Number.isFinite(sec) || sec <= 0) return undefined;
  const ms = sec * 1000 + (Number.isFinite(nanos) ? Math.floor(nanos / 1e6) : 0);
  return Number.isFinite(ms) ? new Date(ms) : undefined;
}

/** Extracts a workflow display title from an entry in the `lr` map. */
function readWorkflowTitle(entry: unknown): string | null {
  const direct = trimmedStr(entry);
  if (direct) return direct;
  if (!entry || typeof entry !== "object") return null;
  const jspb = toSerializedJspb(entry);
  if (jspb) {
    const meta = protoField(jspb, 4);
    const title = trimmedStr(protoField(meta, 1)) ?? trimmedStr(protoField(jspb, 2));
    if (title) return title;
  }
  const metaObj = readOwn(entry, "metadata");
  return (
    trimmedStr(readOwn(entry, "displayName")) ??
    trimmedStr(readOwn(entry, "title")) ??
    trimmedStr(readOwn(entry, "name")) ??
    trimmedStr(readOwn(metaObj, "displayName")) ??
    trimmedStr(readOwn(metaObj, "name"))
  );
}

/** Builds a lookup map of workflow/voice IDs to titles from `lr`. */
function indexWorkflowTitles(lrRaw: unknown): Map<string, string> {
  const titles = new Map<string, string>();
  const recordEntry = (rawKey: unknown, rawVal: unknown): void => {
    const title = readWorkflowTitle(rawVal);
    if (!title) return;
    const jspb = toSerializedJspb(rawVal);
    const idFromVal =
      trimmedStr(jspb ? protoField(jspb, 1) : undefined) ??
      trimmedStr(readOwn(rawVal, "id")) ??
      trimmedStr(readOwn(rawVal, "name"));
    for (const candidate of [trimmedStr(rawKey), idFromVal]) {
      if (!candidate) continue;
      titles.set(candidate, title);
      const clean = stripResourcePrefix(candidate);
      if (clean) titles.set(clean, title);
    }
  };

  if (lrRaw instanceof Map) {
    for (const [k, v] of lrRaw.entries()) recordEntry(k, v);
  } else if (Array.isArray(lrRaw)) {
    for (const v of lrRaw) recordEntry(undefined, v);
  } else if (lrRaw && typeof lrRaw === "object") {
    for (const [k, v] of Object.entries(lrRaw as Record<string, unknown>)) {
      recordEntry(k, v);
    }
  }
  return titles;
}

/** Reads the assigned voice reference string from a character tile when present. */
function readCharacterVoiceRef(tile: FlowTile): string | null {
  const entity = readOwn(tile, "Rc");
  const jspb = toSerializedJspb(entity);
  if (jspb) {
    const charInfo = protoField(protoField(jspb, 4), 3);
    const refs = protoField(charInfo, 2);
    if (Array.isArray(refs) && refs.length > 0) {
      const first = refs[0];
      const custom = trimmedStr(protoField(first, 1));
      if (custom) return stripResourcePrefix(custom);
      const preset = trimmedStr(protoField(first, 2));
      if (preset) return preset;
    }
  }
  const direct =
    trimmedStr(tile.voiceId) ??
    trimmedStr(tile.Vo) ??
    trimmedStr(tile.voice);
  return direct ? stripResourcePrefix(direct) : null;
}

/** Merges custom voices from `cj` and titles from `lr` into a copy of `baseTiles`. */
function mergeProjectVoices(
  baseTiles: Map<string, FlowTile>,
  rawData: unknown,
): Map<string, FlowTile> {
  if (!rawData || typeof rawData !== "object") return baseTiles;
  const cjRaw = readOwn(rawData, "cj");
  const lrRaw = readOwn(rawData, "lr");
  if (!cjRaw && !lrRaw) return baseTiles;

  const lrTitles = indexWorkflowTitles(lrRaw);
  const entries: Array<[unknown, unknown]> = [];
  if (cjRaw instanceof Map) {
    for (const pair of cjRaw.entries()) entries.push(pair);
  } else if (Array.isArray(cjRaw)) {
    for (const item of cjRaw) entries.push([undefined, item]);
  } else if (cjRaw && typeof cjRaw === "object") {
    for (const pair of Object.entries(cjRaw as Record<string, unknown>)) {
      entries.push(pair);
    }
  }
  if (entries.length === 0) return baseTiles;

  const merged = new Map<string, FlowTile>(baseTiles);
  const existingWorkflowIds = new Set<string>();
  for (const tile of merged.values()) {
    const wf = trimmedStr(tile.workflowId);
    if (wf) existingWorkflowIds.add(stripResourcePrefix(wf));
    const pm = trimmedStr(tile.primaryMediaId);
    if (pm) existingWorkflowIds.add(stripResourcePrefix(pm));
  }

  const voiceByRef = new Map<string, { mediaId: string; title: string }>();

  for (const [rawKey, mediaVal] of entries) {
    if (!mediaVal || typeof mediaVal !== "object") continue;
    const jspb = toSerializedJspb(mediaVal);
    let mediaId: string | null = null;
    let workflowId: string | null = null;
    let title: string | null = null;
    let promptText: string | null = null;
    let inlineUrl: string | null = null;
    let createdAt: Date | undefined;

    if (jspb) {
      const audioBranch = protoField(jspb, 11);
      if (!audioBranch || typeof audioBranch !== "object") continue;
      const rawId = trimmedStr(protoField(jspb, 1)) ?? trimmedStr(rawKey);
      if (!rawId || /^voices\//i.test(rawId)) continue;
      const audioMeta = protoField(audioBranch, 1);
      if (protoField(audioMeta, 3) === true) continue;

      mediaId = stripResourcePrefix(rawId);
      const rawWf = trimmedStr(protoField(jspb, 3));
      workflowId = rawWf ? stripResourcePrefix(rawWf) : null;

      const mediaMeta = protoField(jspb, 6);
      createdAt = parseProtoDate(protoField(mediaMeta, 1));
      const labels = protoField(audioMeta, 12);
      const firstLabel = Array.isArray(labels) && labels.length > 0 ? labels[0] : undefined;
      title =
        (rawWf ? lrTitles.get(rawWf) : undefined) ??
        (workflowId ? lrTitles.get(workflowId) : undefined) ??
        lrTitles.get(rawId) ??
        lrTitles.get(mediaId) ??
        trimmedStr(protoField(mediaMeta, 2)) ??
        trimmedStr(protoField(firstLabel, 2)) ??
        trimmedStr(protoField(firstLabel, 1)) ??
        trimmedStr(protoField(audioMeta, 5)) ??
        "Custom voice";
      promptText =
        trimmedStr(protoField(audioMeta, 8)) ??
        trimmedStr(protoField(audioMeta, 2)) ??
        trimmedStr(protoField(audioMeta, 7));
      inlineUrl =
        trimmedStr(protoField(audioMeta, 4)) ??
        trimmedStr(protoField(audioMeta, 6));
    } else {
      const rawType = String(readOwn(mediaVal, "type") ?? readOwn(mediaVal, "kind") ?? "").toUpperCase();
      const rawMime = String(readOwn(mediaVal, "mimeType") ?? "").toLowerCase();
      const hasAudioShape =
        rawType === "VOICE" ||
        rawType === "AUDIO" ||
        rawMime.startsWith("audio/") ||
        readOwn(mediaVal, "audio") != null ||
        readOwn(mediaVal, "voice") != null ||
        (rawType === "" &&
          readOwn(mediaVal, "image") == null &&
          readOwn(mediaVal, "video") == null);
      if (!hasAudioShape) continue;
      if (readOwn(mediaVal, "isPreset") === true || readOwn(mediaVal, "Rv") === true) continue;
      const rawId =
        trimmedStr(readOwn(mediaVal, "id")) ??
        trimmedStr(readOwn(mediaVal, "mediaId")) ??
        trimmedStr( readOwn(mediaVal, "name")) ??
        trimmedStr(rawKey);
      if (!rawId || /^voices\//i.test(rawId)) continue;
      mediaId = stripResourcePrefix(rawId);
      const rawWf = trimmedStr(readOwn(mediaVal, "workflowId"));
      workflowId = rawWf ? stripResourcePrefix(rawWf) : null;
      title =
        trimmedStr(readOwn(mediaVal, "displayName")) ??
        trimmedStr(readOwn(mediaVal, "title")) ??
        (rawWf ? lrTitles.get(rawWf) : undefined) ??
        (workflowId ? lrTitles.get(workflowId) : undefined) ??
        lrTitles.get(rawId) ??
        lrTitles.get(mediaId) ??
        trimmedStr(readOwn(mediaVal, "name")) ??
        "Custom voice";
      promptText =
        trimmedStr(readOwn(mediaVal, "prompt")) ??
        trimmedStr(readOwn(mediaVal, "description"));
      inlineUrl =
        trimmedStr(readOwn(mediaVal, "url")) ??
        trimmedStr(readOwn(mediaVal, "kc")) ??
        trimmedStr(readOwn(mediaVal, "fifeUrl"));
      const rawDate = readOwn(mediaVal, "lc") ?? readOwn(mediaVal, "hc");
      if (rawDate instanceof Date) createdAt = rawDate;
    }

    if (!mediaId) continue;
    const resolvedTitle = title || "Custom voice";
    voiceByRef.set(mediaId, { mediaId, title: resolvedTitle });
    if (workflowId) {
      voiceByRef.set(workflowId, { mediaId, title: resolvedTitle });
    }

    if (
      merged.has(mediaId) ||
      existingWorkflowIds.has(mediaId) ||
      (workflowId !== null && (merged.has(workflowId) || existingWorkflowIds.has(workflowId)))
    ) {
      continue;
    }

    const synthesized: FlowTile = {
      id: mediaId,
      workflowId: workflowId ?? mediaId,
      primaryMediaId: mediaId,
      displayName: resolvedTitle,
      type: "VOICE",
      ...(inlineUrl ? { kc: inlineUrl, url: inlineUrl } : {}),
      ...(promptText ? { prompt: promptText } : {}),
      ...(createdAt ? { hc: createdAt } : {}),
    };
    merged.set(mediaId, synthesized);
  }

  if (voiceByRef.size > 0) {
    for (const [id, tile] of merged.entries()) {
      if (String(tile?.type ?? "").toUpperCase() !== "CHARACTER") continue;
      const ref = readCharacterVoiceRef(tile);
      if (!ref) continue;
      const hit = voiceByRef.get(ref);
      if (!hit) continue;
      merged.set(id, {
        ...tile,
        voiceMediaId: hit.mediaId,
        ...(tile.voiceName == null ? { voiceName: hit.title } : {}),
      });
    }
  }

  return merged;
}

/** Reads the cached rows for the active project when the query settles. */
export function readProjectStore(store: ProjectStore): Map<string, FlowTile> | null {
  if (!isCurrent(store) || isProjectStorePending(store)) return null;
  const query = projectQuery(store);
  const rawQueryData = query?.state.data;
  if (query) {
    const cached = tileMap(rawQueryData, store.format.rows);
    if (cached) return mergeProjectVoices(cached, rawQueryData);
  }
  const signalQuery = readOwn(store.service, store.format.tileQuery);
  if (!signalQuery || typeof signalQuery !== "object" || !("data" in signalQuery)) return null;
  const readData = readOwn(signalQuery, "data");
  const signalData: unknown = typeof readData === "function" ? readData.call(signalQuery) : readData;
  const indexed = indexTileRows(signalData) ?? tileMap(signalData, store.format.rows);
  if (!indexed) return null;
  return mergeProjectVoices(indexed, rawQueryData ?? signalData);
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
