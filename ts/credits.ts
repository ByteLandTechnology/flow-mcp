// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read the account credit balance from cached CREDITS queries or account labels.

import { isLiveLView, readOwn, resolveLView } from "./angular";
import { frontendBuild, readBuildLabel } from "./frontend_builds";
import { runtimeState } from "./state";
import type { NgLView } from "./types";

/** Constructor token for an Angular service class. */
type ServiceConstructor = abstract new (...args: never[]) => object;

/** Keys on credit payloads that store tier codes rather than credit balances. */
const NON_CREDIT_VALUE_KEYS = new Set([
  "serviceTier",
  "tier",
  "paygateTier",
  "userPaygateTier",
]);

/** Explicit field names checked first on cached `CREDITS` payloads. */
const CREDIT_VALUE_KEYS = [
  "credits",
  "remainingCredits",
  "availableCredits",
  "creditBalance",
  "aiCredits",
  "remaining",
  "balance",
  "totalCredits",
  "amount",
] as const;

/** Selector matching single-generation cost labels and composer prompt subtrees. */
const IGNORED_CREDIT_SELECTOR = [
  "flow-credit-cost-label",
  '[class*="credit-cost"]',
  '[class*="cost-label"]',
  "flow-prompt-box",
  "flow-base-prompt-box",
  "flow-edit-video-prompt-box",
  "flow-character-prompt-box",
  "flow-edit-character-footer",
  "flow-creative-agent-prompt-box",
  "flow-agent-panel",
  ".agent-panel-wrapper",
].join(", ");

/** Parses a non-negative integer credit balance from a number or numeric string. */
function parseCreditNumber(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
    return Math.trunc(val);
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (/^\d[\d,]*$/.test(trimmed)) {
      const parsed = parseInt(trimmed.replace(/,/g, ""), 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }
  }
  return null;
}

