use std::{collections::HashMap, sync::Arc, time::Duration};

use remote_protocol::{CommandResponse, ErrorEnvelope, OperationId, ServerCapabilities};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{RwLock, oneshot};
use url::Url;
use uuid::Uuid;

use super::error::DesktopError;

const WS_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);

fn websocket_keepalive_ticker() -> tokio::time::Interval {
    let mut ticker = tokio::time::interval_at(
        tokio::time::Instant::now() + WS_KEEPALIVE_INTERVAL,
        WS_KEEPALIVE_INTERVAL,
    );
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker
}

#[derive(Clone)]
struct RemoteCredential(String);

impl std::fmt::Debug for RemoteCredential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("RemoteCredential([REDACTED])")
    }
}

#[derive(Clone)]
struct RemoteProfile {
    base_url: String,
    token: RemoteCredential,
    e2ee: Arc<RwLock<Option<crate::host::connectivity::e2ee_client::E2eeClientSession>>>,
}

struct RemotePump {
    window_label: String,
    profile_id: String,
    cancel: Option<oneshot::Sender<()>>,
}

pub type RemoteEventSink = Arc<dyn Fn(Value) + Send + Sync>;
pub type HostFamilyEventEmitter = Arc<dyn Fn(&str, &str, &Value) + Send + Sync>;

fn is_loopback_base_url(base_url: &str) -> bool {
    Url::parse(base_url).ok().is_some_and(|url| {
        matches!(
            url.host_str().map(str::to_ascii_lowercase).as_deref(),
            Some("127.0.0.1" | "localhost" | "::1" | "[::1]")
        )
    })
}

fn is_relay_base_url(base_url: &str) -> bool {
    Url::parse(base_url)
        .ok()
        .is_some_and(|url| url.path().starts_with("/t/"))
}

async fn ensure_profile_e2ee(
    client: &reqwest::Client,
    profile: &RemoteProfile,
    force_refresh: bool,
) -> Result<Option<crate::host::connectivity::e2ee_client::E2eeClientSession>, DesktopError> {
    if is_loopback_base_url(&profile.base_url) {
        return Ok(None);
    }
    if !force_refresh
        && let Some(existing) = profile.e2ee.read().await.clone()
    {
        return Ok(Some(existing));
    }
    match crate::host::connectivity::e2ee_client::handshake(client, &profile.base_url).await {
        Ok(session) => {
            *profile.e2ee.write().await = Some(session.clone());
            Ok(Some(session))
        }
        Err(error) => {
            if is_relay_base_url(&profile.base_url) {
                return Err(DesktopError::Internal(format!(
                    "E2EE handshake required for relay connection: {error}"
                )));
            }
            Ok(None)
        }
    }
}

#[derive(Clone)]
pub struct RemoteDesktopRegistry {
    profiles: Arc<RwLock<HashMap<(String, String), RemoteProfile>>>,
    pumps: Arc<RwLock<HashMap<Uuid, RemotePump>>>,
    client: reqwest::Client,
}

