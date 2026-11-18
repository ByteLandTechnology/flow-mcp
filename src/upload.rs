// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Uploads local files through a Flow menu item that opens a file chooser.
//!
//! The 2026-11-15 front end has no file input in the document. A menu item creates a detached
//! file input and calls `click()` on it, and Chrome opens the chooser only after a trusted click.
//! This module intercepts the chooser, keeps a reference to the input, and assigns the files to it.

use std::collections::HashSet;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{Value, json};

use crate::engine::ChromeEngine;

/// Menu button that adds ingredients to the prompt box.
pub(crate) const PROMPT_INGREDIENTS_MENU: &str = "Add ingredients to the prompt box";

/// Menu item text (without the icon name) that uploads media into the prompt box.
pub(crate) const PROMPT_UPLOAD_ITEM: &str = "Upload media";

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

/// Returns a script that gives the center point of the menu button with `aria-label` equal to `label`.
fn button_point_js(label: &str) -> Result<String> {
    let label = serde_json::to_string(label)?;
    Ok(format!(
        r#"(() => {{
  const el = Array.from(document.querySelectorAll("button"))
    .find((b) => b.getAttribute("aria-label") === {label} && b.offsetParent !== null);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {{ x: r.x + r.width / 2, y: r.y + r.height / 2 }};
}})()"#
    ))
}

/// Returns a script that gives the center point of the visible menu item or button whose text is `upload <item>`.
fn item_point_js(item: &str) -> Result<String> {
    let item = serde_json::to_string(&item.to_lowercase())?;
    Ok(format!(
        r#"(() => {{
  const want = "upload " + {item};
  const el = Array.from(document.querySelectorAll('[role="menuitem"], button')).find((e) =>
    e.offsetParent !== null &&
    (e.innerText || "").trim().replace(/\s+/g, " ").toLowerCase() === want);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {{ x: r.x + r.width / 2, y: r.y + r.height / 2 }};
}})()"#
    ))
}

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

/// Polls `expr` until it returns a point, then sends a trusted click to it.
async fn click_when_visible(engine: &ChromeEngine, expr: &str, what: &str) -> Result<()> {
    for _ in 0..20 {
        let point = eval_value(engine, expr).await?;
        if engine.click_point(&point).await? {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    anyhow::bail!("{} is not visible", what)
}

/// Clicks `menu` and its `upload <item>` entry, and assigns `files` to the file input that the page opens.
async fn upload_steps(
    engine: &ChromeEngine,
    menu: &str,
    item: &str,
    files: &[String],
) -> Result<()> {
    click_when_visible(engine, &button_point_js(menu)?, menu).await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    click_when_visible(engine, &item_point_js(item)?, item).await?;
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
