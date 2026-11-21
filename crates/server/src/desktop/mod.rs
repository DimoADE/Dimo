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
pub mod web_service;

use std::sync::Arc;

use local_deployment::LocalDeployment;
use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::Notify;

pub use self::error::DesktopError;
use crate::auth::TokenDigest;

pub const DESKTOP_APP_ORIGIN: &str = "dimo-app://localhost";
pub const DESKTOP_ASSET_ORIGIN: &str = "dimo-asset://localhost";

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

/// Terminate stray companion MCP / helper processes on desktop shutdown (Windows).
pub fn kill_companion_processes_on_exit() {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args([
                "/F",
                "/IM",
                "dimo-mcp.exe",
                "/IM",
                "dimo-workflow-mcp.exe",
                "/IM",
                "dimo-computer-helper.exe",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}