impl RemoteDesktopRegistry {
    pub fn new() -> Result<Self, DesktopError> {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        Ok(Self {
            profiles: Arc::new(RwLock::new(HashMap::new())),
            pumps: Arc::new(RwLock::new(HashMap::new())),
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(60))
                .build()
                .map_err(internal)?,
        })
    }

    pub async fn connect(
        &self,
        window_label: &str,
        profile_id: &str,
        base_url: &str,
        token: String,
    ) -> Result<(), DesktopError> {
        if window_label.trim().is_empty() || profile_id.trim().is_empty() {
            return Err(DesktopError::BadRequest(
                "window and profile identifiers are required".to_string(),
            ));
        }
        if token.len() < 32 {
            return Err(DesktopError::BadRequest(
                "remote Server token must contain at least 32 bytes".to_string(),
            ));
        }
        let base_url = validate_base_url(base_url)?;
        self.profiles.write().await.insert(
            (window_label.to_string(), profile_id.to_string()),
            RemoteProfile {
                base_url,
                token: RemoteCredential(token),
                e2ee: Arc::new(RwLock::new(None)),
            },
        );
        Ok(())
    }

    pub async fn disconnect(&self, window_label: &str, profile_id: &str) {
        self.cancel_pumps(|pump| {
            pump.window_label == window_label && pump.profile_id == profile_id
        })
        .await;
        self.profiles
            .write()
            .await
            .remove(&(window_label.to_string(), profile_id.to_string()));
    }

    pub async fn disconnect_window(&self, window_label: &str) {
        self.cancel_pumps(|pump| pump.window_label == window_label)
            .await;
        self.profiles
            .write()
            .await
            .retain(|(connected_window, _), _| connected_window != window_label);
    }

    async fn cancel_pumps(&self, predicate: impl Fn(&RemotePump) -> bool) {
        let mut pumps = self.pumps.write().await;
        let ids = pumps
            .iter()
            .filter(|(_, pump)| predicate(pump))
            .map(|(id, _)| *id)
            .collect::<Vec<_>>();
        for id in ids {
            if let Some(mut pump) = pumps.remove(&id)
                && let Some(cancel) = pump.cancel.take()
            {
                let _ = cancel.send(());
            }
        }
    }

    pub async fn cancel_subscription(&self, subscription_id: Uuid) {
        if let Some(mut pump) = self.pumps.write().await.remove(&subscription_id)
            && let Some(cancel) = pump.cancel.take()
        {
            let _ = cancel.send(());
        }
    }

    async fn profile(
        &self,
        window_label: &str,
        profile_id: &str,
    ) -> Result<RemoteProfile, DesktopError> {
        let profiles = self.profiles.read().await;
        if let Some(profile) = profiles.get(&(window_label.to_string(), profile_id.to_string())) {
            return Ok(profile.clone());
        }
        if let Some(host_window) = window_label
            .strip_prefix("settings-")
            .filter(|rest| rest.starts_with("host-") && rest.len() > "host-".len())
            && let Some(profile) = profiles.get(&(host_window.to_string(), profile_id.to_string()))
        {
            return Ok(profile.clone());
        }
        Err(DesktopError::NotFound(
            "remote Server profile not connected".to_string(),
        ))
    }

    async fn send_authed_request(
        &self,
        profile: &RemoteProfile,
        method: reqwest::Method,
        path: &str,
        body_json: Option<&Value>,
    ) -> Result<(reqwest::StatusCode, Vec<u8>), DesktopError> {
        let url = format!("{}{path}", profile.base_url);
        let plain_body = body_json
            .map(serde_json::to_vec)
            .transpose()
            .map_err(internal)?;

        for attempt in 0..2 {
            let session = ensure_profile_e2ee(&self.client, profile, attempt > 0).await?;
            let mut req = self
                .client
                .request(method.clone(), &url)
                .header("x-dimo-protocol-version", remote_protocol::PROTOCOL_VERSION);

            if let Some(ref session) = session {
                let enc_headers =
                    crate::host::connectivity::e2ee_client::build_encrypted_headers(
                        session,
                        Some(&profile.token.0),
                    )
                    .map_err(internal)?;
                req = req.headers(enc_headers);
                if let Some(ref plain) = plain_body {
                    let encrypted = crate::host::connectivity::e2ee_client::encrypt_request_body(
                        session, plain,
                    )
                    .map_err(internal)?;
                    req = req.body(encrypted);
                }
            } else {
                req = req.bearer_auth(&profile.token.0);
                if let Some(ref plain) = plain_body {
                    req = req
                        .header("content-type", "application/json")
                        .body(plain.clone());
                }
            }

            let response = req.send().await.map_err(internal)?;
            let status = response.status();
            if status == reqwest::StatusCode::PRECONDITION_FAILED && attempt == 0 && session.is_some()
            {
                *profile.e2ee.write().await = None;
                continue;
            }
            let resp_headers = response.headers().clone();
            let raw = response.bytes().await.map_err(internal)?;
            let decoded = if let Some(ref session) = session {
                crate::host::connectivity::e2ee_client::decrypt_response_bytes(
                    session,
                    &resp_headers,
                    &raw,
                )
                .map_err(internal)?
            } else {
                raw.to_vec()
            };
            return Ok((status, decoded));
        }

        Err(DesktopError::Internal(
            "remote Server E2EE session re-key failed".to_string(),
        ))
    }

    pub async fn call(
        &self,
        window_label: &str,
        profile_id: &str,
        command: &str,
        args: Value,
        operation_id: Option<OperationId>,
    ) -> Result<Value, DesktopError> {
        if command.is_empty()
            || !command.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'_' | b'-' | b'.')
            })
        {
            return Err(DesktopError::BadRequest(
                "remote command identifier is invalid".to_string(),
            ));
        }
        let profile = self.profile(window_label, profile_id).await?;
        let payload = serde_json::json!({
            "operation_id": operation_id.unwrap_or_default(),
            "args": args,
        });
        let (status, body) = self
            .send_authed_request(
                &profile,
                reqwest::Method::POST,
                &format!("/api/v1/call/{command}"),
                Some(&payload),
            )
            .await?;
        decode_command_bytes(status, &body)
    }

    pub async fn capabilities(
        &self,
        window_label: &str,
        profile_id: &str,
    ) -> Result<ServerCapabilities, DesktopError> {
        let profile = self.profile(window_label, profile_id).await?;
        let (status, body) = self
            .send_authed_request(&profile, reqwest::Method::GET, "/api/v1/capabilities", None)
            .await?;
        if status.is_success() {
            return serde_json::from_slice(&body).map_err(internal);
        }
        Err(remote_error_from_bytes(status, &body))
    }

    pub async fn listen_host_event(
        &self,
        emitter: HostFamilyEventEmitter,
        window_label: &str,
        profile_id: &str,
        event: String,
        subscription_id: Uuid,
    ) -> Result<Uuid, DesktopError> {
        let profile = self.profile(window_label, profile_id).await?;
        let channel = format!("remote-desktop:{profile_id}:{event}");
        let (cancel_tx, cancel_rx) = oneshot::channel();
        self.pumps.write().await.insert(
            subscription_id,
            RemotePump {
                window_label: window_label.to_string(),
                profile_id: profile_id.to_string(),
                cancel: Some(cancel_tx),
            },
        );
        let pumps = self.pumps.clone();
        let http_client = self.client.clone();
        let window_label = window_label.to_string();
        tokio::spawn(async move {
            let result = pump_host_event_socket(
                http_client,
                emitter,
                profile,
                event,
                channel,
                subscription_id,
                cancel_rx,
                window_label,
            )
            .await;
            pumps.write().await.remove(&subscription_id);
            if let Err(error) = result {
                tracing::warn!(%error, "remote desktop host event listen failed");
            }
        });
        Ok(subscription_id)
    }

    pub async fn subscribe_events(
        &self,
        window_label: &str,
        profile_id: &str,
        request: serde_json::Value,
        on_event: RemoteEventSink,
        subscription_id: Uuid,
    ) -> Result<Uuid, DesktopError> {
        let profile = self.profile(window_label, profile_id).await?;
        let (cancel_tx, cancel_rx) = oneshot::channel();
        self.pumps.write().await.insert(
            subscription_id,
            RemotePump {
                window_label: window_label.to_string(),
                profile_id: profile_id.to_string(),
                cancel: Some(cancel_tx),
            },
        );
        let pumps = self.pumps.clone();
        let http_client = self.client.clone();
        tokio::spawn(async move {
            let result = pump_subscription_socket(
                http_client,
                profile,
                request,
                on_event.clone(),
                subscription_id,
                cancel_rx,
            )
            .await;
            on_event(serde_json::json!({
                "kind": "subscription_closed",
                "payload": null,
                "sequence": 0,
            }));
            pumps.write().await.remove(&subscription_id);
            if let Err(error) = result {
                tracing::warn!(%error, "remote desktop subscription failed");
            }
        });
        Ok(subscription_id)
    }
}

