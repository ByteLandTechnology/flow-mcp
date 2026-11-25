// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read clips and workflow history from the native scene tile, and select and verify timeline clips in `flow-scene-builder`.

import {
  isLiveLView,
  readOwn,
  resolveLView,
  withLViewMapCapture,
  type NgContextCarrier,
} from "./angular";
import {
  EDIT_PROMPT_BOX_SELECTOR,
  findTextbox,
  isVisibleOutsideNonComposer,
  NON_COMPOSER_PANELS,
  readComposerAlert,
} from "./composer";
import { delay, elText, hoverProbe, isVisibleEnabled } from "./dom";
import { frontendBuild, readBuildLabel } from "./frontend_builds";
import { runtimeState } from "./state";
import type { FlowMediaPayload, FlowTile, SceneClipItem } from "./types";

/** Controls inside `flow-scene-builder` that are never timeline clip items. */
const NON_CLIP_CONTROLS = `${NON_COMPOSER_PANELS}, ${EDIT_PROMPT_BOX_SELECTOR}, flow-playback-control, flow-extend-menu, flow-clip-context-menu, .add-clip-button-container, .add-clip-button, .timeline-controls, .zoom-controls, .cdk-overlay-pane, [role="menu"], [role="listbox"]`;

/** Selectors that identify timeline clip containers inside `flow-scene-builder`. */
const CLIP_CONTAINER_SELECTOR =
  '.clip, [data-workflow-id], [data-clip-id], [data-asset-id], [data-clip-index], [data-testid*="clip"]:not(button):not([role="menuitem"]), [class*="timeline-clip"], [class*="clip-item"], [class*="clip-card"]';

/** Status strings that indicate a timeline clip is not ready for editing. */
const NOT_READY_CLIP_STATUS =
  /^(?:pending|scheduled|generating|loading|unloaded|failed|canceled)$/i;

/** Extracted identifiers and readiness flags for one timeline clip element. */
interface SceneClipInspection {
  /** Explicit clip workflow identifiers on the element or its LView. */
  workflowIds: string[];
  /** Clip or asset identifiers on the element or its LView. */
  clipIds: string[];
  /** Media identifiers on the element or its LView. */
  mediaIds: string[];
  /** Stripped identifiers from `PLACEHOLDER_` or `extend-failed-` items. */
  placeholderIds: string[];
  /** True when the clip is loading, a placeholder, splitting, or failed. */
  notReady: boolean;
  /** True when the item is a secondary extend-composing or failed-extend pill. */
  isAuxiliaryItem: boolean;
}

/** Timeline clip elements grouped by match and readiness state. */
interface MatchedSceneClips {
  /** All visible timeline clip container elements in the timeline. */
  allClips: HTMLElement[];
  /** Ready, selectable clip elements matching the requested ID. */
  readyMatches: HTMLElement[];
  /** Unloaded, placeholder, or failed clip elements matching the requested ID. */
  notReadyMatches: HTMLElement[];
}

/** Outcome of selecting and verifying a target clip in `flow-scene-builder`. */
export type SceneClipSelectionResult =
  | { ok: true; selectedClipId: string }
  | { ok: false; error: string; detail: string };

/** Builds a failed scene clip selection result with error code and detail. */
function selectionFailure(error: string, detail: string): SceneClipSelectionResult {
  return { ok: false, error, detail };
}

/** Returns the clip list and history of a scene in the active build. */
export function sceneContents(tile: FlowTile) {
  const format = frontendBuild(readBuildLabel())?.projectStore.scene;
  const clips = (format && readOwn(tile, format.clips)) ?? tile.Oc;
  const history = (format && readOwn(tile, format.history)) ?? tile.Yf;
  const entries: Iterable<[string, FlowMediaPayload[]]> = history instanceof Map
    ? history.entries()
    : history && typeof history === "object" ? Object.entries(history) : [];
  return {
    clips: Array.isArray(clips) ? clips as SceneClipItem[] : [],
    history: new Map(Array.from(entries, ([id, media]) => [String(id), media])),
  };
}

/** Calls a zero-argument signal getter or returns a plain property value from `obj`. */
function readSignalOrValue(obj: object, key: string): unknown {
  const raw = readOwn(obj, key);
  if (typeof raw === "function" && raw.length === 0) {
    try {
      return raw.call(obj);
    } catch {
      return undefined;
    }
  }
  return raw;
}

