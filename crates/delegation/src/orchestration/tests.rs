use agents::{
    AgentPermissionId, AgentPermissionOption, AgentPermissionOptionKind, AgentPermissionRequest,
    AgentSessionId,
};
use chrono::{Duration, Utc};
use db::models::{
    conversation_delegation::{
        ConversationDelegationRecord, CreateConversationDelegation, McpIdempotencyReceipt,
    },
    project::{CreateProject, Project},
    session::{CreateSession, Session},
};
use serde_json::json;
use sqlx::{SqlitePool, sqlite::SqlitePoolOptions};
use uuid::Uuid;

use super::{
    PendingPermissionStore, conversation_link, idempotency_scope_key, is_orchestration_tool,
    orchestration_tool_schemas, tools::ORCHESTRATION_TOOL_NAMES, truncate_utf8_bytes,
};
use crate::mode_limit::{InteractionModeRank, OrchestrationModeLimit, RuntimeModeRank};

async fn setup_test_db() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("connect sqlite memory");
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .expect("enable foreign_keys");
    sqlx::migrate!("../db/migrations")
        .run(&pool)
        .await
        .expect("run migrations");
    pool
}

async fn seed_parent_and_child(pool: &SqlitePool) -> (Uuid, Uuid, Uuid, Uuid) {
    let project_id = Uuid::new_v4();
    Project::create(
        pool,
        &CreateProject {
            name: "test-project".into(),
            root_path: format!("/tmp/test-project-{project_id}"),
            parent_project_id: None,
            repositories: Vec::new(),
        },
        project_id,
    )
    .await
    .expect("create project");

    let task_id = Uuid::new_v4();
    sqlx::query(
        r#"INSERT INTO tasks (id, project_id, title, status)
           VALUES (?, ?, 'test-task', 'todo')"#,
    )
    .bind(task_id)
    .bind(project_id)
    .execute(pool)
    .await
    .expect("insert task");

    let workspace_id = Uuid::new_v4();
    sqlx::query(
        r#"INSERT INTO workspaces (id, project_id, task_id, branch, use_worktree)
           VALUES (?, ?, ?, 'main', 0)"#,
    )
    .bind(workspace_id)
    .bind(project_id)
    .bind(task_id)
    .execute(pool)
    .await
    .expect("insert workspace");

    let parent_id = Uuid::new_v4();
    let child_id = Uuid::new_v4();
    let mut conn = pool.acquire().await.expect("acquire conn");
    Session::create_on_connection(
        &mut conn,
        &CreateSession {
            executor: Some("codex".into()),
            agent_id: None,
            provider_instance_id: None,
            initial_prompt: None,
            name: Some("parent".into()),
            status: None,
            task_id: None,
        },
        parent_id,
        workspace_id,
    )
    .await
    .expect("create parent session");

    Session::create_on_connection(
        &mut conn,
        &CreateSession {
            executor: Some("codex".into()),
            agent_id: None,
            provider_instance_id: None,
            initial_prompt: None,
            name: Some("child".into()),
            status: None,
            task_id: None,
        },
        child_id,
        workspace_id,
    )
    .await
    .expect("create child session");

    (project_id, workspace_id, parent_id, child_id)
}

#[test]
fn advertises_all_eighteen_orchestration_tools() {
    let schemas = orchestration_tool_schemas();
    assert_eq!(schemas.len(), 18);
    assert_eq!(ORCHESTRATION_TOOL_NAMES.len(), 18);
    for name in ORCHESTRATION_TOOL_NAMES {
        assert!(is_orchestration_tool(name), "missing tool {name}");
        assert!(
            schemas
                .iter()
                .any(|s| s.get("name").and_then(|v| v.as_str()) == Some(*name)),
            "schema missing for {name}"
        );
    }
    assert!(is_orchestration_tool("environment_links"));
    assert!(!is_orchestration_tool("delegate_to_agent"));
    assert!(!is_orchestration_tool("list_spaces"));
}

