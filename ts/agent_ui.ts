// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Drive Flow Agent chat sessions, turns, and history controls via workspace panel UI.

import type { AgentRequest, Session } from "./agent_protocol";
import {
  agentSettingsUiOp,
  ensureAgentPanelOpen,
  findAgentPanelRoot,
  uiSettingsWritePending,
} from "./agent_settings_ui";
import {
  attachComposerItems,
  findAgentTextbox,
  findSendButton,
  parseRenderedTurns,
  respondViaUi,
  uiFailure,
  type UiFormattedTurn,
} from "./agent_ui_dom";
import {
  clickButtonByRegex,
  delay,
  dismissOverlay,
  elText,
  isVisibleEnabled,
  setNativeValue,
} from "./dom";
import { writePromptBox } from "./prompt_writer";

/** UI fallback binding state for a single project workspace. */
interface UiAgentState {
  /** Pinned project ID. */
  projectId: string;
  /** Allocated draft session IDs not yet sent. */
  drafts: Set<string>;
  /** Alias map from MCP session ID to DOM session ID when Flow assigns its own ID. */
  mcpToDomId: Map<string, string>;
  /** Reverse alias map from DOM session ID to MCP session ID. */
  domToMcpId: Map<string, string>;
  /** Known persisted session metadata keyed by MCP session ID. */
  sessions: Map<string, { title: string }>;
  /** Currently displayed MCP session ID in the panel. */
  activeMcpId: string | null;
}

/** Active UI fallback state for the current document. */
let uiState: UiAgentState | null = null;

