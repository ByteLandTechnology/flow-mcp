// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Direct project store and character form fallback operations for character personality notes.

use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{Value, json};

use crate::assets::{FlowAsset, list_assets_with_project, match_asset};
use crate::characters::{exit_character_editor, open_character_editor};
use crate::db::FlowDb;
use crate::engine::ChromeEngine;
use crate::project::{ensure_flow_store, ensure_project_workspace_root, project_id_from_url};
use crate::project_route::character_id_from_url;
use crate::project_store::{ProjectStoreSession, is_store_write_unavailable};

/// Opens a verified project store session for character bio writes, or returns `Ok(None)` on unverified builds.
pub(crate) async fn open_verified_bio_store<'a>(
    engine: &'a ChromeEngine,
    expected_project_id: Option<&str>,
) -> Result<Option<ProjectStoreSession<'a>>> {
    let store = match ProjectStoreSession::open(engine).await {
        Ok(store) => store,
        Err(err) if is_store_write_unavailable(&err) => return Ok(None),
        Err(err) => return Err(err),
    };
    anyhow::ensure!(
        expected_project_id == Some(store.project_id()),
        "The active project changed before the character update"
    );
    match store
        .call("characterBioOp", json!({ "action": "check" }), None)
        .await
    {
        Ok(_) => Ok(Some(store)),
        Err(err) if is_store_write_unavailable(&err) => Ok(None),
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

/// Opens `/character/<id>` if needed and applies character name and personality form edits.
pub(crate) async fn update_character_form_fields(
    engine: &ChromeEngine,
    project_id: Option<&str>,
    character_id: &str,
    new_name: Option<&str>,
    bio: Option<&str>,
) -> Result<()> {
    let payload = json!({
        "action": "update",
        "character_id": character_id,
        "name": new_name,
        "bio": bio,
    });
    let mut res = engine
        .call_flow_async("characterOp", json!([payload.clone()]))
        .await?;
    if let Some(nav_url) = res.get("need_navigate").and_then(Value::as_str) {
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
        let err = res.get("error").and_then(Value::as_str);
        if !matches!(err, Some("store_loading" | "store_not_bound")) {
            break;
        }
        if err == Some("store_loading") {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        ensure_flow_store(engine).await?;
        res = engine
            .call_flow_async("characterOp", json!([payload.clone()]))
            .await?;
    }
    if res.get("ok").and_then(Value::as_bool) != Some(true) {
        if engine
            .current_url()
            .await
            .unwrap_or_default()
            .contains("/character/")
        {
            exit_character_editor(engine, project_id).await;
        }
        anyhow::bail!(
            "Failed to edit character '{}': {}",
            character_id,
            res.get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        );
    }
    Ok(())
}

/// Checks the project snapshot to confirm that `bio` saved on character `char_id`.
pub(crate) async fn confirm_character_bio_saved(
    engine: &ChromeEngine,
    char_id: &str,
    bio: &str,
) -> Result<()> {
    let refreshed = list_assets_with_project(engine).await?;
    let confirmed = refreshed.assets.iter().any(|asset| {
        asset.id == char_id && asset.personality_notes.as_deref().map(str::trim) == Some(bio.trim())
    });
    anyhow::ensure!(
        confirmed,
        "Flow did not persist personality notes for character '{char_id}'"
    );
    Ok(())
}

/// Edits character personality notes through `flow-character-form` when direct store updates are unavailable.
async fn edit_character_bio_in_form(
    engine: &ChromeEngine,
    db: &FlowDb,
    selector: &str,
    bio: &str,
) -> Result<String> {
    ensure_project_workspace_root(engine).await?;
    ensure_flow_store(engine).await?;
    let snap = list_assets_with_project(engine).await?;
    let char_assets: Vec<FlowAsset> = snap
        .assets
        .into_iter()
        .filter(|a| a.kind == "character")
        .collect();
    let target = match_asset(&char_assets, selector, false)
        .cloned()
        .with_context(|| format!("No character matches '{selector}' in active project"))?;
    let cur_url = engine.current_url().await.unwrap_or_default();
    let pid = snap
        .project_id
        .clone()
        .or_else(|| project_id_from_url(&cur_url))
        .context("Missing project ID for character route")?;
    open_character_editor(engine, &cur_url, &pid, &target.id).await?;
    let update_res =
        update_character_form_fields(engine, Some(&pid), &target.id, None, Some(bio)).await;
    exit_character_editor(engine, Some(&pid)).await;
    update_res?;
    confirm_character_bio_saved(engine, &target.id, bio).await?;
    db.upsert_character(
        target.id.clone(),
        Some(pid),
        target.name.clone(),
        Some(bio.trim().to_owned()),
        None,
        None,
    )
    .await?;
    Ok(target.id)
}

/// Finds a character for an edit and saves its notes through the verified store or `flow-character-form`.
pub(crate) async fn edit_character_bio(
    engine: &ChromeEngine,
    db: &FlowDb,
    selector: &str,
    bio: &str,
) -> Result<String> {
    let direct_target = match ProjectStoreSession::open(engine).await {
        Ok(store) => {
            match store
                .call("characterBioOp", json!({ "action": "list" }), None)
                .await
            {
                Ok(mut result) => {
                    let assets: Vec<FlowAsset> =
                        serde_json::from_value(result["characters"].take())?;
                    let target = match_asset(&assets, selector, false)
                        .cloned()
                        .with_context(|| {
                            format!("No character matches '{selector}' in active project")
                        })?;
                    set_character_bio(&store, &target.id, bio).await?;
                    Some((target, store.project_id().to_owned()))
                }
                Err(err) if is_store_write_unavailable(&err) => None,
                Err(err) => return Err(err),
            }
        }
        Err(err) if is_store_write_unavailable(&err) => None,
        Err(err) => return Err(err),
    };
    if let Some((target, project_id)) = direct_target {
        db.upsert_character(
            target.id.clone(),
            Some(project_id),
            target.name.clone(),
            Some(bio.to_owned()),
            None,
            None,
        )
        .await?;
        return Ok(target.id);
    }
    edit_character_bio_in_form(engine, db, selector, bio).await
}
