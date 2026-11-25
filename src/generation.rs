// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Google Flow media generation and asset editing.
//!
//! Drives the Flow generation form through the browser TypeScript runtime and defines MCP
//! request parameter structs for [`crate::queue::JobQueue`] tasks.

use anyhow::{Context, Result};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashSet;
use tokio::sync::broadcast;
use tokio::time::{Duration, Instant};

use crate::assets::{FlowAsset, list_assets_with_project, match_asset};
use crate::db::FlowDb;
use crate::download::download_resolved_asset;
use crate::engine::{ChromeEngine, NetworkResponseEvent, validate_local_files};
use crate::project::{ensure_flow_store, ensure_project_workspace_root};
use crate::queue::{ProgressCallback, SceneParams};

/// Batchexecute RPC IDs associated with Google Flow generation requests.
const BATCH_GENERATION_RPC_IDS: &[&str] = &[
    "Z9cAtf", "ogiZ0b", "YhhmEf", "MZZa6b", "eb1hJf", "nprQif", "jIps6", "fZytfe", "p0UkFb",
    "IJhj9c", "xNyCid",
];

/// Parameters for `flow_generate`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct GenerateParams {
    /// Text prompt for Google Flow.
    pub(crate) prompt: String,
    /// Generation mode: "video" (default) or "image".
    pub(crate) mode: Option<String>,
    /// Model name override (defaults to "veo-3.1-fast" for video or "nano-banana-2" for image).
    pub(crate) model: Option<String>,
    /// Output aspect ratio: "16:9" (default), "9:16", or "1:1".
    pub(crate) aspect: Option<String>,
    /// Output count from 1 to 4 (default 2).
    #[schemars(range(min = 1, max = 4))]
    pub(crate) count: Option<u32>,
    /// Local reference or keyframe image paths to upload before generation.
    pub(crate) frames: Option<Vec<String>>,
    /// Scene or asset label.
    pub(crate) name: Option<String>,
    /// Download created assets when true (default true).
    pub(crate) download: Option<bool>,
    /// Character role key in `character_looks` whose saved look `flow_generate` appends to prompt.
    pub(crate) character_role: Option<String>,
    /// Character look description to save under `character_role` in `character_looks` and append to prompt.
    pub(crate) character_look: Option<String>,
    /// Existing project image asset IDs to attach as ingredients or reference frames.
    pub(crate) asset_ids: Option<Vec<String>>,
    /// Existing character IDs or names to attach to video or image generation.
    pub(crate) characters: Option<Vec<String>>,
    /// Video generation mode (`"frames"` or `"ingredients"`).
    pub(crate) video_type: Option<String>,
    /// Video duration setting (for example `"5s"` or `"8s"`).
    pub(crate) duration: Option<String>,
    /// Video resolution setting (for example `"720p"` or `"1080p"`).
    pub(crate) resolution: Option<String>,
}

/// Parameters for `flow_edit`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct EditParams {
    /// Case-insensitive asset ID, name, or prompt substring that selects the source asset.
    #[serde(rename = "match")]
    pub(crate) r#match: String,
    /// Edit prompt for the matched asset.
    pub(crate) prompt: String,
}

/// Baseline state of an existing asset watched for edit updates or failures.
#[derive(Clone, Copy)]
struct WatchedAsset<'a> {
    /// Asset or scene clip workflow ID.
    id: &'a str,
    /// Primary media ID before edit submission.
    primary_media_id: Option<&'a str>,
    /// Newest variant ID in history before edit submission.
    latest_variant_id: Option<&'a str>,
    /// Resolved media URL before edit submission.
    url: Option<&'a str>,
    /// True when the watched asset already reported a failed or canceled variant before submission.
    was_failed: bool,
}

/// Specification controlling asset polling during generation and edit jobs.
struct AssetWaitSpec<'a> {
    /// Asset IDs already present before submission.
    before_ids: &'a HashSet<String>,
    /// Optional existing tile watched for replacement updates or variant failures.
    watch_updated: Option<WatchedAsset<'a>>,
    /// Target number of generated outputs in the batch.
    expected_count: usize,
    /// Maximum wait time in seconds before failing with timeout.
    timeout_secs: u64,
    /// Compact submission diagnostics included in progress updates.
    submit_summary: &'a str,
}

