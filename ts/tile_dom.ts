// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Locate project tiles in the page, read their state from the bound store, and dispatch page view and text control actions.

import { readOwn, resolveLView } from "./angular";
import {
  characterLooksOf,
  collectionIdOf,
  delay,
  dismissOverlay,
  fifeBase,
  isTrashedTile,
  legacyTile,
} from "./dom";
import { openView, readText, readView, selectText, textPoint } from "./page_view";
import { sceneContents } from "./scene_tiles";
import { runtimeState } from "./state";
import type { FlowTile, TileDomOpRequest, ViewportPoint } from "./types";

/** Lowercase tile kind for a store tile. */
function kindOf(raw: FlowTile | null | undefined): string {
  return String(raw?.type || "").toLowerCase();
}

/** Normalizes a media URL to its `/asb/...` token or FIFE base URL for DOM matching. */
function normalizedMediaKey(rawUrl: unknown): string {
  const base = fifeBase(rawUrl);
  if (!base) return "";
  const asb = /(\/asb\/[^/?#=]+)/.exec(base);
  return asb ? asb[1] : base;
}

/** Returns the media IDs that the page can show for the store tile `raw`. */
function mediaIdsOf(raw: FlowTile | null | undefined): string[] {
  if (!raw) return [];
  const t = legacyTile(raw);
  if (!t) return [];
  const ids: unknown[] = [t.primaryMediaId, t.Fb?.id, t.Fb?.mediaId, t.mediaId];
  const looks = characterLooksOf(raw);
  if (looks instanceof Map) {
    for (const entry of looks.values()) {
      ids.push(entry?.primaryMediaId, entry?.media?.id, entry?.media?.mediaId);
      if (Array.isArray(entry?.history)) {
        for (const item of entry.history) {
          ids.push(item?.primaryMediaId, item?.media?.id);
        }
      }
    }
  }
  const { clips } = sceneContents(raw);
  for (const clip of clips) {
    ids.push(clip?.primaryMediaId, clip?.workflowId);
  }
  return Array.from(
    new Set(
      ids
        .filter((v) => v !== undefined && v !== null && v !== "")
        .map(String),
    ),
  );
}

/** Returns normalized media URL keys that a rendered tile element can carry in `src`. */
function mediaUrlsOf(raw: FlowTile | null | undefined): string[] {
  if (!raw) return [];
  const t = legacyTile(raw);
  if (!t) return [];
  const urls: unknown[] = [
    t.ue,
    t.Wb,
    t.fifeUrl,
    t.imageUrl,
    t.videoUrl,
    t.url,
    t.Fb?.Wb,
    t.Fb?.fifeUrl,
    t.Fb?.Bd,
    t.Fb?.uA,
    t.Fb?.videoUrl,
    t.Fb?.imageUrl,
    t.Fb?.url,
  ];
  const looks = characterLooksOf(raw);
  if (looks instanceof Map) {
    for (const entry of looks.values()) {
      urls.push(entry?.Wb, entry?.fifeUrl, entry?.imageUrl, entry?.url, entry?.media?.Wb);
    }
  }
  const { clips } = sceneContents(raw);
  for (const clip of clips) {
    urls.push(clip?.Wb, clip?.fifeUrl, clip?.Bd, clip?.uA, clip?.videoUrl);
  }
  return Array.from(
    new Set(
      urls
        .map(normalizedMediaKey)
        .filter((v) => v.length > 0),
    ),
  );
}

/** Returns true when another active tile in the same view shares any value from `values`. */
function valuesSharedInView(
  tileMap: Map<string, FlowTile>,
  id: string,
  viewCollection: string | null,
  isCollectionId: (v: string) => boolean,
  extract: (tile: FlowTile) => string[],
  values: string[],
): boolean {
  for (const [otherId, other] of tileMap.entries()) {
    if (otherId === id || isTrashedTile(other)) continue;
    if (collectionIdOf(other, isCollectionId) !== viewCollection) continue;
    if (extract(other).some((item) => values.includes(item))) return true;
  }
  return false;
}

/** Returns true when `el` is rendered with non-zero layout bounds. */
function isRendered(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Checks whether an Angular context on `container` or its child tile host binds `id`. */
function containerBindsTileId(container: HTMLElement, id: string, raw: FlowTile): boolean {
  if (
    container.getAttribute("data-tile-id") === id ||
    container.getAttribute("data-item-id") === id
  ) {
    return true;
  }
  const hosts: Element[] = [
    container,
    ...Array.from(
      container.querySelectorAll(
        "flow-image-tile, flow-video-tile, flow-character-tile, flow-scene-tile, flow-collection-tile",
      ),
    ),
  ];
  for (const host of hosts) {
    if (
      host.getAttribute("data-tile-id") === id ||
      host.getAttribute("data-item-id") === id
    ) {
      return true;
    }
    const lview = resolveLView(host);
    if (!Array.isArray(lview)) continue;
    for (let i = 0; i < Math.min(lview.length, 80); i++) {
      const slot = lview[i];
      if (!slot || typeof slot !== "object") continue;
      if (slot === raw) return true;
      if (readOwn(slot, "id") === id && typeof readOwn(slot, "type") === "string") {
        return true;
      }
      for (const key of Object.keys(slot)) {
        const val = readOwn(slot, key);
        if (val === raw) return true;
        if (val && typeof val === "object" && readOwn(val, "id") === id) {
          return true;
        }
        if (
          typeof val === "function" &&
          val.length === 0 &&
          Object.getOwnPropertySymbols(val).length > 0
        ) {
          try {
            const sigVal = val.call(slot);
            if (sigVal === raw || (sigVal && typeof sigVal === "object" && readOwn(sigVal, "id") === id)) {
              return true;
            }
          } catch {
            // Ignore signal read failures.
          }
        }
      }
    }
  }
  return false;
}

/** Returns true when `container` renders the child host expected for `kind`. */
function containerMatchesKind(container: HTMLElement, kind: string): boolean {
  const attr = (container.getAttribute("data-tile-kind") || "").toLowerCase();
  if (attr) return attr === kind;
  if (kind === "collection") {
    if (container.querySelector("flow-collection-tile")) return true;
    return !container.querySelector(
      "flow-image-tile, flow-video-tile, flow-character-tile, flow-scene-tile, [data-media-id]",
    );
  }
  if (kind === "character") return Boolean(container.querySelector("flow-character-tile"));
  if (kind === "scene") return Boolean(container.querySelector("flow-scene-tile"));
  if (kind === "image") return Boolean(container.querySelector("flow-image-tile"));
  if (kind === "video") return Boolean(container.querySelector("flow-video-tile"));
  return false;
}

/** Returns true when `container` exposes the exact display title `title`. */
function containerMatchesTitle(container: HTMLElement, title: string): boolean {
  const want = title.trim();
  if (!want) return false;
  if ((container.getAttribute("aria-label") || "").trim() === want) return true;
  for (const el of Array.from(container.querySelectorAll("*"))) {
    if ((el.getAttribute("aria-label") || "").trim() === want) return true;
    if (el.children.length === 0 && (el.textContent || "").trim() === want) {
      return true;
    }
  }
  return false;
}

/** Returns the rendered grid tiles that match `predicate`. */
function findMatchingContainers(predicate: (el: HTMLElement) => boolean): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("flow-grid-tile-container")).filter(
    (el) => isRendered(el) && predicate(el),
  );
}

/** Returns the rendered grid tiles that show one of `mediaIds`. */
function findContainersByMediaIds(mediaIds: string[]): HTMLElement[] {
  const found = new Set<HTMLElement>();
  for (const el of Array.from(document.querySelectorAll("[data-media-id]"))) {
    if (!mediaIds.includes(el.getAttribute("data-media-id") || "")) continue;
    const container = el.closest<HTMLElement>("flow-grid-tile-container");
    if (container && isRendered(container)) found.add(container);
  }
  return Array.from(found);
}

/** Returns the rendered grid tiles whose media `src` matches one of `urls`. */
function findContainersByUrls(urls: string[]): HTMLElement[] {
  return findMatchingContainers((container) =>
    Array.from(container.querySelectorAll<HTMLElement>("img[src], video[src]")).some((media) => {
      const key = normalizedMediaKey(media.getAttribute("src"));
      return Boolean(key && urls.includes(key));
    }),
  );
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

/** Finds the tile of `id` in the virtual grid for media, character, scene, or collection items. */
async function locateTile(id: string): Promise<Record<string, unknown>> {
  const tileMap = runtimeState.store?.getTileMap?.();
  if (!(tileMap instanceof Map)) return { ok: false, error: "store_not_bound" };
  const raw = tileMap.get(id);
  if (!raw || isTrashedTile(raw)) return { ok: false, error: "tile_not_found" };

  const isCollectionId = (v: string): boolean =>
    String(tileMap.get(v)?.type || "").toUpperCase() === "COLLECTION";
  const viewCollection = collectionIdOf(raw, isCollectionId);
  const kind = kindOf(raw);
  const title = String(raw.displayName ?? "").trim();

  const mediaIds = mediaIdsOf(raw);
  const canUseMediaIds =
    mediaIds.length > 0 &&
    !valuesSharedInView(tileMap, id, viewCollection, isCollectionId, mediaIdsOf, mediaIds);

  const mediaUrls = mediaUrlsOf(raw);
  const canUseUrls =
    mediaUrls.length > 0 &&
    !valuesSharedInView(tileMap, id, viewCollection, isCollectionId, mediaUrlsOf, mediaUrls);

  const titleOfKind = (tile: FlowTile): string[] => {
    if (kindOf(tile) !== kind) return [];
    const name = String(tile.displayName ?? "").trim();
    return name ? [name] : [];
  };
  const canUseTitle =
    title.length > 0 &&
    !valuesSharedInView(tileMap, id, viewCollection, isCollectionId, titleOfKind, [title]);

  const find = (): HTMLElement[] => {
    const byBinding = findMatchingContainers((el) => containerBindsTileId(el, id, raw));
    if (byBinding.length > 0) return byBinding;
    if (canUseMediaIds) {
      const byMedia = findContainersByMediaIds(mediaIds);
      if (byMedia.length > 0) return byMedia;
    }
    if (canUseUrls) {
      const byUrl = findContainersByUrls(mediaUrls);
      if (byUrl.length > 0) return byUrl;
    }
    if (canUseTitle) {
      const byTitle = findMatchingContainers(
        (el) => containerMatchesKind(el, kind) && containerMatchesTitle(el, title),
      );
      if (byTitle.length > 0) return byTitle;
    }
    return [];
  };

  if (!canUseMediaIds && !canUseUrls && !canUseTitle) {
    // Try exact Angular view binding before reporting ambiguity.
    const exact = await locateContainer(() =>
      findMatchingContainers((el) => containerBindsTileId(el, id, raw)),
    );
    if (exact.ok) return exact;
    return { ok: false, error: "tile_media_ambiguous" };
  }
  return locateContainer(find);
}

/** Expands the library sidebar if it is collapsed. */
async function ensureSidebarExpanded(): Promise<void> {
  const toggle = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button.library-expand-button, button[aria-label="Toggle library"]',
    ),
  ).find((el) => isRendered(el) && el.getAttribute("aria-expanded") !== "true");
  if (toggle && !document.querySelector("flow-nested-list")) {
    toggle.click();
    await delay(350);
  }
}

