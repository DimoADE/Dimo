use std::{
    collections::HashMap,
    future::Future,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicI64, Ordering},
    },
};

use agents::TerminalOutputRx;
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use remote_protocol::{
    EventDurability, SubscriptionBootstrap, SubscriptionId, SubscriptionSnapshot,
};
use serde::Serialize;
use tokio::{sync::broadcast, task::JoinHandle};
use uuid::Uuid;

pub(crate) const BUS_CAPACITY: usize = 2_048;

const PATCH_STREAM_PREFIXES: &[&str] = &[
    "file-tree-stream",
    "projects-stream",
    "project-workspaces-stream",
    "execution-processes-stream",
    "diff-stream",
    "conversation-stream",
    "scratch-stream",
    "slash-commands-stream",
    "log-stream",
];

tokio::task_local! {
    static CURRENT_BUS: Arc<HostEventBus>;
}

pub fn bind_host_events<F: Future>(
    bus: Arc<HostEventBus>,
    fut: F,
) -> impl Future<Output = F::Output> {
    CURRENT_BUS.scope(bus, fut)
}

pub fn current_host_events() -> Arc<HostEventBus> {
    CURRENT_BUS
        .try_with(Arc::clone)
        .expect("Host Event Bus is not bound to this task")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HostEventChannel {
    pub prefix: &'static str,
    pub durability: EventDurability,
    pub required_scope: &'static str,
}

pub const COLLABORATION_SPACE_CHANGED_EVENT: &str = "dimo://collaboration-space-changed";
/// Three-state delivery receipts of a space message changed.
pub const COLLABORATION_RECEIPTS_CHANGED_EVENT: &str = "dimo://collaboration-receipts-changed";
pub const LOCAL_APP_DATA_CLEARED_EVENT: &str = "dimo://local-app-data-cleared";

/// Catalog of Host push channels. Prefix match is longest-first.
pub const HOST_EVENT_CHANNELS: &[HostEventChannel] = &[
    HostEventChannel {
        prefix: "conversation-events",
        durability: EventDurability::BestEffort,
        required_scope: "conversation.read",
    },
    HostEventChannel {
        prefix: "conversation-rate-limit",
        durability: EventDurability::BestEffort,
        required_scope: "conversation.read",
    },
    HostEventChannel {
        prefix: "workspace-sessions-changed",
        durability: EventDurability::Invalidation,
        required_scope: "conversation.read",
    },
    HostEventChannel {
        prefix: "workspace-focus-conversation",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "agent-management-event",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "agent-management-snapshot-invalidated",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "agent-management-discovery-progress",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "agent-capability-catalog-updated",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "agent-terminal-events",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "desktop-session-attention",
        durability: EventDurability::BestEffort,
        required_scope: "conversation.read",
    },
    HostEventChannel {
        prefix: "file-tree-stream",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "projects-stream",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "project-workspaces-stream",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "execution-processes-stream",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "diff-stream",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "conversation-stream",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "scratch-stream",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "slash-commands-stream",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "log-stream",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "dimo://settings-file-changed",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "dimo://backup-progress",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "host-client-changed",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "dimo://remote-host-event",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "dimo://remote-subscription-event",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: LOCAL_APP_DATA_CLEARED_EVENT,
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: COLLABORATION_SPACE_CHANGED_EVENT,
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: COLLABORATION_RECEIPTS_CHANGED_EVENT,
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "theme-changed",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "log-settings://changed",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "logs://appended",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "local-history-import-progress",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "local-history-scan-progress",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "host-tunnel-lease-rejected",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "agent-events",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "terminal-output",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "terminal-exit",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "plugin-contributions-changed",
        durability: EventDurability::Invalidation,
        required_scope: "plugin.read",
    },
    HostEventChannel {
        prefix: "plugin-conversation-draft-insert",
        durability: EventDurability::BestEffort,
        required_scope: "conversation.read",
    },
    HostEventChannel {
        prefix: "plugin-internal-message",
        durability: EventDurability::BestEffort,
        required_scope: "conversation.read",
    },
    HostEventChannel {
        prefix: "conversation-after-turn",
        durability: EventDurability::BestEffort,
        required_scope: "conversation.read",
    },
    HostEventChannel {
        prefix: "conversation-runtime-event",
        durability: EventDurability::BestEffort,
        required_scope: "conversation.read",
    },
    HostEventChannel {
        prefix: "plugin-updates-changed",
        durability: EventDurability::Invalidation,
        required_scope: "plugin.read",
    },
    HostEventChannel {
        prefix: "plugin-updates-available",
        durability: EventDurability::BestEffort,
        required_scope: "plugin.read",
    },
    HostEventChannel {
        prefix: "plugin-notify-toast",
        durability: EventDurability::BestEffort,
        required_scope: "plugin.read",
    },
    HostEventChannel {
        prefix: "provider-bind-confirm",
        durability: EventDurability::BestEffort,
        required_scope: "plugin.write",
    },
    HostEventChannel {
        prefix: "plugin:browser",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "vibex://pulse-deck-changed",
        durability: EventDurability::Invalidation,
        required_scope: "automation.read",
    },
];

#[derive(Clone, Debug)]
pub struct HostEvent {
    pub channel: String,
    pub payload: serde_json::Value,
    pub sequence: i64,
    pub durability: EventDurability,
}

#[derive(Default)]
struct StreamTaskState {
    tasks: HashMap<String, JoinHandle<()>>,
    refs: HashMap<String, usize>,
}

/// Per-Host push surface. Desktop forwards matching channels to Tauri; Server WS
/// attaches as `host_event`. Instances are isolated — never process-global.
#[derive(Clone)]
pub struct HostEventBus {
    tx: broadcast::Sender<HostEvent>,
    patch_tx: broadcast::Sender<HostEvent>,
    sequence: Arc<AtomicI64>,
    last_invalidation: Arc<RwLock<HashMap<String, HostEvent>>>,
    stream_state: Arc<Mutex<StreamTaskState>>,
}

impl Default for HostEventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl HostEventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(BUS_CAPACITY);
        let (patch_tx, _) = broadcast::channel(BUS_CAPACITY);
        Self {
            tx,
            patch_tx,
            sequence: Arc::new(AtomicI64::new(0)),
            last_invalidation: Arc::new(RwLock::new(HashMap::new())),
            stream_state: Arc::new(Mutex::new(StreamTaskState::default())),
        }
    }

    /// Register a stream producer task for `key`, aborting any previous task
    /// registered under the same `key` on this Host Event Bus.
    pub fn replace_stream_task(&self, key: impl Into<String>, task: JoinHandle<()>) {
        if let Ok(mut state) = self.stream_state.lock() {
            state.tasks.retain(|_, handle| !handle.is_finished());
            if let Some(previous) = state.tasks.insert(key.into(), task) {
                previous.abort();
            }
        }
    }

    /// Ensure at most one active producer task is running for `key` on this
    /// Host Event Bus. If a previous task is missing or has finished, `spawn_fn`
    /// is invoked to start a new one.
    pub fn ensure_stream_task<F>(&self, key: impl Into<String>, spawn_fn: F)
    where
        F: FnOnce() -> JoinHandle<()>,
    {
        if let Ok(mut state) = self.stream_state.lock() {
            state.tasks.retain(|_, handle| !handle.is_finished());
            let key = key.into();
            if state.tasks.contains_key(&key) {
                return;
            }
            state.tasks.insert(key, spawn_fn());
        }
    }

    /// Increment the subscriber refcount for an active stream producer task key.
    pub fn retain_stream_task(&self, key: &str) {
        if let Ok(mut state) = self.stream_state.lock() {
            let count = state.refs.entry(key.to_string()).or_insert(0);
            *count = count.saturating_add(1);
        }
    }

    /// Decrement the subscriber refcount for a stream producer task key and abort
    /// + remove the background task once the final subscriber detaches.
    pub fn release_stream_task(&self, key: &str) {
        if let Ok(mut state) = self.stream_state.lock() {
            let should_abort = match state.refs.get_mut(key) {
                Some(count) if *count > 1 => {
                    *count -= 1;
                    false
                }
                Some(_) => {
                    state.refs.remove(key);
                    true
                }
                None => false,
            };
            if should_abort {
                if let Some(handle) = state.tasks.remove(key) {
                    handle.abort();
                }
                state.tasks.retain(|_, handle| !handle.is_finished());
            }
        }
    }

    pub fn current_sequence(&self) -> i64 {
        self.sequence.load(Ordering::SeqCst)
    }

    pub fn has_subscribers(&self) -> bool {
        self.tx.receiver_count() > 0 || self.patch_tx.receiver_count() > 0
    }

    pub fn emit(&self, channel: impl Into<String>, payload: impl Serialize) {
        let channel = channel.into();
        let descriptor = Self::descriptor(&channel);
        let durability = descriptor
            .map(|descriptor| descriptor.durability)
            .unwrap_or(EventDurability::BestEffort);
        let is_patch_stream =
            descriptor.is_some_and(|descriptor| PATCH_STREAM_PREFIXES.contains(&descriptor.prefix));
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let has_tx_receivers = self.tx.receiver_count() > 0;
        let has_patch_receivers = is_patch_stream && self.patch_tx.receiver_count() > 0;
        if durability != EventDurability::Invalidation && !has_tx_receivers && !has_patch_receivers
        {
            return;
        }
        let Ok(payload) = serde_json::to_value(payload) else {
            return;
        };
        let event = HostEvent {
            channel: channel.clone(),
            payload,
            sequence,
            durability,
        };
        if durability == EventDurability::Invalidation
            && let Ok(mut last) = self.last_invalidation.write()
        {
            if last.len() >= 256
                && !last.contains_key(&channel)
                && let Some(evict_key) = last
                    .iter()
                    .filter(|(key, _)| key.contains(':'))
                    .min_by_key(|(_, entry)| entry.sequence)
                    .map(|(key, _)| key.clone())
            {
                last.remove(&evict_key);
            }
            last.insert(channel, event.clone());
        }
        if has_patch_receivers {
            if has_tx_receivers {
                let _ = self.patch_tx.send(event.clone());
            } else {
                let _ = self.patch_tx.send(event);
                return;
            }
        }
        if has_tx_receivers {
            let _ = self.tx.send(event);
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<HostEvent> {
        self.tx.subscribe()
    }

    /// Subscribe exclusively to RFC 6902 patch-stream events, isolated from
    /// high-volume best-effort bursts such as `terminal-output` and `logs://appended`.
    pub fn subscribe_patch_streams(&self) -> broadcast::Receiver<HostEvent> {
        self.patch_tx.subscribe()
    }

    pub fn is_patch_stream_channel(channel: &str) -> bool {
        Self::descriptor(channel)
            .is_some_and(|descriptor| PATCH_STREAM_PREFIXES.contains(&descriptor.prefix))
    }

    /// Return cached latest `Invalidation` events matching `channel` newer than
    /// `after_sequence`, ordered by sequence. Used to recover after a broadcast lag.
    pub fn latest_invalidations_for(
        &self,
        channel: &str,
        exact: bool,
        after_sequence: i64,
    ) -> Vec<HostEvent> {
        let Ok(last) = self.last_invalidation.read() else {
            return Vec::new();
        };
        let mut events = last
            .values()
            .filter(|event| {
                event.sequence > after_sequence
                    && (event.channel == channel
                        || (!exact
                            && event
                                .channel
                                .strip_prefix(channel)
                                .is_some_and(|rest| rest.starts_with(':'))))
            })
            .cloned()
            .collect::<Vec<_>>();
        events.sort_by_key(|event| event.sequence);
        events
    }

    pub fn descriptor(channel: &str) -> Option<&'static HostEventChannel> {
        HOST_EVENT_CHANNELS
            .iter()
            .filter(|candidate| {
                channel == candidate.prefix
                    || channel
                        .strip_prefix(candidate.prefix)
                        .is_some_and(|rest| rest.starts_with(':'))
            })
            .max_by_key(|candidate| candidate.prefix.len())
    }

    pub fn channel_allowed(channel: &str) -> bool {
        Self::descriptor(channel).is_some()
    }

    pub fn required_scope(channel: &str) -> Option<&'static str> {
        Self::descriptor(channel).map(|descriptor| descriptor.required_scope)
    }

    pub fn durability(channel: &str) -> Option<EventDurability> {
        Self::descriptor(channel).map(|descriptor| descriptor.durability)
    }

    /// Attach a Host Event channel. Non-durable channels never replay missed
    /// broadcasts from `after_sequence`. Invalidation attach returns the latest
    /// snapshot so the client can refetch; best-effort is live-only.
    pub fn attach_bootstrap(
        &self,
        subscription_id: SubscriptionId,
        channel: &str,
        _after_sequence: i64,
    ) -> Result<SubscriptionBootstrap, String> {
        let descriptor = Self::descriptor(channel)
            .ok_or_else(|| format!("host event channel `{channel}` is not registered"))?;
        let high_water_mark = self.current_sequence();
        let snapshot = match descriptor.durability {
            EventDurability::Invalidation => self
                .last_invalidation
                .read()
                .ok()
                .and_then(|last| last.get(channel).cloned())
                .map(|event| SubscriptionSnapshot {
                    through_sequence: event.sequence,
                    payload: event.payload,
                }),
            EventDurability::BestEffort | EventDurability::Durable => None,
        };
        Ok(SubscriptionBootstrap {
            subscription_id,
            ready: true,
            snapshot,
            replay: Vec::new(),
            high_water_mark,
            durability: descriptor.durability,
        })
    }
}

