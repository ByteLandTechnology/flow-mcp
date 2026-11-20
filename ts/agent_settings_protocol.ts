// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// MCP fields and native messages for Agent project settings.

/** Approval policy in an Agent project. */
export type ConfirmPolicy = "always" | "never";

/** Default generation options to change for one media type. */
export interface GenerationDefaultsPatch {
  /** Flow model ID. */
  model?: string | null;
  /** Aspect ratio such as `16:9`. */
  aspect_ratio?: string | null;
  /** Number of outputs. */
  output_count?: number | null;
}

/** Card contents that MCP can read and change. */
export interface MemoryCardFields {
  /** Card title. */
  title: string;
  /** Instructions and other project information. */
  description: string;
  /** True when the Agent uses this card. */
  enabled: boolean;
  /** Main media IDs of referenced images. */
  image_media_ids: string[];
  /** IDs of referenced characters. */
  character_ids: string[];
  /** IDs of referenced likenesses. */
  likeness_ids: string[];
}

/** Card fields to change. The Rust tool serializes absent fields as null. */
type MemoryCardPatch = { [Field in keyof MemoryCardFields]?: MemoryCardFields[Field] | null };

/** One change to the project's memory cards. */
export type MemoryPatch =
  | { action: "create"; card: MemoryCardPatch }
  | { action: "update"; id: string; card: MemoryCardPatch }
  | { action: "delete"; id: string };

/** Project settings supplied by the MCP caller. */
export interface AgentSettingsPatch {
  /** Permission policy for generation. */
  confirm_before_generating?: ConfirmPolicy | null;
  /** Image defaults to change. */
  image_defaults?: GenerationDefaultsPatch | null;
  /** Video defaults to change. */
  video_defaults?: GenerationDefaultsPatch | null;
  /** Change to one memory card. */
  memory?: MemoryPatch | null;
}

/** Native message with a mutable copy operation. */
interface NativeMessage {
  /** Copies the message and any fields that MCP does not expose. */
  clone(): this;
}

/** A native memory card. */
export interface NativeMemoryCard extends NativeMessage {
  /** Gets its persistent ID. */
  getId(): string;
  /** Gets its title. */
  Ww(): string;
  /** Gets its description. */
  xl(): string;
  /** Gets its enabled state. */
  Vl(): boolean;
  /** Gets referenced image media IDs. */
  mB(): string[];
  /** Gets referenced character IDs. */
  KH(): string[];
  /** Gets referenced likeness IDs. */
  MH(): string[];
}

/** Native project memory, named the project brief in its update mask. */
export interface NativeMemory extends NativeMessage {
  /** Gets the current cards. */
  ML(): NativeMemoryCard[];
}

/** Native defaults for either media type. */
export interface NativeDefaults extends NativeMessage {
  /** Gets the output count. */
  bz(): number;
  /** Gets the native aspect ratio code. */
  Pg(): number;
  /** Sets the native aspect ratio code. */
  setAspectRatio(code: number): void;
}

/** Native defaults for image generation. */
export interface NativeImageDefaults extends NativeDefaults {
  /** Gets the image model ID. */
  QY(): string;
  /** Sets the image model ID. */
  YN(model: string): void;
}

/** Native defaults for video generation. */
export interface NativeVideoDefaults extends NativeDefaults {
  /** Gets the video model ID. */
  ZY(): string;
  /** Sets the video model ID. */
  cO(model: string): void;
}

/** Native generation defaults under the project metadata. */
export interface NativeGenerationDefaults extends NativeMessage {
  /** Gets image defaults. */
  rR(): NativeImageDefaults;
  /** Gets video defaults. */
  sR(): NativeVideoDefaults;
}

/** Native parts of the project metadata used by Agent. */
export interface NativeSettings {
  /** Gets the confirmation policy code. */
  NL(): number;
  /** Gets the generation defaults. */
  PH(): NativeGenerationDefaults;
  /** Gets the memory. */
  QH(): NativeMemory;
}

/** Model catalogue from the same query as the Flow settings panel. */
export interface ModelCatalogue {
  /** Model families by media type. */
  og: { XH: unknown[]; vo: unknown[] };
  /** Account tier defaults. */
  Wx: object;
}

/** Model option from the native settings filter. */
export interface ModelOption {
  /** Flow model ID. */
  Zf: string;
  /** Label for the model. */
  displayName: string;
  /** True when the account cannot use this model. */
  isDisabled: boolean;
}

/** Verified names of browser exports used by Agent settings. */
export interface AgentSettingsExports {
  /** Angular token for the project metadata service. */
  projectService: Function;
  /** Returns the active project metadata query key. */
  projectKey(projectId: string): unknown[];
  /** Angular token for the model catalogue service. */
  modelService: Function;
  /** Query key for the model catalogue. */
  modelKey: unknown[];
  /** Reads the model catalogue from Flow. */
  fetchModels(service: object): Promise<ModelCatalogue>;
  /** Angular token for the account service tier. */
  serviceTier: Function;
  /** Angular token for the locale. */
  locale: object;
  /** Gets model choices for the media type, aspect ratio, and service tier. */
  modelOptions(input: {
    Mw: unknown[];
    serviceTier: number;
    filters: { Jl: number[]; aspectRatio: string };
    locale: string;
  }): ModelOption[];
  /** Gets the default model ID for the current account tier and media type. */
  defaultModel(input: { Wx: object; serviceTier: number; type: "image" | "video" }): string | undefined;
  /** Selects a model with the same fallback as the native settings panel. */
  selectModel(input: { Nba?: string; options: ModelOption[] }): string | undefined;
  /** Maps native aspect names to display labels. */
  aspectLabels: Record<string, { label: string }>;
  /** Native aspect ratio names for video defaults. */
  videoAspects: string[];
  /** Converts an image aspect name to its native code. */
  imageAspect(aspect: string): number;
  /** Converts a video aspect name to its native code. */
  videoAspect(aspect: string): number;
  /** Native project settings update request. */
  request: new () => object;
  /** Native project metadata message. */
  settings: new () => NativeSettings;
  /** Native update mask. */
  mask: new () => object;
  /** Native memory card. */
  card: new () => NativeMemoryCard;
  /** Native request descriptor constructor. */
  rpc: new (method: object) => { Db(request: object): object };
  /** Native method descriptor for project settings updates. */
  updateMethod: object;
  /** Finalizes a native message. */
  finish<T extends object>(data: T): T;
  /** Sets a nested native message. */
  message(data: object, type: Function, field: number, value: object): void;
  /** Adds field paths to the update mask. */
  maskPaths(mask: object, paths: string[]): object;
  /** Sets a string field. */
  string(data: object, field: number, value: string): void;
  /** Sets a repeated string field. */
  strings(data: object, field: number, values: string[]): void;
  /** Sets an enum field. */
  enumValue(data: object, field: number, value: number): void;
  /** Sets an integer field. */
  integer(data: object, field: number, value: number): void;
  /** Sets a boolean field. */
  boolean(data: object, field: number, value: boolean): void;
  /** Sets all cards of the brief. */
  setCards(memory: NativeMemory, cards: NativeMemoryCard[]): void;
  /** Sets the brief's enabled flag. */
  setMemoryEnabled(memory: NativeMemory, enabled: boolean): void;
}

/** Keys that the compatibility registry maps to native exports. */
export type AgentSettingsExport = keyof AgentSettingsExports;
