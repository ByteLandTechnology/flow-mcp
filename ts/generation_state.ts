// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Match and verify Google Flow generation model family and aspect ratio signals.

import { isLiveLView, resolveLView } from "./angular";
import {
  findLiveBasePromptBox,
  findProjectPageInstance,
  findPromptBoxHost,
} from "./composer";
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
  /** Family ID stored on `Qa.model` (`hg` / `ala` / `cla`). */
  readonly hg: string;
}

/** Known model slugs and family IDs mapped to their canonical display name and `hg` ID. */
const MODEL_FAMILY_ALIASES: Readonly<Record<string, ModelFamilyAlias>> = {
  veo_3_1_fast: { displayName: "Veo 3.1 Fast", hg: "veo_3_1_fast" },
  veo_3_1_lite: { displayName: "Veo 3.1 Lite", hg: "veo_3_1_lite" },
  veo_3_1: { displayName: "Veo 3.1", hg: "veo_3_1" },
  veo_3_1_quality: { displayName: "Veo 3.1 Quality", hg: "veo_3_1_quality" },
  veo_3_fast: { displayName: "Veo 3 Fast", hg: "veo_3_fast" },
  veo_3: { displayName: "Veo 3", hg: "veo_3" },
  veo_2: { displayName: "Veo 2", hg: "veo_2" },
  veo_2_fast: { displayName: "Veo 2 Fast", hg: "veo_2_fast" },
  veo_2_quality: { displayName: "Veo 2 Quality", hg: "veo_2_quality" },
  gemini_omni: { displayName: "Gemini Omni", hg: "macaron_cookie" },
  macaron_cookie: { displayName: "Gemini Omni", hg: "macaron_cookie" },
  nano_banana: { displayName: "Nano Banana", hg: "nano_banana" },
  nano_banana_2: { displayName: "Nano Banana 2", hg: "nano_banana_2" },
  nano_banana_pro: { displayName: "Nano Banana Pro", hg: "nano_banana_pro" },
  imagen_3: { displayName: "Imagen 3", hg: "imagen_3" },
  imagen_4: { displayName: "Imagen 4", hg: "imagen_4" },
};

/** Anchored regular expression matchers for a single model family. */
export interface ModelMatcher {
  /** Canonical display name for UI labels. */
  readonly displayName: string;
  /** Expected `hg` ID when known. */
  readonly expectedHg: string | null;
  /** Anchored `^...$` pattern for primary display labels. */
  readonly labelRe: RegExp;
  /** Anchored `^...$` pattern for `hg` identifiers. */
  readonly hgRe: RegExp;
}

/** Resolved `SKb` enum and UI toggle matcher for a requested aspect ratio. */
export interface AspectSpec {
  /** Expected `SKb` enum value, or null when unrecognized. */
  readonly enumValue: string | null;
  /** Anchored pattern matching the UI aspect ratio toggle button. */
  readonly toggleRe: RegExp;
}

