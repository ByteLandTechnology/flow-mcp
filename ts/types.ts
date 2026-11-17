// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Shared TypeScript interfaces for the Google Flow browser runtime bundle.

/** Ordered Angular Ivy logical view slot array. */
export type NgLView = unknown[];

/** Google internal Wiz payload attached to window. */
export interface WizGlobalData {
  /** Signed request token for batchexecute calls. */
  SNlM0e?: string;
  /** Session identifier for batchexecute calls. */
  FdrFJe?: string;
  /** Build label for batchexecute calls. */
  cfb2h?: string;
  /** Encoded FIFE host configuration string. */
  TSDtV?: string;
}

/** Angular Router subset used for in-app navigation. */
export interface AngularRouter {
  /** Navigate to an Angular route command array with optional extras. */
  navigate: (commands: unknown[], extras?: { queryParams?: Record<string, string> }) => Promise<boolean>;
  /** Router location reference. */
  location: unknown;
  /** Router configuration options. */
  options: unknown;
}

/** Destroyable Angular component or service lifecycle handle. */
export interface AngularLifecycleHandle {
  /** Ivy destroy marker containing the disposed flag `Va`. */
  Ca?: { Va?: boolean };
}

/** Minified nested media metadata stored on a Flow tile. */
export interface FlowMediaPayload {
  /** Primary media identifier. */
  id?: string | number;
  /** Media identifier alias. */
  mediaId?: string | number;
  /** Primary video stream URL field. */
  Bd?: string;
  /** Secondary video URL field. */
  uA?: string;
  /** Signed or proxied video URL field. */
  videoUrl?: string;
  /** FIFE image URL field. */
  Wb?: string;
  /** Explicit FIFE URL alias. */
  fifeUrl?: string;
  /** Image URL alias. */
  imageUrl?: string;
  /** Generic media URL alias. */
  mediaUrl?: string;
  /** Fallback media URL field. */
  url?: string;
  /** Media lifecycle status string. */
  Zc?: string;
  /** Media lifecycle status string in the Flow front end from 2026-11-15 on. */
  od?: string;
  /** Media failure payload or error code. */
  nf?: unknown;
  /** Media failure payload in the Flow front end from 2026-11-15 on. */
  Bf?: unknown;
  /** Video length in seconds in the Flow front end from 2026-11-15 on. */
  xf?: number;
  /** Video resolution code in the Flow front end (4 = 360p, 1 = 720p, 2 = 1080p, 3 = 4K). */
  resolution?: number;
  /** Media width divided by media height. */
  aspectRatio?: number;
  /** Submission time in the Flow front end from 2026-11-15 on. */
  kc?: unknown;
  /** Text prompt used to generate the media. */
  prompt?: string;
  /** Character personality notes on nested payloads. */
  personalityNotes?: string;
  /** Character description alias. */
  description?: string;
  /** Attached voice identifier or object. */
  voice?: unknown;
  /** Trim start timestamp in seconds. */
  Ac?: number;
  /** Alternative trim start timestamp in seconds. */
  Cg?: number;
  /** Trim end timestamp in seconds. */
  Ic?: number;
  /** Alternative trim end timestamp in seconds. */
  Rf?: number;
  /** Rendered media pixel width. */
  width?: number;
  /** Rendered media pixel height. */
  height?: number;
  /** Dimension container carrying width and height. */
  tc?: { width?: number; height?: number };
  /** Dimension container in the Flow front end from 2026-11-15 on. */
  xc?: { width?: number; height?: number };
  /** Clip duration in seconds. */
  durationSeconds?: number;
  /** Duration alias in seconds. */
  duration?: number;
  /** Minified duration field in seconds. */
  Lf?: number;
  /** Creation timestamp or ISO date. */
  hc?: Date | string;
  /** Input prompt container on clip history items. */
  inputs?: { prompt?: string };
}

/** Character look history entry stored in tile look maps. */
export interface CharacterLookEntry {
  /** Primary media identifier for the look. */
  primaryMediaId?: string | number;
  /** FIFE look URL. */
  Wb?: string;
  /** Explicit FIFE URL alias. */
  fifeUrl?: string;
  /** Image URL alias. */
  imageUrl?: string;
  /** Fallback URL alias. */
  url?: string;
  /** Failure status or message. */
  nf?: unknown;
  /** Nested media descriptor. */
  media?: FlowMediaPayload;
  /** Look generation history items. */
  history?: CharacterLookEntry[];
}

