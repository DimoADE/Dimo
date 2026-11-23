//! Two-phase lazy + background legacy JSONL transcript backfill into SQLite.
//!
//! Ensures `ReadPool` (`query_only = ON`) never executes writes while legacy `.jsonl`
//! transcripts are migrated at most once on `WritePool` inside a single `BEGIN IMMEDIATE`
//! transaction and indexed into row-level `conversation_fts`.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use agents::{
    AgentKind,
    acp_transcript::dimo_acp_transcripts_root,
    conversation::{
        ContentBlock, ConversationEvent, ConversationInputBlock, ConversationPlanEntry,
        ConversationSteeringEvent, ConversationToolCallPatch, ConversationUsage, MessageTurn,
        TurnRole,
    },
    parsers::loader::load_import_conversation_detail,
};
use db::models::{
    conversation::{ConversationAgentBindingRecord, ConversationRecord},
    conversation_event::{
        AppendConversationEvent, find_conversation_event_by_idempotency, insert_conversation_event,
    },
    conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    session::Session,
};
use sqlx::{Row, SqliteConnection, SqlitePool};
use uuid::Uuid;

use super::ConversationProjector;

const DEFAULT_BACKGROUND_BATCH_SIZE: i64 = 8;
const BACKGROUND_YIELD_INTERVAL: Duration = Duration::from_millis(250);

/// Register the SQLite-authoritative `session/load` replay gate probe on `ReadPool`.
///
/// Once registered, `agents::acp_transcript` consults `conversation_turns` and
/// `conversation_events` (plus in-process memory claims) instead of `.jsonl` files
/// to block duplicate `session/load` history replays across restarts.
pub fn register_acp_replay_history_probe(read_pool: db::ReadPool) {
    agents::acp_transcript::register_recorded_history_probe(Arc::new(
        move |conversation_id, _agent_dir, acp_session_id| {
            let pool = read_pool.as_pool().clone();
            Box::pin(async move {
                has_sqlite_recorded_history(&pool, conversation_id, &acp_session_id).await
            })
        },
    ));
}

async fn has_sqlite_recorded_history(
    read_pool: &SqlitePool,
    conversation_id: Option<Uuid>,
    acp_session_id: &str,
) -> bool {
    let resolved_id = match conversation_id {
        Some(id) => Some(id),
        None if !acp_session_id.trim().is_empty() => sqlx::query_scalar::<_, Uuid>(
            "SELECT conversation_id FROM conversation_agent_bindings
              WHERE acp_session_id = ?
              ORDER BY created_at DESC
              LIMIT 1",
        )
        .bind(acp_session_id.trim())
        .fetch_optional(read_pool)
        .await
        .ok()
        .flatten()
        .or(sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM sessions WHERE external_session_id = ? LIMIT 1",
        )
        .bind(acp_session_id.trim())
        .fetch_optional(read_pool)
        .await
        .ok()
        .flatten()),
        None => None,
    };

    let Some(cid) = resolved_id else {
        return false;
    };

    sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(
             SELECT 1 FROM conversation_turns
              WHERE conversation_id = ?1
                AND NOT (status = 'pending' AND prompt_id IS NULL)
         ) OR EXISTS(
             SELECT 1 FROM conversation_events
              WHERE conversation_id = ?1
                AND event_kind IN (
                    'assistant_text_delta',
                    'assistant_reasoning_delta',
                    'assistant_content_appended',
                    'tool_call_upsert',
                    'plan_updated',
                    'turn_completed'
                )
         )",
    )
    .bind(cid)
    .fetch_one(read_pool)
    .await
    .map(|v| v != 0)
    .unwrap_or(false)
}

/// Two-phase lazy migration of a legacy `.jsonl` conversation into SQLite:
///
/// 1. **Phase 1 (`ReadPool` — strictly read-only, outside any transaction)**:
///    Checks `sessions.legacy_jsonl_migrated`; if `1` or missing, returns `Ok(false)`.
///    Otherwise reads `Session` metadata and flushes/parses any on-disk `.jsonl` transcript
///    outside of SQLite transactions.
/// 2. **Phase 2 (`WritePool` — single `BEGIN IMMEDIATE` write transaction)**:
///    Re-checks `legacy_jsonl_migrated` inside the write lock (race-safe idempotency),
///    synthesizes canonical `ConversationEvent`s with deterministic idempotency keys when
///    content events are absent, rebuilds `conversation_timeline_rows` +
///    `conversation_projection_snapshots` + row-level `conversation_fts`, and flips
///    `sessions.legacy_jsonl_migrated = 1`.
pub async fn ensure_legacy_jsonl_migrated(
    read_pool: &db::ReadPool,
    write_pool: &db::WritePool,
    conversation_id: Uuid,
) -> Result<bool, sqlx::Error> {
    ensure_legacy_jsonl_migrated_with_pools(
        read_pool.as_pool(),
        write_pool.as_pool(),
        conversation_id,
    )
    .await
}

