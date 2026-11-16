// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Serial background job queue for Google Flow automation tasks.
//!
//! [`JobQueue`] runs generation, edit, and character jobs one at a time on a single
//! worker task so concurrent commands never drive the Chrome page together.
//!
//! Between pending jobs, the worker sleeps for a random interval within
//! [`crate::config::pause_bounds_ms`]. If a job fails with `"agent finished without creating"`
//! and `retried_from` is `None`, the worker enqueues one automatic retry.

use anyhow::Result;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, mpsc, oneshot, watch};
use tokio::time::Instant;

use crate::config::pause_bounds_ms;

/// Maximum number of jobs kept in queue history before pruning terminal entries.
const MAX_JOB_HISTORY: usize = 200;

/// Maximum wait duration (`24` hours in milliseconds) accepted by `wait_for`.
const MAX_WAIT_MS: u64 = 86_400_000;

/// Parameters for `flow_wait`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct WaitParams {
    /// Job IDs to wait for (waits for all jobs when omitted).
    pub(crate) ids: Option<Vec<String>>,
    /// Single job ID to wait for when `ids` is omitted.
    pub(crate) id: Option<String>,
    /// Maximum wait time in seconds (default 600).
    pub(crate) timeout: Option<u64>,
}

/// Parameters for `flow_cancel` and `flow_retry`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct JobIdParams {
    /// Eight-character job ID from the queue.
    pub(crate) id: String,
}

/// Lifecycle state of a queued job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum JobStatus {
    /// Waiting in the FIFO pending queue.
    Queued,
    /// Running in the browser job runner.
    Running,
    /// Finished with success.
    Done,
    /// Finished with an error.
    Failed,
    /// Cancelled before or during execution.
    Cancelled,
}

impl JobStatus {
    /// Returns the lowercase string name of this status.
    fn as_str(self) -> &'static str {
        match self {
            JobStatus::Queued => "queued",
            JobStatus::Running => "running",
            JobStatus::Done => "done",
            JobStatus::Failed => "failed",
            JobStatus::Cancelled => "cancelled",
        }
    }

    /// Returns `true` when the job reached a terminal status.
    fn is_terminal(self) -> bool {
        matches!(
            self,
            JobStatus::Done | JobStatus::Failed | JobStatus::Cancelled
        )
    }
}

/// Parameters for a queued Google Flow automation job.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct SceneParams {
    /// Prompt text for Google Flow.
    pub(crate) prompt: String,
    /// Generation mode (`"video"` or `"image"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) mode: Option<String>,
    /// Model name in the Flow UI.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    /// Scene or asset label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) name: Option<String>,
}

/// Internal job record in [`JobQueue`].
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Job {
    /// Eight-character job ID.
    id: String,
    /// Parameters for the job.
    scene: SceneParams,
    /// Active lifecycle status.
    status: JobStatus,
    /// Creation timestamp in Unix epoch milliseconds.
    created_at: u64,
    /// Execution start timestamp in Unix epoch milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<u64>,
    /// Terminal timestamp in Unix epoch milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    finished_at: Option<u64>,
    /// Latest status message.
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<String>,
    /// Downloaded local file paths.
    #[serde(skip_serializing_if = "Option::is_none")]
    files: Option<Vec<String>>,
    /// Created asset IDs in Google Flow.
    #[serde(skip_serializing_if = "Option::is_none")]
    created: Option<Vec<String>>,
    /// MCP resource URIs for downloaded files.
    #[serde(skip_serializing_if = "Option::is_none")]
    resources: Option<Vec<String>>,
    /// Failure error message.
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// Original job ID for a retried job.
    #[serde(skip_serializing_if = "Option::is_none")]
    retried_from: Option<String>,
}

