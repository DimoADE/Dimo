use super::*;

#[test]
fn emit_connection_status_never_drops_transition_under_lock_contention() {
    let (event_tx, mut event_rx) = manager_event_channel();
    let runner = dummy_runner(event_tx);
    assert_eq!(
        *runner.status.lock().unwrap_or_else(|e| e.into_inner()),
        AgentConnectionStatus::Connecting
    );

    let status_lock = Arc::clone(&runner.status);
    let (locked_tx, locked_rx) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _guard = status_lock.lock().expect("lock status");
        locked_tx.send(()).expect("signal locked");
        std::thread::sleep(Duration::from_millis(30));
    });

    locked_rx.recv().expect("wait for holder to acquire lock");
    // Previously `try_lock()` silently skipped updating `runner.status` under
    // contention, leaving the connection stuck in `Connecting`.
    runner.emit_connection_status(AgentConnectionStatus::Ready, Some("ready".into()), None);
    holder.join().expect("holder thread");

    assert_eq!(
        *runner.status.lock().unwrap_or_else(|e| e.into_inner()),
        AgentConnectionStatus::Ready
    );
    let event = event_rx
        .try_recv()
        .expect("ConnectionStatusChanged must be emitted");
    match event.event {
        AgentEvent::ConnectionStatusChanged { snapshot } => {
            assert_eq!(snapshot.status, AgentConnectionStatus::Ready);
            assert_eq!(snapshot.status_message.as_deref(), Some("ready"));
        }
        other => panic!("expected ConnectionStatusChanged, got {other:?}"),
    }
}

async fn create_test_terminal(session_id: AgentSessionId) -> crate::AgentTerminalId {
    #[cfg(windows)]
    let (command, args) = (
        "cmd".to_string(),
        vec!["/C".to_string(), "echo".to_string(), "ok".to_string()],
    );
    #[cfg(not(windows))]
    let (command, args) = (
        "sh".to_string(),
        vec!["-c".to_string(), "echo ok".to_string()],
    );
    agent_terminal_registry()
        .create_terminal(&crate::terminal::AgentTerminalCreateRequest {
            session_id,
            command,
            args,
            cwd: None,
            env: Vec::new(),
            output_byte_limit: None,
        })
        .await
        .expect("create test terminal")
}

async fn insert_dead_test_connection(
    manager: &AgentConnectionManager,
    connection_id: AgentConnectionId,
    session_id: AgentSessionId,
    prompt_id: AgentPromptId,
    finish_task: bool,
) -> Option<mpsc::Receiver<AgentConnectionCommand>> {
    let (cmd_tx, cmd_rx) = mpsc::channel(4);
    let agent_id = AgentId::parse("claude-code").expect("valid agent id");
    let snapshot = ManagedAgentConnectionSnapshot {
        connection_id,
        agent_id: agent_id.clone(),
        launch_lock: test_launch_lock(agent_id),
        workspace_id: uuid::Uuid::new_v4(),
        working_dir: std::env::temp_dir(),
        additional_directories: Vec::new(),
        auto_approve_mode: AgentAutoApproveMode::default(),
        env: HashMap::new(),
    };
    let session_map = Arc::new(RwLock::new(HashMap::from([(
        session_id,
        "acp-dead-session".to_string(),
    )])));
    let active_prompt = Arc::new(Mutex::new(Some((session_id, prompt_id))));
    let task = if finish_task {
        let handle = tokio::spawn(async {});
        while !handle.is_finished() {
            tokio::task::yield_now().await;
        }
        handle
    } else {
        tokio::spawn(std::future::pending::<()>())
    };
    manager.connections.lock().await.insert(
        connection_id,
        ManagedAgentConnection {
            snapshot,
            cmd_tx,
            capabilities: Arc::new(RwLock::new(AcpCapabilitySnapshot::default())),
            session_map,
            session_controls: Arc::new(RwLock::new(HashMap::new())),
            last_activity: Arc::new(Mutex::new(Instant::now())),
            active_prompt,
            pending_session_id: Arc::new(Mutex::new(None)),
            pending_permissions: Arc::new(Mutex::new(HashMap::new())),
            pending_elicitations: Arc::new(Mutex::new(HashMap::new())),
            child_pid: Arc::new(std::sync::Mutex::new(None)),
            process_job: Arc::new(std::sync::Mutex::new(None)),
            status: Arc::new(std::sync::Mutex::new(AgentConnectionStatus::Ready)),
            task,
        },
    );
    if finish_task {
        Some(cmd_rx)
    } else {
        // Drop cmd_rx so cmd_tx.send fails while task is not yet finished.
        drop(cmd_rx);
        None
    }
}

