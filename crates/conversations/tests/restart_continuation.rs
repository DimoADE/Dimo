use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use agents::{
    AgentContentBlock, AgentId, AgentRuntime, ConversationInputPayload, SessionLaunchLock,
    conversation::{
        ContinuationPolicy, ConversationEvent, ConversationInputBlock, ConversationQuestionRequest,
    },
    runtime_event_channel,
};
use chrono::{Duration as ChronoDuration, Utc};
use conversations::{
    AgentRuntimeLaunchSettings, ConversationContext, ConversationEventAppender, ConversationHost,
    ConversationInputControl, ConversationInputStatus, ConversationServiceError,
    ConversationSessionService, SubmitConversationInput,
    service::{RESTART_CONTINUATION_ORIGIN, RESTART_CONTINUATION_PROMPT},
};
use db::models::{
    conversation::{
        BindingStatus, ConversationAgentBindingRecord, ConversationRecord,
        CreateConversationAgentBinding, CreateConversationRecord,
    },
    conversation_event::AppendConversationEvent,
    conversation_input::ConversationInputRecord,
    conversation_side_effects::{ConversationPermissionRecord, UpsertConversationPermission},
    conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    project::{CreateProject, Project},
    repo::Repo,
    session::{Session, SessionStatus},
    task::{CreateTask, Task},
    workspace::{CreateWorkspace, Workspace},
};
use deployment::Deployment;
use local_deployment::LocalDeployment;
use sqlx::SqlitePool;
use tokio::sync::Mutex;
use uuid::Uuid;

struct RestartFixtureHost;

#[async_trait::async_trait]
impl ConversationHost for RestartFixtureHost {
    fn resolve_working_dir(&self, _: &Workspace, container: &str, _: &[Repo]) -> Option<String> {
        Some(container.into())
    }

    fn resolve_additional_directories(
        &self,
        _: &Workspace,
        _: &str,
        _: &[Repo],
        _: &str,
    ) -> Vec<PathBuf> {
        Vec::new()
    }

    async fn build_prompt_blocks(
        &self,
        _: &str,
        text: String,
        _: &[String],
        _: &[agents::ConversationFileRef],
    ) -> Result<Vec<AgentContentBlock>, ConversationServiceError> {
        Ok(vec![AgentContentBlock::Text { text }])
    }

    async fn launch_settings(
        &self,
        _: &SqlitePool,
        agent: &AgentId,
    ) -> Result<AgentRuntimeLaunchSettings, ConversationServiceError> {
        Ok(AgentRuntimeLaunchSettings {
            auto_approve_mode: agents::AgentAutoApproveMode::Off,
            env: HashMap::new(),
            launch_lock: SessionLaunchLock {
                agent_id: agent.clone(),
                absolute_acp_program: std::env::temp_dir().join("fixture-acp"),
                args: Vec::new(),
                env: BTreeMap::new(),
                runtime_version: "fixture".into(),
                acp_version: "fixture".into(),
            },
        })
    }
}

struct RestartFixture {
    _data: tempfile::TempDir,
    _work: tempfile::TempDir,
    _event_task: tokio::task::JoinHandle<()>,
    ctx: ConversationContext,
    service: ConversationSessionService,
    inputs: ConversationInputControl,
    workspace_id: Uuid,
    agent_id: AgentId,
}

impl Drop for RestartFixture {
    fn drop(&mut self) {
        self._event_task.abort();
    }
}

