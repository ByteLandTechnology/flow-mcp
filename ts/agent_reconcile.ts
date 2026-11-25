// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Reconcile read-only Agent turns, media tiles, session caches, and send readiness.

import { readOwn } from "./angular";
import { isReadyVariant, readProjectTiles, resolveRequestedAsset } from "./agent_attachments";
import type { AttachmentTile } from "./agent_attachments";
import type {
  FlowAgentExports,
  LiveTurn,
  ReplyBlock,
  StoredTurn,
  Transport,
} from "./agent_protocol";
import { resolveQueryClient, waitForQuerySettlement } from "./agent_settings";
import type { AgentInjector, QueryClient, SettingsQuery } from "./agent_settings";
import { cleanMediaId, findMediaContainer, isTrashedTile, legacyMedia } from "./dom";

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
  /** Optional composer service instance on the bound page. */
  composer?: object;
  /** Adapted Agent transport service. */
  transport: Transport;
  /** Unsaved session IDs allocated in this page binding. */
  drafts: Set<string>;
  /** Signal predicate that reports whether the user can send Agent messages. */
  canSend: () => boolean;
  /** Returns true while the page binding still owns the active project. */
  isCurrent: () => boolean;
}

/** Normalizes a tool or streaming media status string to Flow's lifecycle vocabulary. */
export function normalizeToolMediaStatus(rawStatus: string, hasError = false): string {
  const lower = rawStatus
    .trim()
    .toLowerCase()
    .replace(/^media_generation_status_/, "");
  if (!lower) return hasError ? "failed" : "success";
  if (lower === "error" || lower === "failed") return "failed";
  if (lower === "canceled" || lower === "cancelled") return "canceled";
  if (
    lower === "queued" ||
    lower === "pending" ||
    lower === "in_progress" ||
    lower === "active" ||
    lower === "generating"
  ) {
    return "pending";
  }
  if (lower === "succeeded" || lower === "successful" || lower === "completed") {
    return hasError ? "failed" : "success";
  }
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
      const error =
        item.error ??
        extractMediaError(adapted?.nf ?? readOwn(failedTile, "Bf") ?? readOwn(failedTile, "nf"));
      return { media_id: item.media_id, status: "failed", error };
    }

    const { tile, variant } = matched;
    const primary = findMediaContainer(tile)?.[1];
    const container = variant ?? primary;
    const isPrimary =
      !variant ||
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

/** Merges server and local reply block lists when both snapshots belong to the same turn. */
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
      const usePrior =
        saved.card.id === prior.card.id &&
        saved.card.Qj === undefined &&
        prior.card.Qj !== undefined;
      merged.push(usePrior ? prior : saved);
    } else if (saved.type === "permission" && prior.type === "permission") {
      const usePrior =
        saved.card.id === prior.card.id &&
        saved.card.Vz === undefined &&
        prior.card.Vz !== undefined;
      merged.push(usePrior ? prior : saved);
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
    const keepPrevious =
      (prevStatus === "failed" || prevStatus === "canceled") &&
      nextStatus !== "failed" &&
      nextStatus !== "canceled" &&
      nextStatus !== "success";
    merged.set(mediaId, {
      status: keepPrevious ? previous.status : item.status,
      errorCode: item.errorCode ?? previous.errorCode,
    });
  }
  return merged;
}

/** Returns true when two optional attachment identifier arrays match in order. */
function sameAttachmentIds(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const leftIds = left ?? [];
  const rightIds = right ?? [];
  return (
    leftIds.length === rightIds.length &&
    leftIds.every((id, index) => id === rightIds[index])
  );
}

/** Checks that the user message and server response ID match before merging turn data. */
function canMergeDisconnectedTurn(
  savedUser: DecodedUser,
  savedResponseId: string | undefined,
  priorTurn: LiveTurn,
  priorUser: DecodedUser,
  priorReply: DecodedReply,
): boolean {
  if (savedUser.text !== priorUser.text) return false;
  if (
    !sameAttachmentIds(
      savedUser.Gh?.map((item) => item.mediaId),
      priorUser.Gh?.map((item) => item.mediaId),
    ) ||
    !sameAttachmentIds(
      savedUser.Uy?.map((item) => item.Nc),
      priorUser.Uy?.map((item) => item.Nc),
    )
  ) {
    return false;
  }
  const priorResponseId = priorReply.ci || undefined;
  if (savedResponseId && priorResponseId && savedResponseId !== priorResponseId) {
    return false;
  }
  if (savedResponseId && !priorResponseId && priorTurn.errorMessage !== undefined) {
    return false;
  }
  return true;
}

