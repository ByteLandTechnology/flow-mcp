// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Parse Agent panel DOM turns and drive composer attachments and decision cards.

import { pickerElementMatches, type PickerMatchTarget } from "./angular";
import type { AgentDecision, AgentRequest, PendingAction, Session } from "./agent_protocol";
import {
  clickButtonByRegex,
  delay,
  dismissOverlay,
  elText,
  fifeBase,
  isVisibleEnabled,
  setNativeValue,
} from "./dom";
import { uploadUiAction } from "./open_upload_trigger";
import { readStoreSnapshot } from "./read_store_snapshot";

/** Normalized turn object returned by `get_turn`, `list_messages`, `send_message`, and `respond`. */
export interface UiFormattedTurn {
  /** One-based turn index in the session. */
  turn: number;
  /** Turn lifecycle status. */
  status: "in_progress" | "action_required" | "completed" | "failed" | "stopped" | "unknown";
  /** Optional response ID from DOM attributes. */
  response_id?: string;
  /** Connection status when `in_progress`. */
  connected?: boolean;
  /** User prompt and attachments on this turn. */
  user: {
    text: string;
    attachment_media_ids?: string[];
    attachment_character_ids?: string[];
  };
  /** Assistant reply text, generated media, and rich blocks. */
  assistant: {
    text: string;
    media: Array<{ media_id: string; status: string; error?: string }>;
    rich_content: unknown[];
  };
  /** Pending user decisions on the active/latest turn. */
  pending_actions: PendingAction[];
  /** Error message when `status === "failed"`. */
  error?: string;
}

/** Formats an error payload for MCP callers. */
export function uiFailure(
  error: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ok: false, error, ...extra };
}

/** Reads the composer textbox inside the Agent panel. */
export function findAgentTextbox(panel: HTMLElement): HTMLElement | null {
  const scope = panel.querySelector<HTMLElement>("flow-creative-agent-prompt-box") ?? panel;
  const candidates = Array.from(
    scope.querySelectorAll<HTMLElement>(
      '.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"], textarea, input[type="text"]',
    ),
  ).filter(
    (el) =>
      el.getClientRects().length > 0 &&
      !el.closest('[data-agent-settings], [data-action-type="question"]'),
  );
  return candidates[0] ?? null;
}

/** Finds the Send / Submit button in the Agent composer. */
export function findSendButton(panel: HTMLElement): HTMLElement | null {
  const scope = panel.querySelector<HTMLElement>("flow-creative-agent-prompt-box") ?? panel;
  return (
    Array.from(scope.querySelectorAll<HTMLElement>('button, [role="button"]')).find((el) => {
      if (!isVisibleEnabled(el)) return false;
      const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-action") || ""} ${elText(el)}`.trim();
      return /\b(?:send|submit|ask agent|arrow_upward|arrow_forward)\b/i.test(label);
    }) ?? null
  );
}

