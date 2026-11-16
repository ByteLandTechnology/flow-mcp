// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Shared TypeScript interfaces for the Google Flow browser runtime bundle.

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

/** Public browser runtime API exposed at `window.__flowMcp`. */
export interface FlowMcpRuntime {
  /** Probes Google Flow authentication shell status. */
  checkAuth: () => AuthCheckResult;
}

declare global {
  interface Window {
    /** Installed Google Flow MCP runtime facade. */
    __flowMcp?: FlowMcpRuntime;
  }
}
