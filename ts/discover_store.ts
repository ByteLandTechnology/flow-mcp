// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Capture Angular Ivy views from the DOM as a fallback for verified store binding.

import { isNgLViewMap, readOwn, resolveLView, withLViewMapCapture } from "./angular";
import { delay, hoverProbe } from "./dom";
import { projectStoreFormats, withMutationAliases } from "./frontend_builds";
import {
  clearProjectStore,
  currentProjectStore,
  findProjectStoreInView,
  indexTileRows,
  installProjectStore,
  isAngularSignal,
  isCurrent,
  isProjectKey,
  projectInRoute,
  resolveAsyncMutator,
  selectProjectStoreCandidate,
} from "./project_store";
import type { ProjectStore } from "./project_store";
import { runtimeState } from "./state";
import type { DiscoverStoreResult, FlowStoreHandle, FlowTile, NgLView } from "./types";

/** Component hosts and shell selectors that carry Angular contexts in Google Flow. */
const STORE_HOST_SELECTORS = [
  "flow-project-shell",
  "flow-project-page",
  "flow-character-edit-page",
  "flow-character-edit-header",
  "flow-character-form",
  "flow-character-preview-panel",
  "flow-character-image-preview",
  "flow-edit-character-footer",
  "flow-character-header",
  "flow-editor-dispatcher",
  "flow-editor-page",
  "flow-scene-builder",
  "flow-scene-timeline",
  "flow-grid-tile-container",
  'button[aria-label="Settings trigger"]',
  "[mattooltip]",
  "button[aria-label]",
  "aisandbox-root",
  "app-root",
  "header",
  "main",
] as const;

/** Validates that `candidate` is a tile map keyed by tile ID. */
function validateTileMap(candidate: unknown, allowEmpty = false): Map<string, FlowTile> | null {
  if (!(candidate instanceof Map)) return null;
  if (candidate.size === 0) return allowEmpty ? (candidate as Map<string, FlowTile>) : null;
  const indexed = new Map<string, FlowTile>();
  for (const [key, tile] of candidate.entries()) {
    if (
      typeof key !== "string" ||
      !key ||
      !tile ||
      typeof tile !== "object" ||
      typeof readOwn(tile, "id") !== "string" ||
      typeof readOwn(tile, "type") !== "string"
    ) {
      return null;
    }
    indexed.set(String(readOwn(tile, "id") || key), tile as FlowTile);
  }
  return indexed;
}

/** Extracts a tile map from a `PROJECT_TILES` query result object or array. */
function extractQueryTiles(data: unknown): Map<string, FlowTile> | null {
  const direct = indexTileRows(data) ?? validateTileMap(data, true);
  if (direct) return direct;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  for (const format of projectStoreFormats()) {
    const byKnownField = indexTileRows(readOwn(data, format.rows));
    if (byKnownField) return byKnownField;
  }
  for (const key of Object.keys(data)) {
    const candidate = indexTileRows(readOwn(data, key));
    if (candidate) return candidate;
  }
  return null;
}

/** Returns true when `obj` carries a destroyed Angular lifecycle controller. */
function hasDestroyedLifecycle(obj: object): boolean {
  for (const format of projectStoreFormats()) {
    const lc = readOwn(obj, format.lifecycle);
    if (lc && typeof lc === "object" && Boolean(readOwn(lc, format.destroyed))) {
      return true;
    }
  }
  return false;
}

