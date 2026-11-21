use std::sync::Arc;

use deployment::Deployment;
use axum::{
    Json, Router,
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use remote_protocol::{ErrorCode, ErrorEnvelope, OperationId};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    DesktopRuntimeState, PluginDevConnection, backup, browser_bridge, crash_reports,
    error::DesktopError,
    host_client::{
        self, ConnectHostRequest, HOST_CLIENT_CHANGED, advertised_connect_origin,
        sync::SyncableHostProfile,
    },
    host_tunnel::{self, AccountRelayLease},
    launcher::{self, OpenEditorRequest},
    remote_desktop::{HostFamilyEventEmitter, RemoteDesktopProfileInput, RemoteEventSink},
    web_service::{
        self, CreateHostPairingRequest, RespondHostConnectRequest, RevokeHostDeviceRequest,
        WebServiceConfig,
    },
};

const WINDOW_LABEL_HEADER: &str = "x-dimo-window-label";
const HOST_UPDATE_UNREACHABLE: &str = "host_update_unreachable";
const REMOTE_HOST_EVENT_CHANNEL: &str = "dimo://remote-host-event";
const REMOTE_SUBSCRIPTION_EVENT_CHANNEL: &str = "dimo://remote-subscription-event";

pub fn desktop_router(state: DesktopRuntimeState) -> Router {
    Router::new()
        .route("/health", get(desktop_health))
        .route("/shutdown", post(desktop_shutdown))
        .route("/window-destroyed", post(window_destroyed))
        .route("/plugin-dev-connection", get(plugin_dev_connection))
        .route("/browser-bridge", get(browser_bridge::ws_browser_bridge))
        .route("/invoke/{command}", post(invoke_desktop_command))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_desktop_token,
        ))
        .with_state(state)
}

async fn require_desktop_token(
    State(state): State<DesktopRuntimeState>,
    request: Request,
    next: Next,
) -> Response {
    // Reject requests routed through reverse proxies or non-loopback Host headers.
    if request.headers().contains_key("x-forwarded-for")
        || request.headers().contains_key("x-real-ip")
    {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorEnvelope::new(
                ErrorCode::Forbidden,
                "desktop control endpoints are loopback-only",
                false,
                OperationId::new(),
            )),
        )
            .into_response();
    }
    if let Some(host) = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    {
        let host_only = strip_host_port(host.trim());
        if !is_loopback_host(host_only) {
            return (
                StatusCode::FORBIDDEN,
                Json(ErrorEnvelope::new(
                    ErrorCode::Forbidden,
                    "desktop control endpoints require a loopback host",
                    false,
                    OperationId::new(),
                )),
            )
                .into_response();
        }
    }

    let is_ws_upgrade = request
        .headers()
        .get(header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));

    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(extract_bearer_token)
        .or_else(|| {
            is_ws_upgrade
                .then(|| {
                    request
                        .headers()
                        .get(header::SEC_WEBSOCKET_PROTOCOL)
                        .and_then(|value| value.to_str().ok())
                        .and_then(extract_ws_protocol_token)
                })
                .flatten()
        });
    if token.is_some_and(|candidate| state.token_digest.verifies(candidate)) {
        return next.run(request).await;
    }

    (
        StatusCode::UNAUTHORIZED,
        Json(ErrorEnvelope::new(
            ErrorCode::Unauthorized,
            "invalid or missing desktop bearer token",
            false,
            OperationId::new(),
        )),
    )
        .into_response()
}

fn extract_bearer_token(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    let rest = trimmed
        .strip_prefix("Bearer ")
        .or_else(|| trimmed.strip_prefix("bearer "))
        .or_else(|| trimmed.strip_prefix("BEARER "))?;
    let token = rest.trim();
    (!token.is_empty()).then_some(token)
}

fn extract_ws_protocol_token(value: &str) -> Option<&str> {
    value
        .split(',')
        .map(str::trim)
        .find_map(|item| item.strip_prefix("dimo-token."))
        .filter(|token| !token.is_empty())
}

fn strip_host_port(host: &str) -> &str {
    if let Some(rest) = host.strip_prefix('[')
        && let Some((ipv6, _)) = rest.split_once(']')
    {
        return ipv6;
    }
    host.rsplit_once(':')
        .filter(|(h, port)| !h.contains(':') && port.parse::<u16>().is_ok())
        .map_or(host, |(h, _)| h)
}

