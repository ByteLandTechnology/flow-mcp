// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Application service routing Google Flow tools, job queuing, and SQLite persistence.

use anyhow::Result;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use rmcp::model::{Resource, ResourceContents};
use serde_json::{Value, json};
use std::sync::Arc;

use crate::assets::{self, AssetsParams, DownloadParams, RenameEntry};
use crate::auth::{self, LoginParams};
use crate::collections::{self, CollectionsParams};
use crate::config;
use crate::db::{
    DOWNLOAD_ASSET_RESOURCE_PREFIX, DOWNLOAD_RESOURCE_PREFIX, DownloadRecord, DownloadsParams,
    FlowDb, effective_mime_type,
};
use crate::download;
use crate::engine::{ChromeEngine, ENGINE_NAME};
use crate::generation::{self, AgentImagesParams, EditParams, GenerateParams};
use crate::media_files;
use crate::project::{self, ProjectsParams};
use crate::queue::{JobQueue, JobResult, JobRunner, JobView, SceneParams, WaitParams};
use crate::scenes::{self, ScenesParams, VideoParams};

/// Maximum downloaded file size served directly through MCP `resources/read` (`64 MiB`).
const MAX_RESOURCE_READ_BYTES: u64 = 64 * 1024 * 1024;

/// Failure reasons when reading a downloaded file as an MCP resource.
pub(crate) enum ResourceReadError {
    /// The URI does not match a valid `flow://downloads/...` format.
    InvalidUri(String),
    /// No matching database row or managed disk file exists.
    NotFound(String),
    /// The file exceeds the 64 MiB `resources/read` limit and must be fetched with `read_chunk`.
    TooLarge(String),
    /// Unexpected storage or I/O error.
    Internal(String),
}

/// Converts a [`DownloadRecord`] into an MCP [`Resource`] descriptor.
pub(crate) fn record_to_mcp_resource(rec: &DownloadRecord) -> Resource {
    let mime = effective_mime_type(rec.mime_type.as_deref(), &rec.file_path);
    let mut resource = Resource::new(rec.resource_uri.clone(), rec.file_name.clone())
        .with_mime_type(mime)
        .with_size(rec.size_bytes)
        .with_description(format!("Google Flow {} ({})", rec.kind, rec.asset_id));
    if !rec.name.is_empty() {
        resource = resource.with_title(rec.name.clone());
    }
    resource
}

/// Application service that coordinates Flow tools, background jobs, and SQLite storage.
pub(crate) struct FlowService {
    /// Managed Chrome CDP browser engine.
    engine: Arc<ChromeEngine>,
    /// Single-worker serial automation queue.
    queue: Arc<JobQueue>,
    /// SQLite handle for downloads and character metadata.
    db: FlowDb,
}

impl FlowService {
    /// Creates a [`FlowService`] connected to [`ChromeEngine`], [`FlowDb`], and a serial [`JobQueue`].
    pub(crate) fn new(engine: Arc<ChromeEngine>) -> Arc<Self> {
        let db = FlowDb::new();
        let engine_for_runner = Arc::clone(&engine);
        let db_for_runner = db.clone();
        let runner: JobRunner = Arc::new(move |scene, on_progress| {
            let engine = Arc::clone(&engine_for_runner);
            let db = db_for_runner.clone();
            Box::pin(async move {
                let (files, created, resources) = if scene.agent.unwrap_or(false) {
                    generation::run_agent_batch(&engine, &db, &scene, on_progress).await?
                } else if let Some(ref extend_from) = scene.video_extend_from {
                    scenes::run_video_extend(
                        &engine,
                        &db,
                        extend_from,
                        &scene.prompt,
                        scene.scene_id.as_deref(),
                        on_progress,
                    )
                    .await?
                } else if let Some(ref edit_from) = scene.edit_from {
                    generation::run_edit(&engine, &db, edit_from, &scene.prompt, on_progress)
                        .await?
                } else {
                    generation::run_generation(&engine, &db, &scene, on_progress).await?
                };
                Ok(JobResult {
                    files,
                    created,
                    resources,
                })
            })
        });

        let queue = JobQueue::new(runner);
        Arc::new(Self { engine, queue, db })
    }

