// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Command-line flags, subcommands, and subcommand output for `flow-mcp`.

use anyhow::Result;
use clap::{Parser, Subcommand};
use serde_json::{Value, json};
use std::future::Future;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use crate::auth::{self, LoginParams};
use crate::chrome;
use crate::config::{self, FLOW_URL, Settings};
use crate::engine::ChromeEngine;
use crate::http::{HttpOptions, serve_http};
use crate::instance;
use crate::mcp::FlowMcpServer;
use crate::platform;
use crate::service::FlowService;

/// Largest pause bound in seconds that `--pause` accepts.
const MAX_PAUSE_SECS: f64 = 86_400.0;

/// Time limit for `<chrome> --version` during `doctor`.
const CHROME_VERSION_TIMEOUT: Duration = Duration::from_secs(10);

/// Number of attempts to read `WIZ_global_data.cfb2h` after opening Google Flow in `doctor`.
const FLOW_BUILD_PROBE_ATTEMPTS: u32 = 20;

/// Delay between `WIZ_global_data.cfb2h` checks in `doctor`.
const FLOW_BUILD_PROBE_INTERVAL: Duration = Duration::from_millis(250);

/// Command-line flags and the subcommand for `flow-mcp`.
#[derive(Debug, Parser)]
#[command(
    name = "flow-mcp",
    version,
    about = "Rust MCP server for Google Flow with Chrome CDP browser engine",
    subcommand_required = true,
    arg_required_else_help = true
)]
pub(crate) struct Cli {
    /// Set the data root directory (defaults to ~/.flow-mcp)
    #[arg(long, value_name = "PATH", env = "FLOW_MCP_HOME", global = true)]
    home: Option<PathBuf>,

    /// Set the Chrome or Chromium binary path (defaults to auto-detect)
    #[arg(long, value_name = "PATH", env = "FLOW_MCP_CHROME", global = true)]
    chrome: Option<PathBuf>,

    /// Set a fixed Chrome DevTools Protocol port (defaults to a free port)
    #[arg(
        long,
        value_name = "PORT",
        env = "FLOW_MCP_CDP_PORT",
        global = true,
        value_parser = clap::value_parser!(u16).range(1..)
    )]
    cdp_port: Option<u16>,

    /// Set the random pause between queue jobs in seconds (one value sets a fixed pause, 0 disables it)
    #[arg(
        long,
        value_name = "MIN[,MAX]",
        env = "FLOW_MCP_PAUSE",
        global = true,
        default_value = "25,70",
        value_parser = parse_pause
    )]
    pause: (u64, u64),

    /// Run background Chrome in headless mode (Google Flow can reject generations from headless Chrome)
    #[arg(
        long,
        env = "FLOW_MCP_HEADLESS",
        global = true,
        value_parser = clap::builder::BoolishValueParser::new()
    )]
    headless: bool,

    /// Subcommand to run.
    #[command(subcommand)]
    command: Command,
}

/// Subcommands of `flow-mcp`.
#[derive(Debug, Subcommand)]
enum Command {
    /// Serve the MCP tools over standard input and output, or over Streamable HTTP with --http
    Serve {
        /// Serve MCP over Streamable HTTP at http://ADDR/mcp instead of standard input and output (for example 127.0.0.1:8765)
        #[arg(long, value_name = "IP:PORT", env = "FLOW_MCP_HTTP")]
        http: Option<SocketAddr>,
        /// Require this bearer token on each HTTP request; required when the address is not a loopback address
        #[arg(
            long,
            value_name = "TOKEN",
            env = "FLOW_MCP_HTTP_TOKEN",
            hide_env_values = true,
            value_parser = clap::builder::NonEmptyStringValueParser::new()
        )]
        http_token: Option<String>,
    },
    /// Sign in to Google Flow in a visible Chrome window and wait until sign-in completes
    Login {
        /// Set the maximum wait time for sign-in in seconds (15 to 3600)
        #[arg(long, value_name = "SECS", default_value_t = 180)]
        timeout: u64,
        /// Clear saved cookies and the session before sign-in starts
        #[arg(long)]
        force: bool,
        /// Write the result as JSON
        #[arg(long)]
        json: bool,
    },
    /// Show the Google Flow sign-in status (starts background Chrome)
    Status {
        /// Write the result as JSON
        #[arg(long)]
        json: bool,
    },
    /// Clear saved cookies and the Google Flow session
    Logout {
        /// Write the result as JSON
        #[arg(long)]
        json: bool,
    },
    /// Check the Chrome binary, the data directory, the instance lock, the live Flow build, and the sign-in status
    Doctor {
        /// Write the result as JSON
        #[arg(long)]
        json: bool,
    },
}

