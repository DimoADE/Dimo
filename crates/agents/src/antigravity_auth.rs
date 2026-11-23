//! Antigravity ACP auth: the server reads `auth.type` from
//! `$GEMINI_HOME/antigravity-acp/settings.json`, not from the process
//! environment. Dimo records the panel choice as `AGY_AUTH_METHOD` and
//! projects it into that file on save and launch.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

const AUTH_METHOD_ENV: &str = "AGY_AUTH_METHOD";
const ACP_SUBDIR: &str = "antigravity-acp";

pub const AUTH_METHODS: &[&str] = &[
    "oauth-personal",
    "oauth-business",
    "gemini-api-key",
    "agent-platform",
];

const CREDENTIAL_ENV_VARS: &[&str] = &[
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AntigravitySyncStatus {
    Written,
    AlreadyCurrent,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AntigravitySyncReport {
    pub path: PathBuf,
    pub status: AntigravitySyncStatus,
    pub reason: Option<String>,
}

pub fn recorded_auth_method(env: &HashMap<String, String>) -> Option<&str> {
    let method = env
        .get(AUTH_METHOD_ENV)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    if method == "model_provider" {
        return Some("gemini-api-key");
    }
    AUTH_METHODS.contains(&method).then_some(method)
}

fn credential_env_for_method(method: &str) -> &'static [&'static str] {
    match method {
        "gemini-api-key" => &["GEMINI_API_KEY"],
        "agent-platform" => &[
            "GOOGLE_API_KEY",
            "GOOGLE_CLOUD_PROJECT",
            "GOOGLE_CLOUD_LOCATION",
        ],
        _ => &[],
    }
}

/// Clear inherited credential vars the chosen method does not consume.
pub fn apply_antigravity_env_policy(env: &mut HashMap<String, String>) {
    let Some(method) = recorded_auth_method(env) else {
        return;
    };
    let keep = credential_env_for_method(method);
    for key in CREDENTIAL_ENV_VARS {
        let kept =
            keep.contains(key) && env.get(*key).is_some_and(|value| !value.trim().is_empty());
        if kept {
            continue;
        }
        env.remove(*key);
    }
}

pub fn resolve_gemini_home(
    env: &HashMap<String, String>,
    process_home: Option<&Path>,
) -> Result<PathBuf, String> {
    let configured = env
        .get("GEMINI_HOME")
        .map(String::as_str)
        .filter(|value| !value.is_empty());
    let needs_home = configured
        .is_none_or(|value| value == "~" || value.starts_with("~/") || value.starts_with("~\\"));
    if needs_home && process_home.is_none() {
        return Err(
            "cannot tell which home directory Antigravity will use, so the auth file cannot be named"
                .to_string(),
        );
    }
    Ok(resolve_gemini_home_from(configured, process_home))
}

pub fn resolve_gemini_home_from(configured: Option<&str>, home: Option<&Path>) -> PathBuf {
    match configured.filter(|value| !value.is_empty()) {
        Some(value) => expand_home_prefix(value, home),
        None => home.unwrap_or_else(|| Path::new(".")).join(".gemini"),
    }
}

pub fn antigravity_acp_dir(
    env: &HashMap<String, String>,
    process_home: Option<&Path>,
) -> Result<PathBuf, String> {
    Ok(resolve_gemini_home(env, process_home)?.join(ACP_SUBDIR))
}

fn expand_home_prefix(value: &str, home: Option<&Path>) -> PathBuf {
    if value == "~" {
        return home.unwrap_or_else(|| Path::new(".")).to_path_buf();
    }
    if let Some(relative) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return home.unwrap_or_else(|| Path::new(".")).join(relative);
    }
    PathBuf::from(value)
}

fn gcp_field<'a>(env: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    env.get(key)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

const LAUNCH_INJECTED_ENV_VARS: &[&str] = &[
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GEMINI_BASE_URL",
    "GEMINI_MODEL",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
];

fn parse_dotenv_entries(text: &str) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    for raw_line in text.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let line = trimmed.strip_prefix("export ").unwrap_or(trimmed);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let value = value.trim();
        let unquoted = if (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
            || (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2)
        {
            &value[1..value.len() - 1]
        } else {
            value
        };
        entries.push((key.to_string(), unquoted.to_string()));
    }
    entries
}

