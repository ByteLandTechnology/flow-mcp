// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Shared Angular Ivy LView traversal, router lookup, and scene creation helpers.

import {
  characterLookMedia,
  delay,
  elText,
  fifeBase,
  normalizeFlowMediaUrl,
  readMediaUrl,
} from "./dom";
import { splitFlowPath } from "./flow_route";
import { frontendBuild, readBuildLabel } from "./frontend_builds";
import { runtimeState } from "./state";
import type {
  AngularRouter,
  FlowStoreHandle,
  FlowTile,
  NgLView,
} from "./types";

/** Object with optional Angular Ivy `__ngContext__` or internal `lView` links. */
export interface NgContextCarrier {
  /** Angular Ivy LView array or registry slot index. */
  __ngContext__?: number | NgLView | Record<string, unknown>;
  /** Embedded view LView reference. */
  lView?: NgLView;
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

/** Returns `true` when `val` is a non-null, non-array, non-`Map`, non-DOM object. */
export function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return Boolean(
    val &&
      typeof val === "object" &&
      val !== window &&
      val !== document &&
      val !== window.navigation &&
      !(val instanceof Node) &&
      !Array.isArray(val) &&
      !(val instanceof Map),
  );
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

/** Binds the live Angular view registry that contains the selected host context. */
export function bindAngularViews(maps: unknown[], selector: string): boolean {
  for (const host of document.querySelectorAll(selector)) {
    const context = readOwn(host, "__ngContext__");
    if (typeof context !== "number") continue;
    const views = maps.find((map): map is Map<number, NgLView> =>
      isNgLViewMap(map) && isLiveLView(map.get(context)),
    );
    if (views) {
      runtimeState.ngLViewMap = views;
      return true;
    }
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
    const lView = readOwn(raw, "lView");
    if (Array.isArray(lView)) return lView;
    const contextField = frontendBuild(readBuildLabel())?.projectStore.lContextView;
    const verifiedView = contextField ? readOwn(raw, contextField) : undefined;
    return Array.isArray(verifiedView) ? verifiedView : null;
  }
  return null;
}

/** Receives one successful map read or write. */
type MapObserver = (map: Map<unknown, unknown>, key: unknown, value: unknown, write: boolean) => void;

/** Active observers share one pair of wrappers. */
const mapObservers = new Set<MapObserver>();

/** Restores the original methods when the last observer stops. */
let restoreMapMethods: (() => void) | undefined;

/** Starts map capture and returns a function that removes this observer. */
export function startMapCapture(observe: MapObserver): () => void {
  const observer: MapObserver = (...args) => observe(...args);
  if (mapObservers.size === 0) {
    const originalSet = Map.prototype.set;
    const originalGet = Map.prototype.get;
    Map.prototype.set = function (
      this: Map<unknown, unknown>,
      key: unknown,
      value: unknown,
    ): Map<unknown, unknown> {
      const result = originalSet.call(this, key, value);
      for (const active of mapObservers) active(this, key, value, true);
      return result;
    };
    Map.prototype.get = function (
      this: Map<unknown, unknown>,
      key: unknown,
    ): unknown {
      const value: unknown = originalGet.call(this, key);
      for (const active of mapObservers) active(this, key, value, false);
      return value;
    };
    restoreMapMethods = () => {
      Map.prototype.set = originalSet;
      Map.prototype.get = originalGet;
    };
  }
  mapObservers.add(observer);
  return () => {
    mapObservers.delete(observer);
    if (mapObservers.size === 0) {
      restoreMapMethods?.();
      restoreMapMethods = undefined;
    }
  };
}

/** Captures shared map activity until the operation completes. */
export async function withMapCapture<T>(observe: MapObserver, runAsync: () => Promise<T>): Promise<T> {
  const stop = startMapCapture(observe);
  try {
    return await runAsync();
  } finally {
    stop();
  }
}

/** Records Angular's LView map and optionally reports accessed views to the caller. */
export function withLViewMapCapture<T>(
  runAsync: () => Promise<T>,
  visit?: (map: Map<unknown, unknown>, value: unknown) => void,
): Promise<T> {
  return withMapCapture((map, key, value, write) => {
    if (
      (write || !(runtimeState.ngLViewMap instanceof Map)) &&
      typeof key === "number" && Array.isArray(value) && value[19] === key
    ) {
      runtimeState.ngLViewMap = map as Map<number, NgLView>;
    }
    visit?.(map, value);
  }, runAsync);
}

/** Cached query-parameter key per Angular Router instance. */
const routerQueryParamKeys = new WeakMap<AngularRouter, string>();

/** Builds the query parameters that Google Flow routes keep across transitions. */
function flowQueryParams(search: string = location.search): Record<string, string> {
  const params: Record<string, string> = { hl: "en" };
  const authuser = new URLSearchParams(search).get("authuser")?.trim();
  if (authuser) {
    params.authuser = authuser;
  }
  return params;
}

/** Extracts the active route prefix from the current page URL or `<base href>`. */
function activeProjectPrefix(): string {
  const path = location.pathname || "";
  const { prefix } = splitFlowPath(path);
  if (prefix) return prefix;
  const baseHref = document.head?.querySelector("base")?.getAttribute("href");
  if (baseHref) {
    try {
      const basePath = new URL(baseHref, location.origin).pathname.replace(/\/+$/, "");
      if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) {
        return basePath;
      }
    } catch {
      // Ignore malformed `<base href>` attributes.
    }
  }
  return "";
}

