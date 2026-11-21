use std::{
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use agents::{AgentAuthenticationStatus, AgentId, BuiltInProfileCatalog};
use delegation::DelegationBroker;
use deployment::Deployment;
use local_deployment::LocalDeployment;
use plugins::NativePluginAdapter;
use services::services::{
    agent_management::AgentManagementApplicationService,
    agent_management_runtime::AgentManagementRuntimeState,
};
use sqlx::SqlitePool;

const MANAGEMENT_INVALIDATED_EVENT: &str = "agent-management-snapshot-invalidated";
const MAX_PLUGIN_ARCHIVE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_PLUGIN_ARCHIVE_ENTRIES: usize = 5_000;

/// Dependencies required to import queued CLI packages from `~/.dimo/imports`.
#[derive(Clone)]
pub struct CliInboxContext {
    pub plugin_control_plane: Arc<plugins::PluginControlPlane>,
    pub worker_runtime: Arc<plugins::PluginWorkerRuntimeProvider>,
    pub capability_broker: Arc<plugins::HostCapabilityBroker>,
    pub delegation_broker: Arc<DelegationBroker>,
    pub deployment: Arc<LocalDeployment>,
    pub data_dir: PathBuf,
}

#[derive(Default, Debug, PartialEq, Eq)]
struct InboxOriginLock {
    origin: Option<String>,
    git_ref: Option<String>,
    git_sha: Option<String>,
    locked: Option<bool>,
}

struct ExtractedPluginArchive {
    _staging: tempfile::TempDir,
    root: PathBuf,
}

/// Imports queued `.vxp` / `.zip` plugin packages dropped into `~/.dimo/imports`
/// by the CLI. Does not re-run `import_queued_developer_links()`, which
/// `composition.rs` executes earlier during bootstrap.
pub async fn import_cli_inbox(ctx: CliInboxContext) {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let inbox = home.join(".dimo").join("imports");
    import_cli_inbox_from(&inbox, &ctx).await;
}

async fn import_cli_inbox_from(inbox: &Path, ctx: &CliInboxContext) {
    let inbox_owned = inbox.to_path_buf();
    let entries = match tokio::task::spawn_blocking(move || {
        let Ok(read_dir) = std::fs::read_dir(&inbox_owned) else {
            return Vec::new();
        };
        let mut paths = Vec::new();
        for entry in read_dir.flatten() {
            let path = entry.path();
            if is_cli_inbox_package(&path) && !cli_inbox_marker(&path).exists() {
                paths.push(path);
            }
        }
        paths.sort();
        paths
    })
    .await
    {
        Ok(paths) => paths,
        Err(error) => {
            tracing::warn!(%error, "failed to scan CLI plugin import inbox");
            return;
        }
    };

    for path in entries {
        let marker = cli_inbox_marker(&path);
        let sidecar_path = path.clone();
        let lock = tokio::task::spawn_blocking(move || read_origin_sidecar(&sidecar_path))
            .await
            .unwrap_or_default();
        match import_cli_package(ctx, &path, lock).await {
            Ok(plugin_id) => {
                tracing::info!(
                    plugin = %plugin_id,
                    path = %path.display(),
                    "imported CLI marketplace package"
                );
                let _ = tokio::fs::write(&marker, format!("{plugin_id}\n")).await;
            }
            Err(CliImportError::Conflict(detail)) => {
                tracing::debug!(
                    path = %path.display(),
                    %detail,
                    "CLI marketplace package already installed; marking imported"
                );
                let _ = tokio::fs::write(&marker, "installed\n").await;
            }
            Err(CliImportError::Failed(error)) => {
                tracing::warn!(
                    path = %path.display(),
                    %error,
                    "CLI marketplace package import failed"
                );
            }
        }
    }
}

enum CliImportError {
    Conflict(String),
    Failed(String),
}

async fn import_cli_package(
    ctx: &CliInboxContext,
    input: &Path,
    lock: InboxOriginLock,
) -> Result<String, CliImportError> {
    let source_kind = if plugins::origin_kind(lock.origin.as_deref()) == Some("marketplace") {
        plugins::PluginSourceKind::Marketplace
    } else {
        plugins::PluginSourceKind::Snapshot
    };
    let decision = plugins::ConflictDecision::KeepInstalled;

    let input_owned = input.to_path_buf();
    let extracted = tokio::task::spawn_blocking(move || {
        if input_owned.is_file() {
            extract_plugin_archive(&input_owned).map(Some)
        } else {
            Ok(None)
        }
    })
    .await
    .map_err(|error| CliImportError::Failed(error.to_string()))??;

    let source = extracted
        .as_ref()
        .map(|archive| archive.root.as_path())
        .unwrap_or(input);

    if !source.join(".dimo-plugin/plugin.json").is_file() {
        return import_native_plugin(source, source_kind, decision).await;
    }

    let source_buf = source.to_path_buf();
    let incoming = tokio::task::spawn_blocking(move || {
        plugins::PluginPackage::inspect(&source_buf, source_kind)
    })
    .await
    .map_err(|error| CliImportError::Failed(error.to_string()))?
    .map_err(|error| CliImportError::Failed(error.to_string()))?;

    let installed = ctx
        .plugin_control_plane
        .plugin(incoming.id.as_str())
        .await
        .map_err(|error| CliImportError::Failed(error.to_string()))?;
    if installed.is_some() {
        return Ok(incoming.id.as_str().to_owned());
    }

    let storage = ctx.data_dir.join("plugins").join("snapshots");
    let source_buf = source.to_path_buf();
    let mut package = tokio::task::spawn_blocking(move || {
        plugins::PluginPackage::materialize(&source_buf, &storage, source_kind)
    })
    .await
    .map_err(|error| CliImportError::Failed(error.to_string()))?
    .map_err(|error| CliImportError::Failed(error.to_string()))?;

    package.source.kind = source_kind;
    package.source.origin = lock.origin.or(package.source.origin);
    package.source.git_ref = lock.git_ref.or(package.source.git_ref);
    package.source.git_sha = lock.git_sha.or(package.source.git_sha);
    package.source.locked = lock.locked.unwrap_or(package.source.locked);

    let imported = ctx
        .plugin_control_plane
        .import(package, decision)
        .await
        .map_err(|error| {
            let text = error.to_string();
            if text.to_ascii_lowercase().contains("already installed") {
                CliImportError::Conflict(text)
            } else {
                CliImportError::Failed(text)
            }
        })?;
    let plugin_id = imported.plugin.id().to_owned();

    if let Err(error) = enable_imported_plugin(ctx, &plugin_id).await {
        tracing::warn!(
            plugin = %plugin_id,
            %error,
            "post-import automatic plugin activation failed; keeping plugin installed"
        );
    }

    Ok(plugin_id)
}

async fn enable_imported_plugin(ctx: &CliInboxContext, plugin_id: &str) -> Result<(), String> {
    let installed = ctx
        .plugin_control_plane
        .plugin(plugin_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("plugin `{plugin_id}` not found"))?;
    let has_worker = installed.package.entrypoints.worker.is_some();
    let grants = plugins::candidate_capability_grants(&installed.package, &[], &[])
        .map_err(|error| error.to_string())?;
    ctx.plugin_control_plane
        .validate_runtime_readiness(plugin_id)
        .await
        .map_err(|error| format!("{}: {error}", error.code()))?;

    if has_worker {
        let node = ctx
            .worker_runtime
            .resolve()
            .await
            .map_err(|error| error.to_string())?;
        ctx.plugin_control_plane
            .activate_and_enable(&node, plugin_id, &grants, ctx.capability_broker.clone())
            .await
            .map_err(|error| format!("{}: {error}", error.code()))?;
    } else {
        ctx.plugin_control_plane
            .set_enabled(plugin_id, true)
            .await
            .map_err(|error| error.to_string())?;
    }

    let host_config = ctx.deployment.config().read().await.clone();
    let _ = crate::host::plugin_projections::refresh_official_product_runtime_with(
        &ctx.plugin_control_plane,
        &ctx.delegation_broker,
        &host_config,
    )
    .await;
    Ok(())
}

async fn import_native_plugin(
    source: &Path,
    source_kind: plugins::PluginSourceKind,
    decision: plugins::ConflictDecision,
) -> Result<String, CliImportError> {
    let home = dirs::home_dir()
        .ok_or_else(|| CliImportError::Failed("cannot resolve the user home directory".into()))?;
    let mut adapters = Vec::new();
    if source.join(".codex-plugin/plugin.json").is_file() {
        adapters.push(plugins::FilesystemNativePluginAdapter::codex(
            home.join(".codex/plugins/cache"),
        ));
    }
    if source.join(".claude-plugin/plugin.json").is_file() {
        adapters.push(plugins::FilesystemNativePluginAdapter::claude_code(
            home.join(".claude/plugins/cache"),
        ));
    }
    let mut imported_id: Option<String> = None;
    for adapter in adapters {
        let descriptor = adapter
            .install(source, source_kind, decision)
            .await
            .map_err(|error| CliImportError::Failed(error.to_string()))?;
        if let Some(ref current_id) = imported_id {
            if current_id != &descriptor.id {
                return Err(CliImportError::Failed(
                    "co-located native manifests must declare the same plugin ID".into(),
                ));
            }
        } else {
            imported_id = Some(descriptor.id);
        }
    }
    imported_id.ok_or_else(|| {
        CliImportError::Failed(
            "plugin source must contain a Dimo, Codex, or Claude Code manifest".into(),
        )
    })
}

fn is_cli_inbox_package(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if name.ends_with(".imported") {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".vxp") || lower.ends_with(".zip")
}

fn cli_inbox_marker(path: &Path) -> PathBuf {
    let mut marker = path.as_os_str().to_os_string();
    marker.push(".imported");
    PathBuf::from(marker)
}

fn read_origin_sidecar(path: &Path) -> InboxOriginLock {
    let sidecar = {
        let mut name = path.as_os_str().to_os_string();
        name.push(".origin.json");
        PathBuf::from(name)
    };
    let Ok(text) = std::fs::read_to_string(sidecar) else {
        return InboxOriginLock::default();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return InboxOriginLock::default();
    };
    InboxOriginLock {
        origin: value
            .get("origin")
            .and_then(serde_json::Value::as_str)
            .filter(|item| !item.is_empty())
            .map(str::to_owned),
        git_ref: value
            .get("gitRef")
            .and_then(serde_json::Value::as_str)
            .filter(|item| !item.is_empty())
            .map(str::to_owned),
        git_sha: value
            .get("gitSha")
            .and_then(serde_json::Value::as_str)
            .filter(|item| !item.is_empty())
            .map(str::to_owned),
        locked: value.get("locked").and_then(serde_json::Value::as_bool),
    }
}

fn is_gzip_archive(path: &Path) -> bool {
    let mut magic = [0u8; 2];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut magic))
        .is_ok()
        && magic == [0x1f, 0x8b]
}

