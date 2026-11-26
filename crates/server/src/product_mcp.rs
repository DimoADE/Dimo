//! Loopback HTTP entry for product MCP processes.

use std::{collections::BTreeSet, path::PathBuf, sync::Arc};

use application::{CommandRegistry, Principal, RegisteredCommand, SqliteConversationRepository};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use delegation::{
    AgentDelegationDefaults, DelegationListener, TokenEntry, TokenPermissions, TokenRegistry,
    mode_limit::OrchestrationModeLimit,
    orchestration::{McpInvocationContext, OrchestrationService, orchestration_tool_schemas},
};
use delegation_proto::BrokerMessage;
use plugins::OfficialMcpRuntime;
use remote_protocol::CommandRequest;
use serde_json::{Value, json};
use tokio::{net::TcpListener, sync::RwLock};
use uuid::Uuid;

#[async_trait::async_trait]
pub trait ProductMcpSessionLookup: Send + Sync {
    async fn resolve(&self, conversation_id: Uuid) -> Option<(String, PathBuf)>;
    async fn is_space_session(&self, conversation_id: Uuid) -> bool;
}

/// Late-bound application command registry attached once `HostRuntime::build`
/// finishes initializing `CommandRegistry`.
#[derive(Clone, Default)]
pub struct ProductMcpCommandHost {
    commands: Arc<RwLock<Option<CommandRegistry<SqliteConversationRepository>>>>,
}

impl ProductMcpCommandHost {
    pub async fn attach_commands(&self, commands: CommandRegistry<SqliteConversationRepository>) {
        *self.commands.write().await = Some(commands);
    }

    async fn commands(&self) -> Option<CommandRegistry<SqliteConversationRepository>> {
        self.commands.read().await.clone()
    }
}

#[derive(Clone)]
struct GatewayState {
    listener: Arc<DelegationListener>,
    tokens: Arc<TokenRegistry>,
    gate: Arc<OfficialMcpRuntime>,
    sessions: Arc<dyn ProductMcpSessionLookup>,
    command_host: ProductMcpCommandHost,
    orchestration: Option<Arc<OrchestrationService>>,
}

pub async fn start_product_mcp_gateway(
    listener: Arc<DelegationListener>,
    tokens: Arc<TokenRegistry>,
    gate: Arc<OfficialMcpRuntime>,
    sessions: Arc<dyn ProductMcpSessionLookup>,
    command_host: ProductMcpCommandHost,
) -> Result<String, std::io::Error> {
    start_product_mcp_gateway_with_orchestration(
        listener,
        tokens,
        gate,
        sessions,
        command_host,
        None,
    )
    .await
}

pub async fn start_product_mcp_gateway_with_orchestration(
    listener: Arc<DelegationListener>,
    tokens: Arc<TokenRegistry>,
    gate: Arc<OfficialMcpRuntime>,
    sessions: Arc<dyn ProductMcpSessionLookup>,
    command_host: ProductMcpCommandHost,
    orchestration: Option<Arc<OrchestrationService>>,
) -> Result<String, std::io::Error> {
    let listener_tcp = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener_tcp.local_addr()?;
    let base = format!("http://{addr}");
    gate.set_http_base(Some(base.clone()));
    let state = GatewayState {
        listener,
        tokens,
        gate,
        sessions,
        command_host,
        orchestration,
    };
    let app = Router::new()
        .route("/mcp", post(mcp_jsonrpc))
        .route("/internal/companion", post(companion))
        .route(
            "/api/v1/call/{command}",
            post(v1_call).layer(DefaultBodyLimit::max(
                crate::runtime::MAX_COMMAND_BODY_BYTES,
            )),
        )
        .with_state(state);
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener_tcp, app).await {
            tracing::warn!("product MCP gateway stopped: {error}");
        }
    });
    Ok(base)
}

fn extract_bearer(headers: &HeaderMap) -> Option<&str> {
    let raw = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())?;
    let trimmed = raw.trim();
    trimmed
        .strip_prefix("Bearer ")
        .or_else(|| trimmed.strip_prefix("bearer "))
        .or_else(|| trimmed.strip_prefix("BEARER "))
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

