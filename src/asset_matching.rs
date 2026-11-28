// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Asset ID, variant media ID, and `<sceneId>:<wfId>` scene clip matching helpers.

use anyhow::{Context, Result};

use crate::assets::FlowAsset;

/// Strips a leading `media/` or `workflows/` prefix from a resource identifier.
pub(crate) fn strip_resource_prefix(raw: &str) -> &str {
    let trimmed = raw.trim();
    if trimmed.len() > 6 && trimmed[..6].eq_ignore_ascii_case("media/") {
        &trimmed[6..]
    } else if trimmed.len() > 10 && trimmed[..10].eq_ignore_ascii_case("workflows/") {
        &trimmed[10..]
    } else {
        trimmed
    }
}

/// Strips a leading `media/` prefix from a media resource identifier.
pub(crate) fn strip_media_prefix(raw: &str) -> &str {
    let trimmed = raw.trim();
    if trimmed.len() > 6 && trimmed[..6].eq_ignore_ascii_case("media/") {
        &trimmed[6..]
    } else {
        trimmed
    }
}

/// Finds the first asset matching `pred`, preferring `video`, `image`, and `audio` tiles over referencing `character` and `scene` tiles.
fn find_preferring_direct_media<F>(assets: &[FlowAsset], mut pred: F) -> Option<&FlowAsset>
where
    F: FnMut(&FlowAsset) -> bool,
{
    let mut fallback: Option<&FlowAsset> = None;
    for asset in assets {
        if pred(asset) {
            if !matches!(asset.kind.as_str(), "character" | "scene") {
                return Some(asset);
            }
            if fallback.is_none() {
                fallback = Some(asset);
            }
        }
    }
    fallback
}

/// Selects the best-matching asset by exact ID, media ID, exact name, name substring,
/// ID or media ID substring, or optional prompt substring.
pub(crate) fn match_asset<'a>(
    assets: &'a [FlowAsset],
    match_str: &str,
    include_prompt: bool,
) -> Option<&'a FlowAsset> {
    let raw = match_str.trim();
    if raw.is_empty() {
        return None;
    }
    let clean_raw = strip_media_prefix(raw);
    let clean_res = strip_resource_prefix(raw);
    let lower = raw.to_lowercase();
    let clean_lower = clean_raw.to_lowercase();
    let clean_res_lower = clean_res.to_lowercase();

    assets
        .iter()
        .find(|a| a.id == raw)
        .or_else(|| {
            find_preferring_direct_media(assets, |a| {
                a.workflow_id
                    .as_deref()
                    .is_some_and(|wf| wf == raw || strip_resource_prefix(wf) == clean_res)
            })
        })
        .or_else(|| {
            find_preferring_direct_media(assets, |a| {
                a.primary_media_id
                    .as_deref()
                    .is_some_and(|id| id == raw || strip_media_prefix(id) == clean_raw)
            })
        })
        .or_else(|| {
            find_preferring_direct_media(assets, |a| {
                a.media_ids
                    .iter()
                    .any(|id| id == raw || strip_media_prefix(id) == clean_raw)
            })
        })
        .or_else(|| assets.iter().find(|a| a.name.eq_ignore_ascii_case(raw)))
        .or_else(|| {
            assets
                .iter()
                .find(|a| a.name.to_lowercase().contains(&lower))
        })
        .or_else(|| {
            assets
                .iter()
                .find(|a| !a.id.contains(':') && a.id.to_lowercase().contains(&lower))
        })
        .or_else(|| assets.iter().find(|a| a.id.to_lowercase().contains(&lower)))
        .or_else(|| {
            find_preferring_direct_media(assets, |a| {
                a.workflow_id
                    .as_deref()
                    .is_some_and(|wf| wf.to_lowercase().contains(&clean_res_lower))
                    || a.primary_media_id
                        .as_deref()
                        .is_some_and(|id| id.to_lowercase().contains(&clean_lower))
                    || a.media_ids
                        .iter()
                        .any(|id| id.to_lowercase().contains(&clean_lower))
            })
        })
        .or_else(|| {
            if include_prompt {
                assets.iter().find(|a| {
                    a.prompt
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&lower)
                })
            } else {
                None
            }
        })
}

