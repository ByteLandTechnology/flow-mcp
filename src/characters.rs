// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Google Flow character entity workflows, voice discovery, and SQLite persistence.

use anyhow::{Context, Result};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use tokio::time::{Duration, Instant};

use crate::assets::{FlowAsset, list_assets_with_project, match_asset, trash_asset};
use crate::character_bio::{edit_character_bio, set_character_bio};
use crate::db::FlowDb;
use crate::download::download_resolved_asset;
use crate::engine::{ChromeEngine, checked_runtime_result, validate_local_files};
use crate::generation::inspect_generation_network;
use crate::project::{
    ensure_flow_store, ensure_project_workspace_root, project_id_from_url, project_subroute_url,
    project_workspace_url,
};
use crate::project_store::ProjectStoreSession;
use crate::queue::{ProgressCallback, SceneParams};
use crate::voices::{
    VoiceRequest, apply_voice_with_fallback, delete_portrait, list_all_voices, scene_voice,
};

/// Parameters for `flow_character`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct CharacterParams {
    /// Character display name in Google Flow.
    pub(crate) name: String,
    /// Visual look description or biography fallback when `bio` is omitted.
    pub(crate) description: Option<String>,
    /// Character introduction or personality notes.
    pub(crate) bio: Option<String>,
    /// Flow voice name (for example `"Kore"`, `"Charon"`, or from `flow_voices`).
    pub(crate) voice: Option<String>,
    /// Sample dialogue of a custom voice (120 characters at most); needs `voice` as the base voice.
    pub(crate) voice_sample: Option<String>,
    /// Customize performance text of a custom voice (style, age, pace, language); needs `voice` as the base voice.
    pub(crate) voice_performance: Option<String>,
    /// Name of the custom voice to save (defaults to the character name).
    pub(crate) voice_name: Option<String>,
    /// Existing project image asset IDs to attach as character looks.
    pub(crate) asset_ids: Option<Vec<String>>,
    /// Local reference image paths to upload as character looks.
    pub(crate) refs: Option<Vec<String>>,
    /// Optional prompt to generate a character look inside the character editor.
    pub(crate) prompt: Option<String>,
}

/// Parameters for `flow_character_edit`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct CharacterEditParams {
    /// Existing character ID or name substring to edit.
    pub(crate) name: String,
    /// Updated character display name.
    pub(crate) new_name: Option<String>,
    /// Updated character introduction or personality notes.
    pub(crate) bio: Option<String>,
    /// Updated Flow voice name.
    pub(crate) voice: Option<String>,
    /// Sample dialogue of a custom voice (120 characters at most); needs `voice` as the base voice.
    pub(crate) voice_sample: Option<String>,
    /// Customize performance text of a custom voice (style, age, pace, language); needs `voice` as the base voice.
    pub(crate) voice_performance: Option<String>,
    /// Name of the custom voice to save (defaults to the character name).
    pub(crate) voice_name: Option<String>,
    /// Delete the current portrait before `asset_ids` attaches a new one.
    pub(crate) replace_portrait: Option<bool>,
    /// Project image asset IDs to attach as character looks.
    pub(crate) asset_ids: Option<Vec<String>>,
    /// Local image paths to upload as character looks.
    pub(crate) refs: Option<Vec<String>>,
    /// Optional edit or look generation prompt for the character.
    pub(crate) prompt: Option<String>,
}

/// Parameters for `flow_voices`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct VoicesParams {
    /// Optional character ID or name whose editor opens the voice picker.
    pub(crate) character: Option<String>,
}

/// Saves `scene.character_look` under `scene.character_role` or reads the saved
/// look from SQLite, then appends `", character {role}: {look}"` to `scene.prompt`.
pub(crate) async fn apply_character_look(db: &FlowDb, scene: &mut SceneParams) -> Result<()> {
    let Some(role) = scene.character_role.clone() else {
        return Ok(());
    };
    if let Some(look) = scene.character_look.as_deref() {
        db.save_character_look(&role, look).await?;
        scene.prompt = format!("{}, character {}: {}", scene.prompt, role, look);
    } else if let Some(look) = db.get_character_look(&role).await? {
        scene.prompt = format!("{}, character {}: {}", scene.prompt, role, look);
    }
    Ok(())
}

