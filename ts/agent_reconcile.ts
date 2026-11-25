// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Reconcile Agent turns, draft sessions, query caches, tile media, and question streams.

import { readOwn } from "./angular";
import { isReadyVariant, readProjectTiles, resolveRequestedAsset } from "./agent_attachments";
import type { AttachmentTile } from "./agent_attachments";
import type {
  FlowAgentExports,
  FlowAnswer,
  LiveTurn,
  QuestionResponder,
  ReplyBlock,
  StoredTurn,
  Transport,
} from "./agent_protocol";
import { COLD_QUERY_TIMEOUT_MS, resolveQueryClient, waitForQuerySettlement } from "./agent_settings";
import type { AgentInjector, QueryClient } from "./agent_settings";
import { cleanMediaId, delay, findMediaContainer, isTrashedTile, legacyMedia } from "./dom";

/** Poll interval while waiting for a detached bidirectional stream to reattach. */
const STREAM_ATTACH_POLL_MS = 25;

/** Poll interval while watching active question turns for in-place stream resets. */
const REPLAY_WATCH_POLL_MS = 50;

/** Flow surface used by Agent chat operations. */
const AGENT_SURFACE = "SIDE_PANEL";

/** Decoded user message type returned by `FlowAgentExports.reply`. */
type DecodedUser = ReturnType<FlowAgentExports["reply"]>[0];

/** Decoded reply type returned by `FlowAgentExports.reply`. */
type DecodedReply = ReturnType<FlowAgentExports["reply"]>[1];

/** Media output entry reported on a formatted Agent turn. */
export interface ToolMediaItem {
  /** Identifier of the generated image or video. */
  media_id: string;
  /** Current lifecycle status of the media item. */
  status: string;
  /** Error code or message when generation fails. */
  error: string | number | undefined;
}

/** Merged fields for a turn that remains in progress on the server after a disconnect. */
export interface MergedTurnView {
  /** Reconciled user message data. */
  user: DecodedUser;
  /** Reconciled assistant reply text. */
  text: string;
  /** Agent response identifier when available. */
  responseId: string | undefined;
  /** Reconciled reply blocks. */
  blocks: ReplyBlock[];
  /** Server-side turn error, excluding local stream disconnect errors. */
  rawError: string | number | undefined;
  /** Legacy permission summary when present. */
  legacyRequest: DecodedReply["jna"];
  /** Streaming media map merged from local and server snapshots. */
  streamMedia: Map<string, { status: string; errorCode?: string | number }> | undefined;
  /** True when either turn snapshot uses the streaming event model. */
  hasStream: boolean;
  /** Ordered turns to scan for legacy tool result rows. */
  legacySources: LiveTurn[];
}

/** Handles required to clean session caches, drafts, and send readiness queries. */
export interface SessionCacheContext {
  /** Expected project identifier. */
  projectId: string;
  /** Live project page component. */
  page: Record<string, unknown>;
  /** Property name of the native transport on `page`. */
  transportField: string;
  /** Angular injector of the bound project page. */
  injector: AgentInjector;
  /** Adapted Agent transport service. */
  transport: Transport;
  /** Unsaved session IDs allocated in this page binding. */
  drafts: Set<string>;
  /** Signal predicate that reports whether the user can send Agent messages. */
  canSend: () => boolean;
  /** Returns true while the page binding still owns the active project. */
  isCurrent: () => boolean;
}

/** Handles required to submit, verify, and replay question answers on a live turn. */
export interface QuestionReplayContext {
  /** Session identifier that owns the question card. */
  sessionId: string;
  /** One-based turn number that owns the question card. */
  turn: number;
  /** Adapted Agent transport service. */
  transport: Transport;
  /** Adapted native Agent exports. */
  flow: FlowAgentExports;
  /** Native question response service. */
  questions: QuestionResponder;
  /** Returns true while the page binding still owns the active project. */
  isCurrent: () => boolean;
}

/** Accepted question answer stored for replay across stream reconnects. */
interface RecordedQuestionAnswer {
  /** Identifier of the question card. */
  actionId: string;
  /** Validated answers submitted for the card. */
  answers: FlowAnswer[];
}

