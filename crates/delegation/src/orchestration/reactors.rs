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
use db::models::conversation_delegation::ConversationDelegationRecord;
use serde_json::json;
use tokio::{
    sync::{Mutex, broadcast::error::RecvError},
    task::JoinHandle,
};
use uuid::Uuid;

use super::{
    ActivePreparations, DEFAULT_COALESCE_WINDOW_MS, DEFAULT_MAX_RESULT_BYTES,
    PendingPermissionEntry, conversation_link, truncate_utf8_bytes,
};
use crate::{
    assistant_reply::AssistantReplyAccumulator,
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
    let watchdog_task = spawn_deadline_watchdog(
        context.clone(),
        runtime,
        preparations,
        coalescing_parents,
    );

    DelegationReactors {
        tasks: vec![event_task, watchdog_task],
    }
}

/// Reconcile interrupted delegations on `dimo-server` boot:
/// 1. Mark stale `preparing`/`running`/`waiting_for_input` rows failed & clean orphan worktrees.
/// 2. Redeliver any finished `async` delegations whose `delivered_at IS NULL`.
pub async fn run_startup_reconciler(context: ConversationContext) {
    let pool = &context.deployment.db().pool;
    let unfinished = match ConversationDelegationRecord::list_all_unfinished(pool).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(%error, "startup reconciler failed to list unfinished delegations");
            return;
        }
    };

    for row in unfinished {
        if row.status == "preparing"
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
            let expired = match ConversationDelegationRecord::list_expired_active(pool, Utc::now())
                .await
            {
                Ok(rows) => rows,
                Err(_) => continue,
            };
            for row in expired {
                preparations.cancel(row.child_conversation_id).await;
                let service = ConversationSessionService::new(context.clone());
                let _ = service
                    .cancel_turn(
                        row.child_conversation_id,
                        Some("delegated task deadline exceeded".to_string()),
                    )
                    .await;
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

async fn notify_parent_of_pending_permission(
    context: &ConversationContext,
    record: &ConversationDelegationRecord,
    request: &AgentPermissionRequest,
) {
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

async fn maybe_schedule_parent_wakeup(
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
    let rows = match ConversationDelegationRecord::list_undelivered_for_parent(pool, parent_id).await
    {
        Ok(rows) if !rows.is_empty() => rows,
        _ => return,
    };

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
