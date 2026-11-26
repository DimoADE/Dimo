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
    active_profile_id: Option<String>,
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
    needs_token: Option<bool>,
    #[serde(default)]
    last_connected_at: Option<String>,
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

    async fn load_store(&self) -> Result<Option<HostClientStoreFile>, OrchestrationError> {
        let path = self.data_dir.join("host-client-profiles.json");
        let raw = match tokio::fs::read_to_string(&path).await {
            Ok(raw) => raw,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => {
                return Err(OrchestrationError::Internal(format!(
                    "failed to read remote profile store: {err}"
                )));
            }
        };
        let store: HostClientStoreFile = serde_json::from_str(&raw).map_err(|error| {
            OrchestrationError::Internal(format!("invalid remote profile store: {error}"))
        })?;
        Ok(Some(store))
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

        let Some(store) = self.load_store().await? else {
            return Err(OrchestrationError::NotFound(format!(
                "remote environment '{needle}' is not paired on this host"
            )));
        };

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
    async fn list_environments(&self) -> Result<Value, OrchestrationError> {
        let Some(store) = self.load_store().await? else {
            return Ok(json!({
                "local": { "environment_id": "local" },
                "environments": [],
            }));
        };
        let active_id = store.active_profile_id.as_deref();
        let environments: Vec<Value> = store
            .profiles
            .into_iter()
            .map(|profile| {
                let has_credential = profile
                    .access_token
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|t| !t.is_empty());
                let env_id = profile
                    .host_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&profile.id)
                    .to_string();
                let effective_origin = profile
                    .last_good_origin
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&profile.origin)
                    .to_string();
                json!({
                    "environment_id": env_id,
                    "profile_id": profile.id,
                    "host_id": profile.host_id,
                    "name": profile.name,
                    "origin": effective_origin,
                    "has_credential": has_credential,
                    "needs_token": profile.needs_token.unwrap_or(!has_credential),
                    "is_active": active_id == Some(profile.id.as_str()),
                    "last_connected_at": profile.last_connected_at,
                })
            })
            .collect();

        Ok(json!({
            "local": { "environment_id": "local" },
            "environments": environments,
        }))
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn list_environments_handles_missing_store_gracefully() {
        let dir = tempfile::tempdir().expect("tempdir");
        let forwarder = PairedHostMcpForwarder::new(dir.path().to_path_buf());
        let listed = forwarder.list_environments().await.expect("list ok");
        assert_eq!(listed["local"]["environment_id"], "local");
        assert_eq!(listed["environments"].as_array().expect("array").len(), 0);
    }

    #[tokio::test]
    async fn list_environments_redacts_access_token_and_exposes_metadata() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store_json = json!({
            "active_profile_id": "prof-gpu",
            "profiles": [
                {
                    "id": "prof-gpu",
                    "origin": "https://gpu-box.tailnet.ts.net:8443",
                    "last_good_origin": "https://gpu-box.tailnet.ts.net:8443",
                    "host_id": "host-gpu-01",
                    "name": "GPU Workstation",
                    "access_token": "super-secret-bearer-token-do-not-leak",
                    "needs_token": false,
                    "last_connected_at": "2026-11-26T00:00:00Z"
                },
                {
                    "id": "prof-mac",
                    "origin": "http://192.168.1.20:3000",
                    "name": "Mac Mini",
                    "access_token": null
                }
            ]
        });
        tokio::fs::write(
            dir.path().join("host-client-profiles.json"),
            serde_json::to_string_pretty(&store_json).unwrap(),
        )
        .await
        .expect("write store");

        let forwarder = PairedHostMcpForwarder::new(dir.path().to_path_buf());
        let listed = forwarder.list_environments().await.expect("list ok");
        let serialized = serde_json::to_string(&listed).unwrap();
        assert!(
            !serialized.contains("super-secret-bearer-token-do-not-leak"),
            "access_token must never leak in environment_links output"
        );
        let envs = listed["environments"].as_array().expect("array");
        assert_eq!(envs.len(), 2);
        assert_eq!(envs[0]["environment_id"], "host-gpu-01");
        assert_eq!(envs[0]["name"], "GPU Workstation");
        assert_eq!(envs[0]["has_credential"], true);
        assert_eq!(envs[0]["needs_token"], false);
        assert_eq!(envs[0]["is_active"], true);

        assert_eq!(envs[1]["environment_id"], "prof-mac");
        assert_eq!(envs[1]["has_credential"], false);
        assert_eq!(envs[1]["needs_token"], true);
        assert_eq!(envs[1]["is_active"], false);
    }
}
