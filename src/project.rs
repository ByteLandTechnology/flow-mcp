// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Google Flow project navigation, session checks, and Angular store discovery.
//!
//! Drives the Google Flow Angular SPA inside [`ChromeEngine`] to check session state,
//! open or create a project workspace, bind the verified project store, and read asset and
//! collection snapshots.

use anyhow::Result;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::{Duration, Instant};

use crate::auth::{check_page_auth, check_page_signed_in, is_flow_host_url, redirect_sso_if_about};
use crate::config::{FLOW_URL, has_persisted_session};
use crate::engine::{ChromeEngine, ENGINE_NAME, checked_runtime_result};
pub(crate) use crate::project_route::{
    clean_project_title, collection_id_from_url, is_project_subroute_url, project_id_from_url,
    project_subroute_url, project_workspace_url,
};
use crate::project_store::{bind_current_store, prepare_project_store_status};

/// Angular error code for a required input that has no value yet.
const ANGULAR_REQUIRED_INPUT_ERROR: &str = "NG0950";

/// Time limit for home-page project grid pagination and confirmation.
const PROJECTS_OP_BUDGET: Duration = Duration::from_secs(45);

/// Parameters for `flow_status`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct StatusParams {
    /// Check the active Chrome page without navigation when true (default false).
    pub(crate) probe: Option<bool>,
}

/// Parameters for `flow_new_project`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct NewProjectParams {
    /// Project title applied after creation.
    pub(crate) title: Option<String>,
}

/// Parameters for `flow_projects`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct ProjectsParams {
    /// Action name: "list" (default), "create", "open", "rename", or "delete".
    pub(crate) action: Option<String>,
    /// Target project ID (optional for "open", "rename", or "delete").
    pub(crate) id: Option<String>,
    /// Project title for "create" or "rename", or case-insensitive title match for "open" or "delete".
    pub(crate) title: Option<String>,
}

/// Snapshot of the active Google Flow session and open project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct FlowStatus {
    /// True when the browser session is signed in to Google Flow.
    pub(crate) signed_in: bool,
    /// True when the active URL points to a `/project/<id>` workspace.
    pub(crate) in_project: bool,
    /// Active project title when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) project: Option<String>,
    /// Active project ID parsed from `/project/<id>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) project_id: Option<String>,
    /// Active page URL in Chrome.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
    /// Remaining AI credits on the Flow page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) credits: Option<i64>,
    /// Number of media assets in the project store.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) assets_count: Option<usize>,
    /// Number of collections in the project store.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) collections_count: Option<usize>,
    /// True when the active Chrome page session exists.
    pub(crate) page_ready: bool,
    /// Browser engine identifier (`"chrome-cdp"`).
    pub(crate) engine: String,
    /// Front-end build label and project store checks of the active page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) frontend: Option<Value>,
    /// Error message when page startup or probing fails.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

