use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};

use api_types::{MusePluginSummaryView, MusePluginView};
use serde_json::Value;

const PLUGIN_OPERATION_TIMEOUT: Duration = Duration::from_secs(180);

pub fn resolve_plugins_home(user_home: &Path, environment: &HashMap<String, String>) -> PathBuf {
    let data_home = environment
        .get("XDG_DATA_HOME")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| expand_home(user_home, value))
        .or_else(|| {
            std::env::var("XDG_DATA_HOME")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| user_home.join(".local").join("share"));
    data_home.join("muse").join("plugins")
}

pub async fn list_plugins(
    user_home: &Path,
    environment: &HashMap<String, String>,
) -> Result<MusePluginSummaryView, String> {
    let plugins_home = resolve_plugins_home(user_home, environment);
    if let Some(program) = resolve_muse(user_home, environment) {
        match list_via_cli(&program, user_home, environment).await {
            Ok(plugins) => {
                return Ok(MusePluginSummaryView {
                    home: plugins_home.display().to_string(),
                    plugins,
                });
            }
            Err(error) => {
                tracing::warn!(%error, "muse plugins list failed; falling back to plugins directory scan");
            }
        }
    }
    Ok(MusePluginSummaryView {
        plugins: list_from_plugin_dirs(&plugins_home),
        home: plugins_home.display().to_string(),
    })
}

pub async fn install_plugin(
    user_home: &Path,
    environment: &HashMap<String, String>,
    spec: &str,
) -> Result<MusePluginSummaryView, String> {
    let spec = validate_install_spec(spec)?;
    let program = resolve_muse(user_home, environment).ok_or_else(|| {
        "Muse CLI (`muse`) was not found; install Muse Code to manage plugins".to_string()
    })?;
    run_muse(
        &program,
        user_home,
        environment,
        &["plugins", "install", spec.as_str()],
    )
    .await?;
    list_plugins(user_home, environment).await
}

pub async fn approve_plugin(
    user_home: &Path,
    environment: &HashMap<String, String>,
    name: &str,
) -> Result<MusePluginSummaryView, String> {
    let name = validate_plugin_name(name)?;
    let program = resolve_muse(user_home, environment).ok_or_else(|| {
        "Muse CLI (`muse`) was not found; install Muse Code to manage plugins".to_string()
    })?;
    run_muse(
        &program,
        user_home,
        environment,
        &["plugins", "approve", name.as_str()],
    )
    .await?;
    list_plugins(user_home, environment).await
}

pub async fn set_plugin_enabled(
    user_home: &Path,
    environment: &HashMap<String, String>,
    name: &str,
    enabled: bool,
) -> Result<MusePluginSummaryView, String> {
    let name = validate_plugin_name(name)?;
    let program = resolve_muse(user_home, environment).ok_or_else(|| {
        "Muse CLI (`muse`) was not found; install Muse Code to manage plugins".to_string()
    })?;
    let subcommand = if enabled { "enable" } else { "disable" };
    run_muse(
        &program,
        user_home,
        environment,
        &["plugins", subcommand, name.as_str()],
    )
    .await?;
    list_plugins(user_home, environment).await
}

pub async fn remove_plugin(
    user_home: &Path,
    environment: &HashMap<String, String>,
    name: &str,
) -> Result<MusePluginSummaryView, String> {
    let name = validate_plugin_name(name)?;
    let program = resolve_muse(user_home, environment).ok_or_else(|| {
        "Muse CLI (`muse`) was not found; install Muse Code to manage plugins".to_string()
    })?;
    run_muse(
        &program,
        user_home,
        environment,
        &["plugins", "remove", name.as_str()],
    )
    .await?;
    list_plugins(user_home, environment).await
}

pub fn resolve_muse_default() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let empty = HashMap::new();
    resolve_muse(&home, &empty)
}

