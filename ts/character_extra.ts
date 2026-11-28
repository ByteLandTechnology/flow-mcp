// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Custom voices, full voice lists, voice previews, and portrait removal on the open character editor page.

import { withLViewMapCapture } from "./angular";
import { clearCharacterSlot } from "./character_slots";
import {
  cleanVoiceLabel,
  currentCharacterFormVoiceId,
  ensureAngularHostsBound,
  extractBogusSampleUuid,
  findCharacterFormComponent,
  isBogusVoiceSampleUrl,
  isFormVoiceAudioLoading,
  readBoundVoiceCatalog,
  readFormCustomVoiceMediaId,
  readRowItemMeta,
  resolveCustomAudioUrl,
  type VoiceMeta,
} from "./character_voice_catalog";
import {
  clickButtonByRegex,
  delay,
  dismissOverlay,
  elText,
  findSnackbarMatch,
  isVisibleEnabled,
  setNativeValue,
} from "./dom";
import { frontendBuild, readBuildLabel, type VoiceConfirmationFormat } from "./frontend_builds";
import { runtimeState } from "./state";
import type { CharacterExtraOpRequest } from "./types";
import { bindCustomVoiceReceipt, bindVoiceConfirmation } from "./voice_confirmation";

/** One voice row in the "Select a voice" dialog. */
interface VoiceRow extends VoiceMeta {
  /** Row button element. */
  el: HTMLElement;
}

/** Options for `selectRow` when a caller opens a voice preview pane. */
interface SelectRowOptions {
  /** Select a sibling row first if the matched row is already active. */
  reopenIfActive?: boolean;
  /** Hook called right before clicking the matched target row. */
  onBeforeTargetClick?: () => void;
}

/** Icon ligature words that the dialog renders as text inside voice rows. */
export const VOICE_ICON_WORDS: ReadonlySet<string> = new Set([
  "voice_selection",
  "settings_2",
  "play_arrow",
  "favorite",
  "Favorited",
]);

/** Performance text for a custom voice request that supplies only a sample. */
const DEFAULT_VOICE_PERFORMANCE = "Read naturally in the selected voice.";

/** Maximum wait for a save, with time left to attach and confirm the voice. */
const VOICE_SAVE_TIMEOUT_MS = 100_000;

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
type CustomVoiceSaveResult = {
  /** Name of the saved voice. */
  name: string;
  /** ID of the saved voice that the picker selects. */
  id?: string;
} | {
  /** Tool error code. */
  error: string;
  /** Voice operation in progress when the error occurs. */
  stage?: "generate_voice_preview" | "save_custom_voice";
  /** Message from the voice dialog. */
  detail?: string;
};

/** Returns the open voice dialog pane, or null. */
export function voicePane(): Element | null {
  return (
    Array.from(
      document.querySelectorAll(".cdk-overlay-pane, [role='dialog']"),
    ).find((p) => {
      if (
        p.querySelector(
          "mat-tooltip-component, .mdc-tooltip, flow-media-picker-dialog",
        )
      ) {
        return false;
      }
      if (/select a voice/i.test(elText(p))) {
        return (
          p.matches("[role='dialog']") ||
          Boolean(
            p.querySelector(
              "[role='dialog'], button, [role='option'], [role='menuitem'], flow-voice-preview-pane, flow-add-menu-popover-content, flow-add-menu-asset-item, .asset-title, .voice-card-name",
            ),
          )
        );
      }
      return Boolean(
        p.querySelector("flow-voice-preview-pane, .voice-card-name") ||
          (!/add from project/i.test(elText(p)) &&
            p.querySelector("flow-add-menu-asset-item")),
      );
    }) || null
  );
}

