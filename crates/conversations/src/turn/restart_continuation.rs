use std::collections::HashMap;

use agents::{
    AgentId, ConversationInputPayload,
    conversation::{ContinuationPolicy, ConversationInputBlock, ConversationTimelineRow},
};
use chrono::{DateTime, Duration, Utc};
use db::models::{
    conversation::{ConversationAgentBindingRecord, ConversationRecord},
    conversation_input::ConversationInputRecord,
    conversation_side_effects::ConversationPermissionRecord,
    conversation_turn::ConversationTurnRecord,
    session::{Session, SessionStatus},
    workspace::Workspace,
};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{ConversationSessionService, recover::known_acp_session_id};
use crate::{
    ConversationInputControl, ConversationProjector, ConversationServiceError,
    SubmitConversationInput,
};

pub const RESTART_CONTINUATION_ORIGIN: &str = "restart_continuation";

/// Maximum consecutive restart-triggered continuations within the loop window
/// before we stop auto-continuing a conversation to break crash loops.
pub const MAX_CONTINUATION_CHAIN: usize = 3;

/// Lookback window for consecutive restart-continuation crash-loop protection.
pub const CONTINUATION_LOOP_WINDOW_SECS: i64 = 5 * 60;

/// Prompt injected when continuing a turn that was already accepted by an agent
/// provider before an app restart/crash. Mirrors T3Code's safety wording so the
/// agent checks state-changing commands before repeating them.
pub const RESTART_CONTINUATION_PROMPT: &str = "Continue where you left off. Your last turn was cut short by an app restart, so a command or other action it started may have finished or may still be running. Before you repeat one that changes state, confirm it did not take effect and is not still running; if you cannot tell, say so instead of repeating it.";

const RESTART_COLD_RETRY_NOTE: &str = "\n\n[System note: A previous attempt at this turn was cut short by an app restart before completing. Before repeating any command or action that changes state, confirm it did not already take effect and is not still running; if you cannot tell, say so instead of repeating it.]";