/** Active replay tracking state for one session. */
interface SessionReplayState {
  /** Turn number associated with `records`. */
  turn: number;
  /** Ordered question cards accepted during `turn`. */
  records: RecordedQuestionAnswer[];
  /** Adapted Agent transport service. */
  transport: Transport;
  /** Adapted native Agent exports. */
  flow: FlowAgentExports;
  /** Native question response service. */
  questions: QuestionResponder;
  /** Returns true while the page binding still owns the active project. */
  isCurrent: () => boolean;
  /** True while an asynchronous reconnect replay loop is active. */
  watching: boolean;
}

/** Recorded question answers keyed by session ID. */
const sessionReplays = new Map<string, SessionReplayState>();

/** Transport stream maps that already carry the reconnect observer wrapper. */
const hookedStreamMaps = new WeakSet<Map<string, unknown>>();

/** Normalizes a tool or streaming media status string to Flow's lifecycle vocabulary. */
export function normalizeToolMediaStatus(rawStatus: string, hasError = false): string {
  const lower = rawStatus.trim().toLowerCase();
  if (!lower) return hasError ? "failed" : "success";
  if (lower === "error" || lower === "failed") return "failed";
  if (lower === "queued" || lower === "pending") return "pending";
  if (lower === "canceled" || lower === "cancelled") return "canceled";
  return lower;
}

/** Returns true when at least one media item has not failed or been canceled. */
export function hasNonFailedMedia(media: readonly ToolMediaItem[]): boolean {
  return media.some(
    (item) => item.status !== "failed" && item.status !== "canceled" && item.status !== "error",
  );
}

/** Extracts a scalar error code or message from a tile or media failure field. */
function extractMediaError(value: unknown): string | number | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return value;
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["errorCode", "error_code", "code", "error", "message"]) {
    const nested = readOwn(value, key);
    if (typeof nested === "string" && nested.trim()) return nested.trim();
    if (typeof nested === "number") return nested;
  }
  return undefined;
}

/** Finds a non-trashed `FAILED_ASSET` tile matching `mediaId` when standard asset lookup skips it. */
function findFailedAssetTile(tiles: readonly AttachmentTile[], mediaId: string): AttachmentTile | undefined {
  const wanted = cleanMediaId(mediaId);
  return tiles.find((tile) => {
    if (!tile || isTrashedTile(tile) || String(tile.type ?? "").toUpperCase() !== "FAILED_ASSET") {
      return false;
    }
    return tile.id === mediaId ||
      (Boolean(wanted) && (cleanMediaId(tile.id) === wanted || cleanMediaId(tile.primaryMediaId) === wanted));
  });
}

/** Reconciles turn media items against live project tiles and variant readiness. */
export function reconcileTurnMedia(
  items: readonly ToolMediaItem[],
  page?: Record<string, unknown>,
): ToolMediaItem[] {
  const normalized = items.map((item) => ({
    media_id: item.media_id,
    status: normalizeToolMediaStatus(item.status, item.error !== undefined),
    error: item.error,
  }));
  const tiles = readProjectTiles(page);
  if (tiles.length === 0) return normalized;

  return normalized.map((item) => {
    const matched = resolveRequestedAsset(tiles, item.media_id);
    if (!matched) {
      const failedTile = findFailedAssetTile(tiles, item.media_id);
      if (!failedTile) return item;
      const payload = findMediaContainer(failedTile)?.[1];
      const adapted = payload ? legacyMedia(payload) : undefined;
      const error = item.error ?? extractMediaError(adapted?.nf ?? readOwn(failedTile, "Bf") ?? readOwn(failedTile, "nf"));
      return { media_id: item.media_id, status: "failed", error };
    }

    const { tile, variant } = matched;
    const primary = findMediaContainer(tile)?.[1];
    const container = variant ?? primary;
    const isPrimary = !variant ||
      variant === primary ||
      cleanMediaId(readOwn(variant, "id")) === cleanMediaId(tile.primaryMediaId);
    const adapted = container ? legacyMedia(container) : undefined;
    const tileStatus = adapted?.Zc?.toLowerCase();
    const tileError = extractMediaError(adapted?.nf ?? readOwn(tile, "Bf") ?? readOwn(tile, "nf"));

    if (tileStatus === "failed" || tileStatus === "error") {
      return { media_id: item.media_id, status: "failed", error: item.error ?? tileError };
    }
    if (tileStatus === "canceled" || tileStatus === "cancelled") {
      return { media_id: item.media_id, status: "canceled", error: item.error ?? tileError };
    }
    if (item.status === "failed" || item.status === "canceled") {
      if (tileStatus === "success" && !(isPrimary && tile.isPending) && isReadyVariant(container)) {
        return { media_id: item.media_id, status: "success", error: undefined };
      }
      return { ...item, error: item.error ?? tileError };
    }
    if (tileStatus === "scheduled") {
      return { media_id: item.media_id, status: "scheduled", error: undefined };
    }
    if (
      (isPrimary && tile.isPending === true) ||
      tileStatus === "pending" ||
      tileStatus === "queued" ||
      !isReadyVariant(container)
    ) {
      return { media_id: item.media_id, status: "pending", error: undefined };
    }
    if (tileStatus === "success" || item.status === "success") {
      return { media_id: item.media_id, status: "success", error: undefined };
    }
    return item;
  });
}

