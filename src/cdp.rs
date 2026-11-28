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

use crate::config::FLOW_URL;
use crate::engine::NetworkResponseEvent;
use crate::generation::{
    has_generation_batchexecute_rpc, is_generation_rpc_id, is_generation_rpc_url,
};

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

            let inspect_body = network_tx.receiver_count() > 0
                && should_inspect_response_body(&req_method, status, &url);
            if inspect_body {
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
                });
            }
        }
        "Network.loadingFinished" => {
            let Some((url, req_method, status)) = pending_bodies.remove(req_id) else {
                return;
            };
            let req_id_owned = req_id.to_string();
            let tx = network_tx.clone();
            let Some(t) = weak_transport.upgrade() else {
                let _ = tx.send(NetworkResponseEvent {
                    url,
                    method: req_method,
                    status,
                    error_excerpt: None,
                });
                return;
            };
            tokio::spawn(async move {
                let excerpt = fetch_error_excerpt(&t, &req_id_owned, status).await;
                let _ = tx.send(NetworkResponseEvent {
                    url,
                    method: req_method,
                    status,
                    error_excerpt: excerpt,
                });
            });
        }
        "Network.loadingFailed" => {
            req_methods.remove(req_id);
            if let Some((url, req_method, status)) = pending_bodies.remove(req_id) {
                let _ = network_tx.send(NetworkResponseEvent {
                    url,
                    method: req_method,
                    status,
                    error_excerpt: None,
                });
            }
        }
        _ => {}
    }
}

/// Extracts the primary Google Flow host name from [`FLOW_URL`].
fn flow_host() -> &'static str {
    FLOW_URL
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split(['/', '?', '#', ':']).next())
        .filter(|host| !host.is_empty())
        .unwrap_or("flow.google.com")
}

/// Returns `true` when `url` belongs to a Google Flow host.
fn is_flow_api_host(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains(&flow_host().to_ascii_lowercase())
        || lower.contains("aisandbox-pa.googleapis.com")
        || lower.contains("labs.google")
}

/// Returns `true` when an active subscriber needs the body of this CDP HTTP response.
fn should_inspect_response_body(method: &str, status: u16, url: &str) -> bool {
    method.eq_ignore_ascii_case("POST")
        && is_flow_api_host(url)
        && ((status >= 400 && is_generation_rpc_url(url))
            || (status == 200 && has_generation_batchexecute_rpc(url)))
}

