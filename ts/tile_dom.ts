// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Locate project tiles in the page, read their state from the bound store, and dispatch page view and text control actions.

import { isLiveLView, readOwn, resolveLView, withLViewMapCapture } from "./angular";
import {
  characterLookMedia,
  characterLooksOf,
  collectionIdOf,
  delay,
  dismissOverlay,
  elText,
  fifeBase,
  hoverProbe,
  isTrashedTile,
  legacyTile,
  normalizeFlowMediaUrl,
  pickTileUrl,
  readMediaUrl,
} from "./dom";
import { openView, readText, readView, selectText } from "./page_view";
import { isAngularSignal } from "./project_store";
import { sceneContents } from "./scene_tiles";
import { runtimeState } from "./state";
import type { FlowTile, NgLView, TileDomOpRequest, ViewportPoint } from "./types";

/** Normalizes a tile type discriminant into `"CHARACTER"`, `"SCENE"`, or `"MEDIA"`. */
function tileFamily(raw: FlowTile | null | undefined): "CHARACTER" | "SCENE" | "MEDIA" {
  const upper = String(raw?.type ?? "").toUpperCase();
  if (upper === "CHARACTER") return "CHARACTER";
  if (upper === "SCENE") return "SCENE";
  return "MEDIA";
}

/** Returns the media IDs that the page can show for the store tile `raw`. */
function mediaIdsOf(raw: FlowTile | null | undefined): string[] {
  const t = legacyTile(raw);
  if (!t) return [];
  const ids: Array<unknown> = [t.primaryMediaId, t.Fb?.id, t.Fb?.mediaId, t.mediaId];
  const family = tileFamily(raw);
  if (family === "CHARACTER") {
    ids.push(characterLookMedia(raw).primaryMediaId);
    const looks = characterLooksOf(raw);
    if (looks) {
      for (const entry of looks.values()) {
        ids.push(entry?.primaryMediaId);
        if (Array.isArray(entry?.history)) {
          for (const item of entry.history) ids.push(item?.id);
        }
      }
    }
  } else if (family === "SCENE" && raw) {
    const { clips, history } = sceneContents(raw);
    for (const clip of clips) ids.push(clip?.primaryMediaId);
    for (const items of history.values()) {
      if (Array.isArray(items)) {
        for (const item of items) ids.push(item?.id);
      }
    }
  }
  return Array.from(
    new Set(
      ids
        .filter((v) => v !== undefined && v !== null && v !== "")
        .map(String),
    ),
  );
}

/** Returns true when another non-trashed store tile shares one of `mediaIds`. */
function mediaIsShared(
  tileMap: Map<string, FlowTile>,
  id: string,
  raw: FlowTile,
  mediaIds: string[],
  sameFamilyOnly: boolean,
): boolean {
  const family = tileFamily(raw);
  for (const [otherId, other] of tileMap.entries()) {
    if (otherId === id || !other || isTrashedTile(other)) continue;
    if (String(other.type ?? "").toUpperCase() === "COLLECTION") continue;
    if (sameFamilyOnly && tileFamily(other) !== family) continue;
    if (mediaIdsOf(other).some((m) => mediaIds.includes(m))) return true;
  }
  return false;
}

/** Classifies a rendered grid tile container from its DOM markers when present. */
function containerKind(container: HTMLElement): "CHARACTER" | "SCENE" | "MEDIA" | "UNKNOWN" {
  const isCharacterDom =
    container.matches('[data-tile-type="CHARACTER" i], [data-character-id]') ||
    Boolean(
      container.querySelector(
        'flow-character-tile, [data-tile-type="CHARACTER" i], [data-character-id], a[href*="/character/"]',
      ),
    );
  const isSceneDom =
    container.matches('[data-tile-type="SCENE" i], [data-scene-id]') ||
    Boolean(
      container.querySelector(
        'flow-scene-tile, [data-tile-type="SCENE" i], [data-scene-id], a[href*="/scene/"]',
      ),
    );
  if (isCharacterDom && !isSceneDom) return "CHARACTER";
  if (isSceneDom && !isCharacterDom) return "SCENE";
  const isMediaDom =
    container.matches('[data-tile-type="IMAGE" i], [data-tile-type="VIDEO" i]') ||
    Boolean(
      container.querySelector(
        'flow-media-tile, flow-asset-tile, [data-tile-type="IMAGE" i], [data-tile-type="VIDEO" i], a[href*="/edit/"]',
      ),
    );
  return isMediaDom ? "MEDIA" : "UNKNOWN";
}

