//! Event-driven reactors for SQLite Single-Authority orchestration:
//! - `DelegationCompletionReactor`: captures child terminal turns, updates
//!   `conversation_delegations`, emits `AgentEvent::DelegationCompleted`, and
//!   pushes coalesced durable wakeup messages back into the parent conversation.
//! - `DelegationQuestionReactor`: routes child `PermissionRequested` events to
//!   the parent conversation (`pending_request` read/respond) so async children
//!   never silently hang waiting for approval.
//! - `DeadlineWatchdog`: cancels expired `preparing`/`running` delegations.
//! - `run_startup_reconciler`: crash-recovery on server boot.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use agents::{
    AgentContentBlock, AgentEvent, AgentId, AgentPermissionRequest, AgentRuntime, AgentSessionId,
    events::DelegationResultSummary,
};
use chrono::Utc;
use conversations::{
    ConversationContext, ConversationSessionService, ScopedConversationControl,
    rollback_prepared_workspace,
};
use db::models::{conversation_delegation::ConversationDelegationRecord, session::Session};
use serde_json::{Value, json};
use tokio::{
    sync::{Mutex, broadcast::error::RecvError},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    ActivePreparations, DEFAULT_COALESCE_WINDOW_MS, DEFAULT_MAX_RESULT_BYTES,
    PendingPermissionEntry, SharedRemoteForwarder, conversation_link, truncate_utf8_bytes,
};
use crate::{
    assistant_reply::AssistantReplyAccumulator,
    mode_limit::{InteractionModeRank, OrchestrationModeLimit, RuntimeModeRank},
    stop_reason::{StopClass, classify_stop_reason},
};

/// In-memory index of active permission requests awaiting response on child
/// conversations, fed directly from `AgentEvent::PermissionRequested` and
/// cleared on `PermissionResponded` / turn end.
#[derive(Default, Clone)]
pub struct PendingPermissionStore {
    by_conversation: Arc<Mutex<HashMap<Uuid, Vec<AgentPermissionRequest>>>>,
}

impl PendingPermissionStore {
    pub async fn insert(&self, conversation_id: Uuid, request: AgentPermissionRequest) {
        let mut guard = self.by_conversation.lock().await;
        let list = guard.entry(conversation_id).or_default();
        list.retain(|existing| existing.id != request.id);
        list.push(request);
    }

    pub async fn remove(&self, conversation_id: Uuid, permission_id: &str) {
        let mut guard = self.by_conversation.lock().await;
        if let Some(list) = guard.get_mut(&conversation_id) {
            list.retain(|existing| existing.id.to_string() != permission_id);
            if list.is_empty() {
                guard.remove(&conversation_id);
            }
        }
    }

    pub async fn clear_conversation(&self, conversation_id: Uuid) {
        self.by_conversation.lock().await.remove(&conversation_id);
    }

    pub async fn list_entries(&self, conversation_id: Uuid) -> Vec<PendingPermissionEntry> {
        let guard = self.by_conversation.lock().await;
        guard
            .get(&conversation_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|req| {
                let summary = req
                    .details
                    .as_ref()
                    .map(|val| match val {
                        serde_json::Value::String(s) => s.clone(),
                        other => other.to_string(),
                    })
                    .unwrap_or_else(|| req.title.clone());
                PendingPermissionEntry {
                    permission_id: req.id.to_string(),
                    tool_name: req.title.clone(),
                    summary,
                    options: req
                        .options
                        .into_iter()
                        .map(|opt| {
                            json!({
                                "option_id": opt.id,
                                "label": opt.label,
                                "kind": format!("{:?}", opt.kind),
                            })
                        })
                        .collect(),
                }
            })
            .collect()
    }

    pub async fn find_request(
        &self,
        conversation_id: Uuid,
        permission_id: &str,
    ) -> Option<AgentPermissionRequest> {
        let guard = self.by_conversation.lock().await;
        guard
            .get(&conversation_id)?
            .iter()
            .find(|req| req.id.to_string() == permission_id)
            .cloned()
    }
}

