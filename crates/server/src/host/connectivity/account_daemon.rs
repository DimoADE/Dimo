//! Host-level Dimo account binding, background presence heartbeat, autonomous official
//! relay lease renewal, and headless CLI commands (`login`, `logout`, `status`, `tunnel`).
//!
//! Runs identically for both `dimo-server --desktop` and standalone headless `dimo-server serve`.

use std::{
    path::Path,
    process::ExitCode,
    sync::LazyLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use remote_protocol::ReachabilityOrigin;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::{Notify, RwLock};

use super::{custom_public, grant_verifier};
use crate::desktop::host_tunnel::{self, AccountRelayLease};

const FRONTEND_SECTION: &str = "frontend";
const HOST_ACCOUNT_TOKEN_KEY: &str = "__account_token_v1";
const HOST_ACCOUNT_OWNER_KEY: &str = "__account_owner_v1";
const HOST_SAME_ACCOUNT_AUTO_CONNECT_KEY: &str = "__same_account_auto_connect_v1";

const PRESENCE_INTERVAL: Duration = Duration::from_secs(60);
const LEASE_RENEW_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const LEASE_MIN_REMAINING_SECONDS: i64 = 900;
const KEYS_REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundHostAccount {
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default = "default_auto_connect")]
    pub auto_connect: bool,
}

