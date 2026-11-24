// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Create Google Flow scenes and append workflow clips via bound store state.

import { createScene } from "./angular";
import { delay, isTrashedTile, legacyTile } from "./dom";
import { activeProjectStoreFormat, readBuildLabel } from "./frontend_builds";
import {
  clearProjectStore,
  currentProjectStore,
  projectMutationPending,
  projectsToRefresh,
  readConfirmedProjectStore,
} from "./project_store";
import { sceneContents } from "./scene_tiles";
import { clearStore, runtimeState } from "./state";
import type { FlowTile, SceneClipItem, SceneOpRequest } from "./types";

/** Maximum time in milliseconds to wait for a scene clip addition callback. */
const SCENE_ADD_CLIPS_TIMEOUT_MS = 10_000;

/** Store errors thrown before a mutation leaves the browser. */
const PRE_SUBMIT_ERRORS = new Set([
  "unsupported_front_end",
  "project_store_changed",
  "store_mutate_missing",
]);

/** Recorded identifiers of one clip in a scene. */
interface ClipIdentity {
  /** Workflow identifier on the clip. */
  workflowId: string | null;
  /** Primary media identifier on the clip. */
  primaryMediaId: string | null;
}

/** Expected identifiers of one clip requested in `add_clips`. */
interface ExpectedClip {
  /** Source asset ID passed by the caller. */
  assetId: string;
  /** Resolved workflow ID sent to Flow. */
  workflowId: string;
  /** Source primary media ID when known. */
  primaryMediaId: string | null;
}

/** Outcome of waiting for a submitted `add_clips` mutation and its callback. */
type AddClipsWaitOutcome =
  | { kind: "settled" }
  | { kind: "timeout" }
  | { kind: "rejected"; error: string; preSubmit: boolean };

/** Extracts the workflow and primary media IDs from a scene clip item. */
function readClipIdentity(clip: SceneClipItem | undefined): ClipIdentity {
  const wf = clip?.workflowId;
  const media = clip?.primaryMediaId;
  return {
    workflowId: wf == null || wf === "" ? null : String(wf),
    primaryMediaId: media == null || media === "" ? null : String(media),
  };
}

/** Reads the primary media ID of a source project tile when present. */
function sourcePrimaryMediaId(rawTile: FlowTile | undefined): string | null {
  const tile = legacyTile(rawTile);
  const raw =
    tile?.primaryMediaId ??
    tile?.Fb?.id ??
    tile?.Fb?.mediaId ??
    tile?.fb?.mediaId ??
    tile?.mediaId ??
    null;
  return raw == null || raw === "" ? null : String(raw);
}

/** Finds a live, non-trashed scene tile in `tiles` by ID. */
function findLiveSceneTile(
  tiles: Map<string, FlowTile> | null | undefined,
  sceneId: string,
): FlowTile | null {
  if (!(tiles instanceof Map)) return null;
  const candidate = tiles.get(sceneId);
  if (
    candidate &&
    !isTrashedTile(candidate) &&
    !candidate.isPending &&
    String(candidate.type ?? "SCENE").toUpperCase() === "SCENE"
  ) {
    return candidate;
  }
  for (const [id, tile] of tiles.entries()) {
    if (
      String(tile?.id ?? id) === sceneId &&
      !isTrashedTile(tile) &&
      !tile?.isPending &&
      String(tile?.type ?? "").toUpperCase() === "SCENE"
    ) {
      return tile;
    }
  }
  return null;
}

/** Returns true when `actual` matches a recorded pre-submission clip `prior`. */
function clipMatchesPrior(actual: ClipIdentity, prior: ClipIdentity): boolean {
  if (prior.workflowId !== null && actual.workflowId === prior.workflowId) {
    return true;
  }
  return (
    prior.primaryMediaId !== null &&
    actual.primaryMediaId === prior.primaryMediaId
  );
}

