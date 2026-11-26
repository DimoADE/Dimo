//! Monotonic mode ceiling enforced across `delegate_task`, `thread_launch`,
//! `pending_request`, and remote Host forwarding (`X-Dimo-Mode-Limit`).

use agents::AgentAutoApproveMode;
use serde::{Deserialize, Serialize};

pub const MODE_LIMIT_HEADER: &str = "x-dimo-mode-limit";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeModeRank {
    ApprovalRequired = 0,
    FullAccess = 1,
}

impl RuntimeModeRank {
    pub fn as_i64(self) -> i64 {
        self as i64
    }

    pub fn from_i64(value: i64) -> Self {
        if value >= 1 {
            Self::FullAccess
        } else {
            Self::ApprovalRequired
        }
    }

    pub fn parse_str(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "approval_required" | "approval-required" | "default" | "off" => {
                Some(Self::ApprovalRequired)
            }
            "full_access" | "full-access" | "yolo" | "bypass_permissions" | "bypasspermissions" => {
                Some(Self::FullAccess)
            }
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ApprovalRequired => "approval_required",
            Self::FullAccess => "full_access",
        }
    }

    pub fn from_auto_approve(mode: AgentAutoApproveMode) -> Self {
        match mode {
            AgentAutoApproveMode::Yolo | AgentAutoApproveMode::AllowAlways => Self::FullAccess,
            AgentAutoApproveMode::Off => Self::ApprovalRequired,
        }
    }

    pub fn to_auto_approve(self) -> AgentAutoApproveMode {
        match self {
            Self::FullAccess => AgentAutoApproveMode::Yolo,
            Self::ApprovalRequired => AgentAutoApproveMode::Off,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionModeRank {
    Plan = 0,
    Default = 1,
}

impl InteractionModeRank {
    pub fn as_i64(self) -> i64 {
        self as i64
    }

    pub fn from_i64(value: i64) -> Self {
        if value <= 0 {
            Self::Plan
        } else {
            Self::Default
        }
    }

    pub fn parse_str(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "plan" => Some(Self::Plan),
            "default" | "code" | "build" => Some(Self::Default),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Default => "default",
        }
    }
}

/// Monotonic ceiling on what a session (and any descendants it spawns) may do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrchestrationModeLimit {
    pub max_runtime_mode: RuntimeModeRank,
    pub max_interaction_mode: InteractionModeRank,
}

impl Default for OrchestrationModeLimit {
    fn default() -> Self {
        Self::full()
    }
}

impl OrchestrationModeLimit {
    pub const fn full() -> Self {
        Self {
            max_runtime_mode: RuntimeModeRank::FullAccess,
            max_interaction_mode: InteractionModeRank::Default,
        }
    }

    pub const fn approval_required() -> Self {
        Self {
            max_runtime_mode: RuntimeModeRank::ApprovalRequired,
            max_interaction_mode: InteractionModeRank::Default,
        }
    }

    pub const fn plan_only() -> Self {
        Self {
            max_runtime_mode: RuntimeModeRank::ApprovalRequired,
            max_interaction_mode: InteractionModeRank::Plan,
        }
    }

    /// Clamp a requested `(runtime_mode, interaction_mode)` against this ceiling.
    /// The result can never exceed `self`.
    pub fn clamp(
        self,
        requested_runtime: Option<RuntimeModeRank>,
        requested_interaction: Option<InteractionModeRank>,
    ) -> Self {
        let runtime = requested_runtime
            .map(|r| r.min(self.max_runtime_mode))
            .unwrap_or(self.max_runtime_mode);
        let interaction = requested_interaction
            .map(|i| i.min(self.max_interaction_mode))
            .unwrap_or(self.max_interaction_mode);
        Self {
            max_runtime_mode: runtime,
            max_interaction_mode: interaction,
        }
    }

    /// Intersect two ceilings (e.g., local caller limit intersected with incoming
    /// `X-Dimo-Mode-Limit` remote header).
    pub fn intersect(self, other: Self) -> Self {
        Self {
            max_runtime_mode: self.max_runtime_mode.min(other.max_runtime_mode),
            max_interaction_mode: self.max_interaction_mode.min(other.max_interaction_mode),
        }
    }

    /// Returns whether this ceiling allows approving an execution/write permission
    /// automatically without escalating to a human user.
    pub fn allows_auto_approval(self) -> bool {
        self.max_runtime_mode == RuntimeModeRank::FullAccess
            && self.max_interaction_mode == InteractionModeRank::Default
    }

    /// Derive the effective ACP `mode_id` override if restricted.
    pub fn preferred_mode_id(self) -> Option<String> {
        if self.max_interaction_mode == InteractionModeRank::Plan {
            return Some("plan".to_string());
        }
        None
    }

    /// Encode as a compact header value for `X-Dimo-Mode-Limit`.
    pub fn to_header_value(self) -> String {
        format!(
            "runtime={};interaction={}",
            self.max_runtime_mode.as_str(),
            self.max_interaction_mode.as_str()
        )
    }

    /// Parse `X-Dimo-Mode-Limit`. Fails closed to `approval_required()` if malformed.
    pub fn from_header_value(raw: &str) -> Option<Self> {
        let mut runtime = None;
        let mut interaction = None;
        for part in raw.split(';') {
            let Some((key, value)) = part.trim().split_once('=') else {
                continue;
            };
            match key.trim() {
                "runtime" => runtime = RuntimeModeRank::parse_str(value),
                "interaction" => interaction = InteractionModeRank::parse_str(value),
                _ => {}
            }
        }
        Some(Self {
            max_runtime_mode: runtime?,
            max_interaction_mode: interaction?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_ceiling_is_strictly_monotonic() {
        let caller = OrchestrationModeLimit::approval_required();
        let clamped = caller.clamp(
            Some(RuntimeModeRank::FullAccess),
            Some(InteractionModeRank::Default),
        );
        assert_eq!(clamped.max_runtime_mode, RuntimeModeRank::ApprovalRequired);
        assert_eq!(clamped.max_interaction_mode, InteractionModeRank::Default);

        let plan_caller = OrchestrationModeLimit::plan_only();
        let clamped_plan = plan_caller.clamp(
            Some(RuntimeModeRank::FullAccess),
            Some(InteractionModeRank::Default),
        );
        assert_eq!(clamped_plan, OrchestrationModeLimit::plan_only());
        assert_eq!(clamped_plan.preferred_mode_id().as_deref(), Some("plan"));
    }

    #[test]
    fn header_round_trip() {
        let limit = OrchestrationModeLimit {
            max_runtime_mode: RuntimeModeRank::ApprovalRequired,
            max_interaction_mode: InteractionModeRank::Plan,
        };
        let encoded = limit.to_header_value();
        assert_eq!(
            OrchestrationModeLimit::from_header_value(&encoded),
            Some(limit)
        );
    }
}