/** Resolves the instance property key for a declared Angular input name. */
function resolveInputPropertyKey(inst: object, inputName: string): string | null {
  if (inputName in inst) return inputName;
  const ctor = (inst as { constructor?: unknown }).constructor;
  if (typeof ctor !== "function") return null;
  for (const staticKey of Object.getOwnPropertyNames(ctor)) {
    let def: unknown;
    try {
      def = Reflect.get(ctor, staticKey);
    } catch {
      continue;
    }
    if (!def || typeof def !== "object" || readOwn(def, "type") !== ctor) {
      continue;
    }
    const inputs = readOwn(def, "inputs");
    if (!inputs || typeof inputs !== "object") continue;
    const mapping = readOwn(inputs, inputName);
    if (typeof mapping === "string" && mapping) return mapping;
    if (Array.isArray(mapping) && typeof mapping[0] === "string" && mapping[0]) {
      return mapping[0];
    }
    for (const [propKey, rawSpec] of Object.entries(inputs)) {
      if (rawSpec === inputName) return propKey;
      if (Array.isArray(rawSpec) && rawSpec[1] === inputName && propKey) {
        return propKey;
      }
    }
  }
  return null;
}

/** Reads a named Angular component input or signal property from `inst`. */
export function readComponentInput(
  inst: object,
  inputName: string,
): { found: boolean; value: unknown } {
  const propKey = resolveInputPropertyKey(inst, inputName);
  if (!propKey) return { found: false, value: undefined };
  return { found: true, value: readSignalOrValue(inst, propKey) };
}

/** Appends a trimmed identifier to `target`, recording `PLACEHOLDER_` and `extend-failed-` prefixes separately. */
function pushClipIdentifier(
  raw: unknown,
  target: string[],
  placeholderIds: string[],
): boolean {
  if (typeof raw !== "string" && typeof raw !== "number") return false;
  const val = String(raw).trim();
  if (!val || /^flow-scene-timeline-area-\d+$/.test(val)) return false;
  if (val.startsWith("PLACEHOLDER_")) {
    const rest = val.slice("PLACEHOLDER_".length).trim();
    if (rest && !placeholderIds.includes(rest)) placeholderIds.push(rest);
    return true;
  }
  if (val.startsWith("extend-failed-")) {
    const rest = val.slice("extend-failed-".length).trim();
    if (rest && !placeholderIds.includes(rest)) placeholderIds.push(rest);
    return true;
  }
  if (!target.includes(val)) target.push(val);
  return false;
}

/** Returns true when `token` equals `expected` or has the timeline clip ID form `<expected>-<index>`. */
function matchesClipIdToken(token: string, expected: string): boolean {
  const clean = token.trim();
  if (!clean || !expected) return false;
  if (clean === expected) return true;
  return (
    clean.startsWith(`${expected}-`) &&
    /^\d+$/.test(clean.slice(expected.length + 1))
  );
}

/** Inspects a candidate object in an Angular LView for clip identifiers and readiness flags. */
function inspectClipObject(cand: unknown, info: SceneClipInspection): void {
  if (
    !cand ||
    typeof cand !== "object" ||
    cand instanceof Node ||
    cand instanceof Error ||
    cand instanceof Map ||
    cand instanceof Set ||
    Array.isArray(cand)
  ) {
    return;
  }
  const rawType = String(readOwn(cand, "type") || "").trim();
  if (rawType.toUpperCase() === "SCENE") return;
  const lowType = rawType.toLowerCase();
  if (lowType === "extend-composing" || lowType === "failed") {
    info.isAuxiliaryItem = true;
    info.notReady = true;
  } else if (NOT_READY_CLIP_STATUS.test(lowType)) {
    info.notReady = true;
  }
  if (
    readOwn(cand, "kN") === true ||
    readOwn(cand, "isLoading") === true ||
    readOwn(cand, "loaded") === false ||
    Boolean(readOwn(cand, "AC"))
  ) {
    info.notReady = true;
  }
  for (const statusKey of ["od", "Zc", "status", "state"]) {
    const st = readOwn(cand, statusKey);
    if (typeof st === "string" && NOT_READY_CLIP_STATUS.test(st.trim())) {
      info.notReady = true;
    }
  }
  if (pushClipIdentifier(readOwn(cand, "workflowId"), info.workflowIds, info.placeholderIds)) {
    info.notReady = true;
  }
  for (const mediaKey of ["primaryMediaId", "mediaId"]) {
    if (pushClipIdentifier(readOwn(cand, mediaKey), info.mediaIds, info.placeholderIds)) {
      info.notReady = true;
    }
  }
  for (const clipKey of ["clipId", "gI"]) {
    if (pushClipIdentifier(readOwn(cand, clipKey), info.clipIds, info.placeholderIds)) {
      info.notReady = true;
    }
  }
  const hasClipShape =
    "workflowId" in cand ||
    "primaryMediaId" in cand ||
    "mediaId" in cand ||
    "clipId" in cand ||
    "gI" in cand ||
    "Jc" in cand ||
    "Pc" in cand ||
    "start" in cand ||
    "end" in cand;
  if (hasClipShape && pushClipIdentifier(readOwn(cand, "id"), info.clipIds, info.placeholderIds)) {
    info.notReady = true;
  }
}