fn default_auto_connect() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverviewUser {
    id: Option<Value>,
    username: String,
    #[serde(default)]
    display_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverviewResponse {
    user: OverviewUser,
    #[serde(default)]
    relay_permission: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayLeaseApiResponse {
    lease_token: String,
    expires_at: i64,
    relay_host: String,
    relay_port: u16,
    tenant_origin: String,
    host_id: String,
    lease_version: i64,
    #[serde(default)]
    server_id: Option<String>,
    #[serde(default)]
    server_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceLoginStartResponse {
    request_id: String,
    verifier: String,
    user_code: String,
    verify_url: String,
    #[serde(default = "default_login_expires")]
    expires_in: u64,
    #[serde(default = "default_login_interval")]
    interval: u64,
}

fn default_login_expires() -> u64 {
    600
}

fn default_login_interval() -> u64 {
    2
}

#[derive(Debug, Clone, Deserialize)]
struct DeviceLoginPollResponse {
    status: String,
    #[serde(default)]
    token: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct CachedAccountState {
    token_fingerprint: Option<String>,
    user_id: Option<String>,
    username: Option<String>,
    display_name: Option<String>,
    relay_permission: bool,
    last_lease_sync_unix: i64,
    last_keys_sync_unix: i64,
}

static ACCOUNT_CACHE: LazyLock<RwLock<CachedAccountState>> =
    LazyLock::new(|| RwLock::new(CachedAccountState::default()));
static SYNC_TRIGGER: LazyLock<Notify> = LazyLock::new(Notify::new);

pub fn notify_connectivity_changed() {
    SYNC_TRIGGER.notify_one();
}

fn token_fingerprint(token: &str) -> String {
    use ring::digest::{SHA256, digest};
    let hash = digest(&SHA256, token.as_bytes());
    let mut out = String::with_capacity(hash.as_ref().len() * 2);
    for byte in hash.as_ref() {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn value_id_to_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(raw) => {
            let trimmed = raw.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_owned())
        }
        Value::Number(num) => Some(num.to_string()),
        _ => None,
    }
}

pub async fn read_bound_account_at(settings_path: &Path) -> BoundHostAccount {
    let frontend: Map<String, Value> =
        services::services::settings_store::read_section(settings_path, FRONTEND_SECTION)
            .await
            .ok()
            .flatten()
            .unwrap_or_default();

    let token = match frontend.get(HOST_ACCOUNT_TOKEN_KEY) {
        Some(Value::String(raw)) => Some(raw.trim().to_owned()),
        Some(Value::Object(obj)) => obj
            .get("token")
            .and_then(Value::as_str)
            .map(|v| v.trim().to_owned()),
        _ => None,
    }
    .filter(|t| !t.is_empty());

    let owner_obj = frontend.get(HOST_ACCOUNT_OWNER_KEY).and_then(Value::as_object);
    let user_id = owner_obj.and_then(|o| value_id_to_string(o.get("userId").or_else(|| o.get("id"))));
    let username = owner_obj
        .and_then(|o| o.get("username"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned);
    let display_name = owner_obj
        .and_then(|o| o.get("displayName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned);

    let auto_connect = match frontend.get(HOST_SAME_ACCOUNT_AUTO_CONNECT_KEY) {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(raw)) => !raw.trim().eq_ignore_ascii_case("false"),
        _ => true,
    };

    BoundHostAccount {
        token,
        user_id,
        username,
        display_name,
        auto_connect,
    }
}

pub async fn read_bound_account() -> BoundHostAccount {
    let mut bound = read_bound_account_at(&utils::assets::settings_path()).await;
    if let Some(token) = bound.token.as_deref() {
        if bound.user_id.is_none() {
            let fp = token_fingerprint(token);
            let cached = ACCOUNT_CACHE.read().await;
            if cached.token_fingerprint.as_deref() == Some(fp.as_str()) && cached.user_id.is_some()
            {
                bound.user_id = cached.user_id.clone();
                if bound.username.is_none() {
                    bound.username = cached.username.clone();
                }
                if bound.display_name.is_none() {
                    bound.display_name = cached.display_name.clone();
                }
            }
        }
    } else {
        let mut cached = ACCOUNT_CACHE.write().await;
        if cached.token_fingerprint.is_some() || cached.user_id.is_some() {
            cached.token_fingerprint = None;
            cached.user_id = None;
            cached.username = None;
            cached.display_name = None;
            cached.relay_permission = false;
            cached.last_lease_sync_unix = 0;
        }
    }
    bound
}

pub async fn write_bound_account_at(
    settings_path: &Path,
    token: Option<&str>,
    user_id: Option<&str>,
    username: Option<&str>,
    display_name: Option<&str>,
) -> Result<(), String> {
    let mut frontend: Map<String, Value> =
        services::services::settings_store::read_section(settings_path, FRONTEND_SECTION)
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_default();

    match token.map(str::trim).filter(|t| !t.is_empty()) {
        Some(tok) => {
            frontend.insert(
                HOST_ACCOUNT_TOKEN_KEY.to_string(),
                Value::String(tok.to_owned()),
            );
            if let Some(uname) = username.map(str::trim).filter(|v| !v.is_empty()) {
                let mut owner = Map::new();
                if let Some(uid) = user_id.map(str::trim).filter(|v| !v.is_empty()) {
                    owner.insert("userId".to_string(), Value::String(uid.to_owned()));
                }
                owner.insert("username".to_string(), Value::String(uname.to_owned()));
                owner.insert(
                    "displayName".to_string(),
                    Value::String(
                        display_name
                            .map(str::trim)
                            .filter(|v| !v.is_empty())
                            .unwrap_or(uname)
                            .to_owned(),
                    ),
                );
                frontend.insert(HOST_ACCOUNT_OWNER_KEY.to_string(), Value::Object(owner));
            }
        }
        None => {
            frontend.remove(HOST_ACCOUNT_TOKEN_KEY);
            frontend.remove(HOST_ACCOUNT_OWNER_KEY);
        }
    }

    services::services::settings_store::write_section(settings_path, FRONTEND_SECTION, &frontend)
        .await
        .map_err(|e| e.to_string())
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .unwrap_or_default()
}

async fn fetch_overview(client: &reqwest::Client, token: &str) -> Result<OverviewResponse, String> {
    let origin = utils::site_origin();
    let resp = client
        .get(format!("{origin}/api/modelrouter/desktop"))
        .bearer_auth(token)
        .header("user-agent", "Dimo")
        .send()
        .await
        .map_err(|e| format!("account overview request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("account overview returned HTTP {}", resp.status().as_u16()));
    }
    resp.json::<OverviewResponse>()
        .await
        .map_err(|e| format!("invalid account overview response: {e}"))
}

async fn request_relay_lease(
    client: &reqwest::Client,
    token: &str,
    host_id: &str,
    host_name: &str,
) -> Result<AccountRelayLease, String> {
    let origin = utils::site_origin();
    let resp = client
        .post(format!("{origin}/api/account/relay/lease"))
        .bearer_auth(token)
        .header("user-agent", "Dimo")
        .json(&json!({
            "hostId": host_id,
            "hostName": host_name,
            "osType": std::env::consts::OS,
            "osArch": std::env::consts::ARCH,
        }))
        .send()
        .await
        .map_err(|e| format!("relay lease request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("relay lease returned HTTP {}", resp.status().as_u16()));
    }
    let body: RelayLeaseApiResponse = resp
        .json()
        .await
        .map_err(|e| format!("invalid relay lease response: {e}"))?;
    Ok(AccountRelayLease {
        lease_token: body.lease_token,
        expires_at: body.expires_at,
        relay_host: body.relay_host,
        relay_port: body.relay_port,
        tenant_origin: body.tenant_origin,
        host_id: body.host_id,
        lease_version: body.lease_version,
        server_id: body.server_id,
        server_name: body.server_name,
    })
}

pub async fn collect_host_endpoints(listen_port: u16, allow_lan: bool) -> Vec<ReachabilityOrigin> {
    let lan_addresses = if allow_lan {
        utils::net::advertised_http_origins(listen_port, true)
    } else {
        Vec::new()
    };
    let mut published = host_tunnel::published_origins().await;
    for origin in custom_public::custom_public_reachability().await {
        if !published.iter().any(|item| item.origin == origin.origin) {
            published.push(origin);
        }
    }
    host_tunnel::merge_host_reachability(&lan_addresses, published)
}

async fn report_presence(
    client: &reqwest::Client,
    token: &str,
    host_id: &str,
    host_kind: &str,
    app_version: &str,
    endpoints: &[ReachabilityOrigin],
    tunnel_status: &str,
) {
    let origin = utils::site_origin();
    let host_name = utils::net::local_hostname().unwrap_or_else(|| "Dimo Host".to_string());
    let official_relay_origin = endpoints
        .iter()
        .find(|item| item.kind == "official_relay")
        .map(|item| item.origin.clone());

    let encoded_host_id = url::form_urlencoded::byte_serialize(host_id.as_bytes()).collect::<String>();
    let url = format!("{origin}/api/account/hosts/{encoded_host_id}/presence");
    let body = json!({
        "hostName": host_name,
        "hostKind": host_kind,
        "osType": std::env::consts::OS,
        "osArch": std::env::consts::ARCH,
        "appVersion": app_version,
        "endpoints": endpoints,
        "officialRelayOrigin": official_relay_origin,
        "tunnelStatus": tunnel_status,
    });

    match client
        .put(&url)
        .bearer_auth(token)
        .header("user-agent", "Dimo")
        .json(&body)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => {
            tracing::debug!(
                status = resp.status().as_u16(),
                "Host directory presence heartbeat returned non-success (cloud may not yet expose endpoint)"
            );
        }
        Err(error) => {
            tracing::debug!(%error, "Host directory presence heartbeat failed");
        }
    }
}

/// Ensures the cached bound account_id is resolved for offline HostAccessGrant verification.
pub async fn ensure_bound_account_identity() -> BoundHostAccount {
    let mut bound = read_bound_account().await;
    if bound.token.is_none() || bound.user_id.is_some() {
        return bound;
    }
    if let Some(ref token) = bound.token {
        let client = http_client();
        if let Ok(overview) = fetch_overview(&client, token).await {
            let uid = value_id_to_string(overview.user.id.as_ref());
            let display = overview
                .user
                .display_name
                .clone()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| overview.user.username.clone());
            {
                let mut cache = ACCOUNT_CACHE.write().await;
                cache.user_id = uid.clone();
                cache.username = Some(overview.user.username.clone());
                cache.display_name = Some(display.clone());
                cache.relay_permission = overview.relay_permission;
            }
            let _ = write_bound_account_at(
                &utils::assets::settings_path(),
                Some(token),
                uid.as_deref(),
                Some(&overview.user.username),
                Some(&display),
            )
            .await;
            bound.user_id = uid;
            bound.username = Some(overview.user.username);
            bound.display_name = Some(display);
        }
    }
    bound
}

/// Spawns the unified Host connectivity daemon for BOTH `--desktop` and headless `dimo-server`.
///
/// Responsibilities:
/// 1. Keeps `host_tunnel` synchronized even when running headless (without `web_service`).
/// 2. Refreshes `GET /api/auth/host-grant-keys` periodically for offline Ed25519 grant verification.
/// 3. Autonomously renews `/api/account/relay/lease` when signed in with relay permission.
/// 4. Sends `PUT /api/account/hosts/{hostId}/presence` heartbeats with live multi-path endpoints.
pub fn spawn_host_connectivity_daemon(
    host_id: String,
    listen_port: u16,
    allow_lan: bool,
    is_desktop: bool,
    app_version: String,
) -> tokio::task::JoinHandle<()> {
    let host_kind = if is_desktop { "desktop" } else { "headless" }.to_string();
    tokio::spawn(async move {
        if !is_desktop {
            host_tunnel::set_headless_listen_port(Some(listen_port));
            host_tunnel::sync_relay().await;
        }
        // Always register custom_public_origins for browser CORS & reachability on startup.
        host_tunnel::refresh_published_reachability().await;

        let client = http_client();
        let mut ticker = tokio::time::interval(PRESENCE_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            let now = now_unix();
            let bound = read_bound_account().await;

            // Refresh Ed25519 grant signing keys periodically (even if offline-first, best effort).
            let should_refresh_keys = {
                let cache = ACCOUNT_CACHE.read().await;
                now - cache.last_keys_sync_unix >= KEYS_REFRESH_INTERVAL.as_secs() as i64
            };
            if should_refresh_keys && grant_verifier::refresh_grant_keys_from_site().await.is_ok() {
                ACCOUNT_CACHE.write().await.last_keys_sync_unix = now;
            }

            if let Some(token) = bound.token.as_deref() {
                let fp = token_fingerprint(token);
                let need_overview_or_lease = {
                    let cache = ACCOUNT_CACHE.read().await;
                    cache.token_fingerprint.as_deref() != Some(fp.as_str())
                        || cache.user_id.is_none()
                        || now - cache.last_lease_sync_unix >= LEASE_RENEW_INTERVAL.as_secs() as i64
                        || host_tunnel::account_lease_remaining_seconds().await
                            .is_some_and(|rem| rem < LEASE_MIN_REMAINING_SECONDS)
                };

                if need_overview_or_lease {
                    match fetch_overview(&client, token).await {
                        Ok(overview) => {
                            let uid = value_id_to_string(overview.user.id.as_ref());
                            let display = overview
                                .user
                                .display_name
                                .clone()
                                .filter(|v| !v.trim().is_empty())
                                .unwrap_or_else(|| overview.user.username.clone());
                            {
                                let mut cache = ACCOUNT_CACHE.write().await;
                                cache.token_fingerprint = Some(fp.clone());
                                cache.user_id = uid.clone();
                                cache.username = Some(overview.user.username.clone());
                                cache.display_name = Some(display.clone());
                                cache.relay_permission = overview.relay_permission;
                                cache.last_lease_sync_unix = now;
                            }
                            let _ = write_bound_account_at(
                                &utils::assets::settings_path(),
                                Some(token),
                                uid.as_deref(),
                                Some(&overview.user.username),
                                Some(&display),
                            )
                            .await;

                            if overview.relay_permission {
                                let host_name = utils::net::local_hostname()
                                    .unwrap_or_else(|| "Dimo Host".to_string());
                                if let Ok(lease) =
                                    request_relay_lease(&client, token, &host_id, &host_name).await
                                {
                                    let _ = host_tunnel::set_account_relay_lease(Some(lease)).await;
                                }
                            }
                        }
                        Err(error) => {
                            tracing::debug!(%error, "Host account overview refresh skipped");
                        }
                    }
                }

                // Determine active listen port and LAN visibility (desktop reads web_service runtime).
                // In desktop mode, skip cloud presence reporting while the remote web service is stopped
                // so a stopped Desktop Host never advertises unreachable endpoints or appears online.
                let active_listener = if is_desktop {
                    crate::desktop::web_service::listening_endpoint().await
                } else {
                    Some((listen_port, allow_lan))
                };
                if let Some((active_port, effective_allow_lan)) = active_listener {
                    let endpoints = collect_host_endpoints(active_port, effective_allow_lan).await;
                    let tunnel_status = host_tunnel::current_relay_status().await;

                    report_presence(
                        &client,
                        token,
                        &host_id,
                        &host_kind,
                        &app_version,
                        &endpoints,
                        &tunnel_status,
                    )
                    .await;
                }
            } else {
                let mut cache = ACCOUNT_CACHE.write().await;
                if cache.token_fingerprint.is_some() || cache.user_id.is_some() {
                    cache.token_fingerprint = None;
                    cache.user_id = None;
                    cache.username = None;
                    cache.display_name = None;
                    cache.relay_permission = false;
                    cache.last_lease_sync_unix = 0;
                }
            }

            tokio::select! {
                _ = ticker.tick() => {}
                _ = SYNC_TRIGGER.notified() => {}
            }
        }
    })
}

/// Interactive CLI login for standalone headless `dimo-server login`.
pub async fn run_login_command() -> ExitCode {
    let data_dir = utils::assets::host_data_dir();
    let host_id = match utils::assets::load_or_create_local_host_id(&data_dir) {
        Ok(id) => id,
        Err(error) => {
            eprintln!("Failed to resolve Host ID: {error}");
            return ExitCode::from(1);
        }
    };
    let host_name = utils::net::local_hostname().unwrap_or_else(|| "Dimo Server".to_string());
    let origin = utils::site_origin();
    let client = http_client();

    let start_resp = match client
        .post(format!("{origin}/api/auth/desktop/start"))
        .header("user-agent", "Dimo")
        .json(&json!({
            "deviceName": host_name,
            "hostId": host_id,
            "nextPath": "/account",
        }))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => match resp.json::<DeviceLoginStartResponse>().await {
            Ok(parsed) => parsed,
            Err(error) => {
                eprintln!("Invalid login response from {origin}: {error}");
                return ExitCode::from(1);
            }
        },
        Ok(resp) => {
            eprintln!("Login start failed with HTTP {}", resp.status().as_u16());
            return ExitCode::from(1);
        }
        Err(error) => {
            eprintln!("Could not reach {origin}: {error}");
            return ExitCode::from(1);
        }
    };

    println!("Sign in to Dimo Account to bind this Host ({host_id})");
    println!("  Open: {}", start_resp.verify_url);
    println!("  Code: {}", start_resp.user_code);
    println!("Waiting for approval...");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(start_resp.expires_in.max(60));
    let interval = Duration::from_secs(start_resp.interval.clamp(2, 10));

    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(interval).await;
        let poll = match client
            .post(format!("{origin}/api/auth/desktop/token"))
            .header("user-agent", "Dimo")
            .json(&json!({
                "requestId": start_resp.request_id,
                "verifier": start_resp.verifier,
            }))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => resp.json::<DeviceLoginPollResponse>().await.ok(),
            _ => None,
        };
        let Some(poll) = poll else {
            continue;
        };
        if poll.status == "approved"
            && let Some(token) = poll.token
        {
            let overview = match fetch_overview(&client, &token).await {
                Ok(ov) => ov,
                Err(error) => {
                    eprintln!("Signed in, but failed to load account profile: {error}");
                    return ExitCode::from(1);
                }
            };
            let uid = value_id_to_string(overview.user.id.as_ref());
            let display = overview
                .user
                .display_name
                .clone()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| overview.user.username.clone());

            if let Err(error) = write_bound_account_at(
                &utils::assets::settings_path(),
                Some(&token),
                uid.as_deref(),
                Some(&overview.user.username),
                Some(&display),
            )
            .await
            {
                eprintln!("Failed to persist Host account binding: {error}");
                return ExitCode::from(1);
            }

            if overview.relay_permission
                && let Ok(lease) =
                    request_relay_lease(&client, &token, &host_id, &host_name).await
            {
                let _ = host_tunnel::set_account_relay_lease(Some(lease)).await;
            }
            let _ = grant_verifier::refresh_grant_keys_from_site().await;
            println!("Signed in as {display} (@{}).", overview.user.username);
            if overview.relay_permission {
                println!("Official Cloud Relay lease provisioned. Start or restart `dimo-server serve` to bring this Host online.");
            }
            return ExitCode::SUCCESS;
        }
        if poll.status != "pending" {
            eprintln!("Login failed: {}", poll.status);
            return ExitCode::from(1);
        }
    }

    eprintln!("Login timed out.");
    ExitCode::from(1)
}

pub async fn run_logout_command() -> ExitCode {
    let data_dir = utils::assets::host_data_dir();
    let host_id = utils::assets::load_or_create_local_host_id(&data_dir).ok();
    let bound = read_bound_account_at(&utils::assets::settings_path()).await;

    let _ = write_bound_account_at(&utils::assets::settings_path(), None, None, None, None).await;
    let _ = host_tunnel::set_account_relay_lease(None).await;

    if let Ok(db) = db::DBService::new_at(&data_dir).await {
        let auth = crate::SqliteServerAuth::new(db.pool);
        let _ = auth
            .revoke_account_linked_devices(&crate::AuthenticatedCredential::host_console_owner())
            .await;
    }

    if let Some(token) = bound.token.as_deref() {
        let origin = utils::site_origin();
        let client = http_client();
        if let Some(host_id) = host_id.as_deref() {
            let encoded = url::form_urlencoded::byte_serialize(host_id.as_bytes()).collect::<String>();
            let _ = client
                .delete(format!("{origin}/api/account/hosts/{encoded}"))
                .bearer_auth(token)
                .header("user-agent", "Dimo")
                .send()
                .await;
        }
        let _ = client
            .post(format!("{origin}/api/auth/logout"))
            .bearer_auth(token)
            .header("user-agent", "Dimo")
            .send()
            .await;
    }

    println!("Signed out this Host from Dimo account and revoked account-linked devices.");
    ExitCode::SUCCESS
}

pub async fn run_status_command() -> ExitCode {
    let data_dir = utils::assets::host_data_dir();
    let host_id = utils::assets::load_or_create_local_host_id(&data_dir)
        .unwrap_or_else(|_| "(unknown)".to_string());
    let bound = read_bound_account_at(&utils::assets::settings_path()).await;
    let custom = custom_public::list_custom_public_origins().await;
    let published = host_tunnel::published_origins().await;

    println!("Host ID   {host_id}");
    match bound.username.as_deref() {
        Some(uname) => println!(
            "Account   {} (@{})",
            bound.display_name.as_deref().unwrap_or(uname),
            uname
        ),
        None if bound.token.is_some() => println!("Account   signed in (pending profile sync)"),
        None => println!("Account   not signed in (guest / self-hosted mode)"),
    }
    println!("Custom public URLs ({}):", custom.len());
    for item in &custom {
        if let Some(label) = item.label.as_deref() {
            println!("  - {} ({label}) [id={}]", item.origin, item.id);
        } else {
            println!("  - {} [id={}]", item.origin, item.id);
        }
    }
    println!("Published tunnel endpoints ({}):", published.len());
    for item in &published {
        println!("  - {} ({})", item.origin, item.kind);
    }
    ExitCode::SUCCESS
}

pub async fn run_tunnel_add_url_command(
    url: String,
    label: Option<String>,
    skip_probe: bool,
) -> ExitCode {
    let data_dir = utils::assets::host_data_dir();
    let host_id = utils::assets::load_or_create_local_host_id(&data_dir).ok();
    match custom_public::add_custom_public_origin(&url, label, host_id.as_deref(), skip_probe).await
    {
        Ok((record, check)) => {
            println!("Saved custom public origin: {} [id={}]", record.origin, record.id);
            if let Some(warning) = check.and_then(|c| c.warning) {
                eprintln!("Warning: {warning}");
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}

pub async fn run_tunnel_remove_url_command(id_or_url: String) -> ExitCode {
    match custom_public::remove_custom_public_origin(&id_or_url).await {
        Ok(_) => {
            println!("Removed custom public origin: {id_or_url}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}