/** Merges server and local reply block lists without losing partial stream output. */
function mergeReplyBlocks(savedBlocks: readonly ReplyBlock[], priorBlocks: readonly ReplyBlock[]): ReplyBlock[] {
  if (savedBlocks.length === 0) return [...priorBlocks];
  if (priorBlocks.length === 0) return [...savedBlocks];
  const length = Math.max(savedBlocks.length, priorBlocks.length);
  const merged: ReplyBlock[] = [];
  for (let index = 0; index < length; index++) {
    const saved = savedBlocks[index];
    const prior = priorBlocks[index];
    if (!saved) merged.push(prior);
    else if (!prior) merged.push(saved);
    else if (saved.type === "text" && prior.type === "text") {
      merged.push(prior.content.length > saved.content.length ? prior : saved);
    } else if (saved.type === "question" && prior.type === "question") {
      merged.push(saved.card.Qj !== undefined || prior.card.Qj === undefined ? saved : prior);
    } else if (saved.type === "permission" && prior.type === "permission") {
      merged.push(saved.card.Vz !== undefined || prior.card.Vz === undefined ? saved : prior);
    } else {
      merged.push(saved);
    }
  }
  return merged;
}

/** Selects the most complete reply text across server, local, and block snapshots. */
function selectReplyText(savedText: string, priorText: string, blocks: readonly ReplyBlock[]): string {
  const blockText = blocks.flatMap((block) => (block.type === "text" ? [block.content] : [])).join("\n\n");
  let best = savedText;
  for (const candidate of [priorText, blockText]) {
    if (candidate.length > best.length) best = candidate;
  }
  return best;
}

/** Merges streaming media maps from local and server turn snapshots. */
function mergeStreamMedia(
  savedMap: Map<string, { status: string; errorCode?: string | number }> | undefined,
  priorMap: Map<string, { status: string; errorCode?: string | number }> | undefined,
): Map<string, { status: string; errorCode?: string | number }> | undefined {
  if (!savedMap && !priorMap) return undefined;
  const merged = new Map<string, { status: string; errorCode?: string | number }>(priorMap);
  for (const [mediaId, item] of savedMap ?? []) {
    const previous = merged.get(mediaId);
    if (!previous) {
      merged.set(mediaId, item);
      continue;
    }
    const nextStatus = normalizeToolMediaStatus(item.status, item.errorCode !== undefined);
    const prevStatus = normalizeToolMediaStatus(previous.status, previous.errorCode !== undefined);
    const keepPrevious = (prevStatus === "failed" || prevStatus === "canceled") &&
      nextStatus !== "failed" && nextStatus !== "canceled" && nextStatus !== "success";
    merged.set(mediaId, {
      status: keepPrevious ? previous.status : item.status,
      errorCode: item.errorCode ?? previous.errorCode,
    });
  }
  return merged;
}

