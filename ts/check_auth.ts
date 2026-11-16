// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Probe Google Flow authentication shell state on the active page.

import { elText } from "./dom";
import type { AuthCheckResult } from "./types";

/** Inspects host, pathname, sign-in links, and app-shell nodes to infer session state. */
export function checkAuth(): AuthCheckResult {
  const host = (location.hostname || "").toLowerCase();
  const path = (location.pathname || "/").toLowerCase();
  const isFlowHost =
    host === "flow.google.com" ||
    host === "labs.google" ||
    host.endsWith(".labs.google");
  if (!isFlowHost) {
    return {
      signed_in: false,
      explicit_signed_out: true,
      title: document.title,
      path,
    };
  }

  const blockedPrefixes = [
    "/about",
    "/fx/about",
    "/unsupported-country",
    "/age-restricted",
    "/unavailable",
    "/login",
  ];
  if (blockedPrefixes.some((p) => path.startsWith(p))) {
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

  if (path.includes("/project/")) {
    return {
      signed_in: true,
      explicit_signed_out: false,
      title: document.title,
      path,
    };
  }

  const hasAppShell = Boolean(
    document.querySelector(
      'flow-project-card, flow-project-page, aisandbox-root, flow-grid-tile-container, a[href*="/project/"], button[aria-label="Settings trigger"], button[aria-label="New project" i], a[href*="accounts.google.com/SignOutOptions"], a[aria-label^="Google Account:" i]',
    ) ||
      Array.from(document.querySelectorAll('a, button, [role="button"]')).some(
        (el) => {
          if (el.getClientRects().length === 0) return false;
          const label = elText(el) || (el.getAttribute("aria-label") || "").trim();
          return /\bnew project\b/i.test(label);
        },
      ),
  );

  return {
    signed_in: hasAppShell,
    explicit_signed_out: false,
    title: document.title,
    path,
  };
}
