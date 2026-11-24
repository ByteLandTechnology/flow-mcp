// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Discover live Angular stores, tile caches, and character preview panels by runtime structure.

import { isNgLViewMap, readOwn, resolveLView } from "./angular";
import { legacyMedia } from "./dom";
import {
  frontendBuild,
  NOVEMBER_20_CHARACTER_PREVIEW,
  readBuildLabel,
  type CharacterPreviewFormat,
  type ProjectStoreFormat,
} from "./frontend_builds";
import type { FlowMediaPayload, FlowTile, NgLView } from "./types";

/** Lifecycle field pair and active status on an Angular service or component. */
export interface LifecycleShape {
  /** Property name of the lifecycle controller on the owner object. */
  lifecycle: string;
  /** Property name of the boolean destroyed flag on the lifecycle controller. */
  destroyed: string;
  /** True when the lifecycle controller is active and not destroyed. */
  active: boolean;
}

/** Candidate project store binding discovered in Angular views. */
export interface DiscoveredStoreCandidate {
  /** Project ID matched on the store signal. */
  projectId: string;
  /** Store service object. */
  service: object;
  /** Inferred or verified field names on the store and tile query. */
  format: ProjectStoreFormat;
  /** Angular view registry map that holds the store. */
  views: Map<number, NgLView>;
}

/** Structural discovery result across all Angular view maps. */
export interface StoreDiscoveryOutcome {
  /** Validated unique candidates. */
  candidates: DiscoveredStoreCandidate[];
  /** True when structural probing found ambiguous inner fields on an active store. */
  ambiguousInner: boolean;
}

/** Character slot name in the character editor preview panel. */
export type PreviewSlotName = "portrait" | "body";

/** Bound character preview panel operations. */
export interface BoundCharacterPreview {
  /** Opens the native file chooser for the active slot when uniquely identified. */
  upload: (() => unknown) | null;
  /** Reads the media payload of the requested slot. */
  media: (slot: PreviewSlotName) => FlowMediaPayload | null | undefined;
  /** Reads the active preview image URL. */
  source: () => unknown;
  /** Reads whether the preview panel is busy. */
  busy: () => unknown;
}

/** Known lifecycle field pairs from earlier Flow builds. */
const KNOWN_LIFECYCLE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["Ba", "Va"],
  ["Ca", "Va"],
  ["Ca", "Wa"],
  ["Ba", "Wa"],
];

/** Legacy character preview field names used before build 20261120.00. */
const LEGACY_CHARACTER_PREVIEW: CharacterPreviewFormat = {
  lifecycle: "Ca",
  upload: "JR",
  marker: "Si",
  portrait: "ka",
  body: "ma",
  source: "psa",
  busy: "zy",
};

/** Mutation literal markers that identify the project tile dispatcher method. */
const DISPATCHER_MARKERS = [
  "create_collection",
  "set_display_name",
  "single_tile",
  "batch_move_to_collection",
  "batch_set_tiles_trashed",
  "create_scene",
  "add_workflows_to_scene",
];

/** Returns true when `value` is a plain or class instance object suitable for structural inspection. */
function isInspectableObject(value: unknown): value is object {
  return Boolean(
    value &&
      typeof value === "object" &&
      !(value instanceof Node) &&
      !Array.isArray(value) &&
      !(value instanceof Map) &&
      !(value instanceof Set) &&
      !(value instanceof Date) &&
      !(value instanceof RegExp),
  );
}

/** Reads `Function.prototype.toString` safely without throwing on bound or host functions. */
export function safeFnSource(fn: unknown): string {
  if (typeof fn !== "function") return "";
  try {
    return Function.prototype.toString.call(fn);
  } catch {
    return "";
  }
}

