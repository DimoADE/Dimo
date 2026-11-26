//! Thin client for the companion → broker socket. Connects per call, frames one
//! [`BrokerMessage`], and reads one [`BrokerResponse`] back.

use std::time::Duration;

use delegation_proto::{BrokerMessage, BrokerResponse, read_frame, write_frame};

/// Workspace reqwest is rustls `no-provider`. Sidecar processes must install a
/// crypto provider before any TLS client is built, same as the Host binary.
pub fn install_rustls_crypto_provider() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}

fn http_client() -> std::io::Result<reqwest::Client> {
    install_rustls_crypto_provider();
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .no_proxy()
        .build()
        .map_err(|error| std::io::Error::other(error.to_string()))
}

/// POST one broker message to the Host HTTP companion endpoint.
pub async fn call_http(
    server_url: &str,
    server_token: Option<&str>,
    conversation_id: Option<&str>,
    product: &str,
    message: &BrokerMessage,
) -> std::io::Result<BrokerResponse> {
    let url = format!("{}/internal/companion", server_url.trim_end_matches('/'));
    let mut request = http_client()?.post(url).json(message);
    if let Some(token) = server_token {
        request = request.bearer_auth(token);
    }
    if let Some(conversation_id) = conversation_id {
        request = request.header("x-dimo-conversation-id", conversation_id);
    }
    request = request.header("x-dimo-product", product);
    let response = request
        .send()
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    if !response.status().is_success() {
        return Err(std::io::Error::other(format!(
            "companion http {}",
            response.status()
        )));
    }
    response
        .json()
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))
}

