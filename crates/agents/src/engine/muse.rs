//! Native Rust MSP JSON-RPC 2.0 client (`MuseServer`) and `MuseNativeDriver` for `muse serve`.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock, RwLock,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use command_group::AsyncGroupChild;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader},
    sync::{Mutex as AsyncMutex, broadcast, oneshot},
    time::timeout,
};
use uuid::Uuid;
use workspace_utils::process::{
    ProcessTreeJob, group_spawn_no_window_with_job, new_hidden_tokio_command,
};

use crate::{
    conversation::ContentBlock,
    engine::{
        EngineAuth, EngineCacheStatus, EngineCapabilities, EngineCheckpoint, EngineError,
        EngineEvent, EngineEventStream, EngineHandle, EngineModelInfo, EnginePermissionDecision,
        EnginePromptRequest, EngineRateLimits, EngineStartSpec, EngineSteerReceipt,
        EngineSteerRequest, EngineToolClassification, NativeEngineDriver, NativeEngineKind,
        PromptMode, TurnEventRouter, TurnRouteFilter,
        descriptor::normalize_agent_token,
        format_bounded_diagnostic, is_placeholder_engine_session_id,
        muse_protocol::{
            MuseNotificationTracker, build_muse_user_input_answers, is_muse_full_access,
            mint_uuid_v7, muse_approval_mode, muse_canonical_path, muse_capabilities,
            muse_classify_tool_call, muse_normalize_mode, muse_permission_profile,
            muse_workspace_root, normalize_muse_notification, parse_muse_models_response,
            pick_muse_approval_choice_id, prepare_muse_launch_env, resolve_muse_auth,
            resolve_muse_default_mode, resolve_muse_default_model, serialize_muse_input_items,
            serialize_muse_session_mcp, str_any,
        },
        prepare_instance_isolation_env,
        server_pool::{PooledWorkspaceServer, ServerHandleLease, WorkspaceServerPool},
        stream_router::spawn_stderr_tail_reader,
    },
    stderr_tail::StderrTail,
};

const MUSE_RPC_TIMEOUT_MS: u64 = 30_000;
const EVENT_CHANNEL_CAPACITY: usize = 512;

pub use super::muse_protocol::MuseServerCacheKey;

/// Evicts all pooled `MuseServer` instances so subsequent session launches pick up
/// modified `settings.json`, `auth.json`, or `trust.json`, shutting down idle servers.
pub async fn invalidate_muse_servers() -> usize {
    global_muse_servers().invalidate_all().await
}

type PendingRpcEntry = (oneshot::Sender<Result<Value, EngineError>>, u64);
type PendingRpcMap = HashMap<u64, PendingRpcEntry>;

const MAX_LOADED_SESSIONS: usize = 512;

#[derive(Default)]
struct LoadedSessionCache {
    set: HashSet<String>,
    order: VecDeque<String>,
}

impl LoadedSessionCache {
    fn insert(&mut self, session_id: &str) {
        if self.set.insert(session_id.to_string()) {
            self.order.push_back(session_id.to_string());
            while self.order.len() > MAX_LOADED_SESSIONS {
                if let Some(oldest) = self.order.pop_front() {
                    self.set.remove(&oldest);
                }
            }
        }
    }

    fn contains(&self, session_id: &str) -> bool {
        self.set.contains(session_id)
    }
}

#[derive(Debug, Clone, Default)]
struct MuseHandshakeInfo {
    muse_home: Option<String>,
    granted_capabilities: HashSet<String>,
}

/// Long-lived per-(workspace, instance, auth, config, sandbox) MSP JSON-RPC 2.0
/// client connected to `muse serve`.
pub struct MuseServer {
    workspace_id: Uuid,
    disable_sandbox: bool,
    writer: Arc<AsyncMutex<Box<dyn AsyncWrite + Unpin + Send>>>,
    child: AsyncMutex<Option<AsyncGroupChild>>,
    process_job: Mutex<Option<ProcessTreeJob>>,
    stderr_tail: Arc<StderrTail>,
    next_request_id: AtomicU64,
    pending: Arc<Mutex<PendingRpcMap>>,
    tracker: Arc<Mutex<MuseNotificationTracker>>,
    loaded_sessions: Mutex<LoadedSessionCache>,
    session_models: RwLock<HashMap<String, String>>,
    handshake_info: RwLock<MuseHandshakeInfo>,
    turn_router: TurnEventRouter,
    event_tx: broadcast::Sender<EngineEvent>,
    latest_rate_limits: Arc<RwLock<Option<EngineRateLimits>>>,
    alive: Arc<AtomicBool>,
    active_handles: AtomicUsize,
}

impl std::fmt::Debug for MuseServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MuseServer")
            .field("workspace_id", &self.workspace_id)
            .field("disable_sandbox", &self.disable_sandbox)
            .field("alive", &self.is_alive())
            .finish()
    }
}

impl Drop for MuseServer {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        if let Ok(mut guard) = self.process_job.lock()
            && let Some(job) = guard.take()
        {
            let _ = job.terminate();
        }
    }
}

#[async_trait]
impl PooledWorkspaceServer for MuseServer {
    fn is_alive(&self) -> bool {
        MuseServer::is_alive(self)
    }

    fn acquire_handle(&self) -> usize {
        self.active_handles.fetch_add(1, Ordering::AcqRel) + 1
    }

    fn release_handle(&self) -> usize {
        self.active_handles
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                Some(n.saturating_sub(1))
            })
            .map(|prev| prev.saturating_sub(1))
            .unwrap_or(0)
    }

    fn active_handles(&self) -> usize {
        self.active_handles.load(Ordering::Acquire)
    }

    async fn shutdown_server(&self) {
        let _ = self.shutdown().await;
    }
}

fn global_muse_servers() -> &'static WorkspaceServerPool<MuseServerCacheKey, MuseServer> {
    static SERVERS: OnceLock<WorkspaceServerPool<MuseServerCacheKey, MuseServer>> = OnceLock::new();
    SERVERS.get_or_init(WorkspaceServerPool::new)
}