/// Extracts `<id>` from a `/character/<id>` URL path.
fn character_id_from_url(url: &str) -> Option<String> {
    url.split("/character/")
        .nth(1)
        .and_then(|rest| rest.split(['/', '?', '#']).next())
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

/// Opens `/project/<pid>/character/<cid>` using Angular Router first, then URL navigation.
pub(crate) async fn open_character_editor(
    engine: &ChromeEngine,
    reference_url: &str,
    project_id: &str,
    char_id: &str,
) -> Result<()> {
    let res = engine
        .call_flow_async(
            "characterOp",
            json!([{
                "action": "open_editor",
                "project_id": project_id,
                "character_id": char_id,
            }]),
        )
        .await;
    if res
        .as_ref()
        .ok()
        .and_then(|v| v.get("ok"))
        .and_then(|v| v.as_bool())
        == Some(true)
    {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let _ = ensure_flow_store(engine).await;
        return Ok(());
    }
    // Use direct URL navigation if the SPA router does not open the editor.
    let char_url =
        project_subroute_url(reference_url, project_id, &format!("character/{}", char_id));
    engine.navigate(&char_url).await?;
    tokio::time::sleep(Duration::from_millis(1800)).await;
    let _ = ensure_flow_store(engine).await;
    Ok(())
}

/// Exits the character editor back to `/project/<id>` and clears stale Angular store handles.
pub(crate) async fn exit_character_editor(engine: &ChromeEngine, project_id: Option<&str>) {
    let before_finish = engine.current_url().await.unwrap_or_default();
    let in_character = before_finish.contains("/character/");
    let finish_res = engine
        .call_flow_async("characterOp", json!([{ "action": "finish" }]))
        .await;
    let in_workspace = finish_res
        .as_ref()
        .ok()
        .and_then(|v| v.get("in_workspace"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let cur = engine.current_url().await.unwrap_or_default();
    if (in_character && !in_workspace) || cur.contains("/character/") {
        if !cur.contains("/character/") {
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        if let Some(pid) = project_id
            .map(str::to_string)
            .or_else(|| project_id_from_url(&cur))
            .or_else(|| project_id_from_url(&before_finish))
        {
            // Reload `/project/<id>` because exiting a direct `/character/<id>` load leaves an empty shell.
            let _ = engine.navigate(&project_workspace_url(&cur, &pid)).await;
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }
    }
    let _ = ensure_flow_store(engine).await;
}

/// Lists available Flow character voices from the character editor voice picker.
pub(crate) async fn list_voices(
    engine: &ChromeEngine,
    db: &FlowDb,
    character: Option<&str>,
) -> Result<Value> {
    ensure_flow_store(engine).await?;
    let initial_url = engine.current_url().await.unwrap_or_default();
    let mut project_id = project_id_from_url(&initial_url);
    let mut temp_char_id: Option<String> = None;

    if !initial_url.contains("/character/") {
        let snap = list_assets_with_project(engine).await?;
        if project_id.is_none() {
            project_id = snap.project_id.clone();
        }
        let pid = project_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("Missing project ID for character route"))?;
        let chars: Vec<FlowAsset> = snap
            .assets
            .into_iter()
            .filter(|a| a.kind == "character")
            .collect();
        let target_cid = if let Some(q) = character.map(str::trim).filter(|s| !s.is_empty()) {
            match_asset(&chars, q, false).map(|c| c.id.clone())
        } else {
            chars.first().map(|c| c.id.clone())
        };

        let cid = if let Some(existing_cid) = target_cid {
            existing_cid
        } else {
            let created = engine
                .call_flow_async(
                    "characterOp",
                    json!([{
                        "action": "create",
                        "name": "__tmp_voice_probe__",
                    }]),
                )
                .await?;
            if created.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                anyhow::bail!(
                    "Failed to create temporary character for voice lookup: {}",
                    created
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                );
            }
            let tmp_cid = created
                .get("id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .ok_or_else(|| {
                    anyhow::anyhow!("Temporary character creation returned no character ID")
                })?;
            temp_char_id = Some(tmp_cid.clone());
            tmp_cid
        };

        open_character_editor(engine, &initial_url, pid, &cid).await?;
    }

    let full_list = list_all_voices(engine).await;
    let voices_res = match full_list {
        Some(voices) => Ok(json!({ "ok": true, "voices": voices })),
        None => {
            engine
                .call_flow_async("characterVoiceOp", json!([{ "action": "list_voices" }]))
                .await
        }
    };

    exit_character_editor(engine, project_id.as_deref()).await;
    if let Some(tmp_id) = temp_char_id {
        let _ = trash_asset(engine, db, &tmp_id).await;
    }

    let res = voices_res?;
    if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        anyhow::bail!(
            "Failed to list Flow character voices: {}",
            res.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        );
    }
    let count = res
        .get("voices")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    Ok(json!({
        "count": count,
        "voices": res.get("voices").cloned().unwrap_or_else(|| json!([])),
    }))
}

