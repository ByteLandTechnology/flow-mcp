// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Parse and build Google Flow workspace routes.

use anyhow::Result;
use serde_json::json;
use tokio::time::Duration;
use url::Url;

use crate::auth::is_flow_host_url;
use crate::config::FLOW_URL;
use crate::engine::ChromeEngine;

/// Extracts the `/project/<id>` segment from a Flow project URL.
pub(crate) fn project_id_from_url(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    let (_, project) = path.split_once("/project/")?;
    let id = project.split('/').next()?.trim();
    (!id.is_empty()).then(|| id.to_string())
}

/// Returns `true` when `url` points to any `/project/<id>/...` subroute (including `/collection/<cid>`).
pub(crate) fn is_project_subroute_url(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or_default();
    let Some((_, project)) = path.split_once("/project/") else {
        return false;
    };
    let mut segs = project.trim_end_matches('/').split('/');
    if segs.next().is_none_or(str::is_empty) {
        return false;
    }
    segs.next().is_some_and(|seg| !seg.is_empty())
}

/// Returns `true` when `url` points to a non-grid `/project/<id>/...` subroute while keeping `/collection/<cid>`.
pub(crate) fn is_non_grid_subroute_url(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or_default();
    let Some((_, project)) = path.split_once("/project/") else {
        return false;
    };
    let mut segs = project.trim_end_matches('/').split('/');
    if segs.next().is_none_or(str::is_empty) {
        return false;
    }
    match (segs.next(), segs.next(), segs.next()) {
        (None, _, _) => false,
        (Some("collection"), Some(cid), None) => cid.is_empty(),
        (Some(seg), _, _) => !seg.is_empty(),
    }
}

/// Strips `"Google Flow - "` wrappers and rejects generic `"Google Flow"` `document.title` values.
pub(crate) fn clean_flow_page_title(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if let Some(after) = lower.strip_prefix("google flow")
        && let Some(rest) = after
            .trim_start()
            .strip_prefix(['-', '–', '—', '|', ':'])
            .map(str::trim_start)
        && rest.starts_with("ai creative studio")
    {
        return None;
    }
    let without_prefix = strip_google_flow_prefix(trimmed);
    let stripped = strip_google_flow_suffix(without_prefix).trim();
    if stripped.is_empty() || stripped.eq_ignore_ascii_case("google flow") {
        return None;
    }
    Some(stripped.to_string())
}

/// Strips a leading `"Google Flow - "` prefix from a `document.title` string.
fn strip_google_flow_prefix(value: &str) -> &str {
    let prefix = "google flow";
    if value.len() >= prefix.len()
        && value
            .get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
        && let Some(tail) = value.get(prefix.len()..)
        && let Some(after_sep) = tail.trim_start().strip_prefix(['-', '–', '—', '|', ':'])
    {
        return after_sep.trim_start();
    }
    value
}

/// Strips a trailing `"- Google Flow"` suffix from a `document.title` string.
fn strip_google_flow_suffix(value: &str) -> &str {
    let suffix = "google flow";
    if value.len() >= suffix.len()
        && value
            .get(value.len() - suffix.len()..)
            .is_some_and(|tail| tail.eq_ignore_ascii_case(suffix))
        && let Some(head) = value.get(..value.len() - suffix.len())
        && let Some(before_sep) = head.trim_end().strip_suffix(['-', '–', '—', '|', ':'])
    {
        return before_sep.trim_end();
    }
    value
}