/** Discovers the query-parameter key on `NavigationExtras` via `UrlSerializer.parse` on `router`. */
function routerQueryParamsKey(router: AngularRouter): string {
  const cached = routerQueryParamKeys.get(router);
  if (cached) return cached;
  const candidateKeys = Array.from(new Set([...Object.keys(router), "urlSerializer"]));
  for (const key of candidateKeys) {
    const serializer = readOwn(router, key);
    if (!isPlainRecord(serializer)) continue;
    const parse = readOwn(serializer, "parse");
    if (typeof parse !== "function") continue;
    try {
      const tree = (parse as (url: string) => unknown).call(serializer, "/?__flow_qp=1");
      if (!isPlainRecord(tree)) continue;
      for (const treeKey of new Set([...Object.keys(tree), "queryParams"])) {
        const qp = readOwn(tree, treeKey);
        if (isPlainRecord(qp) && readOwn(qp, "__flow_qp") === "1") {
          routerQueryParamKeys.set(router, treeKey);
          return treeKey;
        }
      }
    } catch {
      // Ignore unrelated `parse` methods on router dependencies.
    }
  }
  return "queryParams";
}

/** Navigates through the Angular `Router` while keeping `hl=en` and `authuser`. */
export function navigateSpa(
  router: AngularRouter,
  commands: unknown[],
): Promise<boolean> {
  const qpKey = routerQueryParamsKey(router);
  return router.navigate(commands, { [qpKey]: flowQueryParams() });
}

/** Builds a full Google Flow `/project/<id>` or subroute URL with active prefixes, `hl=en`, and `authuser`. */
export function buildProjectUrl(
  projectId: string,
  subroute: string | readonly string[] = "",
): string {
  const prefix = activeProjectPrefix();
  const cleanSub = Array.isArray(subroute)
    ? subroute
        .filter(Boolean)
        .map((seg) => encodeURIComponent(String(seg)))
        .join("/")
    : String(subroute).replace(/^\/+/, "");
  const suffix = cleanSub ? `/${cleanSub}` : "";
  const url = new URL(
    `${prefix}/project/${encodeURIComponent(projectId)}${suffix}`,
    location.origin,
  );
  for (const [k, v] of Object.entries(flowQueryParams())) {
    url.searchParams.set(k, v);
  }
  return url.href;
}

/** Host selectors searched first for Angular Ivy `LView` trees and root injectors. */
export const ANGULAR_SHELL_SELECTOR =
  "flow-project-shell, flow-project-page, flow-character-edit-page, flow-editor-dispatcher, flow-editor-page, flow-scene-builder, router-outlet, aisandbox-root, app-root, main, header";

