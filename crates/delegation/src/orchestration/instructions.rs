//! Concise runtime orchestration instructions injected invisibly via
//! `before_turn` (`InternalPromptBlock`) on the first turn of ordinary and
//! delegated child sessions.
//!
//! Strictly skips Collaboration Space (`BotSpace` / `GroupSpace`) sessions
//! (which have their own `dimo-bot` prompt/skill) and skips whenever the
//! delegation MCP surface is disabled.

use std::sync::Arc;

use agents::InternalPromptBlock;
use conversations::BeforeTurnContext;
use db::models::{conversation_delegation::ConversationDelegationRecord, session::Session};
use sqlx::SqlitePool;

pub const ORCHESTRATION_PLUGIN_ID: &str = "dimo.orchestration";

pub const TOP_LEVEL_ORCHESTRATION_INSTRUCTIONS: &str = "\
<dimo_orchestration_instructions>
Ordinary coding tasks need no orchestration tools.

- Subagents & delegation: use your native subagent tool when the child uses your own agent runtime/provider and needs no extra isolation, cross-project target, or remote host. Use `delegate_task` for another agent/model (including explicit `[&Agent](dimo://agent/<id>)` user mentions), isolated git worktrees, cross-project work, or paired remote hosts.
- Discovery before delegating: call `orchestrator_capabilities` (and `environment_links` / `project_list` when targeting another host or project) before choosing an agent, model, options, or target project. Never guess agent IDs, models, or remote host IDs.
- Fail honestly: if the requested agent, model, or host is unavailable, report the error — never silently swap to a different agent or model without asking.
- Async delivery: `delegate_task` (`mode: \"async\"`) automatically pushes coalesced completion results back into this conversation. Follow the returned `next` field; do NOT poll `task_status` in a loop.
- Lifecycle control: use `task_cancel` (not `thread_interrupt`) to stop a delegated task; use `pending_request` to answer or escalate child permission prompts; use `thread_launch` / `create_threads` only when the user explicitly asks to open separate top-level threads.
- Links: quote returned `dimo://conversation/...` links verbatim when referencing delegated or launched threads.
</dimo_orchestration_instructions>";

pub const DELEGATED_CHILD_INSTRUCTIONS: &str = "\
<dimo_delegated_child_instructions>
You are running inside a delegated child task. Complete the assigned brief directly and report a concise, factual summary. Avoid spawning further nested delegations unless explicitly required by your brief.
</dimo_delegated_child_instructions>";

/// Compute implicit orchestration prompt blocks for a turn.
///
/// Injects at most once per conversation (on turn #1):
/// - Skips when `delegation_enabled` is false.
/// - Skips Collaboration Space sessions (`origin == "collaboration"` or
///   registered in `space_members` / `bot_spaces`).
/// - Injects the compact child block for delegated child sessions and the
///   concise top-level orchestration rules for ordinary sessions.
pub async fn build_orchestration_before_turn_blocks(
    pool: &SqlitePool,
    ctx: &BeforeTurnContext,
    delegation_enabled: bool,
) -> Vec<InternalPromptBlock> {
    if !delegation_enabled {
        return Vec::new();
    }

    if ctx.origin.eq_ignore_ascii_case("collaboration") {
        return Vec::new();
    }

    if conversations::collaboration::conversation_is_space_session(pool, ctx.conversation_id)
        .await
        .unwrap_or(false)
    {
        return Vec::new();
    }

    // `commit_new_turn` inserts the current turn row before `prepare_turn_prompt`
    // invokes `before_turn` hooks, so turn #1 observes count <= 1 while turn #2+
    // observes count >= 2.
    let turn_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM conversation_turns WHERE conversation_id = ?")
            .bind(ctx.conversation_id)
            .fetch_one(pool)
            .await
            .unwrap_or(0);
    if turn_count > 1 {
        return Vec::new();
    }

    let is_delegated_child =
        ConversationDelegationRecord::find_by_child_conversation(pool, ctx.conversation_id)
            .await
            .ok()
            .flatten()
            .is_some()
            || Session::find_by_id(pool, ctx.conversation_id)
                .await
                .ok()
                .flatten()
                .is_some_and(|session| session.delegation_call_id.is_some());

    let (label, content) = if is_delegated_child {
        ("Dimo Delegated Child", DELEGATED_CHILD_INSTRUCTIONS)
    } else {
        ("Dimo Orchestration", TOP_LEVEL_ORCHESTRATION_INSTRUCTIONS)
    };

    vec![InternalPromptBlock {
        plugin_id: ORCHESTRATION_PLUGIN_ID.to_string(),
        label: Some(label.to_string()),
        content: content.to_string(),
        priority: Some(10),
    }]
}

/// Register the global async `before_turn` orchestration instruction injector.
pub fn install_orchestration_before_turn_hook<F>(pool: SqlitePool, delegation_enabled: F)
where
    F: Fn() -> bool + Send + Sync + 'static,
{
    let enabled = Arc::new(delegation_enabled);
    conversations::register_async_before_turn_hook(move |ctx| {
        let pool = pool.clone();
        let enabled = enabled.clone();
        async move { build_orchestration_before_turn_blocks(&pool, &ctx, enabled()).await }
    });
}
