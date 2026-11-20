// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Input for changes to Flow Agent project settings.

use anyhow::{Result, ensure};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Confirmation policy for Agent generation in this project.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum ConfirmPolicy {
    /// Ask before generation uses credits.
    Always,
    /// Generate without an approval request.
    Never,
}

/// Changes to the default generation settings for one media type.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct GenerationDefaultsPatch {
    /// Flow model ID from `get_settings`.
    model: Option<String>,
    /// Aspect ratio from `get_settings`, such as `16:9`.
    aspect_ratio: Option<String>,
    /// Number of outputs for each generation.
    #[schemars(range(min = 1, max = 4))]
    output_count: Option<u8>,
}

impl GenerationDefaultsPatch {
    /// Checks that the request contains at least one valid field.
    fn validate(&self) -> Result<()> {
        ensure!(
            self.model.is_some() || self.aspect_ratio.is_some() || self.output_count.is_some(),
            "Supply at least one generation default"
        );
        ensure!(
            self.model.as_deref().is_none_or(has_text)
                && self.aspect_ratio.as_deref().is_none_or(has_text),
            "Model and aspect ratio must contain text"
        );
        ensure!(
            self.output_count
                .is_none_or(|count| (1..=4).contains(&count)),
            "output_count must be between 1 and 4"
        );
        Ok(())
    }
}

/// Text, references, and state of one memory card.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct MemoryCardPatch {
    /// Card title.
    title: Option<String>,
    /// Rules, style, or information for the Agent.
    description: Option<String>,
    /// Include this card in the project's Agent instructions.
    enabled: Option<bool>,
    /// Main media IDs of project images. Supply an empty list to clear them.
    image_media_ids: Option<Vec<String>>,
    /// Project character IDs. Supply an empty list to clear them.
    character_ids: Option<Vec<String>>,
    /// Flow likeness IDs. Supply an empty list to clear them.
    likeness_ids: Option<Vec<String>>,
}

impl MemoryCardPatch {
    /// Checks the card fields before Flow opens.
    fn validate(&self) -> Result<()> {
        ensure!(
            self.title.is_some()
                || self.description.is_some()
                || self.enabled.is_some()
                || self.image_media_ids.is_some()
                || self.character_ids.is_some()
                || self.likeness_ids.is_some(),
            "Supply at least one memory card field"
        );
        for ids in [
            &self.image_media_ids,
            &self.character_ids,
            &self.likeness_ids,
        ]
        .into_iter()
        .flatten()
        {
            ensure!(
                ids.iter().all(|id| has_text(id)),
                "Each memory reference ID must contain text"
            );
        }
        Ok(())
    }
}

/// One change to the project's memory cards.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum MemoryPatch {
    /// Adds a card. New cards are enabled by default.
    Create {
        /// Fields for the new card.
        card: MemoryCardPatch,
    },
    /// Changes fields on one card.
    Update {
        /// Existing card ID from `get_settings`.
        id: String,
        /// Fields to change.
        card: MemoryCardPatch,
    },
    /// Deletes one card.
    Delete {
        /// Existing card ID from `get_settings`.
        id: String,
    },
}

/// Project settings to change. Omitted fields keep their current value.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct AgentSettingsPatch {
    /// Confirmation policy for generation that uses credits.
    confirm_before_generating: Option<ConfirmPolicy>,
    /// Defaults for image generation.
    image_defaults: Option<GenerationDefaultsPatch>,
    /// Defaults for video generation.
    video_defaults: Option<GenerationDefaultsPatch>,
    /// Create, update, or delete one memory card.
    memory: Option<MemoryPatch>,
}

impl AgentSettingsPatch {
    /// Checks the input before the tool opens the project.
    pub(crate) fn validate(&self) -> Result<()> {
        ensure!(
            self.confirm_before_generating.is_some()
                || self.image_defaults.is_some()
                || self.video_defaults.is_some()
                || self.memory.is_some(),
            "Supply at least one setting to update"
        );
        for defaults in [&self.image_defaults, &self.video_defaults]
            .into_iter()
            .flatten()
        {
            defaults.validate()?;
        }
        match &self.memory {
            Some(MemoryPatch::Create { card }) => card.validate(),
            Some(MemoryPatch::Update { id, card }) => {
                ensure!(has_text(id), "Memory card ID must contain text");
                card.validate()
            }
            Some(MemoryPatch::Delete { id }) => {
                ensure!(has_text(id), "Memory card ID must contain text");
                Ok(())
            }
            None => Ok(()),
        }
    }
}

/// Returns true when a string contains a non-space character.
pub(crate) fn has_text(value: &str) -> bool {
    !value.trim().is_empty()
}
