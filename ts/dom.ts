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

/** Tile types that represent user-facing project assets in snapshot and collection counts. */
export const ASSET_TILE_TYPES: ReadonlySet<string> = new Set([
  "IMAGE",
  "VIDEO",
  "SCENE",
  "CHARACTER",
]);

/** Returns the own enumerable values of `o` with their keys. */
function ownEntries(o: object): Array<[string, unknown]> {
  return Object.entries(o as Record<string, unknown>);
}

/** Property names that hold text or identifiers and never hold direct media URLs. */
const NON_URL_KEYS = new Set([
  "id",
  "workflowId",
  "entityId",
  "mediaId",
  "primaryMediaId",
  "displayName",
  "title",
  "name",
  "type",
  "prompt",
  "personalityNotes",
  "description",
  "Mv",
  "Zc",
  "od",
  "nf",
  "Bf",
  "Fc",
  "Cc",
  "Dc",
  "hc",
  "createTime",
  "createDate",
  "voice",
  "voiceName",
  "voiceId",
  "Vo",
]);

/** Ordered video stream field names checked first for video items. */
const VIDEO_URL_KEYS = ["Bd", "uA", "videoUrl"] as const;

/** Ordered media URL field names checked before scanning unknown minified keys. */
const MEDIA_URL_KEYS = [
  "Wb",
  "fifeUrl",
  "imageUrl",
  "videoUrl",
  "mediaUrl",
  "url",
  "Bd",
  "uA",
  "ue",
  "kc",
] as const;

/** Reads a property from `obj` and returns undefined when access throws. */
function readProp(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  try {
    return Reflect.get(obj as object, key);
  } catch {
    return undefined;
  }
}

/** Returns `v` when `v` is a valid HTTP, `blob:`, or `data:` media URL string. */
export function asMediaUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || /\s/.test(s)) return null;
  if (/^(?:blob:|data:)/i.test(s)) return s;
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    new URL(s);
    return s;
  } catch {
    return null;
  }
}

/** Returns true when `u` uses `blob:`, `data:`, or a Google Flow media host. */
function isFlowHostUrl(u: string): boolean {
  if (/^(?:blob:|data:)/i.test(u)) return true;
  try {
    const host = new URL(u).hostname.toLowerCase();
    return (
      host === "flow-content.google" ||
      host.endsWith(".flow-content.google") ||
      host === "storage.googleapis.com" ||
      host.endsWith(".googleusercontent.com") ||
      host.endsWith(".fife.usercontent.google.com") ||
      host.endsWith(".google.com") ||
      host.endsWith(".google")
    );
  } catch {
    return false;
  }
}

/** Returns true when `u` carries a video stream path, host, or FIFE video suffix. */
function isVideoStreamUrl(u: string): boolean {
  return /(?:\/video\/|\.mp4(?:$|[?#])|video-downloads\.googleusercontent\.com|=mm,|=dv(?:$|[?#]))/i.test(
    u,
  );
}

/** Returns true when `v` is a record object that can hold media fields. */
function isRecordCandidate(v: unknown): v is object {
  return Boolean(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      !(v instanceof Date) &&
      !(v instanceof Map) &&
      !(v instanceof Set) &&
      !(v instanceof Node) &&
      (typeof window === "undefined" || v !== window) &&
      (typeof document === "undefined" || v !== document),
  );
}

/** Collects unique media URLs directly on `obj` from known keys and URL-shaped fields. */
function directMediaUrls(obj: unknown): string[] {
  if (!isRecordCandidate(obj)) return [];
  const seen = new Set<string>();
  const preferred: string[] = [];
  const fallback: string[] = [];
  const push = (val: unknown): void => {
    const u = asMediaUrl(val);
    if (!u || seen.has(u)) return;
    seen.add(u);
    if (isFlowHostUrl(u)) preferred.push(u);
    else fallback.push(u);
  };
  for (const key of MEDIA_URL_KEYS) {
    const u = asMediaUrl(readProp(obj, key));
    if (u && !seen.has(u)) {
      seen.add(u);
      preferred.push(u);
    }
  }
  for (const [k, v] of ownEntries(obj)) {
    if (!NON_URL_KEYS.has(k)) push(v);
  }
  if (
    preferred.length === 0 &&
    fallback.length === 0 &&
    Boolean(
      readProp(obj, "id") ||
        readProp(obj, "workflowId") ||
        readProp(obj, "mediaId") ||
        readProp(obj, "primaryMediaId") ||
        readProp(obj, "entityId"),
    )
  ) {
    let proto: object | null = Object.getPrototypeOf(obj) as object | null;
    for (let depth = 0; proto && proto !== Object.prototype && depth < 2; depth += 1) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === "constructor" || NON_URL_KEYS.has(key)) continue;
        const desc = Object.getOwnPropertyDescriptor(proto, key);
        if (typeof desc?.get === "function") {
          try {
            push(desc.get.call(obj));
          } catch {
            // Ignore unsafe prototype getters.
          }
        }
      }
      proto = Object.getPrototypeOf(proto) as object | null;
    }
  }
  return [...preferred, ...fallback];
}

