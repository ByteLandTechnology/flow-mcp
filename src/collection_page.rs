// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Page-control fallbacks for collection listing, creation, renaming, membership, and deletion.
//!
//! Reads collection summaries from the project snapshot and drives sidebar buttons, context
//! menus, title inputs, and pointer drag-and-drop when direct collection store writes cannot run.

use std::collections::HashSet;

use anyhow::{Context, Result};
use serde_json::{Value, json};
use tokio::time::Duration;

use crate::collections::{FlowCollection, find_collection, find_unique_collection};
use crate::engine::ChromeEngine;
use crate::project::{ensure_flow_store, read_snapshot};
use crate::tile_menu::{
    MOVE_OUT_MENU_ITEM, click_tile_menu_item, dismiss_overlay, enter_tile_view, enter_view, is_ok,
    page_is_free, page_op, rename_through_menu, restore_view, tile_dom_op, tile_state,
    trash_through_menu, type_text_control, wait_tile_state,
};

/// Accessible label of the sidebar button that starts inline collection creation.
const CREATE_COLLECTION_BUTTON: &str = "Create collection";

/// Accessible label of the grid header button that creates an untitled collection.
const NEW_COLLECTION_BUTTON: &str = "New collection";

/// Accessible label of the button that expands the library sidebar.
const TOGGLE_LIBRARY_BUTTON: &str = "Toggle library";

/// Accessible label of the menu button that adds media or collections in the workspace.
const ADD_MEDIA_MENU_BUTTON: &str = "Add media menu";

/// Reads collection summaries from the active project snapshot without a direct store session.
pub(crate) async fn snapshot_collections(engine: &ChromeEngine) -> Result<Vec<FlowCollection>> {
    let snap = read_snapshot(engine).await?;
    let collections = snap
        .get("collections")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    Ok(serde_json::from_value(collections)?)
}

/// Ensures the page can accept interactive collection controls.
async fn prepare_collection_page(engine: &ChromeEngine) -> Result<()> {
    anyhow::ensure!(
        page_is_free(),
        "Another Flow job uses the browser page right now"
    );
    ensure_flow_store(engine).await
}

