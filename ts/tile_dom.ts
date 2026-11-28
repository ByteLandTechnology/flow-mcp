// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Locate project tiles in the page, read their state from the bound store, and dispatch page view and text control actions.

import {
  isAngularSignal,
  readOwn,
  resolveLView,
  withLViewMapCapture,
  type NgContextCarrier,
} from "./angular";
import {
  collectionIdOf,
  delay,
  dismissOverlay,
  elText,
  hoverProbe,
  isTrashedTile,
  isVisibleEnabled,
  legacyTile,
} from "./dom";
import { openView, readText, readView, selectText } from "./page_view";
import { runtimeState } from "./state";
import type { FlowTile, NgLView, TileDomOpRequest, ViewportPoint } from "./types";

/** Returns the media IDs that the page can show for the store tile `raw`. */
function mediaIdsOf(raw: FlowTile | null | undefined): string[] {
  const t = legacyTile(raw);
  if (!t) return [];
  const ids = [t.primaryMediaId, t.Fb?.id, t.Fb?.mediaId, t.mediaId];
  return Array.from(
    new Set(
      ids
        .filter((v) => v !== undefined && v !== null && v !== "")
        .map(String),
    ),
  );
}

/** Returns true when a store tile other than `id` shows one of `mediaIds`. */
function mediaIsShared(
  tileMap: Map<string, FlowTile>,
  id: string,
  mediaIds: string[],
): boolean {
  for (const [otherId, other] of tileMap.entries()) {
    if (otherId === id) continue;
    if (mediaIdsOf(other).some((m) => mediaIds.includes(m))) return true;
  }
  return false;
}

/** Captures the Angular `LView` map from rendered grid containers when numeric contexts are active. */
async function ensureGridLViewMap(): Promise<void> {
  if (runtimeState.ngLViewMap instanceof Map) return;
  const containers = Array.from(
    document.querySelectorAll<HTMLElement>("flow-grid-tile-container"),
  );
  const needsMap = containers.some(
    (el) => typeof (el as NgContextCarrier).__ngContext__ === "number",
  );
  if (!needsMap) return;
  const probes: Element[] = [];
  for (const el of containers.slice(0, 4)) {
    probes.push(el);
    const btn = el.querySelector("button, [mattooltip]");
    if (btn) probes.push(btn);
  }
  await withLViewMapCapture(() => hoverProbe(probes, 20));
}

/** Returns true when `cand` is a single tile record whose identifier matches `id` or `target`. */
function objectMatchesTile(cand: unknown, id: string, target: FlowTile): boolean {
  if (cand === target) return true;
  if (
    !cand ||
    typeof cand !== "object" ||
    cand instanceof Node ||
    cand instanceof Map ||
    cand instanceof Set ||
    cand instanceof Error ||
    Array.isArray(cand)
  ) {
    return false;
  }
  const candId = readOwn(cand, "id");
  return candId !== undefined && candId !== null && String(candId) === id;
}

/** Verified property and Angular input signal names that hold a grid tile record. */
const TILE_SLOT_KEYS = ["tile", "Ia", "Oa"] as const;

/** Returns true when one `LView` slot or allow-listed Angular input signal binds `id`. */
function slotMatchesTile(slot: unknown, id: string, target: FlowTile): boolean {
  if (objectMatchesTile(slot, id, target)) return true;
  if (
    !slot ||
    typeof slot !== "object" ||
    slot instanceof Node ||
    slot instanceof Map ||
    slot instanceof Set ||
    slot instanceof Error ||
    Array.isArray(slot)
  ) {
    return false;
  }
  for (const key of TILE_SLOT_KEYS) {
    const desc = Object.getOwnPropertyDescriptor(slot, key);
    if (!desc || !("value" in desc)) continue;
    const val: unknown = desc.value;
    if (objectMatchesTile(val, id, target)) return true;
    if (typeof val === "function" && val.length === 0 && isAngularSignal(val)) {
      try {
        if (objectMatchesTile(val.call(slot), id, target)) return true;
      } catch {
        // Ignore unset Angular required input signals.
      }
    }
  }
  return false;
}

/** Returns true when `view` belongs exclusively to `container` rather than the whole grid. */
function isSingleTileView(view: NgLView, container: HTMLElement): boolean {
  const hasOtherContainer = view.some(
    (s) => s instanceof Element && s.tagName === "FLOW-GRID-TILE-CONTAINER" && s !== container,
  );
  if (hasOtherContainer) return false;
  const root = view[0];
  if (root instanceof Element) {
    if (container.contains(root)) return true;
    return (
      root.contains(container) &&
      root.querySelectorAll("flow-grid-tile-container").length <= 1
    );
  }
  return view.some((s) => s === container || (s instanceof Node && container.contains(s)));
}

