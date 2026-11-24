// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Shared DOM, event, input, and FIFE URL helpers for Flow browser modules.

import type { CharacterLookEntry, FifeEnv, FlowMediaPayload, FlowTile } from "./types";

/** Short edge in pixels for each video resolution code of the Flow front end (4 = 360p, 1 = 720p, 2 = 1080p, 3 = 4K). */
const VIDEO_SHORT_EDGE: Readonly<Record<number, number>> = { 1: 720, 2: 1080, 3: 2160, 4: 360 };

/** Calculates video pixel dimensions from a Flow resolution code and an aspect ratio, or returns null. */
function videoDimensions(
  resolution: unknown,
  aspectRatio: unknown,
): { width: number; height: number } | null {
  if (typeof resolution !== "number" || typeof aspectRatio !== "number" || !(aspectRatio > 0)) {
    return null;
  }
  const edge = VIDEO_SHORT_EDGE[resolution];
  if (!edge) return null;
  return aspectRatio >= 1
    ? { width: Math.round(edge * aspectRatio), height: edge }
    : { width: edge, height: Math.round(edge / aspectRatio) };
}

/** Returns true when `d` holds a positive width and height. */
function hasDimensions(d: { width?: number; height?: number } | undefined): boolean {
  return Boolean(d && typeof d.width === "number" && d.width > 0 && typeof d.height === "number" && d.height > 0);
}

/** Media status values of the Flow front end. */
const MEDIA_STATUSES = new Set(["success", "pending", "scheduled", "failed", "canceled"]);

/** Returns the own enumerable values of `o` with their keys. */
function ownEntries(o: object): Array<[string, unknown]> {
  return Object.entries(o as Record<string, unknown>);
}

/** Returns the first field of `m` that holds only a numeric width and height. The key name changes with each front-end build. */
function findDimensions(m: object): { width?: number; height?: number } | undefined {
  for (const [, v] of ownEntries(m)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const d = v as { width?: unknown; height?: unknown };
    if (Object.keys(d).length === 2 && typeof d.width === "number" && typeof d.height === "number") {
      return d as { width: number; height: number };
    }
  }
  return undefined;
}

/** Returns the first field of `m` that holds a media status value. The key name changes with each front-end build. */
function findStatus(m: object): string | undefined {
  for (const [, v] of ownEntries(m)) {
    if (typeof v === "string" && MEDIA_STATUSES.has(v.toLowerCase())) return v;
  }
  return undefined;
}

/** Copies the media fields of a current Flow front end to the old names (`Zc` status, `tc` dimensions, `nf` error, `Lf` duration, `hc` date). It finds the status and the dimensions by shape, and calculates video dimensions when the page gives none. */
export function legacyMedia<T extends FlowMediaPayload | null | undefined>(m: T): T {
  if (!m || typeof m !== "object") return m;
  if (m.Zc !== undefined && m.tc !== undefined) return m;
  const raw = m as Record<string, unknown>;
  const found = m.tc ?? m.xc ?? findDimensions(m);
  const dims = hasDimensions(found) ? found : (videoDimensions(m.resolution, m.aspectRatio) ?? found);
  // `Cf` is the duration of a video on the 2026-11-16 front end. Read it only on a video payload.
  const duration =
    typeof m.xf === "number"
      ? m.xf
      : m.resolution !== undefined && typeof raw.Cf === "number"
        ? raw.Cf
        : undefined;
  const created = [m.hc, m.kc, raw.lc].find((v) => v instanceof Date) as Date | undefined;
  return {
    ...m,
    Zc: m.Zc ?? m.od ?? findStatus(m),
    tc: dims,
    nf: m.nf ?? m.Bf,
    Lf: m.Lf ?? duration,
    hc: m.hc ?? created,
  };
}

/** Returns the field of tile `t` that holds its media payload: an object with a string `id` and a string `workflowId`. The key name changes with each front-end build. */
function findMediaContainer(t: object): FlowMediaPayload | undefined {
  for (const [, v] of ownEntries(t)) {
    if (!v || typeof v !== "object" || Array.isArray(v) || v instanceof Map || v instanceof Date) continue;
    const c = v as { id?: unknown; workflowId?: unknown };
    if (typeof c.id === "string" && typeof c.workflowId === "string") return v as FlowMediaPayload;
  }
  return undefined;
}