/// Configures generation controls, uploads reference frames, writes prompt text, and submits.
async fn apply_generation_controls(
    engine: &ChromeEngine,
    scene: &SceneParams,
) -> Result<serde_json::Value> {
    validate_local_files(scene.frames.as_deref(), "Reference image").await?;

    let raw_mode = scene.mode.as_deref().unwrap_or("video");
    let mode = match raw_mode {
        "image" | "character" | "scene" => "image",
        _ => "video",
    };
    let aspect = scene.aspect.as_deref().unwrap_or("16:9");
    let model = scene.model.as_deref().unwrap_or(if mode == "image" {
        "nano-banana-2"
    } else {
        "veo-3.1-fast"
    });
    let count = scene.count.unwrap_or(2).clamp(1, 4);

    let cfg = json!({
        "mode": mode,
        "aspect": aspect,
        "model": model,
        "count": count,
        "prompt": scene.prompt,
        "asset_ids": scene.asset_ids,
        "characters": scene.characters,
        "video_type": scene.video_type,
        "duration": scene.duration,
        "resolution": scene.resolution,
    });

    let setup_res = engine
        .call_flow_async("setupGeneration", json!([cfg.clone()]))
        .await?;
    if setup_res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        anyhow::bail!(
            "Failed to configure Flow generation UI: {}",
            setup_res
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        );
    }

    let res = engine
        .call_flow_async("attachIngredients", json!([cfg]))
        .await?;
    if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        anyhow::bail!(
            "Failed to configure Flow generation UI: {}",
            res.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        );
    }

    if let Some(frames) = &scene.frames
        && !frames.is_empty()
    {
        let mut uploaded = engine.upload_files("input[type=\"file\"]", frames).await;
        if uploaded.is_err() {
            // The 2026-11-15 front end opens a detached file input from the prompt box menu.
            uploaded = crate::upload::upload_through_menu(
                engine,
                crate::upload::PROMPT_INGREDIENTS_MENU,
                crate::upload::PROMPT_UPLOAD_ITEM,
                frames,
            )
            .await;
        }
        if let Err(first_err) = uploaded {
            let opened_trigger = engine
                .call_flow_js("uploadUiAction", json!(["open_trigger"]))
                .await
                .ok()
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if opened_trigger {
                tokio::time::sleep(Duration::from_millis(350)).await;
                engine
                    .upload_files("input[type=\"file\"]", frames)
                    .await
                    .with_context(|| {
                        format!(
                            "Failed to upload reference files {:?} after opening the upload trigger",
                            frames
                        )
                    })?;
            } else {
                return Err(first_err).with_context(|| {
                    format!(
                        "Failed to upload reference files {:?} through input[type=\"file\"]",
                        frames
                    )
                });
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        let _ = engine
            .call_flow_js("uploadUiAction", json!(["accept_consent"]))
            .await;
        tokio::time::sleep(Duration::from_millis(600)).await;
    }

    let mut submit_res = engine
        .call_flow_async("submitGeneration", json!([]))
        .await?;
    if submit_res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let err = submit_res
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let detail = submit_res
            .get("detail")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        match detail {
            Some(d) => anyhow::bail!(
                "Failed to find an enabled Create or Generate button in the Flow UI: {} ({})",
                err,
                d
            ),
            None => anyhow::bail!(
                "Failed to find an enabled Create or Generate button in the Flow UI: {}",
                err
            ),
        }
    }
    engine.click_point(&submit_res).await?;
    if let Some(obj) = submit_res.as_object_mut() {
        obj.insert("setup".to_string(), res);
    }
    Ok(submit_res)
}