/** Returns true when `container` can unambiguously match `family` under the sharing flags. */
function containerMatchesFamily(
  container: HTMLElement,
  family: "CHARACTER" | "SCENE" | "MEDIA",
  sharedAcrossFamilies = false,
): boolean {
  const kind = containerKind(container);
  if (kind === family) return true;
  if (kind === "UNKNOWN") return !sharedAcrossFamilies;
  return false;
}

/** Returns true when `lv` binds `rawTile` or an item whose `id` matches `id`. */
function lViewMatchesTile(lv: NgLView, id: string, rawTile: FlowTile): boolean {
  for (const slot of lv) {
    if (slot === rawTile) return true;
    if (
      !slot ||
      typeof slot !== "object" ||
      slot instanceof Node ||
      slot instanceof Error ||
      Array.isArray(slot) ||
      slot instanceof Map
    ) {
      continue;
    }
    if (readOwn(slot, "id") === id && typeof readOwn(slot, "type") === "string") {
      return true;
    }
    const keys = Object.keys(slot);
    for (let i = 0; i < keys.length && i < 25; i += 1) {
      const desc = Object.getOwnPropertyDescriptor(slot, keys[i]);
      const val: unknown = desc?.value;
      if (val === rawTile) return true;
      if (val && typeof val === "object" && !(val instanceof Node) && readOwn(val, "id") === id) {
        return true;
      }
      if (typeof val === "function" && val.length === 0 && isAngularSignal(val)) {
        try {
          const out: unknown = val.call(slot);
          if (out === rawTile || (out && typeof out === "object" && readOwn(out, "id") === id)) {
            return true;
          }
        } catch {
          // Ignore unset required signal inputs.
        }
      }
    }
  }
  return false;
}

/** Returns rendered grid containers bound directly to tile `id` via attributes, links, or Angular views. */
function findContainersById(id: string, rawTile: FlowTile): HTMLElement[] {
  const encoded = encodeURIComponent(id);
  const routeFragments = [`/character/${encoded}`, `/scene/${encoded}`, `/edit/${encoded}`];
  const found: HTMLElement[] = [];
  for (const container of Array.from(document.querySelectorAll<HTMLElement>("flow-grid-tile-container"))) {
    const attrNodes = [
      container,
      ...Array.from(
        container.querySelectorAll(
          "[data-tile-id], [data-entity-id], [data-scene-id], [data-character-id]",
        ),
      ),
    ];
    if (
      attrNodes.some((node) =>
        [
          node.getAttribute("data-tile-id"),
          node.getAttribute("data-entity-id"),
          node.getAttribute("data-scene-id"),
          node.getAttribute("data-character-id"),
        ].includes(id),
      )
    ) {
      found.push(container);
      continue;
    }
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("a[href]"));
    if (links.some((a) => routeFragments.some((frag) => (a.getAttribute("href") || "").includes(frag)))) {
      found.push(container);
      continue;
    }
    const seenViews = new Set<NgLView>();
    const probeNodes = [container, ...Array.from(container.querySelectorAll("*")).slice(0, 24)];
    let matchedView = false;
    for (const node of probeNodes) {
      let lv: NgLView | null = resolveLView(node);
      for (let d = 0; d < 3 && Array.isArray(lv); d += 1) {
        if (d > 0 && lv[0] instanceof Node && lv[0] !== container && !container.contains(lv[0])) {
          break;
        }
        if (!seenViews.has(lv)) {
          seenViews.add(lv);
          if (lViewMatchesTile(lv, id, rawTile)) {
            matchedView = true;
            break;
          }
        }
        lv = Array.isArray(lv[3]) ? lv[3] : Array.isArray(lv[15]) ? lv[15] : null;
      }
      if (matchedView) break;
    }
    if (!matchedView && runtimeState.ngLViewMap instanceof Map) {
      for (const view of runtimeState.ngLViewMap.values()) {
        if (!isLiveLView(view) || !(view[0] instanceof Node)) continue;
        if (view[0] !== container && !container.contains(view[0])) continue;
        if (!seenViews.has(view) && lViewMatchesTile(view, id, rawTile)) {
          matchedView = true;
          break;
        }
      }
    }
    if (matchedView) found.push(container);
  }
  return found;
}

