use super::*;
use crate::stderr_tail::sanitize_diagnostic;

pub(in crate::manager) const SILENT_WAIT_ADVISORY_THRESHOLD: Duration = Duration::from_secs(15);

/// Tracks whether a single `session/prompt` turn produced any user-visible output
/// and whether any incoming updates were dropped as unreadable.
#[derive(Debug)]
pub(in crate::manager) struct TurnOutputProbe {
    produced: AtomicBool,
    dropped_updates: std::sync::atomic::AtomicU64,
    first_dropped_tag: std::sync::Mutex<Option<String>>,
    first_dropped_error: std::sync::Mutex<Option<String>>,
    adapter_turn_error: std::sync::Mutex<Option<String>>,
    running_tools: std::sync::Mutex<HashSet<String>>,
    last_progress_at: std::sync::Mutex<Instant>,
    in_retry: AtomicBool,
    silence_waiting_emitted: AtomicBool,
}

impl Default for TurnOutputProbe {
    fn default() -> Self {
        Self {
            produced: AtomicBool::new(false),
            dropped_updates: std::sync::atomic::AtomicU64::new(0),
            first_dropped_tag: std::sync::Mutex::new(None),
            first_dropped_error: std::sync::Mutex::new(None),
            adapter_turn_error: std::sync::Mutex::new(None),
            running_tools: std::sync::Mutex::new(HashSet::new()),
            last_progress_at: std::sync::Mutex::new(Instant::now()),
            in_retry: AtomicBool::new(false),
            silence_waiting_emitted: AtomicBool::new(false),
        }
    }
}

impl TurnOutputProbe {
    pub(in crate::manager) fn note_rendered(&self) {
        self.produced.store(true, Ordering::Release);
    }

    pub(in crate::manager) fn note_progress(&self) {
        if let Ok(mut guard) = self.last_progress_at.lock() {
            *guard = Instant::now();
        }
        self.in_retry.store(false, Ordering::Release);
        self.silence_waiting_emitted.store(false, Ordering::Release);
    }

    pub(in crate::manager) fn should_emit_waiting_model(&self, threshold: Duration) -> bool {
        if self.in_retry.load(Ordering::Acquire)
            || self.silence_waiting_emitted.load(Ordering::Acquire)
            || self.has_running_tools()
        {
            return false;
        }
        self.last_progress_at
            .lock()
            .is_ok_and(|since| since.elapsed() >= threshold)
    }

    pub(in crate::manager) fn mark_waiting_model_emitted(&self) {
        self.silence_waiting_emitted.store(true, Ordering::Release);
    }

    pub(in crate::manager) fn note_adapter_turn_error(&self, error: impl Into<String>) {
        if let Ok(mut guard) = self.adapter_turn_error.lock() {
            *guard = Some(sanitize_diagnostic(&error.into()));
        }
    }

