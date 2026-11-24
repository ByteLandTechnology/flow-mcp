// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Workspace UI fallbacks for collection listing, creation, renaming, membership, and deletion.

use anyhow::{Context, Result};
use serde_json::{Value, json};

use crate::assets::FlowAsset;
use crate::collections::{CollectionsParams, FlowCollection, find_collection};
use crate::engine::ChromeEngine;
use crate::project::read_snapshot;
use crate::tile_menu::{
    create_collection_through_ui, move_tile_collection_through_menu,
    rename_collection_through_page, rename_through_menu, trash_through_menu,
};

/// Reads the active collections from a store or DOM snapshot.
pub(crate) async fn list_collections_ui(engine: &ChromeEngine) -> Result<Vec<FlowCollection>> {
    let mut snap = read_snapshot(engine).await?;
    let raw = snap
        .get_mut("collections")
        .map(Value::take)
        .unwrap_or_else(|| Value::Array(Vec::new()));
    Ok(serde_json::from_value(raw)?)
}

/// Returns true when `id` matches a collection in the current snapshot.
pub(crate) async fn is_collection_ui(engine: &ChromeEngine, id: &str) -> Result<bool> {
    let cols = list_collections_ui(engine).await?;
    Ok(cols.iter().any(|c| c.id == id))
}

/// Resolves an existing collection by `name` or creates a new collection through the workspace UI.
pub(crate) async fn create_collection_ui(engine: &ChromeEngine, name: &str) -> Result<Value> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "Collection name must not be empty");
    let collections = list_collections_ui(engine).await?;
    let mut exact = collections
        .iter()
        .filter(|c| c.name.eq_ignore_ascii_case(name));
    if let Some(first) = exact.next() {
        anyhow::ensure!(
            exact.next().is_none(),
            "ambiguous_collection: More than one collection matches '{name}'. Use a collection ID."
        );
        return Ok(json!({
            "created": false,
            "collection": first,
            "collections": collections,
        }));
    }

    let created_id = create_collection_through_ui(engine, name)
        .await?
        .with_context(|| {
            format!("Could not create collection '{name}' through the workspace UI")
        })?;
    let updated = list_collections_ui(engine).await?;
    let collection = updated
        .iter()
        .find(|c| c.id == created_id)
        .cloned()
        .unwrap_or(FlowCollection {
            id: created_id.clone(),
            name: name.to_string(),
            count: 0,
        });
    Ok(json!({
        "id": created_id,
        "created": true,
        "method": "ui:create_collection",
        "collection": collection,
        "collections": updated,
    }))
}

/// Renames collection `id` to `name` through the workspace tile menu or collection page header.
pub(crate) async fn rename_collection_ui(
    engine: &ChromeEngine,
    id: &str,
    name: &str,
) -> Result<Value> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "Target collection name must not be empty");
    let current = list_collections_ui(engine)
        .await
        .ok()
        .and_then(|cols| cols.into_iter().find(|c| c.id == id).map(|c| c.name))
        .unwrap_or_default();
    let mut method = "menu:rename";
    let mut ok = rename_through_menu(engine, id, name).await?;
    if !ok && !current.is_empty() {
        ok = rename_collection_through_page(engine, id, &current, name).await?;
        if ok {
            method = "page:title";
        }
    }
    anyhow::ensure!(
        ok,
        "Could not rename collection '{id}' through the workspace menu"
    );
    let collections = list_collections_ui(engine).await?;
    Ok(json!({
        "id": id,
        "name": name,
        "method": method,
        "confirmed": true,
        "collections": collections,
    }))
}

