// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Open the Google Flow asset editor via Angular Router or tile controls.

import {
  buildProjectUrl,
  findRouter,
  navigateSpa,
  readOwn,
  resolveLView,
  withLViewMapCapture,
  type NgContextCarrier,
} from "./angular";
import {
  findTextbox,
  NON_COMPOSER_PANELS,
  readComposerAlert,
} from "./composer";
import { delay, elText, isVisibleEnabled } from "./dom";
import {
  collectSceneClipElements,
  ensureSceneBuilderLViewMap,
  readComponentInput,
  sceneContents,
  selectSceneClip,
  verifySelectedSceneClipInBuilder,
} from "./scene_tiles";
import { clearStore, runtimeState } from "./state";

/** Navigates to `/edit/<id>` or `/scene/<scene_id>` and confirms edit composer readiness. */
export async function openEditAsset(
  assetId: string,
  mediaUrl: string | null,
  primaryMediaId: string | null,
  sceneId: string | null = null,
): Promise<unknown> {
  const idStr = String(assetId || "").trim();
  const primaryStr = String(primaryMediaId || "").trim();
  const candidateIds = Array.from(new Set([idStr, primaryStr].filter(Boolean)));

  let resolvedSceneId = sceneId ? String(sceneId).trim() || null : null;
  const tileMap = runtimeState.store?.getTileMap?.();
  if (tileMap instanceof Map && idStr) {
    const directTile = tileMap.get(idStr);
    if (directTile) {
      const rawType = String(directTile.type || "").toUpperCase();
      if (rawType === "SCENE") {
        const clipIds = sceneContents(directTile)
          .clips.map((c) => String(c?.workflowId || "").trim())
          .filter(Boolean);
        const hint =
          clipIds.length > 0
            ? ` Available clip IDs: ${clipIds.slice(0, 6).join(", ")}.`
            : "";
        return {
          opened: false,
          error: "unsupported_asset_kind",
          kind: "scene",
          alert: `Cannot edit scene container '${idStr}' directly. Pass one of its video clip IDs to flow_edit.${hint}`,
          has_textbox: false,
        };
      }
      if (rawType === "CHARACTER") {
        return {
          opened: false,
          error: "unsupported_asset_kind",
          kind: "character",
          alert: `Cannot edit character '${idStr}' with flow_edit. Use flow_character_edit instead.`,
          has_textbox: false,
        };
      }
      if (
        rawType === "AUDIO" ||
        rawType === "MUSIC" ||
        rawType === "VOICE" ||
        rawType === "COLLECTION"
      ) {
        return {
          opened: false,
          error: "unsupported_asset_kind",
          kind: rawType.toLowerCase(),
          alert: `Cannot edit ${rawType.toLowerCase()} asset '${idStr}' with flow_edit.`,
          has_textbox: false,
        };
      }
    } else {
      for (const st of tileMap.values()) {
        if (String(st?.type || "").toUpperCase() !== "SCENE") continue;
        const stId = st.id != null ? String(st.id).trim() : "";
        if (resolvedSceneId && stId && stId !== resolvedSceneId) continue;
        const { clips, history } = sceneContents(st);
        const idx = clips.findIndex(
          (c) => String(c?.workflowId || "").trim() === idStr,
        );
        if (idx >= 0 || history.has(idStr)) {
          if (!resolvedSceneId && stId) resolvedSceneId = stId;
          break;
        }
      }
    }
  }

  const pm = /\/project\/([^/?#]+)/.exec(location.pathname || "");
  const pid = pm ? pm[1] : runtimeState.store?.projectId || null;
  const router = pid ? findRouter() : null;

  if (resolvedSceneId && pid) {
    const targetPath = `/scene/${resolvedSceneId}`;
    let hasSceneBuilder =
      (location.pathname || "").includes(targetPath) &&
      Boolean(document.querySelector("flow-scene-builder"));
    if (!hasSceneBuilder && (location.pathname || "").includes(targetPath)) {
      for (let i = 0; i < 30; i += 1) {
        if (document.querySelector("flow-scene-builder")) {
          hasSceneBuilder = true;
          break;
        }
        await delay(100);
      }
    }
    if (!hasSceneBuilder && router) {
      await withLViewMapCapture(async () => {
        await navigateSpa(router, ["/project", pid, "scene", resolvedSceneId]);
      });
      for (let i = 0; i < 60; i += 1) {
        if (
          (location.pathname || "").includes(targetPath) &&
          document.querySelector("flow-scene-builder")
        ) {
          hasSceneBuilder = true;
          break;
        }
        await delay(100);
      }
    }
    if (hasSceneBuilder) {
      const sb = document.querySelector("flow-scene-builder") || document;
      const selection = await selectSceneClip(sb, idStr, primaryStr);
      if (!selection.ok) {
        clearStore();
        return {
          opened: false,
          error: selection.error,
          selection_error: selection.detail,
          method: "spa_router",
          view: "scene_builder",
          scene_id: resolvedSceneId,
          has_textbox: false,
        };
      }
      for (let i = 0; i < 25; i += 1) {
        if (readComposerAlert(false) || findTextbox(true)) break;
        await delay(100);
      }
      const postCheck = verifySelectedSceneClipInBuilder(sb, idStr, primaryStr);
      if (!postCheck.ok) {
        clearStore();
        return {
          opened: false,
          error: postCheck.error,
          selection_error: postCheck.detail,
          method: "spa_router",
          view: "scene_builder",
          scene_id: resolvedSceneId,
          has_textbox: false,
        };
      }
      clearStore();
      const hasTextbox = Boolean(findTextbox(true));
      const alert = readComposerAlert(!hasTextbox);
      if (alert) {
        return {
          opened: false,
          error: "edit_alert",
          alert,
          method: "spa_router",
          view: "scene_builder",
          scene_id: resolvedSceneId,
          selected_clip_id: postCheck.selectedClipId,
          has_textbox: false,
        };
      }
      return {
        opened: hasTextbox,
        error: hasTextbox ? undefined : "editor_textbox_not_found",
        method: "spa_router",
        view: "scene_builder",
        scene_id: resolvedSceneId,
        selected_clip_id: postCheck.selectedClipId,
        has_textbox: hasTextbox,
      };
    }
    if (!(location.pathname || "").includes(targetPath)) {
      return {
        opened: false,
        edit_url: buildProjectUrl(pid, ["scene", resolvedSceneId]),
        scene_id: resolvedSceneId,
        method: "route_fallback_needed",
      };
    }
    return {
      opened: false,
      error: "scene_builder_not_found",
      scene_id: resolvedSceneId,
      has_textbox: false,
      method: "none",
    };
  }

  const alreadyOnEditRoute = (location.pathname || "").includes("/edit/");
  if (pid && candidateIds.length > 0 && (router || alreadyOnEditRoute)) {
    let lastEmptyView: string | null = null;
    const idsToTry = router ? candidateIds : [idStr || candidateIds[0]];
    for (const candId of idsToTry) {
      if (
        router &&
        !(
          (location.pathname || "").includes(`/edit/${candId}`) &&
          (document.querySelector("flow-editor-page") ||
            document.querySelector("flow-scene-builder"))
        )
      ) {
        await withLViewMapCapture(async () => {
          await navigateSpa(router, ["/project", pid, "edit", candId]);
        });
      }
      let viewKind: string | null = null;
      const waitTicks = router ? 60 : 30;
      for (let i = 0; i < waitTicks; i += 1) {
        const onRoute = (location.pathname || "").includes("/edit/");
        const edPage = document.querySelector("flow-editor-page");
        const sbPage = document.querySelector("flow-scene-builder");
        if (onRoute && (edPage || sbPage)) {
          viewKind = sbPage ? "scene_builder" : "editor_page";
          break;
        }
        await delay(100);
      }
      if (!viewKind) continue;

      for (let i = 0; i < 25; i += 1) {
        if (readComposerAlert(false) || findTextbox(true)) break;
        await delay(100);
      }
      let selectedClipId: string | undefined;
      if (viewKind === "scene_builder") {
        const sbEl = document.querySelector("flow-scene-builder");
        const sbNode: ParentNode = sbEl || document;
        await ensureSceneBuilderLViewMap(sbNode);
        let singleVideoMatch = false;
        if (sbEl) {
          const rawCtx = (sbEl as NgContextCarrier).__ngContext__;
          const sbLv =
            resolveLView(sbEl) ?? (Array.isArray(rawCtx) ? rawCtx : null);
          const sbSlots: unknown[] = Array.isArray(sbLv) ? sbLv : [sbEl];
          for (const slot of sbSlots) {
            if (!slot || typeof slot !== "object" || slot instanceof Node) {
              continue;
            }
            const wfInput = readComponentInput(slot, "workflowId");
            if (
              wfInput.found &&
              typeof wfInput.value === "string" &&
              wfInput.value.trim()
            ) {
              const wfVal = wfInput.value.trim();
              if (wfVal !== candId && wfVal !== idStr && wfVal !== primaryStr) {
                clearStore();
                return {
                  opened: false,
                  error: "scene_clip_selection_mismatch",
                  selection_error: `Video editor targets workflow '${wfVal}' instead of '${idStr || candId}'.`,
                  method: "spa_router",
                  view: viewKind,
                  has_textbox: false,
                };
              }
              singleVideoMatch = true;
              selectedClipId = idStr || candId;
              break;
            }
          }
        }
        const hasTimelineOrClips =
          Boolean(sbNode.querySelector("flow-scene-timeline")) ||
          collectSceneClipElements(sbNode).length > 0;
        if (!singleVideoMatch && (hasTimelineOrClips || !findTextbox(true))) {
          const selection = await selectSceneClip(
            sbNode,
            idStr || candId,
            primaryStr,
          );
          if (!selection.ok) {
            clearStore();
            return {
              opened: false,
              error: selection.error,
              selection_error: selection.detail,
              method: "spa_router",
              view: viewKind,
              has_textbox: false,
            };
          }
          selectedClipId = selection.selectedClipId;
          for (let i = 0; i < 20; i += 1) {
            if (readComposerAlert(false) || findTextbox(true)) break;
            await delay(100);
          }
          const postCheck = verifySelectedSceneClipInBuilder(
            sbNode,
            idStr || candId,
            primaryStr,
          );
          if (!postCheck.ok) {
            clearStore();
            return {
              opened: false,
              error: postCheck.error,
              selection_error: postCheck.detail,
              method: "spa_router",
              view: viewKind,
              has_textbox: false,
            };
          }
          selectedClipId = postCheck.selectedClipId;
        }
      }

      const hasTextbox = Boolean(findTextbox(true));
      const alert = readComposerAlert(!hasTextbox);
      if (alert) {
        clearStore();
        return {
          opened: false,
          error: "edit_alert",
          alert,
          method: "spa_router",
          view: viewKind,
          selected_clip_id: selectedClipId,
          has_textbox: false,
        };
      }
      if (hasTextbox) {
        clearStore();
        return {
          opened: true,
          method: "spa_router",
          view: viewKind,
          selected_clip_id: selectedClipId,
          has_textbox: true,
        };
      }
      lastEmptyView = viewKind;
    }
    if (lastEmptyView) {
      clearStore();
      return {
        opened: false,
        error: "editor_textbox_not_found",
        method: "spa_router",
        view: lastEmptyView,
        has_textbox: false,
      };
    }
  }

  function mentionsAsset(el: Element): boolean {
    if (!el) return false;
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
        if (!isVisibleEnabled(el) || el.closest(NON_COMPOSER_PANELS)) {
          return false;
        }
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
        for (let i = 0; i < 30; i += 1) {
          if (readComposerAlert(false) || findTextbox(true)) break;
          await delay(100);
        }
        let uiSelectedClipId: string | undefined;
        const uiSb = document.querySelector("flow-scene-builder");
        if (
          uiSb &&
          (Boolean(uiSb.querySelector("flow-scene-timeline")) ||
            collectSceneClipElements(uiSb).length > 0)
        ) {
          const uiSelection = await selectSceneClip(uiSb, idStr, primaryStr);
          if (!uiSelection.ok) {
            clearStore();
            return {
              opened: false,
              error: uiSelection.error,
              selection_error: uiSelection.detail,
              method: "ui_edit",
              view: "scene_builder",
              has_textbox: false,
            };
          }
          const uiPostCheck = verifySelectedSceneClipInBuilder(
            uiSb,
            idStr,
            primaryStr,
          );
          if (!uiPostCheck.ok) {
            clearStore();
            return {
              opened: false,
              error: uiPostCheck.error,
              selection_error: uiPostCheck.detail,
              method: "ui_edit",
              view: "scene_builder",
              has_textbox: false,
            };
          }
          uiSelectedClipId = uiPostCheck.selectedClipId;
        }
        const hasTextbox = Boolean(findTextbox(true));
        const alert = readComposerAlert(!hasTextbox);
        if (alert) {
          clearStore();
          return {
            opened: false,
            error: "edit_alert",
            alert,
            method: "ui_edit",
            selected_clip_id: uiSelectedClipId,
            has_textbox: false,
          };
        }
        if (hasTextbox) {
          clearStore();
          return {
            opened: true,
            method: "ui_edit",
            selected_clip_id: uiSelectedClipId,
            has_textbox: true,
          };
        }
      }
    }
  }

  if (pid && idStr && !alreadyOnEditRoute) {
    return {
      opened: false,
      edit_url: buildProjectUrl(pid, ["edit", idStr]),
      method: "route_fallback_needed",
    };
  }
  return { opened: false, has_textbox: false, method: "none" };
}