/** Parses the voice rows that the dialog has rendered now. */
function renderedRows(pane: Element): VoiceRow[] {
  const catalog = readBoundVoiceCatalog(pane);
  const usedCatalog = new Set<VoiceMeta>();
  const rows: VoiceRow[] = [];
  for (const b of Array.from(pane.querySelectorAll("button"))) {
    const text = b.innerText || b.textContent || "";
    const titleEl = b.querySelector(".asset-title, .voice-card-name");
    const descEl = b.querySelector(".asset-description, .voice-card-description");
    if (!/voice_selection/.test(text) && !titleEl) continue;
    const lines = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const words = lines.filter(
      (l) => !l.split(/\s+/).every((w) => VOICE_ICON_WORDS.has(w)),
    );
    const name = cleanVoiceLabel(titleEl, VOICE_ICON_WORDS) || words[0] || "";
    if (!name) continue;
    const domCustom =
      Boolean(b.querySelector(".custom-voice-badge")) ||
      lines.includes("settings_2");
    const itemMeta = readRowItemMeta(b);
    const lowName = name.toLowerCase();
    const meta =
      itemMeta ??
      catalog.find(
        (m) =>
          !usedCatalog.has(m) &&
          m.custom === domCustom &&
          m.name.toLowerCase() === lowName,
      ) ??
      catalog.find((m) => !usedCatalog.has(m) && m.name.toLowerCase() === lowName);
    if (meta) usedCatalog.add(meta);
    const custom = itemMeta ? itemMeta.custom : domCustom || Boolean(meta?.custom);
    const description =
      (titleEl
        ? cleanVoiceLabel(descEl, VOICE_ICON_WORDS) || null
        : words.slice(1).join(" ") || null) ??
      meta?.description ??
      null;
    const id = meta?.id ?? (custom ? undefined : `voices/${name}`);
    rows.push({
      ...(id ? { id } : {}),
      name,
      description,
      custom,
      ...(meta?.mediaId ? { mediaId: meta.mediaId } : {}),
      ...(meta?.workflowId ? { workflowId: meta.workflowId } : {}),
      el: b,
    });
  }
  return rows;
}

/** Returns the scroll container of the voice list. */
function listScroller(pane: Element): HTMLElement | null {
  return (
    Array.from(pane.querySelectorAll<HTMLElement>("*")).find(
      (e) =>
        e.scrollHeight > e.clientHeight + 50 &&
        (/voice_selection/.test(e.innerText || "") ||
          Boolean(e.querySelector("flow-add-menu-asset-item, .asset-title"))),
    ) || null
  );
}

/** Opens the voice dialog from the character voice button and waits until it renders. */
async function openDialog(): Promise<Element | null> {
  const openInner = async (): Promise<Element | null> => {
    const existing = voicePane();
    if (existing) return existing;
    const btn = document.querySelector<HTMLElement>(
      "flow-character-voice-button button",
    );
    if (!btn) return null;
    btn.click();
    for (let i = 0; i < 50; i++) {
      await delay(100);
      const pane = voicePane();
      if (pane && renderedRows(pane).length > 0) return pane;
    }
    return null;
  };
  const pane =
    runtimeState.ngLViewMap instanceof Map
      ? await openInner()
      : await withLViewMapCapture(openInner);
  if (pane) {
    await ensureAngularHostsBound([
      document.querySelector("flow-character-form"),
      pane.querySelector("flow-add-menu-popover-content"),
    ]);
  }
  return pane;
}

