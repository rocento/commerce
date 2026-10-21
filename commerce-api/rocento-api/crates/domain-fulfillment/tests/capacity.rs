use chrono::{Datelike, Duration, Utc};
use domain_fulfillment::{
    capacity::{fits, Dimensions, Selection, Service},
    scheduling::{self, Schedule},
};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;
const SOURCE: Uuid = Uuid::from_u128(1);

#[sqlx::test(migrations = "../../migrations")]
async fn independent_window_block_does_not_close_other_locations(pool: PgPool) {
    let (service, _, _, selection) = setup(&pool, 1, 1, 30, "orders").await;
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO inventory.inventory_sources(id,code,name) VALUES($1,'other-location','Other location')")
        .bind(other).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO fulfillment.schedules(id,source_id,area_id,method,enabled,timezone,config) SELECT $1,$2,area_id,method,enabled,timezone,config FROM fulfillment.schedules WHERE id=$3")
        .bind(Uuid::new_v4()).bind(other).bind(selection.schedule_id).execute(&pool).await.unwrap();
    sqlx::query("UPDATE fulfillment.capacity_rules SET source_id=NULL")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO fulfillment.capacity_rules(id,source_id,method,period,limits,timezone,starts_on,ends_on,local_start) SELECT $1,$2,method,'slot','{\"orders\":0}',timezone,($3 AT TIME ZONE timezone)::date,($3 AT TIME ZONE timezone)::date,($3 AT TIME ZONE timezone)::time FROM fulfillment.schedules WHERE id=$4")
        .bind(Uuid::new_v4()).bind(SOURCE).bind(selection.starts_at).bind(selection.schedule_id).execute(&pool).await.unwrap();
    let overview = service
        .overview(selection.starts_at.date_naive())
        .await
        .unwrap();
    let rows = overview["slots"].as_array().unwrap();
    let at_start =
        |row: &&serde_json::Value| row["slot"]["starts_at"] == json!(selection.starts_at);
    let blocked = rows
        .iter()
        .filter(at_start)
        .find(|r| r["slot"]["source_id"] == json!(SOURCE))
        .unwrap();
    let available = rows
        .iter()
        .filter(at_start)
        .find(|r| r["slot"]["source_id"] == json!(other))
        .unwrap();
    assert_eq!(blocked["status"], "Full");
    assert_eq!(available["status"], "Available");
}

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
#[test]
fn dimensional_hard_soft_and_unknown_facts() {
    let limits = Dimensions::from([("orders".into(), 50)]);
    let used = Dimensions::from([("orders".into(), 50)]);
    let need = Dimensions::from([("orders".into(), 5)]);
    assert!(!fits(&limits, &used, &need, 0).unwrap());
    assert!(fits(&limits, &used, &need, 10).unwrap());
    assert!(!fits(
        &limits,
        &used,
        &Dimensions::from([("orders".into(), 6)]),
        10
    )
    .unwrap());
    assert!(fits(&limits, &used, &Dimensions::new(), 0).is_err());
}
async fn concurrent(pool: PgPool, quantity: i32, dimension: &str) {
    let (service, _, customers, selection) = setup(&pool, 1000, quantity, 10, dimension).await;
    let mut jobs = tokio::task::JoinSet::new();
    for (customer, location) in customers {
        let service = service.clone();
        let mut s = selection.clone();
        s.location_id = location;
        s.idempotency_key = Uuid::new_v4();
        jobs.spawn(async move { service.reserve(customer, s).await });
    }
    let mut accepted = 0;
    let mut rejected = 0;
    while let Some(result) = jobs.join_next().await {
        match result.unwrap() {
            Ok(_) => accepted += 1,
            Err(infra_auth::Error::Invalid(code)) if code == "SLOT_FULL" => rejected += 1,
            Err(e) => panic!("unexpected rejection: {e}"),
        }
    }
    let expected = if dimension == "units" {
        10 / quantity
    } else {
        10
    };
    assert_eq!((accepted, rejected), (expected, 1000 - expected));
    let (count,unique):(i64,i64)=sqlx::query_as("SELECT COUNT(*),COUNT(DISTINCT id) FROM fulfillment.capacity_reservations WHERE status='HELD'").fetch_one(&pool).await.unwrap();
    assert_eq!(count, expected as i64);
    assert_eq!(count, unique);
}
#[sqlx::test(migrations = "../../migrations")]
async fn thousand_concurrent_order_holds(pool: PgPool) {
    concurrent(pool, 1, "orders").await;
}
#[sqlx::test(migrations = "../../migrations")]
async fn thousand_concurrent_multi_unit_holds(pool: PgPool) {
    concurrent(pool, 2, "units").await;
}
#[sqlx::test(migrations = "../../migrations")]
async fn holds_retry_release_expire_restart_and_cart_address_changes(pool: PgPool) {
    let (service, _, customers, selection) = setup(&pool, 2, 1, 1, "orders").await;
    let (customer, location) = customers[0];
    let r = service.reserve(customer, selection.clone()).await.unwrap();
    assert_eq!(
        service
            .reserve(customer, selection.clone())
            .await
            .unwrap()
            .id,
        r.id
    );
    assert!(service.release(customers[1].0, r.id).await.is_err());
    let mut tx = domain_inventory::begin(&pool).await.unwrap();
    assert!(domain_fulfillment::capacity::checkout_selection(
        &mut tx, customer, r.cart_id, location
    )
    .await
    .unwrap()
    .is_some());
    tx.commit().await.unwrap();
    sqlx::query("UPDATE cart_checkout.items SET quantity=40 WHERE cart_id=$1")
        .bind(r.cart_id)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = domain_inventory::begin(&pool).await.unwrap();
    assert!(domain_fulfillment::capacity::checkout_selection(
        &mut tx, customer, r.cart_id, location
    )
    .await
    .is_err());
    tx.commit().await.unwrap();
    service.release(customer, r.id).await.unwrap();
    service.release(customer, r.id).await.unwrap();
    let mut next = selection.clone();
    next.idempotency_key = Uuid::new_v4();
    let r = service.reserve(customer, next).await.unwrap();
    sqlx::query("UPDATE customers.customer_locations SET latitude=32 WHERE id=$1")
        .bind(location)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = domain_inventory::begin(&pool).await.unwrap();
    assert!(domain_fulfillment::capacity::checkout_selection(
        &mut tx, customer, r.cart_id, location
    )
    .await
    .is_err());
    tx.commit().await.unwrap();
    sqlx::query("UPDATE fulfillment.capacity_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1").bind(r.id).execute(&pool).await.unwrap();
    let restarted = Service { pool: pool.clone() };
    // Expiry frees admission even before the recovery worker marks the old record.
    let mut next = selection;
    next.location_id = customers[1].1;
    next.idempotency_key = Uuid::new_v4();
    restarted.reserve(customers[1].0, next).await.unwrap();
    assert_eq!(restarted.expire().await.unwrap(), 1);
    assert_eq!(restarted.expire().await.unwrap(), 0);
}
#[sqlx::test(migrations = "../../migrations")]
async fn daily_caps_include_bookings_before_rule_added(pool: PgPool) {
    let (service, _, customers, selection) = setup(&pool, 2, 1, 10, "orders").await;
    service
        .reserve(customers[0].0, selection.clone())
        .await
        .unwrap();
    sqlx::query("INSERT INTO fulfillment.capacity_rules(id,method,period,limits) VALUES($1,'scheduled_delivery','day','{\"orders\":1}')").bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    let mut next = selection;
    next.location_id = customers[1].1;
    next.starts_at += Duration::hours(1);
    next.ends_at += Duration::hours(1);
    next.idempotency_key = Uuid::new_v4();
    assert!(
        matches!(service.reserve(customers[1].0,next).await,Err(infra_auth::Error::Invalid(code)) if code=="SLOT_FULL")
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn timezone_calendar_cutoff_and_blackout(pool: PgPool) {
    let (_, _, _, selection) = setup(&pool, 1, 1, 10, "orders").await;
    let mut schedule: Schedule = sqlx::query_as("SELECT * FROM fulfillment.schedules WHERE id=$1")
        .bind(selection.schedule_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let date = selection.starts_at.date_naive();
    schedule.timezone = "Asia/Dubai".into();
    let mut tx = pool.begin().await.unwrap();
    let slots = scheduling::generate(&mut tx, &schedule, date)
        .await
        .unwrap();
    assert_eq!(slots[0].starts_at, selection.starts_at - Duration::hours(4));
    schedule.config["exceptions"] =
        json!([{"from":date,"through":date,"closed":true,"windows":[]}]);
    assert!(scheduling::generate(&mut tx, &schedule, date)
        .await
        .unwrap()
        .is_empty());
    schedule.config["exceptions"] = json!([]);
    schedule.enabled = false;
    assert!(scheduling::generate(&mut tx, &schedule, date)
        .await
        .unwrap()
        .is_empty());
    schedule.enabled = true;
    schedule.config["min_days"] = json!(3);
    assert!(scheduling::generate(&mut tx, &schedule, date)
        .await
        .unwrap()
        .is_empty());
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn alternative_source_routing_and_geofence_isolation(pool: PgPool) {
    let (service, product, customers, selection) = setup(&pool, 2, 1, 0, "orders").await;
    let source = Uuid::new_v4();
    let schedule = Uuid::new_v4();
    sqlx::query("INSERT INTO inventory.inventory_sources(id,code,name) VALUES($1,'east','East')")
        .bind(source)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO inventory.source_stock_links(stock_id,source_id) VALUES($1,$2)")
        .bind(SOURCE)
        .bind(source)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO inventory.source_items(source_id,product_id,quantity) VALUES($1,$2,100)",
    )
    .bind(source)
    .bind(product)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO fulfillment.schedules(id,source_id,method,enabled,timezone,config) SELECT $1,$2,method,true,timezone,config FROM fulfillment.schedules WHERE id=$3").bind(schedule).bind(source).bind(selection.schedule_id).execute(&pool).await.unwrap();
    let options = service
        .options(
            customers[0].0,
            customers[0].1,
            selection.starts_at.date_naive(),
        )
        .await
        .unwrap();
    assert!(!options.is_empty());
    assert!(options.iter().all(|s| s.source_id == source));
    let mut second = selection.clone();
    second.schedule_id = schedule;
    let held = service.reserve(customers[0].0, second).await.unwrap();
    assert_eq!(held.source_id, source);
    let allocations: Vec<Uuid> = sqlx::query_scalar(
        "SELECT source_id FROM inventory.reservation_allocations WHERE cart_id=$1",
    )
    .bind(held.cart_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(allocations, vec![source]);
    let area = Uuid::new_v4();
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km) VALUES($1,'Cairo',30,31,10)").bind(area).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.area_stock_links(area_id,stock_id) VALUES($1,$2)")
        .bind(area)
        .bind(SOURCE)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE cart_checkout.carts SET delivery_latitude=30,delivery_longitude=31")
        .execute(&pool)
        .await
        .unwrap();
    assert!(!service
        .options(
            customers[1].0,
            customers[1].1,
            selection.starts_at.date_naive()
        )
        .await
        .unwrap()
        .is_empty());
    sqlx::query("UPDATE customers.customer_locations SET latitude=50 WHERE id=$1")
        .bind(customers[1].1)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        matches!(service.options(customers[1].0,customers[1].1,selection.starts_at.date_naive()).await,Err(infra_auth::Error::Invalid(code)) if code=="OUTSIDE_DELIVERY_AREA")
    );
    assert!(service
        .options(
            customers[0].0,
            customers[1].1,
            selection.starts_at.date_naive()
        )
        .await
        .is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn dst_gaps_repeats_operational_history_and_lead_time(pool: PgPool) {
    let (_, _, _, selection) = setup(&pool, 1, 1, 10, "orders").await;
    let mut schedule: Schedule = sqlx::query_as("SELECT * FROM fulfillment.schedules WHERE id=$1")
        .bind(selection.schedule_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    schedule.timezone = "America/New_York".into();
    schedule.config["duration_minutes"] = json!(null);
    schedule.config["windows"] =
        json!([{"weekday":6,"start":"02:00:00","end":"02:30:00","cutoff":null}]);
    let mut tx = pool.begin().await.unwrap();
    let spring = chrono::NaiveDate::from_ymd_opt(2026, 3, 8).unwrap();
    assert!(scheduling::generate_operational(&mut tx, &schedule, spring)
        .await
        .unwrap()
        .is_empty());
    schedule.config["windows"] =
        json!([{"weekday":6,"start":"01:00:00","end":"01:30:00","cutoff":null}]);
    let fall = chrono::NaiveDate::from_ymd_opt(2026, 11, 1).unwrap();
    assert!(scheduling::generate_operational(&mut tx, &schedule, fall)
        .await
        .unwrap()
        .is_empty());
    schedule.timezone = "UTC".into();
    assert_eq!(
        scheduling::generate_operational(&mut tx, &schedule, fall)
            .await
            .unwrap()
            .len(),
        1
    );
    let today = Utc::now().date_naive();
    schedule.config["windows"] = json!([{"weekday":today.weekday().num_days_from_monday(),"start":"00:00:00","end":"23:59:00","cutoff":null}]);
    schedule.config["lead_minutes"] = json!(1440);
    assert!(scheduling::generate(&mut tx, &schedule, today)
        .await
        .unwrap()
        .is_empty());
    schedule.config["lead_minutes"] = json!(0);
    schedule.config["cutoff"] = json!("00:00:00");
    assert!(scheduling::generate(&mut tx, &schedule, today)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        scheduling::generate_operational(&mut tx, &schedule, today)
            .await
            .unwrap()
            .len(),
        1
    );
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn dated_override_raises_slot_cap_without_bypassing_daily_cap(pool: PgPool) {
    let (service, _, customers, selection) = setup(&pool, 3, 1, 1, "orders").await;
    let parent: Uuid = sqlx::query_scalar("SELECT id FROM fulfillment.capacity_rules LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    let date = selection.starts_at.date_naive();
    sqlx::query("INSERT INTO fulfillment.capacity_rules(id,source_id,period,limits,starts_on,ends_on,overrides_rule_id) VALUES($1,$2,'slot','{\"orders\":2}',$3,$3,$4)").bind(Uuid::new_v4()).bind(SOURCE).bind(date).bind(parent).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO fulfillment.capacity_rules(id,period,limits) VALUES($1,'day','{\"orders\":2}')").bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    for (index, (customer, location)) in customers.iter().enumerate() {
        let mut s = selection.clone();
        s.location_id = *location;
        s.idempotency_key = Uuid::new_v4();
        let result = service.reserve(*customer, s).await;
        if index < 2 {
            result.unwrap();
        } else {
            assert!(matches!(result,Err(infra_auth::Error::Invalid(code)) if code=="SLOT_FULL"));
        }
    }
    let options = service
        .options(customers[2].0, customers[2].1, date)
        .await
        .unwrap();
    assert!(options.is_empty());
    let overview = service.overview(date).await.unwrap();
    assert!(overview["slots"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["status"] == "Full"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn soft_overflow_and_missing_physical_facts_fail_closed(pool: PgPool) {
    let (service, _, customers, selection) = setup(&pool, 3, 1, 1, "orders").await;
    sqlx::query("UPDATE fulfillment.capacity_rules SET overflow_percent=100")
        .execute(&pool)
        .await
        .unwrap();
    for (index, (customer, location)) in customers.iter().enumerate() {
        let mut s = selection.clone();
        s.location_id = *location;
        s.idempotency_key = Uuid::new_v4();
        let held = service.reserve(*customer, s).await;
        if index < 2 {
            held.unwrap();
        } else {
            assert!(held.is_err());
        }
    }
    let overview = service
        .overview(selection.starts_at.date_naive())
        .await
        .unwrap();
    assert!(overview["slots"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["status"] == "Over Capacity"));
    sqlx::query("INSERT INTO fulfillment.capacity_rules(id,period,limits) VALUES($1,'day','{\"weight_grams\":100000}')").bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    assert!(service
        .options(
            customers[2].0,
            customers[2].1,
            selection.starts_at.date_naive()
        )
        .await
        .unwrap()
        .is_empty());
}

#[sqlx::test(migrations = "../../migrations")]
async fn installation_database_isolation(pool: PgPool) {
    use std::str::FromStr;
    let (a, _, customers, selection) = setup(&pool, 1, 1, 1, "orders").await;
    a.reserve(customers[0].0, selection.clone()).await.unwrap();
    let url = std::env::var("DATABASE_URL").unwrap();
    let control = PgPool::connect(&url).await.unwrap();
    let name = format!("capacity_tenant_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&control)
        .await
        .unwrap();
    let options = sqlx::postgres::PgConnectOptions::from_str(&url)
        .unwrap()
        .database(&name);
    let other = sqlx::postgres::PgPoolOptions::new()
        .connect_with(options)
        .await
        .unwrap();
    sqlx::migrate!("../../migrations")
        .run(&other)
        .await
        .unwrap();
    let (b, _, other_customers, other_selection) = setup(&other, 1, 1, 1, "orders").await;
    assert!(b.reserve(customers[0].0, selection).await.is_err());
    assert!(b
        .reserve(other_customers[0].0, other_selection)
        .await
        .is_ok());
    other.close().await;
    sqlx::query(&format!("DROP DATABASE {name}"))
        .execute(&control)
        .await
        .unwrap();
    control.close().await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn hourly_cap_is_shared_by_distinct_half_hour_slots(pool: PgPool) {
    let (service, _, customers, selection) = setup(&pool, 3, 1, 10, "orders").await;
    sqlx::query(
        "UPDATE fulfillment.schedules SET config=jsonb_set(config,'{duration_minutes}','30')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO fulfillment.capacity_rules(id,period,limits) VALUES($1,'hour','{\"orders\":1}')").bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    let mut first = selection.clone();
    first.ends_at = first.starts_at + Duration::minutes(30);
    service
        .reserve(customers[0].0, first.clone())
        .await
        .unwrap();
    let mut second = first.clone();
    second.location_id = customers[1].1;
    second.idempotency_key = Uuid::new_v4();
    second.starts_at += Duration::minutes(30);
    second.ends_at += Duration::minutes(30);
    assert!(
        matches!(service.reserve(customers[1].0,second).await,Err(infra_auth::Error::Invalid(code)) if code=="SLOT_FULL")
    );
    let mut third = first;
    third.location_id = customers[2].1;
    third.idempotency_key = Uuid::new_v4();
    third.starts_at += Duration::hours(1);
    third.ends_at += Duration::hours(1);
    service.reserve(customers[2].0, third).await.unwrap();
}
