// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Infer and validate Flow mutation field keys from live runtime method signatures and handlers.

import { registerTrashedFieldReader } from "./dom";
import {
  frontendBuild,
  readBuildLabel,
  type AssetTrashFormat,
  type CharacterBioFormat,
  type CollectionWriteFormat,
} from "./frontend_builds";
import {
  findActionLiterals,
  findCaseBlocks,
  isCompletionProp,
  isIteratedProp,
  propsReadOn,
  registerBoundDispatcherReader,
  runtimeMutationSources,
  splitObjectLiteralPairs,
} from "./mutation_parser";
import type { StoreProbeCheck } from "./types";

export { registerBoundDispatcherReader };

/** Outcome of validating a runtime mutation shape before dispatch. */
export type ShapeValidation<Format> =
  | { ok: true; format: Format }
  | {
      ok: false;
      reason: "unverified_mutation_shape" | "ambiguous_mutation_shape";
      check: StoreProbeCheck;
    };

/** Inferred shape for a `single_tile` wrapper mutation. */
export interface SingleTileShape {
  /** Tile ID field name on `single_tile`. */
  tileId: string;
  /** Inner change payload field name on `single_tile`. */
  tileChange: string;
}

/** Inferred shape for `set_video_trim_seconds`. */
export interface VideoTrimShape extends SingleTileShape {
  /** Trim start timestamp field name. */
  trimStart: string;
  /** Trim end timestamp field name. */
  trimEnd: string;
}

/** Inferred shape for `create_scene`. */
export interface CreateSceneShape {
  /** Workflow ID array field name. */
  sceneWorkflows: string;
  /** Optional parent collection ID field name. */
  sceneCollection?: string;
  /** Optional completion callback (`{ resolve, reject }`) field name. */
  completion?: string;
  /** Optional created scene field name in the response payload. */
  sceneCreated?: string;
}

/** Inferred shape for `add_workflows_to_scene`. */
export interface AddClipsShape {
  /** Target scene ID field name. */
  sceneId: string;
  /** Workflow ID array field name. */
  sceneWorkflows: string;
  /** Optional completion callback (`{ resolve, reject }`) field name. */
  completion?: string;
}

/** Inferred shape for `create_entity` character creation. */
export interface CreateEntityShape {
  /** Numeric entity type field name (`1` for character). */
  entityType: string;
  /** Optional completion callback (`{ resolve, reject }`) field name. */
  completion?: string;
}

/** Validates a candidate set of serialized shapes and ensures exactly one unique candidate exists. */
function finalizeCandidates<T>(
  name: string,
  items: readonly T[],
  keyOf: (item: T) => string,
): ShapeValidation<T> {
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(keyOf(item), item);
  if (byKey.size === 1) {
    const [only] = byKey.values();
    return { ok: true, format: only };
  }
  if (byKey.size > 1) {
    const detail = `ambiguous candidates (${byKey.size}): ${[...byKey.keys()].join(" | ")}`;
    return { ok: false, reason: "ambiguous_mutation_shape", check: { name, ok: false, detail } };
  }
  return {
    ok: false,
    reason: "unverified_mutation_shape",
    check: { name, ok: false, detail: "no matching runtime mutation shape" },
  };
}