    pub(in crate::manager) fn adapter_turn_error(&self) -> Option<String> {
        self.adapter_turn_error
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    pub(in crate::manager) fn record_agent_event(&self, event: &AgentEvent) {
        if let AgentEvent::RequestActivity { activity, .. } = event {
            if let Ok(mut guard) = self.last_progress_at.lock() {
                *guard = Instant::now();
            }
            match activity.phase {
                crate::request_status::RequestPhase::Retrying => {
                    self.in_retry.store(true, Ordering::Release);
                    self.silence_waiting_emitted.store(false, Ordering::Release);
                }
                crate::request_status::RequestPhase::WaitingModel => {
                    self.silence_waiting_emitted.store(true, Ordering::Release);
                }
                _ => {
                    self.in_retry.store(false, Ordering::Release);
                    self.silence_waiting_emitted.store(false, Ordering::Release);
                }
            }
            return;
        }
        let tool = match event {
            AgentEvent::ToolCall { tool_call } => {
                Some((&tool_call.id, tool_call.status.as_deref()))
            }
            AgentEvent::ToolCallUpdate { update } if update.status.is_some() => {
                Some((&update.id, update.status.as_deref()))
            }
            _ => None,
        };
        if let Some((id, status)) = tool
            && let Ok(mut tools) = self.running_tools.lock()
        {
            if matches!(status, Some("completed" | "failed" | "cancelled")) {
                tools.remove(id);
            } else {
                tools.insert(id.clone());
            }
        }
        let visible = match event {
            AgentEvent::MessageChunk { content } | AgentEvent::ThoughtChunk { content } => {
                agent_content_has_output(content)
            }
            AgentEvent::ToolCall { .. }
            | AgentEvent::ToolCallUpdate { .. }
            | AgentEvent::Plan { .. }
            | AgentEvent::PermissionRequested { .. }
            | AgentEvent::PermissionResponded { auto: true, .. }
            | AgentEvent::ElicitationRequested { .. }
            | AgentEvent::GoalUpdated { .. }
            | AgentEvent::AsyncTasksUpdated { .. } => true,
            _ => false,
        };
        if visible {
            self.note_rendered();
            self.note_progress();
        }
    }

    pub(in crate::manager) fn note_dropped(&self, tag: Option<&str>, error: &str) {
        let prev = self.dropped_updates.fetch_add(1, Ordering::AcqRel);
        if prev == 0 {
            if let Ok(mut guard) = self.first_dropped_tag.lock() {
                *guard = tag.map(str::to_string);
            }
            if let Ok(mut guard) = self.first_dropped_error.lock() {
                *guard = Some(sanitize_diagnostic(error));
            }
        }
    }

    pub(in crate::manager) fn has_output(&self) -> bool {
        self.produced.load(Ordering::Acquire)
    }

    pub(in crate::manager) fn has_running_tools(&self) -> bool {
        self.running_tools
            .lock()
            .is_ok_and(|tools| !tools.is_empty())
    }

    pub(in crate::manager) fn dropped_summary(&self) -> (u64, Option<String>, Option<String>) {
        let count = self.dropped_updates.load(Ordering::Acquire);
        let tag = self
            .first_dropped_tag
            .lock()
            .ok()
            .and_then(|mut guard| guard.take());
        let error = self
            .first_dropped_error
            .lock()
            .ok()
            .and_then(|mut guard| guard.take());
        (count, tag, error)
    }
}

pub(in crate::manager) fn agent_content_has_output(content: &AgentContentBlock) -> bool {
    match content {
        AgentContentBlock::Text { text } => !text.is_empty(),
        AgentContentBlock::Image { .. }
        | AgentContentBlock::Resource { .. }
        | AgentContentBlock::Protocol { .. } => true,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::manager) enum EmptyTurnCause {
    UnreadableUpdates,
    AgentStderr,
    SilentEndTurn,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_only_tool_patch_does_not_restart_completed_tool_or_reset_wait() {
        let probe = TurnOutputProbe::default();
        let patch = |status: Option<&str>| -> AgentEvent {
            serde_json::from_value(serde_json::json!({"kind":"tool_call_update", "update": {
                "id":"tool-1", "status":status, "meta":{"source":"fixture"}
            }}))
            .unwrap()
        };
        probe.record_agent_event(&patch(Some("in_progress")));
        assert!(probe.has_running_tools());
        probe.record_agent_event(&patch(None));
        assert!(probe.has_running_tools());
        probe.record_agent_event(&patch(Some("completed")));
        assert!(!probe.has_running_tools());
        probe.record_agent_event(&patch(None));
        assert!(!probe.has_running_tools());
        assert!(crate::request_status::activity_for_event(&patch(None)).is_none());
    }

    #[test]
    fn silence_waiting_model_fires_once_per_window_and_yields_to_retry_or_progress() {
        let probe = TurnOutputProbe::default();
        assert!(probe.should_emit_waiting_model(Duration::ZERO));
        probe.mark_waiting_model_emitted();
        assert!(!probe.should_emit_waiting_model(Duration::ZERO));

        // Retry suppresses WaitingModel until real output resumes.
        probe.record_agent_event(&AgentEvent::RequestActivity {
            prompt_id: AgentPromptId::new(),
            activity: crate::request_status::RequestActivity::phase(
                crate::request_status::RequestPhase::Retrying,
            ),
        });
        assert!(!probe.should_emit_waiting_model(Duration::ZERO));

        // Content chunk exits retry and re-arms silence detection for a future stall.
        probe.record_agent_event(&AgentEvent::MessageChunk {
            content: AgentContentBlock::Text {
                text: "resumed".into(),
            },
        });
        assert!(probe.should_emit_waiting_model(Duration::ZERO));
    }
}
