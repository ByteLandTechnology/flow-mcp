// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Check the build and runtime requirements of internal Flow operations.

import { readOwn } from "./angular";
import { characterPersonalityNotes } from "./character_bio";
import {
  AGENT_ATTACHMENT_EXPORTS,
  AGENT_EXPORTS,
  AGENT_SETTINGS_EXPORTS,
  FRONTEND_OPERATIONS,
  frontendBuild,
  MEDIA_UPLOAD_EXPORTS,
  readBuildLabel,
  sceneTileFormat,
  snapshotFormat,
  withMutationAliases,
} from "./frontend_builds";
export { withMutationAliases };
import type {
  AgentAttachmentFormat,
  AgentChatFormat,
  AgentSettingsFormat,
  AssetTrashFormat,
  CharacterBioFormat,
  CollectionWriteFormat,
  FrontendFormats,
  ProjectUploadFormat,
} from "./frontend_builds";
import { findProjectPage } from "./project_upload";
import { projectWriteChecks } from "./project_store";
import { isTrashedTile, legacyTile, pickTileUrl } from "./dom";
import { clearStore, runtimeState } from "./state";
import type { FlowTile, StoreProbeCheck, StoreProbeResult } from "./types";

/** Compatibility failure returned before a request is sent. */
interface UnsupportedFrontend {
  /** False when the operation cannot run. */
  ok: false;
  /** Stable tool error code. */
  error: "unsupported_front_end";
  /** Build label of the active page. */
  build: string | null;
  /** Operation that needs the request format. */
  operation: keyof FrontendFormats;
  /** Build and runtime checks that failed. */
  failed_checks: StoreProbeCheck[];
}

/** Result of checking a build and runtime for an operation. */
type FrontendCompatibility<Format> = { ok: true; format: Format } | UnsupportedFrontend;

/** Returns the verified format when the build and runtime checks pass. */
function checkOperation<Operation extends keyof FrontendFormats>(
  operation: Operation,
  build: string | null,
  checks: StoreProbeCheck[],
): FrontendCompatibility<FrontendFormats[Operation]> {
  const formats: Partial<FrontendFormats> | undefined = frontendBuild(build)?.operations;
  const format = formats?.[operation];
  const failed = checks.filter(({ ok }) => !ok);
  if (format && failed.length === 0) return { ok: true, format };
  if (!format) {
    failed.unshift({
      name: "verified_build",
      ok: false,
      detail: build === null ? "Build label unavailable" : "Build has no verified format for this operation",
    });
  }
  return { ok: false, error: "unsupported_front_end", build, operation, failed_checks: failed };
}

/** Checks whether the page publishes a verified Flow build label. */
function buildCheck(build: string | null): StoreProbeCheck {
  const verified = Boolean(frontendBuild(build));
  return {
    name: "verified_build",
    ok: verified,
    detail:
      build === null
        ? "Build label unavailable"
        : verified
          ? "verified"
          : "Unverified Flow front-end build",
  };
}

/** Reports front-end build compatibility on Flow pages outside an open project. */
export function probeBuild(): StoreProbeResult {
  const build = readBuildLabel();
  const verified = buildCheck(build);
  const checks = [verified];
  const operations: Record<
    keyof FrontendFormats,
    { ok: boolean; failed_checks: StoreProbeCheck[] }
  > = {
    agent_chat: operationStatus(checkOperation("agent_chat", build, [])),
    agent_attachments: operationStatus(checkOperation("agent_attachments", build, [])),
    agent_settings: operationStatus(checkOperation("agent_settings", build, [])),
    project_upload: operationStatus(checkOperation("project_upload", build, [])),
    collection_write: operationStatus(checkOperation("collection_write", build, [])),
    character_bio: operationStatus(checkOperation("character_bio", build, [])),
    asset_trash_store: operationStatus(checkOperation("asset_trash_store", build, [])),
  };
  const formats = frontendBuild(build)?.operations;
  const operationsOk = FRONTEND_OPERATIONS.every((name) => !formats?.[name] || operations[name].ok);
  return {
    build,
    ok: verified.ok && checks.every(({ ok }) => ok) && operationsOk,
    checks,
    operations,
  };
}

