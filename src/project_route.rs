// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Parse and build Google Flow workspace routes.

use url::Url;

use crate::config::{FLOW_SSO_URL, FLOW_URL};

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

/// Returns `true` when `path` equals `prefix` or starts with `prefix` followed by `/`.
pub(crate) fn has_segment_prefix(path: &str, prefix: &str) -> bool {
    path == prefix
        || (path.len() > prefix.len()
            && path.starts_with(prefix)
            && path.as_bytes().get(prefix.len()) == Some(&b'/'))
}

/// Normalizes a URL path to lowercase single-slash segments while keeping `/` for root.
pub(crate) fn normalize_flow_path(raw: &str) -> String {
    let segs: Vec<String> = raw
        .trim()
        .split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();
    if segs.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", segs.join("/"))
    }
}

/// Returns `true` when `segment` is a reserved Flow route word rather than an organization ID.
fn is_reserved_flow_segment(segment: &str) -> bool {
    matches!(
        segment.to_ascii_lowercase().as_str(),
        "project"
            | "projects"
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
            | "search"
            | "changelogs"
            | "debug"
    )
}

/// Extracts the active `/fx/tools/flow`, `/u/<digits>`, and `/<org>/global` prefix from `path`.
pub(crate) fn flow_route_prefix(path: &str) -> String {
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let mut prefix = Vec::new();
    let mut i = 0;
    while i < segs.len() {
        if i + 2 < segs.len()
            && segs[i].eq_ignore_ascii_case("fx")
            && segs[i + 1].eq_ignore_ascii_case("tools")
            && segs[i + 2].eq_ignore_ascii_case("flow")
        {
            prefix.extend_from_slice(&["fx", "tools", "flow"]);
            i += 3;
        } else if i + 1 < segs.len()
            && segs[i].eq_ignore_ascii_case("u")
            && !segs[i + 1].is_empty()
            && segs[i + 1].bytes().all(|b| b.is_ascii_digit())
        {
            prefix.extend_from_slice(&["u", segs[i + 1]]);
            i += 2;
        } else if i + 1 < segs.len()
            && segs[i + 1].eq_ignore_ascii_case("global")
            && !is_reserved_flow_segment(segs[i])
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

/// Normalizes `path` and strips `/fx/tools/flow`, `/u/<digits>`, `/<org>/global`, and `/fx` prefixes.
pub(crate) fn strip_flow_route_prefix(path: &str) -> String {
    let clean = normalize_flow_path(path);
    let prefix = flow_route_prefix(&clean);
    let after_prefix = if prefix.is_empty() {
        clean.as_str()
    } else {
        clean
            .strip_prefix(&prefix)
            .filter(|rest| !rest.is_empty())
            .unwrap_or("/")
    };
    if after_prefix == "/fx" {
        "/".to_string()
    } else if let Some(rest) = after_prefix.strip_prefix("/fx/") {
        format!("/{rest}")
    } else {
        after_prefix.to_string()
    }
}

/// Returns `true` when `prefix` includes the `/fx/tools/flow` host mount.
pub(crate) fn prefix_has_fx_tools_flow(prefix: &str) -> bool {
    let lower = prefix.to_ascii_lowercase();
    lower == "/fx/tools/flow"
        || lower.starts_with("/fx/tools/flow/")
        || lower.ends_with("/fx/tools/flow")
        || lower.contains("/fx/tools/flow/")
}

/// Reads a trimmed non-empty query parameter value from `url`.
fn query_param(url: &Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Extracts the `/u/<digits>` account index from `path` when present.
fn path_authuser(path: &str) -> Option<String> {
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let mut i = 0;
    while i + 1 < segs.len() {
        if segs[i].eq_ignore_ascii_case("u")
            && !segs[i + 1].is_empty()
            && segs[i + 1].bytes().all(|b| b.is_ascii_digit())
        {
            return Some(segs[i + 1].to_string());
        }
        i += 1;
    }
    None
}

/// Writes `hl=en` plus optional `authuser` and `pageId` onto `url`.
fn apply_account_query_params(url: &mut Url, authuser: Option<&str>, page_id: Option<&str>) {
    url.set_fragment(None);
    let mut qp = url.query_pairs_mut();
    qp.clear();
    qp.append_pair("hl", "en");
    if let Some(au) = authuser {
        qp.append_pair("authuser", au);
    }
    if let Some(pid) = page_id {
        qp.append_pair("pageId", pid);
    }
}

/// Builds a Flow workspace root URL that keeps the host, route prefixes, `hl=en`, `authuser`, and `pageId` of `reference_url`.
pub(crate) fn flow_workspace_root_url(reference_url: &str) -> String {
    let Some(mut parsed) = Url::parse(reference_url)
        .ok()
        .filter(|u| matches!(u.scheme(), "https" | "http") && is_flow_origin_host(u.host_str()))
    else {
        return FLOW_URL.to_string();
    };
    let on_labs = parsed.host_str().is_some_and(|h| {
        h.eq_ignore_ascii_case("labs.google") || h.to_ascii_lowercase().ends_with(".labs.google")
    });
    let prefix = flow_route_prefix(parsed.path());
    if on_labs && !prefix_has_fx_tools_flow(&prefix) {
        return FLOW_URL.to_string();
    }
    let authuser = query_param(&parsed, "authuser");
    let page_id = query_param(&parsed, "pageId");
    let root_path = if prefix.is_empty() {
        "/".to_string()
    } else {
        format!("{prefix}/")
    };
    parsed.set_path(&root_path);
    apply_account_query_params(&mut parsed, authuser.as_deref(), page_id.as_deref());
    parsed.into()
}

/// Normalizes a verified Flow workspace URL for background promotion while keeping its route, `hl=en`, `authuser`, and `pageId`.
pub(crate) fn promotion_target_url(ready_flow_url: Option<&str>) -> String {
    let Some(raw) = ready_flow_url else {
        return FLOW_URL.to_string();
    };
    if !crate::auth::is_signed_in_flow_url(raw) {
        return flow_workspace_root_url(raw);
    }
    let Some(mut parsed) = Url::parse(raw)
        .ok()
        .filter(|u| matches!(u.scheme(), "https" | "http") && is_flow_origin_host(u.host_str()))
    else {
        return FLOW_URL.to_string();
    };
    let pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(k, _)| k != "hl")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    parsed.set_fragment(None);
    {
        let mut qp = parsed.query_pairs_mut();
        qp.clear();
        qp.append_pair("hl", "en");
        for (k, v) in &pairs {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                qp.append_pair(k, trimmed);
            }
        }
    }
    parsed.into()
}

/// Builds a Google Accounts passive SSO URL whose `continue` target and `authuser` match `reference_url`.
pub(crate) fn flow_sso_url_for(reference_url: &str) -> String {
    let parsed_ref = Url::parse(reference_url)
        .ok()
        .filter(|u| matches!(u.scheme(), "https" | "http") && is_flow_origin_host(u.host_str()));
    let Some(ref_url) = parsed_ref else {
        return FLOW_SSO_URL.to_string();
    };
    let continue_url = if crate::auth::is_signed_in_flow_url(reference_url) {
        promotion_target_url(Some(reference_url))
    } else {
        flow_workspace_root_url(reference_url)
    };
    let authuser = query_param(&ref_url, "authuser").or_else(|| path_authuser(ref_url.path()));
    let page_id = query_param(&ref_url, "pageId");
    if continue_url == FLOW_URL && authuser.is_none() && page_id.is_none() {
        return FLOW_SSO_URL.to_string();
    }
    let Ok(mut sso) = Url::parse(FLOW_SSO_URL) else {
        return FLOW_SSO_URL.to_string();
    };
    let existing: Vec<(String, String)> = sso
        .query_pairs()
        .filter(|(k, _)| k != "continue" && k != "followup" && k != "authuser" && k != "pageId")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    {
        let mut qp = sso.query_pairs_mut();
        qp.clear();
        for (k, v) in &existing {
            qp.append_pair(k, v);
        }
        if let Some(au) = authuser.as_deref() {
            qp.append_pair("authuser", au);
        }
        if let Some(pid) = page_id.as_deref() {
            qp.append_pair("pageId", pid);
        }
        qp.append_pair("continue", &continue_url);
        qp.append_pair("followup", &continue_url);
    }
    sso.into()
}

/// Builds a Google Flow `/project/<id>` or subroute URL with active prefixes, `hl=en`, `authuser`, and `pageId`.
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
        .map(|u| {
            if let Some((before, _)) = u.path().split_once("/project/") {
                let candidate = flow_route_prefix(before);
                if !candidate.is_empty() || before.trim_matches('/').is_empty() {
                    candidate
                } else {
                    before.trim_end_matches('/').to_string()
                }
            } else {
                flow_route_prefix(u.path())
            }
        })
        .unwrap_or_default();
    let authuser = parsed.as_ref().and_then(|u| query_param(u, "authuser"));
    let page_id = parsed.as_ref().and_then(|u| query_param(u, "pageId"));
    let clean_sub = subroute.trim_start_matches('/');
    let route_path = if clean_sub.is_empty() {
        format!("{prefix}/project/{project_id}")
    } else {
        format!("{prefix}/project/{project_id}/{clean_sub}")
    };
    if let Some(mut base) = parsed.or_else(|| Url::parse(FLOW_URL).ok()) {
        base.set_path(&route_path);
        apply_account_query_params(&mut base, authuser.as_deref(), page_id.as_deref());
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
