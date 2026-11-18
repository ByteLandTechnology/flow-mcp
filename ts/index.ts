// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Browser runtime bundle entrypoint registering window.__flowMcp once per document.

import { assetOps } from "./asset_ops";
import { attachIngredients } from "./attach_ingredients";
import { characterExtraOp } from "./character_extra";
import { characterMediaOp } from "./character_media";
import { characterOp } from "./character_ops";
import { characterVoiceOp } from "./character_voices";
import { checkAuth } from "./check_auth";
import { collectionOps } from "./collection_ops";
import { discoverStore } from "./discover_store";
import { fetchMedia } from "./fetch_media";
import { openEditAsset } from "./open_edit_asset";
import { uploadUiAction } from "./open_upload_trigger";
import { locatePoint } from "./locate";
import { probeStore, readBuildLabel } from "./probe";
import { projectNav } from "./project_nav";
import { projectsOp } from "./projects_ops";
import { readStoreSnapshot } from "./read_store_snapshot";
import { resolveVideoUrl } from "./resolve_video_url";
import { sceneOp } from "./scene_ops";
import { setupGeneration } from "./setup_generation";
import { submitGeneration } from "./submit_generation";
import { videoOp } from "./video_ops";

if (!window.__flowMcp) {
  window.__flowMcp = {
    checkAuth,
    buildLabel: readBuildLabel,
    probeStore,
    locatePoint,
    discoverStore,
    readStoreSnapshot,
    projectNav,
    projectsOp,
    assetOps,
    collectionOps,
    fetchMedia,
    resolveVideoUrl,
    setupGeneration,
    attachIngredients,
    uploadUiAction,
    openEditAsset,
    submitGeneration,
    sceneOp,
    videoOp,
    characterOp,
    characterVoiceOp,
    characterMediaOp,
    characterExtraOp,
  };
}