fn extract_plugin_archive(path: &Path) -> Result<ExtractedPluginArchive, CliImportError> {
    if is_gzip_archive(path) {
        return extract_plugin_tar_gz(path);
    }
    extract_plugin_zip(path)
}

fn safe_relative_archive_path(entry_path: &Path) -> Result<Option<PathBuf>, CliImportError> {
    let mut clean = PathBuf::new();
    for component in entry_path.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(CliImportError::Failed(format!(
                    "unsafe archive entry path: {}",
                    entry_path.display()
                )));
            }
        }
    }
    if clean.as_os_str().is_empty() {
        Ok(None)
    } else {
        Ok(Some(clean))
    }
}

fn resolve_extracted_root(staging_root: &Path) -> PathBuf {
    if staging_root.join(".dimo-plugin/plugin.json").is_file()
        || staging_root.join(".codex-plugin/plugin.json").is_file()
        || staging_root.join(".claude-plugin/plugin.json").is_file()
    {
        return staging_root.to_path_buf();
    }
    if let Ok(entries) = std::fs::read_dir(staging_root) {
        let subdirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        if subdirs.len() == 1 {
            return subdirs[0].clone();
        }
    }
    staging_root.to_path_buf()
}

fn extract_plugin_tar_gz(path: &Path) -> Result<ExtractedPluginArchive, CliImportError> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| CliImportError::Failed(format!("cannot read plugin archive: {error}")))?;
    if metadata.len() > MAX_PLUGIN_ARCHIVE_BYTES {
        return Err(CliImportError::Failed(
            "plugin archive must be 100 MB or smaller".into(),
        ));
    }
    let file = File::open(path)
        .map_err(|error| CliImportError::Failed(format!("cannot open plugin archive: {error}")))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let temp_root = utils::path::get_dimo_temp_dir();
    let _ = std::fs::create_dir_all(&temp_root);
    let staging = tempfile::tempdir_in(&temp_root)
        .map_err(|error| CliImportError::Failed(format!("cannot stage plugin archive: {error}")))?;
    let mut extracted_bytes = 0_u64;
    let mut entries = 0_usize;

    for entry in archive
        .entries()
        .map_err(|error| CliImportError::Failed(format!("invalid plugin tar.gz: {error}")))?
    {
        let mut entry = entry
            .map_err(|error| CliImportError::Failed(format!("unreadable tar.gz entry: {error}")))?;
        entries += 1;
        if entries > MAX_PLUGIN_ARCHIVE_ENTRIES {
            return Err(CliImportError::Failed(
                "plugin archive contains more than 5,000 entries".into(),
            ));
        }
        let raw_path = entry
            .path()
            .map_err(|error| CliImportError::Failed(format!("invalid tar.gz path: {error}")))?
            .into_owned();
        let Some(rel) = safe_relative_archive_path(&raw_path)? else {
            continue;
        };
        let dest = staging.path().join(rel);
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&dest)
                .map_err(|error| CliImportError::Failed(error.to_string()))?;
            continue;
        }
        if !entry.header().entry_type().is_file() {
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| CliImportError::Failed(error.to_string()))?;
        }
        let mut out = File::create(&dest)
            .map_err(|error| CliImportError::Failed(error.to_string()))?;
        let written = std::io::copy(&mut entry, &mut out)
            .map_err(|error| CliImportError::Failed(error.to_string()))?;
        extracted_bytes = extracted_bytes.saturating_add(written);
        if extracted_bytes > MAX_PLUGIN_ARCHIVE_BYTES {
            return Err(CliImportError::Failed(
                "extracted plugin archive exceeds 100 MB limit".into(),
            ));
        }
    }

    let root = resolve_extracted_root(staging.path());
    Ok(ExtractedPluginArchive {
        _staging: staging,
        root,
    })
}

