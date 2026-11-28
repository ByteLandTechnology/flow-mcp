// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Slot selection, loading overlay guards, image deletion, and asset picker helpers on the character preview panel.

import { withLViewMapCapture } from "./angular";
import { delay, dismissOverlay, elText, isVisibleEnabled } from "./dom";
import { runtimeState } from "./state";

/** Image slot name on the character preview panel. */
export type CharacterImageSlot = "portrait" | "body";

/** Result from clearing one character image slot. */
export type CharacterSlotClearResult =
  | {
      /** Ready state. */
      ok: true;
      /** True when the slot image was deleted. */
      deleted: boolean;
      /** True when the slot was already empty. */
      empty?: true;
    }
  | {
      /** Error state. */
      ok: false;
      /** Tool error code. */
      error: string;
    };

/** Result from opening the project asset picker for the selected image slot. */
export type SlotPickerOpenResult =
  | {
      /** Picker opened. */
      ok: true;
    }
  | {
      /** Picker failed. */
      ok: false;
      /** Tool error code. */
      error: string;
    };

/** Selector that matches containers excluded from preview-panel slot queries. */
const SLOT_EXCLUDE_SEL =
  "flow-character-prompt-box, flow-edit-character-footer, flow-character-form, flow-slot-chip-button";

/** Maximum wait for a character slot loading overlay to clear. */
const SLOT_OVERLAY_TIMEOUT_MS = 20_000;

/** Returns the character preview panel root outside `flow-character-prompt-box`, or null. */
function previewPanelRoot(): Element | null {
  const panel = document.querySelector("flow-character-preview-panel");
  if (panel && !panel.closest("flow-character-prompt-box")) return panel;
  const preview = document.querySelector("flow-character-image-preview");
  return preview && !preview.closest("flow-character-prompt-box")
    ? preview
    : null;
}

/** Returns the `flow-character-image-preview` element inside `previewPanelRoot`, or null. */
function slotPreviewElement(): Element | null {
  const root = previewPanelRoot();
  if (!root) return null;
  return root.matches("flow-character-image-preview")
    ? root
    : root.querySelector("flow-character-image-preview");
}

/** Finds the visible `portrait` or `body` chip button inside `flow-character-preview-panel`. */
function findSlotChipButton(slot: CharacterImageSlot): HTMLButtonElement | null {
  const label = slot === "portrait" ? /\bportrait\b/i : /\bbody\b/i;
  return (
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "flow-character-preview-panel flow-slot-chip-button button",
      ),
    ).find(
      (btn) =>
        !btn.closest("flow-character-prompt-box, flow-character-form") &&
        btn.getClientRects().length > 0 &&
        label.test(elText(btn)),
    ) || null
  );
}

/** Returns true when `el` is disabled via HTML `disabled`, `aria-disabled`, or Material classes. */
function isButtonDisabled(el: HTMLElement): boolean {
  return (
    (el instanceof HTMLButtonElement && el.disabled) ||
    el.hasAttribute("disabled") ||
    el.getAttribute("aria-disabled") === "true" ||
    el.classList.contains("mat-mdc-button-disabled") ||
    el.classList.contains("mdc-button--disabled")
  );
}

/** Returns true when `slot` controls the visible character image preview. */
function isCharacterSlotSelected(slot: CharacterImageSlot): boolean {
  const chipBtn = findSlotChipButton(slot);
  if (chipBtn) return chipBtn.classList.contains("chip-button-active");
  return (
    slot === "portrait" &&
    !findSlotChipButton("body") &&
    Boolean(slotPreviewElement())
  );
}

/** Returns true while `flow-soupy-overlay` or `.image-area[aria-busy="true"]` covers `root`. */
function hasSlotLoadingOverlay(root: Element): boolean {
  const scope = previewPanelRoot() ?? root;
  for (const ov of Array.from(scope.querySelectorAll("flow-soupy-overlay"))) {
    if (ov.closest("flow-character-prompt-box")) continue;
    if (!(ov instanceof HTMLElement)) return true;
    const style = getComputedStyle(ov);
    if (
      !ov.hasAttribute("hidden") &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    ) {
      return true;
    }
  }
  return Boolean(scope.querySelector('.image-area[aria-busy="true"]'));
}

/** Dispatches hover events on `.image-frame` so Flow mounts `.top-actions` controls. */
async function hoverSlotImageFrame(preview: Element): Promise<void> {
  const frame = preview.querySelector(".image-frame");
  if (!frame || frame.closest("flow-character-prompt-box")) return;
  const rect = frame.getBoundingClientRect();
  const init = {
    bubbles: false,
    clientX: rect.left + Math.max(2, rect.width / 2),
    clientY: rect.top + Math.max(2, rect.height / 2),
  };
  frame.dispatchEvent(new PointerEvent("pointerenter", init));
  frame.dispatchEvent(new MouseEvent("mouseenter", init));
  await delay(100);
}

