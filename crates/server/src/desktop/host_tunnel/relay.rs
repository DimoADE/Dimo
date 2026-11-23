use std::{
    collections::HashMap,
    io,
    pin::Pin,
    sync::{Arc, LazyLock, RwLock},
    task::{Context, Poll},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, ReadBuf},
    net::TcpStream,
    sync::{Mutex, mpsc, oneshot},
    task::{JoinHandle, JoinSet},
};
use utils::tunnel::{RELAY_CONTROL_TIMEOUT_MS, RELAY_HEARTBEAT_INTERVAL_MS, TunnelEndpoint};

use super::{
    RelayState, drop_rejected_account_lease, load_or_create_host_id_sync, load_store,
    promote_pending_if_connected, publish_browser_origins, refresh_active_pairing_beacons,
    valid_account_lease,
};

const RELAY_REJECTION_PREFIX: &str = "relay rejected control session: ";
const MAX_UPGRADE_HEADER_BYTES: usize = 8192;
const MUX_CHUNK_MAX_BYTES: usize = 32 * 1024;
const MUX_CHANNEL_CAPACITY: usize = 512;
const CONTROL_HANDSHAKE_TIMEOUT: Duration =
    Duration::from_millis(RELAY_HEARTBEAT_INTERVAL_MS + 5_000);
const CONTROL_IDLE_TIMEOUT: Duration = Duration::from_millis(RELAY_CONTROL_TIMEOUT_MS);
const POOL_STREAM_READ_TIMEOUT: Duration = Duration::from_secs(90);
const BEACON_REFRESH_INTERVAL: Duration = Duration::from_secs(10 * 60);

type MuxConnMap = Arc<Mutex<HashMap<String, mpsc::Sender<Vec<u8>>>>>;

struct RelayRuntime {
    handle: JoinHandle<()>,
    state: Arc<Mutex<RelayState>>,
}

static RELAY: LazyLock<Mutex<Option<RelayRuntime>>> = LazyLock::new(|| Mutex::new(None));

struct QuickTunnelRuntime {
    local_port: u16,
    handle: JoinHandle<()>,
}

static QUICK_TUNNEL: LazyLock<Mutex<Option<QuickTunnelRuntime>>> =
    LazyLock::new(|| Mutex::new(None));

static QUICK_TUNNEL_STATE: LazyLock<Arc<Mutex<RelayState>>> =
    LazyLock::new(|| Arc::new(Mutex::new(RelayState::default())));

static QUICK_TUNNEL_ORIGIN: LazyLock<RwLock<Option<String>>> = LazyLock::new(|| RwLock::new(None));

static RELAY_TLS_CONFIG: LazyLock<Arc<rustls::ClientConfig>> = LazyLock::new(|| {
    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("valid default TLS protocol versions")
        .with_root_certificates(root_store)
        .with_no_client_auth();
    Arc::new(config)
});

pub(super) enum RelayStream {
    Plain(TcpStream),
    Tls(Box<tokio_rustls::client::TlsStream<TcpStream>>),
}

