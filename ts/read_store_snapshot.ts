// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read all project tiles, scene clips, and collections from the bound store map.

import { characterPersonalityNotes } from "./character_bio";
import { sceneContents } from "./scene_tiles";

import {
  characterLooksOf,
  collectionIdOf,
  fifeEnv as getFifeEnv,
  isTrashedTile,
  legacyMedia,
  legacyTile,
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
  const match = /\/project\/([^/?#]+)/.exec(location.pathname || "");
  const projectId = match ? match[1] : null;
  const helper = runtimeState.store;
  const l = runtimeState.lService;
  if (
    (helper || l) &&
    (runtimeState.routePath !== location.pathname ||
      l?.Ca?.Va ||
      l?._ap?.Ca?.Va ||
      l?.ha?.Ca?.Va)
  ) {
    clearStore();
    return { ok: false, error: "route_changed" };
  }
  if (typeof helper?.isReady === "function" && !helper.isReady()) {
    return { ok: false, error: "store_loading" };
  }
  const tileMap = helper?.getTileMap?.();
  if (!(tileMap instanceof Map)) {
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

  let credits: number | null = null;
  const creditNodes = document.querySelectorAll(
    'header, nav, [class*="credit"], [aria-label*="credit" i]',
  );
  for (const node of creditNodes) {
    const txt = node.textContent || "";
    const credMatch = txt.match(/(\d[\d,]*)\s*(?:credits|AI credits)/i);
    if (credMatch) {
      credits = parseInt(credMatch[1].replace(/,/g, ""), 10);
      break;
    }
  }

  return { ok: true, projectId, projectTitle, credits, assets, collections };
}

/** Reads asset and collection details from the tile map. */
export function readStoreTiles(tileMap: Map<string, FlowTile>): {
  assets: SnapshotAssetItem[];
  collections: SnapshotCollectionItem[];
} {
  const cols = new Map<string, string>();
  const counts = new Map<string, number>();
  const topLevelIds = new Set<string>();
  const sceneTiles: FlowTile[] = [];
  const rawList: Omit<SnapshotAssetItem, "collection_name">[] = [];
  const asHttpOrDataUrl = (v: unknown): string | null =>
    typeof v === "string" && /^(?:https?:|blob:|data:)/i.test(v) ? v : null;
  const env = getFifeEnv();
  const fifeHost = env.fifeHost || "flow.google.com";
  const authuser = env.authuser || null;

  const normalizeFlowMediaUrl = (u: string, kind: string): string => {
    if (typeof u !== "string" || !/^https?:\/\//i.test(u)) return u;
    try {
      const parsed = new URL(u);
      const host = parsed.hostname.toLowerCase();
      const signed = env.isSignedCdnHost(parsed);
      if (signed || !parsed.pathname.startsWith("/asb/")) {
        return u;
      }
      if (
        host.endsWith(".googleusercontent.com") ||
        host.endsWith(".fife.usercontent.google.com") ||
        host === fifeHost.toLowerCase()
      ) {
        parsed.hostname = fifeHost;
        if (kind === "video" && !/=[^/]+$/.test(parsed.pathname)) {
          parsed.pathname = `${parsed.pathname}=mm,22,15`;
        }
        if (authuser) {
          parsed.searchParams.set("authuser", authuser);
        }
        return parsed.toString();
      }
      return u;
    } catch {
      return u;
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
    if (String(rawTile?.type ?? "").toUpperCase() === "COLLECTION") {
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
    if (t.isPending === true && (ttype === "COLLECTION" || ttype === "SCENE")) {
      continue;
    }
    const cid = collectionIdOf(t, isCollectionId);

    if (ttype === "COLLECTION") {
      cols.set(tid, tname);
      if (!counts.has(tid)) counts.set(tid, 0);
      continue;
    }

    topLevelIds.add(tid);
    if (cid) {
      counts.set(cid, (counts.get(cid) ?? 0) + 1);
    }

    const kind =
      ttype === "VIDEO"
        ? "video"
        : ttype === "SCENE"
          ? "scene"
          : ttype === "CHARACTER"
            ? "character"
            : "image";
    if (kind === "scene") {
      sceneTiles.push(t);
    }

    let charFallbackUrl: string | null = null;
    let charLookPrimaryMediaId: string | number | null = null;
    if (kind === "character") {
      charFallbackUrl = asHttpOrDataUrl(t.ue);
      const looks = characterLooksOf(t);
      if (looks) {
        for (const entry of looks.values()) {
          if (!entry) continue;
          if (!charLookPrimaryMediaId && entry.primaryMediaId) {
            charLookPrimaryMediaId = entry.primaryMediaId;
          }
          if (!charFallbackUrl) {
            charFallbackUrl =
              asHttpOrDataUrl(entry.Wb) ||
              asHttpOrDataUrl(entry.kc) ||
              asHttpOrDataUrl(entry.fifeUrl) ||
              asHttpOrDataUrl(entry.imageUrl) ||
              asHttpOrDataUrl(entry.url) ||
              asHttpOrDataUrl(entry.media?.Wb) ||
              asHttpOrDataUrl(entry.media?.kc) ||
              asHttpOrDataUrl(entry.media?.fifeUrl) ||
              asHttpOrDataUrl(entry.media?.url);
          }
          if (!charFallbackUrl && Array.isArray(entry.history)) {
            for (const h of entry.history) {
              charFallbackUrl =
                asHttpOrDataUrl(h?.Wb) ||
                asHttpOrDataUrl(h?.kc) ||
                asHttpOrDataUrl(h?.fifeUrl) ||
                asHttpOrDataUrl(h?.imageUrl) ||
                asHttpOrDataUrl(h?.url) ||
                asHttpOrDataUrl(h?.media?.Wb) ||
                asHttpOrDataUrl(h?.media?.kc) ||
                asHttpOrDataUrl(h?.media?.fifeUrl) ||
                asHttpOrDataUrl(h?.media?.url);
              if (charFallbackUrl) break;
            }
          }
          if (charFallbackUrl && charLookPrimaryMediaId) break;
        }
      }
    }

    const videoMediaUrl =
      kind === "video"
        ? asHttpOrDataUrl(t.Fb?.Bd) ||
          asHttpOrDataUrl(t.Fb?.uA) ||
          asHttpOrDataUrl(t.Fb?.videoUrl) ||
          asHttpOrDataUrl(t.Bd) ||
          asHttpOrDataUrl(t.uA) ||
          asHttpOrDataUrl(t.videoUrl) ||
          asHttpOrDataUrl(t.fb?.Bd) ||
          asHttpOrDataUrl(t.fb?.uA) ||
          asHttpOrDataUrl(t.fb?.videoUrl)
        : null;

    const mediaStatus = String(t.Fb?.Zc ?? t.fb?.Zc ?? t.Zc ?? "").toLowerCase();
    const mediaError = formatMediaError(t.Fb?.nf ?? t.fb?.nf ?? t.nf);
    const mediaNotReady =
      mediaStatus === "pending" ||
      mediaStatus === "scheduled" ||
      mediaStatus === "failed" ||
      mediaStatus === "canceled" ||
      Boolean(t.Fb?.nf || t.fb?.nf || t.nf);

    const primaryMediaId =
      t.primaryMediaId ||
      t.Fb?.id ||
      t.Fb?.mediaId ||
      t.fb?.mediaId ||
      t.mediaId ||
      (kind === "character" ? charLookPrimaryMediaId : null) ||
      null;

    const cachedVideoUrl =
      kind === "video" && primaryMediaId
        ? asHttpOrDataUrl(
            runtimeState.mediaInfoCache.get(String(primaryMediaId))?.url,
          )
        : null;

    const rawMediaUrl =
      videoMediaUrl ||
      asHttpOrDataUrl(t.Fb?.Wb) ||
      asHttpOrDataUrl(t.Fb?.kc) ||
      t.Fb?.fifeUrl ||
      t.Fb?.videoUrl ||
      t.Fb?.imageUrl ||
      t.Fb?.mediaUrl ||
      t.Fb?.url ||
      asHttpOrDataUrl(t.Wb) ||
      asHttpOrDataUrl(t.kc) ||
      t.fifeUrl ||
      t.videoUrl ||
      t.imageUrl ||
      t.mediaUrl ||
      t.url ||
      asHttpOrDataUrl(t.fb?.Wb) ||
      asHttpOrDataUrl(t.fb?.kc) ||
      t.fb?.fifeUrl ||
      t.fb?.videoUrl ||
      t.fb?.imageUrl ||
      t.fb?.mediaUrl ||
      charFallbackUrl ||
      cachedVideoUrl ||
      null;
    const mediaUrl = mediaNotReady ? null : rawMediaUrl;

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
      normalizeVoiceVal(t.voiceName) ??
      normalizeVoiceVal(t.voiceId) ??
      normalizeVoiceVal(t.voice) ??
      normalizeVoiceVal(t.Vo) ??
      normalizeVoiceVal(t.Fb?.voice) ??
      normalizeVoiceVal(t.fb?.voice) ??
      normalizeVoiceVal(t.audioReferences) ??
      null;

    const trimStart =
      kind === "video" && typeof t.Fb?.Jc === "number" ? t.Fb.Jc :
      typeof t.trimStartSeconds === "number"
        ? t.trimStartSeconds
        : typeof t.Fb?.Ac === "number"
          ? t.Fb.Ac
          : typeof t.Ac === "number"
            ? t.Ac
            : typeof t.Cg === "number"
              ? t.Cg
              : typeof t.Fb?.Cg === "number"
                ? t.Fb.Cg
                : null;
    const trimEnd =
      kind === "video" && typeof t.Fb?.Pc === "number" ? t.Fb.Pc :
      typeof t.trimEndSeconds === "number"
        ? t.trimEndSeconds
        : typeof t.Fb?.Ic === "number"
          ? t.Fb.Ic
          : typeof t.Ic === "number"
            ? t.Ic
            : typeof t.Rf === "number"
              ? t.Rf
              : typeof t.Fb?.Rf === "number"
                ? t.Fb.Rf
                : null;

    rawList.push({
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
      url: mediaUrl ? normalizeFlowMediaUrl(String(mediaUrl), kind) : null,
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
    });
  }

  for (const st of sceneTiles) {
    const sceneCid = collectionIdOf(st, isCollectionId);
    const { clips, history } = sceneContents(st);
    const candidates: Array<
      [string, SceneClipItem | null, FlowMediaPayload | null]
    > = [];
    for (const clip of clips) {
      const wfId = clip?.workflowId ? String(clip.workflowId) : null;
      if (!wfId) continue;
      const hist = history.get(wfId);
      const primaryId = clip?.primaryMediaId
        ? String(clip.primaryMediaId)
        : null;
      const mObj = Array.isArray(hist)
        ? hist.find((x) => x && String(x.id || "") === primaryId) ||
          hist[0] ||
          null
        : null;
      candidates.push([wfId, clip, mObj]);
    }
    for (const [wfId, hist] of history) {
      const mObj = Array.isArray(hist) ? hist[0] || null : null;
      candidates.push([wfId, null, mObj]);
    }

    for (const [wfId, clip, rawMedia] of candidates) {
      const mObj = legacyMedia(rawMedia);
      if (!wfId || topLevelIds.has(wfId)) continue;
      topLevelIds.add(wfId);
      const mStatus = String(mObj?.Zc ?? clip?.Zc ?? "").toLowerCase();
      const mError = formatMediaError(mObj?.nf ?? clip?.nf);
      const mNotReady =
        mStatus === "pending" ||
        mStatus === "scheduled" ||
        mStatus === "failed" ||
        mStatus === "canceled" ||
        Boolean(mObj?.nf || clip?.nf);
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
      const rawClipUrl =
        asHttpOrDataUrl(mObj?.Bd) ||
        asHttpOrDataUrl(mObj?.uA) ||
        asHttpOrDataUrl(mObj?.videoUrl) ||
        asHttpOrDataUrl(mObj?.Wb) ||
        asHttpOrDataUrl(mObj?.kc) ||
        asHttpOrDataUrl(mObj?.fifeUrl) ||
        asHttpOrDataUrl(mObj?.mediaUrl) ||
        asHttpOrDataUrl(mObj?.url) ||
        asHttpOrDataUrl(clip?.Bd) ||
        asHttpOrDataUrl(clip?.uA) ||
        asHttpOrDataUrl(clip?.videoUrl) ||
        asHttpOrDataUrl(clip?.Wb) ||
        asHttpOrDataUrl(clip?.kc) ||
        asHttpOrDataUrl(clip?.fifeUrl) ||
        cachedClipVideoUrl ||
        null;
      const clipUrl = mNotReady ? null : rawClipUrl;
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
      rawList.push({
        id: wfId,
        name: String((mObj as FlowTile | null)?.displayName || st.displayName || ""),
        kind: "video",
        prompt: clipPrompt,
        url: clipUrl ? normalizeFlowMediaUrl(String(clipUrl), "video") : null,
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
      });
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
