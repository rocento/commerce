//! Bound handler admission and pre-response execution; streamed bodies retain their
//! endpoint-specific limits. Probe routes stay available when commerce is saturated.
use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct Budget {
    slots: Arc<Semaphore>,
    timeout: Duration,
}

impl Budget {
    fn new(max_in_flight: usize, timeout: Duration) -> Self {
        Self {
            slots: Arc::new(Semaphore::new(max_in_flight)),
            timeout,
        }
    }

    pub fn from_environment() -> Result<Self, &'static str> {
        fn setting(
            name: &str,
            default: usize,
            min: usize,
            max: usize,
        ) -> Result<usize, &'static str> {
            let value = match std::env::var(name) {
                Ok(value) => value.parse().map_err(|_| "Invalid HTTP request budget")?,
                Err(std::env::VarError::NotPresent) => default,
                Err(_) => return Err("Invalid HTTP request budget"),
            };
            (min..=max)
                .contains(&value)
                .then_some(value)
                .ok_or("Invalid HTTP request budget")
        }
        Ok(Self::new(
            setting("HTTP_MAX_IN_FLIGHT", 256, 1, 4096)?,
            Duration::from_millis(setting("HTTP_REQUEST_TIMEOUT_MS", 30000, 100, 120000)? as u64),
        ))
    }
}

fn unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [
            (header::RETRY_AFTER, "3"),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        Json(serde_json::json!({"error":"Service temporarily unavailable"})),
    )
        .into_response()
}

pub async fn enforce(State(budget): State<Budget>, request: Request, next: Next) -> Response {
    if matches!(request.uri().path(), "/health" | "/ready" | "/metrics") {
        return next.run(request).await;
    }
    let Ok(_permit) = budget.slots.try_acquire() else {
        return unavailable();
    };
    match tokio::time::timeout(budget.timeout, next.run(request)).await {
        Ok(response) => response,
        Err(_) => unavailable(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request, middleware, routing::get, Router};
    use tower::ServiceExt;

    fn router(budget: Budget) -> Router {
        Router::new()
            .route("/work", get(|| async { StatusCode::OK }))
            .route(
                "/slow",
                get(|| async {
                    std::future::pending::<()>().await;
                    StatusCode::OK
                }),
            )
            .route("/health", get(|| async { StatusCode::OK }))
            .layer(middleware::from_fn_with_state(budget, enforce))
            .layer(middleware::from_fn(infra_observability::request_trace))
    }

    #[tokio::test]
    async fn saturation_sheds_work_but_keeps_probes_available() {
        let budget = Budget::new(1, Duration::from_secs(1));
        let app = router(budget.clone());
        let held = budget.slots.acquire().await.unwrap();
        let response = app
            .clone()
            .oneshot(Request::builder().uri("/work").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[header::RETRY_AFTER], "3");
        assert!(response.headers().contains_key("x-trace-id"));
        let (_, metrics) = infra_observability::metrics().await;
        assert!(metrics.contains("commerce_http_errors_total{route=\"/work\",method=\"GET\"} 1\n"));
        assert_eq!(
            app.clone()
                .oneshot(
                    Request::builder()
                        .uri("/health")
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        drop(held);
        assert_eq!(
            app.oneshot(Request::builder().uri("/work").body(Body::empty()).unwrap())
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn deadline_cancels_handler_and_releases_admission() {
        let budget = Budget::new(1, Duration::from_millis(20));
        let app = router(budget);
        let response = app
            .clone()
            .oneshot(Request::builder().uri("/slow").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(response.headers().contains_key("x-trace-id"));
        let (_, metrics) = infra_observability::metrics().await;
        assert!(metrics.contains("commerce_http_errors_total{route=\"/slow\",method=\"GET\"} 1\n"));
        assert_eq!(
            app.oneshot(Request::builder().uri("/work").body(Body::empty()).unwrap())
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
}