/** Returns true when `container`'s scoped Angular `LView` slots bind tile `id`. */
function containerMatchesTile(container: HTMLElement, id: string, target: FlowTile): boolean {
  const views = new Set<NgLView>();
  const addHostView = (el: Element, checkParent: boolean): void => {
    const lv = resolveLView(el);
    if (!Array.isArray(lv)) return;
    views.add(lv);
    if (!checkParent) return;
    for (const parent of [lv[3], lv[15]]) {
      if (Array.isArray(parent) && isSingleTileView(parent, container)) {
        views.add(parent);
      }
    }
  };
  addHostView(container, true);
  for (const child of Array.from(container.querySelectorAll("*")).slice(0, 24)) {
    if (child.tagName.includes("-") || "__ngContext__" in child) {
      addHostView(child, false);
    }
  }
  for (const lv of views) {
    if (lv.some((slot) => slotMatchesTile(slot, id, target))) return true;
  }
  return false;
}

/** Returns rendered `flow-grid-tile-container` elements whose `LView` slots match `id`. */
function findContainersByLView(id: string, target: FlowTile): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("flow-grid-tile-container"),
  ).filter((el) => containerMatchesTile(el, id, target));
}

/** Returns the rendered grid tiles that show one of `mediaIds`. */
function findContainers(mediaIds: string[]): HTMLElement[] {
  const found = new Set<HTMLElement>();
  for (const el of Array.from(document.querySelectorAll("[data-media-id]"))) {
    if (!mediaIds.includes(el.getAttribute("data-media-id") || "")) continue;
    const container = el.closest<HTMLElement>("flow-grid-tile-container");
    if (container) found.add(container);
  }
  return Array.from(found);
}

/** Returns the viewport center of `el`. */
function centerOf(el: Element): ViewportPoint {
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Returns true when `el` scrolls its content on the vertical axis. */
function scrollsVertically(el: HTMLElement): boolean {
  if (el.scrollHeight <= el.clientHeight + 10) return false;
  const overflow = getComputedStyle(el).overflowY;
  return overflow === "auto" || overflow === "scroll";
}

/** Returns the element that scrolls the tile grid: the nearest scrolling ancestor of a rendered tile, or the largest scrolling element of the page. */
function findScroller(): HTMLElement | null {
  const tile = document.querySelector<HTMLElement>("flow-grid-tile-container");
  for (let el = tile?.parentElement ?? null; el; el = el.parentElement) {
    if (scrollsVertically(el)) return el;
  }
  let best: HTMLElement | null = null;
  let bestArea = 0;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
    const area = el.clientWidth * el.clientHeight;
    if (area > bestArea && scrollsVertically(el)) {
      best = el;
      bestArea = area;
    }
  }
  return best;
}

/** Scrolls the grid from the top until `find` returns the tiles to use, and returns the points of the single tile and of its "More options" button. */
async function locateContainer(find: () => HTMLElement[]): Promise<Record<string, unknown>> {
  let container: HTMLElement | undefined = find()[0];
  const scroller = findScroller();
  if (!container && scroller) {
    scroller.scrollTop = 0;
    await delay(250);
    container = find()[0];
    for (let i = 0; i < 80 && !container; i++) {
      const before = scroller.scrollTop;
      scroller.scrollTop = before + Math.max(200, scroller.clientHeight * 0.8);
      await delay(200);
      container = find()[0];
      if (scroller.scrollTop === before) break;
    }
  }
  if (!container) return { ok: false, error: "tile_not_rendered" };
  container.scrollIntoView({ block: "center" });
  await delay(300);
  // The virtual grid can replace the element after a scroll.
  const rendered = find();
  if (rendered.length > 1) return { ok: false, error: "tile_ambiguous" };
  container = rendered[0] ?? container;
  const menu = container.querySelector('button[aria-label="More options"]');
  return {
    ok: true,
    tile: centerOf(container),
    menu: menu ? centerOf(menu) : null,
  };
}

/** Finds the tile of `id` in the page by its Angular `LView` binding or media ID. */
async function locateTile(id: string): Promise<Record<string, unknown>> {
  const tileMap = runtimeState.store?.getTileMap?.();
  if (!(tileMap instanceof Map)) return { ok: false, error: "store_not_bound" };
  const target = tileMap.get(id);
  if (!target) return { ok: false, error: "tile_not_found" };
  await ensureGridLViewMap();
  const mediaIds = mediaIdsOf(target);
  const sharedMedia = mediaIds.length > 0 && mediaIsShared(tileMap, id, mediaIds);
  const find = (): HTMLElement[] => {
    const byLView = findContainersByLView(id, target);
    if (byLView.length > 0) return byLView;
    if (mediaIds.length > 0 && !sharedMedia) return findContainers(mediaIds);
    return [];
  };
  const located = await locateContainer(find);
  if (located.ok !== true && located.error === "tile_not_rendered" && sharedMedia) {
    return { ok: false, error: "tile_media_ambiguous" };
  }
  return located;
}