fn assert_dead_connection_cleanup_events(
    event_rx: &mut ManagerEventReceiver,
    connection_id: AgentConnectionId,
    session_id: AgentSessionId,
    prompt_id: AgentPromptId,
) {
    let mut saw_connection_closed = false;
    let mut saw_disconnected = false;
    while let Ok(ev) = event_rx.try_recv() {
        assert_eq!(ev.connection_id, connection_id);
        match ev.event {
            AgentEvent::Error { error }
                if error.code.as_deref() == Some("connection_closed")
                    && ev.session_id == Some(session_id)
                    && ev.prompt_id == Some(prompt_id) =>
            {
                saw_connection_closed = true;
            }
            AgentEvent::ConnectionStatusChanged { snapshot }
                if snapshot.status == AgentConnectionStatus::Disconnected =>
            {
                saw_disconnected = true;
            }
            _ => {}
        }
    }
    assert!(
        saw_connection_closed,
        "dead connection eviction must emit connection_closed error for active prompt"
    );
    assert!(
        saw_disconnected,
        "dead connection eviction must emit Disconnected status change"
    );
}

#[tokio::test]
async fn send_command_evicting_finished_task_runs_dead_connection_cleanup() {
    let (event_tx, mut event_rx) = manager_event_channel();
    let manager = AgentConnectionManager::new_with_driver(event_tx, false);
    let connection_id = AgentConnectionId::new();
    let session_id = AgentSessionId::new();
    let prompt_id = AgentPromptId::new();

    let terminal_id = create_test_terminal(session_id).await;
    assert!(agent_terminal_registry().exists(terminal_id).await);

    let _keep_rx =
        insert_dead_test_connection(&manager, connection_id, session_id, prompt_id, true).await;

    let err = manager
        .list_sessions(connection_id, None, None)
        .await
        .expect_err("sending command to finished connection must fail");
    assert!(
        err.to_string().contains("command channel closed"),
        "unexpected error: {err}"
    );

    assert!(
        !agent_terminal_registry().exists(terminal_id).await,
        "evicting a dead connection via send_command must release its session terminals"
    );
    assert_dead_connection_cleanup_events(&mut event_rx, connection_id, session_id, prompt_id);
}

#[tokio::test]
async fn send_command_evicting_closed_channel_runs_dead_connection_cleanup() {
    let (event_tx, mut event_rx) = manager_event_channel();
    let manager = AgentConnectionManager::new_with_driver(event_tx, false);
    let connection_id = AgentConnectionId::new();
    let session_id = AgentSessionId::new();
    let prompt_id = AgentPromptId::new();

    let terminal_id = create_test_terminal(session_id).await;
    assert!(agent_terminal_registry().exists(terminal_id).await);

    let _ =
        insert_dead_test_connection(&manager, connection_id, session_id, prompt_id, false).await;

    let err = manager
        .list_sessions(connection_id, None, None)
        .await
        .expect_err("sending command to closed channel must fail");
    assert!(
        err.to_string().contains("command channel closed"),
        "unexpected error: {err}"
    );

    assert!(
        !agent_terminal_registry().exists(terminal_id).await,
        "evicting a connection on closed cmd_tx must release its session terminals"
    );
    assert_dead_connection_cleanup_events(&mut event_rx, connection_id, session_id, prompt_id);
}

