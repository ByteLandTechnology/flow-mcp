// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Prepares local file paths and uploads media to Flow.
//!
//! Project uploads use the browser runtime in the active project when supported, and fall back
//! to the workspace upload menu or file chooser when direct upload services are unavailable.

use std::collections::HashSet;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{Value, json};

use crate::engine::{ChromeEngine, validate_local_files};
use crate::project::ensure_flow_store_or_dom;
use crate::project_store::{ProjectStoreSession, can_use_ui_fallback};

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

/// Returns true when any file path in `files` has a video MIME type.
fn contains_video_file(files: &[String]) -> bool {
    files.iter().any(|file| {
        mime_guess::from_path(file)
            .first()
            .is_some_and(|mime| mime.type_() == mime_guess::mime::VIDEO)
    })
}

/// Uploads files to the pinned project and returns the saved assets, falling back to UI upload on unsupported builds.
pub(crate) async fn upload_project_files(engine: &ChromeEngine, files: &[String]) -> Result<Value> {
    if contains_video_file(files)
        && eval_value(engine, "document.hidden")
            .await
            .unwrap_or(Value::Null)
            == Value::Bool(true)
    {
        // Chrome can leave a video in the loading state while its tab is hidden.
        engine.cdp_call("Page.bringToFront", json!({})).await?;
    }
    match ProjectStoreSession::open(engine).await {
        Ok(project) => {
            engine
                .upload_files_to("window.__flowMcp.stageMediaFiles()", files)
                .await?;
            match project
                .call(
                    "projectUpload",
                    json!(files.len()),
                    Some("upload local media"),
                )
                .await
            {
                Ok(val) => Ok(val),
                Err(err) if can_use_ui_fallback(&err) => {
                    drop(project);
                    upload_project_files_ui(engine, files).await
                }
                Err(err) => Err(err),
            }
        }
        Err(err) if can_use_ui_fallback(&err) => upload_project_files_ui(engine, files).await,
        Err(err) => Err(err),
    }
}

/// Uploads local images and videos through the workspace menu or file input and waits for new assets.
async fn upload_project_files_ui(engine: &ChromeEngine, files: &[String]) -> Result<Value> {
    ensure_flow_store_or_dom(engine).await?;
    let before_snap = crate::assets::list_assets_with_project(engine).await?;
    let project_id = before_snap.project_id;
    let before: HashSet<String> = before_snap.assets.into_iter().map(|a| a.id).collect();

    if upload_through_menu(engine, LIBRARY_MEDIA_MENU, LIBRARY_UPLOAD_ITEM, files)
        .await
        .is_err()
    {
        let cap = engine
            .call_flow_js("uploadUiAction", json!(["capture_project_file_input"]))
            .await?;
        let selector = if cap.as_bool() == Some(true) {
            r#"input[type="file"][data-flow-mcp-upload="project"]"#
        } else {
            cap.get("selector")
                .and_then(Value::as_str)
                .context("Could not find a workspace upload button or file input")?
        };
        engine
            .upload_files(selector, files)
            .await
            .context("Failed to assign files to the workspace upload input")?;
    }

    let mut matched = Vec::new();
    for _ in 0..80 {
        tokio::time::sleep(Duration::from_millis(750)).await;
        let _ = engine
            .call_flow_js("uploadUiAction", json!(["accept_consent"]))
            .await;
        let snap = engine
            .call_flow_js("readStoreSnapshot", json!([true]))
            .await?;
        let Some(raw_assets) = snap.get("assets").and_then(Value::as_array) else {
            continue;
        };
        matched = raw_assets
            .iter()
            .filter(|a| {
                let id = a.get("id").and_then(Value::as_str).unwrap_or("");
                let kind = a.get("kind").and_then(Value::as_str).unwrap_or("");
                !id.is_empty() && !before.contains(id) && matches!(kind, "image" | "video")
            })
            .map(|a| {
                json!({
                    "id": a.get("id"),
                    "primary_media_id": a.get("primary_media_id"),
                    "name": a.get("name"),
                    "kind": a.get("kind"),
                })
            })
            .collect();
        if matched.len() >= files.len() {
            return Ok(json!({
                "project_id": project_id,
                "count": matched.len(),
                "assets": matched,
                "method": "ui:upload",
            }));
        }
    }
    anyhow::bail!(
        "outcome_unknown (project upload UI): observed {} of {} uploaded assets within 60 seconds",
        matched.len(),
        files.len()
    )
}

/// Script that keeps the next file input that the page clicks in `window.__fmUploadInput`.
const HOOK_JS: &str = r#"(() => {
  const P = HTMLInputElement.prototype;
  if (window.__fmUploadRestore) window.__fmUploadRestore();
  window.__fmUploadInput = null;
  const orig = P.click;
  P.click = function () {
    if (this.type === "file") window.__fmUploadInput = this;
    return orig.call(this);
  };
  window.__fmUploadRestore = () => { P.click = orig; window.__fmUploadRestore = null; };
  return true;
})()"#;

/// Script that removes the click hook.
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

/// Clicks an upload menu entry matching either `upload <item>` or `<item>`.
async fn click_upload_menu_entry(engine: &ChromeEngine, item: &str) -> Result<()> {
    let prefixed = format!("upload {item}");
    for _ in 0..20 {
        for spec in [
            json!([{ "by": "text", "name": prefixed }]),
            json!([{ "by": "menuitem", "name": item }]),
            json!([{ "by": "text", "name": item }]),
        ] {
            let point = engine.call_flow_js("locatePoint", spec).await?;
            if engine.click_point(&point).await? {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    anyhow::bail!("{} is not visible", item)
}

/// Clicks `menu` and its upload entry, and assigns `files` to the file input that the page opens.
async fn upload_steps(
    engine: &ChromeEngine,
    menu: &str,
    item: &str,
    files: &[String],
) -> Result<()> {
    click_when_visible(engine, "aria-label", menu).await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    click_upload_menu_entry(engine, item).await?;
    let mut opened = false;
    for _ in 0..30 {
        let v = eval_value(engine, "!!window.__fmUploadInput").await?;
        if v.as_bool() == Some(true) {
            opened = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    anyhow::ensure!(opened, "The '{}' item did not open a file chooser", item);
    engine
        .upload_files_to("window.__fmUploadInput", files)
        .await
        .context("Failed to assign files to the Flow upload input")
}

/// Uploads `files` through the `menu` button and its `upload <item>` entry.
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
