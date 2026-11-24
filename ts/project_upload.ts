// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Upload local media through the native Flow project services.

import { isLiveLView, readOwn, resolveLView } from "./angular";
import { delay, legacyMedia, legacyTile } from "./dom";
import { projectUploadCompatibility } from "./frontend_compatibility";
import { MEDIA_UPLOAD_EXPORTS } from "./frontend_builds";
import type { MediaUploadFields, MediaUploadFormat, ProjectUploadFormat } from "./frontend_builds";
import { uploadUiAction } from "./open_upload_trigger";
import { projectStore } from "./project_store";
import { runtimeState } from "./state";
import type { FlowMediaPayload, FlowTile } from "./types";

/** Maximum time for a local upload batch. */
export const MEDIA_UPLOAD_TIMEOUT_MS = 100_000;

/** Maximum video duration before Flow requires a trim. */
const MAX_VIDEO_SECONDS = 30;

/** Interval between project tile checks while Flow transcodes an uploaded video. */
const TRANSCODE_POLL_INTERVAL_MS = 250;

/** Poll count between explicit tile query refreshes for hidden tabs. */
const TRANSCODE_REFETCH_STEPS = 6;

/** Dimensions of a local image. */
interface ImageSize {
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
}

/** Flow ID and the value that Flow uses to allocate it. */
interface FlowId {
  /** Asset or media ID. */
  id: string;
  /** Value that Flow uses to allocate the ID. */
  seed: string;
}

/** Native functions that prepare a Flow upload. */
interface MediaUploadExports {
  /** Allocates a Flow ID. */
  id(): Promise<FlowId>;
  /** Checks file types, names, and sizes. */
  validateFiles(files: File[]): Record<string, File[] | string[]>;
  /** Returns true for a video file. */
  isVideo(file: File): boolean;
  /** Gets the media MIME type from the file name. */
  mimeType(name: string): string | undefined;
  /** Reads the image dimensions. */
  imageSize(file: File): Promise<ImageSize>;
  /** Reads the video aspect ratio and duration. */
  videoInfo(file: File): Promise<{ aspectRatio: number; [field: string]: number }>;
  /** Runs the native upload consent flow. */
  confirmUpload(service: object, files: File[]): Promise<File[]>;
}

/** Keys used to bind the upload functions of a verified build. */
export type MediaUploadExport = keyof MediaUploadExports;

/** One image or video returned by Flow after upload. */
interface UploadedTile extends FlowTile {
  /** ID that identifies the uploaded asset in the project. */
  id: string;
  /** Asset type returned by Flow. */
  type: "IMAGE" | "VIDEO";
  /** Primary media ID, if Flow returns it. */
  primaryMediaId?: string;
}

/** Uploaded asset in the tool result. */
interface UploadResultAsset {
  /** Asset ID in the project. */
  id: string;
  /** Primary media ID from Flow, if available. */
  primary_media_id?: string;
  /** Display name that Flow gives the asset. */
  name: string;
  /** Type of media in the uploaded asset. */
  kind: "image" | "video";
}

/** Native upload services for a project page. */
interface UploadBinding {
  /** Functions that prepare the upload. */
  flow: MediaUploadExports;
  /** Consent service for this page. */
  consent: object;
  /** Submits a mutation for the bound project. */
  submit: (request: Record<string, unknown>) => void;
  /** Reads the live project tiles from the page store signal. */
  tiles: () => FlowTile[];
  /** Refreshes the project tile query when background polling is inactive. */
  refetchTiles?: () => Promise<unknown>;
  /** Upload fields of the verified build. */
  fields: MediaUploadFields;
}

/** Files and context for one upload batch. */
interface UploadInput {
  /** ID of the project that owns the uploads. */
  projectId: string;
  /** Optional collection ID when the active route shows a collection view. */
  collectionId?: string;
  /** Returns true while the bound project is active. */
  isCurrent: () => boolean;
  /** Time limit for the batch. */
  signal: AbortSignal;
  /** Local files that Chrome supplies. */
  files: File[];
}

/** Progress used to report an interrupted batch. */
export interface UploadProgress {
  /** Name of the file that the tool prepares or submits. */
  file?: string;
  /** Native request that can still complete after a timeout. */
  inFlight?: Promise<UploadedTile>;
}

/** File after validation and metadata lookup. */
interface PreparedFile {
  /** File that Flow accepts. */
  file: File;
  /** True if the file is a video. */
  video: boolean;
  /** Aspect ratio of the media. */
  aspectRatio: number;
  /** Image dimensions, if available. */
  imageSize?: ImageSize;
}

/** Temporary input used by CDP to assign files on this page. */
let stagedInput: HTMLInputElement | undefined;

/** True while a standalone upload can still write to the project. */
let libraryUploadPending = false;

