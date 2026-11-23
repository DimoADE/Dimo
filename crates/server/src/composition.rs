use std::{
    collections::HashMap,
    fs::File,
    future::Future,
    net::SocketAddr,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use agents::{AgentRuntime, runtime_event_channel};
use application::SqliteConversationRepository;
use automation::{
    AutomationEngine, EngineError, FileOwnerLock, StartupReconciler, StartupRecoveryReport,
    SystemClock,
};
use conversations::{
    ConversationContext, DefaultConversationHost, start_agent_event_persistence_with_observer,
};
use db::models::automation_v2::SqliteAutomationStore;
use deployment::{Deployment, DeploymentError};
use local_deployment::LocalDeployment;
use plugins::{PluginControlPlane, PluginPreviewHost, SqlitePluginRegistry};
use sqlx::SqlitePool;
use tokio::{
    sync::{Mutex, Notify},
    task::JoinHandle,
};

use crate::{
    PreviewProxyRegistry, ServerConfig, ServerRuntime, ServerToken, SqliteTokenHashStore,
    automation_runtime::HeadlessAutomationRuntime, delegation_runtime::HeadlessDelegationRuntime,
    plugin_artifact::start_plugin_artifact_http,
};

#[derive(Debug, thiserror::Error)]
pub enum ServerBootstrapError {
    #[error(transparent)]
    Deployment(#[from] DeploymentError),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Automation(#[from] EngineError),
    #[error("plugin bootstrap failed: {0}")]
    Plugin(String),
    #[error("conversation recovery failed: {0}")]
    Conversation(String),
    #[error("host identity failed: {0}")]
    HostIdentity(String),
    #[error("desktop runtime failed: {0}")]
    Desktop(String),
}

pub struct ServerBootstrapConfig {
    pub data_dir: PathBuf,
    pub server: ServerConfig,
    pub token: Option<ServerToken>,
    pub allow_loopback_outbox_for_tests: bool,
    pub desktop_mode: bool,
    pub desktop_token: Option<ServerToken>,
    pub resources_dir: Option<PathBuf>,
    pub shutdown_notify: Option<Arc<Notify>>,
    pub autostart_web_service: bool,
}

impl ServerBootstrapConfig {
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        Self {
            data_dir: data_dir.as_ref().to_path_buf(),
            server: ServerConfig::default(),
            token: None,
            allow_loopback_outbox_for_tests: false,
            desktop_mode: false,
            desktop_token: None,
            resources_dir: None,
            shutdown_notify: None,
            autostart_web_service: true,
        }
    }

    pub fn with_token(mut self, token: ServerToken) -> Self {
        self.token = Some(token);
        self
    }

    pub fn with_desktop_mode(mut self, enabled: bool) -> Self {
        self.desktop_mode = enabled;
        self
    }

    pub fn with_desktop_token(mut self, token: ServerToken) -> Self {
        self.desktop_token = Some(token);
        self
    }

    pub fn with_resources_dir(mut self, dir: impl AsRef<Path>) -> Self {
        self.resources_dir = Some(dir.as_ref().to_path_buf());
        self
    }

    pub fn with_shutdown_notify(mut self, notify: Arc<Notify>) -> Self {
        self.shutdown_notify = Some(notify);
        self
    }

    pub fn with_autostart_web_service(mut self, autostart: bool) -> Self {
        self.autostart_web_service = autostart;
        self
    }

    #[doc(hidden)]
    pub fn with_allow_loopback_outbox_for_tests(mut self, allow: bool) -> Self {
        self.allow_loopback_outbox_for_tests = allow;
        self
    }
}

pub struct HeadlessServer {
    pool: SqlitePool,
    data_dir: PathBuf,
    runtime: ServerRuntime<SqliteConversationRepository>,
    pty: local_deployment::pty::PtyService,
    issued_token: Option<ServerToken>,
    _agent_runtime: Arc<AgentRuntime>,
    plugin_control_plane: Arc<PluginControlPlane>,
    capability_broker: Arc<plugins::HostCapabilityBroker>,
    automation_runtime: HeadlessAutomationRuntime,
    automation_owner: Option<AutomationEngine<File>>,
    automation_recovery: Option<StartupRecoveryReport>,
    agent_event_task: Option<JoinHandle<()>>,
    terminal_task: Option<JoinHandle<()>>,
    idle_recycle_task: Option<JoinHandle<()>>,
    local_discovery_task: Option<JoinHandle<()>>,
    _delegation_runtime: HeadlessDelegationRuntime,
    workflow_dispatch_task: Option<JoinHandle<()>>,
    backfill_task: Option<JoinHandle<()>>,
    developer_link_task: Option<JoinHandle<()>>,
    cli_inbox_task: Option<JoinHandle<()>>,
    web_service_autostart_task: Option<JoinHandle<()>>,
    settings_watcher: Option<crate::desktop::settings_watcher::SettingsWatcherHandle>,
    plugin_dev_server: Option<crate::desktop::plugin_dev_server::PluginDevServerHandle>,
    desktop_mode: bool,
    shutdown_notify: Arc<Notify>,
}

impl HeadlessServer {
    pub async fn bootstrap(config: ServerBootstrapConfig) -> Result<Self, ServerBootstrapError> {
        Box::pin(Self::bootstrap_inner(config)).await
    }

    async fn bootstrap_inner(
        mut config: ServerBootstrapConfig,
    ) -> Result<Self, ServerBootstrapError> {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        if config.desktop_mode {
            config.server = config.server.with_desktop_mode(true);
        }
        if let Err(error) =
            crate::desktop::backup::apply_pending_backup_restore_async(config.data_dir.clone())
                .await
        {
            tracing::warn!(
                %error,
                "could not apply pending backup restore before opening database"
            );
        }
        config.server.host_id = utils::assets::load_or_create_host_id(&config.data_dir)
            .map_err(|error| ServerBootstrapError::HostIdentity(error.to_string()))?;
        if config.server.reachability.is_empty() {
            let allow_lan = utils::net::listen_allows_lan(config.server.listen_addr);
            config.server.reachability =
                utils::net::advertised_http_origins(config.server.listen_addr.port(), allow_lan)
                    .into_iter()
                    .filter(|origin| {
                        !remote_protocol::is_loopback_origin(origin)
                            && !remote_protocol::is_public_plaintext_http_origin(origin)
                    })
                    .map(remote_protocol::ReachabilityOrigin::lan)
                    .collect();
        }
        let deployment = Arc::new(LocalDeployment::new_at(&config.data_dir).await?);
        let pool = deployment.db().pool.clone();
        if let Err(error) = crate::reconcile_migrated_data_dir_paths(&pool, &config.data_dir).await
        {
            tracing::warn!(%error, "could not reconcile migrated data directory paths");
        }
        let provisioned = SqliteTokenHashStore::new(pool.clone())
            .provision(config.token)
            .await?;
        let (agent_event_sink, agent_events) = runtime_event_channel();
        let agent_runtime = Arc::new(AgentRuntime::new(agent_event_sink));
        let plugin_control_plane = Arc::new(PluginControlPlane::new(Arc::new(
            SqlitePluginRegistry::new(pool.clone()),
        )));
        plugin_control_plane.watch_worker_crashes();
        let application_deployment: Arc<dyn Deployment> = deployment.clone();
        let row_projectors = Arc::new(Mutex::new(HashMap::new()));
        let events = Arc::new(crate::HostEventBus::new());
        let conversation_context = ConversationContext {
            deployment: application_deployment,
            agent_runtime: agent_runtime.clone(),
            turn_locks: Arc::new(Mutex::new(HashMap::new())),
            runtime_states: Arc::new(Mutex::new(HashMap::new())),
            row_projectors: row_projectors.clone(),
            host: Arc::new(DefaultConversationHost::with_product_mcp_server_names({
                let gate = plugin_control_plane.official_product_mcp_gate();
                std::sync::Arc::new(move || gate.product_mcp_names())
            })),
            event_publisher: Arc::new(crate::chat_notify::ChatDeliveryPublisher::new(Arc::new(
                crate::host::HostRowOpPublisher::new(pool.clone(), row_projectors, events.clone()),
            ))),
        };
        let hot_groups = Arc::new(conversations::HotGroupTracker::default());
        agent_runtime
            .idle_extension()
            .install({
                let pool = pool.clone();
                let hot_groups = hot_groups.clone();
                Arc::new(move || {
                    let pool = pool.clone();
                    let hot_groups = hot_groups.clone();
                    Box::pin(async move { hot_groups.hot_member_sessions(&pool).await })
                        as Pin<Box<dyn Future<Output = _> + Send>>
                })
            })
            .await;
        let agent_event_task = {
            let events = events.clone();
            start_agent_event_persistence_with_observer(
                conversation_context.clone(),
                agent_events,
                move |envelope| {
                    if !matches!(
                        envelope.event,
                        agents::AgentEvent::MessageChunk { .. }
                            | agents::AgentEvent::ThoughtChunk { .. }
                            | agents::AgentEvent::ToolCallUpdate { .. }
                            | agents::AgentEvent::TerminalOutput { .. }
                            | agents::AgentEvent::RawAcpDiagnostic { .. }
                    ) {
                        events.emit("agent-events", envelope);
                    }
                },
            )
        };
        let terminal_task = {
            let pool = pool.clone();
            let events = events.clone();
            tokio::spawn(async move {
                use agents::terminal::AgentTerminalLifecycleEvent;
                use db::models::session::Session;
                let mut rx = agents::terminal::agent_terminal_registry().subscribe_lifecycle();
                loop {
                    match rx.recv().await {
                        Ok(AgentTerminalLifecycleEvent::Created(event)) => {
                            let workspace_id = Session::find_by_id(&pool, event.session_id.0)
                                .await
                                .ok()
                                .flatten()
                                .map(|session| session.workspace_id);
                            events.emit(
                                "agent-terminal-events",
                                serde_json::json!({
                                    "Created": {
                                        "source": "acp",
                                        "session_id": event.terminal_id.0,
                                        "agent_session_id": event.session_id.0,
                                        "workspace_id": workspace_id,
                                        "title": format!("ACP {}", event.command.split_whitespace().next().unwrap_or("Terminal")),
                                        "command": event.command,
                                        "agent_label": "Agent",
                                        "cwd": event.cwd.and_then(|cwd| cwd.to_str().map(str::to_string)),
                                    }
                                }),
                            );
                        }
                        Ok(AgentTerminalLifecycleEvent::Exited { terminal_id, .. }) => {
                            events.emit(
                                "agent-terminal-events",
                                serde_json::json!({
                                    "Exited": {
                                        "source": "acp",
                                        "session_id": terminal_id.0,
                                        "workspace_id": null,
                                    }
                                }),
                            );
                        }
                        Ok(AgentTerminalLifecycleEvent::Released { terminal_id }) => {
                            events.emit(
                                "agent-terminal-events",
                                serde_json::json!({
                                    "Released": {
                                        "source": "acp",
                                        "session_id": terminal_id.0,
                                        "workspace_id": null,
                                    }
                                }),
                            );
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            })
        };
        let conversation_service =
            conversations::ConversationSessionService::new(conversation_context.clone());
        conversation_service
            .recover_interrupted_turns()
            .await
            .map_err(|error| ServerBootstrapError::Conversation(error.to_string()))?;
        crate::host::surface::recover_interrupted_agent_operations(&pool).await;
        conversations::ConversationRelationControl::new(pool.clone())
            .backfill_legacy_delegations()
            .await
            .map_err(|error| ServerBootstrapError::Conversation(error.to_string()))?;
        conversation_service
            .dispatch_queued_inputs()
            .await
            .map_err(|error| ServerBootstrapError::Conversation(error.to_string()))?;
        let space_delivery =
            conversations::ScopedConversationControl::new(conversation_context.clone())
                .delivery_context()
                .with_space_changed({
                    let events = events.clone();
                    move |event| {
                        events.emit(
                            crate::host::events::COLLABORATION_SPACE_CHANGED_EVENT,
                            event,
                        );
                    }
                });
        conversations::spawn_idle_session_sweeper(pool.clone(), space_delivery.clone());
        conversations::spawn_delayed_input_promoter(pool.clone(), space_delivery);

        let preview_host: Arc<dyn PluginPreviewHost> = Arc::new(
            plugins::ExternalProcessPreviewHost::new(plugin_control_plane.clone()),
        );
        let bind_prompts = Arc::new(plugins::ProviderBindPrompts::default());
        let provider_preset_host =
            Arc::new(crate::host::provider_bind::HostProviderPresetHost::new(
                pool.clone(),
                events.clone(),
                bind_prompts.clone(),
                plugin_control_plane.clone(),
            ));
        let remote_profile_host = Arc::new(
            crate::host::remote_profiles::FileRemoteProfileHost::load(&config.data_dir),
        );
        let conversation_host = Arc::new(
            crate::HostPluginConversationHost::new(
                pool.clone(),
                config.data_dir.join("scratch").join("plugins"),
            )
            .with_events(events.clone()),
        );
        let collaboration_host = Arc::new(
            crate::host::collaboration::HostCollaborationHost::new(pool.clone(), events.clone())
                .with_agent_runtime(agent_runtime.clone())
                .with_delivery(
                    conversations::ScopedConversationControl::new(conversation_context.clone())
                        .delivery_context(),
                )
                .with_hot_groups(hot_groups.clone())
                .with_session_warmup(Arc::new(conversations::ConversationSessionWarmup::new(
                    conversation_context.clone(),
                ))),
        );
        let desktop_browser_bridge = if config.desktop_mode {
            Some(crate::desktop::browser_bridge::ElectronBrowserBridge::new(
                events.clone(),
            ))
        } else {
            None
        };
        let mut capability_broker = plugins::HostCapabilityBroker::with_hosts_and_prompts(
            plugin_control_plane.clone(),
            preview_host.clone(),
            provider_preset_host,
            remote_profile_host,
            bind_prompts,
        )
        .with_conversation_host(conversation_host.clone())
        .with_collaboration_host(collaboration_host.clone());
        if let Some(ref bridge) = desktop_browser_bridge {
            let browser_service = Arc::new(browser_host::BrowserService::with_data_dir(
                bridge.clone(),
                true,
                Some(config.data_dir.clone()),
            ));
            bridge.attach_service(&browser_service);
            capability_broker = capability_broker.with_browser_host(browser_service);
        }
        let capability_broker = Arc::new(capability_broker);
        let host_call = plugins::PluginHostCall::new(
            capability_broker.clone() as Arc<dyn plugins::CapabilityBroker>
        );
        if let Err(error) = host_call.clone().bind_loopback().await {
            tracing::warn!(%error, "plugin host.call loopback is unavailable");
        }
        let worker_runtime = Arc::new(plugins::PluginWorkerRuntimeProvider::new(
            config.data_dir.clone(),
        ));
        let bundled_roots = plugin_control_plane
            .install_bundled_official_plugins(&config.data_dir, None)
            .await
            .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?;
        if let Err(error) = plugin_control_plane.import_queued_developer_links().await {
            tracing::warn!(%error, "queued linked Plugin inbox import failed");
        }
        let catalog = plugin_control_plane
            .catalog()
            .await
            .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?;
        let enabled_worker_exists = catalog.iter().any(|plugin| {
            plugin.activation == plugins::PluginActivation::Enabled
                && plugin.entrypoints.worker.is_some()
        });
        let has_developer_links = catalog
            .iter()
            .any(|plugin| plugin.source.kind == plugins::PluginSourceKind::DeveloperLink);
        let mut developer_link_task = None;
        let recovery_failures = if enabled_worker_exists || has_developer_links {
            match worker_runtime.resolve().await {
                Ok(node) => {
                    let activation = plugins::BundledPluginActivation {
                        node_executable: node.clone(),
                        broker: capability_broker.clone(),
                    };
                    if let Err(error) = plugin_control_plane
                        .refresh_installed_bundled_plugins(&bundled_roots, Some(&activation))
                        .await
                    {
                        tracing::warn!(%error, "official plugin packages could not be refreshed");
                    }
                    developer_link_task =
                        Some(plugins::PluginControlPlane::spawn_developer_link_refresh(
                            plugin_control_plane.clone(),
                            node.clone(),
                            config.data_dir.join("plugins").join("dev-candidates"),
                            capability_broker.clone(),
                        ));
                    if enabled_worker_exists {
                        plugin_control_plane
                            .recover_enabled_workers(
                                &node,
                                &config.data_dir.join("plugins").join("dev-candidates"),
                                capability_broker.clone(),
                            )
                            .await
                            .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?
                    } else {
                        Vec::new()
                    }
                }
                Err(error) => {
                    tracing::warn!(%error, "Plugin Worker Runtime could not be provisioned");
                    Vec::new()
                }
            }
        } else {
            if let Err(error) = plugin_control_plane
                .refresh_installed_bundled_plugins(&bundled_roots, None)
                .await
            {
                tracing::warn!(%error, "official plugin packages could not be refreshed");
            }
            Vec::new()
        };
        for failure in recovery_failures {
            tracing::warn!(
                plugin_id = %failure.plugin_id,
                code = %failure.code,
                error = %failure.message,
                "enabled plugin Worker could not be restored"
            );
        }
        plugin_control_plane
            .sync_official_product_mcp_gate()
            .await
            .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?;
        if let Err(error) = services::services::mcp::patch_grok_product_mcp_startup_timeout() {
            tracing::warn!(%error, "Grok product MCP startup timeout patch failed");
        }
        let idle_recycle_task = {
            let idle_recycle = plugin_control_plane.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    interval.tick().await;
                    idle_recycle
                        .recycle_idle_workers(std::time::Duration::from_secs(10 * 60))
                        .await;
                }
            })
        };
        start_plugin_artifact_http(plugin_control_plane.clone())
            .await
            .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?;
        let app_surfaces = Arc::new(plugins::PluginAppSurfaceHost::new(
            plugin_control_plane.clone(),
        ));
        let data_dir_key = config.data_dir.to_string_lossy().into_owned();
        let automation_owner =
            AutomationEngine::acquire(&data_dir_key, FileOwnerLock::default()).await?;
        let automation_recovery = if automation_owner.is_some() {
            Some(
                StartupReconciler::new(SqliteAutomationStore::new(pool.clone()), SystemClock)
                    .reconcile()
                    .await?,
            )
        } else {
            None
        };
        let automation_runtime = HeadlessAutomationRuntime::new(
            deployment.clone(),
            conversation_context.clone(),
            plugin_control_plane.clone(),
        );
        let preview_proxy = PreviewProxyRegistry::default();
        crate::start_chat_inbound(pool.clone(), conversation_context.clone());
        application::WorkflowStoreExecutionPort::with_conversations(
            pool.clone(),
            conversation_context.clone(),
        )
        .reconcile_interrupted()
        .await
        .map_err(|error| ServerBootstrapError::Conversation(error.to_string()))?;
        let product_mcp_commands = crate::ProductMcpCommandHost::default();
        let (delegation_runtime, companion_memory, delegation_broker) =
            HeadlessDelegationRuntime::start(
                agent_runtime.clone(),
                pool.clone(),
                conversation_context.clone(),
                plugin_control_plane.official_product_mcp_gate(),
                events.clone(),
                product_mcp_commands.clone(),
            );
        collaboration_host.install_companion_memory(companion_memory.clone());
        let host_config = deployment.config().read().await.clone();
        if let Err(error) = crate::host::plugin_projections::refresh_official_product_runtime_with(
            &plugin_control_plane,
            &delegation_broker,
            &host_config,
        )
        .await
        {
            tracing::warn!(%error, "official product runtime sync failed");
        }
        {
            let plane = plugin_control_plane.clone();
            let broker = delegation_broker.clone();
            let deployment = deployment.clone();
            capability_broker.set_settings_saved_hook(move || {
                let plane = plane.clone();
                let broker = broker.clone();
                let deployment = deployment.clone();
                tokio::spawn(async move {
                    let config = deployment.config().read().await.clone();
                    let _ = crate::host::plugin_projections::refresh_official_product_runtime_with(
                        &plane, &broker, &config,
                    )
                    .await;
                });
            });
        }
        let host = crate::HostRuntime::build_with_outbox_policy(
            crate::HostRuntimeParts {
                pool: pool.clone(),
                conversations: conversation_context.clone(),
                plugin_control_plane: plugin_control_plane.clone(),
                companion_memory: Some(companion_memory),
                preview_host,
                capability_broker: capability_broker.clone(),
                host_call,
                app_surfaces,
                preview_proxy: preview_proxy.clone(),
                automation: automation_runtime.clone(),
                automation_ownership: crate::AutomationOwnership::fixed(automation_owner.is_some()),
                deployment: deployment.clone(),
                runtime_root: config.data_dir.join("plugins/runtimes"),
                worker_runtime: worker_runtime.clone(),
                adapter: if config.desktop_mode {
                    application::AdapterCapabilities::desktop_electron_host()
                } else {
                    application::AdapterCapabilities::server_http()
                },
                events: Some(events),
                terminal_bridges: None,
                agent_management_runtime: None,
                conversation_host: Some(conversation_host),
                delegation_broker: Some(delegation_broker.clone()),
            },
            config.allow_loopback_outbox_for_tests,
        );
        crate::desktop::logging::attach_event_bus(host.events.clone());
        crate::desktop::host_tunnel::attach_event_bus(host.events.clone());
        product_mcp_commands
            .attach_commands(host.commands.clone())
            .await;
        let local_discovery_task = {
            let runtime = host.agent_management_runtime.clone();
            let events = host.events.clone();
            let pool = pool.clone();
            let desktop_mode = config.desktop_mode;
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                if desktop_mode {
                    crate::desktop::startup_hooks::reconcile_managed_cli_exposures(&pool).await;
                }
                services::services::local_runtime_discovery::warm_local_runtime_discovery(
                    &pool,
                    &runtime,
                    {
                        let events = events.clone();
                        move |progress| {
                            events.emit("agent-management-discovery-progress", progress);
                        }
                    },
                )
                .await;
                if desktop_mode {
                    crate::desktop::startup_hooks::warm_agent_management(&pool, &runtime, &events)
                        .await;
                } else {
                    events.emit("agent-management-snapshot-invalidated", ());
                }
            })
        };
        let workflow_dispatcher =
            application::WorkflowAgentDispatcher::new(conversation_context.clone());
        let workflow_dispatch_task = tokio::spawn(async move {
            loop {
                let woken = workflows::workflow_wake().notified();
                tokio::pin!(woken);
                woken.as_mut().enable();

                match workflow_dispatcher.tick().await {
                    Ok(true) => continue,
                    Ok(false) => {
                        tokio::select! {
                            _ = &mut woken => {}
                            _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {}
                        }
                    }
                    Err(error) => {
                        tracing::warn!(%error, "workflow dispatcher tick failed");
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    }
                }
            }
        });
        let shutdown_notify = config
            .shutdown_notify
            .unwrap_or_else(|| Arc::new(Notify::new()));
        let mut backfill_task = None;
        let mut cli_inbox_task = None;
        let mut web_service_autostart_task = None;
        let mut settings_watcher = None;
        let mut plugin_dev_server = None;
        let desktop_state = if config.desktop_mode {
            if let Err(error) = crate::start_loopback_preview_proxy(preview_proxy.clone()).await {
                tracing::warn!(%error, "loopback preview proxy could not start");
            }
            let dev_handle = crate::desktop::plugin_dev_server::start(
                crate::desktop::plugin_dev_server::PluginDevServerConfig {
                    plugins: plugin_control_plane.clone(),
                    pool: pool.clone(),
                    broker: capability_broker.clone(),
                    worker_runtime: worker_runtime.clone(),
                    runtime_root: config.data_dir.join("plugins/runtimes"),
                    candidate_root: config.data_dir.join("plugins/dev-candidates"),
                    connection_path: Some(config.data_dir.join("plugin-dev.json")),
                    events: host.events.clone(),
                },
            )
            .await
            .map_err(|error| ServerBootstrapError::Desktop(error.to_string()))?;
            let plugin_dev = dev_handle.connection().clone();
            plugin_dev_server = Some(dev_handle);
            let search_pool = pool.clone();
            backfill_task = Some(tokio::spawn(async move {
                match conversations::backfill_missing(&search_pool).await {
                    Ok(indexed) if indexed > 0 => {
                        tracing::info!("indexed {indexed} conversations for search");
                    }
                    Ok(_) => {}
                    Err(error) => {
                        tracing::warn!("conversation search backfill failed: {error}");
                    }
                }
                crate::desktop::release_startup_working_set(&search_pool).await;
            }));
            let inbox_ctx = crate::desktop::startup_hooks::CliInboxContext {
                plugin_control_plane: plugin_control_plane.clone(),
                worker_runtime: worker_runtime.clone(),
                capability_broker: capability_broker.clone(),
                delegation_broker: delegation_broker.clone(),
                deployment: deployment.clone(),
                data_dir: config.data_dir.clone(),
            };
            cli_inbox_task = Some(tokio::spawn(async move {
                crate::desktop::startup_hooks::import_cli_inbox(inbox_ctx).await;
            }));
            let proxy_handle = tokio::runtime::Handle::current();
            settings_watcher = crate::desktop::settings_watcher::start(
                host.events.clone(),
                Some(Arc::new(move || {
                    proxy_handle.spawn(async {
                        crate::init_system_proxy().await;
                    });
                })),
            );
            let desktop_token = config.desktop_token.unwrap_or_else(crate::issue_host_token);
            let remote_desktop = Arc::new(
                crate::desktop::remote_desktop::RemoteDesktopRegistry::new()
                    .map_err(|error| ServerBootstrapError::Desktop(error.to_string()))?,
            );
            let web_service = crate::desktop::web_service::DesktopWebServiceContext {
                pool: pool.clone(),
                host: host.clone(),
                pty: deployment.pty().clone(),
                resources_dir: config.resources_dir.clone(),
                static_asset_resolver: config.server.static_asset_resolver.clone(),
                server_version: config.server.server_version.clone(),
            };
            if config.autostart_web_service {
                let autostart_ctx = web_service.clone();
                web_service_autostart_task = Some(tokio::spawn(async move {
                    if let Err(error) =
                        crate::desktop::web_service::ensure_web_service_autostart(&autostart_ctx)
                            .await
                    {
                        tracing::warn!(%error, "Failed to autostart web service");
                    }
                }));
            }
            let browser_bridge = desktop_browser_bridge.unwrap_or_else(|| {
                crate::desktop::browser_bridge::ElectronBrowserBridge::new(host.events.clone())
            });
            Some(crate::desktop::DesktopRuntimeState {
                token_digest: desktop_token.digest(),
                shutdown: Arc::clone(&shutdown_notify),
                deployment: deployment.clone(),
                web_service,
                remote_desktop,
                browser_bridge,
                plugin_dev,
                events: host.events.clone(),
            })
        } else {
            None
        };
        let pty = deployment.pty().clone();
        let mut runtime = ServerRuntime::from_host(
            config.server,
            Arc::new(crate::SqliteServerAuth::new(pool.clone())),
            host,
            pty.clone(),
        );
        if let Some(desktop) = desktop_state {
            runtime = runtime.with_desktop(desktop);
        }

        Ok(Self {
            pool,
            data_dir: config.data_dir,
            runtime,
            pty,
            issued_token: provisioned.issued_token,
            _agent_runtime: agent_runtime,
            plugin_control_plane,
            capability_broker,
            automation_runtime,
            automation_owner,
            automation_recovery,
            agent_event_task: Some(agent_event_task),
            terminal_task: Some(terminal_task),
            idle_recycle_task: Some(idle_recycle_task),
            local_discovery_task: Some(local_discovery_task),
            _delegation_runtime: delegation_runtime,
            workflow_dispatch_task: Some(workflow_dispatch_task),
            backfill_task,
            developer_link_task,
            cli_inbox_task,
            web_service_autostart_task,
            settings_watcher,
            plugin_dev_server,
            desktop_mode: config.desktop_mode,
            shutdown_notify,
        })
    }

    pub const fn runtime(&self) -> &ServerRuntime<SqliteConversationRepository> {
        &self.runtime
    }

    pub const fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// Runtime port retained by the headless composition for domain adapters
    /// such as delegation and durable conversation event persistence.
    pub const fn agent_runtime(&self) -> &Arc<AgentRuntime> {
        &self._agent_runtime
    }

    pub fn shutdown_handle(&self) -> Arc<Notify> {
        Arc::clone(&self.shutdown_notify)
    }

    pub fn take_issued_token(&mut self) -> Option<ServerToken> {
        self.issued_token.take()
    }

    pub const fn owns_automation_engine(&self) -> bool {
        self.automation_owner.is_some()
    }

    pub const fn automation_recovery(&self) -> Option<&StartupRecoveryReport> {
        self.automation_recovery.as_ref()
    }

    pub async fn serve(self) -> std::io::Result<()> {
        self.serve_with_shutdown(std::future::pending()).await
    }

    pub async fn serve_with_shutdown(
        self,
        shutdown: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> std::io::Result<()> {
        self.serve_with_ready_and_shutdown(|_| {}, shutdown).await
    }

    pub async fn serve_with_ready_and_shutdown(
        mut self,
        on_ready: impl FnOnce(SocketAddr),
        shutdown: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> std::io::Result<()> {
        let listen_addr = self.runtime.config().listen_addr;
        let listener = tokio::net::TcpListener::bind(listen_addr).await?;
        let bound_addr = listener.local_addr()?;
        let automation_task = self.automation_owner.take().map(|engine| {
            let runtime = self.automation_runtime.clone();
            let recovery = self.automation_recovery.take();
            tokio::spawn(runtime.run(engine, recovery))
        });
        tracing::info!(listen_addr = %bound_addr, desktop_mode = self.desktop_mode, "dimo-server listening");
        on_ready(bound_addr);
        let notify = Arc::clone(&self.shutdown_notify);
        let combined_shutdown = async move {
            tokio::select! {
                _ = shutdown => {}
                _ = notify.notified() => {}
            }
        };
        let result = axum::serve(listener, self.runtime.router())
            .with_graceful_shutdown(combined_shutdown)
            .await;

        // 1. Stop file watcher before tearing down background tasks & SQLite.
        if let Some(mut watcher) = self.settings_watcher.take() {
            let _ = tokio::task::spawn_blocking(move || watcher.stop()).await;
        }

        // 2. Abort & await ALL background tasks concurrently under a single bounded timeout
        //    so no writers race with WAL checkpoint and shutdown stays well inside the 5s budget.
        let plugin_dev_task = self.plugin_dev_server.take().and_then(|mut handle| {
            handle.cleanup_connection_file();
            handle.take_task()
        });
        let background_tasks: Vec<JoinHandle<()>> = [
            automation_task,
            plugin_dev_task,
            self.agent_event_task.take(),
            self.workflow_dispatch_task.take(),
            self.terminal_task.take(),
            self.idle_recycle_task.take(),
            self.local_discovery_task.take(),
            self.backfill_task.take(),
            self.developer_link_task.take(),
            self.cli_inbox_task.take(),
            self.web_service_autostart_task.take(),
        ]
        .into_iter()
        .flatten()
        .collect();
        for task in &background_tasks {
            task.abort();
        }
        let _ = tokio::time::timeout(
            Duration::from_millis(1500),
            futures::future::join_all(background_tasks),
        )
        .await;

        // 3. Stop desktop web service (HTTP listeners, relay, quick tunnel).
        if self.desktop_mode {
            let _ = crate::desktop::web_service::stop_web_server().await;
        }

        // 4. Shut down PluginControlPlane workers, host services, and plugin child processes.
        shutdown_plugin_control_plane(&self.plugin_control_plane, &self.capability_broker).await;

        // 5. Terminate instance-owned agent child processes and PTY sessions.
        //    Only tear down process-global registries (agent terminal registry,
        //    desktop companions) in desktop mode so parallel in-process test
        //    servers do not kill sibling instances' shared resources.
        self._agent_runtime.kill_all_processes_on_exit();
        let _ = tokio::time::timeout(Duration::from_secs(1), async {
            if self.desktop_mode {
                tokio::join!(
                    agents::terminal::agent_terminal_registry().release_all(),
                    self.pty.close_all(),
                );
            } else {
                self.pty.close_all().await;
            }
        })
        .await;
        if self.desktop_mode {
            crate::desktop::kill_companion_processes_on_exit();
        }

        // 6. Now that all background writers & plugin workers have stopped, checkpoint WAL cleanly.
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&self.pool),
        )
        .await;

        // 7. Close SQLite pool and apply any pending staged backup restore cleanly.
        let has_pending_restore = self
            .data_dir
            .join(".pending-restore")
            .join("pending.json")
            .is_file();
        if self.desktop_mode || has_pending_restore {
            let _ = tokio::time::timeout(Duration::from_secs(2), self.pool.close()).await;
            if has_pending_restore
                && self.pool.is_closed()
                && let Err(error) = crate::desktop::backup::apply_pending_backup_restore_async(
                    self.data_dir.clone(),
                )
                .await
            {
                tracing::warn!(
                    %error,
                    "could not apply pending backup restore on shutdown; will retry on next startup"
                );
            }
        }
        result
    }
}