fn superagent_scopes() -> BTreeSet<String> {
    let mut scopes = RegisteredCommand::all()
        .into_iter()
        .map(|cmd| cmd.required_scope().to_owned())
        .collect::<BTreeSet<_>>();
    for extra in [
        "workspace.write",
        "artifact.read",
        "artifact.preview",
        "plugin.read",
        "plugin.write",
        "plugin.surface",
        "delegation.read",
        "delegation.cancel",
    ] {
        scopes.insert(extra.to_owned());
    }
    scopes
}

async fn v1_call(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Path(command): Path<String>,
    Json(request): Json<CommandRequest<serde_json::Value>>,
) -> Response {
    let Some(bearer) = extract_bearer(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !state.gate.is_valid_product_token(bearer) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(commands) = state.command_host.commands().await else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error_code": "host_starting",
                "message": "Host command registry is still initializing",
            })),
        )
            .into_response();
    };
    let principal = Principal::remote("dimo-superagent-mcp", superagent_scopes());
    match commands
        .execute_name(&principal, &command, request.operation_id, request.args)
        .await
    {
        Ok(response) => Json(response).into_response(),
        Err(error) => crate::runtime::application_error_response(error),
    }
}

async fn companion(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(mut message): Json<BrokerMessage>,
) -> Result<Json<delegation_proto::BrokerResponse>, StatusCode> {
    let bearer = extract_bearer(&headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let product = headers
        .get("x-dimo-product")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("superagent");
    let expected = state.gate.token_for_product(product);
    if expected.as_deref() != Some(bearer) && !state.gate.is_valid_product_token(bearer) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let conversation_id = headers
        .get("x-dimo-conversation-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| Uuid::parse_str(value).ok());
    if let Some(conversation_id) = conversation_id
        && let Some((connection_id, working_root)) = state.sessions.resolve(conversation_id).await
    {
        let ephemeral = Uuid::new_v4().to_string();
        let permissions = if product == "session" {
            let bits = state.gate.session_features();
            TokenPermissions {
                feedback: bits & plugins::SESSION_FEAT_FEEDBACK != 0,
                ask: bits & plugins::SESSION_FEAT_ASK != 0,
                session_info: bits & plugins::SESSION_FEAT_SESSIONS != 0,
                session_control: bits & plugins::SESSION_FEAT_SESSION_CONTROL != 0,
                ..TokenPermissions::default()
            }
        } else if product == "superagent" {
            let delegation_on = state.gate.allow_delegation_mcp();
            let bits = state.gate.session_features();
            let space_session =
                delegation_on && state.sessions.is_space_session(conversation_id).await;
            TokenPermissions {
                delegation: delegation_on,
                feedback: bits & plugins::SESSION_FEAT_FEEDBACK != 0,
                ask: bits & plugins::SESSION_FEAT_ASK != 0,
                session_info: delegation_on || (bits & plugins::SESSION_FEAT_SESSIONS != 0),
                session_control: bits & plugins::SESSION_FEAT_SESSION_CONTROL != 0,
                workspace_write: delegation_on,
                collaboration: delegation_on,
                space_session,
            }
        } else {
            let space_session = state.sessions.is_space_session(conversation_id).await;
            TokenPermissions {
                delegation: true,
                session_info: true,
                workspace_write: true,
                collaboration: true,
                space_session,
                ..TokenPermissions::default()
            }
        };
        state.tokens.register_with_permissions(
            ephemeral.clone(),
            TokenEntry {
                parent_connection_id: connection_id.clone(),
                parent_conversation_id: conversation_id,
                working_root,
            },
            permissions,
        );
        struct EphemeralTokenGuard<'a> {
            tokens: &'a TokenRegistry,
            token: String,
        }
        impl Drop for EphemeralTokenGuard<'_> {
            fn drop(&mut self) {
                self.tokens.revoke(&self.token);
            }
        }
        let guard = EphemeralTokenGuard {
            tokens: &state.tokens,
            token: ephemeral.clone(),
        };
        rewrite_token(&mut message, &ephemeral, &connection_id);
        let response = state.listener.handle_message(message).await;
        drop(guard);
        return Ok(Json(response));
    }

    Ok(Json(unbound_conversation_response()))
}

