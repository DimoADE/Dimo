//! Read-only legacy ACP JSONL transcript loader used by SQLite backfill
//! (`crate::projection::backfill`).

use agents::{
    AgentKind,
    acp_transcript::{self, EntryKind, dimo_acp_transcripts_root, safe_component},
    conversation::MessageTurn,
    parsers::acp_native::project_turns_for,
};
use uuid::Uuid;

/// Read any existing on-disk JSONL transcript turns for `conversation_id`
/// without mutating or migrating from SQLite.
pub fn read_existing_transcript_turns(conversation_id: Uuid) -> Option<Vec<MessageTurn>> {
    read_existing_transcript_turns_with_external(conversation_id, None)
}

pub fn read_existing_transcript_turns_with_external(
    conversation_id: Uuid,
    external_session_id: Option<&str>,
) -> Option<Vec<MessageTurn>> {
    isolate_test_transcripts();
    let root = dimo_acp_transcripts_root();
    let candidates = transcript_session_id_candidates(conversation_id, external_session_id);
    let entries = std::fs::read_dir(&root).ok()?;
    let mut fallback_turns: Option<Vec<MessageTurn>> = None;
    for dir_entry in entries.flatten() {
        let Ok(file_type) = dir_entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Some(agent_dir) = dir_entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let kind = AgentKind::from_lenient(&agent_dir);
        for sid in &candidates {
            let chain = acp_transcript::read_chain_in(&root, &agent_dir, sid);
            if chain.entries.is_empty() {
                continue;
            }
            let turns = project_turns_for(&chain.entries, kind);
            if turns.is_empty() {
                continue;
            }
            if chain
                .entries
                .iter()
                .any(|entry| matches!(entry.k, EntryKind::Update | EntryKind::TurnEnd))
            {
                return Some(turns);
            }
            if fallback_turns.is_none() {
                fallback_turns = Some(turns);
            }
        }
    }
    fallback_turns
}

fn candidate_agent_dirs_for_agent(agent_id: Option<&str>) -> Vec<String> {
    let mut dirs = Vec::new();
    if let Some(raw) = agent_id.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(kind) = AgentKind::from_lenient(raw) {
            let canonical = kind.as_str().to_string();
            if safe_component(&canonical) && !dirs.contains(&canonical) {
                dirs.push(canonical);
            }
        }
        if safe_component(raw) && !dirs.iter().any(|d| d == raw) {
            dirs.push(raw.to_string());
        }
    }
    dirs
}

/// Flush and read on-disk ACP JSONL turns for a specific `(agent_id, session_id)` binding,
/// checking the binding's own `acp-transcripts/<agent_dir>/` first before scanning other
/// directories for that exact `session_id`. Marks visited `(agent_dir, sid)` chains so
/// callers collecting across multiple historical bindings never double-read a file.
pub(crate) async fn flush_and_read_transcript_turns_for_binding(
    agent_id: Option<&str>,
    session_id: &str,
    visited_chains: &mut std::collections::HashSet<(String, String)>,
) -> Option<Vec<MessageTurn>> {
    isolate_test_transcripts();
    let sid = session_id.trim();
    if sid.is_empty() || !safe_component(sid) {
        return None;
    }
    let root = dimo_acp_transcripts_root();
    let mut dirs = candidate_agent_dirs_for_agent(agent_id);
    if let Ok(entries) = std::fs::read_dir(&root) {
        let mut extra_dirs: Vec<String> = entries
            .flatten()
            .filter_map(|entry| {
                let ft = entry.file_type().ok()?;
                if !ft.is_dir() {
                    return None;
                }
                entry.file_name().to_str().map(str::to_string)
            })
            .filter(|dir| !dirs.contains(dir))
            .collect();
        extra_dirs.sort();
        dirs.extend(extra_dirs);
    }

    let mut fallback: Option<(String, Vec<String>, Vec<MessageTurn>)> = None;
    for agent_dir in dirs {
        if visited_chains.contains(&(agent_dir.clone(), sid.to_string())) {
            continue;
        }
        let ancestors = acp_transcript::continuation_ancestors_in(&root, &agent_dir, sid);
        let _ = acp_transcript::flush_in(&root, &agent_dir, sid).await;
        for ancestor in &ancestors {
            let _ = acp_transcript::flush_in(&root, &agent_dir, ancestor).await;
        }
        let chain = acp_transcript::read_chain_in(&root, &agent_dir, sid);
        if chain.entries.is_empty() {
            continue;
        }
        let kind = AgentKind::from_lenient(&agent_dir)
            .or_else(|| agent_id.and_then(AgentKind::from_lenient));
        let turns = project_turns_for(&chain.entries, kind);
        if turns.is_empty() {
            continue;
        }
        if chain
            .entries
            .iter()
            .any(|entry| matches!(entry.k, EntryKind::Update | EntryKind::TurnEnd))
        {
            visited_chains.insert((agent_dir.clone(), sid.to_string()));
            for ancestor in ancestors {
                visited_chains.insert((agent_dir.clone(), ancestor));
            }
            return Some(turns);
        }
        if fallback.is_none() {
            fallback = Some((agent_dir, ancestors, turns));
        }
    }

    if let Some((agent_dir, ancestors, turns)) = fallback {
        visited_chains.insert((agent_dir.clone(), sid.to_string()));
        for ancestor in ancestors {
            visited_chains.insert((agent_dir.clone(), ancestor));
        }
        return Some(turns);
    }
    None
}

