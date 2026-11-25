// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Navigate Google Flow home, project tiles, and sub-routes.

import { buildProjectUrl, findRouter, navigateSpa } from "./angular";
import { delay, elText, isVisibleEnabled } from "./dom";
import { clearStore } from "./state";

/** Performs a named project UI navigation or layout query inside Google Flow. */
export async function projectNav(action: string): Promise<unknown> {
  if (action === "enter_existing") {
    const links = Array.from(document.querySelectorAll('a[href*="/project/"]'));
    const a = links.find(isVisibleEnabled);
    if (a) {
      a.click();
      return "clicked_link";
    }
    const cards = Array.from(
      document.querySelectorAll(
        'flow-project-card, [class*="project-card"], [data-testid*="project"]',
      ),
    );
    const card = cards.find(isVisibleEnabled);
    if (card) {
      card.click();
      return "clicked_card";
    }
    return "none";
  }

  if (action === "has_workspace") {
    return Boolean(
      document.querySelector(
        'flow-grid-tile-container, textarea, [role="textbox"][contenteditable="true"], button.library-expand-button',
      ),
    );
  }

  if (action === "first_tile_center") {
    const t = document.querySelector("flow-grid-tile-container");
    if (!t) return null;
    const r = t.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  if (action === "click_new_project") {
    if (
      document.querySelector("flow-loading-page, .projects-loading-container") &&
      !document.querySelector(
        "button.projects-grid-new-project-button, button.new-project-button",
      )
    ) {
      return false;
    }
    const direct = Array.from(
      document.querySelectorAll(
        "button.projects-grid-new-project-button, button.new-project-button",
      ),
    );
    const candidates = [
      ...direct,
      ...Array.from(document.querySelectorAll('button, a, [role="button"]')),
    ];
    const seen = new Set<Element>();
    const b = candidates.find((el): el is HTMLElement => {
      if (!el || seen.has(el)) return false;
      seen.add(el);
      if (!isVisibleEnabled(el)) return false;
      if (el.closest("[inert]")) return false;
      if (
        el.classList.contains("projects-grid-new-project-button") ||
        el.classList.contains("new-project-button")
      ) {
        return true;
      }
      const aria = (el.getAttribute("aria-label") || "").trim();
      if (/^(?:\+\s*|add\s*)?new project$/i.test(aria)) return true;
      const text = elText(el);
      return /\bnew project\b/i.test(text);
    });
    if (b) {
      b.scrollIntoView({ block: "center", inline: "nearest" });
      b.click();
      return true;
    }
    return false;
  }

  if (action === "exit_subroute") {
    const activeProject = (): string | undefined =>
      /\/project\/([^/?#]+)/.exec(location.pathname || "")?.[1];
    const pid = activeProject();
    if (!pid) return { ok: false, exited: false, method: "none" };
    const workspace = buildProjectUrl(pid);
    const isOriginalProject = (): boolean =>
      activeProject() === pid && buildProjectUrl(pid) === workspace;
    const isSubRoute = (): boolean =>
      /\/project\/[^/?#]+\/[^/?#]+/.test(location.pathname || "");
    if (!isSubRoute()) {
      return { ok: true, exited: true, method: "already_root" };
    }
    const startPath = location.pathname || "";
    const direct = Array.from(
      document.querySelectorAll(
        'button[aria-label="Done editing scene"], button[aria-label="Done editing"], flow-character-edit-header .back-button, flow-applet-view-header button[aria-label="Back"], button[aria-label="Back button to go to previous page"], flow-navigation-header .back-button:not([aria-label="Home"]), button[aria-label="Go back"]',
      ),
    ).find(isVisibleEnabled);
    let clicked = false;
    if (direct) {
      const inner =
        direct.tagName === "BUTTON" ? null : direct.querySelector("button");
      (isVisibleEnabled(inner) ? inner : direct).click();
      clicked = true;
    } else {
      const hit = Array.from(
        document.querySelectorAll('button, [role="button"]'),
      ).find((el): el is HTMLElement => {
        if (!isVisibleEnabled(el)) return false;
        const aria = (el.getAttribute("aria-label") || "").trim();
        const txt = elText(el);
        return (
          /^(?:done(?: editing(?: scene)?)?|go back|back button to go to previous page)$/i.test(
            aria,
          ) || /^(?:done(?: editing(?: scene)?)?)$/i.test(txt)
        );
      });
      if (hit) {
        hit.click();
        clicked = true;
      }
    }
    if (clicked) {
      for (let i = 0; i < 25; i++) {
        await delay(100);
        if (!isOriginalProject()) break;
        if (!isSubRoute()) {
          clearStore();
          return { ok: true, exited: true, method: "ui_done" };
        }
        if ((location.pathname || "") !== startPath) {
          break;
        }
      }
    }
    const router = isOriginalProject() ? findRouter() : null;
    if (router) {
      await navigateSpa(router, ["/project", pid]);
      for (let i = 0; i < 25; i++) {
        await delay(100);
        if (!isOriginalProject()) break;
        if (!isSubRoute()) {
          clearStore();
          return { ok: true, exited: true, method: "spa_router" };
        }
      }
    }
    return { ok: false, exited: false, method: "none" };
  }

  return { ok: false, error: `unknown_project_nav_action:${action}` };
}
