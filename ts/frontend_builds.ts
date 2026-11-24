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
  /** Project store on the page component. */
  store: string;
  /** Signal with all project tiles. */
  tiles: string;
  /** Query that loads the tiles for the active project. */
  tileQuery: string;
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
    option: { zq: "gq", rma: "eaa" },
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

/** Verified operations and store format of one build. */
interface FrontendBuild {
  /** Layout for the project store. */
  projectStore: ProjectStoreFormat;
  /** Operations with verified request formats. */
  operations: FrontendFormats;
  /** Native fields used to confirm a character voice assignment. */
  voiceConfirmation?: VoiceConfirmationFormat;
  /** Native fields of the character preview panel. */
  characterPreview?: CharacterPreviewFormat;
}

/** Native methods of the character preview panel. */
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

/** Verified project store formats checked when build lookup falls back. */
const PROJECT_STORE_FORMATS: readonly ProjectStoreFormat[] = [
  NOVEMBER_17_STORE,
  NOVEMBER_18_STORE,
  NOVEMBER_20_STORE,
];

/** Request formats by exact build label. Every entry covers all managed operations. */
const VERIFIED_BUILDS: ReadonlyMap<string, FrontendBuild> = new Map([
  ["boq_labs-ai-sandbox-frontend_20261118.14_p0", {
    projectStore: NOVEMBER_18_STORE,
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
    voiceConfirmation: {
      editor: "qu", entityQuery: "ma", savedVoice: "Xjb", selectedVoice: "A3",
      previewSaved: "MK", pickerSelection: "Qn",
    },
    characterPreview: {
      lifecycle: "Ba", upload: "NV", marker: "hh", portrait: "ka", body: "ma", source: "Gza", busy: "mB",
    },
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

/** Returns the layouts to check when the runtime binds the active project store. */
export function projectStoreFormats(): readonly ProjectStoreFormat[] {
  const format = frontendBuild(readBuildLabel())?.projectStore;
  return format ? [format] : PROJECT_STORE_FORMATS;
}
