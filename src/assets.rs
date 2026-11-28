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
use tokio::time::{Duration, Instant};

pub(crate) use crate::asset_matching::match_asset;
use crate::asset_matching::{
    pin_matched_variant_id, resolve_scene_clip_selector, strip_media_prefix, strip_resource_prefix,
};
use crate::collections::{FlowCollection, find_collection};
use crate::db::FlowDb;
use crate::download_urls::eval_resolve_media_url;
use crate::engine::ChromeEngine;
use crate::project::{ensure_flow_store, read_snapshot};
use crate::project_store::ProjectStoreSession;
use crate::tile_menu::{rename_through_menu, tile_state, trash_through_menu};

/// Maximum number of URL lookups that can run at the same time.
const MEDIA_URL_LOOKUPS: usize = 4;

/// Time to resolve missing URLs in one asset list response.
const ASSET_LIST_URL_BUDGET: Duration = Duration::from_secs(10);

/// Ready video variant entry recorded on a project video or single-clip scene tile.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct VideoVariantAsset {
    /// Media ID of the variant without a `media/` prefix.
    pub(crate) media_id: String,
    /// Verified quality label (`"360p"`, `"720p"`, `"1080p"`, or `"4k"`).
    #[serde(default)]
    pub(crate) quality: Option<String>,
    /// Direct media URL on the variant when available.
    #[serde(default)]
    pub(crate) url: Option<String>,
    /// Variant width in pixels when available.
    #[serde(default)]
    pub(crate) width: Option<u32>,
    /// Variant height in pixels when available.
    #[serde(default)]
    pub(crate) height: Option<u32>,
    /// Variant duration in seconds when available.
    #[serde(default)]
    pub(crate) duration: Option<f64>,
}

/// Clip workflow entry inside a project scene tile.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct SceneClipAsset {
    /// Clip workflow ID inside the scene.
    pub(crate) workflow_id: String,
    /// Primary media ID of the clip when available.
    #[serde(default)]
    pub(crate) primary_media_id: Option<String>,
    /// Direct media URL of the clip when available.
    #[serde(default)]
    pub(crate) url: Option<String>,
}

/// Media asset or scene item inside a Google Flow project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct FlowAsset {
    /// Flow asset or tile ID.
    pub(crate) id: String,
    /// Asset display name (`displayName` in the tile store).
    pub(crate) name: String,
    /// Asset kind (`"video"`, `"image"`, `"audio"`, `"scene"`, or `"character"`).
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
    /// Known primary, history, and upscaled variant media IDs on the tile.
    #[serde(default, skip_serializing)]
    pub(crate) media_ids: Vec<String>,
    /// Optional workflow ID associated with a custom voice entry.
    #[serde(default, skip_serializing)]
    pub(crate) workflow_id: Option<String>,
    /// True when a multi-clip or trimmed scene requires Angular scene export.
    #[serde(default, skip_serializing)]
    pub(crate) requires_scene_export: bool,
    /// True when `as29s` case `11` flagged raw 24 kHz PCM audio.
    #[serde(default, skip_serializing)]
    pub(crate) pcm_audio: bool,
    /// Underlying media family override when a tile downloads audio.
    #[serde(default, skip_serializing)]
    pub(crate) media_kind: Option<String>,
    /// Ready video variants (original and upscaled resolutions) on the tile.
    #[serde(default, skip_serializing)]
    pub(crate) variants: Vec<VideoVariantAsset>,
    /// Ordered clip workflow entries on a scene tile.
    #[serde(default, skip_serializing)]
    pub(crate) scene_clips: Vec<SceneClipAsset>,
    /// Creation timestamp (`createTime`) string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) created_at: Option<String>,
}

impl FlowAsset {
    /// Creates an image asset descriptor for a generated character look.
    pub(crate) fn character_look(
        fallback_id: &str,
        name: String,
        url: Option<String>,
        primary_media_id: Option<String>,
    ) -> Self {
        Self {
            id: primary_media_id
                .clone()
                .unwrap_or_else(|| fallback_id.to_string()),
            name,
            kind: "image".to_string(),
            prompt: None,
            url,
            collection_id: None,
            collection_name: None,
            width: None,
            height: None,
            duration: None,
            primary_media_id,
            personality_notes: None,
            voice: None,
            trim_start_seconds: None,
            trim_end_seconds: None,
            media_status: None,
            media_error: None,
            media_ids: Vec::new(),
            workflow_id: None,
            requires_scene_export: false,
            pcm_audio: false,
            media_kind: None,
            variants: Vec::new(),
            scene_clips: Vec::new(),
            created_at: None,
        }
    }
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
    /// Asset kind filter: "image", "video", "audio", "scene", "character", or "all" (default).
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
    /// Exact asset ID, `<sceneId>:<wfId>` scene clip ID, media or variant ID, exact name, or case-insensitive asset substring to download.
    #[serde(rename = "match")]
    pub(crate) r#match: String,
    /// Optional video quality selector: `"original"` (default), `"360p"`, `"720p"`, `"1080p"`, `"4k"`, or `"best"`.
    #[serde(default, alias = "resolution")]
    pub(crate) quality: Option<String>,
}

