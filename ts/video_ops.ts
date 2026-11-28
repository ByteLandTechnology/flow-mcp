// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Trim Flow videos and drive the scene builder extend workflow.

import {
  buildProjectUrl,
  createScene,
  findRouter,
  isNgLViewMap,
  navigateSpa,
  readAngularTooltip,
  readOwn,
  withLViewMapCapture,
} from "./angular";
import { findComposerWarning } from "./composer";
import { delay, elText, hoverProbe, isDisabledProp, isTrashedTile, isVisibleEnabled, legacyMedia, legacyTile, videoTrimBounds } from "./dom";
import { activeProjectStoreFormat } from "./frontend_builds";
import { writePromptBox } from "./prompt_writer";
import {
  findVideoTileByIdOrWorkflow,
  readSceneClipBounds,
  resolveSceneBuilderController,
  sceneContents,
  splitSceneClipId,
} from "./scene_tiles";
import { clearStore, runtimeState } from "./state";
import type { FlowTile, SceneClipItem, VideoOpRequest } from "./types";

/** Checks whether an observed start trim bound matches the requested start time. */
function startBoundMatches(
  actual: number | null,
  expected: number | null,
): boolean {
  if (expected === null || Math.abs(expected) <= 0.01) {
    return actual === null || Math.abs(actual) <= 0.01;
  }
  return typeof actual === "number" && Math.abs(actual - expected) <= 0.01;
}

/** Checks whether an observed end trim bound matches the requested end time. */
function endBoundMatches(
  actual: number | null,
  expected: number | null,
  duration: number | null,
): boolean {
  if (expected === null) {
    if (actual === null) return true;
    return (
      typeof actual === "number" &&
      typeof duration === "number" &&
      duration > 0 &&
      Math.abs(actual - duration) <= 0.01
    );
  }
  return typeof actual === "number" && Math.abs(actual - expected) <= 0.01;
}

/** Finds the last active clip in `scene` whose `workflowId` equals `workflowId`. */
function findLastSceneClip(
  scene: FlowTile | undefined,
  workflowId: string,
): SceneClipItem | undefined {
  if (!scene || isTrashedTile(scene) || String(scene.type ?? "").toUpperCase() !== "SCENE") {
    return undefined;
  }
  const { clips } = sceneContents(scene);
  for (let i = clips.length - 1; i >= 0; i -= 1) {
    if (String(clips[i]?.workflowId ?? "") === workflowId) {
      return clips[i];
    }
  }
  return undefined;
}