fn extract_plugin_zip(path: &Path) -> Result<ExtractedPluginArchive, CliImportError> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| CliImportError::Failed(format!("cannot read plugin archive: {error}")))?;
    if metadata.len() > MAX_PLUGIN_ARCHIVE_BYTES {
        return Err(CliImportError::Failed(
            "plugin archive must be 100 MB or smaller".into(),
        ));
    }
    let file = File::open(path)
        .map_err(|error| CliImportError::Failed(format!("cannot open plugin archive: {error}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| CliImportError::Failed(format!("invalid plugin zip: {error}")))?;
    if archive.len() > MAX_PLUGIN_ARCHIVE_ENTRIES {
        return Err(CliImportError::Failed(
            "plugin archive contains more than 5,000 entries".into(),
        ));
    }
    let temp_root = utils::path::get_dimo_temp_dir();
    let _ = std::fs::create_dir_all(&temp_root);
    let staging = tempfile::tempdir_in(&temp_root)
        .map_err(|error| CliImportError::Failed(format!("cannot stage plugin archive: {error}")))?;
    let mut extracted_bytes = 0_u64;

    for idx in 0..archive.len() {
        let mut entry = archive
            .by_index(idx)
            .map_err(|error| CliImportError::Failed(format!("unreadable zip entry: {error}")))?;
        let Some(enclosed) = entry.enclosed_name() else {
            return Err(CliImportError::Failed(format!(
                "unsafe zip entry path: {}",
                entry.name()
            )));
        };
        let Some(rel) = safe_relative_archive_path(&enclosed)? else {
            continue;
        };
        let dest = staging.path().join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&dest)
                .map_err(|error| CliImportError::Failed(error.to_string()))?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| CliImportError::Failed(error.to_string()))?;
        }
        let mut out = File::create(&dest)
            .map_err(|error| CliImportError::Failed(error.to_string()))?;
        let written = std::io::copy(&mut entry, &mut out)
            .map_err(|error| CliImportError::Failed(error.to_string()))?;
        extracted_bytes = extracted_bytes.saturating_add(written);
        if extracted_bytes > MAX_PLUGIN_ARCHIVE_BYTES {
            return Err(CliImportError::Failed(
                "extracted plugin archive exceeds 100 MB limit".into(),
            ));
        }
    }

    let root = resolve_extracted_root(staging.path());
    Ok(ExtractedPluginArchive {
        _staging: staging,
        root,
    })
}