impl RestartFixture {
    async fn new() -> Self {
        let data = tempfile::tempdir().expect("temp data dir");
        let work = tempfile::tempdir().expect("temp work dir");
        let deployment = Arc::new(
            LocalDeployment::new_at(data.path())
                .await
                .expect("local deployment"),
        );
        let pool = &deployment.db().pool;
        let project = Project::create(
            pool,
            &CreateProject {
                name: "restart-test".into(),
                root_path: work.path().to_string_lossy().into(),
                ..Default::default()
            },
            Uuid::new_v4(),
        )
        .await
        .expect("create project");
        let task = Task::create(
            pool,
            &CreateTask::from_title_description(project.id, "restart-test".into(), None),
            Uuid::new_v4(),
        )
        .await
        .expect("create task");
        let workspace = Workspace::create(
            pool,
            &CreateWorkspace {
                project_id: project.id,
                parent_workspace_id: None,
                branch: "main".into(),
                container_ref: Some(work.path().to_string_lossy().into()),
                use_worktree: false,
                agent_working_dir: Some(work.path().to_string_lossy().into()),
            },
            Uuid::new_v4(),
            task.id,
        )
        .await
        .expect("create workspace");

        let event_publisher = Arc::new(conversations::NoopConversationEventPublisher);
        let (event_sink, event_rx) = runtime_event_channel();
        let runtime = Arc::new(AgentRuntime::new_with_driver(event_sink, false));
        let ctx = ConversationContext {
            deployment: deployment.clone(),
            agent_runtime: runtime,
            turn_locks: Arc::new(Mutex::new(HashMap::new())),
            runtime_states: Default::default(),
            row_projectors: Default::default(),
            host: Arc::new(RestartFixtureHost),
            event_publisher: event_publisher.clone(),
        };
        let event_task = conversations::start_agent_event_persistence(ctx.clone(), event_rx);
        let inputs = ConversationInputControl::with_publisher(pool.clone(), event_publisher);

        Self {
            _data: data,
            _work: work,
            _event_task: event_task,
            service: ConversationSessionService::new(ctx.clone()),
            inputs,
            ctx,
            workspace_id: workspace.id,
            agent_id: AgentId::parse("codex").expect("agent id"),
        }
    }

    fn pool(&self) -> &SqlitePool {
        &self.ctx.deployment.db().pool
    }

