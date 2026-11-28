// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Open the Google Flow asset editor or delegate scene clips via Angular Router.

import {
  buildProjectUrl,
  findRouter,
  navigateSpa,
  readOwn,
  type NgContextCarrier,
} from "./angular";
import {
  delay,
  elText,
  isDisabledProp,
  isTrashedTile,
  isVisibleEnabled,
} from "./dom";
import {
  EDIT_PROMPT_BOX_SELECTOR,
  EDIT_SCOPE_SELECTOR,
  findEditVideoPromptBox,
  isExcludedComposerNode,
  readEditBlockReason,
  selectSceneTimelineClip,
} from "./edit_composer";
import { sceneClipIds, sceneContents } from "./scene_tiles";
import { clearStore, runtimeState } from "./state";

/** Finds a visible enabled prompt textbox inside edit containers outside excluded panels. */
function findVisibleTextbox(): Element | null {
  for (const scopeSel of [EDIT_PROMPT_BOX_SELECTOR, EDIT_SCOPE_SELECTOR]) {
    for (const root of document.querySelectorAll(scopeSel)) {
      if (isExcludedComposerNode(root)) continue;
      const candidates = Array.from(
        root.querySelectorAll(
          '.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"], textarea',
        ),
      );
      const hit = candidates.find(
        (el) =>
          el.getClientRects().length > 0 &&
          !isDisabledProp(el) &&
          !isExcludedComposerNode(el),
      );
      if (hit) return hit;
    }
  }
  return null;
}

/** Resolves scene delegation targets for `SCENE` tiles and clips owned by a scene. */
function resolveSceneDelegation(
  assetId: string,
  explicitSceneId?: string | null,
):
  | { kind: "blocked"; error: string; detail: string; clipIds: string[] }
  | { kind: "scene"; sceneId: string; clipId: string }
  | { kind: "direct" } {
  const explicit = String(explicitSceneId || "").trim();
  const store = runtimeState.store;
  const tileMap = store?.getTileMap?.();

  if (tileMap instanceof Map && assetId) {
    const rawTile = tileMap.get(assetId);
    const rawType = String(rawTile?.type || "").toUpperCase();
    if (rawTile && rawType === "SCENE") {
      const clipIds = sceneClipIds(rawTile);
      if (clipIds.length === 0) {
        return {
          kind: "blocked",
          error: "empty_scene",
          detail: "Scene contains no clips to edit",
          clipIds: [],
        };
      }
      if (clipIds.length > 1) {
        return {
          kind: "blocked",
          error: "multi_clip_scene",
          detail: `Scene contains multiple clips (${clipIds.join(", ")})`,
          clipIds,
        };
      }
      return { kind: "scene", sceneId: assetId, clipId: clipIds[0] };
    }

    if (explicit) {
      return { kind: "scene", sceneId: explicit, clipId: assetId };
    }

    if (rawType !== "IMAGE" && rawType !== "CHARACTER") {
      for (const st of tileMap.values()) {
        if (!st || isTrashedTile(st)) continue;
        if (String(st.type || "").toUpperCase() !== "SCENE") continue;
        const sid = String(st.id || st.workflowId || "").trim();
        if (!sid) continue;
        const { history } = sceneContents(st);
        const inScene =
          sceneClipIds(st).includes(assetId) || history.has(assetId);
        if (inScene) {
          return { kind: "scene", sceneId: sid, clipId: assetId };
        }
      }
    }
  } else if (explicit && assetId) {
    return { kind: "scene", sceneId: explicit, clipId: assetId };
  }

  return { kind: "direct" };
}