fn decode_command_bytes(status: reqwest::StatusCode, body: &[u8]) -> Result<Value, DesktopError> {
    if status.is_success() {
        return serde_json::from_slice::<CommandResponse<Value>>(body)
            .map(|response| response.data)
            .map_err(internal);
    }
    Err(remote_error_from_bytes(status, body))
}

fn remote_error_from_bytes(status: reqwest::StatusCode, body: &[u8]) -> DesktopError {
    match serde_json::from_slice::<ErrorEnvelope>(body) {
        Ok(envelope) => DesktopError::BadRequest(format!(
            "remote Server rejected the request ({status}): {}",
            envelope.message
        )),
        Err(_) => DesktopError::Internal(format!("remote Server returned HTTP {status}")),
    }
}

pub(crate) fn validate_base_url(value: &str) -> Result<String, DesktopError> {
    crate::host::connectivity::validate_remote_base_url(value).map_err(DesktopError::BadRequest)
}

fn internal(error: impl std::fmt::Display) -> DesktopError {
    DesktopError::Internal(error.to_string())
}

fn websocket_url(base_url: &str) -> String {
    format!("{}/api/v1/ws", base_url.replacen("http", "ws", 1))
}

fn token_protocol(token: &str) -> String {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    format!("dimo.token.{}", URL_SAFE_NO_PAD.encode(token.as_bytes()))
}