fn serialize_dotenv_entries(entries: &[(String, String)]) -> String {
    let mut out = String::new();
    for (key, value) in entries {
        out.push_str(key);
        out.push('=');
        out.push_str(value);
        out.push('\n');
    }
    out
}

fn read_dotenv_entries(path: &Path) -> Vec<(String, String)> {
    std::fs::read_to_string(path)
        .map(|text| parse_dotenv_entries(&text))
        .unwrap_or_default()
}

fn write_dotenv_entries(
    acp_dir: &Path,
    path: &Path,
    entries: &[(String, String)],
) -> Result<(), String> {
    let body = serialize_dotenv_entries(entries);
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let parent = target.parent().unwrap_or(acp_dir);
    std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let temp = parent.join(format!(".env.dimo-{}.tmp", std::process::id()));
    std::fs::write(&temp, body).map_err(|err| err.to_string())?;
    if let Err(err) = std::fs::rename(&temp, &target) {
        let _ = std::fs::remove_file(&temp);
        return Err(err.to_string());
    }
    Ok(())
}

fn inject_stored_antigravity_env(env: &mut HashMap<String, String>, acp_dir: &Path) {
    let dotenv_entries = read_dotenv_entries(&acp_dir.join(".env"));
    for (key, value) in dotenv_entries {
        if LAUNCH_INJECTED_ENV_VARS.contains(&key.as_str())
            && !value.trim().is_empty()
            && env
                .get(&key)
                .is_none_or(|existing| existing.trim().is_empty())
        {
            env.insert(key, value);
        }
    }
    if let Ok(Some(settings)) = read_settings(&acp_dir.join("settings.json"))
        && let Some(legacy_env) = settings.get("env").and_then(serde_json::Value::as_object)
    {
        for key in LAUNCH_INJECTED_ENV_VARS {
            if env
                .get(*key)
                .is_none_or(|existing| existing.trim().is_empty())
                && let Some(value) = legacy_env
                    .get(*key)
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            {
                env.insert((*key).to_string(), value.to_string());
            }
        }
    }
}

fn migrate_legacy_settings_env_to_dotenv(acp_dir: &Path, existing: Option<&serde_json::Value>) {
    let Some(legacy_env) = existing
        .and_then(|root| root.get("env"))
        .and_then(serde_json::Value::as_object)
    else {
        return;
    };
    let env_path = acp_dir.join(".env");
    let mut entries = read_dotenv_entries(&env_path);
    let mut changed = false;
    for (key, value) in legacy_env {
        let Some(value) = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if !entries.iter().any(|(existing_key, existing_val)| {
            existing_key == key && !existing_val.trim().is_empty()
        }) {
            entries.retain(|(existing_key, _)| existing_key != key);
            entries.push((key.clone(), value.to_string()));
            changed = true;
        }
    }
    if changed {
        let _ = write_dotenv_entries(acp_dir, &env_path, &entries);
    }
}

