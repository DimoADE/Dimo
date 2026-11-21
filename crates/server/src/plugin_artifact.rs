use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, Request, State},
    http::{StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::get,
};
use plugins::{PluginActivation, PluginControlPlane};
use remote_protocol::{ErrorCode, ErrorEnvelope, OperationId};

pub async fn start_plugin_artifact_http(plugins: Arc<PluginControlPlane>) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    plugins::set_artifact_origin(format!("http://{address}"));
    let router = Router::new()
        .route("/{plugin_id}/{*path}", get(serve_loopback_plugin_artifact))
        .with_state(plugins);
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::warn!(%error, "Plugin artifact server stopped");
        }
    });
    Ok(())
}

/// Authenticates `/api/v1/plugin-artifacts/{plugin_id}/{*path}` requests using
/// either `Authorization: Bearer <token>` or a `?token=<token>` query parameter
/// (required for browser subresource tags such as `<img>`, `<script>`, `<link>`).
pub(crate) async fn require_plugin_artifact_token<R>(
    State(state): State<Arc<crate::runtime::ServerState<R>>>,
    mut request: Request,
    next: Next,
) -> Response {
    let candidate = extract_artifact_token(&request);
    if let Some(candidate) = candidate {
        match state
            .authenticate_bearer_token(&candidate, request.headers())
            .await
        {
            Ok(Some(credential)) => {
                request.extensions_mut().insert(credential);
                return next.run(request).await;
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(%error, "plugin artifact authentication failed");
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(ErrorEnvelope::new(
                        ErrorCode::Internal,
                        "authentication store unavailable",
                        true,
                        OperationId::new(),
                    )),
                )
                    .into_response();
            }
        }
    }

    (
        StatusCode::UNAUTHORIZED,
        Json(ErrorEnvelope::new(
            ErrorCode::Unauthorized,
            "invalid or missing bearer token",
            false,
            OperationId::new(),
        )),
    )
        .into_response()
}

fn extract_artifact_token(request: &Request) -> Option<String> {
    if let Some(token) = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_bearer_token)
    {
        return Some(token);
    }

    let query = request.uri().query()?;
    url::form_urlencoded::parse(query.as_bytes()).find_map(|(key, value)| {
        if key == "token" {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_owned())
        } else {
            None
        }
    })
}

fn parse_bearer_token(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let rest = trimmed
        .strip_prefix("Bearer ")
        .or_else(|| trimmed.strip_prefix("bearer "))
        .or_else(|| trimmed.strip_prefix("BEARER "))?;
    let token = rest.trim();
    (!token.is_empty()).then(|| token.to_owned())
}

pub async fn serve_runtime_plugin_artifact<R>(
    State(state): State<Arc<crate::runtime::ServerState<R>>>,
    Path((plugin_id, path)): Path<(String, String)>,
) -> Response {
    let Some(plugins) = state.plugin_control_plane.clone() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Do NOT attach `Access-Control-Allow-Origin: *` here: the outer
    // `enforce_origin` middleware in `runtime.rs` applies origin-checked CORS.
    serve_plugin_artifact_inner(&plugins, &plugin_id, &path, false).await
}

async fn serve_loopback_plugin_artifact(
    State(plugins): State<Arc<PluginControlPlane>>,
    Path((plugin_id, path)): Path<(String, String)>,
) -> Response {
    // Dedicated 127.0.0.1 loopback server used by desktop module federation.
    serve_plugin_artifact_inner(&plugins, &plugin_id, &path, true).await
}

