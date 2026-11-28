// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read clips, workflow history, and verified scene builder state.

import { findRouter, readOwn, resolveLView } from "./angular";
import { findMediaContainer, isTrashedTile, legacyMedia, parentCollectionId } from "./dom";
import { frontendBuild, readBuildLabel, snapshotFormat } from "./frontend_builds";
import type { FlowMediaPayload, FlowTile, SceneClipItem, StoreProbeCheck } from "./types";

/** Parsed scene ID and clip workflow ID from a `<sceneId>:<wfId>` clip asset ID. */
export interface SceneClipId {
  /** Identifier of the parent scene tile. */
  sceneId: string;
  /** Workflow identifier of the clip inside the scene. */
  workflowId: string;
}

/** Fields that identify the contents of a scene tile. */
export interface SceneTileFormat {
  /** Clip array on a scene tile. */
  clips: string;
  /** Workflow history map on a scene tile. */
  history: string;
  /** Start trim timestamp in seconds on a scene clip item (`Ji`). */
  clipStart?: string;
  /** End trim timestamp in seconds on a scene clip item (`Ci`). */
  clipEnd?: string;
  /** Total clip duration in seconds on a scene clip item (`nc`). */
  clipDuration?: string;
}

/** Native scene builder and timeline descriptors for clip selection and extend checks. */
export interface SceneBuilderFormat {
  /** Exported `flow-scene-builder` component class (`su`). */
  controller: string;
  /** `flow-scene-timeline` component class (`B6`). */
  timeline: string;
  /** Scene player service field on the controller (`Gc`). */
  player: string;
  /** Readiness method on the scene player (`Dx`). */
  playerReady: string;
  /** Writable selected-clip signal on the scene player (`la`). */
  selectedClip: string;
  /** Clip list signal on the controller (`Uc`). */
  clips: string;
  /** Extend disabled reason signal on the controller (`Yo`). */
  extendDisabledReason: string;
  /** Active extend-composing workflow signal on the controller (`TL`). */
  activeExtendClip: string;
  /** Prototype method on the controller that exits extend-composing mode (`rE`). */
  exitExtend: string;
  /** Models signal query on the controller (`Od`). */
  modelsQuery: string;
}

/** Portrait `9:16` numeric aspect ratio expected by Flow's `create_scene` mutation. */
const PORTRAIT_ASPECT_RATIO = 0.5625;

/** Landscape `16:9` numeric aspect ratio expected by Flow's `create_scene` mutation. */
const LANDSCAPE_ASPECT_RATIO = 16 / 9;

/** Splits a `<sceneId>:<wfId>` clip asset ID into its scene and workflow parts. */
export function splitSceneClipId(id: string): SceneClipId | null {
  const colonIdx = id.indexOf(":");
  if (colonIdx <= 0 || colonIdx >= id.length - 1) return null;
  const sceneId = id.slice(0, colonIdx);
  const workflowId = id.slice(colonIdx + 1);
  if (workflowId.includes(":")) return null;
  return { sceneId, workflowId };
}

/** Reads verified trim bounds and duration in seconds from one scene clip item. */
export function readSceneClipBounds(
  clip: SceneClipItem | undefined,
): { start: number | null; end: number | null; duration: number | null } {
  const format = frontendBuild(readBuildLabel())?.projectStore.scene;
  const rawStart = (format?.clipStart ? readOwn(clip, format.clipStart) : undefined) ?? clip?.Ji ?? clip?.Mh;
  const rawEnd = (format?.clipEnd ? readOwn(clip, format.clipEnd) : undefined) ?? clip?.Ci ?? clip?.Eh;
  const rawDur = (format?.clipDuration ? readOwn(clip, format.clipDuration) : undefined) ?? clip?.nc ?? clip?.rc;
  return {
    start: typeof rawStart === "number" ? rawStart : null,
    end: typeof rawEnd === "number" ? rawEnd : null,
    duration: typeof rawDur === "number" ? rawDur : null,
  };
}

/** Returns the clip list and history of a scene in the active build. */
export function sceneContents(tile: FlowTile) {
  const format = frontendBuild(readBuildLabel())?.projectStore.scene;
  const clips = (format && readOwn(tile, format.clips)) ?? tile.Oc;
  const history = (format && readOwn(tile, format.history)) ?? tile.Yf;
  const entries: Iterable<[string, FlowMediaPayload[]]> = history instanceof Map
    ? history.entries()
    : history && typeof history === "object" ? Object.entries(history) : [];
  return {
    clips: Array.isArray(clips) ? clips as SceneClipItem[] : [],
    history: new Map(Array.from(entries, ([id, media]) => [String(id), media])),
  };
}

