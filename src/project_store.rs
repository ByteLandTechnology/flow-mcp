// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Browser session and RPC envelope confirmation for project store operations.

use anyhow::{Context, Result};
use serde_json::{Value, json};
use tokio::sync::MutexGuard;
use tokio::sync::broadcast::Receiver;
use tokio::sync::broadcast::error::{RecvError, TryRecvError};
use tokio::time::{Duration, Instant};

use crate::auth::is_signed_in_flow_url;
use crate::engine::{ChromeEngine, NetworkResponseEvent, checked_runtime_result};
use crate::project::project_id_from_url;

/// Sorted read-only `batchexecute` RPC IDs from the Google Flow application and Wiz base bundles.
const FLOW_READ_ONLY_RPC_IDS: &[&str] = &[
    "AsR0Se", "DLs3dd", "DTaVef", "Dp1eae", "DviW9c", "EErZ0e", "FYBYuf", "Fat5Ld", "GI4k8",
    "GN0Bre", "GjQLTd", "HTrJv", "HU68fc", "Hbi7j", "Hnrtob", "IxdSwd", "Iyc41d", "J0KDW",
    "JCZWLc", "KV2T2d", "L91dPd", "LPzVkd", "LWkPYd", "Mf1z1c", "NQteMd", "NUDX1e", "NfrxTb",
    "O12LBf", "OqcWz", "OylIJd", "PnAUeb", "Pr65yd", "QKeU4c", "QLXvEd", "QZasKb", "Qagez",
    "QiuWMe", "Qrv5xc", "RcItAc", "SIzNd", "SPrCad", "SVN3Zb", "T3Zezf", "TLev1c", "UGqPl",
    "UXeXJe", "Uhba0c", "UpteDb", "UyrjXe", "VeAN2c", "X1yU8", "Xffewf", "Yizz8d", "ZLaYcd",
    "ZndCYe", "Zzl0ze", "aZDXX", "as29s", "bOKtO", "cIafDb", "cMxpTd", "cNMbMd", "cO7JOb",
    "cPZSdc", "cRvg2c", "dvDVle", "e1OaUd", "e3Amyf", "e6lwif", "eAenfb", "eahEVe", "egmKmf",
    "enykc", "fSRV0e", "ftRkFe", "gS5h8c", "gxLfEb", "heTLee", "iFxMud", "jLD2df", "jf24Zb",
    "jtGUlf", "jwpduf", "kDiqOe", "kGwJ9b", "lv2lXd", "m8kykf", "mrlkwd", "ncZTKe", "ngNC2",
    "nzlxg", "o30O0e", "oQLzge", "okjlg", "orwuxb", "pcDSI", "pd379d", "qJcgMc", "qxCAdb",
    "rEhmZd", "rThb8d", "s00Wxb", "sdYaEc", "syFRRe", "tRARke", "uRk1o", "uurnC", "uwAyfb",
    "vAqMP", "ve2Lsc", "vrrFtb", "w9sHx", "wDg3C", "x6ag3", "xI9TVb", "xaPsAd", "y69Wzf", "yBhWQ",
    "yfXKib", "zWuTOe",
];

/// Returns `true` when `rpc_id` is a known read-only `batchexecute` RPC identifier.
fn is_read_only_flow_rpc(rpc_id: &str) -> bool {
    FLOW_READ_ONLY_RPC_IDS.binary_search(&rpc_id).is_ok()
}

/// Returns `true` when a `batchexecute` URL specifies at least one mutating RPC ID in `rpcids`.
fn batchexecute_has_mutating_rpc(url: &str) -> bool {
    let Some((_, after_q)) = url.split_once('?') else {
        return false;
    };
    let query = after_q.split('#').next().unwrap_or(after_q);
    for pair in query.split('&') {
        let Some(raw_ids) = pair.strip_prefix("rpcids=") else {
            continue;
        };
        let normalized = raw_ids.replace("%2C", ",").replace("%2c", ",");
        if normalized
            .split(',')
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .any(|id| !is_read_only_flow_rpc(id))
        {
            return true;
        }
    }
    false
}

/// Returns `true` when `url` targets a mutating `aisandbox-pa.googleapis.com` endpoint.
fn is_aisandbox_mutation_url(url: &str) -> bool {
    if !url.contains("aisandbox-pa.googleapis.com") || url.contains("batchexecute") {
        return false;
    }
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let lower = path.to_ascii_lowercase();
    ![
        ":get",
        ":batchget",
        ":list",
        ":query",
        ":search",
        ":check",
        ":fetch",
    ]
    .iter()
    .any(|suffix| lower.ends_with(suffix))
}

/// Returns `true` when `ev` targets a mutating Flow RPC endpoint.
fn is_flow_mutation_request(ev: &NetworkResponseEvent) -> bool {
    if !ev.method.eq_ignore_ascii_case("POST") {
        return false;
    }
    if ev.url.contains("batchexecute") {
        batchexecute_has_mutating_rpc(&ev.url)
    } else {
        is_aisandbox_mutation_url(&ev.url)
    }
}