/** Parses pending permission, question, and plan cards inside a turn element. */
function parsePendingActions(turnEl: Element, isLatest: boolean): PendingAction[] {
  if (!isLatest) return [];
  const actions: PendingAction[] = [];

  for (const card of turnEl.querySelectorAll<HTMLElement>(
    'flow-agent-permission-card, [data-action-type="permission"], .permission-card',
  )) {
    if (card.getClientRects().length === 0 || card.getAttribute("data-resolved") === "true") {
      continue;
    }
    const approveBtn = Array.from(card.querySelectorAll("button")).find((b) =>
      /\bapprove\b/i.test(`${b.getAttribute("aria-label") || ""} ${elText(b)}`),
    );
    if (!approveBtn || approveBtn.disabled) continue;
    const txt = elText(card);
    const credits =
      Number.parseInt(
        card.getAttribute("data-credits") || /(\d+)\s*credits?/i.exec(txt)?.[1] || "0",
        10,
      ) || 0;
    const image_count =
      Number.parseInt(
        card.getAttribute("data-image-count") || /(\d+)\s*images?/i.exec(txt)?.[1] || "0",
        10,
      ) || 0;
    const video_count =
      Number.parseInt(
        card.getAttribute("data-video-count") || /(\d+)\s*videos?/i.exec(txt)?.[1] || "0",
        10,
      ) || 0;
    actions.push({
      type: "permission",
      action_id: card.getAttribute("data-action-id") || "ui-permission",
      image_count,
      video_count,
      credits,
    });
  }

  for (const card of turnEl.querySelectorAll<HTMLElement>(
    'flow-agent-question-card, [data-action-type="question"], .question-card',
  )) {
    if (card.getClientRects().length === 0 || card.getAttribute("data-resolved") === "true") {
      continue;
    }
    const qNodes = card.querySelectorAll<HTMLElement>("[data-question-id], .agent-question-item");
    const roots = qNodes.length > 0 ? Array.from(qNodes) : [card];
    const questions = roots.map((qEl, idx) => {
      const qid = qEl.getAttribute("data-question-id") || `q-${idx + 1}`;
      const promptEl = qEl.querySelector(".question-text, [data-question-text], h4, p");
      const multiple =
        qEl.getAttribute("data-multiple") === "true" ||
        Boolean(qEl.querySelector('input[type="checkbox"]'));
      const optEls = Array.from(
        qEl.querySelectorAll<HTMLElement>("[data-option-id], .question-option"),
      );
      const options = optEls.map((oEl, oIdx) => ({
        option_id: oEl.getAttribute("data-option-id") || `opt-${oIdx + 1}`,
        label: (oEl.getAttribute("data-label") || elText(oEl)).trim(),
        allows_text:
          oEl.getAttribute("data-allows-text") === "true" ||
          Boolean(oEl.querySelector('input[type="text"], textarea')),
      }));
      return {
        question_id: qid,
        text: promptEl ? elText(promptEl).trim() : elText(qEl).trim(),
        multiple,
        options,
      };
    });
    if (questions.some((q) => q.options.length > 0)) {
      actions.push({
        type: "question",
        action_id: card.getAttribute("data-action-id") || "ui-question",
        questions,
      });
    }
  }

  for (const card of turnEl.querySelectorAll<HTMLElement>(
    'flow-agent-plan-card, [data-action-type="plan"], .plan-card',
  )) {
    if (card.getClientRects().length === 0 || card.getAttribute("data-resolved") === "true") {
      continue;
    }
    const hasRunBtn = Array.from(card.querySelectorAll("button")).some(
      (b) =>
        !b.disabled &&
        /\b(?:run full plan|previz)\b/i.test(`${b.getAttribute("aria-label") || ""} ${elText(b)}`),
    );
    if (!hasRunBtn) continue;
    const titleEl = card.querySelector(".plan-title, [data-plan-title], h3, h4");
    const descEl = card.querySelector(".plan-description, [data-plan-description], p");
    actions.push({
      type: "plan",
      action_id: card.getAttribute("data-action-id") || "plan",
      title: titleEl ? elText(titleEl).trim() : "Plan",
      description: descEl ? elText(descEl).trim() : "",
      decisions: ["run_full_plan", "previz"],
    });
  }

  return actions;
}

