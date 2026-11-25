// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Export multi-clip or trimmed scenes via GjQLTd and IxdSwd batchexecute RPCs.

import { readBuildLabel } from "./frontend_builds";
import { cleanMediaIdKey, sceneClipTrimState } from "./media_variants";
import { sceneContents } from "./scene_tiles";
import { runtimeState } from "./state";
import type { SceneExportRequest, SceneExportResult } from "./types";

/** Staged scene export job token awaiting `IxdSwd` completion. */
interface PendingSceneExport {
  /** Raw JSPB operation token returned at field `2` of `GjQLTd`. */
  opToken: unknown;
  /** Timestamp when the job started in epoch milliseconds. */
  createdAt: number;
}

/** Revocation delay for staged MP4 `blob:` URLs in milliseconds (5 minutes). */
const STAGED_BLOB_TTL_MS = 5 * 60 * 1000;

/** Retention limit for unfinished export handles in milliseconds (10 minutes). */
const PENDING_EXPORT_TTL_MS = 10 * 60 * 1000;

/** Active scene export operation handles keyed by generated `export_id`. */
const pendingExports = new Map<string, PendingSceneExport>();

/** Staged `blob:` URL cleanup timers keyed by object URL. */
const stagedBlobTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Monotonic counter for local `export_id` keys. */
let nextExportSeq = 1;

/** Returns true when `val` is a plain sparse JSPB field map object. */
function isSparseMap(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

/** Reads 1-based protobuf `fieldNumber` from a dense JSPB array or trailing sparse map. */
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

/** Encodes a `google.protobuf.Duration` value in seconds into its Closure JSPB array layout. */
function encodeDurationJspb(secondsValue: number): Array<number | null> {
  if (!Number.isFinite(secondsValue) || secondsValue === 0) {
    return [];
  }
  const sign = secondsValue < 0 ? -1 : 1;
  const abs = Math.abs(secondsValue);
  let whole = Math.floor(abs);
  let nanos = Math.round((abs - whole) * 1e9);
  if (nanos >= 1e9) {
    whole += 1;
    nanos -= 1e9;
  }
  const signedSec = whole === 0 ? 0 : sign * whole;
  const signedNanos = nanos === 0 ? 0 : sign * nanos;
  if (signedNanos === 0) {
    return signedSec === 0 ? [] : [signedSec];
  }
  return [signedSec === 0 ? null : signedSec, signedNanos];
}

/** Decodes a standard or URL-safe Base64 string (or byte array) into a `Uint8Array`. */
function decodeProtoBytes(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) {
    return raw.byteLength > 0 ? raw : null;
  }
  if (Array.isArray(raw) && raw.every((n) => typeof n === "number")) {
    return raw.length > 0 ? new Uint8Array(raw) : null;
  }
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLen);
  try {
    const binary = atob(padded);
    if (binary.length === 0) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Stages MP4 bytes in a browser `Blob` URL and schedules automatic revocation. */
function stageMp4Blob(bytes: Uint8Array): string {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: "video/mp4" });
  const blobUrl = URL.createObjectURL(blob);
  const timer = setTimeout(() => {
    stagedBlobTimers.delete(blobUrl);
    URL.revokeObjectURL(blobUrl);
  }, STAGED_BLOB_TTL_MS);
  stagedBlobTimers.set(blobUrl, timer);
  return blobUrl;
}

/** Releases a previously staged `blob:` URL immediately. */
function releaseStagedBlob(blobUrl: string): void {
  const timer = stagedBlobTimers.get(blobUrl);
  if (timer !== undefined) {
    clearTimeout(timer);
    stagedBlobTimers.delete(blobUrl);
  }
  if (blobUrl.startsWith("blob:")) {
    URL.revokeObjectURL(blobUrl);
  }
}

/** Prunes expired operation handles from `pendingExports`. */
function pruneExpiredHandles(nowMs = Date.now()): void {
  for (const [key, item] of pendingExports.entries()) {
    if (nowMs - item.createdAt >= PENDING_EXPORT_TTL_MS) {
      pendingExports.delete(key);
    }
  }
}

