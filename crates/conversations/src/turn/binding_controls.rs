use agents::{
    AgentId, AgentKind, AgentSessionConfigOverride, AgentSessionControlsSnapshot,
    SessionControlPreferences,
};
use db::models::{conversation::ConversationAgentBindingRecord, session::Session};
use sqlx::SqlitePool;

/// What a freshly established session still needs in order to match the
/// conversation's remembered selection.
#[derive(Debug, Default, PartialEq, Eq)]
pub(in crate::service) struct SessionControlReplayPlan {
    pub(in crate::service) mode: Option<String>,
    pub(in crate::service) config_overrides: Vec<AgentSessionConfigOverride>,
}

/// Diff the remembered selection against what the session currently advertises.
///
/// Only genuine differences are replayed. Re-sending a value the session already
/// holds is not free: some agents rebuild dependent config options on every
/// `session/set_config_option`, so a redundant replay on each session establishment
/// would churn the very controls it is meant to preserve.
pub(in crate::service) fn session_control_replay_plan(
    remembered_mode: Option<String>,
    remembered_config: Vec<AgentSessionConfigOverride>,
    current: &AgentSessionControlsSnapshot,
) -> SessionControlReplayPlan {
    SessionControlReplayPlan {
        mode: remembered_mode.filter(|mode| current.current_mode.as_deref() != Some(mode.as_str())),
        config_overrides: remembered_config
            .into_iter()
            .filter(|selection| {
                !current.config_options.iter().any(|option| {
                    option.key == selection.key
                        && option.value.as_ref().and_then(|value| value.as_str())
                            == Some(selection.value.as_str())
                })
            })
            .collect(),
    }
}

/// Conversation selection wins per key over the agent's last-used / settings
/// defaults (CodeG `getSavedPrefsForConnect`).
#[cfg(test)]
pub(in crate::service) fn session_control_preferences(
    binding: Option<&ConversationAgentBindingRecord>,
    agent_defaults: &[(String, serde_json::Value)],
) -> SessionControlPreferences {
    session_control_preferences_for_member(binding, agent_defaults, None)
}

/// Returns `true` if a collaboration member explicitly configured a non-empty
/// string value for `key` in `collaboration_members.config_values`.
pub(in crate::service) fn seat_has_explicit_config_key(
    member_config: &crate::collaboration::MemberSessionConfig,
    key: &str,
) -> bool {
    member_config
        .config_values
        .as_object()
        .and_then(|map| map.get(key))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

/// Remove the listed keys from a `config_selection_json` object, returning
/// `Some(updated_json)` only if at least one key was removed.
pub(in crate::service) fn remove_config_selection_keys(
    raw_json: &str,
    keys: &[&str],
) -> Option<String> {
    let trimmed = raw_json.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut map =
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(trimmed).ok()?;
    let mut removed = false;
    for key in keys {
        if map.remove(*key).is_some() {
            removed = true;
        }
    }
    if !removed {
        return None;
    }
    serde_json::to_string(&map).ok()
}

/// Resolve session control preferences for either a standalone conversation
/// (`member_config == None`) or a collaboration bot/seat (`Some(member_config)`).
///
/// For a collaboration seat that has no explicit member `"model"` override in
/// `collaboration_members.config_values`, a stale observed `"model"` cached on
/// `conversation_agent_bindings.config_selection_json` must NOT override the
/// agent's current `agent_session_defaults` or live default provider/model.
pub(in crate::service) fn session_control_preferences_for_member(
    binding: Option<&ConversationAgentBindingRecord>,
    agent_defaults: &[(String, serde_json::Value)],
    member_config: Option<&crate::collaboration::MemberSessionConfig>,
) -> SessionControlPreferences {
    let mut config = Vec::new();
    for (key, value) in agent_defaults {
        if key == "mode" {
            continue;
        }
        let value = value
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string());
        if value.is_empty() {
            continue;
        }
        config.push(AgentSessionConfigOverride {
            key: key.clone(),
            value,
        });
    }
    let ignore_inherited_model =
        member_config.is_some_and(|cfg| !seat_has_explicit_config_key(cfg, "model"));
    for override_item in binding_config_selection(binding) {
        if ignore_inherited_model && override_item.key == "model" {
            continue;
        }
        if let Some(existing) = config
            .iter_mut()
            .find(|existing| existing.key == override_item.key)
        {
            existing.value = override_item.value;
        } else {
            config.push(override_item);
        }
    }
    let mode = binding_mode_selection(binding).or_else(|| {
        agent_defaults.iter().find_map(|(key, value)| {
            (key == "mode")
                .then(|| value.as_str().map(str::to_string))
                .flatten()
        })
    });
    SessionControlPreferences {
        mode,
        config,
        wants_prompt_suggestions: false,
    }
}