/** Extracts all clip identifiers and readiness flags from one timeline clip element. */
function inspectSceneClipElement(clipEl: HTMLElement): SceneClipInspection {
  const info: SceneClipInspection = {
    workflowIds: [],
    clipIds: [],
    mediaIds: [],
    placeholderIds: [],
    notReady: false,
    isAuxiliaryItem: false,
  };
  const cls = clipEl.classList;
  if (cls.contains("extend-composing") || cls.contains("failed")) {
    info.isAuxiliaryItem = true;
    info.notReady = true;
  }
  if (
    cls.contains("pending-placeholder") ||
    cls.contains("is-extend-generating") ||
    cls.contains("loading") ||
    cls.contains("is-loading") ||
    cls.contains("clip-loading") ||
    cls.contains("unloaded") ||
    cls.contains("is-unloaded")
  ) {
    info.notReady = true;
  }
  if (
    clipEl.getAttribute("aria-busy") === "true" ||
    clipEl.getAttribute("aria-disabled") === "true" ||
    clipEl.hasAttribute("disabled") ||
    clipEl.getAttribute("data-loading") === "true" ||
    clipEl.getAttribute("data-loaded") === "false" ||
    clipEl.getAttribute("data-ready") === "false" ||
    NOT_READY_CLIP_STATUS.test(
      (clipEl.getAttribute("data-status") || clipEl.getAttribute("data-state") || "").trim(),
    )
  ) {
    info.notReady = true;
  }
  const busyChild = clipEl.querySelector(
    '.processing-shimmer, .extend-loading-overlay, .split-pending-overlay, .loading-spinner, mat-progress-spinner, mat-spinner, flow-error-tile, .extend-failed-tile, [aria-busy="true"]',
  );
  if (busyChild && (busyChild === clipEl || isVisibleOutsideNonComposer(busyChild))) {
    info.notReady = true;
  }

  const innerNodes = [
    clipEl,
    ...Array.from(clipEl.querySelectorAll("*")).filter((n) => !n.closest(NON_CLIP_CONTROLS)),
  ];
  const candidateLViews: unknown[][] = [];
  if (runtimeState.ngLViewMap instanceof Map) {
    for (const lv of runtimeState.ngLViewMap.values()) {
      if (isLiveLView(lv) && lv[0] instanceof Node && clipEl.contains(lv[0])) {
        candidateLViews.push(lv);
      }
    }
  }
  const seenSlots = new Set<object>();
  for (const node of innerNodes) {
    if (pushClipIdentifier(node.getAttribute("data-workflow-id"), info.workflowIds, info.placeholderIds)) {
      info.notReady = true;
    }
    for (const mAttr of ["data-media-id", "data-primary-media-id"]) {
      if (pushClipIdentifier(node.getAttribute(mAttr), info.mediaIds, info.placeholderIds)) {
        info.notReady = true;
      }
    }
    for (const cAttr of ["data-clip-id", "data-asset-id", "data-id", "id"]) {
      if (pushClipIdentifier(node.getAttribute(cAttr), info.clipIds, info.placeholderIds)) {
        info.notReady = true;
      }
    }
    const rawCtx = (node as NgContextCarrier).__ngContext__;
    const lv = resolveLView(node) ?? (Array.isArray(rawCtx) ? rawCtx : null);
    if (Array.isArray(lv)) {
      if (!(lv[0] instanceof Node) || clipEl.contains(lv[0])) candidateLViews.push(lv);
    } else if (rawCtx && typeof rawCtx === "object" && !(rawCtx instanceof Node)) {
      inspectClipObject(rawCtx, info);
    }
  }
  for (const lv of candidateLViews) {
    for (const rawSlot of lv) {
      const subItems = Array.isArray(rawSlot) ? rawSlot : [rawSlot];
      for (const slot of subItems) {
        if (!slot || typeof slot !== "object" || slot instanceof Node || Array.isArray(slot) || seenSlots.has(slot)) {
          continue;
        }
        seenSlots.add(slot);
        const stripClipId = readComponentInput(slot, "clipId");
        if (stripClipId.found && pushClipIdentifier(stripClipId.value, info.clipIds, info.placeholderIds)) {
          info.notReady = true;
        }
        inspectClipObject(slot, info);
        for (const wrapKey of ["$implicit", "Aa", "clip", "item", "data", "Jj"]) {
          const nested = readOwn(slot, wrapKey);
          if (nested && typeof nested === "object") inspectClipObject(nested, info);
        }
      }
    }
  }
  return info;
}