pub struct DelegationReactors {
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for DelegationReactors {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// Spawn the completion reactor, question/permission reactor, and deadline watchdog.
pub fn spawn_orchestration_reactors(
    context: ConversationContext,
    runtime: Arc<AgentRuntime>,
    preparations: ActivePreparations,
    pending_permissions: PendingPermissionStore,
    max_result_bytes: usize,
) -> DelegationReactors {
    let coalescing_parents = Arc::new(Mutex::new(HashSet::<Uuid>::new()));

    let event_task = spawn_event_reactor(
        context.clone(),
        runtime.clone(),
        pending_permissions.clone(),
        coalescing_parents.clone(),
        max_result_bytes,
    );
    let watchdog_task =
        spawn_deadline_watchdog(context.clone(), runtime, preparations, coalescing_parents);

    DelegationReactors {
        tasks: vec![event_task, watchdog_task],
    }
}

/// Reconcile interrupted delegations on `dimo-server` boot:
/// 1. Mark stale local `preparing`/`running`/`waiting_for_input` rows failed & clean orphan worktrees.
/// 2. Redeliver any finished `async` delegations whose `delivered_at IS NULL`.
pub async fn run_startup_reconciler(context: ConversationContext) {
    run_startup_reconciler_with_remote(context, None, None, None, DEFAULT_MAX_RESULT_BYTES).await;
}

/// Remote-aware startup reconciler that resumes cross-Host delegation watchers
/// for unfinished shadow rows (`target_environment_id IS NOT NULL`) when a
/// `RemoteMcpForwarder` is configured and the deadline has not passed.
pub async fn run_startup_reconciler_with_remote(
    context: ConversationContext,
    runtime: Option<Arc<AgentRuntime>>,
    preparations: Option<ActivePreparations>,
    remote_forwarder: Option<SharedRemoteForwarder>,
    max_result_bytes: usize,
) {
    let pool = &context.deployment.db().pool;
    let unfinished = match ConversationDelegationRecord::list_all_unfinished(pool).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(%error, "startup reconciler failed to list unfinished delegations");
            return;
        }
    };

    let coalescing_parents = Arc::new(Mutex::new(HashSet::<Uuid>::new()));

    for row in unfinished {
        if let Some(env_id) = row.target_environment_id.clone() {
            // Never try to roll back a remote Host's workspace locally.
            let deadline_active = row.deadline_at.is_none_or(|d| d > Utc::now());
            if deadline_active
                && let (Some(forwarder), Some(rt), Some(preps)) = (
                    remote_forwarder.clone(),
                    runtime.clone(),
                    preparations.clone(),
                )
            {
                let mode_limit = OrchestrationModeLimit {
                    max_runtime_mode: RuntimeModeRank::from_i64(row.max_runtime_mode),
                    max_interaction_mode: InteractionModeRank::from_i64(row.max_interaction_mode),
                };
                let cancel_token = preps.register(row.child_conversation_id).await;
                spawn_remote_delegation_watcher(RemoteDelegationWatchSpec {
                    context: context.clone(),
                    runtime: rt,
                    preparations: preps,
                    forwarder,
                    coalescing_parents: coalescing_parents.clone(),
                    environment_id: env_id,
                    run_id: row.run_id,
                    child_conversation_id: row.child_conversation_id,
                    mode_limit,
                    deadline_at: row.deadline_at,
                    max_result_bytes,
                    cancel_token,
                    initial_poll_interval: Duration::from_secs(2),
                });
                continue;
            }
        } else if row.status == "preparing"
            && let Some(workspace_id) = row.target_workspace_id
        {
            let _ = rollback_prepared_workspace(&context, workspace_id).await;
        }

        let _ = ConversationDelegationRecord::finish(
            pool,
            &row.run_id,
            "failed",
            None,
            Some("host_restarted"),
            Some("Host restarted before delegated task finished"),
        )
        .await;
    }