/** Finds a rendered sidebar row or grid folder tile that accepts drops for collection `id`. */
async function locateDropTarget(id: string): Promise<Record<string, unknown>> {
  const findSidebarRow = (): HTMLElement | null => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-item-id]"))) {
      if (el.getAttribute("data-item-id") === id && isRendered(el)) return el;
    }
    return null;
  };
  let row = findSidebarRow();
  if (!row) {
    await ensureSidebarExpanded();
    row = findSidebarRow();
  }
  if (row) {
    row.scrollIntoView({ block: "center" });
    await delay(150);
    const refreshed = findSidebarRow() ?? row;
    return { ok: true, target: centerOf(refreshed) };
  }
  const tileLoc = await locateTile(id);
  if (tileLoc.ok && tileLoc.tile) {
    return { ok: true, target: tileLoc.tile };
  }
  return { ok: false, error: "drop_target_not_found" };
}

/** Finds the sidebar root drop zone that moves items out of a collection. */
async function locateRootDropTarget(): Promise<Record<string, unknown>> {
  const findRoot = (): HTMLElement | null => {
    const direct = Array.from(
      document.querySelectorAll<HTMLElement>(
        "[flowNestedListRootDropZone], [flownestedlistrootdropzone], flow-nested-list [data-item-id='']",
      ),
    ).find(isRendered);
    if (direct) return direct;
    return (
      Array.from(
        document.querySelectorAll<HTMLElement>(
          "flow-nested-list button, flow-nested-list a, flow-nested-list [role='treeitem']",
        ),
      ).find(
        (el) =>
          isRendered(el) &&
          !el.hasAttribute("data-item-id") &&
          /^(?:all\s+media|library|all\s+items|project)$/i.test((el.textContent || "").trim()),
      ) ?? null
    );
  };
  let root = findRoot();
  if (!root) {
    await ensureSidebarExpanded();
    root = findRoot();
  }
  if (!root) return { ok: false, error: "root_drop_target_not_found" };
  root.scrollIntoView({ block: "center" });
  await delay(150);
  const refreshed = findRoot() ?? root;
  return { ok: true, target: centerOf(refreshed) };
}

