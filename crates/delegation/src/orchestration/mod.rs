//! SQLite Single-Authority Agent Orchestration, Delegation, and Cross-Project
//! Thread Launch engine.
//!
//! Replaces the legacy volatile in-memory `DelegationBroker` while keeping
//! Collaboration Space completely isolated behind `HostCompanionFeatures`.

pub mod instructions;
pub mod launch;
pub mod reactors;
pub mod service;
pub mod tools;

use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    mode_limit::OrchestrationModeLimit, token_registry::TokenPermissions,
    types::AgentDelegationDefaults,
};

pub const DEFAULT_MAX_DEPTH: u32 = 2;
pub const DEFAULT_MAX_ACTIVE_CHILDREN: u32 = 6;
pub const DEFAULT_MAX_CALLS_PER_PARENT: u32 = 24;
pub const DEFAULT_CHILD_DEADLINE_MS: u64 = 10 * 60 * 1_000;
pub const DEFAULT_MAX_RESULT_BYTES: usize = 64 * 1024;
pub const DEFAULT_COALESCE_WINDOW_MS: u64 = 300;

#[derive(Debug, Clone)]
pub struct OrchestrationConfig {
    pub depth_limit: u32,
    pub max_active_children: u32,
    pub max_calls_per_parent: u32,
    pub child_deadline_ms: u64,
    pub max_result_bytes: usize,
    pub conversation_list_default_days: u32,
    pub delay_max_hours: u32,
    pub agent_defaults: BTreeMap<String, AgentDelegationDefaults>,
}

impl Default for OrchestrationConfig {
    fn default() -> Self {
        Self {
            depth_limit: DEFAULT_MAX_DEPTH,
            max_active_children: DEFAULT_MAX_ACTIVE_CHILDREN,
            max_calls_per_parent: DEFAULT_MAX_CALLS_PER_PARENT,
            child_deadline_ms: DEFAULT_CHILD_DEADLINE_MS,
            max_result_bytes: DEFAULT_MAX_RESULT_BYTES,
            conversation_list_default_days: 7,
            delay_max_hours: 24,
            agent_defaults: BTreeMap::new(),
        }
    }
}

/// Server-resolved caller identity from per-session Bearer token.
/// Never derived from model-supplied arguments.
#[derive(Debug, Clone)]
pub struct McpInvocationContext {
    pub caller_connection_id: String,
    pub caller_conversation_id: Uuid,
    pub working_root: PathBuf,
    pub permissions: TokenPermissions,
    pub mode_limit: OrchestrationModeLimit,
    pub parent_tool_use_id: String,
}

/// Optional cross-machine forwarder implemented in `crates/server` over paired
/// remote Hosts (`ServerProfile` + Remote Protocol v1).
#[async_trait]
pub trait RemoteMcpForwarder: Send + Sync {
    async fn forward_tool_call(
        &self,
        environment_id: &str,
        tool_name: &str,
        arguments: Value,
        mode_limit: OrchestrationModeLimit,
    ) -> Result<Value, OrchestrationError>;

    /// Enumerate paired remote Hosts available for cross-Host orchestration.
    /// Implementations MUST NOT expose `access_token` values.
    async fn list_environments(&self) -> Result<Value, OrchestrationError> {
        Ok(serde_json::json!({
            "local": { "environment_id": "local" },
            "environments": []
        }))
    }
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum OrchestrationError {
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    #[error("forbidden: {0}")]
    Forbidden(String),
    #[error("bad_request: {0}")]
    BadRequest(String),
    #[error("not_found: {0}")]
    NotFound(String),
    #[error("quota_exceeded: {0}")]
    QuotaExceeded(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("unavailable: {0}")]
    Unavailable(String),
    #[error("internal: {0}")]
    Internal(String),
}

impl OrchestrationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unauthorized(_) => "unauthorized",
            Self::Forbidden(_) => "forbidden",
            Self::BadRequest(_) => "bad_request",
            Self::NotFound(_) => "not_found",
            Self::QuotaExceeded(_) => "quota_exceeded",
            Self::Conflict(_) => "conflict",
            Self::Unavailable(_) => "unavailable",
            Self::Internal(_) => "internal",
        }
    }

    pub fn to_json_error(&self) -> Value {
        serde_json::json!({
            "error": {
                "code": self.code(),
                "message": self.to_string(),
            }
        })
    }
}

/// Format a clickable Dimo conversation deep link (matching T3Code's verbatim thread link UX).
pub fn conversation_link(conversation_id: Uuid, environment_id: Option<&str>) -> String {
    match environment_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(env_id) => format!("dimo://conversation/{conversation_id}?env={env_id}"),
        None => format!("dimo://conversation/{conversation_id}"),
    }
}

/// Deterministic SHA-256 scope key for `client_request_id` idempotency.
pub fn idempotency_scope_key(
    caller_conversation_id: Uuid,
    tool_name: &str,
    client_request_id: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(caller_conversation_id.as_bytes());
    hasher.update(b":");
    hasher.update(tool_name.as_bytes());
    hasher.update(b":");
    hasher.update(client_request_id.trim().as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

/// Truncate UTF-8 text cleanly at a char boundary so injected wakeup payloads stay bounded.
pub fn truncate_utf8_bytes(text: &str, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text.to_string(), false);
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}…[truncated]", &text[..end]), true)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPermissionEntry {
    pub permission_id: String,
    pub tool_name: String,
    pub summary: String,
    pub options: Vec<Value>,
}

pub type SharedRemoteForwarder = Arc<dyn RemoteMcpForwarder>;

pub use instructions::{
    DELEGATED_CHILD_INSTRUCTIONS, ORCHESTRATION_PLUGIN_ID, TOP_LEVEL_ORCHESTRATION_INSTRUCTIONS,
    build_orchestration_before_turn_blocks, install_orchestration_before_turn_hook,
};
pub use launch::{
    ActivePreparations, ConversationLaunchService, LaunchTargetSpec, PreparedLaunchResult,
};
pub use reactors::{
    DelegationReactors, PendingPermissionStore, run_startup_reconciler,
    run_startup_reconciler_with_remote, spawn_orchestration_reactors,
};
pub use service::OrchestrationService;
pub use tools::{is_orchestration_tool, orchestration_tool_schemas};

#[cfg(test)]
mod tests;
