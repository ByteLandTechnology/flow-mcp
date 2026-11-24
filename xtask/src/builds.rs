// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Offline static verification of Flow front-end build maps and store fallbacks.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use crate::builds_parse::{
    BUILDS_REL_PATH, ConstDef, TsTok, TsTokKind, TsVal, collect_top_level_consts, err_at, is_ident,
    is_punct, object_map, parse_array, resolve, skip_balanced, tokenize_ts, val_line,
};

/// Required prefix on every verified Google Flow front-end build label.
const BUILD_LABEL_PREFIX: &str = "boq_labs-ai-sandbox-frontend_";

/// Seven managed internal operations required on every entry in `VERIFIED_BUILDS`.
const REQUIRED_OPERATIONS: &[&str] = &[
    "agent_chat",
    "agent_attachments",
    "project_upload",
    "agent_settings",
    "collection_write",
    "asset_trash_store",
    "character_bio",
];

/// Required string fields on every `ProjectStoreFormat` constant.
const STORE_FIELDS: &[&str] = &[
    "storeClass",
    "lifecycle",
    "destroyed",
    "projectId",
    "tilesService",
    "queryClient",
    "dispatcher",
    "rows",
];

/// Required string fields on `collection_write`.
const COLLECTION_WRITE_FIELDS: &[&str] = &["tileId", "tileChange", "moveTarget", "moveTiles"];

/// Required string fields on `asset_trash_store`.
const ASSET_TRASH_FIELDS: &[&str] = &[
    "entries",
    "tile",
    "trashed",
    "date",
    "destination",
    "sceneWorkflows",
];

/// Required string fields on `character_bio`.
const CHARACTER_BIO_FIELDS: &[&str] = &["tileId", "tileChange", "notes"];

/// Required top-level string fields on `agent_chat`.
const AGENT_CHAT_FIELDS: &[&str] = &[
    "page",
    "transport",
    "injector",
    "composer",
    "permissions",
    "questions",
    "project",
    "lifecycle",
    "destroyed",
];

