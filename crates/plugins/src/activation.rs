use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use serde_json::Value;
use tokio::sync::RwLock;

use crate::{
    CapabilityBroker, CapabilityGrant, PluginPackage, SharedNodeWorkerHost, WorkerActivation,
    WorkerHost, WorkerHostError,
};

/// Owns candidate-first Worker generations. A candidate is invisible until
/// spawn, handshake, and registration validation all succeed.
///
/// Tier-0/Tier-1 plugins (no `entrypoints.worker`) record lightweight
/// activation metadata with zero OS subprocesses. Tier-2 Node plugins share a
/// single on-demand `SharedNodeWorkerHost` OS process.
#[derive(Default)]
pub struct ActivationManager {
    next_generation: AtomicU64,
    active: RwLock<BTreeMap<String, Arc<WorkerHost>>>,
    draining: Arc<RwLock<BTreeMap<String, Vec<Arc<WorkerHost>>>>>,
    shared_node: Arc<SharedNodeWorkerHost>,
    plugin_locks: std::sync::Mutex<BTreeMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

#[derive(Clone)]
pub struct ActivationLease {
    host: Arc<WorkerHost>,
}

pub struct PreparedActivation {
    plugin_id: String,
    host: Arc<WorkerHost>,
}

pub(crate) struct GenerationDrain {
    pub generation: u64,
    completion: tokio::task::JoinHandle<()>,
}

impl GenerationDrain {
    pub async fn wait(self) {
        let _ = self.completion.await;
    }
}

impl PreparedActivation {
    pub fn activation(&self) -> &WorkerActivation {
        self.host.activation()
    }

    pub async fn pid(&self) -> Option<u32> {
        self.host.pid().await
    }

    pub async fn discard(self, reason: &str) -> Result<(), WorkerHostError> {
        self.host.dispose(reason).await
    }
}

impl ActivationLease {
    pub fn activation(&self) -> &WorkerActivation {
        self.host.activation()
    }

    pub async fn pid(&self) -> Option<u32> {
        self.host.pid().await
    }

    pub fn is_shared_node_process(&self) -> bool {
        self.host.is_shared_node_process()
    }

    pub fn is_lightweight(&self) -> bool {
        self.host.is_lightweight()
    }

    pub async fn is_terminal(&self) -> bool {
        self.host.is_terminal().await
    }

    pub async fn update_config(&self, config: Value) -> Result<bool, WorkerHostError> {
        if self.host.is_reentrant_lock_held() {
            self.host.defer_config_update(config);
            return Ok(true);
        }
        self.host.update_config(config).await
    }

    pub async fn invoke(&self, handler: &str, input: Value) -> Result<Value, WorkerHostError> {
        self.host.invoke(handler, input).await
    }

    pub async fn invoke_slot(&self, handler: &str, input: Value) -> Result<Value, WorkerHostError> {
        self.host.invoke(handler, input).await
    }

    pub async fn invoke_with_timeout(
        &self,
        handler: &str,
        input: Value,
        request_timeout: std::time::Duration,
    ) -> Result<Value, WorkerHostError> {
        self.host
            .invoke_with_timeout(handler, input, request_timeout)
            .await
    }
}

impl ActivationManager {
    /// Total OS worker subprocesses currently alive for this manager.
    ///
    /// - 0 when only Tier-0/Tier-1 plugins are active or when all Tier-2
    ///   workers are idle/disabled.
    /// - 1 when one or more Tier-2 Node plugins are active in the shared runner
    ///   (plus any dedicated native/Python worker processes).
    pub async fn active_worker_process_count(&self) -> usize {
        let shared = usize::from(self.shared_node.is_running().await);
        let active_dedicated = self
            .active
            .read()
            .await
            .values()
            .filter(|host| host.is_dedicated_process())
            .count();
        let draining_dedicated = self
            .draining
            .read()
            .await
            .values()
            .flat_map(|list| list.iter())
            .filter(|host| host.is_dedicated_process())
            .count();
        shared + active_dedicated + draining_dedicated
    }

    /// OS PID of the shared Node worker runner, if currently running.
    pub async fn shared_node_worker_pid(&self) -> Option<u32> {
        self.shared_node.pid().await
    }

    pub async fn activate_candidate(
        &self,
        node_executable: &Path,
        package: &PluginPackage,
        grants: &[CapabilityGrant],
        broker: Arc<dyn CapabilityBroker>,
    ) -> Result<WorkerActivation, WorkerHostError> {
        let prepared = self
            .prepare_candidate(node_executable, package, grants, broker)
            .await?;
        let activation = prepared.activation().clone();
        let _ = self.commit(prepared).await?;
        Ok(activation)
    }

    /// Acquires a per-`plugin_id` serialization lock shared between lazy
    /// activation and lifecycle write operations (enable, disable, update,
    /// uninstall, idle recycle).
    pub(crate) async fn lock_plugin(&self, plugin_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self
                .plugin_locks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            Arc::clone(
                locks
                    .entry(plugin_id.to_owned())
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
            )
        };
        lock.lock_owned().await
    }

