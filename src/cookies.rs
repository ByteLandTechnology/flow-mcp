// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Cookie normalization, CDP conversion, and atomic `0600` file storage.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

use crate::config::cookies_path;
use crate::platform::write_private_file_atomic;

/// Normalized cookie record persisted in `cookies.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NormalizedCookie {
    /// Cookie name.
    pub(crate) name: String,
    /// Cookie value string.
    pub(crate) value: String,
    /// Cookie domain attribute or host.
    pub(crate) domain: String,
    /// Cookie path scope.
    pub(crate) path: String,
    /// True when Chrome sends the cookie only over HTTPS.
    pub(crate) secure: bool,
    /// True when the cookie is hidden from page scripts.
    pub(crate) http_only: bool,
    /// Cookie `SameSite` policy (`Strict`, `Lax`, or `None`).
    pub(crate) same_site: String,
    /// Optional expiration time in Unix epoch seconds.
    pub(crate) expires: Option<i64>,
    /// True when the cookie applies only to the exact host.
    pub(crate) host_only: bool,
}

impl NormalizedCookie {
    /// Converts this record to a CDP `CookieParam` JSON object for `Network.setCookies`.
    pub(crate) fn to_cdp_cookie_param(&self) -> Option<Value> {
        let name = self.name.trim();
        let clean_domain = self.domain.trim().trim_start_matches('.');
        if name.is_empty() || clean_domain.is_empty() {
            return None;
        }

        let path = if self.path.trim().is_empty() {
            "/".to_string()
        } else {
            self.path.clone()
        };
        let mut same_site = match self.same_site.trim().to_ascii_lowercase().as_str() {
            "strict" => "Strict",
            "none" => "None",
            _ => "Lax",
        };
        // Chromium rejects `SameSite=None` cookies unless `secure` is `true`.
        if same_site == "None" && !self.secure {
            same_site = "Lax";
        }
        let mut obj = serde_json::Map::new();
        obj.insert("name".to_string(), json!(name));
        obj.insert("value".to_string(), json!(self.value));
        obj.insert("path".to_string(), json!(path));
        obj.insert("secure".to_string(), json!(self.secure));
        obj.insert("httpOnly".to_string(), json!(self.http_only));
        obj.insert("sameSite".to_string(), json!(same_site));
        obj.insert("url".to_string(), json!(format!("https://{clean_domain}/")));

        if !self.host_only {
            obj.insert("domain".to_string(), json!(format!(".{clean_domain}")));
        }

        if let Some(ts) = self.expires.filter(|&ts| ts > 0) {
            let now_secs = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            if ts <= now_secs {
                return None;
            }
            obj.insert("expires".to_string(), json!(ts as f64));
        }

        Some(Value::Object(obj))
    }
}

/// Returns `true` when `domain` equals `suffix` or is a subdomain of `suffix`.
pub(crate) fn cookie_domain_matches(domain: &str, suffix: &str) -> bool {
    let clean = domain.trim().trim_start_matches('.').to_ascii_lowercase();
    let target = suffix.to_ascii_lowercase();
    clean == target
        || (clean.len() > target.len()
            && clean.ends_with(&target)
            && clean.as_bytes()[clean.len() - target.len() - 1] == b'.')
}

/// Returns `true` when `domain` belongs to Google or Google Flow cookie scopes.
fn is_flow_cookie_domain(domain: &str) -> bool {
    cookie_domain_matches(domain, "google.com")
        || cookie_domain_matches(domain, "labs.google")
        || cookie_domain_matches(domain, "googleusercontent.com")
        || cookie_domain_matches(domain, "gstatic.com")
}

/// Writes `persisted` cookies atomically to `cookies.json` with `0o600` permissions.
pub(crate) fn write_cookies_file(persisted: &[NormalizedCookie]) -> Result<PathBuf> {
    let cookie_path = cookies_path();
    let serialized = serde_json::to_vec_pretty(persisted)?;
    write_private_file_atomic(&cookie_path, &serialized)?;
    Ok(cookie_path)
}

/// Reads saved cookies from `cookies.json`, returning an empty list if missing.
pub(crate) fn read_cookies_file() -> Result<Vec<NormalizedCookie>> {
    let cookie_path = cookies_path();
    if !cookie_path.exists() {
        return Ok(Vec::new());
    }
    let bytes = std::fs::read(&cookie_path)?;
    let parsed: Vec<NormalizedCookie> = serde_json::from_slice(&bytes)?;
    Ok(parsed)
}