/** Builds a `MergedTurnView` from the stored server turn without local partial fields. */
function storedOnlyTurnView(
  savedTurn: LiveTurn,
  savedUser: DecodedUser,
  savedReply: DecodedReply,
  savedResponseId: string | undefined,
  savedBlocks: ReplyBlock[],
  rawError: string | number | undefined,
): MergedTurnView {
  return {
    user: savedUser,
    text: selectReplyText(savedReply.text, "", savedBlocks),
    responseId: savedResponseId,
    blocks: savedBlocks,
    rawError,
    legacyRequest: savedReply.jna,
    streamMedia: savedTurn.Tf?.Bx,
    hasStream: Boolean(savedTurn.Tf),
    legacySources: [savedTurn],
  };
}

/** Merges a disconnected `STORED_TURN_IN_PROGRESS` turn with a matching local partial turn. */
export function mergeDisconnectedTurn(
  flow: FlowAgentExports,
  savedTurn: LiveTurn,
  priorTurn: LiveTurn | undefined,
  index: number,
  storedResponseId?: string,
): MergedTurnView {
  const [savedUser, savedReply] = flow.reply({ turn: savedTurn, XJ: index, yc: false });
  const savedResponseId = savedReply.ci || storedResponseId || undefined;
  const savedBlocks = savedReply.Oh ?? savedTurn.Tf?.Oh ?? [];
  const rawError = savedReply.errorMessage ?? savedTurn.errorMessage;
  if (!priorTurn) {
    return storedOnlyTurnView(
      savedTurn,
      savedUser,
      savedReply,
      savedResponseId,
      savedBlocks,
      rawError,
    );
  }
  const [priorUser, priorReply] = flow.reply({ turn: priorTurn, XJ: index, yc: false });
  if (
    !canMergeDisconnectedTurn(
      savedUser,
      savedResponseId,
      priorTurn,
      priorUser,
      priorReply,
    )
  ) {
    return storedOnlyTurnView(
      savedTurn,
      savedUser,
      savedReply,
      savedResponseId,
      savedBlocks,
      rawError,
    );
  }
  const priorBlocks = priorReply.Oh ?? priorTurn.Tf?.Oh ?? [];
  const blocks = mergeReplyBlocks(savedBlocks, priorBlocks);
  return {
    user: {
      text: savedUser.text,
      Gh: savedUser.Gh?.length ? savedUser.Gh : priorUser.Gh,
      Uy: savedUser.Uy?.length ? savedUser.Uy : priorUser.Uy,
    },
    text: selectReplyText(savedReply.text, priorReply.text, blocks),
    responseId: savedResponseId ?? (priorReply.ci || undefined),
    blocks,
    rawError,
    legacyRequest: savedReply.jna ?? priorReply.jna,
    streamMedia: mergeStreamMedia(savedTurn.Tf?.Bx, priorTurn.Tf?.Bx),
    hasStream: Boolean(savedTurn.Tf || priorTurn.Tf),
    legacySources: savedTurn.Yu.length > 0 ? [savedTurn, priorTurn] : [priorTurn, savedTurn],
  };
}

/** Returns true when `TurnStore` must hydrate `savedTurns` before sending a follow-up message. */
export function needsTurnHydration(
  localTurns: readonly LiveTurn[] | undefined,
  savedTurns: readonly StoredTurn[],
): boolean {
  const localCount = localTurns?.length ?? 0;
  if (savedTurns.length !== localCount) return true;
  if (!localTurns) return false;
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
    if (
      typeof client?.queryCache?.find === "function" ||
      typeof client?.queryCache?.findAll === "function" ||
      typeof client?.queryCache?.getAll === "function"
    ) {
      return client;
    }
  }
  return undefined;
}