/// Flush and collect ALL on-disk ACP JSONL transcript chunks keyed by `conversation_id`
/// across every `acp-transcripts/<agent_dir>/` directory without stopping at the first match.
pub(crate) async fn flush_and_read_all_transcript_turns_for_conversation(
    conversation_id: Uuid,
    visited_chains: &mut std::collections::HashSet<(String, String)>,
) -> Vec<Vec<MessageTurn>> {
    isolate_test_transcripts();
    let root = dimo_acp_transcripts_root();
    let candidates = transcript_session_id_candidates(conversation_id, None);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut dirs: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let ft = entry.file_type().ok()?;
            if !ft.is_dir() {
                return None;
            }
            entry.file_name().to_str().map(str::to_string)
        })
        .collect();
    dirs.sort();

    let mut collected = Vec::new();
    for agent_dir in dirs {
        let kind = AgentKind::from_lenient(&agent_dir);
        for sid in &candidates {
            if visited_chains.contains(&(agent_dir.clone(), sid.clone())) {
                continue;
            }
            let ancestors = acp_transcript::continuation_ancestors_in(&root, &agent_dir, sid);
            let _ = acp_transcript::flush_in(&root, &agent_dir, sid).await;
            for ancestor in &ancestors {
                let _ = acp_transcript::flush_in(&root, &agent_dir, ancestor).await;
            }
            let chain = acp_transcript::read_chain_in(&root, &agent_dir, sid);
            if chain.entries.is_empty() {
                continue;
            }
            let turns = project_turns_for(&chain.entries, kind);
            if turns.is_empty() {
                continue;
            }
            visited_chains.insert((agent_dir.clone(), sid.clone()));
            for ancestor in ancestors {
                visited_chains.insert((agent_dir.clone(), ancestor));
            }
            collected.push(turns);
        }
    }
    collected
}

fn transcript_session_id_candidates(
    conversation_id: Uuid,
    external_session_id: Option<&str>,
) -> Vec<String> {
    let mut candidates = Vec::with_capacity(3);
    if let Some(ext) = external_session_id
        .map(str::trim)
        .filter(|ext| !ext.is_empty() && safe_component(ext))
    {
        candidates.push(ext.to_string());
    }
    let simple = conversation_id.simple().to_string();
    if !candidates.contains(&simple) {
        candidates.push(simple);
    }
    let hyphenated = conversation_id.to_string();
    if !candidates.contains(&hyphenated) {
        candidates.push(hyphenated);
    }
    candidates
}

