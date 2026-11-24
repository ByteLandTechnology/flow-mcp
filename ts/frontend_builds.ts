// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Field names in verified builds of the Flow front end.

import type { AgentAttachmentExport } from "./agent_attachments";
import type { AgentExport } from "./agent_protocol";
import type { AgentWireFormat } from "./agent_wire";
import type { AgentSettingsExport } from "./agent_settings_protocol";
import type { MediaUploadExport } from "./project_upload";

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
  /** Collection IDs in a verified deletion request. */
  deleteCollections?: string;
}

/** Field names for the asset trash requests of one build. */
export interface AssetTrashFormat {
  /** Entries in a batch trash request. */
  entries: string;
  /** Tile in a batch trash entry. */
  tile: string;
  /** Trash flag in a batch entry. */
  trashed: string;
  /** Timestamp in the batch request. */
  date: string;
  /** Trash destination in a batch entry. */
  destination: string;
  /** Workflow IDs in a scene clip deletion request. */
  sceneWorkflows: string;
}

/** Request formats verified for internal Flow operations. */
export interface FrontendFormats {
  /** Direct Flow Agent session and turn operations. */
  agent_chat: AgentChatFormat;
  /** Agent references and local media uploads. */
  agent_attachments: AgentAttachmentFormat;
  /** Local media uploads to a project library. */
  project_upload: ProjectUploadFormat;
  /** Project-level Agent preferences and memory. */
  agent_settings: AgentSettingsFormat;
  /** Direct collection writes. */
  collection_write: CollectionWriteFormat;
  /** Asset trash through the project store. */
  asset_trash_store: AssetTrashFormat;
  /** Character personality note update. */
  character_bio: CharacterBioFormat;
}

/** Managed operations that every verified Flow build must cover. */
export const FRONTEND_OPERATIONS = [
  "agent_chat",
  "agent_attachments",
  "agent_settings",
  "project_upload",
  "collection_write",
  "character_bio",
  "asset_trash_store",
] as const satisfies readonly (keyof FrontendFormats)[];

/** Browser exports required for native Agent settings requests. */
export const AGENT_SETTINGS_EXPORTS = [
  "projectService",
  "projectKey",
  "modelService",
  "modelKey",
  "fetchModels",
  "serviceTier",
  "locale",
  "modelOptions",
  "defaultModel",
  "selectModel",
  "aspectLabels",
  "videoAspects",
  "imageAspect",
  "videoAspect",
  "request",
  "settings",
  "mask",
  "card",
  "rpc",
  "updateMethod",
  "finish",
  "message",
  "maskPaths",
  "string",
  "strings",
  "enumValue",
  "integer",
  "boolean",
  "setCards",
  "setMemoryEnabled",
] as const satisfies readonly AgentSettingsExport[];

/** Browser exports required for native Agent chat sessions and turns. */
export const AGENT_EXPORTS = [
  "allocate",
  "init",
  "sessionList",
  "readSession",
  "resume",
  "rows",
  "metadata",
  "string",
  "turnType",
  "turns",
  "decode",
  "hydrate",
  "reply",
  "permission",
  "plan",
  "newEnvelope",
  "setContent",
  "mutable",
  "finish",
  "newContent",
  "setParts",
  "newPart",
  "setText",
  "errors",
  "legacyDecision",
  "clearLegacyRequest",
  "oneOf",
  "toolEventType",
  "toolEventGroup",
  "toolResultType",
  "resultItems",
  "structFields",
  "valueString",
] as const satisfies readonly AgentExport[];

/** Browser exports required for Agent attachments and local uploads. */
export const AGENT_ATTACHMENT_EXPORTS = [
  "reference",
  "message",
  "text",
  "id",
  "validateFiles",
  "isVideo",
  "mimeType",
  "imageSize",
  "videoInfo",
  "confirmUpload",
] as const satisfies readonly AgentAttachmentExport[];

/** Browser exports and service fields for Agent settings. */
export interface AgentSettingsFormat {
  /** Project metadata service's query client. */
  queryClient: string;
  /** Project metadata service's request client. */
  requestClient: string;
  /** Browser exports for native settings requests. */
  exports: Readonly<Record<AgentSettingsExport, string>>;
  /** New names for project settings methods and catalogue fields. */
  wire?: AgentSettingsWireFormat;
}

