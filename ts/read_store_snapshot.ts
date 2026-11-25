// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read all project tiles, scene clips, and collections from the bound store map.

import { readOwn } from "./angular";
import { characterPersonalityNotes, characterVoice } from "./character_bio";
import { activeProjectStoreFormat, snapshotFormat } from "./frontend_builds";
import { currentProjectStore, projectInRoute } from "./project_store";
import { sceneContents } from "./scene_tiles";
import {
  asHttpOrDataUrl,
  characterLookMedia,
  cleanMediaId,
  collectionIdOf,
  fifeEnv as getFifeEnv,
  isNonAssetTileType,
  isTrashedTile,
  legacyMedia,
  legacyTile,
  normalizeFlowMediaUrl,
  readMediaUrl,
  videoTrimBounds,
} from "./dom";
import { clearStore, runtimeState } from "./state";
import type {
  FlowMediaPayload,
  FlowTile,
  SceneClipItem,
  SnapshotAssetItem,
  SnapshotCollectionItem,
  StoreSnapshotResult,
} from "./types";

/** Explicit account credit label pattern (`Google Flow credit(s)` or `AI credit(s)`). */
const ACCOUNT_CREDITS_RE = /(?:^|[^\w,])(\d[\d,]*)\s+(?:Google\s+Flow|Flow|AI)\s+credits?\b|\b(?:Google\s+Flow|Flow|AI)\s+credits?\s*[:–-]?\s*(\d[\d,]*)(?![\d,])/i;

/** Selector matching generation credit cost estimates that are not account balances. */
const COST_LABEL_SELECTOR = "flow-credit-cost-label, .credit-cost-label, .credit-cost-link";

/** Locates an active Angular service instance matching `ServiceClass` in runtime state. */
function findCreditsServiceInstance(
  ServiceClass: abstract new (...args: never[]) => object,
): object | null {
  const seen = new Set<object>();
  const checkObject = (candidate: unknown, depth: number): object | null => {
    if (!candidate || typeof candidate !== "object" || candidate instanceof Node || seen.has(candidate)) {
      return null;
    }
    if (candidate instanceof ServiceClass) return candidate;
    if (depth <= 0) return null;
    seen.add(candidate);
    for (const key of Object.keys(candidate)) {
      const hit = checkObject(readOwn(candidate, key), depth - 1);
      if (hit) return hit;
    }
    return null;
  };

  const projectId = projectInRoute();
  const fromStore = checkObject(projectId ? currentProjectStore(projectId)?.service : undefined, 2);
  if (fromStore) return fromStore;

  const views = runtimeState.ngLViewMap;
  if (views instanceof Map) {
    for (const view of views.values()) {
      if (!Array.isArray(view)) continue;
      for (const slot of view) {
        const hit = checkObject(slot, 1);
        if (hit) return hit;
        const injector = readOwn(slot, "Ab") ?? slot;
        const getFn = readOwn(injector, "get");
        if (typeof getFn === "function") {
          try {
            const resolved: unknown = getFn.call(injector, ServiceClass, null);
            if (resolved && typeof resolved === "object" && resolved instanceof ServiceClass) {
              return resolved;
            }
          } catch {
            // Ignore non-Angular get methods.
          }
        }
      }
    }
  }
  return null;
}