/// Cargo test binaries live in `target/.../deps`. Redirect their transcript
/// files so a migration cannot write into the user data directory.
fn isolate_test_transcripts() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        if std::env::var_os("DIMO_TRANSCRIPTS_ROOT").is_some() {
            return;
        }
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let in_deps = exe
            .components()
            .any(|component| component.as_os_str() == "deps");
        if !in_deps {
            return;
        }
        let dir = utils::path::get_dimo_temp_dir()
            .join(format!("acp-transcripts-{}", std::process::id()));
        unsafe {
            std::env::set_var("DIMO_TRANSCRIPTS_ROOT", dir);
        }
    });
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use agents::{
        AgentId,
        acp_transcript::{self, EntryKind, TranscriptHeader, dimo_acp_transcripts_root},
    };
    use db::models::{conversation::ConversationRecord, conversation_turn::ConversationTurnRecord};
    use sqlx::{
        SqlitePool,
        sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    };
    use uuid::Uuid;

    use super::isolate_test_transcripts;

    async fn setup_test_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect memory db");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    #[tokio::test]
    async fn fts_reindex_on_legacy_backfill_indexes_external_session_id_jsonl_assistant_reply() {
        isolate_test_transcripts();
        let pool = setup_test_pool().await;
        let conversation_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        let workspace_id = Uuid::new_v4();
        let agent_id = AgentId::parse("codex").expect("agent id");
        let external_sid = format!("acp-fts-{}", Uuid::new_v4().simple());

        ConversationRecord::create(
            &pool,
            conversation_id,
            db::models::conversation::CreateConversationRecord {
                workspace_id,
                task_id: None,
                title: Some("FTS External Session Test"),
                initial_prompt: Some("Find secret keyword"),
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .expect("create conversation");
        db::models::session::Session::update_agent_metadata(
            &pool,
            conversation_id,
            Some(&external_sid),
            Some(&agent_id),
        )
        .await
        .expect("bind external session id");
        ConversationTurnRecord::create_pending(
            &pool,
            turn_id,
            db::models::conversation_turn::CreateConversationTurn {
                conversation_id,
                prompt_id: None,
                text_preview: Some("Find secret keyword"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn");
        sqlx::query("UPDATE sessions SET legacy_jsonl_migrated = 0 WHERE id = ?")
            .bind(conversation_id)
            .execute(&pool)
            .await
            .expect("mark session unmigrated");

        let root = dimo_acp_transcripts_root();
        let header = TranscriptHeader::new("codex", &external_sid, "/workspace", 1_700_000_000_000);
        let _ = acp_transcript::record_header_in(&root, "codex", &header).await;
        let _ = acp_transcript::record_entry_in(
            &root,
            "codex",
            &external_sid,
            EntryKind::Prompt,
            serde_json::json!([{ "type": "text", "text": "Find secret keyword" }]),
        )
        .await;
        drop(acp_transcript::record_entry_in(
            &root,
            "codex",
            &external_sid,
            EntryKind::Update,
            serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "The magic token is XylophoneQuantum42." }
            }),
        ));
        let _ = acp_transcript::record_entry_in(
            &root,
            "codex",
            &external_sid,
            EntryKind::TurnEnd,
            serde_json::json!({ "stopReason": "end_turn", "durationMs": 80 }),
        )
        .await;

        let migrated = crate::ensure_legacy_jsonl_migrated_on_pool(&pool, conversation_id)
            .await
            .expect("backfill legacy jsonl");
        assert!(migrated);

        let indexed_body: String = sqlx::query_scalar(
            "SELECT COALESCE(group_concat(text, ' '), '') FROM conversation_fts WHERE conversation_id = ?1",
        )
        .bind(conversation_id.to_string())
        .fetch_one(&pool)
        .await
        .expect("fetch row-level FTS text");
        assert!(
            indexed_body.contains("XylophoneQuantum42"),
            "row-level FTS after legacy backfill must include assistant reply from <external_session_id>.jsonl, got: {indexed_body}"
        );
    }
}
