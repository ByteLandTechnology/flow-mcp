// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Observe in-page batchexecute responses and buffer structured wrb.fr and er errors.

import type { BufferedRpcError } from "./types";

/** Maximum number of structured RPC error entries retained in the ring buffer. */
const MAX_RPC_ERROR_ENTRIES = 64;

/** Maximum character length of one buffered RPC error message. */
const MAX_RPC_ERROR_MESSAGE_CHARS = 500;

/** Read-only internal probe RPC identifiers excluded from the error ring buffer. */
const IGNORED_PROBE_RPC_IDS = new Set(["cPZSdc", "as29s"]);

/** Batchexecute RPC identifiers for Google Flow generation, transform, and upload actions. */
export const TRACKED_GENERATION_RPC_IDS = [
  "Z9cAtf",
  "ogiZ0b",
  "YhhmEf",
  "MZZa6b",
  "eb1hJf",
  "nprQif",
  "jIps6",
  "fZytfe",
  "p0UkFb",
  "IJhj9c",
  "xNyCid",
  "LcEY2c",
  "SPrCad",
  "sAVZzc",
  "jeNy9c",
  "maseQ",
] as const;

/** Metadata recorded passively for an in-flight XMLHttpRequest to batchexecute. */
interface BatchXhrMeta {
  /** Request URL passed to `XMLHttpRequest.prototype.open`. */
  url: string;
  /** Serialized text body passed to `XMLHttpRequest.prototype.send`, when available. */
  body: string | null;
  /** True once the completed response for this `open` cycle has been inspected. */
  recorded: boolean;
}

/** Bounded FIFO ring buffer of captured batchexecute error entries. */
const rpcErrorRing: BufferedRpcError[] = [];

/** Monotonic sequence counter assigned to buffered RPC error entries. */
let nextRpcErrorSeq = 1;

/** Guard that prevents duplicate transport hooks in the same document. */
let interceptorInstalled = false;

/** Truncates `raw` to at most `MAX_RPC_ERROR_MESSAGE_CHARS` Unicode code points. */
function truncateErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  const chars = Array.from(trimmed);
  return chars.length <= MAX_RPC_ERROR_MESSAGE_CHARS
    ? trimmed
    : chars.slice(0, MAX_RPC_ERROR_MESSAGE_CHARS).join("");
}

/** Appends one error entry to `rpcErrorRing` and evicts oldest entries past 64. */
function pushRpcError(entry: Omit<BufferedRpcError, "seq">): void {
  const message = truncateErrorMessage(entry.message);
  if (!message) return;
  rpcErrorRing.push({
    ...entry,
    message,
    seq: nextRpcErrorSeq++,
  });
  while (rpcErrorRing.length > MAX_RPC_ERROR_ENTRIES) {
    rpcErrorRing.shift();
  }
}

/** Returns true when `url` targets a Google Boq `batchexecute` endpoint. */
function isBatchExecuteUrl(url: string): boolean {
  return url.includes("batchexecute");
}

/** Extracts text from a fetch or XHR request body without consuming streams. */
function readBodyString(body: unknown): string | null {
  if (typeof body === "string") return body;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return body.toString();
  }
  return null;
}