/** Checks whether `info` matches the requested clip `idStr` or `primaryStr` without workflow ID conflicts. */
function clipIdentityMatches(
  info: SceneClipInspection,
  idStr: string,
  primaryStr: string,
): { matches: boolean; exactAssetId: boolean } {
  if (!idStr && !primaryStr) return { matches: false, exactAssetId: false };
  if (idStr && info.workflowIds.length > 0) {
    const wfMatch = info.workflowIds.includes(idStr);
    return { matches: wfMatch, exactAssetId: wfMatch };
  }
  if (
    idStr &&
    (info.workflowIds.includes(idStr) ||
      info.clipIds.some((t) => matchesClipIdToken(t, idStr)) ||
      info.mediaIds.some((t) => matchesClipIdToken(t, idStr)) ||
      info.placeholderIds.some((t) => matchesClipIdToken(t, idStr)))
  ) {
    return { matches: true, exactAssetId: true };
  }
  if (
    primaryStr &&
    (info.mediaIds.some((t) => matchesClipIdToken(t, primaryStr)) ||
      info.clipIds.some((t) => matchesClipIdToken(t, primaryStr)) ||
      info.placeholderIds.some((t) => matchesClipIdToken(t, primaryStr)))
  ) {
    return { matches: true, exactAssetId: false };
  }
  return { matches: false, exactAssetId: false };
}

/** Collects distinct visible timeline clip container elements inside `searchRoot`. */
export function collectSceneClipElements(searchRoot: ParentNode): HTMLElement[] {
  const rawSet = new Set<HTMLElement>();
  for (const el of Array.from(searchRoot.querySelectorAll(CLIP_CONTAINER_SELECTOR))) {
    if (isVisibleOutsideNonComposer(el) && !el.closest(NON_CLIP_CONTROLS)) {
      rawSet.add(el);
    }
  }
  for (const el of Array.from(searchRoot.querySelectorAll("*"))) {
    if (!isVisibleOutsideNonComposer(el) || el.closest(NON_CLIP_CONTROLS)) continue;
    const container = el.closest(CLIP_CONTAINER_SELECTOR);
    if (
      container instanceof HTMLElement &&
      searchRoot.contains(container) &&
      isVisibleOutsideNonComposer(container) &&
      !container.closest(NON_CLIP_CONTROLS)
    ) {
      rawSet.add(container);
      continue;
    }
    if (el.hasAttribute("data-media-id") || el.hasAttribute("data-primary-media-id")) {
      rawSet.add(el);
    }
  }
  const all = Array.from(rawSet);
  const singleContainers = all.filter((el) => {
    const children = all.filter((other) => other !== el && el.contains(other));
    for (let i = 0; i < children.length; i += 1) {
      for (let j = i + 1; j < children.length; j += 1) {
        if (!children[i].contains(children[j]) && !children[j].contains(children[i])) {
          return false;
        }
      }
    }
    return true;
  });
  return singleContainers.filter(
    (el) => !singleContainers.some((anc) => anc !== el && anc.contains(el)),
  );
}