impl MuseServer {
    pub async fn spawn_for_workspace(
        spec: &EngineStartSpec,
        disable_sandbox: bool,
    ) -> Result<Arc<Self>, EngineError> {
        let muse_path = resolve_muse_binary(spec).await?;
        let isolation_env = prepare_instance_isolation_env(spec, NativeEngineKind::MuseNative)?;
        let cwd = muse_canonical_path(&spec.working_dir);

        let mut args: Vec<&str> = vec!["serve", "--trust-workspace"];
        if disable_sandbox {
            args.push("--disable-sandbox");
        }

        let mut cmd = new_hidden_tokio_command(&muse_path, args);
        cmd.current_dir(&cwd);
        cmd.env("MUSE_NO_AUTO_UPDATE", "1");

        // Scrub parent credentials requested by launch policy (always scrub inherited META_API_KEY
        // unless explicitly provided in spec.env / spec.auth).
        let explicit_api_key = spec
            .env
            .get("META_API_KEY")
            .map(String::as_str)
            .map(str::trim)
            .is_some_and(|s| !s.is_empty())
            || matches!(spec.auth, EngineAuth::ApiKey { .. });
        if !explicit_api_key {
            cmd.env_remove("META_API_KEY");
        }
        for key in &spec.scrubbed_env_keys {
            if !spec.env.contains_key(key) {
                cmd.env_remove(key);
            }
        }
        for (k, v) in &isolation_env {
            cmd.env(k, v);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }

        if let EngineAuth::ApiKey { api_key, base_url } = &spec.auth {
            cmd.env("META_API_KEY", api_key);
            if let Some(url) = base_url {
                cmd.env("META_API_BASE_URL", url);
            }
        }

        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let (mut child, job) = group_spawn_no_window_with_job(&mut cmd).map_err(|e| {
            EngineError::Transport(format_bounded_diagnostic(
                &format!("spawn {}: {e}", muse_path.display()),
                None,
                None,
            ))
        })?;

        let stdin = child
            .inner()
            .stdin
            .take()
            .ok_or_else(|| EngineError::Transport("muse stdin unavailable".into()))?;
        let stdout = child
            .inner()
            .stdout
            .take()
            .ok_or_else(|| EngineError::Transport("muse stdout unavailable".into()))?;

        let stderr_tail = Arc::new(StderrTail::new());
        if let Some(stderr) = child.inner().stderr.take() {
            spawn_stderr_tail_reader(stderr, Arc::clone(&stderr_tail), "muse");
        }

        let server = Self::connect_over_io_with_stderr(
            spec.workspace_id,
            disable_sandbox,
            stdout,
            stdin,
            Some(child),
            Some(job),
            stderr_tail,
        );
        if let Err(err) = server.handshake().await {
            let _ = server.shutdown().await;
            return Err(err);
        }
        Ok(server)
    }

    pub fn connect_over_io_with_stderr<R, W>(
        workspace_id: Uuid,
        disable_sandbox: bool,
        reader: R,
        writer: W,
        child: Option<AsyncGroupChild>,
        process_job: Option<ProcessTreeJob>,
        stderr_tail: Arc<StderrTail>,
    ) -> Arc<Self>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (event_tx, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let writer_arc: Arc<AsyncMutex<Box<dyn AsyncWrite + Unpin + Send>>> =
            Arc::new(AsyncMutex::new(Box::new(writer)));
        let turn_router = TurnEventRouter::new();
        let server = Arc::new(Self {
            workspace_id,
            disable_sandbox,
            writer: Arc::clone(&writer_arc),
            child: AsyncMutex::new(child),
            process_job: Mutex::new(process_job),
            stderr_tail: Arc::clone(&stderr_tail),
            next_request_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            tracker: Arc::new(Mutex::new(MuseNotificationTracker::default())),
            loaded_sessions: Mutex::new(LoadedSessionCache::default()),
            session_models: RwLock::new(HashMap::new()),
            handshake_info: RwLock::new(MuseHandshakeInfo::default()),
            turn_router: turn_router.clone(),
            event_tx: event_tx.clone(),
            latest_rate_limits: Arc::new(RwLock::new(None)),
            alive: Arc::new(AtomicBool::new(true)),
            active_handles: AtomicUsize::new(0),
        });

        let auto_approve_server = Arc::downgrade(&server);
        tokio::spawn(run_reader_loop(
            reader,
            writer_arc,
            Arc::clone(&server.pending),
            Arc::clone(&server.tracker),
            turn_router,
            event_tx,
            stderr_tail,
            Arc::clone(&server.latest_rate_limits),
            Arc::clone(&server.alive),
            auto_approve_server,
        ));
        server
    }