async fn send_and_assert_busy_commands(cmd_tx: &mpsc::Sender<AgentConnectionCommand>) {
    let other_session = AgentSessionId::new();
    let other_prompt = AgentPromptId::new();

    let (prepare_tx, prepare_rx) = oneshot::channel();
    cmd_tx
        .send(AgentConnectionCommand::PrepareSession {
            session_id: other_session,
            preferences: crate::SessionControlPreferences::default(),
            result_tx: prepare_tx,
        })
        .await
        .expect("send PrepareSession");
    let prepare_err = prepare_rx
        .await
        .expect("PrepareSession result_tx must NOT be dropped")
        .expect_err("PrepareSession must be rejected as busy");
    assert!(
        prepare_err
            .to_string()
            .contains("while a turn is in progress"),
        "unexpected PrepareSession error: {prepare_err}"
    );

    let (resume_tx, resume_rx) = oneshot::channel();
    cmd_tx
        .send(AgentConnectionCommand::ResumeSession {
            session_id: other_session,
            external_session_id: "ext-1".into(),
            preferences: crate::SessionControlPreferences::default(),
            result_tx: resume_tx,
        })
        .await
        .expect("send ResumeSession");
    let resume_err = resume_rx
        .await
        .expect("ResumeSession result_tx must NOT be dropped")
        .expect_err("ResumeSession must be rejected as busy");
    assert!(
        resume_err
            .to_string()
            .contains("while a turn is in progress"),
        "unexpected ResumeSession error: {resume_err}"
    );

    let (cfg_tx, cfg_rx) = oneshot::channel();
    cmd_tx
        .send(AgentConnectionCommand::SetSessionConfigOption {
            session_id: other_session,
            key: "model".into(),
            value: serde_json::json!("sonnet"),
            result_tx: cfg_tx,
        })
        .await
        .expect("send SetSessionConfigOption");
    let cfg_err = cfg_rx
        .await
        .expect("SetSessionConfigOption result_tx must NOT be dropped")
        .expect_err("SetSessionConfigOption must be rejected as busy");
    assert!(
        cfg_err.to_string().contains("while a turn is in progress"),
        "unexpected SetSessionConfigOption error: {cfg_err}"
    );

    let (fork_tx, fork_rx) = oneshot::channel();
    cmd_tx
        .send(AgentConnectionCommand::ForkSession {
            session_id: other_session,
            fork_point: None,
            result_tx: fork_tx,
        })
        .await
        .expect("send ForkSession");
    let fork_err = fork_rx
        .await
        .expect("ForkSession result_tx must NOT be dropped")
        .expect_err("ForkSession must be rejected as busy");
    assert!(
        fork_err.to_string().contains("while a turn is in progress"),
        "unexpected ForkSession error: {fork_err}"
    );

    let (steer_tx, steer_rx) = oneshot::channel();
    cmd_tx
        .send(AgentConnectionCommand::Steer {
            session_id: other_session,
            expected_prompt_id: other_prompt,
            blocks: Vec::new(),
            display_blocks: None,
            result_tx: steer_tx,
        })
        .await
        .expect("send Steer");
    let steer_err = steer_rx
        .await
        .expect("Steer result_tx must NOT be dropped")
        .expect_err("Steer must be rejected as busy");
    assert!(
        steer_err
            .to_string()
            .contains("while a turn is in progress"),
        "unexpected Steer error: {steer_err}"
    );
}

