use futures::StreamExt;
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use super::*;
use crate::engine::codex_protocol::command_approval_options;

fn test_start_spec() -> EngineStartSpec {
    EngineStartSpec {
        workspace_id: Uuid::new_v4(),
        working_dir: PathBuf::from("."),
        model: Some("gpt-5-codex".to_string()),
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
async fn codex_native_driver_streams_deltas_resumes_steers_with_real_turn_id_and_rolls_back() {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let (client_read, client_write) = tokio::io::split(client_io);
    let (server_read, mut w) = tokio::io::split(server_io);

    let spec = test_start_spec();
    let app = CodexAppServer::connect_over_io(spec.workspace_id, client_read, client_write, None);

    let mock_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let req: Value = serde_json::from_str(&line).expect("valid jsonrpc");
            let method = req.get("method").and_then(Value::as_str).unwrap_or("");
            let id = req.get("id").cloned();

            match method {
                "initialize" => {
                    assert_eq!(req["params"]["capabilities"]["experimentalApi"], true);
                    reply(&mut w, &id, json!({ "serverInfo": { "name": "codex" } })).await;
                }
                "initialized" => {}
                "thread/start" => {
                    reply(&mut w, &id, json!({ "thread": { "id": "thr-1" } })).await;
                }
                "thread/resume" => {
                    assert_eq!(req["params"]["threadId"], "thr-resumed-99");
                    reply(
                        &mut w,
                        &id,
                        json!({ "thread": { "id": "thr-resumed-99", "model": "gpt-5.4" } }),
                    )
                    .await;
                }
                "turn/start" => {
                    let tid = req["params"]["threadId"]
                        .as_str()
                        .unwrap_or("thr-1")
                        .to_string();
                    reply(
                        &mut w,
                        &id,
                        json!({ "turn": { "id": "codex-turn-real-7" } }),
                    )
                    .await;
                    let thr = json!({ "threadId": tid });
                    let msg = json!({ "threadId": tid, "itemId": "msg-1", "delta": "Hello Codex" });
                    let cmd =
                        json!({ "threadId": tid, "itemId": "cmd-1", "delta": "cargo test ok\n" });
                    let rl = json!({
                        "rateLimits": {
                            "planType": "pro",
                            "primary": { "usedPercent": 42.0, "resetsAt": 1_800_000_000.0 },
                            "credits": { "balance": "19.5" }
                        }
                    });
                    let done = json!({
                        "threadId": tid,
                        "turn": { "id": "codex-turn-real-7", "status": "completed", "model": "gpt-5-codex" }
                    });
                    notif(&mut w, "thread/compaction/started", thr.clone()).await;
                    notif(&mut w, "thread/compaction/completed", thr).await;
                    notif(&mut w, "item/agentMessage/delta", msg).await;
                    notif(&mut w, "item/commandExecution/outputDelta", cmd).await;
                    notif(&mut w, "account/rateLimits/updated", rl).await;
                    notif(&mut w, "turn/completed", done).await;
                }
                "turn/steer" => {
                    assert_eq!(req["params"]["expectedTurnId"], "codex-turn-real-7");
                    reply(&mut w, &id, json!({ "turnId": "codex-turn-real-7" })).await;
                }
                "thread/turns/list" => {
                    let res = json!({
                        "turns": [{ "id": "turn-8", "status": "completed" }],
                        "nextBeforeTurnId": "turn-7",
                        "hasMore": true
                    });
                    reply(&mut w, &id, res).await;
                }
                "thread/fork" => reply(&mut w, &id, json!({ "threadId": "thr-forked" })).await,
                "thread/rollback" => {
                    assert_eq!(req["params"]["beforeTurnId"], "turn-2");
                    reply(&mut w, &id, json!({ "rolledBack": true })).await;
                    break;
                }
                _ => {}
            }
        }
    });

    app.handshake().await.expect("handshake succeeds");
    let driver = CodexNativeDriver::new();
    let handle = driver.bind_existing_server(spec.clone(), Arc::clone(&app), None);

    let prompt_uuid = Uuid::new_v4();
    let blocks = vec![ContentBlock::Text {
        text: "Run tests".into(),
    }];
    let req = EnginePromptRequest {
        prompt_id: prompt_uuid,
        blocks: blocks.clone(),
        session_id: Some("prepared-123".into()),
        mode: PromptMode::Normal,
        ..Default::default()
    };
    let events: Vec<EngineEvent> = driver
        .send_prompt(&handle, req)
        .await
        .unwrap()
        .collect()
        .await;
    assert!(events.iter().any(|e| matches!(
        e,
        EngineEvent::SessionInitialized { session_id: Some(sid), .. } if sid == "thr-1"
    )));
    assert!(events.iter().any(
        |e| matches!(e, EngineEvent::AssistantTextDelta { text, .. } if text == "Hello Codex")
    ));

    let steer = EngineSteerRequest {
        steering_id: Uuid::new_v4(),
        expected_prompt_id: Some(prompt_uuid),
        session_id: None,
        blocks: blocks.clone(),
    };
    let receipt = driver.steer(&handle, steer).await.unwrap();
    assert!(matches!(receipt, EngineSteerReceipt::Accepted { .. }));

    let resumed_handle =
        driver.bind_existing_server(spec, Arc::clone(&app), Some("thr-resumed-99".into()));
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
        EngineEvent::SessionInitialized { session_id: Some(sid), .. } if sid == "thr-resumed-99"
    )));

    let page = driver
        .list_thread_turns(&handle, true, Some("turn-9"), Some(20))
        .await
        .unwrap();
    assert_eq!(page.turns.len(), 1);

    let forked = driver
        .fork_session(
            &handle,
            EngineForkRequest {
                checkpoint_point: Some("turn-2".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(forked.forked_session_id, "thr-forked");

    driver
        .revert_to(
            &handle,
            EngineCheckpoint {
                turn_ordinal: 2,
                external_session_point: Some("turn-2".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    mock_peer.await.expect("mock peer finished cleanly");
}

#[test]
fn serialize_codex_input_items_encodes_base64_image_url_and_local_image_path() {
    let items = serialize_codex_input_items(
        &[
            ContentBlock::Image {
                data: "aGVsbG8=".into(),
                mime_type: "image/png".into(),
                uri: None,
                width: None,
                height: None,
            },
            ContentBlock::Image {
                data: String::new(),
                mime_type: "image/jpeg".into(),
                uri: Some("file:///C:/tmp/screen.jpg".into()),
                width: None,
                height: None,
            },
        ],
        PromptMode::Normal,
    );
    assert_eq!(
        items[0],
        json!({ "type": "image", "url": "data:image/png;base64,aGVsbG8=" })
    );
    assert_eq!(items[1]["type"], "localImage");
    assert!(
        items[1]["path"]
            .as_str()
            .unwrap()
            .replace('\\', "/")
            .ends_with("C:/tmp/screen.jpg")
    );
}

#[test]
fn parse_codex_models_response_preserves_is_default_and_skips_hidden_non_default() {
    let payload = json!({
        "data": [
            {
                "id": "gpt-5.4",
                "displayName": "GPT-5.4",
                "description": "Default model",
                "isDefault": true,
                "hidden": false
            },
            {
                "id": "gpt-hidden-beta",
                "displayName": "Hidden Beta",
                "isDefault": false,
                "hidden": true
            },
            {
                "id": "gpt-hidden-default",
                "displayName": "Hidden Default",
                "isDefault": true,
                "hidden": true
            }
        ]
    });
    let models = crate::engine::codex_protocol::parse_codex_models_response(&payload);
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].id, "gpt-5.4");
    assert!(models[0].is_default);
    assert_eq!(models[1].id, "gpt-hidden-default");
    assert!(models[1].is_default);
}

#[tokio::test]
async fn codex_server_cache_key_tracks_codex_home_config_and_invalidate_clears_cache() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let codex_home = tmp.path().join(".codex");
    std::fs::create_dir_all(&codex_home).expect("mkdir");
    std::fs::write(codex_home.join("config.toml"), "model = \"gpt-5.3\"\n").expect("write config");
    std::fs::write(
        codex_home.join("auth.json"),
        "{\"OPENAI_API_KEY\":\"sk-1\"}",
    )
    .expect("write auth");

    let mut spec = test_start_spec();
    spec.env.insert(
        "CODEX_HOME".to_string(),
        codex_home.to_string_lossy().to_string(),
    );

    let key1 = CodexServerCacheKey::from_spec(&spec);
    std::fs::write(codex_home.join("config.toml"), "model = \"gpt-5.4\"\n").expect("update config");
    let key2 = CodexServerCacheKey::from_spec(&spec);
    assert_ne!(
        key1, key2,
        "editing CODEX_HOME/config.toml must change CodexServerCacheKey"
    );

    std::fs::write(
        codex_home.join("auth.json"),
        "{\"OPENAI_API_KEY\":\"sk-2\"}",
    )
    .expect("update auth");
    let key3 = CodexServerCacheKey::from_spec(&spec);
    assert_ne!(
        key2, key3,
        "editing CODEX_HOME/auth.json must change CodexServerCacheKey"
    );

    std::fs::write(
        codex_home.join("dimo-model-catalog.json"),
        "{\"models\":[]}",
    )
    .expect("write catalog");
    let key4 = CodexServerCacheKey::from_spec(&spec);
    assert_ne!(
        key3, key4,
        "editing dimo-model-catalog.json must change CodexServerCacheKey"
    );

    invalidate_codex_servers().await;
}

#[test]
fn codex_driver_accepts_model_id_filters_foreign_models_unless_custom_base_url() {
    let driver = CodexNativeDriver::new();
    let official = HashMap::new();
    assert!(driver.accepts_model_id("gpt-5.4", &official));
    assert!(driver.accepts_model_id("o4-mini", &official));
    assert!(!driver.accepts_model_id("claude-opus-4-6", &official));
    assert!(!driver.accepts_model_id("gemini-2.5-pro", &official));
    assert!(!driver.accepts_model_id("sonnet", &official));
    assert!(!driver.accepts_model_id("opus", &official));

    let mut custom = HashMap::new();
    custom.insert(
        "OPENAI_BASE_URL".to_string(),
        "https://proxy.example.com/v1".to_string(),
    );
    assert!(driver.accepts_model_id("claude-opus-4-6", &custom));
}

#[test]
fn codex_error_with_will_retry_emits_request_retrying_and_fatal_emits_turn_error() {
    let rl = Arc::new(RwLock::new(None));
    let comp = Arc::new(RwLock::new(HashMap::new()));

    let retry_top = normalize_codex_notification(
        "error",
        &json!({
            "threadId": "thr-1",
            "turnId": "turn-1",
            "willRetry": true,
            "error": {
                "message": "429 rate limited, retrying in 2s",
                "httpStatusCode": 429
            }
        }),
        &rl,
        &comp,
    );
    assert_eq!(retry_top.len(), 1);
    assert!(matches!(
        &retry_top[0],
        EngineEvent::RequestRetrying {
            session_id: Some(sid),
            delay_ms: Some(2000),
            code: Some(code),
            reason: Some(reason),
            ..
        } if sid == "thr-1" && code == "429" && reason.contains("429 rate limited")
    ));

    let retry_reconnecting = normalize_codex_notification(
        "error",
        &json!({
            "threadId": "thr-1",
            "error": {
                "message": "Reconnecting... 2/5",
                "willRetry": true
            }
        }),
        &rl,
        &comp,
    );
    assert!(matches!(
        &retry_reconnecting[0],
        EngineEvent::RequestRetrying {
            attempt: Some(2),
            max_attempts: Some(5),
            ..
        }
    ));

    let fatal = normalize_codex_notification(
        "error",
        &json!({
            "threadId": "thr-1",
            "willRetry": false,
            "error": { "message": "401 Unauthorized: invalid_api_key" }
        }),
        &rl,
        &comp,
    );
    assert!(matches!(
        &fatal[0],
        EngineEvent::TurnError { message, .. } if message.contains("invalid_api_key")
    ));
}

#[test]
fn codex_turn_completed_maps_failed_interrupted_and_completed_statuses() {
    let rl = Arc::new(RwLock::new(None));
    let comp = Arc::new(RwLock::new(HashMap::new()));

    let failed = normalize_codex_notification(
        "turn/completed",
        &json!({
            "threadId": "thr-1",
            "turn": {
                "id": "turn-fail",
                "status": "failed",
                "error": { "message": "Model context length exceeded" }
            }
        }),
        &rl,
        &comp,
    );
    assert!(matches!(
        failed.last(),
        Some(EngineEvent::TurnError { message, .. })
            if message == "Model context length exceeded"
    ));

    let interrupted = normalize_codex_notification(
        "turn/completed",
        &json!({
            "threadId": "thr-1",
            "turn": { "id": "turn-int", "status": "interrupted" }
        }),
        &rl,
        &comp,
    );
    assert!(matches!(
        interrupted.last(),
        Some(EngineEvent::TurnInterrupted { reason, .. }) if reason == "interrupted"
    ));

    let completed = normalize_codex_notification(
        "turn/completed",
        &json!({
            "threadId": "thr-1",
            "turn": { "id": "turn-ok", "status": "completed", "model": "gpt-5.4" }
        }),
        &rl,
        &comp,
    );
    assert!(matches!(
        completed.last(),
        Some(EngineEvent::TurnCompleted {
            stop_reason: Some(sr),
            served_model: Some(m),
            ..
        }) if sr == "end_turn" && m == "gpt-5.4"
    ));
}

#[test]
fn codex_token_usage_subtracts_cached_input_and_separates_total_spend_from_last_window() {
    let rl = Arc::new(RwLock::new(None));
    let comp = Arc::new(RwLock::new(HashMap::new()));

    let events = normalize_codex_notification(
        "thread/tokenUsage/updated",
        &json!({
            "threadId": "thr-1",
            "turnId": "turn-1",
            "tokenUsage": {
                "total": {
                    "inputTokens": 120_000,
                    "cachedInputTokens": 100_000,
                    "outputTokens": 5_000,
                    "totalTokens": 125_000
                },
                "last": {
                    "inputTokens": 45_000,
                    "cachedInputTokens": 40_000,
                    "outputTokens": 1_200,
                    "totalTokens": 46_200
                },
                "modelContextWindow": 272_000
            }
        }),
        &rl,
        &comp,
    );
    assert_eq!(events.len(), 1);
    match &events[0] {
        EngineEvent::UsageUpdated {
            input_tokens,
            cache_read_tokens,
            output_tokens,
            context_used,
            context_window,
            is_turn_summary,
            ..
        } => {
            assert_eq!(*input_tokens, Some(20_000));
            assert_eq!(*cache_read_tokens, Some(100_000));
            assert_eq!(*output_tokens, Some(5_000));
            assert_eq!(*context_used, Some(46_200));
            assert_eq!(*context_window, Some(272_000));
            assert!(!is_turn_summary);
        }
        other => panic!("expected UsageUpdated, got {other:?}"),
    }
}

#[tokio::test]
async fn mcp_tool_approval_elicitation_is_answered_with_action() {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let (client_read, client_write) = tokio::io::split(client_io);
    let (server_read, mut server_write) = tokio::io::split(server_io);
    let app = CodexAppServer::connect_over_io(Uuid::new_v4(), client_read, client_write, None);
    let mut events = app.subscribe_events();

    let observed = tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        let line = lines.next_line().await.unwrap().expect("client reply");
        serde_json::from_str::<Value>(&line).unwrap()
    });

    let request = json!({
        "jsonrpc": "2.0",
        "id": "elic-1",
        "method": "mcpServer/elicitation/request",
        "params": {
            "threadId": "thr-elic",
            "turnId": "turn-elic",
            "serverName": "dimo",
            "mode": "form",
            "message": "Allow the dimo MCP server to run tool \"manage_group\"?",
            "_meta": {
                "codex_approval_kind": "mcp_tool_call",
                "tool_name": "manage_group",
                "persist": "session"
            },
            "requestedSchema": { "type": "object", "properties": {} }
        }
    });
    server_write
        .write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
    server_write.flush().await.unwrap();

    let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
        .await
        .expect("elicitation event")
        .expect("event channel");
    let EngineEvent::PermissionRequested {
        permission_id,
        tool_name,
        options,
        ..
    } = event
    else {
        panic!("expected PermissionRequested, got {event:?}");
    };
    assert_eq!(tool_name, "dimo/manage_group");
    assert!(options.iter().any(|option| option.id == "acceptForSession"));

    app.respond_server_request(&EnginePermissionDecision {
        permission_id,
        approved: true,
        option_id: Some("acceptForSession".to_string()),
        updated_input: None,
        message: None,
        interrupt: false,
    })
    .await
    .unwrap();

    let reply = tokio::time::timeout(std::time::Duration::from_secs(2), observed)
        .await
        .expect("client reply")
        .expect("reader");
    assert_eq!(reply["id"], "elic-1");
    assert!(reply.get("error").is_none());
    assert_eq!(
        reply["result"],
        json!({
            "action": "accept",
            "content": {},
            "_meta": { "persist": "session" }
        })
    );
}

