// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Shared Angular Ivy LView traversal, router lookup, and scene creation helpers.

import { delay, elText, fifeBase } from "./dom";
import { runtimeState } from "./state";
import type { AngularRouter, FlowStoreHandle, FlowTile, NgLView } from "./types";

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

/** Returns `lv` if `lv` is a live Angular LView whose host node remains connected. */
export function isLiveLView(lv: unknown): lv is NgLView {
  return Array.isArray(lv) && (!(lv[0] instanceof Node) || lv[0].isConnected);
}

/** Returns true when `m` matches Angular's integer-keyed LView registry map. */
export function isNgLViewMap(m: unknown): m is Map<number, NgLView> {
  // Runtime.queryObjects(Map.prototype) also returns objects that only inherit from
  // Map.prototype. Reading `size` on them throws, so a non-Map is simply not a match.
  try {
    if (!(m instanceof Map) || m.size === 0) return false;
    for (const [k, v] of m.entries()) {
      return typeof k === "number" && Array.isArray(v) && v[19] === k;
    }
  } catch {
    return false;
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

/** Dispatches a `create_scene` mutation through `helper` and waits for the resolved scene ID. */
export async function createScene(
  helper: FlowStoreHandle,
  getMap: () => Map<string, FlowTile> | null | undefined,
  workflowIds: string[],
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const tileMap = getMap();
  const before = new Set<string>();
  if (tileMap instanceof Map) {
    for (const [k, v] of tileMap.entries()) {
      if (String(v?.type || "").toUpperCase() === "SCENE") {
        before.add(String(v?.id ?? k));
      }
    }
  }
  let resolveDe: (v: unknown) => void = () => {};
  let rejectDe: (e: unknown) => void = () => {};
  let resolvedScene: unknown = null;
  let mutateErr: string | null = null;
  const dePromise = new Promise<unknown>((res, rej) => {
    resolveDe = res;
    rejectDe = rej;
  });
  dePromise.then(
    (v) => {
      resolvedScene = v;
    },
    (e) => {
      const errObj = e as { message?: unknown } | null;
      mutateErr = String(errObj?.message || e || "create_scene_failed");
    },
  );
  const mutatePromise = Promise.resolve(
    helper.mutate({
      type: "create_scene",
      rg: workflowIds,
      Fc: undefined,
      wc: undefined,
      aspectRatio: 1,
      De: { resolve: resolveDe, reject: rejectDe },
      ve: { resolve: resolveDe, reject: rejectDe },
    }),
  ).then(
    (v) => {
      const vObj = v as { VWa?: unknown } | null;
      if (vObj?.VWa && !resolvedScene) resolvedScene = vObj.VWa;
    },
    (e) => {
      if (!mutateErr) {
        const errObj = e as { message?: unknown } | null;
        mutateErr = String(errObj?.message || e || "create_scene_failed");
      }
    },
  );

  const readSceneId = (val: unknown): string | null => {
    if (typeof val === "string" && val) return val;
    if (val && typeof val === "object") {
      const objId = (val as { id?: unknown }).id;
      if (objId) return String(objId);
    }
    return null;
  };

  let sceneId: string | null = null;
  for (let i = 0; i < 80; i++) {
    if (mutateErr) {
      return { ok: false, error: mutateErr };
    }
    const directId = readSceneId(resolvedScene);
    if (directId) {
      sceneId = directId;
      break;
    }
    const mNow = getMap();
    if (mNow instanceof Map) {
      for (const [k, v] of mNow.entries()) {
        if (String(v?.type || "").toUpperCase() === "SCENE" && !v?.isPending) {
          const sid = String(v?.id ?? k);
          if (!before.has(sid)) {
            sceneId = sid;
            break;
          }
        }
      }
    }
    if (sceneId) break;
    await delay(100);
  }
  if (!sceneId && !mutateErr) {
    await Promise.race([mutatePromise, delay(200)]).catch(() => {});
    sceneId = readSceneId(resolvedScene);
  }
  if (mutateErr) {
    return { ok: false, error: mutateErr };
  }
  if (!sceneId) {
    return { ok: false, error: "created_scene_id_not_found" };
  }
  return { ok: true, id: sceneId };
}

/** Matching descriptor used when picking an existing tile in Flow overlay pickers. */
export interface PickerMatchTarget {
  /** Primary tile or workflow ID. */
  id: string;
  /** Optional primary media identifier. */
  primaryMediaId?: string | number | null;
  /** Lowercase display name when present. */
  lowName?: string;
  /** Optional raw media URL. */
  url?: string | null;
  /** Optional normalized FIFE base URL without resize suffix. */
  fife?: string;
}

/** Returns true when a picker item model or Angular payload matches `target`. */
export function pickerAssetMatches(
  a: unknown,
  target: PickerMatchTarget,
): boolean {
  if (!a || typeof a !== "object") return false;
  const aids = [
    readOwn(a, "id"),
    readOwn(a, "workflowId"),
    readOwn(a, "entityId"),
    readOwn(a, "mediaId"),
    readOwn(a, "primaryMediaId"),
  ]
    .filter(Boolean)
    .map(String);
  if (aids.includes(target.id)) return true;
  if (target.primaryMediaId && aids.includes(String(target.primaryMediaId))) {
    return true;
  }
  const aFife = fifeBase(
    readOwn(a, "Wb") ||
      readOwn(a, "fifeUrl") ||
      readOwn(a, "imageUrl") ||
      readOwn(a, "url"),
  );
  return Boolean(target.fife && aFife && target.fife === aFife);
}

/** Returns true when a visible picker DOM node matches `target` via Ivy data, title, or media URL. */
export function pickerElementMatches(
  el: Element,
  target: PickerMatchTarget,
  mediaSelector = "img[src], video[src]",
): boolean {
  if (!el || el.getClientRects().length === 0) return false;
  const lv = resolveLView(el);
  if (Array.isArray(lv)) {
    for (const cand of lv) {
      if (!cand || typeof cand !== "object" || cand instanceof Node) continue;
      if (pickerAssetMatches(cand, target)) return true;
      const assetField = readOwn(cand, "asset");
      const inner =
        typeof assetField === "function" ? assetField.call(cand) : assetField;
      if (pickerAssetMatches(inner, target)) return true;
    }
  }
  if (target.lowName) {
    const titleEl = el.querySelector(".asset-title");
    const txt = (
      (titleEl ? elText(titleEl) : "") ||
      elText(el) ||
      el.getAttribute("aria-label") ||
      ""
    ).toLowerCase();
    if (txt && txt.includes(target.lowName)) return true;
  }
  if (target.url || target.fife) {
    for (const m of el.querySelectorAll(mediaSelector)) {
      const s = m.getAttribute("src") || "";
      if (!s) continue;
      if (
        (target.url && (s === target.url || target.url.includes(s))) ||
        (target.fife && fifeBase(s) === target.fife)
      ) {
        return true;
      }
    }
  }
  return false;
}
