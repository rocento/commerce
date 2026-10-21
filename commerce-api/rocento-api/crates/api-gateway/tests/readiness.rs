mod support;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use sqlx::PgPool;
use tower::ServiceExt;

fn validate_readiness(body: &serde_json::Value) {
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        body,
        &contract["components"]["schemas"]["Readiness"],
        &contract,
    );
}

#[tokio::test]
async fn liveness_without_database_does_not_claim_commerce_readiness() {
    let router = api_gateway::router();
    let live = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(live.status(), 200);
    let ready = router
        .oneshot(
            Request::builder()
                .uri("/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ready.status(), 503);
    assert_eq!(ready.headers()["cache-control"], "no-store");
    let body: serde_json::Value =
        serde_json::from_slice(&ready.into_body().collect().await.unwrap().to_bytes()).unwrap();
    validate_readiness(&body);
    assert_eq!(body["dependencies"]["workers"], "not_configured");
}
#[sqlx::test(migrations = "../../migrations")]
async fn readiness_requires_accessible_commerce_schema(pool: PgPool) {
    let router = api_gateway::router_with_readiness(Some(pool.clone()));
    let response = router
        .oneshot(
            Request::builder()
                .uri("/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    validate_readiness(&body);
    assert_eq!(body["dependencies"]["database"], "ready");
    pool.close().await;
    let router = api_gateway::router_with_readiness(Some(pool));
    let response = router
        .oneshot(
            Request::builder()
                .uri("/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 503);
    let body: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    validate_readiness(&body);
}

#[sqlx::test(migrations = "../../migrations")]
async fn worker_failure_invalidates_cached_readiness_without_breaking_liveness(pool: PgPool) {
    let mut workers = api_gateway::workers::Supervisor::default();
    let (stop, stopping) = tokio::sync::oneshot::channel();
    workers.spawn("inventory-expiry", async move {
        let _ = stopping.await;
    });
    let router = api_gateway::router_with_worker_readiness(Some(pool), workers.health());
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    validate_readiness(&body);
    assert_eq!(body["dependencies"]["workers"], "running");

    stop.send(()).unwrap();
    assert_eq!(
        workers.next_failure().await.unwrap().name,
        "inventory-expiry"
    );
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 503);
    let body: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    validate_readiness(&body);
    assert_eq!(body["dependencies"]["database"], "ready");
    assert_eq!(body["dependencies"]["workers"], "unavailable");
    assert_eq!(
        router
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
        200
    );
    workers.shutdown().await;
}