/** Escapes regular expression metacharacters in literal labels. */
export function escapeRegex(s: unknown): string {
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
export function buildModelMatchers(rawModel: string): ModelMatcher {
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

/** Resolves explicit or ordered default model matchers for `cfg`. */
export function resolveCandidateModelSpecs(
  cfg: GenerationConfig,
  wantImageMode: boolean,
): ModelMatcher[] {
  const rawModel = cfg.model != null ? String(cfg.model).trim() : "";
  if (rawModel) {
    return [buildModelMatchers(rawModel)];
  }
  const rawDefaults = Array.isArray(cfg.default_models)
    ? cfg.default_models
        .map((m) => String(m || "").trim())
        .filter((m) => m.length > 0)
    : [];
  const defaults =
    rawDefaults.length > 0
      ? rawDefaults
      : wantImageMode
        ? ["Nano Banana 2"]
        : ["Veo 3.1 Lite", "Veo 3.1 Fast"];
  return defaults.map((m) => buildModelMatchers(m));
}

/** Resolves a requested aspect ratio string against `SKb` (`SKB_ASPECT_RATIO_MAP`). */
export function resolveExpectedAspect(rawAspect: string): AspectSpec {
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

/** Resolves the live `PromptStateController` (`Qa`) from connected project composer views. */
export function resolvePromptState(): PromptStateController | null {
  const projPage = findProjectPageInstance();
  const liveUx = findLiveBasePromptBox(false, findPromptBoxHost(projPage));
  if (liveUx?.Qa) {
    return liveUx.Qa;
  }
  if (projPage?.Qa) {
    return projPage.Qa;
  }
  const agentSel =
    "flow-agent-panel, .agent-panel-wrapper, flow-creative-agent-prompt-box";
  const isPromptState = (cand: unknown): cand is PromptStateController => {
    if (!cand || typeof cand !== "object" || cand instanceof Node) return false;
    const obj = cand as Partial<PromptStateController>;
    return Boolean(
      obj.config ||
        obj.model ||
        typeof obj.Gp === "function" ||
        typeof obj.Wn === "function",
    );
  };
  const scanLv = (lv: unknown): PromptStateController | null => {
    if (!Array.isArray(lv)) return null;
    for (const cand of lv) {
      if (!cand || typeof cand !== "object" || cand instanceof Node) continue;
      const qaProp = (cand as { Qa?: unknown }).Qa;
      if (isPromptState(qaProp)) return qaProp;
      if (isPromptState(cand)) return cand;
    }
    return null;
  };
  const seeds = [
    document.querySelector("flow-prompt-box flow-base-prompt-box"),
    document.querySelector("flow-prompt-box"),
    document.querySelector("flow-project-page"),
  ].filter((el): el is Element => Boolean(el && !el.closest(agentSel)));
  for (const seed of seeds) {
    let lv: NgLView | null = resolveLView(seed);
    for (let d = 0; d < 6 && Array.isArray(lv); d += 1) {
      const hit = scanLv(lv);
      if (hit) return hit;
      lv = Array.isArray(lv[3]) ? lv[3] : Array.isArray(lv[15]) ? lv[15] : null;
    }
  }
  if (runtimeState.ngLViewMap instanceof Map) {
    for (const lv of runtimeState.ngLViewMap.values()) {
      if (!isLiveLView(lv)) continue;
      if (lv[0] instanceof Element && lv[0].closest(agentSel)) continue;
      const hit = scanLv(lv);
      if (hit) return hit;
    }
  }
  return null;
}

/** Reads the model picker option array from `Qa.model.Wqa()` or `Qa.model.Yqa()`. */
export function readModelOptions(qa: PromptStateController | null): ReadonlyArray<{
  readonly hg?: string;
  readonly displayName?: string;
  readonly isDisabled?: boolean;
}> | null {
  try {
    const opts = qa?.model?.Wqa?.() ?? qa?.model?.Yqa?.();
    return Array.isArray(opts) ? opts : null;
  } catch {
    return null;
  }
}

/** Reads the active model family identifier from `Qa.model` signals. */
function readActiveModelId(
  qa: PromptStateController | null,
  wantImageMode: boolean,
): string {
  const pickNonEmpty = (fn?: () => string | undefined): string => {
    if (typeof fn !== "function") return "";
    try {
      const val = fn.call(qa?.model);
      return typeof val === "string" ? val.trim() : "";
    } catch {
      return "";
    }
  };
  const modeId = wantImageMode
    ? pickNonEmpty(qa?.model?.imageModelFamilyId)
    : pickNonEmpty(qa?.model?.videoModelFamilyId);
  let familyId = "";
  try {
    const fam = qa?.model?.family?.();
    const raw = fam?.id ?? fam?.hg ?? "";
    familyId = typeof raw === "string" ? raw.trim() : "";
  } catch {
    familyId = "";
  }
  return (
    pickNonEmpty(qa?.model?.ala) ||
    pickNonEmpty(qa?.model?.cla) ||
    modeId ||
    familyId
  );
}

/** Reads the active model family display name from `Qa.model.family()` when available. */
function readActiveModelFamilyName(qa: PromptStateController | null): string {
  try {
    const name = qa?.model?.family?.()?.displayName ?? "";
    return typeof name === "string" ? name.trim() : "";
  } catch {
    return "";
  }
}

/** Reads the active `SKb` aspect ratio enum string from `Qa.config.aspectRatio()`. */
function readActiveAspectRatio(qa: PromptStateController | null): string {
  try {
    const fn = qa?.config?.aspectRatio;
    if (typeof fn !== "function") return "";
    const val = fn.call(qa?.config);
    return typeof val === "string" ? val.trim() : "";
  } catch {
    return "";
  }
}

/** Returns true only when `Qa.config.aspectRatio()` is readable, valid for `wantImageMode`, and matches `aspectSpec`. */
export function verifyAspectState(
  qa: PromptStateController | null,
  wantImageMode: boolean,
  aspectSpec: AspectSpec | null,
): boolean {
  const actualAspect = readActiveAspectRatio(qa);
  if (!actualAspect || !SKB_ASPECT_ENUM_VALUES.has(actualAspect)) {
    return false;
  }
  if (!wantImageMode && actualAspect === "SQUARE") {
    return false;
  }
  if (aspectSpec) {
    return Boolean(aspectSpec.enumValue && actualAspect === aspectSpec.enumValue);
  }
  return true;
}

/** Returns true only when `Qa.model` exposes a readable active model matching `spec`. */
export function verifyModelSpec(
  qa: PromptStateController | null,
  wantImageMode: boolean,
  spec: ModelMatcher,
): boolean {
  if (!qa?.model) {
    return false;
  }
  const postOptions = readModelOptions(qa);
  const activeId = readActiveModelId(qa, wantImageMode);
  const activeFamilyName = readActiveModelFamilyName(qa);
  if (!activeId && !activeFamilyName) {
    return false;
  }
  if (postOptions !== null) {
    const matchedOpt = postOptions.find((opt) => {
      const disp = String(opt?.displayName || "").trim();
      const hg = String(opt?.hg || "").trim();
      return spec.labelRe.test(disp) || spec.hgRe.test(hg);
    });
    if (!matchedOpt || matchedOpt.isDisabled === true) {
      return false;
    }
    const targetHg = String(matchedOpt.hg || "").trim();
    const targetDisp = String(matchedOpt.displayName || "").trim();
    if (targetHg) {
      if (activeId) {
        return activeId.toLowerCase() === targetHg.toLowerCase();
      }
      return Boolean(
        targetDisp &&
          activeFamilyName &&
          activeFamilyName.toLowerCase() === targetDisp.toLowerCase(),
      );
    }
    if (activeId) {
      return spec.hgRe.test(activeId) || spec.labelRe.test(activeId);
    }
    return Boolean(
      targetDisp
        ? activeFamilyName.toLowerCase() === targetDisp.toLowerCase()
        : spec.labelRe.test(activeFamilyName),
    );
  }
  if (typeof qa.model.family === "function") {
    try {
      if (!qa.model.family()) {
        return false;
      }
    } catch {
      return false;
    }
  }
  if (activeId) {
    if (spec.hgRe.test(activeId) || spec.labelRe.test(activeId)) {
      return true;
    }
    if (activeFamilyName && spec.labelRe.test(activeFamilyName)) {
      return (
        !spec.expectedHg ||
        activeId.toLowerCase() === spec.expectedHg.toLowerCase()
      );
    }
    return false;
  }
  return spec.labelRe.test(activeFamilyName);
}

/** Verifies readable matching aspect ratio and model state on the project composer before submission. */
export function verifyComposerGenerationState(
  cfg?: GenerationConfig,
): { ok: true } | { ok: false; error: string } {
  const qa = resolvePromptState();
  if (cfg) {
    const mode = String(cfg.mode || "video").toLowerCase();
    const wantImageMode =
      mode === "image" || mode === "character" || mode === "scene";
    const rawAspect = cfg.aspect != null ? String(cfg.aspect).trim() : "";
    const aspectSpec = rawAspect ? resolveExpectedAspect(rawAspect) : null;
    if (aspectSpec && !verifyAspectState(qa, wantImageMode, aspectSpec)) {
      return { ok: false, error: "unsupported_aspect_ratio" };
    }
    const candidates = resolveCandidateModelSpecs(cfg, wantImageMode);
    if (!candidates.some((spec) => verifyModelSpec(qa, wantImageMode, spec))) {
      return { ok: false, error: "unsupported_model" };
    }
    if (!aspectSpec && !verifyAspectState(qa, wantImageMode, null)) {
      return { ok: false, error: "unsupported_aspect_ratio" };
    }
    return { ok: true };
  }
  let curMode = "";
  try {
    curMode = String(qa?.config?.mode?.() || "");
  } catch {
    curMode = "";
  }
  const wantImageMode = curMode.startsWith("IMAGE");
  if (!verifyAspectState(qa, wantImageMode, null)) {
    return { ok: false, error: "unsupported_aspect_ratio" };
  }
  const activeId = readActiveModelId(qa, wantImageMode);
  const activeName = readActiveModelFamilyName(qa);
  if (!qa?.model || (!activeId && !activeName)) {
    return { ok: false, error: "unsupported_model" };
  }
  const opts = readModelOptions(qa);
  if (opts !== null) {
    const found = opts.find((opt) => {
      const hg = String(opt?.hg || "").trim();
      const disp = String(opt?.displayName || "").trim();
      return (
        (activeId && hg.toLowerCase() === activeId.toLowerCase()) ||
        (activeName && disp.toLowerCase() === activeName.toLowerCase())
      );
    });
    if (!found || found.isDisabled === true) {
      return { ok: false, error: "unsupported_model" };
    }
  } else if (typeof qa.model.family === "function") {
    try {
      if (!qa.model.family()) {
        return { ok: false, error: "unsupported_model" };
      }
    } catch {
      return { ok: false, error: "unsupported_model" };
    }
  }
  return { ok: true };
}