pub fn sync_antigravity_settings(
    env: &HashMap<String, String>,
    process_home: Option<&Path>,
) -> AntigravitySyncReport {
    let recorded = recorded_auth_method(env);
    let acp_dir = match antigravity_acp_dir(env, process_home) {
        Ok(dir) => dir,
        Err(reason) => {
            return AntigravitySyncReport {
                path: PathBuf::from("<unknown>"),
                status: AntigravitySyncStatus::Skipped,
                reason: Some(reason),
            };
        }
    };
    let path = acp_dir.join("settings.json");
    let existing = match read_settings(&path) {
        Ok(existing) => existing,
        Err(reason) => {
            return AntigravitySyncReport {
                path,
                status: AntigravitySyncStatus::Skipped,
                reason: Some(reason),
            };
        }
    };
    let has_stale_env = existing
        .as_ref()
        .and_then(serde_json::Value::as_object)
        .is_some_and(|obj| obj.contains_key("env"));
    if has_stale_env {
        migrate_legacy_settings_env_to_dotenv(&acp_dir, existing.as_ref());
    }
    let existing_auth_type = existing
        .as_ref()
        .and_then(|root| root.get("auth"))
        .and_then(|auth| auth.get("type"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let method: String = match (recorded, existing_auth_type) {
        (Some(method), _) => method.to_string(),
        (None, Some(_)) if !has_stale_env => {
            return AntigravitySyncReport {
                path,
                status: AntigravitySyncStatus::AlreadyCurrent,
                reason: None,
            };
        }
        (None, Some(existing_method)) => existing_method,
        (None, None) => "oauth-personal".to_string(),
    };
    let gcp_project = gcp_field(env, "GOOGLE_CLOUD_PROJECT");
    let gcp_location = gcp_field(env, "GOOGLE_CLOUD_LOCATION");
    let updated = match merge_settings(existing, &method, gcp_project, gcp_location) {
        Ok(Some(updated)) => updated,
        Ok(None) => {
            return AntigravitySyncReport {
                path,
                status: AntigravitySyncStatus::AlreadyCurrent,
                reason: None,
            };
        }
        Err(reason) => {
            return AntigravitySyncReport {
                path,
                status: AntigravitySyncStatus::Skipped,
                reason: Some(reason),
            };
        }
    };
    match write_settings(&acp_dir, &path, &updated) {
        Ok(()) => AntigravitySyncReport {
            path,
            status: AntigravitySyncStatus::Written,
            reason: None,
        },
        Err(err) => AntigravitySyncReport {
            path,
            status: AntigravitySyncStatus::Skipped,
            reason: Some(format!("could not write it ({err})")),
        },
    }
}

/// Loads stored Antigravity `.env` (with legacy `settings.json["env"]`
/// fallback), applies the launch env policy, and projects the chosen method
/// into `settings.json` while stripping any stale `"env"` key that
/// `agy_acp_server` rejects.
pub fn apply_antigravity_launch_env(env: &mut HashMap<String, String>) -> AntigravitySyncReport {
    let home = env
        .get("HOME")
        .or_else(|| env.get("USERPROFILE"))
        .map(PathBuf::from)
        .or_else(dirs::home_dir);
    if let Ok(acp_dir) = antigravity_acp_dir(env, home.as_deref()) {
        inject_stored_antigravity_env(env, &acp_dir);
    }
    apply_antigravity_env_policy(env);
    sync_antigravity_settings(env, home.as_deref())
}
fn read_settings(path: &Path) -> Result<Option<serde_json::Value>, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("could not read it ({err})")),
    };
    let parsed: serde_json::Value = serde_json::from_str(&raw).map_err(|err| {
        format!("it is not strict JSON and cannot be rewritten without losing content ({err})")
    })?;
    if !parsed.is_object() {
        return Err("it does not hold a JSON object".to_string());
    }
    Ok(Some(parsed))
}

fn write_settings(acp_dir: &Path, path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let body = serde_json::to_string_pretty(value).map_err(|err| err.to_string())?;
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let parent = target.parent().unwrap_or(acp_dir);
    std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let temp = parent.join(format!(".settings.json.dimo-{}.tmp", std::process::id()));
    std::fs::write(&temp, format!("{body}\n")).map_err(|err| err.to_string())?;
    if let Err(err) = std::fs::rename(&temp, &target) {
        let _ = std::fs::remove_file(&temp);
        return Err(err.to_string());
    }
    Ok(())
}

