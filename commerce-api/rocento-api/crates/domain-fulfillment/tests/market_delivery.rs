use chrono::{Datelike, Duration, Utc};
use domain_fulfillment::capacity::{Selection, Service};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;
const SOURCE: Uuid = Uuid::from_u128(1);
async fn setup(
    pool: &PgPool,
    count: i32,
    quantity: i32,
    limit: i64,
    dimension: &str,
) -> (Service, Uuid, Vec<(Uuid, Uuid)>, Selection) {
    sqlx::query("UPDATE fulfillment.capacity_settings SET enabled=true")
        .execute(pool)
        .await
        .unwrap();
    let category = Uuid::new_v4();
    let product = Uuid::new_v4();
    let schedule = Uuid::new_v4();
    sqlx::query("INSERT INTO catalog.categories(id,name,slug) VALUES($1,'Test','test')")
        .bind(category)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) VALUES($1,'TEST','test','Test','',1,'USD','each',$2)").bind(product).bind(category).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.stock(product_id,on_hand) VALUES($1,100000)")
        .bind(product)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO inventory.source_items(source_id,product_id,quantity) VALUES($1,$2,100000)",
    )
    .bind(SOURCE)
    .bind(product)
    .execute(pool)
    .await
    .unwrap();
    let date = (Utc::now() + Duration::days(2)).date_naive();
    let config = json!({"windows":[{"weekday":date.weekday().num_days_from_monday(),"start":"09:00:00","end":"13:00:00","cutoff":null}],"duration_minutes":60,"spacing_minutes":0,"lead_minutes":60,"cutoff":null,"min_days":0,"max_days":14,"ttl_minutes":10,"release_before":"fulfilling","exceptions":[]});
    sqlx::query("INSERT INTO fulfillment.schedules(id,source_id,method,enabled,timezone,config) VALUES($1,$2,'scheduled_delivery',true,'UTC',$3)").bind(schedule).bind(SOURCE).bind(config).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO fulfillment.capacity_rules(id,source_id,period,limits) VALUES($1,$2,'slot',$3)").bind(Uuid::new_v4()).bind(SOURCE).bind(json!({dimension:limit})).execute(pool).await.unwrap();
    let customers:Vec<Uuid>=sqlx::query_scalar("INSERT INTO customers.customers(id,email,primary_identifier,password_hash,verified) SELECT gen_random_uuid(),n||'@example.test','email','unused',true FROM generate_series(1,$1) n RETURNING id").bind(count).fetch_all(pool).await.unwrap();
    sqlx::query("INSERT INTO cart_checkout.carts(id,customer_id) SELECT gen_random_uuid(),id FROM customers.customers").execute(pool).await.unwrap();
    sqlx::query("INSERT INTO cart_checkout.items(cart_id,product_id,sku,name,unit,price,quantity) SELECT id,$1,'TEST','Test','each',1,$2 FROM cart_checkout.carts").bind(product).bind(quantity).execute(pool).await.unwrap();
    let locations:Vec<(Uuid,Uuid)>=sqlx::query_as("INSERT INTO customers.customer_locations(id,customer_id,label,latitude,longitude,formatted_address) SELECT gen_random_uuid(),id,'home',30,31,'Test' FROM customers.customers RETURNING customer_id,id").fetch_all(pool).await.unwrap();
    assert_eq!(customers.len(), locations.len());
    let selection = Selection {
        schedule_id: schedule,
        location_id: locations[0].1,
        starts_at: date.and_hms_opt(9, 0, 0).unwrap().and_utc(),
        ends_at: date.and_hms_opt(10, 0, 0).unwrap().and_utc(),
        idempotency_key: Uuid::new_v4(),
    };
    (
        Service { pool: pool.clone() },
        product,
        locations,
        selection,
    )
}
#[sqlx::test(migrations = "../../migrations")]
async fn proposed_quantity_capacity_and_commit_date_are_rechecked(pool: PgPool) {
    use domain_fulfillment::market_delivery as m;
    use std::collections::BTreeMap;
    let (service, product, customers, selection) = setup(&pool, 1, 1, 2, "units").await;
    let (customer, location) = customers[0];
    let cart: Uuid = sqlx::query_scalar("SELECT id FROM cart_checkout.carts WHERE customer_id=$1")
        .bind(customer)
        .fetch_one(&pool)
        .await
        .unwrap();
    let date = selection.starts_at.date_naive().to_string();
    let mut tx = pool.begin().await.unwrap();
    assert!(
        m::check(
            &mut tx,
            cart,
            Some(customer),
            Some(location),
            &BTreeMap::from([(product, 2)]),
            &date
        )
        .await
        .unwrap()
        .available
    );
    assert!(
        !m::check(
            &mut tx,
            cart,
            Some(customer),
            Some(location),
            &BTreeMap::from([(product, 3)]),
            &date
        )
        .await
        .unwrap()
        .available
    );
    assert!(
        !m::check(
            &mut tx,
            cart,
            None,
            Some(location),
            &BTreeMap::from([(product, 1)]),
            &date
        )
        .await
        .unwrap()
        .available
    );
    sqlx::query("UPDATE cart_checkout.carts SET market_delivery_date=$2 WHERE id=$1")
        .bind(cart)
        .bind(&date)
        .execute(&mut *tx)
        .await
        .unwrap();
    assert!(m::revalidate(&mut tx, cart).await.is_err());
    tx.commit().await.unwrap();
    service.reserve(customer, selection).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    assert!(m::revalidate(&mut tx, cart).await.is_ok());
    sqlx::query("UPDATE fulfillment.capacity_reservations SET expires_at=now()-interval '1 second' WHERE cart_id=$1").bind(cart).execute(&mut *tx).await.unwrap();
    assert!(m::revalidate(&mut tx, cart).await.is_err());
}