/** Scene timeline clip descriptor inside `st.Oc`. */
export interface SceneClipItem {
  /** Clip workflow identifier. */
  workflowId?: string | number;
  /** Primary media identifier for the clip. */
  primaryMediaId?: string | number;
  /** Clip status field. */
  Zc?: string;
  /** Clip error field. */
  nf?: unknown;
  /** Direct clip video URL. */
  Bd?: string;
  /** Secondary clip video URL. */
  uA?: string;
  /** Fallback clip video URL. */
  videoUrl?: string;
  /** Clip FIFE thumbnail or media URL. */
  Wb?: string;
  /** Explicit FIFE URL alias. */
  fifeUrl?: string;
  /** Trim start in seconds. */
  Mh?: number;
  /** Trim end in seconds. */
  Eh?: number;
  /** Clip duration in seconds. */
  rc?: number;
}

/** Project tile model stored inside the Angular tile map. */
export interface FlowTile extends FlowMediaPayload {
  /** Tile workflow or entity identifier. */
  id?: string | number;
  /** Alias workflow identifier. */
  workflowId?: string | number;
  /** Alias entity identifier. */
  entityId?: string | number;
  /** Alias primary media identifier. */
  primaryMediaId?: string | number;
  /** Tile display title. */
  displayName?: string;
  /** Uppercase tile kind (`IMAGE`, `VIDEO`, `SCENE`, `CHARACTER`, `COLLECTION`). */
  type?: string;
  /** True while creation mutation is pending. */
  isPending?: boolean;
  /** Parent collection identifier. */
  Fc?: string | number;
  /** Soft-trash flag variants. */
  trashed?: boolean;
  /** Secondary trash flag. */
  isTrashed?: boolean;
  /** Minified trash flag. */
  yb?: boolean;
  /** Primary uppercase media container. */
  Fb?: FlowMediaPayload;
  /** Legacy lowercase media container. */
  fb?: FlowMediaPayload;
  /** Primary media container in the Flow front end from 2026-11-15 on. */
  Eb?: FlowMediaPayload;
  /** Character preview fallback URL. */
  ue?: string;
  /** Character look slots map. */
  oi?: Map<unknown, CharacterLookEntry>;
  /** Character personality biography notes. */
  personalityNotes?: string;
  /** Minified character personality notes. */
  Mv?: string;
  /** Attached voice name. */
  voiceName?: unknown;
  /** Attached voice identifier. */
  voiceId?: unknown;
  /** Minified voice descriptor. */
  Vo?: unknown;
  /** Audio voice references list. */
  audioReferences?: unknown;
  /** Non-destructive video trim start in seconds. */
  trimStartSeconds?: number;
  /** Non-destructive video trim end in seconds. */
  trimEndSeconds?: number;
  /** Creation time alias. */
  createTime?: string;
  /** Scene clip array. */
  Oc?: SceneClipItem[];
  /** Scene clip workflow history lookup. */
  Yf?: Map<string, FlowMediaPayload[]> | Record<string, FlowMediaPayload[]>;
  /** Tile width alias. */
  width?: number;
  /** Tile height alias. */
  height?: number;
  /** Creation time field. */
  createDate?: string;
}

/** Mutation signal or queue object inside Angular store services. */
export interface MutationQueueObj {
  /** Pending item reader. */
  ka?: () => { items?: Array<{ mutation?: unknown }> } | null | undefined;
  /** Async promise mutation runner. */
  oe?: (payload: Record<string, unknown>) => Promise<unknown>;
  /** Async mutation helper. */
  mutateAsync?: (payload: Record<string, unknown>) => Promise<unknown>;
  /** Queue mutation dispatcher. */
  mutate?: (payload: Record<string, unknown>) => unknown;
  /** Signal error accessor. */
  error?: () => unknown;
  /** Status stream with `subscribe`. */
  Ha?: { subscribe?: (cb: (ev: { mutation?: unknown; error?: unknown }) => void) => { unsubscribe?: () => void } };
  /** Alternate status stream with `subscribe`. */
  ua?: { subscribe?: (cb: (ev: { mutation?: unknown; error?: unknown }) => void) => { unsubscribe?: () => void } };
}

