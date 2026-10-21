//! Merchant documentation is a separately reviewed projection, never the internal contract.
use crate::identity::{self, ApiError, App};
use axum::{
    extract::{Request, State},
    http::{header, HeaderMap},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};

pub const PATH: &str = "/v1/admin/api-reference/openapi.json";
const CONTRACT: &str = include_str!("../../../merchant-openapi.json");

pub fn router(app: App) -> Router {
    Router::new()
        .route(PATH, get(reference))
        .layer(middleware::from_fn(private_headers))
        .with_state(app)
}

async fn reference(State(app): State<App>, headers: HeaderMap) -> Result<Response, ApiError> {
    let token = identity::cookie(&headers, "admin_session");
    if token.is_empty() {
        return Err(infra_auth::Error::Unauthorized.into());
    }
    // The deployment's existing pool chooses the merchant database. Never read
    // a tenant ID, host, target URL, or schema path from this request.
    let who = app.admins.authenticate(token).await?;
    who.require("api.docs.read")?;
    Ok(([(header::CONTENT_TYPE, "application/json")], CONTRACT).into_response())
}

async fn private_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    for (name, value) in [
        ("cache-control", "private, no-store"),
        ("vary", "Cookie"),
        ("x-content-type-options", "nosniff"),
        ("x-robots-tag", "noindex, nofollow, noarchive"),
        ("cross-origin-resource-policy", "same-origin"),
        ("referrer-policy", "no-referrer"),
    ] {
        response.headers_mut().insert(
            axum::http::HeaderName::from_static(name),
            axum::http::HeaderValue::from_static(value),
        );
    }
    response
}
