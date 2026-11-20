// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Google Flow scene creation, clip management, video trimming, and scene video extension.

use anyhow::{Context, Result};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;
use tokio::time::{Duration, Instant};

use crate::assets::{
    AssetsParams, FlowAsset, RenameEntry, list_assets, list_assets_with_project, match_asset,
    rename_assets, resolve_asset, trash_asset,
};
use crate::db::FlowDb;
use crate::engine::ChromeEngine;
use crate::generation::{collect_created_assets, inspect_generation_network};
use crate::project::{
    ensure_flow_store, project_id_from_url, project_workspace_url, wait_flow_mutation_rpc,
};
use crate::queue::ProgressCallback;

/// Parameters for `flow_scenes`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct ScenesParams {
    /// Action name: "list" (default), "create", "add_clips", "rename", or "trash".
    pub(crate) action: Option<String>,
    /// Target scene ID for "add_clips", "rename", or "trash".
    pub(crate) id: Option<String>,
    /// Scene display name for "create", "rename", or matching "trash".
    pub(crate) name: Option<String>,
    /// Optional source video or asset IDs for "create"; required for "add_clips".
    pub(crate) asset_ids: Option<Vec<String>>,
    /// Insertion clip index for "add_clips".
    pub(crate) position: Option<usize>,
}

/// Parameters for `flow_video`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct VideoParams {
    /// Action name: "trim" or "extend".
    pub(crate) action: String,
    /// Video asset ID, exact name, or case-insensitive substring to match.
    #[serde(rename = "match")]
    pub(crate) r#match: String,
    /// Trim start time in seconds for "trim" (null clears start trim).
    pub(crate) start_seconds: Option<f64>,
    /// Trim end time in seconds for "trim" (null clears end trim).
    pub(crate) end_seconds: Option<f64>,
    /// Extension prompt for "extend".
    pub(crate) prompt: Option<String>,
    /// Existing scene ID to extend inside when available.
    pub(crate) scene_id: Option<String>,
}

/// Dispatches `flow_scenes` actions (`list`, `create`, `add_clips`, `rename`, `trash`).
pub(crate) async fn handle_scenes(
    engine: &ChromeEngine,
    db: &FlowDb,
    req: ScenesParams,
) -> Result<Value> {
    let action = req.action.as_deref().unwrap_or("list").trim();
    match action {
        "list" => {
            let scenes = list_assets(
                engine,
                &AssetsParams {
                    kind: Some("scene".to_string()),
                    ..AssetsParams::default()
                },
            )
            .await?;
            Ok(json!({ "count": scenes.len(), "scenes": scenes }))
        }
        "create" => {
            let asset_ids = req.asset_ids.unwrap_or_default();
            ensure_flow_store(engine).await?;
            let payload = json!({
                "action": "create",
                "asset_ids": asset_ids,
                "name": req.name,
            });
            let res = engine.call_flow_async("sceneOp", json!([payload])).await?;
            if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                anyhow::bail!(
                    "Failed to create scene: {}",
                    res.get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                );
            }
            Ok(res)
        }
        "add_clips" => {
            let scene_id = req.id.context("flow_scenes add_clips requires 'id'")?;
            let asset_ids = req
                .asset_ids
                .filter(|v| !v.is_empty())
                .context("flow_scenes add_clips requires non-empty 'asset_ids'")?;
            ensure_flow_store(engine).await?;
            let payload = json!({
                "action": "add_clips",
                "scene_id": scene_id,
                "asset_ids": asset_ids,
                "position": req.position,
            });
            let res = engine.call_flow_async("sceneOp", json!([payload])).await?;
            if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                anyhow::bail!(
                    "Failed to add clips to scene: {}",
                    res.get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                );
            }
            Ok(res)
        }
        "rename" => {
            let id = req.id.context("flow_scenes rename requires 'id'")?;
            let name = req.name.context("flow_scenes rename requires 'name'")?;
            rename_assets(engine, vec![RenameEntry { id, name }]).await
        }
        "trash" => {
            let target = req
                .id
                .or(req.name)
                .context("flow_scenes trash requires 'id' or 'name'")?;
            trash_asset(engine, db, &target).await
        }
        other => anyhow::bail!("Unknown scene action: {}", other),
    }
}

/// Applies non-destructive start/end trim timestamps to a video tile in Flow.
pub(crate) async fn trim_video(
    engine: &ChromeEngine,
    match_str: &str,
    start_seconds: Option<f64>,
    end_seconds: Option<f64>,
) -> Result<Value> {
    let (target, _, _) = resolve_asset(engine, match_str, true, "flow_video trim").await?;
    let payload = json!({
        "action": "trim",
        "asset_id": target.id,
        "start_seconds": start_seconds,
        "end_seconds": end_seconds,
    });
    let mut net_rx = engine.subscribe_network().await.ok();
    let res = engine.call_flow_async("videoOp", json!([payload])).await?;
    if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        anyhow::bail!(
            "Failed to trim video '{}': {}",
            target.id,
            res.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        );
    }
    if let Some(rx) = net_rx.as_mut() {
        let _ = wait_flow_mutation_rpc(rx, Duration::from_millis(2500)).await;
    }
    Ok(res)
}

