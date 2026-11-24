use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Manifest directory written into plugin packages.
pub const MANIFEST_DIR: &str = ".dimo-plugin";
/// Manifest directory used before the Dimo rename. Plugins installed then are
/// still on disk under this name and must keep loading.
pub const PRE_RENAME_MANIFEST_DIR: &str = ".vibex-plugin";

/// Manifest directories to probe for an installed plugin, current name first.
pub const MANIFEST_DIRS: [&str; 2] = [MANIFEST_DIR, PRE_RENAME_MANIFEST_DIR];

/// Absolute manifest path under `root` for the current name.
pub fn manifest_path(root: impl AsRef<Path>) -> PathBuf {
    root.as_ref().join(MANIFEST_DIR).join("plugin.json")
}

/// First existing `plugin.json` under `root`, checking the current manifest
/// directory before the pre-rename one.
pub fn existing_manifest_path(root: impl AsRef<Path>) -> Option<PathBuf> {
    manifest_candidates(root)
        .into_iter()
        .find(|candidate| candidate.is_file())
}

/// Every manifest path that may exist under `root`, current name first.
pub fn manifest_candidates(root: impl AsRef<Path>) -> Vec<PathBuf> {
    MANIFEST_DIRS
        .iter()
        .map(|dir| root.as_ref().join(dir).join("plugin.json"))
        .collect()
}

macro_rules! stable_id {
    ($name:ident) => {
        #[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

stable_id!(PluginId);
stable_id!(ToolId);
stable_id!(SkillId);
stable_id!(ActionId);

impl PluginId {
    pub(crate) fn from_string(value: String) -> Self {
        Self(value)
    }
}

impl ToolId {
    pub(crate) fn from_string(value: String) -> Self {
        Self(value)
    }
}

impl SkillId {
    pub(crate) fn from_string(value: String) -> Self {
        Self(value)
    }
}

impl ActionId {
    pub fn from_string(value: String) -> Self {
        Self(value)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PluginAction {
    pub id: ActionId,
    pub label: String,
    pub required_skills: Vec<SkillId>,
    pub required_tools: Vec<ToolId>,
    pub prompt_blocks: Vec<PromptBlock>,
    #[serde(default)]
    pub artifact_intent: Option<ArtifactIntent>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PromptBlock {
    Text { text: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ArtifactIntent {
    pub media_types: Vec<String>,
    pub provider: String,
}