/** Resolved Angular project store service instance or wrapper. */
export interface FlowStoreService extends AngularLifecycleHandle {
  /** Underlying `_ap` store variant. */
  _ap?: FlowStoreService & { RC?: { isPending?: () => boolean }; lc?: MutationQueueObj };
  /** Underlying `_uo` store variant. */
  _uo?: FlowStoreService;
  /** Tile map getter or inner signal container. */
  ka?: (() => Map<string, FlowTile> | null | undefined) | MutationQueueObj;
  /** Nested signal container or mutator. */
  ha?: (FlowStoreService & MutationQueueObj) | null;
  /** Lifecycle controller or mutation runner. */
  lc?: MutationQueueObj;
  /** Nested mutation runner. */
  mutate?: (payload: Record<string, unknown>) => unknown;
  /** Direct rename method on legacy store services. */
  RK?: (id: string, displayName: string) => Promise<unknown>;
  /** Legacy helper signature. */
  ZA?: (...args: unknown[]) => unknown;
  /** Optional nested query metadata. */
  na?: unknown;
  /** Optional tile fetcher signal. */
  PG?: (projectId: string | null, payload: Record<string, unknown>) => Promise<unknown>;
  /** Query key builder on UO stores. */
  queryKey?: (projectId: string | null) => unknown;
  /** Query cache handle on UO stores. */
  ob?: { ha?: (qk: unknown) => { Cb?: FlowTile[] } | null | undefined };
}

/** Unified project store handle bound into module state. */
export interface FlowStoreHandle {
  /** Active project identifier extracted from the route. */
  projectId: string | null;
  /** Returns the current project tile map if available. */
  getTileMap: () => Map<string, FlowTile> | null | undefined;
  /** Returns true when pending store fetches have settled. */
  isReady: () => boolean;
  /** Dispatches a store mutation payload and waits for completion. */
  mutate: (payload: Record<string, unknown>) => Promise<unknown>;
  /** Renames one tile or collection by identifier. */
  rename: (id: string, displayName: string) => Promise<unknown>;
}

/** Parsed FIFE CDN rewrite configuration derived from the active page. */
export interface FifeEnv {
  /** Preferred FIFE proxy host name. */
  fifeHost: string;
  /** Optional multi-account `authuser` parameter. */
  authuser: string | null;
  /** Returns true when `parsed` already carries signed CDN credentials. */
  isSignedCdnHost: (parsed: URL) => boolean;
}

/** Flow prompt validation and submission state controller. */
export interface PromptStateController {
  /** Applies serialized prompt segments. */
  Wn?: (doc: { Oe: Array<{ type: string; content: string }> }) => void;
  /** Prompt text helper object. */
  prompt?: { Le?: () => boolean };
  /** Validator status object. */
  lf?: { isValid?: () => boolean; jYa?: () => string };
  /** Mode, output count, and model config signals. */
  config?: {
    mode?: () => string;
    outputCount?: () => number;
  };
}

/** Angular component controller for a base prompt box. */
export interface BasePromptBoxInstance {
  /** Prompt state signal container. */
  Qa?: PromptStateController;
  /** Returns rich editor wrapper containing ProseMirror `th`. */
  CQ?: () => { th?: unknown } | null | undefined;
  /** Submits or prepares prompt state. */
  Wn?: (...args: unknown[]) => unknown;
  /** Returns true when the prompt box can submit. */
  qf?: () => boolean;
  /** Controls settings overlay visibility. */
  VJ?: (() => unknown) & { set?: (open: boolean) => void };
}

/** Host container managing manual and agent prompt boxes. */
export interface PromptBoxHost {
  /** Toggles between manual and agent composer modes. */
  Tx: () => void;
  /** Returns true while agent mode is active. */
  Sk: () => boolean;
  /** Returns the active manual base prompt box instance. */
  mt?: () => BasePromptBoxInstance | null | undefined;
  /** Returns the active agent prompt box wrapper. */
  iU?: () => { mt?: () => BasePromptBoxInstance | null | undefined } | null | undefined;
}

/** Angular project page component instance. */
export interface ProjectPageInstance {
  /** Attaches a tile reference directly into composer state. */
  Ph: (tile: FlowTile) => void;
  /** Prompt state and attached item signal container. */
  Qa: PromptStateController & { kc?: { all?: () => Array<Record<string, unknown>> } };
  /** Store/mode mutation signal container. */
  ub: { mutate: (value: unknown) => unknown };
  /** Secondary agent state signal container. */
  Ta?: { mutate?: (value: unknown) => void };
  /** Returns the prompt box host component. */
  jQ?: () => PromptBoxHost | null | undefined;
}

