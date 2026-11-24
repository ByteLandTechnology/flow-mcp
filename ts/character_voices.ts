// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// List and assign Google Flow character voices inside the character editor.

import type { NgContextCarrier } from "./angular";
import {
  clickButtonByRegex,
  delay,
  dismissOverlay,
  elText,
  isVisibleEnabled,
} from "./dom";
import { isStoreDestroyed } from "./store_shape";
import type { AngularLifecycleHandle, CharacterVoiceOpRequest } from "./types";

/** Minified Angular character form component hosting voice signals. */
interface CharacterFormComponent extends AngularLifecycleHandle {
  /** Voice map signal accessor. */
  bW?: () => Map<unknown, RawVoiceEntry> | null | undefined;
  /** Selected voice ID signal setter. */
  zZ?: (() => unknown) & { set?: (id: string) => void };
  /** Selected voice record signal setter. */
  Kna?: { set?: (raw: RawVoiceEntry) => void };
  /** Voice change emitter. */
  p$?: { emit?: (id: string) => void };
  /** Busy signal accessor. */
  yb?: () => boolean;
}

/** Raw voice descriptor stored inside the Angular character form map. */
interface RawVoiceEntry {
  /** Voice identifier. */
  id?: string | number;
  /** Internal voice name fallback. */
  name?: string;
  /** Human-readable voice title. */
  title?: string;
  /** Voice description summary. */
  description?: string;
}

/** Normalized voice item returned or matched during selection. */
interface NormalizedVoiceItem {
  /** Voice identifier. */
  id: string;
  /** Voice display name. */
  name: string;
  /** Optional voice description. */
  description: string | null;
  /** Underlying raw component entry when available. */
  _raw: RawVoiceEntry | null;
}

/** Cached component instances keyed by `flow-character-form` host element. */
const formComponents = new WeakMap<Element, CharacterFormComponent>();

/** Tracks form elements whose Ivy context probe already ran for one polling pass. */
const probedForms = new WeakSet<Element>();

