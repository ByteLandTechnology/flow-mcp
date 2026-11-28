// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Attach project assets, upload references, and generate character looks.

import {
  pickerAssetMatches,
  pickerElementMatches,
  readOwn,
  resolveLView,
  type PickerMatchTarget,
} from "./angular";
import {
  captureLViewAndClick,
  dismissAllSnackbars,
  findPreviewSlotButton,
  getCharacterPreviewInstance,
  isPreviewSlotOccupiedDom,
  isPreviewSlotSelected,
  normSlot,
  probePreviewControls,
  readPreviewSlotState,
  selectPreviewSlot,
  type CharacterPreview,
  type CharacterSlot,
} from "./character_preview";
import {
  clickButtonByRegex,
  delay,
  dismissOverlay,
  elText,
  findSnackbarMatch,
  fifeBase,
  isVisibleEnabled,
  pickTileUrl,
  setNativeValue,
} from "./dom";
import {
  characterPreviewFormat,
  frontendBuild,
  readBuildLabel,
} from "./frontend_builds";
import { writePromptBox } from "./prompt_writer";
import { runtimeState } from "./state";
import type { CharacterMediaOpRequest } from "./types";

/** Maximum wait for the editor to select and load an upload slot. */
const UPLOAD_SLOT_TIMEOUT_MS = 30_000;