/** Parses rendered conversation turns from the workspace Agent panel DOM. */
export function parseRenderedTurns(panel: HTMLElement): UiFormattedTurn[] {
  const turnEls = Array.from(
    panel.querySelectorAll<HTMLElement>("flow-agent-turn, [data-turn], .agent-turn"),
  ).filter((el) => el.getClientRects().length > 0);

  return turnEls.map((el, idx) => {
    const number = Number.parseInt(el.getAttribute("data-turn") || "", 10) || idx + 1;
    const isLatest = idx === turnEls.length - 1;
    const rawStatus = (el.getAttribute("data-status") || "").toLowerCase();
    const isStreaming =
      rawStatus === "in_progress" ||
      el.getAttribute("aria-busy") === "true" ||
      Boolean(el.querySelector('.streaming-indicator, [aria-busy="true"]'));

    const userEl = el.querySelector(".user-turn, [data-role='user'], .user-message");
    const assistantEl = el.querySelector(
      ".assistant-turn, [data-role='assistant'], .assistant-message",
    );
    const userText = userEl ? elText(userEl).trim() : (el.getAttribute("data-user-text") || "");
    const assistantText = assistantEl
      ? elText(assistantEl).trim()
      : (el.getAttribute("data-assistant-text") || "");

    const attMedia = Array.from(el.querySelectorAll("[data-attachment-media-id]"))
      .map((n) => n.getAttribute("data-attachment-media-id") || "")
      .filter(Boolean);
    const attChars = Array.from(el.querySelectorAll("[data-attachment-character-id]"))
      .map((n) => n.getAttribute("data-attachment-character-id") || "")
      .filter(Boolean);

    const media = Array.from(
      (assistantEl ?? el).querySelectorAll<HTMLElement>(
        "[data-generated-media-id], [data-media-id]",
      ),
    )
      .filter((m) => !m.hasAttribute("data-attachment-media-id"))
      .map((m) => ({
        media_id:
          m.getAttribute("data-generated-media-id") || m.getAttribute("data-media-id") || "",
        status: m.getAttribute("data-media-status") || "success",
        error: m.getAttribute("data-media-error") || undefined,
      }))
      .filter((m) => Boolean(m.media_id));

    const errEl = el.querySelector(".turn-error, [data-turn-error]");
    const errorMsg =
      el.getAttribute("data-turn-error") || (errEl ? elText(errEl).trim() : "") || undefined;

    const pending = parsePendingActions(el, isLatest);
    let status: UiFormattedTurn["status"] = "completed";
    if (pending.length > 0) status = "action_required";
    else if (isStreaming) status = "in_progress";
    else if (rawStatus === "stopped") status = "stopped";
    else if (rawStatus === "failed" || errorMsg) status = "failed";

    return {
      turn: number,
      status,
      response_id: el.getAttribute("data-response-id") || undefined,
      connected: status === "in_progress" ? true : undefined,
      user: {
        text: userText,
        ...(attMedia.length > 0 ? { attachment_media_ids: attMedia } : {}),
        ...(attChars.length > 0 ? { attachment_character_ids: attChars } : {}),
      },
      assistant: {
        text: assistantText,
        media,
        rich_content: [],
      },
      pending_actions: pending,
      ...(errorMsg ? { error: errorMsg } : {}),
    };
  });
}