/// Exits child routes under `/project/<id>`, keeping `/collection/<cid>` when `allow_collection` is `true`.
async fn ensure_project_route(engine: &ChromeEngine, allow_collection: bool) -> Result<()> {
    let current = engine.current_url().await?;
    if !is_project_subroute_url(&current, allow_collection) {
        return Ok(());
    }
    let project_id = project_id_from_url(&current)
        .ok_or_else(|| anyhow::anyhow!("Cannot identify the active Flow project"))?;
    let workspace = project_workspace_url(&current, &project_id);
    let target_url = match collection_id_from_url(&current).filter(|_| allow_collection) {
        Some(cid) => project_subroute_url(&current, &project_id, &format!("collection/{cid}")),
        None => workspace.clone(),
    };
    let returned = |url: &str| {
        is_flow_host_url(url)
            && !is_project_subroute_url(url, allow_collection)
            && project_id_from_url(url).as_deref() == Some(project_id.as_str())
            && project_workspace_url(url, &project_id) == workspace
    };
    let nav_action = if allow_collection {
        "exit_subroute"
    } else {
        "exit_to_root"
    };
    let _ = eval_project_nav(engine, nav_action).await;
    if returned(&engine.current_url().await.unwrap_or_default()) {
        return Ok(());
    }
    engine.navigate(&target_url).await?;
    for _ in 0..10 {
        if returned(&engine.current_url().await.unwrap_or_default()) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    anyhow::bail!("Cannot return to the active Flow project workspace")
}

/// Navigates back to `/project/<id>` or `/project/<id>/collection/<cid>` from non-grid subroutes.
pub(crate) async fn ensure_project_workspace_root(engine: &ChromeEngine) -> Result<()> {
    ensure_project_route(engine, true).await
}

/// Opens a Flow page and verifies access with the active Chrome profile.
async fn ensure_signed_in_flow_page(engine: &ChromeEngine) -> Result<String> {
    engine.ensure_page().await?;
    let mut url = engine.current_url().await?;
    if !is_flow_host_url(&url) {
        engine.navigate(FLOW_URL).await?;
        tokio::time::sleep(Duration::from_millis(600)).await;
        url = engine.current_url().await?;
    }
    redirect_sso_if_about(engine, &mut url).await?;
    if url.contains("accounts.google.com") {
        anyhow::bail!(
            "Google Flow session is not signed in (current URL: {}). Call flow_login first.",
            url
        );
    }
    if !check_page_signed_in(engine).await {
        url = engine.current_url().await.unwrap_or(url);
        anyhow::bail!(
            "Session is not signed in to Google Flow (at {}). Complete sign-in and call flow_login.",
            url
        );
    }
    url = engine.current_url().await.unwrap_or(url);
    Ok(url)
}

/// Evaluates `projectNav(action)` in the active browser page.
async fn eval_project_nav(engine: &ChromeEngine, action: &str) -> Result<Value> {
    engine.call_flow_async("projectNav", json!([action])).await
}

/// Reads Google Flow session state without navigation when `probe` is `true`,
/// or opens Flow when `probe` is `false`. Reads the store without changing project routes.
pub(crate) async fn get_flow_state(engine: &ChromeEngine, probe: bool) -> FlowStatus {
    if !probe && !engine.has_page().await && !has_persisted_session() {
        return FlowStatus {
            signed_in: false,
            in_project: false,
            project: None,
            project_id: None,
            url: None,
            credits: None,
            assets_count: None,
            collections_count: None,
            page_ready: false,
            engine: ENGINE_NAME.to_string(),
            frontend: None,
            error: None,
        };
    }

    let (page_ready, page_err) = if probe {
        (engine.has_page().await, None)
    } else {
        match engine.ensure_page().await {
            Ok(()) => (true, None),
            Err(err) => (false, Some(err)),
        }
    };

    if !page_ready {
        let error = if probe {
            Some("No active Flow page exists".to_string())
        } else if let Some(err) = page_err {
            Some(format!("Failed to initialize the Chrome page: {err:#}"))
        } else {
            Some("Failed to initialize the Chrome page".to_string())
        };
        return FlowStatus {
            signed_in: false,
            in_project: false,
            project: None,
            project_id: None,
            url: None,
            credits: None,
            assets_count: None,
            collections_count: None,
            page_ready: false,
            engine: ENGINE_NAME.to_string(),
            frontend: None,
            error,
        };
    }

    let mut url = engine.current_url().await.unwrap_or_default();
    if !probe {
        if url.is_empty() || url == "about:blank" {
            let _ = engine.navigate(FLOW_URL).await;
            url = engine.current_url().await.unwrap_or_default();
        }
        let _ = redirect_sso_if_about(engine, &mut url).await;
    }
    let auth_check = check_page_auth(engine, false).await;
    if !probe {
        url = engine.current_url().await.unwrap_or(url);
    }
    let project_id = project_id_from_url(&url);
    let in_project = project_id.is_some();
    let signed_in = auth_check
        .get("signed_in")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut project = None;
    let mut credits = None;
    let mut assets_count = None;
    let mut collections_count = None;

    if let Some(project_id) = &project_id {
        prepare_project_store_status(engine, project_id).await;
    }

    if in_project {
        let mut snap = engine
            .call_flow_js("readStoreSnapshot", json!([]))
            .await
            .unwrap_or(Value::Null);
        if !probe {
            for _ in 0..8 {
                if snap.get("error").and_then(Value::as_str) != Some("store_loading") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
                snap = engine
                    .call_flow_js("readStoreSnapshot", json!([]))
                    .await
                    .unwrap_or(Value::Null);
            }
        }
        if snap.get("ok").and_then(Value::as_bool) == Some(true) {
            project = clean_project_title(snap.get("projectTitle").and_then(Value::as_str), true);
            credits = snap.get("credits").and_then(Value::as_i64);
            assets_count = snap.get("assets").and_then(Value::as_array).map(Vec::len);
            collections_count = snap
                .get("collections")
                .and_then(Value::as_array)
                .map(Vec::len);
        } else {
            project = clean_project_title(auth_check.get("title").and_then(Value::as_str), false);
        }
    }

    let frontend = if in_project {
        engine.call_flow_js("probeStore", json!([])).await.ok()
    } else if is_flow_host_url(&url) {
        engine.call_flow_js("probeBuild", json!([])).await.ok()
    } else {
        None
    };

    FlowStatus {
        signed_in,
        in_project,
        project,
        project_id,
        url: Some(url),
        credits,
        assets_count,
        collections_count,
        page_ready: true,
        engine: ENGINE_NAME.to_string(),
        frontend,
        error: None,
    }
}

/// Signs in if needed, opens a `/project/<id>` route, and binds the verified project store.
pub(crate) async fn ensure_flow_store(engine: &ChromeEngine) -> Result<()> {
    let Some(_store_guard) = engine.try_lock_project_store() else {
        let url = engine.current_url().await?;
        if let Some(project_id) = project_id_from_url(&url) {
            let status = engine
                .call_flow_js("projectStoreStatus", json!([project_id]))
                .await?;
            if status["ok"].as_bool() == Some(true) {
                return Ok(());
            }
        }
        anyhow::bail!("The Flow project store is busy");
    };
    let mut url = ensure_signed_in_flow_page(engine).await?;

    if project_id_from_url(&url).is_none() {
        let entered = eval_project_nav(engine, "enter_existing")
            .await
            .unwrap_or(Value::Null);

        if entered.as_str() == Some("none") {
            anyhow::bail!(
                "No Google Flow project is open. Call flow_new_project or flow_projects to create one first."
            );
        }

        let mut entered_project = false;
        for _ in 0..30 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let cur = engine.current_url().await.unwrap_or_default();
            if cur.contains("accounts.google.com") {
                anyhow::bail!(
                    "Google Flow redirected to Google Sign-In ({}). Call flow_login to sign in.",
                    cur
                );
            }
            if project_id_from_url(&cur).is_some() {
                url = cur;
                entered_project = true;
                let has_workspace = eval_project_nav(engine, "has_workspace")
                    .await
                    .ok()
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if has_workspace {
                    break;
                }
            }
        }

        if !entered_project {
            anyhow::bail!(
                "No Google Flow project is open. Call flow_new_project or flow_projects to open or create one first."
            );
        }
    }

    let Some(project_id) = project_id_from_url(&url) else {
        anyhow::bail!(
            "No Google Flow project is open. Call flow_new_project or flow_projects to open or create one first."
        );
    };

    let workspace = project_workspace_url(&url, &project_id);
    let mut input_pending = false;
    for attempt in 0..10 {
        let active_url = engine.current_url().await?;
        anyhow::ensure!(
            is_flow_host_url(&active_url)
                && project_id_from_url(&active_url).as_deref() == Some(project_id.as_str())
                && project_workspace_url(&active_url, &project_id) == workspace,
            "The active Flow project changed during store setup"
        );
        let status = store_loading_result(bind_current_store(engine, &project_id).await)?;
        let status_err = status.get("error").and_then(Value::as_str);
        if status_err == Some("unsupported_front_end") {
            anyhow::bail!(
                "Google Flow front end build is not supported (unsupported_front_end).{}",
                build_suffix(engine).await
            );
        }
        if status["ok"].as_bool() == Some(true) {
            return Ok(());
        }
        if status_err == Some("store_loading") {
            tokio::time::sleep(Duration::from_millis(250)).await;
            continue;
        }
        input_pending = status_err == Some(ANGULAR_REQUIRED_INPUT_ERROR);

        let discovery =
            store_loading_result(engine.call_flow_async("discoverStore", json!([])).await)?;
        let discovery_err = discovery.get("error").and_then(Value::as_str);
        if discovery_err == Some("unsupported_front_end") {
            anyhow::bail!(
                "Google Flow front end build is not supported (unsupported_front_end).{}",
                build_suffix(engine).await
            );
        }
        input_pending |= discovery_err == Some(ANGULAR_REQUIRED_INPUT_ERROR);
        if discovery["bound"].as_bool() == Some(true) {
            tokio::time::sleep(Duration::from_millis(250)).await;
            continue;
        }
        if attempt == 2 && !input_pending {
            let pos = eval_project_nav(engine, "first_tile_center")
                .await
                .unwrap_or(Value::Null);
            if let (Some(x), Some(y)) = (
                pos.get("x").and_then(|v| v.as_f64()),
                pos.get("y").and_then(|v| v.as_f64()),
            ) {
                let _ = engine.mouse_move(x, y).await;
            }
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
    if input_pending {
        anyhow::bail!(
            "The Flow project store is still loading (Angular {ANGULAR_REQUIRED_INPUT_ERROR}).{}",
            build_suffix(engine).await
        );
    }
    anyhow::bail!(
        "Failed to bind the Flow project store. Open a Flow project first.{}",
        build_suffix(engine).await
    )
}

/// Treats an unset Angular input as a loading result for a project store read.
fn store_loading_result(result: Result<Value>) -> Result<Value> {
    match result {
        Err(error)
            if error.to_string().lines().next().is_some_and(|line| {
                line.strip_prefix("JavaScript error: ")
                    .is_some_and(|message| {
                        message
                            .split(|ch: char| !ch.is_ascii_alphanumeric())
                            .any(|part| part == ANGULAR_REQUIRED_INPUT_ERROR)
                    })
            }) =>
        {
            Ok(json!({ "ok": false, "error": ANGULAR_REQUIRED_INPUT_ERROR }))
        }
        result => result,
    }
}

/// Returns a message suffix with the front-end build label, or an empty string when the page has no label.
async fn build_suffix(engine: &ChromeEngine) -> String {
    match engine.build_label().await {
        Some(label) => format!(" Flow front end build: {label}."),
        None => String::new(),
    }
}

/// Binds the Flow store if needed and returns a JSON snapshot of assets, collections, title, and credits.
pub(crate) async fn read_snapshot(engine: &ChromeEngine) -> Result<Value> {
    if engine.has_page().await
        && let Ok(snap) = engine.call_flow_js("readStoreSnapshot", json!([])).await
    {
        if snap.get("ok").and_then(|v| v.as_bool()) == Some(true) {
            return Ok(snap);
        }
        if snap.get("error").and_then(Value::as_str) == Some("unsupported_front_end") {
            anyhow::bail!(
                "Google Flow front end build is not supported (unsupported_front_end).{}",
                build_suffix(engine).await
            );
        }
    }
    let mut last_err = "store_not_bound".to_string();
    for _ in 0..25 {
        ensure_flow_store(engine).await?;
        let snap = store_loading_result(engine.call_flow_js("readStoreSnapshot", json!([])).await)?;
        if snap.get("ok").and_then(|v| v.as_bool()) == Some(true) {
            return Ok(snap);
        }
        last_err = snap
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        if last_err == "unsupported_front_end" {
            anyhow::bail!(
                "Google Flow front end build is not supported (unsupported_front_end).{}",
                build_suffix(engine).await
            );
        }
        let delay_ms = if matches!(
            last_err.as_str(),
            "store_loading" | ANGULAR_REQUIRED_INPUT_ERROR
        ) {
            200
        } else {
            150
        };
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
    }
    anyhow::bail!(
        "Failed to read Flow asset snapshot ({last_err}){}",
        build_suffix(engine).await
    );
}

/// Navigates to the Flow home page, clicks "New project", and persists `title` when provided.
pub(crate) async fn create_project(engine: &ChromeEngine, title: Option<&str>) -> Result<Value> {
    engine.ensure_page().await?;
    let initial_url = engine.current_url().await.unwrap_or_default();
    let already_on_home = crate::auth::is_signed_in_flow_url(&initial_url)
        && project_id_from_url(&initial_url).is_none();
    if !already_on_home {
        engine.navigate(FLOW_URL).await?;
        tokio::time::sleep(Duration::from_millis(900)).await;
    }
    let mut url = ensure_signed_in_flow_page(engine).await?;
    if project_id_from_url(&url).is_some() {
        engine.navigate(FLOW_URL).await?;
        tokio::time::sleep(Duration::from_millis(900)).await;
        url = ensure_signed_in_flow_page(engine).await?;
    }

    let mut clicked = false;
    for attempt in 0..50 {
        if attempt == 12 && already_on_home {
            engine.navigate(FLOW_URL).await?;
            tokio::time::sleep(Duration::from_millis(900)).await;
            url = ensure_signed_in_flow_page(engine).await?;
        }
        if eval_project_nav(engine, "click_new_project")
            .await?
            .as_bool()
            .unwrap_or(false)
        {
            clicked = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    if clicked {
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(400)).await;
            let cur = engine.current_url().await?;
            if cur.contains("accounts.google.com") {
                anyhow::bail!(
                    "Google Flow redirected to Google Sign-In ({}). Call flow_login to sign in.",
                    cur
                );
            }
            url = cur.clone();
            if project_id_from_url(&cur).is_some() {
                let has_ws = eval_project_nav(engine, "has_workspace")
                    .await
                    .ok()
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if has_ws {
                    break;
                }
            }
        }
    }
    let project_id = project_id_from_url(&url);
    let mut final_title = title
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if project_id.is_some() {
        let _ = ensure_flow_store(engine).await;
        if let Some(desired_title) = final_title.as_deref() {
            let res = run_projects_op(
                engine,
                json!({
                    "action": "set_title",
                    "title": desired_title,
                }),
            )
            .await?;
            if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                anyhow::bail!(
                    "Failed to set project title: {}",
                    res.get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                );
            }
            final_title = Some(confirm_project_title(engine, desired_title).await?);
        }
    }
    Ok(json!({
        "created": clicked && project_id.is_some(),
        "clicked": clicked,
        "project_id": project_id,
        "title": final_title,
        "url": url,
    }))
}

/// Invokes `projectsOp(req)` on the active Chrome page.
async fn run_projects_op(engine: &ChromeEngine, req: Value) -> Result<Value> {
    engine.call_flow_async("projectsOp", json!([req])).await
}

/// Returns the remaining milliseconds before `deadline`, or `None` when expired.
fn remaining_budget_ms(deadline: Instant) -> Option<u64> {
    let rem = deadline.checked_duration_since(Instant::now())?;
    let ms = u64::try_from(rem.as_millis()).unwrap_or(u64::MAX);
    (ms > 0).then_some(ms)
}

/// Navigates to the signed-in Google Flow home page and returns the remaining grid budget in milliseconds.
async fn open_signed_in_home_page(engine: &ChromeEngine) -> Result<u64> {
    let deadline = Instant::now() + PROJECTS_OP_BUDGET;
    engine.ensure_page().await?;
    engine.navigate(FLOW_URL).await?;
    tokio::time::sleep(Duration::from_millis(900)).await;
    let _ = ensure_signed_in_flow_page(engine).await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    remaining_budget_ms(deadline)
        .ok_or_else(|| anyhow::anyhow!("Timed out opening the Google Flow home page"))
}

/// Lists all existing Flow projects from the Flow home page.
async fn list_projects(engine: &ChromeEngine) -> Result<Value> {
    let timeout_ms = open_signed_in_home_page(engine).await?;
    let res = run_projects_op(
        engine,
        json!({ "action": "list", "timeout_ms": timeout_ms }),
    )
    .await?;
    if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        anyhow::bail!(
            "Failed to list Flow projects: {}",
            res.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        );
    }
    Ok(res)
}

