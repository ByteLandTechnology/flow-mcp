// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Bind the character preview panel and manage portrait and body preview slots.

import { readOwn, resolveLView, withLViewMapCapture } from "./angular";
import {
  clickButtonByRegex,
  delay,
  elText,
  hoverProbe,
  isVisibleEnabled,
  legacyMedia,
} from "./dom";
import { characterPreviewFormat } from "./frontend_builds";
import { runtimeState } from "./state";
import type { FlowMediaPayload, NgLView } from "./types";

/** Image slot in the character editor. */
export type CharacterSlot = "portrait" | "body";

/** Character preview panel used to open the native picker and read slot state. */
export interface CharacterPreview {
  /** Opens the picker for the active slot. */
  upload: () => unknown;
  /** Reads one slot's media record. */
  media: (slot: CharacterSlot) => FlowMediaPayload | null | undefined;
  /** Reads the source URL of the active slot. */
  source: () => unknown;
  /** Reads the loading state of the active slot. */
  busy: () => unknown;
}

/** Snapshot of character preview slot state read from component signals and DOM. */
export interface PreviewSlotState {
  /** Resolved preview component instance when mounted. */
  previewComp: CharacterPreview | null;
  /** Media record for the selected slot (`portrait` or `body`). */
  slotMedia: FlowMediaPayload | null | undefined;
  /** Trimmed slot media identifier string. */
  slotMediaId: string;
  /** Preview source URL reported by component signal. */
  compSrc: string;
  /** Preview `<img>` source attribute rendered in DOM. */
  imgSrc: string;
  /** True while image preview container is busy. */
  isAreaBusy: boolean;
}

/** Runs `fn` inside LView map capture when the registry map has not yet been discovered. */
export async function captureLViewAndClick(fn: () => void): Promise<void> {
  if (runtimeState.ngLViewMap instanceof Map) {
    fn();
    return;
  }
  await withLViewMapCapture(async () => {
    fn();
    await delay(250);
  });
}

/** Reads a signal or calls a method on the native preview panel. */
function callPanel(panel: object, name: string): unknown {
  const method = readOwn(panel, name);
  return typeof method === "function" ? method.call(panel) : undefined;
}

/** Finds the preview panel in a live Angular view and binds its methods. */
export function getCharacterPreviewInstance(): CharacterPreview | null {
  const format = characterPreviewFormat();
  const roots = document.querySelectorAll(
    "flow-character-preview-panel, flow-character-image-preview",
  );
  const seen = new Set<unknown>();
  for (const root of roots) {
    const startLv = resolveLView(root);
    if (!Array.isArray(startLv)) continue;
    const queue: Array<[NgLView, number]> = [[startLv, 0]];
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      const [lv, depth] = next;
      if (!Array.isArray(lv) || seen.has(lv)) continue;
      seen.add(lv);
      for (const slot of lv) {
        const lc = readOwn(slot, format.lifecycle);
        if (
          slot &&
          typeof slot === "object" &&
          !(slot instanceof Node) &&
          !Array.isArray(slot) &&
          !(slot instanceof Map) &&
          !(lc && typeof lc === "object" && readOwn(lc, "Va")) &&
          typeof readOwn(slot, format.upload) === "function" &&
          typeof readOwn(slot, format.marker) === "function"
        ) {
          return {
            upload: () => callPanel(slot, format.upload),
            media: (which) =>
              legacyMedia(
                callPanel(slot, format[which]) as FlowMediaPayload | null | undefined,
              ),
            source: () => callPanel(slot, format.source),
            busy: () => callPanel(slot, format.busy),
          };
        }
      }
      if (depth < 4) {
        if (Array.isArray(lv[3])) queue.push([lv[3], depth + 1]);
        if (Array.isArray(lv[15])) queue.push([lv[15], depth + 1]);
      }
    }
  }
  return null;
}

/** Normalizes character slot selector into `"portrait"` or `"body"`. */
export function normSlot(raw: unknown): CharacterSlot {
  return String(raw || "portrait").toLowerCase() === "body"
    ? "body"
    : "portrait";
}

