// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Prepares local file paths and uploads media to Flow.
//!
//! Project uploads use the browser runtime in the active project. Menu uploads intercept the
//! file chooser and assign files to the input that Flow creates.

use std::collections::HashSet;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{Value, json};

use crate::engine::{ChromeEngine, validate_local_files};
use crate::project_store::ProjectStoreSession;

/// Menu button that adds ingredients to the prompt box.
pub(crate) const PROMPT_INGREDIENTS_MENU: &str = "Add ingredients to the prompt box";

/// Menu item text (without the icon name) that uploads media into the prompt box.
pub(crate) const PROMPT_UPLOAD_ITEM: &str = "Upload media";

/// Verifies local paths and returns the absolute paths that Chrome uses.
pub(crate) async fn local_upload_paths(files: &[String], label: &str) -> Result<Vec<String>> {
    validate_local_files(Some(files), label).await?;
    let mut paths = Vec::with_capacity(files.len());
    for file in files {
        let path = tokio::fs::canonicalize(file)
            .await
            .with_context(|| format!("Cannot open {label} file: {file}"))?;
        paths.push(
            path.into_os_string()
                .into_string()
                .map_err(|_| anyhow::anyhow!("{label} file path must use UTF-8: {file}"))?,
        );
    }
    Ok(paths)
}

/// Extracts any assets already confirmed before a direct upload failure.
fn partial_uploaded_assets(err: &anyhow::Error) -> Vec<Value> {
    let msg = format!("{err:#}");
    let Some((_, json_part)) = msg.split_once(' ') else {
        return Vec::new();
    };
    serde_json::from_str::<Value>(json_part)
        .ok()
        .and_then(|v| v.get("assets").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

/// Uploads files to the pinned project and falls back to the upload menu when direct upload fails.
pub(crate) async fn upload_project_files(engine: &ChromeEngine, files: &[String]) -> Result<Value> {
    let has_video = files.iter().any(|file| {
        mime_guess::from_path(file)
            .first()
            .is_some_and(|mime| mime.type_() == mime_guess::mime::VIDEO)
    });
    if has_video && eval_value(engine, "document.hidden").await? == Value::Bool(true) {
        // Chrome can leave a video in the loading state while its tab is hidden.
        engine.cdp_call("Page.bringToFront", json!({})).await?;
    }
    let direct = async {
        let project = ProjectStoreSession::open(engine).await?;
        engine
            .upload_files_to("window.__flowMcp.stageMediaFiles()", files)
            .await?;
        project
            .call(
                "projectUpload",
                json!(files.len()),
                Some("upload local media"),
            )
            .await
    }
    .await;
    match direct {
        Ok(result) => Ok(result),
        Err(err) if format!("{err:#}").contains("outcome_unknown") => Err(err),
        Err(err) => {
            let mut confirmed = partial_uploaded_assets(&err);
            let done = confirmed.len().min(files.len());
            if done == files.len() && !confirmed.is_empty() {
                return Ok(json!({
                    "count": confirmed.len(),
                    "assets": confirmed,
                }));
            }
            let mut menu_res = upload_project_files_through_menu(engine, &files[done..]).await?;
            if !confirmed.is_empty()
                && let Some(arr) = menu_res.get_mut("assets").and_then(Value::as_array_mut)
            {
                confirmed.append(arr);
                *arr = confirmed;
                menu_res["count"] = json!(arr.len());
            }
            Ok(menu_res)
        }
    }
}

/// Script that keeps the next file input that the page opens in `window.__fmUploadInput`.
const HOOK_JS: &str = r#"(() => {
  const P = HTMLInputElement.prototype;
  if (window.__fmUploadRestore) window.__fmUploadRestore();
  window.__fmUploadInput = null;
  const origClick = P.click;
  const origPicker = P.showPicker;
  P.click = function () {
    if (this.type === "file") window.__fmUploadInput = this;
    return origClick.call(this);
  };
  if (typeof origPicker === "function") {
    P.showPicker = function () {
      if (this.type === "file") window.__fmUploadInput = this;
      return origPicker.call(this);
    };
  }
  window.__fmUploadRestore = () => {
    P.click = origClick;
    if (typeof origPicker === "function") P.showPicker = origPicker;
    window.__fmUploadRestore = null;
  };
  return true;
})()"#;

