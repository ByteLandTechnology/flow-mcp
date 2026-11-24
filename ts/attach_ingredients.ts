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
  legacyTile,
  pickTileUrl,
  setNativeValue,
} from "./dom";
import {
  frontendBuild,
  readBuildLabel,
  type ComposerAttachmentFormat,
} from "./frontend_builds";
import { writePromptBox } from "./prompt_writer";
import { runtimeState } from "./state";
import type {
  FlowTile,
  GenerationConfig,
  NgLView,
  ProjectPageInstance,
  PromptStateController,
} from "./types";

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
  /** True when the target represents a character reference. */
  isCharacter: boolean;
}

/** Resolves the active `PromptStateController` from the project page or base prompt box. */
function readPromptState(
  projPage: ProjectPageInstance | null,
): PromptStateController | null {
  return (
    projPage?.Qa ??
    findLiveBasePromptBox(false, findPromptBoxHost(projPage))?.Qa ??
    null
  );
}

/** Reads the attached ingredient items from a verified `PromptStateController`. */
function readAttachedItems(
  qa: PromptStateController | null,
  format: ComposerAttachmentFormat,
): Array<Record<string, unknown>> {
  const refs = readOwn(qa, format.references);
  const allFn = readOwn(refs, "all");
  if (typeof allFn !== "function") return [];
  const items: unknown = allFn.call(refs);
  return Array.isArray(items) ? (items as Array<Record<string, unknown>>) : [];
}

/** Checks whether an attached prompt item matches `target` and optional `frameSlot`. */
function itemMatchesTarget(
  item: unknown,
  target: IngredientTarget,
  frameSlot?: string,
): boolean {
  if (!item || typeof item !== "object") return false;
  if (frameSlot && readOwn(item, "Ud") !== frameSlot) return false;
  const vals = [
    readOwn(item, "id"),
    readOwn(item, "workflowId"),
    readOwn(item, "entityId"),
    readOwn(item, "mediaId"),
    readOwn(item, "primaryMediaId"),
    readOwn(item, "Oc"),
  ]
    .filter(Boolean)
    .map(String);
  if (vals.includes(target.id)) return true;
  if (target.primaryMediaId && vals.includes(String(target.primaryMediaId))) {
    return true;
  }
  if (target.isCharacter && target.hasDisplayName) {
    const itemName = String(readOwn(item, "displayName") || "").toLowerCase();
    if (itemName && itemName === target.name.toLowerCase()) return true;
  }
  return false;
}

/** Computes a positive numeric aspect ratio for a keyframe or reference tile. */
function resolveTileAspectRatio(
  tile: FlowTile,
  cfg: GenerationConfig,
): number {
  const norm = legacyTile(tile);
  const kbAspect = readOwn(readOwn(tile, "Kb"), "aspectRatio");
  for (const cand of [norm?.Fb?.aspectRatio, kbAspect, tile.aspectRatio]) {
    if (typeof cand === "number" && Number.isFinite(cand) && cand > 0) {
      return cand;
    }
  }
  if (cfg.aspect === "9:16") return 9 / 16;
  if (cfg.aspect === "1:1") return 1;
  return 16 / 9;
}

/** Returns true when the composer is operating in `VIDEO_FRAMES` keyframe mode. */
function isVideoFramesMode(
  qa: PromptStateController | null,
  cfg: GenerationConfig,
  scope: ParentNode,
): boolean {
  const qaMode = String(qa?.config?.mode?.() || "");
  if (qaMode) return qaMode === "VIDEO_FRAMES";
  if (
    String(cfg.mode || "video").toLowerCase() === "video" &&
    cfg.video_type
  ) {
    return !/ingredient/i.test(String(cfg.video_type).trim());
  }
  const roots: ParentNode[] =
    scope && scope !== document ? [scope, document] : [document];
  const hasAddBtn = roots.some((root) =>
    Array.from(root.querySelectorAll('button, [role="button"]')).some(
      (el) =>
        isVisibleEnabled(el) &&
        /add ingredients to the prompt box|\bingredients\b/i.test(
          (el.getAttribute("aria-label") || elText(el)).trim(),
        ),
    ),
  );
  if (hasAddBtn) return false;
  return roots.some((root) =>
    Array.from(root.querySelectorAll('button, [role="button"]')).some(
      (el) =>
        isVisibleEnabled(el) &&
        /^(?:start|end)$/i.test(
          (el.getAttribute("aria-label") || elText(el)).trim(),
        ),
    ),
  );
}

