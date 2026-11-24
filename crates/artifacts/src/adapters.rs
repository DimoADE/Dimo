use std::path::{Path, PathBuf};

use async_trait::async_trait;
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use crate::{
    ArtifactRecord, ArtifactRepository, PendingPreviewEvent, PendingRevisionEvent, PortError,
    ProducerEvidence, ToolLockEvidence,
};

#[derive(Clone)]
pub struct SqliteArtifactRepository {
    pool: SqlitePool,
}

impl SqliteArtifactRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[derive(FromRow)]
struct ArtifactRow {
    id: Uuid,
    conversation_id: Uuid,
    turn_id: Uuid,
    workspace_id: Option<Uuid>,
    scope_root: String,
    relative_path: String,
    media_type: String,
    content_hash: String,
    revision: i64,
    plugin_id: String,
    plugin_version: String,
    provider_id: String,
    tool_lock_id: String,
    tool_id: String,
    tool_version: String,
    tool_target: String,
    tool_sha256: String,
    tool_executable_path: String,
    created_at_unix_ms: i64,
    updated_at_unix_ms: i64,
}

impl TryFrom<ArtifactRow> for ArtifactRecord {
    type Error = PortError;

    fn try_from(row: ArtifactRow) -> Result<Self, Self::Error> {
        Ok(Self {
            id: row.id,
            conversation_id: row.conversation_id,
            turn_id: row.turn_id,
            workspace_id: row.workspace_id,
            scope_root: PathBuf::from(row.scope_root),
            relative_path: PathBuf::from(row.relative_path),
            media_type: row.media_type,
            content_hash: row.content_hash,
            revision: u64::try_from(row.revision)
                .map_err(|_| PortError::new("artifact revision is negative"))?,
            producer: ProducerEvidence {
                plugin_id: row.plugin_id,
                plugin_version: row.plugin_version,
                provider_id: row.provider_id,
                tool_lock: ToolLockEvidence {
                    id: row.tool_lock_id,
                    tool_id: row.tool_id,
                    version: row.tool_version,
                    target: row.tool_target,
                    sha256: row.tool_sha256,
                    executable_path: PathBuf::from(row.tool_executable_path),
                },
            },
            created_at_unix_ms: u64::try_from(row.created_at_unix_ms)
                .map_err(|_| PortError::new("artifact creation time is negative"))?,
            updated_at_unix_ms: u64::try_from(row.updated_at_unix_ms)
                .map_err(|_| PortError::new("artifact update time is negative"))?,
        })
    }
}

const ARTIFACT_COLUMNS: &str = "id, conversation_id, turn_id, workspace_id, scope_root, \
    relative_path, media_type, content_hash, revision, plugin_id, plugin_version, provider_id, \
    tool_lock_id, tool_id, tool_version, tool_target, tool_sha256, tool_executable_path, \
    created_at_unix_ms, updated_at_unix_ms";

#[async_trait]
impl ArtifactRepository for SqliteArtifactRepository {
    async fn latest_for_path(
        &self,
        conversation_id: Uuid,
        scope_root: &Path,
        relative_path: &Path,
    ) -> Result<Option<ArtifactRecord>, PortError> {
        let query = format!(
            "SELECT {ARTIFACT_COLUMNS} FROM artifact_revisions \
             WHERE conversation_id = ? AND scope_root = ? AND relative_path = ? \
             ORDER BY revision DESC LIMIT 1"
        );
        sqlx::query_as::<_, ArtifactRow>(&query)
            .bind(conversation_id)
            .bind(path_text(scope_root)?)
            .bind(path_text(relative_path)?)
            .fetch_optional(&self.pool)
            .await
            .map_err(port_error)?
            .map(TryInto::try_into)
            .transpose()
    }

