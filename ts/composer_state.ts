// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Direct PromptState mutations, chip cleanup, and item disable checks for verified builds.

import { readOwn } from "./angular";
import { resolveComposerControllers } from "./composer";
import { delay, elText, isVisibleEnabled } from "./dom";
import {
  PROMPT_COMPOSER_EXPORTS,
  promptComposerFormat,
  type PromptComposerFormat,
} from "./frontend_builds";
import type {
  GenerationConfig,
  PromptModelCatalogFamily,
  PromptModelOption,
  PromptStateController,
} from "./types";

/** Custom element tags for all seven Google Flow ingredient chip components. */
export const INGREDIENT_CHIP_TAGS = [
  "flow-character-ingredient-chip",
  "flow-image-ingredient-chip",
  "flow-likeness-ingredient-chip",
  "flow-style-pack-ingredient-chip",
  "flow-audio-ingredient-chip",
  "flow-video-ingredient-chip",
  "flow-file-ingredient-chip",
] as const;

/** Live `Rp` disable reason codes assigned to prompt items in `PromptState`. */
export const LIVE_DISABLE_REASON_CODES = [
  "CAPACITY_EXCEEDED",
  "AGENT_CAPACITY_EXCEEDED",
  "IMAGE_REFERENCES_EXCEEDED",
  "AUDIO_REFERENCES_EXCEEDED",
  "DURATION_NOT_SUPPORTED",
  "TYPE_NOT_SUPPORTED",
  "IMAGE_MODE_NOT_SUPPORTED",
  "MISSING_VISUAL_INGREDIENT",
  "INVALID_CHARACTER_NO_IMAGES",
  "MISSING_PAIRED_FRAME",
  "DIFFERENT_AGENT_SESSION",
] as const;

/** Selector matching Agent composer containers excluded from manual composer queries. */
const AGENT_COMPOSER =
  "flow-agent-panel, .agent-panel-wrapper, flow-creative-agent-prompt-box";

/** Selector matching any of the seven ingredient chip custom elements in `flow-prompt-box`. */
const PROMPT_BOX_CHIP_SELECTOR = INGREDIENT_CHIP_TAGS.map(
  (tag) => `flow-prompt-box ${tag}`,
).join(", ");

/** Normalized generation settings prepared before PromptState or DOM updates. */
export interface NormalizedComposerConfig {
  /** Normalized media category (`"image"` or `"video"`). */
  modeCategory: "image" | "video";
  /** Target `PromptState` mode enum (`"IMAGE"`, `"VIDEO_FRAMES"`, or `"VIDEO_REFERENCES"`). */
  targetMode: "IMAGE" | "VIDEO_FRAMES" | "VIDEO_REFERENCES";
  /** Normalized video submode (`"ingredients"` or `"frames"`) when `modeCategory` is `"video"`. */
  videoType: "ingredients" | "frames" | null;
  /** Requested aspect ratio label or enum key. */
  aspect: string;
  /** Requested or default model identifier. */
  model: string;
  /** Clamped output count (`1..4`) when specified. */
  count: number | null;
}

/** Result of normalizing `GenerationConfig` inputs. */
export type ComposerConfigCheck =
  | { ok: true; config: NormalizedComposerConfig }
  | { ok: false; error: string };

/** Result of applying `PromptState` controls on the active page. */
export type ApplyComposerStateResult =
  | { ok: true; mode: string; model: string; aspect: string }
  | { ok: false; fallback: true }
  | { ok: false; fallback?: false; error: string };

/** Verified runtime functions bound from `window.default_AiSandboxAngularFrontend`. */
interface BoundPromptComposerRuntime {
  /** Build field descriptor. */
  format: PromptComposerFormat;
  /** Live `PromptState` controller. */
  qa: PromptStateController;
  /** Native mode setter (`_.AQ`). */
  setMode: (qa: PromptStateController, mode: string) => void;
  /** Native model family setter (`_.BQ`). */
  setModel: (qa: PromptStateController, modelId: string) => void;
  /** Native output count setter (`_.scc`). */
  setCount: (qa: PromptStateController, count: number) => void;
  /** Map of native aspect enum keys to `{ label, icon }` descriptors (`_.NE`). */
  aspectLabels: Record<string, unknown>;
  /** Allowed native video aspect enum keys (`_.$O`). */
  videoAspects: unknown[];
}