#[test]
fn link_and_idempotency_helpers_are_deterministic() {
    let id = Uuid::new_v4();
    assert_eq!(
        conversation_link(id, None),
        format!("dimo://conversation/{id}")
    );
    assert_eq!(
        conversation_link(id, Some("remote-mac")),
        format!("dimo://conversation/{id}?env=remote-mac")
    );

    let k1 = idempotency_scope_key(id, "delegate_task", "req-1");
    let k2 = idempotency_scope_key(id, "delegate_task", " req-1 ");
    let k3 = idempotency_scope_key(id, "thread_launch", "req-1");
    assert_eq!(k1, k2);
    assert_ne!(k1, k3);
    assert_eq!(k1.len(), 64);

    let (truncated, did_truncate) = truncate_utf8_bytes("你好世界", 6);
    assert!(did_truncate);
    assert!(truncated.starts_with("你好"));
    assert!(truncated.ends_with("[truncated]"));
}

#[test]
fn mode_ceiling_header_and_escalation_guards() {
    let strict = OrchestrationModeLimit {
        max_runtime_mode: RuntimeModeRank::ApprovalRequired,
        max_interaction_mode: InteractionModeRank::Plan,
    };
    let permissive = OrchestrationModeLimit::full();
    assert!(!strict.allows_auto_approval());
    assert!(permissive.allows_auto_approval());

    let encoded = strict.to_header_value();
    assert_eq!(
        OrchestrationModeLimit::from_header_value(&encoded),
        Some(strict)
    );

    let clamped = strict.clamp(
        Some(RuntimeModeRank::FullAccess),
        Some(InteractionModeRank::Default),
    );
    assert_eq!(clamped, strict);
    assert_eq!(permissive.intersect(strict), strict);
}