/** Returns the rendered grid tiles that show one of `mediaIds` and match `family`. */
function findContainers(
  mediaIds: string[],
  family: "CHARACTER" | "SCENE" | "MEDIA",
  sharedAcrossFamilies: boolean,
): HTMLElement[] {
  const found = new Set<HTMLElement>();
  for (const el of Array.from(document.querySelectorAll("[data-media-id]"))) {
    if (!mediaIds.includes(el.getAttribute("data-media-id") || "")) continue;
    const container = el.closest<HTMLElement>("flow-grid-tile-container");
    if (container && containerMatchesFamily(container, family, sharedAcrossFamilies)) {
      found.add(container);
    }
  }
  return Array.from(found);
}

/** Extracts the normalized FIFE base URL of a media, character, or scene tile. */
function tileFifeBase(raw: FlowTile): string {
  const direct = pickTileUrl(raw);
  if (direct) return fifeBase(direct);
  if (tileFamily(raw) === "SCENE") {
    const { clips, history } = sceneContents(raw);
    for (const clip of clips) {
      const url = readMediaUrl(clip, true) || readMediaUrl(clip);
      if (url) return fifeBase(normalizeFlowMediaUrl(url, "video"));
    }
    for (const items of history.values()) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const url = readMediaUrl(item, true) || readMediaUrl(item);
        if (url) return fifeBase(normalizeFlowMediaUrl(url, "video"));
      }
    }
  }
  return "";
}

/** Returns true when another non-trashed tile shares `targetFife`. */
function fifeIsShared(
  tileMap: Map<string, FlowTile>,
  id: string,
  raw: FlowTile,
  targetFife: string,
  sameFamilyOnly: boolean,
): boolean {
  const family = tileFamily(raw);
  for (const [otherId, other] of tileMap.entries()) {
    if (otherId === id || !other || isTrashedTile(other)) continue;
    if (String(other.type ?? "").toUpperCase() === "COLLECTION") continue;
    if (sameFamilyOnly && tileFamily(other) !== family) continue;
    if (tileFifeBase(other) === targetFife) return true;
  }
  return false;
}

/** Returns true when another non-trashed tile shares display `name`. */
function nameIsShared(
  tileMap: Map<string, FlowTile>,
  id: string,
  raw: FlowTile,
  name: string,
  sameFamilyOnly: boolean,
): boolean {
  const low = name.toLowerCase();
  const family = tileFamily(raw);
  for (const [otherId, other] of tileMap.entries()) {
    if (otherId === id || !other || isTrashedTile(other)) continue;
    if (String(other.type ?? "").toUpperCase() === "COLLECTION") continue;
    if (sameFamilyOnly && tileFamily(other) !== family) continue;
    if (String(other.displayName ?? "").trim().toLowerCase() === low) return true;
  }
  return false;
}

/** Returns rendered grid containers matching an unshared FIFE media URL. */
function findContainersByFife(
  targetFife: string,
  family: "CHARACTER" | "SCENE" | "MEDIA",
  sharedAcrossFamilies: boolean,
): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const container of Array.from(document.querySelectorAll<HTMLElement>("flow-grid-tile-container"))) {
    if (!containerMatchesFamily(container, family, sharedAcrossFamilies)) continue;
    const mediaEls = Array.from(container.querySelectorAll("img[src], video[src]"));
    if (
      mediaEls.some((el) => {
        const src = el.getAttribute("src") || "";
        return Boolean(src) && fifeBase(normalizeFlowMediaUrl(src)) === targetFife;
      })
    ) {
      found.push(container);
    }
  }
  return found;
}

