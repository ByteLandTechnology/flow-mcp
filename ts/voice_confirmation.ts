// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Confirm that Flow saved the voice that the character form selected.

import { isLiveLView, readOwn, resolveLView } from "./angular";
import { delay } from "./dom";
import type { VoiceConfirmationFormat } from "./frontend_builds";
import { runtimeState } from "./state";

/** Reads the picker selection after Flow reports a custom voice save. */
interface CustomVoiceReceipt {
  /** Returns the ID of the saved voice selected by the picker. */
  selected: () => string | undefined;
  /** Stops listening for voice saves. */
  close: () => void;
}

/** Finds a component in the view of its host or in a live Angular view. */
function findComponent(host: Element, matches: (value: unknown) => boolean): unknown {
  const view = resolveLView(host);
  const local = view?.find(matches);
  if (local) return local;
  for (const candidate of runtimeState.ngLViewMap?.values() ?? []) {
    if (!isLiveLView(candidate) || candidate[0] !== host) continue;
    const component = candidate.find(matches);
    if (component) return component;
  }
}

/** Reads a voice ID and removes the optional prefix that Flow uses in the picker. */
function voiceId(component: unknown, field: string): string | undefined {
  const read = readOwn(component, field);
  if (typeof read !== "function") return undefined;
  const value: unknown = read.call(component);
  return typeof value === "string" && value ? value.replace(/^voices\//i, "") : undefined;
}

/** Watches the native save event and reads the exact voice selected for assignment. */
export function bindCustomVoiceReceipt(pane: Element, format: VoiceConfirmationFormat): CustomVoiceReceipt | undefined {
  const preview = pane.querySelector("flow-voice-preview-pane");
  const picker = pane.querySelector("flow-add-menu-popover-content");
  if (!preview || !picker) return;
  const component = findComponent(preview, (value) =>
    typeof readOwn(readOwn(value, format.previewSaved), "subscribe") === "function",
  );
  const menu = findComponent(picker, (value) =>
    typeof readOwn(value, format.pickerSelection) === "function",
  );
  const output = readOwn(component, format.previewSaved);
  const subscribe = readOwn(output, "subscribe");
  const selected = readOwn(menu, format.pickerSelection);
  if (typeof subscribe !== "function" || typeof selected !== "function") return;

  let receipt: unknown;
  const subscription: unknown = subscribe.call(output, (value: unknown) => { receipt = value; });
  return {
    selected: () => {
      const media = readOwn(receipt, "mediaId");
      const workflow = readOwn(receipt, "workflowId");
      if (!media && !workflow) return;
      const asset: unknown = selected.call(menu);
      if ((media && readOwn(asset, "mediaId") === media) ||
          (workflow && readOwn(asset, "workflowId") === workflow)) {
        const id = readOwn(asset, "id");
        if (typeof id === "string") return id;
      }
    },
    close: () => {
      const unsubscribe = readOwn(subscription, "unsubscribe");
      if (typeof unsubscribe === "function") unsubscribe.call(subscription);
    },
  };
}

/** Binds the editor's entity query and form before the tool clicks Add to character. */
export function bindVoiceConfirmation(format: VoiceConfirmationFormat) {
  const shell = document.querySelector("flow-character-edit-page");
  const formHost = shell?.querySelector("flow-character-form");
  const frontEnd = readOwn(window, "default_AiSandboxAngularFrontend");
  const editorType = readOwn(frontEnd, format.editor);
  if (!shell || !formHost || typeof editorType !== "function") return;
  const editor = findComponent(shell, (value) => value instanceof editorType);
  const form = findComponent(formHost, (value) => typeof readOwn(value, format.selectedVoice) === "function");
  const query = readOwn(editor, format.entityQuery);
  const fetch = readOwn(query, "refetch");
  if (!form || typeof fetch !== "function" || typeof readOwn(editor, format.savedVoice) !== "function") return;

  return async (expected?: string) => {
    const selected = voiceId(form, format.selectedVoice);
    if (!selected || (expected && selected !== expected.replace(/^voices\//i, ""))) return false;
    const deadline = performance.now() + 7_000;
    while (performance.now() < deadline && shell.isConnected) {
      const remaining = deadline - performance.now();
      const result = await Promise.race([
        Promise.resolve(fetch.call(query)).catch(() => null),
        delay(remaining).then(() => null),
      ]);
      if (readOwn(result, "status") === "success" && voiceId(editor, format.savedVoice) === selected) return true;
      await delay(250);
    }
    return false;
  };
}