/** Merges a disconnected `STORED_TURN_IN_PROGRESS` turn with any local partial turn. */
export function mergeDisconnectedTurn(
  flow: FlowAgentExports,
  savedTurn: LiveTurn,
  priorTurn: LiveTurn | undefined,
  index: number,
): MergedTurnView {
  const [savedUser, savedReply] = flow.reply({ turn: savedTurn, XJ: index, yc: false });
  const savedBlocks = savedReply.Oh ?? savedTurn.Tf?.Oh ?? [];
  const rawError = savedReply.errorMessage ?? savedTurn.errorMessage;
  if (!priorTurn) {
    return {
      user: savedUser,
      text: selectReplyText(savedReply.text, "", savedBlocks),
      responseId: savedReply.ci,
      blocks: savedBlocks,
      rawError,
      legacyRequest: savedReply.jna,
      streamMedia: savedTurn.Tf?.Bx,
      hasStream: Boolean(savedTurn.Tf),
      legacySources: [savedTurn],
    };
  }
  const [priorUser, priorReply] = flow.reply({ turn: priorTurn, XJ: index, yc: false });
  const priorBlocks = priorReply.Oh ?? priorTurn.Tf?.Oh ?? [];
  const blocks = mergeReplyBlocks(savedBlocks, priorBlocks);
  return {
    user: {
      text: savedUser.text || priorUser.text,
      Gh: savedUser.Gh?.length ? savedUser.Gh : priorUser.Gh,
      Uy: savedUser.Uy?.length ? savedUser.Uy : priorUser.Uy,
    },
    text: selectReplyText(savedReply.text, priorReply.text, blocks),
    responseId: savedReply.ci ?? priorReply.ci,
    blocks,
    rawError,
    legacyRequest: savedReply.jna ?? priorReply.jna,
    streamMedia: mergeStreamMedia(savedTurn.Tf?.Bx, priorTurn.Tf?.Bx),
    hasStream: Boolean(savedTurn.Tf || priorTurn.Tf),
    legacySources: savedTurn.Yu.length > 0 ? [savedTurn, priorTurn] : [priorTurn, savedTurn],
  };
}

/** Returns true when `TurnStore` must hydrate `savedTurns` before a new message. */
export function needsTurnHydration(
  localTurns: readonly LiveTurn[] | undefined,
  savedTurns: readonly StoredTurn[],
): boolean {
  const localCount = localTurns?.length ?? 0;
  if (savedTurns.length > localCount) return true;
  if (!localTurns) return false;
  if (localTurns.slice(savedTurns.length).some((turn) => turn.errorMessage !== undefined)) return true;
  return savedTurns.some((saved, index) => {
    const state = saved.getState();
    return localTurns[index]?.errorMessage !== undefined && state !== 3 && state !== 5;
  });
}

/** Resolves a fallback `QueryClient` from the raw transport service when needed. */
function resolveTransportQueryClient(
  page: Record<string, unknown>,
  transportField: string,
  transport: Transport,
): QueryClient | undefined {
  const rawTransport = readOwn(page, transportField);
  for (const candidate of [readOwn(rawTransport, "Wa"), readOwn(transport, "Wa")]) {
    const client = candidate as QueryClient | undefined;
    if (typeof client?.queryCache?.find === "function" || typeof client?.queryCache?.findAll === "function") {
      return client;
    }
  }
  return undefined;
}

/** Removes cached session and session-list queries for `sessionId` from `QueryClient`. */
function clearSessionQueries(client: QueryClient | undefined, projectId: string, sessionId: string): void {
  const cache = client?.queryCache;
  if (!cache) return;
  const targets = new Set<NonNullable<ReturnType<NonNullable<typeof cache.find>>>>();
  if (typeof cache.findAll === "function") {
    for (const query of cache.findAll({ queryKey: ["CREATION_AGENT_SESSION", sessionId] })) targets.add(query);
    for (const query of cache.findAll({ queryKey: ["CREATION_AGENT_SESSIONS"] })) targets.add(query);
  } else if (typeof cache.getAll === "function") {
    for (const query of cache.getAll()) {
      const [scope, keyId] = query.queryKey;
      if (scope === "CREATION_AGENT_SESSIONS" || (scope === "CREATION_AGENT_SESSION" && keyId === sessionId)) {
        targets.add(query);
      }
    }
  } else if (typeof cache.find === "function") {
    for (const queryKey of [
      ["CREATION_AGENT_SESSION", sessionId],
      ["CREATION_AGENT_SESSIONS", projectId],
      ["CREATION_AGENT_SESSIONS"],
    ]) {
      const found = cache.find({ queryKey, exact: true });
      if (found) targets.add(found);
    }
  }
  for (const query of targets) {
    if (typeof cache.remove === "function") {
      cache.remove(query);
      continue;
    }
    const queries = readOwn(cache, "queries");
    if (queries instanceof Map) {
      for (const [hash, entry] of queries.entries()) {
        if (entry === query) queries.delete(hash);
      }
    }
  }
}

