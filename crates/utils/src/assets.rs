use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use directories::ProjectDirs;
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
const PROJECT_ROOT: &str = env!("CARGO_MANIFEST_DIR");

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BootstrapConfig {
    #[serde(default)]
    pub custom_data_dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataDirSettings {
    pub current_data_dir: PathBuf,
    pub default_data_dir: PathBuf,
    pub is_custom: bool,
}

/// Lightweight bootstrap configuration file path (`bootstrap.json`).
///
/// Stored in the OS config directory (`%APPDATA%\dimo\dimo\config\bootstrap.json` on Windows)
/// so the Host can locate a user-configured custom data directory before opening `db.sqlite`.
pub fn bootstrap_config_path() -> PathBuf {
    if let Some(explicit) =
        std::env::var_os("DIMO_BOOTSTRAP_CONFIG_PATH").filter(|value| !value.is_empty())
    {
        return PathBuf::from(explicit);
    }
    ProjectDirs::from("app", "dimo", "dimo")
        .map(|dirs| dirs.config_dir().join("bootstrap.json"))
        .or_else(|| dirs::home_dir().map(|home| home.join(".dimo").join("bootstrap.json")))
        .unwrap_or_else(|| PathBuf::from(".dimo-bootstrap.json"))
}

pub fn load_bootstrap_config_from(path: &Path) -> BootstrapConfig {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<BootstrapConfig>(&raw).ok())
        .unwrap_or_default()
}

pub fn save_bootstrap_config_to(path: &Path, config: &BootstrapConfig) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let encoded = serde_json::to_vec_pretty(config).map_err(std::io::Error::other)?;
    std::fs::write(path, encoded)
}

pub fn read_custom_data_dir_from(bootstrap_path: &Path) -> Option<PathBuf> {
    let config = load_bootstrap_config_from(bootstrap_path);
    let raw = config.custom_data_dir?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() || is_inside_macos_app_bundle(&path) {
        return None;
    }
    Some(crate::path::normalize_windows_extended_path_prefix(path))
}

pub fn read_custom_data_dir() -> Option<PathBuf> {
    let current = bootstrap_config_path();
    if let Some(dir) = read_custom_data_dir_from(&current) {
        return Some(dir);
    }
    let previous = pre_rename_bootstrap_config_path();
    (previous != current)
        .then(|| read_custom_data_dir_from(&previous))
        .flatten()
}

/// Stable data directory for release builds. It lives outside the install
/// tree, so replacing the app bundle cannot delete sessions.
///
/// Windows: `%APPDATA%\dimo\dimo\data`. macOS:
/// `~/Library/Application Support/app.dimo.dimo`. Linux: `$XDG_DATA_HOME/dimo`
/// or `~/.local/share/dimo`.
pub fn legacy_roaming_data_dir() -> PathBuf {
    ProjectDirs::from("app", "dimo", "dimo")
        .map(|dirs| dirs.data_dir().to_path_buf())
        .or_else(|| dirs::data_dir().map(|path| path.join("dimo")))
        .unwrap_or_else(|| PathBuf::from(".dimo-data"))
}

/// Where the previous brand (`VibeX`) kept its data on this machine.
///
/// Users upgrading from VibeX keep their conversations, worktrees and settings
/// only if this directory is adopted, so it is resolved for read purposes and
/// never written through [`asset_dir`](crate::assets::asset_dir).
pub fn pre_rename_data_dir() -> PathBuf {
    ProjectDirs::from("app", "vibex", "vibex")
        .map(|dirs| dirs.data_dir().to_path_buf())
        .or_else(|| dirs::data_dir().map(|path| path.join("vibex")))
        .unwrap_or_else(|| PathBuf::from(".vibex-data"))
}

/// Where the previous brand (`VibeX`) kept `bootstrap.json`.
pub fn pre_rename_bootstrap_config_path() -> PathBuf {
    ProjectDirs::from("app", "vibex", "vibex")
        .map(|dirs| dirs.config_dir().join("bootstrap.json"))
        .or_else(|| dirs::home_dir().map(|home| home.join(".vibex").join("bootstrap.json")))
        .unwrap_or_else(|| PathBuf::from(".vibex-bootstrap.json"))
}

fn is_cargo_build_or_test_dir(dir: &Path) -> bool {
    let components: Vec<String> = dir
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_ascii_lowercase())
        .collect();
    if components.last().is_some_and(|last| last == "deps") {
        return true;
    }
    for window in components.windows(2) {
        if window[0] == "target" && (window[1] == "debug" || window[1] == "release") {
            return true;
        }
    }
    false
}

