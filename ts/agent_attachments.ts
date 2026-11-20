// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Prepare Agent message references and upload local media through Flow.

import { isTrashedTile } from "./dom";
import { agentAttachmentCompatibility } from "./frontend_compatibility";
import { uploadUiAction } from "./open_upload_trigger";
import type { FlowTile } from "./types";

/** Media tile in the active Flow project. */
interface MediaTile extends FlowTile {
  /** Asset ID shown in the project. */
  id: string;
  /** ID of the primary image or video. */
  primaryMediaId?: string;
  /** Type of asset. */
  type: string;
}

/** Reference accepted by the native Agent message builder. */
interface MediaReference {
  /** ID of the image or video. */
  mediaId: string;
  /** Type of media to attach. */
  mediaType: string;
}

/** Dimensions of a local image. */
interface ImageSize {
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
}

/** Flow ID and the value from which it is calculated. */
interface FlowId {
  /** ID for the project asset or media. */
  id: string;
  /** Value that Flow uses to allocate the ID. */
  seed: string;
}

/** Native attachment functions of the verified front end. */
interface AttachmentExports {
  /** Converts a project tile to a reference. */
  reference(tile: MediaTile, position?: string): MediaReference | undefined;
  /** Creates an Agent message with references. */
  message(input: { Lc: object; nc: MediaReference[] }): object;
  /** Builds the text content of the message. */
  text(value: string): object;
  /** Allocates a Flow ID. */
  id(): Promise<FlowId>;
  /** Checks the upload type, name, and size. */
  validateFiles(files: File[]): { mA: File[]; ir: string[] };
  /** Returns true if Flow treats the file as a video. */
  isVideo(file: File): boolean;
  /** Gets the media type from the file name. */
  mimeType(name: string): string | undefined;
  /** Reads the dimensions of an image. */
  imageSize(file: File): Promise<ImageSize>;
  /** Reads the aspect ratio and duration of a video. */
  videoInfo(file: File): Promise<{ aspectRatio: number; Tt: number }>;
  /** Runs the native upload consent flow. */
  confirmUpload(service: object, files: File[]): Promise<File[]>;
}

/** Keys used to bind the attachment functions for each supported build. */
export type AgentAttachmentExport = keyof AttachmentExports;

/** Input to one message with attachments. */
interface AttachmentInput {
  /** Active project component. */
  page: Record<string, unknown>;
  /** ID of the project that owns the assets. */
  projectId: string;
  /** Returns true if the project is still active. */
  isCurrent: () => boolean;
  /** Deadline shared by the session read and attachment preparation. */
  signal: AbortSignal;
  /** Text of the message. */
  message: string;
  /** IDs of project assets to attach. */
  assetIds: string[];
  /** Local files that Chrome assigned to the temporary input. */
  files: File[];
}

/** Files prepared for upload. */
interface PreparedFile {
  /** File to send to Flow. */
  file: File;
  /** True if Flow treats the file as a video. */
  video: boolean;
  /** Aspect ratio of the media. */
  aspectRatio: number;
  /** Image dimensions, when available. */
  imageSize?: ImageSize;
}

/** Native query that supplies the project tile signal. */
interface TileQuery {
  /** Returns the result after the first successful load. */
  data(): unknown;
  /** Loads the current project's tiles. */
  refetch(): Promise<unknown>;
}

/** Sends a project upload request through the native store. */
interface UploadDispatcher {
  /** Submits the mutation in the project page. */
  mutate(request: Record<string, unknown>): void;
}

/** Time limit to prepare and upload files before the tool sends the message. */
export const ATTACHMENT_TIMEOUT_MS = 100_000;

/** Maximum video duration in seconds before Flow opens its trim dialog. */
const MAX_VIDEO_SECONDS = 30;

/** Temporary file input for CDP file assignment. */
let stagedInput: HTMLInputElement | undefined;

/** Creates an input for CDP to assign local files. */
export function stageAgentFiles(): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  stagedInput = input;
  return input;
}

/** Takes the files from the temporary input and clears it. */
export function takeAgentFiles(): File[] {
  const files = Array.from(stagedInput?.files ?? []);
  stagedInput = undefined;
  return files;
}

/** Waits for the operation until the attachment deadline expires. */
export async function waitForAttachment<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
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

/** Gets the project reference only if the tile contains available media. */
function mediaReference(flow: AttachmentExports, tile: MediaTile | undefined) {
  if (!tile || isTrashedTile(tile) || !["IMAGE", "VIDEO"].includes(tile.type))
    return undefined;
  const reference = flow.reference(tile, "REFERENCE");
  return reference?.mediaId ? reference : undefined;
}

/** Gets the upload metadata and checks the video duration. */
async function prepareFile(
  flow: AttachmentExports,
  file: File,
): Promise<PreparedFile> {
  if (flow.isVideo(file)) {
    const metadata = await flow.videoInfo(file);
    if (metadata.Tt > MAX_VIDEO_SECONDS) {
      throw new Error(
        `Trim ${file.name} to ${MAX_VIDEO_SECONDS} seconds or less before upload`,
      );
    }
    return { file, video: true, aspectRatio: metadata.aspectRatio };
  }
  const imageSize = await flow.imageSize(file);
  return {
    file,
    video: false,
    imageSize,
    aspectRatio: imageSize.width / imageSize.height,
  };
}

/** Runs the upload consent workflow with the same handler as other uploads. */
async function confirmFiles(
  flow: AttachmentExports,
  consent: object,
  files: File[],
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const timer = setInterval(() => uploadUiAction("accept_consent"), 250);
  const stop = () => clearInterval(timer);
  signal.addEventListener("abort", stop, { once: true });
  try {
    const accepted = await waitForAttachment(
      () => flow.confirmUpload(consent, files),
      signal,
    );
    if (accepted.length !== files.length)
      throw new Error("Flow did not accept the selected files");
  } finally {
    stop();
    signal.removeEventListener("abort", stop);
  }
}

