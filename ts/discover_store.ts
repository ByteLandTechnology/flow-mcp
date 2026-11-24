// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Discover the Angular Ivy project store service and bind handles in module state.

import {
  isNgLViewMap,
  readOwn,
  resolveLView,
  withLViewMapCapture,
} from "./angular";
import { delay, hoverProbe } from "./dom";
import { withMutationAliases } from "./frontend_compatibility";
import { clearStore, runtimeState } from "./state";
import {
  findMethodByMarker,
  hasMethodString,
  hasPendingProjectTilesQuery,
  isInspectableObject,
  isStoreDestroyed,
  readOwnData,
  resolveTileArrayFromUO,
  resolveTileMapFrom,
} from "./store_shape";
import type {
  DiscoverStoreResult,
  FlowStoreService,
  FlowTile,
  MutationErrorStream,
  MutationQueueObj,
  NgLView,
} from "./types";

export { isStoreDestroyed } from "./store_shape";

/** Returns the async mutate function of a TanStack mutation result (`oe`, `re` or `mutateAsync` by Flow build), or null. */
function mutateAsyncOf(
  obj: unknown,
): ((payload: Record<string, unknown>) => Promise<unknown>) | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  const keys = Object.keys(rec);
  const bind = (fn: unknown) => (payload: Record<string, unknown>) =>
    Promise.resolve((fn as (p: unknown) => unknown).call(rec, payload));
  if (keys.includes("mutate") && keys.includes("reset")) {
    for (const k of keys) {
      if (k === "mutate" || k === "reset" || k.startsWith("is")) continue;
      const fn = readOwn(rec, k);
      if (
        typeof fn === "function" &&
        ((fn as () => unknown).length === 1 || (fn as () => unknown).length === 2)
      ) {
        return bind(fn);
      }
    }
  }
  for (const name of ["mutateAsync", "oe", "re"]) {
    const present = name === "mutateAsync" ? name in rec : keys.includes(name);
    if (!present) continue;
    const fn = readOwn(rec, name);
    if (typeof fn === "function") return bind(fn);
  }
  return null;
}

