// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Format Agent turns, pending actions, expired elicitations, and question answers.

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
): string | undefined {
  if (active) return undefined;
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

/** Reads actual media IDs from the original Agent tool results. */
function legacyTurnMedia(flow: FlowAgentExports, turn: LiveTurn): string[] {
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
  context: TurnContext,
  id: string,
  turn: LiveTurn,
  position: TurnPosition,
) {
  const { number, status, active, latest } = position;
  const [user, reply] = context.flow.reply({ turn, XJ: number - 1, yc: active });
  const blocks = reply.Oh ?? turn.Tf?.Oh ?? [];
  const rawError = reply.errorMessage ?? turn.errorMessage;
  const timeoutError = status !== "stopped" && status !== "in_progress"
    ? expiredElicitationError(blocks, active)
    : undefined;
  const pending = pendingActions(
    blocks,
    active,
    latest && status === "completed" && !timeoutError,
  );
  const legacyRequest = reply.jna ?? context.transport.ka.Ma().get(id);
  if (!active && latest && status === "completed" && !timeoutError && legacyRequest) {
    pending.push({
      type: "permission",
      action_id: LEGACY_PERMISSION_ID,
      image_count: legacyRequest.joa,
      video_count: legacyRequest.loa,
      credits: legacyRequest.qsa,
    });
  }
  const media = [...(turn.Tf?.Bx ?? [])].map(([mediaId, item]) => ({
    media_id: mediaId,
    status: item.status,
    error: item.errorCode,
  }));
  if (!turn.Tf) {
    for (const mediaId of legacyTurnMedia(context.flow, turn)) {
      media.push({ media_id: mediaId, status: "success", error: undefined });
    }
  }
  const effectiveStatus = pending.length > 0
    ? "action_required"
    : timeoutError
      ? "failed"
      : status;
  return {
    turn: number,
    status: effectiveStatus,
    response_id: reply.ci,
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
      text: reply.text,
      media,
      rich_content: blocks.flatMap((b) => (b.type === "a2ui" ? [b.round] : [])),
    },
    pending_actions: pending,
    error: timeoutError ?? rawError,
  };
}

/** Formats the current and persisted turns without treating a local partial reply as final. */
export function conversation(context: TurnContext, id: string, stored: StoredTurn[]) {
  const local = context.transport.ka.ha().get(id);
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
      return formatTurn(context, id, inProgress, {
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
      return formatTurn(context, id, context.flow.decode(saved), {
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
  if (turns.length > (local?.Vh.length ?? 0)) {
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
