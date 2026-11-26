# Agent Orchestration, Delegation & Cross-Project Thread Launch

Normative technical specification for Dimo's multi-agent orchestration, `&Agent` delegation, cross-project top-level thread launching, and unified Streamable HTTP MCP control plane.

## 1. Architectural Invariants

1. **SQLite Single-Authority State ([ADR-0091](../adr/0091-sqlite-single-authority-conversation-projection.md))**: Every delegation run, workspace preparation phase, idempotency receipt, quota count, and wakeup delivery cursor lives in SQLite (`conversation_delegations`, `mcp_idempotency_receipts`, `conversation_relations`). No volatile in-memory state holds authority.
2. **Single-Seam Host Control ([ADR-0078](../adr/0078-host-command-registry-single-seam.md))**: All conversation creation, turn submission, steering, cancellation, and permission resolution flow through `conversations` (`ConversationSessionService` / `ScopedConversationControl`) and `HostEventBus`.
3. **Zero Regression on Collaboration Space**: Collaboration Space (`BotSpace`, `GroupSpace`, hidden seats, `list_spaces`, `read_space_messages`, `post_space_message`, `manage_bot`, `manage_group`, `request_approval`, `memory_search`, `memory_write`, `send_session_input` with `member_id` + `thread_id`) stays strictly isolated behind `TokenFeature::Collaboration` / `TokenFeature::SpaceSession` and `HostCompanionFeatures`.
4. **Monotonic Mode Ceiling**: A child delegation or launched thread can never exceed the caller's `OrchestrationModeLimit` (`runtime_mode` and `interaction_mode`). Mode limits propagate across child tokens and remote Host headers (`X-Dimo-Mode-Limit`).
5. **No Silent Serialization**: Directory-wide write mutexes (`WriteSerialized`) are forbidden. Shared-directory work runs concurrently by contract; write isolation uses real Git worktrees (`isolation: "worktree"`).

## 2. Unified MCP Transport

- `dimo-server` exposes a loopback Streamable HTTP JSON-RPC 2.0 endpoint at `POST /mcp` on the existing loopback product gateway (`127.0.0.1:0`).
- Authentication uses per-session `Authorization: Bearer <token>` resolved to `McpInvocationContext` (caller conversation ID, connection ID, workspace ID, project ID, delegation depth, `OrchestrationModeLimit`, and `TokenPermissions`). Model-supplied caller identity fields are never trusted.
- Native HTTP MCP engines connect directly to `/mcp`; stdio-only ACP engines connect through `dimo-mcp`, which proxies orchestration tool calls to `/mcp` while preserving `pulse`, `workflow`, `collaboration`, `space`, `feedback`, and `ask` tool groups.

## 3. Orchestration Tool Contract (17 Tools)

| Group | Tool | Purpose |
| :--- | :--- | :--- |
| **Discovery** | `orchestrator_capabilities` | List available agents, provider instances, models, config options (thinking/effort), runtime modes, and caller mode ceiling from `agent_capability_catalog`. |
| **Delegation** | `delegate_task` | Launch a child delegation run (`target: { agent_id, provider_instance_id?, model?, options?, project_id?, environment_id? }`, `role?`, `isolation: shared \| worktree`, `worktree?`, `mode: async \| wait`, `completion_wake: always \| settled_only`, `timeout_ms?`, `runtime_mode?`, `interaction_mode?`, `client_request_id?`). Supports local cross-project delegation and `&Agent` mentions. |
| | `task_status` | Query status, preparation stage, worktree/branch, pending requests, and result/error of a delegation run. |
| | `task_cancel` | Cancel a `preparing` or `running` delegation run, rolling back newly created worktrees during preparation. |
| **Top-Level Threads** | `thread_launch` | Launch a durable top-level conversation in any `project_id` or `scratch: true` with `workspace_strategy` (`root \| worktree \| existing_worktree`), model selection, mode limits, optional initial `message`, and `client_request_id`. Returns `dimo://conversation/<id>`. |
| | `create_threads` | Batch variant of `thread_launch` with per-item receipts and partial-failure isolation. |
| | `thread_list` | List conversations filtered by `project_id`, `status`, `parent_conversation_id`, or search query. |
| | `thread_read` | Read recent turns, status, worktree metadata, pending requests, and child delegations of an authorized conversation. |
| | `thread_send` | Enqueue or steer a message into a top-level conversation (rejects active delegated children). |
| | `thread_wait` | Wait for one or more top-level conversations to reach a terminal or pending-request state. |
| | `thread_interrupt` | Interrupt an in-flight turn on an authorized top-level conversation. |
| | `thread_transfer` | `fork` a conversation snapshot into a new thread or `merge_back` a summary into a target conversation. |
| **Projects** | `project_list` | List registered projects (`id`, `name`, `root_path`, `default_main_branch`, `is_git`). |
| | `project_read` | Read project details, repositories, and active worktrees. |
| | `project_create` | Register a local directory as a Dimo `Project`. |
| | `project_clone` | Clone a Git repository URL into a local path and register it as a `Project`. |
| **Blocked Interaction** | `pending_request` | `read` or `respond` to a child conversation's pending permission or `ask_user_question` prompt. Escalates to human UI whenever approval exceeds caller `OrchestrationModeLimit` or `escalate: true`. |

