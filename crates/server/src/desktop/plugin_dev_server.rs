use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path as AxumPath, Request, State, rejection::JsonRejection},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Row, SqlitePool};
use tokio::task::JoinHandle;

use super::PluginDevConnection;

pub const PROTOCOL_VERSION: &str = "1.0";
pub const TOKEN_HEADER: &str = "x-dimo-plugin-dev-token";
pub const PROTOCOL_HEADER: &str = "x-dimo-plugin-dev-protocol";

const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;
const CONTRIBUTIONS_CHANGED_EVENT: &str = "plugin-contributions-changed";

/// Configuration required to start the loopback Plugin Dev Control Protocol 1.0 server.
pub struct PluginDevServerConfig {
    pub plugins: Arc<plugins::PluginControlPlane>,
    pub pool: SqlitePool,
    pub broker: Arc<plugins::HostCapabilityBroker>,
    pub worker_runtime: Arc<plugins::PluginWorkerRuntimeProvider>,
    pub runtime_root: PathBuf,
    pub candidate_root: PathBuf,
    pub connection_path: Option<PathBuf>,
    pub events: Arc<crate::HostEventBus>,
}

/// Live handle owning the loopback Plugin Dev control server task and its persisted connection file.
pub struct PluginDevServerHandle {
    connection: PluginDevConnection,
    task: Option<JoinHandle<()>>,
    connection_path: Option<PathBuf>,
}

impl PluginDevServerHandle {
    pub fn connection(&self) -> &PluginDevConnection {
        &self.connection
    }

    pub fn take_task(&mut self) -> Option<JoinHandle<()>> {
        self.task.take()
    }

