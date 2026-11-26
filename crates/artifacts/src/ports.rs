use std::path::Path;

use async_trait::async_trait;
use uuid::Uuid;

use crate::{ArtifactEvent, ArtifactRecord, PendingPreviewEvent, PendingRevisionEvent, PortError};

#[async_trait]
pub trait ArtifactRepository: Send + Sync {
    async fn latest_for_path(
        &self,
        conversation_id: Uuid,
        scope_root: &Path,
        relative_path: &Path,
    ) -> Result<Option<ArtifactRecord>, PortError>;

    /// Atomically persists a revision and its durable event outbox entry.
    async fn commit_revision(
        &self,
        record: &ArtifactRecord,
        event: &ArtifactEvent,
    ) -> Result<(), PortError>;

    async fn pending_revision_event(
        &self,
        _artifact_id: Uuid,
        _revision: u64,
    ) -> Result<Option<ArtifactEvent>, PortError> {
        Ok(None)
    }

    async fn pending_revision_events(
        &self,
        _limit: usize,
    ) -> Result<Vec<PendingRevisionEvent>, PortError> {
        Ok(Vec::new())
    }

    async fn mark_revision_event_delivered(
        &self,
        _artifact_id: Uuid,
        _revision: u64,
    ) -> Result<(), PortError> {
        Ok(())
    }

    /// Persists a preview lifecycle event before projection. Returns `true`
    /// while the event still needs delivery.
    async fn commit_preview_event(
        &self,
        _key: &str,
        _event: &ArtifactEvent,
    ) -> Result<bool, PortError> {
        Ok(true)
    }

    async fn pending_preview_events(
        &self,
        _limit: usize,
    ) -> Result<Vec<PendingPreviewEvent>, PortError> {
        Ok(Vec::new())
    }

    async fn mark_preview_event_delivered(&self, _key: &str) -> Result<(), PortError> {
        Ok(())
    }

    async fn find(&self, artifact_id: Uuid) -> Result<Option<ArtifactRecord>, PortError>;
}