#[tokio::test]
async fn sqlite_delegation_lifecycle_quotas_and_delivery_idempotency() {
    let pool = setup_test_db().await;
    let (project_id, workspace_id, parent_id, child_id) = seed_parent_and_child(&pool).await;
    let run_id = format!("run_{}", Uuid::new_v4());

    let created = ConversationDelegationRecord::create(
        &pool,
        CreateConversationDelegation {
            run_id: &run_id,
            parent_conversation_id: parent_id,
            child_conversation_id: child_id,
            parent_tool_call_id: "tool_1",
            target_environment_id: None,
            target_project_id: Some(project_id),
            target_workspace_id: Some(workspace_id),
            agent_id: "codex",
            provider_instance_id: None,
            model: Some("gpt-5"),
            role: Some("reviewer"),
            task_preview: "Review diff and run unit tests",
            isolation: "worktree",
            mode: "async",
            completion_wake: "always",
            status: "preparing",
            preparation_stage: Some("allocating_worktree"),
            worktree_path: None,
            branch: None,
            max_runtime_mode: RuntimeModeRank::ApprovalRequired.as_i64(),
            max_interaction_mode: InteractionModeRank::Default.as_i64(),
            deadline_at: Some(Utc::now() - Duration::seconds(5)),
        },
    )
    .await
    .expect("create delegation record");
    assert_eq!(created.status, "preparing");
    assert_eq!(
        ConversationDelegationRecord::count_active_for_parent(&pool, parent_id)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        ConversationDelegationRecord::count_total_for_parent(&pool, parent_id)
            .await
            .unwrap(),
        1
    );

    // Expired watchdog query should detect overdue preparing/running records.
    let expired = ConversationDelegationRecord::list_expired_active(&pool, Utc::now())
        .await
        .unwrap();
    assert_eq!(expired.len(), 1);
    assert_eq!(expired[0].run_id, run_id);

    // Transition preparing -> running -> waiting_for_input -> running -> completed.
    ConversationDelegationRecord::update_preparation(
        &pool,
        &run_id,
        "running",
        None,
        Some(workspace_id),
        Some("/tmp/wt-1"),
        Some("dimo/delegation-1"),
    )
    .await
    .unwrap();
    let waiting = ConversationDelegationRecord::mark_waiting_for_input(&pool, child_id)
        .await
        .unwrap()
        .expect("waiting");
    assert_eq!(waiting.status, "waiting_for_input");
    assert_eq!(
        ConversationDelegationRecord::resume_running(&pool, child_id)
            .await
            .unwrap(),
        1
    );

    let finished = ConversationDelegationRecord::finish(
        &pool,
        &run_id,
        "completed",
        Some("All tests pass."),
        None,
        None,
    )
    .await
    .unwrap()
    .expect("finished");
    assert_eq!(finished.status, "completed");
    assert_eq!(finished.result_summary.as_deref(), Some("All tests pass."));
    assert_eq!(
        ConversationDelegationRecord::count_active_for_parent(&pool, parent_id)
            .await
            .unwrap(),
        0
    );

    // Undelivered completions list + mark_delivered idempotency.
    let undelivered = ConversationDelegationRecord::list_undelivered_for_parent(&pool, parent_id)
        .await
        .unwrap();
    assert_eq!(undelivered.len(), 1);
    assert_eq!(
        ConversationDelegationRecord::mark_delivered(&pool, std::slice::from_ref(&run_id))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        ConversationDelegationRecord::mark_delivered(&pool, std::slice::from_ref(&run_id))
            .await
            .unwrap(),
        0
    );
    assert!(
        ConversationDelegationRecord::list_undelivered_for_parent(&pool, parent_id)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn idempotency_receipt_persists_in_sqlite() {
    let pool = setup_test_db().await;
    let key = idempotency_scope_key(Uuid::new_v4(), "thread_launch", "idem-42");
    assert!(
        McpIdempotencyReceipt::find(&pool, &key)
            .await
            .unwrap()
            .is_none()
    );
    let payload = json!({ "conversation_id": Uuid::new_v4(), "status": "preparing" }).to_string();
    McpIdempotencyReceipt::put(&pool, &key, "thread_launch", &payload)
        .await
        .unwrap();
    let loaded = McpIdempotencyReceipt::find(&pool, &key)
        .await
        .unwrap()
        .expect("stored receipt");
    assert_eq!(loaded.tool_name, "thread_launch");
    assert_eq!(loaded.response_json, payload);
}

#[tokio::test]
async fn pending_permission_store_round_trip() {
    let store = PendingPermissionStore::default();
    let conv_id = Uuid::new_v4();
    let perm_id = AgentPermissionId(Uuid::new_v4());
    store
        .insert(
            conv_id,
            AgentPermissionRequest {
                id: perm_id,
                session_id: AgentSessionId::from(conv_id),
                title: "Run git push".into(),
                details: Some(json!("git push origin feat")),
                options: vec![AgentPermissionOption {
                    id: "opt-allow".into(),
                    label: "Allow once".into(),
                    kind: AgentPermissionOptionKind::AllowOnce,
                    description: None,
                }],
                revision: 1,
            },
        )
        .await;

    let entries = store.list_entries(conv_id).await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].permission_id, perm_id.to_string());
    assert_eq!(entries[0].summary, "git push origin feat");
    assert!(
        store
            .find_request(conv_id, &perm_id.to_string())
            .await
            .is_some()
    );

    store.remove(conv_id, &perm_id.to_string()).await;
    assert!(store.list_entries(conv_id).await.is_empty());
}

#[tokio::test]
async fn orchestration_scratch_workspace_and_session_fk_roundtrip() {
    let pool = setup_test_db().await;
    let first = conversations::ensure_orchestration_scratch_workspace(&pool)
        .await
        .expect("create scratch workspace");
    let second = conversations::ensure_orchestration_scratch_workspace(&pool)
        .await
        .expect("reuse scratch workspace");
    assert_eq!(first.project_id, second.project_id);
    assert_eq!(first.workspace_id, second.workspace_id);

    let conv_id = Uuid::new_v4();
    conversations::create_orchestrated_conversation(
        &pool,
        conversations::CreateOrchestratedConversation {
            id: conv_id,
            parent_conversation_id: None,
            parent_tool_call_id: None,
            delegation_id: None,
            workspace_id: first.workspace_id,
            agent_id: agents::AgentId::parse("codex").unwrap(),
            provider_instance_id: None,
            title: Some("Scratch thread".into()),
            initial_prompt: Some("Hello scratch".into()),
            policy: json!({ "scratch": true }),
        },
    )
    .await
    .expect("create orchestrated conversation with scratch workspace FK");

    let session = Session::find_by_id(&pool, conv_id)
        .await
        .expect("query session")
        .expect("session exists");
    assert_eq!(session.workspace_id, first.workspace_id);
    assert_eq!(session.name.as_deref(), Some("Scratch thread"));
}