fn unbound_conversation_response() -> delegation_proto::BrokerResponse {
    delegation_proto::BrokerResponse::Error {
        code: "missing_conversation".to_string(),
        message: "host conversation context is missing".to_string(),
    }
}

fn rewrite_token(message: &mut BrokerMessage, token: &str, connection_id: &str) {
    match message {
        BrokerMessage::Call(req) => {
            req.token = token.to_string();
            req.parent_connection_id = connection_id.to_string();
        }
        BrokerMessage::Status(req) => req.token = token.to_string(),
        BrokerMessage::CancelTask(req) => req.token = token.to_string(),
        BrokerMessage::Cancel(req) => req.token = token.to_string(),
        BrokerMessage::Feedback(req) => req.token = token.to_string(),
        BrokerMessage::CommitFeedback(req) => req.token = token.to_string(),
        BrokerMessage::Ask(req) => req.token = token.to_string(),
        BrokerMessage::SessionInfo(req) => req.token = token.to_string(),
        BrokerMessage::SessionSend(req) => req.token = token.to_string(),
        BrokerMessage::SessionCancel(req) => req.token = token.to_string(),
        BrokerMessage::SessionWait(req) => req.token = token.to_string(),
        BrokerMessage::Collaborate(req) => req.token = token.to_string(),
        BrokerMessage::Ping => {}
    }
}

/// Unified Streamable HTTP JSON-RPC 2.0 MCP endpoint for Dimo's 17 agent
/// orchestration, delegation, and cross-project thread launch tools.
///
/// Accepts either:
/// - Per-session Bearer tokens registered in `TokenRegistry`, or
/// - Product tokens validated by `OfficialMcpRuntime` paired with
///   `X-Dimo-Conversation-Id`.
async fn mcp_jsonrpc(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Response {
    let id = payload.get("id").cloned();
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match method {
        "initialize" => {
            return jsonrpc_ok(
                id,
                json!({
                    "protocolVersion": "2025-03-26",
                    "capabilities": { "tools": {} },
                    "serverInfo": {
                        "name": "dimo-orchestration-mcp",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                }),
            );
        }
        "notifications/initialized" => {
            return StatusCode::ACCEPTED.into_response();
        }
        "ping" => {
            return jsonrpc_ok(id, json!({}));
        }
        "tools/list" => {
            let Some(bearer) = extract_bearer(&headers) else {
                return StatusCode::UNAUTHORIZED.into_response();
            };
            if state.tokens.lookup(bearer).is_none() && !state.gate.is_valid_product_token(bearer) {
                return StatusCode::UNAUTHORIZED.into_response();
            }
            return jsonrpc_ok(
                id,
                json!({
                    "tools": orchestration_tool_schemas(),
                }),
            );
        }
        "tools/call" => {}
        other => {
            return jsonrpc_err(id, -32601, format!("method '{other}' not found"));
        }
    }

    let Some(orchestration) = state.orchestration.as_ref() else {
        return jsonrpc_err(
            id,
            -32000,
            "orchestration service is not enabled on this gateway",
        );
    };

    let params = payload.get("params").cloned().unwrap_or_else(|| json!({}));
    let Some(tool_name) = params
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return jsonrpc_err(id, -32602, "params.name is required");
    };
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let parent_tool_use_id = extract_tool_use_id(&headers, params.get("_meta"));
    let ctx = match resolve_mcp_invocation_context(&state, &headers, parent_tool_use_id).await {
        Ok(ctx) => ctx,
        Err((status, message)) => {
            if status == StatusCode::UNAUTHORIZED {
                return StatusCode::UNAUTHORIZED.into_response();
            }
            return jsonrpc_err(id, -32001, message);
        }
    };

    // Keep OrchestrationConfig limits in sync with live Host settings.
    sync_orchestration_config_from_gate(orchestration, &state.gate);

    match orchestration.call_tool(&ctx, tool_name, arguments).await {
        Ok(value) => {
            let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
            jsonrpc_ok(
                id,
                json!({
                    "content": [{ "type": "text", "text": text }],
                    "structuredContent": value,
                    "isError": false,
                }),
            )
        }
        Err(error) => {
            let payload = error.to_json_error();
            let text = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| error.to_string());
            jsonrpc_ok(
                id,
                json!({
                    "content": [{ "type": "text", "text": text }],
                    "structuredContent": payload,
                    "isError": true,
                }),
            )
        }
    }
}

