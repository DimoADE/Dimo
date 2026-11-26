use std::collections::HashSet;

use agents::{
    AgentContentBlock, AgentSessionId, EnsureAgentSessionInput, ResumeAgentSessionInput,
    conversation::ContinuationPolicy,
};
use db::models::{conversation::ConversationAgentBindingRecord, session::Session};
use uuid::Uuid;

use super::{ConversationSessionService, ConversationStartTurnInput, PreparedTurnPrompt};
use crate::{
    ConversationServiceError,
    handoff::{DeterministicHandoffService, HandoffError},
};

fn map_handoff_error_to_service(error: HandoffError) -> ConversationServiceError {
    match error {
        HandoffError::ConversationNotFound(id) => {
            ConversationServiceError::NotFound(format!("Conversation {id} not found"))
        }
        HandoffError::InvalidTokenBudget
        | HandoffError::InvalidTargetEngine(_)
        | HandoffError::InvalidTargetInstance(_) => {
            ConversationServiceError::BadRequest(error.to_string())
        }
        HandoffError::RestrictedOwner => ConversationServiceError::SessionUnavailable {
            code: "continuation_not_allowed",
            message: error.to_string(),
        },
        HandoffError::ActiveTurnInProgress | HandoffError::WorkspaceRootMissing(_) => {
            ConversationServiceError::Conflict(error.to_string())
        }
        HandoffError::Database(err) => ConversationServiceError::Internal(err.to_string()),
    }
}

/// Continuation key: agent + optional provider instance + working directory fingerprint for resume matching.
pub fn continuation_key(
    agent_id: &str,
    working_dir: &str,
    provider_instance_id: Option<&str>,
) -> String {
    match db::models::session::normalize_provider_instance_id(provider_instance_id) {
        Some(instance_id) => format!("{agent_id}|{instance_id}|{working_dir}"),
        None => format!("{agent_id}|{working_dir}"),
    }
}

pub fn continuation_key_instance_id(key: &str) -> Option<&str> {
    let (_agent, rest) = key.split_once('|')?;
    let (instance, _dir) = rest.split_once('|')?;
    let trimmed = instance.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("local") {
        None
    } else {
        Some(trimmed)
    }
}

fn normalize_working_dir_for_compare(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let normalized =
        utils::path::normalize_windows_extended_path_prefix(std::path::Path::new(trimmed));
    let mut text = normalized.to_string_lossy().replace('\\', "/");
    while text.len() > 1 && text.ends_with('/') {
        if text.len() == 3 && text.as_bytes()[1] == b':' {
            break;
        }
        text.pop();
    }
    #[cfg(windows)]
    {
        text.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        text
    }
}

pub(crate) fn working_dirs_equal(left: &str, right: &str) -> bool {
    normalize_working_dir_for_compare(left) == normalize_working_dir_for_compare(right)
}

pub(crate) fn binding_matches_target_instance(
    binding: &ConversationAgentBindingRecord,
    agent_id: &agents::AgentId,
    effective_instance: Option<&str>,
) -> bool {
    if binding.agent_id != *agent_id {
        return false;
    }
    match binding.continuation_key.as_deref() {
        Some(existing_key) if !binding.working_dir.is_empty() => {
            existing_key
                == continuation_key(agent_id.as_str(), &binding.working_dir, effective_instance)
        }
        Some(existing_key) => continuation_key_instance_id(existing_key) == effective_instance,
        None => !(effective_instance.is_some() && binding.acp_session_id.is_some()),
    }
}

