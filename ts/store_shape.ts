// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Structural lifecycle, tile query readiness, and tile map helpers for Flow stores.

import { readOwn } from "./angular";
import { frontendBuild, projectStoreFormats, readBuildLabel } from "./frontend_builds";
import type { FlowStoreService, FlowTile } from "./types";

/** Lifecycle flag names on Closure-compiled Angular `DestroyRef` handles. */
const LIFECYCLE_FLAGS = ["Va", "Wa"] as const;

/** Reads an own data property value without invoking getters or Proxy `get` traps. */
export function readOwnData(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  try {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    return desc && "value" in desc ? desc.value : undefined;
  } catch {
    return undefined;
  }
}

/** Returns true when `val` is a plain or class instance object suitable for structural scanning. */
export function isInspectableObject(val: unknown): val is Record<string, unknown> {
  return Boolean(
    val &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      !(val instanceof Node) &&
      !(val instanceof Map) &&
      !(val instanceof Set) &&
      !(val instanceof Date) &&
      !(val instanceof RegExp) &&
      !(val instanceof Promise) &&
      !(val instanceof WeakMap) &&
      !(val instanceof WeakSet) &&
      val !== window &&
      val !== document,
  );
}

/** Reads a boolean lifecycle flag from an own data property or prototype `DestroyRef` getter. */
function readDestroyedFlag(handle: object, flag: string): boolean {
  try {
    const ownDesc = Object.getOwnPropertyDescriptor(handle, flag);
    if (ownDesc) {
      if ("value" in ownDesc) return ownDesc.value === true;
      if (typeof ownDesc.get === "function") {
        return ownDesc.get.call(handle) === true;
      }
      return false;
    }
    let proto: object | null = Object.getPrototypeOf(handle);
    for (let depth = 0; proto && proto !== Object.prototype && depth < 4; depth++) {
      const protoDesc = Object.getOwnPropertyDescriptor(proto, flag);
      if (protoDesc) {
        if ("value" in protoDesc) return protoDesc.value === true;
        if (typeof protoDesc.get === "function") {
          return protoDesc.get.call(handle) === true;
        }
        return false;
      }
      proto = Object.getPrototypeOf(proto);
    }
  } catch {
    return false;
  }
  return false;
}

/** Checks whether one store or component object carries a disposed lifecycle handle. */
function isObjectDestroyed(target: object): boolean {
  if (!isInspectableObject(target)) return false;
  const formats = projectStoreFormats();
  for (const format of formats) {
    const handle = readOwnData(target, format.lifecycle);
    if (isInspectableObject(handle) && readDestroyedFlag(handle, format.destroyed)) {
      return true;
    }
  }
  for (const flag of LIFECYCLE_FLAGS) {
    if (readDestroyedFlag(target, flag)) return true;
  }
  let keys: string[];
  try {
    keys = Object.getOwnPropertyNames(target);
  } catch {
    return false;
  }
  for (const key of keys) {
    const child = readOwnData(target, key);
    if (!isInspectableObject(child)) continue;
    for (const flag of LIFECYCLE_FLAGS) {
      if (readDestroyedFlag(child, flag)) return true;
    }
  }
  return false;
}

/** Returns true when Angular disposes `svc` or its nested store handle. */
export function isStoreDestroyed(svc: unknown): boolean {
  if (!svc || typeof svc !== "object") return true;
  const candidates = [
    svc,
    readOwnData(svc, "_ap"),
    readOwnData(svc, "_uo"),
    readOwnData(svc, "ha"),
  ];
  for (const cand of candidates) {
    if (cand && typeof cand === "object" && isObjectDestroyed(cand)) {
      return true;
    }
  }
  return false;
}

/** Checks whether `qk` identifies an active `PROJECT_TILES` query rather than a disabled query. */
function isProjectTilesQueryKey(qk: unknown, projectId: string | null): boolean {
  if (!Array.isArray(qk) || qk[0] !== "PROJECT_TILES") return false;
  if (qk.length === 1) return true;
  return (
    typeof qk[1] === "string" &&
    qk[1].length > 0 &&
    (!projectId || qk[1] === projectId)
  );
}