async fn connect_remote_socket(
    client: &reqwest::Client,
    profile: &RemoteProfile,
) -> Result<
    (
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Option<crate::host::connectivity::e2ee_client::E2eeClientSession>,
    ),
    DesktopError,
> {
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue};
    let e2ee = ensure_profile_e2ee(client, profile, false).await?;
    let mut request = websocket_url(&profile.base_url)
        .into_client_request()
        .map_err(internal)?;
    let protocol = match &e2ee {
        Some(session) => format!(
            "dimo.v1, {}, {}",
            token_protocol(&profile.token.0),
            crate::host::connectivity::e2ee_client::ws_e2ee_subprotocol(session)
        ),
        None => format!("dimo.v1, {}", token_protocol(&profile.token.0)),
    };
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_str(&protocol).map_err(internal)?,
    );
    let (stream, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(internal)?;
    Ok((stream, e2ee))
}

fn encode_ws_frame(
    e2ee: Option<&crate::host::connectivity::e2ee_client::E2eeClientSession>,
    plain: &str,
) -> Result<String, DesktopError> {
    match e2ee {
        Some(session) => {
            crate::host::connectivity::e2ee_client::encrypt_ws_text(session, plain).map_err(internal)
        }
        None => Ok(plain.to_string()),
    }
}

fn decode_ws_frame(
    e2ee: Option<&crate::host::connectivity::e2ee_client::E2eeClientSession>,
    wire: &str,
) -> Option<String> {
    match e2ee {
        Some(session) => crate::host::connectivity::e2ee_client::decrypt_ws_text(session, wire).ok(),
        None => Some(wire.to_string()),
    }
}

