//! Happy Eyeballs multi-endpoint selection, full `dimo-pairing:` parsing,
//! relay beacon resolution, and `HostAccessGrant` exchange for Desktop `host_client`.

use std::time::Duration;

use remote_protocol::{DeviceCredential, ReachabilityOrigin, RedeemHostAccessGrantRequest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    DeviceCredentialParts, HealthBody,
    identity::{extract_grant_jti, sign_host_grant_pop},
};
use crate::{
    desktop::{error::DesktopError, remote_desktop::validate_base_url},
    host::connectivity::e2ee_client,
};

#[derive(Debug, Clone)]
pub(super) struct ParsedPairingInput {
    pub host_id: Option<String>,
    pub pairing_token: String,
    pub reachability: Vec<ReachabilityOrigin>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BeaconLookupResult {
    pub host_id: String,
    pub origin: String,
}

#[derive(Debug, Clone, Deserialize)]
struct FlexibleReachabilityOrigin {
    origin: String,
    #[serde(default)]
    kind: Option<String>,
}

pub(super) fn infer_origin_kind(origin: &str) -> String {
    let lower = origin.to_ascii_lowercase();
    if lower.contains("/t/") {
        return "official_relay".to_string();
    }
    if remote_protocol::is_loopback_origin(origin) {
        return "direct".to_string();
    }
    if lower.starts_with("http://10.")
        || lower.starts_with("http://192.168.")
        || lower.starts_with("http://172.")
    {
        return "lan".to_string();
    }
    "custom_public".to_string()
}

pub(super) fn deserialize_flexible_endpoints<'de, D>(
    deserializer: D,
) -> Result<Vec<ReachabilityOrigin>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<Vec<FlexibleReachabilityOrigin>>::deserialize(deserializer)?
        .unwrap_or_default();
    Ok(raw
        .into_iter()
        .filter_map(|item| {
            let origin = item.origin.trim().trim_end_matches('/').to_string();
            if origin.is_empty() {
                return None;
            }
            let kind = item
                .kind
                .map(|k| k.trim().to_string())
                .filter(|k| !k.is_empty())
                .unwrap_or_else(|| infer_origin_kind(&origin));
            Some(ReachabilityOrigin { origin, kind })
        })
        .collect())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectWithGrantRequest {
    #[serde(alias = "host_id")]
    pub host_id: String,
    #[serde(default, alias = "host_name", alias = "hostName")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_flexible_endpoints")]
    pub endpoints: Vec<ReachabilityOrigin>,
    #[serde(alias = "grant_token")]
    pub grant_token: String,
    #[serde(default, alias = "profile_id")]
    pub profile_id: Option<String>,
}

pub(super) fn parse_pairing_input(raw: &str) -> ParsedPairingInput {
    let trimmed = raw.trim();
    if let Some(payload) = trimmed.strip_prefix("dimo-pairing:")
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(payload)
    {
        let token = value
            .get("pairing_token")
            .and_then(serde_json::Value::as_str)
            .map(remote_protocol::canonical_pairing_token)
            .unwrap_or_default();
        let host_id = value
            .get("host_id")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(ToOwned::to_owned);
        let reachability = value
            .get("reachability")
            .and_then(|v| serde_json::from_value::<Vec<ReachabilityOrigin>>(v.clone()).ok())
            .unwrap_or_default();
        return ParsedPairingInput {
            host_id,
            pairing_token: token,
            reachability,
        };
    }

    ParsedPairingInput {
        host_id: None,
        pairing_token: remote_protocol::canonical_pairing_token(trimmed),
        reachability: Vec::new(),
    }
}

fn tier_delay(kind: &str, is_last_good: bool) -> Duration {
    if is_last_good {
        return Duration::ZERO;
    }
    match kind {
        "lan" => Duration::ZERO,
        "custom_public" | "custom_relay" | "published" => Duration::from_millis(250),
        "official_relay" => Duration::from_millis(500),
        _ => Duration::from_millis(250),
    }
}

