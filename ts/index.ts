// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Browser runtime bundle entrypoint registering window.__flowMcp once per document.

import { checkAuth } from "./check_auth";
import { discoverStore } from "./discover_store";
import { projectNav } from "./project_nav";
import { projectsOp } from "./projects_ops";
import { readStoreSnapshot } from "./read_store_snapshot";

if (!window.__flowMcp) {
  window.__flowMcp = {
    checkAuth,
    discoverStore,
    readStoreSnapshot,
    projectNav,
    projectsOp,
  };
}
