// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Shared Angular Ivy LView traversal and router lookup helpers.

import { runtimeState } from "./state";
import type { AngularRouter, NgLView } from "./types";

/** Object with optional Angular Ivy `__ngContext__` or internal `lView` links. */
export interface NgContextCarrier {
  /** Angular Ivy LView array or registry slot index. */
  __ngContext__?: number | NgLView;
  /** Embedded view LView reference. */
  lView?: NgLView;
  /** Minified LView reference alias. */
  Pn?: NgLView;
}

/** Reads an own or prototype property safely without triggering exceptions. */
export function readOwn(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  try {
    return Reflect.get(obj as object, key);
  } catch {
    return undefined;
  }
}

/** Returns true when `m` matches Angular's integer-keyed LView registry map. */
export function isNgLViewMap(m: unknown): m is Map<number, NgLView> {
  if (!(m instanceof Map) || m.size === 0) return false;
  for (const [k, v] of m.entries()) {
    return typeof k === "number" && Array.isArray(v) && v[19] === k;
  }
  return false;
}

/** Resolves a DOM element, numeric slot index, or wrapper object to its Angular `NgLView`. */
export function resolveLView(elOrCtx: unknown): NgLView | null {
  const ctxObj =
    elOrCtx && typeof elOrCtx === "object"
      ? (elOrCtx as NgContextCarrier)
      : null;
  const raw: unknown =
    ctxObj && "__ngContext__" in ctxObj ? ctxObj.__ngContext__ : elOrCtx;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "number") {
    return runtimeState.ngLViewMap instanceof Map
      ? runtimeState.ngLViewMap.get(raw) || null
      : null;
  }
  if (raw && typeof raw === "object") {
    const carrier = raw as NgContextCarrier;
    return carrier.lView || carrier.Pn || null;
  }
  return null;
}

/** Temporarily hooks `Map.prototype.get/set` during `runAsync` to capture Angular's LView map. */
export async function withLViewMapCapture<T>(runAsync: () => Promise<T>): Promise<T> {
  const origSet = Map.prototype.set;
  const origGet = Map.prototype.get;
  try {
    Map.prototype.set = function (
      this: Map<unknown, unknown>,
      k: unknown,
      v: unknown,
    ): Map<unknown, unknown> {
      if (typeof k === "number" && Array.isArray(v) && v[19] === k) {
        runtimeState.ngLViewMap = this as unknown as Map<number, NgLView>;
      }
      return origSet.call(this, k, v);
    };
    Map.prototype.get = function (
      this: Map<unknown, unknown>,
      k: unknown,
    ): unknown {
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
    return await runAsync();
  } finally {
    Map.prototype.set = origSet;
    Map.prototype.get = origGet;
  }
}

/** Searches visible shell nodes and captured LViews for the active Angular `Router` instance. */
export function findRouter(): AngularRouter | null {
  const isRouter = (cand: unknown): cand is AngularRouter =>
    Boolean(
      cand &&
        typeof cand === "object" &&
        cand !== window &&
        cand !== document &&
        cand !== window.navigation &&
        !(cand instanceof Node) &&
        !Array.isArray(cand) &&
        !(cand instanceof Map) &&
        typeof (cand as Partial<AngularRouter>).navigate === "function" &&
        "location" in cand &&
        "options" in cand,
    );

  const seenLViews = new Set<unknown>();
  const seenObjs = new Set<object>();

  const inspectInjector = (injRoot: object): AngularRouter | null => {
    let inj: object | null = injRoot;
    for (let d = 0; d < 6 && inj && typeof inj === "object"; d += 1) {
      if (seenObjs.has(inj)) break;
      seenObjs.add(inj);
      const records = readOwn(inj, "records");
      if (records instanceof Map) {
        for (const rec of records.values()) {
          if (isRouter(rec)) return rec;
          const recVal = readOwn(rec, "value");
          if (isRouter(recVal)) return recVal;
        }
      }
      const parent = readOwn(inj, "parent");
      inj = parent && typeof parent === "object" ? parent : null;
    }
    return null;
  };

  const inspectLViewTree = (startLv: NgLView | null): AngularRouter | null => {
    if (!Array.isArray(startLv)) return null;
    const queue: Array<[NgLView, number]> = [[startLv, 0]];
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      const [lv, depth] = next;
      if (!Array.isArray(lv) || seenLViews.has(lv)) continue;
      seenLViews.add(lv);
      for (const slot of lv) {
        if (!slot || typeof slot !== "object" || slot instanceof Node) {
          continue;
        }
        if (isRouter(slot)) return slot;
        if (seenObjs.has(slot)) continue;
        seenObjs.add(slot);
        if (readOwn(slot, "records") instanceof Map || "parent" in slot) {
          const fromInj = inspectInjector(slot);
          if (fromInj) return fromInj;
        }
        if (!Array.isArray(slot) && !(slot instanceof Map)) {
          const keys = Object.keys(slot);
          for (let i = 0; i < keys.length && i < 30; i += 1) {
            const val = readOwn(slot, keys[i]);
            if (isRouter(val)) return val;
          }
        }
      }
      if (depth < 8) {
        if (Array.isArray(lv[3])) queue.push([lv[3], depth + 1]);
        if (Array.isArray(lv[15])) queue.push([lv[15], depth + 1]);
      }
    }
    return null;
  };

  const els = document.querySelectorAll(
    "flow-project-shell, flow-project-page, flow-character-edit-page, flow-editor-dispatcher, flow-editor-page, flow-scene-builder, router-outlet, aisandbox-root, app-root, main",
  );
  for (const el of els) {
    const hit = inspectLViewTree(resolveLView(el));
    if (hit) return hit;
  }
  if (runtimeState.ngLViewMap instanceof Map) {
    for (const lv of runtimeState.ngLViewMap.values()) {
      const hit = inspectLViewTree(lv);
      if (hit) return hit;
    }
  }
  return null;
}
