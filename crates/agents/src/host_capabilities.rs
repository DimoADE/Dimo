//! Per-agent ACP `initialize` client capabilities. Form elicitation is
//! agent-scoped to ACP adapters that support it; Cursor
//! `parameterizedModelPicker` is intentionally omitted.

use agent_client_protocol::schema::v1::{
    BooleanConfigOptionCapabilities, ClientCapabilities, ClientSessionCapabilities,
    ElicitationCapabilities, ElicitationFormCapabilities, SessionConfigOptionsCapabilities,
};
use api_types::{AgentId, AgentKind};

pub(crate) fn build_client_capabilities(agent_id: &AgentId) -> ClientCapabilities {
    let kind = AgentKind::from_lenient(agent_id.as_str());
    let mut client_capabilities = ClientCapabilities::new().terminal(true).session(
        ClientSessionCapabilities::new().config_options(
            SessionConfigOptionsCapabilities::new().boolean(BooleanConfigOptionCapabilities::new()),
        ),
    );
    if matches!(kind, Some(AgentKind::DeepseekHarness | AgentKind::Qoder)) {
        client_capabilities = client_capabilities
            .elicitation(ElicitationCapabilities::new().form(ElicitationFormCapabilities::new()));
    }
    client_capabilities
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps_of(id: &str) -> serde_json::Value {
        serde_json::to_value(build_client_capabilities(&AgentId::parse(id).unwrap()))
            .expect("caps serialize")
    }

    #[test]
    fn form_elicitation_is_advertised_only_to_deepseek_and_qoder() {
        for id in ["deepseek_harness", "qoder"] {
            let caps = caps_of(id);
            assert!(
                caps.get("elicitation").is_some(),
                "{id} must advertise form elicitation"
            );
        }
        for id in ["claude_code", "codex", "grok", "pi", "cline", "cursor"] {
            let caps = caps_of(id);
            let elicitation = caps.get("elicitation");
            let form = elicitation.and_then(|e| e.get("form"));
            assert!(
                form.is_none()
                    || form == Some(&serde_json::json!({}))
                    || form
                        .and_then(|f| f.as_object())
                        .is_some_and(|o| o.is_empty()
                            || o.values().all(|v| v == &serde_json::Value::Bool(false))),
                "{id} must not advertise form elicitation: {elicitation:?}"
            );
        }
    }

    #[test]
    fn cursor_does_not_get_parameterized_model_picker() {
        assert!(
            caps_of("cursor")
                .pointer("/_meta/parameterizedModelPicker")
                .is_none()
        );
    }
}
