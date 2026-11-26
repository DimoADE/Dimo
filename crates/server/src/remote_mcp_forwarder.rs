//! Cross-machine MCP forwarding adapter for `OrchestrationService`.
//!
//! When an agent calls an orchestration tool with a non-local `environment_id`,
//! this forwarder looks up the paired remote Host profile in Dimo's data dir
//! (`host-client-profiles.json`), forwards the JSON-RPC `tools/call` request to
//! the remote Host's `/mcp` endpoint with the caller's monotonic
//! `X-Dimo-Mode-Limit` header, and returns the remote structured payload.

use std::{path::PathBuf, time::Duration};

use async_trait::async_trait;
use delegation::{
    mode_limit::OrchestrationModeLimit,
    orchestration::{OrchestrationError, RemoteMcpForwarder},
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
struct HostClientStoreFile {
    #[serde(default)]
    profiles: Vec<StoredRemoteProfile>,
}

#[derive(Debug, Deserialize)]
struct StoredRemoteProfile {
    id: String,
    origin: String,
    #[serde(default)]
    host_id: Option<String>,
    #[serde(default)]
    name: String,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    last_good_origin: Option<String>,
}

pub(crate) struct PairedHostMcpForwarder {
    data_dir: PathBuf,
    client: reqwest::Client,
}

impl PairedHostMcpForwarder {
    pub(crate) fn new(data_dir: PathBuf) -> Self {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { data_dir, client }
    }

    async fn resolve_profile(
        &self,
        environment_id: &str,
    ) -> Result<StoredRemoteProfile, OrchestrationError> {
        let needle = environment_id.trim();
        if needle.is_empty() {
            return Err(OrchestrationError::BadRequest(
                "environment_id must not be empty".to_string(),
            ));
        }

        let path = self.data_dir.join("host-client-profiles.json");
        let raw = tokio::fs::read_to_string(&path).await.map_err(|_| {
            OrchestrationError::NotFound(format!(
                "remote environment '{needle}' is not paired on this host"
            ))
        })?;
        let store: HostClientStoreFile = serde_json::from_str(&raw).map_err(|error| {
            OrchestrationError::Internal(format!("invalid remote profile store: {error}"))
        })?;

        store
            .profiles
            .into_iter()
            .find(|p| {
                p.id.eq_ignore_ascii_case(needle)
                    || p.host_id
                        .as_deref()
                        .is_some_and(|h| h.eq_ignore_ascii_case(needle))
                    || p.name.eq_ignore_ascii_case(needle)
            })
            .ok_or_else(|| {
                OrchestrationError::NotFound(format!(
                    "remote environment '{needle}' is not paired on this host"
                ))
            })
    }
}

#[async_trait]
impl RemoteMcpForwarder for PairedHostMcpForwarder {
    async fn forward_tool_call(
        &self,
        environment_id: &str,
        tool_name: &str,
        mut arguments: Value,
        mode_limit: OrchestrationModeLimit,
    ) -> Result<Value, OrchestrationError> {
        let profile = self.resolve_profile(environment_id).await?;
        let token = profile
            .access_token
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .ok_or_else(|| {
                OrchestrationError::Unauthorized(format!(
                    "remote environment '{environment_id}' has no stored access token"
                ))
            })?;

        // Strip `environment_id` so the target host executes locally instead of looping.
        if let Some(obj) = arguments.as_object_mut() {
            obj.remove("environment_id");
            if let Some(target) = obj.get_mut("target").and_then(Value::as_object_mut) {
                target.remove("environment_id");
            }
        }

        let origin = profile
            .last_good_origin
            .as_deref()
            .filter(|o| !o.trim().is_empty())
            .unwrap_or(&profile.origin)
            .trim_end_matches('/');
        let url = format!("{origin}/api/v1/mcp");

        let rpc_body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments,
            }
        });

        let response = self
            .client
            .post(&url)
            .bearer_auth(token)
            .header("x-dimo-mode-limit", mode_limit.to_header_value())
            .header("x-dimo-protocol-version", remote_protocol::PROTOCOL_VERSION)
            .json(&rpc_body)
            .send()
            .await
            .map_err(|error| {
                OrchestrationError::Unavailable(format!(
                    "remote environment '{environment_id}' unreachable: {error}"
                ))
            })?;

        let status = response.status();
        let raw_body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            let preview: String = raw_body.trim().chars().take(240).collect();
            return Err(OrchestrationError::Unavailable(format!(
                "remote environment '{environment_id}' returned HTTP {}{}",
                status.as_u16(),
                if preview.is_empty() {
                    String::new()
                } else {
                    format!(": {preview}")
                }
            )));
        }
        let body: Value = serde_json::from_str(&raw_body).map_err(|error| {
            OrchestrationError::Internal(format!(
                "invalid JSON response from remote environment '{environment_id}': {error}"
            ))
        })?;

        if let Some(err) = body.get("error") {
            let msg = err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("remote MCP call failed");
            return Err(OrchestrationError::Internal(msg.to_string()));
        }

        let result = body.get("result").cloned().unwrap_or(Value::Null);
        if result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let text = result
                .pointer("/content/0/text")
                .and_then(Value::as_str)
                .unwrap_or("remote tool returned error");
            return Err(OrchestrationError::Internal(text.to_string()));
        }

        if let Some(structured) = result.get("structuredContent") {
            return Ok(structured.clone());
        }
        if let Some(text) = result.pointer("/content/0/text").and_then(Value::as_str)
            && let Ok(parsed) = serde_json::from_str::<Value>(text)
        {
            return Ok(parsed);
        }
        Ok(result)
    }
}
