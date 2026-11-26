// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Custom voices, full voice lists, voice previews, and slot actions on the open character editor page.

import { isLiveLView, readOwn, resolveLView, withLViewMapCapture } from "./angular";
import { clickButtonByRegex, delay, dismissOverlay, elText, findSnackbarMatch, hoverProbe, isVisibleEnabled, setNativeValue } from "./dom";
import { characterPreviewFormat, characterVoiceFormat, frontendBuild, readBuildLabel, type VoiceConfirmationFormat } from "./frontend_builds";
import { resolveVideoUrl } from "./resolve_video_url";
import { runtimeState } from "./state";
import type { AngularLifecycleHandle, CharacterExtraOpRequest } from "./types";
import { bindCustomVoiceReceipt, bindVoiceConfirmation } from "./voice_confirmation";

/** Image slot name on the character preview panel. */
export type CharacterImageSlot = "portrait" | "body";

/** Result from clearing one character image slot. */
export type CharacterSlotClearResult =
  | { /** Ready state. */ ok: true; /** Deleted flag. */ deleted: boolean; /** Empty flag. */ empty?: true }
  | { /** Error state. */ ok: false; /** Error code. */ error: string };

/** Result from opening the project asset picker for the selected image slot. */
export type SlotPickerOpenResult =
  | { /** Picker opened. */ ok: true }
  | { /** Picker failed. */ ok: false; /** Error code. */ error: string };