    let undelivered = match ConversationDelegationRecord::list_all_undelivered(pool).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(%error, "startup reconciler failed to list undelivered delegations");
            return;
        }
    };
    let mut parents = HashSet::new();
    for row in undelivered {
        parents.insert(row.parent_conversation_id);
    }
    for parent_id in parents {
        deliver_coalesced_completions(&context, parent_id).await;
    }
}

fn spawn_event_reactor(
    context: ConversationContext,
    runtime: Arc<AgentRuntime>,
    pending_permissions: PendingPermissionStore,
    coalescing_parents: Arc<Mutex<HashSet<Uuid>>>,
    max_result_bytes: usize,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut rx = runtime.subscribe_events();
        let mut replies = HashMap::<Uuid, AssistantReplyAccumulator>::new();
        let max_bytes = if max_result_bytes == 0 {
            DEFAULT_MAX_RESULT_BYTES
        } else {
            max_result_bytes
        };

        loop {
            let envelope = match rx.recv().await {
                Ok(env) => env,
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            };
            let Some(child_id) = envelope.session_id.map(|id| id.0) else {
                continue;
            };
            let pool = &context.deployment.db().pool;

            match &envelope.event {
                AgentEvent::MessageChunk {
                    content: AgentContentBlock::Text { text },
                } => {
                    replies.entry(child_id).or_default().push_text(text);
                }
                AgentEvent::ToolCall { .. } => {
                    replies.entry(child_id).or_default().start_tool();
                }
                AgentEvent::PermissionRequested { request } => {
                    pending_permissions.insert(child_id, request.clone()).await;
                    if let Ok(Some(record)) =
                        ConversationDelegationRecord::mark_waiting_for_input(pool, child_id).await
                    {
                        notify_parent_of_pending_permission(&context, &record, request).await;
                    }
                }
                AgentEvent::PermissionResponded { permission_id, .. } => {
                    pending_permissions
                        .remove(child_id, &permission_id.to_string())
                        .await;
                    let _ = ConversationDelegationRecord::resume_running(pool, child_id).await;
                }
                AgentEvent::TurnCompleted { stop_reason }
                | AgentEvent::PromptFinished {
                    finished: agents::AgentPromptFinished { stop_reason, .. },
                } => {
                    pending_permissions.clear_conversation(child_id).await;
                    let raw_text = replies
                        .remove(&child_id)
                        .map(|acc| acc.finish())
                        .unwrap_or_default();
                    let (summary, _) = truncate_utf8_bytes(&raw_text, max_bytes);

                    let Ok(Some(record)) =
                        ConversationDelegationRecord::find_by_child_conversation(pool, child_id)
                            .await
                    else {
                        continue;
                    };
                    if record.is_terminal() {
                        continue;
                    }

                    let (status, error_code, error_message, result_summary) =
                        match classify_stop_reason(stop_reason.as_deref()) {
                            StopClass::EndTurn => ("completed", None, None, Some(summary.as_str())),
                            StopClass::Cancelled => (
                                "cancelled",
                                Some("cancelled"),
                                Some("Delegated child turn was cancelled"),
                                None,
                            ),
                            StopClass::MaxTokens => (
                                "failed",
                                Some("max_tokens"),
                                Some("Delegated child hit max_tokens stop reason"),
                                (!summary.is_empty()).then_some(summary.as_str()),
                            ),
                            StopClass::MaxTurnRequests => (
                                "failed",
                                Some("max_turn_requests"),
                                Some("Delegated child hit max_turn_requests stop reason"),
                                (!summary.is_empty()).then_some(summary.as_str()),
                            ),
                            StopClass::Refusal => (
                                "failed",
                                Some("refusal"),
                                Some("Delegated child refused the request"),
                                (!summary.is_empty()).then_some(summary.as_str()),
                            ),
                            StopClass::Unknown(_) => (
                                "failed",
                                Some("child_unknown"),
                                Some("Delegated child turn ended with an unknown stop reason"),
                                (!summary.is_empty()).then_some(summary.as_str()),
                            ),
                        };

                    if let Ok(Some(finished)) = ConversationDelegationRecord::finish(
                        pool,
                        &record.run_id,
                        status,
                        result_summary,
                        error_code,
                        error_message,
                    )
                    .await
                    {
                        emit_parent_completion_event(&runtime, &finished).await;
                        maybe_schedule_parent_wakeup(
                            context.clone(),
                            coalescing_parents.clone(),
                            &finished,
                        )
                        .await;
                    }
                }
                AgentEvent::Error { error } => {
                    pending_permissions.clear_conversation(child_id).await;
                    replies.remove(&child_id);
                    let Ok(Some(record)) =
                        ConversationDelegationRecord::find_by_child_conversation(pool, child_id)
                            .await
                    else {
                        continue;
                    };
                    if record.is_terminal() {
                        continue;
                    }
                    if let Ok(Some(finished)) = ConversationDelegationRecord::finish(
                        pool,
                        &record.run_id,
                        "failed",
                        None,
                        Some("runtime_error"),
                        Some(&error.message),
                    )
                    .await
                    {
                        emit_parent_completion_event(&runtime, &finished).await;
                        maybe_schedule_parent_wakeup(
                            context.clone(),
                            coalescing_parents.clone(),
                            &finished,
                        )
                        .await;
                    }
                }
                _ => {}
            }
        }
    })
}

