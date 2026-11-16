// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Shared DOM, event, input, and FIFE URL helpers for Flow browser modules.

import type { FifeEnv, FlowTile } from "./types";

/** Waits for `ms` milliseconds before resolving. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads trimmed visible text or `aria-label` fallback from an element. */
export function elText(el: Element | null | undefined): string {
  if (!el) return "";
  const htmlEl = el as Partial<HTMLElement>;
  return (htmlEl.innerText ?? el.textContent ?? "").trim();
}

/** Reads the `disabled` property on form controls or buttons when present. */
export function isDisabledProp(el: Element): boolean {
  return Boolean((el as { disabled?: boolean }).disabled);
}

/** Returns true when `el` is rendered, visible, and not disabled. */
export function isVisibleEnabled(el: Element | null | undefined): el is HTMLElement {
  return Boolean(
    el instanceof HTMLElement &&
      !isDisabledProp(el) &&
      el.getAttribute("aria-disabled") !== "true" &&
      el.getClientRects().length > 0,
  );
}

/** Updates an `<input>` or `<textarea>` through its native prototype value setter and emits DOM events. */
export function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  withBlur = false,
): void {
  const proto =
    el.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (withBlur) {
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }
}

/** Dispatches hover pointer and mouse events to nudge lazy Angular tooltips or templates. */
export async function hoverProbe(elements: Element[], enterPauseMs = 25): Promise<void> {
  for (const el of elements) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + Math.min(24, Math.max(2, rect.width / 2));
    const cy = rect.top + Math.min(24, Math.max(2, rect.height / 2));
    for (const ev of [
      new PointerEvent("pointerenter", {
        bubbles: false,
        clientX: cx,
        clientY: cy,
      }),
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: cx,
        clientY: cy,
      }),
      new MouseEvent("mouseenter", {
        bubbles: false,
        clientX: cx,
        clientY: cy,
      }),
    ]) {
      el.dispatchEvent(ev);
    }
  }
  await delay(enterPauseMs);
  for (const el of elements) {
    for (const ev of [
      new PointerEvent("pointerleave", { bubbles: false }),
      new MouseEvent("mouseleave", { bubbles: false }),
    ]) {
      el.dispatchEvent(ev);
    }
  }
  await delay(25);
}

/** Finds and clicks the first visible enabled interactive element matching `regex`. */
export function clickButtonByRegex(regex: RegExp, root: ParentNode = document): boolean {
  const els = Array.from(
    root.querySelectorAll('button, flow-button, a, [role="button"], [role="menuitem"]'),
  );
  const hit = els.find((el): el is HTMLElement => {
    if (!isVisibleEnabled(el)) return false;
    const aria = (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      ""
    ).trim();
    const raw = elText(el);
    if (/create tool|create with google flow|new project/i.test(`${aria} ${raw}`)) {
      return false;
    }
    const tail =
      raw
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .pop() || "";
    return regex.test(aria) || regex.test(raw) || regex.test(tail);
  });
  if (hit) {
    const inner = hit.tagName === "FLOW-BUTTON" ? hit.querySelector("button") : null;
    const target = inner instanceof HTMLElement ? inner : hit;
    target.click();
    return true;
  }
  return false;
}

/** Sends Escape and clicks `.cdk-overlay-backdrop` to close open modal dialogs or menus. */
export async function dismissOverlay(): Promise<void> {
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
  await delay(100);
  const backdrop = document.querySelector(".cdk-overlay-backdrop");
  if (backdrop instanceof HTMLElement) {
    backdrop.click();
    await delay(120);
  }
}

/** Extracts active FIFE host, `authuser`, and signed-CDN detection from `window.WIZ_global_data`. */
export function fifeEnv(): FifeEnv {
  const wiz = window.WIZ_global_data || {};
  const wizStr = typeof wiz.TSDtV === "string" ? wiz.TSDtV : "";
  const hostMatch = /\[45814675,null,null,null,"([^"]+)"/.exec(wizStr);
  const locHost = String(location.hostname || "").toLowerCase();
  const fifeHost =
    (hostMatch && hostMatch[1]) ||
    (locHost.endsWith(".google.com") || locHost.endsWith(".google")
      ? locHost
      : "flow.google.com");
  const pathUserMatch = /^\/u\/(\d+)(?:\/|$)/.exec(location.pathname || "");
  const searchUser = new URLSearchParams(location.search).get("authuser");
  const authuser =
    pathUserMatch && pathUserMatch[1] !== "0"
      ? pathUserMatch[1]
      : searchUser && searchUser !== "0"
        ? searchUser
        : null;
  const isSignedCdnHost = (parsed: URL): boolean => {
    const host = parsed.hostname.toLowerCase();
    return (
      host === "storage.googleapis.com" ||
      host === "flow-content.google" ||
      host.endsWith(".flow-content.google") ||
      host === "video-downloads.googleusercontent.com" ||
      parsed.searchParams.has("Signature") ||
      parsed.searchParams.has("X-Goog-Signature") ||
      parsed.searchParams.has("GoogleAccessId")
    );
  };
  return { fifeHost, authuser, isSignedCdnHost };
}

/** Strips query parameters and FIFE size suffixes for base URL comparison. */
export function fifeBase(u: unknown): string {
  const s = String(u || "").trim();
  return s ? s.split("?")[0].split("=")[0] : "";
}

/** Selects the best available media URL from a project tile object. */
export function pickTileUrl(t: FlowTile | null | undefined): string | null {
  return (
    t?.Fb?.Wb ||
    t?.Fb?.fifeUrl ||
    t?.Fb?.imageUrl ||
    t?.Fb?.videoUrl ||
    t?.Fb?.url ||
    t?.Wb ||
    t?.fifeUrl ||
    t?.imageUrl ||
    t?.videoUrl ||
    t?.url ||
    t?.ue ||
    null
  );
}
