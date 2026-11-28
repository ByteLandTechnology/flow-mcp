// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Export multi-clip or trimmed Google Flow scenes via verified Angular KD RPCs.

import { readOwn } from "./angular";
import { discoverStore } from "./discover_store";
import { delay, isTrashedTile, legacyMedia } from "./dom";
import { readBuildLabel } from "./frontend_builds";
import { currentProjectStore, projectInRoute } from "./project_store";
import { sceneExportFormat, type SceneExportBuildFormat } from "./scene_export_builds";
import { sceneContents } from "./scene_tiles";
import { runtimeState } from "./state";
import type { FlowMediaPayload, SceneClipItem, SceneExportResult } from "./types";

/** Maximum number of `IxdSwd` status polls per scene export job. */
const MAX_SCENE_EXPORT_POLLS = 25;

/** Default poll interval in milliseconds matching Flow `vHb`. */
const DEFAULT_POLL_DELAY_MS = 3000;

/** Hard wall-clock budget in milliseconds, kept 30 seconds below the 120-second Rust CDP timeout. */
const SCENE_EXPORT_BUDGET_MS = 90_000;

/** Sentinel returned when an awaited step exceeds the scene export deadline. */
const DEADLINE_EXCEEDED = Symbol("scene_export_deadline");

/** Time in milliseconds to retain an unconsumed exported `blob:` URL. */
const EXPORT_BLOB_TTL_MS = 120_000;

/** Active exported `blob:` URLs awaiting browser fetch and revocation. */
const exportedBlobUrls = new Map<string, ReturnType<typeof setTimeout>>();

/** Minimal shape of the Angular `KD` (`ImmutableGenericDataInterface`) client. */
interface GenericDataClient {
  /** Sends a unary RPC request built by `kx.prototype.Eb`. */
  fetch: (request: unknown) => Promise<unknown>;
}

/** Constructable JSPB message class. */
type ProtoCtor = new (raw?: unknown) => object;

/** Constructable unary RPC descriptor class (`kx`). */
type UnaryDescriptorCtor = new (spec: Record<PropertyKey, unknown>) => {
  /** Builds a unary RPC transport request from a cloned JSPB message. */
  Eb: (message: unknown) => unknown;
};

/** Verified runtime functions and constructors bound from the Flow namespace. */
interface BoundSceneExportSymbols {
  /** Angular DI token for `KD`. */
  dataToken: unknown;
  /** Optional Angular video service constructor (`bO`). */
  videoServiceCtor: Function | null;
  /** Unary RPC descriptor constructor (`kx`). */
  UnaryDescriptor: UnaryDescriptorCtor;
  /** Marker symbol or key set to `true` on raw descriptor objects (`Zw`). */
  descriptorMarker: PropertyKey;
  /** Base JSPB message class (`n`). */
  ProtoBase: ProtoCtor;
  /** Request constructor for `GjQLTd`. */
  StartRequest: ProtoCtor;
  /** Response constructor for `GjQLTd`. */
  StartResponse: ProtoCtor;
  /** Request constructor for `IxdSwd`. */
  PollRequest: ProtoCtor;
  /** Response constructor for `IxdSwd`. */
  PollResponse: ProtoCtor;
  /** Clip message constructor (`WBb`). */
  ClipMessage: ProtoCtor;
  /** Sets the clip media ID field (`TBb`). */
  setClipMediaId: (msg: object, mediaId: string) => object;
  /** Sets the clip start duration field (`UBb`). */
  setClipStart: (msg: object, duration: unknown) => object;
  /** Sets the clip end duration field (`VBb`). */
  setClipEnd: (msg: object, duration: unknown) => object;
  /** Converts seconds to a frozen `Duration` proto (`zK`). */
  secondsToDuration: (seconds: number) => unknown;
  /** Normalizes a media resource ID (`Iq`). */
  cleanMediaId: (mediaId: string) => string;
  /** Freezes a JSPB message (`dr`). */
  freezeMsg: (msg: object) => object;
  /** Clones a JSPB message for RPC transport (`cc`). */
  cloneMsg: (msg: object) => unknown;
  /** Sets a repeated submessage array (`mv`). */
  setRepeatedSubmessage: (msg: object, field: number, items: unknown[]) => object;
  /** Sets a singular submessage (`al`). */
  setSubmessage: (msg: object, ctor: ProtoCtor, field: number, value: unknown) => object;
  /** Reads a singular submessage (`X`). */
  getSubmessage: (msg: unknown, ctor: ProtoCtor, field: number) => unknown;
  /** Reads a byte field (`iv`). */
  getBytesField: (msg: unknown, field: number) => unknown;
  /** Converts a JSPB byte wrapper into a `Uint8Array` (`Tc`). */
  bytesToUint8Array: (bytes: unknown) => Uint8Array;
}

