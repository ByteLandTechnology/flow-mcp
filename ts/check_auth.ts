// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Verify Google Flow workspace access with route guards, Wiz tokens, and a read-only probe.

import type { AuthCheckResult } from "./types";

/** Read-only `FLOW_APP_CONFIG` RPC identifier in the Flow workspace route guard. */
const APP_CONFIG_RPC_ID = "cPZSdc";

/** Default Boq frontend data prefix when `WIZ_global_data.eptZe` is absent. */
const DEFAULT_DATA_PREFIX = "/_/AiSandboxAngularFrontend/";

/** Maximum wait in milliseconds for `WIZ_global_data` while the document loads. */
const WIZ_READY_WAIT_MS = 1500;

/** Strict timeout in milliseconds for the read-only Flow backend probe. */
const PROBE_TIMEOUT_MS = 5000;

/** Exact or segment-prefix non-workspace routes from the live Flow route table. */
const NON_WORKSPACE_SEGMENT_PREFIXES = [
  "/unsupported-country",
  "/unsupported-browser",
  "/unavailable",
  "/age-restricted",
  "/privacy",
  "/credits-terms",
  "/about",
  "/flow/about",
  "/academy",
  "/shared/tool",
  "/shared",
  "/flow/shared/tool",
  "/flow/shared",
  "/tools/flow/shared/tool",
  "/tools/flow/shared",
  "/404",
  "/login",
  "/tools/flow/about",
  "/tools/flow/login",
];

/** Selector that matches explicit Google Sign-In prompts and Flow landing shells. */
const SIGN_IN_SELECTOR =
  'flow-landing-page, a[aria-label="Sign in" i], button[aria-label="Sign in" i], button[aria-label="Create with Google Flow" i], a[href*="accounts.google.com/ServiceLogin" i], a[href*="accounts.google.com/v3/signin" i], a[href*="accounts.google.com/InteractiveLogin" i]';

/** Returns `true` when `path` equals `prefix` or begins with `prefix` plus `/`. */
function hasSegmentPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Normalizes a URL pathname to lowercase without trailing slashes, preserving `/`. */
function normalizePathname(raw: string): string {
  const lower = (raw || "/").trim().toLowerCase();
  const withSlash = lower.startsWith("/") ? lower : `/${lower}`;
  const trimmed = withSlash.replace(/\/+$/, "");
  return trimmed || "/";
}

/** Returns `true` when `pathname` matches any of the 17 non-workspace Flow routes. */
function isNonWorkspaceFlowPath(pathname: string): boolean {
  const clean = normalizePathname(pathname);
  const rel =
    clean === "/fx"
      ? "/"
      : clean.startsWith("/fx/")
        ? clean.slice(3)
        : clean;
  if (rel === "/flow") {
    return true;
  }
  return NON_WORKSPACE_SEGMENT_PREFIXES.some((prefix) =>
    hasSegmentPrefix(rel, prefix),
  );
}

/** Returns `true` when `hostname` and `pathname` target an active Flow workspace route. */
function isWorkspaceLocation(hostname: string, pathname: string): boolean {
  const host = (hostname || "").toLowerCase();
  const clean = normalizePathname(pathname);
  const onLabsHost = host === "labs.google" || host.endsWith(".labs.google");
  if (host !== "flow.google.com" && !onLabsHost) {
    return false;
  }
  if (onLabsHost && !hasSegmentPrefix(clean, "/fx/tools/flow")) {
    return false;
  }
  return !isNonWorkspaceFlowPath(clean);
}

/** Builds an `AuthCheckResult` record from the active document metadata. */
function authResult(
  signedIn: boolean,
  explicitSignedOut: boolean,
  tokenExpired: boolean,
  status: number,
  reason: string,
): AuthCheckResult {
  return {
    signed_in: signedIn,
    explicit_signed_out: explicitSignedOut,
    token_expired: tokenExpired,
    status,
    reason,
    title: document.title || "",
    path: (location.pathname || "/").toLowerCase(),
  };
}

/** Waits briefly when the HTML document still parses initial Wiz scripts. */
async function waitForWizData(): Promise<void> {
  const deadline = Date.now() + WIZ_READY_WAIT_MS;
  while (
    !window.WIZ_global_data &&
    document.readyState === "loading" &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/** Normalizes the Boq frontend path prefix so it starts and ends with `/`. */
function resolveDataPrefix(raw: string | undefined): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return DEFAULT_DATA_PREFIX;
  }
  const leading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return leading.endsWith("/") ? leading : `${leading}/`;
}