#[tokio::test]
async fn acp_override_loop_replies_busy_instead_of_dropping_oneshot_senders() {
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

    let session_id = AgentSessionId::new();
    let prompt_id = AgentPromptId::new();
    let (event_tx, _event_rx) = manager_event_channel();
    let runner = dummy_runner_for_agent("opencode", event_tx.clone());
    runner
        .session_map
        .write()
        .await
        .insert(session_id, "acp-override-busy".to_string());
    let controls = SessionControlState {
        modes: Some(SessionModeState::new(
            "agent",
            vec![
                acp::schema::v1::SessionMode::new("agent", "Agent"),
                acp::schema::v1::SessionMode::new("plan", "Plan"),
            ],
        )),
        config_options: vec![
            AcpSessionConfigOption::select(
                "mode",
                "Mode",
                "agent",
                SessionConfigSelectOptions::Ungrouped(vec![
                    SessionConfigSelectOption::new("agent", "Agent"),
                    SessionConfigSelectOption::new("plan", "Plan"),
                ]),
            )
            .category(SessionConfigOptionCategory::Mode),
        ],
        mode_uses_set_mode: true,
        ..Default::default()
    };
    runner
        .session_controls
        .write()
        .await
        .insert(session_id, controls);

    let (client_to_agent, agent_from_client) = tokio::io::duplex(64 * 1024);
    let (_agent_to_client, client_from_agent) = tokio::io::duplex(64 * 1024);

    let (override_seen_tx, override_seen_rx) = oneshot::channel();
    let agent_task = tokio::spawn(async move {
        let mut reader = BufReader::new(agent_from_client);
        let mut line = String::new();
        if reader.read_line(&mut line).await.is_ok() {
            let _ = override_seen_tx.send(line);
        }
        std::future::pending::<()>().await;
    });

    let transport =
        acp::ByteStreams::new(client_to_agent.compat_write(), client_from_agent.compat());
    let bridge = AcpClientBridge::new(
        runner.snapshot.connection_id,
        runner.snapshot.agent_id.clone(),
        event_tx,
        Arc::clone(&runner.session_map),
        Arc::clone(&runner.session_controls),
        Arc::clone(&runner.pending_permissions),
        Arc::clone(&runner.pending_elicitations),
        Arc::clone(&runner.auto_approve_mode),
        Arc::clone(&runner.stream_dedup),
        Arc::clone(&runner.last_activity),
        Arc::clone(&runner.grok_subagent),
        Arc::clone(&runner.grok_mcp),
        Arc::clone(&runner.pending_session_id),
        runner.snapshot.working_dir.clone(),
        runner.snapshot.env.clone(),
        runner.clone(),
    );
    let (cmd_tx, mut cmd_rx) = mpsc::channel(16);
    let runner_for_conn = runner.clone();
    acp::Client
        .builder()
        .name("Dimo")
        .on_receive_notification(
            async move |notification: AgentNotification, _cx| {
                bridge.handle_agent_notification(notification).await
            },
            acp::on_receive_notification!(),
        )
        .connect_with(transport, |conn: ConnectionTo<Agent>| async move {
            let driver_task = tokio::spawn(async move {
                let seen = tokio::time::timeout(Duration::from_secs(2), override_seen_rx)
                    .await
                    .expect("agent should receive session/set_mode")
                    .expect("override_seen channel");
                assert!(seen.contains("session/set_mode"), "unexpected: {seen}");

                send_and_assert_busy_commands(&cmd_tx).await;

                // Non-matching cancel must also receive an ack instead of dropping result_tx.
                let (other_cancel_tx, other_cancel_rx) = oneshot::channel();
                cmd_tx
                    .send(AgentConnectionCommand::Cancel {
                        session_id: AgentSessionId::new(),
                        prompt_id: AgentPromptId::new(),
                        result_tx: other_cancel_tx,
                    })
                    .await
                    .expect("send non-matching cancel");
                assert!(other_cancel_rx.await.expect("non-matching cancel ack"));

                // Finish cleanly by cancelling the active turn.
                let (ack_tx, ack_rx) = oneshot::channel();
                cmd_tx
                    .send(AgentConnectionCommand::Cancel {
                        session_id,
                        prompt_id,
                        result_tx: ack_tx,
                    })
                    .await
                    .expect("send cancel");
                assert!(ack_rx.await.expect("cancel ack"));
            });

            let outcome = tokio::time::timeout(
                Duration::from_secs(3),
                runner_for_conn.run_prompt(
                    &conn,
                    RunPromptRequest {
                        acp_session_id: "acp-override-busy".to_string(),
                        session_id,
                        prompt_id,
                        blocks: vec![AgentContentBlock::Text {
                            text: "hello".into(),
                        }],
                        display_blocks: None,
                        mode_override: Some("plan".into()),
                        config_overrides: Vec::new(),
                    },
                    &mut cmd_rx,
                ),
            )
            .await
            .expect("override loop test must settle promptly")
            .expect("run_prompt ok");
            assert_eq!(outcome, RunPromptOutcome::RetireConnection);
            driver_task.await.expect("driver task");
            Ok(())
        })
        .await
        .expect("connect_with");

    agent_task.abort();
}