/// Single-pool convenience wrapper for callers/tests holding a unified writable `SqlitePool`.
pub async fn ensure_legacy_jsonl_migrated_on_pool(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<bool, sqlx::Error> {
    ensure_legacy_jsonl_migrated_with_pools(pool, pool, conversation_id).await
}

fn turn_content_fingerprint(turn: &MessageTurn) -> String {
    serde_json::to_string(&turn.blocks).unwrap_or_default()
}

fn turns_have_assistant_content(turns: &[MessageTurn]) -> bool {
    turns
        .iter()
        .any(|t| matches!(t.role, TurnRole::Assistant) && !t.blocks.is_empty())
}

fn merge_legacy_turn_chunks(mut chunks: Vec<(i64, usize, Vec<MessageTurn>)>) -> Vec<MessageTurn> {
    chunks.sort_by_key(|(first_ts, source_idx, _)| (*first_ts, *source_idx));
    let mut merged: Vec<MessageTurn> = Vec::new();
    let mut seen_non_acp_ids: HashSet<String> = HashSet::new();
    let mut seen_prev_source_turns: HashSet<(u8, i64, String)> = HashSet::new();

    for (_, _, chunk_turns) in chunks {
        let mut chunk_fingerprints: Vec<(u8, i64, String)> = Vec::with_capacity(chunk_turns.len());
        let mut chunk_non_acp_ids: Vec<String> = Vec::new();
        for turn in chunk_turns {
            let role_tag = match turn.role {
                TurnRole::User => 0u8,
                TurnRole::Assistant => 1u8,
                TurnRole::System => 2u8,
            };
            let is_non_acp_id = !turn.id.is_empty() && !turn.id.starts_with("acp-");
            if is_non_acp_id && seen_non_acp_ids.contains(&turn.id) {
                continue;
            }
            let fp = (
                role_tag,
                turn.timestamp.timestamp_millis(),
                turn_content_fingerprint(&turn),
            );
            if seen_prev_source_turns.contains(&fp) {
                continue;
            }
            if is_non_acp_id {
                chunk_non_acp_ids.push(turn.id.clone());
            }
            chunk_fingerprints.push(fp);
            merged.push(turn);
        }
        for id in chunk_non_acp_ids {
            seen_non_acp_ids.insert(id);
        }
        for fp in chunk_fingerprints {
            seen_prev_source_turns.insert(fp);
        }
    }
    merged
}

async fn load_legacy_turns_outside_tx(
    read_pool: &SqlitePool,
    conversation_id: Uuid,
    session: &Session,
) -> Option<Vec<MessageTurn>> {
    if let Ok(Some(segment_turns)) = crate::transcript_segments::read_in(
        read_pool,
        &dimo_acp_transcripts_root(),
        conversation_id,
    )
    .await
        && !segment_turns.is_empty()
    {
        return Some(segment_turns);
    }

    let mut visited_chains: HashSet<(String, String)> = HashSet::new();
    let mut visited_vendor: HashSet<(String, String)> = HashSet::new();
    let mut chunks: Vec<(i64, usize, Vec<MessageTurn>)> = Vec::new();
    let mut next_source_idx = 0usize;

    let mut push_chunk = |turns: Vec<MessageTurn>| {
        if turns.is_empty() {
            return;
        }
        let first_ts = turns
            .first()
            .map(|t| t.timestamp.timestamp_millis())
            .unwrap_or(i64::MAX);
        chunks.push((first_ts, next_source_idx, turns));
        next_source_idx += 1;
    };

    // 1. Collect transcripts across ALL historical `(binding.agent_id, binding.acp_session_id)`
    //    entries in chronological order, checking each binding's own `agent_dir` AND native
    //    vendor fallback when ACP JSONL has no assistant turns.
    if let Ok(bindings) =
        ConversationAgentBindingRecord::list_for_conversation(read_pool, conversation_id).await
    {
        for binding in &bindings {
            let Some(acp_sid) = binding
                .acp_session_id
                .as_deref()
                .map(str::trim)
                .filter(|sid| !sid.is_empty() && !agents::is_placeholder_acp_session_id(sid))
            else {
                continue;
            };
            let agent_str = binding.agent_id.as_str();
            let acp_turns = crate::jsonl_history::flush_and_read_transcript_turns_for_binding(
                Some(agent_str),
                acp_sid,
                &mut visited_chains,
            )
            .await;

            if let Some(turns) = acp_turns.as_ref()
                && turns_have_assistant_content(turns)
            {
                push_chunk(turns.clone());
                continue;
            }

            let vendor_turns = AgentKind::from_lenient(agent_str).and_then(|kind| {
                if !visited_vendor.insert((kind.as_str().to_string(), acp_sid.to_string())) {
                    return None;
                }
                load_import_conversation_detail(kind, acp_sid, None)
                    .ok()
                    .flatten()
                    .map(|detail| detail.turns)
                    .filter(|turns| !turns.is_empty())
            });

            if let Some(turns) = vendor_turns {
                push_chunk(turns);
            } else if let Some(turns) = acp_turns {
                push_chunk(turns);
            }
        }
    }

    // 2. Also check `session`'s own `(agent_id / executor, external_session_id)` if it wasn't
    //    already covered by a binding record (e.g. legacy sessions created before bindings existed).
    let session_agent_str = session
        .agent_id
        .as_ref()
        .map(|id| id.as_str())
        .or(session.executor.as_deref());
    let session_kind = session_agent_str.and_then(AgentKind::from_lenient);
    if let Some(external) = session
        .external_session_id
        .as_deref()
        .map(str::trim)
        .filter(|sid| !sid.is_empty() && !agents::is_placeholder_acp_session_id(sid))
    {
        let acp_turns = crate::jsonl_history::flush_and_read_transcript_turns_for_binding(
            session_agent_str,
            external,
            &mut visited_chains,
        )
        .await;
        if let Some(turns) = acp_turns.as_ref()
            && turns_have_assistant_content(turns)
        {
            push_chunk(turns.clone());
        } else {
            let vendor_turns = session_kind.and_then(|kind| {
                if !visited_vendor.insert((kind.as_str().to_string(), external.to_string())) {
                    return None;
                }
                load_import_conversation_detail(kind, external, None)
                    .ok()
                    .flatten()
                    .map(|detail| detail.turns)
                    .filter(|turns| !turns.is_empty())
            });
            if let Some(turns) = vendor_turns {
                push_chunk(turns);
            } else if let Some(turns) = acp_turns {
                push_chunk(turns);
            }
        }
    }

    // 3. Collect any conversation-id-keyed legacy transcripts across ALL agent directories.
    for conv_turns in crate::jsonl_history::flush_and_read_all_transcript_turns_for_conversation(
        conversation_id,
        &mut visited_chains,
    )
    .await
    {
        push_chunk(conv_turns);
    }

    let merged = merge_legacy_turn_chunks(chunks);
    (!merged.is_empty()).then_some(merged)
}

async fn ensure_legacy_jsonl_migrated_with_pools(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<bool, sqlx::Error> {
    // Phase 1: Pure ReadPool queries + disk transcript read outside any SQLite transaction.
    match ConversationRecord::is_legacy_jsonl_migrated(read_pool, conversation_id).await? {
        None | Some(true) => return Ok(false),
        Some(false) => {}
    }

    let Some(session) = Session::find_by_id(read_pool, conversation_id).await? else {
        return Ok(false);
    };

    let jsonl_turns = load_legacy_turns_outside_tx(read_pool, conversation_id, &session).await;

    // Phase 2: Single `BEGIN IMMEDIATE` write transaction on WritePool.
    let mut conn = write_pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

    match backfill_on_connection(&mut conn, conversation_id, jsonl_turns.as_deref()).await {
        Ok(migrated) => {
            if let Err(commit_err) = sqlx::query("COMMIT").execute(&mut *conn).await {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                super::cache::evict_write_projector(conversation_id);
                return Err(commit_err);
            }
            Ok(migrated)
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            super::cache::evict_write_projector(conversation_id);
            Err(error)
        }
    }
}

/// Migrate up to `batch_size` unmigrated conversations (`legacy_jsonl_migrated = 0`).
/// Returns the number of conversations flipped to `legacy_jsonl_migrated = 1` in this batch.
pub async fn backfill_next_legacy_batch(
    read_pool: &db::ReadPool,
    write_pool: &db::WritePool,
    batch_size: i64,
) -> Result<usize, sqlx::Error> {
    if batch_size <= 0 {
        return Ok(0);
    }
    let candidate_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM sessions
          WHERE legacy_jsonl_migrated = 0 AND deleted_at IS NULL
          ORDER BY updated_at DESC
          LIMIT ?",
    )
    .bind(batch_size)
    .fetch_all(read_pool.as_pool())
    .await?;

    let mut migrated_count = 0usize;
    for conversation_id in candidate_ids {
        if ensure_legacy_jsonl_migrated(read_pool, write_pool, conversation_id).await? {
            migrated_count += 1;
        }
    }
    Ok(migrated_count)
}

/// Spawn a low-priority background worker that drains unmigrated legacy `.jsonl` sessions
/// in small batches while yielding between batches so live turns never starve on `WritePool(1)`.
pub fn spawn_legacy_jsonl_backfill_worker(
    read_pool: db::ReadPool,
    write_pool: db::WritePool,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let remaining: i64 = match sqlx::query_scalar(
                "SELECT COUNT(*) FROM sessions
                  WHERE legacy_jsonl_migrated = 0 AND deleted_at IS NULL",
            )
            .fetch_one(read_pool.as_pool())
            .await
            {
                Ok(count) => count,
                Err(error) => {
                    tracing::warn!(%error, "legacy jsonl backfill worker count query failed");
                    return;
                }
            };
            if remaining <= 0 {
                return;
            }
            match backfill_next_legacy_batch(&read_pool, &write_pool, DEFAULT_BACKGROUND_BATCH_SIZE)
                .await
            {
                Ok(0) => return,
                Ok(_) => tokio::time::sleep(BACKGROUND_YIELD_INTERVAL).await,
                Err(error) => {
                    tracing::warn!(%error, "legacy jsonl backfill batch failed");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
        }
    })
}

