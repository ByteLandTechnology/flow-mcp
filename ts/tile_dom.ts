// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Locate media, character, scene, and collection tiles in the virtual grid and run DOM view actions.

import { readOwn, resolveLView } from "./angular";
import {
  characterLooksOf,
  clickButtonByRegex,
  collectionIdOf,
  delay,
  dismissOverlay,
  elText,
  fifeBase,
  isTrashedTile,
  isVisibleEnabled,
  legacyTile,
  pickTileUrl,
  setNativeValue,
} from "./dom";
import { openView, readText, readView, selectText, textPoint } from "./page_view";
import { readStoreSnapshot } from "./read_store_snapshot";
import { sceneContents } from "./scene_tiles";
import { runtimeState } from "./state";
import type { FlowTile, NgLView, TileDomOpRequest, ViewportPoint } from "./types";

/** Returns all media IDs associated with a media, character, or scene store tile. */
function mediaIdsOf(raw: FlowTile | null | undefined): string[] {
  const t = legacyTile(raw);
  if (!t) return [];
  const ids: unknown[] = [t.primaryMediaId, t.Fb?.id, t.Fb?.mediaId, t.fb?.mediaId, t.mediaId];
  const ttype = String(t.type || "").toUpperCase();
  if (ttype === "CHARACTER") {
    const looks = characterLooksOf(t);
    if (looks) {
      for (const entry of looks.values()) {
        if (!entry) continue;
        ids.push(entry.primaryMediaId, entry.media?.id, readOwn(entry, "id"));
        if (Array.isArray(entry.history)) {
          for (const h of entry.history) ids.push(h?.primaryMediaId, h?.media?.id, readOwn(h, "id"));
        }
      }
    }
  } else if (ttype === "SCENE") {
    const { clips, history } = sceneContents(t);
    for (const clip of clips) ids.push(clip?.primaryMediaId);
    for (const items of history.values()) {
      for (const m of items) ids.push(m?.id);
    }
  }
  return Array.from(
    new Set(ids.filter((v) => v !== undefined && v !== null && v !== "").map(String)),
  );
}

/** Returns normalized FIFE base URLs associated with a store tile, its looks, or its clips. */
function fifeBasesOf(raw: FlowTile | null | undefined): string[] {
  const t = legacyTile(raw);
  if (!t) return [];
  const urls: unknown[] = [pickTileUrl(t), t.ue];
  const ttype = String(t.type || "").toUpperCase();
  if (ttype === "CHARACTER") {
    const looks = characterLooksOf(t);
    if (looks) {
      for (const entry of looks.values()) {
        urls.push(entry?.Wb, entry?.fifeUrl, entry?.imageUrl, entry?.url, entry?.media?.Wb, entry?.media?.fifeUrl);
      }
    }
  } else if (ttype === "SCENE") {
    const { clips, history } = sceneContents(t);
    for (const clip of clips) urls.push(clip?.Wb, clip?.fifeUrl, clip?.videoUrl, clip?.Bd);
    for (const items of history.values()) {
      for (const m of items) urls.push(m?.Wb, m?.fifeUrl, m?.videoUrl, m?.Bd, m?.url);
    }
  }
  return Array.from(new Set(urls.map(fifeBase).filter(Boolean)));
}

