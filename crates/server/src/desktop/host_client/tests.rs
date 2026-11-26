use super::{
    DeviceCredentialParts, HealthBody, HostClientRuntime, StoredProfile, StoredState,
    advertised_connect_origin, collapse_provisioned_duplicates, format_ssh_host_config,
    host_update_available, is_release_host, normalize_origin, pairing_token_from_input,
    parse_health, resolve_connect_origin, ssh_host_alias, upsert_profile, views,
};

#[test]
fn ssh_host_config_omits_secrets() {
    assert_eq!(ssh_host_alias("Root @ Lab"), "root-lab");
    assert_eq!(
        format_ssh_host_config("Lab", "lab", "203.0.113.8", "root", 22, Some("bastion")),
        "# Dimo Host: Lab\nHost lab\n  HostName 203.0.113.8\n  User root\n  Port 22\n  ProxyJump bastion\n"
    );
}

#[test]
fn saved_hosts_behind_latest_are_update_available() {
    assert!(host_update_available(
        Some("0.2.1"),
        Some("0.2.0"),
        true,
        true
    ));
    assert!(host_update_available(
        Some("v0.3.0"),
        Some("0.2.9"),
        true,
        true
    ));
    assert!(host_update_available(Some("0.2.1"), None, true, true));
    assert!(!host_update_available(
        Some("0.2.1"),
        Some("0.2.1"),
        true,
        true
    ));
    assert!(!host_update_available(
        Some("0.2.1"),
        Some("0.2.0"),
        false,
        true
    ));
    assert!(!host_update_available(None, Some("0.2.0"), true, true));
    assert!(!host_update_available(Some(""), Some("0.2.0"), true, true));
    assert!(!host_update_available(
        Some("0.2.1"),
        Some("0.2.0"),
        true,
        false
    ));
}

