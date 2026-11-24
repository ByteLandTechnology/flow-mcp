// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Tile and collection operations through the "More options" menu of the Google Flow page.
//!
//! Each operation finds the tile through the project store or rendered grid DOM, sends
//! trusted clicks to the menu of the page, and reads the store or DOM to confirm the result.
//! The page builds its own mutation, so a front-end build that renames the mutation fields
//! does not break these operations.

use anyhow::Result;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::time::Duration;

use crate::engine::ChromeEngine;
use crate::project::{ensure_flow_store, read_snapshot};

/// Menu item text that moves a tile to trash.
const TRASH_MENU_ITEM: &str = "Move to trash";

/// Menu item and dialog button text that deletes a collection folder on Google Flow.
const DELETE_COLLECTION_ITEM: &str = "Move all contents to trash";

/// Alternate menu item text that deletes a collection folder.
const DELETE_MENU_ITEM: &str = "Delete";

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

/// Store or DOM state of one tile.
#[derive(Debug, Clone, Default)]
pub(crate) struct TileState {
    /// `present`, `trashed`, or `gone`. Empty when neither store nor DOM is readable.
    pub(crate) state: String,
    /// Display name of a present tile.
    pub(crate) name: String,
    /// Collection ID of a present tile, or `None` when no collection holds it.
    pub(crate) collection: Option<String>,
}

impl TileState {
    /// Returns true when the tile map or DOM shows the tile and the tile is not in trash.
    pub(crate) fn is_present(&self) -> bool {
        self.state == "present"
    }