## 4. Core Engines

### 4.1 Two-Phase Deferred Launch (`ConversationLaunchService`)

1. **Phase 1 (Synchronous)**: Validate target project/scratch, agent/model, `OrchestrationModeLimit`, quotas, worktree allowlist (`git worktree list --porcelain` + canonical path for `existing_worktree`), and `mcp_idempotency_receipts`. Persist `Workspace`, `Session`, `conversation_relations`, and `conversation_delegations` (`status = 'preparing'` when worktree setup is needed) in SQLite and return immediately with `dimo://conversation/<id>`.
2. **Phase 2 (Cancellable Background Preparation)**: Execute optional `git fetch` (`start_from_origin`), create worktree via `ensure_container_exists`, run repo setup scripts (`setup_completed_at`), transition to `running`, and start the initial turn. Cancellation or error removes newly created empty worktrees and records terminal status.

### 4.2 Push Completion Wakeup (`DelegationCompletionReactor`)

- Subscribes to child turn terminal events (`TurnCompleted`, `TurnFailed`, `TurnCancelled`).
- Updates `conversation_delegations` (`status`, `result_summary` capped at `max_result_bytes`, `finished_at`) and emits `AgentEvent::DelegationCompleted` on the parent.
- Enforces `completion_wake`:
  - `always`: coalesces siblings completing within a 300ms window into one durable wakeup input.
  - `settled_only`: waits until all `preparing`/`running`/`waiting_for_input` siblings under the same parent settle, then delivers one coalesced summary.
- Delivers via `ScopedConversationControl::submit_text` and stamps `delivered_at` for restart idempotency.

### 4.3 Blocked Child Question/Permission Router (`DelegationQuestionReactor`)

- Subscribes to child `AgentEvent::PermissionRequested` and `PendingQuestion` events.
- Transitions the delegation row to `waiting_for_input` and wakes the parent with a structured notice pointing to `pending_request`.
- If the parent responds within its `OrchestrationModeLimit`, unblocks the child immediately via `ConversationSessionService::respond_permission` / `answer_question`; otherwise escalates to human approval in the UI.

### 4.4 Quotas, Deadlines & Startup Reconciler

- SQLite-enforced limits: `depth_limit`, `max_active_children`, `max_calls_per_parent`, `child_deadline_ms`, `max_result_bytes`.
- Background deadline watchdog cancels expired `preparing`/`running` delegations (`status = 'timed_out'`).
- On server boot, `StartupReconciler` marks stale `preparing`/`running` delegations failed/interrupted, cleans orphaned worktrees, and redelivers terminal rows where `delivered_at IS NULL`.

### 4.5 Remote Host Forwarding (`environment_id`)

- When a tool call specifies a non-local `environment_id`, `McpAccessGuard` resolves the paired remote Host (`ServerProfile`) and forwards the JSON-RPC call with `X-Dimo-Mode-Limit`, returning `dimo://conversation/<id>?env=<environment_id>`.

## 5. Persistence Schema

- `conversation_delegations`: Durable authority for every delegation run, workspace/worktree metadata, mode ceiling snapshot, lifecycle status, preparation stage, deadline, result summary, and wakeup `delivered_at`.
- `mcp_idempotency_receipts`: Deterministic idempotency cache keyed by `sha256(caller_conversation_id : tool_name : client_request_id)`.
