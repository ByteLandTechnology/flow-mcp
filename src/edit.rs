// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Google Flow asset editing and single-clip scene delegation.
//!
//! Opens image and video editors or delegates single-clip scenes and scene clips to the scene
//! builder, enforces fast-fail checks on blocked editors, and polls variant history.

use anyhow::{Context, Result};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;
use tokio::time::Duration;

use crate::assets::{FlowAsset, list_assets_with_project, match_asset};
use crate::db::FlowDb;
use crate::download::{download_resolved_asset, eval_resolve_media_url};
use crate::engine::ChromeEngine;
use crate::generation::{
    AssetWaitSpec, apply_generation_controls, collect_created_assets, format_submit_progress,
    wait_for_new_assets,
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

/// Fails immediately when any new variant on watched or created assets enters a failed state.
pub(crate) fn check_failed_new_variants(
    assets: &[FlowAsset],
    before_ids: &HashSet<String>,
    before_variants: &HashSet<String>,
    watch_id: Option<&str>,
) -> Result<()> {
    for asset in assets {
        if let Some(tid) = watch_id
            && asset.id != tid
            && before_ids.contains(&asset.id)
        {
            continue;
        }
        for variant in &asset.variants {
            if before_variants.contains(&variant.id) {
                continue;
            }
            if matches!(
                variant.status.as_deref(),
                Some("failed" | "canceled" | "error")
            ) || variant.error.is_some()
            {
                let reason = variant
                    .error
                    .as_deref()
                    .or(variant.status.as_deref())
                    .unwrap_or("failed");
                anyhow::bail!("Flow edit failed on {}: {}", asset.id, reason);
            }
        }
    }
    Ok(())
}

/// Resolves a newly completed variant on `asset` when `hx: false` leaves primary media unchanged.
pub(crate) async fn resolve_new_completed_variant(
    engine: &ChromeEngine,
    asset: &FlowAsset,
    before_variants: &HashSet<String>,
) -> Option<FlowAsset> {
    for variant in asset.variants.iter().rev() {
        if before_variants.contains(&variant.id) || variant.error.is_some() {
            continue;
        }
        if matches!(
            variant.status.as_deref(),
            Some("pending" | "scheduled" | "failed" | "canceled" | "error")
        ) {
            continue;
        }
        let resolved_url = match variant.url.clone() {
            Some(url) => Some(url),
            None if variant.status.as_deref() == Some("success") => {
                eval_resolve_media_url(engine, &variant.id, Some(6000))
                    .await
                    .and_then(|val| {
                        val.get("download_url")
                            .or_else(|| val.get("url"))
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|u| u.starts_with("http"))
                            .map(str::to_string)
                    })
            }
            None => None,
        };
        if let Some(url) = resolved_url {
            let mut out = asset.clone();
            out.primary_media_id = Some(variant.id.clone());
            out.url = Some(url);
            if variant.prompt.is_some() {
                out.prompt.clone_from(&variant.prompt);
            }
            out.media_status.clone_from(&variant.status);
            return Some(out);
        }
    }
    None
}

/// Collects all media and variant IDs present across `assets` before submitting an edit.
fn collect_baseline_variant_ids(assets: &[FlowAsset]) -> HashSet<String> {
    let mut ids = HashSet::new();
    for asset in assets {
        if let Some(ref primary_id) = asset.primary_media_id
            && !primary_id.is_empty()
        {
            ids.insert(primary_id.clone());
        }
        for variant in &asset.variants {
            if !variant.id.is_empty() {
                ids.insert(variant.id.clone());
            }
        }
    }
    ids
}

/// Resolves the target asset and optional parent scene ID, rejecting empty or multi-clip scenes.
fn resolve_edit_target(
    matched: FlowAsset,
    all_assets: &[FlowAsset],
    label: &str,
) -> Result<(FlowAsset, Option<String>)> {
    if matched.kind != "scene" {
        let parent_scene = matched.scene_id.clone();
        return Ok((matched, parent_scene));
    }

    let clips = matched.clip_ids.clone().unwrap_or_default();
    if clips.is_empty() {
        anyhow::bail!(
            "Cannot edit scene '{}' ({}): scene has no clips",
            label,
            matched.id
        );
    }
    if clips.len() > 1 {
        anyhow::bail!(
            "Cannot edit multi-clip scene '{}' ({}); specify one clip ID: {}",
            label,
            matched.id,
            clips.join(", ")
        );
    }

    let clip_id = &clips[0];
    let scene_id = matched.id.clone();
    let clip_asset = all_assets
        .iter()
        .find(|asset| asset.id == *clip_id)
        .cloned()
        .unwrap_or(FlowAsset {
            id: clip_id.clone(),
            name: matched.name,
            kind: "video".to_string(),
            collection_id: matched.collection_id,
            collection_name: matched.collection_name,
            width: matched.width,
            height: matched.height,
            duration: matched.duration,
            scene_id: Some(scene_id.clone()),
            created_at: matched.created_at,
            ..FlowAsset::default()
        });
    Ok((clip_asset, Some(scene_id)))
}

