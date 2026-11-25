use agents::{
    conversation::{ConversationEvent, ConversationSessionNotice, ConversationTimelineRow},
    request_status::{
        ConversationConnectionStatus, ConversationRequestStatus, RequestActivity, RequestPhase,
    },
};
use db::models::conversation_event::ConversationEventRecord;

use super::{ProjectionFold, cache::upsert_stable_notice};

pub const CONNECTION_STATUS_ROW_ID: &str = "status:agent-connection";
pub const REQUEST_STATUS_ROW_ID: &str = "status:agent-request";

impl ProjectionFold {
    pub(super) fn apply_runtime_status(
        &mut self,
        record: &ConversationEventRecord,
        event: &ConversationEvent,
    ) {
        if let ConversationEvent::AgentConnectionStatusChanged {
            status,
            message,
            bound,
        } = event
        {
            if self.side_rows.iter().any(|row| {
                row.row_id == CONNECTION_STATUS_ROW_ID && row.revision >= record.sequence
            }) {
                return;
            }
            let bound = *bound
                || (*status == agents::conversation::ConversationAgentConnectionStatus::Ready
                    && self.side_rows.iter().any(|row| {
                        matches!(&row.row, ConversationTimelineRow::SessionNotice { notice } if notice.connection_status.as_ref().is_some_and(|previous|
                            previous.bound && previous.connection_id == record.connection_id))
                    }));
            upsert_stable_notice(
                &mut self.side_rows,
                CONNECTION_STATUS_ROW_ID,
                record.sequence,
                ConversationSessionNotice {
                    title: "Agent connection".into(),
                    severity: "info".into(),
                    connection_status: Some(ConversationConnectionStatus {
                        status: status.clone(),
                        bound,
                        connection_id: record.connection_id.clone(),
                        message: message.clone(),
                        since: record.created_at,
                    }),
                    ..Default::default()
                },
            );
        } else if matches!(event, ConversationEvent::AgentBindingReady { .. }) {
            let existing_is_newer = self.side_rows.iter().any(|row| {
                row.row_id == CONNECTION_STATUS_ROW_ID && row.revision >= record.sequence
            });
            if !existing_is_newer {
                let existing_connection_id = self.side_rows.iter().find_map(|row| match &row.row {
                    ConversationTimelineRow::SessionNotice { notice }
                        if row.row_id == CONNECTION_STATUS_ROW_ID =>
                    {
                        notice
                            .connection_status
                            .as_ref()
                            .and_then(|status| status.connection_id.clone())
                    }
                    _ => None,
                });
                upsert_stable_notice(
                    &mut self.side_rows,
                    CONNECTION_STATUS_ROW_ID,
                    record.sequence,
                    ConversationSessionNotice {
                        title: "Agent connection".into(),
                        severity: "info".into(),
                        connection_status: Some(ConversationConnectionStatus {
                            status: agents::conversation::ConversationAgentConnectionStatus::Ready,
                            bound: true,
                            connection_id: record.connection_id.clone().or(existing_connection_id),
                            message: None,
                            since: record.created_at,
                        }),
                        ..Default::default()
                    },
                );
            }
        }
        let activity = match event {
            ConversationEvent::UserTurnCreated { .. } | ConversationEvent::UserTurnQueued => {
                RequestActivity::phase(RequestPhase::Submitting)
            }
            ConversationEvent::UserTurnStarted => RequestActivity::phase(RequestPhase::Submitting),
            ConversationEvent::RequestActivityChanged { activity } => activity.clone(),
            ConversationEvent::TurnCompleted { .. } => {
                RequestActivity::phase(RequestPhase::Completed)
            }
            ConversationEvent::TurnFailed { .. } | ConversationEvent::TurnBlocked { .. } => {
                RequestActivity::phase(RequestPhase::Failed)
            }
            ConversationEvent::TurnCancelled { .. } => {
                RequestActivity::phase(RequestPhase::Cancelled)
            }
            ConversationEvent::TurnInterrupted { .. } => {
                RequestActivity::phase(RequestPhase::Interrupted)
            }
            _ => return,
        };
        let Some(turn_id) = record.turn_id else {
            return;
        };
        let previous = self.side_rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::SessionNotice { notice }
                if row.row_id == REQUEST_STATUS_ROW_ID =>
            {
                notice.request_status.as_ref()
            }
            _ => None,
        });
        if let Some(previous) = previous {
            if previous.turn_id == turn_id
                && previous.connection_id.is_some()
                && record.connection_id.is_some()
                && previous.connection_id != record.connection_id
            {
                return;
            }
            if previous.turn_id == turn_id
                && (previous.activity.phase.is_terminal()
                    || (previous.activity.phase == RequestPhase::Cancelling
                        && !activity.phase.is_terminal()
                        && activity.phase != RequestPhase::Cancelling))
            {
                return;
            }
            if previous.turn_id != turn_id
                && !matches!(event, ConversationEvent::UserTurnStarted)
                && !(previous.activity.phase.is_terminal()
                    && matches!(event, ConversationEvent::UserTurnCreated { .. }))
            {
                return;
            }
        }
        let preserved_since = previous
            .filter(|prev| {
                prev.turn_id == turn_id
                    && prev.activity.phase == RequestPhase::WaitingAgent
                    && activity.phase == RequestPhase::WaitingModel
            })
            .map(|prev| prev.since);
        upsert_stable_notice(
            &mut self.side_rows,
            REQUEST_STATUS_ROW_ID,
            record.sequence,
            ConversationSessionNotice {
                title: "Agent request".into(),
                severity: "info".into(),
                request_status: Some(ConversationRequestStatus {
                    turn_id,
                    prompt_id: record.prompt_id.clone(),
                    connection_id: record.connection_id.clone(),
                    activity,
                    since: preserved_since.unwrap_or(record.created_at),
                }),
                ..Default::default()
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;
    use crate::projection::{ConversationProjector, rows::tests::diagnostic_record};
    fn request(events: Vec<(Uuid, ConversationEvent)>) -> ConversationRequestStatus {
        let conversation = Uuid::new_v4();
        let records: Vec<_> = events
            .into_iter()
            .enumerate()
            .map(|(i, (turn, event))| {
                let mut record = diagnostic_record(conversation, i as i64 + 1, &event);
                record.turn_id = Some(turn);
                record.prompt_id = Some(turn.to_string());
                record
            })
            .collect();
        let timeline = ConversationProjector::project_records(conversation, &records).unwrap();
        timeline
            .rows
            .into_iter()
            .find_map(|row| match row.row {
                ConversationTimelineRow::SessionNotice { notice } => notice.request_status,
                _ => None,
            })
            .unwrap()
    }
    #[test]
    fn retry_updates_one_request_and_content_exits_retry() {
        let turn = Uuid::new_v4();
        let retry = |attempt| ConversationEvent::RequestActivityChanged {
            activity: RequestActivity {
                phase: RequestPhase::Retrying,
                retry: Some(agents::request_status::RequestRetry {
                    attempt: Some(attempt),
                    max_attempts: Some(5),
                    delay_ms: None,
                    reason: Some("provider unavailable".into()),
                    code: None,
                }),
            },
        };
        let status = request(vec![
            (turn, ConversationEvent::UserTurnStarted),
            (turn, retry(1)),
            (turn, retry(2)),
        ]);
        assert_eq!(status.activity.retry.unwrap().attempt, Some(2));
        let status = request(vec![
            (turn, ConversationEvent::UserTurnStarted),
            (turn, retry(1)),
            (
                turn,
                ConversationEvent::RequestActivityChanged {
                    activity: RequestActivity::phase(RequestPhase::Responding),
                },
            ),
        ]);
        assert_eq!(status.activity.phase, RequestPhase::Responding);
        assert!(status.activity.retry.is_none());
    }
    #[test]
    fn terminal_and_cancellation_cannot_reopen_or_be_overwritten_by_old_turn() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let activity = |phase| ConversationEvent::RequestActivityChanged {
            activity: RequestActivity::phase(phase),
        };
        let status = request(vec![
            (a, ConversationEvent::UserTurnStarted),
            (a, activity(RequestPhase::Cancelling)),
            (a, activity(RequestPhase::Responding)),
        ]);
        assert_eq!(status.activity.phase, RequestPhase::Cancelling);
        let status = request(vec![
            (a, ConversationEvent::UserTurnStarted),
            (a, ConversationEvent::TurnCancelled { reason: None }),
            (a, activity(RequestPhase::Responding)),
            (b, ConversationEvent::UserTurnStarted),
            (a, activity(RequestPhase::Retrying)),
        ]);
        assert_eq!(status.turn_id, b);
        assert_eq!(status.activity.phase, RequestPhase::Submitting);
    }

    #[test]
    fn waiting_agent_to_waiting_model_preserves_since_timestamp() {
        let conversation = Uuid::new_v4();
        let turn = Uuid::new_v4();
        let t0 = chrono::DateTime::parse_from_rfc3339("2026-11-25T10:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let t15 = t0 + chrono::Duration::seconds(15);

        let mut r1 = diagnostic_record(
            conversation,
            1,
            &ConversationEvent::RequestActivityChanged {
                activity: RequestActivity::phase(RequestPhase::WaitingAgent),
            },
        );
        r1.turn_id = Some(turn);
        r1.prompt_id = Some(turn.to_string());
        r1.created_at = t0;

        let mut r2 = diagnostic_record(
            conversation,
            2,
            &ConversationEvent::RequestActivityChanged {
                activity: RequestActivity::phase(RequestPhase::WaitingModel),
            },
        );
        r2.turn_id = Some(turn);
        r2.prompt_id = Some(turn.to_string());
        r2.created_at = t15;

        let timeline = ConversationProjector::project_records(conversation, &[r1, r2]).unwrap();
        let status = timeline
            .rows
            .into_iter()
            .find_map(|row| match row.row {
                ConversationTimelineRow::SessionNotice { notice } => notice.request_status,
                _ => None,
            })
            .expect("request status row");
        assert_eq!(status.activity.phase, RequestPhase::WaitingModel);
        assert_eq!(status.since, t0);
    }

    #[test]
    fn binding_ready_marks_connection_status_ready_and_bound() {
        use agents::conversation::{AcpCapabilitySnapshot, ConversationAgentConnectionStatus};

        let conversation = Uuid::new_v4();
        let connection_id = Some("conn-1".to_string());
        let mut connecting = diagnostic_record(
            conversation,
            1,
            &ConversationEvent::AgentConnectionStatusChanged {
                status: ConversationAgentConnectionStatus::Connecting,
                message: None,
                bound: false,
            },
        );
        connecting.connection_id = connection_id.clone();

        let mut binding_ready = diagnostic_record(
            conversation,
            2,
            &ConversationEvent::AgentBindingReady {
                acp_session_id: "acp-1".into(),
                capabilities: AcpCapabilitySnapshot::default(),
            },
        );
        binding_ready.connection_id = connection_id.clone();

        let mut ready_unbound = diagnostic_record(
            conversation,
            3,
            &ConversationEvent::AgentConnectionStatusChanged {
                status: ConversationAgentConnectionStatus::Ready,
                message: None,
                bound: false,
            },
        );
        ready_unbound.connection_id = connection_id;

        let timeline = ConversationProjector::project_records(
            conversation,
            &[connecting, binding_ready, ready_unbound],
        )
        .unwrap();
        let connection = timeline
            .rows
            .into_iter()
            .find_map(|row| match row.row {
                ConversationTimelineRow::SessionNotice { notice }
                    if row.row_id == CONNECTION_STATUS_ROW_ID =>
                {
                    notice.connection_status
                }
                _ => None,
            })
            .expect("connection status row");
        assert_eq!(connection.status, ConversationAgentConnectionStatus::Ready);
        assert!(connection.bound);
    }
}
