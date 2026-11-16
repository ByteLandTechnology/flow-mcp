// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Shared DOM helpers for Flow browser modules.

/** Reads trimmed visible text from an element. */
export function elText(el: Element | null | undefined): string {
  if (!el) return "";
  const htmlEl = el as Partial<HTMLElement>;
  return (htmlEl.innerText ?? el.textContent ?? "").trim();
}