/** Returns true when `dialog` binds `target` in its Angular `LView` or dialog data slot. */
function dialogBindsTile(dialog: HTMLElement, id: string, target: FlowTile): boolean {
  if (containerMatchesTile(dialog, id, target)) return true;
  const hosts = [
    dialog,
    ...Array.from(dialog.querySelectorAll("*")).filter(
      (el) => el.tagName.includes("-") || "__ngContext__" in el,
    ),
  ].slice(0, 24);
  for (const host of hosts) {
    const lv = resolveLView(host);
    if (!Array.isArray(lv)) continue;
    for (const slot of lv) {
      const data = readOwn(slot, "data");
      if (
        objectMatchesTile(data, id, target) ||
        objectMatchesTile(readOwn(data, "tile"), id, target)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Returns true when `dialog` describes moving single tile `target` to trash and not another tile. */
function dialogMatchesTrashTarget(
  dialog: HTMLElement,
  id: string,
  target: FlowTile,
  tileMap: Map<string, FlowTile>,
): boolean {
  const dialogText = elText(dialog);
  if (!/\bmove\b[\s\S]*\bto trash\b/i.test(dialogText)) return false;
  const tileType = String(target.type || "IMAGE").toUpperCase();
  if (tileType !== "COLLECTION" && /\bcollection\b/i.test(dialogText)) return false;
  if (/\b(?:chat|project|app|tool)\b/i.test(dialogText)) return false;
  if (dialogBindsTile(dialog, id, target)) return true;
  let seenOther = 0;
  for (const [otherId, otherTile] of tileMap.entries()) {
    if (++seenOther > 200) break;
    if (otherId === id || !otherTile || isTrashedTile(otherTile)) continue;
    if (dialogBindsTile(dialog, otherId, otherTile)) return false;
  }
  const lowerText = dialogText.toLowerCase();
  const displayName = String(target.displayName || "").trim();
  if (displayName && lowerText.includes(displayName.toLowerCase())) {
    return true;
  }
  seenOther = 0;
  for (const [otherId, otherTile] of tileMap.entries()) {
    if (++seenOther > 200) break;
    if (otherId === id || !otherTile || isTrashedTile(otherTile)) continue;
    const otherName = String(otherTile.displayName || "").trim();
    if (
      otherName.length >= 2 &&
      otherName.toLowerCase() !== displayName.toLowerCase() &&
      lowerText.includes(otherName.toLowerCase())
    ) {
      return false;
    }
  }
  const kindWord =
    tileType === "SCENE"
      ? "(?:scene|item|asset)"
      : tileType === "CHARACTER"
        ? "(?:character|item|asset)"
        : tileType === "VIDEO"
          ? "(?:video|clip|media|item|asset)"
          : "(?:image|media|item|asset)";
  return new RegExp(`\\bmove\\s+(?:this\\s+)?${kindWord}\\s+to\\s+trash\\b`, "i").test(dialogText);
}

/** Finds the confirm button of an open trash dialog for tile `id` and returns its viewport point. */
function confirmTrashDialog(id: string): Record<string, unknown> {
  const tileMap = runtimeState.store?.getTileMap?.();
  if (!(tileMap instanceof Map)) return { ok: false, error: "store_not_bound" };
  const target = tileMap.get(id);
  if (!target) return { ok: false, error: "tile_not_found" };
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], mat-dialog-container',
    ),
  )
    .filter((el) => el.getClientRects().length > 0)
    .reverse();
  const buttonPattern =
    /^(?:(?:delete|delete_forever|warning)\s+)?move(?:\s+(?:this\s+)?(?:item|asset|media|image|video|clip|scene|character))?\s+to\s+trash$/i;
  for (const dialog of dialogs) {
    if (!dialogMatchesTrashTarget(dialog, id, target, tileMap)) continue;
    for (const btn of Array.from(dialog.querySelectorAll("button"))) {
      if (!isVisibleEnabled(btn)) continue;
      if (buttonPattern.test(elText(btn))) {
        return { ok: true, point: centerOf(btn) };
      }
    }
  }
  return { ok: false, error: "dialog_confirm_not_found" };
}

/** Returns `present`, `trashed`, or `gone` for the store tile `id`, with its name and its collection ID while it is present. */
function tileState(id: string): Record<string, unknown> {
  const tileMap = runtimeState.store?.getTileMap?.();
  if (!(tileMap instanceof Map)) return { ok: false, error: "store_not_bound" };
  const t = tileMap.get(id);
  if (!t) return { ok: true, state: "gone" };
  const isCollectionId = (v: string): boolean =>
    String(tileMap.get(v)?.type || "").toUpperCase() === "COLLECTION";
  return {
    ok: true,
    state: isTrashedTile(t) ? "trashed" : "present",
    name: String(t.displayName ?? ""),
    collection: collectionIdOf(t, isCollectionId),
  };
}

/** Finds an asset tile, changes the grid view, or uses the asset rename control. */
export async function tileDomOp(req: TileDomOpRequest): Promise<unknown> {
  const action = String(req?.action || "");
  const id = String(req?.id || "");
  if (action === "locate") return locateTile(id);
  if (action === "state") return tileState(id);
  if (action === "view") return readView();
  if (action === "open_view") return openView(id);
  if (action === "text_select") return selectText();
  if (action === "text_value") return readText();
  if (action === "confirm_dialog") return confirmTrashDialog(id);
  if (action === "dismiss") {
    await dismissOverlay();
    return { ok: true };
  }
  return { ok: false, error: `unknown_tile_dom_op:${action}` };
}