pub fn probe_writable_dir(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(format!(".dimo-write-probe-{}", std::process::id()));
    match std::fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

pub fn install_data_dir_for_exe_dir(install_dir: &Path) -> Option<PathBuf> {
    if !install_dir.exists()
        || is_cargo_build_or_test_dir(install_dir)
        || is_inside_macos_app_bundle(install_dir)
    {
        return None;
    }
    let candidate = install_dir.join("data");
    probe_writable_dir(&candidate)
        .then(|| crate::path::normalize_windows_extended_path_prefix(candidate))
}

/// `<install_dir>/data` when writable; `None` for read-only installs
/// (e.g. `C:\Program Files`) and Cargo build trees.
///
/// This is not the live data directory. Probing creates `<install_dir>/data`,
/// and a later app update deletes that directory on macOS. [`release_default_data_dir`]
/// must not call this.
pub fn install_data_dir() -> Option<PathBuf> {
    packaged_install_dir().and_then(|install_dir| install_data_dir_for_exe_dir(&install_dir))
}

/// Resolves the canonical install root for a packaged executable, stripping
/// Electron's `resources/bin/` (and macOS `Contents/Resources/bin/` -> `Contents/MacOS`)
/// sidecar layout while excluding Cargo `target/{debug,release}` and `deps` test binaries.
pub fn packaged_install_dir_for(exe: &Path) -> Option<PathBuf> {
    let exe_dir = exe.parent()?;
    if is_cargo_build_or_test_dir(exe_dir) {
        return None;
    }
    let dir_is_bin = exe_dir
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("bin"));
    let parent_is_resources = exe_dir
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("resources"));
    if dir_is_bin && parent_is_resources {
        if let Some(bundle) = macos_app_bundle_containing(exe) {
            return Some(bundle.join("Contents").join("MacOS"));
        }
        if let Some(install_root) = exe_dir.parent().and_then(Path::parent)
            && !install_root.as_os_str().is_empty()
        {
            return Some(install_root.to_path_buf());
        }
    }
    Some(exe_dir.to_path_buf())
}

/// Directories inside the packaged install tree that may hold legacy `data`
/// (or `data.superseded-*`) subdirectories for `exe`, ordered with the
/// canonical install root first.
pub fn packaged_install_scan_dirs_for(exe: &Path) -> Vec<PathBuf> {
    let Some(install_dir) = packaged_install_dir_for(exe) else {
        return Vec::new();
    };
    let mut dirs = Vec::new();
    push_unique_candidate(&mut dirs, install_dir);
    if let Some(exe_dir) = exe.parent()
        && !is_cargo_build_or_test_dir(exe_dir)
    {
        push_unique_candidate(&mut dirs, exe_dir.to_path_buf());
    }
    dirs
}

/// Install directory of a packaged app, excluding Cargo `target/{debug,release}`
/// and `deps` test binaries.
pub fn packaged_install_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    packaged_install_dir_for(&exe)
}

/// Live release data directory. `install_data` is ignored on purpose: 0.5.0
/// stored the only database under the install tree, and replacing `Dimo.app`
/// deleted it. The stable roaming/XDG directory is the only default.
pub fn resolve_release_data_dir(_install_data: Option<&Path>, stable: PathBuf) -> PathBuf {
    stable
}

/// Release default: [`legacy_roaming_data_dir`]. Does not create
/// `<install_dir>/data`.
pub fn release_default_data_dir() -> PathBuf {
    resolve_release_data_dir(None, legacy_roaming_data_dir())
}

/// `.app` bundle that contains `exe`, when `exe` is `*.app/Contents/MacOS/*`.
pub fn macos_app_bundle_containing(exe: &Path) -> Option<PathBuf> {
    let mut cursor = exe.parent()?;
    loop {
        if cursor.extension().is_some_and(|ext| ext == "app") {
            return Some(cursor.to_path_buf());
        }
        cursor = cursor.parent()?;
    }
}

fn is_app_bundle_component(component: std::path::Component<'_>) -> bool {
    matches!(component, std::path::Component::Normal(name)
        if Path::new(name)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("app")))
}

/// Whether `path` points to or inside a macOS `.app` bundle. Writing runtime
/// data there breaks the sealed Apple code signature (`a sealed resource is
/// missing or invalid`) and causes Gatekeeper to reject the app as damaged.
pub fn is_inside_macos_app_bundle(path: &Path) -> bool {
    is_inside_macos_app_bundle_for_os(cfg!(target_os = "macos"), path)
}

fn is_inside_macos_app_bundle_for_os(is_macos: bool, path: &Path) -> bool {
    let components: Vec<_> = path.components().collect();
    if is_macos && components.iter().copied().any(is_app_bundle_component) {
        return true;
    }
    components.windows(2).any(|pair| {
        is_app_bundle_component(pair[0])
            && matches!(pair[1], std::path::Component::Normal(next) if next.eq_ignore_ascii_case("Contents"))
    })
}