/** Escapes regular expression metacharacters in literal text. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalizes a model identifier or display label to an exact comparison key. */
export function normalizeModelKey(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^models\//, "")
    .replace(/[\s\-_.]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned === "veo_3_1_fast" ? "veo_3_1_lite" : cleaned;
}

/** Builds an anchored regular expression (`^...$`) for DOM fallback model selection. */
export function buildAnchoredModelRegex(rawModel: string): RegExp {
  const canonical =
    normalizeModelKey(rawModel) === "veo_3_1_lite"
      ? "veo 3 1 lite"
      : rawModel.trim().replace(/^models\//i, "");
  const tokens = canonical
    .split(/[\s\-_.]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(escapeRegex);
  if (tokens.length === 0) {
    return new RegExp(`^${escapeRegex(rawModel.trim())}$`, "i");
  }
  return new RegExp(`^${tokens.join("(?:[\\s\\-_.]|\\s+-\\s+)*")}$`, "i");
}

/** Normalizes `cfg` and validates video aspect ratio, `video_type`, and frame characters. */
export function normalizeComposerConfig(cfg: GenerationConfig): ComposerConfigCheck {
  const rawMode = String(cfg.mode || "video").trim().toLowerCase();
  const isImage =
    rawMode === "image" || rawMode === "character" || rawMode === "scene";
  const modeCategory: "image" | "video" = isImage ? "image" : "video";
  const aspect = String(cfg.aspect || "16:9").trim() || "16:9";

  if (
    modeCategory === "video" &&
    (aspect === "1:1" || /^square$/i.test(aspect))
  ) {
    return { ok: false, error: "invalid_video_aspect_ratio" };
  }

  let videoType: "ingredients" | "frames" | null = null;
  let targetMode: "IMAGE" | "VIDEO_FRAMES" | "VIDEO_REFERENCES" = "IMAGE";
  if (modeCategory === "video") {
    const rawVt = String(cfg.video_type || "").trim();
    if (
      !rawVt ||
      /^(?:ingredients?|references?|video_ingredients|video_references)$/i.test(rawVt)
    ) {
      videoType = "ingredients";
      targetMode = "VIDEO_REFERENCES";
    } else if (/^(?:frames?|video_frames)$/i.test(rawVt)) {
      videoType = "frames";
      targetMode = "VIDEO_FRAMES";
    } else {
      return { ok: false, error: `invalid_video_type:${rawVt}` };
    }
    if (
      videoType === "frames" &&
      Array.isArray(cfg.characters) &&
      cfg.characters.some((c) => String(c || "").trim().length > 0)
    ) {
      return { ok: false, error: "characters_not_supported_in_frames" };
    }
  }

  const rawModel = String(cfg.model || "").trim();
  const defaultModel = modeCategory === "image" ? "nano-banana-2" : "veo_3_1_lite";
  const model = !rawModel
    ? defaultModel
    : normalizeModelKey(rawModel) === "veo_3_1_lite"
      ? "veo_3_1_lite"
      : rawModel;
  const count =
    cfg.count != null && Number.isFinite(Number(cfg.count))
      ? Math.min(4, Math.max(1, Math.round(Number(cfg.count))))
      : null;

  return {
    ok: true,
    config: { modeCategory, targetMode, videoType, aspect, model, count },
  };
}

/** Resolves verified `PromptState` exports and the live `Qa` controller when available. */
function bindPromptComposerRuntime(): BoundPromptComposerRuntime | null {
  const format = promptComposerFormat();
  if (!format) return null;
  const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
  for (const name of PROMPT_COMPOSER_EXPORTS) {
    const value = readOwn(namespace, format.exports[name]);
    const ok =
      name === "videoAspects"
        ? Array.isArray(value) && value.length > 0
        : name === "aspectLabels"
          ? value !== null && typeof value === "object"
          : typeof value === "function";
    if (!ok) return null;
  }
  const { qa } = resolveComposerControllers(false);
  if (
    !qa ||
    typeof qa.setAspectRatio !== "function" ||
    typeof qa.clear !== "function"
  ) {
    return null;
  }
  return {
    format,
    qa,
    setMode: readOwn(namespace, format.exports.setMode) as (
      qa: PromptStateController,
      mode: string,
    ) => void,
    setModel: readOwn(namespace, format.exports.setModel) as (
      qa: PromptStateController,
      modelId: string,
    ) => void,
    setCount: readOwn(namespace, format.exports.setCount) as (
      qa: PromptStateController,
      count: number,
    ) => void,
    aspectLabels: readOwn(namespace, format.exports.aspectLabels) as Record<
      string,
      unknown
    >,
    videoAspects: readOwn(namespace, format.exports.videoAspects) as unknown[],
  };
}

/** Returns true when the active build defines `promptComposer`. */
export function buildDefinesPromptComposer(): boolean {
  return Boolean(promptComposerFormat());
}

/** Maps a caller aspect string (`"16:9"`, `"9:16"`, `"1:1"`, or enum key) to Flow's enum key. */
function resolveNativeAspectKey(
  aspect: string,
  aspectLabels: Record<string, unknown>,
): string | null {
  const trimmed = aspect.trim();
  const low = trimmed.toLowerCase();
  const enumAlias =
    low === "landscape"
      ? "16:9"
      : low === "portrait"
        ? "9:16"
        : low === "square"
          ? "1:1"
          : low;
  for (const [key, entry] of Object.entries(aspectLabels)) {
    if (key.toLowerCase() === low) return key;
    const label = String(readOwn(entry, "label") ?? "")
      .trim()
      .toLowerCase();
    if (label && (label === low || label === enumAlias)) return key;
  }
  return null;
}

/** Resolves `requestedModel` to an exact `hg` family ID using anchored comparisons. */
function resolveTargetModelFamilyId(
  requestedModel: string,
  qa: PromptStateController,
  format: PromptComposerFormat,
): { ok: true; id: string } | { ok: false; error: string } {
  const modelObj = readOwn(qa, "model");
  const readFamilies = readOwn(modelObj, format.families);
  if (typeof readFamilies !== "function") {
    return { ok: false, error: "model_families_signal_missing" };
  }
  const rawOptions = readFamilies.call(modelObj) as unknown;
  const options: PromptModelOption[] = Array.isArray(rawOptions)
    ? (rawOptions as PromptModelOption[])
    : [];
  const readCatalog = readOwn(modelObj, format.catalogFamilies);
  const rawCatalog =
    typeof readCatalog === "function"
      ? (readCatalog.call(modelObj) as unknown)
      : null;
  const catalog: PromptModelCatalogFamily[] = Array.isArray(rawCatalog)
    ? (rawCatalog as PromptModelCatalogFamily[])
    : [];

  const catalogAliases = new Map<string, string[]>();
  for (const fam of catalog) {
    const famId = String(readOwn(fam, "id") ?? "").trim();
    if (!famId) continue;
    const names: string[] = [famId];
    const disp = String(readOwn(fam, "displayName") ?? "").trim();
    if (disp) names.push(disp);
    const aliases = readOwn(fam, "aliases");
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias === "string" && alias.trim()) names.push(alias.trim());
      }
    }
    catalogAliases.set(famId, names);
  }

  const targetKey = normalizeModelKey(requestedModel);
  const matches: Array<{ id: string; disabled: boolean }> = [];
  for (const option of options) {
    const id = String(readOwn(option, format.modelId) ?? "").trim();
    if (!id) continue;
    const displayName = String(readOwn(option, "displayName") ?? "").trim();
    const candidates = [id, displayName, ...(catalogAliases.get(id) ?? [])].filter(
      Boolean,
    );
    const matched = candidates.some(
      (cand) => normalizeModelKey(cand) === targetKey,
    );
    if (matched) {
      matches.push({ id, disabled: readOwn(option, "isDisabled") === true });
    }
  }

  if (matches.length === 0) {
    return { ok: false, error: `unknown_model:${requestedModel}` };
  }
  const enabled = matches.find((entry) => !entry.disabled);
  if (!enabled) {
    return { ok: false, error: `model_disabled:${matches[0].id}` };
  }
  return { ok: true, id: enabled.id };
}

