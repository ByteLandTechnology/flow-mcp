// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Google Sign-In, Chrome cookie synchronization, session status, and logout handling.
//!
//! Runs CDP Chrome during background operations and opens a
//! visible Chrome window only during interactive Google Sign-In.

use anyhow::Result;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::time::Duration;
use tokio::time::Instant;
use url::Url;

use crate::config::{
    FLOW_SSO_URL, FLOW_URL, chrome_profile_dir, cookies_path, has_persisted_session,
};
use crate::cookies::{has_google_auth_cookies, read_cookies_file};
use crate::engine::{ChromeEngine, ENGINE_NAME};

/// Parameters for `flow_login`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct LoginParams {
    /// Action name: "login" ("start"), "sync_cookies" ("import_cookies"), "save_cookies", "status", or "logout" ("reset_session", "clear_cookies").
    pub(crate) action: Option<String>,
    /// Wait during "login" until sign-in finishes in Chrome (default true).
    pub(crate) wait: Option<bool>,
    /// Maximum wait time in seconds for sign-in completion (default 180).
    pub(crate) timeout_secs: Option<u64>,
    /// Clear saved cookies and session before starting interactive sign-in (default false).
    pub(crate) force: Option<bool>,
    /// Cookie objects to import directly during "sync_cookies".
    pub(crate) cookies: Option<Vec<Map<String, Value>>>,
}

/// Maximum `/about` SSO redirect attempts during session promotion.
const MAX_ABOUT_REDIRECT_ATTEMPTS: usize = 2;

/// Returns the Flow-relative path for `host` and `path`, or `None` when outside Flow mount paths.
fn normalize_flow_route_path<'a>(host: &str, path: &'a str) -> Option<&'a str> {
    if host == "flow.google.com" {
        if path == "/fx/tools/flow" {
            Some("/")
        } else if path.starts_with("/fx/tools/flow/") {
            Some(&path["/fx/tools/flow".len()..])
        } else {
            Some(path)
        }
    } else if host == "labs.google" || host.ends_with(".labs.google") {
        if path == "/fx/tools/flow" {
            Some("/")
        } else if path.starts_with("/fx/tools/flow/") {
            Some(&path["/fx/tools/flow".len()..])
        } else {
            None
        }
    } else {
        None
    }
}

/// Returns `true` when `rel_path` matches a recognized Google Flow workspace route.
fn is_workspace_flow_path(rel_path: &str) -> bool {
    let trimmed = rel_path.strip_suffix('/').unwrap_or(rel_path);
    if trimmed.is_empty() {
        return true;
    }
    let Some(rest) = trimmed.strip_prefix('/') else {
        return false;
    };
    let segments: Vec<&str> = rest.split('/').collect();
    if segments.iter().any(|seg| seg.is_empty()) {
        return false;
    }
    matches!(
        segments.as_slice(),
        ["projects" | "search"]
            | ["project", _]
            | [
                "project",
                _,
                "chat" | "character" | "trash" | "tools" | "create-tool",
            ]
            | [
                "project",
                _,
                "chat" | "collection" | "scene" | "edit" | "character" | "tool",
                _,
            ]
            | ["project", _, "collection", _, "character"]
            | ["project", _, "trash", "collection", _]
    )
}

/// Returns `true` when `raw` points to a recognized Google Flow workspace route.
pub(crate) fn is_signed_in_flow_url(raw: &str) -> bool {
    let Ok(parsed) = Url::parse(raw) else {
        return false;
    };
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return false;
    }
    let Some(host) = parsed.host_str().map(|h| h.to_ascii_lowercase()) else {
        return false;
    };
    let path = parsed.path().to_ascii_lowercase();
    normalize_flow_route_path(&host, &path).is_some_and(is_workspace_flow_path)
}

