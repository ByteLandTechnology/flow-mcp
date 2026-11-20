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

/** Reads a field from a dense or sparse serialized protobuf message. */
function entityField(message: unknown, field: number): unknown {
  if (!Array.isArray(message)) return undefined;
  const sparse = message.at(-1);
  return Array.isArray(sparse)
    ? message[field - 1]
    : readOwn(sparse, String(field)) ?? message[field - 1];
}

/** Reads the notes from the character entity. Returns null when the entity cannot be read. */
export function characterPersonalityNotes(tile: FlowTile): string | null {
  const entity = readOwn(tile, "Rc");
  const serialize = readOwn(entity, "toJSON");
  if (typeof serialize !== "function") return null;
  try {
    // The nested fields are entity_info (4), character_info (3), and personality_notes (3).
    const info = entityField(entityField(serialize.call(entity), 4), 3);
    if (!Array.isArray(info)) return null;
    const notes = entityField(info, 3);
    if (notes == null) return "";
    return typeof notes === "string" ? notes : null;
  } catch {
    return null;
  }
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