/// Removes orphaned Agent CLI shims on PATH and reclassifies historical
/// `ownership = 'managed'` rows in `agent_installation` to `'external'`.
///
/// Mirrors the Tauri `reconcile_managed_cli_exposures` startup hook (ADR-0060).
pub async fn reconcile_managed_cli_exposures(pool: &SqlitePool) {
    let home = dirs::home_dir();
    reconcile_managed_cli_exposures_in(home.as_deref(), pool).await;
}

async fn reconcile_managed_cli_exposures_in(home_dir: Option<&Path>, pool: &SqlitePool) {
    match home_dir.map(Path::to_path_buf) {
        Some(home) => match tokio::task::spawn_blocking(move || {
            agents::remove_orphaned_cli_shims(&home)
        })
        .await
        {
            Ok(Ok(removed)) if !removed.is_empty() => {
                tracing::info!(
                    count = removed.len(),
                    commands = %removed
                        .iter()
                        .map(|shim| shim.command_name.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                    "removed Agent CLI shims whose Runtime no longer exists"
                );
            }
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                tracing::warn!(%error, "failed to sweep orphaned Agent CLI shims");
            }
            Err(error) => {
                tracing::warn!(%error, "orphaned Agent CLI shim sweep task failed");
            }
        },
        None => {
            tracing::warn!("failed to locate the home directory for the CLI shim sweep");
        }
    }

    match sqlx::query(
        r#"UPDATE agent_installation
           SET ownership = 'external', updated_at = CURRENT_TIMESTAMP
           WHERE ownership = 'managed'"#,
    )
    .execute(pool)
    .await
    {
        Ok(result) if result.rows_affected() > 0 => {
            tracing::info!(
                count = result.rows_affected(),
                "reclassified managed Agent installations as user-environment observations"
            );
        }
        Ok(_) => {}
        Err(error) => {
            tracing::warn!(%error, "failed to reclassify managed Agent installations");
        }
    }
}

