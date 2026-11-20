// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Browser session for direct project store operations.

use anyhow::{Context, Result};
use serde_json::{Value, json};
use tokio::sync::MutexGuard;

use crate::auth::is_signed_in_flow_url;
use crate::engine::ChromeEngine;
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
        let status = engine
            .call_flow_js("projectStoreStatus", json!([project_id]))
            .await?;
        let status =
            if status.get("error").and_then(Value::as_str) == Some("collection_store_not_bound") {
                engine.bind_project_store(&project_id).await?
            } else {
                status
            };
        let session = checked_result(status)?
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
            (Ok(result), _) => checked_result(result),
            (Err(error), Some(mutation)) => anyhow::bail!(
                "outcome_unknown (project {}, {mutation}): {error:#}",
                self.project_id
            ),
            (Err(error), None) => Err(error),
        }
    }
}

/// Returns a successful runtime result or reports the error and its details.
fn checked_result(mut result: Value) -> Result<Value> {
    let fields = result
        .as_object_mut()
        .context("The project store runtime did not return a result")?;
    if fields.remove("ok").and_then(|value| value.as_bool()) == Some(true) {
        return Ok(result);
    }
    let error = fields
        .remove("error")
        .context("The project store runtime did not return an error code")?;
    let error = error
        .as_str()
        .context("The project store runtime returned an invalid error code")?;
    if fields.is_empty() {
        anyhow::bail!("{error}");
    }
    anyhow::bail!("{error} {result}");
}