/// Serializable job summary for MCP responses.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct JobView {
    /// Eight-character job ID.
    pub(crate) id: String,
    /// Active lifecycle status.
    pub(crate) status: JobStatus,
    /// Prompt text for the job.
    pub(crate) prompt: String,
    /// Scene or asset label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) name: Option<String>,
    /// Generation mode (`"video"` or `"image"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) mode: Option<String>,
    /// Model name override.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    /// Creation timestamp in Unix epoch milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) created_at: Option<u64>,
    /// Execution start timestamp in Unix epoch milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) started_at: Option<u64>,
    /// Terminal timestamp in Unix epoch milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) finished_at: Option<u64>,
    /// Latest status message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) progress: Option<String>,
    /// Downloaded local file paths.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) files: Option<Vec<String>>,
    /// Created asset IDs in Google Flow.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) created: Option<Vec<String>>,
    /// MCP resource URIs for downloaded files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) resources: Option<Vec<String>>,
    /// Failure error message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
    /// Original job ID for a retried job.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) retried_from: Option<String>,
}

impl From<&Job> for JobView {
    fn from(j: &Job) -> Self {
        Self {
            id: j.id.clone(),
            status: j.status,
            prompt: j.scene.prompt.clone(),
            name: j.scene.name.clone(),
            mode: j.scene.mode.clone(),
            model: j.scene.model.clone(),
            created_at: Some(j.created_at),
            started_at: j.started_at,
            finished_at: j.finished_at,
            progress: j.progress.clone(),
            files: j.files.clone(),
            created: j.created.clone(),
            resources: j.resources.clone(),
            error: j.error.clone(),
            retried_from: j.retried_from.clone(),
        }
    }
}

/// Output from [`JobRunner`] when a job finishes.
#[derive(Debug, Clone, Default)]
pub(crate) struct JobResult {
    /// Downloaded local file paths.
    pub(crate) files: Vec<String>,
    /// Created asset IDs in Google Flow.
    pub(crate) created: Vec<String>,
    /// MCP resource URIs for downloaded files.
    pub(crate) resources: Vec<String>,
}

/// Callback that records progress updates during job execution.
pub(crate) type ProgressCallback = Arc<dyn Fn(String) + Send + Sync>;

/// Asynchronous callback that runs one [`SceneParams`] job.
pub(crate) type JobRunner = Arc<
    dyn Fn(SceneParams, ProgressCallback) -> Pin<Box<dyn Future<Output = Result<JobResult>> + Send>>
        + Send
        + Sync,
>;

/// Returns the current system time in Unix epoch milliseconds.
fn now_ms() -> u64 {
    crate::db::now_epoch_ms().max(0) as u64
}

/// Returns a uniform random duration in `min_ms..=max_ms` using UUIDv4 entropy.
fn random_pause_ms(min_ms: u64, max_ms: u64) -> u64 {
    if max_ms <= min_ms {
        return min_ms;
    }
    let span = max_ms - min_ms + 1;
    let bytes = uuid::Uuid::new_v4().into_bytes();
    let raw = u64::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ]);
    min_ms + (raw % span)
}

/// Synchronized internal storage backing [`JobQueue`].
struct QueueState {
    /// All tracked jobs keyed by ID.
    jobs: HashMap<String, Job>,
    /// Insertion order of tracked job IDs.
    order: VecDeque<String>,
    /// FIFO queue of waiting `Queued` job IDs.
    pending: VecDeque<String>,
    /// ID of the currently running job when cancelled mid-flight.
    cancelled_running: Option<String>,
    /// Cancellation trigger for the active job runner future.
    running_cancel: Option<oneshot::Sender<()>>,
}