/** Returns true when `actual` matches a requested clip `expected`. */
function clipMatchesExpected(actual: ClipIdentity, expected: ExpectedClip): boolean {
  if (
    actual.workflowId !== null &&
    (actual.workflowId === expected.workflowId ||
      actual.workflowId === expected.assetId)
  ) {
    return true;
  }
  return (
    expected.primaryMediaId !== null &&
    actual.primaryMediaId === expected.primaryMediaId
  );
}

/** Checks whether `afterScene` holds all `before` clips plus all `expected` clips. */
function sceneClipsConfirmed(
  before: ClipIdentity[],
  afterScene: FlowTile,
  expected: ExpectedClip[],
  position: number | null | undefined,
): boolean {
  const after = sceneContents(afterScene).clips.map(readClipIdentity);
  if (after.length !== before.length + expected.length) return false;

  const insertAt =
    typeof position === "number" && Number.isFinite(position)
      ? Math.max(0, Math.min(Math.trunc(position), before.length))
      : before.length;
  const matchesAtIndex =
    before.slice(0, insertAt).every((b, i) => clipMatchesPrior(after[i], b)) &&
    expected.every((exp, i) => clipMatchesExpected(after[insertAt + i], exp)) &&
    before
      .slice(insertAt)
      .every((b, i) => clipMatchesPrior(after[insertAt + expected.length + i], b));
  if (matchesAtIndex) return true;
  if (typeof position === "number" && Number.isFinite(position)) return false;

  const added: ClipIdentity[] = [];
  let priorIndex = 0;
  for (const item of after) {
    if (priorIndex < before.length && clipMatchesPrior(item, before[priorIndex])) {
      priorIndex += 1;
    } else {
      added.push(item);
    }
  }
  return (
    priorIndex === before.length &&
    added.length === expected.length &&
    expected.every((exp, i) => clipMatchesExpected(added[i], exp))
  );
}

