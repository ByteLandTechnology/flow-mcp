// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Format Agent turns, pending actions, expired elicitations, and question answers.

import { readOwn } from "./angular";
import { isReadyVariant, resolveRequestedAsset } from "./agent_attachments";
import type { AttachmentTile } from "./agent_attachments";
import { legacyMedia, legacyTile } from "./dom";
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

/** Status and optional failure detail of one generated media item in a turn. */
interface TurnMediaItem {
  /** Flow media identifier. */
  media_id: string;
  /** Lifecycle status of the media item. */
  status: string;
  /** Error code or message when generation fails. */
  error: string | number | undefined;
}

/** Native Agent handles required to decode and hydrate turns. */
export interface TurnContext {
  /** Library exports used to decode and format turns. */
  flow: FlowAgentExports;
  /** Agent transport service for this document. */
  transport: Transport;
  /** Optional reader for live project tiles on this page. */
  tiles?: () => AttachmentTile[];
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

/** Returns true when a generated media item does not have a failed or canceled status. */
function isNonFailedMedia(item: TurnMediaItem): boolean {
  const status = item.status.toLowerCase();
  return status !== "failed" && status !== "canceled" && status !== "error";
}

/** Returns a timeout message when an unanswered expired elicitation has no later output. */
function expiredElicitationError(
  blocks: ReplyBlock[],
  media: TurnMediaItem[],
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
  if (
    blocks.slice(lastIndex + 1).some(isLaterOutputBlock) ||
    media.some(isNonFailedMedia)
  ) {
    return undefined;
  }
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

/** Converts a raw tool or stream media status to a standard Flow status. */
function normalizeMediaStatus(raw: string | undefined, hasError: boolean): string {
  const status =
    raw?.trim().toLowerCase().replace(/^media_generation_status_/, "") ?? "";
  if (status === "error" || status === "failed") return "failed";
  if (status === "canceled" || status === "cancelled") return "canceled";
  if (
    status === "queued" ||
    status === "in_progress" ||
    status === "active" ||
    status === "generating"
  ) {
    return "pending";
  }
  if (status === "succeeded" || status === "successful" || status === "completed") {
    return hasError ? "failed" : "success";
  }
  if (status) return status;
  return hasError ? "failed" : "success";
}

/** Reads an error code or message from a media error value. */
function readMediaError(value: unknown): string | number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["errorCode", "error_code", "code", "error", "message"]) {
    const field = readOwn(value, key);
    if (typeof field === "number") return field;
    if (typeof field === "string" && field.trim()) return field.trim();
  }
  return undefined;
}

/** Updates one turn media item with the live project tile variant status. */
function reconcileTurnMedia(item: TurnMediaItem, tiles: AttachmentTile[]): TurnMediaItem {
  const normalizedStatus = normalizeMediaStatus(item.status, item.error !== undefined);
  const matched = tiles.length > 0 ? resolveRequestedAsset(tiles, item.media_id) : undefined;
  if (!matched) {
    return { ...item, status: normalizedStatus };
  }
  const payload = matched.variant
    ? legacyMedia(matched.variant)
    : legacyTile(matched.tile).Fb;
  const tileStatus = payload?.Zc?.trim().toLowerCase();
  const tileError = readMediaError(payload?.nf);
  if (tileStatus === "canceled") {
    return { media_id: item.media_id, status: "canceled", error: item.error ?? tileError };
  }
  if (tileStatus === "failed" || tileStatus === "error" || (!tileStatus && tileError !== undefined)) {
    return { media_id: item.media_id, status: "failed", error: item.error ?? tileError };
  }
  const ready = matched.variant
    ? isReadyVariant(matched.variant)
    : matched.tile.isPending !== true && (tileStatus === undefined || tileStatus === "success");
  if (!ready || tileStatus === "pending" || tileStatus === "scheduled") {
    const pendingStatus = tileStatus === "scheduled" ? "scheduled" : "pending";
    return {
      media_id: item.media_id,
      status:
        normalizedStatus === "failed" || normalizedStatus === "canceled"
          ? normalizedStatus
          : pendingStatus,
      error: item.error,
    };
  }
  if (
    ready &&
    (tileStatus === undefined || tileStatus === "success") &&
    (normalizedStatus === "pending" || normalizedStatus === "scheduled")
  ) {
    return { media_id: item.media_id, status: "success", error: undefined };
  }
  return { ...item, status: normalizedStatus };
}

