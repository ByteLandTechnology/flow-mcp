// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Trim Flow videos and drive the scene builder extend workflow.

import { buildProjectUrl, createScene, findRouter, navigateSpa, readAngularTooltip, readOwn, resolveLView, withLViewMapCapture } from "./angular";
import { findComposerWarning } from "./composer";
import { discoverStore } from "./discover_store";
import { cleanMediaId, delay, elText, hoverProbe, isDisabledProp, isTrashedTile, isVisibleEnabled, legacyMedia, legacyTile, videoTrimBounds } from "./dom";
import { activeProjectStoreFormat } from "./frontend_builds";
import { writePromptBox } from "./prompt_writer";
import { clearRpcErrors, drainTrackedRpcErrorMessage } from "./rpc_errors";
import { sceneContents } from "./scene_tiles";
import { clearStore, runtimeState } from "./state";
import type { FlowMediaPayload, FlowTile, VideoOpRequest } from "./types";

/** Per-workflow status snapshot used to detect newly appended extend failures. */
interface ExtendWorkflowSummary {
  /** Number of pending or scheduled media entries on the workflow. */
  pendingCount: number;
  /** Number of failed or canceled media entries on the workflow. */
  failedCount: number;
  /** Identifiers of failed or canceled media entries on the workflow. */
  failedIds: Set<string>;
  /** Formatted message of the most recent failed entry on the workflow. */
  latestError: string | null;
}

/** Baseline workflow state captured right before clicking Start generation in `prepare_extend`. */
let extendBaseline: Map<string, ExtendWorkflowSummary> | null = null;

/** Formats a media failure payload into a readable string, or returns null. */
function formatExtendMediaError(errVal: unknown): string | null {
  if (errVal == null || errVal === "") return null;
  if (typeof errVal === "string") return errVal.trim() || null;
  const msg = readOwn(errVal, "message");
  if (typeof msg === "string" && msg.trim()) return msg.trim();
  try {
    return JSON.stringify(errVal);
  } catch {
    return String(errVal);
  }
}