#[tokio::test]
async fn acp_cancel_ack_loop_replies_busy_instead_of_dropping_oneshot_senders() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

    let session_id = AgentSessionId::new();
    let prompt_id = AgentPromptId::new();
    let (event_tx, _event_rx) = manager_event_channel();
    let runner = dummy_runner_for_agent("opencode", event_tx.clone());
    runner
        .session_map
        .write()
        .await
        .insert(session_id, "acp-cancel-busy".to_string());

    let (client_to_agent, agent_from_client) = tokio::io::duplex(64 * 1024);
    let (mut agent_to_client, client_from_agent) = tokio::io::duplex(64 * 1024);

    let (prompt_seen_tx, prompt_seen_rx) = oneshot::channel();
    let (cancel_seen_tx, cancel_seen_rx) = oneshot::channel();
    let (release_ack_tx, release_ack_rx) = oneshot::channel::<()>();

    let agent_task = tokio::spawn(async move {
        let mut reader = BufReader::new(agent_from_client);
        let mut prompt_line = String::new();
        reader
            .read_line(&mut prompt_line)
            .await
            .expect("read session/prompt");
        let parsed: serde_json::Value =
            serde_json::from_str(&prompt_line).expect("parse session/prompt JSON");
        let req_id = parsed["id"].clone();
        let _ = prompt_seen_tx.send(prompt_line);

        let mut cancel_line = String::new();
        reader
            .read_line(&mut cancel_line)
            .await
            .expect("read session/cancel");
        let _ = cancel_seen_tx.send(cancel_line);

        // Hold session/prompt open until the test finishes probing the cancel-ack wait loop.
        let _ = release_ack_rx.await;
        let response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "stopReason": "cancelled"
            }
        });
        let mut payload = serde_json::to_string(&response).expect("serialize response");
        payload.push('\n');
        let _ = agent_to_client.write_all(payload.as_bytes()).await;
        let _ = agent_to_client.flush().await;
    });

    let transport =
        acp::ByteStreams::new(client_to_agent.compat_write(), client_from_agent.compat());
    let bridge = AcpClientBridge::new(
        runner.snapshot.connection_id,
        runner.snapshot.agent_id.clone(),
        event_tx,
        Arc::clone(&runner.session_map),
        Arc::clone(&runner.session_controls),
        Arc::clone(&runner.pending_permissions),
        Arc::clone(&runner.pending_elicitations),
        Arc::clone(&runner.auto_approve_mode),
        Arc::clone(&runner.stream_dedup),
        Arc::clone(&runner.last_activity),
        Arc::clone(&runner.grok_subagent),
        Arc::clone(&runner.grok_mcp),
        Arc::clone(&runner.pending_session_id),
        runner.snapshot.working_dir.clone(),
        runner.snapshot.env.clone(),
        runner.clone(),
    );
    let (cmd_tx, mut cmd_rx) = mpsc::channel(16);
    let runner_for_conn = runner.clone();
    acp::Client
        .builder()
        .name("Dimo")
        .on_receive_notification(
            async move |notification: AgentNotification, _cx| {
                bridge.handle_agent_notification(notification).await
            },
            acp::on_receive_notification!(),
        )
        .connect_with(transport, |conn: ConnectionTo<Agent>| async move {
            let driver_task = tokio::spawn(async move {
                let seen_prompt = tokio::time::timeout(Duration::from_secs(2), prompt_seen_rx)
                    .await
                    .expect("agent should receive session/prompt")
                    .expect("prompt_seen channel");
                assert!(
                    seen_prompt.contains("session/prompt"),
                    "unexpected: {seen_prompt}"
                );

                // Enter the cancel-ack wait loop.
                let (cancel_ack_tx, cancel_ack_rx) = oneshot::channel();
                cmd_tx
                    .send(AgentConnectionCommand::Cancel {
                        session_id,
                        prompt_id,
                        result_tx: cancel_ack_tx,
                    })
                    .await
                    .expect("send cancel");

                let seen_cancel = tokio::time::timeout(Duration::from_secs(2), cancel_seen_rx)
                    .await
                    .expect("agent should receive session/cancel")
                    .expect("cancel_seen channel");
                assert!(
                    seen_cancel.contains("session/cancel"),
                    "unexpected: {seen_cancel}"
                );

                // Send other commands while run_prompt is blocked in the cancel-ack loop.
                send_and_assert_busy_commands(&cmd_tx).await;

                // Release the agent's prompt response so cancel-ack settles cleanly.
                let _ = release_ack_tx.send(());
                assert!(cancel_ack_rx.await.expect("cancel ack must resolve true"));
            });

            let outcome = tokio::time::timeout(
                Duration::from_secs(3),
                runner_for_conn.run_prompt(
                    &conn,
                    RunPromptRequest {
                        acp_session_id: "acp-cancel-busy".to_string(),
                        session_id,
                        prompt_id,
                        blocks: vec![AgentContentBlock::Text {
                            text: "hello".into(),
                        }],
                        display_blocks: None,
                        mode_override: None,
                        config_overrides: Vec::new(),
                    },
                    &mut cmd_rx,
                ),
            )
            .await
            .expect("cancel-ack loop test must settle promptly")
            .expect("run_prompt ok");
            assert_eq!(outcome, RunPromptOutcome::Settled);
            driver_task.await.expect("driver task");
            Ok(())
        })
        .await
        .expect("connect_with");

    agent_task.await.expect("agent task");
}