/// Staggered Happy Eyeballs prober over candidate Host endpoints.
///
/// Races LAN/last-good immediately, custom public/custom relay at +250ms,
/// and official relay at +500ms, strictly checking `host_id` when known.
pub(super) async fn select_best_endpoint(
    client: &reqwest::Client,
    candidates: &[ReachabilityOrigin],
    last_good_origin: Option<&str>,
    expected_host_id: Option<&str>,
) -> Option<(String, HealthBody)> {
    let mut normalized: Vec<(String, Duration)> = Vec::new();

    if let Some(last) = last_good_origin
        && let Ok(clean) = validate_base_url(last)
    {
        normalized.push((clean, Duration::ZERO));
    }

    for candidate in candidates {
        let Ok(clean) = validate_base_url(&candidate.origin) else {
            continue;
        };
        if normalized.iter().any(|(existing, _)| existing == &clean) {
            continue;
        }
        let delay = tier_delay(&candidate.kind, false);
        normalized.push((clean, delay));
    }

    if normalized.is_empty() {
        return None;
    }

    let mut set = tokio::task::JoinSet::new();
    for (origin, delay) in normalized {
        let http = client.clone();
        let expected = expected_host_id.map(ToOwned::to_owned);
        set.spawn(async move {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            let url = format!("{origin}/health");
            let resp = http
                .get(&url)
                .timeout(Duration::from_secs(4))
                .send()
                .await
                .ok()?;
            if !resp.status().is_success() {
                return None;
            }
            let body = resp.json::<HealthBody>().await.ok()?;
            let ok = body.status.as_deref() == Some("ok") || body.ok == Some(true);
            if !ok {
                return None;
            }
            if let Some(ref want) = expected
                && body.host_id.as_deref().map(str::trim) != Some(want.as_str())
            {
                return None;
            }
            Some((origin, body))
        });
    }

    while let Some(joined) = set.join_next().await {
        if let Ok(Some(found)) = joined {
            set.abort_all();
            return Some(found);
        }
    }
    None
}

pub async fn lookup_relay_beacon(
    client: &reqwest::Client,
    relay_origin: &str,
    pairing_code: &str,
) -> Result<BeaconLookupResult, DesktopError> {
    let clean_relay = validate_base_url(relay_origin)?;
    let clean_code = remote_protocol::canonical_pairing_token(pairing_code);
    if clean_code.is_empty() {
        return Err(DesktopError::BadRequest(
            "pairing code is required for relay beacon lookup".into(),
        ));
    }
    let mut hasher = Sha256::new();
    hasher.update(format!("vibex-pair-code-v1:{clean_code}").as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    let topic = format!("vbx-p-{}", &hex[..32]);
    let base_origin = crate::host::connectivity::browser_origin_of(&clean_relay)
        .unwrap_or(clean_relay);
    let url = format!("{base_origin}/v1/beacon/{topic}");

    let resp = client
        .get(&url)
        .timeout(Duration::from_secs(6))
        .send()
        .await
        .map_err(|e| DesktopError::BadRequest(format!("beacon lookup failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(DesktopError::NotFound(
            "no active Host beacon found for that pairing code".into(),
        ));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| DesktopError::Internal(format!("invalid beacon payload: {e}")))?;
    let host_id = body
        .get("host_id")
        .or_else(|| body.get("hostId"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| DesktopError::Internal("beacon payload missing host_id".into()))?
        .to_string();
    let origin = body
        .get("origin")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| DesktopError::Internal("beacon payload missing origin".into()))?
        .to_string();
    Ok(BeaconLookupResult { host_id, origin })
}

pub(super) async fn send_host_http_request(
    client: &reqwest::Client,
    method: reqwest::Method,
    origin: &str,
    path: &str,
    bearer_token: Option<&str>,
    json_body: Option<&[u8]>,
) -> Result<(reqwest::StatusCode, Vec<u8>), DesktopError> {
    let url = format!("{origin}{path}");
    let is_relay = origin.to_ascii_lowercase().contains("/t/");
    let use_e2ee = !super::is_loopback_http_origin(origin);

    if !use_e2ee {
        let mut req = client
            .request(method, &url)
            .header("x-dimo-protocol-version", remote_protocol::PROTOCOL_VERSION);
        if let Some(token) = bearer_token {
            req = req.bearer_auth(token);
        }
        if let Some(body) = json_body {
            req = req
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.to_vec());
        }
        let response = req
            .send()
            .await
            .map_err(|e| DesktopError::BadRequest(format!("could not reach Host: {e}")))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|e| DesktopError::Internal(e.to_string()))?;
        return Ok((status, bytes.to_vec()));
    }

    let auth_header = bearer_token.map(|t| format!("Bearer {t}"));
    for attempt in 0..2 {
        let session = match e2ee_client::handshake(client, origin).await {
            Ok(session) => Some(session),
            Err(error) => {
                if is_relay {
                    return Err(DesktopError::BadRequest(format!(
                        "E2EE handshake required for relay Host: {error}"
                    )));
                }
                None
            }
        };

        let response = if let Some(ref session) = session {
            let enc_headers =
                e2ee_client::build_encrypted_headers(session, auth_header.as_deref())
                    .map_err(DesktopError::Internal)?;
            let mut req = client
                .request(method.clone(), &url)
                .header("x-dimo-protocol-version", remote_protocol::PROTOCOL_VERSION)
                .headers(enc_headers);
            if let Some(body) = json_body {
                let encrypted = e2ee_client::encrypt_request_body(session, body)
                    .map_err(|e| DesktopError::Internal(e.to_string()))?;
                req = req.body(encrypted);
            }
            req.send()
                .await
                .map_err(|e| DesktopError::BadRequest(format!("could not reach Host: {e}")))?
        } else {
            let mut req = client
                .request(method.clone(), &url)
                .header("x-dimo-protocol-version", remote_protocol::PROTOCOL_VERSION);
            if let Some(token) = bearer_token {
                req = req.bearer_auth(token);
            }
            if let Some(body) = json_body {
                req = req
                    .header(reqwest::header::CONTENT_TYPE, "application/json")
                    .body(body.to_vec());
            }
            req.send()
                .await
                .map_err(|e| DesktopError::BadRequest(format!("could not reach Host: {e}")))?
        };

        let status = response.status();
        if status.as_u16() == 412 && session.is_some() && attempt == 0 {
            continue;
        }
        let resp_headers = response.headers().clone();
        let raw_bytes = response
            .bytes()
            .await
            .map_err(|e| DesktopError::Internal(e.to_string()))?;
        let body_bytes = if let Some(ref session) = session {
            e2ee_client::decrypt_response_bytes(session, &resp_headers, &raw_bytes)
                .map_err(DesktopError::Internal)?
        } else {
            raw_bytes.to_vec()
        };
        return Ok((status, body_bytes));
    }

    Err(DesktopError::BadRequest(
        "Host E2EE session expired during request".into(),
    ))
}

