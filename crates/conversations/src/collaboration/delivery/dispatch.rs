use db::models::collaboration_identity::{self as identity};
use serde_json::json;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::*;

#[derive(Debug, Clone, sqlx::FromRow)]
struct PendingDeliveryRow {
    space_message_id: String,
    conversation_id: String,
    operation_id: String,
    input_id: Option<String>,
    status: String,
    receipt_state: String,
    context_from_seq: Option<i64>,
    wake_deferred_turn_key: Option<String>,
    round_id: Option<String>,
    round_ordinal: Option<i64>,
    round_ready: i64,
}

fn pending_row_on_message(message_id: &str, delivery: PendingDelivery) -> PendingDeliveryRow {
    PendingDeliveryRow {
        space_message_id: message_id.to_string(),
        conversation_id: delivery.conversation_id,
        operation_id: delivery.operation_id,
        input_id: delivery.input_id,
        status: delivery.status,
        receipt_state: delivery.receipt_state,
        context_from_seq: delivery.context_from_seq,
        wake_deferred_turn_key: delivery.wake_deferred_turn_key,
        round_id: delivery.round_id,
        round_ordinal: delivery.round_ordinal,
        round_ready: delivery.round_ready,
    }
}

struct PackedDeliveryMessage {
    seq: i64,
    hop: i64,
    envelope: serde_json::Value,
    content: String,
    display_text: String,
}

async fn load_packed_delivery_message(
    pool: &SqlitePool,
    message_id: &str,
    member_nicknames: &[String],
) -> Result<PackedDeliveryMessage, CollaborationError> {
    let envelope = load_envelope(pool, message_id).await?;
    let seq: i64 = sqlx::query_scalar("SELECT seq FROM collaboration_space_messages WHERE id = ?")
        .bind(message_id)
        .fetch_one(pool)
        .await
        .map_err(db)?;
    let hop: i64 = sqlx::query_scalar("SELECT hop FROM collaboration_space_messages WHERE id = ?")
        .bind(message_id)
        .fetch_optional(pool)
        .await
        .map_err(db)?
        .unwrap_or(0);
    let parsed = parse_space_envelope(&envelope);
    let content = parsed.content.clone();
    let display_text = clean_space_display_text(&content, member_nicknames);
    Ok(PackedDeliveryMessage {
        seq,
        hop,
        envelope,
        content,
        display_text,
    })
}