    async fn create_conversation(&self, native_session_id: Option<&str>) -> Uuid {
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            self.pool(),
            conversation_id,
            CreateConversationRecord {
                workspace_id: self.workspace_id,
                task_id: None,
                title: Some("Restart test"),
                initial_prompt: None,
                status: None,
                executor: Some("codex"),
            },
        )
        .await
        .expect("create conversation");
        sqlx::query("UPDATE sessions SET agent_id = ? WHERE id = ?")
            .bind(self.agent_id.as_str())
            .bind(conversation_id)
            .execute(self.pool())
            .await
            .expect("set agent_id");
        if let Some(acp_session_id) = native_session_id {
            let binding = ConversationAgentBindingRecord::create(
                self.pool(),
                Uuid::new_v4(),
                CreateConversationAgentBinding {
                    conversation_id,
                    agent_id: &self.agent_id,
                    working_dir: self._work.path().to_string_lossy().as_ref(),
                    acp_session_id: Some(acp_session_id),
                    continuation_key: None,
                    acp_protocol_version: None,
                    runtime_version: None,
                    acp_version: None,
                    load_supported: true,
                    resume_supported: true,
                    close_supported: true,
                    terminal_supported: true,
                    additional_directories_supported: false,
                    prompt_capabilities_json: "{}",
                    session_capabilities_json: "{}",
                    client_capabilities_json: "{}",
                    mcp_servers_json: "[]",
                    modes_json: "[]",
                    config_options_json: "[]",
                    current_mode: None,
                    config_selection_json: "{}",
                    status: BindingStatus::Ready,
                },
            )
            .await
            .expect("create binding");
            ConversationAgentBindingRecord::bind_acp_session(
                self.pool(),
                binding.id,
                acp_session_id,
                None,
                BindingStatus::Ready,
            )
            .await
            .expect("bind acp session");
            Session::update_external_session_id(self.pool(), conversation_id, acp_session_id)
                .await
                .expect("update external session id");
        }
        conversation_id
    }

    fn payload(&self, text: &str) -> ConversationInputPayload {
        ConversationInputPayload {
            continuation_policy: None,
            expected_binding_revision: None,
            agent_id: self.agent_id.clone(),
            workspace_id: self.workspace_id,
            executor_profile_id: None,
            text: text.to_string(),
            display_text: None,
            images: Vec::new(),
            mode_override: None,
            config_overrides: Vec::new(),
            workflow_refs: Vec::new(),
            file_refs: Vec::new(),
            internal_prompt_contributions: Vec::new(),
            collaboration_origin: None,
            provider_instance_id: None,
        }
    }

    async fn seed_in_flight_turn(
        &self,
        conversation_id: Uuid,
        payload: ConversationInputPayload,
        status: &str,
        accepted_by_provider: bool,
        origin: Option<&str>,
    ) -> Uuid {
        let turn_id = Uuid::new_v4();
        let blocks = vec![ConversationInputBlock::Text {
            text: payload.text.clone(),
        }];
        let blocks_json = serde_json::to_string(&blocks).expect("serialize blocks");
        ConversationTurnRecord::create_pending(
            self.pool(),
            turn_id,
            CreateConversationTurn {
                conversation_id,
                prompt_id: accepted_by_provider.then_some("prompt-1"),
                text_preview: Some(&payload.text),
                input_blocks_json: &blocks_json,
            },
        )
        .await
        .expect("create pending turn");
        if status != "pending" {
            sqlx::query("UPDATE conversation_turns SET status = ? WHERE id = ?")
                .bind(status)
                .bind(turn_id)
                .execute(self.pool())
                .await
                .expect("update turn status");
        }
        if accepted_by_provider {
            sqlx::query(
                "UPDATE conversation_turns SET started_at = datetime('now', 'subsec') WHERE id = ?",
            )
            .bind(turn_id)
            .execute(self.pool())
            .await
            .expect("set started_at");
        }
        if let Some(origin) = origin {
            sqlx::query("UPDATE conversation_turns SET origin = ? WHERE id = ?")
                .bind(origin)
                .bind(turn_id)
                .execute(self.pool())
                .await
                .expect("set origin");
        }
        ConversationRecord::update_active_turn(self.pool(), conversation_id, Some(turn_id))
            .await
            .expect("set active turn");

        let input_id = Uuid::new_v4();
        let payload_json = serde_json::to_string(&payload).expect("serialize payload");
        sqlx::query(
            r#"INSERT INTO conversation_inputs (
                   id, conversation_id, operation_id, status, revision, sort_key,
                   payload_digest, payload_json, principal_json, turn_id
               ) VALUES (?, ?, ?, 'dispatched', 1, 1024, 'digest', ?, '{"kind":"origin","origin":"local_user"}', ?)"#,
        )
        .bind(input_id)
        .bind(conversation_id)
        .bind(Uuid::new_v4())
        .bind(payload_json)
        .bind(turn_id)
        .execute(self.pool())
        .await
        .expect("insert dispatched input");

        turn_id
    }

    async fn seed_completed_turn(
        &self,
        conversation_id: Uuid,
        text: &str,
        origin: &str,
        created_at: chrono::DateTime<Utc>,
    ) -> Uuid {
        let turn_id = Uuid::new_v4();
        let blocks_json = serde_json::to_string(&vec![ConversationInputBlock::Text {
            text: text.to_string(),
        }])
        .expect("serialize blocks");
        ConversationTurnRecord::create_pending(
            self.pool(),
            turn_id,
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("completed-prompt"),
                text_preview: Some(text),
                input_blocks_json: &blocks_json,
            },
        )
        .await
        .expect("create turn");
        ConversationTurnRecord::mark_completed(self.pool(), turn_id, Some("end_turn"), None, None)
            .await
            .expect("mark completed");
        sqlx::query("UPDATE conversation_turns SET origin = ?, created_at = ? WHERE id = ?")
            .bind(origin)
            .bind(created_at)
            .bind(turn_id)
            .execute(self.pool())
            .await
            .expect("update completed turn origin/time");
        turn_id
    }

    async fn wait_for_turn_status(&self, turn_id: Uuid, expected: &str) {
        for _ in 0..100 {
            if let Some(turn) = ConversationTurnRecord::find_by_id(self.pool(), turn_id)
                .await
                .expect("load turn")
                && turn.status == expected
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let actual = ConversationTurnRecord::find_by_id(self.pool(), turn_id)
            .await
            .expect("load turn")
            .map(|t| t.status);
        panic!("turn {turn_id} did not reach {expected}, actual={actual:?}");
    }
}

