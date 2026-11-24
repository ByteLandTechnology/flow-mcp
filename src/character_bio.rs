// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Direct project store and character editor UI operations for character personality notes.

use anyhow::{Context, Result};
use serde_json::{Value, json};

use crate::assets::{FlowAsset, list_assets_with_project, match_asset};
use crate::characters::{exit_character_editor, open_character_editor};
use crate::db::FlowDb;
use crate::engine::ChromeEngine;
use crate::project::project_id_from_url;
use crate::project_store::{ProjectStoreSession, can_use_ui_fallback};

/// Opens a verified direct store session for personality notes, or returns `Ok(None)` when UI fallback should be used.
pub(crate) async fn open_character_bio_store<'a>(
    engine: &'a ChromeEngine,
    project_id: Option<&str>,
) -> Result<Option<ProjectStoreSession<'a>>> {
    match ProjectStoreSession::open(engine).await {
        Ok(store) => {
            anyhow::ensure!(
                project_id == Some(store.project_id()),
                "The active project changed before the character update"
            );
            match store
                .call("characterBioOp", json!({ "action": "check" }), None)
                .await
            {
                Ok(_) => Ok(Some(store)),
                Err(err) if can_use_ui_fallback(&err) => Ok(None),
                Err(err) => Err(err),
            }
        }
        Err(err) if can_use_ui_fallback(&err) => Ok(None),
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

/// Opens the character editor page, writes personality notes into the editor UI, and returns to the workspace.
pub(crate) async fn set_character_bio_ui(
    engine: &ChromeEngine,
    project_id: Option<&str>,
    character_id: &str,
    bio: &str,
) -> Result<()> {
    let cur_url = engine.current_url().await.unwrap_or_default();
    let url_pid = project_id_from_url(&cur_url);
    let pid = project_id
        .or(url_pid.as_deref())
        .context("Missing project ID for character editor UI")?;
    open_character_editor(engine, &cur_url, pid, character_id).await?;
    let res = engine
        .call_flow_async(
            "characterOp",
            json!([{
                "action": "update",
                "character_id": character_id,
                "bio": bio,
            }]),
        )
        .await;
    exit_character_editor(engine, Some(pid)).await;
    let res = res?;
    if res.get("ok").and_then(Value::as_bool) != Some(true) {
        anyhow::bail!(
            "Failed to update personality notes for '{character_id}' via UI: {}",
            res.get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        );
    }
    Ok(())
}

/// Finds a character and saves its notes through the direct store or character editor UI fallback.
pub(crate) async fn edit_character_bio(
    engine: &ChromeEngine,
    db: &FlowDb,
    selector: &str,
    bio: &str,
) -> Result<String> {
    let fallback_to_ui = match ProjectStoreSession::open(engine).await {
        Ok(store) => {
            match store
                .call("characterBioOp", json!({ "action": "list" }), None)
                .await
            {
                Ok(mut result) => {
                    let assets: Vec<FlowAsset> =
                        serde_json::from_value(result["characters"].take())?;
                    let target = match_asset(&assets, selector, false).with_context(|| {
                        format!("No character matches '{selector}' in active project")
                    })?;
                    match set_character_bio(&store, &target.id, bio).await {
                        Ok(()) => {
                            db.upsert_character(
                                target.id.clone(),
                                Some(store.project_id().to_owned()),
                                target.name.clone(),
                                Some(bio.to_owned()),
                                None,
                                None,
                            )
                            .await?;
                            return Ok(target.id.clone());
                        }
                        Err(err) if can_use_ui_fallback(&err) => true,
                        Err(err) => return Err(err),
                    }
                }
                Err(err) if can_use_ui_fallback(&err) => true,
                Err(err) => return Err(err),
            }
        }
        Err(err) if can_use_ui_fallback(&err) => true,
        Err(err) => return Err(err),
    };

    if !fallback_to_ui {
        anyhow::bail!("Could not update character personality notes");
    }

    let snap = list_assets_with_project(engine).await?;
    let chars: Vec<FlowAsset> = snap
        .assets
        .into_iter()
        .filter(|a| a.kind == "character")
        .collect();
    let target = match_asset(&chars, selector, false)
        .with_context(|| format!("No character matches '{selector}' in active project"))?;
    set_character_bio_ui(engine, snap.project_id.as_deref(), &target.id, bio).await?;
    db.upsert_character(
        target.id.clone(),
        snap.project_id,
        target.name.clone(),
        Some(bio.to_owned()),
        None,
        None,
    )
    .await?;
    Ok(target.id.clone())
}