/** Reads media IDs, statuses, and errors from legacy Agent tool results. */
function legacyTurnMedia(flow: FlowAgentExports, turn: LiveTurn): TurnMediaItem[] {
  const items = new Map<string, TurnMediaItem>();
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
        const media = fields.get("media_id");
        const mediaId = media ? (flow.valueString(media) ?? "").trim() : "";
        if (!mediaId) continue;
        const rawStatus = fields.get("status");
        const errorCode = fields.get("error_code");
        const errorDetail = fields.get("error");
        const errorText =
          (errorCode ? (flow.valueString(errorCode) ?? "").trim() : "") ||
          (errorDetail ? (flow.valueString(errorDetail) ?? "").trim() : "") ||
          undefined;
        const status = normalizeMediaStatus(
          rawStatus ? flow.valueString(rawStatus) : undefined,
          errorText !== undefined,
        );
        items.set(mediaId, { media_id: mediaId, status, error: errorText });
      }
    }
  }
  return [...items.values()];
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
  const rawMedia: TurnMediaItem[] =
    turn.Tf && turn.Tf.Bx.size > 0
      ? [...turn.Tf.Bx].map(([mediaId, item]) => ({
          media_id: mediaId,
          status: item.status,
          error: item.errorCode ?? readMediaError(item),
        }))
      : legacyTurnMedia(context.flow, turn);
  const projectTiles = rawMedia.length > 0 ? (context.tiles?.() ?? []) : [];
  const media = rawMedia.map((item) => reconcileTurnMedia(item, projectTiles));
  const timeoutError = status !== "stopped" && status !== "in_progress"
    ? expiredElicitationError(blocks, media, active)
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
    error: effectiveStatus === "in_progress" ? undefined : (timeoutError ?? rawError),
  };
}

/** Selects the turn with more content when a server turn stays in progress after a disconnect. */
function disconnectedInProgressTurn(
  context: TurnContext,
  saved: StoredTurn,
  prior: LiveTurn | undefined,
  index: number,
): LiveTurn {
  const decoded = context.flow.decode(saved);
  if (!prior) return decoded;
  const [savedUser, savedReply] = context.flow.reply({
    turn: decoded,
    XJ: index,
    yc: false,
  });
  const [priorUser, priorReply] = context.flow.reply({
    turn: prior,
    XJ: index,
    yc: false,
  });
  if (priorUser.text !== savedUser.text) return decoded;
  if (savedReply.ci && priorReply.ci && savedReply.ci !== priorReply.ci) {
    return decoded;
  }
  const savedBlocks = savedReply.Oh?.length ?? decoded.Tf?.Oh.length ?? 0;
  const priorBlocks = priorReply.Oh?.length ?? prior.Tf?.Oh.length ?? 0;
  const savedMedia = decoded.Tf?.Bx.size ?? 0;
  const priorMedia = prior.Tf?.Bx.size ?? 0;
  if (
    Boolean(priorReply.ci && !savedReply.ci) ||
    priorBlocks > savedBlocks ||
    priorMedia > savedMedia ||
    priorReply.text.length > savedReply.text.length ||
    prior.Yu.length > decoded.Yu.length
  ) {
    return prior;
  }
  return decoded;
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
    if (saved && state === STORED_TURN_IN_PROGRESS) {
      return formatTurn(
        context,
        id,
        disconnectedInProgressTurn(context, saved, prior, i),
        {
          number,
          status: "in_progress",
          active: false,
          latest,
        },
      );
    }
    if (saved && (!prior || state !== undefined)) {
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

/** Loads saved turns into the browser and replaces unpersisted local failures before a follow-up message. */
export function loadStoredTurns(
  context: TurnContext,
  sessionId: string,
  turns: StoredTurn[],
): void {
  const { flow, transport } = context;
  const localTurns = transport.ka.ha().get(sessionId)?.Vh ?? [];
  const hasStaleLocalFailure = localTurns.some((turn, index) => {
    if (turn.errorMessage === undefined || turn.errorMessage === flow.errors.IC) {
      return false;
    }
    return index >= turns.length || turns[index]?.getState() !== 3;
  });
  if (turns.length > localTurns.length || hasStaleLocalFailure) {
    const trailing = localTurns
      .slice(turns.length)
      .filter(
        (turn) =>
          turn.errorMessage === undefined || turn.errorMessage === flow.errors.IC,
      );
    flow.hydrate(transport.ka, {
      sessionId,
      BF: [...turns.map(flow.decode), ...trailing],
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