    pub fn cleanup_connection_file(&mut self) {
        if let Some(path) = self.connection_path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl Drop for PluginDevServerHandle {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        self.cleanup_connection_file();
    }
}

#[derive(Clone)]
struct DevState {
    token: Arc<str>,
    plugins: Arc<plugins::PluginControlPlane>,
    pool: SqlitePool,
    broker: Arc<plugins::HostCapabilityBroker>,
    worker_runtime: Arc<plugins::PluginWorkerRuntimeProvider>,
    runtime_root: PathBuf,
    candidate_root: PathBuf,
    events: Arc<crate::HostEventBus>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedPackage {
    publisher: String,
    plugin_id: String,
    version: String,
    package_digest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkedInstallRequest {
    source_path: String,
    expected: ExpectedPackage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CandidateRequest {
    source_path: String,
    expected_package_digest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UninstallRequest {
    #[serde(default = "default_retain_data")]
    retain_data: bool,
}

const fn default_retain_data() -> bool {
    true
}

/// Persist the loopback Plugin Dev connection JSON (`0o600` on Unix) so local developer
/// tooling can discover the running Host's control endpoint without reading the main bearer.
pub fn persist_connection(path: &Path, connection: &PluginDevConnection) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = json!({
        "url": connection.endpoint,
        "token": connection.token,
        "protocolVersion": connection.protocol_version,
    });
    std::fs::write(path, format!("{body}\n"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Bind a dedicated loopback HTTP server implementing Dimo Plugin Dev Control Protocol 1.0.
pub async fn start(config: PluginDevServerConfig) -> anyhow::Result<PluginDevServerHandle> {
    let mut token_bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut token_bytes);
    let token = URL_SAFE_NO_PAD.encode(token_bytes);

    let state = DevState {
        token: Arc::from(token.clone()),
        plugins: config.plugins,
        pool: config.pool,
        broker: config.broker,
        worker_runtime: config.worker_runtime,
        runtime_root: config.runtime_root,
        candidate_root: config.candidate_root,
        events: config.events,
    };

    let router = Router::new()
        .route(
            "/api/plugin-dev/v1/linked-installations",
            post(install_linked),
        )
        .route(
            "/api/plugin-dev/v1/plugins/{publisher}/{id}/candidates",
            post(reload_candidate),
        )
        .route(
            "/api/plugin-dev/v1/plugins/{publisher}/{id}/linked-installation",
            delete(uninstall_linked),
        )
        .route(
            "/api/plugin-dev/v1/plugins/{publisher}/{id}/doctor",
            get(doctor),
        )
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .layer(middleware::from_fn_with_state(state.clone(), authenticate))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let task = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::warn!(%error, "Plugin Dev control server stopped");
        }
    });

    let connection = PluginDevConnection {
        endpoint: format!("http://{address}"),
        token,
        protocol_version: PROTOCOL_VERSION,
    };

    let persisted_path = match config.connection_path {
        Some(path) => match persist_connection(&path, &connection) {
            Ok(()) => Some(path),
            Err(error) => {
                tracing::warn!(
                    %error,
                    path = %path.display(),
                    "Plugin Dev connection file could not be written"
                );
                None
            }
        },
        None => None,
    };

    Ok(PluginDevServerHandle {
        connection,
        task: Some(task),
        connection_path: persisted_path,
    })
}

async fn authenticate(State(state): State<DevState>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    let protocol_ok = headers
        .get(PROTOCOL_HEADER)
        .and_then(|value| value.to_str().ok())
        == Some(PROTOCOL_VERSION);
    let token_ok = headers
        .get(TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|candidate| constant_time_eq(candidate.as_bytes(), state.token.as_bytes()));
    if !protocol_ok || !token_ok {
        return DevError::new(
            StatusCode::UNAUTHORIZED,
            "plugin_dev_unauthorized",
            "Plugin Dev credentials are invalid",
        )
        .into_response();
    }
    next.run(request).await
}

fn extract_json<T>(payload: Result<Json<T>, JsonRejection>) -> Result<T, DevError> {
    match payload {
        Ok(Json(value)) => Ok(value),
        Err(JsonRejection::MissingJsonContentType(_)) => Err(DevError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "plugin_dev_unsupported_media_type",
            "Request body must use Content-Type: application/json",
        )),
        Err(rejection) => Err(DevError::bad_request(
            "plugin_dev_invalid_json",
            rejection.body_text(),
        )),
    }
}

async fn install_linked(
    State(state): State<DevState>,
    payload: Result<Json<LinkedInstallRequest>, JsonRejection>,
) -> Result<Json<Value>, DevError> {
    let request = extract_json(payload)?;
    let (mut package, digest) = inspect_linked_source(&request.source_path)?;
    verify_expected(&package, &digest, &request.expected)?;
    package
        .freeze_execution_root(&state.candidate_root, &digest)
        .map_err(DevError::plugin)?;

    let plugin_id = package.id.as_str().to_owned();
    let grants = selected_grants(&package)?;
    let node = resolve_worker_node(&state, &package).await?;
    let broker: Arc<dyn plugins::CapabilityBroker> = state.broker.clone();

    let installed = state
        .plugins
        .plugin(&plugin_id)
        .await
        .map_err(DevError::plugin)?;
    if let Some(installed) = installed {
        if installed.source.kind != plugins::PluginSourceKind::DeveloperLink {
            return Err(DevError::new(
                StatusCode::CONFLICT,
                "plugin_source_conflict",
                "Installed plugin is not a linked development installation",
            ));
        }
        let published = published_generation(&state, &plugin_id).await;
        prepare_candidate_runtimes(&state, &package, &digest).await?;
        state
            .plugins
            .update_and_activate(&node, package.clone(), &grants, broker)
            .await
            .map_err(|error| DevError::worker(error, published))?;
    } else {
        state
            .plugins
            .import(package.clone(), plugins::ConflictDecision::Reject)
            .await
            .map_err(DevError::plugin)?;
        if let Err(error) = prepare_candidate_runtimes(&state, &package, &digest).await {
            let _ = state.plugins.uninstall(&plugin_id).await;
            return Err(error);
        }
        if let Err(error) = state
            .plugins
            .activate_and_enable(&node, &plugin_id, &grants, broker)
            .await
        {
            let _ = state.plugins.uninstall(&plugin_id).await;
            return Err(DevError::worker(error, None));
        }
    }

    let response = activated_response(&state, &package, digest).await?;
    notify_contributions_changed(&state, response.0["generation"].as_u64());
    Ok(response)
}

async fn reload_candidate(
    State(state): State<DevState>,
    AxumPath((publisher, id)): AxumPath<(String, String)>,
    payload: Result<Json<CandidateRequest>, JsonRejection>,
) -> Result<Json<Value>, DevError> {
    let request = extract_json(payload)?;
    let existing = state
        .plugins
        .plugin(&id)
        .await
        .map_err(DevError::plugin)?
        .ok_or_else(|| DevError::not_found(&id))?;
    if existing.publisher.as_deref() != Some(publisher.as_str())
        || existing.source.kind != plugins::PluginSourceKind::DeveloperLink
    {
        return Err(DevError::new(
            StatusCode::CONFLICT,
            "plugin_not_linked",
            "Plugin identity is not a linked development installation",
        ));
    }

    let published = published_generation(&state, &id).await;
    let (mut package, digest) = inspect_linked_source(&request.source_path)
        .map_err(|error| error.with_published_generation(published))?;
    if package.publisher.as_deref() != Some(publisher.as_str())
        || package.id.as_str() != id
        || digest != request.expected_package_digest
    {
        return Err(DevError::new(
            StatusCode::CONFLICT,
            "plugin_dev_expectation_mismatch",
            "Candidate identity or digest does not match the linked package",
        )
        .with_published_generation(published));
    }

    package
        .freeze_execution_root(&state.candidate_root, &digest)
        .map_err(|error| DevError::plugin(error).with_published_generation(published))?;
    prepare_candidate_runtimes(&state, &package, &digest)
        .await
        .map_err(|error| error.with_published_generation(published))?;
    let grants =
        selected_grants(&package).map_err(|error| error.with_published_generation(published))?;
    let node = resolve_worker_node(&state, &package)
        .await
        .map_err(|error| error.with_published_generation(published))?;
    let broker: Arc<dyn plugins::CapabilityBroker> = state.broker.clone();

    state
        .plugins
        .update_and_activate(&node, package.clone(), &grants, broker)
        .await
        .map_err(|error| DevError::worker(error, published))?;

    let response = activated_response(&state, &package, digest).await?;
    notify_contributions_changed(&state, response.0["generation"].as_u64());
    Ok(response)
}

async fn uninstall_linked(
    State(state): State<DevState>,
    AxumPath((publisher, id)): AxumPath<(String, String)>,
    payload: Result<Json<UninstallRequest>, JsonRejection>,
) -> Result<Json<Value>, DevError> {
    let request = extract_json(payload)?;
    let plugin = state
        .plugins
        .plugin(&id)
        .await
        .map_err(DevError::plugin)?
        .ok_or_else(|| DevError::not_found(&id))?;
    if plugin.publisher.as_deref() != Some(publisher.as_str())
        || plugin.source.kind != plugins::PluginSourceKind::DeveloperLink
    {
        return Err(DevError::new(
            StatusCode::CONFLICT,
            "plugin_not_linked",
            "Plugin identity is not a linked development installation",
        ));
    }

    state.broker.kill_plugin_processes(&id).await;
    state
        .plugins
        .deactivate_worker(&id)
        .await
        .map_err(|error| DevError::worker(error, None))?;
    state
        .plugins
        .uninstall(&id)
        .await
        .map_err(DevError::plugin)?;

    if !request.retain_data {
        let _ = state.plugins.kv_clear(&id).await;
        let _ = state
            .plugins
            .reclaim_unreferenced_runtimes(&state.runtime_root)
            .await;
    }

    notify_contributions_changed(&state, None);
    Ok(Json(json!({
        "protocolVersion": PROTOCOL_VERSION,
        "plugin": { "publisher": publisher, "id": id },
        "removed": true,
        "dataRetention": if request.retain_data { "retained" } else { "deleted" },
    })))
}

async fn doctor(
    State(state): State<DevState>,
    AxumPath((publisher, id)): AxumPath<(String, String)>,
) -> Result<Json<Value>, DevError> {
    let plugin = state
        .plugins
        .plugin(&id)
        .await
        .map_err(DevError::plugin)?
        .ok_or_else(|| DevError::not_found(&id))?;
    if plugin.publisher.as_deref() != Some(publisher.as_str()) {
        return Err(DevError::not_found(&id));
    }

    let grants = state
        .plugins
        .capability_grants(&id)
        .await
        .map_err(DevError::plugin)?;
    let runtimes = state
        .plugins
        .runtime_inventory()
        .await
        .map_err(DevError::plugin)?
        .into_iter()
        .filter(|runtime| runtime.referenced_plugins.contains(&id))
        .collect::<Vec<_>>();
    let catalog = state
        .plugins
        .contributions()
        .await
        .map_err(DevError::plugin)?;
    let contributions = catalog
        .items
        .into_iter()
        .filter(|item| item.plugin_id == id)
        .collect::<Vec<_>>();
    let bindings = sqlx::query(
        "SELECT agent_id, desired, applied, pending_reason, error_code
         FROM plugin_agent_bindings_v4 WHERE plugin_id = ? ORDER BY agent_id",
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await
    .map_err(DevError::database)?
    .into_iter()
    .map(|row| {
        json!({
            "agentId": row.get::<String, _>("agent_id"),
            "desired": row.get::<i64, _>("desired") == 1,
            "applied": row.get::<i64, _>("applied") == 1,
            "pendingReason": row.get::<Option<String>, _>("pending_reason"),
            "errorCode": row.get::<Option<String>, _>("error_code"),
        })
    })
    .collect::<Vec<_>>();

    let generation = published_generation(&state, &id).await;
    let mut diagnostics = if plugin.activation == plugins::PluginActivation::Enabled
        && plugin.entrypoints.worker.is_some()
        && state.plugins.activation_lease(&id).await.is_none()
    {
        vec![json!({
            "code": "worker_not_running",
            "severity": "error",
            "message": "Published Worker generation is not running",
        })]
    } else {
        Vec::new()
    };

    if plugin.source.kind == plugins::PluginSourceKind::DeveloperLink {
        let published_digest = sqlx::query_scalar::<_, String>(
            "SELECT current_package_digest FROM plugin_installations_v4 WHERE plugin_id = ?",
        )
        .bind(&id)
        .fetch_optional(&state.pool)
        .await
        .map_err(DevError::database)?;
        match inspect_linked_source(plugin.source.path.to_string_lossy().as_ref()) {
            Ok((candidate, digest)) => {
                if candidate.publisher != plugin.publisher
                    || candidate.id != plugin.id
                    || published_digest.as_deref() != Some(digest.as_str())
                {
                    diagnostics.push(json!({
                        "code": "linked_candidate_invalid",
                        "severity": "error",
                        "message": "Linked source identity or digest no longer matches the installation",
                    }));
                }
            }
            Err(error) => diagnostics.push(json!({
                "code": "linked_candidate_invalid",
                "severity": "error",
                "message": error.message,
            })),
        }
    }

    Ok(Json(json!({
        "protocolVersion": PROTOCOL_VERSION,
        "plugin": { "publisher": publisher, "id": id },
        "installation": {
            "version": plugin.version,
            "sourcePath": plugin.source.path,
            "sourceKind": plugin.source.kind,
            "packageDigest": plugin.package_digest,
            "origin": plugin.source.origin,
            "gitRef": plugin.source.git_ref,
            "gitSha": plugin.source.git_sha,
            "locked": plugin.source.locked,
        },
        "activation": {
            "enabled": plugin.activation == plugins::PluginActivation::Enabled,
            "generation": generation,
        },
        "sourceKind": match plugin.source.kind {
            plugins::PluginSourceKind::DeveloperLink => "linked",
            plugins::PluginSourceKind::Builtin => "builtin",
            plugins::PluginSourceKind::Marketplace => "marketplace",
            _ => "installed",
        },
        "grants": grants,
        "runtimes": runtimes,
        "contributions": contributions,
        "agentBindings": bindings,
        "mcpRebindingRequired": bindings.iter().any(|binding| {
            binding.get("desired").and_then(|value| value.as_bool()) == Some(true)
                && binding.get("applied").and_then(|value| value.as_bool()) != Some(true)
        }),
        "recentCrashes": plugins::recent_plugin_crashes(&id),
        "diagnostics": diagnostics,
    })))
}

async fn resolve_worker_node(
    state: &DevState,
    package: &plugins::PluginPackage,
) -> Result<PathBuf, DevError> {
    if package.entrypoints.worker.is_some() {
        state
            .worker_runtime
            .resolve_for_package(package)
            .await
            .map_err(DevError::plugin)
    } else {
        Ok(PathBuf::from("node"))
    }
}

fn selected_grants(
    package: &plugins::PluginPackage,
) -> Result<Vec<plugins::CapabilityGrant>, DevError> {
    plugins::candidate_capability_grants(package, &[], &[]).map_err(DevError::plugin)
}

async fn prepare_candidate_runtimes(
    state: &DevState,
    package: &plugins::PluginPackage,
    package_digest: &str,
) -> Result<(), DevError> {
    for declared in &package.runtimes {
        let ready = state
            .plugins
            .runtime_for_package(package.id.as_str(), package_digest, &declared.id)
            .await
            .map_err(DevError::plugin)?
            .is_some_and(|locked| {
                declared
                    .version
                    .as_deref()
                    .is_none_or(|version| version == locked.version)
                    && (declared.target.is_empty() || declared.target == locked.target)
                    && (declared.content_digest.is_empty()
                        || declared.content_digest == locked.content_digest)
                    && locked.executable_path.is_absolute()
                    && locked.executable_path.is_file()
            });
        if ready {
            continue;
        }
        let host = plugins::ContentAddressedRuntimeHost::new(state.runtime_root.clone(), declared)
            .map_err(DevError::plugin)?;
        let installation = plugins::GlobalRuntimeInstaller::new(&host)
            .install(package.id.as_str(), declared)
            .await
            .map_err(DevError::plugin)?;
        state
            .plugins
            .record_runtime_for_package(package.id.as_str(), package_digest, installation)
            .await
            .map_err(DevError::plugin)?;
    }
    Ok(())
}

fn inspect_linked_source(source: &str) -> Result<(plugins::PluginPackage, String), DevError> {
    let raw = PathBuf::from(source);
    let root = raw.canonicalize().map_err(|_| {
        DevError::bad_request("plugin_link_source_missing", "Linked source does not exist")
    })?;
    if !root.is_dir() {
        return Err(DevError::bad_request(
            "plugin_link_source_not_directory",
            "Linked source must be a directory",
        ));
    }
    let package = plugins::PluginPackage::inspect(&root, plugins::PluginSourceKind::DeveloperLink)
        .map_err(DevError::plugin)?;
    let digest = plugins::package_content_digest(&root).map_err(DevError::plugin)?;
    Ok((package, digest))
}

fn verify_expected(
    package: &plugins::PluginPackage,
    digest: &str,
    expected: &ExpectedPackage,
) -> Result<(), DevError> {
    if package.publisher.as_deref() != Some(expected.publisher.as_str())
        || package.id.as_str() != expected.plugin_id
        || package.version != expected.version
        || digest != expected.package_digest
    {
        return Err(DevError::new(
            StatusCode::CONFLICT,
            "plugin_dev_expectation_mismatch",
            "Package identity, version, or digest does not match the Host inspection",
        ));
    }
    Ok(())
}

async fn activated_response(
    state: &DevState,
    package: &plugins::PluginPackage,
    digest: String,
) -> Result<Json<Value>, DevError> {
    let generation = published_generation(state, package.id.as_str())
        .await
        .ok_or_else(|| {
            DevError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "plugin_generation_missing",
                "Plugin activated without a published generation",
            )
        })?;
    Ok(Json(json!({
        "protocolVersion": PROTOCOL_VERSION,
        "plugin": { "publisher": package.publisher, "id": package.id.as_str() },
        "generation": generation,
        "packageDigest": digest,
        "state": "active",
    })))
}

async fn published_generation(state: &DevState, plugin_id: &str) -> Option<u64> {
    sqlx::query_scalar::<_, i64>(
        "SELECT generation_id FROM plugin_generations_v4
         WHERE plugin_id = ? AND state IN ('active','active_degraded')
         ORDER BY generation_id DESC LIMIT 1",
    )
    .bind(plugin_id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
    .and_then(|value| u64::try_from(value).ok())
}

fn notify_contributions_changed(state: &DevState, generation: Option<u64>) {
    let payload = generation.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    });
    state.events.emit(CONTRIBUTIONS_CHANGED_EVENT, payload);
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[derive(Debug)]
struct DevError {
    status: StatusCode,
    code: &'static str,
    message: String,
    published_generation: Option<u64>,
}

impl DevError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            published_generation: None,
        }
    }

    fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    fn not_found(id: &str) -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "plugin_not_found",
            format!("Plugin `{id}` is not installed"),
        )
    }

    fn plugin(error: plugins::PluginError) -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "plugin_operation_failed",
            error.to_string(),
        )
    }

    fn database(error: sqlx::Error) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "plugin_registry_failed",
            error.to_string(),
        )
    }

    fn worker(error: plugins::WorkerHostError, published_generation: Option<u64>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "plugin_candidate_failed",
            message: error.to_string(),
            published_generation,
        }
    }

    fn with_published_generation(mut self, published_generation: Option<u64>) -> Self {
        self.published_generation = published_generation;
        self
    }
}