/** Creates the input that CDP uses to assign local files. */
export function stageMediaFiles(): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  stagedInput = input;
  return input;
}

/** Takes the files and removes the temporary input reference. */
export function takeMediaFiles(): File[] {
  const files = Array.from(stagedInput?.files ?? []);
  stagedInput = undefined;
  return files;
}

/** Runs an operation until the caller's time limit expires. */
export async function waitForMedia<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return run();
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/** Connects the native upload services on a project page. */
export function bindMediaUpload(page: object, format: MediaUploadFormat): UploadBinding | undefined {
  const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
  const store = readOwn(page, format.store);
  const tiles = readOwn(store, format.tiles);
  const tileQuery = readOwn(store, format.tileQuery);
  const refetch = readOwn(tileQuery, "refetch");
  const dispatcher = readOwn(page, format.dispatcher);
  const submit = readOwn(dispatcher, "mutate");
  const injector = readOwn(page, format.injector);
  const get = readOwn(injector, "get");
  const consentType = readOwn(namespace, format.consent);
  if (
    typeof tiles !== "function" ||
    typeof submit !== "function" ||
    typeof get !== "function" ||
    typeof consentType !== "function"
  ) return;
  const exports = MEDIA_UPLOAD_EXPORTS.map((name) => [name, readOwn(namespace, format.exports[name])] as const);
  if (exports.some(([, method]) => typeof method !== "function")) return;
  try {
    const consent: unknown = get.call(injector, consentType);
    if (!consent || typeof consent !== "object") return;
    return {
      flow: Object.fromEntries(exports) as unknown as MediaUploadExports,
      consent,
      submit: (request) => submit.call(dispatcher, request),
      tiles: () => {
        const current: unknown = tiles.call(store);
        return Array.isArray(current) ? (current as FlowTile[]) : [];
      },
      refetchTiles: typeof refetch === "function"
        ? () => Promise.resolve(refetch.call(tileQuery))
        : undefined,
      fields: format.fields,
    };
  } catch {
    return undefined;
  }
}