/** Finds the lifecycle controller and boolean destroyed flag on an Angular object. */
export function findLifecycleFields(owner: unknown): LifecycleShape | null {
  if (!isInspectableObject(owner)) return null;
  for (const [lifecycle, destroyed] of KNOWN_LIFECYCLE_PAIRS) {
    const ctrl = readOwn(owner, lifecycle);
    if (!isInspectableObject(ctrl)) continue;
    const flag = readOwn(ctrl, destroyed);
    if (typeof flag === "boolean") {
      return { lifecycle, destroyed, active: !flag };
    }
  }
  const matches: LifecycleShape[] = [];
  for (const key of Object.keys(owner).slice(0, 40)) {
    const ctrl = readOwn(owner, key);
    if (!isInspectableObject(ctrl)) continue;
    const onDestroy = readOwn(ctrl, "onDestroy");
    if (typeof onDestroy !== "function") continue;
    const boolKeys = Object.keys(ctrl).filter(
      (k) => typeof readOwn(ctrl, k) === "boolean",
    );
    if (boolKeys.some((k) => readOwn(ctrl, k) === true)) {
      return { lifecycle: key, destroyed: boolKeys[0] ?? "destroyed", active: false };
    }
    if (boolKeys.length === 1) {
      matches.push({ lifecycle: key, destroyed: boolKeys[0], active: true });
      continue;
    }
    const src = safeFnSource(onDestroy);
    const referenced = boolKeys.filter((k) =>
      new RegExp(`\\.${k.replace(/\$/g, "\\$")}\\b`).test(src),
    );
    if (referenced.length === 1) {
      matches.push({ lifecycle: key, destroyed: referenced[0], active: true });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/** Returns true when an Angular service or component lifecycle reports a destroyed instance. */
export function isComponentDestroyed(owner: unknown): boolean {
  if (!isInspectableObject(owner)) return true;
  for (const [lifecycle, destroyed] of KNOWN_LIFECYCLE_PAIRS) {
    if (readOwn(readOwn(owner, lifecycle), destroyed) === true) return true;
    for (const nestedKey of ["_ap", "ha"]) {
      if (readOwn(readOwn(readOwn(owner, nestedKey), lifecycle), destroyed) === true) {
        return true;
      }
    }
  }
  const shape = findLifecycleFields(owner);
  return shape !== null && !shape.active;
}

/** Returns true when `key` matches `["PROJECT_TILES", projectId]` or starts with `"PROJECT_TILES"`. */
function matchesProjectTilesKey(key: unknown, projectId: string | null): boolean {
  if (!Array.isArray(key) || key[0] !== "PROJECT_TILES") return false;
  return projectId === null ? key.length >= 1 : key.length === 2 && key[1] === projectId;
}

/** Returns true when `rows` is an array of valid Flow tile objects with unique IDs. */
export function isValidTileRowArray(rows: unknown): rows is FlowTile[] {
  if (!Array.isArray(rows)) return false;
  const seenIds = new Set<string>();
  for (const item of rows) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as { id?: unknown }).id !== "string" ||
      !(item as { id: string }).id ||
      typeof (item as { type?: unknown }).type !== "string"
    ) {
      return false;
    }
    const id = (item as { id: string }).id;
    if (seenIds.has(id)) return false;
    seenIds.add(id);
  }
  return true;
}

/** Inspects a query data payload to find the unique own property holding tile rows. */
function findUniqueRowsField(
  data: unknown,
): { field: string } | { ambiguous: boolean } {
  if (isValidTileRowArray(data)) return { field: "__self__" };
  if (data instanceof Map && isValidTileRowArray([...data.values()])) {
    return { field: "__map__" };
  }
  if (!isInspectableObject(data)) return { ambiguous: false };
  const nonEmpty: string[] = [];
  const empty: string[] = [];
  for (const key of Object.keys(data)) {
    const val = readOwn(data, key);
    if (!isValidTileRowArray(val)) continue;
    if (val.length > 0) nonEmpty.push(key);
    else empty.push(key);
  }
  if (nonEmpty.length === 1) return { field: nonEmpty[0] };
  if (nonEmpty.length > 1) return { ambiguous: true };
  if (empty.length === 1) return { field: empty[0] };
  return { ambiguous: empty.length > 1 };
}

/** Finds dispatcher methods on a tile service object by source markers and arity. */
function findDispatcherMethods(tilesService: object): string[] {
  const names = new Set<string>();
  let cur: object | null = tilesService;
  for (let depth = 0; cur && cur !== Object.prototype && depth < 4; depth++) {
    for (const key of Object.getOwnPropertyNames(cur)) {
      if (key === "constructor" || key === "queryKey") continue;
      const fn = readOwn(tilesService, key);
      if (typeof fn !== "function") continue;
      const src = safeFnSource(fn);
      if (
        src.includes("PROJECT_TILES") &&
        DISPATCHER_MARKERS.some((marker) => src.includes(marker))
      ) {
        names.add(key);
      }
    }
    cur = Object.getPrototypeOf(cur);
  }
  return [...names];
}

