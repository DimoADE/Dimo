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
        .request(
            reqwest::Method::OPTIONS,
            format!("{base_url}/api/v1/desktop/health"),
        )
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

    // 5. Desktop plugin-dev-connection endpoint exposes a live loopback control server.
    let plugin_dev = client
        .get(format!("{base_url}/api/v1/desktop/plugin-dev-connection"))
        .bearer_auth(&token_raw)
        .send()
        .await
        .expect("plugin dev response");
    assert_eq!(plugin_dev.status(), reqwest::StatusCode::OK);
    let plugin_dev_json: serde_json::Value = plugin_dev.json().await.expect("plugin dev json");
    assert_eq!(plugin_dev_json["protocolVersion"], "1.0");
    let dev_endpoint = plugin_dev_json["endpoint"]
        .as_str()
        .expect("plugin dev endpoint")
        .to_owned();
    let dev_token = plugin_dev_json["token"]
        .as_str()
        .expect("plugin dev token")
        .to_owned();
    assert!(dev_endpoint.starts_with("http://127.0.0.1:"));
    assert!(
        dev_token.len() >= 32,
        "plugin dev token should be an opaque random secret"
    );

    // Command invoke route returns the exact same live connection metadata.
    let invoke_dev = client
        .post(format!(
            "{base_url}/api/v1/desktop/invoke/plugin_dev_connection"
        ))
        .bearer_auth(&token_raw)
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("invoke plugin_dev_connection response");
    assert_eq!(invoke_dev.status(), reqwest::StatusCode::OK);
    let invoke_dev_json: serde_json::Value = invoke_dev.json().await.expect("invoke json");
    assert_eq!(invoke_dev_json["endpoint"], dev_endpoint);
    assert_eq!(invoke_dev_json["token"], dev_token);
    assert_eq!(invoke_dev_json["protocolVersion"], "1.0");

    // Persisted plugin-dev.json matches live connection metadata.
    let connection_file = data_dir.path().join("plugin-dev.json");
    assert!(
        connection_file.is_file(),
        "plugin-dev.json should be persisted"
    );
    let persisted: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&connection_file).expect("read plugin-dev.json"),
    )
    .expect("parse plugin-dev.json");
    assert_eq!(persisted["url"], dev_endpoint);
    assert_eq!(persisted["token"], dev_token);
    assert_eq!(persisted["protocolVersion"], "1.0");

    // 5a. Control plane enforces protocol header, constant-time token auth, and JSON bodies.
    let unauth_doctor = client
        .get(format!(
            "{dev_endpoint}/api/plugin-dev/v1/plugins/acme/live-demo/doctor"
        ))
        .send()
        .await
        .expect("unauth doctor");
    assert_eq!(unauth_doctor.status(), reqwest::StatusCode::UNAUTHORIZED);
    let unauth_body: serde_json::Value = unauth_doctor.json().await.expect("unauth json");
    assert_eq!(unauth_body["error"]["code"], "plugin_dev_unauthorized");

    let non_json = client
        .post(format!(
            "{dev_endpoint}/api/plugin-dev/v1/linked-installations"
        ))
        .header(server::desktop::plugin_dev_server::PROTOCOL_HEADER, "1.0")
        .header(server::desktop::plugin_dev_server::TOKEN_HEADER, &dev_token)
        .header(reqwest::header::CONTENT_TYPE, "text/plain")
        .body("not-json")
        .send()
        .await
        .expect("non-json response");
    assert_eq!(
        non_json.status(),
        reqwest::StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    let non_json_body: serde_json::Value = non_json.json().await.expect("non-json body");
    assert_eq!(
        non_json_body["error"]["code"],
        "plugin_dev_unsupported_media_type"
    );

    // 5b. Full live linked-install -> doctor -> candidate hot reload -> uninstall cycle.
    let plugin_src = TempDir::new().expect("plugin source dir");
    std::fs::create_dir_all(plugin_src.path().join(".dimo-plugin")).expect("manifest dir");
    std::fs::create_dir_all(plugin_src.path().join("skills/live")).expect("skills dir");
    std::fs::write(
        plugin_src.path().join("skills/live/SKILL.md"),
        "# Live v1\n",
    )
    .expect("write v1 skill");
    std::fs::write(
        plugin_src.path().join(".dimo-plugin/plugin.json"),
        serde_json::json!({
            "manifestVersion": 4,
            "apiVersion": "1.0",
            "id": "acme.live-demo",
            "publisher": "acme",
            "version": "1.0.0",
            "name": "Live Demo",
            "engines": { "dimo": ">=0.1.3", "pluginSdk": "^1.0.0" },
            "contributes": {
                "agent.skills": [{
                    "id": "live",
                    "kindVersion": 1,
                    "path": "skills/live",
                    "targets": ["codex"]
                }]
            }
        })
        .to_string(),
    )
    .expect("write plugin manifest");
    let digest_v1 = plugins::package_content_digest(plugin_src.path()).expect("digest v1");

    let linked_install = client
        .post(format!(
            "{dev_endpoint}/api/plugin-dev/v1/linked-installations"
        ))
        .header(server::desktop::plugin_dev_server::PROTOCOL_HEADER, "1.0")
        .header(server::desktop::plugin_dev_server::TOKEN_HEADER, &dev_token)
        .json(&serde_json::json!({
            "sourcePath": plugin_src.path().to_string_lossy(),
            "expected": {
                "publisher": "acme",
                "pluginId": "acme.live-demo",
                "version": "1.0.0",
                "packageDigest": digest_v1,
            }
        }))
        .send()
        .await
        .expect("linked install response");
    assert_eq!(linked_install.status(), reqwest::StatusCode::OK);
    let linked_json: serde_json::Value = linked_install.json().await.expect("linked install json");
    assert_eq!(linked_json["protocolVersion"], "1.0");
    assert_eq!(linked_json["state"], "active");
    assert_eq!(linked_json["plugin"]["publisher"], "acme");
    assert_eq!(linked_json["plugin"]["id"], "acme.live-demo");
    assert_eq!(linked_json["packageDigest"], digest_v1);
    let gen_v1 = linked_json["generation"].as_u64().expect("generation v1");
    assert!(gen_v1 >= 1);

    let doctor_res = client
        .get(format!(
            "{dev_endpoint}/api/plugin-dev/v1/plugins/acme/acme.live-demo/doctor"
        ))
        .header(server::desktop::plugin_dev_server::PROTOCOL_HEADER, "1.0")
        .header(server::desktop::plugin_dev_server::TOKEN_HEADER, &dev_token)
        .send()
        .await
        .expect("doctor response");
    assert_eq!(doctor_res.status(), reqwest::StatusCode::OK);
    let doctor_json: serde_json::Value = doctor_res.json().await.expect("doctor json");
    assert_eq!(doctor_json["protocolVersion"], "1.0");
    assert_eq!(doctor_json["activation"]["enabled"], true);
    assert_eq!(doctor_json["activation"]["generation"], gen_v1);
    assert_eq!(doctor_json["sourceKind"], "linked");
    assert!(doctor_json["grants"].is_array());
    assert!(doctor_json["runtimes"].is_array());
    assert!(doctor_json["contributions"].is_array());
    assert!(doctor_json["agentBindings"].is_array());
    assert!(doctor_json["recentCrashes"].is_array());
    assert_eq!(doctor_json["diagnostics"].as_array().map(Vec::len), Some(0));

    // Mutate plugin source on disk, reject mismatched digest while keeping gen_v1 published.
    std::fs::write(
        plugin_src.path().join("skills/live/SKILL.md"),
        "# Live v2\n",
    )
    .expect("write v2 skill");
    let digest_v2 = plugins::package_content_digest(plugin_src.path()).expect("digest v2");
    assert_ne!(digest_v1, digest_v2);

    let bad_candidate = client
        .post(format!(
            "{dev_endpoint}/api/plugin-dev/v1/plugins/acme/acme.live-demo/candidates"
        ))
        .header(server::desktop::plugin_dev_server::PROTOCOL_HEADER, "1.0")
        .header(server::desktop::plugin_dev_server::TOKEN_HEADER, &dev_token)
        .json(&serde_json::json!({
            "sourcePath": plugin_src.path().to_string_lossy(),
            "expectedPackageDigest": digest_v1,
        }))
        .send()
        .await
        .expect("bad candidate response");
    assert_eq!(bad_candidate.status(), reqwest::StatusCode::CONFLICT);
    let bad_candidate_json: serde_json::Value =
        bad_candidate.json().await.expect("bad candidate json");
    assert_eq!(
        bad_candidate_json["error"]["code"],
        "plugin_dev_expectation_mismatch"
    );
    assert_eq!(bad_candidate_json["error"]["publishedGeneration"], gen_v1);

    let good_candidate = client
        .post(format!(
            "{dev_endpoint}/api/plugin-dev/v1/plugins/acme/acme.live-demo/candidates"
        ))
        .header(server::desktop::plugin_dev_server::PROTOCOL_HEADER, "1.0")
        .header(server::desktop::plugin_dev_server::TOKEN_HEADER, &dev_token)
        .json(&serde_json::json!({
            "sourcePath": plugin_src.path().to_string_lossy(),
            "expectedPackageDigest": digest_v2,
        }))
        .send()
        .await
        .expect("good candidate response");
    assert_eq!(good_candidate.status(), reqwest::StatusCode::OK);
    let good_candidate_json: serde_json::Value =
        good_candidate.json().await.expect("good candidate json");
    assert_eq!(good_candidate_json["protocolVersion"], "1.0");
    assert_eq!(good_candidate_json["packageDigest"], digest_v2);
    let gen_v2 = good_candidate_json["generation"]
        .as_u64()
        .expect("generation v2");
    assert!(gen_v2 > gen_v1, "candidate reload must advance generation");

    let uninstall = client
        .delete(format!(
            "{dev_endpoint}/api/plugin-dev/v1/plugins/acme/acme.live-demo/linked-installation"
        ))
        .header(server::desktop::plugin_dev_server::PROTOCOL_HEADER, "1.0")
        .header(server::desktop::plugin_dev_server::TOKEN_HEADER, &dev_token)
        .json(&serde_json::json!({ "retainData": false }))
        .send()
        .await
        .expect("uninstall response");
    assert_eq!(uninstall.status(), reqwest::StatusCode::OK);
    let uninstall_json: serde_json::Value = uninstall.json().await.expect("uninstall json");
    assert_eq!(uninstall_json["protocolVersion"], "1.0");
    assert_eq!(uninstall_json["removed"], true);
    assert_eq!(uninstall_json["dataRetention"], "deleted");

    let doctor_after_uninstall = client
        .get(format!(
            "{dev_endpoint}/api/plugin-dev/v1/plugins/acme/acme.live-demo/doctor"
        ))
        .header(server::desktop::plugin_dev_server::PROTOCOL_HEADER, "1.0")
        .header(server::desktop::plugin_dev_server::TOKEN_HEADER, &dev_token)
        .send()
        .await
        .expect("doctor after uninstall");
    assert_eq!(
        doctor_after_uninstall.status(),
        reqwest::StatusCode::NOT_FOUND
    );

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
    assert!(
        serve_result.is_ok(),
        "serve returned error: {serve_result:?}"
    );
    assert!(
        !connection_file.exists(),
        "plugin-dev.json should be cleaned up on graceful shutdown"
    );
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