pub fn terminal_output_channel(session_id: Uuid) -> String {
    format!("terminal-output:{session_id}")
}

pub fn terminal_exit_channel(session_id: Uuid) -> String {
    format!("terminal-exit:{session_id}")
}

#[derive(Serialize)]
struct TerminalOutputEvent {
    data: String,
    seq: u64,
}

struct TerminalBridge {
    subscribers: usize,
    task: JoinHandle<()>,
}

/// One output pump per Host terminal session, refcounted by attach/close.
#[derive(Default)]
pub struct TerminalBridgeRegistry {
    inner: Mutex<HashMap<Uuid, TerminalBridge>>,
}

impl TerminalBridgeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscriber_count(&self, session_id: Uuid) -> usize {
        self.inner
            .lock()
            .map(|inner| {
                inner
                    .get(&session_id)
                    .map(|bridge| bridge.subscribers)
                    .unwrap_or(0)
            })
            .unwrap_or(0)
    }

    pub fn ensure(&self, bus: Arc<HostEventBus>, session_id: Uuid, output_rx: TerminalOutputRx) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(existing) = inner.get_mut(&session_id) {
            if !existing.task.is_finished() {
                existing.subscribers = existing.subscribers.saturating_add(1);
                drop(output_rx);
                return;
            }
            inner.remove(&session_id);
        }
        let channel = terminal_output_channel(session_id);
        let exit_channel = terminal_exit_channel(session_id);
        let task = tokio::spawn(async move {
            const PTY_COALESCE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(16);
            const PTY_COALESCE_MAX_BYTES: usize = 32 * 1024;

            let mut output_rx = output_rx;
            let mut pending_bytes: Vec<u8> = Vec::new();
            let mut latest_seq: u64 = 0;
            let mut flush_deadline: Option<tokio::time::Instant> = None;

            let emit_batch = |bytes: &mut Vec<u8>, seq: u64| {
                if bytes.is_empty() {
                    return;
                }
                bus.emit(
                    &channel,
                    TerminalOutputEvent {
                        data: BASE64.encode(&*bytes),
                        seq,
                    },
                );
                bytes.clear();
            };

            loop {
                let next = if let Some(deadline) = flush_deadline {
                    tokio::select! {
                        biased;
                        chunk = output_rx.recv() => Some(chunk),
                        _ = tokio::time::sleep_until(deadline) => None,
                    }
                } else {
                    Some(output_rx.recv().await)
                };

                match next {
                    None => {
                        flush_deadline = None;
                        emit_batch(&mut pending_bytes, latest_seq);
                    }
                    Some(Some(chunk)) => {
                        latest_seq = chunk.seq;
                        pending_bytes.extend_from_slice(&chunk.data);
                        if pending_bytes.len() >= PTY_COALESCE_MAX_BYTES {
                            flush_deadline = None;
                            emit_batch(&mut pending_bytes, latest_seq);
                        } else if flush_deadline.is_none() {
                            flush_deadline =
                                Some(tokio::time::Instant::now() + PTY_COALESCE_INTERVAL);
                        }
                    }
                    Some(None) => {
                        emit_batch(&mut pending_bytes, latest_seq);
                        break;
                    }
                }
            }
            bus.emit(&exit_channel, session_id);
        });
        inner.insert(
            session_id,
            TerminalBridge {
                subscribers: 1,
                task,
            },
        );
    }

    pub fn release(&self, session_id: Uuid) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let Some(existing) = inner.get_mut(&session_id) else {
            return;
        };
        existing.subscribers = existing.subscribers.saturating_sub(1);
        if existing.subscribers == 0 {
            existing.task.abort();
            inner.remove(&session_id);
        }
    }

    pub fn abort_all(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        for (_, bridge) in inner.drain() {
            bridge.task.abort();
        }
    }
}

