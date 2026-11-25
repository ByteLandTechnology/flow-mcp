// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Bind Angular image/video edit prompt controllers, select scene timeline clips, and read alerts.

import { isLiveLView, readOwn, resolveLView } from "./angular";
import { delay, elText } from "./dom";
import { activeEditBuild } from "./edit_builds";
import { runtimeState } from "./state";
import type { BasePromptBoxInstance, NgLView, PromptStateController } from "./types";

/** Containers that belong to the Agent composer and must never be targeted by manual or edit flows. */
export const AGENT_COMPOSER_SELECTOR =
  "flow-agent-panel, .agent-panel-wrapper, flow-creative-agent-prompt-box";

/** Editor side and history panels that must never be targeted as edit composers or submit controls. */
export const EDITOR_SIDE_PANEL_SELECTOR =
  "flow-editor-side-panel, flow-editor-history-panel, flow-editor-side-panel-switcher";

/** Combined selector of Agent and side-panel containers excluded on all routes. */
export const EXCLUDED_COMPOSER_SELECTOR = `${AGENT_COMPOSER_SELECTOR}, ${EDITOR_SIDE_PANEL_SELECTOR}`;

/** Direct selector for Flow image and video edit prompt boxes. */
export const EDIT_PROMPT_BOX_SELECTOR =
  "flow-edit-image-prompt-box, flow-edit-video-prompt-box";

/** Scoped container selector for edit prompt discovery across editor and scene builder views. */
export const EDIT_SCOPE_SELECTOR =
  "flow-edit-image-prompt-box, flow-edit-video-prompt-box, flow-editor-page, flow-scene-builder";

/** Live Angular controller interface for `flow-edit-image-prompt-box` (`_.ZX`). */
export interface EditImagePromptBoxInstance {
  /** Shared `PromptStateController` instance. */
  Qa?: PromptStateController;
  /** Child `flow-base-prompt-box` signal query. */
  zr?: () => BasePromptBoxInstance | undefined;
  /** Signal reporting whether submission is disabled. */
  wf?: () => boolean;
}

/** Live Angular controller interface for `flow-edit-video-prompt-box` (`l6`). */
export interface EditVideoPromptBoxInstance {
  /** Shared `PromptStateController` instance. */
  Qa?: PromptStateController;
  /** Selected timeline clip signal. */
  Rn?: () => unknown;
  /** Clip loading input signal. */
  H_?: () => boolean;
  /** Region restriction input signal. */
  eJa?: () => boolean;
  /** Computed region restriction signal. */
  lT?: () => boolean;
  /** Computed region restriction message signal. */
  iPa?: () => string;
  /** Computed too-long clip signal. */
  ina?: () => boolean;
  /** Computed too-long clip message signal. */
  dpb?: () => string;
  /** Computed too-short clip signal. */
  AKa?: () => boolean;
  /** Computed too-short clip message signal. */
  epb?: () => string;
  /** Computed unsupported-resolution signal. */
  nna?: () => boolean;
  /** Unsupported-resolution static text. */
  sXa?: string;
  /** Computed submit disabled signal. */
  wf?: () => boolean;
  /** Computed submit disabled reason signal. */
  UO?: () => string | undefined;
}

/** Returns true when `pathname` is an asset editor (`/edit/`) or scene builder (`/scene/`) route. */
export function isEditRoute(pathname = location.pathname || ""): boolean {
  return /\/(?:edit|scene)\//.test(pathname);
}

/** Resolves whether edit mode is active from an explicit flag or the current browser route. */
export function isEditContext(explicitEdit?: boolean | null): boolean {
  return typeof explicitEdit === "boolean" ? explicitEdit : isEditRoute();
}

/** Returns true when `node` lies inside an excluded Agent or editor side/history panel. */
export function isExcludedComposerNode(node: Node | null | undefined): boolean {
  if (!node) return false;
  const el = node instanceof Element ? node : node.parentElement;
  return Boolean(el?.closest(EXCLUDED_COMPOSER_SELECTOR));
}

/** Calls a zero-argument signal or getter method on `target` when present. */
function callSignal(target: unknown, key: string): unknown {
  const fn = readOwn(target, key);
  if (typeof fn !== "function") return undefined;
  try {
    return (fn as () => unknown).call(target);
  } catch {
    return undefined;
  }
}

