//! Host-owned update observations and exact, expiring update confirmations.
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use application::ApplicationError;
use plugins::{
    PluginActivation, PluginPackage, PluginSourceLock, PluginUpdateResolver, PluginUpdateStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::domains::{
    ServerApplicationDomains, internal_error, parse, plugin_control_item, plugin_error,
};

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateObservations {
    statuses: Vec<PluginUpdateStatus>,
    #[serde(default)]
    notified: BTreeMap<String, String>,
    #[serde(default)]
    host_version: String,
}

pub(crate) struct PreparedPluginUpdate {
    package: PluginPackage,
    previous_digest: String,
    previous_config: Value,
    previous_enabled: bool,
    created_at: u64,
    _directory: tempfile::TempDir,
}

#[derive(Default)]
pub(crate) struct PluginUpdates {
    observations: Mutex<UpdateObservations>,
    pub(crate) mutation: Mutex<()>,
    checking: Mutex<()>,
    prepared: Mutex<BTreeMap<String, PreparedPluginUpdate>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateRequest {
    #[serde(alias = "plugin_id")]
    plugin_id: String,
    #[serde(default)]
    tag: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    digest: Option<String>,
    #[serde(default, alias = "confirmation_id")]
    confirmation_id: Option<String>,
}

fn verify_requested_update_constraints(
    requested_version: Option<&str>,
    requested_digest: Option<&str>,
    resolved_version: &str,
    package_digest: &str,
    archive_sha256: Option<&str>,
) -> Result<(), ApplicationError> {
    if let Some(version) = requested_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let expected = version.strip_prefix('v').unwrap_or(version);
        let actual = resolved_version.strip_prefix('v').unwrap_or(resolved_version);
        if actual != expected {
            return Err(ApplicationError::conflict(format!(
                "resolved plugin update version {resolved_version} does not match requested version {version}"
            )));
        }
    }
    if let Some(digest) = requested_digest
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let matches_content = package_digest == digest;
        let matches_archive = archive_sha256.is_some_and(|sha| sha == digest);
        if !matches_content && !matches_archive {
            return Err(ApplicationError::conflict(format!(
                "resolved plugin update digest {package_digest} does not match requested digest {digest}"
            )));
        }
    }
    Ok(())
}

impl PluginUpdates {
    pub(crate) fn load(root: &Path) -> Self {
        let mut observations: UpdateObservations = std::fs::read(cache_path(root))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        if observations.host_version != env!("CARGO_PKG_VERSION") {
            observations.statuses.retain(|item| item.status != "failed");
            observations.host_version = env!("CARGO_PKG_VERSION").to_owned();
        }
        Self {
            observations: Mutex::new(observations),
            ..Self::default()
        }
    }
}

