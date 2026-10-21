//! Durable transactional outbox and at-least-once NATS JetStream delivery.
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub id: String,
    pub event_type: String,
    pub schema_version: u32,
    pub payload: serde_json::Value,
}

/// Persist alongside the domain write. Delivery is at least once; consumers deduplicate by id.
pub async fn record(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    event_type: &str,
    payload: serde_json::Value,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO platform.outbox(id,event_type,payload) VALUES($1,$2,$3)")
        .bind(uuid::Uuid::new_v4())
        .bind(event_type)
        .bind(payload)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Fixed diagnostic codes never contain payloads, credentials or provider errors.
#[derive(Clone, Copy, Debug)]
pub enum PublishFailure {
    Unavailable,
    Timeout,
    InvalidSubject,
    Serialization,
}
impl PublishFailure {
    fn code(self) -> &'static str {
        match self {
            Self::Unavailable => "publish_unavailable",
            Self::Timeout => "publish_timeout",
            Self::InvalidSubject => "invalid_subject",
            Self::Serialization => "serialization_failed",
        }
    }
}

fn retry_seconds(attempts: i32) -> f64 {
    f64::from((1_u32 << attempts.clamp(0, 6)).min(60))
}

fn valid_subject(event_type: &str) -> bool {
    !event_type.is_empty()
        && event_type.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        })
}

/// Deliver one due row. A failure is retained and scheduled, never discarded.
/// The transport must complete only after the broker's durable acknowledgement.
/// Cancellation/commit failure can replay a successful publish with the SAME id.
pub async fn deliver_one<F, Fut>(pool: &sqlx::PgPool, publish: F) -> Result<bool, sqlx::Error>
where
    F: FnOnce(EventEnvelope) -> Fut,
    Fut: std::future::Future<Output = Result<(), PublishFailure>>,
{
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout = '1000ms'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL lock_timeout = '250ms'")
        .execute(&mut *tx)
        .await?;
    let row: Option<(uuid::Uuid, String, serde_json::Value, i32)> = sqlx::query_as(
        "SELECT id,event_type,payload,attempts FROM platform.outbox WHERE published_at IS NULL AND available_at<=clock_timestamp() ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1"
    ).fetch_optional(&mut *tx).await?;
    let Some((id, event_type, payload, attempts)) = row else {
        tx.commit().await?;
        return Ok(false);
    };
    let outcome = if valid_subject(&event_type) {
        let event = EventEnvelope {
            id: id.to_string(),
            event_type,
            schema_version: 1,
            payload,
        };
        match tokio::time::timeout(std::time::Duration::from_secs(3), publish(event)).await {
            Ok(result) => result,
            Err(_) => Err(PublishFailure::Timeout),
        }
    } else {
        Err(PublishFailure::InvalidSubject)
    };
    match outcome {
        Ok(()) => {
            sqlx::query("UPDATE platform.outbox SET published_at=clock_timestamp(),attempts=LEAST(attempts,2147483646)+1,last_attempt_at=clock_timestamp(),last_error=NULL WHERE id=$1")
                .bind(id).execute(&mut *tx).await?;
        }
        Err(failure) => {
            sqlx::query("UPDATE platform.outbox SET attempts=LEAST(attempts,2147483646)+1,last_attempt_at=clock_timestamp(),last_error=$2,available_at=clock_timestamp()+make_interval(secs=>$3) WHERE id=$1")
                .bind(id).bind(failure.code()).bind(retry_seconds(attempts)).execute(&mut *tx).await?;
            tracing::warn!(event_id=%id, code=failure.code(), "outbox delivery deferred; event retained");
        }
    }
    tx.commit().await?;
    Ok(true)
}

pub async fn publisher(pool: sqlx::PgPool, url: String) {
    // Broker waits must not exhaust the checkout pool.
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .min_connections(0)
        .acquire_timeout(std::time::Duration::from_millis(500))
        .connect_lazy_with((*pool.connect_options()).clone());
    loop {
        if publish_loop(&pool, &url).await.is_err() {
            tracing::warn!("outbox publisher reconnecting; events remain durable");
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}
async fn publish_loop(
    pool: &sqlx::PgPool,
    url: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let client =
        tokio::time::timeout(std::time::Duration::from_secs(5), async_nats::connect(url)).await??;
    let js = async_nats::jetstream::new(client);
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        js.get_or_create_stream(async_nats::jetstream::stream::Config {
            name: "COMMERCE_EVENTS".into(),
            subjects: vec!["commerce.>".into()],
            ..Default::default()
        }),
    )
    .await??;
    loop {
        let publisher = &js;
        let attempted = deliver_one(pool, |event| async move {
            let mut headers = async_nats::HeaderMap::new();
            headers.insert("Nats-Msg-Id", event.id.clone());
            let bytes = serde_json::to_vec(&event).map_err(|_| PublishFailure::Serialization)?;
            publisher
                .publish_with_headers(
                    format!("commerce.{}", event.event_type),
                    headers,
                    bytes.into(),
                )
                .await
                .map_err(|_| PublishFailure::Unavailable)?
                .await
                .map_err(|_| PublishFailure::Unavailable)?;
            Ok(())
        })
        .await?;
        if !attempted {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    }
}