/** Methods and fields used to read and encode one build's Agent settings. */
export interface AgentSettingsWireFormat {
  /** Method that gets the settings from the metadata response. */
  metadata: string;
  /** Method that encodes the request descriptor and message. */
  encode: string;
  /** New names of the settings message methods. */
  methods: Readonly<Record<string, string>>;
  /** Model group in the catalogue. */
  groups: string;
  /** Image model group. */
  imageModels: string;
  /** Video model group. */
  videoModels: string;
  /** Account tier defaults in the catalogue. */
  tierDefaults: string;
  /** Model list in the options request. */
  families: string;
  /** Usage codes in the options filter. */
  usages: string;
  /** Model ID in an option. */
  modelId: string;
  /** Preferred model ID in the selection request. */
  preferredModel: string;
}

/** Project page and browser exports for Agent chat. */
export interface AgentChatFormat {
  /** Exported project page component class. */
  page: string;
  /** Agent transport service on the project page. */
  transport: string;
  /** Angular injector on the project page. */
  injector: string;
  /** Exported Agent composer controller. */
  composer: string;
  /** Exported permission response service. */
  permissions: string;
  /** Exported question response service. */
  questions: string;
  /** Signal with the page's project ID. */
  project: string;
  /** Lifecycle controller on the project page. */
  lifecycle: string;
  /** Destroyed flag on the lifecycle controller. */
  destroyed: string;
  /** Browser exports for the native Agent protocol. */
  exports: Readonly<Record<AgentExport, string>>;
  /** Changes to the native Agent fields and methods. */
  wire?: AgentWireFormat;
}

/** Native services and request fields for local media uploads. */
export interface MediaUploadFormat {
  /** Project store on the page component. */
  store: string;
  /** Signal with all project tiles. */
  tiles: string;
  /** Query that loads the tiles for the active project. */
  tileQuery: string;
  /** Project mutation dispatcher. */
  dispatcher: string;
  /** Angular injector on the project page. */
  injector: string;
  /** Exported upload consent service. */
  consent: string;
  /** Functions that the verified build uses for uploads. */
  exports: Readonly<Record<MediaUploadExport, string>>;
  /** Fields in the native upload format. */
  fields: MediaUploadFields;
}

/** Upload functions that do not depend on Agent message support. */
export const MEDIA_UPLOAD_EXPORTS = [
  "id", "validateFiles", "isVideo", "mimeType", "imageSize", "videoInfo", "confirmUpload",
] as const satisfies readonly MediaUploadExport[];

/** Fields in the native request and reply for a local media upload. */
export interface MediaUploadFields {
  /** Accepted files in the validation result. */
  accepted: string;
  /** Error messages in the validation result. */
  errors: string;
  /** Duration in the video metadata. */
  duration: string;
  /** Workflow ID in the upload request. */
  workflow: string;
  /** Media ID in the upload request. */
  media: string;
  /** Local file in the upload request. */
  file: string;
  /** Date in the upload request. */
  date: string;
  /** Image dimensions in the upload request. */
  dimensions: string;
  /** Completion callbacks in the upload request. */
  completion: string;
}

/** Project page fields and exports for Agent attachments. */
export interface AgentAttachmentFormat extends MediaUploadFormat {
  /** Functions for uploads and Agent message attachments. */
  exports: Readonly<Record<AgentAttachmentExport, string>>;
  /** Fields for uploads and Agent message attachments. */
  fields: AgentAttachmentFields;
}

/** Additional fields in the Agent attachment protocol. */
export interface AgentAttachmentFields extends MediaUploadFields {
  /** Character ID in a native reference. */
  character: string;
  /** Text content in the message request. */
  text: string;
  /** Attachment references in the message request. */
  references: string;
}

/** Project page and upload formats for an independent library upload. */
export interface ProjectUploadFormat {
  /** Class and lifecycle fields of the page that owns the upload services. */
  page: Pick<AgentChatFormat, "page" | "lifecycle" | "destroyed" | "project">;
  /** Native upload fields shared with Agent attachments. */
  media: MediaUploadFormat;
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
  /** Signal query that loads the tiles of the active project. */
  tileQuery: string;
  /** Mutation runner on the project store. */
  mutator: string;
  /** Error observable on the store mutation queue. */
  errorStream: string;
  /** Component slots that hold the injected project store. */
  componentSlots: readonly string[];
  /** Angular LView slot on an upgraded LContext wrapper. */
  lContextView: string;
  /** Field names of a scene tile and its workflow history. */
  scene?: SceneTileFormat;
  /** Native names for mutations that use the general store adapter. */
  mutations?: ProjectMutationFormat;
}