fn approval_params(persist: Value) -> Value {
    json!({
        "threadId": "thr",
        "turnId": "turn",
        "serverName": "dimo",
        "mode": "form",
        "message": "Allow the dimo MCP server to run tool \"list_spaces\"?",
        "_meta": {
            "codex_approval_kind": "mcp_tool_call",
            "tool_name": "list_spaces",
            "persist": persist
        },
        "requestedSchema": { "type": "object", "properties": {} }
    })
}

fn permission_decision(
    option_id: Option<&str>,
    approved: bool,
    interrupt: bool,
) -> EnginePermissionDecision {
    EnginePermissionDecision {
        permission_id: "perm".to_string(),
        approved,
        option_id: option_id.map(str::to_string),
        updated_input: None,
        message: None,
        interrupt,
    }
}

fn pending_codex_request(method: &str) -> PendingCodexServerRequest {
    PendingCodexServerRequest {
        raw_rpc_id: json!("rpc-1"),
        method: method.to_string(),
        thread_id: "thr".to_string(),
        prompt_id: Some("turn".to_string()),
        params: json!({}),
    }
}

#[test]
fn command_rule_round_trip_uses_the_offered_prefix() {
    let mut request = pending_codex_request("item/commandExecution/requestApproval");
    let rule =
        json!({"acceptWithExecpolicyAmendment": {"execpolicy_amendment": ["git", "status"]}});
    request.params = json!({"availableDecisions": ["accept", rule, "cancel"]});

    let options = command_approval_options(&request.params);
    let ids: Vec<_> = options.iter().map(|option| option.id.as_str()).collect();
    assert_eq!(ids, ["accept", "allow-prefix-1", "cancel"]);
    assert_eq!(options[1].label, "Remember command prefix");
    assert_eq!(options[1].description.as_deref(), Some("git status"));
    assert_eq!(options[2].label, "Cancel");

    let result = |id| {
        build_codex_server_request_result(&request, &permission_decision(Some(id), true, false)).0
    };
    assert_eq!(result("allow-prefix-1"), json!({"decision": rule}));
    assert_eq!(result("allow-prefix-0"), json!({"decision": "cancel"}));
    assert_eq!(result("allow-prefix-2"), json!({"decision": "cancel"}));
    assert_eq!(
        build_codex_server_request_result(
            &request,
            &permission_decision(Some("allow-prefix-1"), true, true),
        )
        .0,
        json!({"decision": "cancel"})
    );
}

