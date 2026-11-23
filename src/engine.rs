// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Chrome DevTools Protocol (CDP) browser engine backed by a persistent Chrome profile.

use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::{Mutex, MutexGuard, broadcast};

use crate::auth::is_signed_in_flow_url;
use crate::cdp::{CdpConnection, find_or_create_page_target, page_target_socket};
use crate::chrome::{LoginChrome, ManagedChrome, inspect_login_profile};
use crate::cookies::{
    NormalizedCookie, cookie_header_from_normalized, has_google_auth_cookies, normalize_cookies,
    read_cookies_file, write_cookies_file,
};

/// Browser engine identifier reported by status tools.
pub(crate) const ENGINE_NAME: &str = "chrome-cdp";

/// Compiled browser TypeScript runtime bundle exposing `window.__flowMcp`.
const FLOW_RUNTIME_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/flow_runtime.js"));

/// Default macOS Chrome `User-Agent` fallback before Chrome launches.
#[cfg(target_os = "macos")]
pub(crate) const DEFAULT_CHROME_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

/// Default Windows Chrome `User-Agent` fallback before Chrome launches.
#[cfg(target_os = "windows")]
pub(crate) const DEFAULT_CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

/// Default Linux Chrome `User-Agent` fallback before Chrome launches.
#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
pub(crate) const DEFAULT_CHROME_UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

/// HTTP network response captured from the active page via CDP `Network` events.
#[derive(Debug, Clone)]
pub(crate) struct NetworkResponseEvent {
    /// Request URL reported by Chrome.
    pub(crate) url: String,
    /// HTTP request method (for example `"GET"` or `"POST"`).
    pub(crate) method: String,
    /// HTTP response status code.
    pub(crate) status: u16,
    /// Optional truncated response body returned on HTTP error responses.
    pub(crate) error_excerpt: Option<String>,
}

/// Verifies that every optional file path exists on disk and points to a regular file.
pub(crate) async fn validate_local_files(paths: Option<&[String]>, label: &str) -> Result<()> {
    let Some(paths) = paths else {
        return Ok(());
    };
    for p in paths {
        let path = Path::new(p);
        if !tokio::fs::try_exists(path).await.unwrap_or(false) {
            anyhow::bail!("{} file does not exist: {}", label, p);
        }
        if tokio::fs::metadata(path)
            .await
            .map(|m| !m.is_file())
            .unwrap_or(false)
        {
            anyhow::bail!("{} path is not a file: {}", label, p);
        }
    }
    Ok(())
}

/// Active background Chrome process paired with its CDP connection.
struct ActiveChrome {
    /// Owned background Chrome process handle.
    managed: ManagedChrome,
    /// Open page CDP connection.
    cdp: Arc<CdpConnection>,
}

/// CDP connection to a separate page in the signed-in Chrome profile.
pub(crate) struct BackgroundPage {
    /// Connection to this page only.
    cdp: CdpConnection,
}

impl BackgroundPage {
    /// Returns true while the page connection is open.
    pub(crate) fn is_alive(&self) -> bool {
        self.cdp.is_alive()
    }

    /// Loads the URL in the background page.
    pub(crate) async fn navigate(&self, url: &str) -> Result<()> {
        let result = self.cdp.call("Page.navigate", json!({"url": url})).await?;
        if let Some(error) = result.get("errorText").and_then(Value::as_str) {
            anyhow::bail!("Chrome could not open the Agent page: {error}");
        }
        Ok(())
    }

    /// Calls a browser runtime method in this page.
    pub(crate) async fn call(&self, method: &str, args: Value) -> Result<Value> {
        self.call_with_timeout(method, args, Duration::from_secs(30))
            .await
    }

    /// Calls a browser runtime method with a specified time limit.
    pub(crate) async fn call_with_timeout(
        &self,
        method: &str,
        args: Value,
        timeout: Duration,
    ) -> Result<Value> {
        ChromeEngine::eval_flow_method_on(&self.cdp, method, args, true, timeout).await
    }

    /// Assigns local paths to the temporary file input in the Agent page.
    pub(crate) async fn stage_agent_files(&self, files: &[String]) -> Result<()> {
        set_local_files(&self.cdp, "window.__flowMcp.stageAgentFiles()", files).await
    }