/** Revokes and forgets an exported scene `blob:` URL if tracked. */
export function consumeExportedBlobUrl(url: string): void {
  const timer = exportedBlobUrls.get(url);
  if (timer !== undefined) {
    clearTimeout(timer);
    exportedBlobUrls.delete(url);
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Ignore revocation failures on already-released object URLs.
    }
  }
}

/** Registers an exported `blob:` URL with a bounded lifetime. */
function trackExportedBlobUrl(url: string): void {
  const timer = setTimeout(() => {
    exportedBlobUrls.delete(url);
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Ignore revocation failures on expired object URLs.
    }
  }, EXPORT_BLOB_TTL_MS);
  exportedBlobUrls.set(url, timer);
}

/** Resolves and validates all compiled Angular symbols required by `format`. */
async function bindSceneExportSymbols(
  format: SceneExportBuildFormat,
): Promise<BoundSceneExportSymbols | null> {
  const ns = readOwn(window, format.namespace);
  if (!ns || typeof ns !== "object") return null;

  if (typeof readOwn(ns, format.clipCtor) !== "function") {
    const loader = readOwn(ns, format.moduleLoader);
    if (typeof loader === "function") {
      try {
        await Promise.resolve((loader as (chunk: string) => unknown).call(ns, format.projectChunk));
      } catch {
        // Symbol check below reports unsupported_front_end when chunk loading fails.
      }
    }
  }

  const dataToken = readOwn(ns, format.dataToken);
  const videoServiceRaw = readOwn(ns, format.videoService);
  const UnaryDescriptor = readOwn(ns, format.unaryDescriptorCtor);
  const descriptorMarker = readOwn(ns, format.descriptorMarker);
  const ProtoBase = readOwn(ns, format.protoBaseCtor);
  const StartRequest = readOwn(ns, format.startRequestCtor);
  const StartResponse = readOwn(ns, format.startResponseCtor);
  const PollRequest = readOwn(ns, format.pollRequestCtor);
  const PollResponse = readOwn(ns, format.pollResponseCtor);
  const ClipMessage = readOwn(ns, format.clipCtor);
  const setClipMediaId = readOwn(ns, format.setClipMediaId);
  const setClipStart = readOwn(ns, format.setClipStart);
  const setClipEnd = readOwn(ns, format.setClipEnd);
  const secondsToDuration = readOwn(ns, format.secondsToDuration);
  const cleanMediaId = readOwn(ns, format.cleanMediaId);
  const freezeMsg = readOwn(ns, format.freezeMsg);
  const cloneMsg = readOwn(ns, format.cloneMsg);
  const setRepeatedSubmessage = readOwn(ns, format.setRepeatedSubmessage);
  const setSubmessage = readOwn(ns, format.setSubmessage);
  const getSubmessage = readOwn(ns, format.getSubmessage);
  const getBytesField = readOwn(ns, format.getBytesField);
  const bytesToUint8Array = readOwn(ns, format.bytesToUint8Array);

  if (
    !dataToken ||
    typeof UnaryDescriptor !== "function" ||
    (typeof descriptorMarker !== "symbol" && typeof descriptorMarker !== "string") ||
    typeof ProtoBase !== "function" ||
    typeof StartRequest !== "function" ||
    typeof StartResponse !== "function" ||
    typeof PollRequest !== "function" ||
    typeof PollResponse !== "function" ||
    typeof ClipMessage !== "function" ||
    typeof setClipMediaId !== "function" ||
    typeof setClipStart !== "function" ||
    typeof setClipEnd !== "function" ||
    typeof secondsToDuration !== "function" ||
    typeof cleanMediaId !== "function" ||
    typeof freezeMsg !== "function" ||
    typeof cloneMsg !== "function" ||
    typeof setRepeatedSubmessage !== "function" ||
    typeof setSubmessage !== "function" ||
    typeof getSubmessage !== "function" ||
    typeof getBytesField !== "function" ||
    typeof bytesToUint8Array !== "function"
  ) {
    return null;
  }

  return {
    dataToken,
    videoServiceCtor: typeof videoServiceRaw === "function" ? videoServiceRaw : null,
    UnaryDescriptor: UnaryDescriptor as UnaryDescriptorCtor,
    descriptorMarker,
    ProtoBase: ProtoBase as ProtoCtor,
    StartRequest: StartRequest as ProtoCtor,
    StartResponse: StartResponse as ProtoCtor,
    PollRequest: PollRequest as ProtoCtor,
    PollResponse: PollResponse as ProtoCtor,
    ClipMessage: ClipMessage as ProtoCtor,
    setClipMediaId: setClipMediaId as BoundSceneExportSymbols["setClipMediaId"],
    setClipStart: setClipStart as BoundSceneExportSymbols["setClipStart"],
    setClipEnd: setClipEnd as BoundSceneExportSymbols["setClipEnd"],
    secondsToDuration: secondsToDuration as BoundSceneExportSymbols["secondsToDuration"],
    cleanMediaId: cleanMediaId as BoundSceneExportSymbols["cleanMediaId"],
    freezeMsg: freezeMsg as BoundSceneExportSymbols["freezeMsg"],
    cloneMsg: cloneMsg as BoundSceneExportSymbols["cloneMsg"],
    setRepeatedSubmessage:
      setRepeatedSubmessage as BoundSceneExportSymbols["setRepeatedSubmessage"],
    setSubmessage: setSubmessage as BoundSceneExportSymbols["setSubmessage"],
    getSubmessage: getSubmessage as BoundSceneExportSymbols["getSubmessage"],
    getBytesField: getBytesField as BoundSceneExportSymbols["getBytesField"],
    bytesToUint8Array: bytesToUint8Array as BoundSceneExportSymbols["bytesToUint8Array"],
  };
}