/// Warms Agent management evidence, integrity checks, and authentication caches
/// once at startup, then emits `agent-management-snapshot-invalidated` and
/// releases SQLite page cache working set.
pub async fn warm_agent_management(
    pool: &SqlitePool,
    runtime: &AgentManagementRuntimeState,
    events: &crate::HostEventBus,
) {
    runtime
        .run_warmup_once(async {
            normalize_optional_profile_authentication(pool).await;
            if let Err(error) = AgentManagementApplicationService::new(pool.clone())
                .refresh_component_integrity()
                .await
            {
                tracing::warn!(%error, "Agent management integrity refresh failed during warmup");
            }
            refresh_authentication_probes(pool).await;
        })
        .await;
    events.emit(MANAGEMENT_INVALIDATED_EVENT, ());
    crate::desktop::release_startup_working_set(pool).await;
}

async fn normalize_optional_profile_authentication(pool: &SqlitePool) {
    let service = AgentManagementApplicationService::new(pool.clone());
    for profile in BuiltInProfileCatalog::bundled()
        .profiles()
        .iter()
        .filter(|profile| !profile.authentication_required_by_default)
    {
        if let Err(error) = service
            .sync_authentication(
                &profile.agent_id,
                AgentAuthenticationStatus::NotRequired,
                Some(false),
            )
            .await
        {
            tracing::warn!(
                agent_id = %profile.agent_id,
                %error,
                "failed to normalize optional profile authentication"
            );
        }
    }
}