/** Ensures `runtimeState.ngLViewMap` is captured before scanning Angular views. */
async function ensureComposerLViews(): Promise<void> {
  if (runtimeState.ngLViewMap instanceof Map) return;
  const tipEls = Array.from(
    document.querySelectorAll(
      "[mattooltip], [cdkoverlayorigin], button[aria-label], flow-prompt-box, flow-project-page",
    ),
  ).slice(0, 8);
  await withLViewMapCapture(async () => {
    await hoverProbe(tipEls, 50);
  });
}

/** Attaches reference ingredients or characters and writes the generation prompt text. */
export async function attachIngredients(cfg: GenerationConfig): Promise<unknown> {
  const onEditPage = /\/edit\//.test(location.pathname || "");

  const ingredientTargets: IngredientTarget[] = [];
  const tileMap = runtimeState.store?.getTileMap?.();

  if (Array.isArray(cfg.asset_ids)) {
    for (const id of cfg.asset_ids) {
      const t = tileMap?.get(String(id));
      const lt = legacyTile(t);
      const hasDisplayName = Boolean(t?.displayName && String(t.displayName).trim());
      ingredientTargets.push({
        id: String(id),
        primaryMediaId:
          t?.primaryMediaId || lt?.Fb?.id || lt?.Fb?.mediaId || null,
        hasDisplayName,
        name: hasDisplayName && t?.displayName ? String(t.displayName).trim() : String(id),
        url: pickTileUrl(t),
        tile: t || null,
        isCharacter: String(t?.type || "").toUpperCase() === "CHARACTER",
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
        isCharacter: true,
      });
    }
  }

  const composerFormat = !onEditPage
    ? frontendBuild(readBuildLabel())?.composerAttachment
    : undefined;

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
    if (composerFormat) {
      await ensureComposerLViews();
      const qa = readPromptState(findProjectPageInstance());
      if (typeof qa?.clear === "function") {
        try {
          qa.clear();
        } catch {
          // Ignore disposed signal resets and continue.
        }
      }
    }
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

  let videoFrames = false;
  if (ingredientTargets.length > 0 && !onEditPage) {
    if (composerFormat) await ensureComposerLViews();
    const initialQa = composerFormat
      ? readPromptState(findProjectPageInstance())
      : null;
    videoFrames = isVideoFramesMode(initialQa, cfg, scope);
    if (videoFrames) {
      const invalidKeyframe =
        ingredientTargets.length > 2 ||
        ingredientTargets.some(
          (t) =>
            t.isCharacter ||
            Boolean(t.tile?.type && String(t.tile.type).toUpperCase() !== "IMAGE"),
        );
      if (invalidKeyframe) {
        return { ok: false, error: "ingredient_attach_failed" };
      }
    }
  }

  for (let idx = 0; idx < ingredientTargets.length; idx += 1) {
    const target = ingredientTargets[idx];
    if (!onEditPage && target.tile && composerFormat) {
      await ensureComposerLViews();
      const projPage = findProjectPageInstance();
      const qa = readPromptState(projPage);
      const modeBefore = String(qa?.config?.mode?.() || "");
      const inFrames = modeBefore ? modeBefore === "VIDEO_FRAMES" : videoFrames;
      if (inFrames) {
        videoFrames = true;
        const tileKind = String(target.tile.type || "").toUpperCase();
        if (idx >= 2 || target.isCharacter || (tileKind && tileKind !== "IMAGE")) {
          return { ok: false, error: "ingredient_attach_failed" };
        }
        const frameSlot = idx === 0 ? "FIRST_FRAME" : "LAST_FRAME";
        const attachIng = readOwn(qa, composerFormat.attachIngredient);
        const attachTile = readOwn(projPage, composerFormat.attachTile);
        const mediaId = String(
          target.primaryMediaId || target.tile.primaryMediaId || target.id,
        );
        let directOk = false;
        if (qa && typeof attachIng === "function" && mediaId) {
          try {
            const kb = readOwn(target.tile, "Kb");
            const kc = readOwn(kb, "kc") ?? target.tile.kc;
            const lc = readOwn(target.tile, "lc");
            const uc: Record<string, unknown> = {
              id: mediaId,
              mediaId,
              mediaType: "IMAGE",
              aspectRatio: resolveTileAspectRatio(target.tile, cfg),
              Ud: frameSlot,
              Xb: lc instanceof Date ? lc : new Date(),
              ...(kc !== undefined ? { kc } : {}),
            };
            attachIng.call(qa, { uc, source: "PLUS_BUTTON" });
            directOk = readAttachedItems(qa, composerFormat).some((item) =>
              itemMatchesTarget(item, target, frameSlot),
            );
          } catch {
            // Fall through to attachTile or DOM picker.
          }
        }
        if (!directOk && projPage && typeof attachTile === "function") {
          try {
            attachTile.call(projPage, target.tile);
            await delay(60);
            const modeAfter = String(qa?.config?.mode?.() || "");
            if (modeAfter && modeAfter !== "VIDEO_FRAMES") {
              return { ok: false, error: "ingredient_attach_failed" };
            }
            directOk = readAttachedItems(qa, composerFormat).some((item) =>
              itemMatchesTarget(item, target, frameSlot),
            );
          } catch {
            // Fall back to DOM picker below.
          }
        }
        if (directOk) continue;
      } else if (qa) {
        const beforeItems = readAttachedItems(qa, composerFormat);
        const prevCount = beforeItems.length;
        const attachTile = readOwn(projPage, composerFormat.attachTile);
        const attachIng = readOwn(qa, composerFormat.attachIngredient);
        if (projPage && typeof attachTile === "function") {
          try {
            attachTile.call(projPage, target.tile);
            await delay(120);
          } catch {
            // Fall back to attachIngredient or DOM picker below.
          }
        }
        let afterItems = readAttachedItems(qa, composerFormat);
        let added =
          afterItems.length > prevCount ||
          afterItems.some((item) => itemMatchesTarget(item, target));
        if (
          !added &&
          typeof attachIng === "function" &&
          !target.isCharacter &&
          String(target.tile.type || "").toUpperCase() === "IMAGE"
        ) {
          const mediaId = String(
            target.primaryMediaId || target.tile.primaryMediaId || target.id,
          );
          try {
            attachIng.call(qa, {
              uc: {
                id: mediaId,
                mediaId,
                mediaType: "IMAGE",
                aspectRatio: resolveTileAspectRatio(target.tile, cfg),
                Ud: "REFERENCE",
                Xb: new Date(),
              },
              source: "VIDEO_TILE_REFERENCE",
            });
            afterItems = readAttachedItems(qa, composerFormat);
            added =
              afterItems.length > prevCount ||
              afterItems.some((item) => itemMatchesTarget(item, target));
          } catch {
            // Fall back to DOM picker below.
          }
        }
        if (added) continue;
      }
    }

    const barEl = document.querySelector("flow-ingredient-bar");
    const ingSearchRoots: ParentNode[] = [
      ...(barEl ? [barEl] : []),
      ...(scope && scope !== document ? [scope] : []),
      document,
    ];
    const findTriggerByRegex = (re: RegExp): HTMLElement | null => {
      for (const root of ingSearchRoots) {
        const hit = Array.from(
          root.querySelectorAll('button, [role="button"]'),
        ).find((el): el is HTMLElement => {
          if (!isVisibleEnabled(el)) return false;
          const label = (
            el.getAttribute("aria-label") ||
            elText(el) ||
            el.getAttribute("title") ||
            ""
          ).trim();
          return re.test(label);
        });
        if (hit) return hit;
      }
      return null;
    };

    const frameSlotRe =
      idx === 0
        ? /^(?:start|first frame|add frame)$/i
        : /^(?:end|last frame|add frame)$/i;
    const generalIngRe =
      /add ingredients to the prompt box|\bingredients\b|\badd frame\b/i;

    let ingBtn: HTMLElement | null = null;
    if (!onEditPage && videoFrames) {
      if (
        idx >= 2 ||
        target.isCharacter ||
        Boolean(target.tile?.type && String(target.tile.type).toUpperCase() !== "IMAGE")
      ) {
        return { ok: false, error: "ingredient_attach_failed" };
      }
      ingBtn = findTriggerByRegex(frameSlotRe);
    } else {
      ingBtn = findTriggerByRegex(generalIngRe);
      if (!ingBtn && !onEditPage) {
        const slotBtn = findTriggerByRegex(frameSlotRe);
        if (slotBtn) {
          videoFrames = true;
          if (
            ingredientTargets.length > 2 ||
            idx >= 2 ||
            target.isCharacter ||
            Boolean(
              target.tile?.type && String(target.tile.type).toUpperCase() !== "IMAGE",
            )
          ) {
            return { ok: false, error: "ingredient_attach_failed" };
          }
          ingBtn = slotBtn;
        }
      }
    }
    if (!ingBtn) {
      return { ok: false, error: "ingredient_attach_failed" };
    }
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
    const selectKeys = composerFormat
      ? [composerFormat.popoverSelect, "r9", "Hi"]
      : ["Qda", "r9", "Hi"];
    interface PopoverComponent {
      isPending?: () => boolean;
      ka?: () => unknown[];
      xZ?: () => unknown[];
      Hi?: ((item?: unknown) => unknown) | undefined;
    }
    if (popEl) {
      const findPopSelect = (
        cand: unknown,
      ): ((item: unknown) => unknown) | null => {
        if (!cand || typeof cand !== "object" || cand instanceof Node) {
          return null;
        }
        for (const key of selectKeys) {
          const fn = readOwn(cand, key);
          if (typeof fn === "function") {
            return fn.bind(cand) as (item: unknown) => unknown;
          }
        }
        return null;
      };
      const findPopInst = (
        lv: NgLView | null,
      ): { inst: PopoverComponent; select: (item: unknown) => unknown } | null => {
        if (!Array.isArray(lv)) return null;
        for (const cand of lv) {
          const select = findPopSelect(cand);
          if (select) {
            return { inst: cand as PopoverComponent, select };
          }
        }
        return null;
      };
      let popHit: {
        inst: PopoverComponent;
        select: (item: unknown) => unknown;
      } | null = null;
      let p: NgLView | null = resolveLView(popEl);
      for (let d = 0; d < 4 && Array.isArray(p); d++) {
        popHit = findPopInst(p);
        if (popHit) break;
        p = Array.isArray(p[3]) ? p[3] : Array.isArray(p[15]) ? p[15] : null;
      }
      if (!popHit && runtimeState.ngLViewMap instanceof Map) {
        for (const lv of runtimeState.ngLViewMap.values()) {
          if (!isLiveLView(lv)) continue;
          popHit = findPopInst(lv);
          if (popHit) break;
        }
      }
      if (popHit) {
        const { inst: popInst, select } = popHit;
        for (let w = 0; w < 15; w += 1) {
          if (typeof popInst.isPending === "function" && popInst.isPending()) {
            await delay(100);
          } else {
            break;
          }
        }
        const pool =
          (typeof popInst.ka === "function" ? popInst.ka() : null) ||
          (typeof popInst.xZ === "function" ? popInst.xZ() : null) ||
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
          select(m);
          attached = true;
          await delay(180);
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
    if (!attached) {
      return { ok: false, error: "ingredient_attach_failed" };
    }
  }

  if (ingredientTargets.length > 0 && !onEditPage && composerFormat) {
    const projPage = findProjectPageInstance();
    const qa = readPromptState(projPage);
    const refs = readOwn(qa, composerFormat.references);
    if (qa && typeof readOwn(refs, "all") === "function") {
      for (let w = 0; w < 25; w += 1) {
        const items = readAttachedItems(qa, composerFormat);
        const stillLoading = items.some(
          (x) =>
            Boolean(x) &&
            (Boolean(readOwn(x, composerFormat.validationError)) ||
              readOwn(x, "isLoading") === true),
        );
        if (!stillLoading) break;
        await delay(100);
      }
      const finalMode = String(qa.config?.mode?.() || "");
      if (videoFrames && finalMode && finalMode !== "VIDEO_FRAMES") {
        return { ok: false, error: "ingredient_attach_failed" };
      }
      const settledItems = readAttachedItems(qa, composerFormat).filter(
        (x) =>
          Boolean(x) &&
          !readOwn(x, composerFormat.validationError) &&
          readOwn(x, "isLoading") !== true,
      );
      if (settledItems.length < ingredientTargets.length) {
        return { ok: false, error: "ingredient_attach_failed" };
      }
      const inFrames = finalMode ? finalMode === "VIDEO_FRAMES" : videoFrames;
      for (let idx = 0; idx < ingredientTargets.length; idx += 1) {
        const expectedSlot = inFrames
          ? idx === 0
            ? "FIRST_FRAME"
            : "LAST_FRAME"
          : undefined;
        const matched = settledItems.some((item) =>
          itemMatchesTarget(item, ingredientTargets[idx], expectedSlot),
        );
        if (!matched) {
          return { ok: false, error: "ingredient_attach_failed" };
        }
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
      typeof finalUx?.Qa?.prompt?.Ke === "function"
        ? Boolean(finalUx.Qa.prompt.Ke())
        : typeof finalUx?.Qa?.prompt?.Le === "function"
          ? Boolean(finalUx.Qa.prompt.Le())
          : null,
    qf: typeof finalUx?.qf === "function" ? Boolean(finalUx.qf()) : null,
  };
}
