// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Chrome DevTools Protocol (CDP) browser engine backed by a persistent Chrome profile.

use anyhow::Result;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::{Mutex, broadcast};

use crate::auth::is_signed_in_flow_url;
use crate::cdp::{CdpConnection, find_or_create_page_target};
use crate::chrome::{LoginChrome, ManagedChrome, inspect_login_profile};
use crate::cookies::{
    NormalizedCookie, has_google_auth_cookies, normalize_cookies, read_cookies_file,
    write_cookies_file,
};

/// Browser engine identifier reported by status tools.
pub(crate) const ENGINE_NAME: &str = "chrome-cdp";

/// Compiled browser TypeScript runtime bundle exposing `window.__flowMcp`.
const FLOW_RUNTIME_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/flow_runtime.js"));

/// HTTP network response captured from the active page via CDP `Network` events.
#[derive(Debug, Clone)]
pub(crate) struct NetworkResponseEvent {
    /// Request URL reported by Chrome.
    pub(crate) url: String,
    /// HTTP response status code.
    pub(crate) status: u16,
}

/// Active headless Chrome process paired with its CDP connection.
struct ActiveChrome {
    /// Owned headless Chrome process handle.
    managed: ManagedChrome,
    /// Open page CDP connection.
    cdp: Arc<CdpConnection>,
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

/// Manages one Chrome process and page CDP session per MCP server instance.
pub(crate) struct ChromeEngine {
    /// Active headless Chrome process and page CDP connection.
    inner: Mutex<Option<ActiveChrome>>,
    /// Active visible Chrome process during interactive sign-in.
    login_chrome: Mutex<Option<LoginChrome>>,
    /// Serializes Chrome process launches, shutdowns, and session promotions.
    ensure_lock: Mutex<()>,
    /// True while a visible interactive sign-in window is open.
    visible: AtomicBool,
    /// Broadcast channel for captured CDP `Network` responses.
    network_tx: broadcast::Sender<NetworkResponseEvent>,
}

impl ChromeEngine {
    /// Creates a new [`ChromeEngine`] controller with no active browser process.
    pub(crate) fn new() -> Arc<Self> {
        let (network_tx, _) = broadcast::channel(512);
        Arc::new(Self {
            inner: Mutex::new(None),
            login_chrome: Mutex::new(None),
            ensure_lock: Mutex::new(()),
            visible: AtomicBool::new(false),
            network_tx,
        })
    }

    /// Gracefully stops active Chrome processes while keeping `<home>/chrome-profile` on disk.
    pub(crate) async fn shutdown(&self) {
        let _guard = self.ensure_lock.lock().await;
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

    /// Stops interactive Chrome to flush `<home>/chrome-profile` and starts headless CDP Chrome on it.
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

    /// Ensures a live headless Chrome CDP page exists and seeds cookies from `cookies.json` only when the profile lacks Google auth cookies.
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

    /// Returns the active page CDP connection, launching headless Chrome if necessary.
    async fn active_cdp(&self) -> Result<Arc<CdpConnection>> {
        self.ensure_page().await?;
        let inner = self.inner.lock().await;
        inner
            .as_ref()
            .map(|a| Arc::clone(&a.cdp))
            .ok_or_else(|| anyhow::anyhow!("Chrome page target unavailable"))
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

        let cdp = self.active_cdp().await?;
        let probe = eval_runtime(&cdp, &probe_expr, await_promise, timeout).await?;
        if probe.get("__flowMcpHit").and_then(Value::as_bool) == Some(true) {
            return Ok(probe.get("value").cloned().unwrap_or(Value::Null));
        }

        eval_runtime(&cdp, FLOW_RUNTIME_JS, false, Duration::from_secs(30)).await?;
        let direct_expr = if await_promise {
            format!("(async () => await window.__flowMcp[{method_json}](...{args_json}))()")
        } else {
            format!("window.__flowMcp[{method_json}](...{args_json})")
        };
        eval_runtime(&cdp, &direct_expr, await_promise, timeout).await
    }

    /// Dispatches a trusted CDP mouse move event at viewport coordinates `(x, y)`.
    pub(crate) async fn mouse_move(&self, x: f64, y: f64) -> Result<()> {
        let cdp = self.active_cdp().await?;
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
