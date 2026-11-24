// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Chrome DevTools Protocol (CDP) WebSocket client and local HTTP target discovery.

use anyhow::{Context, Result};
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;
use tokio::sync::{Mutex, broadcast, oneshot};
use tokio_tungstenite::tungstenite::Message;

use crate::engine::NetworkResponseEvent;

/// Error object returned inside a CDP JSON-RPC response frame.
#[derive(Debug, Deserialize)]
struct CdpError {
    /// Human-readable CDP failure description.
    message: Option<String>,
}

/// Incoming JSON frame received from Chrome over the CDP WebSocket.
#[derive(Debug, Deserialize)]
struct CdpInbound {
    /// Request identifier for command replies.
    id: Option<u64>,
    /// Result payload when a CDP command succeeds.
    result: Option<Value>,
    /// Error payload when a CDP command fails.
    error: Option<CdpError>,
    /// Event method name when the frame is an asynchronous CDP event.
    method: Option<String>,
    /// Event parameter payload for asynchronous CDP events.
    params: Option<Value>,
}

/// Map of in-flight CDP command waiters and closed state.
struct PendingState {
    /// True once the WebSocket reader loop stops.
    closed: bool,
    /// Pending reply channels keyed by CDP command `id`.
    waiters: HashMap<u64, oneshot::Sender<Result<Value>>>,
}

/// Drop guard that removes a pending CDP waiter when a call cancels or times out.
struct PendingGuard<'a> {
    /// Shared pending waiter map.
    pending: &'a std::sync::Mutex<PendingState>,
    /// Command identifier owned by this call.
    id: u64,
    /// True while cleanup on drop remains active.
    armed: bool,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        if self.armed
            && let Ok(mut guard) = self.pending.lock()
        {
            guard.waiters.remove(&self.id);
        }
    }
}

/// WebSocket sink type used to send CDP JSON commands.
type WsSink = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;

/// Shared WebSocket transport state for one CDP connection.
struct CdpTransport {
    /// Serialized outbound WebSocket sink.
    sink: Mutex<WsSink>,
    /// In-flight command response channels.
    pending: std::sync::Mutex<PendingState>,
    /// Monotonic CDP command ID generator.
    next_id: AtomicU64,
    /// True while the background WebSocket reader task is alive.
    alive: AtomicBool,
}

impl CdpTransport {
    /// Marks the transport closed and fails all pending command waiters.
    fn mark_closed(&self) {
        self.alive.store(false, Ordering::Release);
        if let Ok(mut guard) = self.pending.lock() {
            guard.closed = true;
            for (_, tx) in guard.waiters.drain() {
                let _ = tx.send(Err(anyhow::anyhow!("Chrome CDP connection closed")));
            }
        }
    }

    /// Sends one CDP command and waits up to `timeout` for its reply frame.
    async fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self
                .pending
                .lock()
                .map_err(|_| anyhow::anyhow!("CDP waiter state lock poisoned"))?;
            if guard.closed {
                anyhow::bail!("Chrome CDP connection closed");
            }
            guard.waiters.insert(id, tx);
        }

        let mut pending_guard = PendingGuard {
            pending: &self.pending,
            id,
            armed: true,
        };

        let payload = json!({
            "id": id,
            "method": method,
            "params": params,
        });

        {
            let mut sink = self.sink.lock().await;
            sink.send(Message::Text(payload.to_string().into()))
                .await
                .with_context(|| format!("Failed to send CDP command {}", method))?;
        }

        let reply = tokio::time::timeout(timeout, rx)
            .await
            .with_context(|| format!("Timed out waiting for CDP command {}", method))?
            .with_context(|| format!("Chrome CDP closed during {}", method))?;
        pending_guard.armed = false;
        reply
    }
}

/// WebSocket CDP client for one Chrome target.
pub(crate) struct CdpConnection {
    /// Shared WebSocket transport.
    transport: Arc<CdpTransport>,
    /// Background task reading inbound CDP frames.
    reader_handle: tokio::task::JoinHandle<()>,
}

impl Drop for CdpConnection {
    fn drop(&mut self) {
        self.transport.mark_closed();
        self.reader_handle.abort();
    }
}