fn spawn_deadline_watchdog(
    context: ConversationContext,
    runtime: Arc<AgentRuntime>,
    preparations: ActivePreparations,
    coalescing_parents: Arc<Mutex<HashSet<Uuid>>>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        loop {
            interval.tick().await;
            let pool = &context.deployment.db().pool;
            let expired =
                match ConversationDelegationRecord::list_expired_active(pool, Utc::now()).await {
                    Ok(rows) => rows,
                    Err(_) => continue,
                };
            for row in expired {
                preparations.cancel(row.child_conversation_id).await;
                if row.target_environment_id.is_none() {
                    let service = ConversationSessionService::new(context.clone());
                    let _ = service
                        .cancel_turn(
                            row.child_conversation_id,
                            Some("delegated task deadline exceeded".to_string()),
                        )
                        .await;
                }
                if let Ok(Some(finished)) = ConversationDelegationRecord::finish(
                    pool,
                    &row.run_id,
                    "timed_out",
                    None,
                    Some("timed_out"),
                    Some("Delegated task exceeded deadline_at"),
                )
                .await
                {
                    emit_parent_completion_event(&runtime, &finished).await;
                    maybe_schedule_parent_wakeup(
                        context.clone(),
                        coalescing_parents.clone(),
                        &finished,
                    )
                    .await;
                }
            }
        }
    })
}

pub(crate) async fn emit_parent_completion_event(
    runtime: &AgentRuntime,
    record: &ConversationDelegationRecord,
) {
    if record.parent_conversation_id.is_nil() {
        return;
    }
    let Some(parent_conn_id) = runtime
        .live_connection_id(AgentSessionId::from(record.parent_conversation_id))
        .await
    else {
        return;
    };
    let Ok(agent_id) = AgentId::parse(&record.agent_id) else {
        return;
    };
    let duration_ms = record
        .finished_at
        .map(|end| (end - record.created_at).num_milliseconds().max(0) as u64);
    let result = if record.status == "completed" {
        DelegationResultSummary::Ok {
            duration_ms,
            text_preview: record.result_summary.clone(),
        }
    } else {
        DelegationResultSummary::Err {
            error_code: record
                .error_code
                .clone()
                .unwrap_or_else(|| record.status.clone()),
        }
    };
    runtime
        .emit_external(
            parent_conn_id,
            Some(AgentSessionId::from(record.parent_conversation_id)),
            AgentEvent::DelegationCompleted {
                delegation_id: record.run_id.clone(),
                parent_tool_use_id: record.parent_tool_call_id.clone(),
                child_session_id: record.child_conversation_id,
                agent_id,
                result,
            },
        )
        .await;
}

