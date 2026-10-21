//! Opt-in native order pushes, independent of App Studio enrollment.
mod provider;
use crate::identity::{self, ApiError, App};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::HeaderMap,
    middleware,
    routing::put,
    Json, Router,
};
use infra_auth::Error;
pub use provider::Provider;
use serde::Deserialize;
use serde_json::json;
use sqlx::{FromRow, PgPool};
use std::{sync::Arc, time::Duration};
use uuid::Uuid;
#[derive(Clone)]
struct PushApp {
    app: App,
    provider: Option<Arc<Provider>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    pub customer_id: Uuid,
    pub platform: String,
    pub app_id: String,
    pub token: String,
    pub locale: String,
}
impl Registration {
    pub fn valid(&self) -> bool {
        matches!(self.platform.as_str(), "ios" | "android")
            && matches!(self.locale.as_str(), "en" | "ar")
            && (32..=4096).contains(&self.token.len())
            && self
                .token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
            && (self.platform != "ios"
                || (self.token.len().is_multiple_of(2)
                    && self.token.bytes().all(|b| b.is_ascii_hexdigit())))
    }
}
pub fn router(app: App, provider: Option<Arc<Provider>>) -> Router {
    Router::new()
        .route(
            "/v1/customer/push-devices/{id}",
            put(register).delete(remove),
        )
        .layer(DefaultBodyLimit::max(8192))
        .layer(middleware::from_fn_with_state(
            app.clone(),
            identity::policy,
        ))
        .with_state(PushApp { app, provider })
}
async fn register(
    State(a): State<PushApp>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<Registration>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let customer = a.app.customers.authenticate(identity::bearer(&h)?).await?;
    if i.customer_id != customer.id || id.is_nil() || !i.valid() {
        return Err(Error::Invalid("Invalid push registration".into()).into());
    }
    let Some(provider) = &a.provider else {
        return Err(Error::Invalid("Push notifications are not configured".into()).into());
    };
    if !provider.accepts(&i.app_id, &i.platform) {
        return Err(Error::Invalid("Unsupported push application".into()).into());
    }
    let session = a.app.customers.security.decode(identity::bearer(&h)?)?.sid;
    let mut tx = a.app.customers.pool.begin().await?;
    // Serialize registrations per account; cap token storage and lock ownership changes.
    sqlx::query("SELECT id FROM customers.customers WHERE id=$1 FOR UPDATE")
        .bind(customer.id)
        .execute(&mut *tx)
        .await?;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM platform.customer_push_devices WHERE customer_id=$1 AND id<>$2",
    )
    .bind(customer.id)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if count >= 20 {
        return Err(Error::Invalid("Too many notification devices".into()).into());
    }
    // The unguessable installation ID plus provider token represents this installation.
    // Remove any old binding of the same token before assigning the authenticated owner.
    sqlx::query("DELETE FROM platform.customer_push_devices WHERE platform=$1 AND app_id=$2 AND token=$3 AND id<>$4").bind(&i.platform).bind(&i.app_id).bind(&i.token).bind(id).execute(&mut *tx).await?;
    let changed=sqlx::query("INSERT INTO platform.customer_push_devices(id,customer_id,platform,app_id,token,locale,session_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET customer_id=excluded.customer_id,session_id=excluded.session_id,platform=excluded.platform,app_id=excluded.app_id,token=excluded.token,locale=excluded.locale,enabled=true,updated_at=clock_timestamp() WHERE customer_push_devices.customer_id=excluded.customer_id")
 .bind(id).bind(customer.id).bind(i.platform).bind(i.app_id).bind(i.token).bind(i.locale).bind(session).execute(&mut *tx).await?;
    if changed.rows_affected() != 1 {
        return Err(
            Error::Invalid("Notification installation belongs to another account".into()).into(),
        );
    }
    // Do not replay an earlier customer's pending notifications on a shared device.
    sqlx::query("DELETE FROM platform.order_push_jobs WHERE device_id=$1 AND customer_id<>$2")
        .bind(id)
        .bind(customer.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"status":"ok"})))
}
async fn remove(
    State(a): State<PushApp>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let customer = a.app.customers.authenticate(identity::bearer(&h)?).await?;
    sqlx::query("DELETE FROM platform.customer_push_devices WHERE id=$1 AND customer_id=$2")
        .bind(id)
        .bind(customer.id)
        .execute(&a.app.customers.pool)
        .await?;
    Ok(Json(json!({"status":"ok"})))
}
#[derive(FromRow)]
struct Job {
    event_id: Uuid,
    device_id: Uuid,
    order_id: Uuid,
    customer_id: Uuid,
    platform: String,
    token: String,
    locale: String,
    attempts: i32,
}
#[derive(Debug, PartialEq)]
pub enum Outcome {
    Delivered,
    InvalidToken,
    Retry,
    Failed,
}
pub async fn deliver_one(pool: &PgPool, provider: &Provider) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE platform.order_push_jobs SET state='expired',completed_at=clock_timestamp() WHERE state='pending' AND expires_at<=clock_timestamp()").execute(&mut *tx).await?;
    let job:Option<Job>=sqlx::query_as("SELECT j.event_id,j.device_id,j.order_id,j.customer_id,d.platform,d.token,d.locale,j.attempts FROM platform.order_push_jobs j JOIN platform.customer_push_devices d ON d.id=j.device_id AND d.customer_id=j.customer_id JOIN customers.sessions s ON s.id=d.session_id AND s.customer_id=d.customer_id AND s.expires_at>clock_timestamp() WHERE j.state='pending' AND d.app_id=$1 AND j.available_at<=clock_timestamp() AND d.enabled AND d.updated_at>clock_timestamp()-interval '30 days' ORDER BY j.available_at LIMIT 1 FOR UPDATE OF j,d SKIP LOCKED").bind(provider.app_id()).fetch_optional(&mut *tx).await?;
    let Some(job) = job else {
        tx.commit().await?;
        return Ok(false);
    };
    let outcome = provider
        .send(
            &job.platform,
            &job.token,
            job.event_id,
            job.order_id,
            job.customer_id,
            &job.locale,
        )
        .await;
    if outcome == Outcome::InvalidToken {
        sqlx::query("UPDATE platform.customer_push_devices SET enabled=false,token=$2 WHERE id=$1")
            .bind(job.device_id)
            .bind(format!("revoked:{}", job.device_id))
            .execute(&mut *tx)
            .await?;
    }
    let state = match outcome {
        Outcome::Delivered => "delivered",
        Outcome::Retry if job.attempts < 7 => "pending",
        _ => "failed",
    };
    sqlx::query("UPDATE platform.order_push_jobs SET state=$3,attempts=attempts+1,available_at=clock_timestamp()+make_interval(secs=>$4),completed_at=CASE WHEN $3='pending' THEN NULL ELSE clock_timestamp() END WHERE event_id=$1 AND device_id=$2")
 .bind(job.event_id).bind(job.device_id).bind(state).bind((30_i32*2_i32.pow(job.attempts.min(7) as u32)) as f64).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(true)
}
pub async fn worker(pool: PgPool, provider: Arc<Provider>) {
    loop {
        match deliver_one(&pool, &provider).await {
            Ok(true) => continue,
            Ok(false) => {}
            // SQL errors can embed token values; never log their bodies.
            Err(_) => tracing::warn!("order push queue unavailable; retrying"),
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_provider_tokens_and_locale() {
        let mut i = Registration {
            customer_id: Uuid::new_v4(),
            platform: "ios".into(),
            app_id: "com.rocento.grocery".into(),
            token: "ab".repeat(32),
            locale: "ar".into(),
        };
        assert!(i.valid());
        i.token.push('/');
        assert!(!i.valid());
        i.platform = "android".into();
        i.token = "fcm-token:".repeat(10);
        assert!(i.valid());
        i.locale = "xx".into();
        assert!(!i.valid());
    }
}

#[cfg(test)]
mod database_tests;