#[test]
fn command_approval_options_falls_back_when_available_decisions_empty_or_unknown() {
    let empty = command_approval_options(&json!({"availableDecisions": []}));
    let unknown = command_approval_options(&json!({
        "availableDecisions": ["unknownDecision", {"other": {}}]
    }));
    let default_ids: Vec<_> = codex_approval_options()
        .into_iter()
        .map(|option| option.id)
        .collect();
    assert_eq!(
        empty.into_iter().map(|o| o.id).collect::<Vec<_>>(),
        default_ids
    );
    assert_eq!(
        unknown.into_iter().map(|o| o.id).collect::<Vec<_>>(),
        default_ids
    );
}

#[test]
fn mcp_tool_approval_elicitation_becomes_a_permission_card() {
    let params = approval_params(json!(["session", "always"]));
    let (permission_id, _record, event) =
        parse_codex_server_request("mcpServer/elicitation/request", &json!("srv-1"), &params)
            .expect("approval elicitation");
    assert_eq!(permission_id, "codex-mcp-elicitation-srv-1");
    match event {
        EngineEvent::PermissionRequested {
            tool_name,
            decision_reason,
            options,
            ..
        } => {
            assert_eq!(tool_name, "dimo/list_spaces");
            assert_eq!(
                decision_reason.as_deref(),
                Some("Allow the dimo MCP server to run tool \"list_spaces\"?")
            );
            let ids: Vec<_> = options.iter().map(|option| option.id.as_str()).collect();
            assert_eq!(
                ids,
                ["accept", "acceptForSession", "acceptAlways", "decline"]
            );
        }
        other => panic!("expected PermissionRequested, got {other:?}"),
    }
}

