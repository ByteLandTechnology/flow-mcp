// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Locate visible controls by their accessible name and return a viewport click point.

import type { LocatePointRequest, ViewportPoint } from "./types";

/** Returns true when `el` is rendered in the viewport. */
function isRendered(el: Element): boolean {
  return el.getClientRects().length > 0;
}

/** Returns the visible control that matches `req`, or null. */
function findControl(req: LocatePointRequest): Element | null {
  if (req.by === "aria-label") {
    return (
      Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"]')).find(
        (b) => b.getAttribute("aria-label") === req.name && isRendered(b),
      ) ?? null
    );
  }
  const want = req.name.trim().toLowerCase();
  const textOf = (e: HTMLElement): string =>
    (e.innerText || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (req.by === "menuitem") {
    return (
      Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).find((e) => {
        const text = textOf(e);
        return isRendered(e) && (text === want || text.endsWith(` ${want}`));
      }) ?? null
    );
  }
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>(
      'mat-dialog-container, [role="alertdialog"], [role="dialog"]',
    ),
  ).filter(isRendered);
  for (const dialog of dialogs) {
    const inDialog = Array.from(
      dialog.querySelectorAll<HTMLElement>('button, [role="button"], [role="menuitem"]'),
    ).find((e) => isRendered(e) && textOf(e) === want);
    if (inDialog) return inDialog;
  }
  return (
    Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"], button, [role="button"]'),
    ).find((e) => isRendered(e) && textOf(e) === want) ?? null
  );
}

/** Returns the viewport center of the visible control that `req` names, or null when none matches. */
export function locatePoint(req: LocatePointRequest): ViewportPoint | null {
  const el = findControl(req);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}
