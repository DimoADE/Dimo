//! JSON Schema definitions for all 17 unified Orchestration MCP tools.

use serde_json::{Value, json};

pub const ORCHESTRATION_TOOL_NAMES: &[&str] = &[
    "orchestrator_capabilities",
    "delegate_task",
    "task_status",
    "task_cancel",
    "thread_launch",
    "create_threads",
    "thread_list",
    "thread_read",
    "thread_send",
    "thread_wait",
    "thread_interrupt",
    "thread_transfer",
    "project_list",
    "project_read",
    "project_create",
    "project_clone",
    "pending_request",
];

pub fn is_orchestration_tool(name: &str) -> bool {
    ORCHESTRATION_TOOL_NAMES.contains(&name)
}

pub fn orchestration_tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "orchestrator_capabilities",
            "description": "List available local or remote coding agents, provider instances, models, reasoning/config options, supported runtime modes, and the caller's mode ceiling. Call once before your first delegate_task or thread_launch when selecting models or options.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Optional substring filter across agent ids, names, and model ids." },
                    "refresh": { "type": "boolean", "description": "Optional flag requesting catalog refresh hints." },
                    "environment_id": { "type": "string", "description": "Optional paired remote Host id." }
                }
            }
        }),
        json!({
            "name": "delegate_task",
            "description": "Delegate a self-contained sub-task to another coding agent in its own child conversation (same project or another project, shared directory or isolated git worktree). A structured user mention such as `[&Codex](dimo://agent/codex)` is an explicit user request to call `delegate_task` with that agent id. Supports `mode: \"async\"` (returns immediately and automatically pushes coalesced completion results back into your conversation — do NOT poll in a loop) or `mode: \"wait\"` (waits up to `timeout_ms`). Respects monotonic mode ceiling and `client_request_id` idempotency.",
            "inputSchema": {
                "type": "object",
                "required": ["task", "target"],
                "properties": {
                    "task": { "type": "string", "description": "Complete, self-contained task brief. The child starts cold and cannot see this conversation." },
                    "role": { "type": "string", "description": "Optional concise role label, e.g. 'Security Reviewer' or 'Frontend Builder'." },
                    "target": {
                        "type": "object",
                        "required": ["agent_id"],
                        "properties": {
                            "agent_id": { "type": "string", "description": "Stable agent id (e.g. 'codex', 'claude_code', 'gemini')." },
                            "provider_instance_id": { "type": "string", "description": "Optional provider instance id." },
                            "model": { "type": "string", "description": "Optional model id override." },
                            "options": { "type": "object", "additionalProperties": { "type": "string" }, "description": "Optional session config overrides such as reasoning effort or thinking budget." },
                            "project_id": { "type": "string", "description": "Optional target project UUID for local cross-project delegation. Defaults to the caller's project." },
                            "environment_id": { "type": "string", "description": "Optional paired remote Host id." }
                        }
                    },
                    "isolation": { "type": "string", "enum": ["shared", "worktree"], "default": "shared", "description": "Use 'worktree' for isolated git branch edits; 'shared' runs concurrently in the target checkout." },
                    "worktree": {
                        "type": "object",
                        "properties": {
                            "base_ref": { "type": "string", "description": "Optional base ref/branch (e.g. 'origin/main')." },
                            "branch": { "type": "string", "description": "Optional new branch name." },
                            "start_from_origin": { "type": "boolean", "description": "Fetch origin before creating the worktree." }
                        }
                    },
                    "mode": { "type": "string", "enum": ["async", "wait"], "default": "async" },
                    "completion_wake": { "type": "string", "enum": ["always", "settled_only"], "default": "always", "description": "'always' coalesces completions within a short window; 'settled_only' waits until all active children finish." },
                    "timeout_ms": { "type": "integer", "minimum": 1000, "description": "Deadline / wait timeout in milliseconds." },
                    "runtime_mode": { "type": "string", "enum": ["approval_required", "full_access"] },
                    "interaction_mode": { "type": "string", "enum": ["default", "plan"] },
                    "client_request_id": { "type": "string", "description": "Deterministic idempotency key to prevent duplicate delegations on retry." }
                }
            }
        }),
        json!({
            "name": "task_status",
            "description": "Inspect the current status, preparation stage, worktree/branch, pending requests, and result/error of a delegated task.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "run_id": { "type": "string" },
                    "child_conversation_id": { "type": "string" },
                    "environment_id": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "task_cancel",
            "description": "Cancel a preparing or running delegated task. Automatically rolls back newly created worktrees when cancelled during preparation.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "run_id": { "type": "string" },
                    "child_conversation_id": { "type": "string" },
                    "reason": { "type": "string" },
                    "environment_id": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "thread_launch",
            "description": "Launch a new durable top-level conversation thread in any registered project (or scratch workspace) with root, fresh git worktree, or verified existing worktree strategy. Uses two-phase deferred launch and returns a clickable `dimo://conversation/<id>` link immediately.",
            "inputSchema": {
                "type": "object",
                "required": ["target"],
                "properties": {
                    "project_id": { "type": "string", "description": "Target project UUID (required unless scratch=true)." },
                    "scratch": { "type": "boolean", "default": false, "description": "Create a workspace-less scratch thread." },
                    "title": { "type": "string" },
                    "workspace_strategy": {
                        "type": "object",
                        "properties": {
                            "kind": { "type": "string", "enum": ["root", "worktree", "existing_worktree"], "default": "root" },
                            "base_ref": { "type": "string" },
                            "branch": { "type": "string" },
                            "start_from_origin": { "type": "boolean" },
                            "worktree_path": { "type": "string", "description": "Required when kind='existing_worktree'; verified against `git worktree list`." }
                        }
                    },
                    "target": {
                        "type": "object",
                        "required": ["agent_id"],
                        "properties": {
                            "agent_id": { "type": "string" },
                            "provider_instance_id": { "type": "string" },
                            "model": { "type": "string" },
                            "options": { "type": "object", "additionalProperties": { "type": "string" } }
                        }
                    },
                    "runtime_mode": { "type": "string", "enum": ["approval_required", "full_access"] },
                    "interaction_mode": { "type": "string", "enum": ["default", "plan"] },
                    "message": { "type": "string", "description": "Optional first user message to start immediately after workspace preparation." },
                    "attachment_paths": { "type": "array", "items": { "type": "string" } },
                    "client_request_id": { "type": "string" },
                    "environment_id": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "create_threads",
            "description": "Batch launch multiple top-level threads across one or more projects with per-item receipts and partial failure isolation.",
            "inputSchema": {
                "type": "object",
                "required": ["threads"],
                "properties": {
                    "threads": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 16,
                        "items": { "type": "object" }
                    },
                    "environment_id": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "thread_list",
            "description": "List conversations on this Host filtered by project_id, parent_conversation_id, status, or text query.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project_id": { "type": "string" },
                    "parent_conversation_id": { "type": "string" },
                    "status": { "type": "string" },
                    "query": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
                    "environment_id": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "thread_read",
            "description": "Read a conversation's metadata, recent turns, worktree/branch info, pending requests, and child delegations.",
            "inputSchema": {
                "type": "object",
                "required": ["conversation_id"],
                "properties": {
                    "conversation_id": { "type": "string" },
                    "max_chars": { "type": "integer", "minimum": 256, "maximum": 65536 },
                    "environment_id": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "thread_send",
            "description": "Send a follow-up message to a top-level conversation (enqueue or steer). Do not use on active delegated children; spawn a new delegate_task or answer via pending_request instead.",
            "inputSchema": {
                "type": "object",
                "required": ["conversation_id", "message"],
                "properties": {
                    "conversation_id": { "type": "string" },
                    "message": { "type": "string" },
                    "mode": { "type": "string", "enum": ["enqueue", "steer"], "default": "enqueue" },
                    "client_request_id": { "type": "string" },
                    "environment_id": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "thread_wait",
            "description": "Wait for one or more conversations to finish their active turn or hit a pending user/permission request.",
            "inputSchema": {
                "type": "object",
                "required": ["conversation_ids"],
                "properties": {
                    "conversation_ids": { "type": "array", "minItems": 1, "items": { "type": "string" } },
                    "timeout_ms": { "type": "integer", "minimum": 100, "maximum": 60000, "default": 30000 },
                    "environment_id": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "thread_interrupt",
            "description": "Interrupt an in-flight turn on a top-level conversation.",
            "inputSchema": {
                "type": "object",
                "required": ["conversation_id"],
                "properties": {
                    "conversation_id": { "type": "string" },
                    "reason": { "type": "string" },
                    "environment_id": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "thread_transfer",
            "description": "Fork a conversation into a new thread (`action: \"fork\"`) or merge a structured summary back into a target conversation (`action: \"merge_back\"`).",
            "inputSchema": {
                "type": "object",
                "required": ["action", "source_conversation_id"],
                "properties": {
                    "action": { "type": "string", "enum": ["fork", "merge_back"] },
                    "source_conversation_id": { "type": "string" },
                    "target_conversation_id": { "type": "string", "description": "Required for merge_back." },
                    "agent_id": { "type": "string", "description": "Optional agent override for fork." },
                    "title": { "type": "string" },
                    "summary": { "type": "string", "description": "Optional custom summary for merge_back; auto-extracted from latest assistant reply if omitted." },
                    "environment_id": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "project_list",
            "description": "List all non-hidden projects registered on this Host.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "environment_id": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "project_read",
            "description": "Read a project's metadata, git repositories, default branch, and active workspaces/worktrees.",
            "inputSchema": {
                "type": "object",
                "required": ["project_id"],
                "properties": {
                    "project_id": { "type": "string" },
                    "environment_id": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "project_create",
            "description": "Register an existing local directory as a Dimo Project (and auto-attach its git repository if present).",
            "inputSchema": {
                "type": "object",
                "required": ["root_path"],
                "properties": {
                    "root_path": { "type": "string" },
                    "name": { "type": "string" },
                    "default_main_branch": { "type": "string" },
                    "environment_id": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "project_clone",
            "description": "Clone a git repository URL into a local destination directory and register it as a Dimo Project.",
            "inputSchema": {
                "type": "object",
                "required": ["repo_url", "destination_path"],
                "properties": {
                    "repo_url": { "type": "string" },
                    "destination_path": { "type": "string" },
                    "name": { "type": "string" },
                    "branch": { "type": "string" },
                    "environment_id": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "pending_request",
            "description": "Inspect (`action: \"read\"`) or answer (`action: \"respond\"`) pending permission requests or `ask_user_question` prompts blocking a child conversation. Responses exceeding the caller's mode ceiling automatically escalate to the human user.",
            "inputSchema": {
                "type": "object",
                "required": ["action", "conversation_id"],
                "properties": {
                    "action": { "type": "string", "enum": ["read", "respond"] },
                    "conversation_id": { "type": "string" },
                    "request_id": { "type": "string", "description": "Permission id or question id to respond to." },
                    "decision": { "type": "string", "enum": ["allow_once", "allow_always", "reject_once", "reject_always", "escalate"] },
                    "option_id": { "type": "string", "description": "Optional explicit permission option_id." },
                    "answers": { "type": "object", "description": "Answers object when responding to ask_user_question." },
                    "environment_id": { "type": "string" }
                }
            }
        }),
    ]
}
