// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Browser session for direct project store operations.

use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{Value, json};
use tokio::sync::MutexGuard;

use crate::auth::is_signed_in_flow_url;
use crate::engine::{ChromeEngine, checked_runtime_result};
use crate::project::project_id_from_url;

/// Holds the browser project store lock and pins the project and runtime session.
pub(crate) struct ProjectStoreSession<'a> {
    /// Browser engine for the active page.
    engine: &'a ChromeEngine,
    /// Locked project store.
    _guard: MutexGuard<'a, ()>,
    /// Project ID in the active Flow route.
    project_id: String,
    /// Identifier of the browser runtime that owns the bound project store.
    session: String,
}

impl<'a> ProjectStoreSession<'a> {
    /// Binds the store in the open Flow project without changing the page.
    pub(crate) async fn open(engine: &'a ChromeEngine) -> Result<Self> {
        let url = engine.current_url().await?;
        let project_id = url::Url::parse(&url)
            .ok()
            .filter(|_| is_signed_in_flow_url(&url))
            .and_then(|url| project_id_from_url(url.path()))
            .context("Open a Google Flow project before you use this tool")?;
        let guard = engine.lock_project_store().await;
        let session = checked_runtime_result(bind_current_store(engine, &project_id).await?)?
            .get("session")
            .and_then(Value::as_str)
            .context("The browser did not return the project store session")?
            .to_owned();
        Ok(Self {
            engine,
            _guard: guard,
            project_id,
            session,
        })
    }

    /// Returns the active project ID at the time of binding.
    pub(crate) fn project_id(&self) -> &str {
        &self.project_id
    }

    /// Calls a store operation for the pinned project and document.
    ///
    /// Use a short description for a mutation whose outcome can be unknown if CDP fails.
    pub(crate) async fn call(
        &self,
        method: &str,
        request: Value,
        mutation: Option<&str>,
    ) -> Result<Value> {
        let response = self
            .engine
            .call_flow_async(method, json!([self.project_id, self.session, request]))
            .await;
        match (response, mutation) {
            (Ok(result), _) => checked_runtime_result(result),
            (Err(error), Some(mutation)) => anyhow::bail!(
                "outcome_unknown (project {}, {mutation}): {error:#}",
                self.project_id
            ),
            (Err(error), None) => Err(error),
        }
    }
}

/// Maximum retry attempts while a fresh project page loads its initial store or workspace module.
const STATUS_PREPARE_ATTEMPTS: usize = 10;

/// Pause between status preparation retries on a fresh project page.
const STATUS_PREPARE_DELAY: Duration = Duration::from_millis(250);

/// Prepares the project store under the store lock and probes compatibility without changing the page.
pub(crate) async fn prepare_project_store_status(
    engine: &ChromeEngine,
    project_id: &str,
) -> Result<Value> {
    let _guard = engine.lock_project_store().await;
    ensure_open_project_snapshot(engine, project_id).await;
    let bind_result = bind_store_with_retry(engine, project_id).await;
    let mut probe = probe_after_workspace_load(engine, project_id).await?;
    if let Err(err) = bind_result {
        record_bind_failure(&mut probe, &format!("{err:#}"));
    }
    Ok(probe)
}

/// Returns `true` when the active page URL still targets `project_id`.
async fn on_requested_project(engine: &ChromeEngine, project_id: &str) -> bool {
    engine
        .current_url()
        .await
        .ok()
        .and_then(|url| project_id_from_url(&url))
        .as_deref()
        == Some(project_id)
}

/// Discovers the general runtime store on an already-open project page when no snapshot is bound yet.
async fn ensure_open_project_snapshot(engine: &ChromeEngine, project_id: &str) {
    for attempt in 0..STATUS_PREPARE_ATTEMPTS {
        if let Ok(snap) = engine.call_flow_js("readStoreSnapshot", json!([])).await
            && snap.get("ok").and_then(Value::as_bool) == Some(true)
        {
            return;
        }
        if !on_requested_project(engine, project_id).await {
            return;
        }
        let _ = engine.call_flow_async("discoverStore", json!([])).await;
        if let Ok(snap) = engine.call_flow_js("readStoreSnapshot", json!([])).await
            && snap.get("ok").and_then(Value::as_bool) == Some(true)
        {
            return;
        }
        if attempt + 1 < STATUS_PREPARE_ATTEMPTS {
            tokio::time::sleep(STATUS_PREPARE_DELAY).await;
        }
    }
}

/// Binds the direct project store, retrying briefly while initial project tile queries finish loading.
async fn bind_store_with_retry(engine: &ChromeEngine, project_id: &str) -> Result<()> {
    for attempt in 0..STATUS_PREPARE_ATTEMPTS {
        let status = bind_current_store(engine, project_id).await?;
        if status.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(());
        }
        let retryable =
            status.get("error").and_then(Value::as_str) == Some("collection_store_not_bound");
        if !retryable
            || attempt + 1 >= STATUS_PREPARE_ATTEMPTS
            || !on_requested_project(engine, project_id).await
        {
            return checked_runtime_result(status).map(|_| ());
        }
        tokio::time::sleep(STATUS_PREPARE_DELAY).await;
    }
    Ok(())
}

/// Runs `probeStore`, waiting briefly when a verified build is still loading its workspace chunk.
async fn probe_after_workspace_load(engine: &ChromeEngine, project_id: &str) -> Result<Value> {
    for attempt in 0..STATUS_PREPARE_ATTEMPTS {
        let probe = engine.call_flow_js("probeStore", json!([])).await?;
        if !workspace_chunk_pending(&probe)
            || attempt + 1 >= STATUS_PREPARE_ATTEMPTS
            || !on_requested_project(engine, project_id).await
        {
            return Ok(probe);
        }
        tokio::time::sleep(STATUS_PREPARE_DELAY).await;
    }
    engine.call_flow_js("probeStore", json!([])).await
}

/// Returns `true` when the build is verified but the lazy project workspace class is not loaded yet.
fn workspace_chunk_pending(probe: &Value) -> bool {
    let verified = probe
        .get("checks")
        .and_then(Value::as_array)
        .is_some_and(|checks| {
            checks.iter().any(|c| {
                c.get("name").and_then(Value::as_str) == Some("verified_build")
                    && c.get("ok").and_then(Value::as_bool) == Some(true)
            })
        });
    let page_missing = probe
        .pointer("/operations/agent_chat/failed_checks")
        .and_then(Value::as_array)
        .is_some_and(|failed| {
            failed
                .iter()
                .any(|c| c.get("name").and_then(Value::as_str) == Some("agent_page"))
        });
    verified && page_missing
}

/// Marks the probe as failed and records the direct project store binding failure.
fn record_bind_failure(probe: &mut Value, detail: &str) {
    let Some(obj) = probe.as_object_mut() else {
        return;
    };
    obj.insert("ok".to_string(), Value::Bool(false));
    if let Some(checks) = obj.get_mut("checks").and_then(Value::as_array_mut) {
        checks.push(json!({
            "name": "project_store_bind",
            "ok": false,
            "detail": detail,
        }));
    }
}

/// Reads or binds the direct store for the requested project.
async fn bind_current_store(engine: &ChromeEngine, project_id: &str) -> Result<Value> {
    let status = engine
        .call_flow_js("projectStoreStatus", json!([project_id]))
        .await?;
    if status.get("error").and_then(Value::as_str) == Some("collection_store_not_bound") {
        return engine.bind_project_store(project_id).await;
    }
    Ok(status)
}
