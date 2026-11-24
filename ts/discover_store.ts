// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Discover the Angular Ivy project store service and bind handles in module state.

import { isNgLViewMap, readOwn, resolveLView, withLViewMapCapture } from "./angular";
import { delay, hoverProbe } from "./dom";
import { withMutationAliases } from "./frontend_compatibility";
import { clearStore, runtimeState } from "./state";
import {
  discoverProjectStoreCandidates,
  discoverQueryTileServiceInLView,
  isComponentDestroyed,
  readRowsFromQueryTileService,
  safeFnSource,
} from "./store_shapes";
import type {
  DiscoverStoreResult,
  FlowStoreService,
  FlowTile,
  MutationQueueObj,
  NgLView,
} from "./types";

/** Checks whether a candidate object defines a method whose source contains `marker`. */
function findMethodByMarker(
  obj: unknown,
  marker: string,
): ((...args: unknown[]) => unknown) | null {
  if (!obj || typeof obj !== "object") return null;
  let cur: object | null = obj;
  for (let depth = 0; cur && cur !== Object.prototype && depth < 3; depth++) {
    for (const k of Object.getOwnPropertyNames(cur)) {
      if (k === "constructor") continue;
      const fn = readOwn(obj, k);
      if (typeof fn === "function" && safeFnSource(fn).includes(marker)) {
        return fn.bind(obj) as (...args: unknown[]) => unknown;
      }
    }
    cur = Object.getPrototypeOf(cur);
  }
  return null;
}

/** Returns true when `obj` has a method containing `marker`. */
function hasMethodString(obj: unknown, marker: string): boolean {
  return Boolean(findMethodByMarker(obj, marker));
}

/** Checks whether `m` looks like a project tile map. */
function isTileMap(m: unknown): m is Map<string, FlowTile> {
  if (!(m instanceof Map)) return false;
  if (m.size === 0) return true;
  for (const v of m.values()) {
    return Boolean(v && typeof v === "object" && ("id" in v || "type" in v));
  }
  return false;
}

/** Extracts the tile `Map` from a candidate Angular store service. */
function resolveTileMapFrom(svc: FlowStoreService | null): Map<string, FlowTile> | null {
  if (!svc || typeof svc !== "object") return null;
  const apKa = svc._ap?.ka;
  const svcKa = svc.ka;
  const haKa = svc.ha?.ka;
  for (const getter of [
    typeof apKa === "function" ? () => apKa.call(svc._ap) : null,
    typeof svcKa === "function" ? () => svcKa.call(svc) : null,
    typeof haKa === "function" ? () => haKa.call(svc.ha) : null,
  ]) {
    if (!getter) continue;
    try {
      const m = getter();
      if (m instanceof Map) return m;
    } catch {
      // Try next getter.
    }
  }
  const queue: object[] = [svc];
  const seen = new Set<object>();
  let emptyMapFallback: Map<string, FlowTile> | null = null;
  while (queue.length && seen.size < 40) {
    const cur = queue.shift();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    for (const k of Object.keys(cur)) {
      const val = readOwn(cur, k);
      if (isTileMap(val)) {
        if (val.size > 0) return val;
        emptyMapFallback = emptyMapFallback || val;
      } else if (val && typeof val === "object" && seen.size < 40) {
        let proto = Object.getPrototypeOf(val) as object | null;
        while (proto && proto !== Object.prototype) {
          for (const mk of Object.getOwnPropertyNames(proto)) {
            if (mk === "constructor") continue;
            try {
              const fn = readOwn(val, mk);
              if (typeof fn === "function" && fn.length === 0) {
                const res = fn.call(val);
                if (isTileMap(res)) {
                  if (res.size > 0) return res;
                  emptyMapFallback = emptyMapFallback || res;
                }
              }
            } catch {
              // Ignore unsafe getters.
            }
          }
          proto = Object.getPrototypeOf(proto) as object | null;
        }
        queue.push(val);
      }
    }
  }
  return emptyMapFallback;
}

