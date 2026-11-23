use futures::StreamExt;
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use super::*;
use crate::engine::muse_protocol::{
    MuseQuestionSpec, PendingMuseUserInput, build_muse_user_input_answers, mint_uuid_v7,
    muse_approval_mode, muse_permission_profile, parse_muse_models_response,
    parse_muse_rate_limits_payload, prepare_muse_launch_env, serialize_muse_input_items,
    serialize_muse_session_mcp, to_windows_verbatim_path,
};

fn test_start_spec() -> EngineStartSpec {
    EngineStartSpec {
        workspace_id: Uuid::new_v4(),
        working_dir: PathBuf::from("."),
        model: Some("muse-2".to_string()),
        ..Default::default()
    }
}

async fn reply<W: AsyncWrite + Unpin>(w: &mut W, id: &Option<Value>, res: Value) {
    let line = format!("{}\n", json!({ "jsonrpc": "2.0", "id": id, "result": res }));
    w.write_all(line.as_bytes()).await.unwrap();
}

async fn notif<W: AsyncWrite + Unpin>(w: &mut W, method: &str, params: Value) {
    let line = format!(
        "{}\n",
        json!({ "jsonrpc": "2.0", "method": method, "params": params })
    );
    w.write_all(line.as_bytes()).await.unwrap();
}

#[tokio::test]
async fn muse_handshake_rejects_unsupported_schema_version() {
    let (client_io, server_io) = tokio::io::duplex(16 * 1024);
    let (client_read, client_write) = tokio::io::split(client_io);
    let (server_read, mut w) = tokio::io::split(server_io);

    let mock_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        if let Ok(Some(line)) = lines.next_line().await {
            let req: Value = serde_json::from_str(&line).expect("valid jsonrpc");
            assert_eq!(req["method"], "initialize");
            reply(
                &mut w,
                &req.get("id").cloned(),
                json!({
                    "schema": { "version": 99 },
                    "grantedCapabilities": ["sessionMcp"]
                }),
            )
            .await;
        }
    });

    let err = MuseNativeDriver::connect_duplex(test_start_spec(), client_read, client_write, None)
        .await
        .err()
        .expect("unsupported schema version must fail");
    assert!(
        err.to_string().contains("99"),
        "expected version diagnostic, got: {err}"
    );
    mock_peer.await.unwrap();
}