/// POST one JSON-RPC 2.0 `tools/call` to the Host unified Streamable HTTP `/mcp`
/// endpoint for the 17 orchestration tools (`orchestrator_capabilities`,
/// `delegate_task`, `task_*`, `thread_*`, `project_*`, `pending_request`).
pub async fn call_mcp_http(
    server_url: &str,
    bearer_token: Option<&str>,
    conversation_id: Option<&str>,
    product: &str,
    tool_name: &str,
    arguments: &serde_json::Value,
    parent_tool_use_id: &str,
) -> Result<serde_json::Value, HostCallError> {
    let url = format!("{}/mcp", server_url.trim_end_matches('/'));
    let client = http_client().map_err(|err| HostCallError::transport(err.to_string()))?;
    let mut params = serde_json::json!({
        "name": tool_name,
        "arguments": arguments,
    });
    if !parent_tool_use_id.trim().is_empty()
        && let Some(obj) = params.as_object_mut()
    {
        obj.insert(
            "_meta".into(),
            serde_json::json!({ "tool_use_id": parent_tool_use_id }),
        );
    }
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": params,
    });

    let mut request = client.post(&url).json(&body);
    if let Some(token) = bearer_token.filter(|t| !t.trim().is_empty()) {
        request = request.bearer_auth(token);
    }
    if let Some(conv) = conversation_id.filter(|c| !c.trim().is_empty()) {
        request = request.header("x-dimo-conversation-id", conv);
    }
    request = request.header("x-dimo-product", product);
    if !parent_tool_use_id.trim().is_empty() {
        request = request.header("x-dimo-tool-use-id", parent_tool_use_id);
    }

    let response = request
        .send()
        .await
        .map_err(|error| HostCallError::transport(error.to_string()))?;
    let status = response.status();
    let raw_text = response
        .text()
        .await
        .map_err(|error| HostCallError::transport(error.to_string()))?;

    if !status.is_success() {
        return Err(HostCallError {
            status: Some(status.as_u16()),
            code: format!("http_{}", status.as_u16()),
            message: if raw_text.trim().is_empty() {
                format!("Host /mcp HTTP {} on {}", status.as_u16(), tool_name)
            } else {
                format!(
                    "Host /mcp HTTP {} on {}: {}",
                    status.as_u16(),
                    tool_name,
                    raw_text.trim()
                )
            },
            violations: Vec::new(),
            unmounted_v1_route: status.as_u16() == 404,
        });
    }

    let parsed: serde_json::Value = serde_json::from_str(&raw_text)
        .map_err(|error| HostCallError::transport(error.to_string()))?;
    if let Some(err) = parsed.get("error") {
        return Err(HostCallError::from_json_error(
            None,
            "mcp_rpc_error",
            format!("Host /mcp RPC error on {tool_name}"),
            err,
        ));
    }
    Ok(parsed
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

/// Structured error returned by Host HTTP (`/api/v1/call/<command>`) or Socket IPC
/// (`BrokerMessage::Collaborate`) so `vibex-mcp` never swallows Host validation or
/// runtime errors into fake local success.
#[derive(Debug, Clone)]
pub struct HostCallError {
    pub status: Option<u16>,
    pub code: String,
    pub message: String,
    pub violations: Vec<serde_json::Value>,
    pub unmounted_v1_route: bool,
}

impl HostCallError {
    pub fn transport(message: impl Into<String>) -> Self {
        Self {
            status: None,
            code: "host_transport_error".to_string(),
            message: message.into(),
            violations: Vec::new(),
            unmounted_v1_route: false,
        }
    }

    pub fn from_json_error(
        status: Option<u16>,
        default_code: &str,
        fallback_message: String,
        body: &serde_json::Value,
    ) -> Self {
        let code = body
            .get("error_code")
            .and_then(serde_json::Value::as_str)
            .or_else(|| body.get("code").and_then(serde_json::Value::as_str))
            .or_else(|| {
                body.pointer("/error/code")
                    .and_then(serde_json::Value::as_str)
            })
            .unwrap_or(default_code)
            .to_string();

        let message = body
            .get("message")
            .and_then(serde_json::Value::as_str)
            .or_else(|| {
                body.pointer("/error/message")
                    .and_then(serde_json::Value::as_str)
            })
            .or_else(|| body.get("error").and_then(serde_json::Value::as_str))
            .or_else(|| body.get("text").and_then(serde_json::Value::as_str))
            .map(str::to_string)
            .unwrap_or(fallback_message);

        let violations = extract_violations(body);
        Self {
            status,
            code,
            message,
            violations,
            unmounted_v1_route: false,
        }
    }

    pub fn into_mcp_error_outcome(self) -> serde_json::Value {
        let mut obj = serde_json::Map::new();
        obj.insert("isError".into(), serde_json::json!(true));
        obj.insert("valid".into(), serde_json::json!(false));
        obj.insert("error_code".into(), serde_json::json!(self.code));
        if let Some(status) = self.status {
            obj.insert("status".into(), serde_json::json!(status));
        }
        obj.insert("message".into(), serde_json::json!(self.message));
        obj.insert("text".into(), serde_json::json!(self.message));
        obj.insert(
            "violations".into(),
            serde_json::Value::Array(self.violations),
        );
        serde_json::Value::Object(obj)
    }
}

fn extract_violations(body: &serde_json::Value) -> Vec<serde_json::Value> {
    for candidate in [
        body.get("violations"),
        body.pointer("/detail/violations"),
        body.pointer("/details/violations"),
        body.pointer("/error/violations"),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(arr) = candidate.as_array() {
            return arr.clone();
        }
    }
    Vec::new()
}

/// Unwrap a `BrokerResponse` returned from Socket IPC or `/internal/companion` for
/// a `BrokerMessage::Collaborate` command, converting any broker or domain error
/// into a `HostCallError`.
pub fn unwrap_broker_command_response(
    response: BrokerResponse,
) -> Result<serde_json::Value, HostCallError> {
    match response {
        BrokerResponse::Error { code, message } => Err(HostCallError {
            status: None,
            code,
            message,
            violations: Vec::new(),
            unmounted_v1_route: false,
        }),
        BrokerResponse::Payload(payload) => {
            let explicit_error = payload
                .get("isError")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
                || payload.get("error_code").is_some()
                || (payload.get("error").is_some() && payload.get("data").is_none())
                || (payload.get("code").is_some()
                    && payload.get("message").is_some()
                    && payload.get("id").is_none()
                    && payload.get("data").is_none());
            if explicit_error {
                let fallback = format!("Host command error: {payload}");
                return Err(HostCallError::from_json_error(
                    payload
                        .get("status")
                        .and_then(serde_json::Value::as_u64)
                        .map(|n| n as u16),
                    "host_command_error",
                    fallback,
                    &payload,
                ));
            }
            Ok(payload.get("data").cloned().unwrap_or(payload))
        }
        BrokerResponse::Ack => Ok(serde_json::Value::Null),
        other => Ok(other.into_outcome()),
    }
}

/// Host HTTP `/api/v1/call/<command>` bridge for Pulse tools when connected to a
/// live Host server. Preserves exact `4xx`/`5xx` error messages and `violations`.
pub async fn call_host_v1_command(
    server_url: &str,
    server_token: Option<&str>,
    conversation_id: Option<&str>,
    command: &str,
    operation_id: &str,
    args: &serde_json::Value,
) -> Result<serde_json::Value, HostCallError> {
    let url = format!(
        "{}/api/v1/call/{}",
        server_url.trim_end_matches('/'),
        command
    );
    let client = http_client().map_err(|err| HostCallError::transport(err.to_string()))?;
    let mut request = client.post(&url).json(&serde_json::json!({
        "operation_id": operation_id,
        "args": args,
    }));
    if let Some(token) = server_token.filter(|t| !t.trim().is_empty()) {
        request = request.bearer_auth(token);
    }
    if let Some(conversation_id) = conversation_id.filter(|c| !c.trim().is_empty()) {
        request = request.header("x-dimo-conversation-id", conversation_id);
    }
    request = request.header("x-dimo-protocol-version", "1.0");
    let response = request
        .send()
        .await
        .map_err(|error| HostCallError::transport(error.to_string()))?;
    let status = response.status();
    let raw_text = response
        .text()
        .await
        .map_err(|error| HostCallError::transport(error.to_string()))?;

    if !status.is_success() {
        if let Ok(parsed_json) = serde_json::from_str::<serde_json::Value>(&raw_text) {
            let fallback = format!("Host HTTP {} on {}", status.as_u16(), command);
            return Err(HostCallError::from_json_error(
                Some(status.as_u16()),
                "http_error",
                fallback,
                &parsed_json,
            ));
        }
        let trimmed = raw_text.trim();
        let fallback_msg = if trimmed.is_empty() {
            format!("Host HTTP {} on {}", status.as_u16(), command)
        } else {
            format!("Host HTTP {} on {}: {}", status.as_u16(), command, trimmed)
        };
        return Err(HostCallError {
            status: Some(status.as_u16()),
            code: format!("http_{}", status.as_u16()),
            message: fallback_msg,
            violations: Vec::new(),
            unmounted_v1_route: status.as_u16() == 404 && trimmed.is_empty(),
        });
    }

    if raw_text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    let body: serde_json::Value = serde_json::from_str(&raw_text)
        .map_err(|error| HostCallError::transport(error.to_string()))?;
    Ok(body.get("data").cloned().unwrap_or(body))
}

/// Connect to the broker socket, send `message`, and return its response.
pub async fn call_broker(
    socket_path: &str,
    message: &BrokerMessage,
) -> std::io::Result<BrokerResponse> {
    #[cfg(unix)]
    {
        let mut stream = tokio::net::UnixStream::connect(socket_path).await?;
        write_frame(&mut stream, message).await?;
        read_frame(&mut stream).await
    }

    #[cfg(windows)]
    {
        let mut stream = open_pipe(socket_path).await?;
        write_frame(&mut stream, message).await?;
        read_frame(&mut stream).await
    }
}

/// Open a Windows named pipe, retrying briefly while the server is rebinding the
/// next instance (`ERROR_PIPE_BUSY`).
#[cfg(windows)]
async fn open_pipe(
    socket_path: &str,
) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    use tokio::net::windows::named_pipe::ClientOptions;

    const ERROR_PIPE_BUSY: i32 = 231;
    const RETRY_BUDGET: std::time::Duration = std::time::Duration::from_millis(200);
    const RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(10);

    let deadline = std::time::Instant::now() + RETRY_BUDGET;
    loop {
        match ClientOptions::new().open(socket_path) {
            Ok(client) => return Ok(client),
            Err(err)
                if (err.raw_os_error() == Some(ERROR_PIPE_BUSY)
                    || err.kind() == std::io::ErrorKind::NotFound)
                    && std::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(RETRY_DELAY).await;
            }
            Err(err) => return Err(err),
        }
    }
}