impl QueueState {
    /// Creates a `Queued` [`Job`], appends it to history and pending queues, and returns its [`JobView`].
    fn enqueue_job(&mut self, scene: SceneParams, retried_from: Option<String>) -> JobView {
        let id = uuid::Uuid::new_v4().to_string()[..8].to_string();
        let job = Job {
            id: id.clone(),
            scene,
            status: JobStatus::Queued,
            created_at: now_ms(),
            started_at: None,
            finished_at: None,
            progress: Some("queued".to_string()),
            files: None,
            created: None,
            resources: None,
            error: None,
            retried_from,
        };
        let view = JobView::from(&job);
        self.order.push_back(id.clone());
        self.pending.push_back(id);
        self.jobs.insert(job.id.clone(), job);
        self.prune_finished();
        view
    }

    /// Removes oldest terminal jobs once tracked job count exceeds [`MAX_JOB_HISTORY`].
    fn prune_finished(&mut self) {
        if self.order.len() <= MAX_JOB_HISTORY {
            return;
        }
        let mut excess = self.order.len() - MAX_JOB_HISTORY;
        let mut retained = VecDeque::with_capacity(self.order.len());
        while let Some(id) = self.order.pop_front() {
            let can_remove = excess > 0
                && self
                    .jobs
                    .get(&id)
                    .is_some_and(|job| job.status.is_terminal());
            if can_remove {
                self.jobs.remove(&id);
                excess -= 1;
            } else {
                retained.push_back(id);
            }
        }
        self.order = retained;
    }
}

/// Single-worker serial queue for Flow automation jobs.
pub(crate) struct JobQueue {
    /// Mutex-protected job map and pending queue.
    state: Arc<Mutex<QueueState>>,
    /// Broadcast counter notifying waiters whenever job state changes.
    state_tx: watch::Sender<u64>,
    /// Executor closure invoked sequentially for each queued job.
    runner: JobRunner,
}

impl JobQueue {
    /// Creates a [`JobQueue`] and starts its serial worker task.
    pub(crate) fn new(runner: JobRunner) -> Arc<Self> {
        let (state_tx, _) = watch::channel(0u64);
        let q = Arc::new(Self {
            state: Arc::new(Mutex::new(QueueState {
                jobs: HashMap::new(),
                order: VecDeque::new(),
                pending: VecDeque::new(),
                cancelled_running: None,
                running_cancel: None,
            })),
            state_tx,
            runner,
        });
        let worker_q = Arc::clone(&q);
        tokio::spawn(async move {
            worker_q.worker_loop().await;
        });
        q
    }

    /// Increments the watch state version to wake the worker and waiting callers.
    fn bump_state_version(&self) {
        self.state_tx.send_modify(|v| *v = v.wrapping_add(1));
    }

    /// Lists all tracked jobs in insertion order.
    pub(crate) async fn list(&self) -> Vec<JobView> {
        let st = self.state.lock().await;
        st.order
            .iter()
            .filter_map(|id| st.jobs.get(id).map(JobView::from))
            .collect()
    }

    /// Cancels a `Queued` or `Running` job and returns terminal jobs unchanged.
    ///
    /// Returns an error when `id` does not exist.
    pub(crate) async fn cancel(&self, id: &str) -> Result<JobView> {
        let mut st = self.state.lock().await;
        let current_status = st
            .jobs
            .get(id)
            .map(|j| j.status)
            .ok_or_else(|| anyhow::anyhow!("Unknown job ID: {}", id))?;
        match current_status {
            JobStatus::Queued => {
                let job = st
                    .jobs
                    .get_mut(id)
                    .ok_or_else(|| anyhow::anyhow!("Unknown job ID: {}", id))?;
                job.status = JobStatus::Cancelled;
                job.finished_at = Some(now_ms());
                job.progress = Some("cancelled".to_string());
                let view = JobView::from(&*job);
                st.pending.retain(|x| x != id);
                drop(st);
                self.bump_state_version();
                Ok(view)
            }
            JobStatus::Running => {
                let job = st
                    .jobs
                    .get_mut(id)
                    .ok_or_else(|| anyhow::anyhow!("Unknown job ID: {}", id))?;
                job.status = JobStatus::Cancelled;
                job.finished_at = Some(now_ms());
                job.progress = Some("cancelled".to_string());
                let view = JobView::from(&*job);
                st.cancelled_running = Some(id.to_string());
                if let Some(cancel_tx) = st.running_cancel.take() {
                    let _ = cancel_tx.send(());
                }
                drop(st);
                self.bump_state_version();
                Ok(view)
            }
            _ => {
                let job = st
                    .jobs
                    .get(id)
                    .ok_or_else(|| anyhow::anyhow!("Unknown job ID: {}", id))?;
                Ok(JobView::from(job))
            }
        }
    }