#[test]
fn omitted_health_release_is_a_published_build() {
    let published: HealthBody =
        serde_json::from_str(r#"{"status":"ok","version":"0.2.1"}"#).expect("json");
    assert!(is_release_host(&published));
    let debug: HealthBody =
        serde_json::from_str(r#"{"status":"ok","version":"0.2.1","release":false}"#).expect("json");
    assert!(!is_release_host(&debug));
    let family: HealthBody =
        serde_json::from_str(r#"{"status":"ok","version":"0.2.1","release":true}"#).expect("json");
    assert!(is_release_host(&family));
}

#[test]
fn health_requires_ok_status() {
    assert!(
        parse_health(
            "http://192.168.1.8:17891",
            HealthBody {
                status: Some("ok".into()),
                ok: None,
                host_id: Some("host-1".into()),
                name: Some("Studio".into()),
                version: Some("0.2.0".into()),
                release: None,
            }
        )
        .is_some()
    );
    assert!(
        parse_health(
            "http://192.168.1.8:17891",
            HealthBody {
                status: Some("down".into()),
                ok: None,
                host_id: None,
                name: None,
                version: None,
                release: None,
            }
        )
        .is_none()
    );
}

#[test]
fn pairing_input_accepts_invitation_payloads() {
    assert_eq!(
        pairing_token_from_input(r#"dimo-pairing:{"pairing_token":"K7M2NPQX","host_id":"h"}"#),
        "K7M2NPQX"
    );
    assert_eq!(pairing_token_from_input(" K7M2NPQX "), "K7M2NPQX");
    assert_eq!(pairing_token_from_input(" k7m2npqx "), "K7M2NPQX");
}

#[test]
fn saved_views_pin_the_connected_host_and_hide_tokens() {
    let state = StoredState {
        active_profile_id: Some("b".into()),
        profiles: vec![
            StoredProfile {
                id: "a".into(),
                origin: "http://192.168.1.8:17891".into(),
                host_id: Some("host-a".into()),
                name: "Alpha".into(),
                device_id: Some("dev-a".into()),
                access_token: Some("secret-a".into()),
                last_connected_at: Some("2026-08-01T00:00:00Z".into()),
                needs_token: false,
                provision_kind: None,
                provision: None,
                ..StoredProfile::default()
            },
            StoredProfile {
                id: "b".into(),
                origin: "http://192.168.1.9:17891".into(),
                host_id: Some("host-b".into()),
                name: "Beta".into(),
                device_id: Some("dev-b".into()),
                access_token: Some("secret-b".into()),
                last_connected_at: Some("2026-08-02T00:00:00Z".into()),
                needs_token: false,
                provision_kind: None,
                provision: None,
                ..StoredProfile::default()
            },
        ],
        ..StoredState::default()
    };
    let encoded = serde_json::to_string(&views(&state, Some("b"))).expect("json");
    assert!(!encoded.contains("secret-"));
    let profiles = views(&state, Some("b"));
    assert_eq!(profiles[0].id, "b");
    assert!(profiles[0].connected);
    assert!(profiles[0].has_credential);
    assert!(!profiles[0].needs_token);
}

#[test]
fn upsert_reuses_the_same_host_id() {
    let mut state = StoredState::default();
    let first = upsert_profile(
        &mut state,
        None,
        "http://192.168.1.8:17891".into(),
        Some("host-1".into()),
        "Studio".into(),
        DeviceCredentialParts {
            device_id: Some("dev-1".into()),
            access_token: "token-1".into(),
        },
        "2026-08-20T00:00:00Z".into(),
    );
    let second = upsert_profile(
        &mut state,
        None,
        "http://192.168.1.8:19000".into(),
        Some("host-1".into()),
        "Studio".into(),
        DeviceCredentialParts {
            device_id: Some("dev-2".into()),
            access_token: "token-2".into(),
        },
        "2026-08-20T01:00:00Z".into(),
    );
    assert_eq!(first, second);
    assert_eq!(state.profiles.len(), 1);
    assert_eq!(state.profiles[0].origin, "http://192.168.1.8:19000");
    assert_eq!(state.profiles[0].access_token.as_deref(), Some("token-2"));
}

#[test]
fn lan_http_origins_default_to_the_host_port() {
    assert_eq!(
        normalize_origin("192.168.1.8").expect("origin"),
        "http://192.168.1.8:17891"
    );
    assert_eq!(
        normalize_origin("http://10.0.0.4:19000").expect("origin"),
        "http://10.0.0.4:19000"
    );
    assert_eq!(
        normalize_origin("47.109.140.92:13630").expect("origin"),
        "http://47.109.140.92:13630"
    );
    assert_eq!(
        normalize_origin("http://203.0.113.10").expect("origin"),
        "http://203.0.113.10:17891"
    );
}

#[test]
fn advertised_origin_replaces_a_stale_tunnel_with_the_host_address() {
    let provision = serde_json::json!({
        "host": "203.0.113.8",
        "port": 22,
        "user": "root",
        "servicePort": 17891,
        "addresses": ["http://127.0.0.1:17891", "http://203.0.113.8:17891"]
    });
    assert_eq!(
        advertised_connect_origin("http://127.0.0.1:41234", Some(&provision)),
        "http://203.0.113.8:17891"
    );
    assert_eq!(
        advertised_connect_origin("http://203.0.113.8:17891", Some(&provision)),
        "http://203.0.113.8:17891"
    );
    assert_eq!(
        advertised_connect_origin("http://192.168.1.8:17891", None),
        "http://192.168.1.8:17891"
    );
    assert_eq!(
        resolve_connect_origin(
            Some("http://127.0.0.1:41234"),
            Some("http://127.0.0.1:41234"),
            Some(&provision)
        ),
        "http://127.0.0.1:41234"
    );
    assert_eq!(
        resolve_connect_origin(None, Some("http://127.0.0.1:41234"), Some(&provision)),
        "http://203.0.113.8:17891"
    );
}

#[tokio::test]
async fn provisioned_hosts_keep_their_kind_across_saves() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = HostClientRuntime::with_path(dir.path().join("profiles.json"));
    let saved = runtime
        .upsert_provisioned(
            None,
            "http://127.0.0.1:41234".to_string(),
            Some("root@lab".to_string()),
            "ssh".to_string(),
            Some(serde_json::json!({ "host": "203.0.113.8", "port": 22, "user": "root" })),
        )
        .await
        .expect("upsert");
    assert_eq!(saved.provision_kind.as_deref(), Some("ssh"));
    let again = runtime
        .profile(&saved.id)
        .await
        .expect("profile")
        .expect("present");
    assert_eq!(again.name, "root@lab");
    assert_eq!(again.provision_kind.as_deref(), Some("ssh"));
    let host_file = dir
        .path()
        .join("hosts")
        .join(format!("{}.sshconfig", saved.id));
    let config = std::fs::read_to_string(&host_file).expect("host file");
    assert!(config.contains("HostName 203.0.113.8"));
    assert!(config.contains("User root"));
    assert!(!config.contains("password"));
}

#[tokio::test]
async fn provisioned_hosts_with_the_same_target_share_one_record() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = HostClientRuntime::with_path(dir.path().join("profiles.json"));
    let first = runtime
        .upsert_provisioned(
            None,
            "http://127.0.0.1:56064".to_string(),
            Some("root@lab".to_string()),
            "ssh".to_string(),
            Some(serde_json::json!({ "host": "203.0.113.8", "port": 22, "user": "root" })),
        )
        .await
        .expect("first");
    let second = runtime
        .upsert_provisioned(
            None,
            "http://127.0.0.1:61091".to_string(),
            Some("root@lab".to_string()),
            "ssh".to_string(),
            Some(serde_json::json!({ "host": "203.0.113.8", "port": 22, "user": "root" })),
        )
        .await
        .expect("second");
    assert_eq!(first.id, second.id);
    assert_eq!(second.origin, "http://127.0.0.1:61091");
    let status = runtime
        .status(
            &super::super::remote_desktop::RemoteDesktopRegistry::new().expect("registry"),
            "main",
        )
        .await
        .expect("status");
    assert_eq!(status.profiles.len(), 1);
}

#[test]
fn collapse_merges_duplicate_ssh_targets() {
    let mut state = StoredState {
        active_profile_id: None,
        profiles: vec![
            StoredProfile {
                id: "old".into(),
                origin: "http://127.0.0.1:56064".into(),
                host_id: None,
                name: "root@lab".into(),
                device_id: None,
                access_token: None,
                last_connected_at: Some("2026-09-01T00:00:00Z".into()),
                needs_token: true,
                provision_kind: Some("ssh".into()),
                provision: Some(serde_json::json!({
                    "host": "203.0.113.8",
                    "port": 22,
                    "user": "root"
                })),
                ..StoredProfile::default()
            },
            StoredProfile {
                id: "new".into(),
                origin: "http://127.0.0.1:61091".into(),
                host_id: Some("host-ssh".into()),
                name: "root@lab".into(),
                device_id: None,
                access_token: Some("token".into()),
                last_connected_at: Some("2026-09-06T00:00:00Z".into()),
                needs_token: false,
                provision_kind: Some("ssh".into()),
                provision: Some(serde_json::json!({
                    "host": "203.0.113.8",
                    "port": 22,
                    "user": "root"
                })),
                ..StoredProfile::default()
            },
        ],
        ..StoredState::default()
    };
    assert!(collapse_provisioned_duplicates(&mut state));
    assert_eq!(state.profiles.len(), 1);
    assert_eq!(state.profiles[0].id, "new");
    assert!(!collapse_provisioned_duplicates(&mut state));
}

#[tokio::test]
async fn store_round_trip_does_not_create_a_file_until_save() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = HostClientRuntime::with_path(dir.path().join("profiles.json"));
    let status = runtime
        .status(
            &super::super::remote_desktop::RemoteDesktopRegistry::new().expect("registry"),
            "main",
        )
        .await
        .expect("status");
    assert!(!status.connected);
    assert!(status.profiles.is_empty());
}

#[tokio::test]
async fn first_token_is_remembered_until_the_host_revokes_it() {
    use axum::{
        Json, Router,
        http::StatusCode,
        response::IntoResponse,
        routing::{get, post},
    };

    use super::{ConnectHostRequest, NEEDS_TOKEN};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let address = listener.local_addr().expect("address");
    let revoked = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let revoked_flag = revoked.clone();
    let router = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(serde_json::json!({
                    "status": "ok",
                    "host_id": "host-1",
                    "name": "Studio"
                }))
            }),
        )
        .route(
            "/api/v1/auth/pairings",
            post(|| async {
                (
                    StatusCode::CREATED,
                    Json(serde_json::json!({
                        "host_id": "host-1",
                        "pairing_id": "0195d6f4-8c37-7b28-a982-6a9e60142f55",
                        "pairing_token": "K7M2NPQX",
                        "expires_at": "2026-08-21T00:00:00Z",
                        "requested_scopes": ["conversation.read"],
                        "preset": "workstation",
                        "reachability": [],
                        "invitation": "dimo-pairing:{}",
                        "connection_code": "K7M2NPQX"
                    })),
                )
            }),
        )
        .route(
            "/api/v1/auth/pairings/redeem",
            post(|| async {
                (
                    StatusCode::CREATED,
                    Json(serde_json::json!({
                        "device_id": "0195d6f4-8c37-7b28-a982-6a9e60142f66",
                        "access_token": format!("{}{}", "vbx_device_", "x".repeat(64)),
                        "scopes": ["conversation.read"]
                    })),
                )
            }),
        )
        .route(
            "/api/v1/capabilities",
            get({
                let revoked_flag = revoked_flag.clone();
                move || {
                    let revoked_flag = revoked_flag.clone();
                    async move {
                        if revoked_flag.load(std::sync::atomic::Ordering::SeqCst) {
                            return (
                                StatusCode::UNAUTHORIZED,
                                Json(serde_json::json!({ "message": "revoked" })),
                            )
                                .into_response();
                        }
                        (
                            StatusCode::OK,
                            Json(serde_json::json!({
                                "server_version": "0.1.3",
                                "protocol_version": "1.0",
                                "minimum_client_version": "0.1.0",
                                "capabilities": ["conversation.read"],
                                "host_id": "host-1",
                                "reachability": []
                            })),
                        )
                            .into_response()
                    }
                }
            }),
        );
    let task = tokio::spawn(async move { axum::serve(listener, router).await });
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = HostClientRuntime::with_path(dir.path().join("profiles.json"));
    let registry = super::super::remote_desktop::RemoteDesktopRegistry::new().expect("registry");
    let origin = format!("http://{address}");
    let first = runtime
        .connect(
            "settings",
            &registry,
            ConnectHostRequest {
                origin: Some(origin.clone()),
                token: Some("K7M2NPQX".into()),
                profile_id: None,
                endpoints: Vec::new(),
            },
        )
        .await
        .expect("first connect");
    assert!(first.profile.has_credential);
    assert!(!first.profile.needs_token);
    assert!(!first.profile.connected);
    assert!(!first.stopped_host);

    let host_window = super::host_window_label(&first.profile.id);
    let local = runtime
        .status(&registry, "settings")
        .await
        .expect("local status");
    assert!(!local.connected);
    assert!(
        local
            .profiles
            .iter()
            .any(|profile| profile.id == first.profile.id && !profile.connected)
    );
    let bound = runtime
        .status(&registry, &host_window)
        .await
        .expect("host status");
    assert!(bound.connected);
    assert_eq!(
        bound.profile.as_ref().map(|profile| profile.id.as_str()),
        Some(first.profile.id.as_str())
    );
    assert!(bound.profiles[0].connected);
    let settings_window = super::super::host_windows::host_settings_window_label(&first.profile.id);
    let companion = runtime
        .status(&registry, &settings_window)
        .await
        .expect("companion settings");
    assert!(companion.connected);
    assert_eq!(
        companion
            .profile
            .as_ref()
            .map(|profile| profile.id.as_str()),
        Some(first.profile.id.as_str())
    );
    let local_settings = runtime
        .status(&registry, "settings")
        .await
        .expect("local settings");
    assert!(!local_settings.connected);

    let second = runtime
        .connect(
            "settings",
            &registry,
            ConnectHostRequest {
                origin: None,
                token: None,
                profile_id: Some(first.profile.id.clone()),
                endpoints: Vec::new(),
            },
        )
        .await
        .expect("remembered connect");
    assert_eq!(second.profile.id, first.profile.id);
    assert!(!second.profile.connected);

    runtime
        .disconnect_window(&registry, &host_window)
        .await
        .expect("close saved Host window");
    let closed = runtime
        .status(&registry, &host_window)
        .await
        .expect("closed host window");
    assert!(!closed.connected);
    runtime
        .drop_binding_for_destroyed_window(&registry, &host_window, true)
        .await;
    let rebound = runtime
        .connect(
            "settings",
            &registry,
            ConnectHostRequest {
                origin: None,
                token: None,
                profile_id: Some(first.profile.id.clone()),
                endpoints: Vec::new(),
            },
        )
        .await
        .expect("reconnect saved Host");
    assert_eq!(rebound.profile.id, first.profile.id);
    runtime
        .drop_binding_for_destroyed_window(&registry, &host_window, true)
        .await;
    let still_bound = runtime
        .status(&registry, &host_window)
        .await
        .expect("kept replacement window");
    assert!(still_bound.connected);
    runtime
        .drop_binding_for_destroyed_window(&registry, &host_window, false)
        .await;
    let unbound = runtime
        .status(&registry, &host_window)
        .await
        .expect("closed replacement");
    assert!(!unbound.connected);

    revoked.store(true, std::sync::atomic::Ordering::SeqCst);
    let err = runtime
        .connect(
            "settings",
            &registry,
            ConnectHostRequest {
                origin: None,
                token: None,
                profile_id: Some(first.profile.id.clone()),
                endpoints: Vec::new(),
            },
        )
        .await
        .expect_err("revoked");
    assert!(
        matches!(err, super::super::error::DesktopError::BadRequest(message) if message == NEEDS_TOKEN)
    );
    task.abort();
}
