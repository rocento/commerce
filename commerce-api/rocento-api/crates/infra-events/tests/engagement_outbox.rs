use infra_events::{deliver_one, record, PublishFailure};

#[sqlx::test(migrations = "../../engagement-migrations")]
async fn engagement_outbox_retries_and_publishes(pool: sqlx::PgPool) {
    // Also verifies the migration safely adopts a schema already repaired live.
    sqlx::raw_sql(include_str!(
        "../../../engagement-migrations/20261011030000_outbox_retries.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    let mut tx = pool.begin().await.unwrap();
    record(
        &mut tx,
        "engagement.test",
        serde_json::json!({"synthetic": true}),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(
        deliver_one(&pool, |_| async { Err(PublishFailure::Unavailable) })
            .await
            .unwrap()
    );
    let (id, attempts, error, unpublished, deferred): (uuid::Uuid, i32, String, bool, bool) = sqlx::query_as(
        "SELECT id,attempts,last_error,published_at IS NULL,available_at>last_attempt_at FROM platform.outbox"
    ).fetch_one(&pool).await.unwrap();
    assert_eq!(attempts, 1);
    assert_eq!(error, "publish_unavailable");
    assert!(unpublished && deferred);
    sqlx::query("UPDATE platform.outbox SET available_at=now()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(deliver_one(&pool, |event| async move {
        assert_eq!(event.id, id.to_string());
        assert_eq!(event.event_type, "engagement.test");
        Ok(())
    })
    .await
    .unwrap());
    let done: bool = sqlx::query_scalar("SELECT published_at IS NOT NULL AND attempts=2 AND last_error IS NULL FROM platform.outbox")
        .fetch_one(&pool).await.unwrap();
    assert!(done);
    assert!(!deliver_one(&pool, |_| async {
        panic!("Published event was delivered again")
    })
    .await
    .unwrap());
}
