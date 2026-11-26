//! Two-phase deferred launch service shared by `delegate_task`, `thread_launch`,
//! and `create_threads`.
//!
//! Phase 1 (sync): validate, persist SQLite rows (`preparing` when worktree
//! setup is required), and return `{ conversation_id, link, status }` immediately.
//! Phase 2 (background, cancellable): run git fetch / worktree checkout / setup,
//! bind the target agent session in the resolved working directory, and dispatch
//! the initial turn. Cancellation or error cleans up newly created worktrees.

use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::Arc,
};

use agents::{
    AgentEvent, AgentId, AgentRuntime, AgentSessionConfigOverride, AgentSessionId,
    events::DelegationResultSummary, ids::AgentConnectionId,
};
use chrono::{Duration as ChronoDuration, Utc};
use conversations::{
    ConversationContext, ConversationSessionService, CreateOrchestratedConversation,
    WorkspaceLaunchStrategy, create_orchestrated_conversation,
    ensure_orchestration_scratch_workspace, prepare_project_workspace, rollback_prepared_workspace,
};
use db::models::{
    conversation_delegation::{ConversationDelegationRecord, CreateConversationDelegation},
    project::Project,
    session::Session,
    workspace::Workspace,
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{OrchestrationError, conversation_link};
use crate::mode_limit::OrchestrationModeLimit;

#[derive(Debug, Clone)]
pub struct LaunchTargetSpec {
    pub agent_id: AgentId,
    pub provider_instance_id: Option<String>,
    pub model: Option<String>,
    pub options: BTreeMap<String, String>,
    pub project_id: Option<Uuid>,
    pub scratch: bool,
    pub workspace_strategy: WorkspaceLaunchStrategy,
    pub effective_mode_limit: OrchestrationModeLimit,
}

#[derive(Debug, Clone)]
pub struct DelegationLaunchSpec {
    pub run_id: String,
    pub parent_conversation_id: Uuid,
    pub parent_connection_id: String,
    pub parent_tool_use_id: String,
    pub caller_workspace_id: Option<Uuid>,
    pub caller_working_root: PathBuf,
    pub explicit_project_id: bool,
    pub role: Option<String>,
    pub task: String,
    pub isolation: String,
    pub mode: String,
    pub completion_wake: String,
    pub deadline_ms: u64,
    pub target: LaunchTargetSpec,
}

#[derive(Debug, Clone)]
pub struct ThreadLaunchSpec {
    pub caller_conversation_id: Uuid,
    pub title: Option<String>,
    pub message: Option<String>,
    pub attachment_paths: Vec<String>,
    pub target: LaunchTargetSpec,
}

#[derive(Debug, Clone)]
pub struct PreparedLaunchResult {
    pub run_id: Option<String>,
    pub conversation_id: Uuid,
    pub project_id: Option<Uuid>,
    pub workspace_id: Option<Uuid>,
    pub link: String,
    pub status: String,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
}

/// Tracks cancellable Phase-2 preparation tasks so `task_cancel` and
/// `thread_interrupt` can abort in-flight worktree setup and trigger rollback.
#[derive(Default, Clone)]
pub struct ActivePreparations {
    tokens: Arc<Mutex<HashMap<Uuid, CancellationToken>>>,
}

impl ActivePreparations {
    pub async fn register(&self, conversation_id: Uuid) -> CancellationToken {
        let token = CancellationToken::new();
        self.tokens.lock().await.insert(conversation_id, token.clone());
        token
    }

    pub async fn cancel(&self, conversation_id: Uuid) -> bool {
        if let Some(token) = self.tokens.lock().await.remove(&conversation_id) {
            token.cancel();
            true
        } else {
            false
        }
    }

    pub async fn finish(&self, conversation_id: Uuid) {
        self.tokens.lock().await.remove(&conversation_id);
    }
}

#[derive(Clone)]
pub struct ConversationLaunchService {
    pub context: ConversationContext,
    pub runtime: Arc<AgentRuntime>,
    pub preparations: ActivePreparations,
}

impl ConversationLaunchService {
    pub fn new(
        context: ConversationContext,
        runtime: Arc<AgentRuntime>,
        preparations: ActivePreparations,
    ) -> Self {
        Self {
            context,
            runtime,
            preparations,
        }
    }

    /// Launch a delegated child conversation using two-phase deferred launch.
    pub async fn launch_delegation(
        &self,
        spec: DelegationLaunchSpec,
    ) -> Result<PreparedLaunchResult, OrchestrationError> {
        let pool = &self.context.deployment.db().pool;
        let child_conversation_id = Uuid::new_v4();
        let target_project = resolve_target_project(pool, spec.target.project_id, false).await?;
        let needs_async_worktree = matches!(
            spec.target.workspace_strategy,
            WorkspaceLaunchStrategy::Worktree { .. }
        );
        if needs_async_worktree && target_project.is_none() {
            return Err(OrchestrationError::BadRequest(
                "worktree isolation requires a registered target project".into(),
            ));
        }

        let ws_title = spec
            .role
            .clone()
            .unwrap_or_else(|| format!("Delegation · {}", spec.target.agent_id));

        // Phase 1 MUST always bind a real FK-valid `session_workspace_id` because
        // `sessions.workspace_id` is `BLOB NOT NULL REFERENCES workspaces(id)`.
        // For async worktrees we bind the project's fast root workspace temporarily
        // and swap `sessions.workspace_id` to the new worktree once Phase 2 finishes.
        let (
            session_workspace_id,
            delegation_workspace_id,
            resolved_project_id,
            initial_working_dir,
            initial_branch,
            initial_worktree_path,
        ) = if needs_async_worktree {
            let project = target_project.as_ref().expect("validated above");
            let placeholder = prepare_project_workspace(
                &self.context,
                project.id,
                None,
                WorkspaceLaunchStrategy::Root,
                ws_title,
            )
            .await
            .map_err(|err| OrchestrationError::BadRequest(err.to_string()))?;
            (
                placeholder.workspace_id,
                None,
                Some(project.id),
                None,
                None,
                None,
            )
        } else if spec.isolation == "shared"
            && !spec.explicit_project_id
            && let Some(caller_ws_id) = spec.caller_workspace_id
            && let Ok(Some(caller_ws)) = Workspace::find_by_id(pool, caller_ws_id).await
        {
            // Inherit the caller's exact checkout (including if caller is in a git worktree).
            let inherited_dir = if spec.caller_working_root.is_dir() {
                spec.caller_working_root.clone()
            } else if let Some(container_ref) = caller_ws.container_ref.as_deref() {
                PathBuf::from(container_ref)
            } else {
                spec.caller_working_root.clone()
            };
            let wt_path = caller_ws
                .use_worktree
                .then(|| inherited_dir.to_string_lossy().into_owned());
            (
                caller_ws.id,
                Some(caller_ws.id),
                Some(caller_ws.project_id),
                Some(inherited_dir),
                (!caller_ws.branch.is_empty()).then_some(caller_ws.branch),
                wt_path,
            )
        } else if let Some(project) = target_project.as_ref() {
            let prepared = prepare_project_workspace(
                &self.context,
                project.id,
                None,
                spec.target.workspace_strategy.clone(),
                ws_title,
            )
            .await
            .map_err(|err| OrchestrationError::BadRequest(err.to_string()))?;
            (
                prepared.workspace_id,
                Some(prepared.workspace_id),
                Some(project.id),
                Some(prepared.working_dir),
                prepared.branch,
                prepared
                    .worktree_path
                    .map(|p| p.to_string_lossy().into_owned()),
            )
        } else {
            let scratch = ensure_orchestration_scratch_workspace(pool)
                .await
                .map_err(|err| OrchestrationError::Internal(err.to_string()))?;
            let working_dir = if spec.caller_working_root.is_dir() {
                spec.caller_working_root.clone()
            } else {
                scratch.working_dir
            };
            (
                scratch.workspace_id,
                Some(scratch.workspace_id),
                Some(scratch.project_id),
                Some(working_dir),
                scratch.branch,
                None,
            )
        };

        let title = spec
            .role
            .as_deref()
            .filter(|r| !r.trim().is_empty())
            .map(|r| format!("{r} · {}", spec.target.agent_id))
            .or_else(|| Some(format!("Delegation · {}", spec.target.agent_id)));
        let task_preview: String = spec.task.chars().take(240).collect();

        create_orchestrated_conversation(
            pool,
            CreateOrchestratedConversation {
                id: child_conversation_id,
                parent_conversation_id: Some(spec.parent_conversation_id),
                parent_tool_call_id: Some(spec.parent_tool_use_id.clone()),
                delegation_id: Some(spec.run_id.clone()),
                workspace_id: session_workspace_id,
                agent_id: spec.target.agent_id.clone(),
                provider_instance_id: spec.target.provider_instance_id.clone(),
                title,
                initial_prompt: Some(spec.task.clone()),
                policy: serde_json::json!({
                    "isolation": &spec.isolation,
                    "mode": &spec.mode,
                    "completionWake": &spec.completion_wake,
                    "maxRuntimeMode": spec.target.effective_mode_limit.max_runtime_mode.as_str(),
                    "maxInteractionMode": spec.target.effective_mode_limit.max_interaction_mode.as_str(),
                }),
            },
        )
        .await
        .map_err(|err| OrchestrationError::Internal(err.to_string()))?;

        let deadline_at =
            Utc::now() + ChronoDuration::milliseconds(spec.deadline_ms.min(86_400_000) as i64);
        let initial_status = if needs_async_worktree {
            "preparing"
        } else {
            "running"
        };
        let initial_stage = if needs_async_worktree {
            Some("creating_worktree")
        } else {
            Some("ready")
        };

        ConversationDelegationRecord::create(
            pool,
            CreateConversationDelegation {
                run_id: &spec.run_id,
                parent_conversation_id: spec.parent_conversation_id,
                child_conversation_id,
                parent_tool_call_id: &spec.parent_tool_use_id,
                target_project_id: resolved_project_id,
                target_workspace_id: delegation_workspace_id,
                target_environment_id: None,
                agent_id: spec.target.agent_id.as_str(),
                provider_instance_id: spec.target.provider_instance_id.as_deref(),
                model: spec.target.model.as_deref(),
                role: spec.role.as_deref(),
                task_preview: &task_preview,
                isolation: &spec.isolation,
                mode: &spec.mode,
                completion_wake: &spec.completion_wake,
                max_runtime_mode: spec.target.effective_mode_limit.max_runtime_mode.as_i64(),
                max_interaction_mode: spec
                    .target
                    .effective_mode_limit
                    .max_interaction_mode
                    .as_i64(),
                status: initial_status,
                preparation_stage: initial_stage,
                worktree_path: initial_worktree_path.as_deref(),
                branch: initial_branch.as_deref(),
                deadline_at: Some(deadline_at),
            },
        )
        .await
        .map_err(|err| OrchestrationError::Internal(err.to_string()))?;

        // Emit AgentEvent::DelegationStarted for parent UI DelegationCard immediately.
        if let Ok(conn_uuid) = Uuid::parse_str(&spec.parent_connection_id) {
            self.runtime
                .emit_external(
                    AgentConnectionId::from(conn_uuid),
                    Some(AgentSessionId::from(spec.parent_conversation_id)),
                    AgentEvent::DelegationStarted {
                        delegation_id: spec.run_id.clone(),
                        parent_tool_use_id: spec.parent_tool_use_id.clone(),
                        child_session_id: child_conversation_id,
                        agent_id: spec.target.agent_id.clone(),
                        task_preview: task_preview.clone(),
                    },
                )
                .await;
        }

        // Phase 2: prepare worktree (if needed), bind child session, start turn.
        let cancel_token = self.preparations.register(child_conversation_id).await;
        let launcher = self.clone();
        let target_project_id = resolved_project_id;
        let run_id_bg = spec.run_id.clone();
        let parent_conn_bg = spec.parent_connection_id.clone();
        let parent_conv_bg = spec.parent_conversation_id;
        let parent_tool_bg = spec.parent_tool_use_id.clone();
        let agent_id_bg = spec.target.agent_id.clone();
        let strategy_bg = spec.target.workspace_strategy.clone();
        let mode_limit_bg = spec.target.effective_mode_limit;
        let model_bg = spec.target.model.clone();
        let options_bg = spec.target.options.clone();
        let task_bg = spec.task.clone();
        let role_bg = spec.role.clone();
        let mode_bg = spec.mode.clone();

        tokio::spawn(async move {
            let outcome = launcher
                .run_delegation_phase2(
                    child_conversation_id,
                    &run_id_bg,
                    target_project_id,
                    initial_working_dir,
                    needs_async_worktree,
                    strategy_bg,
                    role_bg,
                    agent_id_bg.clone(),
                    mode_limit_bg,
                    model_bg,
                    options_bg,
                    task_bg,
                    cancel_token,
                )
                .await;
            launcher.preparations.finish(child_conversation_id).await;

            if let Err((status, code, message)) = outcome {
                let pool = &launcher.context.deployment.db().pool;
                let _ = ConversationDelegationRecord::finish(
                    pool,
                    &run_id_bg,
                    status,
                    None,
                    Some(code),
                    Some(&message),
                )
                .await;
                if status == "cancelled" {
                    let _ = ConversationDelegationRecord::mark_delivered(
                        pool,
                        std::slice::from_ref(&run_id_bg),
                    )
                    .await;
                }
                if let Ok(conn_uuid) = Uuid::parse_str(&parent_conn_bg) {
                    launcher
                        .runtime
                        .emit_external(
                            AgentConnectionId::from(conn_uuid),
                            Some(AgentSessionId::from(parent_conv_bg)),
                            AgentEvent::DelegationCompleted {
                                delegation_id: run_id_bg,
                                parent_tool_use_id: parent_tool_bg,
                                child_session_id: child_conversation_id,
                                agent_id: agent_id_bg,
                                result: DelegationResultSummary::Err {
                                    error_code: code.to_string(),
                                },
                            },
                        )
                        .await;
                }
                // Wake async parents immediately when Phase 2 fails so they never hang.
                if status != "cancelled" && mode_bg == "async" {
                    super::reactors::deliver_coalesced_completions(
                        &launcher.context,
                        parent_conv_bg,
                    )
                    .await;
                }
            }
        });

        Ok(PreparedLaunchResult {
            run_id: Some(spec.run_id),
            conversation_id: child_conversation_id,
            project_id: resolved_project_id,
            workspace_id: delegation_workspace_id,
            link: conversation_link(child_conversation_id, None),
            status: initial_status.to_string(),
            branch: initial_branch,
            worktree_path: initial_worktree_path,
        })
    }

    /// Launch a durable top-level conversation thread (`thread_launch` / `create_threads`).
    pub async fn launch_top_level_thread(
        &self,
        spec: ThreadLaunchSpec,
    ) -> Result<PreparedLaunchResult, OrchestrationError> {
        let pool = &self.context.deployment.db().pool;
        let conversation_id = Uuid::new_v4();
        let target_project =
            resolve_target_project(pool, spec.target.project_id, spec.target.scratch).await?;
        let needs_async_worktree = !spec.target.scratch
            && matches!(
                spec.target.workspace_strategy,
                WorkspaceLaunchStrategy::Worktree { .. }
            );
        if needs_async_worktree && target_project.is_none() {
            return Err(OrchestrationError::BadRequest(
                "worktree strategy requires a registered target project".into(),
            ));
        }

        let ws_title = spec
            .title
            .clone()
            .unwrap_or_else(|| format!("Thread · {}", spec.target.agent_id));

        let (
            session_workspace_id,
            reported_workspace_id,
            resolved_project_id,
            initial_working_dir,
            initial_branch,
            initial_worktree_path,
        ) = if spec.target.scratch {
            let scratch = ensure_orchestration_scratch_workspace(pool)
                .await
                .map_err(|err| OrchestrationError::Internal(err.to_string()))?;
            (
                scratch.workspace_id,
                Some(scratch.workspace_id),
                Some(scratch.project_id),
                Some(scratch.working_dir),
                scratch.branch,
                None,
            )
        } else if needs_async_worktree {
            let project = target_project.as_ref().expect("validated above");
            let placeholder = prepare_project_workspace(
                &self.context,
                project.id,
                None,
                WorkspaceLaunchStrategy::Root,
                ws_title,
            )
            .await
            .map_err(|err| OrchestrationError::BadRequest(err.to_string()))?;
            (
                placeholder.workspace_id,
                None,
                Some(project.id),
                None,
                None,
                None,
            )
        } else if let Some(project) = target_project.as_ref() {
            let prepared = prepare_project_workspace(
                &self.context,
                project.id,
                None,
                spec.target.workspace_strategy.clone(),
                ws_title,
            )
            .await
            .map_err(|err| OrchestrationError::BadRequest(err.to_string()))?;
            (
                prepared.workspace_id,
                Some(prepared.workspace_id),
                Some(project.id),
                Some(prepared.working_dir),
                prepared.branch,
                prepared
                    .worktree_path
                    .map(|p| p.to_string_lossy().into_owned()),
            )
        } else {
            let scratch = ensure_orchestration_scratch_workspace(pool)
                .await
                .map_err(|err| OrchestrationError::Internal(err.to_string()))?;
            (
                scratch.workspace_id,
                Some(scratch.workspace_id),
                Some(scratch.project_id),
                Some(scratch.working_dir),
                scratch.branch,
                None,
            )
        };

        let effective_message = compose_message_with_attachments(
            spec.message.as_deref(),
            &spec.attachment_paths,
        );

        create_orchestrated_conversation(
            pool,
            CreateOrchestratedConversation {
                id: conversation_id,
                parent_conversation_id: None,
                parent_tool_call_id: None,
                delegation_id: None,
                workspace_id: session_workspace_id,
                agent_id: spec.target.agent_id.clone(),
                provider_instance_id: spec.target.provider_instance_id.clone(),
                title: spec.title.clone(),
                initial_prompt: effective_message.clone(),
                policy: serde_json::json!({
                    "launchedBy": spec.caller_conversation_id,
                    "maxRuntimeMode": spec.target.effective_mode_limit.max_runtime_mode.as_str(),
                    "maxInteractionMode": spec.target.effective_mode_limit.max_interaction_mode.as_str(),
                }),
            },
        )
        .await
        .map_err(|err| OrchestrationError::Internal(err.to_string()))?;

        let status = if needs_async_worktree {
            "preparing"
        } else if effective_message
            .as_deref()
            .is_some_and(|msg| !msg.trim().is_empty())
        {
            "running"
        } else {
            "ready"
        };

        if needs_async_worktree
            || effective_message
                .as_deref()
                .is_some_and(|msg| !msg.trim().is_empty())
        {
            let cancel_token = self.preparations.register(conversation_id).await;
            let launcher = self.clone();
            let target_project_id = resolved_project_id;
            let title_bg = spec.title.clone();
            let message_bg = effective_message;
            let strategy_bg = spec.target.workspace_strategy.clone();
            let mode_limit_bg = spec.target.effective_mode_limit;
            let model_bg = spec.target.model.clone();
            let options_bg = spec.target.options.clone();
            let agent_id_bg = spec.target.agent_id.clone();

            tokio::spawn(async move {
                let _ = launcher
                    .run_thread_phase2(
                        conversation_id,
                        target_project_id,
                        initial_working_dir,
                        needs_async_worktree,
                        strategy_bg,
                        title_bg,
                        agent_id_bg,
                        mode_limit_bg,
                        model_bg,
                        options_bg,
                        message_bg,
                        cancel_token,
                    )
                    .await;
                launcher.preparations.finish(conversation_id).await;
            });
        }

        Ok(PreparedLaunchResult {
            run_id: None,
            conversation_id,
            project_id: resolved_project_id,
            workspace_id: reported_workspace_id,
            link: conversation_link(conversation_id, None),
            status: status.to_string(),
            branch: initial_branch,
            worktree_path: initial_worktree_path,
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_delegation_phase2(
        &self,
        child_conversation_id: Uuid,
        run_id: &str,
        target_project_id: Option<Uuid>,
        initial_working_dir: Option<PathBuf>,
        needs_async_worktree: bool,
        strategy: WorkspaceLaunchStrategy,
        role: Option<String>,
        agent_id: AgentId,
        mode_limit: OrchestrationModeLimit,
        model: Option<String>,
        options: BTreeMap<String, String>,
        task: String,
        cancel_token: CancellationToken,
    ) -> Result<(), (&'static str, &'static str, String)> {
        let pool = &self.context.deployment.db().pool;
        let mut working_dir = initial_working_dir;
        let mut created_workspace_id: Option<Uuid> = None;

        if needs_async_worktree {
            if cancel_token.is_cancelled() {
                return Err(("cancelled", "cancelled", "cancelled before preparation".into()));
            }
            let project_id = target_project_id.ok_or((
                "failed",
                "missing_project",
                "worktree isolation requires a registered target project".into(),
            ))?;
            let _ = ConversationDelegationRecord::update_preparation(
                pool,
                run_id,
                "preparing",
                Some("creating_worktree"),
                None,
                None,
                None,
            )
            .await;

            let prepared = tokio::select! {
                _ = cancel_token.cancelled() => {
                    return Err(("cancelled", "cancelled", "cancelled during worktree preparation".into()));
                }
                res = prepare_project_workspace(
                    &self.context,
                    project_id,
                    None,
                    strategy,
                    role.unwrap_or_else(|| format!("Delegation · {agent_id}")),
                ) => {
                    res.map_err(|err| ("failed", "worktree_prepare_failed", err.to_string()))?
                }
            };
            created_workspace_id = Some(prepared.workspace_id);

            if cancel_token.is_cancelled() {
                if prepared.created_worktree {
                    let _ = rollback_prepared_workspace(&self.context, prepared.workspace_id).await;
                }
                return Err(("cancelled", "cancelled", "cancelled after worktree creation".into()));
            }

            // Reassign the child session onto the newly created worktree workspace and task.
            let task_id = Workspace::find_by_id(pool, prepared.workspace_id)
                .await
                .ok()
                .flatten()
                .map(|ws| ws.task_id);
            let _ = Session::update_workspace(
                pool,
                child_conversation_id,
                prepared.workspace_id,
                task_id,
            )
            .await;

            let wt_str = prepared
                .worktree_path
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned());
            let _ = ConversationDelegationRecord::update_preparation(
                pool,
                run_id,
                "running",
                Some("ready"),
                Some(prepared.workspace_id),
                wt_str.as_deref(),
                prepared.branch.as_deref(),
            )
            .await;
            working_dir = Some(prepared.working_dir);
        }

        if cancel_token.is_cancelled() {
            if let Some(ws_id) = created_workspace_id {
                let _ = rollback_prepared_workspace(&self.context, ws_id).await;
            }
            return Err(("cancelled", "cancelled", "cancelled before agent bind".into()));
        }

        let service = ConversationSessionService::new(self.context.clone());
        service
            .ensure_session_controls_with_working_dir(child_conversation_id, working_dir)
            .await
            .map_err(|err| ("failed", "session_bind_failed", err.to_string()))?;

        let overrides = build_config_overrides(model, options);
        let mode_override = mode_limit.preferred_mode_id();

        service
            .start_delegated_turn(child_conversation_id, task, mode_override, overrides)
            .await
            .map_err(|err| ("failed", "turn_start_failed", err.to_string()))?;

        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_thread_phase2(
        &self,
        conversation_id: Uuid,
        target_project_id: Option<Uuid>,
        initial_working_dir: Option<PathBuf>,
        needs_async_worktree: bool,
        strategy: WorkspaceLaunchStrategy,
        title: Option<String>,
        agent_id: AgentId,
        mode_limit: OrchestrationModeLimit,
        model: Option<String>,
        options: BTreeMap<String, String>,
        message: Option<String>,
        cancel_token: CancellationToken,
    ) -> Result<(), String> {
        let pool = &self.context.deployment.db().pool;
        let mut working_dir = initial_working_dir;

        if needs_async_worktree {
            if cancel_token.is_cancelled() {
                return Err("cancelled".into());
            }
            let project_id = target_project_id.ok_or_else(|| "missing project".to_string())?;
            let prepared = tokio::select! {
                _ = cancel_token.cancelled() => return Err("cancelled".into()),
                res = prepare_project_workspace(
                    &self.context,
                    project_id,
                    None,
                    strategy,
                    title.unwrap_or_else(|| format!("Thread · {agent_id}")),
                ) => res.map_err(|err| err.to_string())?
            };
            if cancel_token.is_cancelled() {
                if prepared.created_worktree {
                    let _ = rollback_prepared_workspace(&self.context, prepared.workspace_id).await;
                }
                return Err("cancelled".into());
            }
            let task_id = Workspace::find_by_id(pool, prepared.workspace_id)
                .await
                .ok()
                .flatten()
                .map(|ws| ws.task_id);
            let _ =
                Session::update_workspace(pool, conversation_id, prepared.workspace_id, task_id)
                    .await;
            working_dir = Some(prepared.working_dir);
        }

        if cancel_token.is_cancelled() {
            return Err("cancelled".into());
        }

        if let Some(prompt) = message.filter(|m| !m.trim().is_empty()) {
            let service = ConversationSessionService::new(self.context.clone());
            service
                .ensure_session_controls_with_working_dir(conversation_id, working_dir)
                .await
                .map_err(|err| err.to_string())?;
            let overrides = build_config_overrides(model, options);
            let mode_override = mode_limit.preferred_mode_id();
            service
                .start_delegated_turn(conversation_id, prompt, mode_override, overrides)
                .await
                .map_err(|err| err.to_string())?;
        }
        Ok(())
    }
}

pub(crate) fn compose_message_with_attachments(
    message: Option<&str>,
    attachment_paths: &[String],
) -> Option<String> {
    let cleaned_paths: Vec<&str> = attachment_paths
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    let trimmed_msg = message.map(str::trim).filter(|m| !m.is_empty());
    match (trimmed_msg, cleaned_paths.is_empty()) {
        (None, true) => None,
        (Some(msg), true) => Some(msg.to_string()),
        (msg, false) => {
            let mut out = String::new();
            if let Some(body) = msg {
                out.push_str(body);
                out.push_str("\n\n");
            }
            out.push_str("[Attached files]\n");
            for path in cleaned_paths {
                out.push_str("- ");
                out.push_str(path);
                out.push('\n');
            }
            Some(out)
        }
    }
}

fn build_config_overrides(
    model: Option<String>,
    options: BTreeMap<String, String>,
) -> Vec<AgentSessionConfigOverride> {
    let mut overrides: Vec<AgentSessionConfigOverride> = options
        .into_iter()
        .map(|(key, value)| AgentSessionConfigOverride { key, value })
        .collect();
    if let Some(model_id) = model.filter(|m| !m.trim().is_empty())
        && !overrides.iter().any(|o| o.key == "model")
    {
        overrides.push(AgentSessionConfigOverride {
            key: "model".to_string(),
            value: model_id,
        });
    }
    overrides
}

async fn resolve_target_project(
    pool: &sqlx::SqlitePool,
    project_id: Option<Uuid>,
    scratch: bool,
) -> Result<Option<Project>, OrchestrationError> {
    if scratch {
        return Ok(None);
    }
    let Some(project_id) = project_id else {
        return Ok(None);
    };
    let project = Project::find_by_id(pool, project_id)
        .await
        .map_err(|err| OrchestrationError::Internal(err.to_string()))?
        .ok_or_else(|| OrchestrationError::NotFound(format!("project {project_id} not found")))?;
    Ok(Some(project))
}

/// Resolve the caller conversation's owning project ID, if any.
pub async fn resolve_conversation_project_id(
    pool: &sqlx::SqlitePool,
    conversation_id: Uuid,
) -> Option<Uuid> {
    let session = db::models::session::Session::find_by_id(pool, conversation_id)
        .await
        .ok()??;
    if session.workspace_id.is_nil() {
        return None;
    }
    let workspace = Workspace::find_by_id(pool, session.workspace_id)
        .await
        .ok()??;
    Some(workspace.project_id)
}
