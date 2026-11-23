use std::{
    ffi::OsStr,
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::error::DesktopError;

const BACKUP_FORMAT: &str = "dimo-portable-backup";
const BACKUP_VERSION: u32 = 1;
const BACKUP_PROGRESS_EVENT: &str = "dimo://backup-progress";
const PENDING_RESTORE_DIR: &str = ".pending-restore";
const PENDING_RESTORE_MANIFEST: &str = "pending.json";
const PENDING_RESTORE_VERSION: u32 = 1;
const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";

static BACKUP_CANCELLED: AtomicBool = AtomicBool::new(false);

fn begin_backup_operation() {
    BACKUP_CANCELLED.store(false, Ordering::SeqCst);
}

fn check_backup_cancelled() -> Result<(), DesktopError> {
    if BACKUP_CANCELLED.load(Ordering::SeqCst) {
        return Err(DesktopError::BadRequest(
            "Backup operation cancelled".to_string(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct BackupRoots {
    asset_dir: PathBuf,
    dimo_root: PathBuf,
}

impl BackupRoots {
    fn current() -> Result<Self, DesktopError> {
        Ok(Self {
            asset_dir: utils::assets::asset_dir(),
            dimo_root: dimo_root()?,
        })
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct BackupCreateOptions {
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BackupInspectOptions {
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BackupRestoreStagePayload {
    pub path: String,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    pub format: String,
    pub version: u32,
    pub created_at: String,
    pub app_version: String,
    pub entry_count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupPreviewEntry {
    pub path: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
    /// Whether a live file already exists at this entry's restore target — used
    /// to warn which files a restore would overwrite (meaningful on inspect/restore).
    pub already_exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupPreview {
    pub manifest: BackupManifest,
    pub entries: Vec<BackupPreviewEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupRestoreResult {
    pub preview: BackupPreview,
    pub restored_entries: usize,
    pub requires_reload: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupProgressEvent {
    pub operation: String,
    pub stage: String,
    pub completed: usize,
    pub total: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PortableBackup {
    manifest: BackupManifest,
    entries: Vec<BackupEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BackupEntry {
    path: String,
    size_bytes: u64,
    modified_at: Option<String>,
    bytes_base64: String,
}

#[derive(Debug, Clone)]
struct BackupSource {
    logical_path: String,
    file_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingRestoreManifest {
    version: u32,
    created_at: String,
    stage_dir_name: String,
    entries: Vec<PendingRestoreEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingRestoreEntry {
    logical_path: String,
    target_path: PathBuf,
    staged_file: String,
}

/// Removes a temporary file when dropped unless explicitly disarmed.
struct TempFileGuard {
    path: PathBuf,
    keep: bool,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, keep: false }
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Removes a temporary directory when dropped unless committed.
struct TempDirGuard {
    path: PathBuf,
    committed: bool,
}

impl TempDirGuard {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn emit_progress(
    events: &crate::HostEventBus,
    operation: &str,
    stage: &str,
    completed: usize,
    total: usize,
    message: impl Into<String>,
) {
    events.emit(
        BACKUP_PROGRESS_EVENT,
        BackupProgressEvent {
            operation: operation.to_string(),
            stage: stage.to_string(),
            completed,
            total,
            message: message.into(),
        },
    );
}

fn modified_at(metadata: &fs::Metadata) -> Option<String> {
    let modified = metadata.modified().ok()?;
    let datetime: DateTime<Utc> = modified.into();
    Some(datetime.to_rfc3339())
}

fn asset_file_source(asset_dir: &Path, name: &str) -> Option<BackupSource> {
    let file_path = asset_dir.join(name);
    file_path.exists().then(|| BackupSource {
        logical_path: format!("asset/{name}"),
        file_path,
    })
}

fn dimo_root() -> Result<PathBuf, DesktopError> {
    dirs::home_dir()
        .map(|home| home.join(".dimo"))
        .ok_or_else(|| DesktopError::Internal("Unable to resolve user home directory".to_string()))
}

fn is_internal_backup_temp_name(name: &str) -> bool {
    name == PENDING_RESTORE_DIR
        || ((name.contains(".dimo-restore.")
            || name.contains(".dimo-rollback.")
            || name.contains(".dimo-backup-snapshot."))
            && name.ends_with(".tmp"))
}

fn entry_is_sqlite_db(logical_path: &str) -> bool {
    matches!(
        logical_path,
        "asset/db.sqlite" | "asset/db.sqlite-wal" | "asset/db.sqlite-shm"
    )
}

fn collect_directory_sources(
    base: &Path,
    logical_prefix: &str,
    current: &Path,
    sources: &mut Vec<BackupSource>,
) -> Result<(), DesktopError> {
    if !current.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(current).map_err(|error| {
        DesktopError::Internal(format!(
            "Failed to read directory {}: {error}",
            current.display()
        ))
    })? {
        let entry = entry.map_err(|error| {
            DesktopError::Internal(format!("Failed to read directory entry: {error}"))
        })?;
        let path = entry.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(is_internal_backup_temp_name)
        {
            continue;
        }
        let metadata = fs::metadata(&path).map_err(|error| {
            DesktopError::Internal(format!(
                "Failed to read metadata {}: {error}",
                path.display()
            ))
        })?;

        if metadata.is_dir() {
            collect_directory_sources(base, logical_prefix, &path, sources)?;
            continue;
        }

        if !metadata.is_file() {
            continue;
        }

        let relative = path.strip_prefix(base).map_err(|error| {
            DesktopError::Internal(format!(
                "Failed to derive relative backup path for {}: {error}",
                path.display()
            ))
        })?;
        let mut logical_path = logical_prefix.to_string();
        for component in relative.components() {
            let Component::Normal(part) = component else {
                continue;
            };
            logical_path.push('/');
            logical_path.push_str(&part.to_string_lossy().replace('\\', "/"));
        }

        sources.push(BackupSource {
            logical_path,
            file_path: path,
        });
    }

    Ok(())
}

fn collect_sources(
    roots: &BackupRoots,
    db_snapshot_override: Option<&Path>,
) -> Result<Vec<BackupSource>, DesktopError> {
    let mut sources = Vec::new();
    for name in [
        "settings.json",
        "mcp.json",
        "agent-model-providers.json",
        ".env",
        "config.json",
        "profiles.json",
        "db.sqlite",
        "version-control-settings.json",
        "instructions-metadata.json",
        "system-settings.json",
        "web-service-settings.json",
        "chat-channel-settings.json",
        "chat-channel-secrets.json",
    ] {
        if name == "db.sqlite"
            && let Some(snapshot) = db_snapshot_override
            && snapshot.is_file()
        {
            sources.push(BackupSource {
                logical_path: "asset/db.sqlite".to_string(),
                file_path: snapshot.to_path_buf(),
            });
            continue;
        }
        if let Some(source) = asset_file_source(&roots.asset_dir, name) {
            sources.push(source);
        }
    }

    let settings_path = roots.dimo_root.join("settings.json");
    if settings_path.exists() {
        sources.push(BackupSource {
            logical_path: "dimo/settings.json".to_string(),
            file_path: settings_path,
        });
    }
    let mcp_path = roots.dimo_root.join("mcp.json");
    if mcp_path.exists() {
        sources.push(BackupSource {
            logical_path: "dimo/mcp.json".to_string(),
            file_path: mcp_path,
        });
    }

    collect_directory_sources(
        &roots.dimo_root.join("skills"),
        "dimo/skills",
        &roots.dimo_root.join("skills"),
        &mut sources,
    )?;

    sources.sort_by(|a, b| a.logical_path.cmp(&b.logical_path));
    Ok(sources)
}

fn build_manifest(entries: &[BackupEntry]) -> BackupManifest {
    BackupManifest {
        format: BACKUP_FORMAT.to_string(),
        version: BACKUP_VERSION,
        created_at: Utc::now().to_rfc3339(),
        app_version: utils::version::runtime_app_version(),
        entry_count: entries.len(),
        total_bytes: entries.iter().map(|entry| entry.size_bytes).sum(),
    }
}

fn preview_from_backup(backup: &PortableBackup, roots: &BackupRoots) -> BackupPreview {
    BackupPreview {
        manifest: backup.manifest.clone(),
        entries: backup
            .entries
            .iter()
            .map(|entry| BackupPreviewEntry {
                path: entry.path.clone(),
                size_bytes: entry.size_bytes,
                modified_at: entry.modified_at.clone(),
                already_exists: resolve_restore_target_with_roots(roots, &entry.path)
                    .map(|target| target.exists())
                    .unwrap_or(false),
            })
            .collect(),
    }
}

fn validate_backup(backup: &PortableBackup) -> Result<(), DesktopError> {
    if backup.manifest.format != BACKUP_FORMAT {
        return Err(DesktopError::BadRequest(format!(
            "Unsupported backup format: {}",
            backup.manifest.format
        )));
    }
    if backup.manifest.version != BACKUP_VERSION {
        return Err(DesktopError::BadRequest(format!(
            "Unsupported backup version: {}",
            backup.manifest.version
        )));
    }
    Ok(())
}

fn read_backup_file(path: &Path) -> Result<PortableBackup, DesktopError> {
    let bytes = fs::read(path).map_err(|error| {
        DesktopError::Internal(format!("Failed to read backup {}: {error}", path.display()))
    })?;

    let backup: PortableBackup = serde_json::from_slice(&bytes).map_err(|error| {
        DesktopError::BadRequest(format!(
            "Failed to parse backup {}: {error}",
            path.display()
        ))
    })?;
    validate_backup(&backup)?;
    Ok(backup)
}

fn resolve_restore_target_with_roots(
    roots: &BackupRoots,
    logical_path: &str,
) -> Result<PathBuf, DesktopError> {
    let path = Path::new(logical_path);
    if path.is_absolute() {
        return Err(DesktopError::BadRequest(format!(
            "Backup entry path must be relative: {logical_path}"
        )));
    }

    let mut components = path.components();
    let Some(Component::Normal(prefix)) = components.next() else {
        return Err(DesktopError::BadRequest(format!(
            "Invalid backup entry path: {logical_path}"
        )));
    };

    let mut target = if prefix == OsStr::new("asset") {
        roots.asset_dir.clone()
    } else if prefix == OsStr::new("dimo") {
        roots.dimo_root.clone()
    } else {
        return Err(DesktopError::BadRequest(format!(
            "Unsupported backup entry root: {}",
            prefix.to_string_lossy()
        )));
    };

    let mut has_child = false;
    for component in components {
        let Component::Normal(part) = component else {
            return Err(DesktopError::BadRequest(format!(
                "Unsafe backup entry path: {logical_path}"
            )));
        };
        target.push(part);
        has_child = true;
    }

    if !has_child {
        return Err(DesktopError::BadRequest(format!(
            "Invalid backup entry path: {logical_path}"
        )));
    }

    Ok(target)
}

async fn prepare_sqlite_snapshot(pool: &SqlitePool, asset_dir: &Path) -> Option<TempFileGuard> {
    match tokio::time::timeout(
        Duration::from_secs(5),
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(pool),
    )
    .await
    {
        Ok(Ok(_)) => {
            tracing::debug!("SQLite WAL checkpoint(TRUNCATE) completed before backup");
        }
        Ok(Err(error)) => {
            tracing::warn!(%error, "SQLite WAL checkpoint(TRUNCATE) before backup failed; continuing");
        }
        Err(_) => {
            tracing::warn!("SQLite WAL checkpoint(TRUNCATE) before backup timed out; continuing");
        }
    }

    let db_path = asset_dir.join("db.sqlite");
    if !db_path.is_file() {
        return None;
    }

    let snapshot_path = asset_dir.join(format!(
        ".db.sqlite.dimo-backup-snapshot.{}.tmp",
        Uuid::new_v4()
    ));
    let snapshot_str = snapshot_path.to_string_lossy().to_string();
    let guard = TempFileGuard::new(snapshot_path.clone());

    match tokio::time::timeout(
        Duration::from_secs(15),
        sqlx::query("VACUUM INTO ?1")
            .bind(&snapshot_str)
            .execute(pool),
    )
    .await
    {
        Ok(Ok(_)) if snapshot_path.is_file() => Some(guard),
        Ok(Ok(_)) => {
            tracing::warn!(
                snapshot = %snapshot_path.display(),
                "VACUUM INTO succeeded but snapshot file was missing; falling back to checkpointed db.sqlite"
            );
            None
        }
        Ok(Err(error)) => {
            tracing::warn!(
                %error,
                "VACUUM INTO before backup failed; falling back to checkpointed db.sqlite"
            );
            None
        }
        Err(_) => {
            tracing::warn!(
                "VACUUM INTO before backup timed out; falling back to checkpointed db.sqlite"
            );
            None
        }
    }
}

pub async fn backup_create(
    events: &Arc<crate::HostEventBus>,
    pool: Option<&SqlitePool>,
    options: BackupCreateOptions,
) -> Result<BackupPreview, DesktopError> {
    let roots = BackupRoots::current()?;
    backup_create_with_roots(Arc::clone(events), pool, roots, options).await
}

async fn backup_create_with_roots(
    events: Arc<crate::HostEventBus>,
    pool: Option<&SqlitePool>,
    roots: BackupRoots,
    options: BackupCreateOptions,
) -> Result<BackupPreview, DesktopError> {
    begin_backup_operation();
    let backup_path = PathBuf::from(options.path.trim());
    if backup_path.as_os_str().is_empty() {
        return Err(DesktopError::BadRequest(
            "Backup destination path cannot be empty".to_string(),
        ));
    }

    let db_snapshot_guard = if let Some(pool) = pool {
        prepare_sqlite_snapshot(pool, &roots.asset_dir).await
    } else {
        None
    };

    tokio::task::spawn_blocking(move || {
        let _guard = db_snapshot_guard;
        let snapshot_path = _guard.as_ref().map(|g| g.path.as_path());
        let sources = collect_sources(&roots, snapshot_path)?;
        check_backup_cancelled()?;
        emit_progress(
            &events,
            "create",
            "collect",
            0,
            sources.len(),
            "Collected Dimo data files",
        );

        let total = sources.len();
        let mut entries = Vec::with_capacity(total);
        for (index, source) in sources.into_iter().enumerate() {
            check_backup_cancelled()?;
            let bytes = fs::read(&source.file_path).map_err(|error| {
                DesktopError::Internal(format!(
                    "Failed to read backup source {}: {error}",
                    source.file_path.display()
                ))
            })?;
            let metadata = fs::metadata(&source.file_path).map_err(|error| {
                DesktopError::Internal(format!(
                    "Failed to read backup source metadata {}: {error}",
                    source.file_path.display()
                ))
            })?;

            entries.push(BackupEntry {
                path: source.logical_path.clone(),
                size_bytes: bytes.len() as u64,
                modified_at: modified_at(&metadata),
                bytes_base64: general_purpose::STANDARD.encode(bytes),
            });

            emit_progress(
                &events,
                "create",
                "pack",
                index + 1,
                total,
                format!("Packed {}", source.logical_path),
            );
        }

        check_backup_cancelled()?;
        let manifest = build_manifest(&entries);
        let backup = PortableBackup { manifest, entries };
        if let Some(parent) = backup_path.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent).map_err(|error| {
                DesktopError::Internal(format!(
                    "Failed to create backup destination {}: {error}",
                    parent.display()
                ))
            })?;
        }

        let content = serde_json::to_vec_pretty(&backup).map_err(|error| {
            DesktopError::Internal(format!("Failed to serialize backup: {error}"))
        })?;
        check_backup_cancelled()?;
        fs::write(&backup_path, content).map_err(|error| {
            DesktopError::Internal(format!(
                "Failed to write backup {}: {error}",
                backup_path.display()
            ))
        })?;

        emit_progress(
            &events,
            "create",
            "done",
            total,
            total,
            format!("Backup written to {}", backup_path.display()),
        );

        Ok(preview_from_backup(&backup, &roots))
    })
    .await
    .map_err(|error| DesktopError::Internal(format!("Backup task failed: {error}")))?
}

pub async fn backup_inspect(options: BackupInspectOptions) -> Result<BackupPreview, DesktopError> {
    let roots = BackupRoots::current()?;
    backup_inspect_with_roots(roots, options).await
}

async fn backup_inspect_with_roots(
    roots: BackupRoots,
    options: BackupInspectOptions,
) -> Result<BackupPreview, DesktopError> {
    let path = PathBuf::from(options.path.trim());
    if path.as_os_str().is_empty() {
        return Err(DesktopError::BadRequest(
            "Backup path cannot be empty".to_string(),
        ));
    }

    tokio::task::spawn_blocking(move || {
        let backup = read_backup_file(&path)?;
        Ok(preview_from_backup(&backup, &roots))
    })
    .await
    .map_err(|error| DesktopError::Internal(format!("Backup inspect task failed: {error}")))?
}

struct DecodedRestoreItem {
    logical_path: String,
    target: PathBuf,
    bytes: Vec<u8>,
}

fn decode_and_validate_restore_entries(
    backup: &PortableBackup,
    roots: &BackupRoots,
) -> Result<Vec<DecodedRestoreItem>, DesktopError> {
    let mut items = Vec::with_capacity(backup.entries.len());
    for entry in &backup.entries {
        check_backup_cancelled()?;
        let target = resolve_restore_target_with_roots(roots, &entry.path)?;
        if target.parent().is_none() {
            return Err(DesktopError::BadRequest(format!(
                "Invalid restore target for {}",
                entry.path
            )));
        }
        let bytes = general_purpose::STANDARD
            .decode(&entry.bytes_base64)
            .map_err(|error| {
                DesktopError::BadRequest(format!(
                    "Invalid backup payload for {}: {error}",
                    entry.path
                ))
            })?;
        if entry.path == "asset/db.sqlite"
            && (bytes.len() < SQLITE_HEADER.len() || &bytes[..SQLITE_HEADER.len()] != SQLITE_HEADER)
        {
            return Err(DesktopError::BadRequest(
                "Backup database payload is not a valid SQLite 3 database".to_string(),
            ));
        }
        items.push(DecodedRestoreItem {
            logical_path: entry.path.clone(),
            target,
            bytes,
        });
    }
    Ok(items)
}

/// Tracks staged restore temp files so an early return in phase 1 (or a failure
/// partway through phase-2 commit) cleans up any remaining temp files.
#[derive(Default)]
struct StagedRestore {
    temps: Vec<PathBuf>,
    pairs: Vec<(String, PathBuf, PathBuf)>,
    committed: bool,
}

impl Drop for StagedRestore {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        for temp in &self.temps {
            let _ = fs::remove_file(temp);
        }
    }
}

struct RollbackRecord {
    target: PathBuf,
    rollback_path: Option<PathBuf>,
}

fn rollback_committed(committed: Vec<RollbackRecord>) {
    for record in committed.into_iter().rev() {
        match record.rollback_path {
            Some(rollback_path) => {
                if record.target.exists() {
                    let _ = fs::remove_file(&record.target);
                }
                if let Err(error) = fs::rename(&rollback_path, &record.target) {
                    tracing::error!(
                        target = %record.target.display(),
                        rollback = %rollback_path.display(),
                        %error,
                        "Failed to roll back restored file after commit error"
                    );
                }
            }
            None => {
                let _ = fs::remove_file(&record.target);
            }
        }
    }
}

fn rollback_temp_path(target: &Path, tag: &str) -> Result<PathBuf, DesktopError> {
    let parent = target.parent().ok_or_else(|| {
        DesktopError::BadRequest(format!("Invalid restore target {}", target.display()))
    })?;
    let file_name = target
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "target".to_string());
    Ok(parent.join(format!(".{file_name}.dimo-rollback.{tag}.tmp")))
}

/// Commits staged `(logical_path, temp_file, target_file)` entries atomically with
/// full rollback if any file fails to commit, and removes any listed stale sidecar
/// files (such as `db.sqlite-wal` / `db.sqlite-shm`) inside the same rollback scope.
fn commit_staged_with_rollback(
    mut staged: StagedRestore,
    stale_sidecars: &[PathBuf],
    on_commit: &mut dyn FnMut(usize, &str),
) -> Result<(), DesktopError> {
    // Commit SQLite database files first so any lock/sharing error fails immediately
    // before touching config files, while still guaranteeing rollback of all entries.
    staged
        .pairs
        .sort_by_key(|(logical, _, _)| !entry_is_sqlite_db(logical));

    let run_id = Uuid::new_v4();
    let mut committed: Vec<RollbackRecord> =
        Vec::with_capacity(staged.pairs.len() + stale_sidecars.len());

    // Move aside stale WAL/SHM sidecars under rollback protection before replacing db.sqlite.
    for (idx, sidecar) in stale_sidecars.iter().enumerate() {
        if !sidecar.exists() {
            continue;
        }
        let rollback_path = rollback_temp_path(sidecar, &format!("{run_id}.sidecar.{idx}"))?;
        if let Err(error) = fs::rename(sidecar, &rollback_path) {
            rollback_committed(committed);
            return Err(DesktopError::Internal(format!(
                "Failed to clear stale SQLite sidecar {}: {error}",
                sidecar.display()
            )));
        }
        committed.push(RollbackRecord {
            target: sidecar.clone(),
            rollback_path: Some(rollback_path),
        });
    }

    for (index, (logical_path, temp, target)) in staged.pairs.iter().enumerate() {
        if target.is_dir() {
            rollback_committed(committed);
            return Err(DesktopError::Internal(format!(
                "Failed to commit restore to {}: target is a directory",
                target.display()
            )));
        }
        let rollback_path = if target.exists() {
            let backup_path = rollback_temp_path(target, &format!("{run_id}.{index}"))?;
            if let Err(error) = fs::rename(target, &backup_path) {
                rollback_committed(committed);
                return Err(DesktopError::Internal(format!(
                    "Failed to prepare rollback backup for {}: {error}",
                    target.display()
                )));
            }
            Some(backup_path)
        } else {
            None
        };

        if let Err(error) = fs::rename(temp, target) {
            // Restore the current target's rollback backup first if we moved it aside,
            // then roll back all previously committed targets.
            if let Some(backup_path) = rollback_path {
                let _ = fs::rename(&backup_path, target);
            }
            rollback_committed(committed);
            return Err(DesktopError::Internal(format!(
                "Failed to commit restore to {}: {error}",
                target.display()
            )));
        }

        committed.push(RollbackRecord {
            target: target.clone(),
            rollback_path,
        });
        on_commit(index, logical_path);
    }

    staged.committed = true;

    // All targets committed cleanly; remove rollback backups.
    for record in committed {
        if let Some(rollback_path) = record.rollback_path {
            let _ = fs::remove_file(rollback_path);
        }
    }

    Ok(())
}

fn stale_sqlite_sidecars_for_restore(
    asset_dir: &Path,
    logical_paths: impl IntoIterator<Item = String>,
) -> Vec<PathBuf> {
    let mut restores_db = false;
    let mut has_wal = false;
    let mut has_shm = false;
    for path in logical_paths {
        match path.as_str() {
            "asset/db.sqlite" => restores_db = true,
            "asset/db.sqlite-wal" => has_wal = true,
            "asset/db.sqlite-shm" => has_shm = true,
            _ => {}
        }
    }
    if !restores_db {
        return Vec::new();
    }
    let mut stale = Vec::new();
    if !has_wal {
        stale.push(asset_dir.join("db.sqlite-wal"));
    }
    if !has_shm {
        stale.push(asset_dir.join("db.sqlite-shm"));
    }
    stale
}

fn stage_pending_restore(
    asset_dir: &Path,
    items: &[DecodedRestoreItem],
    events: &crate::HostEventBus,
) -> Result<(), DesktopError> {
    let pending_root = asset_dir.join(PENDING_RESTORE_DIR);
    fs::create_dir_all(&pending_root).map_err(|error| {
        DesktopError::Internal(format!(
            "Failed to create pending restore directory {}: {error}",
            pending_root.display()
        ))
    })?;

    let stage_dir_name = format!("stage-{}", Uuid::new_v4());
    let stage_dir = pending_root.join(&stage_dir_name);
    fs::create_dir_all(&stage_dir).map_err(|error| {
        DesktopError::Internal(format!(
            "Failed to create pending restore stage {}: {error}",
            stage_dir.display()
        ))
    })?;
    let mut stage_guard = TempDirGuard::new(stage_dir.clone());

    let total = items.len();
    let mut pending_entries = Vec::with_capacity(total);
    for (index, item) in items.iter().enumerate() {
        check_backup_cancelled()?;
        let staged_file = format!("entry-{index}.bin");
        let staged_path = stage_dir.join(&staged_file);
        fs::write(&staged_path, &item.bytes).map_err(|error| {
            DesktopError::Internal(format!(
                "Failed to write staged restore entry {}: {error}",
                staged_path.display()
            ))
        })?;
        pending_entries.push(PendingRestoreEntry {
            logical_path: item.logical_path.clone(),
            target_path: item.target.clone(),
            staged_file,
        });
        emit_progress(
            events,
            "restore",
            "stage",
            index + 1,
            total,
            format!("Staged {} for restart restore", item.logical_path),
        );
    }

    check_backup_cancelled()?;
    let manifest = PendingRestoreManifest {
        version: PENDING_RESTORE_VERSION,
        created_at: Utc::now().to_rfc3339(),
        stage_dir_name: stage_dir_name.clone(),
        entries: pending_entries,
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| {
        DesktopError::Internal(format!(
            "Failed to serialize pending restore manifest: {error}"
        ))
    })?;

    let manifest_tmp =
        pending_root.join(format!("{PENDING_RESTORE_MANIFEST}.{}.tmp", Uuid::new_v4()));
    let mut tmp_guard = TempFileGuard::new(manifest_tmp.clone());
    fs::write(&manifest_tmp, manifest_bytes).map_err(|error| {
        DesktopError::Internal(format!(
            "Failed to write pending restore manifest {}: {error}",
            manifest_tmp.display()
        ))
    })?;
    let manifest_path = pending_root.join(PENDING_RESTORE_MANIFEST);
    fs::rename(&manifest_tmp, &manifest_path).map_err(|error| {
        DesktopError::Internal(format!(
            "Failed to activate pending restore manifest {}: {error}",
            manifest_path.display()
        ))
    })?;
    tmp_guard.keep = true;
    stage_guard.commit();

    // Best-effort cleanup of superseded stage-* directories.
    if let Ok(entries) = fs::read_dir(&pending_root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with("stage-") && name_str != stage_dir_name {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }

    Ok(())
}

/// Applies any pending backup restore staged under `<data_dir>/.pending-restore`.
/// Must be called ONLY when no `SqlitePool` holds `db.sqlite` open (e.g., before
/// `LocalDeployment::new_at` on startup, or after `pool.close()` during shutdown).
pub fn apply_pending_backup_restore(data_dir: &Path) -> Result<usize, DesktopError> {
    let pending_root = data_dir.join(PENDING_RESTORE_DIR);
    let manifest_path = pending_root.join(PENDING_RESTORE_MANIFEST);
    if !manifest_path.is_file() {
        return Ok(0);
    }

    let raw = fs::read(&manifest_path).map_err(|error| {
        DesktopError::Internal(format!(
            "Failed to read pending restore manifest {}: {error}",
            manifest_path.display()
        ))
    })?;
    let manifest: PendingRestoreManifest = serde_json::from_slice(&raw).map_err(|error| {
        DesktopError::BadRequest(format!(
            "Failed to parse pending restore manifest {}: {error}",
            manifest_path.display()
        ))
    })?;
    if manifest.version != PENDING_RESTORE_VERSION {
        return Err(DesktopError::BadRequest(format!(
            "Unsupported pending restore version: {}",
            manifest.version
        )));
    }
    if manifest.stage_dir_name.contains('/')
        || manifest.stage_dir_name.contains('\\')
        || manifest.stage_dir_name.contains("..")
    {
        return Err(DesktopError::BadRequest(
            "Unsafe pending restore stage directory name".to_string(),
        ));
    }

    let stage_dir = pending_root.join(&manifest.stage_dir_name);
    let mut staged = StagedRestore::default();
    let run_id = Uuid::new_v4();

    for (index, entry) in manifest.entries.iter().enumerate() {
        if entry.staged_file.contains('/')
            || entry.staged_file.contains('\\')
            || entry.staged_file.contains("..")
        {
            return Err(DesktopError::BadRequest(format!(
                "Unsafe staged file name: {}",
                entry.staged_file
            )));
        }
        let source = stage_dir.join(&entry.staged_file);
        let bytes = fs::read(&source).map_err(|error| {
            DesktopError::Internal(format!(
                "Failed to read staged restore payload {}: {error}",
                source.display()
            ))
        })?;
        if entry.logical_path == "asset/db.sqlite"
            && (bytes.len() < SQLITE_HEADER.len() || &bytes[..SQLITE_HEADER.len()] != SQLITE_HEADER)
        {
            return Err(DesktopError::BadRequest(
                "Staged database payload is not a valid SQLite 3 database".to_string(),
            ));
        }

        let parent = entry.target_path.parent().ok_or_else(|| {
            DesktopError::BadRequest(format!("Invalid restore target for {}", entry.logical_path))
        })?;
        fs::create_dir_all(parent).map_err(|error| {
            DesktopError::Internal(format!(
                "Failed to create restore directory {}: {error}",
                parent.display()
            ))
        })?;
        let file_name = entry
            .target_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("entry{index}"));
        let temp = parent.join(format!(".{file_name}.dimo-restore.{run_id}.{index}.tmp"));
        fs::write(&temp, bytes).map_err(|error| {
            DesktopError::Internal(format!(
                "Failed to stage pending restore file {}: {error}",
                temp.display()
            ))
        })?;
        staged.temps.push(temp.clone());
        staged
            .pairs
            .push((entry.logical_path.clone(), temp, entry.target_path.clone()));
    }

    let stale_sidecars = stale_sqlite_sidecars_for_restore(
        data_dir,
        manifest
            .entries
            .iter()
            .map(|entry| entry.logical_path.clone()),
    );
    let restored_count = manifest.entries.len();

    commit_staged_with_rollback(staged, &stale_sidecars, &mut |_idx, _logical| {})?;

    // Cleanup pending restore marker & staged files once committed.
    let _ = fs::remove_file(&manifest_path);
    let _ = fs::remove_dir_all(&stage_dir);
    let _ = fs::remove_dir(&pending_root);

    tracing::info!(
        data_dir = %data_dir.display(),
        restored_entries = restored_count,
        "Applied pending backup restore"
    );
    Ok(restored_count)
}

pub async fn apply_pending_backup_restore_async(data_dir: PathBuf) -> Result<usize, DesktopError> {
    tokio::task::spawn_blocking(move || apply_pending_backup_restore(&data_dir))
        .await
        .map_err(|error| DesktopError::Internal(format!("Pending restore task failed: {error}")))?
}

pub async fn backup_restore_stage(
    events: &Arc<crate::HostEventBus>,
    pool: Option<&SqlitePool>,
    payload: BackupRestoreStagePayload,
) -> Result<BackupRestoreResult, DesktopError> {
    let roots = BackupRoots::current()?;
    backup_restore_stage_with_roots(Arc::clone(events), pool.is_some(), roots, payload).await
}

async fn backup_restore_stage_with_roots(
    events: Arc<crate::HostEventBus>,
    db_pool_active: bool,
    roots: BackupRoots,
    payload: BackupRestoreStagePayload,
) -> Result<BackupRestoreResult, DesktopError> {
    begin_backup_operation();
    if !payload.confirmed {
        return Err(DesktopError::BadRequest(
            "Restore must be confirmed after backup inspection".to_string(),
        ));
    }

    let path = PathBuf::from(payload.path.trim());
    if path.as_os_str().is_empty() {
        return Err(DesktopError::BadRequest(
            "Backup path cannot be empty".to_string(),
        ));
    }

    tokio::task::spawn_blocking(move || {
        let backup = read_backup_file(&path)?;
        check_backup_cancelled()?;
        let preview = preview_from_backup(&backup, &roots);
        let items = decode_and_validate_restore_entries(&backup, &roots)?;
        let total = items.len();
        let restores_sqlite = items
            .iter()
            .any(|item| entry_is_sqlite_db(&item.logical_path));

        // When SQLite is actively open (live server), stage the entire restore set
        // atomically under `.pending-restore/` so DB and config files are committed
        // together once the pool closes (preventing Windows ERROR_SHARING_VIOLATION
        // / os error 32, stale WAL corruption, and partial config/DB drift).
        if db_pool_active && restores_sqlite {
            stage_pending_restore(&roots.asset_dir, &items, &events)?;
            emit_progress(
                &events,
                "restore",
                "done",
                total,
                total,
                "Restore staged; restart the app to apply",
            );
            return Ok(BackupRestoreResult {
                preview,
                restored_entries: total,
                requires_reload: true,
            });
        }

        // Direct two-phase restore with rollback when DB is not open (or backup has no DB).
        let mut staged = StagedRestore::default();
        let run_id = Uuid::new_v4();
        for (index, item) in items.iter().enumerate() {
            check_backup_cancelled()?;
            let parent = item.target.parent().ok_or_else(|| {
                DesktopError::BadRequest(format!(
                    "Invalid restore target for {}",
                    item.logical_path
                ))
            })?;
            fs::create_dir_all(parent).map_err(|error| {
                DesktopError::Internal(format!(
                    "Failed to create restore directory {}: {error}",
                    parent.display()
                ))
            })?;

            let file_name = item
                .target
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| format!("entry{index}"));
            let temp = parent.join(format!(".{file_name}.dimo-restore.{run_id}.{index}.tmp"));
            fs::write(&temp, &item.bytes).map_err(|error| {
                DesktopError::Internal(format!(
                    "Failed to stage restore for {} at {}: {error}",
                    item.logical_path,
                    temp.display()
                ))
            })?;
            staged.temps.push(temp.clone());
            staged
                .pairs
                .push((item.logical_path.clone(), temp, item.target.clone()));

            emit_progress(
                &events,
                "restore",
                "stage",
                index + 1,
                total,
                format!("Staged {}", item.logical_path),
            );
        }

        check_backup_cancelled()?;
        let stale_sidecars = stale_sqlite_sidecars_for_restore(
            &roots.asset_dir,
            items.iter().map(|item| item.logical_path.clone()),
        );
        commit_staged_with_rollback(staged, &stale_sidecars, &mut |index, logical_path| {
            emit_progress(
                &events,
                "restore",
                "commit",
                index + 1,
                total,
                format!("Restored {logical_path}"),
            );
        })?;

        emit_progress(
            &events,
            "restore",
            "done",
            total,
            total,
            "Restore completed; restart is recommended",
        );

        Ok(BackupRestoreResult {
            preview,
            restored_entries: total,
            requires_reload: true,
        })
    })
    .await
    .map_err(|error| DesktopError::Internal(format!("Backup restore task failed: {error}")))?
}

pub async fn backup_cancel(_op_id: Option<String>) -> Result<(), DesktopError> {
    BACKUP_CANCELLED.store(true, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
#[path = "backup_tests.rs"]
mod tests;