impl CdpConnection {
    /// Connects to `ws_url` and enables `Page`, `Runtime`, `DOM`, and `Network` domains.
    pub(crate) async fn connect_page(
        ws_url: &str,
        network_tx: broadcast::Sender<NetworkResponseEvent>,
    ) -> Result<Self> {
        let conn = Self::connect_raw(ws_url, Some(network_tx)).await?;
        conn.call("Page.enable", json!({})).await?;
        conn.call("Runtime.enable", json!({})).await?;
        conn.call("DOM.enable", json!({})).await?;
        conn.call("Network.enable", json!({})).await?;
        Ok(conn)
    }

    /// Connects to `ws_url` without enabling page domains.
    pub(crate) async fn connect_basic(ws_url: &str) -> Result<Self> {
        Self::connect_raw(ws_url, None).await
    }

    /// Opens the WebSocket connection and spawns the inbound frame dispatcher task.
    async fn connect_raw(
        ws_url: &str,
        network_tx: Option<broadcast::Sender<NetworkResponseEvent>>,
    ) -> Result<Self> {
        let (ws_stream, _) = tokio::time::timeout(
            Duration::from_secs(10),
            tokio_tungstenite::connect_async(ws_url),
        )
        .await
        .with_context(|| format!("Timed out connecting to Chrome CDP WebSocket at {}", ws_url))?
        .with_context(|| format!("Failed to connect to Chrome CDP WebSocket at {}", ws_url))?;

        let (sink, mut stream) = ws_stream.split();
        let transport = Arc::new(CdpTransport {
            sink: Mutex::new(sink),
            pending: std::sync::Mutex::new(PendingState {
                closed: false,
                waiters: HashMap::new(),
            }),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
        });

        let weak_transport: Weak<CdpTransport> = Arc::downgrade(&transport);
        let reader_handle = tokio::spawn(async move {
            let mut req_methods: HashMap<String, String> = HashMap::new();
            let mut pending_bodies: HashMap<String, (String, String, u16)> = HashMap::new();

            while let Some(msg_res) = stream.next().await {
                let Ok(msg) = msg_res else {
                    break;
                };
                let text = match msg {
                    Message::Text(t) => t.to_string(),
                    Message::Binary(b) => match String::from_utf8(b.to_vec()) {
                        Ok(s) => s,
                        Err(_) => continue,
                    },
                    Message::Close(_) => break,
                    _ => continue,
                };
                let Ok(frame) = serde_json::from_str::<CdpInbound>(&text) else {
                    continue;
                };

                if let Some(id) = frame.id {
                    if let Some(t) = weak_transport.upgrade() {
                        let waiter = t
                            .pending
                            .lock()
                            .ok()
                            .and_then(|mut g| g.waiters.remove(&id));
                        if let Some(tx) = waiter {
                            if let Some(err) = frame.error {
                                let msg = err.message.as_deref().unwrap_or("Chrome CDP error");
                                let _ = tx.send(Err(anyhow::anyhow!("Chrome CDP error: {}", msg)));
                            } else {
                                let _ = tx.send(Ok(frame.result.unwrap_or(Value::Null)));
                            }
                        }
                    }
                    continue;
                }

                let Some(method) = frame.method.as_deref() else {
                    continue;
                };
                if method == "Page.javascriptDialogOpening" {
                    if let Some(t) = weak_transport.upgrade() {
                        tokio::spawn(async move {
                            let _ = t
                                .call(
                                    "Page.handleJavaScriptDialog",
                                    json!({ "accept": true }),
                                    Duration::from_secs(5),
                                )
                                .await;
                        });
                    }
                    continue;
                }

                let Some(tx) = network_tx.as_ref() else {
                    continue;
                };
                handle_network_event(
                    method,
                    frame.params.as_ref(),
                    &mut req_methods,
                    &mut pending_bodies,
                    &weak_transport,
                    tx,
                );
            }

            if let Some(t) = weak_transport.upgrade() {
                t.mark_closed();
            }
        });

        Ok(Self {
            transport,
            reader_handle,
        })
    }

    /// Returns `true` when the WebSocket loop is still active.
    pub(crate) fn is_alive(&self) -> bool {
        self.transport.alive.load(Ordering::Acquire)
    }