    async fn commit_revision(
        &self,
        record: &ArtifactRecord,
        event: &crate::ArtifactEvent,
    ) -> Result<(), PortError> {
        let mut transaction = self.pool.begin().await.map_err(port_error)?;
        sqlx::query(
            "INSERT INTO artifact_revisions \
             (id, conversation_id, turn_id, workspace_id, scope_root, relative_path, media_type, \
              content_hash, revision, plugin_id, plugin_version, provider_id, tool_lock_id, \
              tool_id, tool_version, tool_target, tool_sha256, tool_executable_path, \
              created_at_unix_ms, updated_at_unix_ms) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(record.id)
        .bind(record.conversation_id)
        .bind(record.turn_id)
        .bind(record.workspace_id)
        .bind(path_text(&record.scope_root)?)
        .bind(path_text(&record.relative_path)?)
        .bind(&record.media_type)
        .bind(&record.content_hash)
        .bind(record.revision as i64)
        .bind(&record.producer.plugin_id)
        .bind(&record.producer.plugin_version)
        .bind(&record.producer.provider_id)
        .bind(&record.producer.tool_lock.id)
        .bind(&record.producer.tool_lock.tool_id)
        .bind(&record.producer.tool_lock.version)
        .bind(&record.producer.tool_lock.target)
        .bind(&record.producer.tool_lock.sha256)
        .bind(path_text(&record.producer.tool_lock.executable_path)?)
        .bind(record.created_at_unix_ms as i64)
        .bind(record.updated_at_unix_ms as i64)
        .execute(&mut *transaction)
        .await
        .map_err(port_error)?;
        let event_json = serde_json::to_string(event).map_err(port_error)?;
        sqlx::query(
            "INSERT INTO artifact_event_outbox \
             (artifact_id, revision, event_json, delivered) VALUES (?, ?, ?, 0)",
        )
        .bind(record.id)
        .bind(record.revision as i64)
        .bind(event_json)
        .execute(&mut *transaction)
        .await
        .map_err(port_error)?;
        transaction.commit().await.map_err(port_error)?;
        Ok(())
    }

    async fn pending_revision_event(
        &self,
        artifact_id: Uuid,
        revision: u64,
    ) -> Result<Option<crate::ArtifactEvent>, PortError> {
        let event_json = sqlx::query_scalar::<_, String>(
            "SELECT event_json FROM artifact_event_outbox \
             WHERE artifact_id = ? AND revision = ? AND delivered = 0",
        )
        .bind(artifact_id)
        .bind(revision as i64)
        .fetch_optional(&self.pool)
        .await
        .map_err(port_error)?;
        event_json
            .map(|event| serde_json::from_str(&event).map_err(port_error))
            .transpose()
    }

    async fn pending_revision_events(
        &self,
        limit: usize,
    ) -> Result<Vec<PendingRevisionEvent>, PortError> {
        let rows = sqlx::query_as::<_, (Uuid, i64, String)>(
            "SELECT artifact_id, revision, event_json FROM artifact_event_outbox \
             WHERE delivered = 0 ORDER BY rowid LIMIT ?",
        )
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(port_error)?;
        rows.into_iter()
            .map(|(artifact_id, revision, event_json)| {
                Ok(PendingRevisionEvent {
                    artifact_id,
                    revision: u64::try_from(revision)
                        .map_err(|_| PortError::new("artifact revision is negative"))?,
                    event: serde_json::from_str(&event_json).map_err(port_error)?,
                })
            })
            .collect()
    }

    async fn mark_revision_event_delivered(
        &self,
        artifact_id: Uuid,
        revision: u64,
    ) -> Result<(), PortError> {
        sqlx::query(
            "UPDATE artifact_event_outbox SET delivered = 1 \
             WHERE artifact_id = ? AND revision = ?",
        )
        .bind(artifact_id)
        .bind(revision as i64)
        .execute(&self.pool)
        .await
        .map_err(port_error)?;
        Ok(())
    }

    async fn commit_preview_event(
        &self,
        key: &str,
        event: &crate::ArtifactEvent,
    ) -> Result<bool, PortError> {
        let event_json = serde_json::to_string(event).map_err(port_error)?;
        let conversation_id = match event {
            crate::ArtifactEvent::PreviewOpened { preview }
            | crate::ArtifactEvent::PreviewClosed { preview } => preview.conversation_id,
            crate::ArtifactEvent::PreviewFailed {
                conversation_id, ..
            } => *conversation_id,
            crate::ArtifactEvent::RevisionRecorded { .. } => {
                return Err(PortError::new(
                    "revision events cannot be stored in the preview outbox",
                ));
            }
        };
        sqlx::query(
            "INSERT INTO artifact_preview_event_outbox \
             (event_key, conversation_id, event_json, delivered) VALUES (?, ?, ?, 0) \
             ON CONFLICT(event_key) DO NOTHING",
        )
        .bind(key)
        .bind(conversation_id)
        .bind(event_json)
        .execute(&self.pool)
        .await
        .map_err(port_error)?;
        sqlx::query_scalar::<_, bool>(
            "SELECT delivered = 0 FROM artifact_preview_event_outbox WHERE event_key = ?",
        )
        .bind(key)
        .fetch_one(&self.pool)
        .await
        .map_err(port_error)
    }

    async fn pending_preview_events(
        &self,
        limit: usize,
    ) -> Result<Vec<PendingPreviewEvent>, PortError> {
        let rows = sqlx::query_as::<_, (String, String)>(
            "SELECT event_key, event_json FROM artifact_preview_event_outbox \
             WHERE delivered = 0 ORDER BY rowid LIMIT ?",
        )
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(port_error)?;
        rows.into_iter()
            .map(|(key, event_json)| {
                Ok(PendingPreviewEvent {
                    key,
                    event: serde_json::from_str(&event_json).map_err(port_error)?,
                })
            })
            .collect()
    }

    async fn mark_preview_event_delivered(&self, key: &str) -> Result<(), PortError> {
        sqlx::query("UPDATE artifact_preview_event_outbox SET delivered = 1 WHERE event_key = ?")
            .bind(key)
            .execute(&self.pool)
            .await
            .map_err(port_error)?;
        Ok(())
    }

    async fn find(&self, artifact_id: Uuid) -> Result<Option<ArtifactRecord>, PortError> {
        let query = format!(
            "SELECT {ARTIFACT_COLUMNS} FROM artifact_revisions \
             WHERE id = ? ORDER BY revision DESC LIMIT 1"
        );
        sqlx::query_as::<_, ArtifactRow>(&query)
            .bind(artifact_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(port_error)?
            .map(TryInto::try_into)
            .transpose()
    }
}

fn path_text(path: &Path) -> Result<&str, PortError> {
    path.to_str()
        .ok_or_else(|| PortError::new("artifact path is not valid UTF-8"))
}

fn port_error(error: impl std::fmt::Display) -> PortError {
    PortError::new(error.to_string())
}
