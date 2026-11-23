// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Upload local media through the native Flow project services.

import { isLiveLView, readOwn, resolveLView } from "./angular";
import { projectUploadCompatibility } from "./frontend_compatibility";
import { MEDIA_UPLOAD_EXPORTS } from "./frontend_builds";
import type { MediaUploadFields, MediaUploadFormat, ProjectUploadFormat } from "./frontend_builds";
import { uploadUiAction } from "./open_upload_trigger";
import { projectStore } from "./project_store";
import { runtimeState } from "./state";
import type { FlowTile } from "./types";

/** Maximum time for a local upload batch. */
export const MEDIA_UPLOAD_TIMEOUT_MS = 100_000;

/** Maximum video duration before Flow requires a trim. */
const MAX_VIDEO_SECONDS = 30;

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
  /** Upload fields of the verified build. */
  fields: MediaUploadFields;
}

/** Files and context for one upload batch. */
interface UploadInput {
  /** ID of the project that owns the uploads. */
  projectId: string;
  /** Returns true while the bound project is active. */
  isCurrent: () => boolean;
  /** Time limit for the batch. */
  signal: AbortSignal;
  /** Local files that Chrome supplies. */
  files: File[];
  /** Requires a readable video duration before the tool sends any files. */
  requireVideoDuration?: boolean;
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
  const dispatcher = readOwn(page, format.dispatcher);
  const submit = readOwn(dispatcher, "mutate");
  const injector = readOwn(page, format.injector);
  const get = readOwn(injector, "get");
  const consentType = readOwn(namespace, format.consent);
  if (typeof submit !== "function" || typeof get !== "function" || typeof consentType !== "function") return;
  const exports = MEDIA_UPLOAD_EXPORTS.map((name) => [name, readOwn(namespace, format.exports[name])] as const);
  if (exports.some(([, method]) => typeof method !== "function")) return;
  try {
    const consent: unknown = get.call(injector, consentType);
    if (!consent || typeof consent !== "object") return;
    return {
      flow: Object.fromEntries(exports) as unknown as MediaUploadExports,
      consent,
      submit: (request) => submit.call(dispatcher, request),
      fields: format.fields,
    };
  } catch {
    return undefined;
  }
}

/** Reads the file metadata and checks the video duration before upload. */
async function prepareFile(
  flow: MediaUploadExports, file: File, durationField: string, requireVideoDuration: boolean,
): Promise<PreparedFile> {
  if (flow.isVideo(file)) {
    const metadata = await flow.videoInfo(file);
    const duration = metadata[durationField];
    if (requireVideoDuration && (!Number.isFinite(duration) || duration <= 0)) {
      throw new Error(`Flow could not read the video duration for ${file.name}`);
    }
    if (duration > MAX_VIDEO_SECONDS) {
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

/** Sends one upload and waits for the asset that the native request returns. */
async function uploadFile(
  { flow, submit, fields }: UploadBinding,
  input: UploadInput,
  prepared: PreparedFile,
  progress: UploadProgress,
): Promise<UploadedTile> {
  const { signal } = input;
  const { file, video, aspectRatio, imageSize } = prepared;
  const [workflow, media] = await waitForMedia(() => Promise.all([flow.id(), flow.id()]), signal);
  signal.throwIfAborted();
  if (!input.isCurrent()) throw new Error("The Flow project changed");
  const pending = new Promise<UploadedTile>((resolve, reject) => {
    submit({
      type: video ? "upload_video" : "upload_image",
      ua: input.projectId,
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
  }).finally(() => { progress.inFlight = undefined; });
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
    () => Promise.all(accepted.map((file) =>
      prepareFile(flow, file, fields.duration, input.requireVideoDuration === true),
    )),
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

/** Checks the route and lifecycle of a project workspace component. */
function isCurrentPage(page: object, format: ProjectUploadFormat["page"], projectId: string): boolean {
  if (location.pathname.match(/\/project\/([^/]+)\/?$/)?.[1] !== projectId) return false;
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
  const isCurrent = () => projectStore(projectId, session) === store &&
    isCurrentPage(page, format.page, projectId);
  const signal = AbortSignal.timeout(MEDIA_UPLOAD_TIMEOUT_MS);
  const progress: UploadProgress = {};
  const assets: UploadResultAsset[] = [];
  let unconfirmed = false;
  libraryUploadPending = true;
  try {
    const input = { projectId, isCurrent, signal, files, requireVideoDuration: true };
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
    return {
      ok: false, error: progress.inFlight || unconfirmed ? "outcome_unknown" : "project_upload_failed",
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