/** Lists available voices or sets a matching voice inside `/character/<id>`. */
export async function characterVoiceOp(
  req: CharacterVoiceOpRequest,
): Promise<unknown> {
  function getCharacterFormInstance(): CharacterFormComponent | null {
    const form = document.querySelector("flow-character-form");
    if (!form) return null;
    const cached = formComponents.get(form);
    if (cached && !isStoreDestroyed(cached)) {
      return cached;
    }
    const isBasicObj = (cand: unknown): cand is CharacterFormComponent =>
      Boolean(
        cand &&
          typeof cand === "object" &&
          !Array.isArray(cand) &&
          !(cand instanceof Node) &&
          !(cand instanceof Map) &&
          !(cand instanceof Set) &&
          cand !== window &&
          cand !== document &&
          !isStoreDestroyed(cand),
      );
    const isExactComp = (cand: unknown): cand is CharacterFormComponent =>
      isBasicObj(cand) &&
      typeof cand.bW === "function" &&
      typeof cand.zZ === "function";
    const isFormComp = (cand: unknown): cand is CharacterFormComponent => {
      if (!isBasicObj(cand)) return false;
      if (typeof cand.bW === "function" && typeof cand.zZ === "function") {
        return true;
      }
      try {
        return Object.values(cand).includes("Select a voice");
      } catch {
        return false;
      }
    };
    const scanLView = (
      rootLv: unknown,
      predicate: (c: unknown) => c is CharacterFormComponent,
    ): CharacterFormComponent | null => {
      const visited = new Set<unknown>();
      const walk = (lv: unknown, depth: number): CharacterFormComponent | null => {
        if (!Array.isArray(lv) || depth > 2 || visited.has(lv)) return null;
        visited.add(lv);
        for (let i = 0; i < lv.length; i++) {
          const item: unknown = lv[i];
          if (predicate(item)) return item;
          if (depth < 2 && Array.isArray(item)) {
            const nested = walk(item, depth + 1);
            if (nested) return nested;
          }
        }
        return null;
      };
      return walk(rootLv, 0);
    };
    const formNg = (form as NgContextCarrier).__ngContext__;
    const direct =
      scanLView(formNg, isExactComp) || scanLView(formNg, isFormComp);
    if (direct) {
      formComponents.set(form, direct);
      return direct;
    }
    if (typeof formNg !== "number" || probedForms.has(form)) {
      return null;
    }
    probedForms.add(form);

    const seenMaps = new Set<Map<unknown, unknown>>();
    const seenLViews: unknown[] = [];
    const origGet = Map.prototype.get;
    const origSet = Map.prototype.set;
    try {
      Map.prototype.get = function (
        this: Map<unknown, unknown>,
        k: unknown,
      ): unknown {
        seenMaps.add(this);
        return origGet.call(this, k);
      };
      Map.prototype.set = function (
        this: Map<unknown, unknown>,
        k: unknown,
        v: unknown,
      ): Map<unknown, unknown> {
        seenMaps.add(this);
        if (Array.isArray(v)) seenLViews.push(v);
        return origSet.call(this, k, v);
      };
      const r = form.getBoundingClientRect();
      const cx = r.left + Math.min(24, Math.max(2, r.width / 2));
      const cy = r.top + Math.min(24, Math.max(2, r.height / 2));
      form.dispatchEvent(
        new PointerEvent("pointerenter", {
          bubbles: false,
          clientX: cx,
          clientY: cy,
        }),
      );
      form.dispatchEvent(
        new MouseEvent("mouseenter", {
          bubbles: false,
          clientX: cx,
          clientY: cy,
        }),
      );
      for (const el of form.querySelectorAll(
        "flow-character-voice-button, [mattooltip], button",
      )) {
        const er = el.getBoundingClientRect();
        const ex = er.left + Math.min(12, Math.max(2, er.width / 2));
        const ey = er.top + Math.min(12, Math.max(2, er.height / 2));
        el.dispatchEvent(
          new MouseEvent("mouseenter", {
            bubbles: false,
            clientX: ex,
            clientY: ey,
          }),
        );
        el.dispatchEvent(
          new MouseEvent("mouseleave", {
            bubbles: false,
            clientX: ex,
            clientY: ey,
          }),
        );
      }
      for (const inp of form.querySelectorAll("input, textarea")) {
        inp.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
      }
    } finally {
      Map.prototype.get = origGet;
      Map.prototype.set = origSet;
    }
    const idx = formNg;
    const findAcrossCaptured = (
      predicate: (c: unknown) => c is CharacterFormComponent,
    ): CharacterFormComponent | null => {
      for (const lv of seenLViews) {
        const hit = scanLView(lv, predicate);
        if (hit) return hit;
      }
      for (const sm of seenMaps) {
        try {
          const directIdxHit = scanLView(sm.get(idx), predicate);
          if (directIdxHit) return directIdxHit;
          for (const v of sm.values()) {
            const hit = scanLView(v, predicate);
            if (hit) return hit;
          }
        } catch {
          // Ignore mutated map errors.
        }
      }
      return null;
    };
    const hit =
      findAcrossCaptured(isExactComp) || findAcrossCaptured(isFormComp);
    if (hit) {
      formComponents.set(form, hit);
      return hit;
    }
    return null;
  }

  function readVoicesFromComponent(
    comp: CharacterFormComponent | null,
  ): NormalizedVoiceItem[] {
    if (!comp) return [];
    const items: NormalizedVoiceItem[] = [];
    const seen = new Set<string>();
    const pushItem = (raw: unknown): void => {
      if (!raw || typeof raw !== "object") return;
      const entry = raw as RawVoiceEntry;
      const id = String(entry.id ?? entry.name ?? "").trim();
      const name = String(entry.title || entry.name || id).trim();
      const key = (id || name).toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      items.push({
        id: id || name,
        name: name || id,
        description: entry.description ? String(entry.description) : null,
        _raw: entry,
      });
    };
    try {
      const bw = typeof comp.bW === "function" ? comp.bW() : null;
      if (bw instanceof Map) {
        for (const v of bw.values()) pushItem(v);
      }
    } catch {
      // Ignore disposed signal access.
    }
    return items;
  }

  async function waitForVoiceHost(maxTicks = 40): Promise<boolean> {
    for (let i = 0; i < maxTicks; i++) {
      if (
        document.querySelector(
          "flow-character-form, flow-character-voice-button",
        )
      ) {
        return true;
      }
      await delay(100);
    }
    return false;
  }

  async function waitForComponentVoices(maxTicks = 35): Promise<{
    comp: CharacterFormComponent | null;
    voices: NormalizedVoiceItem[];
  }> {
    await waitForVoiceHost(40);
    let lastComp: CharacterFormComponent | null = null;
    for (let i = 0; i < maxTicks; i++) {
      if (i === 10) {
        const form = document.querySelector("flow-character-form");
        if (form) probedForms.delete(form);
      }
      lastComp = getCharacterFormInstance();
      const voices = readVoicesFromComponent(lastComp);
      if (voices.length > 0) {
        return { comp: lastComp, voices };
      }
      await delay(100);
    }
    return { comp: lastComp, voices: [] };
  }

  async function openVoiceModal(): Promise<boolean> {
    await waitForVoiceHost(40);
    const findVoiceBtn = (): HTMLElement | null => {
      const host = document.querySelector("flow-character-voice-button");
      if (host) {
        const inner = Array.from(
          host.querySelectorAll(
            ".voice-selector-empty-btn, .voice-card-start-btn, button, [role='button']",
          ),
        ).find(isVisibleEnabled);
        if (inner) return inner;
      }
      return (
        Array.from(document.querySelectorAll('button, [role="button"]')).find(
          (el): el is HTMLElement =>
            isVisibleEnabled(el) &&
            /select a voice|change voice|\bvoice\b/i.test(
              (el.getAttribute("aria-label") || elText(el)).trim(),
            ),
        ) || null
      );
    };
    let hostBtn: Element | null = null;
    for (let i = 0; i < 40; i++) {
      hostBtn = findVoiceBtn();
      if (hostBtn) break;
      await delay(100);
    }
    if (!hostBtn) {
      hostBtn = document.querySelector("flow-character-voice-button");
    }
    if (!(hostBtn instanceof HTMLElement)) return false;
    hostBtn.click();
    for (let i = 0; i < 60; i++) {
      await delay(100);
      const overlay = document.querySelector(
        'cdk-overlay-pane, [role="dialog"]',
      );
      if (!overlay || overlay.querySelector(".loading-container")) {
        continue;
      }
      if (
        overlay.querySelectorAll(
          "flow-add-menu-asset-item, .asset-title, .voice-card-name",
        ).length > 0
      ) {
        return true;
      }
    }
    return false;
  }

  async function scrapeVoices(): Promise<NormalizedVoiceItem[]> {
    const comp = getCharacterFormInstance();
    const items: NormalizedVoiceItem[] = [];
    const seen = new Set<string>();
    for (const v of readVoicesFromComponent(comp)) {
      const key = (v.id || v.name).toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        items.push(v);
      }
    }
    const overlay = document.querySelector('cdk-overlay-pane, [role="dialog"]');
    const root: ParentNode = overlay || document;
    const ctrlRe =
      /^(?:select a voice|add to character|close|cancel|done|search|clear search)$/i;
    for (const assetItem of root.querySelectorAll("flow-add-menu-asset-item")) {
      const titleEl = assetItem.querySelector(".asset-title");
      const descEl = assetItem.querySelector(".asset-description");
      const name = elText(titleEl);
      if (!name || ctrlRe.test(name) || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const desc = elText(descEl);
      items.push({ id: name, name, description: desc || null, _raw: null });
    }
    const cards = Array.from(
      root.querySelectorAll('[class*="voice-card"]'),
    ).filter((c) => c.querySelector(".voice-card-name"));
    for (const card of cards) {
      const nameEl = card.querySelector(".voice-card-name");
      const name = elText(nameEl);
      if (!name || ctrlRe.test(name) || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const fullText = elText(card).replace(/\s+/g, " ").trim();
      items.push({
        id: name,
        name,
        description: fullText.replace(name, "").trim() || null,
        _raw: null,
      });
    }
    if (overlay) {
      const rows = overlay.querySelectorAll(
        '[role="option"], [role="menuitem"], button, [class*="item"], [class*="tile"], [class*="card"]',
      );
      for (const row of rows) {
        if (!isVisibleEnabled(row)) continue;
        const lines = elText(row)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        const name = lines[0] || "";
        if (!name || ctrlRe.test(name)) continue;
        const exists = items.some(
          (x) =>
            x.name.toLowerCase() === name.toLowerCase() ||
            x.id.toLowerCase() === name.toLowerCase(),
        );
        if (!exists && !seen.has(name.toLowerCase())) {
          seen.add(name.toLowerCase());
          items.push({
            id: name,
            name,
            description: lines.slice(1).join(" - ") || null,
            _raw: null,
          });
        }
      }
    }
    return items;
  }

  const action = String(req?.action || "").toLowerCase();

  if (action === "list_voices") {
    const { voices: compVoices } = await waitForComponentVoices(35);
    if (compVoices.length > 0) {
      return {
        ok: true,
        voices: compVoices.map(({ id, name, description }) => ({
          id,
          name,
          description,
        })),
      };
    }
    const opened = await openVoiceModal();
    const voices = opened ? await scrapeVoices() : [];
    await dismissOverlay();
    if (!opened || voices.length === 0) {
      return { ok: false, error: "voice_picker_not_available" };
    }
    return {
      ok: true,
      voices: voices.map(({ id, name, description }) => ({
        id,
        name,
        description,
      })),
    };
  }

  if (action === "set_voice") {
    const charId = req?.character_id ? String(req.character_id).trim() : null;
    const want = String(req?.voice || "").trim().toLowerCase();
    if (!want) {
      return { ok: true, applied: [] };
    }

    const { comp, voices: compVoices } = await waitForComponentVoices(35);
    const findVoice = (
      list: NormalizedVoiceItem[],
      exact: boolean,
    ): NormalizedVoiceItem | undefined =>
      list.find((v) => {
        const nm = (v.name || "").trim().toLowerCase();
        const vid = (v.id || "").trim().toLowerCase();
        const shortVid = vid.replace(/^voices\//i, "");
        return exact
          ? nm === want || vid === want || shortVid === want
          : nm.includes(want) || vid.includes(want) || shortVid.includes(want);
      });
    const matchedComp =
      findVoice(compVoices, true) || findVoice(compVoices, false);
    if (
      matchedComp?._raw &&
      typeof comp?.Kna?.set === "function" &&
      typeof comp?.zZ?.set === "function" &&
      typeof comp?.p$?.emit === "function"
    ) {
      for (let i = 0; i < 20; i++) {
        if (typeof comp.yb !== "function" || !comp.yb()) break;
        await delay(100);
      }
      comp.Kna.set(matchedComp._raw);
      comp.zZ.set(matchedComp.id);
      comp.p$.emit(matchedComp.id);
      await delay(700);
      return { ok: true, id: charId, applied: ["voice"] };
    }

    const opened = await openVoiceModal();
    if (!opened) {
      return { ok: false, error: "voice_picker_not_available", id: charId };
    }
    const overlay =
      document.querySelector('cdk-overlay-pane, [role="dialog"]') || document;
    const ctrlRe =
      /^(?:select a voice|add to character|close|cancel|done|search|clear search)$/i;
    const assetItems = Array.from(
      overlay.querySelectorAll("flow-add-menu-asset-item"),
    );
    const findAssetItem = (exact: boolean): Element | undefined =>
      assetItems.find((item) => {
        const nm = elText(item.querySelector(".asset-title")).toLowerCase();
        return Boolean(nm) && (exact ? nm === want : nm.includes(want));
      });
    const matchedAssetItem = findAssetItem(true) || findAssetItem(false);
    let matchedTarget: Element | null = matchedAssetItem
      ? matchedAssetItem.closest("button") || matchedAssetItem
      : null;
    if (!matchedTarget) {
      const candidates = Array.from(
        overlay.querySelectorAll(
          '[class*="voice-card"], [role="option"], [role="menuitem"], button, [class*="item"], [class*="tile"], [class*="card"]',
        ),
      ).filter((el) => {
        if (!isVisibleEnabled(el)) return false;
        const firstLine =
          elText(el)
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)[0] || "";
        return Boolean(firstLine) && !ctrlRe.test(firstLine);
      });
      const findOverlayCard = (exact: boolean): Element | undefined =>
        candidates.find((card) => {
          const nm = (
            elText(card.querySelector(".asset-title")) ||
            elText(card.querySelector(".voice-card-name")) ||
            elText(card).split(/\r?\n/)[0] ||
            ""
          )
            .trim()
            .toLowerCase();
          return exact ? nm === want : nm.includes(want);
        });
      matchedTarget = findOverlayCard(true) || findOverlayCard(false) || null;
    }
    if (!matchedTarget) {
      const scraped = await scrapeVoices();
      const available = scraped.map((v) => v.name);
      await dismissOverlay();
      return {
        ok: false,
        error: `voice_not_found:${req.voice}`,
        available_voices: available,
      };
    }
    const selectBtn =
      matchedTarget.querySelector(".voice-card-start-btn") || matchedTarget;
    if (selectBtn instanceof HTMLElement) {
      selectBtn.click();
    }
    await delay(250);
    clickButtonByRegex(
      /^(?:add to character|done|apply|confirm|select)$/i,
      overlay,
    );
    await delay(600);
    await dismissOverlay();
    return { ok: true, id: charId, applied: ["voice"] };
  }

  return { ok: false, error: `unknown_voice_op:${action}` };
}
