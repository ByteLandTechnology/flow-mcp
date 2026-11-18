// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Locate visible controls by their accessible name and return a viewport click point.

import type { LocatePointRequest, ViewportPoint } from "./types";

/** Returns true when `el` is rendered. */
function isRendered(el: Element): boolean {
  return (el as HTMLElement).offsetParent !== null;
}

/** Returns the visible control that matches `req`, or null. */
function findControl(req: LocatePointRequest): Element | null {
  if (req.by === "aria-label") {
    return (
      Array.from(document.querySelectorAll("button")).find(
        (b) => b.getAttribute("aria-label") === req.name && isRendered(b),
      ) ?? null
    );
  }
  const want = req.name.trim().toLowerCase();
  return (
    Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"], button'),
    ).find(
      (e) =>
        isRendered(e) &&
        (e.innerText || "").trim().replace(/\s+/g, " ").toLowerCase() === want,
    ) ?? null
  );
}

/** Returns the viewport center of the visible control that `req` names, or null when none matches. */
export function locatePoint(req: LocatePointRequest): ViewportPoint | null {
  const el = findControl(req);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}
