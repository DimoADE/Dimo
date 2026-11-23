use std::path::{Path, PathBuf};

use api_types::AgentKind;
use chrono::{DateTime, TimeZone, Utc};
use serde_json::Value;

use super::{
    AgentHistoryError, ImportedAgentMessage, ImportedAgentMessageMetadata,
    ImportedAgentMessageRole, ImportedAgentSession,
};

fn timestamp_from_micros(value: Option<&Value>) -> Option<DateTime<Utc>> {
    let raw = value?
        .as_i64()
        .or_else(|| value?.as_u64().map(|u| u as i64))?;
    let millis = raw / 1_000;
    Utc.timestamp_millis_opt(millis).single()
}

fn extract_text_from_parts(value: &Value) -> String {
    match value {
        Value::String(s) => s.trim().to_string(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                item.as_str()
                    .map(str::trim)
                    .or_else(|| item.get("text").and_then(Value::as_str).map(str::trim))
                    .or_else(|| item.get("content").and_then(Value::as_str).map(str::trim))
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(map) => map
            .get("text")
            .or_else(|| map.get("content"))
            .or_else(|| map.get("message"))
            .map(extract_text_from_parts)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

/// Parses a Muse Code `session.jsonl` transcript located under
/// `$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<sessionId>/session.jsonl`.
pub(super) fn parse_muse_session_jsonl(
    path: &Path,
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    let raw = std::fs::read_to_string(path).map_err(|error| AgentHistoryError::Read {
        path: path.to_path_buf(),
        error: error.to_string(),
    })?;

    let fallback_session_id = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|n| n.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| "muse-session".to_string());

    let mut session_id = fallback_session_id;
    let mut workspace_path: Option<PathBuf> = None;
    let mut title: Option<String> = None;
    let mut messages: Vec<ImportedAgentMessage> = Vec::new();

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        if let Some(stream_id) = record
            .get("stream")
            .and_then(|s| s.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            session_id = stream_id.to_string();
        }

        let created_at = timestamp_from_micros(record.get("recorded_at"));
        let Some(payload) = record.get("payload") else {
            continue;
        };
        let event = payload.get("event").unwrap_or(payload);

        if workspace_path.is_none()
            && let Some(ws) = event
                .get("workspace_root")
                .or_else(|| event.get("workspaceRoot"))
                .or_else(|| event.get("cwd"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        {
            workspace_path = Some(PathBuf::from(ws));
        }

        if title.is_none()
            && let Some(t) = event
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        {
            title = Some(t.to_string());
        }

        let kind = event
            .get("kind")
            .or_else(|| event.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");

        match kind {
            "user_message" | "turn_started" | "user_input" => {
                let text = event
                    .get("display_text")
                    .or_else(|| event.get("displayText"))
                    .or_else(|| event.get("text"))
                    .or_else(|| event.get("content"))
                    .or_else(|| event.get("input"))
                    .map(extract_text_from_parts)
                    .unwrap_or_default();
                if !text.is_empty() {
                    if title.is_none() {
                        title = Some(text.chars().take(80).collect());
                    }
                    messages.push(ImportedAgentMessage {
                        role: ImportedAgentMessageRole::User,
                        content: text,
                        created_at,
                        metadata: ImportedAgentMessageMetadata::default(),
                    });
                }
            }
            "assistant_message" | "model_completed" | "turn_completed" => {
                let text = event
                    .get("text")
                    .or_else(|| event.get("content"))
                    .or_else(|| event.get("message"))
                    .or_else(|| event.get("output"))
                    .map(extract_text_from_parts)
                    .unwrap_or_default();
                let model = event
                    .get("model")
                    .and_then(|m| {
                        m.as_str()
                            .or_else(|| m.get("model_id").and_then(Value::as_str))
                            .or_else(|| m.get("modelId").and_then(Value::as_str))
                    })
                    .map(str::to_string);
                let usage = event.get("usage");
                let input_tokens = usage
                    .and_then(|u| u.get("input_tokens").or_else(|| u.get("inputTokens")))
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok());
                let output_tokens = usage
                    .and_then(|u| u.get("output_tokens").or_else(|| u.get("outputTokens")))
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok());
                if !text.is_empty() {
                    messages.push(ImportedAgentMessage {
                        role: ImportedAgentMessageRole::Assistant,
                        content: text,
                        created_at,
                        metadata: ImportedAgentMessageMetadata {
                            model,
                            input_tokens,
                            output_tokens,
                            ..Default::default()
                        },
                    });
                }
            }
            _ => {}
        }
    }

    if messages.is_empty() {
        return Ok(Vec::new());
    }

    let mut session = ImportedAgentSession {
        source_agent: AgentKind::MuseCode,
        external_session_id: session_id,
        title,
        workspace_path,
        messages,
        raw_source_path: Some(path.to_path_buf()),
    };
    session.cap_payloads();
    Ok(vec![session])
}