    /// Sends one CDP command and awaits its result with a 30-second timeout.
    pub(crate) async fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.call_with_timeout(method, params, Duration::from_secs(30))
            .await
    }

    /// Sends one CDP command and awaits its result with a custom timeout.
    pub(crate) async fn call_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        self.transport.call(method, params, timeout).await
    }
}

/// Processes CDP `Network.*` events and publishes request methods, status codes, and error excerpts.
fn handle_network_event(
    method: &str,
    params: Option<&Value>,
    req_methods: &mut HashMap<String, String>,
    pending_bodies: &mut HashMap<String, (String, String, u16)>,
    weak_transport: &Weak<CdpTransport>,
    network_tx: &broadcast::Sender<NetworkResponseEvent>,
) {
    let Some(p) = params else {
        return;
    };
    let Some(req_id) = p.get("requestId").and_then(|v| v.as_str()) else {
        return;
    };

    match method {
        "Network.requestWillBeSent" => {
            let req_method = p
                .pointer("/request/method")
                .and_then(|v| v.as_str())
                .unwrap_or("GET")
                .to_string();
            if req_methods.len() > 1024 {
                req_methods.clear();
            }
            req_methods.insert(req_id.to_string(), req_method);
        }
        "Network.responseReceived" => {
            let Some(url) = p
                .pointer("/response/url")
                .and_then(|v| v.as_str())
                .map(ToString::to_string)
            else {
                return;
            };
            let status = p
                .pointer("/response/status")
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                .min(u16::MAX as u64) as u16;
            let req_method = req_methods
                .remove(req_id)
                .unwrap_or_else(|| "GET".to_string());

            let inspect_wrb = is_batchexecute_post_200(&url, &req_method, status);
            if (status >= 400 && is_error_body_candidate(&url)) || inspect_wrb {
                if pending_bodies.len() > 256 {
                    pending_bodies.clear();
                }
                pending_bodies.insert(req_id.to_string(), (url, req_method, status));
            } else {
                let _ = network_tx.send(NetworkResponseEvent {
                    url,
                    method: req_method,
                    status,
                    error_excerpt: None,
                    wrb_ok: None,
                });
            }
        }
        "Network.loadingFinished" => {
            let Some((url, req_method, status)) = pending_bodies.remove(req_id) else {
                return;
            };
            let inspect_wrb = is_batchexecute_post_200(&url, &req_method, status);
            let req_id_owned = req_id.to_string();
            let tx = network_tx.clone();
            let Some(t) = weak_transport.upgrade() else {
                let _ = tx.send(NetworkResponseEvent {
                    url,
                    method: req_method,
                    status,
                    error_excerpt: inspect_wrb.then(|| "CDP transport closed".to_string()),
                    wrb_ok: inspect_wrb.then_some(false),
                });
                return;
            };
            tokio::spawn(async move {
                let (wrb_ok, excerpt) = if inspect_wrb {
                    match fetch_response_text(&t, &req_id_owned).await {
                        Some(body) => {
                            let (ok, err) = inspect_batchexecute_body(&body);
                            (Some(ok), err)
                        }
                        None => (
                            Some(false),
                            Some("Failed to read batchexecute response body".to_string()),
                        ),
                    }
                } else {
                    (
                        None,
                        fetch_response_text(&t, &req_id_owned)
                            .await
                            .and_then(|body| truncate_excerpt(&body)),
                    )
                };
                let _ = tx.send(NetworkResponseEvent {
                    url,
                    method: req_method,
                    status,
                    error_excerpt: excerpt,
                    wrb_ok,
                });
            });
        }
        "Network.loadingFailed" => {
            req_methods.remove(req_id);
            if let Some((url, req_method, status)) = pending_bodies.remove(req_id) {
                let inspect_wrb = is_batchexecute_post_200(&url, &req_method, status);
                let _ = network_tx.send(NetworkResponseEvent {
                    url,
                    method: req_method,
                    status,
                    error_excerpt: inspect_wrb.then(|| "Network loading failed".to_string()),
                    wrb_ok: inspect_wrb.then_some(false),
                });
            }
        }
        _ => {}
    }
}

/// Maximum number of Unicode characters retained in one error excerpt.
const MAX_ERROR_EXCERPT_CHARS: usize = 500;

