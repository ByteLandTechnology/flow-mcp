// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Open, finish, create, and update profile fields for Google Flow characters.

import { buildProjectUrl, findRouter, navigateSpa, readOwn } from "./angular";
import { clickButtonByRegex, delay, isVisibleEnabled, setNativeValue } from "./dom";
import { activeProjectStoreFormat, characterCreateFormat } from "./frontend_builds";
import { clearStore, runtimeState } from "./state";
import type { CharacterOpRequest } from "./types";

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
    const isCharacterPath = (): boolean =>
      /\/character(?:\/|$)/.test(location.pathname || "");
    const isSubRoutePath = (): boolean =>
      /\/project\/[^/?#]+\/[^/?#]+/.test(location.pathname || "");
    const backBtn = document.querySelector(
      'flow-character-edit-header .back-button, button[aria-label="Go back"]',
    );
    let closed = clickButtonByRegex(/^(?:done(?: editing)?|go back)$/i, document);
    if (!closed && isVisibleEnabled(backBtn)) {
      backBtn.click();
      closed = true;
    }
    for (let i = 0; i < 25; i++) {
      if (!isCharacterPath()) break;
      await delay(100);
    }
    const exited = !isCharacterPath();
    let inWorkspace = false;
    if (exited && !isSubRoutePath()) {
      for (let i = 0; i < 20; i++) {
        if (
          !isSubRoutePath() &&
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

  if (!activeProjectStoreFormat()) {
    clearStore();
    return { ok: false, error: "unsupported_front_end" };
  }
  if (helper && !helper.isCurrent()) clearStore();
  const activeHelper = runtimeState.store;
  const projectMatch = /\/project\/([^/?#]+)/.exec(location.pathname || "");
  const currentPid = projectMatch ? projectMatch[1] : null;
  let charId = req?.character_id ? String(req.character_id).trim() : null;

  if (action === "create") {
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
    if (activeHelper && !activeHelper.isReady()) {
      return { ok: false, error: "store_loading" };
    }

    for (let i = 0; i < 50; i++) {
      if (
        document.querySelector(
          'flow-character-form, flow-character-image-preview, input[aria-label="Character name"]',
        )
      ) {
        break;
      }
      await delay(100);
    }

    const applied: string[] = [];
    if (req?.name) {
      const nameStr = String(req.name).trim();
      const nameInput = document.querySelector(
        'input[aria-label="Character name"]',
      );
      if (nameInput instanceof HTMLInputElement) {
        nameInput.focus();
        setNativeValue(nameInput, nameStr, true);
        applied.push("ui_name");
        await delay(150);
      }
      if (charId && activeHelper?.rename) {
        try {
          await activeHelper.rename(charId, nameStr);
          applied.push("store_name");
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err ?? "rename_failed"),
          };
        }
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
