use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use agents::{NativeFileMutation, NativeFileSystem, TokioNativeFileSystem};
use serde_json::{Number, Value, json};

use super::common::*;
use crate::host::native::{model_provider_import::ImportDraft, read_json_object_or_empty};

pub(super) fn resolve_muse_home(home: &Path, environment: &HashMap<String, String>) -> PathBuf {
    environment
        .get("XDG_CONFIG_HOME")
        .filter(|value| !value.trim().is_empty())
        .map(|value| super::super::expand_agent_home_path(home, value).join("muse"))
        .or_else(|| {
            std::env::var_os("XDG_CONFIG_HOME")
                .filter(|value| !value.is_empty())
                .map(|value| {
                    super::super::expand_agent_home_path(home, &value.to_string_lossy())
                        .join("muse")
                })
        })
        .unwrap_or_else(|| home.join(".config").join("muse"))
}

pub(super) async fn native_muse_draft(muse_home: &Path) -> Result<Option<ImportDraft>, String> {
    let settings = read_json_object_or_empty(&muse_home.join("settings.json")).await?;
    let auth = read_json_object_or_empty(&muse_home.join("auth.json")).await?;
    let transport = settings.get("endpoint_transport").unwrap_or(&Value::Null);
    let api_url = json_text(transport, &["base_url"]);
    let model = json_text(&settings, &["model"]);
    let api_key = auth
        .get("providers")
        .and_then(|providers| providers.get("meta"))
        .map(|meta| json_text(meta, &["api_key"]))
        .unwrap_or_default();
    if api_url.is_empty() && api_key.is_empty() {
        return Ok(None);
    }
    Ok(Some(ImportDraft {
        source_id: "__native_live__".to_string(),
        name: "当前原生配置".to_string(),
        api_url,
        api_key,
        model,
        skip_reason: None,
    }))
}

pub(super) async fn apply_muse(
    muse_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
    let filesystem = TokioNativeFileSystem;
    let settings_path = muse_home.join("settings.json");
    let original_settings = filesystem.read(&settings_path).await?;
    let mut settings_doc = parse_json_object_bytes(&settings_path, original_settings.as_deref())?;
    let root = settings_doc.as_object_mut().expect("object");
    root.entry("schema_version".to_string())
        .or_insert_with(|| Value::Number(Number::from(1)));
    {
        let transport = object_entry(root, "endpoint_transport")?;
        insert_string(transport, "base_url", &provider.api_url);
        let auth_mode = if provider.api_key.trim().is_empty() {
            "none"
        } else {
            "bearer"
        };
        transport.insert("auth".to_string(), Value::String(auth_mode.to_string()));
    }
    insert_string(root, "model", &provider.model);

    let mut mutations = vec![NativeFileMutation {
        path: settings_path,
        expected: original_settings,
        replacement: Some(
            serde_json::to_vec_pretty(&settings_doc)
                .map_err(|error| format!("序列化 Muse Code settings.json 失败：{error}"))?,
        ),
        sensitive: false,
    }];

    if !provider.api_key.trim().is_empty() {
        let auth_path = muse_home.join("auth.json");
        let original_auth = filesystem.read(&auth_path).await?;
        let mut auth_doc = parse_json_object_bytes(&auth_path, original_auth.as_deref())?;
        let auth_root = auth_doc.as_object_mut().expect("object");
        auth_root
            .entry("schema_version".to_string())
            .or_insert_with(|| Value::Number(Number::from(1)));
        let providers = object_entry(auth_root, "providers")?;
        providers.insert(
            "meta".to_string(),
            json!({ "api_key": provider.api_key.trim() }),
        );
        mutations.push(NativeFileMutation {
            path: auth_path,
            expected: original_auth,
            replacement: Some(
                serde_json::to_vec_pretty(&auth_doc)
                    .map_err(|error| format!("序列化 Muse Code auth.json 失败：{error}"))?,
            ),
            sensitive: true,
        });
    }

    apply_projection_mutations(&mutations).await
}