/** Handles character uploads, project reference attachments, and look generation prompts. */
export async function characterMediaOp(
  req: CharacterMediaOpRequest,
): Promise<unknown> {
  const helper = runtimeState.store;
  const getMap = () => helper?.getTileMap?.();
  const action = String(req?.action || "").toLowerCase();

  if (action === "open_upload") {
    const wantSlot = normSlot(req?.slot);
    const deadline = performance.now() + UPLOAD_SLOT_TIMEOUT_MS;
    for (const prev of document.querySelectorAll("[data-flow-mcp-upload]")) {
      prev.removeAttribute("data-flow-mcp-upload");
    }
    if (dismissAllSnackbars()) await delay(100);
    if (!await selectPreviewSlot(wantSlot, deadline)) {
      return { ok: false, error: `character_${wantSlot}_slot_unavailable` };
    }

    const findPreviewUploadButton = (): HTMLElement | null => {
      for (const root of document.querySelectorAll(
        "flow-character-image-preview, flow-character-preview-panel",
      )) {
        const hit = Array.from(
          root.querySelectorAll('button, flow-button, [role="button"]'),
        ).find((el): el is HTMLElement => {
          if (
            el.closest(
              "flow-slot-chip-button, flow-character-form, flow-edit-character-footer, flow-character-prompt-box",
            ) ||
            !isVisibleEnabled(el)
          ) {
            return false;
          }
          const aria = (
            el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            ""
          ).trim();
          const raw = elText(el);
          const tail =
            raw
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean)
              .pop() || "";
          return (
            /^upload$|\bupload\b/i.test(aria) ||
            /^upload$|\bupload\b/i.test(raw) ||
            /^upload$|\bupload\b/i.test(tail)
          );
        });
        if (hit) return hit;
      }
      return null;
    };

    let state = readPreviewSlotState(wantSlot);
    if (!state.previewComp) {
      await probePreviewControls();
      state = readPreviewSlotState(wantSlot);
      if (!state.previewComp && frontendBuild(readBuildLabel())?.characterPreview) {
        return { ok: false, error: "character_preview_not_bound" };
      }
    }
    while (performance.now() < deadline) {
      if (!state.isAreaBusy &&
          (findPreviewUploadButton() || state.slotMediaId || state.imgSrc || state.compSrc)) break;
      await delay(100);
      state = readPreviewSlotState(wantSlot);
    }
    if (!isPreviewSlotSelected(wantSlot)) return { ok: false, error: "character_upload_slot_changed" };
    if (state.isAreaBusy) return { ok: false, error: "character_preview_busy" };
    const { previewComp, slotMediaId, compSrc, imgSrc } = state;
    const prevSrc = imgSrc || compSrc;
    const prevMediaId = slotMediaId;

    let capturedFileInput: HTMLInputElement | null = null;
    const origInputClick = HTMLInputElement.prototype.click;
    const origShowPicker =
      typeof HTMLInputElement.prototype.showPicker === "function"
        ? HTMLInputElement.prototype.showPicker
        : null;
    HTMLInputElement.prototype.click = function (this: HTMLInputElement): void {
      if (this.type === "file") { capturedFileInput = this; return; }
      origInputClick.call(this);
    };
    if (origShowPicker) {
      HTMLInputElement.prototype.showPicker = function (this: HTMLInputElement): void {
        if (this.type === "file") { capturedFileInput = this; return; }
        origShowPicker.call(this);
      };
    }
    try {
      const uploadBtn = findPreviewUploadButton();
      if (uploadBtn) {
        const inner = uploadBtn.tagName === "FLOW-BUTTON" ? uploadBtn.querySelector("button") : null;
        (inner instanceof HTMLElement ? inner : uploadBtn).click();
      } else if (previewComp && (prevMediaId || prevSrc)) {
        void previewComp.upload();
      } else {
        const error = prevSrc && !previewComp ? "character_preview_not_bound" : "upload_button_not_found";
        return { ok: false, error };
      }
      await delay(250);
    } finally {
      HTMLInputElement.prototype.click = origInputClick;
      if (origShowPicker) HTMLInputElement.prototype.showPicker = origShowPicker;
    }

    if (!capturedFileInput) return { ok: false, error: "character_file_input_not_captured" };
    const fileInput: HTMLInputElement = capturedFileInput;
    if (!document.contains(fileInput)) {
      fileInput.style.display = "none";
      document.body.appendChild(fileInput);
    }
    fileInput.setAttribute("data-flow-mcp-upload", "character");
    return {
      ok: true,
      selector: 'input[type="file"][data-flow-mcp-upload="character"]',
      prev_src: prevSrc,
      prev_media_id: prevMediaId,
      slot: wantSlot,
    };
  }

  if (action === "check_upload") {
    const slot = normSlot(req?.slot);
    if (!isPreviewSlotSelected(slot)) return { ok: false, error: "character_upload_slot_changed" };
    const consentDialog = document.querySelector("flow-upload-consent-dialog");
    if (consentDialog && clickButtonByRegex(/^(?:i agree,\s*do not show again|i agree)$/i, consentDialog)) {
      await delay(150);
      return { ok: true, done: false, accepted_consent: true };
    }
    const prevSrc = String(req?.prev_src || "").trim();
    const prevMediaId = String(req?.prev_media_id || "").trim();
    const { slotMedia, slotMediaId, compSrc, imgSrc, isAreaBusy } = readPreviewSlotState(slot);
    const newMedia = Boolean(slotMediaId && slotMediaId !== prevMediaId);
    const failedMedia = slotMedia?.nf === "UPLOAD_FAILED" || slotMedia?.Zc === "failed";
    const failSnack = findSnackbarMatch(/failed to upload image(?: to character)?/i);
    const uploadedSnack = findSnackbarMatch(/image uploaded to character/i);
    if ((newMedia && failedMedia) || (failSnack && !uploadedSnack)) {
      const detail = failSnack?.text.match(/failed to upload image(?: to character)?/i)?.[0];
      return { ok: false, error: "character_upload_failed", slot, detail };
    }
    if (
      !isAreaBusy &&
      ((imgSrc && imgSrc !== prevSrc) ||
        (newMedia && slotMedia?.Zc === "success" && compSrc) ||
        Boolean(uploadedSnack))
    ) {
      if (uploadedSnack) clickButtonByRegex(/^dismiss$/i, uploadedSnack.bar);
      return { ok: true, done: true, src: imgSrc || compSrc, media_id: slotMediaId };
    }
    return { ok: true, done: false };
  }

  if (action === "check_look") {
    const errSnack = findSnackbarMatch(/failed to generate|couldn't generate|unable to generate|policy|violat/i);
    if (errSnack) return { ok: false, error: errSnack.text };
    const errTile = document.querySelector("flow-character-image-preview flow-error-tile");
    if (errTile) {
      return { ok: false, error: elText(errTile) || "character_look_generation_failed" };
    }

    const prevSrc = String(req?.prev_src || "").trim();
    const prevMediaId = String(req?.prev_media_id || "").trim();
    const { slotMedia, slotMediaId, compSrc, imgSrc, isAreaBusy } = readPreviewSlotState(normSlot(req?.slot));

    if (slotMedia?.Zc === "failed" || slotMedia?.Zc === "canceled" || Boolean(slotMedia?.nf)) {
      return { ok: false, error: String(slotMedia?.nf || slotMedia?.Zc || "character_look_generation_failed") };
    }

    let footerBusy = false;
    const footerEl = document.querySelector("flow-edit-character-footer");
    const footerLv = footerEl ? resolveLView(footerEl) : null;
    const previewFmt = characterPreviewFormat();
    if (previewFmt && Array.isArray(footerLv)) {
      const { footerBusy: footerBusyKey } = previewFmt;
      for (const cand of footerLv) {
        try {
          const busyFn = readOwn(cand, footerBusyKey);
          if (typeof busyFn === "function" && Boolean(busyFn.call(cand))) {
            footerBusy = true;
            break;
          }
        } catch {
          // Ignore disposed footer getters.
        }
      }
    }

    const isBusy = footerBusy || isAreaBusy;
    if (!isBusy && ((slotMediaId && slotMediaId !== prevMediaId) || (imgSrc && imgSrc !== prevSrc))) {
      return { ok: true, done: true, media_id: slotMediaId, src: imgSrc || compSrc };
    }
    return { ok: true, done: false, busy: isBusy };
  }

  if (action !== "attach_and_look") {
    return { ok: false, error: `unknown_character_media_op:${action}` };
  }

  const charId = req?.character_id ? String(req.character_id).trim() : null;
  const applied: string[] = [];
  let completedAssets = 0;
  const previewSelector =
    "flow-character-preview-panel, flow-character-image-preview";
  if (
    !document.querySelector(previewSelector) &&
    document.querySelector("flow-character-edit-page")
  ) {
    for (let i = 0; i < 20 && !document.querySelector(previewSelector); i++) {
      await delay(100);
    }
  }
  const requiresBoundPreview = (): boolean =>
    Boolean(
      frontendBuild(readBuildLabel())?.characterPreview &&
        document.querySelector(previewSelector),
    );
  const ensurePreviewBound = async (): Promise<CharacterPreview | null> => {
    let comp = getCharacterPreviewInstance();
    if (!comp) {
      await probePreviewControls();
      comp = getCharacterPreviewInstance();
    }
    return comp;
  };
  let previewCompBefore = await ensurePreviewBound();
  if (!previewCompBefore && requiresBoundPreview()) {
    return {
      ok: false,
      error: "character_preview_not_bound",
      completed_assets: 0,
    };
  }

  if (Array.isArray(req?.asset_ids) && req.asset_ids.length > 0) {
    for (const [idx, aid] of req.asset_ids.entries()) {
      const targetTile = getMap()?.get(String(aid));
      const hasDisplayName = Boolean(targetTile?.displayName && String(targetTile.displayName).trim());
      const targetName = hasDisplayName && targetTile?.displayName ? String(targetTile.displayName).trim() : "";
      const targetPrimaryMediaId = targetTile?.primaryMediaId || targetTile?.Fb?.id || targetTile?.Fb?.mediaId || null;
      const targetUrl = pickTileUrl(targetTile);
      const targetFife = fifeBase(targetUrl);

      if (idx > 0) {
        previewCompBefore = await ensurePreviewBound();
        if (!previewCompBefore && requiresBoundPreview()) {
          return {
            ok: false,
            error: "character_preview_not_bound",
            applied,
            completed_assets: completedAssets,
          };
        }
      }
      const hasSlotMedia = (slot: CharacterSlot): boolean => {
        if (previewCompBefore) {
          const media = previewCompBefore.media(slot);
          return Boolean(media?.id || media?.mediaId);
        }
        return isPreviewSlotOccupiedDom(slot);
      };
      const portraitOccupied = hasSlotMedia("portrait");
      const bodyOccupied = hasSlotMedia("body");
      let wantBodySlot = false;
      if (portraitOccupied && !bodyOccupied) {
        const bodyBtn = findPreviewSlotButton("body");
        if (isVisibleEnabled(bodyBtn)) {
          wantBodySlot = true;
          if (!bodyBtn.classList.contains("chip-button-active")) {
            await captureLViewAndClick(() => bodyBtn.click());
            await delay(250);
          }
        }
      }
      previewCompBefore ??= getCharacterPreviewInstance();
      const prevSlotMedia = wantBodySlot
        ? previewCompBefore?.media("body")
        : previewCompBefore?.media("portrait");
      const prevSlotMediaId = String(prevSlotMedia?.id || "").trim();
      const prevPreviewSrc = String(
        document
          .querySelector("flow-character-image-preview img.preview-image[src]")
          ?.getAttribute("src") ||
          previewCompBefore?.source() ||
          "",
      ).trim();

      dismissAllSnackbars();

      const imageFrame = document.querySelector(
        "flow-character-image-preview .image-frame",
      );
      if (imageFrame) {
        const fr = imageFrame.getBoundingClientRect();
        imageFrame.dispatchEvent(
          new MouseEvent("mouseenter", {
            bubbles: false,
            clientX: fr.left + Math.max(2, fr.width / 2),
            clientY: fr.top + Math.max(2, fr.height / 2),
          }),
        );
        await delay(120);
      }

      let clickedFromProject = false;
      await captureLViewAndClick(() => {
        clickedFromProject = clickButtonByRegex(
          /\badd from project\b/i,
          document,
        );
      });
      if (!clickedFromProject) {
        let openedAdd = false;
        await captureLViewAndClick(() => {
          openedAdd =
            clickButtonByRegex(/\badd to character\b/i, document) ||
            (() => {
              const el = Array.from(
                document.querySelectorAll("flow-add-menu button"),
              ).find(
                (btn): btn is HTMLElement =>
                  !btn.closest("flow-character-form") && isVisibleEnabled(btn),
              );
              if (el) {
                el.click();
                return true;
              }
              return false;
            })();
        });
        if (!openedAdd) {
          return {
            ok: false,
            error: "add_to_character_button_not_found",
            id: charId,
          };
        }
        await delay(220);
        if (!clickButtonByRegex(/\badd from project\b/i, document)) {
          await dismissOverlay();
          return {
            ok: false,
            error: "add_from_project_menu_not_found",
            id: charId,
          };
        }
      }

      let overlay: Element | null = null;
      for (let i = 0; i < 20; i++) {
        overlay =
          Array.from(
            document.querySelectorAll(
              'flow-media-picker-dialog, [role="dialog"], .cdk-overlay-pane, [role="listbox"]',
            ),
          ).find(
            (el) =>
              !el.querySelector(".loading-container") &&
              Boolean(
                el.querySelector(
                  'flow-add-menu-asset-item, flow-grid-tile-container, [role="option"], img[src]',
                ),
              ),
          ) || null;
        if (overlay) break;
        await delay(150);
      }
      const overlayRoot: ParentNode = overlay || document;

      const search = document.querySelector(
        'input[aria-label="Search assets"], input[placeholder*="Search" i]',
      );
      if (
        hasDisplayName &&
        (search instanceof HTMLInputElement ||
          search instanceof HTMLTextAreaElement) &&
        isVisibleEnabled(search)
      ) {
        search.focus();
        setNativeValue(search, targetName);
        await delay(300);
      }

      const lowName = hasDisplayName ? targetName.toLowerCase() : "";
      const matchTarget: PickerMatchTarget = {
        id: String(aid),
        primaryMediaId: targetPrimaryMediaId,
        lowName,
        url: targetUrl,
        fife: targetFife,
      };
      const matchesTarget = (el: Element): boolean =>
        pickerElementMatches(el, matchTarget, "img[src]");

      const assetMenuItems = Array.from(
        overlayRoot.querySelectorAll("flow-add-menu-asset-item"),
      );
      let hit: Element | null = assetMenuItems.find(matchesTarget) || null;
      if (hit) {
        hit = hit.closest("button") || hit;
      } else {
        const items = Array.from(
          overlayRoot.querySelectorAll(
            'flow-grid-tile-container, [role="option"], [data-testid*="asset"], [class*="tile"], button, [role="button"]',
          ),
        );
        hit = items.find(matchesTarget) || null;
      }

      let picked = false;
      if (hit instanceof HTMLElement) {
        hit.click();
        picked = true;
      } else {
        const popEl =
          overlayRoot.querySelector("flow-add-menu-popover-content") ||
          document.querySelector("flow-add-menu-popover-content");
        const popLv = popEl ? resolveLView(popEl) : null;
        const previewFmt = characterPreviewFormat();
        if (previewFmt && Array.isArray(popLv)) {
          const { pickerAssets, pickerSelect } = previewFmt;
          for (const cand of popLv) {
            const listFn = readOwn(cand, pickerAssets);
            const pickFn = readOwn(cand, pickerSelect);
            if (typeof listFn !== "function" || typeof pickFn !== "function") {
              continue;
            }
            const list = listFn.call(cand) as unknown[];
            const m = Array.isArray(list)
              ? list.find((a) => pickerAssetMatches(a, matchTarget)) ||
                (lowName
                  ? list.find((a) =>
                      String(
                        readOwn(a, "title") || readOwn(a, "displayName") || "",
                      )
                        .toLowerCase()
                        .includes(lowName),
                    )
                  : null)
              : null;
            if (m) {
              pickFn.call(cand, m, new MouseEvent("click"));
              picked = true;
              break;
            }
          }
        }
      }

      if (!picked) {
        await dismissOverlay();
        return { ok: false, error: `reference_asset_not_found:${aid}` };
      }
      await delay(250);
      clickButtonByRegex(
        /^(?:add media|add to character|add|done|confirm|select)$/i,
        overlayRoot,
      );

      let refAdded = false;
      for (let i = 0; i < 40; i++) {
        await delay(250);
        const failAttach = findSnackbarMatch(
          /failed to add image|failed to update character/i,
        );
        if (failAttach) {
          await dismissOverlay();
          return { ok: false, error: failAttach.text, id: charId };
        }
        const okAttach = findSnackbarMatch(
          /image added to character|added to character/i,
        );
        if (okAttach) {
          clickButtonByRegex(/^dismiss$/i, okAttach.bar);
          refAdded = true;
          break;
        }

        const stNow = readPreviewSlotState(wantBodySlot ? "body" : "portrait");
        if (!stNow.isAreaBusy) {
          if (
            (stNow.slotMediaId && stNow.slotMediaId !== prevSlotMediaId) ||
            ((stNow.imgSrc || stNow.compSrc) &&
              (stNow.imgSrc || stNow.compSrc) !== prevPreviewSrc)
          ) {
            refAdded = true;
            break;
          }
        }
      }
      await dismissOverlay();
      applied.push(refAdded ? `ref:${aid}` : `ref_clicked:${aid}`);
      completedAssets = idx + 1;
    }
  }

  let lookSubmitPoint: { x: number; y: number } | null = null;
  let lookMeta: Record<string, string> = {};
  if (req?.look_prompt) {
    const footerRoot = document.querySelector(
      "flow-edit-character-footer, flow-character-prompt-box",
    );
    const tb =
      footerRoot?.querySelector(
        '.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"], textarea',
      ) ||
      Array.from(
        document.querySelectorAll(
          '.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"], textarea',
        ),
      ).find((el) => !el.closest("flow-character-form")) ||
      null;
    if (!(tb instanceof HTMLElement)) {
      return { ok: false, error: "character_prompt_box_not_found", id: charId };
    }
    const activeBodyChip = Array.from(
      document.querySelectorAll(
        "flow-character-preview-panel flow-slot-chip-button button.chip-button.chip-button-active",
      ),
    ).some((b) => /\bbody\b/i.test(elText(b)));
    const lookSlot: "portrait" | "body" = activeBodyChip ? "body" : "portrait";
    let beforeLook = readPreviewSlotState(lookSlot);
    if (!beforeLook.previewComp) {
      await probePreviewControls();
      beforeLook = readPreviewSlotState(lookSlot);
      if (!beforeLook.previewComp && requiresBoundPreview()) {
        return {
          ok: false,
          error: "character_preview_not_bound",
          applied,
          completed_assets: completedAssets,
        };
      }
    }
    const prevLookMediaId = beforeLook.slotMediaId;
    const prevLookSrc = beforeLook.imgSrc || beforeLook.compSrc;

    await writePromptBox(tb, req.look_prompt, {
      seeds: [
        document.querySelector("flow-character-prompt-box"),
        document.querySelector("flow-edit-character-footer"),
      ],
      excludeSelector: "flow-prompt-box",
      hoverScopeSelector: "flow-character-prompt-box",
      trySettingsClick: false,
    });
    const btnRoot: ParentNode = footerRoot || document;
    let startBtn: HTMLElement | null = null;
    for (let i = 0; i < 40; i++) {
      const exact = btnRoot.querySelector('button[aria-label="Start generation"]');
      if (isVisibleEnabled(exact)) {
        startBtn = exact;
        break;
      }
      const cand = Array.from(
        btnRoot.querySelectorAll("button, [role='button']"),
      ).find((b): b is HTMLElement => {
        if (!isVisibleEnabled(b)) return false;
        if (
          b.closest(
            "flow-character-form, .cdk-overlay-pane, [role='menu'], [role='listbox']",
          )
        ) {
          return false;
        }
        const lbl = (b.getAttribute("aria-label") || elText(b)).trim();
        if (/select model|format|personal_recommendations/i.test(lbl)) {
          return false;
        }
        return /\b(?:start generation|generate|create|arrow_forward)\b/i.test(
          lbl,
        );
      });
      if (cand) {
        startBtn = cand;
        break;
      }
      await delay(100);
    }
    if (!startBtn) {
      const exactDisabled = btnRoot.querySelector(
        'button[aria-label="Start generation"]',
      );
      return {
        ok: false,
        error: exactDisabled
          ? "character_generate_button_disabled"
          : "character_generate_button_not_found",
        id: charId,
      };
    }
    startBtn.scrollIntoView({ block: "center", inline: "nearest" });
    await delay(40);
    const r = startBtn.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) {
      return {
        ok: false,
        error: "character_generate_button_zero_rect",
        id: charId,
      };
    }
    lookSubmitPoint = {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
    };
    lookMeta = {
      look_slot: lookSlot,
      prev_look_media_id: prevLookMediaId,
      prev_look_src: prevLookSrc,
    };
    applied.push("look_prompt_prepared");
    await delay(100);
  }

  return {
    ok: true,
    id: charId,
    applied,
    ...lookMeta,
    ...(lookSubmitPoint ? { look_submit_point: lookSubmitPoint } : {}),
  };
}