#[tokio::test]
async fn explicit_cancel_mark_delivered_excludes_from_undelivered_queue() {
    let pool = setup_test_db().await;
    let (project_id, workspace_id, parent_id, child_id) = seed_parent_and_child(&pool).await;
    let run_id = format!("run_cancel_{}", Uuid::new_v4());

    ConversationDelegationRecord::create(
        &pool,
        CreateConversationDelegation {
            run_id: &run_id,
            parent_conversation_id: parent_id,
            child_conversation_id: child_id,
            parent_tool_call_id: "tool_cancel",
            target_environment_id: None,
            target_project_id: Some(project_id),
            target_workspace_id: Some(workspace_id),
            agent_id: "codex",
            provider_instance_id: None,
            model: None,
            role: None,
            task_preview: "Long task to cancel",
            isolation: "shared",
            mode: "async",
            completion_wake: "always",
            status: "running",
            preparation_stage: None,
            worktree_path: None,
            branch: None,
            max_runtime_mode: RuntimeModeRank::FullAccess.as_i64(),
            max_interaction_mode: InteractionModeRank::Default.as_i64(),
            deadline_at: None,
        },
    )
    .await
    .expect("create delegation");

    let cancelled = ConversationDelegationRecord::finish(
        &pool,
        &run_id,
        "cancelled",
        None,
        Some("cancelled"),
        Some("cancelled by parent"),
    )
    .await
    .expect("finish cancelled")
    .expect("row updated");
    assert_eq!(cancelled.status, "cancelled");

    ConversationDelegationRecord::mark_delivered(&pool, std::slice::from_ref(&run_id))
        .await
        .expect("mark cancelled run delivered");
    let undelivered = ConversationDelegationRecord::list_undelivered_for_parent(&pool, parent_id)
        .await
        .expect("query undelivered");
    assert!(undelivered.is_empty());
}

#[test]
fn compose_message_with_attachments_handles_all_cases() {
    use super::launch::compose_message_with_attachments;

    assert_eq!(compose_message_with_attachments(None, &[]), None);
    assert_eq!(
        compose_message_with_attachments(Some("  "), &["".into(), "   ".into()]),
        None
    );
    assert_eq!(
        compose_message_with_attachments(Some("Inspect logs"), &[]),
        Some("Inspect logs".into())
    );
    assert_eq!(
        compose_message_with_attachments(None, &["/tmp/a.log".into(), " /tmp/b.png ".into()]),
        Some("[Attached files]\n- /tmp/a.log\n- /tmp/b.png\n".into())
    );
    assert_eq!(
        compose_message_with_attachments(Some("Please check"), &["/tmp/a.log".into()]),
        Some("Please check\n\n[Attached files]\n- /tmp/a.log\n".into())
    );
}

#[test]
fn agent_entry_is_launchable_distinguishes_ready_from_uninstalled_and_disabled() {
    use super::launch::agent_entry_is_launchable;

    assert!(agent_entry_is_launchable(&json!({
        "agent_id": "codex",
        "enabled": true,
        "lifecycle": "ready"
    })));
    assert!(agent_entry_is_launchable(&json!({
        "agent_id": "claude_code",
        "enabled": true,
        "lifecycle": "needs_auth"
    })));
    assert!(agent_entry_is_launchable(&json!({
        "agent_id": "gemini",
        "enabled": true,
        "lifecycle": "needs_config"
    })));
    assert!(!agent_entry_is_launchable(&json!({
        "agent_id": "claude_code",
        "enabled": false,
        "lifecycle": "ready"
    })));
    assert!(!agent_entry_is_launchable(&json!({
        "agent_id": "claude_code",
        "enabled": true,
        "lifecycle": "uninstalled"
    })));
    assert!(!agent_entry_is_launchable(&json!({
        "agent_id": "claude_code",
        "enabled": true,
        "lifecycle": "needs_repair"
    })));
}