/// Returns `true` when `url` belongs to a Flow or Google auth host worth fetching on HTTP errors.
fn is_error_body_candidate(url: &str) -> bool {
    url.contains("flow.google.com")
        || url.contains("aisandbox-pa.googleapis.com")
        || url.contains("labs.google")
        || url.contains("recaptcha")
}

/// Returns `true` when the response is an HTTP 200 `batchexecute` `POST` request.
fn is_batchexecute_post_200(url: &str, method: &str, status: u16) -> bool {
    status == 200 && method.eq_ignore_ascii_case("POST") && url.contains("batchexecute")
}

/// Trims `text` and truncates it to [`MAX_ERROR_EXCERPT_CHARS`] characters when non-empty.
fn truncate_excerpt(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let excerpt = trimmed
        .chars()
        .take(MAX_ERROR_EXCERPT_CHARS)
        .collect::<String>();
    let clean = excerpt.trim();
    (!clean.is_empty()).then(|| clean.to_string())
}

/// Fetches the decoded UTF-8 response body text for `request_id` from Chrome CDP.
async fn fetch_response_text(transport: &CdpTransport, request_id: &str) -> Option<String> {
    let val = transport
        .call(
            "Network.getResponseBody",
            json!({ "requestId": request_id }),
            Duration::from_secs(3),
        )
        .await
        .ok()?;
    let raw_body = val.get("body").and_then(|v| v.as_str())?;
    if val
        .get("base64Encoded")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw_body)
            .ok()?;
        Some(String::from_utf8_lossy(&bytes).into_owned())
    } else {
        Some(raw_body.to_string())
    }
}

/// Formats one `wrb.fr` error value (`entry[5]`) into a bounded diagnostic excerpt.
fn format_wrb_error(rpc_id: Option<&str>, err_val: &Value) -> String {
    let prefix = match rpc_id.filter(|s| !s.is_empty()) {
        Some(id) => format!("wrb.fr {id} error"),
        None => "wrb.fr error".to_string(),
    };
    let detail = if let Some(arr) = err_val.as_array() {
        let code = arr.first().and_then(Value::as_i64);
        let message = arr
            .get(1)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let extra = arr.get(2).filter(|v| !v.is_null());
        match (code, message, extra) {
            (Some(c), Some(m), Some(ex)) => format!("(code {c}): {m} {ex}"),
            (Some(c), Some(m), None) => format!("(code {c}): {m}"),
            (None, Some(m), Some(ex)) => format!(": {m} {ex}"),
            (None, Some(m), None) => format!(": {m}"),
            (Some(c), None, Some(ex)) => format!("(code {c}): {ex}"),
            (Some(c), None, None) => format!("(code {c})"),
            (None, None, _) => format!(": {err_val}"),
        }
    } else if let Some(s) = err_val.as_str() {
        format!(": {s}")
    } else {
        format!(": {err_val}")
    };
    let full = format!("{prefix}{detail}");
    truncate_excerpt(&full).unwrap_or(prefix)
}

/// Inspects one `batchexecute` frame array and updates `saw_valid_wrb` or returns an error excerpt.
fn check_batchexecute_frame(frame: &[Value], saw_valid_wrb: &mut bool) -> Option<String> {
    let tag = frame.first().and_then(Value::as_str)?;
    match tag {
        "er" => {
            let msg = frame
                .get(2)
                .and_then(Value::as_str)
                .or_else(|| frame.get(1).and_then(Value::as_str))
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let raw = match msg {
                Some(m) => format!("batchexecute error: {m}"),
                None => format!("batchexecute error: {}", Value::Array(frame.to_vec())),
            };
            Some(truncate_excerpt(&raw).unwrap_or_else(|| "batchexecute error".to_string()))
        }
        "wrb.fr" => {
            let rpc_id = frame.get(1).and_then(Value::as_str);
            if let Some(err_val) = frame.get(5).filter(|v| !v.is_null()) {
                return Some(format_wrb_error(rpc_id, err_val));
            }
            let has_payload = [2usize, 9, 10]
                .into_iter()
                .any(|idx| frame.get(idx).is_some_and(|v| !v.is_null()));
            if !has_payload {
                let msg = match rpc_id.filter(|s| !s.is_empty()) {
                    Some(id) => format!("wrb.fr {id} returned an empty payload"),
                    None => "wrb.fr returned an empty payload".to_string(),
                };
                return Some(msg);
            }
            *saw_valid_wrb = true;
            None
        }
        _ => None,
    }
}

