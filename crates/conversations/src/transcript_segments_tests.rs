use agents::{
    AgentConnectionId, AgentId,
    acp_transcript::{self, EntryKind},
    conversation::{ContentBlock, MessageTurn},
};
use db::models::conversation::{ConversationRecord, CreateConversationRecord};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use uuid::Uuid;

async fn pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .in_memory(true)
                .foreign_keys(false),
        )
        .await
        .unwrap();
    sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .unwrap();
    pool
}

async fn conversation(pool: &SqlitePool) -> Uuid {
    let id = Uuid::new_v4();
    ConversationRecord::create(
        pool,
        id,
        CreateConversationRecord {
            workspace_id: Uuid::new_v4(),
            task_id: None,
            title: None,
            initial_prompt: None,
            status: None,
            executor: Some("codex"),
        },
    )
    .await
    .unwrap();
    id
}

#[tokio::test]
async fn paged_history_reads_unicode_without_truncation_and_rejects_rewritten_cursors() {
    let pool = pool().await;
    let id = conversation(&pool).await;
    let root = agents::acp_transcript::dimo_acp_transcripts_root();
    let turns: Vec<MessageTurn> = serde_json::from_value(serde_json::json!([
        {"id":"long","role":"user","blocks":[{"type":"text","text":"甲🙂乙丙丁"}],"timestamp":"2026-11-13T00:00:00Z"},
        {"id":"answer","role":"assistant","blocks":[{"type":"text","text":"回答"},{"type":"thinking","text":"private"}],"timestamp":"2026-11-13T00:00:00Z"}
    ])).unwrap();
    super::replace_snapshot_in(&pool, &root, id, "codex", &turns)
        .await
        .unwrap();
    let first = crate::session_info::read_history_page(
        &pool,
        id,
        &delegation_proto::SessionHistoryRequest {
            max_chars: Some(2),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(first.items[0].text, "甲🙂");
    assert_eq!(first.items[0].next_text_offset, Some(2));
    let request = delegation_proto::SessionHistoryRequest {
        item_id: Some(first.items[0].id.clone()),
        text_offset: Some(2),
        max_chars: Some(3),
        history_revision: Some(first.history_revision),
        ..Default::default()
    };
    let rest = crate::session_info::read_history_page(&pool, id, &request)
        .await
        .unwrap();
    assert_eq!(rest.items[0].text, "乙丙丁");
    assert_eq!(rest.items[0].next_text_offset, None);
    let next = crate::session_info::read_history_page(
        &pool,
        id,
        &delegation_proto::SessionHistoryRequest {
            after_item_id: Some(first.items[0].id.clone()),
            max_chars: Some(100),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(next.items.len(), 1);
    assert_eq!(next.items[0].text, "回答");
    super::replace_snapshot_in(&pool, &root, id, "codex", &turns[..1])
        .await
        .unwrap();
    assert!(
        crate::session_info::read_history_page(&pool, id, &request)
            .await
            .is_err()
    );
}

fn text(turns: &[MessageTurn]) -> Vec<String> {
    turns
        .iter()
        .flat_map(|turn| &turn.blocks)
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

async fn append(connection: AgentConnectionId, question: &str) {
    agents::transcript_target::record_entry(
        connection,
        "codex",
        "unused-native",
        EntryKind::Prompt,
        serde_json::json!([{"type":"text","text":question}]),
    )
    .await
    .unwrap();
    agents::transcript_target::record_entry(
        connection,
        "codex",
        "unused-native",
        EntryKind::TurnEnd,
        serde_json::json!({"stopReason":"end_turn"}),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn torn_utf8_tail_keeps_completed_history_and_reopen_repairs_before_append() {
    use std::io::Write;
    let pool = pool().await;
    let id = conversation(&pool).await;
    let root = tempfile::tempdir().unwrap();
    let agent = AgentId::parse("codex").unwrap();
    let binding = Uuid::new_v4();
    let destination = super::open_in(&pool, root.path(), id, binding, &agent, "")
        .await
        .unwrap();
    let connection = AgentConnectionId::new();
    agents::transcript_target::bind(connection, destination.clone());
    append(connection, "completed").await;
    let path = acp_transcript::transcript_path_in(
        &destination.root,
        &destination.directory,
        &destination.session_id,
    )
    .unwrap();
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(&[b'{', b'"', 0xe4, 0xb8])
        .unwrap();
    let history = super::read_in(&pool, root.path(), id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(text(&history), ["completed"]);
    super::open_in(&pool, root.path(), id, binding, &agent, "")
        .await
        .unwrap();
    append(connection, "after repair").await;
    super::seal_in(&pool, root.path(), id).await.unwrap();
    assert_eq!(
        text(
            &super::read_in(&pool, root.path(), id)
                .await
                .unwrap()
                .unwrap()
        ),
        ["completed", "after repair"]
    );
}

#[tokio::test]
async fn snapshots_preserve_protocol_image_generation_and_tool_metadata_losslessly() {
    let pool = pool().await;
    let id = conversation(&pool).await;
    let root = tempfile::tempdir().unwrap();
    let turn: MessageTurn = serde_json::from_value(serde_json::json!({
        "id": "source-message", "role": "assistant", "timestamp": "2026-11-13T00:00:00Z",
        "completed_at": "2026-11-13T00:00:01Z", "duration_ms": 1000,
        "model": "test-model", "agent_message_id": "native-message",
        "blocks": [
            {"type":"protocol","content":{"type":"audio","data":"audio-base64","mimeType":"audio/wav"}},
            {"type":"image_generation","revised_prompt":"image request","image":null},
            {"type":"tool_use","tool_use_id":"tool-1","tool_name":"read","meta":{"delegation":{"source":"agent"}},"status":"completed"},
            {"type":"tool_result","tool_use_id":"tool-1","output_preview":"result","is_error":false}
        ]
    })).unwrap();
    super::import_snapshot_in(&pool, root.path(), id, "codex", std::slice::from_ref(&turn))
        .await
        .unwrap();
    let mut restored = super::read_in(&pool, root.path(), id)
        .await
        .unwrap()
        .unwrap()
        .remove(0);
    assert_ne!(restored.id, turn.id);
    restored.id = turn.id.clone();
    assert_eq!(restored, turn);
}