/// Whether replacing the running app would delete `dir`.
///
/// Only a macOS in-app update replaces the whole `.app`. Windows NSIS and
/// Linux AppImage updates keep a sibling data directory. Cargo test binaries
/// are never treated as a bundle, even when `update_replaces_bundle` is set.
pub fn app_update_deletes_directory(
    update_replaces_bundle: bool,
    current_exe: &Path,
    dir: &Path,
) -> bool {
    if !update_replaces_bundle {
        return false;
    }
    let Some(exe_dir) = current_exe.parent() else {
        return false;
    };
    if is_cargo_build_or_test_dir(exe_dir) {
        return false;
    }
    macos_app_bundle_containing(current_exe).is_some_and(|bundle| dir.starts_with(bundle))
}

fn is_dimo_workspace_root(dir: &Path) -> bool {
    dir.join("Cargo.toml").is_file()
        && dir
            .join("crates")
            .join("utils")
            .join("Cargo.toml")
            .is_file()
}

fn workspace_root_from_ancestor(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|candidate| is_dimo_workspace_root(candidate))
        .map(Path::to_path_buf)
}

fn workspace_root_from_exe(exe: &Path) -> Option<PathBuf> {
    let mut cursor = exe.parent()?;
    while let Some(name) = cursor.file_name().and_then(|n| n.to_str()) {
        if name.eq_ignore_ascii_case("target") {
            let root = cursor.parent()?;
            if is_dimo_workspace_root(root) {
                return Some(root.to_path_buf());
            }
        }
        cursor = cursor.parent()?;
    }
    None
}

pub(crate) fn resolve_debug_dev_assets_dir(
    current_dir: Option<&Path>,
    current_exe: Option<&Path>,
    compile_time_manifest_dir: &Path,
) -> PathBuf {
    let root = current_dir
        .and_then(workspace_root_from_ancestor)
        .or_else(|| current_exe.and_then(workspace_root_from_exe))
        .unwrap_or_else(|| {
            compile_time_manifest_dir
                .parent()
                .and_then(Path::parent)
                .unwrap_or(compile_time_manifest_dir)
                .to_path_buf()
        });
    crate::path::normalize_windows_extended_path_prefix(root).join("dev_assets")
}

fn debug_dev_assets_dir() -> PathBuf {
    let cwd = std::env::current_dir().ok();
    let exe = std::env::current_exe().ok();
    resolve_debug_dev_assets_dir(cwd.as_deref(), exe.as_deref(), Path::new(PROJECT_ROOT))
}

/// A legacy data directory whose database must be moved into the release
/// default before anything opens a database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyDataDirAdoption {
    pub legacy_dir: PathBuf,
    pub target_dir: PathBuf,
}

const ADOPTED_LEGACY_MARKER_FILE: &str = ".adopted-legacy-source";

pub fn same_data_dir(a: &Path, b: &Path) -> bool {
    same_path_for_adoption(a, b)
}

fn same_path_for_adoption(a: &Path, b: &Path) -> bool {
    let norm_a = crate::path::normalize_windows_extended_path_prefix(
        std::fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf()),
    );
    let norm_b = crate::path::normalize_windows_extended_path_prefix(
        std::fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf()),
    );
    if cfg!(windows) {
        norm_a
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .eq_ignore_ascii_case(norm_b.to_string_lossy().trim_end_matches(['\\', '/']))
    } else {
        norm_a == norm_b
    }
}

fn push_unique_candidate(candidates: &mut Vec<PathBuf>, candidate: PathBuf) {
    let normalized = crate::path::normalize_windows_extended_path_prefix(candidate);
    if !candidates
        .iter()
        .any(|existing| same_path_for_adoption(existing, &normalized))
    {
        candidates.push(normalized);
    }
}

#[cfg(target_os = "windows")]
fn windows_vibex_registry_install_dirs() -> Vec<PathBuf> {
    use winreg::{
        RegKey,
        enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ},
    };

    let mut dirs = Vec::new();
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let root = RegKey::predef(hive);
        if let Ok(uninst) = root.open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall\VibeX",
            KEY_READ,
        ) && let Ok(raw) = uninst.get_value::<String, _>("InstallLocation")
        {
            let trimmed = raw.trim().trim_matches('"').trim();
            if !trimmed.is_empty() {
                dirs.push(PathBuf::from(trimmed));
            }
        }
        for subkey in [
            r"Software\vibex\VibeX",
            r"Software\VibeX\VibeX",
            r"Software\Dimo\VibeX",
            r"Software\DimoADE\VibeX",
        ] {
            if let Ok(key) = root.open_subkey_with_flags(subkey, KEY_READ)
                && let Ok(raw) = key.get_value::<String, _>("")
            {
                let trimmed = raw.trim().trim_matches('"').trim();
                if !trimmed.is_empty() {
                    dirs.push(PathBuf::from(trimmed));
                }
            }
        }
    }
    dirs
}