/** Collects live non-DOM objects reachable from rendered Angular views. */
function collectLiveViewObjects(allMaps: Set<Map<unknown, unknown>>): object[] {
  const seenViews = new Set<NgLView>();
  const objects: object[] = [];
  const seenObjects = new Set<object>();
  const addObject = (cand: unknown, depth: number): void => {
    if (
      !cand ||
      typeof cand !== "object" ||
      cand instanceof Node ||
      cand instanceof Window ||
      Array.isArray(cand) ||
      cand instanceof Map ||
      seenObjects.has(cand)
    ) {
      return;
    }
    seenObjects.add(cand);
    objects.push(cand);
    if (depth <= 0) return;
    const keys = Object.keys(cand);
    for (let i = 0; i < keys.length && i < 24; i += 1) {
      addObject(Object.getOwnPropertyDescriptor(cand, keys[i])?.value, depth - 1);
    }
  };
  const visitView = (view: NgLView | null): void => {
    let cur = view;
    for (let d = 0; d < 6 && Array.isArray(cur); d += 1) {
      if (!seenViews.has(cur)) {
        seenViews.add(cur);
        for (const slot of cur) addObject(slot, 2);
      }
      cur = Array.isArray(cur[3]) ? cur[3] : Array.isArray(cur[15]) ? cur[15] : null;
    }
  };

  for (const el of document.querySelectorAll(STORE_HOST_SELECTORS.join(", "))) {
    let cur: Element | null = el;
    for (let steps = 0; cur && steps < 8; steps += 1) {
      visitView(resolveLView(cur));
      cur = cur.parentElement;
    }
  }
  for (const map of allMaps) {
    if (!isNgLViewMap(map)) continue;
    for (const view of map.values()) visitView(view);
  }
  return objects;
}

/** Discovers a read/mutate `FlowStoreHandle` when direct `ProjectStore` class binding fails. */
function installFallbackStore(
  projectId: string,
  allMaps: Set<Map<unknown, unknown>>,
): boolean {
  const objects = collectLiveViewObjects(allMaps);
  let mutatorRunner: ((payload: Record<string, unknown>) => Promise<unknown>) | null = null;
  for (const obj of objects) {
    if (hasDestroyedLifecycle(obj)) continue;
    for (const format of projectStoreFormats()) {
      const runner = resolveAsyncMutator(obj, readOwn(obj, format.mutator));
      if (runner) {
        mutatorRunner = (rawPayload) => runner(withMutationAliases(rawPayload));
        break;
      }
    }
    if (mutatorRunner) break;
  }

  let getTileMap: (() => Map<string, FlowTile> | null) | null = null;
  let isPending = (): boolean => false;

  for (const obj of objects) {
    const rawCache = readOwn(obj, "queryCache");
    const getQueryCache = readOwn(obj, "getQueryCache");
    let cache: unknown = rawCache;
    if ((!cache || typeof cache !== "object") && typeof getQueryCache === "function") {
      try {
        cache = getQueryCache.call(obj);
      } catch {
        cache = null;
      }
    }
    if (!cache || typeof cache !== "object") continue;
    const findQuery = (): Record<string, unknown> | null => {
      const findFn = readOwn(cache, "find");
      if (typeof findFn === "function") {
        try {
          const hit: unknown = findFn.call(cache, {
            queryKey: ["PROJECT_TILES", projectId],
            exact: true,
          });
          if (hit && typeof hit === "object" && isProjectKey(readOwn(hit, "queryKey"), projectId)) {
            return hit as Record<string, unknown>;
          }
        } catch {
          // Fall through to `getAll`.
        }
      }
      const getAllFn = readOwn(cache, "getAll");
      if (typeof getAllFn === "function") {
        try {
          const all: unknown = getAllFn.call(cache);
          if (Array.isArray(all)) {
            const hit = all.find(
              (q) => q && typeof q === "object" && isProjectKey(readOwn(q, "queryKey"), projectId),
            ) as Record<string, unknown> | undefined;
            if (hit) return hit;
          }
        } catch {
          // Ignore non-TanStack caches.
        }
      }
      return null;
    };
    const initial = findQuery();
    if (!initial) continue;
    const initialState = readOwn(initial, "state");
    if (
      readOwn(initialState, "status") === "pending" ||
      extractQueryTiles(readOwn(initialState, "data")) instanceof Map
    ) {
      isPending = () => readOwn(readOwn(findQuery(), "state"), "status") === "pending";
      getTileMap = () => {
        const current = findQuery();
        if (!current) return null;
        const state = readOwn(current, "state");
        if (readOwn(state, "status") === "pending") return null;
        return extractQueryTiles(readOwn(state, "data"));
      };
      break;
    }
  }

  if (!getTileMap) {
    for (const obj of objects) {
      if (hasDestroyedLifecycle(obj)) continue;
      for (const key of Object.keys(obj)) {
        const val = Object.getOwnPropertyDescriptor(obj, key)?.value;
        const mapVal = validateTileMap(val);
        if (mapVal) {
          getTileMap = () =>
            hasDestroyedLifecycle(obj) ? null : validateTileMap(readOwn(obj, key), true);
          break;
        }
        if (typeof val === "function" && val.length === 0 && (isAngularSignal(val) || key === "ka")) {
          try {
            const out: unknown = val.call(obj);
            const fromSignal = validateTileMap(out) ?? indexTileRows(out);
            if (fromSignal) {
              getTileMap = () => {
                if (hasDestroyedLifecycle(obj)) return null;
                try {
                  const next: unknown = val.call(obj);
                  return validateTileMap(next, true) ?? indexTileRows(next);
                } catch {
                  return null;
                }
              };
              break;
            }
          } catch {
            // Ignore throwing getters.
          }
        }
      }
      if (getTileMap) break;
    }
  }

  if (!getTileMap) {
    for (const map of allMaps) {
      if (isNgLViewMap(map)) continue;
      const validated = validateTileMap(map);
      if (validated) {
        getTileMap = () => validateTileMap(map, true);
        break;
      }
    }
  }

  if (!getTileMap) return false;
  const readTiles = getTileMap;
  const handle: FlowStoreHandle = {
    projectId,
    isCurrent: () => projectInRoute() === projectId,
    getTileMap: () => (projectInRoute() === projectId ? readTiles() : null),
    isReady: () => projectInRoute() === projectId && !isPending(),
    ...(mutatorRunner
      ? {
          mutate: mutatorRunner,
          rename: (id: string, displayName: string) =>
            mutatorRunner({
              type: "single_tile",
              Xc: id,
              Uc: id,
              Ve: { type: "set_display_name", displayName },
            }),
        }
      : {}),
  };
  runtimeState.projectId = projectId;
  runtimeState.routePath = location.pathname;
  runtimeState.store = handle;
  return true;
}

