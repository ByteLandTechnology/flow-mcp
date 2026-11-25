// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Google Flow scene creation, clip management, video trimming, and scene video extension.

use anyhow::{Context, Result};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use tokio::time::{Duration, Instant};

use crate::assets::{
    AssetsParams, FlowAsset, RenameEntry, list_assets, list_assets_with_project, match_asset,
    rename_assets, resolve_asset, trash_asset,
};
use crate::db::FlowDb;
use crate::engine::ChromeEngine;
use crate::generation::{collect_created_assets, inspect_generation_network};
use crate::project::{
    ensure_flow_store, ensure_project_workspace_root, project_id_from_url, project_workspace_url,
    read_snapshot,
};
use crate::queue::ProgressCallback;

/// Pre-submit state of a video tile or scene clip used to detect extension updates and failures.
struct ClipBaseline {
    /// Primary media ID recorded before extension submission.
    primary_media_id: Option<String>,
    /// Resolved media URL recorded before extension submission.
    url: Option<String>,
    /// Media status recorded before extension submission, cleared if a failed clip restarts.
    media_status: Option<String>,
    /// Media error recorded before extension submission, cleared if a failed clip restarts.
    media_error: Option<String>,
    /// True when the primary media item was ready before extension submission.
    primary_ready: Option<bool>,
    /// Ordered markers of failed or canceled history items recorded before extension submission.
    failed_history: Vec<String>,
}

impl ClipBaseline {
    /// Captures the baseline fields of one project asset.
    fn from_asset(asset: &FlowAsset) -> Self {
        Self {
            primary_media_id: asset.primary_media_id.clone(),
            url: asset.url.clone(),
            media_status: asset.media_status.clone(),
            media_error: asset.media_error.clone(),
            primary_ready: asset.primary_ready,
            failed_history: asset.failed_history.clone(),
        }
    }

    /// Returns `true` when the baseline already held a failed or canceled state.
    fn was_failed(&self) -> bool {
        matches!(self.media_status.as_deref(), Some("failed" | "canceled"))
            || self.media_error.is_some()
    }
}

/// Checks whether an observed start trim bound matches the requested start time.
fn start_bound_matches(actual: Option<f64>, expected: Option<f64>) -> bool {
    match expected {
        None => actual.is_none_or(|act| act.abs() <= 0.01),
        Some(exp) if exp.abs() <= 0.01 => actual.is_none_or(|act| act.abs() <= 0.01),
        Some(exp) => actual.is_some_and(|act| (act - exp).abs() <= 0.01),
    }
}

/// Checks whether an observed end trim bound matches the requested end time.
fn end_bound_matches(
    actual: Option<f64>,
    expected: Option<f64>,
    before: Option<f64>,
    duration: Option<f64>,
) -> bool {
    match expected {
        None => {
            actual.is_none()
                || actual.zip(duration).is_some_and(|(act, dur)| {
                    dur > 0.0
                        && before.is_none_or(|b| (b - dur).abs() > 0.01)
                        && (act - dur).abs() <= 0.01
                })
        }
        Some(exp) => actual.is_some_and(|act| (act - exp).abs() <= 0.01),
    }
}

