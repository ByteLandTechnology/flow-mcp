// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Flow Agent session queries, live turns, and user responses.

import { buildAttachmentMessage } from "./agent_attachments";
import { MEDIA_UPLOAD_TIMEOUT_MS, takeMediaFiles, waitForMedia } from "./project_upload";
import type {
  AgentDecision,
  AgentRequest,
  FlowAgentExports,
  QuestionResponder,
  Session,
  StoredTurn,
  Transport,
} from "./agent_protocol";
import {
  agentSettingsOp,
  resolveQueryClient,
  settingsWritePending,
  waitForQuerySettlement,
} from "./agent_settings";
import type { AgentInjector } from "./agent_settings";
import {
  LEGACY_PERMISSION_ID,
  STORED_TURN_IN_PROGRESS,
  conversation,
  loadStoredTurns,
  questionAnswers,
} from "./agent_turns";
import { adaptAgentWire } from "./agent_wire";
import { agentChatCompatibility } from "./frontend_compatibility";
import { readBuildLabel } from "./frontend_builds";
import type { AgentChatFormat } from "./frontend_builds";

/** Session and services bound to one project document. */
interface Binding {
  /** Expected project ID. */
  projectId: string;
  /** Live project page component. */
  page: Record<string, unknown>;
  /** Field layout of the supported project page. */
  format: AgentChatFormat;
  /** Angular injector of the project page. */
  injector: AgentInjector;
  /** Library exports used by this binding. */
  flow: FlowAgentExports;
  /** Agent transport service for this document. */
  transport: Transport;
  /** Signal that checks if Flow allows Agent messages in this project. */
  canSend: () => boolean;
  /** Permission response service on the project page. */
  permissions: object;
  /** Question response service on the project page. */
  questions: QuestionResponder;
  /** IDs that Flow has yet to add to the session list. */
  drafts: Set<string>;
}

/** Flow surface used by the Agent service on the project page. */
const AGENT_SURFACE = "SIDE_PANEL";

/** Permission decisions and the labels that Flow uses in the legacy transport. */
const PERMISSION_DECISIONS: Partial<
  Record<AgentDecision, { code: number; label: string }>
> = {
  approve: { code: 1, label: "Approve" },
  approve_and_remember: { code: 2, label: "Always approve" },
  deny: { code: 3, label: "Reject" },
};

/** Plan decisions that Flow accepts. */
const PLAN_DECISIONS: Partial<
  Record<AgentDecision, { aja: number; label: string }>
> = {
  run_full_plan: { aja: 1, label: "Run full plan" },
  previz: { aja: 2, label: "Previz" },
};

/** Current browser binding. */
let binding: Binding | undefined;

/** Reports a failure to the MCP caller. */
function failure(error: string, context: Record<string, unknown> = {}) {
  return { ok: false as const, error, ...context };
}

/** Gets the exported Flow namespace from the active document. */
function namespace(): Record<string, unknown> {
  return Reflect.get(window, "default_AiSandboxAngularFrontend") ?? {};
}

/** Checks that the page route still belongs to the requested project. */
function onProject(projectId: string): boolean {
  return (
    location.pathname.match(/(?:^|\/)project\/([^/]+)\/?$/)?.[1] === projectId
  );
}

/** Returns the binding if the project page is still active. */
function liveBinding(projectId: string): Binding | undefined {
  if (!binding || binding.projectId !== projectId || !onProject(projectId))
    return;
  const { page, format } = binding;
  const life = Reflect.get(page, format.lifecycle) as
    | Record<string, unknown>
    | undefined;
  if (life?.[format.destroyed] !== false) return;
  const project = Reflect.get(page, format.project);
  if (typeof project === "function" && project.call(page) === projectId)
    return binding;
}

/** Returns true if the active document has a binding for this project. */
export function agentBound(projectId: string): boolean {
  return liveBinding(projectId) !== undefined;
}

/** Returns true while a turn uses the live transport. */
export function agentBusy(projectId: string): boolean {
  const bound = liveBinding(projectId);
  return Boolean(bound && (bound.transport.ha.size > 0 || settingsWritePending));
}

