//! Muse Code MSP (`muse serve`) JSON-RPC 2.0 notification normalization into
//! Dimo [`EngineEvent`] streams.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, RwLock},
};

use serde_json::{Value, json};

use crate::engine::{
    EngineEvent, EnginePermissionDecision, EnginePlanEntry, EngineRateLimits,
    muse_protocol::{
        MuseApprovalChoice, MuseQuestionSpec, PendingMuseApproval, PendingMuseUserInput,
        build_muse_approval_options, parse_muse_rate_limits_payload, pick_muse_approval_choice_id,
        str_any,
    },
};

#[derive(Debug, Clone)]
struct TrackedItem {
    session_id: Option<String>,
    kind: String,
    revision: i64,
    subagent_id: Option<String>,
    emitted_start: bool,
    emitted_delta: bool,
    accumulated_text: String,
}

/// Side-effect action returned when Muse requires an automatic host response
/// (e.g., auto-approving a workflow child request in `full-access` mode).
#[derive(Debug, Clone)]
pub struct MuseAutoApproveAction {
    pub session_id: String,
    pub approval_id: String,
    pub requirement_id: Value,
    pub choice_id: String,
}

#[derive(Default)]
pub struct MuseNotificationTracker {
    items: HashMap<String, TrackedItem>,
    pub pending_approvals: HashMap<String, PendingMuseApproval>,
    pub pending_user_inputs: HashMap<String, PendingMuseUserInput>,
    pub full_access_sessions: HashSet<String>,
    pub active_compact_sessions: HashSet<String>,
}

impl MuseNotificationTracker {
    pub fn clear_items_for_session(&mut self, session_id: Option<&str>) {
        match session_id {
            Some(sid) => self
                .items
                .retain(|_, item| item.session_id.as_deref() != Some(sid)),
            None => self.items.retain(|_, item| item.session_id.is_some()),
        }
    }

    pub fn clear_session(&mut self, session_id: &str) {
        self.clear_items_for_session(Some(session_id));
        self.full_access_sessions.remove(session_id);
        self.active_compact_sessions.remove(session_id);
        self.pending_approvals
            .retain(|_, pending| pending.session_id != session_id);
        self.pending_user_inputs
            .retain(|_, pending| pending.session_id != session_id);
    }

    pub fn clear_all(&mut self) {
        self.items.clear();
        self.pending_approvals.clear();
        self.pending_user_inputs.clear();
        self.full_access_sessions.clear();
        self.active_compact_sessions.clear();
    }

    #[cfg(test)]
    pub fn tracked_item_count(&self) -> usize {
        self.items.len()
    }
}

const SUPPRESSED_NATIVE_TOOLS: &[&str] = &["write_todos", "request_user_input", "workflow"];

fn parse_tool_args_value(item: &Value) -> Value {
    if let Some(raw_args) = item.get("args").and_then(Value::as_str) {
        if let Ok(parsed) = serde_json::from_str::<Value>(raw_args) {
            return parsed;
        }
        if !raw_args.trim().is_empty() {
            return json!({ "raw": raw_args });
        }
    }
    if let Some(cmd) = item.get("commandText").and_then(Value::as_str) {
        return json!({ "command": cmd });
    }
    json!({})
}

fn extract_item_output(item: &Value) -> String {
    for key in ["visibleOutput", "text", "finalSummary", "fallbackText"] {
        if let Some(s) = item.get(key).and_then(Value::as_str)
            && !s.is_empty()
        {
            return s.to_string();
        }
    }
    if let Some(res) = item.get("result") {
        if let Some(s) = res.get("text").and_then(Value::as_str)
            && !s.is_empty()
        {
            return s.to_string();
        }
        if let Some(s) = res.get("summary").and_then(Value::as_str)
            && !s.is_empty()
        {
            return s.to_string();
        }
    }
    if let Some(arr) = item.get("summary").and_then(Value::as_array) {
        let joined: Vec<&str> = arr.iter().filter_map(Value::as_str).collect();
        if !joined.is_empty() {
            return joined.join("\n");
        }
    }
    String::new()
}