#[derive(Default)]
struct LegacyRound<'a> {
    user_turn: Option<&'a MessageTurn>,
    steers: Vec<&'a MessageTurn>,
    assistant_turns: Vec<&'a MessageTurn>,
}

fn group_legacy_rounds(turns: &[MessageTurn]) -> Vec<LegacyRound<'_>> {
    let mut rounds: Vec<LegacyRound<'_>> = Vec::new();
    for turn in turns {
        match turn.role {
            TurnRole::User => {
                if turn.id.contains(":steer:") {
                    if let Some(last) = rounds.last_mut() {
                        last.steers.push(turn);
                    } else {
                        rounds.push(LegacyRound {
                            user_turn: None,
                            steers: vec![turn],
                            assistant_turns: Vec::new(),
                        });
                    }
                } else {
                    rounds.push(LegacyRound {
                        user_turn: Some(turn),
                        steers: Vec::new(),
                        assistant_turns: Vec::new(),
                    });
                }
            }
            TurnRole::Assistant => {
                if let Some(last) = rounds.last_mut() {
                    last.assistant_turns.push(turn);
                } else {
                    rounds.push(LegacyRound {
                        user_turn: None,
                        steers: Vec::new(),
                        assistant_turns: vec![turn],
                    });
                }
            }
            TurnRole::System => {}
        }
    }
    rounds
}

async fn backfill_on_connection(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    jsonl_turns: Option<&[MessageTurn]>,
) -> Result<bool, sqlx::Error> {
    // Race-safe idempotency re-check inside `BEGIN IMMEDIATE`.
    match ConversationRecord::is_legacy_jsonl_migrated(&mut *conn, conversation_id).await? {
        None | Some(true) => return Ok(false),
        Some(false) => {}
    }

    if let Some(turns) = jsonl_turns.filter(|t| !t.is_empty()) {
        synthesize_legacy_events_on_connection(&mut *conn, conversation_id, turns).await?;
    }

    ConversationProjector::rebuild_on_connection(&mut *conn, conversation_id).await?;
    let flipped =
        ConversationRecord::mark_legacy_jsonl_migrated_on_connection(&mut *conn, conversation_id)
            .await?;
    Ok(flipped)
}

#[derive(Debug)]
struct ExistingDbTurn {
    id: Uuid,
    event_kinds: HashSet<String>,
    user_text: Option<String>,
    assistant_text: String,
    has_assistant_content: bool,
}

fn turn_has_assistant_content(kinds: &HashSet<String>) -> bool {
    kinds.contains("assistant_text_delta")
        || kinds.contains("assistant_reasoning_delta")
        || kinds.contains("assistant_content_appended")
        || kinds.contains("tool_call_upsert")
        || kinds.contains("plan_updated")
}

fn normalize_match_text(raw: &str) -> String {
    let mut out = String::new();
    let mut prev_ws = false;
    for ch in raw.trim().chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                out.push(' ');
                prev_ws = true;
            }
        } else {
            out.push(ch);
            prev_ws = false;
        }
        if out.len() >= 160 {
            break;
        }
    }
    out
}

fn texts_match(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
    let min_len = a.len().min(b.len());
    min_len >= 16 && (a.starts_with(b) || b.starts_with(a))
}

fn extract_user_text_from_event(normalized_json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(normalized_json).ok()?;
    let blocks = value.get("blocks")?.as_array()?;
    blocks.iter().find_map(|block| {
        if block.get("type").and_then(|v| v.as_str()) == Some("text") {
            block
                .get("text")
                .and_then(|v| v.as_str())
                .map(normalize_match_text)
                .filter(|s| !s.is_empty())
        } else {
            None
        }
    })
}

fn extract_assistant_delta_text(normalized_json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(normalized_json).ok()?;
    value
        .get("text")
        .and_then(|v| v.as_str())
        .map(ToString::to_string)
}

fn match_round_to_db_turn(
    round_idx: usize,
    round: &LegacyRound<'_>,
    db_turns: &[ExistingDbTurn],
    used_db_turns: &[bool],
) -> Option<usize> {
    let round_user = round
        .user_turn
        .and_then(|u| first_text_preview(&u.blocks))
        .map(|s| normalize_match_text(&s))
        .filter(|s| !s.is_empty());
    let round_assistant = round
        .assistant_turns
        .iter()
        .find_map(|a| first_text_preview(&a.blocks))
        .map(|s| normalize_match_text(&s))
        .filter(|s| !s.is_empty());

    // Pass 1: Match by user prompt text, verifying assistant text compatibility
    // when the DB turn already has materialized assistant content.
    if let Some(ref ru) = round_user {
        for (idx, db_turn) in db_turns.iter().enumerate() {
            if used_db_turns[idx] {
                continue;
            }
            let Some(ref du) = db_turn.user_text else {
                continue;
            };
            if !texts_match(ru, du) {
                continue;
            }
            if db_turn.has_assistant_content {
                let da = normalize_match_text(&db_turn.assistant_text);
                if let Some(ref ra) = round_assistant
                    && !da.is_empty()
                    && !texts_match(ra, &da)
                {
                    continue;
                }
            }
            return Some(idx);
        }
    }

    // Pass 2: If the round has no user prompt, match by materialized assistant text.
    if round_user.is_none()
        && let Some(ref ra) = round_assistant
    {
        for (idx, db_turn) in db_turns.iter().enumerate() {
            if used_db_turns[idx] || !db_turn.has_assistant_content {
                continue;
            }
            let da = normalize_match_text(&db_turn.assistant_text);
            if texts_match(ra, &da) {
                return Some(idx);
            }
        }
    }

    // Pass 3: Positional pairing for stub DB turns that have no assistant content yet.
    if round_idx < db_turns.len()
        && !used_db_turns[round_idx]
        && !db_turns[round_idx].has_assistant_content
    {
        return Some(round_idx);
    }

    None
}

