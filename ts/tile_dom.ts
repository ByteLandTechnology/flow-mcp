// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Locate project tiles in the page, read their state from the bound store, and dispatch page view and text control actions.

import { collectionIdOf, delay, dismissOverlay, legacyTile } from "./dom";
import { openView, readText, readView, selectText, textPoint } from "./page_view";
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

/** Finds the tile of `id` in the page by its media ID. */
async function locateTile(id: string): Promise<Record<string, unknown>> {
  const tileMap = runtimeState.store?.getTileMap?.();
  if (!(tileMap instanceof Map)) return { ok: false, error: "store_not_bound" };
  const mediaIds = mediaIdsOf(tileMap.get(id));
  if (mediaIds.length === 0) return { ok: false, error: "tile_media_id_unknown" };
  // The page has no tile ID. A media ID that two tiles show cannot identify one tile.
  if (mediaIsShared(tileMap, id, mediaIds)) {
    return { ok: false, error: "tile_media_ambiguous" };
  }
  return locateContainer(() => findContainers(mediaIds));
}

/** Returns the text lines of a grid tile, without empty lines. */
function tileLines(el: HTMLElement): string[] {
  return (el.innerText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Finds the folder tile of the collection `name` in the main grid and returns its item count. The first text line of a folder tile is the name. A folder tile with items also shows an icon word and the item count, and an empty one shows no count. */
async function locateCollectionTile(name: string): Promise<Record<string, unknown>> {
  const want = name.trim();
  if (!want) return { ok: false, error: "collection_name_empty" };
  const find = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>("flow-grid-tile-container")).filter(
      (el) => tileLines(el)[0] === want,
    );
  const loc = await locateContainer(find);
  if (loc.ok !== true) return loc;
  // Read the item count from the tile again, after the last scroll.
  const tiles = find();
  if (tiles.length !== 1) return { ok: false, error: "tile_ambiguous" };
  const counts = tileLines(tiles[0])
    .slice(1)
    .flatMap((line) => line.split(/\s+/))
    .filter((word) => /^\d+$/.test(word))
    .map(Number);
  if (counts.length > 1) return { ok: false, error: "collection_count_unknown" };
  return { ...loc, count: counts[0] ?? 0 };
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

/** Runs one page action. `locate` and `collection_tile` find a tile in the page, `state` reads the store state of a tile, `view` and `open_view` read and change the page view, `text_point`, `text_select`, and `text_value` use a text control, and `dismiss` closes an open menu. */
export async function tileDomOp(req: TileDomOpRequest): Promise<unknown> {
  const action = String(req?.action || "");
  const id = String(req?.id || "");
  const control = String(req?.control || "");
  const name = String(req?.name || "");
  if (action === "locate") return locateTile(id);
  if (action === "collection_tile") return locateCollectionTile(name);
  if (action === "state") return tileState(id);
  if (action === "view") return readView();
  if (action === "open_view") return openView(id);
  if (action === "text_point") return textPoint(control, name);
  if (action === "text_select") return selectText(control, name);
  if (action === "text_value") return readText(control, name);
  if (action === "dismiss") {
    await dismissOverlay();
    return { ok: true };
  }
  return { ok: false, error: `unknown_tile_dom_op:${action}` };
}
