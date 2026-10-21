//! Owns reporting snapshots, cart/order analytics, and optional assistant telemetry.
//! Order/shipment notification consumers and delivery belong to the commerce gateway.
use crate::{analytics::Client, assistant::Telemetry, workers::Supervisor};
use axum::{extract::State, http::StatusCode, routing::get, Json, Router};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::RwLock;

type Failure = Box<dyn std::error::Error + Send + Sync>;

#[derive(Clone)]
struct Health {
    initialized: Arc<AtomicBool>,
    tasks: crate::workers::Health,
    database: PgPool,
    analytics: Client,
    nats: Arc<RwLock<Option<async_nats::Client>>>,
}

async fn ready(State(state): State<Health>) -> (StatusCode, Json<serde_json::Value>) {
    let tasks = state.initialized.load(Ordering::Acquire) && state.tasks.available();
    let nats = state.nats.read().await.as_ref().is_some_and(|client| {
        client.connection_state() == async_nats::connection::State::Connected
    });
    // Bounded dependency probes are private to this worker, never gateway readiness.
    let (database, clickhouse) = tokio::join!(
        tokio::time::timeout(
            Duration::from_secs(1),
            sqlx::query("SELECT 1").execute(&state.database)
        ),
        tokio::time::timeout(
            Duration::from_secs(1),
            state.analytics.rows("SELECT 1 AS ready")
        )
    );
    let database = matches!(database, Ok(Ok(_)));
    let clickhouse = matches!(clickhouse, Ok(Ok(_)));
    let available = tasks && nats && database && clickhouse;
    (
        if available {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(
            serde_json::json!({"status": if available { "ready" } else { "unavailable" },
            "dependencies": {"workers":tasks,"database":database,"clickhouse":clickhouse,"nats":nats}}),
        ),
    )
}

fn pool(url: &str, connections: u32) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(connections)
        .min_connections(0)
        .acquire_timeout(Duration::from_secs(2))
        .connect_lazy(url)
}

async fn background(
    state: Health,
    reporting: PgPool,
    nats_url: String,
    assistant: Option<Telemetry>,
    mut workers: Supervisor,
) -> Result<(), Failure> {
    // Gateway owns commerce migrations. A worker may start before schema/analytics
    // dependencies are ready, but it must not mutate the commerce schema itself.
    loop {
        let initialize = async {
            let migrated: bool =
                sqlx::query_scalar("SELECT to_regclass('platform.consumer_receipts') IS NOT NULL")
                    .fetch_one(&state.database)
                    .await?;
            if !migrated {
                return Err::<(), Failure>("Commerce migrations are not ready".into());
            }
            let nats = async_nats::connect(&nats_url).await?;
            state.analytics.initialize().await?;
            *state.nats.write().await = Some(nats);
            Ok(())
        };
        if matches!(
            tokio::time::timeout(Duration::from_secs(60), initialize).await,
            Ok(Ok(()))
        ) {
            break;
        }
        tracing::warn!(
            "analytics dependencies are not initialized; retrying without affecting commerce"
        );
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    workers.spawn(
        "reporting",
        state.analytics.clone().reporting_worker(reporting),
    );
    // Preserve the analytics durable cursor; notification receipts are independent.
    workers.spawn(
        "order-analytics",
        state
            .analytics
            .clone()
            .consume_orders(state.database.clone(), nats_url.clone()),
    );
    workers.spawn(
        "cart-analytics",
        state
            .analytics
            .clone()
            .consume_cart(state.database.clone(), nats_url),
    );
    if let Some(assistant) = assistant {
        workers.spawn(
            "assistant-telemetry",
            crate::assistant::telemetry(assistant, state.analytics.clone()),
        );
    }
    state.initialized.store(true, Ordering::Release);
    let failure = workers
        .next_failure()
        .await
        .expect("analytics workers are registered");
    state.initialized.store(false, Ordering::Release);
    workers.shutdown().await;
    Err(Box::new(failure))
}

pub async fn run() -> Result<(), Failure> {
    let telemetry = infra_observability::init_service("commerce-analytics");
    let url = std::env::var("DATABASE_URL")?;
    // Retain the existing four-connection budget: three for event receipts and
    // probes, plus a separate one-connection reporting snapshot pool.
    let database = pool(&url, 3)?;
    let reporting = pool(&url, 1)?;
    let analytics = Client::new(
        std::env::var("CLICKHOUSE_URL")?,
        std::env::var("CLICKHOUSE_USER")?,
        std::env::var("CLICKHOUSE_PASSWORD")?,
    );
    let assistant = Telemetry::environment()?;
    let workers = Supervisor::default();
    let state = Health {
        initialized: Arc::new(AtomicBool::new(false)),
        tasks: workers.health(),
        database: database.clone(),
        analytics,
        nats: Arc::new(RwLock::new(None)),
    };
    let listener = tokio::net::TcpListener::bind(
        std::env::var("ANALYTICS_BIND_ADDRESS").unwrap_or_else(|_| "0.0.0.0:8082".into()),
    )
    .await?;
    let router = Router::new()
        .route("/health", get(|| async { Json(serde_json::json!({"status":"ok"})) }))
        .route("/ready", get(ready))
        .route("/metrics", get(|State(state): State<Health>| async move {
            let available = ready(State(state)).await.0 == StatusCode::OK;
            let (headers, mut metrics) = infra_observability::metrics().await;
            metrics.push_str(&format!("# TYPE commerce_analytics_worker_ready gauge\ncommerce_analytics_worker_ready {}\n", u8::from(available)));
            (headers, metrics)
        }))
        .with_state(state.clone());
    let mut runtime = tokio::spawn(background(
        state.clone(),
        reporting.clone(),
        std::env::var("NATS_URL")?,
        assistant,
        workers,
    ));
    let server = axum::serve(listener, router).into_future();
    tokio::pin!(server);
    let result = tokio::select! {
        result = &mut runtime => match result {
            Ok(result) => result,
            Err(error) => Err(Box::new(error) as Failure),
        },
        result = &mut server => result.map_err(|error| Box::new(error) as Failure),
        result = shutdown_signal() => result.map_err(|error| Box::new(error) as Failure),
    };
    state.initialized.store(false, Ordering::Release);
    // Dropping the supervisor cancels in-flight consumers. Uncommitted receipts
    // roll back, and unacknowledged JetStream messages remain replayable.
    if !runtime.is_finished() {
        runtime.abort();
        let _ = runtime.await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        database.close().await;
        reporting.close().await;
    })
    .await;
    if let Some(provider) = telemetry {
        let _ = provider.shutdown();
    }
    result
}

async fn shutdown_signal() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! { result = tokio::signal::ctrl_c() => result, _ = terminate.recv() => Ok(()) }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await
}

use std::future::IntoFuture;