/** Attaches project assets/characters and staged local files to the Agent composer via UI controls. */
export async function attachComposerItems(
  panel: HTMLElement,
  assetIds: string[],
  files: File[],
): Promise<{ ok: true; uploadedIds: string[] } | { ok: false; error: string }> {
  const liveComposer = (): HTMLElement =>
    panel.querySelector<HTMLElement>("flow-creative-agent-prompt-box") ?? panel;
  const snap = assetIds.length > 0 ? readStoreSnapshot(true) : null;

  for (const rawId of assetIds) {
    const id = rawId.trim();
    if (!id) continue;
    const composer = liveComposer();
    const asset = snap?.ok ? snap.assets?.find((a) => a.id === id) : undefined;
    const target: PickerMatchTarget = {
      id,
      primaryMediaId: asset?.primary_media_id ?? null,
      lowName: asset?.name ? asset.name.toLowerCase() : undefined,
      url: asset?.url ?? null,
      fife: fifeBase(asset?.url ?? ""),
    };

    const addBtn = Array.from(composer.querySelectorAll<HTMLElement>('button, [role="button"]')).find(
      (b) =>
        isVisibleEnabled(b) &&
        /\b(?:add|attach|ingredient|reference|asset|\+)\b/i.test(
          `${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""} ${elText(b)}`,
        ),
    );
    if (!addBtn) return { ok: false, error: "agent_attachment_picker_not_found" };
    addBtn.click();
    await delay(180);

    const pickerScope =
      document.querySelector<HTMLElement>(
        ".cdk-overlay-pane, [data-agent-asset-picker], .ingredient-picker",
      ) ?? document.body;
    const items = Array.from(
      pickerScope.querySelectorAll<HTMLElement>(
        "[data-asset-id], [data-tile-id], [data-character-id], flow-grid-tile-container, .picker-item, [role='option'], [role='menuitem']",
      ),
    ).filter((el) => el.getClientRects().length > 0);
    const match =
      items.find(
        (el) =>
          el.getAttribute("data-asset-id") === id ||
          el.getAttribute("data-tile-id") === id ||
          el.getAttribute("data-character-id") === id,
      ) ?? items.find((el) => pickerElementMatches(el, target));
    if (!match) {
      await dismissOverlay();
      return { ok: false, error: `agent_attachment_not_found:${id}` };
    }
    match.click();
    await delay(150);
    const confirmPick = pickerScope.querySelector<HTMLElement>(
      'button[data-action="confirm-attachments"], button[aria-label="Done"]',
    );
    if (confirmPick && isVisibleEnabled(confirmPick)) {
      confirmPick.click();
      await delay(120);
    }
  }

  const uploadedIds: string[] = [];
  if (files.length > 0) {
    const composer = liveComposer();
    const readChipIds = (): string[] =>
      Array.from(liveComposer().querySelectorAll("[data-uploaded-asset-id], [data-asset-id]"))
        .map(
          (n) => n.getAttribute("data-uploaded-asset-id") || n.getAttribute("data-asset-id") || "",
        )
        .filter(Boolean);
    const beforeChips = new Set(readChipIds());
    const snapBefore = readStoreSnapshot(true);
    const beforeAssets = new Set(snapBefore.ok ? (snapBefore.assets?.map((a) => a.id) ?? []) : []);
    let fileInput = composer.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) {
      let captured: HTMLInputElement | null = null;
      const origClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function (this: HTMLInputElement): void {
        if (this.type === "file") {
          captured = this;
          return;
        }
        origClick.call(this);
      };
      try {
        const upTrigger = Array.from(
          composer.querySelectorAll<HTMLElement>('button, [role="button"]'),
        ).find(
          (b) =>
            isVisibleEnabled(b) &&
            /\b(?:upload|attach file|add file|add_photo_alternate|\+)\b/i.test(
              `${b.getAttribute("aria-label") || ""} ${elText(b)}`,
            ),
        );
        upTrigger?.click();
        await delay(120);
        if (!captured) {
          const menuUp = Array.from(
            document.querySelectorAll<HTMLElement>('[role="menuitem"], .cdk-overlay-pane button'),
          ).find(
            (b) =>
              isVisibleEnabled(b) &&
              /\bupload\b/i.test(`${b.getAttribute("aria-label") || ""} ${elText(b)}`),
          );
          menuUp?.click();
        }
      } finally {
        HTMLInputElement.prototype.click = origClick;
      }
      fileInput =
        captured ??
        document.querySelector<HTMLInputElement>(
          'flow-agent-panel input[type="file"], input[type="file"][data-agent-upload]',
        );
    }
    if (!fileInput) return { ok: false, error: "agent_file_input_not_found" };

    const dt = new DataTransfer();
    for (const file of files) dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("input", { bubbles: true }));
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    for (let i = 0; i < 15 && uploadedIds.length < files.length; i++) {
      await delay(120);
      uploadUiAction("accept_consent");
      for (const cid of readChipIds()) {
        if (!beforeChips.has(cid) && !uploadedIds.includes(cid)) uploadedIds.push(cid);
      }
      const snapAfter = readStoreSnapshot(true);
      if (snapAfter.ok) {
        for (const a of snapAfter.assets ?? []) {
          if (!beforeAssets.has(a.id) && !uploadedIds.includes(a.id)) uploadedIds.push(a.id);
        }
      }
    }
  }

  return { ok: true, uploadedIds };
}

/** Validates question answers against the pending question action schema. */
function validateQuestionAnswers(
  action: Extract<PendingAction, { type: "question" }>,
  answers: NonNullable<AgentRequest["answers"]>,
): boolean {
  const seen = new Set<string>();
  for (const ans of answers) {
    const q = action.questions.find((item) => item.question_id === ans.question_id);
    const text = ans.text?.trim();
    const opts = new Set(ans.option_ids);
    if (
      !q ||
      seen.has(ans.question_id) ||
      opts.size !== ans.option_ids.length ||
      (!q.multiple && opts.size > 1) ||
      (!text && opts.size === 0) ||
      [...opts].some((oid) => !q.options.some((o) => o.option_id === oid)) ||
      (text && (!q.options.some((o) => o.allows_text) || (!q.multiple && opts.size > 0)))
    ) {
      return false;
    }
    seen.add(ans.question_id);
  }
  return answers.length > 0;
}