    pub async fn prepare_candidate(
        &self,
        node_executable: &Path,
        package: &PluginPackage,
        grants: &[CapabilityGrant],
        broker: Arc<dyn CapabilityBroker>,
    ) -> Result<PreparedActivation, WorkerHostError> {
        let generation = self
            .next_generation
            .fetch_add(1, Ordering::SeqCst)
            .saturating_add(1);
        self.prepare_candidate_at(generation, node_executable, package, grants, broker)
            .await
    }

    pub fn prepare_lightweight_candidate_at(
        &self,
        generation: u64,
        package: &PluginPackage,
        grants: &[CapabilityGrant],
        broker: Arc<dyn CapabilityBroker>,
    ) -> Result<PreparedActivation, WorkerHostError> {
        self.next_generation.fetch_max(generation, Ordering::SeqCst);
        let candidate = Arc::new(WorkerHost::spawn_lightweight(
            package, generation, grants, broker,
        )?);
        Ok(PreparedActivation {
            plugin_id: package.id.as_str().to_owned(),
            host: candidate,
        })
    }

    pub async fn prepare_candidate_at(
        &self,
        generation: u64,
        node_executable: &Path,
        package: &PluginPackage,
        grants: &[CapabilityGrant],
        broker: Arc<dyn CapabilityBroker>,
    ) -> Result<PreparedActivation, WorkerHostError> {
        self.next_generation.fetch_max(generation, Ordering::SeqCst);
        let candidate = if package.entrypoints.worker.is_none() {
            Arc::new(WorkerHost::spawn_lightweight(
                package, generation, grants, broker,
            )?)
        } else {
            let runtime = package
                .entrypoints
                .worker_runtime
                .as_deref()
                .unwrap_or("node");
            if runtime == "node" {
                Arc::new(
                    WorkerHost::spawn_in_shared_node(
                        Arc::clone(&self.shared_node),
                        node_executable,
                        package,
                        generation,
                        grants,
                        broker,
                    )
                    .await?,
                )
            } else {
                Arc::new(
                    WorkerHost::spawn(node_executable, package, generation, grants, broker).await?,
                )
            }
        };
        Ok(PreparedActivation {
            plugin_id: package.id.as_str().to_owned(),
            host: candidate,
        })
    }

