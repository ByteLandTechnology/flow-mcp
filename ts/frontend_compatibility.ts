// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Check the build and runtime requirements of internal Flow operations.

import { frontendBuild, readBuildLabel } from "./frontend_builds";
import type { AssetTrashFormat, CharacterBioFormat, CollectionWriteFormat, FrontendFormats } from "./frontend_builds";
import { projectWriteChecks } from "./project_store";
import { legacyTile, pickTileUrl } from "./dom";
import { runtimeState } from "./state";
import type { FlowTile, StoreProbeCheck, StoreProbeResult } from "./types";

/** Compatibility failure returned before a request is sent. */
interface UnsupportedFrontend {
  /** False when the operation cannot run. */
  ok: false;
  /** Stable tool error code. */
  error: "unsupported_front_end";
  /** Build label of the active page. */
  build: string | null;
  /** Operation that needs the request format. */
  operation: keyof FrontendFormats;
  /** Build and runtime checks that failed. */
  failed_checks: StoreProbeCheck[];
}

/** Result of checking a build and runtime for an operation. */
type FrontendCompatibility<Format> = { ok: true; format: Format } | UnsupportedFrontend;

/** Adds the known tile-change aliases used by the general project store. */
export function withTileChangeAliases(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.type !== "single_tile" || !payload.Ve) return payload;
  return { ...payload, We: payload.We ?? payload.Ve, df: payload.df ?? payload.Ve };
}

/** Returns the verified format when the build and runtime checks pass. */
function checkOperation<Operation extends keyof FrontendFormats>(
  operation: Operation,
  build: string | null,
  checks: StoreProbeCheck[],
): FrontendCompatibility<FrontendFormats[Operation]> {
  const format = frontendBuild(build)?.operations[operation];
  const failed = checks.filter(({ ok }) => !ok);
  if (format && failed.length === 0) return { ok: true, format };
  if (!format) {
    failed.unshift({
      name: "verified_build",
      ok: false,
      detail: build === null ? "Build label unavailable" : "Build has no verified format for this operation",
    });
  }
  return { ok: false, error: "unsupported_front_end", build, operation, failed_checks: failed };
}

/** Returns the collection format for the active project when its checks pass. */
export function collectionWriteCompatibility(): FrontendCompatibility<CollectionWriteFormat> {
  return checkOperation("collection_write", readBuildLabel(), projectWriteChecks("collection"));
}

/** Returns the personality update format when the project store can submit and confirm it. */
export function characterBioCompatibility(): FrontendCompatibility<CharacterBioFormat> {
  return checkOperation("character_bio", readBuildLabel(), projectWriteChecks("project"));
}

/** Returns the asset trash format when its checks pass. */
export function assetTrashCompatibility(
  tiles: Map<string, FlowTile>,
): FrontendCompatibility<AssetTrashFormat> {
  return checkOperation("asset_trash_store", readBuildLabel(), assetTrashChecks(tiles));
}

/** Counts readable image and video tiles in the first 200 tiles. */
function tileLayout(tiles: Iterable<FlowTile>): StoreProbeCheck {
  let readable = 0;
  let unreadable = 0;
  let seen = 0;
  for (const raw of tiles) {
    if (++seen > 200) break;
    const kind = String(raw?.type ?? "").toUpperCase();
    if (kind !== "IMAGE" && kind !== "VIDEO") continue;
    const tile = legacyTile(raw);
    if (tile.Fb && (tile.Fb.Zc !== undefined || pickTileUrl(tile))) readable++;
    else unreadable++;
  }
  return {
    name: "tile_layout",
    ok: readable > 0 || unreadable === 0,
    detail: readable + unreadable === 0 ? "no media tiles to inspect" :
      `readable=${readable} unreadable=${unreadable}`,
  };
}

/** Checks the bound store and tile layout used by asset trash. */
function assetTrashChecks(tiles: Map<string, FlowTile> | null | undefined): StoreProbeCheck[] {
  const store = runtimeState.store;
  const checks = [
    { name: "store_bound", ok: Boolean(store), detail: store ? "bound" : "not bound" },
    {
      name: "tile_map",
      ok: tiles instanceof Map,
      detail: tiles instanceof Map ? `${tiles.size} tiles` : "missing",
    },
    {
      name: "mutator",
      ok: typeof store?.mutate === "function",
      detail: typeof store?.mutate === "function" ? "present" : "missing",
    },
  ];
  if (tiles instanceof Map) checks.push(tileLayout(tiles.values()));
  return checks;
}

/** Returns the compatibility result without the internal request format. */
function operationStatus(result: FrontendCompatibility<unknown>): {
  ok: boolean;
  failed_checks: StoreProbeCheck[];
} {
  return { ok: result.ok, failed_checks: result.ok ? [] : result.failed_checks };
}

/** Reports the general store checks and compatibility of each managed operation. */
export function probeStore(): StoreProbeResult {
  const build = readBuildLabel();
  const trashChecks = assetTrashChecks(runtimeState.store?.getTileMap());
  const views = runtimeState.ngLViewMap;
  const checks = [
    {
      name: "lview_registry",
      ok: views instanceof Map,
      detail: views ? `${views.size} views` : "not captured",
    },
    ...trashChecks,
  ];
  return {
    build,
    ok: checks.every(({ ok }) => ok),
    checks,
    operations: {
      collection_write: operationStatus(checkOperation("collection_write", build, projectWriteChecks("collection"))),
      character_bio: operationStatus(checkOperation("character_bio", build, projectWriteChecks("project"))),
      asset_trash_store: operationStatus(checkOperation("asset_trash_store", build, trashChecks)),
    },
  };
}