/** Finds a top-level `VIDEO` tile in `tiles` by tile ID or workflow ID. */
export function findVideoTileByIdOrWorkflow(
  tiles: Map<string, FlowTile> | null | undefined,
  idOrWorkflowId: string | undefined,
): FlowTile | undefined {
  if (!(tiles instanceof Map) || !idOrWorkflowId) return undefined;
  const direct = tiles.get(idOrWorkflowId);
  if (
    direct &&
    !isTrashedTile(direct) &&
    String(direct.type ?? "").toUpperCase() === "VIDEO"
  ) {
    return direct;
  }
  for (const tile of tiles.values()) {
    if (!tile || isTrashedTile(tile) || String(tile.type ?? "").toUpperCase() !== "VIDEO") {
      continue;
    }
    if (String(tile.workflowId ?? "") === idOrWorkflowId || String(tile.id ?? "") === idOrWorkflowId) {
      return tile;
    }
  }
  return undefined;
}

/** Reads `0.5625` (`9:16`) or `16 / 9` (`16:9`) from verified `Kb.aspectRatio` or `Bc` dimensions on clip `0`. */
export function readSceneAspectRatio(clip0: FlowTile | undefined): number {
  if (!clip0) return LANDSCAPE_ASPECT_RATIO;
  const media = findMediaContainer(clip0)?.[1];
  const rawRatio = media ? readOwn(media, "aspectRatio") : undefined;
  if (typeof rawRatio === "number" && Number.isFinite(rawRatio) && rawRatio > 0) {
    return rawRatio < 1 ? PORTRAIT_ASPECT_RATIO : LANDSCAPE_ASPECT_RATIO;
  }
  const dimsField = snapshotFormat()?.media.dimensions;
  const rawDims = (media && dimsField ? readOwn(media, dimsField) : undefined) ?? legacyMedia(media)?.tc;
  const width = typeof readOwn(rawDims, "width") === "number"
    ? (readOwn(rawDims, "width") as number)
    : clip0.width;
  const height = typeof readOwn(rawDims, "height") === "number"
    ? (readOwn(rawDims, "height") as number)
    : clip0.height;
  if (typeof width === "number" && width > 0 && typeof height === "number" && height > 0) {
    return width < height ? PORTRAIT_ASPECT_RATIO : LANDSCAPE_ASPECT_RATIO;
  }
  return LANDSCAPE_ASPECT_RATIO;
}

/** Reads the verified `Dc` collection ID on clip `0` when present. */
export function readSceneCollectionId(clip0: FlowTile | undefined): string | undefined {
  if (!clip0) return undefined;
  const field = frontendBuild(readBuildLabel())?.projectStore.mutations?.sceneCollection;
  const mapped = field ? readOwn(clip0, field) : undefined;
  if (typeof mapped === "string" && mapped) return mapped;
  const fallback = parentCollectionId(clip0) ?? (typeof clip0.Fc === "string" ? clip0.Fc : null);
  return fallback || undefined;
}

/** Finds the timeline class in the global namespace or in the controller's Ivy dependencies. */
function resolveTimelineClass(
  namespace: unknown,
  controllerClass: unknown,
  timelineName: string,
): Function | null {
  const direct = readOwn(namespace, timelineName);
  if (typeof direct === "function") return direct;
  const cmp = readOwn(controllerClass, "Ma") ?? readOwn(controllerClass, "ɵcmp");
  const rawDeps = readOwn(cmp, "dependencies");
  const deps: unknown = typeof rawDeps === "function" ? rawDeps.call(cmp) : rawDeps;
  if (!Array.isArray(deps)) return null;
  for (const dep of deps) {
    if (typeof dep === "function" && dep.name === timelineName) return dep;
  }
  return null;
}

/** Escapes regex metacharacters in `value`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns true when `fnSource` accesses property `exportName` as an exact identifier. */
function referencesExport(fnSource: string, exportName: string): boolean {
  const escaped = escapeRegExp(exportName);
  return new RegExp(`(?:\\.|\\[\\s*["'])${escaped}(?:["']\\s*\\]|(?![\\w$]))`).test(fnSource);
}

/** Returns true when `controllerClass` defines `member` on its prototype or assigns `this.<member>`. */
function controllerDefinesMember(
  controllerClass: Function,
  classSource: string,
  member: string,
): boolean {
  if (typeof readOwn(controllerClass.prototype, member) === "function") return true;
  const escaped = escapeRegExp(member);
  return new RegExp(`\\bthis\\.${escaped}(?![\\w$])`).test(classSource);
}

/** Checks whether the Angular router registers a lazy `scene/:sceneId` loader for `controllerName`. */
function hasDeferredSceneRoute(routes: unknown, controllerName: string): boolean {
  if (!Array.isArray(routes)) return false;
  for (const route of routes) {
    if (!route || typeof route !== "object") continue;
    const path = readOwn(route, "path");
    if (typeof path === "string" && path.includes("scene/")) {
      for (const loaderKey of ["mh", "loadComponent"]) {
        const loader = readOwn(route, loaderKey);
        if (typeof loader === "function" && referencesExport(Function.prototype.toString.call(loader), controllerName)) {
          return true;
        }
      }
    }
    if (hasDeferredSceneRoute(readOwn(route, "children"), controllerName)) return true;
  }
  return false;
}