/// Normalizes a single Muse MSP JSON-RPC notification into zero or more [`EngineEvent`]s
/// plus optional auto-approve RPC commands (for workflow children in `full-access` mode).
pub fn normalize_muse_notification(
    method: &str,
    params: &Value,
    tracker: &Arc<Mutex<MuseNotificationTracker>>,
    latest_rate_limits: &Arc<RwLock<Option<EngineRateLimits>>>,
) -> (Vec<EngineEvent>, Vec<MuseAutoApproveAction>) {
    let mut events = Vec::new();
    let mut auto_approves = Vec::new();

    match method {
        "usage/changed" => {
            if let Some(limits) = parse_muse_rate_limits_payload(params) {
                if let Ok(mut guard) = latest_rate_limits.write() {
                    *guard = Some(limits.clone());
                }
                events.push(EngineEvent::RateLimitsUpdated {
                    session_id: None,
                    rate_limits: limits,
                });
            }
            return (events, auto_approves);
        }
        "view/gap" => {
            let session_id = str_any(params, &["sessionId"]);
            events.push(EngineEvent::TurnError {
                prompt_id: None,
                session_id,
                message: "Muse delivery gap detected; session requires recovery".to_string(),
            });
            return (events, auto_approves);
        }
        "turn/started" => {
            let session_id = str_any(params, &["sessionId"]);
            let turn_id = str_any(params, &["turnId"]);
            events.push(EngineEvent::TurnStarted {
                prompt_id: turn_id.clone(),
                turn_id,
                session_id,
            });
            return (events, auto_approves);
        }
        "turn/completed" => {
            let session_id = str_any(params, &["sessionId"]);
            if let Ok(mut state) = tracker.lock() {
                if let Some(sid) = session_id.as_deref()
                    && state.active_compact_sessions.contains(sid)
                {
                    return (events, auto_approves);
                }
                state.clear_items_for_session(session_id.as_deref());
            }
            let turn_id = str_any(params, &["turnId"]);
            let terminal = str_any(params, &["terminal"]).unwrap_or_else(|| "completed".into());
            if let Some(usage) = params.get("usage")
                && let Some(ev) =
                    build_usage_event(session_id.clone(), turn_id.clone(), usage, None, true)
            {
                events.push(ev);
            }
            match terminal.as_str() {
                "completed" => {
                    events.push(EngineEvent::TurnCompleted {
                        prompt_id: turn_id.clone(),
                        turn_id,
                        session_id,
                        stop_reason: Some("end_turn".to_string()),
                        served_model: str_any(params, &["modelId", "model"]),
                    });
                }
                "cancelled" => {
                    let reason = str_any(params, &["reason"])
                        .unwrap_or_else(|| "Muse turn cancelled".to_string());
                    events.push(EngineEvent::TurnInterrupted {
                        prompt_id: turn_id,
                        session_id,
                        reason,
                    });
                }
                _ => {
                    let message = params
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| str_any(params, &["reason"]))
                        .unwrap_or_else(|| format!("Muse turn ended with `{terminal}`"));
                    events.push(EngineEvent::TurnError {
                        prompt_id: turn_id,
                        session_id,
                        message,
                    });
                }
            }
            return (events, auto_approves);
        }
        "session/closed" | "session/ended" | "session/deleted" => {
            if let Some(sid) = str_any(params, &["sessionId"])
                && let Ok(mut state) = tracker.lock()
            {
                state.clear_session(&sid);
            }
            return (events, auto_approves);
        }
        "session/tokenUsage" => {
            let session_id = str_any(params, &["sessionId"]);
            let turn_id = str_any(params, &["turnId"]);
            let prompt_tokens = params.get("promptTokens").and_then(Value::as_u64);
            let empty_usage = json!({});
            let usage = params.get("usage").unwrap_or(&empty_usage);
            if let Some(ev) = build_usage_event(session_id, turn_id, usage, prompt_tokens, false) {
                events.push(ev);
            }
            return (events, auto_approves);
        }
        "session/contextUsage" => {
            let session_id = str_any(params, &["sessionId"]);
            let used = params.get("usedTokens").and_then(Value::as_u64);
            let window = params.get("windowTokens").and_then(Value::as_u64);
            if used.is_some() || window.is_some() {
                events.push(EngineEvent::UsageUpdated {
                    prompt_id: None,
                    session_id,
                    input_tokens: None,
                    output_tokens: None,
                    cache_read_tokens: None,
                    cache_write_tokens: None,
                    cost_usd: None,
                    context_used: used,
                    context_window: window,
                    is_turn_summary: false,
                    model: None,
                });
            }
            return (events, auto_approves);
        }
        "session/todoListChanged" => {
            let session_id = str_any(params, &["sessionId"]);
            let entries: Vec<EnginePlanEntry> = params
                .get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|item| {
                    let content = str_any(item, &["text", "content", "title"])?;
                    let raw_status = str_any(item, &["status"]).unwrap_or_else(|| "pending".into());
                    if raw_status == "cancelled" {
                        return None;
                    }
                    let status = match raw_status.as_str() {
                        "completed" => "completed",
                        "inProgress" | "in_progress" => "in_progress",
                        _ => "pending",
                    };
                    Some(EnginePlanEntry {
                        content,
                        status: status.to_string(),
                        priority: None,
                    })
                })
                .collect();
            events.push(EngineEvent::PlanUpdated {
                prompt_id: None,
                session_id,
                entries,
            });
            return (events, auto_approves);
        }
        "item/started" | "item/updated" | "item/completed" => {
            let session_id = str_any(params, &["sessionId"]);
            let Some(item) = params.get("item") else {
                return (events, auto_approves);
            };
            let Some(item_id) = str_any(item, &["itemId"]) else {
                return (events, auto_approves);
            };
            let kind = str_any(item, &["kind"]).unwrap_or_default();
            if kind == "userMessage" || kind == "reminderChild" {
                return (events, auto_approves);
            }
            let status = str_any(item, &["status"]).unwrap_or_default();
            let tool_name = str_any(item, &["tool", "toolName"]);
            if kind == "toolCall"
                && tool_name
                    .as_deref()
                    .is_some_and(|t| SUPPRESSED_NATIVE_TOOLS.contains(&t))
                && status != "failed"
            {
                return (events, auto_approves);
            }
            let revision = item.get("revision").and_then(Value::as_i64).unwrap_or(1);
            let turn_id = str_any(item, &["turnId"]).or_else(|| str_any(params, &["turnId"]));

            let Ok(mut state) = tracker.lock() else {
                return (events, auto_approves);
            };
            let prev = state.items.get(&item_id).cloned();
            if let Some(ref existing) = prev
                && existing.revision > revision
            {
                return (events, auto_approves);
            }

            let is_terminal = method == "item/completed"
                || matches!(status.as_str(), "completed" | "failed" | "cancelled");
            let emitted_start = prev.as_ref().is_some_and(|p| p.emitted_start);
            let emitted_delta = prev.as_ref().is_some_and(|p| p.emitted_delta);
            let prev_text = prev
                .as_ref()
                .map(|p| p.accumulated_text.clone())
                .unwrap_or_default();

            match kind.as_str() {
                "agentMessage" | "assistantMessage" => {
                    let text = item
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if is_terminal {
                        if !text.is_empty() {
                            if !emitted_delta {
                                events.push(EngineEvent::AssistantMessage {
                                    prompt_id: turn_id,
                                    session_id: session_id.clone(),
                                    message_id: Some(item_id.clone()),
                                    text: text.clone(),
                                });
                            } else if let Some(suffix) = text.strip_prefix(&prev_text)
                                && !suffix.is_empty()
                            {
                                events.push(EngineEvent::AssistantTextDelta {
                                    prompt_id: turn_id,
                                    session_id: session_id.clone(),
                                    message_id: Some(item_id.clone()),
                                    text: suffix.to_string(),
                                });
                            }
                        }
                        state.items.remove(&item_id);
                    } else {
                        if let Some(suffix) = text.strip_prefix(&prev_text)
                            && !suffix.is_empty()
                        {
                            events.push(EngineEvent::AssistantTextDelta {
                                prompt_id: turn_id,
                                session_id: session_id.clone(),
                                message_id: Some(item_id.clone()),
                                text: suffix.to_string(),
                            });
                        }
                        state.items.insert(
                            item_id,
                            TrackedItem {
                                session_id,
                                kind,
                                revision,
                                subagent_id: None,
                                emitted_start: true,
                                emitted_delta: emitted_delta || !text.is_empty(),
                                accumulated_text: text,
                            },
                        );
                    }
                }
                "reasoning" => {
                    let text = item
                        .get("text")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| {
                            item.get("summary").and_then(Value::as_array).map(|arr| {
                                arr.iter()
                                    .filter_map(Value::as_str)
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                        })
                        .unwrap_or_default();
                    if let Some(suffix) = text.strip_prefix(&prev_text)
                        && !suffix.is_empty()
                    {
                        events.push(EngineEvent::ThinkingDelta {
                            prompt_id: turn_id,
                            session_id: session_id.clone(),
                            message_id: Some(item_id.clone()),
                            thinking: suffix.to_string(),
                        });
                    }
                    if is_terminal {
                        state.items.remove(&item_id);
                    } else {
                        state.items.insert(
                            item_id,
                            TrackedItem {
                                session_id,
                                kind,
                                revision,
                                subagent_id: None,
                                emitted_start: true,
                                emitted_delta: emitted_delta || !text.is_empty(),
                                accumulated_text: text,
                            },
                        );
                    }
                }
                "subagent" => {
                    let subagent_id = str_any(item, &["childSessionId", "subagentId"])
                        .unwrap_or_else(|| item_id.clone());
                    let role = str_any(item, &["role"]);
                    let objective = str_any(item, &["objective", "fallbackText"]);
                    if !emitted_start {
                        events.push(EngineEvent::SubagentSpawned {
                            prompt_id: turn_id.clone(),
                            session_id: session_id.clone(),
                            subagent_id: subagent_id.clone(),
                            parent_tool_use_id: None,
                            subagent_type: role,
                            description: objective,
                        });
                    }
                    let control_ready = item
                        .get("controlStatus")
                        .and_then(Value::as_str)
                        .is_some_and(|s| s == "resultReady");
                    if is_terminal || control_ready {
                        let summary = extract_item_output(item);
                        let final_status = if status == "failed" {
                            "failed"
                        } else if status == "cancelled" {
                            "cancelled"
                        } else {
                            "completed"
                        };
                        events.push(EngineEvent::SubagentCompleted {
                            prompt_id: turn_id,
                            session_id: session_id.clone(),
                            subagent_id: subagent_id.clone(),
                            parent_tool_use_id: None,
                            status: final_status.to_string(),
                            summary: (!summary.is_empty()).then_some(summary),
                        });
                    }
                    if is_terminal {
                        state.items.remove(&item_id);
                    } else {
                        state.items.insert(
                            item_id,
                            TrackedItem {
                                session_id,
                                kind,
                                revision,
                                subagent_id: Some(subagent_id),
                                emitted_start: true,
                                emitted_delta,
                                accumulated_text: prev_text,
                            },
                        );
                    }
                }
                "compaction" => {
                    events.push(EngineEvent::AutoCompactionChanged {
                        session_id: session_id.clone(),
                        in_progress: !is_terminal,
                    });
                    let completed_compact_turn = is_terminal
                        && session_id
                            .as_deref()
                            .is_some_and(|sid| state.active_compact_sessions.remove(sid));
                    if is_terminal {
                        state.items.remove(&item_id);
                        if completed_compact_turn {
                            state.clear_items_for_session(session_id.as_deref());
                        }
                    } else {
                        state.items.insert(
                            item_id,
                            TrackedItem {
                                session_id: session_id.clone(),
                                kind,
                                revision,
                                subagent_id: None,
                                emitted_start: true,
                                emitted_delta,
                                accumulated_text: prev_text,
                            },
                        );
                    }
                    if completed_compact_turn {
                        let outcome = str_any(item, &["outcome"]);
                        if status == "completed"
                            && outcome.as_deref().is_none_or(|o| o == "compacted")
                        {
                            events.push(EngineEvent::TurnCompleted {
                                prompt_id: turn_id.clone(),
                                turn_id,
                                session_id,
                                stop_reason: Some("end_turn".to_string()),
                                served_model: None,
                            });
                        } else if status == "cancelled" {
                            let reason = str_any(item, &["failureReason", "reason"])
                                .unwrap_or_else(|| "Muse compaction cancelled".to_string());
                            events.push(EngineEvent::TurnInterrupted {
                                prompt_id: turn_id,
                                session_id,
                                reason,
                            });
                        } else {
                            let message = str_any(item, &["failureReason", "reason"])
                                .unwrap_or_else(|| "Muse compaction failed".to_string());
                            events.push(EngineEvent::TurnError {
                                prompt_id: turn_id,
                                session_id,
                                message,
                            });
                        }
                    }
                }
                _ => {
                    // toolCall, userShell, workflow
                    let resolved_name = tool_name.clone().unwrap_or_else(|| kind.clone());
                    if !emitted_start {
                        events.push(EngineEvent::ToolCall {
                            prompt_id: turn_id.clone(),
                            session_id: session_id.clone(),
                            parent_tool_use_id: None,
                            tool_use_id: Some(item_id.clone()),
                            tool_name: resolved_name.clone(),
                            input: parse_tool_args_value(item),
                        });
                    }
                    if is_terminal {
                        let is_error = status == "failed" || status == "cancelled";
                        let out = extract_item_output(item);
                        let failure = str_any(item, &["failureReason"]);
                        let content = match (failure, out.is_empty()) {
                            (Some(f), false) => json!(format!("{f}\n{out}")),
                            (Some(f), true) => json!(f),
                            (None, _) => json!(out),
                        };
                        events.push(EngineEvent::ToolResult {
                            prompt_id: turn_id,
                            session_id: session_id.clone(),
                            parent_tool_use_id: None,
                            tool_use_id: Some(item_id.clone()),
                            is_error,
                            content,
                        });
                        state.items.remove(&item_id);
                    } else {
                        state.items.insert(
                            item_id,
                            TrackedItem {
                                session_id,
                                kind,
                                revision,
                                subagent_id: None,
                                emitted_start: true,
                                emitted_delta,
                                accumulated_text: prev_text,
                            },
                        );
                    }
                }
            }
            return (events, auto_approves);
        }
        "item/delta" => {
            let session_id = str_any(params, &["sessionId"]);
            let Some(item_id) = str_any(params, &["itemId"]) else {
                return (events, auto_approves);
            };
            let delta = params.get("delta").and_then(Value::as_str).unwrap_or("");
            if delta.is_empty() {
                return (events, auto_approves);
            }
            let field = params
                .get("field")
                .and_then(Value::as_str)
                .unwrap_or("text");
            let fallback_kind = str_any(params, &["kind"]).unwrap_or_else(|| "agentMessage".into());
            let turn_id = str_any(params, &["turnId"]);
            let Ok(mut state) = tracker.lock() else {
                return (events, auto_approves);
            };
            let tracked = state
                .items
                .entry(item_id.clone())
                .or_insert_with(|| TrackedItem {
                    session_id: session_id.clone(),
                    kind: fallback_kind,
                    revision: 0,
                    subagent_id: None,
                    emitted_start: false,
                    emitted_delta: false,
                    accumulated_text: String::new(),
                });
            tracked.emitted_delta = true;
            match tracked.kind.as_str() {
                "agentMessage" | "assistantMessage" if field == "text" => {
                    tracked.accumulated_text.push_str(delta);
                    events.push(EngineEvent::AssistantTextDelta {
                        prompt_id: turn_id,
                        session_id,
                        message_id: Some(item_id),
                        text: delta.to_string(),
                    });
                }
                "reasoning" if field == "text" || field.starts_with("summary.") => {
                    tracked.accumulated_text.push_str(delta);
                    events.push(EngineEvent::ThinkingDelta {
                        prompt_id: turn_id,
                        session_id,
                        message_id: Some(item_id),
                        thinking: delta.to_string(),
                    });
                }
                "subagent" => {
                    if let Some(subagent_id) = tracked.subagent_id.clone() {
                        events.push(EngineEvent::SubagentUpdated {
                            prompt_id: turn_id,
                            session_id,
                            subagent_id,
                            parent_tool_use_id: None,
                            text_delta: delta.to_string(),
                        });
                    }
                }
                _ if field == "output" || field == "visibleOutput" || field == "text" => {
                    events.push(EngineEvent::TerminalOutputDelta {
                        prompt_id: turn_id,
                        session_id,
                        call_id: Some(item_id),
                        delta: delta.to_string(),
                    });
                }
                _ => {}
            }
            return (events, auto_approves);
        }
        "approval/requested" | "approval/updated" => {
            let Some(approval_id) = str_any(params, &["approvalId"]) else {
                return (events, auto_approves);
            };
            let Some(session_id) = str_any(params, &["sessionId"]) else {
                return (events, auto_approves);
            };
            let turn_id = str_any(params, &["turnId"]);
            let requirement_id = params
                .get("currentRequirementId")
                .cloned()
                .unwrap_or_else(|| json!({ "approvalId": approval_id, "sourceIndex": 0 }));
            let from_subagent = params.get("subagentOrigin").is_some_and(|v| !v.is_null());
            let choices: Vec<MuseApprovalChoice> = params
                .get("availableChoices")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|c| {
                    Some(MuseApprovalChoice {
                        choice_id: str_any(c, &["choiceId"])?,
                        label: str_any(c, &["label"]).unwrap_or_default(),
                        decision: str_any(c, &["decision"]).unwrap_or_default(),
                        scope: str_any(c, &["scope"]).unwrap_or_else(|| "once".into()),
                    })
                })
                .collect();

            let pending = PendingMuseApproval {
                approval_id: approval_id.clone(),
                session_id: session_id.clone(),
                turn_id: turn_id.clone(),
                requirement_id: requirement_id.clone(),
                choices: choices.clone(),
                from_subagent,
            };

            let Ok(mut state) = tracker.lock() else {
                return (events, auto_approves);
            };
            if method == "approval/updated" && !state.pending_approvals.contains_key(&approval_id) {
                return (events, auto_approves);
            }
            let auto_approve = from_subagent && state.full_access_sessions.contains(&session_id);
            state
                .pending_approvals
                .insert(approval_id.clone(), pending.clone());

            if auto_approve
                && let Some((choice_id, _)) = pick_muse_approval_choice_id(
                    &pending,
                    &EnginePermissionDecision {
                        permission_id: approval_id.clone(),
                        approved: true,
                        option_id: Some("accept".to_string()),
                        updated_input: None,
                        message: None,
                        interrupt: false,
                    },
                )
            {
                auto_approves.push(MuseAutoApproveAction {
                    session_id,
                    approval_id,
                    requirement_id,
                    choice_id,
                });
                return (events, auto_approves);
            }

            let subject = params.get("subject").cloned().unwrap_or(Value::Null);
            let tool_name = str_any(params, &["toolName"])
                .or_else(|| str_any(&subject, &["kind"]))
                .unwrap_or_else(|| "permission".to_string());
            let reason = str_any(&subject, &["command", "path", "host", "target"]);
            let input = json!({
                "subject": subject,
                "rawArgs": params.get("rawArgs"),
                "protectedWrite": params.get("protectedWrite"),
                "judgeEscalated": params.get("judgeEscalated"),
            });

            events.push(EngineEvent::PermissionRequested {
                permission_id: approval_id,
                prompt_id: turn_id,
                session_id: Some(session_id),
                tool_name,
                input,
                decision_reason: reason,
                options: build_muse_approval_options(&choices),
            });
            return (events, auto_approves);
        }
        "approval/resolved" => {
            let Some(approval_id) = str_any(params, &["approvalId"]) else {
                return (events, auto_approves);
            };
            let session_id = str_any(params, &["sessionId"]);
            let removed = tracker
                .lock()
                .ok()
                .and_then(|mut s| s.pending_approvals.remove(&approval_id));
            let behavior = str_any(params, &["decision"])
                .map(|d| {
                    if d.starts_with("approved") {
                        "allow".to_string()
                    } else {
                        "deny".to_string()
                    }
                })
                .unwrap_or_else(|| "resolved".to_string());
            events.push(EngineEvent::PermissionResolved {
                permission_id: approval_id,
                prompt_id: removed.and_then(|r| r.turn_id),
                session_id,
                behavior,
            });
            return (events, auto_approves);
        }
        "userInput/requested" => {
            let Some(user_input_id) = str_any(params, &["userInputId"]) else {
                return (events, auto_approves);
            };
            let Some(session_id) = str_any(params, &["sessionId"]) else {
                return (events, auto_approves);
            };
            let turn_id = str_any(params, &["turnId"]);
            let raw_questions = params
                .get("questions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            let mut specs = Vec::new();
            let mut normalized_questions = Vec::new();
            for q in &raw_questions {
                let Some(id) = str_any(q, &["id"]) else {
                    continue;
                };
                let header = str_any(q, &["header"]).unwrap_or_else(|| "Question".to_string());
                let question = str_any(q, &["question"]).unwrap_or_default();
                let multi_select = q
                    .get("selection")
                    .and_then(|s| s.get("mode"))
                    .and_then(Value::as_str)
                    == Some("multiple");
                let options: Vec<Value> = q
                    .get("options")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|opt| {
                        let label = str_any(opt, &["label"])?;
                        let description =
                            str_any(opt, &["description"]).unwrap_or_else(|| label.clone());
                        Some(json!({ "label": label, "description": description }))
                    })
                    .collect();
                let option_labels: Vec<String> = options
                    .iter()
                    .filter_map(|opt| opt.get("label").and_then(Value::as_str).map(str::to_string))
                    .collect();
                specs.push(MuseQuestionSpec {
                    id: id.clone(),
                    question: question.clone(),
                    multi_select,
                    option_labels,
                });
                normalized_questions.push(json!({
                    "id": id,
                    "header": header,
                    "question": question,
                    "options": options,
                    "multiSelect": multi_select,
                }));
            }

            if let Ok(mut state) = tracker.lock() {
                state.pending_user_inputs.insert(
                    user_input_id.clone(),
                    PendingMuseUserInput {
                        user_input_id: user_input_id.clone(),
                        session_id: session_id.clone(),
                        turn_id: turn_id.clone(),
                        questions: specs,
                    },
                );
            }
            events.push(EngineEvent::QuestionRequested {
                request_id: user_input_id,
                prompt_id: turn_id,
                session_id: Some(session_id),
                tool_call_id: None,
                questions: Value::Array(normalized_questions),
            });
            return (events, auto_approves);
        }
        "userInput/settled" => {
            if let Some(user_input_id) = str_any(params, &["userInputId"])
                && let Ok(mut state) = tracker.lock()
            {
                state.pending_user_inputs.remove(&user_input_id);
            }
            return (events, auto_approves);
        }
        _ => {}
    }

    (events, auto_approves)
}

fn build_usage_event(
    session_id: Option<String>,
    turn_id: Option<String>,
    usage: &Value,
    fallback_input_tokens: Option<u64>,
    is_turn_summary: bool,
) -> Option<EngineEvent> {
    let input_tokens = usage
        .get("inputTokens")
        .and_then(Value::as_u64)
        .or(fallback_input_tokens);
    let output_tokens = usage.get("outputTokens").and_then(Value::as_u64);
    let cache_read_tokens = usage
        .get("cacheReadTokens")
        .or_else(|| usage.get("cachedTokens"))
        .and_then(Value::as_u64);
    let cache_write_tokens = usage.get("cacheWriteTokens").and_then(Value::as_u64);
    if input_tokens.is_none()
        && output_tokens.is_none()
        && cache_read_tokens.is_none()
        && cache_write_tokens.is_none()
    {
        return None;
    }
    Some(EngineEvent::UsageUpdated {
        prompt_id: turn_id,
        session_id,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cost_usd: None,
        context_used: None,
        context_window: None,
        is_turn_summary,
        model: None,
    })
}