#[allow(clippy::too_many_arguments)]
async fn pump_host_event_socket(
    http_client: reqwest::Client,
    emitter: HostFamilyEventEmitter,
    profile: RemoteProfile,
    event: String,
    channel: String,
    subscription_id: Uuid,
    cancel_rx: oneshot::Receiver<()>,
    window_label: String,
) -> Result<(), DesktopError> {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    tokio::pin!(cancel_rx);
    let mut backoff_ms: u64 = 500;
    let mut after_sequence: i64 = 0;

    loop {
        let (mut stream, e2ee) = match connect_remote_socket(&http_client, &profile).await {
            Ok(pair) => {
                backoff_ms = 500;
                pair
            }
            Err(_) => {
                *profile.e2ee.write().await = None;
                tokio::select! {
                    _ = &mut cancel_rx => return Ok(()),
                    _ = tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)) => {
                        backoff_ms = (backoff_ms * 2).min(8_000);
                        continue;
                    }
                }
            }
        };

        let attach = serde_json::json!({
            "type": "attach",
            "request": {
                "subscription_id": subscription_id,
                "resource": "host_event",
                "channel": event,
                "after_sequence": after_sequence,
            }
        });
        let attach_wire = match encode_ws_frame(e2ee.as_ref(), &attach.to_string()) {
            Ok(text) => text,
            Err(_) => {
                *profile.e2ee.write().await = None;
                continue;
            }
        };
        if stream.send(Message::Text(attach_wire.into())).await.is_err() {
            *profile.e2ee.write().await = None;
            tokio::select! {
                _ = &mut cancel_rx => return Ok(()),
                _ = tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)) => {
                    backoff_ms = (backoff_ms * 2).min(8_000);
                    continue;
                }
            }
        }

        let mut keepalive = websocket_keepalive_ticker();
        let mut non_retriable_error = false;
        loop {
            tokio::select! {
                _ = &mut cancel_rx => {
                    let detach = serde_json::json!({
                        "type": "detach",
                        "subscription_id": subscription_id,
                    });
                    if let Ok(wire) = encode_ws_frame(e2ee.as_ref(), &detach.to_string()) {
                        let _ = stream.send(Message::Text(wire.into())).await;
                    }
                    return Ok(());
                }
                _ = keepalive.tick() => {
                    if stream.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                }
                frame = stream.next() => {
                    let Some(frame) = frame else { break };
                    let Ok(frame) = frame else { break };
                    match frame {
                        Message::Close(_) => break,
                        Message::Ping(payload) => {
                            if stream.send(Message::Pong(payload)).await.is_err() {
                                break;
                            }
                        }
                        Message::Pong(_) => {}
                        Message::Text(text) => {
                            let Some(plain) = decode_ws_frame(e2ee.as_ref(), &text) else {
                                continue;
                            };
                            let Ok(value) = serde_json::from_str::<Value>(&plain) else {
                                continue;
                            };
                            match value.get("type").and_then(Value::as_str) {
                                Some("event") => {
                                    if let Some(seq) = value.pointer("/event/sequence").and_then(Value::as_i64) {
                                        after_sequence = after_sequence.max(seq);
                                    }
                                    if let Some(payload) = value.pointer("/event/payload") {
                                        emitter(&window_label, &channel, payload);
                                    }
                                }
                                Some("snapshot") => {
                                    if let Some(seq) = value.pointer("/snapshot/through_sequence").and_then(Value::as_i64) {
                                        after_sequence = after_sequence.max(seq);
                                    }
                                    if let Some(payload) = value.pointer("/snapshot/payload") {
                                        emitter(&window_label, &channel, payload);
                                    }
                                }
                                Some("error") => {
                                    let code = value.pointer("/error/code").and_then(Value::as_str).unwrap_or("");
                                    if matches!(code, "unauthorized" | "forbidden" | "not_found" | "bad_request") {
                                        non_retriable_error = true;
                                        break;
                                    }
                                }
                                Some("detached") => break,
                                _ => {}
                            }
                        }
                        _ => {}
                    }
                }
            }
        }

        if non_retriable_error {
            return Ok(());
        }
        *profile.e2ee.write().await = None;
        tokio::select! {
            _ = &mut cancel_rx => return Ok(()),
            _ = tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)) => {
                backoff_ms = (backoff_ms * 2).min(8_000);
            }
        }
    }
}