/// Opens a Flow project by `id` or `title` and binds the project store.
async fn open_project(
    engine: &ChromeEngine,
    id: Option<&str>,
    title: Option<&str>,
) -> Result<Value> {
    let mut target_id = id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let mut matched_title = title.map(|s| s.trim().to_string());

    if target_id.is_none() {
        let want = title
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Provide `id` or `title` to open a project"))?;
        let timeout_ms = open_signed_in_home_page(engine).await?;
        let listed = run_projects_op(
            engine,
            json!({ "action": "list", "title": want, "timeout_ms": timeout_ms }),
        )
        .await?;
        if listed.get("ok").and_then(Value::as_bool) != Some(true) {
            anyhow::bail!(
                "Failed to list Flow projects: {}",
                listed
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            );
        }
        let truncated = listed.get("truncated").and_then(Value::as_bool) == Some(true);
        let projects = listed
            .get("projects")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let hit = projects
            .iter()
            .find(|p| {
                p.get("title")
                    .and_then(Value::as_str)
                    .is_some_and(|t| t.trim().to_lowercase() == want)
            })
            .cloned()
            .or_else(|| {
                projects.into_iter().find(|p| {
                    p.get("title")
                        .and_then(Value::as_str)
                        .is_some_and(|t| t.trim().to_lowercase().contains(&want))
                })
            });
        let Some(p) = hit else {
            if truncated {
                anyhow::bail!(
                    "Timed out scanning the Google Flow projects grid for title '{}'",
                    want
                );
            }
            anyhow::bail!("No Google Flow project matches title '{}'", want);
        };
        target_id = p.get("id").and_then(Value::as_str).map(str::to_string);
        if let Some(t) = p.get("title").and_then(Value::as_str) {
            matched_title = Some(t.to_string());
        }
    }

    let pid =
        target_id.ok_or_else(|| anyhow::anyhow!("Resolved project has no valid project ID"))?;
    let cur = engine.current_url().await.unwrap_or_default();
    let project_url = project_workspace_url(&cur, &pid);
    engine.navigate(&project_url).await?;
    tokio::time::sleep(Duration::from_millis(800)).await;
    ensure_flow_store(engine).await?;
    let snap = read_snapshot(engine).await?;
    let resolved_title =
        clean_project_title(snap.get("projectTitle").and_then(Value::as_str), true)
            .or(matched_title);
    Ok(json!({
        "opened": true,
        "project_id": pid,
        "title": resolved_title,
        "url": engine.current_url().await.unwrap_or(project_url),
        "assets_count": snap.get("assets").and_then(Value::as_array).map_or(0, Vec::len),
        "collections_count": snap.get("collections").and_then(Value::as_array).map_or(0, Vec::len),
    }))
}