/// Checks a `batchexecute` HTTP 200 body for valid `wrb.fr` payloads and absence of RPC errors.
fn inspect_batchexecute_body(body: &str) -> (bool, Option<String>) {
    let trimmed = body.trim_start();
    let rest = if let Some(after_prefix) = trimmed.strip_prefix(")]}'") {
        after_prefix
            .find('\n')
            .map_or(after_prefix, |idx| &after_prefix[idx + 1..])
    } else {
        trimmed
    };

    let mut saw_valid_wrb = false;
    let stream = serde_json::Deserializer::from_str(rest).into_iter::<Value>();
    for item in stream {
        let Ok(val) = item else {
            break;
        };
        let Some(outer) = val.as_array() else {
            continue;
        };
        if outer.first().and_then(Value::as_str).is_some() {
            if let Some(err) = check_batchexecute_frame(outer, &mut saw_valid_wrb) {
                return (false, Some(err));
            }
            continue;
        }
        for entry in outer {
            if let Some(frame) = entry.as_array()
                && let Some(err) = check_batchexecute_frame(frame, &mut saw_valid_wrb)
            {
                return (false, Some(err));
            }
        }
    }

    if saw_valid_wrb {
        (true, None)
    } else {
        let fallback = truncate_excerpt(rest)
            .unwrap_or_else(|| "Invalid or empty batchexecute response".to_string());
        (false, Some(fallback))
    }
}

/// Returns the shared HTTP client for local Chrome CDP endpoint discovery.
fn http_client() -> &'static reqwest::Client {
    static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_millis(500))
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Queries `/json/version` from a local Chrome CDP HTTP endpoint.
pub(crate) async fn fetch_json_version(endpoint: &str) -> Option<Value> {
    let url = format!("{}/json/version", endpoint.trim_end_matches('/'));
    let resp = http_client().get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<Value>().await.ok()
}

/// Picks the preferred Google Flow or fallback `"page"` target from `/json/list`.
fn select_page_target(list: &[Value]) -> Option<&Value> {
    list.iter()
        .find(|t| {
            t.get("type").and_then(|v| v.as_str()) == Some("page")
                && t.get("url").and_then(|v| v.as_str()).is_some_and(|u| {
                    u.contains("flow.google.com")
                        || u.contains("labs.google")
                        || u.contains("accounts.google.com")
                })
        })
        .or_else(|| {
            list.iter()
                .find(|t| t.get("type").and_then(|v| v.as_str()) == Some("page"))
        })
}

/// Finds or creates a page target on `endpoint` and returns its `webSocketDebuggerUrl`.
pub(crate) async fn find_or_create_page_target(endpoint: &str) -> Result<String> {
    let base = endpoint.trim_end_matches('/');
    let list_url = format!("{}/json/list", base);
    if let Ok(resp) = http_client().get(&list_url).send().await
        && resp.status().is_success()
        && let Ok(list) = resp.json::<Vec<Value>>().await
        && let Some(page) = select_page_target(&list)
        && let Some(ws) = page.get("webSocketDebuggerUrl").and_then(|v| v.as_str())
    {
        return Ok(ws.to_string());
    }

    let new_url = format!("{}/json/new?about:blank", base);
    let resp =
        http_client().put(&new_url).send().await.with_context(|| {
            format!("Failed to request a new Chrome page target at {}", new_url)
        })?;
    let page: Value = resp
        .json()
        .await
        .context("Failed to parse Chrome /json/new response")?;
    let ws = page
        .get("webSocketDebuggerUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            anyhow::anyhow!("Missing webSocketDebuggerUrl in Chrome /json/new response")
        })?
        .to_string();
    Ok(ws)
}

/// Gets the WebSocket URL for the specified Chrome target.
pub(crate) async fn page_target_socket(endpoint: &str, target_id: &str) -> Result<String> {
    let url = format!("{}/json/list", endpoint.trim_end_matches('/'));
    let list: Vec<Value> = http_client()
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    list.iter()
        .find(|target| target["id"].as_str() == Some(target_id))
        .and_then(|target| target["webSocketDebuggerUrl"].as_str())
        .map(str::to_owned)
        .context("Chrome did not report the new page target")
}