pub fn resolve_muse(user_home: &Path, environment: &HashMap<String, String>) -> Option<PathBuf> {
    for key in ["DIMO_MUSE_PATH", "MUSE_PATH"] {
        if let Some(path) = environment
            .get(key)
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| expand_home(user_home, value))
            .filter(|path| path.is_file())
        {
            return Some(path);
        }
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                let candidate = expand_home(user_home, trimmed);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    if let Ok(found) = which::which("muse") {
        return Some(found);
    }
    let candidates = [
        user_home.join(".local").join("bin").join("muse"),
        user_home.join(".local").join("bin").join("muse.exe"),
        user_home.join(".local").join("bin").join("muse.cmd"),
    ];
    if let Some(found) = candidates.into_iter().find(|path| path.is_file()) {
        return Some(found);
    }
    #[cfg(windows)]
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA")
        && !local_app_data.trim().is_empty()
    {
        let dir = PathBuf::from(local_app_data).join("Programs").join("muse");
        for name in ["muse.cmd", "muse.exe"] {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

async fn list_via_cli(
    program: &Path,
    user_home: &Path,
    environment: &HashMap<String, String>,
) -> Result<Vec<MusePluginView>, String> {
    let output = muse_output(
        program,
        user_home,
        environment,
        &["plugins", "list", "--json"],
    )
    .await?;
    parse_list_json(&output)
}

fn parse_list_json(bytes: &[u8]) -> Result<Vec<MusePluginView>, String> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("Failed to parse `muse plugins list --json`: {error}"))?;
    let entries = value
        .as_array()
        .cloned()
        .or_else(|| {
            value.as_object().and_then(|object| {
                ["plugins", "installed", "installedPlugins"]
                    .into_iter()
                    .find_map(|key| object.get(key).and_then(Value::as_array).cloned())
            })
        })
        .unwrap_or_default();
    let mut plugins = entries
        .iter()
        .filter_map(project_cli_entry)
        .collect::<Vec<_>>();
    plugins.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    Ok(plugins)
}

fn project_cli_entry(entry: &Value) -> Option<MusePluginView> {
    let id = ["pluginId", "id", "name"]
        .into_iter()
        .find_map(|key| entry.get(key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let name = ["name", "displayName", "pluginId", "id"]
        .into_iter()
        .find_map(|key| entry.get(key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(id);
    let enabled = entry
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            entry
                .get("status")
                .and_then(Value::as_str)
                .is_none_or(|status| !status.eq_ignore_ascii_case("disabled"))
        });
    let approved = entry
        .get("approved")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            entry
                .get("status")
                .and_then(Value::as_str)
                .is_none_or(|status| {
                    !status.eq_ignore_ascii_case("pending")
                        && !status.eq_ignore_ascii_case("pending_approval")
                        && !status.eq_ignore_ascii_case("unapproved")
                })
        });
    let status = entry
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if !approved {
                "pending_approval".to_string()
            } else if enabled {
                "enabled".to_string()
            } else {
                "disabled".to_string()
            }
        });
    let path = ["installPath", "path", "cachePath", "directory", "dir"]
        .into_iter()
        .find_map(|key| entry.get(key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let source = entry
        .get("source")
        .and_then(|value| {
            value
                .as_str()
                .or_else(|| value.get("url").and_then(Value::as_str))
                .or_else(|| value.get("path").and_then(Value::as_str))
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some(MusePluginView {
        id: id.to_string(),
        name: name.to_string(),
        version: entry
            .get("version")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        status,
        enabled,
        approved,
        path,
        source,
        marketplace: entry
            .get("marketplace")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    })
}

fn list_from_plugin_dirs(plugins_home: &Path) -> Vec<MusePluginView> {
    let Ok(entries) = std::fs::read_dir(plugins_home) else {
        return Vec::new();
    };
    let mut plugins = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(dir_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if dir_name.starts_with('.') || dir_name == "marketplaces" {
            continue;
        }
        let manifest_path = [
            path.join("plugin.json"),
            path.join(".muse-plugin").join("plugin.json"),
            path.join("manifest.json"),
        ]
        .into_iter()
        .find(|candidate| candidate.is_file());
        let manifest = manifest_path
            .and_then(|candidate| std::fs::read(&candidate).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let id = manifest
            .as_ref()
            .and_then(|doc| doc.get("id").and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(dir_name)
            .to_string();
        let name = manifest
            .as_ref()
            .and_then(|doc| doc.get("name").and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&id)
            .to_string();
        let version = manifest
            .as_ref()
            .and_then(|doc| doc.get("version").and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        plugins.push(MusePluginView {
            id,
            name,
            version,
            status: "installed".to_string(),
            enabled: true,
            approved: true,
            path: Some(path.display().to_string()),
            source: None,
            marketplace: None,
        });
    }
    plugins.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    plugins
}

async fn run_muse(
    program: &Path,
    user_home: &Path,
    environment: &HashMap<String, String>,
    args: &[&str],
) -> Result<(), String> {
    let _ = muse_output(program, user_home, environment, args).await?;
    Ok(())
}

async fn muse_output(
    program: &Path,
    user_home: &Path,
    environment: &HashMap<String, String>,
    args: &[&str],
) -> Result<Vec<u8>, String> {
    let mut command = utils::process::new_hidden_tokio_command(program, args.iter().copied());
    command
        .env("MUSE_EXPERIMENTAL_PLUGINS", "1")
        .env("MUSE_NO_AUTO_UPDATE", "1")
        .kill_on_drop(true);
    for key in ["XDG_CONFIG_HOME", "XDG_DATA_HOME"] {
        if let Some(value) = environment
            .get(key)
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            command.env(key, expand_home(user_home, value));
        }
    }
    let output = tokio::time::timeout(PLUGIN_OPERATION_TIMEOUT, command.output())
        .await
        .map_err(|_| "muse plugins command timed out".to_string())?
        .map_err(|error| format!("Failed to start muse plugins command: {error}"))?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    Err(utils::process::command_output_detail(&output)
        .unwrap_or_else(|| format!("muse plugins exited with status {}", output.status)))
}

fn validate_install_spec(spec: &str) -> Result<String, String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err("Plugin source cannot be empty".to_string());
    }
    if spec
        .chars()
        .any(|ch| ch.is_whitespace() || matches!(ch, ';' | '|' | '&' | '`' | '$' | '\n' | '\r'))
    {
        return Err("Plugin source contains unsupported shell characters".to_string());
    }
    if spec.contains("..") {
        return Err("Plugin source path is invalid".to_string());
    }
    Ok(spec.to_string())
}

fn validate_plugin_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || name.contains(['/', '\\', ';', '|', '&', '`', '$', '\n', '\r'])
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '@'))
    {
        return Err("Plugin identifier is invalid".to_string());
    }
    Ok(name.to_string())
}