/// Authenticated remote Streamable HTTP MCP handler mounted at `/api/v1/mcp`
/// behind `require_token` for cross-machine `environment_id` forwarding.
pub(crate) async fn remote_mcp_jsonrpc(headers: HeaderMap, Json(payload): Json<Value>) -> Response {
    let id = payload.get("id").cloned();
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match method {
        "initialize" => {
            return jsonrpc_ok(
                id,
                json!({
                    "protocolVersion": "2025-03-26",
                    "capabilities": { "tools": {} },
                    "serverInfo": {
                        "name": "dimo-remote-orchestration",
                        "version": env!("CARGO_PKG_VERSION"),
                    }
                }),
            );
        }
        "notifications/initialized" => {
            return StatusCode::ACCEPTED.into_response();
        }
        "tools/list" => {
            return jsonrpc_ok(
                id,
                json!({
                    "tools": orchestration_tool_schemas(),
                }),
            );
        }
        "tools/call" => {}
        other => {
            return jsonrpc_err(id, -32601, format!("method '{other}' not found"));
        }
    }

    let Some(orchestration) = crate::delegation_runtime::active_orchestration_service() else {
        return jsonrpc_err(
            id,
            -32000,
            "orchestration service is not enabled on this host",
        );
    };

    let params = payload.get("params").cloned().unwrap_or_else(|| json!({}));
    let Some(tool_name) = params
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return jsonrpc_err(id, -32602, "params.name is required");
    };
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    // Fail closed to approval_required if X-Dimo-Mode-Limit is absent or invalid.
    let mode_limit = headers
        .get("x-dimo-mode-limit")
        .and_then(|v| v.to_str().ok())
        .and_then(OrchestrationModeLimit::from_header_value)
        .unwrap_or_else(OrchestrationModeLimit::approval_required);

    let caller_conversation_id = headers
        .get("x-dimo-conversation-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|raw| Uuid::parse_str(raw.trim()).ok())
        .unwrap_or(Uuid::nil());

    let ctx = McpInvocationContext {
        caller_connection_id: String::new(),
        caller_conversation_id,
        working_root: PathBuf::from("."),
        permissions: TokenPermissions {
            delegation: true,
            feedback: true,
            ask: true,
            session_info: true,
            session_control: true,
            workspace_write: true,
            collaboration: false,
            space_session: false,
        },
        mode_limit,
        parent_tool_use_id: extract_tool_use_id(&headers, params.get("_meta")),
    };

    match orchestration.call_tool(&ctx, tool_name, arguments).await {
        Ok(value) => {
            let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
            jsonrpc_ok(
                id,
                json!({
                    "content": [{ "type": "text", "text": text }],
                    "structuredContent": value,
                    "isError": false,
                }),
            )
        }
        Err(error) => {
            let payload = error.to_json_error();
            let text = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| error.to_string());
            jsonrpc_ok(
                id,
                json!({
                    "content": [{ "type": "text", "text": text }],
                    "structuredContent": payload,
                    "isError": true,
                }),
            )
        }
    }
}