    pub async fn handshake(&self) -> Result<Value, EngineError> {
        let init_params = json!({
            "clientInfo": {
                "name": "dimo",
                "title": "Dimo",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "capabilities": {
                "requestedCapabilities": ["sessionMcp"],
            },
        });
        let init_result = self.request("initialize", init_params).await?;

        let schema_version = init_result
            .get("schema")
            .and_then(|s| s.get("version"))
            .and_then(Value::as_i64);
        if let Some(version) = schema_version
            && version != 1
        {
            return Err(EngineError::Transport(format!(
                "Muse returned unsupported MSP protocol schema version `{version}`"
            )));
        }

        let granted: HashSet<String> = init_result
            .get("grantedCapabilities")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        let muse_home = str_any(&init_result, &["museHome"]);
        if let Ok(mut guard) = self.handshake_info.write() {
            guard.muse_home = muse_home;
            guard.granted_capabilities = granted;
        }

        self.notify("initialized", Value::Null).await?;
        Ok(init_result)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub fn disable_sandbox(&self) -> bool {
        self.disable_sandbox
    }

    pub fn supports_session_mcp(&self) -> bool {
        self.handshake_info
            .read()
            .ok()
            .is_some_and(|info| info.granted_capabilities.contains("sessionMcp"))
    }

    pub fn muse_home(&self) -> Option<String> {
        self.handshake_info
            .read()
            .ok()
            .and_then(|info| info.muse_home.clone())
    }

    pub fn stderr_tail(&self) -> &Arc<StderrTail> {
        &self.stderr_tail
    }

    pub fn turn_router(&self) -> &TurnEventRouter {
        &self.turn_router
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<EngineEvent> {
        self.event_tx.subscribe()
    }

    pub fn latest_rate_limits(&self) -> Option<EngineRateLimits> {
        self.latest_rate_limits.read().ok().and_then(|g| g.clone())
    }

    pub fn mark_session_loaded(&self, session_id: &str) {
        if !is_placeholder_engine_session_id(session_id)
            && let Ok(mut guard) = self.loaded_sessions.lock()
        {
            guard.insert(session_id);
        }
    }

    pub fn is_session_loaded(&self, session_id: &str) -> bool {
        self.loaded_sessions
            .lock()
            .ok()
            .is_some_and(|guard| guard.contains(session_id))
    }

    pub fn set_session_full_access(&self, session_id: &str, full_access: bool) {
        if let Ok(mut state) = self.tracker.lock() {
            if full_access {
                state.full_access_sessions.insert(session_id.to_string());
            } else {
                state.full_access_sessions.remove(session_id);
            }
        }
    }

    pub fn mark_session_compacting(&self, session_id: &str, active: bool) {
        if let Ok(mut state) = self.tracker.lock() {
            if active {
                state.active_compact_sessions.insert(session_id.to_string());
            } else {
                state.active_compact_sessions.remove(session_id);
            }
        }
    }

    pub fn cleanup_session(&self, session_id: &str) {
        if let Ok(mut state) = self.tracker.lock() {
            state.clear_session(session_id);
        }
        if let Ok(mut models) = self.session_models.write() {
            models.remove(session_id);
        }
    }

    #[cfg(test)]
    pub(crate) fn tracker_counts_for_test(&self) -> (usize, usize) {
        self.tracker
            .lock()
            .map(|state| (state.tracked_item_count(), state.full_access_sessions.len()))
            .unwrap_or((0, 0))
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, EngineError> {
        let mark = self.stderr_tail.mark();
        if !self.is_alive() {
            return Err(EngineError::Transport(format_bounded_diagnostic(
                "muse serve process closed",
                Some(&self.stderr_tail),
                Some(mark),
            )));
        }
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id, (tx, mark));
        }

        let payload = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(err) = self.write_line(&payload).await {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(err);
        }

        match timeout(Duration::from_millis(MUSE_RPC_TIMEOUT_MS), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(EngineError::Transport(format_bounded_diagnostic(
                &format!("muse serve closed before replying to `{method}`"),
                Some(&self.stderr_tail),
                Some(mark),
            ))),
            Err(_) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                Err(EngineError::Timeout {
                    method: method.to_string(),
                    timeout_ms: MUSE_RPC_TIMEOUT_MS,
                })
            }
        }
    }

    /// Sends a mutating MSP command RPC with an idempotent UUIDv7 `commandId`.
    pub async fn command(
        &self,
        method: &str,
        mut params: Value,
        command_id: Option<String>,
    ) -> Result<Value, EngineError> {
        let cid = command_id.unwrap_or_else(mint_uuid_v7);
        if let Some(obj) = params.as_object_mut() {
            obj.entry("commandId".to_string())
                .or_insert_with(|| json!(cid));
        }
        self.request(method, params).await
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), EngineError> {
        let payload = if params.is_null() {
            json!({ "jsonrpc": "2.0", "method": method })
        } else {
            json!({ "jsonrpc": "2.0", "method": method, "params": params })
        };
        self.write_line(&payload).await
    }

    pub(crate) fn publish_event(&self, event: EngineEvent) {
        self.turn_router.publish(&event);
        let _ = self.event_tx.send(event);
    }

    async fn write_line(&self, message: &Value) -> Result<(), EngineError> {
        super::write_jsonrpc_frame(&self.writer, message).await
    }

    pub async fn ensure_session(
        &self,
        existing_session_id: Option<&str>,
        model: Option<&str>,
        working_dir: &Path,
        mcp_servers: Option<&Value>,
        permission_mode: Option<&str>,
    ) -> Result<(String, Option<EngineEvent>), EngineError> {
        let approval_mode = muse_approval_mode(permission_mode);
        let permission_profile = muse_permission_profile(permission_mode);
        let full_access = is_muse_full_access(permission_mode);
        let config_obj = if self.supports_session_mcp() {
            mcp_servers.and_then(serialize_muse_session_mcp)
        } else {
            None
        };

        if let Some(id) = existing_session_id
            .map(str::trim)
            .filter(|s| !is_placeholder_engine_session_id(s))
        {
            self.set_session_full_access(id, full_access);
            if self.is_session_loaded(id) {
                return Ok((id.to_string(), None));
            }

            let mut resume_params = json!({
                "sessionId": id,
                "excludeItems": true,
                "permissionProfile": permission_profile,
            });
            if let Some(cfg) = config_obj {
                resume_params["config"] = cfg;
            }
            let result = match self.command("session/resume", resume_params, None).await {
                Ok(result) => result,
                Err(error) => {
                    self.cleanup_session(id);
                    return Err(error);
                }
            };
            if result
                .get("history")
                .and_then(|h| h.get("noneReason"))
                .and_then(Value::as_str)
                == Some("projectionUnavailable")
            {
                self.cleanup_session(id);
                return Err(EngineError::Transport(format!(
                    "Muse session `{id}` history projection is unavailable; start a new session"
                )));
            }
            let resumed_model = result
                .get("session")
                .and_then(|s| s.get("modelId"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| model.map(str::to_string));

            let _ = self
                .command(
                    "session/setApprovalMode",
                    json!({ "sessionId": id, "mode": approval_mode }),
                    None,
                )
                .await;

            self.mark_session_loaded(id);
            if let Some(ref m) = resumed_model
                && let Ok(mut guard) = self.session_models.write()
            {
                guard.insert(id.to_string(), m.clone());
            }
            let init_ev = EngineEvent::SessionInitialized {
                session_id: Some(id.to_string()),
                model: resumed_model,
                slash_commands: vec!["compact".to_string()],
            };
            return Ok((id.to_string(), Some(init_ev)));
        }

        let new_session_id = mint_uuid_v7();
        self.set_session_full_access(&new_session_id, full_access);
        let canonical_cwd = muse_canonical_path(working_dir);
        let mut start_params = json!({
            "sessionId": new_session_id,
            "workspaceRoot": canonical_cwd.to_string_lossy(),
            "providerId": "meta",
            "approvalMode": approval_mode,
            "permissionProfile": permission_profile,
        });
        if let Some(m) = model.map(str::trim).filter(|s| !s.is_empty()) {
            start_params["modelId"] = json!(m);
        }
        if let Some(cfg) = config_obj {
            start_params["config"] = cfg;
        }
        let result = match self.command("session/start", start_params, None).await {
            Ok(res) => res,
            Err(err) => {
                self.cleanup_session(&new_session_id);
                return Err(err);
            }
        };
        let returned_session_id = result
            .get("session")
            .and_then(|s| s.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let session_id = match returned_session_id {
            Some(returned) => {
                if returned != new_session_id {
                    self.cleanup_session(&new_session_id);
                }
                returned
            }
            None => new_session_id,
        };
        self.set_session_full_access(&session_id, full_access);

        let started_model = result
            .get("session")
            .and_then(|s| s.get("modelId"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| model.map(str::to_string));

        self.mark_session_loaded(&session_id);
        if let Some(ref m) = started_model
            && let Ok(mut guard) = self.session_models.write()
        {
            guard.insert(session_id.clone(), m.clone());
        }

        let init_ev = EngineEvent::SessionInitialized {
            session_id: Some(session_id.clone()),
            model: started_model,
            slash_commands: vec!["compact".to_string()],
        };
        Ok((session_id, Some(init_ev)))
    }

    pub async fn maybe_switch_model(
        &self,
        session_id: &str,
        target_model: Option<&str>,
    ) -> Result<(), EngineError> {
        let Some(target) = target_model.map(str::trim).filter(|s| !s.is_empty()) else {
            return Ok(());
        };
        let current = self
            .session_models
            .read()
            .ok()
            .and_then(|m| m.get(session_id).cloned());
        if current.as_deref() == Some(target) {
            return Ok(());
        }
        self.command(
            "session/setModel",
            json!({
                "sessionId": session_id,
                "model": { "modelId": target, "providerId": "meta" },
            }),
            None,
        )
        .await?;
        if let Ok(mut guard) = self.session_models.write() {
            guard.insert(session_id.to_string(), target.to_string());
        }
        Ok(())
    }

    pub async fn set_approval_mode(
        &self,
        session_id: &str,
        permission_mode: &str,
    ) -> Result<(), EngineError> {
        let mode = muse_approval_mode(Some(permission_mode));
        self.set_session_full_access(session_id, is_muse_full_access(Some(permission_mode)));
        let _ = self
            .command(
                "session/setApprovalMode",
                json!({ "sessionId": session_id, "mode": mode }),
                None,
            )
            .await?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn start_turn(
        &self,
        session_id: &str,
        blocks: &[ContentBlock],
        effort: Option<&str>,
        working_dir: &Path,
        additional_directories: &[PathBuf],
        mode: PromptMode,
        command_id: Option<String>,
    ) -> Result<Value, EngineError> {
        if mode == PromptMode::Compact {
            let result = self
                .command(
                    "session/compact",
                    json!({ "sessionId": session_id }),
                    command_id,
                )
                .await?;
            return Ok(result);
        }

        let (input, display_text) = serialize_muse_input_items(blocks, mode);
        let mut workspace_roots = vec![muse_workspace_root(working_dir)];
        for extra in additional_directories {
            let root = muse_workspace_root(extra);
            if !workspace_roots.contains(&root) {
                workspace_roots.push(root);
            }
        }
        let turn_command_id = command_id.unwrap_or_else(mint_uuid_v7);
        let mut params = json!({
            "sessionId": session_id,
            "input": input,
            "displayText": display_text,
            "workspaceRoots": workspace_roots,
            "ifBusy": "queue",
        });
        if let Some(eff) = effort.map(str::trim).filter(|s| !s.is_empty()) {
            params["reasoningEffort"] = json!(eff);
        }
        self.command("turn/start", params, Some(turn_command_id))
            .await
    }

    pub async fn steer_turn(
        &self,
        session_id: &str,
        expected_turn_id: Option<&str>,
        blocks: &[ContentBlock],
    ) -> Result<EngineSteerReceipt, EngineError> {
        let Some(turn_id) = expected_turn_id.filter(|s| !s.trim().is_empty()) else {
            return Ok(EngineSteerReceipt::Rejected {
                code: "no_active_turn".to_string(),
                message: "Muse requires an active turnId to steer".to_string(),
            });
        };
        let (input, _) = serialize_muse_input_items(blocks, PromptMode::Steer);
        let params = json!({
            "sessionId": session_id,
            "expectedTurnId": turn_id,
            "input": input,
        });
        match self.command("turn/steer", params, None).await {
            Ok(result) => Ok(EngineSteerReceipt::Accepted {
                prompt_id: str_any(&result, &["turnId"]).or_else(|| Some(turn_id.to_string())),
                session_id: Some(session_id.to_string()),
                delivery_mode: "native".to_string(),
            }),
            Err(EngineError::Rpc { code, message }) => Ok(EngineSteerReceipt::Rejected {
                code: format!("rpc_{code}"),
                message,
            }),
            Err(other) => Err(other),
        }
    }

    pub async fn interrupt_turn(
        &self,
        session_id: &str,
        turn_id: Option<&str>,
    ) -> Result<(), EngineError> {
        let Some(tid) = turn_id.filter(|s| !s.trim().is_empty()) else {
            return Ok(());
        };
        let _ = self
            .command(
                "turn/interrupt",
                json!({ "sessionId": session_id, "turnId": tid }),
                None,
            )
            .await?;
        Ok(())
    }

    pub async fn decide_approval(
        &self,
        decision: &EnginePermissionDecision,
    ) -> Result<(), EngineError> {
        let pending = self
            .tracker
            .lock()
            .ok()
            .and_then(|s| s.pending_approvals.get(&decision.permission_id).cloned())
            .ok_or_else(|| {
                EngineError::InvalidRequest(format!(
                    "unknown or already-resolved Muse approval `{}`",
                    decision.permission_id
                ))
            })?;

        let (choice_id, behavior) =
            pick_muse_approval_choice_id(&pending, decision).ok_or_else(|| {
                EngineError::InvalidRequest(format!(
                    "Muse approval `{}` has no matching choice for decision",
                    decision.permission_id
                ))
            })?;

        self.command(
            "approval/decide",
            json!({
                "sessionId": pending.session_id,
                "approvalId": pending.approval_id,
                "requirementId": pending.requirement_id,
                "choiceId": choice_id,
            }),
            None,
        )
        .await?;

        if let Ok(mut state) = self.tracker.lock() {
            state.pending_approvals.remove(&decision.permission_id);
        }

        self.publish_event(EngineEvent::PermissionResolved {
            permission_id: pending.approval_id,
            prompt_id: pending.turn_id,
            session_id: Some(pending.session_id),
            behavior,
        });
        Ok(())
    }

    pub async fn answer_user_input(
        &self,
        request_id: &str,
        answers: &Value,
        cancelled: bool,
    ) -> Result<(), EngineError> {
        let pending = self
            .tracker
            .lock()
            .ok()
            .and_then(|s| s.pending_user_inputs.get(request_id).cloned())
            .ok_or_else(|| {
                EngineError::InvalidRequest(format!(
                    "unknown or already-resolved Muse userInput request `{request_id}`"
                ))
            })?;

        let encoded = build_muse_user_input_answers(&pending, answers, cancelled);
        self.command(
            "userInput/answer",
            json!({
                "sessionId": pending.session_id,
                "userInputId": pending.user_input_id,
                "answers": encoded,
            }),
            None,
        )
        .await?;

        if let Ok(mut state) = self.tracker.lock() {
            state.pending_user_inputs.remove(request_id);
        }
        Ok(())
    }

    pub async fn list_models(&self) -> Vec<EngineModelInfo> {
        if let Ok(Ok(result)) = timeout(
            Duration::from_secs(5),
            self.request("model/list", json!({})),
        )
        .await
        {
            return parse_muse_models_response(&result);
        }
        Vec::new()
    }

    pub async fn shutdown(&self) -> Result<(), EngineError> {
        self.alive.store(false, Ordering::Release);
        if let Ok(mut guard) = self.process_job.lock()
            && let Some(job) = guard.take()
        {
            let _ = job.terminate();
        }
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
        }
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_reader_loop<R>(
    reader: R,
    writer: Arc<AsyncMutex<Box<dyn AsyncWrite + Unpin + Send>>>,
    pending: Arc<Mutex<PendingRpcMap>>,
    tracker: Arc<Mutex<MuseNotificationTracker>>,
    turn_router: TurnEventRouter,
    event_tx: broadcast::Sender<EngineEvent>,
    stderr_tail: Arc<StderrTail>,
    latest_rate_limits: Arc<RwLock<Option<EngineRateLimits>>>,
    alive: Arc<AtomicBool>,
    server_for_auto_approve: std::sync::Weak<MuseServer>,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        let raw_id = msg.get("id").filter(|v| !v.is_null()).cloned();
        let method = msg.get("method").and_then(Value::as_str);

        // JSON-RPC response to our outgoing request
        if let Some(ref id_val) = raw_id
            && method.is_none()
        {
            let numeric_id = id_val
                .as_u64()
                .or_else(|| id_val.as_str().and_then(|s| s.parse::<u64>().ok()));
            if let Some(id) = numeric_id
                && let Some((tx, mark)) = pending.lock().ok().and_then(|mut map| map.remove(&id))
            {
                let outcome = if let Some(err_val) = msg.get("error").filter(|v| !v.is_null()) {
                    let code = err_val
                        .get("code")
                        .and_then(Value::as_i64)
                        .unwrap_or(-32000);
                    let raw_msg = str_any(err_val, &["message"])
                        .or_else(|| err_val.as_str().map(str::to_string))
                        .unwrap_or_else(|| "Muse JSON-RPC error".to_string());
                    Err(EngineError::Rpc {
                        code,
                        message: format_bounded_diagnostic(
                            &raw_msg,
                            Some(&stderr_tail),
                            Some(mark),
                        ),
                    })
                } else {
                    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = tx.send(outcome);
            }
            continue;
        }

        // Server-initiated request: acknowledge approval/request & userInput/request with `{}`
        if let (Some(id_val), Some(method_name)) = (raw_id, method) {
            let reply = if method_name == "approval/request" || method_name == "userInput/request" {
                json!({ "jsonrpc": "2.0", "id": id_val, "result": {} })
            } else {
                json!({
                    "jsonrpc": "2.0",
                    "id": id_val,
                    "error": {
                        "code": -32601,
                        "message": format!("Unsupported Muse server request `{method_name}`"),
                    }
                })
            };
            let _ = super::write_jsonrpc_frame(&writer, &reply).await;
            continue;
        }

        // MSP notification
        if let Some(method_name) = method {
            let params = msg.get("params").unwrap_or(&Value::Null);
            let (events, auto_approves) =
                normalize_muse_notification(method_name, params, &tracker, &latest_rate_limits);
            for ev in events {
                turn_router.publish(&ev);
                let _ = event_tx.send(ev);
            }
            for action in auto_approves {
                if let Some(srv) = server_for_auto_approve.upgrade() {
                    tokio::spawn(async move {
                        let _ = srv
                            .command(
                                "approval/decide",
                                json!({
                                    "sessionId": action.session_id,
                                    "approvalId": action.approval_id,
                                    "requirementId": action.requirement_id,
                                    "choiceId": action.choice_id,
                                }),
                                None,
                            )
                            .await;
                    });
                }
            }
        }
    }

    alive.store(false, Ordering::Release);
    if let Ok(mut map) = pending.lock() {
        for (_, (tx, mark)) in map.drain() {
            let _ = tx.send(Err(EngineError::Transport(format_bounded_diagnostic(
                "muse serve exited",
                Some(&stderr_tail),
                Some(mark),
            ))));
        }
    }
    if let Ok(mut state) = tracker.lock() {
        state.clear_all();
    }
    turn_router.fail_active_turns("muse serve exited", &stderr_tail);
}

pub use super::muse_protocol::resolve_muse_binary;

struct MuseHandleContext {
    spec: EngineStartSpec,
    lease: ServerHandleLease<MuseServer>,
    active_prompt_id: RwLock<Option<Uuid>>,
    active_turn_id: RwLock<Option<String>>,
}

impl MuseHandleContext {
    fn server(&self) -> &Arc<MuseServer> {
        self.lease.server()
    }
}

/// `NativeEngineDriver` implementation backed by `MuseServer` (`muse serve`).
#[derive(Default)]
pub struct MuseNativeDriver {
    handles: RwLock<HashMap<Uuid, Arc<MuseHandleContext>>>,
}

impl MuseNativeDriver {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn connect_duplex<R, W>(
        spec: EngineStartSpec,
        reader: R,
        writer: W,
        stderr_tail: Option<Arc<StderrTail>>,
    ) -> Result<(Self, EngineHandle), EngineError>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let tail = stderr_tail.unwrap_or_else(|| Arc::new(StderrTail::new()));
        let disable_sandbox = spec
            .config_overrides
            .get("permissionMode")
            .and_then(Value::as_str)
            .is_some_and(|m| is_muse_full_access(Some(m)));
        let server = MuseServer::connect_over_io_with_stderr(
            spec.workspace_id,
            disable_sandbox,
            reader,
            writer,
            None,
            None,
            tail,
        );
        server.handshake().await?;
        let driver = Self::new();
        let handle = driver.bind_existing_server(spec, server, None);
        Ok((driver, handle))
    }

    pub fn bind_existing_server(
        &self,
        spec: EngineStartSpec,
        server: Arc<MuseServer>,
        initial_session_id: Option<String>,
    ) -> EngineHandle {
        self.bind_leased_server(spec, ServerHandleLease::acquire(server), initial_session_id)
    }

    fn bind_leased_server(
        &self,
        spec: EngineStartSpec,
        lease: ServerHandleLease<MuseServer>,
        initial_session_id: Option<String>,
    ) -> EngineHandle {
        let connection_id = Uuid::new_v4();
        let official = !spec.uses_custom_base_url(NativeEngineKind::MuseNative);
        let clean_initial = initial_session_id.filter(|s| !is_placeholder_engine_session_id(s));
        let handle = EngineHandle::new(
            connection_id,
            NativeEngineKind::MuseNative,
            spec.workspace_id,
            spec.working_dir.clone(),
            official,
            clean_initial,
        );
        let ctx = Arc::new(MuseHandleContext {
            spec,
            lease,
            active_prompt_id: RwLock::new(None),
            active_turn_id: RwLock::new(None),
        });
        if let Ok(mut map) = self.handles.write() {
            map.insert(connection_id, ctx);
        }
        handle
    }

    async fn ensure_server_for_handle(
        &self,
        handle: &EngineHandle,
        desired_disable_sandbox: Option<bool>,
    ) -> Result<(Arc<MuseHandleContext>, Arc<MuseServer>), EngineError> {
        let ctx = self
            .handles
            .read()
            .ok()
            .and_then(|map| map.get(&handle.connection_id).cloned())
            .ok_or(EngineError::UnknownHandle(handle.connection_id))?;

        let want_disable = desired_disable_sandbox.unwrap_or_else(|| ctx.server().disable_sandbox());
        if ctx.server().is_alive() && ctx.server().disable_sandbox() == want_disable {
            return Ok((Arc::clone(&ctx), Arc::clone(ctx.server())));
        }

        let reconnected = get_or_spawn_workspace_server(&ctx.spec, want_disable).await?;
        let reconnected_server = Arc::clone(reconnected.server());
        let preserved_prompt_id = ctx.active_prompt_id.read().ok().and_then(|g| *g);
        let preserved_turn_id = ctx.active_turn_id.read().ok().and_then(|g| g.clone());
        let updated_ctx = Arc::new(MuseHandleContext {
            spec: ctx.spec.clone(),
            lease: reconnected,
            active_prompt_id: RwLock::new(preserved_prompt_id),
            active_turn_id: RwLock::new(preserved_turn_id),
        });
        let previous = self.handles.write().ok().and_then(|mut map| {
            match map.entry(handle.connection_id) {
                std::collections::hash_map::Entry::Occupied(mut entry) => {
                    Some(entry.insert(Arc::clone(&updated_ctx)))
                }
                std::collections::hash_map::Entry::Vacant(_) => None,
            }
        });
        let Some(prev) = previous else {
            let new_key = MuseServerCacheKey::from_spec(&updated_ctx.spec, want_disable);
            global_muse_servers()
                .release_and_shutdown_if_unused(&new_key, &updated_ctx.lease)
                .await;
            return Err(EngineError::UnknownHandle(handle.connection_id));
        };
        if let Some(sid) = handle
            .external_session_id()
            .filter(|s| !is_placeholder_engine_session_id(s))
        {
            prev.server().cleanup_session(&sid);
        }
        let prev_key = MuseServerCacheKey::from_spec(&prev.spec, prev.server().disable_sandbox());
        global_muse_servers()
            .release_and_shutdown_if_unused(&prev_key, &prev.lease)
            .await;
        Ok((updated_ctx, reconnected_server))
    }
}

async fn get_or_spawn_workspace_server(
    spec: &EngineStartSpec,
    disable_sandbox: bool,
) -> Result<ServerHandleLease<MuseServer>, EngineError> {
    let key = MuseServerCacheKey::from_spec(spec, disable_sandbox);
    global_muse_servers()
        .get_or_spawn(key, || MuseServer::spawn_for_workspace(spec, disable_sandbox))
        .await
}

#[async_trait]
impl NativeEngineDriver for MuseNativeDriver {
    fn engine_id(&self) -> &str {
        NativeEngineKind::MuseNative.engine_id()
    }

    fn kind(&self) -> Option<NativeEngineKind> {
        Some(NativeEngineKind::MuseNative)
    }

    fn supports_agent(&self, agent_kind_or_id: &str) -> bool {
        matches!(
            normalize_agent_token(agent_kind_or_id).as_str(),
            "muse_code" | "musecode" | "muse" | "muse_native"
        )
    }

    fn capabilities(&self) -> EngineCapabilities {
        muse_capabilities(self.engine_id())
    }

    fn normalize_mode(&self, raw: &str) -> Option<String> {
        muse_normalize_mode(raw)
    }

    fn resolve_auth(&self, env: &HashMap<String, String>) -> EngineAuth {
        resolve_muse_auth(env)
    }

    fn prepare_launch_env(
        &self,
        locked_program: &Path,
        snapshot_env: &HashMap<String, String>,
        launch_env: &mut HashMap<String, String>,
        scrubbed_keys: &mut Vec<String>,
    ) {
        prepare_muse_launch_env(locked_program, snapshot_env, launch_env, scrubbed_keys);
    }

    fn profile_isolation_dir(&self) -> Option<(&'static str, &'static str)> {
        Some(("XDG_CONFIG_HOME", "muse-config"))
    }

    fn uses_custom_base_url(&self, spec: &EngineStartSpec) -> bool {
        spec.uses_custom_base_url(NativeEngineKind::MuseNative)
    }

    fn resolve_default_model(&self, env: &HashMap<String, String>) -> Option<String> {
        resolve_muse_default_model(env)
    }

    fn resolve_default_mode(&self, env: &HashMap<String, String>) -> Option<String> {
        resolve_muse_default_mode(env)
    }

    fn classify_tool_call(
        &self,
        raw_name: &str,
        input: &Value,
        parent_tool_use_id: Option<&str>,
    ) -> EngineToolClassification {
        muse_classify_tool_call(raw_name, input, parent_tool_use_id)
    }

    async fn invalidate_caches(&self) -> usize {
        invalidate_muse_servers().await
    }

    async fn start(&self, spec: EngineStartSpec) -> Result<EngineHandle, EngineError> {
        let default_mode = resolve_muse_default_mode(&spec.env);
        let initial_mode = spec
            .config_overrides
            .get("permissionMode")
            .and_then(Value::as_str)
            .or(default_mode.as_deref());
        let disable_sandbox = is_muse_full_access(initial_mode);
        let lease = get_or_spawn_workspace_server(&spec, disable_sandbox).await?;
        Ok(self.bind_leased_server(spec, lease, None))
    }

    async fn send_prompt(
        &self,
        handle: &EngineHandle,
        request: EnginePromptRequest,
    ) -> Result<EngineEventStream, EngineError> {
        let want_disable_sandbox = request
            .permission_mode
            .as_deref()
            .map(|m| is_muse_full_access(Some(m)));
        let (ctx, server) = self
            .ensure_server_for_handle(handle, want_disable_sandbox)
            .await?;

        let requested = request
            .session_id
            .clone()
            .or_else(|| handle.external_session_id());
        let effective_model = request.model.as_deref().or(ctx.spec.model.as_deref());
        let effective_mcp = request.mcp_servers.as_ref().or(Some(&ctx.spec.mcp_servers));
        let effective_dirs = if request.additional_directories.is_empty() {
            &ctx.spec.additional_directories
        } else {
            &request.additional_directories
        };

        let (session_id, session_init_event) = server
            .ensure_session(
                requested.as_deref(),
                effective_model,
                &ctx.spec.working_dir,
                effective_mcp,
                request.permission_mode.as_deref(),
            )
            .await?;
        handle.set_external_session_id(Some(session_id.clone()));

        server
            .maybe_switch_model(&session_id, effective_model)
            .await?;

        let turn_stream = server.turn_router().register_turn(
            TurnRouteFilter::MuseSession {
                session_id: session_id.clone(),
            },
            Arc::clone(server.stderr_tail()),
        );

        if let Some(init_ev) = session_init_event {
            server.publish_event(init_ev);
        }

        if let Ok(mut pid_guard) = ctx.active_prompt_id.write() {
            *pid_guard = Some(request.prompt_id);
        }
        let command_id = mint_uuid_v7();
        if let Ok(mut guard) = ctx.active_turn_id.write() {
            *guard = Some(command_id.clone());
        }
        let is_compact = request.mode == PromptMode::Compact;
        if is_compact {
            server.mark_session_compacting(&session_id, true);
        }
        let start_res = match server
            .start_turn(
                &session_id,
                &request.blocks,
                request.effort.as_deref(),
                &ctx.spec.working_dir,
                effective_dirs,
                request.mode,
                Some(command_id),
            )
            .await
        {
            Ok(res) => res,
            Err(err) => {
                if is_compact {
                    server.mark_session_compacting(&session_id, false);
                }
                return Err(err);
            }
        };
        if is_compact {
            let status = str_any(&start_res, &["status"]);
            if status.as_deref() != Some("accepted") {
                server.mark_session_compacting(&session_id, false);
                let message = match status.as_deref() {
                    Some("noop") => str_any(&start_res, &["reason"])
                        .unwrap_or_else(|| "Muse has no context to compact.".to_string()),
                    Some(other) => {
                        format!("Muse returned an unsupported compaction status: `{other}`")
                    }
                    None => str_any(&start_res, &["reason"])
                        .unwrap_or_else(|| "Muse declined compaction request.".to_string()),
                };
                server.publish_event(EngineEvent::TurnError {
                    prompt_id: Some(request.prompt_id.to_string()),
                    session_id: Some(session_id.clone()),
                    message,
                });
            }
        } else if let Some(turn_id) = str_any(&start_res, &["turnId"])
            && let Ok(mut guard) = ctx.active_turn_id.write()
        {
            *guard = Some(turn_id);
        }

        Ok(Box::pin(turn_stream))
    }

    async fn steer(
        &self,
        handle: &EngineHandle,
        request: EngineSteerRequest,
    ) -> Result<EngineSteerReceipt, EngineError> {
        let (ctx, server) = self.ensure_server_for_handle(handle, None).await?;
        let session_id = request
            .session_id
            .or_else(|| handle.external_session_id())
            .filter(|s| !is_placeholder_engine_session_id(s))
            .ok_or_else(|| {
                EngineError::InvalidRequest("cannot steer without active Muse sessionId".into())
            })?;

        let active_pid = ctx.active_prompt_id.read().ok().and_then(|g| *g);
        if let (Some(expected_pid), Some(current_pid)) = (request.expected_prompt_id, active_pid)
            && expected_pid != current_pid
        {
            return Ok(EngineSteerReceipt::Rejected {
                code: "turn_mismatch".to_string(),
                message: format!(
                    "expected prompt `{expected_pid}` does not match active prompt `{current_pid}`"
                ),
            });
        }

        let actual_turn_id = ctx.active_turn_id.read().ok().and_then(|g| g.clone());
        let receipt = server
            .steer_turn(&session_id, actual_turn_id.as_deref(), &request.blocks)
            .await?;
        if matches!(receipt, EngineSteerReceipt::Accepted { .. }) {
            server.publish_event(EngineEvent::PromptSteered {
                prompt_id: active_pid.map(|id| id.to_string()),
                session_id: Some(session_id),
            });
        }
        Ok(receipt)
    }

    async fn interrupt(&self, handle: &EngineHandle) -> Result<(), EngineError> {
        let (ctx, server) = self.ensure_server_for_handle(handle, None).await?;
        let Some(session_id) = handle
            .external_session_id()
            .filter(|s| !is_placeholder_engine_session_id(s))
        else {
            return Ok(());
        };
        let turn_id = ctx.active_turn_id.read().ok().and_then(|g| g.clone());
        server.interrupt_turn(&session_id, turn_id.as_deref()).await
    }

    async fn revert_to(
        &self,
        _handle: &EngineHandle,
        _checkpoint: EngineCheckpoint,
    ) -> Result<(), EngineError> {
        Err(EngineError::Unsupported(
            "Muse Code does not support native session rollback".to_string(),
        ))
    }

    async fn set_permission_mode(
        &self,
        handle: &EngineHandle,
        mode: &str,
    ) -> Result<(), EngineError> {
        let want_disable_sandbox = is_muse_full_access(Some(mode));
        let (_, server) = self
            .ensure_server_for_handle(handle, Some(want_disable_sandbox))
            .await?;
        if let Some(session_id) = handle
            .external_session_id()
            .filter(|s| !is_placeholder_engine_session_id(s))
        {
            server.set_session_full_access(&session_id, want_disable_sandbox);
            // Switching between sandboxed (`default`) and unsandboxed (`full-access`)
            // routes to a different `muse serve` process where `session_id` has not
            // been resumed yet; `ensure_session` will resume with the updated profile
            // and approval mode on the next prompt.
            if server.is_session_loaded(&session_id) {
                server.set_approval_mode(&session_id, mode).await?;
            }
        }
        Ok(())
    }

    async fn respond_permission(
        &self,
        handle: &EngineHandle,
        decision: EnginePermissionDecision,
    ) -> Result<(), EngineError> {
        let (_, server) = self.ensure_server_for_handle(handle, None).await?;
        server.decide_approval(&decision).await
    }

    async fn respond_question(
        &self,
        handle: &EngineHandle,
        request_id: &str,
        answers: Value,
        cancelled: bool,
    ) -> Result<(), EngineError> {
        let (_, server) = self.ensure_server_for_handle(handle, None).await?;
        server
            .answer_user_input(request_id, &answers, cancelled)
            .await
    }

    async fn list_models(
        &self,
        handle: &EngineHandle,
    ) -> Result<Vec<EngineModelInfo>, EngineError> {
        let (_, server) = self.ensure_server_for_handle(handle, None).await?;
        Ok(server.list_models().await)
    }

    fn rate_limits(&self, handle: &EngineHandle) -> Option<EngineRateLimits> {
        let ctx = self
            .handles
            .read()
            .ok()
            .and_then(|map| map.get(&handle.connection_id).cloned())?;
        ctx.server().latest_rate_limits()
    }

    fn cache_status(&self, _handle: &EngineHandle) -> Option<EngineCacheStatus> {
        None
    }

    async fn shutdown(&self, handle: EngineHandle) -> Result<(), EngineError> {
        let removed = self
            .handles
            .write()
            .ok()
            .and_then(|mut map| map.remove(&handle.connection_id));
        if let Some(ctx) = removed {
            if let Some(sid) = handle
                .external_session_id()
                .filter(|s| !is_placeholder_engine_session_id(s))
            {
                ctx.server().cleanup_session(&sid);
            }
            let key = MuseServerCacheKey::from_spec(&ctx.spec, ctx.server().disable_sandbox());
            global_muse_servers()
                .release_and_shutdown_if_unused(&key, &ctx.lease)
                .await;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "muse_tests.rs"]
mod tests;