    /// Binds the Agent runtime to the specified project page.
    pub(crate) async fn bind_agent(&self, project_id: &str) -> Result<bool> {
        let result = bind_browser_instances(
            &self.cdp,
            "window.__flowMcp?.agentPrototype()",
            "bindAgent",
            project_id,
        )
        .await?;
        Ok(result.and_then(|value| value.as_bool()).unwrap_or(false))
    }
}

/// Poll status reported for an open standard interactive Chrome sign-in window.
pub(crate) struct LoginPollStatus {
    /// True when the user closed the interactive Chrome process.
    pub(crate) exited: bool,
    /// Google Accounts rejection URL observed during sign-in, if any.
    pub(crate) rejected_url: Option<String>,
    /// Signed-in Google Flow URL observed during sign-in, if any.
    pub(crate) flow_url: Option<String>,
    /// True when Google authentication cookies exist in the login profile.
    pub(crate) has_google_auth_cookies: bool,
}

/// Manages the Chrome process and main page for one MCP server instance.
pub(crate) struct ChromeEngine {
    /// Active background Chrome process and page CDP connection.
    inner: Mutex<Option<ActiveChrome>>,
    /// Active visible Chrome process during interactive sign-in.
    login_chrome: Mutex<Option<LoginChrome>>,
    /// Serializes Chrome process launches, shutdowns, and session promotions.
    ensure_lock: Mutex<()>,
    /// Serializes direct project store operations.
    project_store_lock: Mutex<()>,
    /// True while a visible interactive sign-in window is open.
    visible: AtomicBool,
    /// Broadcast channel for captured CDP `Network` responses.
    network_tx: broadcast::Sender<NetworkResponseEvent>,
    /// Cached Chrome `User-Agent` string observed from `/json/version` or the active page.
    user_agent: Mutex<Option<String>>,
}

impl ChromeEngine {
    /// Creates a new [`ChromeEngine`] controller with no active browser process.
    pub(crate) fn new() -> Arc<Self> {
        let (network_tx, _) = broadcast::channel(512);
        Arc::new(Self {
            inner: Mutex::new(None),
            login_chrome: Mutex::new(None),
            ensure_lock: Mutex::new(()),
            project_store_lock: Mutex::new(()),
            visible: AtomicBool::new(false),
            network_tx,
            user_agent: Mutex::new(None),
        })
    }

    /// Gracefully stops active Chrome processes while keeping `<home>/chrome-profile` on disk.
    pub(crate) async fn shutdown(&self) {
        let _guard = self.ensure_lock.lock().await;
        *self.user_agent.lock().await = None;
        let active = {
            let mut inner = self.inner.lock().await;
            inner.take()
        };
        let login = {
            let mut login_guard = self.login_chrome.lock().await;
            login_guard.take()
        };
        if let Some(mc) = login {
            mc.shutdown().await;
        }
        if let Some(a) = active {
            flush_and_shutdown_active(a).await;
        }
        self.visible.store(false, Ordering::Release);
    }

    /// Returns `true` when a standard interactive Chrome sign-in window is active.
    pub(crate) async fn has_login_chrome(&self) -> bool {
        self.login_chrome.lock().await.is_some()
    }

    /// Launches a clean visible Chrome window without CDP flags for interactive Google Sign-In.
    pub(crate) async fn launch_interactive_login(&self, start_url: &str) -> Result<()> {
        let _ensure = self.ensure_lock.lock().await;
        let prev_active = {
            let mut inner = self.inner.lock().await;
            inner.take()
        };
        let prev_login = {
            let mut login = self.login_chrome.lock().await;
            login.take()
        };
        if let Some(old) = prev_active {
            flush_and_shutdown_active(old).await;
        }
        if let Some(old) = prev_login {
            old.shutdown().await;
        }

        self.visible.store(true, Ordering::Release);
        let login = LoginChrome::launch(start_url).await?;
        let mut guard = self.login_chrome.lock().await;
        *guard = Some(login);
        Ok(())
    }