/** Checks whether a TanStack query signal or cache entry is still pending its initial data. */
function isQueryPending(query: unknown): boolean {
  if (!query || typeof query !== "object") return false;
  try {
    if ("isPending" in query) {
      const fn = readOwn(query, "isPending");
      if (typeof fn === "function" && fn.call(query) === true) return true;
      if (fn === true) return true;
    }
    if ("state" in query) {
      const state = readOwn(query, "state");
      if (isInspectableObject(state) && "status" in state && readOwn(state, "status") === "pending") {
        return true;
      }
    }
    if ("status" in query) {
      const status = readOwn(query, "status");
      const val = typeof status === "function" ? status.call(query) : status;
      if (val === "pending") return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Checks whether a `QueryCache` holds a pending `PROJECT_TILES` query for `projectId`. */
function hasPendingInQueryCache(cache: unknown, projectId: string | null): boolean {
  if (!isInspectableObject(cache)) return false;
  try {
    const getAll = readOwn(cache, "getAll");
    const list: Iterable<unknown> | null =
      typeof getAll === "function"
        ? (getAll.call(cache) as Iterable<unknown>)
        : readOwnData(cache, "queries") instanceof Map
          ? (readOwnData(cache, "queries") as Map<unknown, unknown>).values()
          : null;
    if (!list) return false;
    for (const q of list) {
      if (!q || typeof q !== "object") continue;
      const qk = readOwnData(q, "queryKey") ?? readOwn(q, "queryKey");
      if (isProjectTilesQueryKey(qk, projectId) && isQueryPending(q)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/** Returns true when `svc` has a pending `tileQuery` or `PROJECT_TILES` query. */
export function hasPendingProjectTilesQuery(
  svc: FlowStoreService | null | undefined,
  projectId: string | null,
): boolean {
  if (!svc || typeof svc !== "object") return false;
  const ap = (readOwnData(svc, "_ap") as FlowStoreService | undefined) ||
    (readOwnData(svc, "ha") as FlowStoreService | undefined) ||
    svc;
  const build = frontendBuild(readBuildLabel());
  const hintSet = new Set<string>();
  if (build?.projectStore.tileQuery) hintSet.add(build.projectStore.tileQuery);
  if (build?.operations.agent_attachments?.tileQuery) {
    hintSet.add(build.operations.agent_attachments.tileQuery);
  }
  for (const fmt of projectStoreFormats()) {
    if (fmt.tileQuery) hintSet.add(fmt.tileQuery);
  }
  hintSet.add("RC");

  const roots = ap === svc ? [ap] : [ap, svc];
  for (const root of roots) {
    if (!isInspectableObject(root)) continue;
    for (const key of hintSet) {
      let cand = readOwnData(root, key);
      if (cand === undefined && key in root) cand = readOwn(root, key);
      if (isQueryPending(cand)) return true;
    }
  }

  const visited = new Set<object>();
  const queue: Array<[object, number]> = roots
    .filter((r): r is Record<string, unknown> => isInspectableObject(r))
    .map((r) => [r, 0]);

  while (queue.length > 0 && visited.size < 40) {
    const next = queue.shift();
    if (!next) break;
    const [cur, depth] = next;
    if (visited.has(cur)) continue;
    visited.add(cur);

    let keys: string[];
    try {
      keys = Object.getOwnPropertyNames(cur);
    } catch {
      continue;
    }
    for (const key of keys) {
      const val = readOwnData(cur, key);
      if (!isInspectableObject(val)) continue;
      if (key === "queryCache" && hasPendingInQueryCache(val, projectId)) {
        return true;
      }
      const cache = readOwnData(val, "queryCache");
      if (cache && hasPendingInQueryCache(cache, projectId)) {
        return true;
      }
      let qk: unknown = readOwnData(val, "queryKey");
      if (qk === undefined && "queryKey" in val) {
        const qkProp = readOwn(val, "queryKey");
        if (Array.isArray(qkProp)) {
          qk = qkProp;
        } else if (typeof qkProp === "function" && qkProp.length === 0) {
          try {
            qk = qkProp.call(val);
          } catch {
            qk = undefined;
          }
        }
      }
      if (isProjectTilesQueryKey(qk, projectId) && isQueryPending(val)) {
        return true;
      }
      if (depth < 2) {
        queue.push([val, depth + 1]);
      }
    }
  }
  return false;
}

/** Finds a method on `obj` or its prototype chain whose source contains `marker`. */
export function findMethodByMarker(
  obj: unknown,
  marker: string,
): ((...args: unknown[]) => unknown) | null {
  if (!obj || typeof obj !== "object") return null;
  let cur: object | null = obj;
  for (let depth = 0; cur && cur !== Object.prototype && depth < 3; depth++) {
    for (const k of Object.getOwnPropertyNames(cur)) {
      if (k === "constructor") continue;
      const desc = Object.getOwnPropertyDescriptor(cur, k);
      const fn = desc && "value" in desc ? desc.value : readOwn(obj, k);
      if (typeof fn === "function") {
        try {
          if (fn.toString().includes(marker)) {
            return fn.bind(obj) as (...args: unknown[]) => unknown;
          }
        } catch {
          // Ignore functions without readable source text.
        }
      }
    }
    cur = Object.getPrototypeOf(cur);
  }
  return null;
}

/** Returns true when `obj` defines a method whose source contains `marker`. */
export function hasMethodString(obj: unknown, marker: string): boolean {
  return Boolean(findMethodByMarker(obj, marker));
}

/** Checks whether `m` matches the shape of a project tile `Map`. */
function isTileMap(m: unknown): m is Map<string, FlowTile> {
  if (!(m instanceof Map)) return false;
  if (m.size === 0) return true;
  for (const v of m.values()) {
    return Boolean(v && typeof v === "object" && ("id" in v || "type" in v));
  }
  return false;
}

/** Extracts the project tile `Map` from a bound Angular store service. */
export function resolveTileMapFrom(svc: FlowStoreService | null): Map<string, FlowTile> | null {
  if (!svc || typeof svc !== "object") return null;
  const apKa = svc._ap?.ka;
  if (typeof apKa === "function") {
    try {
      const m = apKa.call(svc._ap);
      if (m instanceof Map) return m;
    } catch {
      // Try the next map accessor.
    }
  }
  if (typeof svc.ka === "function") {
    try {
      const m = svc.ka();
      if (m instanceof Map) return m;
    } catch {
      // Try the next map accessor.
    }
  }
  const haKa = svc.ha?.ka;
  if (typeof haKa === "function") {
    try {
      const m = haKa.call(svc.ha);
      if (m instanceof Map) return m;
    } catch {
      // Fall back to breadth-first property scan.
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
      const val = readOwnData(cur, k);
      if (isTileMap(val)) {
        if (val.size > 0) return val;
        emptyMapFallback = emptyMapFallback || val;
      } else if (isInspectableObject(val) && seen.size < 40) {
        let proto = Object.getPrototypeOf(val) as object | null;
        while (proto && proto !== Object.prototype) {
          for (const mk of Object.getOwnPropertyNames(proto)) {
            if (mk === "constructor") continue;
            try {
              const desc = Object.getOwnPropertyDescriptor(proto, mk);
              const fn = desc && "value" in desc ? desc.value : undefined;
              if (typeof fn === "function" && fn.length === 0) {
                const res = fn.call(val);
                if (isTileMap(res)) {
                  if (res.size > 0) return res;
                  emptyMapFallback = emptyMapFallback || res;
                }
              }
            } catch {
              // Ignore methods that require runtime arguments or context.
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

/** Resolves cached tile rows from a `_uo` query-cache service. */
export function resolveTileArrayFromUO(
  uo: FlowStoreService,
  projectId: string | null,
): FlowTile[] | null {
  if (!uo || typeof uo !== "object" || typeof uo.ob?.ha !== "function") {
    return null;
  }
  try {
    const qk =
      typeof uo.queryKey === "function"
        ? uo.queryKey(projectId)
        : ["PROJECT_TILES", projectId];
    const data = uo.ob.ha(qk);
    if (data && Array.isArray(data.Cb)) return data.Cb;
  } catch {
    return null;
  }
  return null;
}
