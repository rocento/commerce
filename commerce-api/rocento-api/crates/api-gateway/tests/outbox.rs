use infra_events::{deliver_one, PublishFailure};
use sqlx::PgPool;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[sqlx::test(migrations = false)]
async fn retry_migration_preserves_legacy_pending_and_published_events(pool: PgPool) {
    sqlx::raw_sql(include_str!(
        "../../../migrations/20260913010000_identity.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO platform.outbox(id,event_type,payload,published_at) VALUES(gen_random_uuid(),'test.pending','{}',NULL),(gen_random_uuid(),'test.published','{}',now())")
        .execute(&pool).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../migrations/20261011030000_outbox_retries.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    let rows: Vec<(String, i32, bool)> = sqlx::query_as("SELECT event_type,attempts,published_at IS NOT NULL FROM platform.outbox ORDER BY event_type")
        .fetch_all(&pool).await.unwrap();
    assert_eq!(
        rows,
        vec![
            ("test.pending".into(), 0, false),
            ("test.published".into(), 0, true)
        ]
    );
    assert!(deliver_one(&pool, |event| async move {
        assert_eq!(event.event_type, "test.pending");
        Ok(())
    })
    .await
    .unwrap());
    assert!(
        !deliver_one(&pool, |_| async { panic!("old published event replayed") })
            .await
            .unwrap()
    );
}

async fn seed(pool: &PgPool) -> Uuid {
    sqlx::query("DELETE FROM platform.outbox")
        .execute(pool)
        .await
        .unwrap();
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO platform.outbox(id,event_type,payload) VALUES($1,'test.event','{}')")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    id
}

#[sqlx::test(migrations = "../../migrations")]
async fn failed_event_is_retained_and_does_not_block_later_events(pool: PgPool) {
    let id = seed(&pool).await;
    assert!(
        deliver_one(&pool, |_| async { Err(PublishFailure::Unavailable) })
            .await
            .unwrap()
    );
    let state: (i32, bool, String, bool) = sqlx::query_as("SELECT attempts,published_at IS NULL,last_error,available_at>clock_timestamp() FROM platform.outbox WHERE id=$1")
        .bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(state, (1, true, "publish_unavailable".into(), true));
    assert!(!deliver_one(&pool, |_| async {
        panic!("deferred row was retried early")
    })
    .await
    .unwrap());
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO platform.outbox(id,event_type,payload) VALUES($1,'test.event','{}')")
        .bind(other)
        .execute(&pool)
        .await
        .unwrap();
    assert!(deliver_one(&pool, |event| async move {
        assert_eq!(event.id, other.to_string());
        Ok(())
    })
    .await
    .unwrap());
    sqlx::query("UPDATE platform.outbox SET available_at=now() WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    deliver_one(&pool, |event| async move {
        assert_eq!(event.id, id.to_string());
        Ok(())
    })
    .await
    .unwrap();
    let state: (i32, bool, bool) = sqlx::query_as("SELECT attempts,published_at IS NOT NULL,last_error IS NULL FROM platform.outbox WHERE id=$1")
        .bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(state, (2, true, true));
}

#[sqlx::test(migrations = "../../migrations")]
async fn cancellation_after_broker_acceptance_replays_same_id(pool: PgPool) {
    let id = seed(&pool).await;
    let observed = Arc::new(Mutex::new(Vec::new()));
    let copy = observed.clone();
    let worker_pool = pool.clone();
    let (accepted, received) = tokio::sync::oneshot::channel();
    let worker = tokio::spawn(async move {
        deliver_one(&worker_pool, |event| async move {
            copy.lock().unwrap().push(event.id);
            accepted.send(()).unwrap();
            std::future::pending::<Result<(), PublishFailure>>().await
        })
        .await
    });
    received.await.unwrap();
    // Simulate a process loss after remote acceptance, before its local commit.
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    // A blocking row lock waits for the cancelled transaction's rollback.
    let mut tx = pool.begin().await.unwrap();
    let pending: bool = sqlx::query_scalar(
        "SELECT published_at IS NULL FROM platform.outbox WHERE id=$1 FOR UPDATE",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert!(pending);
    tx.commit().await.unwrap();
    deliver_one(&pool, |event| async {
        observed.lock().unwrap().push(event.id);
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        *observed.lock().unwrap(),
        vec![id.to_string(), id.to_string()]
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_publishers_skip_claimed_event(pool: PgPool) {
    seed(&pool).await;
    let mut held = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM platform.outbox FOR UPDATE")
        .fetch_all(&mut *held)
        .await
        .unwrap();
    assert!(
        !deliver_one(&pool, |_| async { panic!("claimed event delivered twice") })
            .await
            .unwrap()
    );
    held.rollback().await.unwrap();
    assert!(deliver_one(&pool, |_| async { Ok(()) }).await.unwrap());
}

#[sqlx::test(migrations = "../../migrations")]
async fn hung_publish_is_bounded_and_invalid_subject_is_retained(pool: PgPool) {
    let id = seed(&pool).await;
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        deliver_one(&pool, |_| std::future::pending()),
    )
    .await
    .expect("publisher retained a connection beyond its deadline")
    .unwrap();
    let error: String = sqlx::query_scalar("SELECT last_error FROM platform.outbox WHERE id=$1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(error, "publish_timeout");
    sqlx::query(
        "UPDATE platform.outbox SET event_type='bad.*',available_at=now(),attempts=100 WHERE id=$1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    deliver_one(&pool, |_| async {
        panic!("wildcard must not reach the broker")
    })
    .await
    .unwrap();
    let state: (String, bool, bool) = sqlx::query_as("SELECT last_error,published_at IS NULL,available_at BETWEEN now()+interval '59 seconds' AND now()+interval '61 seconds' FROM platform.outbox WHERE id=$1")
        .bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(state, ("invalid_subject".into(), true, true));
}
