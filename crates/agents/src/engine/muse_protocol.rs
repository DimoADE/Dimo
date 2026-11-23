//! Muse Code MSP (`muse serve`) JSON-RPC 2.0 notification normalization,
//! approval/question mapping, model catalog parsing, session MCP translation,
//! and multimodal prompt serialization.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use chrono::{TimeZone, Utc};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::{
    conversation::ContentBlock,
    engine::{
        EngineAuth, EngineCapabilities, EngineCommandSpec, EngineEffortSpec, EngineModeSpec,
        EngineModelInfo, EnginePermissionDecision, EngineRateLimits, EngineSelectChoice,
        EngineToolClassification, PromptMode, classify_standard_tool_call,
        resolve_home_dir_from_env,
    },
    permissions::{AgentPermissionOption, AgentPermissionOptionKind},
};

pub(crate) fn str_any(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| value.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Generates an RFC 9562 UUIDv7 string for MSP `commandId` and `sessionId`.
pub fn mint_uuid_v7() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut bytes = *Uuid::new_v4().as_bytes();
    bytes[0] = ((millis >> 40) & 0xff) as u8;
    bytes[1] = ((millis >> 32) & 0xff) as u8;
    bytes[2] = ((millis >> 24) & 0xff) as u8;
    bytes[3] = ((millis >> 16) & 0xff) as u8;
    bytes[4] = ((millis >> 8) & 0xff) as u8;
    bytes[5] = (millis & 0xff) as u8;
    // Version 7 (0111xxxx)
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    // RFC 4122/9562 variant (10xxxxxx)
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

/// Canonicalizes a filesystem path, correcting case on case-insensitive filesystems.
/// On Windows, strips the `\\?\` verbatim prefix so callers can safely pass it as `current_dir`.
pub fn muse_canonical_path(path: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    strip_windows_verbatim_prefix(&canonical)
}

pub(crate) fn strip_windows_verbatim_prefix(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let raw = path.to_string_lossy();
        if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(rest) = raw.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

/// Formats a workspace root path for MSP `turn/start` `workspaceRoots`.
/// On Windows, Muse validates canonical case and expects verbatim `\\?\` / `\\?\UNC\` paths.
pub fn muse_workspace_root(path: &Path) -> String {
    #[cfg(windows)]
    {
        let canonical = std::fs::canonicalize(path)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| path.to_string_lossy().replace('/', "\\"));
        to_windows_verbatim_path(&canonical)
    }
    #[cfg(not(windows))]
    {
        muse_canonical_path(path).to_string_lossy().into_owned()
    }
}

pub fn to_windows_verbatim_path(path: &str) -> String {
    if path.starts_with(r"\\?\") {
        path.to_string()
    } else if let Some(unc) = path.strip_prefix(r"\\") {
        format!(r"\\?\UNC\{unc}")
    } else {
        format!(r"\\?\{path}")
    }
}

pub fn is_muse_full_access(permission_mode: Option<&str>) -> bool {
    matches!(
        permission_mode.map(str::trim),
        Some(
            "full-access"
                | "yolo"
                | "bypassPermissions"
                | "danger-full-access"
                | "dangerFullAccess"
                | "unrestricted"
                | ":unrestricted"
                | "auto"
        )
    )
}

pub fn muse_approval_mode(permission_mode: Option<&str>) -> &'static str {
    if is_muse_full_access(permission_mode) {
        "allowAll"
    } else {
        "promptUnmatched"
    }
}

pub fn muse_permission_profile(permission_mode: Option<&str>) -> &'static str {
    if is_muse_full_access(permission_mode) {
        ":unrestricted"
    } else {
        ":ask-me"
    }
}