/** Finds all ready and not-ready clip elements matching `idStr` or `primaryStr` in `searchRoot`. */
function matchSceneClips(
  searchRoot: ParentNode,
  idStr: string,
  primaryStr: string,
): MatchedSceneClips {
  const allClips = collectSceneClipElements(searchRoot);
  const exactReady: HTMLElement[] = [];
  const primaryReady: HTMLElement[] = [];
  const notReadyMatches: HTMLElement[] = [];
  for (const clipEl of allClips) {
    const info = inspectSceneClipElement(clipEl);
    const match = clipIdentityMatches(info, idStr, primaryStr);
    if (!match.matches) continue;
    if (info.isAuxiliaryItem || info.notReady) {
      notReadyMatches.push(clipEl);
    } else if (match.exactAssetId) {
      exactReady.push(clipEl);
    } else {
      primaryReady.push(clipEl);
    }
  }
  return {
    allClips,
    readyMatches: exactReady.length > 0 ? exactReady : primaryReady,
    notReadyMatches,
  };
}

/** Returns true when a timeline clip container carries a positive DOM selection state. */
function isClipElementSelectedInDom(el: HTMLElement): boolean {
  if (el.getAttribute("aria-selected") === "false" || el.getAttribute("data-selected") === "false") {
    return false;
  }
  if (el.querySelector(".unselected-mask")) return false;
  return (
    el.classList.contains("selected") ||
    el.classList.contains("is-selected") ||
    el.classList.contains("active") ||
    el.getAttribute("aria-selected") === "true" ||
    el.getAttribute("aria-current") === "true" ||
    el.getAttribute("data-selected") === "true" ||
    el.hasAttribute("selected")
  );
}