/// Discovers `<VibeX_install_dir>/data` (and legacy bundle dirs) where the
/// pre-rename `VibeX` desktop app stored its database and settings before
/// `Dimo` was installed into its own directory.
pub fn pre_rename_install_data_dir_candidates_for(
    current_exe: Option<&Path>,
    local_app_data: Option<&Path>,
    program_files: Option<&Path>,
    program_files_x86: Option<&Path>,
    home_dir: Option<&Path>,
    app_data_dir: Option<&Path>,
    registry_install_dirs: &[PathBuf],
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    for install_root in registry_install_dirs {
        push_unique_candidate(&mut candidates, install_root.join("data"));
    }

    if let Some(install_dir) = current_exe.and_then(packaged_install_dir_for) {
        if let Some(bundle) = current_exe.and_then(macos_app_bundle_containing) {
            // `Dimo.app/Contents/{MacOS,Resources/bin}` -> sibling `VibeX.app/Contents/MacOS/data`
            if let Some(apps_dir) = bundle.parent() {
                push_unique_candidate(
                    &mut candidates,
                    apps_dir
                        .join("VibeX.app")
                        .join("Contents")
                        .join("MacOS")
                        .join("data"),
                );
            }
        } else if cfg!(target_os = "macos") {
            if let Some(apps_dir) = install_dir
                .parent()
                .and_then(|contents| contents.parent())
                .and_then(|bundle| bundle.parent())
            {
                push_unique_candidate(
                    &mut candidates,
                    apps_dir
                        .join("VibeX.app")
                        .join("Contents")
                        .join("MacOS")
                        .join("data"),
                );
            }
        } else if let Some(parent) = install_dir.parent() {
            push_unique_candidate(&mut candidates, parent.join("VibeX").join("data"));
            if cfg!(target_os = "linux") {
                push_unique_candidate(&mut candidates, parent.join("vibex").join("data"));
            }
        }
    }

    if cfg!(target_os = "windows") {
        if let Some(local) = local_app_data {
            push_unique_candidate(&mut candidates, local.join("VibeX").join("data"));
            push_unique_candidate(
                &mut candidates,
                local.join("Programs").join("VibeX").join("data"),
            );
        }
        if let Some(pf) = program_files {
            push_unique_candidate(&mut candidates, pf.join("VibeX").join("data"));
        }
        if let Some(pf86) = program_files_x86 {
            push_unique_candidate(&mut candidates, pf86.join("VibeX").join("data"));
        }
    } else if cfg!(target_os = "macos") {
        if let Some(home) = home_dir {
            push_unique_candidate(
                &mut candidates,
                home.join("Applications")
                    .join("VibeX.app")
                    .join("Contents")
                    .join("MacOS")
                    .join("data"),
            );
        }
        push_unique_candidate(
            &mut candidates,
            PathBuf::from("/Applications/VibeX.app/Contents/MacOS/data"),
        );
    }

    if let Some(data_dir) = app_data_dir {
        push_unique_candidate(&mut candidates, data_dir.join("com.vibex.app"));
        push_unique_candidate(&mut candidates, data_dir.join("VibeX"));
    }

    candidates
}

/// `<Dimo install>/data` directories that may still hold the database written
/// by 0.5.0 and 0.5.1. Paths are joined only; nothing is created.
///
/// The running executable's canonical install `data` dir is first so an
/// activity-score tie prefers the copy that app was using.
pub fn dimo_install_data_dir_candidates_for(
    current_exe: Option<&Path>,
    local_app_data: Option<&Path>,
    program_files: Option<&Path>,
    program_files_x86: Option<&Path>,
    home_dir: Option<&Path>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(exe) = current_exe {
        for scan_dir in packaged_install_scan_dirs_for(exe) {
            push_unique_candidate(&mut candidates, scan_dir.join("data"));
        }
    }

    if cfg!(target_os = "windows") {
        if let Some(local) = local_app_data {
            push_unique_candidate(&mut candidates, local.join("Dimo").join("data"));
            push_unique_candidate(
                &mut candidates,
                local.join("Programs").join("Dimo").join("data"),
            );
        }
        if let Some(pf) = program_files {
            push_unique_candidate(&mut candidates, pf.join("Dimo").join("data"));
        }
        if let Some(pf86) = program_files_x86 {
            push_unique_candidate(&mut candidates, pf86.join("Dimo").join("data"));
        }
    } else if cfg!(target_os = "macos") {
        if let Some(home) = home_dir {
            push_unique_candidate(
                &mut candidates,
                home.join("Applications")
                    .join("Dimo.app")
                    .join("Contents")
                    .join("MacOS")
                    .join("data"),
            );
        }
        push_unique_candidate(
            &mut candidates,
            PathBuf::from("/Applications/Dimo.app/Contents/MacOS/data"),
        );
    } else if cfg!(target_os = "linux") {
        if let Some(install_dir) = current_exe.and_then(packaged_install_dir_for)
            && let Some(parent) = install_dir.parent()
        {
            push_unique_candidate(&mut candidates, parent.join("Dimo").join("data"));
        }
        push_unique_candidate(&mut candidates, PathBuf::from("/opt/Dimo/data"));
    }

    candidates
}