fn merge_settings(
    existing: Option<serde_json::Value>,
    method: &str,
    gcp_project: Option<&str>,
    gcp_location: Option<&str>,
) -> Result<Option<serde_json::Value>, String> {
    let mut root = match existing {
        Some(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
        _ => serde_json::json!({}),
    };
    let before = root.clone();
    {
        let obj = root
            .as_object_mut()
            .ok_or_else(|| "it does not hold a JSON object".to_string())?;
        // `agy_acp_server` rejects an `"env"` key in `settings.json`; credentials
        // live in `antigravity-acp/.env` and are injected into the child process.
        obj.remove("env");
        match obj.get("auth") {
            None | Some(serde_json::Value::Null) => {
                obj.insert("auth".into(), serde_json::json!({}));
            }
            Some(serde_json::Value::Object(_)) => {}
            Some(_) => return Err("`auth` is not an object".to_string()),
        }
        obj.get_mut("auth")
            .and_then(serde_json::Value::as_object_mut)
            .ok_or_else(|| "`auth` is not an object".to_string())?
            .insert("type".into(), serde_json::Value::String(method.to_string()));

        if gcp_project.is_some() || gcp_location.is_some() {
            match obj.get("gcp") {
                None | Some(serde_json::Value::Null) => {
                    obj.insert("gcp".into(), serde_json::json!({}));
                }
                Some(serde_json::Value::Object(_)) => {}
                Some(_) => return Err("`gcp` is not an object".to_string()),
            }
            let gcp = obj
                .get_mut("gcp")
                .and_then(serde_json::Value::as_object_mut)
                .ok_or_else(|| "`gcp` is not an object".to_string())?;
            for (name, value) in [("project", gcp_project), ("location", gcp_location)] {
                if let Some(value) = value {
                    gcp.insert(name.into(), serde_json::Value::String(value.to_string()));
                }
            }
        }
    }
    Ok((root != before).then_some(root))
}
#[cfg(test)]
mod tests {
    use super::*;

    fn env(method: &str) -> HashMap<String, String> {
        HashMap::from([(AUTH_METHOD_ENV.to_string(), method.to_string())])
    }

    #[test]
    fn env_policy_scrubs_credentials_the_chosen_method_does_not_use() {
        let mut personal = HashMap::from([
            (AUTH_METHOD_ENV.to_string(), "oauth-personal".to_string()),
            ("GEMINI_API_KEY".to_string(), "secret".to_string()),
            ("GOOGLE_API_KEY".to_string(), "google".to_string()),
            ("GOOGLE_CLOUD_PROJECT".to_string(), "proj".to_string()),
        ]);
        apply_antigravity_env_policy(&mut personal);
        assert!(!personal.contains_key("GEMINI_API_KEY"));
        assert!(!personal.contains_key("GOOGLE_API_KEY"));
        assert!(!personal.contains_key("GOOGLE_CLOUD_PROJECT"));

        let mut api = HashMap::from([
            (AUTH_METHOD_ENV.to_string(), "gemini-api-key".to_string()),
            ("GEMINI_API_KEY".to_string(), "secret".to_string()),
            ("GOOGLE_API_KEY".to_string(), "google".to_string()),
        ]);
        apply_antigravity_env_policy(&mut api);
        assert_eq!(api.get("GEMINI_API_KEY").unwrap(), "secret");
        assert!(!api.contains_key("GOOGLE_API_KEY"));

        let mut platform = HashMap::from([
            (AUTH_METHOD_ENV.to_string(), "agent-platform".to_string()),
            ("GOOGLE_API_KEY".to_string(), "google".to_string()),
            ("GEMINI_API_KEY".to_string(), "secret".to_string()),
        ]);
        apply_antigravity_env_policy(&mut platform);
        assert_eq!(platform.get("GOOGLE_API_KEY").unwrap(), "google");
        assert!(!platform.contains_key("GEMINI_API_KEY"));

        let mut provider = HashMap::from([
            (AUTH_METHOD_ENV.to_string(), "model_provider".to_string()),
            ("GEMINI_API_KEY".to_string(), "secret".to_string()),
            ("GOOGLE_API_KEY".to_string(), "google".to_string()),
        ]);
        apply_antigravity_env_policy(&mut provider);
        assert_eq!(provider.get("GEMINI_API_KEY").unwrap(), "secret");
        assert!(!provider.contains_key("GOOGLE_API_KEY"));
        assert_eq!(recorded_auth_method(&provider), Some("gemini-api-key"));
    }

    #[test]
    fn env_policy_leaves_unrecorded_methods_alone() {
        let mut env = HashMap::from([("GEMINI_API_KEY".to_string(), "secret".to_string())]);
        apply_antigravity_env_policy(&mut env);
        assert_eq!(env.get("GEMINI_API_KEY").unwrap(), "secret");
    }

    #[test]
    fn settings_sync_writes_auth_type_and_preserves_foreign_keys() {
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = env("oauth-business");
        runtime.insert(
            "GEMINI_HOME".to_string(),
            dir.path().to_string_lossy().into_owned(),
        );
        runtime.insert("GOOGLE_CLOUD_PROJECT".to_string(), "acme".to_string());
        runtime.insert("GOOGLE_CLOUD_LOCATION".to_string(), "global".to_string());
        let report = sync_antigravity_settings(&runtime, None);
        assert_eq!(report.status, AntigravitySyncStatus::Written);
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(report.path).unwrap()).unwrap();
        assert_eq!(parsed["auth"]["type"], "oauth-business");
        assert_eq!(parsed["gcp"]["project"], "acme");
        assert_eq!(parsed["gcp"]["location"], "global");

        let second = sync_antigravity_settings(&runtime, None);
        assert_eq!(second.status, AntigravitySyncStatus::AlreadyCurrent);
    }

    #[test]
    fn settings_sync_defaults_oauth_personal_when_nothing_is_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = HashMap::from([(
            "GEMINI_HOME".to_string(),
            dir.path().to_string_lossy().into_owned(),
        )]);
        let report = sync_antigravity_settings(&runtime, None);
        assert_eq!(report.status, AntigravitySyncStatus::Written);
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(report.path).unwrap()).unwrap();
        assert_eq!(parsed["auth"]["type"], "oauth-personal");
    }

    #[test]
    fn settings_sync_keeps_the_gcp_project_the_user_entered() {
        let dir = tempfile::tempdir().unwrap();
        let acp_dir = dir.path().join(ACP_SUBDIR);
        std::fs::create_dir_all(&acp_dir).unwrap();
        std::fs::write(
            acp_dir.join("settings.json"),
            r#"{"gcp":{"project":"acme","location":"global"}}"#,
        )
        .unwrap();
        let mut runtime = env("oauth-business");
        runtime.insert(
            "GEMINI_HOME".to_string(),
            dir.path().to_string_lossy().into_owned(),
        );

        let report = sync_antigravity_settings(&runtime, None);

        assert_eq!(report.status, AntigravitySyncStatus::Written);
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(report.path).unwrap()).unwrap();
        assert_eq!(parsed["auth"]["type"], "oauth-business");
        assert_eq!(parsed["gcp"]["project"], "acme");
        assert_eq!(parsed["gcp"]["location"], "global");
    }

    #[test]
    fn gemini_home_expands_tilde_against_the_child_home() {
        let home = PathBuf::from("/srv/agy");
        assert_eq!(
            resolve_gemini_home_from(Some("~/profile"), Some(&home)),
            PathBuf::from("/srv/agy/profile")
        );
        assert_eq!(
            resolve_gemini_home_from(None, Some(&home)),
            PathBuf::from("/srv/agy/.gemini")
        );
    }

    #[test]
    fn launch_env_injects_dotenv_keys_and_strips_legacy_settings_env() {
        let dir = tempfile::tempdir().unwrap();
        let acp_dir = dir.path().join(ACP_SUBDIR);
        std::fs::create_dir_all(&acp_dir).unwrap();
        std::fs::write(
            acp_dir.join("settings.json"),
            r#"{"keep":true,"auth":{"type":"gemini-api-key"},"env":{"GEMINI_API_KEY":"legacy-key","GOOGLE_GEMINI_BASE_URL":"https://legacy.example/v1"}}"#,
        )
        .unwrap();

        let mut runtime = env("gemini-api-key");
        runtime.insert(
            "GEMINI_HOME".to_string(),
            dir.path().to_string_lossy().into_owned(),
        );
        let report = apply_antigravity_launch_env(&mut runtime);
        assert_eq!(report.status, AntigravitySyncStatus::Written);
        assert_eq!(
            runtime.get("GEMINI_API_KEY").map(String::as_str),
            Some("legacy-key")
        );
        assert_eq!(
            runtime.get("GOOGLE_GEMINI_BASE_URL").map(String::as_str),
            Some("https://legacy.example/v1")
        );

        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&report.path).unwrap()).unwrap();
        assert_eq!(parsed["keep"], true);
        assert_eq!(parsed["auth"]["type"], "gemini-api-key");
        assert!(
            parsed.get("env").is_none(),
            "settings.json must not contain an env object for agy_acp_server"
        );

        let dotenv_text = std::fs::read_to_string(acp_dir.join(".env")).unwrap();
        assert!(dotenv_text.contains("GEMINI_API_KEY=legacy-key"));
        assert!(dotenv_text.contains("GOOGLE_GEMINI_BASE_URL=https://legacy.example/v1"));

        // Under oauth-personal, .env keys must still be scrubbed by the env policy.
        let mut oauth_runtime = env("oauth-personal");
        oauth_runtime.insert(
            "GEMINI_HOME".to_string(),
            dir.path().to_string_lossy().into_owned(),
        );
        let oauth_report = apply_antigravity_launch_env(&mut oauth_runtime);
        assert_eq!(oauth_report.status, AntigravitySyncStatus::Written);
        assert!(!oauth_runtime.contains_key("GEMINI_API_KEY"));
    }
}
