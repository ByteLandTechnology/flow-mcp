// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Fetch media bytes inside Chrome using credentials matched to same-origin proxies and CDNs.

import { fifeEnv } from "./dom";
import type { FetchedMediaPayload } from "./types";

/** Fetches `u`, checks `Content-Type` against `expectedKind`, and returns Base64 bytes. */
export async function fetchMedia(
  u: string,
  expectedKind: string,
): Promise<FetchedMediaPayload> {
  const kind = expectedKind ? String(expectedKind).toLowerCase() : "";
  const parsed = ((): URL | null => {
    try {
      return new URL(u, location.href);
    } catch {
      return null;
    }
  })();

  const env = fifeEnv();
  const isSignedCdn = Boolean(parsed && env.isSignedCdnHost(parsed));

  const modes: RequestCredentials[] = isSignedCdn
    ? ["omit"]
    : parsed && parsed.origin === location.origin
      ? ["same-origin", "include"]
      : ["same-origin", "include", "omit"];

  let r: Response | null = null;
  let lastErr: unknown = null;
  for (const mode of modes) {
    try {
      const resp = await fetch(u, { credentials: mode });
      if (resp.ok) {
        r = resp;
        break;
      }
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  if (!r) {
    throw lastErr instanceof Error
      ? lastErr
      : new Error(String(lastErr || "Media fetch failed"));
  }
  const ct = r.headers.get("content-type") || null;
  if (
    ct &&
    /^\s*(?:text\/|application\/(?:json|xml|dash\+xml|xhtml\+xml|vnd\.apple\.mpegurl)|audio\/mpegurl)\b/i.test(
      ct,
    )
  ) {
    throw new Error(`Media URL returned non-media content-type: ${ct}`);
  }
  if (ct && kind === "video" && /^\s*(?:image|audio)\//i.test(ct)) {
    throw new Error(`Media URL returned non-video content-type: ${ct}`);
  }
  if (
    ct &&
    (kind === "image" || kind === "character") &&
    /^\s*(?:video|audio)\//i.test(ct)
  ) {
    throw new Error(`Media URL returned non-image content-type: ${ct}`);
  }
  const buf = await r.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.length === 0) {
    throw new Error("Media URL returned empty body");
  }
  const chunks: string[] = [];
  const chunk = 0x4000;
  for (let i = 0; i < bytes.length; i += chunk) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunk)));
  }
  return {
    b64: btoa(chunks.join("")),
    contentType: ct,
    disposition: r.headers.get("content-disposition") || null,
  };
}
