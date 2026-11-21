use std::{net::SocketAddr, time::Duration};

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use server::{HeadlessServer, ServerBootstrapConfig, ServerToken};
use tempfile::TempDir;
use tokio::sync::oneshot;
use tower::ServiceExt;

#[tokio::test(flavor = "multi_thread")]
async fn desktop_mode_binds_ephemeral_port_accepts_custom_origin_and_shuts_down_cleanly() {
    let data_dir = TempDir::new().expect("data dir");
    let desktop_token = ServerToken::try_new(
        "dimo_desktop_test_token_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6".to_string(),
    )
    .expect("valid test desktop token");
    let token_raw = desktop_token.expose_once();

    let mut config = ServerBootstrapConfig::new(data_dir.path())
        .with_desktop_mode(true)
        .with_desktop_token(
            ServerToken::try_new(token_raw.clone()).expect("clone valid test desktop token"),
        )
        .with_autostart_web_service(false);
    config.server = config
        .server
        .with_listen_addr("127.0.0.1:0".parse().expect("ephemeral addr"), false)
        .expect("loopback listen addr");

    let server = HeadlessServer::bootstrap(config)
        .await
        .expect("desktop bootstrap");

    let (ready_tx, ready_rx) = oneshot::channel::<SocketAddr>();
    let serve_task = tokio::spawn(async move {
        let mut ready_tx = Some(ready_tx);
        server
            .serve_with_ready_and_shutdown(
                move |addr| {
                    if let Some(tx) = ready_tx.take() {
                        let _ = tx.send(addr);
                    }
                },
                std::future::pending(),
            )
            .await
    });

    let bound_addr = tokio::time::timeout(Duration::from_secs(5), ready_rx)
        .await
        .expect("server should bind promptly")
        .expect("ready channel should emit bound addr");
    assert!(bound_addr.ip().is_loopback());
    assert_ne!(bound_addr.port(), 0);

    let base_url = format!("http://{bound_addr}");
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("reqwest client");

    // 1. CORS preflight for Electron custom protocol origin `dimo-app://localhost`.
    let preflight = client
        .request(reqwest::Method::OPTIONS, format!("{base_url}/api/v1/desktop/health"))
        .header("Origin", server::desktop::DESKTOP_APP_ORIGIN)
        .header("Access-Control-Request-Method", "GET")
        .send()
        .await
        .expect("preflight response");
    assert!(
        preflight.status().is_success(),
        "preflight status was {}",
        preflight.status()
    );
    assert_eq!(
        preflight
            .headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok()),
        Some(server::desktop::DESKTOP_APP_ORIGIN)
    );

    // 2. Desktop endpoints reject missing/invalid tokens and forwarded proxy headers.
    let missing_auth = client
        .get(format!("{base_url}/api/v1/desktop/health"))
        .send()
        .await
        .expect("missing auth response");
    assert_eq!(missing_auth.status(), reqwest::StatusCode::UNAUTHORIZED);

    let wrong_auth = client
        .get(format!("{base_url}/api/v1/desktop/health"))
        .bearer_auth("wrong_token_value_123456789012345678901234")
        .send()
        .await
        .expect("wrong auth response");
    assert_eq!(wrong_auth.status(), reqwest::StatusCode::UNAUTHORIZED);

    let proxied = client
        .get(format!("{base_url}/api/v1/desktop/health"))
        .bearer_auth(&token_raw)
        .header("x-forwarded-for", "203.0.113.9")
        .send()
        .await
        .expect("proxied response");
    assert_eq!(proxied.status(), reqwest::StatusCode::FORBIDDEN);

    // 3. Valid desktop token accesses `/api/v1/desktop/health` with custom origin CORS.
    let health = client
        .get(format!("{base_url}/api/v1/desktop/health"))
        .header("Origin", server::desktop::DESKTOP_APP_ORIGIN)
        .bearer_auth(&token_raw)
        .send()
        .await
        .expect("health response");
    assert_eq!(health.status(), reqwest::StatusCode::OK);
    assert_eq!(
        health
            .headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok()),
        Some(server::desktop::DESKTOP_APP_ORIGIN)
    );
    let health_json: serde_json::Value = health.json().await.expect("health json");
    assert_eq!(health_json["status"], "ok");
    assert_eq!(health_json["desktop_mode"], true);
    assert!(health_json["pid"].as_u64().is_some());

    // 4. Ephemeral desktop token also grants Host owner access on `/api/v1/capabilities`.
    let capabilities = client
        .get(format!("{base_url}/api/v1/capabilities"))
        .bearer_auth(&token_raw)
        .send()
        .await
        .expect("capabilities response");
    assert_eq!(capabilities.status(), reqwest::StatusCode::OK);

    // 5. Desktop plugin-dev-connection endpoint works.
    let plugin_dev = client
        .get(format!("{base_url}/api/v1/desktop/plugin-dev-connection"))
        .bearer_auth(&token_raw)
        .send()
        .await
        .expect("plugin dev response");
    assert_eq!(plugin_dev.status(), reqwest::StatusCode::OK);
    let plugin_dev_json: serde_json::Value = plugin_dev.json().await.expect("plugin dev json");
    assert_eq!(plugin_dev_json["protocolVersion"], "1.0");

    // 6. Desktop command invoke endpoint dispatches migrated commands and rejects unknown ones.
    let cancel = client
        .post(format!("{base_url}/api/v1/desktop/invoke/backup_cancel"))
        .bearer_auth(&token_raw)
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("backup_cancel response");
    assert_eq!(cancel.status(), reqwest::StatusCode::OK);

    let unknown = client
        .post(format!("{base_url}/api/v1/desktop/invoke/nonexistent_cmd"))
        .bearer_auth(&token_raw)
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("unknown command response");
    assert_eq!(unknown.status(), reqwest::StatusCode::NOT_FOUND);

    // 7. `/api/v1/desktop/shutdown` triggers graceful shutdown and clean exit.
    let shutdown = client
        .post(format!("{base_url}/api/v1/desktop/shutdown"))
        .bearer_auth(&token_raw)
        .send()
        .await
        .expect("shutdown response");
    assert_eq!(shutdown.status(), reqwest::StatusCode::OK);

    let serve_result = tokio::time::timeout(Duration::from_secs(5), serve_task)
        .await
        .expect("server should shut down within timeout")
        .expect("serve task should not panic");
    assert!(serve_result.is_ok(), "serve returned error: {serve_result:?}");
}

#[tokio::test]
async fn non_desktop_mode_does_not_mount_desktop_control_routes() {
    let data_dir = TempDir::new().expect("data dir");
    let server = HeadlessServer::bootstrap(ServerBootstrapConfig::new(data_dir.path()))
        .await
        .expect("headless bootstrap");

    let response = server
        .runtime()
        .router()
        .oneshot(
            Request::builder()
                .uri("/api/v1/desktop/health")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