async fn resolve_mcp_invocation_context(
    state: &GatewayState,
    headers: &HeaderMap,
    parent_tool_use_id: String,
) -> Result<McpInvocationContext, (StatusCode, String)> {
    let bearer = extract_bearer(headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "missing bearer token".to_string()))?;

    let header_mode_limit = headers
        .get("x-dimo-mode-limit")
        .and_then(|v| v.to_str().ok())
        .and_then(OrchestrationModeLimit::from_header_value);

    // 1. Direct per-session token registered in TokenRegistry (zero DB lookup for identity).
    if let Some(entry) = state.tokens.lookup(bearer) {
        let permissions = state.tokens.permissions(bearer).unwrap_or_default();
        let mut base_limit = state.tokens.mode_limit(bearer).unwrap_or_default();
        if let Some(header_limit) = header_mode_limit {
            base_limit = base_limit.intersect(header_limit);
        }
        let effective_limit = if let Some(orch) = state.orchestration.as_ref() {
            orch.resolve_caller_mode_limit(entry.parent_conversation_id, base_limit)
                .await
        } else {
            base_limit
        };
        return Ok(McpInvocationContext {
            caller_connection_id: entry.parent_connection_id,
            caller_conversation_id: entry.parent_conversation_id,
            working_root: entry.working_root,
            permissions,
            mode_limit: effective_limit,
            parent_tool_use_id,
        });
    }

    // 2. Product token + X-Dimo-Conversation-Id (used by dimo-mcp proxy or remote Host forwarding).
    let product = headers
        .get("x-dimo-product")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("superagent");
    let expected = state.gate.token_for_product(product);
    if expected.as_deref() != Some(bearer) && !state.gate.is_valid_product_token(bearer) {
        return Err((StatusCode::UNAUTHORIZED, "invalid bearer token".to_string()));
    }

    let conversation_id = headers
        .get("x-dimo-conversation-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|raw| Uuid::parse_str(raw.trim()).ok())
        .unwrap_or(Uuid::nil());

    let (connection_id, working_root) = if !conversation_id.is_nil() {
        state
            .sessions
            .resolve(conversation_id)
            .await
            .unwrap_or_else(|| (String::new(), PathBuf::from(".")))
    } else {
        (String::new(), PathBuf::from("."))
    };

    let delegation_on = state.gate.allow_delegation_mcp();
    let bits = state.gate.session_features();
    let space_session = if delegation_on && !conversation_id.is_nil() {
        state.sessions.is_space_session(conversation_id).await
    } else {
        false
    };
    let permissions = TokenPermissions {
        delegation: delegation_on,
        feedback: bits & plugins::SESSION_FEAT_FEEDBACK != 0,
        ask: bits & plugins::SESSION_FEAT_ASK != 0,
        session_info: delegation_on || (bits & plugins::SESSION_FEAT_SESSIONS != 0),
        session_control: bits & plugins::SESSION_FEAT_SESSION_CONTROL != 0,
        workspace_write: delegation_on,
        collaboration: delegation_on,
        space_session,
    };

    let base_limit = header_mode_limit.unwrap_or_default();
    let effective_limit = if let Some(orch) = state.orchestration.as_ref()
        && !conversation_id.is_nil()
    {
        orch.resolve_caller_mode_limit(conversation_id, base_limit)
            .await
    } else {
        base_limit
    };

    Ok(McpInvocationContext {
        caller_connection_id: connection_id,
        caller_conversation_id: conversation_id,
        working_root,
        permissions,
        mode_limit: effective_limit,
        parent_tool_use_id,
    })
}

fn extract_tool_use_id(headers: &HeaderMap, meta: Option<&Value>) -> String {
    if let Some(meta) = meta {
        for key in [
            "tool_use_id",
            "toolCallId",
            "tool_call_id",
            "progressToken",
            "progress_token",
        ] {
            if let Some(val) = meta.get(key) {
                if let Some(s) = val.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    return s.to_string();
                }
                if let Some(n) = val.as_i64() {
                    return n.to_string();
                }
                if let Some(n) = val.as_u64() {
                    return n.to_string();
                }
            }
        }
    }
    headers
        .get("x-dimo-tool-use-id")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_default()
}

