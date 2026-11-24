// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Direct project store and character editor operations for personality notes.

use anyhow::{Context, Result};
use serde_json::json;

use crate::assets::{FlowAsset, list_assets_with_project, match_asset};
use crate::characters::{exit_character_editor, open_character_editor};
use crate::db::FlowDb;
use crate::engine::{ChromeEngine, checked_runtime_result};
use crate::project::{ensure_flow_store, ensure_project_workspace_root, project_id_from_url};
use crate::project_store::ProjectStoreSession;

/// Returns true when a direct store error can fall back to the character editor view.
pub(crate) fn is_bio_fallback_eligible(err: &anyhow::Error) -> bool {
    let msg = format!("{err:#}");
    if msg.contains("outcome_unknown") {
        return false;
    }
    msg.contains("unsupported_front_end")
        || msg.contains("collection_store_not_bound")
        || msg.contains("ambiguous_collection_store")
        || msg.contains("project_store_changed")
        || msg.contains("project_changed")
        || msg.contains("character_bio_unreadable")
        || msg.contains("Open a Google Flow project")
}

/// Opens a verified direct store session for character notes, or returns `Ok(None)` when the editor fallback applies.
pub(crate) async fn prepare_bio_store<'a>(
    engine: &'a ChromeEngine,
    expected_project: Option<&str>,
) -> Result<Option<ProjectStoreSession<'a>>> {
    let check = async {
        let store = ProjectStoreSession::open(engine).await?;
        anyhow::ensure!(
            expected_project == Some(store.project_id()),
            "The active project changed before the character update"
        );
        store
            .call("characterBioOp", json!({ "action": "check" }), None)
            .await?;
        Ok::<ProjectStoreSession<'a>, anyhow::Error>(store)
    }
    .await;
    match check {
        Ok(store) => Ok(Some(store)),
        Err(err) if is_bio_fallback_eligible(&err) => Ok(None),
        Err(err) => Err(err),
    }
}

/// Saves character notes in the active project and checks the server result.
pub(crate) async fn set_character_bio(
    store: &ProjectStoreSession<'_>,
    character_id: &str,
    bio: &str,
) -> Result<()> {
    store
        .call(
            "characterBioOp",
            json!({ "action": "set", "id": character_id, "bio": bio }),
            Some(&format!("character {character_id}")),
        )
        .await?;
    Ok(())
}

/// Tries to save character notes directly; returns `Ok(false)` when the caller must use the editor view.
pub(crate) async fn try_set_character_bio(
    store: Option<ProjectStoreSession<'_>>,
    character_id: &str,
    bio: &str,
) -> Result<bool> {
    let Some(store) = store else {
        return Ok(false);
    };
    match set_character_bio(&store, character_id, bio).await {
        Ok(()) => Ok(true),
        Err(err) if is_bio_fallback_eligible(&err) => Ok(false),
        Err(err) => Err(err),
    }
}

/// Saves and confirms personality notes inside the open `/character/<id>` editor view.
pub(crate) async fn save_character_bio_in_editor(engine: &ChromeEngine, bio: &str) -> Result<()> {
    let res = engine
        .call_flow_async("characterBioEditorOp", json!([bio]))
        .await?;
    checked_runtime_result(res)?;
    Ok(())
}

/// Opens the character editor, saves and confirms personality notes, and returns to the workspace.
async fn edit_character_bio_in_editor(
    engine: &ChromeEngine,
    db: &FlowDb,
    selector: &str,
    bio: &str,
) -> Result<String> {
    let _store_guard = engine.lock_project_store().await;
    ensure_project_workspace_root(engine).await?;
    ensure_flow_store(engine).await?;
    let snap = list_assets_with_project(engine).await?;
    let characters: Vec<FlowAsset> = snap
        .assets
        .into_iter()
        .filter(|a| a.kind == "character")
        .collect();
    let target = match_asset(&characters, selector, false)
        .cloned()
        .with_context(|| format!("No character matches '{selector}' in active project"))?;

    let cur_url = engine.current_url().await.unwrap_or_default();
    let fallback_pid = project_id_from_url(&cur_url);
    let pid = snap
        .project_id
        .as_deref()
        .or(fallback_pid.as_deref())
        .context("Missing project ID for character route")?;

    open_character_editor(engine, &cur_url, pid, &target.id).await?;
    let save_res = save_character_bio_in_editor(engine, bio).await;
    exit_character_editor(engine, snap.project_id.as_deref()).await;
    save_res?;

    db.upsert_character(
        target.id.clone(),
        snap.project_id,
        target.name,
        Some(bio.to_owned()),
        None,
        None,
    )
    .await?;
    Ok(target.id)
}

/// Finds a character for an edit and saves its notes through the direct store or character editor.
pub(crate) async fn edit_character_bio(
    engine: &ChromeEngine,
    db: &FlowDb,
    selector: &str,
    bio: &str,
) -> Result<String> {
    let direct = async {
        let store = ProjectStoreSession::open(engine).await?;
        let project_id = store.project_id().to_owned();
        let mut result = store
            .call("characterBioOp", json!({ "action": "list" }), None)
            .await?;
        let assets: Vec<FlowAsset> = serde_json::from_value(result["characters"].take())?;
        let target = match_asset(&assets, selector, false)
            .cloned()
            .with_context(|| format!("No character matches '{selector}' in active project"))?;
        set_character_bio(&store, &target.id, bio).await?;
        Ok::<(FlowAsset, String), anyhow::Error>((target, project_id))
    }
    .await;

    match direct {
        Ok((target, project_id)) => {
            db.upsert_character(
                target.id.clone(),
                Some(project_id),
                target.name,
                Some(bio.to_owned()),
                None,
                None,
            )
            .await?;
            Ok(target.id)
        }
        Err(err) if is_bio_fallback_eligible(&err) => {
            edit_character_bio_in_editor(engine, db, selector, bio).await
        }
        Err(err) => Err(err),
    }
}