/// Fails immediately when `openEditAsset` reports a blocked editor or duration/region alert.
fn check_open_edit_blocked(label: &str, open_res: &Value) -> Result<()> {
    let blocked = open_res
        .get("blocked")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let alert = open_res
        .get("alert")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let detail = open_res
        .get("detail")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let err_code = open_res
        .get("error")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if blocked || alert.is_some() || err_code.is_some() {
        let message = alert.or(detail).or(err_code).unwrap_or("editor is blocked");
        anyhow::bail!("Cannot edit '{}': {}", label, message);
    }
    Ok(())
}

/// Opens an edit flow for an asset matching `match_str`, submits `prompt`, and saves outputs.
pub(crate) async fn run_edit(
    engine: &ChromeEngine,
    db: &FlowDb,
    match_str: &str,
    prompt: &str,
    on_progress: ProgressCallback,
) -> Result<(Vec<String>, Vec<String>, Vec<String>)> {
    ensure_project_workspace_root(engine).await?;
    let snap = list_assets_with_project(engine).await?;
    let matched = match_asset(&snap.assets, match_str, true)
        .cloned()
        .with_context(|| format!("No asset matches '{}' for edit", match_str))?;

    let before_ids: HashSet<String> = snap.assets.iter().map(|a| a.id.clone()).collect();
    let before_variants = collect_baseline_variant_ids(&snap.assets);

    let label = if matched.name.is_empty() {
        matched.id.clone()
    } else {
        matched.name.clone()
    };
    let (target, delegated_scene_id) = resolve_edit_target(matched, &snap.assets, &label)?;
    on_progress(format!("preparing edit for {}", label));

    let edit_mode = if target.kind == "video" || delegated_scene_id.is_some() {
        "video"
    } else {
        "image"
    };

    let mut open_res = engine
        .call_flow_async(
            "openEditAsset",
            json!([
                target.id,
                target.url,
                target.primary_media_id,
                delegated_scene_id
            ]),
        )
        .await
        .unwrap_or_default();
    check_open_edit_blocked(&label, &open_res)?;

    let mut opened_in_ui = open_res
        .get("opened")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !opened_in_ui && let Some(edit_url) = open_res.get("edit_url").and_then(|v| v.as_str()) {
        engine.navigate(edit_url).await?;
        tokio::time::sleep(Duration::from_millis(1200)).await;
        ensure_flow_store(engine).await?;
        open_res = engine
            .call_flow_async(
                "openEditAsset",
                json!([
                    target.id,
                    target.url,
                    target.primary_media_id,
                    delegated_scene_id
                ]),
            )
            .await
            .unwrap_or_default();
        check_open_edit_blocked(&label, &open_res)?;
        opened_in_ui = open_res
            .get("opened")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
    } else if opened_in_ui {
        let _ = ensure_flow_store(engine).await;
    }

    let mut attached_frames: Option<Vec<String>> = None;
    if !opened_in_ui {
        if edit_mode == "video" {
            anyhow::bail!("Could not open the Flow editor for video asset '{}'", label);
        }
        if target.url.is_some() || target.primary_media_id.is_some() {
            let _ = ensure_project_workspace_root(engine).await;
            let _ = ensure_flow_store(engine).await;
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
        } else {
            anyhow::bail!("Could not open the Flow editor for image asset '{}'", label);
        }
    }

    let current_url = engine.current_url().await.unwrap_or_default();
    let in_edit_route =
        opened_in_ui && (current_url.contains("/edit/") || current_url.contains("/scene/"));
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
        edit: Some(opened_in_ui),
        ..Default::default()
    };
    let mut net_rx = engine.subscribe_network().await?;
    let submit_res = apply_generation_controls(engine, &scene).await?;
    let submit_summary = format_submit_progress("submitted edit", &submit_res);
    on_progress(submit_summary.clone());

    let (created, project_id, project_title) = wait_for_new_assets(
        engine,
        AssetWaitSpec {
            before_ids: &before_ids,
            before_variant_ids: Some(&before_variants),
            watch_updated: Some((
                target.id.as_str(),
                target.primary_media_id.as_deref(),
                target.url.as_deref(),
            )),
            expected_count: 1,
            timeout_secs: 420,
            submit_summary: &submit_summary,
        },
        &mut net_rx,
        &on_progress,
    )
    .await?;
    let out = collect_created_assets(
        engine,
        db,
        created,
        project_id,
        project_title,
        true,
        &on_progress,
    )
    .await;
    ensure_project_workspace_root(engine).await?;
    Ok(out)
}
