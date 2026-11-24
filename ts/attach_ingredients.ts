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
  characterLooksOf,
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
}

/** Attaches reference ingredients or characters and writes the generation prompt text. */
export async function attachIngredients(cfg: GenerationConfig): Promise<unknown> {
  const onEditPage = /\/edit\//.test(location.pathname || "");

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
          const asStr = (v: unknown): string | null =>
            typeof v === "string" && v ? v : null;
          if (!charUrl) {
            charUrl =
              entry.Wb ||
              asStr(entry.kc) ||
              entry.fifeUrl ||
              entry.imageUrl ||
              entry.url ||
              entry.media?.Wb ||
              asStr(entry.media?.kc) ||
              entry.media?.fifeUrl ||
              entry.media?.url ||
              null;
          }
          if (!charUrl && Array.isArray(entry.history)) {
            for (const h of entry.history) {
              const candidateUrl =
                h?.Wb ||
                asStr(h?.kc) ||
                h?.fifeUrl ||
                h?.imageUrl ||
                h?.url ||
                h?.media?.Wb ||
                asStr(h?.media?.kc) ||
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
      });
    }
  }

  if (ingredientTargets.length > 0 && !onEditPage) {
    const staleRemoveBtns = Array.from(
      document.querySelectorAll(
        'flow-prompt-box button[aria-label*="Remove" i], flow-prompt-box [class*="chip"] button',
      ),
    ).filter((el): el is HTMLElement => {
      if (!isVisibleEnabled(el)) return false;
      const lbl = (el.getAttribute("aria-label") || elText(el)).trim();
      return /^remove\b|remove ingredient|remove reference|remove frame/i.test(
        lbl,
      );
    });
    for (const btn of staleRemoveBtns) {
      btn.click();
    }
    if (staleRemoveBtns.length > 0) await delay(100);
  }

  const initialTb = onEditPage ? findTextbox(true) : await ensureManualComposer();
  if (!onEditPage && !initialTb) return { ok: false, error: "manual_prompt_not_ready" };
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

  for (const target of ingredientTargets) {
    if (!onEditPage && target.tile) {
      if (!(runtimeState.ngLViewMap instanceof Map)) {
        const tipEls = Array.from(
          document.querySelectorAll("[mattooltip], button[aria-label]"),
        ).slice(0, 8);
        await withLViewMapCapture(async () => {
          await hoverProbe(tipEls, 50);
        });
      }
      const projPage = findProjectPageInstance();
      if (projPage && typeof projPage.Ph === "function") {
        const beforeItems = projPage.Qa?.kc?.all?.() || [];
        const prevCount = Array.isArray(beforeItems) ? beforeItems.length : 0;
        try {
          projPage.Ph(target.tile);
          await delay(180);
        } catch {
          // Fall back to DOM picker below.
        }
        const afterItems = projPage.Qa?.kc?.all?.() || [];
        const added =
          Array.isArray(afterItems) &&
          (afterItems.length > prevCount ||
            afterItems.some((item) => {
              const vals = [
                item?.id,
                item?.workflowId,
                item?.entityId,
                item?.mediaId,
                item?.primaryMediaId,
              ]
                .filter(Boolean)
                .map(String);
              return (
                vals.includes(target.id) ||
                (target.primaryMediaId &&
                  vals.includes(String(target.primaryMediaId)))
              );
            }));
        if (added) continue;
      }
    }

    const ingSearchRoots: ParentNode[] =
      scope && scope !== document ? [scope, document] : [document];
    let ingBtn: HTMLElement | null = null;
    for (const root of ingSearchRoots) {
      ingBtn =
        Array.from(root.querySelectorAll('button, [role="button"]')).find(
          (el): el is HTMLElement => {
            if (!isVisibleEnabled(el)) return false;
            const label = (
              el.getAttribute("aria-label") ||
              elText(el) ||
              el.getAttribute("title") ||
              ""
            ).trim();
            return /add ingredients to the prompt box|\bingredients\b|\badd frame\b/i.test(
              label,
            );
          },
        ) || null;
      if (ingBtn) break;
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
    }
    if (popEl) {
      const findPopInst = (lv: NgLView | null): PopoverComponent | null => {
        if (!Array.isArray(lv)) return null;
        for (const cand of lv) {
          if (
            cand &&
            typeof cand === "object" &&
            !(cand instanceof Node) &&
            (typeof (cand as PopoverComponent).r9 === "function" ||
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
          if (typeof popInst.r9 === "function") {
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
  }

  if (ingredientTargets.length > 0 && !onEditPage) {
    const projPage = findProjectPageInstance();
    if (projPage?.Qa?.kc?.all) {
      for (let w = 0; w < 25; w += 1) {
        const items = projPage.Qa.kc.all();
        const stillLoading =
          Array.isArray(items) &&
          items.some(
            (x) =>
              x &&
              (x.tl === "INVALID_CHARACTER_NO_IMAGES" || x.isLoading === true),
          );
        if (!stillLoading) break;
        await delay(100);
      }
    }
  }

  const tb = findTextbox(onEditPage);
  if (!tb) return { ok: false, error: "prompt_textbox_not_found" };
  const promptHost = !onEditPage
    ? findPromptBoxHost(findProjectPageInstance())
    : null;
  const composerSeeds = onEditPage
    ? [
        document.querySelector("flow-edit-video-prompt-box"),
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
      ];
  const writeInfo = await writePromptBox(tb, cfg.prompt, {
    liveUx: findLiveBasePromptBox(onEditPage, promptHost),
    seeds: composerSeeds,
    excludeSelector:
      !onEditPage
        ? "flow-agent-panel, .agent-panel-wrapper, flow-creative-agent-prompt-box"
        : null,
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
      tb
        .closest(
          "flow-edit-video-prompt-box, flow-creative-agent-prompt-box, flow-agent-panel, flow-base-prompt-box",
        )
        ?.tagName?.toLowerCase() || null,
    prompt_tier: writeInfo.tier,
    prompt_len: tbLen.length,
    settings_open: Boolean(!onEditPage && settingsOpen()),
    sk_agent:
      typeof finalHost?.Sk === "function" ? Boolean(finalHost.Sk()) : null,
    qa_mode: finalUx?.Qa?.config?.mode?.() || null,
    prompt_empty:
      typeof finalUx?.Qa?.prompt?.Le === "function"
        ? Boolean(finalUx.Qa.prompt.Le())
        : null,
    qf: typeof finalUx?.qf === "function" ? Boolean(finalUx.qf()) : null,
  };
}