/** Applies mode, aspect ratio, model family, and output count directly on `PromptState`. */
export function applyPromptComposerState(
  cfg: GenerationConfig,
): ApplyComposerStateResult {
  const checked = normalizeComposerConfig(cfg);
  if (!checked.ok) {
    return { ok: false, error: checked.error };
  }
  if (!buildDefinesPromptComposer()) {
    return { ok: false, fallback: true };
  }
  const runtime = bindPromptComposerRuntime();
  if (!runtime) {
    return { ok: false, error: "prompt_composer_unavailable" };
  }
  const { format, qa, setMode, setModel, setCount, aspectLabels, videoAspects } =
    runtime;
  const { modeCategory, targetMode, aspect, model, count } = checked.config;

  const nativeAspect = resolveNativeAspectKey(aspect, aspectLabels);
  if (!nativeAspect) {
    return { ok: false, error: `unsupported_aspect_ratio:${aspect}` };
  }
  if (
    modeCategory === "video" &&
    !videoAspects.some((entry) => String(entry) === nativeAspect)
  ) {
    return { ok: false, error: `invalid_video_aspect_ratio:${aspect}` };
  }

  setMode(qa, targetMode);
  if (qa.config?.mode?.() !== targetMode) {
    return { ok: false, error: `mode_update_failed:${targetMode}` };
  }

  qa.setAspectRatio?.(nativeAspect);

  const modelMatch = resolveTargetModelFamilyId(model, qa, format);
  if (!modelMatch.ok) {
    return { ok: false, error: modelMatch.error };
  }
  setModel(qa, modelMatch.id);
  const readActiveFamily = readOwn(readOwn(qa, "model"), format.activeFamily);
  const activeFamily =
    typeof readActiveFamily === "function"
      ? String(readActiveFamily.call(readOwn(qa, "model")) ?? "")
      : "";
  if (activeFamily !== modelMatch.id) {
    return { ok: false, error: `model_update_failed:${modelMatch.id}` };
  }

  if (qa.config?.aspectRatio?.() !== nativeAspect) {
    qa.setAspectRatio?.(nativeAspect);
  }
  if (
    typeof qa.config?.aspectRatio === "function" &&
    qa.config.aspectRatio() !== nativeAspect
  ) {
    return { ok: false, error: `aspect_ratio_not_supported:${aspect}` };
  }

  if (count !== null) {
    setCount(qa, count);
    if (
      typeof qa.config?.outputCount === "function" &&
      Number(qa.config.outputCount()) !== count
    ) {
      return { ok: false, error: `count_update_failed:${count}` };
    }
  }

  return {
    ok: true,
    mode: targetMode,
    model: modelMatch.id,
    aspect: nativeAspect,
  };
}

