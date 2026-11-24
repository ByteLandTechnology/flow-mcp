// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Click the image/frame/library upload trigger or accept the upload consent dialog.

import { elText, isVisibleEnabled } from "./dom";

/** Clicks an upload trigger button, captures a hidden file input, or accepts upload consent. */
export function uploadUiAction(action: string): boolean {
  if (action === "accept_consent") {
    const dialogs = document.querySelectorAll(
      'flow-upload-consent-dialog, [data-testid="upload-consent-dialog"], mat-dialog-container, [role="dialog"], [role="alertdialog"]',
    );
    for (const dialog of dialogs) {
      const btn = Array.from(dialog.querySelectorAll('button, [role="button"]')).find(
        (el): el is HTMLElement => {
          if (!isVisibleEnabled(el)) return false;
          const txt = elText(el);
          return /^(?:i agree,\s*do not show again|i agree)$/i.test(txt) ||
            (dialog.matches('flow-upload-consent-dialog, [data-testid="upload-consent-dialog"]') &&
              /^(?:accept|continue)$/i.test(txt));
        },
      );
      if (btn) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  if (action === "capture_project_file_input") {
    for (const prev of document.querySelectorAll('[data-flow-mcp-upload="project"]')) {
      prev.removeAttribute("data-flow-mcp-upload");
    }
    const existing = document.querySelector<HTMLInputElement>(
      'flow-project-page input[type="file"], flow-project-shell input[type="file"], input[type="file"][data-upload-target="project"]',
    );
    if (existing) {
      existing.setAttribute("data-flow-mcp-upload", "project");
      return true;
    }
    let captured: HTMLInputElement | null = null;
    const origClick = HTMLInputElement.prototype.click;
    const origShow =
      typeof HTMLInputElement.prototype.showPicker === "function"
        ? HTMLInputElement.prototype.showPicker
        : null;
    HTMLInputElement.prototype.click = function (this: HTMLInputElement): void {
      if (this.type === "file") {
        captured = this;
        return;
      }
      origClick.call(this);
    };
    if (origShow) {
      HTMLInputElement.prototype.showPicker = function (this: HTMLInputElement): void {
        if (this.type === "file") {
          captured = this;
          return;
        }
        origShow.call(this);
      };
    }
    try {
      const menuItem = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitem"], button, [role="button"]'),
      ).find((el) => {
        if (!isVisibleEnabled(el)) return false;
        const label = `${el.getAttribute("aria-label") || ""} ${elText(el)}`.trim();
        return /^(?:upload|upload media|upload files?)$/i.test(label) || /\bupload\b$/i.test(label);
      });
      menuItem?.click();
    } finally {
      HTMLInputElement.prototype.click = origClick;
      if (origShow) HTMLInputElement.prototype.showPicker = origShow;
    }
    if (!captured) return false;
    const inputEl: HTMLInputElement = captured;
    if (!document.contains(inputEl)) {
      inputEl.style.display = "none";
      document.body.appendChild(inputEl);
    }
    inputEl.setAttribute("data-flow-mcp-upload", "project");
    return true;
  }

  const els = Array.from(document.querySelectorAll('button, [role="button"]'));
  const trigger = els.find((el): el is HTMLElement => {
    if (!isVisibleEnabled(el)) return false;
    const label = (
      el.getAttribute("aria-label") ||
      elText(el) ||
      el.getAttribute("title") ||
      ""
    ).trim();
    return /add ingredients to the prompt box|add frame|first frame|upload|attach|reference|add_photo_alternate|add_a_photo/i.test(
      label,
    );
  });
  if (trigger) {
    trigger.click();
    return true;
  }
  return false;
}