/// Truncates non-empty error text to at most 500 characters.
fn truncate_excerpt(text: &str) -> Option<String> {
    let excerpt: String = text.trim().chars().take(500).collect();
    let trimmed = excerpt.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Reads 1-based protobuf `field` from a JSPB array with a message ID at index `0` (`Wa` offset).
fn jspb_msg_field(frame: &[Value], field: usize) -> Option<&Value> {
    let last_idx = frame.len().checked_sub(1)?;
    if last_idx < 1 || field == 0 {
        return None;
    }
    let val = if field >= last_idx {
        let last = &frame[last_idx];
        if let Value::Object(map) = last {
            map.get(&field.to_string())?
        } else if field == last_idx {
            last
        } else {
            return None;
        }
    } else {
        &frame[field]
    };
    (!val.is_null()).then_some(val)
}

/// Reads 1-based protobuf `field` from a JSPB submessage array without a message ID.
fn jspb_submsg_field(arr: &[Value], field: usize) -> Option<&Value> {
    if arr.is_empty() || field == 0 {
        return None;
    }
    let idx = field - 1;
    let last_idx = arr.len() - 1;
    let val = if idx >= last_idx {
        let last = &arr[last_idx];
        if let Value::Object(map) = last {
            map.get(&field.to_string())?
        } else if idx == last_idx {
            last
        } else {
            return None;
        }
    } else {
        &arr[idx]
    };
    (!val.is_null()).then_some(val)
}

/// Extracts the first readable non-type-URL string inside a nested error payload.
fn first_detail_text(val: &Value) -> Option<String> {
    match val {
        Value::String(s) => {
            let trimmed = s.trim();
            (!trimmed.is_empty() && !trimmed.starts_with("type.googleapis.com/"))
                .then(|| trimmed.to_string())
        }
        Value::Array(items) => items.iter().find_map(first_detail_text),
        Value::Object(map) => ["message", "reason", "detail", "error"]
            .into_iter()
            .find_map(|k| map.get(k).and_then(first_detail_text))
            .or_else(|| map.values().find_map(first_detail_text)),
        _ => None,
    }
}

/// Formats a `wrb.fr` frame when `Yp` (`[2, 9, 10]`) is empty and field 5 holds a `google.rpc.Status` array.
fn format_wrb_error(frame: &[Value], rpc_id: Option<&str>) -> Option<String> {
    let status_arr = jspb_msg_field(frame, 5)?.as_array()?;
    let code = jspb_submsg_field(status_arr, 1).and_then(Value::as_i64);
    let direct_msg = jspb_submsg_field(status_arr, 2)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let detail_msg =
        direct_msg.or_else(|| jspb_submsg_field(status_arr, 3).and_then(first_detail_text));
    if code.unwrap_or(0) == 0 && detail_msg.is_none() {
        return None;
    }
    let code_str = code.filter(|c| *c != 0).map(|c| c.to_string());
    let prefix = match (rpc_id, code_str.as_deref()) {
        (Some(id), Some(c)) => format!("wrb.fr {id} error {c}"),
        (Some(id), None) => format!("wrb.fr {id} error"),
        (None, Some(c)) => format!("wrb.fr error {c}"),
        (None, None) => "wrb.fr error".to_string(),
    };
    Some(match detail_msg {
        Some(msg) => format!("{prefix}: {msg}"),
        None => prefix,
    })
}

/// Formats one `er` (`DA`) batch executor error frame into a summary string.
fn format_er_error(frame: &[Value]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for field in [2usize, 4, 9] {
        if let Some(val) = jspb_msg_field(frame, field) {
            let piece = val
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .or_else(|| val.as_i64().map(|n| n.to_string()));
            if let Some(text) = piece
                && !parts.contains(&text)
            {
                parts.push(text);
            }
        }
    }
    if let Some(detail) = jspb_msg_field(frame, 10).and_then(first_detail_text)
        && !parts.contains(&detail)
    {
        parts.push(detail);
    }
    if parts.is_empty() {
        "er".to_string()
    } else {
        format!("er: {}", parts.join(" "))
    }
}

/// Accumulates RPC-specific and batch-level errors while scanning `batchexecute` chunks.
struct EnvelopeScanState {
    /// Restricts `wrb.fr` errors to `BATCH_GENERATION_RPC_IDS` when true.
    only_generation_rpcs: bool,
    /// True once a generation RPC `wrb.fr` frame carries a response payload in `[2, 9, 10]`.
    saw_generation_data: bool,
    /// Matched `wrb.fr` RPC errors.
    rpc_errors: Vec<String>,
    /// Unattributed `wrb.fr` or `er` batch executor errors.
    batch_errors: Vec<String>,
}

/// Collects `wrb.fr` and `er` frames from one parsed `batchexecute` JSON value.
fn collect_envelope_errors(val: &Value, state: &mut EnvelopeScanState) {
    let Some(arr) = val.as_array() else {
        return;
    };
    match arr.first().and_then(Value::as_str) {
        Some("wrb.fr") => {
            let rpc_id = jspb_msg_field(arr, 1)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let has_data = [2usize, 9, 10]
                .into_iter()
                .any(|field| jspb_msg_field(arr, field).is_some());
            if has_data {
                if rpc_id.is_some_and(is_generation_rpc_id) {
                    state.saw_generation_data = true;
                }
                return;
            }
            let Some(err) = format_wrb_error(arr, rpc_id) else {
                return;
            };
            match rpc_id {
                Some(id) if !state.only_generation_rpcs || is_generation_rpc_id(id) => {
                    state.rpc_errors.push(err);
                }
                Some(_) => {}
                None => state.batch_errors.push(err),
            }
        }
        Some("er") => state.batch_errors.push(format_er_error(arr)),
        Some(_) => {}
        None => {
            for item in arr {
                collect_envelope_errors(item, state);
            }
        }
    }
}

/// Parses a Google `batchexecute` response body for `wrb.fr` or `er` errors.
fn parse_batchexecute_error(text: &str, only_generation_rpcs: bool) -> Option<String> {
    let trimmed = text.trim_start();
    let mut rest = trimmed.strip_prefix(")]}'").unwrap_or(trimmed);
    let mut state = EnvelopeScanState {
        only_generation_rpcs,
        saw_generation_data: false,
        rpc_errors: Vec::new(),
        batch_errors: Vec::new(),
    };
    while !rest.is_empty() {
        rest = rest.trim_start();
        if rest.is_empty() {
            break;
        }
        if rest.as_bytes().first().is_some_and(u8::is_ascii_digit) {
            let line_end = rest.find('\n').map_or(rest.len(), |i| i + 1);
            let digits = rest[..line_end].trim();
            if digits.bytes().all(|b| b.is_ascii_digit()) {
                rest = &rest[line_end..];
                continue;
            }
        }
        if rest.starts_with('[') {
            let mut stream = serde_json::Deserializer::from_str(rest).into_iter::<Value>();
            if let Some(Ok(parsed)) = stream.next() {
                collect_envelope_errors(&parsed, &mut state);
                let consumed = stream.byte_offset();
                if consumed > 0 {
                    rest = &rest[consumed..];
                    continue;
                }
            }
        }
        rest = match rest.find('\n') {
            Some(pos) => &rest[pos + 1..],
            None => "",
        };
    }
    let mut errors = state.rpc_errors;
    if !only_generation_rpcs || !state.saw_generation_data {
        errors.extend(state.batch_errors);
    }
    (!errors.is_empty()).then(|| errors.join("; "))
}

/// Fetches and truncates the error excerpt of a failed HTTP or `batchexecute` CDP response to 500 characters.
async fn fetch_error_excerpt(
    transport: &CdpTransport,
    request_id: &str,
    status: u16,
) -> Option<String> {
    let val = transport
        .call(
            "Network.getResponseBody",
            json!({ "requestId": request_id }),
            Duration::from_secs(3),
        )
        .await
        .ok()?;
    let raw_body = val.get("body").and_then(|v| v.as_str())?;
    let text = if val
        .get("base64Encoded")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw_body)
            .ok()?;
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        raw_body.to_string()
    };
    if status == 200 {
        let rpc_err = parse_batchexecute_error(&text, true)?;
        truncate_excerpt(&rpc_err)
    } else if let Some(rpc_err) = parse_batchexecute_error(&text, false) {
        truncate_excerpt(&rpc_err)
    } else {
        truncate_excerpt(&text)
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