/** Executes one `batchexecute` RPC and returns the parsed `wrb.fr` payload array. */
async function callBatchExecuteRpc(
  rpcId: string,
  innerArgs: unknown[],
  timeoutMs: number,
): Promise<{ ok: true; proto: unknown } | { ok: false; error: string }> {
  const wiz = window.WIZ_global_data || {};
  const at = typeof wiz.SNlM0e === "string" ? wiz.SNlM0e : "";
  const sid = typeof wiz.FdrFJe === "string" ? wiz.FdrFJe : "";
  const bl = readBuildLabel() ?? (typeof wiz.cfb2h === "string" ? wiz.cfb2h : "");
  if (!at) {
    return { ok: false, error: "missing_wiz_token" };
  }

  const reqPayload = JSON.stringify([
    [[rpcId, JSON.stringify(innerArgs), null, "generic"]],
  ]);
  const params = new URLSearchParams({
    rpcids: rpcId,
    "source-path": location.pathname || "/",
    bl,
    "f.sid": sid,
    hl: "en",
    rt: "c",
  });
  const body = `f.req=${encodeURIComponent(reqPayload)}&at=${encodeURIComponent(at)}`;
  try {
    const resp = await fetch(
      `/_/AiSandboxAngularFrontend/data/batchexecute?${params.toString()}`,
      {
        method: "POST",
        credentials: "include",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body,
      },
    );
    if (!resp.ok) {
      return { ok: false, error: `http_${resp.status}` };
    }
    const text = await resp.text();
    for (const line of text.split(/\r?\n/)) {
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
          Array.isArray(entry) &&
          entry[0] === "wrb.fr" &&
          entry[1] === rpcId &&
          typeof entry[2] === "string"
        ) {
          try {
            return { ok: true, proto: JSON.parse(entry[2]) };
          } catch {
            return { ok: false, error: "invalid_rpc_proto_json" };
          }
        }
      }
    }
    return { ok: false, error: `empty_${rpcId}_response` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Inspects an `IxdSwd` response message and stages state `3` MP4 bytes as a `blob:` URL. */
function interpretExportPollProto(
  exportId: string,
  proto: unknown,
): SceneExportResult {
  const rawState = jspbField(proto, 1);
  const state = typeof rawState === "number" ? rawState : Number(rawState ?? 0);
  if (state === 3) {
    pendingExports.delete(exportId);
    const rawBytes = jspbField(proto, 5);
    const bytes = decodeProtoBytes(rawBytes);
    if (!bytes || bytes.byteLength === 0) {
      return { ok: false, error: "scene_export_empty_mp4" };
    }
    const blobUrl = stageMp4Blob(bytes);
    return { ok: true, status: "ready", blob_url: blobUrl };
  }
  if (state === 1 || state === 2 || state === 6) {
    return { ok: true, status: "pending", export_id: exportId };
  }
  pendingExports.delete(exportId);
  return {
    ok: false,
    error: `scene_export_failed_state_${String(state)}`,
  };
}

/** Starts, polls, or releases a Google Flow scene MP4 export over `batchexecute`. */
export async function exportScene(
  req: SceneExportRequest,
): Promise<SceneExportResult> {
  pruneExpiredHandles();
  const action = req?.action ?? "start";
  const rpcTimeoutMs =
    typeof req?.timeout_ms === "number" && req.timeout_ms > 0
      ? req.timeout_ms
      : 10_000;

  if (action === "release") {
    if (typeof req.blob_url === "string" && req.blob_url) {
      releaseStagedBlob(req.blob_url);
    }
    if (typeof req.export_id === "string" && req.export_id) {
      pendingExports.delete(req.export_id);
    }
    return { ok: true, status: "released" };
  }

  if (action === "poll") {
    const exportId = typeof req.export_id === "string" ? req.export_id.trim() : "";
    const pending = exportId ? pendingExports.get(exportId) : undefined;
    if (!pending) {
      return { ok: false, error: "unknown_scene_export_id" };
    }
    const pollRes = await callBatchExecuteRpc("IxdSwd", [pending.opToken], rpcTimeoutMs);
    if (!pollRes.ok) {
      return pollRes;
    }
    return interpretExportPollProto(exportId, pollRes.proto);
  }

  if (action !== "start") {
    return { ok: false, error: "unknown_scene_export_action" };
  }

  const sceneId = typeof req.scene_id === "string" ? req.scene_id.trim() : "";
  if (!sceneId) {
    return { ok: false, error: "missing_scene_id" };
  }
  const tileMap = runtimeState.store?.getTileMap();
  if (!(tileMap instanceof Map)) {
    return { ok: false, error: "store_not_bound" };
  }
  const tile =
    tileMap.get(sceneId) ??
    Array.from(tileMap.values()).find((t) => String(t?.id ?? "") === sceneId);
  if (!tile) {
    return { ok: false, error: "scene_not_found" };
  }

  const { clips } = sceneContents(tile);
  if (clips.length === 0) {
    return { ok: false, error: "scene_has_no_clips" };
  }

  const clipSpecs: unknown[] = [];
  for (const clip of clips) {
    const mediaId = cleanMediaIdKey(clip?.primaryMediaId);
    if (!mediaId) {
      return { ok: false, error: "scene_clip_missing_media_id" };
    }
    const { startSec, endSec } = sceneClipTrimState(clip);
    clipSpecs.push([
      mediaId,
      null,
      encodeDurationJspb(startSec),
      encodeDurationJspb(endSec),
    ]);
  }

  const startRes = await callBatchExecuteRpc("GjQLTd", [clipSpecs], rpcTimeoutMs);
  if (!startRes.ok) {
    return startRes;
  }
  const opToken = jspbField(startRes.proto, 2);
  if (opToken == null || (!Array.isArray(opToken) && !isSparseMap(opToken))) {
    return { ok: false, error: "missing_scene_export_token" };
  }

  const exportId = `scene-export-${Date.now()}-${nextExportSeq++}`;
  pendingExports.set(exportId, {
    opToken,
    createdAt: Date.now(),
  });
  return { ok: true, status: "pending", export_id: exportId };
}
