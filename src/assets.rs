// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Google Flow asset listing, matching, renaming, and trashing.
//!
//! Reads the active project store through [`crate::project::read_snapshot`].

use anyhow::{Context, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::{Duration, Instant};

use crate::db::FlowDb;
use crate::download::eval_resolve_media_url;
use crate::engine::ChromeEngine;
use crate::project::{ensure_flow_store, is_flow_mutation_rpc_ok, read_snapshot};

/// Media asset or scene item inside a Google Flow project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct FlowAsset {
    /// Flow asset or tile ID.
    pub(crate) id: String,
    /// Asset display name (`displayName` in the tile store).
    pub(crate) name: String,
    /// Asset kind (`"video"`, `"image"`, `"scene"`, or `"character"`).
    pub(crate) kind: String,
    /// Generation prompt for the asset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) prompt: Option<String>,
    /// Direct signed media URL (`fifeUrl`, `videoUrl`, or `imageUrl`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
    /// Parent collection ID (`Fc` field on the tile).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) collection_id: Option<String>,
    /// Parent collection display name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) collection_name: Option<String>,
    /// Media width in pixels.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) width: Option<u32>,
    /// Media height in pixels.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) height: Option<u32>,
    /// Video or audio duration in seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) duration: Option<f64>,
    /// Primary media ID for video trim and edit operations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) primary_media_id: Option<String>,
    /// Character personality notes or introduction text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) personality_notes: Option<String>,
    /// Selected Flow voice reference for character tiles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) voice: Option<Value>,
    /// Video trim start timestamp in seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) trim_start_seconds: Option<f64>,
    /// Video trim end timestamp in seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) trim_end_seconds: Option<f64>,
    /// Internal media status used for generation failure detection.
    #[serde(default, skip_serializing)]
    pub(crate) media_status: Option<String>,
    /// Internal media error payload used for generation failure detection.
    #[serde(default, skip_serializing)]
    pub(crate) media_error: Option<String>,
    /// Creation timestamp (`createTime`) string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) created_at: Option<String>,
}

/// Snapshot of active project metadata and asset tiles.
#[derive(Debug, Clone)]
pub(crate) struct ProjectAssetsSnapshot {
    /// Active Google Flow project ID when known.
    pub(crate) project_id: Option<String>,
    /// Active Google Flow project title when known.
    pub(crate) project_title: Option<String>,
    /// Project asset tiles with resolved media URLs.
    pub(crate) assets: Vec<FlowAsset>,
}

/// Asset or collection rename entry.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub(crate) struct RenameEntry {
    /// Target asset or collection ID in Google Flow.
    pub(crate) id: String,
    /// New display name for the asset or collection.
    pub(crate) name: String,
}

/// Parameters for `flow_assets`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct AssetsParams {
    /// Case-insensitive substring that matches asset ID, name, or prompt.
    pub(crate) query: Option<String>,
    /// Asset kind filter: "image", "video", "scene", "character", or "all" (default).
    pub(crate) kind: Option<String>,
    /// Collection filter: collection ID, name substring, "all", "none", or "uncollected".
    pub(crate) collection: Option<String>,
    /// Maximum number of assets to return (at least 1).
    #[schemars(range(min = 1))]
    pub(crate) limit: Option<usize>,
}

/// Parameters for `flow_rename`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct RenameParams {
    /// Non-empty list of `{ id, name }` entries to rename.
    pub(crate) items: Vec<RenameEntry>,
}

/// Parameters for `flow_download`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct DownloadParams {
    /// Exact asset ID, exact name, or case-insensitive asset substring to download.
    #[serde(rename = "match")]
    pub(crate) r#match: String,
}

/// Parameters for `flow_trash`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct TrashParams {
    /// Case-insensitive asset or collection ID, name, or prompt substring to trash.
    #[serde(rename = "match")]
    pub(crate) r#match: String,
}

/// Resolves missing direct media URLs on finished image or video tiles through `as29s` RPCs.
async fn populate_missing_media_urls(engine: &ChromeEngine, assets: &mut [FlowAsset]) {
    let mut cache: HashMap<String, Option<String>> = HashMap::new();
    for asset in assets.iter_mut() {
        if !matches!(asset.kind.as_str(), "video" | "image")
            || asset.url.is_some()
            || asset.media_error.is_some()
            || matches!(
                asset.media_status.as_deref(),
                Some("pending" | "scheduled" | "failed" | "canceled")
            )
        {
            continue;
        }
        let Some(media_id) = asset
            .primary_media_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        if let Some(cached) = cache.get(media_id) {
            asset.url = cached.clone();
            continue;
        }
        let resolved = eval_resolve_media_url(engine, media_id)
            .await
            .and_then(|val| {
                val.get("url")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|u| u.starts_with("http"))
                    .map(str::to_string)
            });
        cache.insert(media_id.to_string(), resolved.clone());
        asset.url = resolved;
    }
}

