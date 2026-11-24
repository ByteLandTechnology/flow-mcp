// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Probe Google Flow authentication shell state on the active page.

import { elText } from "./dom";
import type { AuthCheckResult } from "./types";

/** Selectors for controls rendered inside an active `/project/:id` workspace route. */
const PROJECT_WORKSPACE_SELECTOR = [
  "flow-project-page",
  "flow-grid-tile-container",
  "flow-prompt-box",
  "flow-base-prompt-box",
  "flow-rich-text-editor",
  "flow-character-edit-page",
  "flow-character-form",
  "flow-scene-builder",
  "flow-editor-page",
  "flow-agent-panel",
  "flow-applet-prompt-box",
  "button.library-expand-button",
  'button[aria-label="Settings trigger"]',
  'button[aria-label="Done editing"]',
  'button[aria-label="Done editing scene"]',
  'button[aria-label="Go back"]',
  '[role="textbox"][contenteditable="true"]',
  "textarea",
].join(", ");

/** Selectors for controls rendered on the Flow home, `/projects`, and `/search` routes. */
const HOME_WORKSPACE_SELECTOR = [
  "flow-project-card",
  'a[href*="/project/"]',
  "button.projects-grid-new-project-button",
  "button.new-project-button",
  'button[aria-label="New project" i]',
].join(", ");

/** Normalizes `host` and `path` to a Flow-relative route path, or returns `null`. */
function normalizeFlowRoutePath(host: string, path: string): string | null {
  if (host === "flow.google.com") {
    if (path === "/fx/tools/flow") return "/";
    if (path.startsWith("/fx/tools/flow/")) return path.slice("/fx/tools/flow".length);
    return path;
  }
  if (host === "labs.google" || host.endsWith(".labs.google")) {
    if (path === "/fx/tools/flow") return "/";
    if (path.startsWith("/fx/tools/flow/")) return path.slice("/fx/tools/flow".length);
    return null;
  }
  return null;
}

/** Returns `true` when `relPath` matches an allowlisted Google Flow workspace route. */
function isWorkspaceFlowPath(relPath: string): boolean {
  const trimmed = relPath.endsWith("/") ? relPath.slice(0, -1) : relPath;
  if (trimmed === "") return true;
  if (!trimmed.startsWith("/")) return false;
  const segments = trimmed.slice(1).split("/");
  if (segments.some((seg) => seg.length === 0)) return false;
  if (segments.length === 1) {
    return segments[0] === "projects" || segments[0] === "search";
  }
  if (segments[0] !== "project") return false;
  if (segments.length === 2) return true;
  const sub = segments[2];
  if (segments.length === 3) {
    return (
      sub === "chat" ||
      sub === "character" ||
      sub === "trash" ||
      sub === "tools" ||
      sub === "create-tool"
    );
  }
  if (segments.length === 4) {
    return (
      sub === "chat" ||
      sub === "collection" ||
      sub === "scene" ||
      sub === "edit" ||
      sub === "character" ||
      sub === "tool"
    );
  }
  if (segments.length === 5) {
    return (
      (sub === "collection" && segments[4] === "character") ||
      (sub === "trash" && segments[3] === "collection")
    );
  }
  return false;
}

/** Returns `true` when rendered workspace controls exist for `relPath` after router guards settle. */
function hasWorkspaceControls(relPath: string): boolean {
  if (relPath === "/project" || relPath.startsWith("/project/")) {
    return Boolean(document.querySelector(PROJECT_WORKSPACE_SELECTOR));
  }
  if (document.querySelector(HOME_WORKSPACE_SELECTOR)) {
    return true;
  }
  if (
    (relPath === "/search" || relPath === "/search/") &&
    document.querySelector(
      'input[type="search"], input[aria-label*="Search" i], input[placeholder*="Search" i]',
    )
  ) {
    return true;
  }
  return Array.from(document.querySelectorAll('a, button, [role="button"]')).some(
    (el) => {
      if (el.getClientRects().length === 0) return false;
      const label = elText(el) || (el.getAttribute("aria-label") || "").trim();
      return /\bnew project\b/i.test(label);
    },
  );
}

/** Inspects host, route allowlist, server bootstrap state, and workspace controls to verify sign-in. */
export function checkAuth(): AuthCheckResult {
  const host = (location.hostname || "").toLowerCase();
  const path = (location.pathname || "/").toLowerCase();
  const relPath = normalizeFlowRoutePath(host, path);
  if (relPath === null || !isWorkspaceFlowPath(relPath)) {
    return {
      signed_in: false,
      explicit_signed_out: true,
      title: document.title,
      path,
    };
  }

  if (
    document.querySelector(
      'flow-landing-page, a[aria-label="Sign in" i], button[aria-label="Sign in" i], button[aria-label="Create with Google Flow" i], a[href*="accounts.google.com/ServiceLogin" i], a[href*="accounts.google.com/v3/signin" i], a[href*="accounts.google.com/InteractiveLogin" i]',
    )
  ) {
    return {
      signed_in: false,
      explicit_signed_out: true,
      title: document.title,
      path,
    };
  }

  const signInBtn = Array.from(
    document.querySelectorAll('a, button, [role="button"]'),
  ).find((el) => {
    if (el.getClientRects().length === 0) return false;
    const label = elText(el) || (el.getAttribute("aria-label") || "").trim();
    return /\bsign in\b/i.test(label);
  });
  if (signInBtn) {
    return {
      signed_in: false,
      explicit_signed_out: true,
      title: document.title,
      path,
    };
  }

  const authFlag = window.WIZ_global_data?.awbSEf;
  if (authFlag === false) {
    return {
      signed_in: false,
      explicit_signed_out: true,
      title: document.title,
      path,
    };
  }
  if (authFlag !== true) {
    return {
      signed_in: false,
      explicit_signed_out: false,
      title: document.title,
      path,
    };
  }

  return {
    signed_in: hasWorkspaceControls(relPath),
    explicit_signed_out: false,
    title: document.title,
    path,
  };
}