/** Returns rendered grid containers matching an unshared tile display name. */
function findContainersByName(
  name: string,
  family: "CHARACTER" | "SCENE" | "MEDIA",
  sharedAcrossFamilies: boolean,
): HTMLElement[] {
  const low = name.toLowerCase();
  const found: HTMLElement[] = [];
  for (const container of Array.from(document.querySelectorAll<HTMLElement>("flow-grid-tile-container"))) {
    if (!containerMatchesFamily(container, family, sharedAcrossFamilies)) continue;
    const aria = (container.getAttribute("aria-label") || "").trim().toLowerCase();
    const lines = elText(container)
      .split(/\r?\n/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (aria === low || lines.includes(low)) {
      found.push(container);
    }
  }
  return found;
}

/** Captures Angular's LView map from rendered grid tiles when not yet recorded. */
async function ensureGridLViews(): Promise<void> {
  if (runtimeState.ngLViewMap instanceof Map) return;
  const targets = Array.from(
    document.querySelectorAll(
      "flow-grid-tile-container [mattooltip], flow-grid-tile-container button, flow-grid-tile-container",
    ),
  ).filter((el) => el.getClientRects().length > 0);
  if (targets.length === 0) return;
  await withLViewMapCapture(() => hoverProbe(targets.slice(0, 6), 25));
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

/** Finds the media, character, or scene tile of `id` in the virtual grid. */
async function locateTile(id: string): Promise<Record<string, unknown>> {
  const tileMap = runtimeState.store?.getTileMap?.();
  if (!(tileMap instanceof Map)) return { ok: false, error: "store_not_bound" };
  const rawTile = tileMap.get(id);
  if (!rawTile) return { ok: false, error: "tile_not_found" };
  await ensureGridLViews();

  const family = tileFamily(rawTile);
  const mediaIds = mediaIdsOf(rawTile);
  const sharedInFamily =
    mediaIds.length > 0 && mediaIsShared(tileMap, id, rawTile, mediaIds, true);
  const sharedAcrossAll =
    mediaIds.length > 0 && mediaIsShared(tileMap, id, rawTile, mediaIds, false);
  const targetFife = tileFifeBase(rawTile);
  const fifeSharedInFamily =
    Boolean(targetFife) && fifeIsShared(tileMap, id, rawTile, targetFife, true);
  const fifeSharedAcrossAll =
    Boolean(targetFife) && fifeIsShared(tileMap, id, rawTile, targetFife, false);
  const name = String(rawTile.displayName ?? "").trim();
  const nameSharedInFamily =
    Boolean(name) && nameIsShared(tileMap, id, rawTile, name, true);
  const nameSharedAcrossAll =
    Boolean(name) && nameIsShared(tileMap, id, rawTile, name, false);

  const findCandidates = (): HTMLElement[] => {
    const byId = findContainersById(id, rawTile);
    if (byId.length > 0) return byId;
    if (mediaIds.length > 0 && !sharedInFamily) {
      const byMedia = findContainers(mediaIds, family, sharedAcrossAll);
      if (byMedia.length > 0) return byMedia;
    }
    if (targetFife && !fifeSharedInFamily) {
      const byFife = findContainersByFife(targetFife, family, fifeSharedAcrossAll);
      if (byFife.length > 0) return byFife;
    }
    if (name && family !== "MEDIA" && !nameSharedInFamily) {
      const byName = findContainersByName(name, family, nameSharedAcrossAll);
      if (byName.length > 0) return byName;
    }
    return [];
  };

  const result = await locateContainer(findCandidates);
  if (result.ok === false && result.error === "tile_not_rendered") {
    if (mediaIds.length > 0 && (sharedInFamily || sharedAcrossAll)) {
      return { ok: false, error: "tile_media_ambiguous" };
    }
    if (mediaIds.length === 0 && !targetFife && !(name && family !== "MEDIA")) {
      return { ok: false, error: "tile_media_id_unknown" };
    }
  }
  return result;
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
  if (action === "dismiss") {
    await dismissOverlay();
    return { ok: true };
  }
  return { ok: false, error: `unknown_tile_dom_op:${action}` };
}