    /// Polls interactive Chrome exit state and profile sign-in progress.
    pub(crate) async fn poll_login_chrome(&self) -> Result<Option<LoginPollStatus>> {
        let (exited, profile_dir, started_at) = {
            let mut guard = self.login_chrome.lock().await;
            let Some(lc) = guard.as_mut() else {
                return Ok(None);
            };
            (lc.try_exited()?, lc.profile_dir.clone(), lc.started_at)
        };

        let probe = inspect_login_profile(&profile_dir, started_at).await;
        Ok(Some(LoginPollStatus {
            exited,
            rejected_url: probe.rejected_url,
            flow_url: probe.flow_url,
            has_google_auth_cookies: probe.has_google_auth_cookies,
        }))
    }

    /// Stops interactive Chrome to flush `<home>/chrome-profile` and starts background CDP Chrome on it.
    pub(crate) async fn promote_login_chrome(&self, start_url: &str) -> Result<()> {
        let _ensure = self.ensure_lock.lock().await;
        let stale = {
            let mut inner = self.inner.lock().await;
            inner.take()
        };
        if let Some(old) = stale {
            flush_and_shutdown_active(old).await;
        }

        let lc = {
            let mut login = self.login_chrome.lock().await;
            login
                .take()
                .ok_or_else(|| anyhow::anyhow!("No active interactive Chrome sign-in window"))?
        };

        lc.shutdown().await;
        self.visible.store(false, Ordering::Release);
        let managed = ManagedChrome::launch(start_url).await?;
        let active = self.connect_managed_chrome(managed).await?;

        let mut inner = self.inner.lock().await;
        *inner = Some(active);
        Ok(())
    }

    /// Connects to a page target on `managed` or shuts down `managed` if connection fails.
    async fn connect_managed_chrome(&self, managed: ManagedChrome) -> Result<ActiveChrome> {
        let ws_url = match find_or_create_page_target(&managed.http_endpoint).await {
            Ok(v) => v,
            Err(err) => {
                managed.shutdown().await;
                return Err(err);
            }
        };
        let cdp = match CdpConnection::connect_page(&ws_url, self.network_tx.clone()).await {
            Ok(conn) => Arc::new(conn),
            Err(err) => {
                managed.shutdown().await;
                return Err(err);
            }
        };

        if !managed.user_agent.is_empty() {
            *self.user_agent.lock().await = Some(managed.user_agent.clone());
        }
        Ok(ActiveChrome { managed, cdp })
    }

    /// Returns `true` when an active Chrome page CDP connection is open.
    pub(crate) async fn has_page(&self) -> bool {
        let inner = self.inner.lock().await;
        inner.as_ref().is_some_and(|a| a.cdp.is_alive())
    }

    /// Returns `true` when the interactive Chrome sign-in window is active.
    pub(crate) fn is_window_visible(&self) -> bool {
        self.visible.load(Ordering::Acquire)
    }

    /// Returns the local HTTP CDP endpoint URL if Chrome is running.
    pub(crate) async fn cdp_endpoint(&self) -> Option<String> {
        let inner = self.inner.lock().await;
        inner
            .as_ref()
            .filter(|a| a.cdp.is_alive())
            .map(|a| a.managed.http_endpoint.clone())
    }

    /// Ensures a live background Chrome CDP page exists and seeds cookies from `cookies.json` only when the profile lacks Google auth cookies.
    pub(crate) async fn ensure_page(&self) -> Result<()> {
        let _ensure = self.ensure_lock.lock().await;
        let stale = {
            let mut inner = self.inner.lock().await;
            match inner.as_ref() {
                Some(a) if a.cdp.is_alive() => return Ok(()),
                Some(_) => inner.take(),
                None => None,
            }
        };
        let login = {
            let mut login_guard = self.login_chrome.lock().await;
            login_guard.take()
        };
        if let Some(old) = stale {
            flush_and_shutdown_active(old).await;
        }
        if let Some(lc) = login {
            lc.shutdown().await;
        }
        self.visible.store(false, Ordering::Release);

        let managed = ManagedChrome::launch("about:blank").await?;
        let active = self.connect_managed_chrome(managed).await?;

        let existing_cookies = fetch_cdp_cookies(&active.cdp).await.unwrap_or_default();
        if !has_google_auth_cookies(&existing_cookies) {
            let saved_cookies = read_cookies_file().unwrap_or_default();
            let cdp_cookies: Vec<Value> = saved_cookies
                .iter()
                .filter_map(NormalizedCookie::to_cdp_cookie_param)
                .collect();
            apply_cdp_cookies(&active.cdp, &cdp_cookies).await;
        }

        let mut inner = self.inner.lock().await;
        *inner = Some(active);
        Ok(())
    }

