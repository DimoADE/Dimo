//! Unified Host connectivity management HTTP routes (`/api/v1/host/connectivity/*`).
//!
//! Available identically on both `dimo-server --desktop` and standalone headless `dimo-server serve`
//! for any credential holding `device.pair` (Host owner / admin).

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use remote_protocol::{ErrorCode, ErrorEnvelope, OperationId};
use serde::Deserialize;
use serde_json::json;

use super::{account_daemon, custom_public};
use crate::{AuthenticatedCredential, desktop::host_tunnel, runtime::ServerState};

#[derive(Debug, Deserialize)]
struct CustomPublicOriginInput {
    origin: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    skip_probe: bool,
}

#[derive(Debug, Deserialize)]
struct TunnelEnabledInput {
    enabled: bool,
}

fn require_host_admin(credential: &AuthenticatedCredential) -> Option<Response> {
    if credential.grants_capability("device.pair") {
        return None;
    }
    Some(
        (
            StatusCode::FORBIDDEN,
            Json(ErrorEnvelope::new(
                ErrorCode::Forbidden,
                "credential does not grant host connectivity administration",
                false,
                OperationId::new(),
            )),
        )
            .into_response(),
    )
}

fn bad_request(message: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(ErrorEnvelope::new(
            ErrorCode::BadRequest,
            message.into(),
            false,
            OperationId::new(),
        )),
    )
        .into_response()
}

pub fn connectivity_router<R>() -> Router<Arc<ServerState<R>>>
where
    R: Send + Sync + 'static,
{
    Router::new()
        .route("/status", get(get_connectivity_status::<R>))
        .route("/custom-public/probe", post(probe_custom_public::<R>))
        .route("/custom-public", post(add_custom_public::<R>))
        .route("/custom-public/{id}", delete(remove_custom_public::<R>))
        .route("/tunnel/enabled", post(set_tunnel_enabled::<R>))
        .route("/tunnel/reconnect", post(reconnect_tunnel::<R>))
}

async fn get_connectivity_status<R>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
) -> Response
where
    R: Send + Sync + 'static,
{
    if let Some(resp) = require_host_admin(&credential) {
        return resp;
    }
    let bound = account_daemon::read_bound_account().await;
    let custom_origins = custom_public::list_custom_public_origins().await;
    let tunnel = host_tunnel::current_status_snapshot().await;
    let endpoints = account_daemon::collect_host_endpoints(
        state.config.listen_addr.port(),
        !state.config.listen_addr.ip().is_loopback(),
    )
    .await;

    Json(json!({
        "host_id": state.config.host_id,
        "host_name": utils::net::local_hostname(),
        "desktop_mode": state.config.desktop_mode,
        "account": {
            "signed_in": bound.token.is_some(),
            "user_id": bound.user_id,
            "username": bound.username,
            "display_name": bound.display_name,
            "auto_connect": bound.auto_connect,
        },
        "custom_public_origins": custom_origins,
        "tunnel": tunnel,
        "endpoints": endpoints,
    }))
    .into_response()
}

async fn probe_custom_public<R>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
    Json(input): Json<CustomPublicOriginInput>,
) -> Response
where
    R: Send + Sync + 'static,
{
    if let Some(resp) = require_host_admin(&credential) {
        return resp;
    }
    let expected_host_id = (!state.config.host_id.is_empty()).then_some(state.config.host_id.as_str());
    match custom_public::probe_custom_public_origin(&input.origin, expected_host_id).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => bad_request(error),
    }
}

async fn add_custom_public<R>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
    Json(input): Json<CustomPublicOriginInput>,
) -> Response
where
    R: Send + Sync + 'static,
{
    if let Some(resp) = require_host_admin(&credential) {
        return resp;
    }
    let expected_host_id = (!state.config.host_id.is_empty()).then_some(state.config.host_id.as_str());
    match custom_public::add_custom_public_origin(
        &input.origin,
        input.label,
        expected_host_id,
        input.skip_probe,
    )
    .await
    {
        Ok((record, check)) => {
            host_tunnel::refresh_published_reachability().await;
            account_daemon::notify_connectivity_changed();
            (
                StatusCode::CREATED,
                Json(json!({
                    "record": record,
                    "check": check,
                    "custom_public_origins": custom_public::list_custom_public_origins().await,
                })),
            )
                .into_response()
        }
        Err(error) => bad_request(error),
    }
}