/// Parses one pause bound in seconds into milliseconds.
fn parse_pause_secs(raw: &str) -> Result<u64, String> {
    let secs = raw
        .trim()
        .parse::<f64>()
        .map_err(|_| format!("`{}` is not a number of seconds", raw.trim()))?;
    if !secs.is_finite() || !(0.0..=MAX_PAUSE_SECS).contains(&secs) {
        return Err(format!(
            "`{}` is not between 0 and {} seconds",
            raw.trim(),
            MAX_PAUSE_SECS
        ));
    }
    Ok((secs * 1000.0).round() as u64)
}

/// Parses `MIN[,MAX]` in seconds into inclusive pause bounds in milliseconds.
fn parse_pause(raw: &str) -> Result<(u64, u64), String> {
    let (min_ms, max_ms) = match raw.split_once(',') {
        Some((min, max)) => (parse_pause_secs(min)?, parse_pause_secs(max)?),
        None => {
            let fixed = parse_pause_secs(raw)?;
            (fixed, fixed)
        }
    };
    if min_ms > max_ms {
        return Err("MIN must not be greater than MAX".to_string());
    }
    Ok((min_ms, max_ms))
}

/// Waits for `SIGINT` or Unix `SIGTERM`.
async fn wait_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut sigterm) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = sigterm.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

/// Runs `task` until it ends or a shutdown signal arrives, then shuts down Chrome.
async fn run_with_engine<T>(
    engine: &Arc<ChromeEngine>,
    task: impl Future<Output = Result<T>>,
) -> Result<T> {
    let result = tokio::select! {
        res = task => res,
        _ = wait_shutdown_signal() => Err(anyhow::anyhow!("Interrupted by a shutdown signal")),
    };
    engine.shutdown().await;
    result
}

/// Returns `LoginParams` for `action` with default values for all other fields.
fn login_params(action: &str) -> LoginParams {
    LoginParams {
        action: Some(action.to_string()),
        wait: None,
        timeout_secs: None,
        force: None,
        cookies: None,
    }
}

/// Takes the `<home>` lock, runs one `flow_login` action in a new `ChromeEngine`, and returns the tool result.
async fn run_login_action(params: LoginParams) -> Result<Value> {
    instance::acquire_instance_lock()?;
    let engine = ChromeEngine::new();
    run_with_engine(&engine, auth::handle_login(&engine, params)).await
}

/// Formats one JSON value as plain text for terminal output.
fn plain_value(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Bool(true) => "yes".to_string(),
        Value::Bool(false) => "no".to_string(),
        Value::Null => "-".to_string(),
        other => other.to_string(),
    }
}

/// Writes `result` as pretty JSON or as one `key: value` line per top-level field.
fn print_result(result: &Value, as_json: bool) -> Result<()> {
    if as_json {
        println!("{}", serde_json::to_string_pretty(result)?);
        return Ok(());
    }
    if let Value::Object(map) = result {
        for (key, value) in map {
            if key != "ok" {
                println!("{key}: {}", plain_value(value));
            }
        }
    } else {
        println!("{}", plain_value(result));
    }
    Ok(())
}

/// Returns one `doctor` check result.
fn check(name: &str, status: &str, detail: impl Into<String>) -> Value {
    json!({ "name": name, "status": status, "detail": detail.into() })
}