/// Reads the active project's metadata and full asset list in one snapshot call.
pub(crate) async fn list_assets_with_project(
    engine: &ChromeEngine,
) -> Result<ProjectAssetsSnapshot> {
    let snap = read_snapshot(engine).await?;
    let project_id = snap
        .get("projectId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let project_title = snap
        .get("projectTitle")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let mut assets: Vec<FlowAsset> = serde_json::from_value(
        snap.get("assets")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    )?;
    populate_missing_media_urls(engine, &mut assets).await;
    Ok(ProjectAssetsSnapshot {
        project_id,
        project_title,
        assets,
    })
}

/// Selects the best-matching asset by exact ID, exact name, name substring, ID substring,
/// or optional prompt substring.
pub(crate) fn match_asset<'a>(
    assets: &'a [FlowAsset],
    match_str: &str,
    include_prompt: bool,
) -> Option<&'a FlowAsset> {
    let raw = match_str.trim();
    if raw.is_empty() {
        return None;
    }
    let lower = raw.to_lowercase();

    assets
        .iter()
        .find(|a| a.id == raw)
        .or_else(|| assets.iter().find(|a| a.name.eq_ignore_ascii_case(raw)))
        .or_else(|| {
            assets
                .iter()
                .find(|a| a.name.to_lowercase().contains(&lower))
        })
        .or_else(|| assets.iter().find(|a| a.id.to_lowercase().contains(&lower)))
        .or_else(|| {
            if include_prompt {
                assets.iter().find(|a| {
                    a.prompt
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&lower)
                })
            } else {
                None
            }
        })
}

/// Resolves the single best-matching asset and active project metadata across all project assets.
pub(crate) async fn resolve_asset(
    engine: &ChromeEngine,
    match_str: &str,
    include_prompt: bool,
    context_label: &str,
) -> Result<(FlowAsset, Option<String>, Option<String>)> {
    let snap = list_assets_with_project(engine).await?;
    let target = match_asset(&snap.assets, match_str, include_prompt)
        .cloned()
        .with_context(|| {
            format!(
                "No asset matches '{}' in the active project for {}",
                match_str, context_label
            )
        })?;
    Ok((target, snap.project_id, snap.project_title))
}

/// Lists assets in the active Flow project matching optional query, kind, collection, and limit filters.
pub(crate) async fn list_assets(
    engine: &ChromeEngine,
    query: Option<&str>,
    kind: Option<&str>,
    collection: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<FlowAsset>> {
    let snap = list_assets_with_project(engine).await?;
    let all = snap.assets;

    let q_lower = query
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let k_filter = kind.unwrap_or("all");
    let col_filter = collection.map(|s| s.trim().to_lowercase());

    let mut filtered: Vec<FlowAsset> = all
        .into_iter()
        .filter(|a| {
            if k_filter != "all" && a.kind != k_filter {
                return false;
            }
            if let Some(q) = &q_lower {
                let name_hit = a.name.to_lowercase().contains(q);
                let id_hit = a.id.to_lowercase().contains(q);
                let prompt_hit = a.prompt.as_deref().unwrap_or("").to_lowercase().contains(q);
                if !name_hit && !id_hit && !prompt_hit {
                    return false;
                }
            }
            if let Some(cf) = &col_filter {
                if cf == "none" || cf == "uncollected" {
                    if a.collection_id.is_some() {
                        return false;
                    }
                } else if cf != "all" {
                    let cid = a.collection_id.as_deref().unwrap_or("").to_lowercase();
                    let cname = a.collection_name.as_deref().unwrap_or("").to_lowercase();
                    if cid != *cf && !cname.contains(cf) {
                        return false;
                    }
                }
            }
            true
        })
        .collect();

    if let Some(lim) = limit {
        filtered.truncate(lim);
    }
    Ok(filtered)
}

/// Checks whether a snapshot reflects `name` on asset or collection `id`.
fn snapshot_has_renamed(snap: &Value, id: &str, name: &str) -> bool {
    ["assets", "collections"].iter().any(|key| {
        snap.get(*key)
            .and_then(|v| v.as_array())
            .is_some_and(|arr| {
                arr.iter().any(|item| {
                    item.get("id").and_then(|v| v.as_str()) == Some(id)
                        && item.get("name").and_then(|v| v.as_str()) == Some(name)
                })
            })
    })
}

/// Renames items through `lService` and confirms by RPC status or updated snapshot state.
pub(crate) async fn rename_assets(engine: &ChromeEngine, items: Vec<RenameEntry>) -> Result<Value> {
    ensure_flow_store(engine).await?;
    let total = items.len();
    let mut renamed = Vec::new();
    let mut failed = Vec::new();

    'items: for (idx, entry) in items.into_iter().enumerate() {
        let mut ok = false;
        for attempt in 0..2 {
            // Subscribe before calling rename so the listener catches store RPC responses.
            let mut rx = engine.subscribe_network().await?;
            let res = engine
                .call_flow_async(
                    "assetOps",
                    json!([
                        "rename",
                        entry.id,
                        { "name": entry.name, "resetOld": attempt > 0 }
                    ]),
                )
                .await?;
            if let Some(e) = res.get("err").and_then(|v| v.as_str()) {
                failed.push(json!({ "id": entry.id, "name": entry.name, "error": e }));
                continue 'items;
            }

            let mut confirmed = read_snapshot(engine)
                .await
                .is_ok_and(|snap| snapshot_has_renamed(&snap, &entry.id, &entry.name));

            if !confirmed {
                let deadline = Instant::now() + Duration::from_secs(6);
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    let slice = remaining.min(Duration::from_millis(500));
                    match tokio::time::timeout(slice, rx.recv()).await {
                        Ok(Ok(ev)) => {
                            if is_flow_mutation_rpc_ok(&ev) {
                                confirmed = true;
                                break;
                            }
                        }
                        Ok(Err(RecvError::Lagged(_))) => continue,
                        Ok(Err(RecvError::Closed)) => break,
                        Err(_) => {
                            if let Ok(snap) = read_snapshot(engine).await
                                && snapshot_has_renamed(&snap, &entry.id, &entry.name)
                            {
                                confirmed = true;
                                break;
                            }
                        }
                    }
                }
            }
            if !confirmed && let Ok(snap) = read_snapshot(engine).await {
                confirmed = snapshot_has_renamed(&snap, &entry.id, &entry.name);
            }
            if confirmed {
                ok = true;
                break;
            }
        }
        if ok {
            renamed.push(json!({ "id": entry.id, "name": entry.name }));
        } else {
            failed.push(json!({
                "id": entry.id,
                "name": entry.name,
                "error": "rename mutation not confirmed",
            }));
        }
        if idx + 1 < total {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    Ok(json!({
        "renamed": renamed.len(),
        "failed": failed.len(),
        "items": renamed,
        "errors": failed,
    }))
}

/// Builds a trash error message from a failed `assetOps` result, with the build label and each rejected attempt.
fn trash_error_message(res: &Value) -> String {
    let mut msg = res
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown trash error")
        .to_string();
    if let Some(build) = res.get("build").and_then(|v| v.as_str()) {
        msg.push_str(&format!(" (Flow front end build: {build})"));
    }
    if let Some(attempts) = res.get("attempts").and_then(|v| v.as_array()) {
        let parts: Vec<String> = attempts
            .iter()
            .map(|a| {
                let field = |k: &str| a.get(k).and_then(|v| v.as_str()).unwrap_or("?");
                format!("{}: {}", field("method"), field("error"))
            })
            .collect();
        msg.push_str(&format!("; attempts: {}", parts.join("; ")));
    }
    if let Some(checks) = res.get("failed_checks").and_then(|v| v.as_array()) {
        let names: Vec<&str> = checks
            .iter()
            .filter_map(|c| c.get("name").and_then(|v| v.as_str()))
            .collect();
        msg.push_str(&format!("; failed checks: {}", names.join(", ")));
    }
    msg
}

/// Moves a tile or collection into Google Flow trash and returns the store response.
pub(crate) async fn invoke_trash_tile(engine: &ChromeEngine, id: &str) -> Result<Value> {
    let res = engine
        .call_flow_async("assetOps", json!(["trash", id, Value::Null]))
        .await?;
    if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        anyhow::bail!("{}", trash_error_message(&res));
    }
    Ok(res)
}

