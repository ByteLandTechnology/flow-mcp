// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Resolve stream and download media URLs via TanStack queryCache, native Flow services, and sparse JSPB fallback.

import { readOwn } from "./angular";
import { characterLooksOf, fifeEnv as getFifeEnv, isExpiredSignedUrl, legacyTile } from "./dom";
import { frontendBuild, readBuildLabel } from "./frontend_builds";
import {
  bindMediaResolver,
  findActiveQueryCaches,
  mediaResolverCompatibility,
} from "./frontend_compatibility";
import type {
  MediaResolverBinding,
  TanStackQueryCache,
  TanStackQueryEntry,
} from "./frontend_compatibility";
import { waitForMedia } from "./project_upload";
import { runtimeState } from "./state";
import type { CachedMediaInfo, FlowTile, ResolvedMediaResult } from "./types";

/** Internal extraction accumulator that ranks signed URLs ahead of unsigned FIFE URLs. */
interface MediaExtractState {
  /** Preferred signed streaming URL. */
  signedStreamUrl: string | null;
  /** Preferred signed download URL. */
  signedDownloadUrl: string | null;
  /** Preferred unsigned FIFE streaming URL. */
  unsignedStreamUrl: string | null;
  /** Preferred unsigned FIFE download URL. */
  unsignedDownloadUrl: string | null;
  /** Ordered list of unique signed URL candidates. */
  signedCandidates: string[];
  /** Ordered list of unique unsigned URL candidates. */
  unsignedCandidates: string[];
  /** Raw unsigned FIFE URLs eligible for native `NJ` registration. */
  rawUnsignedFife: string[];
}

/** Creates an empty media URL extraction accumulator. */
function emptyExtractState(): MediaExtractState {
  return {
    signedStreamUrl: null,
    signedDownloadUrl: null,
    unsignedStreamUrl: null,
    unsignedDownloadUrl: null,
    signedCandidates: [],
    unsignedCandidates: [],
    rawUnsignedFife: [],
  };
}

/** Returns true when `state` holds at least one resolved URL candidate. */
function hasCandidates(state: MediaExtractState): boolean {
  return state.signedCandidates.length > 0 || state.unsignedCandidates.length > 0;
}

/** Appends `url` to `list` when non-null and not already present. */
function pushUnique(list: string[], url: string | null): void {
  if (url && !list.includes(url)) {
    list.push(url);
  }
}

/** Normalizes `rawUrl` into a validated HTTP(S) URL string, or returns null. */
function asDirectUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    return new URL(trimmed).toString();
  } catch {
    return null;
  }
}

/** Unwraps a Closure JSPB message instance or returns `msg` when it is already an array. */
function unwrapJspbArray(msg: unknown): readonly unknown[] | null {
  if (Array.isArray(msg)) return msg;
  if (!msg || typeof msg !== "object" || msg instanceof Map || msg instanceof Set) {
    return null;
  }
  const qf = readOwn(msg, "qf");
  if (Array.isArray(qf)) return qf;
  for (const key of Object.keys(msg)) {
    const val = readOwn(msg, key);
    if (Array.isArray(val)) return val;
  }
  return null;
}

