// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Google Flow asset editing and scene clip selection workflow.
//!
//! Opens the asset or scene editor through the browser runtime, submits edit prompts, and tracks
//! updated or failed variants.

use anyhow::{Context, Result};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashSet;
use tokio::time::Duration;

use crate::assets::{list_assets_with_project, match_asset};
use crate::db::FlowDb;
use crate::download::download_resolved_asset;
use crate::engine::ChromeEngine;
use crate::generation::{
    AssetWaitSpec, WatchedAsset, apply_generation_controls, collect_created_assets,
    format_submit_progress, wait_for_new_assets,
};
use crate::project::{ensure_flow_store, ensure_project_workspace_root};
use crate::queue::{ProgressCallback, SceneParams};

/// Parameters for `flow_edit`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct EditParams {
    /// Case-insensitive asset ID, name, or prompt substring that selects the source asset.
    #[serde(rename = "match")]
    pub(crate) r#match: String,
    /// Edit prompt for the matched asset.
    pub(crate) prompt: String,
}

/// Exits any editor subroute and returns an error when `openEditAsset` reports an alert or clip error.
async fn check_open_edit_errors(
    engine: &ChromeEngine,
    open_res: &serde_json::Value,
    label: &str,
) -> Result<()> {
    if let Some(alert) = open_res
        .get("alert")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        let _ = ensure_project_workspace_root(engine).await;
        anyhow::bail!("Flow cannot edit '{}': {}", label, alert);
    }
    if let Some(sel_err) = open_res
        .get("selection_error")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        let _ = ensure_project_workspace_root(engine).await;
        anyhow::bail!("Flow cannot select clip '{}': {}", label, sel_err);
    }
    Ok(())
}

/// Opens an edit flow for an asset that matches `match_str`, submits `prompt`, and downloads/indexes outputs.
pub(crate) async fn run_edit(
    engine: &ChromeEngine,
    db: &FlowDb,
    match_str: &str,
    prompt: &str,
    on_progress: ProgressCallback,
) -> Result<(Vec<String>, Vec<String>, Vec<String>)> {
    ensure_project_workspace_root(engine).await?;
    let snap = list_assets_with_project(engine).await?;
    let target = match_asset(&snap.assets, match_str, true)
        .cloned()
        .with_context(|| format!("No asset matches '{}' for edit", match_str))?;
    match target.kind.as_str() {
        "scene" => {
            let clip_ids: Vec<&str> = snap
                .assets
                .iter()
                .filter(|a| a.scene_id.as_deref() == Some(target.id.as_str()))
                .map(|a| a.id.as_str())
                .take(6)
                .collect();
            let hint = if clip_ids.is_empty() {
                String::new()
            } else {
                format!(" Available clip IDs: {}.", clip_ids.join(", "))
            };
            anyhow::bail!(
                "Cannot edit scene container '{}' directly; pass one of its video clip IDs to flow_edit.{}",
                target.id,
                hint
            );
        }
        "character" => anyhow::bail!(
            "Cannot edit character '{}' with flow_edit; use flow_character_edit instead.",
            target.id
        ),
        "audio" => anyhow::bail!("Cannot edit audio asset '{}' with flow_edit.", target.id),
        _ => {}
    }
    let before: HashSet<String> = snap.assets.into_iter().map(|a| a.id).collect();

    let label = if target.name.is_empty() {
        target.id.clone()
    } else {
        target.name.clone()
    };
    on_progress(format!("preparing edit for {}", label));

    let edit_mode = if target.kind == "video" {
        "video"
    } else {
        "image"
    };

    let open_args = json!([
        target.id,
        target.url,
        target.primary_media_id,
        target.scene_id
    ]);
    let mut open_res = engine
        .call_flow_async("openEditAsset", open_args.clone())
        .await
        .unwrap_or_default();
    check_open_edit_errors(engine, &open_res, &label).await?;
    let is_editor_open = |res: &serde_json::Value| {
        if res.get("opened").and_then(|v| v.as_bool()) != Some(true)
            || res.get("has_textbox").and_then(|v| v.as_bool()) != Some(true)
            || res.get("selection_error").is_some()
        {
            return false;
        }
        if target.scene_id.is_some() || res.get("scene_id").and_then(|v| v.as_str()).is_some() {
            return res.get("selected_clip_id").and_then(|v| v.as_str())
                == Some(target.id.as_str());
        }
        true
    };
    let mut opened_in_ui = is_editor_open(&open_res);

    if !opened_in_ui && let Some(edit_url) = open_res.get("edit_url").and_then(|v| v.as_str()) {
        engine.navigate(edit_url).await?;
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let _ = ensure_flow_store(engine).await;
        open_res = engine
            .call_flow_async("openEditAsset", open_args)
            .await
            .unwrap_or_default();
        check_open_edit_errors(engine, &open_res, &label).await?;
        opened_in_ui = is_editor_open(&open_res);
    } else if opened_in_ui {
        let _ = ensure_flow_store(engine).await;
    }

    let mut attached_frames: Option<Vec<String>> = None;
    if !opened_in_ui {
        if edit_mode == "video" {
            let _ = ensure_project_workspace_root(engine).await;
            anyhow::bail!(
                "Could not open an inline edit control or editor route for video asset '{}'",
                label
            );
        }
        if ensure_project_workspace_root(engine).await.is_err() {
            let _ = ensure_flow_store(engine).await;
        }
        if target.url.is_some() || target.primary_media_id.is_some() {
            let local_path =
                if let Some(cached) = db.find_existing_file_for_asset(&target.id).await? {
                    cached.file_path
                } else {
                    let downloaded = download_resolved_asset(
                        engine,
                        db,
                        &target,
                        snap.project_id.clone(),
                        snap.project_title.clone(),
                    )
                    .await?;
                    downloaded.file_path
                };
            attached_frames = Some(vec![local_path]);
        }
    }

    let cur_url = engine.current_url().await.unwrap_or_default();
    let in_edit_route = opened_in_ui && (cur_url.contains("/edit/") || cur_url.contains("/scene/"));
    on_progress(format!("submitting edit for {}", label));
    let scene = SceneParams {
        prompt: prompt.to_string(),
        mode: if in_edit_route {
            None
        } else {
            Some(edit_mode.to_string())
        },
        frames: attached_frames,
        count: Some(1),
        ..Default::default()
    };
    let mut net_rx = engine.subscribe_network().await?;
    let submit_res = apply_generation_controls(engine, &scene).await?;
    let submit_summary = format_submit_progress("submitted edit", &submit_res);
    on_progress(submit_summary.clone());

    let before_failed_ids: HashSet<String> = target
        .failed_variants
        .iter()
        .map(|v| v.id.clone())
        .collect();
    let target_was_failed = matches!(target.media_status.as_deref(), Some("failed" | "canceled"));
    let (created, project_id, project_title) = wait_for_new_assets(
        engine,
        AssetWaitSpec {
            before_ids: &before,
            watch_updated: Some(WatchedAsset {
                id: target.id.as_str(),
                primary_media_id: target.primary_media_id.as_deref(),
                before_failed_variant_ids: &before_failed_ids,
                url: target.url.as_deref(),
                was_failed: target_was_failed,
            }),
            expected_count: 1,
            timeout_secs: 420,
            submit_summary: &submit_summary,
        },
        &mut net_rx,
        &on_progress,
    )
    .await?;
    ensure_project_workspace_root(engine).await?;
    Ok(collect_created_assets(
        engine,
        db,
        created,
        project_id,
        project_title,
        true,
        &on_progress,
    )
    .await)
}