/** Extracts candidate RPC identifiers from `url` query parameters and `f.req` form data. */
function extractRequestRpcIds(url: string, bodyText: string | null): string[] {
  const ids: string[] = [];
  const addId = (candidate: string): void => {
    const clean = candidate.trim();
    if (/^[A-Za-z0-9_]{4,12}$/.test(clean) && !ids.includes(clean)) {
      ids.push(clean);
    }
  };

  try {
    const parsed = new URL(url, location.origin);
    const rawParam = parsed.searchParams.get("rpcids") || "";
    for (const part of rawParam.split(",")) {
      if (part) addId(part);
    }
  } catch {
    const match = /[?&]rpcids=([^&#]+)/.exec(url);
    if (match) {
      for (const part of decodeURIComponent(match[1]).split(",")) {
        if (part) addId(part);
      }
    }
  }

  if (bodyText) {
    let freq = bodyText;
    if (bodyText.includes("f.req=")) {
      try {
        freq = new URLSearchParams(bodyText).get("f.req") || bodyText;
      } catch {
        // Keep raw body string when URLSearchParams decoding fails.
      }
    }
    try {
      const outer: unknown = JSON.parse(freq);
      if (Array.isArray(outer) && Array.isArray(outer[0])) {
        for (const call of outer[0]) {
          if (Array.isArray(call) && typeof call[0] === "string") {
            addId(call[0]);
          }
        }
      }
    } catch {
      const re = /\[\s*"([A-Za-z0-9_]{4,12})"\s*,/g;
      let hit = re.exec(freq);
      while (hit) {
        addId(hit[1]);
        hit = re.exec(freq);
      }
    }
  }

  return ids;
}

/** Collects human-readable detail strings nested inside a JSPB error detail structure. */
function collectNestedStrings(node: unknown, out: string[], depth: number): void {
  if (depth <= 0 || out.length >= 6 || node == null) return;
  if (typeof node === "string") {
    const clean = node.trim();
    if (
      clean &&
      !clean.startsWith("type.googleapis.com/") &&
      !/^[a-z0-9_.-]+\.[A-Za-z0-9_]+$/.test(clean) &&
      !out.includes(clean)
    ) {
      out.push(clean);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectNestedStrings(child, out, depth - 1);
    }
    return;
  }
  if (typeof node === "object") {
    const msg = (node as { message?: unknown }).message;
    if (typeof msg === "string") {
      collectNestedStrings(msg, out, depth - 1);
    }
  }
}

/** Formats code and message fields from a `wrb.fr` error payload at `entry[5]`. */
function extractWrbError(rpcErr: unknown): { code: number | null; message: string } {
  if (typeof rpcErr === "string") {
    return { code: null, message: rpcErr.trim() || "RPC failed" };
  }
  if (typeof rpcErr === "number") {
    return { code: rpcErr, message: `RPC error code ${rpcErr}` };
  }
  if (Array.isArray(rpcErr)) {
    const code = typeof rpcErr[0] === "number" ? rpcErr[0] : null;
    const primary = typeof rpcErr[1] === "string" ? rpcErr[1].trim() : "";
    const details: string[] = [];
    if (rpcErr.length > 2) {
      collectNestedStrings(rpcErr.slice(2), details, 5);
    }
    const detailSuffix = details.filter((d) => d !== primary).join("; ");
    const combined = primary && detailSuffix
      ? `${primary} (${detailSuffix})`
      : primary || detailSuffix;
    if (combined) {
      return { code, message: combined };
    }
    return {
      code,
      message: code !== null ? `RPC error code ${code}` : "RPC failed",
    };
  }
  if (rpcErr && typeof rpcErr === "object") {
    const msg = (rpcErr as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) {
      return { code: null, message: msg.trim() };
    }
    try {
      return { code: null, message: JSON.stringify(rpcErr) };
    } catch {
      return { code: null, message: "RPC failed" };
    }
  }
  return { code: null, message: "RPC failed" };
}

/** Formats code and message fields from an envelope-level `["er", ...]` frame. */
function extractErFrame(
  entry: unknown[],
  requestRpcIds: string[],
): { rpcId: string; code: number | null; message: string } {
  const code =
    typeof entry[5] === "number"
      ? entry[5]
      : typeof entry[1] === "number"
        ? entry[1]
        : typeof entry[2] === "number"
          ? entry[2]
          : null;
  const entryRpcId =
    typeof entry[1] === "string" && /^[A-Za-z0-9_]{4,12}$/.test(entry[1].trim())
      ? entry[1].trim()
      : null;
  const rpcId = requestRpcIds[0] ?? entryRpcId ?? "er";
  const parts: string[] = [];
  for (const field of [entry[2], entry[4], entry[3], entry[1]]) {
    if (typeof field === "string" && field.trim() === rpcId) continue;
    collectNestedStrings(field, parts, 4);
  }
  const message =
    parts.join("; ") ||
    (code !== null ? `Batch RPC error code ${code}` : "Batch RPC error");
  return { rpcId, code, message };
}

/** Parses one `batchexecute` response payload and appends any `wrb.fr` or `er` errors. */
export function recordBatchExecuteResponse(
  url: string,
  requestRpcIds: string[],
  status: number,
  bodyText: string,
): void {
  if (!bodyText || (!bodyText.includes("wrb.fr") && !bodyText.includes('"er"'))) {
    return;
  }
  const rpcIdsFromReq =
    requestRpcIds.length > 0 ? requestRpcIds : extractRequestRpcIds(url, null);
  for (const rawLine of bodyText.split(/\r?\n/)) {
    const line = rawLine.replace(/^\)\]\}'\s*/, "").trim();
    if (!line.startsWith("[")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    const frames: unknown[] =
      parsed[0] === "wrb.fr" || parsed[0] === "er" ? [parsed] : parsed;
    for (const frame of frames) {
      if (!Array.isArray(frame) || frame.length === 0) continue;
      const tag = frame[0];
      if (tag === "wrb.fr") {
        const rpcId =
          typeof frame[1] === "string" && frame[1].trim()
            ? frame[1].trim()
            : (rpcIdsFromReq[0] ?? "wrb.fr");
        if (IGNORED_PROBE_RPC_IDS.has(rpcId)) continue;
        const hasData =
          frame[2] != null || frame[9] != null || frame[10] != null;
        if (hasData || frame[5] == null) continue;
        const { code, message } = extractWrbError(frame[5]);
        const rpcIds = Array.from(new Set([rpcId, ...rpcIdsFromReq]));
        pushRpcError({
          kind: "wrb.fr",
          rpc_id: rpcId,
          rpc_ids: rpcIds,
          code,
          status,
          message,
        });
      } else if (tag === "er") {
        if (
          rpcIdsFromReq.length > 0 &&
          rpcIdsFromReq.every((id) => IGNORED_PROBE_RPC_IDS.has(id))
        ) {
          continue;
        }
        const { rpcId, code, message } = extractErFrame(frame, rpcIdsFromReq);
        if (IGNORED_PROBE_RPC_IDS.has(rpcId)) continue;
        const rpcIds =
          rpcIdsFromReq.length > 0
            ? rpcIdsFromReq.slice()
            : rpcId !== "er"
              ? [rpcId]
              : [];
        pushRpcError({
          kind: "er",
          rpc_id: rpcId,
          rpc_ids: rpcIds,
          code,
          status,
          message,
        });
      }
    }
  }
}

/** Clears all buffered RPC errors before starting a new user operation. */
export function clearRpcErrors(): void {
  rpcErrorRing.length = 0;
}

/** Drains and returns buffered RPC errors matching `rpcIds` (or all errors when omitted). */
export function drainRpcErrors(
  rpcIds?: readonly string[] | null,
): BufferedRpcError[] {
  if (!rpcIds || rpcIds.length === 0) {
    return rpcErrorRing.splice(0, rpcErrorRing.length);
  }
  const wanted = new Set(
    rpcIds.map((id) => String(id).trim()).filter(Boolean),
  );
  if (wanted.size === 0) {
    return rpcErrorRing.splice(0, rpcErrorRing.length);
  }
  const matched: BufferedRpcError[] = [];
  let writeIdx = 0;
  for (let i = 0; i < rpcErrorRing.length; i++) {
    const item = rpcErrorRing[i];
    const hits =
      wanted.has(item.rpc_id) ||
      item.rpc_ids.some((id) => wanted.has(id)) ||
      (item.kind === "er" && item.rpc_ids.length === 0);
    if (hits) {
      matched.push(item);
    } else {
      rpcErrorRing[writeIdx++] = item;
    }
  }
  rpcErrorRing.length = writeIdx;
  return matched;
}

/** Drains matching tracked RPC errors and formats the first failure string, or returns null. */
export function drainTrackedRpcErrorMessage(
  rpcIds: readonly string[] = TRACKED_GENERATION_RPC_IDS,
): string | null {
  const drained = drainRpcErrors(rpcIds);
  if (drained.length === 0) return null;
  const first = drained[0];
  const prefix =
    first.code !== null
      ? `${first.rpc_id} (code ${first.code})`
      : first.rpc_id;
  return truncateErrorMessage(`${prefix}: ${first.message}`);
}

/** Installs passive `fetch` and `XMLHttpRequest` observers for `batchexecute` once per document. */
export function installBatchRpcInterceptor(): void {
  if (interceptorInstalled) return;
  interceptorInstalled = true;

  if (typeof window.fetch === "function") {
    const origFetch = window.fetch;
    const wrappedFetch: typeof window.fetch = function (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      let url = "";
      try {
        url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : typeof Request !== "undefined" && input instanceof Request
                ? input.url
                : "";
      } catch {
        url = "";
      }
      if (!url || !isBatchExecuteUrl(url)) {
        return origFetch.call(window, input, init);
      }
      const reqIds = extractRequestRpcIds(url, readBodyString(init?.body));
      const responsePromise = origFetch.call(window, input, init);
      responsePromise.then(
        (resp) => {
          try {
            const cloned = resp.clone();
            void cloned.text().then(
              (text) => {
                try {
                  recordBatchExecuteResponse(url, reqIds, resp.status, text);
                } catch {
                  // Ignore malformed batch payloads.
                }
              },
              () => {
                // Ignore aborted response reads.
              },
            );
          } catch {
            // Ignore locked or opaque responses.
          }
        },
        () => {
          // Ignore network rejections handled by caller.
        },
      );
      return responsePromise;
    };
    window.fetch = wrappedFetch;
  }

  if (typeof XMLHttpRequest !== "undefined") {
    const xhrMeta = new WeakMap<XMLHttpRequest, BatchXhrMeta>();
    const observedXhrs = new WeakSet<XMLHttpRequest>();
    const proto = XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;

    proto.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ): void {
      try {
        const urlStr = typeof url === "string" ? url : String(url ?? "");
        if (isBatchExecuteUrl(urlStr)) {
          xhrMeta.set(this, { url: urlStr, body: null, recorded: false });
          if (!observedXhrs.has(this)) {
            observedXhrs.add(this);
            this.addEventListener("readystatechange", () => {
              if (this.readyState !== 4) return;
              const cur = xhrMeta.get(this);
              if (!cur || cur.recorded) return;
              cur.recorded = true;
              try {
                if (this.responseType === "" || this.responseType === "text") {
                  const reqIds = extractRequestRpcIds(cur.url, cur.body);
                  recordBatchExecuteResponse(
                    cur.url,
                    reqIds,
                    this.status,
                    this.responseText || "",
                  );
                }
              } catch {
                // Ignore non-text XHR responses.
              }
            });
          }
        } else {
          xhrMeta.delete(this);
        }
      } catch {
        // Ignore non-standard open arguments.
      }
      origOpen.call(
        this,
        method,
        url,
        async ?? true,
        username ?? null,
        password ?? null,
      );
    };

    proto.send = function (
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
      const meta = xhrMeta.get(this);
      if (meta) {
        meta.body = readBodyString(body);
      }
      origSend.call(this, body);
    };
  }
}
