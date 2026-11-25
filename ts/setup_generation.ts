// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Configure Google Flow generation mode, settings, model, aspect ratio, and count.

import { resolveLView, withLViewMapCapture } from "./angular";
import {
  closeModelMenu,
  closeSettingsAndMenus,
  ensureManualComposer,
  findLiveBasePromptBox,
  findProjectPageInstance,
  findPromptBoxHost,
  settingsOpen,
} from "./composer";
import { delay, elText, hoverProbe, isVisibleEnabled } from "./dom";
import { isEditContext } from "./edit_composer";
import { runtimeState } from "./state";
import type { GenerationConfig, NgLView } from "./types";

/** Escapes regular expression metacharacters in literal labels. */
function escapeRegex(s: unknown): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Walks up from `tb` to locate the enclosing composer panel container. */
function findComposerRoot(tb: Element | null): ParentNode {
  if (!tb) return document;
  let cur: Element | null = tb.parentElement;
  for (let i = 0; i < 6 && cur; i++) {
    if (
      cur.querySelector('button[disabled], button:not([disabled]), [role="tab"]') &&
      cur.getBoundingClientRect().height >= 80
    ) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return document;
}

/** Finds and clicks a visible option button matching `regex` inside `scopeRoot`. */
function clickByText(
  regex: RegExp,
  scopeRoot: ParentNode,
  allowDocFallback = true,
): boolean {
  const searchRoots: ParentNode[] =
    scopeRoot && scopeRoot !== document
      ? allowDocFallback
        ? [scopeRoot, document]
        : [scopeRoot]
      : [document];
  const interactiveSel =
    'button, [role="tab"], [role="option"], [role="menuitem"], [role="radio"]';
  const isExcludedButton = (el: Element): boolean => {
    const aria = (el.getAttribute("aria-label") || "").trim();
    return aria === "Select model family" || aria === "Settings trigger";
  };
  for (const root of searchRoots) {
    const els = Array.from(
      root.querySelectorAll(
        'button, [role="tab"], [role="option"], [role="menuitem"], [role="radio"], .model-select-option',
      ),
    );
    const hit = els.find((el): el is HTMLElement => {
      if (!isVisibleEnabled(el) || isExcludedButton(el)) return false;
      if (!el.matches(interactiveSel)) {
        const inner = el.querySelector(interactiveSel);
        if (inner && (!isVisibleEnabled(inner) || isExcludedButton(inner))) {
          return false;
        }
      }
      const aria = (el.getAttribute("aria-label") || "").trim();
      const raw = elText(el);
      const tail =
        raw
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
          .pop() || "";
      return regex.test(aria) || regex.test(raw) || regex.test(tail);
    });
    if (hit) {
      const targetBtn = hit.matches(interactiveSel)
        ? hit
        : Array.from(hit.querySelectorAll(interactiveSel)).find(
            (b): b is HTMLElement => isVisibleEnabled(b) && !isExcludedButton(b),
          ) || hit;
      targetBtn.click();
      return true;
    }
  }
  return false;
}

/** Clicks a settings control matching `regex` within the labeled group container. */
function clickInsideGroup(
  groupLabel: string,
  regex: RegExp,
  scopeRoot: ParentNode,
): boolean {
  const settingsRoot =
    document.querySelector(
      "flow-prompt-box-settings, .settings-content-overlay",
    ) || document;
  const group =
    settingsRoot.querySelector(`[aria-label="${groupLabel}"]`) ||
    settingsRoot.querySelector(`[aria-label*="${groupLabel}" i]`) ||
    document.querySelector(`[aria-label="${groupLabel}"]`) ||
    document.querySelector(`[aria-label*="${groupLabel}" i]`);
  if (group && clickByText(regex, group, false)) {
    return true;
  }
  return clickByText(regex, scopeRoot, false);
}

/** Finds the duration range input inside `roots` for `"Length"` or `"Extend Length"`. */
function findDurationRangeInput(roots: ParentNode[]): HTMLInputElement | null {
  const selectors = [
    'flow-duration-slider input[type="range"][aria-label="Length" i]',
    'flow-duration-slider input[type="range"][aria-label="Extend Length" i]',
    'input[type="range"][aria-label="Length" i]',
    'input[type="range"][aria-label="Extend Length" i]',
    'flow-duration-slider input[type="range"]',
  ];
  for (const sel of selectors) {
    for (const root of roots) {
      const match = root.querySelector(sel);
      if (match instanceof HTMLInputElement) return match;
    }
  }
  return null;
}

/** Reads visible or text content from `node` for duration label parsing. */
function readDurationContainerText(node: ParentNode): string {
  if (node instanceof HTMLElement) {
    return node.innerText || node.textContent || "";
  }
  return node.textContent || document.body?.innerText || document.body?.textContent || "";
}

/** Sets the video length slider of the Flow settings panel to `secs` seconds, and returns true when the slider accepts the value. */
async function setLengthSlider(secs: number, scopeRoot: ParentNode): Promise<boolean> {
  const overlay = document.querySelector(
    "flow-prompt-box-settings, .settings-content-overlay",
  );
  const roots = overlay && overlay !== scopeRoot ? [overlay, scopeRoot] : [overlay || scopeRoot];
  const input = findDurationRangeInput(roots);
  if (!input) return false;
  const min = Number(input.min);
  const max = Number(input.max);
  const rawStep = Number(input.step);
  const step = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : 1;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min || (max - min) / step > 120) {
    return false;
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) return false;

  const slider = input.closest("flow-duration-slider");
  const container: ParentNode = overlay || scopeRoot;
  const readShownSecs = (): number | null => {
    if (slider) {
      const m = /\b(\d+)\s*Sec\b/i.exec(readDurationContainerText(slider));
      if (m) return Number(m[1]);
    }
    const m = /(?:Extend\s+)?Length\s*(\d+)\s*Sec\b/i.exec(
      readDurationContainerText(container),
    );
    return m ? Number(m[1]) : null;
  };
  const applyValue = (val: string): void => {
    setter.call(input, val);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const prior = input.value;
  const initialSecs = readShownSecs();
  if (initialSecs === null) return false;
  if (initialSecs === secs) {
    applyValue(prior);
    return true;
  }

  const intSteps = Number.isInteger(min) && Number.isInteger(step);
  for (let idx = min; idx <= max + 1e-9; idx += step) {
    const candidate = String(intSteps ? Math.round(idx) : idx);
    applyValue(candidate);
    await delay(40);
    if (readShownSecs() === secs) {
      return true;
    }
  }

  applyValue(prior);
  return false;
}

/** Ensures `runtimeState.ngLViewMap` is populated via non-destructive hover or settings probes. */
async function ensureLViewCapture(allowSettingsClick = false): Promise<void> {
  const hasLViewMap = (): boolean => runtimeState.ngLViewMap instanceof Map;
  if (hasLViewMap()) {
    return;
  }
  await withLViewMapCapture(async () => {
    const sel =
      "[mattooltip], [cdkoverlayorigin], button[aria-label], flow-agent-mode-toggle-chip button, flow-prompt-box, flow-project-page";
    const all = Array.from(document.querySelectorAll(sel));
    const visible = all.filter((el) => el.getClientRects().length > 0);
    const tipEls = (visible.length > 0 ? visible : all).slice(0, 12);
    await hoverProbe(tipEls, 60);
  });
  if (hasLViewMap()) {
    return;
  }
  if (allowSettingsClick) {
    const sBtn = document.querySelector(
      'flow-prompt-box button[aria-label="Settings trigger"], button[aria-label="Settings trigger"]',
    );
    if (isVisibleEnabled(sBtn) && !settingsOpen()) {
      await withLViewMapCapture(async () => {
        sBtn.click();
        await delay(140);
      });
    }
  }
}

/** Configures generation mode, video type, aspect ratio, output count, duration, resolution, and model. */
export async function setupGeneration(
  cfg: GenerationConfig,
): Promise<{ ok: boolean; error?: string }> {
  const onEditPage = isEditContext(cfg.edit);

  if (!onEditPage) {
    const textbox = await ensureManualComposer();
    if (!textbox) return { ok: false, error: "manual_prompt_not_ready" };
    await ensureLViewCapture(true);

    const settingsBtn = document.querySelector(
      'flow-prompt-box button[aria-label="Settings trigger"], button[aria-label="Settings trigger"]',
    );
    const scope = findComposerRoot(textbox);

    if (isVisibleEnabled(settingsBtn) && !settingsOpen()) {
      await withLViewMapCapture(async () => {
        settingsBtn.click();
        await delay(180);
      });
    }

    const settingsScope = (): ParentNode =>
      document.querySelector(
        "flow-prompt-box-settings, .settings-content-overlay",
      ) || scope;
    const mode = String(cfg.mode || "video").toLowerCase();
    if (mode === "image" || mode === "character" || mode === "scene") {
      clickInsideGroup(
        "Mode",
        /\b(image|images|create image)\b/i,
        settingsScope(),
      );
    } else {
      clickInsideGroup(
        "Mode",
        /\b(video|videos|create video)\b/i,
        settingsScope(),
      );
    }
    await delay(140);

    try {
      if (cfg.video_type && mode === "video") {
        const vt = String(cfg.video_type).trim();
        const vtRe = /ingredient/i.test(vt)
          ? /\bingredients?\b/i
          : /\bframes?\b/i;
        if (clickInsideGroup("Video type", vtRe, settingsScope())) {
          await delay(120);
        }
      }
    } catch {
      // Optional video_type control may not be rendered.
    }

    try {
      if (cfg.aspect) {
        const a = String(cfg.aspect).trim();
        const aspectRe =
          a === "16:9"
            ? /\b16:9\b|\blandscape\b/i
            : a === "9:16"
              ? /\b9:16\b|\bportrait\b/i
              : a === "1:1"
                ? /\b1:1\b|\bsquare\b/i
                : new RegExp(escapeRegex(a), "i");
        if (clickInsideGroup("Aspect ratio", aspectRe, settingsScope())) {
          await delay(120);
        }
      }
    } catch {
      // Optional aspect ratio control may be unavailable.
    }

    try {
      if (cfg.count != null) {
        const n = escapeRegex(String(cfg.count));
        const countRe = new RegExp(
          `^(?:${n}|x${n}|${n}x|${n}\\s*(?:outputs?|results?|images?|videos?))$`,
          "i",
        );
        if (clickInsideGroup("Output count", countRe, settingsScope())) {
          await delay(120);
        }
      }
    } catch {
      // Optional output count control may be unavailable.
    }

    try {
      if (cfg.duration && mode === "video") {
        const rawDur = String(cfg.duration).replace(/s$/i, "").trim();
        const secs = Number.parseInt(rawDur, 10);
        const curScope = settingsScope();
        if (Number.isFinite(secs) && await setLengthSlider(secs, curScope)) {
          await delay(160);
        } else {
          const d = escapeRegex(rawDur);
          const hasDurGroup = Boolean(
            document.querySelector('[aria-label*="Video duration" i]'),
          );
          const durRe = hasDurGroup
            ? new RegExp(`\\b${d}\\s*s\\b|\\b${d}\\b`, "i")
            : new RegExp(`\\b${d}\\s*(?:s|sec)\\b`, "i");
          if (clickInsideGroup("Video duration", durRe, curScope)) {
            await delay(120);
          }
        }
      }
    } catch {
      // Optional duration control may be unavailable.
    }

    try {
      if (cfg.resolution && mode === "video") {
        const rRe = new RegExp(escapeRegex(String(cfg.resolution).trim()), "i");
        if (clickInsideGroup("Video resolution", rRe, settingsScope())) {
          await delay(120);
        }
      }
    } catch {
      // Optional resolution control may be unavailable.
    }

    try {
      if (cfg.model) {
        const flexPattern = escapeRegex(String(cfg.model).trim()).replace(
          /[-_\s]+/g,
          "[\\s\\-_]*",
        );
        const modelRe = new RegExp(flexPattern, "i");
        const familyBtn = document.querySelector(
          'button[aria-label="Select model family"]',
        );
        if (isVisibleEnabled(familyBtn)) {
          familyBtn.click();
          let pickerPane: Element | null = null;
          for (let w = 0; w < 8; w += 1) {
            await delay(50);
            pickerPane =
              document.querySelector(".flow-model-picker-panel") ||
              Array.from(document.querySelectorAll(".cdk-overlay-pane"))
                .reverse()
                .find(
                  (p) =>
                    !p.querySelector(".mdc-tooltip") && !p.contains(familyBtn),
                ) ||
              null;
            if (pickerPane) break;
          }
          if (pickerPane) {
            clickByText(modelRe, pickerPane, false);
          }
          await delay(120);
          await closeModelMenu();
        } else if (clickByText(modelRe, settingsScope(), false)) {
          await delay(120);
        }
      }
    } catch {
      // Optional model selector may differ by mode.
    }

    try {
      // Some models show the resolution toggle and the length slider only after the model changes.
      if (mode === "video" && cfg.model) {
        if (cfg.resolution) {
          const rRe = new RegExp(escapeRegex(String(cfg.resolution).trim()), "i");
          if (clickInsideGroup("Video resolution", rRe, settingsScope())) {
            await delay(120);
          }
        }
        if (cfg.duration) {
          const secs = Number.parseInt(String(cfg.duration).replace(/s$/i, ""), 10);
          if (Number.isFinite(secs) && await setLengthSlider(secs, settingsScope())) {
            await delay(160);
          }
        }
      }
    } catch {
      // Optional resolution and length controls may be unavailable.
    }

    try {
      const liveUx = findLiveBasePromptBox(
        false,
        findPromptBoxHost(findProjectPageInstance()),
      );
      const curMode = String(liveUx?.Qa?.config?.mode?.() || "");
      const wantImageMode =
        mode === "image" || mode === "character" || mode === "scene";
      if (wantImageMode && curMode && curMode !== "IMAGE") {
        clickInsideGroup("Mode", /\bimage\b/i, settingsScope());
        await delay(140);
      } else if (!wantImageMode && curMode && !curMode.startsWith("VIDEO")) {
        clickInsideGroup("Mode", /\bvideo\b/i, settingsScope());
        await delay(140);
        if (cfg.video_type) {
          const vt = String(cfg.video_type).trim();
          const vtRe = /ingredient/i.test(vt)
            ? /\bingredients?\b/i
            : /\bframes?\b/i;
          if (clickInsideGroup("Video type", vtRe, settingsScope())) {
            await delay(120);
          }
        }
      }
      if (
        cfg.count != null &&
        typeof liveUx?.Qa?.config?.outputCount === "function" &&
        Number(liveUx.Qa.config.outputCount()) !== Number(cfg.count)
      ) {
        const settingsEl = document.querySelector("flow-prompt-box-settings");
        if (settingsEl) {
          let lv: NgLView | null = resolveLView(settingsEl);
          for (let d = 0; d < 4 && Array.isArray(lv); d += 1) {
            const iw = lv.find(
              (
                c,
              ): c is {
                Osa?: (count: number) => void;
                Ula?: (count: number) => void;
              } =>
                Boolean(
                  c &&
                    typeof c === "object" &&
                    !(c instanceof Node) &&
                    (typeof (c as { Osa?: unknown }).Osa === "function" ||
                      typeof (c as { Ula?: unknown }).Ula === "function"),
                ),
            );
            if (iw) {
              if (typeof iw.Osa === "function") {
                iw.Osa(Number(cfg.count));
              } else if (typeof iw.Ula === "function") {
                iw.Ula(Number(cfg.count));
              }
              await delay(100);
              break;
            }
            lv = Array.isArray(lv[3])
              ? lv[3]
              : Array.isArray(lv[15])
                ? lv[15]
                : null;
          }
        }
      }
    } catch {
      // Ignore non-fatal post-settings sync check.
    }

    if (settingsOpen()) {
      await closeSettingsAndMenus();
    }
  }

  return { ok: true };
}
