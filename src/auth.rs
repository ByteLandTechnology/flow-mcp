// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Google Sign-In, explicit cookie export/import, session verification, and logout handling.
//!
//! Runs CDP Chrome on `<home>/chrome-profile` during background operations and opens a
//! visible Chrome window without CDP flags only during interactive Google Sign-In.

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

/// Maximum number of `/about` passive SSO redirect attempts during session promotion.
const MAX_ABOUT_SSO_RETRIES: usize = 2;

/// Exact or segment-prefix non-workspace routes from the live Flow route table.
const NON_WORKSPACE_SEGMENT_PREFIXES: [&str; 19] = [
    "/unsupported-country",
    "/unsupported-browser",
    "/unavailable",
    "/age-restricted",
    "/privacy",
    "/credits-terms",
    "/about",
    "/flow/about",
    "/academy",
    "/shared/tool",
    "/shared",
    "/flow/shared/tool",
    "/flow/shared",
    "/tools/flow/shared/tool",
    "/tools/flow/shared",
    "/404",
    "/login",
    "/tools/flow/about",
    "/tools/flow/login",
];

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

/// Returns `true` when `path` equals `prefix` or begins with `prefix` plus `/`.
fn has_segment_prefix(path: &str, prefix: &str) -> bool {
    path == prefix
        || (path.len() > prefix.len()
            && path.starts_with(prefix)
            && path.as_bytes().get(prefix.len()) == Some(&b'/'))
}

/// Normalizes a URL path to lowercase without trailing slashes, preserving `/`.
fn normalize_flow_path(raw: &str) -> String {
    let lower = raw.trim().to_ascii_lowercase();
    let with_slash = if lower.starts_with('/') {
        lower
    } else {
        format!("/{lower}")
    };
    let trimmed = with_slash.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Strips an optional `/fx` prefix from a normalized path.
fn strip_fx_prefix(clean_path: &str) -> &str {
    if clean_path == "/fx" {
        "/"
    } else if let Some(rest) = clean_path.strip_prefix("/fx/") {
        &clean_path[3..3 + 1 + rest.len()]
    } else {
        clean_path
    }
}

/// Returns `true` when `clean_path` matches any of the 17 non-workspace Flow routes.
fn is_non_workspace_flow_path(clean_path: &str) -> bool {
    let rel = strip_fx_prefix(clean_path);
    if rel == "/flow" {
        return true;
    }
    NON_WORKSPACE_SEGMENT_PREFIXES
        .iter()
        .any(|prefix| has_segment_prefix(rel, prefix))
}

/// Returns true when the URL targets a Google Flow host.
pub(crate) fn is_flow_host_url(raw: &str) -> bool {
    Url::parse(raw).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && crate::project_route::is_flow_origin_host(url.host_str())
    })
}

/// Returns `true` when `raw` points to a Google Flow workspace host and route.
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
    let on_labs = host == "labs.google" || host.ends_with(".labs.google");
    if host != "flow.google.com" && !on_labs {
        return false;
    }
    let clean_path = normalize_flow_path(parsed.path());
    if on_labs && !has_segment_prefix(&clean_path, "/fx/tools/flow") {
        return false;
    }
    !is_non_workspace_flow_path(&clean_path)
}

/// Evaluates `checkAuth` once in the active page, retrying brief context resets during navigation.
async fn eval_check_auth_once(engine: &ChromeEngine) -> Option<Value> {
    for _ in 0..3 {
        match engine.call_flow_async("checkAuth", json!([])).await {
            Ok(v) => return Some(v),
            Err(_) => tokio::time::sleep(Duration::from_millis(350)).await,
        }
    }
    None
}

/// Verifies active Flow workspace access and reloads the workspace once when a session token expired.
pub(crate) async fn check_page_auth(engine: &ChromeEngine, reload_on_expired: bool) -> Value {
    let url = engine.current_url().await.unwrap_or_default();
    if !is_signed_in_flow_url(&url) {
        return Value::Null;
    }
    let Some(state) = eval_check_auth_once(engine).await else {
        return Value::Null;
    };
    if reload_on_expired && state.get("token_expired").and_then(Value::as_bool) == Some(true) {
        let target = if is_signed_in_flow_url(&url) {
            url
        } else {
            FLOW_URL.to_string()
        };
        if engine.navigate(&target).await.is_ok() {
            let mut refreshed = engine.current_url().await.unwrap_or_default();
            let _ = redirect_sso_if_about(engine, &mut refreshed).await;
            if is_signed_in_flow_url(&refreshed) {
                return eval_check_auth_once(engine).await.unwrap_or(Value::Null);
            }
        }
        return Value::Null;
    }
    state
}

