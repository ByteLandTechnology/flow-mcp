// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Extract saved custom voices from PROJECT_TILES and map look-less character voices.

import { readOwn } from "./angular";
import { asHttpOrDataUrl, isExpiredSignedUrl, normalizeFlowMediaUrl } from "./dom";
import { snapshotFormat } from "./frontend_builds";
import { runtimeState } from "./state";
import type { CustomVoiceItem, FifeEnv, FlowTile, SnapshotAssetItem } from "./types";

/** Reads a 1-based field from a dense or sparse serialized JSPB array. */
function voiceProtoField(msg: unknown, field: number): unknown {
  if (!Array.isArray(msg) || field < 1) return undefined;
  const tail: unknown = msg[msg.length - 1];
  if (tail && typeof tail === "object" && !Array.isArray(tail)) {
    const mapped = readOwn(tail, String(field));
    if (mapped !== undefined) return mapped;
  }
  return msg[field - 1];
}

/** Iterates values from a `Map`, array, or plain record. */
function mapValues(source: unknown): unknown[] {
  if (source instanceof Map) return Array.from(source.values());
  if (Array.isArray(source)) return source;
  if (source && typeof source === "object") return Object.values(source);
  return [];
}

/** Builds a workflow and tile display-name lookup map from `lr` and `rowsField`. */
function buildVoiceNameMap(data: unknown, rowsField: string): Map<string, string> {
  const names = new Map<string, string>();
  const register = (key: unknown, title: unknown): void => {
    if (typeof key !== "string" || typeof title !== "string") return;
    const cleanKey = key.trim();
    const cleanTitle = title.trim();
    if (!cleanKey || !cleanTitle) return;
    names.set(cleanKey, cleanTitle);
    names.set(cleanKey.replace(/^(?:media|workflows)\//i, ""), cleanTitle);
  };

  const rows = readOwn(data, rowsField);
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const displayName = readOwn(row, "displayName");
      register(readOwn(row, "id"), displayName);
      register(readOwn(row, "workflowId"), displayName);
      register(readOwn(row, "primaryMediaId"), displayName);
    }
  }

  const lr = readOwn(data, "lr");
  const lrEntries: Array<[unknown, unknown]> =
    lr instanceof Map
      ? Array.from(lr.entries())
      : lr && typeof lr === "object" && !Array.isArray(lr)
        ? Object.entries(lr)
        : [];
  for (const [wfKey, wfVal] of lrEntries) {
    let wfId: unknown = wfKey;
    let wfTitle: unknown = readOwn(wfVal, "displayName") ?? readOwn(wfVal, "name");
    const getNameFn = readOwn(wfVal, "getName");
    if (typeof getNameFn === "function") {
      try {
        wfId = getNameFn.call(wfVal) ?? wfId;
      } catch {
        // Keep map key fallback.
      }
    }
    const getMetaFn = readOwn(wfVal, "getMetadata");
    if (!wfTitle && typeof getMetaFn === "function") {
      try {
        const meta: unknown = getMetaFn.call(wfVal);
        const qdFn = readOwn(meta, "Qd");
        if (typeof qdFn === "function") {
          wfTitle = qdFn.call(meta);
        }
      } catch {
        // Fall through to serialized JSON check.
      }
    }
    const toJsonFn = readOwn(wfVal, "toJSON");
    if (!wfTitle && typeof toJsonFn === "function") {
      try {
        const rawWf: unknown = toJsonFn.call(wfVal);
        wfId = voiceProtoField(rawWf, 1) ?? wfId;
        const rawMeta = voiceProtoField(rawWf, 4) ?? voiceProtoField(rawWf, 3);
        wfTitle = voiceProtoField(rawMeta, 1);
      } catch {
        // Ignore malformed workflow entry.
      }
    }
    register(wfId, wfTitle);
  }
  return names;
}

