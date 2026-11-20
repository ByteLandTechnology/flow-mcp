// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Flow Agent session queries, live turns, and user responses.

import {
  ATTACHMENT_TIMEOUT_MS,
  buildAttachmentMessage,
  takeAgentFiles,
  waitForAttachment,
} from "./agent_attachments";
import type {
  AgentDecision,
  AgentRequest,
  FlowAgentExports,
  FlowAnswer,
  LiveTurn,
  PendingAction,
  QuestionResponder,
  ReplyBlock,
  Session,
  StoredTurn,
  Transport,
} from "./agent_protocol";
import { agentSettingsOp, settingsWritePending } from "./agent_settings";
import type { AgentInjector } from "./agent_settings";
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

/** Phase of a stored turn that has yet to finish. */
const STORED_TURN_IN_PROGRESS = 1;

/** Action ID for a permission request that starts a new turn. */
const LEGACY_PERMISSION_ID = "legacy-permission";

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

/** Phase of a turn before the tool checks for pending actions. */
type TurnStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown";

/** Position and phase of a turn in the conversation. */
interface TurnPosition {
  /** Turn number, which starts at one. */
  number: number;
  /** Current phase of the turn. */
  status: TurnStatus;
  /** True when the page has an open response for the turn. */
  active: boolean;
  /** True when the turn is the last turn in the conversation. */
  latest: boolean;
}

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
      const transport = page[format.transport] as Transport | undefined;
      const ns = namespace();
      const injector = page[format.injector] as AgentInjector | undefined;
      const composer = injector?.get?.(ns[format.composer]) as
        | { wb?: () => boolean }
        | undefined;
      const permissions = injector?.get?.(ns[format.permissions]) as
        | object
        | undefined;
      const questions = injector?.get?.(ns[format.questions]) as
        | Binding["questions"]
        | undefined;
      if (
        !injector || !transport ||
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
      const flow = Object.fromEntries(
        Object.entries(format.exports).map(([key, name]) => [key, ns[name]]),
      ) as unknown as FlowAgentExports;
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

/** Gets the caller actions that are still open in this reply. */
function pendingActions(
  blocks: ReplyBlock[],
  active: boolean,
  latest: boolean,
): PendingAction[] {
  const actions: PendingAction[] = [];
  for (const block of blocks) {
    if (
      active &&
      block.type === "permission" &&
      block.card.source === "elicitation" &&
      block.card.Vz === undefined &&
      !block.card.Ls &&
      !block.card.isDisabled
    ) {
      const { id, summary } = block.card;
      actions.push({
        type: "permission",
        action_id: id,
        image_count: summary.joa,
        video_count: summary.loa,
        credits: summary.qsa,
      });
    }
    if (
      active &&
      block.type === "question" &&
      block.card.Qj === undefined &&
      !block.card.Ls
    ) {
      actions.push({
        type: "question",
        action_id: block.card.id,
        questions: block.card.Qm.map((q) => ({
          question_id: q.fk,
          text: q.dt,
          multiple: q.cj,
          options: q.options.map((o) => ({
            option_id: o.zq,
            label: o.label,
            allows_text: o.rma,
          })),
        })),
      });
    }
    if (!active && latest && block.type === "plan") {
      actions.push({
        type: "plan",
        action_id: block.Gz.XDa || "plan",
        title: block.Gz.title,
        description: block.Gz.FOa,
        decisions: ["run_full_plan", "previz"],
      });
    }
  }
  return actions;
}

/** Returns the stable tool status associated with a stored turn. */
function storedStatus(state: number): TurnStatus {
  switch (state) {
    case STORED_TURN_IN_PROGRESS:
      return "in_progress";
    case 2:
    case 4:
      return "completed";
    case 3:
      return "failed";
    case 5:
      return "stopped";
    default:
      return "unknown";
  }
}

/** Reads actual media IDs from the original Agent tool results. */
function legacyMedia(flow: FlowAgentExports, turn: LiveTurn): string[] {
  const ids = new Set<string>();
  for (const message of turn.Yu) {
    for (const event of flow.turns(message, flow.toolEventType, 2)) {
      const result = flow.oneOf(
        event,
        flow.toolResultType,
        5,
        flow.toolEventGroup,
      );
      if (!result) continue;
      for (const row of flow.resultItems(result)) {
        const media = flow.structFields(row).get("media_id");
        if (media) ids.add(flow.valueString(media));
      }
    }
  }
  return [...ids].filter(Boolean);
}

/** Formats one Agent turn using the same message model that the chat page uses. */
function formatTurn(
  bound: Binding,
  id: string,
  turn: LiveTurn,
  position: TurnPosition,
) {
  const { number, status, active, latest } = position;
  const [user, reply] = bound.flow.reply({ turn, XJ: number - 1, yc: active });
  const blocks = reply.Oh ?? turn.Tf?.Oh ?? [];
  const pending = pendingActions(
    blocks,
    active,
    latest && status === "completed",
  );
  const legacyRequest = reply.jna ?? bound.transport.ka.Ma().get(id);
  if (!active && latest && status === "completed" && legacyRequest) {
    pending.push({
      type: "permission",
      action_id: LEGACY_PERMISSION_ID,
      image_count: legacyRequest.joa,
      video_count: legacyRequest.loa,
      credits: legacyRequest.qsa,
    });
  }
  const media = [...(turn.Tf?.Bx ?? [])].map(([mediaId, media]) => ({
    media_id: mediaId,
    status: media.status,
    error: media.errorCode,
  }));
  if (!turn.Tf) {
    for (const mediaId of legacyMedia(bound.flow, turn))
      media.push({ media_id: mediaId, status: "success", error: undefined });
  }
  return {
    turn: number,
    status: pending.length > 0 ? "action_required" : status,
    response_id: reply.ci,
    connected: status === "in_progress" ? active : undefined,
    user: {
      text: user.text,
      attachment_media_ids: user.Gh?.length
        ? user.Gh.map(({ mediaId }) => mediaId)
        : undefined,
    },
    assistant: {
      text: reply.text,
      media,
      rich_content: blocks.flatMap((b) => (b.type === "a2ui" ? [b.round] : [])),
    },
    pending_actions: pending,
    error: reply.errorMessage ?? turn.errorMessage,
  };
}

/** Formats the current and persisted turns without treating a local partial reply as final. */
function conversation(bound: Binding, id: string, stored: StoredTurn[]) {
  const local = bound.transport.ka.ha().get(id);
  const inProgress = local?.xe;
  const count = Math.max(
    stored.length,
    (local?.Vh.length ?? 0) + (inProgress ? 1 : 0),
  );
  const liveNumber = inProgress && local ? local.Vh.length + 1 : undefined;
  return Array.from({ length: count }, (_, i) => {
    const saved = stored[i];
    const prior = local?.Vh[i];
    const number = i + 1;
    const latest = number === count;
    if (inProgress && number === liveNumber) {
      return formatTurn(bound, id, inProgress, {
        number,
        status: "in_progress",
        active: true,
        latest,
      });
    }
    const state = saved?.getState();
    if (
      saved &&
      (!prior || (state !== undefined && state !== STORED_TURN_IN_PROGRESS))
    ) {
      return formatTurn(bound, id, bound.flow.decode(saved), {
        number,
        status: storedStatus(state ?? 0),
        active: false,
        latest,
      });
    }
    if (!prior) throw new Error("Flow did not return a complete turn list");
    const status =
      prior.errorMessage === undefined
        ? "completed"
        : prior.errorMessage === bound.flow.errors.IC
          ? "stopped"
          : "failed";
    return formatTurn(bound, id, prior, {
      number,
      status,
      active: false,
      latest,
    });
  });
}

/** Returns true if the project accepts a new Agent turn. */
function readyToSend(bound: Binding): boolean {
  return (
    bound.canSend() && bound.transport.ha.size === 0 && !bound.transport.la()
  );
}

/** Loads saved turns into the browser before a follow-up message. */
function loadStoredTurns(
  bound: Binding,
  sessionId: string,
  turns: StoredTurn[],
): void {
  const { flow, transport } = bound;
  const local = transport.ka.ha().get(sessionId);
  if (turns.length > (local?.Vh.length ?? 0)) {
    flow.hydrate(transport.ka, {
      sessionId,
      BF: turns.map(flow.decode),
      hka: false,
      xe: null,
    });
  }
}

/** Attachment data for a user message. */
interface MessageAttachments {
  /** Image and video IDs from the project. */
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
  /** Media to attach to the message. */
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
  const local = transport.ka.ha().get(id);
  if (
    !readyToSend(bound) ||
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

/** Accepts only valid answers to the exact questions in the active request. */
function questionAnswers(
  action: Extract<PendingAction, { type: "question" }>,
  answers: NonNullable<AgentRequest["answers"]>,
): FlowAnswer[] | null {
  const seen = new Set<string>();
  const results: FlowAnswer[] = [];
  for (const answer of answers) {
    const question = action.questions.find(
      (q) => q.question_id === answer.question_id,
    );
    const text = answer.text?.trim();
    const options = new Set(answer.option_ids);
    if (
      !question ||
      seen.has(answer.question_id) ||
      options.size !== answer.option_ids.length ||
      (!question.multiple && options.size > 1) ||
      (!text && options.size === 0) ||
      [...options].some(
        (id) => !question.options.some((o) => o.option_id === id),
      ) ||
      (text &&
        (!question.options.some((o) => o.allows_text) ||
          (!question.multiple && options.size > 0)))
    )
      return null;
    seen.add(answer.question_id);
    results.push({ fk: answer.question_id, VN: [...options], HY: text });
  }
  return results.length > 0 ? results : null;
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
      if (!readyToSend(bound))
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
    if (
      !readyToSend(bound) ||
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
      ? AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS)
      : undefined;
  const input = {
    text: request.message ?? "",
    attachments: signal ? { assetIds, files, signal } : undefined,
  };
  if (request.action === "create_session")
    return send(bound, draftSession(id), [], input);

  try {
    const session = await waitForAttachment(
      () => getSession(bound, id),
      signal,
    );
    if (!session) return failure("agent_session_not_found", { session_id: id });
    const stored = bound.transport.ha.has(id)
      ? []
      : await waitForAttachment(() => savedTurns(bound, session), signal);
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
  const files = takeAgentFiles();
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
    const saved = await savedSessions(bound);
    return {
      ok: true as const,
      project_id: projectId,
      can_send: bound.canSend(),
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
    if (
      !last ||
      stored.length !== request.turn ||
      last.getState() !== STORED_TURN_IN_PROGRESS ||
      !readyToSend(bound)
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