    /// Returns the active page CDP connection, launching background Chrome if necessary.
    async fn active_cdp(&self) -> Result<Arc<CdpConnection>> {
        self.ensure_page().await?;
        let inner = self.inner.lock().await;
        inner
            .as_ref()
            .map(|a| Arc::clone(&a.cdp))
            .ok_or_else(|| anyhow::anyhow!("Chrome page target unavailable"))
    }

    /// Sends one raw CDP command to the active page and returns its result.
    pub(crate) async fn cdp_call(&self, method: &str, params: Value) -> Result<Value> {
        let cdp = self.active_cdp().await?;
        cdp.call(method, params).await
    }

    /// Opens a new page in the managed Chrome profile.
    pub(crate) async fn open_background_page(&self) -> Result<BackgroundPage> {
        let cdp = self.active_cdp().await?;
        let endpoint = self
            .cdp_endpoint()
            .await
            .context("Chrome endpoint unavailable")?;
        let target = cdp
            .call(
                "Target.createTarget",
                json!({"url": "about:blank", "background": true}),
            )
            .await?;
        let id = target["targetId"]
            .as_str()
            .context("Chrome did not return a target ID")?;
        let result = async {
            let socket = page_target_socket(&endpoint, id).await?;
            let (network_tx, _) = broadcast::channel(16);
            Ok(BackgroundPage {
                cdp: CdpConnection::connect_page(&socket, network_tx).await?,
            })
        }
        .await;
        if result.is_err() {
            let _ = cdp
                .call("Target.closeTarget", json!({"targetId": id}))
                .await;
        }
        result
    }