#[tokio::test]
async fn muse_driver_streams_session_deltas_tools_todos_rate_limits_steer_and_resume() {
    let (client_io, server_io) = tokio::io::duplex(128 * 1024);
    let (client_read, client_write) = tokio::io::split(client_io);
    let (server_read, mut w) = tokio::io::split(server_io);

    let spec = test_start_spec();
    let app = MuseServer::connect_over_io_with_stderr(
        spec.workspace_id,
        false,
        client_read,
        client_write,
        None,
        None,
        Arc::new(StderrTail::new()),
    );

    let mock_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        let mut saw_initialized = false;
        while let Ok(Some(line)) = lines.next_line().await {
            let req: Value = serde_json::from_str(&line).expect("valid jsonrpc");
            let method = req.get("method").and_then(Value::as_str).unwrap_or("");
            let id = req.get("id").cloned();

            match method {
                "initialize" => {
                    assert_eq!(
                        req["params"]["capabilities"]["requestedCapabilities"],
                        json!(["sessionMcp"])
                    );
                    reply(
                        &mut w,
                        &id,
                        json!({
                            "schema": { "version": 1 },
                            "grantedCapabilities": ["sessionMcp"],
                            "museHome": "/tmp/muse-home"
                        }),
                    )
                    .await;
                }
                "initialized" => {
                    saw_initialized = true;
                }
                "model/list" => {
                    reply(
                        &mut w,
                        &id,
                        json!({
                            "models": [
                                {
                                    "modelId": "muse-2",
                                    "providerId": "meta",
                                    "displayName": "Muse 2",
                                    "isDefault": true,
                                    "supportsReasoning": true
                                },
                                {
                                    "modelId": "other-provider-model",
                                    "providerId": "other"
                                }
                            ]
                        }),
                    )
                    .await;
                }
                "session/start" => {
                    assert!(saw_initialized);
                    assert_eq!(req["params"]["providerId"], "meta");
                    assert_eq!(req["params"]["approvalMode"], "promptUnmatched");
                    assert_eq!(req["params"]["permissionProfile"], ":ask-me");
                    assert!(req["params"]["commandId"].as_str().is_some());
                    reply(
                        &mut w,
                        &id,
                        json!({
                            "session": {
                                "sessionId": "muse-sess-1",
                                "modelId": "muse-2"
                            }
                        }),
                    )
                    .await;
                }
                "session/resume" => {
                    assert_eq!(req["params"]["sessionId"], "muse-sess-resumed");
                    assert_eq!(req["params"]["excludeItems"], true);
                    reply(
                        &mut w,
                        &id,
                        json!({
                            "session": {
                                "sessionId": "muse-sess-resumed",
                                "modelId": "muse-2"
                            }
                        }),
                    )
                    .await;
                }
                "session/setApprovalMode" => {
                    reply(&mut w, &id, json!({ "ok": true })).await;
                }
                "session/setModel" => {
                    assert_eq!(req["params"]["model"]["providerId"], "meta");
                    reply(&mut w, &id, json!({ "ok": true })).await;
                }
                "turn/start" => {
                    let sid = req["params"]["sessionId"].as_str().unwrap().to_string();
                    assert!(req["params"]["commandId"].as_str().is_some());
                    reply(&mut w, &id, json!({ "turnId": "muse-turn-7" })).await;

                    notif(
                        &mut w,
                        "turn/started",
                        json!({ "sessionId": sid, "turnId": "muse-turn-7" }),
                    )
                    .await;
                    notif(
                        &mut w,
                        "item/started",
                        json!({
                            "sessionId": sid,
                            "turnId": "muse-turn-7",
                            "item": {
                                "itemId": "tool-1",
                                "kind": "toolCall",
                                "toolName": "Bash",
                                "input": { "command": "cargo test" }
                            }
                        }),
                    )
                    .await;
                    notif(
                        &mut w,
                        "item/completed",
                        json!({
                            "sessionId": sid,
                            "turnId": "muse-turn-7",
                            "item": {
                                "itemId": "tool-1",
                                "kind": "toolCall",
                                "toolName": "Bash",
                                "status": "completed",
                                "output": "test result: ok"
                            }
                        }),
                    )
                    .await;
                    notif(
                        &mut w,
                        "item/delta",
                        json!({
                            "sessionId": sid,
                            "turnId": "muse-turn-7",
                            "itemId": "msg-1",
                            "kind": "assistantMessage",
                            "delta": "Hello Muse"
                        }),
                    )
                    .await;
                    notif(
                        &mut w,
                        "session/todoListChanged",
                        json!({
                            "sessionId": sid,
                            "items": [
                                { "id": "t1", "content": "Run checks", "status": "in_progress" }
                            ]
                        }),
                    )
                    .await;
                    notif(
                        &mut w,
                        "usage/changed",
                        json!({
                            "sessionId": sid,
                            "quota": {
                                "planName": "Meta Pro",
                                "windows": [
                                    { "windowType": "five_hour", "usedPercent": 35.0, "resetsAt": 1_800_000_000 }
                                ]
                            }
                        }),
                    )
                    .await;
                    notif(
                        &mut w,
                        "turn/completed",
                        json!({
                            "sessionId": sid,
                            "turnId": "muse-turn-7",
                            "status": "completed",
                            "usage": {
                                "inputTokens": 120,
                                "outputTokens": 45,
                                "cacheReadTokens": 20
                            }
                        }),
                    )
                    .await;
                }
                "turn/steer" => {
                    assert_eq!(req["params"]["expectedTurnId"], "muse-turn-7");
                    reply(&mut w, &id, json!({ "turnId": "muse-turn-7" })).await;
                }
                "turn/interrupt" => {
                    assert_eq!(req["params"]["turnId"], "muse-turn-7");
                    reply(&mut w, &id, json!({ "interrupted": true })).await;
                    break;
                }
                _ => {}
            }
        }
    });

    app.handshake().await.expect("handshake succeeds");
    assert!(app.supports_session_mcp());
    assert_eq!(app.muse_home().as_deref(), Some("/tmp/muse-home"));

    let driver = MuseNativeDriver::new();
    let handle = driver.bind_existing_server(spec.clone(), Arc::clone(&app), None);

    let models = driver.list_models(&handle).await.unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].id, "muse-2");

    let prompt_uuid = Uuid::new_v4();
    let blocks = vec![ContentBlock::Text {
        text: "Run checks".into(),
    }];
    let events: Vec<EngineEvent> = driver
        .send_prompt(
            &handle,
            EnginePromptRequest {
                prompt_id: prompt_uuid,
                blocks: blocks.clone(),
                session_id: Some("muse-native-placeholder".into()),
                mode: PromptMode::Normal,
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .collect()
        .await;

    assert!(events.iter().any(|e| matches!(
        e,
        EngineEvent::SessionInitialized { session_id: Some(sid), .. } if sid == "muse-sess-1"
    )));
    assert!(events.iter().any(|e| matches!(
        e,
        EngineEvent::AssistantTextDelta { text, .. } if text == "Hello Muse"
    )));
    assert!(events.iter().any(|e| matches!(
        e,
        EngineEvent::ToolCall { tool_use_id: Some(id), .. } if id == "tool-1"
    )));
    assert!(events.iter().any(|e| matches!(
        e,
        EngineEvent::PlanUpdated { entries, .. } if entries.len() == 1 && entries[0].content == "Run checks"
    )));
    assert!(driver.rate_limits(&handle).is_some());

    // Prompt mismatch rejection
    let rejected = driver
        .steer(
            &handle,
            EngineSteerRequest {
                steering_id: Uuid::new_v4(),
                expected_prompt_id: Some(Uuid::new_v4()),
                session_id: None,
                blocks: blocks.clone(),
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        rejected,
        EngineSteerReceipt::Rejected { ref code, .. } if code == "turn_mismatch"
    ));

    // Valid steer
    let accepted = driver
        .steer(
            &handle,
            EngineSteerRequest {
                steering_id: Uuid::new_v4(),
                expected_prompt_id: Some(prompt_uuid),
                session_id: None,
                blocks: blocks.clone(),
            },
        )
        .await
        .unwrap();
    assert!(matches!(accepted, EngineSteerReceipt::Accepted { .. }));

    // Resume an existing session
    let resumed_handle =
        driver.bind_existing_server(spec, Arc::clone(&app), Some("muse-sess-resumed".into()));
    let resume_events: Vec<EngineEvent> = driver
        .send_prompt(
            &resumed_handle,
            EnginePromptRequest {
                prompt_id: Uuid::new_v4(),
                blocks,
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .collect()
        .await;
    assert!(resume_events.iter().any(|e| matches!(
        e,
        EngineEvent::SessionInitialized { session_id: Some(sid), .. } if sid == "muse-sess-resumed"
    )));

    driver.interrupt(&handle).await.unwrap();
    mock_peer.await.expect("mock peer finished cleanly");
}

#[tokio::test]
async fn muse_high_frequency_delta_burst_is_lossless() {
    const DELTA_COUNT: usize = 2_500;
    let (client_io, server_io) = tokio::io::duplex(256 * 1024);
    let (client_read, client_write) = tokio::io::split(client_io);
    let (server_read, mut w) = tokio::io::split(server_io);

    let mock_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let req: Value = serde_json::from_str(&line).unwrap();
            let method = req.get("method").and_then(Value::as_str).unwrap_or("");
            let id = req.get("id").cloned();
            match method {
                "initialize" => {
                    reply(
                        &mut w,
                        &id,
                        json!({ "schema": { "version": 1 }, "grantedCapabilities": [] }),
                    )
                    .await;
                }
                "session/start" => {
                    reply(
                        &mut w,
                        &id,
                        json!({ "session": { "sessionId": "burst-s" } }),
                    )
                    .await;
                }
                "turn/start" => {
                    reply(&mut w, &id, json!({ "turnId": "burst-t" })).await;
                    for idx in 0..DELTA_COUNT {
                        notif(
                            &mut w,
                            "item/delta",
                            json!({
                                "sessionId": "burst-s",
                                "turnId": "burst-t",
                                "itemId": "m1",
                                "kind": "assistantMessage",
                                "delta": format!("{idx};")
                            }),
                        )
                        .await;
                    }
                    notif(
                        &mut w,
                        "turn/completed",
                        json!({ "sessionId": "burst-s", "turnId": "burst-t", "status": "completed" }),
                    )
                    .await;
                    break;
                }
                _ => {}
            }
        }
    });

    let (driver, handle) =
        MuseNativeDriver::connect_duplex(test_start_spec(), client_read, client_write, None)
            .await
            .unwrap();

    let events: Vec<EngineEvent> = driver
        .send_prompt(
            &handle,
            EnginePromptRequest {
                prompt_id: Uuid::new_v4(),
                blocks: vec![ContentBlock::Text {
                    text: "burst".into(),
                }],
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .collect()
        .await;

    let deltas: Vec<&str> = events
        .iter()
        .filter_map(|ev| match ev {
            EngineEvent::AssistantTextDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(deltas.len(), DELTA_COUNT);
    assert_eq!(deltas.first().copied(), Some("0;"));
    assert_eq!(deltas.last().copied(), Some("2499;"));
    mock_peer.await.unwrap();
}

#[tokio::test]
async fn muse_bidirectional_approval_user_input_and_subagent_auto_approve() {
    let (client_io, server_io) = tokio::io::duplex(128 * 1024);
    let (client_read, client_write) = tokio::io::split(client_io);
    let (server_read, mut w) = tokio::io::split(server_io);

    let (auto_done_tx, auto_done_rx) = tokio::sync::oneshot::channel::<Value>();
    let mock_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        let mut auto_done_tx = Some(auto_done_tx);
        while let Ok(Some(line)) = lines.next_line().await {
            let req: Value = serde_json::from_str(&line).unwrap();
            let method = req.get("method").and_then(Value::as_str).unwrap_or("");
            let id = req.get("id").cloned();
            match method {
                "initialize" => {
                    reply(
                        &mut w,
                        &id,
                        json!({ "schema": { "version": 1 }, "grantedCapabilities": ["sessionMcp"] }),
                    )
                    .await;
                }
                "session/start" => {
                    reply(&mut w, &id, json!({ "session": { "sessionId": "appr-s" } })).await;
                }
                "turn/start" => {
                    reply(&mut w, &id, json!({ "turnId": "appr-t" })).await;
                    // 1) Interactive approval
                    notif(
                        &mut w,
                        "approval/requested",
                        json!({
                            "sessionId": "appr-s",
                            "turnId": "appr-t",
                            "approvalId": "ap-1",
                            "toolName": "Bash",
                            "currentRequirementId": { "approvalId": "ap-1", "sourceIndex": 0 },
                            "subject": { "kind": "command", "command": "rm -rf tmp" },
                            "availableChoices": [
                                { "choiceId": "allow_once", "label": "Allow once", "decision": "allow", "scope": "once" },
                                { "choiceId": "deny_once", "label": "Deny", "decision": "deny", "scope": "once" }
                            ]
                        }),
                    )
                    .await;
                }
                "approval/decide" => {
                    let appr_id = req["params"]["approvalId"].as_str().unwrap_or("");
                    reply(&mut w, &id, json!({ "ok": true })).await;
                    if appr_id == "ap-1" {
                        assert_eq!(req["params"]["choiceId"], "allow_once");
                        assert_eq!(
                            req["params"]["requirementId"],
                            json!({ "approvalId": "ap-1", "sourceIndex": 0 })
                        );
                        // 2) Send a userInput request
                        notif(
                            &mut w,
                            "userInput/requested",
                            json!({
                                "sessionId": "appr-s",
                                "turnId": "appr-t",
                                "userInputId": "ui-1",
                                "questions": [
                                    {
                                        "id": "q1",
                                        "header": "Framework",
                                        "question": "Which framework?",
                                        "selection": { "mode": "single" },
                                        "options": [
                                            { "label": "React", "description": "React UI" },
                                            { "label": "Vue", "description": "Vue UI" }
                                        ]
                                    }
                                ]
                            }),
                        )
                        .await;
                    } else if appr_id == "ap-subagent" {
                        if let Some(tx) = auto_done_tx.take() {
                            let _ = tx.send(req["params"].clone());
                        }
                        notif(
                            &mut w,
                            "turn/completed",
                            json!({ "sessionId": "appr-s", "turnId": "appr-t", "status": "completed" }),
                        )
                        .await;
                        break;
                    }
                }
                "userInput/answer" => {
                    assert_eq!(req["params"]["userInputId"], "ui-1");
                    assert_eq!(req["params"]["answers"][0]["questionId"], "q1");
                    assert_eq!(req["params"]["answers"][0]["selectedLabel"], "React");
                    reply(&mut w, &id, json!({ "ok": true })).await;
                    // 3) Subagent approval while session is marked full-access
                    notif(
                        &mut w,
                        "approval/requested",
                        json!({
                            "sessionId": "appr-s",
                            "turnId": "appr-t",
                            "approvalId": "ap-subagent",
                            "subagentOrigin": { "agentId": "worker-1" },
                            "toolName": "Bash",
                            "currentRequirementId": { "approvalId": "ap-subagent", "sourceIndex": 0 },
                            "availableChoices": [
                                { "choiceId": "allow_sub", "label": "Allow", "decision": "allow", "scope": "once" }
                            ]
                        }),
                    )
                    .await;
                }
                _ => {}
            }
        }
    });

    let spec = test_start_spec();
    let server = MuseServer::connect_over_io_with_stderr(
        spec.workspace_id,
        false,
        client_read,
        client_write,
        None,
        None,
        Arc::new(StderrTail::new()),
    );
    server.handshake().await.unwrap();
    let driver = MuseNativeDriver::new();
    let handle = driver.bind_existing_server(spec, Arc::clone(&server), None);

    let mut stream = driver
        .send_prompt(
            &handle,
            EnginePromptRequest {
                prompt_id: Uuid::new_v4(),
                blocks: vec![ContentBlock::Text { text: "go".into() }],
                ..Default::default()
            },
        )
        .await
        .unwrap();

    let mut saw_perm = false;
    let mut saw_question = false;
    while let Some(ev) = stream.next().await {
        match ev {
            EngineEvent::PermissionRequested {
                permission_id,
                options,
                ..
            } => {
                assert_eq!(permission_id, "ap-1");
                assert_eq!(options.len(), 2);
                saw_perm = true;
                driver
                    .respond_permission(
                        &handle,
                        EnginePermissionDecision {
                            permission_id,
                            approved: true,
                            option_id: Some("allow_once".into()),
                            updated_input: None,
                            message: None,
                            interrupt: false,
                        },
                    )
                    .await
                    .unwrap();
            }
            EngineEvent::QuestionRequested { request_id, .. } => {
                assert_eq!(request_id, "ui-1");
                saw_question = true;
                // Enable full-access on session before answering so subagent approval auto-approves
                server.set_session_full_access("appr-s", true);
                driver
                    .respond_question(&handle, &request_id, json!({ "q1": "React" }), false)
                    .await
                    .unwrap();
            }
            _ => {}
        }
    }

    assert!(saw_perm);
    assert!(saw_question);
    let auto_params = auto_done_rx.await.expect("subagent auto-approve executed");
    assert_eq!(auto_params["choiceId"], "allow_sub");
    mock_peer.await.unwrap();
}

#[test]
fn muse_session_mcp_wire_schema_is_strictly_compliant() {
    let raw = json!({
        "local_tool": {
            "command": "npx",
            "args": ["-y", "@example/mcp"],
            "env": { "API_KEY": "secret" },
            "cwd": "/tmp",
            "forbiddenExtra": true
        },
        "remote_http": {
            "type": "http",
            "url": "https://mcp.example.com/rpc",
            "headers": { "Authorization": "Bearer abc" },
            "extraField": 123
        },
        "unsupported_sse": {
            "type": "sse",
            "url": "https://mcp.example.com/sse"
        }
    });

    let serialized = serialize_muse_session_mcp(&raw).expect("non-empty mcp config");
    let servers = serialized["mcpServers"]
        .as_object()
        .expect("mcpServers map");
    assert_eq!(servers.len(), 2);
    assert!(!servers.contains_key("unsupported_sse"));

    let local = servers["local_tool"].as_object().unwrap();
    assert_eq!(
        local.get("transport").and_then(Value::as_str),
        Some("stdio")
    );
    assert_eq!(local.get("command").and_then(Value::as_str), Some("npx"));
    assert!(!local.contains_key("forbiddenExtra"));

    let remote = servers["remote_http"].as_object().unwrap();
    assert_eq!(
        remote.get("transport").and_then(Value::as_str),
        Some("streamableHttp")
    );
    assert_eq!(
        remote.get("url").and_then(Value::as_str),
        Some("https://mcp.example.com/rpc")
    );
    assert!(!remote.contains_key("extraField"));
}

#[test]
fn muse_launch_env_scrubs_api_key_in_subscription_mode_and_disables_auto_update() {
    let mut snapshot = HashMap::new();
    snapshot.insert("META_API_KEY".to_string(), "sk-meta-secret".to_string());
    let mut launch = HashMap::new();
    let mut scrubbed = Vec::new();

    prepare_muse_launch_env(
        Path::new("/usr/local/bin/muse"),
        &snapshot,
        &mut launch,
        &mut scrubbed,
    );
    assert_eq!(
        launch.get("MUSE_NO_AUTO_UPDATE").map(String::as_str),
        Some("1")
    );
    assert!(scrubbed.iter().any(|k| k == "META_API_KEY"));
    assert!(!launch.contains_key("META_API_KEY"));

    // Explicit API key mode preserves META_API_KEY
    let mut api_launch = HashMap::new();
    api_launch.insert("META_API_KEY".to_string(), "sk-explicit".to_string());
    let mut api_scrubbed = Vec::new();
    prepare_muse_launch_env(
        Path::new("/usr/local/bin/muse"),
        &snapshot,
        &mut api_launch,
        &mut api_scrubbed,
    );
    assert_eq!(
        api_launch.get("META_API_KEY").map(String::as_str),
        Some("sk-explicit")
    );
    assert!(api_scrubbed.is_empty());
}

#[test]
fn muse_helpers_cover_uuid_v7_verbatim_paths_models_inputs_and_cache_key() {
    let id = mint_uuid_v7();
    let parsed = Uuid::parse_str(&id).expect("valid uuid");
    assert_eq!(parsed.get_version_num(), 7);

    assert_eq!(
        to_windows_verbatim_path(r"C:\Users\dev\repo"),
        r"\\?\C:\Users\dev\repo"
    );
    assert_eq!(
        to_windows_verbatim_path(r"\\server\share\repo"),
        r"\\?\UNC\server\share\repo"
    );
    assert_eq!(
        to_windows_verbatim_path(r"\\?\C:\already"),
        r"\\?\C:\already"
    );

    assert_eq!(muse_approval_mode(Some("default")), "promptUnmatched");
    assert_eq!(muse_approval_mode(Some("full-access")), "allowAll");
    assert_eq!(muse_permission_profile(Some("default")), ":ask-me");
    assert_eq!(muse_permission_profile(Some("yolo")), ":unrestricted");

    let models = parse_muse_models_response(&json!({
        "models": [
            { "modelId": "muse-2-mini", "providerId": "meta" },
            { "modelId": "claude-opus", "providerId": "anthropic" }
        ]
    }));
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].id, "muse-2-mini");
    assert_eq!(models[0].label, "Muse 2 Mini");

    let (items, display) = serialize_muse_input_items(
        &[
            ContentBlock::Text {
                text: "Inspect this".into(),
            },
            ContentBlock::Image {
                data: "aGVsbG8=".into(),
                mime_type: "image/png".into(),
                uri: None,
                width: None,
                height: None,
            },
        ],
        PromptMode::Normal,
    );
    assert_eq!(display, "Inspect this");
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["type"], "text");
    assert_eq!(items[1]["type"], "image");

    let pending_ui = PendingMuseUserInput {
        user_input_id: "u1".into(),
        session_id: "s1".into(),
        turn_id: None,
        questions: vec![
            MuseQuestionSpec {
                id: "q_single".into(),
                question: "Pick one".into(),
                multi_select: false,
                option_labels: vec!["A".into(), "B".into()],
            },
            MuseQuestionSpec {
                id: "q_multi".into(),
                question: "Pick many".into(),
                multi_select: true,
                option_labels: vec!["X".into(), "Y".into()],
            },
            MuseQuestionSpec {
                id: "q_free".into(),
                question: "Custom".into(),
                multi_select: false,
                option_labels: vec!["Preset".into()],
            },
        ],
    };
    let answers = build_muse_user_input_answers(
        &pending_ui,
        &json!({
            "q_single": "A",
            "q_multi": ["X", "Y"],
            "q_free": "something custom"
        }),
        false,
    );
    assert_eq!(
        answers[0],
        json!({ "questionId": "q_single", "selectedLabel": "A" })
    );
    assert_eq!(
        answers[1],
        json!({ "questionId": "q_multi", "selectedLabels": ["X", "Y"] })
    );
    assert_eq!(
        answers[2],
        json!({ "questionId": "q_free", "freeText": "something custom" })
    );

    let rl = parse_muse_rate_limits_payload(&json!({
        "quota": {
            "planName": "Pro",
            "windows": [
                { "windowType": "five_hour", "usedPercent": 20.0, "resetsAt": 1_750_000_000 },
                { "windowType": "seven_day", "usedPercent": 50.0, "resetsAt": 1_750_500_000 }
            ]
        }
    }))
    .expect("rate limits parsed");
    assert_eq!(rl.plan_type.as_deref(), Some("Pro"));
    assert!(rl.utilization.is_some());
    assert!(rl.reset_at.is_some());

    // Cache key distinguishes sandbox mode & config fingerprint
    let tmp = tempfile::tempdir().unwrap();
    let cfg_dir = tmp.path().join("muse");
    std::fs::create_dir_all(&cfg_dir).unwrap();
    std::fs::write(
        cfg_dir.join("settings.json"),
        r#"{"schema_version":1,"model":"muse-2"}"#,
    )
    .unwrap();
    let mut spec = test_start_spec();
    spec.env.insert(
        "XDG_CONFIG_HOME".to_string(),
        tmp.path().to_string_lossy().into_owned(),
    );
    let key_sandboxed = MuseServerCacheKey::from_spec(&spec, false);
    let key_unrestricted = MuseServerCacheKey::from_spec(&spec, true);
    assert_ne!(key_sandboxed, key_unrestricted);

    std::fs::write(
        cfg_dir.join("settings.json"),
        r#"{"schema_version":1,"model":"muse-2-pro"}"#,
    )
    .unwrap();
    let key_after_edit = MuseServerCacheKey::from_spec(&spec, false);
    assert_ne!(key_sandboxed, key_after_edit);

    // StderrTail redaction & 64 KiB cap
    let tail = StderrTail::new();
    tail.push("META_API_KEY=meta_secret_token_1234567890\n");
    for _ in 0..2000 {
        tail.push("0123456789abcdef0123456789abcdef0123456789abcdef\n");
    }
    let snapshot = tail.summary().unwrap_or_default();
    assert!(!snapshot.contains("meta_secret_token_1234567890"));
    assert!(snapshot.len() <= 64 * 1024 + 256);

    // Empty free-text answer without options must never send empty `freeText: ""`
    let free_only = PendingMuseUserInput {
        user_input_id: "ui-empty".into(),
        session_id: "s-empty".into(),
        turn_id: None,
        questions: vec![MuseQuestionSpec {
            id: "q_blank".into(),
            question: "Any note?".into(),
            multi_select: false,
            option_labels: vec![],
        }],
    };
    let blank_answers = build_muse_user_input_answers(&free_only, &json!({}), false);
    assert_eq!(blank_answers.len(), 1);
    let sent_free = blank_answers[0]["freeText"].as_str().unwrap_or("");
    assert!(!sent_free.is_empty());
}