/** Extracts a credit balance from a cached `CREDITS` query payload. */
function extractCreditsFromData(data: unknown, depth = 0): number | null {
  if (depth > 3 || data == null) return null;
  const direct = parseCreditNumber(data);
  if (direct !== null) return direct;
  if (typeof data !== "object") return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const hit = parseCreditNumber(item);
      if (hit !== null) return hit;
    }
    const tail = data.at(-1);
    if (tail && typeof tail === "object" && !Array.isArray(tail)) {
      const keys = Object.keys(tail)
        .filter((k) => /^\d+$/.test(k))
        .sort((a, b) => Number(a) - Number(b));
      for (const k of keys) {
        const hit = parseCreditNumber(readOwn(tail, k));
        if (hit !== null) return hit;
      }
    }
    return null;
  }
  for (const key of CREDIT_VALUE_KEYS) {
    const raw = readOwn(data, key);
    const val =
      typeof raw === "function"
        ? (() => {
            try {
              return raw.call(data);
            } catch {
              return undefined;
            }
          })()
        : raw;
    const hit = parseCreditNumber(val);
    if (hit !== null) return hit;
    if (val && typeof val === "object") {
      const nested = extractCreditsFromData(val, depth + 1);
      if (nested !== null) return nested;
    }
  }
  const serialize = readOwn(data, "toJSON");
  if (typeof serialize === "function") {
    try {
      const hit = extractCreditsFromData(serialize.call(data), depth + 1);
      if (hit !== null) return hit;
    } catch {
      // Fall through to own property scan.
    }
  }
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (NON_CREDIT_VALUE_KEYS.has(k)) continue;
    const hit = parseCreditNumber(v);
    if (hit !== null) return hit;
  }
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (
      NON_CREDIT_VALUE_KEYS.has(k) ||
      !v ||
      typeof v !== "object" ||
      v instanceof Date
    ) {
      continue;
    }
    const hit = extractCreditsFromData(v, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

/** Returns true when `key` identifies a `CREDITS` service query. */
function isCreditsQueryKey(key: unknown): boolean {
  return (
    Array.isArray(key) &&
    key.some(
      (part) => typeof part === "string" && part.toUpperCase() === "CREDITS",
    )
  );
}

/** Reads the credit balance from a TanStack `Query` or query observer carrying `CREDITS`. */
function extractCreditsFromQuery(query: unknown): number | null {
  if (!query || typeof query !== "object") return null;
  const state = readOwn(query, "state");
  if (state && typeof state === "object") {
    const status = readOwn(state, "status");
    const data = readOwn(state, "data");
    if (status !== "pending" && status !== "error" && data !== undefined) {
      const hit = extractCreditsFromData(data);
      if (hit !== null) return hit;
    }
  }
  const dataProp = readOwn(query, "data");
  if (typeof dataProp === "function") {
    try {
      const hit = extractCreditsFromData(dataProp.call(query));
      if (hit !== null) return hit;
    } catch {
      // Ignore disposed query signals.
    }
  }
  return extractCreditsFromData(dataProp);
}

/** Inspects a query client, query cache, or query object for a cached `CREDITS` balance. */
function extractCreditsFromCacheOwner(cand: unknown): number | null {
  if (!cand || typeof cand !== "object" || cand instanceof Node) return null;
  if (isCreditsQueryKey(readOwn(cand, "queryKey"))) {
    const hit = extractCreditsFromQuery(cand);
    if (hit !== null) return hit;
  }
  const queryCache = readOwn(cand, "queryCache");
  const cache =
    queryCache && typeof queryCache === "object" ? queryCache : cand;
  const findAll = readOwn(cache, "findAll");
  if (typeof findAll === "function") {
    try {
      const list = findAll.call(cache, { queryKey: ["CREDITS"] });
      if (Array.isArray(list)) {
        for (const q of list) {
          const hit = extractCreditsFromQuery(q);
          if (hit !== null) return hit;
        }
      }
    } catch {
      // Ignore non-QueryCache methods.
    }
  }
  const find = readOwn(cache, "find");
  if (typeof find === "function") {
    try {
      const q = find.call(cache, { queryKey: ["CREDITS"] });
      const hit = extractCreditsFromQuery(q);
      if (hit !== null) return hit;
    } catch {
      // Ignore non-QueryCache methods.
    }
  }
  const getAll = readOwn(cache, "getAll");
  if (typeof getAll === "function") {
    try {
      const list = getAll.call(cache);
      if (Array.isArray(list)) {
        for (const q of list) {
          if (!isCreditsQueryKey(readOwn(q, "queryKey"))) continue;
          const hit = extractCreditsFromQuery(q);
          if (hit !== null) return hit;
        }
      }
    } catch {
      // Ignore non-QueryCache methods.
    }
  }
  const getQueryData = readOwn(cand, "getQueryData");
  if (typeof getQueryData === "function") {
    try {
      const hit = extractCreditsFromData(getQueryData.call(cand, ["CREDITS"]));
      if (hit !== null) return hit;
    } catch {
      // Ignore non-QueryClient methods.
    }
  }
  const ha = readOwn(cand, "ha");
  if (
    typeof ha === "function" &&
    (Boolean(queryCache && typeof queryCache === "object") ||
      typeof find === "function")
  ) {
    try {
      const hit = extractCreditsFromData(ha.call(cand, ["CREDITS"]));
      if (hit !== null) return hit;
    } catch {
      // Ignore non-QueryClient methods.
    }
  }
  for (const [, val] of Object.entries(cache as Record<string, unknown>)) {
    const items =
      val instanceof Map
        ? Array.from(val.values())
        : Array.isArray(val)
          ? val
          : null;
    if (!items) continue;
    for (const q of items) {
      if (!isCreditsQueryKey(readOwn(q, "queryKey"))) continue;
      const hit = extractCreditsFromQuery(q);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/** Reads the cached credit balance from bound Angular services and TanStack Query caches. */
function readCachedCredits(): number | null {
  const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
  const tierKey =
    frontendBuild(readBuildLabel())?.operations.agent_settings?.exports
      .serviceTier;
  const serviceTokens = [tierKey, "EG", "pG"]
    .filter((k): k is string => Boolean(k))
    .map((k) => readOwn(namespace, k))
    .filter((tok): tok is ServiceConstructor => typeof tok === "function");

  const queue: object[] = [];
  const seen = new Set<object>();
  const enqueue = (val: unknown): void => {
    if (
      val &&
      typeof val === "object" &&
      !(val instanceof Node) &&
      !(val instanceof Date) &&
      !seen.has(val) &&
      seen.size < 160
    ) {
      seen.add(val);
      queue.push(val);
    }
  };

  enqueue(runtimeState.lService);

  const inspectInjector = (injRoot: object): void => {
    let inj: object | null = injRoot;
    for (let d = 0; d < 6 && inj && typeof inj === "object"; d += 1) {
      const getFn = readOwn(inj, "get");
      if (typeof getFn === "function") {
        for (const token of serviceTokens) {
          try {
            enqueue(getFn.call(inj, token, null));
          } catch {
            // Ignore injector lookup errors.
          }
        }
      }
      const records = readOwn(inj, "records");
      if (records instanceof Map) {
        for (const rec of records.values()) {
          enqueue(rec);
          enqueue(readOwn(rec, "value"));
        }
      }
      const parent = readOwn(inj, "parent");
      inj = parent && typeof parent === "object" ? parent : null;
    }
  };

  const seenViews = new Set<unknown>();
  const inspectView = (lv: NgLView | null, depth = 0): void => {
    if (!Array.isArray(lv) || seenViews.has(lv) || seenViews.size > 60) return;
    seenViews.add(lv);
    for (const slot of lv) {
      if (!slot || typeof slot !== "object" || slot instanceof Node) continue;
      if (
        readOwn(slot, "records") instanceof Map ||
        "parent" in slot ||
        typeof readOwn(slot, "get") === "function"
      ) {
        inspectInjector(slot);
      }
      enqueue(slot);
    }
    if (depth < 4) {
      if (Array.isArray(lv[3])) inspectView(lv[3], depth + 1);
      if (Array.isArray(lv[15])) inspectView(lv[15], depth + 1);
    }
  };

  for (const el of document.querySelectorAll(
    "flow-project-page, flow-project-shell, aisandbox-root, app-root, header, main",
  )) {
    inspectView(resolveLView(el));
  }
  if (runtimeState.ngLViewMap instanceof Map) {
    for (const lv of runtimeState.ngLViewMap.values()) {
      if (isLiveLView(lv)) inspectView(lv);
      if (seenViews.size > 60) break;
    }
  }

  let idx = 0;
  while (idx < queue.length) {
    const cur = queue[idx];
    idx += 1;
    const hit = extractCreditsFromCacheOwner(cur);
    if (hit !== null) return hit;
    if (serviceTokens.some((tok) => cur instanceof tok)) {
      for (const key of [
        "credits",
        "remainingCredits",
        "availableCredits",
        "creditBalance",
      ]) {
        const fn = readOwn(cur, key);
        if (typeof fn === "function") {
          try {
            const val = parseCreditNumber(fn.call(cur));
            if (val !== null) return val;
          } catch {
            // Ignore disposed signals.
          }
        }
      }
    }
    if (
      !Array.isArray(cur) &&
      !(cur instanceof Map) &&
      !(cur instanceof Set) &&
      seen.size < 160
    ) {
      for (const val of Object.values(cur as Record<string, unknown>)) {
        enqueue(val);
      }
    }
  }
  return null;
}

/** Extracts text and accessible labels from `node` after removing composer cost elements. */
function cleanCreditNodeText(node: Element): string {
  if (
    node.matches(IGNORED_CREDIT_SELECTOR) ||
    node.closest(IGNORED_CREDIT_SELECTOR)
  ) {
    return "";
  }
  const aria = `${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""}`.trim();
  if (!node.querySelector(IGNORED_CREDIT_SELECTOR)) {
    return `${aria} ${node.textContent || ""}`.trim();
  }
  const clone = node.cloneNode(true) as Element;
  for (const ignored of clone.querySelectorAll(IGNORED_CREDIT_SELECTOR)) {
    ignored.remove();
  }
  return `${aria} ${clone.textContent || ""}`.trim();
}

/** Reads the account credit balance from cached `CREDITS` queries or account credit labels. */
export function readAccountCredits(): number | null {
  const cached = readCachedCredits();
  if (cached !== null) return cached;

  const explicitNodes = document.querySelectorAll(
    'header, nav, [role="menu"], [role="dialog"], .cdk-overlay-pane, [aria-label*="credit" i], [class*="credit"], body',
  );
  for (const node of explicitNodes) {
    const txt = cleanCreditNodeText(node);
    if (!txt) continue;
    const flowMatch =
      txt.match(/(\d[\d,]*)\s*Google\s+Flow\s+credits\b/i) ||
      txt.match(/\bGoogle\s+Flow\s+credits[\s:–-]*(\d[\d,]*)/i);
    if (flowMatch) {
      const parsed = parseCreditNumber(flowMatch[1]);
      if (parsed !== null) return parsed;
    }
  }

  const headerNodes = document.querySelectorAll(
    'header, nav, [class*="credit"], [aria-label*="credit" i]',
  );
  for (const node of headerNodes) {
    const txt = cleanCreditNodeText(node);
    if (!txt || /\bcost\b/i.test(txt)) continue;
    const credMatch = txt.match(/(\d[\d,]*)\s*(?:AI\s+credits|credits)\b/i);
    if (credMatch) {
      const parsed = parseCreditNumber(credMatch[1]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}