pub(crate) fn muse_capabilities(engine_id: &str) -> EngineCapabilities {
    EngineCapabilities {
        engine_id: engine_id.to_string(),
        supports_native_steer: true,
        supports_native_revert: false,
        supports_native_fork: false,
        supports_rate_limit_push: true,
        supports_prompt_cache_ttl: false,
        records_idle_compaction_activity: false,
        modes: EngineModeSpec {
            modes: vec![
                EngineSelectChoice {
                    id: "default".to_string(),
                    label: "Approval Required".to_string(),
                    description: Some(
                        "Sandboxed execution with interactive approval prompts (:ask-me)"
                            .to_string(),
                    ),
                },
                EngineSelectChoice {
                    id: "full-access".to_string(),
                    label: "Full Access".to_string(),
                    description: Some(
                        "Unrestricted execution without sandbox or approval prompts (:unrestricted)"
                            .to_string(),
                    ),
                },
            ],
            default_mode_id: "default".to_string(),
            yolo_mode_id: "full-access".to_string(),
        },
        effort: Some(EngineEffortSpec {
            choices: vec![
                EngineSelectChoice {
                    id: "low".to_string(),
                    label: "Low".to_string(),
                    description: None,
                },
                EngineSelectChoice {
                    id: "medium".to_string(),
                    label: "Medium".to_string(),
                    description: None,
                },
                EngineSelectChoice {
                    id: "high".to_string(),
                    label: "High".to_string(),
                    description: None,
                },
                EngineSelectChoice {
                    id: "xhigh".to_string(),
                    label: "Extra High".to_string(),
                    description: None,
                },
                EngineSelectChoice {
                    id: "max".to_string(),
                    label: "Max".to_string(),
                    description: None,
                },
            ],
            default_value: "high".to_string(),
        }),
        default_commands: vec![EngineCommandSpec {
            name: "compact".to_string(),
            description: "Compact conversation context".to_string(),
        }],
    }
}

pub(crate) fn muse_normalize_mode(raw: &str) -> Option<String> {
    match raw.trim() {
        "yolo" | "bypassPermissions" | "full-access" | "agent-full-access"
        | "danger-full-access" | "dangerFullAccess" | "unrestricted" | ":unrestricted" | "auto" => {
            Some("full-access".to_string())
        }
        "default" | "approval-required" | "ask-me" | ":ask-me" | "auto-review" | "acceptEdits"
        | "workspace-write" | "agent" => Some("default".to_string()),
        _ => None,
    }
}

pub(crate) fn resolve_muse_auth(env: &HashMap<String, String>) -> EngineAuth {
    if let Some(api_key) = env.get("META_API_KEY").filter(|v| !v.trim().is_empty()) {
        return EngineAuth::ApiKey {
            api_key: api_key.clone(),
            base_url: env
                .get("META_API_BASE_URL")
                .filter(|u| !u.trim().is_empty())
                .cloned(),
        };
    }
    EngineAuth::Ambient
}

pub(crate) fn prepare_muse_launch_env(
    locked_program: &Path,
    snapshot_env: &HashMap<String, String>,
    launch_env: &mut HashMap<String, String>,
    scrubbed_keys: &mut Vec<String>,
) {
    if locked_program.is_absolute()
        && locked_program.is_file()
        && locked_program
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|stem| stem.eq_ignore_ascii_case("muse"))
        && !launch_env.contains_key("DIMO_MUSE_PATH")
        && !launch_env.contains_key("MUSE_PATH")
    {
        launch_env.insert(
            "MUSE_PATH".to_string(),
            locked_program.to_string_lossy().into_owned(),
        );
    }

    launch_env
        .entry("MUSE_NO_AUTO_UPDATE".to_string())
        .or_insert_with(|| "1".to_string());

    // Drop an inherited META_API_KEY so Muse uses its `muse login` OAuth session
    // unless the user explicitly configured META_API_KEY in Dimo settings/env.
    let explicit_api_key = launch_env
        .get("META_API_KEY")
        .map(String::as_str)
        .map(str::trim)
        .is_some_and(|v| !v.is_empty());
    let mode_is_api = launch_env
        .get("MUSE_AUTH_MODE")
        .or_else(|| snapshot_env.get("MUSE_AUTH_MODE"))
        .map(String::as_str)
        .is_some_and(|m| m.trim().eq_ignore_ascii_case("official_api"));
    if !explicit_api_key && !mode_is_api {
        launch_env.remove("META_API_KEY");
        if !scrubbed_keys.iter().any(|k| k == "META_API_KEY") {
            scrubbed_keys.push("META_API_KEY".to_string());
        }
    }
}

