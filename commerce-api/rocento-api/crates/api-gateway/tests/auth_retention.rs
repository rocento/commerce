use infra_auth::{admit, digest, retention};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrations = "../../migrations")]
async fn retention_is_bounded_preserves_live_windows_and_reports_backlog(pool: PgPool) {
    for n in 0..5 {
        sqlx::query("INSERT INTO platform.rate_limits(key,attempts,window_start) VALUES($1,9,now()-interval '2 days')")
            .bind(format!("old-{n}")).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO platform.rate_limits(key,attempts,window_start) VALUES('active',10,now()),('grace',10,now()-interval '16 minutes')")
        .execute(&pool).await.unwrap();
    let first = retention::purge(&pool, 2).await.unwrap();
    assert_eq!(first.rate_limits, 2);
    assert!(first.oldest_due_seconds > 80000);
    let second = retention::purge(&pool, 2).await.unwrap();
    assert_eq!(second.rate_limits, 2);
    let third = retention::purge(&pool, 2).await.unwrap();
    assert_eq!(third.rate_limits, 1);
    assert_eq!(third.oldest_due_seconds, 0);
    let rows: Vec<(String, i32)> =
        sqlx::query_as("SELECT key,attempts FROM platform.rate_limits ORDER BY key")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(rows, vec![("active".into(), 10), ("grace".into(), 10)]);
    assert!(retention::purge(&pool, 1001).await.is_err());
}

#[sqlx::test(migrations = "../../migrations")]
async fn cleanup_skips_concurrent_renewal_without_resetting_its_allowance(pool: PgPool) {
    let key = digest("renewed-key");
    sqlx::query("INSERT INTO platform.rate_limits(key,attempts,window_start) VALUES($1,1,now()-interval '2 days'),('other-old',1,now()-interval '2 days')")
        .bind(&key).execute(&pool).await.unwrap();
    let mut renewal = pool.begin().await.unwrap();
    sqlx::query("UPDATE platform.rate_limits SET window_start=now(),attempts=10 WHERE key=$1")
        .bind(&key)
        .execute(&mut *renewal)
        .await
        .unwrap();
    let purged = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        retention::purge(&pool, 100),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(purged.rate_limits, 1);
    renewal.commit().await.unwrap();
    assert_eq!(retention::purge(&pool, 100).await.unwrap().rate_limits, 0);
    assert!(matches!(
        admit(&pool, &[("renewed-key".into(), 10)]).await,
        Err(infra_auth::Error::RateLimited)
    ));
}

#[sqlx::test(migrations = "../../migrations")]
async fn expired_sessions_and_challenges_respect_grace_and_batch_size(pool: PgPool) {
    let customer = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash) VALUES($1,'retention@example.test','email','fixture')")
        .bind(customer).execute(&pool).await.unwrap();
    let admin = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,role_id,password_hash) VALUES($1,'retention@example.test','Fixture','00000000-0000-0000-0000-000000000001','fixture')")
        .bind(admin).execute(&pool).await.unwrap();
    for (name, age) in [
        ("old-a", -172800i32),
        ("old-b", -172800),
        ("grace", -60),
        ("active", 3600),
    ] {
        sqlx::query("INSERT INTO customers.sessions(id,customer_id,refresh_hash,expires_at) VALUES($1,$2,$3,now()+make_interval(secs=>$4))")
            .bind(Uuid::new_v4()).bind(customer).bind(name).bind(f64::from(age)).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+make_interval(secs=>$3))")
            .bind(name).bind(admin).bind(f64::from(age)).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO customers.challenges(customer_id,purpose,token_hash,expires_at) VALUES($1,'reset','old',now()-interval '2 days'),($1,'verify','active',now()+interval '10 minutes')")
        .bind(customer).execute(&pool).await.unwrap();
    let first = retention::purge(&pool, 1).await.unwrap();
    assert_eq!(
        (
            first.customer_sessions,
            first.admin_sessions,
            first.challenges
        ),
        (1, 1, 1)
    );
    let second = retention::purge(&pool, 1).await.unwrap();
    assert_eq!(
        (
            second.customer_sessions,
            second.admin_sessions,
            second.challenges
        ),
        (1, 1, 0)
    );
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM customers.sessions")
        .fetch_one(&pool)
        .await
        .unwrap();
    let admins: i64 = sqlx::query_scalar("SELECT count(*) FROM admin_iam.sessions")
        .fetch_one(&pool)
        .await
        .unwrap();
    let challenges: i64 = sqlx::query_scalar("SELECT count(*) FROM customers.challenges")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!((sessions, admins, challenges), (2, 2, 1));
    let customers: i64 = sqlx::query_scalar("SELECT count(*) FROM customers.customers")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(customers, 1, "business records are untouched");
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_admission_never_overruns_installation_budget(pool: PgPool) {
    let mut tasks = Vec::new();
    for n in 0..20 {
        let pool = pool.clone();
        tasks.push(tokio::spawn(async move {
            admit(
                &pool,
                &[(format!("subject-{n}"), 2), ("installation".into(), 5)],
            )
            .await
        }));
    }
    let mut accepted = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(()) => accepted += 1,
            Err(infra_auth::Error::RateLimited) => {}
            Err(error) => panic!("unexpected admission error: {error}"),
        }
    }
    assert_eq!(accepted, 5);
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.rate_limits")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 6, "failed transactions leave no per-subject garbage");
}

async fn assert_busy(error: sqlx::Error) {
    use axum::response::IntoResponse;
    use http_body_util::BodyExt;
    let response = api_gateway::identity::ApiError::from(error).into_response();
    assert_eq!(
        response.status(),
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(response.headers()["retry-after"], "3");
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        value,
        serde_json::json!({"error":"Service is busy. Please try again shortly."})
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn database_capacity_timeouts_are_sanitized_retryable_responses(pool: PgPool) {
    assert_busy(sqlx::Error::PoolTimedOut).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL statement_timeout='10ms'")
        .execute(&mut *tx)
        .await
        .unwrap();
    let error = sqlx::query("SELECT pg_sleep(1)")
        .execute(&mut *tx)
        .await
        .unwrap_err();
    assert_busy(error).await;
    tx.rollback().await.unwrap();
    let mut owner = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(87654321)")
        .execute(&mut *owner)
        .await
        .unwrap();
    let mut waiter = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL lock_timeout='10ms'")
        .execute(&mut *waiter)
        .await
        .unwrap();
    let error = sqlx::query("SELECT pg_advisory_xact_lock(87654321)")
        .execute(&mut *waiter)
        .await
        .unwrap_err();
    assert_busy(error).await;
    waiter.rollback().await.unwrap();
    owner.rollback().await.unwrap();
}