    /// Locks the direct project store until the current operation ends.
    pub(crate) async fn lock_project_store(&self) -> MutexGuard<'_, ()> {
        self.project_store_lock.lock().await
    }

    /// Tries to lock the project store without waiting for a write to finish.
    pub(crate) fn try_lock_project_store(&self) -> Option<MutexGuard<'_, ()>> {
        self.project_store_lock.try_lock().ok()
    }

    /// Passes live Map objects to the project store binder in the same JavaScript context.
    pub(crate) async fn bind_project_store(&self, project_id: &str) -> Result<Value> {
        let cdp = self.active_cdp().await?;
        let project_id = project_id.to_owned();
        tokio::spawn(async move {
            bind_browser_instances(&cdp, "Map.prototype", "bindProjectStore", &project_id)
                .await?
                .context("Chrome did not return the Map prototype")
        })
        .await
        .context("The project store search did not finish")?
    }

    /// Finds the Angular view registry for the specified host in the active page.
    pub(crate) async fn bind_angular_views(&self, selector: &str) -> Result<bool> {
        let cdp = self.active_cdp().await?;
        let selector = selector.to_owned();
        tokio::spawn(async move {
            let result =
                bind_browser_instances(&cdp, "Map.prototype", "bindAngularViews", &selector)
                    .await?;
            Ok(result.and_then(|value| value.as_bool()) == Some(true))
        })
        .await
        .context("The Angular view search did not finish")?
    }

    /// Returns the Flow front-end build label that the active page publishes, or `None` when it is unavailable.
    pub(crate) async fn build_label(&self) -> Option<String> {
        let value = self.call_flow_js("buildLabel", json!([])).await.ok()?;
        value.as_str().map(str::to_string)
    }

    /// Navigates the active page to `url` and waits until the document becomes interactive.
    pub(crate) async fn navigate(&self, url: &str) -> Result<()> {
        let cdp = self.active_cdp().await?;
        cdp.call("Page.navigate", json!({ "url": url })).await?;
        for _ in 0..80 {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let state = eval_runtime(&cdp, "document.readyState", false, Duration::from_secs(5))
                .await
                .unwrap_or(Value::Null);
            if matches!(state.as_str(), Some("complete") | Some("interactive")) {
                if state.as_str() == Some("complete") {
                    tokio::time::sleep(Duration::from_millis(350)).await;
                }
                break;
            }
        }
        Ok(())
    }

    /// Returns the current page URL, or an empty string if Chrome has not started.
    pub(crate) async fn current_url(&self) -> Result<String> {
        let cdp = {
            let inner = self.inner.lock().await;
            let Some(a) = inner.as_ref().filter(|a| a.cdp.is_alive()) else {
                return Ok(String::new());
            };
            Arc::clone(&a.cdp)
        };
        let val =
            eval_runtime(&cdp, "window.location.href", false, Duration::from_secs(10)).await?;
        Ok(val.as_str().unwrap_or("").to_string())
    }

    /// Evaluates a synchronous JavaScript expression in the active page.
    async fn eval_js(&self, expr: &str) -> Result<Value> {
        let cdp = self.active_cdp().await?;
        eval_runtime(&cdp, expr, false, Duration::from_secs(30)).await
    }

    /// Calls a synchronous method on `window.__flowMcp`, installing the runtime bundle on demand.
    pub(crate) async fn call_flow_js(&self, method: &str, args: Value) -> Result<Value> {
        self.eval_flow_method(method, args, false, Duration::from_secs(30))
            .await
    }

    /// Calls an asynchronous method on `window.__flowMcp`, installing the runtime bundle on demand.
    pub(crate) async fn call_flow_async(&self, method: &str, args: Value) -> Result<Value> {
        self.eval_flow_method(method, args, true, Duration::from_secs(120))
            .await
    }

    /// Invokes `window.__flowMcp[method](...args)` in one round-trip when installed, or injects the bundle first.
    async fn eval_flow_method(
        &self,
        method: &str,
        args: Value,
        await_promise: bool,
        timeout: Duration,
    ) -> Result<Value> {
        let cdp = self.active_cdp().await?;
        Self::eval_flow_method_on(&cdp, method, args, await_promise, timeout).await
    }

    /// Invokes a runtime method in the specified Chrome page.
    async fn eval_flow_method_on(
        cdp: &CdpConnection,
        method: &str,
        args: Value,
        await_promise: bool,
        timeout: Duration,
    ) -> Result<Value> {
        anyhow::ensure!(
            args.is_array(),
            "Flow runtime arguments for '{}' must be a JSON array",
            method
        );
        let method_json = serde_json::to_string(method)?;
        let args_json = serde_json::to_string(&args)?;
        let call_expr = if await_promise {
            format!("await rt[{method_json}](...{args_json})")
        } else {
            format!("rt[{method_json}](...{args_json})")
        };
        let probe_expr = if await_promise {
            format!(
                "(async () => {{ const rt = window.__flowMcp; if (!rt || typeof rt[{method_json}] !== \"function\") return {{ __flowMcpHit: false }}; return {{ __flowMcpHit: true, value: {call_expr} }}; }})()"
            )
        } else {
            format!(
                "(() => {{ const rt = window.__flowMcp; if (!rt || typeof rt[{method_json}] !== \"function\") return {{ __flowMcpHit: false }}; return {{ __flowMcpHit: true, value: {call_expr} }}; }})()"
            )
        };

        let probe = eval_runtime(cdp, &probe_expr, await_promise, timeout).await?;
        if probe.get("__flowMcpHit").and_then(Value::as_bool) == Some(true) {
            return Ok(probe.get("value").cloned().unwrap_or(Value::Null));
        }

        eval_runtime(cdp, FLOW_RUNTIME_JS, false, Duration::from_secs(30)).await?;
        let direct_expr = if await_promise {
            format!("(async () => await window.__flowMcp[{method_json}](...{args_json}))()")
        } else {
            format!("window.__flowMcp[{method_json}](...{args_json})")
        };
        eval_runtime(cdp, &direct_expr, await_promise, timeout).await
    }

    /// Dispatches a trusted CDP mouse move event at viewport coordinates `(x, y)`.
    pub(crate) async fn mouse_move(&self, x: f64, y: f64) -> Result<()> {
        let cdp = self.active_cdp().await?;
        dispatch_mouse_moved(&cdp, x, y).await
    }

    /// Dispatches a trusted CDP left mouse click sequence at viewport coordinates `(x, y)`.
    pub(crate) async fn mouse_click(&self, x: f64, y: f64) -> Result<()> {
        let cdp = self.active_cdp().await?;
        dispatch_mouse_moved(&cdp, x, y).await?;
        tokio::time::sleep(Duration::from_millis(25)).await;
        cdp.call(
            "Input.dispatchMouseEvent",
            json!({
                "type": "mousePressed",
                "x": x,
                "y": y,
                "button": "left",
                "buttons": 1,
                "clickCount": 1,
                "pointerType": "mouse",
            }),
        )
        .await?;
        tokio::time::sleep(Duration::from_millis(35)).await;
        cdp.call(
            "Input.dispatchMouseEvent",
            json!({
                "type": "mouseReleased",
                "x": x,
                "y": y,
                "button": "left",
                "buttons": 0,
                "clickCount": 1,
                "pointerType": "mouse",
            }),
        )
        .await?;
        Ok(())
    }

    /// Dispatches a trusted CDP left click when `point` contains numeric `x` and `y` coordinates.
    pub(crate) async fn click_point(&self, point: &Value) -> Result<bool> {
        let (Some(x), Some(y)) = (
            point.get("x").and_then(|v| v.as_f64()),
            point.get("y").and_then(|v| v.as_f64()),
        ) else {
            return Ok(false);
        };
        self.mouse_click(x, y).await?;
        tokio::time::sleep(Duration::from_millis(300)).await;
        Ok(true)
    }

    /// Assigns local `files` to the `<input>` element matching `selector` through CDP `DOM.setFileInputFiles`.
    pub(crate) async fn upload_files(&self, selector: &str, files: &[String]) -> Result<()> {
        let sel_json = serde_json::to_string(selector)?;
        let query_expr = format!("document.querySelector({})", sel_json);
        self.upload_files_to(&query_expr, files).await
    }

    /// Assigns local `files` to the `<input>` element that the JavaScript expression `query_expr` returns.
    pub(crate) async fn upload_files_to(&self, query_expr: &str, files: &[String]) -> Result<()> {
        let cdp = self.active_cdp().await?;
        set_local_files(&cdp, query_expr, files).await
    }

    /// Subscribes to CDP network response events captured from the active page.
    pub(crate) async fn subscribe_network(
        &self,
    ) -> Result<broadcast::Receiver<NetworkResponseEvent>> {
        self.ensure_page().await?;
        Ok(self.network_tx.subscribe())
    }

    /// Imports raw CDP cookie JSON objects into Chrome and writes Google/Flow cookies to `cookies.json`.
    pub(crate) async fn import_cookies(&self, cookies: Vec<Value>) -> Result<usize> {
        self.ensure_page().await?;
        let normalized = normalize_cookies(cookies);
        let cdp_cookies: Vec<Value> = normalized
            .iter()
            .filter_map(NormalizedCookie::to_cdp_cookie_param)
            .collect();
        let count = cdp_cookies.len();

        let cdp = self.active_cdp().await?;
        apply_cdp_cookies(&cdp, &cdp_cookies).await;
        write_cookies_file(&normalized)?;
        Ok(count)
    }

    /// Saves current Chrome Google and Flow domain cookies to `cookies.json` (`0600`).
    pub(crate) async fn save_cookies(&self) -> Result<usize> {
        let persisted = self.flow_cookies().await?;
        write_cookies_file(&persisted)?;
        Ok(persisted.len())
    }

    /// Returns the Chrome `User-Agent` string or the platform Chrome fallback.
    pub(crate) async fn user_agent(&self) -> String {
        if let Some(ua) = self.user_agent.lock().await.clone() {
            return ua;
        }
        if let Ok(val) = self.eval_js("navigator.userAgent").await
            && let Some(ua) = val.as_str().map(str::trim).filter(|s| !s.is_empty())
        {
            let s = ua.to_string();
            *self.user_agent.lock().await = Some(s.clone());
            return s;
        }
        DEFAULT_CHROME_UA.to_string()
    }

    /// Builds a `Cookie` header matching `target_url` from Chrome cookies or `cookies.json`.
    pub(crate) async fn cookie_header_for_url(&self, target_url: &str) -> Option<String> {
        let cookies = if self.has_page().await {
            match self.all_normalized_cookies().await {
                Ok(c) if !c.is_empty() => c,
                _ => read_cookies_file().ok()?,
            }
        } else {
            read_cookies_file().ok()?
        };
        cookie_header_from_normalized(&cookies, target_url)
            .ok()
            .filter(|s| !s.is_empty())
    }

    /// Returns normalized cookies for Google and Flow domains from Chrome or `cookies.json`.
    pub(crate) async fn flow_cookies(&self) -> Result<Vec<NormalizedCookie>> {
        if self.has_page().await {
            self.all_normalized_cookies().await
        } else {
            read_cookies_file()
        }
    }

    /// Stops Chrome processes and deletes `<home>/chrome-profile`.
    pub(crate) async fn clear_session(&self) -> Result<()> {
        let _guard = self.ensure_lock.lock().await;
        *self.user_agent.lock().await = None;
        let login = {
            let mut login_guard = self.login_chrome.lock().await;
            login_guard.take()
        };
        let active = {
            let mut inner = self.inner.lock().await;
            inner.take()
        };
        if let Some(mc) = login {
            mc.shutdown().await;
        }
        if let Some(old) = active {
            drop(old.cdp);
            old.managed.shutdown().await;
        }
        self.visible.store(false, Ordering::Release);
        let _ = tokio::fs::remove_dir_all(crate::config::chrome_profile_dir()).await;
        Ok(())
    }

    /// Reads normalized cookies directly from the active Chrome CDP connection.
    async fn all_normalized_cookies(&self) -> Result<Vec<NormalizedCookie>> {
        let cdp = self.active_cdp().await?;
        fetch_cdp_cookies(&cdp).await
    }
}

