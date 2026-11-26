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
fn advertises_all_seventeen_orchestration_tools() {
    let schemas = orchestration_tool_schemas();
    assert_eq!(schemas.len(), 17);
    assert_eq!(ORCHESTRATION_TOOL_NAMES.len(), 17);
    for name in ORCHESTRATION_TOOL_NAMES {
        assert!(is_orchestration_tool(name), "missing tool {name}");
        assert!(
            schemas
                .iter()
                .any(|s| s.get("name").and_then(|v| v.as_str()) == Some(*name)),
            "schema missing for {name}"
        );
    }
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
    assert!(store.find_request(conv_id, &perm_id.to_string()).await.is_some());

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
