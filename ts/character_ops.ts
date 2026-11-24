// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Open, finish, create, and update profile fields for Google Flow characters.

import { findRouter } from "./angular";
import { clickButtonByRegex, delay, isVisibleEnabled, setNativeValue } from "./dom";
import { clearStore, runtimeState } from "./state";
import type { CharacterOpRequest } from "./types";

/** Creates, opens, updates, or finishes character entity editing in Google Flow. */
export async function characterOp(req: CharacterOpRequest): Promise<unknown> {
  const helper = runtimeState.store;
  const getMap = () => helper?.getTileMap?.();
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
      await router.navigate(["/project", pid, "character", cid]);
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
    if (
      runtimeState.projectId === pid &&
      runtimeState.lService &&
      !(typeof runtimeState.lService.Ba === "object" && runtimeState.lService.Ba?.Va) &&
      !(typeof runtimeState.lService.Ca === "object" && runtimeState.lService.Ca?.Va) &&
      !(typeof runtimeState.lService._ap?.Ba === "object" && runtimeState.lService._ap?.Ba?.Va) &&
      !(typeof runtimeState.lService._ap?.Ca === "object" && runtimeState.lService._ap?.Ca?.Va)
    ) {
      runtimeState.routePath = location.pathname;
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

  const tileMap = getMap();
  const projectMatch = /(\/(?:fx\/tools\/flow\/)?project\/[^/?#]+)/.exec(
    location.pathname || "",
  );
  const projectBasePath = projectMatch ? projectMatch[1] : null;
  let charId = req?.character_id ? String(req.character_id).trim() : null;

  if (action === "create") {
    if (!helper?.mutate) {
      return { ok: false, error: "store_mutate_missing" };
    }
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

    const mutatePromise = Promise.resolve(
      helper.mutate({
        type: "create_entity",
        pM: 1,
        A3: 1,
        AW: 1,
        displayName: charName,
        tb: undefined,
        ub: undefined,
        De: { resolve: resolveDe, reject: rejectDe },
        ve: { resolve: resolveDe, reject: rejectDe },
      }),
    ).then(
      (v) => {
        const resObj = v as { NH?: unknown; MF?: unknown; II?: unknown } | null;
        const created = resObj?.NH ?? resObj?.MF ?? resObj?.II;
        if (created && !resolvedTile) resolvedTile = created;
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
      if (projectBasePath) {
        return {
          ok: false,
          need_navigate: `${location.origin}${projectBasePath}/character/${encodeURIComponent(charId)}?hl=en`,
        };
      }
      return { ok: false, error: "not_in_project_route" };
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
      if (charId && helper?.rename) {
        await helper.rename(charId, nameStr);
        applied.push("store_name");
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