/// Exits active project subroutes matched by `is_subroute` using `nav_action` or direct navigation.
async fn exit_matching_subroute(
    engine: &ChromeEngine,
    nav_action: &str,
    is_subroute: fn(&str) -> bool,
) -> Result<()> {
    let current = engine.current_url().await?;
    if !is_subroute(&current) {
        return Ok(());
    }
    let project_id = project_id_from_url(&current)
        .ok_or_else(|| anyhow::anyhow!("Cannot identify the active Flow project"))?;
    let workspace = project_workspace_url(&current, &project_id);
    let returned = |url: &str| {
        is_flow_host_url(url)
            && !is_subroute(url)
            && project_id_from_url(url).as_deref() == Some(project_id.as_str())
            && project_workspace_url(url, &project_id) == workspace
    };
    let _ = engine
        .call_flow_async("projectNav", json!([nav_action]))
        .await;
    if returned(&engine.current_url().await.unwrap_or_default()) {
        return Ok(());
    }
    engine.navigate(&workspace).await?;
    for _ in 0..10 {
        if returned(&engine.current_url().await.unwrap_or_default()) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    anyhow::bail!("Cannot return to the active Flow project workspace")
}

/// Navigates back to `/project/<id>` from non-grid subroutes while keeping `/project/<id>/collection/<cid>`.
pub(crate) async fn ensure_project_workspace_root(engine: &ChromeEngine) -> Result<()> {
    exit_matching_subroute(engine, "exit_subroute", is_non_grid_subroute_url).await
}

/// Navigates back to `/project/<id>` when Chrome is on any `/project/<id>/...` subroute.
pub(crate) async fn ensure_project_root_route(engine: &ChromeEngine) -> Result<()> {
    exit_matching_subroute(engine, "exit_to_project_root", is_project_subroute_url).await
}

/// Returns `true` when `host` is a Google Flow host (`flow.google.com` or `labs.google`).
pub(crate) fn is_flow_origin_host(host: Option<&str>) -> bool {
    let Some(h) = host else {
        return false;
    };
    h.eq_ignore_ascii_case("flow.google.com")
        || h.eq_ignore_ascii_case("labs.google")
        || h.to_ascii_lowercase().ends_with(".labs.google")
}

/// Extracts the active route prefix before `/project/` from a Flow URL path.
fn flow_route_prefix(path: &str) -> String {
    if let Some((before, _)) = path.split_once("/project/") {
        return before.trim_end_matches('/').to_string();
    }
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let mut prefix = Vec::new();
    let mut i = 0;
    while i < segs.len() {
        if segs[i..].starts_with(&["fx", "tools", "flow"]) {
            prefix.extend_from_slice(&["fx", "tools", "flow"]);
            i += 3;
        } else if i + 1 < segs.len()
            && segs[i] == "u"
            && !segs[i + 1].is_empty()
            && segs[i + 1].bytes().all(|b| b.is_ascii_digit())
        {
            prefix.extend_from_slice(&["u", segs[i + 1]]);
            i += 2;
        } else if i + 1 < segs.len()
            && segs[i + 1] == "global"
            && !matches!(
                segs[i],
                "project" | "projects" | "about" | "shared" | "flow" | "tools" | "fx" | "u"
            )
        {
            prefix.extend_from_slice(&[segs[i], "global"]);
            i += 2;
        } else {
            break;
        }
    }
    if prefix.is_empty() {
        String::new()
    } else {
        format!("/{}", prefix.join("/"))
    }
}

/// Builds a Google Flow `/project/<id>` or subroute URL with active prefixes, `hl=en`, and `authuser`.
pub(crate) fn project_subroute_url(
    reference_url: &str,
    project_id: &str,
    subroute: &str,
) -> String {
    let parsed = Url::parse(reference_url)
        .ok()
        .filter(|u| matches!(u.scheme(), "https" | "http") && is_flow_origin_host(u.host_str()));
    let prefix = parsed
        .as_ref()
        .map(|u| flow_route_prefix(u.path()))
        .unwrap_or_default();
    let authuser = parsed.as_ref().and_then(|u| {
        u.query_pairs()
            .find(|(k, _)| k == "authuser")
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    });
    let clean_sub = subroute.trim_start_matches('/');
    let route_path = if clean_sub.is_empty() {
        format!("{prefix}/project/{project_id}")
    } else {
        format!("{prefix}/project/{project_id}/{clean_sub}")
    };
    if let Some(mut base) = parsed.or_else(|| Url::parse(FLOW_URL).ok()) {
        base.set_path(&route_path);
        base.set_fragment(None);
        {
            let mut qp = base.query_pairs_mut();
            qp.clear();
            qp.append_pair("hl", "en");
            if let Some(au) = authuser.as_deref() {
                qp.append_pair("authuser", au);
            }
        }
        return base.into();
    }
    format!("https://flow.google.com{route_path}?hl=en")
}

/// Builds the Google Flow `/project/<id>` workspace URL with active prefixes, `hl=en`, and `authuser`.
pub(crate) fn project_workspace_url(reference_url: &str, project_id: &str) -> String {
    project_subroute_url(reference_url, project_id, "")
}

/// Extracts `<id>` from a `/character/<id>` URL path.
pub(crate) fn character_id_from_url(url: &str) -> Option<String> {
    url.split("/character/")
        .nth(1)
        .and_then(|rest| rest.split(['/', '?', '#']).next())
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}