/// Clicks the first visible button from `labels`.
async fn click_any_button(engine: &ChromeEngine, labels: &[&str]) -> Result<Option<String>> {
    for _ in 0..12 {
        for label in labels {
            let point = engine
                .call_flow_js(
                    "locatePoint",
                    json!([{ "by": "aria-label", "name": *label }]),
                )
                .await?;
            if engine.click_point(&point).await? {
                return Ok(Some((*label).to_string()));
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    Ok(None)
}

/// Creates a collection through the sidebar or pinned collections button and verifies its name.
pub(crate) async fn create_collection_through_page(
    engine: &ChromeEngine,
    raw_name: &str,
) -> Result<Value> {
    let name = raw_name.trim();
    anyhow::ensure!(!name.is_empty(), "Collection name must not be empty");
    prepare_collection_page(engine).await?;

    let existing = snapshot_collections(engine).await?;
    if let Some(found) = find_unique_collection(
        existing
            .iter()
            .filter(|c| c.name.eq_ignore_ascii_case(name)),
        name,
    )? {
        return Ok(json!({
            "created": false,
            "collection": found,
            "collections": existing,
        }));
    }

    let before_ids: HashSet<String> = existing.into_iter().map(|c| c.id).collect();
    let saved = enter_view(engine, None).await;

    let mut clicked =
        click_any_button(engine, &[CREATE_COLLECTION_BUTTON, NEW_COLLECTION_BUTTON]).await?;
    if clicked.is_none() {
        let _ = click_any_button(engine, &[TOGGLE_LIBRARY_BUTTON]).await?;
        tokio::time::sleep(Duration::from_millis(300)).await;
        clicked =
            click_any_button(engine, &[CREATE_COLLECTION_BUTTON, NEW_COLLECTION_BUTTON]).await?;
    }
    if clicked.is_none()
        && click_any_button(engine, &[ADD_MEDIA_MENU_BUTTON])
            .await?
            .is_some()
    {
        tokio::time::sleep(Duration::from_millis(250)).await;
        for (by, label) in [
            ("menuitem", CREATE_COLLECTION_BUTTON),
            ("text", "create_new_folder Create collection"),
            ("text", CREATE_COLLECTION_BUTTON),
        ] {
            let point = engine
                .call_flow_js("locatePoint", json!([{ "by": by, "name": label }]))
                .await?;
            if engine.click_point(&point).await? {
                clicked = Some(CREATE_COLLECTION_BUTTON.to_string());
                break;
            }
        }
    }
    let Some(trigger) = clicked else {
        restore_view(engine, saved).await;
        anyhow::bail!("The Create collection control is not visible on the Flow page");
    };

    tokio::time::sleep(Duration::from_millis(250)).await;
    if trigger == CREATE_COLLECTION_BUTTON {
        let _ = type_text_control(engine, "item", "", name).await?;
    }

    let mut created_id: Option<String> = None;
    for _ in 0..40 {
        if let Ok(cols) = snapshot_collections(engine).await
            && let Some(found) = cols.into_iter().find(|c| !before_ids.contains(&c.id))
        {
            created_id = Some(found.id);
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    let Some(id) = created_id else {
        dismiss_overlay(engine).await;
        restore_view(engine, saved).await;
        anyhow::bail!("Flow did not create collection '{name}' through page controls");
    };

    if tile_state(engine, &id).await.name != name {
        let _ = rename_collection_in_page(engine, &id, name).await?;
    }
    restore_view(engine, saved).await;

    let collections = snapshot_collections(engine).await?;
    let collection = collections
        .iter()
        .find(|c| c.id == id)
        .with_context(|| format!("Collection '{id}' disappeared after creation"))?;
    Ok(json!({
        "ok": true,
        "created": true,
        "id": collection.id,
        "name": collection.name,
        "method": "page:create_collection",
        "collection": collection,
        "collections": collections,
    }))
}

/// Renames collection `id` to `name` in the open workspace via its menu or collection page title.
async fn rename_collection_in_page(engine: &ChromeEngine, id: &str, name: &str) -> Result<Value> {
    if rename_through_menu(engine, id, name).await? {
        return Ok(json!({
            "ok": true,
            "id": id,
            "name": name,
            "method": "menu:rename",
        }));
    }

    let current = tile_state(engine, id).await.name;
    let saved = enter_view(engine, Some(id)).await;
    let view = page_op(engine, json!({ "action": "view" })).await?;
    if view.get("collection").and_then(Value::as_str) != Some(id) {
        restore_view(engine, saved).await;
        anyhow::bail!("Cannot open collection '{id}' to rename it");
    }

    let point_res = page_op(
        engine,
        json!({ "action": "text_point", "control": "title", "name": current }),
    )
    .await?;
    let clicked = match point_res.get("point") {
        Some(pt) if is_ok(&point_res) => engine.click_point(pt).await?,
        _ => false,
    };
    let typed = if clicked {
        tokio::time::sleep(Duration::from_millis(150)).await;
        type_text_control(engine, "title", &current, name).await?
    } else {
        false
    };
    let confirmed = typed && wait_tile_state(engine, id, 40, |s| s.name == name).await;
    restore_view(engine, saved).await;
    anyhow::ensure!(
        confirmed,
        "Failed to rename collection '{id}' through page controls"
    );
    Ok(json!({
        "ok": true,
        "id": id,
        "name": name,
        "method": "page:collection_title",
    }))
}

/// Renames collection `id` to `name` through page controls and confirms the updated name.
pub(crate) async fn rename_collection_through_page(
    engine: &ChromeEngine,
    id: &str,
    name: &str,
) -> Result<Value> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "Target collection name must not be empty");
    prepare_collection_page(engine).await?;
    let state = tile_state(engine, id).await;
    anyhow::ensure!(
        state.is_present() && state.kind == "collection",
        "Collection not found: {id}"
    );
    if state.name == name {
        return Ok(json!({ "ok": true, "id": id, "name": name, "method": "noop" }));
    }
    rename_collection_in_page(engine, id, name).await
}

/// Sends a trusted mouse drag from `(sx, sy)` to `(tx, ty)` across Flow drop zones.
async fn drag_point_to_point(
    engine: &ChromeEngine,
    sx: f64,
    sy: f64,
    tx: f64,
    ty: f64,
) -> Result<()> {
    engine.mouse_move(sx, sy).await?;
    tokio::time::sleep(Duration::from_millis(80)).await;
    engine
        .cdp_call(
            "Input.dispatchMouseEvent",
            json!({
                "type": "mousePressed",
                "x": sx,
                "y": sy,
                "button": "left",
                "buttons": 1,
                "clickCount": 1,
            }),
        )
        .await?;
    tokio::time::sleep(Duration::from_millis(80)).await;
    engine
        .cdp_call(
            "Input.dispatchMouseEvent",
            json!({
                "type": "mouseMoved",
                "x": sx + 14.0,
                "y": sy + 14.0,
                "button": "left",
                "buttons": 1,
            }),
        )
        .await?;
    tokio::time::sleep(Duration::from_millis(160)).await;
    engine
        .cdp_call(
            "Input.dispatchMouseEvent",
            json!({
                "type": "mouseMoved",
                "x": (sx + tx) / 2.0,
                "y": (sy + ty) / 2.0,
                "button": "left",
                "buttons": 1,
            }),
        )
        .await?;
    tokio::time::sleep(Duration::from_millis(80)).await;
    engine
        .cdp_call(
            "Input.dispatchMouseEvent",
            json!({
                "type": "mouseMoved",
                "x": tx,
                "y": ty,
                "button": "left",
                "buttons": 1,
            }),
        )
        .await?;
    tokio::time::sleep(Duration::from_millis(160)).await;
    engine
        .cdp_call(
            "Input.dispatchMouseEvent",
            json!({
                "type": "mouseReleased",
                "x": tx,
                "y": ty,
                "button": "left",
                "buttons": 0,
                "clickCount": 1,
            }),
        )
        .await?;
    Ok(())
}

/// Drags from `(sx, sy)` to `(tx, ty)` and waits for `done`, trying HTML5 drag events if pointer drag does not settle.
async fn drag_and_confirm(
    engine: &ChromeEngine,
    item_id: &str,
    coords: (f64, f64, f64, f64),
    done: impl Fn(&crate::tile_menu::TileState) -> bool,
) -> Result<bool> {
    let (sx, sy, tx, ty) = coords;
    drag_point_to_point(engine, sx, sy, tx, ty).await?;
    if wait_tile_state(engine, item_id, 6, &done).await {
        return Ok(true);
    }
    let _ = page_op(
        engine,
        json!({ "action": "html5_drag", "coords": [sx, sy, tx, ty] }),
    )
    .await;
    Ok(wait_tile_state(engine, item_id, 34, done).await)
}

/// Validates that each ID in `ids` names a present non-collection tile.
async fn verify_movable_items(engine: &ChromeEngine, ids: &[String]) -> Result<()> {
    for id in ids {
        let st = tile_state(engine, id).await;
        anyhow::ensure!(st.is_present(), "asset_not_found: {id}");
        anyhow::ensure!(st.kind != "collection", "collection_not_movable: {id}");
    }
    Ok(())
}

/// Populates a collection (creating it first when missing) by dragging tiles onto its drop target.
pub(crate) async fn add_to_collection_through_page(
    engine: &ChromeEngine,
    ids: &[String],
    target: &str,
) -> Result<Value> {
    let target = target.trim();
    anyhow::ensure!(!target.is_empty(), "Collection name must not be empty");
    prepare_collection_page(engine).await?;
    verify_movable_items(engine, ids).await?;

    let collections = snapshot_collections(engine).await?;
    let target_id = if let Some(found) = find_collection(&collections, target, false)? {
        found.id.clone()
    } else {
        let created = create_collection_through_page(engine, target).await?;
        created
            .get("id")
            .or_else(|| created.pointer("/collection/id"))
            .and_then(Value::as_str)
            .context("Page collection creation returned no collection ID")?
            .to_owned()
    };

    for item_id in ids {
        let st = tile_state(engine, item_id).await;
        if st.collection.as_deref() == Some(target_id.as_str()) {
            continue;
        }
        let saved = enter_tile_view(engine, item_id).await;
        let src = tile_dom_op(engine, "locate", item_id).await?;
        let dst = tile_dom_op(engine, "drop_target", &target_id).await?;
        let coords = (|| {
            let s = src.get("tile")?;
            let d = dst.get("target")?;
            Some((
                s.get("x")?.as_f64()?,
                s.get("y")?.as_f64()?,
                d.get("x")?.as_f64()?,
                d.get("y")?.as_f64()?,
            ))
        })();
        let Some((sx, sy, tx, ty)) = coords else {
            restore_view(engine, saved).await;
            anyhow::bail!(
                "Cannot locate tile '{item_id}' or collection '{target_id}' for drag-and-drop"
            );
        };
        let drag_res = drag_and_confirm(engine, item_id, (sx, sy, tx, ty), |s| {
            s.collection.as_deref() == Some(target_id.as_str())
        })
        .await;
        restore_view(engine, saved).await;
        let moved = drag_res?;
        anyhow::ensure!(
            moved,
            "Flow did not confirm moving tile '{item_id}' into collection '{target_id}'"
        );
    }

    Ok(json!({
        "ok": true,
        "moved": ids.len(),
        "collection_id": target_id,
        "ids": ids,
        "method": "page:drag_to_collection",
    }))
}

/// Moves tiles out of their parent collection through the menu item or root drop zone.
pub(crate) async fn remove_from_collection_through_page(
    engine: &ChromeEngine,
    ids: &[String],
) -> Result<Value> {
    prepare_collection_page(engine).await?;
    verify_movable_items(engine, ids).await?;
    let mut method = "menu:move_out_of_collection";

    for item_id in ids {
        let st = tile_state(engine, item_id).await;
        if st.collection.is_none() {
            continue;
        }
        let saved = enter_tile_view(engine, item_id).await;
        let clicked = click_tile_menu_item(engine, item_id, MOVE_OUT_MENU_ITEM).await?;
        let mut moved =
            clicked && wait_tile_state(engine, item_id, 40, |s| s.collection.is_none()).await;
        if !moved {
            let src = tile_dom_op(engine, "locate", item_id).await?;
            let dst = page_op(engine, json!({ "action": "root_drop_target" })).await?;
            let coords = (|| {
                let s = src.get("tile")?;
                let d = dst.get("target")?;
                Some((
                    s.get("x")?.as_f64()?,
                    s.get("y")?.as_f64()?,
                    d.get("x")?.as_f64()?,
                    d.get("y")?.as_f64()?,
                ))
            })();
            if let Some(coords) = coords
                && drag_and_confirm(engine, item_id, coords, |s| s.collection.is_none())
                    .await
                    .unwrap_or(false)
            {
                moved = true;
                method = "page:drag_to_root";
            }
        }
        restore_view(engine, saved).await;
        anyhow::ensure!(
            moved,
            "Flow did not confirm moving tile '{item_id}' out of its collection"
        );
    }

    Ok(json!({
        "ok": true,
        "removed": ids.len(),
        "moved": ids.len(),
        "collection_id": Value::Null,
        "ids": ids,
        "method": method,
    }))
}

/// Empties member tiles to root and deletes collection `id` through its context menu.
pub(crate) async fn delete_collection_through_page(
    engine: &ChromeEngine,
    id: &str,
) -> Result<Value> {
    prepare_collection_page(engine).await?;
    let st = tile_state(engine, id).await;
    anyhow::ensure!(
        st.is_present() && st.kind == "collection",
        "Collection not found: {id}"
    );
    anyhow::ensure!(
        !st.has_child_collections,
        "collection_has_child_collections: {id}"
    );

    let member_ids = st.member_ids;
    if !member_ids.is_empty() {
        remove_from_collection_through_page(engine, &member_ids).await?;
    }
    anyhow::ensure!(
        wait_tile_state(engine, id, 20, |s| s.count == 0 && !s.has_child_collections).await,
        "Collection '{id}' is not empty before deletion"
    );
    let trashed = trash_through_menu(engine, id).await?;
    anyhow::ensure!(
        trashed,
        "Failed to delete collection '{id}' through its context menu"
    );

    Ok(json!({
        "ok": true,
        "deleted": id,
        "moved_to_root": member_ids.len(),
        "confirmed": true,
        "method": "menu:delete_collection",
    }))
}