/// Infers whether `name` on `domain` should be treated as a host-only cookie.
pub(crate) fn infer_host_only(name: &str, domain: &str) -> bool {
    if domain.starts_with('.') {
        false
    } else {
        let clean = domain.trim().to_ascii_lowercase();
        name.to_ascii_lowercase().starts_with("__host-")
            || clean == "accounts.google.com"
            || (clean == "flow.google.com" && !name.starts_with("_ga"))
    }
}

/// Keeps Google, Labs, and Flow domain cookies and normalizes `hostOnly` and `expires` fields.
pub(crate) fn normalize_cookies(raw_cookies: Vec<Value>) -> Vec<NormalizedCookie> {
    let mut persisted = Vec::new();
    for c in raw_cookies {
        let domain = c.get("domain").and_then(|v| v.as_str()).unwrap_or("");
        if !is_flow_cookie_domain(domain) {
            continue;
        }
        let Some(name) = c.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let value = c.get("value").and_then(|v| v.as_str()).unwrap_or("");
        let path = c.get("path").and_then(|v| v.as_str()).unwrap_or("/");
        let secure = c.get("secure").and_then(|v| v.as_bool()).unwrap_or(true);
        let http_only = c.get("httpOnly").and_then(|v| v.as_bool()).unwrap_or(false);
        let same_site = c.get("sameSite").and_then(|v| v.as_str()).unwrap_or("Lax");
        let expires = c
            .get("expires")
            .and_then(|v| v.as_f64())
            .filter(|&e| e > 0.0 && e <= i64::MAX as f64)
            .map(|e| e as i64);
        // Keep an explicit `hostOnly` flag when present; otherwise infer from name and host.
        let host_only = c
            .get("hostOnly")
            .and_then(|v| v.as_bool())
            .unwrap_or_else(|| infer_host_only(name, domain));
        persisted.push(NormalizedCookie {
            name: name.to_string(),
            value: value.to_string(),
            domain: domain.to_string(),
            path: path.to_string(),
            secure,
            http_only,
            same_site: same_site.to_string(),
            expires,
            host_only,
        });
    }
    persisted
}

/// Returns `true` when `domain` and `name` match a core Google Sign-In session cookie.
pub(crate) fn is_google_auth_cookie_pair(domain: &str, name: &str) -> bool {
    const AUTH_NAMES: [&str; 6] = [
        "SID",
        "__Secure-1PSID",
        "__Secure-3PSID",
        "SAPISID",
        "__Secure-1PAPISID",
        "__Secure-3PAPISID",
    ];
    cookie_domain_matches(domain, "google.com") && AUTH_NAMES.contains(&name.trim())
}

/// Returns `true` when core Google Sign-In session cookies are present.
pub(crate) fn has_google_auth_cookies(cookies: &[NormalizedCookie]) -> bool {
    cookies
        .iter()
        .any(|c| !c.value.trim().is_empty() && is_google_auth_cookie_pair(&c.domain, &c.name))
}

/// Builds an HTTP `Cookie` request header for `target_url` from normalized records.
pub(crate) fn cookie_header_from_normalized(
    cookies: &[NormalizedCookie],
    target_url: &str,
) -> Result<String> {
    let parsed = Url::parse(target_url)?;
    let Some(url_host) = parsed.host_str() else {
        return Ok(String::new());
    };
    let is_https = parsed.scheme() == "https";
    let url_path = parsed.path();
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let mut pairs = Vec::new();
    for cookie in cookies {
        if cookie.name.trim().is_empty() || (cookie.secure && !is_https) {
            continue;
        }
        if let Some(exp) = cookie.expires
            && exp > 0
            && exp <= now_secs
        {
            continue;
        }

        let clean_domain = cookie.domain.trim().trim_start_matches('.');
        if clean_domain.is_empty() {
            continue;
        }
        let domain_ok = if cookie.host_only {
            url_host.eq_ignore_ascii_case(clean_domain)
        } else {
            cookie_domain_matches(url_host, clean_domain)
        };
        if !domain_ok {
            continue;
        }

        let cookie_path = if cookie.path.trim().is_empty() {
            "/"
        } else {
            cookie.path.as_str()
        };
        let path_ok = url_path == cookie_path
            || (url_path.starts_with(cookie_path)
                && (cookie_path.ends_with('/')
                    || url_path.as_bytes().get(cookie_path.len()) == Some(&b'/')));
        if !path_ok {
            continue;
        }

        pairs.push(format!("{}={}", cookie.name, cookie.value));
    }

    Ok(pairs.join("; "))
}
