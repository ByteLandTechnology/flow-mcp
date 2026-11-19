// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Google Flow collection listing, creation, renaming, and asset assignment.

use anyhow::{Context, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Duration;

use crate::assets::{RenameEntry, invoke_trash_tile, rename_assets};
use crate::engine::ChromeEngine;
use crate::project::{ensure_flow_store, read_snapshot, wait_flow_mutation_rpc};

/// Collection summary in the active Flow project.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct FlowCollection {
    /// Collection tile ID.
    id: String,
    /// Collection display name.
    name: String,
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

/// Lists collections in the active Flow project.
async fn list_collections(engine: &ChromeEngine) -> Result<Vec<FlowCollection>> {
    let snap = read_snapshot(engine).await?;
    let cols: Vec<FlowCollection> = serde_json::from_value(
        snap.get("collections")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    )?;
    Ok(cols)
}

/// Creates a collection in the active Flow project when no matching name exists.
async fn create_collection(engine: &ChromeEngine, name: &str) -> Result<Value> {
    let trimmed = name.trim();
    anyhow::ensure!(!trimmed.is_empty(), "Collection name must not be empty");
    let existing = list_collections(engine).await?;
    if let Some(found) = existing
        .iter()
        .find(|c| c.name.eq_ignore_ascii_case(trimmed))
    {
        return Ok(json!({ "created": false, "collection": found, "collections": existing }));
    }

    let col_id = engine
        .call_flow_async("collectionOps", json!(["create", trimmed, Value::Null]))
        .await?;
    let updated = list_collections(engine).await?;
    Ok(json!({ "created": true, "id": col_id, "collections": updated }))
}

/// Renames a collection that matches `from` by ID or case-insensitive name.
async fn rename_collection(engine: &ChromeEngine, from: &str, to: &str) -> Result<Value> {
    let new_name = to.trim();
    anyhow::ensure!(
        !new_name.is_empty(),
        "Target collection name must not be empty"
    );
    let cols = list_collections(engine).await?;
    let target = cols
        .iter()
        .find(|c| c.id == from || c.name.eq_ignore_ascii_case(from))
        .cloned()
        .with_context(|| format!("Collection not found: {}", from))?;

    let res = rename_assets(
        engine,
        vec![RenameEntry {
            id: target.id.clone(),
            name: new_name.to_string(),
        }],
    )
    .await?;
    let after = list_collections(engine).await?;
    Ok(
        json!({ "renamed": true, "from": from, "to": new_name, "result": res, "collections": after }),
    )
}

/// Executes `batch_move_to_collection` for `ids` toward `target_id` (or `None` to uncollect).
async fn move_collection_tiles(
    engine: &ChromeEngine,
    target_id: Option<&str>,
    ids: Vec<String>,
    op_label: &str,
) -> Result<(u64, Value, bool, Value)> {
    ensure_flow_store(engine).await?;
    let mut rx = engine.subscribe_network().await?;
    let res = engine
        .call_flow_async("collectionOps", json!(["move", target_id, ids]))
        .await?;
    if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let err = res
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown collection move error");
        anyhow::bail!("Failed to {} assets {:?}: {}", op_label, ids, err);
    }

    let rpc_ok = wait_flow_mutation_rpc(&mut rx, Duration::from_millis(500)).await;
    let moved = res.get("moved").and_then(|v| v.as_u64()).unwrap_or(0);
    let verified = res.get("verified").and_then(|v| v.as_u64()).unwrap_or(0);
    if moved > 0 && verified < moved {
        anyhow::bail!(
            "Failed to {}: the store shows {} of {} assets in the target after the mutation; the front end may have renamed the payload fields",
            op_label,
            verified,
            moved
        );
    }
    let missing = res.get("missing").cloned().unwrap_or_else(|| json!([]));
    let method = res.get("method").cloned().unwrap_or(Value::Null);
    Ok((moved, missing, rpc_ok, method))
}