#[test]
fn filled_form_and_url_elicitations_stay_unhandled() {
    let mut form = approval_params(json!("session"));
    form["requestedSchema"]["properties"] = json!({
        "confirmed": { "type": "boolean" }
    });
    assert!(
        parse_codex_server_request("mcpServer/elicitation/request", &json!(1), &form).is_none()
    );

    let url = json!({
        "threadId": "thr",
        "serverName": "dimo",
        "mode": "url",
        "message": "Sign in",
        "url": "https://example.test",
        "elicitationId": "e1",
        "_meta": { "codex_approval_kind": "mcp_tool_call" }
    });
    assert!(parse_codex_server_request("mcpServer/elicitation/request", &json!(2), &url).is_none());

    let mut needs_input = approval_params(json!("session"));
    needs_input["_meta"]["codex_requires_user_input"] = json!(true);
    assert!(
        parse_codex_server_request("mcpServer/elicitation/request", &json!(3), &needs_input)
            .is_none()
    );
}

#[test]
fn mcp_tool_approval_reply_uses_action_not_decision() {
    let pending = pending_codex_request("mcpServer/elicitation/request");
    let (accept, behavior) = build_codex_server_request_result(
        &pending,
        &permission_decision(Some("accept"), true, false),
    );
    assert_eq!(behavior, "accept");
    assert_eq!(accept, json!({ "action": "accept", "content": {} }));

    let (session, _) = build_codex_server_request_result(
        &pending,
        &permission_decision(Some("acceptForSession"), true, false),
    );
    assert_eq!(
        session,
        json!({
            "action": "accept",
            "content": {},
            "_meta": { "persist": "session" }
        })
    );

    let (always, _) = build_codex_server_request_result(
        &pending,
        &permission_decision(Some("acceptAlways"), true, false),
    );
    assert_eq!(always["_meta"]["persist"], "always");
    assert!(always.get("decision").is_none());

    let (decline, behavior) = build_codex_server_request_result(
        &pending,
        &permission_decision(Some("decline"), false, false),
    );
    assert_eq!(behavior, "decline");
    assert_eq!(decline, json!({ "action": "decline" }));

    let (cancel, behavior) =
        build_codex_server_request_result(&pending, &permission_decision(None, false, true));
    assert_eq!(behavior, "cancel");
    assert_eq!(cancel, json!({ "action": "cancel" }));
}

