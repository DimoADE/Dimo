//! Unified SQLite-backed OrchestrationService handling all 18 orchestration MCP
//! tools (`orchestrator_capabilities`, `environment_links`, `delegate_task`,
//! `task_*`, `thread_*`, `project_*`, `pending_request`) with Access Guard,
//! Mode Ceiling, deterministic `client_request_id` idempotency, quotas, and
//! cross-Host remote forwarding + shadow tracking.

use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};

use agents::{
    AgentEvent, AgentId, AgentPermissionOptionKind, AgentPermissionResponse, AgentRuntime,
    AgentSessionId, ids::AgentConnectionId,
};
use chrono::{Duration as ChronoDuration, Utc};
use conversations::{
    ConversationContext, ConversationSessionService, ForkVisibleConversation,
    ScopedConversationControl, WorkspaceLaunchStrategy, fork_visible_conversation,
    read_history_page, rollback_prepared_workspace,
};
use db::models::{
    conversation::{ConversationRecord, DbConversationSummary},
    conversation_delegation::{
        ConversationDelegationRecord, CreateConversationDelegation, McpIdempotencyReceipt,
    },
    project::{CreateProject, Project},
    project_repo::ProjectRepo,
    session::Session,
    workspace::Workspace,
};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::{
    ActivePreparations, ConversationLaunchService, McpInvocationContext, OrchestrationConfig,
    OrchestrationError, PendingPermissionStore, SharedRemoteForwarder, conversation_link,
    idempotency_scope_key,
    launch::{
        DelegationLaunchSpec, LaunchTargetSpec, ThreadLaunchSpec, agent_entry_is_launchable,
        resolve_conversation_project_id,
    },
    reactors::{
        RemoteDelegationWatchSpec, emit_parent_completion_event, maybe_schedule_parent_wakeup,
        spawn_remote_delegation_watcher, sync_remote_status_into_shadow,
    },
};
use crate::{
    mode_limit::{InteractionModeRank, OrchestrationModeLimit, RuntimeModeRank},
    steering::InMemoryCompanionFeatures,
};

pub struct OrchestrationService {
    pub context: ConversationContext,
    pub runtime: Arc<AgentRuntime>,
    pub launcher: ConversationLaunchService,
    pub config: Arc<RwLock<OrchestrationConfig>>,
    pub pending_permissions: PendingPermissionStore,
    pub companion_memory: Arc<InMemoryCompanionFeatures>,
    remote_forwarder: RwLock<Option<SharedRemoteForwarder>>,
    coalescing_parents: Arc<Mutex<HashSet<Uuid>>>,
    remote_poll_interval: Duration,
}

impl OrchestrationService {
    pub fn new(
        context: ConversationContext,
        runtime: Arc<AgentRuntime>,
        preparations: ActivePreparations,
        pending_permissions: PendingPermissionStore,
        companion_memory: Arc<InMemoryCompanionFeatures>,
        config: OrchestrationConfig,
    ) -> Self {
        let launcher =
            ConversationLaunchService::new(context.clone(), runtime.clone(), preparations);
        Self {
            context,
            runtime,
            launcher,
            config: Arc::new(RwLock::new(config)),
            pending_permissions,
            companion_memory,
            remote_forwarder: RwLock::new(None),
            coalescing_parents: Arc::new(Mutex::new(HashSet::new())),
            remote_poll_interval: Duration::from_secs(2),
        }
    }

    pub fn set_remote_forwarder(&self, forwarder: SharedRemoteForwarder) {
        *self.remote_forwarder.write().unwrap() = Some(forwarder);
    }

    pub fn update_config(&self, updater: impl FnOnce(&mut OrchestrationConfig)) {
        let mut guard = self.config.write().unwrap();
        updater(&mut guard);
    }

    pub fn config_snapshot(&self) -> OrchestrationConfig {
        self.config.read().unwrap().clone()
    }

    fn current_remote_forwarder(&self) -> Option<Arc<dyn super::RemoteMcpForwarder>> {
        self.remote_forwarder.read().unwrap().clone()
    }

    /// Unified guarded entry point for every orchestration MCP tool call.
    pub async fn call_tool(
        &self,
        ctx: &McpInvocationContext,
        name: &str,
        args: Value,
    ) -> Result<Value, OrchestrationError> {
        if !ctx.permissions.delegation && requires_delegation_permission(name) {
            return Err(OrchestrationError::Forbidden(format!(
                "tool '{name}' requires delegation permission"
            )));
        }

        // Cross-machine forwarding when a non-local `environment_id` is specified.
        let env_id = extract_environment_id(&args);
        if let Some(env_id) = env_id {
            let Some(forwarder) = self.current_remote_forwarder() else {
                return Err(OrchestrationError::Unavailable(format!(
                    "remote Host forwarding is not configured for environment_id '{env_id}'"
                )));
            };
            return match name {
                "delegate_task" => {
                    self.delegate_task_remote(ctx, &env_id, args, forwarder)
                        .await
                }
                "task_status" => self.task_status_remote(ctx, &env_id, args, forwarder).await,
                "task_cancel" => self.task_cancel_remote(ctx, &env_id, args, forwarder).await,
                _ => {
                    let mut result = forwarder
                        .forward_tool_call(&env_id, name, args, ctx.mode_limit)
                        .await?;
                    annotate_remote_links(&mut result, &env_id);
                    Ok(result)
                }
            };
        }

        match name {
            "orchestrator_capabilities" => self.orchestrator_capabilities(ctx, args).await,
            "environment_links" => self.environment_links(args).await,
            "delegate_task" => self.delegate_task(ctx, args).await,
            "task_status" => self.task_status(ctx, args).await,
            "task_cancel" => self.task_cancel(ctx, args).await,
            "thread_launch" => self.thread_launch(ctx, args).await,
            "create_threads" => self.create_threads(ctx, args).await,
            "thread_list" => self.thread_list(args).await,
            "thread_read" => self.thread_read(args).await,
            "thread_send" => self.thread_send(ctx, args).await,
            "thread_wait" => self.thread_wait(args).await,
            "thread_interrupt" => self.thread_interrupt(args).await,
            "thread_transfer" => self.thread_transfer(ctx, args).await,
            "project_list" => self.project_list(args).await,
            "project_read" => self.project_read(args).await,
            "project_create" => self.project_create(args).await,
            "project_clone" => self.project_clone(args).await,
            "pending_request" => self.pending_request(ctx, args).await,
            other => Err(OrchestrationError::BadRequest(format!(
                "unknown orchestration tool '{other}'"
            ))),
        }
    }

    async fn environment_links(&self, args: Value) -> Result<Value, OrchestrationError> {
        let query = str_field(&args, "query").map(|q| q.to_ascii_lowercase());
        let forwarder = self.current_remote_forwarder();
        let mut payload = match forwarder {
            Some(forwarder) => forwarder.list_environments().await?,
            None => json!({
                "local": { "environment_id": "local" },
                "environments": [],
            }),
        };
        if let Some(q) = query.as_deref()
            && let Some(envs) = payload
                .get_mut("environments")
                .and_then(Value::as_array_mut)
        {
            envs.retain(|entry| entry.to_string().to_ascii_lowercase().contains(q));
        }
        Ok(payload)
    }

    async fn orchestrator_capabilities(
        &self,
        ctx: &McpInvocationContext,
        args: Value,
    ) -> Result<Value, OrchestrationError> {
        let pool = &self.context.deployment.db().pool;
        let query = str_field(&args, "query").map(|q| q.to_ascii_lowercase());

        let catalog = conversations::collaboration::list_available_bot_agents(
            pool,
            ctx.caller_conversation_id,
            None,
        )
        .await
        .map_err(|e| OrchestrationError::Internal(e.to_string()))?;

        let raw_agents: Vec<Value> = catalog
            .get("agents")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|mut entry| {
                let launchable = agent_entry_is_launchable(&entry);
                if let Some(obj) = entry.as_object_mut() {
                    obj.insert("available_for_launch".to_string(), json!(launchable));
                }
                entry
            })
            .collect();