#[tokio::test]
async fn restart_recovery_auto_continues_interrupted_turn_ahead_of_queued_followups_and_preserves_origin()
 {
    let fixture = RestartFixture::new().await;
    let conversation_id = fixture.create_conversation(Some("native-session-1")).await;
    let interrupted_turn_id = fixture
        .seed_in_flight_turn(
            conversation_id,
            fixture.payload("implement auth middleware"),
            "running",
            true,
            None,
        )
        .await;

    // A user follow-up was already queued behind the in-flight turn before the crash.
    let followup = fixture
        .inputs
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id: Uuid::new_v4(),
            payload: fixture.payload("then add unit tests"),
            principal: serde_json::json!({ "kind": "origin", "origin": "local_user" }),
        })
        .await
        .expect("queue follow-up");

    let recovered = fixture
        .service
        .recover_interrupted_turns()
        .await
        .expect("recover interrupted turns");
    assert_eq!(recovered, 1);

    // Original turn is marked interrupted.
    let interrupted = ConversationTurnRecord::find_by_id(fixture.pool(), interrupted_turn_id)
        .await
        .expect("load interrupted turn")
        .expect("interrupted turn exists");
    assert_eq!(interrupted.status, "interrupted");

    // Continuation input is placed strictly ahead of the queued follow-up.
    let queued = fixture
        .inputs
        .list(conversation_id)
        .await
        .expect("list inputs")
        .into_iter()
        .filter(|input| input.status == ConversationInputStatus::Queued)
        .collect::<Vec<_>>();
    assert_eq!(queued.len(), 2);
    assert_eq!(queued[0].payload.text, RESTART_CONTINUATION_PROMPT);
    assert_eq!(queued[0].payload.continuation_policy, None);
    assert_eq!(
        queued[0].principal.get("origin").and_then(|v| v.as_str()),
        Some(RESTART_CONTINUATION_ORIGIN)
    );
    assert_eq!(queued[1].id, followup.id);
    assert!(queued[0].sort_key < queued[1].sort_key);

    // Startup queue dispatch runs the continuation turn and records its origin.
    let started = fixture
        .service
        .dispatch_queued_inputs()
        .await
        .expect("dispatch queued inputs");
    assert_eq!(started, 1);

    let turns = ConversationTurnRecord::list_for_conversation(fixture.pool(), conversation_id)
        .await
        .expect("list turns");
    assert!(turns.len() >= 2);
    let continuation_turn = &turns[1];
    assert_eq!(continuation_turn.origin, RESTART_CONTINUATION_ORIGIN);
    assert_eq!(
        continuation_turn.text_preview.as_deref(),
        Some(RESTART_CONTINUATION_PROMPT)
    );
    fixture
        .wait_for_turn_status(continuation_turn.id, "running")
        .await;
}

#[tokio::test]
async fn never_started_turn_replays_original_prompt_instead_of_generic_continue() {
    let fixture = RestartFixture::new().await;
    let conversation_id = fixture.create_conversation(Some("native-session-2")).await;
    let mut original = fixture.payload("build the search index");
    original.images = vec!["img-1".into()];
    original.mode_override = Some("plan".into());
    original.provider_instance_id = Some("custom-instance".into());

    fixture
        .seed_in_flight_turn(conversation_id, original.clone(), "pending", false, None)
        .await;

    fixture
        .service
        .recover_interrupted_turns()
        .await
        .expect("recover");

    let queued = fixture
        .inputs
        .list(conversation_id)
        .await
        .expect("list inputs")
        .into_iter()
        .filter(|input| input.status == ConversationInputStatus::Queued)
        .collect::<Vec<_>>();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].payload.text, "build the search index");
    assert_eq!(queued[0].payload.images, vec!["img-1".to_string()]);
    assert_eq!(queued[0].payload.mode_override.as_deref(), Some("plan"));
    assert_eq!(
        queued[0].payload.provider_instance_id.as_deref(),
        Some("custom-instance")
    );
}