/** Fields that identify the contents of a scene tile. */
export interface SceneTileFormat {
  /** Clip array on a scene tile. */
  clips: string;
  /** Workflow history map on a scene tile. */
  history: string;
}

/** Names of fields used by the general project mutations. */
export interface ProjectMutationFormat {
  /** Tile ID in a single-tile request. */
  tileId: string;
  /** Change in a single-tile request. */
  tileChange: string;
  /** Workflow IDs used to create a scene or add clips. */
  sceneWorkflows: string;
  /** Collection ID in a scene creation request. */
  sceneCollection: string;
  /** Scene tile in a successful creation response. */
  sceneCreated: string;
  /** Scene ID in a request to add workflows. */
  sceneId: string;
  /** Start time in a video trim request. */
  trimStart: string;
  /** End time in a video trim request. */
  trimEnd: string;
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
  tileQuery: "RC",
  mutator: "lc",
  errorStream: "Ha",
  componentSlots: ["ha", "Eu", "oa", "ka"],
  lContextView: "Pn",
  scene: { clips: "Tc", history: "tg" },
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
  tileQuery: "Ir",
  mutator: "lc",
  errorStream: "Da",
  componentSlots: ["Xg", "ha", "Eu", "oa", "ka"],
  lContextView: "Pn",
};

/** Project store format of build 20261120.00. */
const NOVEMBER_20_STORE: ProjectStoreFormat = {
  storeClass: "GO",
  lifecycle: "Ba",
  destroyed: "Va",
  projectId: "ua",
  tilesService: "ma",
  queryClient: "Wa",
  dispatcher: "YJ",
  rows: "yb",
  tileQuery: "rs",
  mutator: "ld",
  errorStream: "Da",
  componentSlots: ["fh", "ha", "Ew", "la", "ka"],
  lContextView: "zp",
  scene: { clips: "Uc", history: "Cg" },
  mutations: {
    tileId: "Xc", tileChange: "mf", sceneWorkflows: "ng", sceneCollection: "Dc",
    sceneCreated: "t6a", sceneId: "yc", trimStart: "dh", trimEnd: "ug",
  },
};

/** Agent settings format of build 20261118.14. */
const NOVEMBER_18_AGENT_SETTINGS: AgentSettingsFormat = {
  queryClient: "Wa",
  requestClient: "ka",
  exports: {
    projectService: "DN", projectKey: "RL", modelService: "xN", modelKey: "PFb",
    fetchModels: "RFb", serviceTier: "pG", locale: "lh", modelOptions: "xO",
    defaultModel: "rO", selectModel: "hZ", aspectLabels: "AE", videoAspects: "DO",
    imageAspect: "Jlc", videoAspect: "Klc", request: "Ny", settings: "k_",
    mask: "Zq", card: "bM", rpc: "ax", updateMethod: "CDb", finish: "ac",
    message: "Sk", maskPaths: "Xq", string: "pv", strings: "rv", enumValue: "Ft",
    integer: "nv", boolean: "Zs", setCards: "csc", setMemoryEnabled: "bsc",
  },
};

/** Agent settings format of build 20261120.00. */
const NOVEMBER_20_AGENT_SETTINGS: AgentSettingsFormat = {
  queryClient: "Wa",
  requestClient: "ka",
  exports: {
    projectService: "$N", projectKey: "pM", modelService: "UN", modelKey: "wGb",
    fetchModels: "yGb", serviceTier: "EG", locale: "nh", modelOptions: "UO",
    defaultModel: "OO", selectModel: "NZ", aspectLabels: "NE", videoAspects: "$O",
    imageAspect: "rmc", videoAspect: "smc", request: "$y", settings: "Q_",
    mask: "gr", card: "AM", rpc: "kx", updateMethod: "jEb", finish: "cc",
    message: "al", maskPaths: "er", string: "wv", strings: "yv", enumValue: "Ot",
    integer: "uv", boolean: "ht", setCards: "Jsc", setMemoryEnabled: "Isc",
  },
  wire: {
    metadata: "Kn", encode: "Eb",
    methods: {
      NL: "wM", PH: "uI", QH: "vI", rR: "gS", sR: "hS", Pg: "Vg", bz: "rz",
      QY: "NZ", ZY: "WZ", YN: "HO", cO: "KO", ML: "vM", Ww: "vx", xl: "Jl",
      Vl: "tm", mB: "MB", KH: "pI", MH: "rI",
    },
    groups: "yg", imageModels: "BI", videoModels: "No", tierDefaults: "sy",
    families: "jx", usages: "Xl", modelId: "hg", preferredModel: "fda",
  },
};