/** Collects workflow media item lists from the project store and live scene builder view. */
function collectExtendWorkflowItems(): Map<string, FlowMediaPayload[]> {
  const workflows = new Map<string, FlowMediaPayload[]>();
  const appendItems = (wfId: string, items: readonly FlowMediaPayload[]): void => {
    if (!wfId || items.length === 0) return;
    const list = workflows.get(wfId) ?? [];
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const norm = legacyMedia(raw);
      const itemId = cleanMediaId(String(norm.id ?? norm.mediaId ?? ""));
      if (
        itemId &&
        list.some((prev) => cleanMediaId(String(prev.id ?? prev.mediaId ?? "")) === itemId)
      ) {
        continue;
      }
      list.push(norm);
    }
    if (list.length > 0) workflows.set(wfId, list);
  };

  const activeSceneId = /\/scene\/([^/?#]+)/.exec(location.pathname || "")?.[1] ?? null;
  const tileMap = runtimeState.store?.getTileMap?.();
  if (tileMap instanceof Map) {
    for (const [id, rawTile] of tileMap.entries()) {
      const tile = legacyTile(rawTile);
      if (!tile || isTrashedTile(tile)) continue;
      const tid = String(tile.id ?? id);
      const ttype = String(tile.type ?? "").toUpperCase();
      if (ttype === "SCENE") {
        if (activeSceneId && tid !== activeSceneId) continue;
        const { history } = sceneContents(rawTile);
        for (const [wfId, hist] of history.entries()) {
          if (Array.isArray(hist)) appendItems(wfId, hist);
        }
      } else if (ttype === "VIDEO") {
        const hist = readOwn(rawTile, "history");
        if (Array.isArray(hist)) {
          appendItems(tid, hist as FlowMediaPayload[]);
        }
        if (tile.Fb) {
          appendItems(tid, [tile.Fb]);
        }
      }
    }
  }

  const sb = document.querySelector("flow-scene-builder");
  const lv = sb ? resolveLView(sb) : null;
  if (Array.isArray(lv)) {
    for (const slot of lv) {
      if (!slot || typeof slot !== "object" || slot instanceof Node || Array.isArray(slot)) {
        continue;
      }
      for (const key of Object.keys(slot)) {
        const val = readOwn(slot, key);
        if (!(val instanceof Map) || val.size === 0) continue;
        const sample = val.entries().next().value as [unknown, unknown] | undefined;
        const firstItem = Array.isArray(sample?.[1]) ? sample[1][0] : undefined;
        if (
          !sample ||
          typeof sample[0] !== "string" ||
          !Array.isArray(sample[1]) ||
          !firstItem ||
          typeof firstItem !== "object" ||
          firstItem instanceof Node ||
          !(
            "id" in firstItem ||
            "od" in firstItem ||
            "Zc" in firstItem ||
            "Bf" in firstItem ||
            "nf" in firstItem
          )
        ) {
          continue;
        }
        for (const [wfId, hist] of val.entries()) {
          if (typeof wfId === "string" && Array.isArray(hist)) {
            appendItems(wfId, hist as FlowMediaPayload[]);
          }
        }
      }
    }
  }

  return workflows;
}

/** Summarizes pending and failed history counts per workflow for extend polling. */
function captureExtendWorkflowSummary(): Map<string, ExtendWorkflowSummary> {
  const summaries = new Map<string, ExtendWorkflowSummary>();
  for (const [wfId, items] of collectExtendWorkflowItems().entries()) {
    let pendingCount = 0;
    let failedCount = 0;
    const failedIds = new Set<string>();
    let latestError: string | null = null;
    items.forEach((item, index) => {
      const status = String(item.Zc ?? "").toLowerCase();
      const err = formatExtendMediaError(item.nf);
      if (status === "pending" || status === "scheduled") {
        pendingCount += 1;
      } else if (status === "failed" || status === "canceled" || Boolean(err)) {
        failedCount += 1;
        const fid = cleanMediaId(String(item.id ?? item.mediaId ?? "")) || `#${index}`;
        failedIds.add(fid);
        latestError = err || status || "failed";
      }
    });
    summaries.set(wfId, { pendingCount, failedCount, failedIds, latestError });
  }
  return summaries;
}

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
  before: number | null,
  duration: number | null,
): boolean {
  if (expected === null) {
    if (actual === null) return true;
    return (
      typeof actual === "number" &&
      typeof duration === "number" &&
      duration > 0 &&
      (before === null || Math.abs(before - duration) > 0.01) &&
      Math.abs(actual - duration) <= 0.01
    );
  }
  return typeof actual === "number" && Math.abs(actual - expected) <= 0.01;
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
    const rawTile = tileMap.get(id);
    if (!rawTile) return { ok: false, error: `video_asset_not_found:${id}` };
    const tile = legacyTile(rawTile);
    const before = videoTrimBounds(tile);
    const mediaId = String(
      tile?.primaryMediaId ||
        tile?.Fb?.id ||
        tile?.Fb?.mediaId ||
        tile?.fb?.mediaId ||
        tile?.mediaId ||
        id,
    );
    const startSec =
      typeof req.start_seconds === "number" ? req.start_seconds : null;
    const endSec = typeof req.end_seconds === "number" ? req.end_seconds : null;
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
      endBoundMatches(cand.end, endSec, before.end, duration);
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
    const id = String(req?.asset_id || "").trim();
    const activeScene = /\/scene\/([^/?#]+)/.exec(location.pathname)?.[1];
    if (!activeScene || (req.scene_id && activeScene !== req.scene_id)) {
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
      let sceneId = req?.scene_id ? String(req.scene_id).trim() : null;
      if (!sceneId) {
        const wfId = String(tileMap.get(id)?.workflowId || id);
        const created = await createScene(helper, getMap, [wfId]);
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
        };
      } else {
        return {
          ok: false,
          error: "not_in_project_route",
          scene_id: sceneId,
        };
      }
    }

    for (let i = 0; i < 40; i++) {
      if (
        document.querySelector(
          "flow-scene-timeline, .is-extend-mode, .extend-composing, button[aria-label='Add clip']",
        )
      ) {
        break;
      }
      await delay(100);
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
      let extendBtn = findExtendBtn();
      if (!extendBtn) {
        const sb = document.querySelector("flow-scene-builder") || document;
        const clip = sb.querySelector(
          '[class*="clip"], [data-testid*="clip"], video',
        );
        if (clip instanceof HTMLElement) {
          clip.click();
          await delay(250);
        }
        for (let i = 0; i < 15; i++) {
          extendBtn = findExtendBtn();
          if (extendBtn) break;
          await delay(100);
        }
      }
      if (extendBtn) {
        extendBtn.click();
        await delay(300);
      }
      if (!inExtendMode()) {
        const addClipBtn = document.querySelector(
          'flow-scene-builder button[aria-label="Add clip"], flow-scene-timeline button[aria-label="Add clip"], button[aria-label="Add clip"]',
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
              /^(?:extend|prompt to extend)$/i.test(aria) ||
              /^(?:extend|prompt to extend)$/i.test(raw) ||
              Boolean(el.closest(".extend-clip-option"))
            );
          });
          if (extendOpt) {
            const innerBtn =
              extendOpt.querySelector("button, [role='menuitem']") || extendOpt;
            if (!isVisibleEnabled(innerBtn) || !isVisibleEnabled(extendOpt)) {
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
    if (activeProjectStoreFormat()) {
      if (!runtimeState.store || !runtimeState.store.isCurrent()) {
        await discoverStore();
      }
      for (let i = 0; i < 20 && runtimeState.store && !runtimeState.store.isReady(); i++) {
        await delay(100);
      }
    }
    clearRpcErrors();
    extendBaseline = captureExtendWorkflowSummary();
    return { ok: true, submit_point: { x, y } };
  }

  if (action === "poll_extend") {
    const rpcError = drainTrackedRpcErrorMessage();
    if (rpcError) {
      return { ok: true, extending: false, error: rpcError };
    }
    if ((!runtimeState.store || !runtimeState.store.isCurrent()) && activeProjectStoreFormat()) {
      await discoverStore();
    }
    const currentWorkflows = captureExtendWorkflowSummary();
    let busyHistory = false;
    for (const [wfId, cur] of currentWorkflows.entries()) {
      if (cur.pendingCount > 0) {
        busyHistory = true;
      }
      if (cur.failedCount > 0) {
        const prior = extendBaseline?.get(wfId);
        const hasNewFailedId = prior
          ? Array.from(cur.failedIds).some((fid) => !prior.failedIds.has(fid))
          : true;
        if (!prior || cur.failedCount > prior.failedCount || hasNewFailedId) {
          extendBaseline = currentWorkflows;
          return {
            ok: true,
            extending: false,
            error: cur.latestError || "failed",
            failed_workflow_id: wfId,
          };
        }
      }
    }
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
    return { ok: true, extending: busyDom || extendingText || busyHistory };
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
