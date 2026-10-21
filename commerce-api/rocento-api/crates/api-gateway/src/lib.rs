pub mod account_deletion;
pub mod analytics;
pub mod analytics_worker;
pub mod api_reference;
pub mod areas;
pub mod auth_ip;
pub mod cart;
pub mod catalog;
pub mod config;
pub mod customer_journey;
pub mod identity;
pub mod login_alerts;
pub mod marketing_notifications;
pub mod msi;
pub mod notification_campaigns;
pub mod shopping;
pub mod storefront_notifications;
use axum::{routing::get, Json, Router};
use shared_kernel::HealthResponse;

pub mod readiness;
pub mod reliability;
pub mod workers;
pub fn router() -> Router {
    router_with_readiness(None)
}
pub fn router_with_readiness(pool: Option<sqlx::PgPool>) -> Router {
    router_with_worker_readiness(pool, workers::Health::default())
}
pub fn router_with_worker_readiness(
    pool: Option<sqlx::PgPool>,
    workers: workers::Health,
) -> Router {
    Router::new()
        .route("/health", get(|| async { Json(HealthResponse::default()) }))
        .merge(readiness::router_with_workers(pool, workers))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_contract() {
        let response = router()
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "application/json");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({"status": "ok"})
        );
    }
}

pub mod orders;

pub mod assistant;
mod assistant_baseline;
mod assistant_failures;

pub mod support;

pub mod admin_depth;
pub mod mobile;
pub mod themes;

pub mod reporting;

pub mod exports;
pub mod grids;

pub mod attributes;
pub mod replenishment;

pub mod commerce_notifications;
pub mod email_templates;
pub mod notifications;

pub mod assistant_catalog;

pub mod segments;

pub mod merchant;

pub mod assistant_settings;
pub mod assistant_trace;
pub mod assistant_tracking;
pub mod discoverability;

pub mod public_commerce;

pub mod capacity;

mod market;
mod markets;

pub mod localization;

pub mod request_budget;

pub mod engagement;

pub mod relationships;

pub mod order_push;
#[cfg(test)]
#[path = "../tests/support/signing.rs"]
pub(crate) mod test_signing;