/** Walks connected DOM elements and parent LViews to find a candidate `ProjectStore`. */
function scanDomStore(projectId: string): ProjectStore | null {
  const seen = new Set<object>();
  const candidates: ProjectStore[] = [];
  const collectFromElement = (el: Element): void => {
    let view: NgLView | null = resolveLView(el);
    for (let depth = 0; depth < 6 && Array.isArray(view); depth += 1) {
      candidates.push(...findProjectStoreInView(view, projectId, seen));
      view = Array.isArray(view[3]) ? view[3] : Array.isArray(view[15]) ? view[15] : null;
    }
  };

  for (const el of document.querySelectorAll(STORE_HOST_SELECTORS.join(", "))) {
    let cur: Element | null = el;
    for (let steps = 0; cur && steps < 12; steps += 1) {
      collectFromElement(cur);
      cur = cur.parentElement;
    }
  }
  if (!candidates.length) {
    const allElements = document.querySelectorAll("*");
    const limit = Math.min(allElements.length, 600);
    for (let i = 0; i < limit; i += 1) {
      collectFromElement(allElements[i]);
    }
  }
  return selectProjectStoreCandidate(candidates) ?? null;
}

/** Captures Angular's LView map via hover probing when not yet recorded in `runtimeState`. */
async function ensureLViewMap(): Promise<void> {
  if (runtimeState.ngLViewMap instanceof Map) return;
  await withLViewMapCapture(async () => {
    const targets = Array.from(
      document.querySelectorAll(
        "[mattooltip], [cdkoverlayorigin], button[aria-label], flow-prompt-box, flow-project-page, flow-scene-builder, flow-character-edit-page",
      ),
    );
    const visible = targets.filter((el) => el.getClientRects().length > 0);
    await hoverProbe((visible.length > 0 ? visible : targets).slice(0, 12), 25);
  });
}

