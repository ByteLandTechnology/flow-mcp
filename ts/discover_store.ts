// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Capture Angular Ivy views from the DOM as a fallback for verified store binding.

import { isNgLViewMap, resolveLView, withLViewMapCapture } from "./angular";
import { delay, hoverProbe } from "./dom";
import { activeProjectStoreFormat } from "./frontend_builds";
import {
  clearProjectStore,
  currentProjectStore,
  inspectProjectStoreInView,
  installProjectStore,
  isCurrent,
  isProjectRouteLoading,
  projectInRoute,
  selectProjectStoreCandidate,
} from "./project_store";
import type { ProjectStore } from "./project_store";
import { runtimeState } from "./state";
import type { DiscoverStoreResult, NgLView } from "./types";

/** Component hosts and shell selectors that carry Angular contexts in Google Flow. */
const STORE_HOST_SELECTORS = [
  "flow-project-shell",
  "flow-project-page",
  "flow-character-page",
  "flow-character-edit-page",
  "flow-character-edit-header",
  "flow-character-form",
  "flow-character-preview-panel",
  "flow-character-image-preview",
  "flow-create-character-footer",
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

/** Result of a DOM or map-capture store scan. */
interface StoreDiscoveryScan {
  /** Selected verified store for the active project, if ready to bind. */
  readonly store: ProjectStore | null;
  /** True when a live verified store throws `NG0950` for an unset project input. */
  readonly inputPending: boolean;
}

/** Walks connected DOM elements and parent LViews to find a verified `ProjectStore`. */
function scanDomStore(projectId: string): StoreDiscoveryScan {
  const seen = new Set<object>();
  const candidates: ProjectStore[] = [];
  let inputPending = false;
  const collectFromElement = (el: Element): void => {
    let view: NgLView | null = resolveLView(el);
    for (let depth = 0; depth < 6 && Array.isArray(view); depth += 1) {
      const scan = inspectProjectStoreInView(view, projectId, seen);
      candidates.push(...scan.matches);
      inputPending ||= scan.inputPending;
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
  if (!candidates.length && !inputPending) {
    const allElements = document.querySelectorAll("*");
    const limit = Math.min(allElements.length, 600);
    for (let i = 0; i < limit; i += 1) {
      collectFromElement(allElements[i]);
    }
  }
  return {
    store: selectProjectStoreCandidate(candidates) ?? null,
    inputPending,
  };
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

/** Captures Map accesses while running `probe` and searches captured views for a verified store. */
async function captureStoreDuring(
  projectId: string,
  allMaps: Set<Map<unknown, unknown>>,
  probe: () => Promise<void>,
): Promise<StoreDiscoveryScan> {
  const seenViews = new Set<NgLView>();
  await withLViewMapCapture(probe, (map, value) => {
    allMaps.add(map);
    if (Array.isArray(value)) seenViews.add(value);
  });

  const seen = new Set<object>();
  const candidates: ProjectStore[] = [];
  let inputPending = false;
  for (const view of seenViews) {
    const scan = inspectProjectStoreInView(view, projectId, seen);
    candidates.push(...scan.matches);
    inputPending ||= scan.inputPending;
  }
  for (const map of allMaps) {
    if (!(runtimeState.ngLViewMap instanceof Map) && isNgLViewMap(map)) {
      runtimeState.ngLViewMap = map;
    }
    try {
      for (const value of map.values()) {
        const scan = inspectProjectStoreInView(value, projectId, seen);
        candidates.push(...scan.matches);
        inputPending ||= scan.inputPending;
      }
    } catch {
      // Skip non-Map prototypes or concurrent map mutations.
    }
  }
  return {
    store: selectProjectStoreCandidate(candidates) ?? null,
    inputPending,
  };
}

/** Binds the verified project store from DOM contexts or transient Angular view activity. */
export async function discoverStore(): Promise<DiscoverStoreResult> {
  if (!activeProjectStoreFormat()) {
    clearProjectStore();
    return { bound: false, newlyDiscovered: false, error: "unsupported_front_end" };
  }
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

  clearProjectStore();

  const initial = scanDomStore(projectId);
  let found = initial.store;
  let inputPending = initial.inputPending;
  if (found) {
    await ensureLViewMap();
    if (!isCurrent(found)) {
      const rescan = scanDomStore(projectId);
      found = rescan.store;
      inputPending ||= rescan.inputPending;
    }
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
    if (found || inputPending) break;
    const targets = document.querySelectorAll(selector);
    if (targets.length === 0) continue;
    const captured = await captureStoreDuring(projectId, allMaps, async () => {
      await hoverProbe(Array.from(targets).slice(0, 6), 25);
    });
    found = captured.store;
    inputPending ||= captured.inputPending;
    if (!found && !inputPending) {
      const domScan = scanDomStore(projectId);
      found = domScan.store;
      inputPending ||= domScan.inputPending;
    }
  }

  if (!found && !inputPending) {
    const scroller = document.querySelector(".page-container, cdk-virtual-scroll-viewport");
    if (scroller) {
      const prev = scroller.scrollTop;
      const captured = await captureStoreDuring(projectId, allMaps, async () => {
        scroller.scrollTop = Math.min(scroller.scrollHeight, prev + 200);
        scroller.dispatchEvent(new Event("scroll"));
        await delay(50);
        scroller.scrollTop = prev;
        scroller.dispatchEvent(new Event("scroll"));
        await delay(50);
      });
      found = captured.store;
      inputPending ||= captured.inputPending;
    }
  }

  if (found) {
    await ensureLViewMap();
    if (!isCurrent(found)) {
      const rescan = scanDomStore(projectId);
      found = rescan.store;
      inputPending ||= rescan.inputPending;
    }
    if (found) {
      installProjectStore(found);
      return { bound: true, newlyDiscovered: true };
    }
  }
  if (inputPending || isProjectRouteLoading()) {
    return { bound: false, newlyDiscovered: false, error: "store_loading" };
  }
  return { bound: false, newlyDiscovered: false };
}
