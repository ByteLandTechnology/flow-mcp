// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Write and confirm character personality notes in the project store.

import { readOwn } from "./angular";
import { isTrashedTile } from "./dom";
import { characterBioCompatibility } from "./frontend_compatibility";
import {
  mutateAndVerify,
  projectMutationPending,
  projectsToRefresh,
  projectStore,
  readProjectStore,
  refreshAfterUnknown,
} from "./project_store";
import type { FlowTile } from "./types";

/** Arguments for an operation on character personality notes. */
export type CharacterBioRequest =
  | { action: "list" | "check" }
  | { action: "set"; id: string; bio: string };

/** Returns true when `value` is a plain object that maps protobuf field keys to values. */
function isSparseFieldMap(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Map) &&
    !(value instanceof Set)
  );
}

/** Reads a 1-based field from a dense or sparse serialized protobuf message. */
function entityField(message: unknown, field: number): unknown {
  if (Array.isArray(message)) {
    const sparse = message.at(-1);
    if (isSparseFieldMap(sparse)) {
      const denseEnd = message.length - 1;
      return (
        readOwn(sparse, String(field)) ??
        (field >= 1 && field - 1 < denseEnd ? message[field - 1] : undefined)
      );
    }
    return field >= 1 ? message[field - 1] : undefined;
  }
  if (isSparseFieldMap(message)) {
    return readOwn(message, String(field));
  }
  return undefined;
}

/** Extracts `character_info` (field 3 of `entity_info` at field 4) from a serialized entity. */
function extractCharacterInfo(serialized: unknown): unknown {
  const info = entityField(entityField(serialized, 4), 3);
  return Array.isArray(info) || isSparseFieldMap(info) ? info : null;
}

/** Reads `character_info` from `tile.Rc` or any protobuf-serializable entity on `tile`. */
function readCharacterInfo(tile: FlowTile): unknown {
  const decodeEntity = (entity: unknown): unknown => {
    if (Array.isArray(entity)) return extractCharacterInfo(entity);
    const serialize = readOwn(entity, "toJSON");
    if (typeof serialize !== "function") return null;
    try {
      return extractCharacterInfo(serialize.call(entity));
    } catch {
      return null;
    }
  };
  const direct = decodeEntity(readOwn(tile, "Rc"));
  if (direct !== null) return direct;
  for (const [key, value] of Object.entries(tile as Record<string, unknown>)) {
    if (key === "Rc" || !value || typeof value !== "object") continue;
    const found = decodeEntity(value);
    if (found !== null) return found;
  }
  return null;
}

/** Extracts the first voice identifier string from a dense or sparse `audio_references` value. */
function decodeProtoVoice(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || /^(?:https?:\/\/|blob:|data:)/i.test(trimmed)) return null;
    return trimmed;
  }
  if (Array.isArray(value)) {
    const tail = value.at(-1);
    const numericTail =
      isSparseFieldMap(tail) &&
      Object.keys(tail).every((k) => /^\d+$/.test(k));
    const denseEnd = numericTail ? value.length - 1 : value.length;
    const entries: Array<[number, unknown]> = [];
    for (let i = 0; i < denseEnd; i += 1) {
      if (value[i] != null) entries.push([i + 1, value[i]]);
    }
    if (numericTail) {
      for (const key of Object.keys(tail)) {
        const sparseVal = readOwn(tail, key);
        if (sparseVal != null) entries.push([Number(key), sparseVal]);
      }
      entries.sort((a, b) => a[0] - b[0]);
    }
    for (const [, entryVal] of entries) {
      const hit = decodeProtoVoice(entryVal, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (isSparseFieldMap(value)) {
    for (const namedKey of ["voiceName", "voiceId", "title", "name", "id"]) {
      const named = decodeProtoVoice(readOwn(value, namedKey), depth + 1);
      if (named) return named;
    }
    const numericKeys = Object.keys(value)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    for (const key of numericKeys) {
      const hit = decodeProtoVoice(readOwn(value, key), depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Reads the assigned voice identifier from field 2 (`audio_references`) of `character_info`. */
export function characterVoice(tile: FlowTile): string | null {
  const info = readCharacterInfo(tile);
  if (!info) return null;
  return decodeProtoVoice(entityField(info, 2));
}

/** Reads the notes from the character entity. Returns null when the entity cannot be read. */
export function characterPersonalityNotes(tile: FlowTile): string | null {
  const info = readCharacterInfo(tile);
  if (!info) return null;
  const notes = entityField(info, 3);
  if (notes == null) return "";
  return typeof notes === "string" ? notes : null;
}

/** Returns true for a character that can receive new notes. */
function editableCharacter(tile: FlowTile | undefined): tile is FlowTile {
  return Boolean(tile && tile.type === "CHARACTER" && !tile.isPending && !isTrashedTile(tile));
}

/** Reads or changes character notes in the pinned project without opening the editor. */
export async function characterBioOp(
  projectId: string,
  session: string,
  request: CharacterBioRequest,
): Promise<unknown> {
  const store = projectStore(projectId, session);
  let tiles = store && readProjectStore(store);
  if (!store || !tiles) return { ok: false, error: "project_store_changed" };

  const support = characterBioCompatibility();
  if (!support.ok) return support;
  if (projectMutationPending) return { ok: false, error: "project_mutation_pending" };
  if (request.action === "check") return { ok: true };

  if (projectsToRefresh.has(projectId) || (request.action === "set" && !tiles.has(request.id))) {
    tiles = await refreshAfterUnknown(store);
    if (!tiles) return { ok: false, error: "project_refresh_failed", project_id: projectId };
  }

  if (request.action === "list") {
    const characters = Array.from(tiles, ([id, tile]) =>
      editableCharacter(tile) ? { id, name: tile.displayName ?? "", kind: "character" } : null,
    ).filter((tile) => tile !== null);
    return { ok: true, characters };
  }
  if (request.action !== "set") return { ok: false, error: "unknown_character_bio_action" };
  const { id, bio } = request;
  const tile = tiles.get(id);
  if (!editableCharacter(tile)) return { ok: false, error: "character_not_found", id };
  if (characterPersonalityNotes(tile) === null) {
    return { ok: false, error: "character_bio_unreadable", id };
  }

  const { format } = support;
  const after = await mutateAndVerify(
    store,
    {
      type: "single_tile",
      [format.tileId]: id,
      [format.tileChange]: { type: "set_character_personality_notes", [format.notes]: bio },
    },
    (fresh) => {
      const character = fresh.get(id);
      return editableCharacter(character) && characterPersonalityNotes(character) === bio;
    },
  );
  return after
    ? { ok: true }
    : { ok: false, error: "outcome_unknown", stage: "set_character_bio", project_id: projectId, id };
}