/** Creates a scene or adds workflow clips to an existing scene. */
export async function sceneOp(req: SceneOpRequest): Promise<unknown> {
  const build = readBuildLabel();
  if (!activeProjectStoreFormat()) {
    clearProjectStore();
    return { ok: false, error: "unsupported_front_end", build };
  }
  const helper = runtimeState.store;
  if (!helper || !helper.isCurrent()) {
    if (helper) clearStore();
    return { ok: false, error: "store_not_bound" };
  }
  if (!helper.isReady()) {
    return { ok: false, error: "store_loading" };
  }
  const getMap = (): Map<string, FlowTile> | null | undefined => helper.getTileMap();
  let tileMap = getMap();
  if (!(tileMap instanceof Map) || !helper.mutate) {
    return { ok: false, error: "store_not_bound" };
  }

  const action = String(req?.action || "").toLowerCase();
  const resolveWfIds = (ids: string[]): string[] =>
    ids.map((id) => String(getMap()?.get(id)?.workflowId || id));

  if (action === "create") {
    const assetIds = Array.isArray(req?.asset_ids)
      ? req.asset_ids.map(String)
      : [];
    const created = await createScene(helper, getMap, resolveWfIds(assetIds));
    if (!created?.ok || !created.id) {
      return created || { ok: false, error: "created_scene_id_not_found" };
    }
    if (req?.name && helper.rename) {
      try {
        await helper.rename(created.id, String(req.name));
        await delay(400);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err ?? "scene_rename_failed"),
        };
      }
    }
    return {
      ok: true,
      id: created.id,
      name: req?.name ? String(req.name) : null,
    };
  }

  if (action === "add_clips") {
    const sceneId = String(req?.scene_id || "").trim();
    const assetIds = Array.isArray(req?.asset_ids)
      ? req.asset_ids.map((id) => String(id).trim()).filter(Boolean)
      : [];
    if (!sceneId || !assetIds.length) {
      return { ok: false, error: "scene_id_and_asset_ids_required" };
    }
    if (projectMutationPending) {
      return { ok: false, error: "project_mutation_pending" };
    }
    const projectId = helper.projectId;
    const store = projectId ? currentProjectStore(projectId) : null;
    if (store && projectsToRefresh.has(store.projectId)) {
      const refreshed = await readConfirmedProjectStore(store);
      if (!refreshed) {
        return { ok: false, error: "project_refresh_failed", project_id: store.projectId };
      }
      tileMap = refreshed;
    }
    const existingTile = tileMap.get(sceneId);
    if (
      existingTile &&
      (isTrashedTile(existingTile) ||
        existingTile.isPending === true ||
        (typeof existingTile.type === "string" &&
          existingTile.type.toUpperCase() !== "SCENE"))
    ) {
      return { ok: false, error: "scene_not_found", scene_id: sceneId };
    }

    const beforeScene = findLiveSceneTile(tileMap, sceneId);
    const baseline = beforeScene
      ? sceneContents(beforeScene).clips.map(readClipIdentity)
      : null;
    const expectedClips: ExpectedClip[] = assetIds.map((assetId) => {
      const rawSource = tileMap?.get(assetId);
      return {
        assetId,
        workflowId: String(rawSource?.workflowId || assetId),
        primaryMediaId: sourcePrimaryMediaId(rawSource),
      };
    });
    const workflowIds = expectedClips.map((clip) => clip.workflowId);
    const timeoutMs =
      typeof req?.timeout_ms === "number" &&
      Number.isFinite(req.timeout_ms) &&
      req.timeout_ms > 0
        ? Math.min(req.timeout_ms, SCENE_ADD_CLIPS_TIMEOUT_MS)
        : SCENE_ADD_CLIPS_TIMEOUT_MS;

    let resolveCallback: () => void = () => {};
    let rejectCallback: (err: unknown) => void = () => {};
    const callbackPromise = new Promise<void>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });
    void callbackPromise.catch(() => undefined);
    const completion = {
      resolve: () => resolveCallback(),
      reject: (err: unknown) => rejectCallback(err),
    };

    if (store) projectsToRefresh.add(store.projectId);
    const mutatePromise = Promise.resolve().then(() =>
      helper.mutate({
        type: "add_workflows_to_scene",
        Lc: sceneId,
        Ic: sceneId,
        rg: workflowIds,
        YWa: workflowIds,
        position: typeof req.position === "number" ? req.position : undefined,
        Mh: undefined,
        Eh: undefined,
        De: completion,
        ve: completion,
      }),
    );
    void mutatePromise.catch(() => undefined);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome: AddClipsWaitOutcome = await Promise.race([
      Promise.all([mutatePromise, callbackPromise]).then(
        (): AddClipsWaitOutcome => ({ kind: "settled" }),
        (err: unknown): AddClipsWaitOutcome => {
          const message =
            err instanceof Error ? err.message : String(err ?? "add_workflows_failed");
          if (message === "mutation_timeout") {
            return { kind: "timeout" };
          }
          return {
            kind: "rejected",
            error: message,
            preSubmit: PRE_SUBMIT_ERRORS.has(message),
          };
        },
      ),
      new Promise<AddClipsWaitOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });

    if (outcome.kind === "rejected") {
      if (outcome.preSubmit && store) {
        projectsToRefresh.delete(store.projectId);
      }
      return { ok: false, error: outcome.error };
    }

    if (outcome.kind === "timeout") {
      const freshTiles = store
        ? await readConfirmedProjectStore(store)
        : helper.isCurrent() && helper.isReady()
          ? helper.getTileMap() ?? null
          : null;
      const afterScene = findLiveSceneTile(freshTiles, sceneId);
      if (
        baseline !== null &&
        afterScene !== null &&
        sceneClipsConfirmed(baseline, afterScene, expectedClips, req.position)
      ) {
        if (store) projectsToRefresh.delete(store.projectId);
        return {
          ok: true,
          scene_id: sceneId,
          added: assetIds.length,
          confirmed: true,
        };
      }
      return {
        ok: false,
        error: "outcome_unknown",
        project_id: projectId,
        stage: "add_clips",
        scene_id: sceneId,
        asset_ids: assetIds,
      };
    }

    if (store) projectsToRefresh.delete(store.projectId);
    await delay(400);
    return { ok: true, scene_id: sceneId, added: assetIds.length };
  }

  return { ok: false, error: `unknown_scene_action:${action}` };
}
