//! Sensitive delivery jobs stay in PostgreSQL, never in the public event bus.
use crate::{Notification, Result};
use uuid::Uuid;

pub async fn enqueue(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    customer: Option<Uuid>,
    challenge_hash: Option<String>,
    notification: &Notification,
    ttl_seconds: i32,
) -> Result<()> {
    let payload = serde_json::to_value(notification).map_err(|_| crate::Error::Internal)?;
    sqlx::query("INSERT INTO platform.notification_jobs(id,customer_id,purpose,challenge_hash,payload,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+make_interval(secs=>$6)) ON CONFLICT(id) DO NOTHING")
        .bind(id).bind(customer).bind(&notification.purpose).bind(challenge_hash)
        .bind(payload).bind(f64::from(ttl_seconds)).execute(&mut **tx).await?;
    Ok(())
}