/** Escapes regex metacharacters in a property identifier. */
function escapeIdent(key: string): string {
  return key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Locates the tile TanStack mutator on `obj` (such as `this.ld` or `this.lc`) through `mutateAsyncOf`. */
function findAsyncMutator(
  obj: FlowStoreService | MutationQueueObj | null | undefined,
): MutationQueueObj | null {
  if (!isInspectableObject(obj)) return null;
  let ownKeys: string[];
  try {
    ownKeys = Object.getOwnPropertyNames(obj);
  } catch {
    return null;
  }
  const candidates: Array<[string, MutationQueueObj]> = [];
  for (const key of ownKeys) {
    if (key === "ha" || key === "_ap" || key === "_uo") continue;
    const val = readOwnData(obj, key);
    if (val && typeof val === "object" && mutateAsyncOf(val)) {
      candidates.push([key, val as MutationQueueObj]);
    }
  }
  if (candidates.length > 1) {
    const haObj = readOwnData(obj, "ha");
    const params =
      (isInspectableObject(haObj) ? readOwnData(haObj, "parameters") : undefined) ??
      readOwnData(obj, "parameters");
    if (isInspectableObject(params)) {
      for (const pk of Object.getOwnPropertyNames(params)) {
        const pfn = readOwnData(params, pk);
        if (typeof pfn !== "function") continue;
        let src = "";
        try {
          src = pfn.toString();
        } catch {
          continue;
        }
        for (const [key, mut] of candidates) {
          if (new RegExp(`\\.${escapeIdent(key)}\\b`).test(src)) {
            return mut;
          }
        }
      }
    }
  }
  for (const known of ["ld", "lc", "ka"]) {
    const val = readOwnData(obj, known) ?? (known in obj ? readOwn(obj, known) : undefined);
    if (val && typeof val === "object" && mutateAsyncOf(val)) {
      return val as MutationQueueObj;
    }
  }
  return candidates.length > 0 ? candidates[candidates.length - 1][1] : null;
}

/** Converts an arbitrary error value into an `Error` instance. */
function toMutationError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Reads the current error signal on a mutation queue when available. */
function readQueueError(mq: MutationQueueObj | null | undefined): unknown {
  if (!mq || typeof mq !== "object" || !("error" in mq)) return null;
  const errFn = readOwn(mq, "error");
  if (typeof errFn === "function") {
    try {
      return errFn.call(mq) ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Collects distinct subscribable error streams (`Da`, `oa`, `Ha`, `ua`, or own observables) on `mq`. */
function findErrorStreams(mq: MutationQueueObj | null | undefined): MutationErrorStream[] {
  if (!isInspectableObject(mq)) return [];
  const streams: MutationErrorStream[] = [];
  const seen = new Set<object>();
  const add = (cand: unknown): void => {
    if (!cand || typeof cand !== "object" || seen.has(cand) || !("subscribe" in cand)) return;
    const sub = readOwn(cand, "subscribe");
    if (typeof sub === "function") {
      seen.add(cand);
      streams.push(cand as MutationErrorStream);
    }
  };
  for (const key of ["Da", "oa", "Ha", "ua"]) {
    add(readOwnData(mq, key) ?? (key in mq ? readOwn(mq, key) : undefined));
  }
  for (const key of Object.getOwnPropertyNames(mq)) {
    add(readOwnData(mq, key));
  }
  return streams;
}

/** Clears a wedged `_.EO` queue entry and error signal caused by `payload` so `_.CO` keeps running. */
function unwedgeMutationQueue(
  mq: MutationQueueObj | null | undefined,
  payload: Record<string, unknown>,
  err: unknown,
): void {
  if (!isInspectableObject(mq)) return;
  for (const key of Object.getOwnPropertyNames(mq)) {
    const sig = readOwnData(mq, key) as
      | ((() => unknown) & { set?: (val: unknown) => void })
      | undefined;
    if (typeof sig !== "function" || typeof sig.set !== "function") continue;
    try {
      const cur = sig();
      if (err != null && cur === err) {
        sig.set(undefined);
        continue;
      }
      if (cur && typeof cur === "object" && Array.isArray((cur as { items?: unknown }).items)) {
        const items = (cur as { items: Array<{ mutation?: unknown }> }).items;
        const filtered = items.filter((it) => !it || it.mutation !== payload);
        if (filtered.length !== items.length) {
          const ctor = (cur as { constructor?: new (a: unknown[]) => unknown }).constructor;
          const next =
            typeof ctor === "function" && ctor !== Object
              ? new ctor(filtered)
              : { ...(cur as Record<string, unknown>), items: filtered };
          sig.set(next);
        }
      }
    } catch {
      // Ignore read-only signals.
    }
  }
}

/** Dispatches a store mutation payload and waits for queue completion. */
async function invokeMutation(
  queueObj: MutationQueueObj | FlowStoreService | null | undefined,
  payload: Record<string, unknown>,
  lcObj?: MutationQueueObj | null,
): Promise<unknown> {
  payload = withMutationAliases(payload);
  const mq = queueObj as MutationQueueObj | null | undefined;
  const lcAsync = mutateAsyncOf(lcObj);
  if (lcAsync) {
    const res = await lcAsync(payload);
    await delay(0);
    return res;
  }
  const qAsync = mutateAsyncOf(mq);
  if (qAsync) {
    const res = await qAsync(payload);
    await delay(0);
    return res;
  }
  const qMutateAsync = mq && "mutateAsync" in mq ? mq.mutateAsync : undefined;
  if (typeof qMutateAsync === "function") {
    const res = await qMutateAsync.call(mq, payload);
    await delay(0);
    return res;
  }
  const qKa = mq && "ka" in mq && typeof mq.ka === "function" ? mq.ka.bind(mq) : null;
  const hasPendingQueueItems = (): boolean => {
    if (!qKa || readQueueError(mq)) return false;
    try {
      const q = qKa();
      return Array.isArray(q?.items) && q.items.length > 0;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 200; i++) {
    if (!hasPendingQueueItems()) break;
    await delay(50);
  }
  if (typeof queueObj?.mutate === "function" && qKa) {
    const priorError = readQueueError(mq);
    if (priorError) {
      throw toMutationError(priorError);
    }
    let capturedError: unknown = null;
    const subs: Array<{ unsubscribe?: () => void }> = [];
    try {
      for (const obs of findErrorStreams(mq)) {
        if (typeof obs.subscribe !== "function") continue;
        const sub = obs.subscribe((ev) => {
          if (ev && typeof ev === "object" && (!ev.mutation || ev.mutation === payload) && ev.error) {
            capturedError = ev.error;
          }
        });
        if (sub) subs.push(sub);
      }
      queueObj.mutate(payload);
      for (let i = 0; i < 1200; i++) {
        await delay(25);
        const activeErr = capturedError ?? readQueueError(mq);
        if (activeErr) {
          unwedgeMutationQueue(mq, payload, activeErr);
          throw toMutationError(activeErr);
        }
        const snapshot = qKa();
        const items = snapshot?.items;
        const stillQueued =
          Array.isArray(items) &&
          items.some((it) => it && it.mutation === payload);
        if (!stillQueued) {
          const settledErr = capturedError ?? readQueueError(mq);
          if (settledErr) {
            unwedgeMutationQueue(mq, payload, settledErr);
            throw toMutationError(settledErr);
          }
          await delay(0);
          return undefined;
        }
      }
      const timeoutErr = capturedError ?? readQueueError(mq);
      if (timeoutErr) {
        unwedgeMutationQueue(mq, payload, timeoutErr);
        throw toMutationError(timeoutErr);
      }
      throw new Error("mutation_timeout");
    } finally {
      for (const sub of subs) {
        try {
          sub.unsubscribe?.();
        } catch {
          // Ignore unsubscribe error.
        }
      }
    }
  }
  if (typeof queueObj?.mutate === "function") {
    const res = await queueObj.mutate(payload);
    await delay(0);
    return res;
  }
  throw new Error("store_mutate_missing");
}

/** Resolves a callable mutator function from an `lService` candidate. */
function resolveMutatorFrom(
  svc: FlowStoreService | null,
  projectId: string | null,
): ((payload: Record<string, unknown>) => Promise<unknown>) | null {
  if (!svc || typeof svc !== "object") return null;
  const apMutator = findAsyncMutator(svc._ap);
  const directLc = apMutator || findAsyncMutator(svc);
  const haInner = svc.ha?.ha as MutationQueueObj | null | undefined;
  if (haInner && typeof haInner.mutate === "function") {
    const haLc = findAsyncMutator(svc.ha) || directLc;
    return (payload) => invokeMutation(haInner, payload, haLc);
  }
  if (svc.ha && typeof svc.ha.mutate === "function") {
    return (payload) => invokeMutation(svc.ha, payload, findAsyncMutator(svc.ha) || directLc);
  }
  if (directLc && mutateAsyncOf(directLc)) {
    return (payload) => invokeMutation(svc, payload, directLc);
  }
  if (typeof svc.mutate === "function") {
    return (payload) => invokeMutation(svc, payload, directLc);
  }
  for (const k of Object.keys(svc)) {
    const child = readOwnData(svc, k);
    if (child && typeof child === "object") {
      const childObj = child as FlowStoreService;
      const childLc = findAsyncMutator(childObj) || directLc;
      if (childLc && mutateAsyncOf(childLc)) {
        return (payload) => invokeMutation(childObj, payload, childLc);
      }
      if ("mutate" in childObj && typeof childObj.mutate === "function") {
        return (payload) => invokeMutation(childObj, payload, childLc);
      }
      if (isInspectableObject(childObj)) {
        for (const ck of Object.keys(childObj)) {
          const sub = readOwnData(childObj, ck) as MutationQueueObj | undefined;
          if (sub && typeof sub === "object" && "mutate" in sub && typeof sub.mutate === "function") {
            return (payload) => invokeMutation(sub, payload, childLc);
          }
        }
      }
    }
  }
  const dispatcher =
    findMethodByMarker(svc, "batch_move_to_collection") ||
    findMethodByMarker(svc, "set_display_name");
  if (dispatcher) {
    return (payload) => Promise.resolve(dispatcher(projectId, payload));
  }
  return null;
}

/** Returns true while bound store queries are ready and not pending initial load. */
function isStoreDataReady(svc: FlowStoreService | null): boolean {
  if (!svc || isStoreDestroyed(svc)) return false;
  const routeMatch = /\/project\/([^/?#]+)/.exec(location.pathname || "");
  const activeProjectId = runtimeState.projectId || (routeMatch ? routeMatch[1] : null);
  if (hasPendingProjectTilesQuery(svc, activeProjectId)) {
    return false;
  }
  if (svc._uo) {
    const haKa = svc.ha?.ka;
    const m = typeof haKa === "function" ? haKa.call(svc.ha) : null;
    if (!(m instanceof Map)) return false;
  }
  return true;
}

/** Checks whether `v` is the primary `lService` facade. */
function isLService(v: unknown): boolean {
  if (!v || typeof v !== "object" || v instanceof Node) return false;
  const svc = v as FlowStoreService;
  if (
    "RK" in svc &&
    typeof svc.RK === "function" &&
    typeof svc.ZA === "function" &&
    typeof svc.ha?.ka === "function"
  ) {
    return !isStoreDestroyed(svc);
  }
  if (
    (hasMethodString(svc, "create_collection") ||
      hasMethodString(svc, "PROJECT_TILES") ||
      hasMethodString(readOwnData(svc, "na"), "PROJECT_TILES")) &&
    hasMethodString(svc, "set_display_name") &&
    resolveTileMapFrom(svc) instanceof Map
  ) {
    return !isStoreDestroyed(svc);
  }
  return false;
}

/** Checks whether `v` is the `_ap` signal-store variant. */
function isAPService(v: unknown): v is FlowStoreService {
  if (!v || typeof v !== "object" || v instanceof Node) {
    return false;
  }
  const svc = v as FlowStoreService;
  if (!("ka" in svc) || !("ha" in svc)) {
    return false;
  }
  if (typeof svc.ka !== "function" || typeof svc.ha?.mutate !== "function") {
    return false;
  }
  if (isStoreDestroyed(svc)) {
    return false;
  }
  try {
    return svc.ka() instanceof Map;
  } catch {
    return false;
  }
}

/** Checks whether `v` is the `_uo` query-cache service variant. */
function isUOService(v: unknown): v is FlowStoreService {
  if (!v || typeof v !== "object" || v instanceof Node) return false;
  const svc = v as FlowStoreService;
  if (
    typeof svc.PG !== "function" ||
    typeof svc.queryKey !== "function" ||
    typeof svc.ob?.ha !== "function"
  ) {
    return false;
  }
  return (
    hasMethodString(svc, "create_collection") &&
    hasMethodString(svc, "PROJECT_TILES")
  );
}

/** Scans the DOM, Ivy contexts, and transient Map activity to bind the project store. */
export async function discoverStore(): Promise<DiscoverStoreResult> {
  const match = /\/project\/([^/?#]+)/.exec(location.pathname || "");
  const projectId = match ? match[1] : null;

  function installHandle(found: FlowStoreService): void {
    if (isAPService(found) && !isLService(found)) {
      const ap = found;
      const apKa = ap.ka as () => Map<string, FlowTile> | null | undefined;
      runtimeState.lService = {
        _ap: ap,
        ha: { ka: () => apKa.call(ap), ha: ap.ha },
      };
      runtimeState.projectId = projectId;
      runtimeState.routePath = location.pathname;
      runtimeState.store = {
        projectId,
        getTileMap: () => apKa.call(ap),
        isReady: () => isStoreDataReady(runtimeState.lService),
        mutate: (payload) => invokeMutation(ap.ha, payload, findAsyncMutator(ap)),
        rename: async (id, displayName) =>
          await invokeMutation(
            ap.ha,
            {
              type: "single_tile",
              Xc: id,
              Uc: id,
              Ve: { type: "set_display_name", displayName },
            },
            findAsyncMutator(ap),
          ),
      };
      return;
    }

    if (isUOService(found) && !isLService(found)) {
      const uo = found;
      const uoPg = uo.PG as (
        pid: string | null,
        payload: Record<string, unknown>,
      ) => Promise<unknown>;
      const getUoMap = (): Map<string, FlowTile> | null => {
        const arr = resolveTileArrayFromUO(uo, projectId);
        if (!arr) return null;
        const m = new Map<string, FlowTile>();
        for (const t of arr) {
          if (t && t.id != null) m.set(String(t.id), t);
        }
        return m;
      };
      runtimeState.lService = {
        _uo: uo,
        ha: { ka: getUoMap },
      };
      runtimeState.projectId = projectId;
      runtimeState.routePath = location.pathname;
      runtimeState.store = {
        projectId,
        getTileMap: getUoMap,
        isReady: () => isStoreDataReady(runtimeState.lService),
        mutate: (payload) =>
          uoPg.call(uo, projectId, withMutationAliases(payload)),
        rename: async (id, displayName) =>
          await uoPg.call(
            uo,
            projectId,
            withMutationAliases({
              type: "single_tile",
              Xc: id,
              Uc: id,
              Ve: { type: "set_display_name", displayName },
            }),
          ),
      };
      return;
    }

    runtimeState.lService = found;
    runtimeState.projectId = projectId;
    runtimeState.routePath = location.pathname;
    runtimeState.store = {
      projectId,
      getTileMap: () => resolveTileMapFrom(runtimeState.lService),
      isReady: () => isStoreDataReady(runtimeState.lService),
      mutate: (payload) => {
        const fn = resolveMutatorFrom(runtimeState.lService, projectId);
        if (!fn) throw new Error("store_mutate_missing");
        return fn(withMutationAliases(payload));
      },
      rename: async (id, displayName) => {
        const svc = runtimeState.lService;
        const fn = resolveMutatorFrom(svc, projectId);
        if (fn) {
          return await fn(
            withMutationAliases({
              type: "single_tile",
              Xc: id,
              Uc: id,
              Ve: { type: "set_display_name", displayName },
            }),
          );
        }
        if (svc && typeof svc.RK === "function") {
          return await svc.RK(id, displayName);
        }
        throw new Error("store_rename_missing");
      },
    };
  }

  if (
    runtimeState.projectId === projectId &&
    runtimeState.routePath === location.pathname &&
    runtimeState.lService &&
    !isStoreDestroyed(runtimeState.lService) &&
    !runtimeState.lService._uo &&
    resolveTileMapFrom(runtimeState.lService) instanceof Map
  ) {
    installHandle(runtimeState.lService._ap || runtimeState.lService);
    return { bound: true, newlyDiscovered: false };
  }

  clearStore();

  const findInLView = (lv: unknown): FlowStoreService | null => {
    if (!Array.isArray(lv)) return null;
    for (let i = 0; i < lv.length; i++) {
      if (isLService(lv[i])) return lv[i] as FlowStoreService;
    }
    return null;
  };

  const findAPInLView = (lv: unknown): FlowStoreService | null => {
    if (!Array.isArray(lv)) return null;
    for (let i = 0; i < lv.length; i++) {
      const cand = lv[i];
      if (isAPService(cand)) return cand;
      if (isInspectableObject(cand)) {
        const seenProps = new Set<string>();
        for (const prop of ["fh", "ha", "Ew", "la", "Xg", "Eu", "oa", "ka", ...Object.keys(cand)]) {
          if (seenProps.has(prop)) continue;
          seenProps.add(prop);
          const nested = readOwnData(cand, prop);
          if (isAPService(nested)) return nested;
        }
      }
    }
    return null;
  };

  const findUOInLView = (lv: unknown): FlowStoreService | null => {
    if (!Array.isArray(lv)) return null;
    for (let i = 0; i < lv.length; i++) {
      const cand = lv[i];
      if (isUOService(cand)) return cand;
      if (isInspectableObject(cand)) {
        for (const prop of ["ma", "ya", "Hoa", "oa", "ld", "wa", "Ua", "Vd"]) {
          const nested = readOwnData(cand, prop);
          if (isUOService(nested)) return nested;
        }
      }
    }
    return null;
  };

  const findAnyInLView = (lv: unknown): FlowStoreService | null =>
    findInLView(lv) || findAPInLView(lv) || findUOInLView(lv);

  const scanDomNgContexts = (
    matcher: (lv: unknown) => FlowStoreService | null = findInLView,
  ): FlowStoreService | null => {
    const matchWithParents = (el: Element): FlowStoreService | null => {
      let p: NgLView | null = resolveLView(el);
      for (let d = 0; d < 6 && Array.isArray(p); d++) {
        const hit = matcher(p);
        if (hit) return hit;
        p = Array.isArray(p[3]) ? p[3] : Array.isArray(p[15]) ? p[15] : null;
      }
      return null;
    };
    const roots = document.querySelectorAll(
      'flow-project-page, flow-project-shell, flow-editor-dispatcher, flow-editor-page, flow-character-edit-page, flow-character-edit-header, flow-character-page, flow-character-form, flow-character-preview-panel, flow-character-image-preview, flow-edit-character-footer, flow-character-header, flow-scene-builder, flow-grid-tile-container, aisandbox-root, button[aria-label="Settings trigger"], button[aria-label], [mattooltip], button.library-expand-button, app-root, main, [class*="project"], [class*="character"]',
    );
    for (const el of roots) {
      let cur: Element | null = el;
      let steps = 0;
      while (cur && steps < 12) {
        const hit = matchWithParents(cur);
        if (hit) return hit;
        cur = cur.parentElement;
        steps++;
      }
    }
    const allEls = document.querySelectorAll("*");
    const limit = Math.min(allEls.length, 600);
    for (let i = 0; i < limit; i++) {
      const lv = resolveLView(allEls[i]);
      if (lv) {
        const hit = matcher(lv);
        if (hit) return hit;
      }
    }
    return null;
  };

  const probeLViewMapHover = async (): Promise<void> => {
    if (runtimeState.ngLViewMap instanceof Map) return;
    await withLViewMapCapture(async () => {
      const all = Array.from(
        document.querySelectorAll(
          "[mattooltip], [cdkoverlayorigin], button[aria-label], flow-agent-mode-toggle-chip button, flow-prompt-box, flow-project-page, flow-scene-builder, flow-editor-page, flow-character-edit-page",
        ),
      );
      const visible = all.filter((el) => el.getClientRects().length > 0);
      const targets = (visible.length > 0 ? visible : all).slice(0, 12);
      await hoverProbe(targets, 30);
    });
  };

  let found: FlowStoreService | null =
    scanDomNgContexts(findInLView) ||
    scanDomNgContexts(findAPInLView) ||
    scanDomNgContexts(findUOInLView);
  if (found) {
    await probeLViewMapHover();
    installHandle(found);
    return { bound: true, newlyDiscovered: true };
  }

  const allSeenMaps = new Set<Map<unknown, unknown>>();

  const scanMaps = (maps: Set<Map<unknown, unknown>>): FlowStoreService | null => {
    for (const m of maps) {
      if (!(runtimeState.ngLViewMap instanceof Map) && isNgLViewMap(m)) {
        runtimeState.ngLViewMap = m;
      }
    }
    for (const matcher of [findInLView, findAPInLView, findUOInLView]) {
      for (const m of maps) {
        try {
          for (const v of m.values()) {
            const hit = matcher(v);
            if (hit) return hit;
          }
        } catch {
          // Ignore mutated maps during iteration.
        }
      }
    }
    return null;
  };

  const captureWithMapHook = async (
    runAsync: () => Promise<void>,
  ): Promise<FlowStoreService | null> => {
    const origSet = Map.prototype.set;
    const origGet = Map.prototype.get;
    const seenMaps = new Set<Map<unknown, unknown>>();
    const seenLViews: NgLView[] = [];
    let directFound: FlowStoreService | null = null;
    try {
      Map.prototype.set = function (
        this: Map<unknown, unknown>,
        k: unknown,
        v: unknown,
      ): Map<unknown, unknown> {
        seenMaps.add(this);
        allSeenMaps.add(this);
        if (typeof k === "number" && Array.isArray(v) && v[19] === k) {
          runtimeState.ngLViewMap = this as unknown as Map<number, NgLView>;
        }
        if (Array.isArray(v)) {
          seenLViews.push(v);
          if (!directFound) directFound = findAnyInLView(v);
        }
        return origSet.call(this, k, v);
      };
      Map.prototype.get = function (
        this: Map<unknown, unknown>,
        k: unknown,
      ): unknown {
        seenMaps.add(this);
        allSeenMaps.add(this);
        const v: unknown = origGet.call(this, k);
        if (
          !(runtimeState.ngLViewMap instanceof Map) &&
          typeof k === "number" &&
          Array.isArray(v) &&
          v[19] === k
        ) {
          runtimeState.ngLViewMap = this as unknown as Map<number, NgLView>;
        }
        return v;
      };
      await runAsync();
    } finally {
      Map.prototype.set = origSet;
      Map.prototype.get = origGet;
    }
    if (directFound) return directFound;
    for (const matcher of [findInLView, findAPInLView, findUOInLView]) {
      for (const lv of seenLViews) {
        const hit = matcher(lv);
        if (hit) return hit;
      }
    }
    return scanMaps(seenMaps);
  };

  const probeSelectors = [
    "flow-project-page", "flow-project-shell", "flow-editor-dispatcher",
    "flow-editor-page", "flow-character-edit-page", "flow-character-edit-header",
    "flow-character-form", "flow-character-preview-panel", "flow-character-image-preview",
    "flow-edit-character-footer", "flow-character-page", "flow-character-header",
    "flow-scene-builder", "flow-grid-tile-container",
    'button[aria-label="Settings trigger"]', "[mattooltip]", "button[aria-label]",
    "aisandbox-root", "header", "main",
  ];
  for (const sel of probeSelectors) {
    if (found) break;
    const targets = document.querySelectorAll(sel);
    if (targets.length === 0) continue;
    found = await captureWithMapHook(async () => {
      await hoverProbe(Array.from(targets).slice(0, 6), 25);
    });
  }

  if (!found) {
    const scroller = document.querySelector(
      ".page-container, cdk-virtual-scroll-viewport",
    );
    if (scroller) {
      const prev = scroller.scrollTop;
      found = await captureWithMapHook(async () => {
        scroller.scrollTop = Math.min(scroller.scrollHeight, prev + 200);
        scroller.dispatchEvent(new Event("scroll"));
        await delay(50);
      });
      if (!found) {
        found = await captureWithMapHook(async () => {
          scroller.scrollTop = prev;
          scroller.dispatchEvent(new Event("scroll"));
          await delay(80);
        });
      } else {
        scroller.scrollTop = prev;
      }
    }
  }

  if (!found) found = scanMaps(allSeenMaps);

  if (!found) {
    const pm = document.querySelector(
      '.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"], textarea:not([aria-label="Character personality"])',
    );
    if (pm instanceof HTMLElement) {
      found = await captureWithMapHook(async () => {
        pm.focus();
        pm.click();
        await delay(60);
      });
      if (!found) found = scanMaps(allSeenMaps);
    }
  }

  if (!found) {
    const charInputs = document.querySelectorAll(
      'input[aria-label="Character name"], textarea[aria-label="Character personality"]',
    );
    if (charInputs.length > 0) {
      found = await captureWithMapHook(async () => {
        for (const inp of charInputs) {
          inp.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
        }
        await delay(60);
      });
      if (!found) found = scanMaps(allSeenMaps);
    }
  }

  if (!found) {
    const findPanelToggle = (): HTMLElement | null => {
      const btn = Array.from(
        document.querySelectorAll('button, [role="button"]'),
      ).find(
        (b) =>
          b instanceof HTMLElement &&
          b.getClientRects().length > 0 &&
          /\b(?:collapse|expand)\b/i.test(
            (b.innerText || b.getAttribute("aria-label") || "").trim(),
          ),
      );
      return btn instanceof HTMLElement ? btn : null;
    };
    const toggleBtn = findPanelToggle();
    if (toggleBtn) {
      found = await captureWithMapHook(async () => {
        toggleBtn.click();
        await delay(80);
      });
      const toggleAgain = findPanelToggle();
      if (toggleAgain) {
        const hit2 = await captureWithMapHook(async () => {
          toggleAgain.click();
          await delay(80);
        });
        if (!found) found = hit2;
      }
      if (!found) found = scanMaps(allSeenMaps);
    }
  }

  if (found) {
    await probeLViewMapHover();
    installHandle(found);
    return { bound: true, newlyDiscovered: true };
  }
  return { bound: false, newlyDiscovered: false };
}