#[test]
fn command_approval_reply_keeps_decision_field() {
    let (result, behavior) = build_codex_server_request_result(
        &pending_codex_request("item/commandExecution/requestApproval"),
        &permission_decision(Some("accept"), true, false),
    );
    assert_eq!(behavior, "accept");
    assert_eq!(result, json!({ "decision": "accept" }));
}

async fn reply_error<W: AsyncWrite + Unpin>(
    w: &mut W,
    id: &Option<Value>,
    code: i64,
    message: &str,
) {
    let line = format!(
        "{}\n",
        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
    );
    w.write_all(line.as_bytes()).await.unwrap();
}

#[tokio::test]
async fn codex_empty_rollout_resume_error_falls_back_to_thread_start() {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let (client_read, client_write) = tokio::io::split(client_io);
    let (server_read, mut w) = tokio::io::split(server_io);

    let spec = test_start_spec();
    let app = CodexAppServer::connect_over_io(spec.workspace_id, client_read, client_write, None);

    let mock_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        let mut saw_resume = false;
        let mut saw_start = false;
        while let Ok(Some(line)) = lines.next_line().await {
            let req: Value = serde_json::from_str(&line).expect("valid jsonrpc");
            let method = req.get("method").and_then(Value::as_str).unwrap_or("");
            let id = req.get("id").cloned();
            match method {
                "initialize" => {
                    reply(&mut w, &id, json!({ "serverInfo": { "name": "codex" } })).await;
                }
                "initialized" => {}
                "thread/resume" => {
                    saw_resume = true;
                    assert_eq!(req["params"]["threadId"], "thr-stale-empty");
                    reply_error(
                        &mut w,
                        &id,
                        -32603,
                        "failed to read thread: rollout at /home/user/.codex/sessions/rollout-empty.jsonl is empty",
                    )
                    .await;
                }
                "thread/start" => {
                    saw_start = true;
                    assert!(
                        saw_resume,
                        "thread/resume must be attempted before fallback"
                    );
                    reply(
                        &mut w,
                        &id,
                        json!({ "thread": { "id": "thr-recovered-42", "model": "gpt-5.4" } }),
                    )
                    .await;
                }
                "turn/start" => {
                    assert_eq!(req["params"]["threadId"], "thr-recovered-42");
                    reply(&mut w, &id, json!({ "turn": { "id": "turn-rec-1" } })).await;
                    notif(
                        &mut w,
                        "item/agentMessage/delta",
                        json!({
                            "threadId": "thr-recovered-42",
                            "itemId": "msg-1",
                            "delta": "Recovered cleanly"
                        }),
                    )
                    .await;
                    notif(
                        &mut w,
                        "turn/completed",
                        json!({
                            "threadId": "thr-recovered-42",
                            "turn": { "id": "turn-rec-1", "status": "completed", "model": "gpt-5.4" }
                        }),
                    )
                    .await;
                    break;
                }
                _ => {}
            }
        }
        assert!(saw_resume && saw_start);
    });

    app.handshake().await.expect("handshake succeeds");
    let driver = CodexNativeDriver::new();
    let handle =
        driver.bind_existing_server(spec, Arc::clone(&app), Some("thr-stale-empty".into()));

    let events: Vec<EngineEvent> = driver
        .send_prompt(
            &handle,
            EnginePromptRequest {
                prompt_id: Uuid::new_v4(),
                blocks: vec![ContentBlock::Text {
                    text: "Continue our work".into(),
                }],
                ..Default::default()
            },
        )
        .await
        .expect("fallback to thread/start should succeed")
        .collect()
        .await;

    assert_eq!(
        handle.external_session_id().as_deref(),
        Some("thr-recovered-42")
    );
    assert!(app.is_thread_loaded("thr-recovered-42"));
    assert!(!app.is_thread_loaded("thr-stale-empty"));
    assert!(events.iter().any(|ev| matches!(
        ev,
        EngineEvent::SessionInitialized { session_id: Some(sid), model: Some(m), .. }
            if sid == "thr-recovered-42" && m == "gpt-5.4"
    )));
    assert!(events.iter().any(|ev| matches!(
        ev,
        EngineEvent::AssistantTextDelta { text, .. } if text == "Recovered cleanly"
    )));

    mock_peer.await.expect("mock peer finished cleanly");
}