/** Voice metadata shared across dialog rows and Angular voice catalogs. */
interface VoiceMeta {
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

/** One voice row in the "Select a voice" dialog. */
interface VoiceRow extends VoiceMeta {
  /** Row button element. */
  el: HTMLElement;
}

/** Icon ligature and badge words that the dialog renders as text inside voice rows. */
export const VOICE_ICON_WORDS: ReadonlySet<string> = new Set([
  "voice_selection", "settings_2", "play_arrow", "favorite", "Favorited",
]);

/** Pattern matching canonical UUID strings. */
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Pattern matching static sample paths synthesized erroneously from custom voice UUIDs. */
const BOGUS_SAMPLE_UUID_RE = /\/voices\/samples\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.wav(?:[?#]|$)/i;

/** Selector matching containers excluded from preview-panel slot queries. */
const SLOT_EXCLUDE_SEL = "flow-character-prompt-box, flow-edit-character-footer, flow-character-form, flow-slot-chip-button";

/** Performance text for a custom voice request that supplies only a sample. */
const DEFAULT_VOICE_PERFORMANCE = "Read naturally in the selected voice.";

/** Maximum wait for a save, with time left to attach and confirm the voice. */
const VOICE_SAVE_TIMEOUT_MS = 100_000;

/** Maximum wait for a character slot loading overlay to clear. */
const SLOT_OVERLAY_TIMEOUT_MS = 20_000;

/** Values for the custom voice editor and its save deadline. */
interface CustomVoiceInput {
  /** Sample text to read. */
  sample: string;
  /** Performance instructions for the selected voice. */
  performance: string;
  /** Name for the saved voice. */
  name: string;
  /** Latest time to wait for Flow to save the voice. */
  deadline: number;
}

/** Saved voice name or the stage that Flow cannot confirm. */
type CustomVoiceSaveResult =
  | { /** Name of the saved voice. */ name: string; /** Saved voice ID. */ id?: string }
  | { /** Error code. */ error: string; /** Active stage. */ stage?: "generate_voice_preview" | "save_custom_voice"; /** Detail text. */ detail?: string };

/** Calls a zero-argument signal or getter method safely on `target`. */
function callSignal(target: unknown, key: string): unknown {
  const fn = readOwn(target, key);
  if (typeof fn !== "function") return undefined;
  try { return fn.call(target); } catch { return undefined; }
}

/** Walks an Angular host view and live registry views to find a matching component. */
function findHostComponent(host: Element | null | undefined, matches: (candidate: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  if (!host) return null;
  const visited = new Set<unknown>();
  const scan = (lv: unknown, depth: number): Record<string, unknown> | null => {
    if (!Array.isArray(lv) || depth > 2 || visited.has(lv)) return null;
    visited.add(lv);
    for (const item of lv) {
      if (item && typeof item === "object" && !Array.isArray(item) && !(item instanceof Node) && !(item instanceof Map) && !(item instanceof Set) && matches(item as Record<string, unknown>)) return item as Record<string, unknown>;
      const nested = depth < 2 && Array.isArray(item) ? scan(item, depth + 1) : null;
      if (nested) return nested;
    }
    return null;
  };
  const direct = scan(resolveLView(host), 0);
  if (direct) return direct;
  for (const candidate of runtimeState.ngLViewMap?.values() ?? []) {
    const hit = isLiveLView(candidate) && candidate[0] === host ? scan(candidate, 0) : null;
    if (hit) return hit;
  }
  return null;
}

/** Probes `hosts` inside Angular LView map capture when their views are not yet bound. */
async function ensureAngularHostsBound(hosts: Array<Element | null | undefined>): Promise<void> {
  const live = hosts.filter((h): h is Element => Boolean(h));
  if (live.length === 0 || live.every((h) => Boolean(resolveLView(h)))) return;
  const targets = live.flatMap((h) => [h, ...Array.from(h.querySelectorAll("flow-character-voice-button, flow-add-menu-asset-item, [mattooltip], button")).slice(0, 6)]);
  await withLViewMapCapture(async () => {
    await hoverProbe(targets);
    for (const inp of live.flatMap((h) => Array.from(h.querySelectorAll("input, textarea")).slice(0, 4))) {
      inp.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
    }
  });
}

/** Returns the live `flow-character-form` Angular component instance, or null. */
function findCharacterFormComponent(): Record<string, unknown> | null {
  const fmt = characterVoiceFormat();
  return findHostComponent(document.querySelector("flow-character-form"), (cand) => {
    const lc = readOwn(cand as AngularLifecycleHandle, fmt.lifecycle);
    if (lc && typeof lc === "object" && readOwn(lc, fmt.destroyed)) return false;
    return typeof readOwn(cand, fmt.selectedVoice) === "function" || typeof readOwn(cand, fmt.voiceMap) === "function";
  });
}

/** Converts a raw Angular voice object into `VoiceMeta` with a canonical `id`, or null. */
function parseVoiceAsset(raw: unknown): (VoiceMeta & { id: string }) | null {
  if (!raw || typeof raw !== "object" || raw instanceof Node || Array.isArray(raw)) return null;
  const idVal = readOwn(raw, "id") ?? readOwn(raw, "voiceId");
  const titleVal = readOwn(raw, "title") ?? readOwn(raw, "name") ?? readOwn(raw, "displayName");
  const rawId = typeof idVal === "string" ? idVal.trim() : "";
  const rawName = typeof titleVal === "string" ? titleVal.trim() : "";
  if (!rawId && !rawName) return null;
  const mediaVal = readOwn(raw, "mediaId") ?? readOwn(raw, "primaryMediaId");
  const workflowVal = readOwn(raw, "workflowId");
  const mediaId = typeof mediaVal === "string" && mediaVal.trim() ? mediaVal.trim() : undefined;
  const workflowId = typeof workflowVal === "string" && workflowVal.trim() ? workflowVal.trim() : undefined;
  const descVal = readOwn(raw, "description");
  const description = typeof descVal === "string" && descVal.trim() ? descVal.trim() : null;
  const presetFlag = readOwn(raw, "Rv") === true || /^voices\//i.test(rawId);
  const customFlag = readOwn(raw, "custom") === true || readOwn(raw, "isCustom") === true || readOwn(raw, "B$") === true;
  const custom = customFlag || (!presetFlag && Boolean(workflowId || UUID_RE.test(rawId) || (mediaId && UUID_RE.test(mediaId))));
  const name = rawName || rawId.replace(/^voices\//i, "");
  const id = rawId ? (!custom && !/^voices\//i.test(rawId) ? `voices/${rawId}` : rawId) : (custom ? workflowId || mediaId || name : `voices/${name}`);
  return { id, name, description, custom, ...(mediaId ? { mediaId } : {}), ...(workflowId ? { workflowId } : {}) };
}

/** Reads the voice metadata bound directly to one `flow-add-menu-asset-item` host, or null. */
function readRowItemMeta(button: HTMLElement): (VoiceMeta & { id: string }) | null {
  const itemHost = button.querySelector("flow-add-menu-asset-item") ?? button;
  let found: (VoiceMeta & { id: string }) | null = null;
  const isVoiceObj = (v: unknown): boolean =>
    typeof readOwn(v, "title") === "string" || typeof readOwn(v, "mediaId") === "string" || typeof readOwn(v, "workflowId") === "string";
  findHostComponent(itemHost, (cand) => {
    const direct = parseVoiceAsset(cand);
    if (direct && isVoiceObj(cand)) { found = direct; return true; }
    for (const key of Object.keys(cand)) {
      const prop = readOwn(cand, key);
      const val = typeof prop === "function" && prop.length === 0 ? callSignal(cand, key) : prop;
      const parsed = parseVoiceAsset(val);
      if (parsed && isVoiceObj(val)) { found = parsed; return true; }
    }
    return false;
  });
  return found;
}

/** Pushes voice entries from a `Map`, array, query `.data()`, or single record into `sink`. */
function pushVoiceSource(source: unknown, sink: (item: unknown) => void): void {
  if (!source) return;
  if (source instanceof Map || Array.isArray(source)) { for (const v of source.values()) sink(v); return; }
  sink(source);
  if (typeof source === "object" && !(source instanceof Node)) {
    for (const key of Object.keys(source)) {
      const prop = readOwn(source, key);
      if (Array.isArray(prop)) for (const v of prop) sink(v);
    }
  }
}

/** Reads resolved `.data()` or `.state.data` from a query signal object on `comp`. */
function readQueryData(comp: Record<string, unknown>, key: string): unknown {
  const q = readOwn(comp, key);
  if (!q || typeof q !== "object") return undefined;
  return (typeof readOwn(q, "data") === "function" ? callSignal(q, "data") : readOwn(q, "data")) ?? readOwn(readOwn(q, "state"), "data");
}

/** Collects voice metadata from `flow-add-menu-popover-content` and `flow-character-form`. */
function readBoundVoiceCatalog(pane: Element | null): Array<VoiceMeta & { id: string }> {
  const out: Array<VoiceMeta & { id: string }> = [];
  const seen = new Set<string>();
  const push = (raw: unknown): void => {
    const parsed = parseVoiceAsset(raw);
    const key = parsed ? `${parsed.custom ? "1" : "0"}:${parsed.id.toLowerCase()}` : "";
    if (parsed && !seen.has(key)) { seen.add(key); out.push(parsed); }
  };
  const previewFmt = characterPreviewFormat();
  const confirmFmt = frontendBuild(readBuildLabel())?.voiceConfirmation;
  const pickerComp = findHostComponent(pane?.querySelector("flow-add-menu-popover-content"), (cand) =>
    typeof readOwn(cand, previewFmt.pickerAssets) === "function" ||
    Boolean(confirmFmt && typeof readOwn(cand, confirmFmt.pickerSelection) === "function"));
  if (pickerComp) {
    pushVoiceSource(callSignal(pickerComp, previewFmt.pickerAssets), push);
    if (confirmFmt) pushVoiceSource(callSignal(pickerComp, confirmFmt.pickerSelection), push);
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
function cleanVoiceLabel(el: Element | null): string {
  if (!el) return "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest("mat-icon, .favorite-icon, .custom-voice-badge, .cdk-visually-hidden")) {
      const text = node.textContent?.trim();
      if (text && !VOICE_ICON_WORDS.has(text)) parts.push(text);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Returns the open voice dialog pane, or null. */
export function voicePane(): Element | null {
  return Array.from(document.querySelectorAll(".cdk-overlay-pane, [role='dialog']")).find((p) => {
    if (p.querySelector("mat-tooltip-component, .mdc-tooltip, flow-media-picker-dialog")) return false;
    if (/select a voice/i.test(elText(p))) {
      return p.matches("[role='dialog']") || Boolean(p.querySelector(
        "[role='dialog'], button, [role='option'], [role='menuitem'], flow-voice-preview-pane, flow-add-menu-popover-content, flow-add-menu-asset-item, .asset-title, .voice-card-name",
      ));
    }
    return Boolean(p.querySelector("flow-voice-preview-pane, .voice-card-name") ||
      (!/add from project/i.test(elText(p)) && p.querySelector("flow-add-menu-asset-item")));
  }) || null;
}

/** Parses the voice rows that the dialog has rendered now. */
function renderedRows(pane: Element): VoiceRow[] {
  const catalog = readBoundVoiceCatalog(pane);
  const usedCatalog = new Set<VoiceMeta>();
  const rows: VoiceRow[] = [];
  for (const b of Array.from(pane.querySelectorAll<HTMLElement>("button"))) {
    const text = b.innerText || b.textContent || "";
    const titleEl = b.querySelector(".asset-title, .voice-card-name");
    const descEl = b.querySelector(".asset-description, .voice-card-description");
    if (!/voice_selection/.test(text) && !titleEl) continue;
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const words = lines.filter((l) => !l.split(/\s+/).every((w) => VOICE_ICON_WORDS.has(w)));
    const name = cleanVoiceLabel(titleEl) || words[0] || "";
    if (!name) continue;
    const domCustom = Boolean(b.querySelector(".custom-voice-badge")) || lines.includes("settings_2");
    const itemMeta = readRowItemMeta(b);
    const lowName = name.toLowerCase();
    const meta = itemMeta ??
      catalog.find((m) => !usedCatalog.has(m) && m.custom === domCustom && m.name.toLowerCase() === lowName) ??
      catalog.find((m) => !usedCatalog.has(m) && m.name.toLowerCase() === lowName);
    if (meta) usedCatalog.add(meta);
    const custom = itemMeta ? itemMeta.custom : domCustom || Boolean(meta?.custom);
    const description = (titleEl ? cleanVoiceLabel(descEl) || null : words.slice(1).join(" ") || null) ?? meta?.description ?? null;
    const id = meta?.id ?? (custom ? undefined : `voices/${name}`);
    rows.push({
      ...(id ? { id } : {}), name, description, custom,
      ...(meta?.mediaId ? { mediaId: meta.mediaId } : {}),
      ...(meta?.workflowId ? { workflowId: meta.workflowId } : {}),
      el: b,
    });
  }
  return rows;
}

/** Returns the scroll container of the voice list. */
function listScroller(pane: Element): HTMLElement | null {
  return Array.from(pane.querySelectorAll<HTMLElement>("*")).find((e) =>
    e.scrollHeight > e.clientHeight + 50 &&
    (/voice_selection/.test(e.innerText || "") || Boolean(e.querySelector("flow-add-menu-asset-item, .asset-title")))) || null;
}

/** Opens the voice dialog from the character voice button and binds Angular views. */
async function openDialog(): Promise<Element | null> {
  const openInner = async (): Promise<Element | null> => {
    const existing = voicePane();
    if (existing) return existing;
    const btn = document.querySelector<HTMLElement>("flow-character-voice-button button");
    if (!btn) return null;
    btn.click();
    for (let i = 0; i < 50; i++) {
      await delay(100);
      const pane = voicePane();
      if (pane && renderedRows(pane).length > 0) return pane;
    }
    return null;
  };
  const pane = runtimeState.ngLViewMap instanceof Map ? await openInner() : await withLViewMapCapture(openInner);
  if (pane) await ensureAngularHostsBound([document.querySelector("flow-character-form"), pane.querySelector("flow-add-menu-popover-content")]);
  return pane;
}

/** Scrolls the whole virtual list once and returns every voice row in list order. */
async function collectAllRows(pane: Element): Promise<VoiceRow[]> {
  await ensureAngularHostsBound([document.querySelector("flow-character-form"), pane.querySelector("flow-add-menu-popover-content")]);
  const sc = listScroller(pane);
  const byKey = new Map<string, VoiceRow>();
  const take = (): void => {
    for (const r of renderedRows(pane)) {
      const key = `${r.custom ? "custom" : "preset"}:${(r.id ?? r.name).toLowerCase()}`;
      if (!byKey.has(key)) byKey.set(key, r);
    }
  };
  if (sc) sc.scrollTop = 0;
  await delay(250);
  take();
  for (let i = 0; sc && i < 60; i++) {
    const before = sc.scrollTop;
    sc.scrollTop = before + Math.max(120, sc.clientHeight - 60);
    await delay(200);
    take();
    if (sc.scrollTop === before) break;
  }
  return Array.from(byKey.values());
}

/** Returns true when `el`, an ancestor, or a child voice item is already active in the picker. */
function isVoiceRowActive(el: HTMLElement): boolean {
  return el.classList.contains("asset-item-active") || el.getAttribute("aria-selected") === "true" ||
    Boolean(el.querySelector('.asset-item-active, [aria-selected="true"]')) ||
    Boolean(el.closest('.asset-item-active, [aria-selected="true"]'));
}

/** Returns true when `row` matches `query` by display name, `voices/<Name>`, `id`, `mediaId`, or `workflowId`. */
function voiceRowMatches(row: VoiceRow, query: string): boolean {
  const want = query.trim().toLowerCase();
  return Boolean(want) && (
    row.name.toLowerCase() === want || `voices/${row.name}`.toLowerCase() === want ||
    row.id?.toLowerCase() === want || row.mediaId?.toLowerCase() === want || row.workflowId?.toLowerCase() === want
  );
}

/** Scrolls until a matching voice row renders, selects it when inactive, and returns its metadata. */
async function selectRow(pane: Element, name: string): Promise<(VoiceMeta & { wasActive: boolean }) | null> {
  await ensureAngularHostsBound([document.querySelector("flow-character-form"), pane.querySelector("flow-add-menu-popover-content")]);
  const sc = listScroller(pane);
  if (sc) sc.scrollTop = 0;
  await delay(200);
  for (let i = 0; i < 60; i++) {
    const row = renderedRows(pane).find((r) => voiceRowMatches(r, name));
    if (row) {
      row.el.scrollIntoView({ block: "center" });
      const wasActive = isVoiceRowActive(row.el);
      if (wasActive) await delay(150);
      else { row.el.click(); await delay(700); }
      const { el: _el, ...meta } = row;
      return { ...meta, wasActive };
    }
    if (!sc) break;
    const before = sc.scrollTop;
    sc.scrollTop = before + Math.max(120, sc.clientHeight - 60);
    await delay(200);
    if (sc.scrollTop === before) break;
  }
  return null;
}

/** Returns the dialog field that matches `test` on its placeholder. */
function field(pane: Element, test: RegExp): HTMLInputElement | HTMLTextAreaElement | null {
  return Array.from(pane.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input"))
    .find((f) => test.test(f.getAttribute("placeholder") || "")) || null;
}

/** Returns the visible dialog button whose text or `aria-label` matches `re`. */
function paneButton(pane: Element, re: RegExp): HTMLElement | null {
  return Array.from(pane.querySelectorAll<HTMLElement>("button")).find((b) =>
    isVisibleEnabled(b) && !/voice_selection/.test(b.innerText || "") &&
    !b.querySelector("flow-add-menu-asset-item, .asset-title, .voice-card-name") &&
    re.test(`${b.getAttribute("aria-label") || ""} ${elText(b)}`)) || null;
}

/** Saves the custom voice and waits for Flow to show its saved entry. */
async function saveCustomVoice(
  pane: Element,
  { sample, performance, name, deadline }: CustomVoiceInput,
  format?: VoiceConfirmationFormat,
): Promise<CustomVoiceSaveResult> {
  const sampleEl = field(pane, /hi there/i);
  const perfEl = field(pane, /performance style/i);
  if (!sampleEl || !perfEl) return { error: "voice_custom_fields_not_found" };
  if (sample) setNativeValue(sampleEl, sample);
  setNativeValue(perfEl, performance || DEFAULT_VOICE_PERFORMANCE);

  // Flow shows the name field after the performance text changes.
  let nameEl: HTMLInputElement | HTMLTextAreaElement | null = null;
  for (let i = 0; i < 30 && !nameEl; i++) {
    nameEl = field(voicePane() ?? pane, /voice name/i);
    if (!nameEl) await delay(100);
  }
  if (!nameEl) return { error: "voice_name_field_not_found" };
  if (name) setNativeValue(nameEl, name);
  const savedName = nameEl.value.trim();
  if (!savedName) return { error: "voice_name_required" };

  let save: HTMLElement | null = null;
  for (let i = 0; i < 30 && !save; i++) {
    save = paneButton(voicePane() ?? pane, /save new voice/i);
    if (!save) await delay(100);
  }
  if (!save) return { error: "save_new_voice_button_not_found" };
  const saveError = /failed to save voice|preview generation failed|failed to load audio preview/i;
  const priorError = findSnackbarMatch(saveError);
  const oldRows = new Set(renderedRows(voicePane() ?? pane).filter((row) => row.custom && row.name === savedName).map((row) => row.el));
  const receipt = format && bindCustomVoiceReceipt(voicePane() ?? pane, format);
  try {
    save.click();
    // Flow can keep Add to character active for the base voice during the save.
    while (globalThis.performance.now() < deadline) {
      await delay(500);
      const error = findSnackbarMatch(saveError);
      if (error && (error.bar !== priorError?.bar || error.text !== priorError.text)) {
        const detail = error.text.match(saveError)?.[0];
        return /^failed to save voice$/i.test(detail ?? "")
          ? { error: "outcome_unknown", stage: "save_custom_voice", detail }
          : { error: "custom_voice_preview_failed", stage: "generate_voice_preview", detail };
      }
      const current = voicePane();
      if (!current) {
        return { error: "outcome_unknown", stage: "save_custom_voice", detail: "Flow closes the voice dialog before it confirms the save" };
      }
      if (receipt) {
        const id = receipt.selected();
        if (id) return { name: savedName, id };
      } else {
        const saved = renderedRows(current).find((row) => row.custom && row.name === savedName && !oldRows.has(row.el));
        const saving = /\bsaving\b/i.test(elText(current.querySelector("button.voice-save-button")));
        if (saved && !saving) {
          if (!isVoiceRowActive(saved.el)) saved.el.click();
          return { name: savedName, ...(saved.id ? { id: saved.id } : {}) };
        }
      }
    }
  } finally {
    receipt?.close();
  }
  return { error: "outcome_unknown", stage: "save_custom_voice", detail: "Flow does not confirm the custom voice before the time limit" };
}

/** Returns the text of the character voice button. */
function voiceButtonText(): string {
  const button = document.querySelector("flow-character-voice-button");
  const name = cleanVoiceLabel(button?.querySelector(".voice-card-name, .asset-title") ?? null);
  return (name || cleanVoiceLabel(button) || elText(button)).replace(/\s+/g, " ").trim();
}

/** Selects a base voice, optionally saves a custom voice with sample dialogue and performance text, and adds it to the character. */
async function applyVoice(req: CharacterExtraOpRequest): Promise<Record<string, unknown>> {
  const deadline = globalThis.performance.now() + VOICE_SAVE_TIMEOUT_MS;
  const base = String(req.voice || "").trim();
  const sample = String(req.sample || "").trim();
  const performance = String(req.performance || "").trim();
  const name = String(req.voice_name || "").trim();
  const custom = Boolean(sample || performance);
  if (custom && sample.length > 120) return { ok: false, error: "voice_sample_over_120_characters" };
  const format = frontendBuild(readBuildLabel())?.voiceConfirmation;
  let pane = format ? await withLViewMapCapture(openDialog) : await openDialog();
  if (!pane) return { ok: false, error: "voice_dialog_not_available" };
  const confirm = format && bindVoiceConfirmation(format);
  if (format && !confirm) {
    await dismissOverlay();
    return { ok: false, error: "voice_confirmation_unavailable" };
  }
  let selected: VoiceMeta | null = null;
  if (base) {
    selected = await selectRow(pane, base);
    if (!selected) {
      const available = (await collectAllRows(pane)).map((r) => r.name);
      await dismissOverlay();
      return { ok: false, error: `voice_not_found:${base}`, available_voices: available };
    }
  }
  let expected = selected?.name ?? base;
  let expectedId = selected?.id;
  if (custom) {
    const result = await saveCustomVoice(voicePane() ?? pane, { sample, performance, name, deadline }, format);
    if ("error" in result) {
      await dismissOverlay();
      return { ok: false, ...result };
    }
    expected = result.name;
    expectedId = result.id;
    await delay(250);
  }
  pane = voicePane() ?? pane;
  const add = paneButton(pane, /add to character/i);
  if (add) add.click();
  else clickButtonByRegex(/^(?:add to character|done|apply|select)$/i, pane);
  await delay(1500);
  if (voicePane()) await dismissOverlay();
  const shown = voiceButtonText();
  const expect = expected.toLowerCase();
  if (expect && !shown.toLowerCase().includes(expect)) return { ok: false, error: "voice_not_applied", shown };
  if (confirm && !(await confirm(expectedId))) return { ok: false, error: "outcome_unknown", stage: "set_character_voice" };
  return { ok: true, applied: [custom ? "custom_voice" : "voice"], shown };
}

/** Fetches `src` and returns it as a base64 audio result. */
async function audioResult(src: string): Promise<Record<string, unknown>> {
  for (const a of Array.from(document.querySelectorAll("audio"))) a.pause();
  const res = await fetch(src);
  if (!res.ok) return { ok: false, error: `voice_preview_fetch_failed:${res.status}` };
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { ok: true, mime: res.headers.get("content-type") || "audio/wav", data: btoa(bin), voice: voiceButtonText() };
}

/** Returns true when `url` is a synthetic `/voices/samples/<uuid>.wav` fallback URL. */
function isBogusVoiceSampleUrl(url: string, isCustomVoice = false): boolean {
  return BOGUS_SAMPLE_UUID_RE.test(url) || (isCustomVoice && /\/voices\/samples\/[^/?#]+\.wav(?:[?#]|$)/i.test(url));
}

/** Returns every valid audio URL that the page has played or loaded. */
function knownAudioUrls(isCustomVoice = false): string[] {
  const fromEls = Array.from(document.querySelectorAll("audio")).map((a) => a.currentSrc || a.src);
  const fromNet = performance.getEntriesByType("resource").map((e) => e.name).filter((u) => /flow-content\.google\/audio\//.test(u));
  return [...fromEls, ...fromNet].filter((s) => /^(?:https?:|blob:)/.test(s) && !isBogusVoiceSampleUrl(s, isCustomVoice));
}

/** Returns true when a TanStack Query object on `flow-character-form` is still loading initial data. */
function isVoiceQueryLoading(query: unknown): boolean {
  if (!query || typeof query !== "object") return false;
  for (const key of ["isLoading", "isPending"]) {
    if (Boolean(typeof readOwn(query, key) === "function" ? callSignal(query, key) : readOwn(query, key))) return true;
  }
  const hasData = typeof readOwn(query, "data") === "function" ? callSignal(query, "data") != null : true;
  const fetching = typeof readOwn(query, "isFetching") === "function" ? Boolean(callSignal(query, "isFetching")) : readOwn(query, "isFetching") === true;
  return !hasData && fetching;
}

/** Returns true while `w4.ma`, `w4.na`, or `flow-character-form` busy state is loading. */
function isFormVoiceAudioLoading(formComp: Record<string, unknown> | null): boolean {
  return Boolean(formComp) && (
    isVoiceQueryLoading(readOwn(formComp, "ma")) ||
    isVoiceQueryLoading(readOwn(formComp, "na")) ||
    Boolean(callSignal(formComp, characterVoiceFormat().busy))
  );
}

/** Reads the custom voice `mediaId` (or UUID) of the selected voice on `flow-character-form`. */
function readFormCustomVoiceMediaId(formComp: Record<string, unknown> | null): { isCustom: boolean; mediaId: string | null } {
  if (!formComp) return { isCustom: false, mediaId: null };
  const fmt = characterVoiceFormat();
  const rawSel = callSignal(formComp, fmt.selectedVoice);
  const selectedId = typeof rawSel === "string" ? rawSel.trim() : "";
  const lowSel = selectedId.toLowerCase();
  const candidates: Array<VoiceMeta & { id: string }> = [];
  const push = (raw: unknown): void => { const p = parseVoiceAsset(raw); if (p) candidates.push(p); };
  push(callSignal(formComp, fmt.selectedRecord));
  push(callSignal(formComp, "ha"));
  pushVoiceSource(callSignal(formComp, fmt.voiceMap), push);
  pushVoiceSource(readQueryData(formComp, "ma"), push);
  pushVoiceSource(readQueryData(formComp, "na"), push);
  const matchesSelected = (m: VoiceMeta & { id: string }): boolean =>
    !lowSel || m.id.toLowerCase() === lowSel || m.workflowId?.toLowerCase() === lowSel ||
    m.mediaId?.toLowerCase() === lowSel || `voices/${m.name}`.toLowerCase() === lowSel;
  const hit = candidates.find((m) => matchesSelected(m) && Boolean(m.mediaId)) ??
    candidates.find(matchesSelected) ?? (!lowSel ? candidates[0] : undefined);
  if (hit) {
    return { isCustom: hit.custom, mediaId: hit.custom ? hit.mediaId || (UUID_RE.test(hit.id) ? hit.id : null) : null };
  }
  return selectedId && UUID_RE.test(selectedId) ? { isCustom: true, mediaId: selectedId } : { isCustom: false, mediaId: null };
}

/** Resolves a custom voice audio URL through `resolveVideoUrl` when `mediaId` is available. */
async function resolveCustomAudioUrl(mediaId: string | null | undefined): Promise<string> {
  const clean = typeof mediaId === "string" ? mediaId.trim() : "";
  if (!clean || /^voices\//i.test(clean)) return "";
  const resolved = await resolveVideoUrl(clean);
  return resolved?.ok === true ? String(resolved.url || resolved.download_url || "").trim() : "";
}

/** Plays the character voice preview and returns the audio as base64. */
async function previewVoice(): Promise<Record<string, unknown>> {
  const findPlay = (): HTMLElement | null =>
    document.querySelector("flow-character-voice-button")?.querySelector<HTMLElement>('button[aria-label="Play preview"]') ?? null;
  let play: HTMLElement | null = null;
  for (let i = 0; i < 40 && !play; i++) {
    play = findPlay();
    if (!play) await delay(500);
  }
  if (!play) return { ok: false, error: "voice_preview_button_not_found" };
  await ensureAngularHostsBound([document.querySelector("flow-character-form")]);
  let formComp = findCharacterFormComponent();
  for (let i = 0; i < 40 && isFormVoiceAudioLoading(formComp); i++) {
    await delay(200);
    formComp = findCharacterFormComponent() ?? formComp;
    if (!isFormVoiceAudioLoading(formComp)) { await delay(100); formComp = findCharacterFormComponent() ?? formComp; }
  }
  const beforePlay = new Set(knownAudioUrls(true));
  play = findPlay() ?? play;
  play.click();
  let src = "";
  let triedResolve = false;
  for (let i = 0; i < 120 && !src; i++) {
    await delay(500);
    formComp = findCharacterFormComponent() ?? formComp;
    const loading = isFormVoiceAudioLoading(formComp);
    const { isCustom, mediaId } = readFormCustomVoiceMediaId(formComp);
    const rawUrls = Array.from(document.querySelectorAll("audio")).map((a) => a.currentSrc || a.src);
    src = rawUrls.find((s) => /^(?:https?:|blob:)/.test(s) && !isBogusVoiceSampleUrl(s, isCustom)) ||
      knownAudioUrls(isCustom).find((u) => !beforePlay.has(u)) || "";
    if (src || loading) continue;
    const bogusUuid = rawUrls.map((s) => BOGUS_SAMPLE_UUID_RE.exec(s)?.[1] ?? "").find(Boolean);
    const ids = [mediaId, bogusUuid].filter((v, idx, arr): v is string => Boolean(v) && arr.indexOf(v) === idx);
    if (!triedResolve && ids.length > 0 && (i >= 1 || Boolean(bogusUuid))) {
      triedResolve = true;
      for (const id of ids) { src = await resolveCustomAudioUrl(id); if (src) break; }
    }
  }
  return src ? audioResult(src) : { ok: false, error: "voice_preview_audio_not_found" };
}

/** Reads `<audio src>` inside `flow-voice-preview-pane`, skipping bogus UUID sample paths. */
function previewPaneAudioSrc(pane: Element, isCustomVoice: boolean): string {
  const root = pane.querySelector("flow-voice-preview-pane") ?? pane;
  for (const audio of Array.from(root.querySelectorAll<HTMLAudioElement>("audio"))) {
    const candidate = (audio.currentSrc || audio.src || "").trim();
    if (/^(?:https?:|blob:)/.test(candidate) && !isBogusVoiceSampleUrl(candidate, isCustomVoice)) return candidate;
  }
  return "";
}

/** Generates a preview of a base voice with sample and performance text in the voice dialog, without saving a voice. */
async function auditionVoice(req: CharacterExtraOpRequest): Promise<Record<string, unknown>> {
  const base = String(req.voice || "").trim();
  const sample = String(req.sample || "").trim();
  const performance = String(req.performance || "").trim();
  if (!base) return { ok: false, error: "audition_needs_voice" };
  if (sample.length > 120) return { ok: false, error: "voice_sample_over_120_characters" };
  const beforeOpen = new Set(knownAudioUrls());
  let openedPane = await openDialog();
  if (!openedPane) return { ok: false, error: "voice_dialog_not_available" };
  let paneSrcBeforeSelect = previewPaneAudioSrc(openedPane, false);
  let before = new Set(knownAudioUrls());
  let selected = await selectRow(openedPane, base);
  if (selected && !selected.wasActive && !voicePane()) {
    openedPane = await openDialog();
    const other = openedPane && renderedRows(openedPane).find((r) => !voiceRowMatches(r, base));
    if (!openedPane || (other && !(await selectRow(openedPane, other.name)))) {
      await dismissOverlay();
      return { ok: false, error: "voice_dialog_not_available" };
    }
    paneSrcBeforeSelect = previewPaneAudioSrc(openedPane, false);
    before = new Set(knownAudioUrls());
    selected = await selectRow(openedPane, base);
  }
  if (!selected || !openedPane) {
    await dismissOverlay();
    return { ok: false, error: `voice_not_found:${base}` };
  }
  const pane = openedPane;
  const activeVoice = selected;
  const sampleSuffix = `/samples/${activeVoice.name.toLowerCase()}.wav`;
  const matchPreloaded = (): string =>
    activeVoice.custom ? "" : knownAudioUrls(false).find((u) => u.toLowerCase().includes(sampleSuffix)) || "";
  const pollAuditionSrc = (requireNew: boolean): string => {
    const paneSrc = previewPaneAudioSrc(voicePane() ?? pane, activeVoice.custom);
    const allowPane = requireNew ? !before.has(paneSrc) : (activeVoice.wasActive || paneSrc !== paneSrcBeforeSelect);
    const direct = paneSrc && allowPane ? paneSrc : "";
    const baseline = !requireNew && activeVoice.wasActive ? beforeOpen : before;
    return direct || knownAudioUrls(activeVoice.custom).find((u) => !baseline.has(u)) || "";
  };
  let src = "";
  if (!sample && !performance) {
    for (let i = 0; i < 20 && !src; i++) {
      src = pollAuditionSrc(false) || (i >= 4 ? matchPreloaded() : "");
      if (!src) await delay(150);
    }
    if (!src && activeVoice.custom) src = await resolveCustomAudioUrl(activeVoice.mediaId ?? activeVoice.id);
    if (!src) {
      const play = paneButton(voicePane() ?? pane, /preview/i);
      if (play) {
        play.click();
        for (let i = 0; i < 40 && !src; i++) { await delay(250); src = pollAuditionSrc(false) || matchPreloaded(); }
      } else src = matchPreloaded();
    }
  } else {
    const livePane = voicePane() ?? pane;
    const sampleEl = field(livePane, /hi there/i);
    const perfEl = field(livePane, /performance style/i);
    if (sample && sampleEl) setNativeValue(sampleEl, sample);
    if (performance && perfEl) setNativeValue(perfEl, performance);
    await delay(400);
    before = new Set(knownAudioUrls(activeVoice.custom));
    const initialPaneSrc = previewPaneAudioSrc(voicePane() ?? livePane, activeVoice.custom);
    if (initialPaneSrc) before.add(initialPaneSrc);
    const play = paneButton(voicePane() ?? livePane, /preview/i);
    if (!play) { await dismissOverlay(); return { ok: false, error: "voice_preview_button_not_found" }; }
    play.click();
    for (let i = 0; i < 180 && !src; i++) { await delay(500); src = pollAuditionSrc(true); }
  }
  let result: Record<string, unknown>;
  try {
    result = src ? await audioResult(src) : { ok: false, error: "voice_audition_audio_not_found" };
  } catch (e) {
    result = { ok: false, error: `voice_audition_fetch_failed:${String(e)}` };
  }
  await dismissOverlay();
  return { ...result, voice: activeVoice.name };
}

/** Returns the character preview panel root outside `flow-character-prompt-box`, or null. */
function previewPanelRoot(): Element | null {
  const panel = document.querySelector("flow-character-preview-panel");
  if (panel && !panel.closest("flow-character-prompt-box")) return panel;
  const preview = document.querySelector("flow-character-image-preview");
  return preview && !preview.closest("flow-character-prompt-box") ? preview : null;
}

/** Returns the `flow-character-image-preview` element inside `previewPanelRoot`, or null. */
function slotPreviewElement(): Element | null {
  const root = previewPanelRoot();
  return !root ? null : (root.matches("flow-character-image-preview") ? root : root.querySelector("flow-character-image-preview"));
}

/** Finds the visible `portrait` or `body` chip button inside `flow-character-preview-panel`. */
function findSlotChipButton(slot: CharacterImageSlot): HTMLButtonElement | null {
  const label = slot === "portrait" ? /\bportrait\b/i : /\bbody\b/i;
  return Array.from(document.querySelectorAll<HTMLButtonElement>("flow-character-preview-panel flow-slot-chip-button button"))
    .find((btn) => !btn.closest("flow-character-prompt-box, flow-character-form") && btn.getClientRects().length > 0 && label.test(elText(btn))) || null;
}

/** Returns true while `flow-soupy-overlay` or `.image-area[aria-busy="true"]` covers `root`. */
function hasSlotLoadingOverlay(root: Element): boolean {
  const scope = previewPanelRoot() ?? root;
  for (const ov of Array.from(scope.querySelectorAll("flow-soupy-overlay"))) {
    if (ov.closest("flow-character-prompt-box")) continue;
    if (!(ov instanceof HTMLElement)) return true;
    const style = getComputedStyle(ov);
    if (!ov.hasAttribute("hidden") && style.display !== "none" && style.visibility !== "hidden") return true;
  }
  return Boolean(scope.querySelector('.image-area[aria-busy="true"]'));
}

/** Dispatches hover events on `.image-frame` so Flow mounts `.top-actions` controls. */
async function hoverSlotImageFrame(preview: Element): Promise<void> {
  const frame = preview.querySelector(".image-frame");
  if (!frame || frame.closest("flow-character-prompt-box")) return;
  const rect = frame.getBoundingClientRect();
  const init = { bubbles: false, clientX: rect.left + Math.max(2, rect.width / 2), clientY: rect.top + Math.max(2, rect.height / 2) };
  frame.dispatchEvent(new PointerEvent("pointerenter", init));
  frame.dispatchEvent(new MouseEvent("mouseenter", init));
  await delay(100);
}

/** Runs `fn` inside Angular LView map capture when the registry map is not yet bound. */
async function clickWithLViewCapture(fn: () => void, waitMs = 150): Promise<void> {
  if (runtimeState.ngLViewMap instanceof Map) { fn(); return; }
  await withLViewMapCapture(async () => { fn(); await delay(waitMs); });
}

/** Returns true when `el` is explicitly disabled via HTML `disabled`, `aria-disabled`, or Material classes. */
function isButtonDisabled(el: HTMLElement): boolean {
  return (el instanceof HTMLButtonElement && el.disabled) || el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true" ||
    el.classList.contains("mat-mdc-button-disabled") || el.classList.contains("mdc-button--disabled");
}

/** Returns true when the requested preview slot holds media rather than an empty add state. */
function isSelectedSlotOccupied(slot: CharacterImageSlot, preview: Element): boolean {
  const chipBtn = findSlotChipButton(slot);
  if (chipBtn) {
    if (chipBtn.closest("flow-slot-chip-button")?.querySelector("img[src]")) return true;
    if (!chipBtn.classList.contains("chip-button-active") || /\bcreate\b/i.test(`${elText(chipBtn)} ${chipBtn.getAttribute("aria-label") || ""}`)) return false;
  }
  return Boolean(preview.querySelector("img.preview-image[src]")?.getAttribute("src")?.trim() || preview.querySelector('button[aria-label="Delete image"]'));
}

/** Returns true when `slot` has rendered either empty-slot controls or occupied-slot media. */
function isSlotControlsSettled(slot: CharacterImageSlot, preview: Element): boolean {
  const chipBtn = findSlotChipButton(slot);
  if (isSelectedSlotOccupied(slot, preview) || (chipBtn && /\bcreate\b/i.test(`${elText(chipBtn)} ${chipBtn.getAttribute("aria-label") || ""}`))) return true;
  const scope = previewPanelRoot() ?? preview;
  return /\b(?:add from project|add to character|upload)\b/i.test(elText(preview)) ||
    Array.from(scope.querySelectorAll("flow-add-menu, button, flow-button")).some((el) =>
      !el.closest(SLOT_EXCLUDE_SEL) && (el.tagName === "FLOW-ADD-MENU" || /\b(?:add from project|add to character|upload)\b/i.test(`${el.getAttribute("aria-label") || ""} ${elText(el)}`)));
}

/** Selects `slot` (`portrait` or `body`) and waits until `flow-soupy-overlay` clears. */
export async function waitForCharacterSlot(slot: CharacterImageSlot = "portrait"): Promise<boolean> {
  const deadline = globalThis.performance.now() + SLOT_OVERLAY_TIMEOUT_MS;
  while (globalThis.performance.now() < deadline) {
    const preview = slotPreviewElement();
    if (!previewPanelRoot() || !preview) { await delay(100); continue; }
    const chipBtn = findSlotChipButton(slot);
    if (chipBtn) {
      if (!chipBtn.classList.contains("chip-button-active")) {
        if (!isVisibleEnabled(chipBtn)) { await delay(100); continue; }
        await clickWithLViewCapture(() => chipBtn.click(), 150);
        await delay(150);
        continue;
      }
    } else if (slot === "body") return false;
    if (!hasSlotLoadingOverlay(preview) && isSlotControlsSettled(slot, preview)) {
      await hoverSlotImageFrame(preview);
      return true;
    }
    await delay(100);
  }
  return false;
}

/** Selects `slot`, waits for `flow-soupy-overlay` to clear, and deletes its image when replaceable. */
export async function clearCharacterSlot(slot: CharacterImageSlot = "portrait"): Promise<CharacterSlotClearResult> {
  const ready = await waitForCharacterSlot(slot);
  const preview = slotPreviewElement();
  if (!preview) return { ok: false, error: `character_${slot}_slot_unavailable` };
  if (!ready && hasSlotLoadingOverlay(preview)) return { ok: false, error: "character_slot_overlay_timeout" };
  await hoverSlotImageFrame(preview);
  const del = Array.from(preview.querySelectorAll<HTMLElement>('button[aria-label="Delete image"]'))
    .find((btn) => !btn.closest("flow-character-prompt-box, flow-character-form"));
  const occupied = isSelectedSlotOccupied(slot, preview);
  if (!del) return occupied ? { ok: false, error: "character_slot_occupied" } : { ok: true, deleted: false, empty: true };
  if (isButtonDisabled(del)) return { ok: false, error: "character_slot_occupied" };
  del.click();
  for (let i = 0; i < 30; i++) {
    await delay(100);
    const confirmBtn = Array.from(document.querySelectorAll<HTMLElement>(".cdk-overlay-pane button, [role='dialog'] button"))
      .find((b) => isVisibleEnabled(b) && /^delete$/i.test(elText(b).trim()));
    if (confirmBtn) { confirmBtn.click(); break; }
  }
  for (let i = 0; i < 60; i++) {
    await delay(100);
    const currentPreview = slotPreviewElement();
    if (!currentPreview || hasSlotLoadingOverlay(currentPreview)) continue;
    const chipBtn = findSlotChipButton(slot);
    if (slot === "body" && !chipBtn) return { ok: true, deleted: true };
    if (chipBtn && !chipBtn.classList.contains("chip-button-active")) {
      if (/\bcreate\b/i.test(`${elText(chipBtn)} ${chipBtn.getAttribute("aria-label") || ""}`) || !chipBtn.closest("flow-slot-chip-button")?.querySelector("img[src]")) return { ok: true, deleted: true };
      if (isVisibleEnabled(chipBtn)) chipBtn.click();
      continue;
    }
    if (/add from project/i.test(elText(currentPreview)) || !isSelectedSlotOccupied(slot, currentPreview)) return { ok: true, deleted: true };
  }
  return { ok: false, error: "portrait_delete_not_confirmed" };
}

/** Clicks a visible enabled button matching `re` inside `root` while excluding `flow-character-prompt-box`. */
function clickScopedSlotButton(re: RegExp, root: ParentNode): boolean {
  const hit = Array.from(root.querySelectorAll<HTMLElement>('button, flow-button, [role="button"], [role="menuitem"]'))
    .find((el) => !el.closest(SLOT_EXCLUDE_SEL) && isVisibleEnabled(el) && re.test(`${el.getAttribute("aria-label") || ""} ${elText(el)}`.trim()));
  if (!hit) return false;
  const inner = hit.tagName === "FLOW-BUTTON" ? hit.querySelector("button") : null;
  (inner instanceof HTMLElement ? inner : hit).click();
  return true;
}

/** Opens the "Add from project" picker for the currently selected slot inside `flow-character-preview-panel`. */
export async function openSlotProjectPicker(slot: CharacterImageSlot): Promise<SlotPickerOpenResult> {
  await waitForCharacterSlot(slot);
  const root = previewPanelRoot();
  const preview = slotPreviewElement();
  if (!root || !preview) return { ok: false, error: "add_to_character_button_not_found" };
  let clickedDirect = false;
  await clickWithLViewCapture(() => { clickedDirect = clickScopedSlotButton(/\badd from project\b/i, root); }, 250);
  if (clickedDirect) return { ok: true };

  let openedMenu = false;
  await clickWithLViewCapture(() => {
    if (clickScopedSlotButton(/\badd to character\b/i, root)) { openedMenu = true; return; }
    const menuBtn = Array.from(root.querySelectorAll<HTMLElement>("flow-add-menu button")).find((btn) => !btn.closest(SLOT_EXCLUDE_SEL) && isVisibleEnabled(btn));
    if (menuBtn) { menuBtn.click(); openedMenu = true; }
  }, 250);
  if (!openedMenu) return { ok: false, error: isSelectedSlotOccupied(slot, preview) ? "character_slot_occupied" : "add_to_character_button_not_found" };
  await delay(220);
  const menuClicked = Array.from(document.querySelectorAll(".cdk-overlay-pane, [role='menu'], [role='dialog']")).some((pane) => clickScopedSlotButton(/\badd from project\b/i, pane)) || clickScopedSlotButton(/\badd from project\b/i, root);
  if (!menuClicked) { await dismissOverlay(); return { ok: false, error: "add_from_project_menu_not_found" }; }
  return { ok: true };
}

/** Deletes the portrait image of the open character and waits until the slot is empty. */
async function deletePortrait(): Promise<Record<string, unknown>> {
  return clearCharacterSlot("portrait");
}

/** Runs one character editor action that `characterVoiceOp` and `characterMediaOp` do not cover. */
export async function characterExtraOp(req: CharacterExtraOpRequest): Promise<unknown> {
  const action = String(req?.action || "").toLowerCase();
  if (action === "apply_voice") return applyVoice(req);
  if (action === "preview_voice") return previewVoice();
  if (action === "audition_voice") return auditionVoice(req);
  if (action === "delete_portrait") return deletePortrait();
  if (action === "list_all_voices") {
    const pane = await openDialog();
    if (!pane) return { ok: false, error: "voice_dialog_not_available" };
    const rows = await collectAllRows(pane);
    await dismissOverlay();
    return {
      ok: true,
      voices: rows.map((r) => ({
        id: r.id ?? (r.custom ? r.name : `voices/${r.name}`),
        name: r.name,
        description: r.description,
        custom: r.custom,
      })),
    };
  }
  return { ok: false, error: `unknown_character_extra_op:${action}` };
}
