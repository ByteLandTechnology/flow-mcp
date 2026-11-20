// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Locate the enabled Flow generation submit button and compute its viewport click point.

import { readOwn } from "./angular";
import { delay, elText, isVisibleEnabled } from "./dom";
import { runtimeState } from "./state";

/** Finds the enabled Start generation button, uncovers it if needed, and returns its viewport point. */
export async function submitGeneration(): Promise<unknown> {
  const isVisible = (b: Element | null | undefined): b is HTMLElement =>
    Boolean(b instanceof HTMLElement && b.getClientRects().length > 0);

  async function prepareTarget(
    btn: HTMLElement,
    method: string,
  ): Promise<unknown> {
    btn.scrollIntoView({ block: "center", inline: "nearest" });
    await delay(40);
    let r = btn.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) {
      return {
        ok: false,
        error: "submit_button_zero_rect",
        detail: method,
      };
    }
    let cx = r.left + r.width / 2;
    let cy = r.top + r.height / 2;
    let hit = document.elementFromPoint(cx, cy);
    if (hit && hit !== btn && !btn.contains(hit)) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
        }),
      );
      await delay(120);
      btn.scrollIntoView({ block: "center", inline: "nearest" });
      await delay(40);
      r = btn.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) {
        return {
          ok: false,
          error: "submit_button_zero_rect",
          detail: method,
        };
      }
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      hit = document.elementFromPoint(cx, cy);
    }
    return {
      ok: true,
      method,
      x: cx,
      y: cy,
      hit_tag: hit ? hit.tagName?.toLowerCase() || null : null,
      hit_inside_btn: Boolean(hit && (hit === btn || btn.contains(hit))),
    };
  }

  const onEditPage = /\/edit\//.test(location.pathname || "");
  const scopedSelectors = onEditPage
    ? [
        'flow-edit-video-prompt-box button[aria-label="Start generation"]',
        'flow-editor-page button[aria-label="Start generation"]',
        'flow-scene-builder button[aria-label="Start generation"]',
        'button[aria-label="Start generation"]',
      ]
    : [
        'flow-prompt-box flow-base-prompt-box button[aria-label="Start generation"]',
        'flow-prompt-box button[aria-label="Start generation"]',
      ];
  const findStartButton = (): HTMLElement | null => {
    for (const sel of scopedSelectors) {
      const match = Array.from(document.querySelectorAll(sel)).find(
        (b): b is HTMLElement => {
          if (!isVisible(b)) return false;
          if (
            !onEditPage &&
            b.closest(
              "flow-agent-panel, .agent-panel-wrapper, flow-creative-agent-prompt-box",
            )
          ) {
            return false;
          }
          return true;
        },
      );
      if (match) return match;
    }
    const fallback = Array.from(
      document.querySelectorAll('button[aria-label="Start generation"]'),
    ).find((b): b is HTMLElement => {
      if (!isVisible(b)) return false;
      if (
        !onEditPage &&
        b.closest(
          "flow-agent-panel, .agent-panel-wrapper, flow-creative-agent-prompt-box",
        )
      ) {
        return false;
      }
      return true;
    });
    return fallback ?? null;
  };

  for (let i = 0; i < 120; i += 1) {
    const exact = findStartButton();
    if (isVisibleEnabled(exact)) {
      return await prepareTarget(exact, "aria_start_generation");
    }
    if (exact && isVisible(exact)) {
      await delay(100);
    } else {
      break;
    }
  }

  const exactAfter = findStartButton();
  if (exactAfter && isVisible(exactAfter) && !isVisibleEnabled(exactAfter)) {
    let reason = runtimeState.promptState?.lf?.jYa?.() || "";
    if (!reason && runtimeState.ngLViewMap instanceof Map) {
      for (const lv of runtimeState.ngLViewMap.values()) {
        if (!Array.isArray(lv)) continue;
        if (lv[0] instanceof Node && !lv[0].isConnected) continue;
        for (const cand of lv) {
          try {
            const sLFn = readOwn(cand, "sL");
            const qaLf = readOwn(readOwn(cand, "Qa"), "lf") as
              | { jYa?: () => string }
              | undefined;
            const wnFn = readOwn(cand, "Wn");
            const directLf = readOwn(cand, "lf") as
              | { jYa?: () => string }
              | undefined;
            const msg =
              (typeof sLFn === "function" ? String(sLFn.call(cand) || "") : "") ||
              qaLf?.jYa?.() ||
              (typeof wnFn === "function" ? directLf?.jYa?.() || "" : "");
            if (msg) {
              reason = msg;
              break;
            }
          } catch {
            // Ignore unreachable validator methods.
          }
        }
        if (reason) break;
      }
    }
    const visiblePm = Array.from(document.querySelectorAll(".ProseMirror")).find(
      (el) => el.getClientRects().length > 0,
    );
    const detail = [
      reason,
      ((visiblePm || document.querySelector(".ProseMirror"))?.textContent || "").slice(
        0,
        40,
      ),
    ]
      .filter(Boolean)
      .join(" | ");
    return { ok: false, error: "start_generation_disabled", detail };
  }

  const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
  const createBtn = btns.find((b): b is HTMLElement => {
    if (b.tagName === "A" || !isVisibleEnabled(b)) return false;
    if (!onEditPage && b.closest("flow-agent-panel, .agent-panel-wrapper, flow-creative-agent-prompt-box")) {
      return false;
    }
    if (
      b.closest(
        '.cdk-overlay-pane, [role="menu"], [role="listbox"], nav, aside',
      )
    ) {
      return false;
    }
    const label = (
      b.getAttribute("aria-label") ||
      elText(b) ||
      b.getAttribute("title") ||
      ""
    ).trim();
    if (
      /create with google flow|new project|create tool|create collection|create project|redo extend|done editing|create\s+(?:image|video|character|scene)/i.test(
        label,
      )
    ) {
      return false;
    }
    if (/\b(?:start generation|generate|extend|create)\b/i.test(label)) {
      return true;
    }
    return b.tagName === "BUTTON" && /\barrow_forward\b/i.test(label);
  });
  if (!createBtn) return { ok: false, error: "submit_button_not_found" };
  return await prepareTarget(createBtn, "fallback_button");
}