async fn pump_subscription_socket(
    http_client: reqwest::Client,
    profile: RemoteProfile,
    request: Value,
    on_event: RemoteEventSink,
    subscription_id: Uuid,
    cancel_rx: oneshot::Receiver<()>,
) -> Result<(), DesktopError> {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let (mut stream, e2ee) = match connect_remote_socket(&http_client, &profile).await {
        Ok(pair) => pair,
        Err(first_error) => {
            let had_e2ee = profile.e2ee.read().await.is_some();
            if !had_e2ee {
                return Err(first_error);
            }
            *profile.e2ee.write().await = None;
            connect_remote_socket(&http_client, &profile).await?
        }
    };
    let mut request = request;
    if let Some(object) = request.as_object_mut() {
        object.insert(
            "subscription_id".to_string(),
            serde_json::json!(subscription_id),
        );
    }
    let attach = serde_json::json!({
        "type": "attach",
        "request": request,
    });
    let attach_wire = encode_ws_frame(e2ee.as_ref(), &attach.to_string())?;
    stream
        .send(Message::Text(attach_wire.into()))
        .await
        .map_err(internal)?;
    tokio::pin!(cancel_rx);
    let mut keepalive = websocket_keepalive_ticker();
    loop {
        tokio::select! {
            _ = &mut cancel_rx => {
                let detach = serde_json::json!({
                    "type": "detach",
                    "subscription_id": subscription_id,
                });
                if let Ok(wire) = encode_ws_frame(e2ee.as_ref(), &detach.to_string()) {
                    let _ = stream.send(Message::Text(wire.into())).await;
                }
                break;
            }
            _ = keepalive.tick() => {
                stream
                    .send(Message::Ping(Vec::new().into()))
                    .await
                    .map_err(internal)?;
            }
            frame = stream.next() => {
                let Some(frame) = frame else { break };
                let text = match frame.map_err(internal)? {
                    Message::Close(_) => break,
                    Message::Ping(payload) => {
                        stream.send(Message::Pong(payload)).await.map_err(internal)?;
                        continue;
                    }
                    Message::Pong(_) => continue,
                    Message::Text(text) => text,
                    _ => continue,
                };
                let Some(plain) = decode_ws_frame(e2ee.as_ref(), &text) else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<Value>(&plain) else {
                    continue;
                };
                match value.get("type").and_then(Value::as_str) {
                    Some("event") => {
                        if let Some(event) = value.get("event") {
                            on_event(event.clone());
                        }
                    }
                    Some("snapshot") => {
                        if let Some(snapshot) = value.get("snapshot") {
                            on_event(serde_json::json!({
                                "kind": "subscription_snapshot",
                                "payload": snapshot.get("payload"),
                                "sequence": snapshot.get("through_sequence"),
                            }));
                        }
                    }
                    Some("error") => {
                        if let Some(error) = value.get("error") {
                            on_event(serde_json::json!({
                                "kind": "subscription_error",
                                "payload": error,
                                "sequence": 0,
                            }));
                        }
                    }
                    Some("detached") => break,
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDesktopProfileInput {
    pub profile_id: String,
    pub base_url: String,
    pub token: String,
}

#[cfg(test)]
mod tests {
    use axum::{Json, Router, extract::Request, http::header, routing::post};
    use remote_protocol::{CommandResponse, OperationId};

    use super::{RemoteCredential, RemoteDesktopRegistry, validate_base_url};

    #[test]
    fn remote_server_urls_accept_http_or_https_origins() {
        assert!(validate_base_url("https://server.example").is_ok());
        assert!(validate_base_url("http://127.0.0.1:17891").is_ok());
        assert!(validate_base_url("http://192.168.1.20:17891").is_ok());
        assert!(validate_base_url("http://studio.local:17891").is_ok());
        assert!(validate_base_url("http://[::1]:17891").is_ok());
        assert!(validate_base_url("http://10.8.0.2:17891").is_ok());
        assert_eq!(
            validate_base_url("http://203.0.113.10:13630").expect("tunnel origin"),
            "http://203.0.113.10:13630"
        );
        assert_eq!(
            validate_base_url("http://47.109.140.92:13630").expect("tunnel origin"),
            "http://47.109.140.92:13630"
        );
        assert_eq!(
            validate_base_url("https://relay.dimo-ai.com/t/host-abc123/").expect("relay origin"),
            "https://relay.dimo-ai.com/t/host-abc123"
        );
        assert_eq!(
            validate_base_url("https://my.example.com/dimo/").expect("reverse proxy subpath"),
            "https://my.example.com/dimo"
        );
        assert!(validate_base_url("https://203.0.113.10").is_ok());
        assert!(validate_base_url("ftp://server.example").is_err());
        assert!(validate_base_url("https://user@server.example").is_err());
        assert!(validate_base_url("https://server.example/a/../b").is_err());
        assert!(validate_base_url("https://server.example/dimo?q=1").is_err());
        assert!(validate_base_url("https://server.example/dimo#frag").is_err());
    }

    #[tokio::test]
    async fn same_profile_name_is_isolated_by_desktop_window() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let router = Router::new().route(
            "/api/v1/call/{command}",
            post(|request: Request| async move {
                let authorization = request
                    .headers()
                    .get(header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default();
                Json(CommandResponse::new(
                    OperationId::new(),
                    serde_json::json!(if authorization.ends_with('a') {
                        "window-a"
                    } else {
                        "window-b"
                    }),
                ))
            }),
        );
        let _task = tokio::spawn(async move { axum::serve(listener, router).await });
        let registry = RemoteDesktopRegistry::new().expect("registry");
        let base_url = format!("http://{address}");
        registry
            .connect(
                "window-a",
                "shared-name",
                &base_url,
                format!("{}a", "x".repeat(32)),
            )
            .await
            .expect("window a");
        registry
            .connect(
                "window-b",
                "shared-name",
                &base_url,
                format!("{}b", "x".repeat(32)),
            )
            .await
            .expect("window b");

        assert_eq!(
            registry
                .call(
                    "window-a",
                    "shared-name",
                    "ping",
                    serde_json::json!({}),
                    None
                )
                .await
                .expect("call a"),
            "window-a"
        );
        assert_eq!(
            registry
                .call(
                    "window-b",
                    "shared-name",
                    "ping",
                    serde_json::json!({}),
                    None
                )
                .await
                .expect("call b"),
            "window-b"
        );
        registry.disconnect_window("window-a").await;
        assert!(
            registry
                .call(
                    "window-a",
                    "shared-name",
                    "ping",
                    serde_json::json!({}),
                    None
                )
                .await
                .is_err()
        );
        assert!(
            registry
                .call(
                    "window-b",
                    "shared-name",
                    "ping",
                    serde_json::json!({}),
                    None
                )
                .await
                .is_ok()
        );
        assert_eq!(
            format!("{:?}", RemoteCredential("super-secret".to_string())),
            "RemoteCredential([REDACTED])"
        );
    }

    #[tokio::test]
    async fn remote_calls_stay_on_the_bound_window_and_its_settings() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let router = Router::new().route(
            "/api/v1/call/{command}",
            post(|_request: Request| async move {
                Json(CommandResponse::new(
                    OperationId::new(),
                    serde_json::json!("bound"),
                ))
            }),
        );
        let _task = tokio::spawn(async move { axum::serve(listener, router).await });
        let registry = RemoteDesktopRegistry::new().expect("registry");
        let base_url = format!("http://{address}");
        registry
            .connect("host-abc", "active-host-client", &base_url, "x".repeat(32))
            .await
            .expect("host window");

        assert!(
            registry
                .call(
                    "main",
                    "active-host-client",
                    "get_projects",
                    serde_json::json!({}),
                    None
                )
                .await
                .is_err()
        );
        assert_eq!(
            registry
                .call(
                    "host-abc",
                    "active-host-client",
                    "get_projects",
                    serde_json::json!({}),
                    None
                )
                .await
                .expect("host window"),
            "bound"
        );
        assert_eq!(
            registry
                .call(
                    "settings-host-abc",
                    "active-host-client",
                    "get_projects",
                    serde_json::json!({}),
                    None
                )
                .await
                .expect("host settings window"),
            "bound"
        );
        _task.abort();
    }

    #[tokio::test]
    async fn cancel_subscription_stops_the_owned_pump() {
        let registry = RemoteDesktopRegistry::new().expect("registry");
        let (tx, rx) = tokio::sync::oneshot::channel();
        let id = uuid::Uuid::new_v4();
        registry.pumps.write().await.insert(
            id,
            super::RemotePump {
                window_label: "window-a".into(),
                profile_id: "profile".into(),
                cancel: Some(tx),
            },
        );
        registry.cancel_subscription(id).await;
        assert!(rx.await.is_ok());
        assert!(registry.pumps.read().await.get(&id).is_none());
    }
}
