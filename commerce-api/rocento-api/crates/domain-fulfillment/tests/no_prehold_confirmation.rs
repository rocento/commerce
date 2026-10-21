//! Split plans with disjoint products can reach capacity confirmation concurrently.
//! Their source order need not match the order of the global capacity buckets.
use chrono::{Duration, Utc};
use domain_fulfillment::{capacity, plans};
use infra_auth::Error;
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::Barrier;
use uuid::Uuid;

async fn opposite_windows(pool: PgPool, limit: i64) {
    sqlx::query("UPDATE fulfillment.capacity_settings SET enabled=true")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE fulfillment.system_capabilities SET capabilities=$1")
        .bind(json!({
            "capacity_management_enabled": true,
            "checkout_capacity_holds_enabled": false,
            "geo_fencing_enabled": false,
            "split_order_scheduling_enabled": true,
            "split_delivery_mode": "independent_windows"
        }))
        .execute(&pool)
        .await
        .unwrap();
    let sources = [Uuid::from_u128(1), Uuid::from_u128(2)];
    sqlx::query(
        "INSERT INTO inventory.inventory_sources(id,code,name) VALUES($1,'second','Second source')",
    )
    .bind(sources[1])
    .execute(&pool)
    .await
    .unwrap();
    let schedules = [Uuid::new_v4(), Uuid::new_v4()];
    for (source, schedule) in sources.iter().zip(schedules) {
        sqlx::query("INSERT INTO fulfillment.schedules(id,source_id,method,enabled,timezone,config) VALUES($1,$2,'scheduled_delivery',true,'UTC','{}')")
            .bind(schedule).bind(source).execute(&pool).await.unwrap();
    }
    let rule = Uuid::new_v4();
    // Two windows on one UTC date belong to opposite days in this global rule.
    sqlx::query("INSERT INTO fulfillment.capacity_rules(id,period,limits,timezone) VALUES($1,'day',$2,'America/New_York')")
        .bind(rule).bind(json!({"orders":limit})).execute(&pool).await.unwrap();
    let date = (Utc::now() + Duration::days(2)).date_naive();
    let windows = [
        date.and_hms_opt(1, 0, 0).unwrap().and_utc(),
        date.and_hms_opt(13, 0, 0).unwrap().and_utc(),
    ];
    let category = Uuid::new_v4();
    sqlx::query("INSERT INTO catalog.categories(id,name,slug) VALUES($1,'Test','test')")
        .bind(category)
        .execute(&pool)
        .await
        .unwrap();
    let mut fixtures = Vec::new();
    for cart_index in 0..2 {
        let (customer, cart, location, plan, order) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash,verified) VALUES($1,$2,'email','unused',true)")
            .bind(customer).bind(format!("{customer}@example.test")).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO customers.customer_locations(id,customer_id,label,latitude,longitude,formatted_address) VALUES($1,$2,'home',30,31,'Test')")
            .bind(location).bind(customer).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO cart_checkout.carts(id,customer_id) VALUES($1,$2)")
            .bind(cart)
            .bind(customer)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency) VALUES($1,$2,$3,$4,'placed','{}','{}',2,0,2,'USD')")
            .bind(order).bind(customer).bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
        let selection = plans::Selection {
            request: plans::Request {
                method: "delivery".into(),
                location_id: Some(location),
                source_id: None,
                date,
                asap: false,
            },
            windows: sources
                .iter()
                .enumerate()
                .map(|(group_index, source)| {
                    let start = windows[(group_index + cart_index) % 2];
                    plans::Window {
                        source_id: *source,
                        schedule_id: schedules[group_index],
                        starts_at: start,
                        ends_at: start + Duration::hours(1),
                    }
                })
                .collect(),
            idempotency_key: Uuid::new_v4(),
        };
        sqlx::query("INSERT INTO fulfillment.plans(id,customer_id,cart_id,store_id,method,location_id,fingerprint,capabilities,request,status,expires_at,idempotency_key) SELECT $1,$2,$3,fulfillment_store_id,'delivery',$4,'{}','{}',$5,'HELD',clock_timestamp()+interval '10 minutes',$6 FROM cart_checkout.carts WHERE id=$3")
            .bind(plan).bind(customer).bind(cart).bind(location).bind(json!(selection)).bind(selection.idempotency_key).execute(&pool).await.unwrap();
        for (group_index, window) in selection.windows.iter().enumerate() {
            let group = Uuid::new_v4();
            let product = Uuid::new_v4();
            let sku = format!("{cart_index}-{group_index}");
            sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) VALUES($1,$2,$2,'Test','',1,'USD','each',$3)")
                .bind(product).bind(&sku).bind(category).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO cart_checkout.items(cart_id,product_id,sku,name,unit,price,quantity) VALUES($1,$2,$3,'Test','each',1,1)")
                .bind(cart).bind(product).bind(sku).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO fulfillment.plan_groups(id,plan_id,source_id,method,schedule_id,starts_at,ends_at,timezone,requirement,release_before) VALUES($1,$2,$3,'delivery',$4,$5,$6,'UTC','{\"orders\":1,\"units\":1}','fulfilling')")
                .bind(group).bind(plan).bind(window.source_id).bind(window.schedule_id).bind(window.starts_at).bind(window.ends_at).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO fulfillment.plan_items(group_id,product_id,stock_id,quantity) SELECT $1,$2,id,1 FROM inventory.stocks WHERE is_default")
                .bind(group).bind(product).execute(&pool).await.unwrap();
        }
        fixtures.push((customer, cart, order));
    }
    // Widen the gap between a plan's first and second bucket admissions. Without
    // the confirmation guard each transaction owns the bucket the other needs.
    sqlx::raw_sql("CREATE FUNCTION fulfillment.slow_test_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$; CREATE TRIGGER slow_test_ledger BEFORE INSERT ON fulfillment.capacity_reservations FOR EACH ROW EXECUTE FUNCTION fulfillment.slow_test_ledger()")
        .execute(&pool).await.unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let mut jobs = tokio::task::JoinSet::new();
    for (customer, cart, order) in fixtures {
        let pool = pool.clone();
        let barrier = barrier.clone();
        jobs.spawn(async move {
            // Both transactions own their disjoint cart/product scopes first.
            let mut tx = domain_inventory::begin_cart(&pool, Some(customer), "", &[]).await?;
            barrier.wait().await;
            let result = plans::confirm(&mut tx, cart, order).await;
            match result {
                Ok(()) => {
                    capacity::confirm(&mut tx, cart, order).await?;
                    tx.commit().await?;
                    Ok(())
                }
                Err(error) => {
                    tx.rollback().await?;
                    Err(error)
                }
            }
        });
    }
    let (mut accepted, mut full) = (0, 0);
    while let Some(result) = jobs.join_next().await {
        match result.unwrap() {
            Ok(()) => accepted += 1,
            Err(Error::Invalid(code)) if code == "SLOT_FULL" => full += 1,
            Err(error) => panic!("confirmation must not deadlock or time out: {error}"),
        }
    }
    assert_eq!((accepted, full), (limit, 2 - limit));
    let usage: Vec<i64> = sqlx::query_scalar("SELECT count(*) FROM fulfillment.capacity_consumption c JOIN fulfillment.capacity_reservations r ON r.id=c.reservation_id WHERE c.rule_id=$1 AND r.status='CONFIRMED' GROUP BY c.bucket_key ORDER BY c.bucket_key")
        .bind(rule).fetch_all(&pool).await.unwrap();
    assert_eq!(usage, vec![limit, limit]);
    let held: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM fulfillment.capacity_reservations WHERE status='HELD'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        held, 0,
        "rejected confirmations must leave no partial ledger"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn opposite_day_order_confirms_both_disjoint_carts_without_deadlock(pool: PgPool) {
    opposite_windows(pool, 2).await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn opposite_day_order_honors_global_capacity_without_partial_ledgers(pool: PgPool) {
    opposite_windows(pool, 1).await;
}
