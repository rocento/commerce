//! Authoritative commerce readiness, cached briefly to bound probe load.
use axum::{
    extract::State,
    http::{header, StatusCode},
    routing::get,
    Json, Router,
};
use sqlx::PgPool;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

#[derive(Clone)]
struct Probe {
    pool: Option<PgPool>,
    cached: Arc<Mutex<Option<(Instant, bool)>>>,
    workers: crate::workers::Health,
}
pub fn router(pool: Option<PgPool>) -> Router {
    router_with_workers(pool, crate::workers::Health::default())
}
pub fn router_with_workers(pool: Option<PgPool>, workers: crate::workers::Health) -> Router {
    Router::new().route("/ready", get(ready)).with_state(Probe {
        pool,
        cached: Arc::new(Mutex::new(None)),
        workers,
    })
}
async fn ready(
    State(probe): State<Probe>,
) -> (
    StatusCode,
    [(header::HeaderName, &'static str); 1],
    Json<serde_json::Value>,
) {
    let mut cached = probe.cached.lock().await;
    let database_available = if let Some((at, ok)) = *cached {
        if at.elapsed() < Duration::from_secs(2) {
            ok
        } else {
            check(&probe.pool).await
        }
    } else {
        check(&probe.pool).await
    };
    // Do not extend the cache on a hit: sustained probes must still check the DB.
    if cached
        .as_ref()
        .is_none_or(|(at, _)| at.elapsed() >= Duration::from_secs(2))
    {
        *cached = Some((Instant::now(), database_available));
    }
    // Worker exits invalidate readiness immediately, even while the DB probe is cached.
    let available = database_available && probe.workers.available();
    (
        if available {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({
            "status":if available {"ready"} else {"unavailable"},
            "dependencies":{
                "database":if database_available {"ready"}else{"unavailable"},
                "workers":probe.workers.status()
            }
        })),
    )
}
async fn check(pool: &Option<PgPool>) -> bool {
    let Some(pool) = pool else {
        return false;
    };
    matches!(tokio::time::timeout(Duration::from_secs(1),sqlx::query_scalar::<_,bool>(
        "SELECT to_regclass('customers.customers') IS NOT NULL AND to_regclass('catalog.products') IS NOT NULL AND to_regclass('inventory.reservations') IS NOT NULL AND to_regclass('orders.orders') IS NOT NULL"
    ).fetch_one(pool)).await,Ok(Ok(true)))
}