/// Polls project snapshots until a verified `projectTitle` holds `desired` after a settle delay.
async fn confirm_project_title(engine: &ChromeEngine, desired: &str) -> Result<String> {
    let matches_desired = |snap: &Value| {
        snap.get("projectTitleVerified").and_then(Value::as_bool) != Some(false)
            && snap
                .get("projectTitle")
                .and_then(Value::as_str)
                .map(str::trim)
                == Some(desired)
    };
    let deadline = Instant::now() + Duration::from_secs(6);
    tokio::time::sleep(Duration::from_millis(250)).await;
    while Instant::now() < deadline {
        if let Ok(snap) = read_snapshot(engine).await
            && matches_desired(&snap)
        {
            tokio::time::sleep(Duration::from_millis(200)).await;
            if let Ok(settled) = read_snapshot(engine).await
                && matches_desired(&settled)
            {
                return Ok(desired.to_string());
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    anyhow::bail!(
        "Failed to confirm project title '{desired}' in the Flow project store{}",
        build_suffix(engine).await
    )
}

/// Renames the active project (or the project identified by `id`).
async fn rename_project(engine: &ChromeEngine, id: Option<&str>, title: &str) -> Result<Value> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        anyhow::bail!("New project title must not be empty");
    }
    if let Some(pid) = id.map(str::trim).filter(|s| !s.is_empty()) {
        let cur = engine.current_url().await.unwrap_or_default();
        if project_id_from_url(&cur).as_deref() != Some(pid) {
            let _ = open_project(engine, Some(pid), None).await?;
        } else {
            ensure_project_route(engine, false).await?;
            ensure_flow_store(engine).await?;
        }
    } else {
        ensure_project_route(engine, false).await?;
        ensure_flow_store(engine).await?;
    }
    ensure_project_route(engine, false).await?;
    let res = run_projects_op(engine, json!({ "action": "set_title", "title": trimmed })).await?;
    if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        anyhow::bail!(
            "Failed to rename project: {}",
            res.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        );
    }
    let confirmed_title = confirm_project_title(engine, trimmed).await?;
    let cur = engine.current_url().await.unwrap_or_default();
    Ok(json!({
        "ok": true,
        "project_id": project_id_from_url(&cur),
        "title": confirmed_title,
    }))
}