#[tokio::test]
async fn started_turn_without_native_session_uses_original_prompt_on_turn_1_and_portable_handoff_on_later_turns()
 {
    let fixture = RestartFixture::new().await;

    // Turn 1 without native session -> replay original prompt with restart safety note.
    let conv_turn1 = fixture.create_conversation(None).await;
    fixture
        .seed_in_flight_turn(
            conv_turn1,
            fixture.payload("refactor router"),
            "running",
            true,
            None,
        )
        .await;

    // Multi-turn without native session -> portable handoff continuation.
    let conv_multi = fixture.create_conversation(None).await;
    fixture
        .seed_completed_turn(
            conv_multi,
            "initial setup",
            "local_user",
            Utc::now() - ChronoDuration::minutes(2),
        )
        .await;
    fixture
        .seed_in_flight_turn(
            conv_multi,
            fixture.payload("finish migration"),
            "running",
            true,
            None,
        )
        .await;

    fixture
        .service
        .recover_interrupted_turns()
        .await
        .expect("recover");

    let q1 = fixture
        .inputs
        .list(conv_turn1)
        .await
        .expect("list turn1")
        .into_iter()
        .find(|i| i.status == ConversationInputStatus::Queued)
        .expect("turn1 continuation queued");
    assert!(q1.payload.text.starts_with("refactor router"));
    assert!(q1.payload.text.contains("cut short by an app restart"));
    assert_eq!(q1.payload.display_text.as_deref(), Some("refactor router"));
    assert_eq!(q1.payload.continuation_policy, None);

    let q2 = fixture
        .inputs
        .list(conv_multi)
        .await
        .expect("list multi")
        .into_iter()
        .find(|i| i.status == ConversationInputStatus::Queued)
        .expect("multi continuation queued");
    assert_eq!(q2.payload.text, RESTART_CONTINUATION_PROMPT);
    assert_eq!(
        q2.payload.continuation_policy,
        Some(ContinuationPolicy::Portable)
    );
}

#[tokio::test]
async fn skips_turns_waiting_on_user_permissions_questions_or_blocked_status() {
    let fixture = RestartFixture::new().await;

    // 1. Blocked turn
    let conv_blocked = fixture.create_conversation(Some("native-blocked")).await;
    fixture
        .seed_in_flight_turn(
            conv_blocked,
            fixture.payload("deploy"),
            "blocked",
            true,
            None,
        )
        .await;

    // 2. Running turn with pending permission
    let conv_perm = fixture.create_conversation(Some("native-perm")).await;
    let perm_turn = fixture
        .seed_in_flight_turn(
            conv_perm,
            fixture.payload("run migration"),
            "running",
            true,
            None,
        )
        .await;
    ConversationPermissionRecord::upsert_pending(
        fixture.pool(),
        UpsertConversationPermission {
            id: Uuid::new_v4(),
            conversation_id: conv_perm,
            turn_id: perm_turn,
            permission_id: "perm-1",
            title: Some("Run shell command"),
            details_json: "{}",
            options_json: "[]",
            auto: false,
        },
    )
    .await
    .expect("insert pending permission");

    // 3. Running turn with unanswered question
    let conv_q = fixture.create_conversation(Some("native-question")).await;
    let q_turn = fixture
        .seed_in_flight_turn(
            conv_q,
            fixture.payload("choose framework"),
            "running",
            true,
            None,
        )
        .await;
    let q_event = ConversationEvent::QuestionRequested {
        request: ConversationQuestionRequest {
            question_id: "q-1".into(),
            prompt: "Which database?".into(),
            options: Vec::new(),
            asked_at: Some(Utc::now()),
            schema: None,
        },
    };
    let q_json = serde_json::to_string(&q_event).expect("serialize question");
    ConversationEventAppender::append(
        fixture.pool(),
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id: conv_q,
            turn_id: Some(q_turn),
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "runtime",
            event_kind: "question_requested",
            normalized_json: &q_json,
            raw_json: None,
            idempotency_key: Some("test:q-1"),
        },
    )
    .await
    .expect("append question event");

    let recovered = fixture
        .service
        .recover_interrupted_turns()
        .await
        .expect("recover");
    assert_eq!(recovered, 3);

    for cid in [conv_blocked, conv_perm, conv_q] {
        let queued_count = fixture
            .inputs
            .list(cid)
            .await
            .expect("list inputs")
            .into_iter()
            .filter(|i| i.status == ConversationInputStatus::Queued)
            .count();
        assert_eq!(
            queued_count, 0,
            "conversation {cid} awaiting user interaction must not auto-continue"
        );
    }
}

