// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Direct project store operations for character personality notes.

use anyhow::{Context, Result};
use serde_json::json;

use crate::assets::{FlowAsset, match_asset};
use crate::db::FlowDb;
use crate::engine::ChromeEngine;
use crate::project_store::ProjectStoreSession;

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

/// Finds a character for an edit and saves its notes without opening the editor.
pub(crate) async fn edit_character_bio(
    engine: &ChromeEngine,
    db: &FlowDb,
    selector: &str,
    bio: &str,
) -> Result<String> {
    let store = ProjectStoreSession::open(engine).await?;
    let mut result = store
        .call("characterBioOp", json!({ "action": "list" }), None)
        .await?;
    let assets: Vec<FlowAsset> = serde_json::from_value(result["characters"].take())?;
    let target = match_asset(&assets, selector, false)
        .with_context(|| format!("No character matches '{selector}' in active project"))?;
    set_character_bio(&store, &target.id, bio).await?;
    db.upsert_character(
        target.id.clone(),
        Some(store.project_id().to_owned()),
        target.name.clone(),
        Some(bio.to_owned()),
        None,
        None,
    )
    .await?;
    Ok(target.id.clone())
}