/// Parameters for `flow_trash`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct TrashParams {
    /// Case-insensitive asset or collection ID, name, or prompt substring to trash.
    #[serde(rename = "match")]
    pub(crate) r#match: String,
}

/// Resolves missing direct media URLs on finished media, character, and 1-clip scene tiles through `as29s` RPCs.
async fn populate_missing_media_urls(
    engine: &ChromeEngine,
    assets: &mut [FlowAsset],
    deadline: Option<Instant>,
) {
    let mut missing: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, asset) in assets.iter().enumerate() {
        if !matches!(
            asset.kind.as_str(),
            "video" | "image" | "character" | "audio" | "scene"
        ) || asset.requires_scene_export
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
            let (resolved, media_kind, pcm_audio) =
                eval_resolve_media_url(engine, &media_id, timeout_ms)
                    .await
                    .map(|val| {
                        let url = val
                            .get("url")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|u| u.starts_with("http"))
                            .map(str::to_string);
                        let kind = val
                            .get("media_kind")
                            .and_then(|v| v.as_str())
                            .map(str::to_string);
                        let pcm = val
                            .get("pcm_audio")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        (url, kind, pcm)
                    })
                    .unwrap_or((None, None, false));
            (indices, resolved, media_kind, pcm_audio)
        })
        .buffer_unordered(MEDIA_URL_LOOKUPS);
    futures_util::pin_mut!(lookups);
    while let Some((indices, url, media_kind, pcm_audio)) = lookups.next().await {
        for index in indices {
            if let Some(ref resolved_url) = url {
                assets[index].url = Some(resolved_url.clone());
            }
            if pcm_audio {
                assets[index].pcm_audio = true;
            }
            if let Some(ref mk) = media_kind {
                if assets[index].kind == "image" && mk == "audio" {
                    assets[index].kind = "audio".to_string();
                }
                assets[index].media_kind = Some(mk.clone());
            }
        }
    }
}