/** Reads current slot media, preview URLs, and busy indicators for `slot`. */
export function readPreviewSlotState(slot: CharacterSlot): PreviewSlotState {
  const previewComp = getCharacterPreviewInstance();
  const slotMedia = previewComp?.media(slot);
  const slotMediaId = String(slotMedia?.id || "").trim();
  const compSrc = String(previewComp?.source() || "").trim();
  const imgSrc = (
    document
      .querySelector("flow-character-image-preview img.preview-image[src]")
      ?.getAttribute("src") || ""
  ).trim();
  const isAreaBusy =
    Boolean(
      document.querySelector(
        'flow-character-image-preview .image-area[aria-busy="true"]',
      ),
    ) || Boolean(previewComp?.busy());
  return { previewComp, slotMedia, slotMediaId, compSrc, imgSrc, isAreaBusy };
}

/** Dismisses active Flow snackbars so stale notifications do not mask results. */
export function dismissAllSnackbars(): boolean {
  let dismissed = false;
  for (const snack of document.querySelectorAll(
    "flow-snackbar, simple-snack-bar, mat-snack-bar-container",
  )) {
    if (clickButtonByRegex(/^dismiss$/i, snack)) dismissed = true;
  }
  return dismissed;
}

/** Finds a visible slot button, including the Create portrait and Create body states. */
export function findPreviewSlotButton(slot: CharacterSlot): HTMLButtonElement | undefined {
  const label = slot === "portrait" ? /\bportrait\b/i : /\bbody\b/i;
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      "flow-character-preview-panel flow-slot-chip-button button",
    ),
  ].find((button) => button.getClientRects().length > 0 && label.test(elText(button)));
}

/** Reports whether the requested slot controls the visible preview. */
export function isPreviewSlotSelected(slot: CharacterSlot): boolean {
  const button = findPreviewSlotButton(slot);
  if (button) return button.classList.contains("chip-button-active");
  return (
    slot === "portrait" &&
    !findPreviewSlotButton("body") &&
    Boolean(document.querySelector("flow-character-image-preview"))
  );
}

/** Probes preview controls inside LView capture so Angular reveals its view registry. */
export async function probePreviewControls(): Promise<void> {
  const controls = [
    ...document.querySelectorAll(
      "flow-character-preview-panel [mattooltip], flow-character-preview-panel button",
    ),
  ];
  await withLViewMapCapture(() => hoverProbe(controls.slice(0, 6)));
}

/** Infers whether `slot` holds media from preview slot chips and rendered image state. */
export function isPreviewSlotOccupiedDom(slot: CharacterSlot): boolean {
  const button = findPreviewSlotButton(slot);
  if (button) {
    const chip = button.closest("flow-slot-chip-button");
    if (chip?.querySelector("img[src]")) return true;
    const label = `${elText(button)} ${button.getAttribute("aria-label") || ""}`;
    if (/\bcreate\b/i.test(label)) return false;
    if (!button.classList.contains("chip-button-active")) return true;
    const previewImg = document
      .querySelector("flow-character-image-preview img.preview-image[src]")
      ?.getAttribute("src")
      ?.trim();
    if (previewImg) return true;
    const previewEl = document.querySelector("flow-character-image-preview");
    return !previewEl || !/\badd from project\b/i.test(elText(previewEl));
  }
  return (
    slot === "portrait" &&
    Boolean(
      document
        .querySelector("flow-character-image-preview img.preview-image[src]")
        ?.getAttribute("src")
        ?.trim(),
    )
  );
}

/** Selects the requested slot and waits for the preview controls. */
export async function selectPreviewSlot(
  slot: CharacterSlot,
  deadline: number,
): Promise<boolean> {
  let clicked: HTMLButtonElement | undefined;
  while (performance.now() < deadline) {
    if (isPreviewSlotSelected(slot)) return true;
    const button = findPreviewSlotButton(slot);
    if (isVisibleEnabled(button) && button !== clicked) {
      clicked = button;
      await captureLViewAndClick(() => button.click());
    }
    await delay(100);
  }
  return false;
}
