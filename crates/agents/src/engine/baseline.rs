//! Zero-latency bundled session controls synthesis for dedicated native engines.
//!
//! Produces the same `AgentSessionControlsSnapshot` structure (`modes`, `model`,
//! `effort`, `capabilities`, `available_commands`) as `seed_native_session_controls`
//! without spawning any child process or requiring an active `EngineHandle`.

use std::collections::HashMap;

use serde_json::Value;

use crate::{
    AgentAvailableCommand, AgentSessionConfigChoice, AgentSessionConfigOption,
    AgentSessionControlsSnapshot, AgentSessionMode,
    conversation::{AcpCapabilitySnapshot, AgentPromptCapabilities, DeliveryChannel},
    engine::{EngineModelInfo, EngineRegistry, EngineRuntimePreference, NativeEngineDriver},
};

/// Builds an `AgentSessionControlsSnapshot` from a native engine driver's static
/// capabilities, a model list, and launch environment overrides without touching
/// any live process.
pub fn build_native_controls_snapshot(
    driver: &dyn NativeEngineDriver,
    models: &[EngineModelInfo],
    env: &HashMap<String, String>,
    yolo: bool,
) -> AgentSessionControlsSnapshot {
    let engine_caps = driver.capabilities();
    let configured_mode = driver
        .resolve_default_mode(env)
        .and_then(|mode| driver.normalize_mode(&mode));

    let modes: Vec<AgentSessionMode> = engine_caps
        .modes
        .modes
        .iter()
        .map(|choice| AgentSessionMode {
            id: choice.id.clone(),
            label: choice.label.clone(),
            description: choice
                .description
                .as_deref()
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .map(str::to_string),
        })
        .collect();

    let current_mode = configured_mode
        .filter(|id| engine_caps.modes.modes.iter().any(|c| c.id == *id))
        .unwrap_or_else(|| {
            if yolo {
                engine_caps.modes.yolo_mode_id.clone()
            } else {
                engine_caps.modes.default_mode_id.clone()
            }
        });

    let mut effective_models = models.to_vec();
    driver.apply_env_to_models(&mut effective_models, env);

    let default_model_env = env
        .get("DIMO_DEFAULT_MODEL")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| driver.resolve_default_model(env));

    let mut config_options = Vec::new();

    if !modes.is_empty() {
        let mode_choices = modes
            .iter()
            .map(|mode| AgentSessionConfigChoice {
                value: Value::String(mode.id.clone()),
                label: mode.label.clone(),
                description: mode.description.clone(),
            })
            .collect();
        config_options.push(AgentSessionConfigOption {
            key: "mode".to_string(),
            label: "Mode".to_string(),
            description: None,
            category: Some("mode".to_string()),
            value: Some(Value::String(current_mode.clone())),
            choices: mode_choices,
            dependency: None,
        });
    }

    let mut model_choices: Vec<AgentSessionConfigChoice> = effective_models
        .iter()
        .filter(|m| !m.id.trim().is_empty())
        .map(|m| AgentSessionConfigChoice {
            value: Value::String(m.id.clone()),
            label: m.label.clone(),
            description: m
                .description
                .as_deref()
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .map(str::to_string),
        })
        .collect();
    if let Some(pref) = default_model_env
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        && !model_choices.iter().any(|c| c.value.as_str() == Some(pref))
    {
        model_choices.insert(
            0,
            AgentSessionConfigChoice {
                value: Value::String(pref.to_string()),
                label: pref.to_string(),
                description: None,
            },
        );
    }
    if !model_choices.is_empty() {
        let current_model = default_model_env
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| {
                effective_models
                    .iter()
                    .find(|m| m.is_default)
                    .map(|m| m.id.clone())
            })
            .or_else(|| model_choices[0].value.as_str().map(str::to_string))
            .unwrap_or_default();
        config_options.push(AgentSessionConfigOption {
            key: "model".to_string(),
            label: "Model".to_string(),
            description: None,
            category: Some("model".to_string()),
            value: Some(Value::String(current_model)),
            choices: model_choices,
            dependency: None,
        });
    }

    if let Some(effort_spec) = engine_caps.effort.as_ref() {
        let effort_choices = effort_spec
            .choices
            .iter()
            .map(|choice| AgentSessionConfigChoice {
                value: Value::String(choice.id.clone()),
                label: choice.label.clone(),
                description: choice
                    .description
                    .as_deref()
                    .map(str::trim)
                    .filter(|d| !d.is_empty())
                    .map(str::to_string),
            })
            .collect();
        config_options.push(AgentSessionConfigOption {
            key: "effort".to_string(),
            label: "推理强度".to_string(),
            description: None,
            category: Some("thought_level".to_string()),
            value: Some(Value::String(effort_spec.default_value.clone())),
            choices: effort_choices,
            dependency: None,
        });
    }

    let available_commands: Vec<AgentAvailableCommand> = engine_caps
        .default_commands
        .iter()
        .map(|cmd| AgentAvailableCommand {
            name: cmd.name.clone(),
            description: (!cmd.description.trim().is_empty()).then(|| cmd.description.clone()),
            input_schema: None,
        })
        .collect();

    let capabilities = AcpCapabilitySnapshot {
        protocol_version: Some("native-v1".to_string()),
        prompt: AgentPromptCapabilities {
            text: true,
            image: true,
            audio: false,
            resource: true,
            resource_link: true,
        },
        load_session: true,
        resume_session: true,
        close_session: true,
        fork_session: engine_caps.supports_native_fork,
        list_sessions: false,
        delete_session: false,
        steering: engine_caps.supports_native_steer,
        delivery_channel: DeliveryChannel::Native,
        terminal: true,
        additional_directories: true,
        filesystem_requests: true,
        mcp_stdio: true,
        mcp_http: true,
        mcp_sse: true,
        modes: modes.clone(),
        current_mode: Some(current_mode.clone()),
        config_options: config_options.clone(),
        available_commands: available_commands.clone(),
        ..Default::default()
    };

    AgentSessionControlsSnapshot {
        modes,
        current_mode: Some(current_mode),
        config_options,
        capabilities: Some(capabilities),
        available_commands: Some(available_commands),
        ..Default::default()
    }
}