async fn has_local_parent_session(pool: &sqlx::SqlitePool, parent_id: Uuid) -> bool {
    if parent_id.is_nil() {
        return false;
    }
    Session::find_by_id(pool, parent_id)
        .await
        .ok()
        .flatten()
        .is_some()
}

async fn notify_parent_of_pending_permission(
    context: &ConversationContext,
    record: &ConversationDelegationRecord,
    request: &AgentPermissionRequest,
) {
    let pool = &context.deployment.db().pool;
    if !has_local_parent_session(pool, record.parent_conversation_id).await {
        return;
    }
    let options_text = request
        .options
        .iter()
        .map(|opt| format!("`{}` ({})", opt.id, opt.label))
        .collect::<Vec<_>>()
        .join(", ");
    let details_text = request
        .details
        .as_ref()
        .map(|val| match val {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .unwrap_or_else(|| "(none)".to_string());
    let body = format!(
        "[Delegated child awaiting input]\n\
         - run_id: `{}`\n\
         - conversation_id: `{}` ({})\n\
         - request_id: `{}`\n\
         - title: {}\n\
         - details: {}\n\
         - options: {}\n\n\
         Call `pending_request` with `action: \"read\"` or `action: \"respond\"` (or `decision: \"escalate\"` to ask the user).",
        record.run_id,
        record.child_conversation_id,
        conversation_link(
            record.child_conversation_id,
            record.target_environment_id.as_deref()
        ),
        request.id,
        request.title,
        details_text,
        if options_text.is_empty() {
            "allow_once, reject_once, escalate".to_string()
        } else {
            options_text
        }
    );
    let control = ScopedConversationControl::new(context.clone());
    let _ = control
        .submit_text(
            record.parent_conversation_id,
            &record.parent_conversation_id.to_string(),
            &Uuid::new_v4().to_string(),
            &body,
        )
        .await;
}

pub(crate) async fn maybe_schedule_parent_wakeup(
    context: ConversationContext,
    coalescing_parents: Arc<Mutex<HashSet<Uuid>>>,
    finished: &ConversationDelegationRecord,
) {
    let pool = &context.deployment.db().pool;
    let should_wake = if finished.mode == "async" {
        true
    } else {
        // Even if a `wait` child finished, check whether a `settled_only` async
        // sibling is waiting to be delivered now that active count decreased.
        ConversationDelegationRecord::list_undelivered_for_parent(
            pool,
            finished.parent_conversation_id,
        )
        .await
        .map(|rows| !rows.is_empty())
        .unwrap_or(false)
    };
    if !should_wake {
        return;
    }
    let settled_only = finished.mode == "async" && finished.completion_wake == "settled_only";
    schedule_parent_wakeup(
        context,
        coalescing_parents,
        finished.parent_conversation_id,
        settled_only,
    )
    .await;
}

async fn schedule_parent_wakeup(
    context: ConversationContext,
    coalescing_parents: Arc<Mutex<HashSet<Uuid>>>,
    parent_id: Uuid,
    settled_only: bool,
) {
    let pool = &context.deployment.db().pool;
    if settled_only {
        let active = ConversationDelegationRecord::count_active_for_parent(pool, parent_id)
            .await
            .unwrap_or(0);
        if active > 0 {
            return;
        }
    }
    {
        let mut guard = coalescing_parents.lock().await;
        if !guard.insert(parent_id) {
            return;
        }
    }
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(DEFAULT_COALESCE_WINDOW_MS)).await;
        coalescing_parents.lock().await.remove(&parent_id);
        deliver_coalesced_completions(&context, parent_id).await;
    });
}

