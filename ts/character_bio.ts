// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Write and confirm character personality notes in the project store.

import { readOwn } from "./angular";
import { delay, findSnackbarMatch, isTrashedTile, setNativeValue } from "./dom";
import { characterBioCompatibility } from "./frontend_compatibility";
import {
  mutateAndVerify,
  projectMutationPending,
  projectsToRefresh,
  projectStore,
  readProjectStore,
  refreshAfterUnknown,
} from "./project_store";
import { runtimeState } from "./state";
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

/** Finds the rendered personality notes textarea in the open character editor. */
function findPersonalityTextarea(): HTMLTextAreaElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLTextAreaElement>(
      'textarea[aria-label="Character personality"], flow-character-form textarea',
    ),
  );
  return (
    candidates.find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.disabled && !el.closest("[inert]");
    }) ?? null
  );
}

/** Reads personality notes from a store tile across protobuf and flat fields. */
function readTilePersonalityNotes(tile: FlowTile | undefined): string | null {
  if (!tile) return null;
  const fromProto = characterPersonalityNotes(tile);
  if (fromProto !== null) return fromProto;
  if (typeof tile.personalityNotes === "string") return tile.personalityNotes;
  if (typeof tile.Mv === "string") return tile.Mv;
  return null;
}

/** Returns true when the discovered store queue still holds pending mutations. */
function storeQueuePending(): boolean {
  const svc = runtimeState.lService;
  const getters = [svc?.lc?.ka, svc?._ap?.lc?.ka, svc?.ha?.lc?.ka];
  for (const ka of getters) {
    if (typeof ka !== "function") continue;
    try {
      const q = ka();
      if (Array.isArray(q?.items) && q.items.length > 0) return true;
    } catch {
      // Ignore unreadable queue handles.
    }
  }
  return false;
}

/** Saves and confirms character personality notes through the open character editor view. */
export async function characterBioEditorOp(bio: string): Promise<unknown> {
  let textarea: HTMLTextAreaElement | null = null;
  for (let i = 0; i < 25; i++) {
    textarea = findPersonalityTextarea();
    if (textarea) break;
    await delay(200);
  }
  if (!textarea) {
    return { ok: false, error: "character_bio_editor_not_found" };
  }

  const expected = bio.trim();
  const routeCharId = /\/character\/([^/?#]+)/.exec(location.pathname || "")?.[1] ?? null;
  textarea.scrollIntoView({ block: "center" });
  textarea.focus();
  setNativeValue(textarea, bio, true);

  let blurFired = false;
  const onBlur = (): void => {
    blurFired = true;
  };
  textarea.addEventListener("blur", onBlur, { once: true });
  textarea.blur();
  textarea.removeEventListener("blur", onBlur);
  if (!blurFired) {
    textarea.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
    textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  }

  await delay(400);
  for (let i = 0; i < 24; i++) {
    const snackErr = findSnackbarMatch(/failed|error|unable|couldn't/i);
    if (snackErr) {
      return { ok: false, error: "character_bio_save_failed", detail: snackErr };
    }
    const live = findPersonalityTextarea() ?? textarea;
    if (live.value.trim() !== expected) {
      await delay(200);
      continue;
    }
    if (storeQueuePending()) {
      await delay(250);
      continue;
    }
    const tileMap = runtimeState.store?.getTileMap?.();
    const tile = routeCharId && tileMap instanceof Map ? tileMap.get(routeCharId) : undefined;
    const stored = readTilePersonalityNotes(tile);
    if (stored !== null) {
      if (stored.trim() === expected) {
        return { ok: true, confirmed: true, bio: live.value };
      }
      await delay(250);
      continue;
    }
    if (i >= 2) {
      return { ok: true, confirmed: true, bio: live.value };
    }
    await delay(250);
  }
  return { ok: false, error: "character_bio_not_confirmed" };
}