/// Runs `<chrome> --version` and returns its first output line.
async fn chrome_version(path: &Path) -> Option<String> {
    let output = tokio::time::timeout(
        CHROME_VERSION_TIMEOUT,
        tokio::process::Command::new(path)
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim();
    (!line.is_empty()).then(|| line.to_string())
}

/// Checks that the Chrome binary exists and reports its version.
async fn check_chrome() -> Value {
    let source = if config::cli_chrome_path().is_some() {
        "--chrome"
    } else {
        "auto-detect"
    };
    let Some(path) = chrome::find_chrome() else {
        return check(
            "chrome",
            "fail",
            "No Chrome or Chromium found. Install Chrome, or set --chrome or FLOW_MCP_CHROME.",
        );
    };
    if !path.is_file() {
        return check(
            "chrome",
            "fail",
            format!("{} ({source}) is not a file", path.display()),
        );
    }
    let version = chrome_version(&path)
        .await
        .unwrap_or_else(|| "version unknown".to_string());
    check(
        "chrome",
        "ok",
        format!("{} ({source}, {version})", path.display()),
    )
}

/// Checks that the Unix permission bits of `path` are `expected`.
fn check_mode(name: &str, path: &Path, expected: u32) -> Value {
    if !path.exists() {
        return check(
            name,
            "skip",
            format!("{} does not exist yet", path.display()),
        );
    }
    match platform::file_mode(path) {
        None => check(
            name,
            "skip",
            "Unix permission bits do not apply on this platform",
        ),
        Some(mode) => {
            let status = if mode == expected { "ok" } else { "fail" };
            check(
                name,
                status,
                format!(
                    "{} has mode {mode:o}, expected {expected:o}",
                    path.display()
                ),
            )
        }
    }
}

/// Checks the data root and the permissions of the private files in it.
fn check_home() -> Vec<Value> {
    let home = config::home_dir();
    let home_check = match std::fs::metadata(&home) {
        Err(_) => check(
            "home",
            "warn",
            format!("{} does not exist yet", home.display()),
        ),
        Ok(meta) if !meta.is_dir() => check(
            "home",
            "fail",
            format!("{} is not a directory", home.display()),
        ),
        Ok(meta) if meta.permissions().readonly() => {
            check("home", "fail", format!("{} is read-only", home.display()))
        }
        Ok(_) => check("home", "ok", home.display().to_string()),
    };
    vec![
        home_check,
        check_mode("chrome-profile", &config::chrome_profile_dir(), 0o700),
        check_mode("cookies.json", &config::cookies_path(), 0o600),
        check_mode("flow-mcp.db", &config::db_path(), 0o600),
    ]
}

/// Takes the `<home>` lock and reports orphaned Chrome; returns the check and `true` when this process holds the lock.
fn check_instance_lock() -> (Value, bool) {
    match instance::try_acquire_instance_lock() {
        Err(e) => (check("instance-lock", "fail", format!("{e:#}")), false),
        Ok(false) => (
            check(
                "instance-lock",
                "warn",
                format!(
                    "Another flow-mcp process uses {}",
                    config::home_dir().display()
                ),
            ),
            false,
        ),
        Ok(true) => {
            let orphans = instance::orphan_chrome_pids(&config::chrome_profile_dir());
            let value = if orphans.is_empty() {
                check(
                    "instance-lock",
                    "ok",
                    "No other flow-mcp process uses the data directory",
                )
            } else {
                check(
                    "instance-lock",
                    "warn",
                    format!(
                        "Orphaned Chrome PID {orphans:?} uses the profile; the next Chrome start stops it"
                    ),
                )
            };
            (value, true)
        }
    }
}

/// Probes `WIZ_global_data.cfb2h` against `VERIFIED_BUILDS` on the live Google Flow page.
async fn check_flow_build_in_engine(engine: &ChromeEngine) -> Value {
    if let Err(e) = engine.ensure_page().await {
        return check("flow-build", "fail", format!("{e:#}"));
    }
    let mut url = engine.current_url().await.unwrap_or_default();
    if !auth::is_flow_host_url(&url) {
        if let Err(e) = engine.navigate(FLOW_URL).await {
            return check("flow-build", "fail", format!("{e:#}"));
        }
        url = engine
            .current_url()
            .await
            .unwrap_or_else(|_| FLOW_URL.to_string());
    }
    let mut last_err = None;
    for _ in 0..FLOW_BUILD_PROBE_ATTEMPTS {
        match engine.call_flow_js("probeBuild", json!([])).await {
            Ok(probe) => {
                if probe.get("ok").and_then(Value::as_bool) == Some(true) {
                    let build = probe
                        .get("build")
                        .and_then(Value::as_str)
                        .unwrap_or("verified");
                    return check(
                        "flow-build",
                        "ok",
                        format!("Verified Google Flow build ({build})"),
                    );
                }
                if let Some(build) = probe.get("build").and_then(Value::as_str) {
                    return check(
                        "flow-build",
                        "fail",
                        format!("Unverified Google Flow build ({build})"),
                    );
                }
                last_err = None;
            }
            Err(e) => {
                last_err = Some(format!("{e:#}"));
            }
        }
        tokio::time::sleep(FLOW_BUILD_PROBE_INTERVAL).await;
    }
    if let Some(err) = last_err {
        return check("flow-build", "fail", err);
    }
    url = engine.current_url().await.unwrap_or(url);
    check(
        "flow-build",
        "fail",
        format!("WIZ_global_data.cfb2h is missing at {url}"),
    )
}

/// Checks the live Google Flow build and sign-in status in one shared background Chrome session.
async fn check_live_flow(chrome_ok: bool, locked: bool) -> (Value, Value) {
    if !locked {
        let build = if chrome_ok {
            check(
                "flow-build",
                "skip",
                "Another flow-mcp uses the data directory; use the flow_status tool there",
            )
        } else {
            check(
                "flow-build",
                "fail",
                "Chrome is unavailable; cannot check the live Google Flow build",
            )
        };
        let sign_in = check(
            "sign-in",
            "skip",
            "Another flow-mcp uses the data directory; use the flow_login tool there",
        );
        return (build, sign_in);
    }
    if !chrome_ok {
        return (
            check(
                "flow-build",
                "fail",
                "Chrome is unavailable; cannot check the live Google Flow build",
            ),
            check("sign-in", "skip", "Chrome is unavailable"),
        );
    }
    let engine = ChromeEngine::new();
    let result = run_with_engine(&engine, async {
        let sign_in = match auth::handle_login(&engine, login_params("status")).await {
            Err(e) => check("sign-in", "fail", format!("{e:#}")),
            Ok(res) if res.get("signedIn").and_then(Value::as_bool) == Some(true) => {
                let url = res.get("url").map(plain_value).unwrap_or_default();
                check("sign-in", "ok", format!("Signed in ({url})"))
            }
            Ok(_) => check("sign-in", "warn", "Not signed in; run `flow-mcp login`"),
        };
        let flow_build = check_flow_build_in_engine(&engine).await;
        Ok((flow_build, sign_in))
    })
    .await;
    match result {
        Ok(pair) => pair,
        Err(e) => {
            let msg = format!("{e:#}");
            (
                check("flow-build", "fail", msg.clone()),
                check("sign-in", "fail", msg),
            )
        }
    }
}

/// Runs all `doctor` checks, writes the report, and returns status `1` when any check fails.
async fn run_doctor(as_json: bool) -> Result<ExitCode> {
    let chrome_check = check_chrome().await;
    let chrome_ok = chrome_check.get("status").and_then(Value::as_str) == Some("ok");
    let mut checks = vec![chrome_check];
    checks.extend(check_home());
    let (lock_check, locked) = check_instance_lock();
    checks.push(lock_check);
    let (flow_build_check, sign_in_check) = check_live_flow(chrome_ok, locked).await;
    checks.push(flow_build_check);
    checks.push(sign_in_check);

    let exit_code = if checks
        .iter()
        .any(|c| c.get("status").and_then(Value::as_str) == Some("fail"))
    {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    };

    if as_json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({ "checks": checks }))?
        );
        return Ok(exit_code);
    }
    for c in &checks {
        let status = c.get("status").map(plain_value).unwrap_or_default();
        let name = c.get("name").map(plain_value).unwrap_or_default();
        let detail = c.get("detail").map(plain_value).unwrap_or_default();
        println!("[{status:<4}] {name}: {detail}");
    }
    Ok(exit_code)
}