/// Formats compact setup and submit diagnostics for generation progress logs.
fn format_submit_progress(prefix: &str, submit_res: &serde_json::Value) -> String {
    fn str_or<'a>(obj: Option<&'a serde_json::Value>, key: &str, fallback: &'a str) -> &'a str {
        obj.and_then(|v| v.get(key))
            .and_then(|v| v.as_str())
            .unwrap_or(fallback)
    }
    let bool_or = |obj: Option<&serde_json::Value>, key: &str| {
        obj.and_then(|v| v.get(key))
            .and_then(|v| v.as_bool())
            .map_or("unknown", |b| if b { "true" } else { "false" })
    };

    let setup = submit_res.get("setup");
    let method = str_or(Some(submit_res), "method", "unknown");
    let hit_tag = str_or(Some(submit_res), "hit_tag", "none");
    let hit_inside_btn = bool_or(Some(submit_res), "hit_inside_btn");
    let composer = str_or(setup, "composer", "unknown");
    let sk_agent = bool_or(setup, "sk_agent");
    let qa_mode = str_or(setup, "qa_mode", "unknown");
    let prompt_tier = str_or(setup, "prompt_tier", "unknown");
    let prompt_len = setup
        .and_then(|s| s.get("prompt_len"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let prompt_empty = bool_or(setup, "prompt_empty");
    let qf = bool_or(setup, "qf");
    let settings_open = bool_or(setup, "settings_open");

    format!(
        "{prefix} (method={method}, composer={composer}, sk_agent={sk_agent}, qa_mode={qa_mode}, prompt_tier={prompt_tier}, prompt_len={prompt_len}, prompt_empty={prompt_empty}, qf={qf}, settings_open={settings_open}, hit_tag={hit_tag}, hit_inside_btn={hit_inside_btn})"
    )
}

/// Returns `true` when `url` matches a Flow generation API endpoint.
fn is_generation_rpc_url(url: &str) -> bool {
    url.contains("aisandbox-pa.googleapis.com")
        || url.contains("FlowCreationAgentService")
        || url.contains("flowMedia")
        || url.contains("batchGenerate")
        || url.contains("AsyncGenerate")
        || url.contains("VideoFx")
        || (url.contains("batchexecute")
            && BATCH_GENERATION_RPC_IDS.iter().any(|id| url.contains(id)))
}

/// Drains CDP network events to surface API HTTP errors, reCAPTCHA blocks, or request acceptance.
pub(crate) fn inspect_generation_network(
    net_rx: &mut broadcast::Receiver<NetworkResponseEvent>,
    on_progress: &ProgressCallback,
) -> Result<Option<u16>> {
    let mut accepted_status: Option<u16> = None;
    loop {
        match net_rx.try_recv() {
            Ok(ev) => {
                if ev.url.contains("/AiSandboxAngularFrontend/jserror")
                    && ev.url.to_ascii_lowercase().contains("recaptcha")
                {
                    anyhow::bail!(
                        "Google Flow blocked generation in ChromeEngine due to a reCAPTCHA Enterprise error ({})",
                        ev.url
                    );
                }
                if ev.method.eq_ignore_ascii_case("POST") && is_generation_rpc_url(&ev.url) {
                    if ev.status >= 400 {
                        let excerpt = ev.error_excerpt.as_deref().unwrap_or("no error body");
                        if excerpt.to_ascii_lowercase().contains("recaptcha")
                            || ev.url.to_ascii_lowercase().contains("recaptcha")
                        {
                            anyhow::bail!(
                                "Google Flow blocked generation in ChromeEngine due to a reCAPTCHA Enterprise error (HTTP {} {}: {})",
                                ev.status,
                                ev.url,
                                excerpt
                            );
                        }
                        anyhow::bail!(
                            "Flow generation API returned HTTP {} ({}): {}",
                            ev.status,
                            ev.url,
                            excerpt
                        );
                    }
                    if ev.status > 0 {
                        accepted_status = Some(ev.status);
                        on_progress(format!("Flow API accepted request (HTTP {})", ev.status));
                    }
                }
            }
            Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
            Err(broadcast::error::TryRecvError::Empty)
            | Err(broadcast::error::TryRecvError::Closed) => break,
        }
    }
    Ok(accepted_status)
}

/// Polls project snapshots until expected generated outputs resolve or fail.
async fn wait_for_new_assets(
    engine: &ChromeEngine,
    spec: AssetWaitSpec<'_>,
    net_rx: &mut broadcast::Receiver<NetworkResponseEvent>,
    on_progress: &ProgressCallback,
) -> Result<(Vec<FlowAsset>, Option<String>, Option<String>)> {
    let deadline = Instant::now() + Duration::from_secs(spec.timeout_secs);
    let mut consecutive_errors = 0u32;
    let mut grace_deadline: Option<Instant> = None;
    let mut accepted_status: Option<u16> = None;
    let mut last_pending_count = 0usize;
    let mut last_pending_info = String::from("none");

    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_secs(3)).await;
        if let Some(code) = inspect_generation_network(net_rx, on_progress)? {
            accepted_status = Some(code);
        }
        let snap = match list_assets_with_project(engine).await {
            Ok(s) => {
                consecutive_errors = 0;
                s
            }
            Err(e) => {
                consecutive_errors += 1;
                if consecutive_errors >= 3 || e.to_string().contains("not signed in") {
                    return Err(e);
                }
                on_progress("retrying Flow snapshot read".to_string());
                continue;
            }
        };

        let new_ones: Vec<FlowAsset> = snap
            .assets
            .iter()
            .filter(|a| {
                if !spec.before_ids.contains(&a.id) && a.url.is_some() {
                    return true;
                }
                if let Some(watched) = spec.watch_updated
                    && a.id == watched.id
                    && a.url.is_some()
                {
                    let pmid_changed = a
                        .primary_media_id
                        .as_deref()
                        .is_some_and(|p| Some(p) != watched.primary_media_id);
                    let url_changed = a.url.as_deref() != watched.url;
                    return pmid_changed || url_changed;
                }
                false
            })
            .cloned()
            .collect();

        if new_ones.is_empty() {
            let new_tiles: Vec<&FlowAsset> = snap
                .assets
                .iter()
                .filter(|a| !spec.before_ids.contains(&a.id))
                .collect();
            last_pending_count = new_tiles.len();
            last_pending_info = if new_tiles.is_empty() {
                if let Some(watched) = spec.watch_updated {
                    snap.assets
                        .iter()
                        .find(|a| a.id == watched.id)
                        .map(|a| {
                            format!("{}:{}", a.id, a.media_status.as_deref().unwrap_or("none"))
                        })
                        .unwrap_or_else(|| "none".to_string())
                } else {
                    "none".to_string()
                }
            } else {
                new_tiles
                    .iter()
                    .map(|a| format!("{}:{}", a.id, a.media_status.as_deref().unwrap_or("none")))
                    .collect::<Vec<_>>()
                    .join(",")
            };
            if !new_tiles.is_empty()
                && new_tiles
                    .iter()
                    .all(|a| matches!(a.media_status.as_deref(), Some("failed" | "canceled")))
            {
                let first = new_tiles[0];
                anyhow::bail!(
                    "Flow generation failed on tile {}: {}",
                    first.id,
                    first
                        .media_error
                        .as_deref()
                        .unwrap_or(first.media_status.as_deref().unwrap_or("failed"))
                );
            }
            if let Some(w) = spec.watch_updated
                && let Some(watched) = snap.assets.iter().find(|a| a.id == w.id)
                && matches!(watched.media_status.as_deref(), Some("failed" | "canceled"))
                && (watched.latest_variant_id.as_deref() != w.latest_variant_id
                    || watched.primary_media_id.as_deref() != w.primary_media_id
                    || !w.was_failed)
            {
                anyhow::bail!(
                    "Flow edit failed on {}: {}",
                    w.id,
                    watched
                        .media_error
                        .as_deref()
                        .unwrap_or(watched.media_status.as_deref().unwrap_or("failed"))
                );
            }
        }

        if new_ones.len() >= spec.expected_count.max(1) {
            on_progress(format!("created {} asset(s)", new_ones.len()));
            return Ok((new_ones, snap.project_id, snap.project_title));
        }

        if !new_ones.is_empty() {
            let g_deadline = grace_deadline
                .get_or_insert_with(|| (Instant::now() + Duration::from_secs(15)).min(deadline));
            if Instant::now() >= *g_deadline {
                on_progress(format!("created {} asset(s)", new_ones.len()));
                return Ok((new_ones, snap.project_id, snap.project_title));
            }
            on_progress(format!(
                "created {}/{} asset(s), waiting for batch",
                new_ones.len(),
                spec.expected_count
            ));
        } else if let Some(code) = accepted_status {
            on_progress(format!(
                "waiting for Flow generation (API HTTP {}, pending={}, tiles={}, {})",
                code, last_pending_count, last_pending_info, spec.submit_summary
            ));
        } else {
            on_progress(format!(
                "waiting for Flow generation (pending={}, tiles={}, {})",
                last_pending_count, last_pending_info, spec.submit_summary
            ));
        }
    }
    anyhow::bail!(
        "Timed out waiting for Flow generation to produce assets (accepted_status={}, pending_tiles={}, {}; {})",
        accepted_status.map_or_else(|| "none".to_string(), |c| c.to_string()),
        last_pending_count,
        last_pending_info,
        spec.submit_summary
    )
}