/// Returns `true` when the active Flow page shows an authenticated workspace shell.
pub(crate) async fn check_page_signed_in(engine: &ChromeEngine) -> bool {
    for _ in 0..8 {
        let url = engine.current_url().await.unwrap_or_default();
        if !is_signed_in_flow_url(&url) {
            return false;
        }
        let Ok(v) = engine.call_flow_js("checkAuth", json!([])).await else {
            tokio::time::sleep(Duration::from_millis(350)).await;
            continue;
        };
        if v.get("signed_in").and_then(|s| s.as_bool()) == Some(true) {
            return true;
        }
        if v.get("explicit_signed_out").and_then(|s| s.as_bool()) == Some(true) {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    false
}

/// Removes the persisted `cookies.json` file if present on disk.
fn remove_cookies_file() {
    let path = cookies_path();
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
}

/// Takes the `<home>` lock, then deletes `cookies.json` and wipes `<home>/chrome-profile`.
async fn clear_cookies_and_session(engine: &ChromeEngine) -> Result<()> {
    crate::instance::acquire_instance_lock()?;
    remove_cookies_file();
    engine.clear_session().await
}

/// Verifies URL, Google auth cookies, and Flow DOM shell together.
async fn check_fully_signed_in(engine: &ChromeEngine) -> bool {
    let url = engine.current_url().await.unwrap_or_default();
    if !is_signed_in_flow_url(&url) || url.contains("accounts.google.com") {
        return false;
    }
    let cookies = engine.flow_cookies().await.unwrap_or_default();
    if !has_google_auth_cookies(&cookies) {
        return false;
    }
    check_page_signed_in(engine).await
}

/// Formats a successful `flow_login` response JSON object.
fn signed_in_login_result(mode: &str, count: usize, url: String) -> Value {
    json!({
        "ok": true,
        "action": "login",
        "signedIn": true,
        "engine": ENGINE_NAME,
        "mode": mode,
        "cookiesCount": count,
        "url": url,
    })
}

/// Returns `true` when `url` points to a Google Flow `/about` or `/flow` landing route.
pub(crate) fn is_about_landing_url(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str().map(|h| h.to_ascii_lowercase()) else {
        return false;
    };
    let path = parsed.path().to_ascii_lowercase();
    let clean = path.strip_suffix('/').unwrap_or(&path);
    if host == "flow.google.com" {
        clean == "/about"
            || clean.starts_with("/about/")
            || clean == "/flow"
            || clean == "/flow/about"
            || clean.starts_with("/flow/about/")
            || clean == "/fx/about"
            || clean.starts_with("/fx/about/")
            || clean == "/fx/tools/flow/about"
            || clean.starts_with("/fx/tools/flow/about/")
    } else if host == "labs.google" || host.ends_with(".labs.google") {
        clean == "/fx/about"
            || clean.starts_with("/fx/about/")
            || clean == "/fx/tools/flow/about"
            || clean.starts_with("/fx/tools/flow/about/")
    } else {
        false
    }
}

/// Returns `true` when `url` points to a Google Accounts interactive sign-in route.
fn is_interactive_signin_url(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    if !host.eq_ignore_ascii_case("accounts.google.com") {
        return false;
    }
    let path = parsed.path().to_ascii_lowercase();
    path.contains("/v3/signin/")
        || path.contains("/signin/v2/")
        || path.contains("/interactivelogin")
        || path.contains("/servicelogin")
        || path.contains("/accountchooser")
}

/// Polls until Chrome finishes the passive Google SSO redirect or lands on an interactive sign-in page.
pub(crate) async fn wait_for_sso_redirect(engine: &ChromeEngine) {
    for _ in 0..20 {
        let cur = engine.current_url().await.unwrap_or_default();
        if is_signed_in_flow_url(&cur) || is_interactive_signin_url(&cur) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

/// Follows the Google SSO entry URL and refreshes `url` when Chrome lands on an `/about` page.
pub(crate) async fn redirect_sso_if_about(engine: &ChromeEngine, url: &mut String) -> Result<()> {
    if is_about_landing_url(url) {
        engine.navigate(FLOW_SSO_URL).await?;
        wait_for_sso_redirect(engine).await;
        *url = engine.current_url().await.unwrap_or_default();
    }
    Ok(())
}

/// Ensures Chrome is on a signed-in Flow workspace URL or follows the passive SSO redirect.
async fn ensure_flow_session_url(engine: &ChromeEngine) {
    let mut cur = engine.current_url().await.unwrap_or_default();
    if !is_signed_in_flow_url(&cur) {
        let _ = engine.navigate(FLOW_URL).await;
        cur = engine.current_url().await.unwrap_or_default();
    }
    if is_about_landing_url(&cur) || !is_signed_in_flow_url(&cur) {
        let _ = engine.navigate(FLOW_SSO_URL).await;
        wait_for_sso_redirect(engine).await;
    }
}

/// Promotes the interactive Chrome profile into background CDP mode and verifies Google Flow sign-in.
async fn finalize_promoted_login(engine: &ChromeEngine, start_url: &str) -> Result<Option<Value>> {
    engine.promote_login_chrome(start_url).await?;
    let mut about_retries = 0usize;
    for _ in 0..30 {
        let cur = engine.current_url().await.unwrap_or_default();
        if is_interactive_signin_url(&cur) {
            break;
        }
        if is_about_landing_url(&cur) {
            if about_retries >= MAX_ABOUT_REDIRECT_ATTEMPTS {
                break;
            }
            about_retries += 1;
            let _ = engine.navigate(FLOW_SSO_URL).await;
            wait_for_sso_redirect(engine).await;
            let after = engine.current_url().await.unwrap_or_default();
            if is_interactive_signin_url(&after) {
                break;
            }
            continue;
        }
        if is_signed_in_flow_url(&cur) && check_fully_signed_in(engine).await {
            let count = engine.save_cookies().await?;
            let final_url = engine.current_url().await.unwrap_or_default();
            return Ok(Some(signed_in_login_result(
                "interactive-chrome",
                count,
                final_url,
            )));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    engine.shutdown().await;
    Ok(None)
}

/// Signs in to Google Flow using standard Chrome and promotes the session into background CDP Chrome.
async fn login_with_chrome(
    engine: &ChromeEngine,
    timeout_secs: u64,
    wait_for_login: bool,
    force: bool,
) -> Result<Value> {
    if force {
        clear_cookies_and_session(engine).await?;
        engine.launch_interactive_login(FLOW_SSO_URL).await?;
    } else {
        if engine.has_login_chrome().await {
            if let Some(st) = engine.poll_login_chrome().await? {
                if let Some(rejected) = st.rejected_url {
                    clear_cookies_and_session(engine).await?;
                    anyhow::bail!(
                        "Google Accounts rejected sign-in in this browser session (URL: {}).",
                        rejected
                    );
                }
                if st.exited || (st.flow_url.is_some() && st.has_google_auth_cookies) {
                    if let Some(res) = finalize_promoted_login(engine, FLOW_URL).await? {
                        return Ok(res);
                    }
                    if st.exited {
                        anyhow::bail!("Sign-in window was closed before Google Sign-In completed.");
                    }
                }
            }
        } else if has_persisted_session() || engine.has_page().await {
            engine.ensure_page().await?;
            ensure_flow_session_url(engine).await;
            if check_fully_signed_in(engine).await {
                let count = engine.save_cookies().await?;
                let final_url = engine.current_url().await.unwrap_or_default();
                return Ok(signed_in_login_result("existing-session", count, final_url));
            }
        }

        if !engine.has_login_chrome().await {
            engine.launch_interactive_login(FLOW_SSO_URL).await?;
        }
    }

    if !wait_for_login {
        let st = engine.poll_login_chrome().await?;
        let url = st
            .as_ref()
            .and_then(|s| s.flow_url.clone().or_else(|| s.rejected_url.clone()))
            .unwrap_or_else(|| FLOW_SSO_URL.to_string());
        return Ok(json!({
            "ok": true,
            "action": "login",
            "signedIn": false,
            "engine": ENGINE_NAME,
            "mode": "window-open",
            "windowVisible": true,
            "cdpEndpoint": Value::Null,
            "url": url,
            "message": "Chrome sign-in window is open. Complete Google Sign-In in the window and call flow_login again."
        }));
    }

    let clamped_secs = timeout_secs.clamp(15, 3600);
    let deadline = Instant::now() + Duration::from_secs(clamped_secs);

    loop {
        let Some(st) = engine.poll_login_chrome().await? else {
            anyhow::bail!("Sign-in window was closed before Google Sign-In completed.");
        };

        if let Some(rejected) = st.rejected_url {
            clear_cookies_and_session(engine).await?;
            anyhow::bail!(
                "Google Accounts rejected sign-in in this browser session (URL: {}).",
                rejected
            );
        }

        if st.exited {
            if let Some(res) = finalize_promoted_login(engine, FLOW_URL).await? {
                return Ok(res);
            }
            anyhow::bail!("Sign-in window was closed before Google Sign-In completed.");
        }

        if st.flow_url.is_some() && st.has_google_auth_cookies {
            tokio::time::sleep(Duration::from_millis(4000)).await;
            if let Some(res) = finalize_promoted_login(engine, FLOW_URL).await? {
                return Ok(res);
            }
            anyhow::bail!(
                "Google Sign-In redirected to Google Flow, but session verification did not succeed. Run flow_login again."
            );
        }

        if Instant::now() >= deadline {
            if let Ok(Some(res)) = finalize_promoted_login(engine, FLOW_URL).await {
                return Ok(res);
            }
            engine.shutdown().await;
            anyhow::bail!(
                "Timed out after {}s waiting for Google Sign-In in Chrome.",
                clamped_secs,
            );
        }

        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Dispatches `flow_login` actions (`login`, `sync_cookies`, `save_cookies`, `status`, and `logout`).
pub(crate) async fn handle_login(engine: &ChromeEngine, req: LoginParams) -> Result<Value> {
    let action = req.action.as_deref().unwrap_or("login");

    match action {
        "login" | "start" => {
            let wait = req.wait.unwrap_or(true);
            let timeout_secs = req.timeout_secs.unwrap_or(180);
            let force = req.force.unwrap_or(false);
            login_with_chrome(engine, timeout_secs, wait, force).await
        }
        "sync_cookies" | "import_cookies" => {
            let count = if let Some(arr) = req.cookies {
                let vals = arr.into_iter().map(Value::Object).collect();
                engine.import_cookies(vals).await?
            } else {
                let disk = read_cookies_file()?;
                let vals: Vec<Value> = disk
                    .into_iter()
                    .filter_map(|c| serde_json::to_value(c).ok())
                    .collect();
                engine.import_cookies(vals).await?
            };
            engine.navigate(FLOW_SSO_URL).await?;
            wait_for_sso_redirect(engine).await;
            let url = engine.current_url().await.unwrap_or_default();
            let signed_in = check_page_signed_in(engine).await;
            if signed_in {
                let _ = engine.save_cookies().await;
            }
            Ok(json!({
                "ok": true,
                "action": "sync_cookies",
                "count": count,
                "url": url,
                "signedIn": signed_in,
                "engine": ENGINE_NAME,
            }))
        }
        "save_cookies" => {
            let count = engine.save_cookies().await?;
            Ok(json!({
                "ok": true,
                "action": "save_cookies",
                "count": count,
                "engine": ENGINE_NAME,
            }))
        }
        "status" => {
            if engine.has_login_chrome().await
                && let Some(st) = engine.poll_login_chrome().await?
            {
                if st.exited || (st.flow_url.is_some() && st.has_google_auth_cookies) {
                    let _ = finalize_promoted_login(engine, FLOW_URL).await;
                } else {
                    return Ok(json!({
                        "ok": true,
                        "action": "status",
                        "engine": ENGINE_NAME,
                        "pageReady": false,
                        "windowVisible": true,
                        "cdpEndpoint": Value::Null,
                        "cookiesSaved": cookies_path().is_file(),
                        "profileDir": chrome_profile_dir().to_string_lossy(),
                        "url": st.flow_url.or(st.rejected_url).unwrap_or_else(|| FLOW_SSO_URL.to_string()),
                        "signedIn": false,
                    }));
                }
            }
            let session_saved = has_persisted_session();
            let mut page_ready = engine.has_page().await;
            if !page_ready && session_saved && engine.ensure_page().await.is_ok() {
                ensure_flow_session_url(engine).await;
                page_ready = engine.has_page().await;
            }
            let url = if page_ready {
                engine.current_url().await.unwrap_or_default()
            } else {
                String::new()
            };
            let signed_in = if page_ready {
                check_page_signed_in(engine).await
            } else {
                false
            };
            if signed_in {
                let _ = engine.save_cookies().await;
            }
            Ok(json!({
                "ok": true,
                "action": "status",
                "engine": ENGINE_NAME,
                "pageReady": page_ready,
                "windowVisible": engine.is_window_visible(),
                "cdpEndpoint": engine.cdp_endpoint().await,
                "cookiesSaved": cookies_path().is_file(),
                "profileDir": chrome_profile_dir().to_string_lossy(),
                "url": url,
                "signedIn": signed_in,
            }))
        }
        "logout" | "reset_session" | "clear_cookies" => {
            clear_cookies_and_session(engine).await?;
            Ok(json!({
                "ok": true,
                "action": "logout",
                "engine": ENGINE_NAME,
                "url": "about:blank",
            }))
        }
        other => anyhow::bail!("Unknown login action: {}", other),
    }
}
