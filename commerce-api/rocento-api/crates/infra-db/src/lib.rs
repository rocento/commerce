use infra_observability::{
    record_db_pool_snapshot, DbPoolSnapshot, Operation, OperationResult, OperationTimer,
};
use sqlx::{postgres::PgPoolOptions, PgPool, Postgres, Transaction};
use std::time::Duration;

fn pool_limits(
    max_connections: Option<String>,
    acquire_timeout_ms: Option<String>,
) -> Result<(u32, Duration), sqlx::Error> {
    let parse = |value: Option<String>, default, min, max, setting| {
        let value = value.map_or(Ok(default), |value| value.parse::<u32>().map_err(|_| ()));
        value
            .ok()
            .filter(|value| (min..=max).contains(value))
            .ok_or_else(|| sqlx::Error::Configuration(format!("Invalid {setting}").into()))
    };
    Ok((
        parse(max_connections, 10, 2, 200, "DB_MAX_CONNECTIONS")?,
        Duration::from_millis(u64::from(parse(
            acquire_timeout_ms,
            3000,
            100,
            30000,
            "DB_ACQUIRE_TIMEOUT_MS",
        )?)),
    ))
}

pub async fn connect(url: &str) -> Result<PgPool, sqlx::Error> {
    let setting = |name| match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(_) => Err(sqlx::Error::Configuration(format!("Invalid {name}").into())),
    };
    let (max_connections, acquire_timeout) = pool_limits(
        setting("DB_MAX_CONNECTIONS")?,
        setting("DB_ACQUIRE_TIMEOUT_MS")?,
    )?;
    let pool = PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(acquire_timeout)
        .after_connect(|connection, _| Box::pin(verify_durability(connection)))
        .connect(url)
        .await?;
    record_db_pool_snapshot(pool_snapshot(&pool));
    Ok(pool)
}

/// Samples the pool without retaining a pool or connection in metrics storage.
pub fn pool_snapshot(pool: &PgPool) -> DbPoolSnapshot {
    DbPoolSnapshot {
        size: pool.size(),
        idle: pool.num_idle(),
        max_connections: pool.options().get_max_connections(),
    }
}

/// Measures SQLx acquisition latency, including connection checks/opening,
/// separately from the subsequent database BEGIN round trip.
pub async fn begin_transaction(
    pool: &PgPool,
) -> Result<Transaction<'static, Postgres>, sqlx::Error> {
    let timer = OperationTimer::new(Operation::DbPoolAcquire);
    let acquired = pool.acquire().await;
    timer.finish(match &acquired {
        Ok(_) => OperationResult::Success,
        Err(sqlx::Error::PoolTimedOut) => OperationResult::Timeout,
        Err(_) => OperationResult::Error,
    });
    record_db_pool_snapshot(pool_snapshot(pool));
    // SQLx 0.8.6 uses this same owned-connection constructor in Pool::begin.
    // Keeping ownership in Transaction preserves automatic rollback/release.
    Transaction::begin(acquired?, None).await
}

pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    sqlx::migrate!("../../migrations").run(pool).await
}