/// Public helper (also used in tests and startup reconciler) to coalesce all
/// undelivered async completions for `parent_id` into one durable wakeup message.
pub async fn deliver_coalesced_completions(context: &ConversationContext, parent_id: Uuid) {
    let pool = &context.deployment.db().pool;
    let rows =
        match ConversationDelegationRecord::list_undelivered_for_parent(pool, parent_id).await {
            Ok(rows) if !rows.is_empty() => rows,
            _ => return,
        };

    // When a remote Host finishes a delegation whose originating parent lives on
    // another machine (`Uuid::nil()` or missing local `sessions` row), the remote
    // caller's watcher owns wakeup delivery — mark rows delivered cleanly here.
    if !has_local_parent_session(pool, parent_id).await {
        let run_ids: Vec<String> = rows.into_iter().map(|r| r.run_id).collect();
        let _ = ConversationDelegationRecord::mark_delivered(pool, &run_ids).await;
        return;
    }

    // If every undelivered row requested `settled_only`, wait until active count reaches 0.
    let all_settled_only = rows.iter().all(|row| row.completion_wake == "settled_only");
    if all_settled_only {
        let active = ConversationDelegationRecord::count_active_for_parent(pool, parent_id)
            .await
            .unwrap_or(0);
        if active > 0 {
            return;
        }
    }

    let body = format_coalesced_completion_message(&rows);
    let control = ScopedConversationControl::new(context.clone());
    match control
        .submit_text(
            parent_id,
            &parent_id.to_string(),
            &Uuid::new_v4().to_string(),
            &body,
        )
        .await
    {
        Ok(_) => {
            let run_ids: Vec<String> = rows.into_iter().map(|r| r.run_id).collect();
            let _ = ConversationDelegationRecord::mark_delivered(pool, &run_ids).await;
        }
        Err(error) => {
            tracing::warn!(
                %parent_id,
                %error,
                "failed to deliver coalesced delegation completion wakeup to parent"
            );
        }
    }
}

pub(crate) struct RemoteDelegationWatchSpec {
    pub context: ConversationContext,
    pub runtime: Arc<AgentRuntime>,
    pub preparations: ActivePreparations,
    pub forwarder: SharedRemoteForwarder,
    pub coalescing_parents: Arc<Mutex<HashSet<Uuid>>>,
    pub environment_id: String,
    pub run_id: String,
    pub child_conversation_id: Uuid,
    pub mode_limit: OrchestrationModeLimit,
    pub deadline_at: Option<chrono::DateTime<Utc>>,
    pub max_result_bytes: usize,
    pub cancel_token: CancellationToken,
    pub initial_poll_interval: Duration,
}

/// Apply a remote `task_status` JSON response onto the local shadow delegation
/// row, returning `Some(finished_record)` if the shadow row transitioned to a
/// terminal state on this update.
pub(crate) async fn sync_remote_status_into_shadow(
    pool: &sqlx::SqlitePool,
    run_id: &str,
    remote_payload: &Value,
    max_result_bytes: usize,
) -> Option<ConversationDelegationRecord> {
    let status = remote_payload
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("running");
    let max_bytes = if max_result_bytes == 0 {
        DEFAULT_MAX_RESULT_BYTES
    } else {
        max_result_bytes
    };

    if matches!(status, "completed" | "failed" | "cancelled" | "timed_out") {
        let raw_summary = remote_payload.get("result_summary").and_then(Value::as_str);
        let truncated_summary = raw_summary.map(|s| truncate_utf8_bytes(s, max_bytes).0);
        let error_code = remote_payload.get("error_code").and_then(Value::as_str);
        let error_message = remote_payload.get("error_message").and_then(Value::as_str);

        if remote_payload
            .get("worktree_path")
            .and_then(Value::as_str)
            .is_some()
            || remote_payload
                .get("branch")
                .and_then(Value::as_str)
                .is_some()
        {
            let _ = ConversationDelegationRecord::update_preparation(
                pool,
                run_id,
                status,
                remote_payload
                    .get("preparation_stage")
                    .and_then(Value::as_str),
                remote_payload
                    .get("workspace_id")
                    .and_then(Value::as_str)
                    .and_then(|s| Uuid::parse_str(s).ok()),
                remote_payload.get("worktree_path").and_then(Value::as_str),
                remote_payload.get("branch").and_then(Value::as_str),
            )
            .await;
        }

        return ConversationDelegationRecord::finish(
            pool,
            run_id,
            status,
            truncated_summary.as_deref(),
            error_code,
            error_message,
        )
        .await
        .ok()
        .flatten();
    }

    let _ = ConversationDelegationRecord::update_preparation(
        pool,
        run_id,
        status,
        remote_payload
            .get("preparation_stage")
            .and_then(Value::as_str),
        remote_payload
            .get("workspace_id")
            .and_then(Value::as_str)
            .and_then(|s| Uuid::parse_str(s).ok()),
        remote_payload.get("worktree_path").and_then(Value::as_str),
        remote_payload.get("branch").and_then(Value::as_str),
    )
    .await;
    None
}