/** Returns `present`, `trashed`, or `gone` for the store tile `id`, with kind, name, collection, and members. */
function tileState(id: string): Record<string, unknown> {
  const tileMap = runtimeState.store?.getTileMap?.();
  if (!(tileMap instanceof Map)) return { ok: false, error: "store_not_bound" };
  const t = tileMap.get(id);
  if (!t) return { ok: true, state: "gone" };
  const isCollectionId = (v: string): boolean =>
    String(tileMap.get(v)?.type || "").toUpperCase() === "COLLECTION";
  const kind = kindOf(t);
  let count = 0;
  const memberIds: string[] = [];
  let hasChildCollections = false;
  if (kind === "collection") {
    for (const [otherId, other] of tileMap.entries()) {
      if (otherId === id || isTrashedTile(other)) continue;
      if (collectionIdOf(other, isCollectionId) !== id) continue;
      if (kindOf(other) === "collection") {
        hasChildCollections = true;
      } else {
        if (other.type === "SCENE" && other.isPending === true) continue;
        count += 1;
        memberIds.push(String(other.id ?? otherId));
      }
    }
  }
  return {
    ok: true,
    state: isTrashedTile(t) ? "trashed" : "present",
    kind,
    name: String(t.displayName ?? ""),
    collection: collectionIdOf(t, isCollectionId),
    count,
    member_ids: memberIds,
    has_child_collections: hasChildCollections,
  };
}

