use super::*;

impl AcpClientBridge {
    pub(in crate::manager) async fn session_notification(
        &self,
        args: SessionNotification,
    ) -> Result<(), acp::Error> {
        let acp_session_id = args.session_id.0.to_string();
        let bound_session_id = self.agent_session_for_acp(acp_session_id.clone()).await;
        let session_id =
            resolve_agent_session_id(bound_session_id, *self.pending_session_id.lock().await);
        if bound_session_id.is_none()
            && session_id.is_some()
            && (is_session_transcript_update(&args.update)
                || matches!(
                    args.update,
                    SessionUpdate::UsageUpdate(_) | SessionUpdate::SessionInfoUpdate(_)
                )
                || session_update_is_end_turn_usage(&args.update))
        {
            // Unbound notifications are `session/load` / `session/resume`
            // replaying history. They must not become a live turn. Record the
            // replay only when this load claimed an empty transcript file.
            if let SessionUpdate::SessionInfoUpdate(ref info) = args.update {
                let neutral_goal = self.apply.neutral_goal_channel.load(Ordering::SeqCst);
                if let Some(goal) =
                    crate::codex_goal::session_info_goal_value(info.meta.as_ref(), neutral_goal)
                {
                    self.apply
                        .apply_session_info_goal(session_id, goal, false)
                        .await;
                }
            }
            if is_session_transcript_update(&args.update) {
                self.record_hydrated_update(&acp_session_id, &args.update)
                    .await;
            }
            return Ok(());
        }
        if bound_session_id.is_some() && !matches!(args.update, SessionUpdate::UsageUpdate(_)) {
            self.maybe_emit_grok_usage(session_id, args.meta.as_ref())
                .await;
        }
        if matches!(
            args.update,
            SessionUpdate::ToolCall(_) | SessionUpdate::ToolCallUpdate(_) | SessionUpdate::Plan(_)
        ) {
            self.record_live_update(&acp_session_id, &args.update);
        }
        let event = match args.update {
            SessionUpdate::AgentMessageChunk(chunk) => {
                if self.take_pi_startup_banner(session_id, &chunk).await
                    || session_notice::is_adapter_cancelled_chunk(self.apply.agent_kind(), &chunk)
                {
                    None
                } else if let Some(activity) = crate::vendor_request_activity::pi_lifecycle_retry(
                    self.apply.agent_kind(),
                    &chunk,
                ) {
                    if let Some((active_session, prompt_id)) =
                        *self.apply.active_prompt.lock().await
                        && Some(active_session) == session_id
                    {
                        Some(AgentEvent::RequestActivity {
                            prompt_id,
                            activity,
                        })
                    } else {
                        None
                    }
                } else if let Some(adapter_error) =
                    session_notice::adapter_turn_error_from_chunk(self.apply.agent_kind(), &chunk)
                {
                    self.apply
                        .note_adapter_turn_error(session_id, adapter_error);
                    None
                } else if let Some(notice) =
                    session_notice::from_agent_message_chunk_for(self.apply.agent_kind(), &chunk)
                {
                    Some(AgentEvent::RawAcpDiagnostic {
                        raw: session_notice::diagnostic_payload(&notice),
                    })
                } else if let Some(parent_id) = crate::air_contract::chunk_parent_tool_use_id(
                    self.apply.agent_kind(),
                    chunk.meta.as_ref(),
                ) {
                    let text = match acp_content_to_agent(chunk.content.clone()) {
                        AgentContentBlock::Text { text } => text,
                        _ => String::new(),
                    };
                    self.record_live_update(
                        &acp_session_id,
                        &SessionUpdate::AgentMessageChunk(chunk),
                    );
                    if text.is_empty() {
                        None
                    } else {
                        let folded = self
                            .apply
                            .append_subagent_chunk(&parent_id, "text", &text)
                            .await;
                        Some(AgentEvent::ToolCallUpdate {
                            update: AgentToolCallUpdate {
                                id: parent_id,
                                title: None,
                                status: None,
                                content: None,
                                input_preview: None,
                                meta: bounded_optional_meta(folded),
                                images: Vec::new(),
                            },
                        })
                    }
                } else if crate::air_contract::codebuddy_chunk_marks_subagent(
                    self.apply.agent_kind(),
                    chunk.meta.as_ref(),
                ) {
                    self.record_live_update(
                        &acp_session_id,
                        &SessionUpdate::AgentMessageChunk(chunk),
                    );
                    None
                } else {
                    let gated = self
                        .gate_stream_chunk(
                            &acp_session_id,
                            StreamKind::Message,
                            acp_content_to_agent(chunk.content.clone()),
                        )
                        .await;
                    if gated.is_some() {
                        self.record_live_update(
                            &acp_session_id,
                            &SessionUpdate::AgentMessageChunk(chunk),
                        );
                    }
                    gated.map(|content| AgentEvent::MessageChunk { content })
                }
            }
            SessionUpdate::AgentThoughtChunk(chunk) => {
                if let Some(parent_id) = crate::air_contract::chunk_parent_tool_use_id(
                    self.apply.agent_kind(),
                    chunk.meta.as_ref(),
                ) {
                    let text = match acp_content_to_agent(chunk.content.clone()) {
                        AgentContentBlock::Text { text } => text,
                        _ => String::new(),
                    };
                    self.record_live_update(
                        &acp_session_id,
                        &SessionUpdate::AgentThoughtChunk(chunk),
                    );
                    if text.is_empty() {
                        None
                    } else {
                        let folded = self
                            .apply
                            .append_subagent_chunk(&parent_id, "thinking", &text)
                            .await;
                        Some(AgentEvent::ToolCallUpdate {
                            update: AgentToolCallUpdate {
                                id: parent_id,
                                title: None,
                                status: None,
                                content: None,
                                input_preview: None,
                                meta: bounded_optional_meta(folded),
                                images: Vec::new(),
                            },
                        })
                    }
                } else if crate::air_contract::codebuddy_chunk_marks_subagent(
                    self.apply.agent_kind(),
                    chunk.meta.as_ref(),
                ) {
                    self.record_live_update(
                        &acp_session_id,
                        &SessionUpdate::AgentThoughtChunk(chunk),
                    );
                    None
                } else {
                    let gated = self
                        .gate_stream_chunk(
                            &acp_session_id,
                            StreamKind::Thought,
                            acp_content_to_agent(chunk.content.clone()),
                        )
                        .await;
                    if gated.is_some() {
                        self.record_live_update(
                            &acp_session_id,
                            &SessionUpdate::AgentThoughtChunk(chunk),
                        );
                    }
                    gated.map(|content| AgentEvent::ThoughtChunk { content })
                }
            }
            SessionUpdate::ToolCall(tool_call) => {
                let status = Some(acp_enum_label(&tool_call.status));
                let original_input_preview = acp_tool_input_preview(
                    tool_call.raw_input.as_ref(),
                    &tool_call.content,
                    &tool_call.locations,
                );
                let call_id = tool_call.tool_call_id.0.to_string();
                let folded = self
                    .apply
                    .fold_air_tool_meta(&call_id, tool_call.meta.clone(), true)
                    .await;
                let was_hosted = self.apply.hosted_terminal_is_tracked(&call_id).await;
                let hosted = self
                    .apply
                    .hosted_terminal_output(&call_id, folded.as_ref(), status.as_deref())
                    .await;
                let skip_placeholder = was_hosted
                    || hosted.is_some()
                    || self.apply.agent_kind().is_some_and(|kind| {
                        crate::hosted_terminal::hosted_terminal_meta_marks_shell(
                            kind,
                            folded.as_ref(),
                        )
                    });
                let meta = bounded_optional_meta(folded);
                self.grok_subagent.lock().await.note_tool_call(
                    &call_id,
                    Some(tool_call.title.as_str()),
                    original_input_preview.as_deref(),
                    meta.as_ref(),
                    status.as_deref(),
                );
                let peeled = self.grok_mcp.lock().await.apply(
                    &call_id,
                    Some(tool_call.title.as_str()),
                    tool_call.raw_input.as_ref(),
                    tool_call.raw_output.as_ref(),
                );
                if let Some(session_id) = session_id {
                    self.note_in_flight_question_tool_input(
                        session_id,
                        Some(peeled.title.as_str()),
                        peeled.raw_input.as_ref().or(tool_call.raw_input.as_ref()),
                        status.as_deref(),
                    )
                    .await;
                }
                let enriched_input_preview = if peeled.peeled_input {
                    None
                } else {
                    self.capture_edit_tool_start(session_id, &call_id, &tool_call)
                        .await
                };
                let input_preview = if peeled.peeled_input {
                    json_preview(peeled.raw_input.as_ref())
                } else {
                    enriched_input_preview.or(original_input_preview)
                };
                let content = hosted
                    .map(truncate_preview)
                    .or_else(|| peeled.output_text.map(truncate_preview))
                    .or_else(|| {
                        if skip_placeholder {
                            None
                        } else {
                            json_preview(tool_call.raw_output.as_ref())
                        }
                    })
                    .or_else(|| {
                        if skip_placeholder {
                            None
                        } else {
                            acp_tool_content_preview(&tool_call.content)
                        }
                    });
                Some(AgentEvent::ToolCall {
                    tool_call: AgentToolCall {
                        status,
                        content,
                        id: call_id,
                        title: peeled.title,
                        kind: Some(acp_enum_label(&tool_call.kind)),
                        input_preview,
                        meta,
                        images: acp_tool_images(&tool_call.content),
                    },
                })
            }
            SessionUpdate::ToolCallUpdate(update) => {
                let call_id = update.tool_call_id.0.to_string();
                let status = update.fields.status.as_ref().map(acp_enum_label);
                let enriched_input_preview = self
                    .finish_edit_tool_update(session_id, &call_id, &update)
                    .await;
                let content_blocks = update.fields.content.as_deref().unwrap_or_default();
                let original_input_preview = acp_tool_input_preview(
                    update.fields.raw_input.as_ref(),
                    content_blocks,
                    update.fields.locations.as_deref().unwrap_or_default(),
                );
                let folded = self
                    .apply
                    .fold_air_tool_meta(&call_id, update.meta.clone(), false)
                    .await;
                let was_hosted = self.apply.hosted_terminal_is_tracked(&call_id).await;
                let hosted = self
                    .apply
                    .hosted_terminal_output(&call_id, folded.as_ref(), status.as_deref())
                    .await;
                let skip_placeholder = was_hosted
                    || hosted.is_some()
                    || self.apply.agent_kind().is_some_and(|kind| {
                        crate::hosted_terminal::hosted_terminal_meta_marks_shell(
                            kind,
                            folded.as_ref(),
                        )
                    });
                let meta = bounded_optional_meta(folded);
                self.grok_subagent.lock().await.note_tool_call(
                    &call_id,
                    update.fields.title.as_deref(),
                    original_input_preview.as_deref(),
                    meta.as_ref(),
                    status.as_deref(),
                );
                let peeled = self.grok_mcp.lock().await.apply(
                    &call_id,
                    update.fields.title.as_deref(),
                    update.fields.raw_input.as_ref(),
                    update.fields.raw_output.as_ref(),
                );
                if let Some(session_id) = session_id {
                    self.note_in_flight_question_tool_input(
                        session_id,
                        Some(peeled.title.as_str()).or(update.fields.title.as_deref()),
                        peeled
                            .raw_input
                            .as_ref()
                            .or(update.fields.raw_input.as_ref()),
                        status.as_deref(),
                    )
                    .await;
                }
                let input_preview = if peeled.peeled_input {
                    json_preview(peeled.raw_input.as_ref())
                } else {
                    enriched_input_preview.or(original_input_preview)
                };
                let content = hosted
                    .map(truncate_preview)
                    .or_else(|| peeled.output_text.map(truncate_preview))
                    .or_else(|| {
                        if skip_placeholder {
                            None
                        } else {
                            update.fields.raw_output.as_ref().and_then(|output| {
                                serde_json::to_string(output).ok().map(truncate_preview)
                            })
                        }
                    })
                    .or_else(|| {
                        if skip_placeholder {
                            None
                        } else {
                            acp_tool_content_preview(content_blocks)
                        }
                    });
                let title =
                    grok_mcp::should_rewrite_title(update.fields.title.as_deref(), &peeled.title)
                        .then_some(peeled.title);
                Some(AgentEvent::ToolCallUpdate {
                    update: AgentToolCallUpdate {
                        id: call_id,
                        title,
                        status,
                        content,
                        input_preview,
                        meta,
                        images: acp_tool_images(content_blocks),
                    },
                })
            }
            SessionUpdate::Plan(plan) => Some(AgentEvent::Plan {
                plan: AgentPlan {
                    entries: plan
                        .entries
                        .into_iter()
                        .map(|entry| crate::AgentPlanEntry {
                            content: entry.content,
                            status: plan_entry_status_name(entry.status),
                            priority: Some(plan_entry_priority_name(entry.priority)),
                        })
                        .collect(),
                },
            }),
            SessionUpdate::AvailableCommandsUpdate(update) => {
                let commands = self.enrich_available_commands(agent_available_commands_from_acp(
                    update.available_commands,
                ));
                if let Some(session_id) = session_id {
                    self.session_controls
                        .write()
                        .await
                        .entry(session_id)
                        .or_default()
                        .available_commands = Some(commands.clone());
                }
                Some(AgentEvent::AvailableCommands { commands })
            }
            SessionUpdate::UserMessageChunk(chunk) => {
                if let Some(session_id) = session_id {
                    let model = chunk.meta.as_ref().and_then(|meta| {
                        serde_json::to_value(meta)
                            .ok()
                            .and_then(|value| crate::model_id_from_meta(Some(&value)))
                    });
                    if let Some(model) = model {
                        self.session_controls
                            .write()
                            .await
                            .entry(session_id)
                            .or_default()
                            .last_model_id = Some(model);
                    }
                }
                Some(AgentEvent::RawAcpDiagnostic {
                    raw: serde_json::json!({
                        "kind": "user_message_acknowledged",
                        "preview": acp_content_preview(&chunk.content),
                    }),
                })
            }
            SessionUpdate::CurrentModeUpdate(update) => {
                let mut mode_id = update.current_mode_id.0.to_string();
                let is_omp = self.apply.agent_kind() == Some(AgentKind::Omp);
                if let Some(session_id) = session_id {
                    let (options, drift_check, effective_mode_id, suppressed) = {
                        let mut controls = self.session_controls.write().await;
                        let entry = controls.entry(session_id).or_default();
                        let effective_mode = if is_omp && entry.omp_yolo_mode {
                            if mode_id == "default" {
                                OMP_YOLO_MODE_ID.to_string()
                            } else {
                                mode_id.clone()
                            }
                        } else {
                            mode_id.clone()
                        };
                        let mut candidate_options = entry.config_options.clone();
                        apply_current_mode_to_config_options(
                            &mut candidate_options,
                            &effective_mode,
                        );
                        let candidate_mapped =
                            agent_session_config_options_from_acp(candidate_options.clone());
                        let drift_check = check_asserted_config_drift(
                            &mut entry.asserted_config_values,
                            &mut entry.drift_retry_counts,
                            &candidate_mapped,
                        );
                        if !drift_check.reassert.is_empty() {
                            // Suppress unsolicited drift back to defaults while we
                            // still have retry budget to re-assert the user's mode.
                            (
                                entry.config_options.clone(),
                                drift_check,
                                effective_mode,
                                true,
                            )
                        } else {
                            if is_omp && entry.omp_yolo_mode && effective_mode != OMP_YOLO_MODE_ID {
                                entry.omp_yolo_mode = false;
                            }
                            entry.config_options = candidate_options;
                            if let Some(ref mut mode_state) = entry.modes {
                                mode_state.current_mode_id =
                                    acp::schema::v1::SessionModeId::new(effective_mode.clone());
                            }
                            (
                                entry.config_options.clone(),
                                drift_check,
                                effective_mode,
                                false,
                            )
                        }
                    };
                    for rejection in drift_check.exhausted {
                        self.apply
                            .emit_config_option_rejection(session_id, rejection);
                    }
                    if suppressed {
                        self.apply.spawn_reassert_config_drift(
                            session_id,
                            acp_session_id.clone(),
                            drift_check.reassert,
                        );
                        return Ok(());
                    }
                    mode_id = effective_mode_id;
                    let (modes, current) = session_modes_from_config_options(&options);
                    if self.pending_session_id.lock().await.is_none() {
                        send_manager_event(
                            &self.event_tx,
                            AgentConnectionManagerEvent {
                                connection_id: self.connection_id,
                                session_id: Some(session_id),
                                prompt_id: None,
                                event: AgentEvent::SessionModes { modes, current },
                            },
                        );
                    }
                }
                Some(AgentEvent::ModeChanged { mode_id })
            }
            SessionUpdate::ConfigOptionUpdate(update) => {
                // Mirror the pushed options into the stored controls so later
                // `session/set_config_option` matching never works off stale data.
                let mut config_options = update.config_options;
                let is_omp = self.apply.agent_kind() == Some(AgentKind::Omp);
                if is_omp {
                    qualify_omp_model_labels(&mut config_options);
                    ensure_omp_yolo_config_option(&mut config_options);
                }
                if let Some(session_id) = session_id {
                    let (mapped, drift_check) = {
                        let mut controls = self.session_controls.write().await;
                        let stored = controls.entry(session_id).or_default();
                        if is_omp && stored.omp_yolo_mode {
                            let (_, pushed_mode) =
                                session_modes_from_config_options(&config_options);
                            if pushed_mode.as_deref() == Some("default") {
                                apply_current_mode_to_config_options(
                                    &mut config_options,
                                    OMP_YOLO_MODE_ID,
                                );
                            } else if pushed_mode.is_some() {
                                stored.omp_yolo_mode = false;
                            }
                        }
                        let pushed_mapped =
                            agent_session_config_options_from_acp(config_options.clone());
                        let drift_check = check_asserted_config_drift(
                            &mut stored.asserted_config_values,
                            &mut stored.drift_retry_counts,
                            &pushed_mapped,
                        );
                        // Preserve desired values for any key being re-asserted so
                        // non-drifted catalog updates propagate without flashing
                        // reverted defaults onto the UI.
                        for (drifted_key, desired_value) in &drift_check.reassert {
                            apply_config_option_value(
                                &mut config_options,
                                drifted_key,
                                desired_value,
                            );
                        }
                        stored.config_options = config_options;
                        stored.mode_uses_set_mode = stored.mode_uses_set_mode
                            && config_options_have_mode_category(&stored.config_options);
                        if let Some(model) = current_grok_model_id(&stored.config_options) {
                            stored.last_model_id = Some(model);
                        }
                        let broadcast_mapped =
                            agent_session_config_options_from_acp(stored.config_options.clone());
                        (broadcast_mapped, drift_check)
                    };
                    for rejection in drift_check.exhausted {
                        self.apply
                            .emit_config_option_rejection(session_id, rejection);
                    }
                    self.apply.spawn_reassert_config_drift(
                        session_id,
                        acp_session_id.clone(),
                        drift_check.reassert,
                    );
                    Some(AgentEvent::SessionConfigOptions { options: mapped })
                } else {
                    let mapped = agent_session_config_options_from_acp(config_options);
                    Some(AgentEvent::SessionConfigOptions { options: mapped })
                }
            }
            SessionUpdate::UsageUpdate(update) => {
                let usage = agent_usage_from_acp(update);
                Some(AgentEvent::Usage {
                    usage: self.usage_with_session_model(session_id, usage).await,
                })
            }
            SessionUpdate::SessionInfoUpdate(update) => {
                let neutral_goal = self.apply.neutral_goal_channel.load(Ordering::SeqCst);
                if let Some(goal) =
                    crate::codex_goal::session_info_goal_value(update.meta.as_ref(), neutral_goal)
                {
                    self.apply
                        .apply_session_info_goal(session_id, goal, true)
                        .await;
                }
                Some(AgentEvent::SessionInfoUpdated {
                    patch: session_info_patch_from_acp(update),
                })
            }
            other => {
                let raw_notification =
                    serde_json::to_value(other).unwrap_or(serde_json::Value::Null);
                if let Some(usage) = crate::usage_from_session_update(&raw_notification) {
                    Some(AgentEvent::Usage {
                        usage: self.usage_with_session_model(session_id, usage).await,
                    })
                } else if let Some(notice) =
                    session_notice::from_session_update_value(&raw_notification)
                {
                    Some(AgentEvent::RawAcpDiagnostic {
                        raw: session_notice::diagnostic_payload(&notice),
                    })
                } else {
                    let tag = raw_notification
                        .get("sessionUpdate")
                        .and_then(serde_json::Value::as_str);
                    self.apply.note_dropped_update(
                        session_id,
                        tag,
                        "unrecognized sessionUpdate variant",
                    );
                    Some(AgentEvent::RawAcpDiagnostic {
                        raw: bounded_raw_diagnostic(raw_notification),
                    })
                }
            }
        };

        if let Some(event) = event {
            let establishing = self.pending_session_id.lock().await.is_some();
            if establishing
                && matches!(
                    event,
                    AgentEvent::SessionModes { .. }
                        | AgentEvent::SessionConfigOptions { .. }
                        | AgentEvent::ModeChanged { .. }
                )
            {
                // Hold the first broadcast until preferred controls are applied
                // (CodeG applies before `session_modes` / `session_config_options`).
                return Ok(());
            }
            self.apply.record_turn_probe_event(session_id, &event);
            send_manager_event(
                &self.event_tx,
                AgentConnectionManagerEvent {
                    connection_id: self.connection_id,
                    session_id,
                    prompt_id: self
                        .apply
                        .active_prompt
                        .lock()
                        .await
                        .as_ref()
                        .filter(|(active_session, _)| Some(*active_session) == session_id)
                        .map(|(_, id)| *id),
                    event,
                },
            );
        }
        Ok(())
    }