/// Forward PTY (or Agent terminal) bytes onto the Host Event Bus as base64.
pub fn spawn_terminal_output_bridge(
    bus: Arc<HostEventBus>,
    bridges: &TerminalBridgeRegistry,
    session_id: Uuid,
    output_rx: TerminalOutputRx,
) {
    bridges.ensure(bus, session_id, output_rx);
}

/// Map a `patch_stream` resource name to the Host Event Bus channel the
/// matching `subscribe_*_stream` producer emits on.
pub fn patch_stream_channel(stream: &str, args: &serde_json::Value) -> Result<String, String> {
    let field = |camel: &str, snake: &str| {
        args.get(camel)
            .or_else(|| args.get(snake))
            .and_then(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| value.as_u64().map(|id| id.to_string()))
            })
    };
    match stream {
        "projects" => Ok("projects-stream".to_string()),
        "file_tree" => {
            let root_path = args
                .get("rootPath")
                .or_else(|| args.get("root_path"))
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "rootPath is required".to_string())?;
            let canonical = std::fs::canonicalize(root_path)
                .map_err(|error| format!("Invalid file tree root '{root_path}': {error}"))?;
            Ok(format!("file-tree-stream:{}", canonical.to_string_lossy()))
        }
        "project_workspaces" => field("projectId", "project_id")
            .map(|id| format!("project-workspaces-stream:{id}"))
            .ok_or_else(|| "projectId is required".to_string()),
        "execution_processes" => field("sessionId", "session_id")
            .map(|id| format!("execution-processes-stream:{id}"))
            .ok_or_else(|| "sessionId is required".to_string()),
        "diff" => {
            let id = field("workspaceId", "workspace_id")
                .ok_or_else(|| "workspaceId is required".to_string())?;
            let stats = args
                .get("statsOnly")
                .or_else(|| args.get("stats_only"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            Ok(if stats {
                format!("diff-stream:{id}:stats")
            } else {
                format!("diff-stream:{id}")
            })
        }
        "scratch" => field("scratchId", "scratch_id")
            .map(|id| format!("scratch-stream:{id}"))
            .ok_or_else(|| "scratchId is required".to_string()),
        "log" => field("processId", "process_id")
            .map(|id| format!("log-stream:{id}"))
            .ok_or_else(|| "processId is required".to_string()),
        "conversation" => {
            let process = field("executionProcessId", "execution_process_id")
                .ok_or_else(|| "executionProcessId is required".to_string())?;
            match field("streamId", "stream_id") {
                Some(stream_id) if !stream_id.is_empty() => {
                    Ok(format!("conversation-stream:{process}:{stream_id}"))
                }
                _ => Ok(format!("conversation-stream:{process}")),
            }
        }
        "slash_commands" => {
            let executor = args
                .get("executorProfileId")
                .or_else(|| args.get("executor_profile_id"))
                .and_then(|value| value.get("executor"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("none");
            let variant = args
                .get("executorProfileId")
                .or_else(|| args.get("executor_profile_id"))
                .and_then(|value| value.get("variant"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("default");
            let workspace = field("workspaceId", "workspace_id").unwrap_or_else(|| "none".into());
            let repo = field("repoId", "repo_id").unwrap_or_else(|| "none".into());
            Ok(format!(
                "slash-commands-stream:{executor}:{variant}:{workspace}:{repo}"
            ))
        }
        other => Err(format!("unknown patch stream `{other}`")),
    }
}

pub fn patch_stream_subscribe_command(stream: &str) -> Option<&'static str> {
    match stream {
        "projects" => Some("subscribe_projects_stream"),
        "project_workspaces" => Some("subscribe_project_workspaces_stream"),
        "execution_processes" => Some("subscribe_execution_processes_stream"),
        "diff" => Some("subscribe_diff_stream"),
        "file_tree" => Some("subscribe_file_tree_stream"),
        "scratch" => Some("subscribe_scratch_stream"),
        "slash_commands" => Some("subscribe_slash_commands_stream"),
        "log" => Some("subscribe_log_stream"),
        "conversation" => Some("subscribe_conversation_stream"),
        _ => None,
    }
}

/// Map a `patch_stream` resource name and args to the task key used in
/// `HostEventBus::stream_tasks`.
pub fn patch_stream_task_key(stream: &str, args: &serde_json::Value) -> Result<String, String> {
    if stream == "file_tree" {
        let root_path = args
            .get("rootPath")
            .or_else(|| args.get("root_path"))
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "rootPath is required".to_string())?;
        let canonical = std::fs::canonicalize(root_path)
            .map_err(|error| format!("Invalid file tree root '{root_path}': {error}"))?;
        return Ok(format!("file-tree:{}", canonical.to_string_lossy()));
    }
    patch_stream_channel(stream, args)
}

#[cfg(test)]
mod tests {
    use remote_protocol::EventDurability;

    use super::{
        HostEventBus, TerminalBridgeRegistry, patch_stream_channel, patch_stream_subscribe_command,
    };

    #[test]
    fn conversation_channel_is_allowed() {
        assert!(HostEventBus::channel_allowed("conversation-events"));
        assert!(HostEventBus::channel_allowed(
            "conversation-events:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        ));
        assert!(!HostEventBus::channel_allowed("desktop-toast"));
    }

    #[test]
    fn host_push_channels_are_allowed() {
        for channel in [
            "diff-stream:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "file-tree-stream",
            "projects-stream",
            "theme-changed",
            "dimo://collaboration-space-changed",
            "agent-management-snapshot-invalidated",
            "agent-events",
            "slash-commands-stream:codex:default:none:none",
            "terminal-output:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "terminal-exit:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "conversation-runtime-event:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "conversation-rate-limit:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "plugin-notify-toast",
        ] {
            assert!(
                HostEventBus::channel_allowed(channel),
                "{channel} must be forwarded"
            );
        }
    }

    #[test]
    fn durability_is_classified_from_the_catalog() {
        assert_eq!(
            HostEventBus::durability("conversation-events:abc"),
            Some(EventDurability::BestEffort)
        );
        assert_eq!(
            HostEventBus::durability("agent-events"),
            Some(EventDurability::BestEffort)
        );
        assert_eq!(
            HostEventBus::durability("workspace-sessions-changed"),
            Some(EventDurability::Invalidation)
        );
        assert_eq!(
            HostEventBus::durability("terminal-output:abc"),
            Some(EventDurability::BestEffort)
        );
        assert_eq!(
            HostEventBus::durability("agent-management-discovery-progress"),
            Some(EventDurability::BestEffort)
        );
        assert_eq!(
            HostEventBus::durability("theme-changed"),
            Some(EventDurability::Invalidation)
        );
    }

    #[test]
    fn buses_do_not_share_events_across_hosts() {
        let first = HostEventBus::new();
        let second = HostEventBus::new();
        let mut first_rx = first.subscribe();
        let mut second_rx = second.subscribe();
        first.emit("theme-changed", "host-a");
        second.emit("theme-changed", "host-b");
        let first_event = first_rx.try_recv().expect("host-a event");
        let second_event = second_rx.try_recv().expect("host-b event");
        assert_eq!(first_event.payload, serde_json::json!("host-a"));
        assert_eq!(second_event.payload, serde_json::json!("host-b"));
        assert!(first_rx.try_recv().is_err());
        assert!(second_rx.try_recv().is_err());
    }

    #[test]
    fn best_effort_attach_does_not_replay() {
        let bus = HostEventBus::new();
        bus.emit("logs://appended", "one");
        bus.emit(
            "conversation-events:00000000-0000-0000-0000-000000000001",
            serde_json::json!({ "kind": "rowOps", "ops": [{ "op": "append_text" }] }),
        );
        bus.emit("agent-events", serde_json::json!({ "type": "delta" }));
        bus.emit("logs://appended", "two");
        let bootstrap = bus
            .attach_bootstrap(remote_protocol::SubscriptionId::new(), "logs://appended", 0)
            .expect("attach");
        assert_eq!(bootstrap.durability, EventDurability::BestEffort);
        assert!(bootstrap.replay.is_empty());
        assert!(bootstrap.snapshot.is_none());
        assert!(bootstrap.high_water_mark >= 2);

        let conv_bootstrap = bus
            .attach_bootstrap(
                remote_protocol::SubscriptionId::new(),
                "conversation-events:00000000-0000-0000-0000-000000000001",
                0,
            )
            .expect("attach conversation-events");
        assert_eq!(conv_bootstrap.durability, EventDurability::BestEffort);
        assert!(conv_bootstrap.replay.is_empty());
        assert!(conv_bootstrap.snapshot.is_none());

        let agent_bootstrap = bus
            .attach_bootstrap(remote_protocol::SubscriptionId::new(), "agent-events", 0)
            .expect("attach agent-events");
        assert_eq!(agent_bootstrap.durability, EventDurability::BestEffort);
        assert!(agent_bootstrap.replay.is_empty());
        assert!(agent_bootstrap.snapshot.is_none());
    }

    #[test]
    fn invalidation_attach_returns_latest_snapshot_not_replay() {
        let bus = HostEventBus::new();
        bus.emit("theme-changed", "light");
        bus.emit("theme-changed", "dark");
        let bootstrap = bus
            .attach_bootstrap(remote_protocol::SubscriptionId::new(), "theme-changed", 0)
            .expect("attach");
        assert_eq!(bootstrap.durability, EventDurability::Invalidation);
        assert!(bootstrap.replay.is_empty());
        assert_eq!(
            bootstrap.snapshot.expect("snapshot").payload,
            serde_json::json!("dark")
        );
    }

    #[tokio::test]
    async fn terminal_output_bridge_emits_base64_on_the_host_bus() {
        let bus = std::sync::Arc::new(HostEventBus::new());
        let bridges = TerminalBridgeRegistry::new();
        let (tx, rx) = agents::TerminalOutputTx::pair();
        let session_id = uuid::Uuid::from_u128(0x1111_2222_3333_4444_5555_6666_7777_8888);
        let mut events = bus.subscribe();
        super::spawn_terminal_output_bridge(bus.clone(), &bridges, session_id, rx);
        super::spawn_terminal_output_bridge(
            bus.clone(),
            &bridges,
            session_id,
            agents::TerminalOutputTx::pair().1,
        );
        assert_eq!(bridges.subscriber_count(session_id), 2);
        tx.push(agents::TerminalOutputChunk {
            seq: 1,
            data: b"prompt>\n".to_vec(),
        });
        let channel = super::terminal_output_channel(session_id);
        let event = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let event = events.recv().await.expect("bus open");
                if event.channel == channel {
                    return event;
                }
            }
        })
        .await
        .expect("terminal output reached the Host Event Bus");
        assert_eq!(
            event.payload,
            serde_json::json!({
                "data": base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    b"prompt>\n"
                ),
                "seq": 1,
            })
        );
        bridges.release(session_id);
        assert_eq!(bridges.subscriber_count(session_id), 1);
        bridges.release(session_id);
        assert_eq!(bridges.subscriber_count(session_id), 0);
    }

    #[test]
    fn patch_stream_maps_to_the_producer_channel() {
        assert_eq!(
            patch_stream_channel("projects", &serde_json::json!({})).unwrap(),
            "projects-stream"
        );
        assert_eq!(
            patch_stream_channel("diff", &serde_json::json!({ "workspaceId": "ws-1" })).unwrap(),
            "diff-stream:ws-1"
        );
        assert_eq!(
            patch_stream_channel(
                "diff",
                &serde_json::json!({ "workspaceId": "ws-1", "statsOnly": true })
            )
            .unwrap(),
            "diff-stream:ws-1:stats"
        );
        assert_eq!(
            patch_stream_channel(
                "slash_commands",
                &serde_json::json!({
                    "executorProfileId": { "executor": "codex", "variant": "default" },
                    "workspaceId": "ws",
                    "repoId": "repo"
                })
            )
            .unwrap(),
            "slash-commands-stream:codex:default:ws:repo"
        );
        assert_eq!(
            patch_stream_subscribe_command("file_tree"),
            Some("subscribe_file_tree_stream")
        );
        assert!(patch_stream_channel("unknown", &serde_json::json!({})).is_err());
    }

    #[tokio::test]
    async fn patch_streams_do_not_poison_bootstrap_snapshot_and_replace_stream_task_aborts_previous()
     {
        let bus = HostEventBus::new();
        bus.emit(
            "projects-stream",
            serde_json::json!({ "JsonPatch": [{ "op": "replace", "path": "", "value": {} }] }),
        );
        bus.emit("projects-stream", serde_json::json!({ "Ready": null }));
        let bootstrap = bus
            .attach_bootstrap(remote_protocol::SubscriptionId::new(), "projects-stream", 0)
            .expect("attach projects-stream");
        assert_eq!(bootstrap.durability, EventDurability::BestEffort);
        assert!(bootstrap.snapshot.is_none());

        let (tx1, rx1) = tokio::sync::oneshot::channel::<()>();
        let handle1 = tokio::spawn(async move {
            let _ = rx1.await;
        });
        bus.replace_stream_task("projects-stream", handle1);
        let handle2 = tokio::spawn(async {});
        bus.replace_stream_task("projects-stream", handle2);
        tokio::task::yield_now().await;
        assert!(tx1.is_closed());
    }

    #[tokio::test]
    async fn stream_task_refcounting_aborts_only_when_last_subscriber_releases() {
        let bus = HostEventBus::new();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let handle = tokio::spawn(async move {
            let _ = rx.await;
        });
        bus.replace_stream_task("diff-stream:ws-1", handle);
        bus.retain_stream_task("diff-stream:ws-1");
        bus.retain_stream_task("diff-stream:ws-1");

        // First release keeps the producer task alive for the second subscriber.
        bus.release_stream_task("diff-stream:ws-1");
        tokio::task::yield_now().await;
        assert!(!tx.is_closed());

        // Final release aborts and removes the producer task.
        bus.release_stream_task("diff-stream:ws-1");
        tokio::task::yield_now().await;
        assert!(tx.is_closed());

        // Unretained direct RPC task is unaffected by release calls on unknown keys.
        let (rpc_tx, rpc_rx) = tokio::sync::oneshot::channel::<()>();
        bus.replace_stream_task(
            "projects-stream",
            tokio::spawn(async move {
                let _ = rpc_rx.await;
            }),
        );
        bus.release_stream_task("projects-stream");
        tokio::task::yield_now().await;
        assert!(!rpc_tx.is_closed());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn stream_task_release_and_retain_are_atomic_under_contention() {
        let bus = std::sync::Arc::new(HostEventBus::new());
        let key = "diff-stream:ws-race";
        let alive_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        for _ in 0..200 {
            let bus_a = bus.clone();
            let bus_b = bus.clone();
            let alive_a = alive_count.clone();
            let alive_b = alive_count.clone();

            bus.retain_stream_task(key);
            bus.ensure_stream_task(key, || {
                let alive = alive_a.clone();
                alive.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::spawn(async move {
                    struct Guard(std::sync::Arc<std::sync::atomic::AtomicUsize>);
                    impl Drop for Guard {
                        fn drop(&mut self) {
                            self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                        }
                    }
                    let _guard = Guard(alive);
                    std::future::pending::<()>().await;
                })
            });

            let releaser = tokio::spawn(async move {
                bus_a.release_stream_task(key);
            });
            let subscriber = tokio::spawn(async move {
                bus_b.retain_stream_task(key);
                bus_b.ensure_stream_task(key, || {
                    let alive = alive_b.clone();
                    alive.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    tokio::spawn(async move {
                        struct Guard(std::sync::Arc<std::sync::atomic::AtomicUsize>);
                        impl Drop for Guard {
                            fn drop(&mut self) {
                                self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                            }
                        }
                        let _guard = Guard(alive);
                        std::future::pending::<()>().await;
                    })
                });
            });

            let _ = tokio::join!(releaser, subscriber);
            tokio::task::yield_now().await;

            // Exactly one subscriber remains retained, so a live task must still be registered.
            let state = bus.stream_state.lock().expect("lock stream state");
            assert_eq!(state.refs.get(key).copied(), Some(1));
            let handle = state
                .tasks
                .get(key)
                .expect("retained subscriber must still have an active task");
            assert!(!handle.is_finished());
            drop(state);

            // Clean up for next iteration.
            bus.release_stream_task(key);
            tokio::task::yield_now().await;
        }
    }
}
