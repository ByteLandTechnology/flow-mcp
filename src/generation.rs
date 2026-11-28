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
    /// Model family override (defaults to "Veo 3.1 Lite", or "Veo 3.1 Fast" on legacy builds, for video and "Nano Banana 2" for image).
    pub(crate) model: Option<String>,
    /// Output aspect ratio: "16:9" (default), "9:16", or "1:1" (image mode only).
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
    /// Video generation mode ("ingredients" default or "frames").
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

/// Specification controlling asset polling during generation and edit jobs.
struct AssetWaitSpec<'a> {
    /// Asset IDs already present before submission.
    before_ids: &'a HashSet<String>,
    /// Optional existing tile `(asset_id, primary_media_id, url)` watched for replacement updates.
    watch_updated: Option<(&'a str, Option<&'a str>, Option<&'a str>)>,
    /// Target number of generated outputs in the batch.
    expected_count: usize,
    /// Maximum wait time in seconds before failing with timeout.
    timeout_secs: u64,
    /// Compact submission diagnostics included in progress updates.
    submit_summary: &'a str,
}

/// Context for `apply_generation_controls` distinguishing standard generation from edit flows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubmissionKind {
    /// Standard `flow_generate` request.
    Generate,
    /// Image edit fallback on the project workspace when no edit view opens.
    EditFallback,
    /// Edit session already opened via `/edit/` or an inline tile edit button.
    InlineEdit,
}

/// Validated and normalized control parameters sent to the browser generation runtime.
struct NormalizedControls {
    /// Canonical mode string (`"video"` or `"image"`).
    mode: &'static str,
    /// Canonical aspect ratio label when explicitly provided or defaulted for generation.
    aspect: Option<String>,
    /// Trimmed explicit model family override when specified by the caller.
    model: Option<String>,
    /// Explicit video sub-mode (`Some("ingredients")` or `Some("frames")`) when supplied by the caller.
    explicit_video_type: Option<&'static str>,
    /// Non-empty trimmed project asset IDs to attach.
    asset_ids: Option<Vec<String>>,
    /// Non-empty trimmed character IDs or names to attach.
    characters: Option<Vec<String>>,
    /// Clamped batch output count in `1..=4`.
    count: u32,
}

/// Trims items in `raw` and drops empty strings, returning `None` when none remain.
fn clean_string_list(raw: Option<&[String]>) -> Option<Vec<String>> {
    let items: Vec<String> = raw
        .unwrap_or(&[])
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect();
    (!items.is_empty()).then_some(items)
}

/// Normalizes generation parameters and rejects invalid video aspect, character, and frame combinations.
fn resolve_generation_controls(
    scene: &SceneParams,
    kind: SubmissionKind,
) -> Result<NormalizedControls> {
    let is_edit = kind != SubmissionKind::Generate;
    let raw_mode = scene
        .mode
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("video");
    let mode = if raw_mode.eq_ignore_ascii_case("image")
        || raw_mode.eq_ignore_ascii_case("character")
        || raw_mode.eq_ignore_ascii_case("scene")
    {
        "image"
    } else {
        "video"
    };
    let explicit_aspect = scene
        .aspect
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let aspect = if is_edit {
        explicit_aspect.map(str::to_string)
    } else {
        Some(explicit_aspect.unwrap_or("16:9").to_string())
    };
    if let Some(a) = aspect.as_deref()
        && mode == "video"
        && (a == "1:1" || a.eq_ignore_ascii_case("square"))
    {
        anyhow::bail!("Video mode does not support aspect ratio '{a}'; use '16:9' or '9:16'");
    }
    let explicit_video_type = if mode == "video" && !is_edit {
        match scene
            .video_type
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            None => None,
            Some(vt)
                if vt.eq_ignore_ascii_case("ingredients")
                    || vt.eq_ignore_ascii_case("ingredient")
                    || vt.eq_ignore_ascii_case("video_ingredients")
                    || vt.eq_ignore_ascii_case("video_references") =>
            {
                Some("ingredients")
            }
            Some(vt)
                if vt.eq_ignore_ascii_case("frames")
                    || vt.eq_ignore_ascii_case("frame")
                    || vt.eq_ignore_ascii_case("video_frames") =>
            {
                Some("frames")
            }
            Some(vt) => anyhow::bail!(
                "Unsupported video_type '{vt}' for video mode; use 'ingredients' or 'frames'"
            ),
        }
    } else {
        None
    };
    let effective_video_type = if mode == "video" && !is_edit {
        Some(explicit_video_type.unwrap_or("ingredients"))
    } else {
        None
    };
    let asset_ids = clean_string_list(scene.asset_ids.as_deref());
    let characters = clean_string_list(scene.characters.as_deref());
    if effective_video_type == Some("frames") {
        if characters.is_some() {
            anyhow::bail!(
                "Video frames mode does not support character references; use video_type 'ingredients'"
            );
        }
        let ref_count =
            scene.frames.as_ref().map_or(0, Vec::len) + asset_ids.as_ref().map_or(0, Vec::len);
        anyhow::ensure!(
            ref_count <= 2,
            "Frame mode accepts at most two references, got {ref_count}"
        );
    }
    let model = scene
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Ok(NormalizedControls {
        mode,
        aspect,
        model,
        explicit_video_type,
        asset_ids,
        characters,
        count: scene.count.unwrap_or(2).clamp(1, 4),
    })
}

