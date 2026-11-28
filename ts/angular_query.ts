// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read Angular QueryCache entries and router navigation state from live Ivy trees.

import {
  ANGULAR_SHELL_SELECTOR,
  findInAngular,
  findRouter,
  isPlainRecord,
  readOwn,
  withLViewMapCapture,
} from "./angular";
import { hoverProbe } from "./dom";
import { runtimeState } from "./state";
import type {
  AngularQueryCache,
  AngularQueryClient,
  AngularQueryEntry,
} from "./types";

/** Returns `true` when `cand` is a non-DOM object holding a `find` function. */
function hasQueryFind(cand: unknown): cand is AngularQueryCache {
  return isPlainRecord(cand) && typeof readOwn(cand, "find") === "function";
}

/** Returns `true` when `cand` matches Angular's standalone `QueryCache` shape. */
function isAngularQueryCache(cand: unknown): cand is AngularQueryCache {
  return (
    hasQueryFind(cand) &&
    (typeof readOwn(cand, "getAll") === "function" ||
      readOwn(cand, "queries") instanceof Map)
  );
}

/** Searches Angular injectors and LViews for the live `QueryClient` or `QueryCache`. */
export function findQueryCache(): AngularQueryCache | null {
  const clientOrCache = findInAngular(
    (cand): cand is AngularQueryClient | AngularQueryCache => {
      if (isAngularQueryCache(cand)) return true;
      if (!cand || typeof cand !== "object" || cand instanceof Node) {
        return false;
      }
      return hasQueryFind(readOwn(cand, "queryCache"));
    },
  );
  if (!clientOrCache) return null;
  const nested = readOwn(clientOrCache, "queryCache");
  return hasQueryFind(nested) ? nested : (clientOrCache as AngularQueryCache);
}

/** Resolves Angular's `QueryCache`, capturing `ngLViewMap` once if numeric contexts are unbound. */
export async function ensureAngularQueryCache(): Promise<AngularQueryCache | null> {
  const direct = findQueryCache();
  if (direct) return direct;
  if (!(runtimeState.ngLViewMap instanceof Map)) {
    const hasNumericContext = Array.from(
      document.querySelectorAll(ANGULAR_SHELL_SELECTOR),
    ).some((el) => typeof readOwn(el, "__ngContext__") === "number");
    if (hasNumericContext) {
      await withLViewMapCapture(async () => {
        const targets = Array.from(
          document.querySelectorAll(
            "[mattooltip], [cdkoverlayorigin], button[aria-label], button, a[href]",
          ),
        );
        if (targets.length > 0) {
          await hoverProbe(targets.slice(0, 8), 20);
        }
      });
    }
  }
  return findQueryCache();
}

/** Returns `true` when any DOM host on the page carries an Angular Ivy `__ngContext__`. */
export function hasAngularContext(): boolean {
  if (
    runtimeState.ngLViewMap instanceof Map &&
    runtimeState.ngLViewMap.size > 0
  ) {
    return true;
  }
  for (const el of document.querySelectorAll(ANGULAR_SHELL_SELECTOR)) {
    if (readOwn(el, "__ngContext__") !== undefined) return true;
  }
  const all = document.querySelectorAll("*");
  const limit = Math.min(all.length, 200);
  for (let i = 0; i < limit; i += 1) {
    if ("__ngContext__" in all[i]) return true;
  }
  return false;
}

/** Returns `true` when Angular's `Router` has an active navigation in flight. */
export function isRouterNavigating(): boolean {
  const router = findRouter();
  if (!router) return false;
  for (const key of ["currentNavigation", "getCurrentNavigation"]) {
    const fn = readOwn(router, key);
    if (typeof fn === "function") {
      try {
        if (fn.call(router) != null) return true;
      } catch {
        // Ignore router accessor errors.
      }
    }
  }
  return readOwn(router, "navigating") === true;
}

/** Reads a cached query entry matching `queryKey` from `cache`. */
export function readQueryCacheEntry(
  cache: AngularQueryCache | null,
  queryKey: readonly unknown[],
): AngularQueryEntry | undefined {
  if (!cache) return undefined;
  if (typeof cache.find === "function") {
    try {
      const hit = cache.find({ queryKey, exact: true });
      if (hit) return hit;
    } catch {
      // Fall through to hash or list lookup.
    }
  }
  const hash = JSON.stringify(queryKey);
  if (typeof cache.get === "function") {
    try {
      const hit = cache.get(hash);
      if (hit) return hit;
    } catch {
      // Fall through to map or list lookup.
    }
  }
  if (cache.queries instanceof Map) {
    const hit = cache.queries.get(hash);
    if (hit) return hit;
  }
  if (typeof cache.getAll === "function") {
    try {
      for (const entry of cache.getAll()) {
        if (
          entry?.queryHash === hash ||
          JSON.stringify(entry?.queryKey) === hash
        ) {
          return entry;
        }
      }
    } catch {
      // Ignore concurrent cache iteration errors.
    }
  }
  return undefined;
}