/// Fetches browser cookies over CDP and filters them to Google and Flow domains.
async fn fetch_cdp_cookies(cdp: &CdpConnection) -> Result<Vec<NormalizedCookie>> {
    let res = match cdp.call("Storage.getCookies", json!({})).await {
        Ok(v) => v,
        Err(_) => cdp.call("Network.getAllCookies", json!({})).await?,
    };
    let raw = res
        .get("cookies")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(normalize_cookies(raw))
}

/// Applies normalized CDP `CookieParam` objects via `Network.setCookies` or `Network.setCookie`.
async fn apply_cdp_cookies(cdp: &CdpConnection, cookies: &[Value]) {
    if cookies.is_empty() {
        return;
    }
    if cdp
        .call("Network.setCookies", json!({ "cookies": cookies }))
        .await
        .is_ok()
    {
        return;
    }
    for cookie in cookies {
        let _ = cdp.call("Network.setCookie", cookie.clone()).await;
    }
}

/// Saves fresh cookies when shutting down a signed-in Chrome session and stops the child process.
async fn flush_and_shutdown_active(a: ActiveChrome) {
    if a.cdp.is_alive()
        && let Ok(val) = eval_runtime(
            &a.cdp,
            "window.location.href",
            false,
            Duration::from_secs(3),
        )
        .await
        && val.as_str().is_some_and(is_signed_in_flow_url)
        && let Ok(persisted) = fetch_cdp_cookies(&a.cdp).await
        && has_google_auth_cookies(&persisted)
    {
        let _ = write_cookies_file(&persisted);
    }
    drop(a.cdp);
    a.managed.shutdown().await;
}

