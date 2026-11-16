// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Application service routing Google Flow tools, job queuing, and SQLite persistence.

use anyhow::Result;
use serde_json::{Value, json};
use std::sync::Arc;

use crate::auth::{self, LoginParams};
use crate::config;
use crate::db::FlowDb;
use crate::engine::{ChromeEngine, ENGINE_NAME};
use crate::project::{self, ProjectsParams};
use crate::queue::{JobQueue, JobResult, JobRunner, JobView, WaitParams};

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
        let runner: JobRunner =
            Arc::new(move |_scene, _on_progress| Box::pin(async move { Ok(JobResult::default()) }));
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
}
