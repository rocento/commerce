use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug, Clone, thiserror::Error)]
#[error("{code}")]
pub struct ApiError {
    pub code: String,
    pub status: StatusCode,
}

impl ApiError {
    pub fn new(code: impl Into<String>, status: StatusCode) -> Self {
        Self {
            code: code.into(),
            status,
        }
    }

    pub fn bad(code: impl Into<String>) -> Self {
        Self::new(code, StatusCode::BAD_REQUEST)
    }

    pub fn unauthorized(code: impl Into<String>) -> Self {
        Self::new(code, StatusCode::UNAUTHORIZED)
    }

    pub fn forbidden(code: impl Into<String>) -> Self {
        Self::new(code, StatusCode::FORBIDDEN)
    }

    pub fn conflict(code: impl Into<String>) -> Self {
        Self::new(code, StatusCode::CONFLICT)
    }

    pub fn unavailable() -> Self {
        Self::new("SERVICE_UNAVAILABLE", StatusCode::SERVICE_UNAVAILABLE)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "code": self.code }))).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(%error, "database request failed");
        Self::unavailable()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