/** ProseMirror editor transaction builder subset. */
export interface ProseMirrorTransaction {
  /** Replaces document range `[from, to]` with `node`. */
  replaceWith: (from: number, to: number, node: unknown) => ProseMirrorTransaction;
}

/** ProseMirror editor state subset. */
export interface ProseMirrorState {
  /** Document schema used to construct nodes. */
  schema: {
    text: (text: string) => unknown;
    node?: (name: string, attrs?: unknown, content?: unknown[]) => unknown;
    nodes?: {
      hard_break?: { create?: () => unknown };
      paragraph?: { create?: (attrs: unknown, content: unknown[]) => unknown };
    };
  };
  /** Current document tree. */
  doc: { content: { size: number } };
  /** Default transaction builder. */
  tr?: ProseMirrorTransaction;
  /** Minified transaction builder alias. */
  Fi?: ProseMirrorTransaction;
}

/** ProseMirror editor view subset. */
export interface ProseMirrorView {
  /** Current editor state. */
  state: ProseMirrorState;
  /** Standard transaction dispatch function. */
  dispatch?: (tr: ProseMirrorTransaction) => void;
  /** Minified transaction dispatch alias. */
  Qd?: (tr: ProseMirrorTransaction) => void;
}

/** Options accepted by `writePromptBox`. */
export interface WritePromptOptions {
  /** Resolved base prompt box controller. */
  liveUx?: BasePromptBoxInstance | null;
  /** Candidate host DOM nodes searched first for Ivy controllers. */
  seeds?: Array<Element | null>;
  /** Selector excluding non-target prompt components. */
  excludeSelector?: string | null;
  /** Whether to require `PromptState` non-empty confirmation. */
  strictSync?: boolean;
  /** Whether clicking the Settings button is permitted to reveal Ivy maps. */
  trySettingsClick?: boolean;
  /** Selector restricting LView hover probing scope. */
  hoverScopeSelector?: string | null;
  /** Async cleanup callback invoked after temporarily opening Settings. */
  onCloseSettings?: () => Promise<void>;
}

/** Result returned by `writePromptBox`. */
export interface WritePromptResult {
  /** True when the prompt box reflects the written text. */
  ok: boolean;
  /** Strategy tier that succeeded. */
  tier: string;
}

/** Cached media resolution entry for a primary media identifier. */
export interface CachedMediaInfo {
  /** Primary stream or image URL. */
  url: string;
  /** Preferred download URL. */
  download_url: string;
  /** Ordered list of candidate download URLs. */
  candidates: string[];
}

/** Result returned by `checkAuth`. */
export interface AuthCheckResult {
  /** True when Flow displays an authenticated app shell. */
  signed_in: boolean;
  /** True when a landing page or sign-in link explicitly indicates signed-out state. */
  explicit_signed_out: boolean;
  /** Current document title. */
  title: string;
  /** Lowercase active location pathname. */
  path: string;
}

/** Result returned by `discoverStore`. */
export interface DiscoverStoreResult {
  /** True when a store handle is bound. */
  bound: boolean;
  /** True when this call discovered a fresh store handle. */
  newlyDiscovered: boolean;
}

/** Asset entry normalized for `readStoreSnapshot`. */
export interface SnapshotAssetItem {
  /** Tile or clip workflow identifier. */
  id: string;
  /** Display name. */
  name: string;
  /** Asset kind (`image`, `video`, `scene`, or `character`). */
  kind: string;
  /** Generation prompt text. */
  prompt: string | null;
  /** Normalized media URL. */
  url: string | null;
  /** Parent collection identifier. */
  collection_id: string | null;
  /** Parent collection name. */
  collection_name: string | null;
  /** Primary media identifier. */
  primary_media_id: string | null;
  /** Character personality notes. */
  personality_notes: string | null;
  /** Assigned voice name or identifier. */
  voice: string | null;
  /** Trim start in seconds. */
  trim_start_seconds: number | null;
  /** Trim end in seconds. */
  trim_end_seconds: number | null;
  /** Lowercase media generation status. */
  media_status: string | null;
  /** Failure description when present. */
  media_error: string | null;
  /** Media width in pixels. */
  width: number | null;
  /** Media height in pixels. */
  height: number | null;
  /** Media duration in seconds. */
  duration: number | null;
  /** ISO creation timestamp string. */
  created_at: string | null;
}

