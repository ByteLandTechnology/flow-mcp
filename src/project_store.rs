// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Browser session for direct project store operations.

use anyhow::{Context, Result};
use serde_json::{Value, json};
use tokio::sync::MutexGuard;
use tokio::time::{Duration, sleep};

use crate::auth::is_signed_in_flow_url;
use crate::engine::{ChromeEngine, checked_runtime_result};
use crate::project::project_id_from_url;

/// Maximum bind retries while a fresh project page loads its tile query.
const STORE_BIND_ATTEMPTS: u32 = 20;

/// Delay between store bind checks on a fresh project page.
const STORE_BIND_INTERVAL: Duration = Duration::from_millis(200);

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
        let session = checked_runtime_result(bind_ready_store(engine, &project_id).await?)?
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

/// Prepares the direct store for a status check without changing the page.
pub(crate) async fn prepare_project_store_status(
    engine: &ChromeEngine,
    project_id: &str,
) -> Result<Value> {
    let _guard = engine.lock_project_store().await;
    bind_ready_store(engine, project_id).await
}

/// Binds the direct store and waits briefly when a fresh project page is still loading tiles.
async fn bind_ready_store(engine: &ChromeEngine, project_id: &str) -> Result<Value> {
    let mut status = bind_current_store(engine, project_id).await?;
    for _ in 0..STORE_BIND_ATTEMPTS {
        if status.get("error").and_then(Value::as_str) != Some("collection_store_not_bound") {
            break;
        }
        let build = engine
            .call_flow_js("probeBuild", json!([]))
            .await
            .unwrap_or(Value::Null);
        if build.get("ok").and_then(Value::as_bool) != Some(true) {
            break;
        }
        sleep(STORE_BIND_INTERVAL).await;
        status = bind_current_store(engine, project_id).await?;
    }
    Ok(status)
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
