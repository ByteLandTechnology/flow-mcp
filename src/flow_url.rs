// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Parse and classify Google Flow hosts, prefixes, and workspace routes.

use url::Url;

/// Parsed components of a Google Flow URL path after stripping active prefixes.
pub(crate) struct StrippedFlowPath {
    /// Active route prefix starting with `/` when present, keeping original case.
    pub(crate) prefix: String,
    /// Normalized lowercase route path starting with `/` without trailing slashes.
    pub(crate) route: String,
    /// True when `/fx/tools/flow` appears in the stripped prefix segments.
    has_labs_flow_prefix: bool,
}

/// Returns `true` when `path` equals `prefix` or starts with `prefix` followed by `/`.
fn has_segment_prefix(path: &str, prefix: &str) -> bool {
    path == prefix
        || (path.len() > prefix.len()
            && path.starts_with(prefix)
            && path.as_bytes().get(prefix.len()) == Some(&b'/'))
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

/// Returns `true` when `raw` points to a Google Flow `http` or `https` host.
pub(crate) fn is_flow_host_url(raw: &str) -> bool {
    Url::parse(raw).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https") && is_flow_origin_host(url.host_str())
    })
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

/// Returns `true` when lowercase segments after `/project/<id>` match a non-grid editor or view subroute.
pub(crate) fn is_non_grid_project_subroute_segments(segs: &[&str]) -> bool {
    match segs {
        ["character" | "tools" | "create-tool" | "trash" | "chat"] => true,
        ["character" | "scene" | "edit" | "tool" | "chat", id] => !id.is_empty(),
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

/// Returns `true` when `parsed` points to a Google Flow workspace host and allowlisted route.
pub(crate) fn is_signed_in_parsed_flow_url(parsed: &Url) -> bool {
    if !matches!(parsed.scheme(), "http" | "https") || !is_flow_origin_host(parsed.host_str()) {
        return false;
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let on_labs = host == "labs.google" || host.ends_with(".labs.google");
    let stripped = split_flow_path(parsed.path());
    if on_labs && !stripped.has_labs_flow_prefix {
        return false;
    }
    is_workspace_flow_route(&stripped.route)
}

/// Returns `true` when `raw` points to a Google Flow workspace host and allowlisted route.
pub(crate) fn is_signed_in_flow_url(raw: &str) -> bool {
    Url::parse(raw).is_ok_and(|parsed| is_signed_in_parsed_flow_url(&parsed))
}

/// Returns `true` when `url` points to a Google Flow `/about` landing route under any supported prefix.
pub(crate) fn is_about_landing_url(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return url.contains("flow.google.com/about") || url.contains("/fx/about");
    };
    if !matches!(parsed.scheme(), "http" | "https") || !is_flow_origin_host(parsed.host_str()) {
        return false;
    }
    let stripped = split_flow_path(parsed.path());
    let rel = stripped.route.as_str();
    rel == "/flow"
        || has_segment_prefix(rel, "/about")
        || has_segment_prefix(rel, "/flow/about")
        || has_segment_prefix(rel, "/tools/flow/about")
}
