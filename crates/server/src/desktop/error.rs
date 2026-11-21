use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use remote_protocol::{ErrorCode, ErrorEnvelope, OperationId};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum DesktopError {
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Bad request: {0}")]
    BadRequest(String),
    #[error("Internal error: {0}")]
    Internal(String),
    #[error("Conflict: {0}")]
    Conflict(String),
}

impl Serialize for DesktopError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<anyhow::Error> for DesktopError {
    fn from(error: anyhow::Error) -> Self {
        Self::Internal(error.to_string())
    }
}

impl From<sqlx::Error> for DesktopError {
    fn from(error: sqlx::Error) -> Self {
        Self::Internal(error.to_string())
    }
}

impl From<serde_json::Error> for DesktopError {
    fn from(error: serde_json::Error) -> Self {
        Self::Internal(error.to_string())
    }
}

impl IntoResponse for DesktopError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Self::NotFound(message) => (StatusCode::NOT_FOUND, ErrorCode::NotFound, message),
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, ErrorCode::BadRequest, message),
            Self::Conflict(message) => (StatusCode::CONFLICT, ErrorCode::Conflict, message),
            Self::Internal(message) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                ErrorCode::Internal,
                message,
            ),
        };
        (
            status,
            Json(ErrorEnvelope::new(code, message, false, OperationId::new())),
        )
            .into_response()
    }
}
