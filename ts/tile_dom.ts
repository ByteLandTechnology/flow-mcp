// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Locate project tiles in the page by media ID, read their state from the bound store, and use the rename control of the page.

import { collectionIdOf, delay, dismissOverlay, legacyTile } from "./dom";
import { runtimeState } from "./state";
import type { FlowTile, TileDomOpRequest, ViewportPoint } from "./types";

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

/** Returns the first rendered grid tile that shows one of `mediaIds`, or null. */
function findContainer(mediaIds: string[]): HTMLElement | null {
  return findContainers(mediaIds)[0] ?? null;
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

/** Scrolls the virtual grid until the tile of `id` renders, and returns the tile and its "More options" button points. */
async function locateTile(id: string): Promise<Record<string, unknown>> {
  const tileMap = runtimeState.store?.getTileMap?.();
  if (!(tileMap instanceof Map)) return { ok: false, error: "store_not_bound" };
  const mediaIds = mediaIdsOf(tileMap.get(id));
  if (mediaIds.length === 0) return { ok: false, error: "tile_media_id_unknown" };
  // The page has no tile ID. A media ID that two tiles show cannot identify one tile.
  if (mediaIsShared(tileMap, id, mediaIds)) {
    return { ok: false, error: "tile_media_ambiguous" };
  }
  let container = findContainer(mediaIds);
  const scroller = findScroller();
  if (!container && scroller) {
    scroller.scrollTop = 0;
    await delay(250);
    container = findContainer(mediaIds);
    for (let i = 0; i < 80 && !container; i++) {
      const before = scroller.scrollTop;
      scroller.scrollTop = before + Math.max(200, scroller.clientHeight * 0.8);
      await delay(200);
      container = findContainer(mediaIds);
      if (scroller.scrollTop === before) break;
    }
  }
  if (!container) return { ok: false, error: "tile_not_rendered" };
  container.scrollIntoView({ block: "center" });
  await delay(300);
  // The virtual grid can replace the element after a scroll.
  const rendered = findContainers(mediaIds);
  if (rendered.length > 1) return { ok: false, error: "tile_media_ambiguous" };
  container = rendered[0] ?? container;
  const menu = container.querySelector('button[aria-label="More options"]');
  return {
    ok: true,
    tile: centerOf(container),
    menu: menu ? centerOf(menu) : null,
  };
}

/** Returns `present`, `trashed`, or `gone` for the store tile `id`, with its name and its collection ID while it is present. */
function tileState(id: string): Record<string, unknown> {
  const tileMap = runtimeState.store?.getTileMap?.();
  if (!(tileMap instanceof Map)) return { ok: false, error: "store_not_bound" };
  const t = tileMap.get(id);
  if (!t) return { ok: true, state: "gone" };
  const trashed =
    t.trashed === true || t.isTrashed === true || t.yb === true || t.Ab === true;
  const isCollectionId = (v: string): boolean =>
    String(tileMap.get(v)?.type || "").toUpperCase() === "COLLECTION";
  return {
    ok: true,
    state: trashed ? "trashed" : "present",
    name: String(t.displayName ?? ""),
    collection: collectionIdOf(t, isCollectionId),
  };
}

/** Returns the text control of the open "Rename tile" overlay, or null. */
function renameControl(): HTMLElement | null {
  const host = Array.from(
    document.querySelectorAll<HTMLElement>('[aria-label="Rename tile"]'),
  ).find((e) => e.getClientRects().length > 0);
  if (!host) return null;
  if (host instanceof HTMLInputElement || host instanceof HTMLTextAreaElement) return host;
  return (
    host.querySelector<HTMLElement>('input, textarea, [contenteditable="true"]') ??
    (host.isContentEditable ? host : null)
  );
}

/** Returns the text of the rename control `el`. */
function renameText(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  return (el.innerText || "").trim();
}

/** Focuses the open "Rename tile" control and selects its text, so that typed text replaces the old name. */
function selectRenameText(): Record<string, unknown> {
  const el = renameControl();
  if (!el) return { ok: false, error: "rename_control_not_found" };
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.select();
  } else {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  return { ok: true, focused: document.activeElement === el, value: renameText(el) };
}

/** Returns the text of the open "Rename tile" control. */
function readRenameText(): Record<string, unknown> {
  const el = renameControl();
  if (!el) return { ok: false, error: "rename_control_not_found" };
  return { ok: true, value: renameText(el) };
}

/** Runs one tile action: `locate` finds the tile in the page, `state` reads its store state, `rename_select` and `rename_value` use the open rename control, and `dismiss` closes an open menu. */
export async function tileDomOp(req: TileDomOpRequest): Promise<unknown> {
  const action = String(req?.action || "");
  const id = String(req?.id || "");
  if (action === "locate") return locateTile(id);
  if (action === "state") return tileState(id);
  if (action === "rename_select") return selectRenameText();
  if (action === "rename_value") return readRenameText();
  if (action === "dismiss") {
    await dismissOverlay();
    return { ok: true };
  }
  return { ok: false, error: `unknown_tile_dom_op:${action}` };
}