/** Checks the frontend build and verifies the native Agent exports. */
export function agentStatus(projectId: string) {
  if (!onProject(projectId) || readBuildLabel() === null)
    return failure("agent_page_not_ready");
  const compatibility = agentChatCompatibility();
  if (!compatibility.ok) return compatibility;
  const ns = namespace();
  const { format } = compatibility;
  if (typeof ns[format.page] !== "function")
    return failure("agent_page_not_ready");
  const checks = Object.entries(format.exports).map(([key, name]) => ({
    name: key,
    ok:
      key === "errors"
        ? typeof ns[name] === "object" && ns[name] !== null
        : key === "toolEventGroup"
          ? Array.isArray(ns[name])
          : typeof ns[name] === "function",
    detail: "Agent frontend export",
  }));
  const result = agentChatCompatibility(checks);
  return result.ok ? { ok: true as const } : result;
}

/** Gets the prototype that CDP uses to find instances in the current document. */
export function agentPrototype(): object | null {
  const compatibility = agentChatCompatibility();
  if (!compatibility.ok) return null;
  const type = namespace()[compatibility.format.page];
  return typeof type === "function" ? type.prototype : null;
}

/** Finds a live project page and takes its project-scoped service handles. */
export function bindAgent(
  instances: Record<string, unknown>[],
  projectId: string,
): boolean {
  const compatibility = agentChatCompatibility();
  if (!compatibility.ok || !onProject(projectId)) return false;
  const format = compatibility.format;
  for (const page of instances) {
    const life = page[format.lifecycle] as Record<string, unknown> | undefined;
    const project = page[format.project];
    if (life?.[format.destroyed] !== false || typeof project !== "function")
      continue;
    try {
      if (project.call(page) !== projectId) continue;
      const nativeTransport = page[format.transport] as Transport | undefined;
      const ns = namespace();
      const injector = page[format.injector] as AgentInjector | undefined;
      const composer = injector?.get?.(ns[format.composer]) as
        | { wb?: () => boolean }
        | undefined;
      const permissions = injector?.get?.(ns[format.permissions]) as
        | object
        | undefined;
      const nativeQuestions = injector?.get?.(ns[format.questions]) as
        | Binding["questions"]
        | undefined;
      if (!nativeTransport || !nativeQuestions) continue;
      const exports = Object.fromEntries(
        Object.entries(format.exports).map(([key, name]) => [key, ns[name]]),
      ) as unknown as FlowAgentExports;
      const services = adaptAgentWire({
        flow: exports, transport: nativeTransport, questions: nativeQuestions,
      }, format.wire);
      if (!services) continue;
      const { transport, questions, flow } = services;
      if (
        !injector ||
        !(transport.ha instanceof Map) ||
        typeof transport.ka?.ha !== "function" ||
        typeof transport.ka.Ma !== "function" ||
        typeof transport.ka.yL !== "function" ||
        typeof transport.sendMessage !== "function" ||
        typeof transport.la !== "function" ||
        typeof transport.yL !== "function" ||
        typeof transport.W1 !== "function" ||
        typeof transport.ev !== "function" ||
        typeof questions?.OA !== "function" ||
        !permissions ||
        typeof composer?.wb !== "function"
      )
        continue;
      binding = {
        projectId,
        format,
        page,
        injector,
        transport,
        questions,
        permissions,
        flow,
        canSend: () => composer.wb?.() === true,
        drafts: binding?.page === page ? binding.drafts : new Set(),
      };
      return true;
    } catch {
      // The router can supply an instance before it initializes the required input.
    }
  }
  return false;
}

/** Allocates an ID without submitting a message or changing remote state. */
export async function agentAllocate(projectId: string) {
  const bound = liveBinding(projectId);
  if (!bound) return failure("agent_project_changed");
  const { id } = await bound.flow.allocate();
  return { ok: true as const, session_id: id };
}

/** Reads a fresh session list from Flow for the pinned project. */
async function savedSessions(bound: Binding): Promise<Session[]> {
  const { flow, transport, projectId } = bound;
  const rows = flow.rows(
    await flow.sessionList(transport, projectId).queryFn(),
  );
  return rows.map((row) => {
    const metadata = flow.metadata(row);
    const sessionId = flow.string(row, 1);
    bound.drafts.delete(sessionId);
    return {
      session_id: sessionId,
      title: metadata ? flow.string(metadata, 1) : "",
      persisted: true,
    };
  });
}

