// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Collection operations on the active Google Flow project store.

use anyhow::{Context, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::collection_page::{
    add_to_collection_through_page, create_collection_through_page, delete_collection_through_page,
    remove_from_collection_through_page, rename_collection_through_page, snapshot_collections,
};
use crate::engine::ChromeEngine;
use crate::project_store::ProjectStoreSession;

/// Collection summary in the active Flow project.
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct FlowCollection {
    /// Collection tile ID.
    pub(crate) id: String,
    /// Collection display name.
    pub(crate) name: String,
    /// Asset count in this collection.
    pub(crate) count: usize,
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

impl ProjectStoreSession<'_> {
    /// Calls the collection runtime for the pinned project and document.
    pub(crate) async fn run_collections(&self, request: Value) -> Result<Value> {
        let mutation = matches!(
            request.get("action").and_then(Value::as_str),
            Some("create" | "rename" | "move" | "delete")
        )
        .then(|| format!("request {request}"));
        self.call("collectionOps", request, mutation.as_deref())
            .await
    }

    /// Reads the active collections from the bound store.
    async fn list(&self) -> Result<Vec<FlowCollection>> {
        let mut value = self.run_collections(json!({ "action": "list" })).await?;
        Ok(serde_json::from_value(value["collections"].take())?)
    }

    /// Requests a verified rename for a collection ID.
    pub(crate) async fn rename(&self, id: &str, name: &str) -> Result<Value> {
        self.run_collections(json!({ "action": "rename", "id": id, "name": name }))
            .await
    }

    /// Requests deletion of a collection ID through the collection path.
    pub(crate) async fn delete(&self, id: &str) -> Result<Value> {
        self.run_collections(json!({ "action": "delete", "id": id }))
            .await
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
        self.run_collections(json!({ "action": "create", "id": id.to_string(), "name": name }))
            .await
    }

    /// Moves the requested IDs into a collection or to the project root.
    async fn move_assets(&self, ids: Vec<String>, target: Option<&str>) -> Result<Value> {
        let Some(target) = target else {
            return self
                .run_collections(json!({ "action": "move", "ids": ids, "target": null }))
                .await;
        };
        let target = target.trim();
        anyhow::ensure!(!target.is_empty(), "Collection name must not be empty");
        let collections = self.list().await?;
        let id = if let Some(collection) = find_collection(&collections, target, false)? {
            collection.id.clone()
        } else {
            self.run_collections(json!({ "action": "check_assets", "ids": ids }))
                .await?;
            let value = self.create(target).await?;
            value
                .get("id")
                .or_else(|| value.pointer("/collection/id"))
                .and_then(Value::as_str)
                .context("The store did not return the collection ID")?
                .to_owned()
        };
        self.run_collections(json!({ "action": "move", "ids": ids, "target": id }))
            .await
    }
}

/// Returns the only collection in a set of matches, if one exists.
pub(crate) fn find_unique_collection<'a>(
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

/// Returns the requested collection from the direct store session or reports a missing target.
async fn require_collection(session: &ProjectStoreSession<'_>, query: &str) -> Result<String> {
    let collections = session.list().await?;
    Ok(find_collection(&collections, query.trim(), false)?
        .with_context(|| format!("Collection not found: {query}"))?
        .id
        .clone())
}

/// Returns the requested collection from the project snapshot or reports a missing target.
async fn require_snapshot_collection(engine: &ChromeEngine, query: &str) -> Result<String> {
    let collections = snapshot_collections(engine).await?;
    Ok(find_collection(&collections, query.trim(), false)?
        .with_context(|| format!("Collection not found: {query}"))?
        .id
        .clone())
}

/// Returns true when a direct collection error can fall back to page controls.
fn is_collection_fallback_eligible(err: &anyhow::Error) -> bool {
    let msg = format!("{err:#}");
    if msg.contains("outcome_unknown") {
        return false;
    }
    msg.contains("unsupported_front_end")
        || msg.contains("collection_store_not_bound")
        || msg.contains("ambiguous_collection_store")
        || msg.contains("collection_delete_unavailable")
        || msg.contains("project_store_changed")
        || msg.contains("project_changed")
        || msg.contains("Open a Google Flow project")
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
    match req.action.as_str() {
        "list" => {
            let _guard = engine.lock_project_store().await;
            Ok(json!({ "collections": snapshot_collections(engine).await? }))
        }
        "create" => {
            let name = req
                .name
                .context("flow_collections create requires 'name'")?;
            let direct = async {
                let session = ProjectStoreSession::open(engine).await?;
                session.create(&name).await
            }
            .await;
            match direct {
                Ok(val) => Ok(val),
                Err(err) if is_collection_fallback_eligible(&err) => {
                    let _guard = engine.lock_project_store().await;
                    create_collection_through_page(engine, &name).await
                }
                Err(err) => Err(err),
            }
        }
        "rename" => {
            let from = req
                .from
                .context("flow_collections rename requires 'from'")?;
            let to = req.to.context("flow_collections rename requires 'to'")?;
            let to = to.trim();
            anyhow::ensure!(!to.is_empty(), "Target collection name must not be empty");
            let direct = async {
                let session = ProjectStoreSession::open(engine).await?;
                let id = require_collection(&session, &from).await?;
                session.rename(&id, to).await
            }
            .await;
            let mut result = match direct {
                Ok(val) => val,
                Err(err) if is_collection_fallback_eligible(&err) => {
                    let _guard = engine.lock_project_store().await;
                    let id = require_snapshot_collection(engine, &from).await?;
                    rename_collection_through_page(engine, &id, to).await?
                }
                Err(err) => return Err(err),
            };
            result["renamed"] = json!(true);
            result["from"] = json!(from);
            result["to"] = json!(to);
            Ok(result)
        }
        "add" => {
            let target = req
                .collection
                .context("flow_collections add requires 'collection'")?;
            let ids = move_ids(req.ids, "add")?;
            let direct = async {
                let session = ProjectStoreSession::open(engine).await?;
                session.move_assets(ids.clone(), Some(&target)).await
            }
            .await;
            match direct {
                Ok(val) => Ok(val),
                Err(err) if is_collection_fallback_eligible(&err) => {
                    let _guard = engine.lock_project_store().await;
                    add_to_collection_through_page(engine, &ids, &target).await
                }
                Err(err) => Err(err),
            }
        }
        "remove" => {
            let ids = move_ids(req.ids, "remove")?;
            let direct = async {
                let session = ProjectStoreSession::open(engine).await?;
                session.move_assets(ids.clone(), None).await
            }
            .await;
            match direct {
                Ok(val) => Ok(val),
                Err(err) if is_collection_fallback_eligible(&err) => {
                    let _guard = engine.lock_project_store().await;
                    remove_from_collection_through_page(engine, &ids).await
                }
                Err(err) => Err(err),
            }
        }
        "delete" => {
            let target = req
                .collection
                .or(req.name)
                .or(req.from)
                .context("flow_collections delete requires 'collection', 'name', or 'from'")?;
            let direct = async {
                let session = ProjectStoreSession::open(engine).await?;
                let id = require_collection(&session, &target).await?;
                session.delete(&id).await
            }
            .await;
            match direct {
                Ok(val) => Ok(val),
                Err(err) if is_collection_fallback_eligible(&err) => {
                    let _guard = engine.lock_project_store().await;
                    let id = require_snapshot_collection(engine, &target).await?;
                    delete_collection_through_page(engine, &id).await
                }
                Err(err) => Err(err),
            }
        }
        other => anyhow::bail!("Unknown collections action: {other}"),
    }
}