#[tokio::test]
async fn skips_maintenance_commands_without_blocking_queued_followups() {
    let fixture = RestartFixture::new().await;
    let conv_compact = fixture.create_conversation(Some("native-compact")).await;
    fixture
        .seed_in_flight_turn(
            conv_compact,
            fixture.payload("  /compact focus on backend"),
            "running",
            true,
            None,
        )
        .await;
    let followup = fixture
        .inputs
        .submit(SubmitConversationInput {
            conversation_id: conv_compact,
            operation_id: Uuid::new_v4(),
            payload: fixture.payload("next user message"),
            principal: serde_json::json!({ "kind": "origin", "origin": "local_user" }),
        })
        .await
        .expect("queue follow-up");

    let conv_clear = fixture.create_conversation(Some("native-clear")).await;
    fixture
        .seed_in_flight_turn(conv_clear, fixture.payload("/CLEAR"), "running", true, None)
        .await;

    fixture
        .service
        .recover_interrupted_turns()
        .await
        .expect("recover");

    let compact_queued = fixture
        .inputs
        .list(conv_compact)
        .await
        .expect("list compact")
        .into_iter()
        .filter(|i| i.status == ConversationInputStatus::Queued)
        .collect::<Vec<_>>();
    assert_eq!(compact_queued.len(), 1);
    assert_eq!(compact_queued[0].id, followup.id);

    let clear_queued = fixture
        .inputs
        .list(conv_clear)
        .await
        .expect("list clear")
        .into_iter()
        .filter(|i| i.status == ConversationInputStatus::Queued)
        .count();
    assert_eq!(clear_queued, 0);
}

#[tokio::test]
async fn crash_loop_guard_stops_after_three_recent_continuations_but_allows_older_ones() {
    let fixture = RestartFixture::new().await;

    // 3 consecutive recent restart_continuation turns (2 completed + 1 in-flight) -> 4th blocked.
    let conv_loop = fixture.create_conversation(Some("native-loop")).await;
    let recent = Utc::now() - ChronoDuration::seconds(30);
    fixture
        .seed_completed_turn(
            conv_loop,
            RESTART_CONTINUATION_PROMPT,
            RESTART_CONTINUATION_ORIGIN,
            recent,
        )
        .await;
    fixture
        .seed_completed_turn(
            conv_loop,
            RESTART_CONTINUATION_PROMPT,
            RESTART_CONTINUATION_ORIGIN,
            recent,
        )
        .await;
    fixture
        .seed_in_flight_turn(
            conv_loop,
            fixture.payload(RESTART_CONTINUATION_PROMPT),
            "running",
            true,
            Some(RESTART_CONTINUATION_ORIGIN),
        )
        .await;

    // 2 older than 5-minute window + 1 recent in-flight -> allowed!
    let conv_old = fixture.create_conversation(Some("native-old")).await;
    let old = Utc::now() - ChronoDuration::minutes(10);
    fixture
        .seed_completed_turn(
            conv_old,
            RESTART_CONTINUATION_PROMPT,
            RESTART_CONTINUATION_ORIGIN,
            old,
        )
        .await;
    fixture
        .seed_completed_turn(
            conv_old,
            RESTART_CONTINUATION_PROMPT,
            RESTART_CONTINUATION_ORIGIN,
            old,
        )
        .await;
    fixture
        .seed_in_flight_turn(
            conv_old,
            fixture.payload(RESTART_CONTINUATION_PROMPT),
            "running",
            true,
            Some(RESTART_CONTINUATION_ORIGIN),
        )
        .await;

    fixture
        .service
        .recover_interrupted_turns()
        .await
        .expect("recover");

    let loop_queued = fixture
        .inputs
        .list(conv_loop)
        .await
        .expect("list loop")
        .into_iter()
        .filter(|i| i.status == ConversationInputStatus::Queued)
        .count();
    assert_eq!(loop_queued, 0, "crash-loop conversation must be stopped");

    let old_queued = fixture
        .inputs
        .list(conv_old)
        .await
        .expect("list old")
        .into_iter()
        .filter(|i| i.status == ConversationInputStatus::Queued)
        .count();
    assert_eq!(old_queued, 1, "expired loop window must allow continuation");
}