/** Infers and validates the `single_tile` wrapper shape (`tileId`, `tileChange`). */
export function inferSingleTileShape(): ShapeValidation<SingleTileShape> {
  const build = frontendBuild(readBuildLabel());
  const verifiedMut = build?.projectStore.mutations;
  if (verifiedMut) {
    return { ok: true, format: { tileId: verifiedMut.tileId, tileChange: verifiedMut.tileChange } };
  }
  const verifiedCol = build?.operations.collection_write;
  if (verifiedCol) {
    return { ok: true, format: { tileId: verifiedCol.tileId, tileChange: verifiedCol.tileChange } };
  }

  const sources = runtimeMutationSources();
  const candidates: SingleTileShape[] = [];

  for (const { block, actionVar } of findCaseBlocks(sources, "single_tile")) {
    const props = propsReadOn(block, actionVar);
    if (props.length !== 2) continue;
    const changeProps = props.filter((p) => {
      const v = actionVar.replace(/\$/g, "\\$");
      const esc = p.replace(/\$/g, "\\$");
      if (new RegExp(`\\b${v}(?:\\?\\.|\\.)${esc}(?:\\?\\.|\\.)type\\b`).test(block)) return true;
      const alias = new RegExp(`\\b([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*${v}(?:\\?\\.|\\.)${esc}\\b`).exec(block);
      return Boolean(
        alias && new RegExp(`\\b${alias[1].replace(/\$/g, "\\$")}(?:\\?\\.|\\.)type\\b`).test(block),
      );
    });
    if (changeProps.length === 1) {
      const tileChange = changeProps[0];
      const tileId = props.find((p) => p !== tileChange);
      if (tileId && tileId !== tileChange) candidates.push({ tileId, tileChange });
    }
  }

  for (const pairs of findActionLiterals(sources, "single_tile")) {
    const others = pairs.filter((p) => p.key !== "type");
    if (others.length !== 2) continue;
    const withType = others.filter((p) => /\btype\s*:/.test(p.value));
    if (withType.length === 1) {
      const tileChange = withType[0].key;
      const tileId = others.find((p) => p.key !== tileChange)?.key;
      if (tileId && tileId !== tileChange) candidates.push({ tileId, tileChange });
    }
  }

  return finalizeCandidates("single_tile_shape", candidates, (c) => `${c.tileId}:${c.tileChange}`);
}

/** Infers and validates `CharacterBioFormat` (`tileId`, `tileChange`, `notes`). */
export function inferCharacterBioShape(): ShapeValidation<CharacterBioFormat> {
  const verified = frontendBuild(readBuildLabel())?.operations.character_bio;
  if (verified) return { ok: true, format: verified };

  const single = inferSingleTileShape();
  if (!single.ok) return single;

  const sources = runtimeMutationSources();
  const noteKeys: string[] = [];

  for (const { block, actionVar } of findCaseBlocks(sources, "set_character_personality_notes")) {
    const props = propsReadOn(block, actionVar);
    if (props.length === 1) noteKeys.push(props[0]);
  }
  for (const pairs of findActionLiterals(sources, "set_character_personality_notes")) {
    const others = pairs.filter((p) => p.key !== "type");
    if (others.length === 1) noteKeys.push(others[0].key);
  }

  const notesCheck = finalizeCandidates("character_bio_shape", noteKeys, (k) => k);
  if (!notesCheck.ok) return notesCheck;
  return { ok: true, format: { ...single.format, notes: notesCheck.format } };
}

/** Infers and validates `VideoTrimShape` (`tileId`, `tileChange`, `trimStart`, `trimEnd`). */
export function inferVideoTrimShape(): ShapeValidation<VideoTrimShape> {
  const verified = frontendBuild(readBuildLabel())?.projectStore.mutations;
  if (verified) {
    const { tileId, tileChange, trimStart, trimEnd } = verified;
    return { ok: true, format: { tileId, tileChange, trimStart, trimEnd } };
  }

  const single = inferSingleTileShape();
  if (!single.ok) return single;

  const sources = runtimeMutationSources();
  const pairsList: Array<{ trimStart: string; trimEnd: string }> = [];

  for (const pairs of findActionLiterals(sources, "set_video_trim_seconds")) {
    const bounds = pairs.filter((p) => p.key !== "type" && p.key !== "mediaId");
    if (bounds.length === 2 && bounds[0].key !== bounds[1].key) {
      pairsList.push({ trimStart: bounds[0].key, trimEnd: bounds[1].key });
    }
  }
  if (pairsList.length === 0) {
    for (const { block, actionVar } of findCaseBlocks(sources, "set_video_trim_seconds")) {
      const props = propsReadOn(block, actionVar).filter((p) => p !== "mediaId");
      if (props.length === 2 && props[0] !== props[1]) {
        const i0 = block.indexOf(`.${props[0]}`);
        const i1 = block.indexOf(`.${props[1]}`);
        if (i0 >= 0 && i1 >= 0 && i0 !== i1) {
          pairsList.push(
            i0 < i1
              ? { trimStart: props[0], trimEnd: props[1] }
              : { trimStart: props[1], trimEnd: props[0] },
          );
        }
      }
    }
  }

  const trimCheck = finalizeCandidates("video_trim_shape", pairsList, (p) => `${p.trimStart}:${p.trimEnd}`);
  if (!trimCheck.ok) return trimCheck;
  return { ok: true, format: { ...single.format, ...trimCheck.format } };
}