    pub(crate) async fn commit(
        &self,
        prepared: PreparedActivation,
    ) -> Result<Option<GenerationDrain>, WorkerHostError> {
        let plugin_id = prepared.plugin_id;
        let incoming_generation = prepared.host.activation().generation;
        let previous = {
            let mut active = self.active.write().await;
            if let Some(existing) = active.get(&plugin_id) {
                let existing_generation = existing.activation().generation;
                let stale = incoming_generation < existing_generation
                    || (incoming_generation == existing_generation
                        && !existing.is_terminal().await);
                if stale {
                    drop(active);
                    let _ = prepared.host.dispose("stale generation rejected").await;
                    return Err(WorkerHostError::external(
                        "stale_generation",
                        format!(
                            "refusing to overwrite generation {existing_generation} of plugin `{plugin_id}` with generation {incoming_generation}"
                        ),
                    ));
                }
            }
            active.insert(plugin_id.clone(), prepared.host)
        };
        if let Some(previous) = previous {
            let generation = previous.activation().generation;
            self.draining
                .write()
                .await
                .entry(plugin_id.clone())
                .or_default()
                .push(Arc::clone(&previous));
            let draining_map = Arc::clone(&self.draining);
            let completion = tokio::spawn(async move {
                let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
                // 2 strong refs exist while draining_map + this task hold `previous`;
                // external ActivationLeases make strong_count > 2.
                while Arc::strong_count(&previous) > 2 && tokio::time::Instant::now() < deadline {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
                let _ = previous.dispose("generation replaced").await;
                let mut map = draining_map.write().await;
                if let Some(list) = map.get_mut(&plugin_id) {
                    list.retain(|item| item.activation().generation != generation);
                    if list.is_empty() {
                        map.remove(&plugin_id);
                    }
                }
            });
            Ok(Some(GenerationDrain {
                generation,
                completion,
            }))
        } else {
            Ok(None)
        }
    }

    pub async fn running_plugin_ids(&self) -> Vec<String> {
        self.active.read().await.keys().cloned().collect()
    }

    pub async fn idle_elapsed(&self, plugin_id: &str) -> Option<std::time::Duration> {
        self.active
            .read()
            .await
            .get(plugin_id)
            .map(|host| host.idle_elapsed())
    }

    pub async fn lease(&self, plugin_id: &str) -> Option<ActivationLease> {
        self.active
            .read()
            .await
            .get(plugin_id)
            .cloned()
            .map(|host| ActivationLease { host })
    }

    pub async fn update_config(
        &self,
        plugin_id: &str,
        config: Value,
    ) -> Result<bool, WorkerHostError> {
        let Some(lease) = self.lease(plugin_id).await else {
            return Ok(false);
        };
        if lease.is_lightweight() || lease.is_terminal().await {
            return Ok(false);
        }
        lease.update_config(config).await
    }

    pub async fn deactivate(&self, plugin_id: &str) -> Result<bool, WorkerHostError> {
        let previous = self.active.write().await.remove(plugin_id);
        let draining = self
            .draining
            .write()
            .await
            .remove(plugin_id)
            .unwrap_or_default();
        for old in draining {
            if old.is_reentrant_lock_held() {
                old.mark_terminal();
                tokio::spawn(async move {
                    let _ = old.dispose("plugin disabled").await;
                });
            } else {
                let _ = old.dispose("plugin disabled").await;
            }
        }
        if let Some(previous) = previous {
            if previous.is_reentrant_lock_held() {
                previous.mark_terminal();
                tokio::spawn(async move {
                    let _ = previous.dispose("plugin disabled").await;
                });
            } else {
                previous.dispose("plugin disabled").await?;
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub(crate) async fn deactivate_if_terminal(
        &self,
        plugin_id: &str,
    ) -> Result<bool, WorkerHostError> {
        let host = self.active.read().await.get(plugin_id).cloned();
        let Some(host) = host else {
            return Ok(false);
        };
        if !host.is_terminal().await {
            return Ok(false);
        }
        self.deactivate(plugin_id).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn test_lightweight_package(id: &str) -> (tempfile::TempDir, PluginPackage) {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("README.md"), "# Test Plugin").expect("write readme");
        let pkg = PluginPackage::for_test(
            id,
            "Test Plugin",
            "1.0.0",
            crate::PluginSourceKind::Snapshot,
            dir.path(),
        );
        (dir, pkg)
    }

    #[tokio::test]
    async fn commit_requires_strictly_increasing_generation_for_live_hosts() {
        let manager = ActivationManager::default();
        let (_dir, pkg) = test_lightweight_package("dimo.gen-guard");
        let broker: Arc<dyn CapabilityBroker> = Arc::new(crate::DenyCapabilityBroker);

        let gen2 = manager
            .prepare_lightweight_candidate_at(2, &pkg, &[], Arc::clone(&broker))
            .expect("prepare gen 2");
        assert!(manager.commit(gen2).await.expect("commit gen 2").is_none());
        assert_eq!(
            manager
                .lease("dimo.gen-guard")
                .await
                .expect("lease gen 2")
                .activation()
                .generation,
            2
        );

        // Stale older generation must be rejected without replacing gen 2.
        let gen1 = manager
            .prepare_lightweight_candidate_at(1, &pkg, &[], Arc::clone(&broker))
            .expect("prepare stale gen 1");
        let stale_err = manager
            .commit(gen1)
            .await
            .err()
            .expect("older generation must be rejected");
        assert_eq!(stale_err.code(), "stale_generation");
        assert_eq!(
            manager
                .lease("dimo.gen-guard")
                .await
                .expect("lease still gen 2")
                .activation()
                .generation,
            2
        );

        // Duplicate live generation must also be rejected.
        let dup_gen2 = manager
            .prepare_lightweight_candidate_at(2, &pkg, &[], Arc::clone(&broker))
            .expect("prepare duplicate gen 2");
        let dup_err = manager
            .commit(dup_gen2)
            .await
            .err()
            .expect("equal live generation must be rejected");
        assert_eq!(dup_err.code(), "stale_generation");

        // Strictly newer generation succeeds and drains gen 2.
        let gen3 = manager
            .prepare_lightweight_candidate_at(3, &pkg, &[], broker)
            .expect("prepare gen 3");
        let drain = manager
            .commit(gen3)
            .await
            .expect("commit gen 3")
            .expect("replacing gen 2 yields drain");
        assert_eq!(drain.generation, 2);
        assert_eq!(
            manager
                .lease("dimo.gen-guard")
                .await
                .expect("lease gen 3")
                .activation()
                .generation,
            3
        );
    }

    #[tokio::test]
    async fn per_plugin_lock_serializes_same_plugin_without_blocking_other_plugins() {
        let manager = Arc::new(ActivationManager::default());
        let guard_a = manager.lock_plugin("dimo.alpha").await;

        // Different plugin acquires immediately while alpha is held.
        let guard_b = tokio::time::timeout(
            std::time::Duration::from_millis(200),
            manager.lock_plugin("dimo.beta"),
        )
        .await
        .expect("different plugin must not be blocked");
        drop(guard_b);

        // Same plugin waits until guard_a is released.
        let manager_clone = Arc::clone(&manager);
        let waiter = tokio::spawn(async move {
            let _g = manager_clone.lock_plugin("dimo.alpha").await;
        });
        tokio::task::yield_now().await;
        assert!(
            !waiter.is_finished(),
            "second lock for same plugin must wait while first guard is held"
        );
        drop(guard_a);
        tokio::time::timeout(std::time::Duration::from_millis(500), waiter)
            .await
            .expect("waiter should acquire after release")
            .expect("waiter task ok");
    }
}
