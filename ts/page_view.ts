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
  if (!router) return { ok: false, error: "router_not_found" };
  const commands = want
    ? ["/project", view.projectId, "collection", want]
    : ["/project", view.projectId];
  await router.navigate(commands, { queryParams: { hl: "en" } });
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

/** Returns the text input of a page control: `tile` is the "Rename tile" overlay, `item` is the name input of a new sidebar collection, and `title` is the title of a collection page whose text is `current`. */
function textControl(control: string, current: string): HTMLInputElement | null {
  if (control === "tile") {
    const host = Array.from(document.querySelectorAll('[aria-label="Rename tile"]')).find(isRendered);
    const input = host?.querySelector("input");
    return input instanceof HTMLInputElement ? input : null;
  }
  if (control === "item") {
    const input = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[aria-label="Rename item"]'),
    ).find(isRendered);
    return input ?? null;
  }
  if (control === "title") {
    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[aria-label="Editable text"]'),
    ).filter(isRendered);
    // The project title uses the same label. Select the input that has the focus, or the one that shows the collection name.
    const active = inputs.find((e) => e === document.activeElement && e.classList.contains("editing"));
    if (active) return active;
    const named = inputs.filter((e) => e.value === current);
    return named.length === 1 ? named[0] : null;
  }
  return null;
}

/** Returns the viewport center of the text input of `control`. */
export function textPoint(control: string, current: string): Record<string, unknown> {
  const el = textControl(control, current);
  if (!el) return { ok: false, error: "text_control_not_found" };
  const r = el.getBoundingClientRect();
  return { ok: true, point: { x: r.x + r.width / 2, y: r.y + r.height / 2 } };
}

/** Selects the text of the focused text input of `control`, so that typed text replaces it. It does not move the focus. */
export function selectText(control: string, current: string): Record<string, unknown> {
  const el = textControl(control, current);
  if (!el) return { ok: false, error: "text_control_not_found" };
  const focused = document.activeElement === el;
  if (focused) el.select();
  return { ok: true, focused, value: el.value };
}

/** Returns the text of the text input of `control`. */
export function readText(control: string, current: string): Record<string, unknown> {
  const el = textControl(control, current);
  if (!el) return { ok: false, error: "text_control_not_found" };
  return { ok: true, value: el.value };
}
