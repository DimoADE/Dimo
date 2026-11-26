use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationDelegationRecord {
    pub run_id: String,
    pub parent_conversation_id: Uuid,
    pub child_conversation_id: Uuid,
    pub parent_tool_call_id: String,
    pub target_project_id: Option<Uuid>,
    pub target_workspace_id: Option<Uuid>,
    pub target_environment_id: Option<String>,
    pub agent_id: String,
    pub provider_instance_id: Option<String>,
    pub model: Option<String>,
    pub role: Option<String>,
    pub task_preview: String,
    pub isolation: String,
    pub mode: String,
    pub completion_wake: String,
    pub max_runtime_mode: i64,
    pub max_interaction_mode: i64,
    pub status: String,
    pub preparation_stage: Option<String>,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub result_summary: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub deadline_at: Option<DateTime<Utc>>,
    pub delivered_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct CreateConversationDelegation<'a> {
    pub run_id: &'a str,
    pub parent_conversation_id: Uuid,
    pub child_conversation_id: Uuid,
    pub parent_tool_call_id: &'a str,
    pub target_project_id: Option<Uuid>,
    pub target_workspace_id: Option<Uuid>,
    pub target_environment_id: Option<&'a str>,
    pub agent_id: &'a str,
    pub provider_instance_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub role: Option<&'a str>,
    pub task_preview: &'a str,
    pub isolation: &'a str,
    pub mode: &'a str,
    pub completion_wake: &'a str,
    pub max_runtime_mode: i64,
    pub max_interaction_mode: i64,
    pub status: &'a str,
    pub preparation_stage: Option<&'a str>,
    pub worktree_path: Option<&'a str>,
    pub branch: Option<&'a str>,
    pub deadline_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct McpIdempotencyReceipt {
    pub scope_key: String,
    pub tool_name: String,
    pub response_json: String,
    pub created_at: DateTime<Utc>,
}

const COLUMNS: &str = r#"run_id, parent_conversation_id, child_conversation_id, parent_tool_call_id,
    target_project_id, target_workspace_id, target_environment_id, agent_id, provider_instance_id,
    model, role, task_preview, isolation, mode, completion_wake, max_runtime_mode,
    max_interaction_mode, status, preparation_stage, worktree_path, branch, result_summary,
    error_code, error_message, deadline_at, delivered_at, created_at, updated_at, finished_at"#;

impl ConversationDelegationRecord {
    pub async fn create(
        pool: &SqlitePool,
        input: CreateConversationDelegation<'_>,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"INSERT INTO conversation_delegations (
                   run_id, parent_conversation_id, child_conversation_id, parent_tool_call_id,
                   target_project_id, target_workspace_id, target_environment_id, agent_id,
                   provider_instance_id, model, role, task_preview, isolation, mode,
                   completion_wake, max_runtime_mode, max_interaction_mode, status,
                   preparation_stage, worktree_path, branch, deadline_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               RETURNING {COLUMNS}"#
        ))
        .bind(input.run_id)
        .bind(input.parent_conversation_id)
        .bind(input.child_conversation_id)
        .bind(input.parent_tool_call_id)
        .bind(input.target_project_id)
        .bind(input.target_workspace_id)
        .bind(input.target_environment_id)
        .bind(input.agent_id)
        .bind(input.provider_instance_id)
        .bind(input.model)
        .bind(input.role)
        .bind(input.task_preview)
        .bind(input.isolation)
        .bind(input.mode)
        .bind(input.completion_wake)
        .bind(input.max_runtime_mode)
        .bind(input.max_interaction_mode)
        .bind(input.status)
        .bind(input.preparation_stage)
        .bind(input.worktree_path)
        .bind(input.branch)
        .bind(input.deadline_at)
        .fetch_one(pool)
        .await
    }

    pub async fn find_by_run_id(
        pool: &SqlitePool,
        run_id: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {COLUMNS} FROM conversation_delegations WHERE run_id = ?"
        ))
        .bind(run_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn find_by_child_conversation(
        pool: &SqlitePool,
        child_conversation_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {COLUMNS} FROM conversation_delegations WHERE child_conversation_id = ?"
        ))
        .bind(child_conversation_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn list_for_parent(
        pool: &SqlitePool,
        parent_conversation_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {COLUMNS} FROM conversation_delegations WHERE parent_conversation_id = ? ORDER BY created_at DESC"
        ))
        .bind(parent_conversation_id)
        .fetch_all(pool)
        .await
    }

    pub async fn count_active_for_parent(
        pool: &SqlitePool,
        parent_conversation_id: Uuid,
    ) -> Result<u32, sqlx::Error> {
        let count: i64 = sqlx::query_scalar(
            r#"SELECT COUNT(*) FROM conversation_delegations
               WHERE parent_conversation_id = ?
                 AND status IN ('preparing', 'running', 'waiting_for_input')"#,
        )
        .bind(parent_conversation_id)
        .fetch_one(pool)
        .await?;
        Ok(count.max(0) as u32)
    }

    pub async fn count_total_for_parent(
        pool: &SqlitePool,
        parent_conversation_id: Uuid,
    ) -> Result<u32, sqlx::Error> {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversation_delegations WHERE parent_conversation_id = ?",
        )
        .bind(parent_conversation_id)
        .fetch_one(pool)
        .await?;
        Ok(count.max(0) as u32)
    }

    pub async fn update_preparation(
        pool: &SqlitePool,
        run_id: &str,
        status: &str,
        preparation_stage: Option<&str>,
        target_workspace_id: Option<Uuid>,
        worktree_path: Option<&str>,
        branch: Option<&str>,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            r#"UPDATE conversation_delegations
               SET status = ?,
                   preparation_stage = ?,
                   target_workspace_id = COALESCE(?, target_workspace_id),
                   worktree_path = COALESCE(?, worktree_path),
                   branch = COALESCE(?, branch),
                   updated_at = datetime('now', 'subsec')
               WHERE run_id = ? AND finished_at IS NULL"#,
        )
        .bind(status)
        .bind(preparation_stage)
        .bind(target_workspace_id)
        .bind(worktree_path)
        .bind(branch)
        .bind(run_id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub async fn mark_waiting_for_input(
        pool: &SqlitePool,
        child_conversation_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"UPDATE conversation_delegations
               SET status = 'waiting_for_input',
                   updated_at = datetime('now', 'subsec')
               WHERE child_conversation_id = ?
                 AND status IN ('running', 'waiting_for_input')
                 AND finished_at IS NULL
               RETURNING {COLUMNS}"#
        ))
        .bind(child_conversation_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn resume_running(
        pool: &SqlitePool,
        child_conversation_id: Uuid,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            r#"UPDATE conversation_delegations
               SET status = 'running',
                   updated_at = datetime('now', 'subsec')
               WHERE child_conversation_id = ?
                 AND status = 'waiting_for_input'
                 AND finished_at IS NULL"#,
        )
        .bind(child_conversation_id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub async fn finish(
        pool: &SqlitePool,
        run_id: &str,
        status: &str,
        result_summary: Option<&str>,
        error_code: Option<&str>,
        error_message: Option<&str>,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"UPDATE conversation_delegations
               SET status = ?,
                   result_summary = COALESCE(?, result_summary),
                   error_code = COALESCE(?, error_code),
                   error_message = COALESCE(?, error_message),
                   finished_at = COALESCE(finished_at, datetime('now', 'subsec')),
                   updated_at = datetime('now', 'subsec')
               WHERE run_id = ? AND finished_at IS NULL
               RETURNING {COLUMNS}"#
        ))
        .bind(status)
        .bind(result_summary)
        .bind(error_code)
        .bind(error_message)
        .bind(run_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn list_undelivered_for_parent(
        pool: &SqlitePool,
        parent_conversation_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {COLUMNS} FROM conversation_delegations
               WHERE parent_conversation_id = ?
                 AND mode = 'async'
                 AND finished_at IS NOT NULL
                 AND delivered_at IS NULL
               ORDER BY finished_at ASC"#
        ))
        .bind(parent_conversation_id)
        .fetch_all(pool)
        .await
    }

    pub async fn list_all_undelivered(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {COLUMNS} FROM conversation_delegations
               WHERE mode = 'async'
                 AND finished_at IS NOT NULL
                 AND delivered_at IS NULL
               ORDER BY finished_at ASC"#
        ))
        .fetch_all(pool)
        .await
    }

    pub async fn mark_delivered(
        pool: &SqlitePool,
        run_ids: &[String],
    ) -> Result<u64, sqlx::Error> {
        let mut total = 0u64;
        for run_id in run_ids {
            let result = sqlx::query(
                r#"UPDATE conversation_delegations
                   SET delivered_at = datetime('now', 'subsec'),
                       updated_at = datetime('now', 'subsec')
                   WHERE run_id = ? AND delivered_at IS NULL"#,
            )
            .bind(run_id)
            .execute(pool)
            .await?;
            total += result.rows_affected();
        }
        Ok(total)
    }

    pub async fn list_expired_active(
        pool: &SqlitePool,
        now: DateTime<Utc>,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {COLUMNS} FROM conversation_delegations
               WHERE finished_at IS NULL
                 AND deadline_at IS NOT NULL
                 AND deadline_at <= ?"#
        ))
        .bind(now)
        .fetch_all(pool)
        .await
    }

    pub async fn list_all_unfinished(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {COLUMNS} FROM conversation_delegations WHERE finished_at IS NULL"
        ))
        .fetch_all(pool)
        .await
    }

    pub fn is_terminal(&self) -> bool {
        self.finished_at.is_some()
            || matches!(
                self.status.as_str(),
                "completed" | "failed" | "cancelled" | "timed_out"
            )
    }
}

impl McpIdempotencyReceipt {
    pub async fn find(
        pool: &SqlitePool,
        scope_key: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            "SELECT scope_key, tool_name, response_json, created_at FROM mcp_idempotency_receipts WHERE scope_key = ?",
        )
        .bind(scope_key)
        .fetch_optional(pool)
        .await
    }

    pub async fn put(
        pool: &SqlitePool,
        scope_key: &str,
        tool_name: &str,
        response_json: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"INSERT OR IGNORE INTO mcp_idempotency_receipts (scope_key, tool_name, response_json)
               VALUES (?, ?, ?)"#,
        )
        .bind(scope_key)
        .bind(tool_name)
        .bind(response_json)
        .execute(pool)
        .await?;
        Ok(())
    }
}