/** Returns `candidate` when it implements `KD.fetch`. */
function asDataClient(candidate: unknown): GenericDataClient | null {
  if (!candidate || typeof candidate !== "object") return null;
  const fetchFn = readOwn(candidate, "fetch");
  return typeof fetchFn === "function" ? (candidate as GenericDataClient) : null;
}

/** Resolves the live `KD` data client from the bound project store or Angular views. */
function locateDataClient(
  format: SceneExportBuildFormat,
  symbols: BoundSceneExportSymbols,
): GenericDataClient | null {
  const projectId = projectInRoute() ?? runtimeState.projectId;
  const store = projectId ? currentProjectStore(projectId) : null;
  if (store) {
    const tilesService = readOwn(store.service, store.format.tilesService);
    const direct = asDataClient(readOwn(tilesService, format.serviceDataField));
    if (direct) return direct;
    if (tilesService && typeof tilesService === "object") {
      for (const key of Object.keys(tilesService)) {
        const sub = readOwn(tilesService, key);
        const nested =
          asDataClient(sub) ?? asDataClient(readOwn(sub, format.serviceDataField));
        if (nested) return nested;
      }
    }
  }

  const views = runtimeState.ngLViewMap;
  if (views instanceof Map) {
    for (const view of views.values()) {
      if (!Array.isArray(view)) continue;
      for (const slot of view) {
        if (!slot || typeof slot !== "object" || slot instanceof Node) continue;
        if (symbols.videoServiceCtor && slot instanceof symbols.videoServiceCtor) {
          const fromSvc = asDataClient(readOwn(slot, format.serviceDataField));
          if (fromSvc) return fromSvc;
        }
        const injector = readOwn(slot, "Ab") ?? slot;
        const getFn = readOwn(injector, "get");
        if (typeof getFn === "function") {
          try {
            const kd: unknown = getFn.call(injector, symbols.dataToken, null);
            const client = asDataClient(kd);
            if (client) return client;
          } catch {
            // Ignore non-Angular get methods.
          }
          if (symbols.videoServiceCtor) {
            try {
              const svc: unknown = getFn.call(injector, symbols.videoServiceCtor, null);
              const client = asDataClient(readOwn(svc, format.serviceDataField));
              if (client) return client;
            } catch {
              // Ignore optional video service lookup misses.
            }
          }
        }
      }
    }
  }
  return null;
}