fn resolve_muse_config_dir(env: &HashMap<String, String>) -> Option<PathBuf> {
    if let Some(explicit) = env
        .get("XDG_CONFIG_HOME")
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(PathBuf::from(explicit).join("muse"));
    }
    if let Some(explicit) = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(explicit).join("muse"));
    }
    resolve_home_dir_from_env(env).map(|home| home.join(".config").join("muse"))
}

fn read_muse_settings_json(env: &HashMap<String, String>) -> Option<Value> {
    let dir = resolve_muse_config_dir(env)?;
    let raw = std::fs::read_to_string(dir.join("settings.json")).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

pub(crate) fn resolve_muse_default_model(env: &HashMap<String, String>) -> Option<String> {
    let settings = read_muse_settings_json(env)?;
    settings
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub(crate) fn resolve_muse_default_mode(env: &HashMap<String, String>) -> Option<String> {
    let settings = read_muse_settings_json(env)?;
    let profile = settings
        .get("permissions")
        .and_then(|p| p.get("default_profile"))
        .and_then(Value::as_str)?;
    muse_normalize_mode(profile)
}

pub(crate) fn format_muse_model_label(model_id: &str, display_label: Option<&str>) -> String {
    let candidate = display_label
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(model_id);
    if candidate == model_id && candidate.starts_with("muse-") {
        candidate
            .split('-')
            .map(|seg| {
                let mut chars = seg.chars();
                match chars.next() {
                    Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        candidate.to_string()
    }
}

pub fn parse_muse_models_response(result: &Value) -> Vec<EngineModelInfo> {
    let provider_id = result
        .get("providerId")
        .and_then(Value::as_str)
        .unwrap_or("meta");
    if provider_id != "meta" {
        return Vec::new();
    }
    let Some(items) = result.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        if item
            .get("providerId")
            .and_then(Value::as_str)
            .is_some_and(|p| p != "meta")
        {
            continue;
        }
        let Some(id) = str_any(item, &["modelId", "id"]) else {
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let display_label = item.get("displayLabel").and_then(Value::as_str);
        let label = format_muse_model_label(&id, display_label);
        let is_default = item
            .get("isDefault")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let description = item
            .get("defaultReasoningEffort")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|eff| format!("Default reasoning: {eff}"));
        out.push(EngineModelInfo {
            id,
            label,
            description,
            is_default,
        });
    }
    out
}

/// Converts Dimo's session MCP server map into Muse MSP `config.mcpServers` wire format.
///
/// Exact upstream schema (`meta-models/muse-code-sdk` `SessionMcpServerConfig`):
/// - Stdio: `{ "transport": "stdio", "command": "...", "args": [...], "env": {...}, "mode": "optional" }`
/// - StreamableHttp: `{ "transport": "streamableHttp", "url": "https://...", "headers": {...}, "mode": "optional" }`
pub fn serialize_muse_session_mcp(mcp_servers: &Value) -> Option<Value> {
    let obj = mcp_servers.as_object()?;
    if obj.is_empty() {
        return None;
    }
    let mut mapped = Map::new();
    for (name, spec) in obj {
        let Some(entry) = spec.as_object() else {
            continue;
        };
        if entry.get("disabled").and_then(Value::as_bool) == Some(true)
            || entry.get("enabled").and_then(Value::as_bool) == Some(false)
        {
            continue;
        }
        let explicit_transport = entry
            .get("transport")
            .or_else(|| entry.get("type"))
            .and_then(Value::as_str)
            .map(str::trim);
        if explicit_transport.is_some_and(|t| t.eq_ignore_ascii_case("sse")) {
            continue;
        }
        let mode = entry
            .get("mode")
            .and_then(Value::as_str)
            .filter(|m| matches!(*m, "optional" | "required"))
            .unwrap_or("optional");

        if let Some(url) = entry
            .get("url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let mut server = Map::new();
            server.insert("transport".into(), json!("streamableHttp"));
            server.insert("url".into(), json!(url));
            server.insert("mode".into(), json!(mode));
            if let Some(headers) = entry
                .get("headers")
                .and_then(Value::as_object)
                .filter(|h| !h.is_empty())
            {
                let mut clean_headers = Map::new();
                for (hk, hv) in headers {
                    if let Some(s) = hv.as_str() {
                        clean_headers.insert(hk.clone(), json!(s));
                    }
                }
                if !clean_headers.is_empty() {
                    server.insert("headers".into(), Value::Object(clean_headers));
                }
            }
            mapped.insert(name.clone(), Value::Object(server));
        } else if let Some(command) = entry
            .get("command")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let mut server = Map::new();
            server.insert("transport".into(), json!("stdio"));
            server.insert("command".into(), json!(command));
            server.insert("mode".into(), json!(mode));
            if let Some(args) = entry.get("args").and_then(Value::as_array) {
                let clean_args: Vec<Value> = args
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|s| json!(s))
                    .collect();
                if !clean_args.is_empty() {
                    server.insert("args".into(), Value::Array(clean_args));
                }
            }
            if let Some(env) = entry
                .get("env")
                .and_then(Value::as_object)
                .filter(|e| !e.is_empty())
            {
                let mut clean_env = Map::new();
                for (ek, ev) in env {
                    if let Some(s) = ev.as_str() {
                        clean_env.insert(ek.clone(), json!(s));
                    }
                }
                if !clean_env.is_empty() {
                    server.insert("env".into(), Value::Object(clean_env));
                }
            }
            mapped.insert(name.clone(), Value::Object(server));
        }
    }
    if mapped.is_empty() {
        None
    } else {
        Some(json!({ "mcpServers": Value::Object(mapped) }))
    }
}

fn strip_file_uri_to_local_path(raw: &str) -> String {
    if let Ok(parsed) = url::Url::parse(raw)
        && parsed.scheme() == "file"
        && let Ok(path) = parsed.to_file_path()
    {
        return path.to_string_lossy().into_owned();
    }
    raw.to_string()
}

pub fn serialize_muse_input_items(
    blocks: &[ContentBlock],
    mode: PromptMode,
) -> (Vec<Value>, String) {
    let mut parts = Vec::new();
    let mut display_segments = Vec::new();
    for block in blocks {
        match block {
            ContentBlock::Text { text } => {
                if !text.is_empty() {
                    parts.push(json!({ "type": "text", "text": text }));
                    display_segments.push(text.clone());
                }
            }
            ContentBlock::Image {
                data,
                mime_type,
                uri,
                ..
            } => {
                let trimmed_data = data.trim();
                let media_type = if mime_type.trim().is_empty() {
                    "image/png"
                } else {
                    mime_type.trim()
                };
                if !trimmed_data.is_empty() {
                    parts.push(json!({
                        "type": "image",
                        "base64Data": trimmed_data,
                        "mediaType": media_type,
                    }));
                } else if let Some(raw_uri) =
                    uri.as_deref().map(str::trim).filter(|s| !s.is_empty())
                {
                    let local_path = strip_file_uri_to_local_path(raw_uri);
                    if let Ok(bytes) = std::fs::read(&local_path) {
                        let encoded = BASE64_STANDARD.encode(bytes);
                        parts.push(json!({
                            "type": "image",
                            "base64Data": encoded,
                            "mediaType": media_type,
                        }));
                    }
                }
            }
            ContentBlock::Resource { uri, .. } => {
                let text = format!("@{uri}");
                parts.push(json!({ "type": "text", "text": text }));
                display_segments.push(text);
            }
            _ => {}
        }
    }
    if parts.is_empty() && mode != PromptMode::Compact {
        parts.push(json!({ "type": "text", "text": "" }));
    }
    let display_text = if display_segments.is_empty() {
        "Image attachment".to_string()
    } else {
        display_segments.join("\n")
    };
    (parts, display_text)
}

#[derive(Debug, Clone)]
pub struct MuseApprovalChoice {
    pub choice_id: String,
    pub label: String,
    pub decision: String,
    pub scope: String,
}

#[derive(Debug, Clone)]
pub struct PendingMuseApproval {
    pub approval_id: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub requirement_id: Value,
    pub choices: Vec<MuseApprovalChoice>,
    pub from_subagent: bool,
}

#[derive(Debug, Clone)]
pub struct MuseQuestionSpec {
    pub id: String,
    pub question: String,
    pub multi_select: bool,
    pub option_labels: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PendingMuseUserInput {
    pub user_input_id: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub questions: Vec<MuseQuestionSpec>,
}

fn map_muse_decision_kind(decision: &str, scope: &str) -> Option<AgentPermissionOptionKind> {
    match decision {
        "approved" | "allow" => Some(AgentPermissionOptionKind::AllowOnce),
        "approvedForSession" => Some(AgentPermissionOptionKind::AllowAlways),
        "approvedPolicyAmendment" => match scope {
            "session" | "localPersistent" => Some(AgentPermissionOptionKind::AllowAlways),
            _ => Some(AgentPermissionOptionKind::AllowOnce),
        },
        "denied" | "deny" | "deniedPolicyAmendment" => Some(AgentPermissionOptionKind::RejectOnce),
        "abort" => Some(AgentPermissionOptionKind::RejectOnce),
        _ => None,
    }
}

pub fn build_muse_approval_options(choices: &[MuseApprovalChoice]) -> Vec<AgentPermissionOption> {
    let mut out = Vec::new();
    for c in choices {
        let Some(kind) = map_muse_decision_kind(&c.decision, &c.scope) else {
            continue;
        };
        out.push(AgentPermissionOption {
            id: c.choice_id.clone(),
            label: if c.label.trim().is_empty() {
                c.decision.clone()
            } else {
                c.label.clone()
            },
            kind,
            description: None,
        });
    }
    if out.is_empty() {
        out.push(AgentPermissionOption {
            id: "accept".to_string(),
            label: "Allow once".to_string(),
            kind: AgentPermissionOptionKind::AllowOnce,
            description: None,
        });
        out.push(AgentPermissionOption {
            id: "decline".to_string(),
            label: "Decline".to_string(),
            kind: AgentPermissionOptionKind::RejectOnce,
            description: None,
        });
    }
    out
}

/// Resolves the exact MSP `choiceId` and normalized behavior string for a permission decision.
pub fn pick_muse_approval_choice_id(
    pending: &PendingMuseApproval,
    decision: &EnginePermissionDecision,
) -> Option<(String, String)> {
    // 1. Direct match on choice_id if caller passed one of the advertised choiceIds.
    if let Some(opt_id) = decision
        .option_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some(found) = pending.choices.iter().find(|c| c.choice_id == opt_id) {
            let behavior = if map_muse_decision_kind(&found.decision, &found.scope)
                .is_some_and(AgentPermissionOptionKind::is_allow)
            {
                "allow".to_string()
            } else {
                "deny".to_string()
            };
            return Some((found.choice_id.clone(), behavior));
        }
        // Match semantic aliases ("accept", "acceptForSession", "acceptAlways", "decline", "cancel").
        let preferred = match opt_id {
            "acceptForSession" | "allow_for_session" => pending.choices.iter().find(|c| {
                c.decision == "approvedForSession"
                    || (c.decision == "approvedPolicyAmendment" && c.scope == "session")
            }),
            "acceptAlways" | "allow_always" => pending
                .choices
                .iter()
                .find(|c| c.decision == "approvedPolicyAmendment" && c.scope == "localPersistent")
                .or_else(|| {
                    pending
                        .choices
                        .iter()
                        .find(|c| c.decision == "approvedForSession")
                }),
            "decline" | "deny" | "reject" => pending
                .choices
                .iter()
                .find(|c| c.decision == "denied" || c.decision == "deniedPolicyAmendment")
                .or_else(|| pending.choices.iter().find(|c| c.decision == "abort")),
            "cancel" | "abort" => pending.choices.iter().find(|c| c.decision == "abort"),
            _ => None,
        };
        if let Some(found) = preferred {
            let behavior = if map_muse_decision_kind(&found.decision, &found.scope)
                .is_some_and(AgentPermissionOptionKind::is_allow)
            {
                "allow".to_string()
            } else {
                "deny".to_string()
            };
            return Some((found.choice_id.clone(), behavior));
        }
    }

    // 2. Fallback by `decision.approved` boolean.
    if decision.approved {
        let choice = pending
            .choices
            .iter()
            .find(|c| c.decision == "approved")
            .or_else(|| {
                pending.choices.iter().find(|c| {
                    map_muse_decision_kind(&c.decision, &c.scope)
                        .is_some_and(AgentPermissionOptionKind::is_allow)
                })
            })?;
        Some((choice.choice_id.clone(), "allow".to_string()))
    } else {
        let choice = pending
            .choices
            .iter()
            .find(|c| c.decision == "denied" || c.decision == "deniedPolicyAmendment")
            .or_else(|| pending.choices.iter().find(|c| c.decision == "abort"))?;
        Some((choice.choice_id.clone(), "deny".to_string()))
    }
}

/// Converts Dimo's question answers JSON object into Muse's `userInput/answer` `answers` array.
pub fn build_muse_user_input_answers(
    pending: &PendingMuseUserInput,
    answers: &Value,
    cancelled: bool,
) -> Vec<Value> {
    let mut out = Vec::new();
    let map = answers.as_object();
    for q in &pending.questions {
        if cancelled {
            out.push(json!({
                "questionId": q.id,
                "freeText": "Cancelled by user",
            }));
            continue;
        }
        let raw = map.and_then(|m| m.get(&q.id).or_else(|| m.get(&q.question)));
        let values: Vec<String> = match raw {
            Some(Value::String(s)) => vec![s.clone()],
            Some(Value::Array(arr)) => arr
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
            Some(Value::Object(obj)) => obj
                .get("answers")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            _ => Vec::new(),
        };

        let mut selected = Vec::new();
        let mut free_parts = Vec::new();
        for val in values {
            if q.option_labels.iter().any(|lbl| lbl == &val) {
                if !selected.contains(&val) {
                    selected.push(val);
                }
            } else if !val.trim().is_empty() {
                free_parts.push(val);
            }
        }
        let free_text = free_parts.join("\n");
        let bounded_free: String = free_text.chars().take(500).collect();

        let mut entry = Map::new();
        entry.insert("questionId".into(), json!(q.id));
        if !selected.is_empty() {
            if q.multi_select {
                entry.insert("selectedLabels".into(), json!(selected));
            } else {
                entry.insert("selectedLabel".into(), json!(selected[0]));
            }
            if !bounded_free.is_empty() {
                entry.insert("note".into(), json!(bounded_free));
            }
        } else if !bounded_free.is_empty() {
            entry.insert("freeText".into(), json!(bounded_free));
        } else if let Some(first_opt) = q.option_labels.first() {
            if q.multi_select {
                entry.insert("selectedLabels".into(), json!([first_opt]));
            } else {
                entry.insert("selectedLabel".into(), json!(first_opt));
            }
        } else {
            // Muse's MSP schema rejects empty `freeText`; emit a concise sentinel when
            // neither options nor user text exist.
            entry.insert("freeText".into(), json!("No answer provided"));
        }
        out.push(Value::Object(entry));
    }
    out
}

pub fn parse_muse_rate_limits_payload(params: &Value) -> Option<EngineRateLimits> {
    let quota = params.get("quota");
    let tier = params
        .get("tier")
        .or_else(|| quota.and_then(|q| q.get("planName").or_else(|| q.get("tier"))))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let quota_first_window = quota
        .and_then(|q| q.get("windows"))
        .and_then(Value::as_array)
        .and_then(|windows| {
            windows
                .iter()
                .find(|w| w.get("usedPercent").and_then(Value::as_f64).is_some())
                .or_else(|| windows.first())
        });
    let window = params.get("window").or(quota_first_window);
    let weekly = params.get("weekly");
    let used_percent = window
        .and_then(|w| w.get("usedPercent"))
        .and_then(Value::as_f64)
        .or_else(|| {
            weekly
                .and_then(|w| w.get("usedPercent"))
                .and_then(Value::as_f64)
        });
    let resets_raw = window
        .and_then(|w| w.get("resetsAtMs").or_else(|| w.get("resetsAt")))
        .and_then(Value::as_i64)
        .or_else(|| {
            weekly
                .and_then(|w| w.get("resetsAtMs").or_else(|| w.get("resetsAt")))
                .and_then(Value::as_i64)
        });
    let reset_at = resets_raw.and_then(|ts| {
        if ts.abs() >= 1_000_000_000_000 {
            Utc.timestamp_millis_opt(ts).single()
        } else {
            Utc.timestamp_opt(ts, 0).single()
        }
    });
    if tier.is_none() && used_percent.is_none() && reset_at.is_none() {
        return None;
    }
    Some(EngineRateLimits {
        requests_remaining: None,
        tokens_remaining: None,
        reset_at,
        credits_remaining: None,
        plan_type: tier,
        utilization: used_percent.map(|pct| (pct / 100.0).clamp(0.0, 2.0)),
    })
}

pub(crate) fn muse_classify_tool_call(
    raw_name: &str,
    input: &Value,
    _parent_tool_use_id: Option<&str>,
) -> EngineToolClassification {
    if raw_name.starts_with("mcp__") {
        return classify_standard_tool_call(raw_name, input);
    }
    let lower = raw_name.to_ascii_lowercase();
    if lower == "usershell"
        || lower.contains("shell")
        || lower.contains("bash")
        || lower == "exec_command"
    {
        let cmd = str_any(input, &["command", "cmd", "commandText"])
            .unwrap_or_else(|| raw_name.to_string());
        return EngineToolClassification {
            semantic_kind: "execute".to_string(),
            title: cmd,
            meta: None,
        };
    }
    if lower.contains("write") || lower.contains("edit") || lower.contains("patch") {
        let path = str_any(input, &["file_path", "path", "filePath"]);
        let title = match path {
            Some(p) => format!("{raw_name} {p}"),
            None => raw_name.to_string(),
        };
        return EngineToolClassification {
            semantic_kind: "edit".to_string(),
            title,
            meta: None,
        };
    }
    if lower.contains("read") || lower == "view_file" {
        let path = str_any(input, &["file_path", "path", "filePath"]);
        let title = match path {
            Some(p) => format!("Read {p}"),
            None => raw_name.to_string(),
        };
        return EngineToolClassification {
            semantic_kind: "read".to_string(),
            title,
            meta: None,
        };
    }
    if lower.contains("grep") || lower.contains("glob") || lower.contains("search_files") {
        let pattern = str_any(input, &["pattern", "query"]);
        let title = match pattern {
            Some(p) => format!("{raw_name} {p}"),
            None => raw_name.to_string(),
        };
        return EngineToolClassification {
            semantic_kind: "search".to_string(),
            title,
            meta: None,
        };
    }
    if lower.contains("web") || lower.contains("browse") || lower.contains("fetch") {
        let target = str_any(input, &["url", "query", "pattern"]);
        let title = match target {
            Some(t) => format!("{raw_name} {t}"),
            None => raw_name.to_string(),
        };
        return EngineToolClassification {
            semantic_kind: "fetch".to_string(),
            title,
            meta: None,
        };
    }
    classify_standard_tool_call(raw_name, input)
}

pub use super::muse_events::{
    MuseAutoApproveAction, MuseNotificationTracker, normalize_muse_notification,
};

pub async fn resolve_muse_binary(
    spec: &crate::engine::EngineStartSpec,
) -> Result<PathBuf, crate::engine::EngineError> {
    if let Some(val) = spec
        .env
        .get("DIMO_MUSE_PATH")
        .map(String::as_str)
        .map(str::trim)
        && !val.is_empty()
    {
        let p = PathBuf::from(val);
        if p.is_file() {
            return Ok(p);
        }
        return Err(crate::engine::EngineError::BinaryNotFound(format!(
            "DIMO_MUSE_PATH `{val}` not found"
        )));
    }
    if let Some(val) = std::env::var_os("DIMO_MUSE_PATH").filter(|s| !s.is_empty()) {
        let p = PathBuf::from(&val);
        if p.is_file() {
            return Ok(p);
        }
        return Err(crate::engine::EngineError::BinaryNotFound(format!(
            "DIMO_MUSE_PATH `{}` not found",
            val.to_string_lossy()
        )));
    }
    if let Some(val) = spec.env.get("MUSE_PATH").map(String::as_str).map(str::trim)
        && !val.is_empty()
    {
        let p = PathBuf::from(val);
        if p.is_file() {
            return Ok(p);
        }
    }
    if let Some(val) = std::env::var_os("MUSE_PATH").filter(|s| !s.is_empty()) {
        let p = PathBuf::from(val);
        if p.is_file() {
            return Ok(p);
        }
    }

    let bins: &[&str] = if cfg!(windows) {
        &["muse.cmd", "muse.exe", "muse.bat"]
    } else {
        &["muse"]
    };

    if let Some(spec_path) = spec.env.get("PATH").or_else(|| spec.env.get("Path")) {
        for dir in std::env::split_paths(spec_path) {
            for name in bins {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }

    for name in bins {
        if let Some(found) = workspace_utils::shell::resolve_executable_path(name).await {
            return Ok(found);
        }
    }

    let home = spec
        .env
        .get("USERPROFILE")
        .or_else(|| spec.env.get("HOME"))
        .cloned()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .or_else(|| std::env::var("HOME").ok());
    let mut fallback_dirs = Vec::new();
    if let Some(h) = home {
        fallback_dirs.push(PathBuf::from(h).join(".local").join("bin"));
    }
    if cfg!(windows)
        && let Ok(local) = std::env::var("LOCALAPPDATA")
    {
        fallback_dirs.push(PathBuf::from(local).join("Programs").join("muse"));
    }
    for dir in fallback_dirs {
        for name in bins {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    Err(crate::engine::EngineError::BinaryNotFound(
        "muse CLI not found".into(),
    ))
}

/// Multi-instance cache key isolating `MuseServer` processes across workspace,
/// `ProviderInstanceConfig`, auth/endpoint fingerprint, native `~/.config/muse`
/// configuration files, and sandbox posture (`--disable-sandbox`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MuseServerCacheKey {
    pub workspace_id: uuid::Uuid,
    pub provider_instance_id: Option<String>,
    pub auth_fingerprint: String,
    pub native_config_fingerprint: String,
    pub disable_sandbox: bool,
}

impl MuseServerCacheKey {
    pub fn from_spec(spec: &crate::engine::EngineStartSpec, disable_sandbox: bool) -> Self {
        Self {
            workspace_id: spec.workspace_id,
            provider_instance_id: spec
                .provider_instance_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            auth_fingerprint: spec.auth_fingerprint(),
            native_config_fingerprint: spec.native_muse_config_fingerprint(),
            disable_sandbox,
        }
    }
}
