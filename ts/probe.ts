// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read the Google Flow front-end build label and check the bound project store shape.

import { runtimeState } from "./state";
import type { FlowTile, StoreProbeCheck, StoreProbeResult } from "./types";

/** Returns the front-end build label from `WIZ_global_data.cfb2h`, or null when the page does not publish one. */
export function readBuildLabel(): string | null {
  const label = window.WIZ_global_data?.cfb2h;
  if (typeof label !== "string") return null;
  const trimmed = label.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Returns one probe check record. */
function check(name: string, ok: boolean, detail: string): StoreProbeCheck {
  return { name, ok, detail };
}

/** Classifies the media container layout of up to 40 tiles in `tiles`. */
function tileLayout(tiles: Iterable<unknown>): StoreProbeCheck {
  let legacy = 0;
  let current = 0;
  let other = 0;
  let seen = 0;
  for (const raw of tiles) {
    if (++seen > 40) break;
    if (!raw || typeof raw !== "object") continue;
    const t = raw as FlowTile;
    if (t.Eb) current++;
    else if (t.Fb) legacy++;
    else if (t.type === "media" || t.type === "workflow") other++;
  }
  if (current + legacy + other === 0) {
    return check("tile_layout", true, "no media tiles to inspect");
  }
  const detail = `current=${current} legacy=${legacy} unknown=${other}`;
  // A tile without media yet is normal. Fail only when no tile has a known media container.
  return check("tile_layout", current + legacy > 0, detail);
}

/** Reports whether the bound project store has the shape that the runtime expects. It never calls a mutation. */
export function probeStore(): StoreProbeResult {
  const helper = runtimeState.store;
  const checks: StoreProbeCheck[] = [];
  checks.push(
    check(
      "lview_registry",
      runtimeState.ngLViewMap instanceof Map,
      runtimeState.ngLViewMap ? `${runtimeState.ngLViewMap.size} views` : "not captured",
    ),
  );
  checks.push(check("store_bound", Boolean(helper), helper ? "bound" : "not bound"));
  const tileMap = helper?.getTileMap?.();
  checks.push(
    check(
      "tile_map",
      tileMap instanceof Map,
      tileMap instanceof Map ? `${tileMap.size} tiles` : "missing",
    ),
  );
  checks.push(
    check(
      "mutator",
      typeof helper?.mutate === "function",
      typeof helper?.mutate === "function" ? "present" : "missing",
    ),
  );
  if (tileMap instanceof Map) checks.push(tileLayout(tileMap.values()));
  return {
    build: readBuildLabel(),
    ok: checks.every((c) => c.ok),
    checks,
  };
}

/**
 * Check names that a destructive operation needs.
 * The view registry only matters while the runtime discovers the store.
 * The tile layout fails in a project that has only failed generations, and a trash mutation does not read the media container.
 */
const DESTRUCTIVE_CHECKS = new Set(["store_bound", "tile_map", "mutator"]);

/** Returns an `unsupported_front_end` error when the store shape is unknown, or null when a destructive operation may run. */
export function destructiveGate(): {
  ok: false;
  error: string;
  build: string | null;
  failed_checks: StoreProbeCheck[];
} | null {
  const probe = probeStore();
  const failed = probe.checks.filter(
    (c) => DESTRUCTIVE_CHECKS.has(c.name) && !c.ok,
  );
  if (failed.length === 0) return null;
  return {
    ok: false,
    error: "unsupported_front_end",
    build: probe.build,
    failed_checks: failed,
  };
}
