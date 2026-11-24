use std::sync::Arc;

use anyhow::Error as AnyhowError;
use async_trait::async_trait;
use db::{DBService, models::workspace::WorkspaceError};
use executors::executors::ExecutorError;
use git::{GitService, GitServiceError};
use git2::Error as Git2Error;
use services::services::{
    config::{Config, ConfigError},
    container::{ContainerError, ContainerService},
    events::{EventError, EventService},
    file_search::FileSearchService,
    filesystem::{FilesystemError, FilesystemService},
    filesystem_watcher::FilesystemWatcherError,
    image::{ImageError, ImageService},
    project::ProjectService,
    repo::RepoService,
    worktree_manager::WorktreeError,
};
use sqlx::Error as SqlxError;
use thiserror::Error;
use tokio::sync::RwLock;

#[derive(Debug, Error)]
pub enum DeploymentError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sqlx(#[from] SqlxError),
    #[error(transparent)]
    Git2(#[from] Git2Error),
    #[error(transparent)]
    GitServiceError(#[from] GitServiceError),
    #[error(transparent)]
    FilesystemWatcherError(#[from] FilesystemWatcherError),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
    #[error(transparent)]
    Container(#[from] ContainerError),
    #[error(transparent)]
    Executor(#[from] ExecutorError),
    #[error(transparent)]
    Image(#[from] ImageError),
    #[error(transparent)]
    Filesystem(#[from] FilesystemError),
    #[error(transparent)]
    Worktree(#[from] WorktreeError),
    #[error(transparent)]
    Event(#[from] EventError),
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Other(#[from] AnyhowError),
}

/// Backend service surface, dependency-injected into the Tauri shell.
///
/// Object-safe (架构报告 A-2): `AppState` holds `Arc<dyn Deployment>`, so the shell is
/// decoupled from the concrete `LocalDeployment` and an alternative impl (remote /
/// containerized) can be swapped in. Construction (`new`) is intentionally NOT on the
/// trait — it returns `Self`, which would break object-safety; each concrete impl keeps
/// its own inherent constructor.
#[async_trait]
pub trait Deployment: Send + Sync + 'static {
    fn config(&self) -> &Arc<RwLock<Config>>;

    fn db(&self) -> &DBService;

    fn container(&self) -> &dyn ContainerService;

    fn git(&self) -> &GitService;

    fn project(&self) -> &ProjectService;

    fn repo(&self) -> &RepoService;

    fn image(&self) -> &ImageService;

    fn filesystem(&self) -> &FilesystemService;

    fn events(&self) -> &EventService;

    fn file_search(&self) -> &FileSearchService;
}