/// Dispatches a CDP `mouseMoved` event on `cdp` at viewport coordinates `(x, y)`.
async fn dispatch_mouse_moved(cdp: &CdpConnection, x: f64, y: f64) -> Result<()> {
    cdp.call(
        "Input.dispatchMouseEvent",
        json!({
            "type": "mouseMoved",
            "x": x,
            "y": y,
            "pointerType": "mouse",
        }),
    )
    .await?;
    Ok(())
}

/// Finds the file input that the expression returns and assigns the local files.
async fn set_local_files(cdp: &CdpConnection, query_expr: &str, files: &[String]) -> Result<()> {
    let group = format!("flow-file-input-{}", uuid::Uuid::new_v4());
    let assignment = async {
        let mut object_id: Option<String> = None;
        for _ in 0..20 {
            let res = cdp
                .call(
                    "Runtime.evaluate",
                    json!({
                        "expression": query_expr,
                        "returnByValue": false,
                        "objectGroup": group,
                    }),
                )
                .await?;
            if let Some(oid) = res.pointer("/result/objectId").and_then(|v| v.as_str()) {
                object_id = Some(oid.to_string());
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        let Some(object_id) = object_id else {
            anyhow::bail!("File input element not found for: {}", query_expr);
        };

        cdp.call(
            "DOM.setFileInputFiles",
            json!({
                "objectId": object_id,
                "files": files,
            }),
        )
        .await?;
        Ok(())
    }
    .await;
    let released = cdp
        .call("Runtime.releaseObjectGroup", json!({"objectGroup": group}))
        .await;
    assignment?;
    released?;
    tokio::time::sleep(Duration::from_millis(250)).await;
    Ok(())
}

/// Evaluates `expr` via CDP `Runtime.evaluate` and propagates JavaScript exception messages.
async fn eval_runtime(
    cdp: &CdpConnection,
    expr: &str,
    await_promise: bool,
    timeout: Duration,
) -> Result<Value> {
    let res = cdp
        .call_with_timeout(
            "Runtime.evaluate",
            json!({
                "expression": expr,
                "returnByValue": true,
                "awaitPromise": await_promise,
            }),
            timeout,
        )
        .await?;
    runtime_value(&res)
}

/// Returns the JavaScript value or exception from a CDP runtime response.
fn runtime_value(res: &Value) -> Result<Value> {
    if let Some(details) = res.get("exceptionDetails") {
        let msg = details
            .pointer("/exception/description")
            .or_else(|| details.pointer("/exception/value"))
            .or_else(|| details.get("text"))
            .and_then(|v| v.as_str())
            .unwrap_or("JavaScript evaluation exception");
        anyhow::bail!("JavaScript error: {}", msg);
    }

    Ok(res.pointer("/result/value").cloned().unwrap_or(Value::Null))
}

/// Removes the success flag or returns the error code and details from the page.
pub(crate) fn checked_runtime_result(mut result: Value) -> Result<Value> {
    let fields = result
        .as_object_mut()
        .context("The browser runtime did not return a result")?;
    if fields.remove("ok").and_then(|value| value.as_bool()) == Some(true) {
        return Ok(result);
    }
    let error = fields
        .remove("error")
        .context("The browser runtime did not return an error code")?;
    let error = error
        .as_str()
        .context("The browser runtime returned an invalid error code")?;
    if fields.is_empty() {
        anyhow::bail!("{error}");
    }
    anyhow::bail!("{error} {result}");
}

/// Queries live browser instances and passes them to the specified runtime binder.
async fn bind_browser_instances(
    cdp: &CdpConnection,
    prototype_expression: &str,
    binder: &str,
    context: &str,
) -> Result<Option<Value>> {
    let group = format!("flow-bind-{}", uuid::Uuid::new_v4());
    let result = async {
        let prototype = cdp
            .call(
                "Runtime.evaluate",
                json!({ "expression": prototype_expression, "objectGroup": group }),
            )
            .await?;
        let Some(prototype_id) = prototype.pointer("/result/objectId").and_then(Value::as_str) else {
            runtime_value(&prototype)?;
            return Ok(None);
        };
        let instances = cdp
            .call(
                "Runtime.queryObjects",
                json!({ "prototypeObjectId": prototype_id, "objectGroup": group }),
            )
            .await?;
        let id = instances.pointer("/objects/objectId").and_then(Value::as_str)
            .context("Chrome did not return any objects for the binder")?;
        let result = cdp
            .call(
                "Runtime.callFunctionOn",
                json!({
                    "objectId": id,
                    "functionDeclaration": "function (method, context) { return window.__flowMcp?.[method](this, context); }",
                    "arguments": [{"value": binder}, {"value": context}],
                    "returnByValue": true,
                }),
            )
            .await?;
        runtime_value(&result).map(Some)
    }.await;
    let released = cdp
        .call("Runtime.releaseObjectGroup", json!({"objectGroup": group}))
        .await;
    let value = result?;
    released?;
    Ok(value)
}
