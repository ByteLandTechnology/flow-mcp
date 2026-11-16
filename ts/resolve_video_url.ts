// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Resolve stream and download media URLs for a primary media ID via batchexecute RPC.

import { fifeEnv as getFifeEnv } from "./dom";
import { runtimeState } from "./state";
import type { ResolvedMediaResult } from "./types";

/** Internal extraction accumulator for `as29s` protobuf responses. */
interface MediaExtractState {
  /** Preferred streaming URL. */
  streamUrl: string | null;
  /** Preferred download URL. */
  downloadUrl: string | null;
  /** Ordered list of unique URL candidates. */
  candidates: string[];
}

/** Resolves prioritized media stream and download URLs for `primaryMediaId`. */
export async function resolveVideoUrl(
  primaryMediaId: string,
): Promise<ResolvedMediaResult> {
  const cacheKey = primaryMediaId ? String(primaryMediaId) : "";
  const wiz = window.WIZ_global_data || {};
  const at = typeof wiz.SNlM0e === "string" ? wiz.SNlM0e : "";
  const sid = typeof wiz.FdrFJe === "string" ? wiz.FdrFJe : "";
  const bl = typeof wiz.cfb2h === "string" ? wiz.cfb2h : "";
  if (!cacheKey || !at) {
    return { ok: false, error: "missing_wiz_or_media_id" };
  }

  const cachedInfo = runtimeState.mediaInfoCache.get(cacheKey);
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
    };
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
    optionsSuffix: string,
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
        parsed.hostname = fifeHost;
        const basePath = parsed.pathname.replace(/=[^/]*$/, "");
        parsed.pathname = optionsSuffix
          ? `${basePath}=${optionsSuffix}`
          : basePath;
        if (authuser) {
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

  const slotAt = (arr: unknown, idx: number): unknown =>
    Array.isArray(arr) ? arr[idx] : undefined;

  const extractFromProto = (proto: unknown, state: MediaExtractState): void => {
    const video = slotAt(proto, 7);
    if (Array.isArray(video)) {
      const v5 = slotAt(video, 5);
      for (const branch of [slotAt(v5, 1), slotAt(v5, 2)]) {
        // Inspect branch[0] (video stream) only; branch[1] is a still thumbnail.
        const okDirect = asDirectUrl(slotAt(branch, 0));
        if (!okDirect) continue;
        if (isSignedUrl(okDirect)) {
          pushCandidate(state.candidates, okDirect);
          state.downloadUrl ||= okDirect;
          state.streamUrl ||= okDirect;
        } else {
          const mm22 = rewriteFifeUrl(okDirect, "mm,22,15");
          const mm18 = rewriteFifeUrl(okDirect, "mm,18,15");
          pushCandidate(state.candidates, mm22);
          pushCandidate(state.candidates, mm18);
          state.streamUrl ||= mm22;
        }
      }

      const v0 = slotAt(video, 0);
      const v1 = slotAt(video, 1);
      const v4 = slotAt(video, 4);
      for (const raw of [
        slotAt(v0, 8),
        slotAt(v4, 2),
        slotAt(v0, 12),
        slotAt(v0, 11),
        slotAt(v4, 0),
        slotAt(v0, 5),
        slotAt(v1, 3),
        slotAt(v5, 0),
      ]) {
        const direct = asDirectUrl(raw);
        if (!direct) continue;
        if (isSignedUrl(direct)) {
          pushCandidate(state.candidates, direct);
          state.downloadUrl ||= direct;
          state.streamUrl ||= direct;
        } else {
          const dUrl = rewriteFifeUrl(direct, "d");
          const mm22 = rewriteFifeUrl(direct, "mm,22,15");
          const dv = rewriteFifeUrl(direct, "dv");
          pushCandidate(state.candidates, dUrl);
          pushCandidate(state.candidates, mm22);
          pushCandidate(state.candidates, dv);
          state.downloadUrl ||= dUrl;
          state.streamUrl ||= mm22;
        }
      }

      const fifeStream = asDirectUrl(slotAt(v5, 0));
      if (fifeStream) {
        if (isSignedUrl(fifeStream)) {
          pushCandidate(state.candidates, fifeStream);
          state.downloadUrl ||= fifeStream;
          state.streamUrl ||= fifeStream;
        } else {
          const mm22 = rewriteFifeUrl(fifeStream, "mm,22,15");
          const mm18 = rewriteFifeUrl(fifeStream, "mm,18,15");
          const dv = rewriteFifeUrl(fifeStream, "dv");
          pushCandidate(state.candidates, mm22);
          pushCandidate(state.candidates, mm18);
          pushCandidate(state.candidates, dv);
          state.streamUrl ||= mm22;
        }
      }
    }

    const image = slotAt(proto, 6);
    if (Array.isArray(image)) {
      const i5 = slotAt(image, 5);
      for (const entryVal of [slotAt(i5, 1), slotAt(i5, 2)]) {
        const direct =
          asDirectUrl(entryVal) ||
          (Array.isArray(entryVal) ? asDirectUrl(entryVal[0]) : null);
        if (!direct) continue;
        pushCandidate(state.candidates, direct);
        state.downloadUrl ||= direct;
        state.streamUrl ||= direct;
      }

      const i0 = slotAt(image, 0);
      const i1 = slotAt(image, 1);
      for (const rawFife of [
        slotAt(i0, 13),
        slotAt(i1, 3),
        slotAt(i5, 0),
      ]) {
        const direct = asDirectUrl(rawFife);
        if (!direct) continue;
        if (isSignedUrl(direct)) {
          pushCandidate(state.candidates, direct);
          state.downloadUrl ||= direct;
          state.streamUrl ||= direct;
        } else {
          const dUrl = rewriteFifeUrl(direct, "d");
          const s0Url = rewriteFifeUrl(direct, "s0");
          const s1600Url = rewriteFifeUrl(direct, "s1600-rw");
          pushCandidate(state.candidates, dUrl);
          pushCandidate(state.candidates, s0Url);
          pushCandidate(state.candidates, s1600Url);
          state.downloadUrl ||= dUrl;
          state.streamUrl ||= s1600Url;
        }
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
    streamUrl: null,
    downloadUrl: null,
    candidates: [],
  };
  let lastErr = await fetchAs29s([cacheKey], state);
  const hasSigned = state.candidates.some(isSignedUrl);
  if (!hasSigned || !state.streamUrl) {
    const secondErr = await fetchAs29s([cacheKey, null, [1]], state);
    if (secondErr && !lastErr) {
      lastErr = secondErr;
    }
  }
  if (state.candidates.length === 0) {
    return { ok: false, error: lastErr || "no_video_url_in_proto" };
  }
  const finalDl = state.downloadUrl || state.candidates[0];
  const finalUrl = state.streamUrl || finalDl;
  runtimeState.mediaInfoCache.set(cacheKey, {
    url: finalUrl,
    download_url: finalDl,
    candidates: state.candidates.slice(),
  });
  return {
    ok: true,
    url: finalUrl,
    download_url: finalDl,
    candidates: state.candidates.slice(),
  };
}