    /// Re-enqueues a `Failed` or `Cancelled` job with `retried_from` set to `id`.
    ///
    /// Returns an error when `id` does not exist or is not terminal.
    pub(crate) async fn retry(&self, id: &str) -> Result<JobView> {
        let view = {
            let mut st = self.state.lock().await;
            let (status, scene) = st
                .jobs
                .get(id)
                .map(|j| (j.status, j.scene.clone()))
                .ok_or_else(|| anyhow::anyhow!("Unknown job ID: {}", id))?;
            if status != JobStatus::Failed && status != JobStatus::Cancelled {
                anyhow::bail!(
                    "Job {} has status {}. Retry only failed or cancelled jobs.",
                    id,
                    status.as_str()
                );
            }
            st.enqueue_job(scene, Some(id.to_string()))
        };
        self.bump_state_version();
        Ok(view)
    }

    /// Reads current views and terminal status for `ids` or all tracked jobs.
    async fn snapshot_jobs(&self, ids: Option<&[String]>) -> Result<(bool, Vec<JobView>)> {
        let st = self.state.lock().await;
        let targets: Vec<&Job> = match ids {
            Some(list) if !list.is_empty() => {
                let mut matched = Vec::with_capacity(list.len());
                for id in list {
                    let job = st
                        .jobs
                        .get(id)
                        .ok_or_else(|| anyhow::anyhow!("Unknown job ID: {}", id))?;
                    matched.push(job);
                }
                matched
            }
            _ => st.order.iter().filter_map(|id| st.jobs.get(id)).collect(),
        };
        let all_terminal = targets.iter().all(|j| j.status.is_terminal());
        let views: Vec<JobView> = targets.into_iter().map(JobView::from).collect();
        Ok((all_terminal, views))
    }

    /// Waits up to `timeout_ms` for targeted jobs (or all jobs when `ids` is empty)
    /// to reach `Done`, `Failed`, or `Cancelled`, then returns their snapshots.
    pub(crate) async fn wait_for(
        &self,
        ids: Option<&[String]>,
        timeout_ms: u64,
    ) -> Result<Vec<JobView>> {
        let mut rx = self.state_tx.subscribe();
        let deadline = Instant::now() + Duration::from_millis(timeout_ms.min(MAX_WAIT_MS));
        loop {
            let _ = rx.borrow_and_update();
            let (done, snapshot) = self.snapshot_jobs(ids).await?;
            if done || Instant::now() >= deadline {
                return Ok(snapshot);
            }
            match tokio::time::timeout_at(deadline, rx.changed()).await {
                Ok(Ok(())) => continue,
                Ok(Err(_)) | Err(_) => {
                    let (_, fresh) = self.snapshot_jobs(ids).await?;
                    return Ok(fresh);
                }
            }
        }
    }

