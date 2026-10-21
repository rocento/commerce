use api_gateway::{analytics::Client, identity, reporting};
use axum::{body::Body, http::Request};
use infra_auth::Security;
use sqlx::PgPool;
use tower::ServiceExt;

use uuid::Uuid;

#[sqlx::test(migrations = "../../migrations")]
async fn report_permission_and_range_are_enforced_before_analytics(pool: PgPool) {
    let security = Security::new(
        "reporting-test-secret-".repeat(3),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let app = identity::App::new(pool.clone(), security, vec![]);
    // Unreachable analytics server proves rejected requests never attempt analytical reads.
    let router = reporting::router(reporting::App {
        identity: app,
        analytics: Client::new(
            "http://127.0.0.1:1".into(),
            "unused".into(),
            "unused".into(),
        ),
    });
    let path = "/v1/admin/reports/dashboard?from=2026-01-01&to=2026-01-31";
    let response = router
        .clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let role = Uuid::new_v4();
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'report-test','{}')")
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'report-test@example.test','Reporter','!', $2)").bind(user).bind(role).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest("report-test-token")).bind(user).execute(&pool).await.unwrap();
    let cookie = "admin_session=report-test-token";
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(path)
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    let denied = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/admin/reports/assistant")
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        denied.status(),
        403,
        "assistant telemetry requires reporting permission before provider access"
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['reports.read'] WHERE id=$1")
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    for invalid in [
        "from=2026-02-01&to=2026-01-01",
        "from=2020-01-01&to=2026-01-01",
        "from=2026-01-01&to=2099-01-01",
        "from=not-a-date&to=2026-01-01",
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/admin/reports/dashboard?{invalid}"))
                    .header("cookie", cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 400);
    }
    let unavailable = router
        .oneshot(
            Request::builder()
                .uri(path)
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unavailable.status(), 503);
    assert_eq!(unavailable.headers()["retry-after"], "3");
    let body = axum::body::to_bytes(unavailable.into_body(), 4096)
        .await
        .unwrap();
    let body = String::from_utf8(body.to_vec()).unwrap();
    assert!(body.contains("temporarily unavailable"));
    assert!(
        !body.contains("127.0.0.1"),
        "provider details must stay private"
    );
}

#[tokio::test]
#[ignore = "requires a disposable ClickHouse at CLICKHOUSE_TEST_URL"]
async fn assistant_report_deduplicates_and_scopes_real_telemetry() {
    let client = Client::new(
        std::env::var("CLICKHOUSE_TEST_URL").expect("isolated ClickHouse URL"),
        "commerce_test".into(),
        "isolated-test-only".into(),
    );
    let tenant = Uuid::new_v4();
    let id = Uuid::new_v4();
    let metric = || api_gateway::assistant::Metric {
        request_id: id,
        outcome: "completed".into(),
        latency_ms: 100,
        created_at: chrono::Utc::now(),
    };
    client
        .assistant_metrics(tenant, vec![metric()])
        .await
        .unwrap();
    client
        .assistant_metrics(tenant, vec![metric()])
        .await
        .unwrap();
    client
        .assistant_metrics(
            tenant,
            vec![api_gateway::assistant::Metric {
                request_id: Uuid::new_v4(),
                outcome: "unavailable".into(),
                latency_ms: 300,
                created_at: chrono::Utc::now(),
            }],
        )
        .await
        .unwrap();
    client
        .assistant_metrics(Uuid::new_v4(), vec![metric()])
        .await
        .unwrap();
    let report = client.assistant_report(tenant).await.unwrap();
    assert_eq!(report.total, 2);
    assert_eq!(report.completed, 1);
    assert_eq!(report.unavailable, 1);
    assert_eq!(report.average_latency_ms, Some(200.0));
    let empty = client.assistant_report(Uuid::new_v4()).await.unwrap();
    assert_eq!(empty.total, 0);
    assert_eq!(empty.average_latency_ms, None);
}

#[sqlx::test(migrations = "../../migrations")]
async fn failed_snapshot_never_publishes_completion(pool: PgPool) {
    use std::sync::{Arc, Mutex};
    let queries = Arc::new(Mutex::new(Vec::<String>::new()));
    let captured = queries.clone();
    let server = axum::Router::new().route(
        "/",
        axum::routing::post(
            move |axum::extract::Query(q): axum::extract::Query<
                std::collections::HashMap<String, String>,
            >| {
                let captured = captured.clone();
                async move {
                    let query = q.get("query").cloned().unwrap_or_default();
                    captured.lock().unwrap().push(query.clone());
                    if query.contains("INSERT INTO product_performance_daily") {
                        axum::http::StatusCode::SERVICE_UNAVAILABLE
                    } else {
                        axum::http::StatusCode::OK
                    }
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
    let client = Client::new(format!("http://{address}"), "test".into(), "test".into());
    assert!(client.sync_reports(&pool).await.is_err());
    let queries = queries.lock().unwrap();
    assert!(queries
        .iter()
        .any(|q| q.contains("INSERT INTO sales_daily")));
    assert!(!queries
        .iter()
        .any(|q| q.contains("INSERT INTO reporting_runs")));
    task.abort();
}

#[sqlx::test(migrations = "../../migrations")]
async fn reporting_worker_retries_after_lock_contention_and_provider_failure(pool: PgPool) {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let attempts = Arc::new(AtomicUsize::new(0));
    let observed = attempts.clone();
    let server = axum::Router::new().route(
        "/",
        axum::routing::post(move || {
            observed.fetch_add(1, Ordering::SeqCst);
            async { axum::http::StatusCode::SERVICE_UNAVAILABLE }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server_task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
    let mut lock = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(88008)")
        .execute(&mut *lock)
        .await
        .unwrap();
    let client = Client::new(format!("http://{address}"), "test".into(), "test".into());
    let worker = tokio::spawn(client.reporting_worker(pool.clone()));
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    assert_eq!(attempts.load(Ordering::SeqCst), 0);
    lock.rollback().await.unwrap();
    let recovered = tokio::time::timeout(std::time::Duration::from_secs(13), async {
        while attempts.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await;
    worker.abort();
    server_task.abort();
    assert!(
        recovered.is_ok(),
        "worker must retry both lock contention and provider failure before the normal interval"
    );
}