/** Agent chat format of build 20261118.14. */
const NOVEMBER_18_AGENT: AgentChatFormat = {
  page: "ku",
  transport: "na",
  injector: "Cb",
  composer: "q3",
  permissions: "Q1",
  questions: "R1",
  project: "ua",
  lifecycle: "Ba",
  destroyed: "Va",
  exports: {
    allocate: "yN", init: "b0", sessionList: "Kvc", readSession: "Svc", resume: "Tvc",
    rows: "NZ", metadata: "PZ", string: "p", turnType: "w_", turns: "bv",
    decode: "XZ", hydrate: "Muc", reply: "eCc", permission: "yFc", plan: "KEc",
    newEnvelope: "B1", setContent: "YZ", mutable: "Uq", finish: "Wq", newContent: "wK",
    setParts: "vK", newPart: "qK", setText: "pK", errors: "uE", legacyDecision: "xFc",
    clearLegacyRequest: "Nuc", oneOf: "nr", toolEventType: "lZ", toolEventGroup: "nZ",
    toolResultType: "uZ", resultItems: "qZ", structFields: "hM", valueString: "pZ",
  },
};

/** Agent chat format of build 20261120.00. */
const NOVEMBER_20_AGENT: AgentChatFormat = {
  page: "uu",
  transport: "na",
  injector: "Ab",
  composer: "z3",
  permissions: "f2",
  questions: "g2",
  project: "ua",
  lifecycle: "Ba",
  destroyed: "Va",
  exports: {
    allocate: "VN",
    init: "twc",
    sessionList: "swc",
    readSession: "Bwc",
    resume: "Cwc",
    rows: "s_",
    metadata: "u_",
    string: "p",
    turnType: "b0",
    turns: "lv",
    decode: "C_",
    hydrate: "rvc",
    reply: "hDc",
    permission: "DGc",
    plan: "PFc",
    newEnvelope: "S1",
    setContent: "D_",
    mutable: "br",
    finish: "dr",
    newContent: "TK",
    setParts: "SK",
    newPart: "NK",
    setText: "MK",
    errors: "HE",
    legacyDecision: "CGc",
    clearLegacyRequest: "svc",
    oneOf: "vr",
    toolEventType: "RZ",
    toolEventGroup: "TZ",
    toolResultType: "$Z",
    resultItems: "WZ",
    structFields: "GM",
    valueString: "VZ",
  },
  wire: {
    methods: { stop: "uv", deleteSession: "eM", renameSession: "Z2", clearSession: "eM", permissions: "La", answer: "nB" },
    send: { Oe: "Te", Gn: "Wn", hi: "wi", Aq: "Wq" },
    hydrate: { BF: "hG", hka: "Rla", xe: "Ce" },
    resume: { BF: "hG", TM: "BN" },
    formatTurn: { XJ: "DK", yc: "Ac" },
    permissionRequest: { Ig: "Of" },
    planRequest: { VE: "DF", hi: "wi" },
    planChoice: { aja: "Fka" },
    questionRequest: { Ig: "Of", Qj: "Nj", hi: "wi" },
    answer: { fk: "Lk", VN: "EO", HY: "DZ" },
    session: { Vh: "Jh", xe: "Ce" },
    turn: { Yu: "rv", Tf: "Yf" },
    stream: { Oh: "Ah", Bx: "Sx" },
    user: { Gh: "Nh", Uy: "lz" },
    character: { Nc: "Oc" },
    reply: { Oh: "Ah", ci: "oi", jna: "Uoa" },
    permissionCard: { Vz: "rA", Ls: "Wr" },
    permissionSummary: { qsa: "nua", joa: "Wpa", loa: "Ypa" },
    questionCard: { Qm: "nn", Qj: "Nj", Ls: "Wr" },
    question: { fk: "Lk", dt: "lq", cj: "Yi" },
    option: { zq: "gq", recommended: "eaa" },
    planBlock: "cA",
    plan: { XDa: "lGa", FOa: "mRa" },
    errors: { IC: "mD" },
  },
};

