// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Composer host, prompt textbox, and settings overlay helpers.

import { isLiveLView, resolveLView, withLViewMapCapture } from "./angular";
import { delay, elText, isDisabledProp, isVisibleEnabled } from "./dom";
import { runtimeState } from "./state";
import type {
  BasePromptBoxInstance,
  NgLView,
  ProjectPageInstance,
  PromptBoxHost,
} from "./types";

/** Selector matching editable prompt textboxes in Flow composer UI. */
const TEXTBOX_SELECTOR =
  '.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"], [contenteditable="true"], textarea';

/** Containers that belong to the Agent composer. */
const AGENT_COMPOSER = "flow-agent-panel, .agent-panel-wrapper, flow-creative-agent-prompt-box";

/** Finds a visible textbox in a composer root. */
function composerTextbox(root: ParentNode | null, edit: boolean): HTMLElement | null {
  return Array.from(root?.querySelectorAll(TEXTBOX_SELECTOR) ?? []).find(
    (el): el is HTMLElement =>
      el instanceof HTMLElement && el.getClientRects().length > 0 &&
      !isDisabledProp(el) && (edit || !el.closest(AGENT_COMPOSER)),
  ) ?? null;
}

/** Finds the active visible prompt textbox for generation or edit composers. */
export function findTextbox(editFlag: boolean): HTMLElement | null {
  const scopedSelector = editFlag
    ? "flow-edit-video-prompt-box, flow-editor-page, flow-scene-builder"
    : "flow-prompt-box flow-base-prompt-box, flow-prompt-box";
  return composerTextbox(document.querySelector(scopedSelector), editFlag) ||
    composerTextbox(document, editFlag);
}

/** Closes the active Agent panel and waits for the manual prompt to become editable. */
export async function ensureManualComposer(): Promise<HTMLElement | null> {
  const clicked = new WeakSet<HTMLElement>();
  const hosts = new WeakSet<PromptBoxHost>();
  for (let attempt = 0; attempt < 40; attempt++) {
    const prompt = document.querySelector("flow-prompt-box");
    const textbox = composerTextbox(prompt, false);
    if (textbox) return textbox;

    const panel = document.querySelector("flow-agent-panel, .agent-panel-wrapper");
    const close = Array.from(panel?.querySelectorAll('button, [role="button"]') ?? []).find(
      (button): button is HTMLElement => isVisibleEnabled(button) &&
        /^(close(?: (?:agent )?panel)?|switch to manual|exit agent)$/i.test(
          (button.getAttribute("aria-label") || elText(button)).trim(),
        ),
    );
    const toggle = Array.from(prompt?.querySelectorAll(
      'flow-agent-mode-toggle-chip button[aria-pressed="true"], flow-agent-mode-switch button[aria-pressed="true"], flow-creative-agent-prompt-box flow-agent-mode-toggle-chip button',
    ) ?? []).find(isVisibleEnabled);
    const control = [close, toggle].find(
      (button): button is HTMLElement => Boolean(button && !clicked.has(button)),
    );
    if (control) {
      clicked.add(control);
      await withLViewMapCapture(async () => {
        control.click();
        await delay(100);
      });
      continue;
    }
    if (prompt) {
      const host = findPromptBoxHost(findProjectPageInstance());
      if (host && !hosts.has(host)) {
        hosts.add(host);
        try {
          if (host.Sk()) host.Tx();
        } catch {
          // Wait for the prompt box if its required inputs are still loading.
        }
      }
    }
    await delay(100);
  }
  return null;
}

