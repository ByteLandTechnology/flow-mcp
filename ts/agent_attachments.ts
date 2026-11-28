// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Prepare Agent message references and upload local media through Flow.

import { readOwn } from "./angular";
import { cleanMediaId, findMediaContainer, isTrashedTile, legacyMedia } from "./dom";
import { frontendBuild, readBuildLabel } from "./frontend_builds";
import { agentAttachmentCompatibility } from "./frontend_compatibility";
import { bindMediaUpload, uploadMediaFiles, waitForMedia } from "./project_upload";
import type { MediaUploadExport, UploadProgress } from "./project_upload";
import type { FlowMediaPayload, FlowTile } from "./types";

/** Tile that can supply a reference in the active Flow project. */
export interface AttachmentTile extends FlowTile {
  /** Asset ID shown in the project. */
  id: string;
  /** ID of the primary image or video. */
  primaryMediaId?: string;
  /** Edit and generation media variants stored on the tile. */
  history?: FlowMediaPayload[];
  /** Upsampled video media variants stored on the tile. */
  yn?: FlowMediaPayload[];
  /** Type of asset. */
  type: string;
}

/** Image or video reference accepted by the native message builder. */
interface MediaReference {
  /** ID of the image or video. */
  mediaId: string;
  /** Type of media to attach. */
  mediaType: "IMAGE" | "VIDEO";
}

/** Character reference accepted by the native message builder. */
interface CharacterReference {
  /** Type of reference to attach. */
  mediaType: "CHARACTER";
  /** Native fields of the character reference. */
  [field: string]: unknown;
}

/** Reference accepted by the native Agent message builder. */
type AttachmentReference = MediaReference | CharacterReference;

/** Native attachment functions of the verified front end. */
interface AttachmentExports {
  /** Converts a project tile to a reference. */
  reference(tile: AttachmentTile, position?: string): AttachmentReference | undefined;
  /** Creates an Agent message with references. */
  message(input: Record<string, object>): object;
  /** Builds the text content of the message. */
  text(value: string): object;
}

/** Keys used to bind the Agent attachment functions for each supported build. */
export type AgentAttachmentExport = keyof AttachmentExports | MediaUploadExport;

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

/** Native query that supplies the project tile signal. */
interface TileQuery {
  /** Returns the result after the first successful load. */
  data(): unknown;
  /** Loads the current project's tiles. */
  refetch(): Promise<unknown>;
}

/** Returns true when the tile can identify a media reference. */
function isMediaTile(tile: AttachmentTile): boolean {
  return tile.type === "IMAGE" || tile.type === "VIDEO";
}

/** Returns true when a media variant payload has finished generating or uploading. */
export function isReadyVariant(variant: FlowMediaPayload | undefined): boolean {
  if (!variant || typeof variant !== "object") return true;
  const source = readOwn(variant, "source");
  const uploaded = readOwn(variant, "vp");
  if (uploaded === false) return false;
  const status = legacyMedia(variant).Zc?.toLowerCase();
  if (source === "GENERATED") return status === "success";
  if (source === "UPLOADED" && typeof uploaded === "boolean" && !uploaded) return false;
  return status === undefined || status === "success";
}

/** Finds the media variant matching `mediaId` in `history`, `yn`, or the primary container. */
function findVariantByMediaId(
  tile: AttachmentTile,
  mediaId: string,
  primary: FlowMediaPayload | undefined,
): FlowMediaPayload | undefined {
  const wanted = cleanMediaId(mediaId);
  if (!wanted) return undefined;
  const inHistory = Array.isArray(tile.history)
    ? tile.history.find((item) => cleanMediaId(readOwn(item, "id")) === wanted)
    : undefined;
  if (inHistory) return inHistory;
  const inUpsampled = Array.isArray(tile.yn)
    ? tile.yn.find((item) => cleanMediaId(readOwn(item, "id")) === wanted)
    : undefined;
  if (inUpsampled) return inUpsampled;
  return primary && cleanMediaId(readOwn(primary, "id")) === wanted ? primary : undefined;
}

/** Resolves a tile and optional media variant matching a requested project asset or media ID. */
export function resolveRequestedAsset(
  tiles: AttachmentTile[],
  requestedId: string,
): { tile: AttachmentTile; variant?: FlowMediaPayload; variantId?: string } | undefined {
  const wanted = cleanMediaId(requestedId);
  for (const tile of tiles) {
    if (!tile || isTrashedTile(tile)) continue;
    if (tile.id === requestedId) {
      if (!isMediaTile(tile)) return { tile };
      const container = findMediaContainer(tile)?.[1];
      const variant = tile.primaryMediaId
        ? findVariantByMediaId(tile, tile.primaryMediaId, container)
        : container;
      const rawVariantId = readOwn(variant, "id");
      return {
        tile,
        variant,
        variantId: typeof rawVariantId === "string" ? rawVariantId : tile.primaryMediaId,
      };
    }
  }
  if (!wanted) return undefined;
  for (const tile of tiles) {
    if (!tile || isTrashedTile(tile) || !isMediaTile(tile)) continue;
    const container = findMediaContainer(tile)?.[1];
    if (tile.primaryMediaId && cleanMediaId(tile.primaryMediaId) === wanted) {
      return {
        tile,
        variant: findVariantByMediaId(tile, tile.primaryMediaId, container),
        variantId: tile.primaryMediaId,
      };
    }
    const variant = findVariantByMediaId(tile, wanted, container);
    if (variant) {
      const rawVariantId = readOwn(variant, "id");
      return {
        tile,
        variant,
        variantId: typeof rawVariantId === "string" ? rawVariantId : wanted,
      };
    }
  }
  return undefined;
}