/** Collection summary returned inside `StoreSnapshotResult`. */
export interface SnapshotCollectionItem {
  /** Collection identifier. */
  id: string;
  /** Collection display name. */
  name: string;
  /** Member tile count. */
  count: number;
}

/** Result returned by `readStoreSnapshot`. */
export type StoreSnapshotResult =
  | { ok: false; error: string }
  | {
      ok: true;
      projectId: string | null;
      projectTitle: string | null;
      credits: number | null;
      assets: SnapshotAssetItem[];
      collections: SnapshotCollectionItem[];
    };

/** Request payload for `projectsOp`. */
export interface ProjectsOpRequest {
  /** Operation (`list`, `set_title`, or `delete`). */
  action?: string;
  /** Desired project title for `set_title` or target match for `delete`. */
  title?: string;
  /** Project identifier for `delete`. */
  project_id?: string;
}

/** Extra options for `assetOps("rename", ...)`. */
export interface AssetRenameExtra {
  /** Updated display name. */
  name?: string;
  /** True when resetting tile display name before retrying rename. */
  resetOld?: boolean;
}

/** Payload returned by `fetchMedia`. */
export interface FetchedMediaPayload {
  /** Base64 encoded binary media payload. */
  b64: string;
  /** Response `Content-Type` header if present. */
  contentType: string | null;
  /** Response `Content-Disposition` header if present. */
  disposition: string | null;
}

/** Result returned by `resolveVideoUrl`. */
export type ResolvedMediaResult =
  | { ok: false; error: string }
  | { ok: true; url: string; download_url: string; candidates: string[] };

/** Configuration payload shared by `setupGeneration` and `attachIngredients`. */
export interface GenerationConfig {
  /** Generation mode (`video`, `image`, `character`, or `scene`). */
  mode?: string | null;
  /** Aspect ratio label. */
  aspect?: string | null;
  /** Model label. */
  model?: string | null;
  /** Requested output count. */
  count?: number | null;
  /** Prompt text. */
  prompt?: string | null;
  /** Project asset IDs attached as ingredients. */
  asset_ids?: string[] | null;
  /** Character names or IDs attached as ingredients. */
  characters?: string[] | null;
  /** Video sub-type (`frames` or `ingredients`). */
  video_type?: string | null;
  /** Video duration label. */
  duration?: string | null;
  /** Video resolution label. */
  resolution?: string | null;
  /** Whether to enable Agent Mode composer. */
  agent?: boolean | null;
}

/** Request payload for `sceneOp`. */
export interface SceneOpRequest {
  /** Operation (`create` or `add_clips`). */
  action?: string;
  /** Clip asset IDs to include. */
  asset_ids?: string[] | null;
  /** Optional scene title. */
  name?: string | null;
  /** Existing scene ID for `add_clips`. */
  scene_id?: string | null;
  /** Optional insertion position index. */
  position?: number | null;
}

/** Request payload for `videoOp`. */
export interface VideoOpRequest {
  /** Operation (`trim`, `prepare_extend`, `poll_extend`, or `done_scene`). */
  action?: string;
  /** Target video asset identifier. */
  asset_id?: string | null;
  /** Target scene identifier for `prepare_extend`. */
  scene_id?: string | null;
  /** Extend prompt text. */
  prompt?: string | null;
  /** Non-destructive trim start timestamp in seconds. */
  start_seconds?: number | null;
  /** Non-destructive trim end timestamp in seconds. */
  end_seconds?: number | null;
}

/** Request payload for `characterOp`. */
export interface CharacterOpRequest {
  /** Operation (`open_editor`, `finish`, `create`, or `update`). */
  action?: string;
  /** Project identifier. */
  project_id?: string | null;
  /** Character identifier. */
  character_id?: string | null;
  /** Character display name. */
  name?: string | null;
  /** Character personality notes. */
  bio?: string | null;
  /** Optional voice name triggering editor navigation after create. */
  voice?: string | null;
  /** Optional project reference asset IDs triggering editor navigation after create. */
  asset_ids?: string[] | null;
  /** Optional look generation prompt triggering editor navigation after create. */
  look_prompt?: string | null;
}

