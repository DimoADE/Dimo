//! Shared host DTOs exported to TypeScript via `generate_types`.

use agents::{
    AgentAvailableCommand, AgentSessionConfigOption,
    conversation::{
        AcpCapabilitySnapshot, ConversationSessionGoal, ConversationSessionModes,
        ConversationTimeline, MessageTurn, SessionStats,
    },
};
use api_types::AgentId;
use chrono::{DateTime, Utc};
use db::models::{conversation::DbConversationSummary, session::SessionStatus};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(use_ts_enum)]
pub enum AttentionItemKind {
    /// Agent is blocked on a permission decision — highest priority.
    PendingPermission,
    /// Agent is blocked on a question to the user.
    PendingQuestion,
    /// Session surfaced a notice, warning, or error.
    SessionNotice,
    /// Latest turn completed and may still need a look.
    TurnCompleted,
    /// Latest turn failed; needs a retry or a follow-up.
    TurnFailed,
    /// Latest turn was interrupted by a host crash/restart; never auto-resent.
    TurnInterrupted,
    /// Agent finished; the change is waiting for human review.
    InReview,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttentionItem {
    pub kind: AttentionItemKind,
    pub session_id: Uuid,
    pub workspace_id: Uuid,
    pub task_id: Uuid,
    pub project_id: Uuid,
    pub project_name: String,
    pub session_name: Option<String>,
    pub agent_type: Option<String>,
    pub detail: Option<String>,
    #[ts(type = "number | null")]
    pub happened_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttentionInbox {
    /// Sorted: blocking items first (permission, question), then failures,
    /// then review; newest first within each kind.
    pub items: Vec<AttentionItem>,
    /// Number of items actively blocking an agent right now.
    #[ts(type = "number")]
    pub blocking_count: u32,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportMeta {
    pub id: String,
    #[ts(type = "number | null")]
    pub created_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportsInfo {
    /// `owner/repo` used to prefill a GitHub issue; None when unresolvable.
    pub repository: Option<String>,
    pub reports: Vec<CrashReportMeta>,
}

/// A conversation's metadata plus its event-sourced projection.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DbConversationDetail {
    pub summary: DbConversationSummary,
    /// Open path no longer ships a duplicate of `timeline` (ADR-0061). Kept empty
    /// so existing TypeScript bindings remain valid.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub turns: Vec<MessageTurn>,
    pub timeline: ConversationTimeline,
    /// Index of `timeline.rows[0]` in the full transcript.
    #[serde(default)]
    pub turns_offset: u32,
    /// Turn count of the full transcript, including turns above the window.
    #[serde(default)]
    pub turns_total: u32,
    /// Fingerprint of the turns above the window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix_hash: Option<String>,
    #[serde(default)]
    pub user_turns_before_offset: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_binding: Option<ConversationActiveBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_turn: Option<ConversationCurrentTurn>,
    pub projection_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_stats: Option<SessionStats>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_flight_user_turn_id: Option<String>,
    /// Latest agent-advertised session modes, hydrated from the event log so a
    /// reopened conversation renders the real ACP pickers immediately.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_modes: Option<ConversationSessionModes>,
    /// Latest agent-advertised config options (model / permission / …), same
    /// hydration contract as `session_modes`.
    #[serde(default)]
    pub session_config_options: Vec<AgentSessionConfigOption>,
    /// Latest agent-advertised slash/skill catalog. `None` until the agent
    /// publishes `available_commands_update`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_commands: Option<Vec<AgentAvailableCommand>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_goal: Option<ConversationSessionGoal>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub async_tasks: Vec<agents::AsyncTaskRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_suggestion: Option<String>,
    /// Snapshot of the role used to create this conversation. Absent when the
    /// conversation was not created from a role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona: Option<conversations::collaboration::ConversationPersonaView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationActiveBinding {
    pub id: Uuid,
    pub agent_type: String,
    pub working_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_session_id: Option<String>,
    pub status: String,
    pub capabilities: AcpCapabilitySnapshot,
    /// True when this binding was created while MultiAgent collaboration was on,
    /// so Host delivered `dimo-delegation-mcp` on that session new/resume/rebind.
    #[serde(default)]
    pub delegation_mcp_delivered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationCurrentTurn {
    pub id: Uuid,
    pub ordinal: i64,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct SessionCollaborationRef {
    pub member_id: String,
    pub member_name: String,
    pub thread_id: String,
    pub thread_kind: String,
    pub thread_name: String,
    /// Active members of a group thread in join order; empty for direct threads.
    pub thread_members: Vec<SessionCollaborationMemberRef>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct SessionCollaborationMemberRef {
    pub member_id: String,
    pub name: String,
    pub conversation_id: String,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct SessionSummary {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub task_id: Option<Uuid>,
    pub name: Option<String>,
    pub display_name: String,
    pub status: SessionStatus,
    pub executor: Option<String>,
    pub agent_id: Option<AgentId>,
    pub workspace_name: Option<String>,
    pub workspace_branch: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub first_prompt: Option<String>,
    pub is_running: bool,
    pub continuity_mode: SessionContinuityMode,
    #[serde(default)]
    pub pinned_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub collaboration: Option<SessionCollaborationRef>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SessionContinuityMode {
    NewSession,
    ResumeInPlace,
}