impl IntoResponse for DevError {
    fn into_response(self) -> Response<Body> {
        (
            self.status,
            Json(json!({
                "error": {
                    "code": self.code,
                    "message": self.message,
                    "retryable": false,
                    "diagnosticId": Value::Null,
                    "publishedGeneration": self.published_generation,
                    "details": Value::Null,
                }
            })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_a_loopback_connection_for_developer_tooling() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("plugin-dev.json");
        persist_connection(
            &path,
            &PluginDevConnection {
                endpoint: "http://127.0.0.1:43100".to_owned(),
                token: "dev-token".to_owned(),
                protocol_version: PROTOCOL_VERSION,
            },
        )
        .unwrap();
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["url"], "http://127.0.0.1:43100");
        assert_eq!(raw["token"], "dev-token");
        assert_eq!(raw["protocolVersion"], "1.0");
    }

    #[test]
    fn constant_time_token_comparison_requires_exact_match() {
        assert!(constant_time_eq(b"same-secret", b"same-secret"));
        assert!(!constant_time_eq(b"same-secret", b"diff-secret"));
        assert!(!constant_time_eq(b"short", b"longer-secret"));
    }

    #[test]
    fn linked_candidates_inherit_full_trust_grants() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join(".dimo-plugin")).unwrap();
        std::fs::create_dir_all(root.path().join("skills/sample")).unwrap();
        std::fs::write(root.path().join("skills/sample/SKILL.md"), "# Sample\n").unwrap();
        std::fs::write(
            root.path().join(".dimo-plugin/plugin.json"),
            json!({
                "manifestVersion": 4,
                "apiVersion": "1.0",
                "id": "permission-test",
                "publisher": "dev.test",
                "version": "1.0.0",
                "name": "Permission test",
                "engines": { "dimo": ">=0.1.3", "pluginSdk": "^1.0.0" },
                "permissions": [{
                    "id": "preview",
                    "capability": "artifact.preview",
                    "scope": { "providers": ["sample"] },
                    "reason": "Preview"
                }],
                "contributes": {
                    "agent.skills": [{
                        "id": "sample", "kindVersion": 1,
                        "path": "skills/sample", "targets": ["codex"]
                    }]
                }
            })
            .to_string(),
        )
        .unwrap();
        let package =
            plugins::PluginPackage::inspect(root.path(), plugins::PluginSourceKind::DeveloperLink)
                .unwrap();

