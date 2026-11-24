// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Click the image/frame upload trigger or accept the upload consent dialog.

import { elText, isVisibleEnabled } from "./dom";

/** Clicks the frame upload trigger button or accepts the upload consent modal. */
export function uploadUiAction(action: string): boolean {
  if (action === "accept_consent") {
    const dialog = document.querySelector("flow-upload-consent-dialog");
    if (!dialog) return false;
    const btn = Array.from(
      dialog.querySelectorAll('button, [role="button"]'),
    ).find((el): el is HTMLElement => {
      if (!isVisibleEnabled(el)) return false;
      const txt = elText(el);
      return /^(?:i agree,\s*do not show again|i agree)$/i.test(txt);
    });
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }

  const promptBox = document.querySelector("flow-prompt-box");
  const els = [
    ...Array.from(
      promptBox?.querySelectorAll('button, [role="button"]') ?? [],
    ),
    ...Array.from(document.querySelectorAll('button, [role="button"]')),
  ];
  const trigger = els.find((el): el is HTMLElement => {
    if (!isVisibleEnabled(el)) return false;
    const label = (
      el.getAttribute("aria-label") ||
      elText(el) ||
      el.getAttribute("title") ||
      ""
    ).trim();
    return /^(?:start|end)$|add ingredients to the prompt box|add frame|first frame|upload|attach|reference|add_photo_alternate|add_a_photo/i.test(
      label,
    );
  });
  if (trigger) {
    trigger.click();
    return true;
  }
  return false;
}
