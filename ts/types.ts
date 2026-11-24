// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Shared TypeScript interfaces for the Google Flow browser runtime bundle.

/** Ordered Angular Ivy logical view slot array. */
export type NgLView = unknown[];

/** Google internal Wiz payload attached to window. */
export interface WizGlobalData {
  /** True when the server rendered an authenticated Google session. */
  awbSEf?: boolean;
  /** Signed request token for batchexecute calls. */
  SNlM0e?: string;
  /** Session identifier for batchexecute calls. */
  FdrFJe?: string;
  /** Build label for batchexecute calls. */
  cfb2h?: string;
  /** Frontend data path prefix for batchexecute calls. */
  eptZe?: string;
  /** Encoded FIFE host configuration string. */
  TSDtV?: string;
}

/** Angular Router subset used for in-app navigation. */
export interface AngularRouter {
  /** Navigate to an Angular route command array with optional extras. */
  navigate: (commands: unknown[], extras?: Record<string, unknown>) => Promise<boolean>;
  /** Router location reference. */
  location: unknown;
  /** Router configuration options. */
  options: unknown;
}

/** Destroyable Angular component or service lifecycle handle. */
export interface AngularLifecycleHandle {
  /** Lifecycle destroy marker in the Flow front end from 2026-11-18 on. */
  Ba?: { Va?: boolean };
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
  /** Media MIME type from the Flow front end. */
  mimeType?: string;
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
  /** Uploaded media URL in build 20261120.00, or submission Date in earlier builds. */
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
  /** Video trim start in build 20261120.00. */
  Jc?: number;
  /** Video trim end in build 20261120.00. */
  Pc?: number;
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
  /** Media item identifier on look history entries. */
  id?: string | number;
  /** Primary media identifier for the look. */
  primaryMediaId?: string | number;
  /** Direct look image URL in build 20261120.00. */
  kc?: unknown;
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
  /** Clip status field in the Flow front end from 2026-11-15 on. */
  od?: string;
  /** Clip error field. */
  nf?: unknown;
  /** Clip error field in the Flow front end from 2026-11-15 on. */
  Bf?: unknown;
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
  /** Direct clip media URL in build 20261120.00. */
  kc?: unknown;
  /** Trim start in seconds. */
  Mh?: number;
  /** Trim end in seconds. */
  Eh?: number;
  /** Clip duration in seconds. */
  rc?: number;
  /** Scene clip start in build 20261120.00. */
  Ji?: number;
  /** Scene clip end in build 20261120.00. */
  Ci?: number;
  /** Scene clip duration in build 20261120.00. */
  nc?: number;
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
  /** Uppercase tile kind (`IMAGE`, `VIDEO`, `AUDIO`, `SCENE`, `CHARACTER`, `COLLECTION`). */
  type?: string;
  /** True while creation mutation is pending. */
  isPending?: boolean;
  /** Parent collection identifier. */
  Fc?: string | number;
  /** Parent collection identifier in the current project store. */
  Cc?: string;
  /** Parent collection identifier in build 20261120.00. */
  Dc?: string;
  /** Soft-trash flag variants. */
  trashed?: boolean;
  /** Secondary trash flag. */
  isTrashed?: boolean;
  /** Minified trash flag. */
  yb?: boolean;
  /** Minified trash flag of the 2026-11-15 front end. */
  Ab?: boolean;
  /** Trash flag in build 20261118.14. */
  Bb?: boolean;
  /** Trash flag in build 20261120.00. */
  Cb?: boolean;
  /** Primary uppercase media container. */
  Fb?: FlowMediaPayload;
  /** Legacy lowercase media container. */
  fb?: FlowMediaPayload;
  /** Primary media container in the Flow front end from 2026-11-15 on. */
  Eb?: FlowMediaPayload;
  /** Primary media container in build 20261120.00. */
  Kb?: FlowMediaPayload;
  /** Character preview fallback URL. */
  ue?: string;
  /** Preview media identifier or fallback URL in build 20261120.00. */
  Kd?: string;
  /** Character look slots map. */
  oi?: Map<unknown, CharacterLookEntry>;
  /** Character look slots map in build 20261120.00. */
  Ng?: Map<unknown, CharacterLookEntry>;
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

/** Unified project store handle bound into module state. */
export interface FlowStoreHandle {
  /** Active project identifier extracted from the route. */
  projectId: string | null;
  /** Returns true when the bound store matches the active route and remains live. */
  isCurrent: () => boolean;
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

/** Serialized prompt text segment sent to `PromptStateController`. */
export interface PromptTextSegment {
  /** Segment kind, such as `"text"`. */
  type: string;
  /** Segment text payload. */
  content: string;
}

/** Serialized prompt document accepted by `PromptStateController`. */
export interface PromptDocumentPayload {
  /** Prompt segments in earlier builds. */
  Oe?: PromptTextSegment[];
  /** Prompt segments in build 20261120.00. */
  Te?: PromptTextSegment[];
}

/** Flow prompt validation and submission state controller. */
export interface PromptStateController {
  /** Applies serialized prompt segments in earlier builds. */
  Wn?: (doc: PromptDocumentPayload) => void;
  /** Applies serialized prompt segments in build 20261120.00. */
  Gp?: (doc: PromptDocumentPayload) => void;
  /** Prompt text helper object. */
  prompt?: {
    /** Returns true when the prompt is empty in earlier builds. */
    Le?: () => boolean;
    /** Returns true when the prompt is empty in build 20261120.00. */
    Ke?: () => boolean;
  };
  /** Validator status object in earlier builds. */
  lf?: { isValid?: () => boolean; jYa?: () => string };
  /** Validator status object in build 20261120.00. */
  Ff?: { isValid?: () => boolean; N7a?: () => string };
  /** Mode, output count, and model config signals. */
  config?: {
    mode?: () => string;
    outputCount?: () => number;
  };
  /** Attached item signal container in legacy builds. */
  kc?: { all?: () => Array<Record<string, unknown>> };
  /** Attached item signal container in build 20261120.00 and later. */
  oc?: { all?: () => Array<Record<string, unknown>> };
}

/** Rich text editor component wrapper that holds a ProseMirror view. */
export interface RichTextEditorInstance {
  /** ProseMirror editor view in earlier builds. */
  th?: unknown;
  /** ProseMirror editor view in build 20261120.00. */
  Tb?: unknown;
}

/** Writable signal subset that controls an open state boolean. */
export type BooleanOverlaySignal =
  | ((() => unknown) & { set?: (open: boolean) => void })
  | { set?: (open: boolean) => void };

/** Angular component controller for a base prompt box. */
export interface BasePromptBoxInstance {
  /** Prompt state signal container. */
  Qa?: PromptStateController;
  /** Returns the rich editor wrapper in earlier builds. */
  CQ?: () => RichTextEditorInstance | null | undefined;
  /** Returns the rich editor wrapper in build 20261120.00. */
  IU?: () => RichTextEditorInstance | null | undefined;
  /** Submits or prepares prompt state in earlier builds. */
  Wn?: (...args: unknown[]) => unknown;
  /** Submits or prepares prompt state in build 20261120.00. */
  Gp?: (...args: unknown[]) => unknown;
  /** Returns true when the prompt box can submit in earlier builds. */
  qf?: () => boolean;
  /** Returns true when the prompt box can submit in build 20261120.00. */
  wf?: () => boolean;
  /** Controls settings overlay visibility in earlier builds. */
  VJ?: BooleanOverlaySignal;
  /** Controls settings overlay visibility in build 20261120.00. */
  rN?: BooleanOverlaySignal;
  /** Returns the disabled submit reason in earlier builds. */
  sL?: () => string;
  /** Returns the disabled submit reason in build 20261120.00. */
  vV?: () => string;
}

/** Host container managing manual and agent prompt boxes. */
export interface PromptBoxHost {
  /** Toggles between manual and agent composer modes in earlier builds. */
  Tx?: () => void;
  /** Toggles between manual and agent composer modes in build 20261120.00. */
  Xu?: () => void;
  /** Returns true while agent mode is active in earlier builds. */
  Sk?: () => boolean;
  /** Returns true while agent mode is active in build 20261120.00. */
  Nl?: () => boolean;
  /** Returns the active manual base prompt box instance in earlier builds. */
  mt?: () => BasePromptBoxInstance | null | undefined;
  /** Returns the active manual base prompt box instance in build 20261120.00. */
  zr?: () => BasePromptBoxInstance | null | undefined;
}

/** Angular project page component instance. */
export interface ProjectPageInstance {
  /** Attaches a tile reference directly into composer state on legacy builds. */
  Ph?: (tile: FlowTile) => void;
  /** Prompt state and attached item signal container. */
  Qa?: PromptStateController;
  /** Store or mode mutation signal container. */
  ub?: { mutate?: (value: unknown) => unknown };
  /** Store mutation dispatcher on the project page. */
  he?: { mutate?: (value: unknown) => unknown };
  /** Optional attached item signal container alias. */
  oc?: { all?: () => Array<Record<string, unknown>> };
  /** Secondary agent state signal container. */
  Ta?: { mutate?: (value: unknown) => void };
  /** Returns the prompt box host component in earlier builds. */
  jQ?: () => PromptBoxHost | null | undefined;
  /** Returns the prompt box host component in build 20261120.00. */
  NF?: () => PromptBoxHost | null | undefined;
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
  /** Minified transaction builder alias in earlier builds. */
  Fi?: ProseMirrorTransaction;
  /** Minified transaction builder alias in build 20261120.00. */
  uj?: ProseMirrorTransaction;
}

/** ProseMirror editor view subset. */
export interface ProseMirrorView {
  /** Current editor state. */
  state: ProseMirrorState;
  /** Root DOM element of the editor view. */
  dom?: Element;
  /** Standard transaction dispatch function. */
  dispatch?: (tr: ProseMirrorTransaction) => void;
  /** Minified transaction dispatch alias in earlier builds. */
  Qd?: (tr: ProseMirrorTransaction) => void;
  /** Minified transaction dispatch alias in build 20261120.00. */
  Td?: (tr: ProseMirrorTransaction) => void;
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
  /** Media kind from the wire response when known. */
  media_kind?: "video" | "image" | "audio";
}

/** Result returned by `checkAuth`. */
export interface AuthCheckResult {
  /** True when Flow confirms an active workspace session. */
  signed_in: boolean;
  /** True when route, Wiz flags, or backend errors reject the session. */
  explicit_signed_out: boolean;
  /** True when the session token expired and the workspace page must reload. */
  token_expired: boolean;
  /** HTTP status code of the backend probe, or 0 when skipped. */
  status: number;
  /** Short code that describes the verification outcome. */
  reason: string;
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
  /** Optional compatibility or discovery error code. */
  error?: string;
}

/** Asset entry normalized for `readStoreSnapshot`. */
export interface SnapshotAssetItem {
  /** Tile or clip workflow identifier. */
  id: string;
  /** Display name. */
  name: string;
  /** Asset kind (`image`, `video`, `audio`, `scene`, or `character`). */
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
  | {
      ok: true;
      url: string;
      download_url: string;
      candidates: string[];
      media_kind?: "video" | "image" | "audio";
    };

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
  /** Optional callback wait limit in milliseconds for `add_clips`. */
  timeout_ms?: number | null;
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

/** Request payload for `characterExtraOp`. */
export interface CharacterExtraOpRequest {
  /** Operation (`apply_voice`, `audition_voice`, `preview_voice`, `delete_portrait`, or `list_all_voices`). */
  action?: string;
  /** Base voice name to select in the voice dialog. */
  voice?: string | null;
  /** Sample dialogue text for a custom voice (120 characters at most). */
  sample?: string | null;
  /** Customize performance text for a custom voice. */
  performance?: string | null;
  /** Name of the custom voice to save. */
  voice_name?: string | null;
}

/** Viewport click point computed in browser coordinates. */
export interface ViewportPoint {
  /** Horizontal viewport pixel coordinate. */
  x: number;
  /** Vertical viewport pixel coordinate. */
  y: number;
}

/** Viewport coordinates of a control center. */
export interface ViewportPoint {
  /** Horizontal viewport coordinate in CSS pixels. */
  x: number;
  /** Vertical viewport coordinate in CSS pixels. */
  y: number;
}

/** Selects a visible control by its accessible name. */
export interface LocatePointRequest {
  /** `aria-label` matches a button label exactly. `text` matches the whole visible text of a menu item or button, ignoring case and spacing. `menuitem` matches a menu item whose text is the name, with or without an icon word before it. */
  by: "aria-label" | "text" | "menuitem";
  /** Label or text to match. */
  name: string;
}

/** Request for `tileDomOp`. */
export interface TileDomOpRequest {
  /** `locate`, `state`, `view`, `open_view`, `text_select`, `text_value`, or `dismiss`. */
  action: string;
  /** Store tile ID for `locate` and `state`, or the collection ID for `open_view` (empty for the main grid). */
  id?: string;
}

/** One check of the store probe. */
export interface StoreProbeCheck {
  /** Stable check name, for example `tile_map`. */
  name: string;
  /** True when the check passed. */
  ok: boolean;
  /** Short human-readable detail. */
  detail: string;
}

/** Result of the non-mutating front-end build and project store probe. */
export interface StoreProbeResult {
  /** Front-end build label, or null when the page publishes none. */
  build: string | null;
  /** True when the build is verified and all checks and operations pass. */
  ok: boolean;
  /** Build and store checks in run order. */
  checks: StoreProbeCheck[];
  /** Compatibility of each managed internal operation. */
  operations: Record<string, { ok: boolean; failed_checks: StoreProbeCheck[] }>;
}

/** Public browser runtime API exposed at `window.__flowMcp`. */
export interface FlowMcpRuntime {
  /** Returns the temporary input for a local media upload. */
  stageMediaFiles: typeof import("./project_upload").stageMediaFiles;
  /** Uploads local media to the pinned project. */
  projectUpload: typeof import("./project_upload").projectUpload;
  /** Allocates an ID for a new Agent session. */
  agentAllocate: typeof import("./agent_chat").agentAllocate;
  /** Checks the project and lifecycle of the bound Agent. */
  agentBound: typeof import("./agent_chat").agentBound;
  /** Checks for a turn that still uses the Agent transport. */
  agentBusy: typeof import("./agent_chat").agentBusy;
  /** Runs one operation on the bound Agent. */
  agentOp: typeof import("./agent_chat").agentOp;
  /** Returns the project page prototype for CDP instance discovery. */
  agentPrototype: typeof import("./agent_chat").agentPrototype;
  /** Checks the Agent build and chat exports. */
  agentStatus: typeof import("./agent_chat").agentStatus;
  /** Binds the Agent services of the project page. */
  bindAgent: typeof import("./agent_chat").bindAgent;
  /** Verifies Google Flow workspace authentication on the active page. */
  checkAuth: () => Promise<AuthCheckResult>;
  /** Discovers Angular Ivy store services and binds module state. */
  discoverStore: () => Promise<DiscoverStoreResult>;
  /** Reads normalized assets, collections, title, and credits from bound store. */
  readStoreSnapshot: () => StoreSnapshotResult;
  /** Navigates Google Flow home, project tiles, and sub-routes. */
  projectNav: (action: string) => Promise<unknown>;
  /** Lists, renames, or deletes Google Flow projects on home or workspace pages. */
  projectsOp: (req: ProjectsOpRequest) => Promise<unknown>;
  /** Renames or moves asset tiles to trash. */
  assetOps: (action: string, id: string, extra: AssetRenameExtra | null) => Promise<unknown>;
  /** Moves one asset to trash in the pinned project store. */
  trashAssetOp: (projectId: string, session: string, id: string) => Promise<unknown>;
  /** Reports the project store status for one project. */
  projectStoreStatus: (projectId: string) => unknown;
  /** Finds the active project store in the Angular view registry. */
  bindProjectStore: (maps: unknown[], projectId: string) => unknown;
  /** Binds the Angular view registry that contains the selected host. */
  bindAngularViews: (maps: unknown[], selector: string) => boolean;
  /** Reads or changes tiles in the pinned project store. */
  collectionOps: (
    projectId: string,
    session: string,
    request: import("./collection_ops").CollectionRequest,
  ) => Promise<unknown>;
  /** Fetches a media URL with page credentials and returns Base64 payload metadata. */
  fetchMedia: (u: string, expectedKind: string) => Promise<FetchedMediaPayload>;
  /** Resolves stream and download URLs for a primary media identifier via `as29s`. */
  resolveVideoUrl: (
    primaryMediaId: string,
    timeoutMs?: number | null,
    bypassCache?: boolean,
  ) => Promise<ResolvedMediaResult>;
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
  /** Reads or changes character notes in the pinned project. */
  characterBioOp: (
    projectId: string,
    session: string,
    request: import("./character_bio").CharacterBioRequest,
  ) => Promise<unknown>;
  /** Lists available character voices and sets a voice on the character form. */
  characterVoiceOp: (req: CharacterVoiceOpRequest) => Promise<unknown>;
  /** Opens character uploads, attaches project references, and generates looks. */
  characterMediaOp: (req: CharacterMediaOpRequest) => Promise<unknown>;
  /** Saves custom voices, lists all voices, previews the voice, and deletes the portrait. */
  characterExtraOp: (req: CharacterExtraOpRequest) => Promise<unknown>;
  /** Returns the front-end build label of the page, or null. */
  buildLabel: () => string | null;
  /** Checks front-end build compatibility outside an open project. */
  probeBuild: () => StoreProbeResult;
  /** Checks the bound project store shape without calling a mutation. */
  probeStore: () => StoreProbeResult;
  /** Returns the click point of a visible control by accessible name, or null. */
  locatePoint: (req: LocatePointRequest) => ViewportPoint | null;
  /** Locates a project tile in the page, reads its trash state, or closes an open menu. */
  tileDomOp: (req: TileDomOpRequest) => Promise<unknown>;
}

declare global {
  interface Window {
    /** Installed Google Flow MCP runtime facade. */
    __flowMcp?: FlowMcpRuntime;
    /** Google Wiz configuration injected by the Flow server. */
    WIZ_global_data?: WizGlobalData;
  }
}