/// Starts the MCP server over standard input and output, or over HTTP when `http` is set,
/// and shuts down Chrome on exit or on a shutdown signal.
async fn run_serve(http: Option<HttpOptions>) -> Result<()> {
    let engine = ChromeEngine::new();
    let server = FlowMcpServer::new(FlowService::new(Arc::clone(&engine)));
    let result = match http {
        None => tokio::select! {
            res = server.serve_stdio() => res,
            _ = wait_shutdown_signal() => Ok(()),
        },
        Some(options) => serve_http(server, options, wait_shutdown_signal()).await,
    };
    engine.shutdown().await;
    result
}

/// Stores the parsed settings and runs the selected subcommand.
pub(crate) async fn run(cli: Cli) -> Result<ExitCode> {
    config::init_settings(Settings {
        home: cli.home,
        chrome: cli.chrome,
        cdp_port: cli.cdp_port,
        pause_ms: cli.pause,
        headless: cli.headless,
    });
    match cli.command {
        Command::Serve { http, http_token } => {
            run_serve(http.map(|addr| HttpOptions {
                addr,
                token: http_token,
            }))
            .await?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Login {
            timeout,
            force,
            json,
        } => {
            let params = LoginParams {
                wait: Some(true),
                timeout_secs: Some(timeout),
                force: Some(force),
                ..login_params("login")
            };
            eprintln!(
                "Complete the sign-in in the browser window. flow-mcp continues when it detects the sign-in, or when you close the window."
            );
            print_result(&run_login_action(params).await?, json)?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Status { json } => {
            print_result(&run_login_action(login_params("status")).await?, json)?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Logout { json } => {
            print_result(&run_login_action(login_params("logout")).await?, json)?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Doctor { json } => run_doctor(json).await,
    }
}