#[tokio::test]
async fn remote_originated_delegation_avoids_parent_session_fk_violation() {
    use conversations::{CreateOrchestratedConversation, create_orchestrated_conversation};

    let pool = setup_test_db().await;
    let (_project_id, workspace_id, _parent_id, _existing_child) =
        seed_parent_and_child(&pool).await;

    let child_id = Uuid::new_v4();
    let remote_parent_id = Uuid::new_v4(); // Does NOT exist in local `sessions` table!
    let run_id = format!("run_remote_fk_{}", Uuid::new_v4().simple());

    // Passing `parent_conversation_id: None` on `sessions` avoids FK failure under PRAGMA foreign_keys = ON,
    // while `conversation_delegations` preserves `remote_parent_id` without FK constraints.
    create_orchestrated_conversation(
        &pool,
        CreateOrchestratedConversation {
            id: child_id,
            parent_conversation_id: None,
            parent_tool_call_id: Some("tool_remote_1".into()),
            delegation_id: Some(run_id.clone()),
            workspace_id,
            agent_id: agents::AgentId::parse("codex").unwrap(),
            provider_instance_id: None,
            title: Some("Remote Child".into()),
            initial_prompt: Some("Run tests on remote host".into()),
            policy: json!({
                "remoteParentConversationId": remote_parent_id,
            }),
        },
    )
    .await
    .expect("remote-originated child session should insert without FK error");

    let rec = ConversationDelegationRecord::create(
        &pool,
        CreateConversationDelegation {
            run_id: &run_id,
            parent_conversation_id: remote_parent_id,
            child_conversation_id: child_id,
            parent_tool_call_id: "tool_remote_1",
            target_project_id: None,
            target_workspace_id: Some(workspace_id),
            target_environment_id: None,
            agent_id: "codex",
            provider_instance_id: None,
            model: None,
            role: None,
            task_preview: "Run tests on remote host",
            isolation: "shared",
            mode: "async",
            completion_wake: "always",
            status: "running",
            preparation_stage: Some("ready"),
            worktree_path: None,
            branch: None,
            max_runtime_mode: RuntimeModeRank::FullAccess.as_i64(),
            max_interaction_mode: InteractionModeRank::Default.as_i64(),
            deadline_at: None,
        },
    )
    .await
    .expect("delegation row with remote parent id should insert cleanly");

    assert_eq!(rec.parent_conversation_id, remote_parent_id);
    let session = Session::find_by_id(&pool, child_id)
        .await
        .expect("query session")
        .expect("session exists");
    assert_eq!(session.parent_session_id, None);
    assert_eq!(session.delegation_call_id.as_deref(), Some(run_id.as_str()));
}

