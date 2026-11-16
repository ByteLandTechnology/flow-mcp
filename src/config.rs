// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Runtime paths, Google Flow URL constants, and CLI override storage.

use std::path::PathBuf;
use std::sync::OnceLock;

/// Google Flow base URL with the English interface parameter (`hl=en`).
pub(crate) const FLOW_URL: &str = "https://flow.google.com/?hl=en";

/// Google Accounts sign-in URL that redirects to Google Flow in English.
pub(crate) const FLOW_SSO_URL: &str = "https://accounts.google.com/ServiceLogin?hl=en&passive=1209600&osid=1&continue=https%3A%2F%2Fflow.google.com%2F%3Fhl%3Den&followup=https%3A%2F%2Fflow.google.com%2F%3Fhl%3Den&ec=GAZA7QU";

/// Process-wide override for `--home`.
static CLI_HOME_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Process-wide override for `--chrome`.
static CLI_CHROME_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Stores the `--home` override once at startup.
///
/// [`home_dir`] checks this value before environment variables and platform defaults.
pub(crate) fn init_cli_home(home: Option<PathBuf>) {
    if let Some(h) = home {
        let _ = CLI_HOME_DIR.set(h);
    }
}

/// Stores the `--chrome` executable override once at startup.
pub(crate) fn set_chrome_path(path: PathBuf) {
    let _ = CLI_CHROME_PATH.set(path);
}

/// Returns the `--chrome` binary path override if set at startup.
pub(crate) fn cli_chrome_path() -> Option<PathBuf> {
    CLI_CHROME_PATH.get().cloned()
}

/// Returns the `flow-mcp` data root (`--home`, then `FLOW_MCP_HOME`, then `~/.flow-mcp`).
pub(crate) fn home_dir() -> PathBuf {
    if let Some(v) = CLI_HOME_DIR.get() {
        return v.clone();
    }
    if let Ok(v) = std::env::var("FLOW_MCP_HOME")
        && !v.trim().is_empty()
    {
        return PathBuf::from(v);
    }
    std::env::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".flow-mcp")
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

/// Returns the explicit Chrome CDP port from `FLOW_MCP_CHROME_CDP_PORT` when valid and positive.
pub(crate) fn configured_cdp_port() -> Option<u16> {
    std::env::var("FLOW_MCP_CHROME_CDP_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .filter(|&p| p > 0)
}