/** Searches visible shell nodes, injectors, and captured LViews for a service matching `match`. */
export function findInAngular<T>(match: (cand: unknown) => cand is T): T | null {
  const ownMaps = (obj: object): Array<Map<unknown, unknown>> => {
    const maps: Array<Map<unknown, unknown>> = [];
    const named = readOwn(obj, "records");
    if (named instanceof Map) maps.push(named);
    for (const key of Object.keys(obj)) {
      const val = readOwn(obj, key);
      if (val instanceof Map && !maps.includes(val)) {
        maps.push(val);
      }
    }
    return maps;
  };

  const seenLViews = new Set<unknown>();
  const seenObjs = new Set<object>();
  const seenInjectors = new Set<object>();

  const inspectInjector = (injRoot: object): T | null => {
    let inj: object | null = injRoot;
    for (let d = 0; d < 10 && inj && typeof inj === "object"; d += 1) {
      if (seenInjectors.has(inj)) break;
      seenInjectors.add(inj);
      for (const records of ownMaps(inj)) {
        for (const rec of records.values()) {
          if (match(rec)) return rec;
          const recVal = readOwn(rec, "value");
          if (match(recVal)) return recVal;
          if (isPlainRecord(recVal) && !seenObjs.has(recVal)) {
            seenObjs.add(recVal);
            const rKeys = Object.keys(recVal);
            for (let i = 0; i < rKeys.length && i < 16; i += 1) {
              const nested = readOwn(recVal, rKeys[i]);
              if (match(nested)) return nested;
            }
          }
        }
      }
      const parent = readOwn(inj, "parent");
      if (parent && typeof parent === "object" && !(parent instanceof Node)) {
        inj = parent;
        continue;
      }
      let nextInj: object | null = null;
      for (const key of Object.keys(inj)) {
        const candParent = readOwn(inj, key);
        if (
          isPlainRecord(candParent) &&
          !seenInjectors.has(candParent) &&
          ownMaps(candParent).length > 0
        ) {
          nextInj = candParent;
          break;
        }
      }
      inj = nextInj;
    }
    return null;
  };

  const inspectLViewTree = (startLv: NgLView | null): T | null => {
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
        if (match(slot)) return slot;
        if ("parent" in slot || ownMaps(slot).length > 0) {
          const fromInj = inspectInjector(slot);
          if (fromInj) return fromInj;
        }
        if (seenObjs.has(slot)) continue;
        seenObjs.add(slot);
        if (isPlainRecord(slot)) {
          const keys = Object.keys(slot);
          for (let i = 0; i < keys.length && i < 30; i += 1) {
            const val = readOwn(slot, keys[i]);
            if (match(val)) return val;
            if (isPlainRecord(val) && ("parent" in val || ownMaps(val).length > 0)) {
              const fromNested = inspectInjector(val);
              if (fromNested) return fromNested;
            }
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

  for (const el of document.querySelectorAll(ANGULAR_SHELL_SELECTOR)) {
    const hit = inspectLViewTree(resolveLView(el));
    if (hit) return hit;
  }
  if (runtimeState.ngLViewMap instanceof Map) {
    for (const lv of runtimeState.ngLViewMap.values()) {
      const hit = inspectLViewTree(lv);
      if (hit) return hit;
    }
  }
  const all = document.querySelectorAll("*");
  const limit = Math.min(all.length, 200);
  for (let i = 0; i < limit; i += 1) {
    if ("__ngContext__" in all[i]) {
      const hit = inspectLViewTree(resolveLView(all[i]));
      if (hit) return hit;
    }
  }
  return null;
}

/** Searches visible shell nodes and captured LViews for the active Angular `Router` instance. */
export function findRouter(): AngularRouter | null {
  return findInAngular(
    (cand): cand is AngularRouter =>
      isPlainRecord(cand) &&
      typeof (cand as Partial<AngularRouter>).navigate === "function" &&
      "location" in cand &&
      "options" in cand,
  );
}

/** Maximum time to confirm scene creation and the initial clip load. */
const SCENE_CREATE_TIMEOUT_MS = 30_000;

/** Reads the ID from a native scene creation result. */
function readSceneId(scene: unknown): string | undefined {
  if (typeof scene === "string" && scene) return scene;
  const id = readOwn(scene, "id");
  return typeof id === "string" && id ? id : undefined;
}

/** Returns the IDs of the confirmed scenes in the store. */
function sceneIds(tiles: Map<string, FlowTile> | null | undefined): string[] {
  return [...(tiles?.entries() ?? [])].flatMap(([id, tile]) =>
    tile.type === "SCENE" && !tile.isPending ? [String(tile.id ?? id)] : []);
}

/** Creates a scene and waits for its ID from Flow. */
export async function createScene(
  helper: FlowStoreHandle,
  getMap: () => Map<string, FlowTile> | null | undefined,
  workflowIds: string[],
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const before = new Set(sceneIds(getMap()));
  const resultField = frontendBuild(readBuildLabel())?.projectStore.mutations?.sceneCreated ?? "VWa";
  let confirmedId: string | undefined;
  let failure: string | undefined;
  const completion = {
    resolve: (scene: unknown) => { confirmedId ??= readSceneId(scene); },
    reject: (error: unknown) => {
      failure ??= error instanceof Error ? error.message : String(error ?? "create_scene_failed");
    },
  };
  const deadline = performance.now() + SCENE_CREATE_TIMEOUT_MS;
  void Promise.resolve().then(() => helper.mutate({
    type: "create_scene",
    rg: workflowIds,
    Fc: undefined,
    wc: undefined,
    aspectRatio: 1,
    De: completion,
    ve: completion,
  })).then((response) => {
    completion.resolve(readOwn(response, resultField));
  }, completion.reject);

  while (performance.now() < deadline) {
    if (confirmedId) return { ok: true, id: confirmedId };
    if (failure) return { ok: false, error: failure };
    const added = sceneIds(getMap()).filter((id) => !before.has(id));
    if (added.length === 1) return { ok: true, id: added[0] };
    await delay(200);
  }
  return { ok: false, error: "scene_creation_outcome_unknown" };
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
  const rawUrl =
    readMediaUrl(a) ||
    readMediaUrl(readOwn(a, "Kb")) ||
    readMediaUrl(readOwn(a, "Fb")) ||
    characterLookMedia(a as FlowTile).url;
  const targetFife = target.fife ? fifeBase(normalizeFlowMediaUrl(target.fife)) : "";
  const aFife = rawUrl ? fifeBase(normalizeFlowMediaUrl(rawUrl)) : "";
  return Boolean(targetFife && aFife && targetFife === aFife);
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
    const targetFife = target.fife ? fifeBase(normalizeFlowMediaUrl(target.fife)) : "";
    for (const m of el.querySelectorAll(mediaSelector)) {
      const s = m.getAttribute("src") || "";
      if (!s) continue;
      if (
        (target.url && (s === target.url || target.url.includes(s))) ||
        (targetFife && fifeBase(normalizeFlowMediaUrl(s)) === targetFife)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Reads a trimmed string property or zero-argument Angular input signal from `cand`. */
function readTooltipSlotValue(cand: object, key: string): string {
  const val = readOwn(cand, key);
  if (typeof val === "string") return val.trim();
  if (typeof val === "function" && val.length === 0) {
    try {
      const out: unknown = val.call(cand);
      if (typeof out === "string") return out.trim();
    } catch {
      return "";
    }
  }
  return "";
}

/** Scans one Angular `NgLView` for `MatTooltip.message` or `flow-menu-item` `Sf` and `CA` inputs. */
function scanLViewTooltip(lv: NgLView, hostNode: Element): string {
  for (const slot of lv) {
    if (Array.isArray(slot) && slot[0] === hostNode) {
      const nested = scanLViewTooltip(slot, hostNode);
      if (nested) return nested;
    }
  }
  for (const key of ["message", "Sf", "CA"]) {
    for (const cand of lv) {
      if (!isPlainRecord(cand) || cand instanceof Error) continue;
      const text = readTooltipSlotValue(cand, key);
      if (text) return text;
    }
  }
  return "";
}

/** Reads tooltip text from Angular `MatTooltip` (`message`), `Sf` or `CA` inputs, or HTML attributes. */
export function readAngularTooltip(el: Element | null | undefined): string {
  if (!el) return "";
  const hostItem = el.closest("flow-menu-item, .extend-clip-option") || el;
  const seenLViews = new Set<NgLView>();
  const innerNodes = Array.from(hostItem.querySelectorAll("*"));
  const targets = [...innerNodes, el, hostItem];
  for (const node of targets) {
    let lv: NgLView | null = resolveLView(node);
    for (let d = 0; d < 3 && Array.isArray(lv); d += 1) {
      if (
        d > 0 &&
        lv[0] instanceof Node &&
        lv[0] !== hostItem &&
        !hostItem.contains(lv[0])
      ) {
        break;
      }
      if (!seenLViews.has(lv)) {
        seenLViews.add(lv);
        const found = scanLViewTooltip(lv, hostItem);
        if (found) return found;
      }
      lv = Array.isArray(lv[3]) ? lv[3] : Array.isArray(lv[15]) ? lv[15] : null;
    }
  }
  for (const node of [el, hostItem, ...innerNodes]) {
    const attr = (
      node.getAttribute("mattooltip") ||
      node.getAttribute("title") ||
      ""
    ).trim();
    if (attr) return attr;
  }
  return "";
}
