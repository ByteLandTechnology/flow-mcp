// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Custom character voices, full voice lists, voice previews, and portrait removal on the character editor page.

use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::assets::{FlowAsset, list_assets_with_project, match_asset};
use crate::characters::{exit_character_editor, open_character_editor};
use crate::config::downloads_dir;
use crate::engine::{ChromeEngine, checked_runtime_result};
use crate::platform::{create_private_dir_all, write_private_file_atomic};
use crate::project::{ensure_flow_store, ensure_project_workspace_root, project_id_from_url};
use crate::queue::SceneParams;

/// Largest length of the Sample dialogue text that Google Flow accepts.
const MAX_SAMPLE_CHARS: usize = 120;

/// Parameters for `flow_voice_preview`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct VoicePreviewParams {
    /// Character ID or name substring whose voice preview to play and download.
    pub(crate) character: String,
    /// Base voice to audition instead of the saved character voice; Flow saves nothing.
    pub(crate) voice: Option<String>,
    /// Sample dialogue to audition with `voice` (120 characters at most).
    pub(crate) voice_sample: Option<String>,
    /// Customize performance text to audition with `voice`.
    pub(crate) voice_performance: Option<String>,
}

/// Voice settings to apply on an open character editor page.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct VoiceRequest<'a> {
    /// Base Flow voice name to select (for example `"Charon"`).
    pub(crate) voice: Option<&'a str>,
    /// Sample dialogue text of a custom voice.
    pub(crate) sample: Option<&'a str>,
    /// Customize performance text of a custom voice.
    pub(crate) performance: Option<&'a str>,
    /// Name of the custom voice to save.
    pub(crate) voice_name: Option<&'a str>,
}

impl VoiceRequest<'_> {
    /// Returns true when the request saves a custom voice.
    pub(crate) fn is_custom(&self) -> bool {
        self.sample.is_some_and(|s| !s.trim().is_empty())
            || self.performance.is_some_and(|s| !s.trim().is_empty())
    }

    /// Returns true when the request changes the voice at all.
    pub(crate) fn is_set(&self) -> bool {
        self.voice.is_some_and(|s| !s.trim().is_empty()) || self.is_custom()
    }
}

/// Returns the `error` string of a browser op result, or `fallback`.
fn op_error(res: &Value, fallback: &str) -> String {
    res.get("error")
        .and_then(|v| v.as_str())
        .unwrap_or(fallback)
        .to_string()
}

/// Returns true when a browser op result has `"ok": true`.
fn op_ok(res: &Value) -> bool {
    res.get("ok").and_then(|v| v.as_bool()) == Some(true)
}

/// Selects the base voice, saves a custom voice when sample or performance text is set, and adds it to the open character.
pub(crate) async fn apply_voice(engine: &ChromeEngine, req: VoiceRequest<'_>) -> Result<()> {
    if req.is_custom() {
        if req.voice.is_none_or(|v| v.trim().is_empty()) {
            anyhow::bail!(
                "A custom voice needs a base voice: set `voice` with `voice_sample` or `voice_performance`"
            );
        }
        if req
            .sample
            .is_some_and(|s| s.chars().count() > MAX_SAMPLE_CHARS)
        {
            anyhow::bail!(
                "`voice_sample` has more than {} characters",
                MAX_SAMPLE_CHARS
            );
        }
    }
    let res = engine
        .call_flow_async(
            "characterExtraOp",
            json!([{
                "action": "apply_voice",
                "voice": req.voice,
                "sample": req.sample,
                "performance": req.performance,
                "voice_name": req.voice_name,
            }]),
        )
        .await?;
    if !op_ok(&res)
        && let Some(list) = res.get("available_voices").and_then(Value::as_array)
    {
        let names: Vec<&str> = list.iter().filter_map(Value::as_str).collect();
        anyhow::bail!(
            "{} (available voices: {})",
            op_error(&res, "voice assignment failed"),
            names.join(", ")
        );
    }
    checked_runtime_result(res)?;
    Ok(())
}

/// Returns the voice settings of `scene`, with the custom voice name defaulting to `default_name`.
pub(crate) fn scene_voice<'a>(scene: &'a SceneParams, default_name: &'a str) -> VoiceRequest<'a> {
    VoiceRequest {
        voice: scene.voice.as_deref(),
        sample: scene.voice_sample.as_deref(),
        performance: scene.voice_performance.as_deref(),
        voice_name: scene.voice_name.as_deref().or(Some(default_name)),
    }
}

/// Applies `req` with `apply_voice`; if the voice dialog does not open for a plain voice, uses the older `characterVoiceOp` path.
pub(crate) async fn apply_voice_with_fallback(
    engine: &ChromeEngine,
    char_id: &str,
    req: VoiceRequest<'_>,
) -> Result<()> {
    let Err(err) = apply_voice(engine, req).await else {
        return Ok(());
    };
    if req.is_custom()
        || req.voice.is_none()
        || !err.to_string().contains("voice_dialog_not_available")
    {
        return Err(err);
    }
    let res = engine
        .call_flow_async(
            "characterVoiceOp",
            json!([{ "action": "set_voice", "character_id": char_id, "voice": req.voice }]),
        )
        .await?;
    if !op_ok(&res) {
        anyhow::bail!("{}", op_error(&res, "voice assignment failed"));
    }
    Ok(())
}

