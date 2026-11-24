// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Google Flow asset listing, matching, renaming, and trashing.
//!
//! Reads the active project store through [`crate::project::read_snapshot`].

use anyhow::{Context, Result};
use futures_util::{StreamExt, stream};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::{Duration, Instant};

use crate::collection_page::{delete_collection_through_page, rename_collection_through_page};
use crate::collections::{FlowCollection, find_collection};
use crate::db::FlowDb;
use crate::download::eval_resolve_media_url;
use crate::engine::ChromeEngine;
use crate::project::{ensure_flow_store, is_flow_mutation_rpc_ok, read_snapshot};
use crate::project_store::ProjectStoreSession;
use crate::tile_menu::{rename_through_menu, tile_state, trash_through_menu};

/// Maximum number of URL lookups that can run at the same time.
const MEDIA_URL_LOOKUPS: usize = 4;

/// Time to resolve missing URLs in one asset list response.
const ASSET_LIST_URL_BUDGET: Duration = Duration::from_secs(10);

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

/// Operation to run in the active project library.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AssetAction {
    /// Lists the assets in the active project.
    #[default]
    List,
    /// Uploads local images and videos to the active project.
    Upload,
}

/// Parameters for `flow_assets`.
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub(crate) struct AssetsParams {
    /// Asset operation. The default is `list`.
    #[serde(default)]
    pub(crate) action: AssetAction,
    /// Local image or video file paths for `upload`.
    pub(crate) files: Option<Vec<String>>,
    /// Case-insensitive substring that matches asset ID, name, or prompt.
    pub(crate) query: Option<String>,
    /// Asset kind filter: "image", "video", "scene", "character", or "all" (default).
    pub(crate) kind: Option<String>,
    /// Collection filter: collection ID, name substring, "all", "none", or "uncollected".
    pub(crate) collection: Option<String>,
    /// Maximum number of assets to return (at least 1).
    #[schemars(range(min = 1))]
    pub(crate) limit: Option<usize>,
    /// Resolve missing media URLs when true. Default is true.
    pub(crate) resolve_urls: Option<bool>,
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
async fn populate_missing_media_urls(
    engine: &ChromeEngine,
    assets: &mut [FlowAsset],
    deadline: Option<Instant>,
) {
    let mut missing: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, asset) in assets.iter().enumerate() {
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
        missing.entry(media_id.to_string()).or_default().push(index);
    }
    let mut groups: Vec<_> = missing.into_iter().collect();
    groups.sort_unstable_by_key(|(_, indices)| indices.first().copied());
    let lookups = stream::iter(groups)
        .map(|(media_id, indices)| async move {
            let timeout_ms = deadline.and_then(|at| {
                u64::try_from(at.saturating_duration_since(Instant::now()).as_millis()).ok()
            });
            let resolved = eval_resolve_media_url(engine, &media_id, timeout_ms)
                .await
                .and_then(|val| {
                    val.get("url")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|u| u.starts_with("http"))
                        .map(str::to_string)
                });
            (indices, resolved)
        })
        .buffer_unordered(MEDIA_URL_LOOKUPS);
    futures_util::pin_mut!(lookups);
    while let Some((indices, url)) = lookups.next().await {
        for index in indices {
            assets[index].url = url.clone();
        }
    }
}

/// Reads the active project's metadata and full asset list in one snapshot call.
pub(crate) async fn list_assets_with_project(
    engine: &ChromeEngine,
) -> Result<ProjectAssetsSnapshot> {
    let mut snapshot = read_project_assets(engine).await?;
    populate_missing_media_urls(engine, &mut snapshot.assets, None).await;
    Ok(snapshot)
}

/// Reads project metadata and assets without requesting media URLs.
async fn read_project_assets(engine: &ChromeEngine) -> Result<ProjectAssetsSnapshot> {
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
    let assets = serde_json::from_value(
        snap.get("assets")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    )?;
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
    request: &AssetsParams,
) -> Result<Vec<FlowAsset>> {
    let snap = read_project_assets(engine).await?;
    let all = snap.assets;

    let q_lower = request
        .query
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let k_filter = request.kind.as_deref().unwrap_or("all");
    let col_filter = request
        .collection
        .as_deref()
        .map(|s| s.trim().to_lowercase());

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

    if let Some(lim) = request.limit {
        filtered.truncate(lim);
    }
    if request.resolve_urls.unwrap_or(true) {
        let deadline = Instant::now() + ASSET_LIST_URL_BUDGET;
        let _ = tokio::time::timeout_at(
            deadline,
            populate_missing_media_urls(engine, &mut filtered, Some(deadline)),
        )
        .await;
    }
    Ok(filtered)
}

/// Checks whether the project snapshot shows the requested name for an asset or collection.
fn snapshot_has_renamed(snap: &Value, id: &str, name: &str) -> bool {
    ["assets", "collections"].into_iter().any(|section| {
        snap.get(section)
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("id").and_then(Value::as_str) == Some(id)
                        && item.get("name").and_then(Value::as_str) == Some(name)
                })
            })
    })
}