/// Downloads and indexes produced assets into SQLite when `should_download` is enabled.
pub(crate) async fn collect_created_assets(
    engine: &ChromeEngine,
    db: &FlowDb,
    assets: Vec<FlowAsset>,
    project_id: Option<String>,
    project_title: Option<String>,
    should_download: bool,
    on_progress: &ProgressCallback,
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut files = Vec::new();
    let mut created_ids = Vec::new();
    let mut resources = Vec::new();
    let mut dl_errors = Vec::new();
    for asset in assets {
        created_ids.push(asset.id.clone());
        if should_download {
            match download_resolved_asset(
                engine,
                db,
                &asset,
                project_id.clone(),
                project_title.clone(),
            )
            .await
            {
                Ok(rec) => {
                    files.push(rec.file_path);
                    resources.push(rec.resource_uri);
                }
                Err(e) => dl_errors.push(format!("{}: {}", asset.id, e)),
            }
        }
    }
    if !dl_errors.is_empty() {
        on_progress(format!(
            "completed with download error(s): {}",
            dl_errors.join("; ")
        ));
    }
    (files, created_ids, resources)
}

/// Submits a video or image generation job, waits for new assets, and downloads/indexes them if enabled.
pub(crate) async fn run_generation(
    engine: &ChromeEngine,
    db: &FlowDb,
    scene: &SceneParams,
    on_progress: ProgressCallback,
) -> Result<(Vec<String>, Vec<String>, Vec<String>)> {
    ensure_project_workspace_root(engine).await?;
    ensure_flow_store(engine).await?;
    if scene.video_type.as_deref() == Some("frames") {
        let count = scene.frames.as_ref().map_or(0, Vec::len)
            + scene.asset_ids.as_ref().map_or(0, Vec::len)
            + scene.characters.as_ref().map_or(0, Vec::len);
        anyhow::ensure!(
            count <= 2,
            "Frame mode accepts at most two references, got {count}"
        );
    }
    // Upload local frames into the library first and attach them as assets, so that the
    // uploaded tiles are not counted as generated outputs.
    let uploaded_scene;
    let scene = match scene.frames.as_deref() {
        Some(frames) if !frames.is_empty() => {
            validate_local_files(Some(frames), "Reference image").await?;
            on_progress("uploading reference images".to_string());
            match crate::upload::upload_to_library(engine, frames).await {
                Ok(ids) => {
                    let mut s = scene.clone();
                    s.asset_ids.get_or_insert_with(Vec::new).extend(ids);
                    s.frames = None;
                    uploaded_scene = s;
                    &uploaded_scene
                }
                Err(e) => {
                    on_progress(format!("library upload failed, using prompt upload: {e:#}"));
                    scene
                }
            }
        }
        _ => scene,
    };
    on_progress("preparing Flow UI".to_string());
    let snap = list_assets_with_project(engine).await?;
    let before: HashSet<String> = snap.assets.into_iter().map(|a| a.id).collect();
    let expected_count = scene.count.unwrap_or(2).clamp(1, 4) as usize;

    let mut net_rx = engine.subscribe_network().await?;
    let submit_res = apply_generation_controls(engine, scene).await?;
    let submit_summary = format_submit_progress("submitted generation", &submit_res);
    on_progress(submit_summary.clone());

    let (new_assets, project_id, project_title) = wait_for_new_assets(
        engine,
        AssetWaitSpec {
            before_ids: &before,
            watch_updated: None,
            expected_count,
            timeout_secs: 420,
            submit_summary: &submit_summary,
        },
        &mut net_rx,
        &on_progress,
    )
    .await?;
    let should_dl = scene.download.unwrap_or(true);
    Ok(collect_created_assets(
        engine,
        db,
        new_assets,
        project_id,
        project_title,
        should_dl,
        &on_progress,
    )
    .await)
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
    if let Some(alert) = open_res
        .get("alert")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        let _ = ensure_project_workspace_root(engine).await;
        anyhow::bail!("Flow cannot edit '{}': {}", label, alert);
    }
    let is_editor_open = |res: &serde_json::Value| {
        res.get("opened").and_then(|v| v.as_bool()) == Some(true)
            && res.get("has_textbox").and_then(|v| v.as_bool()) == Some(true)
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
        if let Some(alert) = open_res
            .get("alert")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            let _ = ensure_project_workspace_root(engine).await;
            anyhow::bail!("Flow cannot edit '{}': {}", label, alert);
        }
        opened_in_ui = is_editor_open(&open_res);
    } else if opened_in_ui {
        let _ = ensure_flow_store(engine).await;
    }

    let mut attached_frames: Option<Vec<String>> = None;
    if !opened_in_ui {
        ensure_project_workspace_root(engine).await?;
        if edit_mode == "video" {
            anyhow::bail!(
                "Could not open an inline edit control or editor route for video asset '{}'",
                label
            );
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

    let target_was_failed = matches!(target.media_status.as_deref(), Some("failed" | "canceled"));
    let (created, project_id, project_title) = wait_for_new_assets(
        engine,
        AssetWaitSpec {
            before_ids: &before,
            watch_updated: Some(WatchedAsset {
                id: target.id.as_str(),
                primary_media_id: target.primary_media_id.as_deref(),
                latest_variant_id: target.latest_variant_id.as_deref(),
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