pub fn dimo_install_data_dir_candidates() -> Vec<PathBuf> {
    let current_exe = std::env::current_exe().ok();
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::data_local_dir);
    let program_files = std::env::var_os("ProgramFiles")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let program_files_x86 = std::env::var_os("ProgramFiles(x86)")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let home_dir = dirs::home_dir();
    dimo_install_data_dir_candidates_for(
        current_exe.as_deref(),
        local_app_data.as_deref(),
        program_files.as_deref(),
        program_files_x86.as_deref(),
        home_dir.as_deref(),
    )
}

/// Returns `true` when `path`'s final directory segment already carries a
/// migration backup suffix (`.superseded-` or `.preserved-`).
pub fn is_migration_backup_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.contains(".superseded-") || name.contains(".preserved-"))
}

fn is_chained_or_preserved_backup_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.contains(".preserved-") || name.matches(".superseded-").count() > 1
        })
}

/// Set-aside copies named `{dir}.superseded-*` that still contain `db.sqlite`.
/// Missing directories, already-superseded/preserved directories, and chained
/// backup copies are ignored. Nothing is created.
pub fn superseded_data_dirs_beside(dir: &Path) -> Vec<PathBuf> {
    if is_migration_backup_dir(dir) {
        return Vec::new();
    }
    let Some(parent) = dir.parent() else {
        return Vec::new();
    };
    if parent.as_os_str().is_empty() {
        return Vec::new();
    }
    let Some(file_name) = dir.file_name().and_then(|name| name.to_str()) else {
        return Vec::new();
    };
    if file_name.is_empty() {
        return Vec::new();
    }
    let prefix = format!("{file_name}.superseded-");
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || is_chained_or_preserved_backup_dir(&path) {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.starts_with(&prefix) && path.join("db.sqlite").is_file() {
            found.push(crate::path::normalize_windows_extended_path_prefix(path));
        }
    }
    found.sort();
    found
}

fn append_superseded_siblings(candidates: &mut Vec<PathBuf>) {
    let mut seeds = candidates.clone();
    seeds.push(release_default_data_dir());
    for seed in seeds {
        for sibling in superseded_data_dirs_beside(&seed) {
            push_unique_candidate(candidates, sibling);
        }
    }
}

pub fn pre_rename_install_data_dir_candidates() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    let registry_dirs = windows_vibex_registry_install_dirs();
    #[cfg(not(target_os = "windows"))]
    let registry_dirs: Vec<PathBuf> = Vec::new();

    let current_exe = std::env::current_exe().ok();
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::data_local_dir);
    let program_files = std::env::var_os("ProgramFiles")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let program_files_x86 = std::env::var_os("ProgramFiles(x86)")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let home_dir = dirs::home_dir();
    let app_data_dir = dirs::data_dir();

    pre_rename_install_data_dir_candidates_for(
        current_exe.as_deref(),
        local_app_data.as_deref(),
        program_files.as_deref(),
        program_files_x86.as_deref(),
        home_dir.as_deref(),
        app_data_dir.as_deref(),
        &registry_dirs,
    )
}

/// Ordered directories that may still hold a database that belongs in the
/// stable roaming/XDG directory. The stable directory itself is the target,
/// not a source. Nothing here is created.
pub fn legacy_data_dir_candidates() -> Vec<PathBuf> {
    let mut candidates = dimo_install_data_dir_candidates();
    for dir in pre_rename_install_data_dir_candidates() {
        push_unique_candidate(&mut candidates, dir);
    }
    push_unique_candidate(&mut candidates, pre_rename_data_dir());
    append_superseded_siblings(&mut candidates);
    let stable = release_default_data_dir();
    candidates.retain(|dir| !same_path_for_adoption(dir, &stable));
    candidates
}

pub fn read_adopted_legacy_sources(target_dir: &Path) -> Vec<PathBuf> {
    let marker = target_dir.join(ADOPTED_LEGACY_MARKER_FILE);
    let Ok(raw) = std::fs::read_to_string(marker) else {
        return Vec::new();
    };
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect()
}

