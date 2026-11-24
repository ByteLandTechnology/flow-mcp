// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Shared Angular Ivy LView traversal, router lookup, and scene creation helpers.

import { delay, elText, fifeBase } from "./dom";
import { frontendBuild, readBuildLabel } from "./frontend_builds";
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

/** Binds the live Angular view registry that contains the selected host context. */
export function bindAngularViews(maps: unknown[], selector: string): boolean {
  const context = readOwn(document.querySelector(selector), "__ngContext__");
  if (typeof context !== "number") return false;
  const views = maps.find((map): map is Map<number, NgLView> =>
    isNgLViewMap(map) && isLiveLView(map.get(context)),
  );
  if (!views) return false;
  runtimeState.ngLViewMap = views;
  return true;
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

/** Extracts the active route prefix before `/project/` from the current page URL. */
function activeProjectPrefix(): string {
  const path = location.pathname || "";
  const projectIdx = path.indexOf("/project/");
  if (projectIdx >= 0) {
    return path.slice(0, projectIdx).replace(/\/+$/, "");
  }
  const baseHref = document.head?.querySelector("base")?.getAttribute("href");
  if (baseHref) {
    try {
      const basePath = new URL(baseHref, location.origin).pathname.replace(/\/+$/, "");
      if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) {
        return basePath;
      }
    } catch {
      // Fall through to segment check.
    }
  }
  const segs = path.split("/").filter(Boolean);
  const prefixSegs: string[] = [];
  let i = 0;
  while (i < segs.length) {
    if (
      segs[i] === "fx" &&
      segs[i + 1] === "tools" &&
      segs[i + 2] === "flow"
    ) {
      prefixSegs.push("fx", "tools", "flow");
      i += 3;
    } else if (segs[i] === "u" && /^\d+$/.test(segs[i + 1] || "")) {
      prefixSegs.push("u", segs[i + 1]);
      i += 2;
    } else if (
      segs[i + 1] === "global" &&
      !/^(?:project|projects|about|shared|flow|tools|fx|u)$/.test(segs[i])
    ) {
      prefixSegs.push(segs[i], "global");
      i += 2;
    } else {
      break;
    }
  }
  return prefixSegs.length > 0 ? `/${prefixSegs.join("/")}` : "";
}

/** Discovers the query-parameter key on `NavigationExtras` via `UrlSerializer.parse` on `router`. */
function routerQueryParamsKey(router: AngularRouter): string {
  const cached = routerQueryParamKeys.get(router);
  if (cached) return cached;
  const candidateKeys = Array.from(new Set([...Object.keys(router), "urlSerializer"]));
  for (const key of candidateKeys) {
    const serializer = readOwn(router, key);
    if (
      !serializer ||
      typeof serializer !== "object" ||
      serializer === window ||
      serializer === document ||
      serializer instanceof Node
    ) {
      continue;
    }
    const parse = readOwn(serializer, "parse");
    if (typeof parse !== "function") continue;
    try {
      const tree = (parse as (url: string) => unknown).call(
        serializer,
        "/?__flow_qp=1",
      );
      if (!tree || typeof tree !== "object") continue;
      const treeKeys = Array.from(new Set([...Object.keys(tree), "queryParams"]));
      for (const treeKey of treeKeys) {
        const qp = readOwn(tree, treeKey);
        if (
          qp &&
          typeof qp === "object" &&
          !Array.isArray(qp) &&
          readOwn(qp, "__flow_qp") === "1"
        ) {
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

  const inspectInjector = (injRoot: object): AngularRouter | null => {
    let inj: object | null = injRoot;
    for (let d = 0; d < 6 && inj && typeof inj === "object"; d += 1) {
      if (seenInjectors.has(inj)) break;
      seenInjectors.add(inj);
      for (const records of ownMaps(inj)) {
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
        if ("parent" in slot || ownMaps(slot).length > 0) {
          const fromInj = inspectInjector(slot);
          if (fromInj) return fromInj;
        }
        if (seenObjs.has(slot)) continue;
        seenObjs.add(slot);
        if (!Array.isArray(slot) && !(slot instanceof Map)) {
          const keys = Object.keys(slot);
          for (let i = 0; i < keys.length && i < 30; i += 1) {
            const val = readOwn(slot, keys[i]);
            if (isRouter(val)) return val;
            if (
              val &&
              typeof val === "object" &&
              !(val instanceof Node) &&
              !Array.isArray(val) &&
              !(val instanceof Map) &&
              ("parent" in val || ownMaps(val).length > 0)
            ) {
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
