//! Per-key async workspace server pool with explicit business handle counting.
//!
//! Coordinates concurrent `get_or_spawn`, `release_and_shutdown_if_unused`, and
//! `invalidate_all` operations across `CodexAppServer` and `MuseServer` without
//! holding a global lock across subprocess spawn/handshake or relying on
//! `Arc::strong_count` (which races with transient background probes).

use std::{
    collections::HashMap,
    future::Future,
    hash::Hash,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use async_trait::async_trait;
use tokio::sync::Mutex as AsyncMutex;

use crate::engine::EngineError;

/// Pooled workspace-scoped native engine server (`CodexAppServer` / `MuseServer`).
#[async_trait]
pub(crate) trait PooledWorkspaceServer: Send + Sync + 'static {
    fn is_alive(&self) -> bool;
    fn acquire_handle(&self) -> usize;
    fn release_handle(&self) -> usize;
    fn active_handles(&self) -> usize;
    async fn shutdown_server(&self);
}

/// RAII business-handle lease for a pooled workspace server.
///
/// Guarantees that every acquired handle is released at most once — whether via
/// explicit `shutdown()` or implicit `Drop` — so double-shutdown or drop can
/// never underflow `active_handles`.
pub(crate) struct ServerHandleLease<S: PooledWorkspaceServer> {
    server: Arc<S>,
    released: AtomicBool,
}

impl<S: PooledWorkspaceServer> ServerHandleLease<S> {
    pub(crate) fn acquire(server: Arc<S>) -> Self {
        server.acquire_handle();
        Self {
            server,
            released: AtomicBool::new(false),
        }
    }

    pub(crate) fn server(&self) -> &Arc<S> {
        &self.server
    }

    /// Releases this lease at most once and returns the remaining handle count
    /// if this call performed the release.
    pub(crate) fn release_once(&self) -> Option<usize> {
        if self.released.swap(true, Ordering::AcqRel) {
            return None;
        }
        Some(self.server.release_handle())
    }
}

impl<S: PooledWorkspaceServer> Drop for ServerHandleLease<S> {
    fn drop(&mut self) {
        self.release_once();
    }
}

type Slot<S> = Arc<AsyncMutex<Option<Arc<S>>>>;

/// Per-key pooled server registry.
///
/// The outer `std::sync::Mutex` only protects short map lookups/insertions and
/// is never held across `.await`. Each cache key owns its own `tokio::sync::Mutex`
/// slot so spawning/handshaking workspace A never blocks workspace B, while
/// concurrent spawn and shutdown on the same key serialize cleanly.
pub(crate) struct WorkspaceServerPool<K, S> {
    entries: Mutex<HashMap<K, Slot<S>>>,
}