/** Reads the `set` method from an Angular writable signal function or object. */
function readSignalSetter(target: unknown): ((value: unknown) => void) | undefined {
  if (typeof target !== "function" && (!target || typeof target !== "object")) return undefined;
  try {
    const setter: unknown = Reflect.get(target as object, "set");
    return typeof setter === "function" ? (setter as (value: unknown) => void) : undefined;
  } catch {
    return undefined;
  }
}

/** Resets the selected session signal `qg()` on a native or adapted `TurnStore` when it matches `sessionId`. */
function resetActiveSessionOnStore(store: unknown, sessionId: string): void {
  if (!store || typeof store !== "object") return;
  const qg = readOwn(store, "qg");
  if (typeof qg === "function") {
    try {
      if (qg.call(store) !== sessionId) return;
    } catch {
      return;
    }
    const oa = readOwn(store, "oa");
    const setOa = readSignalSetter(oa);
    if (setOa) setOa.call(oa, undefined);
    if (qg.call(store) !== sessionId) return;
    const setQg = readSignalSetter(qg);
    if (setQg) {
      setQg.call(qg, undefined);
      return;
    }
  }
  for (const field of Object.values(store as Record<string, unknown>)) {
    const setter = typeof field === "function" ? readSignalSetter(field) : undefined;
    if (!setter) continue;
    try {
      if ((field as () => unknown).call(store) === sessionId) {
        setter.call(field, undefined);
        if (typeof qg === "function" && qg.call(store) !== sessionId) return;
      }
    } catch {
      // Skip unrelated signals that require an Angular reactive context.
    }
  }
}

/** Clears draft tracking, `TurnStore` state, `QueryClient` caches, and `qg()` for `sessionId`. */
export function purgeSessionState(context: SessionCacheContext, sessionId: string): void {
  clearQuestionReplays(sessionId);
  context.drafts.delete(sessionId);
  context.transport.ka.yL(sessionId);
  const rawTransport = readOwn(context.page, context.transportField);
  resetActiveSessionOnStore(readOwn(rawTransport, "ka"), sessionId);
  resetActiveSessionOnStore(context.transport.ka, sessionId);
  const client = resolveQueryClient(context.injector, context.page) ??
    resolveTransportQueryClient(context.page, context.transportField, context.transport);
  clearSessionQueries(client, context.projectId, sessionId);
}

/** Returns true when an unpersisted draft has no active turn and no completed turn. */
export function isFailedDraftSession(transport: Transport, sessionId: string): boolean {
  if (transport.ha.has(sessionId)) return false;
  const local = transport.ka.ha().get(sessionId);
  if (local?.xe) return false;
  if (!local || local.Vh.length === 0) return true;
  return !local.Vh.some((turn) => turn.errorMessage === undefined);
}

/** Purges all failed unpersisted initial draft sessions from memory and `QueryClient`. */
export function purgeFailedDrafts(context: SessionCacheContext): void {
  for (const sessionId of [...context.drafts]) {
    if (isFailedDraftSession(context.transport, sessionId)) purgeSessionState(context, sessionId);
  }
}

/** Waits for both `PROJECT_DETAILS` and `USER_PROFILE` queries before evaluating `canSend`. */
export async function waitForSendReadiness(
  context: SessionCacheContext,
  signal?: AbortSignal,
): Promise<boolean> {
  if (context.canSend()) return true;
  const client = resolveQueryClient(context.injector, context.page) ??
    resolveTransportQueryClient(context.page, context.transportField, context.transport);
  const shared = { client, ready: () => context.canSend(), canContinue: context.isCurrent, signal };
  await Promise.all([
    waitForQuerySettlement({ ...shared, queryKey: ["PROJECT_DETAILS", context.projectId] }),
    waitForQuerySettlement({ ...shared, queryKey: ["USER_PROFILE"] }),
  ]);
  return context.canSend();
}

