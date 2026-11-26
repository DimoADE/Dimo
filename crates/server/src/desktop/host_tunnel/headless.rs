//! Unified headless & multi-path reachability helpers for `host_tunnel`.
//!
//! Keeps `host_tunnel/mod.rs` concise while enabling standalone `dimo-server serve`
//! and desktop mode to share the same tunnel lifecycle, official/custom relay
//! reachability kinds, and `custom_public_origins` CORS publishing.

use std::sync::atomic::{AtomicU16, Ordering};

use chrono::Utc;
use remote_protocol::ReachabilityOrigin;

use super::{
    DesktopError, HostTunnelStore, HostTunnelStatus, RelaySyncMode, current_status,
    decide_relay_sync_mode, default_official_quick_origin, load_store, quick_tunnel_origin,
    quick_tunnel_snapshot, relay_snapshot, save_store, sync_relay, valid_account_lease,
};
use crate::host::connectivity::{browser_origin_of, custom_public};

static HEADLESS_LISTEN_PORT: AtomicU16 = AtomicU16::new(0);

pub fn set_headless_listen_port(port: Option<u16>) {
    HEADLESS_LISTEN_PORT.store(port.unwrap_or(0), Ordering::Relaxed);
}

pub(super) fn headless_listen_port() -> Option<u16> {
    let port = HEADLESS_LISTEN_PORT.load(Ordering::Relaxed);
    (port > 0).then_some(port)
}

pub(super) fn store_published_reachability(store: &HostTunnelStore) -> Vec<ReachabilityOrigin> {
    let mut origins: Vec<ReachabilityOrigin> = Vec::new();
    let mut push_unique = |item: ReachabilityOrigin| {
        if !origins.iter().any(|existing| existing.origin == item.origin) {
            origins.push(item);
        }
    };

    if store.enabled {
        if let Some(saved) = store
            .saved
            .iter()
            .find(|item| Some(item.id.as_str()) == store.active_id.as_deref())
        {
            if saved.kind == "relay" {
                push_unique(ReachabilityOrigin::custom_relay(saved.origin.clone()));
            } else {
                push_unique(ReachabilityOrigin::custom_public(saved.origin.clone()));
            }
        }
        if let Some(quick) = default_official_quick_origin(store) {
            push_unique(ReachabilityOrigin::official_relay(quick));
        }
    } else if let Some(quick) = quick_tunnel_origin() {
        push_unique(ReachabilityOrigin::official_relay(quick));
    }

    origins
}

pub(super) async fn publish_reachability_for_store(store: &HostTunnelStore) {
    let mut reachability = store_published_reachability(store);
    for custom in custom_public::custom_public_reachability().await {
        if !reachability
            .iter()
            .any(|existing| existing.origin == custom.origin)
        {
            reachability.push(custom);
        }
    }

    let mut browser_origins: Vec<String> = Vec::new();
    for item in &reachability {
        if let Some(origin) = browser_origin_of(&item.origin)
            && !browser_origins.contains(&origin)
        {
            browser_origins.push(origin);
        }
        if !browser_origins.contains(&item.origin) {
            browser_origins.push(item.origin.clone());
        }
    }

    crate::set_extra_browser_origins(browser_origins);
    crate::set_published_reachability(reachability);
}

pub async fn refresh_published_reachability() {
    let store = load_store().await.unwrap_or_default();
    publish_reachability_for_store(&store).await;
}

pub async fn account_lease_remaining_seconds() -> Option<i64> {
    let store = load_store().await.ok()?;
    let lease = store.account_lease.as_ref()?;
    if lease.expires_at <= 0 {
        return None;
    }
    Some(lease.expires_at - Utc::now().timestamp())
}

pub async fn current_relay_status() -> String {
    let Ok(store) = load_store().await else {
        return "idle".to_string();
    };
    match decide_relay_sync_mode(&store) {
        RelaySyncMode::OfficialQuickTunnel => quick_tunnel_snapshot().await.status,
        _ => relay_snapshot().await.status,
    }
}

pub async fn current_status_snapshot() -> HostTunnelStatus {
    current_status().await.unwrap_or(HostTunnelStatus {
        enabled: false,
        saved: Vec::new(),
        active_id: None,
        pending: None,
        relay_state: "idle".to_string(),
        last_error: None,
    })
}

pub async fn set_host_tunnel_enabled_headless(
    enabled: bool,
) -> Result<HostTunnelStatus, DesktopError> {
    let mut store = load_store().await?;
    store.enabled = enabled;
    if !enabled {
        store.pending = None;
    } else if store.active_id.is_none() && valid_account_lease(&store).is_some() {
        store.active_id = Some("auto-quick-tunnel".to_string());
    }
    save_store(&store).await?;
    sync_relay().await;
    current_status().await
}