/** Checks the class and protocol exports required by Agent chat. */
function agentChatExportChecks(format: AgentChatFormat, namespace: unknown): StoreProbeCheck[] {
  return [
    {
      name: "project_page",
      ok: typeof readOwn(namespace, format.page) === "function",
      detail: "Project workspace class",
    },
    {
      name: "composer",
      ok: typeof readOwn(namespace, format.composer) === "function",
      detail: "Agent composer service",
    },
    {
      name: "permissions",
      ok: typeof readOwn(namespace, format.permissions) === "function",
      detail: "Agent permission service",
    },
    {
      name: "questions",
      ok: typeof readOwn(namespace, format.questions) === "function",
      detail: "Agent question service",
    },
    ...AGENT_EXPORTS.map((name) => {
      const value = readOwn(namespace, format.exports[name]);
      return {
        name,
        ok:
          name === "errors"
            ? value !== null && typeof value === "object"
            : name === "toolEventGroup"
              ? Array.isArray(value)
              : typeof value === "function",
        detail: "Agent frontend export",
      };
    }),
  ];
}

/** Checks the protocol and catalogue exports required by Agent settings. */
function agentSettingsExportChecks(
  format: AgentSettingsFormat,
  namespace: unknown,
): StoreProbeCheck[] {
  return AGENT_SETTINGS_EXPORTS.map((name) => {
    const value = readOwn(namespace, format.exports[name]);
    return {
      name,
      ok:
        name === "modelKey" || name === "videoAspects"
          ? Array.isArray(value)
          : name === "aspectLabels" || name === "locale" || name === "updateMethod"
            ? value !== null && typeof value === "object"
            : typeof value === "function",
      detail: "Agent settings frontend export",
    };
  });
}

/** Returns the Agent layout when the build and runtime checks pass. */
export function agentChatCompatibility(
  checks: StoreProbeCheck[] = [],
): FrontendCompatibility<AgentChatFormat> {
  const build = readBuildLabel();
  const format = frontendBuild(build)?.operations.agent_chat;
  const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
  const exports = format ? agentChatExportChecks(format, namespace) : [];
  return checkOperation("agent_chat", build, [...exports, ...checks]);
}

/** Returns the verified project settings format when its checks pass. */
export function agentSettingsCompatibility(
  checks: StoreProbeCheck[] = [],
): FrontendCompatibility<AgentSettingsFormat> {
  const build = readBuildLabel();
  const format = frontendBuild(build)?.operations.agent_settings;
  const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
  const exports = format ? agentSettingsExportChecks(format, namespace) : [];
  return checkOperation("agent_settings", build, [...exports, ...checks]);
}

/** Returns the Agent attachment format when the build and runtime checks pass. */
export function agentAttachmentCompatibility(
  checks: StoreProbeCheck[] = [],
): FrontendCompatibility<AgentAttachmentFormat> {
  const build = readBuildLabel();
  const format = frontendBuild(build)?.operations.agent_attachments;
  const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
  const exports = format ? [
    ...AGENT_ATTACHMENT_EXPORTS.map((name) => ({
      name,
      ok: typeof readOwn(namespace, format.exports[name]) === "function",
      detail: "Agent attachment export",
    })),
    {
      name: "upload_consent",
      ok: typeof readOwn(namespace, format.consent) === "function",
      detail: "Upload consent service",
    },
  ] : [];
  return checkOperation("agent_attachments", build, [...exports, ...checks]);
}

/** Returns the project library upload format when the native functions are available. */
export function projectUploadCompatibility(
  checks: StoreProbeCheck[] = [],
): FrontendCompatibility<ProjectUploadFormat> {
  const build = readBuildLabel();
  const format = frontendBuild(build)?.operations.project_upload;
  const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
  const exports = format ? [
    ...MEDIA_UPLOAD_EXPORTS.map((name) => ({
      name,
      ok: typeof readOwn(namespace, format.media.exports[name]) === "function",
      detail: "Media upload export",
    })),
    {
      name: "upload_consent",
      ok: typeof readOwn(namespace, format.media.consent) === "function",
      detail: "Upload consent service",
    },
    {
      name: "project_page",
      ok: typeof readOwn(namespace, format.page.page) === "function",
      detail: "Project workspace class",
    },
  ] : [];
  return checkOperation("project_upload", build, [...exports, ...checks]);
}