#[tokio::test]
async fn remote_shadow_row_syncs_status_and_formats_env_deep_link() {
    use super::reactors::{format_coalesced_completion_message, sync_remote_status_into_shadow};

    let pool = setup_test_db().await;
    let (_project_id, _workspace_id, parent_id, _local_child) = seed_parent_and_child(&pool).await;

    let remote_child_id = Uuid::new_v4(); // Lives on remote Host, NOT in local `sessions`!
    let run_id = format!("run_shadow_{}", Uuid::new_v4().simple());

    ConversationDelegationRecord::create(
        &pool,
        CreateConversationDelegation {
            run_id: &run_id,
            parent_conversation_id: parent_id,
            child_conversation_id: remote_child_id,
            parent_tool_call_id: "tool_shadow_1",
            target_project_id: None,
            target_workspace_id: None,
            target_environment_id: Some("gpu-box"),
            agent_id: "claude_code",
            provider_instance_id: None,
            model: Some("claude-sonnet-4-6"),
            role: Some("Remote Trainer"),
            task_preview: "Train evaluation baseline",
            isolation: "worktree",
            mode: "async",
            completion_wake: "always",
            status: "preparing",
            preparation_stage: Some("creating_worktree"),
            worktree_path: None,
            branch: None,
            max_runtime_mode: RuntimeModeRank::ApprovalRequired.as_i64(),
            max_interaction_mode: InteractionModeRank::Default.as_i64(),
            deadline_at: Some(Utc::now() + Duration::minutes(5)),
        },
    )
    .await
    .expect("insert local shadow row");

    // Intermediate running sync should not mark terminal.
    let still_running = sync_remote_status_into_shadow(
        &pool,
        &run_id,
        &json!({
            "run_id": run_id,
            "status": "running",
            "preparation_stage": "ready",
            "branch": "feat/gpu-eval",
            "worktree_path": "/srv/worktrees/gpu-eval",
        }),
        4096,
    )
    .await;
    assert!(still_running.is_none());

    // Terminal sync finishes shadow row and preserves branch/worktree/result_summary.
    let finished = sync_remote_status_into_shadow(
        &pool,
        &run_id,
        &json!({
            "run_id": run_id,
            "status": "completed",
            "result_summary": "Eval passed with 98.4% accuracy.",
            "branch": "feat/gpu-eval",
            "worktree_path": "/srv/worktrees/gpu-eval",
        }),
        4096,
    )
    .await
    .expect("terminal shadow transition");

    assert_eq!(finished.status, "completed");
    assert_eq!(finished.target_environment_id.as_deref(), Some("gpu-box"));
    assert_eq!(finished.branch.as_deref(), Some("feat/gpu-eval"));
    assert_eq!(
        finished.result_summary.as_deref(),
        Some("Eval passed with 98.4% accuracy.")
    );

    let msg = format_coalesced_completion_message(std::slice::from_ref(&finished));
    assert!(
        msg.contains(&format!(
            "dimo://conversation/{remote_child_id}?env=gpu-box"
        )),
        "completion message must include ?env=gpu-box deep link, got: {msg}"
    );
    assert!(msg.contains("Eval passed with 98.4% accuracy."));
}