/** Infers and validates `CollectionWriteFormat` (`tileId`, `tileChange`, `moveTarget`, `moveTiles`, `deleteCollections?`). */
export function inferCollectionWriteShape(): ShapeValidation<CollectionWriteFormat> {
  const verified = frontendBuild(readBuildLabel())?.operations.collection_write;
  if (verified) return { ok: true, format: verified };

  const single = inferSingleTileShape();
  if (!single.ok) return single;

  const sources = runtimeMutationSources();
  const moveCandidates: Array<{ moveTarget: string; moveTiles: string }> = [];

  for (const { block, actionVar } of findCaseBlocks(sources, "batch_move_to_collection")) {
    const props = propsReadOn(block, actionVar);
    if (props.length !== 2) continue;
    const iterated = props.filter((p) => isIteratedProp(block, actionVar, p));
    if (iterated.length === 1) {
      const moveTiles = iterated[0];
      const moveTarget = props.find((p) => p !== moveTiles);
      if (moveTarget && moveTarget !== moveTiles) {
        moveCandidates.push({ moveTarget, moveTiles });
      }
    }
  }
  if (moveCandidates.length === 0) {
    for (const pairs of findActionLiterals(sources, "batch_move_to_collection")) {
      const others = pairs.filter((p) => p.key !== "type");
      if (others.length !== 2) continue;
      const arrayVal = others.filter((p) => /^\[|\.map\(|\.filter\(|tiles/i.test(p.value));
      if (arrayVal.length === 1) {
        const moveTiles = arrayVal[0].key;
        const moveTarget = others.find((p) => p.key !== moveTiles)?.key;
        if (moveTarget && moveTarget !== moveTiles) {
          moveCandidates.push({ moveTarget, moveTiles });
        }
      }
    }
  }

  const moveCheck = finalizeCandidates(
    "collection_move_shape",
    moveCandidates,
    (m) => `${m.moveTarget}:${m.moveTiles}`,
  );
  if (!moveCheck.ok) return moveCheck;

  const delKeys = new Set<string>();
  for (const { block, actionVar } of findCaseBlocks(sources, "batch_delete_tiles")) {
    for (const p of propsReadOn(block, actionVar)) {
      if (isIteratedProp(block, actionVar, p) && /COLLECTION|collection/i.test(block)) {
        delKeys.add(p);
      }
    }
  }
  const deleteCollections = delKeys.size === 1 ? [...delKeys][0] : undefined;

  return {
    ok: true,
    format: {
      ...single.format,
      ...moveCheck.format,
      ...(deleteCollections ? { deleteCollections } : {}),
    },
  };
}

/** Infers and validates `AssetTrashFormat` (`entries`, `tile`, `trashed`, `date`, `destination`, `sceneWorkflows`). */
export function inferAssetTrashShape(): ShapeValidation<AssetTrashFormat> {
  const verified = frontendBuild(readBuildLabel())?.operations.asset_trash_store;
  if (verified) return { ok: true, format: verified };

  const sources = runtimeMutationSources();
  const candidates: Array<Omit<AssetTrashFormat, "sceneWorkflows">> = [];

  for (const pairs of findActionLiterals(sources, "batch_set_tiles_trashed")) {
    const others = pairs.filter((p) => p.key !== "type");
    if (others.length !== 2) continue;
    const datePair = others.find((p) => /new\s+Date|Date\.now/i.test(p.value));
    const entriesPair = others.find((p) => p !== datePair);
    if (!datePair || !entriesPair) continue;
    const innerBrace = /\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/.exec(entriesPair.value);
    if (!innerBrace) continue;
    const entryPairs = splitObjectLiteralPairs(innerBrace[1]);
    if (entryPairs.length !== 3) continue;
    const destPair = entryPairs.find((p) => /\bmode\s*:/.test(p.value));
    const boolPair = entryPairs.find((p) => p !== destPair && /^(?:!0|!1|true|false)\b/.test(p.value));
    const tilePair = entryPairs.find((p) => p !== destPair && p !== boolPair);
    if (destPair && boolPair && tilePair) {
      candidates.push({
        date: datePair.key,
        entries: entriesPair.key,
        tile: tilePair.key,
        trashed: boolPair.key,
        destination: destPair.key,
      });
    }
  }

  for (const { block, actionVar } of findCaseBlocks(sources, "batch_set_tiles_trashed")) {
    const props = propsReadOn(block, actionVar);
    if (props.length !== 2) continue;
    const iter = props.filter((p) => isIteratedProp(block, actionVar, p));
    if (iter.length !== 1) continue;
    const entries = iter[0];
    const date = props.find((p) => p !== entries);
    if (!date) continue;
    const av = actionVar.replace(/\$/g, "\\$");
    const ev = entries.replace(/\$/g, "\\$");
    const itemVarMatch = new RegExp(
      `(?:\\bfor\\s*\\(\\s*(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s+of\\s+${av}(?:\\?\\.|\\.)${ev})|(?:${av}(?:\\?\\.|\\.)${ev}\\.(?:map|forEach)\\(\\s*(?:\\(\\s*)?([A-Za-z_$][A-Za-z0-9_$]*))`,
    ).exec(block);
    const itemVar = itemVarMatch?.[1] || itemVarMatch?.[2];
    if (!itemVar) continue;
    const itemProps = propsReadOn(block, itemVar);
    if (itemProps.length !== 3) continue;
    const iv = itemVar.replace(/\$/g, "\\$");
    const dests = itemProps.filter((p) =>
      new RegExp(`\\b${iv}(?:\\?\\.|\\.)${p.replace(/\$/g, "\\$")}(?:\\?\\.|\\.)mode\\b`).test(block),
    );
    const tiles = itemProps.filter((p) =>
      new RegExp(`\\b${iv}(?:\\?\\.|\\.)${p.replace(/\$/g, "\\$")}(?:\\?\\.|\\.)(?:id|type|workflowId)\\b`).test(block),
    );
    if (dests.length === 1 && tiles.length === 1 && dests[0] !== tiles[0]) {
      const trashed = itemProps.find((p) => p !== dests[0] && p !== tiles[0]);
      if (trashed) {
        candidates.push({ date, entries, tile: tiles[0], trashed, destination: dests[0] });
      }
    }
  }

  const baseCheck = finalizeCandidates(
    "asset_trash_shape",
    candidates,
    (c) => `${c.date}:${c.entries}:${c.tile}:${c.trashed}:${c.destination}`,
  );
  if (!baseCheck.ok) return baseCheck;

  const wfKeys = new Set<string>();
  for (const { block, actionVar } of findCaseBlocks(sources, "batch_delete_tiles")) {
    for (const p of propsReadOn(block, actionVar)) {
      if (isIteratedProp(block, actionVar, p) && /workflow|scene|clip/i.test(block)) {
        wfKeys.add(p);
      }
    }
  }
  if (wfKeys.size > 1) {
    const detail = `ambiguous sceneWorkflows keys: ${[...wfKeys].join(", ")}`;
    return {
      ok: false,
      reason: "ambiguous_mutation_shape",
      check: { name: "scene_clip_delete_shape", ok: false, detail },
    };
  }
  return {
    ok: true,
    format: { ...baseCheck.format, sceneWorkflows: wfKeys.size === 1 ? [...wfKeys][0] : "" },
  };
}

/** Infers and validates `CreateSceneShape` (`create_scene`). */
export function inferCreateSceneShape(): ShapeValidation<CreateSceneShape> {
  const verified = frontendBuild(readBuildLabel())?.projectStore.mutations;
  if (verified) {
    return {
      ok: true,
      format: {
        sceneWorkflows: verified.sceneWorkflows,
        sceneCollection: verified.sceneCollection,
        sceneCreated: verified.sceneCreated,
        completion: "De",
      },
    };
  }

  const sources = runtimeMutationSources();
  const candidates: CreateSceneShape[] = [];

  for (const { block, actionVar } of findCaseBlocks(sources, "create_scene")) {
    const props = propsReadOn(block, actionVar).filter((p) => p !== "aspectRatio");
    const iter = props.filter((p) => isIteratedProp(block, actionVar, p));
    if (iter.length !== 1) continue;
    const sceneWorkflows = iter[0];
    const completions = props.filter((p) => isCompletionProp(block, actionVar, p));
    if (completions.length > 1) continue;
    const completion = completions[0];
    const rest = props.filter((p) => p !== sceneWorkflows && p !== completion);
    const sceneCollection = rest.length === 1 ? rest[0] : undefined;
    const retMatch = /return\s*\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(block);
    candidates.push({
      sceneWorkflows,
      ...(sceneCollection ? { sceneCollection } : {}),
      ...(completion ? { completion } : {}),
      ...(retMatch ? { sceneCreated: retMatch[1] } : {}),
    });
  }
  if (candidates.length === 0) {
    for (const pairs of findActionLiterals(sources, "create_scene")) {
      const others = pairs.filter((p) => p.key !== "type" && p.key !== "aspectRatio");
      const wfPairs = others.filter((p) => /^\[|\.map\(|workflow/i.test(p.value));
      const compPairs = others.filter((p) => /\bresolve\b/.test(p.value));
      if (wfPairs.length === 1 && compPairs.length <= 1) {
        candidates.push({
          sceneWorkflows: wfPairs[0].key,
          ...(compPairs[0] ? { completion: compPairs[0].key } : {}),
        });
      }
    }
  }

  return finalizeCandidates(
    "create_scene_shape",
    candidates,
    (c) => `${c.sceneWorkflows}:${c.sceneCollection ?? ""}:${c.completion ?? ""}`,
  );
}

/** Infers and validates `AddClipsShape` (`add_workflows_to_scene`). */
export function inferAddClipsShape(): ShapeValidation<AddClipsShape> {
  const verified = frontendBuild(readBuildLabel())?.projectStore.mutations;
  if (verified) {
    return {
      ok: true,
      format: {
        sceneId: verified.sceneId,
        sceneWorkflows: verified.sceneWorkflows,
        completion: "De",
      },
    };
  }

  const sources = runtimeMutationSources();
  const candidates: AddClipsShape[] = [];

  for (const { block, actionVar } of findCaseBlocks(sources, "add_workflows_to_scene")) {
    const props = propsReadOn(block, actionVar).filter((p) => p !== "position");
    const iter = props.filter((p) => isIteratedProp(block, actionVar, p));
    if (iter.length !== 1) continue;
    const sceneWorkflows = iter[0];
    const completions = props.filter((p) => isCompletionProp(block, actionVar, p));
    if (completions.length > 1) continue;
    const completion = completions[0];
    const scalars = props.filter((p) => p !== sceneWorkflows && p !== completion);
    if (scalars.length === 1) {
      candidates.push({
        sceneId: scalars[0],
        sceneWorkflows,
        ...(completion ? { completion } : {}),
      });
    } else if (scalars.length > 1) {
      const av = actionVar.replace(/\$/g, "\\$");
      const getMatches = scalars.filter((s) =>
        new RegExp(`\\.get\\(\\s*${av}(?:\\?\\.|\\.)${s.replace(/\$/g, "\\$")}\\s*\\)`).test(block),
      );
      if (getMatches.length === 1) {
        candidates.push({
          sceneId: getMatches[0],
          sceneWorkflows,
          ...(completion ? { completion } : {}),
        });
      }
    }
  }
  if (candidates.length === 0) {
    for (const pairs of findActionLiterals(sources, "add_workflows_to_scene")) {
      const others = pairs.filter((p) => p.key !== "type" && p.key !== "position");
      const compPairs = others.filter((p) => /\bresolve\b/.test(p.value));
      const wfPairs = others.filter((p) => p !== compPairs[0] && (/^\[|\.map\(|workflow/i.test(p.value)));
      const idPairs = others.filter((p) => p !== compPairs[0] && p !== wfPairs[0]);
      if (wfPairs.length === 1 && idPairs.length === 1 && compPairs.length <= 1) {
        candidates.push({
          sceneId: idPairs[0].key,
          sceneWorkflows: wfPairs[0].key,
          ...(compPairs[0] ? { completion: compPairs[0].key } : {}),
        });
      }
    }
  }

  return finalizeCandidates(
    "add_workflows_to_scene_shape",
    candidates,
    (c) => `${c.sceneId}:${c.sceneWorkflows}:${c.completion ?? ""}`,
  );
}

/** Infers and validates `CreateEntityShape` (`create_entity`). */
export function inferCreateEntityShape(): ShapeValidation<CreateEntityShape> {
  const sources = runtimeMutationSources();
  const candidates: CreateEntityShape[] = [];

  for (const pairs of findActionLiterals(sources, "create_entity")) {
    const others = pairs.filter((p) => p.key !== "type" && p.key !== "displayName");
    const compPairs = others.filter((p) => /\bresolve\b/.test(p.value));
    const numPairs = others.filter(
      (p) => p !== compPairs[0] && /^(?:1|!0|[A-Za-z_$]+\.[A-Z_]+)$/.test(p.value),
    );
    if (numPairs.length === 1 && compPairs.length <= 1) {
      candidates.push({
        entityType: numPairs[0].key,
        ...(compPairs[0] ? { completion: compPairs[0].key } : {}),
      });
    }
  }
  for (const { block, actionVar } of findCaseBlocks(sources, "create_entity")) {
    const props = propsReadOn(block, actionVar).filter((p) => p !== "displayName");
    const completions = props.filter((p) => isCompletionProp(block, actionVar, p));
    const rest = props.filter((p) => !completions.includes(p));
    if (rest.length === 1 && completions.length <= 1) {
      candidates.push({
        entityType: rest[0],
        ...(completions[0] ? { completion: completions[0] } : {}),
      });
    }
  }

  return finalizeCandidates(
    "create_entity_shape",
    candidates,
    (c) => `${c.entityType}:${c.completion ?? ""}`,
  );
}

/** Builds a validated mutation payload or throws a structured diagnostic error before any write. */
export function buildValidatedMutation(payload: Record<string, unknown>): Record<string, unknown> {
  const action = String(payload.type ?? "");
  if (action === "single_tile") {
    const rawChange = payload.change ?? payload.Ve ?? payload.We ?? payload.df ?? payload.mf;
    if (!rawChange || typeof rawChange !== "object") {
      throw new Error("unverified_mutation_shape:single_tile:missing_change");
    }
    const change = rawChange as Record<string, unknown>;
    const tileIdVal = payload.tileId ?? payload.Xc ?? payload.Uc ?? payload.Vc;
    if (typeof tileIdVal !== "string" || !tileIdVal) {
      throw new Error("unverified_mutation_shape:single_tile:missing_tile_id");
    }
    if (change.type === "set_video_trim_seconds") {
      const trim = inferVideoTrimShape();
      if (!trim.ok) {
        throw new Error(`${trim.reason}:${trim.check.name}:${trim.check.detail}`);
      }
      const startVal = "startSeconds" in change ? change.startSeconds : change.Cg;
      const endVal = "endSeconds" in change ? change.endSeconds : change.Rf;
      return {
        type: "single_tile",
        [trim.format.tileId]: tileIdVal,
        [trim.format.tileChange]: {
          type: "set_video_trim_seconds",
          mediaId: change.mediaId,
          [trim.format.trimStart]: startVal ?? null,
          [trim.format.trimEnd]: endVal ?? null,
        },
      };
    }
    if (change.type === "set_character_personality_notes") {
      const bio = inferCharacterBioShape();
      if (!bio.ok) {
        throw new Error(`${bio.reason}:${bio.check.name}:${bio.check.detail}`);
      }
      const textVal = typeof change.notes === "string" ? change.notes : String(change.Mv ?? "");
      return {
        type: "single_tile",
        [bio.format.tileId]: tileIdVal,
        [bio.format.tileChange]: {
          type: "set_character_personality_notes",
          [bio.format.notes]: textVal,
        },
      };
    }
    const single = inferSingleTileShape();
    if (!single.ok) {
      throw new Error(`${single.reason}:${single.check.name}:${single.check.detail}`);
    }
    return {
      type: "single_tile",
      [single.format.tileId]: tileIdVal,
      [single.format.tileChange]: change,
    };
  }

  if (action === "create_scene") {
    const scene = inferCreateSceneShape();
    if (!scene.ok) {
      throw new Error(`${scene.reason}:${scene.check.name}:${scene.check.detail}`);
    }
    const workflows = payload.workflows ?? payload.rg ?? [];
    const completion = payload.completion ?? payload.De ?? payload.ve;
    const out: Record<string, unknown> = {
      type: "create_scene",
      [scene.format.sceneWorkflows]: workflows,
      aspectRatio: payload.aspectRatio ?? 1,
    };
    if (scene.format.sceneCollection) {
      out[scene.format.sceneCollection] = payload.collectionId ?? payload.Fc;
    }
    if (completion && scene.format.completion) {
      out[scene.format.completion] = completion;
    }
    return out;
  }

  if (action === "add_workflows_to_scene") {
    const add = inferAddClipsShape();
    if (!add.ok) {
      throw new Error(`${add.reason}:${add.check.name}:${add.check.detail}`);
    }
    const sceneId = payload.sceneId ?? payload.Lc ?? payload.Ic;
    const workflows = payload.workflows ?? payload.rg ?? [];
    const completion = payload.completion ?? payload.De ?? payload.ve;
    const out: Record<string, unknown> = {
      type: "add_workflows_to_scene",
      [add.format.sceneId]: sceneId,
      [add.format.sceneWorkflows]: workflows,
      position: payload.position,
    };
    if (completion && add.format.completion) {
      out[add.format.completion] = completion;
    }
    return out;
  }

  if (action === "create_entity") {
    const entity = inferCreateEntityShape();
    if (!entity.ok) {
      throw new Error(`${entity.reason}:${entity.check.name}:${entity.check.detail}`);
    }
    const completion = payload.completion ?? payload.De ?? payload.ve;
    const out: Record<string, unknown> = {
      type: "create_entity",
      [entity.format.entityType]: 1,
      displayName: payload.displayName,
    };
    if (completion && entity.format.completion) {
      out[entity.format.completion] = completion;
    }
    return out;
  }

  if (action === "batch_move_to_collection") {
    const col = inferCollectionWriteShape();
    if (!col.ok) {
      throw new Error(`${col.reason}:${col.check.name}:${col.check.detail}`);
    }
    if (col.format.moveTarget in payload && col.format.moveTiles in payload) {
      return payload;
    }
    return {
      type: "batch_move_to_collection",
      [col.format.moveTarget]: payload.target ?? null,
      [col.format.moveTiles]: payload.tiles ?? [],
    };
  }

  if (action === "batch_set_tiles_trashed") {
    const trash = inferAssetTrashShape();
    if (!trash.ok) {
      throw new Error(`${trash.reason}:${trash.check.name}:${trash.check.detail}`);
    }
    return payload;
  }

  return payload;
}

registerTrashedFieldReader(() => {
  const shape = inferAssetTrashShape();
  return shape.ok ? shape.format.trashed : null;
});