fn expand_home(user_home: &Path, value: &str) -> PathBuf {
    if let Some(rest) = value.strip_prefix("~/") {
        user_home.join(rest)
    } else if value == "~" {
        user_home.to_path_buf()
    } else {
        PathBuf::from(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_list_json_projects_muse_plugins() {
        let plugins = parse_list_json(
            br#"{"plugins":[{"id":"lint@meta","name":"Lint","version":"1.2.0","enabled":false,"approved":false,"installPath":"/tmp/lint","source":"https://github.com/example/lint","marketplace":"meta"}]}"#,
        )
        .unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].id, "lint@meta");
        assert_eq!(plugins[0].name, "Lint");
        assert!(!plugins[0].enabled);
        assert!(!plugins[0].approved);
        assert_eq!(plugins[0].status, "pending_approval");
        assert_eq!(plugins[0].marketplace.as_deref(), Some("meta"));
    }

    #[test]
    fn fallback_scan_reads_plugin_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("demo-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{"id":"demo-plugin","name":"Demo Plugin","version":"0.4.0"}"#,
        )
        .unwrap();
        let plugins = list_from_plugin_dirs(dir.path());
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].id, "demo-plugin");
        assert_eq!(plugins[0].name, "Demo Plugin");
        assert_eq!(plugins[0].version.as_deref(), Some("0.4.0"));
    }

    #[test]
    fn validates_install_spec_and_plugin_name() {
        assert!(validate_install_spec("owner/repo").is_ok());
        assert!(validate_install_spec("https://github.com/owner/repo").is_ok());
        assert!(validate_install_spec("owner/repo;rm -rf /").is_err());
        assert!(validate_plugin_name("lint@meta").is_ok());
        assert!(validate_plugin_name("../evil").is_err());
    }
}