/** Inspects one `batchexecute` response body for `FLOW_APP_CONFIG` or token expiration. */
function parseProbeEnvelope(text: string, status: number): AuthCheckResult {
  let verifiedConfig = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\)\]\}'\s*/, "").trim();
    if (!line.startsWith("[")) {
      continue;
    }
    let entries: unknown;
    try {
      entries = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (!Array.isArray(entry)) {
        continue;
      }
      if (entry[0] === "xsrf") {
        return authResult(false, false, true, status, "xsrf_expired");
      }
      if (entry[0] !== "wrb.fr" || entry[1] !== APP_CONFIG_RPC_ID) {
        continue;
      }
      const rpcErr = entry[5];
      if (Array.isArray(rpcErr) && typeof rpcErr[0] === "number") {
        if (rpcErr[0] === 16) {
          return authResult(false, false, true, status, "rpc_unauthenticated");
        }
        return authResult(
          false,
          true,
          false,
          status,
          `rpc_error_${rpcErr[0]}`,
        );
      }
      if (typeof entry[2] !== "string") {
        continue;
      }
      let config: unknown;
      try {
        config = JSON.parse(entry[2]);
      } catch {
        continue;
      }
      if (Array.isArray(config)) {
        if (config[30] === false) {
          return authResult(false, true, false, status, "unsupported_country");
        }
        if (config[31] === false) {
          return authResult(false, true, false, status, "age_restricted");
        }
        verifiedConfig = true;
      } else if (config !== null && typeof config === "object") {
        verifiedConfig = true;
      }
    }
  }
  if (!verifiedConfig) {
    return authResult(false, false, false, status, "missing_rpc_payload");
  }
  if (!isWorkspaceLocation(location.hostname, location.pathname)) {
    return authResult(false, true, false, status, "non_workspace_route");
  }
  return authResult(true, false, false, status, "ok");
}

/** Verifies host, workspace route, `WIZ_global_data` tokens, and an HTTP 200 Flow probe. */
export async function checkAuth(): Promise<AuthCheckResult> {
  await waitForWizData();

  const host = (location.hostname || "").toLowerCase();
  const isFlowHost =
    host === "flow.google.com" ||
    host === "labs.google" ||
    host.endsWith(".labs.google");
  if (!isFlowHost) {
    return authResult(false, true, false, 0, "not_on_flow_host");
  }
  if (!isWorkspaceLocation(host, location.pathname)) {
    return authResult(false, true, false, 0, "non_workspace_route");
  }
  if (document.querySelector(SIGN_IN_SELECTOR)) {
    return authResult(false, true, false, 0, "sign_in_prompt");
  }

  const wiz = window.WIZ_global_data;
  if (wiz?.awbSEf !== true) {
    return authResult(false, true, false, 0, "wiz_signed_out");
  }
  const xsrfToken = typeof wiz.SNlM0e === "string" ? wiz.SNlM0e.trim() : "";
  if (!xsrfToken) {
    return authResult(false, true, false, 0, "missing_wiz_token");
  }

  const params = new URLSearchParams({
    rpcids: APP_CONFIG_RPC_ID,
    "source-path": location.pathname || "/",
    hl: "en",
    rt: "c",
  });
  if (typeof wiz.cfb2h === "string" && wiz.cfb2h.trim()) {
    params.set("bl", wiz.cfb2h.trim());
  }
  if (typeof wiz.FdrFJe === "string" && wiz.FdrFJe.trim()) {
    params.set("f.sid", wiz.FdrFJe.trim());
  }

  const reqPayload = JSON.stringify([
    [[APP_CONFIG_RPC_ID, "[]", null, "generic"]],
  ]);
  const body = `f.req=${encodeURIComponent(reqPayload)}&at=${encodeURIComponent(xsrfToken)}`;
  const prefix = resolveDataPrefix(wiz.eptZe);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(`${prefix}data/batchexecute?${params.toString()}`, {
      method: "POST",
      credentials: "include",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body,
    });
    const text = await resp.text();
    if (resp.status === 401) {
      return authResult(false, false, true, resp.status, "http_401");
    }
    if (resp.status === 400 && /xsrf/i.test(text)) {
      return authResult(false, false, true, resp.status, "xsrf_expired");
    }
    if (resp.status !== 200) {
      return authResult(
        false,
        resp.status === 403,
        false,
        resp.status,
        `http_${resp.status}`,
      );
    }
    return parseProbeEnvelope(text, resp.status);
  } catch (err) {
    const aborted =
      err instanceof DOMException && err.name === "AbortError"
        ? "probe_timeout"
        : "probe_network_error";
    return authResult(false, false, false, 0, aborted);
  } finally {
    clearTimeout(timer);
  }
}