/** Gets a native reference and checks that it matches the selected asset or variant. */
function projectReference(
  flow: AttachmentExports,
  tile: AttachmentTile | undefined,
  characterField: string,
  variant?: FlowMediaPayload,
  variantId?: string,
) {
  if (!tile || isTrashedTile(tile)) return undefined;
  const character = tile.type === "CHARACTER";
  if (character ? tile.isPending : !isMediaTile(tile)) return undefined;
  if (!character) {
    if (variant ? !isReadyVariant(variant) : tile.isPending) return undefined;
  }
  const containerKey = !character ? findMediaContainer(tile)?.[0] : undefined;
  const history = !character && variant && variantId
    ? (Array.isArray(tile.history)
        ? (tile.history.some((item) => cleanMediaId(readOwn(item, "id")) === cleanMediaId(variantId))
            ? tile.history
            : [...tile.history, variant])
        : [variant])
    : undefined;
  const adapted = !character && variant && variantId
    ? {
        ...tile,
        primaryMediaId: variantId,
        ...(containerKey ? { [containerKey]: variant } : {}),
        ...(history ? { history } : {}),
      }
    : tile;
  const reference = flow.reference(adapted, "REFERENCE");
  if (character) {
    return reference?.mediaType === "CHARACTER" && reference[characterField] === tile.id
      ? reference : undefined;
  }
  return reference &&
    reference.mediaType !== "CHARACTER" &&
    reference.mediaId &&
    (!variantId || cleanMediaId(reference.mediaId) === cleanMediaId(variantId))
    ? reference : undefined;
}

/** Uses separate keys for character IDs and media IDs. */
function referenceKey(reference: AttachmentReference, characterField: string): string {
  return reference.mediaType === "CHARACTER"
    ? `character:${reference[characterField]}`
    : `media:${reference.mediaId}`;
}

/** Reads the current project tiles from the bound page store when available. */
export function readAgentProjectTiles(page: Record<string, unknown>): AttachmentTile[] {
  const format = frontendBuild(readBuildLabel())?.operations.agent_attachments;
  if (!format) return [];
  const store = readOwn(page, format.store);
  const tiles = readOwn(store, format.tiles);
  if (typeof tiles !== "function") return [];
  try {
    const items: unknown = tiles.call(store);
    return Array.isArray(items) ? (items as AttachmentTile[]) : [];
  } catch {
    return [];
  }
}

/** Resolves project references, uploads local files, and builds the native Agent message. */
export async function buildAttachmentMessage(input: AttachmentInput) {
  const compatibility = agentAttachmentCompatibility();
  if (!compatibility.ok) return compatibility;
  const { format } = compatibility;
  const { fields } = format;
  const exports = Reflect.get(window, "default_AiSandboxAngularFrontend") ?? {};
  const store = input.page[format.store] as Record<string, unknown> | undefined;
  const tiles = store?.[format.tiles];
  const query = store?.[format.tileQuery] as TileQuery | undefined;
  const upload = input.files.length ? bindMediaUpload(input.page, format) : undefined;
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
      ok: upload !== undefined,
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
  const progress: UploadProgress = {};
  try {
    if (input.assetIds.length > 0 && query) {
      // The Agent page can hold a cache from before a change in the project page.
      const result = await waitForMedia(() => query.refetch(), signal);
      if (readOwn(result, "status") === "error" || !query.data())
        return {
          ok: false as const,
          error: "agent_attachment_assets_unavailable",
        };
    }
    if (!input.isCurrent())
      return { ok: false as const, error: "agent_project_changed" };
    const projectTiles = (tiles as () => AttachmentTile[])();
    const references = new Map<string, AttachmentReference>();
    for (const id of input.assetIds) {
      const matched = resolveRequestedAsset(projectTiles, id);
      const reference = matched
        ? projectReference(flow, matched.tile, fields.character, matched.variant, matched.variantId)
        : undefined;
      if (!reference)
        return {
          ok: false as const,
          error: "agent_attachment_unavailable",
          asset_id: id,
        };
      references.set(referenceKey(reference, fields.character), reference);
    }
    if (upload) {
      await uploadMediaFiles(upload, input, progress, (tile, file) => {
        uploadedAssetIds.push(tile.id);
        const reference = projectReference(flow, tile, fields.character);
        if (!reference || reference.mediaType === "CHARACTER") {
          throw new Error(`Flow could not attach ${file.name} after upload`);
        }
        references.set(referenceKey(reference, fields.character), reference);
      });
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
        [fields.text]: flow.text(input.message),
        [fields.references]: [...references.values()],
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
      file_in_progress: (progress.inFlight || signal.aborted) ? progress.file : undefined,
    };
  }
}