/** Strips an optional `media/` prefix from a media identifier. */
function cleanMediaId(value: unknown): string {
  return typeof value === "string" ? value.replace(/^media\//, "") : "";
}

/** Returns true when a media status string indicates a finished or failed operation. */
function isTerminalMediaStatus(status: string | undefined): boolean {
  return status === "success" || status === "failed" || status === "canceled";
}

/** Reads the normalized primary media payload from a tile. */
function tileMediaPayload(tile: FlowTile): FlowMediaPayload | undefined {
  const container = legacyTile(tile)?.Fb;
  const primaryId = cleanMediaId(tile.primaryMediaId);
  const history = readOwn(tile, "history");
  const fromHistory = primaryId && Array.isArray(history)
    ? history.find(
        (item): item is FlowMediaPayload =>
          Boolean(item && typeof item === "object" && cleanMediaId(readOwn(item, "id")) === primaryId),
      )
    : undefined;
  const historyMedia = fromHistory ? legacyMedia(fromHistory) : undefined;
  if (container && historyMedia) {
    const containerStatus = container.Zc?.toLowerCase();
    const historyStatus = historyMedia.Zc?.toLowerCase();
    if (!isTerminalMediaStatus(containerStatus) && isTerminalMediaStatus(historyStatus)) {
      return historyMedia;
    }
    return container;
  }
  return container ?? historyMedia;
}

/** Formats a failure message from the native media error payload. */
function transcodeFailureMessage(fileName: string, detail: unknown): string {
  if (typeof detail === "string" && detail.trim()) {
    return `Flow failed to transcode ${fileName}: ${detail.trim()}`;
  }
  const message = readOwn(detail, "message");
  if (typeof message === "string" && message.trim()) {
    return `Flow failed to transcode ${fileName}: ${message.trim()}`;
  }
  return `Flow failed to transcode ${fileName}`;
}

/** Evaluates whether an uploaded video tile is ready, still transcoding, or failed. */
function videoTranscodeState(
  tile: FlowTile,
  fileName: string,
): { state: "ready"; tile: UploadedTile } | { state: "pending" } | { state: "failed"; message: string } {
  const media = tileMediaPayload(tile);
  const status = media?.Zc?.toLowerCase();
  const uploadedFlag = readOwn(media, "vp");
  if (
    tile.type === "FAILED_ASSET" ||
    status === "failed" ||
    status === "canceled" ||
    (status !== "pending" && status !== "scheduled" && uploadedFlag === false)
  ) {
    return { state: "failed", message: transcodeFailureMessage(fileName, media?.nf ?? tile.nf ?? tile.Bf) };
  }
  if (tile.isPending || status === "pending" || status === "scheduled") {
    return { state: "pending" };
  }
  return { state: "ready", tile: tile as UploadedTile };
}

/** Polls the project tile store until video transcoding finishes or fails. */
async function waitForVideoTranscode(
  binding: UploadBinding,
  input: UploadInput,
  initial: UploadedTile,
  fileName: string,
): Promise<UploadedTile> {
  const first = videoTranscodeState(initial, fileName);
  if (first.state === "failed") throw new Error(first.message);
  if (first.state === "ready") return first.tile;

  const initialMediaId = cleanMediaId(initial.primaryMediaId);
  const matchesTile = (candidate: FlowTile): boolean =>
    candidate.id === initial.id ||
    (initialMediaId !== "" && cleanMediaId(candidate.primaryMediaId) === initialMediaId);

  let seenInStore = binding.tiles().some(matchesTile);
  for (let step = 1; ; step++) {
    input.signal.throwIfAborted();
    await waitForMedia(() => delay(TRANSCODE_POLL_INTERVAL_MS), input.signal);
    if (!input.isCurrent()) throw new Error("The Flow project changed");
    if (binding.refetchTiles && step % TRANSCODE_REFETCH_STEPS === 0) {
      await waitForMedia(() => binding.refetchTiles!().catch(() => undefined), input.signal);
      if (!input.isCurrent()) throw new Error("The Flow project changed");
    }
    const current = binding.tiles().find(matchesTile);
    if (!current) {
      if (seenInStore) throw new Error(transcodeFailureMessage(fileName, undefined));
      continue;
    }
    seenInStore = true;
    const next = videoTranscodeState(current, fileName);
    if (next.state === "failed") throw new Error(next.message);
    if (next.state === "ready") return next.tile;
  }
}

/** Reads the file metadata and checks the video duration before upload. */
async function prepareFile(
  flow: MediaUploadExports, file: File, durationField: string,
): Promise<PreparedFile> {
  if (flow.isVideo(file)) {
    const metadata = await flow.videoInfo(file);
    const duration = metadata[durationField];
    if (typeof duration === "number" && Number.isFinite(duration) && duration > MAX_VIDEO_SECONDS) {
      throw new Error(`Trim ${file.name} to ${MAX_VIDEO_SECONDS} seconds or less before upload`);
    }
    return { file, video: true, aspectRatio: metadata.aspectRatio };
  }
  const imageSize = await flow.imageSize(file);
  return { file, video: false, imageSize, aspectRatio: imageSize.width / imageSize.height };
}

/** Completes the upload consent dialog for all validated files. */
async function confirmFiles(
  { flow, consent }: UploadBinding, files: File[], signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const timer = setInterval(() => uploadUiAction("accept_consent"), 250);
  try {
    const accepted = await waitForMedia(() => flow.confirmUpload(consent, files), signal);
    if (accepted.length !== files.length) throw new Error("Flow did not accept the selected files");
  } finally {
    clearInterval(timer);
  }
}

/** Sends one upload and waits until the asset and any video transcoding complete. */
async function uploadFile(
  binding: UploadBinding,
  input: UploadInput,
  prepared: PreparedFile,
  progress: UploadProgress,
): Promise<UploadedTile> {
  const { flow, submit, fields } = binding;
  const { signal } = input;
  const { file, video, aspectRatio, imageSize } = prepared;
  const [workflow, media] = await waitForMedia(() => Promise.all([flow.id(), flow.id()]), signal);
  signal.throwIfAborted();
  if (!input.isCurrent()) throw new Error("The Flow project changed");
  const pending = (async () => {
    const initial = await new Promise<UploadedTile>((resolve, reject) => {
      submit({
        type: video ? "upload_video" : "upload_image",
        ua: input.projectId,
        ...(input.collectionId ? { tb: input.collectionId } : {}),
        [fields.workflow]: workflow,
        [fields.media]: media,
        fileName: file.name,
        mimeType: file.type || flow.mimeType(file.name) ||
          (video ? "video/mp4" : "application/octet-stream"),
        aspectRatio,
        [fields.file]: file,
        [fields.date]: new Date(),
        source: "FILE_PICKER",
        [fields.dimensions]: imageSize,
        [fields.completion]: { resolve, reject },
      });
    });
    return video ? waitForVideoTranscode(binding, input, initial, file.name) : initial;
  })().finally(() => { progress.inFlight = undefined; });
  progress.inFlight = pending;
  return waitForMedia(() => pending, signal);
}

/** Validates the entire batch, then uploads each file in input order. */
export async function uploadMediaFiles(
  binding: UploadBinding,
  input: UploadInput,
  progress: UploadProgress,
  onUploaded: (tile: UploadedTile, file: File) => void,
): Promise<void> {
  const { flow, fields } = binding;
  const { signal } = input;
  signal.throwIfAborted();
  const validation = flow.validateFiles(input.files);
  const accepted = validation[fields.accepted] as File[];
  const errors = validation[fields.errors] as string[];
  if (accepted.length !== input.files.length) {
    throw new Error(errors.join(" ") || "Flow did not accept all the selected files");
  }
  const prepared = await waitForMedia(
    () => Promise.all(accepted.map((file) => prepareFile(flow, file, fields.duration))),
    signal,
  );
  if (!input.isCurrent()) throw new Error("The Flow project changed");
  await confirmFiles(binding, accepted, signal);
  for (const item of prepared) {
    progress.file = item.file.name;
    const tile = await uploadFile(binding, input, item, progress);
    onUploaded(tile, item.file);
    progress.file = undefined;
  }
}

/** Parses `/project/<id>` and `/project/<id>/collection/<collectionId>` routes. */
function projectWorkspaceRoute(pathname: string): { projectId: string; collectionId?: string } | undefined {
  const match = pathname.match(/\/project\/([^/?#]+)(?:\/collection\/([^/?#]+))?\/?$/);
  if (!match) return undefined;
  return {
    projectId: match[1],
    collectionId: match[2] ? decodeURIComponent(match[2]) : undefined,
  };
}

/** Checks the route and lifecycle of a project workspace component. */
function isCurrentPage(page: object, format: ProjectUploadFormat["page"], projectId: string): boolean {
  if (projectWorkspaceRoute(location.pathname)?.projectId !== projectId) return false;
  const project = readOwn(page, format.project);
  return readOwn(readOwn(page, format.lifecycle), format.destroyed) === false &&
    typeof project === "function" && project.call(page) === projectId;
}

/** Finds the live project page that owns the upload services. */
function findProjectPage(format: ProjectUploadFormat["page"], projectId: string): object | undefined {
  const host = document.querySelector("flow-project-page");
  const type = readOwn(readOwn(window, "default_AiSandboxAngularFrontend"), format.page);
  if (!host || typeof type !== "function") return;
  const matches = (value: unknown): value is object =>
    value instanceof type && isCurrentPage(value, format, projectId);
  const page = resolveLView(host)?.find(matches);
  if (page) return page;
  for (const view of runtimeState.ngLViewMap?.values() ?? []) {
    if (!isLiveLView(view) || view[0] !== host) continue;
    const candidate = view.find(matches);
    if (candidate) return candidate;
  }
}

/** Uploads staged media to the pinned project and reports the exact assets that Flow returns. */
export async function projectUpload(projectId: string, session: string, fileCount: number): Promise<unknown> {
  const files = takeMediaFiles();
  if (!files.length || files.length !== fileCount) return { ok: false, error: "project_upload_files_unavailable" };
  if (libraryUploadPending) return { ok: false, error: "project_upload_pending" };
  const store = projectStore(projectId, session);
  if (!store) return { ok: false, error: "project_changed" };
  const support = projectUploadCompatibility();
  if (!support.ok) return support;
  const { format } = support;
  const page = findProjectPage(format.page, projectId);
  if (!page) return { ok: false, error: "project_upload_page_not_ready" };
  const binding = bindMediaUpload(page, format.media);
  if (!binding) {
    return projectUploadCompatibility([{
      name: "project_upload_service", ok: false, detail: "Project upload services",
    }]);
  }
  const collectionId = projectWorkspaceRoute(location.pathname)?.collectionId;
  const isCurrent = () => projectStore(projectId, session) === store &&
    isCurrentPage(page, format.page, projectId);
  const signal = AbortSignal.timeout(MEDIA_UPLOAD_TIMEOUT_MS);
  const progress: UploadProgress = {};
  const assets: UploadResultAsset[] = [];
  let unconfirmed = false;
  libraryUploadPending = true;
  try {
    const input = { projectId, collectionId, isCurrent, signal, files };
    await uploadMediaFiles(binding, input, progress, (tile, file) => {
      if (!tile?.id || (tile.type !== "IMAGE" && tile.type !== "VIDEO")) {
        unconfirmed = true;
        throw new Error("Flow did not return a valid uploaded asset");
      }
      assets.push({
        id: tile.id,
        primary_media_id: tile.primaryMediaId,
        name: tile.displayName || file.name,
        kind: tile.type === "VIDEO" ? "video" : "image",
      });
    });
    return { ok: true, project_id: projectId, count: assets.length, assets };
  } catch (error) {
    const interrupted = Boolean(progress.inFlight || unconfirmed || (signal.aborted && progress.file));
    return {
      ok: false, error: interrupted ? "outcome_unknown" : "project_upload_failed",
      project_id: projectId, assets,
      file: progress.file,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    const release = () => { libraryUploadPending = false; };
    // Flow can finish the current write after the tool reaches its time limit.
    if (progress.inFlight) void progress.inFlight.then(release, release);
    else release();
  }
}