#[tokio::test]
async fn respects_config_toggle_and_skips_closed_deleted_automation_and_workflow_conversations() {
    let fixture = RestartFixture::new().await;

    // 1. Toggle disabled -> nothing auto-continued
    fixture
        .ctx
        .deployment
        .config()
        .write()
        .await
        .continue_conversations_after_restart = false;
    let conv_disabled = fixture.create_conversation(Some("native-disabled")).await;
    fixture
        .seed_in_flight_turn(
            conv_disabled,
            fixture.payload("work while disabled"),
            "running",
            true,
            None,
        )
        .await;
    fixture
        .service
        .recover_interrupted_turns()
        .await
        .expect("recover with toggle off");
    assert_eq!(
        fixture
            .inputs
            .list(conv_disabled)
            .await
            .expect("list")
            .into_iter()
            .filter(|i| i.status == ConversationInputStatus::Queued)
            .count(),
        0
    );

    // Re-enable toggle and verify closed / automation / workflow_step / deleted are skipped.
    fixture
        .ctx
        .deployment
        .config()
        .write()
        .await
        .continue_conversations_after_restart = true;

    let conv_done = fixture.create_conversation(Some("native-done")).await;
    fixture
        .seed_in_flight_turn(conv_done, fixture.payload("done"), "running", true, None)
        .await;
    conversations::workbench_status::apply_manual_status(
        fixture.pool(),
        conv_done,
        SessionStatus::Done,
    )
    .await
    .expect("mark manually done");

    let conv_archived = fixture.create_conversation(Some("native-archived")).await;
    fixture
        .seed_in_flight_turn(
            conv_archived,
            fixture.payload("archived"),
            "running",
            true,
            None,
        )
        .await;
    ConversationRecord::update_status(fixture.pool(), conv_archived, SessionStatus::Archived)
        .await
        .expect("mark archived");

    let conv_auto = fixture.create_conversation(Some("native-auto")).await;
    fixture
        .seed_in_flight_turn(
            conv_auto,
            fixture.payload("scheduled task"),
            "running",
            true,
            Some(conversations::commit_reminder::AUTOMATION_ORIGIN),
        )
        .await;

    let conv_workflow = fixture.create_conversation(Some("native-wf")).await;
    let parent_wf = fixture.create_conversation(None).await;
    sqlx::query(
        r#"INSERT INTO conversation_relations (
               id, parent_conversation_id, child_conversation_id, kind, visibility, metadata_json
           ) VALUES (?, ?, ?, 'workflow_step', 'visible', '{}')"#,
    )
    .bind(Uuid::new_v4())
    .bind(parent_wf)
    .bind(conv_workflow)
    .execute(fixture.pool())
    .await
    .expect("insert workflow relation");
    fixture
        .seed_in_flight_turn(
            conv_workflow,
            fixture.payload("workflow step"),
            "running",
            true,
            None,
        )
        .await;

    let conv_deleted = fixture.create_conversation(Some("native-deleted")).await;
    fixture
        .seed_in_flight_turn(
            conv_deleted,
            fixture.payload("deleted"),
            "running",
            true,
            None,
        )
        .await;
    sqlx::query("UPDATE sessions SET deleted_at = datetime('now') WHERE id = ?")
        .bind(conv_deleted)
        .execute(fixture.pool())
        .await
        .expect("soft delete");

    fixture
        .service
        .recover_interrupted_turns()
        .await
        .expect("recover filtered");

    for (label, cid) in [
        ("done", conv_done),
        ("archived", conv_archived),
        ("auto", conv_auto),
        ("workflow", conv_workflow),
        ("deleted", conv_deleted),
    ] {
        let queued = ConversationInputRecord::list_for_conversation(fixture.pool(), cid)
            .await
            .expect("list records")
            .into_iter()
            .filter(|r| r.status == "queued")
            .count();
        assert_eq!(
            queued, 0,
            "{label} conversation {cid} must not auto-continue"
        );
    }
}

#[tokio::test]
async fn dispatches_multiple_interrupted_conversations_in_one_startup_pass() {
    let fixture = RestartFixture::new().await;
    let mut conversations = Vec::new();
    for idx in 0..4 {
        let cid = fixture
            .create_conversation(Some(&format!("native-multi-{idx}")))
            .await;
        fixture
            .seed_in_flight_turn(
                cid,
                fixture.payload(&format!("task {idx}")),
                "running",
                true,
                None,
            )
            .await;
        conversations.push(cid);
    }

    let recovered = fixture
        .service
        .recover_interrupted_turns()
        .await
        .expect("recover all");
    assert_eq!(recovered, 4);

    let started = fixture
        .service
        .dispatch_queued_inputs()
        .await
        .expect("dispatch all");
    assert_eq!(started, 4);

    for cid in conversations {
        let turns = ConversationTurnRecord::list_for_conversation(fixture.pool(), cid)
            .await
            .expect("list turns");
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].status, "interrupted");
        assert_eq!(turns[1].origin, RESTART_CONTINUATION_ORIGIN);
        fixture.wait_for_turn_status(turns[1].id, "running").await;
    }
}