/** Scans Angular LViews anchored at `elements` (and `ngLViewMap`) for an instance matching `pred`. */
function findControllerInViews<T>(
  elements: Element[],
  pred: (cand: unknown) => cand is T,
): T | null {
  for (const startEl of elements) {
    if (isExcludedComposerNode(startEl)) continue;
    const probes = [startEl, startEl.firstElementChild].filter(
      (n): n is Element => Boolean(n && !isExcludedComposerNode(n)),
    );
    for (const node of probes) {
      let lv: NgLView | null = resolveLView(node);
      for (let d = 0; d < 6 && Array.isArray(lv); d += 1) {
        if (lv[0] instanceof Node && isExcludedComposerNode(lv[0])) break;
        for (const cand of lv) {
          if (pred(cand)) return cand;
        }
        lv = Array.isArray(lv[3]) ? lv[3] : Array.isArray(lv[15]) ? lv[15] : null;
      }
    }
  }
  if (runtimeState.ngLViewMap instanceof Map) {
    for (const lv of runtimeState.ngLViewMap.values()) {
      if (!isLiveLView(lv)) continue;
      if (lv[0] instanceof Node && isExcludedComposerNode(lv[0])) continue;
      for (const cand of lv) {
        if (pred(cand)) return cand;
      }
    }
  }
  return null;
}

/** Binds the live `flow-edit-image-prompt-box` (`_.ZX`) Angular controller when mounted. */
export function findEditImagePromptBox(): EditImagePromptBoxInstance | null {
  const format = activeEditBuild();
  const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
  const ctor = format ? readOwn(namespace, format.imagePromptBox) : undefined;
  const childKey = format?.imageBoxChild ?? "zr";
  const qaKey = format?.promptState ?? "Qa";
  const isImageBox = (cand: unknown): cand is EditImagePromptBoxInstance => {
    if (!cand || typeof cand !== "object" || cand instanceof Node) return false;
    if (typeof ctor === "function" && cand instanceof ctor) return true;
    return (
      Boolean(readOwn(cand, qaKey)) &&
      typeof readOwn(cand, childKey) === "function" &&
      (typeof readOwn(cand, "yx") === "function" ||
        typeof readOwn(cand, "bia") === "function" ||
        typeof readOwn(cand, "VHa") === "function")
    );
  };
  const hosts = Array.from(
    document.querySelectorAll("flow-edit-image-prompt-box"),
  ).filter((el) => !isExcludedComposerNode(el));
  return findControllerInViews(hosts, isImageBox);
}

/** Binds the live `flow-edit-video-prompt-box` (`l6`) Angular controller when mounted. */
export function findEditVideoPromptBox(): EditVideoPromptBoxInstance | null {
  const format = activeEditBuild();
  const qaKey = format?.promptState ?? "Qa";
  const clipKey = format?.selectedClip ?? "Rn";
  const disabledKey = format?.submitDisabled ?? "wf";
  const reasonKey = format?.submitDisabledReason ?? "UO";
  const tooLongKey = format?.tooLong ?? "ina";
  const regionKey = format?.regionBlockedInput ?? "eJa";
  const regionComputedKey = format?.regionBlocked ?? "lT";
  const loadingKey = format?.clipLoading ?? "H_";
  const isVideoBox = (cand: unknown): cand is EditVideoPromptBoxInstance => {
    if (!cand || typeof cand !== "object" || cand instanceof Node) return false;
    return (
      Boolean(readOwn(cand, qaKey)) &&
      typeof readOwn(cand, clipKey) === "function" &&
      typeof readOwn(cand, disabledKey) === "function" &&
      (typeof readOwn(cand, reasonKey) === "function" ||
        typeof readOwn(cand, tooLongKey) === "function" ||
        typeof readOwn(cand, regionKey) === "function" ||
        typeof readOwn(cand, regionComputedKey) === "function" ||
        typeof readOwn(cand, loadingKey) === "function")
    );
  };
  const hosts = Array.from(
    document.querySelectorAll("flow-edit-video-prompt-box"),
  ).filter((el) => !isExcludedComposerNode(el));
  return findControllerInViews(hosts, isVideoBox);
}

