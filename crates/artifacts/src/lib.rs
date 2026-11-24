//! Artifact records and SQLite repository.

mod adapters;
mod error;
mod ports;
mod types;

pub use adapters::SqliteArtifactRepository;
pub use error::PortError;
pub use ports::ArtifactRepository;
pub use types::{
    ArtifactEvent, ArtifactPreviewReference, ArtifactRecord, ArtifactReference,
    PendingPreviewEvent, PendingRevisionEvent, ProducerEvidence, ToolLockEvidence,
};