/** Returns a session that Flow has not saved yet. */
function draftSession(sessionId: string): Session {
  return { session_id: sessionId, title: "", persisted: false };
}

/** Reads or checks a project-owned session before it can be modified. */
async function getSession(
  bound: Binding,
  sessionId: string,
): Promise<Session | undefined> {
  if (bound.drafts.has(sessionId) && bound.transport.ha.has(sessionId))
    return draftSession(sessionId);
  const saved = (await savedSessions(bound)).find(
    (session) => session.session_id === sessionId,
  );
  return (
    saved ?? (bound.drafts.has(sessionId) ? draftSession(sessionId) : undefined)
  );
}

/** Gets persisted turns in their original order. */
async function savedTurns(
  bound: Binding,
  session: Session,
): Promise<StoredTurn[]> {
  if (!session.persisted) return [];
  const { flow, transport } = bound;
  return flow.turns<StoredTurn>(
    await flow.readSession(transport, session.session_id),
    flow.turnType,
    2,
  );
}

/** Waits for active `PROJECT_DETAILS` queries before reading `canSend`. */
async function canSendReady(bound: Binding, signal?: AbortSignal): Promise<boolean> {
  if (bound.canSend()) return true;
  const client = resolveQueryClient(bound.injector, bound.page);
  await waitForQuerySettlement({
    client,
    queryKey: ["PROJECT_DETAILS", bound.projectId],
    ready: () => bound.canSend(),
    canContinue: () => liveBinding(bound.projectId) === bound,
    signal,
  });
  return bound.canSend();
}

/** Returns true if the project accepts a new Agent turn after `PROJECT_DETAILS` settles. */
async function readyToSend(bound: Binding, signal?: AbortSignal): Promise<boolean> {
  const allowed = await canSendReady(bound, signal);
  return (
    liveBinding(bound.projectId) === bound &&
    allowed &&
    bound.transport.ha.size === 0 &&
    !bound.transport.la()
  );
}

/** Attachment data for a user message. */
interface MessageAttachments {
  /** Image, video, and character IDs from the project. */
  assetIds: string[];
  /** Files to upload before the message is sent. */
  files: File[];
  /** Deadline shared by the session read and attachment preparation. */
  signal: AbortSignal;
}

/** Content of one new Agent turn. */
interface MessageInput {
  /** Text of the user message. */
  text: string;
  /** Project references and files to attach to the message. */
  attachments?: MessageAttachments;
  /** Response code for the legacy permission transport. */
  permission?: number;
}

/** Sends one message using Flow's own envelope and authentication flow. */
async function send(
  bound: Binding,
  session: Session,
  saved: StoredTurn[],
  input: MessageInput,
) {
  const { flow, transport, projectId } = bound;
  const id = session.session_id;
  const { text, attachments, permission } = input;
  const canSend = await readyToSend(bound, attachments?.signal);
  if (liveBinding(projectId) !== bound) return failure("agent_project_changed");
  const local = transport.ka.ha().get(id);
  if (
    !canSend ||
    local?.xe ||
    saved.at(-1)?.getState() === STORED_TURN_IN_PROGRESS
  )
    return failure("agent_turn_active_or_unavailable");
  if (!session.persisted && local?.Vh.length)
    return failure("agent_session_not_saved", { session_id: id });
  const prepared = attachments
    ? await buildAttachmentMessage({
        page: bound.page,
        projectId,
        isCurrent: () => liveBinding(projectId) === bound,
        message: text,
        ...attachments,
      })
    : undefined;
  if (prepared && !prepared.ok) return prepared;
  const uploadResult = prepared?.uploaded_asset_ids.length
    ? { uploaded_asset_ids: prepared.uploaded_asset_ids }
    : {};
  if (!session.persisted) {
    bound.drafts.add(id);
    flow.init(transport, id, projectId);
  } else {
    loadStoredTurns(bound, id, saved);
  }
  const number = Math.max(saved.length, local?.Vh.length ?? 0) + 1;
  let envelope = prepared?.message;
  if (!envelope) {
    const part = flow.finish(flow.setText(flow.mutable(flow.newPart()), text));
    const content = flow.finish(
      flow.setParts(flow.mutable(flow.newContent()), [part]),
    );
    envelope = flow.finish(
      flow.setContent(flow.mutable(flow.newEnvelope()), content),
    );
  }
  try {
    await transport.sendMessage({
      ua: projectId,
      Fb: id,
      Oe: envelope,
      Gn: number,
      hi: AGENT_SURFACE,
      Aq: permission,
    });
  } catch {
    return failure("outcome_unknown", {
      session_id: id,
      turn: number,
      ...uploadResult,
    });
  }
  if (permission !== undefined)
    flow.clearLegacyRequest(transport.ka, { sessionId: id });
  const result = conversation(bound, id, saved).find(
    (item) => item.turn === number,
  );
  return result
    ? { ok: true as const, ...session, turn: result, ...uploadResult }
    : failure("agent_submission_not_observed", {
        session_id: id,
        turn: number,
        ...uploadResult,
      });
}