/// Spawn a background watcher that bridges a remote Host's delegated task back
/// to the local parent conversation: syncs status into the local shadow row,
/// notifies on `waiting_for_input`, enforces `deadline_at`, emits
/// `AgentEvent::DelegationCompleted`, and schedules coalesced parent wakeup.
pub(crate) fn spawn_remote_delegation_watcher(spec: RemoteDelegationWatchSpec) -> JoinHandle<()> {
    tokio::spawn(async move {
        let pool = &spec.context.deployment.db().pool;
        let base_ms = spec.initial_poll_interval.as_millis().max(25) as u64;
        let max_ms = (base_ms.saturating_mul(3)).clamp(base_ms, 5_000);
        let mut poll_ms = base_ms;
        let mut consecutive_errors = 0u32;
        let mut notified_waiting = false;

        loop {
            tokio::select! {
                _ = spec.cancel_token.cancelled() => {
                    break;
                }
                _ = tokio::time::sleep(Duration::from_millis(poll_ms)) => {}
            }
            if spec.cancel_token.is_cancelled() {
                break;
            }

            let existing =
                match ConversationDelegationRecord::find_by_run_id(pool, &spec.run_id).await {
                    Ok(Some(rec)) => rec,
                    _ => break,
                };
            if existing.is_terminal() {
                break;
            }

            if let Some(deadline) = spec.deadline_at
                && Utc::now() >= deadline
            {
                let _ = spec
                    .forwarder
                    .forward_tool_call(
                        &spec.environment_id,
                        "task_cancel",
                        json!({
                            "run_id": spec.run_id,
                            "reason": "delegated task deadline exceeded",
                        }),
                        spec.mode_limit,
                    )
                    .await;
                if let Ok(Some(finished)) = ConversationDelegationRecord::finish(
                    pool,
                    &spec.run_id,
                    "timed_out",
                    None,
                    Some("timed_out"),
                    Some("Remote delegated task exceeded deadline_at"),
                )
                .await
                {
                    emit_parent_completion_event(&spec.runtime, &finished).await;
                    maybe_schedule_parent_wakeup(
                        spec.context.clone(),
                        spec.coalescing_parents.clone(),
                        &finished,
                    )
                    .await;
                }
                break;
            }

            match spec
                .forwarder
                .forward_tool_call(
                    &spec.environment_id,
                    "task_status",
                    json!({ "run_id": spec.run_id }),
                    spec.mode_limit,
                )
                .await
            {
                Ok(remote_payload) => {
                    consecutive_errors = 0;
                    let remote_status = remote_payload
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("running");
                    if remote_status == "waiting_for_input" && !notified_waiting {
                        notified_waiting = true;
                        let _ = ConversationDelegationRecord::mark_waiting_for_input(
                            pool,
                            spec.child_conversation_id,
                        )
                        .await;
                        notify_parent_of_remote_pending_requests(
                            &spec.context,
                            &existing,
                            &spec.environment_id,
                            &remote_payload,
                        )
                        .await;
                    } else if remote_status != "waiting_for_input" {
                        notified_waiting = false;
                    }

                    if let Some(finished) = sync_remote_status_into_shadow(
                        pool,
                        &spec.run_id,
                        &remote_payload,
                        spec.max_result_bytes,
                    )
                    .await
                    {
                        emit_parent_completion_event(&spec.runtime, &finished).await;
                        maybe_schedule_parent_wakeup(
                            spec.context.clone(),
                            spec.coalescing_parents.clone(),
                            &finished,
                        )
                        .await;
                        break;
                    }
                    poll_ms = (poll_ms + base_ms / 2).min(max_ms);
                }
                Err(error) => {
                    consecutive_errors += 1;
                    if consecutive_errors >= 6 {
                        let msg = format!(
                            "Lost connection to remote environment '{}': {error}",
                            spec.environment_id
                        );
                        if let Ok(Some(finished)) = ConversationDelegationRecord::finish(
                            pool,
                            &spec.run_id,
                            "failed",
                            None,
                            Some("remote_unreachable"),
                            Some(&msg),
                        )
                        .await
                        {
                            emit_parent_completion_event(&spec.runtime, &finished).await;
                            maybe_schedule_parent_wakeup(
                                spec.context.clone(),
                                spec.coalescing_parents.clone(),
                                &finished,
                            )
                            .await;
                        }
                        break;
                    }
                    poll_ms = max_ms;
                }
            }
        }

        spec.preparations.finish(spec.child_conversation_id).await;
    })
}