    /// Returns Flow browser state, jobs, engine capabilities, saved looks, download count, and paths.
    pub(crate) async fn status(&self, probe: bool) -> Result<Value> {
        let (flow_st, jobs, looks_res, downloads_res) = tokio::join!(
            project::get_flow_state(&self.engine, probe),
            self.queue.list(),
            self.db.load_character_looks(),
            self.db.count_downloads(),
        );
        let looks = looks_res?;
        let downloads_indexed = downloads_res?;
        Ok(json!({
            "flow": flow_st,
            "jobs": jobs,
            "engine": ENGINE_NAME,
            "capabilities": {
                "chrome_cdp": true,
            },
            "characters_saved": looks,
            "downloads_indexed": downloads_indexed,
            "db_path": config::db_path().to_string_lossy(),
            "downloads_dir": config::downloads_dir().to_string_lossy(),
            "cookies_path": config::cookies_path().to_string_lossy(),
            "persistent_profile": true,
            "profile_dir": config::chrome_profile_dir().to_string_lossy(),
            "cdp_endpoint": self.engine.cdp_endpoint().await,
            "chrome_binary": crate::chrome::find_chrome().map(|p| p.to_string_lossy().into_owned()),
        }))
    }

    /// Returns all currently tracked queue jobs.
    pub(crate) async fn list_jobs(&self) -> Vec<JobView> {
        self.queue.list().await
    }

    /// Saves any supplied `character_look` under `character_role` and appends it to `prompt`.
    async fn apply_character_look_prefill(&self, scene: &mut SceneParams) -> Result<()> {
        let Some(role) = scene.character_role.clone() else {
            return Ok(());
        };
        if let Some(look) = scene.character_look.as_deref() {
            self.db.save_character_look(&role, look).await?;
            scene.prompt = format!("{}, character {}: {}", scene.prompt, role, look);
        } else if let Some(look) = self.db.get_character_look(&role).await? {
            scene.prompt = format!("{}, character {}: {}", scene.prompt, role, look);
        }
        Ok(())
    }

    /// Saves any supplied character look in SQLite, appends it to `prompt`, and queues the job.
    pub(crate) async fn generate(&self, req: GenerateParams) -> Result<JobView> {
        let mut scene = SceneParams {
            prompt: req.prompt,
            mode: req.mode,
            model: req.model,
            aspect: req.aspect,
            count: req.count,
            frames: req.frames,
            name: req.name,
            download: req.download,
            character_role: req.character_role,
            character_look: req.character_look,
            asset_ids: req.asset_ids,
            characters: req.characters,
            video_type: req.video_type,
            duration: req.duration,
            resolution: req.resolution,
            ..Default::default()
        };
        self.apply_character_look_prefill(&mut scene).await?;
        Ok(self.queue.enqueue(scene).await)
    }

    /// Queues a Flow Agent Mode batch image job.
    pub(crate) async fn agent_images(&self, req: AgentImagesParams) -> Result<JobView> {
        let scene = SceneParams {
            prompt: req.prompt,
            mode: Some("image".to_string()),
            model: req.model,
            aspect: req.aspect,
            count: req.count,
            agent: Some(true),
            ..Default::default()
        };
        Ok(self.queue.enqueue(scene).await)
    }

