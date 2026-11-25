// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Resolve stream and download media URLs for a primary media ID via batchexecute RPC.

import { fifeEnv as getFifeEnv } from "./dom";
import { readBuildLabel } from "./frontend_builds";
import { getFreshCachedMedia, isExpiredSignedUrl } from "./media_variants";
import { runtimeState } from "./state";
import type { ResolvedMediaResult } from "./types";

/** Media family in an `as29s` wire message. */
type ResolvedMediaKind = "video" | "image" | "audio";

/** URL and kind state that `extractFromProto` collects from `as29s` responses. */
interface MediaExtractState {
  /** Preferred signed streaming URL. */
  signedStreamUrl: string | null;
  /** Preferred signed download URL. */
  signedDownloadUrl: string | null;
  /** Unique signed direct URL candidates in priority order. */
  signedCandidates: string[];
  /** Preferred unsigned streaming URL. */
  unsignedStreamUrl: string | null;
  /** Preferred unsigned download URL. */
  unsignedDownloadUrl: string | null;
  /** Unique unsigned URL candidates in priority order. */
  unsignedCandidates: string[];
  /** Media family from the wire message. */
  mediaKind: ResolvedMediaKind | null;
  /** True when case `11` audio resolved raw 24 kHz PCM bytes. */
  pcmAudio: boolean;
}