/** Builds a frozen clip export protobuf message matching the scene download handler of Flow. */
function buildClipMessage(
  clip: SceneClipItem,
  media: FlowMediaPayload | null,
  symbols: BoundSceneExportSymbols,
): object | null {
  const rawMediaId =
    clip.primaryMediaId != null
      ? String(clip.primaryMediaId).trim()
      : media?.id != null
        ? String(media.id).trim()
        : "";
  if (!rawMediaId) return null;
  const mediaId = symbols.cleanMediaId(rawMediaId);
  if (!mediaId) return null;

  const duration =
    typeof clip.nc === "number" && Number.isFinite(clip.nc) && clip.nc > 0
      ? clip.nc
      : typeof clip.rc === "number" && Number.isFinite(clip.rc) && clip.rc > 0
        ? clip.rc
        : typeof media?.durationSeconds === "number" && media.durationSeconds > 0
          ? media.durationSeconds
          : typeof media?.Lf === "number" && media.Lf > 0
            ? media.Lf
            : 8;
  const startSec =
    typeof clip.Ji === "number" && Number.isFinite(clip.Ji)
      ? Math.max(0, clip.Ji)
      : typeof clip.Mh === "number" && Number.isFinite(clip.Mh)
        ? Math.max(0, clip.Mh)
        : typeof media?.Jc === "number" && Number.isFinite(media.Jc)
          ? Math.max(0, media.Jc)
          : 0;
  const rawEnd =
    typeof clip.Ci === "number" && Number.isFinite(clip.Ci) && clip.Ci > 0
      ? clip.Ci
      : typeof clip.Eh === "number" && Number.isFinite(clip.Eh) && clip.Eh > 0
        ? clip.Eh
        : typeof media?.Pc === "number" && Number.isFinite(media.Pc) && media.Pc > 0
          ? media.Pc
          : duration;
  const endSec = Math.max(startSec, rawEnd);

  const msg = new symbols.ClipMessage();
  const withMedia = symbols.setClipMediaId(msg, mediaId);
  const withStart = symbols.setClipStart(withMedia, symbols.secondsToDuration(startSec));
  const withEnd = symbols.setClipEnd(withStart, symbols.secondsToDuration(endSec));
  return symbols.freezeMsg(withEnd);
}

/** Races `work` against `deadlineMs` (`performance.now()` clock) and clears its timer on settle. */
async function raceDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
): Promise<T | typeof DEADLINE_EXCEEDED> {
  const remaining = deadlineMs - performance.now();
  if (remaining <= 0) return DEADLINE_EXCEEDED;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof DEADLINE_EXCEEDED>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_EXCEEDED), remaining);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Exports a multi-clip or trimmed scene through `GjQLTd` and `IxdSwd` on `KD`. */