/// Polls active project store snapshots until `before.id` holds the requested trim bounds.
async fn confirm_trimmed_video(
    engine: &ChromeEngine,
    before: &FlowAsset,
    start_seconds: Option<f64>,
    end_seconds: Option<f64>,
) -> Result<(Option<f64>, Option<f64>)> {
    let query = AssetsParams {
        kind: Some("video".to_string()),
        resolve_urls: Some(false),
        ..AssetsParams::default()
    };
    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline {
        let videos = list_assets(engine, &query).await?;
        if let Some(video) = videos.iter().find(|a| a.id == before.id)
            && start_bound_matches(video.trim_start_seconds, start_seconds)
            && end_bound_matches(
                video.trim_end_seconds,
                end_seconds,
                before.trim_end_seconds,
                video.duration.or(before.duration),
            )
        {
            return Ok((video.trim_start_seconds, video.trim_end_seconds));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    anyhow::bail!(
        "Failed to confirm updated trim bounds in the Flow project store for video '{}'",
        before.id
    )
}

/// Returns `true` when `asset` currently holds a failed or canceled media or history state.
fn clip_is_failed(asset: &FlowAsset) -> bool {
    matches!(asset.media_status.as_deref(), Some("failed" | "canceled"))
        || asset.media_error.is_some()
        || !asset.failed_history.is_empty()
}

/// Returns `true` when `asset` is a video tile or clip that entered an error state since `before`.
fn clip_entered_error(asset: &FlowAsset, before: &HashMap<String, ClipBaseline>) -> bool {
    if asset.kind != "video" || !clip_is_failed(asset) {
        return false;
    }
    match before.get(&asset.id) {
        None => true,
        Some(prior) => {
            if asset.has_new_failures(&prior.failed_history) {
                return true;
            }
            if asset.primary_ready == Some(true) {
                return false;
            }
            !prior.was_failed()
                || prior.primary_ready == Some(true)
                || asset.primary_media_id != prior.primary_media_id
                || asset.media_error != prior.media_error
        }
    }
}

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
            let _ = read_snapshot(engine).await?;
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
            let _ = read_snapshot(engine).await?;
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
    let mut res = engine.call_flow_async("videoOp", json!([payload])).await?;
    if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        anyhow::bail!(
            "Failed to trim video '{}': {}",
            target.id,
            res.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        );
    }
    let (confirmed_start, confirmed_end) =
        confirm_trimmed_video(engine, &target, start_seconds, end_seconds).await?;
    if let Some(obj) = res.as_object_mut() {
        obj.insert("start_seconds".to_string(), json!(confirmed_start));
        obj.insert("end_seconds".to_string(), json!(confirmed_end));
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
    ensure_project_workspace_root(engine).await?;
    let snap = list_assets_with_project(engine).await?;
    let target = match_asset(&snap.assets, match_str, true)
        .cloned()
        .with_context(|| format!("No asset matches '{}' for video extend", match_str))?;
    anyhow::ensure!(
        target.kind == "video",
        "Asset '{}' is not a video",
        target.id
    );
    let project_id = snap.project_id.clone();

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
    let point = res
        .get("submit_point")
        .context("Video extend did not return a submit point")?;
    // Scene creation can copy the input clip to a new workflow before submission.
    let prepared = list_assets_with_project(engine).await?;
    anyhow::ensure!(
        prepared.project_id == project_id,
        "The Flow project changed"
    );
    let mut before: HashMap<String, ClipBaseline> = prepared
        .assets
        .iter()
        .map(|asset| (asset.id.clone(), ClipBaseline::from_asset(asset)))
        .collect();
    let mut net_rx = engine.subscribe_network().await?;
    engine.click_point(point).await?;

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

        if let Ok(cur_snap) = list_assets_with_project(engine).await {
            for asset in &cur_snap.assets {
                if asset.kind == "video"
                    && let Some(prior) = before.get_mut(&asset.id)
                {
                    if !clip_is_failed(asset) && prior.was_failed() {
                        prior.media_status = asset.media_status.clone();
                        prior.media_error = None;
                        prior.primary_ready = asset.primary_ready;
                        prior.failed_history.clear();
                    } else if asset.failed_history.len() < prior.failed_history.len() {
                        prior.failed_history = asset.failed_history.clone();
                    }
                }
            }
            if let Some(failed_tile) = cur_snap
                .assets
                .iter()
                .find(|a| clip_entered_error(a, &before))
            {
                extend_err = Some(anyhow::anyhow!(
                    "Flow video extend failed on tile {}: {}",
                    failed_tile.id,
                    failed_tile
                        .media_error
                        .as_deref()
                        .or(failed_tile.media_status.as_deref())
                        .unwrap_or("failed")
                ));
                break;
            }
            if !extending {
                let fresh: Vec<FlowAsset> = cur_snap
                    .assets
                    .iter()
                    .filter(|a| {
                        a.kind == "video"
                            && a.url.is_some()
                            && before.get(&a.id).is_none_or(|prior| {
                                a.primary_media_id.as_deref().map_or_else(
                                    || a.url != prior.url,
                                    |media_id| prior.primary_media_id.as_deref() != Some(media_id),
                                )
                            })
                    })
                    .cloned()
                    .collect();
                if !fresh.is_empty() {
                    new_assets = fresh;
                    break;
                }
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