fn sync_orchestration_config_from_gate(
    orchestration: &OrchestrationService,
    gate: &OfficialMcpRuntime,
) {
    let Some(limits) = gate.host_delegation_limits() else {
        return;
    };
    orchestration.update_config(|next| {
        next.depth_limit = limits.depth_limit.clamp(1, 8);
        next.conversation_list_default_days = limits.conversation_list_default_days.clamp(1, 365);
        next.delay_max_hours = limits.delay_max_hours.clamp(1, 720);
        next.agent_defaults = limits
            .agent_defaults
            .into_iter()
            .map(|(agent_id, (mode_id, config_values))| {
                (
                    agent_id,
                    AgentDelegationDefaults {
                        mode_id,
                        config_values,
                    },
                )
            })
            .collect();
    });
}

fn jsonrpc_ok(id: Option<Value>, result: Value) -> Response {
    Json(json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "result": result,
    }))
    .into_response()
}

fn jsonrpc_err(id: Option<Value>, code: i64, message: impl Into<String>) -> Response {
    Json(json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "error": {
            "code": code,
            "message": message.into(),
        },
    }))
    .into_response()
}

#[cfg(test)]
mod mcp_http_tests {
    use delegation::{
        ChildStatusLookup, ChildStatusRecord, ConnectionSpawner, DelegationBroker,
        DelegationCompletedEvent, DelegationConfig, DelegationError, DelegationEventEmitter,
        DelegationLink, DelegationMetaWriter, DelegationStartedEvent, DepthLookup, SpawnerError,
    };

    use super::*;

    struct NullLookup;
    #[async_trait::async_trait]
    impl ProductMcpSessionLookup for NullLookup {
        async fn resolve(&self, _conversation_id: Uuid) -> Option<(String, PathBuf)> {
            None
        }
        async fn is_space_session(&self, _conversation_id: Uuid) -> bool {
            false
        }
    }

    struct NullSpawner;
    #[async_trait::async_trait]
    impl ConnectionSpawner for NullSpawner {
        async fn spawn(
            &self,
            _: &str,
            _: agents::AgentId,
            _: Option<String>,
            _: Uuid,
        ) -> Result<String, SpawnerError> {
            Err(SpawnerError::Spawn("noop".into()))
        }
        async fn create_child_conversation(
            &self,
            id: Uuid,
            _: &str,
            _: &DelegationLink,
        ) -> Result<Uuid, SpawnerError> {
            Ok(id)
        }
        async fn send_prompt_linked(
            &self,
            _: &str,
            id: Uuid,
            _: String,
            _: DelegationLink,
        ) -> Result<Uuid, SpawnerError> {
            Ok(id)
        }
        async fn cancel(&self, _: &str) -> Result<(), SpawnerError> {
            Ok(())
        }
        async fn release_child(&self, _: Uuid) -> Result<(), SpawnerError> {
            Ok(())
        }
        async fn disconnect(&self, _: &str) -> Result<(), SpawnerError> {
            Ok(())
        }
    }

    struct NullDepth;
    #[async_trait::async_trait]
    impl DepthLookup for NullDepth {
        async fn parent_session_id(&self, _: Uuid) -> Result<Option<Uuid>, DelegationError> {
            Ok(None)
        }
        async fn active_durable_children(&self, _: Uuid) -> Result<u32, DelegationError> {
            Ok(0)
        }
    }

    struct NullStatus;
    #[async_trait::async_trait]
    impl ChildStatusLookup for NullStatus {
        async fn status_by_call_id(&self, _: &str) -> Option<ChildStatusRecord> {
            None
        }
    }

    struct NullMeta;
    #[async_trait::async_trait]
    impl DelegationMetaWriter for NullMeta {
        async fn write_meta(&self, _: &str, _: &str, _: Value) {}
    }