        let grants = selected_grants(&package).unwrap();
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0].capability, "artifact.preview");
    }

    #[tokio::test]
    async fn end_to_end_live_plugin_dev_protocol_flow() {
        use deployment::Deployment as _;

        let data_dir = tempfile::tempdir().unwrap();
        let deployment = local_deployment::LocalDeployment::new_at(data_dir.path())
            .await
            .unwrap();
        let pool = deployment.db().pool.clone();

        let registry = Arc::new(plugins::SqlitePluginRegistry::new(pool.clone()));
        let plugin_plane = Arc::new(plugins::PluginControlPlane::new(registry));
        let preview_host: Arc<dyn plugins::PluginPreviewHost> = Arc::new(
            plugins::ExternalProcessPreviewHost::new(plugin_plane.clone()),
        );
        let broker = Arc::new(plugins::HostCapabilityBroker::new(
            plugin_plane.clone(),
            preview_host,
        ));
        let worker_runtime = Arc::new(plugins::PluginWorkerRuntimeProvider::new(
            data_dir.path().to_path_buf(),
        ));
        let events = Arc::new(crate::HostEventBus::default());
        let mut event_rx = events.subscribe();

        let connection_path = data_dir.path().join("plugin-dev.json");
        let handle = start(PluginDevServerConfig {
            plugins: plugin_plane,
            pool,
            broker,
            worker_runtime,
            runtime_root: data_dir.path().join("plugins/runtimes"),
            candidate_root: data_dir.path().join("plugins/dev-candidates"),
            connection_path: Some(connection_path.clone()),
            events,
        })
        .await
        .unwrap();

        let endpoint = handle.connection().endpoint.clone();
        let token = handle.connection().token.clone();
        assert!(endpoint.starts_with("http://127.0.0.1:"));
        assert!(token.len() >= 32);
        assert!(connection_path.is_file());

        let client = reqwest::Client::builder().no_proxy().build().unwrap();

        // 1. Rejects missing/invalid credentials.
        let unauth = client
            .get(format!(
                "{endpoint}/api/plugin-dev/v1/plugins/acme/acme.live/doctor"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(unauth.status(), reqwest::StatusCode::UNAUTHORIZED);
        let unauth_json: Value = unauth.json().await.unwrap();
        assert_eq!(unauth_json["error"]["code"], "plugin_dev_unauthorized");

        // 2. Rejects non-JSON body with structured protocol error.
        let non_json = client
            .post(format!("{endpoint}/api/plugin-dev/v1/linked-installations"))
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION)
            .header(TOKEN_HEADER, &token)
            .header(reqwest::header::CONTENT_TYPE, "text/plain")
            .body("hello")
            .send()
            .await
            .unwrap();
        assert_eq!(
            non_json.status(),
            reqwest::StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        let non_json_body: Value = non_json.json().await.unwrap();
        assert_eq!(
            non_json_body["error"]["code"],
            "plugin_dev_unsupported_media_type"
        );

        // 3. Prepare local linked plugin package and install it.
        let plugin_src = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(plugin_src.path().join(".dimo-plugin")).unwrap();
        std::fs::create_dir_all(plugin_src.path().join("skills/live")).unwrap();
        std::fs::write(
            plugin_src.path().join("skills/live/SKILL.md"),
            "# Live v1\n",
        )
        .unwrap();
        std::fs::write(
            plugin_src.path().join(".dimo-plugin/plugin.json"),
            json!({
                "manifestVersion": 4,
                "apiVersion": "1.0",
                "id": "acme.live",
                "publisher": "acme",
                "version": "1.0.0",
                "name": "Live Dev Plugin",
                "engines": { "dimo": ">=0.1.3", "pluginSdk": "^1.0.0" },
                "contributes": {
                    "agent.skills": [{
                        "id": "live",
                        "kindVersion": 1,
                        "path": "skills/live",
                        "targets": ["codex"]
                    }]
                }
            })
            .to_string(),
        )
        .unwrap();
        let digest_v1 = plugins::package_content_digest(plugin_src.path()).unwrap();

        let installed = client
            .post(format!("{endpoint}/api/plugin-dev/v1/linked-installations"))
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION)
            .header(TOKEN_HEADER, &token)
            .json(&json!({
                "sourcePath": plugin_src.path().to_string_lossy(),
                "expected": {
                    "publisher": "acme",
                    "pluginId": "acme.live",
                    "version": "1.0.0",
                    "packageDigest": digest_v1,
                }
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(installed.status(), reqwest::StatusCode::OK);
        let installed_json: Value = installed.json().await.unwrap();
        assert_eq!(installed_json["protocolVersion"], "1.0");
        assert_eq!(installed_json["state"], "active");
        assert_eq!(installed_json["packageDigest"], digest_v1);
        let gen_v1 = installed_json["generation"].as_u64().unwrap();
        assert!(gen_v1 >= 1);

        // Verify real-time UI notification event emitted.
        let event = tokio::time::timeout(std::time::Duration::from_secs(2), event_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.channel, CONTRIBUTIONS_CHANGED_EVENT);

        // 4. Doctor reports clean linked installation with all required inventory arrays.
        let doctor_res = client
            .get(format!(
                "{endpoint}/api/plugin-dev/v1/plugins/acme/acme.live/doctor"
            ))
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION)
            .header(TOKEN_HEADER, &token)
            .send()
            .await
            .unwrap();
        assert_eq!(doctor_res.status(), reqwest::StatusCode::OK);
        let doctor_json: Value = doctor_res.json().await.unwrap();
        assert_eq!(doctor_json["protocolVersion"], "1.0");
        assert_eq!(doctor_json["activation"]["enabled"], true);
        assert_eq!(doctor_json["activation"]["generation"], gen_v1);
        assert_eq!(doctor_json["sourceKind"], "linked");
        assert!(doctor_json["grants"].is_array());
        assert!(doctor_json["runtimes"].is_array());
        assert!(doctor_json["contributions"].is_array());
        assert!(doctor_json["agentBindings"].is_array());
        assert!(doctor_json["recentCrashes"].is_array());
        assert_eq!(doctor_json["diagnostics"].as_array().map(Vec::len), Some(0));

        // 5. Mutate source: mismatched digest is rejected while preserving publishedGeneration.
        std::fs::write(
            plugin_src.path().join("skills/live/SKILL.md"),
            "# Live v2\n",
        )
        .unwrap();
        let digest_v2 = plugins::package_content_digest(plugin_src.path()).unwrap();
        assert_ne!(digest_v1, digest_v2);

        let mismatch = client
            .post(format!(
                "{endpoint}/api/plugin-dev/v1/plugins/acme/acme.live/candidates"
            ))
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION)
            .header(TOKEN_HEADER, &token)
            .json(&json!({
                "sourcePath": plugin_src.path().to_string_lossy(),
                "expectedPackageDigest": digest_v1,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(mismatch.status(), reqwest::StatusCode::CONFLICT);
        let mismatch_json: Value = mismatch.json().await.unwrap();
        assert_eq!(
            mismatch_json["error"]["code"],
            "plugin_dev_expectation_mismatch"
        );
        assert_eq!(mismatch_json["error"]["publishedGeneration"], gen_v1);

        // 6. Valid candidate hot reload advances published generation.
        let reloaded = client
            .post(format!(
                "{endpoint}/api/plugin-dev/v1/plugins/acme/acme.live/candidates"
            ))
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION)
            .header(TOKEN_HEADER, &token)
            .json(&json!({
                "sourcePath": plugin_src.path().to_string_lossy(),
                "expectedPackageDigest": digest_v2,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(reloaded.status(), reqwest::StatusCode::OK);
        let reloaded_json: Value = reloaded.json().await.unwrap();
        assert_eq!(reloaded_json["packageDigest"], digest_v2);
        let gen_v2 = reloaded_json["generation"].as_u64().unwrap();
        assert!(gen_v2 > gen_v1);

        // 7. Uninstall deletes plugin data when retainData is false.
        let uninstalled = client
            .delete(format!(
                "{endpoint}/api/plugin-dev/v1/plugins/acme/acme.live/linked-installation"
            ))
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION)
            .header(TOKEN_HEADER, &token)
            .json(&json!({ "retainData": false }))
            .send()
            .await
            .unwrap();
        assert_eq!(uninstalled.status(), reqwest::StatusCode::OK);
        let uninstalled_json: Value = uninstalled.json().await.unwrap();
        assert_eq!(uninstalled_json["removed"], true);
        assert_eq!(uninstalled_json["dataRetention"], "deleted");

        let gone = client
            .get(format!(
                "{endpoint}/api/plugin-dev/v1/plugins/acme/acme.live/doctor"
            ))
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION)
            .header(TOKEN_HEADER, &token)
            .send()
            .await
            .unwrap();
        assert_eq!(gone.status(), reqwest::StatusCode::NOT_FOUND);

        // 8. Dropping handle cleans up plugin-dev.json and stops listener task.
        drop(handle);
        assert!(!connection_path.exists());
    }
}