/// Pins `target.primary_media_id` when `match_str` selects a specific variant in `target.media_ids`.
pub(crate) fn pin_matched_variant_id(target: &mut FlowAsset, match_str: &str) {
    let raw = match_str.trim();
    if raw.is_empty() || target.id == raw || target.name.eq_ignore_ascii_case(raw) {
        return;
    }
    let clean_raw = strip_media_prefix(raw);
    let exact = target
        .media_ids
        .iter()
        .find(|id| id.as_str() == raw || strip_media_prefix(id) == clean_raw)
        .cloned();
    let lower = raw.to_lowercase();
    let clean_lower = clean_raw.to_lowercase();
    let matched = exact.or_else(|| {
        if target.name.to_lowercase().contains(&lower) || target.id.to_lowercase().contains(&lower)
        {
            return None;
        }
        target
            .media_ids
            .iter()
            .find(|id| id.to_lowercase().contains(&clean_lower))
            .cloned()
    });
    if let Some(variant_id) = matched {
        let normalized = strip_media_prefix(&variant_id).to_string();
        let changed =
            target.primary_media_id.as_deref().map(strip_media_prefix) != Some(normalized.as_str());
        target.primary_media_id = Some(normalized);
        if changed {
            target.url = None;
        }
    }
}

/// Resolves an explicit `<sceneId>:<wfId>` clip selector against a scene tile in `assets`.
pub(crate) fn resolve_scene_clip_selector(
    assets: &[FlowAsset],
    match_str: &str,
    context_label: &str,
) -> Result<Option<FlowAsset>> {
    let raw = match_str.trim();
    if assets.iter().any(|a| a.id == raw) {
        return Ok(None);
    }
    let Some((raw_scene, raw_wf)) = raw.split_once(':') else {
        return Ok(None);
    };
    let scene_key = strip_resource_prefix(raw_scene);
    let Some(scene) = assets
        .iter()
        .find(|a| a.kind == "scene" && (a.id == raw_scene.trim() || a.id == scene_key))
    else {
        return Ok(None);
    };
    let wf_id = strip_resource_prefix(raw_wf);
    if wf_id.is_empty() || wf_id.contains(':') {
        anyhow::bail!(
            "Invalid scene clip selector '{}' for {}: expected '<scene_id>:<workflow_id>'",
            raw,
            context_label
        );
    }
    let clip = scene
        .scene_clips
        .iter()
        .find(|c| c.workflow_id == wf_id || strip_resource_prefix(&c.workflow_id) == wf_id)
        .with_context(|| {
            format!(
                "Scene '{}' has no clip workflow '{}' for {}",
                scene.id, wf_id, context_label
            )
        })?;
    let standalone = assets.iter().find(|a| {
        a.kind == "video"
            && (a.id == clip.workflow_id
                || a.id == wf_id
                || a.workflow_id
                    .as_deref()
                    .is_some_and(|wf| wf == wf_id || strip_resource_prefix(wf) == wf_id))
    });
    let primary_media_id = clip
        .primary_media_id
        .clone()
        .or_else(|| standalone.and_then(|v| v.primary_media_id.clone()));
    let url = clip
        .url
        .clone()
        .or_else(|| standalone.and_then(|v| v.url.clone()));
    let mut media_ids = standalone.map(|v| v.media_ids.clone()).unwrap_or_default();
    if let Some(ref mid) = primary_media_id
        && !media_ids.iter().any(|existing| existing == mid)
    {
        media_ids.insert(0, mid.clone());
    }
    let resolved_id = if context_label == "flow_download" || standalone.is_none() {
        format!("{}:{}", scene.id, clip.workflow_id)
    } else if let Some(v) = standalone {
        v.id.clone()
    } else {
        format!("{}:{}", scene.id, clip.workflow_id)
    };
    let name = standalone
        .map(|v| v.name.clone())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| format!("{} ({})", scene.name, clip.workflow_id));
    Ok(Some(FlowAsset {
        id: resolved_id,
        name,
        kind: "video".to_string(),
        prompt: standalone.and_then(|v| v.prompt.clone()),
        url,
        collection_id: scene.collection_id.clone(),
        collection_name: scene.collection_name.clone(),
        width: standalone.and_then(|v| v.width),
        height: standalone.and_then(|v| v.height),
        duration: standalone.and_then(|v| v.duration),
        primary_media_id,
        personality_notes: None,
        voice: None,
        trim_start_seconds: standalone.and_then(|v| v.trim_start_seconds),
        trim_end_seconds: standalone.and_then(|v| v.trim_end_seconds),
        media_status: standalone.and_then(|v| v.media_status.clone()),
        media_error: standalone.and_then(|v| v.media_error.clone()),
        media_ids,
        workflow_id: Some(clip.workflow_id.clone()),
        requires_scene_export: false,
        pcm_audio: false,
        media_kind: Some("video".to_string()),
        variants: standalone.map(|v| v.variants.clone()).unwrap_or_default(),
        scene_clips: Vec::new(),
        created_at: standalone
            .and_then(|v| v.created_at.clone())
            .or_else(|| scene.created_at.clone()),
    }))
}