/** Runs `fn` inside Angular LView map capture when the registry map is not yet bound. */
async function clickWithLViewCapture(
  fn: () => void,
  waitMs = 150,
): Promise<void> {
  if (runtimeState.ngLViewMap instanceof Map) {
    fn();
    return;
  }
  await withLViewMapCapture(async () => {
    fn();
    await delay(waitMs);
  });
}

/** Returns true when the requested preview slot holds media rather than an empty add state. */
function isSelectedSlotOccupied(
  slot: CharacterImageSlot,
  preview: Element,
): boolean {
  const chipBtn = findSlotChipButton(slot);
  if (chipBtn) {
    if (chipBtn.closest("flow-slot-chip-button")?.querySelector("img[src]")) {
      return true;
    }
    const label = `${elText(chipBtn)} ${chipBtn.getAttribute("aria-label") || ""}`;
    if (
      !chipBtn.classList.contains("chip-button-active") ||
      /\bcreate\b/i.test(label)
    ) {
      return false;
    }
  }
  return Boolean(
    preview.querySelector("img.preview-image[src]")?.getAttribute("src")?.trim() ||
      preview.querySelector('button[aria-label="Delete image"]'),
  );
}

/** Returns true when `slot` renders either empty-slot controls or occupied-slot media. */
function isSlotControlsSettled(
  slot: CharacterImageSlot,
  preview: Element,
): boolean {
  const chipBtn = findSlotChipButton(slot);
  if (
    isSelectedSlotOccupied(slot, preview) ||
    (chipBtn &&
      /\bcreate\b/i.test(
        `${elText(chipBtn)} ${chipBtn.getAttribute("aria-label") || ""}`,
      ))
  ) {
    return true;
  }
  const scope = previewPanelRoot() ?? preview;
  return (
    /\b(?:add from project|add to character|upload)\b/i.test(elText(preview)) ||
    Array.from(
      scope.querySelectorAll("flow-add-menu, button, flow-button"),
    ).some(
      (el) =>
        !el.closest(SLOT_EXCLUDE_SEL) &&
        (el.tagName === "FLOW-ADD-MENU" ||
          /\b(?:add from project|add to character|upload)\b/i.test(
            `${el.getAttribute("aria-label") || ""} ${elText(el)}`,
          )),
    )
  );
}

/** Selects `slot` (`portrait` or `body`) and waits until `flow-soupy-overlay` clears. */
export async function waitForCharacterSlot(
  slot: CharacterImageSlot = "portrait",
): Promise<boolean> {
  const deadline = globalThis.performance.now() + SLOT_OVERLAY_TIMEOUT_MS;
  let disabledTicks = 0;
  let missingTicks = 0;
  while (globalThis.performance.now() < deadline) {
    const preview = slotPreviewElement();
    if (!previewPanelRoot() || !preview) {
      await delay(100);
      continue;
    }
    const chipBtn = findSlotChipButton(slot);
    if (chipBtn) {
      missingTicks = 0;
      if (!chipBtn.classList.contains("chip-button-active")) {
        if (isButtonDisabled(chipBtn) || !isVisibleEnabled(chipBtn)) {
          disabledTicks += 1;
          if (!hasSlotLoadingOverlay(preview) && disabledTicks >= 3) {
            return false;
          }
          await delay(100);
          continue;
        }
        disabledTicks = 0;
        await clickWithLViewCapture(() => chipBtn.click(), 150);
        await delay(150);
        continue;
      }
      disabledTicks = 0;
    } else if (slot === "body" || Boolean(findSlotChipButton("body"))) {
      missingTicks += 1;
      if (!hasSlotLoadingOverlay(preview) && missingTicks >= 3) {
        return false;
      }
      await delay(100);
      continue;
    }
    if (!hasSlotLoadingOverlay(preview) && isSlotControlsSettled(slot, preview)) {
      await hoverSlotImageFrame(preview);
      if (isCharacterSlotSelected(slot) && !hasSlotLoadingOverlay(preview)) {
        return true;
      }
    }
    await delay(100);
  }
  return false;
}