/// Reads the active project's metadata and full asset list within the URL lookup time limit.
pub(crate) async fn list_assets_with_project(
    engine: &ChromeEngine,
) -> Result<ProjectAssetsSnapshot> {
    let mut snapshot = read_project_assets(engine).await?;
    let deadline = Instant::now() + ASSET_LIST_URL_BUDGET;
    let _ = tokio::time::timeout_at(
        deadline,
        populate_missing_media_urls(engine, &mut snapshot.assets, Some(deadline)),
    )
    .await;
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

/// Resolves the single best-matching asset and active project metadata across all project assets.
pub(crate) async fn resolve_asset(
    engine: &ChromeEngine,
    match_str: &str,
    include_prompt: bool,
    context_label: &str,
) -> Result<(FlowAsset, Option<String>, Option<String>)> {
    let snap = read_project_assets(engine).await?;
    if let Some(clip_asset) = resolve_scene_clip_selector(&snap.assets, match_str, context_label)? {
        return Ok((clip_asset, snap.project_id, snap.project_title));
    }
    let mut target = match_asset(&snap.assets, match_str, include_prompt)
        .cloned()
        .with_context(|| {
            format!(
                "No asset matches '{}' in the active project for {}",
                match_str, context_label
            )
        })?;
    pin_matched_variant_id(&mut target, match_str);
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
    let resolve_urls = request.resolve_urls.unwrap_or(true);
    let classify_media = resolve_urls && matches!(k_filter, "image" | "audio");
    let col_filter = request
        .collection
        .as_deref()
        .map(|s| s.trim().to_lowercase());

    let mut filtered: Vec<FlowAsset> = all
        .into_iter()
        .filter(|a| {
            let possible_audio =
                classify_media && k_filter == "audio" && a.kind == "image" && a.url.is_none();
            if k_filter != "all" && a.kind != k_filter && !possible_audio {
                return false;
            }
            if let Some(q) = &q_lower {
                let clean_q = strip_media_prefix(q);
                let clean_wf_q = strip_resource_prefix(q);
                let name_hit = a.name.to_lowercase().contains(q);
                let id_hit = a.id.to_lowercase().contains(q)
                    || a.workflow_id
                        .as_deref()
                        .is_some_and(|wf| wf.to_lowercase().contains(clean_wf_q))
                    || a.primary_media_id
                        .as_deref()
                        .is_some_and(|id| id.to_lowercase().contains(clean_q))
                    || a.media_ids
                        .iter()
                        .any(|id| id.to_lowercase().contains(clean_q));
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

    if !classify_media && let Some(lim) = request.limit {
        filtered.truncate(lim);
    }
    if resolve_urls {
        let deadline = Instant::now() + ASSET_LIST_URL_BUDGET;
        let _ = tokio::time::timeout_at(
            deadline,
            populate_missing_media_urls(engine, &mut filtered, Some(deadline)),
        )
        .await;
    }
    if classify_media {
        filtered.retain(|a| a.kind == k_filter);
        if let Some(lim) = request.limit {
            filtered.truncate(lim);
        }
    }
    Ok(filtered)
}

/// Checks whether the asset snapshot shows the requested name.
fn snapshot_has_renamed(snap: &Value, id: &str, name: &str) -> bool {
    snap.get("assets")
        .and_then(Value::as_array)
        .is_some_and(|assets| {
            assets.iter().any(|item| {
                item.get("id").and_then(Value::as_str) == Some(id)
                    && item.get("name").and_then(Value::as_str) == Some(name)
            })
        })
}

/// Polls project snapshots after a settle delay to confirm that `id` holds `name`.
async fn confirm_renamed_asset(engine: &ChromeEngine, id: &str, name: &str) -> bool {
    let deadline = Instant::now() + Duration::from_secs(6);
    tokio::time::sleep(Duration::from_millis(350)).await;
    while Instant::now() < deadline {
        if let Ok(snap) = read_snapshot(engine).await
            && snapshot_has_renamed(&snap, id, name)
        {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if let Ok(settled) = read_snapshot(engine).await
                && snapshot_has_renamed(&settled, id, name)
            {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    false
}

/// Renames collections through the collection store and other tiles through the page or store.
pub(crate) async fn rename_assets(engine: &ChromeEngine, items: Vec<RenameEntry>) -> Result<Value> {
    let collections = ProjectStoreSession::open(engine).await?;
    let total = items.len();
    let mut renamed = Vec::new();
    let mut failed = Vec::new();
    let mut asset_store_ready = false;

    'items: for (idx, entry) in items.into_iter().enumerate() {
        match collections.is_collection(&entry.id).await {
            Ok(false) => {}
            Ok(true) => {
                match collections.rename(&entry.id, &entry.name).await {
                    Ok(result) => renamed.push(json!({
                        "id": entry.id, "name": entry.name, "method": result["method"]
                    })),
                    Err(err) => failed.push(rename_error(&entry, &err)),
                }
                continue 'items;
            }
            Err(err) => {
                failed.push(rename_error(&entry, &err));
                continue 'items;
            }
        }
        if !asset_store_ready {
            ensure_flow_store(engine).await?;
            asset_store_ready = true;
        }
        // Use the rename control of the page first. The page then builds its own mutation.
        if tile_state(engine, &entry.id).await.is_present()
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
            if confirm_renamed_asset(engine, &entry.id, &entry.name).await {
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

/// Moves an asset to trash through the tile menu or the pinned project store.
async fn invoke_trash_tile(
    engine: &ChromeEngine,
    session: &ProjectStoreSession<'_>,
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

/// Moves a matching asset, character, scene, or collection to trash through the Flow store.
pub(crate) async fn trash_asset(
    engine: &ChromeEngine,
    db: &FlowDb,
    match_str: &str,
) -> Result<Value> {
    let collections = ProjectStoreSession::open(engine).await?;
    let query = match_str.trim();
    if collections.is_collection(query).await? {
        return collections.delete(query).await;
    }

    let mut tiles = collections
        .run_collections(json!({ "action": "assets" }))
        .await?;
    let assets: Vec<FlowAsset> = serde_json::from_value(tiles["assets"].take())?;
    let Some(asset) = match_asset(&assets, query, true) else {
        let summaries: Vec<FlowCollection> = serde_json::from_value(tiles["collections"].take())?;
        let collection = find_collection(&summaries, query, true)?
            .with_context(|| format!("No asset or collection matches '{query}' for flow_trash"))?;
        return collections.delete(&collection.id).await;
    };

    let id = &asset.id;
    let is_character = asset.kind == "character";
    let res = invoke_trash_tile(engine, &collections, id)
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
