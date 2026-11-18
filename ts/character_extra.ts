// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Custom voices, full voice lists, voice previews, and portrait removal on the open character editor page.

import {
  clickButtonByRegex,
  delay,
  dismissOverlay,
  elText,
  setNativeValue,
} from "./dom";
import type { CharacterExtraOpRequest } from "./types";

/** One voice row in the "Select a voice" dialog. */
interface VoiceRow {
  /** Voice name as the dialog shows it. */
  name: string;
  /** Voice description, for example "Female, soft, high pitch". */
  description: string | null;
  /** True for a saved custom voice. */
  custom: boolean;
  /** Row button element. */
  el: HTMLElement;
}

/** Icon ligature words that the dialog renders as text inside voice rows. */
const ICON_WORDS = new Set(["voice_selection", "settings_2", "play_arrow"]);

/** Returns the open voice dialog pane, or null. */
function voicePane(): Element | null {
  return (
    Array.from(
      document.querySelectorAll(".cdk-overlay-pane, [role='dialog']"),
    ).find((p) => /select a voice/i.test(elText(p))) || null
  );
}

/** Parses the voice rows that the dialog has rendered now. */
function renderedRows(pane: Element): VoiceRow[] {
  const rows: VoiceRow[] = [];
  for (const b of Array.from(pane.querySelectorAll("button"))) {
    const text = b.innerText || "";
    if (!/voice_selection/.test(text)) continue;
    const lines = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const words = lines.filter((l) => !ICON_WORDS.has(l));
    if (!words.length) continue;
    rows.push({
      name: words[0],
      description: words.slice(1).join(" ") || null,
      custom: lines.includes("settings_2"),
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
        /voice_selection/.test(e.innerText || ""),
    ) || null
  );
}

/** Opens the voice dialog from the character voice button and waits until it renders. */
async function openDialog(): Promise<Element | null> {
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
}

/** Scrolls the whole virtual list once and returns every voice row in list order. */
async function collectAllRows(pane: Element): Promise<VoiceRow[]> {
  const sc = listScroller(pane);
  const byName = new Map<string, VoiceRow>();
  const take = (): void => {
    for (const r of renderedRows(pane)) {
      if (!byName.has(r.name)) byName.set(r.name, r);
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
  return Array.from(byName.values());
}

/** Scrolls until a row named `name` renders, clicks it, and returns true on success. */
async function selectRow(pane: Element, name: string): Promise<boolean> {
  const want = name.trim().toLowerCase();
  const sc = listScroller(pane);
  if (sc) sc.scrollTop = 0;
  await delay(200);
  for (let i = 0; i < 60; i++) {
    const row = renderedRows(pane).find((r) => r.name.toLowerCase() === want);
    if (row) {
      row.el.scrollIntoView({ block: "center" });
      row.el.click();
      await delay(700);
      return true;
    }
    if (!sc) break;
    const before = sc.scrollTop;
    sc.scrollTop = before + Math.max(120, sc.clientHeight - 60);
    await delay(200);
    if (sc.scrollTop === before) break;
  }
  return false;
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

/** Returns the visible dialog button whose text matches `re`. */
function paneButton(pane: Element, re: RegExp): HTMLElement | null {
  return (
    Array.from(pane.querySelectorAll<HTMLElement>("button")).find(
      (b) =>
        !/voice_selection/.test(b.innerText || "") &&
        re.test(b.innerText || ""),
    ) || null
  );
}

/** Returns the text of the character voice button. */
function voiceButtonText(): string {
  return elText(document.querySelector("flow-character-voice-button"))
    .replace(/\s+/g, " ")
    .trim();
}

/** Selects a base voice, optionally saves a custom voice with sample dialogue and performance text, and adds it to the character. */
async function applyVoice(
  req: CharacterExtraOpRequest,
): Promise<Record<string, unknown>> {
  const base = String(req.voice || "").trim();
  const sample = String(req.sample || "").trim();
  const performance = String(req.performance || "").trim();
  const name = String(req.voice_name || "").trim();
  const custom = Boolean(sample || performance);
  if (custom && sample.length > 120)
    return { ok: false, error: "voice_sample_over_120_characters" };
  const pane = await openDialog();
  if (!pane) return { ok: false, error: "voice_dialog_not_available" };
  if (base && !(await selectRow(pane, base))) {
    const available = (await collectAllRows(pane)).map((r) => r.name);
    await dismissOverlay();
    return {
      ok: false,
      error: `voice_not_found:${base}`,
      available_voices: available,
    };
  }
  if (custom) {
    const sampleEl = field(pane, /hi there/i);
    const perfEl = field(pane, /performance style/i);
    if (!sampleEl || !perfEl) {
      await dismissOverlay();
      return { ok: false, error: "voice_custom_fields_not_found" };
    }
    if (sample) setNativeValue(sampleEl, sample);
    if (performance) setNativeValue(perfEl, performance);
    let nameEl: HTMLInputElement | HTMLTextAreaElement | null = null;
    for (let i = 0; i < 30 && !nameEl; i++) {
      await delay(100);
      nameEl = field(pane, /voice name/i);
    }
    if (nameEl && name) setNativeValue(nameEl, name);
    const save = paneButton(pane, /save new voice/i);
    if (!save) {
      await dismissOverlay();
      return { ok: false, error: "save_new_voice_button_not_found" };
    }
    save.click();
    let ready = false;
    // Stay below the 120-second limit of the Rust call, so that this op reports the timeout.
    for (let i = 0; i < 220 && !ready; i++) {
      await delay(500);
      ready = Boolean(paneButton(pane, /add to character/i));
    }
    if (!ready) {
      await dismissOverlay();
      return { ok: false, error: "custom_voice_save_timeout" };
    }
  }
  const add = paneButton(pane, /add to character/i);
  if (add) {
    add.click();
  } else {
    clickButtonByRegex(/^(?:add to character|done|apply|select)$/i, pane);
  }
  await delay(1500);
  if (voicePane()) await dismissOverlay();
  const shown = voiceButtonText();
  const expect = (custom ? name : base).toLowerCase();
  if (expect && !shown.toLowerCase().includes(expect)) {
    return { ok: false, error: "voice_not_applied", shown };
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
function knownAudioUrls(): string[] {
  const fromEls = Array.from(document.querySelectorAll("audio")).map(
    (a) => a.currentSrc || a.src,
  );
  const fromNet = performance
    .getEntriesByType("resource")
    .map((e) => e.name)
    .filter((u) => /flow-content\.google\/audio\//.test(u));
  return [...fromEls, ...fromNet].filter((s) => /^(?:https?:|blob:)/.test(s));
}

/** Plays the character voice preview and returns the audio as base64. */
async function previewVoice(): Promise<Record<string, unknown>> {
  // The character page renders the voice button some time after the route changes.
  let play: HTMLElement | null = null;
  for (let i = 0; i < 40 && !play; i++) {
    play =
      document
        .querySelector("flow-character-voice-button")
        ?.querySelector<HTMLElement>('button[aria-label="Play preview"]') ??
      null;
    if (!play) await delay(500);
  }
  if (!play) return { ok: false, error: "voice_preview_button_not_found" };
  play.click();
  let src = "";
  for (let i = 0; i < 120 && !src; i++) {
    await delay(500);
    src =
      Array.from(document.querySelectorAll("audio"))
        .map((a) => a.currentSrc || a.src)
        .find((s) => /^(?:https?:|blob:)/.test(s)) || "";
  }
  if (!src) return { ok: false, error: "voice_preview_audio_not_found" };
  return audioResult(src);
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
  if (!(await selectRow(pane, base))) {
    await dismissOverlay();
    return { ok: false, error: `voice_not_found:${base}` };
  }
  const sampleEl = field(pane, /hi there/i);
  const perfEl = field(pane, /performance style/i);
  if (sample && sampleEl) setNativeValue(sampleEl, sample);
  if (performance && perfEl) setNativeValue(perfEl, performance);
  await delay(400);
  const before = new Set(knownAudioUrls());
  const play = paneButton(pane, /preview/i);
  if (!play) {
    await dismissOverlay();
    return { ok: false, error: "voice_preview_button_not_found" };
  }
  play.click();
  let src = "";
  for (let i = 0; i < 180 && !src; i++) {
    await delay(500);
    src = knownAudioUrls().find((u) => !before.has(u)) || "";
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
  return { ...result, voice: base };
}

/** Deletes the portrait image of the open character and waits until the slot is empty. */
async function deletePortrait(): Promise<Record<string, unknown>> {
  const preview = document.querySelector("flow-character-image-preview");
  const del = preview?.querySelector<HTMLElement>(
    'button[aria-label="Delete image"]',
  );
  if (!del) return { ok: true, deleted: false };
  del.click();
  for (let i = 0; i < 30; i++) {
    await delay(100);
    const confirm = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".cdk-overlay-pane button, [role='dialog'] button",
      ),
    ).find((b) => /^delete$/i.test(elText(b).trim()));
    if (confirm) {
      confirm.click();
      break;
    }
  }
  for (let i = 0; i < 50; i++) {
    await delay(100);
    if (
      /add from project/i.test(
        elText(document.querySelector("flow-character-image-preview")),
      )
    ) {
      return { ok: true, deleted: true };
    }
  }
  return { ok: false, error: "portrait_delete_not_confirmed" };
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
        id: r.name,
        name: r.name,
        description: r.description,
        custom: r.custom,
      })),
    };
  }
  return { ok: false, error: `unknown_character_extra_op:${action}` };
}
