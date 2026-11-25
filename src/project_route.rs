// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Parse and build Google Flow workspace routes.

use url::Url;

use crate::config::FLOW_URL;

/// Extracts the `/project/<id>` segment from a Flow workspace URL or path.
pub(crate) fn project_id_from_url(url: &str) -> Option<String> {
    if url.contains("://") && !crate::auth::is_signed_in_flow_url(url) {
        return None;
    }
    let path = url.split(['?', '#']).next()?;
    let stripped = split_flow_path(path);
    if !stripped.route.starts_with("/project/") || !is_workspace_flow_route(&stripped.route) {
        return None;
    }
    let prefix_count = stripped.prefix.split('/').filter(|s| !s.is_empty()).count();
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let id = segs.get(prefix_count + 1)?.trim();
    (!id.is_empty()).then(|| id.to_string())
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

/// Parsed components of a Google Flow URL path after stripping active prefixes.
pub(crate) struct StrippedFlowPath {
    /// Active route prefix starting with `/` when present, preserving original case.
    pub(crate) prefix: String,
    /// Normalized lowercase route path starting with `/` without trailing slashes.
    pub(crate) route: String,
    /// True when `/fx/tools/flow` appears in the stripped prefix segments.
    pub(crate) has_labs_flow_prefix: bool,
}

/// Returns `true` when `seg` is a reserved Flow top-level segment rather than an organization slug.
fn is_reserved_flow_segment(seg: &str) -> bool {
    matches!(
        seg.to_ascii_lowercase().as_str(),
        "project"
            | "projects"
            | "search"
            | "changelogs"
            | "about"
            | "shared"
            | "flow"
            | "tools"
            | "fx"
            | "u"
            | "unsupported-country"
            | "unsupported-browser"
            | "unavailable"
            | "age-restricted"
            | "privacy"
            | "credits-terms"
            | "academy"
            | "404"
            | "login"
            | "debug"
    )
}

/// Strips `/fx/tools/flow`, `/fx`, `/u/<digits>`, and `/<org>/global` prefixes from `path`.
pub(crate) fn split_flow_path(path: &str) -> StrippedFlowPath {
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let mut prefix = Vec::new();
    let mut has_labs_flow_prefix = false;
    let mut i = 0;
    while i < segs.len() {
        if segs.len() >= i + 3
            && segs[i].eq_ignore_ascii_case("fx")
            && segs[i + 1].eq_ignore_ascii_case("tools")
            && segs[i + 2].eq_ignore_ascii_case("flow")
        {
            has_labs_flow_prefix = true;
            prefix.extend_from_slice(&segs[i..i + 3]);
            i += 3;
        } else if segs[i].eq_ignore_ascii_case("fx") {
            prefix.push(segs[i]);
            i += 1;
        } else if i + 1 < segs.len()
            && ((segs[i].eq_ignore_ascii_case("u")
                && !segs[i + 1].is_empty()
                && segs[i + 1].bytes().all(|b| b.is_ascii_digit()))
                || (segs[i + 1].eq_ignore_ascii_case("global")
                    && !is_reserved_flow_segment(segs[i])))
        {
            prefix.extend_from_slice(&segs[i..i + 2]);
            i += 2;
        } else {
            break;
        }
    }
    let prefix_str = if prefix.is_empty() {
        String::new()
    } else {
        format!("/{}", prefix.join("/"))
    };
    let route = if i >= segs.len() {
        "/".to_string()
    } else {
        format!("/{}", segs[i..].join("/")).to_ascii_lowercase()
    };
    StrippedFlowPath {
        prefix: prefix_str,
        route,
        has_labs_flow_prefix,
    }
}

/// Returns `true` when lowercase segments after `/project/<id>` match a recognized Flow project subroute.
fn is_project_subroute_segments(segs: &[&str]) -> bool {
    match segs {
        ["character" | "tools" | "create-tool" | "trash" | "chat"] => true,
        [
            "character" | "scene" | "edit" | "tool" | "collection" | "chat",
            id,
        ] => !id.is_empty(),
        ["collection", id, "character"] | ["trash", "collection", id] => !id.is_empty(),
        _ => false,
    }
}

/// Returns `true` when a prefix-stripped lowercase `route` is a recognized Flow workspace path.
pub(crate) fn is_workspace_flow_route(route: &str) -> bool {
    if matches!(route, "/" | "/projects" | "/search" | "/changelogs") {
        return true;
    }
    let Some(rest) = route.strip_prefix("/project/") else {
        return false;
    };
    let segs: Vec<&str> = rest.split('/').collect();
    let Some((&project_id, sub)) = segs.split_first() else {
        return false;
    };
    !project_id.is_empty() && (sub.is_empty() || is_project_subroute_segments(sub))
}

/// Returns `true` when `url` points to a non-grid subroute inside `/project/<id>`.
pub(crate) fn is_project_subroute_url(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or_default();
    let stripped = split_flow_path(path);
    let Some(rest) = stripped.route.strip_prefix("/project/") else {
        return false;
    };
    let segs: Vec<&str> = rest.split('/').collect();
    let Some((&project_id, sub)) = segs.split_first() else {
        return false;
    };
    !project_id.is_empty() && is_project_subroute_segments(sub)
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
