// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Offline validation of Google Flow front-end build contracts and fallback stores.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

/// Managed Flow operations that every verified build must define.
const REQUIRED_OPERATIONS: &[&str] = &[
    "agent_chat",
    "agent_attachments",
    "agent_settings",
    "project_upload",
    "collection_write",
    "character_bio",
    "asset_trash_store",
];

/// Required `AgentExport` keys on every `AgentChatFormat` constant.
const REQUIRED_AGENT_EXPORTS: &[&str] = &[
    "allocate",
    "init",
    "sessionList",
    "readSession",
    "resume",
    "rows",
    "metadata",
    "string",
    "turnType",
    "turns",
    "decode",
    "hydrate",
    "reply",
    "permission",
    "plan",
    "newEnvelope",
    "setContent",
    "mutable",
    "finish",
    "newContent",
    "setParts",
    "newPart",
    "setText",
    "errors",
    "legacyDecision",
    "clearLegacyRequest",
    "oneOf",
    "toolEventType",
    "toolEventGroup",
    "toolResultType",
    "resultItems",
    "structFields",
    "valueString",
];

/// Required `AgentSettingsExport` keys on every `AgentSettingsFormat` constant.
const REQUIRED_AGENT_SETTINGS_EXPORTS: &[&str] = &[
    "projectService",
    "projectKey",
    "modelService",
    "modelKey",
    "fetchModels",
    "serviceTier",
    "locale",
    "modelOptions",
    "defaultModel",
    "selectModel",
    "aspectLabels",
    "videoAspects",
    "imageAspect",
    "videoAspect",
    "request",
    "settings",
    "mask",
    "card",
    "rpc",
    "updateMethod",
    "finish",
    "message",
    "maskPaths",
    "string",
    "strings",
    "enumValue",
    "integer",
    "boolean",
    "setCards",
    "setMemoryEnabled",
];

/// Required `AgentAttachmentExport` keys on every `AgentAttachmentFormat` constant.
const REQUIRED_AGENT_ATTACHMENT_EXPORTS: &[&str] = &[
    "reference",
    "message",
    "text",
    "id",
    "validateFiles",
    "isVideo",
    "mimeType",
    "imageSize",
    "videoInfo",
    "confirmUpload",
];

/// Required `PromptComposerExport` keys on every `PromptComposerFormat` constant.
const REQUIRED_PROMPT_COMPOSER_EXPORTS: &[&str] = &[
    "promptState",
    "setMode",
    "setModel",
    "setCount",
    "aspectLabels",
    "videoAspects",
];

/// Required string field keys on every `PromptComposerFormat` constant.
const REQUIRED_PROMPT_COMPOSER_FIELDS: &[&str] = &[
    "families",
    "activeFamily",
    "catalogFamilies",
    "modelId",
    "items",
    "disableReason",
    "clearOutput",
];