/// Clicks `look_submit_point` when present and returns `(slot, prev_media_id, prev_src)`.
async fn click_look_submit_if_present(
    engine: &ChromeEngine,
    op_res: &Value,
) -> Result<Option<(String, String, String)>> {
    if let Some(pt) = op_res.get("look_submit_point")
        && engine.click_point(pt).await?
    {
        let slot = op_res
            .get("look_slot")
            .and_then(|v| v.as_str())
            .unwrap_or("portrait")
            .to_string();
        let prev_media_id = op_res
            .get("prev_look_media_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let prev_src = op_res
            .get("prev_look_src")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        return Ok(Some((slot, prev_media_id, prev_src)));
    }
    Ok(None)
}

/// Voice, portrait, and look changes to apply on an open `/character/<id>` page.
struct PageMediaRequest<'a> {
    /// Character ID of the open editor.
    char_id: &'a str,
    /// Voice settings, including custom voice text.
    voice: VoiceRequest<'a>,
    /// Project image asset IDs to attach.
    asset_ids: Option<&'a [String]>,
    /// Optional look generation prompt.
    look_prompt: Option<&'a str>,
    /// Delete the current portrait before attaching `asset_ids`.
    replace_portrait: bool,
}

/// Applies voice, reference assets, and optional look generation inside an open `/character/<id>` page.
async fn apply_character_page_media(
    engine: &ChromeEngine,
    req: PageMediaRequest<'_>,
) -> Result<Option<(String, String, String)>> {
    let char_id = req.char_id;
    let asset_ids = req.asset_ids;
    let look_prompt = req.look_prompt;
    if req.voice.is_set() {
        apply_voice_with_fallback(engine, char_id, req.voice).await?;
    }

    if req.replace_portrait && asset_ids.is_some_and(|a| !a.is_empty()) {
        delete_portrait(engine).await?;
    }

    let has_assets = asset_ids.is_some_and(|a| !a.is_empty());
    if !has_assets && look_prompt.is_none() {
        return Ok(None);
    }

    let m_res = engine
        .call_flow_async(
            "characterMediaOp",
            json!([{
                "action": "attach_and_look",
                "character_id": char_id,
                "asset_ids": asset_ids,
                "look_prompt": look_prompt,
            }]),
        )
        .await?;
    if m_res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        anyhow::bail!(
            "{}",
            m_res
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("character media update failed")
        );
    }
    click_look_submit_if_present(engine, &m_res).await
}

