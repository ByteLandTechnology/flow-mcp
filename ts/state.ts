// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Module-scoped browser runtime state replacing loose window globals.

import type {
  CachedMediaInfo,
  FlowStoreHandle,
  FlowStoreService,
  NgLView,
  PromptStateController,
} from "./types";

/** Shared mutable runtime state scoped to one page document inside the bundle. */
export interface RuntimeState {
  /** Captured Angular Ivy integer-keyed LView registry map. */
  ngLViewMap: Map<number, NgLView> | null;
  /** Bound Angular project store service handle. */
  lService: FlowStoreService | null;
  /** Project identifier active when `lService` was bound. */
  projectId: string | null;
  /** Location pathname active when `lService` was bound. */
  routePath: string | null;
  /** Normalized store mutation and snapshot handle. */
  store: FlowStoreHandle | null;
  /** Cached resolved media URLs keyed by primary media identifier. */
  mediaInfoCache: Map<string, CachedMediaInfo>;
  /** Most recently captured prompt validation and submission state controller. */
  promptState: PromptStateController | null;
}

/** Single mutable runtime state container for the current page session. */
export const runtimeState: RuntimeState = {
  ngLViewMap: null,
  lService: null,
  projectId: null,
  routePath: null,
  store: null,
  mediaInfoCache: new Map<string, CachedMediaInfo>(),
  promptState: null,
};

/** Clears bound store handles and cached route context. */
export function clearStore(): void {
  runtimeState.lService = null;
  runtimeState.projectId = null;
  runtimeState.routePath = null;
  runtimeState.store = null;
}