/** Opens `/edit/<id>` or delegates 1-clip scenes and scene clips to `/scene/<scene_id>`. */
export async function openEditAsset(
  assetId: string,
  mediaUrl: string | null,
  primaryMediaId: string | null,
  sceneId?: string | null,
): Promise<unknown> {
  const idStr = String(assetId || "").trim();
  const delegation = resolveSceneDelegation(idStr, sceneId);
  if (delegation.kind === "blocked") {
    return {
      opened: false,
      blocked: true,
      error: delegation.error,
      alert: delegation.detail,
      detail: delegation.detail,
      clip_ids: delegation.clipIds,
    };
  }

  const pm = /\/project\/([^/?#]+)/.exec(location.pathname || "");
  const pid = pm ? pm[1] : runtimeState.store?.projectId || null;
  const router = pid ? findRouter() : null;

  if (delegation.kind === "scene") {
    const targetSceneId = delegation.sceneId;
    const targetClipId = delegation.clipId;
    let onSceneBuilder =
      (location.pathname || "").includes(`/scene/${targetSceneId}`) &&
      Boolean(document.querySelector("flow-scene-builder"));

    if (!onSceneBuilder && router && pid) {
      await navigateSpa(router, ["/project", pid, "scene", targetSceneId]);
      for (let i = 0; i < 60; i += 1) {
        if (
          (location.pathname || "").includes(`/scene/${targetSceneId}`) &&
          document.querySelector("flow-scene-builder")
        ) {
          onSceneBuilder = true;
          break;
        }
        await delay(100);
      }
    }

    if (onSceneBuilder) {
      for (let i = 0; i < 40; i += 1) {
        if (
          document.querySelector(
            "flow-scene-timeline, flow-edit-video-prompt-box",
          )
        ) {
          break;
        }
        await delay(100);
      }
      const clipSelected = await selectSceneTimelineClip(
        targetClipId,
        primaryMediaId,
      );
      if (!clipSelected) {
        clearStore();
        return {
          opened: false,
          blocked: true,
          error: "scene_clip_not_selected",
          alert: `Could not select clip '${targetClipId}' in scene '${targetSceneId}'`,
          detail: `Could not select clip '${targetClipId}' in scene '${targetSceneId}'`,
          method: "scene_delegation",
          view: "scene_builder",
          scene_id: targetSceneId,
          clip_id: targetClipId,
        };
      }
      for (let i = 0; i < 20; i += 1) {
        if (findVisibleTextbox() || readEditBlockReason() !== null) break;
        await delay(100);
      }
      const alertText = readEditBlockReason();
      const hasTextbox = Boolean(findVisibleTextbox());
      clearStore();
      if (alertText) {
        return {
          opened: true,
          blocked: true,
          error: "editor_blocked",
          alert: alertText,
          detail: alertText,
          method: "scene_delegation",
          view: "scene_builder",
          scene_id: targetSceneId,
          clip_id: targetClipId,
        };
      }
      return {
        opened: hasTextbox,
        blocked: false,
        method: "scene_delegation",
        view: "scene_builder",
        scene_id: targetSceneId,
        clip_id: targetClipId,
        has_textbox: hasTextbox,
      };
    }

    if (pid) {
      return {
        opened: false,
        edit_url: buildProjectUrl(pid, ["scene", targetSceneId]),
        scene_id: targetSceneId,
        clip_id: targetClipId,
        method: "route_fallback_needed",
      };
    }
    return { opened: false, method: "none" };
  }

  const candidateIds = Array.from(
    new Set([idStr, String(primaryMediaId || "").trim()].filter(Boolean)),
  );

  let viewKind: string | null = null;
  if ((location.pathname || "").includes("/edit/")) {
    const edPage = document.querySelector(
      "flow-editor-page, flow-image-editor, flow-edit-image-prompt-box",
    );
    const sbPage = document.querySelector("flow-scene-builder");
    if (edPage || sbPage) {
      viewKind = sbPage ? "scene_builder" : "editor_page";
    }
  }

  if (!viewKind && router && pid && candidateIds.length > 0) {
    for (const candId of candidateIds) {
      await navigateSpa(router, ["/project", pid, "edit", candId]);
      for (let i = 0; i < 60; i += 1) {
        const onRoute = (location.pathname || "").includes("/edit/");
        const edPage = document.querySelector(
          "flow-editor-page, flow-image-editor, flow-edit-image-prompt-box",
        );
        const sbPage = document.querySelector("flow-scene-builder");
        if (onRoute && (edPage || sbPage)) {
          viewKind = sbPage ? "scene_builder" : "editor_page";
          break;
        }
        await delay(100);
      }
      if (viewKind) break;
    }
  }

  if (viewKind) {
    for (let i = 0; i < 25; i += 1) {
      if (
        findVisibleTextbox() ||
        readEditBlockReason() !== null ||
        (viewKind === "scene_builder" &&
          document.querySelector("flow-scene-timeline, flow-edit-video-prompt-box"))
      ) {
        break;
      }
      await delay(100);
    }
    if (
      viewKind === "scene_builder" &&
      readEditBlockReason() === null &&
      (Boolean(
        document.querySelector("flow-scene-timeline, flow-scene-builder .clip"),
      ) ||
        Boolean(findEditVideoPromptBox()) ||
        !findVisibleTextbox())
    ) {
      const clipSelected = await selectSceneTimelineClip(idStr, primaryMediaId);
      if (!clipSelected) {
        clearStore();
        return {
          opened: false,
          blocked: true,
          error: "scene_clip_not_selected",
          alert: `Could not select clip '${idStr}' in scene builder`,
          detail: `Could not select clip '${idStr}' in scene builder`,
          method: "spa_router",
          view: "scene_builder",
          clip_id: idStr,
        };
      }
    }
    for (let i = 0; i < 15; i += 1) {
      if (findVisibleTextbox() || readEditBlockReason() !== null) break;
      await delay(100);
    }
    const alertText = readEditBlockReason();
    const hasTextbox = Boolean(findVisibleTextbox());
    clearStore();
    if (alertText) {
      return {
        opened: true,
        blocked: true,
        error: "editor_blocked",
        alert: alertText,
        detail: alertText,
        method: "spa_router",
        view: viewKind,
        clip_id: idStr,
      };
    }
    return {
      opened: hasTextbox,
      blocked: false,
      method: "spa_router",
      view: viewKind,
      has_textbox: hasTextbox,
    };
  }

  function mentionsAsset(el: Element): boolean {
    if (!el || isExcludedComposerNode(el)) return false;
    if (mediaUrl) {
      const media = el.querySelectorAll("img[src], video[src], source[src]");
      for (const m of media) {
        const src = m.getAttribute("src") || "";
        if (
          src &&
          (src === mediaUrl || mediaUrl.includes(src) || src.includes(mediaUrl))
        ) {
          return true;
        }
      }
    }
    const ng = (el as NgContextCarrier).__ngContext__;
    if (Array.isArray(ng)) {
      for (let i = 0; i < ng.length; i++) {
        const item = ng[i];
        if (
          item &&
          typeof item === "object" &&
          String(readOwn(item, "id") || readOwn(item, "workflowId") || "") ===
            idStr
        ) {
          return true;
        }
      }
    }
    return false;
  }

  const tiles = Array.from(
    document.querySelectorAll(
      'flow-grid-tile-container, [data-testid*="tile"], [class*="tile"]',
    ),
  );
  const tile = tiles.find(mentionsAsset) || null;
  if (tile) {
    tile.scrollIntoView({ block: "center" });
    await delay(100);
    const r = tile.getBoundingClientRect();
    tile.dispatchEvent(
      new PointerEvent("pointerenter", {
        bubbles: false,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    );
    tile.dispatchEvent(
      new MouseEvent("mouseenter", {
        bubbles: false,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    );
    await delay(150);

    for (const scope of [tile, document]) {
      const btns = Array.from(
        scope.querySelectorAll('button, a, [role="button"], [role="menuitem"]'),
      );
      const editBtn = btns.find((el): el is HTMLElement => {
        if (!isVisibleEnabled(el) || isExcludedComposerNode(el)) return false;
        const txt = (
          el.getAttribute("aria-label") ||
          elText(el) ||
          el.getAttribute("title") ||
          ""
        ).trim();
        return /\b(?:edit|modify|reframe|inpaint)\b/i.test(txt);
      });
      if (editBtn) {
        editBtn.click();
        for (let i = 0; i < 20; i += 1) {
          if (findVisibleTextbox() || readEditBlockReason() !== null) break;
          await delay(100);
        }
        const alertText = readEditBlockReason();
        const hasTextbox = Boolean(findVisibleTextbox());
        if (alertText) {
          return {
            opened: true,
            blocked: true,
            error: "editor_blocked",
            alert: alertText,
            detail: alertText,
            method: "ui_edit",
          };
        }
        return {
          opened: hasTextbox,
          blocked: false,
          has_textbox: hasTextbox,
          method: "ui_edit",
        };
      }
    }
  }

  if (pid && idStr) {
    return {
      opened: false,
      edit_url: buildProjectUrl(pid, ["edit", idStr]),
      method: "route_fallback_needed",
    };
  }
  return { opened: false, method: "none" };
}
