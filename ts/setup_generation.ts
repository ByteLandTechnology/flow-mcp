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
import { runtimeState } from "./state";
import type { GenerationConfig, NgLView, PromptStateController } from "./types";

/** Aspect ratio label-to-enum table matching `SKb` / `_.OE` in Google Flow. */
const SKB_ASPECT_RATIO_MAP: Readonly<Record<string, string>> = {
  "8:1": "LANDSCAPE_8_1",
  "4:1": "LANDSCAPE_4_1",
  "21:9": "ULTRAWIDE",
  "16:9": "LANDSCAPE",
  "3:2": "LANDSCAPE_3_2",
  "4:3": "LANDSCAPE_4_3",
  "5:4": "LANDSCAPE_5_4",
  "1:1": "SQUARE",
  "4:5": "PORTRAIT_4_5",
  "3:4": "PORTRAIT_3_4",
  "2:3": "PORTRAIT_2_3",
  "9:16": "PORTRAIT",
  "1:4": "PORTRAIT_1_4",
  "1:8": "PORTRAIT_1_8",
};

/** Reverse lookup of valid `SKb` aspect ratio enum values. */
const SKB_ASPECT_ENUM_VALUES: ReadonlySet<string> = new Set(
  Object.values(SKB_ASPECT_RATIO_MAP),
);

/** Canonical display name and family ID pair for known Google Flow models. */
interface ModelFamilyAlias {
  /** Primary label rendered in `Select model family`. */
  readonly displayName: string;
  /** Family ID stored on `Qa.model` (`hg` / `ala`). */
  readonly hg: string;
}

/** Legacy model slugs and family IDs mapped to live `Select model family` names. */
const MODEL_FAMILY_ALIASES: Readonly<Record<string, ModelFamilyAlias>> = {
  veo_3_1_fast: { displayName: "Veo 3.1 Lite", hg: "veo_3_1_lite" },
  veo_3_1_lite: { displayName: "Veo 3.1 Lite", hg: "veo_3_1_lite" },
  veo_3_1: { displayName: "Veo 3.1", hg: "veo_3_1" },
  veo_3_1_quality: { displayName: "Veo 3.1", hg: "veo_3_1" },
  veo_3_fast: { displayName: "Veo 3 Fast", hg: "veo_3_fast" },
  veo_3: { displayName: "Veo 3", hg: "veo_3" },
  veo_2: { displayName: "Veo 2", hg: "veo_2" },
  veo_2_fast: { displayName: "Veo 2", hg: "veo_2" },
  veo_2_quality: { displayName: "Veo 2", hg: "veo_2" },
  gemini_omni: { displayName: "Gemini Omni", hg: "macaron_cookie" },
  macaron_cookie: { displayName: "Gemini Omni", hg: "macaron_cookie" },
  nano_banana: { displayName: "Nano Banana", hg: "nano_banana" },
  nano_banana_2: { displayName: "Nano Banana 2", hg: "nano_banana_2" },
  nano_banana_pro: { displayName: "Nano Banana Pro", hg: "nano_banana_pro" },
  imagen_3: { displayName: "Imagen 3", hg: "imagen_3" },
  imagen_4: { displayName: "Imagen 4", hg: "imagen_4" },
};

/** Escapes regular expression metacharacters in literal labels. */
function escapeRegex(s: unknown): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalizes a model string into an underscore-separated lookup key. */
function modelAliasKey(raw: string): string {
  return raw
    .trim()
    .split(/[\s\-_.]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase())
    .join("_");
}

/** Builds anchored `^...$` matchers for model `displayName` and `hg` values. */
function buildModelMatchers(rawModel: string): {
  displayName: string;
  expectedHg: string | null;
  labelRe: RegExp;
  hgRe: RegExp;
} {
  const trimmed = rawModel.trim();
  const alias = MODEL_FAMILY_ALIASES[modelAliasKey(trimmed)];
  const displayName = alias ? alias.displayName : trimmed;
  const flexLabel = escapeRegex(displayName).replace(/[-_\s]+/g, "[\\s\\-_]*");
  const labelRe = new RegExp(`^${flexLabel}$`, "i");
  const hgPattern = alias
    ? `^${escapeRegex(alias.hg)}$`
    : `^(?:${flexLabel}|${escapeRegex(modelAliasKey(trimmed))})$`;
  return {
    displayName,
    expectedHg: alias ? alias.hg : null,
    labelRe,
    hgRe: new RegExp(hgPattern, "i"),
  };
}