/// Validates `VERIFIED_BUILDS`, export tables, and registered stores offline.
pub(crate) fn check_flow_contracts(root: &Path) -> Vec<String> {
    let mut errors = Vec::new();
    let builds_rel = "ts/frontend_builds.ts";
    let builds_path = root.join(builds_rel);
    let Ok(raw_builds) = fs::read_to_string(&builds_path) else {
        errors.push(format!("{builds_rel}: cannot read Flow build definitions"));
        return errors;
    };
    let clean = strip_ts_comments(&raw_builds);

    check_string_array(
        builds_rel,
        &clean,
        "FRONTEND_OPERATIONS",
        REQUIRED_OPERATIONS,
        &mut errors,
    );
    check_string_array(
        builds_rel,
        &clean,
        "AGENT_EXPORTS",
        REQUIRED_AGENT_EXPORTS,
        &mut errors,
    );
    check_string_array(
        builds_rel,
        &clean,
        "AGENT_SETTINGS_EXPORTS",
        REQUIRED_AGENT_SETTINGS_EXPORTS,
        &mut errors,
    );
    check_string_array(
        builds_rel,
        &clean,
        "AGENT_ATTACHMENT_EXPORTS",
        REQUIRED_AGENT_ATTACHMENT_EXPORTS,
        &mut errors,
    );
    check_string_array(
        builds_rel,
        &clean,
        "PROMPT_COMPOSER_EXPORTS",
        REQUIRED_PROMPT_COMPOSER_EXPORTS,
        &mut errors,
    );

    check_typed_export_maps(
        builds_rel,
        &clean,
        "AgentChatFormat",
        REQUIRED_AGENT_EXPORTS,
        &mut errors,
    );
    check_typed_export_maps(
        builds_rel,
        &clean,
        "AgentSettingsFormat",
        REQUIRED_AGENT_SETTINGS_EXPORTS,
        &mut errors,
    );
    check_typed_export_maps(
        builds_rel,
        &clean,
        "AgentAttachmentFormat",
        REQUIRED_AGENT_ATTACHMENT_EXPORTS,
        &mut errors,
    );
    check_typed_export_maps(
        builds_rel,
        &clean,
        "PromptComposerFormat",
        REQUIRED_PROMPT_COMPOSER_EXPORTS,
        &mut errors,
    );
    check_typed_string_fields(
        builds_rel,
        &clean,
        "PromptComposerFormat",
        REQUIRED_PROMPT_COMPOSER_FIELDS,
        &mut errors,
    );

    let declared_stores = collect_typed_consts(&clean, "ProjectStoreFormat");
    if declared_stores.is_empty() {
        errors.push(format!(
            "{builds_rel}: no ProjectStoreFormat constants found"
        ));
    }
    let declared_composers = collect_typed_consts(&clean, "PromptComposerFormat");
    if declared_composers.is_empty() {
        errors.push(format!(
            "{builds_rel}: no PromptComposerFormat constants found"
        ));
    }

    let (build_stores, build_composers) = check_verified_builds(
        builds_rel,
        &clean,
        &declared_stores,
        &declared_composers,
        &mut errors,
    );
    for store in declared_stores.difference(&build_stores) {
        errors.push(format!(
            "{builds_rel}: store `{store}` has no registered build"
        ));
    }
    for composer in declared_composers.difference(&build_composers) {
        errors.push(format!(
            "{builds_rel}: promptComposer `{composer}` has no registered build"
        ));
    }

    let compat_rel = "ts/frontend_compatibility.ts";
    let compat_path = root.join(compat_rel);
    match fs::read_to_string(&compat_path) {
        Ok(raw_compat) => {
            let clean_compat = strip_ts_comments(&raw_compat);
            check_probe_store(compat_rel, &clean_compat, &mut errors);
        }
        Err(_) => errors.push(format!(
            "{compat_rel}: cannot read front-end compatibility probes"
        )),
    }

    errors
}

/// Replaces TypeScript comments with spaces while preserving string literals and newlines.
fn strip_ts_comments(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = String::with_capacity(src.len());
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                out.push(' ');
                i += 1;
            }
            continue;
        }
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                out.push(if bytes[i] == b'\n' { '\n' } else { ' ' });
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }
        if b == b'"' || b == b'\'' || b == b'`' {
            let quote = b;
            out.push(char::from(quote));
            i += 1;
            while i < bytes.len() {
                let ch = src[i..].chars().next().unwrap_or('\0');
                out.push(ch);
                i += ch.len_utf8();
                if ch == '\\' && i < bytes.len() {
                    let esc = src[i..].chars().next().unwrap_or('\0');
                    out.push(esc);
                    i += esc.len_utf8();
                    continue;
                }
                if ch == char::from(quote) {
                    break;
                }
            }
            continue;
        }
        let ch = src[i..].chars().next().unwrap_or('\0');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Finds the slice enclosed by matching `open` and `close` delimiters starting at or after `from`.
fn delimited_slice(src: &str, from: usize, open: u8, close: u8) -> Option<(&str, usize)> {
    let bytes = src.as_bytes();
    let mut i = from;
    while i < bytes.len() && bytes[i] != open {
        i += 1;
    }
    if i >= bytes.len() {
        return None;
    }
    let body_start = i + 1;
    let mut depth = 1usize;
    i += 1;
    while i < bytes.len() && depth > 0 {
        let b = bytes[i];
        if b == b'"' || b == b'\'' || b == b'`' {
            let quote = b;
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' {
                    i = (i + 2).min(bytes.len());
                    continue;
                }
                if bytes[i] == quote {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if b == open {
            depth += 1;
        } else if b == close {
            depth -= 1;
            if depth == 0 {
                return Some((&src[body_start..i], i + 1));
            }
        }
        i += 1;
    }
    None
}

/// Extracts double-quoted string literals at the top level of `body`.
fn top_level_strings(body: &str) -> Vec<String> {
    let bytes = body.as_bytes();
    let mut items = Vec::new();
    let mut depth = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'"' && depth == 0 {
            let start = i + 1;
            i += 1;
            while i < bytes.len() && bytes[i] != b'"' {
                if bytes[i] == b'\\' {
                    i = (i + 2).min(bytes.len());
                } else {
                    i += 1;
                }
            }
            if i <= bytes.len() {
                items.push(body[start..i].to_string());
            }
            i += 1;
            continue;
        }
        if matches!(b, b'{' | b'[' | b'(') {
            depth += 1;
        } else if matches!(b, b'}' | b']' | b')') {
            depth = depth.saturating_sub(1);
        }
        i += 1;
    }
    items
}

