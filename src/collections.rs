// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Collection operations on the active Google Flow project store.

use anyhow::{Context, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::MutexGuard;

use crate::auth::is_signed_in_flow_url;
use crate::engine::ChromeEngine;
use crate::project::project_id_from_url;

/// Collection summary in the active Flow project.
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct FlowCollection {
    /// Collection tile ID.
    pub(crate) id: String,
    /// Collection display name.
    pub(crate) name: String,
    /// Asset count in this collection.
    count: usize,
}

/// Parameters for `flow_collections`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct CollectionsParams {
    /// Action name: "list", "create", "rename", "add", "remove", or "delete".
    pub(crate) action: String,
    /// Collection name for "create" or "delete".
    pub(crate) name: Option<String>,
    /// Existing collection ID or name for "rename" or "delete".
    pub(crate) from: Option<String>,
    /// New collection name for "rename".
    pub(crate) to: Option<String>,
    /// Target collection ID or name for "add" or "delete".
    pub(crate) collection: Option<String>,
    /// Exact asset or character IDs to move into ("add") or out of ("remove") a collection.
    pub(crate) ids: Option<Vec<String>>,
}

/// Holds the browser collection lock and pins the project and runtime session.
pub(crate) struct CollectionSession<'a> {
    /// Browser engine for the active page.
    engine: &'a ChromeEngine,
    /// Locked collection path.
    _guard: MutexGuard<'a, ()>,
    /// Project ID in the active Flow route.
    project_id: String,
    /// Identifier of the browser runtime that owns the bound project store.
    session: String,
}

impl<'a> CollectionSession<'a> {
    /// Binds the store in the open Flow project without changing the page.
    pub(crate) async fn open(engine: &'a ChromeEngine) -> Result<Self> {
        let url = engine.current_url().await?;
        let project_id = url::Url::parse(&url)
            .ok()
            .filter(|_| is_signed_in_flow_url(&url))
            .and_then(|url| project_id_from_url(url.path()))
            .context("Open a Google Flow project before you use this tool")?;
        let guard = engine.lock_collections().await;
        let status = engine
            .call_flow_js("collectionStoreStatus", json!([project_id]))
            .await?;
        let status =
            if status.get("error").and_then(Value::as_str) == Some("collection_store_not_bound") {
                engine.bind_collection_store(&project_id).await?
            } else {
                status
            };
        let session = checked_result(status)?
            .get("session")
            .and_then(Value::as_str)
            .context("The browser did not return the collection session")?
            .to_owned();
        Ok(Self {
            engine,
            _guard: guard,
            project_id,
            session,
        })
    }

    /// Calls the collection runtime for the pinned project and document.
    pub(crate) async fn run(&self, request: Value) -> Result<Value> {
        let response = self
            .engine
            .call_flow_async(
                "collectionOps",
                json!([self.project_id, self.session, request]),
            )
            .await;
        let response = match response {
            Ok(value) => value,
            Err(error)
                if matches!(
                    request.get("action").and_then(Value::as_str),
                    Some("create" | "rename" | "move")
                ) =>
            {
                anyhow::bail!(
                    "outcome_unknown (project {}, request {}): {error:#}",
                    self.project_id,
                    request,
                )
            }
            Err(error) => return Err(error),
        };
        checked_result(response)
    }

    /// Reads the active collections from the bound store.
    async fn list(&self) -> Result<Vec<FlowCollection>> {
        let mut value = self.run(json!({ "action": "list" })).await?;
        Ok(serde_json::from_value(value["collections"].take())?)
    }

    /// Returns true when the tile ID belongs to a collection.
    pub(crate) async fn is_collection(&self, id: &str) -> Result<bool> {
        let res = self.run(json!({ "action": "inspect", "id": id })).await?;
        Ok(res.get("collection").and_then(Value::as_bool) == Some(true))
    }

    /// Requests a verified rename for a collection ID.
    pub(crate) async fn rename(&self, id: &str, name: &str) -> Result<Value> {
        self.run(json!({ "action": "rename", "id": id, "name": name }))
            .await
    }

    /// Requests deletion of a collection ID through the collection path.
    pub(crate) async fn delete(&self, id: &str) -> Result<Value> {
        self.run(json!({ "action": "delete", "id": id })).await
    }

    /// Resolves an existing collection or creates and verifies a new one.
    async fn create(&self, name: &str) -> Result<Value> {
        let name = name.trim();
        anyhow::ensure!(!name.is_empty(), "Collection name must not be empty");
        let collections = self.list().await?;
        if let Some(found) = find_unique_collection(
            collections
                .iter()
                .filter(|c| c.name.eq_ignore_ascii_case(name)),
            name,
        )? {
            return Ok(
                json!({ "created": false, "collection": found, "collections": collections }),
            );
        }
        let id = uuid::Uuid::new_v4();
        self.run(json!({ "action": "create", "id": id.to_string(), "name": name }))
            .await
    }