        let ready_agent_ids: Vec<String> = raw_agents
            .iter()
            .filter(|entry| {
                entry
                    .get("available_for_launch")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
            .filter_map(|entry| {
                entry
                    .get("agent_id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();

        let agents: Vec<Value> = match query.as_deref() {
            None => raw_agents,
            Some(q) => raw_agents
                .into_iter()
                .filter(|entry| entry.to_string().to_ascii_lowercase().contains(q))
                .collect(),
        };

        let config = self.config_snapshot();
        Ok(json!({
            "caller_agent_id": catalog.get("caller_agent_id").cloned().unwrap_or(Value::Null),
            "ready_agent_ids": ready_agent_ids,
            "agents": agents,
            "caller_mode_limit": {
                "max_runtime_mode": ctx.mode_limit.max_runtime_mode.as_str(),
                "max_interaction_mode": ctx.mode_limit.max_interaction_mode.as_str(),
            },
            "quotas": {
                "depth_limit": config.depth_limit,
                "max_active_children": config.max_active_children,
                "max_calls_per_parent": config.max_calls_per_parent,
                "child_deadline_ms": config.child_deadline_ms,
                "max_result_bytes": config.max_result_bytes,
            }
        }))
    }

    async fn delegate_task(
        &self,
        ctx: &McpInvocationContext,
        args: Value,
    ) -> Result<Value, OrchestrationError> {
        let pool = &self.context.deployment.db().pool;

        // Deterministic idempotency check.
        let idempotency_key = str_field(&args, "client_request_id").map(|req_id| {
            idempotency_scope_key(ctx.caller_conversation_id, "delegate_task", req_id)
        });
        if let Some(scope_key) = idempotency_key.as_deref()
            && let Some(receipt) = McpIdempotencyReceipt::find(pool, scope_key)
                .await
                .map_err(|e| OrchestrationError::Internal(e.to_string()))?
            && let Ok(cached) = serde_json::from_str::<Value>(&receipt.response_json)
        {
            return Ok(cached);
        }

        let task = str_field(&args, "task")
            .filter(|t| !t.trim().is_empty())
            .ok_or_else(|| OrchestrationError::BadRequest("task is required".into()))?
            .to_string();
        let target = args
            .get("target")
            .and_then(Value::as_object)
            .ok_or_else(|| OrchestrationError::BadRequest("target object is required".into()))?;
        let raw_agent_id = target
            .get("agent_id")
            .and_then(Value::as_str)
            .ok_or_else(|| OrchestrationError::BadRequest("target.agent_id is required".into()))?;
        let agent_id = AgentId::parse(raw_agent_id)
            .map_err(|e| OrchestrationError::BadRequest(format!("invalid agent_id: {e}")))?;

        // Enforce SQLite-backed quotas (depth, active children, total per parent).
        let config = self.config_snapshot();
        let caller_depth = compute_delegation_depth(pool, ctx.caller_conversation_id).await?;
        if caller_depth >= config.depth_limit {
            return Err(OrchestrationError::QuotaExceeded(format!(
                "delegation depth limit ({}) reached",
                config.depth_limit
            )));
        }
        let active =
            ConversationDelegationRecord::count_active_for_parent(pool, ctx.caller_conversation_id)
                .await
                .map_err(|e| OrchestrationError::Internal(e.to_string()))?;
        if active >= config.max_active_children {
            return Err(OrchestrationError::QuotaExceeded(format!(
                "max_active_children ({}) reached",
                config.max_active_children
            )));
        }
        let total =
            ConversationDelegationRecord::count_total_for_parent(pool, ctx.caller_conversation_id)
                .await
                .map_err(|e| OrchestrationError::Internal(e.to_string()))?;
        if total >= config.max_calls_per_parent {
            return Err(OrchestrationError::QuotaExceeded(format!(
                "max_calls_per_parent ({}) reached",
                config.max_calls_per_parent
            )));
        }

        // Enforce monotonic Mode Ceiling.
        let req_runtime = str_field(&args, "runtime_mode").and_then(RuntimeModeRank::parse_str);
        let req_interaction =
            str_field(&args, "interaction_mode").and_then(InteractionModeRank::parse_str);
        let effective_mode_limit = ctx.mode_limit.clamp(req_runtime, req_interaction);

        // Resolve target project (explicit target.project_id or caller's project).
        let explicit_project_id = target
            .get("project_id")
            .and_then(Value::as_str)
            .is_some_and(|raw| !raw.trim().is_empty());
        let caller_workspace_id = Session::find_by_id(pool, ctx.caller_conversation_id)
            .await
            .ok()
            .flatten()
            .map(|s| s.workspace_id);
        let target_project_id = match target.get("project_id").and_then(Value::as_str) {
            Some(raw) if !raw.trim().is_empty() => {
                Some(Uuid::parse_str(raw.trim()).map_err(|_| {
                    OrchestrationError::BadRequest("invalid target.project_id".into())
                })?)
            }
            _ => resolve_conversation_project_id(pool, ctx.caller_conversation_id).await,
        };

        let isolation = str_field(&args, "isolation")
            .unwrap_or("shared")
            .to_string();
        let workspace_strategy = match isolation.as_str() {
            "worktree" => {
                let wt = args.get("worktree").and_then(Value::as_object);
                WorkspaceLaunchStrategy::Worktree {
                    base_ref: wt
                        .and_then(|o| o.get("base_ref"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    branch: wt
                        .and_then(|o| o.get("branch"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    start_from_origin: wt
                        .and_then(|o| o.get("start_from_origin"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                }
            }
            "shared" => WorkspaceLaunchStrategy::Root,
            other => {
                return Err(OrchestrationError::BadRequest(format!(
                    "unsupported isolation '{other}'"
                )));
            }
        };

        let mode = match str_field(&args, "mode").unwrap_or("async") {
            "async" => "async",
            "wait" => "wait",
            other => {
                return Err(OrchestrationError::BadRequest(format!(
                    "unsupported mode '{other}'"
                )));
            }
        };
        let completion_wake = match str_field(&args, "completion_wake").unwrap_or("always") {
            "always" => "always",
            "settled_only" => "settled_only",
            other => {
                return Err(OrchestrationError::BadRequest(format!(
                    "unsupported completion_wake '{other}'"
                )));
            }
        };
        let timeout_ms = args
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(config.child_deadline_ms)
            .clamp(1_000, 86_400_000);

        let mut options = parse_string_map(target.get("options"));
        if let Some(defaults) = config.agent_defaults.get(agent_id.as_str()) {
            for (k, v) in &defaults.config_values {
                options.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }

        let run_id = format!("run_{}", Uuid::new_v4().simple());
        let launched = self
            .launcher
            .launch_delegation(DelegationLaunchSpec {
                run_id: run_id.clone(),
                parent_conversation_id: ctx.caller_conversation_id,
                parent_connection_id: ctx.caller_connection_id.clone(),
                parent_tool_use_id: ctx.parent_tool_use_id.clone(),
                caller_workspace_id,
                caller_working_root: ctx.working_root.clone(),
                explicit_project_id,
                role: str_field(&args, "role").map(str::to_string),
                task,
                isolation: isolation.clone(),
                mode: mode.to_string(),
                completion_wake: completion_wake.to_string(),
                deadline_ms: timeout_ms,
                target: LaunchTargetSpec {
                    agent_id,
                    provider_instance_id: target
                        .get("provider_instance_id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    model: target
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    options,
                    project_id: target_project_id,
                    scratch: false,
                    workspace_strategy,
                    effective_mode_limit,
                },
            })
            .await?;

        let response = if mode == "wait" {
            self.wait_for_delegation(&run_id, timeout_ms.min(60_000))
                .await?
        } else {
            json!({
                "run_id": launched.run_id,
                "child_conversation_id": launched.conversation_id,
                "project_id": launched.project_id,
                "workspace_id": launched.workspace_id,
                "link": launched.link,
                "status": launched.status,
                "branch": launched.branch,
                "worktree_path": launched.worktree_path,
                "effective_mode_limit": {
                    "runtime_mode": effective_mode_limit.max_runtime_mode.as_str(),
                    "interaction_mode": effective_mode_limit.max_interaction_mode.as_str(),
                },
                "next": "Wait for automatic completion delivery; do not poll task_status in a loop."
            })
        };

        if let Some(scope_key) = idempotency_key.as_deref()
            && let Ok(raw) = serde_json::to_string(&response)
        {
            let _ = McpIdempotencyReceipt::put(pool, scope_key, "delegate_task", &raw).await;
        }
        Ok(response)
    }

    async fn delegate_task_remote(
        &self,
        ctx: &McpInvocationContext,
        env_id: &str,
        args: Value,
        forwarder: SharedRemoteForwarder,
    ) -> Result<Value, OrchestrationError> {
        let pool = &self.context.deployment.db().pool;

        // Deterministic idempotency check on the local Host before forwarding.
        let idempotency_key = str_field(&args, "client_request_id").map(|req_id| {
            idempotency_scope_key(ctx.caller_conversation_id, "delegate_task", req_id)
        });
        if let Some(scope_key) = idempotency_key.as_deref()
            && let Some(receipt) = McpIdempotencyReceipt::find(pool, scope_key)
                .await
                .map_err(|e| OrchestrationError::Internal(e.to_string()))?
            && let Ok(cached) = serde_json::from_str::<Value>(&receipt.response_json)
        {
            return Ok(cached);
        }

        let task = str_field(&args, "task")
            .filter(|t| !t.trim().is_empty())
            .ok_or_else(|| OrchestrationError::BadRequest("task is required".into()))?
            .to_string();
        let target = args
            .get("target")
            .and_then(Value::as_object)
            .ok_or_else(|| OrchestrationError::BadRequest("target object is required".into()))?;
        let raw_agent_id = target
            .get("agent_id")
            .and_then(Value::as_str)
            .ok_or_else(|| OrchestrationError::BadRequest("target.agent_id is required".into()))?;
        let agent_id = AgentId::parse(raw_agent_id)
            .map_err(|e| OrchestrationError::BadRequest(format!("invalid agent_id: {e}")))?;

        // Enforce local parent quotas before dispatching to the remote Host.
        let config = self.config_snapshot();
        let caller_depth = compute_delegation_depth(pool, ctx.caller_conversation_id).await?;
        if caller_depth >= config.depth_limit {
            return Err(OrchestrationError::QuotaExceeded(format!(
                "delegation depth limit ({}) reached",
                config.depth_limit
            )));
        }
        let active =
            ConversationDelegationRecord::count_active_for_parent(pool, ctx.caller_conversation_id)
                .await
                .map_err(|e| OrchestrationError::Internal(e.to_string()))?;
        if active >= config.max_active_children {
            return Err(OrchestrationError::QuotaExceeded(format!(
                "max_active_children ({}) reached",
                config.max_active_children
            )));
        }
        let total =
            ConversationDelegationRecord::count_total_for_parent(pool, ctx.caller_conversation_id)
                .await
                .map_err(|e| OrchestrationError::Internal(e.to_string()))?;
        if total >= config.max_calls_per_parent {
            return Err(OrchestrationError::QuotaExceeded(format!(
                "max_calls_per_parent ({}) reached",
                config.max_calls_per_parent
            )));
        }

        let req_runtime = str_field(&args, "runtime_mode").and_then(RuntimeModeRank::parse_str);
        let req_interaction =
            str_field(&args, "interaction_mode").and_then(InteractionModeRank::parse_str);
        let effective_mode_limit = ctx.mode_limit.clamp(req_runtime, req_interaction);

        let isolation = str_field(&args, "isolation")
            .unwrap_or("shared")
            .to_string();
        let mode = match str_field(&args, "mode").unwrap_or("async") {
            "async" => "async",
            "wait" => "wait",
            other => {
                return Err(OrchestrationError::BadRequest(format!(
                    "unsupported mode '{other}'"
                )));
            }
        };
        let completion_wake = match str_field(&args, "completion_wake").unwrap_or("always") {
            "always" => "always",
            "settled_only" => "settled_only",
            other => {
                return Err(OrchestrationError::BadRequest(format!(
                    "unsupported completion_wake '{other}'"
                )));
            }
        };
        let timeout_ms = args
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(config.child_deadline_ms)
            .clamp(1_000, 86_400_000);
        let role = str_field(&args, "role").map(str::to_string);
        let provider_instance_id = target
            .get("provider_instance_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let model = target
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string);

        // Forward to the remote Host with the clamped monotonic mode ceiling.
        let mut remote_response = forwarder
            .forward_tool_call(env_id, "delegate_task", args, effective_mode_limit)
            .await?;

        let run_id = remote_response
            .get("run_id")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("run_{}", Uuid::new_v4().simple()));
        let child_conversation_id = remote_response
            .get("child_conversation_id")
            .and_then(Value::as_str)
            .and_then(|s| Uuid::parse_str(s).ok())
            .ok_or_else(|| {
                OrchestrationError::Internal(format!(
                    "remote host '{env_id}' returned invalid or missing child_conversation_id"
                ))
            })?;
        let remote_project_id = remote_response
            .get("project_id")
            .and_then(Value::as_str)
            .and_then(|s| Uuid::parse_str(s).ok());
        let remote_workspace_id = remote_response
            .get("workspace_id")
            .and_then(Value::as_str)
            .and_then(|s| Uuid::parse_str(s).ok());
        let remote_status = remote_response
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("running")
            .to_string();
        let remote_branch = remote_response
            .get("branch")
            .and_then(Value::as_str)
            .map(str::to_string);
        let remote_worktree_path = remote_response
            .get("worktree_path")
            .and_then(Value::as_str)
            .map(str::to_string);

        let task_preview: String = task.chars().take(240).collect();
        let deadline_at =
            Utc::now() + ChronoDuration::milliseconds(timeout_ms.min(86_400_000) as i64);

        // Persist a local shadow row so quotas, UI DelegationCards, `task_status`,
        // `task_cancel`, and automatic coalesced completion wakeups work seamlessly
        // across Hosts.
        ConversationDelegationRecord::create(
            pool,
            CreateConversationDelegation {
                run_id: &run_id,
                parent_conversation_id: ctx.caller_conversation_id,
                child_conversation_id,
                parent_tool_call_id: &ctx.parent_tool_use_id,
                target_project_id: remote_project_id,
                target_workspace_id: remote_workspace_id,
                target_environment_id: Some(env_id),
                agent_id: agent_id.as_str(),
                provider_instance_id: provider_instance_id.as_deref(),
                model: model.as_deref(),
                role: role.as_deref(),
                task_preview: &task_preview,
                isolation: &isolation,
                mode,
                completion_wake,
                max_runtime_mode: effective_mode_limit.max_runtime_mode.as_i64(),
                max_interaction_mode: effective_mode_limit.max_interaction_mode.as_i64(),
                status: &remote_status,
                preparation_stage: remote_response
                    .get("preparation_stage")
                    .and_then(Value::as_str),
                worktree_path: remote_worktree_path.as_deref(),
                branch: remote_branch.as_deref(),
                deadline_at: Some(deadline_at),
            },
        )
        .await
        .map_err(|e| OrchestrationError::Internal(e.to_string()))?;

        // Emit DelegationStarted on the local parent connection for UI cards.
        if let Ok(conn_uuid) = Uuid::parse_str(&ctx.caller_connection_id) {
            self.runtime
                .emit_external(
                    AgentConnectionId::from(conn_uuid),
                    Some(AgentSessionId::from(ctx.caller_conversation_id)),
                    AgentEvent::DelegationStarted {
                        delegation_id: run_id.clone(),
                        parent_tool_use_id: ctx.parent_tool_use_id.clone(),
                        child_session_id: child_conversation_id,
                        agent_id: agent_id.clone(),
                        task_preview,
                    },
                )
                .await;
        }

        if let Some(obj) = remote_response.as_object_mut() {
            obj.insert(
                "link".to_string(),
                json!(conversation_link(child_conversation_id, Some(env_id))),
            );
            obj.insert("environment_id".to_string(), json!(env_id));
        }

        if matches!(
            remote_status.as_str(),
            "completed" | "failed" | "cancelled" | "timed_out"
        ) {
            if let Some(finished) = sync_remote_status_into_shadow(
                pool,
                &run_id,
                &remote_response,
                config.max_result_bytes,
            )
            .await
            {
                let _ = ConversationDelegationRecord::mark_delivered(
                    pool,
                    std::slice::from_ref(&finished.run_id),
                )
                .await;
                emit_parent_completion_event(&self.runtime, &finished).await;
            }
        } else {
            let cancel_token = self
                .launcher
                .preparations
                .register(child_conversation_id)
                .await;
            spawn_remote_delegation_watcher(RemoteDelegationWatchSpec {
                context: self.context.clone(),
                runtime: self.runtime.clone(),
                preparations: self.launcher.preparations.clone(),
                forwarder,
                coalescing_parents: self.coalescing_parents.clone(),
                environment_id: env_id.to_string(),
                run_id: run_id.clone(),
                child_conversation_id,
                mode_limit: effective_mode_limit,
                deadline_at: Some(deadline_at),
                max_result_bytes: config.max_result_bytes,
                cancel_token,
                initial_poll_interval: self.remote_poll_interval,
            });
        }

        if let Some(scope_key) = idempotency_key.as_deref()
            && let Ok(raw) = serde_json::to_string(&remote_response)
        {
            let _ = McpIdempotencyReceipt::put(pool, scope_key, "delegate_task", &raw).await;
        }
        Ok(remote_response)
    }

    async fn task_status_remote(
        &self,
        ctx: &McpInvocationContext,
        env_id: &str,
        args: Value,
        forwarder: SharedRemoteForwarder,
    ) -> Result<Value, OrchestrationError> {
        let mut remote_payload = forwarder
            .forward_tool_call(env_id, "task_status", args, ctx.mode_limit)
            .await?;
        annotate_remote_links(&mut remote_payload, env_id);
        if let Some(obj) = remote_payload.as_object_mut() {
            obj.insert("environment_id".to_string(), json!(env_id));
        }

        // Sync terminal state back into any matching local shadow row.
        if let Some(run_id) = remote_payload.get("run_id").and_then(Value::as_str) {
            let pool = &self.context.deployment.db().pool;
            if let Ok(Some(local)) =
                ConversationDelegationRecord::find_by_run_id(pool, run_id).await
                && !local.is_terminal()
            {
                let config = self.config_snapshot();
                if let Some(finished) = sync_remote_status_into_shadow(
                    pool,
                    run_id,
                    &remote_payload,
                    config.max_result_bytes,
                )
                .await
                {
                    self.launcher
                        .preparations
                        .cancel(finished.child_conversation_id)
                        .await;
                    emit_parent_completion_event(&self.runtime, &finished).await;
                    maybe_schedule_parent_wakeup(
                        self.context.clone(),
                        self.coalescing_parents.clone(),
                        &finished,
                    )
                    .await;
                }
            }
        }
        Ok(remote_payload)
    }

    async fn task_cancel_remote(
        &self,
        ctx: &McpInvocationContext,
        env_id: &str,
        args: Value,
        forwarder: SharedRemoteForwarder,
    ) -> Result<Value, OrchestrationError> {
        let reason = str_field(&args, "reason")
            .unwrap_or("cancelled by parent via task_cancel")
            .to_string();
        let mut remote_payload = forwarder
            .forward_tool_call(env_id, "task_cancel", args.clone(), ctx.mode_limit)
            .await?;
        annotate_remote_links(&mut remote_payload, env_id);
        if let Some(obj) = remote_payload.as_object_mut() {
            obj.insert("environment_id".to_string(), json!(env_id));
        }

        // Also mark any matching local shadow row cancelled and stop its watcher.
        let pool = &self.context.deployment.db().pool;
        let shadow = if let Some(run_id) = remote_payload
            .get("run_id")
            .and_then(Value::as_str)
            .or_else(|| str_field(&args, "run_id"))
        {
            ConversationDelegationRecord::find_by_run_id(pool, run_id)
                .await
                .ok()
                .flatten()
        } else if let Some(child_id) =
            str_field(&args, "child_conversation_id").and_then(|s| Uuid::parse_str(s).ok())
        {
            ConversationDelegationRecord::find_by_child_conversation(pool, child_id)
                .await
                .ok()
                .flatten()
        } else {
            None
        };
        if let Some(record) = shadow {
            self.launcher
                .preparations
                .cancel(record.child_conversation_id)
                .await;
            let updated = ConversationDelegationRecord::finish(
                pool,
                &record.run_id,
                "cancelled",
                None,
                Some("cancelled"),
                Some(&reason),
            )
            .await
            .ok()
            .flatten()
            .unwrap_or(record);
            let _ = ConversationDelegationRecord::mark_delivered(
                pool,
                std::slice::from_ref(&updated.run_id),
            )
            .await;
            emit_parent_completion_event(&self.runtime, &updated).await;
        }
        Ok(remote_payload)
    }

    async fn wait_for_delegation(
        &self,
        run_id: &str,
        wait_ms: u64,
    ) -> Result<Value, OrchestrationError> {
        let pool = &self.context.deployment.db().pool;
        let deadline = Instant::now() + Duration::from_millis(wait_ms);
        loop {
            let record = ConversationDelegationRecord::find_by_run_id(pool, run_id)
                .await
                .map_err(|e| OrchestrationError::Internal(e.to_string()))?
                .ok_or_else(|| OrchestrationError::NotFound(format!("run '{run_id}' not found")))?;
            if record.is_terminal()
                || record.status == "waiting_for_input"
                || Instant::now() >= deadline
            {
                return Ok(self.serialize_delegation_record(&record).await);
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }

    async fn task_status(
        &self,
        ctx: &McpInvocationContext,
        args: Value,
    ) -> Result<Value, OrchestrationError> {
        let record = self.find_delegation_by_args(&args).await?;
        // Transparently query the remote Host when inspecting a non-terminal
        // cross-Host shadow row without explicitly repeating `environment_id`.
        if let Some(ref remote_env) = record.target_environment_id
            && !record.is_terminal()
            && let Some(forwarder) = self.current_remote_forwarder()
            && let Ok(remote_payload) = self
                .task_status_remote(
                    ctx,
                    remote_env,
                    json!({ "run_id": record.run_id }),
                    forwarder,
                )
                .await
        {
            return Ok(remote_payload);
        }
        Ok(self.serialize_delegation_record(&record).await)
    }

    async fn task_cancel(
        &self,
        ctx: &McpInvocationContext,
        args: Value,
    ) -> Result<Value, OrchestrationError> {
        let pool = &self.context.deployment.db().pool;
        let record = self.find_delegation_by_args(&args).await?;
        let reason = str_field(&args, "reason")
            .unwrap_or("cancelled by parent via task_cancel")
            .to_string();

        self.launcher
            .preparations
            .cancel(record.child_conversation_id)
            .await;

        if let Some(ref remote_env) = record.target_environment_id {
            // Forward cancellation to the remote Host when cancelling a shadow row.
            if let Some(forwarder) = self.current_remote_forwarder() {
                let _ = forwarder
                    .forward_tool_call(
                        remote_env,
                        "task_cancel",
                        json!({
                            "run_id": record.run_id,
                            "reason": reason,
                        }),
                        ctx.mode_limit,
                    )
                    .await;
            }
        } else {
            if record.status == "preparing"
                && let Some(ws_id) = record.target_workspace_id
            {
                let _ = rollback_prepared_workspace(&self.context, ws_id).await;
            }
            let service = ConversationSessionService::new(self.context.clone());
            let _ = service
                .cancel_turn(record.child_conversation_id, Some(reason.clone()))
                .await;
        }

        let updated = ConversationDelegationRecord::finish(
            pool,
            &record.run_id,
            "cancelled",
            None,
            Some("cancelled"),
            Some(&reason),
        )
        .await
        .map_err(|e| OrchestrationError::Internal(e.to_string()))?
        .unwrap_or(record);

        // Explicit cancellation must update UI cards immediately and never
        // spuriously re-deliver as an async completion wakeup later.
        let _ = ConversationDelegationRecord::mark_delivered(
            pool,
            std::slice::from_ref(&updated.run_id),
        )
        .await;
        emit_parent_completion_event(&self.runtime, &updated).await;

        Ok(self.serialize_delegation_record(&updated).await)
    }

    async fn thread_launch(
        &self,
        ctx: &McpInvocationContext,
        args: Value,
    ) -> Result<Value, OrchestrationError> {
        let pool = &self.context.deployment.db().pool;
        let idempotency_key = str_field(&args, "client_request_id").map(|req_id| {
            idempotency_scope_key(ctx.caller_conversation_id, "thread_launch", req_id)
        });
        if let Some(scope_key) = idempotency_key.as_deref()
            && let Some(receipt) = McpIdempotencyReceipt::find(pool, scope_key)
                .await
                .map_err(|e| OrchestrationError::Internal(e.to_string()))?
            && let Ok(cached) = serde_json::from_str::<Value>(&receipt.response_json)
        {
            return Ok(cached);
        }

        let scratch = args
            .get("scratch")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let project_id = match str_field(&args, "project_id") {
            Some(raw) => Some(
                Uuid::parse_str(raw)
                    .map_err(|_| OrchestrationError::BadRequest("invalid project_id".into()))?,
            ),
            None if scratch => None,
            None => resolve_conversation_project_id(pool, ctx.caller_conversation_id).await,
        };
        if !scratch && project_id.is_none() {
            return Err(OrchestrationError::BadRequest(
                "project_id is required unless scratch=true".into(),
            ));
        }

        let target = args
            .get("target")
            .and_then(Value::as_object)
            .ok_or_else(|| OrchestrationError::BadRequest("target object is required".into()))?;
        let raw_agent_id = target
            .get("agent_id")
            .and_then(Value::as_str)
            .ok_or_else(|| OrchestrationError::BadRequest("target.agent_id is required".into()))?;
        let agent_id = AgentId::parse(raw_agent_id)
            .map_err(|e| OrchestrationError::BadRequest(format!("invalid agent_id: {e}")))?;

        let workspace_strategy = parse_workspace_strategy(args.get("workspace_strategy"))?;
        let req_runtime = str_field(&args, "runtime_mode").and_then(RuntimeModeRank::parse_str);
        let req_interaction =
            str_field(&args, "interaction_mode").and_then(InteractionModeRank::parse_str);
        let effective_mode_limit = ctx.mode_limit.clamp(req_runtime, req_interaction);
        let attachment_paths: Vec<String> = args
            .get("attachment_paths")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();

        let launched = self
            .launcher
            .launch_top_level_thread(ThreadLaunchSpec {
                caller_conversation_id: ctx.caller_conversation_id,
                title: str_field(&args, "title").map(str::to_string),
                message: str_field(&args, "message").map(str::to_string),
                attachment_paths,
                target: LaunchTargetSpec {
                    agent_id,
                    provider_instance_id: target
                        .get("provider_instance_id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    model: target
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    options: parse_string_map(target.get("options")),
                    project_id,
                    scratch,
                    workspace_strategy,
                    effective_mode_limit,
                },
            })
            .await?;

        let response = json!({
            "conversation_id": launched.conversation_id,
            "project_id": launched.project_id,
            "workspace_id": launched.workspace_id,
            "link": launched.link,
            "status": launched.status,
            "branch": launched.branch,
            "worktree_path": launched.worktree_path,
            "effective_mode_limit": {
                "runtime_mode": effective_mode_limit.max_runtime_mode.as_str(),
                "interaction_mode": effective_mode_limit.max_interaction_mode.as_str(),
            },
        });

        if let Some(scope_key) = idempotency_key.as_deref()
            && let Ok(raw) = serde_json::to_string(&response)
        {
            let _ = McpIdempotencyReceipt::put(pool, scope_key, "thread_launch", &raw).await;
        }
        Ok(response)
    }

    async fn create_threads(
        &self,
        ctx: &McpInvocationContext,
        args: Value,
    ) -> Result<Value, OrchestrationError> {
        let items = args
            .get("threads")
            .and_then(Value::as_array)
            .ok_or_else(|| OrchestrationError::BadRequest("threads array is required".into()))?;
        if items.is_empty() || items.len() > 16 {
            return Err(OrchestrationError::BadRequest(
                "threads must contain between 1 and 16 entries".into(),
            ));
        }
        let mut results = Vec::with_capacity(items.len());
        for (index, item) in items.iter().enumerate() {
            match self.thread_launch(ctx, item.clone()).await {
                Ok(launched) => results.push(json!({
                    "index": index,
                    "ok": true,
                    "thread": launched,
                })),
                Err(error) => results.push(json!({
                    "index": index,
                    "ok": false,
                    "error": {
                        "code": error.code(),
                        "message": error.to_string(),
                    }
                })),
            }
        }
        Ok(json!({ "results": results }))
    }

    async fn thread_list(&self, args: Value) -> Result<Value, OrchestrationError> {
        let pool = &self.context.deployment.db().pool;
        let limit = args
            .get("limit")
            .and_then(Value::as_i64)
            .unwrap_or(30)
            .clamp(1, 100);
        let project_filter = str_field(&args, "project_id").and_then(|s| Uuid::parse_str(s).ok());
        let parent_filter =
            str_field(&args, "parent_conversation_id").and_then(|s| Uuid::parse_str(s).ok());
        let status_filter = str_field(&args, "status").map(str::to_ascii_lowercase);
        let query_filter = str_field(&args, "query").map(str::to_ascii_lowercase);

        let sessions: Vec<Session> = sqlx::query_as(
            r#"SELECT s.* FROM sessions s
               LEFT JOIN workspaces w ON w.id = s.workspace_id
               WHERE s.deleted_at IS NULL
                 AND (?1 IS NULL OR w.project_id = ?1)
                 AND (?2 IS NULL OR s.parent_session_id = ?2)
               ORDER BY s.updated_at DESC
               LIMIT ?3"#,
        )
        .bind(project_filter)
        .bind(parent_filter)
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(|e| OrchestrationError::Internal(e.to_string()))?;

        let mut threads = Vec::new();
        for session in sessions {
            let status_str = format!("{:?}", session.status).to_ascii_lowercase();
            if let Some(ref wanted) = status_filter
                && !status_str.contains(wanted)
            {
                continue;
            }
            if let Some(ref q) = query_filter {
                let title = session.name.as_deref().unwrap_or("").to_ascii_lowercase();
                if !title.contains(q) && !session.id.to_string().contains(q) {
                    continue;
                }
            }
            threads.push(json!({
                "conversation_id": session.id,
                "link": conversation_link(session.id, None),
                "workspace_id": session.workspace_id,
                "parent_conversation_id": session.parent_session_id,
                "agent_id": session.agent_id,
                "title": session.name,
                "status": session.status,
                "created_at": session.created_at,
                "updated_at": session.updated_at,
            }));
        }
        Ok(json!({ "threads": threads }))
    }

    async fn thread_read(&self, args: Value) -> Result<Value, OrchestrationError> {
        let pool = &self.context.deployment.db().pool;
        let conversation_id = parse_required_uuid(&args, "conversation_id")?;
        let summary = DbConversationSummary::find_by_id(pool, conversation_id)
            .await
            .map_err(|e| OrchestrationError::Internal(e.to_string()))?
            .ok_or_else(|| {
                OrchestrationError::NotFound(format!("conversation {conversation_id} not found"))
            })?;

        let max_chars = args
            .get("max_chars")
            .and_then(Value::as_u64)
            .unwrap_or(16_000)
            .clamp(256, 65_536) as usize;
        let history = read_history_page(
            pool,
            conversation_id,
            &delegation_proto::SessionHistoryRequest {
                item_id: None,
                after_item_id: None,
                text_offset: None,
                max_chars: Some(max_chars),
                history_revision: None,
                item_ids: Vec::new(),
            },
        )
        .await
        .ok();

        let workspace = if summary.workspace_id.is_nil() {
            None
        } else {
            Workspace::find_by_id(pool, summary.workspace_id)
                .await
                .ok()
                .flatten()
        };
        let delegation =
            ConversationDelegationRecord::find_by_child_conversation(pool, conversation_id)
                .await
                .ok()
                .flatten();
        let children = ConversationDelegationRecord::list_for_parent(pool, conversation_id)
            .await
            .unwrap_or_default();
        let pending = self.pending_permissions.list_entries(conversation_id).await;
        let pending_questions = self
            .companion_memory
            .list_pending_questions(conversation_id)
            .await;

        Ok(json!({
            "conversation_id": conversation_id,
            "link": conversation_link(conversation_id, None),
            "title": summary.title,
            "agent_id": summary.agent_id,
            "workspace_id": summary.workspace_id,
            "project_id": workspace.as_ref().map(|w| w.project_id),
            "branch": workspace.as_ref().map(|w| &w.branch),
            "worktree_path": workspace.as_ref().and_then(|w| w.container_ref.as_deref()),
            "delegation": delegation,
            "children": children,
            "pending_requests": pending,
            "pending_questions": pending_questions,
            "history": history,
        }))
    }

    async fn thread_send(
        &self,
        ctx: &McpInvocationContext,
        args: Value,
    ) -> Result<Value, OrchestrationError> {
        let pool = &self.context.deployment.db().pool;
        let conversation_id = parse_required_uuid(&args, "conversation_id")?;
        let message = str_field(&args, "message")
            .filter(|m| !m.trim().is_empty())
            .ok_or_else(|| OrchestrationError::BadRequest("message is required".into()))?;

        // Protect delegated children from misuse (parity with T3Code orchestration rule).
        if let Some(delegation) =
            ConversationDelegationRecord::find_by_child_conversation(pool, conversation_id)
                .await
                .map_err(|e| OrchestrationError::Internal(e.to_string()))?
            && !delegation.is_terminal()
        {
            return Err(OrchestrationError::Conflict(
                "cannot thread_send to an active delegated child; use pending_request or launch a new delegate_task"
                    .into(),
            ));
        }

        let op_id = str_field(&args, "client_request_id")
            .and_then(|s| Uuid::parse_str(s).ok())
            .unwrap_or_else(Uuid::new_v4);
        let control = ScopedConversationControl::new(self.context.clone());
        let mode = str_field(&args, "mode").unwrap_or("enqueue");
        if mode == "steer"
            && let Ok(Some(conv)) = ConversationRecord::find_by_id(pool, conversation_id).await
            && let Some(active_turn_id) = conv.active_turn_id
            && let Ok(receipt) = control
                .steer_authorized(
                    conversation_id,
                    op_id,
                    active_turn_id,
                    message,
                    json!({
                        "kind": "orchestration",
                        "caller_conversation_id": ctx.caller_conversation_id,
                    }),
                )
                .await
        {
            return Ok(json!({
                "conversation_id": conversation_id,
                "link": conversation_link(conversation_id, None),
                "steered": true,
                "steering_id": receipt.steering_id,
                "turn_id": active_turn_id,
                "status": format!("{:?}", receipt.status),
            }));
        }

        let submission = control
            .submit_text(
                conversation_id,
                &conversation_id.to_string(),
                &op_id.to_string(),
                message,
            )
            .await
            .map_err(|e| OrchestrationError::Internal(e.to_string()))?;
        Ok(json!({
            "conversation_id": conversation_id,
            "link": conversation_link(conversation_id, None),
            "steered": false,
            "input_id": submission.input.id,
            "turn_id": submission.turn.as_ref().map(|t| t.turn_id),
            "status": format!("{:?}", submission.input.status),
        }))
    }

    async fn thread_wait(&self, args: Value) -> Result<Value, OrchestrationError> {
        let ids: Vec<Uuid> = args
            .get("conversation_ids")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                OrchestrationError::BadRequest("conversation_ids array is required".into())
            })?
            .iter()
            .filter_map(|v| v.as_str().and_then(|s| Uuid::parse_str(s).ok()))
            .collect();
        if ids.is_empty() {
            return Err(OrchestrationError::BadRequest(
                "at least one valid conversation_id is required".into(),
            ));
        }
        let timeout_ms = args
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(30_000)
            .clamp(100, 60_000);
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let control = ScopedConversationControl::new(self.context.clone());

        loop {
            let mut snapshots = Vec::with_capacity(ids.len());
            let mut any_ready = false;
            for &id in &ids {
                let pending = self.pending_permissions.list_entries(id).await;
                let pending_questions = self.companion_memory.list_pending_questions(id).await;
                let wait = control.wait(id, &id.to_string(), None, None).await.ok();
                let ready = !pending.is_empty()
                    || !pending_questions.is_empty()
                    || wait.as_ref().is_some_and(|w| w.ready);
                if ready {
                    any_ready = true;
                }
                snapshots.push(json!({
                    "conversation_id": id,
                    "link": conversation_link(id, None),
                    "ready": ready,
                    "turn_status": wait.as_ref().and_then(|w| w.turn_status.clone()),
                    "pending_requests": pending,
                    "pending_questions": pending_questions,
                }));
            }
            if any_ready || Instant::now() >= deadline {
                return Ok(json!({
                    "timed_out": !any_ready,
                    "threads": snapshots,
                }));
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }

    async fn thread_interrupt(&self, args: Value) -> Result<Value, OrchestrationError> {
        let conversation_id = parse_required_uuid(&args, "conversation_id")?;
        let reason = str_field(&args, "reason")
            .unwrap_or("interrupted via thread_interrupt")
            .to_string();
        self.launcher.preparations.cancel(conversation_id).await;
        let service = ConversationSessionService::new(self.context.clone());
        service
            .cancel_turn(conversation_id, Some(reason))
            .await
            .map_err(|e| OrchestrationError::Internal(e.to_string()))?;
        Ok(json!({
            "conversation_id": conversation_id,
            "link": conversation_link(conversation_id, None),
            "interrupted": true,
        }))
    }

    async fn thread_transfer(
        &self,
        _ctx: &McpInvocationContext,
        args: Value,
    ) -> Result<Value, OrchestrationError> {
        let pool = &self.context.deployment.db().pool;
        let action = str_field(&args, "action")
            .ok_or_else(|| OrchestrationError::BadRequest("action is required".into()))?;
        let source_id = parse_required_uuid(&args, "source_conversation_id")?;

        match action {
            "fork" => {
                let target_agent_id = match str_field(&args, "agent_id") {
                    Some(raw) => Some(
                        AgentId::parse(raw)
                            .map_err(|e| OrchestrationError::BadRequest(e.to_string()))?,
                    ),
                    None => None,
                };
                let (forked_id, copied_turns) = fork_visible_conversation(
                    pool,
                    ForkVisibleConversation {
                        source_id,
                        until_turn_id: None,
                        target_agent_id,
                        target_provider_instance_id: str_field(&args, "provider_instance_id")
                            .map(str::to_string),
                    },
                )
                .await
                .map_err(|e| OrchestrationError::Internal(e.to_string()))?;
                Ok(json!({
                    "action": "fork",
                    "source_conversation_id": source_id,
                    "conversation_id": forked_id,
                    "copied_turns": copied_turns,
                    "link": conversation_link(forked_id, None),
                }))
            }
            "merge_back" => {
                let target_id = parse_required_uuid(&args, "target_conversation_id")?;
                let summary = match str_field(&args, "summary") {
                    Some(text) if !text.trim().is_empty() => text.to_string(),
                    _ => {
                        let page = read_history_page(
                            pool,
                            source_id,
                            &delegation_proto::SessionHistoryRequest {
                                item_id: None,
                                after_item_id: None,
                                text_offset: None,
                                max_chars: Some(8_000),
                                history_revision: None,
                                item_ids: Vec::new(),
                            },
                        )
                        .await
                        .map_err(|e| OrchestrationError::Internal(e.to_string()))?;
                        page.items
                            .last()
                            .map(|item| item.text.clone())
                            .unwrap_or_else(|| "(empty source conversation)".to_string())
                    }
                };
                let payload = format!(
                    "[Merged summary from {}]\n\n{}",
                    conversation_link(source_id, None),
                    summary
                );
                let control = ScopedConversationControl::new(self.context.clone());
                let sub = control
                    .submit_text(
                        target_id,
                        &target_id.to_string(),
                        &Uuid::new_v4().to_string(),
                        &payload,
                    )
                    .await
                    .map_err(|e| OrchestrationError::Internal(e.to_string()))?;
                Ok(json!({
                    "action": "merge_back",
                    "source_conversation_id": source_id,
                    "target_conversation_id": target_id,
                    "target_link": conversation_link(target_id, None),
                    "input_id": sub.input.id,
                }))
            }
            other => Err(OrchestrationError::BadRequest(format!(
                "unsupported thread_transfer action '{other}'"
            ))),
        }
    }

    async fn project_list(&self, args: Value) -> Result<Value, OrchestrationError> {
        let pool = &self.context.deployment.db().pool;
        let query = str_field(&args, "query").map(str::to_ascii_lowercase);
        let projects = Project::find_all(pool)
            .await
            .map_err(|e| OrchestrationError::Internal(e.to_string()))?;
        let filtered: Vec<Value> = projects
            .into_iter()
            .filter(|p| {
                query.as_deref().is_none_or(|q| {
                    p.name.to_ascii_lowercase().contains(q)
                        || p.root_path.to_ascii_lowercase().contains(q)
                })
            })
            .map(|p| {
                json!({
                    "project_id": p.id,
                    "name": p.name,
                    "root_path": p.root_path,
                    "is_git": p.is_git,
                    "default_main_branch": p.default_main_branch,
                })
            })
            .collect();
        Ok(json!({ "projects": filtered }))
    }

    async fn project_read(&self, args: Value) -> Result<Value, OrchestrationError> {
        let pool = &self.context.deployment.db().pool;
        let project_id = parse_required_uuid(&args, "project_id")?;
        let project = Project::find_by_id(pool, project_id)
            .await
            .map_err(|e| OrchestrationError::Internal(e.to_string()))?
            .ok_or_else(|| {
                OrchestrationError::NotFound(format!("project {project_id} not found"))
            })?;
        let repos = ProjectRepo::find_repos_for_project(pool, project_id)
            .await
            .unwrap_or_default();
        let workspaces = Workspace::fetch_by_project_id(pool, project_id)
            .await
            .unwrap_or_default();
        Ok(json!({
            "project_id": project.id,
            "name": project.name,
            "root_path": project.root_path,
            "is_git": project.is_git,
            "default_main_branch": project.default_main_branch,
            "repos": repos.into_iter().map(|r| json!({
                "id": r.id,
                "name": r.name,
                "path": r.path,
                "setup_script": r.setup_script,
            })).collect::<Vec<_>>(),
            "workspaces": workspaces.into_iter().map(|w| json!({
                "workspace_id": w.id,
                "branch": w.branch,
                "use_worktree": w.use_worktree,
                "container_ref": w.container_ref,
                "archived": w.archived,
            })).collect::<Vec<_>>(),
        }))
    }

    async fn project_create(&self, args: Value) -> Result<Value, OrchestrationError> {
        let pool = &self.context.deployment.db().pool;
        let raw_path = str_field(&args, "root_path")
            .ok_or_else(|| OrchestrationError::BadRequest("root_path is required".into()))?;
        let path = PathBuf::from(raw_path);
        if !path.is_dir() {
            return Err(OrchestrationError::BadRequest(format!(
                "directory '{}' does not exist",
                path.display()
            )));
        }
        let canonical = tokio::fs::canonicalize(&path).await.unwrap_or(path);
        let root_str = canonical.to_string_lossy().into_owned();
        if let Some(existing) = Project::find_any_by_root_path(pool, &root_str)
            .await
            .map_err(|e| OrchestrationError::Internal(e.to_string()))?
        {
            return Ok(json!({
                "project_id": existing.id,
                "name": existing.name,
                "root_path": existing.root_path,
                "existing": true,
            }));
        }
        let name = str_field(&args, "name")
            .map(str::to_string)
            .or_else(|| {
                canonical
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "project".to_string());
        let project_id = Uuid::new_v4();
        let created = Project::create(
            pool,
            &CreateProject {
                name: name.clone(),
                root_path: root_str.clone(),
                parent_project_id: None,
                repositories: Vec::new(),
            },
            project_id,
        )
        .await
        .map_err(|e| OrchestrationError::Internal(e.to_string()))?;

        // Attach git repo automatically if `.git` is present.
        if canonical.join(".git").exists() {
            let _ = ProjectRepo::add_repo_to_project(pool, project_id, &root_str, &name).await;
        }
        if let Some(branch) = str_field(&args, "default_main_branch") {
            let _ = Project::update(
                pool,
                project_id,
                &db::models::project::UpdateProject {
                    name: None,
                    default_main_branch: Some(branch.to_string()),
                },
            )
            .await;
        }
        Ok(json!({
            "project_id": created.id,
            "name": created.name,
            "root_path": created.root_path,
            "existing": false,
        }))
    }

    async fn project_clone(&self, args: Value) -> Result<Value, OrchestrationError> {
        let repo_url = str_field(&args, "repo_url")
            .ok_or_else(|| OrchestrationError::BadRequest("repo_url is required".into()))?;
        let dest = str_field(&args, "destination_path")
            .ok_or_else(|| OrchestrationError::BadRequest("destination_path is required".into()))?;
        let mut cmd = tokio::process::Command::new("git");
        cmd.arg("clone");
        if let Some(branch) = str_field(&args, "branch") {
            cmd.args(["--branch", branch]);
        }
        cmd.arg(repo_url).arg(dest);
        let output = cmd
            .output()
            .await
            .map_err(|e| OrchestrationError::Internal(format!("git clone failed: {e}")))?;
        if !output.status.success() {
            return Err(OrchestrationError::BadRequest(format!(
                "git clone failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        self.project_create(json!({
            "root_path": dest,
            "name": args.get("name"),
            "default_main_branch": args.get("branch"),
        }))
        .await
    }

    async fn pending_request(
        &self,
        ctx: &McpInvocationContext,
        args: Value,
    ) -> Result<Value, OrchestrationError> {
        let action = str_field(&args, "action")
            .ok_or_else(|| OrchestrationError::BadRequest("action is required".into()))?;
        let conversation_id = parse_required_uuid(&args, "conversation_id")?;

        match action {
            "read" => {
                let permissions = self.pending_permissions.list_entries(conversation_id).await;
                let questions = self
                    .companion_memory
                    .list_pending_questions(conversation_id)
                    .await;
                Ok(json!({
                    "conversation_id": conversation_id,
                    "link": conversation_link(conversation_id, None),
                    "permissions": permissions,
                    "questions": questions,
                }))
            }
            "respond" => {
                let request_id = str_field(&args, "request_id").ok_or_else(|| {
                    OrchestrationError::BadRequest("request_id is required for respond".into())
                })?;

                // First check if this is a pending `ask_user_question`.
                if let Some(answers) = args.get("answers")
                    && self
                        .companion_memory
                        .answer_question(request_id, conversation_id, answers.clone())
                        .await
                        .is_ok()
                {
                    let _ = ConversationDelegationRecord::resume_running(
                        &self.context.deployment.db().pool,
                        conversation_id,
                    )
                    .await;
                    return Ok(json!({
                        "conversation_id": conversation_id,
                        "request_id": request_id,
                        "resolved": true,
                        "kind": "question",
                    }));
                }

                // Otherwise handle a pending AgentPermissionRequest.
                let decision = str_field(&args, "decision").unwrap_or("escalate");
                let requesting_approval = matches!(decision, "allow_once" | "allow_always")
                    || args.get("option_id").is_some();

                // Mode Ceiling guard: parent cannot auto-approve beyond its own mode limit.
                if decision == "escalate"
                    || (requesting_approval && !ctx.mode_limit.allows_auto_approval())
                {
                    return Ok(json!({
                        "conversation_id": conversation_id,
                        "request_id": request_id,
                        "resolved": false,
                        "escalated_to_user": true,
                        "reason": if decision == "escalate" {
                            "explicitly escalated to user"
                        } else {
                            "caller mode_limit does not allow auto-approving permission requests; escalated to human UI"
                        },
                    }));
                }

                let req = self
                    .pending_permissions
                    .find_request(conversation_id, request_id)
                    .await
                    .ok_or_else(|| {
                        OrchestrationError::NotFound(format!(
                            "pending permission '{request_id}' not found on conversation {conversation_id}"
                        ))
                    })?;

                let option_id = if let Some(explicit) = str_field(&args, "option_id") {
                    Some(explicit.to_string())
                } else {
                    let wanted_kind = match decision {
                        "allow_once" => AgentPermissionOptionKind::AllowOnce,
                        "allow_always" => AgentPermissionOptionKind::AllowAlways,
                        "reject_once" => AgentPermissionOptionKind::RejectOnce,
                        "reject_always" => AgentPermissionOptionKind::RejectAlways,
                        other => {
                            return Err(OrchestrationError::BadRequest(format!(
                                "invalid decision '{other}'"
                            )));
                        }
                    };
                    req.options
                        .iter()
                        .find(|opt| opt.kind == wanted_kind)
                        .map(|opt| opt.id.clone())
                };

                let response = match option_id {
                    Some(option_id) => AgentPermissionResponse::selected(option_id),
                    None => AgentPermissionResponse::Cancelled,
                };
                let service = ConversationSessionService::new(self.context.clone());
                service
                    .respond_permission(conversation_id, request_id.to_string(), response)
                    .await
                    .map_err(|e| OrchestrationError::Internal(e.to_string()))?;
                self.pending_permissions
                    .remove(conversation_id, request_id)
                    .await;
                let _ = ConversationDelegationRecord::resume_running(
                    &self.context.deployment.db().pool,
                    conversation_id,
                )
                .await;

                Ok(json!({
                    "conversation_id": conversation_id,
                    "request_id": request_id,
                    "resolved": true,
                    "kind": "permission",
                    "decision": decision,
                }))
            }
            other => Err(OrchestrationError::BadRequest(format!(
                "unsupported pending_request action '{other}'"
            ))),
        }
    }

    async fn find_delegation_by_args(
        &self,
        args: &Value,
    ) -> Result<ConversationDelegationRecord, OrchestrationError> {
        let pool = &self.context.deployment.db().pool;
        if let Some(run_id) = str_field(args, "run_id") {
            return ConversationDelegationRecord::find_by_run_id(pool, run_id)
                .await
                .map_err(|e| OrchestrationError::Internal(e.to_string()))?
                .ok_or_else(|| OrchestrationError::NotFound(format!("run '{run_id}' not found")));
        }
        if let Some(child_raw) = str_field(args, "child_conversation_id") {
            let child_id = Uuid::parse_str(child_raw).map_err(|_| {
                OrchestrationError::BadRequest("invalid child_conversation_id".into())
            })?;
            return ConversationDelegationRecord::find_by_child_conversation(pool, child_id)
                .await
                .map_err(|e| OrchestrationError::Internal(e.to_string()))?
                .ok_or_else(|| {
                    OrchestrationError::NotFound(format!(
                        "no delegation found for child_conversation_id {child_id}"
                    ))
                });
        }
        Err(OrchestrationError::BadRequest(
            "either run_id or child_conversation_id is required".into(),
        ))
    }

    async fn serialize_delegation_record(&self, record: &ConversationDelegationRecord) -> Value {
        let pending = self
            .pending_permissions
            .list_entries(record.child_conversation_id)
            .await;
        json!({
            "run_id": record.run_id,
            "parent_conversation_id": record.parent_conversation_id,
            "child_conversation_id": record.child_conversation_id,
            "link": conversation_link(
                record.child_conversation_id,
                record.target_environment_id.as_deref()
            ),
            "project_id": record.target_project_id,
            "workspace_id": record.target_workspace_id,
            "agent_id": record.agent_id,
            "provider_instance_id": record.provider_instance_id,
            "model": record.model,
            "role": record.role,
            "isolation": record.isolation,
            "mode": record.mode,
            "completion_wake": record.completion_wake,
            "status": record.status,
            "preparation_stage": record.preparation_stage,
            "worktree_path": record.worktree_path,
            "branch": record.branch,
            "result_summary": record.result_summary,
            "error_code": record.error_code,
            "error_message": record.error_message,
            "pending_requests": pending,
            "created_at": record.created_at,
            "finished_at": record.finished_at,
            "delivered_at": record.delivered_at,
        })
    }

    /// Resolve a session's effective mode limit from:
    /// 1. Explicit `base_limit` (e.g., token ceiling or incoming remote header)
    /// 2. Live `AgentRuntime` session state (`current_mode == "plan"` and connection `auto_approve_mode`)
    /// 3. Persisted SQLite delegation ceiling (if this session is itself a delegated child)
    pub async fn resolve_caller_mode_limit(
        &self,
        conversation_id: Uuid,
        base_limit: OrchestrationModeLimit,
    ) -> OrchestrationModeLimit {
        let mut limit = base_limit;
        let session_id = AgentSessionId::from(conversation_id);
        if let Some(controls) = self.runtime.retained_session_controls(session_id).await
            && let Some(current_mode) = controls.current_mode.as_deref()
            && InteractionModeRank::parse_str(current_mode) == Some(InteractionModeRank::Plan)
        {
            limit = limit.intersect(OrchestrationModeLimit::plan_only());
        }
        if let Some(auto_approve) = self.runtime.session_auto_approve_mode(session_id).await {
            limit = limit.intersect(OrchestrationModeLimit {
                max_runtime_mode: RuntimeModeRank::from_auto_approve(auto_approve),
                max_interaction_mode: InteractionModeRank::Default,
            });
        }

        let pool = &self.context.deployment.db().pool;
        if let Ok(Some(record)) =
            ConversationDelegationRecord::find_by_child_conversation(pool, conversation_id).await
        {
            let persisted = OrchestrationModeLimit {
                max_runtime_mode: RuntimeModeRank::from_i64(record.max_runtime_mode),
                max_interaction_mode: InteractionModeRank::from_i64(record.max_interaction_mode),
            };
            limit = limit.intersect(persisted);
        }
        limit
    }

    /// Lookup live parent connection id if connected.
    pub async fn live_connection_id(&self, conversation_id: Uuid) -> Option<String> {
        self.runtime
            .live_connection_id(AgentSessionId::from(conversation_id))
            .await
            .map(|id| id.to_string())
    }

    /// Cancel an active delegation by its `child_conversation_id` (used by Host UI `delegation_cancel`).
    pub async fn cancel_child_conversation(&self, child_conversation_id: Uuid, reason: &str) {
        let pool = &self.context.deployment.db().pool;
        let Ok(Some(record)) =
            ConversationDelegationRecord::find_by_child_conversation(pool, child_conversation_id)
                .await
        else {
            return;
        };
        if record.is_terminal() {
            return;
        }
        self.launcher
            .preparations
            .cancel(child_conversation_id)
            .await;
        if let Some(ref remote_env) = record.target_environment_id {
            if let Some(forwarder) = self.current_remote_forwarder() {
                let mode_limit = OrchestrationModeLimit {
                    max_runtime_mode: RuntimeModeRank::from_i64(record.max_runtime_mode),
                    max_interaction_mode: InteractionModeRank::from_i64(
                        record.max_interaction_mode,
                    ),
                };
                let _ = forwarder
                    .forward_tool_call(
                        remote_env,
                        "task_cancel",
                        json!({
                            "run_id": record.run_id,
                            "reason": reason,
                        }),
                        mode_limit,
                    )
                    .await;
            }
        } else {
            let _ = ConversationSessionService::new(self.context.clone())
                .cancel_turn(child_conversation_id, Some(reason.to_string()))
                .await;
            if let Some(ws_id) = record.target_workspace_id
                && record.status == "preparing"
            {
                let _ = rollback_prepared_workspace(&self.context, ws_id).await;
            }
        }
        let updated = ConversationDelegationRecord::finish(
            pool,
            &record.run_id,
            "cancelled",
            None,
            Some("cancelled"),
            Some(reason),
        )
        .await
        .ok()
        .flatten()
        .unwrap_or(record);
        let _ = ConversationDelegationRecord::mark_delivered(
            pool,
            std::slice::from_ref(&updated.run_id),
        )
        .await;
        emit_parent_completion_event(&self.runtime, &updated).await;
    }
}

/// Recursively append `?env=<env_id>` to any `dimo://conversation/<id>` deep
/// links returned by a remote Host so links open on the right environment.
fn annotate_remote_links(value: &mut Value, env_id: &str) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(link)) = map.get_mut("link")
                && link.starts_with("dimo://conversation/")
                && !link.contains("?env=")
            {
                link.push_str(&format!("?env={env_id}"));
            }
            for child in map.values_mut() {
                annotate_remote_links(child, env_id);
            }
        }
        Value::Array(items) => {
            for item in items {
                annotate_remote_links(item, env_id);
            }
        }
        _ => {}
    }
}

fn requires_delegation_permission(name: &str) -> bool {
    matches!(
        name,
        "delegate_task"
            | "task_cancel"
            | "thread_launch"
            | "create_threads"
            | "thread_send"
            | "thread_interrupt"
            | "thread_transfer"
            | "project_create"
            | "project_clone"
            | "pending_request"
    )
}

fn extract_environment_id(args: &Value) -> Option<String> {
    let direct = args
        .get("environment_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty() && *v != "local");
    if let Some(env) = direct {
        return Some(env.to_string());
    }
    args.get("target")
        .and_then(|t| t.get("environment_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty() && *v != "local")
        .map(str::to_string)
}

fn str_field<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

fn parse_required_uuid(args: &Value, key: &str) -> Result<Uuid, OrchestrationError> {
    let raw = str_field(args, key)
        .ok_or_else(|| OrchestrationError::BadRequest(format!("{key} is required")))?;
    Uuid::parse_str(raw)
        .map_err(|_| OrchestrationError::BadRequest(format!("invalid UUID for {key}")))
}

fn parse_string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    let Some(obj) = value.and_then(Value::as_object) else {
        return map;
    };
    for (k, v) in obj {
        if let Some(s) = v.as_str() {
            map.insert(k.clone(), s.to_string());
        } else if v.is_boolean() || v.is_number() {
            map.insert(k.clone(), v.to_string());
        }
    }
    map
}

fn parse_workspace_strategy(
    value: Option<&Value>,
) -> Result<WorkspaceLaunchStrategy, OrchestrationError> {
    let Some(obj) = value.and_then(Value::as_object) else {
        return Ok(WorkspaceLaunchStrategy::Root);
    };
    match obj.get("kind").and_then(Value::as_str).unwrap_or("root") {
        "root" => Ok(WorkspaceLaunchStrategy::Root),
        "worktree" => Ok(WorkspaceLaunchStrategy::Worktree {
            base_ref: obj
                .get("base_ref")
                .and_then(Value::as_str)
                .map(str::to_string),
            branch: obj
                .get("branch")
                .and_then(Value::as_str)
                .map(str::to_string),
            start_from_origin: obj
                .get("start_from_origin")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        "existing_worktree" => {
            let path = obj
                .get("worktree_path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    OrchestrationError::BadRequest(
                        "workspace_strategy.worktree_path is required for existing_worktree".into(),
                    )
                })?;
            Ok(WorkspaceLaunchStrategy::ExistingWorktree {
                worktree_path: PathBuf::from(path),
            })
        }
        other => Err(OrchestrationError::BadRequest(format!(
            "unsupported workspace_strategy.kind '{other}'"
        ))),
    }
}

async fn compute_delegation_depth(
    pool: &sqlx::SqlitePool,
    conversation_id: Uuid,
) -> Result<u32, OrchestrationError> {
    let mut depth = 0u32;
    let mut cursor = conversation_id;
    let mut visited = std::collections::HashSet::new();
    while visited.insert(cursor) && depth < 16 {
        let parent: Option<Uuid> =
            sqlx::query_scalar("SELECT parent_session_id FROM sessions WHERE id = ?")
                .bind(cursor)
                .fetch_optional(pool)
                .await
                .map_err(|e| OrchestrationError::Internal(e.to_string()))?
                .flatten();
        let Some(parent_id) = parent else {
            break;
        };
        depth += 1;
        cursor = parent_id;
    }
    Ok(depth)
}