/** Selects `slot`, waits for `flow-soupy-overlay` to clear, and deletes its image when replaceable. */
export async function clearCharacterSlot(
  slot: CharacterImageSlot = "portrait",
): Promise<CharacterSlotClearResult> {
  const ready = await waitForCharacterSlot(slot);
  const preview = slotPreviewElement();
  if (!preview) {
    return { ok: false, error: `character_${slot}_slot_unavailable` };
  }
  if (!ready || !isCharacterSlotSelected(slot)) {
    return {
      ok: false,
      error: hasSlotLoadingOverlay(preview)
        ? "character_slot_overlay_timeout"
        : `character_${slot}_slot_unavailable`,
    };
  }
  await hoverSlotImageFrame(preview);
  if (!isCharacterSlotSelected(slot)) {
    return { ok: false, error: `character_${slot}_slot_unavailable` };
  }
  const del = Array.from(
    preview.querySelectorAll<HTMLElement>('button[aria-label="Delete image"]'),
  ).find((btn) => !btn.closest("flow-character-prompt-box, flow-character-form"));
  const occupied = isSelectedSlotOccupied(slot, preview);
  if (!del) {
    return occupied
      ? { ok: false, error: "character_slot_occupied" }
      : { ok: true, deleted: false, empty: true };
  }
  if (isButtonDisabled(del)) {
    return { ok: false, error: "character_slot_occupied" };
  }
  del.click();
  for (let i = 0; i < 30; i++) {
    await delay(100);
    const confirmBtn = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".cdk-overlay-pane button, [role='dialog'] button",
      ),
    ).find((b) => isVisibleEnabled(b) && /^delete$/i.test(elText(b).trim()));
    if (confirmBtn) {
      confirmBtn.click();
      break;
    }
  }
  for (let i = 0; i < 60; i++) {
    await delay(100);
    const currentPreview = slotPreviewElement();
    if (!currentPreview || hasSlotLoadingOverlay(currentPreview)) continue;
    const chipBtn = findSlotChipButton(slot);
    if (slot === "body" && !chipBtn) return { ok: true, deleted: true };
    if (chipBtn && !chipBtn.classList.contains("chip-button-active")) {
      const label = `${elText(chipBtn)} ${chipBtn.getAttribute("aria-label") || ""}`;
      if (
        /\bcreate\b/i.test(label) ||
        !chipBtn.closest("flow-slot-chip-button")?.querySelector("img[src]")
      ) {
        return { ok: true, deleted: true };
      }
      if (isVisibleEnabled(chipBtn) && !isButtonDisabled(chipBtn)) {
        chipBtn.click();
      }
      continue;
    }
    if (
      /add from project/i.test(elText(currentPreview)) ||
      !isSelectedSlotOccupied(slot, currentPreview)
    ) {
      return { ok: true, deleted: true };
    }
  }
  return { ok: false, error: "portrait_delete_not_confirmed" };
}

/** Clicks a visible enabled button matching `re` inside `root` while excluding `flow-character-prompt-box`. */
function clickScopedSlotButton(re: RegExp, root: ParentNode): boolean {
  const hit = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, flow-button, [role="button"], [role="menuitem"]',
    ),
  ).find(
    (el) =>
      !el.closest(SLOT_EXCLUDE_SEL) &&
      !isButtonDisabled(el) &&
      isVisibleEnabled(el) &&
      re.test(`${el.getAttribute("aria-label") || ""} ${elText(el)}`.trim()),
  );
  if (!hit) return false;
  const inner =
    hit.tagName === "FLOW-BUTTON" ? hit.querySelector("button") : null;
  if (inner instanceof HTMLElement && isButtonDisabled(inner)) return false;
  (inner instanceof HTMLElement ? inner : hit).click();
  return true;
}

/** Opens the "Add from project" picker for `slot` inside `flow-character-preview-panel`. */
export async function openSlotProjectPicker(
  slot: CharacterImageSlot,
): Promise<SlotPickerOpenResult> {
  const ready = await waitForCharacterSlot(slot);
  const root = previewPanelRoot();
  const preview = slotPreviewElement();
  if (!root || !preview) {
    return { ok: false, error: `character_${slot}_slot_unavailable` };
  }
  if (!ready || !isCharacterSlotSelected(slot)) {
    return {
      ok: false,
      error: hasSlotLoadingOverlay(preview)
        ? "character_slot_overlay_timeout"
        : `character_${slot}_slot_unavailable`,
    };
  }
  let clickedDirect = false;
  await clickWithLViewCapture(() => {
    clickedDirect = clickScopedSlotButton(/\badd from project\b/i, root);
  }, 250);
  if (clickedDirect) return { ok: true };

  let openedMenu = false;
  await clickWithLViewCapture(() => {
    if (clickScopedSlotButton(/\badd to character\b/i, root)) {
      openedMenu = true;
      return;
    }
    const menuBtn = Array.from(
      root.querySelectorAll<HTMLElement>("flow-add-menu button"),
    ).find(
      (btn) =>
        !btn.closest(SLOT_EXCLUDE_SEL) &&
        !isButtonDisabled(btn) &&
        isVisibleEnabled(btn),
    );
    if (menuBtn) {
      menuBtn.click();
      openedMenu = true;
    }
  }, 250);
  if (!openedMenu) {
    return {
      ok: false,
      error: isSelectedSlotOccupied(slot, preview)
        ? "character_slot_occupied"
        : "add_to_character_button_not_found",
    };
  }
  await delay(220);
  const menuClicked =
    Array.from(
      document.querySelectorAll(
        ".cdk-overlay-pane, [role='menu'], [role='dialog']",
      ),
    ).some((pane) => clickScopedSlotButton(/\badd from project\b/i, pane)) ||
    clickScopedSlotButton(/\badd from project\b/i, root);
  if (!menuClicked) {
    await dismissOverlay();
    return { ok: false, error: "add_from_project_menu_not_found" };
  }
  return { ok: true };
}