pub fn record_adopted_legacy_source(target_dir: &Path, legacy_dir: &Path) -> std::io::Result<()> {
    let normalized = crate::path::normalize_windows_extended_path_prefix(
        std::fs::canonicalize(legacy_dir).unwrap_or_else(|_| legacy_dir.to_path_buf()),
    );
    let mut recorded = read_adopted_legacy_sources(target_dir);
    if recorded
        .iter()
        .any(|existing| same_path_for_adoption(existing, &normalized))
    {
        return Ok(());
    }
    recorded.push(normalized);
    std::fs::create_dir_all(target_dir)?;
    let content = recorded
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(target_dir.join(ADOPTED_LEGACY_MARKER_FILE), content)
}

fn is_already_adopted_legacy_source(target_dir: &Path, legacy_dir: &Path) -> bool {
    read_adopted_legacy_sources(target_dir)
        .into_iter()
        .any(|recorded| same_path_for_adoption(&recorded, legacy_dir))
}

/// Returns all legacy data directories holding a `db.sqlite` that are eligible
/// for adoption into the release default data directory.
pub fn pending_legacy_data_dir_adoptions() -> Vec<LegacyDataDirAdoption> {
    if cfg!(debug_assertions)
        || renamed_env_var("DIMO_DATA_DIR").is_some()
        || read_custom_data_dir().is_some()
    {
        return Vec::new();
    }
    let target_dir = release_default_data_dir();
    legacy_data_dir_candidates()
        .into_iter()
        .filter_map(|dir| legacy_data_dir_adoption(dir, target_dir.clone()))
        .collect()
}

pub fn legacy_data_dir_adoption(
    legacy_dir: PathBuf,
    target_dir: PathBuf,
) -> Option<LegacyDataDirAdoption> {
    (!same_path_for_adoption(&legacy_dir, &target_dir)
        && !is_chained_or_preserved_backup_dir(&legacy_dir)
        && !is_already_adopted_legacy_source(&target_dir, &legacy_dir)
        && legacy_dir.join("db.sqlite").is_file())
    .then_some(LegacyDataDirAdoption {
        legacy_dir,
        target_dir,
    })
}

pub fn default_data_dir_without_custom() -> PathBuf {
    if cfg!(debug_assertions) {
        debug_dev_assets_dir()
    } else {
        release_default_data_dir()
    }
}

/// Default Host data directory shared by Desktop release builds and `dimo-server`.
///
/// Desktop debug builds still use the repo `dev_assets/` tree via [`asset_dir`] unless
/// overridden by `bootstrap.json`.
pub fn default_host_data_dir() -> PathBuf {
    read_custom_data_dir()
        .filter(|custom| std::fs::create_dir_all(custom).is_ok())
        .unwrap_or_else(release_default_data_dir)
}

static DATA_DIR_FOR_THIS_RUN: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Opens `dir` for the rest of this process. Used when a legacy data directory
/// could not be moved yet (for example, an older Dimo still holds it open):
/// the user's existing data is opened in place and the move is retried on the
/// next launch. Must run before anything resolves the data directory.
pub fn use_data_dir_for_this_run(dir: PathBuf) {
    if is_inside_macos_app_bundle(&dir) {
        return;
    }
    let _ = DATA_DIR_FOR_THIS_RUN.set(dir);
}

pub fn asset_dir() -> PathBuf {
    if let Some(dir) = DATA_DIR_FOR_THIS_RUN.get() {
        return dir.clone();
    }
    let path = if cfg!(debug_assertions) {
        if let Some(custom) = read_custom_data_dir()
            && std::fs::create_dir_all(&custom).is_ok()
        {
            custom
        } else {
            debug_dev_assets_dir()
        }
    } else {
        default_host_data_dir()
    };

    // Ensure the directory exists
    if !path.exists() {
        std::fs::create_dir_all(&path).expect("Failed to create asset directory");
    }

    path
}

/// Canonical Host data directory for Desktop and `dimo-server`.
///
/// Reads a `DIMO_*` environment variable, falling back to the equivalent
/// `VIBEX_*` name so environments configured before the rename keep working.
pub fn renamed_env_var(name: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            let legacy = name
                .strip_prefix("DIMO_")
                .map(|rest| format!("VIBEX_{rest}"))?;
            std::env::var_os(legacy).filter(|value| !value.is_empty())
        })
}

/// `DIMO_DATA_DIR` wins. Otherwise this is [`asset_dir`] so debug Desktop
/// keeps using `dev_assets/` (unless customized) and release builds use the
/// stable roaming/XDG directory ([`legacy_roaming_data_dir`]) or the user's
/// custom data directory.
pub fn host_data_dir() -> PathBuf {
    if let Some(explicit) = renamed_env_var("DIMO_DATA_DIR") {
        let path = PathBuf::from(explicit);
        if !is_inside_macos_app_bundle(&path) {
            let _ = std::fs::create_dir_all(&path);
            return path;
        }
    }
    asset_dir()
}