/** Probes one object for the tile query service layout (`queryClient`, `rows`, `dispatcher`). */
export function inspectTilesServiceShape(
  tiles: unknown,
  projectId: string | null,
): {
  queryClient: string;
  rows: string;
  dispatcher: string;
  ambiguousDispatcher: boolean;
} | { ambiguous: true } | null {
  if (!isInspectableObject(tiles)) return null;
  const queryKeyFn = readOwn(tiles, "queryKey");
  if (typeof queryKeyFn !== "function") return null;
  let key: unknown;
  try {
    key = queryKeyFn.call(tiles, projectId);
  } catch {
    return null;
  }
  if (!matchesProjectTilesKey(key, projectId)) return null;

  const clientMatches: Array<{ queryClient: string; rows: string }> = [];
  let sawAmbiguousRows = false;
  for (const prop of Object.keys(tiles).slice(0, 40)) {
    const client = readOwn(tiles, prop);
    const cache = readOwn(client, "queryCache");
    const find = readOwn(cache, "find");
    if (typeof find !== "function") continue;
    let query: { queryKey?: unknown; state?: { status?: string; data?: unknown }; fetch?: unknown } | undefined;
    try {
      query = find.call(cache, { queryKey: key, exact: true }) as typeof query;
    } catch {
      continue;
    }
    if (
      !query ||
      !matchesProjectTilesKey(query.queryKey, projectId) ||
      !query.state ||
      query.state.status === "pending"
    ) {
      continue;
    }
    const rowsRes = findUniqueRowsField(query.state.data);
    if ("field" in rowsRes) {
      clientMatches.push({ queryClient: prop, rows: rowsRes.field });
    } else if (rowsRes.ambiguous) {
      sawAmbiguousRows = true;
    }
  }
  if (sawAmbiguousRows || clientMatches.length > 1) return { ambiguous: true };
  if (clientMatches.length === 0) return null;

  const dispatchers = findDispatcherMethods(tiles);
  return {
    queryClient: clientMatches[0].queryClient,
    rows: clientMatches[0].rows,
    dispatcher: dispatchers.length === 1 ? dispatchers[0] : "",
    ambiguousDispatcher: dispatchers.length > 1,
  };
}

/** Probes one Angular object to determine whether it is a live project shell store for `projectId`. */
function probeStoreObject(
  service: object,
  projectId: string,
): { format: ProjectStoreFormat } | { ambiguous: true } | null {
  const life = findLifecycleFields(service);
  if (!life || !life.active) return null;

  const projectGetters: string[] = [];
  const tileServices: Array<{
    tilesService: string;
    queryClient: string;
    rows: string;
    dispatcher: string;
  }> = [];

  for (const key of Object.keys(service).slice(0, 50)) {
    if (key === life.lifecycle) continue;
    const val = Object.getOwnPropertyDescriptor(service, key)?.value;
    if (typeof val === "function" && val.length === 0) {
      try {
        if (val.call(service) === projectId) projectGetters.push(key);
      } catch {
        // Ignore throwing signal or getter.
      }
      continue;
    }
    const tilesShape = inspectTilesServiceShape(val, projectId);
    if (!tilesShape) continue;
    if ("ambiguous" in tilesShape || tilesShape.ambiguousDispatcher) {
      return { ambiguous: true };
    }
    tileServices.push({
      tilesService: key,
      queryClient: tilesShape.queryClient,
      rows: tilesShape.rows,
      dispatcher: tilesShape.dispatcher,
    });
  }

  if (tileServices.length === 0 || projectGetters.length === 0) return null;
  if (tileServices.length > 1 || projectGetters.length > 1) {
    return { ambiguous: true };
  }

  const tiles = tileServices[0];
  const ctorName =
    typeof (service as { constructor?: { name?: unknown } }).constructor?.name === "string"
      ? ((service as { constructor: { name: string } }).constructor.name || "DiscoveredStore")
      : "DiscoveredStore";
  return {
    format: {
      storeClass: ctorName,
      lifecycle: life.lifecycle,
      destroyed: life.destroyed,
      projectId: projectGetters[0],
      tilesService: tiles.tilesService,
      queryClient: tiles.queryClient,
      dispatcher: tiles.dispatcher,
      rows: tiles.rows,
    },
  };
}