/** Extracts tile IDs bound inside the Angular `LView` of `container` or its immediate children. */
function lviewTileIdsOf(container: Element): string[] {
  const ids = new Set<string>();
  const recordObj = (obj: unknown): void => {
    if (!obj || typeof obj !== "object" || obj instanceof Node || Array.isArray(obj)) return;
    const rawId = readOwn(obj, "id");
    const rawType = readOwn(obj, "type");
    const wfId = readOwn(obj, "workflowId");
    const entityId = readOwn(obj, "entityId");
    if (typeof rawId === "string" && rawId && (typeof rawType === "string" || wfId || entityId || "displayName" in obj)) {
      ids.add(rawId);
    }
    if (typeof wfId === "string" && wfId) ids.add(wfId);
    if (typeof entityId === "string" && entityId) ids.add(entityId);
  };

  const inspectLv = (startLv: NgLView | null): void => {
    if (!Array.isArray(startLv)) return;
    const queue: Array<[NgLView, number]> = [[startLv, 0]];
    const seen = new Set<unknown>();
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      const [lv, depth] = next;
      if (!Array.isArray(lv) || seen.has(lv)) continue;
      seen.add(lv);
      for (const slot of lv) {
        if (!slot || typeof slot !== "object" || slot instanceof Node) continue;
        recordObj(slot);
        for (const prop of ["tile", "item", "asset", "collection", "data"]) {
          const field = readOwn(slot, prop);
          const val =
            typeof field === "function" && field.length === 0
              ? safeCall(field as () => unknown, slot)
              : field;
          recordObj(val);
        }
      }
      if (depth < 2) {
        for (const slot of lv) {
          if (Array.isArray(slot) && slot.length >= 20) queue.push([slot as NgLView, depth + 1]);
        }
      }
    }
  };

  inspectLv(resolveLView(container));
  for (const child of Array.from(container.children).slice(0, 4)) {
    inspectLv(resolveLView(child));
  }
  return [...ids];
}

/** Calls a zero-argument getter safely. */
function safeCall(fn: () => unknown, ctx: unknown): unknown {
  try {
    return fn.call(ctx);
  } catch {
    return undefined;
  }
}