    /// Moves the requested IDs into a collection or to the project root.
    async fn move_assets(&self, ids: Vec<String>, target: Option<&str>) -> Result<Value> {
        let Some(target) = target else {
            return self
                .run(json!({ "action": "move", "ids": ids, "target": null }))
                .await;
        };
        let target = target.trim();
        anyhow::ensure!(!target.is_empty(), "Collection name must not be empty");
        let collections = self.list().await?;
        let id = if let Some(collection) = find_collection(&collections, target, false)? {
            collection.id.clone()
        } else {
            self.run(json!({ "action": "check_assets", "ids": ids }))
                .await?;
            let value = self.create(target).await?;
            value
                .get("id")
                .or_else(|| value.pointer("/collection/id"))
                .and_then(Value::as_str)
                .context("The store did not return the collection ID")?
                .to_owned()
        };
        self.run(json!({ "action": "move", "ids": ids, "target": id }))
            .await
    }
}

/// Returns a successful runtime result or reports the error and its details.
fn checked_result(mut result: Value) -> Result<Value> {
    let fields = result
        .as_object_mut()
        .context("The collection runtime did not return a result")?;
    if fields.remove("ok").and_then(|value| value.as_bool()) == Some(true) {
        return Ok(result);
    }
    let error = fields
        .remove("error")
        .context("The collection runtime did not return an error code")?;
    let error = error
        .as_str()
        .context("The collection runtime returned an invalid error code")?;
    if fields.is_empty() {
        anyhow::bail!("{error}");
    }
    anyhow::bail!("{error} {result}");
}

/// Returns the only collection in a set of matches, if one exists.
fn find_unique_collection<'a>(
    mut matches: impl Iterator<Item = &'a FlowCollection>,
    query: &str,
) -> Result<Option<&'a FlowCollection>> {
    let first = matches.next();
    anyhow::ensure!(
        matches.next().is_none(),
        "ambiguous_collection: More than one collection matches '{query}'. Use a collection ID."
    );
    Ok(first)
}

/// Resolves a collection ID, exact name, or optional name substring.
pub(crate) fn find_collection<'a>(
    collections: &'a [FlowCollection],
    query: &str,
    allow_substring: bool,
) -> Result<Option<&'a FlowCollection>> {
    if query.is_empty() {
        return Ok(None);
    }
    if let Some(id_match) = collections.iter().find(|c| c.id == query) {
        return Ok(Some(id_match));
    }
    let exact = find_unique_collection(
        collections
            .iter()
            .filter(|c| c.name.eq_ignore_ascii_case(query)),
        query,
    )?;
    if exact.is_some() || !allow_substring {
        return Ok(exact);
    }
    let lower = query.to_lowercase();
    find_unique_collection(
        collections
            .iter()
            .filter(|c| c.name.to_lowercase().contains(&lower)),
        query,
    )
}

/// Returns the requested collection or reports a missing target.
async fn require_collection(session: &CollectionSession<'_>, query: &str) -> Result<String> {
    let collections = session.list().await?;
    Ok(find_collection(&collections, query.trim(), false)?
        .with_context(|| format!("Collection not found: {query}"))?
        .id
        .clone())
}

/// Returns the nonempty list of asset IDs for a move request.
fn move_ids(ids: Option<Vec<String>>, action: &str) -> Result<Vec<String>> {
    ids.filter(|ids| !ids.is_empty()).with_context(|| {
        format!("flow_collections {action} requires at least one asset ID in 'ids'")
    })
}

/// Dispatches the six actions of `flow_collections`.
pub(crate) async fn handle_collections(
    engine: &ChromeEngine,
    req: CollectionsParams,
) -> Result<Value> {
    let session = CollectionSession::open(engine).await?;
    match req.action.as_str() {
        "list" => Ok(json!({ "collections": session.list().await? })),
        "create" => {
            let name = req
                .name
                .context("flow_collections create requires 'name'")?;
            session.create(&name).await
        }
        "rename" => {
            let from = req
                .from
                .context("flow_collections rename requires 'from'")?;
            let to = req.to.context("flow_collections rename requires 'to'")?;
            let to = to.trim();
            anyhow::ensure!(!to.is_empty(), "Target collection name must not be empty");
            let id = require_collection(&session, &from).await?;
            let mut result = session.rename(&id, to).await?;
            result["renamed"] = json!(true);
            result["from"] = json!(from);
            result["to"] = json!(to);
            Ok(result)
        }
        "add" => {
            let target = req
                .collection
                .context("flow_collections add requires 'collection'")?;
            session
                .move_assets(move_ids(req.ids, "add")?, Some(&target))
                .await
        }
        "remove" => {
            session
                .move_assets(move_ids(req.ids, "remove")?, None)
                .await
        }
        "delete" => {
            let target = req
                .collection
                .or(req.name)
                .or(req.from)
                .context("flow_collections delete requires 'collection', 'name', or 'from'")?;
            let id = require_collection(&session, &target).await?;
            session.delete(&id).await
        }
        other => anyhow::bail!("Unknown collections action: {other}"),
    }
}
