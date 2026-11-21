// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// ProseMirror and Angular prompt writer shared across generation, video extend, and character looks.

import { readOwn, resolveLView, withLViewMapCapture } from "./angular";
import { delay, hoverProbe, isVisibleEnabled, setNativeValue } from "./dom";
import { runtimeState } from "./state";
import type {
  NgLView,
  PromptStateController,
  ProseMirrorState,
  ProseMirrorTransaction,
  ProseMirrorView,
  WritePromptOptions,
  WritePromptResult,
} from "./types";

/** Checks whether `val` exposes ProseMirror transaction `replaceWith`. */
function isPmTransaction(val: unknown): val is ProseMirrorTransaction {
  if (!val || typeof val !== "object") return false;
  const candidate = val as {
    replaceWith?: unknown;
    type?: unknown;
    content?: unknown;
  };
  return (
    typeof candidate.replaceWith === "function" &&
    !(candidate.type && candidate.content)
  );
}

/** Extracts a ProseMirror transaction object from an editor state instance. */
function findPmTransaction(state: unknown): ProseMirrorTransaction | null {
  if (!state || typeof state !== "object") return null;
  const trProp = readOwn(state, "tr");
  if (isPmTransaction(trProp)) return trProp;
  const fiProp = readOwn(state, "Fi");
  if (isPmTransaction(fiProp)) return fiProp;
  const seen = new Set<string>();
  let cur: object | null = state;
  for (let d = 0; cur && cur !== Object.prototype && d < 3; d++) {
    let names: string[] = [];
    try {
      names = Object.getOwnPropertyNames(cur);
    } catch {
      break;
    }
    for (const k of names) {
      if (
        seen.has(k) ||
        k === "constructor" ||
        k === "doc" ||
        k === "schema" ||
        k === "selection"
      ) {
        continue;
      }
      seen.add(k);
      const val = readOwn(state, k);
      if (isPmTransaction(val)) return val;
    }
    cur = Object.getPrototypeOf(cur);
  }
  return null;
}

/** Type guard for ProseMirror `EditorView` structures. */
function isPmViewStruct(cand: unknown): cand is ProseMirrorView {
  if (!cand || typeof cand !== "object") return false;
  const view = cand as Partial<ProseMirrorView>;
  return Boolean(
    view.state &&
      (view.state as Partial<ProseMirrorState>).schema &&
      (view.state as Partial<ProseMirrorState>).doc &&
      findPmTransaction(view.state),
  );
}