/** Resolves the active `BasePromptBoxInstance` inside image or video edit prompt boxes. */
export function resolveEditBasePromptBox(
  scanElement: (el: Element | null) => BasePromptBoxInstance | null,
): BasePromptBoxInstance | null {
  const format = activeEditBuild();
  const childKey = format?.imageBoxChild ?? "zr";
  const imageBox = findEditImagePromptBox();
  if (imageBox) {
    const child = callSignal(imageBox, childKey);
    if (child && typeof child === "object" && !(child instanceof Node)) {
      return child as BasePromptBoxInstance;
    }
  }
  const candidates = Array.from(
    document.querySelectorAll(
      "flow-edit-image-prompt-box flow-base-prompt-box, flow-edit-image-prompt-box, flow-edit-video-prompt-box flow-base-prompt-box, flow-edit-video-prompt-box",
    ),
  ).filter((el) => !isExcludedComposerNode(el));
  for (const el of candidates) {
    const found = scanElement(el);
    if (found) return found;
  }
  return null;
}

/** Cleans Material icon ligatures and action button labels from an editor alert element. */
function cleanAlertElementText(el: Element): string {
  const dedicated = el.querySelector(".too-long-text");
  if (dedicated) {
    const txt = elText(dedicated).trim();
    if (txt) return txt;
  }
  const clone = el.cloneNode(true);
  if (clone instanceof Element) {
    for (const extra of clone.querySelectorAll("button, mat-icon, .too-long-icon")) {
      extra.remove();
    }
    const stripped = (clone.textContent || "").replace(/\s+/g, " ").trim();
    if (stripped) return stripped;
  }
  return elText(el)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !/^(?:warning|error|info|bolt|content_cut|trim automatically|exit extend mode)$/i.test(
          line,
        ),
    )
    .join(" ")
    .trim();
}

/** Returns true when `el` is rendered and visible outside excluded panels. */
function isVisibleAlertElement(el: Element): boolean {
  if (!(el instanceof HTMLElement) || !el.isConnected) return false;
  if (isExcludedComposerNode(el)) return false;
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  return el.getClientRects().length > 0 || el.textContent?.trim() !== "";
}

/** Reads any active `.too-long-overlay` `[role="alert"]` or `l6` controller block reason. */
export function readEditBlockReason(): string | null {
  const alertEls = Array.from(
    document.querySelectorAll(
      '.too-long-overlay, flow-edit-video-prompt-box [role="alert"], flow-edit-image-prompt-box [role="alert"], flow-scene-builder .too-long-overlay',
    ),
  );
  for (const el of alertEls) {
    if (!isVisibleAlertElement(el)) continue;
    const msg = cleanAlertElementText(el);
    if (msg) return msg;
  }

  const videoBox = findEditVideoPromptBox();
  if (!videoBox) return null;
  const format = activeEditBuild();
  const loading = Boolean(callSignal(videoBox, format?.clipLoading ?? "H_"));
  if (loading) return null;

  const regionBlocked =
    Boolean(callSignal(videoBox, format?.regionBlocked ?? "lT")) ||
    (Boolean(callSignal(videoBox, format?.selectedClip ?? "Rn")) &&
      Boolean(callSignal(videoBox, format?.regionBlockedInput ?? "eJa")));
  if (regionBlocked) {
    const msg =
      callSignal(videoBox, format?.regionBlockedMessage ?? "iPa") ??
      callSignal(videoBox, format?.submitDisabledReason ?? "UO");
    return typeof msg === "string" && msg.trim()
      ? msg.trim()
      : "Editing uploaded videos is not available in your region right now.";
  }

  if (Boolean(callSignal(videoBox, format?.tooLong ?? "ina"))) {
    const msg = callSignal(videoBox, format?.tooLongMessage ?? "dpb");
    return typeof msg === "string" && msg.trim()
      ? msg.trim()
      : "Videos longer than 10s can't be edited. Trim to 10s or under to edit.";
  }

  if (Boolean(callSignal(videoBox, format?.resolutionBlocked ?? "nna"))) {
    const msg = readOwn(videoBox, format?.resolutionBlockedMessage ?? "sXa");
    return typeof msg === "string" && msg.trim()
      ? msg.trim()
      : "Videos of this resolution cannot be edited currently.";
  }

  if (Boolean(callSignal(videoBox, format?.tooShort ?? "AKa"))) {
    const msg = callSignal(videoBox, format?.tooShortMessage ?? "epb");
    return typeof msg === "string" && msg.trim()
      ? msg.trim()
      : "Video clip is shorter than the minimum editable duration.";
  }

  const disabledReason = callSignal(videoBox, format?.submitDisabledReason ?? "UO");
  if (typeof disabledReason === "string" && disabledReason.trim()) {
    return disabledReason.trim();
  }
  return null;
}