/// Returns the zero-latency bundled baseline controls snapshot for a dedicated
/// native engine (ClaudeCode, Codex) when no persisted catalog exists yet.
/// Returns `None` for ACP-only agents (e.g. Antigravity) or engines without a
/// bundled model list.
pub fn bundled_controls_snapshot(
    agent_id: &str,
    env: &HashMap<String, String>,
    yolo: bool,
) -> Option<AgentSessionControlsSnapshot> {
    let driver = EngineRegistry::bundled().resolve_driver_for_agent(
        agent_id,
        EngineRuntimePreference::NativeFirst,
        None,
    )?;
    let models = driver.bundled_models();
    if models.is_empty() {
        return None;
    }
    Some(build_native_controls_snapshot(
        driver.as_ref(),
        &models,
        env,
        yolo,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{CatalogRefreshPolicy, catalog_refresh_policy_for_agent};

    #[test]
    fn bundled_controls_snapshot_returns_complete_controls_for_claude_and_codex() {
        let env = HashMap::new();
        for agent_id in ["claude_code", "codex"] {
            let snapshot = bundled_controls_snapshot(agent_id, &env, false)
                .unwrap_or_else(|| panic!("expected bundled baseline for {agent_id}"));
            assert!(!snapshot.modes.is_empty(), "expected modes for {agent_id}");
            assert!(snapshot.current_mode.is_some());
            assert!(
                snapshot
                    .config_options
                    .iter()
                    .any(|o| o.key == "model" && !o.choices.is_empty()),
                "expected model choices for {agent_id}"
            );
            assert!(
                snapshot
                    .config_options
                    .iter()
                    .any(|o| o.key == "effort" && !o.choices.is_empty()),
                "expected effort choices for {agent_id}"
            );
        }
    }

    #[test]
    fn bundled_controls_snapshot_returns_none_for_acp_agents() {
        let env = HashMap::new();
        assert!(bundled_controls_snapshot("antigravity", &env, false).is_none());
        assert!(bundled_controls_snapshot("opencode", &env, false).is_none());
        assert_eq!(
            catalog_refresh_policy_for_agent("antigravity"),
            CatalogRefreshPolicy::PassiveOnly
        );
        assert_eq!(
            catalog_refresh_policy_for_agent("claude_code"),
            CatalogRefreshPolicy::BackgroundNativeProbe
        );
        assert_eq!(
            catalog_refresh_policy_for_agent("codex"),
            CatalogRefreshPolicy::BackgroundNativeProbe
        );
    }
}