/// Runs a character create or edit job through `JobQueue` and persists metadata in SQLite.
pub(crate) async fn create_or_update_character_job(
    engine: &ChromeEngine,
    db: &FlowDb,
    scene: &SceneParams,
    is_edit: bool,
    on_progress: ProgressCallback,
) -> Result<(Vec<String>, Vec<String>, Vec<String>)> {
    let effective_bio = scene.bio.clone().or_else(|| scene.description.clone());
    let look_prompt = (!scene.prompt.trim().is_empty()).then(|| scene.prompt.clone());
    let has_refs = scene.refs.as_ref().is_some_and(|r| !r.is_empty());
    if is_edit
        && let Some(bio) = effective_bio.as_deref()
        && scene.new_name.is_none()
        && scene.asset_ids.is_none()
        && !has_refs
        && look_prompt.is_none()
        && !scene_voice(scene, "").is_set()
    {
        let selector = scene
            .character
            .as_deref()
            .context("Missing character selector for character edit")?;
        on_progress(format!("saving personality notes for '{selector}'"));
        let id = edit_character_bio(engine, db, selector, bio).await?;
        return Ok((Vec::new(), vec![id], Vec::new()));
    }

    validate_local_files(scene.refs.as_deref(), "Character reference image").await?;
    ensure_project_workspace_root(engine).await?;
    ensure_flow_store(engine).await?;
    let snap = list_assets_with_project(engine).await?;
    let project_id = snap.project_id.clone();
    let project_title = snap.project_title.clone();
    let mut bio_store = if effective_bio.is_some() {
        let store = ProjectStoreSession::open(engine).await?;
        anyhow::ensure!(
            project_id.as_deref() == Some(store.project_id()),
            "The active project changed before the character update"
        );
        store
            .call("characterBioOp", json!({ "action": "check" }), None)
            .await?;
        Some(store)
    } else {
        None
    };
    let editor_opened;
    let mut net_rx = if look_prompt.is_some() || has_refs {
        Some(engine.subscribe_network().await?)
    } else {
        None
    };

    let (char_id, persisted_name, look_meta) = if !is_edit {
        let char_name = scene
            .character
            .clone()
            .unwrap_or_else(|| "Character".to_string());
        on_progress(format!("creating character '{}'", char_name));
        let res = engine
            .call_flow_async(
                "characterOp",
                json!([{
                    "action": "create",
                    "name": char_name,
                    "voice": scene.voice,
                    "asset_ids": scene.asset_ids,
                    "look_prompt": look_prompt,
                }]),
            )
            .await?;
        if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            anyhow::bail!(
                "Failed to create character '{}': {}",
                char_name,
                res.get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
            );
        }
        let cid = res
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| anyhow::anyhow!("Character creation returned no character ID"))?;

        if let (Some(store), Some(bio)) = (bio_store.take(), effective_bio.as_deref()) {
            set_character_bio(&store, &cid, bio).await.map_err(|err| {
                anyhow::anyhow!("Failed to save personality notes for '{cid}': {err:#}")
            })?;
        }

        let need_update_on_page = res
            .get("need_update_on_page")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let mut submitted_meta = None;
        editor_opened = need_update_on_page || has_refs;
        if editor_opened {
            let cur_url = engine.current_url().await.unwrap_or_default();
            let fallback_pid = project_id_from_url(&cur_url);
            let pid = project_id
                .as_deref()
                .or(fallback_pid.as_deref())
                .ok_or_else(|| anyhow::anyhow!("Missing project ID for character route"))?;
            open_character_editor(engine, &cur_url, pid, &cid).await?;

            if need_update_on_page {
                let media_res = apply_character_page_media(
                    engine,
                    PageMediaRequest {
                        char_id: &cid,
                        voice: scene_voice(scene, &char_name),
                        asset_ids: scene.asset_ids.as_deref(),
                        look_prompt: look_prompt.as_deref(),
                        replace_portrait: false,
                    },
                )
                .await;
                match media_res {
                    Ok(meta) => submitted_meta = meta,
                    Err(err) => {
                        exit_character_editor(engine, project_id.as_deref()).await;
                        db.upsert_character(
                            cid,
                            project_id,
                            char_name.clone(),
                            effective_bio,
                            scene.voice.clone(),
                            None,
                        )
                        .await?;
                        anyhow::bail!("Failed to configure character '{}': {}", char_name, err);
                    }
                }
            }
        }
        (cid, char_name, submitted_meta)
    } else {
        let target_query = scene
            .character
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("Missing character selector for character edit"))?;
        let char_assets: Vec<FlowAsset> = snap
            .assets
            .into_iter()
            .filter(|a| a.kind == "character")
            .collect();
        let target = match_asset(&char_assets, target_query, false)
            .cloned()
            .with_context(|| {
                format!("No character matches '{}' in active project", target_query)
            })?;
        on_progress(format!("editing character '{}'", target.name));
        if let (Some(store), Some(bio)) = (bio_store.take(), effective_bio.as_deref()) {
            set_character_bio(&store, &target.id, bio).await?;
        }
        editor_opened = true;

        let payload = json!({
            "action": "update",
            "character_id": target.id,
            "name": scene.new_name,
        });
        let mut res = engine
            .call_flow_async("characterOp", json!([payload.clone()]))
            .await?;
        if let Some(nav_url) = res.get("need_navigate").and_then(|v| v.as_str()) {
            if let (Some(pid), Some(cid)) =
                (project_id_from_url(nav_url), character_id_from_url(nav_url))
            {
                open_character_editor(engine, nav_url, &pid, &cid).await?;
            } else {
                engine.navigate(nav_url).await?;
                tokio::time::sleep(Duration::from_millis(1800)).await;
                let _ = ensure_flow_store(engine).await;
            }
            res = engine
                .call_flow_async("characterOp", json!([payload.clone()]))
                .await?;
        }
        for _ in 0..25 {
            if res.get("error").and_then(Value::as_str) != Some("store_loading") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
            let _ = ensure_flow_store(engine).await;
            res = engine
                .call_flow_async("characterOp", json!([payload.clone()]))
                .await?;
        }
        if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            if engine
                .current_url()
                .await
                .unwrap_or_default()
                .contains("/character/")
            {
                exit_character_editor(engine, project_id.as_deref()).await;
            }
            anyhow::bail!(
                "Failed to edit character '{}': {}",
                target.id,
                res.get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
            );
        }
        let default_voice_name = scene
            .new_name
            .clone()
            .unwrap_or_else(|| target.name.clone());
        let submitted_meta = match apply_character_page_media(
            engine,
            PageMediaRequest {
                char_id: &target.id,
                voice: scene_voice(scene, &default_voice_name),
                asset_ids: scene.asset_ids.as_deref(),
                look_prompt: look_prompt.as_deref(),
                replace_portrait: scene.replace_portrait.unwrap_or(false),
            },
        )
        .await
        {
            Ok(meta) => meta,
            Err(err) => {
                if engine
                    .current_url()
                    .await
                    .unwrap_or_default()
                    .contains("/character/")
                {
                    exit_character_editor(engine, project_id.as_deref()).await;
                }
                anyhow::bail!("Failed to edit character '{}': {}", target.id, err);
            }
        };
        let final_name = scene.new_name.clone().unwrap_or(target.name);
        (target.id, final_name, submitted_meta)
    };

    let upload_err = async {
        let Some(refs) = scene.refs.as_ref().filter(|refs| !refs.is_empty()) else {
            return Ok(());
        };
        for (idx, ref_path) in refs.iter().take(2).enumerate() {
            let slot = if idx == 0 { "portrait" } else { "body" };
            on_progress(format!("uploading character {slot} reference image"));
            let request = json!([{
                "action": "open_upload",
                "slot": slot,
                "character_id": char_id,
            }]);
            let mut open_res = engine
                .call_flow_async("characterMediaOp", request.clone())
                .await?;
            if open_res.get("error").and_then(Value::as_str) == Some("character_preview_not_bound")
                && engine
                    .bind_angular_views(
                        "flow-character-preview-panel, flow-character-image-preview",
                    )
                    .await
                    .unwrap_or(false)
            {
                open_res = engine.call_flow_async("characterMediaOp", request).await?;
            }
            let opened = checked_runtime_result(open_res).map_err(|err| {
                anyhow::anyhow!("Failed to open the {slot} upload for character '{char_id}': {err}")
            })?;
            let selector = opened
                .get("selector")
                .and_then(Value::as_str)
                .context("Flow did not return the character file input")?;
            let check_request = json!([{
                "action": "check_upload",
                "character_id": char_id,
                "slot": slot,
                "prev_src": opened.get("prev_src"),
                "prev_media_id": opened.get("prev_media_id"),
            }]);
            engine
                .upload_files(selector, std::slice::from_ref(ref_path))
                .await
                .map_err(|err| {
                    anyhow::anyhow!(
                        "outcome_unknown (character '{char_id}', {slot} upload): {err}"
                    )
                })?;

            let upload_deadline = Instant::now() + Duration::from_secs(45);
            loop {
                tokio::time::sleep(Duration::from_millis(400)).await;
                if let Some(rx) = net_rx.as_mut() {
                    inspect_generation_network(rx, &on_progress)?;
                }
                let result = engine
                    .call_flow_async("characterMediaOp", check_request.clone())
                    .await
                    .map_err(|err| {
                        anyhow::anyhow!(
                            "outcome_unknown (character '{char_id}', {slot} upload): {err}"
                        )
                    })?;
                let checked = checked_runtime_result(result).map_err(|err| {
                    anyhow::anyhow!(
                        "Failed to upload the {slot} reference image for character '{char_id}': {err}"
                    )
                })?;
                if checked.get("done").and_then(Value::as_bool) == Some(true) {
                    break;
                }
                if Instant::now() >= upload_deadline {
                    anyhow::bail!(
                        "outcome_unknown (character '{char_id}', {slot} upload): Flow did not confirm the upload"
                    );
                }
            }
        }
        Ok(())
    }
    .await
    .err();

    let mut files = Vec::new();
    let created = vec![char_id.clone()];
    let mut resources = Vec::new();

    let mut look_err = None;
    if upload_err.is_none() && look_prompt.is_some() {
        let (look_slot, prev_look_media_id, prev_look_src) = look_meta
            .clone()
            .unwrap_or_else(|| ("portrait".to_string(), String::new(), String::new()));
        on_progress("waiting for character look generation".to_string());
        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if let Some(rx) = net_rx.as_mut()
                && let Err(err) = inspect_generation_network(rx, &on_progress)
            {
                look_err = Some(err);
                break;
            }
            let chk = engine
                .call_flow_async(
                    "characterMediaOp",
                    json!([{
                        "action": "check_look",
                        "character_id": char_id,
                        "slot": look_slot,
                        "prev_media_id": prev_look_media_id,
                        "prev_src": prev_look_src,
                    }]),
                )
                .await;
            if let Ok(chk) = chk {
                if chk.get("ok").and_then(|v| v.as_bool()) == Some(false) {
                    look_err = Some(anyhow::anyhow!(
                        "Failed to generate character look: {}",
                        chk.get("error")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                    ));
                    break;
                }
                if chk.get("done").and_then(|v| v.as_bool()) == Some(true) {
                    let media_id = chk
                        .get("media_id")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| char_id.clone());
                    if let Some(src) = chk
                        .get("src")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| s.starts_with("http") || s.starts_with("data:"))
                    {
                        let temp_asset = FlowAsset {
                            id: media_id,
                            name: persisted_name.clone(),
                            kind: "image".to_string(),
                            prompt: None,
                            url: Some(src.to_string()),
                            collection_id: None,
                            collection_name: None,
                            width: None,
                            height: None,
                            duration: None,
                            primary_media_id: None,
                            personality_notes: None,
                            voice: None,
                            trim_start_seconds: None,
                            trim_end_seconds: None,
                            media_status: None,
                            media_error: None,
                            created_at: None,
                        };
                        if let Ok(rec) = download_resolved_asset(
                            engine,
                            db,
                            &temp_asset,
                            project_id.clone(),
                            project_title.clone(),
                        )
                        .await
                        {
                            files.push(rec.file_path);
                            resources.push(rec.resource_uri);
                        }
                    }
                    break;
                }
            }
            if Instant::now() >= deadline {
                look_err = Some(anyhow::anyhow!(
                    "Timed out waiting for character look generation"
                ));
                break;
            }
        }
    }

    if editor_opened {
        exit_character_editor(engine, project_id.as_deref()).await;
    }

    if let Some(err) = upload_err.or(look_err) {
        if !is_edit {
            db.upsert_character(
                char_id,
                project_id,
                persisted_name,
                effective_bio,
                scene.voice.clone(),
                None,
            )
            .await?;
        }
        return Err(err);
    }

    db.upsert_character(
        char_id,
        project_id,
        persisted_name,
        effective_bio,
        scene.voice.clone(),
        scene.asset_ids.clone(),
    )
    .await?;

    Ok((files, created, resources))
}