/** Verifies that `sb` selects `targetClip` and marks it ready for editing. */
function verifySceneClipSelection(
  sb: ParentNode,
  targetClip: HTMLElement,
  allClips: HTMLElement[],
  idStr: string,
  primaryStr: string,
): SceneClipSelectionResult {
  const label = idStr || primaryStr;
  if (!isVisibleOutsideNonComposer(targetClip)) {
    return selectionFailure("scene_clip_not_selected", `Clip '${label}' is no longer visible in the scene timeline.`);
  }
  const targetInfo = inspectSceneClipElement(targetClip);
  if (!clipIdentityMatches(targetInfo, idStr, primaryStr).matches) {
    return selectionFailure("scene_clip_selection_mismatch", `Selected timeline element does not match clip '${label}'.`);
  }
  if (targetInfo.notReady) {
    return selectionFailure("scene_clip_not_loaded", `Clip '${label}' has not finished loading in the scene timeline.`);
  }
  if (
    targetClip.getAttribute("aria-selected") === "false" ||
    targetClip.getAttribute("data-selected") === "false" ||
    Boolean(targetClip.querySelector(".unselected-mask"))
  ) {
    return selectionFailure("scene_clip_not_selected", `Clip '${label}' is not selected in the scene timeline.`);
  }
  for (const other of allClips) {
    if (other === targetClip || targetClip.contains(other) || other.contains(targetClip)) {
      continue;
    }
    if (isClipElementSelectedInDom(other)) {
      return selectionFailure("scene_clip_selection_mismatch", `Another timeline clip is selected instead of '${label}'.`);
    }
  }

  const domProvesSelected = isClipElementSelectedInDom(targetClip);
  let componentProvesSelected = false;

  const mediaSharedInTimeline =
    Boolean(primaryStr) &&
    allClips.some((other) => {
      if (other === targetClip) return false;
      const otherInfo = inspectSceneClipElement(other);
      return (
        !otherInfo.isAuxiliaryItem &&
        (otherInfo.mediaIds.some((t) => matchesClipIdToken(t, primaryStr)) ||
          otherInfo.clipIds.some((t) => matchesClipIdToken(t, primaryStr)))
      );
    });

  const hostCandidates = [
    ...(sb instanceof Element ? [sb] : []),
    ...Array.from(
      sb.querySelectorAll(`flow-scene-timeline, ${EDIT_PROMPT_BOX_SELECTOR}, flow-base-prompt-box`),
    ).filter((el) => !el.closest(NON_COMPOSER_PANELS)),
  ];
  const hostSet = new Set<Element>(hostCandidates);
  const rawSlots: unknown[] = [...hostCandidates];
  for (const host of hostCandidates) {
    const rawCtx = (host as NgContextCarrier).__ngContext__;
    const lv = resolveLView(host) ?? (Array.isArray(rawCtx) ? rawCtx : null);
    if (Array.isArray(lv)) rawSlots.push(...lv);
    else if (rawCtx && typeof rawCtx === "object") rawSlots.push(rawCtx);
  }
  if (runtimeState.ngLViewMap instanceof Map) {
    for (const lv of runtimeState.ngLViewMap.values()) {
      if (
        isLiveLView(lv) &&
        lv[0] instanceof Element &&
        !lv[0].closest(NON_COMPOSER_PANELS) &&
        (lv[0] === sb || sb.contains(lv[0]))
      ) {
        rawSlots.push(...lv);
      }
    }
  }
  const seenObjs = new Set<object>();
  for (const rawSlot of rawSlots) {
    const subSlots = Array.isArray(rawSlot) ? rawSlot : [rawSlot];
    for (const slot of subSlots) {
      if (!slot || typeof slot !== "object" || Array.isArray(slot)) continue;
      if (slot instanceof Node && (!(slot instanceof Element) || !hostSet.has(slot))) continue;
      if (seenObjs.has(slot)) continue;
      seenObjs.add(slot);

      const loadingInput = readComponentInput(slot, "isClipLoading");
      if (loadingInput.found && loadingInput.value === true) {
        return selectionFailure("scene_clip_not_loaded", `Clip '${label}' has not finished loading in the editor.`);
      }
      const disabledReason = readComponentInput(slot, "submitDisabledReason");
      if (
        disabledReason.found &&
        typeof disabledReason.value === "string" &&
        /finish loading/i.test(disabledReason.value)
      ) {
        return selectionFailure("scene_clip_not_loaded", disabledReason.value.trim());
      }
      const placeholderInput = readComponentInput(slot, "placeholderText");
      if (
        placeholderInput.found &&
        typeof placeholderInput.value === "string" &&
        /select a clip to edit/i.test(placeholderInput.value)
      ) {
        return selectionFailure("scene_clip_not_selected", `Editor still prompts to select a clip instead of '${label}'.`);
      }

      for (const wfProp of ["selectedWorkflowId", "selectedClipId", "activeWorkflowId", "activeClipId"]) {
        if (!(wfProp in slot)) continue;
        const rawWf = readSignalOrValue(slot, wfProp);
        if (typeof rawWf === "string" && rawWf.trim()) {
          const val = rawWf.trim();
          const matchesTarget =
            (Boolean(idStr) && matchesClipIdToken(val, idStr)) ||
            (Boolean(primaryStr) && matchesClipIdToken(val, primaryStr)) ||
            targetInfo.clipIds.includes(val);
          if (!matchesTarget) {
            return selectionFailure("scene_clip_selection_mismatch", `Active scene clip is '${val}' instead of '${label}'.`);
          }
          if (!mediaSharedInTimeline || (Boolean(idStr) && val === idStr)) {
            componentProvesSelected = true;
          }
        }
      }

      const selClip = readComponentInput(slot, "selectedClip");
      if (selClip.found) {
        if (selClip.value === null || selClip.value === undefined) {
          return selectionFailure("scene_clip_not_selected", `No clip is loaded in the edit composer for '${label}'.`);
        }
        if (typeof selClip.value === "object") {
          const sc = selClip.value as object;
          const scWf = String(readOwn(sc, "workflowId") || "").trim();
          const scId = String(readOwn(sc, "id") || readOwn(sc, "clipId") || "").trim();
          const scMedia = String(readOwn(sc, "primaryMediaId") || readOwn(sc, "mediaId") || "").trim();
          if (scId.startsWith("PLACEHOLDER_")) {
            return selectionFailure("scene_clip_not_loaded", `Clip '${label}' has not finished loading in the edit composer.`);
          }
          if (scWf && idStr && scWf !== idStr) {
            return selectionFailure("scene_clip_selection_mismatch", `Edit composer targets workflow '${scWf}' instead of '${label}'.`);
          }
          if (scWf && idStr && scWf === idStr) componentProvesSelected = true;
          for (const tok of [scMedia, scId].filter(Boolean)) {
            const matchesKnown =
              (Boolean(idStr) && matchesClipIdToken(tok, idStr)) ||
              (Boolean(primaryStr) && matchesClipIdToken(tok, primaryStr)) ||
              targetInfo.clipIds.some((c) => matchesClipIdToken(tok, c)) ||
              targetInfo.mediaIds.some((m) => matchesClipIdToken(tok, m));
            if (
              !matchesKnown &&
              (Boolean(primaryStr) || targetInfo.clipIds.length > 0 || targetInfo.mediaIds.length > 0)
            ) {
              return selectionFailure("scene_clip_selection_mismatch", `Edit composer targets clip '${tok}' instead of '${label}'.`);
            }
            if (
              matchesKnown &&
              !mediaSharedInTimeline &&
              ((Boolean(idStr) && matchesClipIdToken(tok, idStr)) ||
                (Boolean(primaryStr) && matchesClipIdToken(tok, primaryStr)))
            ) {
              componentProvesSelected = true;
            }
          }
        }
      }

      const selMedia = readComponentInput(slot, "selectedClipMediaId");
      if (selMedia.found) {
        const sm = selMedia.value != null ? String(selMedia.value).trim() : "";
        if (!sm) {
          return selectionFailure("scene_clip_not_selected", `Edit composer has no selected clip media ID for '${label}'.`);
        }
        const matchesMedia =
          (Boolean(primaryStr) && sm === primaryStr) ||
          (Boolean(idStr) && sm === idStr) ||
          targetInfo.mediaIds.includes(sm);
        if (!matchesMedia && (Boolean(primaryStr) || targetInfo.mediaIds.length > 0)) {
          return selectionFailure("scene_clip_selection_mismatch", `Edit composer targets media '${sm}' instead of '${label}'.`);
        }
        if (!mediaSharedInTimeline && ((Boolean(primaryStr) && sm === primaryStr) || (Boolean(idStr) && sm === idStr))) {
          componentProvesSelected = true;
        }
      }
    }
  }

  const tb = findTextbox(true);
  if (tb) {
    const ph = (
      tb.getAttribute("placeholder") ||
      tb.getAttribute("data-placeholder") ||
      tb.getAttribute("aria-placeholder") ||
      ""
    ).trim();
    if (/select a clip to edit/i.test(ph)) {
      return selectionFailure("scene_clip_not_selected", `Editor textbox still asks to select a clip instead of '${label}'.`);
    }
  }

  if (!domProvesSelected && !componentProvesSelected) {
    return selectionFailure("scene_clip_selection_unverified", `Cannot verify selection of clip '${label}' in the scene timeline.`);
  }
  return { ok: true, selectedClipId: label };
}