/** Returns true when `val` is a plain sparse JSPB field map object. */
function isSparseMap(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

/** Returns true when `val` is a JSPB message array or sparse field map. */
function isJspbMessage(val: unknown): boolean {
  return Array.isArray(val) || isSparseMap(val);
}

/** Reads 1-based protobuf `fieldNumber` from a dense JSPB array or its trailing sparse map. */
function jspbField(msg: unknown, fieldNumber: number): unknown {
  if (fieldNumber < 1) return undefined;
  if (isSparseMap(msg)) {
    return msg[String(fieldNumber)];
  }
  if (!Array.isArray(msg) || msg.length === 0) {
    return undefined;
  }
  const denseIdx = fieldNumber - 1;
  const lastIdx = msg.length - 1;
  const tail = msg[lastIdx];
  if (isSparseMap(tail)) {
    if (denseIdx < lastIdx && msg[denseIdx] != null) {
      return msg[denseIdx];
    }
    return tail[String(fieldNumber)];
  }
  return denseIdx <= lastIdx ? msg[denseIdx] : undefined;
}

/** Resolves media stream and download URLs within the optional request budget. */
export async function resolveVideoUrl(
  primaryMediaId: string,
  timeoutMs?: number | null,
  bypassCache?: boolean,
): Promise<ResolvedMediaResult> {
  const signal = timeoutMs == null ? undefined : AbortSignal.timeout(timeoutMs);
  const cacheKey = primaryMediaId ? String(primaryMediaId) : "";
  const wiz = window.WIZ_global_data || {};
  const at = typeof wiz.SNlM0e === "string" ? wiz.SNlM0e : "";
  const sid = typeof wiz.FdrFJe === "string" ? wiz.FdrFJe : "";
  const bl = readBuildLabel() ?? "";
  if (!cacheKey || !at) {
    return { ok: false, error: "missing_wiz_or_media_id" };
  }

  if (bypassCache) {
    runtimeState.mediaInfoCache.delete(cacheKey);
  } else {
    const cachedInfo = getFreshCachedMedia(cacheKey);
    if (
      cachedInfo &&
      typeof cachedInfo.url === "string" &&
      /^https?:\/\//i.test(cachedInfo.url) &&
      Array.isArray(cachedInfo.candidates) &&
      cachedInfo.candidates.length > 0
    ) {
      return {
        ok: true,
        url: cachedInfo.url,
        download_url:
          typeof cachedInfo.download_url === "string" &&
          /^https?:\/\//i.test(cachedInfo.download_url)
            ? cachedInfo.download_url
            : cachedInfo.url,
        candidates: cachedInfo.candidates.slice(),
        ...(cachedInfo.media_kind ? { media_kind: cachedInfo.media_kind } : {}),
        ...(cachedInfo.pcm_audio ? { pcm_audio: true } : {}),
      };
    }
  }

  const { fifeHost, authuser, isSignedCdnHost } = getFifeEnv();

  const asDirectUrl = (rawUrl: unknown): string | null => {
    if (typeof rawUrl !== "string") return null;
    const trimmed = rawUrl.trim();
    if (!/^https?:\/\//i.test(trimmed)) return null;
    try {
      return new URL(trimmed).toString();
    } catch {
      return null;
    }
  };

  const rewriteFifeUrl = (
    rawUrl: unknown,
    optionsSuffix: string | null,
    proxyActive: boolean,
  ): string | null => {
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
        if (proxyActive) {
          parsed.hostname = fifeHost;
        }
        if (optionsSuffix !== null) {
          const basePath = parsed.pathname.replace(/=[^/]*$/, "");
          parsed.pathname = optionsSuffix
            ? `${basePath}=${optionsSuffix}`
            : basePath;
        }
        if (
          authuser &&
          parsed.hostname.toLowerCase() === fifeHost.toLowerCase()
        ) {
          parsed.searchParams.set("authuser", authuser);
        }
      }
      return parsed.toString();
    } catch {
      return null;
    }
  };

  const isSignedUrl = (rawUrl: string): boolean => {
    try {
      return isSignedCdnHost(new URL(rawUrl));
    } catch {
      return false;
    }
  };

  const pushCandidate = (list: string[], raw: unknown): void => {
    const direct = asDirectUrl(raw);
    if (direct && !list.includes(direct)) {
      list.push(direct);
    }
  };

  const recordSigned = (state: MediaExtractState, direct: string): boolean => {
    if (isExpiredSignedUrl(direct)) return false;
    pushCandidate(state.signedCandidates, direct);
    state.signedDownloadUrl ||= direct;
    state.signedStreamUrl ||= direct;
    return true;
  };

  const hasExtractedUrls = (state: MediaExtractState): boolean =>
    state.signedCandidates.length > 0 || state.unsignedCandidates.length > 0;

  const extractBranchUrl = (branch: unknown): string | null =>
    asDirectUrl(branch) ||
    asDirectUrl(jspbField(branch, 1)) ||
    asDirectUrl(jspbField(jspbField(branch, 1), 1));

  const extractFromProto = (proto: unknown, state: MediaExtractState): void => {
    const video = jspbField(proto, 8);
    if (isJspbMessage(video)) {
      const v6 = jspbField(video, 6);
      const rawV6Case1 = jspbField(v6, 1);
      const v6Case1 = extractBranchUrl(rawV6Case1);
      const v6Case2 = extractBranchUrl(jspbField(v6, 2));
      const v6Case3 = extractBranchUrl(jspbField(v6, 3));
      const proxyActive = Boolean(
        rawV6Case1 != null &&
          !v6Case2 &&
          !v6Case3 &&
          !(v6Case1 && isSignedUrl(v6Case1)),
      );

      for (const okDirect of [v6Case2, v6Case3]) {
        // Read field 1 (video stream) only; field 2 on a nested branch is a still thumbnail.
        if (!okDirect) continue;
        if (isSignedUrl(okDirect)) {
          recordSigned(state, okDirect);
        } else {
          const mm22 = rewriteFifeUrl(okDirect, "mm,22,15", proxyActive);
          const mm18 = rewriteFifeUrl(okDirect, "mm,18,15", proxyActive);
          const dUrl = rewriteFifeUrl(okDirect, "d", proxyActive);
          pushCandidate(state.unsignedCandidates, mm22);
          pushCandidate(state.unsignedCandidates, mm18);
          pushCandidate(state.unsignedCandidates, dUrl);
          state.unsignedStreamUrl ||= mm22;
          state.unsignedDownloadUrl ||= dUrl;
        }
      }

      const v1 = jspbField(video, 1);
      const v2 = jspbField(video, 2);
      const v5 = jspbField(video, 5);
      for (const raw of [
        jspbField(v1, 9),
        jspbField(v5, 3),
        jspbField(v1, 13),
        jspbField(v1, 12),
        jspbField(v5, 1),
        jspbField(v1, 6),
        jspbField(v2, 4),
        v6Case1,
      ]) {
        const direct = asDirectUrl(raw);
        if (!direct) continue;
        if (isSignedUrl(direct)) {
          recordSigned(state, direct);
        } else {
          const dUrl = rewriteFifeUrl(direct, "d", proxyActive);
          const mm22 = rewriteFifeUrl(direct, "mm,22,15", proxyActive);
          const mm18 = rewriteFifeUrl(direct, "mm,18,15", proxyActive);
          const dv = rewriteFifeUrl(direct, "dv", proxyActive);
          pushCandidate(state.unsignedCandidates, dUrl);
          pushCandidate(state.unsignedCandidates, mm22);
          pushCandidate(state.unsignedCandidates, mm18);
          pushCandidate(state.unsignedCandidates, dv);
          state.unsignedDownloadUrl ||= dUrl;
          state.unsignedStreamUrl ||= mm22;
        }
      }
      if (hasExtractedUrls(state)) {
        state.mediaKind ||= "video";
        return;
      }
    }

    const image = jspbField(proto, 7);
    if (isJspbMessage(image)) {
      const i6 = jspbField(image, 6);
      const rawI6Case1 = jspbField(i6, 1);
      const i6Case1 = extractBranchUrl(rawI6Case1);
      const i6Case2 = extractBranchUrl(jspbField(i6, 2));
      const i6Case3 = extractBranchUrl(jspbField(i6, 3));
      const proxyActive = Boolean(
        rawI6Case1 != null &&
          !i6Case2 &&
          !i6Case3 &&
          !(i6Case1 && isSignedUrl(i6Case1)),
      );

      for (const direct of [i6Case2, i6Case3]) {
        if (!direct) continue;
        if (isSignedUrl(direct)) {
          recordSigned(state, direct);
        } else {
          pushCandidate(state.unsignedCandidates, direct);
          state.unsignedDownloadUrl ||= direct;
          state.unsignedStreamUrl ||= direct;
        }
      }

      const i1 = jspbField(image, 1);
      const i2 = jspbField(image, 2);
      for (const rawFife of [
        jspbField(i1, 14),
        jspbField(i2, 4),
        i6Case1,
      ]) {
        const direct = asDirectUrl(rawFife);
        if (!direct) continue;
        if (isSignedUrl(direct)) {
          recordSigned(state, direct);
        } else {
          const dUrl = rewriteFifeUrl(direct, "d", proxyActive);
          const s0Url = rewriteFifeUrl(direct, "s0", proxyActive);
          const s1600Url = rewriteFifeUrl(direct, "s1600-rw", proxyActive);
          pushCandidate(state.unsignedCandidates, dUrl);
          pushCandidate(state.unsignedCandidates, s0Url);
          pushCandidate(state.unsignedCandidates, s1600Url);
          state.unsignedDownloadUrl ||= dUrl;
          state.unsignedStreamUrl ||= s1600Url;
        }
      }
      if (hasExtractedUrls(state)) {
        state.mediaKind ||= "image";
        return;
      }
    }

    const audio = jspbField(proto, 11);
    if (isJspbMessage(audio)) {
      const a6 = jspbField(audio, 6);
      const rawA6Case1 = jspbField(a6, 1);
      const a6Case1 = extractBranchUrl(rawA6Case1);
      const a6Case2 = extractBranchUrl(jspbField(a6, 2));
      const a6Case3 = extractBranchUrl(jspbField(a6, 3));
      const proxyActive = Boolean(
        rawA6Case1 != null &&
          !a6Case2 &&
          !a6Case3 &&
          !(a6Case1 && isSignedUrl(a6Case1)),
      );

    const a1 = jspbField(audio, 1);
      const a2 = jspbField(audio, 2);
      const a5 = jspbField(audio, 5);
      let addedCase11Audio = false;
      for (const rawAudio of [
        a6Case2,
        a6Case3,
        extractBranchUrl(jspbField(a5, 2)),
        extractBranchUrl(jspbField(a5, 3)),
        jspbField(a1, 4),
        jspbField(a1, 6),
        jspbField(a1, 3),
        jspbField(a1, 5),
        jspbField(a1, 9),
        jspbField(a1, 12),
        jspbField(a1, 13),
        jspbField(a1, 14),
        jspbField(a1, 2),
        jspbField(a1, 1),
        jspbField(a2, 4),
        jspbField(a2, 3),
        jspbField(a2, 1),
        jspbField(a5, 1),
        extractBranchUrl(jspbField(audio, 4)),
        extractBranchUrl(jspbField(audio, 3)),
        extractBranchUrl(jspbField(audio, 2)),
        extractBranchUrl(jspbField(audio, 1)),
        a6Case1,
      ]) {
        const direct = asDirectUrl(rawAudio);
        if (!direct) continue;
        if (isSignedUrl(direct)) {
          if (recordSigned(state, direct)) {
            addedCase11Audio = true;
          }
        } else {
          const rewritten = proxyActive
            ? rewriteFifeUrl(direct, null, true) || direct
            : direct;
          pushCandidate(state.unsignedCandidates, rewritten);
          if (rewritten !== direct) {
            pushCandidate(state.unsignedCandidates, direct);
          }
          state.unsignedDownloadUrl ||= rewritten;
          state.unsignedStreamUrl ||= rewritten;
          addedCase11Audio = true;
        }
      }
      if (addedCase11Audio) {
        state.mediaKind ||= "audio";
        state.pcmAudio = true;
      } else if (hasExtractedUrls(state)) {
        state.mediaKind ||= "audio";
      }
    }
  };

  async function fetchAs29s(
    innerArgsArray: unknown[],
    state: MediaExtractState,
  ): Promise<string | null> {
    try {
      const reqPayload = JSON.stringify([
        [["as29s", JSON.stringify(innerArgsArray), null, "generic"]],
      ]);
      const params = new URLSearchParams({
        rpcids: "as29s",
        "source-path": location.pathname || "/",
        bl,
        "f.sid": sid,
        hl: "en",
        rt: "c",
      });
      const body = `f.req=${encodeURIComponent(reqPayload)}&at=${encodeURIComponent(at)}`;
      const resp = await fetch(
        `/_/AiSandboxAngularFrontend/data/batchexecute?${params.toString()}`,
        {
          method: "POST",
          credentials: "include",
          signal,
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
          extractFromProto(proto, state);
        }
      }
      return matchedRpc ? null : "no_video_url_in_proto";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  const state: MediaExtractState = {
    signedStreamUrl: null,
    signedDownloadUrl: null,
    signedCandidates: [],
    unsignedStreamUrl: null,
    unsignedDownloadUrl: null,
    unsignedCandidates: [],
    mediaKind: null,
    pcmAudio: false,
  };
  let lastErr = await fetchAs29s([cacheKey, null, [1]], state);
  if (
    !signal?.aborted &&
    state.signedCandidates.length === 0 &&
    state.unsignedCandidates.length === 0
  ) {
    const fallbackErr = await fetchAs29s([cacheKey], state);
    if (fallbackErr && !lastErr) {
      lastErr = fallbackErr;
    }
  }

  const candidates: string[] = [];
  for (const cand of state.signedCandidates) {
    pushCandidate(candidates, cand);
  }
  for (const cand of state.unsignedCandidates) {
    pushCandidate(candidates, cand);
  }
  if (candidates.length === 0) {
    return { ok: false, error: lastErr || "no_video_url_in_proto" };
  }

  const finalDl =
    state.signedDownloadUrl ||
    state.signedCandidates[0] ||
    state.unsignedDownloadUrl ||
    candidates[0];
  const finalUrl =
    state.signedStreamUrl ||
    state.signedDownloadUrl ||
    state.signedCandidates[0] ||
    state.unsignedStreamUrl ||
    finalDl;
  runtimeState.mediaInfoCache.set(cacheKey, {
    url: finalUrl,
    download_url: finalDl,
    candidates: candidates.slice(),
    ...(state.mediaKind ? { media_kind: state.mediaKind } : {}),
    ...(state.pcmAudio ? { pcm_audio: true } : {}),
    cached_at: Date.now(),
  });
  return {
    ok: true,
    url: finalUrl,
    download_url: finalDl,
    candidates: candidates.slice(),
    ...(state.mediaKind ? { media_kind: state.mediaKind } : {}),
    ...(state.pcmAudio ? { pcm_audio: true } : {}),
  };
}