async fn in_flight_delivery_count(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<i64, CollaborationError> {
    sqlx::query_scalar(
        r#"SELECT COUNT(*)
           FROM collaboration_space_deliveries d
           JOIN collaboration_space_messages m ON m.id = d.space_message_id
           WHERE m.space_id = ? AND d.receipt_state = 'processing'"#,
    )
    .bind(space_id)
    .fetch_one(pool)
    .await
    .map_err(db)
}

pub(crate) async fn deliver_pending(
    pool: &SqlitePool,
    space_id: &str,
    message_id: &str,
    turn_delivery: &DeliveryContext,
) -> Result<SpacePostResult, CollaborationError> {
    let envelope = load_envelope(pool, message_id).await?;
    let seq: i64 = sqlx::query_scalar("SELECT seq FROM collaboration_space_messages WHERE id = ?")
        .bind(message_id)
        .fetch_one(pool)
        .await
        .map_err(db)?;
    let space_members = list_space_members(pool, space_id, MessageAudience::Agent)
        .await
        .unwrap_or_default();
    let member_nicknames: Vec<String> = space_members
        .iter()
        .map(|member| member.nickname.clone())
        .collect();
    let parsed = parse_space_envelope(&envelope);
    let content = parsed.content.clone();
    let display_text = clean_space_display_text(&content, &member_nicknames);
    let same_message = sqlx::query_as::<_, PendingDelivery>(
        r#"SELECT d.conversation_id, d.operation_id, d.input_id, d.status, d.receipt_state,
                  d.context_from_seq, d.wake_deferred_turn_key, d.round_id, d.round_ordinal,
                  CASE WHEN d.round_id IS NULL
                         OR d.round_ordinal <= (SELECT current_ordinal FROM collaboration_rounds r
                                                WHERE r.id = d.round_id AND r.state IN ('open','closing'))
                         OR EXISTS (SELECT 1 FROM collaboration_rounds r
                                    WHERE r.id = d.round_id AND r.state = 'closed')
                       THEN 1 ELSE 0 END AS round_ready
           FROM collaboration_space_deliveries d
           WHERE d.space_message_id = ?
           ORDER BY COALESCE(d.round_ordinal, 0) ASC, d.rowid ASC"#,
    )
    .bind(message_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let other_ready = sqlx::query_as::<_, PendingDeliveryRow>(
        r#"SELECT d.space_message_id, d.conversation_id, d.operation_id, d.input_id, d.status,
                  d.receipt_state, d.context_from_seq, d.wake_deferred_turn_key, d.round_id,
                  d.round_ordinal,
                  CASE WHEN d.round_id IS NULL
                         OR d.round_ordinal <= (SELECT current_ordinal FROM collaboration_rounds r
                                                WHERE r.id = d.round_id AND r.state IN ('open','closing'))
                         OR EXISTS (SELECT 1 FROM collaboration_rounds r
                                    WHERE r.id = d.round_id AND r.state = 'closed')
                       THEN 1 ELSE 0 END AS round_ready
           FROM collaboration_space_deliveries d
           WHERE d.space_message_id != ?
             AND d.round_id IS NOT NULL
             AND TRIM(d.round_id) != ''
             AND d.round_ordinal <= (
                 SELECT r.current_ordinal FROM collaboration_rounds r
                 WHERE r.id = d.round_id
                   AND r.state IN ('open', 'closing')
                   AND r.root_message_id = ?
             )
           ORDER BY COALESCE(d.round_ordinal, 0) ASC, d.rowid ASC"#,
    )
    .bind(message_id)
    .bind(message_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let mut pending: Vec<PendingDeliveryRow> = same_message
        .into_iter()
        .map(|delivery| pending_row_on_message(message_id, delivery))
        .collect();
    pending.extend(other_ready);
    pending.sort_by(|a, b| {
        a.round_ordinal
            .unwrap_or(0)
            .cmp(&b.round_ordinal.unwrap_or(0))
            .then_with(|| a.conversation_id.cmp(&b.conversation_id))
    });
    let mut packed_by_id: std::collections::HashMap<String, PackedDeliveryMessage> =
        std::collections::HashMap::new();
    packed_by_id.insert(
        message_id.to_string(),
        PackedDeliveryMessage {
            seq,
            hop: sqlx::query_scalar("SELECT hop FROM collaboration_space_messages WHERE id = ?")
                .bind(message_id)
                .fetch_optional(pool)
                .await
                .map_err(db)?
                .unwrap_or(0),
            envelope: envelope.clone(),
            content: content.clone(),
            display_text: display_text.clone(),
        },
    );
    let mut in_flight = in_flight_delivery_count(pool, space_id).await?;
    let mut receipts = Vec::new();
    for delivery in pending {
        let Ok(mut conversation_id) = Uuid::parse_str(&delivery.conversation_id) else {
            continue;
        };
        let delivery_message_id = delivery.space_message_id.clone();
        if !packed_by_id.contains_key(&delivery_message_id) {
            let packed =
                load_packed_delivery_message(pool, &delivery_message_id, &member_nicknames).await?;
            packed_by_id.insert(delivery_message_id.clone(), packed);
        }
        let packed = packed_by_id
            .get(&delivery_message_id)
            .expect("packed delivery message");
        let seq = packed.seq;
        let envelope = &packed.envelope;
        let content = packed.content.as_str();
        let display_text = packed.display_text.as_str();
        let chain_limit_exceeded = packed.hop > MAX_ASSISTANT_HOPS_PER_ROOT;
        let nickname = member_nickname(pool, space_id, conversation_id)
            .await?
            .unwrap_or_else(|| conversation_id.to_string());
        if delivery.input_id.is_some()
            || delivery.status == "failed"
            || delivery.status == "skipped_chain_limit"
        {
            receipts.push(DeliveryReceipt {
                conversation_id,
                nickname,
                delivered: delivery.status,
                state: delivery.receipt_state,
                input_id: delivery
                    .input_id
                    .as_deref()
                    .and_then(|id| Uuid::parse_str(id).ok()),
                error_code: None,
            });
            continue;
        }
        if delivery.receipt_state == "cancelled" || delivery.round_ready == 0 {
            receipts.push(DeliveryReceipt {
                conversation_id,
                nickname,
                delivered: delivery.status,
                state: delivery.receipt_state,
                input_id: None,
                error_code: None,
            });
            continue;
        }
        let Ok(operation_id) = Uuid::parse_str(&delivery.operation_id) else {
            continue;
        };
        if chain_limit_exceeded {
            let mut conn = pool.acquire().await.map_err(db)?;
            let _ = sqlx::query("PRAGMA ignore_check_constraints = ON")
                .execute(&mut *conn)
                .await;
            let update_res = sqlx::query(
                r#"UPDATE collaboration_space_deliveries
                   SET status = 'skipped_chain_limit',
                       receipt_state = 'cancelled',
                       wake_deferred_turn_key = NULL,
                       receipt_updated_at = ?
                   WHERE space_message_id = ? AND conversation_id = ?"#,
            )
            .bind(now_stamp())
            .bind(&delivery_message_id)
            .bind(conversation_id.to_string())
            .execute(&mut *conn)
            .await;
            let _ = sqlx::query("PRAGMA ignore_check_constraints = OFF")
                .execute(&mut *conn)
                .await;
            update_res.map_err(db)?;
            receipts.push(DeliveryReceipt {
                conversation_id,
                nickname,
                delivered: "skipped_chain_limit".to_string(),
                state: "cancelled".to_string(),
                input_id: None,
                error_code: Some("chain_limit_exceeded".to_string()),
            });
            continue;
        }
        let target = match load_session(pool, conversation_id).await? {
            Some(session) if session.deleted_at.is_none() && session.status != "archived" => {
                session
            }
            _ => match try_heal_dead_seat(pool, space_id, &delivery_message_id, conversation_id)
                .await?
            {
                Some((healed_id, healed_session)) => {
                    conversation_id = healed_id;
                    healed_session
                }
                None => {
                    mark_delivery_failed(pool, &delivery_message_id, conversation_id).await?;
                    receipts.push(DeliveryReceipt {
                        conversation_id,
                        nickname,
                        delivered: "failed".to_string(),
                        state: delivery.receipt_state.clone(),
                        input_id: None,
                        error_code: Some("not_found".to_string()),
                    });
                    continue;
                }
            },
        };
        let current_round_slot = delivery
            .round_id
            .as_deref()
            .is_some_and(|id| !id.trim().is_empty())
            && delivery.round_ready == 1;
        if in_flight >= MAX_IN_FLIGHT_DELIVERIES_PER_SPACE && !current_round_slot {
            receipts.push(DeliveryReceipt {
                conversation_id,
                nickname,
                delivered: "queued".to_string(),
                state: delivery.receipt_state.clone(),
                input_id: None,
                error_code: None,
            });
            continue;
        }
        if session_is_asleep(pool, conversation_id).await? {
            let released = match delivery.wake_deferred_turn_key.as_deref() {
                // Held earlier over the cap: deliver once the originating
                // turn has ended ("next turn"), never stall.
                Some(key) => !wake_turn_in_flight(pool, key).await?,
                None => false,
            };
            if !released {
                let turn_key = wake_turn_key(pool, &delivery_message_id, envelope).await?;
                if !reserve_wake(
                    pool,
                    &turn_key,
                    conversation_id,
                    &delivery_message_id,
                    wake_cap_per_turn(),
                )
                .await?
                {
                    // Over the per-turn wake cap: held visibly as
                    // 'limit_reached' until the originating turn ends.
                    hold_over_wake_cap(pool, &delivery_message_id, conversation_id, &turn_key)
                        .await?;
                    receipts.push(DeliveryReceipt {
                        conversation_id,
                        nickname,
                        delivered: "deferred".to_string(),
                        state: WAKE_LIMIT_REACHED.to_string(),
                        input_id: None,
                        error_code: Some("wake_limit_exceeded".to_string()),
                    });
                    continue;
                }
            }
        }
        if !try_acquire_member_write(pool, conversation_id).await? {
            receipts.push(DeliveryReceipt {
                conversation_id,
                nickname,
                delivered: "deferred".to_string(),
                state: delivery.receipt_state.clone(),
                input_id: None,
                error_code: Some("write_serialized_busy".to_string()),
            });
            continue;
        }
        if delivery.context_from_seq.is_none() {
            let from = context_window_start(pool, space_id, conversation_id, seq).await?;
            sqlx::query(
                r#"UPDATE collaboration_space_deliveries SET context_from_seq = ?
                   WHERE space_message_id = ? AND conversation_id = ?"#,
            )
            .bind(from)
            .bind(&delivery_message_id)
            .bind(conversation_id.to_string())
            .execute(pool)
            .await
            .map_err(db)?;
        }
        let dest_thread = thread_id_for_conversation(pool, conversation_id)
            .await?
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| space_id.to_string());
        let packed = compose_space_delivery_prompt(
            pool,
            conversation_id,
            &dest_thread,
            seq,
            envelope,
            content,
            display_text,
        )
        .await?;
        let origin = origin_from_envelope(space_id, envelope, &space_members);
        match deliver_text(
            pool,
            conversation_id,
            operation_id,
            &packed,
            Some(display_text.to_string()),
            Some(origin),
            &target,
            json!({
                "kind": "collaboration_space",
                "spaceId": space_id,
                "messageId": delivery_message_id,
            }),
            turn_delivery,
        )
        .await
        {
            Ok(receipt) => {
                let mut delivered_status = receipt.delivered.clone();
                if delivered_status == "queued"
                    && let Some(input_id) = receipt.input_id
                {
                    let input_status: Option<String> =
                        sqlx::query_scalar("SELECT status FROM conversation_inputs WHERE id = ?")
                            .bind(input_id)
                            .fetch_optional(pool)
                            .await
                            .ok()
                            .flatten();
                    if input_status.as_deref() == Some("dispatched") {
                        delivered_status = "dispatched".to_string();
                    }
                }
                let state = if delivered_status == "dispatched" {
                    "processing"
                } else {
                    "queued"
                };
                if state == "processing" {
                    in_flight = in_flight.saturating_add(1);
                }
                let turn_id = if receipt.input_id.is_some() {
                    bind_delivery_turn(
                        pool,
                        &dest_thread,
                        &delivery_message_id,
                        conversation_id,
                        envelope,
                        delivery.round_id.as_deref(),
                        delivery.round_ordinal,
                    )
                    .await?
                } else {
                    None
                };
                // The queue may already have dispatched the input (trigger),
                // so never move a receipt backwards.
                sqlx::query(
                    r#"UPDATE collaboration_space_deliveries
                       SET input_id = ?,
                           status = CASE
                             WHEN ? = 'dispatched' THEN 'dispatched'
                             WHEN ? IS NOT NULL AND EXISTS (
                               SELECT 1 FROM conversation_inputs ci
                               WHERE ci.id = ? AND ci.status = 'dispatched'
                             ) THEN 'dispatched'
                             ELSE ?
                           END,
                           wake_deferred_turn_key = NULL,
                           turn_id = COALESCE(?, turn_id),
                           receipt_state = CASE
                             WHEN ? = 'processing' THEN 'processing'
                             WHEN ? IS NOT NULL AND EXISTS (
                               SELECT 1 FROM conversation_inputs ci
                               WHERE ci.id = ? AND ci.status = 'dispatched'
                             ) THEN 'processing'
                             WHEN receipt_state = 'queued' THEN ?
                             ELSE receipt_state
                           END,
                           receipt_updated_at = ?
                       WHERE space_message_id = ? AND conversation_id = ?"#,
                )
                .bind(receipt.input_id.map(|id| id.to_string()))
                .bind(&delivered_status)
                .bind(receipt.input_id)
                .bind(receipt.input_id)
                .bind(&delivered_status)
                .bind(turn_id.as_deref())
                .bind(state)
                .bind(receipt.input_id)
                .bind(receipt.input_id)
                .bind(state)
                .bind(now_stamp())
                .bind(&delivery_message_id)
                .bind(conversation_id.to_string())
                .execute(pool)
                .await
                .map_err(db)?;
                advance_last_seen(pool, space_id, conversation_id, &delivery_message_id, seq)
                    .await?;
                touch_session_activity(pool, conversation_id).await?;
                let state: String = sqlx::query_scalar(
                    r#"SELECT receipt_state FROM collaboration_space_deliveries
                       WHERE space_message_id = ? AND conversation_id = ?"#,
                )
                .bind(&delivery_message_id)
                .bind(conversation_id.to_string())
                .fetch_one(pool)
                .await
                .map_err(db)?;
                receipts.push(DeliveryReceipt {
                    conversation_id,
                    nickname,
                    delivered: receipt.delivered,
                    state,
                    input_id: receipt.input_id,
                    error_code: None,
                });
            }
            Err(error) => {
                if error.code != "limit_exceeded" {
                    mark_delivery_failed(pool, &delivery_message_id, conversation_id).await?;
                    finish_open_turn(pool, &delivery_message_id, conversation_id, "error").await?;
                }
                receipts.push(DeliveryReceipt {
                    conversation_id,
                    nickname,
                    delivered: "failed".to_string(),
                    state: delivery.receipt_state.clone(),
                    input_id: None,
                    error_code: Some(error.code.to_string()),
                });
            }
        }
    }
    Ok(SpacePostResult {
        message_id: message_id.to_string(),
        seq,
        receipts,
    })
}

/// Most recent missed group messages packed verbatim into one delivery;
/// older missed messages collapse into a one-line summary.
pub const MISSED_CONTEXT_VERBATIM: usize = 15;
/// Furthest back (in messages) a missed-context window ever reaches.
pub(crate) const MISSED_CONTEXT_LIMIT: i64 = 500;
/// Per-message character cap inside the packed block.
pub(crate) const MISSED_CONTEXT_MESSAGE_CHARS: usize = 1500;

/// Thread binding (`collaboration_thread_members`) of a seat conversation.
pub(crate) async fn seat_binding(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<identity::ThreadMemberRow>, CollaborationError> {
    identity::binding_of_conversation(pool, conversation_id)
        .await
        .map_err(db)
}

/// Exclusive lower seq bound of the missed-context window for a delivery of
/// message `seq`: the member's last seen message in this thread, or (never
/// seen) the last `MISSED_CONTEXT_LIMIT` messages.
pub(crate) async fn context_window_start(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    seq: i64,
) -> Result<i64, CollaborationError> {
    let last_seen = match seat_binding(pool, conversation_id).await? {
        Some(binding) => binding_last_seen_seq(pool, space_id, &binding).await?,
        None => None,
    };
    let floor = (seq - 1 - MISSED_CONTEXT_LIMIT).max(0);
    Ok(last_seen
        .map_or(floor, |seen| seen.max(floor))
        .min(seq - 1)
        .max(0))
}

pub(crate) async fn binding_last_seen_seq(
    pool: &SqlitePool,
    space_id: &str,
    binding: &identity::ThreadMemberRow,
) -> Result<Option<i64>, CollaborationError> {
    sqlx::query_scalar::<_, i64>(
        r#"SELECT m.seq FROM collaboration_thread_members tm
           JOIN collaboration_space_messages m
             ON m.id = tm.last_seen_message_id AND m.space_id = ?
           WHERE tm.thread_id = ? AND tm.member_id = ?"#,
    )
    .bind(space_id)
    .bind(&binding.thread_id)
    .bind(&binding.member_id)
    .fetch_optional(pool)
    .await
    .map_err(db)
}

/// Highest seq this conversation already finished (`replied` / `passed`)
/// or authored/observed during a completed turn in `space_id`. `None` when it
/// has never completed a delivery.
pub(crate) async fn last_completed_delivery_seq(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
) -> Result<Option<i64>, CollaborationError> {
    let cid = conversation_id.to_string();
    let delivery_max = sqlx::query_scalar::<_, Option<i64>>(
        r#"SELECT MAX(m.seq) FROM collaboration_space_deliveries d
           JOIN collaboration_space_messages m ON m.id = d.space_message_id
           WHERE d.conversation_id = ?
             AND m.space_id = ?
             AND d.receipt_state IN ('replied', 'passed')"#,
    )
    .bind(&cid)
    .bind(space_id)
    .fetch_one(pool)
    .await
    .map_err(db)?;
    let Some(mut max_seq) = delivery_max else {
        return Ok(None);
    };

    let nickname = member_nickname(pool, space_id, conversation_id)
        .await
        .ok()
        .flatten();
    let agent_rows = sqlx::query_as::<_, (i64, String)>(
        r#"SELECT seq, envelope_json FROM collaboration_space_messages
           WHERE space_id = ? AND seq > ? AND origin = 'agent'
           ORDER BY seq DESC LIMIT ?"#,
    )
    .bind(space_id)
    .bind(max_seq)
    .bind(MISSED_CONTEXT_LIMIT)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    for (seq, raw) in &agent_rows {
        let parsed = parse_space_envelope_str(raw);
        if envelope_sender_is_conversation(&parsed, conversation_id, nickname.as_deref()) {
            max_seq = max_seq.max(*seq);
            break;
        }
    }

    let earlier_round_peers = sqlx::query_as::<_, (String, i64)>(
        r#"SELECT DISTINCT d_prev.conversation_id, COALESCE(m_root.seq, 0)
           FROM collaboration_space_deliveries d
           JOIN collaboration_space_messages m_root ON m_root.id = d.space_message_id
           JOIN collaboration_space_deliveries d_prev ON d_prev.round_id = d.round_id
           WHERE d.conversation_id = ?
             AND m_root.space_id = ?
             AND d.receipt_state IN ('replied', 'passed')
             AND d.round_id IS NOT NULL
             AND COALESCE(d.round_ordinal, 0) > 1
             AND COALESCE(d_prev.round_ordinal, 0) > 0
             AND COALESCE(d_prev.round_ordinal, 0) < COALESCE(d.round_ordinal, 0)"#,
    )
    .bind(&cid)
    .bind(space_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    for (peer_cid_raw, root_seq) in earlier_round_peers {
        let Ok(peer_cid) = Uuid::parse_str(&peer_cid_raw) else {
            continue;
        };
        let peer_nick = member_nickname(pool, space_id, peer_cid)
            .await
            .ok()
            .flatten();
        for (seq, raw) in &agent_rows {
            if *seq <= root_seq {
                continue;
            }
            let parsed = parse_space_envelope_str(raw);
            if envelope_sender_is_conversation(&parsed, peer_cid, peer_nick.as_deref()) {
                max_seq = max_seq.max(*seq);
            }
        }
    }

    Ok(Some(max_seq))
}

/// One-line speaking-order trail for a multi-bot round this delivery belongs
/// to. `None` when the delivery is not part of a round with at least two members.
pub(crate) async fn round_speaking_order_line(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    seq: i64,
) -> Result<Option<String>, CollaborationError> {
    let round_id: Option<String> = sqlx::query_scalar(
        r#"SELECT d.round_id FROM collaboration_space_deliveries d
           JOIN collaboration_space_messages m ON m.id = d.space_message_id
           WHERE d.conversation_id = ?
             AND m.space_id = ?
             AND m.seq <= ?
             AND d.round_id IS NOT NULL
             AND TRIM(d.round_id) != ''
           ORDER BY m.seq DESC, COALESCE(d.round_ordinal, 0) DESC
           LIMIT 1"#,
    )
    .bind(conversation_id.to_string())
    .bind(space_id)
    .bind(seq)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let Some(round_id) = round_id else {
        return Ok(None);
    };
    let current_ordinal: i64 =
        sqlx::query_scalar("SELECT current_ordinal FROM collaboration_rounds WHERE id = ?")
            .bind(&round_id)
            .fetch_optional(pool)
            .await
            .map_err(db)?
            .unwrap_or(1);
    let members: Vec<(String, i64, String, i64)> = sqlx::query_as(
        r#"SELECT d.conversation_id, COALESCE(d.round_ordinal, 0), d.receipt_state, COALESCE(m.seq, 0)
           FROM collaboration_space_deliveries d
           LEFT JOIN collaboration_space_messages m ON m.id = d.space_message_id
           WHERE d.round_id = ?
           ORDER BY COALESCE(d.round_ordinal, 2147483647), d.conversation_id"#,
    )
    .bind(&round_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    if members.len() < 2 {
        return Ok(None);
    }
    let self_cid = conversation_id.to_string();
    let self_has_current = members
        .iter()
        .any(|(cid, ordinal, _, _)| cid == &self_cid && *ordinal == current_ordinal);
    let mut parts = Vec::new();
    for (cid, ordinal, state, slot_seq) in members {
        let cid_uuid = Uuid::parse_str(&cid).ok();
        let nick = match cid_uuid {
            Some(id) => member_nickname(pool, space_id, id)
                .await?
                .unwrap_or_else(|| cid.clone()),
            None => cid.clone(),
        };
        let is_self_active_slot =
            cid_uuid == Some(conversation_id) && (ordinal == current_ordinal || !self_has_current);
        let status = if is_self_active_slot {
            "you, now"
        } else if state == "passed" {
            "passed"
        } else if state == "processing" && ordinal > 0 && ordinal < current_ordinal {
            let posted = match cid_uuid {
                Some(id) => member_posted_after(pool, space_id, id, slot_seq)
                    .await
                    .unwrap_or(false),
                None => false,
            };
            if posted { "posted" } else { "working" }
        } else if matches!(
            state.as_str(),
            "replied" | "timed_out" | "cancelled" | "failed"
        ) || (ordinal > 0 && ordinal < current_ordinal)
        {
            "posted"
        } else {
            "waiting"
        };
        parts.push(format!("@{nick} ({status})"));
    }
    Ok(Some(parts.join(" → ")))
}

/// Nicknames of other Bots currently mid-turn in this GroupSpace.
pub(crate) async fn working_peers_line(
    pool: &SqlitePool,
    space_id: &str,
    exclude_conversation_id: Uuid,
    before_seq: i64,
) -> Result<Option<String>, CollaborationError> {
    if !is_group_space(space_id) {
        return Ok(None);
    }
    let rows: Vec<String> = sqlx::query_scalar(
        r#"SELECT DISTINCT COALESCE(NULLIF(TRIM(sm.nickname), ''), d.conversation_id)
           FROM collaboration_space_deliveries d
           JOIN collaboration_space_messages m ON m.id = d.space_message_id
           LEFT JOIN collaboration_space_members sm
             ON sm.space_id = m.space_id AND sm.conversation_id = d.conversation_id
           LEFT JOIN collaboration_turns t ON t.id = d.turn_id
           WHERE m.space_id = ?
             AND m.seq < ?
             AND d.conversation_id != ?
             AND (
               d.receipt_state = 'processing'
               OR t.state = 'running'
               OR EXISTS (
                 SELECT 1 FROM collaboration_turns ct
                 WHERE ct.space_id = m.space_id
                   AND ct.conversation_id = d.conversation_id
                   AND ct.state = 'running'
               )
             )
           ORDER BY COALESCE(NULLIF(TRIM(sm.nickname), ''), d.conversation_id)"#,
    )
    .bind(space_id)
    .bind(before_seq)
    .bind(exclude_conversation_id.to_string())
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let extra: Vec<String> = sqlx::query_scalar(
        r#"SELECT DISTINCT COALESCE(NULLIF(TRIM(sm.nickname), ''), t.conversation_id)
           FROM collaboration_turns t
           JOIN collaboration_space_messages m ON m.id = t.space_message_id
           LEFT JOIN collaboration_space_members sm
             ON sm.space_id = t.space_id AND sm.conversation_id = t.conversation_id
           WHERE t.space_id = ?
             AND t.state = 'running'
             AND t.conversation_id != ?
             AND m.seq < ?
           ORDER BY COALESCE(NULLIF(TRIM(sm.nickname), ''), t.conversation_id)"#,
    )
    .bind(space_id)
    .bind(exclude_conversation_id.to_string())
    .bind(before_seq)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let mut names = Vec::new();
    for name in rows.into_iter().chain(extra) {
        let name = name.trim();
        if name.is_empty() || names.iter().any(|existing: &String| existing == name) {
            continue;
        }
        names.push(name.to_string());
    }
    if names.is_empty() {
        return Ok(None);
    }
    let list = names
        .iter()
        .map(|name| format!("@{name} (working)"))
        .collect::<Vec<_>>()
        .join("、");
    Ok(Some(list))
}

/// Group messages in `(from_seq, before_seq)` that this conversation did not
/// author, rendered as a "while you were away" block. `None` when empty.
#[cfg(test)]
pub(crate) async fn missed_group_context(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    from_seq: i64,
    before_seq: i64,
) -> Result<Option<String>, CollaborationError> {
    let lines =
        fetch_missed_group_lines(pool, space_id, conversation_id, from_seq, before_seq).await?;
    Ok(format_missed_group_block(
        "[上次发言后的群内新消息]",
        &lines,
    ))
}

/// Higher truncation limit for pinned root/parent task messages so child bots
/// keep Master's or User's full task specification even in busy groups.
pub(crate) const PINNED_ROOT_CONTEXT_CHARS: usize = 4000;

async fn try_heal_dead_seat(
    pool: &SqlitePool,
    space_id: &str,
    delivery_message_id: &str,
    old_conversation_id: Uuid,
) -> Result<Option<(Uuid, SessionHead)>, CollaborationError> {
    let binding = identity::binding_of_conversation(pool, old_conversation_id)
        .await
        .map_err(db)?;
    let Some(binding) = binding.filter(|b| b.status == "active") else {
        return Ok(None);
    };
    let still_in_space: Option<i64> = sqlx::query_scalar(
        r#"SELECT 1 FROM collaboration_space_members
           WHERE space_id = ? AND conversation_id = ? AND kind = 'agent'
           LIMIT 1"#,
    )
    .bind(space_id)
    .bind(old_conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    if still_in_space.is_none() && binding.thread_id != space_id {
        return Ok(None);
    }

    let healed_id = match resolve_session(pool, &binding.member_id, &binding.thread_id).await {
        Ok(id) => id,
        Err(error) => {
            tracing::warn!(
                %space_id,
                old_conversation_id = %old_conversation_id,
                member_id = %binding.member_id,
                %error,
                "failed to heal dead collaboration seat during delivery"
            );
            return Ok(None);
        }
    };
    let Some(healed_session) = load_session(pool, healed_id).await? else {
        return Ok(None);
    };
    if healed_session.deleted_at.is_some() || healed_session.status == "archived" {
        return Ok(None);
    }
    if healed_id != old_conversation_id {
        sqlx::query(
            r#"UPDATE collaboration_space_members
               SET conversation_id = ?
               WHERE space_id = ? AND conversation_id = ?"#,
        )
        .bind(healed_id.to_string())
        .bind(space_id)
        .bind(old_conversation_id.to_string())
        .execute(pool)
        .await
        .map_err(db)?;
        sqlx::query(
            r#"UPDATE collaboration_space_deliveries
               SET conversation_id = ?
               WHERE space_message_id = ?
                 AND conversation_id = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM collaboration_space_deliveries d2
                   WHERE d2.space_message_id = collaboration_space_deliveries.space_message_id
                     AND d2.conversation_id = ?
                 )"#,
        )
        .bind(healed_id.to_string())
        .bind(delivery_message_id)
        .bind(old_conversation_id.to_string())
        .bind(healed_id.to_string())
        .execute(pool)
        .await
        .map_err(db)?;
    }
    Ok(Some((healed_id, healed_session)))
}

/// Split incremental group messages since `from_seq` around `trigger_seq` so
/// messages before `#trigger_seq` appear above the trigger envelope and
/// messages after `#trigger_seq` (e.g. earlier speakers' replies in the same
/// sequential round) appear below the trigger envelope in chronological order.
///
/// Always pins the trigger's root/parent task ancestor(s) verbatim at the top
/// of the pre-trigger missed context (with [`PINNED_ROOT_CONTEXT_CHARS`]) when
/// they fall outside the latest `MISSED_CONTEXT_VERBATIM` window or within the
/// current missed window, avoiding duplicates.
pub(crate) async fn split_missed_group_context(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    from_seq: i64,
    trigger_seq: i64,
) -> Result<(Option<String>, Option<String>), CollaborationError> {
    let lines =
        fetch_missed_group_lines(pool, space_id, conversation_id, from_seq, trigger_seq).await?;
    let pinned =
        fetch_pinned_task_ancestors(pool, space_id, conversation_id, from_seq, trigger_seq).await?;
    if lines.is_empty() && pinned.is_empty() {
        return Ok((None, None));
    }
    let pinned_seqs: std::collections::HashSet<i64> =
        pinned.iter().map(|(seq, _, _)| *seq).collect();
    let pre: Vec<(i64, String, String)> = lines
        .iter()
        .filter(|(seq, _, _)| *seq < trigger_seq && !pinned_seqs.contains(seq))
        .cloned()
        .collect();
    let post: Vec<(i64, String, String)> = lines
        .iter()
        .filter(|(seq, _, _)| *seq > trigger_seq)
        .cloned()
        .collect();
    let has_pre = !pinned.is_empty() || !pre.is_empty();
    match (has_pre, post.is_empty()) {
        (false, true) => Ok((None, None)),
        (true, true) => Ok((
            format_missed_group_block_with_pinned("[上次发言后的群内新消息]", &pinned, &pre),
            None,
        )),
        (false, false) => Ok((
            None,
            format_missed_group_block("[上次发言后的群内新消息]", &post),
        )),
        (true, false) => Ok((
            format_missed_group_block_with_pinned("[上次发言后的群内新消息]", &pinned, &pre),
            format_missed_group_block("[本轮新增群内消息]", &post),
        )),
    }
}

async fn fetch_pinned_task_ancestors(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    from_seq: i64,
    trigger_seq: i64,
) -> Result<Vec<(i64, String, String)>, CollaborationError> {
    let trigger_row: Option<(String, Option<String>, String)> = sqlx::query_as(
        r#"SELECT id, root_id, envelope_json
           FROM collaboration_space_messages
           WHERE space_id = ? AND seq = ?
           LIMIT 1"#,
    )
    .bind(space_id)
    .bind(trigger_seq)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let Some((trigger_id, trigger_root_id, trigger_raw)) = trigger_row else {
        return Ok(Vec::new());
    };
    let trigger_parsed = parse_space_envelope_str(&trigger_raw);
    let mut target_ids: Vec<String> = Vec::new();
    let mut push_unique = |id: &str| {
        let trimmed = id.trim();
        if !trimmed.is_empty()
            && trimmed != trigger_id
            && !target_ids.iter().any(|existing| existing == trimmed)
        {
            target_ids.push(trimmed.to_string());
        }
    };
    if let Some(ref root) = trigger_root_id {
        push_unique(root);
    }
    if let Some(ref parent) = trigger_parsed.reply_to {
        push_unique(parent);
    }
    // If `root_id` was not recorded or matched the trigger itself, walk `reply_to`
    // up to 16 hops to recover the thread's original task root as well.
    let needs_walk = trigger_root_id
        .as_deref()
        .map(str::trim)
        .is_none_or(|r| r.is_empty() || r == trigger_id);
    if needs_walk && let Some(mut cursor) = trigger_parsed.reply_to.clone() {
        let mut seen_walk = std::collections::HashSet::new();
        seen_walk.insert(trigger_id.clone());
        let mut root_candidate: Option<String> = None;
        for _ in 0..16 {
            if !seen_walk.insert(cursor.clone()) {
                break;
            }
            let raw: Option<String> = sqlx::query_scalar(
                r#"SELECT envelope_json FROM collaboration_space_messages
                   WHERE space_id = ? AND id = ?
                   LIMIT 1"#,
            )
            .bind(space_id)
            .bind(&cursor)
            .fetch_optional(pool)
            .await
            .map_err(db)?;
            let Some(raw) = raw else {
                break;
            };
            root_candidate = Some(cursor.clone());
            let parsed = parse_space_envelope_str(&raw);
            let Some(next) = parsed
                .reply_to
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
            else {
                break;
            };
            cursor = next;
        }
        if let Some(root) = root_candidate {
            push_unique(&root);
        }
    }
    if target_ids.is_empty() {
        return Ok(Vec::new());
    }

    let nickname = member_nickname(pool, space_id, conversation_id)
        .await
        .ok()
        .flatten();
    let mut pinned: Vec<(i64, String, String)> = Vec::new();
    for anc_id in target_ids {
        let row: Option<(i64, String, String)> = sqlx::query_as(
            r#"SELECT seq, origin, envelope_json
               FROM collaboration_space_messages
               WHERE space_id = ? AND id = ?
               LIMIT 1"#,
        )
        .bind(space_id)
        .bind(&anc_id)
        .fetch_optional(pool)
        .await
        .map_err(db)?;
        let Some((anc_seq, origin, raw)) = row else {
            continue;
        };
        if origin == "system" || anc_seq >= trigger_seq {
            continue;
        }
        // Pin when the ancestor is in the missed window (`anc_seq > from_seq`) OR
        // when > `MISSED_CONTEXT_VERBATIM` messages have intervened since it was posted.
        if anc_seq <= from_seq && trigger_seq - anc_seq <= MISSED_CONTEXT_VERBATIM as i64 {
            continue;
        }
        let parsed = parse_space_envelope_str(&raw);
        if envelope_sender_is_conversation(&parsed, conversation_id, nickname.as_deref()) {
            continue;
        }
        let who = if parsed.sender.is_empty() {
            "Bot".to_string()
        } else {
            parsed.sender
        };
        pinned.push((anc_seq, who, parsed.content));
    }
    pinned.sort_by_key(|(seq, _, _)| *seq);
    pinned.dedup_by_key(|(seq, _, _)| *seq);
    Ok(pinned)
}

async fn fetch_missed_group_lines(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    from_seq: i64,
    exclude_seq: i64,
) -> Result<Vec<(i64, String, String)>, CollaborationError> {
    let nickname = member_nickname(pool, space_id, conversation_id)
        .await
        .ok()
        .flatten();
    let rows = sqlx::query_as::<_, (i64, String)>(
        r#"SELECT seq, envelope_json FROM collaboration_space_messages
           WHERE space_id = ? AND seq > ? AND seq != ? AND origin != 'system'
           ORDER BY seq DESC LIMIT ?"#,
    )
    .bind(space_id)
    .bind(from_seq)
    .bind(exclude_seq)
    .bind(MISSED_CONTEXT_LIMIT)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let mut lines = Vec::new();
    for (seq, raw) in rows {
        let parsed = parse_space_envelope_str(&raw);
        if envelope_sender_is_conversation(&parsed, conversation_id, nickname.as_deref()) {
            continue;
        }
        let who = if parsed.sender.is_empty() {
            "Bot".to_string()
        } else {
            parsed.sender
        };
        lines.push((seq, who, parsed.content));
    }
    lines.reverse();
    Ok(lines)
}

fn truncate_missed_message(content: &str, max_chars: usize) -> String {
    if content.chars().count() > max_chars {
        content.chars().take(max_chars).collect::<String>()
            + "…（完整内容请调用 read_space_messages）"
    } else {
        content.to_string()
    }
}

fn format_missed_group_block(header: &str, lines: &[(i64, String, String)]) -> Option<String> {
    format_missed_group_block_with_pinned(header, &[], lines)
}

fn format_missed_group_block_with_pinned(
    header: &str,
    pinned: &[(i64, String, String)],
    lines: &[(i64, String, String)],
) -> Option<String> {
    if pinned.is_empty() && lines.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for (seq, who, content) in pinned {
        let content = truncate_missed_message(content, PINNED_ROOT_CONTEXT_CHARS);
        out.push(format!("[#{seq}] {who}: {content}"));
    }
    let older = lines.len().saturating_sub(MISSED_CONTEXT_VERBATIM);
    if older > 0 {
        let collapsed = &lines[..older];
        let mut who: Vec<&str> = Vec::new();
        for (_, name, _) in collapsed {
            if !who.contains(&name.as_str()) {
                who.push(name);
            }
        }
        out.push(format!(
            "[#{}–#{}] 更早 {older} 条来自 {}（已折叠；完整内容请调用 read_space_messages）",
            collapsed[0].0,
            collapsed[older - 1].0,
            who.join("、")
        ));
    }
    for (seq, who, content) in &lines[older..] {
        let content = truncate_missed_message(content, MISSED_CONTEXT_MESSAGE_CHARS);
        out.push(format!("[#{seq}] {who}: {content}"));
    }
    Some(format!("{header}\n{}", out.join("\n")))
}

/// Record that the member behind `conversation_id` has now seen `message_id`
/// (seq `seq`) in this thread. Never moves backwards.
pub(crate) async fn advance_last_seen(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    message_id: &str,
    seq: i64,
) -> Result<(), CollaborationError> {
    let Some(binding) = seat_binding(pool, conversation_id).await? else {
        return Ok(());
    };
    let current = binding_last_seen_seq(pool, space_id, &binding).await?;
    if current.is_some_and(|seen| seen >= seq) {
        return Ok(());
    }
    sqlx::query(
        r#"UPDATE collaboration_thread_members SET last_seen_message_id = ?
           WHERE thread_id = ? AND member_id = ?"#,
    )
    .bind(message_id)
    .bind(&binding.thread_id)
    .bind(&binding.member_id)
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(())
}

/// Retry deliveries that were deferred (wake cap or write serialization):
/// queued rows with no input yet. Returns how many messages were retried.
pub async fn redeliver_deferred(
    pool: &SqlitePool,
    delivery: &DeliveryContext,
) -> Result<usize, CollaborationError> {
    let pending = sqlx::query_as::<_, (String, String)>(
        r#"SELECT DISTINCT m.space_id, d.space_message_id
           FROM collaboration_space_deliveries d
           JOIN collaboration_space_messages m ON m.id = d.space_message_id
           WHERE d.status = 'queued' AND d.input_id IS NULL
             AND (d.round_id IS NULL
                  OR d.round_ordinal <= (SELECT current_ordinal FROM collaboration_rounds r
                                         WHERE r.id = d.round_id AND r.state IN ('open','closing'))
                  OR EXISTS (SELECT 1 FROM collaboration_rounds r
                             WHERE r.id = d.round_id AND r.state = 'closed'))
           LIMIT 100"#,
    )
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let mut retried = pending.len();
    for (space_id, message_id) in &pending {
        if let Err(error) = deliver_pending(pool, space_id, message_id, delivery).await {
            tracing::warn!(%error, %message_id, "deferred space delivery retry failed");
        }
    }

    let queued_with_input = sqlx::query_as::<_, (String, String, String, Option<String>)>(
        r#"SELECT d.space_message_id, d.conversation_id, d.input_id, ci.status
           FROM collaboration_space_deliveries d
           LEFT JOIN conversation_inputs ci
             ON lower(hex(ci.id)) = replace(lower(d.input_id), '-', '')
           WHERE d.receipt_state = 'queued'
             AND d.input_id IS NOT NULL
             AND TRIM(d.input_id) != ''
           LIMIT 100"#,
    )
    .fetch_all(pool)
    .await
    .map_err(db)?;

    for (space_message_id, cid_raw, _input_id, ci_status) in queued_with_input {
        let Ok(conversation_id) = Uuid::parse_str(&cid_raw) else {
            continue;
        };
        let mut dispatched = ci_status.as_deref() == Some("dispatched");
        if !dispatched
            && ci_status.as_deref() == Some("queued")
            && let Some(dispatcher) = &delivery.dispatcher
        {
            match dispatcher.start_if_idle(conversation_id).await {
                Ok(Some(_)) => {
                    dispatched = true;
                }
                Ok(None) => {
                    let current_status: Option<String> = sqlx::query_scalar(
                        r#"SELECT ci.status
                           FROM collaboration_space_deliveries d
                           JOIN conversation_inputs ci
                             ON lower(hex(ci.id)) = replace(lower(d.input_id), '-', '')
                           WHERE d.space_message_id = ? AND d.conversation_id = ?
                           LIMIT 1"#,
                    )
                    .bind(&space_message_id)
                    .bind(&cid_raw)
                    .fetch_optional(pool)
                    .await
                    .ok()
                    .flatten();
                    if current_status.as_deref() == Some("dispatched") {
                        dispatched = true;
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        %error,
                        %conversation_id,
                        %space_message_id,
                        "deferred queued input start_if_idle failed"
                    );
                }
            }
        }
        if dispatched {
            let now = now_stamp();
            let _ = sqlx::query(
                r#"UPDATE collaboration_space_deliveries
                   SET status = 'dispatched',
                       receipt_state = 'processing',
                       receipt_updated_at = ?
                   WHERE space_message_id = ?
                     AND conversation_id = ?
                     AND receipt_state = 'queued'"#,
            )
            .bind(&now)
            .bind(&space_message_id)
            .bind(&cid_raw)
            .execute(pool)
            .await;
            retried += 1;
        }
    }

    Ok(retried)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collaboration::{
        PostToSpace, post_to_space,
        test_support::{create_session, setup_pool, space_of},
    };

    #[tokio::test]
    async fn split_missed_group_context_pins_root_task_verbatim_past_15_messages_and_preserves_over_1500_chars()
     {
        let pool = setup_pool().await;
        let ws = Uuid::new_v4();
        let master = Uuid::new_v4();
        let peer = Uuid::new_v4();
        let child = Uuid::new_v4();
        create_session(&pool, master, ws, Some("Master")).await;
        create_session(&pool, peer, ws, Some("Peer")).await;
        create_session(&pool, child, ws, Some("Child")).await;

        let space_id = space_of(&pool, master).await;
        for (cid, name) in [(peer, "Peer"), (child, "Child")] {
            crate::collaboration::add_space_member(
                &pool,
                master,
                &space_id,
                cid,
                name,
                Uuid::new_v4(),
            )
            .await
            .expect("add member");
        }

        // 1. Root task message (#1) with > 1500 chars (2200+ chars) and a unique tail marker.
        let body_filler = "任务需求背景与验收标准说明。".repeat(160);
        let root_spec = format!("ROOT_SPEC_HEADER_81 {body_filler} END_OF_ROOT_SPEC_TOKEN_81");
        assert!(
            root_spec.chars().count() > MISSED_CONTEXT_MESSAGE_CHARS,
            "root spec must exceed 1500 chars"
        );
        assert!(
            root_spec.chars().count() < PINNED_ROOT_CONTEXT_CHARS,
            "root spec should fit inside pinned cap"
        );

        let root_post = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(master),
                space_id: space_id.clone(),
                content: root_spec,
                summary: None,
                to: vec!["Peer".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .expect("post root task");

        // 2. Intervene with 18 messages (> MISSED_CONTEXT_VERBATIM = 15) from Peer/Master.
        for i in 1..=18 {
            let sender = if i % 2 == 0 { master } else { peer };
            post_to_space(
                &pool,
                PostToSpace {
                    caller_id: Some(sender),
                    space_id: space_id.clone(),
                    content: format!("Intervening chatter round {i}"),
                    summary: None,
                    to: Vec::new(),
                    in_reply_to: Some(root_post.message_id.clone()),
                    operation_id: Uuid::new_v4(),
                },
            )
            .await
            .expect("post intervening message");
        }

        // 3. Final @Child mention replying to the root task (#20).
        let trigger_post = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(master),
                space_id: space_id.clone(),
                content: "@Child please implement the plan now".to_string(),
                summary: None,
                to: vec!["Child".to_string()],
                in_reply_to: Some(root_post.message_id.clone()),
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .expect("post trigger mention");

        let (pre, post) = split_missed_group_context(&pool, &space_id, child, 0, trigger_post.seq)
            .await
            .expect("split missed context");
        assert!(post.is_none());
        let pre = pre.expect("expected pre-trigger missed context");

        // Root task (#1) must be pinned verbatim at the top, not folded or truncated at 1500 chars.
        let first_content_line = pre.lines().nth(1).expect("first line after header");
        assert!(
            first_content_line.starts_with(&format!("[#{}]", root_post.seq)),
            "root task must be pinned at top of missed context, got: {first_content_line}"
        );
        assert!(
            pre.contains("ROOT_SPEC_HEADER_81") && pre.contains("END_OF_ROOT_SPEC_TOKEN_81"),
            "pinned root task must preserve >1500 chars verbatim"
        );
        assert_eq!(
            pre.matches("ROOT_SPEC_HEADER_81").count(),
            1,
            "pinned root task must not be duplicated"
        );
        // Older intervening chatter should still be collapsed cleanly without folding #1.
        assert!(
            pre.contains("已折叠"),
            "older intervening messages beyond verbatim window should be folded: {pre}"
        );
        assert!(
            !pre.contains("root_id"),
            "rendered context must never leak internal root_id field"
        );
    }

    #[tokio::test]
    async fn deliver_pending_heals_soft_deleted_and_archived_group_seats_before_not_found() {
        let pool = setup_pool().await;
        let ws = Uuid::new_v4();
        let leader = Uuid::new_v4();
        let worker = Uuid::new_v4();
        create_session(&pool, leader, ws, Some("Leader")).await;
        create_session(&pool, worker, ws, Some("Worker")).await;

        let space_id = space_of(&pool, leader).await;
        let added = crate::collaboration::add_space_member(
            &pool,
            leader,
            &space_id,
            worker,
            "Worker",
            Uuid::new_v4(),
        )
        .await
        .expect("add worker seat");
        let seat_cid = Uuid::parse_str(added.conversation_id.as_deref().unwrap()).unwrap();

        // 1. Soft-delete the worker's seat session row before posting a mention.
        sqlx::query("UPDATE sessions SET deleted_at = datetime('now') WHERE id = ?")
            .bind(seat_cid)
            .execute(&pool)
            .await
            .expect("soft-delete worker seat");

        let post1 = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(leader),
                space_id: space_id.clone(),
                content: "@Worker please handle task 1".to_string(),
                summary: None,
                to: vec!["Worker".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .expect("post after soft-delete");

        let receipt1 = post1
            .receipts
            .iter()
            .find(|r| r.nickname == "Worker")
            .expect("worker receipt 1");
        assert_ne!(
            receipt1.delivered, "failed",
            "soft-deleted seat should self-heal instead of failing with not_found: {receipt1:?}"
        );
        assert_eq!(receipt1.error_code, None);
        assert_ne!(receipt1.conversation_id, seat_cid);
        let healed_cid_1 = receipt1.conversation_id;

        // 2. Archive the healed seat session row and post again -> heals again!
        sqlx::query("UPDATE sessions SET status = 'archived' WHERE id = ?")
            .bind(healed_cid_1)
            .execute(&pool)
            .await
            .expect("archive healed seat");

        let post2 = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(leader),
                space_id: space_id.clone(),
                content: "@Worker please handle task 2".to_string(),
                summary: None,
                to: vec!["Worker".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .expect("post after archive");

        let receipt2 = post2
            .receipts
            .iter()
            .find(|r| r.nickname == "Worker")
            .expect("worker receipt 2");
        assert_ne!(
            receipt2.delivered, "failed",
            "archived seat should self-heal instead of failing with not_found: {receipt2:?}"
        );
        assert_eq!(receipt2.error_code, None);
        assert_ne!(receipt2.conversation_id, healed_cid_1);
    }
}