/** Finds the unique matching clip in `sb` and verifies its active selection. */
export function verifySelectedSceneClipInBuilder(
  sb: ParentNode,
  idStr: string,
  primaryStr: string,
): SceneClipSelectionResult {
  const label = idStr || primaryStr;
  if (!label) {
    return selectionFailure("scene_clip_id_required", "A clip ID is required to select a scene clip.");
  }
  const searchRoot = sb.querySelector("flow-scene-timeline") || sb;
  const { allClips, readyMatches, notReadyMatches } = matchSceneClips(searchRoot, idStr, primaryStr);
  if (readyMatches.length === 0) {
    if (notReadyMatches.length > 0) {
      return selectionFailure("scene_clip_not_loaded", `Clip '${label}' has not finished loading in the scene timeline.`);
    }
    return selectionFailure("scene_clip_not_found", `Clip '${label}' is not present in the scene timeline.`);
  }
  if (readyMatches.length > 1) {
    return selectionFailure("scene_clip_ambiguous", `Multiple timeline clips match '${label}'.`);
  }
  return verifySceneClipSelection(sb, readyMatches[0], allClips, idStr, primaryStr);
}

/** Captures Angular's LView registry map from `sb` when numeric `__ngContext__` slots are unresolved. */
export async function ensureSceneBuilderLViewMap(sb: ParentNode): Promise<void> {
  const numericNodes = Array.from(sb.querySelectorAll("*"))
    .slice(0, 60)
    .filter((el) => typeof (el as NgContextCarrier).__ngContext__ === "number");
  if (numericNodes.length === 0) return;
  if (runtimeState.ngLViewMap instanceof Map) {
    const allResolved = numericNodes.every((el) => {
      const idx = (el as NgContextCarrier).__ngContext__ as number;
      const lv = runtimeState.ngLViewMap?.get(idx);
      return isLiveLView(lv) && (!(lv[0] instanceof Node) || el === lv[0] || sb.contains(lv[0]));
    });
    if (allResolved) return;
    runtimeState.ngLViewMap = null;
  }
  await withLViewMapCapture(async () => {
    const probes = Array.from(
      sb.querySelectorAll("[mattooltip], [cdkoverlayorigin], button[aria-label], .clip, [class*='clip']"),
    )
      .filter((el) => !el.closest(NON_COMPOSER_PANELS) && el.getClientRects().length > 0)
      .slice(0, 8);
    await hoverProbe(probes, 20);
  });
}