/** Agent attachment format of build 20261118.14. */
const NOVEMBER_18_ATTACHMENTS: AgentAttachmentFormat = {
  store: "Xg",
  tiles: "la",
  tileQuery: "Ir",
  dispatcher: "ie",
  injector: "Cb",
  consent: "PR",
  exports: {
    reference: "vO", message: "nAc", text: "FI", id: "yN", validateFiles: "uR",
    isVideo: "sR", mimeType: "jTb", imageSize: "rR", videoInfo: "qTb", confirmUpload: "OR",
  },
  fields: {
    character: "Nc", text: "Lc", references: "nc", accepted: "mA", errors: "ir",
    duration: "Tt", workflow: "hf", media: "wh", file: "yn", date: "kc",
    dimensions: "Ac", completion: "sm",
  },
};

/** Agent attachment format of build 20261120.00. */
const NOVEMBER_20_ATTACHMENTS: AgentAttachmentFormat = {
  store: "fh",
  tiles: "la",
  tileQuery: "rs",
  dispatcher: "he",
  injector: "Ab",
  consent: "kS",
  exports: {
    reference: "SO", message: "jBc", text: "QI", id: "VN", validateFiles: "UR",
    isVideo: "RR", mimeType: "OTb", imageSize: "QR", videoInfo: "UTb", confirmUpload: "jS",
  },
  fields: {
    character: "Oc", text: "Nc", references: "oc", accepted: "IA", errors: "Ir",
    duration: "pu", workflow: "lf", media: "Eh", file: "Nn", date: "lc",
    dimensions: "Bc", completion: "Jm",
  },
};

/** Verified media payload fields used during snapshot reads. */
export interface SnapshotMediaFormat {
  /** Primary media payload property on an image or video tile. */
  container: string;
  /** Direct media URL property on a media payload or history item. */
  url: string;
  /** Lifecycle status property on a media payload. */
  status: string;
  /** Error payload property on a media payload. */
  error: string;
  /** Dimensions object property on a media payload. */
  dimensions: string;
  /** Video duration property in seconds on a media payload. */
  duration: string;
  /** Creation date property on a tile or media payload. */
  date: string;
}

/** Verified character tile and entity protobuf fields used during snapshot reads. */
export interface SnapshotCharacterFormat {
  /** Serialized entity message property on a character tile. */
  entity: string;
  /** Look workflow map property on a character tile. */
  looks: string;
  /** Preview media ID property on a character tile. */
  previewMediaId: string;
  /** Protobuf field number for `entity_info` on the entity message. */
  entityInfoField: number;
  /** Protobuf field number for `character_info` on `entity_info`. */
  characterInfoField: number;
  /** Protobuf field number for `audio_references` on `character_info`. */
  audioReferencesField: number;
  /** Protobuf field number for a preset voice ID on an audio reference. */
  presetVoiceField: number;
  /** Protobuf field number for a custom voice workflow ID on an audio reference. */
  customVoiceField: number;
  /** Protobuf field number for `personality_notes` on `character_info`. */
  notesField: number;
}

/** Verified tile type discriminants in the project tile store. */
export interface SnapshotTileTypesFormat {
  /** Collection tile type value. */
  collection: string;
  /** Asset tile type values included in project asset lists. */
  assets: readonly string[];
  /** Non-asset tile type values excluded from project asset lists and counts. */
  ignored: readonly string[];
}

/** Verified account credits service and balance accessors. */
export interface SnapshotCreditsFormat {
  /** Exported credits service class on the Angular frontend namespace. */
  service: string;
  /** Signal method returning the spendable total credit balance. */
  total: string;
  /** Query property on the credits service. */
  query: string;
  /** Method on the credits query message returning total credits. */
  balanceMethod: string;
}

/** Verified snapshot field map for one frontend build. */
export interface SnapshotFormat {
  /** Media payload and URL properties. */
  media: SnapshotMediaFormat;
  /** Character look, preview, and entity properties. */
  character: SnapshotCharacterFormat;
  /** Tile type discriminants for assets, collections, and non-asset items. */
  tileTypes: SnapshotTileTypesFormat;
  /** Credits service class and balance accessors. */
  credits: SnapshotCreditsFormat;
}