#[derive(Debug, Clone)]
pub(crate) struct SettledInterruptedTurn {
    pub turn: ConversationTurnRecord,
    pub had_pending_user_interaction: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ContinuationSkipReason {
    PendingUserInteraction,
    AutomationOwned,
    WorkflowOwned,
    ConversationUnavailable,
    ConversationClosed,
    WorkspaceMissing,
    SupersededByNewerTurn,
    MaintenanceCommand,
    CrashLoopLimitReached,
    AgentUnavailable,
    EmptyPrompt,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ContinuationPlan {
    Continue(Box<ConversationInputPayload>),
    Skip(ContinuationSkipReason),
}

impl ConversationSessionService {
    /// Inspect pending permissions, unanswered questions, and blocked status
    /// **before** `interrupt_in_flight_turn` voids pending interactions.
    pub(super) async fn turn_had_pending_user_interaction(
        &self,
        turn: &ConversationTurnRecord,
    ) -> Result<bool, ConversationServiceError> {
        if turn.status == "blocked" {
            return Ok(true);
        }
        let pool = &self.ctx.deployment.db().pool;
        let permissions = ConversationPermissionRecord::list_for_turn(pool, turn.id).await?;
        if permissions.iter().any(|p| p.status == "pending") {
            return Ok(true);
        }
        let side_rows =
            ConversationProjector::persisted_side_rows(pool, turn.conversation_id).await?;
        let has_unanswered_question = side_rows.iter().any(|entry| {
            matches!(
                &entry.row,
                ConversationTimelineRow::QuestionRequest { response: None, .. }
            )
        });
        Ok(has_unanswered_question)
    }

    /// Evaluate all turns interrupted during startup recovery and idempotently
    /// enqueue restart continuations at the front of each eligible conversation's
    /// durable input queue. Actual execution happens when `dispatch_queued_inputs`
    /// runs immediately afterward.
    pub(super) async fn enqueue_restart_continuations(
        &self,
        settled_turns: &[SettledInterruptedTurn],
    ) -> Result<usize, ConversationServiceError> {
        if settled_turns.is_empty() {
            return Ok(0);
        }
        let enabled = self
            .ctx
            .deployment
            .config()
            .read()
            .await
            .continue_conversations_after_restart;
        if !enabled {
            tracing::info!(
                count = settled_turns.len(),
                "startup recovery: automatic restart continuation is disabled in settings"
            );
            return Ok(0);
        }

        // Evaluate at most one (the latest) settled interrupted turn per conversation.
        let mut latest_by_conversation: HashMap<Uuid, &SettledInterruptedTurn> = HashMap::new();
        for item in settled_turns {
            latest_by_conversation
                .entry(item.turn.conversation_id)
                .and_modify(|existing| {
                    if item.turn.ordinal > existing.turn.ordinal {
                        *existing = item;
                    }
                })
                .or_insert(item);
        }

        let pool = &self.ctx.deployment.db().pool;
        let inputs = ConversationInputControl::with_publisher(
            pool.clone(),
            self.ctx.event_publisher.clone(),
        );
        let now = Utc::now();
        let mut enqueued = 0usize;

        for (conversation_id, settled) in latest_by_conversation {
            match plan_restart_continuation(pool, settled, now).await {
                Ok(ContinuationPlan::Continue(payload)) => {
                    let operation_id =
                        restart_continuation_operation_id(conversation_id, settled.turn.id);
                    match inputs
                        .submit_at_front(SubmitConversationInput {
                            conversation_id,
                            operation_id,
                            payload: *payload,
                            principal: serde_json::json!({
                                "kind": "origin",
                                "origin": RESTART_CONTINUATION_ORIGIN,
                            }),
                        })
                        .await
                    {
                        Ok(_) => {
                            enqueued += 1;
                            tracing::info!(
                                %conversation_id,
                                interrupted_turn_id = %settled.turn.id,
                                "startup recovery: queued automatic continuation for interrupted conversation"
                            );
                        }
                        Err(error) => {
                            tracing::warn!(
                                %conversation_id,
                                interrupted_turn_id = %settled.turn.id,
                                %error,
                                "startup recovery: failed to enqueue automatic continuation"
                            );
                        }
                    }
                }
                Ok(ContinuationPlan::Skip(reason)) => {
                    tracing::debug!(
                        %conversation_id,
                        interrupted_turn_id = %settled.turn.id,
                        ?reason,
                        "startup recovery: skipped automatic continuation"
                    );
                }
                Err(error) => {
                    tracing::warn!(
                        %conversation_id,
                        interrupted_turn_id = %settled.turn.id,
                        %error,
                        "startup recovery: failed to evaluate automatic continuation"
                    );
                }
            }
        }

        Ok(enqueued)
    }
}

pub(crate) fn restart_continuation_operation_id(conversation_id: Uuid, turn_id: Uuid) -> Uuid {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("restart-continuation:{conversation_id}:{turn_id}").as_bytes(),
    )
}

pub(crate) fn is_native_maintenance_command(text: &str) -> bool {
    let trimmed = text.trim_start();
    let Some(rest) = trimmed.strip_prefix('/') else {
        return false;
    };
    let command = rest
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(command.as_str(), "compact" | "clear" | "logout")
}

pub(crate) fn exceeds_continuation_loop_limit(
    turns: &[ConversationTurnRecord],
    now: DateTime<Utc>,
) -> bool {
    let window = Duration::seconds(CONTINUATION_LOOP_WINDOW_SECS);
    let mut chain = 0usize;
    for turn in turns.iter().rev() {
        if turn.origin != RESTART_CONTINUATION_ORIGIN {
            break;
        }
        if now.signed_duration_since(turn.created_at) > window {
            break;
        }
        chain += 1;
        if chain >= MAX_CONTINUATION_CHAIN {
            return true;
        }
    }
    false
}

pub(crate) async fn plan_restart_continuation(
    pool: &SqlitePool,
    settled: &SettledInterruptedTurn,
    now: DateTime<Utc>,
) -> Result<ContinuationPlan, ConversationServiceError> {
    let turn = &settled.turn;
    let conversation_id = turn.conversation_id;

    if settled.had_pending_user_interaction {
        return Ok(ContinuationPlan::Skip(
            ContinuationSkipReason::PendingUserInteraction,
        ));
    }

    if turn.origin == crate::commit_reminder::AUTOMATION_ORIGIN {
        return Ok(ContinuationPlan::Skip(
            ContinuationSkipReason::AutomationOwned,
        ));
    }

    let Some(conversation) = ConversationRecord::find_by_id(pool, conversation_id).await? else {
        return Ok(ContinuationPlan::Skip(
            ContinuationSkipReason::ConversationUnavailable,
        ));
    };
    if matches!(
        conversation.status,
        SessionStatus::Done | SessionStatus::Archived
    ) {
        return Ok(ContinuationPlan::Skip(
            ContinuationSkipReason::ConversationClosed,
        ));
    }

    let Some(session) = Session::find_by_id(pool, conversation_id).await? else {
        return Ok(ContinuationPlan::Skip(
            ContinuationSkipReason::ConversationUnavailable,
        ));
    };
    if session.executor.as_deref() == Some("workflow")
        || is_workflow_step_conversation(pool, conversation_id).await?
    {
        return Ok(ContinuationPlan::Skip(
            ContinuationSkipReason::WorkflowOwned,
        ));
    }

    if Workspace::find_by_id(pool, conversation.workspace_id)
        .await?
        .is_none()
    {
        return Ok(ContinuationPlan::Skip(
            ContinuationSkipReason::WorkspaceMissing,
        ));
    }

    let turns = ConversationTurnRecord::list_for_conversation(pool, conversation_id).await?;
    if turns.last().is_none_or(|latest| latest.id != turn.id) {
        return Ok(ContinuationPlan::Skip(
            ContinuationSkipReason::SupersededByNewerTurn,
        ));
    }

    if exceeds_continuation_loop_limit(&turns, now) {
        return Ok(ContinuationPlan::Skip(
            ContinuationSkipReason::CrashLoopLimitReached,
        ));
    }

    let original_payload = ConversationInputRecord::find_by_turn_id(pool, conversation_id, turn.id)
        .await?
        .and_then(|record| {
            serde_json::from_str::<ConversationInputPayload>(&record.payload_json).ok()
        });

    let original_text = extract_original_prompt_text(turn, original_payload.as_ref());
    if original_text
        .as_deref()
        .is_some_and(is_native_maintenance_command)
    {
        return Ok(ContinuationPlan::Skip(
            ContinuationSkipReason::MaintenanceCommand,
        ));
    }

    let latest_binding =
        ConversationAgentBindingRecord::latest_for_conversation(pool, conversation_id).await?;
    let Some(agent_id) = original_payload
        .as_ref()
        .map(|payload| payload.agent_id.clone())
        .or_else(|| {
            latest_binding
                .as_ref()
                .map(|binding| binding.agent_id.clone())
        })
        .or_else(|| session.agent_id.clone())
    else {
        return Ok(ContinuationPlan::Skip(
            ContinuationSkipReason::AgentUnavailable,
        ));
    };

    let was_accepted_by_provider = turn.prompt_id.is_some() || turn.started_at.is_some();
    let has_restorable_native_session =
        known_acp_session_id(latest_binding.as_ref(), Some(&session), &agent_id).is_some();
    let has_prior_completed_turn = turns
        .iter()
        .any(|existing| existing.id != turn.id && existing.status == "completed");

    let payload = if !was_accepted_by_provider {
        // Case A: Host died before the provider ever accepted this turn.
        // Re-submit the original input payload rather than a generic "Continue"
        // (avoids T3Code #26384 empty continuation before first response).
        build_original_retry_payload(
            conversation.workspace_id,
            &agent_id,
            &session,
            original_payload,
            original_text,
            false,
        )
    } else if has_restorable_native_session {
        // Case B: Provider saw the turn and we have a restorable native session
        // ID. `ensure_session_controls` will resume the session automatically.
        Some(build_continue_payload(
            conversation.workspace_id,
            &agent_id,
            &session,
            original_payload.as_ref(),
            None,
        ))
    } else if has_prior_completed_turn && !is_delegation_conversation(pool, conversation_id).await?
    {
        // Case C1: Multi-turn conversation without a restorable native session.
        // Use Dimo's deterministic SQLite portable handoff to rebuild context.
        Some(build_continue_payload(
            conversation.workspace_id,
            &agent_id,
            &session,
            original_payload.as_ref(),
            Some(ContinuationPolicy::Portable),
        ))
    } else if original_payload.is_some()
        || original_text
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty())
    {
        // Case C2: Turn 1 (or delegation child) started without a persisted
        // native session ID. Replay the original prompt with a restart safety
        // note so the fresh session has full context.
        build_original_retry_payload(
            conversation.workspace_id,
            &agent_id,
            &session,
            original_payload,
            original_text,
            true,
        )
    } else {
        Some(build_continue_payload(
            conversation.workspace_id,
            &agent_id,
            &session,
            original_payload.as_ref(),
            None,
        ))
    };

