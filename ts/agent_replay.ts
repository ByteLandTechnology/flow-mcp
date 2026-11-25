// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Track one in-flight question answer per session, turn, action, and stream for replay.

import { readOwn } from "./angular";
import type {
  AgentReplayEntry,
  FlowAgentExports,
  FlowAnswer,
  QuestionResponder,
  ReplyBlock,
  Transport,
} from "./agent_protocol";
import { conversation, questionAnswers } from "./agent_turns";
import type { TurnContext } from "./agent_turns";

/** Flow surface used by Agent question responses. */
const AGENT_SURFACE = "SIDE_PANEL";

/** Tracks in-flight answers per stream entry (`Map<"sessionId\0turn\0actionId", channelOrStream>`). */
const sentOnStream = new WeakMap<object, Map<string, object>>();

/** Tracks the single pre-attachment `Wvc.na` buffered answer key on an unclosed stream wrapper. */
const bufferedOnStream = new WeakMap<object, string>();

/** Tracks answers submitted while a stream wrapper was already detached, preventing duplicate calls. */
const detachedOnStream = new WeakMap<object, Set<string>>();

/** Services required to send or replay question answers on live Agent streams. */
export interface ReplayTurnContext extends TurnContext {
  /** Native question response service on the bound page. */
  questions: QuestionResponder;
}

/** Returns true when a handle is explicitly closed or detached. */
function isClosedHandle(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  if (readOwn(value, "closed") === true) return true;
  if (readOwn(value, "detached") === true) return true;
  if (readOwn(readOwn(value, "Wj"), "closed") === true) return true;
  return false;
}

/** Returns true when a stream or subscription handle is open. */
function isOpenHandle(value: unknown): boolean {
  if (isClosedHandle(value)) return false;
  if ("ha" in (value as object) && !readOwn(value, "ha")) return false;
  return true;
}

/** Returns true when a live transport map entry holds an attached open stream. */
export function isStreamAttached(entry: unknown): boolean {
  if (!isOpenHandle(entry)) return false;
  if ("Ui" in (entry as object)) return isOpenHandle(readOwn(entry, "Ui"));
  return true;
}

/** Returns the underlying bidirectional channel object when exposed, or `stream` itself. */
function streamChannelToken(stream: object): object {
  const channel = readOwn(stream, "Ui") ?? readOwn(stream, "ha");
  return channel && typeof channel === "object" ? channel : stream;
}

/** Builds the composite lookup key for a session, turn, and question action. */
function answerKey(sessionId: string, turn: number, actionId: string): string {
  return `${sessionId}\0${turn}\0${actionId}`;
}

/** Records that `(sessionId, turn, actionId)` was sent on `stream` and its active channel. */
function markInFlightAnswer(
  stream: object,
  sessionId: string,
  turn: number,
  actionId: string,
): void {
  let entries = sentOnStream.get(stream);
  if (!entries) {
    entries = new Map();
    sentOnStream.set(stream, entries);
  }
  entries.set(answerKey(sessionId, turn, actionId), streamChannelToken(stream));
}

/** Returns true when `(sessionId, turn, actionId)` already has an in-flight answer on `stream`. */
export function hasInFlightAnswer(
  stream: unknown,
  sessionId: string,
  turn: number,
  actionId: string,
): boolean {
  if (!stream || typeof stream !== "object" || !isStreamAttached(stream)) {
    return false;
  }
  const key = answerKey(sessionId, turn, actionId);
  if (sentOnStream.get(stream)?.get(key) === streamChannelToken(stream)) {
    return true;
  }
  if (bufferedOnStream.get(stream) === key && readOwn(stream, "na") === undefined) {
    bufferedOnStream.delete(stream);
    markInFlightAnswer(stream, sessionId, turn, actionId);
    return true;
  }
  return false;
}

/** Clears tracked in-flight answers for `sessionId` on the active transport stream. */
export function clearInFlightAnswers(transport: Transport, sessionId: string): void {
  const stream = transport.ha.get(sessionId);
  if (!stream || typeof stream !== "object") return;
  const prefix = `${sessionId}\0`;
  const entries = sentOnStream.get(stream);
  if (entries) {
    for (const key of [...entries.keys()]) {
      if (key.startsWith(prefix)) entries.delete(key);
    }
  }
  if (bufferedOnStream.get(stream)?.startsWith(prefix)) {
    bufferedOnStream.delete(stream);
  }
  const detached = detachedOnStream.get(stream);
  if (detached) {
    for (const key of [...detached]) {
      if (key.startsWith(prefix)) detached.delete(key);
    }
  }
}

/** Reads the current reply blocks of the active turn for `sessionId`. */
function readLiveTurnBlocks(
  transport: Transport,
  flow: FlowAgentExports,
  sessionId: string,
  turn: number,
): ReplyBlock[] | undefined {
  const local = transport.ka.ha().get(sessionId);
  if (!local?.xe || local.Vh.length + 1 !== turn) return undefined;
  if (local.xe.Tf?.Oh) return local.xe.Tf.Oh;
  const [, reply] = flow.reply({ turn: local.xe, XJ: turn - 1, yc: true });
  return reply.Oh ?? [];
}

/** Returns the first unanswered, non-expired question card ID in `blocks`. */
function firstOpenQuestionId(blocks: readonly ReplyBlock[]): string | undefined {
  for (const block of blocks) {
    if (block.type === "question" && block.card.Qj === undefined && !block.card.Ls) {
      return block.card.id;
    }
  }
  return undefined;
}