/** Snapshot format of build 20261120.00. */
const NOVEMBER_20_SNAPSHOT: SnapshotFormat = {
  media: {
    container: "Kb",
    url: "kc",
    status: "od",
    error: "Bf",
    dimensions: "Bc",
    duration: "Cf",
    date: "lc",
  },
  character: {
    entity: "Rc",
    looks: "Ng",
    previewMediaId: "Kd",
    entityInfoField: 4,
    characterInfoField: 3,
    audioReferencesField: 2,
    presetVoiceField: 2,
    customVoiceField: 1,
    notesField: 3,
  },
  tileTypes: {
    collection: "COLLECTION",
    assets: ["IMAGE", "VIDEO", "SCENE", "CHARACTER"],
    ignored: ["TEXT_TILE", "CUSTOM"],
  },
  credits: {
    service: "EG",
    total: "Ts",
    query: "query",
    balanceMethod: "YR",
  },
};

/** Verified operations and store format of one build. */
interface FrontendBuildFields {
  /** Layout for the project store. */
  projectStore: ProjectStoreFormat;
  /** Snapshot field descriptors for verified store reads. */
  snapshot?: SnapshotFormat;
  /** Native fields used to confirm a character voice assignment. */
  voiceConfirmation?: VoiceConfirmationFormat;
  /** Native fields of the character preview panel and controls. */
  characterPreview?: CharacterPreviewFormat;
  /** Native fields of the character voice form. */
  characterVoice?: CharacterVoiceFormat;
  /** Native fields for character creation and store lifecycle checks. */
  characterCreate?: CharacterCreateFormat;
  /** Native fields of editable project titles. */
  projectTitle?: ProjectTitleFormat;
}

/** A verified build with full or pre-Agent operation coverage. */
type FrontendBuild = FrontendBuildFields & (
  | { legacy?: false; operations: FrontendFormats }
  | { legacy: true; operations: Pick<FrontendFormats, "collection_write" | "asset_trash_store" | "character_bio"> & Partial<FrontendFormats> }
);

/** Native methods of the character preview panel and look controls. */
export interface CharacterPreviewFormat {
  /** Lifecycle controller on the panel. */
  lifecycle: string;
  /** Method that opens the native file picker for the active slot. */
  upload: string;
  /** Method that identifies the preview panel. */
  marker: string;
  /** Signal with the portrait media record. */
  portrait: string;
  /** Signal with the body media record. */
  body: string;
  /** Signal with the active slot image URL. */
  source: string;
  /** Signal that reports whether the preview is busy. */
  busy: string;
  /** Footer signal that reports whether look generation is busy. */
  footerBusy: string;
  /** Popover method that lists project assets in the add menu. */
  pickerAssets: string;
  /** Popover method that selects a project asset in the add menu. */
  pickerSelect: string;
}

/** Native signals and outputs of the character voice form. */
export interface CharacterVoiceFormat {
  /** Lifecycle controller on the form component. */
  lifecycle: string;
  /** Destroyed flag on the lifecycle controller. */
  destroyed: string;
  /** Signal with the loaded voice map. */
  voiceMap: string;
  /** Signal with the selected voice ID. */
  selectedVoice: string;
  /** Signal with the selected raw voice entry. */
  selectedRecord: string;
  /** Output emitter that commits a voice change. */
  changeEmitter: string;
  /** Signal that reports whether the form is busy. */
  busy: string;
  /** True when the build keeps the form voice map empty while idle. */
  emptyMap: boolean;
}

/** Field names for character creation and store lifecycle checks. */
export interface CharacterCreateFormat {
  /** Lifecycle controller on the bound store service. */
  lifecycle: string;
  /** Destroyed flag on the lifecycle controller. */
  destroyed: string;
  /** Entity kind fields set to `1` in a `create_entity` request. */
  entityKinds: readonly string[];
  /** Collection fields set to `undefined` in a `create_entity` request. */
  collections: readonly string[];
  /** Completion callback fields in a `create_entity` request. */
  completions: readonly string[];
  /** Created tile fields in a `create_entity` response. */
  created: readonly string[];
}

