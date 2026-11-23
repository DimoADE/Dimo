use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::Response,
};
use base64::Engine as _;
use browser_host::{
    BrowserBounds, BrowserHostError, BrowserProxyCapability, BrowserService, ConsoleLine,
    FrozenFrame, NativeTabs,
};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use super::DesktopRuntimeState;
use crate::HostEventBus;

pub const BROWSER_HOST_EVENT: &str = "plugin:browser";
pub const BROWSER_BRIDGE_SUBPROTOCOL: &str = "dimo-browser-bridge";
const RPC_TIMEOUT: Duration = Duration::from_secs(30);

/// Bridges `browser_host::BrowserService` in `dimo-server --desktop` to the
/// Electron Main process over an authenticated loopback WebSocket.
pub struct ElectronBrowserBridge {
    events: Arc<HostEventBus>,
    service: OnceLock<Weak<BrowserService>>,
    active_tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, BrowserHostError>>>>,
    next_id: AtomicU64,
    downloads_dir: Mutex<Option<String>>,
    proxy_capability: Mutex<BrowserProxyCapability>,
}

impl ElectronBrowserBridge {
    pub fn new(events: Arc<HostEventBus>) -> Arc<Self> {
        let default_downloads = dirs::download_dir().map(|p| p.to_string_lossy().into_owned());
        Arc::new(Self {
            events,
            service: OnceLock::new(),
            active_tx: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            downloads_dir: Mutex::new(default_downloads),
            proxy_capability: Mutex::new(BrowserProxyCapability::default()),
        })
    }

    pub fn attach_service(&self, service: &Arc<BrowserService>) {
        let _ = self.service.set(Arc::downgrade(service));
    }

    pub fn is_connected(&self) -> bool {
        self.active_tx
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .is_some_and(|tx| !tx.is_closed())
    }

    fn service(&self) -> Option<Arc<BrowserService>> {
        self.service.get().and_then(Weak::upgrade)
    }

    fn install_connection(&self, tx: mpsc::UnboundedSender<String>) {
        let mut slot = self.active_tx.lock().unwrap_or_else(|p| p.into_inner());
        *slot = Some(tx);
    }

    fn clear_connection_if_matches(&self, tx: &mpsc::UnboundedSender<String>) {
        let mut slot = self.active_tx.lock().unwrap_or_else(|p| p.into_inner());
        let matches = slot
            .as_ref()
            .is_some_and(|current| current.same_channel(tx));
        if matches {
            slot.take();
            drop(slot);
            self.fail_all_pending("Electron browser bridge disconnected");
        }
    }

    fn fail_all_pending(&self, reason: &str) {
        let drained: Vec<oneshot::Sender<Result<Value, BrowserHostError>>> = {
            let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
            pending.drain().map(|(_, sender)| sender).collect()
        };
        for sender in drained {
            let _ = sender.send(Err(BrowserHostError::new("browser_unavailable", reason)));
        }
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Value, BrowserHostError> {
        let tx = {
            self.active_tx
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone()
        }
        .ok_or_else(|| {
            BrowserHostError::new(
                "browser_unavailable",
                "Electron browser bridge is not connected",
            )
        })?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (resp_tx, resp_rx) = oneshot::channel();
        {
            self.pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(id, resp_tx);
        }

        let payload = json!({
            "type": "rpc_request",
            "id": id,
            "method": method,
            "params": params,
        });
        if tx.send(payload.to_string()).is_err() {
            self.pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            return Err(BrowserHostError::new(
                "browser_unavailable",
                "Electron browser bridge channel closed",
            ));
        }

        match tokio::time::timeout(RPC_TIMEOUT, resp_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(BrowserHostError::new(
                "browser_unavailable",
                "Electron browser bridge dropped pending request",
            )),
            Err(_) => {
                self.pending
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&id);
                Err(BrowserHostError::new(
                    "browser_timeout",
                    format!("Electron browser RPC '{method}' timed out"),
                ))
            }
        }
    }