/** Writes `rawText` into a ProseMirror or plain input textbox using multi-tier dispatch. */
export async function writePromptBox(
  tb: HTMLElement,
  rawText: unknown,
  opts: WritePromptOptions = {},
): Promise<WritePromptResult> {
  const text = String(rawText ?? "");
  if (tb instanceof HTMLTextAreaElement || tb instanceof HTMLInputElement) {
    setNativeValue(tb, text);
    return { ok: tb.value === text, tier: "textarea" };
  }

  const expectedPrefix = text.trim().slice(0, 24);
  const hasWritten = (): boolean =>
    !expectedPrefix || (tb.textContent || "").includes(expectedPrefix);

  const applyToPmView = (pmView: unknown, raw: string): boolean => {
    if (!isPmViewStruct(pmView)) return false;
    const tr = findPmTransaction(pmView.state);
    if (!tr) return false;
    try {
      const schema = pmView.state.schema;
      const lines = raw.replace(/\r\n?/g, "\n").split("\n");
      const inlineNodes: unknown[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) inlineNodes.push(schema.text(lines[i]));
        if (i < lines.length - 1) {
          const hb =
            typeof schema.node === "function"
              ? schema.node("hard_break")
              : schema.nodes?.hard_break?.create?.();
          if (hb) inlineNodes.push(hb);
        }
      }
      const para =
        typeof schema.node === "function"
          ? schema.node("paragraph", null, inlineNodes)
          : schema.nodes?.paragraph?.create?.(null, inlineNodes);
      if (!para) return false;
      const nextTr = tr.replaceWith(0, pmView.state.doc.content.size, para);
      const dispatchFns: Array<(t: ProseMirrorTransaction) => void> = [];
      const dispatchTxFns: Array<(t: ProseMirrorTransaction) => void> = [];
      const updateStateFns: Array<(t: ProseMirrorTransaction) => void> = [];
      if (typeof pmView.dispatch === "function") {
        const dispatch = pmView.dispatch;
        dispatchFns.push((t) => dispatch(t));
      }
      if (typeof pmView.Qd === "function") {
        const qd = pmView.Qd;
        dispatchFns.push((t) => qd(t));
      }
      let cur: object | null = pmView;
      for (let d = 0; cur && cur !== Object.prototype && d < 3; d++) {
        let names: string[] = [];
        try {
          names = Object.getOwnPropertyNames(cur);
        } catch {
          break;
        }
        for (const k of names) {
          if (k === "constructor" || k === "dispatch" || k === "Qd") {
            continue;
          }
          const fn = readOwn(pmView, k);
          if (typeof fn === "function" && fn.length === 1) {
            let src = "";
            try {
              src = fn.toString();
            } catch {
              src = "";
            }
            if (/dispatchTransaction/.test(src)) {
              dispatchTxFns.push((t) => fn.call(pmView, t));
            } else if (/\.apply\(|updateState/.test(src)) {
              updateStateFns.push((t) => fn.call(pmView, t));
            }
          }
        }
        cur = Object.getPrototypeOf(cur);
      }
      dispatchFns.push(...dispatchTxFns, ...updateStateFns);
      const prevState = pmView.state;
      for (const callDispatch of dispatchFns) {
        try {
          callDispatch(nextTr);
          if (pmView.state !== prevState || hasWritten()) {
            return true;
          }
        } catch {
          // Try next dispatch candidate.
        }
      }
    } catch {
      return false;
    }
    return false;
  };

  async function capturePromptControllers(rootEl: HTMLElement): Promise<{
    richEditor: { th?: unknown } | null;
    pmViewFound: ProseMirrorView | null;
    promptState: PromptStateController | null;
  }> {
    let richEditor: { th?: unknown } | null = null;
    let pmViewFound: ProseMirrorView | null = null;
    let promptState: PromptStateController | null = null;

    if (opts.liveUx) {
      if (opts.liveUx.Qa && typeof opts.liveUx.Qa.Wn === "function") {
        promptState = opts.liveUx.Qa;
      }
      try {
        const cq =
          typeof opts.liveUx.CQ === "function" ? opts.liveUx.CQ() : null;
        if (cq && isPmViewStruct(cq.th)) {
          richEditor = cq;
          pmViewFound = cq.th;
        }
      } catch {
        // Continue with LView discovery.
      }
    }

    const extractFromLView = (lv: NgLView): void => {
      if (!Array.isArray(lv)) return;
      for (let i = 0; i < lv.length; i++) {
        let cand: unknown;
        try {
          cand = lv[i];
        } catch {
          continue;
        }
        if (!cand || typeof cand !== "object" || cand instanceof Node) {
          continue;
        }
        try {
          const cqFn = readOwn(cand, "CQ");
          if (!pmViewFound && typeof cqFn === "function") {
            const re = cqFn.call(cand) as { th?: unknown } | null | undefined;
            if (re && isPmViewStruct(re.th)) {
              richEditor = re;
              pmViewFound = re.th;
            }
          }
          if (!pmViewFound) {
            const thVal = readOwn(cand, "th");
            if (isPmViewStruct(cand)) {
              pmViewFound = cand;
            } else if (isPmViewStruct(thVal)) {
              richEditor = cand as { th?: unknown };
              pmViewFound = thVal;
            } else {
              for (const k of Object.keys(cand).slice(0, 20)) {
                const slotVal = readOwn(cand, k);
                if (isPmViewStruct(slotVal)) {
                  richEditor = cand as { th?: unknown };
                  pmViewFound = slotVal;
                  break;
                }
              }
            }
          }
        } catch {
          // Ignore opaque getters.
        }
        try {
          if (!promptState) {
            const qaVal = readOwn(cand, "Qa") as PromptStateController | undefined;
            const ownWn = readOwn(cand, "Wn");
            const ownLf = readOwn(cand, "lf") as { isValid?: unknown } | undefined;
            if (qaVal && typeof qaVal.Wn === "function") {
              promptState = qaVal;
            } else if (
              typeof ownWn === "function" &&
              ownLf &&
              typeof ownLf.isValid === "function"
            ) {
              promptState = cand as PromptStateController;
            }
          }
        } catch {
          // Ignore opaque getters.
        }
        if (pmViewFound && promptState) return;
      }
    };

    const scanResolvedTree = (): void => {
      const defaultSeeds = [
        document.querySelector("flow-rich-text-editor"),
        document.querySelector("flow-edit-video-prompt-box"),
        document.querySelector("flow-base-prompt-box"),
      ];
      const extraSeeds = Array.isArray(opts.seeds) ? opts.seeds : defaultSeeds;
      const startSeeds = [
        rootEl,
        rootEl.closest("flow-rich-text-editor"),
        rootEl.closest("flow-base-prompt-box"),
        rootEl.closest("flow-edit-video-prompt-box"),
        rootEl.closest("flow-creative-agent-prompt-box"),
        rootEl.closest("flow-applet-prompt-box"),
        rootEl.closest("flow-prompt-box"),
        rootEl.closest("flow-character-prompt-box"),
        rootEl.closest("flow-edit-character-footer"),
        ...extraSeeds,
      ].filter((el): el is Element => Boolean(el));
      for (const seed of startSeeds) {
        let cur: Element | null = seed;
        for (let depth = 0; depth < 8 && cur; depth++) {
          let p: NgLView | null = resolveLView(cur);
          for (let pDepth = 0; pDepth < 6 && Array.isArray(p); pDepth++) {
            extractFromLView(p);
            if (pmViewFound && promptState) return;
            p = Array.isArray(p[3])
              ? p[3]
              : Array.isArray(p[15])
                ? p[15]
                : null;
          }
          cur = cur.parentElement;
        }
      }
    };

    scanResolvedTree();

    if (
      (!pmViewFound || !promptState) &&
      !(runtimeState.ngLViewMap instanceof Map)
    ) {
      const sBtn =
        opts.trySettingsClick !== false
          ? document.querySelector('button[aria-label="Settings trigger"]')
          : null;
      if (isVisibleEnabled(sBtn)) {
        await withLViewMapCapture(async () => {
          sBtn.click();
          await delay(80);
        });
        if (typeof opts.onCloseSettings === "function") {
          await opts.onCloseSettings();
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
          await delay(60);
          if (
            document.querySelector(
              '.settings-content-overlay, [aria-label="Aspect ratio"], button[aria-label="Select model family"]',
            ) &&
            isVisibleEnabled(sBtn)
          ) {
            sBtn.click();
            await delay(60);
          }
        }
      } else {
        const scope =
          (opts.hoverScopeSelector
            ? document.querySelector(opts.hoverScopeSelector)
            : null) || document;
        const tipEls = Array.from(
          scope.querySelectorAll("[mattooltip], button[aria-label]"),
        ).slice(0, 6);
        await withLViewMapCapture(async () => {
          await hoverProbe(tipEls, 80);
        });
      }
      scanResolvedTree();
    }

    if (
      (!pmViewFound || !promptState) &&
      runtimeState.ngLViewMap instanceof Map
    ) {
      for (const lv of runtimeState.ngLViewMap.values()) {
        if (lv[0] instanceof Node && !lv[0].isConnected) continue;
        if (
          opts.excludeSelector &&
          lv[0] instanceof Element &&
          lv[0].closest(opts.excludeSelector)
        ) {
          continue;
        }
        extractFromLView(lv);
        if (pmViewFound && promptState) break;
      }
    }
    return { richEditor, pmViewFound, promptState };
  }

  const { richEditor, pmViewFound, promptState } =
    await capturePromptControllers(tb);
  runtimeState.promptState = promptState || null;
  const isPromptPopulated = (): boolean =>
    typeof promptState?.prompt?.Le === "function"
      ? promptState.prompt.Le() === false
      : false;
  const isSynced = (): boolean =>
    opts.strictSync && typeof promptState?.prompt?.Le === "function"
      ? isPromptPopulated()
      : true;

  if (opts.strictSync) {
    if (pmViewFound || richEditor?.th) {
      applyToPmView(pmViewFound || richEditor?.th, text);
      await delay(120);
      if (hasWritten() && isSynced()) {
        return { ok: true, tier: "closure_pm" };
      }
    }
  } else if (pmViewFound || richEditor?.th || promptState) {
    applyToPmView(pmViewFound || richEditor?.th, text);
    await delay(100);
    if (
      promptState &&
      typeof promptState.Wn === "function" &&
      promptState.prompt?.Le?.() !== false
    ) {
      try {
        promptState.Wn({ Oe: [{ type: "text", content: text }] });
      } catch {
        // Fall through to DOM checks.
      }
      await delay(80);
    }
    if (
      hasWritten() ||
      promptState?.prompt?.Le?.() === false ||
      promptState?.lf?.isValid?.() === true
    ) {
      return { ok: true, tier: "closure_pm" };
    }
  }

  function findEditorView(): ProseMirrorView | null {
    const roots: unknown[] = [tb, tb.firstChild, tb.parentElement].filter(Boolean);
    for (const root of roots) {
      if (isPmViewStruct(root)) return root;
      let keys: string[] = [];
      try {
        keys = Object.getOwnPropertyNames(root);
      } catch {
        continue;
      }
      for (const k of keys) {
        if (k.startsWith("__ng") || k.startsWith("__zone")) continue;
        const val = readOwn(root, k);
        if (isPmViewStruct(val)) return val;
        if (
          val &&
          typeof val === "object" &&
          !(val instanceof Node) &&
          val !== window
        ) {
          let subKeys: string[] = [];
          try {
            subKeys = Object.getOwnPropertyNames(val);
          } catch {
            continue;
          }
          for (const sk of subKeys) {
            if (sk.startsWith("__ng") || sk.startsWith("__zone")) continue;
            const sub = readOwn(val, sk);
            if (isPmViewStruct(sub)) return sub;
          }
        }
      }
    }
    return null;
  }

  const view = findEditorView();
  if (view && applyToPmView(view, text)) {
    await delay(120);
    if (hasWritten() && isSynced()) return { ok: true, tier: "editor_view" };
  }

  try {
    tb.focus();
    const p = tb.querySelector("p");
    if (p) p.textContent = "";
    else {
      const paragraph = document.createElement("p");
      paragraph.append(document.createElement("br"));
      tb.replaceChildren(paragraph);
    }
    await delay(40);
    const pasteEv = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(pasteEv, "clipboardData", {
      value: {
        getData: (t: string) => (t === "text/plain" ? text : ""),
        types: ["text/plain"],
        files: [],
        items: [],
      },
    });
    tb.dispatchEvent(pasteEv);
    await delay(120);
    if (hasWritten() && isSynced()) return { ok: true, tier: "paste" };
  } catch {
    // Fall through to execCommand tier.
  }

  try {
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(tb);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("delete", false);
    } else {
      document.execCommand("selectAll", false);
    }
    if (document.execCommand("insertText", false, text)) {
      await delay(100);
      if (hasWritten() && isSynced()) {
        return { ok: true, tier: "exec_command" };
      }
    }
  } catch {
    // Fall through to strictSync promptState tier.
  }

  if (
    opts.strictSync &&
    promptState &&
    typeof promptState.Wn === "function" &&
    !isPromptPopulated()
  ) {
    try {
      promptState.Wn({ Oe: [{ type: "text", content: text }] });
      await delay(120);
      if (isPromptPopulated()) {
        return { ok: true, tier: "prompt_state" };
      }
    } catch {
      // Fall through to beforeinput tier.
    }
  }

  try {
    tb.focus();
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(tb);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    tb.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "deleteContentBackward",
      }),
    );
    tb.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text,
      }),
    );
    await delay(120);
    if (hasWritten()) return { ok: true, tier: "beforeinput" };
  } catch {
    // Fall through to direct DOM paragraph update.
  }

  const p = tb.querySelector("p") ?? document.createElement("p");
  p.textContent = text;
  if (!p.parentElement) tb.replaceChildren(p);
  tb.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data: text,
    }),
  );
  await delay(220);
  return { ok: hasWritten(), tier: "dom_p" };
}