    async fn note_in_flight_question_tool_input(
        &self,
        session_id: AgentSessionId,
        title: Option<&str>,
        raw_input: Option<&serde_json::Value>,
        status: Option<&str>,
    ) {
        if matches!(status, Some("completed" | "failed" | "cancelled")) {
            return;
        }
        let Some(raw_input) = raw_input else {
            return;
        };
        if extract_question_items_from_tool_input(raw_input).is_some()
            || title.is_some_and(is_question_tool_title)
        {
            self.session_controls
                .write()
                .await
                .entry(session_id)
                .or_default()
                .in_flight_question_input = Some(raw_input.clone());
        }
    }
}

pub(in crate::manager) fn is_question_tool_title(title: &str) -> bool {
    let lower = title.trim().to_ascii_lowercase();
    lower == "ask_user_question"
        || lower == "askuserquestion"
        || lower == "ask_question"
        || lower == "askquestion"
        || lower == "request_user_input"
        || lower.ends_with("_ask_user_question")
        || lower.ends_with("/ask_user_question")
        || lower.ends_with("_ask_question")
        || lower.ends_with("/ask_question")
}

pub(in crate::manager) fn extract_question_items_from_tool_input(
    value: &serde_json::Value,
) -> Option<&Vec<serde_json::Value>> {
    let mut current = value;
    for _ in 0..4 {
        let obj = current.as_object()?;
        if let Some(questions) = obj
            .get("questions")
            .and_then(serde_json::Value::as_array)
            .filter(|items| !items.is_empty())
        {
            return Some(questions);
        }
        current = obj
            .get("arguments")
            .or_else(|| obj.get("Arguments"))
            .or_else(|| obj.get("tool_input"))
            .or_else(|| obj.get("input"))
            .or_else(|| obj.get("params"))?;
    }
    None
}

