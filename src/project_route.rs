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

/// Returns `true` when `url` points to a child route under `/project/<id>`.
///
/// When `allow_collection` is `true`, `/project/<id>/collection/<cid>` counts as a grid view
/// while deeper paths such as `/project/<id>/collection/<cid>/character` remain subroutes.
pub(crate) fn is_project_subroute_url(url: &str, allow_collection: bool) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or_default();
    let Some((_, project)) = path.split_once("/project/") else {
        return false;
    };
    let mut segs = project.trim_end_matches('/').split('/');
    if segs.next().is_none_or(|id| id.trim().is_empty()) {
        return false;
    }
    match (segs.next(), segs.next(), segs.next()) {
        (None, _, _) => false,
        (Some("collection"), Some(cid), None) if allow_collection && !cid.trim().is_empty() => {
            false
        }
        (Some(seg), _, _) => !seg.trim().is_empty(),
    }
}

/// Strips one case-insensitive ASCII `prefix` from the start of `text`.
fn strip_ascii_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| text.get(prefix.len()..))
        .flatten()
}

/// Strips one case-insensitive ASCII `suffix` from the end of `text`.
fn strip_ascii_suffix_ci<'a>(text: &'a str, suffix: &str) -> Option<&'a str> {
    let start = text.len().checked_sub(suffix.len())?;
    let tail = text.get(start..)?;
    tail.eq_ignore_ascii_case(suffix)
        .then(|| text.get(..start))
        .flatten()
}

/// Removes one leading `"Google Flow - "` or trailing `"- Google Flow"` affix from `text`.
fn strip_flow_affix_once(text: &str) -> Option<&str> {
    for brand in ["google flow", "flow"] {
        if let Some(rest) = strip_ascii_prefix_ci(text, brand)
            && rest
                .starts_with(|ch: char| ch.is_whitespace() || matches!(ch, '-' | '–' | '—' | '|'))
            && let Some(stripped) = rest.trim_start().strip_prefix(['-', '–', '—', '|'])
        {
            return Some(stripped.trim());
        }
        if let Some(before) = strip_ascii_suffix_ci(text, brand)
            && before
                .ends_with(|ch: char| ch.is_whitespace() || matches!(ch, '-' | '–' | '—' | '|'))
            && let Some(stripped) = before.trim_end().strip_suffix(['-', '–', '—', '|'])
        {
            return Some(stripped.trim());
        }
    }
    None
}

/// Returns a trimmed project title from the verified store or cleans a fallback document title.
pub(crate) fn clean_project_title(raw: Option<&str>, verified: bool) -> Option<String> {
    let text = raw?.trim();
    if text.is_empty() {
        return None;
    }
    if verified {
        return Some(text.to_string());
    }
    let mut cleaned = text;
    while let Some(next) = strip_flow_affix_once(cleaned) {
        cleaned = next;
    }
    let lower = cleaned.to_ascii_lowercase();
    if cleaned.is_empty()
        || matches!(lower.as_str(), "google flow" | "flow" | "untitled")
        || lower.starts_with("ai creative studio")
    {
        return None;
    }
    Some(cleaned.to_string())
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