/** Returns the collection format for the active project when its checks pass. */
export function collectionWriteCompatibility(): FrontendCompatibility<CollectionWriteFormat> {
  return checkOperation("collection_write", readBuildLabel(), projectWriteChecks("collection"));
}

/** Returns the personality update format when the project store can submit and confirm it. */
export function characterBioCompatibility(): FrontendCompatibility<CharacterBioFormat> {
  return checkOperation("character_bio", readBuildLabel(), projectWriteChecks("project"));
}

/** Returns the asset trash format when its checks pass. */
export function assetTrashCompatibility(): FrontendCompatibility<AssetTrashFormat> {
  return checkOperation("asset_trash_store", readBuildLabel(), projectWriteChecks("project"));
}

/** Checks live services on `<flow-project-page>` when the workspace view is mounted. */
function projectPageOperationChecks(
  build: string | null,
): Partial<Record<keyof FrontendFormats, StoreProbeCheck[]>> {
  const projectId = /\/project\/([^/?#]+)/.exec(location.pathname)?.[1] ?? null;
  const verified = frontendBuild(build);
  if (!projectId || !verified || verified.legacy || !document.querySelector("flow-project-page")) return {};
  const formats = verified.operations;
  const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
  const page = findProjectPage(formats.agent_chat, projectId);
  const pageCheck: StoreProbeCheck = {
    name: "project_page_instance",
    ok: Boolean(page),
    detail: page ? "mounted" : "not bound for the active project",
  };
  if (!page) {
    return {
      agent_chat: [pageCheck],
      agent_attachments: [pageCheck],
      agent_settings: [pageCheck],
      project_upload: [pageCheck],
    };
  }
  const injector = readOwn(page, formats.agent_chat.injector) as
    | { get?: (token: unknown, fallback?: null) => unknown }
    | undefined;
  const getService = (key: string): unknown => {
    const token = readOwn(namespace, key);
    if (typeof token !== "function" || typeof injector?.get !== "function") return null;
    try {
      return injector.get(token, null);
    } catch {
      return null;
    }
  };
  const attachStore = readOwn(page, formats.agent_attachments.store);
  const tileQuery = readOwn(attachStore, formats.agent_attachments.tileQuery);
  const attachDispatcher = readOwn(page, formats.agent_attachments.dispatcher);
  const projectService = getService(formats.agent_settings.exports.projectService);
  const queryClient = readOwn(projectService, formats.agent_settings.queryClient) as
    | { queryCache?: { find?: unknown } }
    | undefined;
  const requestClient = readOwn(projectService, formats.agent_settings.requestClient) as
    | { mutate?: unknown }
    | undefined;
  const uploadDispatcher = readOwn(page, formats.project_upload.media.dispatcher);
  return {
    agent_chat: [
      pageCheck,
      {
        name: "agent_transport",
        ok: Boolean(readOwn(page, formats.agent_chat.transport)),
        detail: "Agent transport service",
      },
      {
        name: "agent_services",
        ok:
          typeof injector?.get === "function" &&
          Boolean(getService(formats.agent_chat.composer)) &&
          Boolean(getService(formats.agent_chat.permissions)) &&
          Boolean(getService(formats.agent_chat.questions)),
        detail: "Project page injector and Agent services",
      },
    ],
    agent_attachments: [
      pageCheck,
      {
        name: "attachment_store",
        ok:
          typeof readOwn(attachStore, formats.agent_attachments.tiles) === "function" &&
          typeof readOwn(tileQuery, "data") === "function" &&
          typeof readOwn(tileQuery, "refetch") === "function" &&
          typeof readOwn(attachDispatcher, "mutate") === "function" &&
          Boolean(getService(formats.agent_attachments.consent)),
        detail: "Attachment tile query and upload dispatcher",
      },
    ],
    agent_settings: [
      pageCheck,
      {
        name: "metadata_service",
        ok:
          typeof queryClient?.queryCache?.find === "function" &&
          typeof requestClient?.mutate === "function",
        detail: "Project metadata query and writer",
      },
    ],
    project_upload: [
      pageCheck,
      {
        name: "project_upload_service",
        ok:
          Boolean(getService(formats.project_upload.media.consent)) &&
          typeof readOwn(uploadDispatcher, "mutate") === "function",
        detail: "Project upload services",
      },
    ],
  };
}

/** Non-completed generation states that do not carry a final media URL yet. */
const INCOMPLETE_MEDIA_STATUSES = new Set(["pending", "scheduled", "failed", "canceled"]);

/** Returns true when `raw` or `media` carries an uploaded user media marker (`_.QE`). */
function isUploadedMediaTile(raw: FlowTile, media: object, namespace: unknown): boolean {
  const qe = readOwn(namespace, "QE");
  const values = [...Object.values(media), ...Object.values(raw)];
  if (typeof qe === "symbol") {
    return values.includes(qe) || readOwn(media, "vp") === true;
  }
  return values.some((v) => typeof v === "symbol") || readOwn(media, "vp") === true;
}

/** Returns true when a media tile carries a valid in-progress status or a readable URL. */
function isReadableMediaTile(raw: FlowTile, tile: FlowTile, namespace: unknown): boolean {
  if (tile.isPending === true) return true;
  const media = tile.Fb;
  if (!media || typeof media !== "object") return false;
  const hasUrl = Boolean(pickTileUrl(tile));
  if (typeof media.Zc === "string") {
    const status = media.Zc.toLowerCase();
    if (INCOMPLETE_MEDIA_STATUSES.has(status)) return true;
    return status === "success" && hasUrl;
  }
  if (media.Zc !== undefined) return false;
  return isUploadedMediaTile(raw, media, namespace) && hasUrl;
}

/** Counts readable image and video tiles in the first 200 tiles. */
function tileLayout(tiles: Iterable<FlowTile>): StoreProbeCheck {
  const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
  let readable = 0;
  let unreadable = 0;
  let seen = 0;
  for (const raw of tiles) {
    if (++seen > 200) break;
    const kind = String(raw?.type ?? "").toUpperCase();
    if (kind !== "IMAGE" && kind !== "VIDEO") continue;
    const tile = legacyTile(raw);
    if (isReadableMediaTile(raw, tile, namespace)) readable++;
    else unreadable++;
  }
  return {
    name: "tile_layout",
    ok: unreadable === 0,
    detail: readable + unreadable === 0 ? "no media tiles to inspect" :
      `readable=${readable} unreadable=${unreadable}`,
  };
}

/** Known uppercase tile types when `snapshotFormat()?.tileTypes` is absent. */
const KNOWN_TILE_TYPES = new Set([
  "COLLECTION",
  "IMAGE",
  "VIDEO",
  "SCENE",
  "CHARACTER",
  "TEXT_TILE",
  "CUSTOM",
  "FAILED_ASSET",
  "AUDIO",
  "MUSIC",
  "VOICE",
]);

/** Returns true when every inspected tile in an unverified store has readable fields. */
export function hasReadableCascadedTiles(tiles: Map<string, FlowTile>): boolean {
  if (!tileLayout(tiles.values()).ok) return false;
  const snapFmt = snapshotFormat();
  const sceneFmt = sceneTileFormat();
  let seen = 0;
  for (const raw of tiles.values()) {
    if (++seen > 200) break;
    const kind = String(raw?.type ?? "").toUpperCase();
    if (!kind) return false;
    if (snapFmt) {
      const { tileTypes } = snapFmt;
      const recognized =
        kind === tileTypes.collection ||
        tileTypes.assets.includes(kind) ||
        tileTypes.ignored.includes(kind) ||
        KNOWN_TILE_TYPES.has(kind);
      if (!recognized) return false;
    } else if (!KNOWN_TILE_TYPES.has(kind)) {
      return false;
    }
    if (isTrashedTile(raw) || raw.isPending === true) continue;
    if (kind === "IMAGE" || kind === "VIDEO") {
      const mediaKeys = snapFmt ? [snapFmt.media.container, "Fb"] : ["Fb", "Eb"];
      const hasContainer = mediaKeys.some((key) => {
        const value = readOwn(raw, key);
        return Boolean(value && typeof value === "object");
      });
      if (!hasContainer) return false;
    }
    if (kind === "CHARACTER") {
      if (typeof raw.displayName !== "string") return false;
      if (
        characterPersonalityNotes(raw) === null &&
        typeof raw.personalityNotes !== "string"
      ) {
        return false;
      }
    }
    if (kind === "COLLECTION" && typeof raw.displayName !== "string") {
      return false;
    }
    if (kind === "SCENE") {
      if (typeof raw.displayName !== "string") return false;
      const hasClips = sceneFmt
        ? Array.isArray(readOwn(raw, sceneFmt.clips)) || Array.isArray(raw.Oc)
        : Array.isArray(raw.Oc);
      if (!hasClips) return false;
    }
  }
  return true;
}

/** Checks the bound store and tile layout used by asset trash. */
function assetTrashChecks(tiles: Map<string, FlowTile> | null | undefined): StoreProbeCheck[] {
  const rawStore = runtimeState.store;
  const store = rawStore?.isCurrent() ? rawStore : null;
  if (rawStore && !store) clearStore();
  const checks = [
    { name: "store_bound", ok: Boolean(store), detail: store ? "bound" : "not bound" },
    {
      name: "tile_map",
      ok: tiles instanceof Map,
      detail: tiles instanceof Map ? `${tiles.size} tiles` : "missing",
    },
    {
      name: "mutator",
      ok: typeof store?.mutate === "function",
      detail: typeof store?.mutate === "function" ? "present" : "missing",
    },
  ];
  if (tiles instanceof Map) checks.push(tileLayout(tiles.values()));
  return checks;
}

/** Returns the compatibility result without the internal request format. */
function operationStatus(result: FrontendCompatibility<unknown>): {
  ok: boolean;
  failed_checks: StoreProbeCheck[];
} {
  return { ok: result.ok, failed_checks: result.ok ? [] : result.failed_checks };
}

/** Reports the general store checks and compatibility of each managed operation. */
export function probeStore(): StoreProbeResult {
  const build = readBuildLabel();
  const verified = buildCheck(build);
  const liveStore = runtimeState.store?.isCurrent() ? runtimeState.store : null;
  const trashChecks = assetTrashChecks(liveStore?.getTileMap());
  const views = runtimeState.ngLViewMap;
  const checks = [
    verified,
    {
      name: "lview_registry",
      ok: views instanceof Map,
      detail: views ? `${views.size} views` : "not captured",
    },
    ...trashChecks,
  ];
  const pageChecks = projectPageOperationChecks(build);
  const operations: Record<
    keyof FrontendFormats,
    { ok: boolean; failed_checks: StoreProbeCheck[] }
  > = {
    agent_chat: operationStatus(agentChatCompatibility(pageChecks.agent_chat)),
    agent_attachments: operationStatus(agentAttachmentCompatibility(pageChecks.agent_attachments)),
    agent_settings: operationStatus(agentSettingsCompatibility(pageChecks.agent_settings)),
    project_upload: operationStatus(projectUploadCompatibility(pageChecks.project_upload)),
    collection_write: operationStatus(collectionWriteCompatibility()),
    character_bio: operationStatus(characterBioCompatibility()),
    asset_trash_store: operationStatus(assetTrashCompatibility()),
  };
  const formats = frontendBuild(build)?.operations;
  const operationsOk = FRONTEND_OPERATIONS.every((name) => !formats?.[name] || operations[name].ok);
  return {
    build,
    ok: verified.ok && checks.every(({ ok }) => ok) && operationsOk,
    checks,
    operations,
  };
}
