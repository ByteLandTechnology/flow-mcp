// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Locate project tiles in the page by media ID, and read their trash state from the bound store.

import { delay, dismissOverlay, legacyTile } from "./dom";
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
  const scroller = document.querySelector<HTMLElement>(
    "cdk-virtual-scroll-viewport",
  );
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

/** Returns `present`, `trashed`, or `gone` for the store tile `id`. */
function tileState(id: string): Record<string, unknown> {
  const tileMap = runtimeState.store?.getTileMap?.();
  if (!(tileMap instanceof Map)) return { ok: false, error: "store_not_bound" };
  const t = tileMap.get(id);
  if (!t) return { ok: true, state: "gone" };
  const trashed =
    t.trashed === true || t.isTrashed === true || t.yb === true || t.Ab === true;
  return { ok: true, state: trashed ? "trashed" : "present" };
}

/** Runs one tile action: `locate` finds the tile in the page, `state` reads its trash state, and `dismiss` closes an open menu. */
export async function tileDomOp(req: TileDomOpRequest): Promise<unknown> {
  const action = String(req?.action || "");
  const id = String(req?.id || "");
  if (action === "locate") return locateTile(id);
  if (action === "state") return tileState(id);
  if (action === "dismiss") {
    await dismissOverlay();
    return { ok: true };
  }
  return { ok: false, error: `unknown_tile_dom_op:${action}` };
}