/** Resolves a requested aspect ratio string against `SKb` (`SKB_ASPECT_RATIO_MAP`). */
function resolveExpectedAspect(rawAspect: string): {
  enumValue: string | null;
  toggleRe: RegExp;
} {
  const trimmed = rawAspect.trim();
  const direct = SKB_ASPECT_RATIO_MAP[trimmed];
  if (direct) {
    const toggleRe =
      trimmed === "16:9"
        ? /^(?:16:9|landscape)$/i
        : trimmed === "9:16"
          ? /^(?:9:16|portrait)$/i
          : trimmed === "1:1"
            ? /^(?:1:1|square)$/i
            : new RegExp(`^(?:${escapeRegex(trimmed)}|${escapeRegex(direct)})$`, "i");
    return { enumValue: direct, toggleRe };
  }
  const upper = trimmed.toUpperCase();
  if (upper === "LANDSCAPE") {
    return { enumValue: "LANDSCAPE", toggleRe: /^(?:16:9|landscape)$/i };
  }
  if (upper === "PORTRAIT") {
    return { enumValue: "PORTRAIT", toggleRe: /^(?:9:16|portrait)$/i };
  }
  if (upper === "SQUARE") {
    return { enumValue: "SQUARE", toggleRe: /^(?:1:1|square)$/i };
  }
  if (SKB_ASPECT_ENUM_VALUES.has(upper)) {
    const pair = Object.entries(SKB_ASPECT_RATIO_MAP).find(([, v]) => v === upper);
    const lbl = pair ? pair[0] : trimmed;
    return {
      enumValue: upper,
      toggleRe: new RegExp(`^(?:${escapeRegex(lbl)}|${escapeRegex(upper)})$`, "i"),
    };
  }
  return {
    enumValue: null,
    toggleRe: new RegExp(`^${escapeRegex(trimmed)}$`, "i"),
  };
}

/** Resolves the active `PromptStateController` (`Qa`) from the project composer. */
function resolvePromptState(): PromptStateController | null {
  const projPage = findProjectPageInstance();
  const liveUx = findLiveBasePromptBox(false, findPromptBoxHost(projPage));
  return liveUx?.Qa ?? projPage?.Qa ?? runtimeState.promptState ?? null;
}

/** Reads the model picker option array from `Qa.model.Wqa()` or `Qa.model.Yqa()`. */
function readModelOptions(qa: PromptStateController | null): ReadonlyArray<{
  readonly hg?: string;
  readonly displayName?: string;
  readonly isDisabled?: boolean;
}> | null {
  const opts = qa?.model?.Wqa?.() ?? qa?.model?.Yqa?.();
  return Array.isArray(opts) ? opts : null;
}

