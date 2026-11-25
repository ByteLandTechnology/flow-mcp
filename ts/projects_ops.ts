// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// List, rename, and delete Google Flow projects from the Flow UI.

import { readOwn, resolveLView } from "./angular";
import { delay, elText, setNativeValue } from "./dom";
import { projectTitleFormat } from "./frontend_builds";
import {
  createProjectsGridContext,
  readCardTitle,
  type ScannedProjectCard,
} from "./projects_grid";
import type { ProjectsOpRequest } from "./types";

/** Lists, renames, or deletes Google Flow projects on home or workspace pages. */
export async function projectsOp(req: ProjectsOpRequest): Promise<unknown> {
  const {
    deadlineExpired,
    waitBeforeDeadline,
    collectRenderedCards,
    scanGridCards,
    runAndAwaitNetwork,
  } = createProjectsGridContext(req?.timeout_ms);

  const action = String(req?.action || "list").toLowerCase();

  if (action === "list") {
    const wantId = req?.project_id ? String(req.project_id).trim() : "";
    const wantTitle = req?.title ? String(req.title).trim().toLowerCase() : "";
    const stopWhen =
      wantId || wantTitle
        ? (cards: ScannedProjectCard[]): boolean =>
            cards.some((p) => {
              if (wantId) return p.id === wantId;
              return (
                Boolean(wantTitle) &&
                Boolean(p.title) &&
                (p.title || "").trim().toLowerCase() === wantTitle
              );
            })
        : undefined;
    const { items, truncated } = await scanGridCards(stopWhen);
    return {
      ok: true,
      projects: items.map(({ id, title, url }) => ({ id, title, url })),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  if (action === "set_title") {
    const desired = String(req?.title || "").trim();
    if (!desired) return { ok: false, error: "empty_title" };
    const isSubroutePath = (): boolean =>
      /\/project\/[^/?#]+\/[^/?#]+/.test(location.pathname || "");
    const isProjectRootPath = (): boolean =>
      /\/project\/[^/?#]+\/?$/.test(location.pathname || "");
    if (isSubroutePath()) {
      return { ok: false, error: "project_subroute_active" };
    }
    if (!isProjectRootPath()) {
      return { ok: false, error: "not_in_project_root" };
    }
    const headerHostSelector =
      "flow-project-page flow-tile-view-header flow-navigation-header flow-editable-text";
    const headerInputSelector = `${headerHostSelector} input.editable-text-input, ${headerHostSelector} input[aria-label="Editable text"], ${headerHostSelector} input`;
    let input: HTMLInputElement | null = null;
    for (let i = 0; i < 40 && !deadlineExpired(); i++) {
      if (isSubroutePath()) {
        return { ok: false, error: "project_subroute_active" };
      }
      if (!isProjectRootPath()) {
        return { ok: false, error: "not_in_project_root" };
      }
      const candidates = Array.from(
        document.querySelectorAll(headerInputSelector),
      );
      const found = candidates.find(
        (cand): cand is HTMLInputElement =>
          cand instanceof HTMLInputElement &&
          !cand.closest(
            "flow-project-sidenav-container, mat-sidenav, aside",
          ) &&
          cand.getClientRects().length > 0,
      );
      if (found) {
        input = found;
        break;
      }
      if (!(await waitBeforeDeadline(100))) break;
    }
    if (!input) return { ok: false, error: "project_title_input_not_found" };
    const titleInput = input;
    const host = titleInput.closest(headerHostSelector);
    if (!host) return { ok: false, error: "project_title_input_not_found" };
    if ((titleInput.value || "").trim() === desired) {
      return { ok: true, title: desired };
    }
    let abortedOnRoute = false;
    await runAndAwaitNetwork(
      async () => {
        if (isSubroutePath() || !isProjectRootPath()) {
          abortedOnRoute = true;
          return;
        }
        titleInput.focus();
        titleInput.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
        await delay(50);
        setNativeValue(titleInput, desired);
        await delay(50);
        const doneBtn = host.querySelector('button[aria-label="Done"]');
        if (doneBtn instanceof HTMLElement) {
          doneBtn.click();
        } else {
          titleInput.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
        await delay(60);
        if (
          host.querySelector(".editable-text-container.editing") ||
          (titleInput.value || "").trim() !== desired
        ) {
          try {
            const lv = resolveLView(host);
            if (Array.isArray(lv)) {
              const titleFormat = projectTitleFormat();
              for (const slot of lv) {
                const emitter = readOwn(slot, titleFormat.saveEmitter) as
                  | { emit?: (v: string) => void }
                  | undefined;
                const state = readOwn(slot, titleFormat.stateSignal) as
                  | { set?: (v: unknown) => void }
                  | undefined;
                if (
                  typeof emitter?.emit === "function" &&
                  typeof state?.set === "function"
                ) {
                  emitter.emit(desired);
                  state.set({ state: "viewing" });
                  break;
                }
              }
            }
          } catch {
            // Fall through to polling check.
          }
        }
      },
      400,
      6000,
    );
    if (abortedOnRoute || isSubroutePath()) {
      return { ok: false, error: "project_subroute_active" };
    }
    if (!isProjectRootPath()) {
      return { ok: false, error: "not_in_project_root" };
    }
    const isSettledTitle = (): boolean =>
      !host.querySelector(".editable-text-container.editing") &&
      (titleInput.value || "").trim() === desired;
    await waitBeforeDeadline(300);
    for (let i = 0; i < 30 && !deadlineExpired(); i++) {
      if (isSettledTitle()) {
        if (!(await waitBeforeDeadline(200))) break;
        if (isSettledTitle()) {
          return { ok: true, confirmed: true, title: desired };
        }
      }
      if (!(await waitBeforeDeadline(150))) break;
    }
    return { ok: false, error: "project_title_not_confirmed" };
  }

  if (action === "delete") {
    const targetId = req?.project_id ? String(req.project_id).trim() : "";
    const targetTitle = req?.title ? String(req.title).trim() : "";
    if (!targetId && !targetTitle) {
      return { ok: false, error: "missing_project_target" };
    }
    const targetTitleLower = targetTitle.toLowerCase();
    const matchesTarget = (p: ScannedProjectCard): boolean => {
      if (targetId) return p.id === targetId;
      return (
        Boolean(targetTitleLower) &&
        Boolean(p.title) &&
        (p.title || "").trim().toLowerCase() === targetTitleLower
      );
    };
    const { items, truncated } = await scanGridCards((cards) =>
      cards.some(matchesTarget),
    );
    const hit = items.find(matchesTarget);
    if (!hit || !hit._card) {
      return {
        ok: false,
        error: truncated ? "project_scan_timeout" : "project_card_not_found",
      };
    }
    const beforeRenderedMatches = items.filter(matchesTarget).length;
    const deletedId = hit.id;
    const deletedTitle = hit.title;
    const card = hit._card;
    card.scrollIntoView({ block: "center" });
    if (!(await waitBeforeDeadline(100))) {
      return { ok: false, error: "project_scan_timeout" };
    }
    const r = card.getBoundingClientRect();
    card.dispatchEvent(
      new PointerEvent("pointerenter", {
        bubbles: false,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    );
    card.dispatchEvent(
      new MouseEvent("mouseenter", {
        bubbles: false,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    );
    if (!(await waitBeforeDeadline(150))) {
      return { ok: false, error: "project_scan_timeout" };
    }

    let delBtn = card.querySelector('button[aria-label="Delete project"]');
    if (!delBtn) {
      const moreBtn = card.querySelector(
        'button[aria-label*="More" i], button[aria-haspopup="menu"]',
      );
      if (moreBtn instanceof HTMLElement) {
        moreBtn.click();
        if (!(await waitBeforeDeadline(200))) {
          document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
          );
          return { ok: false, error: "project_scan_timeout" };
        }
        delBtn =
          document.querySelector(
            'button[aria-label="Delete project"], [role="menuitem"][aria-label*="Delete" i]',
          ) ||
          Array.from(
            document.querySelectorAll('button, [role="menuitem"]'),
          ).find((el) => /\bdelete project\b/i.test(elText(el))) ||
          null;
      }
    }
    if (!(delBtn instanceof HTMLElement)) {
      return { ok: false, error: "delete_project_button_not_found" };
    }
    if (deadlineExpired()) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      return { ok: false, error: "project_scan_timeout" };
    }
    delBtn.click();

    let confirmBtn: HTMLElement | null = null;
    for (let i = 0; i < 25 && !deadlineExpired(); i++) {
      if (!(await waitBeforeDeadline(100))) break;
      const dialogs = Array.from(
        document.querySelectorAll(
          '[role="dialog"], .mat-mdc-dialog-container, .cdk-overlay-pane',
        ),
      );
      for (const dlg of dialogs) {
        if (!/delete this project/i.test(dlg.textContent || "")) continue;
        const foundBtn = Array.from(dlg.querySelectorAll("button")).find((b) =>
          /\bdelete project\b/i.test(
            elText(b) || (b.getAttribute("aria-label") || "").trim(),
          ),
        );
        if (foundBtn instanceof HTMLElement) {
          confirmBtn = foundBtn;
          break;
        }
      }
      if (confirmBtn) break;
    }
    if (!confirmBtn || deadlineExpired()) {
      const timedOut = deadlineExpired();
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      return {
        ok: false,
        error: timedOut
          ? "project_scan_timeout"
          : "delete_confirm_button_not_found",
      };
    }

    const finalConfirm = confirmBtn;
    const outcomeUnknown = (): Record<string, unknown> => ({
      ok: false,
      error: "outcome_unknown",
      stage: "confirm_project_delete",
      project_id: deletedId,
      title: deletedTitle,
    });
    const networkSettled = await runAndAwaitNetwork(
      async () => {
        finalConfirm.click();
      },
      350,
      8000,
    );
    if (!networkSettled && deadlineExpired()) {
      return outcomeUnknown();
    }

    const hasDeleteDialog = (): boolean =>
      Array.from(
        document.querySelectorAll(
          '[role="dialog"], .mat-mdc-dialog-container, .cdk-overlay-pane',
        ),
      ).some((dlg) => /delete this project/i.test(dlg.textContent || ""));
    const entryRemoved = (entries: ScannedProjectCard[]): boolean => {
      if (hasDeleteDialog()) return false;
      if (deletedId) {
        return !entries.some((p) => p.id === deletedId);
      }
      if (!document.body.contains(card)) {
        return true;
      }
      const liveTitle = (readCardTitle(card) || "").trim().toLowerCase();
      return (
        liveTitle !== targetTitleLower &&
        entries.filter(matchesTarget).length < beforeRenderedMatches
      );
    };

    while (!deadlineExpired()) {
      const current = await collectRenderedCards(true);
      if (entryRemoved(current)) {
        if (!(await waitBeforeDeadline(200))) break;
        const recheck = await collectRenderedCards(true);
        if (entryRemoved(recheck)) {
          return {
            ok: true,
            confirmed: true,
            deleted_id: deletedId,
            deleted_title: deletedTitle,
          };
        }
      }
      if (!(await waitBeforeDeadline(150))) break;
    }
    return outcomeUnknown();
  }

  return { ok: false, error: `unknown_project_action:${action}` };
}
