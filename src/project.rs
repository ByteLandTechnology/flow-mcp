// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Google Flow project navigation, session checks, and Angular store discovery.
//!
//! Drives the Google Flow Angular SPA inside [`ChromeEngine`] to check session state,
//! open or create a project workspace, locate the `lService` store, and read asset and
//! collection snapshots.

use anyhow::Result;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Duration;

use crate::auth::{check_page_signed_in, is_signed_in_flow_url, redirect_sso_if_about};
use crate::config::{FLOW_URL, has_persisted_session};
use crate::engine::{ChromeEngine, ENGINE_NAME};
use crate::project_store::{prepare_project_store_status, wait_flow_mutation_rpc};

/// Angular error code for a required input that has no value yet.
const ANGULAR_REQUIRED_INPUT_ERROR: &str = "NG0950";

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

/// Extracts the `/project/<id>` segment from a Flow project URL.
pub(crate) fn project_id_from_url(url: &str) -> Option<String> {
    if let Some(pos) = url.find("/project/") {
        let rest = &url[pos + "/project/".len()..];
        let seg = rest.split(['/', '?', '#']).next().unwrap_or("").trim();
        if !seg.is_empty() {
            return Some(seg.to_string());
        }
    }
    None
}

/// Builds a Google Flow `/project/<id>` or sub-route URL preserving `/fx/tools/flow` when active.
pub(crate) fn project_subroute_url(
    reference_url: &str,
    project_id: &str,
    subroute: &str,
) -> String {
    let prefix = if reference_url.contains("/fx/tools/flow") {
        "https://flow.google.com/fx/tools/flow"
    } else {
        "https://flow.google.com"
    };
    let clean_sub = subroute.trim_start_matches('/');
    if clean_sub.is_empty() {
        format!("{}/project/{}?hl=en", prefix, project_id)
    } else {
        format!("{}/project/{}/{}?hl=en", prefix, project_id, clean_sub)
    }
}

/// Builds the Google Flow `/project/<id>` workspace URL preserving `/fx/tools/flow` when active.
pub(crate) fn project_workspace_url(reference_url: &str, project_id: &str) -> String {
    project_subroute_url(reference_url, project_id, "")
}

/// Navigates back to `/project/<id>` when Chrome is currently on a character, scene, edit, chat, or tools sub-route.
pub(crate) async fn ensure_project_workspace_root(engine: &ChromeEngine) -> Result<()> {
    let is_subroute = |url: &str| {
        let path = url.split(['?', '#']).next().unwrap_or_default();
        let section = path
            .split_once("/project/")
            .and_then(|(_, project)| project.split('/').nth(1));
        matches!(
            section,
            Some("character" | "scene" | "edit" | "chat" | "tool" | "tools")
        )
    };
    let cur = engine.current_url().await.unwrap_or_default();
    if is_subroute(&cur) {
        let _ = eval_project_nav(engine, "exit_subroute").await;
        let after = engine.current_url().await.unwrap_or_default();
        if is_subroute(&after)
            && let Some(pid) = project_id_from_url(&after).or_else(|| project_id_from_url(&cur))
        {
            engine
                .navigate(&project_workspace_url(&after, &pid))
                .await?;
            tokio::time::sleep(Duration::from_millis(900)).await;
        }
    }
    Ok(())
}

