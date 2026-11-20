use sqlx::PgPool;

const MIGRATION: i64 = 20261118010000;
const TARGET: &str = "history-order-9999";

async fn history_fingerprint(pool: &PgPool) -> String {
    sqlx::query_scalar(
        "SELECT md5(jsonb_agg(to_jsonb(h) ORDER BY id)::text) FROM orders.order_status_history h",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn ordered_history(pool: &PgPool) -> String {
    sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(h) ORDER BY created_at,id)::text \
         FROM orders.order_status_history h WHERE order_id=md5($1)::uuid",
    )
    .bind(TARGET)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn lookup_plan(pool: &PgPool) -> String {
    let lines: Vec<String> = sqlx::query_scalar(
        "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders.order_status_history \
         WHERE order_id=md5($1)::uuid ORDER BY created_at,id",
    )
    .bind(TARGET)
    .fetch_all(pool)
    .await
    .unwrap();
    lines.join("\n")
}

#[sqlx::test(migrations = false)]
async fn upgrade_preserves_history_and_avoids_scanning_unrelated_orders(pool: PgPool) {
    let mut previous = sqlx::migrate!("../../migrations");
    previous
        .migrations
        .to_mut()
        .retain(|m| m.version < MIGRATION);
    previous.run(&pool).await.unwrap();

    // Three events per order, including equal timestamps to exercise the ID
    // tie-breaker used by checkout. All data is synthetic and database-local.
    sqlx::raw_sql(
        "INSERT INTO orders.orders \
         (id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency) \
         SELECT md5('history-order-'||n)::uuid,md5('history-customer-'||n)::uuid, \
         md5('history-quote-'||n)::uuid,md5('history-key-'||n)::uuid, \
         'placed','{}','{}',10,0,10,'USD' FROM generate_series(1,10000) n; \
         INSERT INTO orders.order_status_history(id,order_id,status,reason,created_at) \
         SELECT md5('history-event-'||o.id::text||'-'||n)::uuid,o.id, \
         CASE n WHEN 1 THEN 'placed' WHEN 2 THEN 'confirmed' ELSE 'fulfilling' END, \
         'Synthetic history',TIMESTAMPTZ '2026-01-01 00:00:00+00' + (n/2)*INTERVAL '1 second' \
         FROM orders.orders o CROSS JOIN generate_series(1,3) n; \
         ANALYZE orders.order_status_history;",
    )
    .execute(&pool)
    .await
    .unwrap();

    let fingerprint = history_fingerprint(&pool).await;
    let history = ordered_history(&pool).await;
    let before = lookup_plan(&pool).await;
    assert!(
        before.contains("Seq Scan on order_status_history"),
        "{before}"
    );

    infra_db::migrate(&pool).await.unwrap();
    // The normal migrator must safely recognize an already-applied upgrade.
    infra_db::migrate(&pool).await.unwrap();
    assert_eq!(fingerprint, history_fingerprint(&pool).await);
    assert_eq!(history, ordered_history(&pool).await);

    let after = lookup_plan(&pool).await;
    assert!(
        after.contains("order_status_history_order_created"),
        "{after}"
    );
    assert!(
        !after.contains("Seq Scan on order_status_history"),
        "{after}"
    );
    println!("History lookup before upgrade:\n{before}\nAfter upgrade:\n{after}");

    // Existing order histories remain writable after the migration.
    sqlx::query(
        "INSERT INTO orders.order_status_history(id,order_id,status,reason,created_at) \
         VALUES(md5('history-after-upgrade')::uuid,md5($1)::uuid,'shipped', \
         'Synthetic post-upgrade event',TIMESTAMPTZ '2026-01-01 00:00:02+00')",
    )
    .bind(TARGET)
    .execute(&pool)
    .await
    .unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM orders.order_status_history WHERE order_id=md5($1)::uuid",
    )
    .bind(TARGET)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 4);
}
