// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Attach ingredient assets or characters and populate the generation prompt box.

import {
  isLiveLView,
  pickerAssetMatches,
  pickerElementMatches,
  readOwn,
  resolveLView,
  withLViewMapCapture,
  type PickerMatchTarget,
} from "./angular";
import {
  closeSettingsAndMenus,
  ensureManualComposer,
  findLiveBasePromptBox,
  findProjectPageInstance,
  findPromptBoxHost,
  findTextbox,
  settingsOpen,
} from "./composer";
import {
  EDIT_PROMPT_BOX_SELECTOR,
  EXCLUDED_COMPOSER_SELECTOR,
  isEditContext,
  isExcludedComposerNode,
} from "./edit_composer";
import {
  characterLooksOf,
  cleanMediaId,
  delay,
  elText,
  fifeBase,
  hoverProbe,
  isVisibleEnabled,
  pickTileUrl,
  setNativeValue,
} from "./dom";
import { writePromptBox } from "./prompt_writer";
import { runtimeState } from "./state";
import type { FlowTile, GenerationConfig, NgLView } from "./types";

/** Normalized target ingredient asset or character descriptor. */
interface IngredientTarget {
  /** Tile identifier or fallback match key. */
  id: string;
  /** Primary media identifier when known. */
  primaryMediaId: string | number | null;
  /** True when a non-empty display name is present for search filtering. */
  hasDisplayName: boolean;
  /** Display name or fallback identifier. */
  name: string;
  /** Preferred image/video preview URL for visual matching. */
  url: string | null;
  /** Resolved project tile reference when present. */
  tile: FlowTile | null;
  /** True when the caller supplied a character name or ID. */
  character?: boolean;
}

/** Checks whether a prompt item refers to the exact requested asset or character. */
function itemMatchesTarget(item: unknown, target: IngredientTarget): boolean {
  const ids = ["id", "workflowId", "entityId", "mediaId", "primaryMediaId", "Oc"]
    .map((field) => readOwn(item, field))
    .map((value) => cleanMediaId(typeof value === "number" ? String(value) : value))
    .filter(Boolean);
  const primary = target.primaryMediaId == null ? "" : cleanMediaId(String(target.primaryMediaId));
  if (ids.includes(cleanMediaId(target.id)) || (primary && ids.includes(primary))) return true;
  const name = readOwn(item, "displayName");
  return Boolean(target.character && !target.tile &&
    target.hasDisplayName && typeof name === "string" &&
    name.trim().toLowerCase() === target.name.toLowerCase());
}

/** Returns true while a prompt item is loading or when it cannot be submitted. */
function itemNotReady(item: unknown): boolean {
  const invalid = /^(?:INVALID|ERROR|FAILED|PENDING|LOADING)(?:_|$)/i;
  return readOwn(item, "isLoading") === true ||
    ["Rp", "tl"].some((field) => {
      const state = readOwn(item, field);
      return typeof state === "string" && invalid.test(state);
    });
}

/** Verifies the requested frame in each slot before the prompt can be submitted. */
function framesReady(items: unknown[] | null, targets: IngredientTarget[]): boolean {
  if (!items || items.length !== targets.length) return false;
  const hasSlots = items.some((item) => readOwn(item, "Ud") != null);
  return targets.every((target, index) => {
    const slot = index === 0 ? "FIRST_FRAME" : "LAST_FRAME";
    const item = hasSlots ? items.find((entry) => readOwn(entry, "Ud") === slot) : items[index];
    return !itemNotReady(item) && itemMatchesTarget(item, target);
  });
}

