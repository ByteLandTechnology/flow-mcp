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
  RichTextEditorInstance,
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
  const ujProp = readOwn(state, "uj");
  if (isPmTransaction(ujProp)) return ujProp;
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

/** Extracts a ProseMirror `EditorView` from a rich-text editor instance or wrapper object. */
function findPmViewInRichEditor(cand: unknown): ProseMirrorView | null {
  if (!cand || typeof cand !== "object" || cand instanceof Node) return null;
  if (isPmViewStruct(cand)) return cand;
  const tbVal = readOwn(cand, "Tb");
  if (isPmViewStruct(tbVal)) return tbVal;
  const thVal = readOwn(cand, "th");
  if (isPmViewStruct(thVal)) return thVal;

  let fallback: ProseMirrorView | null = null;
  for (const k of Object.keys(cand)) {
    const slotVal = readOwn(cand, k);
    if (isPmViewStruct(slotVal)) {
      if (readOwn(slotVal, "dom")) return slotVal;
      fallback ??= slotVal;
    } else if (
      slotVal &&
      typeof slotVal === "object" &&
      !(slotVal instanceof Node)
    ) {
      const subTb = readOwn(slotVal, "Tb");
      if (isPmViewStruct(subTb)) return subTb;
      const subTh = readOwn(slotVal, "th");
      if (isPmViewStruct(subTh)) return subTh;
    }
  }
  return fallback;
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
          const fn = readOwn(cur, k);
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
      if (typeof pmView.Td === "function") {
        const td = pmView.Td;
        dispatchFns.push((t) => td.call(pmView, t));
      }
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
    richEditor: RichTextEditorInstance | null;
    pmViewFound: ProseMirrorView | null;
    promptState: PromptStateController | null;
  }> {
    let richEditor: RichTextEditorInstance | null = null;
    let pmViewFound: ProseMirrorView | null = null;
    let promptState: PromptStateController | null = null;

    if (opts.liveUx) {
      if (
        opts.liveUx.Qa &&
        (typeof opts.liveUx.Qa.Gp === "function" ||
          typeof opts.liveUx.Qa.Wn === "function")
      ) {
        promptState = opts.liveUx.Qa;
      }
      try {
        const getEditor =
          typeof opts.liveUx.IU === "function"
            ? opts.liveUx.IU
            : typeof opts.liveUx.CQ === "function"
              ? opts.liveUx.CQ
              : null;
        const re = getEditor ? getEditor.call(opts.liveUx) : null;
        const view = findPmViewInRichEditor(re);
        if (re && view) {
          richEditor = re;
          pmViewFound = view;
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
          const editorGetter = readOwn(cand, "IU") ?? readOwn(cand, "CQ");
          if (!pmViewFound && typeof editorGetter === "function") {
            const re = editorGetter.call(cand) as
              | RichTextEditorInstance
              | null
              | undefined;
            const view = findPmViewInRichEditor(re);
            if (re && view) {
              richEditor = re;
              pmViewFound = view;
            }
          }
          if (!pmViewFound) {
            if (isPmViewStruct(cand)) {
              pmViewFound = cand;
            } else {
              const view = findPmViewInRichEditor(cand);
              if (view) {
                richEditor = cand as RichTextEditorInstance;
                pmViewFound = view;
              }
            }
          }
        } catch {
          // Ignore opaque getters.
        }
        try {
          if (!promptState) {
            const qaVal = readOwn(cand, "Qa") as PromptStateController | undefined;
            const ownApply = readOwn(cand, "Gp") ?? readOwn(cand, "Wn");
            const ownValidator = (readOwn(cand, "Ff") ?? readOwn(cand, "lf")) as
              | { isValid?: unknown }
              | undefined;
            if (
              qaVal &&
              (typeof qaVal.Gp === "function" || typeof qaVal.Wn === "function")
            ) {
              promptState = qaVal;
            } else if (
              typeof ownApply === "function" &&
              ownValidator &&
              typeof ownValidator.isValid === "function"
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
  const readPromptEmpty = (): boolean | null => {
    if (typeof promptState?.prompt?.Ke === "function") {
      return Boolean(promptState.prompt.Ke());
    }
    if (typeof promptState?.prompt?.Le === "function") {
      return Boolean(promptState.prompt.Le());
    }
    return null;
  };
  const hasValidator = (): boolean =>
    typeof promptState?.Ff?.isValid === "function" ||
    typeof promptState?.lf?.isValid === "function";
  const isPromptValid = (): boolean =>
    typeof promptState?.Ff?.isValid === "function"
      ? promptState.Ff.isValid() === true
      : typeof promptState?.lf?.isValid === "function"
        ? promptState.lf.isValid() === true
        : false;
  const applyPromptStateText = (content: string): boolean => {
    const applyFn =
      typeof promptState?.Gp === "function"
        ? promptState.Gp
        : typeof promptState?.Wn === "function"
          ? promptState.Wn
          : null;
    if (!promptState || !applyFn) return false;
    const segments = [{ type: "text", content }];
    applyFn.call(promptState, { Oe: segments, Te: segments });
    return true;
  };
  const isPromptPopulated = (): boolean => {
    const empty = readPromptEmpty();
    if (empty !== null) return empty === false;
    return hasValidator() ? isPromptValid() : false;
  };
  const isSynced = (): boolean =>
    opts.strictSync && (readPromptEmpty() !== null || hasValidator())
      ? isPromptPopulated()
      : true;
  const activePmTarget: unknown =
    pmViewFound || richEditor?.Tb || richEditor?.th;

  if (opts.strictSync) {
    if (activePmTarget) {
      applyToPmView(activePmTarget, text);
      await delay(120);
      if (hasWritten() && isSynced()) {
        return { ok: true, tier: "closure_pm" };
      }
    }
  } else if (activePmTarget || promptState) {
    applyToPmView(activePmTarget, text);
    await delay(100);
    if (
      promptState &&
      (typeof promptState.Gp === "function" ||
        typeof promptState.Wn === "function") &&
      !isPromptPopulated()
    ) {
      try {
        applyPromptStateText(text);
      } catch {
        // Fall through to DOM checks.
      }
      await delay(80);
    }
    if (hasWritten() || isPromptPopulated() || isPromptValid()) {
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
    (typeof promptState.Gp === "function" ||
      typeof promptState.Wn === "function") &&
    !isPromptPopulated()
  ) {
    try {
      applyPromptStateText(text);
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
