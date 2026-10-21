//! Bounded queue diagnostics, separate from the commerce pool and readiness.
//! A failed sample retains the last observation and explicitly reports staleness.
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::{
    fmt::Write,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

#[derive(Default)]
struct Snapshot {
    attempted: Option<Instant>,
    success: bool,
    last_success: u64,
    failures: u64,
    queues: Vec<(String, i64, f64)>,
}

#[derive(Clone)]
pub struct Collector {
    pool: PgPool,
    snapshot: Arc<Mutex<Snapshot>>,
}

impl Collector {
    pub fn new(commerce: &PgPool) -> Self {
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .min_connections(0)
            .acquire_timeout(Duration::from_millis(250))
            .idle_timeout(Duration::from_secs(30))
            .connect_lazy_with((*commerce.connect_options()).clone());
        Self {
            pool,
            snapshot: Arc::new(Mutex::new(Snapshot::default())),
        }
    }

    pub async fn append_metrics(&self, output: &mut String) {
        let mut snapshot = self.snapshot.lock().await;
        if snapshot
            .attempted
            .is_none_or(|at| at.elapsed() >= Duration::from_secs(10))
        {
            snapshot.attempted = Some(Instant::now());
            // A cancelled scrape must not leave the previous sample marked fresh.
            snapshot.success = false;
            match tokio::time::timeout(Duration::from_millis(750), sample(&self.pool)).await {
                Ok(Ok(queues)) => {
                    snapshot.queues = queues;
                    snapshot.success = true;
                    snapshot.last_success = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                }
                _ => {
                    snapshot.success = false;
                    snapshot.failures += 1;
                }
            }
        }
        render(&snapshot, output);
    }
}

async fn sample(pool: &PgPool) -> Result<Vec<(String, i64, f64)>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION READ ONLY")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout = '250ms'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL lock_timeout = '100ms'")
        .execute(&mut *tx)
        .await?;
    let queues = sqlx::query_as(
        "SELECT 'outbox'::text, count(*)::bigint,
                COALESCE(GREATEST(0, EXTRACT(EPOCH FROM now()-min(created_at))),0)::float8
           FROM platform.outbox WHERE published_at IS NULL
         UNION ALL
         SELECT 'notifications'::text, count(*)::bigint,
                COALESCE(GREATEST(0, EXTRACT(EPOCH FROM now()-min(created_at))),0)::float8
           FROM platform.notification_jobs WHERE status='pending'
         UNION ALL
         SELECT 'outbox_retrying'::text, count(*)::bigint, 0::float8
           FROM platform.outbox WHERE published_at IS NULL AND attempts>0
         UNION ALL
         SELECT 'notifications_failed'::text, count(*)::bigint, 0::float8
           FROM platform.notification_jobs WHERE status='failed'",
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(queues)
}

fn render(snapshot: &Snapshot, output: &mut String) {
    let _ = writeln!(output,
        "# TYPE commerce_reliability_sample_success gauge\ncommerce_reliability_sample_success {}\n\
         # TYPE commerce_reliability_last_success_seconds gauge\ncommerce_reliability_last_success_seconds {}\n\
         # TYPE commerce_reliability_sample_failures_total counter\ncommerce_reliability_sample_failures_total {}\n\
         # TYPE commerce_queue_pending gauge\n# TYPE commerce_queue_oldest_pending_seconds gauge",
        u8::from(snapshot.success), snapshot.last_success, snapshot.failures);
    for (queue, count, age) in &snapshot.queues {
        if queue == "outbox_retrying" || queue == "notifications_failed" {
            let _ = writeln!(
                output,
                "# TYPE commerce_{queue} gauge\ncommerce_{queue} {count}"
            );
            continue;
        }
        let _ = writeln!(output,
            "commerce_queue_pending{{queue={queue:?}}} {count}\ncommerce_queue_oldest_pending_seconds{{queue={queue:?}}} {age}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[sqlx::test(migrations = "../../migrations")]
    async fn samples_pending_only_and_does_not_mutate_jobs(pool: PgPool) {
        // Migrations enqueue a bootstrap event; this fixture owns its test database.
        sqlx::query("DELETE FROM platform.outbox")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO platform.outbox(id,event_type,payload,created_at,published_at) VALUES
            (gen_random_uuid(),'test','{}',now()-interval '2 minutes',NULL),
            (gen_random_uuid(),'test','{}',now()-interval '1 day',now())",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO platform.notification_jobs(id,purpose,payload,expires_at,created_at) VALUES
            (gen_random_uuid(),'test','{}',now()+interval '1 hour',now()-interval '1 minute')")
            .execute(&pool).await.unwrap();
        sqlx::query("UPDATE platform.outbox SET attempts=2")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO platform.notification_jobs(id,purpose,payload,expires_at,status) VALUES(gen_random_uuid(),'test',NULL,now()+interval '1 hour','failed')")
            .execute(&pool).await.unwrap();
        let rows = sample(&pool).await.unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[2].1, 1);
        assert_eq!(rows[3].1, 1);
        assert_eq!((&rows[0].0, rows[0].1), (&"outbox".to_string(), 1));
        assert!(rows[0].2 >= 119.0);
        assert_eq!(rows[1].1, 1);
        assert!(rows[1].2 >= 59.0);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM platform.outbox")
                .fetch_one(&pool)
                .await
                .unwrap(),
            2
        );
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn unavailable_database_retains_observation_and_marks_failure(pool: PgPool) {
        let collector = Collector::new(&pool);
        let mut output = String::new();
        collector.append_metrics(&mut output).await;
        assert!(output.contains("commerce_reliability_sample_success 1\n"));
        let observed: Vec<String> = output
            .lines()
            .filter(|line| line.starts_with("commerce_queue_"))
            .map(str::to_owned)
            .collect();
        collector.pool.close().await;
        collector.snapshot.lock().await.attempted = None;
        output.clear();
        collector.append_metrics(&mut output).await;
        assert!(output.contains("commerce_reliability_sample_success 0\n"));
        assert!(output.contains("commerce_reliability_sample_failures_total 1\n"));
        assert!(observed.iter().all(|line| output.contains(line)));
        // Repeated scrapes use the cached failure; they do not hammer the database.
        output.clear();
        collector.append_metrics(&mut output).await;
        assert!(output.contains("commerce_reliability_sample_failures_total 1\n"));
    }

    #[test]
    fn no_successful_sample_does_not_claim_empty_queues() {
        let mut output = String::new();
        render(&Snapshot::default(), &mut output);
        assert!(output.contains("commerce_reliability_last_success_seconds 0\n"));
        assert!(!output.contains("commerce_queue_pending{"));
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn locked_queue_times_out_without_borrowing_commerce_connections(pool: PgPool) {
        let collector = Collector::new(&pool);
        let mut transaction = pool.begin().await.unwrap();
        sqlx::query("LOCK TABLE platform.outbox IN ACCESS EXCLUSIVE MODE")
            .execute(&mut *transaction)
            .await
            .unwrap();
        let started = Instant::now();
        let mut output = String::new();
        collector.append_metrics(&mut output).await;
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(output.contains("commerce_reliability_sample_success 0\n"));
        assert!(!output.contains("commerce_queue_pending{"));
        // The caller's existing transaction remains usable after collection fails.
        assert_eq!(
            sqlx::query_scalar::<_, i32>("SELECT 1")
                .fetch_one(&mut *transaction)
                .await
                .unwrap(),
            1
        );
        transaction.rollback().await.unwrap();
    }
}
