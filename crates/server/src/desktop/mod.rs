pub mod backup;
pub mod browser_bridge;
pub mod crash_reports;
pub mod error;
pub mod host_client;
pub mod host_tunnel;
pub mod host_windows;
pub mod launcher;
pub mod logging;
pub mod remote_desktop;
pub mod routes;
pub mod settings_watcher;
pub mod startup_hooks;
pub mod web_service;

use std::{
    collections::HashSet,
    sync::{Arc, Mutex, OnceLock},
};

use local_deployment::LocalDeployment;
use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::Notify;

pub use self::error::DesktopError;
use crate::auth::TokenDigest;

pub const DESKTOP_APP_ORIGIN: &str = "dimo-app://localhost";
pub const DESKTOP_ASSET_ORIGIN: &str = "dimo-asset://localhost";

static OWNED_COMPANION_PIDS: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();

fn owned_companion_pids() -> &'static Mutex<HashSet<u32>> {
    OWNED_COMPANION_PIDS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Register a companion child PID owned by this `dimo-server` instance so
/// shutdown can clean it up without touching sibling instances.
pub fn register_owned_companion_pid(pid: u32) {
    if pid == 0 || pid == std::process::id() {
        return;
    }
    if let Ok(mut guard) = owned_companion_pids().lock() {
        guard.insert(pid);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDevConnection {
    pub endpoint: String,
    pub token: String,
    pub protocol_version: &'static str,
}

impl PluginDevConnection {
    pub fn current() -> Self {
        Self {
            endpoint: plugins::artifact_origin().unwrap_or_default().to_string(),
            token: String::new(),
            protocol_version: "1.0",
        }
    }
}

/// Runtime state attached to `ServerState` only when `dimo-server` runs in `--desktop` mode.
#[derive(Clone)]
pub struct DesktopRuntimeState {
    pub(crate) token_digest: TokenDigest,
    pub shutdown: Arc<Notify>,
    pub deployment: Arc<LocalDeployment>,
    pub web_service: web_service::DesktopWebServiceContext,
    pub remote_desktop: Arc<remote_desktop::RemoteDesktopRegistry>,
    pub browser_bridge: Arc<browser_bridge::ElectronBrowserBridge>,
    pub events: Arc<crate::HostEventBus>,
}

/// Release SQLite page cache and process working set after heavy startup tasks finish.
pub async fn release_startup_working_set(pool: &SqlitePool) {
    let _ = sqlx::query("PRAGMA shrink_memory").execute(pool).await;
}

/// Terminate only companion child processes owned by this `dimo-server` instance.
///
/// Never uses global image-name termination (`taskkill /IM ...`), which would
/// kill companion processes belonging to other running Dimo instances or worktrees.
/// Any remaining owned child processes assigned via
/// `utils::process::assign_pid_to_guardian_job` are reaped automatically by the
/// OS Guardian Job when this process exits.
pub fn kill_companion_processes_on_exit() {
    let pids: Vec<u32> = owned_companion_pids()
        .lock()
        .map(|mut guard| guard.drain().collect())
        .unwrap_or_default();

    for pid in pids {
        utils::parent_watch::terminate_owned_pid(pid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_companion_pid_registry_ignores_self_and_zero_and_drains_on_exit() {
        register_owned_companion_pid(0);
        register_owned_companion_pid(std::process::id());
        let snapshot: Vec<u32> = owned_companion_pids()
            .lock()
            .unwrap()
            .iter()
            .copied()
            .collect();
        assert!(!snapshot.contains(&0));
        assert!(!snapshot.contains(&std::process::id()));
        kill_companion_processes_on_exit();
        assert!(owned_companion_pids().lock().unwrap().is_empty());
    }
}
