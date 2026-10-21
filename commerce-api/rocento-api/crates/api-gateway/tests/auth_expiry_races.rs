//! Exercise expiry while a real authentication request waits on PostgreSQL locks.
use api_gateway::identity::{router, App};
use axum::{body::Body, http::Request, Router};
use http_body_util::BodyExt;
use infra_auth::{Notification, NotificationSink, Security};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tower::ServiceExt;
use uuid::Uuid;

#[derive(Default)]
struct Inbox(Mutex<Vec<Notification>>);
impl NotificationSink for Inbox {
    fn send(&self, notification: Notification) {
        self.0.lock().unwrap().push(notification);
    }
}

async fn fixture(pool: &PgPool) -> (App, Uuid, Arc<Inbox>) {
    let inbox = Arc::new(Inbox::default());
    let mut security = Security::new(
        "expiry-race-secret-at-least-32-characters".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    security.notifications = inbox.clone();
    let app = App::new(pool.clone(), security, vec!["http://localhost:5173".into()]);
    let customer = app.customers.register(credentials()).await.unwrap();
    (app, customer.id, inbox)
}

fn credentials() -> domain_customers::Credentials {
    domain_customers::Credentials {
        identifier: "expiry-race@example.test".into(),
        password: "Expiry race password!".into(),
    }
}

async fn request(router: Router, path: &str, payload: Value, cookie: &str) -> (u16, Value) {
    let response = router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("content-type", "application/json")
                .header("x-commerce-request", "1")
                .header("cookie", cookie)
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn wait_for_customer_lock(pool: &PgPool, blocker: i32) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)))",
            )
            .bind(blocker)
            .fetch_one(pool)
            .await
            .unwrap();
            if waiting {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the HTTP request must reach and wait on the customer row lock");
}

async fn challenge_expiry_race(pool: PgPool, purpose: &str) {
    let (app, customer, inbox) = fixture(&pool).await;
    let login = app.customers.login(credentials()).await.unwrap();
    if purpose == "reset" {
        app.customers
            .request_challenge(
                domain_customers::ChallengeRequest {
                    identifier: credentials().identifier,
                },
                "reset",
            )
            .await
            .unwrap();
    }
    let code = inbox
        .0
        .lock()
        .unwrap()
        .iter()
        .find(|notification| notification.purpose == purpose)
        .unwrap()
        .code
        .clone();
    let mut held = pool.begin().await.unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *held)
        .await
        .unwrap();
    sqlx::query("SELECT id FROM customers.customers WHERE id=$1 FOR UPDATE")
        .bind(customer)
        .execute(&mut *held)
        .await
        .unwrap();
    let mut payload = json!({"identifier":credentials().identifier,"token":code});
    let path = if purpose == "reset" {
        payload["password"] = json!("Replacement race password!");
        "/v1/customer/auth/reset-password"
    } else {
        "/v1/customer/auth/verify"
    };
    let http = router(app.clone());
    let attempt = tokio::spawn(async move { request(http, path, payload, "").await });
    wait_for_customer_lock(&pool, blocker).await;
    // The transaction has started, but the challenge expires before validation.
    sqlx::query("UPDATE customers.challenges SET expires_at=clock_timestamp() WHERE customer_id=$1 AND purpose=$2")
        .bind(customer)
        .bind(purpose)
        .execute(&pool)
        .await
        .unwrap();
    held.commit().await.unwrap();
    let (status, body) = attempt.await.unwrap();
    assert_eq!(
        status, 401,
        "expired {purpose} challenge was accepted: {body}"
    );
    assert!(!app.customers.customer(customer).await.unwrap().verified);
    assert!(app
        .customers
        .authenticate(&login.body.access_token)
        .await
        .is_ok());
    let emitted: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.outbox WHERE event_type IN ('customer.verified','customer.password_reset')")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(
        emitted, 0,
        "an expired challenge must not publish a success event"
    );
    if purpose == "reset" {
        assert!(app.customers.login(credentials()).await.is_ok());
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn verification_rechecks_expiry_after_customer_lock_wait(pool: PgPool) {
    challenge_expiry_race(pool, "verify").await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn password_reset_rechecks_expiry_after_customer_lock_wait(pool: PgPool) {
    challenge_expiry_race(pool, "reset").await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn refresh_rechecks_session_expiry_after_customer_lock_wait(pool: PgPool) {
    let (app, customer, _) = fixture(&pool).await;
    let login = app.customers.login(credentials()).await.unwrap();
    let mut held = pool.begin().await.unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *held)
        .await
        .unwrap();
    sqlx::query("SELECT id FROM customers.customers WHERE id=$1 FOR UPDATE")
        .bind(customer)
        .execute(&mut *held)
        .await
        .unwrap();
    let cookie = format!("customer_refresh={}", login.refresh);
    let http = router(app.clone());
    let attempt = tokio::spawn(async move {
        request(http, "/v1/customer/auth/refresh", Value::Null, &cookie).await
    });
    wait_for_customer_lock(&pool, blocker).await;
    sqlx::query("UPDATE customers.sessions SET expires_at=clock_timestamp() WHERE customer_id=$1")
        .bind(customer)
        .execute(&pool)
        .await
        .unwrap();
    held.commit().await.unwrap();
    let (status, body) = attempt.await.unwrap();
    assert_eq!(status, 401, "expired refresh session was accepted: {body}");
    let unchanged: bool =
        sqlx::query_scalar("SELECT refresh_hash=$2 FROM customers.sessions WHERE customer_id=$1")
            .bind(customer)
            .bind(infra_auth::digest(&login.refresh))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        unchanged,
        "expired refresh must not rotate the session secret"
    );
    let emitted: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM platform.outbox WHERE event_type='customer.session_refreshed'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(emitted, 0);
}