/** Returns the async mutate function of a TanStack mutation result, or null. */
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
      const fn = readOwn(rec, k);
      if (k !== "mutate" && k !== "reset" && typeof fn === "function" && (fn as () => unknown).length === 2) {
        return bind(fn);
      }
    }
  }
  for (const name of ["mutateAsync", "oe", "re"]) {
    const fn = readOwn(rec, name);
    if (keys.includes(name) && typeof fn === "function") return bind(fn);
  }
  return null;
}

/** Dispatches a store mutation payload and waits for queue completion. */
async function invokeMutation(
  queueObj: MutationQueueObj | FlowStoreService | null | undefined,
  payload: Record<string, unknown>,
  lcObj?: MutationQueueObj | null,
): Promise<unknown> {
  payload = withMutationAliases(payload);
  const mq = queueObj as MutationQueueObj | null | undefined;
  const qKa = typeof mq?.ka === "function" ? mq.ka.bind(mq) : null;
  for (let i = 0; i < 200; i++) {
    if (!qKa) break;
    try {
      const q = qKa();
      if (!Array.isArray(q?.items) || q.items.length === 0) break;
    } catch {
      break;
    }
    await delay(50);
  }
  for (const candidate of [mutateAsyncOf(lcObj), mutateAsyncOf(mq)]) {
    if (candidate) {
      const res = await candidate(payload);
      await delay(0);
      return res;
    }
  }
  if (typeof mq?.mutateAsync === "function") {
    const res = await mq.mutateAsync.call(mq, payload);
    await delay(0);
    return res;
  }
  if (typeof queueObj?.mutate === "function" && qKa) {
    let capturedError: unknown = null;
    let sub: { unsubscribe?: () => void } | null = null;
    try {
      const obs = mq?.Ha || mq?.ua;
      if (obs && typeof obs.subscribe === "function") {
        sub = obs.subscribe((ev) => {
          if (ev && (!ev.mutation || ev.mutation === payload) && ev.error) {
            capturedError = ev.error;
          }
        });
      }
      queueObj.mutate(payload);
      for (let i = 0; i < 1200; i++) {
        await delay(25);
        if (capturedError) break;
        const items = qKa()?.items;
        const stillQueued = Array.isArray(items) && items.some((it) => it && it.mutation === payload);
        if (!stillQueued) {
          let errState: unknown = null;
          if (typeof mq?.error === "function") {
            try {
              errState = mq.error();
            } catch {
              errState = null;
            }
          }
          if (errState) {
            throw errState instanceof Error ? errState : new Error(String(errState));
          }
          await delay(0);
          return undefined;
        }
      }
      if (capturedError) {
        throw capturedError instanceof Error ? capturedError : new Error(String(capturedError));
      }
      throw new Error("mutation_timeout");
    } finally {
      try {
        sub?.unsubscribe?.();
      } catch {
        // Ignore unsubscribe error.
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
  const lcFallback = (obj: FlowStoreService): MutationQueueObj | null => {
    if (mutateAsyncOf(obj.lc)) return obj.lc ?? null;
    if (typeof obj.ka === "object" && obj.ka && mutateAsyncOf(obj.ka)) return obj.ka;
    return null;
  };
  const haInner = svc.ha?.ha as MutationQueueObj | null | undefined;
  if (haInner && typeof haInner.mutate === "function") {
    const haLc =
      svc.ha && mutateAsyncOf(svc.ha.lc)
        ? (svc.ha.lc ?? null)
        : typeof svc.ka === "object" && svc.ka && mutateAsyncOf(svc.ka)
          ? svc.ka
          : null;
    return (payload) => invokeMutation(haInner, payload, haLc);
  }
  if (svc.ha && typeof svc.ha.mutate === "function") {
    return (payload) => invokeMutation(svc.ha, payload, lcFallback(svc));
  }
  const directLc = lcFallback(svc);
  if (directLc && mutateAsyncOf(directLc)) return (payload) => invokeMutation(svc, payload, directLc);
  if (typeof svc.mutate === "function") return (payload) => invokeMutation(svc, payload, directLc);
  for (const k of Object.keys(svc)) {
    const child = readOwn(svc, k);
    if (!child || typeof child !== "object") continue;
    const childObj = child as FlowStoreService;
    const childLc = childObj.lc || directLc || null;
    if (typeof childObj.mutate === "function") return (payload) => invokeMutation(childObj, payload, childLc);
    for (const ck of Object.keys(childObj)) {
      const sub = readOwn(childObj, ck) as MutationQueueObj | undefined;
      if (sub && typeof sub.mutate === "function") return (payload) => invokeMutation(sub, payload, childLc);
    }
  }
  const dispatchers: Array<(...args: unknown[]) => unknown> = [];
  let cur: object | null = svc;
  for (let depth = 0; cur && cur !== Object.prototype && depth < 3; depth++) {
    for (const k of Object.getOwnPropertyNames(cur)) {
      if (k === "constructor") continue;
      const fn = readOwn(svc, k);
      const src = safeFnSource(fn);
      if (
        typeof fn === "function" &&
        src.includes("PROJECT_TILES") &&
        (src.includes("batch_move_to_collection") || src.includes("set_display_name"))
      ) {
        dispatchers.push(fn.bind(svc) as (...args: unknown[]) => unknown);
      }
    }
    cur = Object.getPrototypeOf(cur);
  }
  if (dispatchers.length === 1) {
    return (payload) => Promise.resolve(dispatchers[0](projectId, withMutationAliases(payload)));
  }
  return null;
}

/** Returns true when `svc` or its nested wrapper has been destroyed by Angular. */
function isDestroyed(svc: FlowStoreService | null | undefined): boolean {
  if (!svc || typeof svc !== "object") return true;
  if (svc._qt) return isComponentDestroyed(svc._qt.owner);
  if (svc._ap) return isComponentDestroyed(svc._ap);
  if (svc._uo) return isComponentDestroyed(svc._uo);
  return isComponentDestroyed(svc);
}

/** Returns true while bound store queries are ready and not pending initial load. */
function isStoreDataReady(svc: FlowStoreService | null): boolean {
  if (!svc || isDestroyed(svc)) return false;
  const ap = svc._ap || svc.ha || svc;
  const rc = readOwn(ap, "RC") as { isPending?: () => boolean } | undefined;
  if (typeof rc?.isPending === "function" && rc.isPending()) return false;
  if (svc._uo || svc._qt) {
    const haKa = svc.ha?.ka;
    if (!(typeof haKa === "function" && haKa.call(svc.ha) instanceof Map)) return false;
  }
  return true;
}

/** Checks whether `v` is the primary `lService` facade. */
function isLService(v: unknown): boolean {
  if (!v || typeof v !== "object" || isDestroyed(v as FlowStoreService)) return false;
  const svc = v as FlowStoreService;
  if (typeof svc.RK === "function" && typeof svc.ZA === "function" && typeof svc.ha?.ka === "function") {
    return true;
  }
  return (
    (hasMethodString(svc, "create_collection") ||
      hasMethodString(svc, "PROJECT_TILES") ||
      hasMethodString(svc.na, "PROJECT_TILES")) &&
    hasMethodString(svc, "set_display_name") &&
    resolveTileMapFrom(svc) instanceof Map
  );
}

/** Checks whether `v` is the `_ap` signal-store variant. */
function isAPService(v: unknown): v is FlowStoreService {
  if (!v || typeof v !== "object" || v instanceof Node || isDestroyed(v as FlowStoreService)) {
    return false;
  }
  const svc = v as FlowStoreService;
  if (typeof svc.ka !== "function" || typeof svc.ha?.mutate !== "function") return false;
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
  return (
    typeof svc.PG === "function" &&
    typeof svc.queryKey === "function" &&
    typeof svc.ob?.ha === "function" &&
    hasMethodString(svc, "create_collection") &&
    hasMethodString(svc, "PROJECT_TILES")
  );
}

/** Resolves cached tile rows from a `_uo` store service. */
function resolveTileArrayFromUO(uo: FlowStoreService, projectId: string | null): FlowTile[] | null {
  if (!uo || typeof uo !== "object" || typeof uo.ob?.ha !== "function") return null;
  try {
    const qk = typeof uo.queryKey === "function" ? uo.queryKey(projectId) : ["PROJECT_TILES", projectId];
    const data = uo.ob.ha(qk);
    if (data && Array.isArray(data.Cb)) return data.Cb;
  } catch {
    return null;
  }
  return null;
}

/** Builds the rename payload passed through `withMutationAliases`. */
function renamePayload(id: string, displayName: string): Record<string, unknown> {
  return { type: "single_tile", tileId: id, change: { type: "set_display_name", displayName } };
}

/** Route path of the most recent failed invasive DOM store probe. */
let lastInvasiveMissPath = "";
/** Timestamp (`performance.now()`) of the most recent failed invasive DOM store probe. */
let lastInvasiveMissAt = -Infinity;
/** Cooldown between invasive hover/scroll/focus store probes on the same route. */
const INVASIVE_PROBE_COOLDOWN_MS = 5_000;

/** Scans the DOM, Ivy contexts, and transient Map activity to bind the project store. */
export async function discoverStore(): Promise<DiscoverStoreResult> {
  const match = /\/project\/([^/?#]+)/.exec(location.pathname || "");
  const projectId = match ? match[1] : null;

  function installHandle(found: FlowStoreService): void {
    if (isAPService(found) && !isLService(found)) {
      const ap = found;
      const apKa = ap.ka as () => Map<string, FlowTile> | null | undefined;
      runtimeState.lService = { _ap: ap, ha: { ka: () => apKa.call(ap), ha: ap.ha } };
      runtimeState.projectId = projectId;
      runtimeState.routePath = location.pathname;
      runtimeState.store = {
        projectId,
        getTileMap: () => apKa.call(ap),
        isReady: () => isStoreDataReady(runtimeState.lService),
        mutate: (payload) => invokeMutation(ap.ha, payload, ap.lc),
        rename: async (id, displayName) => await invokeMutation(ap.ha, renamePayload(id, displayName), ap.lc),
      };
      return;
    }

    if (found._qt) {
      const qt = found._qt;
      const getQtMap = (): Map<string, FlowTile> | null =>
        readRowsFromQueryTileService(qt.tilesService, qt.queryClient, qt.rows, projectId);
      const dispatch = (payload: Record<string, unknown>): Promise<unknown> => {
        const fn = qt.dispatcher ? readOwn(qt.tilesService, qt.dispatcher) : undefined;
        if (typeof fn !== "function") throw new Error("store_mutate_missing");
        return Promise.resolve(fn.call(qt.tilesService, projectId, withMutationAliases(payload)));
      };
      runtimeState.lService = { _qt: qt, ha: { ka: getQtMap } };
      runtimeState.projectId = projectId;
      runtimeState.routePath = location.pathname;
      runtimeState.store = {
        projectId,
        getTileMap: getQtMap,
        isReady: () => isStoreDataReady(runtimeState.lService),
        mutate: dispatch,
        rename: async (id, displayName) => await dispatch(renamePayload(id, displayName)),
      };
      return;
    }

    if (isUOService(found) && !isLService(found)) {
      const uo = found;
      const uoPg = uo.PG as (pid: string | null, payload: Record<string, unknown>) => Promise<unknown>;
      const getUoMap = (): Map<string, FlowTile> | null => {
        const arr = resolveTileArrayFromUO(uo, projectId);
        if (!arr) return null;
        const m = new Map<string, FlowTile>();
        for (const t of arr) {
          if (t && t.id != null) m.set(String(t.id), t);
        }
        return m;
      };
      runtimeState.lService = { _uo: uo, ha: { ka: getUoMap } };
      runtimeState.projectId = projectId;
      runtimeState.routePath = location.pathname;
      runtimeState.store = {
        projectId,
        getTileMap: getUoMap,
        isReady: () => isStoreDataReady(runtimeState.lService),
        mutate: (payload) => uoPg.call(uo, projectId, withMutationAliases(payload)),
        rename: async (id, displayName) =>
          await uoPg.call(uo, projectId, withMutationAliases(renamePayload(id, displayName))),
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
        if (fn) return await fn(withMutationAliases(renamePayload(id, displayName)));
        if (svc && typeof svc.RK === "function") return await svc.RK(id, displayName);
        throw new Error("store_rename_missing");
      },
    };
  }

  if (
    runtimeState.projectId === projectId &&
    runtimeState.routePath === location.pathname &&
    runtimeState.lService &&
    !isDestroyed(runtimeState.lService) &&
    !runtimeState.lService._uo &&
    !runtimeState.lService._qt &&
    resolveTileMapFrom(runtimeState.lService) instanceof Map
  ) {
    installHandle(runtimeState.lService._ap || runtimeState.lService);
    return { bound: true, newlyDiscovered: false };
  }

  clearStore();

  const findInLView = (lv: unknown): FlowStoreService | null => {
    if (!Array.isArray(lv)) return null;
    for (const cand of lv) {
      if (isLService(cand)) return cand as FlowStoreService;
    }
    return null;
  };
  const findAPInLView = (lv: unknown): FlowStoreService | null => {
    if (!Array.isArray(lv)) return null;
    for (const cand of lv) {
      if (isAPService(cand)) return cand;
      if (cand && typeof cand === "object" && !(cand instanceof Node)) {
        for (const prop of ["Eu", "oa", "ka"]) {
          const nested = readOwn(cand, prop);
          if (isAPService(nested)) return nested;
        }
      }
    }
    return null;
  };
  const findUOInLView = (lv: unknown): FlowStoreService | null => {
    if (!Array.isArray(lv)) return null;
    for (const cand of lv) {
      if (isUOService(cand)) return cand;
      if (cand && typeof cand === "object" && !(cand instanceof Node)) {
        for (const prop of ["ma", "ya", "Hoa", "oa"]) {
          const nested = readOwn(cand, prop);
          if (isUOService(nested)) return nested;
        }
      }
    }
    return null;
  };
  const findQTInLView = (lv: unknown): FlowStoreService | null => {
    const hit = discoverQueryTileServiceInLView(lv, projectId);
    if (!hit) return null;
    return {
      _qt: hit,
      ha: { ka: () => readRowsFromQueryTileService(hit.tilesService, hit.queryClient, hit.rows, projectId) },
    };
  };

  const matchers = [findInLView, findAPInLView, findUOInLView, findQTInLView];
  const findAnyInLView = (lv: unknown): FlowStoreService | null => {
    for (const m of matchers) {
      const hit = m(lv);
      if (hit) return hit;
    }
    return null;
  };

  /** Verifies that structural store discovery is unambiguous across known Angular view maps. */
  const isAmbiguousAcrossMaps = (maps: Iterable<unknown>): boolean => {
    if (!projectId) return false;
    const outcome = discoverProjectStoreCandidates([...maps], projectId);
    return outcome.ambiguousInner || outcome.candidates.length > 1;
  };

  const scanDomNgContexts = (matcher: (lv: unknown) => FlowStoreService | null): FlowStoreService | null => {
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
      'flow-project-page, flow-project-shell, flow-character-edit-page, flow-character-edit-header, flow-character-page, flow-character-form, flow-character-preview-panel, flow-character-image-preview, flow-edit-character-footer, flow-character-header, flow-scene-page, flow-grid-tile-container, aisandbox-root, button[aria-label="Settings trigger"], button[aria-label], [mattooltip], button.library-expand-button, app-root, main, [class*="project"], [class*="character"]',
    );
    for (const el of roots) {
      let cur: Element | null = el;
      for (let steps = 0; cur && steps < 12; steps++) {
        const hit = matchWithParents(cur);
        if (hit) return hit;
        cur = cur.parentElement;
      }
    }
    const allEls = document.querySelectorAll("*");
    const limit = Math.min(allEls.length, 600);
    for (let i = 0; i < limit; i++) {
      const lv = resolveLView(allEls[i]);
      const hit = lv ? matcher(lv) : null;
      if (hit) return hit;
    }
    return null;
  };

  const probeLViewMapHover = async (): Promise<void> => {
    if (runtimeState.ngLViewMap instanceof Map) return;
    await withLViewMapCapture(async () => {
      const all = Array.from(
        document.querySelectorAll(
          "[mattooltip], [cdkoverlayorigin], button[aria-label], flow-agent-mode-toggle-chip button, flow-prompt-box, flow-project-page",
        ),
      );
      const visible = all.filter((el) => el.getClientRects().length > 0);
      await hoverProbe((visible.length > 0 ? visible : all).slice(0, 12), 30);
    });
  };

  let found: FlowStoreService | null = null;
  for (const matcher of matchers) {
    found = scanDomNgContexts(matcher);
    if (found) break;
  }
  if (found) {
    await probeLViewMapHover();
    if (runtimeState.ngLViewMap && isAmbiguousAcrossMaps([runtimeState.ngLViewMap])) {
      clearStore();
      return { bound: false, newlyDiscovered: false };
    }
    installHandle(found);
    return { bound: true, newlyDiscovered: true };
  }

  const allSeenMaps = new Set<Map<unknown, unknown>>();
  const scanMaps = (maps: Set<Map<unknown, unknown>>): FlowStoreService | null => {
    for (const m of maps) {
      if (!(runtimeState.ngLViewMap instanceof Map) && isNgLViewMap(m)) runtimeState.ngLViewMap = m;
    }
    if (isAmbiguousAcrossMaps(maps)) return null;
    for (const matcher of matchers) {
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

  const captureWithMapHook = async (runAsync: () => Promise<void>): Promise<FlowStoreService | null> => {
    const origSet = Map.prototype.set;
    const origGet = Map.prototype.get;
    const seenMaps = new Set<Map<unknown, unknown>>();
    const seenLViews: NgLView[] = [];
    let directFound: FlowStoreService | null = null;
    try {
      Map.prototype.set = function (this: Map<unknown, unknown>, k: unknown, v: unknown): Map<unknown, unknown> {
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
      Map.prototype.get = function (this: Map<unknown, unknown>, k: unknown): unknown {
        seenMaps.add(this);
        allSeenMaps.add(this);
        const v: unknown = origGet.call(this, k);
        if (!(runtimeState.ngLViewMap instanceof Map) && typeof k === "number" && Array.isArray(v) && v[19] === k) {
          runtimeState.ngLViewMap = this as unknown as Map<number, NgLView>;
        }
        return v;
      };
      await runAsync();
    } finally {
      Map.prototype.set = origSet;
      Map.prototype.get = origGet;
    }
    if (isAmbiguousAcrossMaps(allSeenMaps)) return null;
    if (directFound) return directFound;
    for (const matcher of matchers) {
      for (const lv of seenLViews) {
        const hit = matcher(lv);
        if (hit) return hit;
      }
    }
    return scanMaps(seenMaps);
  };

  if (!found && runtimeState.ngLViewMap instanceof Map) {
    found = scanMaps(new Set([runtimeState.ngLViewMap]));
  }
  const routeKey = `${location.pathname}?${location.search}`;
  if (
    !found &&
    document.readyState === "complete" &&
    lastInvasiveMissPath === routeKey &&
    performance.now() - lastInvasiveMissAt < INVASIVE_PROBE_COOLDOWN_MS
  ) {
    return { bound: false, newlyDiscovered: false, cooldownSkipped: true };
  }

  const probeSelectors = [
    "flow-project-page", "flow-project-shell", "flow-character-edit-page",
    "flow-character-edit-header", "flow-character-form", "flow-character-preview-panel",
    "flow-character-image-preview", "flow-edit-character-footer", "flow-character-page",
    "flow-character-header", "flow-scene-page", "flow-grid-tile-container",
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
    const scroller = document.querySelector(".page-container, cdk-virtual-scroll-viewport");
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
        for (const inp of charInputs) inp.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
        await delay(60);
      });
      if (!found) found = scanMaps(allSeenMaps);
    }
  }

  if (!found) {
    const findPanelToggle = (): HTMLElement | null => {
      const btn = Array.from(document.querySelectorAll('button, [role="button"]')).find(
        (b) =>
          b instanceof HTMLElement &&
          b.getClientRects().length > 0 &&
          /\b(?:collapse|expand)\b/i.test((b.innerText || b.getAttribute("aria-label") || "").trim()),
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

  if (found && !isAmbiguousAcrossMaps(allSeenMaps)) {
    lastInvasiveMissPath = "";
    await probeLViewMapHover();
    if (runtimeState.ngLViewMap && isAmbiguousAcrossMaps([runtimeState.ngLViewMap])) {
      clearStore();
      return { bound: false, newlyDiscovered: false };
    }
    installHandle(found);
    return { bound: true, newlyDiscovered: true };
  }
  lastInvasiveMissPath = routeKey;
  lastInvasiveMissAt = performance.now();
  return { bound: false, newlyDiscovered: false };
}