async fn verify_durability(connection: &mut sqlx::PgConnection) -> Result<(), sqlx::Error> {
    let durable: bool = sqlx::query_scalar(
        "SELECT current_setting('fsync')='on' AND current_setting('synchronous_commit') IN ('on','remote_apply') AND current_setting('full_page_writes')='on' AND current_setting('wal_level') IN ('replica','logical')"
    ).fetch_one(connection).await?;
    if !durable {
        return Err(sqlx::Error::Configuration("Postgres durability settings are unsafe; require fsync/full_page_writes, synchronous durable commit and replica WAL".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_configuration_is_bounded_and_does_not_echo_invalid_values() {
        assert_eq!(
            pool_limits(None, None).unwrap(),
            (10, Duration::from_secs(3))
        );
        assert_eq!(
            pool_limits(Some("25".into()), Some("750".into())).unwrap(),
            (25, Duration::from_millis(750))
        );
        for value in ["0", "201", "invalid-sensitive-value"] {
            let error = pool_limits(Some(value.into()), None)
                .unwrap_err()
                .to_string();
            assert!(error.contains("DB_MAX_CONNECTIONS"));
            assert!(!error.contains(value));
        }
        assert!(pool_limits(None, Some("99".into())).is_err());
        assert!(pool_limits(None, Some("30001".into())).is_err());
    }

    fn acquisition_value(metrics: &str, field: &str, result: &str) -> f64 {
        let prefix = format!("commerce_db_pool_acquire_seconds_{field}{{result=\"{result}\"}} ");
        metrics
            .lines()
            .find_map(|line| line.strip_prefix(&prefix))
            .map_or(0.0, |value| value.parse().unwrap())
    }

    #[tokio::test]
    async fn closed_lazy_pool_is_measured_without_connecting() {
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect_lazy("postgres://unused@127.0.0.1:1/unused")
            .unwrap();
        pool.close().await;
        assert!(matches!(
            begin_transaction(&pool).await,
            Err(sqlx::Error::PoolClosed)
        ));
        assert_eq!(
            pool_snapshot(&pool),
            DbPoolSnapshot {
                size: 0,
                idle: 0,
                max_connections: 1
            }
        );
        let (_, metrics) = infra_observability::metrics().await;
        assert!(metrics.contains("commerce_db_pool_acquire_seconds_count{result=\"error\"} 1\n"));
        assert!(metrics.contains("# TYPE commerce_db_pool_connections gauge\n"));
    }

    #[sqlx::test]
    async fn acquisition_wait_is_separate_from_owned_transaction_lifetime(pool: PgPool) {
        let mut held = Vec::new();
        for _ in 0..pool.options().get_max_connections() {
            held.push(pool.acquire().await.unwrap());
        }
        let (_, before) = infra_observability::metrics().await;
        let task_pool = pool.clone();
        let mut waiting = tokio::spawn(async move { begin_transaction(&task_pool).await });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(60), &mut waiting)
                .await
                .is_err()
        );
        drop(held.pop());
        let mut transaction = tokio::time::timeout(std::time::Duration::from_secs(3), waiting)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let (_, acquired) = infra_observability::metrics().await;
        assert_eq!(
            acquisition_value(&acquired, "count", "success"),
            acquisition_value(&before, "count", "success") + 1.0
        );
        assert!(
            acquisition_value(&acquired, "sum", "success")
                - acquisition_value(&before, "sum", "success")
                >= 0.03
        );
        sqlx::query("CREATE TEMPORARY TABLE acquisition_probe (value integer)")
            .execute(&mut *transaction)
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        transaction.rollback().await.unwrap();
        let (_, finished) = infra_observability::metrics().await;
        assert_eq!(
            acquisition_value(&finished, "sum", "success"),
            acquisition_value(&acquired, "sum", "success")
        );
        drop(held);
    }

    #[sqlx::test]
    async fn pool_deadline_has_a_fixed_timeout_result(pool: PgPool) {
        let constrained = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_millis(50))
            .connect_with((*pool.connect_options()).clone())
            .await
            .unwrap();
        let held = constrained.acquire().await.unwrap();
        let (_, before) = infra_observability::metrics().await;
        assert!(matches!(
            begin_transaction(&constrained).await,
            Err(sqlx::Error::PoolTimedOut)
        ));
        let (_, after) = infra_observability::metrics().await;
        assert_eq!(
            acquisition_value(&after, "count", "timeout"),
            acquisition_value(&before, "count", "timeout") + 1.0
        );
        drop(held);
        constrained.close().await;
    }

    #[sqlx::test]
    async fn rejects_weakened_commit_modes(pool: PgPool) {
        let mut connection = pool.acquire().await.unwrap();
        for mode in ["off", "local", "remote_write"] {
            sqlx::query(&format!("SET synchronous_commit = '{mode}'"))
                .execute(&mut *connection)
                .await
                .unwrap();
            assert!(matches!(
                verify_durability(&mut connection).await,
                Err(sqlx::Error::Configuration(_))
            ));
        }
        for mode in ["on", "remote_apply"] {
            sqlx::query(&format!("SET synchronous_commit = '{mode}'"))
                .execute(&mut *connection)
                .await
                .unwrap();
            verify_durability(&mut connection).await.unwrap();
        }
    }
}