#[tokio::test]
async fn codex_skills_traversal_limit_rpc_error_is_enriched_without_fallback() {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let (client_read, client_write) = tokio::io::split(client_io);
    let (server_read, mut w) = tokio::io::split(server_io);

    let spec = test_start_spec();
    let app = CodexAppServer::connect_over_io(spec.workspace_id, client_read, client_write, None);

    let mock_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let req: Value = serde_json::from_str(&line).expect("valid jsonrpc");
            let method = req.get("method").and_then(Value::as_str).unwrap_or("");
            let id = req.get("id").cloned();
            match method {
                "initialize" => {
                    reply(&mut w, &id, json!({ "serverInfo": { "name": "codex" } })).await;
                }
                "initialized" => {}
                "thread/resume" => {
                    reply_error(
                        &mut w,
                        &id,
                        -32603,
                        "skills scan reached its traversal limit",
                    )
                    .await;
                    break;
                }
                "thread/start" => {
                    panic!("skills traversal error must not silently fall back to thread/start");
                }
                _ => {}
            }
        }
    });

    app.handshake().await.expect("handshake succeeds");
    let err = app
        .ensure_thread(
            Some("thr-existing"),
            Some("gpt-5.4"),
            Path::new("."),
            None,
            None,
        )
        .await
        .expect_err("skills traversal error must propagate");
    match err {
        EngineError::Rpc { code, message } => {
            assert_eq!(code, -32603);
            assert!(message.contains("skills scan reached its traversal limit"));
            assert!(
                message.contains("~/.agents/skills"),
                "expected actionable ~/.agents/skills guidance, got: {message}"
            );
        }
        other => panic!("expected EngineError::Rpc, got {other:?}"),
    }

    mock_peer.await.expect("mock peer finished cleanly");
}