/** Returns `t` with `Fb` set to its media payload under the old field names and `hc` set to its date. It finds the media payload by shape, because the key name changes with each front-end build. */
export function legacyTile<T extends FlowTile | null | undefined>(t: T): T {
  if (!t || typeof t !== "object") return t;
  const raw = t as Record<string, unknown>;
  const legacy: unknown = raw.Fb;
  if (legacy && typeof legacy === "object" && (legacy as FlowMediaPayload).Zc !== undefined) return t;
  const media =
    legacy && typeof legacy === "object"
      ? (legacy as FlowMediaPayload)
      : raw.Eb && typeof raw.Eb === "object"
        ? (raw.Eb as FlowMediaPayload)
        : findMediaContainer(t);
  // A tile without media and without the key `Fb` needs no change.
  if (!media && legacy === undefined) return t;
  const created = [t.hc, t.kc, raw.lc].find((v) => v instanceof Date) as Date | undefined;
  // A current front end can use the key `Fb` for a boolean. Do not let it pass as a media payload.
  return { ...t, Fb: legacyMedia(media), hc: t.hc ?? created };
}

/** Reads the parent collection ID from the known project tile fields. */
export function parentCollectionId(tile: FlowTile): string | null {
  if (typeof tile.Dc === "string" && tile.Dc) return tile.Dc;
  return typeof tile.Cc === "string" && tile.Cc ? tile.Cc : null;
}

/** Returns the ID of the collection that holds tile `t`, or null. It accepts the old `Fc` field, or any other string field that names a collection tile, because the key name changes with each front-end build. */
export function collectionIdOf(
  t: FlowTile | null | undefined,
  isCollectionId: (id: string) => boolean,
): string | null {
  if (!t || typeof t !== "object") return null;
  const parent = parentCollectionId(t);
  if (parent && isCollectionId(parent)) return parent;
  if (t.Fc) return String(t.Fc);
  for (const [k, v] of ownEntries(t)) {
    if (k === "id" || typeof v !== "string" || v === "") continue;
    if (isCollectionId(v)) return v;
  }
  return null;
}

/** Returns true when the project store marks the tile as trashed. */
export function isTrashedTile(t: FlowTile): boolean {
  return t.trashed === true || t.isTrashed === true || t.Cb === true ||
    t.yb === true || t.Ab === true;
}

/** Returns the look map of character tile `t`, or null. It accepts the old `oi` field, or any other `Map` field whose entries hold a `primaryMediaId` or a `history`, because the key name changes with each front-end build. */
export function characterLooksOf(
  t: FlowTile | null | undefined,
): Map<unknown, CharacterLookEntry> | null {
  if (!t || typeof t !== "object") return null;
  if (t.oi instanceof Map) return t.oi;
  for (const [, v] of ownEntries(t)) {
    if (!(v instanceof Map) || v.size === 0) continue;
    const first: unknown = v.values().next().value;
    if (first && typeof first === "object" && ("primaryMediaId" in first || "history" in first)) {
      return v as Map<unknown, CharacterLookEntry>;
    }
  }
  return null;
}

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

/** Returns the first visible snackbar element whose text matches `regex`. */
export function findSnackbarMatch(
  regex: RegExp,
): { text: string; bar: Element } | null {
  for (const el of document.querySelectorAll(
    "flow-snackbar, simple-snack-bar, mat-snack-bar-container, [matsnackbarlabel]",
  )) {
    const text = elText(el);
    if (text && regex.test(text)) {
      const bar =
        el.closest("flow-snackbar, simple-snack-bar, mat-snack-bar-container") ||
        el;
      return { text, bar };
    }
  }
  return null;
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
export function pickTileUrl(tile: FlowTile | null | undefined): string | null {
  const t = legacyTile(tile);
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

/** Reads non-destructive start and end trim bounds in seconds from a project tile. */
export function videoTrimBounds(
  rawTile: FlowTile | null | undefined,
): { start: number | null; end: number | null } {
  const t = legacyTile(rawTile);
  if (!t) return { start: null, end: null };
  const isVideo = String(t.type ?? "VIDEO").toUpperCase() === "VIDEO";
  const start =
    isVideo && typeof t.Fb?.Jc === "number"
      ? t.Fb.Jc
      : typeof t.trimStartSeconds === "number"
        ? t.trimStartSeconds
        : typeof t.Fb?.Ac === "number"
          ? t.Fb.Ac
          : typeof t.Ac === "number"
            ? t.Ac
            : typeof t.Cg === "number"
              ? t.Cg
              : typeof t.Fb?.Cg === "number"
                ? t.Fb.Cg
                : null;
  const end =
    isVideo && typeof t.Fb?.Pc === "number"
      ? t.Fb.Pc
      : typeof t.trimEndSeconds === "number"
        ? t.trimEndSeconds
        : typeof t.Fb?.Ic === "number"
          ? t.Fb.Ic
          : typeof t.Ic === "number"
            ? t.Ic
            : typeof t.Rf === "number"
              ? t.Rf
              : typeof t.Fb?.Rf === "number"
                ? t.Fb.Rf
                : null;
  return { start, end };
}