async fn serve_plugin_artifact_inner(
    plugins: &PluginControlPlane,
    plugin_id: &str,
    path: &str,
    allow_wildcard_cors: bool,
) -> Response {
    let Ok(Some(plugin)) = plugins.plugin(plugin_id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if plugin.activation != PluginActivation::Enabled {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(file) = plugin.package.checked_file(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(bytes) = tokio::fs::read(file).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let content_type = content_type_for_path(path);
    let mut response = (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        bytes,
    )
        .into_response();
    if allow_wildcard_cors {
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            axum::http::HeaderValue::from_static("*"),
        );
    }
    response
}

fn content_type_for_path(path: &str) -> &'static str {
    let ext = path
        .rsplit('.')
        .next()
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use application::{ApplicationCore, SqliteConversationRepository};
    use axum::{body::Body, http::Request};
    use plugins::{
        ConflictDecision, InMemoryPluginRegistry, PluginControlPlane, PluginPackage,
        PluginSourceKind,
    };
    use tower::ServiceExt;

    use crate::{ServerConfig, ServerRuntime, ServerToken};

    async fn build_artifact_test_runtime() -> (tempfile::TempDir, axum::Router, String) {
        let temp = tempfile::tempdir().unwrap();
        let plugin_dir = temp.path().join("demo-plugin");
        std::fs::create_dir_all(plugin_dir.join(".dimo-plugin")).unwrap();
        std::fs::write(
            plugin_dir.join(".dimo-plugin").join("plugin.json"),
            serde_json::json!({
                "id": "demo.artifact",
                "name": "Demo Artifact Plugin",
                "version": "1.0.0",
                "apiVersion": "2.0",
                "description": "test"
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(plugin_dir.join("index.js"), "export const ok = true;\n").unwrap();
        std::fs::write(temp.path().join("secret.txt"), "top-secret").unwrap();

        let package = PluginPackage::inspect(&plugin_dir, PluginSourceKind::Snapshot).unwrap();
        let control_plane = Arc::new(PluginControlPlane::new(Arc::new(
            InMemoryPluginRegistry::default(),
        )));
        control_plane
            .import(package, ConflictDecision::Replace)
            .await
            .unwrap();
        control_plane
            .set_enabled("demo.artifact", true)
            .await
            .unwrap();

        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        let secret = "test-artifact-secret-token-12345".to_string();
        let token = ServerToken::try_new(secret.clone()).unwrap();
        let core = ApplicationCore::new(SqliteConversationRepository::new(pool));
        let runtime = ServerRuntime::new(ServerConfig::default(), token, core)
            .with_plugin_control_plane(control_plane);

        (temp, runtime.router(), secret)
    }

    #[tokio::test]
    async fn runtime_plugin_artifacts_require_auth_enforce_cors_and_block_traversal() {
        let (_temp, router, token) = build_artifact_test_runtime().await;

        // 1. Unauthenticated -> 401 Unauthorized.
        let unauth = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/plugin-artifacts/demo.artifact/index.js")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauth.status(), axum::http::StatusCode::UNAUTHORIZED);

        // 2. Authenticated via Bearer token -> 200 OK without wildcard CORS.
        let bearer_resp = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/plugin-artifacts/demo.artifact/index.js")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bearer_resp.status(), axum::http::StatusCode::OK);
        assert!(
            bearer_resp
                .headers()
                .get(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .is_none(),
            "runtime plugin artifact endpoint must not emit wildcard ACAO"
        );
        let body = axum::body::to_bytes(bearer_resp.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"export const ok = true;\n");

        // 3. Authenticated via ?token= query param -> 200 OK.
        let query_resp = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/v1/plugin-artifacts/demo.artifact/index.js?token={token}"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(query_resp.status(), axum::http::StatusCode::OK);

        // 4. Disallowed Origin -> 403 Forbidden via enforce_origin.
        let bad_origin = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/plugin-artifacts/demo.artifact/index.js")
                    .header("authorization", format!("Bearer {token}"))
                    .header("origin", "https://evil.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bad_origin.status(), axum::http::StatusCode::FORBIDDEN);

        // 5. Allowed loopback Origin -> echoes specific origin, never "*".
        let good_origin = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/plugin-artifacts/demo.artifact/index.js")
                    .header("authorization", format!("Bearer {token}"))
                    .header("origin", "http://127.0.0.1:4173")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(good_origin.status(), axum::http::StatusCode::OK);
        assert_eq!(
            good_origin
                .headers()
                .get(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .and_then(|v| v.to_str().ok()),
            Some("http://127.0.0.1:4173")
        );

        // 6. Path traversal blocked -> 404 Not Found.
        let traversal = router
            .oneshot(
                Request::builder()
                    .uri("/api/v1/plugin-artifacts/demo.artifact/..%2Fsecret.txt")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(traversal.status(), axum::http::StatusCode::NOT_FOUND);
    }
}