/** Finds the live `flow-project-page` Angular component instance. */
export function findProjectPageInstance(): ProjectPageInstance | null {
  const isProjPage = (cand: unknown): cand is ProjectPageInstance => {
    if (!cand || typeof cand !== "object" || cand instanceof Node) return false;
    const obj = cand as Partial<ProjectPageInstance>;
    return (
      typeof obj.Ph === "function" &&
      Boolean(obj.Qa) &&
      typeof obj.ub?.mutate === "function"
    );
  };
  const scanLv = (lv: unknown): ProjectPageInstance | null =>
    Array.isArray(lv) ? lv.find((c): c is ProjectPageInstance => isProjPage(c)) || null : null;

  const pgEl = document.querySelector("flow-project-page");
  if (pgEl) {
    let p: NgLView | null = resolveLView(pgEl);
    for (let d = 0; d < 6 && Array.isArray(p); d += 1) {
      const hit = scanLv(p);
      if (hit) return hit;
      p = Array.isArray(p[3]) ? p[3] : Array.isArray(p[15]) ? p[15] : null;
    }
  }
  if (runtimeState.ngLViewMap instanceof Map) {
    for (const lv of runtimeState.ngLViewMap.values()) {
      if (!isLiveLView(lv)) continue;
      const hit = scanLv(lv);
      if (hit) return hit;
    }
  }
  return null;
}

/** Type guard for the Angular prompt box host managing manual/agent toggle state. */
function isPromptBoxHost(cand: unknown): cand is PromptBoxHost {
  if (!cand || typeof cand !== "object" || cand instanceof Node) return false;
  const obj = cand as Partial<PromptBoxHost>;
  return typeof obj.Tx === "function" && typeof obj.Sk === "function";
}

/** Finds the live `flow-prompt-box` host component instance. */
export function findPromptBoxHost(projPage: ProjectPageInstance | null): PromptBoxHost | null {
  if (projPage && typeof projPage.jQ === "function") {
    try {
      const host = projPage.jQ();
      if (isPromptBoxHost(host)) return host;
    } catch {
      // Fall through to LView scanning.
    }
  }
  const scanLvForHost = (lv: unknown): PromptBoxHost | null => {
    if (!Array.isArray(lv)) return null;
    for (const cand of lv) {
      if (isPromptBoxHost(cand)) return cand;
      if (Array.isArray(cand) && typeof cand[1] === "object") {
        for (const sub of cand) {
          if (isPromptBoxHost(sub)) return sub;
        }
      }
    }
    return null;
  };
  const pbEl = document.querySelector("flow-prompt-box");
  if (pbEl) {
    const pbNodes = [
      pbEl,
      pbEl.firstElementChild,
      pbEl.querySelector("flow-prompt-box-drop-zone"),
      pbEl.querySelector("flow-prompt-box-instruction-card-wrapper"),
      pbEl.querySelector("flow-base-prompt-box"),
      pbEl.querySelector("flow-creative-agent-prompt-box"),
    ].filter((n): n is Element => Boolean(n));
    for (const node of pbNodes) {
      let p: NgLView | null = resolveLView(node);
      for (let d = 0; d < 6 && Array.isArray(p); d += 1) {
        const hit = scanLvForHost(p);
        if (hit) return hit;
        p = Array.isArray(p[3]) ? p[3] : Array.isArray(p[15]) ? p[15] : null;
      }
    }
  }
  if (runtimeState.ngLViewMap instanceof Map) {
    for (const lv of runtimeState.ngLViewMap.values()) {
      if (!isLiveLView(lv)) continue;
      const hit = scanLvForHost(lv);
      if (hit) return hit;
    }
  }
  return null;
}

/** Type guard for `flow-base-prompt-box` controller instances. */
function isBasePromptBoxInst(cand: unknown): cand is BasePromptBoxInstance {
  if (!cand || typeof cand !== "object" || cand instanceof Node) return false;
  const obj = cand as Partial<BasePromptBoxInstance>;
  return Boolean(obj.Qa && typeof obj.Wn === "function" && typeof obj.qf === "function");
}

/** Walks up parent elements and LViews from `startEl` to find a `BasePromptBoxInstance`. */
function scanElementForBasePromptBox(startEl: Element | null): BasePromptBoxInstance | null {
  if (!startEl) return null;
  let cur: Element | null = startEl;
  for (let depth = 0; depth < 6 && cur; depth += 1) {
    let lv: NgLView | null = resolveLView(cur);
    for (let pDepth = 0; pDepth < 6 && Array.isArray(lv); pDepth += 1) {
      for (const cand of lv) {
        if (isBasePromptBoxInst(cand)) return cand;
      }
      lv = Array.isArray(lv[3]) ? lv[3] : Array.isArray(lv[15]) ? lv[15] : null;
    }
    cur = cur.parentElement;
  }
  return null;
}

