// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Open, finish, create, and update profile fields for Google Flow characters.

import { findRouter, readOwn } from "./angular";
import { clickButtonByRegex, delay, elText, isVisibleEnabled, setNativeValue } from "./dom";
import { inferCreateEntityShape, inferSingleTileShape } from "./mutation_shapes";
import { clearStore, runtimeState } from "./state";
import { isComponentDestroyed } from "./store_shapes";
import type { CharacterOpRequest } from "./types";

/** Maximum wait for `create_entity` completion or character route creation. */
const CHARACTER_CREATE_TIMEOUT_MS = 10_000;

/** Finds the character personality textarea in the character editor form. */
function findCharacterBioInput(): HTMLTextAreaElement | HTMLInputElement | null {
  const direct = document.querySelector(
    'textarea[aria-label="Character personality"], textarea[aria-label*="personality" i], input[aria-label="Character personality"], flow-character-form textarea',
  );
  if (direct instanceof HTMLTextAreaElement || direct instanceof HTMLInputElement) {
    return direct;
  }
  for (const el of document.querySelectorAll("textarea")) {
    if (el instanceof HTMLTextAreaElement && el.getClientRects().length > 0) {
      const hint = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`;
      if (/personality|bio|description|notes|about/i.test(hint)) return el;
    }
  }
  return null;
}

/** Creates a character through workspace UI controls when direct `create_entity` cannot run. */
async function createCharacterViaUi(
  charName: string,
  req: CharacterOpRequest,
): Promise<Record<string, unknown>> {
  const knownCharIds = new Set<string>();
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href*="/character/"]')) {
    const id = /\/character\/([^/?#]+)/.exec(link.getAttribute("href") || "")?.[1];
    if (id) knownCharIds.add(id);
  }
  for (const tile of document.querySelectorAll("flow-grid-tile-container[data-tile-id]")) {
    const tid = tile.getAttribute("data-tile-id");
    if (tid) knownCharIds.add(tid);
  }

  let clicked = clickButtonByRegex(
    /^(?:create character|new character|add character)$/i,
    document,
  );
  if (!clicked) {
    const addMenu =
      document.querySelector('button[aria-label="Add media menu"]') ||
      Array.from(document.querySelectorAll('button, [role="button"]')).find(
        (b) =>
          isVisibleEnabled(b) &&
          /^(?:add media menu|add|new|\+)$/i.test((b.getAttribute("aria-label") || elText(b)).trim()),
      );
    if (isVisibleEnabled(addMenu)) {
      addMenu.click();
      await delay(200);
      const menuTarget = Array.from(
        document.querySelectorAll('[role="menuitem"], .cdk-overlay-pane button, [role="menu"] button'),
      ).find(
        (el): el is HTMLElement =>
          isVisibleEnabled(el) && /\bcharacter\b/i.test(`${el.getAttribute("aria-label") || ""} ${elText(el)}`),
      );
      if (menuTarget) {
        menuTarget.click();
        clicked = true;
      }
    }
  }
  if (!clicked) {
    return { ok: false, error: "character_create_ui_trigger_not_found" };
  }

  let charId: string | null = null;
  const deadline = performance.now() + CHARACTER_CREATE_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const inRoute = /\/character\/([^/?#]+)/.exec(location.pathname || "")?.[1];
    if (inRoute) {
      charId = inRoute;
      break;
    }
    for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href*="/character/"]')) {
      const id = /\/character\/([^/?#]+)/.exec(link.getAttribute("href") || "")?.[1];
      if (id && !knownCharIds.has(id)) {
        charId = id;
        break;
      }
    }
    if (!charId) {
      for (const tile of document.querySelectorAll("flow-grid-tile-container[data-tile-id]")) {
        const tid = tile.getAttribute("data-tile-id");
        const kind = (tile.getAttribute("data-tile-kind") || tile.getAttribute("data-kind") || "").toLowerCase();
        if (tid && !knownCharIds.has(tid) && kind === "character") {
          charId = tid;
          break;
        }
      }
    }
    if (charId) break;
    await delay(100);
  }
  if (!charId) {
    return { ok: false, error: "created_character_id_not_found" };
  }

  const applied = ["ui_create_character"];
  if (location.pathname.includes(`/character/${charId}`)) {
    for (let i = 0; i < 25; i++) {
      if (document.querySelector('input[aria-label="Character name"], flow-character-form')) break;
      await delay(100);
    }
    const nameInput = document.querySelector('input[aria-label="Character name"]');
    if (nameInput instanceof HTMLInputElement && charName) {
      nameInput.focus();
      setNativeValue(nameInput, charName, true);
      nameInput.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      applied.push("ui_name");
      await delay(120);
    }
    if (typeof req?.bio === "string") {
      const bioInput = findCharacterBioInput();
      if (bioInput) {
        bioInput.focus();
        setNativeValue(bioInput, req.bio, true);
        bioInput.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
        applied.push("ui_bio");
        await delay(120);
      }
    }
  }

  const needsPageUpdate = Boolean(
    req?.voice ||
      (Array.isArray(req?.asset_ids) && req.asset_ids.length > 0) ||
      req?.look_prompt ||
      (typeof req?.bio === "string" && !applied.includes("ui_bio")) ||
      (charName && !applied.includes("ui_name")),
  );
  return {
    ok: true,
    id: charId,
    name: charName,
    ...(needsPageUpdate ? { need_update_on_page: true } : {}),
    applied,
  };
}

/** Creates, opens, updates, or finishes character entity editing in Google Flow. */
export async function characterOp(req: CharacterOpRequest): Promise<unknown> {
  const helper = runtimeState.store;
  const getMap = () => helper?.getTileMap?.();
  const action = String(req?.action || "").toLowerCase();

  if (action === "open_editor") {
    const pid = String(req?.project_id || "").trim();
    const cid = String(req?.character_id || "").trim();
    if (!pid || !cid) return { ok: false, error: "missing_character_route_ids" };
    const targetSuffix = `/character/${cid}`;
    if (!location.pathname.includes(targetSuffix)) {
      const router = findRouter();
      if (router) {
        await router.navigate(["/project", pid, "character", cid]);
      } else {
        const link = document.querySelector<HTMLElement>(`a[href*="/character/${CSS.escape(cid)}"]`);
        if (!link) return { ok: false, error: "angular_router_not_found" };
        link.click();
      }
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
      return { ok: false, error: "character_editor_timeout", path: location.pathname };
    }
    if (
      runtimeState.projectId === pid &&
      runtimeState.lService &&
      !isComponentDestroyed(runtimeState.lService)
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
        if (document.querySelector("flow-project-page, flow-grid-tile-container")) {
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
  const projectMatch = /(\/(?:fx\/tools\/flow\/)?project\/[^/?#]+)/.exec(location.pathname || "");
  const projectBasePath = projectMatch ? projectMatch[1] : null;
  let charId = req?.character_id ? String(req.character_id).trim() : null;

  if (action === "create") {
    const charName = String(req?.name || "Character").trim() || "Character";
    const shape = helper?.mutate ? inferCreateEntityShape() : null;
    if (!helper?.mutate || !shape?.ok) {
      return await createCharacterViaUi(charName, req);
    }

    const existingIds = new Set<string>();
    if (tileMap instanceof Map) {
      for (const [k, v] of tileMap.entries()) {
        if (String(v?.type || "").toUpperCase() === "CHARACTER") {
          existingIds.add(String(v?.id ?? k));
        }
      }
    }

    let resolvedTile: unknown = null;
    let mutateErr: string | null = null;
    const completion = {
      resolve: (v: unknown) => {
        resolvedTile ??= v;
      },
      reject: (e: unknown) => {
        const errObj = e as { message?: unknown } | null;
        mutateErr ??= String(errObj?.message || e || "create_entity_failed");
      },
    };

    const extractResponseEntity = (resp: unknown): unknown => {
      if (!resp || typeof resp !== "object") return null;
      if (typeof readOwn(resp, "id") === "string") return resp;
      for (const key of Object.keys(resp)) {
        const nested = readOwn(resp, key);
        if (nested && typeof nested === "object" && typeof readOwn(nested, "id") === "string") {
          return nested;
        }
      }
      return null;
    };

    const deadline = performance.now() + CHARACTER_CREATE_TIMEOUT_MS;
    void Promise.resolve()
      .then(() =>
        helper.mutate({
          type: "create_entity",
          displayName: charName,
          completion,
        }),
      )
      .then((v) => {
        const created = extractResponseEntity(v);
        if (created && !resolvedTile) resolvedTile = created;
      }, completion.reject);

    const resolvedId = (): string | null => {
      if (resolvedTile && typeof resolvedTile === "object") {
        const id = readOwn(resolvedTile, "id");
        if (id) return String(id);
      }
      return null;
    };

    while (performance.now() < deadline) {
      if (mutateErr) return { ok: false, error: mutateErr };
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

    if (mutateErr) return { ok: false, error: mutateErr };
    if (!charId) return { ok: false, error: "created_character_id_not_found" };

    const needsPageUpdate = Boolean(
      req?.voice ||
        (Array.isArray(req?.asset_ids) && req.asset_ids.length > 0) ||
        req?.look_prompt ||
        typeof req?.bio === "string",
    );
    return {
      ok: true,
      id: charId,
      name: charName,
      ...(needsPageUpdate ? { need_update_on_page: true } : {}),
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
      const nameInput = document.querySelector('input[aria-label="Character name"]');
      if (nameInput instanceof HTMLInputElement) {
        nameInput.focus();
        setNativeValue(nameInput, nameStr, true);
        nameInput.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
        applied.push("ui_name");
        await delay(150);
      }
      if (charId && helper?.rename && inferSingleTileShape().ok) {
        await helper.rename(charId, nameStr);
        applied.push("store_name");
      }
    }
    if (typeof req?.bio === "string") {
      const bioInput = findCharacterBioInput();
      if (!bioInput) {
        return { ok: false, error: "character_bio_input_not_found" };
      }
      bioInput.focus();
      setNativeValue(bioInput, req.bio, true);
      bioInput.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      applied.push("ui_bio");
      await delay(150);
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