/// Moves `ids` into `collection` through `batch_move_to_collection` and creates the collection if absent.
async fn move_to_collection(
    engine: &ChromeEngine,
    ids: Vec<String>,
    collection: &str,
) -> Result<Value> {
    let cols = list_collections(engine).await?;
    let mut target = cols
        .iter()
        .find(|c| c.id == collection || c.name.eq_ignore_ascii_case(collection))
        .cloned();
    if target.is_none() {
        create_collection(engine, collection).await?;
        let refreshed = list_collections(engine).await?;
        target = refreshed
            .iter()
            .find(|c| c.id == collection || c.name.eq_ignore_ascii_case(collection))
            .cloned();
    }
    let col = target.with_context(|| format!("Failed to resolve collection: {}", collection))?;
    let (moved, missing, rpc_ok, method) = move_collection_tiles(
        engine,
        Some(&col.id),
        ids,
        &format!("move into collection '{}'", col.name),
    )
    .await?;
    let refreshed_col = list_collections(engine)
        .await
        .ok()
        .and_then(|items| items.into_iter().find(|c| c.id == col.id));
    let confirmed = rpc_ok;
    let updated_col = refreshed_col.unwrap_or(col);
    Ok(json!({
        "moved": moved,
        "missing": missing,
        "confirmed": confirmed,
        "collection": updated_col,
        "method": method,
    }))
}

/// Removes `ids` from their parent collections (`rj: undefined`).
async fn remove_from_collection(engine: &ChromeEngine, ids: Vec<String>) -> Result<Value> {
    let (removed, missing, _rpc_ok, method) =
        move_collection_tiles(engine, None, ids, "remove from collection").await?;
    Ok(json!({
        "removed": removed,
        "missing": missing,
        "confirmed": true,
        "method": method,
    }))
}

/// Deletes a collection matching `query` (`batch_move_and_delete_collection`).
async fn delete_collection(engine: &ChromeEngine, query: &str) -> Result<Value> {
    let cols = list_collections(engine).await?;
    let target = cols
        .iter()
        .find(|c| c.id == query || c.name.eq_ignore_ascii_case(query))
        .cloned()
        .with_context(|| format!("Collection not found: {}", query))?;
    let res = invoke_trash_tile(engine, &target.id)
        .await
        .with_context(|| format!("Failed to delete collection '{}'", target.name))?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    Ok(json!({
        "deleted": true,
        "collection": target,
        "method": res.get("method").cloned().unwrap_or(Value::Null),
    }))
}

/// Dispatches `flow_collections` actions (`list`, `create`, `rename`, `add`, `remove`, `delete`).
pub(crate) async fn handle_collections(
    engine: &ChromeEngine,
    req: CollectionsParams,
) -> Result<Value> {
    match req.action.as_str() {
        "list" => {
            let cols = list_collections(engine).await?;
            Ok(json!({ "collections": cols }))
        }
        "create" => {
            let name = req
                .name
                .context("flow_collections create requires 'name'")?;
            create_collection(engine, &name).await
        }
        "rename" => {
            let from = req
                .from
                .context("flow_collections rename requires 'from'")?;
            let to = req.to.context("flow_collections rename requires 'to'")?;
            rename_collection(engine, &from, &to).await
        }
        "add" => {
            let col = req
                .collection
                .context("flow_collections add requires 'collection'")?;
            let ids = req.ids.context("flow_collections add requires 'ids'")?;
            anyhow::ensure!(
                !ids.is_empty(),
                "flow_collections add requires at least one asset ID in 'ids'"
            );
            move_to_collection(engine, ids, &col).await
        }
        "remove" => {
            let ids = req.ids.context("flow_collections remove requires 'ids'")?;
            anyhow::ensure!(
                !ids.is_empty(),
                "flow_collections remove requires at least one asset ID in 'ids'"
            );
            remove_from_collection(engine, ids).await
        }
        "delete" => {
            let target = req
                .collection
                .or(req.name)
                .or(req.from)
                .context("flow_collections delete requires 'collection', 'name', or 'from'")?;
            delete_collection(engine, &target).await
        }
        other => anyhow::bail!("Unknown collections action: {}", other),
    }
}