/// Moves a matching asset, character, scene, or collection to trash through the Flow store.
pub(crate) async fn trash_asset(
    engine: &ChromeEngine,
    db: &FlowDb,
    match_str: &str,
) -> Result<Value> {
    let snap = read_snapshot(engine).await?;
    let assets: Vec<FlowAsset> = serde_json::from_value(
        snap.get("assets")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    )?;

    let mut target_id: Option<String> = None;
    let mut trashed_payload: Option<Value> = None;
    let mut is_character = false;

    if let Some(asset) = match_asset(&assets, match_str, true) {
        target_id = Some(asset.id.clone());
        is_character = asset.kind == "character";
        trashed_payload = Some(serde_json::to_value(asset)?);
    } else if let Some(cols) = snap.get("collections").and_then(|v| v.as_array()) {
        let raw = match_str.trim();
        let lower = raw.to_lowercase();
        let col = cols
            .iter()
            .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(raw))
            .or_else(|| {
                cols.iter().find(|c| {
                    c.get("name")
                        .and_then(|v| v.as_str())
                        .is_some_and(|n| n.eq_ignore_ascii_case(raw))
                })
            })
            .or_else(|| {
                cols.iter().find(|c| {
                    c.get("name")
                        .and_then(|v| v.as_str())
                        .is_some_and(|n| n.to_lowercase().contains(&lower))
                })
            });
        if let Some(c) = col {
            target_id = c.get("id").and_then(|v| v.as_str()).map(str::to_string);
            trashed_payload = Some(c.clone());
        }
    }

    let id = target_id.with_context(|| {
        format!(
            "No asset or collection matches '{}' for flow_trash",
            match_str
        )
    })?;
    let res = invoke_trash_tile(engine, &id)
        .await
        .with_context(|| format!("Failed to trash '{}'", id))?;
    if is_character {
        let _ = db.delete_character(&id).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    Ok(json!({
        "trashed": trashed_payload,
        "method": res.get("method").cloned().unwrap_or(Value::Null),
    }))
}