/** Checks whether the browser route is on `/project/<projectId>`. */
function onProject(projectId: string): boolean {
  return /(?:^|\/)project\/([^/?#]+)\/?$/.exec(location.pathname || "")?.[1] === projectId;
}

/** Binds the workspace Agent panel in UI fallback mode for `projectId`. */
export async function agentUiBind(projectId: string): Promise<Record<string, unknown>> {
  if (!onProject(projectId)) return uiFailure("agent_page_not_ready");
  const panel = await ensureAgentPanelOpen();
  if (!panel) return uiFailure("agent_page_not_ready");
  if (!uiState || uiState.projectId !== projectId) {
    uiState = {
      projectId,
      drafts: new Set(),
      mcpToDomId: new Map(),
      domToMcpId: new Map(),
      sessions: new Map(),
      activeMcpId: null,
    };
  }
  syncSessionsFromDom(panel, uiState);
  return { ok: true, mode: "ui" };
}

/** Returns true when `agentUiBind` has bound `projectId` and the panel remains mounted. */
export function agentUiBound(projectId: string): boolean {
  return Boolean(
    uiState && uiState.projectId === projectId && onProject(projectId) && findAgentPanelRoot(),
  );
}

/** Returns true while a turn in the Agent panel is streaming or settings are saving. */
export function agentUiBusy(projectId: string): boolean {
  if (!agentUiBound(projectId)) return false;
  if (uiSettingsWritePending) return true;
  const panel = findAgentPanelRoot();
  if (!panel) return false;
  const turns = parseRenderedTurns(panel);
  return turns.at(-1)?.status === "in_progress";
}

/** Allocates a draft session ID in UI fallback mode. */
export function agentUiAllocate(projectId: string): Record<string, unknown> {
  if (!agentUiBound(projectId) || !uiState) return uiFailure("agent_project_changed");
  const id = crypto.randomUUID();
  uiState.drafts.add(id);
  return { ok: true, session_id: id };
}

/** Synchronizes DOM session list items with `state`. */
function syncSessionsFromDom(panel: HTMLElement, state: UiAgentState): Session[] {
  const activeDomAttr = panel.getAttribute("data-active-session-id") || "";
  const items = Array.from(
    document.querySelectorAll<HTMLElement>(
      'flow-agent-panel [data-session-id], .agent-panel-wrapper [data-session-id], .cdk-overlay-pane [data-session-id]',
    ),
  );
  for (const el of items) {
    const domId = el.getAttribute("data-session-id") || "";
    if (!domId) continue;
    let mcpId = state.domToMcpId.get(domId);
    if (!mcpId) {
      mcpId = domId;
      state.domToMcpId.set(domId, mcpId);
      state.mcpToDomId.set(mcpId, domId);
    }
    state.drafts.delete(mcpId);
    const titleEl = el.querySelector(".session-title, [data-session-title]") ?? el;
    const rawTitle = (el.getAttribute("data-session-title") || elText(titleEl)).trim();
    state.sessions.set(mcpId, { title: rawTitle });
    if (
      domId === activeDomAttr ||
      el.getAttribute("aria-selected") === "true" ||
      el.getAttribute("aria-current") === "true" ||
      el.classList.contains("active")
    ) {
      state.activeMcpId = mcpId;
    }
  }
  if (activeDomAttr) {
    const mapped = state.domToMcpId.get(activeDomAttr) ?? activeDomAttr;
    state.domToMcpId.set(activeDomAttr, mapped);
    state.mcpToDomId.set(mapped, activeDomAttr);
    state.activeMcpId = mapped;
    if (!state.sessions.has(mapped)) {
      const headerTitle = panel.querySelector(".agent-session-title, [data-active-session-title]");
      state.sessions.set(mapped, { title: headerTitle ? elText(headerTitle).trim() : "" });
    }
  }

  const out: Session[] = [];
  for (const draftId of state.drafts) {
    out.push({ session_id: draftId, title: "", persisted: false });
  }
  for (const [session_id, meta] of state.sessions.entries()) {
    if (!state.drafts.has(session_id)) {
      out.push({ session_id, title: meta.title, persisted: true });
    }
  }
  return out;
}

/** Opens the session switcher menu if present so hidden session entries become inspectable. */
async function withSessionListOpen<T>(
  panel: HTMLElement,
  fn: () => Promise<T>,
): Promise<T> {
  const trigger = Array.from(panel.querySelectorAll<HTMLElement>('button, [role="button"]')).find(
    (b) =>
      isVisibleEnabled(b) &&
      /\b(?:sessions|chat history|history|previous chats|conversations)\b/i.test(
        `${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""} ${elText(b)}`,
      ),
  );
  if (!trigger) return await fn();
  const alreadyOpen = Boolean(
    Array.from(
      document.querySelectorAll<HTMLElement>(
        'flow-agent-panel [data-session-id], .cdk-overlay-pane [data-session-id], [data-session-menu-open="true"]',
      ),
    ).some((el) => el.getClientRects().length > 0),
  );
  if (!alreadyOpen) {
    trigger.click();
    await delay(150);
  }
  try {
    return await fn();
  } finally {
    if (!alreadyOpen && document.querySelector(".cdk-overlay-pane [data-session-id]")) {
      await dismissOverlay();
    }
  }
}

/** Switches the panel UI to display `mcpId`. */
async function selectUiSession(
  panel: HTMLElement,
  state: UiAgentState,
  mcpId: string,
): Promise<boolean> {
  if (state.activeMcpId === mcpId) return true;
  const domId = state.mcpToDomId.get(mcpId) ?? mcpId;
  return await withSessionListOpen(panel, async () => {
    const item = Array.from(
      document.querySelectorAll<HTMLElement>("[data-session-id]"),
    ).find((el) => el.getAttribute("data-session-id") === domId && el.getClientRects().length > 0);
    if (!item) return false;
    const clickTarget = item.querySelector<HTMLElement>("button, a, .session-select") ?? item;
    clickTarget.click();
    await delay(180);
    state.activeMcpId = mcpId;
    return true;
  });
}

/** Submits a new session or follow-up message through the Agent composer UI. */
async function sendUiMessage(
  panel: HTMLElement,
  state: UiAgentState,
  req: AgentRequest,
  files: File[],
): Promise<Record<string, unknown>> {
  const sessionId = req.session_id || "";
  if (!sessionId) return uiFailure("agent_session_id_required");

  if (req.action === "create_session") {
    const existingTurns = parseRenderedTurns(panel);
    if (existingTurns.length > 0 || state.activeMcpId) {
      const newChatBtn = Array.from(
        panel.querySelectorAll<HTMLElement>('button, [role="button"]'),
      ).find(
        (b) =>
          isVisibleEnabled(b) &&
          /\b(?:new chat|new session|new conversation|start new)\b/i.test(
            `${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""} ${elText(b)}`,
          ),
      );
      if (newChatBtn) {
        newChatBtn.click();
        await delay(180);
      }
    }
  } else {
    const switched = await selectUiSession(panel, state, sessionId);
    if (!switched && !state.sessions.has(sessionId) && !state.drafts.has(sessionId)) {
      return uiFailure("agent_session_not_found", { session_id: sessionId });
    }
  }

  const beforeTurns = parseRenderedTurns(panel);
  if (beforeTurns.at(-1)?.status === "in_progress") {
    return uiFailure("agent_turn_active_or_unavailable");
  }

  const assetIds = req.asset_ids?.map((s) => s.trim()).filter(Boolean) ?? [];
  const attached = await attachComposerItems(panel, assetIds, files);
  if (!attached.ok) return uiFailure(attached.error, { session_id: sessionId });

  const tb = findAgentTextbox(panel);
  if (!tb) return uiFailure("agent_prompt_textbox_not_found");
  const text = req.message ?? "";
  if (tb instanceof HTMLTextAreaElement || tb instanceof HTMLInputElement) {
    tb.focus();
    setNativeValue(tb, text, true);
  } else {
    const written = await writePromptBox(tb, text, {
      seeds: [panel.querySelector("flow-creative-agent-prompt-box"), panel],
      strictSync: false,
      trySettingsClick: false,
    });
    if (!written.ok) {
      tb.focus();
      tb.textContent = text;
      tb.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    }
  }
  await delay(100);

  const sendBtn = findSendButton(panel);
  if (!sendBtn) return uiFailure("agent_send_button_not_found");
  sendBtn.click();

  const wantTurn = beforeTurns.length + 1;
  let observed: UiFormattedTurn | undefined;
  for (let i = 0; i < 40; i++) {
    await delay(100);
    const nowTurns = parseRenderedTurns(panel);
    observed =
      nowTurns.find((t) => t.turn === wantTurn) ??
      (nowTurns.length > beforeTurns.length ? nowTurns.at(-1) : undefined);
    if (observed) break;
  }

  let domActiveId = panel.getAttribute("data-active-session-id") || "";
  if (!domActiveId && req.action === "create_session") {
    domActiveId = await withSessionListOpen(panel, async () => {
      const cur = document.querySelector<HTMLElement>(
        '[data-session-id][aria-current="true"], [data-session-id][aria-selected="true"], [data-session-id].active',
      );
      return cur?.getAttribute("data-session-id") || "";
    });
  }
  domActiveId = domActiveId || (state.mcpToDomId.get(sessionId) ?? sessionId);
  state.drafts.delete(sessionId);
  state.mcpToDomId.set(sessionId, domActiveId);
  state.domToMcpId.set(domActiveId, sessionId);
  state.activeMcpId = sessionId;
  const headerTitle = panel.querySelector(".agent-session-title, [data-active-session-title]");
  const title = headerTitle
    ? elText(headerTitle).trim()
    : (state.sessions.get(sessionId)?.title ?? text.slice(0, 40));
  state.sessions.set(sessionId, { title });

  if (!observed) {
    return uiFailure("agent_submission_not_observed", { session_id: sessionId, turn: wantTurn });
  }
  return {
    ok: true,
    session_id: sessionId,
    title,
    persisted: true,
    turn: observed,
    ...(attached.uploadedIds.length > 0 ? { uploaded_asset_ids: attached.uploadedIds } : {}),
  };
}

/** Executes an `AgentRequest` through the workspace Agent panel UI fallback. */
export async function agentUiOp(
  request: AgentRequest,
  files: File[],
): Promise<Record<string, unknown>> {
  if (!onProject(request.project_id)) return uiFailure("agent_project_changed");
  const panel = await ensureAgentPanelOpen();
  if (!panel) return uiFailure("agent_panel_not_found");
  if (!uiState || uiState.projectId !== request.project_id) {
    await agentUiBind(request.project_id);
  }
  if (!uiState) return uiFailure("agent_project_changed");

  if (request.action === "get_settings" || request.action === "update_settings") {
    if (request.action === "update_settings" && agentUiBusy(request.project_id)) {
      return uiFailure("agent_turn_active");
    }
    return await agentSettingsUiOp(request.project_id, request.settings ?? undefined);
  }

  if (request.action === "list_sessions") {
    const sessions = await withSessionListOpen(panel, async () =>
      syncSessionsFromDom(panel, uiState!),
    );
    const canSend = Boolean(findAgentTextbox(panel)) && !agentUiBusy(request.project_id);
    return {
      ok: true,
      project_id: request.project_id,
      can_send: canSend,
      sessions,
    };
  }

  const id = request.session_id;
  if (!id) return uiFailure("agent_session_id_required");

  if (request.action === "create_session" || request.action === "send_message") {
    return await sendUiMessage(panel, uiState, request, files);
  }

  const allSessions = await withSessionListOpen(panel, async () =>
    syncSessionsFromDom(panel, uiState!),
  );
  const session = allSessions.find((s) => s.session_id === id);
  if (!session) return uiFailure("agent_session_not_found", { session_id: id });

  if (request.action === "rename_session") {
    if (!session.persisted) return uiFailure("agent_session_not_saved", { session_id: id });
    await selectUiSession(panel, uiState, id);
    const title = request.title?.trim() ?? "";
    const domId = uiState.mcpToDomId.get(id) ?? id;
    await withSessionListOpen(panel, async () => {
      const row =
        document.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(domId)}"]`) ?? panel;
      const renameBtn = Array.from(row.querySelectorAll<HTMLElement>('button, [role="button"]')).find(
        (b) =>
          isVisibleEnabled(b) &&
          /\brename\b/i.test(
            `${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""} ${elText(b)}`,
          ),
      );
      renameBtn?.click();
      await delay(120);
      const input =
        document.querySelector<HTMLInputElement>(
          '[data-session-rename-input], input[aria-label*="Session title" i], input[aria-label*="Rename" i]',
        ) ?? row.querySelector<HTMLInputElement>("input");
      if (input) {
        input.focus();
        setNativeValue(input, title, true);
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }),
        );
        input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
        await delay(120);
      }
    });
    uiState.sessions.set(id, { title });
    return { ok: true, ...session, title };
  }

  if (request.action === "delete_session") {
    if (!session.persisted) return uiFailure("agent_session_not_saved", { session_id: id });
    const domId = uiState.mcpToDomId.get(id) ?? id;
    await withSessionListOpen(panel, async () => {
      const row =
        document.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(domId)}"]`) ?? panel;
      const delBtn = Array.from(row.querySelectorAll<HTMLElement>('button, [role="button"]')).find(
        (b) =>
          isVisibleEnabled(b) &&
          /\b(?:delete|remove)\b/i.test(
            `${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""} ${elText(b)}`,
          ),
      );
      delBtn?.click();
      await delay(150);
      const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
      if (dialog) clickButtonByRegex(/^(?:delete|remove|confirm|yes)$/i, dialog);
      await delay(150);
    });
    uiState.sessions.delete(id);
    uiState.mcpToDomId.delete(id);
    uiState.domToMcpId.delete(domId);
    if (uiState.activeMcpId === id) uiState.activeMcpId = null;
    return { ok: true, ...session, deleted: true };
  }

  await selectUiSession(panel, uiState, id);
  if (request.action === "respond") {
    return await respondViaUi(panel, session, request);
  }

  if (request.action === "stop") {
    const turns = parseRenderedTurns(panel);
    const latest = turns.at(-1);
    if (!latest || latest.status !== "in_progress" || latest.turn !== request.turn) {
      return uiFailure("agent_turn_not_active");
    }
    const stopBtn = Array.from(panel.querySelectorAll<HTMLElement>('button, [role="button"]')).find(
      (b) =>
        isVisibleEnabled(b) &&
        /\b(?:stop|cancel generation)\b/i.test(`${b.getAttribute("aria-label") || ""} ${elText(b)}`),
    );
    if (!stopBtn) return uiFailure("agent_stop_button_not_found");
    stopBtn.click();
    await delay(200);
    return { ok: true, ...session, turn: parseRenderedTurns(panel).at(-1) };
  }

  if (request.action === "resume") {
    const turns = parseRenderedTurns(panel);
    const latest = turns.at(-1);
    const resumeBtn = Array.from(
      panel.querySelectorAll<HTMLElement>('button, [role="button"]'),
    ).find(
      (b) =>
        isVisibleEnabled(b) &&
        /\b(?:resume|continue|retry)\b/i.test(`${b.getAttribute("aria-label") || ""} ${elText(b)}`),
    );
    if (!latest || latest.turn !== request.turn || !resumeBtn) {
      return uiFailure("agent_turn_cannot_resume");
    }
    resumeBtn.click();
    await delay(200);
    return { ok: true, ...session, turn: parseRenderedTurns(panel).at(-1) };
  }

  const turns = parseRenderedTurns(panel);
  if (request.action === "get_turn") {
    const found = turns.find((t) => t.turn === request.turn);
    return found ? { ok: true, ...session, turn: found } : uiFailure("agent_turn_not_found");
  }

  const end = request.before_turn ? Math.min(request.before_turn - 1, turns.length) : turns.length;
  const start = Math.max(0, end - (request.limit ?? 20));
  return {
    ok: true,
    ...session,
    turns: turns.slice(start, end),
    next_before_turn: start > 0 ? start + 1 : null,
  };
}
