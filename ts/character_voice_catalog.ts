// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Angular voice catalog, row metadata, and custom voice audio helpers for the character editor.

import { isLiveLView, readOwn, resolveLView, withLViewMapCapture } from "./angular";
import { hoverProbe } from "./dom";
import {
  characterPreviewFormat,
  characterVoiceFormat,
  frontendBuild,
  readBuildLabel,
} from "./frontend_builds";
import { resolveVideoUrl } from "./resolve_video_url";
import { runtimeState } from "./state";
import type { AngularLifecycleHandle } from "./types";

/** Voice metadata shared across dialog rows and Angular voice catalogs. */
export interface VoiceMeta {
  /** Canonical voice ID (`"voices/<name>"` for presets or a custom UUID). */
  id?: string;
  /** Voice name as the dialog shows it. */
  name: string;
  /** Voice description, for example "Female, soft, high pitch". */
  description: string | null;
  /** True for a saved custom voice. */
  custom: boolean;
  /** Audio media UUID when the voice entry exposes one. */
  mediaId?: string;
  /** Workflow UUID when the custom voice entry exposes one. */
  workflowId?: string;
}

/** Pattern that matches canonical UUID strings. */
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Pattern that matches static sample paths built erroneously from custom voice UUIDs. */
const BOGUS_SAMPLE_UUID_RE =
  /\/voices\/samples\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.wav(?:[?#]|$)/i;

/** Allow-listed property and signal names read on `flow-add-menu-asset-item` views. */
const ROW_ITEM_ALLOW_KEYS = ["asset", "item", "voice", "$implicit"] as const;

/** Calls a zero-argument signal or getter method safely on `target`. */
function callSignal(target: unknown, key: string): unknown {
  const fn = readOwn(target, key);
  if (typeof fn !== "function") return undefined;
  try {
    return fn.call(target);
  } catch {
    return undefined;
  }
}

/** Walks an Angular host view and live registry views to find a matching component. */
function findHostComponent(
  host: Element | null | undefined,
  matches: (candidate: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  if (!host) return null;
  const visited = new Set<unknown>();
  const scan = (
    lv: unknown,
    depth: number,
  ): Record<string, unknown> | null => {
    if (!Array.isArray(lv) || depth > 2 || visited.has(lv)) return null;
    visited.add(lv);
    for (const item of lv) {
      if (
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        !(item instanceof Node) &&
        !(item instanceof Map) &&
        !(item instanceof Set) &&
        matches(item as Record<string, unknown>)
      ) {
        return item as Record<string, unknown>;
      }
      const nested =
        depth < 2 && Array.isArray(item) ? scan(item, depth + 1) : null;
      if (nested) return nested;
    }
    return null;
  };
  const direct = scan(resolveLView(host), 0);
  if (direct) return direct;
  for (const candidate of runtimeState.ngLViewMap?.values() ?? []) {
    const hit =
      isLiveLView(candidate) && candidate[0] === host
        ? scan(candidate, 0)
        : null;
    if (hit) return hit;
  }
  return null;
}

/** Probes `hosts` inside Angular LView map capture when their views are not yet bound. */
export async function ensureAngularHostsBound(
  hosts: Array<Element | null | undefined>,
): Promise<void> {
  const live = hosts.filter((h): h is Element => Boolean(h));
  if (live.length === 0 || live.every((h) => Boolean(resolveLView(h)))) return;
  const targets = live.flatMap((h) => [
    h,
    ...Array.from(
      h.querySelectorAll(
        "flow-character-voice-button, flow-add-menu-asset-item, [mattooltip], button",
      ),
    ).slice(0, 6),
  ]);
  await withLViewMapCapture(async () => {
    await hoverProbe(targets);
    for (const inp of live.flatMap((h) =>
      Array.from(h.querySelectorAll("input, textarea")).slice(0, 4),
    )) {
      inp.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
    }
  });
}

/** Returns the live `flow-character-form` Angular component instance, or null. */
export function findCharacterFormComponent(): Record<string, unknown> | null {
  const fmt = characterVoiceFormat();
  return findHostComponent(
    document.querySelector("flow-character-form"),
    (cand) => {
      const lc = readOwn(cand as AngularLifecycleHandle, fmt.lifecycle);
      if (lc && typeof lc === "object" && readOwn(lc, fmt.destroyed)) {
        return false;
      }
      return (
        typeof readOwn(cand, fmt.selectedVoice) === "function" ||
        typeof readOwn(cand, fmt.voiceMap) === "function"
      );
    },
  );
}

/** Returns the selected voice ID reported by `flow-character-form`, or an empty string. */
export function currentCharacterFormVoiceId(): string {
  const formComp = findCharacterFormComponent();
  if (!formComp) return "";
  const raw = callSignal(formComp, characterVoiceFormat().selectedVoice);
  return typeof raw === "string" ? raw.trim() : "";
}

/** Converts a raw Angular voice object into `VoiceMeta` with a canonical `id`, or null. */
function parseVoiceAsset(raw: unknown): (VoiceMeta & { id: string }) | null {
  if (
    !raw ||
    typeof raw !== "object" ||
    raw instanceof Node ||
    Array.isArray(raw)
  ) {
    return null;
  }
  const idVal = readOwn(raw, "id") ?? readOwn(raw, "voiceId");
  const titleVal =
    readOwn(raw, "title") ?? readOwn(raw, "name") ?? readOwn(raw, "displayName");
  const rawId = typeof idVal === "string" ? idVal.trim() : "";
  const rawName = typeof titleVal === "string" ? titleVal.trim() : "";
  if (!rawId && !rawName) return null;
  const mediaVal = readOwn(raw, "mediaId") ?? readOwn(raw, "primaryMediaId");
  const workflowVal = readOwn(raw, "workflowId");
  const mediaId =
    typeof mediaVal === "string" && mediaVal.trim()
      ? mediaVal.trim()
      : undefined;
  const workflowId =
    typeof workflowVal === "string" && workflowVal.trim()
      ? workflowVal.trim()
      : undefined;
  const descVal = readOwn(raw, "description");
  const description =
    typeof descVal === "string" && descVal.trim() ? descVal.trim() : null;
  const presetFlag = readOwn(raw, "Rv") === true || /^voices\//i.test(rawId);
  const customFlag =
    readOwn(raw, "custom") === true ||
    readOwn(raw, "isCustom") === true ||
    readOwn(raw, "B$") === true;
  const custom =
    customFlag ||
    (!presetFlag &&
      Boolean(
        workflowId || UUID_RE.test(rawId) || (mediaId && UUID_RE.test(mediaId)),
      ));
  const name = rawName || rawId.replace(/^voices\//i, "");
  const id = rawId
    ? !custom && !/^voices\//i.test(rawId)
      ? `voices/${rawId}`
      : rawId
    : custom
      ? workflowId || mediaId || name
      : `voices/${name}`;
  return {
    id,
    name,
    description,
    custom,
    ...(mediaId ? { mediaId } : {}),
    ...(workflowId ? { workflowId } : {}),
  };
}

/** Reads voice metadata from allow-listed fields on one `flow-add-menu-asset-item` host, or null. */
export function readRowItemMeta(
  button: HTMLElement,
): (VoiceMeta & { id: string }) | null {
  const itemHost = button.querySelector("flow-add-menu-asset-item") ?? button;
  let found: (VoiceMeta & { id: string }) | null = null;
  const isVoiceObj = (v: unknown): boolean =>
    typeof readOwn(v, "title") === "string" ||
    typeof readOwn(v, "mediaId") === "string" ||
    typeof readOwn(v, "workflowId") === "string";
  findHostComponent(itemHost, (cand) => {
    const direct = parseVoiceAsset(cand);
    if (direct && isVoiceObj(cand)) {
      found = direct;
      return true;
    }
    for (const key of ROW_ITEM_ALLOW_KEYS) {
      const prop = readOwn(cand, key);
      const val =
        key !== "$implicit" && typeof prop === "function" && prop.length === 0
          ? callSignal(cand, key)
          : prop;
      const parsed = parseVoiceAsset(val);
      if (parsed && isVoiceObj(val)) {
        found = parsed;
        return true;
      }
    }
    return false;
  });
  return found;
}

/** Pushes voice entries from a `Map`, array, query `.data()`, or single record into `sink`. */
function pushVoiceSource(source: unknown, sink: (item: unknown) => void): void {
  if (!source) return;
  if (source instanceof Map || Array.isArray(source)) {
    for (const v of source.values()) sink(v);
    return;
  }
  sink(source);
  if (typeof source === "object" && !(source instanceof Node)) {
    for (const key of Object.keys(source)) {
      const prop = readOwn(source, key);
      if (Array.isArray(prop)) {
        for (const v of prop) sink(v);
      }
    }
  }
}

/** Reads resolved `.data()` or `.state.data` from a query signal object on `comp`. */
function readQueryData(comp: Record<string, unknown>, key: string): unknown {
  const q = readOwn(comp, key);
  if (!q || typeof q !== "object") return undefined;
  return (
    (typeof readOwn(q, "data") === "function"
      ? callSignal(q, "data")
      : readOwn(q, "data")) ?? readOwn(readOwn(q, "state"), "data")
  );
}

/** Collects voice metadata from `flow-add-menu-popover-content` and `flow-character-form`. */
export function readBoundVoiceCatalog(
  pane: Element | null,
): Array<VoiceMeta & { id: string }> {
  const out: Array<VoiceMeta & { id: string }> = [];
  const seen = new Set<string>();
  const push = (raw: unknown): void => {
    const parsed = parseVoiceAsset(raw);
    const key = parsed
      ? `${parsed.custom ? "1" : "0"}:${parsed.id.toLowerCase()}`
      : "";
    if (parsed && !seen.has(key)) {
      seen.add(key);
      out.push(parsed);
    }
  };
  const previewFmt = characterPreviewFormat();
  const confirmFmt = frontendBuild(readBuildLabel())?.voiceConfirmation;
  const pickerComp = findHostComponent(
    pane?.querySelector("flow-add-menu-popover-content"),
    (cand) =>
      typeof readOwn(cand, previewFmt.pickerAssets) === "function" ||
      Boolean(
        confirmFmt &&
          typeof readOwn(cand, confirmFmt.pickerSelection) === "function",
      ),
  );
  if (pickerComp) {
    pushVoiceSource(callSignal(pickerComp, previewFmt.pickerAssets), push);
    if (confirmFmt) {
      pushVoiceSource(callSignal(pickerComp, confirmFmt.pickerSelection), push);
    }
  }
  const formComp = findCharacterFormComponent();
  if (formComp) {
    const voiceFmt = characterVoiceFormat();
    pushVoiceSource(callSignal(formComp, voiceFmt.voiceMap), push);
    push(callSignal(formComp, voiceFmt.selectedRecord));
    push(callSignal(formComp, "ha"));
    pushVoiceSource(readQueryData(formComp, "ma"), push);
    pushVoiceSource(readQueryData(formComp, "na"), push);
  }
  return out;
}

/** Reads clean visible text from `el` without Material icon or hidden badge text. */
export function cleanVoiceLabel(
  el: Element | null,
  iconWords: ReadonlySet<string>,
): string {
  if (!el) return "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (
      !node.parentElement?.closest(
        "mat-icon, .favorite-icon, .custom-voice-badge, .cdk-visually-hidden",
      )
    ) {
      const text = node.textContent?.trim();
      if (text && !iconWords.has(text)) parts.push(text);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Returns true when `url` is a synthetic `/voices/samples/<uuid>.wav` fallback URL. */
export function isBogusVoiceSampleUrl(
  url: string,
  isCustomVoice = false,
): boolean {
  return (
    BOGUS_SAMPLE_UUID_RE.test(url) ||
    (isCustomVoice && /\/voices\/samples\/[^/?#]+\.wav(?:[?#]|$)/i.test(url))
  );
}

/** Extracts the UUID from a synthetic `/voices/samples/<uuid>.wav` URL, or an empty string. */
export function extractBogusSampleUuid(url: string): string {
  return BOGUS_SAMPLE_UUID_RE.exec(url)?.[1] ?? "";
}

/** Returns true when a TanStack Query object on `flow-character-form` is loading initial data. */
function isVoiceQueryLoading(query: unknown): boolean {
  if (!query || typeof query !== "object") return false;
  for (const key of ["isLoading", "isPending"]) {
    if (
      Boolean(
        typeof readOwn(query, key) === "function"
          ? callSignal(query, key)
          : readOwn(query, key),
      )
    ) {
      return true;
    }
  }
  const hasData =
    typeof readOwn(query, "data") === "function"
      ? callSignal(query, "data") != null
      : true;
  const fetching =
    typeof readOwn(query, "isFetching") === "function"
      ? Boolean(callSignal(query, "isFetching"))
      : readOwn(query, "isFetching") === true;
  return !hasData && fetching;
}

/** Returns true while `w4.ma`, `w4.na`, or `flow-character-form` busy state is loading. */
export function isFormVoiceAudioLoading(
  formComp: Record<string, unknown> | null,
): boolean {
  return (
    Boolean(formComp) &&
    (isVoiceQueryLoading(readOwn(formComp, "ma")) ||
      isVoiceQueryLoading(readOwn(formComp, "na")) ||
      Boolean(callSignal(formComp, characterVoiceFormat().busy)))
  );
}

/** Reads the custom voice `mediaId` or UUID of the selected voice on `flow-character-form`. */
export function readFormCustomVoiceMediaId(
  formComp: Record<string, unknown> | null,
): { isCustom: boolean; mediaId: string | null } {
  if (!formComp) return { isCustom: false, mediaId: null };
  const fmt = characterVoiceFormat();
  const rawSel = callSignal(formComp, fmt.selectedVoice);
  const selectedId = typeof rawSel === "string" ? rawSel.trim() : "";
  const lowSel = selectedId.toLowerCase();
  const candidates: Array<VoiceMeta & { id: string }> = [];
  const push = (raw: unknown): void => {
    const p = parseVoiceAsset(raw);
    if (p) candidates.push(p);
  };
  push(callSignal(formComp, fmt.selectedRecord));
  push(callSignal(formComp, "ha"));
  pushVoiceSource(callSignal(formComp, fmt.voiceMap), push);
  pushVoiceSource(readQueryData(formComp, "ma"), push);
  pushVoiceSource(readQueryData(formComp, "na"), push);
  const matchesSelected = (m: VoiceMeta & { id: string }): boolean =>
    !lowSel ||
    m.id.toLowerCase() === lowSel ||
    m.workflowId?.toLowerCase() === lowSel ||
    m.mediaId?.toLowerCase() === lowSel ||
    `voices/${m.name}`.toLowerCase() === lowSel;
  const hit =
    candidates.find((m) => matchesSelected(m) && Boolean(m.mediaId)) ??
    candidates.find(matchesSelected) ??
    (!lowSel ? candidates[0] : undefined);
  if (hit) {
    return {
      isCustom: hit.custom,
      mediaId: hit.custom
        ? hit.mediaId || (UUID_RE.test(hit.id) ? hit.id : null)
        : null,
    };
  }
  return selectedId && UUID_RE.test(selectedId)
    ? { isCustom: true, mediaId: selectedId }
    : { isCustom: false, mediaId: null };
}

/** Resolves a custom voice audio URL through `resolveVideoUrl` when `mediaId` is available. */
export async function resolveCustomAudioUrl(
  mediaId: string | null | undefined,
): Promise<string> {
  const clean = typeof mediaId === "string" ? mediaId.trim() : "";
  if (!clean || /^voices\//i.test(clean)) return "";
  const resolved = await resolveVideoUrl(clean);
  return resolved?.ok === true
    ? String(resolved.url || resolved.download_url || "").trim()
    : "";
}
