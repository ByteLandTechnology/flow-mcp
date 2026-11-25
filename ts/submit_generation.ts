// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Locate the enabled Flow generation submit button and compute its viewport click point.

import { readAngularTooltip, readOwn, resolveLView } from "./angular";
import { findComposerWarning } from "./composer";
import { delay, elText, isVisibleEnabled } from "./dom";
import {
  EDIT_SCOPE_SELECTOR,
  isEditContext,
  isExcludedComposerNode,
  readEditBlockReason,
} from "./edit_composer";
import { runtimeState } from "./state";
import type { NgLView } from "./types";

/** Extracts a disabled submit validator message from a component or controller candidate. */
function readCandidateValidatorReason(cand: unknown): string {
  if (!cand || typeof cand !== "object" || cand instanceof Node) return "";
  try {
    const vVFn = readOwn(cand, "vV");
    if (typeof vVFn === "function") {
      const msg = String(vVFn.call(cand) || "").trim();
      if (msg) return msg;
    }
    const sLFn = readOwn(cand, "sL");
    if (typeof sLFn === "function") {
      const msg = String(sLFn.call(cand) || "").trim();
      if (msg) return msg;
    }
    const qa = readOwn(cand, "Qa");
    const qaFf = readOwn(qa, "Ff") as { N7a?: () => string } | undefined;
    const qaLf = readOwn(qa, "lf") as { jYa?: () => string } | undefined;
    const qaMsg = String(qaFf?.N7a?.() || qaLf?.jYa?.() || "").trim();
    if (qaMsg) return qaMsg;

    const applyFn = readOwn(cand, "Gp") ?? readOwn(cand, "Wn");
    if (typeof applyFn === "function") {
      const directFf = readOwn(cand, "Ff") as { N7a?: () => string } | undefined;
      const directLf = readOwn(cand, "lf") as { jYa?: () => string } | undefined;
      const directMsg = String(
        directFf?.N7a?.() || directLf?.jYa?.() || "",
      ).trim();
      if (directMsg) return directMsg;
    }
  } catch {
    // Ignore unreachable validator methods.
  }
  return "";
}