#[tokio::test]
async fn orchestration_before_turn_instructions_gate_first_turn_child_space_and_disabled() {
    use super::instructions::{
        DELEGATED_CHILD_INSTRUCTIONS, ORCHESTRATION_PLUGIN_ID,
        TOP_LEVEL_ORCHESTRATION_INSTRUCTIONS, build_orchestration_before_turn_blocks,
    };

    let pool = setup_test_db().await;
    let (_project_id, workspace_id, parent_id, child_id) = seed_parent_and_child(&pool).await;

    let parent_ctx = conversations::BeforeTurnContext {
        conversation_id: parent_id,
        workspace_id,
        agent_id: agents::AgentId::parse("codex").unwrap(),
        text: "Help me inspect this repo".into(),
        display_text: "Help me inspect this repo".into(),
        origin: "user".into(),
    };

    // 1. Disabled -> empty.
    let disabled = build_orchestration_before_turn_blocks(&pool, &parent_ctx, false).await;
    assert!(disabled.is_empty());

    // 2. Collaboration origin -> empty.
    let mut collab_ctx = parent_ctx.clone();
    collab_ctx.origin = "collaboration".into();
    let collab_blocks = build_orchestration_before_turn_blocks(&pool, &collab_ctx, true).await;
    assert!(collab_blocks.is_empty());

    // 3. Ordinary session turn #1 -> injects concise top-level orchestration block.
    let turn1_blocks = build_orchestration_before_turn_blocks(&pool, &parent_ctx, true).await;
    assert_eq!(turn1_blocks.len(), 1);
    assert_eq!(turn1_blocks[0].plugin_id, ORCHESTRATION_PLUGIN_ID);
    assert_eq!(
        turn1_blocks[0].content,
        TOP_LEVEL_ORCHESTRATION_INSTRUCTIONS
    );

    // 4. Turn #2+ -> skipped once conversation_turns has >= 2 rows.
    for idx in 0..2 {
        db::models::conversation_turn::ConversationTurnRecord::create_pending(
            &pool,
            Uuid::new_v4(),
            db::models::conversation_turn::CreateConversationTurn {
                conversation_id: parent_id,
                prompt_id: None,
                text_preview: Some(&format!("turn {idx}")),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("insert turn");
    }
    let turn2_blocks = build_orchestration_before_turn_blocks(&pool, &parent_ctx, true).await;
    assert!(turn2_blocks.is_empty());

    // 5. Delegated child session -> injects compact child instructions.
    let run_id = format!("run_child_instr_{}", Uuid::new_v4().simple());
    ConversationDelegationRecord::create(
        &pool,
        CreateConversationDelegation {
            run_id: &run_id,
            parent_conversation_id: parent_id,
            child_conversation_id: child_id,
            parent_tool_call_id: "tool_instr",
            target_project_id: None,
            target_workspace_id: Some(workspace_id),
            target_environment_id: None,
            agent_id: "codex",
            provider_instance_id: None,
            model: None,
            role: None,
            task_preview: "Child task",
            isolation: "shared",
            mode: "async",
            completion_wake: "always",
            status: "running",
            preparation_stage: Some("ready"),
            worktree_path: None,
            branch: None,
            max_runtime_mode: RuntimeModeRank::FullAccess.as_i64(),
            max_interaction_mode: InteractionModeRank::Default.as_i64(),
            deadline_at: None,
        },
    )
    .await
    .expect("insert child delegation");
    let child_ctx = conversations::BeforeTurnContext {
        conversation_id: child_id,
        workspace_id,
        agent_id: agents::AgentId::parse("codex").unwrap(),
        text: "Do child task".into(),
        display_text: "Do child task".into(),
        origin: "user".into(),
    };
    let child_blocks = build_orchestration_before_turn_blocks(&pool, &child_ctx, true).await;
    assert_eq!(child_blocks.len(), 1);
    assert_eq!(child_blocks[0].content, DELEGATED_CHILD_INSTRUCTIONS);

    // 6. Collaboration Space session -> strictly skipped even when origin is "user".
    let space_id = Uuid::new_v4().to_string();
    let bot_conv_id = Uuid::new_v4();
    let mut conn = pool.acquire().await.expect("conn");
    Session::create_on_connection(
        &mut conn,
        &CreateSession {
            executor: Some("codex".into()),
            agent_id: None,
            provider_instance_id: None,
            initial_prompt: None,
            name: Some("Bot Space Session".into()),
            status: None,
            task_id: None,
        },
        bot_conv_id,
        workspace_id,
    )
    .await
    .expect("create bot session");
    drop(conn);
    sqlx::query(
        r#"INSERT INTO collaboration_spaces (id, workspace_id, name, created_at)
           VALUES (?, ?, 'Bot Space', datetime('now'))"#,
    )
    .bind(&space_id)
    .bind(workspace_id.to_string())
    .execute(&pool)
    .await
    .expect("insert space");
    sqlx::query(
        r#"INSERT INTO collaboration_space_members (space_id, member_id, conversation_id, nickname, kind, visible_to_agents)
           VALUES (?, ?, ?, 'HelperBot', 'agent', 1)"#,
    )
    .bind(&space_id)
    .bind(Uuid::new_v4().to_string())
    .bind(bot_conv_id.to_string())
    .execute(&pool)
    .await
    .expect("insert space member");

    let space_ctx = conversations::BeforeTurnContext {
        conversation_id: bot_conv_id,
        workspace_id,
        agent_id: agents::AgentId::parse("codex").unwrap(),
        text: "Hello bot".into(),
        display_text: "Hello bot".into(),
        origin: "user".into(),
    };
    let space_blocks = build_orchestration_before_turn_blocks(&pool, &space_ctx, true).await;
    assert!(
        space_blocks.is_empty(),
        "Collaboration Space sessions must never receive orchestration instructions"
    );
}
