// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Tile operations through the "More options" menu of the Google Flow page.
//!
//! Each operation finds the tile through the project store, sends trusted
//! clicks to the menu of the page, and reads the store to confirm the result.
//! The page builds its own mutation, so a front-end build that renames the
//! mutation fields does not break these operations.

use anyhow::Result;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::time::Duration;

use crate::engine::ChromeEngine;
use crate::project::ensure_flow_store;

/// Menu item text that moves a tile to trash.
const TRASH_MENU_ITEM: &str = "Move to trash";

/// Menu item text that opens the rename control of a tile.
const RENAME_MENU_ITEM: &str = "Rename";

/// Number of queue jobs that use the page now.
static PAGE_JOBS: AtomicUsize = AtomicUsize::new(0);

/// Marks the page as in use by a queue job until the value drops.
pub(crate) struct PageHold;

impl PageHold {
    /// Marks the page as in use by one queue job.
    pub(crate) fn new() -> Self {
        PAGE_JOBS.fetch_add(1, Ordering::AcqRel);
        Self
    }
}

impl Drop for PageHold {
    /// Releases the page for menu operations.
    fn drop(&mut self) {
        PAGE_JOBS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Returns true when no queue job uses the page. A menu operation clicks the page and can change the route, so it must not run while a job waits on the page.
fn page_is_free() -> bool {
    PAGE_JOBS.load(Ordering::Acquire) == 0
}

/// Store state of one tile.
#[derive(Debug, Clone, Default)]
pub(crate) struct TileState {
    /// `present`, `trashed`, or `gone`. Empty when the store is not readable.
    pub(crate) state: String,
    /// Display name of a present tile.
    pub(crate) name: String,
    /// Collection ID of a present tile, or `None` when no collection holds it.
    pub(crate) collection: Option<String>,
}

impl TileState {
    /// Returns true when the tile map shows the tile and the tile is not in trash.
    pub(crate) fn is_present(&self) -> bool {
        self.state == "present"
    }

    /// Returns true when the tile is in trash or the tile map does not show it.
    fn is_trashed_or_gone(&self) -> bool {
        self.state == "trashed" || self.state == "gone"
    }
}

/// Runs one `tileDomOp` action of the browser runtime with the request `req`.
async fn page_op(engine: &ChromeEngine, req: Value) -> Result<Value> {
    engine.call_flow_async("tileDomOp", json!([req])).await
}

/// Runs one `tileDomOp` action of the browser runtime for tile `id`.
async fn tile_dom_op(engine: &ChromeEngine, action: &str, id: &str) -> Result<Value> {
    page_op(engine, json!({ "action": action, "id": id })).await
}

/// Returns true when the result `res` of a page action has `ok` set.
fn is_ok(res: &Value) -> bool {
    res.get("ok").and_then(|v| v.as_bool()) == Some(true)
}

/// Reads the store state of tile `id`. Returns the default state when the store is not readable.
pub(crate) async fn tile_state(engine: &ChromeEngine, id: &str) -> TileState {
    let Ok(res) = tile_dom_op(engine, "state", id).await else {
        return TileState::default();
    };
    let text = |key: &str| res.get(key).and_then(|v| v.as_str()).map(str::to_string);
    TileState {
        state: text("state").unwrap_or_default(),
        name: text("name").unwrap_or_default(),
        collection: text("collection").filter(|v| !v.is_empty()),
    }
}

/// Polls the store state of tile `id` every 250 ms, and returns true when `done` accepts it within `tries` polls.
async fn wait_tile_state(
    engine: &ChromeEngine,
    id: &str,
    tries: u32,
    done: impl Fn(&TileState) -> bool,
) -> bool {
    for _ in 0..tries {
        if done(&tile_state(engine, id).await) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    false
}

/// Returns true when the store shows tile `id` as trashed or removed within `tries` polls of 250 ms.
pub(crate) async fn wait_trashed(engine: &ChromeEngine, id: &str, tries: u32) -> bool {
    wait_tile_state(engine, id, tries, TileState::is_trashed_or_gone).await
}

/// Closes an open menu or overlay of the page.
async fn dismiss_overlay(engine: &ChromeEngine) {
    let _ = tile_dom_op(engine, "dismiss", "").await;
}

/// Hovers the tile that `loc` describes, opens its "More options" menu, and clicks the menu item `item`.
///
/// Returns false when the page does not show the tile, the menu, or the menu item. It closes the menu in that case.
async fn click_menu_item_at(engine: &ChromeEngine, loc: &Value, item: &str) -> Result<bool> {
    if !is_ok(loc) {
        return Ok(false);
    }
    let (Some(tile), Some(menu)) = (loc.get("tile"), loc.get("menu")) else {
        return Ok(false);
    };
    if let (Some(x), Some(y)) = (
        tile.get("x").and_then(|v| v.as_f64()),
        tile.get("y").and_then(|v| v.as_f64()),
    ) {
        engine.mouse_move(x, y).await?;
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    if !engine.click_point(menu).await? {
        return Ok(false);
    }
    for _ in 0..15 {
        let point = engine
            .call_flow_js("locatePoint", json!([{ "by": "menuitem", "name": item }]))
            .await?;
        if engine.click_point(&point).await? {
            return Ok(true);
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    dismiss_overlay(engine).await;
    Ok(false)
}

/// Opens the "More options" menu of tile `id` and clicks the menu item `item`.
async fn click_tile_menu_item(engine: &ChromeEngine, id: &str, item: &str) -> Result<bool> {
    let loc = tile_dom_op(engine, "locate", id).await?;
    click_menu_item_at(engine, &loc, item).await
}

/// Page view to restore after an operation: `Some(collection ID)`, with an empty ID for the main grid.
type SavedView = Option<String>;

/// Opens the main grid when `collection` is `None`, or the page of that collection, and binds the store again.
///
/// Returns the view to restore when the route changed. Returns `None` when the page already shows the view or cannot change to it.
async fn enter_view(engine: &ChromeEngine, collection: Option<&str>) -> SavedView {
    let before = page_op(engine, json!({ "action": "view" })).await.ok()?;
    let previous = before
        .get("collection")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let res = tile_dom_op(engine, "open_view", collection.unwrap_or(""))
        .await
        .ok()?;
    if !is_ok(&res) || res.get("changed").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    let _ = ensure_flow_store(engine).await;
    Some(previous)
}

/// Opens the view that shows tile `id`: the page of its collection, or the main grid.
async fn enter_tile_view(engine: &ChromeEngine, id: &str) -> SavedView {
    let state = tile_state(engine, id).await;
    if !state.is_present() {
        return None;
    }
    enter_view(engine, state.collection.as_deref()).await
}

/// Opens the view that `saved` holds again, and binds the store again.
async fn restore_view(engine: &ChromeEngine, saved: SavedView) {
    if let Some(collection) = saved {
        let _ = tile_dom_op(engine, "open_view", &collection).await;
        let _ = ensure_flow_store(engine).await;
    }
}

/// Moves a media tile to trash through its menu, and returns true when the store confirms it.
///
/// Returns false when the page does not show the tile, the menu, or the menu item, so that the caller can use the store mutation.
async fn trash_in_view(engine: &ChromeEngine, id: &str) -> Result<bool> {
    if !click_tile_menu_item(engine, id, TRASH_MENU_ITEM).await? {
        return Ok(false);
    }
    if wait_trashed(engine, id, 6).await {
        return Ok(true);
    }
    let confirm = page_op(engine, json!({ "action": "confirm_dialog" })).await?;
    if is_ok(&confirm)
        && let Some(point) = confirm.get("point")
        && engine.click_point(point).await?
        && wait_trashed(engine, id, 36).await
    {
        return Ok(true);
    }
    if wait_trashed(engine, id, 34).await {
        return Ok(true);
    }
    // The page can show a dialog after the click. Close it before the caller sends the store mutation.
    dismiss_overlay(engine).await;
    Ok(false)
}

/// Sends one trusted key press of the Enter key to the focused control.
async fn press_enter(engine: &ChromeEngine) -> Result<()> {
    for kind in ["keyDown", "keyUp"] {
        let mut params = json!({
            "type": kind,
            "key": "Enter",
            "code": "Enter",
            "windowsVirtualKeyCode": 13,
            "nativeVirtualKeyCode": 13,
        });
        if kind == "keyDown"
            && let Some(obj) = params.as_object_mut()
        {
            obj.insert("text".to_string(), Value::String("\r".to_string()));
        }
        engine.cdp_call("Input.dispatchKeyEvent", params).await?;
    }
    Ok(())
}

/// Types `name` into the focused rename control and submits it with the Enter key.
async fn type_rename(engine: &ChromeEngine, name: &str) -> Result<bool> {
    let mut selected = false;
    for _ in 0..15 {
        let res = page_op(engine, json!({ "action": "text_select" })).await?;
        if is_ok(&res) && res.get("focused").and_then(|v| v.as_bool()) == Some(true) {
            selected = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    if !selected {
        dismiss_overlay(engine).await;
        return Ok(false);
    }
    engine
        .cdp_call("Input.insertText", json!({ "text": name }))
        .await?;
    tokio::time::sleep(Duration::from_millis(150)).await;
    let typed = page_op(engine, json!({ "action": "text_value" })).await?;
    if typed.get("value").and_then(|v| v.as_str()) != Some(name) {
        // The control does not hold the new name. Do not submit a wrong name.
        dismiss_overlay(engine).await;
        return Ok(false);
    }
    press_enter(engine).await?;
    Ok(true)
}

/// Renames a media tile in the current view through the "Rename" item of its menu.
async fn rename_in_view(engine: &ChromeEngine, id: &str, name: &str) -> Result<bool> {
    if !click_tile_menu_item(engine, id, RENAME_MENU_ITEM).await? {
        return Ok(false);
    }
    if !type_rename(engine, name).await? {
        return Ok(false);
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut renamed = wait_tile_state(engine, id, 40, |s| s.name == name).await;
    if renamed {
        tokio::time::sleep(Duration::from_millis(250)).await;
        renamed = tile_state(engine, id).await.name == name;
    }
    if !renamed {
        dismiss_overlay(engine).await;
    }
    Ok(renamed)
}

/// Moves a media tile to trash through its menu, and returns true when the store confirms it.
///
/// Opens the view that shows the tile first, and restores the view after the operation. Returns false when the page does not show the tile, the menu, or the menu item, so that the caller can use the store mutation.
pub(crate) async fn trash_through_menu(engine: &ChromeEngine, id: &str) -> Result<bool> {
    if !page_is_free() {
        return Ok(false);
    }
    let saved = enter_tile_view(engine, id).await;
    let res = trash_in_view(engine, id).await;
    restore_view(engine, saved).await;
    res
}

/// Renames a media tile through the "Rename" item of its menu, and returns true when the store shows `name`.
///
/// Opens the view that shows the tile first, and restores the view after the operation. Returns false when the page does not show the tile, the menu item, or the rename control, or when the control does not hold `name` after the text input. The caller can then use the store mutation.
pub(crate) async fn rename_through_menu(
    engine: &ChromeEngine,
    id: &str,
    name: &str,
) -> Result<bool> {
    if !page_is_free() {
        return Ok(false);
    }
    let saved = enter_tile_view(engine, id).await;
    let res = rename_in_view(engine, id, name).await;
    restore_view(engine, saved).await;
    res
}