fn is_loopback_host(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    lower == "localhost"
        || lower
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

async fn desktop_health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "desktop_mode": true,
        "pid": std::process::id(),
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn desktop_shutdown(State(state): State<DesktopRuntimeState>) -> Json<Value> {
    state.shutdown.notify_one();
    Json(json!({ "ok": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowDestroyedRequest {
    label: String,
    #[serde(default)]
    window_still_open: bool,
}

async fn window_destroyed(
    State(state): State<DesktopRuntimeState>,
    Json(body): Json<WindowDestroyedRequest>,
) -> Json<Value> {
    host_client::runtime()
        .drop_binding_for_destroyed_window(
            &state.remote_desktop,
            &body.label,
            body.window_still_open,
        )
        .await;
    state.events.emit(HOST_CLIENT_CHANGED, ());
    Json(json!({ "ok": true }))
}

async fn plugin_dev_connection() -> Json<PluginDevConnection> {
    Json(PluginDevConnection::current())
}

fn window_label(headers: &HeaderMap) -> String {
    headers
        .get(WINDOW_LABEL_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("main")
        .to_string()
}

fn parse_args<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, DesktopError> {
    serde_json::from_value(value)
        .map_err(|error| DesktopError::BadRequest(format!("invalid command arguments: {error}")))
}

fn to_json<T: serde::Serialize>(value: T) -> Result<Value, DesktopError> {
    serde_json::to_value(value).map_err(DesktopError::from)
}

async fn local_host_id() -> Option<String> {
    tokio::task::spawn_blocking(|| {
        utils::assets::load_or_create_host_id(&utils::assets::asset_dir()).ok()
    })
    .await
    .ok()
    .flatten()
}

fn map_host_update_error(error: DesktopError) -> DesktopError {
    match &error {
        DesktopError::BadRequest(message)
            if message == HOST_UPDATE_UNREACHABLE || message.contains("could not reach Host") =>
        {
            DesktopError::BadRequest(HOST_UPDATE_UNREACHABLE.to_string())
        }
        _ => error,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OptionsArg<T> {
    options: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PayloadArg<T> {
    payload: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestArg<T> {
    request: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigArg {
    config: WebServiceConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortArg {
    port: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnabledArg {
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddressArg {
    address: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OptionalIdArg {
    #[serde(default)]
    id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdArg {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseArg {
    #[serde(default)]
    lease: Option<AccountRelayLease>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupCancelArg {
    #[serde(default)]
    op_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteConnectArg {
    profile: RemoteDesktopProfileInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteProfileIdArg {
    profile_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCallArg {
    profile_id: String,
    command: String,
    args: Value,
    #[serde(default)]
    operation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteListenArg {
    profile_id: String,
    event: String,
    #[serde(default)]
    subscription_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSubscribeArg {
    profile_id: String,
    request: Value,
    #[serde(default)]
    subscription_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionIdArg {
    subscription_id: String,
}

#[derive(Deserialize)]
struct ProfileIdPayload {
    #[serde(alias = "profileId")]
    profile_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetSyncAccountPayload {
    #[serde(default)]
    account_user_id: Option<String>,
    #[serde(default)]
    legacy_account_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportSyncPayload {
    account_user_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeSyncPayload {
    account_user_id: String,
    #[serde(default)]
    profiles: Vec<SyncableHostProfile>,
    #[serde(default)]
    authoritative: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkSyncPushedPayload {
    account_user_id: String,
    #[serde(default)]
    profile_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AckSyncDeletesPayload {
    #[serde(default)]
    delete_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenProjectInEditorArg {
    id: uuid::Uuid,
    #[serde(default)]
    payload: Option<OpenEditorRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenRepoInEditorArg {
    #[serde(alias = "repo_id")]
    repo_id: uuid::Uuid,
    #[serde(default)]
    payload: Option<OpenEditorRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenWorkspaceInEditorArg {
    #[serde(alias = "workspace_id")]
    workspace_id: uuid::Uuid,
    #[serde(default, alias = "editor_type")]
    editor_type: Option<String>,
    #[serde(default, alias = "file_path")]
    file_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenInEditorArg {
    path: std::path::PathBuf,
    #[serde(default, alias = "editor_type")]
    editor_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenExternalTerminalArg {
    #[serde(alias = "workspace_id")]
    workspace_id: uuid::Uuid,
    #[serde(alias = "terminal", alias = "terminal_app", alias = "terminalApp")]
    terminal_app: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordShellCrashArg {
    #[serde(default)]
    source: String,
    message: String,
    #[serde(default)]
    stack: Option<String>,
}

async fn invoke_desktop_command(
    State(state): State<DesktopRuntimeState>,
    headers: HeaderMap,
    Path(command): Path<String>,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, DesktopError> {
    let args = body.map(|Json(value)| value).unwrap_or_else(|| json!({}));
    let caller = window_label(&headers);
    let result = match command.as_str() {
        "plugin_dev_connection" => to_json(PluginDevConnection::current())?,

        // Backup
        "backup_create" => {
            let parsed: OptionsArg<backup::BackupCreateOptions> = parse_args(args)?;
            to_json(backup::backup_create(&state.events, parsed.options).await?)?
        }
        "backup_inspect" => {
            let parsed: OptionsArg<backup::BackupInspectOptions> = parse_args(args)?;
            to_json(backup::backup_inspect(parsed.options).await?)?
        }
        "backup_restore_stage" => {
            let parsed: PayloadArg<backup::BackupRestoreStagePayload> = parse_args(args)?;
            to_json(backup::backup_restore_stage(&state.events, parsed.payload).await?)?
        }
        "backup_cancel" => {
            let parsed: BackupCancelArg = parse_args(args)?;
            backup::backup_cancel(parsed.op_id).await?;
            Value::Null
        }

        // Web service & device pairing
        "get_web_service_config" => to_json(web_service::get_web_service_config().await?)?,
        "update_web_service_config" => {
            let parsed: ConfigArg = parse_args(args)?;
            to_json(
                web_service::update_web_service_config(&state.web_service, parsed.config).await?,
            )?
        }
        "get_web_server_status" => to_json(web_service::get_web_server_status().await?)?,
        "start_web_server" => to_json(web_service::start_web_server(&state.web_service).await?)?,
        "stop_web_server" => to_json(web_service::stop_web_server().await?)?,
        "probe_web_service_port" => {
            let parsed: PortArg = parse_args(args)?;
            to_json(web_service::probe_web_service_port(parsed.port).await?)?
        }
        "generate_web_service_token" => {
            to_json(web_service::generate_web_service_token(&state.web_service.pool).await?)?
        }
        "create_host_device_pairing" => {
            let parsed: RequestArg<CreateHostPairingRequest> = parse_args(args)?;
            to_json(
                web_service::create_host_device_pairing(&state.web_service.pool, parsed.request)
                    .await?,
            )?
        }
        "list_host_devices" => {
            to_json(web_service::list_host_devices(&state.web_service.pool).await?)?
        }
        "list_host_connect_requests" => {
            to_json(web_service::list_host_connect_requests(&state.web_service.pool).await?)?
        }
        "respond_host_connect_request" => {
            let parsed: RequestArg<RespondHostConnectRequest> = parse_args(args)?;
            web_service::respond_host_connect_request(&state.web_service.pool, parsed.request)
                .await?;
            Value::Null
        }
        "revoke_host_device" => {
            let parsed: RequestArg<RevokeHostDeviceRequest> = parse_args(args)?;
            to_json(
                web_service::revoke_host_device(&state.web_service.pool, parsed.request).await?,
            )?
        }
        "revoke_account_linked_devices" => {
            to_json(web_service::revoke_account_linked_devices(&state.web_service.pool).await?)?
        }

        // Host tunnel
        "get_host_tunnel" => to_json(host_tunnel::get_host_tunnel(&state.web_service).await?)?,
        "set_host_tunnel_enabled" => {
            let parsed: EnabledArg = parse_args(args)?;
            to_json(
                host_tunnel::set_host_tunnel_enabled(&state.web_service, parsed.enabled).await?,
            )?
        }
        "check_existing_host_tunnel" => {
            let parsed: AddressArg = parse_args(args)?;
            to_json(
                host_tunnel::check_existing_host_tunnel(&state.web_service, parsed.address).await?,
            )?
        }
        "select_saved_host_tunnel" => {
            let parsed: OptionalIdArg = parse_args(args)?;
            to_json(host_tunnel::select_saved_host_tunnel(parsed.id).await?)?
        }
        "start_create_host_tunnel" => {
            let parsed: AddressArg = parse_args(args)?;
            to_json(
                host_tunnel::start_create_host_tunnel(&state.web_service, parsed.address).await?,
            )?
        }
        "confirm_create_host_tunnel" => {
            to_json(host_tunnel::confirm_create_host_tunnel(&state.web_service).await?)?
        }
        "cancel_create_host_tunnel" => to_json(host_tunnel::cancel_create_host_tunnel().await?)?,
        "remove_saved_host_tunnel" => {
            let parsed: IdArg = parse_args(args)?;
            to_json(host_tunnel::remove_saved_host_tunnel(parsed.id).await?)?
        }
        "set_account_relay_lease" => {
            let parsed: LeaseArg = parse_args(args)?;
            to_json(host_tunnel::set_account_relay_lease(parsed.lease).await?)?
        }

        // Remote desktop proxy
        "remote_desktop_connect" => {
            let parsed: RemoteConnectArg = parse_args(args)?;
            state
                .remote_desktop
                .connect(
                    &caller,
                    &parsed.profile.profile_id,
                    &parsed.profile.base_url,
                    parsed.profile.token,
                )
                .await?;
            Value::Null
        }
        "remote_desktop_disconnect" => {
            let parsed: RemoteProfileIdArg = parse_args(args)?;
            state
                .remote_desktop
                .disconnect(&caller, &parsed.profile_id)
                .await;
            Value::Null
        }
        "remote_desktop_call" => {
            let parsed: RemoteCallArg = parse_args(args)?;
            let operation_id = parsed
                .operation_id
                .map(|value| OperationId::parse(&value))
                .transpose()
                .map_err(|error| {
                    DesktopError::BadRequest(format!("invalid operation id: {error}"))
                })?;
            state
                .remote_desktop
                .call(
                    &caller,
                    &parsed.profile_id,
                    &parsed.command,
                    parsed.args,
                    operation_id,
                )
                .await?
        }
        "remote_desktop_capabilities" => {
            let parsed: RemoteProfileIdArg = parse_args(args)?;
            to_json(
                state
                    .remote_desktop
                    .capabilities(&caller, &parsed.profile_id)
                    .await?,
            )?
        }
        "remote_desktop_listen" => {
            let parsed: RemoteListenArg = parse_args(args)?;
            let subscription_id = parsed
                .subscription_id
                .as_deref()
                .map(uuid::Uuid::parse_str)
                .transpose()
                .map_err(|error| {
                    DesktopError::BadRequest(format!("invalid subscription id: {error}"))
                })?
                .unwrap_or_else(uuid::Uuid::new_v4);
            let events = state.events.clone();
            let emitter: HostFamilyEventEmitter = Arc::new(move |window_label, channel, payload| {
                events.emit(
                    REMOTE_HOST_EVENT_CHANNEL,
                    json!({
                        "windowLabel": window_label,
                        "targets": super::host_windows::host_family_event_labels(window_label),
                        "channel": channel,
                        "payload": payload,
                    }),
                );
            });
            let id = state
                .remote_desktop
                .listen_host_event(
                    emitter,
                    &caller,
                    &parsed.profile_id,
                    parsed.event,
                    subscription_id,
                )
                .await?;
            Value::String(id.to_string())
        }
        "remote_desktop_subscribe" => {
            let parsed: RemoteSubscribeArg = parse_args(args)?;
            let subscription_id = parsed
                .subscription_id
                .as_deref()
                .map(uuid::Uuid::parse_str)
                .transpose()
                .map_err(|error| {
                    DesktopError::BadRequest(format!("invalid subscription id: {error}"))
                })?
                .unwrap_or_else(uuid::Uuid::new_v4);
            let events = state.events.clone();
            let sub_id_str = subscription_id.to_string();
            let sink: RemoteEventSink = Arc::new(move |event| {
                events.emit(
                    REMOTE_SUBSCRIPTION_EVENT_CHANNEL,
                    json!({
                        "subscriptionId": sub_id_str,
                        "event": event,
                    }),
                );
            });
            let id = state
                .remote_desktop
                .subscribe_events(
                    &caller,
                    &parsed.profile_id,
                    parsed.request,
                    sink,
                    subscription_id,
                )
                .await?;
            Value::String(id.to_string())
        }
        "remote_desktop_cancel_subscription" => {
            let parsed: SubscriptionIdArg = parse_args(args)?;
            let subscription_id = uuid::Uuid::parse_str(&parsed.subscription_id).map_err(|error| {
                DesktopError::BadRequest(format!("invalid subscription id: {error}"))
            })?;
            state
                .remote_desktop
                .cancel_subscription(subscription_id)
                .await;
            Value::Null
        }

        // Host client
        "host_client_status" => {
            host_client::runtime()
                .set_local_host_id(local_host_id().await)
                .await;
            to_json(
                host_client::runtime()
                    .status(&state.remote_desktop, &caller)
                    .await?,
            )?
        }
        "host_client_discover" => {
            host_client::runtime()
                .set_local_host_id(local_host_id().await)
                .await;
            to_json(host_client::runtime().discover().await?)?
        }
        "host_client_host_updates" => to_json(host_client::runtime().probe_updates().await?)?,
        "host_client_apply_host_update" => {
            let parsed: RequestArg<ProfileIdPayload> = parse_args(args)?;
            let Some(profile) = host_client::runtime()
                .profile(&parsed.request.profile_id)
                .await?
            else {
                return Err(DesktopError::NotFound(
                    "saved Host was not found".to_string(),
                ));
            };
            let origin = advertised_connect_origin(&profile.origin, profile.provision.as_ref());
            let Some(token) = host_client::runtime()
                .access_token(&parsed.request.profile_id)
                .await?
            else {
                return Err(DesktopError::BadRequest(
                    HOST_UPDATE_UNREACHABLE.to_string(),
                ));
            };
            let applied = host_client::runtime()
                .apply_host_upgrade(&origin, &token)
                .await
                .map_err(map_host_update_error)?;
            to_json(applied)?
        }
        "host_client_connect" => {
            let parsed: RequestArg<ConnectHostRequest> = parse_args(args)?;
            host_client::runtime()
                .set_local_host_id(local_host_id().await)
                .await;
            let result = host_client::runtime()
                .connect(&caller, &state.remote_desktop, parsed.request)
                .await?;
            host_client::runtime()
                .bind_saved_profile_window(&state.remote_desktop, &result.profile.id)
                .await?;
            state.events.emit(HOST_CLIENT_CHANGED, ());
            to_json(result)?
        }
        "host_client_disconnect" => {
            host_client::runtime()
                .disconnect_window(&state.remote_desktop, &caller)
                .await?;
            state.events.emit(HOST_CLIENT_CHANGED, ());
            Value::Null
        }
        "host_client_delete" => {
            let parsed: RequestArg<ProfileIdPayload> = parse_args(args)?;
            let closed_windows = host_client::runtime()
                .delete(&state.remote_desktop, &parsed.request.profile_id)
                .await?;
            state.events.emit(HOST_CLIENT_CHANGED, ());
            json!({ "closedWindows": closed_windows })
        }
        "host_client_set_sync_account" => {
            let parsed: RequestArg<SetSyncAccountPayload> = parse_args(args)?;
            host_client::runtime()
                .set_local_host_id(local_host_id().await)
                .await;
            let result = host_client::runtime()
                .set_sync_account_with_legacy(
                    &state.remote_desktop,
                    parsed.request.account_user_id.as_deref(),
                    &parsed.request.legacy_account_ids,
                )
                .await?;
            if result.changed {
                state.events.emit(HOST_CLIENT_CHANGED, ());
            }
            json!({
                "changed": result.changed,
                "closedWindows": result.closed_windows,
            })
        }
        "host_client_export_sync_profiles" => {
            let parsed: RequestArg<ExportSyncPayload> = parse_args(args)?;
            host_client::runtime()
                .set_local_host_id(local_host_id().await)
                .await;
            to_json(
                host_client::runtime()
                    .export_sync_bundle(&parsed.request.account_user_id)
                    .await?,
            )?
        }
        "host_client_merge_sync_profiles" => {
            let parsed: RequestArg<MergeSyncPayload> = parse_args(args)?;
            host_client::runtime()
                .set_local_host_id(local_host_id().await)
                .await;
            let result = host_client::runtime()
                .merge_sync_profiles(
                    &state.remote_desktop,
                    &parsed.request.account_user_id,
                    parsed.request.profiles,
                    parsed.request.authoritative,
                )
                .await?;
            if result.changed {
                state.events.emit(HOST_CLIENT_CHANGED, ());
            }
            json!({
                "changed": result.changed,
                "closedWindows": result.closed_windows,
            })
        }
        "host_client_mark_sync_pushed" => {
            let parsed: RequestArg<MarkSyncPushedPayload> = parse_args(args)?;
            host_client::runtime()
                .mark_sync_pushed(&parsed.request.account_user_id, &parsed.request.profile_ids)
                .await?;
            Value::Null
        }
        "host_client_ack_sync_deletes" => {
            let parsed: RequestArg<AckSyncDeletesPayload> = parse_args(args)?;
            host_client::runtime()
                .ack_sync_deletes(&parsed.request.delete_ids)
                .await?;
            Value::Null
        }

        // Editor & external terminal launchers
        "open_project_in_editor" => {
            let parsed: OpenProjectInEditorArg = parse_args(args)?;
            to_json(
                launcher::open_project_in_editor(&state.deployment, parsed.id, parsed.payload)
                    .await?,
            )?
        }
        "open_repo_in_editor" => {
            let parsed: OpenRepoInEditorArg = parse_args(args)?;
            to_json(
                launcher::open_repo_in_editor(&state.deployment, parsed.repo_id, parsed.payload)
                    .await?,
            )?
        }
        "open_workspace_in_editor" => {
            let parsed: OpenWorkspaceInEditorArg = parse_args(args)?;
            to_json(
                launcher::open_workspace_in_editor(
                    &state.deployment,
                    parsed.workspace_id,
                    parsed.editor_type,
                    parsed.file_path,
                )
                .await?,
            )?
        }
        "open_in_editor" => {
            let parsed: OpenInEditorArg = parse_args(args)?;
            to_json(
                launcher::open_in_editor(
                    &state.deployment,
                    &parsed.path,
                    parsed.editor_type.as_deref(),
                )
                .await?,
            )?
        }
        "open_external_terminal" => {
            let parsed: OpenExternalTerminalArg = parse_args(args)?;
            launcher::open_external_terminal(
                &state.deployment,
                parsed.workspace_id,
                parsed.terminal_app,
            )
            .await?;
            Value::Null
        }

        // Developer mode persistence (shared with Tauri settings.json system.developer_mode)
        "get_developer_mode" => {
            let enabled = tokio::task::spawn_blocking(launcher::read_developer_mode)
                .await
                .unwrap_or(false);
            Value::Bool(enabled)
        }
        "set_developer_mode" => {
            let parsed: EnabledArg = parse_args(args)?;
            let enabled = launcher::write_developer_mode(parsed.enabled).await?;
            Value::Bool(enabled)
        }

        // Desktop shell crash report recorder
        "record_shell_crash" => {
            let parsed: RecordShellCrashArg = parse_args(args)?;
            let path = tokio::task::spawn_blocking(move || {
                crash_reports::write_shell_crash_report(
                    &parsed.source,
                    &parsed.message,
                    parsed.stack.as_deref(),
                )
            })
            .await
            .map_err(|error| DesktopError::Internal(error.to_string()))?
            .map_err(|error| DesktopError::Internal(error.to_string()))?;
            let id = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_string();
            json!({ "id": id })
        }

        // Pre-update user data evacuation + SQLite WAL checkpoint
        "evacuate_user_data_before_update" => {
            crate::evacuate_user_data_before_app_update()
                .await
                .map_err(DesktopError::Internal)?;
            let pool = state.deployment.db().pool.clone();
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&pool),
            )
            .await;
            Value::Null
        }

        other => {
            return Err(DesktopError::NotFound(format!(
                "unknown desktop command: {other}"
            )));
        }
    };
    Ok(Json(result))
}