#[tokio::test]
async fn codex_app_server_caches_model_list_and_refreshes_on_fresh_call() {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let (client_read, client_write) = tokio::io::split(client_io);
    let (server_read, mut w) = tokio::io::split(server_io);

    let spec = test_start_spec();
    let app = CodexAppServer::connect_over_io(spec.workspace_id, client_read, client_write, None);
    let rpc_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let rpc_count_peer = Arc::clone(&rpc_count);

    let mock_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let req: Value = serde_json::from_str(&line).expect("valid jsonrpc");
            let method = req.get("method").and_then(Value::as_str).unwrap_or("");
            let id = req.get("id").cloned();
            match method {
                "initialize" => {
                    reply(&mut w, &id, json!({ "serverInfo": { "name": "codex" } })).await;
                }
                "initialized" => {}
                "model/list" => {
                    let call = rpc_count_peer.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    let model_id = if call == 1 {
                        "gpt-5.4-cached"
                    } else {
                        "gpt-5.4-fresh"
                    };
                    reply(
                        &mut w,
                        &id,
                        json!({
                            "data": [{ "id": model_id, "displayName": model_id }]
                        }),
                    )
                    .await;
                    if call >= 2 {
                        break;
                    }
                }
                _ => {}
            }
        }
    });

    app.handshake().await.expect("handshake succeeds");
    let first = app.list_models().await;
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].id, "gpt-5.4-cached");

    let second = app.list_models().await;
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].id, "gpt-5.4-cached");
    assert_eq!(
        rpc_count.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "second list_models call must hit in-memory cache without a second RPC"
    );

    let refreshed = app
        .probe_models_fresh()
        .await
        .expect("fresh probe succeeds");
    assert_eq!(refreshed.len(), 1);
    assert_eq!(refreshed[0].id, "gpt-5.4-fresh");
    assert_eq!(
        rpc_count.load(std::sync::atomic::Ordering::SeqCst),
        2,
        "probe_models_fresh must issue a fresh model/list RPC"
    );

    let after_refresh = app.list_models().await;
    assert_eq!(after_refresh[0].id, "gpt-5.4-fresh");

    mock_peer.await.expect("mock peer finished cleanly");
}