/** Returns true when a `Wvc` stream entry in `transport.ha` is detached from its transport. */
function isDetachedStream(stream: unknown): boolean {
  if (!stream || typeof stream !== "object") return false;
  if (readOwn(stream, "detached") === true) return true;
  if (readOwn(readOwn(stream, "Wj"), "closed") === true) return true;
  for (const value of Object.values(stream as Record<string, unknown>)) {
    if (value && typeof value === "object" && typeof readOwn(value, "unsubscribe") === "function") {
      if (readOwn(value, "closed") === true) return true;
    }
  }
  const hasSlot = "ha" in stream || "Ui" in stream || typeof readOwn(stream, "detach") === "function";
  return hasSlot && readOwn(stream, "ha") == null && readOwn(stream, "Ui") == null;
}

/** Waits for a detached `Wvc` stream to reattach or close within a bounded timeout. */
async function waitForStreamAttachment(
  transport: Transport,
  sessionId: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + COLD_QUERY_TIMEOUT_MS;
  while (Date.now() < deadline && isCurrent()) {
    if (!transport.ha.has(sessionId)) return false;
    if (!isDetachedStream(transport.ha.get(sessionId))) return true;
    await delay(Math.max(1, Math.min(STREAM_ATTACH_POLL_MS, deadline - Date.now())));
  }
  return isCurrent() && transport.ha.has(sessionId) && !isDetachedStream(transport.ha.get(sessionId));
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

/** Returns true when `TurnStore` recorded `Qj` on the specified question card. */
function isQuestionCardAccepted(
  transport: Transport,
  flow: FlowAgentExports,
  sessionId: string,
  turn: number,
  actionId: string,
): boolean {
  const blocks = readLiveTurnBlocks(transport, flow, sessionId, turn);
  const target = blocks?.find(
    (block): block is Extract<ReplyBlock, { type: "question" }> =>
      block.type === "question" && block.card.id === actionId,
  );
  return target?.card.Qj !== undefined;
}

/** Replays any unpersisted recorded question answers on an attached live stream. */
function replaySessionAnswersSync(state: SessionReplayState, sessionId: string): void {
  if (!state.isCurrent() || !state.transport.ha.has(sessionId)) return;
  if (isDetachedStream(state.transport.ha.get(sessionId))) return;
  const local = state.transport.ka.ha().get(sessionId);
  if (!local?.xe) return;
  if (local.Vh.length + 1 !== state.turn) {
    sessionReplays.delete(sessionId);
    return;
  }
  for (const record of state.records) {
    if (isQuestionCardAccepted(state.transport, state.flow, sessionId, state.turn, record.actionId)) {
      continue;
    }
    const blocks = readLiveTurnBlocks(state.transport, state.flow, sessionId, state.turn);
    if (!blocks || firstOpenQuestionId(blocks) !== record.actionId) break;
    state.questions.OA({ sessionId, Ig: record.actionId, Qj: record.answers, hi: AGENT_SURFACE });
    if (!isQuestionCardAccepted(state.transport, state.flow, sessionId, state.turn, record.actionId)) {
      break;
    }
  }
}

/** Waits for stream attachment after a reconnect and replays unpersisted answers. */
async function replayAfterStreamReconnect(sessionId: string): Promise<void> {
  const state = sessionReplays.get(sessionId);
  if (!state || !state.isCurrent()) return;
  const attached = await waitForStreamAttachment(state.transport, sessionId, state.isCurrent);
  const latest = sessionReplays.get(sessionId);
  if (attached && latest) replaySessionAnswersSync(latest, sessionId);
}

/** Watches an active turn so in-place stream resets also replay recorded question answers. */
async function watchActiveQuestionTurn(sessionId: string): Promise<void> {
  const initial = sessionReplays.get(sessionId);
  if (!initial || initial.watching) return;
  initial.watching = true;
  try {
    while (sessionReplays.has(sessionId)) {
      const current = sessionReplays.get(sessionId);
      if (!current || !current.isCurrent() || !current.transport.ha.has(sessionId)) break;
      replaySessionAnswersSync(current, sessionId);
      await delay(REPLAY_WATCH_POLL_MS);
    }
  } finally {
    const finalState = sessionReplays.get(sessionId);
    if (finalState) finalState.watching = false;
  }
}

/** Installs an instance-level `set` observer on `transport.ha` to catch `Dwc` / `Cwc` reconnects. */
function armStreamReconnectHook(map: Map<string, unknown>): void {
  if (hookedStreamMaps.has(map)) return;
  hookedStreamMaps.add(map);
  const setStream = function (this: Map<string, unknown>, key: string, value: unknown): Map<string, unknown> {
    const result = Map.prototype.set.call(this, key, value) as Map<string, unknown>;
    if (sessionReplays.has(key)) {
      queueMicrotask(() => {
        void replayAfterStreamReconnect(key);
        void watchActiveQuestionTurn(key);
      });
    }
    return result;
  };
  Object.defineProperty(map, "set", { value: setStream, configurable: true, writable: true });
}

/** Clears recorded question answers for `sessionId`, or when `turn` no longer matches. */
export function clearQuestionReplays(sessionId: string, keepTurn?: number): void {
  if (keepTurn === undefined || sessionReplays.get(sessionId)?.turn !== keepTurn) {
    sessionReplays.delete(sessionId);
  }
}

/** Synchronously replays any recorded question answers whose cards reset on an attached stream. */
export function reconcileQuestionReplays(
  context: Omit<QuestionReplayContext, "turn">,
  stored: readonly StoredTurn[],
  inProgressState: number,
): void {
  const existing = sessionReplays.get(context.sessionId);
  if (!existing) return;
  Object.assign(existing, {
    transport: context.transport,
    flow: context.flow,
    questions: context.questions,
    isCurrent: context.isCurrent,
  });
  armStreamReconnectHook(context.transport.ha);
  if (context.transport.ha.has(context.sessionId)) {
    replaySessionAnswersSync(existing, context.sessionId);
    return;
  }
  const lastState = stored.at(-1)?.getState();
  if (lastState !== undefined && lastState !== inProgressState) {
    sessionReplays.delete(context.sessionId);
  }
}

/** Waits for stream attachment after `resume` and replays recorded answers for `sessionId`. */
export async function replayResumedQuestions(context: Omit<QuestionReplayContext, "turn">): Promise<void> {
  const existing = sessionReplays.get(context.sessionId);
  if (!existing) return;
  Object.assign(existing, {
    transport: context.transport,
    flow: context.flow,
    questions: context.questions,
    isCurrent: context.isCurrent,
  });
  armStreamReconnectHook(context.transport.ha);
  await replayAfterStreamReconnect(context.sessionId);
  void watchActiveQuestionTurn(context.sessionId);
}

/** Waits on detached `Wvc` streams, submits a question answer, verifies acceptance, and arms replay. */
export async function submitQuestionAnswer(
  context: QuestionReplayContext,
  actionId: string,
  answers: FlowAnswer[],
): Promise<"ok" | "project_changed" | "not_pending"> {
  const { sessionId, turn, transport, flow, questions, isCurrent } = context;
  armStreamReconnectHook(transport.ha);
  clearQuestionReplays(sessionId, turn);

  for (let attempt = 0; attempt < 2; attempt++) {
    const attached = await waitForStreamAttachment(transport, sessionId, isCurrent);
    if (!isCurrent()) return "project_changed";
    if (!attached) return "not_pending";

    const existing = sessionReplays.get(sessionId);
    if (existing && existing.turn === turn) {
      Object.assign(existing, { transport, flow, questions, isCurrent });
      replaySessionAnswersSync(existing, sessionId);
    }

    const blocks = readLiveTurnBlocks(transport, flow, sessionId, turn);
    if (!blocks || firstOpenQuestionId(blocks) !== actionId) {
      if (isQuestionCardAccepted(transport, flow, sessionId, turn, actionId)) break;
      return "not_pending";
    }

    questions.OA({ sessionId, Ig: actionId, Qj: answers, hi: AGENT_SURFACE });
    if (isQuestionCardAccepted(transport, flow, sessionId, turn, actionId)) {
      const state: SessionReplayState = sessionReplays.get(sessionId) ?? {
        turn,
        records: [],
        transport,
        flow,
        questions,
        isCurrent,
        watching: false,
      };
      Object.assign(state, { turn, transport, flow, questions, isCurrent });
      const idx = state.records.findIndex((item) => item.actionId === actionId);
      if (idx >= 0) state.records[idx] = { actionId, answers };
      else state.records.push({ actionId, answers });
      sessionReplays.set(sessionId, state);
      void watchActiveQuestionTurn(sessionId);
      return "ok";
    }
    if (!transport.ha.has(sessionId)) return "not_pending";
  }
  return isCurrent() ? "not_pending" : "project_changed";
}