/// Renames media, character, scene, and collection tiles without requiring an upfront direct store session.
pub(crate) async fn rename_assets(engine: &ChromeEngine, items: Vec<RenameEntry>) -> Result<Value> {
    let mut store_lock = Some(engine.lock_project_store().await);
    ensure_flow_store(engine).await?;
    let total = items.len();
    let mut renamed = Vec::new();
    let mut failed = Vec::new();

    'items: for (idx, entry) in items.into_iter().enumerate() {
        if store_lock.is_none() {
            store_lock = Some(engine.lock_project_store().await);
            ensure_flow_store(engine).await?;
        }
        let state = tile_state(engine, &entry.id).await;
        if state.is_present() && state.kind == "collection" {
            match rename_collection_through_page(engine, &entry.id, &entry.name).await {
                Ok(result) => {
                    renamed.push(json!({
                        "id": entry.id,
                        "name": entry.name,
                        "method": result["method"],
                    }));
                    if idx + 1 < total {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                    continue 'items;
                }
                Err(page_err) => {
                    drop(store_lock.take());
                    let direct = match ProjectStoreSession::open(engine).await {
                        Ok(session) => session.rename(&entry.id, &entry.name).await,
                        Err(_) => Err(page_err),
                    };
                    match direct {
                        Ok(result) => renamed.push(json!({
                            "id": entry.id,
                            "name": entry.name,
                            "method": result["method"],
                        })),
                        Err(err) => failed.push(rename_error(&entry, &err)),
                    }
                    continue 'items;
                }
            }
        }
        // Use the rename control of the page first. The page then builds its own mutation.
        if state.is_present()
            && matches!(
                rename_through_menu(engine, &entry.id, &entry.name).await,
                Ok(true)
            )
        {
            renamed.push(json!({ "id": entry.id, "name": entry.name, "method": "menu:rename" }));
            if idx + 1 < total {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            continue 'items;
        }
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
            renamed.push(json!({ "id": entry.id, "name": entry.name, "method": "mutation" }));
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

/// Returns the error for a rename entry.
fn rename_error(entry: &RenameEntry, err: &anyhow::Error) -> Value {
    json!({ "id": entry.id, "name": entry.name, "error": format!("{err:#}") })
}

/// Deletes a collection through page controls first and falls back to the direct store session.
async fn invoke_trash_collection(
    engine: &ChromeEngine,
    store_lock: &mut Option<tokio::sync::MutexGuard<'_, ()>>,
    id: &str,
) -> Result<Value> {
    match delete_collection_through_page(engine, id).await {
        Ok(result) => Ok(result),
        Err(err) if format!("{err:#}").contains("collection_has_child_collections") => Err(err),
        Err(page_err) => {
            drop(store_lock.take());
            match ProjectStoreSession::open(engine).await {
                Ok(session) => session.delete(id).await,
                Err(_) => Err(page_err),
            }
        }
    }
}

/// Moves a non-collection tile to trash through its context menu or a direct store session.
async fn invoke_trash_tile(
    engine: &ChromeEngine,
    store_lock: &mut Option<tokio::sync::MutexGuard<'_, ()>>,
    id: &str,
) -> Result<Value> {
    let menu_error =
        if ensure_flow_store(engine).await.is_ok() && tile_state(engine, id).await.is_present() {
            match trash_through_menu(engine, id).await {
                Ok(true) => {
                    return Ok(
                        json!({ "ok": true, "method": "menu:move_to_trash", "confirmed": true }),
                    );
                }
                Ok(false) => None,
                Err(err) => Some(format!("{err:#}")),
            }
        } else {
            None
        };
    drop(store_lock.take());
    let session = ProjectStoreSession::open(engine).await.map_err(|err| {
        if let Some(menu_err) = &menu_error {
            anyhow::anyhow!("{err:#} (menu fallback: {menu_err})")
        } else {
            err
        }
    })?;
    let mut result = session
        .call("trashAssetOp", json!(id), Some("trash asset"))
        .await?;
    if let Some(object) = result.as_object_mut()
        && let Some(error) = menu_error
    {
        object.insert("menu_error".to_string(), Value::String(error));
    }
    Ok(result)
}

/// Moves a matching asset, character, scene, or collection to trash without requiring an upfront store session.
pub(crate) async fn trash_asset(
    engine: &ChromeEngine,
    db: &FlowDb,
    match_str: &str,
) -> Result<Value> {
    let mut store_lock = Some(engine.lock_project_store().await);
    let snap = read_snapshot(engine).await?;
    let query = match_str.trim();
    let collections: Vec<FlowCollection> = serde_json::from_value(
        snap.get("collections")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    )?;
    if let Some(exact_col) = collections.iter().find(|c| c.id == query) {
        return invoke_trash_collection(engine, &mut store_lock, &exact_col.id).await;
    }

    let assets: Vec<FlowAsset> = serde_json::from_value(
        snap.get("assets")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    )?;
    let Some(asset) = match_asset(&assets, query, true).cloned() else {
        let collection = find_collection(&collections, query, true)?
            .with_context(|| format!("No asset or collection matches '{query}' for flow_trash"))?;
        return invoke_trash_collection(engine, &mut store_lock, &collection.id).await;
    };

    let id = &asset.id;
    let is_character = asset.kind == "character";
    let res = invoke_trash_tile(engine, &mut store_lock, id)
        .await
        .map_err(|err| anyhow::anyhow!("Failed to trash '{id}': {err:#}"))?;
    if is_character {
        let _ = db.delete_character(id).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    Ok(json!({
        "trashed": asset,
        "method": res.get("method").cloned().unwrap_or(Value::Null),
        "confirmed": res.get("confirmed").cloned().unwrap_or(Value::Null),
    }))
}
