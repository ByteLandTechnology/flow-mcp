// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Verify Google Flow workspace access with route guards, Wiz tokens, and a read-only probe.

import {
  flowQueryParams,
  flowRoutePrefix,
  hasSegmentPrefix,
  normalizeFlowPathname,
  pathAuthuser,
  prefixHasFxToolsFlow,
  stripFlowRoutePrefix,
} from "./angular";
import { isJspbMessage, jspbField } from "./resolve_video_url";
import type { AuthCheckResult } from "./types";

/** Read-only `FLOW_APP_CONFIG` RPC identifier in the Flow workspace route guard. */
const APP_CONFIG_RPC_ID = "cPZSdc";

/** Read-only `CHECK_TOOL_AVAILABILITY` RPC identifier in the Flow workspace route guard. */
const TOOL_AVAILABILITY_RPC_ID = "KV2T2d";

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

/** Returns `true` when `pathname` matches any of the 17 non-workspace Flow routes. */
export function isNonWorkspaceFlowPath(pathname: string): boolean {
  const rel = stripFlowRoutePrefix(pathname);
  if (rel === "/flow") {
    return true;
  }
  return NON_WORKSPACE_SEGMENT_PREFIXES.some((prefix) =>
    hasSegmentPrefix(rel, prefix),
  );
}

/** Returns `true` when `hostname` and `pathname` target an active Flow workspace route. */
export function isWorkspaceLocation(
  hostname: string,
  pathname: string,
): boolean {
  const host = (hostname || "").toLowerCase();
  const clean = normalizeFlowPathname(pathname);
  const onLabsHost = host === "labs.google" || host.endsWith(".labs.google");
  if (host !== "flow.google.com" && !onLabsHost) {
    return false;
  }
  if (onLabsHost && !prefixHasFxToolsFlow(flowRoutePrefix(clean))) {
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

/** Returns `true` when a JSPB boolean field value explicitly encodes `false` or `0`. */
function isJspbDisabledFlag(val: unknown): boolean {
  return val === false || val === 0;
}

/** Parses an integer enum code from a JSPB field value, or `0` when absent. */
function readJspbEnumCode(val: unknown): number {
  if (typeof val === "number" && Number.isInteger(val)) {
    return val;
  }
  if (typeof val === "string" && /^\d+$/.test(val.trim())) {
    return Number(val.trim());
  }
  return 0;
}

/** Inspects one `batchexecute` response body for `cPZSdc`, `KV2T2d`, or token expiration. */
export function parseProbeEnvelope(
  text: string,
  status: number,
): AuthCheckResult {
  let verifiedProbe = false;
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
      if (
        entry[0] !== "wrb.fr" ||
        (entry[1] !== APP_CONFIG_RPC_ID && entry[1] !== TOOL_AVAILABILITY_RPC_ID)
      ) {
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
      let payload: unknown;
      try {
        payload = JSON.parse(entry[2]);
      } catch {
        continue;
      }
      if (!isJspbMessage(payload)) {
        continue;
      }
      if (entry[1] === APP_CONFIG_RPC_ID) {
        if (isJspbDisabledFlag(jspbField(payload, 31))) {
          return authResult(false, true, false, status, "unsupported_country");
        }
        if (isJspbDisabledFlag(jspbField(payload, 32))) {
          return authResult(false, true, false, status, "age_restricted");
        }
        verifiedProbe = true;
      } else {
        const availability = readJspbEnumCode(jspbField(payload, 1));
        if (availability === 7) {
          return authResult(false, true, false, status, "age_restricted");
        }
        if (
          availability === 4 ||
          availability === 5 ||
          availability === 6 ||
          availability === 8
        ) {
          return authResult(false, true, false, status, "unavailable");
        }
        verifiedProbe = true;
      }
    }
  }
  if (!verifiedProbe) {
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

  const checkToolAvailability = wiz.cPpIQe !== true;
  const params = new URLSearchParams({
    rpcids: checkToolAvailability
      ? `${APP_CONFIG_RPC_ID},${TOOL_AVAILABILITY_RPC_ID}`
      : APP_CONFIG_RPC_ID,
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
  const routeParams = flowQueryParams(location.search);
  const wizUser =
    typeof wiz.QrtxK === "string" && wiz.QrtxK.trim() && wiz.QrtxK.trim() !== "0"
      ? wiz.QrtxK.trim()
      : "";
  const authuser =
    routeParams.authuser || pathAuthuser(location.pathname) || wizUser;
  if (authuser) {
    params.set("authuser", authuser);
  }
  if (routeParams.pageId) {
    params.set("pageId", routeParams.pageId);
  }

  const rpcCalls: Array<[string, string, null, string]> = checkToolAvailability
    ? [
        [APP_CONFIG_RPC_ID, "[]", null, "1"],
        [TOOL_AVAILABILITY_RPC_ID, "[22]", null, "2"],
      ]
    : [[APP_CONFIG_RPC_ID, "[]", null, "generic"]];
  const reqPayload = JSON.stringify([rpcCalls]);
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