/** Selects the best direct media URL on `obj`, preferring video streams when `preferVideo` is true. */
export function mediaUrlOf(obj: unknown, preferVideo = false): string | null {
  if (!isRecordCandidate(obj)) return null;
  if (preferVideo) {
    for (const key of VIDEO_URL_KEYS) {
      const u = asMediaUrl(readProp(obj, key));
      if (u) return u;
    }
  }
  const urls = directMediaUrls(obj);
  if (preferVideo) {
    const stream = urls.find(isVideoStreamUrl);
    if (stream) return stream;
  }
  return urls[0] ?? null;
}

/** Returns the first own `Date` value on `o`, keeping timestamps separate from URL strings. */
function findDate(o: object): Date | undefined {
  for (const [, v] of ownEntries(o)) {
    if (v instanceof Date) return v;
  }
  return undefined;
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

/** Copies the media fields of a current Flow front end to the old names (`Wb` URL, `Zc` status, `tc` dimensions, `nf` error, `Lf` duration, `hc` date). It finds the URL, status, date, and dimensions by shape, and calculates video dimensions when the page gives none. */
export function legacyMedia<T extends FlowMediaPayload | null | undefined>(m: T): T {
  if (!m || typeof m !== "object") return m;
  const existingUrl = asMediaUrl(m.Wb);
  const detectedUrl = existingUrl ?? mediaUrlOf(m);
  if (
    m.Zc !== undefined &&
    m.tc !== undefined &&
    (existingUrl !== null || detectedUrl === null)
  ) {
    return m;
  }
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
  const created =
    ([m.hc, m.kc, raw.lc].find((v) => v instanceof Date) as Date | undefined) ??
    findDate(m);
  return {
    ...m,
    ...(detectedUrl && existingUrl === null ? { Wb: detectedUrl } : {}),
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

/** Returns `t` with `Fb` set to its media payload under the old field names and `hc` set to its date. It finds the media payload and date by shape, because key names change with each front-end build. */
export function legacyTile<T extends FlowTile | null | undefined>(t: T): T {
  if (!t || typeof t !== "object") return t;
  const raw = t as Record<string, unknown>;
  const legacy: unknown = raw.Fb;
  const legacyObj =
    legacy && typeof legacy === "object" ? (legacy as FlowMediaPayload) : undefined;
  if (
    legacyObj &&
    legacyObj.Zc !== undefined &&
    legacyObj.tc !== undefined &&
    (asMediaUrl(legacyObj.Wb) !== null || mediaUrlOf(legacyObj) === null) &&
    t.hc !== undefined
  ) {
    return t;
  }
  const media =
    legacyObj ??
    (raw.Eb && typeof raw.Eb === "object"
      ? (raw.Eb as FlowMediaPayload)
      : findMediaContainer(t));
  const created =
    ([t.hc, t.kc, raw.lc].find((v) => v instanceof Date) as Date | undefined) ??
    findDate(t);
  // A tile without media, without the key `Fb`, and without a new date needs no change.
  if (!media && legacy === undefined && (t.hc !== undefined || !created)) return t;
  // A current front end can use the key `Fb` for a boolean. Do not let it pass as a media payload.
  return {
    ...t,
    ...(media || legacy !== undefined ? { Fb: legacyMedia(media) } : {}),
    hc: t.hc ?? created,
  };
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

/** Returns true when `m` carries a non-ready or failed media status. */
function isNonReadyLookItem(m: unknown): boolean {
  if (!isRecordCandidate(m)) return false;
  const status = String(
    readProp(m, "Zc") ?? readProp(m, "od") ?? findStatus(m) ?? "",
  ).toLowerCase();
  return (
    status === "pending" ||
    status === "scheduled" ||
    status === "failed" ||
    status === "canceled"
  );
}

/** Extracts a media URL from one character look slot or look history entry. */
function lookEntryUrl(item: unknown): string | null {
  if (!isRecordCandidate(item) || isNonReadyLookItem(item)) return null;
  const direct = mediaUrlOf(item);
  if (direct) return direct;
  const nestedMedia = readProp(item, "media");
  if (isRecordCandidate(nestedMedia) && !isNonReadyLookItem(nestedMedia)) {
    const nestedUrl = mediaUrlOf(nestedMedia);
    if (nestedUrl) return nestedUrl;
  }
  const container = findMediaContainer(item);
  if (container && !isNonReadyLookItem(container)) {
    const containerUrl = mediaUrlOf(container);
    if (containerUrl) return containerUrl;
  }
  for (const [, v] of ownEntries(item)) {
    if (!isRecordCandidate(v) || isNonReadyLookItem(v)) continue;
    const subUrl = mediaUrlOf(v);
    if (subUrl) return subUrl;
  }
  return null;
}

/** Resolves the preview media URL and primary media ID from a character tile's look slots. */
export function characterLookMedia(t: FlowTile | null | undefined): {
  url: string | null;
  primaryMediaId: string | number | null;
} {
  if (!t || typeof t !== "object") return { url: null, primaryMediaId: null };
  let url = asMediaUrl(t.ue);
  let primaryMediaId: string | number | null = null;
  const looks = characterLooksOf(t);
  if (!looks) return { url, primaryMediaId };
  for (const entry of looks.values()) {
    if (!entry || typeof entry !== "object") continue;
    if (!primaryMediaId && entry.primaryMediaId) {
      primaryMediaId = entry.primaryMediaId;
    }
    if (!url) {
      url = lookEntryUrl(entry);
    }
    if (!url && Array.isArray(entry.history)) {
      const wantId = entry.primaryMediaId ? String(entry.primaryMediaId) : "";
      const primaryHit = wantId
        ? entry.history.find((h) => {
            const hid = readProp(h, "id") ?? readProp(h, "mediaId");
            return hid != null && String(hid) === wantId;
          })
        : undefined;
      const ordered = primaryHit
        ? [primaryHit, ...entry.history]
        : entry.history;
      for (const h of ordered) {
        url = lookEntryUrl(h);
        if (url) break;
      }
    }
    if (url && primaryMediaId) break;
  }
  return { url, primaryMediaId };
}

/** Collects all candidate media URLs from a tile, media record, or picker item. */
export function mediaUrlsOf(obj: unknown): string[] {
  if (!isRecordCandidate(obj)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const addAll = (urls: string[]): void => {
    for (const u of urls) {
      if (!seen.has(u)) {
        seen.add(u);
        out.push(u);
      }
    }
  };
  addAll(directMediaUrls(obj));
  for (const key of ["Fb", "Eb", "fb", "media"]) {
    addAll(directMediaUrls(readProp(obj, key)));
  }
  const container = findMediaContainer(obj);
  if (container) addAll(directMediaUrls(container));
  const lookUrl = characterLookMedia(obj as FlowTile).url;
  if (lookUrl && !seen.has(lookUrl)) {
    seen.add(lookUrl);
    out.push(lookUrl);
  }
  return out;
}

/** Strips query parameters and FIFE size suffixes for base URL comparison. */
export function fifeBase(u: unknown): string {
  if (typeof u !== "string") return "";
  const s = u.trim();
  return s ? s.split("?")[0].split("=")[0] : "";
}

/** Selects the best available media URL from a project tile object. */
export function pickTileUrl(tile: FlowTile | null | undefined): string | null {
  const t = legacyTile(tile);
  if (!t || typeof t !== "object") return null;
  const isVideo = String(t.type ?? "").toUpperCase() === "VIDEO";
  return (
    mediaUrlOf(t.Fb, isVideo) ||
    mediaUrlOf(t, isVideo) ||
    mediaUrlOf(t.fb, isVideo) ||
    characterLookMedia(t).url ||
    null
  );
}