/** Native fields of `flow-editable-text` used to commit a project title. */
export interface ProjectTitleFormat {
  /** Output emitter that commits the edited title text. */
  saveEmitter: string;
  /** Signal that sets the component back to viewing mode. */
  stateSignal: string;
}

/** Character editor and query fields used to read the saved voice. */
export interface VoiceConfirmationFormat {
  /** Exported character editor class. */
  editor: string;
  /** Query that loads the character entity. */
  entityQuery: string;
  /** Editor method that reads the voice ID from that entity. */
  savedVoice: string;
  /** Form method that reads the locally selected voice ID. */
  selectedVoice: string;
  /** Event that reports the saved voice media and workflow IDs. */
  previewSaved: string;
  /** Signal with the voice that the picker will add to the character. */
  pickerSelection: string;
}

/** Character preview format of earlier builds. */
const LEGACY_CHARACTER_PREVIEW: CharacterPreviewFormat = {
  lifecycle: "Ca", upload: "JR", marker: "Si", portrait: "ka", body: "ma",
  source: "psa", busy: "zy", footerBusy: "Th", pickerAssets: "Hi", pickerSelect: "Sla",
};

/** Character voice form format of earlier builds. */
const LEGACY_CHARACTER_VOICE: CharacterVoiceFormat = {
  lifecycle: "Ca", destroyed: "Va", voiceMap: "bW", selectedVoice: "zZ",
  selectedRecord: "Kna", changeEmitter: "p$", busy: "yb", emptyMap: false,
};

/** Character creation format of earlier builds. */
const LEGACY_CHARACTER_CREATE: CharacterCreateFormat = {
  lifecycle: "Ca", destroyed: "Va", entityKinds: ["A3", "AW"],
  collections: ["tb", "ub"], completions: ["De", "ve"], created: ["MF", "II"],
};

/** Editable project title format of earlier builds. */
const LEGACY_PROJECT_TITLE: ProjectTitleFormat = { saveEmitter: "tJa", stateSignal: "state" };