/** Trims video clip timestamps or orchestrates scene-builder video extension. */
export async function videoOp(req: VideoOpRequest): Promise<unknown> {
  const helper = runtimeState.store;
  const getMap = (): Map<string, FlowTile> | null | undefined => helper?.getTileMap?.();
  const tileMap = getMap();
  const action = String(req?.action || "").toLowerCase();

  if (action === "trim") {
    if (!activeProjectStoreFormat()) {
      clearStore();
      return { ok: false, error: "unsupported_front_end" };
    }
    if (!helper || !helper.isCurrent()) {
      if (helper) clearStore();
      return { ok: false, error: "store_not_bound" };
    }
    if (!helper.isReady()) {
      return { ok: false, error: "store_loading" };
    }
    if (!(tileMap instanceof Map) || !helper.mutate) {
      return { ok: false, error: "store_not_bound" };
    }
    const id = String(req?.asset_id || "").trim();
    const startSec =
      typeof req.start_seconds === "number" ? req.start_seconds : null;
    const endSec = typeof req.end_seconds === "number" ? req.end_seconds : null;
    const clipRef = splitSceneClipId(id);
    if (clipRef) {
      const rawScene = tileMap.get(clipRef.sceneId);
      const clip = findLastSceneClip(rawScene, clipRef.workflowId);
      if (!rawScene || !clip) {
        return { ok: false, error: `video_asset_not_found:${id}` };
      }
      const mediaId = String(clip.primaryMediaId ?? "").trim();
      if (!mediaId) {
        return { ok: false, error: `video_media_id_missing:${id}` };
      }
      const initialBounds = readSceneClipBounds(clip);
      const hist = sceneContents(rawScene).history.get(clipRef.workflowId);
      const rawHistMedia = Array.isArray(hist)
        ? hist.find((m) => String(m?.id ?? "") === mediaId) ?? hist[0]
        : undefined;
      const histMedia = legacyMedia(rawHistMedia);
      const topTile = legacyTile(findVideoTileByIdOrWorkflow(tileMap, clipRef.workflowId));
      const duration =
        initialBounds.duration ??
        (typeof histMedia?.durationSeconds === "number"
          ? histMedia.durationSeconds
          : typeof histMedia?.duration === "number"
            ? histMedia.duration
            : typeof histMedia?.Lf === "number"
              ? histMedia.Lf
              : typeof topTile?.durationSeconds === "number"
                ? topTile.durationSeconds
                : typeof topTile?.duration === "number"
                  ? topTile.duration
                  : typeof topTile?.Fb?.Lf === "number"
                    ? topTile.Fb.Lf
                    : null);
      const resolvedEnd = endSec ?? duration;
      const change: Record<string, unknown> = {
        type: "set_scene_clip_primary_media",
        workflowId: clipRef.workflowId,
        primaryMediaId: mediaId,
        Ji: startSec ?? 0,
      };
      if (typeof resolvedEnd === "number") {
        change.Ci = resolvedEnd;
      }
      await helper.mutate({
        type: "single_tile",
        Xc: clipRef.sceneId,
        Uc: clipRef.sceneId,
        Ve: change,
      });
      const matchesSceneClip = (
        cand: { start: number | null; end: number | null; duration: number | null },
      ): boolean =>
        startBoundMatches(cand.start, startSec) &&
        endBoundMatches(cand.end, endSec, cand.duration ?? duration);
      await delay(300);
      for (let i = 0; i < 30; i++) {
        const currentClip = findLastSceneClip(
          getMap()?.get(clipRef.sceneId),
          clipRef.workflowId,
        );
        if (currentClip) {
          const bounds = readSceneClipBounds(currentClip);
          if (matchesSceneClip(bounds)) {
            await delay(200);
            const settledClip = findLastSceneClip(
              getMap()?.get(clipRef.sceneId),
              clipRef.workflowId,
            );
            const settled = readSceneClipBounds(settledClip);
            if (settledClip && matchesSceneClip(settled)) {
              return {
                ok: true,
                confirmed: true,
                asset_id: id,
                media_id: mediaId,
                start_seconds: settled.start,
                end_seconds: settled.end,
              };
            }
          }
        }
        await delay(200);
      }
      return { ok: false, error: "trim_not_confirmed" };
    }

    const rawTile = tileMap.get(id);
    if (!rawTile) return { ok: false, error: `video_asset_not_found:${id}` };
    const tile = legacyTile(rawTile);
    const mediaId = String(
      tile?.primaryMediaId ||
        tile?.Fb?.id ||
        tile?.Fb?.mediaId ||
        tile?.fb?.mediaId ||
        tile?.mediaId ||
        id,
    );
    await helper.mutate({
      type: "single_tile",
      Xc: String(tile?.id ?? id),
      Uc: String(tile?.id ?? id),
      Ve: {
        type: "set_video_trim_seconds",
        mediaId,
        Cg: startSec,
        Rf: endSec,
        Gg: startSec,
        Wf: endSec,
      },
    });
    const duration =
      typeof tile?.durationSeconds === "number"
        ? tile.durationSeconds
        : typeof tile?.duration === "number"
          ? tile.duration
          : typeof tile?.Fb?.durationSeconds === "number"
            ? tile.Fb.durationSeconds
            : typeof tile?.Fb?.duration === "number"
              ? tile.Fb.duration
              : typeof tile?.Fb?.Lf === "number"
                ? tile.Fb.Lf
                : typeof tile?.Lf === "number"
                  ? tile.Lf
                  : null;
    const matchesStore = (
      cand: { start: number | null; end: number | null },
    ): boolean =>
      startBoundMatches(cand.start, startSec) &&
      endBoundMatches(cand.end, endSec, duration);
    await delay(300);
    for (let i = 0; i < 30; i++) {
      const current = getMap()?.get(id);
      if (current) {
        const bounds = videoTrimBounds(current);
        if (matchesStore(bounds)) {
          await delay(200);
          const settled = videoTrimBounds(getMap()?.get(id));
          if (matchesStore(settled)) {
            return {
              ok: true,
              confirmed: true,
              asset_id: id,
              media_id: mediaId,
              start_seconds: settled.start,
              end_seconds: settled.end,
            };
          }
        }
      }
      await delay(200);
    }
    return { ok: false, error: "trim_not_confirmed" };
  }

  if (action === "prepare_extend") {
    const rawId = String(req?.asset_id || "").trim();
    const clipRef = splitSceneClipId(rawId);
    const impliedSceneId = clipRef ? clipRef.sceneId : null;
    const rawTargetId = clipRef ? clipRef.workflowId : rawId;
    let sceneId = req?.scene_id ? String(req.scene_id).trim() : impliedSceneId;
    const matchedTile = findVideoTileByIdOrWorkflow(tileMap, rawTargetId);
    const targetWfId = matchedTile
      ? String(matchedTile.workflowId || matchedTile.id || rawTargetId)
      : rawTargetId;

    // When a scene is already open and no different scene_id is requested,
    // prepare_extend inspects the open scene and fails with scene_clip_not_found
    // if targetWfId is absent rather than reusing that scene for an unrelated video.
    const activeScene = /\/scene\/([^/?#]+)/.exec(location.pathname)?.[1] ?? null;
    if (!activeScene || (sceneId && activeScene !== sceneId)) {
      if (!activeProjectStoreFormat()) {
        clearStore();
        return { ok: false, error: "unsupported_front_end" };
      }
      if (!helper || !helper.isCurrent()) {
        if (helper) clearStore();
        return { ok: false, error: "store_not_bound" };
      }
      if (!helper.isReady()) {
        return { ok: false, error: "store_loading" };
      }
      if (!(tileMap instanceof Map) || !helper.mutate) {
        return { ok: false, error: "store_not_bound" };
      }
      if (!sceneId) {
        if (!rawTargetId) {
          return { ok: false, error: "video_asset_required" };
        }
        if (!matchedTile) {
          return { ok: false, error: `video_asset_not_found:${rawTargetId}` };
        }
        const created = await createScene(helper, getMap, [targetWfId]);
        if (!created?.ok || !created.id) {
          return { ok: false, error: created.error ?? "failed_to_create_scene_for_extend" };
        }
        sceneId = created.id;
      }
      const pm = /\/project\/([^/?#]+)/.exec(location.pathname || "");
      const pid = pm ? pm[1] : helper?.projectId || null;
      const router = pid ? findRouter() : null;
      let navigatedSpa = false;
      if (router && pid) {
        await navigateSpa(router, ["/project", pid, "scene", sceneId]);
        for (let i = 0; i < 60; i++) {
          const onScene = (location.pathname || "").includes(
            `/scene/${sceneId}`,
          );
          const hasSb = Boolean(document.querySelector("flow-scene-builder"));
          if (onScene && hasSb) {
            navigatedSpa = true;
            break;
          }
          await delay(100);
        }
      }
      if (navigatedSpa) {
        clearStore();
        await delay(250);
      } else if (pid) {
        return {
          ok: false,
          need_navigate: buildProjectUrl(pid, ["scene", sceneId]),
          scene_id: sceneId,
          workflow_id: targetWfId || undefined,
        };
      } else {
        return {
          ok: false,
          error: "not_in_project_route",
          scene_id: sceneId,
        };
      }
    } else {
      sceneId ||= activeScene;
    }

    let capturedMap = false;
    let resolved = resolveSceneBuilderController();
    for (let i = 0; i < 80 && !resolved; i++) {
      const host = document.querySelector("flow-scene-builder");
      if (host && !(runtimeState.ngLViewMap instanceof Map) && !capturedMap) {
        capturedMap = true;
        await withLViewMapCapture(
          async () => {
            const targets = Array.from(
              document.querySelectorAll(
                "flow-scene-builder, flow-scene-timeline, button[aria-label], [mattooltip]",
              ),
            );
            await hoverProbe(targets.slice(0, 8), 25);
          },
          (map) => {
            if (!(runtimeState.ngLViewMap instanceof Map) && isNgLViewMap(map)) {
              runtimeState.ngLViewMap = map;
            }
          },
        );
      }
      resolved = resolveSceneBuilderController();
      if (resolved) break;
      await delay(100);
    }
    if (!resolved) {
      return { ok: false, error: "scene_builder_controller_not_found" };
    }

    let playerReady = false;
    for (let i = 0; i < 120; i++) {
      resolved = resolveSceneBuilderController() ?? resolved;
      const player = readOwn(resolved.controller, resolved.format.player);
      const readyFn = readOwn(player, resolved.format.playerReady);
      if (typeof readyFn === "function" && Boolean(readyFn.call(player))) {
        playerReady = true;
        break;
      }
      await delay(100);
    }
    if (!playerReady) {
      return { ok: false, error: "scene_player_not_ready" };
    }

    for (let i = 0; i < 40; i++) {
      if (document.querySelector("flow-scene-timeline")) break;
      await delay(100);
    }

    resolved = resolveSceneBuilderController() ?? resolved;
    const { controller, format: sbFormat } = resolved;
    const clipsFn = readOwn(controller, sbFormat.clips);
    const rawClips: unknown = typeof clipsFn === "function" ? clipsFn.call(controller) : null;
    const clips = Array.isArray(rawClips) ? rawClips : [];
    const targetClip = targetWfId
      ? clips.find((clip) => {
          const wf = String(readOwn(clip, "workflowId") ?? "");
          return (
            wf === targetWfId ||
            (rawTargetId !== "" &&
              (wf === rawTargetId ||
                String(readOwn(clip, "id") ?? "") === rawTargetId ||
                String(readOwn(clip, "primaryMediaId") ?? "") === rawTargetId))
          );
        })
      : clips[clips.length - 1];
    if (!targetClip) {
      return {
        ok: false,
        error: targetWfId ? `scene_clip_not_found:${targetWfId}` : "scene_has_no_clips",
      };
    }
    const selectedWfId = String(readOwn(targetClip, "workflowId") ?? targetWfId);
    const clipIndex = clips.indexOf(targetClip);
    const activeExtendFn = readOwn(controller, sbFormat.activeExtendClip);
    const exitExtendFn = readOwn(controller, sbFormat.exitExtend);
    const modelsQuery = readOwn(controller, sbFormat.modelsQuery);
    const isModelsPending = readOwn(modelsQuery, "isPending");
    if (
      typeof activeExtendFn !== "function" ||
      typeof exitExtendFn !== "function" ||
      typeof isModelsPending !== "function"
    ) {
      return { ok: false, error: "scene_builder_signals_missing" };
    }
    const activeExtendWf: unknown = activeExtendFn.call(controller);
    if (
      typeof activeExtendWf === "string" &&
      activeExtendWf &&
      activeExtendWf !== selectedWfId
    ) {
      exitExtendFn.call(controller);
    }

    const player = readOwn(controller, sbFormat.player);
    const selectedSignal = readOwn(player, sbFormat.selectedClip);
    const setSelected = readOwn(selectedSignal, "set");
    if (typeof setSelected !== "function") {
      return { ok: false, error: "scene_selected_clip_signal_missing" };
    }
    setSelected.call(selectedSignal, selectedWfId);
    await delay(50);

    let selectedClipEl: Element | null = null;
    for (let i = 0; i < 25; i++) {
      const signalMatches =
        typeof selectedSignal !== "function" ||
        String(selectedSignal.call(player) ?? "") === selectedWfId;
      const timelineClips = Array.from(
        document.querySelectorAll(
          "flow-scene-timeline .clip:not(.extend-composing):not(.pending-placeholder)",
        ),
      );
      const candidateEl =
        timelineClips.length === clips.length && clipIndex >= 0
          ? timelineClips[clipIndex]
          : document.querySelector("flow-scene-timeline .clip.selected");
      if (signalMatches && candidateEl?.classList.contains("selected")) {
        selectedClipEl = candidateEl;
        break;
      }
      setSelected.call(selectedSignal, selectedWfId);
      await delay(80);
    }
    if (!selectedClipEl) {
      return { ok: false, error: `scene_clip_selection_not_confirmed:${selectedWfId}` };
    }

    const readDisabledReason = (): string | null => {
      const fn = readOwn(controller, sbFormat.extendDisabledReason);
      const value: unknown = typeof fn === "function" ? fn.call(controller) : null;
      return typeof value === "string" && value ? value : null;
    };
    let disabledReason = readDisabledReason();
    for (let i = 0; i < 15 && disabledReason === "no-extension-model"; i++) {
      if (!Boolean(isModelsPending.call(modelsQuery))) break;
      await delay(100);
      disabledReason = readDisabledReason();
    }
    if (disabledReason) {
      return { ok: false, error: `extend_option_disabled:${disabledReason}` };
    }

    const inExtendMode = (): boolean =>
      Boolean(
        document.querySelector(
          ".is-extend-mode, .extend-composing, .extend-mode-chip",
        ),
      );

    const findExtendBtn = (): HTMLElement | null =>
      Array.from(
        document.querySelectorAll('button, [role="button"], [role="tab"]'),
      ).find((el): el is HTMLElement => {
        if (!isVisibleEnabled(el)) return false;
        const aria = (el.getAttribute("aria-label") || "").trim();
        const raw = elText(el);
        if (/redo extend|done editing/i.test(`${aria} ${raw}`)) return false;
        const tail =
          raw
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
            .pop() || "";
        return (
          /^(?:extend|prompt to extend)$/i.test(aria) ||
          /^(?:extend|prompt to extend)$/i.test(raw) ||
          /^(?:extend|prompt to extend)$/i.test(tail)
        );
      }) || null;

    if (!inExtendMode()) {
      const extendBtn = findExtendBtn();
      if (extendBtn) {
        extendBtn.click();
        await delay(300);
      }
      if (!inExtendMode()) {
        const addClipBtn =
          selectedClipEl.querySelector(
            'button[aria-label="Add clip"], .add-clip-button',
          ) ||
          document.querySelector(
            'flow-scene-timeline .clip.selected button[aria-label="Add clip"], flow-scene-timeline .clip.selected .add-clip-button, flow-scene-timeline button[aria-label="Add clip"], flow-scene-timeline .add-clip-button, flow-scene-builder button[aria-label="Add clip"], button[aria-label="Add clip"]',
          );
        if (isVisibleEnabled(addClipBtn)) {
          if (!(runtimeState.ngLViewMap instanceof Map)) {
            await withLViewMapCapture(async () => {
              addClipBtn.click();
              await delay(250);
            });
          } else {
            addClipBtn.click();
            await delay(250);
          }
          // Angular renders the menu in an overlay outside the menu host.
          const menuScope = document.querySelector(".extend-menu-panel") ?? document;
          const optCandidates = Array.from(
            menuScope.querySelectorAll(
              '.extend-clip-option button, .extend-clip-option [role="menuitem"], flow-menu-item.extend-clip-option, button, [role="menuitem"], [role="button"]',
            ),
          );
          const extendOpt = optCandidates.find((el) => {
            if (el.getClientRects().length === 0) return false;
            const aria = (el.getAttribute("aria-label") || "").trim();
            const raw = elText(el);
            if (/redo extend|done editing|add clip/i.test(`${aria} ${raw}`)) {
              return false;
            }
            return (
              /^(?:extend(?:\s+with\b.*)?|prompt to extend)$/i.test(aria) ||
              /^(?:extend(?:\s+with\b.*)?|prompt to extend)$/i.test(raw) ||
              Boolean(el.closest(".extend-clip-option"))
            );
          });
          if (extendOpt) {
            const innerBtn =
              extendOpt.querySelector("button, [role='menuitem']") || extendOpt;
            if (!isVisibleEnabled(innerBtn) || !isVisibleEnabled(extendOpt)) {
              const signalReason = readDisabledReason();
              if (signalReason) {
                return { ok: false, error: `extend_option_disabled:${signalReason}` };
              }
              if (!(runtimeState.ngLViewMap instanceof Map)) {
                await withLViewMapCapture(async () => {
                  await hoverProbe([extendOpt, innerBtn], 40);
                });
              }
              const reason =
                readAngularTooltip(extendOpt) ||
                readAngularTooltip(innerBtn) ||
                "unavailable";
              return { ok: false, error: `extend_option_disabled:${reason}` };
            }
            innerBtn.click();
            for (let i = 0; i < 20; i++) {
              if (inExtendMode()) break;
              await delay(100);
            }
          }
        }
      }
    }

    if (!inExtendMode()) return { ok: false, error: "extend_mode_not_ready" };
    const composer = document.querySelector("flow-edit-video-prompt-box") ??
      document.querySelector("flow-scene-builder");
    if (!composer) return { ok: false, error: "extend_composer_not_found" };

    let tb: HTMLElement | null = null;
    for (let i = 0; i < 20; i++) {
      const textboxes = Array.from(
        composer.querySelectorAll(
          '.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"], textarea',
        ),
      ).filter(
        (el): el is HTMLElement =>
          el instanceof HTMLElement &&
          el.getClientRects().length > 0 &&
          !isDisabledProp(el),
      );
      tb =
        textboxes.find((el) => {
          const ctx = (
            el.getAttribute("aria-label") ||
            el.getAttribute("placeholder") ||
            elText(el.parentElement) ||
            ""
          ).toLowerCase();
          return ctx.includes("extend");
        }) ||
        textboxes[0] ||
        null;
      if (tb) break;
      await delay(100);
    }
    if (!tb) return { ok: false, error: "extend_prompt_textbox_not_found" };

    const prompt = String(req?.prompt || "").trim();
    if (!prompt) return { ok: false, error: "extend_prompt_required" };
    const written = await writePromptBox(tb, prompt, {
      seeds: [composer.querySelector("flow-rich-text-editor"), composer],
      strictSync: true,
      trySettingsClick: false,
      hoverScopeSelector: "flow-scene-builder",
    });
    if (!written.ok) return { ok: false, error: "extend_prompt_not_written" };
    if (!inExtendMode()) return { ok: false, error: "extend_mode_changed" };

    let submitBtn: HTMLElement | null = null;
    const exactSelector = 'button[aria-label="Start generation"]';
    const checkExtendWarning = (): {
      ok: false;
      error: string;
      detail: string;
    } | null => {
      const w = findComposerWarning([composer, document], true);
      if (!w) return null;
      const prefix =
        w.kind === "credit"
          ? "extend_credit_quota_exceeded"
          : "extend_high_demand_warning";
      return {
        ok: false,
        error: `${prefix}:${w.detail}`,
        detail: w.detail,
      };
    };
    for (let i = 0; i < 120; i++) {
      const exact = composer.querySelector(exactSelector);
      if (isVisibleEnabled(exact)) {
        submitBtn = exact;
        break;
      }
      const warning = checkExtendWarning();
      if (warning) return warning;
      if (exact && exact.getClientRects().length > 0) {
        await delay(100);
      } else {
        break;
      }
    }
    if (!submitBtn) {
      const warningAfter = checkExtendWarning();
      if (warningAfter) return warningAfter;
      const exactAfter = composer.querySelector(exactSelector);
      if (
        exactAfter &&
        exactAfter.getClientRects().length > 0 &&
        !isVisibleEnabled(exactAfter)
      ) {
        const validatorDetail =
          runtimeState.promptState?.Ff?.N7a?.() ||
          runtimeState.promptState?.lf?.jYa?.() ||
          readAngularTooltip(exactAfter) ||
          "";
        return validatorDetail
          ? {
              ok: false,
              error: `extend_start_generation_disabled:${validatorDetail}`,
              detail: validatorDetail,
            }
          : { ok: false, error: "extend_start_generation_disabled" };
      }
      submitBtn =
        Array.from(composer.querySelectorAll('button, [role="button"]')).find(
          (b): b is HTMLElement => {
            if (b.tagName === "A" || !isVisibleEnabled(b)) return false;
            if (
              b.closest(
                'flow-credit-warning-button, flow-high-demand-warning-button, .cdk-overlay-pane, [role="menu"], [role="listbox"], nav, aside',
              )
            ) {
              return false;
            }
            const lbl = (b.getAttribute("aria-label") || elText(b)).trim();
            if (
              /create tool|create with google flow|new project|done editing scene/i.test(
                lbl,
              )
            ) {
              return false;
            }
            return (
              /\b(?:start generation|extend|generate)\b/i.test(lbl) ||
              (b.tagName === "BUTTON" && /\barrow_forward\b/i.test(lbl))
            );
          },
        ) || null;
    }
    if (!submitBtn) {
      return { ok: false, error: "extend_submit_button_not_found" };
    }
    submitBtn.scrollIntoView({ block: "center", inline: "nearest" });
    await delay(40);
    const r = submitBtn.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) {
      return { ok: false, error: "extend_submit_button_zero_rect" };
    }
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (!submitBtn.contains(document.elementFromPoint(x, y))) {
      return { ok: false, error: "extend_submit_button_obscured" };
    }
    return {
      ok: true,
      submit_point: { x, y },
      scene_id: sceneId,
      workflow_id: selectedWfId,
    };
  }

  if (action === "poll_extend") {
    const busyDom = Boolean(
      document.querySelector(
        "flow-scene-timeline .is-extend-generating, flow-scene-timeline .pending-placeholder, flow-scene-timeline [aria-busy='true']",
      ),
    );
    const scope = document.querySelector("flow-scene-builder") ?? document.body;
    const extendingText = Array.from(
      scope.querySelectorAll(
        '[class*="extend"], [class*="status"], [class*="progress"], [aria-live]',
      ),
    ).some(
      (el) =>
        !el.closest('[contenteditable="true"], textarea, input') &&
        /\bExtending\b|Extending…/i.test(elText(el)),
    );
    return { ok: true, extending: busyDom || extendingText };
  }

  if (action === "done_scene") {
    const findDoneBtn = (): Element | null =>
      document.querySelector('button[aria-label="Done editing scene"]') ||
      Array.from(document.querySelectorAll('button, [role="button"]')).find(
        (el) =>
          isVisibleEnabled(el) &&
          /^done editing scene$/i.test(
            (el.getAttribute("aria-label") || elText(el)).trim(),
          ),
      ) ||
      null;
    const doneBtn = findDoneBtn();
    if (isVisibleEnabled(doneBtn)) {
      doneBtn.click();
      for (let i = 0; i < 25; i++) {
        await delay(100);
        if (!location.pathname.includes("/scene/")) break;
      }
    }
    if (location.pathname.includes("/scene/")) {
      const pm = /\/project\/([^/?#]+)/.exec(location.pathname || "");
      const pid = pm ? pm[1] : null;
      const router = pid ? findRouter() : null;
      if (router && pid) {
        await navigateSpa(router, ["/project", pid]);
        for (let i = 0; i < 25; i++) {
          await delay(100);
          if (!location.pathname.includes("/scene/")) break;
        }
      }
    }
    const closed = !location.pathname.includes("/scene/");
    clearStore();
    return { ok: true, closed };
  }

  return { ok: false, error: `unknown_video_action:${action}` };
}
