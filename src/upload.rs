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

/// Alternate menu item text (without the icon name) that uploads files into the prompt box.
const PROMPT_UPLOAD_FILES_ITEM: &str = "Upload files";

/// Frame slot button labels in `VIDEO_FRAMES` mode (`Start` first, then `End`).
const FRAME_SLOT_BUTTONS: [&str; 2] = ["Start", "End"];

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

/// Uploads files to the pinned project and returns the saved assets.
pub(crate) async fn upload_project_files(engine: &ChromeEngine, files: &[String]) -> Result<Value> {
    let project = ProjectStoreSession::open(engine).await?;
    let has_video = files.iter().any(|file| {
        mime_guess::from_path(file)
            .first()
            .is_some_and(|mime| mime.type_() == mime_guess::mime::VIDEO)
    });
    if has_video && eval_value(engine, "document.hidden").await? == Value::Bool(true) {
        // Chrome can leave a video in the loading state while its tab is hidden.
        engine.cdp_call("Page.bringToFront", json!({})).await?;
    }
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

/// Clicks `upload <item>` (or `upload Upload files` for prompt uploads) when visible.
async fn click_upload_item(engine: &ChromeEngine, item: &str) -> Result<()> {
    let primary = format!("upload {item}");
    if item != PROMPT_UPLOAD_ITEM {
        return click_when_visible(engine, "text", &primary).await;
    }
    let alt = format!("upload {PROMPT_UPLOAD_FILES_ITEM}");
    for _ in 0..20 {
        for candidate in [&primary, &alt] {
            let point = engine
                .call_flow_js("locatePoint", json!([{ "by": "text", "name": candidate }]))
                .await?;
            if engine.click_point(&point).await? {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    anyhow::bail!("Neither '{primary}' nor '{alt}' is visible")
}

/// Waits for `window.__fmUploadInput` to capture a file input and assigns `files` to it.
async fn assign_opened_chooser(engine: &ChromeEngine, item: &str, files: &[String]) -> Result<()> {
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

/// Clicks `menu` (or `Start` and `End` frame slots when `menu` is hidden) and uploads `files`.
async fn upload_steps(
    engine: &ChromeEngine,
    menu: &str,
    item: &str,
    files: &[String],
) -> Result<()> {
    if files.is_empty() {
        return Ok(());
    }
    if menu != PROMPT_INGREDIENTS_MENU {
        click_when_visible(engine, "aria-label", menu).await?;
        tokio::time::sleep(Duration::from_millis(500)).await;
        click_upload_item(engine, item).await?;
        return assign_opened_chooser(engine, item, files).await;
    }

    for _ in 0..20 {
        let menu_point = engine
            .call_flow_js("locatePoint", json!([{ "by": "aria-label", "name": menu }]))
            .await?;
        if engine.click_point(&menu_point).await? {
            tokio::time::sleep(Duration::from_millis(500)).await;
            click_upload_item(engine, item).await?;
            return assign_opened_chooser(engine, item, files).await;
        }

        let start_point = engine
            .call_flow_js(
                "locatePoint",
                json!([{ "by": "text", "name": FRAME_SLOT_BUTTONS[0] }]),
            )
            .await?;
        let end_point = engine
            .call_flow_js(
                "locatePoint",
                json!([{ "by": "text", "name": FRAME_SLOT_BUTTONS[1] }]),
            )
            .await?;
        if (!start_point.is_null() || !end_point.is_null())
            && files.len() > FRAME_SLOT_BUTTONS.len()
        {
            anyhow::bail!(
                "Frame mode accepts at most {} files, got {}",
                FRAME_SLOT_BUTTONS.len(),
                files.len()
            );
        }
        if engine.click_point(&start_point).await? {
            tokio::time::sleep(Duration::from_millis(500)).await;
            click_upload_item(engine, item).await?;
            assign_opened_chooser(engine, item, &files[..1]).await?;
            if files.len() == 2 {
                tokio::time::sleep(Duration::from_millis(350)).await;
                let _ = engine
                    .call_flow_js("uploadUiAction", json!(["accept_consent"]))
                    .await;
                eval_value(engine, HOOK_JS).await?;
                click_when_visible(engine, "text", FRAME_SLOT_BUTTONS[1]).await?;
                tokio::time::sleep(Duration::from_millis(500)).await;
                click_upload_item(engine, item).await?;
                assign_opened_chooser(engine, item, &files[1..2]).await?;
            }
            return Ok(());
        }
        if files.len() == 1 {
            let has_start_chip = eval_value(
                engine,
                "!!document.querySelector('flow-prompt-box flow-image-ingredient-chip')",
            )
            .await?
            .as_bool()
                == Some(true);
            if has_start_chip && engine.click_point(&end_point).await? {
                tokio::time::sleep(Duration::from_millis(500)).await;
                click_upload_item(engine, item).await?;
                return assign_opened_chooser(engine, item, &files[..1]).await;
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    anyhow::bail!("{} is not visible", menu)
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