/** Reads the spendable account credit balance from the verified build's credits service. */
function readMappedCredits(): number | null {
  const format = snapshotFormat()?.credits;
  if (!format) return null;
  const frontEnd = readOwn(window, "default_AiSandboxAngularFrontend");
  const ServiceClass = readOwn(frontEnd, format.service);
  if (typeof ServiceClass !== "function") return null;
  const instance = findCreditsServiceInstance(
    ServiceClass as abstract new (...args: never[]) => object,
  );
  if (!instance) return null;
  try {
    const totalFn = readOwn(instance, format.total);
    if (typeof totalFn === "function") {
      const total: unknown = totalFn.call(instance);
      if (typeof total === "number" && Number.isFinite(total) && total >= 0) {
        return Math.trunc(total);
      }
    }
    const query = readOwn(instance, format.query);
    const dataFn = readOwn(query, "data");
    if (typeof dataFn === "function") {
      const data: unknown = dataFn.call(query);
      const balanceFn = readOwn(data, format.balanceMethod);
      if (typeof balanceFn === "function") {
        const balance: unknown = balanceFn.call(data);
        if (typeof balance === "number" && Number.isFinite(balance) && balance >= 0) {
          return Math.trunc(balance);
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Extracts an integer credit count from an explicit account credit string. */
function parseAccountCreditsText(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\b(?:generate\s+for|generating\s+will\s+use)\s+\d[\d,]*\s+(?:(?:Google\s+Flow|AI|Flow)\s+)?credits?\b/gi, " ");
  const match = ACCOUNT_CREDITS_RE.exec(cleaned);
  if (!match) return null;
  const parsed = parseInt((match[1] || match[2]).replace(/,/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Reads explicit account credit labels from the DOM while ignoring generation cost labels. */
function readDomAccountCredits(): number | null {
  const creditNodes = document.querySelectorAll(
    'header, nav, .cdk-overlay-container, [class*="credit"], [aria-label*="credit" i]',
  );
  for (const node of creditNodes) {
    if (node.matches?.(COST_LABEL_SELECTOR) || node.closest?.(COST_LABEL_SELECTOR)) {
      continue;
    }
    const ariaParsed = parseAccountCreditsText(node.getAttribute?.("aria-label") || "");
    if (ariaParsed !== null) return ariaParsed;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    let textNode = walker.nextNode();
    while (textNode) {
      if (!textNode.parentElement?.closest(COST_LABEL_SELECTOR)) {
        const part = textNode.textContent?.trim();
        if (part) parts.push(part);
      }
      textNode = walker.nextNode();
    }
    const parsed = parseAccountCreditsText(parts.join(" "));
    if (parsed !== null) return parsed;
  }
  return null;
}

/** Normalizes nested voice descriptors into a display string. */
function normalizeVoiceVal(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (Array.isArray(v)) {
    return v.length > 0 ? normalizeVoiceVal(v[0]) : null;
  }
  if (typeof v === "object") {
    const obj = v as {
      title?: unknown;
      name?: unknown;
      voiceName?: unknown;
      voiceId?: unknown;
      id?: unknown;
    };
    const raw =
      obj.title ?? obj.name ?? obj.voiceName ?? obj.voiceId ?? obj.id ?? null;
    return raw == null ? null : String(raw);
  }
  return String(v);
}

/** Reads project tiles, scenes, characters, and collections from bound runtime state. */
export function readStoreSnapshot(): StoreSnapshotResult {
  if (!activeProjectStoreFormat()) {
    clearStore();
    return { ok: false, error: "unsupported_front_end" };
  }
  const match = /\/project\/([^/?#]+)/.exec(location.pathname || "");
  const projectId = match ? match[1] : null;
  const helper = runtimeState.store;
  if (!helper) {
    return { ok: false, error: "store_not_bound" };
  }
  if (
    projectId &&
    runtimeState.projectId &&
    runtimeState.projectId !== projectId
  ) {
    clearStore();
    return { ok: false, error: "project_mismatch" };
  }
  if (!helper.isCurrent() || runtimeState.routePath !== location.pathname) {
    clearStore();
    return { ok: false, error: "route_changed" };
  }
  if (!helper.isReady()) {
    return { ok: false, error: "store_loading" };
  }
  const tileMap = helper.getTileMap();
  if (!(tileMap instanceof Map)) {
    return { ok: false, error: "store_not_bound" };
  }

  const { assets, collections } = readStoreTiles(tileMap);
  const titleEl = document.querySelector(
    'input[aria-label="Editable text"], .editable-text-input, [data-testid="project-title"]',
  );
  const rawTitle = titleEl
    ? ((titleEl as HTMLInputElement).value || titleEl.textContent || "").trim()
    : "";
  const docTitle = (document.title || "")
    .replace(/\s*[-–|]\s*(?:Google\s*)?Flow\s*$/i, "")
    .trim();
  const projectTitle = rawTitle || docTitle || null;

  const credits = readMappedCredits() ?? readDomAccountCredits();

  return { ok: true, projectId, projectTitle, credits, assets, collections };
}

/** Summary of primary media and appended failure items in a workflow `history` array. */
interface MediaHistorySummary {
  /** Primary media entry matching `primaryId`, or `history[0]` when `primaryId` is absent. */
  primary: FlowMediaPayload | null;
  /** Formatted error from the latest failed or canceled item in `history`, when present. */
  error: string | null;
  /** Lowercase status (`failed` or `canceled`) of the latest failed item, when present. */
  failedStatus: string;
}

/** Scans all entries in `rawHistory` to locate the primary media item and any appended failures. */
function inspectMediaHistory(
  rawHistory: unknown,
  primaryId: string | null,
  formatError: (errVal: unknown) => string | null,
): MediaHistorySummary {
  if (!Array.isArray(rawHistory) || rawHistory.length === 0) {
    return { primary: null, error: null, failedStatus: "" };
  }
  const items: FlowMediaPayload[] = [];
  for (const rawItem of rawHistory) {
    if (rawItem && typeof rawItem === "object") {
      items.push(legacyMedia(rawItem as FlowMediaPayload));
    }
  }
  if (items.length === 0) {
    return { primary: null, error: null, failedStatus: "" };
  }
  const wantedId = primaryId ? cleanMediaId(primaryId) : "";
  const primary = wantedId
    ? items.find(
        (item) => cleanMediaId(String(item.id ?? item.mediaId ?? "")) === wantedId,
      ) ?? items[0]
    : items[0];

  let failedCount = 0;
  let latestRawError: string | null = null;
  let latestFailedStatus = "";
  for (const item of items) {
    const status = String(item.Zc ?? "").toLowerCase();
    const err = formatError(item.nf);
    if (status === "failed" || status === "canceled" || Boolean(err)) {
      failedCount += 1;
      latestFailedStatus =
        status === "failed" || status === "canceled" ? status : "failed";
      latestRawError = err || latestFailedStatus;
    }
  }
  const error = latestRawError
    ? failedCount > 1
      ? `${latestRawError} (attempt ${failedCount})`
      : latestRawError
    : null;
  return { primary, error, failedStatus: latestFailedStatus };
}

/** Reads asset and collection details from the tile map. */
export function readStoreTiles(tileMap: Map<string, FlowTile>): {
  assets: SnapshotAssetItem[];
  collections: SnapshotCollectionItem[];
} {
  const cols = new Map<string, string>();
  const counts = new Map<string, number>();
  const byId = new Map<string, Omit<SnapshotAssetItem, "collection_name">>();
  const sceneTiles: FlowTile[] = [];
  const rawList: Omit<SnapshotAssetItem, "collection_name">[] = [];
  const env = getFifeEnv();
  const collectionType = snapshotFormat()?.tileTypes.collection ?? "COLLECTION";
  const isSignedUrlStr = (url: string | null): url is string => {
    if (url === null) return false;
    try {
      return env.isSignedCdnHost(new URL(url));
    } catch {
      return false;
    }
  };

  const formatMediaError = (errVal: unknown): string | null => {
    if (errVal == null || errVal === "") return null;
    if (typeof errVal === "string") return errVal;
    const msg = (errVal as { message?: unknown }).message;
    if (typeof msg === "string" && msg) {
      return msg;
    }
    try {
      return JSON.stringify(errVal);
    } catch {
      return String(errVal);
    }
  };

  const collectionIds = new Set<string>();
  for (const [id, rawTile] of tileMap.entries()) {
    if (String(rawTile?.type ?? "").toUpperCase() === collectionType) {
      collectionIds.add(String(rawTile.id ?? id));
    }
  }
  const isCollectionId = (v: string): boolean => collectionIds.has(v);

  for (const [id, rawTile] of tileMap.entries()) {
    const t = legacyTile(rawTile);
    if (!t || isTrashedTile(t)) {
      continue;
    }
    const tid = String(t.id ?? id);
    const tname = String(t.displayName ?? "");
    const ttype = String(t.type ?? "IMAGE").toUpperCase();
    if (t.isPending === true && (ttype === collectionType || ttype === "SCENE")) {
      continue;
    }

    if (ttype === collectionType) {
      cols.set(tid, tname);
      if (!counts.has(tid)) counts.set(tid, 0);
      continue;
    }
    if (isNonAssetTileType(ttype)) {
      continue;
    }

    const cid = collectionIdOf(t, isCollectionId);
    if (cid) {
      counts.set(cid, (counts.get(cid) ?? 0) + 1);
    }

    const rawMime = String(t.Fb?.mimeType ?? t.fb?.mimeType ?? t.mimeType ?? "").toLowerCase();
    const baseKind =
      ttype === "VIDEO"
        ? "video"
        : ttype === "AUDIO" || ttype === "MUSIC" || ttype === "VOICE" || rawMime.startsWith("audio/")
          ? "audio"
          : ttype === "SCENE"
            ? "scene"
            : ttype === "CHARACTER"
              ? "character"
              : "image";
    if (baseKind === "scene") {
      sceneTiles.push(t);
    }

    const charMedia = baseKind === "character" ? characterLookMedia(t) : { url: null, primaryMediaId: null };
    const charFallbackUrl = charMedia.url;
    const charLookPrimaryMediaId = charMedia.primaryMediaId;

    const primaryMediaId =
      charLookPrimaryMediaId ||
      t.primaryMediaId ||
      t.Fb?.id ||
      t.Fb?.mediaId ||
      t.fb?.mediaId ||
      t.mediaId ||
      null;

    const histInfo = inspectMediaHistory(
      readOwn(rawTile, "history") ?? t.history,
      primaryMediaId ? String(primaryMediaId) : null,
      formatMediaError,
    );

    const videoMediaUrl =
      baseKind === "video"
        ? readMediaUrl(t.Fb, true) ||
          readMediaUrl(histInfo.primary, true) ||
          readMediaUrl(t, true) ||
          readMediaUrl(t.fb, true)
        : null;

    const primaryStatus = String(
      t.Fb?.Zc ?? histInfo.primary?.Zc ?? t.fb?.Zc ?? t.Zc ?? "",
    ).toLowerCase();
    const primaryError = formatMediaError(
      t.Fb?.nf ?? histInfo.primary?.nf ?? t.fb?.nf ?? t.nf,
    );
    const mediaNotReady =
      primaryStatus === "pending" ||
      primaryStatus === "scheduled" ||
      primaryStatus === "failed" ||
      primaryStatus === "canceled" ||
      Boolean(primaryError);

    const cachedEntry = primaryMediaId
      ? runtimeState.mediaInfoCache.get(String(primaryMediaId))
      : undefined;
    const kind =
      baseKind === "image" && cachedEntry?.media_kind === "audio"
        ? "audio"
        : baseKind;
    const cachedMediaUrl = asHttpOrDataUrl(cachedEntry?.url);

    const tileMediaUrl = baseKind === "character" && charLookPrimaryMediaId
      ? charFallbackUrl
      : videoMediaUrl ||
      readMediaUrl(t.Fb) ||
      readMediaUrl(histInfo.primary) ||
      readMediaUrl(t) ||
      readMediaUrl(t.fb) ||
      charFallbackUrl ||
      null;
    const rawMediaUrl = isSignedUrlStr(tileMediaUrl)
      ? tileMediaUrl
      : isSignedUrlStr(cachedMediaUrl)
        ? cachedMediaUrl
        : tileMediaUrl || cachedMediaUrl || null;
    const mediaUrl = mediaNotReady ? null : rawMediaUrl;
    const hasReadyPrimary = !mediaNotReady && Boolean(primaryMediaId || rawMediaUrl);
    const mediaStatus =
      hasReadyPrimary && histInfo.error
        ? primaryStatus || "success"
        : primaryStatus || histInfo.failedStatus || "";
    const mediaError = primaryError ?? histInfo.error;

    const bio =
      (ttype === "CHARACTER" ? characterPersonalityNotes(t) : null) ??
      t.personalityNotes ??
      t.Mv ??
      t.description ??
      t.Fb?.personalityNotes ??
      t.Fb?.description ??
      t.fb?.personalityNotes ??
      t.fb?.description ??
      null;

    const voiceRaw =
      (ttype === "CHARACTER" ? normalizeVoiceVal(characterVoice(t)) : null) ??
      normalizeVoiceVal(t.voiceName) ??
      normalizeVoiceVal(t.voiceId) ??
      normalizeVoiceVal(t.voice) ??
      normalizeVoiceVal(t.Vo) ??
      normalizeVoiceVal(t.Fb?.voice) ??
      normalizeVoiceVal(t.fb?.voice) ??
      normalizeVoiceVal(t.audioReferences) ??
      null;

    const { start: trimStart, end: trimEnd } = videoTrimBounds(t);

    const topEntry: Omit<SnapshotAssetItem, "collection_name"> = {
      id: tid,
      name: tname,
      kind,
      prompt: t.Fb?.prompt
        ? String(t.Fb.prompt)
        : t.fb?.prompt
          ? String(t.fb.prompt)
          : t.prompt
            ? String(t.prompt)
            : null,
      url: mediaUrl ? normalizeFlowMediaUrl(String(mediaUrl), kind, env) : null,
      collection_id: cid,
      primary_media_id: primaryMediaId ? String(primaryMediaId) : null,
      personality_notes: bio == null ? null : String(bio),
      voice: voiceRaw != null ? voiceRaw : null,
      trim_start_seconds: trimStart,
      trim_end_seconds: trimEnd,
      media_status: mediaStatus || null,
      media_error: mediaError,
      width:
        typeof t.width === "number"
          ? t.width
          : typeof t.Fb?.width === "number"
            ? t.Fb.width
            : typeof t.Fb?.tc?.width === "number"
              ? t.Fb.tc.width
              : typeof t.tc?.width === "number"
                ? t.tc.width
                : null,
      height:
        typeof t.height === "number"
          ? t.height
          : typeof t.Fb?.height === "number"
            ? t.Fb.height
            : typeof t.Fb?.tc?.height === "number"
              ? t.Fb.tc.height
              : typeof t.tc?.height === "number"
                ? t.tc.height
                : null,
      duration:
        typeof t.durationSeconds === "number"
          ? t.durationSeconds
          : typeof t.duration === "number"
            ? t.duration
            : typeof t.Fb?.durationSeconds === "number"
              ? t.Fb.durationSeconds
              : typeof t.Fb?.duration === "number"
                ? t.Fb.duration
                : typeof t.Fb?.Lf === "number"
                  ? t.Fb.Lf
                  : typeof t.Lf === "number"
                    ? t.Lf
                    : null,
      created_at:
        t.hc instanceof Date
          ? t.hc.toISOString()
          : t.hc
            ? String(t.hc)
            : t.createTime
              ? String(t.createTime)
              : null,
    };
    rawList.push(topEntry);
    byId.set(tid, topEntry);
  }

  for (const st of sceneTiles) {
    const sceneCid = collectionIdOf(st, isCollectionId);
    const { clips, history } = sceneContents(st);
    const candidates: Array<
      [string, SceneClipItem | null, FlowMediaPayload[] | null]
    > = [];
    for (const clip of clips) {
      const wfId = clip?.workflowId ? String(clip.workflowId) : null;
      if (!wfId) continue;
      const hist = history.get(wfId);
      candidates.push([wfId, clip, Array.isArray(hist) ? hist : null]);
    }
    for (const [wfId, hist] of history) {
      candidates.push([wfId, null, Array.isArray(hist) ? hist : null]);
    }

    for (const [wfId, clip, rawHist] of candidates) {
      if (!wfId) continue;
      const primaryId = clip?.primaryMediaId
        ? String(clip.primaryMediaId)
        : null;
      const histInfo = inspectMediaHistory(rawHist, primaryId, formatMediaError);
      const mObj = histInfo.primary;
      const cObj = legacyMedia(clip as FlowMediaPayload | null);
      const primaryStatus = String(
        mObj?.Zc ?? cObj?.Zc ?? clip?.Zc ?? "",
      ).toLowerCase();
      const primaryError = formatMediaError(mObj?.nf ?? cObj?.nf ?? clip?.nf);
      const mNotReady =
        primaryStatus === "pending" ||
        primaryStatus === "scheduled" ||
        primaryStatus === "failed" ||
        primaryStatus === "canceled" ||
        Boolean(primaryError);
      const mError = primaryError ?? histInfo.error;
      const existing = byId.get(wfId);
      if (existing) {
        if (
          primaryStatus === "failed" ||
          primaryStatus === "canceled" ||
          Boolean(mError)
        ) {
          const existingReady =
            existing.media_status === "success" || Boolean(existing.url);
          if (
            !existingReady &&
            existing.media_status !== "failed" &&
            existing.media_status !== "canceled"
          ) {
            existing.media_status =
              primaryStatus || histInfo.failedStatus || existing.media_status;
          } else if (existingReady && !existing.media_status) {
            existing.media_status = "success";
          }
          if (
            mError &&
            (!existing.media_error ||
              mError.length > existing.media_error.length)
          ) {
            existing.media_error = mError;
          }
        }
        continue;
      }
      const clipPrimaryMediaId = clip?.primaryMediaId
        ? String(clip.primaryMediaId)
        : mObj?.id
          ? String(mObj.id)
          : null;
      const cachedClipVideoUrl = clipPrimaryMediaId
        ? asHttpOrDataUrl(
            runtimeState.mediaInfoCache.get(clipPrimaryMediaId)?.url,
          )
        : null;
      const tileClipUrl =
        readMediaUrl(mObj, true) ||
        readMediaUrl(clip, true) ||
        readMediaUrl(mObj) ||
        readMediaUrl(clip) ||
        null;
      const rawClipUrl = isSignedUrlStr(tileClipUrl)
        ? tileClipUrl
        : isSignedUrlStr(cachedClipVideoUrl)
           ? cachedClipVideoUrl
          : tileClipUrl || cachedClipVideoUrl || null;
      const clipUrl = mNotReady ? null : rawClipUrl;
      const hasReadyClip = !mNotReady && Boolean(clipPrimaryMediaId || rawClipUrl);
      const mStatus =
        hasReadyClip && histInfo.error
          ? primaryStatus || "success"
          : primaryStatus || histInfo.failedStatus || "";
      const trimStartVal =
        typeof clip?.Ji === "number" ? clip.Ji :
        typeof mObj?.Jc === "number" ? mObj.Jc :
        typeof mObj?.Ac === "number"
          ? mObj.Ac
          : typeof mObj?.Cg === "number"
            ? mObj.Cg
            : typeof clip?.Mh === "number"
              ? clip.Mh
              : null;
      const trimEndVal =
        typeof clip?.Ci === "number" ? clip.Ci :
        typeof mObj?.Pc === "number" ? mObj.Pc :
        typeof mObj?.Ic === "number"
          ? mObj.Ic
          : typeof mObj?.Rf === "number"
            ? mObj.Rf
            : typeof clip?.Eh === "number"
              ? clip.Eh
              : null;
      const durVal =
        typeof clip?.nc === "number" ? clip.nc :
        typeof clip?.rc === "number"
          ? clip.rc
          : typeof mObj?.durationSeconds === "number"
            ? mObj.durationSeconds
            : typeof mObj?.duration === "number"
              ? mObj.duration
              : typeof mObj?.Lf === "number"
                ? mObj.Lf
                : null;
      const clipPrompt = mObj?.prompt
        ? String(mObj.prompt)
        : mObj?.inputs?.prompt
          ? String(mObj.inputs.prompt)
          : null;
      const clipCreated =
        mObj?.hc instanceof Date
          ? mObj.hc.toISOString()
          : mObj?.hc
            ? String(mObj.hc)
            : st.hc instanceof Date
              ? st.hc.toISOString()
              : st.hc
                ? String(st.hc)
                : null;
      const sceneEntry: Omit<SnapshotAssetItem, "collection_name"> = {
        id: wfId,
        name: String((mObj as FlowTile | null)?.displayName || st.displayName || ""),
        kind: "video",
        prompt: clipPrompt,
        url: clipUrl ? normalizeFlowMediaUrl(String(clipUrl), "video", env) : null,
        collection_id: sceneCid,
        primary_media_id: clipPrimaryMediaId,
        personality_notes: null,
        voice: null,
        trim_start_seconds: trimStartVal,
        trim_end_seconds: trimEndVal,
        media_status: mStatus || null,
        media_error: mError,
        width:
          typeof mObj?.width === "number"
            ? mObj.width
            : typeof mObj?.tc?.width === "number"
              ? mObj.tc.width
              : null,
        height:
          typeof mObj?.height === "number"
            ? mObj.height
            : typeof mObj?.tc?.height === "number"
              ? mObj.tc.height
              : null,
        duration: durVal,
        created_at: clipCreated,
      };
      rawList.push(sceneEntry);
      byId.set(wfId, sceneEntry);
    }
  }

  const assets: SnapshotAssetItem[] = rawList.map((a) => ({
    ...a,
    collection_name: a.collection_id
      ? (cols.get(a.collection_id) ?? null)
      : null,
  }));

  const collections: SnapshotCollectionItem[] = [];
  for (const [cid, cname] of cols.entries()) {
    collections.push({
      id: cid,
      name: cname,
      count: counts.get(cid) ?? 0,
    });
  }

  return { assets, collections };
}