/// Deletes the portrait image of the open character so that a new portrait can be attached.
pub(crate) async fn delete_portrait(engine: &ChromeEngine) -> Result<()> {
    engine
        .bind_angular_views("flow-character-preview-panel, flow-character-image-preview")
        .await?;
    let res = engine
        .call_flow_async("characterExtraOp", json!([{ "action": "delete_portrait" }]))
        .await?;
    if !op_ok(&res) {
        anyhow::bail!("{}", op_error(&res, "portrait delete failed"));
    }
    let deleted = res.get("deleted").and_then(Value::as_bool) == Some(true);
    let empty = res.get("empty").and_then(Value::as_bool) == Some(true);
    if !deleted && !empty {
        anyhow::bail!("{}", op_error(&res, "portrait delete not confirmed"));
    }
    Ok(())
}

/// Scrolls the whole voice dialog list of the open character and returns all voices, or None on failure.
pub(crate) async fn list_all_voices(engine: &ChromeEngine) -> Option<Value> {
    engine
        .bind_angular_views("flow-character-form, flow-character-edit-page")
        .await
        .ok()?;
    let res = engine
        .call_flow_async("characterExtraOp", json!([{ "action": "list_all_voices" }]))
        .await
        .ok()?;
    if !op_ok(&res) {
        return None;
    }
    res.get("voices").cloned()
}

/// Opens a character, plays its voice preview (or auditions `voice` without saving), saves the audio under `<home>/downloads`, and returns the file path.
pub(crate) async fn preview_voice(
    engine: &ChromeEngine,
    req: &VoicePreviewParams,
) -> Result<Value> {
    let character = req.character.as_str();
    let audition = req
        .voice
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let has_text = [&req.voice_sample, &req.voice_performance]
        .iter()
        .any(|t| t.as_deref().is_some_and(|s| !s.trim().is_empty()));
    if audition.is_none() && has_text {
        anyhow::bail!("`voice_sample` and `voice_performance` need `voice` as the base voice");
    }
    if req
        .voice_sample
        .as_ref()
        .is_some_and(|s| s.chars().count() > MAX_SAMPLE_CHARS)
    {
        anyhow::bail!(
            "`voice_sample` has more than {} characters",
            MAX_SAMPLE_CHARS
        );
    }
    ensure_project_workspace_root(engine).await?;
    ensure_flow_store(engine).await?;
    let snap = list_assets_with_project(engine).await?;
    let cur_url = engine.current_url().await.unwrap_or_default();
    let project_id = snap
        .project_id
        .clone()
        .or_else(|| project_id_from_url(&cur_url))
        .context("Missing project ID for character route")?;
    let chars: Vec<FlowAsset> = snap
        .assets
        .into_iter()
        .filter(|a| a.kind == "character")
        .collect();
    let target = match_asset(&chars, character, false)
        .cloned()
        .with_context(|| format!("No character matches '{}' in active project", character))?;

    open_character_editor(engine, &cur_url, &project_id, &target.id).await?;
    let op = match audition {
        Some(voice) => json!([{
            "action": "audition_voice",
            "voice": voice,
            "sample": req.voice_sample,
            "performance": req.voice_performance,
        }]),
        None => json!([{ "action": "preview_voice" }]),
    };
    let res = async {
        engine
            .bind_angular_views("flow-character-form, flow-character-edit-page")
            .await?;
        engine.call_flow_async("characterExtraOp", op).await
    }
    .await;
    exit_character_editor(engine, Some(&project_id)).await;
    let res = res?;
    if !op_ok(&res) {
        anyhow::bail!(
            "Failed to preview voice of '{}': {}",
            target.name,
            op_error(&res, "unknown")
        );
    }
    let data = res
        .get("data")
        .and_then(|v| v.as_str())
        .context("Voice preview returned no audio data")?;
    let bytes = BASE64
        .decode(data)
        .context("Voice preview audio is not valid base64")?;
    let mime = res
        .get("mime")
        .and_then(|v| v.as_str())
        .unwrap_or("audio/wav");
    let ext = if mime.contains("mpeg") {
        "mp3"
    } else if mime.contains("ogg") {
        "ogg"
    } else {
        "wav"
    };
    let dir = downloads_dir();
    create_private_dir_all(&dir)?;
    let stamp = crate::db::now_epoch_ms();
    let label = audition.map_or_else(|| "saved".to_string(), |v| v.replace(['/', '\\', ' '], "_"));
    let path = dir.join(format!("voice-{}-{}-{}.{}", target.id, label, stamp, ext));
    write_private_file_atomic(&path, &bytes)?;
    Ok(json!({
        "character_id": target.id,
        "character": target.name,
        "voice": res.get("voice").cloned().unwrap_or(Value::Null),
        "audition": audition.is_some(),
        "file": path.display().to_string(),
        "mime_type": mime,
        "bytes": bytes.len(),
    }))
}