/// Lists live character entities in the active project merged with SQLite character metadata.
pub(crate) async fn list_characters(engine: &ChromeEngine, db: &FlowDb) -> Result<Value> {
    let snap = list_assets_with_project(engine).await?;
    let stored = db.list_characters(snap.project_id.as_deref()).await?;
    let mut by_id: HashMap<String, _> = stored.into_iter().map(|c| (c.id.clone(), c)).collect();

    let mut out = Vec::new();
    for asset in snap.assets {
        let is_char = asset.kind == "character"
            || (asset.kind == "image"
                && asset
                    .collection_name
                    .as_deref()
                    .is_some_and(|c| c.eq_ignore_ascii_case("Characters")));
        if !is_char {
            continue;
        }
        let saved = by_id.remove(&asset.id);
        let bio = asset
            .personality_notes
            .clone()
            .or_else(|| saved.as_ref().and_then(|s| s.bio.clone()));
        let voice = asset.voice.clone().or_else(|| {
            saved
                .as_ref()
                .and_then(|s| s.voice.clone())
                .map(Value::String)
        });
        let ref_asset_ids = saved
            .as_ref()
            .map(|s| s.ref_asset_ids.clone())
            .unwrap_or_default();
        out.push(json!({
            "id": asset.id,
            "name": asset.name,
            "kind": asset.kind,
            "bio": bio,
            "voice": voice,
            "ref_asset_ids": ref_asset_ids,
            "url": asset.url,
            "collection_id": asset.collection_id,
            "collection_name": asset.collection_name,
            "created_at": asset.created_at,
        }));
    }

    Ok(json!({
        "count": out.len(),
        "project_id": snap.project_id,
        "characters": out,
    }))
}