impl<K, S> WorkspaceServerPool<K, S>
where
    K: Eq + Hash + Clone + Send + Sync + 'static,
    S: PooledWorkspaceServer,
{
    pub(crate) fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn get_or_create_slot(&self, key: &K) -> Slot<S> {
        let mut map = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(
            map.entry(key.clone())
                .or_insert_with(|| Arc::new(AsyncMutex::new(None))),
        )
    }

    fn get_slot(&self, key: &K) -> Option<Slot<S>> {
        let map = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        map.get(key).cloned()
    }

    /// Removes `key` from `entries` when its slot is empty and no other task
    /// holds a clone of `slot` (strong count == 2: `entries` + caller's local).
    fn prune_if_empty_locked(&self, key: &K, slot: &Slot<S>, slot_guard: &Option<Arc<S>>) {
        if slot_guard.is_some() {
            return;
        }
        let mut map = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if map.get(key).is_some_and(|entry| Arc::ptr_eq(entry, slot))
            && Arc::strong_count(slot) == 2
        {
            map.remove(key);
        }
    }

    /// Returns a handle lease for an alive server under `key`, spawning one
    /// without blocking unrelated keys if absent or dead.
    pub(crate) async fn get_or_spawn<F, Fut>(
        &self,
        key: K,
        spawn: F,
    ) -> Result<ServerHandleLease<S>, EngineError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Arc<S>, EngineError>>,
    {
        let slot = self.get_or_create_slot(&key);
        let mut slot_guard = slot.lock().await;

        if let Some(existing) = slot_guard.as_ref()
            && existing.is_alive()
        {
            return Ok(ServerHandleLease::acquire(Arc::clone(existing)));
        }

        *slot_guard = None;
        match spawn().await {
            Ok(spawned) => {
                let lease = ServerHandleLease::acquire(Arc::clone(&spawned));
                *slot_guard = Some(spawned);
                Ok(lease)
            }
            Err(err) => {
                self.prune_if_empty_locked(&key, &slot, &slot_guard);
                Err(err)
            }
        }
    }

    /// Releases `lease` while serialized against concurrent spawns on `key`.
    /// Evicts from the pool and shuts down the server when `active_handles`
    /// reaches zero.
    pub(crate) async fn release_and_shutdown_if_unused(
        &self,
        key: &K,
        lease: &ServerHandleLease<S>,
    ) {
        let should_shutdown = if let Some(slot) = self.get_slot(key) {
            let mut slot_guard = slot.lock().await;
            let Some(remaining) = lease.release_once() else {
                return;
            };
            if remaining == 0 {
                if slot_guard
                    .as_ref()
                    .is_some_and(|cached| Arc::ptr_eq(cached, lease.server()))
                {
                    *slot_guard = None;
                    self.prune_if_empty_locked(key, &slot, &slot_guard);
                }
                true
            } else {
                false
            }
        } else {
            matches!(lease.release_once(), Some(0))
        };

        if should_shutdown {
            lease.server().shutdown_server().await;
        }
    }

    /// Evicts all pooled servers and shuts down any whose `active_handles == 0`.
    pub(crate) async fn invalidate_all(&self) -> usize {
        let drained: Vec<Slot<S>> = {
            let mut map = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            map.drain().map(|(_, slot)| slot).collect()
        };
        let mut count = 0;
        for slot in drained {
            let server = slot.lock().await.take();
            if let Some(server) = server {
                count += 1;
                if server.active_handles() == 0 {
                    server.shutdown_server().await;
                }
            }
        }
        count
    }

    /// Finds an alive pooled server whose key matches `predicate`.
    pub(crate) async fn find_alive(&self, mut predicate: impl FnMut(&K) -> bool) -> Option<Arc<S>> {
        let matching_slots: Vec<Slot<S>> = {
            let map = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            map.iter()
                .filter(|(k, _)| predicate(k))
                .map(|(_, slot)| Arc::clone(slot))
                .collect()
        };
        for slot in matching_slots {
            let guard = slot.lock().await;
            if let Some(server) = guard.as_ref()
                && server.is_alive()
            {
                return Some(Arc::clone(server));
            }
        }
        None
    }

    #[cfg(test)]
    pub(crate) async fn insert_for_test(&self, key: K, server: Arc<S>) {
        let slot = self.get_or_create_slot(&key);
        *slot.lock().await = Some(server);
    }

    #[cfg(test)]
    pub(crate) async fn remove_for_test(&self, key: &K) -> Option<Arc<S>> {
        let slot = self.get_slot(key)?;
        let mut slot_guard = slot.lock().await;
        let removed = slot_guard.take();
        self.prune_if_empty_locked(key, &slot, &slot_guard);
        removed
    }

    #[cfg(test)]
    pub(crate) fn entry_count_for_test(&self) -> usize {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };

    use tokio::sync::{Notify, oneshot};

    use super::*;

    struct FakeServer {
        id: usize,
        alive: AtomicBool,
        handles: AtomicUsize,
        shutdown_calls: AtomicUsize,
    }

    impl FakeServer {
        fn new(id: usize) -> Arc<Self> {
            Arc::new(Self {
                id,
                alive: AtomicBool::new(true),
                handles: AtomicUsize::new(0),
                shutdown_calls: AtomicUsize::new(0),
            })
        }
    }

    #[async_trait]
    impl PooledWorkspaceServer for FakeServer {
        fn is_alive(&self) -> bool {
            self.alive.load(Ordering::Acquire)
        }

        fn acquire_handle(&self) -> usize {
            self.handles.fetch_add(1, Ordering::AcqRel) + 1
        }

        fn release_handle(&self) -> usize {
            self.handles
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                    Some(n.saturating_sub(1))
                })
                .map(|prev| prev.saturating_sub(1))
                .unwrap_or(0)
        }

        fn active_handles(&self) -> usize {
            self.handles.load(Ordering::Acquire)
        }

        async fn shutdown_server(&self) {
            self.alive.store(false, Ordering::Release);
            self.shutdown_calls.fetch_add(1, Ordering::AcqRel);
        }
    }

    #[tokio::test]
    async fn release_shuts_down_despite_transient_arc_clones_and_never_underflows() {
        let pool: WorkspaceServerPool<&'static str, FakeServer> = WorkspaceServerPool::new();
        let lease = pool
            .get_or_spawn("ws-a", || async { Ok(FakeServer::new(1)) })
            .await
            .unwrap();
        let server = Arc::clone(lease.server());
        // Simulate transient background probe (e.g. read_rate_limits) holding extra Arc clones.
        let _probe_clone_1 = Arc::clone(&server);
        let _probe_clone_2 = Arc::clone(&server);
        assert!(Arc::strong_count(&server) >= 4);
        assert_eq!(server.active_handles(), 1);

        // Shutting down the sole business handle must still evict & shut down the server.
        pool.release_and_shutdown_if_unused(&"ws-a", &lease).await;
        assert_eq!(server.active_handles(), 0);
        assert!(!server.is_alive());
        assert_eq!(server.shutdown_calls.load(Ordering::Acquire), 1);
        assert_eq!(pool.entry_count_for_test(), 0);

        // Double release + Drop must be no-ops and never underflow or re-shutdown.
        pool.release_and_shutdown_if_unused(&"ws-a", &lease).await;
        drop(lease);
        assert_eq!(server.active_handles(), 0);
        assert_eq!(server.shutdown_calls.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn slow_spawn_on_workspace_a_does_not_block_workspace_b() {
        let pool = Arc::new(WorkspaceServerPool::<&'static str, FakeServer>::new());
        let (started_tx, started_rx) = oneshot::channel();
        let release_a = Arc::new(Notify::new());

        let pool_a = Arc::clone(&pool);
        let release_a_task = Arc::clone(&release_a);
        let task_a = tokio::spawn(async move {
            pool_a
                .get_or_spawn("ws-slow", || async move {
                    let _ = started_tx.send(());
                    release_a_task.notified().await;
                    Ok(FakeServer::new(1))
                })
                .await
        });

        // Wait until ws-slow is inside its slow spawn/handshake.
        started_rx.await.unwrap();

        // Workspace B must complete immediately without waiting on ws-slow.
        let lease_b = tokio::time::timeout(
            Duration::from_millis(200),
            pool.get_or_spawn("ws-fast", || async { Ok(FakeServer::new(2)) }),
        )
        .await
        .expect("workspace B must not block behind workspace A spawn")
        .unwrap();
        assert_eq!(lease_b.server().id, 2);

        release_a.notify_one();
        let lease_a = task_a.await.unwrap().unwrap();
        assert_eq!(lease_a.server().id, 1);

        pool.release_and_shutdown_if_unused(&"ws-slow", &lease_a)
            .await;
        pool.release_and_shutdown_if_unused(&"ws-fast", &lease_b)
            .await;
    }

    #[tokio::test]
    async fn concurrent_shutdown_and_spawn_on_same_key_never_returns_dead_server() {
        let pool = Arc::new(WorkspaceServerPool::<&'static str, FakeServer>::new());
        let next_id = Arc::new(AtomicUsize::new(10));

        for _ in 0..50 {
            let lease1 = pool
                .get_or_spawn("ws-race", || {
                    let id = next_id.fetch_add(1, Ordering::Relaxed);
                    async move { Ok(FakeServer::new(id)) }
                })
                .await
                .unwrap();

            let pool_shutdown = Arc::clone(&pool);
            let pool_spawn = Arc::clone(&pool);
            let next_id_spawn = Arc::clone(&next_id);

            let ((), lease2) = tokio::join!(
                async move {
                    pool_shutdown
                        .release_and_shutdown_if_unused(&"ws-race", &lease1)
                        .await;
                },
                async move {
                    pool_spawn
                        .get_or_spawn("ws-race", || {
                            let id = next_id_spawn.fetch_add(1, Ordering::Relaxed);
                            async move { Ok(FakeServer::new(id)) }
                        })
                        .await
                        .unwrap()
                }
            );

            // Whichever task won the per-key slot lock, the returned lease MUST
            // reference a live server with active_handles >= 1.
            assert!(
                lease2.server().is_alive(),
                "get_or_spawn must never return a server being shut down"
            );
            assert_eq!(lease2.server().active_handles(), 1);
            pool.release_and_shutdown_if_unused(&"ws-race", &lease2)
                .await;
        }
        assert_eq!(pool.entry_count_for_test(), 0);
    }
}
