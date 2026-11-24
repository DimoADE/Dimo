//! Local Marketplace v1: static signed index.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::PluginError;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceListing {
    pub publisher: String,
    pub plugin_id: String,
    pub version: String,
    pub summary: String,
    pub package_digest: String,
    pub archive: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceIndex {
    pub listings: Vec<MarketplaceListing>,
}

pub fn load_index(path: &Path) -> Result<MarketplaceIndex, PluginError> {
    if !path.is_file() {
        return Ok(MarketplaceIndex::default());
    }
    serde_json::from_str(
        &fs::read_to_string(path)
            .map_err(|error| PluginError::io("read marketplace index", error))?,
    )
    .map_err(|error| PluginError::invalid_manifest(error.to_string()))
}

pub fn archive_digest(path: &Path) -> Result<String, PluginError> {
    let bytes =
        fs::read(path).map_err(|error| PluginError::io("read marketplace archive", error))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

pub fn default_index_path(data_root: &Path) -> PathBuf {
    data_root.join("plugins/index/official.v1.json")
}
