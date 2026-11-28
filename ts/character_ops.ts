// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Open, finish, create, and update profile fields for Google Flow characters.

import { buildProjectUrl, findRouter, navigateSpa, readOwn } from "./angular";
import { characterPersonalityNotes } from "./character_bio";
import { clickButtonByRegex, delay, isVisibleEnabled, setNativeValue } from "./dom";
import {
  activeProjectStoreFormat,
  characterCreateFormat,
  readBuildLabel,
} from "./frontend_builds";
import { currentProjectStore, refreshProjectStore } from "./project_store";
import { clearStore, runtimeState } from "./state";
import type { CharacterOpRequest, FlowTile } from "./types";

/** Selector for the character name input inside `flow-character-form`. */
const CHARACTER_NAME_INPUT_SELECTOR =
  'flow-character-form input[aria-label="Character name"], input[aria-label="Character name"], flow-character-form input.name-input';

/** Selector for the character personality textarea inside `flow-character-form`. */
const CHARACTER_BIO_INPUT_SELECTOR =
  'flow-character-form textarea[aria-label="Character personality"], textarea[aria-label="Character personality"], flow-character-form textarea.personality-textarea';

/** Returns true when `el` is an enabled, non-inert text control. */
function isEditableField(
  el: Element | null,
): el is HTMLInputElement | HTMLTextAreaElement {
  return (
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
    !el.disabled &&
    !el.readOnly &&
    !el.closest("[inert]")
  );
}

/** Reads normalized personality notes from `tile`, or null when unreadable. */
function readCharacterTileBio(tile: FlowTile | undefined): string | null {
  if (!tile) return null;
  const fromEntity = characterPersonalityNotes(tile);
  if (fromEntity !== null) return fromEntity;
  return typeof tile.personalityNotes === "string" ? tile.personalityNotes : null;
}

/** Polls the bound project store after form debounce until `matches` holds across two checks. */
async function confirmCharacterStoreReadback(
  projectId: string | null,
  charId: string,
  matches: (tile: FlowTile | undefined) => boolean,
): Promise<boolean> {
  await delay(550);
  for (let i = 0; i < 30; i += 1) {
    const busy = Boolean(
      document.querySelector(
        'flow-character-form [aria-busy="true"], flow-character-edit-page [aria-busy="true"]',
      ),
    );
    if (!busy && i > 0 && i % 3 === 0 && projectId) {
      const liveStore = currentProjectStore(projectId);
      if (liveStore) {
        await refreshProjectStore(liveStore).catch(() => null);
      }
    }
    const tile = runtimeState.store?.getTileMap?.()?.get(charId);
    if (!busy && matches(tile)) {
      await delay(300);
      if (projectId) {
        const liveStore = currentProjectStore(projectId);
        if (liveStore) {
          await refreshProjectStore(liveStore).catch(() => null);
        }
      }
      const settled = runtimeState.store?.getTileMap?.()?.get(charId);
      if (matches(settled)) return true;
    }
    await delay(250);
  }
  return false;
}