pub fn get_data_dir_settings() -> DataDirSettings {
    let current_data_dir = crate::path::normalize_windows_extended_path_prefix(host_data_dir());
    let default_data_dir =
        crate::path::normalize_windows_extended_path_prefix(default_data_dir_without_custom());
    let is_custom = read_custom_data_dir().is_some() || current_data_dir != default_data_dir;
    DataDirSettings {
        current_data_dir,
        default_data_dir,
        is_custom,
    }
}

pub fn set_custom_data_dir(new_dir: Option<&Path>) -> std::io::Result<DataDirSettings> {
    if new_dir.is_some_and(is_inside_macos_app_bundle) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "data directory cannot be inside a macOS .app bundle",
        ));
    }
    let normalized = new_dir.map(|dir| {
        crate::path::normalize_windows_extended_path_prefix(dir)
            .to_string_lossy()
            .into_owned()
    });
    let config = BootstrapConfig {
        custom_data_dir: normalized,
    };
    save_bootstrap_config_to(&bootstrap_config_path(), &config)?;
    Ok(get_data_dir_settings())
}

pub fn config_path() -> PathBuf {
    host_data_dir().join("config.json")
}

/// Copy `settings.json` (or legacy `config.json`) from known VibeX / home
/// locations into `target_dir` if `target_dir/settings.json` does not exist yet.
pub fn adopt_legacy_settings_into(target_dir: &Path) {
    let dest = target_dir.join("settings.json");
    if dest.exists() {
        return;
    }
    adopt_legacy_file(
        dirs::home_dir().map(|home| home.join(".dimo").join("settings.json")),
        &dest,
    );
    adopt_legacy_file(
        dirs::home_dir().map(|home| home.join(".vibex").join("settings.json")),
        &dest,
    );
    for legacy_dir in pre_rename_install_data_dir_candidates()
        .into_iter()
        .chain(std::iter::once(pre_rename_data_dir()))
    {
        if same_path_for_adoption(&legacy_dir, target_dir) {
            continue;
        }
        adopt_legacy_file(Some(legacy_dir.join("settings.json")), &dest);
        if dest.exists() {
            return;
        }
    }
}

/// Settings live next to the Host database. `~/.dimo/settings.json` (or
/// pre-rename `~/.vibex/settings.json` and VibeX data directories in release
/// builds) is copied once if the Host file does not exist yet.
pub fn settings_path() -> PathBuf {
    let data_dir = host_data_dir();
    let dest = data_dir.join("settings.json");
    adopt_legacy_file(
        dirs::home_dir().map(|home| home.join(".dimo").join("settings.json")),
        &dest,
    );
    adopt_legacy_file(
        dirs::home_dir().map(|home| home.join(".vibex").join("settings.json")),
        &dest,
    );
    if !cfg!(debug_assertions) {
        adopt_legacy_settings_into(&data_dir);
    }
    dest
}

pub fn im_env_path() -> PathBuf {
    let data_dir = host_data_dir();
    let dest = data_dir.join(".env");
    adopt_legacy_file(
        dirs::home_dir().map(|home| home.join(".dimo").join(".env")),
        &dest,
    );
    adopt_legacy_file(
        dirs::home_dir().map(|home| home.join(".vibex").join(".env")),
        &dest,
    );
    if !cfg!(debug_assertions) {
        for legacy_dir in pre_rename_install_data_dir_candidates()
            .into_iter()
            .chain(std::iter::once(pre_rename_data_dir()))
        {
            if !same_path_for_adoption(&legacy_dir, &data_dir) {
                adopt_legacy_file(Some(legacy_dir.join(".env")), &dest);
            }
        }
    }
    dest
}

fn adopt_legacy_file(legacy: Option<PathBuf>, dest: &Path) {
    let Some(legacy) = legacy else {
        return;
    };
    if dest.exists() || !legacy.exists() {
        return;
    }
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::copy(legacy, dest);
}

/// Directories Tauri used for `app.path().app_data_dir()`. Host product files
/// now live in [`host_data_dir`].
///
/// The `com.vibex.app` / `VibeX` / `vibex` entries are the pre-rename
/// identifiers: files written before the Dimo rename are still picked up from
/// there when the new location does not have them yet.
pub fn tauri_app_data_dir_candidates() -> Vec<PathBuf> {
    let Some(data) = dirs::data_dir() else {
        return Vec::new();
    };
    let mut dirs = vec![
        data.join("com.dimo.app"),
        data.join("Dimo"),
        data.join("dimo"),
        data.join("com.vibex.app"),
        data.join("VibeX"),
        data.join("vibex"),
    ];
    dirs.dedup();
    dirs
}

