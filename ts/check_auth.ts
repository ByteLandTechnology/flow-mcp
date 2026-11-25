// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Verify Google Flow workspace access with route allowlists, Angular QueryCache state, and RPC fallback.

import {
  ensureAngularQueryCache,
  hasAngularContext,
  isRouterNavigating,
  isWorkspaceFlowRoute,
  readOwn,
  readQueryCacheEntry,
  resolveFlowAuthuser,
  resolveFlowPageId,
  splitFlowPath,
} from "./angular";
import type { AngularQueryEntry, AuthCheckResult } from "./types";

/** Read-only `FLOW_APP_CONFIG` RPC identifier in the Flow workspace route guard. */
const APP_CONFIG_RPC_ID = "cPZSdc";

/** Read-only `CHECK_TOOL_AVAILABILITY` RPC identifier in the Flow workspace route guard. */
const TOOL_AVAILABILITY_RPC_ID = "KV2T2d";

/** Tool identifier passed to `CHECK_TOOL_AVAILABILITY` by the Flow workspace route guard. */
const FLOW_TOOL_AVAILABILITY_ID = 22;

/** Unminified `QueryCache` key for `FLOW_APP_CONFIG`. */
const APP_CONFIG_QUERY_KEY = ["FLOW_APP_CONFIG"] as const;

/** Unminified `QueryCache` key for `CHECK_TOOL_AVAILABILITY` on Flow workspace routes. */
const TOOL_AVAILABILITY_QUERY_KEY = [
  "CHECK_TOOL_AVAILABILITY",
  FLOW_TOOL_AVAILABILITY_ID,
] as const;

/** Default Boq frontend data prefix when `WIZ_global_data.eptZe` is absent. */
const DEFAULT_DATA_PREFIX = "/_/AiSandboxAngularFrontend/";

/** Maximum wait in milliseconds for `WIZ_global_data` while the document loads. */
const WIZ_READY_WAIT_MS = 1500;

/** Maximum wait in milliseconds for active route guards and pending queries to settle. */
const GUARD_SETTLE_WAIT_MS = 2000;

/** Short hydration wait in milliseconds when Angular hosts mount before `QueryCache` populates. */
const HYDRATION_CACHE_WAIT_MS = 300;

/** Strict timeout in milliseconds for the read-only Flow backend probe. */
const PROBE_TIMEOUT_MS = 5000;

/** Selector that matches explicit Google Sign-In prompts and Flow landing shells. */
const SIGN_IN_SELECTOR =
  'flow-landing-page, a[aria-label="Sign in" i], button[aria-label="Sign in" i], button[aria-label="Create with Google Flow" i], a[href*="accounts.google.com/ServiceLogin" i], a[href*="accounts.google.com/v3/signin" i], a[href*="accounts.google.com/InteractiveLogin" i]';