/// Returns `true` when the active Flow page passes workspace route, Wiz token, and backend probe checks.
pub(crate) async fn check_page_signed_in(engine: &ChromeEngine) -> bool {
    check_page_auth(engine, true)
        .await
        .get("signed_in")
        .and_then(Value::as_bool)
        .unwrap_or(false)
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

/// Verifies URL, live Google auth cookies, and the authenticated Flow workspace probe together.
async fn check_fully_signed_in(engine: &ChromeEngine) -> Option<usize> {
    let url = engine.current_url().await.unwrap_or_default();
    if !is_signed_in_flow_url(&url) || url.contains("accounts.google.com") {
        return None;
    }
    let cookies = engine.flow_cookies().await.unwrap_or_default();
    if !has_google_auth_cookies(&cookies) {
        return None;
    }
    check_page_signed_in(engine).await.then_some(cookies.len())
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

/// Returns `true` when `url` points to a Google Flow `/about` landing route.
pub(crate) fn is_about_landing_url(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return url.contains("flow.google.com/about") || url.contains("/fx/about");
    };
    let Some(host) = parsed.host_str().map(|h| h.to_ascii_lowercase()) else {
        return false;
    };
    let on_flow =
        host == "flow.google.com" || host == "labs.google" || host.ends_with(".labs.google");
    if !on_flow {
        return false;
    }
    let clean = normalize_flow_path(parsed.path());
    let rel = strip_fx_prefix(&clean);
    rel == "/flow"
        || has_segment_prefix(rel, "/about")
        || has_segment_prefix(rel, "/flow/about")
        || has_segment_prefix(rel, "/tools/flow/about")
}

/// Returns `true` when `url` points to an interactive Google Accounts sign-in route.
fn is_interactive_signin_url(url: &str) -> bool {
    url.contains("/InteractiveLogin")
        || url.contains("/ServiceLogin")
        || url.contains("/v3/signin/")
        || url.contains("/signin/v2/")
        || url.contains("/AccountChooser")
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
            if about_retries >= MAX_ABOUT_SSO_RETRIES {
                break;
            }
            about_retries += 1;
            let _ = engine.navigate(FLOW_SSO_URL).await;
            wait_for_sso_redirect(engine).await;
            let after_sso = engine.current_url().await.unwrap_or_default();
            if is_interactive_signin_url(&after_sso) {
                break;
            }
            continue;
        }
        if is_signed_in_flow_url(&cur)
            && let Some(count) = check_fully_signed_in(engine).await
        {
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
        crate::instance::acquire_instance_lock()?;
        remove_cookies_file();
        engine.launch_interactive_login(FLOW_SSO_URL, true).await?;
    } else if engine.has_login_chrome().await {
        if let Some(st) = engine.poll_login_chrome().await? {
            if let Some(rejected) = st.rejected_url {
                engine.shutdown().await;
                anyhow::bail!(
                    "Google Accounts rejected sign-in in this browser session (URL: {}).",
                    rejected
                );
            }
            if st.exited || st.has_google_auth_cookies {
                if let Some(res) = finalize_promoted_login(engine, FLOW_URL).await? {
                    return Ok(res);
                }
                if st.exited {
                    anyhow::bail!("Sign-in window was closed before Google Sign-In completed.");
                }
            }
        }
        if !engine.has_login_chrome().await {
            engine.launch_interactive_login(FLOW_SSO_URL, false).await?;
        }
    } else {
        if has_persisted_session() || engine.has_page().await {
            engine.ensure_page().await?;
            ensure_flow_session_url(engine).await;
            if let Some(count) = check_fully_signed_in(engine).await {
                let final_url = engine.current_url().await.unwrap_or_default();
                return Ok(signed_in_login_result("existing-session", count, final_url));
            }
        }
        engine.launch_interactive_login(FLOW_SSO_URL, false).await?;
    }

    if !wait_for_login {
        let st = engine.poll_login_chrome().await?;
        let url = st
            .and_then(|s| s.rejected_url)
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
            engine.shutdown().await;
            anyhow::bail!(
                "Google Accounts rejected sign-in in this browser session (URL: {}).",
                rejected
            );
        }

        if st.exited || st.has_google_auth_cookies {
            if st.has_google_auth_cookies && !st.exited {
                tokio::time::sleep(Duration::from_secs(4)).await;
            }
            if let Some(res) = finalize_promoted_login(engine, FLOW_URL).await? {
                return Ok(res);
            }
            if st.exited {
                anyhow::bail!("Sign-in window was closed before Google Sign-In completed.");
            }
            anyhow::bail!(
                "Google Sign-In wrote authentication cookies, but workspace verification did not succeed. Run flow_login again."
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
            let signed_in = check_page_signed_in(engine).await;
            let url = engine.current_url().await.unwrap_or_default();
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
            let mut promotion_attempted = false;
            if engine.has_login_chrome().await
                && let Some(st) = engine.poll_login_chrome().await?
            {
                if st.exited || st.has_google_auth_cookies {
                    promotion_attempted = true;
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
                        "url": st.rejected_url.unwrap_or_else(|| FLOW_SSO_URL.to_string()),
                        "signedIn": false,
                    }));
                }
            }
            let session_saved = has_persisted_session();
            let mut page_ready = engine.has_page().await;
            if !promotion_attempted
                && !page_ready
                && session_saved
                && engine.ensure_page().await.is_ok()
            {
                ensure_flow_session_url(engine).await;
                page_ready = engine.has_page().await;
            }
            let signed_in = if page_ready {
                check_page_auth(engine, false)
                    .await
                    .get("signed_in")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            } else {
                false
            };
            let url = if page_ready {
                engine.current_url().await.unwrap_or_default()
            } else {
                String::new()
            };
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