/** Cancels and removes cached session and session-list queries for `sessionId` from `QueryClient`. */
async function clearSessionQueries(
  client: QueryClient | undefined,
  projectId: string,
  sessionId: string,
): Promise<void> {
  const cache = client?.queryCache;
  if (!cache) return;
  const targets = new Set<SettingsQuery>();
  if (typeof cache.findAll === "function") {
    for (const query of cache.findAll({ queryKey: ["CREATION_AGENT_SESSION", sessionId] })) {
      targets.add(query);
    }
    for (const query of cache.findAll({ queryKey: ["CREATION_AGENT_SESSIONS"] })) {
      targets.add(query);
    }
  }
  if (typeof cache.getAll === "function" && targets.size === 0) {
    for (const query of cache.getAll()) {
      const [scope, keyId] = query.queryKey;
      if (scope === "CREATION_AGENT_SESSIONS" || (scope === "CREATION_AGENT_SESSION" && keyId === sessionId)) {
        targets.add(query);
      }
    }
  }
  if (typeof cache.find === "function") {
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
    await query.cancel?.({ revert: true }).catch(() => undefined);
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

/** Resets active and pending session signals (`qg`, `oa`, `la`, `ka`) when they hold `sessionId`. */
function resetActiveSessionOnTarget(target: unknown, sessionId: string): void {
  if (!target || typeof target !== "object") return;
  const qg = readOwn(target, "qg");
  if (typeof qg === "function") {
    try {
      if (qg.call(target) === sessionId) {
        const oa = readOwn(target, "oa");
        const setOa = readSignalSetter(oa);
        if (setOa) setOa.call(oa, undefined);
        if (qg.call(target) === sessionId) {
          const setQg = readSignalSetter(qg);
          if (setQg) setQg.call(qg, undefined);
        }
      }
    } catch {
      // Ignore signal read errors outside reactive contexts.
    }
  }
  const la = readOwn(target, "la");
  if (typeof la === "function") {
    try {
      if (la.call(target) === sessionId) {
        const ka = readOwn(target, "ka");
        const setKa = readSignalSetter(ka);
        if (setKa) setKa.call(ka, undefined);
      }
    } catch {
      // Ignore unrelated `la` methods that are not session signals.
    }
  }
  for (const field of Object.values(target as Record<string, unknown>)) {
    const setter = typeof field === "function" ? readSignalSetter(field) : undefined;
    if (!setter) continue;
    try {
      if ((field as () => unknown).call(target) === sessionId) {
        setter.call(field, undefined);
      }
    } catch {
      // Skip unrelated signals that require an Angular reactive context.
    }
  }
}

/** Clears draft tracking, `TurnStore` state, active session signals, and `QueryClient` caches. */
export async function purgeSessionState(
  context: SessionCacheContext,
  sessionId: string,
): Promise<void> {
  context.drafts.delete(sessionId);
  context.transport.ka.yL(sessionId);
  const rawTransport = readOwn(context.page, context.transportField);
  for (const target of [
    readOwn(rawTransport, "ka"),
    rawTransport,
    context.transport.ka,
    context.composer,
  ]) {
    resetActiveSessionOnTarget(target, sessionId);
  }
  const client =
    resolveQueryClient(context.injector, context.page) ??
    resolveTransportQueryClient(context.page, context.transportField, context.transport);
  await clearSessionQueries(client, context.projectId, sessionId);
}

/** Returns true when an unpersisted draft has no active turn and all local turns failed. */
export function isFailedDraftSession(transport: Transport, sessionId: string): boolean {
  if (transport.ha.has(sessionId)) return false;
  const local = transport.ka.ha().get(sessionId);
  if (!local || local.xe || local.Vh.length === 0) return false;
  return local.Vh.every((turn) => turn.errorMessage !== undefined);
}

/** Purges unpersisted draft sessions whose attempted turns all failed without saving. */
export async function purgeFailedDrafts(context: SessionCacheContext): Promise<void> {
  for (const sessionId of [...context.drafts]) {
    if (isFailedDraftSession(context.transport, sessionId)) {
      await purgeSessionState(context, sessionId);
    }
  }
}

/** Waits for `PROJECT_DETAILS` and `USER_PROFILE` queries before evaluating `canSend`. */
export async function waitForSendReadiness(
  context: SessionCacheContext,
  signal?: AbortSignal,
): Promise<boolean> {
  if (context.canSend()) return true;
  const client =
    resolveQueryClient(context.injector, context.page) ??
    resolveTransportQueryClient(context.page, context.transportField, context.transport);
  const shared = { client, ready: () => context.canSend(), canContinue: context.isCurrent, signal };
  await Promise.all([
    waitForQuerySettlement({ ...shared, queryKey: ["PROJECT_DETAILS", context.projectId] }),
    waitForQuerySettlement({ ...shared, queryKey: ["USER_PROFILE"] }),
  ]);
  return context.canSend();
}