export async function sceneExport(
  sceneId: string,
  pollDelayMs?: number,
  timeoutMs?: number,
): Promise<SceneExportResult> {
  const trimmedId = String(sceneId || "").trim();
  if (!trimmedId) {
    return { ok: false, error: "missing_scene_id" };
  }
  if (trimmedId.includes(":")) {
    return { ok: false, error: "scene_clip_id_not_scene" };
  }

  const budgetMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(SCENE_EXPORT_BUDGET_MS, Math.max(1000, timeoutMs))
      : SCENE_EXPORT_BUDGET_MS;
  const deadlineMs = performance.now() + budgetMs;

  const format = sceneExportFormat(readBuildLabel());
  if (!format) {
    return { ok: false, error: "unsupported_front_end" };
  }
  const symbolsRes = await raceDeadline(bindSceneExportSymbols(format), deadlineMs);
  if (symbolsRes === DEADLINE_EXCEEDED) {
    return { ok: false, error: "scene_export_timeout" };
  }
  const symbols = symbolsRes;
  if (!symbols) {
    return { ok: false, error: "unsupported_front_end" };
  }

  if (!runtimeState.store || !runtimeState.store.isCurrent() || !runtimeState.store.isReady()) {
    const boundRes = await raceDeadline(discoverStore(), deadlineMs);
    if (boundRes === DEADLINE_EXCEEDED) {
      return { ok: false, error: "scene_export_timeout" };
    }
  }
  const tileMap = runtimeState.store?.getTileMap?.();
  if (!(tileMap instanceof Map)) {
    return { ok: false, error: "store_not_bound" };
  }
  const sceneTile = tileMap.get(trimmedId);
  if (
    !sceneTile ||
    isTrashedTile(sceneTile) ||
    String(sceneTile.type ?? "").toUpperCase() !== "SCENE"
  ) {
    return { ok: false, error: "scene_not_found" };
  }

  const { clips, history } = sceneContents(sceneTile);
  if (clips.length === 0) {
    return { ok: false, error: "scene_empty" };
  }

  const clipMessages: object[] = [];
  for (const clip of clips) {
    const wfId = clip.workflowId != null ? String(clip.workflowId) : "";
    const histList = wfId ? history.get(wfId) : undefined;
    const rawClipMid = clip.primaryMediaId != null ? symbols.cleanMediaId(String(clip.primaryMediaId)) : "";
    const rawMedia = Array.isArray(histList)
      ? histList.find((m) => m && symbols.cleanMediaId(String(m.id ?? "")) === rawClipMid) ??
        histList[0] ??
        null
      : null;
    const built = buildClipMessage(clip, legacyMedia(rawMedia), symbols);
    if (!built) {
      return { ok: false, error: "scene_clip_missing_media_id" };
    }
    clipMessages.push(built);
  }

  let dataClient = locateDataClient(format, symbols);
  if (!dataClient) {
    const retryStore = await raceDeadline(discoverStore(), deadlineMs);
    if (retryStore === DEADLINE_EXCEEDED) {
      return { ok: false, error: "scene_export_timeout" };
    }
    dataClient = locateDataClient(format, symbols);
  }
  if (!dataClient) {
    return { ok: false, error: "scene_export_service_unavailable" };
  }

  const startSpec: Record<PropertyKey, unknown> = {
    Xa: format.startRpcId,
    kb: undefined,
    hb: true,
    Ya: symbols.StartResponse,
    lb: symbols.StartRequest,
  };
  startSpec[symbols.descriptorMarker] = true;
  const startDescriptor = new symbols.UnaryDescriptor(startSpec);

  const pollSpec: Record<PropertyKey, unknown> = {
    Xa: format.pollRpcId,
    kb: undefined,
    hb: true,
    Ya: symbols.PollResponse,
    lb: symbols.PollRequest,
  };
  pollSpec[symbols.descriptorMarker] = true;
  const pollDescriptor = new symbols.UnaryDescriptor(pollSpec);

  const OpTokenCtor = class extends symbols.ProtoBase {
    constructor(raw?: unknown) {
      super(raw);
    }
  };

  try {
    const startReq = symbols.setRepeatedSubmessage(
      new symbols.StartRequest(),
      format.startClipsField,
      clipMessages,
    );
    const startResp = await raceDeadline(
      dataClient.fetch(startDescriptor.Eb(symbols.cloneMsg(startReq))),
      deadlineMs,
    );
    if (startResp === DEADLINE_EXCEEDED) {
      return { ok: false, error: "scene_export_timeout" };
    }
    const operationToken = symbols.getSubmessage(
      startResp,
      OpTokenCtor,
      format.startOperationField,
    );
    if (!operationToken) {
      return { ok: false, error: "scene_export_missing_operation" };
    }

    const waitMs =
      typeof pollDelayMs === "number" && Number.isFinite(pollDelayMs) && pollDelayMs >= 0
        ? pollDelayMs
        : DEFAULT_POLL_DELAY_MS;

    for (let attempt = 0; attempt < MAX_SCENE_EXPORT_POLLS; attempt += 1) {
      if (performance.now() >= deadlineMs) {
        return { ok: false, error: "scene_export_timeout" };
      }
      if (waitMs > 0) {
        const stepWait = attempt === 0 ? Math.min(1000, waitMs) : waitMs;
        const waited = await raceDeadline(delay(stepWait), deadlineMs);
        if (waited === DEADLINE_EXCEEDED || performance.now() >= deadlineMs) {
          return { ok: false, error: "scene_export_timeout" };
        }
      }
      const pollReq = symbols.setSubmessage(
        new symbols.PollRequest(),
        OpTokenCtor,
        format.pollOperationField,
        operationToken,
      );
      const pollResp = await raceDeadline(
        dataClient.fetch(pollDescriptor.Eb(symbols.cloneMsg(pollReq))),
        deadlineMs,
      );
      if (pollResp === DEADLINE_EXCEEDED) {
        return { ok: false, error: "scene_export_timeout" };
      }
      const statusFn = readOwn(pollResp, format.pollStatusMethod);
      const status =
        typeof statusFn === "function" ? statusFn.call(pollResp) : undefined;

      if (status === 3) {
        const rawBytesField = symbols.getBytesField(pollResp, format.pollBytesField);
        const mp4Bytes = rawBytesField == null ? null : symbols.bytesToUint8Array(rawBytesField);
        if (!mp4Bytes || mp4Bytes.byteLength === 0) {
          return { ok: false, error: "scene_export_empty_payload" };
        }
        const safeBytes = new Uint8Array(mp4Bytes.byteLength);
        safeBytes.set(mp4Bytes);
        const blobUrl = URL.createObjectURL(new Blob([safeBytes], { type: "video/mp4" }));
        trackExportedBlobUrl(blobUrl);
        return { ok: true, url: blobUrl, contentType: "video/mp4" };
      }
      if (status === 1 || status === 2 || status === 6) {
        continue;
      }
      if (status === 0 || status === 4 || status === 5 || status === 7) {
        return { ok: false, error: `scene_export_failed_${String(status)}` };
      }
      return { ok: false, error: `scene_export_unexpected_status_${String(status)}` };
    }

    return { ok: false, error: "scene_export_timeout" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message || "scene_export_rpc_failed" };
  }
}