    /// Returns true when the tile is in trash or no longer shown.
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

/// Reads the store or DOM state of tile `id`. Returns the default state when not readable.
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

/// Polls the state of tile `id` every 250 ms, and returns true when `done` accepts it within `tries` polls.
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

/// Returns true when the store or DOM shows tile `id` as trashed or removed within `tries` polls of 250 ms.
pub(crate) async fn wait_trashed(engine: &ChromeEngine, id: &str, tries: u32) -> bool {
    wait_tile_state(engine, id, tries, TileState::is_trashed_or_gone).await
}

/// Closes an open menu or overlay of the page.
async fn dismiss_overlay(engine: &ChromeEngine) {
    let _ = tile_dom_op(engine, "dismiss", "").await;
}

/// Hovers the tile that `loc` describes and opens its "More options" menu.
async fn open_tile_menu_at(engine: &ChromeEngine, loc: &Value) -> Result<bool> {
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
    engine.click_point(menu).await
}

/// Hovers the tile that `loc` describes, opens its "More options" menu, and clicks one of `items`.
///
/// Returns false when the page does not show the tile, the menu, or any matching menu item.
async fn click_menu_items_at(engine: &ChromeEngine, loc: &Value, items: &[&str]) -> Result<bool> {
    if !open_tile_menu_at(engine, loc).await? {
        return Ok(false);
    }
    for _ in 0..15 {
        for item in items {
            let point = engine
                .call_flow_js("locatePoint", json!([{ "by": "menuitem", "name": item }]))
                .await?;
            if engine.click_point(&point).await? {
                return Ok(true);
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    dismiss_overlay(engine).await;
    Ok(false)
}

/// Opens the "More options" menu of tile `id` and clicks one of `items`.
async fn click_tile_menu_items(engine: &ChromeEngine, id: &str, items: &[&str]) -> Result<bool> {
    let loc = tile_dom_op(engine, "locate", id).await?;
    click_menu_items_at(engine, &loc, items).await
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

/// Returns true when the page shows the main grid (`collection` is `None`) or the page of that collection.
async fn view_is(engine: &ChromeEngine, collection: Option<&str>) -> bool {
    let Ok(view) = page_op(engine, json!({ "action": "view" })).await else {
        return false;
    };
    view.get("grid").and_then(|v| v.as_bool()) == Some(true)
        && view.get("collection").and_then(|v| v.as_str()) == collection
}

/// Clicks a confirmation button inside an open alert or confirmation dialog when present.
async fn confirm_trash_dialog_if_present(engine: &ChromeEngine) -> Result<bool> {
    for _ in 0..10 {
        for label in [
            DELETE_COLLECTION_ITEM,
            TRASH_MENU_ITEM,
            DELETE_MENU_ITEM,
            "Confirm",
        ] {
            let point = engine
                .call_flow_js("locatePoint", json!([{ "by": "text", "name": label }]))
                .await?;
            if engine.click_point(&point).await? {
                return Ok(true);
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    Ok(false)
}

/// Moves a tile or collection folder to trash through its menu, and returns true when confirmed.
async fn trash_in_view(engine: &ChromeEngine, id: &str) -> Result<bool> {
    if !click_tile_menu_items(
        engine,
        id,
        &[TRASH_MENU_ITEM, DELETE_COLLECTION_ITEM, DELETE_MENU_ITEM],
    )
    .await?
    {
        return Ok(false);
    }
    if wait_trashed(engine, id, 4).await {
        return Ok(true);
    }
    let _ = confirm_trash_dialog_if_present(engine).await;
    if wait_trashed(engine, id, 36).await {
        return Ok(true);
    }
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

/// Types `name` into the focused rename control (`control`, `current`) and submits it with Enter.
async fn type_into_control(
    engine: &ChromeEngine,
    control: &str,
    current: &str,
    name: &str,
) -> Result<bool> {
    let req = |action: &str| json!({ "action": action, "control": control, "name": current });
    let mut selected = false;
    for _ in 0..15 {
        let res = page_op(engine, req("text_select")).await?;
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
    let typed = page_op(engine, req("text_value")).await?;
    if typed.get("value").and_then(|v| v.as_str()) != Some(name) {
        dismiss_overlay(engine).await;
        return Ok(false);
    }
    press_enter(engine).await?;
    Ok(true)
}

/// Types `name` into the focused tile or dialog rename control and submits it with the Enter key.
async fn type_rename(engine: &ChromeEngine, name: &str) -> Result<bool> {
    type_into_control(engine, "", "", name).await
}

/// Renames a tile in the current view through the "Rename" item of its menu.
async fn rename_in_view(engine: &ChromeEngine, id: &str, name: &str) -> Result<bool> {
    if !click_tile_menu_items(engine, id, &[RENAME_MENU_ITEM]).await? {
        return Ok(false);
    }
    if !type_rename(engine, name).await? {
        return Ok(false);
    }
    let renamed = wait_tile_state(engine, id, 40, |s| s.name == name).await;
    if !renamed {
        dismiss_overlay(engine).await;
    }
    Ok(renamed)
}

/// Moves a tile or collection folder to trash through its menu, and returns true when confirmed.
pub(crate) async fn trash_through_menu(engine: &ChromeEngine, id: &str) -> Result<bool> {
    if !page_is_free() {
        return Ok(false);
    }
    let saved = enter_tile_view(engine, id).await;
    let res = trash_in_view(engine, id).await;
    let deleted_saved = matches!(res, Ok(true)) && saved.as_deref() == Some(id);
    if !deleted_saved {
        restore_view(engine, saved).await;
    }
    res
}

/// Opens the page of collection `id` and renames its editable page title from `current` to `name`.
pub(crate) async fn rename_collection_through_page(
    engine: &ChromeEngine,
    id: &str,
    current: &str,
    name: &str,
) -> Result<bool> {
    if !page_is_free() {
        return Ok(false);
    }
    let saved = enter_view(engine, Some(id)).await;
    let res = if view_is(engine, Some(id)).await {
        let point_res = page_op(
            engine,
            json!({ "action": "text_point", "control": "title", "name": current }),
        )
        .await?;
        if let Some(point) = point_res.get("point").filter(|_| is_ok(&point_res))
            && engine.click_point(point).await?
        {
            let typed = type_into_control(engine, "title", current, name).await?;
            tokio::time::sleep(Duration::from_millis(600)).await;
            Ok(typed)
        } else {
            Ok(false)
        }
    } else {
        Ok(false)
    };
    restore_view(engine, saved).await;
    res
}

/// Renames a tile or collection folder through the "Rename" item of its menu, and returns true when confirmed.
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

/// Moves a tile into `target_id` or out of its collection (`None`) through its tile menu.
pub(crate) async fn move_tile_collection_through_menu(
    engine: &ChromeEngine,
    id: &str,
    target_id: Option<&str>,
    target_name: Option<&str>,
) -> Result<bool> {
    if !page_is_free() {
        return Ok(false);
    }
    let saved = enter_tile_view(engine, id).await;
    let loc = tile_dom_op(engine, "locate", id).await?;
    if !open_tile_menu_at(engine, &loc).await? {
        restore_view(engine, saved).await;
        return Ok(false);
    }
    tokio::time::sleep(Duration::from_millis(150)).await;
    let res = page_op(
        engine,
        json!({
            "action": "move_collection_menu",
            "id": id,
            "target_id": target_id.unwrap_or(""),
            "name": target_name.unwrap_or(""),
        }),
    )
    .await;
    let clicked = res.as_ref().is_ok_and(is_ok);
    if clicked {
        let _ = wait_tile_state(engine, id, 12, |s| s.collection.as_deref() == target_id).await;
    } else {
        dismiss_overlay(engine).await;
    }
    restore_view(engine, saved).await;
    Ok(clicked)
}

/// Creates a new collection through the workspace UI and returns its ID when observed.
pub(crate) async fn create_collection_through_ui(
    engine: &ChromeEngine,
    name: &str,
) -> Result<Option<String>> {
    if !page_is_free() {
        return Ok(None);
    }
    let saved = enter_view(engine, None).await;
    let before_ids: HashSet<String> = read_snapshot(engine)
        .await
        .ok()
        .and_then(|snap| snap.get("collections").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|c| c.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();

    let res = page_op(
        engine,
        json!({ "action": "create_collection_ui", "name": name }),
    )
    .await?;
    if !is_ok(&res) {
        restore_view(engine, saved).await;
        return Ok(None);
    }
    let typed = res.get("typed").and_then(Value::as_bool) == Some(true);
    if !typed {
        let _ = type_rename(engine, name).await;
    }

    let mut created_id: Option<String> = None;
    let mut needs_rename = false;
    for _ in 0..25 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let Ok(snap) = engine
            .call_flow_js("readStoreSnapshot", json!([true]))
            .await
        else {
            continue;
        };
        let Some(cols) = snap.get("collections").and_then(Value::as_array) else {
            continue;
        };
        if let Some(found) = cols.iter().find(|c| {
            c.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| !before_ids.contains(id))
        }) {
            let cid = found
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let cname = found.get("name").and_then(Value::as_str).unwrap_or("");
            needs_rename = cname != name;
            created_id = Some(cid);
            break;
        }
        if let Some(named) = cols
            .iter()
            .find(|c| c.get("name").and_then(Value::as_str) == Some(name))
            .and_then(|c| c.get("id").and_then(Value::as_str))
        {
            created_id = Some(named.to_string());
            break;
        }
    }

    if needs_rename && let Some(cid) = created_id.as_deref() {
        let _ = rename_in_view(engine, cid, name).await;
    }
    restore_view(engine, saved).await;
    Ok(created_id)
}
