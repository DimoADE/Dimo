use api_types::AgentId;

#[test]
fn agent_id_rejects_invalid_values_and_preserves_stable_ids() {
    for raw in [
        "claude_code",
        "codex",
        "opencode",
        "pi",
        "gemini",
        "cline",
        "my-registry-agent",
        "vendor.agent-v2",
        "openclaw",
        "hermes",
        "qa_mock",
    ] {
        let id = AgentId::parse(raw)
            .unwrap_or_else(|error| panic!("expected {raw:?} to be a valid AgentId: {error}"));

        assert_eq!(id.as_str(), raw);
        assert_eq!(id.to_string(), raw);
        assert_eq!(
            serde_json::from_str::<AgentId>(
                &serde_json::to_string(&id).expect("AgentId should serialize")
            )
            .expect("serialized AgentId should deserialize"),
            id
        );
    }

    for raw in [
        "",
        "ClaudeCode",
        "CLAUDE_CODE",
        "has space",
        "-leading",
        "trailing-",
        ".leading",
        "trailing.",
        "slash/agent",
        "agent@vendor",
        "中文",
    ] {
        assert!(
            AgentId::parse(raw).is_err(),
            "expected {raw:?} to be rejected"
        );
    }
}