async fn refresh_authentication_probes(pool: &SqlitePool) {
    let agent_ids = match sqlx::query_scalar::<_, String>("SELECT agent_id FROM agent_membership")
        .fetch_all(pool)
        .await
    {
        Ok(agent_ids) => agent_ids,
        Err(error) => {
            tracing::warn!(%error, "failed to load Agents for authentication refresh");
            return;
        }
    };
    for raw_agent_id in agent_ids {
        let Ok(agent_id) = AgentId::parse(raw_agent_id) else {
            continue;
        };
        if let Err(error) =
            crate::host::management::persist_observed_authentication(pool, &agent_id).await
        {
            tracing::debug!(
                agent_id = %agent_id,
                %error,
                "failed to refresh Agent authentication during warmup"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    #[tokio::test]
    async fn reconcile_managed_cli_exposures_reclassifies_managed_rows() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("test.sqlite");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&db_path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE agent_installation (
                agent_id TEXT PRIMARY KEY,
                ownership TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_installation (agent_id, ownership, updated_at)
             VALUES ('codex', 'managed', '2026-01-01'), ('claude', 'external', '2026-01-01')",
        )
        .execute(&pool)
        .await
        .unwrap();

        reconcile_managed_cli_exposures_in(Some(temp.path()), &pool).await;

        let ownership: String =
            sqlx::query_scalar("SELECT ownership FROM agent_installation WHERE agent_id = 'codex'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(ownership, "external");

        pool.close().await;
    }

    #[test]
    fn cli_inbox_package_detection_and_origin_sidecar_parsing() {
        let temp = tempfile::tempdir().unwrap();
        let pkg = temp.path().join("demo.vxp");
        std::fs::write(&pkg, b"zip").unwrap();
        let imported = cli_inbox_marker(&pkg);
        std::fs::write(&imported, b"demo\n").unwrap();
        let other = temp.path().join("readme.txt");
        std::fs::write(&other, b"ignore").unwrap();

        assert!(is_cli_inbox_package(&pkg));
        assert!(!is_cli_inbox_package(&imported));
        assert!(!is_cli_inbox_package(&other));

        let sidecar = temp.path().join("demo.vxp.origin.json");
        std::fs::write(
            &sidecar,
            r#"{"origin":"marketplace:dimo/demo","gitRef":"main","gitSha":"abc123","locked":true}"#,
        )
        .unwrap();
        let lock = read_origin_sidecar(&pkg);
        assert_eq!(
            lock,
            InboxOriginLock {
                origin: Some("marketplace:dimo/demo".to_string()),
                git_ref: Some("main".to_string()),
                git_sha: Some("abc123".to_string()),
                locked: Some(true),
            }
        );
    }
}
