// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Check the build and runtime requirements of internal Flow operations.

import {
  frontendBuild,
  MEDIA_UPLOAD_EXPORTS,
  projectMutationFormat,
  readBuildLabel,
} from "./frontend_builds";
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
import { projectWriteChecks } from "./project_store";
import { legacyTile, pickTileUrl } from "./dom";
import { runtimeState } from "./state";
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

/** Adds the native fields used by the general project store. */
export function withMutationAliases(payload: Record<string, unknown>): Record<string, unknown> {
  const format = projectMutationFormat();
  if (payload.type === "single_tile" && payload.Ve && typeof payload.Ve === "object") {
    if (!format) return { ...payload, We: payload.We ?? payload.Ve, df: payload.df ?? payload.Ve };
    const change = payload.Ve as Record<string, unknown>;
    const native = change.type === "set_video_trim_seconds" ? {
      ...change, [format.trimStart]: change.Cg, [format.trimEnd]: change.Rf,
    } : change;
    return { ...payload, [format.tileId]: payload.Xc ?? payload.Uc, [format.tileChange]: native };
  }
  if (format && payload.type === "create_scene") {
    return { ...payload, [format.sceneWorkflows]: payload.rg, [format.sceneCollection]: payload.Fc };
  }
  if (format && payload.type === "add_workflows_to_scene") {
    return { ...payload, [format.sceneId]: payload.Lc, [format.sceneWorkflows]: payload.rg };
  }
  return payload;
}

/** Returns the verified format when the build and runtime checks pass. */
function checkOperation<Operation extends keyof FrontendFormats>(
  operation: Operation,
  build: string | null,
  checks: StoreProbeCheck[],
): FrontendCompatibility<FrontendFormats[Operation]> {
  const format = frontendBuild(build)?.operations[operation];
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

/** Returns the Agent layout when the build and runtime checks pass. */
export function agentChatCompatibility(
  checks: StoreProbeCheck[] = [],
): FrontendCompatibility<AgentChatFormat> {
  return checkOperation("agent_chat", readBuildLabel(), checks);
}

/** Returns the verified project settings format when its checks pass. */
export function agentSettingsCompatibility(
  checks: StoreProbeCheck[] = [],
): FrontendCompatibility<AgentSettingsFormat> {
  return checkOperation("agent_settings", readBuildLabel(), checks);
}

/** Returns the Agent attachment format when the build and runtime checks pass. */
export function agentAttachmentCompatibility(
  checks: StoreProbeCheck[] = [],
): FrontendCompatibility<AgentAttachmentFormat> {
  const build = readBuildLabel();
  const format = frontendBuild(build)?.operations.agent_attachments;
  const namespace = Reflect.get(window, "default_AiSandboxAngularFrontend") ?? {};
  const exports = Object.entries(format?.exports ?? {}).map(([name, key]) => ({
    name,
    ok: typeof namespace[key] === "function",
    detail: "Agent attachment export",
  }));
  return checkOperation("agent_attachments", build, [...exports, ...checks]);
}

/** Returns the project library upload format when the native functions are available. */
export function projectUploadCompatibility(
  checks: StoreProbeCheck[] = [],
): FrontendCompatibility<ProjectUploadFormat> {
  const build = readBuildLabel();
  const format = frontendBuild(build)?.operations.project_upload;
  const namespace = Reflect.get(window, "default_AiSandboxAngularFrontend") ?? {};
  const exports = format ? [
    ...MEDIA_UPLOAD_EXPORTS.map((name) => ({
      name,
      ok: typeof namespace[format.media.exports[name]] === "function",
      detail: "Media upload export",
    })),
    {
      name: "upload_consent",
      ok: typeof namespace[format.media.consent] === "function",
      detail: "Upload consent service",
    },
    {
      name: "project_page",
      ok: typeof namespace[format.page.page] === "function",
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

/** Counts readable image and video tiles in the first 200 tiles. */
function tileLayout(tiles: Iterable<FlowTile>): StoreProbeCheck {
  let readable = 0;
  let unreadable = 0;
  let seen = 0;
  for (const raw of tiles) {
    if (++seen > 200) break;
    const kind = String(raw?.type ?? "").toUpperCase();
    if (kind !== "IMAGE" && kind !== "VIDEO") continue;
    const tile = legacyTile(raw);
    if (tile.Fb && (tile.Fb.Zc !== undefined || pickTileUrl(tile))) readable++;
    else unreadable++;
  }
  return {
    name: "tile_layout",
    ok: readable > 0 || unreadable === 0,
    detail: readable + unreadable === 0 ? "no media tiles to inspect" :
      `readable=${readable} unreadable=${unreadable}`,
  };
}

/** Checks the bound store and tile layout used by asset trash. */
function assetTrashChecks(tiles: Map<string, FlowTile> | null | undefined): StoreProbeCheck[] {
  const store = runtimeState.store;
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
  const trashChecks = assetTrashChecks(runtimeState.store?.getTileMap());
  const views = runtimeState.ngLViewMap;
  const checks = [
    {
      name: "lview_registry",
      ok: views instanceof Map,
      detail: views ? `${views.size} views` : "not captured",
    },
    ...trashChecks,
  ];
  return {
    build,
    ok: checks.every(({ ok }) => ok),
    checks,
    operations: {
      agent_chat: operationStatus(agentChatCompatibility()),
      agent_attachments: operationStatus(agentAttachmentCompatibility()),
      agent_settings: operationStatus(agentSettingsCompatibility()),
      project_upload: operationStatus(projectUploadCompatibility()),
      collection_write: operationStatus(checkOperation("collection_write", build, projectWriteChecks("collection"))),
      character_bio: operationStatus(checkOperation("character_bio", build, projectWriteChecks("project"))),
      asset_trash_store: operationStatus(assetTrashCompatibility()),
    },
  };
}