/// Script that removes the file input hook.
const UNHOOK_JS: &str = "window.__fmUploadRestore && window.__fmUploadRestore(), true";

/// Evaluates `expr` on the page and returns its JSON value.
async fn eval_value(engine: &ChromeEngine, expr: &str) -> Result<Value> {
    let res = engine
        .cdp_call(
            "Runtime.evaluate",
            json!({ "expression": expr, "returnByValue": true }),
        )
        .await?;
    Ok(res.pointer("/result/value").cloned().unwrap_or(Value::Null))
}

/// Polls until the control that `by` and `name` select is visible, then sends a trusted click to it.
async fn click_when_visible(engine: &ChromeEngine, by: &str, name: &str) -> Result<()> {
    for _ in 0..20 {
        let point = engine
            .call_flow_js("locatePoint", json!([{ "by": by, "name": name }]))
            .await?;
        if engine.click_point(&point).await? {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    anyhow::bail!("{} is not visible", name)
}

/// Clicks the visible upload menu item for `item` across Flow menu variants.
async fn click_upload_item(engine: &ChromeEngine, item: &str) -> Result<()> {
    let prefixed = format!("upload {item}");
    for _ in 0..20 {
        let mut candidates = vec![("menuitem", item), ("text", prefixed.as_str())];
        if item == LIBRARY_UPLOAD_ITEM {
            candidates.push(("menuitem", PROMPT_UPLOAD_ITEM));
            candidates.push(("text", PROMPT_UPLOAD_ITEM));
        }
        for (by, label) in candidates {
            let point = engine
                .call_flow_js("locatePoint", json!([{ "by": by, "name": label }]))
                .await?;
            if engine.click_point(&point).await? {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    anyhow::bail!("{} is not visible", item)
}

/// Opens `menu`, clicks `item`, and waits for the page to create its file input.
async fn open_menu_file_input(engine: &ChromeEngine, menu: &str, item: &str) -> Result<()> {
    let _ = eval_value(engine, "window.__fmUploadInput = null, true").await;
    click_when_visible(engine, "aria-label", menu).await?;
    tokio::time::sleep(Duration::from_millis(400)).await;
    click_upload_item(engine, item).await?;
    for attempt in 0..30 {
        let v = eval_value(engine, "!!window.__fmUploadInput").await?;
        if v.as_bool() == Some(true) {
            return Ok(());
        }
        if attempt % 3 == 1 {
            let _ = engine
                .call_flow_js("uploadUiAction", json!(["accept_consent"]))
                .await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    anyhow::bail!("The '{}' item did not open a file chooser", item)
}

/// Clicks `menu` and its upload entry, and assigns `files` to the file input that the page opens.
async fn upload_steps(
    engine: &ChromeEngine,
    menu: &str,
    item: &str,
    files: &[String],
) -> Result<()> {
    open_menu_file_input(engine, menu, item).await?;
    let multiple = eval_value(
        engine,
        "Boolean(window.__fmUploadInput && window.__fmUploadInput.multiple)",
    )
    .await?
    .as_bool()
    .unwrap_or(false);
    if files.len() <= 1 || multiple {
        return engine
            .upload_files_to("window.__fmUploadInput", files)
            .await
            .context("Failed to assign files to the Flow upload input");
    }
    engine
        .upload_files_to("window.__fmUploadInput", &files[..1])
        .await
        .context("Failed to assign file to the Flow upload input")?;
    for file in &files[1..] {
        tokio::time::sleep(Duration::from_millis(300)).await;
        open_menu_file_input(engine, menu, item).await?;
        engine
            .upload_files_to("window.__fmUploadInput", std::slice::from_ref(file))
            .await
            .context("Failed to assign file to the Flow upload input")?;
    }
    Ok(())
}

/// Uploads `files` through the `menu` button and its upload entry.
pub(crate) async fn upload_through_menu(
    engine: &ChromeEngine,
    menu: &str,
    item: &str,
    files: &[String],
) -> Result<()> {
    engine
        .cdp_call(
            "Page.setInterceptFileChooserDialog",
            json!({ "enabled": true }),
        )
        .await?;
    let res = match eval_value(engine, HOOK_JS).await {
        Ok(_) => upload_steps(engine, menu, item, files).await,
        Err(e) => Err(e),
    };
    let _ = eval_value(engine, UNHOOK_JS).await;
    let _ = engine
        .cdp_call(
            "Page.setInterceptFileChooserDialog",
            json!({ "enabled": false }),
        )
        .await;
    res
}

/// Menu button on the project page that adds media to the project library.
const LIBRARY_MEDIA_MENU: &str = "Add media menu";

/// Menu item text (without the icon name) that uploads files into the project library.
const LIBRARY_UPLOAD_ITEM: &str = "Upload";

/// Uploads images and videos through the workspace menu and returns metadata for saved assets.
async fn upload_project_files_through_menu(
    engine: &ChromeEngine,
    files: &[String],
) -> Result<Value> {
    let _store_guard = engine.lock_project_store().await;
    crate::project::ensure_project_workspace_root(engine).await?;
    crate::project::ensure_flow_store(engine).await?;
    let before_snap = crate::assets::list_assets_with_project(engine).await?;
    let initial_project_id = before_snap.project_id;
    let before: HashSet<String> = before_snap.assets.into_iter().map(|a| a.id).collect();

    upload_through_menu(engine, LIBRARY_MEDIA_MENU, LIBRARY_UPLOAD_ITEM, files).await?;

    let mut ready_count = 0usize;
    for attempt in 0..120 {
        let wait_ms = if attempt < 10 { 500 } else { 1000 };
        tokio::time::sleep(Duration::from_millis(wait_ms)).await;
        let _ = engine
            .call_flow_js("uploadUiAction", json!(["accept_consent"]))
            .await;
        let snap = crate::assets::list_assets_with_project(engine).await?;
        let mut ready = Vec::new();
        for asset in snap.assets {
            if before.contains(&asset.id) || !matches!(asset.kind.as_str(), "image" | "video") {
                continue;
            }
            if asset.media_status.as_deref() == Some("failed") || asset.media_error.is_some() {
                let detail = asset
                    .media_error
                    .unwrap_or_else(|| "upload failed".to_string());
                anyhow::bail!("Menu upload failed for asset '{}': {}", asset.id, detail);
            }
            if !matches!(
                asset.media_status.as_deref(),
                Some("pending" | "scheduled" | "canceled")
            ) && (asset.primary_media_id.is_some() || asset.url.is_some())
            {
                ready.push(asset);
            }
        }
        ready_count = ready.len();
        if ready_count >= files.len() {
            let assets: Vec<Value> = ready
                .into_iter()
                .map(|a| {
                    json!({
                        "id": a.id,
                        "primary_media_id": a.primary_media_id,
                        "name": a.name,
                        "kind": a.kind,
                        "url": a.url,
                        "width": a.width,
                        "height": a.height,
                        "duration": a.duration,
                    })
                })
                .collect();
            return Ok(json!({
                "project_id": snap.project_id.or(initial_project_id),
                "count": assets.len(),
                "method": "menu:upload",
                "assets": assets,
            }));
        }
    }
    anyhow::bail!(
        "Uploaded {} of {} files through the Flow menu within 120 seconds",
        ready_count,
        files.len()
    )
}

/// Returns the IDs of all tiles in the active project.
async fn project_tile_ids(engine: &ChromeEngine) -> Result<HashSet<String>> {
    let snap = crate::assets::list_assets_with_project(engine).await?;
    Ok(snap.assets.into_iter().map(|a| a.id).collect())
}

/// Uploads `files` into the project library, accepts the upload consent dialog, and returns the new image asset IDs.
pub(crate) async fn upload_to_library(
    engine: &ChromeEngine,
    files: &[String],
) -> Result<Vec<String>> {
    let before = project_tile_ids(engine).await?;
    upload_through_menu(engine, LIBRARY_MEDIA_MENU, LIBRARY_UPLOAD_ITEM, files).await?;
    let mut new_ids: Vec<String> = Vec::new();
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(1000)).await;
        let _ = engine
            .call_flow_js("uploadUiAction", json!(["accept_consent"]))
            .await;
        let snap = crate::assets::list_assets_with_project(engine).await?;
        new_ids = snap
            .assets
            .into_iter()
            .filter(|a| !before.contains(&a.id) && a.kind == "image" && a.url.is_some())
            .map(|a| a.id)
            .collect();
        if new_ids.len() >= files.len() {
            return Ok(new_ids);
        }
    }
    anyhow::bail!(
        "Uploaded {} of {} files into the Flow library within 60 seconds",
        new_ids.len(),
        files.len()
    )
}