#[tokio::test]
async fn muse_compact_accepted_and_noop_terminate_and_unloaded_permission_mode_skips_rpc() {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let (client_read, client_write) = tokio::io::split(client_io);
    let (server_read, mut w) = tokio::io::split(server_io);

    let spec = test_start_spec();
    let app = MuseServer::connect_over_io_with_stderr(
        spec.workspace_id,
        false,
        client_read,
        client_write,
        None,
        None,
        Arc::new(StderrTail::new()),
    );

    let mock_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        let mut compact_calls = 0_u32;
        let mut saw_set_approval_mode_on_unloaded = false;
        while let Ok(Some(line)) = lines.next_line().await {
            let req: Value = serde_json::from_str(&line).unwrap();
            let method = req.get("method").and_then(Value::as_str).unwrap_or("");
            let id = req.get("id").cloned();
            match method {
                "initialize" => {
                    reply(
                        &mut w,
                        &id,
                        json!({ "schema": { "version": 1 }, "grantedCapabilities": [] }),
                    )
                    .await;
                }
                "session/start" => {
                    reply(
                        &mut w,
                        &id,
                        json!({ "session": { "sessionId": "compact-s", "modelId": "muse-2" } }),
                    )
                    .await;
                }
                "session/setApprovalMode" => {
                    let sid = req["params"]["sessionId"].as_str().unwrap_or("");
                    if sid == "unloaded-s" {
                        saw_set_approval_mode_on_unloaded = true;
                    }
                    reply(&mut w, &id, json!({})).await;
                }
                "session/compact" => {
                    compact_calls += 1;
                    if compact_calls == 1 {
                        reply(&mut w, &id, json!({ "status": "accepted" })).await;
                        notif(
                            &mut w,
                            "item/started",
                            json!({
                                "sessionId": "compact-s",
                                "item": {
                                    "itemId": "cmp-1",
                                    "kind": "compaction",
                                    "status": "inProgress",
                                    "revision": 1
                                }
                            }),
                        )
                        .await;
                        notif(
                            &mut w,
                            "item/completed",
                            json!({
                                "sessionId": "compact-s",
                                "item": {
                                    "itemId": "cmp-1",
                                    "kind": "compaction",
                                    "status": "completed",
                                    "outcome": "compacted",
                                    "revision": 2
                                }
                            }),
                        )
                        .await;
                    } else {
                        reply(
                            &mut w,
                            &id,
                            json!({ "status": "noop", "reason": "Nothing to compact" }),
                        )
                        .await;
                    }
                }
                "turn/interrupt" => {
                    reply(&mut w, &id, json!({})).await;
                    break;
                }
                _ => {
                    if id.is_some() {
                        reply(&mut w, &id, json!({})).await;
                    }
                }
            }
        }
        assert!(
            !saw_set_approval_mode_on_unloaded,
            "session/setApprovalMode must not be sent for an unloaded session"
        );
    });

    app.handshake().await.expect("handshake succeeds");

    let driver = MuseNativeDriver::new();

    // 1. set_permission_mode on a handle whose session is not loaded on this server must succeed without RPC
    let unloaded_handle =
        driver.bind_existing_server(spec.clone(), Arc::clone(&app), Some("unloaded-s".into()));
    driver
        .set_permission_mode(&unloaded_handle, "default")
        .await
        .expect("set_permission_mode on unloaded session succeeds");

    // 2. PromptMode::Compact accepted -> completes when compaction item completes
    let handle = driver.bind_existing_server(spec, Arc::clone(&app), None);
    let accepted_events: Vec<EngineEvent> = driver
        .send_prompt(
            &handle,
            EnginePromptRequest {
                prompt_id: Uuid::new_v4(),
                blocks: vec![],
                mode: PromptMode::Compact,
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .collect()
        .await;
    assert!(accepted_events.iter().any(|e| matches!(
        e,
        EngineEvent::AutoCompactionChanged {
            in_progress: true,
            ..
        }
    )));
    assert!(accepted_events.iter().any(|e| matches!(
        e,
        EngineEvent::AutoCompactionChanged {
            in_progress: false,
            ..
        }
    )));
    assert!(
        accepted_events
            .iter()
            .any(|e| matches!(e, EngineEvent::TurnCompleted { .. }))
    );

    // 3. PromptMode::Compact noop -> terminates immediately with TurnError without hanging
    let noop_events: Vec<EngineEvent> = driver
        .send_prompt(
            &handle,
            EnginePromptRequest {
                prompt_id: Uuid::new_v4(),
                blocks: vec![],
                mode: PromptMode::Compact,
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .collect()
        .await;
    assert!(noop_events.iter().any(|e| matches!(
        e,
        EngineEvent::TurnError { message, .. } if message.contains("Nothing to compact")
    )));

    driver.interrupt(&handle).await.unwrap();
    drop(driver);
    drop(handle);
    drop(unloaded_handle);
    drop(app);
    mock_peer.await.expect("mock peer finished cleanly");
}