/** Attaches reference ingredients or characters and writes the generation prompt text. */
export async function attachIngredients(cfg: GenerationConfig): Promise<unknown> {
  const onEditPage = isEditContext(cfg.edit);

  const ingredientTargets: IngredientTarget[] = [];
  const tileMap = runtimeState.store?.getTileMap?.();

  if (Array.isArray(cfg.asset_ids)) {
    for (const id of cfg.asset_ids) {
      const t = tileMap?.get(String(id));
      const hasDisplayName = Boolean(t?.displayName && String(t.displayName).trim());
      ingredientTargets.push({
        id: String(id),
        primaryMediaId: t?.primaryMediaId || t?.Fb?.id || t?.Fb?.mediaId || null,
        hasDisplayName,
        name: hasDisplayName && t?.displayName ? String(t.displayName).trim() : String(id),
        url: pickTileUrl(t),
        tile: t || null,
      });
    }
  }

  if (Array.isArray(cfg.characters)) {
    for (const c of cfg.characters) {
      const key = String(c);
      let matched: FlowTile | null = tileMap?.get(key) || null;
      if (!matched && tileMap instanceof Map) {
        const low = key.toLowerCase();
        for (const t of tileMap.values()) {
          if (String(t?.type || "").toUpperCase() !== "CHARACTER") continue;
          const nm = String(t?.displayName || "").toLowerCase();
          if (nm === low || nm.includes(low)) {
            matched = t;
            break;
          }
        }
      }
      let charUrl = pickTileUrl(matched);
      let charPrimaryMediaId: string | number | null =
        matched?.primaryMediaId ||
        matched?.Fb?.id ||
        matched?.Fb?.mediaId ||
        null;
      const looks = characterLooksOf(matched);
      if (looks) {
        for (const entry of looks.values()) {
          if (!entry) continue;
          if (!charPrimaryMediaId && entry.primaryMediaId) {
            charPrimaryMediaId = entry.primaryMediaId;
          }
          if (!charUrl) {
            charUrl =
              entry.Wb ||
              entry.fifeUrl ||
              entry.imageUrl ||
              entry.url ||
              entry.media?.Wb ||
              entry.media?.fifeUrl ||
              entry.media?.url ||
              null;
          }
          if (!charUrl && Array.isArray(entry.history)) {
            for (const h of entry.history) {
              const candidateUrl =
                h?.Wb ||
                h?.fifeUrl ||
                h?.imageUrl ||
                h?.url ||
                h?.media?.Wb ||
                h?.media?.fifeUrl ||
                h?.media?.url ||
                null;
              if (candidateUrl) {
                charUrl = candidateUrl;
                break;
              }
            }
          }
          if (charUrl && charPrimaryMediaId) break;
        }
      }
      const hasDisplayName = Boolean(
        matched?.displayName ? String(matched.displayName).trim() : key.trim(),
      );
      ingredientTargets.push({
        id: matched?.id ? String(matched.id) : key,
        primaryMediaId: charPrimaryMediaId,
        hasDisplayName,
        name: matched?.displayName ? String(matched.displayName).trim() : key,
        url: charUrl,
        tile: matched || null,
        character: true,
      });
    }
  }

  const initialTb = onEditPage ? findTextbox(true) : await ensureManualComposer();
  if (!onEditPage && !initialTb) return { ok: false, error: "manual_prompt_not_ready" };

  if (ingredientTargets.length > 0 && !onEditPage) {
    for (let pass = 0; pass < 4; pass += 1) {
      const staleRemoveBtns = Array.from(
        document.querySelectorAll(
          'flow-prompt-box flow-image-ingredient-chip button, flow-prompt-box button[aria-label*="Remove" i], flow-prompt-box [class*="chip"] button',
        ),
      ).filter((el): el is HTMLElement => {
        if (!isVisibleEnabled(el)) return false;
        if (el.closest("flow-image-ingredient-chip")) return true;
        const lbl = (el.getAttribute("aria-label") || elText(el)).trim();
        return /^remove\b|remove ingredient|remove reference|remove frame/i.test(
          lbl,
        );
      });
      if (staleRemoveBtns.length === 0) break;
      for (const btn of staleRemoveBtns) {
        btn.click();
      }
      await delay(100);
    }
  }

  const scope: ParentNode = (() => {
    let cur: Element | null | undefined = initialTb?.parentElement;
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
  })();

  const readPageItems = (
    page: ReturnType<typeof findProjectPageInstance>,
    ux?: ReturnType<typeof findLiveBasePromptBox>,
  ): Array<Record<string, unknown>> | null => {
    const raw =
      page?.Qa?.oc?.all?.() ??
      page?.Qa?.kc?.all?.() ??
      page?.oc?.all?.() ??
      ux?.Qa?.oc?.all?.() ??
      ux?.Qa?.kc?.all?.();
    return Array.isArray(raw) ? raw : null;
  };

  if (
    ingredientTargets.length > 0 &&
    !onEditPage &&
    !(runtimeState.ngLViewMap instanceof Map)
  ) {
    const tipEls = Array.from(
      document.querySelectorAll("[mattooltip], button[aria-label]"),
    ).slice(0, 8);
    await withLViewMapCapture(async () => {
      await hoverProbe(tipEls, 50);
    });
  }

  const promptBoxEl = onEditPage
    ? Array.from(document.querySelectorAll(EDIT_PROMPT_BOX_SELECTOR)).find(
        (el) => !isExcludedComposerNode(el),
      ) ?? null
    : document.querySelector("flow-prompt-box");
  const ingSearchRoots: ParentNode[] = [
    ...(promptBoxEl ? [promptBoxEl] : []),
    ...(scope && scope !== document && scope !== promptBoxEl ? [scope] : []),
    document,
  ];
  const initialPage = !onEditPage ? findProjectPageInstance() : null;
  const initialUx = !onEditPage
    ? findLiveBasePromptBox(false, findPromptBoxHost(initialPage))
    : null;
  const initialQaMode = String(
    initialPage?.Qa?.config?.mode?.() || initialUx?.Qa?.config?.mode?.() || "",
  );
  const hasAddIngredientsBtn = ingSearchRoots.some((root) =>
    Array.from(root.querySelectorAll('button, [role="button"]')).some(
      (el) =>
        isVisibleEnabled(el) &&
        !isExcludedComposerNode(el) &&
        /add ingredients to the prompt box|\bingredients\b/i.test(
          (
            el.getAttribute("aria-label") ||
            elText(el) ||
            el.getAttribute("title") ||
            ""
          ).trim(),
        ),
    ),
  );
  const hasFrameSlotBtn = ingSearchRoots.some((root) =>
    Array.from(root.querySelectorAll('button, [role="button"]')).some(
      (el) =>
        isVisibleEnabled(el) &&
        !isExcludedComposerNode(el) &&
        /^(?:start|end)$/i.test(
          (el.getAttribute("aria-label") || elText(el)).trim(),
        ),
    ),
  );
  const isVideoFrames =
    !onEditPage &&
    (initialQaMode
      ? initialQaMode === "VIDEO_FRAMES"
      : (/^frames?$/i.test(String(cfg.video_type || "").trim()) &&
          String(cfg.mode || "video").toLowerCase() === "video") ||
        (!hasAddIngredientsBtn && hasFrameSlotBtn));

  if (isVideoFrames && ingredientTargets.length > 2) {
    return { ok: false, error: "ingredient_attach_failed" };
  }

  let attachedSteps = 0;

  for (let idx = 0; idx < ingredientTargets.length; idx += 1) {
    const target = ingredientTargets[idx];
    if (!onEditPage && target.tile && (!isVideoFrames || !hasFrameSlotBtn)) {
      const projPage = findProjectPageInstance();
      if (projPage && typeof projPage.Ph === "function") {
        const beforeItems = readPageItems(projPage) || [];
        const prevCount = beforeItems.length;
        try {
          projPage.Ph(target.tile);
          await delay(180);
        } catch {
          // Fall back to DOM picker below.
        }
        const afterItems = readPageItems(projPage) || [];
        const added = afterItems.some((item) => itemMatchesTarget(item, target)) ||
          (!isVideoFrames && afterItems.length > prevCount);
        if (added) {
          attachedSteps += 1;
          continue;
        }
      }
    }

    const slotPattern = isVideoFrames
      ? idx === 0
        ? /^start$/i
        : /^end$/i
      : /add ingredients to the prompt box|\bingredients\b|\badd frame\b/i;
    let ingBtn: HTMLElement | null = null;
    for (const root of ingSearchRoots) {
      ingBtn =
        Array.from(root.querySelectorAll('button, [role="button"]')).find(
          (el): el is HTMLElement => {
            if (!isVisibleEnabled(el) || isExcludedComposerNode(el)) return false;
            const label = (
              el.getAttribute("aria-label") ||
              elText(el) ||
              el.getAttribute("title") ||
              ""
            ).trim();
            return slotPattern.test(label);
          },
        ) || null;
      if (ingBtn) break;
    }
    if (!ingBtn && isVideoFrames) {
      for (const root of ingSearchRoots) {
        ingBtn =
          Array.from(root.querySelectorAll('button, [role="button"]')).find(
            (el): el is HTMLElement => {
              if (!isVisibleEnabled(el) || isExcludedComposerNode(el)) return false;
              const label = (
                el.getAttribute("aria-label") ||
                elText(el) ||
                el.getAttribute("title") ||
                ""
              ).trim();
              return /\badd frame\b/i.test(label);
            },
          ) || null;
        if (ingBtn) break;
      }
    }
    if (!ingBtn) break;
    const activeIngBtn = ingBtn;
    if (!(runtimeState.ngLViewMap instanceof Map)) {
      await withLViewMapCapture(async () => {
        activeIngBtn.click();
        await delay(250);
      });
    } else {
      activeIngBtn.click();
      await delay(250);
    }

    const searchInput = document.querySelector(
      'input[aria-label="Search assets"], input[placeholder*="Search" i]',
    );
    if (
      (searchInput instanceof HTMLInputElement ||
        searchInput instanceof HTMLTextAreaElement) &&
      isVisibleEnabled(searchInput)
    ) {
      if (target.hasDisplayName) {
        searchInput.focus();
        setNativeValue(searchInput, target.name);
        await delay(250);
      } else if (searchInput.value) {
        setNativeValue(searchInput, "");
        await delay(250);
      }
    }

    const overlay: ParentNode =
      document.querySelector(
        'flow-media-picker-dialog, [role="dialog"], .cdk-overlay-pane, [role="listbox"], .mat-mdc-menu-panel',
      ) || document;
    const lowName = target.hasDisplayName ? target.name.toLowerCase() : "";
    const matchTarget: PickerMatchTarget = {
      id: target.id,
      primaryMediaId: target.primaryMediaId,
      lowName,
      url: target.url,
      fife: fifeBase(target.url),
    };

    let attached = false;
    const popEl =
      overlay.querySelector("flow-add-menu-popover-content") ||
      document.querySelector("flow-add-menu-popover-content");
    interface PopoverComponent {
      isPending?: () => boolean;
      ka?: () => unknown[];
      Hi?: ((item?: unknown) => unknown) | undefined;
      r9?: (item: unknown) => void;
      Qda?: (item: unknown) => void;
    }
    if (popEl) {
      const findPopInst = (lv: NgLView | null): PopoverComponent | null => {
        if (!Array.isArray(lv)) return null;
        for (const cand of lv) {
          if (
            cand &&
            typeof cand === "object" &&
            !(cand instanceof Node) &&
            (typeof (cand as PopoverComponent).Qda === "function" ||
              typeof (cand as PopoverComponent).r9 === "function" ||
              typeof (cand as PopoverComponent).Hi === "function")
          ) {
            return cand as PopoverComponent;
          }
        }
        return null;
      };
      let popInst: PopoverComponent | null = null;
      let p: NgLView | null = resolveLView(popEl);
      for (let d = 0; d < 4 && Array.isArray(p); d++) {
        popInst = findPopInst(p);
        if (popInst) break;
        p = Array.isArray(p[3]) ? p[3] : Array.isArray(p[15]) ? p[15] : null;
      }
      if (!popInst && runtimeState.ngLViewMap instanceof Map) {
        for (const lv of runtimeState.ngLViewMap.values()) {
          if (!isLiveLView(lv)) continue;
          popInst = findPopInst(lv);
          if (popInst) break;
        }
      }
      if (popInst) {
        for (let w = 0; w < 15; w += 1) {
          if (typeof popInst.isPending === "function" && popInst.isPending()) {
            await delay(100);
          } else {
            break;
          }
        }
        const pool =
          (typeof popInst.ka === "function" ? popInst.ka() : null) ||
          (typeof popInst.Hi === "function" ? popInst.Hi() : null) ||
          [];
        const m = Array.isArray(pool)
          ? pool.find((a) => pickerAssetMatches(a, matchTarget)) ||
            (lowName
              ? pool.find((a) =>
                  String(
                    readOwn(a, "title") || readOwn(a, "displayName") || "",
                  )
                    .toLowerCase()
                    .includes(lowName),
                )
              : null)
          : null;
        if (m) {
          if (typeof popInst.Qda === "function") {
            popInst.Qda(m);
            attached = true;
          } else if (typeof popInst.r9 === "function") {
            popInst.r9(m);
            attached = true;
          } else if (typeof popInst.Hi === "function") {
            popInst.Hi(m);
            attached = true;
          }
          if (attached) await delay(180);
        }
      }
    }

    if (!attached) {
      const items = Array.from(
        overlay.querySelectorAll(
          '[role="option"], [role="menuitem"], .asset-tile, [data-testid*="asset"], [data-testid*="tile"], button, [role="button"]',
        ),
      );
      const hit = items.find((el): el is HTMLElement => {
        if (!isVisibleEnabled(el) || el === searchInput) return false;
        const lbl = (el.getAttribute("aria-label") || elText(el)).trim();
        if (/^(?:close|cancel|search|clear|confirm|done)$/i.test(lbl)) {
          return false;
        }
        return pickerElementMatches(el, matchTarget);
      });
      if (hit) {
        hit.click();
        await delay(150);
        if (document.querySelector("flow-add-menu-popover-content")) {
          const detailAdd = document.querySelector(
            "flow-add-menu-detail-pane button.detail-add-to-prompt-btn",
          );
          if (isVisibleEnabled(detailAdd)) {
            detailAdd.click();
          } else if (hit.isConnected) {
            hit.click();
          }
        }
        attached = true;
      }
    }

    if (attached) {
      attachedSteps += 1;
      await delay(220);
      const confirmBtn = Array.from(
        overlay.querySelectorAll('button, [role="button"]'),
      ).find((b): b is HTMLElement => {
        if (!isVisibleEnabled(b)) return false;
        const lbl = (b.getAttribute("aria-label") || elText(b)).trim();
        return /^(?:confirm|add media|add to prompt|add|done)$/i.test(lbl);
      });
      if (confirmBtn) {
        confirmBtn.click();
        await delay(220);
      }
    }

    if (
      document.querySelector(
        'flow-media-picker-dialog, flow-add-menu-popover-content, input[aria-label="Search assets"]',
      )
    ) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
        }),
      );
      await delay(120);
      if (
        document.querySelector(
          'flow-media-picker-dialog, flow-add-menu-popover-content, input[aria-label="Search assets"]',
        )
      ) {
        const backdrop = document.querySelector(".cdk-overlay-backdrop");
        if (backdrop instanceof HTMLElement) {
          backdrop.click();
          await delay(150);
        }
      }
    }

    if (isVideoFrames && !attached) break;
  }

  if (ingredientTargets.length > 0) {
    const projPage = !onEditPage ? findProjectPageInstance() : null;
    const liveUx = !onEditPage
      ? findLiveBasePromptBox(false, findPromptBoxHost(projPage))
      : null;
    let finalItems = !onEditPage ? readPageItems(projPage, liveUx) : null;
    const ready = (): boolean => isVideoFrames
      ? framesReady(finalItems, ingredientTargets)
      : finalItems === null ||
        (finalItems.length >= ingredientTargets.length && !finalItems.some(itemNotReady));
    for (let attempt = 0; attachedSteps === ingredientTargets.length && !ready() && attempt < 25; attempt++) {
      await delay(100);
      finalItems = readPageItems(projPage, liveUx);
    }
    if (attachedSteps < ingredientTargets.length || !ready()) {
      return { ok: false, error: "ingredient_attach_failed" };
    }
  }

  const tb = findTextbox(onEditPage);
  if (!tb) return { ok: false, error: "prompt_textbox_not_found" };
  const promptHost = !onEditPage
    ? findPromptBoxHost(findProjectPageInstance())
    : null;
  const composerSeeds = (
    onEditPage
      ? [
          document.querySelector("flow-edit-image-prompt-box"),
          document.querySelector("flow-edit-video-prompt-box"),
          document.querySelector("flow-edit-image-prompt-box flow-rich-text-editor"),
          document.querySelector("flow-edit-video-prompt-box flow-rich-text-editor"),
          document.querySelector("flow-editor-page flow-rich-text-editor"),
          document.querySelector("flow-scene-builder flow-rich-text-editor"),
          document.querySelector("flow-rich-text-editor"),
        ]
      : [
          document.querySelector(
            "flow-prompt-box flow-base-prompt-box flow-rich-text-editor",
          ),
          document.querySelector("flow-prompt-box flow-base-prompt-box"),
          document.querySelector("flow-prompt-box flow-rich-text-editor"),
        ]
  ).filter((el) => !isExcludedComposerNode(el));
  const writeInfo = await writePromptBox(tb, cfg.prompt, {
    liveUx: findLiveBasePromptBox(onEditPage, promptHost),
    seeds: composerSeeds,
    excludeSelector: EXCLUDED_COMPOSER_SELECTOR,
    strictSync: true,
    onCloseSettings: closeSettingsAndMenus,
  });
  if (tb instanceof HTMLTextAreaElement && !writeInfo.ok) {
    return { ok: false, error: "prompt_value_mismatch" };
  }
  const finalHost = !onEditPage
    ? findPromptBoxHost(findProjectPageInstance())
    : null;
  const finalUx = findLiveBasePromptBox(onEditPage, finalHost);
  const tbLen =
    (tb instanceof HTMLTextAreaElement || tb instanceof HTMLInputElement
      ? tb.value
      : tb.textContent) || "";
  return {
    ok: true,
    composer:
      (
        tb.closest(
          "flow-edit-image-prompt-box, flow-edit-video-prompt-box, flow-creative-agent-prompt-box, flow-agent-panel",
        ) || tb.closest("flow-base-prompt-box")
      )?.tagName?.toLowerCase() || null,
    prompt_tier: writeInfo.tier,
    prompt_len: tbLen.length,
    settings_open: Boolean(!onEditPage && settingsOpen()),
    sk_agent:
      typeof finalHost?.Nl === "function"
        ? Boolean(finalHost.Nl())
        : typeof finalHost?.Sk === "function"
          ? Boolean(finalHost.Sk())
          : null,
    qa_mode: finalUx?.Qa?.config?.mode?.() || null,
    prompt_empty:
      typeof finalUx?.Qa?.prompt?.Ke === "function"
        ? Boolean(finalUx.Qa.prompt.Ke())
        : typeof finalUx?.Qa?.prompt?.Le === "function"
          ? Boolean(finalUx.Qa.prompt.Le())
          : null,
    qf:
      typeof finalUx?.wf === "function"
        ? Boolean(finalUx.wf())
        : typeof finalUx?.qf === "function"
          ? Boolean(finalUx.qf())
          : null,
  };
}
