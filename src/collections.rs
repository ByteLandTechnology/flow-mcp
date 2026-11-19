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
use crate::tile_menu::{
    create_collection_through_page, delete_empty_collection_through_menu, move_out_through_menu,
    rename_collection_through_page, tile_state,
};

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

/// Reads the collections every 500 ms, and returns the first list that `done` accepts within `tries` reads.
async fn wait_collections(
    engine: &ChromeEngine,
    tries: u32,
    done: impl Fn(&[FlowCollection]) -> bool,
) -> Option<Vec<FlowCollection>> {
    for _ in 0..tries {
        if let Ok(cols) = list_collections(engine).await
            && done(&cols)
        {
            return Some(cols);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    None
}

/// Creates a collection in the active Flow project when no matching name exists.
///
/// Uses the "Create collection" button of the page first. If the page does not show the button, sends the store mutation. Returns an error when the store does not show the new collection.
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

    let is_new = |cols: &[FlowCollection]| {
        cols.iter()
            .any(|c| c.name == trimmed && !existing.iter().any(|old| old.id == c.id))
    };
    let method = match create_collection_through_page(engine, trimmed).await {
        Ok(Some(true)) => "page:create_collection",
        Ok(Some(false)) => anyhow::bail!(
            "Failed to create collection '{}': the page did not accept the name; a collection with the default name can remain",
            trimmed
        ),
        _ => {
            engine
                .call_flow_async("collectionOps", json!(["create", trimmed, Value::Null]))
                .await?;
            "mutation"
        }
    };
    let updated = wait_collections(engine, 20, is_new)
        .await
        .with_context(|| {
            format!(
                "Failed to create collection '{}' ({}): the store does not show it",
                trimmed, method
            )
        })?;
    let created = updated
        .iter()
        .find(|c| c.name == trimmed && !existing.iter().any(|old| old.id == c.id));
    let id = created.map(|c| c.id.clone());
    Ok(json!({ "created": true, "id": id, "method": method, "collections": updated }))
}

/// Renames a collection that matches `from` by ID or case-insensitive name.
///
/// Uses the title of the collection page first, then the store mutation. Returns an error when the store does not show the new name.
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

    let has_new_name =
        |cols: &[FlowCollection]| cols.iter().any(|c| c.id == target.id && c.name == new_name);
    // Use the title of the collection page first. The page then builds its own mutation.
    if matches!(
        rename_collection_through_page(engine, &target.id, &target.name, new_name).await,
        Ok(true)
    ) && let Some(after) = wait_collections(engine, 20, has_new_name).await
    {
        return Ok(json!({
            "renamed": true,
            "from": from,
            "to": new_name,
            "method": "page:collection_title",
            "collections": after,
        }));
    }
    let res = rename_assets(
        engine,
        vec![RenameEntry {
            id: target.id.clone(),
            name: new_name.to_string(),
        }],
    )
    .await?;
    let after = wait_collections(engine, 10, has_new_name)
        .await
        .with_context(|| {
            format!(
                "Failed to rename collection '{}' to '{}': the store does not show the new name",
                target.name, new_name
            )
        })?;
    Ok(json!({
        "renamed": true,
        "from": from,
        "to": new_name,
        "method": "mutation",
        "result": res,
        "collections": after,
    }))
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

/// Removes `ids` from their parent collections.
///
/// Uses the "Move out of collection" item of the tile menu first. For each tile that the page does not show, sends the store mutation.
async fn remove_from_collection(engine: &ChromeEngine, ids: Vec<String>) -> Result<Value> {
    ensure_flow_store(engine).await?;
    let mut by_menu: u64 = 0;
    let mut rest = Vec::new();
    for id in ids {
        let state = tile_state(engine, &id).await;
        if state.is_present() && state.collection.is_none() {
            // No collection holds this tile.
            by_menu += 1;
            continue;
        }
        if state.is_present() && matches!(move_out_through_menu(engine, &id).await, Ok(true)) {
            by_menu += 1;
        } else {
            rest.push(id);
        }
    }
    if rest.is_empty() {
        return Ok(json!({
            "removed": by_menu,
            "missing": [],
            "confirmed": true,
            "method": "menu:move_out_of_collection",
        }));
    }
    let (removed, missing, _rpc_ok, method) =
        move_collection_tiles(engine, None, rest, "remove from collection").await?;
    Ok(json!({
        "removed": by_menu + removed,
        "missing": missing,
        "confirmed": true,
        "method": method,
        "removed_through_menu": by_menu,
    }))
}

/// Returns the IDs of the assets that the snapshot shows in collection `collection_id`.
async fn collection_member_ids(engine: &ChromeEngine, collection_id: &str) -> Result<Vec<String>> {
    let snap = read_snapshot(engine).await?;
    let ids = snap
        .get("assets")
        .and_then(|v| v.as_array())
        .map(|assets| {
            assets
                .iter()
                .filter(|a| a.get("collection_id").and_then(|v| v.as_str()) == Some(collection_id))
                .filter_map(|a| a.get("id").and_then(|v| v.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Ok(ids)
}

/// Deletes a collection matching `query` and keeps its assets.
///
/// Moves the assets out of the collection first, because the page moves all contents of a collection to trash when it deletes the collection. Then uses the menu of the folder tile, or the store mutation. Returns an error when the collection holds another collection, when an asset stays in it, or when the store still shows the collection.
async fn delete_collection(engine: &ChromeEngine, query: &str) -> Result<Value> {
    let cols = list_collections(engine).await?;
    let target = cols
        .iter()
        .find(|c| c.id == query || c.name.eq_ignore_ascii_case(query))
        .cloned()
        .with_context(|| format!("Collection not found: {}", query))?;
    for other in cols.iter().filter(|c| c.id != target.id) {
        let parent = tile_state(engine, &other.id).await.collection;
        anyhow::ensure!(
            parent.as_deref() != Some(target.id.as_str()),
            "Collection '{}' holds the collection '{}'; move or delete that collection first",
            target.name,
            other.name
        );
    }
    let members = collection_member_ids(engine, &target.id).await?;
    let moved_out = members.len();
    if !members.is_empty() {
        remove_from_collection(engine, members).await?;
    }
    let is_empty = |cols: &[FlowCollection]| cols.iter().any(|c| c.id == target.id && c.count == 0);
    anyhow::ensure!(
        wait_collections(engine, 10, is_empty).await.is_some(),
        "Collection '{}' still holds assets after the move; it is not deleted",
        target.name
    );
    let is_gone = |cols: &[FlowCollection]| !cols.iter().any(|c| c.id == target.id);
    let mut method = Value::String("menu:move_all_contents_to_trash".to_string());
    // The page finds the folder tile by its name. Use the menu only when no other collection has this name.
    let unique_name = cols.iter().filter(|c| c.name == target.name).count() == 1;
    let by_menu = unique_name
        && matches!(
            delete_empty_collection_through_menu(engine, &target.id, &target.name).await,
            Ok(true)
        )
        && wait_collections(engine, 20, is_gone).await.is_some();
    if !by_menu {
        let res = invoke_trash_tile(engine, &target.id)
            .await
            .with_context(|| format!("Failed to delete collection '{}'", target.name))?;
        method = res.get("method").cloned().unwrap_or(Value::Null);
        anyhow::ensure!(
            wait_collections(engine, 10, is_gone).await.is_some(),
            "Failed to delete collection '{}': the store still shows it",
            target.name
        );
    }
    Ok(json!({
        "deleted": true,
        "collection": target,
        "assets_moved_out": moved_out,
        "method": method,
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