    match payload {
        Some(payload) => Ok(ContinuationPlan::Continue(Box::new(payload))),
        None => Ok(ContinuationPlan::Skip(ContinuationSkipReason::EmptyPrompt)),
    }
}

fn build_continue_payload(
    workspace_id: Uuid,
    agent_id: &AgentId,
    session: &Session,
    original: Option<&ConversationInputPayload>,
    continuation_policy: Option<ContinuationPolicy>,
) -> ConversationInputPayload {
    ConversationInputPayload {
        continuation_policy,
        expected_binding_revision: None,
        agent_id: agent_id.clone(),
        workspace_id: original.map_or(workspace_id, |payload| payload.workspace_id),
        executor_profile_id: original.and_then(|payload| payload.executor_profile_id.clone()),
        text: RESTART_CONTINUATION_PROMPT.to_string(),
        display_text: None,
        images: Vec::new(),
        mode_override: original.and_then(|payload| payload.mode_override.clone()),
        config_overrides: original
            .map(|payload| payload.config_overrides.clone())
            .unwrap_or_default(),
        workflow_refs: Vec::new(),
        file_refs: Vec::new(),
        internal_prompt_contributions: Vec::new(),
        collaboration_origin: None,
        provider_instance_id: original
            .and_then(|payload| payload.provider_instance_id.clone())
            .or_else(|| session.provider_instance_id.clone()),
    }
}

