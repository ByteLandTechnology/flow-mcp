// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Browser session for direct project store operations.

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

    /// Returns the browser engine for this session.
    pub(crate) fn engine(&self) -> &'a ChromeEngine {
        self.engine
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
pub(crate) async fn prepare_project_store_status(engine: &ChromeEngine, project_id: &str) {
    if let Some(_guard) = engine.try_lock_project_store() {
        let _ = bind_current_store(engine, project_id).await;
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

/// Returns true when `err` comes from an unavailable or unverified front-end store shape before any server write.
pub(crate) fn can_use_ui_fallback(err: &anyhow::Error) -> bool {
    let text = format!("{err:#}");
    if text.contains("outcome_unknown")
        || text.contains("Open a Google Flow project")
        || text.contains("not signed in")
        || text.contains("No Google Flow project is open")
    {
        return false;
    }
    [
        "unsupported_front_end",
        "collection_store_not_bound",
        "ambiguous_collection_store",
        "collection_delete_unavailable",
        "unverified_mutation_shape",
        "ambiguous_mutation_shape",
        "project_upload_page_not_ready",
        "Failed to find the Flow project store",
        "The browser did not return the project store session",
        "store_not_bound",
        "mutation_unavailable",
    ]
    .iter()
    .any(|code| text.contains(code))
}
