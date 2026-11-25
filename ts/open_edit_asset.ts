// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Open the Google Flow asset editor via Angular Router or tile controls.

import {
  buildProjectUrl,
  findRouter,
  navigateSpa,
  readOwn,
  resolveLView,
  type NgContextCarrier,
} from "./angular";
import {
  EDIT_PROMPT_BOX_SELECTOR,
  findTextbox,
  NON_COMPOSER_PANELS,
} from "./composer";
import { delay, elText, isVisibleEnabled } from "./dom";
import { sceneContents } from "./scene_tiles";
import { clearStore, runtimeState } from "./state";

/** Returns true when `el` is connected, visible on screen, and outside non-composer panels. */
function isVisibleOutsideNonComposer(el: Element | null | undefined): el is HTMLElement {
  if (!(el instanceof HTMLElement) || !el.isConnected) return false;
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;
  if (el.closest(NON_COMPOSER_PANELS)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  return el.getClientRects().length > 0;
}

/** Reads a blocking `.too-long-overlay` or composer alert message from the active editor view. */
function readComposerAlert(includePageAlerts: boolean): string | null {
  const primaryAlerts = Array.from(
    document.querySelectorAll(
      `.too-long-overlay, flow-edit-video-prompt-box [role="alert"], flow-edit-image-prompt-box [role="alert"]`,
    ),
  );
  for (const el of primaryAlerts) {
    if (!isVisibleOutsideNonComposer(el)) continue;
    const msg = elText(el).replace(/\s+/g, " ").trim();
    if (msg) return msg;
  }
  if (!includePageAlerts) return null;
  const pageAlerts = Array.from(
    document.querySelectorAll(
      'flow-editor-page [role="alert"], flow-scene-builder [role="alert"], flow-alert-dialog [role="dialog"], flow-alert-dialog',
    ),
  );
  for (const el of pageAlerts) {
    if (!isVisibleOutsideNonComposer(el)) continue;
    const msg = elText(el).replace(/\s+/g, " ").trim();
    if (msg) return msg;
  }
  return null;
}

/** Checks whether an Angular context slot matches the target clip identifier. */
function objectMatchesClip(
  item: unknown,
  idStr: string,
  primaryStr: string,
): boolean {
  if (!item || typeof item !== "object" || item instanceof Node) return false;
  const rawType = String(readOwn(item, "type") || "").toUpperCase();
  if (rawType === "SCENE") return false;
  const wf = String(readOwn(item, "workflowId") || "").trim();
  if (idStr && wf === idStr) return true;
  const pmid = String(readOwn(item, "primaryMediaId") || "").trim();
  if (primaryStr && pmid === primaryStr) return true;
  const id = String(readOwn(item, "id") || "").trim();
  return Boolean(idStr && id === idStr);
}

/** Checks whether a DOM node in `flow-scene-builder` represents the target clip. */
function elementMatchesSceneClip(
  el: Element,
  idStr: string,
  primaryStr: string,
  mediaUrl: string | null,
): boolean {
  for (const attr of [
    "data-workflow-id",
    "data-clip-id",
    "data-asset-id",
    "data-id",
    "id",
  ]) {
    const val = (el.getAttribute(attr) || "").trim();
    if (val && (val === idStr || (primaryStr && val === primaryStr))) {
      return true;
    }
  }
  if (mediaUrl) {
    const mediaNodes = [
      ...(el.matches("img[src], video[src], source[src]") ? [el] : []),
      ...Array.from(el.querySelectorAll("img[src], video[src], source[src]")),
    ];
    if (
      mediaNodes.length === 1 &&
      (() => {
        const src = mediaNodes[0].getAttribute("src") || "";
        return Boolean(
          src &&
            (src === mediaUrl ||
              mediaUrl.includes(src) ||
              src.includes(mediaUrl)),
        );
      })()
    ) {
      return true;
    }
  }
  const lv = resolveLView(el) ?? (el as NgContextCarrier).__ngContext__;
  if (Array.isArray(lv)) {
    for (const slot of lv) {
      if (objectMatchesClip(slot, idStr, primaryStr)) return true;
    }
  }
  return false;
}

/** Selects the target clip in `flow-scene-builder` and opens clip edit mode when needed. */
async function selectSceneClip(
  sb: ParentNode,
  idStr: string,
  primaryStr: string,
  mediaUrl: string | null,
  clipIndex: number,
): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    if (
      sb.querySelector(
        'flow-scene-timeline, [class*="clip"], [data-testid*="clip"], video',
      )
    ) {
      break;
    }
    await delay(100);
  }
  const searchRoot = sb.querySelector("flow-scene-timeline") || sb;
  const candidates = Array.from(searchRoot.querySelectorAll("*")).filter(
    (el): el is HTMLElement =>
      isVisibleOutsideNonComposer(el) && !el.closest(EDIT_PROMPT_BOX_SELECTOR),
  );
  const directMatches = candidates.filter((el) =>
    elementMatchesSceneClip(el, idStr, primaryStr, mediaUrl),
  );
  let targetClip: HTMLElement | null =
    directMatches.find(
      (el) => !directMatches.some((other) => other !== el && el.contains(other)),
    ) ??
    directMatches[0] ??
    null;

  if (!targetClip && clipIndex >= 0) {
    const timeline = sb.querySelector("flow-scene-timeline");
    if (timeline) {
      const rawItems = Array.from(
        timeline.querySelectorAll(
          '[data-clip-index], [data-testid*="clip"], [class*="timeline-clip"], [class*="clip-item"], [class*="clip-card"]',
        ),
      ).filter(isVisibleOutsideNonComposer);
      const topItems = rawItems.filter(
        (el) => !rawItems.some((other) => other !== el && other.contains(el)),
      );
      if (clipIndex < topItems.length) {
        targetClip = topItems[clipIndex];
      } else {
        const directChildren = Array.from(timeline.children).filter(
          isVisibleOutsideNonComposer,
        );
        if (clipIndex < directChildren.length) {
          targetClip = directChildren[clipIndex];
        }
      }
    }
  }

  if (!targetClip && !findTextbox(true)) {
    const fallback = sb.querySelector(
      '[class*="clip"], [data-testid*="clip"], video',
    );
    if (isVisibleOutsideNonComposer(fallback)) {
      targetClip = fallback;
    }
  }

  if (targetClip) {
    targetClip.click();
    await delay(250);
  }

  if (readComposerAlert(false)) return;

  if (
    !findTextbox(true) ||
    Boolean(document.querySelector(".is-extend-mode, .extend-composing"))
  ) {
    const editTrigger = Array.from(
      sb.querySelectorAll('button, [role="button"], [role="tab"]'),
    ).find((b): b is HTMLElement => {
      if (!isVisibleEnabled(b) || b.closest(NON_COMPOSER_PANELS)) return false;
      const lbl = (
        b.getAttribute("aria-label") ||
        elText(b) ||
        b.getAttribute("title") ||
        ""
      ).trim();
      if (/done editing|delete|split|download/i.test(lbl)) return false;
      return /^(?:edit(?:\s+(?:clip|video))?)$/i.test(lbl);
    });
    if (editTrigger) {
      editTrigger.click();
      await delay(300);
    }
  }
}

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
  let clipIndex = -1;
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
          if (idx >= 0) clipIndex = idx;
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
      await navigateSpa(router, ["/project", pid, "scene", resolvedSceneId]);
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
      await selectSceneClip(sb, idStr, primaryStr, mediaUrl, clipIndex);
      for (let i = 0; i < 25; i += 1) {
        if (readComposerAlert(false) || findTextbox(true)) break;
        await delay(100);
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
          has_textbox: false,
        };
      }
      return {
        opened: hasTextbox,
        error: hasTextbox ? undefined : "editor_textbox_not_found",
        method: "spa_router",
        view: "scene_builder",
        scene_id: resolvedSceneId,
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
        await navigateSpa(router, ["/project", pid, "edit", candId]);
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
      if (
        !readComposerAlert(false) &&
        viewKind === "scene_builder" &&
        !findTextbox(true)
      ) {
        const sb = document.querySelector("flow-scene-builder") || document;
        await selectSceneClip(sb, idStr, primaryStr, mediaUrl, clipIndex);
        for (let i = 0; i < 20; i += 1) {
          if (readComposerAlert(false) || findTextbox(true)) break;
          await delay(100);
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
          has_textbox: false,
        };
      }
      if (hasTextbox) {
        clearStore();
        return {
          opened: true,
          method: "spa_router",
          view: viewKind,
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
        const hasTextbox = Boolean(findTextbox(true));
        const alert = readComposerAlert(!hasTextbox);
        if (alert) {
          clearStore();
          return {
            opened: false,
            error: "edit_alert",
            alert,
            method: "ui_edit",
            has_textbox: false,
          };
        }
        if (hasTextbox) {
          clearStore();
          return { opened: true, method: "ui_edit", has_textbox: true };
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