/** Creates, opens, updates, or finishes character entity editing in Google Flow. */
export async function characterOp(req: CharacterOpRequest): Promise<unknown> {
  const helper = runtimeState.store;
  const getMap = () => runtimeState.store?.getTileMap?.();
  const action = String(req?.action || "").toLowerCase();

  if (action === "open_editor") {
    const pid = String(req?.project_id || "").trim();
    const cid = String(req?.character_id || "").trim();
    if (!pid || !cid) {
      return { ok: false, error: "missing_character_route_ids" };
    }
    const targetSuffix = `/character/${cid}`;
    if (!location.pathname.includes(targetSuffix)) {
      const router = findRouter();
      if (!router) {
        return { ok: false, error: "angular_router_not_found" };
      }
      await navigateSpa(router, ["/project", pid, "character", cid]);
    }
    let ready = false;
    for (let i = 0; i < 60; i += 1) {
      const hasUrl = location.pathname.includes(targetSuffix);
      const hasEditor = Boolean(
        document.querySelector(
          "flow-character-edit-page, flow-character-preview-panel, flow-character-image-preview, flow-character-form",
        ),
      );
      if (hasUrl && hasEditor) {
        ready = true;
        break;
      }
      await delay(100);
    }
    if (!ready) {
      return {
        ok: false,
        error: "character_editor_timeout",
        path: location.pathname,
      };
    }
    if (runtimeState.projectId === pid && helper?.isCurrent()) {
      runtimeState.routePath = location.pathname;
    } else if (helper && !helper.isCurrent()) {
      clearStore();
    }
    return { ok: true, spa: true, path: location.pathname };
  }

  if (action === "finish") {
    const backBtn = document.querySelector(
      'flow-character-edit-header .back-button, button[aria-label="Go back"]',
    );
    let closed = clickButtonByRegex(/^(?:done(?: editing)?|go back)$/i, document);
    if (!closed && isVisibleEnabled(backBtn)) {
      backBtn.click();
      closed = true;
    }
    for (let i = 0; i < 25; i++) {
      if (!location.pathname.includes("/character/")) break;
      await delay(100);
    }
    const exited = !location.pathname.includes("/character/");
    let inWorkspace = false;
    if (exited) {
      for (let i = 0; i < 20; i++) {
        if (
          document.querySelector("flow-project-page, flow-grid-tile-container")
        ) {
          inWorkspace = true;
          break;
        }
        await delay(100);
      }
    }
    clearStore();
    return { ok: true, closed, in_workspace: inWorkspace };
  }

  if (helper && !helper.isCurrent()) clearStore();
  const activeHelper = runtimeState.store;
  const projectMatch = /\/project\/([^/?#]+)/.exec(location.pathname || "");
  const currentPid = projectMatch ? projectMatch[1] : null;
  let charId = req?.character_id ? String(req.character_id).trim() : null;

  if (action === "create") {
    if (!activeProjectStoreFormat()) {
      return { ok: false, error: "unsupported_front_end", build: readBuildLabel() };
    }
    if (!activeHelper) {
      return { ok: false, error: "store_not_bound" };
    }
    if (!activeHelper.isReady()) {
      return { ok: false, error: "store_loading" };
    }
    if (!activeHelper.mutate) {
      return { ok: false, error: "store_mutate_missing" };
    }
    const tileMap = activeHelper.getTileMap();
    const existingIds = new Set<string>();
    if (tileMap instanceof Map) {
      for (const [k, v] of tileMap.entries()) {
        if (String(v?.type || "").toUpperCase() === "CHARACTER") {
          existingIds.add(String(v?.id ?? k));
        }
      }
    }

    const charName = String(req?.name || "Character").trim() || "Character";
    let resolveDe: (v: unknown) => void = () => {};
    let rejectDe: (e: unknown) => void = () => {};
    let resolvedTile: unknown = null;
    let mutateErr: string | null = null;
    const dePromise = new Promise<unknown>((res, rej) => {
      resolveDe = res;
      rejectDe = rej;
    });
    dePromise.then(
      (v) => {
        resolvedTile = v;
      },
      (e) => {
        const errObj = e as { message?: unknown } | null;
        mutateErr = String(errObj?.message || e || "create_entity_failed");
      },
    );

    const format = characterCreateFormat();
    if (!format) {
      return { ok: false, error: "unsupported_front_end", build: readBuildLabel() };
    }
    const completion = { resolve: resolveDe, reject: rejectDe };
    const payload: Record<string, unknown> = {
      type: "create_entity",
      displayName: charName,
    };
    for (const key of format.entityKinds) payload[key] = 1;
    for (const key of format.collections) payload[key] = undefined;
    for (const key of format.completions) payload[key] = completion;

    const mutatePromise = Promise.resolve(activeHelper.mutate(payload)).then(
      (v) => {
        for (const key of format.created) {
          const created = readOwn(v, key);
          if (created) {
            if (!resolvedTile) resolvedTile = created;
            break;
          }
        }
      },
      (e) => {
        if (!mutateErr) {
          const errObj = e as { message?: unknown } | null;
          mutateErr = String(errObj?.message || e || "create_entity_failed");
        }
      },
    );

    const resolvedId = (): string | null => {
      if (resolvedTile && typeof resolvedTile === "object") {
        const id = (resolvedTile as { id?: unknown }).id;
        if (id) return String(id);
      }
      return null;
    };

    for (let i = 0; i < 80; i++) {
      if (mutateErr) {
        return { ok: false, error: mutateErr };
      }
      const directId = resolvedId();
      if (directId) {
        charId = directId;
        break;
      }
      const mNow = getMap();
      if (mNow instanceof Map) {
        for (const [k, v] of mNow.entries()) {
          if (String(v?.type || "").toUpperCase() === "CHARACTER") {
            const cid = String(v?.id ?? k);
            if (!existingIds.has(cid)) {
              charId = cid;
              break;
            }
          }
        }
      }
      if (charId) break;
      await delay(100);
    }

    if (mutateErr) {
      return { ok: false, error: mutateErr };
    }
    if (!charId) {
      await Promise.race([mutatePromise, delay(200)]).catch(() => {});
      if (mutateErr) return { ok: false, error: mutateErr };
      const directId = resolvedId();
      if (directId) charId = directId;
    }
    if (!charId) {
      return { ok: false, error: "created_character_id_not_found" };
    }

    const needsPageUpdate = Boolean(
      req?.voice ||
        (Array.isArray(req?.asset_ids) && req.asset_ids.length > 0) ||
        req?.look_prompt,
    );
    if (needsPageUpdate) {
      return {
        ok: true,
        id: charId,
        name: charName,
        need_update_on_page: true,
        applied: ["create_entity"],
      };
    }

    return {
      ok: true,
      id: charId,
      name: charName,
      applied: ["create_entity"],
    };
  }

  if (action === "update") {
    if (!charId) return { ok: false, error: "missing_character_id" };
    if (!location.pathname.includes(`/character/${charId}`)) {
      if (currentPid) {
        return {
          ok: false,
          need_navigate: buildProjectUrl(currentPid, ["character", charId]),
        };
      }
      return { ok: false, error: "not_in_project_route" };
    }
    const needsStoreConfirm = Boolean(
      (req?.bio !== undefined && req?.bio !== null) ||
        (req?.name && !activeProjectStoreFormat()),
    );
    if (needsStoreConfirm && !activeHelper) {
      return { ok: false, error: "store_not_bound" };
    }
    if (activeHelper && !activeHelper.isReady()) {
      return { ok: false, error: "store_loading" };
    }

    for (let i = 0; i < 50; i++) {
      const nameReady =
        !req?.name ||
        isEditableField(document.querySelector(CHARACTER_NAME_INPUT_SELECTOR));
      const bioReady =
        req?.bio === undefined ||
        req?.bio === null ||
        isEditableField(document.querySelector(CHARACTER_BIO_INPUT_SELECTOR));
      if (
        nameReady &&
        bioReady &&
        document.querySelector(
          `flow-character-form, flow-character-image-preview, ${CHARACTER_NAME_INPUT_SELECTOR}, ${CHARACTER_BIO_INPUT_SELECTOR}`,
        )
      ) {
        break;
      }
      await delay(100);
    }

    const applied: string[] = [];
    if (req?.name) {
      const nameStr = String(req.name).trim();
      const nameInput = document.querySelector(CHARACTER_NAME_INPUT_SELECTOR);
      if (nameInput instanceof HTMLInputElement && isEditableField(nameInput)) {
        nameInput.focus();
        setNativeValue(nameInput, nameStr, true);
        nameInput.dispatchEvent(new Event("blur", { bubbles: true }));
        applied.push("ui_name");
        await delay(150);
      }
      if (activeProjectStoreFormat() && charId && activeHelper?.rename) {
        try {
          await activeHelper.rename(charId, nameStr);
          applied.push("store_name");
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err ?? "rename_failed"),
          };
        }
      } else if (!applied.includes("ui_name")) {
        return { ok: false, error: "character_name_input_not_found" };
      } else {
        const confirmed = await confirmCharacterStoreReadback(
          currentPid,
          charId,
          (tile) => String(tile?.displayName ?? "").trim() === nameStr,
        );
        if (!confirmed) {
          return { ok: false, error: "character_name_not_confirmed" };
        }
      }
    }

    if (req?.bio !== undefined && req?.bio !== null) {
      const bioStr = String(req.bio);
      const expectedBio = bioStr.trim();
      const bioInput = document.querySelector(CHARACTER_BIO_INPUT_SELECTOR);
      if (isEditableField(bioInput)) {
        bioInput.focus();
        setNativeValue(bioInput, bioStr, true);
        bioInput.dispatchEvent(new Event("blur", { bubbles: true }));
        await delay(200);
        const inputVal = bioInput.value ?? "";
        if (inputVal !== bioStr && inputVal.trim() !== expectedBio) {
          return { ok: false, error: "character_bio_input_mismatch" };
        }
        const confirmed = await confirmCharacterStoreReadback(
          currentPid,
          charId,
          (tile) => {
            const notes = readCharacterTileBio(tile);
            return notes !== null && notes.trim() === expectedBio;
          },
        );
        if (!confirmed) {
          return { ok: false, error: "character_bio_not_confirmed" };
        }
        applied.push("ui_bio");
      } else {
        return { ok: false, error: "character_bio_input_not_found" };
      }
    }

    return {
      ok: true,
      id: charId,
      name: req?.name || null,
      applied,
    };
  }

  return { ok: false, error: `unknown_character_op:${action}` };
}