/** Applies a decision to one action from the requested turn. */
async function respond(
  bound: Binding,
  req: AgentRequest,
  session: Session,
  stored: StoredTurn[],
) {
  const id = session.session_id;
  const current = conversation(bound, id, stored).at(-1);
  const action =
    current?.turn === req.turn &&
    current?.pending_actions.find((item) => item.action_id === req.action_id);
  if (!action) return failure("agent_action_not_pending");
  if (action.type === "permission") {
    const decision = req.decision && PERMISSION_DECISIONS[req.decision];
    if (!decision) return failure("invalid_agent_permission_decision");
    if (action.action_id === LEGACY_PERMISSION_ID) {
      const canSend = await readyToSend(bound);
      if (liveBinding(bound.projectId) !== bound)
        return failure("agent_project_changed");
      if (!canSend)
        return failure("agent_turn_active_or_unavailable");
      bound.flow.legacyDecision(bound.permissions, decision.code);
      return send(bound, session, stored, {
        text: decision.label,
        permission: decision.code,
      });
    }
    bound.flow.permission(bound.permissions, {
      sessionId: id,
      Ig: action.action_id,
      action: decision.code,
    });
  } else if (action.type === "question") {
    const answers = req.answers && questionAnswers(action, req.answers);
    if (!answers) return failure("invalid_agent_question_answers");
    bound.questions.OA({
      sessionId: id,
      Ig: action.action_id,
      Qj: answers,
      hi: AGENT_SURFACE,
    });
  } else {
    const canSend = await readyToSend(bound);
    if (liveBinding(bound.projectId) !== bound)
      return failure("agent_project_changed");
    if (
      !canSend ||
      stored.at(-1)?.getState() === STORED_TURN_IN_PROGRESS
    )
      return failure("agent_turn_active_or_unavailable");
    const plan = req.decision && PLAN_DECISIONS[req.decision];
    if (!plan) return failure("invalid_agent_plan_decision");
    loadStoredTurns(bound, id, stored);
    bound.flow.plan(bound.transport, {
      ua: bound.projectId,
      Fb: id,
      VE: plan,
      hi: AGENT_SURFACE,
    });
    const turn = conversation(bound, id, stored).at(-1);
    if (!turn || turn.turn !== (req.turn ?? 0) + 1)
      return failure("agent_submission_not_observed", {
        session_id: id,
        turn: (req.turn ?? 0) + 1,
      });
    return { ok: true as const, ...session, turn };
  }
  return {
    ok: true as const,
    ...session,
    turn: conversation(bound, id, stored).at(-1),
  };
}

/** Loads the session and sends one message within the attachment deadline. */
async function sendUserMessage(
  bound: Binding,
  request: AgentRequest,
  id: string,
  files: File[],
) {
  const assetIds = request.asset_ids?.map((id) => id.trim()) ?? [];
  const signal =
    assetIds.length || files.length
      ? AbortSignal.timeout(MEDIA_UPLOAD_TIMEOUT_MS)
      : undefined;
  const input = {
    text: request.message ?? "",
    attachments: signal ? { assetIds, files, signal } : undefined,
  };
  if (request.action === "create_session")
    return send(bound, draftSession(id), [], input);

  try {
    const session = await waitForMedia(
      () => getSession(bound, id),
      signal,
    );
    if (!session) return failure("agent_session_not_found", { session_id: id });
    const stored = bound.transport.ha.has(id)
      ? []
      : await waitForMedia(() => savedTurns(bound, session), signal);
    if (liveBinding(bound.projectId) !== bound)
      return failure("agent_project_changed");
    return send(bound, session, stored, input);
  } catch (error) {
    if (signal?.aborted) {
      return failure("agent_attachment_timeout", { session_id: id });
    }
    throw error;
  }
}