/** Selects the matching clip ID in `flow-scene-builder`, opens clip edit mode, and proves selection. */
export async function selectSceneClip(
  sb: ParentNode,
  idStr: string,
  primaryStr: string,
): Promise<SceneClipSelectionResult> {
  const label = idStr || primaryStr;
  if (!label) {
    return {
      ok: false,
      error: "scene_clip_id_required",
      detail: "A clip ID is required to select a scene clip.",
    };
  }

  await ensureSceneBuilderLViewMap(sb);

  let targetClip: HTMLElement | null = null;
  let allClips: HTMLElement[] = [];
  let sawNotReadyMatch = false;
  let sawAmbiguousMatch = false;

  for (let i = 0; i < 25; i += 1) {
    await ensureSceneBuilderLViewMap(sb);
    const searchRoot = sb.querySelector("flow-scene-timeline") || sb;
    const matched = matchSceneClips(searchRoot, idStr, primaryStr);
    allClips = matched.allClips;
    if (matched.readyMatches.length === 1) {
      targetClip = matched.readyMatches[0];
      sawAmbiguousMatch = false;
      break;
    }
    sawAmbiguousMatch = matched.readyMatches.length > 1;
    sawNotReadyMatch = matched.notReadyMatches.length > 0;
    await delay(100);
  }

  if (!targetClip) {
    if (sawAmbiguousMatch) {
      return selectionFailure("scene_clip_ambiguous", `Multiple timeline clips match '${label}'.`);
    }
    if (sawNotReadyMatch) {
      return selectionFailure("scene_clip_not_loaded", `Clip '${label}' has not finished loading in the scene timeline.`);
    }
    return selectionFailure("scene_clip_not_found", `Clip '${label}' is not present in the scene timeline.`);
  }

  let verified = verifySceneClipSelection(sb, targetClip, allClips, idStr, primaryStr);
  if (!verified.ok) {
    targetClip.scrollIntoView({ block: "nearest", inline: "center" });
    await withLViewMapCapture(async () => {
      targetClip.click();
      await delay(150);
    });
    for (let i = 0; i < 15; i += 1) {
      verified = verifySelectedSceneClipInBuilder(sb, idStr, primaryStr);
      if (verified.ok) break;
      await delay(100);
    }
  }
  if (!verified.ok) return verified;

  if (readComposerAlert(false)) return verified;

  if (!findTextbox(true) || Boolean(document.querySelector(".is-extend-mode, .extend-composing"))) {
    const editTrigger = Array.from(
      sb.querySelectorAll('button, [role="button"], [role="tab"]'),
    ).find((b): b is HTMLElement => {
      if (!isVisibleEnabled(b) || b.closest(NON_COMPOSER_PANELS)) return false;
      const lbl = (b.getAttribute("aria-label") || elText(b) || b.getAttribute("title") || "").trim();
      if (/done editing|delete|split|download/i.test(lbl)) return false;
      return /^(?:exit extend mode|edit(?:\s+(?:clip|video))?)$/i.test(lbl);
    });
    if (editTrigger) {
      editTrigger.click();
      await delay(300);
    }
  }

  return verifySelectedSceneClipInBuilder(sb, idStr, primaryStr);
}
