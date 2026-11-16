// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Trim Flow videos and drive the scene builder extend workflow.

import { createScene, findRouter } from "./angular";
import { delay, elText, isDisabledProp, isVisibleEnabled } from "./dom";
import { writePromptBox } from "./prompt_writer";
import { clearStore, runtimeState } from "./state";
import type { FlowTile, VideoOpRequest } from "./types";

/** Trims video clip timestamps or orchestrates scene-builder video extension. */
export async function videoOp(req: VideoOpRequest): Promise<unknown> {
  const helper = runtimeState.store;
  const getMap = (): Map<string, FlowTile> | null | undefined => helper?.getTileMap?.();
  const tileMap = getMap();
  const action = String(req?.action || "").toLowerCase();

  if (action === "trim") {
    if (!(tileMap instanceof Map) || !helper?.mutate) {
      return { ok: false, error: "store_not_bound" };
    }
    const id = String(req?.asset_id || "").trim();
    const tile = tileMap.get(id);
    if (!tile) return { ok: false, error: `video_asset_not_found:${id}` };
    const mediaId = String(
      tile.primaryMediaId ||
        tile.Fb?.id ||
        tile.Fb?.mediaId ||
        tile.fb?.mediaId ||
        tile.mediaId ||
        id,
    );
    const startSec =
      typeof req.start_seconds === "number" ? req.start_seconds : null;
    const endSec = typeof req.end_seconds === "number" ? req.end_seconds : null;
    await helper.mutate({
      type: "single_tile",
      Xc: String(tile.id ?? id),
      Ve: {
        type: "set_video_trim_seconds",
        mediaId,
        Cg: startSec,
        Rf: endSec,
      },
    });
    await delay(500);
    return {
      ok: true,
      asset_id: id,
      media_id: mediaId,
      start_seconds: startSec,
      end_seconds: endSec,
    };
  }

  if (action === "prepare_extend") {
    const id = String(req?.asset_id || "").trim();
    if (!location.pathname.includes("/scene/")) {
      if (!(tileMap instanceof Map) || !helper?.mutate) {
        return { ok: false, error: "store_not_bound" };
      }
      let sceneId = req?.scene_id ? String(req.scene_id).trim() : null;
      if (!sceneId) {
        const wfId = String(tileMap.get(id)?.workflowId || id);
        const created = await createScene(helper, getMap, [wfId]);
        if (!created?.ok || !created.id) {
          return { ok: false, error: "failed_to_create_scene_for_extend" };
        }
        sceneId = created.id;
      }
      const pm = /(\/(?:fx\/tools\/flow\/)?project\/([^/?#]+))/.exec(
        location.pathname || "",
      );
      const pid = pm ? pm[2] : null;
      const router = pid ? findRouter() : null;
      let navigatedSpa = false;
      if (router && pid) {
        await router.navigate(["/project", pid, "scene", sceneId], {
          queryParams: { hl: "en" },
        });
        for (let i = 0; i < 60; i++) {
          const onScene = (location.pathname || "").includes(
            `/scene/${sceneId}`,
          );
          const hasSb = Boolean(document.querySelector("flow-scene-builder"));
          if (onScene && hasSb) {
            navigatedSpa = true;
            break;
          }
          await delay(100);
        }
      }
      if (navigatedSpa) {
        clearStore();
        await delay(250);
      } else {
        const projPath = pm ? pm[1] : "";
        return {
          ok: false,
          need_navigate: `${location.origin}${projPath}/scene/${encodeURIComponent(sceneId)}?hl=en`,
          scene_id: sceneId,
        };
      }
    }

    for (let i = 0; i < 40; i++) {
      if (
        document.querySelector(
          "flow-scene-timeline, .is-extend-mode, .extend-composing, button[aria-label='Add clip']",
        )
      ) {
        break;
      }
      await delay(100);
    }

    const inExtendMode = (): boolean =>
      Boolean(
        document.querySelector(
          ".is-extend-mode, .extend-composing, .extend-mode-chip",
        ),
      );

    const findExtendBtn = (): HTMLElement | null =>
      Array.from(
        document.querySelectorAll('button, [role="button"], [role="tab"]'),
      ).find((el): el is HTMLElement => {
        if (!isVisibleEnabled(el)) return false;
        const aria = (el.getAttribute("aria-label") || "").trim();
        const raw = elText(el);
        if (/redo extend|done editing/i.test(`${aria} ${raw}`)) return false;
        const tail =
          raw
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
            .pop() || "";
        return (
          /^(?:extend|prompt to extend)$/i.test(aria) ||
          /^(?:extend|prompt to extend)$/i.test(raw) ||
          /^(?:extend|prompt to extend)$/i.test(tail)
        );
      }) || null;

    if (!inExtendMode()) {
      let extendBtn = findExtendBtn();
      if (!extendBtn) {
        const sb = document.querySelector("flow-scene-builder") || document;
        const clip = sb.querySelector(
          '[class*="clip"], [data-testid*="clip"], video',
        );
        if (clip instanceof HTMLElement) {
          clip.click();
          await delay(250);
        }
        for (let i = 0; i < 15; i++) {
          extendBtn = findExtendBtn();
          if (extendBtn) break;
          await delay(100);
        }
      }
      if (extendBtn) {
        extendBtn.click();
        await delay(300);
      }
      if (!inExtendMode()) {
        const addClipBtn = document.querySelector(
          'flow-scene-builder button[aria-label="Add clip"], flow-scene-timeline button[aria-label="Add clip"], button[aria-label="Add clip"]',
        );
        if (isVisibleEnabled(addClipBtn)) {
          addClipBtn.click();
          await delay(250);
          const menuScope =
            document.querySelector(
              '.extend-menu-panel, flow-extend-menu, .cdk-overlay-pane, [role="menu"]',
            ) || document;
          const optCandidates = Array.from(
            menuScope.querySelectorAll(
              '.extend-clip-option button, .extend-clip-option [role="menuitem"], flow-menu-item.extend-clip-option, button, [role="menuitem"], [role="button"]',
            ),
          );
          const extendOpt = optCandidates.find((el) => {
            if (el.getClientRects().length === 0) return false;
            const aria = (el.getAttribute("aria-label") || "").trim();
            const raw = elText(el);
            if (/redo extend|done editing|add clip/i.test(`${aria} ${raw}`)) {
              return false;
            }
            return (
              /^(?:extend|prompt to extend)$/i.test(aria) ||
              /^(?:extend|prompt to extend)$/i.test(raw) ||
              Boolean(el.closest(".extend-clip-option"))
            );
          });
          if (extendOpt) {
            const innerBtn =
              extendOpt.querySelector("button, [role='menuitem']") || extendOpt;
            if (!isVisibleEnabled(innerBtn) || !isVisibleEnabled(extendOpt)) {
              const reason = (
                extendOpt.getAttribute("mattooltip") ||
                extendOpt.getAttribute("title") ||
                innerBtn.getAttribute("mattooltip") ||
                innerBtn.getAttribute("title") ||
                "unavailable"
              ).trim();
              return { ok: false, error: `extend_option_disabled:${reason}` };
            }
            innerBtn.click();
            for (let i = 0; i < 20; i++) {
              if (inExtendMode()) break;
              await delay(100);
            }
          }
        }
      }
    }

    let tb: HTMLElement | null = null;
    for (let i = 0; i < 20; i++) {
      const textboxes = Array.from(
        document.querySelectorAll(
          '.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"], textarea',
        ),
      ).filter(
        (el): el is HTMLElement =>
          el instanceof HTMLElement &&
          el.getClientRects().length > 0 &&
          !isDisabledProp(el),
      );
      tb =
        textboxes.find((el) => {
          const ctx = (
            el.getAttribute("aria-label") ||
            el.getAttribute("placeholder") ||
            elText(el.parentElement) ||
            ""
          ).toLowerCase();
          return ctx.includes("extend");
        }) ||
        textboxes[0] ||
        null;
      if (tb) break;
      await delay(100);
    }
    if (!tb) return { ok: false, error: "extend_prompt_textbox_not_found" };

    const prompt = String(req?.prompt || "").trim();
    if (!prompt) return { ok: false, error: "extend_prompt_required" };
    await writePromptBox(tb, prompt);

    let submitBtn: HTMLElement | null = null;
    const exactSelector = 'button[aria-label="Start generation"]';
    for (let i = 0; i < 120; i++) {
      const exact = document.querySelector(exactSelector);
      if (isVisibleEnabled(exact)) {
        submitBtn = exact;
        break;
      }
      if (exact && exact.getClientRects().length > 0) {
        await delay(100);
      } else {
        break;
      }
    }
    if (!submitBtn) {
      const exactAfter = document.querySelector(exactSelector);
      if (
        exactAfter &&
        exactAfter.getClientRects().length > 0 &&
        !isVisibleEnabled(exactAfter)
      ) {
        return { ok: false, error: "extend_start_generation_disabled" };
      }
      submitBtn =
        Array.from(document.querySelectorAll('button, [role="button"]')).find(
          (b): b is HTMLElement => {
            if (b.tagName === "A" || !isVisibleEnabled(b)) return false;
            if (
              b.closest(
                '.cdk-overlay-pane, [role="menu"], [role="listbox"], nav, aside',
              )
            ) {
              return false;
            }
            const lbl = (b.getAttribute("aria-label") || elText(b)).trim();
            if (
              /create tool|create with google flow|new project|done editing scene/i.test(
                lbl,
              )
            ) {
              return false;
            }
            return (
              /\b(?:start generation|extend|generate)\b/i.test(lbl) ||
              (b.tagName === "BUTTON" && /\barrow_forward\b/i.test(lbl))
            );
          },
        ) || null;
    }
    if (!submitBtn) {
      return { ok: false, error: "extend_submit_button_not_found" };
    }
    submitBtn.scrollIntoView({ block: "center", inline: "nearest" });
    await delay(40);
    const r = submitBtn.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) {
      return { ok: false, error: "extend_submit_button_zero_rect" };
    }
    return {
      ok: true,
      submit_point: {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
      },
    };
  }

  if (action === "poll_extend") {
    const bodyText = elText(document.body);
    const extending =
      /\bExtending\b|Extending…/i.test(bodyText) ||
      Boolean(
        document.querySelector(
          "flow-scene-timeline .is-extend-generating, flow-scene-timeline .pending-placeholder, flow-scene-timeline [aria-busy='true']",
        ),
      );
    return { ok: true, extending };
  }

  if (action === "done_scene") {
    const findDoneBtn = (): Element | null =>
      document.querySelector('button[aria-label="Done editing scene"]') ||
      Array.from(document.querySelectorAll('button, [role="button"]')).find(
        (el) =>
          isVisibleEnabled(el) &&
          /^done editing scene$/i.test(
            (el.getAttribute("aria-label") || elText(el)).trim(),
          ),
      ) ||
      null;
    const doneBtn = findDoneBtn();
    if (isVisibleEnabled(doneBtn)) {
      doneBtn.click();
      for (let i = 0; i < 25; i++) {
        await delay(100);
        if (!location.pathname.includes("/scene/")) break;
      }
    }
    if (location.pathname.includes("/scene/")) {
      const pm = /\/project\/([^/?#]+)/.exec(location.pathname || "");
      const pid = pm ? pm[1] : null;
      const router = pid ? findRouter() : null;
      if (router && pid) {
        await router.navigate(["/project", pid], { queryParams: { hl: "en" } });
        for (let i = 0; i < 25; i++) {
          await delay(100);
          if (!location.pathname.includes("/scene/")) break;
        }
      }
    }
    const closed = !location.pathname.includes("/scene/");
    clearStore();
    return { ok: true, closed };
  }

  return { ok: false, error: `unknown_video_action:${action}` };
}