/** Extracts explicit tile, route, workflow, or entity IDs rendered on `container` in the DOM. */
function domDirectIdsOf(container: Element): string[] {
  const out = new Set<string>();
  for (const attr of ["data-tile-id", "data-id", "data-workflow-id", "data-entity-id"]) {
    const v = container.getAttribute(attr);
    if (v) out.add(v);
    for (const sub of container.querySelectorAll(`[${attr}]`)) {
      const sv = sub.getAttribute(attr);
      if (sv) out.add(sv);
    }
  }
  for (const link of container.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = link.getAttribute("href") || "";
    const m = /\/(?:collection|character|scene|edit)\/([^/?#]+)/.exec(href);
    if (m?.[1]) out.add(decodeURIComponent(m[1]));
  }
  return [...out];
}

/** Reads the rendered title or folder label inside a tile container. */
function containerTitleOf(container: Element): string {
  const titleEl = container.querySelector(
    ".asset-title, .tile-title, [data-tile-title], .collection-name, flow-collection-tile h3, h3, h4",
  );
  if (titleEl) {
    const t = elText(titleEl).trim();
    if (t) return t;
  }
  const attrTitle = (
    container.getAttribute("data-tile-name") ||
    container.getAttribute("aria-label") ||
    ""
  ).trim();
  if (attrTitle) return attrTitle;
  const rawLines = (elText(container) || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (rawLines.length >= 3 && /^\d+$/.test(rawLines[rawLines.length - 1])) {
    return rawLines[0];
  }
  return "";
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

/** Returns the element that scrolls the tile grid. */
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

/** Scrolls the grid until `find` locates the target tile, rejecting ambiguous matches. */
async function locateContainer(
  find: () => { containers: HTMLElement[]; ambiguousReason?: string },
): Promise<Record<string, unknown>> {
  let step = find();
  if (step.ambiguousReason) return { ok: false, error: step.ambiguousReason };
  let container: HTMLElement | undefined = step.containers[0];
  const scroller = findScroller();
  if (!container && scroller) {
    scroller.scrollTop = 0;
    await delay(250);
    step = find();
    if (step.ambiguousReason) return { ok: false, error: step.ambiguousReason };
    container = step.containers[0];
    for (let i = 0; i < 80 && !container; i++) {
      const before = scroller.scrollTop;
      scroller.scrollTop = before + Math.max(200, scroller.clientHeight * 0.8);
      await delay(200);
      step = find();
      if (step.ambiguousReason) return { ok: false, error: step.ambiguousReason };
      container = step.containers[0];
      if (scroller.scrollTop === before) break;
    }
  }
  if (!container) return { ok: false, error: "tile_not_rendered" };
  container.scrollIntoView({ block: "center" });
  await delay(300);
  const rendered = find();
  if (rendered.ambiguousReason) return { ok: false, error: rendered.ambiguousReason };
  if (rendered.containers.length > 1) return { ok: false, error: "tile_ambiguous" };
  container = rendered.containers[0] ?? container;
  const menu =
    container.querySelector('button[aria-label="More options"]') ||
    container.querySelector('button[aria-label*="More" i], button[aria-haspopup="menu"]');
  return {
    ok: true,
    tile: centerOf(container),
    menu: menu ? centerOf(menu) : null,
  };
}

/** Locates a media, character, scene, or collection tile in the virtual grid. */
async function locateTile(id: string): Promise<Record<string, unknown>> {
  const tileMap = runtimeState.store?.getTileMap?.();
  const rawTile = tileMap instanceof Map ? tileMap.get(id) : undefined;
  const tile = legacyTile(rawTile);

  const targetIds = new Set<string>([id]);
  if (tile) {
    if (tile.id) targetIds.add(String(tile.id));
    if (tile.workflowId) targetIds.add(String(tile.workflowId));
    if (tile.entityId) targetIds.add(String(tile.entityId));
  }

  const mediaIds = tile ? mediaIdsOf(tile) : [];
  const fifeBases = tile ? fifeBasesOf(tile) : [];
  const domSnap = !(tileMap instanceof Map) ? readStoreSnapshot(true) : null;
  const domName = domSnap?.ok
    ? (domSnap.assets?.find((a) => a.id === id)?.name ??
      domSnap.collections?.find((c) => c.id === id)?.name ??
      "")
    : "";
  const wantName = tile ? String(tile.displayName ?? "").trim() : (domName || id).trim();
  const wantType = tile ? String(tile.type ?? "").toUpperCase() : "";

  let mediaShared = false;
  let fifeShared = false;
  let nameShared = false;
  if (tileMap instanceof Map && tile) {
    const isColId = (v: string): boolean =>
      String(tileMap.get(v)?.type || "").toUpperCase() === "COLLECTION";
    const myCol = wantType === "COLLECTION" ? null : collectionIdOf(tile, isColId);
    for (const [otherId, otherRaw] of tileMap.entries()) {
      if (otherId === id || isTrashedTile(otherRaw)) continue;
      if (mediaIds.length > 0 && mediaIdsOf(otherRaw).some((m) => mediaIds.includes(m))) {
        mediaShared = true;
      }
      if (fifeBases.length > 0 && fifeBasesOf(otherRaw).some((f) => fifeBases.includes(f))) {
        fifeShared = true;
      }
      const other = legacyTile(otherRaw);
      const otherCol =
        String(other?.type || "").toUpperCase() === "COLLECTION"
          ? null
          : collectionIdOf(other, isColId);
      if (wantName && otherCol === myCol && String(other?.displayName ?? "").trim() === wantName) {
        nameShared = true;
      }
    }
  }

  return locateContainer(() => {
    const allContainers = Array.from(
      document.querySelectorAll<HTMLElement>("flow-grid-tile-container"),
    ).filter((c) => c.getClientRects().length > 0);

    // 1. Exact tile identity via Angular LView binding or explicit DOM tile/route attributes.
    const exactMatches = allContainers.filter((c) => {
      const lvIds = lviewTileIdsOf(c);
      if (lvIds.some((lid) => targetIds.has(lid))) return true;
      const domIds = domDirectIdsOf(c);
      return domIds.some((did) => targetIds.has(did));
    });
    if (exactMatches.length > 1) return { containers: [], ambiguousReason: "tile_ambiguous" };
    if (exactMatches.length === 1) return { containers: exactMatches };

    // 2. Media ID attribute match (including character look and scene clip media IDs).
    const candidateMediaIds = mediaIds.length > 0 ? mediaIds : !(tileMap instanceof Map) ? [id] : [];
    if (candidateMediaIds.length > 0) {
      const mediaContainers = allContainers.filter((c) =>
        Array.from(c.querySelectorAll("[data-media-id]")).some((el) =>
          candidateMediaIds.includes(el.getAttribute("data-media-id") || ""),
        ),
      );
      if (mediaContainers.length > 0) {
        if (mediaShared) return { containers: [], ambiguousReason: "tile_media_ambiguous" };
        if (mediaContainers.length > 1) return { containers: [], ambiguousReason: "tile_ambiguous" };
        return { containers: mediaContainers };
      }
    }

    // 3. Unique FIFE media URL match on rendered `<img>` or `<video>`.
    if (fifeBases.length > 0 && !fifeShared) {
      const fifeContainers = allContainers.filter((c) =>
        Array.from(c.querySelectorAll("img[src], video[src]")).some((el) => {
          const fb = fifeBase(el.getAttribute("src") || "");
          return Boolean(fb && fifeBases.includes(fb));
        }),
      );
      if (fifeContainers.length > 1) return { containers: [], ambiguousReason: "tile_ambiguous" };
      if (fifeContainers.length === 1) return { containers: fifeContainers };
    }

    // 4. Unique display or folder name match within the active grid view.
    if (wantName) {
      const nameContainers = allContainers.filter((c) => containerTitleOf(c) === wantName);
      if (nameContainers.length > 0) {
        if (nameShared || nameContainers.length > 1) {
          return { containers: [], ambiguousReason: "tile_ambiguous" };
        }
        return { containers: nameContainers };
      }
    }

    if (mediaShared && mediaIds.length > 0) {
      return { containers: [], ambiguousReason: "tile_media_ambiguous" };
    }
    return { containers: [] };
  });
}

/** Returns `present`, `trashed`, or `gone` for `id`, using the DOM workspace if no JS store is bound. */
function tileState(id: string): Record<string, unknown> {
  const tileMap = runtimeState.store?.getTileMap?.();
  if (tileMap instanceof Map) {
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
  const domSnap = readStoreSnapshot(true);
  if (!domSnap.ok) return { ok: false, error: "store_not_bound" };
  const asset = domSnap.assets?.find((a) => a.id === id);
  if (asset) {
    return {
      ok: true,
      state: "present",
      name: asset.name,
      collection: asset.collection_id,
    };
  }
  const col = domSnap.collections?.find((c) => c.id === id);
  if (col) {
    return { ok: true, state: "present", name: col.name, collection: null };
  }
  return { ok: true, state: "gone" };
}

/** Creates a collection folder through workspace UI buttons when direct store writes cannot run. */
async function createCollectionViaUi(name: string): Promise<Record<string, unknown>> {
  const readCols = (): Array<{ id: string; name: string }> => {
    const snap = readStoreSnapshot(true);
    return snap.ok && Array.isArray(snap.collections)
      ? snap.collections.map((c) => ({ id: c.id, name: c.name }))
      : [];
  };
  const beforeIds = new Set(readCols().map((c) => c.id));

  let triggered = clickButtonByRegex(
    /^(?:create collection|new collection|add collection|new folder|create folder)$/i,
    document,
  );
  if (!triggered) {
    const addBtn =
      document.querySelector('button[aria-label="Add media menu"]') ||
      Array.from(document.querySelectorAll('button, [role="button"]')).find(
        (b) =>
          isVisibleEnabled(b) &&
          /^(?:add media menu|add|new|\+|create)$/i.test((b.getAttribute("aria-label") || elText(b)).trim()),
      );
    if (isVisibleEnabled(addBtn)) {
      addBtn.click();
      await delay(200);
      const item = Array.from(
        document.querySelectorAll('[role="menuitem"], .cdk-overlay-pane button, [role="menu"] button'),
      ).find(
        (el): el is HTMLElement =>
          isVisibleEnabled(el) && /\b(?:collection|folder)\b/i.test(`${el.getAttribute("aria-label") || ""} ${elText(el)}`),
      );
      if (item) {
        item.click();
        triggered = true;
      }
    }
  }
  if (!triggered) return { ok: false, error: "collection_create_ui_not_found" };

  await delay(250);
  const dialogInput = document.querySelector<HTMLInputElement>(
    '[role="dialog"] input, mat-dialog-container input, [aria-label="Rename tile"] input, input[aria-label="Rename item"], input[aria-label="Collection name"]',
  );
  if (dialogInput && dialogInput.getClientRects().length > 0) {
    dialogInput.focus();
    setNativeValue(dialogInput, name, true);
    dialogInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    dialogInput.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    const dialog = dialogInput.closest('[role="dialog"], mat-dialog-container');
    if (dialog) clickButtonByRegex(/^(?:create|save|done|ok|confirm)$/i, dialog);
  }

  for (let i = 0; i < 40; i++) {
    const cols = readCols();
    const created = cols.find((c) => !beforeIds.has(c.id));
    if (created) {
      return {
        ok: true,
        id: created.id,
        name: created.name,
        typed: created.name === name,
        created_named: created.name === name,
      };
    }
    await delay(150);
  }
  return { ok: false, error: "collection_create_ui_timeout" };
}

/** Moves the tile whose context menu is currently open into `targetName`/`targetId`, or out to top-level. */
async function applyOpenMenuCollectionMove(
  targetId: string,
  targetName: string,
): Promise<Record<string, unknown>> {
  const menuItems = (): HTMLElement[] =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="menuitem"], .cdk-overlay-pane button, [role="menu"] button',
      ),
    ).filter((el) => el.getClientRects().length > 0 && !el.hasAttribute("disabled"));

  if (!targetId) {
    const removeDirect = menuItems().find((el) =>
      /\b(?:remove from collection|move out of collection|move to project|remove from folder)\b/i.test(
        `${el.getAttribute("aria-label") || ""} ${elText(el)}`,
      ),
    );
    if (removeDirect) {
      removeDirect.click();
      await delay(250);
      return { ok: true };
    }
  }

  const moveSubTrigger = menuItems().find((el) =>
    /\b(?:move to collection|add to collection|move to folder|collection)\b/i.test(
      `${el.getAttribute("aria-label") || ""} ${elText(el)}`,
    ),
  );
  if (!moveSubTrigger) {
    return { ok: false, error: "collection_menu_item_not_found" };
  }
  moveSubTrigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  moveSubTrigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  moveSubTrigger.click();
  await delay(250);

  const candidates = menuItems().filter((el) => el !== moveSubTrigger);
  let chosen: HTMLElement | undefined;
  if (!targetId) {
    chosen = candidates.find((el) =>
      /\b(?:none|remove|no collection|all media|main grid|root)\b/i.test(
        `${el.getAttribute("aria-label") || ""} ${elText(el)}`,
      ),
    );
  } else {
    chosen =
      candidates.find(
        (el) =>
          el.getAttribute("data-collection-id") === targetId ||
          el.getAttribute("data-id") === targetId,
      ) ??
      candidates.find((el) => {
        const txt = elText(el).trim().replace(/\s+/g, " ");
        return Boolean(targetName && (txt === targetName || txt.endsWith(` ${targetName}`)));
      });
  }
  if (!chosen) {
    await dismissOverlay();
    return { ok: false, error: "collection_target_option_not_found" };
  }
  chosen.click();
  await delay(250);
  return { ok: true };
}

/** Finds an asset or collection tile, changes the grid view, or drives UI menu controls. */
export async function tileDomOp(req: TileDomOpRequest): Promise<unknown> {
  const action = String(req?.action || "");
  const id = String(req?.id || "");
  const control = String(req?.control || "");
  const name = String(req?.name || "");
  if (action === "locate") return locateTile(id);
  if (action === "state") return tileState(id);
  if (action === "view") return readView();
  if (action === "open_view") return openView(id);
  if (action === "text_point") return textPoint(control, name);
  if (action === "text_select") return selectText(control, name);
  if (action === "text_value") return readText(control, name);
  if (action === "create_collection_ui") {
    return createCollectionViaUi(name || "Untitled Collection");
  }
  if (action === "move_collection_menu") {
    return applyOpenMenuCollectionMove(String(req?.target_id || ""), name);
  }
  if (action === "dismiss") {
    await dismissOverlay();
    return { ok: true };
  }
  return { ok: false, error: `unknown_tile_dom_op:${action}` };
}