/// Extracts top-level `key: value` entries from a TypeScript object literal body.
fn top_level_object_entries(body: &str) -> Vec<(String, String)> {
    let bytes = body.as_bytes();
    let mut entries = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut i = 0usize;
    while i <= bytes.len() {
        let at_end = i == bytes.len();
        let b = if at_end { b',' } else { bytes[i] };
        if !at_end && (b == b'"' || b == b'\'' || b == b'`') {
            let quote = b;
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' {
                    i = (i + 2).min(bytes.len());
                    continue;
                }
                if bytes[i] == quote {
                    break;
                }
                i += 1;
            }
            i += 1;
            continue;
        }
        if !at_end && matches!(b, b'{' | b'[' | b'(') {
            depth += 1;
        } else if !at_end && matches!(b, b'}' | b']' | b')') {
            depth = depth.saturating_sub(1);
        } else if b == b',' && depth == 0 {
            let segment = body[start..i].trim();
            if let Some((raw_key, raw_val)) = split_top_colon(segment) {
                let key = raw_key.trim().trim_matches('"').to_string();
                let val = raw_val.trim().to_string();
                if !key.is_empty() {
                    entries.push((key, val));
                }
            }
            start = i + 1;
        }
        i += 1;
    }
    entries
}

/// Splits `segment` at its first top-level `:` character.
fn split_top_colon(segment: &str) -> Option<(&str, &str)> {
    let bytes = segment.as_bytes();
    let mut depth = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'"' || b == b'\'' || b == b'`' {
            let quote = b;
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' {
                    i = (i + 2).min(bytes.len());
                    continue;
                }
                if bytes[i] == quote {
                    break;
                }
                i += 1;
            }
            i += 1;
            continue;
        }
        if matches!(b, b'{' | b'[' | b'(') {
            depth += 1;
        } else if matches!(b, b'}' | b']' | b')') {
            depth = depth.saturating_sub(1);
        } else if b == b':' && depth == 0 {
            return Some((&segment[..i], &segment[i + 1..]));
        }
        i += 1;
    }
    None
}

/// Verifies that a named TypeScript string array constant contains the exact `expected` set.
fn check_string_array(
    label: &str,
    src: &str,
    const_name: &str,
    expected: &[&str],
    errors: &mut Vec<String>,
) {
    let needle = format!("const {const_name}");
    let Some(pos) = src.find(&needle) else {
        errors.push(format!("{label}: missing `{const_name}` constant"));
        return;
    };
    let Some(eq_rel) = src[pos..].find('=') else {
        errors.push(format!("{label}: `{const_name}` has no initializer"));
        return;
    };
    let Some((arr_body, _)) = delimited_slice(src, pos + eq_rel, b'[', b']') else {
        errors.push(format!("{label}: `{const_name}` is not an array literal"));
        return;
    };
    let found = top_level_strings(arr_body);
    let found_set: BTreeSet<&str> = found.iter().map(String::as_str).collect();
    if found.len() != found_set.len() {
        errors.push(format!(
            "{label}: `{const_name}` contains duplicate entries"
        ));
    }
    for req in expected {
        if !found_set.contains(req) {
            errors.push(format!(
                "{label}: `{const_name}` omits required entry `{req}`"
            ));
        }
    }
    if found_set.len() != expected.len() {
        errors.push(format!(
            "{label}: `{const_name}` has {} unique entries, expected {}",
            found_set.len(),
            expected.len()
        ));
    }
}