pub(super) async fn exchange_host_access_grant(
    client: &reqwest::Client,
    origin: &str,
    host_id: &str,
    grant_token: &str,
    device_name: &str,
) -> Result<DeviceCredentialParts, DesktopError> {
    let jti = extract_grant_jti(grant_token)?;
    let (client_pubkey, pop_signature) = sign_host_grant_pop(&jti, host_id)?;

    let payload = RedeemHostAccessGrantRequest {
        grant_token: grant_token.trim().to_string(),
        client_public_key_ed25519: client_pubkey,
        pop_signature,
        device_name: device_name.to_string(),
        client_kind: Some("desktop".to_string()),
        preset: Some(remote_protocol::DevicePermissionPreset::Workstation),
    };
    let plain =
        serde_json::to_vec(&payload).map_err(|e| DesktopError::Internal(e.to_string()))?;
    let (status, body_bytes) = send_host_http_request(
        client,
        reqwest::Method::POST,
        origin,
        "/api/v1/auth/grant-exchange",
        None,
        Some(&plain),
    )
    .await?;

    if !status.is_success() {
        let msg = serde_json::from_slice::<remote_protocol::ErrorEnvelope>(&body_bytes)
            .map(|env| env.message)
            .unwrap_or_else(|_| format!("Host grant exchange rejected ({status})"));
        return Err(DesktopError::BadRequest(msg));
    }

    let credential: DeviceCredential = serde_json::from_slice(&body_bytes)
        .map_err(|e| DesktopError::Internal(e.to_string()))?;
    Ok(DeviceCredentialParts {
        device_id: Some(credential.device_id.to_string()),
        access_token: credential.access_token,
    })
}

impl super::HostClientRuntime {
    pub fn client_identity(&self) -> Result<super::identity::ClientIdentityView, DesktopError> {
        super::identity::load_client_identity_view()
    }

    pub async fn lookup_beacon(
        &self,
        relay_origin: &str,
        pairing_code: &str,
    ) -> Result<BeaconLookupResult, DesktopError> {
        lookup_relay_beacon(&self.client, relay_origin, pairing_code).await
    }

    pub(super) async fn resolve_origin_for_connect(
        &self,
        request: &super::ConnectHostRequest,
        selected: Option<&super::StoredProfile>,
        parsed_pairing: Option<&ParsedPairingInput>,
    ) -> Result<String, DesktopError> {
        let mut candidates: Vec<ReachabilityOrigin> = Vec::new();
        let mut push_origin = |origin: &str, kind: &str| {
            let trimmed = origin.trim();
            if trimmed.is_empty() {
                return;
            }
            if let Ok(clean) = super::normalize_origin(trimmed)
                && !candidates.iter().any(|c| c.origin == clean)
            {
                candidates.push(ReachabilityOrigin {
                    origin: clean,
                    kind: kind.to_string(),
                });
            }
        };

        if let Some(explicit) = request.origin.as_deref() {
            push_origin(explicit, "lan");
        }
        for ep in &request.endpoints {
            push_origin(&ep.origin, &ep.kind);
        }
        if let Some(parsed) = parsed_pairing {
            for ep in &parsed.reachability {
                push_origin(&ep.origin, &ep.kind);
            }
        }
        if let Some(profile) = selected {
            let advertised =
                super::advertised_connect_origin(&profile.origin, profile.provision.as_ref());
            push_origin(&advertised, "lan");
            for ep in &profile.endpoints {
                push_origin(&ep.origin, &ep.kind);
            }
        }

        if candidates.len() > 1 {
            let expected_host_id = parsed_pairing
                .and_then(|p| p.host_id.as_deref())
                .or_else(|| selected.and_then(|p| p.host_id.as_deref()));
            let last_good = selected.and_then(|p| p.last_good_origin.as_deref());
            if let Some((best, _)) =
                select_best_endpoint(&self.client, &candidates, last_good, expected_host_id).await
            {
                return Ok(best);
            }
        }

        if let Some(first) = candidates.first() {
            return Ok(first.origin.clone());
        }

        super::normalize_origin(&super::resolve_connect_origin(
            request.origin.as_deref(),
            selected.map(|profile| profile.origin.as_str()),
            selected.and_then(|profile| profile.provision.as_ref()),
        ))
    }