    /// Queues an asset edit job that matches `req.match`.
    pub(crate) async fn edit(&self, req: EditParams) -> Result<JobView> {
        let scene = SceneParams {
            prompt: req.prompt,
            edit_from: Some(req.r#match),
            ..Default::default()
        };
        Ok(self.queue.enqueue(scene).await)
    }

    /// Lists, creates, adds clips to, renames, or trashes Google Flow scenes.
    pub(crate) async fn scenes(&self, req: ScenesParams) -> Result<Value> {
        scenes::handle_scenes(&self.engine, &self.db, req).await
    }

    /// Trims a video immediately or queues a video extension job.
    pub(crate) async fn video(&self, req: VideoParams) -> Result<Value> {
        match req.action.trim() {
            "trim" => {
                scenes::trim_video(
                    &self.engine,
                    &req.r#match,
                    req.start_seconds,
                    req.end_seconds,
                )
                .await
            }
            "extend" => {
                let prompt = req
                    .prompt
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| anyhow::anyhow!("flow_video extend requires 'prompt'"))?;
                let scene = SceneParams {
                    prompt,
                    video_extend_from: Some(req.r#match),
                    scene_id: req.scene_id,
                    ..Default::default()
                };
                let job = self.queue.enqueue(scene).await;
                Ok(serde_json::to_value(job)?)
            }
            other => anyhow::bail!("Unknown video action: {}", other),
        }
    }

    /// Waits for `req.ids` or all jobs up to `req.timeout` seconds (default `600`).
    pub(crate) async fn wait(&self, req: WaitParams) -> Result<Value> {
        let ids = req
            .ids
            .filter(|v| !v.is_empty())
            .or_else(|| req.id.map(|s| vec![s]));
        let timeout_s = req.timeout.unwrap_or(600);
        let jobs = self
            .queue
            .wait_for(ids.as_deref(), timeout_s.saturating_mul(1000))
            .await?;
        Ok(json!({ "jobs": jobs }))
    }

    /// Cancels a queued or running job by `id`.
    pub(crate) async fn cancel(&self, id: &str) -> Result<Value> {
        let res = self.queue.cancel(id).await?;
        Ok(json!({ "job": res }))
    }

    /// Retries a failed or cancelled job by `id`.
    pub(crate) async fn retry(&self, id: &str) -> Result<Value> {
        let res = self.queue.retry(id).await?;
        Ok(json!({ "job": res }))
    }

    /// Opens the Flow home page, clicks "New project", and saves `title` when given.
    pub(crate) async fn new_project(&self, title: Option<&str>) -> Result<Value> {
        project::create_project(&self.engine, title).await
    }

    /// Lists, creates, opens, renames, or deletes Google Flow projects.
    pub(crate) async fn projects(&self, req: ProjectsParams) -> Result<Value> {
        let is_delete = req
            .action
            .as_deref()
            .is_some_and(|a| a.trim().eq_ignore_ascii_case("delete"));
        let req_id = req.id.clone();
        let res = project::handle_projects(&self.engine, req).await?;
        if is_delete
            && let Some(pid) = res
                .get("deleted_id")
                .and_then(|v| v.as_str())
                .or(req_id.as_deref())
        {
            let _ = self.db.delete_characters_by_project(pid).await;
        }
        Ok(res)
    }

    /// Runs `flow_login` actions for Google Sign-In, cookie synchronization, status, and logout.
    pub(crate) async fn login(&self, req: LoginParams) -> Result<Value> {
        auth::handle_login(&self.engine, req).await
    }

    /// Lists assets in the active Google Flow project.
    pub(crate) async fn assets(&self, req: AssetsParams) -> Result<Value> {
        let list = assets::list_assets(
            &self.engine,
            req.query.as_deref(),
            req.kind.as_deref(),
            req.collection.as_deref(),
            req.limit,
        )
        .await?;
        Ok(json!({ "count": list.len(), "assets": list }))
    }

    /// Renames one or more assets or collections in the active Google Flow project.
    pub(crate) async fn rename(&self, items: Vec<RenameEntry>) -> Result<Value> {
        anyhow::ensure!(!items.is_empty(), "flow_rename requires at least one item");
        let res = assets::rename_assets(&self.engine, items).await?;
        if let Some(renamed) = res.get("items").and_then(|v| v.as_array()) {
            for item in renamed {
                if let (Some(id), Some(name)) = (
                    item.get("id").and_then(|v| v.as_str()),
                    item.get("name").and_then(|v| v.as_str()),
                ) {
                    let _ = self.db.rename_character_if_exists(id, name).await;
                }
            }
        }
        Ok(res)
    }

    /// Lists, creates, renames, or populates collections in the active Flow project.
    pub(crate) async fn collections(&self, req: CollectionsParams) -> Result<Value> {
        collections::handle_collections(&self.engine, req).await
    }

    /// Moves the asset or collection matching `match_str` to trash in the active Google Flow project.
    pub(crate) async fn trash(&self, match_str: &str) -> Result<Value> {
        assets::trash_asset(&self.engine, &self.db, match_str).await
    }

    /// Downloads the asset matching `req.match` into `<home>/downloads` and records it in SQLite.
    pub(crate) async fn download(&self, req: DownloadParams) -> Result<DownloadRecord> {
        download::download_asset(&self.engine, &self.db, &req.r#match).await
    }

    /// Resolves one download record by row `id` or latest `asset_id` for inspection or chunk reads.
    async fn resolve_download_for_get_or_chunk(
        &self,
        id: Option<i64>,
        asset_id: Option<&str>,
        existing_only: bool,
    ) -> Result<DownloadRecord> {
        if let Some(row_id) = id {
            return self
                .db
                .get_download_by_id(row_id)
                .await?
                .ok_or_else(|| anyhow::anyhow!("No download record with id {}", row_id));
        }
        let aid = asset_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Specify 'id' or 'asset_id'"))?;
        let rec = if existing_only {
            self.db.find_existing_file_for_asset(aid).await?
        } else {
            self.db.get_latest_download_for_asset(aid).await?
        };
        rec.ok_or_else(|| anyhow::anyhow!("No download record for asset '{}'", aid))
    }

    /// Queries, inspects, reads chunks from, prunes, deletes, or clears indexed downloads.
    pub(crate) async fn downloads(&self, req: DownloadsParams) -> Result<Value> {
        let action = req.action.as_deref().unwrap_or("list");
        match action {
            "list" => {
                let (total_indexed, total_indexed_bytes, downloads) =
                    self.db.list_downloads(req).await?;
                let matched_bytes: u64 = downloads.iter().map(|r| r.size_bytes).sum();
                Ok(json!({
                    "action": "list",
                    "count": downloads.len(),
                    "total_indexed": total_indexed,
                    "matched_bytes": matched_bytes,
                    "total_indexed_bytes": total_indexed_bytes,
                    "db_path": config::db_path().to_string_lossy(),
                    "downloads_dir": config::downloads_dir().to_string_lossy(),
                    "downloads": downloads,
                }))
            }
            "get" => {
                let rec = self
                    .resolve_download_for_get_or_chunk(req.id, req.asset_id.as_deref(), false)
                    .await?;
                Ok(json!({
                    "action": "get",
                    "record": rec,
                }))
            }
            "read_chunk" => {
                let rec = self
                    .resolve_download_for_get_or_chunk(req.id, req.asset_id.as_deref(), true)
                    .await?;
                media_files::read_download_chunk(&rec, req.offset.unwrap_or(0), req.length).await
            }
            "delete" | "remove" => {
                let records = self
                    .db
                    .select_downloads_by_selector(req.id, req.asset_id.as_deref())
                    .await?;
                if records.is_empty() {
                    anyhow::bail!("No download record matches the given selector");
                }
                let (ids, deleted_files, freed_bytes, items) =
                    media_files::remove_managed_download_files(&records).await?;
                let (deleted_records, remaining_records) =
                    self.db.delete_downloads_by_ids(&ids).await?;
                Ok(json!({
                    "action": "delete",
                    "deleted_records": deleted_records,
                    "deleted_files": deleted_files,
                    "freed_bytes": freed_bytes,
                    "remaining_records": remaining_records,
                    "items": items,
                }))
            }
            "prune" => {
                let (pruned_records, remaining_records) = self.db.prune_missing_downloads().await?;
                Ok(json!({
                    "action": "prune",
                    "pruned_records": pruned_records,
                    "remaining_records": remaining_records,
                }))
            }
            "clear" => {
                let records = self
                    .db
                    .select_downloads_for_clear(req.older_than_days)
                    .await?;
                if records.is_empty() {
                    let remaining_records = self.db.count_downloads().await?;
                    return Ok(json!({
                        "action": "clear",
                        "deleted_records": 0,
                        "deleted_files": 0,
                        "freed_bytes": 0,
                        "remaining_records": remaining_records,
                    }));
                }
                let (ids, deleted_files, freed_bytes, _) =
                    media_files::remove_managed_download_files(&records).await?;
                let (deleted_records, remaining_records) =
                    self.db.delete_downloads_by_ids(&ids).await?;
                Ok(json!({
                    "action": "clear",
                    "deleted_records": deleted_records,
                    "deleted_files": deleted_files,
                    "freed_bytes": freed_bytes,
                    "remaining_records": remaining_records,
                }))
            }
            other => anyhow::bail!("Unknown downloads action: {}", other),
        }
    }

    /// Lists all existing downloaded files as MCP [`Resource`] descriptors.
    pub(crate) async fn list_download_resources(&self) -> Result<Vec<Resource>> {
        let records = self.db.list_all_existing_downloads().await?;
        Ok(records.iter().map(record_to_mcp_resource).collect())
    }

    /// Reads one downloaded file addressed by `flow://downloads/{id}` or `flow://downloads/asset/{asset_id}`.
    pub(crate) async fn read_download_resource(
        &self,
        uri: &str,
    ) -> std::result::Result<ResourceContents, ResourceReadError> {
        let rec = if let Some(asset_id) = uri.strip_prefix(DOWNLOAD_ASSET_RESOURCE_PREFIX) {
            if asset_id.is_empty() || asset_id.contains('/') {
                return Err(ResourceReadError::InvalidUri(format!(
                    "Invalid asset resource URI: {}",
                    uri
                )));
            }
            self.db
                .find_existing_file_for_asset(asset_id)
                .await
                .map_err(|e| ResourceReadError::Internal(e.to_string()))?
                .ok_or_else(|| {
                    ResourceReadError::NotFound(format!(
                        "No downloaded file found for asset '{}'",
                        asset_id
                    ))
                })?
        } else if let Some(id_str) = uri.strip_prefix(DOWNLOAD_RESOURCE_PREFIX) {
            let id = id_str
                .parse::<i64>()
                .ok()
                .filter(|&n| n > 0)
                .ok_or_else(|| {
                    ResourceReadError::InvalidUri(format!("Invalid download resource URI: {}", uri))
                })?;
            self.db
                .get_download_by_id(id)
                .await
                .map_err(|e| ResourceReadError::Internal(e.to_string()))?
                .ok_or_else(|| {
                    ResourceReadError::NotFound(format!("No download record with id {}", id))
                })?
        } else {
            return Err(ResourceReadError::InvalidUri(format!(
                "Unsupported resource URI scheme: {}",
                uri
            )));
        };

        let path =
            media_files::verified_managed_download_path(&rec.file_path).ok_or_else(|| {
                ResourceReadError::NotFound(format!(
                    "Downloaded file is missing from managed downloads directory: {}",
                    rec.file_path
                ))
            })?;
        let meta = tokio::fs::metadata(&path)
            .await
            .map_err(|e| ResourceReadError::Internal(e.to_string()))?;
        if meta.len() > MAX_RESOURCE_READ_BYTES {
            return Err(ResourceReadError::TooLarge(format!(
                "Resource {} is {} bytes (exceeds {} byte limit for resources/read). Use flow_downloads with action=\"read_chunk\" and id={}.",
                uri,
                meta.len(),
                MAX_RESOURCE_READ_BYTES,
                rec.id
            )));
        }

        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|e| ResourceReadError::Internal(e.to_string()))?;
        let mime = effective_mime_type(rec.mime_type.as_deref(), &rec.file_path);
        Ok(ResourceContents::blob(BASE64.encode(&bytes), uri.to_string()).with_mime_type(mime))
    }
}