/// Collects `const <NAME>: <type_name>` constant identifiers in `src`.
fn collect_typed_consts(src: &str, type_name: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let marker = format!(": {type_name}");
    let mut offset = 0usize;
    while let Some(rel) = src[offset..].find(&marker) {
        let pos = offset + rel;
        let prefix = src[..pos].trim_end();
        if let Some(const_pos) = prefix.rfind("const ") {
            let candidate = prefix[const_pos + "const ".len()..].trim();
            if !candidate.is_empty()
                && candidate
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            {
                names.insert(candidate.to_string());
            }
        }
        offset = pos + marker.len();
    }
    names
}

/// Verifies `exports` maps on every constant of type `type_name`.
fn check_typed_export_maps(
    label: &str,
    src: &str,
    type_name: &str,
    expected: &[&str],
    errors: &mut Vec<String>,
) {
    let consts = collect_typed_consts(src, type_name);
    if consts.is_empty() {
        errors.push(format!("{label}: no `{type_name}` constants found"));
        return;
    }
    for name in consts {
        let needle = format!("const {name}: {type_name}");
        let Some(pos) = src.find(&needle) else {
            continue;
        };
        let Some((obj_body, _)) = delimited_slice(src, pos + needle.len(), b'{', b'}') else {
            errors.push(format!("{label}: `{name}` has no object literal"));
            continue;
        };
        let entries = top_level_object_entries(obj_body);
        let Some((_, exports_val)) = entries.iter().find(|(k, _)| k == "exports") else {
            errors.push(format!("{label}: `{name}` omits `exports`"));
            continue;
        };
        let Some((exports_body, _)) = delimited_slice(exports_val, 0, b'{', b'}') else {
            errors.push(format!(
                "{label}: `{name}.exports` is not an object literal"
            ));
            continue;
        };
        let export_entries = top_level_object_entries(exports_body);
        let mut keys = BTreeSet::new();
        for (k, v) in &export_entries {
            let unquoted = v.trim_matches('"');
            if !v.starts_with('"') || !v.ends_with('"') || unquoted.is_empty() {
                errors.push(format!(
                    "{label}: `{name}.exports.{k}` must be a non-empty string literal"
                ));
            }
            keys.insert(k.as_str());
        }
        for req in expected {
            if !keys.contains(req) {
                errors.push(format!(
                    "{label}: `{name}.exports` omits required export `{req}`"
                ));
            }
        }
    }
}

/// Verifies top-level string literal fields on every constant of type `type_name`.
fn check_typed_string_fields(
    label: &str,
    src: &str,
    type_name: &str,
    expected: &[&str],
    errors: &mut Vec<String>,
) {
    for name in collect_typed_consts(src, type_name) {
        let needle = format!("const {name}: {type_name}");
        let Some(pos) = src.find(&needle) else {
            continue;
        };
        let Some((obj_body, _)) = delimited_slice(src, pos + needle.len(), b'{', b'}') else {
            continue;
        };
        let entries = top_level_object_entries(obj_body);
        for req in expected {
            match entries.iter().find(|(k, _)| k == req) {
                Some((_, val)) => {
                    let unquoted = val.trim_matches('"');
                    if !val.starts_with('"') || !val.ends_with('"') || unquoted.is_empty() {
                        errors.push(format!(
                            "{label}: `{name}.{req}` must be a non-empty string literal"
                        ));
                    }
                }
                None => errors.push(format!("{label}: `{name}` omits required field `{req}`")),
            }
        }
    }
}