/** Uploads one file and returns the tile that Flow returns for that upload. */
async function uploadFile(
  flow: AttachmentExports,
  dispatcher: UploadDispatcher,
  input: AttachmentInput,
  prepared: PreparedFile,
): Promise<MediaTile> {
  const { signal } = input;
  const { file, video, aspectRatio, imageSize } = prepared;
  const [workflow, media] = await waitForAttachment(
    () => Promise.all([flow.id(), flow.id()]),
    signal,
  );
  signal.throwIfAborted();
  if (!input.isCurrent()) throw new Error("The Flow project changed");
  return waitForAttachment(
    () =>
      new Promise((resolve, reject) => {
        dispatcher.mutate({
          type: video ? "upload_video" : "upload_image",
          ua: input.projectId,
          hf: workflow,
          wh: media,
          fileName: file.name,
          mimeType:
            file.type ||
            flow.mimeType(file.name) ||
            (video ? "video/mp4" : "application/octet-stream"),
          aspectRatio,
          yn: file,
          kc: new Date(),
          source: "FILE_PICKER",
          Ac: imageSize,
          sm: { resolve, reject },
        });
      }),
    signal,
  );
}

/** Resolves project references, uploads local files, and builds the native Agent message. */
export async function buildAttachmentMessage(input: AttachmentInput) {
  const compatibility = agentAttachmentCompatibility();
  if (!compatibility.ok) return compatibility;
  const { format } = compatibility;
  const exports = Reflect.get(window, "default_AiSandboxAngularFrontend") ?? {};
  const store = input.page[format.store] as Record<string, unknown> | undefined;
  const tiles = store?.[format.tiles];
  const query = store?.[format.tileQuery] as TileQuery | undefined;
  const dispatcher = input.page[format.dispatcher] as
    | UploadDispatcher
    | undefined;
  const injector = input.page[format.injector] as
    | { get(type: unknown): object }
    | undefined;
  const checks = [
    {
      name: "project_tiles",
      ok: typeof tiles === "function",
      detail: "Project tile signal",
    },
  ];
  if (input.assetIds.length > 0) {
    checks.push({
      name: "project_tile_query",
      ok:
        typeof query?.data === "function" &&
        typeof query?.refetch === "function",
      detail: "Project tile query",
    });
  }
  if (input.files.length > 0) {
    checks.push({
      name: "upload_service",
      ok:
        typeof dispatcher?.mutate === "function" &&
        typeof injector?.get === "function" &&
        typeof exports[format.consent] === "function",
      detail: "Project upload services",
    });
  }
  const checked = agentAttachmentCompatibility(checks);
  if (!checked.ok) return checked;

  const flow = Object.fromEntries(
    Object.entries(format.exports).map(([name, key]) => [name, exports[key]]),
  ) as unknown as AttachmentExports;
  const uploadedAssetIds: string[] = [];
  const { signal } = input;
  let currentFile: string | undefined;
  try {
    if (input.assetIds.length > 0 && query && !query.data()) {
      await waitForAttachment(() => query.refetch(), signal);
      if (!query.data())
        return {
          ok: false as const,
          error: "agent_attachment_assets_unavailable",
        };
    }
    if (!input.isCurrent())
      return { ok: false as const, error: "agent_project_changed" };
    const projectTiles: MediaTile[] = (tiles as () => MediaTile[])();
    const references = new Map<string, MediaReference>();
    for (const id of input.assetIds) {
      const tile =
        projectTiles.find((asset) => asset.id === id) ??
        projectTiles.find(
          (asset) =>
            asset.primaryMediaId?.replace(/^media\//, "") ===
            id.replace(/^media\//, ""),
        );
      const reference = mediaReference(flow, tile);
      if (!reference)
        return {
          ok: false as const,
          error: "agent_attachment_unavailable",
          asset_id: id,
        };
      references.set(reference.mediaId, reference);
    }
    if (input.files.length > 0 && injector && dispatcher) {
      const consent = injector.get(exports[format.consent]);
      const { mA: accepted, ir: errors } = flow.validateFiles(input.files);
      if (accepted.length !== input.files.length)
        throw new Error(errors.join(" "));
      const prepared = await waitForAttachment(
        () => Promise.all(accepted.map((file) => prepareFile(flow, file))),
        signal,
      );
      await confirmFiles(flow, consent, accepted, signal);
      for (const file of prepared) {
        currentFile = file.file.name;
        const tile = await uploadFile(flow, dispatcher, input, file);
        uploadedAssetIds.push(tile.id);
        currentFile = undefined;
        const reference = mediaReference(flow, tile);
        if (!reference)
          throw new Error(
            `Flow could not attach ${file.file.name} after upload`,
          );
        references.set(reference.mediaId, reference);
      }
    }
    signal.throwIfAborted();
    if (!input.isCurrent())
      return {
        ok: false as const,
        error: "agent_project_changed",
        uploaded_asset_ids: uploadedAssetIds,
      };
    return {
      ok: true as const,
      message: flow.message({
        Lc: flow.text(input.message),
        nc: [...references.values()],
      }),
      uploaded_asset_ids: uploadedAssetIds,
    };
  } catch (error) {
    return {
      ok: false as const,
      error: signal.aborted
        ? "agent_attachment_timeout"
        : "agent_attachment_failed",
      detail: error instanceof Error ? error.message : String(error),
      uploaded_asset_ids: uploadedAssetIds,
      file_in_progress: signal.aborted ? currentFile : undefined,
    };
  }
}