/** Runs one session or message action for the bound project. */
export async function agentOp(request: AgentRequest) {
  const files = takeMediaFiles();
  if (files.length !== (request.file_count ?? 0))
    return failure("agent_attachment_files_unavailable");
  const bound = liveBinding(request.project_id);
  if (!bound) return failure("agent_project_changed");
  const { projectId, transport } = bound;
  if (request.action === "get_settings" || request.action === "update_settings") {
    if (request.action === "update_settings" && transport.ha.size > 0)
      return failure("agent_turn_active");
    return agentSettingsOp({
      projectId,
      injector: bound.injector,
      isCurrent: () => liveBinding(projectId) === bound,
    }, request.settings ?? undefined);
  }
  const id = request.session_id;
  if (request.action === "list_sessions") {
    const [saved, canSend] = await Promise.all([
      savedSessions(bound),
      canSendReady(bound),
    ]);
    if (liveBinding(projectId) !== bound)
      return failure("agent_project_changed");
    return {
      ok: true as const,
      project_id: projectId,
      can_send: canSend,
      sessions: [...Array.from(bound.drafts, draftSession), ...saved],
    };
  }
  if (!id) return failure("agent_session_id_required");
  if (
    request.action === "create_session" ||
    request.action === "send_message"
  ) {
    return sendUserMessage(bound, request, id, files);
  }
  const session = await getSession(bound, id);
  if (!session) return failure("agent_session_not_found", { session_id: id });
  if (!liveBinding(projectId)) return failure("agent_project_changed");
  if (
    request.action === "rename_session" ||
    request.action === "delete_session"
  ) {
    if (transport.ha.has(id)) return failure("agent_turn_active");
    if (!session.persisted)
      return failure("agent_session_not_saved", { session_id: id });
    if (request.action === "rename_session") {
      const title = request.title?.trim() ?? "";
      await transport.W1(id, title, projectId);
      return { ok: true as const, ...session, title };
    }
    await transport.yL(id);
    transport.ka.yL(id);
    return { ok: true as const, ...session, deleted: true };
  }

  const live = transport.ha.has(id);
  const stored = live ? [] : await savedTurns(bound, session);
  if (!liveBinding(projectId)) return failure("agent_project_changed");
  if (request.action === "respond")
    return respond(bound, request, session, stored);
  if (request.action === "resume") {
    const last = stored.at(-1);
    const canSend = await readyToSend(bound);
    if (liveBinding(projectId) !== bound)
      return failure("agent_project_changed");
    if (
      !last ||
      stored.length !== request.turn ||
      last.getState() !== STORED_TURN_IN_PROGRESS ||
      !canSend
    )
      return failure("agent_turn_cannot_resume");
    if (
      !bound.flow.resume(transport, {
        Fb: id,
        ua: projectId,
        BF: stored,
        TM: last,
      })
    )
      return failure("agent_turn_cannot_resume");
    return {
      ok: true as const,
      ...session,
      turn: conversation(bound, id, stored).at(-1),
    };
  }
  if (request.action === "stop") {
    const current = transport.ka.ha().get(id);
    if (
      !transport.ha.has(id) ||
      !current?.xe ||
      current.Vh.length + 1 !== request.turn
    )
      return failure("agent_turn_not_active");
    transport.ev(id);
    const turn = conversation(bound, id, stored).at(-1);
    return { ok: true as const, ...session, turn };
  }
  const turns = conversation(bound, id, stored);
  if (request.action === "get_turn") {
    const turn = turns.find((item) => item.turn === request.turn);
    return turn
      ? { ok: true as const, ...session, turn }
      : failure("agent_turn_not_found");
  }
  const end = request.before_turn
    ? Math.min(request.before_turn - 1, turns.length)
    : turns.length;
  const start = Math.max(0, end - (request.limit ?? 20));
  return {
    ok: true as const,
    ...session,
    turns: turns.slice(start, end),
    next_before_turn: start > 0 ? start + 1 : null,
  };
}