fn cache_path(root: &Path) -> PathBuf {
    root.join("plugins/update-observations.json")
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn save_cache(root: &Path, observations: &mut UpdateObservations) -> Result<(), ApplicationError> {
    use std::io::Write;
    observations.host_version = env!("CARGO_PKG_VERSION").to_owned();
    let path = cache_path(root);
    let parent = path.parent().unwrap();
    std::fs::create_dir_all(parent).map_err(internal_error)?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(internal_error)?;
    serde_json::to_writer(&mut file, observations).map_err(internal_error)?;
    file.flush().map_err(internal_error)?;
    file.as_file().sync_all().map_err(internal_error)?;
    file.persist(path).map_err(internal_error)?;
    Ok(())
}

impl ServerApplicationDomains {
    pub(crate) fn spawn_plugin_updates(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            loop {
                let Some(host) = weak.upgrade() else {
                    break;
                };
                if let Err(error) = host.check_plugin_updates(false).await {
                    tracing::warn!(?error, "background plugin update check failed");
                }
                drop(host);
                tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
            }
        });
    }

    pub(crate) async fn check_plugin_updates(
        &self,
        cached: bool,
    ) -> Result<Value, ApplicationError> {
        if cached {
            return serde_json::to_value(&self.plugin_updates.observations.lock().await.statuses)
                .map_err(internal_error);
        }
        let _check = self.plugin_updates.checking.lock().await;
        let catalog = self
            .plugin_control_plane
            .catalog()
            .await
            .map_err(plugin_error)?;
        let previous = self
            .plugin_updates
            .observations
            .lock()
            .await
            .statuses
            .clone();
        let mut statuses = Vec::new();
        // Bounded parallel requests keep one unavailable registry from blocking every plugin.
        use futures::{StreamExt, stream};
        let results = stream::iter(catalog.into_iter().map(|plugin| async move {
            let lock = plugin.source.update_lock.clone().or_else(|| {
                PluginSourceLock::from_source(
                    &plugin.source,
                    &plugin.version,
                    &plugin.package_digest,
                )
            });
            let result = match lock {
                Some(lock) => match PluginUpdateResolver::new() {
                    Ok(resolver) => resolver.resolve(&lock, None).await.map(Some),
                    Err(error) => Err(error),
                },
                None => Ok(None),
            };
            (plugin, result)
        }))
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await;
        let _mutation = self.plugin_updates.mutation.lock().await;
        let current = self
            .plugin_control_plane
            .catalog()
            .await
            .map_err(plugin_error)?;
        for (plugin, result) in results {
            if !current.iter().any(|item| {
                item.id() == plugin.id() && item.package_digest == plugin.package_digest
            }) {
                continue;
            }
            let old = previous.iter().find(|item| item.plugin_id == plugin.id());
            match result {
                Ok(result) => {
                    let supported = result.is_some();
                    let candidate = result.flatten();
                    statuses.push(PluginUpdateStatus {
                        plugin_id: plugin.id().to_owned(),
                        update_available: candidate.is_some(),
                        status: if candidate.is_some() {
                            "available"
                        } else if supported {
                            "current"
                        } else {
                            "unsupported"
                        }
                        .to_owned(),
                        checked_at: now(),
                        last_successful_at: Some(now()),
                        error: None,
                        available_tag: candidate.as_ref().map(|c| c.source.tag.clone()),
                        available_version: candidate.as_ref().map(|c| c.source.version.clone()),
                        candidate,
                    });
                }
                Err(error) => statuses.push(PluginUpdateStatus::failed(
                    plugin.id().to_owned(),
                    error.to_string(),
                    old,
                )),
            }
        }
        statuses.sort_by(|a, b| a.plugin_id.cmp(&b.plugin_id));
        let mut observations = self.plugin_updates.observations.lock().await;
        let newly_available: Vec<_> = statuses
            .iter()
            .filter(|item| {
                item.status == "available"
                    && item.available_version.as_ref() != observations.notified.get(&item.plugin_id)
            })
            .cloned()
            .collect();
        for item in &newly_available {
            if let Some(version) = &item.available_version {
                observations
                    .notified
                    .insert(item.plugin_id.clone(), version.clone());
            }
        }
        observations.statuses = statuses;
        if let Err(error) = save_cache(&self.runtime_root, &mut observations) {
            tracing::warn!(?error, "could not persist plugin update observations");
        }
        self.events
            .emit("plugin-updates-changed", &observations.statuses);
        if !newly_available.is_empty() {
            self.events
                .emit("plugin-updates-available", newly_available);
        }
        serde_json::to_value(&observations.statuses).map_err(internal_error)
    }

    async fn apply_prepared_plugin_update(
        &self,
        installed: &plugins::InstalledPlugin,
        prepared: PreparedPluginUpdate,
    ) -> Result<Value, ApplicationError> {
        self.ensure_required_plugin_dependencies(&prepared.package)
            .await?;
        let result = if prepared.previous_enabled {
            let node = self
                .worker_runtime
                .resolve()
                .await
                .map_err(internal_error)?;
            let grants = plugins::candidate_capability_grants(&prepared.package, &[], &[])
                .map_err(plugin_error)?;
            self.plugin_control_plane
                .update_and_activate(
                    &node,
                    prepared.package,
                    &grants,
                    self.capability_broker.clone(),
                )
                .await
                .map_err(|error| {
                    ApplicationError::conflict(format!("{}: {error}", error.code()))
                })?
        } else {
            self.plugin_control_plane
                .import(prepared.package, plugins::ConflictDecision::Replace)
                .await
                .map_err(plugin_error)?
                .plugin
        };
        // Publication now owns this directory, including the rollback generation.
        let _ = prepared._directory.keep();
        if result.activation == PluginActivation::Enabled
            && let Err(error) = self
                .refresh_updated_plugin_projections(installed, &result)
                .await
        {
            tracing::warn!(
                ?error,
                plugin_id = result.id(),
                "could not refresh existing plugin bindings after update"
            );
        }
        let mut observations = self.plugin_updates.observations.lock().await;
        observations
            .statuses
            .retain(|item| item.plugin_id != result.id());
        if let Err(error) = save_cache(&self.runtime_root, &mut observations) {
            tracing::warn!(?error, "could not persist plugin update observations");
        }
        self.events
            .emit("plugin-updates-changed", &observations.statuses);
        self.events.emit("plugin-contributions-changed", now());
        Ok(plugin_control_item(&result))
    }

    /// Unified plugin update supporting both two-step preview/confirm (`apply_immediately = false`)
    /// and one-step update (`apply_immediately = true`) with optional `tag`, `version`, and `digest`.
    pub(crate) async fn plugin_update_with_mode(
        &self,
        args: Value,
        apply_immediately: bool,
    ) -> Result<Value, ApplicationError> {
        let args: UpdateRequest = parse(args)?;
        let installed = self
            .plugin_control_plane
            .plugin(&args.plugin_id)
            .await
            .map_err(plugin_error)?
            .ok_or_else(|| ApplicationError::not_found(args.plugin_id.clone()))?;
        if let Some(confirmation_id) = args.confirmation_id {
            let prepared = self
                .plugin_updates
                .prepared
                .lock()
                .await
                .remove(&confirmation_id)
                .ok_or_else(|| {
                    ApplicationError::conflict("update preview expired; preview again")
                })?;
            if prepared.package.id.as_str() != args.plugin_id
                || now().saturating_sub(prepared.created_at) > 600
            {
                return Err(ApplicationError::conflict(
                    "update preview expired; preview again",
                ));
            }
            if installed.package_digest != prepared.previous_digest
                || (installed.activation == PluginActivation::Enabled) != prepared.previous_enabled
                || installed.product_detail().map_err(plugin_error)?.config
                    != prepared.previous_config
            {
                return Err(ApplicationError::conflict(
                    "plugin or settings changed; preview the update again",
                ));
            }
            let digest = plugins::package_content_digest(&prepared.package.source.path)
                .map_err(plugin_error)?;
            let expected = prepared
                .package
                .source
                .update_lock
                .as_ref()
                .map(|lock| lock.package_digest.as_str());
            if expected != Some(digest.as_str())
                || prepared
                    .package
                    .product_detail()
                    .map_err(plugin_error)?
                    .config
                    != prepared.previous_config
            {
                return Err(ApplicationError::conflict(
                    "prepared update content changed",
                ));
            }
            return self
                .apply_prepared_plugin_update(&installed, prepared)
                .await;
        }
        let lock = installed
            .source
            .update_lock
            .clone()
            .or_else(|| {
                PluginSourceLock::from_source(
                    &installed.source,
                    &installed.version,
                    &installed.package_digest,
                )
            })
            .ok_or_else(|| ApplicationError::bad_request("plugin has no locked update source"))?;
        let resolver = PluginUpdateResolver::new().map_err(plugin_error)?;
        let requested_ref = args.tag.as_deref().or(args.version.as_deref());
        let candidate = resolver
            .resolve(&lock, requested_ref)
            .await
            .map_err(plugin_error)?
            .ok_or_else(|| ApplicationError::not_found("no stable plugin update is available"))?;
        let staging = tempfile::tempdir().map_err(internal_error)?;
        let archive = resolver
            .download(&candidate, staging.path())
            .await
            .map_err(plugin_error)?;
        let candidate_root = self.runtime_root.join("plugins/candidates");
        tokio::fs::create_dir_all(&candidate_root)
            .await
            .map_err(internal_error)?;
        let directory = tempfile::tempdir_in(candidate_root).map_err(internal_error)?;
        let mut package =
            PluginPackage::materialize_candidate(&archive, directory.path(), &installed.package)
                .map_err(plugin_error)?;
        plugins::validate_update_package(&package, &candidate).map_err(plugin_error)?;
        let digest = plugins::package_content_digest(&package.source.path).map_err(plugin_error)?;
        verify_requested_update_constraints(
            args.version.as_deref(),
            args.digest.as_deref(),
            &package.version,
            &digest,
            candidate.sha256.as_deref(),
        )?;
        let mut source_lock = candidate.source.clone();
        source_lock.package_digest = digest.clone();
        package.source.kind = match source_lock.source_kind.as_str() {
            "github" => plugins::PluginSourceKind::Snapshot,
            "marketplace" => plugins::PluginSourceKind::Marketplace,
            _ => package.source.kind,
        };
        package.source.origin = Some(source_lock.origin.clone());
        package.source.git_ref = Some(source_lock.tag.clone());
        package.source.git_sha = candidate.sha256.clone();
        package.source.locked = true;
        package.source.update_lock = Some(source_lock);
        package.source.show_tree = installed.source.show_tree;
        let prepared_update = PreparedPluginUpdate {
            package: package.clone(),
            _directory: directory,
            previous_digest: installed.package_digest.clone(),
            previous_config: installed.product_detail().map_err(plugin_error)?.config,
            previous_enabled: installed.activation == PluginActivation::Enabled,
            created_at: now(),
        };
        if apply_immediately {
            return self
                .apply_prepared_plugin_update(&installed, prepared_update)
                .await;
        }
        let confirmation_id = uuid::Uuid::new_v4().to_string();
        let response = json!({
            "confirmationId": confirmation_id,
            "plugin": plugin_control_item(&plugins::InstalledPlugin { package, activation: installed.activation, package_digest: digest.clone() }),
            "currentVersion": installed.version, "targetVersion": prepared_update.package.version,
            "packageDigest": digest, "source": candidate.source,
            "releaseNotes": candidate.release_notes,
        });
        let mut prepared = self.plugin_updates.prepared.lock().await;
        prepared.retain(|_, item| now().saturating_sub(item.created_at) <= 600);
        if prepared.len() >= 32 {
            return Err(ApplicationError::conflict(
                "too many pending update previews",
            ));
        }
        prepared.insert(confirmation_id, prepared_update);
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn observations_and_notification_deduplication_survive_restart() {
        let root = tempfile::tempdir().unwrap();
        let mut observations = UpdateObservations {
            statuses: vec![PluginUpdateStatus::failed(
                "acme.notes".into(),
                "offline".into(),
                None,
            )],
            notified: BTreeMap::from([("acme.notes".into(), "2.0.0".into())]),
            host_version: env!("CARGO_PKG_VERSION").to_owned(),
        };
        save_cache(root.path(), &mut observations).unwrap();
        let restored = PluginUpdates::load(root.path());
        let observations = restored.observations.lock().await;
        assert_eq!(observations.statuses[0].status, "failed");
        assert_eq!(observations.statuses[0].error.as_deref(), Some("offline"));
        assert_eq!(
            observations.notified.get("acme.notes").map(String::as_str),
            Some("2.0.0")
        );
    }

    #[tokio::test]
    async fn stale_failed_observations_from_older_host_are_cleared_on_load() {
        let root = tempfile::tempdir().unwrap();
        let path = cache_path(root.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let legacy = json!({
            "statuses": [
                {
                    "pluginId": "dimo.browser",
                    "updateAvailable": false,
                    "status": "failed",
                    "checkedAt": 100,
                    "lastSuccessfulAt": null,
                    "availableTag": null,
                    "availableVersion": null,
                    "error": "check plugin update: HTTP status client error (404 Not Found)",
                    "candidate": null
                },
                {
                    "pluginId": "acme.notes",
                    "updateAvailable": true,
                    "status": "available",
                    "checkedAt": 100,
                    "lastSuccessfulAt": 100,
                    "availableTag": "v2.0.0",
                    "availableVersion": "2.0.0",
                    "error": null,
                    "candidate": null
                }
            ],
            "notified": { "acme.notes": "2.0.0" }
        });
        std::fs::write(&path, legacy.to_string()).unwrap();
        let restored = PluginUpdates::load(root.path());
        let observations = restored.observations.lock().await;
        assert_eq!(observations.host_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(observations.statuses.len(), 1);
        assert_eq!(observations.statuses[0].plugin_id, "acme.notes");
        assert_eq!(
            observations.notified.get("acme.notes").map(String::as_str),
            Some("2.0.0")
        );
    }

    #[test]
    fn update_request_parses_version_digest_and_snake_case_aliases() {
        let req: UpdateRequest = parse(json!({
            "plugin_id": "acme.notes",
            "version": "2.1.0",
            "digest": "sha256:abc123",
            "confirmation_id": "conf-1"
        }))
        .expect("snake_case UpdateRequest");
        assert_eq!(req.plugin_id, "acme.notes");
        assert_eq!(req.version.as_deref(), Some("2.1.0"));
        assert_eq!(req.digest.as_deref(), Some("sha256:abc123"));
        assert_eq!(req.confirmation_id.as_deref(), Some("conf-1"));

        let camel: UpdateRequest = parse(json!({
            "pluginId": "acme.notes",
            "tag": "v2.1.0"
        }))
        .expect("camelCase UpdateRequest");
        assert_eq!(camel.tag.as_deref(), Some("v2.1.0"));
        assert!(camel.confirmation_id.is_none());
    }

    #[test]
    fn verify_requested_update_constraints_enforces_version_and_digest() {
        assert!(
            verify_requested_update_constraints(
                Some("v2.1.0"),
                Some("sha256:pkg"),
                "2.1.0",
                "sha256:pkg",
                Some("sha256:archive"),
            )
            .is_ok()
        );
        assert!(
            verify_requested_update_constraints(
                Some("2.1.0"),
                Some("sha256:archive"),
                "2.1.0",
                "sha256:pkg",
                Some("sha256:archive"),
            )
            .is_ok()
        );
        let version_err = verify_requested_update_constraints(
            Some("2.2.0"),
            None,
            "2.1.0",
            "sha256:pkg",
            None,
        )
        .expect_err("version mismatch should fail");
        assert!(version_err.to_string().contains("2.2.0"));

        let digest_err = verify_requested_update_constraints(
            None,
            Some("sha256:wrong"),
            "2.1.0",
            "sha256:pkg",
            Some("sha256:archive"),
        )
        .expect_err("digest mismatch should fail");
        assert!(digest_err.to_string().contains("sha256:wrong"));
    }
}