pub(in crate::service) async fn session_wants_prompt_suggestions(
    pool: &SqlitePool,
    session: &Session,
) -> bool {
    if session.parent_session_id.is_some() || session.delegation_call_id.is_some() {
        return false;
    }
    let is_non_composer_child: Option<i64> = sqlx::query_scalar(
        r#"SELECT 1
           FROM conversation_relations
           WHERE child_conversation_id = ?
             AND (kind IN ('delegation', 'workflow_step') OR visibility = 'hidden')
           LIMIT 1"#,
    )
    .bind(session.id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    is_non_composer_child.is_none()
}

pub(in crate::service) fn binding_mode_selection(
    binding: Option<&ConversationAgentBindingRecord>,
) -> Option<String> {
    binding
        .and_then(|binding| binding.current_mode.clone())
        .map(|mode| mode.trim().to_string())
        .filter(|mode| !mode.is_empty())
}

pub(in crate::service) fn binding_config_selection(
    binding: Option<&ConversationAgentBindingRecord>,
) -> Vec<AgentSessionConfigOverride> {
    binding
        .and_then(|binding| {
            let trimmed = binding.config_selection_json.trim();
            if trimmed.is_empty() {
                return None;
            }
            match serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(trimmed) {
                Ok(map) => Some(map),
                Err(error) => {
                    tracing::warn!(
                        binding_id = %binding.id,
                        conversation_id = %binding.conversation_id,
                        %error,
                        "invalid config_selection_json on conversation binding; ignoring"
                    );
                    None
                }
            }
        })
        .map(|selection| {
            selection
                .into_iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| AgentSessionConfigOverride {
                        key,
                        value: value.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(in crate::service) fn apply_preferences_to_controls_snapshot(
    controls: &mut AgentSessionControlsSnapshot,
    preferences: &SessionControlPreferences,
) {
    if let Some(mode) = preferences
        .mode
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        && controls.modes.iter().any(|candidate| candidate.id == mode)
    {
        controls.current_mode = Some(mode.to_string());
    }
    for override_item in &preferences.config {
        let key = override_item.key.trim();
        let val = override_item.value.trim();
        if key.is_empty() || val.is_empty() {
            continue;
        }
        if let Some(opt) = controls.config_options.iter_mut().find(|o| o.key == key) {
            let valid =
                opt.choices.is_empty() || opt.choices.iter().any(|choice| choice.value == val);
            if valid {
                opt.value = Some(serde_json::Value::String(val.to_string()));
            }
        }
    }
}

pub(in crate::service) fn is_placeholder_acp_session_id(id: &str) -> bool {
    agents::is_placeholder_acp_session_id(id)
}

pub(in crate::service) fn resolve_agent_id_from_executor(
    executor: Option<&str>,
) -> Option<AgentId> {
    let raw = executor?.trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("agent") {
        return None;
    }
    AgentKind::from_lenient(raw)
        .and_then(|kind| AgentId::parse(kind.as_str()).ok())
        .or_else(|| AgentId::parse(raw).ok())
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::json;
    use uuid::Uuid;

    use super::*;
    use crate::collaboration::MemberSessionConfig;

    fn binding_with_config(config_selection_json: &str) -> ConversationAgentBindingRecord {
        let now = Utc::now();
        ConversationAgentBindingRecord {
            id: Uuid::new_v4(),
            conversation_id: Uuid::new_v4(),
            agent_id: AgentId::parse("opencode").expect("opencode"),
            working_dir: "/workspace".to_string(),
            acp_session_id: Some("oc-session-1".to_string()),
            resume_allowed: true,
            invalidated_reason: None,
            connection_id: None,
            continuation_key: None,
            is_resume_head: true,
            acp_protocol_version: None,
            runtime_version: None,
            acp_version: None,
            load_supported: false,
            resume_supported: false,
            close_supported: false,
            terminal_supported: false,
            additional_directories_supported: false,
            prompt_capabilities_json: "{}".to_string(),
            session_capabilities_json: "{}".to_string(),
            client_capabilities_json: "{}".to_string(),
            mcp_servers_json: "[]".to_string(),
            modes_json: "[]".to_string(),
            config_options_json: "[]".to_string(),
            current_mode: None,
            config_selection_json: config_selection_json.to_string(),
            status: "active".to_string(),
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn seat_without_explicit_model_uses_updated_agent_default_instead_of_stale_binding_model() {
        let binding = binding_with_config(
            r#"{"model":"stale-provider/old-model","reasoning_effort":"high"}"#,
        );
        let member_cfg = MemberSessionConfig {
            agent_id: Some("opencode".to_string()),
            mode_id: None,
            config_values: json!({}),
            persona_prompt: None,
        };

        // Updated agent default must win over the stale binding model.
        let prefs = session_control_preferences_for_member(
            Some(&binding),
            &[("model".to_string(), json!("new-provider/fresh-model"))],
            Some(&member_cfg),
        );
        assert_eq!(
            prefs
                .config
                .iter()
                .find(|o| o.key == "model")
                .map(|o| o.value.as_str()),
            Some("new-provider/fresh-model"),
            "seat without explicit override must pick up updated agent default"
        );
        assert_eq!(
            prefs
                .config
                .iter()
                .find(|o| o.key == "reasoning_effort")
                .map(|o| o.value.as_str()),
            Some("high"),
            "non-model selection keys should remain intact"
        );

        // When no agent default is set, stale binding model must NOT be sent so live default wins.
        let prefs_live =
            session_control_preferences_for_member(Some(&binding), &[], Some(&member_cfg));
        assert!(
            !prefs_live.config.iter().any(|o| o.key == "model"),
            "stale inherited model must be omitted when neither member nor agent defaults pin it"
        );
    }

    #[test]
    fn seat_with_explicit_member_model_override_is_preserved_over_agent_default() {
        let binding = binding_with_config(r#"{"model":"custom-provider/pinned-model"}"#);
        let member_cfg = MemberSessionConfig {
            agent_id: Some("opencode".to_string()),
            mode_id: None,
            config_values: json!({ "model": "custom-provider/pinned-model" }),
            persona_prompt: None,
        };

        let prefs = session_control_preferences_for_member(
            Some(&binding),
            &[("model".to_string(), json!("new-provider/fresh-model"))],
            Some(&member_cfg),
        );
        assert_eq!(
            prefs
                .config
                .iter()
                .find(|o| o.key == "model")
                .map(|o| o.value.as_str()),
            Some("custom-provider/pinned-model"),
            "explicit member model override must win over agent default"
        );
    }

    #[test]
    fn remove_config_selection_keys_drops_only_target_keys() {
        let updated = remove_config_selection_keys(
            r#"{"model":"stale/x","reasoning_effort":"medium"}"#,
            &["model"],
        )
        .expect("should strip model");
        let parsed: serde_json::Value = serde_json::from_str(&updated).unwrap();
        assert_eq!(parsed, json!({ "reasoning_effort": "medium" }));
        assert_eq!(
            remove_config_selection_keys(r#"{"reasoning_effort":"medium"}"#, &["model"]),
            None
        );
    }
}