/** Finds the enabled Start generation button, uncovers it if needed, and returns its viewport point. */
export async function submitGeneration(
  explicitEdit?: boolean | null,
): Promise<unknown> {
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

  const onEditPage = isEditContext(explicitEdit);
  const scopedSelectors = onEditPage
    ? [
        'flow-edit-image-prompt-box button[aria-label="Start generation"]',
        'flow-edit-video-prompt-box button[aria-label="Start generation"]',
        'flow-editor-page button[aria-label="Start generation"]',
        'flow-scene-builder button[aria-label="Start generation"]',
        'button[aria-label="Start generation"]',
      ]
    : [
        'flow-prompt-box flow-base-prompt-box button[aria-label="Start generation"]',
        'flow-prompt-box button[aria-label="Start generation"]',
      ];
  const warningRoots = (): ParentNode[] => {
    const roots: ParentNode[] = (
      onEditPage
        ? [
            document.querySelector("flow-edit-image-prompt-box"),
            document.querySelector("flow-edit-video-prompt-box"),
            document.querySelector("flow-editor-page"),
            document.querySelector("flow-scene-builder"),
          ]
        : [
            document.querySelector("flow-prompt-box flow-base-prompt-box"),
            document.querySelector("flow-prompt-box"),
          ]
    ).filter((el): el is Element => Boolean(el && !isExcludedComposerNode(el)));
    roots.push(document);
    return roots;
  };
  const checkWarning = (): { ok: false; error: string; detail: string } | null => {
    const w = findComposerWarning(warningRoots(), true);
    if (!w) return null;
    return {
      ok: false,
      error: w.kind === "credit" ? "credit_quota_exceeded" : "high_demand_warning",
      detail: w.detail,
    };
  };
  const findStartButton = (): HTMLElement | null => {
    for (const sel of scopedSelectors) {
      const match = Array.from(document.querySelectorAll(sel)).find(
        (b): b is HTMLElement => isVisible(b) && !isExcludedComposerNode(b),
      );
      if (match) return match;
    }
    const fallback = Array.from(
      document.querySelectorAll('button[aria-label="Start generation"]'),
    ).find((b): b is HTMLElement => isVisible(b) && !isExcludedComposerNode(b));
    return fallback ?? null;
  };

  for (let i = 0; i < 120; i += 1) {
    const exact = findStartButton();
    if (isVisibleEnabled(exact)) {
      return await prepareTarget(exact, "aria_start_generation");
    }
    const warning = checkWarning();
    if (warning) return warning;
    if (exact && isVisible(exact)) {
      await delay(100);
    } else {
      break;
    }
  }

  const warningAfter = checkWarning();
  if (warningAfter) return warningAfter;

  if (onEditPage) {
    const blockReason = readEditBlockReason();
    if (blockReason) {
      return { ok: false, error: "editor_blocked", detail: blockReason };
    }
  }

  const exactAfter = findStartButton();
  if (exactAfter && isVisible(exactAfter) && !isVisibleEnabled(exactAfter)) {
    let reason =
      (onEditPage ? readEditBlockReason() || "" : "") ||
      runtimeState.promptState?.Ff?.N7a?.() ||
      runtimeState.promptState?.lf?.jYa?.() ||
      "";
    if (!reason) {
      let cur: Element | null = exactAfter;
      for (let depth = 0; depth < 6 && cur && !reason; depth += 1) {
        if (isExcludedComposerNode(cur)) break;
        let lv: NgLView | null = resolveLView(cur);
        for (let pDepth = 0; pDepth < 6 && Array.isArray(lv) && !reason; pDepth += 1) {
          if (lv[0] instanceof Node && isExcludedComposerNode(lv[0])) break;
          for (const cand of lv) {
            const msg = readCandidateValidatorReason(cand);
            if (msg) {
              reason = msg;
              break;
            }
          }
          lv = Array.isArray(lv[3]) ? lv[3] : Array.isArray(lv[15]) ? lv[15] : null;
        }
        cur = cur.parentElement;
      }
    }
    if (!reason && runtimeState.ngLViewMap instanceof Map) {
      for (const lv of runtimeState.ngLViewMap.values()) {
        if (!Array.isArray(lv)) continue;
        if (lv[0] instanceof Node && !lv[0].isConnected) continue;
        if (lv[0] instanceof Node && isExcludedComposerNode(lv[0])) {
          continue;
        }
        for (const cand of lv) {
          const msg = readCandidateValidatorReason(cand);
          if (msg) {
            reason = msg;
            break;
          }
        }
        if (reason) break;
      }
    }
    if (!reason) {
      reason = readAngularTooltip(exactAfter);
    }
    const visiblePm = Array.from(document.querySelectorAll(".ProseMirror")).find(
      (el) => el.getClientRects().length > 0 && !isExcludedComposerNode(el),
    );
    const fallbackPm = Array.from(document.querySelectorAll(".ProseMirror")).find(
      (el) => !isExcludedComposerNode(el),
    );
    const detail = [
      reason,
      ((visiblePm || fallbackPm)?.textContent || "").slice(
        0,
        40,
      ),
    ]
      .filter(Boolean)
      .join(" | ");
    return { ok: false, error: "start_generation_disabled", detail };
  }

  const scopedRoots: ParentNode[] = onEditPage
    ? [
        ...Array.from(document.querySelectorAll(EDIT_SCOPE_SELECTOR)).filter(
          (el) => !isExcludedComposerNode(el),
        ),
        document,
      ]
    : [document];
  const btns: Element[] = [];
  const seenBtns = new Set<Element>();
  for (const root of scopedRoots) {
    for (const b of root.querySelectorAll('button, [role="button"]')) {
      if (!seenBtns.has(b)) {
        seenBtns.add(b);
        btns.push(b);
      }
    }
  }
  const createBtn = btns.find((b): b is HTMLElement => {
    if (b.tagName === "A" || !isVisibleEnabled(b)) return false;
    if (isExcludedComposerNode(b)) {
      return false;
    }
    if (
      b.closest(
        'flow-credit-warning-button, flow-high-demand-warning-button, .cdk-overlay-pane, [role="menu"], [role="listbox"], nav, aside',
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