/** Discovers live project store candidates by runtime structure across Angular view maps. */
export function discoverProjectStoreCandidates(
  maps: unknown[],
  projectId: string,
): StoreDiscoveryOutcome {
  const seen = new Set<object>();
  const candidates: DiscoveredStoreCandidate[] = [];
  let ambiguousInner = false;

  const consider = (value: unknown, views: Map<number, NgLView>): void => {
    if (!isInspectableObject(value) || seen.has(value)) return;
    seen.add(value);
    const probed = probeStoreObject(value, projectId);
    if (!probed) return;
    if ("ambiguous" in probed) {
      ambiguousInner = true;
      return;
    }
    candidates.push({
      projectId,
      service: value,
      format: probed.format,
      views,
    });
  };

  for (const map of maps) {
    if (!isNgLViewMap(map)) continue;
    for (const view of map.values()) {
      if (!Array.isArray(view)) continue;
      for (const slot of view) {
        consider(slot, map);
        if (!isInspectableObject(slot)) continue;
        for (const key of Object.keys(slot).slice(0, 40)) {
          consider(Object.getOwnPropertyDescriptor(slot, key)?.value, map);
        }
      }
    }
  }
  return { candidates, ambiguousInner };
}

/** Discovers a query-cache tile store handle inside a single Angular LView for `discoverStore`. */
export function discoverQueryTileServiceInLView(
  lv: unknown,
  projectId: string | null,
): {
  owner: object;
  tilesService: object;
  queryClient: string;
  rows: string;
  dispatcher: string;
} | null {
  if (!Array.isArray(lv) || !projectId) return null;
  const checkCandidate = (cand: unknown) => {
    if (!isInspectableObject(cand) || isComponentDestroyed(cand)) return null;
    const direct = inspectTilesServiceShape(cand, projectId);
    if (direct && !("ambiguous" in direct) && !direct.ambiguousDispatcher) {
      return {
        owner: cand,
        tilesService: cand,
        queryClient: direct.queryClient,
        rows: direct.rows,
        dispatcher: direct.dispatcher,
      };
    }
    const storeProbe = probeStoreObject(cand, projectId);
    if (storeProbe && !("ambiguous" in storeProbe)) {
      const tiles = readOwn(cand, storeProbe.format.tilesService);
      if (isInspectableObject(tiles)) {
        return {
          owner: cand,
          tilesService: tiles,
          queryClient: storeProbe.format.queryClient,
          rows: storeProbe.format.rows,
          dispatcher: storeProbe.format.dispatcher,
        };
      }
    }
    return null;
  };

  for (const slot of lv) {
    const hit = checkCandidate(slot);
    if (hit) return hit;
    if (!isInspectableObject(slot)) continue;
    for (const key of Object.keys(slot).slice(0, 30)) {
      const nested = checkCandidate(Object.getOwnPropertyDescriptor(slot, key)?.value);
      if (nested) return nested;
    }
  }
  return null;
}

/** Reads tile rows from a structurally discovered query-cache tile service. */
export function readRowsFromQueryTileService(
  tilesService: object,
  queryClientKey: string,
  rowsKey: string,
  projectId: string | null,
): Map<string, FlowTile> | null {
  const queryKeyFn = readOwn(tilesService, "queryKey");
  const cache = readOwn(readOwn(tilesService, queryClientKey), "queryCache");
  const find = readOwn(cache, "find");
  if (typeof queryKeyFn !== "function" || typeof find !== "function") return null;
  try {
    const key: unknown = queryKeyFn.call(tilesService, projectId);
    const query = find.call(cache, { queryKey: key, exact: true }) as {
      state?: { status?: string; data?: unknown };
    } | undefined;
    if (!query?.state || query.state.status === "pending") return null;
    const rawData = query.state.data;
    const rows =
      rowsKey === "__self__"
        ? rawData
        : rowsKey === "__map__"
          ? rawData instanceof Map
            ? [...rawData.values()]
            : null
          : readOwn(rawData, rowsKey);
    if (!Array.isArray(rows)) return null;
    const map = new Map<string, FlowTile>();
    for (const row of rows) {
      if (row && typeof row === "object" && (row as { id?: unknown }).id != null) {
        map.set(String((row as { id: unknown }).id), row as FlowTile);
      }
    }
    return map;
  } catch {
    return null;
  }
}