/** Resolves the active manual or edit `BasePromptBoxInstance`. */
export function findLiveBasePromptBox(
  editFlag: boolean,
  promptBoxHost: PromptBoxHost | null,
): BasePromptBoxInstance | null {
  if (!editFlag) {
    try {
      const direct = promptBoxHost?.mt?.();
      if (isBasePromptBoxInst(direct)) return direct;
    } catch {
      // Fall through to DOM scan.
    }
    return scanElementForBasePromptBox(
      document.querySelector("flow-prompt-box flow-base-prompt-box"),
    );
  }
  return scanElementForBasePromptBox(
    document.querySelector(
      "flow-edit-video-prompt-box flow-base-prompt-box, flow-edit-video-prompt-box",
    ),
  );
}

/** Returns true while the generation settings overlay or controls are visible. */
export function settingsOpen(): boolean {
  return Boolean(
    document.querySelector(
      '.settings-content-overlay, flow-prompt-box-settings, [aria-label="Mode"], [aria-label="Aspect ratio"], [aria-label="Output count"], button[aria-label="Select model family"]',
    ),
  );
}

/** Closes the open model family dropdown panel if visible. */
export async function closeModelMenu(): Promise<void> {
  for (let step = 0; step < 3; step += 1) {
    if (
      !document.querySelector(
        ".flow-model-picker-panel, .settings-menu-backdrop",
      )
    ) {
      break;
    }
    const menuBackdrop = document.querySelector(".settings-menu-backdrop");
    if (menuBackdrop instanceof HTMLElement) {
      menuBackdrop.click();
    } else {
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
    }
    for (let i = 0; i < 8; i += 1) {
      if (
        !document.querySelector(
          ".flow-model-picker-panel, .settings-menu-backdrop",
        )
      ) {
        break;
      }
      await delay(50);
    }
  }
}

/** Closes any open model picker menu and the prompt box settings overlay. */
export async function closeSettingsAndMenus(): Promise<void> {
  await closeModelMenu();
  if (!settingsOpen()) return;
  const baseEl = document.querySelector(
    "flow-prompt-box flow-base-prompt-box, flow-base-prompt-box",
  );
  const findBaseInst = (lv: NgLView): BasePromptBoxInstance | null => {
    for (const cand of lv) {
      if (
        cand &&
        typeof cand === "object" &&
        !(cand instanceof Node) &&
        typeof (cand as BasePromptBoxInstance).VJ === "function" &&
        typeof (cand as BasePromptBoxInstance).VJ?.set === "function"
      ) {
        return cand as BasePromptBoxInstance;
      }
    }
    return null;
  };
  let baseInst: BasePromptBoxInstance | null = null;
  if (baseEl) {
    let p: NgLView | null = resolveLView(baseEl);
    for (let d = 0; d < 6 && Array.isArray(p); d += 1) {
      baseInst = findBaseInst(p);
      if (baseInst) break;
      p = Array.isArray(p[3]) ? p[3] : Array.isArray(p[15]) ? p[15] : null;
    }
  }
  if (!baseInst && runtimeState.ngLViewMap instanceof Map) {
    for (const lv of runtimeState.ngLViewMap.values()) {
      if (!isLiveLView(lv)) continue;
      baseInst = findBaseInst(lv);
      if (baseInst) break;
    }
  }
  if (baseInst?.VJ?.set) {
    try {
      baseInst.VJ.set(false);
    } catch {
      // Ignore disposed signal writes and fall back to DOM toggle.
    }
    await delay(80);
  }
  if (settingsOpen()) {
    const sBtn = document.querySelector(
      'flow-prompt-box button[aria-label="Settings trigger"], button[aria-label="Settings trigger"]',
    );
    if (isVisibleEnabled(sBtn)) {
      sBtn.click();
      await delay(80);
    }
  }
  if (settingsOpen()) {
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
  }
  for (let i = 0; i < 10; i += 1) {
    if (
      !settingsOpen() &&
      !document.querySelector(".cdk-overlay-backdrop, .settings-content-overlay")
    ) {
      break;
    }
    await delay(50);
  }
}
