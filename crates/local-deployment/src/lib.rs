use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use db::DBService;
use deployment::{Deployment, DeploymentError};
use git::GitService;
use services::services::{
    config::{Config, load_config_from_file, publish_config_runtime, save_config_to_file},
    container::ContainerService,
    events::EventService,
    file_search::FileSearchService,
    filesystem::FilesystemService,
    image::ImageService,
    pr_monitor::PrMonitorService,
    project::ProjectService,
    repo::RepoService,
    worktree_manager::WorktreeManager,
};
use tokio::sync::RwLock;
use utils::msg_store::MsgStore;

use crate::{container::LocalContainerService, pty::PtyService};
mod command;
pub mod container;
mod copy;
mod process_completion;
pub mod pty;

#[derive(Clone)]
pub struct LocalDeployment {
    config: Arc<RwLock<Config>>,
    db: DBService,
    container: LocalContainerService,
    git: GitService,
    project: ProjectService,
    repo: RepoService,
    image: ImageService,
    filesystem: FilesystemService,
    events: EventService,
    file_search: FileSearchService,
    pty: PtyService,
}

impl LocalDeployment {
    pub fn settings_path(&self) -> &std::path::Path {
        self.container.settings_path()
    }
    // Inherent constructor: `new` is intentionally not on the `Deployment` trait (it
    // returns `Self`, which would break the object-safety needed for `Arc<dyn Deployment>`).
    pub async fn new() -> Result<Self, DeploymentError> {
        Self::new_with_settings_paths(
            utils::assets::host_data_dir(),
            utils::assets::settings_path(),
            Some(utils::assets::config_path()),
        )
        .await
    }

    pub async fn new_at(data_dir: impl AsRef<std::path::Path>) -> Result<Self, DeploymentError> {
        let settings_file = data_dir.as_ref().join("settings.json");
        let legacy_config_file = data_dir.as_ref().join("config.json");
        Self::new_with_settings_paths(data_dir, settings_file, Some(legacy_config_file)).await
    }

    async fn new_with_settings_paths(
        data_dir: impl AsRef<std::path::Path>,
        settings_file: std::path::PathBuf,
        legacy_config_file: Option<std::path::PathBuf>,
    ) -> Result<Self, DeploymentError> {
        std::fs::create_dir_all(data_dir.as_ref())?;
        if !settings_file.exists()
            && let Some(legacy_config_file) = legacy_config_file.as_ref()
            && legacy_config_file.exists()
        {
            let legacy_config = load_config_from_file(legacy_config_file).await;
            save_config_to_file(&legacy_config, &settings_file).await?;
            tracing::info!(
                from = %legacy_config_file.display(),
                to = %settings_file.display(),
                "Migrated application settings"
            );
        }
        let mut raw_config = load_config_from_file(&settings_file).await;

        // Check if app version has changed and set release notes flag
        {
            let current_version = utils::version::APP_VERSION;
            let stored_version = raw_config.last_app_version.as_deref();

            if stored_version != Some(current_version) {
                // Show release notes only if this is an upgrade (not first install)
                raw_config.show_release_notes = stored_version.is_some();
                raw_config.last_app_version = Some(current_version.to_string());
            }
        }

        // Always save config (may have been migrated or version updated)
        save_config_to_file(&raw_config, &settings_file).await?;
        publish_config_runtime(&raw_config).await;

        let workspace_dir_override = raw_config
            .workspace_dir
            .as_ref()
            .map(|workspace_dir| utils::path::expand_tilde(workspace_dir));
        WorktreeManager::set_workspace_dir_override(workspace_dir_override);

        let config = Arc::new(RwLock::new(raw_config));
        let git = GitService::new();
        let project = ProjectService::new();
        let repo = RepoService::new();
        let msg_stores = Arc::new(RwLock::new(HashMap::new()));
        let filesystem = FilesystemService::new();

        // Create shared components for EventService
        let events_msg_store = Arc::new(MsgStore::new());
        let events_entry_count = Arc::new(RwLock::new(0));

        // Create DB with writer-only event hooks backed by ReadPool (no hidden third pool).
        let db = {
            let msg_store_for_hook = events_msg_store.clone();
            let entry_count_for_hook = events_entry_count.clone();
            DBService::new_at_with_reader_hook(data_dir.as_ref(), move |reader, commit_fence| {
                EventService::create_hook(
                    msg_store_for_hook,
                    entry_count_for_hook,
                    reader,
                    commit_fence,
                )
            })
            .await?
        };

        let image = ImageService::new(db.clone().pool)?;
        {
            let image_service = image.clone();
            tokio::spawn(async move {
                tracing::info!("Starting orphaned image cleanup...");
                if let Err(e) = image_service.delete_orphaned_images().await {
                    tracing::error!("Failed to clean up orphaned images: {}", e);
                }
            });
        }

        let pty = PtyService::new();
        let container = LocalContainerService::new(
            db.clone(),
            msg_stores.clone(),
            config.clone(),
            git.clone(),
            image.clone(),
            settings_file.clone(),
            pty.clone(),
        )
        .await;

        let events = EventService::new(db.clone(), events_msg_store);

        let file_search = FileSearchService::new();

        {
            let db = db.clone();
            let container = container.clone();
            PrMonitorService::spawn(db, container).await;
        }

        let deployment = Self {
            config,
            db,
            container,
            git,
            project,
            repo,
            image,
            filesystem,
            events,
            file_search,
            pty,
        };

        Ok(deployment)
    }
}

#[async_trait]
impl Deployment for LocalDeployment {
    fn config(&self) -> &Arc<RwLock<Config>> {
        &self.config
    }

    fn db(&self) -> &DBService {
        &self.db
    }

    fn container(&self) -> &dyn ContainerService {
        &self.container
    }

    fn git(&self) -> &GitService {
        &self.git
    }

    fn project(&self) -> &ProjectService {
        &self.project
    }

    fn repo(&self) -> &RepoService {
        &self.repo
    }

    fn image(&self) -> &ImageService {
        &self.image
    }

    fn filesystem(&self) -> &FilesystemService {
        &self.filesystem
    }

    fn events(&self) -> &EventService {
        &self.events
    }

    fn file_search(&self) -> &FileSearchService {
        &self.file_search
    }
}

impl LocalDeployment {
    pub fn pty(&self) -> &PtyService {
        &self.pty
    }
}