impl ConversationSessionService {
    pub(super) async fn prepare_turn_continuation(
        &self,
        input: &ConversationStartTurnInput,
        turn_id: Uuid,
        prepared: &mut PreparedTurnPrompt,
    ) -> Result<(), ConversationServiceError> {
        let pool = &self.ctx.deployment.db().pool;
        let session = Session::find_by_id(pool, input.conversation_id)
            .await?
            .ok_or_else(|| ConversationServiceError::NotFound("Conversation not found".into()))?;
        let _ = crate::ensure_legacy_jsonl_migrated_on_pool(pool, input.conversation_id).await?;
        let source =
            ConversationAgentBindingRecord::active_for_conversation(pool, input.conversation_id)
                .await?;
        let explicit_input_instance = input
            .provider_instance_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let requested_or_session = explicit_input_instance.or_else(|| {
            session
                .provider_instance_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        });
        let effective_instance = crate::resolve_effective_provider_instance_id(
            pool,
            &input.agent_id,
            requested_or_session,
        )
        .await?;
        let launch_instance_id = effective_instance
            .as_deref()
            .unwrap_or(db::models::provider_instance::LOCAL_PROVIDER_INSTANCE_ID);
        let target_key = continuation_key(
            input.agent_id.as_str(),
            &prepared.working_dir,
            effective_instance.as_deref(),
        );
        let has_restorable_native_session =
            source.as_ref().is_some_and(|binding| {
                binding.resume_allowed
                    && binding.acp_session_id.as_deref().is_some_and(|id| {
                        !id.trim().is_empty() && !agents::is_placeholder_acp_session_id(id)
                    })
            }) || session.external_session_id.as_deref().is_some_and(|id| {
                !id.trim().is_empty() && !agents::is_placeholder_acp_session_id(id)
            }) && source.as_ref().is_none_or(|binding| binding.resume_allowed);
        let portable_without_native = if input.continuation_policy
            == Some(ContinuationPolicy::Portable)
            && !has_restorable_native_session
        {
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM conversation_turns WHERE conversation_id = ? AND id != ?)",
            )
            .bind(input.conversation_id)
            .bind(turn_id)
            .fetch_one(pool)
            .await?
        } else {
            false
        };
        let working_dir_switched = if let Some(binding) = source.as_ref() {
            !binding.working_dir.trim().is_empty()
                && !working_dirs_equal(&binding.working_dir, &prepared.working_dir)
        } else {
            false
        };
        let switching = portable_without_native
            || if let Some(binding) = source.as_ref() {
                let instance_switched = match binding.continuation_key.as_deref() {
                    Some(existing_key) => {
                        continuation_key_instance_id(existing_key) != effective_instance.as_deref()
                    }
                    None => effective_instance.is_some() && binding.acp_session_id.is_some(),
                };
                binding.agent_id != input.agent_id || working_dir_switched || instance_switched
            } else if let Some(latest) =
                ConversationAgentBindingRecord::latest_for_conversation(pool, input.conversation_id)
                    .await?
            {
                let latest_dir_switched = !latest.working_dir.trim().is_empty()
                    && !working_dirs_equal(&latest.working_dir, &prepared.working_dir);
                let latest_instance_switched = latest
                    .continuation_key
                    .as_deref()
                    .is_some_and(|existing_key| {
                        continuation_key_instance_id(existing_key) != effective_instance.as_deref()
                    });
                latest.agent_id != input.agent_id
                    || latest_dir_switched
                    || latest_instance_switched
            } else {
                session
                    .agent_id
                    .as_ref()
                    .is_some_and(|agent| *agent != input.agent_id)
            };
        let fresh = input.continuation_policy == Some(ContinuationPolicy::Fresh);

        if let Some(requested_id) = explicit_input_instance {
            let normalized_storage =
                db::models::session::normalize_provider_instance_storage_id(Some(requested_id));
            if session.provider_instance_id != normalized_storage {
                let _ = Session::update_provider_instance_id(
                    pool,
                    input.conversation_id,
                    normalized_storage.as_deref(),
                )
                .await;
            }
        }

        // Stage C: look for a resumable binding with matching continuation key.
        let resume_candidate = if switching && !fresh {
            ConversationAgentBindingRecord::resume_head_for_key(
                pool,
                input.conversation_id,
                &target_key,
            )
            .await?
            .filter(|b| {
                b.resume_allowed
                    && b.acp_session_id.as_deref().is_some_and(|id| {
                        !id.is_empty() && !agents::is_placeholder_acp_session_id(id)
                    })
            })
        } else {
            None
        };

        let cold = (switching && resume_candidate.is_none()) || fresh;

        if cold {
            self.validate_continuation_owner(input.conversation_id, input.agent_id.as_str())
                .await?;
            if let Ok(controls) = self
                .ctx
                .agent_runtime
                .session_controls_snapshot(AgentSessionId(input.conversation_id))
                .await
                && controls
                    .async_tasks
                    .iter()
                    .any(|task| !agents::async_tasks::async_task_state_is_terminal(&task.state))
            {
                return Err(ConversationServiceError::SessionUnavailable {
                    code: "continuation_not_allowed",
                    message: "Stop background Agent tasks before changing context".into(),
                });
            }
            self.release_agent_session_for_switch(input.conversation_id)
                .await?;
            if !self
                .turn_is_still_in_flight(input.conversation_id, turn_id)
                .await?
            {
                return Err(ConversationServiceError::Conflict(
                    "Turn was cancelled during history preparation".into(),
                ));
            }
            let use_portable_handoff =
                input.continuation_policy == Some(ContinuationPolicy::Portable)
                    || (working_dir_switched && !fresh);
            let selection = if use_portable_handoff {
                let _ = crate::ensure_legacy_jsonl_migrated_on_pool(pool, input.conversation_id)
                    .await?;
                let current_bytes = serde_json::to_vec(&prepared.agent_blocks)
                    .map_err(|e| ConversationServiceError::Internal(e.to_string()))?
                    .len();
                let byte_budget =
                    (64 * 1024usize).min((128 * 1024usize).saturating_sub(current_bytes));
                DeterministicHandoffService::build_execution_handoff(
                    pool,
                    input.conversation_id,
                    input.agent_id.as_str(),
                    turn_id,
                    &[],
                    &HashSet::new(),
                    byte_budget,
                )
                .await
                .map_err(map_handoff_error_to_service)?
            } else {
                None
            };
            crate::handoff::plan(
                pool,
                input,
                turn_id,
                source.as_ref().map(|b| b.id),
                selection.as_ref(),
            )
            .await?;

            let settings = self
                .ctx
                .host
                .launch_settings_with_provider_instance(
                    pool,
                    &input.agent_id,
                    Some(launch_instance_id),
                )
                .await?;
            let remembered_target_binding =
                ConversationAgentBindingRecord::list_for_conversation(pool, input.conversation_id)
                    .await
                    .ok()
                    .and_then(|bindings| {
                        bindings.into_iter().rev().find(|binding| {
                            binding_matches_target_instance(
                                binding,
                                &input.agent_id,
                                effective_instance.as_deref(),
                            )
                        })
                    });
            let mut preferences = self
                .resolved_session_control_preferences(
                    pool,
                    &input.agent_id,
                    remembered_target_binding.as_ref(),
                )
                .await;
            preferences.mode = input.mode_override.clone().or(preferences.mode);
            for value in &input.config_overrides {
                preferences.config.retain(|old| old.key != value.key);
                preferences.config.push(value.clone());
            }
            let candidate = self
                .ctx
                .agent_runtime
                .prepare_session(EnsureAgentSessionInput {
                    agent_id: input.agent_id.clone(),
                    launch_lock: settings.launch_lock,
                    workspace_id: session.workspace_id,
                    working_dir: prepared.working_dir.clone().into(),
                    additional_directories: prepared.additional_directories.clone(),
                    session_id: AgentSessionId(input.conversation_id),
                    acp_session_id: String::new(),
                    auto_approve_mode: settings.auto_approve_mode,
                    env: settings.env,
                    preferences,
                })
                .await
                .map_err(ConversationServiceError::from)?;
            let lock = self.turn_lock(input.conversation_id).await;
            let _guard = lock.lock().await;
            let in_flight = self
                .turn_is_still_in_flight(input.conversation_id, turn_id)
                .await?;
            if !in_flight {
                self.drop_live_agent_connection(input.conversation_id).await;
                return Err(ConversationServiceError::Conflict(
                    "Turn was cancelled during Agent startup".into(),
                ));
            }
            self.commit_native_binding(
                input.conversation_id,
                &input.agent_id,
                &prepared.working_dir,
                &candidate.session.acp_session_id,
                candidate.session.connection_id,
                effective_instance.as_deref(),
            )
            .await?;
            self.ctx
                .agent_runtime
                .commit_prepared_session(AgentSessionId(input.conversation_id))
                .await;
            if let Some(selection) = selection {
                prepared.agent_blocks.insert(
                    0,
                    AgentContentBlock::Text {
                        text: selection.prompt,
                    },
                );
            }
        } else if let Some(resume) = resume_candidate {
            // Stage C resume: restore the target agent's native session.
            self.validate_continuation_owner(input.conversation_id, input.agent_id.as_str())
                .await?;
            if let Ok(controls) = self
                .ctx
                .agent_runtime
                .session_controls_snapshot(AgentSessionId(input.conversation_id))
                .await
                && controls
                    .async_tasks
                    .iter()
                    .any(|task| !agents::async_tasks::async_task_state_is_terminal(&task.state))
            {
                return Err(ConversationServiceError::SessionUnavailable {
                    code: "continuation_not_allowed",
                    message: "Stop background Agent tasks before changing context".into(),
                });
            }
            self.release_agent_session_for_switch(input.conversation_id)
                .await?;
            if !self
                .turn_is_still_in_flight(input.conversation_id, turn_id)
                .await?
            {
                return Err(ConversationServiceError::Conflict(
                    "Turn was cancelled during history preparation".into(),
                ));
            }

            let settings = self
                .ctx
                .host
                .launch_settings_with_provider_instance(
                    pool,
                    &input.agent_id,
                    Some(launch_instance_id),
                )
                .await?;
            let mut preferences = self
                .resolved_session_control_preferences(pool, &input.agent_id, Some(&resume))
                .await;
            preferences.mode = input.mode_override.clone().or(preferences.mode);
            for value in &input.config_overrides {
                preferences.config.retain(|old| old.key != value.key);
                preferences.config.push(value.clone());
            }
            let acp_session_id = resume.acp_session_id.clone().unwrap_or_default();
            let (resumed_session, recovery) = self
                .ctx
                .agent_runtime
                .resume_session(ResumeAgentSessionInput {
                    agent_id: input.agent_id.clone(),
                    launch_lock: settings.launch_lock,
                    workspace_id: session.workspace_id,
                    working_dir: prepared.working_dir.clone().into(),
                    additional_directories: prepared.additional_directories.clone(),
                    session_id: AgentSessionId(input.conversation_id),
                    external_session_id: acp_session_id.clone(),
                    auto_approve_mode: settings.auto_approve_mode,
                    env: settings.env,
                    preferences,
                })
                .await
                .map_err(ConversationServiceError::from)?;
            self.finalize_resumed_continuation(
                input,
                turn_id,
                prepared,
                source.as_ref(),
                &resume,
                &target_key,
                &acp_session_id,
                &resumed_session,
                recovery,
            )
            .await?;
        } else {
            if session.agent_id.as_ref() != Some(&input.agent_id) {
                let _ = Session::update_agent_metadata(
                    pool,
                    input.conversation_id,
                    session.external_session_id.as_deref(),
                    Some(&input.agent_id),
                )
                .await;
            }
            self.ensure_session_controls_locked_with_provider_instance(
                input.conversation_id,
                Some(prepared.working_dir.clone().into()),
                Some(launch_instance_id),
            )
            .await?;
        }
        let binding =
            ConversationAgentBindingRecord::active_for_conversation(pool, input.conversation_id)
                .await?
                .ok_or_else(|| {
                    ConversationServiceError::Internal("Prepared Agent has no binding".into())
                })?;
        sqlx::query("UPDATE conversation_turns SET agent_binding_id = ? WHERE id = ? AND status = 'pending'")
            .bind(binding.id).bind(turn_id).execute(pool).await?;
        crate::handoff::set_target(pool, turn_id, binding.id).await?;
        Ok(())
    }

    /// Finalize a Stage C resume after `resume_session` completes.
    ///
    /// - When the provider truly resumed the prior native session, pack only the
    ///   portable delta unknown to `resume.id` and reactivate `resume.id` in place.
    /// - When the provider fell back to `CreatedNewSession`, repack full portable
    ///   history for the blank session, retire `resume.id` intact without overwriting
    ///   its `acp_session_id`, and insert/activate a fresh binding for the new session.
    #[allow(clippy::too_many_arguments)]
    async fn finalize_resumed_continuation(
        &self,
        input: &ConversationStartTurnInput,
        turn_id: Uuid,
        prepared: &mut PreparedTurnPrompt,
        source: Option<&ConversationAgentBindingRecord>,
        resume: &ConversationAgentBindingRecord,
        target_key: &str,
        previous_acp_session_id: &str,
        resumed_session: &agents::AgentSessionSnapshot,
        recovery: Option<agents::SessionRecoveryStrategy>,
    ) -> Result<(), ConversationServiceError> {
        let pool = &self.ctx.deployment.db().pool;
        let runtime_session_id = AgentSessionId(input.conversation_id);
        let lock = self.turn_lock(input.conversation_id).await;
        let _guard = lock.lock().await;
        if !self
            .turn_is_still_in_flight(input.conversation_id, turn_id)
            .await?
        {
            self.drop_live_agent_connection(input.conversation_id).await;
            return Err(ConversationServiceError::Conflict(
                "Turn was cancelled during Agent startup".into(),
            ));
        }

        let created_new_session = matches!(
            recovery,
            Some(agents::SessionRecoveryStrategy::CreatedNewSession)
        );

        let plan_result: Result<
            Option<crate::continuation::HistorySelection>,
            ConversationServiceError,
        > = async {
            let selection = if input.continuation_policy == Some(ContinuationPolicy::Portable) {
                let (known_prefixes, delivered_ids) = if created_new_session {
                    (Vec::new(), HashSet::new())
                } else {
                    (
                        self.known_segment_prefixes(pool, resume.id).await?,
                        crate::handoff::delivered_item_ids(pool, resume.id).await?,
                    )
                };
                let _ = crate::ensure_legacy_jsonl_migrated_on_pool(pool, input.conversation_id)
                    .await?;
                let current_bytes = serde_json::to_vec(&prepared.agent_blocks)
                    .map_err(|e| ConversationServiceError::Internal(e.to_string()))?
                    .len();
                let byte_budget =
                    (64 * 1024usize).min((128 * 1024usize).saturating_sub(current_bytes));
                DeterministicHandoffService::build_execution_handoff(
                    pool,
                    input.conversation_id,
                    input.agent_id.as_str(),
                    turn_id,
                    &known_prefixes,
                    &delivered_ids,
                    byte_budget,
                )
                .await
                .map_err(map_handoff_error_to_service)?
            } else {
                None
            };
            crate::handoff::plan(
                pool,
                input,
                turn_id,
                source.map(|b| b.id),
                selection.as_ref(),
            )
            .await?;
            Ok(selection)
        }
        .await;
        let selection = match plan_result {
            Ok(selection) => selection,
            Err(error) => {
                self.drop_live_agent_connection(input.conversation_id).await;
                return Err(error);
            }
        };

        let binding_result: Result<ConversationAgentBindingRecord, ConversationServiceError> =
            async {
                if created_new_session {
                    sqlx::query(
                        "UPDATE conversation_agent_bindings
                         SET resume_allowed = 0,
                             is_resume_head = 0,
                             invalidated_reason = COALESCE(invalidated_reason, 'resume_created_new_session'),
                             updated_at = datetime('now', 'subsec')
                         WHERE id = ?",
                    )
                    .bind(resume.id)
                    .execute(pool)
                    .await?;
                    let effective_working_dir = if !prepared.working_dir.trim().is_empty() {
                        prepared.working_dir.as_str()
                    } else {
                        resume.working_dir.as_str()
                    };
                    let new_binding =
                        ConversationAgentBindingRecord::prepare_native_session_with_continuation_key(
                            pool,
                            input.conversation_id,
                            &input.agent_id,
                            effective_working_dir,
                            &resumed_session.acp_session_id,
                            &resumed_session.connection_id.to_string(),
                            Some(target_key),
                        )
                        .await?;
                    ConversationAgentBindingRecord::activate(
                        pool,
                        input.conversation_id,
                        new_binding.id,
                    )
                    .await?;
                    sqlx::query(
                        "UPDATE conversation_agent_bindings
                         SET is_resume_head = 0
                         WHERE conversation_id = ? AND continuation_key = ?",
                    )
                    .bind(input.conversation_id)
                    .bind(target_key)
                    .execute(pool)
                    .await?;
                    sqlx::query(
                        "UPDATE conversation_agent_bindings
                         SET continuation_key = ?, is_resume_head = 1
                         WHERE id = ?",
                    )
                    .bind(target_key)
                    .bind(new_binding.id)
                    .execute(pool)
                    .await?;
                } else {
                    let _ = sqlx::query(
                        "UPDATE conversation_agent_bindings
                         SET acp_session_id = ?,
                             connection_id = ?,
                             status = 'ready',
                             updated_at = datetime('now', 'subsec')
                         WHERE id = ?",
                    )
                    .bind(&resumed_session.acp_session_id)
                    .bind(resumed_session.connection_id.to_string())
                    .bind(resume.id)
                    .execute(pool)
                    .await?;
                    ConversationAgentBindingRecord::activate(
                        pool,
                        input.conversation_id,
                        resume.id,
                    )
                    .await?;
                }
                ConversationAgentBindingRecord::active_for_conversation(
                    pool,
                    input.conversation_id,
                )
                .await?
                .ok_or_else(|| {
                    ConversationServiceError::Internal("Resumed binding disappeared".into())
                })
            }
            .await;
        let resumed_binding = match binding_result {
            Ok(binding) => binding,
            Err(error) => {
                self.drop_live_agent_connection(input.conversation_id).await;
                return Err(error);
            }
        };

        self.replay_remembered_session_controls(
            input.conversation_id,
            runtime_session_id,
            Some(&resumed_binding),
        )
        .await;
        self.ctx
            .agent_runtime
            .commit_prepared_session(runtime_session_id)
            .await;
        let capabilities = self
            .ctx
            .agent_runtime
            .session_controls_snapshot(runtime_session_id)
            .await
            .ok()
            .and_then(|controls| controls.capabilities)
            .or_else(|| {
                serde_json::from_str::<agents::conversation::AcpCapabilitySnapshot>(
                    &resumed_binding.session_capabilities_json,
                )
                .ok()
            })
            .unwrap_or_default();
        self.append_event(
            input.conversation_id,
            None,
            "runtime",
            agents::conversation::ConversationEvent::AgentBindingReady {
                acp_session_id: resumed_session.acp_session_id.clone(),
                capabilities,
            },
            None,
        )
        .await?;
        if created_new_session {
            let continues_from = (!previous_acp_session_id.is_empty()
                && previous_acp_session_id != resumed_session.acp_session_id)
                .then(|| previous_acp_session_id.to_string());
            self.record_agent_binding_recovered(
                input.conversation_id,
                agents::SessionRecoveryStrategy::CreatedNewSession,
                continues_from,
            )
            .await?;
        }
        if let Some(selection) = selection {
            prepared.agent_blocks.insert(
                0,
                AgentContentBlock::Text {
                    text: selection.prompt,
                },
            );
        }
        Ok(())
    }

    /// Get the turn-ID and legacy segment-ID prefixes for turns the binding already owns natively.
    async fn known_segment_prefixes(
        &self,
        pool: &sqlx::SqlitePool,
        binding_id: Uuid,
    ) -> Result<Vec<String>, sqlx::Error> {
        let turn_ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM conversation_turns WHERE agent_binding_id = ? ORDER BY ordinal",
        )
        .bind(binding_id)
        .fetch_all(pool)
        .await?;
        let segment_ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM conversation_transcript_segments WHERE binding_id = ? ORDER BY ordinal",
        )
        .bind(binding_id)
        .fetch_all(pool)
        .await?;
        let mut prefixes = Vec::with_capacity(turn_ids.len() + segment_ids.len());
        for id in turn_ids {
            prefixes.push(format!("{id}:"));
        }
        for id in segment_ids {
            prefixes.push(format!("segment:{}:", id.simple()));
        }
        Ok(prefixes)
    }

    async fn validate_continuation_owner(
        &self,
        conversation_id: Uuid,
        requested_agent_id: &str,
    ) -> Result<(), ConversationServiceError> {
        let pool = &self.ctx.deployment.db().pool;
        let owned: bool = sqlx::query_scalar(
            r#"SELECT EXISTS(
                   SELECT 1 FROM conversation_relations
                   WHERE child_conversation_id = ?
                     AND kind IN ('workflow_step', 'delegation')
               )
               OR EXISTS(
                   SELECT 1 FROM collaboration_thread_members tm
                   LEFT JOIN collaboration_members m ON m.id = tm.member_id
                   WHERE tm.conversation_id = ?
                     AND lower(replace(COALESCE(m.agent, ''), '-', '_')) != lower(replace(?, '-', '_'))
               )"#,
        )
        .bind(conversation_id)
        .bind(conversation_id.to_string())
        .bind(requested_agent_id)
        .fetch_one(pool)
        .await?;
        if owned {
            return Err(ConversationServiceError::SessionUnavailable {
                code: "continuation_not_allowed",
                message: "This conversation's Agent is controlled by its workflow or bot".into(),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{BTreeMap, HashMap},
        path::PathBuf,
        sync::Arc,
    };

    use agents::{
        AgentAutoApproveMode, AgentConnectionId, AgentContentBlock, AgentId, AgentRuntime,
        AgentSessionId, AgentSessionSnapshot, AgentSessionStatus, NoopEventSink,
        SessionLaunchLock, SessionRecoveryStrategy,
        conversation::{ContinuationPolicy, ConversationEvent, ConversationInputBlock},
    };
    use db::models::{
        conversation::{
            ConversationAgentBindingRecord, ConversationRecord, CreateConversationRecord,
        },
        conversation_event::AppendConversationEvent,
        conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
        project::{CreateProject, Project},
        task::{CreateTask, Task},
        workspace::{CreateWorkspace, Workspace},
    };
    use deployment::Deployment;
    use local_deployment::LocalDeployment;

    use super::*;
    use crate::{AgentRuntimeLaunchSettings, ConversationContext, ConversationHost};

    struct TestHost;

    #[async_trait::async_trait]
    impl ConversationHost for TestHost {
        fn resolve_working_dir(
            &self,
            _: &Workspace,
            container: &str,
            _: &[db::models::repo::Repo],
        ) -> Option<String> {
            Some(container.into())
        }

        fn resolve_additional_directories(
            &self,
            _: &Workspace,
            _: &str,
            _: &[db::models::repo::Repo],
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
            _: &sqlx::SqlitePool,
            agent: &AgentId,
        ) -> Result<AgentRuntimeLaunchSettings, ConversationServiceError> {
            Ok(AgentRuntimeLaunchSettings {
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
                launch_lock: SessionLaunchLock {
                    agent_id: agent.clone(),
                    absolute_acp_program: std::env::temp_dir().join("b3-test-acp"),
                    args: Vec::new(),
                    env: BTreeMap::new(),
                    runtime_version: "test".into(),
                    acp_version: "test".into(),
                },
            })
        }
    }

    async fn seed_two_agent_history() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        ConversationSessionService,
        sqlx::SqlitePool,
        Uuid,
        Uuid,
        String,
        ConversationAgentBindingRecord,
        ConversationAgentBindingRecord,
        Uuid,
    ) {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let working_dir = work.path().to_string_lossy().to_string();
        let deployment = Arc::new(LocalDeployment::new_at(data.path()).await.unwrap());
        let pool = deployment.db().pool.clone();
        let project = Project::create(
            &pool,
            &CreateProject {
                name: "b3".into(),
                root_path: working_dir.clone(),
                ..Default::default()
            },
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let task = Task::create(
            &pool,
            &CreateTask::from_title_description(project.id, "b3".into(), None),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let workspace = Workspace::create(
            &pool,
            &CreateWorkspace {
                project_id: project.id,
                parent_workspace_id: None,
                branch: "main".into(),
                container_ref: Some(working_dir.clone()),
                use_worktree: false,
                agent_working_dir: Some(working_dir.clone()),
            },
            Uuid::new_v4(),
            task.id,
        )
        .await
        .unwrap();
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: workspace.id,
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("claude_code"),
            },
        )
        .await
        .unwrap();

        let claude = AgentId::parse("claude_code").unwrap();
        let codex = AgentId::parse("codex").unwrap();
        let claude_key = continuation_key("claude_code", &working_dir, None);
        let codex_key = continuation_key("codex", &working_dir, None);

        // Binding 1: claude_code owns Turn 1
        let claude_binding =
            ConversationAgentBindingRecord::prepare_native_session_with_continuation_key(
                &pool,
                conversation_id,
                &claude,
                &working_dir,
                "claude-old-session-1",
                "conn-claude-1",
                Some(&claude_key),
            )
            .await
            .unwrap();
        ConversationAgentBindingRecord::activate(&pool, conversation_id, claude_binding.id)
            .await
            .unwrap();
        sqlx::query("UPDATE conversation_agent_bindings SET is_resume_head = 1 WHERE id = ?")
            .bind(claude_binding.id)
            .execute(&pool)
            .await
            .unwrap();

        let turn1 = ConversationTurnRecord::create_pending(
            &pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("p1"),
                text_preview: Some("remember alpha-secret-from-turn-1"),
                input_blocks_json: "[]",
            },
        )
        .await
        .unwrap();
        sqlx::query("UPDATE conversation_turns SET agent_binding_id = ?, status = 'completed' WHERE id = ?")
            .bind(claude_binding.id)
            .bind(turn1.id)
            .execute(&pool)
            .await
            .unwrap();

        // Binding 2: codex owns Turn 2
        let codex_binding =
            ConversationAgentBindingRecord::prepare_native_session_with_continuation_key(
                &pool,
                conversation_id,
                &codex,
                &working_dir,
                "codex-session-2",
                "conn-codex-2",
                Some(&codex_key),
            )
            .await
            .unwrap();
        ConversationAgentBindingRecord::activate(&pool, conversation_id, codex_binding.id)
            .await
            .unwrap();
        sqlx::query("UPDATE conversation_agent_bindings SET is_resume_head = 1 WHERE id = ?")
            .bind(codex_binding.id)
            .execute(&pool)
            .await
            .unwrap();

        let turn2 = ConversationTurnRecord::create_pending(
            &pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("p2"),
                text_preview: Some("follow-up beta-detail-from-turn-2"),
                input_blocks_json: "[]",
            },
        )
        .await
        .unwrap();
        sqlx::query("UPDATE conversation_turns SET agent_binding_id = ?, status = 'completed' WHERE id = ?")
            .bind(codex_binding.id)
            .bind(turn2.id)
            .execute(&pool)
            .await
            .unwrap();

        // Append conversation events for Turn 1 and Turn 2 so handoff packs both.
        let events = [
            (
                Some(turn1.id),
                "user",
                "user_turn_created",
                ConversationEvent::UserTurnCreated {
                    blocks: vec![ConversationInputBlock::Text {
                        text: "remember alpha-secret-from-turn-1".into(),
                    }],
                    workflow_refs: Vec::new(),
                },
            ),
            (
                Some(turn1.id),
                "acp",
                "assistant_text_delta",
                ConversationEvent::AssistantTextDelta {
                    text: "stored alpha-secret-from-turn-1".into(),
                    message_id: None,
                },
            ),
            (
                Some(turn1.id),
                "runtime",
                "turn_completed",
                ConversationEvent::TurnCompleted { stop_reason: None },
            ),
            (
                Some(turn2.id),
                "user",
                "user_turn_created",
                ConversationEvent::UserTurnCreated {
                    blocks: vec![ConversationInputBlock::Text {
                        text: "follow-up beta-detail-from-turn-2".into(),
                    }],
                    workflow_refs: Vec::new(),
                },
            ),
            (
                Some(turn2.id),
                "acp",
                "assistant_text_delta",
                ConversationEvent::AssistantTextDelta {
                    text: "handled beta-detail-from-turn-2".into(),
                    message_id: None,
                },
            ),
            (
                Some(turn2.id),
                "runtime",
                "turn_completed",
                ConversationEvent::TurnCompleted { stop_reason: None },
            ),
        ];
        for (tid, source, kind, ev) in events {
            let normalized = serde_json::to_string(&ev).unwrap();
            crate::ConversationEventAppender::append(
                &pool,
                AppendConversationEvent {
                    id: Uuid::new_v4(),
                    conversation_id,
                    turn_id: tid,
                    binding_id: None,
                    connection_id: None,
                    prompt_id: None,
                    source,
                    event_kind: kind,
                    normalized_json: &normalized,
                    raw_json: None,
                    idempotency_key: None,
                },
            )
            .await
            .unwrap();
        }

        // Pending Turn 3 switching back to claude_code.
        let turn3 = ConversationTurnRecord::create_pending(
            &pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("p3"),
                text_preview: Some("continue on claude"),
                input_blocks_json: "[]",
            },
        )
        .await
        .unwrap();
        ConversationRecord::update_active_turn(&pool, conversation_id, Some(turn3.id))
            .await
            .unwrap();

        let runtime = Arc::new(AgentRuntime::new_with_driver(
            Arc::new(NoopEventSink),
            false,
        ));
        let ctx = ConversationContext {
            deployment,
            agent_runtime: runtime,
            turn_locks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            runtime_states: Default::default(),
            row_projectors: Default::default(),
            host: Arc::new(TestHost),
            event_publisher: Arc::new(crate::NoopConversationEventPublisher),
        };
        let service = ConversationSessionService::new(ctx);

        let claude_binding =
            ConversationAgentBindingRecord::list_for_conversation(&pool, conversation_id)
                .await
                .unwrap()
                .into_iter()
                .find(|b| b.id == claude_binding.id)
                .unwrap();
        let codex_binding =
            ConversationAgentBindingRecord::list_for_conversation(&pool, conversation_id)
                .await
                .unwrap()
                .into_iter()
                .find(|b| b.id == codex_binding.id)
                .unwrap();

        (
            data,
            work,
            service,
            pool,
            workspace.id,
            conversation_id,
            working_dir,
            claude_binding,
            codex_binding,
            turn3.id,
        )
    }

    fn start_input(
        workspace_id: Uuid,
        conversation_id: Uuid,
        agent_id: AgentId,
    ) -> ConversationStartTurnInput {
        ConversationStartTurnInput {
            continuation_policy: Some(ContinuationPolicy::Portable),
            expected_binding_revision: None,
            agent_id,
            workspace_id,
            conversation_id,
            executor_profile_id: None,
            text: "continue on claude".into(),
            display_text: None,
            images: Vec::new(),
            mode_override: None,
            config_overrides: Vec::new(),
            workflow_refs: Vec::new(),
            file_refs: Vec::new(),
            internal_prompt_contributions: Vec::new(),
            queued_input_claim: None,
            operation_id: Some(Uuid::new_v4()),
            collaboration_origin: None,
            provider_instance_id: None,
        }
    }

    #[tokio::test]
    async fn stage_c_created_new_session_fallback_repacks_full_history_and_inserts_new_binding() {
        let (
            _data,
            _work,
            service,
            pool,
            workspace_id,
            conversation_id,
            working_dir,
            old_claude_binding,
            codex_binding,
            turn3_id,
        ) = seed_two_agent_history().await;

        let claude = AgentId::parse("claude_code").unwrap();
        let target_key = continuation_key("claude_code", &working_dir, None);
        let input = start_input(workspace_id, conversation_id, claude);
        let mut prepared = PreparedTurnPrompt {
            working_dir: working_dir.clone(),
            additional_directories: Vec::new(),
            agent_blocks: vec![AgentContentBlock::Text {
                text: "continue on claude".into(),
            }],
            display_blocks: vec![AgentContentBlock::Text {
                text: "continue on claude".into(),
            }],
            smart_reminder: None,
        };
        let now = chrono::Utc::now();
        let resumed_snapshot = AgentSessionSnapshot {
            id: AgentSessionId(conversation_id),
            connection_id: AgentConnectionId(Uuid::new_v4()),
            acp_session_id: "claude-fresh-session-999".into(),
            status: AgentSessionStatus::Ready,
            active_prompt_id: None,
            queued_prompt_ids: Vec::new(),
            created_at: now,
            updated_at: now,
        };

        service
            .finalize_resumed_continuation(
                &input,
                turn3_id,
                &mut prepared,
                Some(&codex_binding),
                &old_claude_binding,
                &target_key,
                "claude-old-session-1",
                &resumed_snapshot,
                Some(SessionRecoveryStrategy::CreatedNewSession),
            )
            .await
            .expect("finalize CreatedNewSession fallback");

        // 1. Full portable history (both Turn 1 and Turn 2) must be packed for the blank session.
        let handoff_prompt = match &prepared.agent_blocks[0] {
            AgentContentBlock::Text { text } => text.as_str(),
            other => panic!("expected text handoff block, got {other:?}"),
        };
        assert!(
            handoff_prompt.contains("alpha-secret-from-turn-1"),
            "CreatedNewSession fallback must include Turn 1 previously owned by old binding: {handoff_prompt}"
        );
        assert!(
            handoff_prompt.contains("beta-detail-from-turn-2"),
            "CreatedNewSession fallback must include Turn 2: {handoff_prompt}"
        );

        // 2. Old binding must remain intact (acp_session_id not overwritten) and be retired.
        let all_bindings =
            ConversationAgentBindingRecord::list_for_conversation(&pool, conversation_id)
                .await
                .unwrap();
        let old_after = all_bindings
            .iter()
            .find(|b| b.id == old_claude_binding.id)
            .expect("old binding still present");
        assert_eq!(
            old_after.acp_session_id.as_deref(),
            Some("claude-old-session-1"),
            "old binding acp_session_id must not be overwritten in place"
        );
        assert!(!old_after.resume_allowed, "old binding must be retired");
        assert!(
            !old_after.is_resume_head,
            "old binding must not be resume head"
        );
        assert_eq!(
            old_after.invalidated_reason.as_deref(),
            Some("resume_created_new_session")
        );

        // 3. A brand-new binding must be created and activated with the new session id.
        let active = ConversationAgentBindingRecord::active_for_conversation(&pool, conversation_id)
            .await
            .unwrap()
            .expect("active binding exists");
        assert_ne!(active.id, old_claude_binding.id);
        assert_eq!(
            active.acp_session_id.as_deref(),
            Some("claude-fresh-session-999")
        );
        assert!(active.is_resume_head);
        assert!(active.resume_allowed);
    }

    #[tokio::test]
    async fn stage_c_true_native_resume_packs_only_delta_and_reuses_binding() {
        let (
            _data,
            _work,
            service,
            pool,
            workspace_id,
            conversation_id,
            working_dir,
            old_claude_binding,
            codex_binding,
            turn3_id,
        ) = seed_two_agent_history().await;

        let claude = AgentId::parse("claude_code").unwrap();
        let target_key = continuation_key("claude_code", &working_dir, None);
        let input = start_input(workspace_id, conversation_id, claude);
        let mut prepared = PreparedTurnPrompt {
            working_dir: working_dir.clone(),
            additional_directories: Vec::new(),
            agent_blocks: vec![AgentContentBlock::Text {
                text: "continue on claude".into(),
            }],
            display_blocks: vec![AgentContentBlock::Text {
                text: "continue on claude".into(),
            }],
            smart_reminder: None,
        };
        let now = chrono::Utc::now();
        let resumed_snapshot = AgentSessionSnapshot {
            id: AgentSessionId(conversation_id),
            connection_id: AgentConnectionId(Uuid::new_v4()),
            acp_session_id: "claude-old-session-1".into(),
            status: AgentSessionStatus::Ready,
            active_prompt_id: None,
            queued_prompt_ids: Vec::new(),
            created_at: now,
            updated_at: now,
        };

        service
            .finalize_resumed_continuation(
                &input,
                turn3_id,
                &mut prepared,
                Some(&codex_binding),
                &old_claude_binding,
                &target_key,
                "claude-old-session-1",
                &resumed_snapshot,
                None,
            )
            .await
            .expect("finalize true native resume");

        // True native resume sends only Turn 2 delta and omits Turn 1 already owned by old_claude_binding.
        let handoff_prompt = match &prepared.agent_blocks[0] {
            AgentContentBlock::Text { text } => text.as_str(),
            other => panic!("expected text handoff block, got {other:?}"),
        };
        assert!(
            !handoff_prompt.contains("alpha-secret-from-turn-1"),
            "true native resume must not duplicate Turn 1 already known to binding: {handoff_prompt}"
        );
        assert!(
            handoff_prompt.contains("beta-detail-from-turn-2"),
            "true native resume must carry Turn 2 delta: {handoff_prompt}"
        );

        let active = ConversationAgentBindingRecord::active_for_conversation(&pool, conversation_id)
            .await
            .unwrap()
            .expect("active binding exists");
        assert_eq!(active.id, old_claude_binding.id);
    }
}