/** Resolves the live `su` scene builder controller from `<flow-scene-builder>` via `resolveLView`. */
export function resolveSceneBuilderController(
  host: Element | null = document.querySelector("flow-scene-builder"),
): { controller: Record<string, unknown>; format: SceneBuilderFormat } | null {
  const format = frontendBuild(readBuildLabel())?.projectStore.sceneBuilder;
  if (!format || !host) return null;
  const view = resolveLView(host);
  if (!Array.isArray(view)) return null;
  const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
  const controllerClass = readOwn(namespace, format.controller);
  for (const slot of view) {
    if (!slot || typeof slot !== "object" || slot instanceof Node) continue;
    if (typeof controllerClass === "function" && slot instanceof controllerClass) {
      return { controller: slot as Record<string, unknown>, format };
    }
    const player = readOwn(slot, format.player);
    const modelsQuery = readOwn(slot, format.modelsQuery);
    if (
      player &&
      typeof player === "object" &&
      typeof readOwn(player, format.playerReady) === "function" &&
      typeof readOwn(slot, format.clips) === "function" &&
      typeof readOwn(slot, format.extendDisabledReason) === "function" &&
      typeof readOwn(slot, format.activeExtendClip) === "function" &&
      typeof readOwn(slot, format.exitExtend) === "function" &&
      Boolean(modelsQuery && typeof readOwn(modelsQuery, "isPending") === "function")
    ) {
      return { controller: slot as Record<string, unknown>, format };
    }
  }
  return null;
}

/** Verifies the `sceneBuilder` descriptors of `build` for `probeStore()`. */
export function sceneBuilderChecks(build: string | null): StoreProbeCheck[] {
  const format = frontendBuild(build)?.projectStore.sceneBuilder;
  if (!format) return [];
  const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
  const controllerClass = readOwn(namespace, format.controller);
  const host = document.querySelector("flow-scene-builder");

  if (typeof controllerClass !== "function") {
    const deferred = !host && hasDeferredSceneRoute(readOwn(findRouter(), "config"), format.controller);
    return [{
      name: "scene_builder",
      ok: deferred,
      detail: deferred
        ? `deferred route -> ${format.controller}`
        : `missing export ${format.controller}`,
    }];
  }

  const timelineClass = resolveTimelineClass(namespace, controllerClass, format.timeline);
  const timelineCmp = timelineClass ? (readOwn(timelineClass, "Ma") ?? readOwn(timelineClass, "ɵcmp")) : undefined;
  const timelineInputs = readOwn(timelineCmp, "inputs");
  const publicDisabledInput = readOwn(timelineInputs, "extendDisabledReason");
  const inputsOk =
    !timelineInputs ||
    typeof timelineInputs !== "object" ||
    readOwn(timelineInputs, format.extendDisabledReason) !== undefined ||
    (Array.isArray(publicDisabledInput) && publicDisabledInput[0] === format.extendDisabledReason) ||
    publicDisabledInput === format.extendDisabledReason;
  if (!timelineClass || !inputsOk) {
    return [{
      name: "scene_builder",
      ok: false,
      detail: !timelineClass
        ? `missing timeline ${format.timeline}`
        : `missing input ${format.extendDisabledReason} on ${format.timeline}`,
    }];
  }

  const classSource = Function.prototype.toString.call(controllerClass);
  if (typeof readOwn(controllerClass.prototype, format.exitExtend) !== "function") {
    return [{
      name: "scene_builder",
      ok: false,
      detail: `missing method ${format.exitExtend} on ${format.controller}`,
    }];
  }
  const requiredFields = [
    format.player,
    format.clips,
    format.extendDisabledReason,
    format.activeExtendClip,
    format.modelsQuery,
  ];
  const missingField = requiredFields.find(
    (field) => !controllerDefinesMember(controllerClass, classSource, field),
  );
  if (missingField) {
    return [{
      name: "scene_builder",
      ok: false,
      detail: `missing member ${missingField} on ${format.controller}`,
    }];
  }

  if (!host) {
    return [{
      name: "scene_builder",
      ok: true,
      detail: `${format.controller}+${format.timeline} verified`,
    }];
  }

  const resolved = resolveSceneBuilderController(host);
  const controller = resolved?.controller;
  const player = controller ? readOwn(controller, format.player) : undefined;
  const selectedSignal = player ? readOwn(player, format.selectedClip) : undefined;
  const modelsQuery = controller ? readOwn(controller, format.modelsQuery) : undefined;
  const liveOk = Boolean(
    controller &&
      player &&
      typeof player === "object" &&
      typeof readOwn(player, format.playerReady) === "function" &&
      typeof readOwn(selectedSignal, "set") === "function" &&
      typeof readOwn(controller, format.clips) === "function" &&
      typeof readOwn(controller, format.extendDisabledReason) === "function" &&
      typeof readOwn(controller, format.activeExtendClip) === "function" &&
      typeof readOwn(controller, format.exitExtend) === "function" &&
      modelsQuery &&
      typeof readOwn(modelsQuery, "isPending") === "function",
  );
  return [{
    name: "scene_builder",
    ok: liveOk,
    detail: liveOk ? "live controller verified" : "live controller signals missing",
  }];
}