/// Moves `ids` into collection `target` (creating it if needed) or out to the project root (`None`).
pub(crate) async fn move_assets_ui(
    engine: &ChromeEngine,
    ids: Vec<String>,
    target: Option<&str>,
) -> Result<Value> {
    anyhow::ensure!(!ids.is_empty(), "At least one asset ID is required");
    let (target_id, target_name) = if let Some(raw_target) = target {
        let trimmed = raw_target.trim();
        anyhow::ensure!(!trimmed.is_empty(), "Collection name must not be empty");
        let collections = list_collections_ui(engine).await?;
        if let Some(col) = find_collection(&collections, trimmed, false)? {
            (Some(col.id.clone()), Some(col.name.clone()))
        } else {
            let created = create_collection_ui(engine, trimmed).await?;
            let cid = created
                .get("id")
                .or_else(|| created.pointer("/collection/id"))
                .and_then(Value::as_str)
                .context("UI collection creation did not return a collection ID")?
                .to_string();
            (Some(cid), Some(trimmed.to_string()))
        }
    } else {
        (None, None)
    };

    for id in &ids {
        let moved = move_tile_collection_through_menu(
            engine,
            id,
            target_id.as_deref(),
            target_name.as_deref(),
        )
        .await?;
        anyhow::ensure!(
            moved,
            "Could not move tile '{id}' through the workspace collection menu"
        );
    }

    let collections = list_collections_ui(engine).await?;
    Ok(json!({
        "moved": ids.len(),
        "ids": ids,
        "collection": target_id,
        "method": "menu:move_collection",
        "confirmed": true,
        "collections": collections,
    }))
}

/// Empties any member tiles from collection `id` and deletes the folder through its menu.
pub(crate) async fn delete_collection_ui(engine: &ChromeEngine, id: &str) -> Result<Value> {
    let snap = read_snapshot(engine).await?;
    let assets: Vec<FlowAsset> = serde_json::from_value(
        snap.get("assets")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    )?;
    let members: Vec<String> = assets
        .into_iter()
        .filter(|a| a.collection_id.as_deref() == Some(id))
        .map(|a| a.id)
        .collect();
    for member_id in &members {
        let moved = move_tile_collection_through_menu(engine, member_id, None, None).await?;
        anyhow::ensure!(
            moved,
            "Could not move member asset '{member_id}' out of collection '{id}' before deletion"
        );
    }

    let trashed = trash_through_menu(engine, id).await?;
    anyhow::ensure!(
        trashed,
        "Could not delete collection '{id}' through the workspace menu"
    );
    let collections = list_collections_ui(engine).await.unwrap_or_default();
    Ok(json!({
        "id": id,
        "deleted": true,
        "unassigned": members.len(),
        "method": "menu:delete_collection",
        "confirmed": true,
        "collections": collections,
    }))
}

/// Resolves a collection ID by exact ID or unambiguous name from the UI snapshot.
async fn require_collection_ui(engine: &ChromeEngine, query: &str) -> Result<String> {
    let collections = list_collections_ui(engine).await?;
    Ok(find_collection(&collections, query.trim(), false)?
        .with_context(|| format!("Collection not found: {query}"))?
        .id
        .clone())
}

/// Dispatches `flow_collections` actions through workspace UI fallbacks.
pub(crate) async fn handle_collections_ui(
    engine: &ChromeEngine,
    req: CollectionsParams,
) -> Result<Value> {
    match req.action.as_str() {
        "list" => Ok(json!({ "collections": list_collections_ui(engine).await? })),
        "create" => {
            let name = req
                .name
                .context("flow_collections create requires 'name'")?;
            create_collection_ui(engine, &name).await
        }
        "rename" => {
            let from = req
                .from
                .context("flow_collections rename requires 'from'")?;
            let to = req.to.context("flow_collections rename requires 'to'")?;
            let to = to.trim();
            anyhow::ensure!(!to.is_empty(), "Target collection name must not be empty");
            let id = require_collection_ui(engine, &from).await?;
            let mut result = rename_collection_ui(engine, &id, to).await?;
            result["renamed"] = json!(true);
            result["from"] = json!(from);
            result["to"] = json!(to);
            Ok(result)
        }
        "add" => {
            let target = req
                .collection
                .context("flow_collections add requires 'collection'")?;
            let ids = req
                .ids
                .filter(|v| !v.is_empty())
                .context("flow_collections add requires at least one asset ID in 'ids'")?;
            move_assets_ui(engine, ids, Some(&target)).await
        }
        "remove" => {
            let ids = req
                .ids
                .filter(|v| !v.is_empty())
                .context("flow_collections remove requires at least one asset ID in 'ids'")?;
            move_assets_ui(engine, ids, None).await
        }
        "delete" => {
            let target = req
                .collection
                .or(req.name)
                .or(req.from)
                .context("flow_collections delete requires 'collection', 'name', or 'from'")?;
            let id = require_collection_ui(engine, &target).await?;
            delete_collection_ui(engine, &id).await
        }
        other => anyhow::bail!("Unknown collections action: {other}"),
    }
}
