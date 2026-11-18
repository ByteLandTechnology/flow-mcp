// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read the Google Flow front-end build label that the page publishes.

/** Returns the front-end build label from `WIZ_global_data.cfb2h`, or null when the page does not publish one. */
export function readBuildLabel(): string | null {
  const label = window.WIZ_global_data?.cfb2h;
  if (typeof label !== "string") return null;
  const trimmed = label.trim();
  return trimmed.length > 0 ? trimmed : null;
}