/** Request payload for `characterVoiceOp`. */
export interface CharacterVoiceOpRequest {
  /** Operation (`list_voices` or `set_voice`). */
  action?: string;
  /** Character identifier. */
  character_id?: string | null;
  /** Voice name or identifier. */
  voice?: string | null;
}

/** Request payload for `characterMediaOp`. */
export interface CharacterMediaOpRequest {
  /** Operation (`open_upload`, `check_upload`, `check_look`, or `attach_and_look`). */
  action?: string;
  /** Character identifier. */
  character_id?: string | null;
  /** Target slot (`portrait` or `body`). */
  slot?: string | null;
  /** Previous preview source URL before upload or look generation. */
  prev_src?: string | null;
  /** Previous slot media identifier before upload or look generation. */
  prev_media_id?: string | null;
  /** Project asset IDs to attach as looks. */
  asset_ids?: string[] | null;
  /** Optional look generation prompt. */
  look_prompt?: string | null;
}

/** Viewport click point computed in browser coordinates. */
export interface ViewportPoint {
  /** Horizontal viewport pixel coordinate. */
  x: number;
  /** Vertical viewport pixel coordinate. */
  y: number;
}

/** Public browser runtime API exposed at `window.__flowMcp`. */
export interface FlowMcpRuntime {
  /** Probes Google Flow authentication shell status. */
  checkAuth: () => AuthCheckResult;
  /** Discovers Angular Ivy store services and binds module state. */
  discoverStore: () => Promise<DiscoverStoreResult>;
  /** Reads normalized assets, collections, title, and credits from bound store. */
  readStoreSnapshot: () => StoreSnapshotResult;
  /** Navigates Google Flow home, project tiles, and sub-routes. */
  projectNav: (action: string) => Promise<unknown>;
  /** Lists, renames, or deletes Google Flow projects on home or workspace pages. */
  projectsOp: (req: ProjectsOpRequest) => Promise<unknown>;
  /** Renames or moves tiles and collections to trash. */
  assetOps: (action: string, id: string, extra: AssetRenameExtra | null) => Promise<unknown>;
  /** Creates collections and moves asset tiles across collections. */
  collectionOps: (action: string, arg1: string | null, arg2: string[] | null) => Promise<unknown>;
  /** Fetches a media URL with page credentials and returns Base64 payload metadata. */
  fetchMedia: (u: string, expectedKind: string) => Promise<FetchedMediaPayload>;
  /** Resolves stream and download URLs for a primary media identifier via `as29s`. */
  resolveVideoUrl: (primaryMediaId: string) => Promise<ResolvedMediaResult>;
  /** Configures generation mode, video type, aspect ratio, count, duration, resolution, and model. */
  setupGeneration: (cfg: GenerationConfig) => Promise<{ ok: boolean; error?: string }>;
  /** Attaches ingredient assets or characters and writes the generation prompt. */
  attachIngredients: (cfg: GenerationConfig) => Promise<unknown>;
  /** Clicks the upload trigger button or accepts upload consent dialogs. */
  uploadUiAction: (action: string) => boolean;
  /** Opens the asset editor via Angular Router or grid tile UI controls. */
  openEditAsset: (assetId: string, mediaUrl: string | null, primaryMediaId: string | null) => Promise<unknown>;
  /** Locates the enabled generation submit button and returns its viewport click point. */
  submitGeneration: () => Promise<unknown>;
  /** Creates Flow scenes and adds clips. */
  sceneOp: (req: SceneOpRequest) => Promise<unknown>;
  /** Applies video trim timestamps or drives the scene builder extend workflow. */
  videoOp: (req: VideoOpRequest) => Promise<unknown>;
  /** Opens/exits the character editor and creates or updates character fields. */
  characterOp: (req: CharacterOpRequest) => Promise<unknown>;
  /** Lists available character voices and sets a voice on the character form. */
  characterVoiceOp: (req: CharacterVoiceOpRequest) => Promise<unknown>;
  /** Opens character uploads, attaches project references, and generates looks. */
  characterMediaOp: (req: CharacterMediaOpRequest) => Promise<unknown>;
}

declare global {
  interface Window {
    /** Installed Google Flow MCP runtime facade. */
    __flowMcp?: FlowMcpRuntime;
    /** Google Wiz configuration injected by the Flow server. */
    WIZ_global_data?: WizGlobalData;
  }
}