/** Scrolls the whole virtual list once and returns every voice row in list order. */
async function collectAllRows(pane: Element): Promise<VoiceRow[]> {
  await ensureAngularHostsBound([
    document.querySelector("flow-character-form"),
    pane.querySelector("flow-add-menu-popover-content"),
  ]);
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

/** Returns true when `el`, an ancestor, or a child voice item is active in the picker. */
function isVoiceRowActive(el: HTMLElement): boolean {
  return (
    el.classList.contains("asset-item-active") ||
    el.getAttribute("aria-selected") === "true" ||
    Boolean(el.querySelector('.asset-item-active, [aria-selected="true"]')) ||
    Boolean(el.closest('.asset-item-active, [aria-selected="true"]'))
  );
}

/** Returns true when `row` matches `query` by name, `voices/<Name>`, `id`, `mediaId`, or `workflowId`. */
function voiceRowMatches(row: VoiceRow, query: string): boolean {
  const want = query.trim().toLowerCase();
  return (
    Boolean(want) &&
    (row.name.toLowerCase() === want ||
      `voices/${row.name}`.toLowerCase() === want ||
      row.id?.toLowerCase() === want ||
      row.mediaId?.toLowerCase() === want ||
      row.workflowId?.toLowerCase() === want)
  );
}

/** Returns true when `query` matches the current character voice or an active row in `pane`. */
function isTargetVoiceCurrentOrActive(pane: Element, query: string): boolean {
  const want = query.trim().toLowerCase();
  const wantShort = want.replace(/^voices\//i, "");
  const curBtn = voiceButtonText().toLowerCase();
  const curId = currentCharacterFormVoiceId().toLowerCase();
  const curIdShort = curId.replace(/^voices\//i, "");
  return (
    (Boolean(curBtn) && (curBtn === want || curBtn === wantShort)) ||
    (Boolean(curId) && (curId === want || curIdShort === wantShort)) ||
    renderedRows(pane).some(
      (r) => voiceRowMatches(r, query) && isVoiceRowActive(r.el),
    )
  );
}

/** Scrolls until a matching row renders, clicks it, and returns its metadata. */
async function selectRow(
  pane: Element,
  name: string,
  options?: SelectRowOptions,
): Promise<VoiceMeta | null> {
  await ensureAngularHostsBound([
    document.querySelector("flow-character-form"),
    pane.querySelector("flow-add-menu-popover-content"),
  ]);
  let sc = listScroller(pane);
  if (sc) sc.scrollTop = 0;
  await delay(200);
  for (let i = 0; i < 60; i++) {
    const rows = renderedRows(pane);
    const row = rows.find((r) => voiceRowMatches(r, name));
    if (row) {
      let target = row;
      target.el.scrollIntoView({ block: "center" });
      if (options?.reopenIfActive && isVoiceRowActive(target.el)) {
        const other = rows.find(
          (r) =>
            r.el !== target.el &&
            !voiceRowMatches(r, name) &&
            !isVoiceRowActive(r.el),
        );
        if (other) {
          other.el.click();
          await delay(700);
          target =
            renderedRows(pane).find((r) => voiceRowMatches(r, name)) ?? target;
        }
      }
      options?.onBeforeTargetClick?.();
      target.el.click();
      await delay(700);
      const { el: _el, ...meta } = target;
      return meta;
    }
    // Flow renders the list after the dialog opens, so wait while no row exists.
    if (!rows.length && i < 25) {
      await delay(300);
      continue;
    }
    sc ??= listScroller(pane);
    if (!sc) break;
    const before = sc.scrollTop;
    sc.scrollTop = before + Math.max(120, sc.clientHeight - 60);
    await delay(200);
    if (sc.scrollTop === before) break;
  }
  return null;
}

/** Returns the dialog field that matches `test` on its placeholder. */
function field(
  pane: Element,
  test: RegExp,
): HTMLInputElement | HTMLTextAreaElement | null {
  return (
    Array.from(
      pane.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        "textarea, input",
      ),
    ).find((f) => test.test(f.getAttribute("placeholder") || "")) || null
  );
}

/** Returns the visible dialog button whose text or `aria-label` matches `re`. */
function paneButton(pane: Element, re: RegExp): HTMLElement | null {
  return (
    Array.from(pane.querySelectorAll<HTMLElement>("button")).find(
      (b) =>
        isVisibleEnabled(b) &&
        !/voice_selection/.test(b.innerText || "") &&
        !b.querySelector(
          "flow-add-menu-asset-item, .asset-title, .voice-card-name",
        ) &&
        re.test(`${b.getAttribute("aria-label") || ""} ${elText(b)}`),
    ) || null
  );
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
  const oldRows = new Set(renderedRows(voicePane() ?? pane)
    .filter((row) => row.custom && row.name === savedName)
    .map((row) => row.el));
  const receipt = format && bindCustomVoiceReceipt(voicePane() ?? pane, format);
  try {
    save.click();
    // Flow can keep Add to character active for the base voice during the save.
    while (globalThis.performance.now() < deadline) {
      await delay(500);
      const error = findSnackbarMatch(saveError);
      if (error && (error.bar !== priorError?.bar || error.text !== priorError.text)) {
        const detail = error.text.match(saveError)?.[0];
        if (/^failed to save voice$/i.test(detail ?? "")) {
          return { error: "outcome_unknown", stage: "save_custom_voice", detail };
        }
        return { error: "custom_voice_preview_failed", stage: "generate_voice_preview", detail };
      }
      const current = voicePane();
      if (!current) {
        return {
          error: "outcome_unknown", stage: "save_custom_voice",
          detail: "Flow closes the voice dialog before it confirms the save",
        };
      }
      if (receipt) {
        const id = receipt.selected();
        if (id) return { name: savedName, id };
      } else {
        const saved = renderedRows(current).find((row) =>
          row.custom && row.name === savedName && !oldRows.has(row.el));
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
  return {
    error: "outcome_unknown", stage: "save_custom_voice",
    detail: "Flow does not confirm the custom voice before the time limit",
  };
}

/** Returns the text of the character voice button. */
function voiceButtonText(): string {
  const button = document.querySelector("flow-character-voice-button");
  const name = cleanVoiceLabel(
    button?.querySelector(".voice-card-name, .asset-title") ?? null,
    VOICE_ICON_WORDS,
  );
  return (name || cleanVoiceLabel(button, VOICE_ICON_WORDS) || elText(button))
    .replace(/\s+/g, " ")
    .trim();
}

/** Selects a base voice, optionally saves a custom voice with sample dialogue and performance text, and adds it to the character. */
async function applyVoice(
  req: CharacterExtraOpRequest,
): Promise<Record<string, unknown>> {
  const deadline = globalThis.performance.now() + VOICE_SAVE_TIMEOUT_MS;
  const base = String(req.voice || "").trim();
  const sample = String(req.sample || "").trim();
  const performance = String(req.performance || "").trim();
  const name = String(req.voice_name || "").trim();
  const custom = Boolean(sample || performance);
  if (custom && sample.length > 120)
    return { ok: false, error: "voice_sample_over_120_characters" };
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
    if (isTargetVoiceCurrentOrActive(pane, base)) {
      const other = renderedRows(pane).find(
        (r) => !voiceRowMatches(r, base) && !isVoiceRowActive(r.el),
      );
      if (other) await selectRow(pane, other.name);
    }
    selected = await selectRow(voicePane() ?? pane, base, {
      reopenIfActive: true,
    });
    if (!selected) {
      const available = (await collectAllRows(voicePane() ?? pane)).map(
        (r) => r.name,
      );
      await dismissOverlay();
      return {
        ok: false,
        error: `voice_not_found:${base}`,
        available_voices: available,
      };
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
  if (add) {
    add.click();
  } else {
    clickButtonByRegex(/^(?:add to character|done|apply|select)$/i, pane);
  }
  await delay(1500);
  if (voicePane()) await dismissOverlay();
  const shown = voiceButtonText();
  const expect = expected.toLowerCase();
  if (expect && !shown.toLowerCase().includes(expect)) {
    return { ok: false, error: "voice_not_applied", shown };
  }
  if (confirm && !await confirm(expectedId)) {
    return { ok: false, error: "outcome_unknown", stage: "set_character_voice" };
  }
  return { ok: true, applied: [custom ? "custom_voice" : "voice"], shown };
}

/** Fetches `src` and returns it as a base64 audio result. */
async function audioResult(src: string): Promise<Record<string, unknown>> {
  for (const a of Array.from(document.querySelectorAll("audio"))) a.pause();
  const res = await fetch(src);
  if (!res.ok)
    return { ok: false, error: `voice_preview_fetch_failed:${res.status}` };
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return {
    ok: true,
    mime: res.headers.get("content-type") || "audio/wav",
    data: btoa(bin),
    voice: voiceButtonText(),
  };
}

/** Returns every audio URL that the page has played or loaded. */
function knownAudioUrls(isCustomVoice = false): string[] {
  const fromEls = Array.from(document.querySelectorAll("audio")).map(
    (a) => a.currentSrc || a.src,
  );
  const fromNet = performance
    .getEntriesByType("resource")
    .map((e) => e.name)
    .filter((u) => /flow-content\.google\/audio\//.test(u));
  return [...fromEls, ...fromNet].filter(
    (s) => /^(?:https?:|blob:)/.test(s) && !isBogusVoiceSampleUrl(s, isCustomVoice),
  );
}

/** Plays the character voice preview and returns the audio as base64. */
async function previewVoice(): Promise<Record<string, unknown>> {
  // The character page renders the voice button some time after the route changes.
  const findPlay = (): HTMLElement | null =>
    document
      .querySelector("flow-character-voice-button")
      ?.querySelector<HTMLElement>('button[aria-label="Play preview"]') ?? null;
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
    if (!isFormVoiceAudioLoading(formComp)) {
      await delay(100);
      formComp = findCharacterFormComponent() ?? formComp;
    }
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
    const rawUrls = Array.from(document.querySelectorAll("audio")).map(
      (a) => a.currentSrc || a.src,
    );
    src =
      rawUrls.find(
        (s) => /^(?:https?:|blob:)/.test(s) && !isBogusVoiceSampleUrl(s, isCustom),
      ) ||
      knownAudioUrls(isCustom).find((u) => !beforePlay.has(u)) ||
      "";
    if (src || loading) continue;
    const bogusUuid = rawUrls.map(extractBogusSampleUuid).find(Boolean);
    const ids = [mediaId, bogusUuid].filter(
      (v, idx, arr): v is string => Boolean(v) && arr.indexOf(v) === idx,
    );
    if (!triedResolve && ids.length > 0 && (i >= 1 || Boolean(bogusUuid))) {
      triedResolve = true;
      for (const id of ids) {
        src = await resolveCustomAudioUrl(id);
        if (src) break;
      }
    }
  }
  if (!src) return { ok: false, error: "voice_preview_audio_not_found" };
  return audioResult(src);
}

/** Reads `<audio src>` inside `flow-voice-preview-pane`, skipping bogus UUID sample paths. */
function previewPaneAudioSrc(pane: Element, isCustomVoice: boolean): string {
  const root = pane.querySelector("flow-voice-preview-pane") ?? pane;
  for (const audio of Array.from(root.querySelectorAll<HTMLAudioElement>("audio"))) {
    const candidate = (audio.currentSrc || audio.src || "").trim();
    if (
      /^(?:https?:|blob:)/.test(candidate) &&
      !isBogusVoiceSampleUrl(candidate, isCustomVoice)
    ) {
      return candidate;
    }
  }
  return "";
}

/** Generates a preview of a base voice with sample and performance text in the voice dialog, without saving a voice. */
async function auditionVoice(
  req: CharacterExtraOpRequest,
): Promise<Record<string, unknown>> {
  const base = String(req.voice || "").trim();
  const sample = String(req.sample || "").trim();
  const performance = String(req.performance || "").trim();
  if (!base) return { ok: false, error: "audition_needs_voice" };
  if (sample.length > 120)
    return { ok: false, error: "voice_sample_over_120_characters" };
  const pane = await openDialog();
  if (!pane) return { ok: false, error: "voice_dialog_not_available" };
  // Flow applies the voice and closes the dialog when the row of the current voice is clicked.
  // Select another row first so that the click on the base voice only opens its preview pane.
  if (isTargetVoiceCurrentOrActive(pane, base)) {
    for (let i = 0; i < 25 && renderedRows(pane).length === 0; i++) {
      await delay(300);
    }
    const other = renderedRows(pane).find(
      (r) => !voiceRowMatches(r, base) && !isVoiceRowActive(r.el),
    );
    if (other && !(await selectRow(pane, other.name))) {
      await dismissOverlay();
      return { ok: false, error: `voice_not_found:${other.name}` };
    }
  }
  let paneSrcBeforeSelect = previewPaneAudioSrc(voicePane() ?? pane, false);
  let before = new Set(knownAudioUrls());
  const selected = await selectRow(voicePane() ?? pane, base, {
    reopenIfActive: true,
    onBeforeTargetClick: () => {
      const live = voicePane() ?? pane;
      paneSrcBeforeSelect = previewPaneAudioSrc(live, false);
      before = new Set(knownAudioUrls());
    },
  });
  if (!selected) {
    await dismissOverlay();
    return { ok: false, error: `voice_not_found:${base}` };
  }
  const generated = Boolean(sample || performance);
  const sampleSuffix = `/samples/${selected.name.toLowerCase()}.wav`;
  const matchesVoiceSample = (url: string): boolean =>
    selected.custom ||
    !/\/samples\/[^/?#]+\.wav(?:[?#]|$)/i.test(url) ||
    url.toLowerCase().includes(sampleSuffix);
  const matchPreloaded = (): string =>
    selected.custom
      ? ""
      : knownAudioUrls(false).find((u) =>
          u.toLowerCase().includes(sampleSuffix),
        ) || "";
  const pollAuditionSrc = (requireNew: boolean): string => {
    const paneSrc = previewPaneAudioSrc(voicePane() ?? pane, selected.custom);
    const allowPane = requireNew
      ? !before.has(paneSrc)
      : paneSrc !== paneSrcBeforeSelect && matchesVoiceSample(paneSrc);
    if (paneSrc && allowPane) return paneSrc;
    return (
      knownAudioUrls(selected.custom).find(
        (u) => !before.has(u) && (requireNew || matchesVoiceSample(u)),
      ) || ""
    );
  };
  let src = "";
  if (!generated) {
    for (let i = 0; i < 20 && !src; i++) {
      src = pollAuditionSrc(false) || (i >= 4 ? matchPreloaded() : "");
      if (!src) await delay(150);
    }
    if (!src && selected.custom) {
      src = await resolveCustomAudioUrl(selected.mediaId ?? selected.id);
    }
    if (!src) {
      const livePane = voicePane() ?? pane;
      before = new Set(knownAudioUrls(selected.custom));
      paneSrcBeforeSelect = previewPaneAudioSrc(livePane, selected.custom);
      if (paneSrcBeforeSelect) before.add(paneSrcBeforeSelect);
      const play = paneButton(livePane, /preview/i);
      if (play) {
        play.click();
        for (let i = 0; i < 40 && !src; i++) {
          await delay(250);
          src = pollAuditionSrc(false) || matchPreloaded();
        }
      } else {
        src = matchPreloaded();
      }
    }
  } else {
    const livePane = voicePane() ?? pane;
    const sampleEl = field(livePane, /hi there/i);
    const perfEl = field(livePane, /performance style/i);
    if (sample && sampleEl) setNativeValue(sampleEl, sample);
    if (performance && perfEl) setNativeValue(perfEl, performance);
    await delay(400);
    before = new Set(knownAudioUrls(selected.custom));
    const initialPaneSrc = previewPaneAudioSrc(
      voicePane() ?? livePane,
      selected.custom,
    );
    if (initialPaneSrc) before.add(initialPaneSrc);
    const play = paneButton(voicePane() ?? livePane, /preview/i);
    if (!play) {
      await dismissOverlay();
      return { ok: false, error: "voice_preview_button_not_found" };
    }
    play.click();
    for (let i = 0; i < 180 && !src; i++) {
      await delay(500);
      src = pollAuditionSrc(true);
    }
  }
  let result: Record<string, unknown>;
  try {
    result = src
      ? await audioResult(src)
      : { ok: false, error: "voice_audition_audio_not_found" };
  } catch (e) {
    result = { ok: false, error: `voice_audition_fetch_failed:${String(e)}` };
  }
  await dismissOverlay();
  return { ...result, voice: selected.name };
}

/** Deletes the portrait image of the open character and waits until the slot is empty. */
async function deletePortrait(): Promise<Record<string, unknown>> {
  return clearCharacterSlot("portrait");
}

/** Runs one character editor action that `characterVoiceOp` and `characterMediaOp` do not cover. */
export async function characterExtraOp(
  req: CharacterExtraOpRequest,
): Promise<unknown> {
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