/// Required 33 browser export keys on `agent_chat.exports`.
const AGENT_CHAT_EXPORTS: &[&str] = &[
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

/// Required top-level string fields on `agent_settings`.
const AGENT_SETTINGS_FIELDS: &[&str] = &["queryClient", "requestClient"];

/// Required 30 browser export keys on `agent_settings.exports`.
const AGENT_SETTINGS_EXPORTS: &[&str] = &[
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

/// Required top-level string fields on `agent_attachments`.
const AGENT_ATTACHMENT_TOP_FIELDS: &[&str] = &[
    "store",
    "tiles",
    "tileQuery",
    "dispatcher",
    "injector",
    "consent",
];

/// Required 10 browser export keys on `agent_attachments.exports`.
const AGENT_ATTACHMENT_EXPORTS: &[&str] = &[
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

/// Required 12 protocol field keys on `agent_attachments.fields`.
const AGENT_ATTACHMENT_FIELDS: &[&str] = &[
    "character",
    "text",
    "references",
    "accepted",
    "errors",
    "duration",
    "workflow",
    "media",
    "file",
    "date",
    "dimensions",
    "completion",
];

/// Required page fields on `project_upload.page`.
const UPLOAD_PAGE_FIELDS: &[&str] = &["page", "lifecycle", "destroyed", "project"];

/// Required top-level media fields on `project_upload.media`.
const UPLOAD_MEDIA_TOP_FIELDS: &[&str] = &["dispatcher", "injector", "consent"];

/// Required 7 upload export keys on `project_upload.media.exports`.
const UPLOAD_MEDIA_EXPORTS: &[&str] = &[
    "id",
    "validateFiles",
    "isVideo",
    "mimeType",
    "imageSize",
    "videoInfo",
    "confirmUpload",
];

/// Required 9 upload field keys on `project_upload.media.fields`.
const UPLOAD_MEDIA_FIELDS: &[&str] = &[
    "accepted",
    "errors",
    "duration",
    "workflow",
    "media",
    "file",
    "date",
    "dimensions",
    "completion",
];

/// Validates `VERIFIED_BUILDS` and `projectStoreFormats` in `ts/frontend_builds.ts`.
pub(crate) fn check_frontend_builds(root: &Path) -> Vec<String> {
    let path = root.join(BUILDS_REL_PATH);
    let raw = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(err) => return vec![format!("{BUILDS_REL_PATH}: failed to read file: {err}")],
    };

    let mut errors = Vec::new();
    let tokens = match tokenize_ts(&raw) {
        Ok(list) => list,
        Err(err) => return vec![format!("{BUILDS_REL_PATH}:{err}")],
    };

    check_frontend_formats_interface(&tokens, &mut errors);
    let consts = collect_top_level_consts(&tokens, &mut errors);
    let store_names = check_store_constants(&consts, &mut errors);
    let used_stores = check_verified_builds(&tokens, &consts, &store_names, &mut errors);
    check_project_store_fallbacks(&tokens, &store_names, &used_stores, &mut errors);
    errors
}

/// Verifies `interface FrontendFormats` declares all seven managed operations as required fields.
fn check_frontend_formats_interface(tokens: &[TsTok], errors: &mut Vec<String>) {
    let mut i = 0usize;
    while i + 2 < tokens.len() {
        if is_ident(tokens, i, "interface")
            && is_ident(tokens, i + 1, "FrontendFormats")
            && is_punct(tokens, i + 2, '{')
        {
            let iface_line = tokens[i].line;
            let Some(end) = skip_balanced(tokens, i + 2, '{', '}') else {
                errors.push(err_at(iface_line, "unterminated FrontendFormats interface"));
                return;
            };
            let mut fields = BTreeSet::new();
            let mut j = i + 3;
            while j + 1 < end - 1 {
                if let TsTokKind::Ident(field) = &tokens[j].kind {
                    if is_punct(tokens, j + 1, '?') {
                        errors.push(err_at(
                            tokens[j].line,
                            format!("FrontendFormats.{field} must not be optional"),
                        ));
                    }
                    if is_punct(tokens, j + 1, ':') {
                        fields.insert(field.clone());
                    }
                }
                while j < end - 1 && !is_punct(tokens, j, ';') {
                    j += 1;
                }
                j += 1;
            }
            for &op in REQUIRED_OPERATIONS {
                if !fields.contains(op) {
                    errors.push(err_at(
                        iface_line,
                        format!("FrontendFormats omits required operation `{op}`"),
                    ));
                }
            }
            return;
        }
        i += 1;
    }
    errors.push(err_at(1, "missing `interface FrontendFormats`"));
}

/// Verifies that an object literal has non-empty string values for every key in `required`.
fn check_required_strings(
    ctx: &str,
    val: &TsVal,
    consts: &BTreeMap<String, ConstDef>,
    required: &[&str],
    exact: bool,
    errors: &mut Vec<String>,
) {
    let Some((map, line)) = object_map(ctx, val, consts, errors) else {
        return;
    };
    for &req in required {
        match map.get(req) {
            None => errors.push(err_at(line, format!("{ctx} omits required key `{req}`"))),
            Some((v, k_line)) => match resolve(v, consts) {
                TsVal::Str(s, _) if !s.trim().is_empty() => {}
                _ => errors.push(err_at(
                    *k_line,
                    format!("{ctx}.{req} must be a non-empty string"),
                )),
            },
        }
    }
    if exact {
        for (k, (_, k_line)) in &map {
            if !required.contains(k) {
                errors.push(err_at(*k_line, format!("{ctx} has unexpected key `{k}`")));
            }
        }
    }
}

/// Validates all `ProjectStoreFormat` constants and returns their names.
fn check_store_constants(
    consts: &BTreeMap<String, ConstDef>,
    errors: &mut Vec<String>,
) -> BTreeSet<String> {
    let mut stores = BTreeSet::new();
    for (name, def) in consts {
        if def.type_name.as_deref() == Some("ProjectStoreFormat") {
            stores.insert(name.clone());
            check_required_strings(name, &def.value, consts, STORE_FIELDS, false, errors);
        }
    }
    if stores.is_empty() {
        errors.push(err_at(
            1,
            "expected at least one `ProjectStoreFormat` constant",
        ));
    }
    stores
}

/// Validates every entry in `VERIFIED_BUILDS` and returns the referenced store constant names.
fn check_verified_builds(
    tokens: &[TsTok],
    consts: &BTreeMap<String, ConstDef>,
    store_names: &BTreeSet<String>,
    errors: &mut Vec<String>,
) -> BTreeSet<String> {
    let mut used_stores = BTreeSet::new();
    let Some(builds_def) = consts.get("VERIFIED_BUILDS") else {
        let line = tokens.first().map_or(1, |t| t.line);
        errors.push(err_at(line, "missing `VERIFIED_BUILDS` constant"));
        return used_stores;
    };
    let TsVal::Array(entries, map_line) = &builds_def.value else {
        errors.push(err_at(
            builds_def.line,
            "`VERIFIED_BUILDS` must be a `new Map([...])` entry array",
        ));
        return used_stores;
    };
    if entries.is_empty() {
        errors.push(err_at(*map_line, "`VERIFIED_BUILDS` must not be empty"));
        return used_stores;
    }

    let mut seen_labels = BTreeSet::new();
    for entry in entries {
        let TsVal::Array(pair, pair_line) = entry else {
            errors.push(err_at(
                val_line(entry),
                "`VERIFIED_BUILDS` entry must be a `[label, build]` tuple",
            ));
            continue;
        };
        if pair.len() != 2 {
            errors.push(err_at(
                *pair_line,
                "`VERIFIED_BUILDS` tuple must have 2 elements",
            ));
            continue;
        }
        let TsVal::Str(label, label_line) = &pair[0] else {
            errors.push(err_at(
                val_line(&pair[0]),
                "build label must be a string literal",
            ));
            continue;
        };
        if !label.starts_with(BUILD_LABEL_PREFIX) || label.len() <= BUILD_LABEL_PREFIX.len() {
            errors.push(err_at(
                *label_line,
                format!("build label `{label}` must start with `{BUILD_LABEL_PREFIX}`"),
            ));
        }
        if !seen_labels.insert(label.clone()) {
            errors.push(err_at(
                *label_line,
                format!("duplicate build label `{label}` in `VERIFIED_BUILDS`"),
            ));
        }
        check_single_build(
            label,
            &pair[1],
            consts,
            store_names,
            &mut used_stores,
            errors,
        );
    }

    used_stores
}

/// Validates `projectStore` and all seven `operations` on a single `VERIFIED_BUILDS` entry.
fn check_single_build(
    label: &str,
    build_val: &TsVal,
    consts: &BTreeMap<String, ConstDef>,
    store_names: &BTreeSet<String>,
    used_stores: &mut BTreeSet<String>,
    errors: &mut Vec<String>,
) {
    let ctx = format!("VERIFIED_BUILDS[{label}]");
    let Some((build_map, build_line)) = object_map(&ctx, build_val, consts, errors) else {
        return;
    };

    match build_map.get("projectStore") {
        None => errors.push(err_at(
            build_line,
            format!("{ctx} omits required `projectStore`"),
        )),
        Some((TsVal::Ident(store_ident, s_line), _)) => {
            if store_names.contains(store_ident) {
                used_stores.insert(store_ident.clone());
            } else {
                errors.push(err_at(
                    *s_line,
                    format!(
                        "{ctx}.projectStore `{store_ident}` is not a ProjectStoreFormat constant"
                    ),
                ));
            }
        }
        Some((other, _)) => check_required_strings(
            &format!("{ctx}.projectStore"),
            other,
            consts,
            STORE_FIELDS,
            false,
            errors,
        ),
    }

    let Some((ops_val, _)) = build_map.get("operations") else {
        errors.push(err_at(
            build_line,
            format!("{ctx} omits required `operations`"),
        ));
        return;
    };
    let ops_ctx = format!("{ctx}.operations");
    let Some((ops_map, ops_line)) = object_map(&ops_ctx, ops_val, consts, errors) else {
        return;
    };

    for &op in REQUIRED_OPERATIONS {
        if !ops_map.contains_key(op) {
            errors.push(err_at(
                ops_line,
                format!("{ops_ctx} omits required operation `{op}`"),
            ));
        }
    }
    for (op_key, (_, k_line)) in &ops_map {
        if !REQUIRED_OPERATIONS.contains(op_key) {
            errors.push(err_at(
                *k_line,
                format!("{ops_ctx} has unknown operation `{op_key}`"),
            ));
        }
    }

    if let Some((v, _)) = ops_map.get("collection_write") {
        check_required_strings(
            &format!("{ops_ctx}.collection_write"),
            v,
            consts,
            COLLECTION_WRITE_FIELDS,
            false,
            errors,
        );
    }
    if let Some((v, _)) = ops_map.get("asset_trash_store") {
        check_required_strings(
            &format!("{ops_ctx}.asset_trash_store"),
            v,
            consts,
            ASSET_TRASH_FIELDS,
            true,
            errors,
        );
    }
    if let Some((v, _)) = ops_map.get("character_bio") {
        check_required_strings(
            &format!("{ops_ctx}.character_bio"),
            v,
            consts,
            CHARACTER_BIO_FIELDS,
            true,
            errors,
        );
    }
    if let Some((v, _)) = ops_map.get("agent_chat") {
        check_nested_exports(
            &format!("{ops_ctx}.agent_chat"),
            v,
            consts,
            AGENT_CHAT_FIELDS,
            AGENT_CHAT_EXPORTS,
            errors,
        );
    }
    if let Some((v, _)) = ops_map.get("agent_settings") {
        check_nested_exports(
            &format!("{ops_ctx}.agent_settings"),
            v,
            consts,
            AGENT_SETTINGS_FIELDS,
            AGENT_SETTINGS_EXPORTS,
            errors,
        );
    }
    if let Some((v, _)) = ops_map.get("agent_attachments") {
        check_attachments_format(&format!("{ops_ctx}.agent_attachments"), v, consts, errors);
    }
    if let Some((v, _)) = ops_map.get("project_upload") {
        check_project_upload_format(&format!("{ops_ctx}.project_upload"), v, consts, errors);
    }
}

/// Validates an operation object with top-level string fields and an `exports` map.
fn check_nested_exports(
    ctx: &str,
    val: &TsVal,
    consts: &BTreeMap<String, ConstDef>,
    top_fields: &[&str],
    export_keys: &[&str],
    errors: &mut Vec<String>,
) {
    check_required_strings(ctx, val, consts, top_fields, false, errors);
    let Some((map, line)) = object_map(ctx, val, consts, errors) else {
        return;
    };
    match map.get("exports") {
        None => errors.push(err_at(line, format!("{ctx} omits `exports`"))),
        Some((exports_val, _)) => check_required_strings(
            &format!("{ctx}.exports"),
            exports_val,
            consts,
            export_keys,
            true,
            errors,
        ),
    }
}

/// Validates `agent_attachments` top-level fields, `exports`, and `fields`.
fn check_attachments_format(
    ctx: &str,
    val: &TsVal,
    consts: &BTreeMap<String, ConstDef>,
    errors: &mut Vec<String>,
) {
    check_nested_exports(
        ctx,
        val,
        consts,
        AGENT_ATTACHMENT_TOP_FIELDS,
        AGENT_ATTACHMENT_EXPORTS,
        errors,
    );
    let Some((map, line)) = object_map(ctx, val, consts, errors) else {
        return;
    };
    match map.get("fields") {
        None => errors.push(err_at(line, format!("{ctx} omits `fields`"))),
        Some((fields_val, _)) => check_required_strings(
            &format!("{ctx}.fields"),
            fields_val,
            consts,
            AGENT_ATTACHMENT_FIELDS,
            true,
            errors,
        ),
    }
}

/// Validates `project_upload` `page` and `media` sub-formats.
fn check_project_upload_format(
    ctx: &str,
    val: &TsVal,
    consts: &BTreeMap<String, ConstDef>,
    errors: &mut Vec<String>,
) {
    let Some((map, line)) = object_map(ctx, val, consts, errors) else {
        return;
    };
    match map.get("page") {
        None => errors.push(err_at(line, format!("{ctx} omits `page`"))),
        Some((page_val, _)) => check_required_strings(
            &format!("{ctx}.page"),
            page_val,
            consts,
            UPLOAD_PAGE_FIELDS,
            false,
            errors,
        ),
    }
    match map.get("media") {
        None => errors.push(err_at(line, format!("{ctx} omits `media`"))),
        Some((media_val, _)) => {
            let media_ctx = format!("{ctx}.media");
            check_required_strings(
                &media_ctx,
                media_val,
                consts,
                UPLOAD_MEDIA_TOP_FIELDS,
                false,
                errors,
            );
            if let Some((media_map, media_line)) = object_map(&media_ctx, media_val, consts, errors)
            {
                match media_map.get("exports") {
                    None => errors.push(err_at(media_line, format!("{media_ctx} omits `exports`"))),
                    Some((exp_val, _)) => check_required_strings(
                        &format!("{media_ctx}.exports"),
                        exp_val,
                        consts,
                        UPLOAD_MEDIA_EXPORTS,
                        false,
                        errors,
                    ),
                }
                match media_map.get("fields") {
                    None => errors.push(err_at(media_line, format!("{media_ctx} omits `fields`"))),
                    Some((fld_val, _)) => check_required_strings(
                        &format!("{media_ctx}.fields"),
                        fld_val,
                        consts,
                        UPLOAD_MEDIA_FIELDS,
                        false,
                        errors,
                    ),
                }
            }
        }
    }
}

/// Verifies `projectStoreFormats()` fallback array includes every `ProjectStoreFormat` constant.
fn check_project_store_fallbacks(
    tokens: &[TsTok],
    store_names: &BTreeSet<String>,
    used_stores: &BTreeSet<String>,
    errors: &mut Vec<String>,
) {
    let mut i = 0usize;
    while i + 1 < tokens.len() {
        if is_ident(tokens, i, "function") && is_ident(tokens, i + 1, "projectStoreFormats") {
            let fn_line = tokens[i].line;
            let mut j = i + 2;
            while j < tokens.len() && !is_punct(tokens, j, '{') {
                j += 1;
            }
            let Some(end) = skip_balanced(tokens, j, '{', '}') else {
                errors.push(err_at(
                    fn_line,
                    "unterminated `projectStoreFormats` function body",
                ));
                return;
            };
            let mut fallback = None;
            let mut k = j + 1;
            while k < end - 1 {
                if is_punct(tokens, k, ':') && is_punct(tokens, k + 1, '[') {
                    match parse_array(tokens, k + 1) {
                        Ok((TsVal::Array(items, arr_line), _)) => {
                            fallback = Some((items, arr_line));
                            break;
                        }
                        Ok(_) => {}
                        Err(err) => {
                            errors.push(err);
                            return;
                        }
                    }
                }
                k += 1;
            }
            let Some((items, arr_line)) = fallback else {
                errors.push(err_at(
                    fn_line,
                    "`projectStoreFormats` must return a fallback `[...]` store array",
                ));
                return;
            };
            let mut listed = BTreeSet::new();
            for item in &items {
                match item {
                    TsVal::Ident(name, line) => {
                        if !store_names.contains(name) {
                            errors.push(err_at(
                                *line,
                                format!(
                                    "`projectStoreFormats` fallback `{name}` is not a ProjectStoreFormat constant"
                                ),
                            ));
                        }
                        if !listed.insert(name.clone()) {
                            errors.push(err_at(
                                *line,
                                format!("`projectStoreFormats` duplicates fallback `{name}`"),
                            ));
                        }
                    }
                    other => errors.push(err_at(
                        val_line(other),
                        "`projectStoreFormats` fallback entries must reference ProjectStoreFormat constants",
                    )),
                }
            }
            for store in store_names.union(used_stores) {
                if !listed.contains(store) {
                    errors.push(err_at(
                        arr_line,
                        format!("`projectStoreFormats` fallback array omits `{store}`"),
                    ));
                }
            }
            return;
        }
        i += 1;
    }
    errors.push(err_at(1, "missing `function projectStoreFormats`"));
}
