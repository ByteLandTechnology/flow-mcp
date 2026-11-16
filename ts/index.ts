// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Browser runtime bundle entrypoint registering window.__flowMcp once per document.

import { checkAuth } from "./check_auth";

if (!window.__flowMcp) {
  window.__flowMcp = {
    checkAuth,
  };
}
