// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Switch the project page between the main grid and a collection page, and use the text controls of the page.

import { findRouter } from "./angular";
import { delay } from "./dom";
import { clearStore } from "./state";

/** View of the project page: the main grid, one collection page, or a different route. */
interface PageView {
  /** Project ID of the route, or null. */
  projectId: string | null;
  /** True when the route is the main grid or a collection page. */
  grid: boolean;
  /** Collection ID of a collection page, or null. */
  collection: string | null;
}

/** Reads the view of the project page from the route. */
function currentView(): PageView {
  const path = location.pathname || "";
  const m = /\/project\/([^/?#]+)(?:\/([^/?#]+)(?:\/([^/?#]+))?)?\/?$/.exec(path);
  if (!m) return { projectId: null, grid: false, collection: null };
  if (!m[2]) return { projectId: m[1], grid: true, collection: null };
  if (m[2] === "collection" && m[3]) return { projectId: m[1], grid: true, collection: m[3] };
  return { projectId: m[1], grid: false, collection: null };
}

/** Returns the view of the project page. */
export function readView(): Record<string, unknown> {
  return { ok: true, ...currentView() };
}

/** Opens the main grid when `collection` is empty, or the page of collection `collection`. It changes the route only from the main grid or from a collection page. */
export async function openView(collection: string): Promise<Record<string, unknown>> {
  const view = currentView();
  if (!view.projectId || !view.grid) return { ok: false, error: "not_on_grid_route" };
  const want = collection || null;
  if (view.collection === want) return { ok: true, changed: false };
  const router = findRouter();
  const prefix = (location.pathname || "").startsWith("/fx/tools/flow") ? "/fx/tools/flow" : "";
  if (router) {
    const commands = want
      ? ["/project", view.projectId, "collection", want]
      : ["/project", view.projectId];
    await router.navigate(commands, { queryParams: { hl: "en" } });
  } else if (want) {
    const link = document.querySelector<HTMLElement>(`a[href*="/collection/${CSS.escape(want)}"]`);
    if (link) {
      link.click();
    } else {
      history.pushState({}, "", `${prefix}/project/${encodeURIComponent(view.projectId)}/collection/${encodeURIComponent(want)}?hl=en`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  } else {
    const back = document.querySelector<HTMLElement>(
      'button[aria-label="Back to project"], button[aria-label="Go back"], a.collection-back-link',
    );
    if (back && back.getClientRects().length > 0) {
      back.click();
    } else {
      history.pushState({}, "", `${prefix}/project/${encodeURIComponent(view.projectId)}?hl=en`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }
  for (let i = 0; i < 50; i++) {
    await delay(100);
    const now = currentView();
    if (now.grid && now.collection === want) {
      // The store of the page changes with the route. The runtime binds it again.
      clearStore();
      await delay(600);
      return { ok: true, changed: true };
    }
  }
  return { ok: false, error: "route_did_not_change" };
}

/** Returns true when `el` is rendered. */
function isRendered(el: Element): boolean {
  return el.getClientRects().length > 0;
}

/** Returns the text input of the requested asset or collection rename control. */
function renameControl(control = "", current = ""): HTMLInputElement | null {
  if (control === "item") {
    return (
      Array.from(
        document.querySelectorAll<HTMLInputElement>('input[aria-label="Rename item"]'),
      ).find(isRendered) ?? null
    );
  }
  if (control === "title") {
    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[aria-label="Editable text"]'),
    ).filter(isRendered);
    const active = inputs.find(
      (e) => e === document.activeElement && e.classList.contains("editing"),
    );
    if (active) return active;
    const named = inputs.filter((e) => e.value === current);
    return named.length === 1 ? named[0] : null;
  }
  const host = Array.from(document.querySelectorAll('[aria-label="Rename tile"]')).find(isRendered);
  const hostInput = host?.querySelector("input");
  if (hostInput instanceof HTMLInputElement && isRendered(hostInput)) return hostInput;
  const direct = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'input[aria-label="Rename tile"], input[aria-label="Rename item"], input[aria-label="Collection name"], [role="dialog"] input, flow-grid-tile-container input',
    ),
  ).find(isRendered);
  if (direct) return direct;
  if (document.activeElement instanceof HTMLInputElement && isRendered(document.activeElement)) {
    const insideTileOrHeader = document.activeElement.closest(
      'flow-grid-tile-container, [role="dialog"], .collection-header',
    );
    if (insideTileOrHeader) return document.activeElement;
  }
  return null;
}

/** Returns the viewport center of the requested rename control. */
export function textPoint(control = "", current = ""): Record<string, unknown> {
  const el = renameControl(control, current);
  if (!el) return { ok: false, error: "text_control_not_found" };
  const r = el.getBoundingClientRect();
  return { ok: true, point: { x: r.x + r.width / 2, y: r.y + r.height / 2 } };
}

/** Selects the text of the focused rename control. */
export function selectText(control = "", current = ""): Record<string, unknown> {
  const el = renameControl(control, current);
  if (!el) return { ok: false, error: "text_control_not_found" };
  const focused = document.activeElement === el;
  if (focused) el.select();
  return { ok: true, focused, value: el.value };
}

/** Returns the text in the rename control. */
export function readText(control = "", current = ""): Record<string, unknown> {
  const el = renameControl(control, current);
  if (!el) return { ok: false, error: "text_control_not_found" };
  return { ok: true, value: el.value };
}