/** Reads the active model family identifier from `Qa.model.ala()` or `Qa.model.cla()`. */
function readActiveModelId(qa: PromptStateController | null): string {
  const id =
    qa?.model?.ala?.() ?? qa?.model?.cla?.() ?? qa?.model?.family?.()?.id ?? "";
  return typeof id === "string" ? id.trim() : "";
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
    if (el.closest("flow-menu-item-actions")) return true;
    const aria = (el.getAttribute("aria-label") || "").trim();
    return aria === "Select model family" || aria === "Settings trigger";
  };
  const isDisabledMenuItem = (menuItem: Element): boolean => {
    const attr = menuItem.getAttribute("disabled");
    if (attr === "true" || (attr !== null && attr !== "false")) return true;
    if (menuItem.getAttribute("aria-disabled") === "true") return true;
    const innerBtn = menuItem.querySelector(
      ".flow-internal-menu-item, .flow-internal-menu-item-link, button",
    );
    return Boolean(innerBtn && !isVisibleEnabled(innerBtn));
  };
  for (const root of searchRoots) {
    const els = Array.from(
      root.querySelectorAll(
        'flow-menu-item, .model-select-option, button, [role="tab"], [role="option"], [role="menuitem"], [role="menuitemradio"], [role="radio"]',
      ),
    );
    const hit = els.find((el): el is HTMLElement => {
      if (!isVisibleEnabled(el) || isExcludedButton(el)) return false;
      const menuItem = el.matches("flow-menu-item, .model-select-option")
        ? el
        : el.closest("flow-menu-item, .model-select-option");
      if (menuItem) {
        if (isDisabledMenuItem(menuItem)) return false;
        const labelNode = menuItem.querySelector(".label");
        const primaryLabel = (
          (labelNode ? elText(labelNode) : "") ||
          menuItem.getAttribute("label") ||
          ""
        ).trim();
        const menuAria = (
          el.getAttribute("aria-label") ||
          menuItem.getAttribute("aria-label") ||
          ""
        ).trim();
        if (primaryLabel) {
          return (
            regex.test(primaryLabel) || (menuAria.length > 0 && regex.test(menuAria))
          );
        }
      }
      if (!el.matches(interactiveSel)) {
        const inner = el.querySelector(interactiveSel);
        if (inner && (!isVisibleEnabled(inner) || isExcludedButton(inner))) {
          return false;
        }
      }
      const aria = (el.getAttribute("aria-label") || "").trim();
      const toggleNode = el.querySelector(".toggle-text");
      const toggleLabel = toggleNode ? elText(toggleNode).trim() : "";
      const raw = elText(el);
      const tail =
        raw
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
          .pop() || "";
      return (
        (toggleLabel.length > 0 && regex.test(toggleLabel)) ||
        (aria.length > 0 && regex.test(aria)) ||
        regex.test(raw) ||
        regex.test(tail)
      );
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
  const onEditPage = /\/edit\//.test(location.pathname || "");

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
    const wantImageMode =
      mode === "image" || mode === "character" || mode === "scene";
    const effectiveVideoType = !wantImageMode
      ? String(cfg.video_type || "ingredients").trim().toLowerCase()
      : "";
    const wantVideoIngredients =
      !wantImageMode && !/^(?:frames?|video[\s_-]*frames?)$/i.test(effectiveVideoType);

    if (wantImageMode) {
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
      if (!wantImageMode) {
        const qaMode = String(resolvePromptState()?.config?.mode?.() || "");
        const needsSwitch = wantVideoIngredients
          ? !qaMode || qaMode === "VIDEO_FRAMES" || Boolean(cfg.video_type)
          : qaMode !== "VIDEO_FRAMES";
        if (needsSwitch) {
          const vtRe = wantVideoIngredients
            ? /^(?:ingredients?|video[\s_-]*ingredients?)$/i
            : /^(?:frames?|video[\s_-]*frames?)$/i;
          if (clickInsideGroup("Video type", vtRe, settingsScope())) {
            await delay(120);
          }
        }
      }
    } catch {
      // Optional video_type control may not be rendered.
    }

    const rawAspect = cfg.aspect != null ? String(cfg.aspect).trim() : "";
    const aspectSpec = rawAspect ? resolveExpectedAspect(rawAspect) : null;
    if (aspectSpec) {
      if (
        !aspectSpec.enumValue ||
        (!wantImageMode && aspectSpec.enumValue === "SQUARE")
      ) {
        if (settingsOpen()) {
          await closeSettingsAndMenus();
        }
        return { ok: false, error: "unsupported_aspect_ratio" };
      }
      try {
        if (clickInsideGroup("Aspect ratio", aspectSpec.toggleRe, settingsScope())) {
          await delay(120);
        }
      } catch {
        // Optional aspect ratio control may be unavailable.
      }
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

    const rawModel = cfg.model != null ? String(cfg.model).trim() : "";
    const modelSpec = rawModel ? buildModelMatchers(rawModel) : null;
    let hadModelPickerItems = false;
    let clickedModelItem = false;
    try {
      if (modelSpec) {
        const preQa = resolvePromptState();
        const preOptions = readModelOptions(preQa);
        const matchedOption = preOptions?.find((opt) => {
          const disp = String(opt?.displayName || "").trim();
          const hg = String(opt?.hg || "").trim();
          return modelSpec.labelRe.test(disp) || modelSpec.hgRe.test(hg);
        });
        const exactDisplay = String(matchedOption?.displayName || "").trim();
        const menuRe = exactDisplay
          ? new RegExp(`^${escapeRegex(exactDisplay)}$`, "i")
          : modelSpec.labelRe;
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
            hadModelPickerItems =
              pickerPane.querySelectorAll(
                'flow-menu-item, .model-select-option, [role="menuitem"], [role="option"]',
              ).length > 0;
            clickedModelItem =
              clickByText(menuRe, pickerPane, false) ||
              (menuRe !== modelSpec.labelRe &&
                clickByText(modelSpec.labelRe, pickerPane, false)) ||
              clickByText(modelSpec.hgRe, pickerPane, false);
          }
          await delay(120);
          await closeModelMenu();
        } else if (
          clickByText(menuRe, settingsScope(), false) ||
          clickByText(modelSpec.hgRe, settingsScope(), false)
        ) {
          clickedModelItem = true;
          await delay(120);
        }
      }
    } catch {
      // Optional model selector may differ by mode.
    }

    try {
      // Some models show the resolution toggle and the length slider only after the model changes.
      if (!wantImageMode && modelSpec) {
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
      let qa = resolvePromptState();
      let curMode = String(qa?.config?.mode?.() || "");
      if (wantImageMode && curMode && curMode !== "IMAGE") {
        clickInsideGroup("Mode", /\bimage\b/i, settingsScope());
        await delay(140);
      } else if (!wantImageMode) {
        if (curMode && !curMode.startsWith("VIDEO")) {
          clickInsideGroup("Mode", /\bvideo\b/i, settingsScope());
          await delay(140);
          qa = resolvePromptState();
          curMode = String(qa?.config?.mode?.() || "");
        }
        if (wantVideoIngredients && curMode === "VIDEO_FRAMES") {
          if (
            clickInsideGroup(
              "Video type",
              /^(?:ingredients?|video[\s_-]*ingredients?)$/i,
              settingsScope(),
            )
          ) {
            await delay(120);
          }
        } else if (!wantVideoIngredients && curMode && curMode !== "VIDEO_FRAMES") {
          if (
            clickInsideGroup(
              "Video type",
              /^(?:frames?|video[\s_-]*frames?)$/i,
              settingsScope(),
            )
          ) {
            await delay(120);
          }
        }
      }
      if (
        aspectSpec?.enumValue &&
        typeof qa?.config?.aspectRatio === "function" &&
        String(qa.config.aspectRatio() || "") !== aspectSpec.enumValue
      ) {
        if (clickInsideGroup("Aspect ratio", aspectSpec.toggleRe, settingsScope())) {
          await delay(120);
        }
      }
      const liveUx = findLiveBasePromptBox(
        false,
        findPromptBoxHost(findProjectPageInstance()),
      );
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

    const verifiedQa = resolvePromptState();
    if (aspectSpec?.enumValue && typeof verifiedQa?.config?.aspectRatio === "function") {
      const actualAspect = String(verifiedQa.config.aspectRatio() || "").trim();
      if (actualAspect && actualAspect !== aspectSpec.enumValue) {
        if (settingsOpen()) {
          await closeSettingsAndMenus();
        }
        return { ok: false, error: "unsupported_aspect_ratio" };
      }
    }

    if (modelSpec) {
      const postOptions = readModelOptions(verifiedQa);
      const activeId = readActiveModelId(verifiedQa);
      const activeFamilyName = String(
        verifiedQa?.model?.family?.()?.displayName || "",
      ).trim();
      let modelVerified = true;
      if (postOptions && postOptions.length > 0) {
        const matchedOpt = postOptions.find((opt) => {
          const disp = String(opt?.displayName || "").trim();
          const hg = String(opt?.hg || "").trim();
          return modelSpec.labelRe.test(disp) || modelSpec.hgRe.test(hg);
        });
        if (!matchedOpt || matchedOpt.isDisabled === true) {
          modelVerified = false;
        } else if (activeId) {
          const targetHg = String(matchedOpt.hg || "").trim();
          if (
            targetHg
              ? activeId !== targetHg
              : !modelSpec.hgRe.test(activeId) && !modelSpec.labelRe.test(activeId)
          ) {
            modelVerified = false;
          }
        }
      } else if (activeId) {
        if (
          !modelSpec.hgRe.test(activeId) &&
          !modelSpec.labelRe.test(activeId) &&
          !(activeFamilyName && modelSpec.labelRe.test(activeFamilyName))
        ) {
          modelVerified = false;
        }
      } else if (hadModelPickerItems && !clickedModelItem) {
        modelVerified = false;
      }
      if (!modelVerified) {
        if (settingsOpen()) {
          await closeSettingsAndMenus();
        }
        return { ok: false, error: "unsupported_model" };
      }
    }

    if (settingsOpen()) {
      await closeSettingsAndMenus();
    }
  }

  return { ok: true };
}
