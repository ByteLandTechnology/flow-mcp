// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Field names in verified builds of the Flow front end.

/** Field names for the collection write requests of one build. */
export interface CollectionWriteFormat {
  /** Tile ID in a single-tile request. */
  tileId: string;
  /** Change in a single-tile request. */
  tileChange: string;
  /** Destination in a collection move request. */
  moveTarget: string;
  /** Tiles in a collection move request. */
  moveTiles: string;
}

/** Field names for the asset trash requests of one build. */
export interface AssetTrashFormat {
  /** Entries in a batch trash request. */
  entries: string;
  /** Trash destination in a batch entry. */
  destination: string;
  /** Workflow IDs in a scene clip deletion request. */
  sceneWorkflows: string;
  /** Clip array on a scene tile. */
  sceneClips: string;
  /** Workflow history map on a scene tile. */
  sceneHistory: string;
}

/** Request formats verified for internal Flow operations. */
export interface FrontendFormats {
  /** Direct collection writes. */
  collection_write: CollectionWriteFormat;
  /** Asset trash through the project store. */
  asset_trash_store: AssetTrashFormat;
  /** Character personality note update. */
  character_bio: CharacterBioFormat;
}

/** Field names for a character personality update. */
export interface CharacterBioFormat {
  /** Character ID in a single-tile request. */
  tileId: string;
  /** Change in a single-tile request. */
  tileChange: string;
  /** Text in a personality change. */
  notes: string;
}

/** Field names for the active project store and its tile query. */
export interface ProjectStoreFormat {
  /** Class of the project shell store. */
  storeClass: string;
  /** Lifecycle controller on the store. */
  lifecycle: string;
  /** Destroyed flag on the lifecycle controller. */
  destroyed: string;
  /** Project ID signal. */
  projectId: string;
  /** Service that owns the tile query and writes. */
  tilesService: string;
  /** Query client on the tile service. */
  queryClient: string;
  /** Project mutation dispatcher. */
  dispatcher: string;
  /** Tile rows in the query result. */
  rows: string;
}

/** Project store format of build 20261117.10. */
const NOVEMBER_17_STORE: ProjectStoreFormat = {
  storeClass: "VN",
  lifecycle: "Ca",
  destroyed: "Wa",
  projectId: "va",
  tilesService: "na",
  queryClient: "Xa",
  dispatcher: "VI",
  rows: "Bb",
};

/** Project store format of build 20261118.14. */
const NOVEMBER_18_STORE: ProjectStoreFormat = {
  storeClass: "jO",
  lifecycle: "Ba",
  destroyed: "Va",
  projectId: "ua",
  tilesService: "ma",
  queryClient: "Wa",
  dispatcher: "sJ",
  rows: "Ab",
};

/** Verified operations and store format of one build. */
interface FrontendBuild {
  /** Layout for the project store. */
  projectStore: ProjectStoreFormat;
  /** Operations with verified request formats. */
  operations: Partial<FrontendFormats>;
}

/** Request formats by exact build label. Include only verified operations. */
const VERIFIED_BUILDS: ReadonlyMap<string, FrontendBuild> = new Map([
  ["boq_labs-ai-sandbox-frontend_20261117.10_p0", {
    projectStore: NOVEMBER_17_STORE,
    operations: {
      collection_write: { tileId: "Uc", tileChange: "df", moveTarget: "Sj", moveTiles: "Bb" },
      asset_trash_store: {
        entries: "Kv",
        destination: "Dm",
        sceneWorkflows: "qg",
        sceneClips: "Tc",
        sceneHistory: "tg",
      },
      character_bio: { tileId: "Uc", tileChange: "df", notes: "mx" },
    },
  }],
  ["boq_labs-ai-sandbox-frontend_20261118.14_p0", {
    projectStore: NOVEMBER_18_STORE,
    operations: { character_bio: { tileId: "Vc", tileChange: "jf", notes: "Jx" } },
  }],
]);

/** Returns the exact label published by the active page. */
export function readBuildLabel(): string | null {
  const label = window.WIZ_global_data?.cfb2h;
  return typeof label === "string" ? label.trim() || null : null;
}

/** Returns the verified formats for an exact build label. */
export function frontendBuild(label: string | null): FrontendBuild | undefined {
  return label === null ? undefined : VERIFIED_BUILDS.get(label);
}

/** Returns the layouts to check when the runtime binds the active project store. */
export function projectStoreFormats(): readonly ProjectStoreFormat[] {
  const format = frontendBuild(readBuildLabel())?.projectStore;
  return format ? [format] : [NOVEMBER_17_STORE, NOVEMBER_18_STORE];
}