impl AsyncRead for RelayStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_read(cx, buf),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for RelayStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_write(cx, buf),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_flush(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RelayControlServerFrame {
    Ping {
        ts: i64,
    },
    ReplenishPool {
        count: usize,
    },
    OpenData {
        host_id: String,
        conn_id: String,
    },
    HttpReq {
        host_id: String,
        id: String,
        method: String,
        path: String,
        headers: Vec<(String, String)>,
        body_b64: String,
    },
    MuxOpen {
        host_id: String,
        conn_id: String,
        raw_req_b64: String,
    },
    MuxData {
        conn_id: String,
        data_b64: String,
    },
    MuxClose {
        conn_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RelayControlClientFrame {
    Pong {
        ts: i64,
    },
    UpdateMeta {
        name: String,
        lan_origins: Vec<String>,
    },
    HttpRes {
        host_id: String,
        id: String,
        status: u16,
        headers: Vec<(String, String)>,
        body_b64: String,
    },
    MuxData {
        host_id: String,
        conn_id: String,
        data_b64: String,
    },
    MuxClose {
        host_id: String,
        conn_id: String,
    },
}

pub(super) fn quick_tunnel_origin() -> Option<String> {
    QUICK_TUNNEL_ORIGIN
        .read()
        .ok()
        .and_then(|guard| guard.clone())
}

pub(super) fn set_quick_tunnel_origin(origin: Option<String>) {
    if let Ok(mut guard) = QUICK_TUNNEL_ORIGIN.write() {
        *guard = origin;
    }
}

pub(super) async fn relay_snapshot() -> RelayState {
    let runtime = RELAY.lock().await;
    if let Some(runtime) = runtime.as_ref() {
        runtime.state.lock().await.clone()
    } else {
        RelayState::default()
    }
}

pub(super) async fn quick_tunnel_snapshot() -> RelayState {
    QUICK_TUNNEL_STATE.lock().await.clone()
}

pub(super) async fn ensure_quick_tunnel(local_port: u16) {
    if cfg!(test) {
        return;
    }
    {
        let guard = QUICK_TUNNEL.lock().await;
        if let Some(runtime) = guard.as_ref()
            && runtime.local_port == local_port
            && !runtime.handle.is_finished()
        {
            return;
        }
    }
    stop_quick_tunnel().await;
    {
        let mut state = QUICK_TUNNEL_STATE.lock().await;
        state.status = "connecting".to_string();
        state.error = None;
    }
    let handle = tokio::spawn(run_quick_tunnel_supervisor(local_port));
    *QUICK_TUNNEL.lock().await = Some(QuickTunnelRuntime { local_port, handle });
}

pub async fn stop_quick_tunnel() {
    if let Some(runtime) = QUICK_TUNNEL.lock().await.take() {
        runtime.handle.abort();
    }
    set_quick_tunnel_origin(None);
    *QUICK_TUNNEL_STATE.lock().await = RelayState::default();
    if let Ok(store) = load_store().await {
        publish_browser_origins(&store);
    }
}

/// Relay rejections that the same lease can never recover from (the computer was removed
/// from the account, or the lease is no longer valid). Retrying them only loads the relay.
pub(super) fn terminal_lease_rejection(error: &str) -> Option<&str> {
    let reason = error.strip_prefix(RELAY_REJECTION_PREFIX)?.trim();
    matches!(
        reason,
        "host_revoked" | "lease_expired" | "invalid_lease_signature" | "lease_host_mismatch"
    )
    .then_some(reason)
}

async fn connect_tcp_with_fallback(host: &str, port: u16) -> Result<TcpStream, String> {
    let host_owned = host.to_string();
    let resolved = tokio::task::spawn_blocking(move || {
        utils::net::resolve_host_ipv4_direct(&host_owned, port)
    })
    .await
    .ok()
    .flatten();

    if let Some(addr) = resolved {
        match tokio::time::timeout(
            Duration::from_secs(6),
            utils::net::connect_tcp_bypassing_tun(addr),
        )
        .await
        {
            Ok(Ok(stream)) => return Ok(stream),
            Ok(Err(err)) => {
                tracing::debug!(
                    %host,
                    port,
                    %addr,
                    %err,
                    "direct TUN-bypass TCP connect failed; falling back to OS resolver"
                );
            }
            Err(_) => {
                tracing::debug!(
                    %host,
                    port,
                    %addr,
                    "direct TUN-bypass TCP connect timed out; falling back to OS resolver"
                );
            }
        }
    }

    let stream = tokio::time::timeout(Duration::from_secs(8), TcpStream::connect((host, port)))
        .await
        .map_err(|_| format!("TCP connect to {host}:{port} timed out"))?
        .map_err(|err| err.to_string())?;
    let _ = stream.set_nodelay(true);
    utils::net::configure_tcp_keepalive(&stream);
    Ok(stream)
}

async fn perform_http_tunnel_upgrade<S>(stream: &mut S, host: &str) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let req = format!(
        "GET /v1/tunnel HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
    );
    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|err| err.to_string())?;
    stream.flush().await.map_err(|err| err.to_string())?;

    let header_bytes = tokio::time::timeout(Duration::from_secs(6), async {
        let mut buf = Vec::with_capacity(256);
        let mut byte = [0u8; 1];
        loop {
            let n = stream
                .read(&mut byte)
                .await
                .map_err(|err| err.to_string())?;
            if n == 0 {
                return Err("relay closed connection during upgrade".to_string());
            }
            buf.push(byte[0]);
            if buf.ends_with(b"\r\n\r\n") {
                return Ok(buf);
            }
            if buf.len() >= MAX_UPGRADE_HEADER_BYTES {
                return Err("relay upgrade response headers exceeded limit".to_string());
            }
        }
    })
    .await
    .map_err(|_| "relay tunnel upgrade timed out".to_string())??;

    let status_line = String::from_utf8_lossy(&header_bytes);
    if !status_line.starts_with("HTTP/1.1 101") && !status_line.starts_with("HTTP/1.0 101") {
        let first = status_line.lines().next().unwrap_or("unknown status");
        return Err(format!("relay upgrade rejected: {first}"));
    }
    Ok(())
}

async fn connect_to_relay_host(host: &str, port: u16) -> Result<RelayStream, String> {
    let is_domain =
        host.parse::<std::net::IpAddr>().is_err() && !host.eq_ignore_ascii_case("localhost");

    if port == 443 && is_domain {
        let tcp = connect_tcp_with_fallback(host, 443).await?;
        let server_name = rustls_pki_types::ServerName::try_from(host.to_string())
            .map_err(|err| format!("invalid relay TLS server name '{host}': {err}"))?;
        let connector = tokio_rustls::TlsConnector::from(RELAY_TLS_CONFIG.clone());
        let tls = tokio::time::timeout(Duration::from_secs(8), connector.connect(server_name, tcp))
            .await
            .map_err(|_| "relay TLS handshake timed out".to_string())?
            .map_err(|err| format!("relay TLS handshake failed: {err}"))?;
        let mut stream = RelayStream::Tls(Box::new(tls));
        perform_http_tunnel_upgrade(&mut stream, host).await?;
        return Ok(stream);
    }

    if port == 80 && is_domain {
        let tcp = connect_tcp_with_fallback(host, 80).await?;
        let mut stream = RelayStream::Plain(tcp);
        perform_http_tunnel_upgrade(&mut stream, host).await?;
        return Ok(stream);
    }

    let tcp = connect_tcp_with_fallback(host, port).await?;
    Ok(RelayStream::Plain(tcp))
}

async fn run_quick_tunnel_supervisor(local_port: u16) {
    let state = QUICK_TUNNEL_STATE.clone();
    loop {
        if let Ok(store) = load_store().await
            && let Some(lease) = valid_account_lease(&store)
        {
            let host = lease.relay_host.trim().to_string();
            let port = lease.relay_port;
            let token = lease.lease_token.trim().to_string();
            let key = format!("{host}:{port}:official");
            {
                let mut snapshot = state.lock().await;
                snapshot.status = "connecting".to_string();
                snapshot.connected_key = Some(key.clone());
            }
            match maintain_control(&host, port, &token, local_port, &key, &state).await {
                Ok(()) => {
                    set_quick_tunnel_origin(None);
                    let mut snapshot = state.lock().await;
                    snapshot.status = "connecting".to_string();
                }
                Err(error) => {
                    set_quick_tunnel_origin(None);
                    {
                        let mut snapshot = state.lock().await;
                        snapshot.status = "connecting".to_string();
                        snapshot.error = Some(error.clone());
                    }
                    if let Some(reason) = terminal_lease_rejection(&error) {
                        tracing::warn!(reason, "official relay rejected the account lease");
                        drop_rejected_account_lease(&token).await;
                    }
                }
            }
        } else {
            set_quick_tunnel_origin(None);
            *state.lock().await = RelayState::default();
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

pub(super) async fn start_relay(host: String, port: u16, token: String, local_port: u16) {
    let key = format!("{host}:{port}:{token}");
    {
        let current = RELAY.lock().await;
        if let Some(runtime) = current.as_ref() {
            let state = runtime.state.lock().await;
            if state.connected_key.as_deref() == Some(key.as_str())
                && (state.status == "connected" || state.status == "connecting")
            {
                return;
            }
        }
    }
    stop_relay().await;
    let state = Arc::new(Mutex::new(RelayState {
        status: "connecting".to_string(),
        error: None,
        connected_key: Some(key.clone()),
    }));
    let handle = tokio::spawn(run_relay(host, port, token, local_port, key, state.clone()));
    *RELAY.lock().await = Some(RelayRuntime { handle, state });
}

pub async fn stop_relay() {
    if let Some(runtime) = RELAY.lock().await.take() {
        runtime.handle.abort();
    }
}

async fn run_relay(
    host: String,
    port: u16,
    token: String,
    local_port: u16,
    key: String,
    state: Arc<Mutex<RelayState>>,
) {
    loop {
        match maintain_control(&host, port, &token, local_port, &key, &state).await {
            Ok(()) => {
                let mut snapshot = state.lock().await;
                snapshot.status = "connecting".to_string();
            }
            Err(error) => {
                let mut snapshot = state.lock().await;
                snapshot.status = "connecting".to_string();
                snapshot.error = Some(error);
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

fn send_mux_close(ctrl_tx: &mpsc::UnboundedSender<String>, host_id: &str, conn_id: &str) {
    if let Ok(frame) = serde_json::to_string(&RelayControlClientFrame::MuxClose {
        host_id: host_id.to_string(),
        conn_id: conn_id.to_string(),
    }) {
        let _ = ctrl_tx.send(format!("{frame}\n"));
    }
}

async fn remove_mux_conn_if_current(
    mux_conns: &MuxConnMap,
    conn_id: &str,
    weak_tx: &mpsc::WeakSender<Vec<u8>>,
) -> bool {
    let mut guard = mux_conns.lock().await;
    let should_remove = match (guard.get(conn_id), weak_tx.upgrade()) {
        (Some(current), Some(ours)) => current.same_channel(&ours),
        _ => false,
    };
    if should_remove {
        guard.remove(conn_id);
    }
    should_remove
}

#[allow(clippy::too_many_arguments)]
async fn run_mux_local_bridge(
    local_port: u16,
    host_id: String,
    conn_id: String,
    raw_req: Vec<u8>,
    mut rx: mpsc::Receiver<Vec<u8>>,
    weak_tx: mpsc::WeakSender<Vec<u8>>,
    mux_conns: MuxConnMap,
    ctrl_tx: mpsc::UnboundedSender<String>,
) {
    let local = match TcpStream::connect(("127.0.0.1", local_port)).await {
        Ok(stream) => {
            let _ = stream.set_nodelay(true);
            stream
        }
        Err(_) => {
            remove_mux_conn_if_current(&mux_conns, &conn_id, &weak_tx).await;
            send_mux_close(&ctrl_tx, &host_id, &conn_id);
            return;
        }
    };

    let (mut local_reader, mut local_writer) = local.into_split();
    if local_writer.write_all(&raw_req).await.is_err() {
        remove_mux_conn_if_current(&mux_conns, &conn_id, &weak_tx).await;
        send_mux_close(&ctrl_tx, &host_id, &conn_id);
        return;
    }

    let writer_fut = async {
        while let Some(chunk) = rx.recv().await {
            if local_writer.write_all(&chunk).await.is_err() {
                break;
            }
        }
        let _ = local_writer.shutdown().await;
    };

    let reader_fut = async {
        let mut buf = vec![0u8; MUX_CHUNK_MAX_BYTES];
        loop {
            match local_reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let Ok(frame) = serde_json::to_string(&RelayControlClientFrame::MuxData {
                        host_id: host_id.clone(),
                        conn_id: conn_id.clone(),
                        data_b64: BASE64.encode(&buf[..n]),
                    }) else {
                        break;
                    };
                    if ctrl_tx.send(format!("{frame}\n")).is_err() {
                        break;
                    }
                }
            }
        }
        if remove_mux_conn_if_current(&mux_conns, &conn_id, &weak_tx).await {
            send_mux_close(&ctrl_tx, &host_id, &conn_id);
        }
    };

    tokio::pin!(writer_fut);
    tokio::pin!(reader_fut);

    tokio::select! {
        () = &mut reader_fut => {
            let _ = tokio::time::timeout(Duration::from_secs(2), &mut writer_fut).await;
        }
        () = &mut writer_fut => {
            let _ = tokio::time::timeout(Duration::from_secs(5), &mut reader_fut).await;
        }
    }
}

async fn maintain_control(
    host: &str,
    port: u16,
    token: &str,
    local_port: u16,
    key: &str,
    state: &Arc<Mutex<RelayState>>,
) -> Result<(), String> {
    let host_id = tokio::task::spawn_blocking(load_or_create_host_id_sync)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "default".to_string());

    let stream = connect_to_relay_host(host, port).await?;
    maintain_control_on_stream(
        stream,
        host,
        port,
        token,
        &host_id,
        local_port,
        key,
        state,
        CONTROL_HANDSHAKE_TIMEOUT,
        CONTROL_IDLE_TIMEOUT,
        true,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn maintain_control_on_stream<S>(
    stream: S,
    host: &str,
    port: u16,
    token: &str,
    host_id: &str,
    local_port: u16,
    key: &str,
    state: &Arc<Mutex<RelayState>>,
    handshake_timeout: Duration,
    idle_timeout: Duration,
    publish_to_host: bool,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (reader, mut writer) = tokio::io::split(stream);

    // Never transmit local hostname or internal LAN IPs to the public relay control plane.
    let name_b64 = BASE64.encode(b"Dimo Desktop");
    let lan_b64 = BASE64.encode(b"[]");
    writer
        .write_all(format!("DIMO-CTRL v2 {host_id} {token} {name_b64} {lan_b64} mux\n").as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    writer.flush().await.map_err(|error| error.to_string())?;

    let mut lines = BufReader::new(reader).lines();

    // Wait for the relay's first control response (OK / ERR / first frame) before reporting
    // "connected" or advertising the public tenant origin.
    let first_line = loop {
        let maybe_line = tokio::time::timeout(handshake_timeout, lines.next_line())
            .await
            .map_err(|_| "tunnel control handshake timed out".to_string())?
            .map_err(|error| error.to_string())?;
        let Some(line) = maybe_line else {
            return Err("tunnel control closed during handshake".to_string());
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(err_reason) = trimmed.strip_prefix("ERR ") {
            return Err(format!("{RELAY_REJECTION_PREFIX}{err_reason}"));
        }
        break line;
    };

    {
        let mut snapshot = state.lock().await;
        snapshot.status = "connected".to_string();
        snapshot.error = None;
        snapshot.connected_key = Some(key.to_string());
    }

    let endpoint = TunnelEndpoint {
        host: host.to_string(),
        port,
    };
    let scheme = if port == 443 { "https" } else { "http" };
    let tenant_origin = utils::tunnel::format_tenant_origin(scheme, &endpoint, host_id);
    if publish_to_host {
        set_quick_tunnel_origin(Some(tenant_origin.clone()));
        if let Ok(store) = load_store().await {
            publish_browser_origins(&store);
        }
        promote_pending_if_connected(host, port, token, host_id).await;
        {
            let beacon_host = host.to_string();
            let beacon_origin = tenant_origin.clone();
            tokio::spawn(async move {
                refresh_active_pairing_beacons(&beacon_host, port, &beacon_origin).await;
            });
        }
    }

    let (ctrl_tx, mut ctrl_rx) = mpsc::unbounded_channel::<String>();
    let (write_err_tx, mut write_err_rx) = oneshot::channel::<String>();
    let writer_task = tokio::spawn(async move {
        while let Some(first) = ctrl_rx.recv().await {
            if let Err(err) = writer.write_all(first.as_bytes()).await {
                let _ = write_err_tx.send(format!("tunnel control write failed: {err}"));
                return;
            }
            while let Ok(next) = ctrl_rx.try_recv() {
                if let Err(err) = writer.write_all(next.as_bytes()).await {
                    let _ = write_err_tx.send(format!("tunnel control write failed: {err}"));
                    return;
                }
            }
            if let Err(err) = writer.flush().await {
                let _ = write_err_tx.send(format!("tunnel control flush failed: {err}"));
                return;
            }
        }
    });

    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let local_http_client = reqwest::Client::builder()
        .no_proxy()
        .pool_max_idle_per_host(16)
        .timeout(Duration::from_secs(65))
        .build()
        .map_err(|err| err.to_string())?;

    let mux_conns: MuxConnMap = Arc::new(Mutex::new(HashMap::new()));
    let mut mux_tasks = JoinSet::new();
    let mut beacon_refresh_ticker = tokio::time::interval_at(
        tokio::time::Instant::now() + BEACON_REFRESH_INTERVAL,
        BEACON_REFRESH_INTERVAL,
    );
    beacon_refresh_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let outcome: Result<(), String> = async {
        let mut pending_first_line = Some(first_line);
        let idle_deadline = tokio::time::sleep(idle_timeout);
        tokio::pin!(idle_deadline);

        loop {
            let line = if let Some(initial) = pending_first_line.take() {
                initial
            } else {
                tokio::select! {
                    line_res = lines.next_line() => {
                        match line_res.map_err(|error| error.to_string())? {
                            Some(line) => {
                                idle_deadline.as_mut().reset(tokio::time::Instant::now() + idle_timeout);
                                line
                            }
                            None => return Err("tunnel control closed".to_string()),
                        }
                    }
                    write_err = &mut write_err_rx => {
                        return Err(write_err.unwrap_or_else(|_| "tunnel control writer exited".to_string()));
                    }
                    () = &mut idle_deadline => {
                        return Err("tunnel control heartbeat timed out".to_string());
                    }
                    _ = beacon_refresh_ticker.tick(), if publish_to_host => {
                        let beacon_host = host.to_string();
                        let beacon_origin = tenant_origin.clone();
                        tokio::spawn(async move {
                            refresh_active_pairing_beacons(&beacon_host, port, &beacon_origin).await;
                        });
                        continue;
                    }
                }
            };

            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with("OK ") || trimmed == "OK" {
                continue;
            }
            if let Some(err_reason) = trimmed.strip_prefix("ERR ") {
                return Err(format!("{RELAY_REJECTION_PREFIX}{err_reason}"));
            }
            // Backwards compatibility with v1 single-host relay script
            if let Some(id) = trimmed.strip_prefix("OPEN ") {
                let host = host.to_string();
                let token = token.to_string();
                let id = id.to_string();
                tokio::spawn(async move {
                    let _ = open_data_path(host, port, token, id, local_port).await;
                });
                continue;
            }

            let Ok(frame) = serde_json::from_str::<RelayControlServerFrame>(trimmed) else {
                continue;
            };
            match frame {
                RelayControlServerFrame::Ping { ts } => {
                    if let Ok(pong) = serde_json::to_string(&RelayControlClientFrame::Pong { ts }) {
                        let _ = ctrl_tx.send(format!("{pong}\n"));
                    }
                    while mux_tasks.try_join_next().is_some() {}
                }
                RelayControlServerFrame::ReplenishPool { count } => {
                    let count = count.min(4);
                    for _ in 0..count {
                        let host = host.to_string();
                        let host_id = host_id.to_string();
                        let token = token.to_string();
                        tokio::spawn(async move {
                            let _ =
                                open_prewarmed_pool_stream(host, port, host_id, token, local_port)
                                    .await;
                        });
                    }
                }
                RelayControlServerFrame::OpenData {
                    host_id: target_host_id,
                    conn_id,
                } => {
                    if target_host_id != host_id {
                        continue;
                    }
                    let host = host.to_string();
                    let host_id = host_id.to_string();
                    let token = token.to_string();
                    tokio::spawn(async move {
                        let _ = open_v2_data_path(host, port, host_id, token, conn_id, local_port)
                            .await;
                    });
                }
                RelayControlServerFrame::MuxOpen {
                    host_id: target_host_id,
                    conn_id,
                    raw_req_b64,
                } => {
                    if target_host_id != host_id {
                        continue;
                    }
                    while mux_tasks.try_join_next().is_some() {}
                    let Ok(raw_req) = BASE64.decode(raw_req_b64) else {
                        send_mux_close(&ctrl_tx, host_id, &conn_id);
                        continue;
                    };
                    let (tx, rx) = mpsc::channel::<Vec<u8>>(MUX_CHANNEL_CAPACITY);
                    let weak_tx = tx.downgrade();
                    mux_conns.lock().await.insert(conn_id.clone(), tx);

                    let mux_conns_clone = mux_conns.clone();
                    let ctrl_tx_clone = ctrl_tx.clone();
                    let host_id_clone = host_id.to_string();
                    mux_tasks.spawn(async move {
                        run_mux_local_bridge(
                            local_port,
                            host_id_clone,
                            conn_id,
                            raw_req,
                            rx,
                            weak_tx,
                            mux_conns_clone,
                            ctrl_tx_clone,
                        )
                        .await;
                    });
                }
                RelayControlServerFrame::MuxData { conn_id, data_b64 } => {
                    let Ok(bytes) = BASE64.decode(data_b64) else {
                        continue;
                    };
                    if bytes.is_empty() {
                        continue;
                    }
                    let sender = mux_conns.lock().await.get(&conn_id).cloned();
                    if let Some(tx) = sender {
                        match tokio::time::timeout(Duration::from_secs(10), tx.send(bytes)).await {
                            Ok(Ok(())) => {}
                            Ok(Err(_)) | Err(_) => {
                                mux_conns.lock().await.remove(&conn_id);
                                send_mux_close(&ctrl_tx, host_id, &conn_id);
                            }
                        }
                    }
                }
                RelayControlServerFrame::MuxClose { conn_id } => {
                    mux_conns.lock().await.remove(&conn_id);
                }
                RelayControlServerFrame::HttpReq {
                    host_id: req_host_id,
                    id,
                    method,
                    path,
                    headers,
                    body_b64,
                } => {
                    // Strict multi-tenant check: never process a request addressed to another host_id
                    if req_host_id != host_id {
                        continue;
                    }
                    let client = local_http_client.clone();
                    let ctrl_tx = ctrl_tx.clone();
                    let host_id = host_id.to_string();
                    tokio::spawn(async move {
                        let url = format!("http://127.0.0.1:{local_port}{path}");
                        let m = reqwest::Method::from_bytes(method.as_bytes())
                            .unwrap_or(reqwest::Method::GET);
                        let mut req = client.request(m, &url);
                        for (k, v) in headers {
                            req = req.header(&k, &v);
                        }
                        let body = BASE64.decode(body_b64).unwrap_or_default();
                        if !body.is_empty() {
                            req = req.body(body);
                        }
                        let (status, out_headers, resp_bytes) = match req.send().await {
                            Ok(resp) => {
                                let status = resp.status().as_u16();
                                let mut hdrs = Vec::new();
                                for (k, v) in resp.headers() {
                                    if let Ok(s) = v.to_str() {
                                        hdrs.push((k.as_str().to_string(), s.to_string()));
                                    }
                                }
                                let bytes = resp.bytes().await.unwrap_or_default().to_vec();
                                (status, hdrs, bytes)
                            }
                            Err(_) => (502, Vec::new(), Vec::new()),
                        };
                        if let Ok(res_frame) =
                            serde_json::to_string(&RelayControlClientFrame::HttpRes {
                                host_id,
                                id,
                                status,
                                headers: out_headers,
                                body_b64: BASE64.encode(&resp_bytes),
                            })
                        {
                            let _ = ctrl_tx.send(format!("{res_frame}\n"));
                        }
                    });
                }
            }
        }
    }
    .await;

    writer_task.abort();
    mux_conns.lock().await.clear();
    mux_tasks.abort_all();
    outcome
}

async fn open_prewarmed_pool_stream(
    host: String,
    port: u16,
    host_id: String,
    token: String,
    local_port: u16,
) -> Result<(), String> {
    let remote = connect_to_relay_host(&host, port).await?;
    let mut buf_remote = BufReader::new(remote);
    buf_remote
        .get_mut()
        .write_all(format!("DIMO-DATA v2 {host_id} {token} POOL\n").as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    buf_remote
        .get_mut()
        .flush()
        .await
        .map_err(|error| error.to_string())?;

    let mut line = String::new();
    loop {
        line.clear();
        let n = tokio::time::timeout(POOL_STREAM_READ_TIMEOUT, buf_remote.read_line(&mut line))
            .await
            .map_err(|_| "prewarmed pool stream read timed out".to_string())?
            .map_err(|error| error.to_string())?;
        if n == 0 {
            return Ok(());
        }
        let cmd = line.trim();
        if cmd == "NOOP" {
            continue;
        }
        if let Some(target_host_id) = cmd.strip_prefix("USE ") {
            // Strict tenant check before bridging to local host service
            if target_host_id.trim() != host_id {
                return Err("tenant mismatch on prewarmed data stream".to_string());
            }
            break;
        }
    }

    let mut local = TcpStream::connect(("127.0.0.1", local_port))
        .await
        .map_err(|error| error.to_string())?;
    let _ = local.set_nodelay(true);
    let buffered = buf_remote.buffer().to_vec();
    let mut remote = buf_remote.into_inner();
    if !buffered.is_empty() {
        local
            .write_all(&buffered)
            .await
            .map_err(|error| error.to_string())?;
    }
    let _ = tokio::io::copy_bidirectional(&mut remote, &mut local).await;
    Ok(())
}

async fn open_v2_data_path(
    host: String,
    port: u16,
    host_id: String,
    token: String,
    id: String,
    local_port: u16,
) -> Result<(), String> {
    let mut local = TcpStream::connect(("127.0.0.1", local_port))
        .await
        .map_err(|error| error.to_string())?;
    let _ = local.set_nodelay(true);
    let mut remote = connect_to_relay_host(&host, port).await?;
    remote
        .write_all(format!("DIMO-DATA v2 {host_id} {token} {id}\n").as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    remote.flush().await.map_err(|error| error.to_string())?;
    let _ = tokio::io::copy_bidirectional(&mut remote, &mut local).await;
    Ok(())
}

async fn open_data_path(
    host: String,
    port: u16,
    token: String,
    id: String,
    local_port: u16,
) -> Result<(), String> {
    let mut local = TcpStream::connect(("127.0.0.1", local_port))
        .await
        .map_err(|error| error.to_string())?;
    let _ = local.set_nodelay(true);
    let mut remote = connect_to_relay_host(&host, port).await?;
    remote
        .write_all(format!("DIMO-DATA {token} {id}\n").as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    remote.flush().await.map_err(|error| error.to_string())?;
    let _ = tokio::io::copy_bidirectional(&mut remote, &mut local).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Arc, time::Duration};

    use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
        sync::{Mutex, mpsc},
    };

    use super::{
        MUX_CHUNK_MAX_BYTES, MuxConnMap, RELAY_REJECTION_PREFIX, RelayControlClientFrame,
        RelayControlServerFrame, RelayState, maintain_control_on_stream,
        perform_http_tunnel_upgrade, run_mux_local_bridge,
    };

    #[tokio::test]
    async fn http_tunnel_upgrade_consumes_exact_headers_and_rejects_308() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let server_task = tokio::spawn(async move {
            let mut req_buf = vec![0u8; 512];
            let n = server.read(&mut req_buf).await.expect("read req");
            let req_text = String::from_utf8_lossy(&req_buf[..n]);
            assert!(req_text.starts_with("GET /v1/tunnel HTTP/1.1\r\nHost: dimo-ai.com\r\n"));
            server
                .write_all(
                    b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: upgrade\r\n\r\nOK host-1\n",
                )
                .await
                .expect("write 101");
        });

        perform_http_tunnel_upgrade(&mut client, "dimo-ai.com")
            .await
            .expect("101 upgrade succeeds");
        server_task.await.expect("server joined");

        let mut remaining = String::new();
        client
            .read_to_string(&mut remaining)
            .await
            .expect("read trailing payload");
        assert_eq!(remaining, "OK host-1\n");

        let (mut client_308, mut server_308) = tokio::io::duplex(4096);
        tokio::spawn(async move {
            let mut req_buf = vec![0u8; 512];
            let _ = server_308.read(&mut req_buf).await;
            let _ = server_308
                .write_all(
                    b"HTTP/1.1 308 Permanent Redirect\r\nLocation: https://dimo-ai.com/v1/tunnel\r\n\r\n",
                )
                .await;
        });
        let err = perform_http_tunnel_upgrade(&mut client_308, "dimo-ai.com")
            .await
            .expect_err("308 must be rejected");
        assert_eq!(
            err,
            "relay upgrade rejected: HTTP/1.1 308 Permanent Redirect"
        );
    }

    #[test]
    fn mux_control_frames_roundtrip_snake_case() {
        let open_json = r#"{"type":"mux_open","host_id":"h1","conn_id":"c1","raw_req_b64":"R0VU"}"#;
        let parsed: RelayControlServerFrame = serde_json::from_str(open_json).expect("mux_open");
        assert!(matches!(
            parsed,
            RelayControlServerFrame::MuxOpen {
                ref host_id,
                ref conn_id,
                ref raw_req_b64
            } if host_id == "h1" && conn_id == "c1" && raw_req_b64 == "R0VU"
        ));

        let data_frame = RelayControlClientFrame::MuxData {
            host_id: "h1".to_string(),
            conn_id: "c1".to_string(),
            data_b64: "aGVsbG8=".to_string(),
        };
        let encoded = serde_json::to_string(&data_frame).expect("serialize mux_data");
        assert_eq!(
            encoded,
            r#"{"type":"mux_data","host_id":"h1","conn_id":"c1","data_b64":"aGVsbG8="}"#
        );

        let close_frame = RelayControlClientFrame::MuxClose {
            host_id: "h1".to_string(),
            conn_id: "c1".to_string(),
        };
        let encoded_close = serde_json::to_string(&close_frame).expect("serialize mux_close");
        assert_eq!(
            encoded_close,
            r#"{"type":"mux_close","host_id":"h1","conn_id":"c1"}"#
        );
    }

    #[tokio::test]
    async fn mux_local_bridge_pumps_32k_chunks_and_emits_close_on_eof() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local ws server");
        let local_port = listener.local_addr().expect("local addr").port();

        let large_response = vec![b'x'; MUX_CHUNK_MAX_BYTES + 4096];
        let expected_response = large_response.clone();

        let local_server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let expected_head = b"GET /api/v1/ws HTTP/1.1\r\n\r\nping!";
            let mut head_buf = [0u8; 32];
            socket
                .read_exact(&mut head_buf)
                .await
                .expect("read upgrade and muxed client bytes");
            assert_eq!(&head_buf, expected_head);

            socket
                .write_all(&large_response)
                .await
                .expect("write large response");
            socket.shutdown().await.expect("shutdown");
        });

        let mux_conns: MuxConnMap = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::channel::<Vec<u8>>(16);
        let weak_tx = tx.downgrade();
        mux_conns
            .lock()
            .await
            .insert("conn-1".to_string(), tx.clone());

        let (ctrl_tx, mut ctrl_rx) = mpsc::unbounded_channel::<String>();
        let bridge = tokio::spawn(run_mux_local_bridge(
            local_port,
            "host-abc".to_string(),
            "conn-1".to_string(),
            b"GET /api/v1/ws HTTP/1.1\r\n\r\n".to_vec(),
            rx,
            weak_tx,
            mux_conns.clone(),
            ctrl_tx,
        ));

        tx.send(b"ping!".to_vec()).await.expect("send mux data");
        drop(tx);

        bridge.await.expect("bridge completes");
        local_server.await.expect("local server completes");

        assert!(!mux_conns.lock().await.contains_key("conn-1"));

        let mut reassembled = Vec::new();
        let mut chunk_sizes = Vec::new();
        let mut saw_close = false;
        while let Ok(raw_line) = ctrl_rx.try_recv() {
            let frame: RelayControlClientFrame =
                serde_json::from_str(raw_line.trim()).expect("valid client frame");
            match frame {
                RelayControlClientFrame::MuxData {
                    host_id,
                    conn_id,
                    data_b64,
                } => {
                    assert_eq!(host_id, "host-abc");
                    assert_eq!(conn_id, "conn-1");
                    let decoded = BASE64.decode(data_b64).expect("valid b64");
                    assert!(decoded.len() <= MUX_CHUNK_MAX_BYTES);
                    chunk_sizes.push(decoded.len());
                    reassembled.extend_from_slice(&decoded);
                }
                RelayControlClientFrame::MuxClose { host_id, conn_id } => {
                    assert_eq!(host_id, "host-abc");
                    assert_eq!(conn_id, "conn-1");
                    saw_close = true;
                }
                other => panic!("unexpected frame: {other:?}"),
            }
        }
        assert!(
            chunk_sizes.len() >= 2,
            "expected >32KiB response to split across >=2 chunks, got {chunk_sizes:?}"
        );
        assert_eq!(reassembled, expected_response);
        assert!(saw_close, "expected MuxClose after local EOF");
    }

    #[tokio::test]
    async fn control_handshake_rejection_never_marks_connected() {
        let (client, server) = tokio::io::duplex(4096);
        let (server_read, mut server_write) = tokio::io::split(server);
        let server_task = tokio::spawn(async move {
            let mut lines = BufReader::new(server_read).lines();
            let handshake = lines.next_line().await.expect("read").expect("line");
            assert!(handshake.starts_with("DIMO-CTRL v2 host-test tok-1 "));
            server_write
                .write_all(b"ERR lease_expired\n")
                .await
                .expect("write err");
            server_write.flush().await.expect("flush");
        });

        let state = Arc::new(Mutex::new(RelayState {
            status: "connecting".to_string(),
            error: None,
            connected_key: None,
        }));
        let result = maintain_control_on_stream(
            client,
            "127.0.0.1",
            17891,
            "tok-1",
            "host-test",
            17891,
            "key-1",
            &state,
            Duration::from_secs(2),
            Duration::from_secs(5),
            false,
        )
        .await;

        server_task.await.expect("server completes");
        let err = result.expect_err("handshake rejection must return error");
        assert!(err.starts_with(RELAY_REJECTION_PREFIX), "got {err}");
        assert!(err.contains("lease_expired"), "got {err}");
        assert_eq!(state.lock().await.status, "connecting");
    }

    #[tokio::test]
    async fn control_idle_watchdog_times_out_silent_stream() {
        let (client, server) = tokio::io::duplex(4096);
        let (server_read, mut server_write) = tokio::io::split(server);
        let server_task = tokio::spawn(async move {
            let mut lines = BufReader::new(server_read).lines();
            let _ = lines.next_line().await.expect("read").expect("line");
            server_write
                .write_all(b"OK host-test\n")
                .await
                .expect("write ok");
            server_write.flush().await.expect("flush");
            // Keep both halves alive without sending any further frames.
            tokio::time::sleep(Duration::from_secs(2)).await;
            drop(lines);
        });

        let state = Arc::new(Mutex::new(RelayState {
            status: "connecting".to_string(),
            error: None,
            connected_key: None,
        }));
        let err = tokio::time::timeout(
            Duration::from_secs(2),
            maintain_control_on_stream(
                client,
                "127.0.0.1",
                17891,
                "tok-1",
                "host-test",
                17891,
                "key-1",
                &state,
                Duration::from_secs(2),
                Duration::from_millis(120),
                false,
            ),
        )
        .await
        .expect("must not hang")
        .expect_err("idle stream must time out");

        assert_eq!(err, "tunnel control heartbeat timed out");
        assert_eq!(state.lock().await.status, "connected");
        server_task.abort();
    }

    #[tokio::test]
    async fn control_writer_failure_aborts_read_loop() {
        struct FailAfterHandshakeStream {
            inner: tokio::io::DuplexStream,
            writes_seen: usize,
        }
        impl tokio::io::AsyncRead for FailAfterHandshakeStream {
            fn poll_read(
                mut self: std::pin::Pin<&mut Self>,
                cx: &mut std::task::Context<'_>,
                buf: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
            }
        }
        impl tokio::io::AsyncWrite for FailAfterHandshakeStream {
            fn poll_write(
                mut self: std::pin::Pin<&mut Self>,
                cx: &mut std::task::Context<'_>,
                buf: &[u8],
            ) -> std::task::Poll<std::io::Result<usize>> {
                self.writes_seen += 1;
                if self.writes_seen > 1 {
                    return std::task::Poll::Ready(Err(std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "simulated write error",
                    )));
                }
                std::pin::Pin::new(&mut self.inner).poll_write(cx, buf)
            }
            fn poll_flush(
                mut self: std::pin::Pin<&mut Self>,
                cx: &mut std::task::Context<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                std::pin::Pin::new(&mut self.inner).poll_flush(cx)
            }
            fn poll_shutdown(
                mut self: std::pin::Pin<&mut Self>,
                cx: &mut std::task::Context<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
            }
        }

        let (client, server) = tokio::io::duplex(4096);
        let (server_read, mut server_write) = tokio::io::split(server);
        let server_task = tokio::spawn(async move {
            let mut lines = BufReader::new(server_read).lines();
            let _ = lines.next_line().await.expect("read").expect("line");
            server_write
                .write_all(b"OK host-test\n{\"type\":\"ping\",\"ts\":42}\n")
                .await
                .expect("write ok and ping");
            server_write.flush().await.expect("flush");
            tokio::time::sleep(Duration::from_secs(5)).await;
            drop(lines);
        });

        let state = Arc::new(Mutex::new(RelayState {
            status: "connecting".to_string(),
            error: None,
            connected_key: None,
        }));
        let err = tokio::time::timeout(
            Duration::from_secs(2),
            maintain_control_on_stream(
                FailAfterHandshakeStream {
                    inner: client,
                    writes_seen: 0,
                },
                "127.0.0.1",
                17891,
                "tok-1",
                "host-test",
                17891,
                "key-1",
                &state,
                Duration::from_secs(2),
                Duration::from_secs(30),
                false,
            ),
        )
        .await
        .expect("writer error must abort loop before idle timeout")
        .expect_err("writer failure must return error");

        assert!(
            err.contains("tunnel control write failed")
                || err.contains("tunnel control flush failed"),
            "unexpected error: {err}"
        );
        server_task.abort();
    }
}