pub fn tauri_app_data_file_candidates(relative: impl AsRef<Path>) -> Vec<PathBuf> {
    let relative = relative.as_ref();
    tauri_app_data_dir_candidates()
        .into_iter()
        .map(|root| root.join(relative))
        .collect()
}

/// Copy `relative` from the first existing Tauri app-data location when `dest`
/// is missing. Existing Host files win.
pub fn adopt_tauri_app_data_file(relative: impl AsRef<Path>, dest: &Path) {
    if dest.exists() {
        return;
    }
    for legacy in tauri_app_data_file_candidates(relative) {
        adopt_legacy_file(Some(legacy), dest);
        if dest.exists() {
            return;
        }
    }
}

/// Copy files that exist in `from` but not yet under `dest`.
pub fn copy_missing_files(from: &Path, dest: &Path) {
    let _ = std::fs::create_dir_all(dest);
    let Ok(entries) = std::fs::read_dir(from) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name() else {
            continue;
        };
        let target = dest.join(name);
        if !target.exists() {
            let _ = std::fs::copy(&path, &target);
        }
    }
}

/// Copy files that exist in a legacy Tauri directory but not yet under Host.
pub fn adopt_tauri_app_data_dir_files(relative: impl AsRef<Path>, dest: &Path) {
    for legacy_dir in tauri_app_data_file_candidates(relative) {
        copy_missing_files(&legacy_dir, dest);
    }
}

/// Directory for rotating application log files (P2-8). Created on first use.
pub fn logs_dir() -> PathBuf {
    let path = host_data_dir().join("logs");
    if !path.exists() {
        let _ = std::fs::create_dir_all(&path);
    }
    path
}

pub fn profiles_path() -> PathBuf {
    host_data_dir().join("profiles.json")
}

pub fn host_identity_path(data_root: &Path) -> PathBuf {
    data_root.join("host-identity.json")
}

/// Stable Host identity for the given data directory.
///
/// Desktop and `dimo-server` must persist this next to the database so pairing
/// and capabilities keep the same identity across restarts and Host family
/// processes.
pub fn load_or_create_host_id(data_root: &Path) -> std::io::Result<String> {
    let path = host_identity_path(data_root);
    if let Ok(text) = std::fs::read_to_string(&path)
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(&text)
        && let Some(host_id) = value
            .get("host_id")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    {
        return Ok(host_id.to_string());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let host_id = uuid::Uuid::new_v4().to_string();
    let encoded = serde_json::to_vec_pretty(&serde_json::json!({ "host_id": host_id }))
        .map_err(std::io::Error::other)?;
    let staging = path.with_extension("json.tmp");
    std::fs::write(&staging, encoded)?;
    restrict_owner_read_write(&staging);
    match std::fs::rename(&staging, &path) {
        Ok(()) => {}
        Err(_) if path.exists() => {
            let _ = std::fs::remove_file(&staging);
            if let Ok(text) = std::fs::read_to_string(&path)
                && let Ok(value) = serde_json::from_str::<serde_json::Value>(&text)
                && let Some(existing) = value
                    .get("host_id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            {
                return Ok(existing.to_string());
            }
        }
        Err(error) => {
            let _ = std::fs::remove_file(&staging);
            return Err(error);
        }
    }
    restrict_owner_read_write(&path);
    Ok(host_id)
}

fn restrict_owner_read_write(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

#[derive(RustEmbed)]
#[folder = "../../assets/sounds"]
pub struct SoundAssets;

/// Official plugin packages are no longer rust-embedded into the Host.
/// Older Hosts may still have copies under `builtin-plugins/`; keep those
/// visible so marketplace updates can replace them.
pub fn existing_official_plugin_roots(data_root: &Path) -> Vec<PathBuf> {
    existing_materialized_plugin_roots(data_root)
        .into_values()
        .collect()
}

fn existing_materialized_plugin_roots(data_root: &Path) -> BTreeMap<String, PathBuf> {
    let mut found = BTreeMap::new();
    let root = data_root.join("builtin-plugins");
    let Ok(entries) = std::fs::read_dir(root) else {
        return found;
    };
    for entry in entries.flatten() {
        let plugin_dir = entry.path();
        if !plugin_dir.is_dir() {
            continue;
        }
        let Some(plugin_id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
        let Ok(versions) = std::fs::read_dir(&plugin_dir) else {
            continue;
        };
        for version in versions.flatten() {
            let path = version.path();
            if version.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if !path.join(".dimo-plugin/plugin.json").is_file() {
                continue;
            }
            let modified = std::fs::metadata(&path)
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            if best
                .as_ref()
                .is_none_or(|(current, _)| modified >= *current)
            {
                best = Some((modified, path));
            }
        }
        if let Some((_, path)) = best {
            found.insert(plugin_id, path);
        }
    }
    found
}

#[cfg(test)]
#[path = "assets_tests.rs"]
mod tests;