/// Deletes a Flow project from the Flow home page by `id` or exact `title`.
async fn delete_project(
    engine: &ChromeEngine,
    id: Option<&str>,
    title: Option<&str>,
) -> Result<Value> {
    let clean_id = id.map(str::trim).filter(|s| !s.is_empty());
    let clean_title = title.map(str::trim).filter(|s| !s.is_empty());
    if clean_id.is_none() && clean_title.is_none() {
        anyhow::bail!("Provide `id` or `title` to delete a project");
    }
    let timeout_ms = open_signed_in_home_page(engine).await?;

    let response = run_projects_op(
        engine,
        json!({
            "action": "delete",
            "project_id": clean_id,
            "title": clean_title,
            "timeout_ms": timeout_ms,
        }),
    )
    .await;
    match response {
        Ok(res) if res.get("ok").and_then(Value::as_bool) == Some(true) => Ok(res),
        Ok(res) if res.get("error").and_then(Value::as_str) == Some("outcome_unknown") => {
            checked_runtime_result(res)
        }
        Ok(res) => {
            let err = checked_runtime_result(res)
                .err()
                .unwrap_or_else(|| anyhow::anyhow!("unknown"));
            anyhow::bail!("Failed to delete project: {err:#}");
        }
        Err(err) => anyhow::bail!("outcome_unknown (delete project): {err:#}"),
    }
}

/// Dispatches `flow_projects` actions (`list`, `create`, `open`, `rename`, `delete`).
pub(crate) async fn handle_projects(engine: &ChromeEngine, req: ProjectsParams) -> Result<Value> {
    let action = req.action.as_deref().unwrap_or("list").trim();
    match action {
        "list" => list_projects(engine).await,
        "create" => create_project(engine, req.title.as_deref()).await,
        "open" => open_project(engine, req.id.as_deref(), req.title.as_deref()).await,
        "rename" => {
            let title = req
                .title
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("`title` is required for action \"rename\""))?;
            rename_project(engine, req.id.as_deref(), title).await
        }
        "delete" => delete_project(engine, req.id.as_deref(), req.title.as_deref()).await,
        other => anyhow::bail!("Unknown project action: {}", other),
    }
}