    /// Runs queued jobs sequentially and pauses between consecutive pending jobs.
    async fn worker_loop(self: Arc<Self>) {
        let mut rx = self.state_tx.subscribe();
        loop {
            let _ = rx.borrow_and_update();
            let next_job = {
                let mut st = self.state.lock().await;
                let mut picked = None;
                while let Some(id) = st.pending.pop_front() {
                    let Some(job) = st.jobs.get_mut(&id) else {
                        continue;
                    };
                    if job.status == JobStatus::Queued {
                        job.status = JobStatus::Running;
                        job.started_at = Some(now_ms());
                        job.progress = Some("starting".to_string());
                        let scene = job.scene.clone();
                        let (cancel_tx, cancel_rx) = oneshot::channel();
                        st.running_cancel = Some(cancel_tx);
                        picked = Some((id, scene, cancel_rx));
                        break;
                    }
                }
                picked
            };

            let Some((id, scene, mut cancel_rx)) = next_job else {
                if rx.changed().await.is_err() {
                    break;
                }
                continue;
            };
            self.bump_state_version();

            let (prog_tx, mut prog_rx) = mpsc::unbounded_channel::<String>();
            let progress_cb: ProgressCallback = Arc::new(move |msg: String| {
                let _ = prog_tx.send(msg);
            });

            let mut fut = (self.runner)(scene, progress_cb);
            let mut prog_open = true;
            let run_outcome = loop {
                tokio::select! {
                    biased;
                    _ = &mut cancel_rx => break None,
                    maybe_msg = prog_rx.recv(), if prog_open => {
                        match maybe_msg {
                            Some(msg) => {
                                {
                                    let mut st = self.state.lock().await;
                                    if let Some(j) = st
                                        .jobs
                                        .get_mut(&id)
                                        .filter(|j| j.status == JobStatus::Running)
                                    {
                                        j.progress = Some(msg);
                                    }
                                }
                                self.bump_state_version();
                            }
                            None => {
                                prog_open = false;
                            }
                        }
                    }
                    res = &mut fut => break Some(res),
                }
            };
            drop(fut);

            {
                let mut st = self.state.lock().await;
                while let Ok(msg) = prog_rx.try_recv() {
                    if let Some(j) = st
                        .jobs
                        .get_mut(&id)
                        .filter(|j| j.status == JobStatus::Running)
                    {
                        j.progress = Some(msg);
                    }
                }
                st.running_cancel = None;
                let was_cancelled = st.cancelled_running.as_deref() == Some(&id);
                if was_cancelled {
                    st.cancelled_running = None;
                }
                let mut retry_scene: Option<SceneParams> = None;
                if let Some(job) = st.jobs.get_mut(&id) {
                    if was_cancelled || job.status == JobStatus::Cancelled || run_outcome.is_none()
                    {
                        job.status = JobStatus::Cancelled;
                        job.finished_at.get_or_insert_with(now_ms);
                        job.progress = Some("cancelled".to_string());
                    } else if let Some(res) = run_outcome {
                        match res {
                            Ok(jr) => {
                                job.status = JobStatus::Done;
                                job.finished_at = Some(now_ms());
                                job.files = Some(jr.files);
                                job.created = Some(jr.created);
                                job.resources = Some(jr.resources);
                                if !job.progress.as_deref().is_some_and(|p| {
                                    p.starts_with("completed with download error(s):")
                                }) {
                                    job.progress = Some("done".to_string());
                                }
                            }
                            Err(e) => {
                                let msg = e.to_string();
                                if msg.contains("agent finished without creating")
                                    && !msg.to_ascii_lowercase().contains("recaptcha")
                                    && job.retried_from.is_none()
                                {
                                    retry_scene = Some(job.scene.clone());
                                }
                                job.status = JobStatus::Failed;
                                job.finished_at = Some(now_ms());
                                job.error = Some(msg);
                                job.progress = Some("failed".to_string());
                            }
                        }
                    }
                }
                if let Some(scene_to_retry) = retry_scene {
                    st.enqueue_job(scene_to_retry, Some(id));
                }
                st.prune_finished();
            }

            self.bump_state_version();

            let has_more = !self.state.lock().await.pending.is_empty();
            if has_more {
                let (min_ms, max_ms) = pause_bounds_ms();
                if max_ms > 0 {
                    let wait_ms = random_pause_ms(min_ms, max_ms);
                    tokio::time::sleep(Duration::from_millis(wait_ms)).await;
                }
            }
        }
    }
}
