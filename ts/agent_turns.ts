// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Format Agent turns, pending actions, expired elicitations, and question answers.

import {
  hasNonFailedMedia,
  mergeDisconnectedTurn,
  needsTurnHydration,
  normalizeToolMediaStatus,
  reconcileTurnMedia,
} from "./agent_reconcile";
import type { ToolMediaItem } from "./agent_reconcile";
import type {
  AgentRequest,
  FlowAgentExports,
  FlowAnswer,
  LiveTurn,
  PendingAction,
  ReplyBlock,
  StoredTurn,
  Transport,
} from "./agent_protocol";

/** Phase of a stored turn that has yet to finish. */
export const STORED_TURN_IN_PROGRESS = 1;

/** Action ID for a permission request that starts a new turn. */
export const LEGACY_PERMISSION_ID = "legacy-permission";

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

/** Native Agent handles required to decode and hydrate turns. */
export interface TurnContext {
  /** Library exports used to decode and format turns. */
  flow: FlowAgentExports;
  /** Agent transport service for this document. */
  transport: Transport;
  /** Live project page component when bound. */
  page?: Record<string, unknown>;
}

/** Returns true when a later reply block in the same turn supersedes a proposed plan. */
function isSupersededPlan(blocks: ReplyBlock[], index: number): boolean {
  return blocks.slice(index + 1).some(
    (block) =>
      block.type === "plan" ||
      block.type === "a2ui" ||
      block.type === "permission" ||
      block.type === "question" ||
      (block.type === "text" && block.content.trim().length > 0),
  );
}

/** Returns true when a block after an expired elicitation produces new reply output. */
function isLaterOutputBlock(block: ReplyBlock): boolean {
  switch (block.type) {
    case "text":
      return block.content.trim().length > 0;
    case "a2ui":
    case "plan":
    case "view_agent_memory":
      return true;
    case "permission":
      return block.card.Vz !== undefined;
    case "question":
      return block.card.Qj !== undefined;
    default:
      return false;
  }
}

/** Returns a timeout message when an unanswered expired elicitation has no later output. */
function expiredElicitationError(
  blocks: ReplyBlock[],
  active: boolean,
  media: readonly ToolMediaItem[],
): string | undefined {
  if (active || hasNonFailedMedia(media)) return undefined;
  let lastIndex = -1;
  let lastKind: "permission" | "question" | undefined;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (
      block.type === "permission" &&
      block.card.source === "elicitation" &&
      block.card.Vz === undefined &&
      block.card.Ls === true
    ) {
      lastIndex = i;
      lastKind = "permission";
    } else if (
      block.type === "question" &&
      block.card.Qj === undefined &&
      block.card.Ls === true
    ) {
      lastIndex = i;
      lastKind = "question";
    }
  }
  if (lastIndex < 0 || !lastKind) return undefined;
  if (blocks.slice(lastIndex + 1).some(isLaterOutputBlock)) return undefined;
  return lastKind === "permission"
    ? "Generation approval timed out."
    : "Question request timed out.";
}

