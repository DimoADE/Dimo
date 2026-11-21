use std::sync::Arc;

use axum::{
    Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use plugins::{PluginActivation, PluginControlPlane};

pub async fn start_plugin_artifact_http(plugins: Arc<PluginControlPlane>) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    plugins::set_artifact_origin(format!("http://{address}"));
    let router = Router::new()
        .route("/{plugin_id}/{*path}", get(serve_plugin_artifact))
        .with_state(plugins);
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::warn!(%error, "Plugin artifact server stopped");
        }
    });
    Ok(())
}

pub async fn serve_runtime_plugin_artifact<R>(
    State(state): State<Arc<crate::runtime::ServerState<R>>>,
    Path((plugin_id, path)): Path<(String, String)>,
) -> Response {
    let Some(plugins) = state.plugin_control_plane.clone() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    serve_plugin_artifact(State(plugins), Path((plugin_id, path))).await
}

async fn serve_plugin_artifact(
    State(plugins): State<Arc<PluginControlPlane>>,
    Path((plugin_id, path)): Path<(String, String)>,
) -> Response {
    let Ok(Some(plugin)) = plugins.plugin(&plugin_id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if plugin.activation != PluginActivation::Enabled {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(file) = plugin.package.checked_file(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(bytes) = tokio::fs::read(file).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let content_type = content_type_for_path(&path);
    (
        [
            (axum::http::header::CONTENT_TYPE, content_type),
            (axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
            (axum::http::header::CACHE_CONTROL, "no-cache"),
        ],
        bytes,
    )
        .into_response()
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