/** Returns true when the live turn records `Qj` on the specified question card. */
function isQuestionAcknowledged(
  transport: Transport,
  flow: FlowAgentExports,
  sessionId: string,
  turn: number,
  actionId: string,
): boolean {
  const blocks = readLiveTurnBlocks(transport, flow, sessionId, turn);
  return Boolean(
    blocks?.some(
      (block) =>
        block.type === "question" &&
        block.card.id === actionId &&
        block.card.Qj !== undefined,
    ),
  );
}

/** Sends one question answer on the current stream without duplicate sends on delayed acks. */
export function sendQuestionOnStream(
  context: ReplayTurnContext,
  sessionId: string,
  turn: number,
  actionId: string,
  answers: FlowAnswer[],
): "ok" | "turn_not_active" | "not_pending" {
  const { transport, flow, questions } = context;
  const entry = transport.ha.get(sessionId);
  if (!entry || typeof entry !== "object") return "turn_not_active";

  const blocks = readLiveTurnBlocks(transport, flow, sessionId, turn);
  if (!blocks || firstOpenQuestionId(blocks) !== actionId) {
    return "not_pending";
  }

  const key = answerKey(sessionId, turn, actionId);
  const attached = isStreamAttached(entry);
  if (attached && hasInFlightAnswer(entry, sessionId, turn, actionId)) {
    return "not_pending";
  }
  if (!attached) {
    if (bufferedOnStream.get(entry) === key || detachedOnStream.get(entry)?.has(key)) {
      return "not_pending";
    }
  }

  questions.OA({
    sessionId,
    Ig: actionId,
    Qj: answers,
    hi: AGENT_SURFACE,
  });

  const after = transport.ha.get(sessionId);
  const failedSync =
    after === undefined &&
    transport.ka.ha().get(sessionId)?.Vh.at(-1)?.errorMessage !== undefined;
  if (failedSync) return "not_pending";

  if (attached) {
    if (
      after !== undefined &&
      (typeof after !== "object" ||
        after === null ||
        !isStreamAttached(after) ||
        readOwn(after, "na") !== undefined)
    ) {
      return "not_pending";
    }
    markInFlightAnswer(entry, sessionId, turn, actionId);
    if (after && typeof after === "object" && after !== entry) {
      markInFlightAnswer(after, sessionId, turn, actionId);
    }
  } else if (after && typeof after === "object") {
    if (!isClosedHandle(after) && readOwn(after, "na") !== undefined) {
      bufferedOnStream.set(after, key);
    } else if (isStreamAttached(after)) {
      markInFlightAnswer(after, sessionId, turn, actionId);
    } else {
      let detached = detachedOnStream.get(after);
      if (!detached) {
        detached = new Set();
        detachedOnStream.set(after, detached);
      }
      detached.add(key);
    }
  }
  return "ok";
}

/** Replays recorded question answers once per `(session, turn, action, stream)` after reconnect. */
export function replayQuestionAnswers(
  context: ReplayTurnContext,
  entries: readonly AgentReplayEntry[],
) {
  const { transport, flow, questions } = context;
  let replayed = 0;
  const blockedSessions = new Set<string>();
  const touchedSessions = new Set<string>();

  for (const entry of entries) {
    const sessionId = entry.session_id;
    if (blockedSessions.has(sessionId)) continue;

    const stream = transport.ha.get(sessionId);
    if (!stream || typeof stream !== "object" || !isStreamAttached(stream)) {
      blockedSessions.add(sessionId);
      continue;
    }

    const local = transport.ka.ha().get(sessionId);
    if (!local?.xe || local.Vh.length + 1 !== entry.turn) continue;

    if (isQuestionAcknowledged(transport, flow, sessionId, entry.turn, entry.action_id)) {
      continue;
    }
    if (hasInFlightAnswer(stream, sessionId, entry.turn, entry.action_id)) {
      blockedSessions.add(sessionId);
      continue;
    }

    const blocks = readLiveTurnBlocks(transport, flow, sessionId, entry.turn);
    if (!blocks || firstOpenQuestionId(blocks) !== entry.action_id) {
      blockedSessions.add(sessionId);
      continue;
    }

    const current = conversation(context, sessionId, []).at(-1);
    const action =
      current?.turn === entry.turn
        ? current.pending_actions.find(
            (item): item is Extract<typeof item, { type: "question" }> =>
              item.type === "question" && item.action_id === entry.action_id,
          )
        : undefined;
    if (!action) {
      blockedSessions.add(sessionId);
      continue;
    }

    const formatted = questionAnswers(action, entry.answers);
    if (!formatted) {
      blockedSessions.add(sessionId);
      continue;
    }

    questions.OA({
      sessionId,
      Ig: action.action_id,
      Qj: formatted,
      hi: AGENT_SURFACE,
    });

    const after = transport.ha.get(sessionId);
    const failedSync =
      after === undefined &&
      transport.ka.ha().get(sessionId)?.Vh.at(-1)?.errorMessage !== undefined;
    if (
      !failedSync &&
      (after === undefined ||
        (typeof after === "object" &&
          after !== null &&
          isStreamAttached(after) &&
          readOwn(after, "na") === undefined))
    ) {
      markInFlightAnswer(stream, sessionId, entry.turn, action.action_id);
      if (after && typeof after === "object" && after !== stream) {
        markInFlightAnswer(after, sessionId, entry.turn, action.action_id);
      }
      replayed++;
      touchedSessions.add(sessionId);
      if (!isQuestionAcknowledged(transport, flow, sessionId, entry.turn, action.action_id)) {
        blockedSessions.add(sessionId);
      }
    } else {
      blockedSessions.add(sessionId);
    }
  }

  const turns = Object.fromEntries(
    [...touchedSessions].map((sessionId) => [
      sessionId,
      conversation(context, sessionId, []).at(-1),
    ]),
  );
  return { ok: true as const, replayed, turns };
}
