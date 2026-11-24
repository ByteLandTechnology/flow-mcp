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

/** Returns the viewport center of `el`. */
function centerPoint(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Returns the rendered text input for `control` (`tile`, `item`, or `title`). */
function findTextControl(control: string, current: string): HTMLInputElement | null {
  const kind = control || "tile";
  if (kind === "title") {
    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[aria-label="Editable text"]'),
    ).filter(isRendered);
    const active = inputs.find((el) => document.activeElement === el);
    if (active) return active;
    if (current) {
      const exact = inputs.find((el) => el.value.trim() === current.trim());
      if (exact) return exact;
    }
    return inputs[0] ?? null;
  }
  const itemInput = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[aria-label="Rename item"]'),
  ).find(isRendered);
  const tileHost = Array.from(document.querySelectorAll('[aria-label="Rename tile"]')).find(
    isRendered,
  );
  const tileInput = tileHost?.querySelector("input");
  const resolvedTile = tileInput instanceof HTMLInputElement ? tileInput : null;
  if (kind === "item") {
    return itemInput ?? resolvedTile;
  }
  return resolvedTile ?? itemInput ?? null;
}

/** Returns the click point of the requested text control. */
export function textPoint(control = "tile", current = ""): Record<string, unknown> {
  const el = findTextControl(control, current);
  if (!el) return { ok: false, error: "text_control_not_found" };
  return { ok: true, point: centerPoint(el) };
}

/** Selects the text of the focused rename or title control. */
export function selectText(control = "tile", current = ""): Record<string, unknown> {
  const el = findTextControl(control, current);
  if (!el) return { ok: false, error: "text_control_not_found" };
  const focused = document.activeElement === el;
  if (focused) el.select();
  return { ok: true, focused, value: el.value };
}

/** Returns the text in the requested rename or title control. */
export function readText(control = "tile", current = ""): Record<string, unknown> {
  const el = findTextControl(control, current);
  if (!el) return { ok: false, error: "text_control_not_found" };
  return { ok: true, value: el.value };
}