/** Extracts saved custom voices from `cj` and `lr` on settled `PROJECT_TILES` query data. */
export function readCustomVoicesFromQueryData(
  data: unknown,
  rowsField: string,
): CustomVoiceItem[] {
  if (!data || typeof data !== "object") return [];
  const cj = readOwn(data, "cj");
  const candidates = mapValues(cj);
  if (candidates.length === 0) return [];

  const nameMap = buildVoiceNameMap(data, rowsField);
  const frontEnd = readOwn(window, "default_AiSandboxAngularFrontend");
  const hUbFn = readOwn(frontEnd, "hUb");
  const fvFn = readOwn(frontEnd, "fv");
  const brOneof = readOwn(frontEnd, "Br");

  const out: CustomVoiceItem[] = [];
  const seen = new Set<string>();
  const lookupTitle = (wfId: string | null, mediaId: string): string | null => {
    if (wfId) {
      const hit = nameMap.get(wfId) ?? nameMap.get(wfId.replace(/^workflows\//i, ""));
      if (hit) return hit;
    }
    return nameMap.get(mediaId) ?? nameMap.get(mediaId.replace(/^media\//i, "")) ?? null;
  };

  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;

    if (
      typeof hUbFn === "function" &&
      typeof fvFn === "function" &&
      Array.isArray(brOneof)
    ) {
      try {
        const isAudio = Boolean(
          (fvFn as (msg: unknown, field: number, oneof: unknown[]) => unknown).call(
            frontEnd,
            item,
            11,
            brOneof,
          ),
        );
        if (!isAudio) continue;
        const mapped = (
          hUbFn as (msg: unknown, names: Map<string, string>) => Record<string, unknown> | undefined
        ).call(frontEnd, item, nameMap);
        if (!mapped || mapped.Rv === true || mapped.Db === true) continue;
        const rawId = String(mapped.id ?? mapped.workflowId ?? mapped.mediaId ?? "").trim();
        if (!rawId || /^voices\//i.test(rawId)) continue;
        const mediaId = String(mapped.mediaId ?? rawId)
          .trim()
          .replace(/^(?:media|workflows)\//i, "");
        if (!mediaId || seen.has(mediaId)) continue;
        seen.add(mediaId);
        const wfId =
          typeof mapped.workflowId === "string" && mapped.workflowId.trim()
            ? mapped.workflowId.trim()
            : null;
        const assetId = rawId.replace(/^(?:media|workflows)\//i, "") || mediaId;
        const prompt =
          typeof mapped.description === "string" && mapped.description.trim()
            ? mapped.description.trim()
            : typeof mapped.f7 === "string" && mapped.f7.trim()
              ? mapped.f7.trim()
              : null;
        const rawUrl = typeof mapped.NU === "string" ? mapped.NU.trim() : "";
        const created =
          mapped.rm instanceof Date && mapped.rm.getTime() > 0
            ? mapped.rm.toISOString()
            : null;
        out.push({
          id: assetId,
          name:
            (typeof mapped.title === "string" && mapped.title.trim()) ||
            lookupTitle(wfId, mediaId) ||
            "Custom voice",
          mediaId,
          workflowId: wfId,
          prompt,
          url: /^https?:\/\//i.test(rawUrl) ? rawUrl : null,
          createdAt: created,
        });
        continue;
      } catch {
        // Fall through to structural JSPB and plain-object inspection.
      }
    }

    const toJsonFn = readOwn(item, "toJSON");
    const serialized: unknown =
      typeof toJsonFn === "function"
        ? (() => {
            try {
              return toJsonFn.call(item);
            } catch {
              return null;
            }
          })()
        : Array.isArray(item)
          ? item
          : null;

    if (Array.isArray(serialized)) {
      const audioBranch = voiceProtoField(serialized, 11);
      if (!audioBranch || typeof audioBranch !== "object") continue;
      const audioInner = Array.isArray(audioBranch)
        ? (voiceProtoField(audioBranch, 1) ?? audioBranch)
        : (readOwn(audioBranch, "1") ?? audioBranch);
      if (voiceProtoField(audioInner, 3) === true) continue;
      const rawName = voiceProtoField(serialized, 1);
      if (typeof rawName !== "string" || !rawName.trim() || /^voices\//i.test(rawName.trim())) {
        continue;
      }
      const mediaId = rawName.trim().replace(/^media\//i, "");
      if (!mediaId || seen.has(mediaId)) continue;
      const meta =
        voiceProtoField(serialized, 4) ??
        voiceProtoField(serialized, 5) ??
        voiceProtoField(serialized, 6);
      if (voiceProtoField(meta, 4) === true) continue;
      seen.add(mediaId);
      const wfRaw = voiceProtoField(serialized, 3);
      const wfId = typeof wfRaw === "string" && wfRaw.trim() ? wfRaw.trim() : null;
      const metaTitle = voiceProtoField(meta, 2);
      const audioName = voiceProtoField(audioInner, 1);
      const title =
        (typeof metaTitle === "string" && metaTitle.trim()) ||
        (typeof audioName === "string" && audioName.trim()) ||
        lookupTitle(wfId, mediaId) ||
        "Custom voice";
      const desc =
        voiceProtoField(audioInner, 8) ??
        voiceProtoField(audioInner, 2) ??
        voiceProtoField(audioInner, 5);
      const urlCand = voiceProtoField(audioInner, 4) ?? voiceProtoField(audioInner, 6);
      out.push({
        id: mediaId,
        name: title,
        mediaId,
        workflowId: wfId,
        prompt: typeof desc === "string" && desc.trim() ? desc.trim() : null,
        url:
          typeof urlCand === "string" && /^https?:\/\//i.test(urlCand.trim())
            ? urlCand.trim()
            : null,
        createdAt: null,
      });
      continue;
    }

    if (readOwn(item, "Rv") === true || readOwn(item, "Db") === true || readOwn(item, "trashed") === true) {
      continue;
    }
    const kindHint = String(readOwn(item, "type") ?? readOwn(item, "kind") ?? "").toUpperCase();
    const hasAudioField =
      kindHint === "VOICE" ||
      kindHint === "AUDIO" ||
      readOwn(item, "audio") != null ||
      typeof readOwn(item, "NU") === "string";
    if (!hasAudioField) continue;
    const rawId = String(readOwn(item, "mediaId") ?? readOwn(item, "id") ?? "").trim();
    if (!rawId || /^voices\//i.test(rawId)) continue;
    const mediaId = rawId.replace(/^media\//i, "");
    if (!mediaId || seen.has(mediaId)) continue;
    seen.add(mediaId);
    const wfRaw = readOwn(item, "workflowId");
    const wfId = typeof wfRaw === "string" && wfRaw.trim() ? wfRaw.trim() : null;
    const rawTitle = readOwn(item, "title") ?? readOwn(item, "displayName") ?? readOwn(item, "name");
    const rawPrompt = readOwn(item, "description") ?? readOwn(item, "prompt") ?? readOwn(item, "f7");
    const rawUrl = readOwn(item, "NU") ?? readOwn(item, "url");
    const rawCreated = readOwn(item, "rm") ?? readOwn(item, "createdAt") ?? readOwn(item, "createTime");
    out.push({
      id: mediaId,
      name:
        (typeof rawTitle === "string" && rawTitle.trim()) ||
        lookupTitle(wfId, mediaId) ||
        "Custom voice",
      mediaId,
      workflowId: wfId,
      prompt: typeof rawPrompt === "string" && rawPrompt.trim() ? rawPrompt.trim() : null,
      url:
        typeof rawUrl === "string" && /^https?:\/\//i.test(rawUrl.trim())
          ? rawUrl.trim()
          : null,
      createdAt:
        rawCreated instanceof Date
          ? rawCreated.toISOString()
          : typeof rawCreated === "string" && rawCreated.trim()
            ? rawCreated.trim()
            : null,
    });
  }

  return out;
}

/** Extracts the assigned custom or preset voice ID from a character tile when present. */
export function characterAssignedVoiceId(t: FlowTile): string | null {
  const format = snapshotFormat()?.character;
  const entity = readOwn(t, format?.entity ?? "Rc");
  const serialize = readOwn(entity, "toJSON");
  if (typeof serialize === "function") {
    try {
      const root: unknown = serialize.call(entity);
      const info = voiceProtoField(
        voiceProtoField(root, format?.entityInfoField ?? 4),
        format?.characterInfoField ?? 3,
      );
      const refs = voiceProtoField(info, format?.audioReferencesField ?? 2);
      if (Array.isArray(refs) && refs.length > 0) {
        const first: unknown = refs[0];
        const custom = voiceProtoField(first, format?.customVoiceField ?? 1);
        if (typeof custom === "string" && custom.trim()) {
          return custom.trim().replace(/^media\//i, "");
        }
        const preset = voiceProtoField(first, format?.presetVoiceField ?? 2);
        if (typeof preset === "string" && preset.trim()) {
          return preset.trim();
        }
      }
    } catch {
      // Fall through to plain tile voice fields.
    }
  }
  for (const cand of [t.voiceId, t.Vo, t.voice]) {
    if (typeof cand === "string" && cand.trim()) {
      return cand.trim().replace(/^media\//i, "");
    }
    if (cand && typeof cand === "object" && !Array.isArray(cand)) {
      const nested =
        readOwn(cand, "mediaId") ??
        readOwn(cand, "voiceId") ??
        readOwn(cand, "id");
      if (typeof nested === "string" && nested.trim()) {
        return nested.trim().replace(/^media\//i, "");
      }
    }
  }
  return null;
}

/** Resolves a look-less character's assigned voice against `customVoices`. */
export function resolveLooklessCharacterVoice(
  tile: FlowTile,
  lookUrl: string | null,
  lookPrimaryMediaId: string | null,
  customVoices: CustomVoiceItem[],
): {
  url: string | null;
  primaryMediaId: string | null;
  isVoice: boolean;
  pcmAudio: boolean;
} {
  const nonExpired = (raw: unknown): string | null => {
    const direct = asHttpOrDataUrl(raw);
    return direct && !isExpiredSignedUrl(direct) ? direct : null;
  };
  if (lookUrl || lookPrimaryMediaId) {
    return {
      url: nonExpired(lookUrl),
      primaryMediaId: lookPrimaryMediaId,
      isVoice: false,
      pcmAudio: false,
    };
  }
  const rawRef = characterAssignedVoiceId(tile);
  if (!rawRef) {
    return { url: null, primaryMediaId: null, isVoice: false, pcmAudio: false };
  }
  const cleanRef = rawRef.replace(/^(?:media|workflows)\//i, "");
  const matched = customVoices.find(
    (v) =>
      v.id === rawRef ||
      v.id === cleanRef ||
      v.mediaId === cleanRef ||
      (v.workflowId !== null &&
        (v.workflowId === rawRef ||
          v.workflowId.replace(/^workflows\//i, "") === cleanRef)),
  );
  return {
    url: nonExpired(matched?.url),
    primaryMediaId: matched ? matched.mediaId : rawRef,
    isVoice: true,
    pcmAudio: Boolean(matched),
  };
}

/** Appends saved custom voices that do not collide with existing tile or workflow IDs. */
export function appendCustomVoiceAssets(
  customVoices: CustomVoiceItem[],
  byId: Map<string, Omit<SnapshotAssetItem, "collection_name">>,
  rawList: Array<Omit<SnapshotAssetItem, "collection_name">>,
  env: FifeEnv,
): void {
  const nonExpired = (raw: unknown): string | null => {
    const direct = asHttpOrDataUrl(raw);
    return direct && !isExpiredSignedUrl(direct) ? direct : null;
  };
  const isSignedUrlStr = (url: string | null): url is string => {
    if (url === null) return false;
    try {
      return env.isSignedCdnHost(new URL(url));
    } catch {
      return false;
    }
  };

  for (const voice of customVoices) {
    if (!voice.id || byId.has(voice.id)) continue;
    if (voice.workflowId && byId.has(voice.workflowId)) continue;
    const cachedVoice = runtimeState.mediaInfoCache.get(voice.mediaId);
    const directVoiceUrl = nonExpired(voice.url);
    const cachedVoiceUrl = nonExpired(cachedVoice?.url);
    const rawVoiceUrl = isSignedUrlStr(directVoiceUrl)
      ? directVoiceUrl
      : isSignedUrlStr(cachedVoiceUrl)
        ? cachedVoiceUrl
        : directVoiceUrl || cachedVoiceUrl || null;
    const voiceMediaIds = voice.mediaId ? [voice.mediaId] : [];
    const voiceEntry: Omit<SnapshotAssetItem, "collection_name"> = {
      id: voice.id,
      name: voice.name,
      kind: "audio",
      prompt: voice.prompt,
      url: rawVoiceUrl ? normalizeFlowMediaUrl(rawVoiceUrl, "audio", env) : null,
      collection_id: null,
      primary_media_id: voice.mediaId,
      personality_notes: null,
      voice: voice.name,
      trim_start_seconds: null,
      trim_end_seconds: null,
      media_status: "success",
      media_error: null,
      width: null,
      height: null,
      duration: null,
      created_at: voice.createdAt,
      media_ids: voiceMediaIds,
      workflow_id: voice.workflowId,
      pcm_audio: true,
      media_kind: "audio",
    };
    rawList.push(voiceEntry);
    byId.set(voice.id, voiceEntry);
  }
}