/// Extends a matched video asset using Flow's scene extend workflow and downloads new media.
pub(crate) async fn run_video_extend(
    engine: &ChromeEngine,
    db: &FlowDb,
    match_str: &str,
    prompt: &str,
    scene_id: Option<&str>,
    on_progress: ProgressCallback,
) -> Result<(Vec<String>, Vec<String>, Vec<String>)> {
    let snap = list_assets_with_project(engine).await?;
    let target = match_asset(&snap.assets, match_str, true)
        .cloned()
        .with_context(|| format!("No asset matches '{}' for video extend", match_str))?;
    let before_ids: HashSet<String> = snap.assets.iter().map(|a| a.id.clone()).collect();
    let before_target_sig = (target.primary_media_id.clone(), target.url.clone());
    let project_id = snap.project_id.clone();
    let mut net_rx = engine.subscribe_network().await?;

    on_progress(format!("opening extend editor for {}", target.id));
    let req_payload = json!({
        "action": "prepare_extend",
        "asset_id": target.id,
        "scene_id": scene_id,
        "prompt": prompt,
    });
    let mut res = engine
        .call_flow_async("videoOp", json!([req_payload]))
        .await?;
    let opened_scene_id = res
        .get("scene_id")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    if let Some(nav_url) = res.get("need_navigate").and_then(|v| v.as_str()) {
        engine.navigate(nav_url).await?;
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let _ = ensure_flow_store(engine).await;
        let retry_payload = json!({
            "action": "prepare_extend",
            "asset_id": target.id,
            "scene_id": opened_scene_id,
            "prompt": prompt,
        });
        res = engine
            .call_flow_async("videoOp", json!([retry_payload]))
            .await?;
    }

    if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        anyhow::bail!(
            "Failed to submit video extend: {}",
            res.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        );
    }
    if let Some(pt) = res.get("submit_point") {
        engine.click_point(pt).await?;
    }

    on_progress("extending video in Flow scene editor".to_string());
    let deadline = Instant::now() + Duration::from_secs(420);
    let mut new_assets = Vec::new();
    let mut extend_err = None;
    loop {
        tokio::time::sleep(Duration::from_secs(4)).await;
        if let Err(err) = inspect_generation_network(&mut net_rx, &on_progress) {
            extend_err = Some(err);
            break;
        }
        let poll_res = engine
            .call_flow_async("videoOp", json!([{ "action": "poll_extend" }]))
            .await
            .unwrap_or_default();
        let extending = poll_res
            .get("extending")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if extending {
            on_progress("extending video...".to_string());
        }

        if !extending && let Ok(cur_snap) = list_assets_with_project(engine).await {
            let fresh: Vec<FlowAsset> = cur_snap
                .assets
                .iter()
                .filter(|a| {
                    a.kind == "video"
                        && a.url.is_some()
                        && (!before_ids.contains(&a.id)
                            || (a.id == target.id
                                && ((a.primary_media_id.is_some()
                                    && a.primary_media_id != before_target_sig.0)
                                    || a.url != before_target_sig.1)))
                })
                .cloned()
                .collect();
            if !fresh.is_empty() {
                new_assets = fresh;
                break;
            }
            if let Some(failed_tile) = cur_snap.assets.iter().find(|a| {
                a.kind == "video"
                    && !before_ids.contains(&a.id)
                    && matches!(a.media_status.as_deref(), Some("failed" | "canceled"))
            }) {
                extend_err = Some(anyhow::anyhow!(
                    "Flow video extend failed on tile {}: {}",
                    failed_tile.id,
                    failed_tile.media_error.as_deref().unwrap_or("failed")
                ));
                break;
            }
        }
        if Instant::now() >= deadline {
            if new_assets.is_empty() && extend_err.is_none() {
                extend_err = Some(anyhow::anyhow!("Timed out waiting for video extend"));
            }
            break;
        }
    }

    let _ = engine
        .call_flow_async("videoOp", json!([{ "action": "done_scene" }]))
        .await;

    let cur_url = engine.current_url().await.unwrap_or_default();
    if cur_url.contains("/scene/")
        && let Some(pid) = project_id.clone().or_else(|| project_id_from_url(&cur_url))
    {
        let proj_url = project_workspace_url(&cur_url, &pid);
        let _ = engine.navigate(&proj_url).await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
    let _ = ensure_flow_store(engine).await;

    if let Some(err) = extend_err {
        return Err(err);
    }

    let (files, mut created, resources) = collect_created_assets(
        engine,
        db,
        new_assets,
        snap.project_id.clone(),
        snap.project_title.clone(),
        true,
        &on_progress,
    )
    .await;
    if created.is_empty() {
        if let Some(sid) = opened_scene_id {
            created.push(sid);
        } else {
            anyhow::bail!("Video extend finished without producing a new video or scene tile");
        }
    }
    Ok((files, created, resources))
}