async fn remove_custom_public<R>(
    State(_state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
    Path(id): Path<String>,
) -> Response
where
    R: Send + Sync + 'static,
{
    if let Some(resp) = require_host_admin(&credential) {
        return resp;
    }
    match custom_public::remove_custom_public_origin(&id).await {
        Ok(remaining) => {
            host_tunnel::refresh_published_reachability().await;
            account_daemon::notify_connectivity_changed();
            Json(json!({
                "custom_public_origins": remaining,
            }))
            .into_response()
        }
        Err(error) => bad_request(error),
    }
}

async fn set_tunnel_enabled<R>(
    State(_state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
    Json(input): Json<TunnelEnabledInput>,
) -> Response
where
    R: Send + Sync + 'static,
{
    if let Some(resp) = require_host_admin(&credential) {
        return resp;
    }
    match host_tunnel::set_host_tunnel_enabled_headless(input.enabled).await {
        Ok(status) => {
            account_daemon::notify_connectivity_changed();
            Json(status).into_response()
        }
        Err(error) => bad_request(error.to_string()),
    }
}

async fn reconnect_tunnel<R>(
    State(_state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
) -> Response
where
    R: Send + Sync + 'static,
{
    if let Some(resp) = require_host_admin(&credential) {
        return resp;
    }
    match host_tunnel::reconnect_active_tunnel().await {
        Ok(status) => {
            account_daemon::notify_connectivity_changed();
            Json(status).into_response()
        }
        Err(error) => bad_request(error.to_string()),
    }
}

/// Public endpoint: `POST /api/v1/auth/grant-exchange`.
///
/// Exchanges a short-lived Ed25519-signed `HostAccessGrant` (issued by `dimo-ai.com`
/// for the Host's bound Dimo account) plus client Ed25519 Proof-of-Possession signature
/// for a real Host `DeviceCredential`, verified locally with zero cloud call on the hot path.
pub async fn redeem_host_access_grant<R>(
    State(state): State<Arc<ServerState<R>>>,
    Json(request): Json<remote_protocol::RedeemHostAccessGrantRequest>,
) -> Response
where
    R: Send + Sync + 'static,
{
    let Some(pool) = state.auth.sqlite_pool() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorEnvelope::new(
                ErrorCode::Internal,
                "host grant exchange requires persistent SQLite authentication",
                true,
                OperationId::new(),
            )),
        )
            .into_response();
    };

    let bound = account_daemon::ensure_bound_account_identity().await;
    if !bound.auto_connect {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorEnvelope::new(
                ErrorCode::Forbidden,
                "same-account instant connect is disabled on this Host",
                false,
                OperationId::new(),
            )),
        )
            .into_response();
    }
    if bound.user_id.is_none() && bound.username.is_none() {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorEnvelope::new(
                ErrorCode::Forbidden,
                "this Host is not signed in to a Dimo account",
                false,
                OperationId::new(),
            )),
        )
            .into_response();
    }

    let verified = match super::grant_verifier::verify_and_consume_grant(
        pool,
        &request.grant_token,
        &request.client_public_key_ed25519,
        &request.pop_signature,
        &state.config.host_id,
        bound.user_id.as_deref(),
        bound.username.as_deref(),
    )
    .await
    {
        Ok(verified) => verified,
        Err(error) => {
            let (status, code) = match error {
                super::grant_verifier::GrantVerifyError::KeysUnavailable => {
                    (StatusCode::SERVICE_UNAVAILABLE, ErrorCode::Internal)
                }
                super::grant_verifier::GrantVerifyError::HostMismatch
                | super::grant_verifier::GrantVerifyError::AccountMismatch
                | super::grant_verifier::GrantVerifyError::InvalidSignature
                | super::grant_verifier::GrantVerifyError::InvalidPopSignature
                | super::grant_verifier::GrantVerifyError::ClientKeyMismatch => {
                    (StatusCode::FORBIDDEN, ErrorCode::Forbidden)
                }
                super::grant_verifier::GrantVerifyError::Expired
                | super::grant_verifier::GrantVerifyError::Replayed => {
                    (StatusCode::UNAUTHORIZED, ErrorCode::Unauthorized)
                }
                _ => (StatusCode::BAD_REQUEST, ErrorCode::BadRequest),
            };
            return (
                status,
                Json(ErrorEnvelope::new(
                    code,
                    error.to_string(),
                    false,
                    OperationId::new(),
                )),
            )
                .into_response();
        }
    };

    let account_label = bound
        .display_name
        .clone()
        .or(bound.username.clone())
        .or(bound.user_id.clone())
        .unwrap_or_else(|| verified.account_id.clone());

    let connect_request = remote_protocol::CreateDeviceConnectRequest {
        device_name: request.device_name,
        client_kind: Some(verified.client_kind),
        public_key_ed25519: Some(verified.client_pubkey_b64),
        session_nonce: None,
        account_token: None,
        preset: Some(verified.preset),
        replace_existing_mobile: false,
    };

    match state
        .auth
        .create_connect_request(
            &state.config.host_id,
            connect_request,
            None,
            Some(&account_label),
            true,
        )
        .await
    {
        Ok(response) => match response.credential {
            Some(credential) => (StatusCode::CREATED, Json(credential)).into_response(),
            None => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorEnvelope::new(
                    ErrorCode::Internal,
                    "grant exchange did not produce a device credential",
                    false,
                    OperationId::new(),
                )),
            )
                .into_response(),
        },
        Err(error) => bad_request(error.to_string()),
    }
}