#[cfg(test)]
mod edit_diff_tests {
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;

    async fn test_bridge(
        working_dir: &Path,
    ) -> (AcpClientBridge, AgentSessionId, ManagerEventReceiver) {
        let (event_tx, event_rx) = manager_event_channel();
        let agent_id = AgentId::parse("claude").unwrap();
        let connection_id = AgentConnectionId::new();
        let runner = AgentConnectionRunner::new(
            ManagedAgentConnectionSnapshot {
                connection_id,
                agent_id: agent_id.clone(),
                launch_lock: SessionLaunchLock {
                    agent_id: agent_id.clone(),
                    absolute_acp_program: PathBuf::from("/fixture/acp"),
                    args: Vec::new(),
                    env: BTreeMap::new(),
                    runtime_version: "fixture".into(),
                    acp_version: "2.2.2".into(),
                },
                workspace_id: uuid::Uuid::nil(),
                working_dir: working_dir.to_path_buf(),
                additional_directories: Vec::new(),
                auto_approve_mode: AgentAutoApproveMode::default(),
                env: HashMap::new(),
            },
            event_tx.clone(),
            None,
        );
        let session = AgentSessionId::new();
        let prompt = AgentPromptId::new();
        runner
            .session_map
            .write()
            .await
            .insert(session, "acp-edit-test".into());
        *runner.active_prompt.lock().await = Some((session, prompt));
        let bridge = AcpClientBridge::new(
            connection_id,
            agent_id,
            event_tx,
            runner.session_map.clone(),
            runner.session_controls.clone(),
            runner.pending_permissions.clone(),
            runner.pending_elicitations.clone(),
            runner.auto_approve_mode.clone(),
            runner.stream_dedup.clone(),
            runner.last_activity.clone(),
            runner.grok_subagent.clone(),
            runner.grok_mcp.clone(),
            runner.pending_session_id.clone(),
            working_dir.to_path_buf(),
            HashMap::new(),
            runner,
        );
        (bridge, session, event_rx)
    }