/** Selects `clipWorkflowId` on `<flow-scene-timeline>` and waits for clip state to settle. */
export async function selectSceneTimelineClip(
  clipWorkflowId: string,
): Promise<boolean> {
  const targetId = String(clipWorkflowId || "").trim();
  if (!targetId) return false;
  const format = activeEditBuild();
  const clipsKey = format?.timelineClips ?? "zh";
  const serviceKey = format?.timelineService ?? "Ef";
  const setSigKey = format?.timelineSelectedSignal ?? "la";
  const readSigKey = format?.timelineSelectedRead ?? "Ca";
  const outKey = format?.timelineSelectOutput ?? "WBa";

  interface TimelineController {
    [key: string]: unknown;
  }

  const isTimeline = (cand: unknown): cand is TimelineController =>
    Boolean(
      cand &&
        typeof cand === "object" &&
        !(cand instanceof Node) &&
        typeof readOwn(cand, clipsKey) === "function" &&
        readOwn(cand, serviceKey) != null,
    );

  let selected = false;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const timelines = Array.from(
      document.querySelectorAll("flow-scene-timeline"),
    ).filter((el) => !isExcludedComposerNode(el));
    const ctrl = findControllerInViews(timelines, isTimeline);
    const clipsRaw = ctrl ? callSignal(ctrl, clipsKey) : undefined;
    const clips = Array.isArray(clipsRaw) ? clipsRaw : [];
    const clipIdx = clips.findIndex(
      (item) =>
        String(readOwn(item, "workflowId") || readOwn(item, "id") || "") ===
        targetId,
    );

    const domClips = Array.from(
      document.querySelectorAll(
        "flow-scene-timeline .clip, flow-scene-builder .clip",
      ),
    ).filter((el): el is HTMLElement => el instanceof HTMLElement && !isExcludedComposerNode(el));

    if (clipIdx >= 0 && domClips[clipIdx]) {
      const targetEl = domClips[clipIdx];
      const clickTarget =
        targetEl.querySelector<HTMLElement>("div") || targetEl;
      clickTarget.click();
      selected = true;
    }

    if (ctrl) {
      const svc = readOwn(ctrl, serviceKey);
      const curSelected = callSignal(svc, readSigKey);
      if (curSelected === targetId) {
        selected = true;
      } else if (clipIdx >= 0 || clips.length === 0) {
        const sig = readOwn(svc, setSigKey) as { set?: (id: string) => void } | undefined;
        if (typeof sig?.set === "function") {
          try {
            sig.set(targetId);
            selected = true;
          } catch {
            // Fall through to DOM click fallback.
          }
        }
        const emitter = readOwn(ctrl, outKey) as { emit?: (id: string) => void } | undefined;
        if (typeof emitter?.emit === "function") {
          try {
            emitter.emit(targetId);
            selected = true;
          } catch {
            // Ignore emitter errors on partially initialized views.
          }
        }
      }
    }

    if (!selected && domClips.length === 1) {
      const clickTarget =
        domClips[0].querySelector<HTMLElement>("div") || domClips[0];
      clickTarget.click();
      selected = true;
    }

    const videoBox = findEditVideoPromptBox();
    const activeClip = videoBox
      ? callSignal(videoBox, format?.selectedClip ?? "Rn")
      : undefined;
    if (selected && (activeClip != null || readEditBlockReason() !== null)) {
      break;
    }
    await delay(100);
  }

  for (let waitIdx = 0; waitIdx < 25; waitIdx += 1) {
    const videoBox = findEditVideoPromptBox();
    const loading = videoBox
      ? Boolean(callSignal(videoBox, format?.clipLoading ?? "H_"))
      : false;
    if (!loading) break;
    await delay(100);
  }
  return selected;
}