    pub fn handle_client_message(&self, raw: &str, outbound_tx: &mpsc::UnboundedSender<String>) {
        let Ok(msg) = serde_json::from_str::<ClientBridgeMessage>(raw) else {
            tracing::warn!("ignoring malformed Electron browser bridge message");
            return;
        };
        match msg {
            ClientBridgeMessage::Hello {
                downloads_dir,
                proxy_capability,
            } => {
                if let Some(dir) = downloads_dir.filter(|value| !value.trim().is_empty()) {
                    *self.downloads_dir.lock().unwrap_or_else(|p| p.into_inner()) = Some(dir);
                }
                if let Some(cap) = proxy_capability {
                    *self
                        .proxy_capability
                        .lock()
                        .unwrap_or_else(|p| p.into_inner()) = cap;
                }
            }
            ClientBridgeMessage::RpcResponse {
                id,
                ok,
                result,
                code,
                message,
            } => {
                let waiter = self
                    .pending
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&id);
                if let Some(waiter) = waiter {
                    if ok {
                        let _ = waiter.send(Ok(result.unwrap_or(Value::Null)));
                    } else {
                        let err_code = map_rpc_error_code(code.as_deref());
                        let err_msg = message
                            .filter(|s| !s.trim().is_empty())
                            .unwrap_or_else(|| "Electron browser RPC failed".to_owned());
                        let _ = waiter.send(Err(BrowserHostError::new(err_code, err_msg)));
                    }
                }
            }
            ClientBridgeMessage::Event { payload } => {
                self.handle_inbound_event(payload);
            }
            ClientBridgeMessage::CheckNavigation { id, url } => {
                let (allowed, prefer_system) = if let Some(service) = self.service() {
                    (
                        service.can_navigate(&url),
                        service.prefers_system_browser(&url),
                    )
                } else {
                    (true, false)
                };
                let reply = json!({
                    "type": "policy_response",
                    "id": id,
                    "allowed": allowed,
                    "preferSystem": prefer_system,
                });
                let _ = outbound_tx.send(reply.to_string());
            }
        }
    }

    fn handle_inbound_event(&self, payload: Value) {
        let kind = payload
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let tab_id = payload
            .get("tabId")
            .and_then(Value::as_str)
            .unwrap_or_default();

        if let Some(service) = self.service() {
            match kind {
                "tab.state" if !tab_id.is_empty() => {
                    let url = payload.get("url").and_then(Value::as_str);
                    let title = payload.get("title").and_then(Value::as_str);
                    let favicon = payload.get("favicon").and_then(Value::as_str);
                    let loading = payload.get("loading").and_then(Value::as_bool);
                    if loading == Some(true)
                        && let Some(u) = url
                    {
                        let _ = service.begin_navigation(tab_id, u);
                    }
                    if loading == Some(false)
                        && let Some(u) = url
                    {
                        service.commit_url(tab_id, u);
                    }
                    service.update_chrome(tab_id, url, title, favicon);
                }
                "tab.chrome" if !tab_id.is_empty() => {
                    let url = payload.get("url").and_then(Value::as_str);
                    let title = payload.get("title").and_then(Value::as_str);
                    let favicon = payload.get("favicon").and_then(Value::as_str);
                    service.update_chrome(tab_id, url, title, favicon);
                }
                "tab.open" if !tab_id.is_empty() => {
                    if let Some(url) = payload.get("url").and_then(Value::as_str) {
                        let profile_id = payload
                            .get("profileId")
                            .and_then(Value::as_str)
                            .unwrap_or("default");
                        service.adopt_tab(
                            tab_id.to_owned(),
                            url.to_owned(),
                            profile_id.to_owned(),
                            BrowserBounds::default(),
                        );
                    }
                }
                "console" if !tab_id.is_empty() => {
                    if let Some(line_val) = payload.get("line")
                        && let Ok(line) = serde_json::from_value::<ConsoleLine>(line_val.clone())
                    {
                        service.push_console_line(tab_id, line);
                    }
                    return;
                }
                _ => {}
            }
        } else if kind == "console" {
            return;
        }

        self.events.emit(BROWSER_HOST_EVENT, payload);
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientBridgeMessage {
    Hello {
        #[serde(default, rename = "downloadsDir")]
        downloads_dir: Option<String>,
        #[serde(default, rename = "proxyCapability")]
        proxy_capability: Option<BrowserProxyCapability>,
    },
    RpcResponse {
        id: u64,
        ok: bool,
        #[serde(default)]
        result: Option<Value>,
        #[serde(default)]
        code: Option<String>,
        #[serde(default)]
        message: Option<String>,
    },
    Event {
        payload: Value,
    },
    CheckNavigation {
        id: u64,
        url: String,
    },
}

#[async_trait]
impl NativeTabs for ElectronBrowserBridge {
    async fn open(
        &self,
        tab_id: &str,
        url: &str,
        bounds: &BrowserBounds,
        profile_id: &str,
    ) -> Result<(), BrowserHostError> {
        let _ = self
            .rpc(
                "open",
                json!({
                    "tabId": tab_id,
                    "url": url,
                    "bounds": bounds,
                    "profileId": profile_id,
                }),
            )
            .await?;
        Ok(())
    }

    async fn navigate(&self, tab_id: &str, url: &str) -> Result<(), BrowserHostError> {
        let _ = self
            .rpc("navigate", json!({ "tabId": tab_id, "url": url }))
            .await?;
        Ok(())
    }

    async fn close(&self, tab_id: &str) -> Result<(), BrowserHostError> {
        match self.rpc("close", json!({ "tabId": tab_id })).await {
            Ok(_) => Ok(()),
            Err(err) if err.code() == "browser_no_such_tab" => Ok(()),
            Err(err) => Err(err),
        }
    }

    async fn set_bounds(
        &self,
        tab_id: &str,
        bounds: &BrowserBounds,
    ) -> Result<(), BrowserHostError> {
        if !self.is_connected() {
            return Ok(());
        }
        let _ = self
            .rpc("set_bounds", json!({ "tabId": tab_id, "bounds": bounds }))
            .await;
        Ok(())
    }

    async fn eval(&self, tab_id: &str, expression: &str) -> Result<String, BrowserHostError> {
        let value = self
            .rpc("eval", json!({ "tabId": tab_id, "expression": expression }))
            .await?;
        match value {
            Value::String(text) => Ok(text),
            Value::Null => Ok("null".to_owned()),
            other => Ok(other.to_string()),
        }
    }

    async fn current_url(&self, tab_id: &str) -> Result<String, BrowserHostError> {
        let value = self.rpc("current_url", json!({ "tabId": tab_id })).await?;
        Ok(value.as_str().unwrap_or("about:blank").to_owned())
    }

    async fn go_back(&self, tab_id: &str) -> Result<(), BrowserHostError> {
        let _ = self.rpc("go_back", json!({ "tabId": tab_id })).await?;
        Ok(())
    }

    async fn go_forward(&self, tab_id: &str) -> Result<(), BrowserHostError> {
        let _ = self.rpc("go_forward", json!({ "tabId": tab_id })).await?;
        Ok(())
    }

    async fn reload(&self, tab_id: &str) -> Result<(), BrowserHostError> {
        let _ = self.rpc("reload", json!({ "tabId": tab_id })).await?;
        Ok(())
    }

    async fn set_zoom(&self, tab_id: &str, factor: f64) -> Result<(), BrowserHostError> {
        let _ = self
            .rpc("set_zoom", json!({ "tabId": tab_id, "factor": factor }))
            .await?;
        Ok(())
    }

    async fn open_devtools(&self, tab_id: &str) -> Result<(), BrowserHostError> {
        let _ = self
            .rpc("open_devtools", json!({ "tabId": tab_id }))
            .await?;
        Ok(())
    }

    async fn set_device(&self, tab_id: &str, device: &str) -> Result<(), BrowserHostError> {
        let _ = self
            .rpc("set_device", json!({ "tabId": tab_id, "device": device }))
            .await?;
        Ok(())
    }

    async fn inject(&self, tab_id: &str, script: &str) -> Result<(), BrowserHostError> {
        let _ = self
            .rpc("inject", json!({ "tabId": tab_id, "script": script }))
            .await?;
        Ok(())
    }

    async fn freeze_frame(&self, tab_id: &str) -> Result<Option<FrozenFrame>, BrowserHostError> {
        let value = self.rpc("freeze_frame", json!({ "tabId": tab_id })).await?;
        if value.is_null() {
            return Ok(None);
        }
        let frame: FrozenFrame = serde_json::from_value(value).map_err(|error| {
            BrowserHostError::new(
                "browser_read_failed",
                format!("invalid freeze frame: {error}"),
            )
        })?;
        Ok(Some(frame))
    }

    async fn capture_png(&self, tab_id: &str) -> Result<Vec<u8>, BrowserHostError> {
        let value = self.rpc("capture_png", json!({ "tabId": tab_id })).await?;
        let b64 = value
            .as_str()
            .or_else(|| value.get("data").and_then(Value::as_str))
            .ok_or_else(|| {
                BrowserHostError::new("browser_read_failed", "capture_png returned empty payload")
            })?;
        base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .map_err(|error| {
                BrowserHostError::new(
                    "browser_read_failed",
                    format!("capture_png invalid base64: {error}"),
                )
            })
    }

    async fn clear_profile(&self, profile_id: &str) -> Result<(), BrowserHostError> {
        let _ = self
            .rpc("clear_profile", json!({ "profileId": profile_id }))
            .await?;
        Ok(())
    }

    async fn remove_profile(&self, profile_id: &str) -> Result<(), BrowserHostError> {
        let _ = self
            .rpc("remove_profile", json!({ "profileId": profile_id }))
            .await?;
        Ok(())
    }

    async fn reset_all(&self) -> Result<(), BrowserHostError> {
        if !self.is_connected() {
            return Ok(());
        }
        let _ = self.rpc("reset_all", json!({})).await?;
        Ok(())
    }

    fn downloads_dir(&self) -> Option<String> {
        self.downloads_dir
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn proxy_capability(&self) -> BrowserProxyCapability {
        self.proxy_capability
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn supports_page_load_events(&self) -> bool {
        true
    }

    fn notify(&self, payload: Value) {
        self.events.emit(BROWSER_HOST_EVENT, payload);
    }

    async fn stop(&self, tab_id: &str) -> Result<(), BrowserHostError> {
        let _ = self.rpc("stop", json!({ "tabId": tab_id })).await?;
        Ok(())
    }

    async fn find(
        &self,
        tab_id: &str,
        query: &str,
        forward: bool,
    ) -> Result<bool, BrowserHostError> {
        let value = self
            .rpc(
                "find",
                json!({ "tabId": tab_id, "query": query, "forward": forward }),
            )
            .await?;
        Ok(value
            .as_bool()
            .or_else(|| value.get("found").and_then(Value::as_bool))
            .unwrap_or(false))
    }
}

pub async fn ws_browser_bridge(
    ws: WebSocketUpgrade,
    State(state): State<DesktopRuntimeState>,
) -> Response {
    let bridge = Arc::clone(&state.browser_bridge);
    ws.protocols([BROWSER_BRIDGE_SUBPROTOCOL])
        .on_upgrade(move |socket| serve_browser_bridge_socket(socket, bridge))
}

async fn serve_browser_bridge_socket(socket: WebSocket, bridge: Arc<ElectronBrowserBridge>) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<String>();

    bridge.install_connection(outbound_tx.clone());
    tracing::info!("Electron browser bridge WebSocket connected");

    let write_task = tokio::spawn(async move {
        while let Some(text) = outbound_rx.recv().await {
            if ws_sender.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(incoming) = ws_receiver.next().await {
        match incoming {
            Ok(Message::Text(text)) => {
                bridge.handle_client_message(&text, &outbound_tx);
            }
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(_) | Message::Pong(_) | Message::Binary(_)) => {}
            Err(error) => {
                tracing::debug!(%error, "Electron browser bridge socket receive error");
                break;
            }
        }
    }

    write_task.abort();
    bridge.clear_connection_if_matches(&outbound_tx);
    tracing::info!("Electron browser bridge WebSocket disconnected");
}

fn map_rpc_error_code(raw: Option<&str>) -> &'static str {
    match raw.map(str::trim) {
        Some("browser_invalid") => "browser_invalid",
        Some("browser_no_such_tab") => "browser_no_such_tab",
        Some("browser_bad_address") => "browser_bad_address",
        Some("browser_unavailable") => "browser_unavailable",
        Some("browser_read_failed") => "browser_read_failed",
        Some("browser_eval_failed") => "browser_eval_failed",
        Some("browser_timeout") => "browser_timeout",
        Some("capability_unimplemented") => "capability_unimplemented",
        _ => "browser_native_error",
    }
}

#[cfg(test)]
mod tests {
    use browser_host::GrantLevel;

    use super::*;

    #[tokio::test]
    async fn rpc_round_trip_and_capture_png_decoding() {
        let events = Arc::new(HostEventBus::new());
        let bridge = ElectronBrowserBridge::new(events);
        let (tx, mut rx) = mpsc::unbounded_channel();
        bridge.install_connection(tx.clone());

        let bridge_for_responder = Arc::clone(&bridge);
        let tx_for_responder = tx.clone();
        let responder = tokio::spawn(async move {
            let raw = rx.recv().await.expect("rpc_request");
            let parsed: Value = serde_json::from_str(&raw).expect("valid json");
            assert_eq!(parsed["type"], "rpc_request");
            assert_eq!(parsed["method"], "capture_png");
            let id = parsed["id"].as_u64().expect("id");
            let encoded = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n");
            let reply = json!({
                "type": "rpc_response",
                "id": id,
                "ok": true,
                "result": encoded,
            });
            bridge_for_responder.handle_client_message(&reply.to_string(), &tx_for_responder);
        });

        let png = bridge
            .capture_png("tab-1")
            .await
            .expect("capture_png succeeds");
        assert_eq!(png, b"\x89PNG\r\n\x1a\n");
        responder.await.expect("responder finishes");
    }

    #[tokio::test]
    async fn disconnect_fails_inflight_rpc_immediately() {
        let events = Arc::new(HostEventBus::new());
        let bridge = ElectronBrowserBridge::new(events);
        let (tx, mut rx) = mpsc::unbounded_channel();
        bridge.install_connection(tx.clone());

        let bridge_clone = Arc::clone(&bridge);
        let call = tokio::spawn(async move { bridge_clone.eval("tab-1", "1+1").await });

        let _ = rx.recv().await.expect("rpc request sent");
        bridge.clear_connection_if_matches(&tx);

        let err = call
            .await
            .expect("join")
            .expect_err("must fail on disconnect");
        assert_eq!(err.code(), "browser_unavailable");
    }

    #[tokio::test]
    async fn inbound_events_update_browser_service_and_emit_host_event() {
        let events = Arc::new(HostEventBus::new());
        let mut sub = events.subscribe();
        let bridge = ElectronBrowserBridge::new(events);
        let service = Arc::new(BrowserService::new(bridge.clone(), true));
        bridge.attach_service(&service);

        let (tx, mut rx) = mpsc::unbounded_channel();
        bridge.install_connection(tx.clone());

        // Adopt a tab via inbound `tab.open`
        let open_evt = json!({
            "type": "event",
            "payload": {
                "kind": "tab.open",
                "tabId": "tab-42",
                "url": "https://example.com/start",
                "profileId": "default",
            }
        });
        bridge.handle_client_message(&open_evt.to_string(), &tx);

        // Emit `tab.state` commit + chrome update
        let state_evt = json!({
            "type": "event",
            "payload": {
                "kind": "tab.state",
                "tabId": "tab-42",
                "url": "https://example.com/done",
                "title": "Done Page",
                "loading": false,
            }
        });
        bridge.handle_client_message(&state_evt.to_string(), &tx);

        // Emit console line
        let console_evt = json!({
            "type": "event",
            "payload": {
                "kind": "console",
                "tabId": "tab-42",
                "line": {
                    "level": "warn",
                    "source": "console",
                    "text": "hello from electron",
                    "at": 12345
                }
            }
        });
        bridge.handle_client_message(&console_evt.to_string(), &tx);

        // Verify BrowserService state updated
        let listed = browser_host::dispatch(&service, "test-plugin", "tab.list", json!({}))
            .await
            .expect("tab.list");
        let tabs = listed["tabs"].as_array().expect("tabs array");
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0]["tabId"], "tab-42");
        assert_eq!(tabs[0]["url"], "https://example.com/done");
        assert_eq!(tabs[0]["title"], "Done Page");
        assert_eq!(tabs[0]["loading"], false);

        // Verify grant allows console.read
        let _ = browser_host::dispatch(
            &service,
            "test-plugin",
            "grant.set",
            json!({ "tabId": "tab-42", "level": GrantLevel::Read }),
        )
        .await
        .expect("grant.set");
        let console_read = browser_host::dispatch(
            &service,
            "test-plugin",
            "console.read",
            json!({ "tabId": "tab-42" }),
        )
        .await
        .expect("console.read");
        assert_eq!(
            console_read["entries"][0]["text"],
            Value::String("hello from electron".to_owned())
        );

        // Verify check_navigation returns policy_response
        let check_msg = json!({
            "type": "check_navigation",
            "id": 7,
            "url": "https://example.com/page"
        });
        bridge.handle_client_message(&check_msg.to_string(), &tx);
        let policy_raw = rx.recv().await.expect("policy_response");
        let policy_json: Value = serde_json::from_str(&policy_raw).expect("json");
        assert_eq!(policy_json["type"], "policy_response");
        assert_eq!(policy_json["id"], 7);
        assert_eq!(policy_json["allowed"], true);

        // Verify HostEventBus received plugin:browser event
        let first_event = sub.recv().await.expect("event emitted");
        assert_eq!(first_event.channel, BROWSER_HOST_EVENT);
        assert_eq!(first_event.payload["kind"], "tab.open");
    }
}