/** Returns true when `val` is a plain trailing JSPB sparse field dictionary. */
function isPlainSparseMap(val: unknown): val is Record<string, unknown> {
  if (!val || typeof val !== "object" || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

/** Reads a 1-based protobuf field from a dense JSPB array or its trailing sparse map. */
function protoField(msg: unknown, fieldNum: number): unknown {
  const arr = unwrapJspbArray(msg);
  if (!arr || arr.length === 0 || fieldNum < 1) return undefined;
  const lastIdx = arr.length - 1;
  const last = arr[lastIdx];
  const hasSparse = isPlainSparseMap(last);
  const denseEnd = hasSparse ? lastIdx : arr.length;
  const idx = fieldNum - 1;
  if (idx < denseEnd && arr[idx] !== undefined && arr[idx] !== null) {
    return arr[idx];
  }
  if (hasSparse) {
    const sparseVal = last[String(fieldNum)];
    if (sparseVal !== undefined && sparseVal !== null) {
      return sparseVal;
    }
  }
  return undefined;
}

/** Reads a direct URL string from a scalar field or the first field of a nested sub-message. */
function protoUrlScalar(val: unknown): string | null {
  return asDirectUrl(val) ?? asDirectUrl(protoField(val, 1));
}

/** Normalizes an optional media kind string (`"video"`, `"image"`, `"character"`, or `"audio"`). */
function normalizeKind(expectedKind?: string | null): string | null {
  if (!expectedKind) return null;
  const k = String(expectedKind).trim().toLowerCase();
  return k || null;
}

/** Converts a raw tile `type` string to a normalized media kind, or returns null. */
function tileTypeToKind(ttype: string): string | null {
  if (ttype === "VIDEO") return "video";
  if (ttype === "CHARACTER") return "character";
  if (ttype === "AUDIO" || ttype === "VOICE") return "audio";
  if (ttype === "IMAGE") return "image";
  return null;
}

/** Extracts the primary media ID from a normalized project tile, including character looks. */
function extractTileMediaId(t: FlowTile, ttype: string): string | null {
  const direct =
    t.primaryMediaId ?? t.Fb?.id ?? t.Fb?.mediaId ?? t.fb?.mediaId ?? t.mediaId ??
    (ttype === "CHARACTER" ? readOwn(t, "Kd") : null);
  if (direct != null && String(direct).trim()) return String(direct).trim();
  if (ttype === "CHARACTER") {
    const looks = characterLooksOf(t);
    for (const entry of looks?.values() ?? []) {
      const lid = entry?.primaryMediaId ?? entry?.media?.id ?? entry?.media?.mediaId;
      if (lid != null && String(lid).trim()) return String(lid).trim();
    }
  }
  return null;
}

/** Maps a media or tile ID to its canonical `mediaId` and inferred media `kind`. */
function resolveMediaTarget(
  rawId: string,
  expectedKind?: string | null,
): { mediaId: string; kind: string | null } {
  const explicit = normalizeKind(expectedKind);
  const tileMap = runtimeState.store?.getTileMap?.();
  if (!(tileMap instanceof Map)) return { mediaId: rawId, kind: explicit };
  const matchTile = (rawTile: FlowTile | undefined): { mediaId: string; kind: string | null } | null => {
    const t = legacyTile(rawTile);
    if (!t) return null;
    const ttype = String(t.type ?? "").toUpperCase();
    const mappedId = extractTileMediaId(t, ttype);
    return { mediaId: mappedId || rawId, kind: explicit ?? tileTypeToKind(ttype) };
  };
  if (tileMap.has(rawId)) {
    const byKey = matchTile(tileMap.get(rawId));
    if (byKey) return byKey;
  }
  for (const rawTile of tileMap.values()) {
    const t = legacyTile(rawTile);
    if (!t) continue;
    const ttype = String(t.type ?? "").toUpperCase();
    if (String(t.id ?? "") === rawId) {
      return { mediaId: extractTileMediaId(t, ttype) || rawId, kind: explicit ?? tileTypeToKind(ttype) };
    }
    const ids = [t.primaryMediaId, t.Fb?.id, t.Fb?.mediaId, t.fb?.mediaId, t.mediaId, readOwn(t, "Kd")];
    if (ids.some((id) => id != null && String(id) === rawId)) {
      return { mediaId: rawId, kind: explicit ?? tileTypeToKind(ttype) };
    }
    if (ttype === "CHARACTER") {
      for (const entry of characterLooksOf(t as FlowTile)?.values() ?? []) {
        if (String(entry?.primaryMediaId ?? "") === rawId || String(entry?.media?.id ?? "") === rawId) {
          return { mediaId: rawId, kind: explicit ?? "character" };
        }
      }
    }
  }
  return { mediaId: rawId, kind: explicit };
}

/** Creates URL rewrite and extraction helpers for the active FIFE environment. */
function createMediaExtractor() {
  const { fifeHost, authuser, isSignedCdnHost } = getFifeEnv();

  const isSignedUrl = (rawUrl: string): boolean => {
    try {
      return isSignedCdnHost(new URL(rawUrl));
    } catch {
      return false;
    }
  };

  const rewriteFifeUrl = (rawUrl: unknown, optionsSuffix: string): string | null => {
    const direct = asDirectUrl(rawUrl);
    if (!direct) return null;
    try {
      const parsed = new URL(direct);
      if (isSignedCdnHost(parsed)) {
        return parsed.toString();
      }
      const host = parsed.hostname.toLowerCase();
      if (
        host.endsWith(".googleusercontent.com") ||
        host.endsWith(".fife.usercontent.google.com") ||
        host === fifeHost.toLowerCase()
      ) {
        parsed.hostname = fifeHost;
        const basePath = parsed.pathname.replace(/=[^/]*$/, "");
        parsed.pathname = optionsSuffix ? `${basePath}=${optionsSuffix}` : basePath;
        if (authuser) {
          parsed.searchParams.set("authuser", authuser);
        }
      }
      return parsed.toString();
    } catch {
      return null;
    }
  };

  const recordSigned = (state: MediaExtractState, direct: string): void => {
    if (isExpiredSignedUrl(direct)) return;
    pushUnique(state.signedCandidates, direct);
    state.signedDownloadUrl ??= direct;
    state.signedStreamUrl ??= direct;
  };

  const recordRawFife = (state: MediaExtractState, direct: string): void => {
    if (!direct.includes("storage.googleapis.com")) {
      pushUnique(state.rawUnsignedFife, direct);
    }
  };

  const recordVideoUrl = (
    state: MediaExtractState,
    raw: unknown,
    includeDownloadFlag: boolean,
  ): void => {
    const direct = asDirectUrl(raw);
    if (!direct) return;
    if (isSignedUrl(direct)) {
      recordSigned(state, direct);
      return;
    }
    recordRawFife(state, direct);
    const dUrl = includeDownloadFlag ? rewriteFifeUrl(direct, "d") : null;
    const mm22 = rewriteFifeUrl(direct, "mm,22,15");
    const mm18 = rewriteFifeUrl(direct, "mm,18,15");
    const dv = rewriteFifeUrl(direct, "dv");
    if (dUrl) {
      pushUnique(state.unsignedCandidates, dUrl);
      state.unsignedDownloadUrl ??= dUrl;
    }
    pushUnique(state.unsignedCandidates, mm22);
    pushUnique(state.unsignedCandidates, mm18);
    pushUnique(state.unsignedCandidates, dv);
    pushUnique(state.unsignedCandidates, direct);
    state.unsignedStreamUrl ??= mm22 ?? direct;
    state.unsignedDownloadUrl ??= mm22 ?? direct;
  };

  const recordImageUrl = (state: MediaExtractState, raw: unknown): void => {
    const direct = asDirectUrl(raw);
    if (!direct) return;
    if (isSignedUrl(direct)) {
      recordSigned(state, direct);
      return;
    }
    recordRawFife(state, direct);
    const dUrl = rewriteFifeUrl(direct, "d");
    const s0Url = rewriteFifeUrl(direct, "s0");
    const s1600Url = rewriteFifeUrl(direct, "s1600-rw");
    pushUnique(state.unsignedCandidates, dUrl);
    pushUnique(state.unsignedCandidates, s0Url);
    pushUnique(state.unsignedCandidates, s1600Url);
    pushUnique(state.unsignedCandidates, direct);
    state.unsignedDownloadUrl ??= dUrl ?? direct;
    state.unsignedStreamUrl ??= s1600Url ?? direct;
  };

  const recordAudioUrl = (state: MediaExtractState, raw: unknown): void => {
    const direct = asDirectUrl(raw);
    if (!direct) return;
    if (isSignedUrl(direct)) {
      recordSigned(state, direct);
      return;
    }
    const cleanUrl = rewriteFifeUrl(direct, "");
    const dUrl = rewriteFifeUrl(direct, "d");
    pushUnique(state.unsignedCandidates, cleanUrl ?? direct);
    pushUnique(state.unsignedCandidates, direct);
    pushUnique(state.unsignedCandidates, dUrl);
    state.unsignedDownloadUrl ??= cleanUrl ?? direct;
    state.unsignedStreamUrl ??= cleanUrl ?? direct;
  };

  const extractVideoProto = (video: unknown, state: MediaExtractState): void => {
    if (!unwrapJspbArray(video)) return;
    const v6 = protoField(video, 6);
    for (const branch of [protoField(v6, 2), protoField(v6, 3)]) {
      // Read field 1 (video stream) only; field 2 is the poster thumbnail image.
      const streamUrl = protoUrlScalar(protoField(branch, 1)) ?? asDirectUrl(branch);
      if (streamUrl) {
        recordVideoUrl(state, streamUrl, false);
      }
    }
    const v1 = protoField(video, 1);
    const v2 = protoField(video, 2);
    const v5 = protoField(video, 5);
    for (const raw of [
      protoField(v1, 9),
      protoField(v5, 3),
      protoField(v1, 13),
      protoField(v1, 12),
      protoField(v5, 1),
      protoField(v1, 6),
      protoField(v2, 4),
      protoUrlScalar(protoField(v6, 1)),
    ]) {
      recordVideoUrl(state, raw, true);
    }
  };

  const extractImageProto = (image: unknown, state: MediaExtractState): void => {
    if (!unwrapJspbArray(image)) return;
    const i6 = protoField(image, 6);
    for (const branch of [protoField(i6, 2), protoField(i6, 3)]) {
      const signedOrDirect = protoUrlScalar(branch);
      if (signedOrDirect) {
        if (isSignedUrl(signedOrDirect)) {
          recordSigned(state, signedOrDirect);
        } else {
          recordImageUrl(state, signedOrDirect);
        }
      }
    }
    const i1 = protoField(image, 1);
    const i2 = protoField(image, 2);
    for (const rawFife of [
      protoField(i1, 14),
      protoField(i2, 4),
      protoUrlScalar(protoField(i6, 1)),
    ]) {
      recordImageUrl(state, rawFife);
    }
  };

  const extractAudioProto = (audio: unknown, state: MediaExtractState): void => {
    if (!unwrapJspbArray(audio)) return;
    const a6 = protoField(audio, 6);
    for (const branch of [protoField(a6, 2), protoField(a6, 3), protoField(a6, 1)]) {
      const resolved = protoUrlScalar(branch);
      if (resolved) {
        recordAudioUrl(state, resolved);
      }
    }
    const a1 = protoField(audio, 1);
    const a2 = protoField(audio, 2);
    for (const rawAudio of [
      protoUrlScalar(protoField(a1, 4)),
      protoUrlScalar(protoField(a1, 6)),
      protoUrlScalar(protoField(a1, 1)),
      protoUrlScalar(protoField(a2, 4)),
      protoUrlScalar(protoField(audio, 2)),
      protoUrlScalar(protoField(audio, 3)),
      protoUrlScalar(protoField(audio, 4)),
    ]) {
      recordAudioUrl(state, rawAudio);
    }
  };

  const extractFromProto = (
    proto: unknown,
    state: MediaExtractState,
    kind: string | null,
  ): void => {
    const video = protoField(proto, 8);
    const image = protoField(proto, 7);
    const audio = protoField(proto, 11);
    if (kind === "audio") {
      extractAudioProto(audio, state);
      if (!hasCandidates(state)) {
        extractVideoProto(video, state);
        extractImageProto(image, state);
      }
      return;
    }
    if (kind === "image" || kind === "character") {
      extractImageProto(image, state);
      if (!hasCandidates(state)) {
        extractVideoProto(video, state);
        extractAudioProto(audio, state);
      }
      return;
    }
    extractVideoProto(video, state);
    extractImageProto(image, state);
    extractAudioProto(audio, state);
  };

  const recordVideoPayload = (
    state: MediaExtractState,
    data: unknown,
    videoField?: string,
  ): void => {
    if (typeof data === "string") {
      recordVideoUrl(state, data, false);
      return;
    }
    if (!data || typeof data !== "object") return;
    if (videoField) {
      const fieldVal = readOwn(data, videoField);
      if (asDirectUrl(fieldVal)) {
        recordVideoUrl(state, fieldVal, false);
        return;
      }
    }
    const urls = Object.keys(data)
      .map((k) => asDirectUrl(readOwn(data, k)))
      .filter((u): u is string => u !== null);
    if (urls.length === 1) {
      recordVideoUrl(state, urls[0], false);
    } else {
      for (const u of urls) {
        if (/(?:=mm,\d|=dv\b|\.mp4(?:$|[?#])|\.webm(?:$|[?#]))/i.test(u)) {
          recordVideoUrl(state, u, false);
        }
      }
    }
  };

  return {
    isSignedUrl,
    recordVideoUrl,
    recordVideoPayload,
    recordImageUrl,
    recordAudioUrl,
    extractFromProto,
  };
}

/** Saves `state` into `runtimeState.mediaInfoCache` and returns a resolved cache entry. */
function finalizeState(
  cacheKey: string,
  state: MediaExtractState,
  binding?: MediaResolverBinding,
): (CachedMediaInfo & { ok: true }) | null {
  const candidates: string[] = [];
  for (const u of state.signedCandidates) pushUnique(candidates, u);
  for (const u of state.unsignedCandidates) pushUnique(candidates, u);
  if (candidates.length === 0) return null;

  if (state.signedCandidates.length === 0 && state.rawUnsignedFife.length > 0 && binding) {
    try {
      binding.registerFife(binding.service, state.rawUnsignedFife);
    } catch {
      // Ignore optional FIFE registration errors during fallback URL resolution.
    }
  }

  const finalDl =
    state.signedDownloadUrl ?? state.unsignedDownloadUrl ?? candidates[0];
  const finalUrl =
    state.signedStreamUrl ??
    state.signedDownloadUrl ??
    state.unsignedStreamUrl ??
    finalDl;
  const entry: CachedMediaInfo = {
    url: finalUrl,
    download_url: finalDl,
    candidates: candidates.slice(),
  };
  runtimeState.mediaInfoCache.set(cacheKey, entry);
  return {
    ok: true,
    url: entry.url,
    download_url: entry.download_url,
    candidates: entry.candidates.slice(),
  };
}

/** Returns matching TanStack query entries for `[prefix, mediaId]` from `qc`. */
function findQueriesByPrefix(
  qc: TanStackQueryCache,
  prefix: string,
  mediaId: string,
): readonly TanStackQueryEntry[] {
  try {
    if (typeof qc.findAll === "function") {
      return qc.findAll({ queryKey: [prefix, mediaId] });
    }
    return qc
      .getAll()
      .filter(
        (q) =>
          Array.isArray(q?.queryKey) &&
          q.queryKey[0] === prefix &&
          q.queryKey[1] === mediaId,
      );
  } catch {
    return [];
  }
}

/** Reads a non-expired entry from `runtimeState.mediaInfoCache`, evicting expired records. */
function readMemoryCacheEntry(key: string): (CachedMediaInfo & { ok: true }) | null {
  const mem = runtimeState.mediaInfoCache.get(key);
  if (!mem || typeof mem.url !== "string" || !/^https?:\/\//i.test(mem.url) || !mem.candidates?.length) {
    return null;
  }
  const dl = typeof mem.download_url === "string" && /^https?:\/\//i.test(mem.download_url)
    ? mem.download_url
    : mem.url;
  const freshCandidates = mem.candidates.filter((c) => !isExpiredSignedUrl(c));
  if (isExpiredSignedUrl(mem.url) || isExpiredSignedUrl(dl) || freshCandidates.length === 0) {
    runtimeState.mediaInfoCache.delete(key);
    return null;
  }
  return { ok: true, url: mem.url, download_url: dl, candidates: freshCandidates };
}

/** Reads a cached media entry from `mediaInfoCache` or active TanStack `queryCache` with zero RPCs. */
export function readCachedMediaInfo(
  primaryMediaId: string,
  expectedKind?: string | null,
  caches?: readonly TanStackQueryCache[],
): (CachedMediaInfo & { ok: true }) | null {
  const rawKey = primaryMediaId ? String(primaryMediaId).trim() : "";
  if (!rawKey) return null;

  const directMem = readMemoryCacheEntry(rawKey);
  if (directMem) return directMem;

  const { mediaId: cacheKey, kind } = resolveMediaTarget(rawKey, expectedKind);
  if (cacheKey !== rawKey) {
    const mappedMem = readMemoryCacheEntry(cacheKey);
    if (mappedMem) return mappedMem;
  }

  const activeCaches = caches ?? findActiveQueryCaches();
  if (activeCaches.length === 0) return null;

  const extractor = createMediaExtractor();
  const state = emptyExtractState();
  const videoField = frontendBuild(readBuildLabel())?.operations.media_resolver?.videoUrl;

  for (const qc of activeCaches) {
    if (kind !== "image" && kind !== "character" && kind !== "audio") {
      for (const q of findQueriesByPrefix(qc, "VIDEO_URLS", cacheKey)) {
        if (q.state?.status !== "success" || q.state.isInvalidated) continue;
        extractor.recordVideoPayload(state, q.state.data, videoField);
      }
    }

    if (kind !== "video" && kind !== "audio") {
      for (const q of findQueriesByPrefix(qc, "IMAGE_SRC", cacheKey)) {
        if (q.state?.status !== "success" || q.state.isInvalidated) continue;
        if (typeof q.state.data === "string") {
          extractor.recordImageUrl(state, q.state.data);
        }
      }
    }

    for (const q of findQueriesByPrefix(qc, "MEDIA", cacheKey)) {
      if (q.state?.status !== "success" || q.state.isInvalidated) continue;
      if (q.state.data !== undefined && q.state.data !== null) {
        extractor.extractFromProto(q.state.data, state, kind);
      }
    }
  }

  const finalized = finalizeState(cacheKey, state);
  if (finalized && rawKey !== cacheKey) {
    runtimeState.mediaInfoCache.set(rawKey, {
      url: finalized.url,
      download_url: finalized.download_url,
      candidates: finalized.candidates.slice(),
    });
  }
  return finalized;
}

/** Finds an in-flight TanStack query promise for `mediaId` when one is already pending. */
function findPendingMediaPromise(
  caches: readonly TanStackQueryCache[],
  mediaId: string,
): Promise<unknown> | null {
  for (const qc of caches) {
    for (const prefix of ["VIDEO_URLS", "IMAGE_SRC", "MEDIA"]) {
      for (const q of findQueriesByPrefix(qc, prefix, mediaId)) {
        if (q.state?.status === "pending" && q.promise instanceof Promise) {
          return q.promise;
        }
      }
    }
  }
  return null;
}

/** Resolves media stream and download URLs via active cache, native Flow resolver, or sparse `as29s` fallback. */
export async function resolveVideoUrl(
  primaryMediaId: string,
  timeoutMs?: number | null,
  expectedKind?: string | null,
): Promise<ResolvedMediaResult> {
  const signal = timeoutMs == null ? undefined : AbortSignal.timeout(timeoutMs);
  const rawKey = primaryMediaId ? String(primaryMediaId).trim() : "";
  if (!rawKey) {
    return { ok: false, error: "missing_wiz_or_media_id" };
  }

  const { mediaId: cacheKey, kind } = resolveMediaTarget(rawKey, expectedKind);
  const rememberAlias = (res: CachedMediaInfo & { ok: true }): CachedMediaInfo & { ok: true } => {
    if (rawKey !== cacheKey) {
      runtimeState.mediaInfoCache.set(rawKey, {
        url: res.url,
        download_url: res.download_url,
        candidates: res.candidates.slice(),
      });
    }
    return res;
  };

  const caches = findActiveQueryCaches();
  const cachedHit = readCachedMediaInfo(cacheKey, kind, caches);
  if (cachedHit) {
    return rememberAlias(cachedHit);
  }

  const inFlight = findPendingMediaPromise(caches, cacheKey);
  if (inFlight && !signal?.aborted) {
    try {
      await waitForMedia(() => inFlight, signal);
      const settledHit = readCachedMediaInfo(cacheKey, kind, caches);
      if (settledHit) {
        return rememberAlias(settledHit);
      }
    } catch {
      if (signal?.aborted) {
        return { ok: false, error: "timeout" };
      }
    }
  }

  const extractor = createMediaExtractor();

  if (kind !== "audio" && !signal?.aborted) {
    const compat = mediaResolverCompatibility();
    const binding = compat.ok ? bindMediaResolver(compat.format) : undefined;
    if (binding) {
      const nativeState = emptyExtractState();
      if (kind === "image" || kind === "character") {
        try {
          const imgUrl = await waitForMedia(
            () =>
              binding.resolveImage(binding.service, {
                mediaId: cacheKey,
                me: false,
                aspectRatio: 1,
                Bc: 3,
                signal,
              }),
            signal,
          );
          extractor.recordImageUrl(nativeState, imgUrl);
        } catch {
          // Check queryCache and sparse wire fallback when native image lookup fails.
        }
      } else {
        try {
          const vidRes = await waitForMedia(
            () =>
              binding.resolveVideo(binding.service, {
                mediaId: cacheKey,
                me: false,
                de: true,
                signal,
              }),
            signal,
          );
          extractor.recordVideoPayload(nativeState, vidRes, binding.format.videoUrl);
        } catch {
          if (kind === null && !signal?.aborted) {
            const warmHit = readCachedMediaInfo(cacheKey, null, [binding.queryCache]);
            if (warmHit) {
              return rememberAlias(warmHit);
            }
            try {
              const imgUrl = await waitForMedia(
                () =>
                  binding.resolveImage(binding.service, {
                    mediaId: cacheKey,
                    me: false,
                    aspectRatio: 1,
                    Bc: 3,
                    signal,
                  }),
                signal,
              );
              extractor.recordImageUrl(nativeState, imgUrl);
            } catch {
              // Use sparse wire fallback when native video and image lookups fail.
            }
          }
        }
      }

      const resolvedNative = finalizeState(cacheKey, nativeState, binding);
      if (resolvedNative) {
        return rememberAlias(resolvedNative);
      }
      const postNativeCache = readCachedMediaInfo(cacheKey, kind, [binding.queryCache]);
      if (postNativeCache) {
        return rememberAlias(postNativeCache);
      }
    }
  }

  if (signal?.aborted) {
    return { ok: false, error: "timeout" };
  }

  const wiz = window.WIZ_global_data || {};
  const at = typeof wiz.SNlM0e === "string" ? wiz.SNlM0e : "";
  const sid = typeof wiz.FdrFJe === "string" ? wiz.FdrFJe : "";
  const bl = readBuildLabel() ?? "";
  if (!at) {
    return { ok: false, error: "missing_wiz_or_media_id" };
  }

  const fallbackState = emptyExtractState();
  const rpcErr = await fetchSparseAs29s(
    [cacheKey, null, [1]],
    { at, sid, bl, signal },
    (proto) => extractor.extractFromProto(proto, fallbackState, kind),
  );

  const finalized = finalizeState(cacheKey, fallbackState, bindMediaResolver());
  if (!finalized) {
    return { ok: false, error: rpcErr || "no_video_url_in_proto" };
  }
  return rememberAlias(finalized);
}

/** Sends a single-pass `as29s` `batchexecute` RPC and passes each decoded payload to `onProto`. */
async function fetchSparseAs29s(
  innerArgsArray: unknown[],
  ctx: { at: string; sid: string; bl: string; signal?: AbortSignal },
  onProto: (proto: unknown) => void,
): Promise<string | null> {
  try {
    const reqPayload = JSON.stringify([
      [["as29s", JSON.stringify(innerArgsArray), null, "generic"]],
    ]);
    const params = new URLSearchParams({
      rpcids: "as29s",
      "source-path": location.pathname || "/",
      bl: ctx.bl,
      "f.sid": ctx.sid,
      hl: "en",
      rt: "c",
    });
    const body = `f.req=${encodeURIComponent(reqPayload)}&at=${encodeURIComponent(ctx.at)}`;
    const resp = await fetch(
      `/_/AiSandboxAngularFrontend/data/batchexecute?${params.toString()}`,
      {
        method: "POST",
        credentials: "include",
        signal: ctx.signal,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body,
      },
    );
    if (!resp.ok) {
      return `http_${resp.status}`;
    }

    const text = await resp.text();
    const lines = text.split(/\r?\n/);
    let matchedRpc = false;
    for (const line of lines) {
      if (!line.startsWith("[")) continue;
      let entries: unknown;
      try {
        entries = JSON.parse(line);
      } catch {
        continue;
      }
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (
          !Array.isArray(entry) ||
          entry[0] !== "wrb.fr" ||
          entry[1] !== "as29s" ||
          typeof entry[2] !== "string"
        ) {
          continue;
        }
        matchedRpc = true;
        let proto: unknown;
        try {
          proto = JSON.parse(entry[2]);
        } catch {
          continue;
        }
        onProto(proto);
      }
    }
    return matchedRpc ? null : "no_video_url_in_proto";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