async fn synthesize_legacy_events_on_connection(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    turns: &[MessageTurn],
) -> Result<(), sqlx::Error> {
    let rounds = group_legacy_rounds(turns);
    if rounds.is_empty() {
        return Ok(());
    }

    let db_turn_rows = sqlx::query(
        "SELECT id, text_preview FROM conversation_turns
          WHERE conversation_id = ?
          ORDER BY ordinal ASC",
    )
    .bind(conversation_id)
    .fetch_all(&mut *conn)
    .await?;

    let mut db_turns: Vec<ExistingDbTurn> = Vec::with_capacity(db_turn_rows.len());
    let mut db_turn_index_by_id: HashMap<Uuid, usize> = HashMap::with_capacity(db_turn_rows.len());
    for row in db_turn_rows {
        let id: Uuid = row.try_get("id")?;
        let text_preview: Option<String> = row.try_get("text_preview")?;
        let normalized_preview = text_preview
            .as_deref()
            .map(normalize_match_text)
            .filter(|s| !s.is_empty());
        let idx = db_turns.len();
        db_turn_index_by_id.insert(id, idx);
        db_turns.push(ExistingDbTurn {
            id,
            event_kinds: HashSet::new(),
            user_text: normalized_preview,
            assistant_text: String::new(),
            has_assistant_content: false,
        });
    }

    let existing_rows = sqlx::query(
        "SELECT turn_id, event_kind, normalized_json FROM conversation_events
          WHERE conversation_id = ?
          ORDER BY sequence ASC",
    )
    .bind(conversation_id)
    .fetch_all(&mut *conn)
    .await?;

    for row in existing_rows {
        let maybe_turn_id: Option<Uuid> = row.try_get("turn_id")?;
        let event_kind: String = row.try_get("event_kind")?;
        let normalized_json: String = row.try_get("normalized_json")?;
        let Some(tid) = maybe_turn_id else {
            continue;
        };
        let Some(&idx) = db_turn_index_by_id.get(&tid) else {
            continue;
        };
        let db_turn = &mut db_turns[idx];
        db_turn.event_kinds.insert(event_kind.clone());
        if event_kind == "user_turn_created"
            && let Some(text) = extract_user_text_from_event(&normalized_json)
        {
            db_turn.user_text = Some(text);
        } else if event_kind == "assistant_text_delta"
            && db_turn.assistant_text.len() < 512
            && let Some(delta) = extract_assistant_delta_text(&normalized_json)
        {
            db_turn.assistant_text.push_str(&delta);
        }
    }
    for db_turn in &mut db_turns {
        db_turn.has_assistant_content = turn_has_assistant_content(&db_turn.event_kinds);
    }

    let mut used_db_turns = vec![false; db_turns.len()];

    for (round_idx, round) in rounds.iter().enumerate() {
        let matched_idx = match_round_to_db_turn(round_idx, round, &db_turns, &used_db_turns);
        if let Some(idx) = matched_idx {
            used_db_turns[idx] = true;
            if db_turns[idx].has_assistant_content {
                // This round already has assistant content materialized in SQLite
                // (e.g., a post-engine-switch turn); skip to avoid duplicating events.
                continue;
            }
        }

        let (turn_id, existing_kinds) = match matched_idx {
            Some(idx) => (db_turns[idx].id, Some(&db_turns[idx].event_kinds)),
            None => {
                let preview = round
                    .user_turn
                    .and_then(|u| first_text_preview(&u.blocks))
                    .unwrap_or_default();
                let deterministic_turn_id = Uuid::new_v5(
                    &Uuid::NAMESPACE_OID,
                    format!("legacy-turn:{conversation_id}:{round_idx}").as_bytes(),
                );
                let created = ConversationTurnRecord::create_pending_on_connection(
                    &mut *conn,
                    deterministic_turn_id,
                    CreateConversationTurn {
                        conversation_id,
                        prompt_id: None,
                        text_preview: (!preview.is_empty()).then_some(preview.as_str()),
                        input_blocks_json: "[]",
                    },
                )
                .await?;
                (created.id, None)
            }
        };

        let has_user_created = existing_kinds.is_some_and(|s| s.contains("user_turn_created"));
        let has_steering = existing_kinds.is_some_and(|s| s.contains("conversation_steering"));
        let has_terminal_event = existing_kinds.is_some_and(|s| {
            s.contains("turn_completed")
                || s.contains("turn_failed")
                || s.contains("turn_cancelled")
                || s.contains("turn_interrupted")
        });

        let mut synthesized: Vec<(&'static str, ConversationEvent)> = Vec::new();

        if !has_user_created && let Some(user_turn) = round.user_turn {
            let blocks = input_blocks_from_content_blocks(&user_turn.blocks);
            if !blocks.is_empty() {
                synthesized.push((
                    "user",
                    ConversationEvent::UserTurnCreated {
                        blocks,
                        workflow_refs: Vec::new(),
                    },
                ));
            }
        }

        // Pair assistant segments with mid-turn steering slices in order when present.
        if !has_steering && !round.steers.is_empty() {
            if let Some(first_assistant) = round.assistant_turns.first() {
                append_assistant_turn_events(first_assistant, &mut synthesized);
            }
            for (steer_idx, steer_turn) in round.steers.iter().enumerate() {
                let blocks = input_blocks_from_content_blocks(&steer_turn.blocks);
                if !blocks.is_empty() {
                    let steering_id = Uuid::new_v5(
                        &Uuid::NAMESPACE_OID,
                        format!("legacy-steer:{conversation_id}:{round_idx}:{steer_idx}")
                            .as_bytes(),
                    );
                    let operation_id = Uuid::new_v5(
                        &Uuid::NAMESPACE_OID,
                        format!("legacy-steer-op:{conversation_id}:{round_idx}:{steer_idx}")
                            .as_bytes(),
                    );
                    synthesized.push((
                        "user",
                        ConversationEvent::ConversationSteering {
                            event: ConversationSteeringEvent::Requested {
                                steering_id,
                                operation_id,
                                expected_turn_id: turn_id,
                                payload_digest: format!("legacy-{round_idx}-{steer_idx}"),
                                blocks,
                                principal: serde_json::json!({ "kind": "user" }),
                            },
                        },
                    ));
                    synthesized.push((
                        "acp",
                        ConversationEvent::ConversationSteering {
                            event: ConversationSteeringEvent::Accepted {
                                steering_id,
                                expected_turn_id: turn_id,
                                delivery_mode: Some(
                                    agents::conversation::ConversationSteeringDeliveryMode::Native,
                                ),
                                restarted_turn_id: None,
                            },
                        },
                    ));
                }
                if let Some(next_assistant) = round.assistant_turns.get(steer_idx + 1) {
                    append_assistant_turn_events(next_assistant, &mut synthesized);
                }
            }
            for extra_assistant in round.assistant_turns.iter().skip(round.steers.len() + 1) {
                append_assistant_turn_events(extra_assistant, &mut synthesized);
            }
        } else {
            for assistant_turn in &round.assistant_turns {
                append_assistant_turn_events(assistant_turn, &mut synthesized);
            }
        }

        let round_settled = round
            .assistant_turns
            .last()
            .is_some_and(|a| a.completed_at.is_some())
            || has_terminal_event;
        if round_settled && !has_terminal_event && !round.assistant_turns.is_empty() {
            synthesized.push((
                "acp",
                ConversationEvent::TurnCompleted {
                    stop_reason: Some("end_turn".to_string()),
                },
            ));
        }

        for (ev_idx, (source, event)) in synthesized.into_iter().enumerate() {
            let idempotency_key = format!("legacy-jsonl:{conversation_id}:{round_idx}:{ev_idx}");
            if find_conversation_event_by_idempotency(
                &mut *conn,
                conversation_id,
                Some(idempotency_key.as_str()),
            )
            .await?
            .is_some()
            {
                continue;
            }
            let event_value =
                serde_json::to_value(&event).map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
            let event_kind = event_value
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let normalized_json =
                serde_json::to_string(&event).map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
            let event_id = Uuid::new_v5(&Uuid::NAMESPACE_OID, idempotency_key.as_bytes());
            insert_conversation_event(
                &mut *conn,
                AppendConversationEvent {
                    id: event_id,
                    conversation_id,
                    turn_id: Some(turn_id),
                    binding_id: None,
                    connection_id: None,
                    prompt_id: None,
                    source,
                    event_kind: &event_kind,
                    normalized_json: &normalized_json,
                    raw_json: None,
                    idempotency_key: Some(idempotency_key.as_str()),
                },
            )
            .await?;
        }
    }

    Ok(())
}

fn first_text_preview(blocks: &[ContentBlock]) -> Option<String> {
    blocks.iter().find_map(|block| match block {
        ContentBlock::Text { text } if !text.trim().is_empty() => {
            Some(text.chars().take(160).collect())
        }
        _ => None,
    })
}

fn input_blocks_from_content_blocks(blocks: &[ContentBlock]) -> Vec<ConversationInputBlock> {
    let mut out = Vec::new();
    for block in blocks {
        match block {
            ContentBlock::Text { text } if !text.is_empty() => {
                out.push(ConversationInputBlock::Text { text: text.clone() });
            }
            ContentBlock::Image {
                data,
                mime_type,
                uri,
                ..
            } => {
                let resolved_uri = uri
                    .clone()
                    .filter(|u| !u.is_empty())
                    .unwrap_or_else(|| format!("data:{mime_type};base64,{data}"));
                out.push(ConversationInputBlock::Image {
                    uri: resolved_uri,
                    mime_type: mime_type.clone(),
                    title: None,
                });
            }
            ContentBlock::Resource { uri, title } => {
                out.push(ConversationInputBlock::Resource {
                    uri: uri.clone(),
                    title: title.clone(),
                    mime_type: None,
                });
            }
            ContentBlock::Protocol { content } => {
                out.push(ConversationInputBlock::Protocol {
                    content: content.clone(),
                });
            }
            _ => {}
        }
    }
    out
}

fn append_assistant_turn_events(
    turn: &MessageTurn,
    out: &mut Vec<(&'static str, ConversationEvent)>,
) {
    let mut tool_seq = 0usize;
    for block in &turn.blocks {
        match block {
            ContentBlock::Thinking { text } if !text.is_empty() => {
                out.push((
                    "acp",
                    ConversationEvent::AssistantReasoningDelta {
                        text: text.clone(),
                        message_id: turn.agent_message_id.clone(),
                    },
                ));
            }
            ContentBlock::Text { text } if !text.is_empty() => {
                out.push((
                    "acp",
                    ConversationEvent::AssistantTextDelta {
                        text: text.clone(),
                        message_id: turn.agent_message_id.clone(),
                    },
                ));
            }
            ContentBlock::Image { .. }
            | ContentBlock::ImageGeneration { .. }
            | ContentBlock::Resource { .. }
            | ContentBlock::Protocol { .. } => {
                out.push((
                    "acp",
                    ConversationEvent::AssistantContentAppended {
                        block: block.clone(),
                        message_id: turn.agent_message_id.clone(),
                    },
                ));
            }
            ContentBlock::Plan { entries } => {
                let mapped_entries = entries
                    .iter()
                    .enumerate()
                    .map(|(idx, entry)| ConversationPlanEntry {
                        id: format!("plan-{idx}"),
                        content: entry.content.clone(),
                        status: entry.status.clone(),
                        priority: entry.priority.clone(),
                    })
                    .collect();
                out.push((
                    "acp",
                    ConversationEvent::PlanUpdated {
                        entries: mapped_entries,
                    },
                ));
            }
            ContentBlock::ToolUse {
                tool_use_id,
                tool_name,
                status,
                kind,
                input_preview,
                meta,
                images,
                ..
            } => {
                tool_seq += 1;
                let call_id = tool_use_id
                    .clone()
                    .unwrap_or_else(|| format!("legacy-tool-{tool_seq}"));
                let raw_input = input_preview.as_deref().map(|raw| {
                    serde_json::from_str(raw)
                        .unwrap_or_else(|_| serde_json::Value::String(raw.to_string()))
                });
                out.push((
                    "acp",
                    ConversationEvent::ToolCallUpsert {
                        tool_call: ConversationToolCallPatch {
                            tool_call_id: call_id,
                            title: Some(tool_name.clone()),
                            kind: kind.clone().or_else(|| Some(tool_name.clone())),
                            status: status.clone().or_else(|| Some("in_progress".to_string())),
                            raw_input,
                            raw_output: None,
                            raw_output_append: None,
                            content: None,
                            locations: None,
                            metadata: meta.clone(),
                            images: images.clone(),
                        },
                    },
                ));
            }
            ContentBlock::ToolResult {
                tool_use_id,
                output_preview,
                is_error,
                ..
            } => {
                let call_id = tool_use_id
                    .clone()
                    .unwrap_or_else(|| format!("legacy-tool-{}", tool_seq.max(1)));
                let raw_output = output_preview
                    .as_ref()
                    .map(|text| serde_json::Value::String(text.clone()));
                out.push((
                    "acp",
                    ConversationEvent::ToolCallUpsert {
                        tool_call: ConversationToolCallPatch {
                            tool_call_id: call_id,
                            title: None,
                            kind: None,
                            status: Some(
                                if *is_error { "failed" } else { "completed" }.to_string(),
                            ),
                            raw_input: None,
                            raw_output,
                            raw_output_append: None,
                            content: None,
                            locations: None,
                            metadata: None,
                            images: Vec::new(),
                        },
                    },
                ));
            }
            _ => {}
        }
    }

    if let Some(usage) = &turn.usage {
        out.push((
            "acp",
            ConversationEvent::UsageUpdated {
                usage: ConversationUsage {
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    cache_creation_input_tokens: usage.cache_creation_input_tokens,
                    cache_read_input_tokens: usage.cache_read_input_tokens,
                    context_used: usage.context_used,
                    context_window_max: usage.context_window_max,
                    cost_amount: usage.cost_amount,
                    cost_currency: usage.cost_currency.clone(),
                    model: turn.model.clone(),
                },
            },
        ));
    }
}

#[cfg(test)]
mod tests {
    use agents::{
        AgentId,
        acp_transcript::{self, EntryKind, TranscriptHeader, dimo_acp_transcripts_root},
        conversation::ConversationTimelineRow,
    };
    use db::models::conversation::CreateConversationRecord;

    use super::*;

    async fn seed_legacy_session(
        db: &db::DBService,
        title: &str,
        prompt: &str,
        assistant_reply: &str,
    ) -> Uuid {
        let writer = db.writer().as_pool();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(writer)
            .await
            .expect("disable fk for test seed");

        let conversation_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        let external_sid = format!("acp-backfill-{}", Uuid::new_v4().simple());
        let agent_id = AgentId::parse("codex").expect("agent id");

        ConversationRecord::create(
            writer,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: Some(title),
                initial_prompt: Some(prompt),
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .expect("create conversation");

        Session::update_agent_metadata(
            writer,
            conversation_id,
            Some(&external_sid),
            Some(&agent_id),
        )
        .await
        .expect("bind external session id");

        ConversationTurnRecord::create_pending(
            writer,
            turn_id,
            CreateConversationTurn {
                conversation_id,
                prompt_id: None,
                text_preview: Some(prompt),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn");

        // Mark session as legacy unmigrated (`0`), simulating a pre-cutover row.
        sqlx::query("UPDATE sessions SET legacy_jsonl_migrated = 0 WHERE id = ?")
            .bind(conversation_id)
            .execute(writer)
            .await
            .expect("set legacy_jsonl_migrated = 0");

        // Ensure test transcript isolation is active before writing JSONL entries.
        let _ = crate::jsonl_history::read_existing_transcript_turns(conversation_id);
        let root = dimo_acp_transcripts_root();
        let header = TranscriptHeader::new("codex", &external_sid, "/workspace", 1_700_000_000_000);
        let _ = acp_transcript::record_header_in(&root, "codex", &header).await;
        let _ = acp_transcript::record_entry_in(
            &root,
            "codex",
            &external_sid,
            EntryKind::Prompt,
            serde_json::json!([{ "type": "text", "text": prompt }]),
        )
        .await;
        drop(acp_transcript::record_entry_in(
            &root,
            "codex",
            &external_sid,
            EntryKind::Update,
            serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": assistant_reply }
            }),
        ));
        drop(acp_transcript::record_entry_in(
            &root,
            "codex",
            &external_sid,
            EntryKind::Update,
            serde_json::json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "call-legacy-1",
                "title": "Run cargo test",
                "kind": "execute",
                "status": "in_progress",
                "rawInput": { "command": "cargo test" }
            }),
        ));
        drop(acp_transcript::record_entry_in(
            &root,
            "codex",
            &external_sid,
            EntryKind::Update,
            serde_json::json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call-legacy-1",
                "status": "completed",
                "content": [{ "type": "content", "content": { "type": "text", "text": "ok" } }]
            }),
        ));
        let _ = acp_transcript::record_entry_in(
            &root,
            "codex",
            &external_sid,
            EntryKind::TurnEnd,
            serde_json::json!({
                "stopReason": "end_turn",
                "durationMs": 250,
                "usage": {
                    "inputTokens": 120,
                    "outputTokens": 45,
                    "cacheCreationInputTokens": 0,
                    "cacheReadInputTokens": 0
                }
            }),
        )
        .await;

        conversation_id
    }

    #[tokio::test]
    async fn read_only_read_pool_plus_write_pool_backfills_legacy_jsonl_once_and_indexes_fts() {
        let db = db::DBService::new_in_memory_for_tests()
            .await
            .expect("in-memory dual-pool db");
        let conversation_id = seed_legacy_session(
            &db,
            "Legacy Backfill Test",
            "Inspect legacy quantum circuit",
            "Backfilled answer token QuartzNebula99.",
        )
        .await;

        // First call: Phase 1 reads on `query_only = ON` ReadPool (no SQLITE_READONLY!),
        // Phase 2 writes on WritePool(1) and flips `legacy_jsonl_migrated = 1`.
        let migrated = ensure_legacy_jsonl_migrated(db.reader(), db.writer(), conversation_id)
            .await
            .expect("two-phase backfill succeeds without SQLITE_READONLY");
        assert!(migrated, "first backfill should migrate session");
        assert_eq!(
            ConversationRecord::is_legacy_jsonl_migrated(db.reader().as_pool(), conversation_id)
                .await
                .expect("read migration flag"),
            Some(true)
        );

        let event_count_after_first: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversation_events WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_one(db.reader().as_pool())
        .await
        .expect("count events");
        assert!(event_count_after_first >= 4);

        // Pure ReadPool `project_open` returns full user + assistant + tool blocks + stats!
        let open = ConversationProjector::project_open(db.reader().as_pool(), conversation_id, 16)
            .await
            .expect("project_open on ReadPool");
        let message_rows: Vec<_> = open
            .timeline
            .rows
            .iter()
            .filter(|r| matches!(r.row, ConversationTimelineRow::MessageTurn { .. }))
            .collect();
        assert_eq!(message_rows.len(), 2);
        match &message_rows[1].row {
            ConversationTimelineRow::MessageTurn { turn, phase, .. } => {
                assert_eq!(phase, "settled");
                let text_blocks: Vec<_> = turn
                    .blocks
                    .iter()
                    .filter(|b| matches!(b, ContentBlock::Text { .. }))
                    .collect();
                assert_eq!(
                    text_blocks.len(),
                    1,
                    "assistant text must not duplicate after tool call"
                );
                assert!(turn.blocks.iter().any(|b| {
                    matches!(b, ContentBlock::Text { text } if text.contains("QuartzNebula99"))
                }));
                assert!(turn.blocks.iter().any(|b| {
                    matches!(b, ContentBlock::ToolUse { tool_name, status, .. }
                        if tool_name == "Run cargo test" && status.as_deref() == Some("completed"))
                }));
            }
            other => panic!("expected assistant MessageTurn, got {other:?}"),
        }
        assert_eq!(open.session_stats.and_then(|s| s.total_tokens), Some(165));

        // Row-level trigram FTS5 search on ReadPool finds the backfilled assistant reply!
        let mut read_conn = db.reader().acquire().await.expect("acquire read conn");
        let hits = crate::search::search_conversations(&mut read_conn, "QuartzNebula99", None, 10)
            .await
            .expect("FTS search on ReadPool");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].conversation_id, conversation_id);

        // Second call short-circuits in Phase 1 (`Ok(false)`) without duplicating events.
        let second = ensure_legacy_jsonl_migrated(db.reader(), db.writer(), conversation_id)
            .await
            .expect("second backfill call");
        assert!(!second, "already-migrated session must short-circuit");
        let event_count_after_second: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversation_events WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_one(db.reader().as_pool())
        .await
        .expect("count events after second call");
        assert_eq!(event_count_after_second, event_count_after_first);
    }

    #[tokio::test]
    async fn backfill_next_legacy_batch_drains_unmigrated_sessions() {
        let db = db::DBService::new_in_memory_for_tests()
            .await
            .expect("in-memory dual-pool db");
        let c1 = seed_legacy_session(&db, "Batch 1", "Prompt 1", "Reply Alpha777").await;
        let c2 = seed_legacy_session(&db, "Batch 2", "Prompt 2", "Reply Bravo888").await;

        let count = backfill_next_legacy_batch(db.reader(), db.writer(), 10)
            .await
            .expect("drain batch");
        assert_eq!(count, 2);

        for cid in [c1, c2] {
            assert_eq!(
                ConversationRecord::is_legacy_jsonl_migrated(db.reader().as_pool(), cid)
                    .await
                    .expect("flag"),
                Some(true)
            );
        }

        let next_count = backfill_next_legacy_batch(db.reader(), db.writer(), 10)
            .await
            .expect("empty batch");
        assert_eq!(next_count, 0);
    }

    async fn record_transcript_round(
        root: &std::path::Path,
        agent_dir: &str,
        session_id: &str,
        prompt: &str,
        reply: &str,
    ) {
        let _ = acp_transcript::record_entry_in(
            root,
            agent_dir,
            session_id,
            EntryKind::Prompt,
            serde_json::json!([{ "type": "text", "text": prompt }]),
        )
        .await;
        drop(acp_transcript::record_entry_in(
            root,
            agent_dir,
            session_id,
            EntryKind::Update,
            serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": reply }
            }),
        ));
        let _ = acp_transcript::record_entry_in(
            root,
            agent_dir,
            session_id,
            EntryKind::TurnEnd,
            serde_json::json!({ "stopReason": "end_turn" }),
        )
        .await;
    }

    #[tokio::test]
    async fn multi_binding_claude_to_codex_backfill_preserves_prior_claude_turns_without_duplicating_codex_turn()
     {
        let db = db::DBService::new_in_memory_for_tests()
            .await
            .expect("in-memory dual-pool db");
        let writer = db.writer().as_pool();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(writer)
            .await
            .expect("disable fk for test seed");

        let conversation_id = Uuid::new_v4();
        let claude_sid = format!("claude-legacy-{}", Uuid::new_v4().simple());
        let codex_sid = format!("codex-next-{}", Uuid::new_v4().simple());

        ConversationRecord::create(
            writer,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: Some("Claude to Codex Switch"),
                initial_prompt: Some("Claude prompt one"),
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .expect("create conversation");

        // Record historical closed Claude binding + active ready Codex binding.
        let claude_binding_id = Uuid::new_v4();
        let codex_binding_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO conversation_agent_bindings
                (id, conversation_id, agent_id, agent_type, working_dir, acp_session_id, status, created_at, updated_at)
             VALUES (?, ?, 'claude_code', 'claude_code', '/workspace', ?, 'closed', '2026-01-01T00:00:01Z', '2026-01-01T00:00:02Z')",
        )
        .bind(claude_binding_id)
        .bind(conversation_id)
        .bind(&claude_sid)
        .execute(writer)
        .await
        .expect("insert claude binding");

        sqlx::query(
            "INSERT INTO conversation_agent_bindings
                (id, conversation_id, agent_id, agent_type, working_dir, acp_session_id, status, created_at, updated_at)
             VALUES (?, ?, 'codex', 'codex', '/workspace', ?, 'ready', '2026-01-01T00:01:00Z', '2026-01-01T00:01:00Z')",
        )
        .bind(codex_binding_id)
        .bind(conversation_id)
        .bind(&codex_sid)
        .execute(writer)
        .await
        .expect("insert codex binding");

        // Session now points at Codex after switching away from Claude.
        let codex_agent = AgentId::parse("codex").expect("codex agent id");
        Session::update_agent_metadata(
            writer,
            conversation_id,
            Some(&codex_sid),
            Some(&codex_agent),
        )
        .await
        .expect("set codex session metadata");

        // Legacy Claude turns exist as stub turn rows without assistant content events,
        // while the post-switch Codex turn already wrote full SQLite events.
        let claude_turn_1 = Uuid::new_v4();
        let claude_turn_2 = Uuid::new_v4();
        let codex_turn_3 = Uuid::new_v4();
        for (tid, prompt) in [
            (claude_turn_1, "Claude prompt one"),
            (claude_turn_2, "Claude prompt two"),
            (codex_turn_3, "Codex prompt three"),
        ] {
            ConversationTurnRecord::create_pending(
                writer,
                tid,
                CreateConversationTurn {
                    conversation_id,
                    prompt_id: None,
                    text_preview: Some(prompt),
                    input_blocks_json: "[]",
                },
            )
            .await
            .expect("create turn");
        }

        // Write full SQLite events for the post-switch Codex turn (simulating `has_content_events > 0`).
        let codex_events: [(&str, ConversationEvent); 3] = [
            (
                "user",
                ConversationEvent::UserTurnCreated {
                    blocks: vec![ConversationInputBlock::Text {
                        text: "Codex prompt three".to_string(),
                    }],
                    workflow_refs: Vec::new(),
                },
            ),
            (
                "acp",
                ConversationEvent::AssistantTextDelta {
                    text: "Codex reply Delta333.".to_string(),
                    message_id: None,
                },
            ),
            (
                "acp",
                ConversationEvent::TurnCompleted {
                    stop_reason: Some("end_turn".to_string()),
                },
            ),
        ];
        for (source, event) in codex_events {
            let value = serde_json::to_value(&event).expect("serialize event");
            let kind = value
                .get("kind")
                .and_then(|v| v.as_str())
                .expect("event kind");
            let json = serde_json::to_string(&event).expect("json");
            let mut conn = db.writer().acquire().await.expect("acquire writer");
            insert_conversation_event(
                &mut conn,
                AppendConversationEvent {
                    id: Uuid::new_v4(),
                    conversation_id,
                    turn_id: Some(codex_turn_3),
                    binding_id: Some(codex_binding_id),
                    connection_id: None,
                    prompt_id: None,
                    source,
                    event_kind: kind,
                    normalized_json: &json,
                    raw_json: None,
                    idempotency_key: None,
                },
            )
            .await
            .expect("insert codex event");
        }

        sqlx::query("UPDATE sessions SET legacy_jsonl_migrated = 0 WHERE id = ?")
            .bind(conversation_id)
            .execute(writer)
            .await
            .expect("mark unmigrated");

        // Write Claude legacy JSONL under `claude_code/` and Codex JSONL under `codex/`.
        let _ = crate::jsonl_history::read_existing_transcript_turns(conversation_id);
        let root = dimo_acp_transcripts_root();
        let claude_header =
            TranscriptHeader::new("claude_code", &claude_sid, "/workspace", 1_700_000_000_000);
        let _ = acp_transcript::record_header_in(&root, "claude_code", &claude_header).await;
        record_transcript_round(
            &root,
            "claude_code",
            &claude_sid,
            "Claude prompt one",
            "Claude reply Amber111.",
        )
        .await;
        record_transcript_round(
            &root,
            "claude_code",
            &claude_sid,
            "Claude prompt two",
            "Claude reply Cobalt222.",
        )
        .await;

        let codex_header =
            TranscriptHeader::new("codex", &codex_sid, "/workspace", 1_700_000_060_000);
        let _ = acp_transcript::record_header_in(&root, "codex", &codex_header).await;
        record_transcript_round(
            &root,
            "codex",
            &codex_sid,
            "Codex prompt three",
            "Codex reply Delta333.",
        )
        .await;

        let migrated = ensure_legacy_jsonl_migrated(db.reader(), db.writer(), conversation_id)
            .await
            .expect("multi-binding backfill succeeds");
        assert!(migrated);

        let open = ConversationProjector::project_open(db.reader().as_pool(), conversation_id, 32)
            .await
            .expect("project_open");
        let turns: Vec<&MessageTurn> = open
            .timeline
            .rows
            .iter()
            .filter_map(|r| match &r.row {
                ConversationTimelineRow::MessageTurn { turn, .. } => Some(turn),
                _ => None,
            })
            .collect();

        // Expect 3 user + 3 assistant message turns = 6 total, with zero duplication.
        assert_eq!(
            turns.len(),
            6,
            "expected 2 Claude rounds + 1 Codex round (6 message turns), got {}",
            turns.len()
        );
        let texts: Vec<String> = turns
            .iter()
            .map(|t| {
                t.blocks
                    .iter()
                    .filter_map(|b| match b {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("")
            })
            .collect();

        assert!(
            texts.iter().any(|t| t.contains("Amber111")),
            "missing first Claude reply: {texts:?}"
        );
        assert!(
            texts.iter().any(|t| t.contains("Cobalt222")),
            "missing second Claude reply: {texts:?}"
        );
        assert_eq!(
            texts.iter().filter(|t| t.contains("Delta333")).count(),
            1,
            "post-switch Codex reply must not be duplicated: {texts:?}"
        );

        // Verify FTS search finds the migrated Claude historical reply.
        let mut read_conn = db.reader().acquire().await.expect("acquire read conn");
        let hits = crate::search::search_conversations(&mut read_conn, "Amber111", None, 10)
            .await
            .expect("FTS search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].conversation_id, conversation_id);
    }

    #[tokio::test]
    async fn confirm_engine_handoff_migrates_legacy_claude_history_before_overwriting_session() {
        let db = db::DBService::new_in_memory_for_tests()
            .await
            .expect("in-memory dual-pool db");
        let writer = db.writer().as_pool();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(writer)
            .await
            .expect("disable fk for test seed");

        let conversation_id = Uuid::new_v4();
        let claude_sid = format!("claude-pre-handoff-{}", Uuid::new_v4().simple());
        let claude_agent = AgentId::parse("claude_code").expect("claude agent");
        let codex_agent = AgentId::parse("codex").expect("codex agent");

        ConversationRecord::create(
            writer,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: Some("Pre-handoff Claude Session"),
                initial_prompt: Some("Explain Rust ownership"),
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .expect("create conversation");

        Session::update_agent_metadata(
            writer,
            conversation_id,
            Some(&claude_sid),
            Some(&claude_agent),
        )
        .await
        .expect("bind claude session");

        sqlx::query("UPDATE sessions SET legacy_jsonl_migrated = 0 WHERE id = ?")
            .bind(conversation_id)
            .execute(writer)
            .await
            .expect("mark unmigrated");

        let _ = crate::jsonl_history::read_existing_transcript_turns(conversation_id);
        let root = dimo_acp_transcripts_root();
        let header =
            TranscriptHeader::new("claude_code", &claude_sid, "/workspace", 1_700_000_000_000);
        let _ = acp_transcript::record_header_in(&root, "claude_code", &header).await;
        record_transcript_round(
            &root,
            "claude_code",
            &claude_sid,
            "Explain Rust ownership",
            "PreHandoffToken789.",
        )
        .await;

        crate::handoff::DeterministicHandoffService::confirm_engine_handoff(
            writer,
            conversation_id,
            &codex_agent,
            None,
        )
        .await
        .expect("confirm_engine_handoff succeeds");

        assert_eq!(
            ConversationRecord::is_legacy_jsonl_migrated(db.reader().as_pool(), conversation_id)
                .await
                .expect("read migration flag"),
            Some(true)
        );
        let open = ConversationProjector::project_open(db.reader().as_pool(), conversation_id, 16)
            .await
            .expect("project_open");
        let has_claude_reply = open.timeline.rows.iter().any(|r| match &r.row {
            ConversationTimelineRow::MessageTurn { turn, .. } => turn.blocks.iter().any(
                |b| matches!(b, ContentBlock::Text { text } if text.contains("PreHandoffToken789")),
            ),
            _ => false,
        });
        assert!(
            has_claude_reply,
            "Claude legacy reply must survive confirm_engine_handoff"
        );
    }
}