/** Reads the current attached prompt items array (`Qa.oc.all()`) for the active route. */
export function readPromptItems(
  editFlag: boolean,
): Array<Record<string, unknown>> | null {
  const format = promptComposerFormat();
  const itemsKey = format?.items ?? "oc";
  const { page, ux, qa } = resolveComposerControllers(editFlag);
  const candidates: unknown[] = [qa, ux?.Qa, page?.Qa, page];
  for (const holder of candidates) {
    if (!holder || typeof holder !== "object") continue;
    for (const key of [itemsKey, "oc", "kc"]) {
      const container = readOwn(holder, key);
      const allFn = readOwn(container, "all");
      if (typeof allFn === "function") {
        const list = allFn.call(container) as unknown;
        if (Array.isArray(list)) {
          return list as Array<Record<string, unknown>>;
        }
      }
    }
  }
  return null;
}

/** Returns true while `item` reports `isLoading === true`. */
export function isPromptItemLoading(item: unknown): boolean {
  return readOwn(item, "isLoading") === true;
}

/** Returns the defined `Rp` disable code on `item`, or `null` when the item is enabled. */
export function itemDisableReason(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const format = promptComposerFormat();
  const fields = format
    ? [format.disableReason, "Rp", "tl"]
    : ["Rp", "tl"];
  for (const field of fields) {
    const raw = readOwn(item, field);
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

/** Returns the first defined `Rp` disable code across `items`, or `null` when all items are valid. */
export function findPromptItemsDisableReason(
  items: readonly unknown[] | null | undefined,
): string | null {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    const code = itemDisableReason(item);
    if (code) return code;
  }
  return null;
}

/** Finds the remove button inside one of the seven `<flow-*-ingredient-chip>` elements. */
function findChipRemoveButton(chip: Element): HTMLElement | null {
  const buttons = Array.from(chip.querySelectorAll("button")).filter(
    isVisibleEnabled,
  );
  if (buttons.length === 0) return null;
  const explicit = buttons.find((btn) => {
    const label = (
      btn.getAttribute("aria-label") ||
      elText(btn) ||
      btn.getAttribute("title") ||
      ""
    ).trim();
    return /\b(?:remove|delete|clear|close|cancel)\b/i.test(label);
  });
  return explicit ?? buttons[buttons.length - 1] ?? null;
}

/** Clears `PromptState`, emits `lF` (`"all"`), and removes any remaining ingredient chips. */
export async function clearPromptComposerItems(): Promise<void> {
  const format = promptComposerFormat();
  const clearOutputKey = format?.clearOutput ?? "lF";
  const { ux, qa } = resolveComposerControllers(false);

  try {
    ux?.lW?.nPa?.();
  } catch {
    // Ignore optional uploader cancellation errors.
  }
  try {
    qa?.clear?.();
  } catch {
    // Fall back to DOM clear controls below if Qa.clear throws.
  }
  try {
    const emitter = readOwn(ux, clearOutputKey) as
      | { emit?: (scope: string) => void }
      | undefined;
    emitter?.emit?.("all");
  } catch {
    // Ignore optional emitter errors.
  }
  try {
    const onCleared = ux?.C7?.();
    if (typeof onCleared === "function") onCleared();
  } catch {
    // Ignore optional clear callback errors.
  }

  const hasRemainingChipsOrItems = (): boolean =>
    (readPromptItems(false)?.length ?? 0) > 0 ||
    Array.from(document.querySelectorAll(PROMPT_BOX_CHIP_SELECTOR)).some(
      (chip) => !chip.closest(AGENT_COMPOSER) && chip.isConnected,
    );

  if (hasRemainingChipsOrItems()) {
    await delay(40);
  }

  if (hasRemainingChipsOrItems()) {
    const clearBtn = Array.from(
      document.querySelectorAll(
        'flow-prompt-box button[aria-label="Clear prompt"], button[aria-label="Clear prompt"]',
      ),
    ).find(
      (el): el is HTMLElement =>
        isVisibleEnabled(el) && !el.closest(AGENT_COMPOSER),
    );
    if (clearBtn) {
      clearBtn.click();
      await delay(60);
    }
  }

  for (let pass = 0; pass < 4 && hasRemainingChipsOrItems(); pass += 1) {
    const removeButtons = new Set<HTMLElement>();
    for (const chip of document.querySelectorAll(PROMPT_BOX_CHIP_SELECTOR)) {
      if (chip.closest(AGENT_COMPOSER)) continue;
      const btn = findChipRemoveButton(chip);
      if (btn) removeButtons.add(btn);
    }
    for (const el of document.querySelectorAll(
      'flow-prompt-box button[aria-label*="Remove" i], flow-prompt-box [class*="chip"] button',
    )) {
      if (!(el instanceof HTMLElement) || !isVisibleEnabled(el)) continue;
      if (el.closest(AGENT_COMPOSER)) continue;
      const lbl = (el.getAttribute("aria-label") || elText(el)).trim();
      if (
        /^remove\b|remove ingredient|remove reference|remove frame|remove character|remove audio|remove video|remove file|remove style|remove likeness/i.test(
          lbl,
        )
      ) {
        removeButtons.add(el);
      }
    }
    if (removeButtons.size === 0) break;
    for (const btn of removeButtons) {
      btn.click();
    }
    await delay(80);
  }
}