/** Captures Map accesses while running `probe` and searches captured views for a candidate store. */
async function captureStoreDuring(
  projectId: string,
  allMaps: Set<Map<unknown, unknown>>,
  probe: () => Promise<void>,
): Promise<ProjectStore | null> {
  const seenViews = new Set<NgLView>();
  await withLViewMapCapture(probe, (map, value) => {
    allMaps.add(map);
    if (Array.isArray(value)) seenViews.add(value);
  });

  const seen = new Set<object>();
  const candidates: ProjectStore[] = [];
  for (const view of seenViews) {
    candidates.push(...findProjectStoreInView(view, projectId, seen));
  }
  for (const map of allMaps) {
    if (!(runtimeState.ngLViewMap instanceof Map) && isNgLViewMap(map)) {
      runtimeState.ngLViewMap = map;
    }
    try {
      for (const value of map.values()) {
        candidates.push(...findProjectStoreInView(value, projectId, seen));
      }
    } catch {
      // Skip non-Map prototypes or concurrent map mutations.
    }
  }
  return selectProjectStoreCandidate(candidates) ?? null;
}

/** Binds the project store from DOM contexts, transient Angular view activity, or query state. */
export async function discoverStore(): Promise<DiscoverStoreResult> {
  const projectId = projectInRoute();
  if (!projectId) {
    clearProjectStore();
    return { bound: false, newlyDiscovered: false, error: "not_in_project" };
  }

  const existing = currentProjectStore(projectId);
  if (existing) {
    runtimeState.routePath = location.pathname;
    return { bound: true, newlyDiscovered: false };
  }
  if (
    runtimeState.store &&
    runtimeState.projectId === projectId &&
    runtimeState.store.isCurrent() &&
    runtimeState.store.getTileMap() instanceof Map &&
    !scanDomStore(projectId)
  ) {
    runtimeState.routePath = location.pathname;
    return { bound: true, newlyDiscovered: false };
  }

  clearProjectStore();

  let found = scanDomStore(projectId);
  if (found) {
    await ensureLViewMap();
    if (!isCurrent(found)) found = scanDomStore(projectId);
    if (found) {
      installProjectStore(found);
      return { bound: true, newlyDiscovered: true };
    }
  }

  const allMaps = new Set<Map<unknown, unknown>>();
  if (runtimeState.ngLViewMap instanceof Map) {
    allMaps.add(runtimeState.ngLViewMap);
  }

  for (const selector of STORE_HOST_SELECTORS) {
    if (found) break;
    const targets = document.querySelectorAll(selector);
    if (targets.length === 0) continue;
    found = await captureStoreDuring(projectId, allMaps, async () => {
      await hoverProbe(Array.from(targets).slice(0, 6), 25);
    });
    if (!found) found = scanDomStore(projectId);
  }

  if (!found) {
    const scroller = document.querySelector(".page-container, cdk-virtual-scroll-viewport");
    if (scroller) {
      const prev = scroller.scrollTop;
      found = await captureStoreDuring(projectId, allMaps, async () => {
        scroller.scrollTop = Math.min(scroller.scrollHeight, prev + 200);
        scroller.dispatchEvent(new Event("scroll"));
        await delay(50);
        scroller.scrollTop = prev;
        scroller.dispatchEvent(new Event("scroll"));
        await delay(50);
      });
    }
  }

  if (found) {
    await ensureLViewMap();
    if (!isCurrent(found)) found = scanDomStore(projectId);
    if (found) {
      installProjectStore(found);
      return { bound: true, newlyDiscovered: true };
    }
  }

  await ensureLViewMap();
  if (runtimeState.ngLViewMap instanceof Map) {
    allMaps.add(runtimeState.ngLViewMap);
  }
  if (installFallbackStore(projectId, allMaps)) {
    return { bound: true, newlyDiscovered: true };
  }
  return { bound: false, newlyDiscovered: false };
}