/// Returns `true` when an HTTP response marks a successful Flow store mutation RPC.
fn is_flow_mutation_rpc_ok(ev: &NetworkResponseEvent) -> bool {
    if !is_flow_mutation_request(ev)
        || !(200..300).contains(&ev.status)
        || ev.error_excerpt.is_some()
    {
        return false;
    }
    if ev.url.contains("batchexecute") {
        ev.status == 200 && ev.wrb_ok == Some(true)
    } else {
        ev.wrb_ok != Some(false)
    }
}

/// Returns the error description when a mutating Flow RPC fails at the HTTP or `wrb.fr` layer.
fn flow_mutation_rpc_error(ev: &NetworkResponseEvent) -> Option<String> {
    if !is_flow_mutation_request(ev) {
        return None;
    }
    if ev.status >= 400 {
        let excerpt = ev.error_excerpt.as_deref().unwrap_or("no error body");
        return Some(format!("HTTP {}: {}", ev.status, excerpt));
    }
    if ev.wrb_ok == Some(false) {
        return Some(
            ev.error_excerpt
                .clone()
                .unwrap_or_else(|| "Flow RPC returned an error envelope".to_string()),
        );
    }
    None
}

/// Waits up to `wait` for a valid Flow mutation RPC, returning an error string on failure or timeout.
pub(crate) async fn await_flow_mutation_rpc(
    rx: &mut Receiver<NetworkResponseEvent>,
    wait: Duration,
) -> std::result::Result<(), String> {
    loop {
        match rx.try_recv() {
            Ok(ev) => {
                if is_flow_mutation_rpc_ok(&ev) {
                    return Ok(());
                }
                if let Some(err) = flow_mutation_rpc_error(&ev) {
                    return Err(err);
                }
            }
            Err(TryRecvError::Lagged(_)) => continue,
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Closed) => {
                return Err("Flow network channel closed".to_string());
            }
        }
    }
    let deadline = Instant::now() + wait;
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Ok(ev)) => {
                if is_flow_mutation_rpc_ok(&ev) {
                    return Ok(());
                }
                if let Some(err) = flow_mutation_rpc_error(&ev) {
                    return Err(err);
                }
            }
            Ok(Err(RecvError::Lagged(_))) => continue,
            Ok(Err(RecvError::Closed)) => {
                return Err("Flow network channel closed".to_string());
            }
            Err(_) => {
                return Err("Timed out waiting for Flow mutation RPC".to_string());
            }
        }
    }
}

/// Drains buffered network events and waits up to `wait` for a Flow RPC response.
pub(crate) async fn wait_flow_mutation_rpc(
    rx: &mut Receiver<NetworkResponseEvent>,
    wait: Duration,
) -> bool {
    await_flow_mutation_rpc(rx, wait).await.is_ok()
}

/// Holds the browser project store lock and pins the project and runtime session.
pub(crate) struct ProjectStoreSession<'a> {
    /// Browser engine for the active page.
    engine: &'a ChromeEngine,
    /// Locked project store.
    _guard: MutexGuard<'a, ()>,
    /// Project ID in the active Flow route.
    project_id: String,
    /// Identifier of the browser runtime that owns the bound project store.
    session: String,
}

impl<'a> ProjectStoreSession<'a> {
    /// Binds the store in the open Flow project without changing the page.
    pub(crate) async fn open(engine: &'a ChromeEngine) -> Result<Self> {
        let url = engine.current_url().await?;
        let project_id = url::Url::parse(&url)
            .ok()
            .filter(|_| is_signed_in_flow_url(&url))
            .and_then(|url| project_id_from_url(url.path()))
            .context("Open a Google Flow project before you use this tool")?;
        let guard = engine.lock_project_store().await;
        let session = checked_runtime_result(bind_current_store(engine, &project_id).await?)?
            .get("session")
            .and_then(Value::as_str)
            .context("The browser did not return the project store session")?
            .to_owned();
        Ok(Self {
            engine,
            _guard: guard,
            project_id,
            session,
        })
    }

    /// Returns the active project ID at the time of binding.
    pub(crate) fn project_id(&self) -> &str {
        &self.project_id
    }

    /// Calls a store operation for the pinned project and document.
    ///
    /// Use a short description for a mutation whose outcome can be unknown if CDP fails.
    pub(crate) async fn call(
        &self,
        method: &str,
        request: Value,
        mutation: Option<&str>,
    ) -> Result<Value> {
        let response = self
            .engine
            .call_flow_async(method, json!([self.project_id, self.session, request]))
            .await;
        match (response, mutation) {
            (Ok(result), _) => checked_runtime_result(result),
            (Err(error), Some(mutation)) => anyhow::bail!(
                "outcome_unknown (project {}, {mutation}): {error:#}",
                self.project_id
            ),
            (Err(error), None) => Err(error),
        }
    }
}

/// Prepares the direct store for a status check without changing the page.
pub(crate) async fn prepare_project_store_status(engine: &ChromeEngine, project_id: &str) {
    if let Some(_guard) = engine.try_lock_project_store() {
        let _ = bind_current_store(engine, project_id).await;
    }
}

/// Reads or binds the direct store for the requested project.
async fn bind_current_store(engine: &ChromeEngine, project_id: &str) -> Result<Value> {
    let status = engine
        .call_flow_js("projectStoreStatus", json!([project_id]))
        .await?;
    if status.get("error").and_then(Value::as_str) == Some("collection_store_not_bound") {
        return engine.bind_project_store(project_id).await;
    }
    Ok(status)
}
