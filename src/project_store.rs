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
    /// Binds the store for `operation`, reporting build incompatibility when unverified.
    pub(crate) async fn open_for(engine: &'a ChromeEngine, operation: &str) -> Result<Self> {
        let project_id = open_project_id(engine).await?;
        let guard = engine.lock_project_store().await;
        let mut dom_probed = false;
        let mut status = bind_current_store(engine, &project_id).await?;
        for _ in 0..25 {
            let err = status.get("error").and_then(Value::as_str);
            if err == Some("collection_store_not_bound") && !dom_probed {
                dom_probed = true;
                let _ = engine.call_flow_async("discoverStore", json!([])).await;
                status = engine
                    .call_flow_js("projectStoreStatus", json!([project_id]))
                    .await?;
                continue;
            }
            if err == Some("store_loading") {
                tokio::time::sleep(Duration::from_millis(200)).await;
                status = bind_current_store(engine, &project_id).await?;
                continue;
            }
            break;
        }
        if status.get("ok").and_then(Value::as_bool) != Some(true)
            && let Ok(probe) = engine.call_flow_js("probeBuild", json!([])).await
            && probe
                .pointer(&format!("/operations/{operation}/ok"))
                .and_then(Value::as_bool)
                == Some(false)
        {
            checked_runtime_result(json!({
                "ok": false,
                "error": "unsupported_front_end",
                "build": probe.get("build").cloned().unwrap_or(Value::Null),
                "operation": operation,
                "failed_checks": probe
                    .pointer(&format!("/operations/{operation}/failed_checks"))
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            }))?;
        }
        let session = checked_runtime_result(status)?
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

/// Returns the project ID from the active signed-in Google Flow project URL.
pub(crate) async fn open_project_id(engine: &ChromeEngine) -> Result<String> {
    let url = engine.current_url().await?;
    url::Url::parse(&url)
        .ok()
        .filter(|_| is_signed_in_flow_url(&url))
        .and_then(|url| project_id_from_url(url.path()))
        .context("Open a Google Flow project before you use this tool")
}

/// Prepares the direct store for a status check without changing the page.
pub(crate) async fn prepare_project_store_status(engine: &ChromeEngine, project_id: &str) {
    if let Some(_guard) = engine.try_lock_project_store() {
        let _ = bind_current_store(engine, project_id).await;
    }
}

/// Reads or binds the verified store for the requested project.
pub(crate) async fn bind_current_store(engine: &ChromeEngine, project_id: &str) -> Result<Value> {
    let status = engine
        .call_flow_js("projectStoreStatus", json!([project_id]))
        .await?;
    if status.get("error").and_then(Value::as_str) == Some("collection_store_not_bound") {
        return engine.bind_project_store(project_id).await;
    }
    Ok(status)
}