/// Validates every entry in `VERIFIED_BUILDS` and returns referenced stores and prompt composers.
fn check_verified_builds(
    label: &str,
    src: &str,
    declared_stores: &BTreeSet<String>,
    declared_composers: &BTreeSet<String>,
    errors: &mut Vec<String>,
) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut used_stores = BTreeSet::new();
    let mut used_composers = BTreeSet::new();
    let Some(pos) = src.find("const VERIFIED_BUILDS") else {
        errors.push(format!("{label}: missing `VERIFIED_BUILDS` map"));
        return (used_stores, used_composers);
    };
    let Some(map_pos) = src[pos..].find("new Map") else {
        errors.push(format!(
            "{label}: `VERIFIED_BUILDS` must initialize `new Map([...])`"
        ));
        return (used_stores, used_composers);
    };
    let Some((arr_body, _)) = delimited_slice(src, pos + map_pos, b'[', b']') else {
        errors.push(format!(
            "{label}: `VERIFIED_BUILDS` has no entry array literal"
        ));
        return (used_stores, used_composers);
    };

    let mut cursor = 0usize;
    let mut build_count = 0usize;
    while let Some((tuple_body, next_cursor)) = delimited_slice(arr_body, cursor, b'[', b']') {
        cursor = next_cursor;
        let tuple_strings = top_level_strings(tuple_body);
        let Some(build_id) = tuple_strings.first() else {
            errors.push(format!(
                "{label}: `VERIFIED_BUILDS` entry has no build label string"
            ));
            continue;
        };
        if !build_id.starts_with("boq_labs-ai-sandbox-frontend_") {
            errors.push(format!(
                "{label}: invalid Flow build label `{build_id}` in `VERIFIED_BUILDS`"
            ));
        }
        let Some((build_obj, _)) = delimited_slice(tuple_body, 0, b'{', b'}') else {
            errors.push(format!(
                "{label}: build `{build_id}` in `VERIFIED_BUILDS` has no configuration object"
            ));
            continue;
        };
        build_count += 1;
        let fields = top_level_object_entries(build_obj);
        match fields.iter().find(|(k, _)| k == "projectStore") {
            Some((_, store_ident)) if declared_stores.contains(store_ident.as_str()) => {
                used_stores.insert(store_ident.clone());
            }
            Some((_, store_ident)) => errors.push(format!(
                "{label}: build `{build_id}` references unknown projectStore `{store_ident}`"
            )),
            None => errors.push(format!("{label}: build `{build_id}` omits `projectStore`")),
        }
        if let Some((_, composer_ident)) = fields.iter().find(|(k, _)| k == "promptComposer") {
            if declared_composers.contains(composer_ident.as_str()) {
                used_composers.insert(composer_ident.clone());
            } else {
                errors.push(format!(
                    "{label}: build `{build_id}` references unknown promptComposer `{composer_ident}`"
                ));
            }
        }
        let Some((_, ops_val)) = fields.iter().find(|(k, _)| k == "operations") else {
            errors.push(format!("{label}: build `{build_id}` omits `operations`"));
            continue;
        };
        let Some((ops_body, _)) = delimited_slice(ops_val, 0, b'{', b'}') else {
            errors.push(format!(
                "{label}: build `{build_id}` `operations` is not an object literal"
            ));
            continue;
        };
        let ops_entries = top_level_object_entries(ops_body);
        let ops_keys: BTreeSet<&str> = ops_entries.iter().map(|(k, _)| k.as_str()).collect();
        let legacy = fields
            .iter()
            .any(|(key, value)| key == "legacy" && value == "true");
        for op in REQUIRED_OPERATIONS {
            if legacy
                && !matches!(
                    *op,
                    "collection_write" | "asset_trash_store" | "character_bio"
                )
            {
                continue;
            }
            if !ops_keys.contains(op) {
                errors.push(format!(
                    "{label}: build `{build_id}` in `VERIFIED_BUILDS` omits operation `{op}`"
                ));
            }
        }
    }

    if build_count == 0 {
        errors.push(format!("{label}: `VERIFIED_BUILDS` must not be empty"));
    }
    (used_stores, used_composers)
}

/// Verifies that `probeStore()` checks managed operations, `promptComposer`, and build status.
fn check_probe_store(label: &str, src: &str, errors: &mut Vec<String>) {
    let Some(fn_pos) = src.find("export function probeStore") else {
        errors.push(format!("{label}: missing `export function probeStore`"));
        return;
    };
    let Some((fn_body, _)) = delimited_slice(src, fn_pos, b'{', b'}') else {
        errors.push(format!("{label}: `probeStore` has no function body"));
        return;
    };
    for op in REQUIRED_OPERATIONS {
        let key = format!("{op}:");
        if !fn_body.contains(&key) {
            errors.push(format!(
                "{label}: `probeStore` omits compatibility check for `{op}`"
            ));
        }
    }
    if !fn_body.contains("promptComposerCheck") {
        errors.push(format!(
            "{label}: `probeStore` omits runtime check for `promptComposer`"
        ));
    }
    if !fn_body.contains("FRONTEND_OPERATIONS.every") {
        errors.push(format!(
            "{label}: `probeStore` must require all `FRONTEND_OPERATIONS` in top-level `ok`"
        ));
    }
}