/// Configures generation controls, uploads reference frames, writes prompt text, and submits.
async fn apply_generation_controls(
    engine: &ChromeEngine,
    scene: &SceneParams,
    kind: SubmissionKind,
) -> Result<serde_json::Value> {
    let controls = resolve_generation_controls(scene, kind)?;
    validate_local_files(scene.frames.as_deref(), "Reference image").await?;

    let cfg = json!({
        "mode": controls.mode,
        "aspect": controls.aspect,
        "model": controls.model,
        "edit": kind != SubmissionKind::Generate,
        "inline_edit": kind == SubmissionKind::InlineEdit,
        "count": controls.count,
        "prompt": scene.prompt,
        "asset_ids": controls.asset_ids,
        "characters": controls.characters,
        "video_type": controls.explicit_video_type,
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
        .call_flow_async("attachIngredients", json!([cfg.clone()]))
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
        .call_flow_async("submitGeneration", json!([cfg]))
        .await?;
    if submit_res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let err = submit_res
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        if matches!(err, "unsupported_model" | "unsupported_aspect_ratio") {
            anyhow::bail!("Failed to configure Flow generation UI: {err}");
        }
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
                if let Some((tid, prev_pmid, prev_url)) = spec.watch_updated
                    && a.id == tid
                    && a.url.is_some()
                {
                    let pmid_changed = a
                        .primary_media_id
                        .as_deref()
                        .is_some_and(|p| Some(p) != prev_pmid);
                    let url_changed = a.url.as_deref() != prev_url;
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
                if let Some((tid, _, _)) = spec.watch_updated {
                    snap.assets
                        .iter()
                        .find(|a| a.id == tid)
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
            if let Some((tid, prev_pmid, _)) = spec.watch_updated
                && let Some(watched) = snap.assets.iter().find(|a| a.id == tid)
                && matches!(watched.media_status.as_deref(), Some("failed" | "canceled"))
                && (watched.primary_media_id.as_deref() != prev_pmid
                    || watched.media_error.is_some())
            {
                anyhow::bail!(
                    "Flow edit failed on {}: {}",
                    tid,
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
    let controls = resolve_generation_controls(scene, SubmissionKind::Generate)?;
    ensure_project_workspace_root(engine).await?;
    ensure_flow_store(engine).await?;
    let mut normalized_scene = scene.clone();
    normalized_scene.video_type = controls.explicit_video_type.map(str::to_string);
    normalized_scene.asset_ids = controls.asset_ids;
    normalized_scene.characters = controls.characters;
    let scene = &normalized_scene;
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
    let submit_res = apply_generation_controls(engine, scene, SubmissionKind::Generate).await?;
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
    let before: HashSet<String> = snap.assets.into_iter().map(|a| a.id).collect();

    let label = if target.name.is_empty() {
        target.id.clone()
    } else {
        target.name.clone()
    };
    on_progress(format!("preparing edit for {}", label));

    let edit_mode =
        if target.kind == "video" || (target.kind == "scene" && target.duration.is_some()) {
            "video"
        } else {
            "image"
        };

    let open_res = engine
        .call_flow_async(
            "openEditAsset",
            json!([target.id, target.url, target.primary_media_id]),
        )
        .await
        .unwrap_or_default();
    let mut opened_in_ui = open_res
        .get("opened")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !opened_in_ui {
        if let Some(edit_url) = open_res.get("edit_url").and_then(|v| v.as_str()) {
            engine.navigate(edit_url).await?;
            tokio::time::sleep(Duration::from_millis(1200)).await;
            ensure_flow_store(engine).await?;
            opened_in_ui = true;
        }
    } else {
        let _ = ensure_flow_store(engine).await;
    }

    let mut attached_frames: Option<Vec<String>> = None;
    if !opened_in_ui {
        if edit_mode == "video" {
            anyhow::bail!(
                "Could not open an inline edit control or /edit/ route for video asset '{}'",
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

    let in_edit_route = engine
        .current_url()
        .await
        .unwrap_or_default()
        .contains("/edit/");
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
    let edit_kind = if opened_in_ui || in_edit_route {
        SubmissionKind::InlineEdit
    } else {
        SubmissionKind::EditFallback
    };
    let mut net_rx = engine.subscribe_network().await?;
    let submit_res = apply_generation_controls(engine, &scene, edit_kind).await?;
    let submit_summary = format_submit_progress("submitted edit", &submit_res);
    on_progress(submit_summary.clone());

    let (created, project_id, project_title) = wait_for_new_assets(
        engine,
        AssetWaitSpec {
            before_ids: &before,
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
