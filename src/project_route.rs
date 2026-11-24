// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Parse and build Google Flow workspace routes.

use url::Url;

use crate::config::FLOW_URL;

/// Extracts the `/project/<id>` segment from a Flow project URL.
pub(crate) fn project_id_from_url(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    let (_, project) = path.split_once("/project/")?;
    let id = project.split('/').next()?.trim();
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