/** Returns `true` when `hostname` and `pathname` target an allowlisted Flow workspace route. */
export function isWorkspaceLocation(hostname: string, pathname: string): boolean {
  const host = (hostname || "").toLowerCase();
  const onLabsHost = host === "labs.google" || host.endsWith(".labs.google");
  if (host !== "flow.google.com" && !onLabsHost) {
    return false;
  }
  const stripped = splitFlowPath(pathname || "/");
  if (onLabsHost && !stripped.hasLabsFlowPrefix) {
    return false;
  }
  return isWorkspaceFlowRoute(stripped.route);
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

/** Returns `true` when `value` is a plain key-value object suitable as a JSPB sparse pivot map. */
function isPlainPivotObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Reads a 1-based protobuf field from a JSPB `.qf` instance, dense array, or sparse pivot object. */
function readJspbField(payload: unknown, fieldNumber: number): unknown {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  let target: unknown = payload;
  if (!Array.isArray(target)) {
    const qf = readOwn(target, "qf");
    if (Array.isArray(qf)) {
      target = qf;
    } else {
      const toJson = readOwn(target, "toJSON");
      if (typeof toJson === "function") {
        try {
          const serialized: unknown = toJson.call(target);
          if (serialized && typeof serialized === "object") {
            target = serialized;
          }
        } catch {
          // Fall through to direct property inspection.
        }
      }
    }
  }
  const sparseKey = String(fieldNumber);
  if (!Array.isArray(target)) {
    return readOwn(target, sparseKey);
  }
  const lastIndex = target.length - 1;
  if (lastIndex < 0) {
    return undefined;
  }
  const denseIndex = fieldNumber - 1;
  const tail: unknown = target[lastIndex];
  const hasPivot = isPlainPivotObject(tail);
  if (denseIndex < lastIndex) {
    const denseVal: unknown = target[denseIndex];
    if (denseVal !== undefined && denseVal !== null) {
      return denseVal;
    }
    return hasPivot ? readOwn(tail, sparseKey) : denseVal;
  }
  if (hasPivot) {
    return readOwn(tail, sparseKey);
  }
  return denseIndex === lastIndex ? tail : undefined;
}

/** Returns `true` when a JSPB boolean flag value explicitly disables eligibility (`false` or `0`). */
function isDisabledJspbBool(value: unknown): boolean {
  return value === false || value === 0;
}

/** Evaluates `FLOW_APP_CONFIG` (`cPZSdc`) payload fields `31` (country) and `32` (age). */
function evaluateAppConfigPayload(
  payload: unknown,
): "ok" | "unsupported_country" | "age_restricted" | "invalid" {
  if (!payload || typeof payload !== "object") {
    return "invalid";
  }
  if (isDisabledJspbBool(readJspbField(payload, 31))) {
    return "unsupported_country";
  }
  if (isDisabledJspbBool(readJspbField(payload, 32))) {
    return "age_restricted";
  }
  return "ok";
}

/** Evaluates `CHECK_TOOL_AVAILABILITY` (`KV2T2d`) field `1` (`Cla()`) codes `4`..`8`. */
function evaluateToolAvailabilityPayload(
  payload: unknown,
): "ok" | "age_restricted" | "unavailable" {
  if (!payload || typeof payload !== "object") {
    return "ok";
  }
  let rawCode: unknown = readJspbField(payload, 1);
  if (rawCode === undefined) {
    const cla = readOwn(payload, "Cla");
    if (typeof cla === "function") {
      try {
        rawCode = cla.call(payload);
      } catch {
        rawCode = undefined;
      }
    }
  }
  const code =
    typeof rawCode === "number" && Number.isFinite(rawCode)
      ? Math.trunc(rawCode)
      : undefined;
  if (code === 7) {
    return "age_restricted";
  }
  if (code === 4 || code === 5 || code === 6 || code === 8) {
    return "unavailable";
  }
  return "ok";
}

/** Returns `true` when `entry` is actively fetching or still awaiting its initial settlement. */
function isQueryPending(entry: AngularQueryEntry | undefined): boolean {
  if (!entry?.state) return false;
  return (
    entry.state.status === "pending" || entry.state.fetchStatus === "fetching"
  );
}

/** Returns `true` when a `QueryCache` error indicates HTTP 401 or gRPC `UNAUTHENTICATED` (`16`). */
function isUnauthenticatedQueryError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const um = readOwn(err, "um");
  const httpStatus = readOwn(err, "httpStatusCode");
  const status = readOwn(err, "status");
  const code = readOwn(err, "code");
  if (um === 401 || httpStatus === 401 || status === 401 || code === 16) {
    return true;
  }
  if (status && typeof status === "object") {
    const vf = readOwn(status, "vf");
    if (typeof vf === "function") {
      try {
        if (vf.call(status) === 16) return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

/** Reads settled eligibility queries from Angular's `QueryCache` after awaiting active route guards. */
async function checkAngularQueryEligibility(): Promise<AuthCheckResult | null> {
  if (!hasAngularContext()) {
    return null;
  }
  const start = Date.now();
  const settleDeadline = start + GUARD_SETTLE_WAIT_MS;
  const hydrationDeadline = start + HYDRATION_CACHE_WAIT_MS;

  while (true) {
    if (!isWorkspaceLocation(location.hostname, location.pathname)) {
      return authResult(false, true, false, 0, "non_workspace_route");
    }
    if (document.querySelector(SIGN_IN_SELECTOR)) {
      return authResult(false, true, false, 0, "sign_in_prompt");
    }

    const cache = await ensureAngularQueryCache();
    const appQuery = readQueryCacheEntry(cache, APP_CONFIG_QUERY_KEY);
    const toolQuery = readQueryCacheEntry(cache, TOOL_AVAILABILITY_QUERY_KEY);
    const navigating = isRouterNavigating();
    const pending = isQueryPending(appQuery) || isQueryPending(toolQuery);
    const now = Date.now();

    if ((navigating || pending) && now < settleDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      continue;
    }
    if (!appQuery && !toolQuery && now < hydrationDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      continue;
    }

    const authErr =
      appQuery?.state?.error ??
      appQuery?.state?.failureReason ??
      toolQuery?.state?.error ??
      toolQuery?.state?.failureReason;
    if (isUnauthenticatedQueryError(authErr)) {
      return authResult(false, false, true, 401, "rpc_unauthenticated");
    }

    const toolData =
      toolQuery?.state?.status === "success" ? toolQuery.state.data : undefined;
    if (toolData !== undefined) {
      const toolVerdict = evaluateToolAvailabilityPayload(toolData);
      if (toolVerdict !== "ok") {
        return authResult(false, true, false, 0, toolVerdict);
      }
    }

    const appData =
      appQuery?.state?.status === "success" ? appQuery.state.data : undefined;
    if (appData !== undefined) {
      const appVerdict = evaluateAppConfigPayload(appData);
      if (appVerdict === "unsupported_country" || appVerdict === "age_restricted") {
        return authResult(false, true, false, 0, appVerdict);
      }
    }

    if ((!appQuery || !toolQuery) && now < hydrationDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      continue;
    }

    if (appData !== undefined && toolData !== undefined) {
      if (evaluateAppConfigPayload(appData) !== "ok") {
        return null;
      }
      if (!isWorkspaceLocation(location.hostname, location.pathname)) {
        return authResult(false, true, false, 0, "non_workspace_route");
      }
      return authResult(true, false, false, 0, "ok");
    }

    return null;
  }
}

/** Inspects a batched `batchexecute` response body for `cPZSdc` and `KV2T2d` eligibility or auth errors. */
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
      let parsedPayload: unknown;
      try {
        parsedPayload = JSON.parse(entry[2]);
      } catch {
        continue;
      }
      if (entry[1] === APP_CONFIG_RPC_ID) {
        const verdict = evaluateAppConfigPayload(parsedPayload);
        if (verdict === "unsupported_country" || verdict === "age_restricted") {
          return authResult(false, true, false, status, verdict);
        }
        if (verdict === "ok") {
          verifiedConfig = true;
        }
      } else if (entry[1] === TOOL_AVAILABILITY_RPC_ID) {
        const toolVerdict = evaluateToolAvailabilityPayload(parsedPayload);
        if (toolVerdict !== "ok") {
          return authResult(false, true, false, status, toolVerdict);
        }
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

/** Verifies host, workspace route, `WIZ_global_data` tokens, Angular `QueryCache`, or a batched Flow RPC probe. */
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

  const cachedResult = await checkAngularQueryEligibility();
  if (cachedResult) {
    return cachedResult;
  }

  const params = new URLSearchParams({
    rpcids: `${APP_CONFIG_RPC_ID},${TOOL_AVAILABILITY_RPC_ID}`,
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
  const authuser = resolveFlowAuthuser();
  if (authuser) {
    params.set("authuser", authuser);
  }
  const pageId = resolveFlowPageId();
  if (pageId) {
    params.set("pageId", pageId);
  }

  const reqPayload = JSON.stringify([
    [
      [APP_CONFIG_RPC_ID, "[]", null, "1"],
      [
        TOOL_AVAILABILITY_RPC_ID,
        JSON.stringify([FLOW_TOOL_AVAILABILITY_ID]),
        null,
        "2",
      ],
    ],
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