fn build_original_retry_payload(
    workspace_id: Uuid,
    agent_id: &AgentId,
    session: &Session,
    original: Option<ConversationInputPayload>,
    fallback_text: Option<String>,
    append_cold_retry_note: bool,
) -> Option<ConversationInputPayload> {
    if let Some(mut payload) = original {
        payload.expected_binding_revision = None;
        payload.agent_id = agent_id.clone();
        if payload.provider_instance_id.is_none() {
            payload.provider_instance_id = session.provider_instance_id.clone();
        }
        if append_cold_retry_note && !payload.text.contains(RESTART_COLD_RETRY_NOTE.trim()) {
            if payload.display_text.is_none() && !payload.text.trim().is_empty() {
                payload.display_text = Some(payload.text.clone());
            }
            payload.text.push_str(RESTART_COLD_RETRY_NOTE);
        }
        return Some(payload);
    }

    let text = fallback_text
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())?;
    let (final_text, display_text) = if append_cold_retry_note {
        (format!("{text}{RESTART_COLD_RETRY_NOTE}"), Some(text))
    } else {
        (text, None)
    };
    Some(ConversationInputPayload {
        continuation_policy: None,
        expected_binding_revision: None,
        agent_id: agent_id.clone(),
        workspace_id,
        executor_profile_id: None,
        text: final_text,
        display_text,
        images: Vec::new(),
        mode_override: None,
        config_overrides: Vec::new(),
        workflow_refs: Vec::new(),
        file_refs: Vec::new(),
        internal_prompt_contributions: Vec::new(),
        collaboration_origin: None,
        provider_instance_id: session.provider_instance_id.clone(),
    })
}

fn extract_original_prompt_text(
    turn: &ConversationTurnRecord,
    original_payload: Option<&ConversationInputPayload>,
) -> Option<String> {
    if let Some(payload) = original_payload
        && !payload.text.trim().is_empty()
    {
        return Some(payload.text.clone());
    }
    if let Ok(blocks) = serde_json::from_str::<Vec<ConversationInputBlock>>(&turn.input_blocks_json)
    {
        let joined = blocks
            .into_iter()
            .filter_map(|block| match block {
                ConversationInputBlock::Text { text } if !text.trim().is_empty() => Some(text),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        if !joined.trim().is_empty() {
            return Some(joined);
        }
    }
    turn.text_preview
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

async fn is_workflow_step_conversation(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<bool, ConversationServiceError> {
    let is_workflow: bool = sqlx::query_scalar(
        r#"SELECT EXISTS(
               SELECT 1 FROM conversation_relations
               WHERE child_conversation_id = ? AND kind = 'workflow_step'
           )"#,
    )
    .bind(conversation_id)
    .fetch_one(pool)
    .await?;
    Ok(is_workflow)
}

async fn is_delegation_conversation(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<bool, ConversationServiceError> {
    let is_delegation: bool = sqlx::query_scalar(
        r#"SELECT EXISTS(
               SELECT 1 FROM conversation_relations
               WHERE child_conversation_id = ? AND kind = 'delegation'
           )"#,
    )
    .bind(conversation_id)
    .fetch_one(pool)
    .await?;
    Ok(is_delegation)
}