/** Gets the caller actions that are still open in this reply. */
function pendingActions(
  blocks: ReplyBlock[],
  active: boolean,
  latest: boolean,
): PendingAction[] {
  const actions: PendingAction[] = [];
  let hasOpenQuestion = false;
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
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
      !hasOpenQuestion &&
      block.type === "question" &&
      block.card.Qj === undefined &&
      !block.card.Ls
    ) {
      hasOpenQuestion = true;
      actions.push({
        type: "question",
        action_id: block.card.id,
        questions: block.card.Qm.map((q) => ({
          question_id: q.fk,
          text: q.dt,
          multiple: q.cj,
          allows_text:
            q.options.every((o) => typeof o.rma !== "boolean") ||
            q.options.some((o) => o.rma === true),
          options: q.options.map((o) => ({
            option_id: o.zq,
            label: o.label,
            allows_text: o.rma === true,
            ...(typeof o.recommended === "boolean"
              ? { recommended: o.recommended }
              : {}),
          })),
        })),
      });
    }
    if (!active && latest && block.type === "plan" && !isSupersededPlan(blocks, index)) {
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

/** Reads a trimmed string field from a legacy tool struct row when present. */
function readToolField(
  flow: FlowAgentExports,
  fields: Map<string, object>,
  key: string,
): string | undefined {
  const value = fields.get(key);
  if (!value) return undefined;
  const text = flow.valueString(value).trim();
  return text || undefined;
}

/** Reads media items, statuses, and errors from the original Agent tool results. */
function legacyTurnMedia(flow: FlowAgentExports, turn: LiveTurn): ToolMediaItem[] {
  const items = new Map<string, ToolMediaItem>();
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
        const fields = flow.structFields(row);
        const mediaId = readToolField(flow, fields, "media_id");
        if (!mediaId) continue;
        const rawStatus = readToolField(flow, fields, "status") ?? "";
        const error =
          readToolField(flow, fields, "error_code") ??
          readToolField(flow, fields, "error");
        items.set(mediaId, {
          media_id: mediaId,
          status: normalizeToolMediaStatus(rawStatus, error !== undefined),
          error,
        });
      }
    }
  }
  return [...items.values()];
}

/** Reads field 6 (`response_id`) from a raw `StoredTurn` protobuf when present. */
function storedTurnResponseId(
  flow: FlowAgentExports,
  saved: StoredTurn | undefined,
): string | undefined {
  if (!saved) return undefined;
  try {
    return flow.string(saved, 6) || undefined;
  } catch {
    return undefined;
  }
}

/** Formats one Agent turn using the same message model that the chat page uses. */
function formatTurn(
  context: TurnContext,
  id: string,
  turn: LiveTurn,
  position: TurnPosition,
  prior?: LiveTurn,
  storedResponseId?: string,
) {
  const { number, status, active, latest } = position;
  const disconnected = status === "in_progress" && !active
    ? mergeDisconnectedTurn(context.flow, turn, prior, number - 1, storedResponseId)
    : undefined;
  const decoded = disconnected ? undefined : context.flow.reply({ turn, XJ: number - 1, yc: active });
  const user = disconnected ? disconnected.user : decoded![0];
  const replyText = disconnected ? disconnected.text : decoded![1].text;
  const responseId = disconnected
    ? disconnected.responseId
    : (decoded![1].ci || storedResponseId);
  const blocks = disconnected
    ? disconnected.blocks
    : (decoded![1].Oh ?? turn.Tf?.Oh ?? []);
  const rawError = disconnected
    ? disconnected.rawError
    : (decoded![1].errorMessage ?? turn.errorMessage);
  const streamMedia = disconnected ? disconnected.streamMedia : turn.Tf?.Bx;
  const hasStream = disconnected ? disconnected.hasStream : Boolean(turn.Tf);
  const legacySources = disconnected ? disconnected.legacySources : [turn];

  const mediaById = new Map<string, ToolMediaItem>();
  for (const [mediaId, item] of streamMedia ?? []) {
    mediaById.set(mediaId, {
      media_id: mediaId,
      status: item.status,
      error: item.errorCode,
    });
  }
  for (const source of legacySources) {
    if (hasStream && source.Yu.length === 0) continue;
    for (const item of legacyTurnMedia(context.flow, source)) {
      const current = mediaById.get(item.media_id);
      if (!current) {
        if (!hasStream || mediaById.size === 0) mediaById.set(item.media_id, item);
        continue;
      }
      mediaById.set(item.media_id, {
        media_id: item.media_id,
        status:
          item.status === "failed" || item.status === "pending"
            ? item.status
            : current.status,
        error: current.error ?? item.error,
      });
    }
  }
  const media = reconcileTurnMedia([...mediaById.values()], context.page);

  const timeoutError = status !== "stopped" && status !== "in_progress"
    ? expiredElicitationError(blocks, active, media)
    : undefined;
  const pending = pendingActions(
    blocks,
    active,
    latest && status === "completed" && !timeoutError,
  );
  const legacyRequest =
    (disconnected ? disconnected.legacyRequest : decoded![1].jna) ??
    context.transport.ka.Ma().get(id);
  if (!active && latest && status === "completed" && !timeoutError && legacyRequest) {
    pending.push({
      type: "permission",
      action_id: LEGACY_PERMISSION_ID,
      image_count: legacyRequest.joa,
      video_count: legacyRequest.loa,
      credits: legacyRequest.qsa,
    });
  }
  const effectiveStatus = pending.length > 0
    ? "action_required"
    : timeoutError
      ? "failed"
      : status;
  return {
    turn: number,
    status: effectiveStatus,
    response_id: responseId,
    connected: effectiveStatus === "in_progress" ? active : undefined,
    user: {
      text: user.text,
      attachment_media_ids: user.Gh?.length
        ? user.Gh.map(({ mediaId }) => mediaId)
        : undefined,
      attachment_character_ids: user.Uy?.length
        ? user.Uy.map(({ Nc }) => Nc)
        : undefined,
    },
    assistant: {
      text: replyText,
      media,
      rich_content: blocks.flatMap((b) => (b.type === "a2ui" ? [b.round] : [])),
    },
    pending_actions: pending,
    error: effectiveStatus === "in_progress" ? undefined : (timeoutError ?? rawError),
  };
}