async fn shutdown_plugin_control_plane(
    plugin_control_plane: &PluginControlPlane,
    capability_broker: &plugins::HostCapabilityBroker,
) {
    let catalog =
        match tokio::time::timeout(Duration::from_secs(1), plugin_control_plane.catalog()).await {
            Ok(Ok(catalog)) => catalog,
            Ok(Err(error)) => {
                tracing::warn!(%error, "could not read plugin catalog during shutdown");
                return;
            }
            Err(_) => {
                tracing::warn!("timed out reading plugin catalog during shutdown");
                return;
            }
        };

    let plugin_ids: Vec<String> = catalog
        .into_iter()
        .map(|plugin| plugin.id().to_string())
        .collect();
    if plugin_ids.is_empty() {
        return;
    }

    let shutdown_futures = plugin_ids.into_iter().map(|plugin_id| async move {
        capability_broker.kill_plugin_processes(&plugin_id).await;
        let _ = plugin_control_plane.deactivate_worker(&plugin_id).await;
    });
    if tokio::time::timeout(
        Duration::from_millis(1500),
        futures::future::join_all(shutdown_futures),
    )
    .await
    .is_err()
    {
        tracing::warn!("timed out shutting down plugin workers during shutdown");
    }
}

impl Drop for HeadlessServer {
    fn drop(&mut self) {
        self.settings_watcher.take();
        self.plugin_dev_server.take();
        for task in [
            self.workflow_dispatch_task.take(),
            self.terminal_task.take(),
            self.idle_recycle_task.take(),
            self.local_discovery_task.take(),
            self.backfill_task.take(),
            self.agent_event_task.take(),
            self.developer_link_task.take(),
            self.cli_inbox_task.take(),
            self.web_service_autostart_task.take(),
        ]
        .into_iter()
        .flatten()
        {
            task.abort();
        }
    }
}
