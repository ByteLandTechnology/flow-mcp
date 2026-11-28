// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Parse and build Google Flow workspace routes.

use url::Url;

use crate::config::FLOW_URL;
use crate::flow_url::{
    is_flow_origin_host, is_non_grid_project_subroute_segments, is_signed_in_parsed_flow_url,
    is_workspace_flow_route, split_flow_path,
};

/// Extracts the `/project/<id>` segment from a prefix-stripped Flow URL path.
fn project_id_from_path(path: &str) -> Option<String> {
    let stripped = split_flow_path(path);
    if !stripped.route.starts_with("/project/") || !is_workspace_flow_route(&stripped.route) {
        return None;
    }
    let prefix_count = stripped.prefix.split('/').filter(|s| !s.is_empty()).count();
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let id = segs.get(prefix_count + 1)?.trim();
    (!id.is_empty()).then(|| id.to_string())
}

/// Extracts the `/project/<id>` segment from a Flow workspace URL or path.
pub(crate) fn project_id_from_url(url: &str) -> Option<String> {
    if let Ok(parsed) = Url::parse(url) {
        if !is_signed_in_parsed_flow_url(&parsed) {
            return None;
        }
        return project_id_from_path(parsed.path());
    }
    if !url.starts_with('/') {
        return None;
    }
    let path = url.split(['?', '#']).next()?;
    project_id_from_path(path)
}

/// Returns `true` when `path` points to a non-grid subroute inside `/project/<id>`.
fn is_project_subroute_path(path: &str) -> bool {
    let stripped = split_flow_path(path);
    let Some(rest) = stripped.route.strip_prefix("/project/") else {
        return false;
    };
    let segs: Vec<&str> = rest.split('/').collect();
    let Some((&project_id, sub)) = segs.split_first() else {
        return false;
    };
    !project_id.is_empty() && is_non_grid_project_subroute_segments(sub)
}

/// Returns `true` when `url` points to a non-grid subroute inside `/project/<id>`.
pub(crate) fn is_project_subroute_url(url: &str) -> bool {
    if let Ok(parsed) = Url::parse(url) {
        if !is_signed_in_parsed_flow_url(&parsed) {
            return false;
        }
        return is_project_subroute_path(parsed.path());
    }
    if !url.starts_with('/') {
        return false;
    }
    let path = url.split(['?', '#']).next().unwrap_or_default();
    is_project_subroute_path(path)
}

/// Extracts the active route prefix from a Flow URL path.
fn flow_route_prefix(path: &str) -> String {
    split_flow_path(path).prefix
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