/** Calls a zero-argument method or signal on `panel` safely. */
function callZeroArg(panel: object, name: string): unknown {
  if (!name) return undefined;
  const fn = readOwn(panel, name);
  if (typeof fn !== "function") return undefined;
  try {
    return fn.call(panel);
  } catch {
    return undefined;
  }
}

/** Binds a character preview panel using a static `CharacterPreviewFormat` if all members exist. */
function tryStaticPreviewFormat(
  slot: object,
  format: CharacterPreviewFormat,
): BoundCharacterPreview | null {
  if (isComponentDestroyed(slot)) return null;
  if (
    typeof readOwn(slot, format.upload) !== "function" ||
    typeof readOwn(slot, format.marker) !== "function" ||
    typeof readOwn(slot, format.portrait) !== "function" ||
    typeof readOwn(slot, format.body) !== "function"
  ) {
    return null;
  }
  return {
    upload: () => callZeroArg(slot, format.upload),
    media: (which) =>
      legacyMedia(callZeroArg(slot, format[which]) as FlowMediaPayload | null | undefined),
    source: () => callZeroArg(slot, format.source),
    busy: () => callZeroArg(slot, format.busy),
  };
}

/** Returns true when `value` looks like a character slot media record or an empty slot value. */
function isMediaOrEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return Boolean(
    isInspectableObject(value) &&
      typeof (value as { id?: unknown }).id === "string" &&
      (value as { id: string }).id.length > 0,
  );
}

