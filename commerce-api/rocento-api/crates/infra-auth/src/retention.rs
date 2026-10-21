//! Bounded retention for disposable authentication state. Business records and
//! audit history are never included. A one-day grace exceeds every limiter window.
use crate::{Error, Result};
use sqlx::PgPool;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::Duration;

#[derive(Debug, Default, serde::Serialize)]
pub struct Purged {
    pub rate_limits: u64,
    pub customer_sessions: u64,
    pub admin_sessions: u64,
    pub challenges: u64,
    pub oldest_due_seconds: i64,
}
static LAST_SUCCESS: AtomicI64 = AtomicI64::new(0);
static FAILURES: AtomicU64 = AtomicU64::new(0);
static OLDEST_DUE: AtomicI64 = AtomicI64::new(0);

#[derive(serde::Serialize)]
pub struct Status {
    pub last_success_unix: i64,
    pub failures: u64,
    pub oldest_due_seconds: i64,
}
pub fn status() -> Status {
    Status {
        last_success_unix: LAST_SUCCESS.load(Ordering::Relaxed),
        failures: FAILURES.load(Ordering::Relaxed),
        oldest_due_seconds: OLDEST_DUE.load(Ordering::Relaxed),
    }
}

pub async fn purge(pool: &PgPool, batch: i64) -> Result<Purged> {
    if !(1..=1000).contains(&batch) {
        return Err(Error::Invalid(
            "Retention batch must be between 1 and 1000".into(),
        ));
    }
    let mut tx = pool.begin().await?;
    sqlx::query(
        "SELECT set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)",
    )
    .execute(&mut *tx)
    .await?;
    // Lock and recheck before deleting: another gateway can renew an old key or
    // challenge concurrently without having that refreshed state erased.
    let rate_limits = sqlx::query("WITH expired AS (SELECT key FROM platform.rate_limits WHERE window_start < statement_timestamp()-interval '1 day' ORDER BY window_start,key LIMIT $1 FOR UPDATE SKIP LOCKED) DELETE FROM platform.rate_limits r USING expired e WHERE r.key=e.key AND r.window_start < statement_timestamp()-interval '1 day'")
        .bind(batch).execute(&mut *tx).await?.rows_affected();
    let customer_sessions = sqlx::query("WITH expired AS (SELECT id FROM customers.sessions WHERE expires_at < statement_timestamp()-interval '1 day' ORDER BY expires_at,id LIMIT $1 FOR UPDATE SKIP LOCKED) DELETE FROM customers.sessions s USING expired e WHERE s.id=e.id AND s.expires_at < statement_timestamp()-interval '1 day'")
        .bind(batch).execute(&mut *tx).await?.rows_affected();
    let admin_sessions = sqlx::query("WITH expired AS (SELECT token_hash FROM admin_iam.sessions WHERE expires_at < statement_timestamp()-interval '1 day' ORDER BY expires_at,token_hash LIMIT $1 FOR UPDATE SKIP LOCKED) DELETE FROM admin_iam.sessions s USING expired e WHERE s.token_hash=e.token_hash AND s.expires_at < statement_timestamp()-interval '1 day'")
        .bind(batch).execute(&mut *tx).await?.rows_affected();
    let challenges = sqlx::query("WITH expired AS (SELECT customer_id,purpose FROM customers.challenges WHERE expires_at < statement_timestamp()-interval '1 day' ORDER BY expires_at,customer_id,purpose LIMIT $1 FOR UPDATE SKIP LOCKED) DELETE FROM customers.challenges c USING expired e WHERE c.customer_id=e.customer_id AND c.purpose=e.purpose AND c.expires_at < statement_timestamp()-interval '1 day'")
        .bind(batch).execute(&mut *tx).await?.rows_affected();
    let oldest_due_seconds = sqlx::query_scalar("SELECT GREATEST(0,COALESCE((SELECT extract(epoch FROM statement_timestamp()-window_start-interval '1 day')::bigint FROM platform.rate_limits ORDER BY window_start,key LIMIT 1),0),COALESCE((SELECT extract(epoch FROM statement_timestamp()-expires_at-interval '1 day')::bigint FROM customers.sessions ORDER BY expires_at,id LIMIT 1),0),COALESCE((SELECT extract(epoch FROM statement_timestamp()-expires_at-interval '1 day')::bigint FROM admin_iam.sessions ORDER BY expires_at,token_hash LIMIT 1),0),COALESCE((SELECT extract(epoch FROM statement_timestamp()-expires_at-interval '1 day')::bigint FROM customers.challenges ORDER BY expires_at,customer_id,purpose LIMIT 1),0))")
        .fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Purged {
        rate_limits,
        customer_sessions,
        admin_sessions,
        challenges,
        oldest_due_seconds,
    })
}

/// Supervised by the gateway. A transient database outage retries with backoff;
/// atomic status and structured logs expose failures, last success and backlog lag.
pub async fn worker(pool: PgPool) {
    let mut delay = 1u64;
    loop {
        match purge(&pool, 500).await {
            Ok(purged) => {
                LAST_SUCCESS.store(chrono::Utc::now().timestamp(), Ordering::Relaxed);
                OLDEST_DUE.store(purged.oldest_due_seconds, Ordering::Relaxed);
                tracing::info!(
                    event = "authentication_retention",
                    ?purged,
                    "Authentication retention batch completed"
                );
                if purged.oldest_due_seconds > 3600 {
                    tracing::warn!(
                        event = "authentication_retention_lag",
                        oldest_due_seconds = purged.oldest_due_seconds,
                        "Authentication retention is behind schedule"
                    );
                }
                delay = 1;
                // Catch up in bounded batches without monopolizing the database.
                let wait = if purged.oldest_due_seconds > 0 { 1 } else { 60 };
                tokio::time::sleep(Duration::from_secs(wait)).await;
            }
            Err(error) => {
                FAILURES.fetch_add(1, Ordering::Relaxed);
                tracing::warn!(event="authentication_retention_failure", error=%error, retry_seconds=delay, "Authentication retention failed; retrying");
                tokio::time::sleep(Duration::from_secs(delay)).await;
                delay = (delay * 2).min(60);
            }
        }
    }
}