/** Formats the current and persisted turns without treating a local partial reply as final. */
export function conversation(context: TurnContext, id: string, stored: StoredTurn[]) {
  const local = context.transport.ka.ha().get(id);
  const inProgress = local?.xe;
  const hasTransport = context.transport.ha.has(id);
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
      return formatTurn(context, id, inProgress, {
        number,
        status: "in_progress",
        active: hasTransport,
        latest,
      });
    }
    const state = saved?.getState();
    const savedResponseId = storedTurnResponseId(context.flow, saved);
    if (saved && state === STORED_TURN_IN_PROGRESS) {
      return formatTurn(
        context,
        id,
        context.flow.decode(saved),
        {
          number,
          status: "in_progress",
          active: false,
          latest,
        },
        prior,
        savedResponseId,
      );
    }
    if (saved && (!prior || state !== undefined)) {
      return formatTurn(
        context,
        id,
        context.flow.decode(saved),
        {
          number,
          status: storedStatus(state ?? 0),
          active: false,
          latest,
        },
        undefined,
        savedResponseId,
      );
    }
    if (!prior) throw new Error("Flow did not return a complete turn list");
    const status =
      prior.errorMessage === undefined
        ? "completed"
        : prior.errorMessage === context.flow.errors.IC
          ? "stopped"
          : "failed";
    return formatTurn(context, id, prior, {
      number,
      status,
      active: false,
      latest,
    });
  });
}

/** Loads saved turns into the browser before a follow-up message. */
export function loadStoredTurns(
  context: TurnContext,
  sessionId: string,
  turns: StoredTurn[],
): void {
  const { flow, transport } = context;
  const local = transport.ka.ha().get(sessionId);
  if (needsTurnHydration(local?.Vh, turns)) {
    flow.hydrate(transport.ka, {
      sessionId,
      BF: turns.map(flow.decode),
      hka: false,
      xe: null,
    });
  }
}

/** Validates answers to the active question card, including write-in text and empty skip lists. */
export function questionAnswers(
  action: Extract<PendingAction, { type: "question" }>,
  answers: NonNullable<AgentRequest["answers"]>,
): FlowAnswer[] | null {
  if (answers.length === 0) return [];
  const seen = new Set<string>();
  const results: FlowAnswer[] = [];
  for (const answer of answers) {
    const question = action.questions.find(
      (q) => q.question_id === answer.question_id,
    );
    const text = answer.text?.trim() || undefined;
    const options = new Set(answer.option_ids);
    if (
      !question ||
      seen.has(answer.question_id) ||
      options.size !== answer.option_ids.length ||
      (!question.multiple && options.size > 1) ||
      (!text && options.size === 0) ||
      (text && !question.allows_text) ||
      [...options].some(
        (id) => !question.options.some((o) => o.option_id === id),
      )
    ) {
      return null;
    }
    seen.add(answer.question_id);
    results.push({ fk: answer.question_id, VN: [...options], HY: text });
  }
  return results;
}
