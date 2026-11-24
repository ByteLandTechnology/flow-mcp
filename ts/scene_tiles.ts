// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read clips and workflow history from the native scene tile.

import { readOwn } from "./angular";
import { frontendBuild, readBuildLabel } from "./frontend_builds";
import type { FlowMediaPayload, FlowTile, SceneClipItem } from "./types";

/** Returns true when `value` is a non-empty or valid array of scene clip descriptors. */
function isSceneClipArray(value: unknown): value is SceneClipItem[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (item) =>
      Boolean(item && typeof item === "object" && !Array.isArray(item)) &&
      (typeof (item as SceneClipItem).workflowId === "string" ||
        typeof (item as SceneClipItem).workflowId === "number"),
  );
}

/** Returns true when `value` is a media payload array inside a scene workflow history map. */
function isHistoryMediaList(value: unknown): value is FlowMediaPayload[] {
  return (
    Array.isArray(value) &&
    value.every(
      (m) =>
        Boolean(m && typeof m === "object" && !Array.isArray(m)) &&
        ("id" in m || "Wb" in m || "fifeUrl" in m || "videoUrl" in m || "Bd" in m || "url" in m),
    )
  );
}

/** Collects own values on `tile` and one-level nested plain containers for structural scene probing. */
function sceneCandidateValues(tile: FlowTile): unknown[] {
  const out: unknown[] = [];
  for (const val of Object.values(tile as Record<string, unknown>)) {
    out.push(val);
    if (
      val &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      !(val instanceof Map) &&
      !(val instanceof Date)
    ) {
      for (const sub of Object.values(val as Record<string, unknown>)) out.push(sub);
    }
  }
  return out;
}

/** Infers the clip list of a scene tile from verified, known, or live object fields. */
function findSceneClips(tile: FlowTile, verifiedKey?: string): SceneClipItem[] {
  if (verifiedKey) {
    const direct = readOwn(tile, verifiedKey);
    if (Array.isArray(direct)) return direct as SceneClipItem[];
  }
  const candidates = sceneCandidateValues(tile);
  const nonEmpty = candidates.filter(
    (val): val is SceneClipItem[] => isSceneClipArray(val) && val.length > 0,
  );
  if (nonEmpty.length === 1) return nonEmpty[0];
  for (const key of ["Uc", "Tc", "Oc"]) {
    const known = readOwn(tile, key);
    if (isSceneClipArray(known)) return known;
  }
  const emptyArrays = candidates.filter(
    (v): v is SceneClipItem[] => Array.isArray(v) && v.length === 0,
  );
  return emptyArrays.length === 1 ? emptyArrays[0] : [];
}

/** Infers the workflow history map of a scene tile from verified, known, or live object fields. */
function findSceneHistory(
  tile: FlowTile,
  clips: readonly SceneClipItem[],
  verifiedKey?: string,
): Map<string, FlowMediaPayload[]> {
  const toMap = (candidate: unknown): Map<string, FlowMediaPayload[]> | null => {
    if (candidate instanceof Map) {
      const entries = [...candidate.entries()];
      if (
        entries.every(
          ([k, v]) => (typeof k === "string" || typeof k === "number") && isHistoryMediaList(v),
        )
      ) {
        return new Map(entries.map(([k, v]) => [String(k), v]));
      }
      return null;
    }
    if (
      candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      !(candidate instanceof Date)
    ) {
      const entries = Object.entries(candidate as Record<string, unknown>);
      if (entries.length > 0 && entries.every(([, v]) => isHistoryMediaList(v))) {
        return new Map(entries.map(([k, v]) => [k, v as FlowMediaPayload[]]));
      }
    }
    return null;
  };

  if (verifiedKey) {
    const direct = toMap(readOwn(tile, verifiedKey));
    if (direct) return direct;
  }
  const wfSet = new Set(clips.map((c) => String(c.workflowId ?? "")).filter(Boolean));
  const nonEmptyMaps: Map<string, FlowMediaPayload[]>[] = [];
  const emptyMaps: Map<string, FlowMediaPayload[]>[] = [];
  for (const val of sceneCandidateValues(tile)) {
    const parsed = toMap(val);
    if (!parsed) continue;
    if (parsed.size > 0) nonEmptyMaps.push(parsed);
    else emptyMaps.push(parsed);
  }
  if (nonEmptyMaps.length === 1) return nonEmptyMaps[0];
  if (nonEmptyMaps.length > 1 && wfSet.size > 0) {
    const matching = nonEmptyMaps.filter((m) => [...wfSet].some((id) => m.has(id)));
    if (matching.length === 1) return matching[0];
  }
  for (const key of ["Cg", "tg", "Yf"]) {
    const known = toMap(readOwn(tile, key));
    if (known) return known;
  }
  return emptyMaps.length === 1 ? emptyMaps[0] : new Map();
}

/** Returns the clip list and history of a scene in the active build. */
export function sceneContents(tile: FlowTile) {
  if (!tile || typeof tile !== "object") {
    return { clips: [] as SceneClipItem[], history: new Map<string, FlowMediaPayload[]>() };
  }
  const format = frontendBuild(readBuildLabel())?.projectStore.scene;
  const clips = findSceneClips(tile, format?.clips);
  const history = findSceneHistory(tile, clips, format?.history);
  return { clips, history };
}