/// Ensures Chrome is on a signed-in Google Flow page and persists fresh cookies.
async fn ensure_signed_in_flow_page(engine: &ChromeEngine) -> Result<String> {
    engine.ensure_page().await?;
    let mut url = engine.current_url().await?;
    if !url.contains("labs.google") && !url.contains("flow.google.com") {
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
    let _ = engine.save_cookies().await;
    Ok(url)
}

/// Evaluates `projectNav(action)` in the active browser page.
async fn eval_project_nav(engine: &ChromeEngine, action: &str) -> Result<Value> {
    engine.call_flow_async("projectNav", json!([action])).await
}

/// Reads Google Flow session state without navigation when `probe` is `true`,
/// or opens Flow and binds the project store when `probe` is `false`.
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
    let project_id = project_id_from_url(&url);
    let in_project = project_id.is_some();

    let auth_check = if is_signed_in_flow_url(&url) {
        engine
            .call_flow_js("checkAuth", json!([]))
            .await
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };

    let signed_in = if auth_check
        .get("signed_in")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        true
    } else if !probe {
        check_page_signed_in(engine).await
    } else {
        false
    };
    if signed_in && !probe {
        let _ = engine.save_cookies().await;
    }

    let mut project = auth_check
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut credits = None;
    let mut assets_count = None;
    let mut collections_count = None;

    if in_project {
        let mut snap = engine
            .call_flow_js("readStoreSnapshot", json!([]))
            .await
            .unwrap_or(Value::Null);
        if snap.get("ok").and_then(|v| v.as_bool()) != Some(true)
            && !probe
            && ensure_flow_store(engine).await.is_ok()
        {
            snap = engine
                .call_flow_js("readStoreSnapshot", json!([]))
                .await
                .unwrap_or(Value::Null);
        }
        if snap.get("ok").and_then(|v| v.as_bool()) == Some(true) {
            if let Some(t) = snap.get("projectTitle").and_then(|v| v.as_str())
                && !t.is_empty()
            {
                project = Some(t.to_string());
            }
            credits = snap.get("credits").and_then(|v| v.as_i64());
            assets_count = snap
                .get("assets")
                .and_then(|v| v.as_array())
                .map(|a| a.len());
            collections_count = snap
                .get("collections")
                .and_then(|v| v.as_array())
                .map(|c| c.len());
        }
    }

    let frontend = if let Some(project_id) = &project_id {
        prepare_project_store_status(engine, project_id).await;
        engine.call_flow_js("probeStore", json!([])).await.ok()
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

/// Signs in if needed, opens a `/project/<id>` route, and binds `lService` in runtime state.
pub(crate) async fn ensure_flow_store(engine: &ChromeEngine) -> Result<()> {
    let url = ensure_signed_in_flow_page(engine).await?;
    let mut navigated = false;

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
                entered_project = true;
                navigated = true;
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

    let mut input_pending = false;
    for attempt in 0..10 {
        let discovery =
            store_loading_result(engine.call_flow_async("discoverStore", json!([])).await)?;
        input_pending =
            discovery.get("error").and_then(Value::as_str) == Some(ANGULAR_REQUIRED_INPUT_ERROR);
        let bound = discovery
            .get("bound")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if bound {
            let newly_discovered = discovery
                .get("newlyDiscovered")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if navigated || newly_discovered {
                let _ = engine.save_cookies().await;
            }
            return Ok(());
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
        "Failed to find the Flow project store (lService). Open a Flow project first.{}",
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
        && snap.get("ok").and_then(|v| v.as_bool()) == Some(true)
    {
        return Ok(snap);
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
            let mut net_rx = engine.subscribe_network().await.ok();
            if let Ok(res) = run_projects_op(
                engine,
                json!({
                    "action": "set_title",
                    "title": desired_title,
                }),
            )
            .await
            {
                if let Some(rx) = net_rx.as_mut() {
                    let _ = wait_flow_mutation_rpc(rx, Duration::from_millis(1200)).await;
                }
                if res.get("ok").and_then(|v| v.as_bool()) == Some(true)
                    && let Some(t) = res.get("title").and_then(|v| v.as_str())
                {
                    final_title = Some(t.to_string());
                }
            }
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

/// Navigates to the signed-in Google Flow home page.
async fn open_signed_in_home_page(engine: &ChromeEngine) -> Result<()> {
    engine.ensure_page().await?;
    engine.navigate(FLOW_URL).await?;
    tokio::time::sleep(Duration::from_millis(900)).await;
    let _ = ensure_signed_in_flow_page(engine).await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    Ok(())
}

/// Lists all existing Flow projects from the Flow home page.
async fn list_projects(engine: &ChromeEngine) -> Result<Value> {
    open_signed_in_home_page(engine).await?;
    let res = run_projects_op(engine, json!({ "action": "list" })).await?;
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
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Provide `id` or `title` to open a project"))?;
        let listed = list_projects(engine).await?;
        let projects = listed
            .get("projects")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let hit = projects.into_iter().find(|p| {
            p.get("title")
                .and_then(|v| v.as_str())
                .map(|t| t.trim().to_ascii_lowercase().contains(&want))
                .unwrap_or(false)
        });
        let Some(p) = hit else {
            anyhow::bail!("No Google Flow project matches title '{}'", want);
        };
        target_id = p.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());
        if let Some(t) = p.get("title").and_then(|v| v.as_str()) {
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
    Ok(json!({
        "opened": true,
        "project_id": pid,
        "title": snap.get("projectTitle").and_then(|v| v.as_str()).map(|s| s.to_string()).or(matched_title),
        "url": engine.current_url().await.unwrap_or(project_url),
        "assets_count": snap.get("assets").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
        "collections_count": snap.get("collections").and_then(|v| v.as_array()).map(|c| c.len()).unwrap_or(0),
    }))
}

/// Renames the active project (or the project identified by `id`).
async fn rename_project(engine: &ChromeEngine, id: Option<&str>, title: &str) -> Result<Value> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        anyhow::bail!("New project title must not be empty");
    }
    if let Some(pid) = id.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let cur = engine.current_url().await.unwrap_or_default();
        if project_id_from_url(&cur).as_deref() != Some(pid) {
            let _ = open_project(engine, Some(pid), None).await?;
        }
    } else {
        ensure_flow_store(engine).await?;
    }
    let mut net_rx = engine.subscribe_network().await.ok();
    let res = run_projects_op(engine, json!({ "action": "set_title", "title": trimmed })).await?;
    if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        anyhow::bail!(
            "Failed to rename project: {}",
            res.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        );
    }
    if let Some(rx) = net_rx.as_mut() {
        let _ = wait_flow_mutation_rpc(rx, Duration::from_millis(1200)).await;
    }
    let cur = engine.current_url().await.unwrap_or_default();
    Ok(json!({
        "ok": true,
        "project_id": project_id_from_url(&cur),
        "title": res.get("title").and_then(|v| v.as_str()).unwrap_or(trimmed),
    }))
}

/// Deletes a Flow project from the Flow home page by `id` or exact `title`.
async fn delete_project(
    engine: &ChromeEngine,
    id: Option<&str>,
    title: Option<&str>,
) -> Result<Value> {
    if id.map(|s| s.trim()).filter(|s| !s.is_empty()).is_none()
        && title.map(|s| s.trim()).filter(|s| !s.is_empty()).is_none()
    {
        anyhow::bail!("Provide `id` or `title` to delete a project");
    }
    open_signed_in_home_page(engine).await?;

    let mut net_rx = engine.subscribe_network().await.ok();
    let res = run_projects_op(
        engine,
        json!({ "action": "delete", "project_id": id, "title": title }),
    )
    .await?;
    if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        anyhow::bail!(
            "Failed to delete project: {}",
            res.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        );
    }
    if let Some(rx) = net_rx.as_mut() {
        let _ = wait_flow_mutation_rpc(rx, Duration::from_millis(1200)).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    Ok(res)
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