async fn notify_parent_of_remote_pending_requests(
    context: &ConversationContext,
    record: &ConversationDelegationRecord,
    environment_id: &str,
    remote_payload: &Value,
) {
    let pool = &context.deployment.db().pool;
    if !has_local_parent_session(pool, record.parent_conversation_id).await {
        return;
    }
    let summary = remote_payload
        .get("pending_requests")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .map(|req| {
            let id = req
                .get("permission_id")
                .and_then(Value::as_str)
                .unwrap_or("");
            let title = req
                .get("tool_name")
                .and_then(Value::as_str)
                .unwrap_or("permission request");
            let detail = req
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("(none)");
            format!("- request_id: `{id}`\n- title: {title}\n- details: {detail}")
        })
        .unwrap_or_else(|| "- details: awaiting input on remote host".to_string());
    let body = format!(
        "[Remote delegated child awaiting input]\n\
         - run_id: `{}`\n\
         - environment_id: `{environment_id}`\n\
         - conversation_id: `{}` ({})\n\
         {summary}\n\n\
         Call `pending_request` with `environment_id: \"{environment_id}\"`, `conversation_id: \"{}\"` and `action: \"read\"` or `action: \"respond\"`.",
        record.run_id,
        record.child_conversation_id,
        conversation_link(record.child_conversation_id, Some(environment_id)),
        record.child_conversation_id,
    );
    let control = ScopedConversationControl::new(context.clone());
    let _ = control
        .submit_text(
            record.parent_conversation_id,
            &record.parent_conversation_id.to_string(),
            &Uuid::new_v4().to_string(),
            &body,
        )
        .await;
}

pub fn format_coalesced_completion_message(rows: &[ConversationDelegationRecord]) -> String {
    let mut out = String::new();
    if rows.len() == 1 {
        out.push_str("[Delegated task finished]\n");
    } else {
        out.push_str(&format!("[{} delegated tasks finished]\n", rows.len()));
    }
    for row in rows {
        let link = conversation_link(
            row.child_conversation_id,
            row.target_environment_id.as_deref(),
        );
        out.push_str(&format!(
            "\n### `{}` ({}{} · {})\n",
            row.run_id,
            row.agent_id,
            row.role
                .as_deref()
                .map(|r| format!(" · {r}"))
                .unwrap_or_default(),
            row.status,
        ));
        out.push_str(&format!("- thread: {}\n", link));
        if let Some(branch) = row.branch.as_deref() {
            out.push_str(&format!("- branch: `{branch}`\n"));
        }
        if let Some(wt) = row.worktree_path.as_deref() {
            out.push_str(&format!("- worktree: `{wt}`\n"));
        }
        if let Some(err) = row.error_message.as_deref() {
            out.push_str(&format!("- error: {err}\n"));
        }
        if let Some(summary) = row
            .result_summary
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            out.push('\n');
            out.push_str(summary);
            out.push('\n');
        }
    }
    out
}