/** Structurally inspects a character preview component to bind its signals and upload method. */
function probeCharacterPreviewComponent(
  comp: object,
  renderedImgSrc: string,
  activeSlot: PreviewSlotName,
): BoundCharacterPreview | "ambiguous" | null {
  if (!isInspectableObject(comp) || isComponentDestroyed(comp)) return null;
  const proto = Object.getPrototypeOf(comp) as object | null;
  if (!proto || proto === Object.prototype) return null;

  const uploadMethods: string[] = [];
  let protoCombinedSrc = "";
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor") continue;
    const fn = readOwn(comp, name);
    if (typeof fn !== "function") continue;
    const src = safeFnSource(fn);
    protoCombinedSrc += `\n${src}`;
    if (
      fn.length === 0 &&
      (/createElement\s*\(\s*["']input["']\)/i.test(src) ||
        /\.type\s*=\s*["']file["']/i.test(src) ||
        (/\.click\s*\(\s*\)/.test(src) && /accept|file|upload|consent/i.test(src)))
    ) {
      uploadMethods.push(name);
    }
  }

  const zeroArgOwn = Object.keys(comp).filter((k) => {
    const fn = Object.getOwnPropertyDescriptor(comp, k)?.value;
    return typeof fn === "function" && fn.length === 0;
  });
  if (zeroArgOwn.length < 2 && uploadMethods.length === 0) return null;

  const signalValues = new Map<string, unknown>();
  for (const key of zeroArgOwn) {
    signalValues.set(key, callZeroArg(comp, key));
  }

  // Infer portrait and body signals from `ka`/`ma`, prototype slot branches, or media payloads.
  let portraitKey = "";
  let bodyKey = "";
  if (
    signalValues.has("ka") &&
    signalValues.has("ma") &&
    isMediaOrEmpty(signalValues.get("ka")) &&
    isMediaOrEmpty(signalValues.get("ma"))
  ) {
    portraitKey = "ka";
    bodyKey = "ma";
  } else {
    const branchMatch =
      /portrait[^?;:]*\?\s*this\.([A-Za-z0-9_$]+)\(\)\s*:\s*this\.([A-Za-z0-9_$]+)\(\)/i.exec(
        protoCombinedSrc,
      ) ||
      /body[^?;:]*\?\s*this\.([A-Za-z0-9_$]+)\(\)\s*:\s*this\.([A-Za-z0-9_$]+)\(\)/i.exec(
        protoCombinedSrc,
      );
    if (branchMatch) {
      const isBodyFirst = /^body/i.test(branchMatch[0]);
      const first = branchMatch[1];
      const second = branchMatch[2];
      if (
        signalValues.has(first) &&
        signalValues.has(second) &&
        isMediaOrEmpty(signalValues.get(first)) &&
        isMediaOrEmpty(signalValues.get(second))
      ) {
        portraitKey = isBodyFirst ? second : first;
        bodyKey = isBodyFirst ? first : second;
      }
    }
    if (!portraitKey || !bodyKey) {
      const mediaSignals = zeroArgOwn.filter((k) => {
        const v = signalValues.get(k);
        return isInspectableObject(v) && typeof (v as { id?: unknown }).id === "string";
      });
      if (mediaSignals.length === 1) {
        if (activeSlot === "portrait") portraitKey = mediaSignals[0];
        else bodyKey = mediaSignals[0];
      }
    }
  }

  // Infer source URL signal and busy boolean signal.
  const stringSignals = zeroArgOwn.filter((k) => {
    const v = signalValues.get(k);
    return (
      typeof v === "string" &&
      (renderedImgSrc ? v === renderedImgSrc : /^(?:https?:|blob:|data:|$)/.test(v))
    );
  });
  const sourceKey =
    (renderedImgSrc
      ? stringSignals.find((k) => signalValues.get(k) === renderedImgSrc)
      : stringSignals.find((k) => /^https?:|^blob:|^data:/.test(String(signalValues.get(k))))) ?? "";

  const boolSignals = zeroArgOwn.filter((k) => typeof signalValues.get(k) === "boolean");
  const busyKey = boolSignals.length === 1 ? boolSignals[0] : "";

  if (uploadMethods.length === 0 && !portraitKey && !bodyKey && !sourceKey) {
    return null;
  }
  if (uploadMethods.length > 1) return "ambiguous";

  const uploadFn = uploadMethods.length === 1 ? () => callZeroArg(comp, uploadMethods[0]) : null;
  return {
    upload: uploadFn,
    media: (which) => {
      const key = which === "portrait" ? portraitKey : bodyKey;
      return legacyMedia(
        (key ? callZeroArg(comp, key) : undefined) as FlowMediaPayload | null | undefined,
      );
    },
    source: () => (sourceKey ? callZeroArg(comp, sourceKey) : ""),
    busy: () => (busyKey ? callZeroArg(comp, busyKey) : false),
  };
}

/** Discovers the character preview panel in Angular LViews by verified or runtime structure. */
export function discoverCharacterPreview(
  roots: Iterable<Element>,
  renderedImgSrc: string,
  activeSlot: PreviewSlotName,
): BoundCharacterPreview | null {
  const verified = frontendBuild(readBuildLabel())?.characterPreview;
  const staticFormats = verified
    ? [verified]
    : [NOVEMBER_20_CHARACTER_PREVIEW, LEGACY_CHARACTER_PREVIEW];

  const seenLViews = new Set<unknown>();
  const seenObjects = new Set<object>();
  const structuralMatches: BoundCharacterPreview[] = [];
  let sawAmbiguous = false;

  for (const root of roots) {
    const startLv = resolveLView(root);
    if (!Array.isArray(startLv)) continue;
    const queue: Array<[NgLView, number]> = [[startLv, 0]];
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      const [lv, depth] = next;
      if (!Array.isArray(lv) || seenLViews.has(lv)) continue;
      seenLViews.add(lv);
      for (const slot of lv) {
        if (!isInspectableObject(slot) || seenObjects.has(slot)) continue;
        seenObjects.add(slot);
        for (const fmt of staticFormats) {
          const bound = tryStaticPreviewFormat(slot, fmt);
          if (bound) return bound;
        }
        const probed = probeCharacterPreviewComponent(slot, renderedImgSrc, activeSlot);
        if (probed === "ambiguous") {
          sawAmbiguous = true;
        } else if (probed) {
          structuralMatches.push(probed);
        }
      }
      if (depth < 4) {
        if (Array.isArray(lv[3])) queue.push([lv[3], depth + 1]);
        if (Array.isArray(lv[15])) queue.push([lv[15], depth + 1]);
      }
    }
  }

  if (sawAmbiguous) return null;
  if (structuralMatches.length === 1) return structuralMatches[0];
  const withUpload = structuralMatches.filter((m) => m.upload !== null);
  if (withUpload.length === 1) return withUpload[0];
  return null;
}