/** Dispatches an HTML5 DragEvent sequence from `(sx, sy)` to `(tx, ty)` when native drag attributes are used. */
async function html5Drag(coords?: [number, number, number, number]): Promise<Record<string, unknown>> {
  if (!Array.isArray(coords) || coords.length !== 4) return { ok: false, error: "invalid_coords" };
  const [sx, sy, tx, ty] = coords;
  const rawSrc = document.elementFromPoint(sx, sy);
  const src = rawSrc?.closest("[draggable='true'], flow-grid-tile-container") ?? rawSrc;
  const dst = document.elementFromPoint(tx, ty);
  if (!src || !dst) return { ok: false, error: "drag_element_not_found" };
  const dt = new DataTransfer();
  const fire = (target: Element, type: string, x: number, y: number): void => {
    target.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }),
    );
  };
  fire(src, "dragstart", sx, sy);
  await delay(60);
  fire(dst, "dragenter", tx, ty);
  fire(dst, "dragover", tx, ty);
  await delay(60);
  fire(dst, "drop", tx, ty);
  fire(src, "dragend", tx, ty);
  return { ok: true };
}

/** Finds an asset tile, locates a drop target, changes the grid view, or uses a page text control. */
export async function tileDomOp(req: TileDomOpRequest): Promise<unknown> {
  const action = String(req?.action || "");
  const id = String(req?.id || "");
  const control = String(req?.control || "tile");
  const name = String(req?.name || "");
  if (action === "locate") return locateTile(id);
  if (action === "drop_target") return locateDropTarget(id);
  if (action === "root_drop_target") return locateRootDropTarget();
  if (action === "html5_drag") return html5Drag(req?.coords);
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
