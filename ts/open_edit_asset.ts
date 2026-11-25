// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Open the Google Flow asset editor via Angular Router or tile controls.

import {
  buildProjectUrl,
  findRouter,
  navigateSpa,
  readOwn,
  resolveLView,
} from "./angular";
import { delay, elText, isDisabledProp, isVisibleEnabled } from "./dom";
import { clearStore } from "./state";

/** Navigates to `/edit/<id>` using Angular Router or triggers an inline tile edit action. */
export async function openEditAsset(
  assetId: string,
  mediaUrl: string | null,
  primaryMediaId: string | null,
): Promise<unknown> {
  const idStr = String(assetId || "").trim();
  const candidateIds = Array.from(
    new Set([idStr, String(primaryMediaId || "").trim()].filter(Boolean)),
  );

  function findVisibleTextbox(): Element | null {
    const candidates = Array.from(
      document.querySelectorAll(
        '.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"], textarea',
      ),
    );
    return (
      candidates.find(
        (el) => el.getClientRects().length > 0 && !isDisabledProp(el),
      ) || null
    );
  }

  const pm = /\/project\/([^/?#]+)/.exec(location.pathname || "");
  const pid = pm ? pm[1] : null;
  const router = pid && candidateIds.length > 0 ? findRouter() : null;
  if (router && pid && candidateIds.length > 0) {
    let viewKind: string | null = null;
    for (const candId of candidateIds) {
      await navigateSpa(router, ["/project", pid, "edit", candId]);
      for (let i = 0; i < 60; i += 1) {
        const onRoute = (location.pathname || "").includes("/edit/");
        const edPage = document.querySelector("flow-editor-page");
        const sbPage = document.querySelector("flow-scene-builder");
        if (onRoute && (edPage || sbPage)) {
          viewKind = sbPage ? "scene_builder" : "editor_page";
          break;
        }
        await delay(100);
      }
      if (viewKind) break;
    }

    if (viewKind) {
      for (let i = 0; i < 25; i += 1) {
        if (findVisibleTextbox()) break;
        await delay(100);
      }
      if (viewKind === "scene_builder" && !findVisibleTextbox()) {
        const sb = document.querySelector("flow-scene-builder") || document;
        const clip = sb.querySelector(
          '[class*="clip"], [data-testid*="clip"], video',
        );
        if (clip instanceof HTMLElement) {
          clip.click();
          await delay(200);
        }
        if (!findVisibleTextbox()) {
          const editTrigger = Array.from(
            sb.querySelectorAll('button, [role="button"], [role="tab"]'),
          ).find((b): b is HTMLElement => {
            if (!isVisibleEnabled(b)) return false;
            const lbl = (
              b.getAttribute("aria-label") ||
              elText(b) ||
              b.getAttribute("title") ||
              ""
            ).trim();
            if (/done editing|delete|split|download/i.test(lbl)) return false;
            return /^(?:edit(?:\s+(?:clip|video))?)$/i.test(lbl);
          });
          if (editTrigger) {
            editTrigger.click();
            await delay(300);
          }
        }
      }
      for (let i = 0; i < 20; i += 1) {
        if (findVisibleTextbox()) break;
        await delay(100);
      }
      clearStore();
      return {
        opened: true,
        method: "spa_router",
        view: viewKind,
        has_textbox: Boolean(findVisibleTextbox()),
      };
    }
  }

  function mentionsAsset(el: Element): boolean {
    if (!el) return false;
    if (mediaUrl) {
      const media = el.querySelectorAll("img[src], video[src], source[src]");
      for (const m of media) {
        const src = m.getAttribute("src") || "";
        if (
          src &&
          (src === mediaUrl || mediaUrl.includes(src) || src.includes(mediaUrl))
        ) {
          return true;
        }
      }
    }
    const ng = resolveLView(el);
    if (Array.isArray(ng)) {
      for (let i = 0; i < ng.length; i++) {
        const item = ng[i];
        if (
          item &&
          typeof item === "object" &&
          String(readOwn(item, "id") || readOwn(item, "workflowId") || "") ===
            idStr
        ) {
          return true;
        }
      }
    }
    return false;
  }

  const tiles = Array.from(
    document.querySelectorAll(
      'flow-grid-tile-container, [data-testid*="tile"], [class*="tile"]',
    ),
  );
  const tile = tiles.find(mentionsAsset) || null;
  if (tile) {
    tile.scrollIntoView({ block: "center" });
    await delay(100);
    const r = tile.getBoundingClientRect();
    tile.dispatchEvent(
      new PointerEvent("pointerenter", {
        bubbles: false,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    );
    tile.dispatchEvent(
      new MouseEvent("mouseenter", {
        bubbles: false,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    );
    await delay(150);

    for (const scope of [tile, document]) {
      const btns = Array.from(
        scope.querySelectorAll('button, a, [role="button"], [role="menuitem"]'),
      );
      const editBtn = btns.find((el): el is HTMLElement => {
        if (!isVisibleEnabled(el)) return false;
        const txt = (
          el.getAttribute("aria-label") ||
          elText(el) ||
          el.getAttribute("title") ||
          ""
        ).trim();
        return /\b(?:edit|modify|reframe|inpaint)\b/i.test(txt);
      });
      if (editBtn) {
        editBtn.click();
        await delay(300);
        return { opened: true, method: "ui_edit" };
      }
    }
  }

  if (pid && idStr) {
    return {
      opened: false,
      edit_url: buildProjectUrl(pid, ["edit", idStr]),
      method: "route_fallback_needed",
    };
  }
  return { opened: false, method: "none" };
}
