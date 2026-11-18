// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Runtime paths, Google Flow URL constants, and CLI override storage.

use std::path::PathBuf;
use std::sync::OnceLock;

/// Google Flow base URL with the English interface parameter (`hl=en`).
pub(crate) const FLOW_URL: &str = "https://flow.google.com/?hl=en";

/// Google Accounts sign-in URL that redirects to Google Flow in English.
pub(crate) const FLOW_SSO_URL: &str = "https://accounts.google.com/ServiceLogin?hl=en&passive=1209600&osid=1&continue=https%3A%2F%2Fflow.google.com%2F%3Fhl%3Den&followup=https%3A%2F%2Fflow.google.com%2F%3Fhl%3Den&ec=GAZA7QU";

/// Default lower bound of the pause between queue jobs, in milliseconds.
pub(crate) const DEFAULT_PAUSE_MIN_MS: u64 = 25_000;

/// Default upper bound of the pause between queue jobs, in milliseconds.
pub(crate) const DEFAULT_PAUSE_MAX_MS: u64 = 70_000;

/// Runtime settings that the command line or its environment variables supply.
#[derive(Debug, Clone)]
pub(crate) struct Settings {
    /// Data root from `--home` or `FLOW_MCP_HOME`.
    pub(crate) home: Option<PathBuf>,
    /// Chrome or Chromium binary from `--chrome` or `FLOW_MCP_CHROME`.
    pub(crate) chrome: Option<PathBuf>,
    /// Fixed Chrome CDP port from `--cdp-port` or `FLOW_MCP_CDP_PORT`.
    pub(crate) cdp_port: Option<u16>,
    /// Inclusive pause bounds between queue jobs in milliseconds, from `--pause` or `FLOW_MCP_PAUSE`.
    pub(crate) pause_ms: (u64, u64),
    /// True when `--headless` or `FLOW_MCP_HEADLESS` selects headless background Chrome.
    pub(crate) headless: bool,
}

impl Default for Settings {
    /// Returns settings with no overrides and the default pause bounds.
    fn default() -> Self {
        Self {
            home: None,
            chrome: None,
            cdp_port: None,
            pause_ms: (DEFAULT_PAUSE_MIN_MS, DEFAULT_PAUSE_MAX_MS),
            headless: false,
        }
    }
}

/// Process-wide settings that `init_settings` stores once at startup.
static SETTINGS: OnceLock<Settings> = OnceLock::new();

/// Stores the parsed runtime settings once at startup.
pub(crate) fn init_settings(settings: Settings) {
    let _ = SETTINGS.set(settings);
}

/// Returns the stored runtime settings, or the defaults before `init_settings` runs.
fn settings() -> Settings {
    SETTINGS.get().cloned().unwrap_or_default()
}

/// Returns the `--chrome` binary path override if set at startup.
pub(crate) fn cli_chrome_path() -> Option<PathBuf> {
    settings().chrome
}

/// Returns the `flow-mcp` data root (`--home` or `FLOW_MCP_HOME`, then `~/.flow-mcp`).
pub(crate) fn home_dir() -> PathBuf {
    if let Some(v) = settings().home {
        return v;
    }
    std::env::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".flow-mcp")
}

/// Returns `<home_dir>/downloads` for all downloaded media files.
pub(crate) fn downloads_dir() -> PathBuf {
    home_dir().join("downloads")
}

/// Returns `<home_dir>/flow-mcp.db` for the local SQLite database.
pub(crate) fn db_path() -> PathBuf {
    home_dir().join("flow-mcp.db")
}

/// Returns `<home_dir>/flow-mcp.lock`, which a process locks while it can start Chrome.
pub(crate) fn instance_lock_path() -> PathBuf {
    home_dir().join("flow-mcp.lock")
}

/// Returns `<home_dir>/cookies.json` for saved Google Flow session cookies.
pub(crate) fn cookies_path() -> PathBuf {
    home_dir().join("cookies.json")
}

/// Returns `<home_dir>/chrome-profile` for the persistent `0700` Chrome user-data directory.
pub(crate) fn chrome_profile_dir() -> PathBuf {
    home_dir().join("chrome-profile")
}

/// Returns `true` when persisted session data exists in `<home_dir>/chrome-profile` or `cookies.json`.
pub(crate) fn has_persisted_session() -> bool {
    cookies_path().is_file() || chrome_profile_dir().join("Default").is_dir()
}

/// Returns the fixed Chrome CDP port from `--cdp-port` or `FLOW_MCP_CDP_PORT`.
pub(crate) fn configured_cdp_port() -> Option<u16> {
    settings().cdp_port
}

/// Returns the inclusive pause bounds between queue jobs in milliseconds.
pub(crate) fn pause_bounds_ms() -> (u64, u64) {
    settings().pause_ms
}

/// Returns true when `--headless` or `FLOW_MCP_HEADLESS` selects headless background Chrome. The default is a visible window.
pub(crate) fn headless_chrome() -> bool {
    settings().headless
}