/** Clicks the matching permission, question, or plan decision control in the Agent panel UI. */
export async function respondViaUi(
  panel: HTMLElement,
  session: Session,
  req: AgentRequest,
): Promise<Record<string, unknown>> {
  const turns = parseRenderedTurns(panel);
  const latest = turns.at(-1);
  const action =
    latest && latest.turn === req.turn
      ? latest.pending_actions.find((a) => a.action_id === req.action_id)
      : undefined;
  if (!action) return uiFailure("agent_action_not_pending");

  const turnEls = Array.from(
    panel.querySelectorAll<HTMLElement>("flow-agent-turn, [data-turn], .agent-turn"),
  ).filter((el) => el.getClientRects().length > 0);
  const latestEl = turnEls.at(-1);
  if (!latestEl) return uiFailure("agent_action_not_pending");

  if (action.type === "permission") {
    const labelMap: Partial<Record<AgentDecision, RegExp>> = {
      approve: /^(?:approve|allow|confirm)$/i,
      approve_and_remember: /^(?:always approve|always allow|approve and remember)$/i,
      deny: /^(?:reject|deny|cancel)$/i,
    };
    const pattern = req.decision ? labelMap[req.decision] : undefined;
    if (!pattern) return uiFailure("invalid_agent_permission_decision");
    const card =
      latestEl.querySelector<HTMLElement>(
        `[data-action-id="${CSS.escape(action.action_id)}"], flow-agent-permission-card, [data-action-type="permission"], .permission-card`,
      ) ?? latestEl;
    if (!clickButtonByRegex(pattern, card)) {
      return uiFailure("agent_permission_button_not_found");
    }
    await delay(200);
    return { ok: true, ...session, turn: parseRenderedTurns(panel).at(-1) };
  }

  if (action.type === "question") {
    if (!req.answers || !validateQuestionAnswers(action, req.answers)) {
      return uiFailure("invalid_agent_question_answers");
    }
    const card =
      latestEl.querySelector<HTMLElement>(
        `[data-action-id="${CSS.escape(action.action_id)}"], flow-agent-question-card, [data-action-type="question"], .question-card`,
      ) ?? latestEl;
    for (const ans of req.answers) {
      const qScope =
        card.querySelector<HTMLElement>(`[data-question-id="${CSS.escape(ans.question_id)}"]`) ??
        card;
      for (const oid of ans.option_ids) {
        const optEl =
          qScope.querySelector<HTMLElement>(`[data-option-id="${CSS.escape(oid)}"]`) ??
          Array.from(qScope.querySelectorAll<HTMLElement>(".question-option, button, label")).find(
            (el) => el.getAttribute("data-option-id") === oid,
          );
        if (!optEl) return uiFailure("agent_question_option_not_found");
        (optEl.querySelector<HTMLElement>("button, input") ?? optEl).click();
        await delay(80);
      }
      if (ans.text?.trim()) {
        const freeInput = qScope.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          'input[type="text"], textarea',
        );
        if (!freeInput) return uiFailure("agent_question_text_input_not_found");
        freeInput.focus();
        setNativeValue(freeInput, ans.text.trim(), true);
        await delay(80);
      }
    }
    clickButtonByRegex(/^(?:submit|send|continue|confirm|next)$/i, card);
    await delay(200);
    return { ok: true, ...session, turn: parseRenderedTurns(panel).at(-1) };
  }

  const planLabels: Partial<Record<AgentDecision, RegExp>> = {
    run_full_plan: /\brun full plan\b/i,
    previz: /\bpreviz\b/i,
  };
  const planPattern = req.decision ? planLabels[req.decision] : undefined;
  if (!planPattern) return uiFailure("invalid_agent_plan_decision");
  const card =
    latestEl.querySelector<HTMLElement>(
      `[data-action-id="${CSS.escape(action.action_id)}"], flow-agent-plan-card, [data-action-type="plan"], .plan-card`,
    ) ?? latestEl;
  const btn = Array.from(card.querySelectorAll<HTMLElement>("button, [role='button']")).find(
    (b) =>
      isVisibleEnabled(b) &&
      planPattern.test(`${b.getAttribute("aria-label") || ""} ${elText(b)}`),
  );
  if (!btn) return uiFailure("agent_plan_button_not_found");
  btn.click();
  for (let i = 0; i < 30; i++) {
    await delay(100);
    const updated = parseRenderedTurns(panel);
    if (updated.length > turns.length) {
      return { ok: true, ...session, turn: updated.at(-1) };
    }
  }
  return { ok: true, ...session, turn: parseRenderedTurns(panel).at(-1) };
}