    pub async fn connect_with_grant(
        &self,
        caller_window: &str,
        registry: &crate::desktop::remote_desktop::RemoteDesktopRegistry,
        request: ConnectWithGrantRequest,
    ) -> Result<super::ConnectHostResult, DesktopError> {
        let host_id = request.host_id.trim();
        if host_id.is_empty() {
            return Err(DesktopError::BadRequest("hostId is required".into()));
        }
        if request.endpoints.is_empty() {
            return Err(DesktopError::BadRequest(
                "at least one Host endpoint is required".into(),
            ));
        }

        let mut state = self.load().await?;
        let selected = request
            .profile_id
            .as_deref()
            .and_then(|id| state.profiles.iter().find(|p| p.id == id))
            .or_else(|| {
                state
                    .profiles
                    .iter()
                    .find(|p| p.host_id.as_deref() == Some(host_id))
            })
            .cloned();
        let last_good = selected.as_ref().and_then(|p| p.last_good_origin.as_deref());

        let (origin, health) = select_best_endpoint(
            &self.client,
            &request.endpoints,
            last_good,
            Some(host_id),
        )
        .await
        .ok_or_else(|| {
            DesktopError::BadRequest("could not reach Host on any advertised endpoint".into())
        })?;

        let device_name = super::local_device_name();
        let credential = exchange_host_access_grant(
            &self.client,
            &origin,
            host_id,
            &request.grant_token,
            &device_name,
        )
        .await?;

        let capabilities =
            super::fetch_capabilities(&self.client, &origin, &credential.access_token).await?;
        let resolved_host_id = super::empty_to_none(capabilities.host_id)
            .or_else(|| Some(host_id.to_string()));
        let name = request
            .name
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| health.name.and_then(super::empty_to_none))
            .or_else(|| selected.as_ref().map(|p| p.name.clone()).filter(|v| !v.is_empty()))
            .unwrap_or_else(|| origin.clone());

        let now = chrono::Utc::now().to_rfc3339();
        let profile_id = super::upsert_profile(
            &mut state,
            selected.as_ref().map(|p| p.id.as_str()),
            origin.clone(),
            resolved_host_id,
            name,
            credential.clone(),
            now,
        );
        if let Some(profile) = state.profiles.iter_mut().find(|p| p.id == profile_id) {
            let mut merged = request.endpoints.clone();
            for ep in capabilities.reachability {
                if !merged.iter().any(|existing| existing.origin == ep.origin) {
                    merged.push(ep);
                }
            }
            profile.endpoints = merged;
            profile.last_good_origin = Some(origin.clone());
            profile.trust_source = Some("account_linked".to_string());
        }
        state.active_profile_id = None;
        self.save(&state).await?;

        self.bind_window(registry, &profile_id, &origin, credential.access_token)
            .await?;

        let target_window = super::host_window_label(&profile_id);
        let bound_here = caller_window == target_window;
        let views = super::views(&state, bound_here.then_some(profile_id.as_str()));
        let profile = views
            .into_iter()
            .find(|item| item.id == profile_id)
            .expect("connected profile");
        Ok(super::ConnectHostResult {
            profile,
            stopped_host: false,
        })
    }
}

pub(super) async fn fetch_latest_host_version(client: &reqwest::Client) -> Option<String> {
    let repository = std::env::var("DIMO_UPDATE_REPOSITORY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "DimoADE/Dimo".to_string());
    let url = format!("https://api.github.com/repos/{repository}/releases/latest");
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, "Dimo")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: serde_json::Value = response.json().await.ok()?;
    body.get("tag_name")
        .and_then(serde_json::Value::as_str)
        .map(|tag| tag.trim_start_matches('v').to_string())
        .filter(|value| !value.is_empty())
}