    fn tool_call_start(
        call_id: &str,
        kind: &str,
        raw_input: serde_json::Value,
    ) -> SessionNotification {
        serde_json::from_value(json!({
            "sessionId": "acp-edit-test",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": call_id,
                "title": "Running edit_file",
                "kind": kind,
                "status": "in_progress",
                "rawInput": raw_input,
            }
        }))
        .unwrap()
    }

    fn tool_call_finish(call_id: &str, status: &str) -> SessionNotification {
        serde_json::from_value(json!({
            "sessionId": "acp-edit-test",
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": call_id,
                "title": "edit_file done",
                "status": status,
                "rawOutput": "edited",
            }
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn synthesizes_diffs_for_modify_create_delete_and_overlapping_edits() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("app.ts");
        std::fs::write(&target, "const x = 1;\nconst y = 2;\n").unwrap();
        let new_file = dir.path().join("created.ts");

        let (bridge, _, mut rx) = test_bridge(dir.path()).await;

        // 1. Overlapping parallel edits to same file do not double count.
        bridge
            .session_notification(tool_call_start(
                "edit-1",
                "edit",
                json!({ "file_path": target.to_string_lossy() }),
            ))
            .await
            .unwrap();
        let _ = rx.try_recv().unwrap();

        bridge
            .session_notification(tool_call_start(
                "edit-2",
                "edit",
                json!({ "file_path": target.to_string_lossy() }),
            ))
            .await
            .unwrap();
        let _ = rx.try_recv().unwrap();

        std::fs::write(&target, "const x = 10;\nconst y = 2;\n").unwrap();
        bridge
            .session_notification(tool_call_finish("edit-1", "completed"))
            .await
            .unwrap();
        let ev1 = rx.try_recv().unwrap().event;
        let AgentEvent::ToolCallUpdate { update: up1 } = ev1 else {
            panic!("expected ToolCallUpdate");
        };
        let parsed1: serde_json::Value =
            serde_json::from_str(up1.input_preview.as_deref().unwrap()).unwrap();
        let diff1 = parsed1["unified_diff"].as_str().unwrap();
        assert!(diff1.contains("-const x = 1;"));
        assert!(diff1.contains("+const x = 10;"));

        std::fs::write(&target, "const x = 10;\nconst y = 20;\nconst z = 30;\n").unwrap();
        bridge
            .session_notification(tool_call_finish("edit-2", "completed"))
            .await
            .unwrap();
        let ev2 = rx.try_recv().unwrap().event;
        let AgentEvent::ToolCallUpdate { update: up2 } = ev2 else {
            panic!("expected ToolCallUpdate");
        };
        let parsed2: serde_json::Value =
            serde_json::from_str(up2.input_preview.as_deref().unwrap()).unwrap();
        let diff2 = parsed2["unified_diff"].as_str().unwrap();
        assert!(!diff2.contains("const x = 1;"));
        assert!(diff2.contains("-const y = 2;"));
        assert!(diff2.contains("+const y = 20;"));
        assert!(diff2.contains("+const z = 30;"));

        // 2. New file creation.
        bridge
            .session_notification(tool_call_start(
                "create-1",
                "edit",
                json!({ "file_path": "created.ts" }),
            ))
            .await
            .unwrap();
        let _ = rx.try_recv().unwrap();
        std::fs::write(&new_file, "export const hello = true;\n").unwrap();
        bridge
            .session_notification(tool_call_finish("create-1", "completed"))
            .await
            .unwrap();
        let AgentEvent::ToolCallUpdate { update: up_create } = rx.try_recv().unwrap().event else {
            panic!("expected ToolCallUpdate");
        };
        let parsed_create: serde_json::Value =
            serde_json::from_str(up_create.input_preview.as_deref().unwrap()).unwrap();
        let diff_create = parsed_create["unified_diff"].as_str().unwrap();
        assert!(diff_create.starts_with("--- /dev/null\n+++ b/created.ts\n"));
        assert!(diff_create.contains("+export const hello = true;"));

        // 3. File deletion.
        bridge
            .session_notification(tool_call_start(
                "delete-1",
                "delete",
                json!({ "file_path": "created.ts" }),
            ))
            .await
            .unwrap();
        let _ = rx.try_recv().unwrap();
        std::fs::remove_file(&new_file).unwrap();
        bridge
            .session_notification(tool_call_finish("delete-1", "completed"))
            .await
            .unwrap();
        let AgentEvent::ToolCallUpdate { update: up_del } = rx.try_recv().unwrap().event else {
            panic!("expected ToolCallUpdate");
        };
        let parsed_del: serde_json::Value =
            serde_json::from_str(up_del.input_preview.as_deref().unwrap()).unwrap();
        let diff_del = parsed_del["unified_diff"].as_str().unwrap();
        assert!(diff_del.starts_with("--- a/created.ts\n+++ /dev/null\n"));
        assert!(diff_del.contains("-export const hello = true;"));
    }

    #[tokio::test]
    async fn skips_failed_binary_and_already_populated_edits() {
        let dir = TempDir::new().unwrap();
        let text_file = dir.path().join("fail.ts");
        let bin_file = dir.path().join("blob.bin");
        std::fs::write(&text_file, "before\n").unwrap();
        std::fs::write(&bin_file, [0u8, 1, 2, 3]).unwrap();

        let (bridge, _, mut rx) = test_bridge(dir.path()).await;

        // Failed edit emits no synthesized input_preview.
        bridge
            .session_notification(tool_call_start(
                "fail-1",
                "edit",
                json!({ "file_path": text_file.to_string_lossy() }),
            ))
            .await
            .unwrap();
        let _ = rx.try_recv().unwrap();
        std::fs::write(&text_file, "after\n").unwrap();
        bridge
            .session_notification(tool_call_finish("fail-1", "failed"))
            .await
            .unwrap();
        let AgentEvent::ToolCallUpdate { update: up_fail } = rx.try_recv().unwrap().event else {
            panic!("expected ToolCallUpdate");
        };
        assert!(up_fail.input_preview.is_none());

        // Binary edit emits no synthesized input_preview.
        bridge
            .session_notification(tool_call_start(
                "bin-1",
                "edit",
                json!({ "file_path": bin_file.to_string_lossy() }),
            ))
            .await
            .unwrap();
        let _ = rx.try_recv().unwrap();
        std::fs::write(&bin_file, [0u8, 4, 5, 6]).unwrap();
        bridge
            .session_notification(tool_call_finish("bin-1", "completed"))
            .await
            .unwrap();
        let AgentEvent::ToolCallUpdate { update: up_bin } = rx.try_recv().unwrap().event else {
            panic!("expected ToolCallUpdate");
        };
        assert!(up_bin.input_preview.is_none());

        // Already-populated edit preserves original payload without re-diffing.
        let structured: SessionNotification = serde_json::from_value(json!({
            "sessionId": "acp-edit-test",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "grok-1",
                "title": "Edit",
                "kind": "edit",
                "status": "in_progress",
                "rawInput": {
                    "file_path": text_file.to_string_lossy(),
                    "old_string": "after",
                    "new_string": "final",
                }
            }
        }))
        .unwrap();
        bridge.session_notification(structured).await.unwrap();
        let _ = rx.try_recv().unwrap();
        std::fs::write(&text_file, "unrelated disk change\n").unwrap();
        bridge
            .session_notification(tool_call_finish("grok-1", "completed"))
            .await
            .unwrap();
        let AgentEvent::ToolCallUpdate { update: up_grok } = rx.try_recv().unwrap().event else {
            panic!("expected ToolCallUpdate");
        };
        assert!(up_grok.input_preview.is_none());
    }

    #[tokio::test]
    async fn falls_back_to_git_checkpoint_when_start_snapshot_misses_write() {
        let dir = TempDir::new().unwrap();
        let run_git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .arg("-C")
                .arg(dir.path())
                .args(args)
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?} failed");
        };
        run_git(&["init"]);
        run_git(&["config", "user.email", "test@dimo.local"]);
        run_git(&["config", "user.name", "Dimo Test"]);

        let file = dir.path().join("tracked.ts");
        std::fs::write(&file, "const preTurn = true;\n").unwrap();
        run_git(&["add", "tracked.ts"]);
        run_git(&["commit", "-m", "initial"]);

        let (bridge, session, mut rx) = test_bridge(dir.path()).await;
        crate::checkpoint_ref::CheckpointRef::new()
            .capture(dir.path(), session.0, 1)
            .await
            .unwrap();

        // Simulate disk write occurring BEFORE the in_progress notification arrives.
        std::fs::write(&file, "const preTurn = false;\nconst added = 1;\n").unwrap();
        bridge
            .session_notification(tool_call_start(
                "race-1",
                "edit",
                json!({ "file_path": file.to_string_lossy() }),
            ))
            .await
            .unwrap();
        let _ = rx.try_recv().unwrap();

        bridge
            .session_notification(tool_call_finish("race-1", "completed"))
            .await
            .unwrap();
        let AgentEvent::ToolCallUpdate { update } = rx.try_recv().unwrap().event else {
            panic!("expected ToolCallUpdate");
        };
        let parsed: serde_json::Value =
            serde_json::from_str(update.input_preview.as_deref().unwrap()).unwrap();
        let diff = parsed["unified_diff"].as_str().unwrap();
        assert!(diff.contains("-const preTurn = true;"));
        assert!(diff.contains("+const preTurn = false;"));
        assert!(diff.contains("+const added = 1;"));
    }
}