#[tokio::test]
async fn codex_probe_models_for_provider_reuses_alive_pooled_server_across_workspaces() {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let (client_read, client_write) = tokio::io::split(client_io);
    let (server_read, mut w) = tokio::io::split(server_io);

    let mut pooled_spec = test_start_spec();
    pooled_spec.provider_instance_id = Some(format!("probe-pool-test-{}", Uuid::new_v4()));
    let app = Arc::new(CodexAppServer::connect_over_io(
        pooled_spec.workspace_id,
        client_read,
        client_write,
        None,
    ));

    let mock_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let req: Value = serde_json::from_str(&line).expect("valid jsonrpc");
            let method = req.get("method").and_then(Value::as_str).unwrap_or("");
            let id = req.get("id").cloned();
            match method {
                "initialize" => {
                    reply(&mut w, &id, json!({ "serverInfo": { "name": "codex" } })).await;
                }
                "initialized" => {}
                "model/list" => {
                    reply(
                        &mut w,
                        &id,
                        json!({
                            "data": [{ "id": "gpt-5.4-pooled", "displayName": "GPT-5.4 Pooled" }]
                        }),
                    )
                    .await;
                    break;
                }
                _ => {}
            }
        }
    });

    app.handshake().await.expect("handshake succeeds");
    let pool_key = CodexServerCacheKey::from_spec(&pooled_spec);
    global_codex_servers()
        .insert_for_test(pool_key.clone(), Arc::clone(&app))
        .await;

    let mut probe_spec = pooled_spec.clone();
    probe_spec.workspace_id = Uuid::new_v4();
    let driver = CodexNativeDriver::new();
    let probed = driver
        .probe_models_for_provider(&probe_spec)
        .await
        .expect("probe should reuse alive pooled server without spawning");

    global_codex_servers().remove_for_test(&pool_key).await;
    let _ = app.shutdown().await;

    let models = probed.expect("native driver returns Some(models)");
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].id, "gpt-5.4-pooled");
    mock_peer.await.expect("mock peer finished cleanly");
}

#[tokio::test]
async fn codex_driver_shutdown_evicts_and_stops_server_despite_transient_arc_clone() {
    let (client_io, _server_io) = tokio::io::duplex(4 * 1024);
    let (client_read, client_write) = tokio::io::split(client_io);

    let mut spec = test_start_spec();
    spec.provider_instance_id = Some(format!("shutdown-race-{}", Uuid::new_v4()));
    let app = CodexAppServer::connect_over_io(spec.workspace_id, client_read, client_write, None);
    let pool_key = CodexServerCacheKey::from_spec(&spec);
    global_codex_servers()
        .insert_for_test(pool_key.clone(), Arc::clone(&app))
        .await;

    let driver = CodexNativeDriver::new();
    let handle = driver.bind_existing_server(spec.clone(), Arc::clone(&app), None);
    // Simulate a background read_rate_limits probe holding an extra Arc clone.
    let _bg_probe_clone = Arc::clone(&app);
    assert!(Arc::strong_count(&app) >= 4);
    assert_eq!(app.active_handles(), 1);

    driver.shutdown(handle).await.expect("shutdown succeeds");

    assert_eq!(app.active_handles(), 0);
    assert!(
        !app.is_alive(),
        "server must shut down when business handle count reaches 0 despite transient Arc clones"
    );
    assert!(
        global_codex_servers().remove_for_test(&pool_key).await.is_none(),
        "evicted server must be removed from global_codex_servers"
    );
}