/** Request formats by exact build label. Include only verified operations. */
const VERIFIED_BUILDS: ReadonlyMap<string, FrontendBuild> = new Map([
  ["boq_labs-ai-sandbox-frontend_20261117.10_p0", {
    legacy: true,
    projectStore: NOVEMBER_17_STORE,
    characterCreate: { ...LEGACY_CHARACTER_CREATE, lifecycle: "Ca", destroyed: "Wa" },
    operations: {
      collection_write: { tileId: "Uc", tileChange: "df", moveTarget: "Sj", moveTiles: "Bb" },
      asset_trash_store: {
        entries: "Kv",
        tile: "Oa",
        trashed: "Ab",
        date: "jc",
        destination: "Dm",
        sceneWorkflows: "qg",
      },
      character_bio: { tileId: "Uc", tileChange: "df", notes: "mx" },
    },
  }],
  ["boq_labs-ai-sandbox-frontend_20261118.14_p0", {
    projectStore: NOVEMBER_18_STORE,
    characterCreate: { ...LEGACY_CHARACTER_CREATE, lifecycle: "Ba", destroyed: "Va" },
    characterVoice: { ...LEGACY_CHARACTER_VOICE, lifecycle: "Ba", destroyed: "Va" },
    operations: {
      collection_write: { tileId: "Vc", tileChange: "jf", moveTarget: "Wj", moveTiles: "Ab" },
      asset_trash_store: {
        entries: "Yv", tile: "Ia", trashed: "Bb", date: "Yb", destination: "Km",
        sceneWorkflows: "Gj",
      },
      character_bio: { tileId: "Vc", tileChange: "jf", notes: "Jx" },
      agent_chat: NOVEMBER_18_AGENT,
      agent_attachments: NOVEMBER_18_ATTACHMENTS,
      project_upload: { page: NOVEMBER_18_AGENT, media: NOVEMBER_18_ATTACHMENTS },
      agent_settings: NOVEMBER_18_AGENT_SETTINGS,
    },
  }],
  ["boq_labs-ai-sandbox-frontend_20261120.00_p0", {
    projectStore: NOVEMBER_20_STORE,
    snapshot: NOVEMBER_20_SNAPSHOT,
    voiceConfirmation: {
      editor: "qu", entityQuery: "ma", savedVoice: "Xjb", selectedVoice: "A3",
      previewSaved: "MK", pickerSelection: "Qn",
    },
    characterPreview: {
      lifecycle: "Ba", upload: "NV", marker: "hh", portrait: "ka", body: "ma",
      source: "Gza", busy: "mB", footerBusy: "Zh", pickerAssets: "xZ", pickerSelect: "Qda",
    },
    characterVoice: {
      lifecycle: "Ba", destroyed: "Va", voiceMap: "o_", selectedVoice: "A3",
      selectedRecord: "Pua", changeEmitter: "Pea", busy: "yb", emptyMap: true,
    },
    characterCreate: {
      lifecycle: "Ba", destroyed: "Va", entityKinds: ["pM"],
      collections: ["tb", "ub"], completions: ["De", "ve"], created: ["NH"],
    },
    projectTitle: { saveEmitter: "HSa", stateSignal: "state" },
    operations: {
      collection_write: {
        tileId: "Xc", tileChange: "mf", moveTarget: "mk", moveTiles: "yb", deleteCollections: "mu",
      },
      asset_trash_store: {
        entries: "tw", tile: "Ia", trashed: "Cb", date: "Xb", destination: "hn",
        sceneWorkflows: "Dj",
      },
      character_bio: { tileId: "Xc", tileChange: "mf", notes: "Zx" },
      agent_chat: NOVEMBER_20_AGENT,
      agent_attachments: NOVEMBER_20_ATTACHMENTS,
      project_upload: { page: NOVEMBER_20_AGENT, media: NOVEMBER_20_ATTACHMENTS },
      agent_settings: NOVEMBER_20_AGENT_SETTINGS,
    },
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

/** Returns the verified project store layout of the active build, or undefined. */
export function activeProjectStoreFormat(): ProjectStoreFormat | undefined {
  return frontendBuild(readBuildLabel())?.projectStore;
}

/** Adds the native fields used by the verified project store mutator. */
export function withMutationAliases(payload: Record<string, unknown>): Record<string, unknown> {
  const build = frontendBuild(readBuildLabel());
  const format = build?.projectStore.mutations;
  if (payload.type === "single_tile" && payload.Ve && typeof payload.Ve === "object") {
    const change = payload.Ve as Record<string, unknown>;
    if (format) {
      const native = change.type === "set_video_trim_seconds" ? {
        ...change, [format.trimStart]: change.Cg, [format.trimEnd]: change.Rf,
      } : change;
      return { ...payload, [format.tileId]: payload.Xc ?? payload.Uc, [format.tileChange]: native };
    }
    const collectionWrite = build?.operations.collection_write;
    if (collectionWrite) {
      return {
        ...payload,
        [collectionWrite.tileId]: payload.Xc ?? payload.Uc,
        [collectionWrite.tileChange]: change,
      };
    }
    return payload;
  }
  if (format && payload.type === "create_scene") {
    return { ...payload, [format.sceneWorkflows]: payload.rg, [format.sceneCollection]: payload.Fc };
  }
  if (format && payload.type === "add_workflows_to_scene") {
    return { ...payload, [format.sceneId]: payload.Lc, [format.sceneWorkflows]: payload.rg };
  }
  if (format && payload.type === "create_entity") {
    return { ...payload, pM: payload.pM ?? 1 };
  }
  return payload;
}

/** Returns the character preview field mapping for the active build. */
export function characterPreviewFormat(): CharacterPreviewFormat {
  return frontendBuild(readBuildLabel())?.characterPreview ?? LEGACY_CHARACTER_PREVIEW;
}

/** Returns the character voice form mapping for the active build. */
export function characterVoiceFormat(): CharacterVoiceFormat {
  return frontendBuild(readBuildLabel())?.characterVoice ?? LEGACY_CHARACTER_VOICE;
}

/** Returns the character creation and store lifecycle mapping for the active build. */
export function characterCreateFormat(): CharacterCreateFormat {
  return frontendBuild(readBuildLabel())?.characterCreate ?? LEGACY_CHARACTER_CREATE;
}

/** Returns the editable project title mapping for the active build. */
export function projectTitleFormat(): ProjectTitleFormat {
  return frontendBuild(readBuildLabel())?.projectTitle ?? LEGACY_PROJECT_TITLE;
}

/** Returns the verified snapshot field descriptors for the active build. */
export function snapshotFormat(): SnapshotFormat | undefined {
  return frontendBuild(readBuildLabel())?.snapshot;
}