    struct NullEmitter;
    #[async_trait::async_trait]
    impl DelegationEventEmitter for NullEmitter {
        async fn emit_started(&self, _: DelegationStartedEvent) {}
        async fn emit_completed(&self, _: DelegationCompletedEvent) {}
    }

    struct NullParent;
    #[async_trait::async_trait]
    impl delegation::ParentSessionLookup for NullParent {
        async fn contains_session(&self, _: &str, _: Uuid) -> bool {
            false
        }
    }

    #[tokio::test]
    async fn mcp_endpoint_handles_initialize_and_authenticated_tools_list() {
        let tokens = Arc::new(TokenRegistry::new());
        let gate = Arc::new(OfficialMcpRuntime::default());
        gate.publish_binding(plugins::OfficialMcpBinding {
            plugin_id: "dimo.delegation".into(),
            binary_id: "dimo-mcp".into(),
            product: "delegation".into(),
            features: plugins::SESSION_FEAT_ALL,
            token: "test-product-token".into(),
        });

        let broker = Arc::new(DelegationBroker::new(
            Arc::new(NullSpawner),
            Arc::new(NullDepth),
            Arc::new(NullStatus),
            Arc::new(NullMeta),
            Arc::new(NullEmitter),
            DelegationConfig::default(),
        ));
        let listener = Arc::new(DelegationListener::new(
            broker,
            tokens.clone(),
            Arc::new(NullParent),
        ));
        let base = start_product_mcp_gateway_with_orchestration(
            listener,
            tokens,
            gate,
            Arc::new(NullLookup),
            ProductMcpCommandHost::default(),
            None,
        )
        .await
        .expect("start gateway");

        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();

        // 1. initialize succeeds without auth.
        let init: Value = client
            .post(format!("{base}/mcp"))
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {}
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            init["result"]["serverInfo"]["name"],
            "dimo-orchestration-mcp"
        );

        // 2. tools/list without bearer token returns 401.
        let unauth = client
            .post(format!("{base}/mcp"))
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/list",
                "params": {}
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(unauth.status(), reqwest::StatusCode::UNAUTHORIZED);

        // 3. tools/list with valid product token returns all 18 tools.
        let list: Value = client
            .post(format!("{base}/mcp"))
            .bearer_auth("test-product-token")
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/list",
                "params": {}
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let tools = list["result"]["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 18);
        assert!(tools.iter().any(|t| t["name"] == "delegate_task"));
        assert!(tools.iter().any(|t| t["name"] == "thread_launch"));
        assert!(
            tools
                .iter()
                .any(|t| t["name"] == "orchestrator_capabilities")
        );
        assert!(tools.iter().any(|t| t["name"] == "environment_links"));
    }

    #[tokio::test]
    async fn remote_mcp_jsonrpc_handles_initialize_and_tools_list() {
        let init_resp = remote_mcp_jsonrpc(
            HeaderMap::new(),
            Json(json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "initialize",
                "params": {}
            })),
        )
        .await;
        assert_eq!(init_resp.status(), StatusCode::OK);
        let init_bytes = axum::body::to_bytes(init_resp.into_body(), 1024 * 64)
            .await
            .unwrap();
        let init_json: Value = serde_json::from_slice(&init_bytes).unwrap();
        assert_eq!(init_json["id"], 7);
        assert_eq!(
            init_json["result"]["serverInfo"]["name"],
            "dimo-remote-orchestration"
        );

        let list_resp = remote_mcp_jsonrpc(
            HeaderMap::new(),
            Json(json!({
                "jsonrpc": "2.0",
                "id": 8,
                "method": "tools/list",
                "params": {}
            })),
        )
        .await;
        assert_eq!(list_resp.status(), StatusCode::OK);
        let list_bytes = axum::body::to_bytes(list_resp.into_body(), 1024 * 256)
            .await
            .unwrap();
        let list_json: Value = serde_json::from_slice(&list_bytes).unwrap();
        assert_eq!(list_json["id"], 8);
        assert_eq!(
            list_json["result"]["tools"]
                .as_array()
                .expect("tools array")
                .len(),
            18
        );
    }
}
