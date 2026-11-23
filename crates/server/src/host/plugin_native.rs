use std::{
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use application::ApplicationError;
use plugins::{NativePluginAdapter, NativePluginDescriptor};
use serde_json::{Value, json};

use crate::domains::{ServerApplicationDomains, internal_error, parse, plugin_error, serialize};

const NATIVE_CLI_DISCOVER_TIMEOUT: Duration = Duration::from_secs(5);
const NATIVE_CLI_CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct CachedNativePluginEntry {
    format: &'static str,
    plugin: NativePluginDescriptor,
    item: Value,
}

struct NativePluginCacheState {
    fetched_at: Instant,
    entries: Vec<CachedNativePluginEntry>,
}

fn native_plugin_cache() -> &'static Mutex<Option<NativePluginCacheState>> {
    static CACHE: OnceLock<Mutex<Option<NativePluginCacheState>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn invalidate_native_plugin_cache() {
    if let Ok(mut guard) = native_plugin_cache().lock() {
        *guard = None;
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginIdentityArgs {
    plugin_id: String,
}

impl ServerApplicationDomains {
    pub(crate) async fn merge_native_cli_plugins(&self, plugins: &mut Vec<Value>) {
        let entries = discover_all_native_cli_plugins_cached().await;
        for entry in entries {
            if let Some(existing) = plugins.iter_mut().find(|plugin| {
                plugin.get("id").and_then(Value::as_str) == Some(entry.plugin.id.as_str())
            }) {
                if let Some(formats) = existing.get_mut("formats").and_then(Value::as_array_mut)
                    && !formats
                        .iter()
                        .any(|item| item.as_str() == Some(entry.format))
                {
                    formats.push(Value::String(entry.format.to_owned()));
                }
            } else {
                plugins.push(entry.item);
            }
        }
    }

    pub(crate) async fn native_plugin_set_enabled(
        &self,
        plugin_id: &str,
        enabled: bool,
    ) -> Result<Option<Value>, ApplicationError> {
        let Some((adapter, descriptor, format)) = find_native_cli_plugin(plugin_id).await? else {
            return Ok(None);
        };
        adapter
            .set_enabled(&descriptor.id, enabled)
            .await
            .map_err(plugin_error)?;
        invalidate_native_plugin_cache();
        let refreshed = find_native_descriptor(&adapter, &descriptor.id).await?;
        Ok(Some(native_plugin_item(
            refreshed,
            format,
            adapter.capabilities(),
        )))
    }

    pub(crate) async fn native_plugin_update(
        &self,
        args: Value,
    ) -> Result<Option<Value>, ApplicationError> {
        let Ok(args) = parse::<PluginIdentityArgs>(args) else {
            return Ok(None);
        };
        let Some((adapter, descriptor, format)) = find_native_cli_plugin(&args.plugin_id).await?
        else {
            return Ok(None);
        };
        adapter.update(&descriptor.id).await.map_err(plugin_error)?;
        invalidate_native_plugin_cache();
        let refreshed = find_native_descriptor(&adapter, &descriptor.id).await?;
        Ok(Some(native_plugin_item(
            refreshed,
            format,
            adapter.capabilities(),
        )))
    }

    pub(crate) async fn native_plugin_uninstall(
        &self,
        plugin_id: &str,
    ) -> Result<bool, ApplicationError> {
        let Some((adapter, descriptor, _)) = find_native_cli_plugin(plugin_id).await? else {
            return Ok(false);
        };
        adapter
            .uninstall(&descriptor.id)
            .await
            .map_err(plugin_error)?;
        invalidate_native_plugin_cache();
        Ok(true)
    }

    pub(crate) async fn native_plugin_contributions(
        &self,
        plugin_id: &str,
    ) -> Result<Option<Value>, ApplicationError> {
        let Some((_, descriptor, _)) = find_native_cli_plugin(plugin_id).await? else {
            return Ok(None);
        };
        let skills = discover_native_skills(&descriptor.path);
        let mcp = read_native_mcp(&descriptor.path)?;
        serialize(json!({
            "skills": skills,
            "mcp": mcp.unwrap_or(Value::Null),
        }))
        .map(Some)
    }
}

async fn discover_all_native_cli_plugins_cached() -> Vec<CachedNativePluginEntry> {
    if let Ok(guard) = native_plugin_cache().lock()
        && let Some(state) = guard.as_ref()
        && state.fetched_at.elapsed() < NATIVE_CLI_CACHE_TTL
    {
        return state.entries.clone();
    }

    let (codex_entries, claude_entries, muse_entries) = tokio::join!(
        discover_single_cli_adapter("codex", "codex", |program| {
            plugins::OfficialCliNativePluginAdapter::codex(program)
        }),
        discover_single_cli_adapter("claude", "claude_code", |program| {
            plugins::OfficialCliNativePluginAdapter::claude_code(program)
        }),
        discover_single_cli_adapter("muse", "muse_code", |program| {
            plugins::OfficialCliNativePluginAdapter::muse_code(program)
        }),
    );

    let mut entries = codex_entries;
    entries.extend(claude_entries);
    entries.extend(muse_entries);

    if let Ok(mut guard) = native_plugin_cache().lock() {
        *guard = Some(NativePluginCacheState {
            fetched_at: Instant::now(),
            entries: entries.clone(),
        });
    }
    entries
}

async fn resolve_native_cli_binary(binary: &'static str) -> Option<std::path::PathBuf> {
    if let Some(program) = utils::shell::resolve_executable_path(binary).await {
        return Some(program);
    }
    if binary == "muse" {
        return tokio::task::spawn_blocking(
            crate::host::native::muse_plugins::resolve_muse_default,
        )
        .await
        .ok()
        .flatten();
    }
    None
}

async fn discover_single_cli_adapter(
    binary: &'static str,
    format: &'static str,
    build: impl FnOnce(std::path::PathBuf) -> plugins::OfficialCliNativePluginAdapter,
) -> Vec<CachedNativePluginEntry> {
    let Some(program) = resolve_native_cli_binary(binary).await else {
        return Vec::new();
    };
    let adapter = build(program);
    let capabilities = adapter.capabilities();
    let discovered =
        match tokio::time::timeout(NATIVE_CLI_DISCOVER_TIMEOUT, adapter.discover()).await {
            Ok(Ok(items)) => items,
            Ok(Err(error)) => {
                tracing::debug!(binary, %error, "native CLI plugin discovery failed");
                return Vec::new();
            }
            Err(_) => {
                tracing::warn!(binary, "native CLI plugin discovery timed out");
                return Vec::new();
            }
        };
    tokio::task::spawn_blocking(move || {
        discovered
            .into_iter()
            .map(|plugin| {
                let item = native_plugin_item(plugin.clone(), format, capabilities);
                CachedNativePluginEntry {
                    format,
                    plugin,
                    item,
                }
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

async fn native_cli_adapters() -> Vec<(plugins::OfficialCliNativePluginAdapter, &'static str)> {
    let (codex_bin, claude_bin, muse_bin) = tokio::join!(
        resolve_native_cli_binary("codex"),
        resolve_native_cli_binary("claude"),
        resolve_native_cli_binary("muse"),
    );
    let mut adapters = Vec::new();
    if let Some(program) = codex_bin {
        adapters.push((
            plugins::OfficialCliNativePluginAdapter::codex(program),
            "codex",
        ));
    }
    if let Some(program) = claude_bin {
        adapters.push((
            plugins::OfficialCliNativePluginAdapter::claude_code(program),
            "claude_code",
        ));
    }
    if let Some(program) = muse_bin {
        adapters.push((
            plugins::OfficialCliNativePluginAdapter::muse_code(program),
            "muse_code",
        ));
    }
    adapters
}

async fn find_native_cli_plugin(
    plugin_id: &str,
) -> Result<
    Option<(
        plugins::OfficialCliNativePluginAdapter,
        NativePluginDescriptor,
        &'static str,
    )>,
    ApplicationError,
> {
    for (adapter, format) in native_cli_adapters().await {
        let Ok(Ok(discovered)) =
            tokio::time::timeout(NATIVE_CLI_DISCOVER_TIMEOUT, adapter.discover()).await
        else {
            continue;
        };
        if let Some(plugin) = discovered.into_iter().find(|plugin| plugin.id == plugin_id) {
            return Ok(Some((adapter, plugin, format)));
        }
    }
    Ok(None)
}

async fn find_native_descriptor(
    adapter: &plugins::OfficialCliNativePluginAdapter,
    plugin_id: &str,
) -> Result<NativePluginDescriptor, ApplicationError> {
    tokio::time::timeout(NATIVE_CLI_DISCOVER_TIMEOUT, adapter.discover())
        .await
        .map_err(|_| ApplicationError::internal("native plugin discovery timed out"))?
        .map_err(plugin_error)?
        .into_iter()
        .find(|plugin| plugin.id == plugin_id)
        .ok_or_else(|| ApplicationError::not_found(plugin_id.to_owned()))
}

fn native_plugin_item(
    plugin: NativePluginDescriptor,
    format: &str,
    capabilities: plugins::NativeAdapterCapabilities,
) -> Value {
    let skills = discover_native_skills(&plugin.path);
    let mcp_servers = native_mcp_names(&plugin.path);
    let source_kind = match plugin.ecosystem {
        plugins::NativeEcosystem::Codex => "codex_native",
        plugins::NativeEcosystem::ClaudeCode => "claude_code_native",
        plugins::NativeEcosystem::MuseCode => "muse_code_native",
    };
    json!({
        "id": plugin.id,
        "publisher": Value::Null,
        "packageDigest": Value::Null,
        "updatePackageDigest": Value::Null,
        "name": plugin.name,
        "version": plugin.version.unwrap_or_else(|| "unknown".to_owned()),
        "description": Value::Null,
        "enabled": plugin.enabled.unwrap_or(false),
        "builtin": false,
        "sourceKind": source_kind,
        "sourcePath": plugin.path.to_string_lossy(),
        "formats": [format],
        "skills": skills,
        "runtimes": [],
        "warnings": [],
        "permissions": [],
        "permissionDelta": [],
        "mcpCount": mcp_servers.len(),
        "mcpServers": mcp_servers,
        "hooks": discover_native_resources(&plugin.path, "hooks"),
        "workflows": discover_native_resources(&plugin.path, "workflows"),
        "invocationCount": 0,
        "invocations": [],
        "appContributions": [],
        "nativeManaged": true,
        "enableSupported": capabilities.enable,
        "updateSupported": capabilities.update,
        "rollbackSupported": false,
        "uninstallSupported": capabilities.uninstall,
        "sourceOrigin": Value::Null,
        "sourceRef": Value::Null,
        "sourceSha": Value::Null,
        "sourceLocked": false,
        "sourceShowTree": Value::Null,
    })
}

fn discover_native_skills(root: &Path) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(root.join("skills")) else {
        return Vec::new();
    };
    let mut skills = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let skill = entry.path().join("SKILL.md");
            skill.is_file().then(|| {
                json!({
                    "id": entry.file_name().to_string_lossy(),
                    "path": skill
                        .strip_prefix(root)
                        .unwrap_or(&skill)
                        .to_string_lossy(),
                })
            })
        })
        .collect::<Vec<_>>();
    skills.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
    skills
}

fn discover_native_resources(root: &Path, directory: &str) -> Vec<Value> {
    fn visit(
        root: &Path,
        current: &Path,
        directory: &str,
        depth: usize,
        resources: &mut Vec<Value>,
    ) {
        if depth > 6 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(current) else {
            return;
        };
        let prefix = format!("{directory}/");
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                visit(root, &path, directory, depth + 1, resources);
                continue;
            }
            let relative = path.strip_prefix(root).unwrap_or(&path);
            let id = relative
                .with_extension("")
                .to_string_lossy()
                .replace('\\', "/");
            resources.push(json!({
                "id": id.trim_start_matches(&prefix),
                "path": relative.to_string_lossy().replace('\\', "/"),
            }));
        }
    }

    let mut resources = Vec::new();
    visit(root, &root.join(directory), directory, 0, &mut resources);
    resources.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
    resources
}

fn read_native_mcp(root: &Path) -> Result<Option<Value>, ApplicationError> {
    let path = root.join(".mcp.json");
    if !path.is_file() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path).map_err(internal_error)?;
    serde_json::from_str(&content).map(Some).map_err(|error| {
        ApplicationError::bad_request(format!("invalid native MCP configuration: {error}"))
    })
}

fn native_mcp_names(root: &Path) -> Vec<String> {
    match read_native_mcp(root) {
        Ok(Some(value)) => {
            let mut names = value
                .get("mcpServers")
                .unwrap_or(&value)
                .as_object()
                .map(|servers| servers.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            names.sort();
            names
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn native_plugin_item_marks_cli_plugins_as_native_managed() {
        let item = native_plugin_item(
            NativePluginDescriptor {
                id: "demo".into(),
                name: "Demo".into(),
                version: Some("1.0.0".into()),
                ecosystem: plugins::NativeEcosystem::Codex,
                path: PathBuf::from("/tmp/demo"),
                enabled: Some(true),
            },
            "codex",
            plugins::NativeAdapterCapabilities {
                discover: true,
                install: false,
                enable: false,
                update: false,
                uninstall: true,
            },
        );
        assert_eq!(item["id"], "demo");
        assert_eq!(item["sourceKind"], "codex_native");
        assert_eq!(item["nativeManaged"], true);
        assert_eq!(item["enableSupported"], false);
        assert_eq!(item["uninstallSupported"], true);
        assert_eq!(item["formats"], json!(["codex"]));
    }
}
