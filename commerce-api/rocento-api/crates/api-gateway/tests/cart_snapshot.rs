//! Phase 4 snapshot and bulk-command regressions.
//! Metric-delta tests isolate process counters without serializing other test binaries.
use domain_cart_checkout::{Cart, Service as Carts};
use domain_inventory::Service as Inventory;
use infra_auth::Error;
use rust_decimal::Decimal;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

// Ordinary snapshot reads may run together; counter assertions exclude every
// producer in this binary. Other integration binaries have independent metrics.
static SNAPSHOT_METRICS: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

struct Fixture {
    carts: Carts,
    customer: Uuid,
    cart: Uuid,
    products: Vec<Uuid>,
}

async fn fixture(pool: &PgPool, count: usize) -> Fixture {
    let category = Uuid::new_v4();
    sqlx::query("INSERT INTO catalog.categories(id,name,slug) VALUES($1,'Snapshot fixtures','snapshot-fixtures')")
        .bind(category).execute(pool).await.unwrap();
    let products: Vec<_> = (0..count)
        .map(|index| Uuid::from_u128(1000 + index as u128))
        .collect();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) SELECT id,'SNAP-'||ordinal,'snapshot-'||ordinal,'Current name '||ordinal,'Snapshot fixture',1.25,'USD','each',$2 FROM unnest($1::uuid[]) WITH ORDINALITY ids(id,ordinal)")
        .bind(&products).bind(category).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.stock(product_id,on_hand) SELECT id,10 FROM unnest($1::uuid[]) ids(id)")
        .bind(&products).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.source_items(source_id,product_id,quantity) SELECT $2,id,10 FROM unnest($1::uuid[]) ids(id)")
        .bind(&products).bind(Uuid::from_u128(1)).execute(pool).await.unwrap();
    let customer = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash) VALUES($1,$2,'email','test-unused')")
        .bind(customer).bind(format!("{customer}@example.test")).execute(pool).await.unwrap();
    let cart = Uuid::new_v4();
    sqlx::query("INSERT INTO cart_checkout.carts(id,customer_id) VALUES($1,$2)")
        .bind(cart)
        .bind(customer)
        .execute(pool)
        .await
        .unwrap();
    Fixture {
        carts: Carts {
            pool: pool.clone(),
            inventory: Inventory::new(pool.clone(), 900).unwrap(),
        },
        customer,
        cart,
        products,
    }
}

async fn set_items(pool: &PgPool, f: &Fixture, count: usize) {
    sqlx::query("DELETE FROM cart_checkout.items WHERE cart_id=$1")
        .bind(f.cart)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM inventory.reservations WHERE cart_id=$1")
        .bind(f.cart)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO cart_checkout.items(cart_id,product_id,sku,name,unit,price,currency,quantity) SELECT $2,id,'STORED-'||ordinal,'Stored name '||ordinal,'stored-unit',1.00,'USD',2 FROM unnest($1::uuid[]) WITH ORDINALITY ids(id,ordinal)")
        .bind(&f.products[..count]).bind(f.cart).execute(pool).await.unwrap();
    // Alternate live and expired own holds, with another customer's live hold
    // on every SKU. Expired rows stay present throughout the read-only checks.
    sqlx::query("INSERT INTO inventory.reservations(cart_id,product_id,quantity,expires_at) SELECT $2,id,2,clock_timestamp()+CASE WHEN ordinal%2=1 THEN interval '1 hour' ELSE interval '-1 hour' END FROM unnest($1::uuid[]) WITH ORDINALITY ids(id,ordinal)")
        .bind(&f.products[..count]).bind(f.cart).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.reservation_allocations(cart_id,product_id,source_id,stock_id,quantity) SELECT cart_id,product_id,$2,$2,quantity FROM inventory.reservations WHERE cart_id=$1")
        .bind(f.cart).bind(Uuid::from_u128(1)).execute(pool).await.unwrap();
}

async fn add_other_holds(pool: &PgPool, products: &[Uuid]) {
    let cart = Uuid::new_v4();
    sqlx::query("INSERT INTO inventory.reservations(cart_id,product_id,quantity,expires_at) SELECT $2,id,3,clock_timestamp()+interval '1 hour' FROM unnest($1::uuid[]) ids(id)")
        .bind(products).bind(cart).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.reservation_allocations(cart_id,product_id,source_id,stock_id,quantity) SELECT cart_id,product_id,$2,$2,quantity FROM inventory.reservations WHERE cart_id=$1")
        .bind(cart).bind(Uuid::from_u128(1)).execute(pool).await.unwrap();
    let expired: Vec<_> = (0..101).map(|_| Uuid::new_v4()).collect();
    sqlx::query("INSERT INTO inventory.reservations(cart_id,product_id,quantity,expires_at) SELECT id,$2,1,clock_timestamp()+interval '1 hour' FROM unnest($1::uuid[]) ids(id)")
        .bind(&expired).bind(products[0]).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.reservation_allocations(cart_id,product_id,source_id,stock_id,quantity) SELECT cart_id,product_id,$2,$2,quantity FROM inventory.reservations WHERE cart_id=ANY($1)")
        .bind(&expired).bind(Uuid::from_u128(1)).execute(pool).await.unwrap();
    sqlx::query("SELECT inventory.refresh_availability($1)")
        .bind(products[0])
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE inventory.reservations SET expires_at=clock_timestamp()-interval '1 hour' WHERE cart_id=ANY($1)")
        .bind(&expired).execute(pool).await.unwrap();
}

async fn state(pool: &PgPool) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_object('carts',(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM cart_checkout.carts v),'items',(SELECT jsonb_agg(to_jsonb(v) ORDER BY cart_id,product_id) FROM cart_checkout.items v),'holds',(SELECT jsonb_agg(to_jsonb(v) ORDER BY cart_id,product_id) FROM inventory.reservations v),'allocations',(SELECT jsonb_agg(to_jsonb(v) ORDER BY cart_id,product_id,source_id) FROM inventory.reservation_allocations v),'stock',(SELECT jsonb_agg(to_jsonb(v) ORDER BY product_id) FROM inventory.stock v),'source_projection',(SELECT jsonb_agg(to_jsonb(v) ORDER BY source_id,product_id) FROM inventory.source_availability v),'outbox',(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM platform.outbox v))")
        .fetch_one(pool).await.unwrap()
}

async fn read(f: &Fixture) -> Cart {
    f.carts.read_customer(f.customer).await.unwrap().unwrap()
}

fn assert_snapshot(cart: &Cart, f: &Fixture, count: usize) {
    assert_eq!(cart.id, f.cart);
    assert_eq!(cart.customer_id, Some(f.customer));
    assert_eq!(cart.items.len(), count);
    assert_eq!(cart.currency, "USD");
    assert_eq!(cart.subtotal, Decimal::new(250 * count as i64, 2));
    assert_eq!(cart.fully_reserved, count == 1);
    for (index, item) in cart.items.iter().enumerate() {
        assert_eq!(item.product_id, f.products[index]);
        assert_eq!(item.sku, format!("SNAP-{}", index + 1));
        assert_eq!(item.name, format!("Stored name {}", index + 1));
        assert_eq!(item.unit, "stored-unit");
        assert_eq!(item.price, Decimal::new(125, 2));
        assert_eq!(item.line_total, Decimal::new(250, 2));
        assert_eq!(item.quantity, 2);
        assert_eq!(item.available, 7);
        assert_eq!(item.reserved_quantity, if index % 2 == 0 { 2 } else { 0 });
        assert_eq!(item.expires_at.is_some(), index % 2 == 0);
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn default_stock_snapshots_are_fresh_and_read_only_across_batch_boundaries(pool: PgPool) {
    let _metrics = SNAPSHOT_METRICS.read().await;
    let f = fixture(&pool, 200).await;
    add_other_holds(&pool, &f.products).await;
    for count in [1, 20, 21, 200] {
        set_items(&pool, &f, count).await;
        let before = state(&pool).await;
        assert_snapshot(&read(&f).await, &f, count);
        assert_eq!(
            state(&pool).await,
            before,
            "read changed state at {count} lines"
        );
    }
    let expired: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM inventory.reservations WHERE expires_at<=clock_timestamp()",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(expired, 201);
}

#[sqlx::test(migrations = "../../migrations")]
async fn area_snapshots_ignore_expiry_backlog_and_use_no_area_zero_without_writes(pool: PgPool) {
    let _metrics = SNAPSHOT_METRICS.read().await;
    let f = fixture(&pool, 200).await;
    let area = Uuid::new_v4();
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km) VALUES($1,'Snapshot area',30,31,10)")
        .bind(area).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.area_stock_links(area_id,stock_id) VALUES($1,$2)")
        .bind(area)
        .bind(Uuid::from_u128(1))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE cart_checkout.carts SET delivery_latitude=30,delivery_longitude=31 WHERE id=$1",
    )
    .bind(f.cart)
    .execute(&pool)
    .await
    .unwrap();
    add_other_holds(&pool, &f.products).await;
    let cached: i64 = sqlx::query_scalar(
        "SELECT available FROM inventory.source_availability WHERE source_id=$1 AND product_id=$2",
    )
    .bind(Uuid::from_u128(1))
    .bind(f.products[0])
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        cached, 0,
        "the fixture must leave an intentionally stale projection"
    );
    for count in [1, 20, 21, 200] {
        set_items(&pool, &f, count).await;
        let before = state(&pool).await;
        assert_snapshot(&read(&f).await, &f, count);
        assert_eq!(
            state(&pool).await,
            before,
            "area read changed state at {count} lines"
        );
    }
    sqlx::query(
        "UPDATE cart_checkout.carts SET delivery_latitude=NULL,delivery_longitude=NULL WHERE id=$1",
    )
    .bind(f.cart)
    .execute(&pool)
    .await
    .unwrap();
    let before = state(&pool).await;
    let no_area = read(&f).await;
    for item in no_area.items {
        assert_eq!(item.available, i64::from(item.reserved_quantity));
    }
    assert_eq!(state(&pool).await, before);
}

fn selling_rule(measure: &str, unit: &str) -> Value {
    json!({"kind":"pack","measure_unit":unit,"measure_per_unit":measure,"minimum":1,"maximum":1000,"increment":1,"estimated_weight":null,"final_weight":null,"regulated":false})
}

#[sqlx::test(migrations = "../../migrations")]
async fn snapshot_keeps_stored_names_and_units_but_refreshes_price_sku_and_rule_labels(
    pool: PgPool,
) {
    let _metrics = SNAPSHOT_METRICS.read().await;
    let f = fixture(&pool, 3).await;
    set_items(&pool, &f, 3).await;
    sqlx::query("UPDATE catalog.products SET price=2.75,sku='REFRESHED-SKU',name='New catalog name',unit='pack',active=false WHERE id=$1")
        .bind(f.products[0]).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO cart_checkout.selling_rules(product_id,rule) VALUES($1,$2)")
        .bind(f.products[0])
        .bind(selling_rule("6", "piece"))
        .execute(&pool)
        .await
        .unwrap();
    // This fallback is required for an existing cart even after its catalog
    // product disappears; inventory identity and stored line facts remain.
    sqlx::query("DELETE FROM catalog.products WHERE id=$1")
        .bind(f.products[1])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO cart_checkout.selling_rules(product_id,rule) VALUES($1,$2)")
        .bind(f.products[2]).bind(json!({"kind":"weight","measure_unit":"kg","measure_per_unit":"0.25","minimum":1,"maximum":1000,"increment":1,"estimated_weight":null,"final_weight":null,"regulated":false}))
        .execute(&pool).await.unwrap();
    let before = state(&pool).await;
    let cart = read(&f).await;
    assert_eq!(cart.items[0].sku, "REFRESHED-SKU");
    assert_eq!(cart.items[0].name, "Stored name 1");
    assert_eq!(cart.items[0].price, Decimal::new(275, 2));
    assert_eq!(cart.items[0].unit, "units of 6 pieces");
    assert_eq!(cart.items[1].sku, "STORED-2");
    assert_eq!(cart.items[1].name, "Stored name 2");
    assert_eq!(cart.items[1].price, Decimal::ONE);
    assert_eq!(cart.items[1].unit, "stored-unit");
    assert_eq!(cart.items[2].unit, "units of 0.25 kg");
    assert_eq!(cart.subtotal, Decimal::new(1000, 2));
    assert_eq!(state(&pool).await, before);
}

async fn snapshot_count(result: &str) -> u64 {
    let (_, metrics) = infra_observability::metrics().await;
    let prefix = format!("commerce_cart_snapshot_seconds_count{{result=\"{result}\"}} ");
    metrics
        .lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .map_or(0, |count| count.parse().unwrap())
}

async fn invalid_read(f: &Fixture, expected: &str) {
    let before = state(&f.carts.pool).await;
    match f.carts.read_customer(f.customer).await {
        Err(Error::Invalid(error)) => assert_eq!(error, expected),
        _ => panic!("snapshot should reject with {expected}"),
    }
    assert_eq!(state(&f.carts.pool).await, before);
}

#[sqlx::test(migrations = "../../migrations")]
async fn snapshot_reports_first_line_currency_or_rule_error_in_stored_order(pool: PgPool) {
    let _metrics = SNAPSHOT_METRICS.write().await;
    let f = fixture(&pool, 21).await;
    set_items(&pool, &f, 21).await;
    sqlx::query("UPDATE catalog.products SET currency='EGP' WHERE id=$1")
        .bind(f.products[0])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO cart_checkout.selling_rules(product_id,rule) VALUES($1,'{\"unknown_field\":true}'::jsonb)")
        .bind(f.products[20]).execute(&pool).await.unwrap();
    let errors_before = snapshot_count("error").await;
    invalid_read(&f, "CURRENCY_MISMATCH").await;
    sqlx::query("UPDATE catalog.products SET currency='USD' WHERE id=$1")
        .bind(f.products[0])
        .execute(&pool)
        .await
        .unwrap();
    invalid_read(&f, "SELLING_RULE_INVALID").await;
    sqlx::query("INSERT INTO cart_checkout.selling_rules(product_id,rule) VALUES($1,'{\"unknown_field\":true}'::jsonb)")
        .bind(f.products[0]).execute(&pool).await.unwrap();
    sqlx::query("UPDATE catalog.products SET currency='EGP' WHERE id=$1")
        .bind(f.products[20])
        .execute(&pool)
        .await
        .unwrap();
    invalid_read(&f, "SELLING_RULE_INVALID").await;
    assert_eq!(snapshot_count("error").await, errors_before + 3);
}

async fn bundle_parent(pool: &PgPool, f: &Fixture, quantities: &[i32]) -> Uuid {
    let parent = Uuid::new_v4();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,product_type) SELECT $1,'SNAP-BUNDLE','snapshot-bundle','Snapshot bundle','Snapshot fixture',0,'USD','each',category_id,'bundle' FROM catalog.products WHERE id=$2")
        .bind(parent).bind(f.products[0]).execute(pool).await.unwrap();
    for (index, quantity) in quantities.iter().enumerate() {
        sqlx::query("INSERT INTO catalog.product_links(parent_id,child_id,position,option_label,quantity) VALUES($1,$2,$3,$4,$5)")
            .bind(parent).bind(f.products[index]).bind(index as i32).bind(format!("Group {index}")).bind(quantity)
            .execute(pool).await.unwrap();
    }
    parent
}

async fn event_quantities(pool: &PgPool, cart: Uuid, event: &str) -> Vec<(Uuid, i32)> {
    sqlx::query_as("SELECT (payload->>'product_id')::uuid,(payload->>'quantity')::integer FROM platform.outbox WHERE event_type=$2 AND (payload->>'cart_id')::uuid=$1 ORDER BY (payload->>'product_id')::uuid")
        .bind(cart).bind(event).fetch_all(pool).await.unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn bundle_builds_one_snapshot_and_preserves_child_quantities_and_events(pool: PgPool) {
    let _metrics = SNAPSHOT_METRICS.write().await;
    let f = fixture(&pool, 3).await;
    let parent = bundle_parent(&pool, &f, &[2, 3, 4]).await;
    let before = snapshot_count("success").await;
    let cart = f
        .carts
        .bundle(Some(f.customer), "", parent, f.products.clone())
        .await
        .unwrap();
    assert_eq!(snapshot_count("success").await, before + 1);
    assert_eq!(cart.items.len(), 3);
    assert!(cart.fully_reserved);
    assert_eq!(cart.subtotal, Decimal::new(1125, 2));
    let expected: Vec<_> = f.products.iter().copied().zip([2, 3, 4]).collect();
    assert_eq!(
        cart.items
            .iter()
            .map(|item| (item.product_id, item.quantity))
            .collect::<Vec<_>>(),
        expected
    );
    assert_eq!(
        event_quantities(&pool, f.cart, "cart.item_added").await,
        expected
    );
    assert_eq!(
        event_quantities(&pool, f.cart, "inventory.reserved").await,
        expected
    );
    for item in cart.items {
        assert_eq!(item.reserved_quantity, item.quantity);
        assert_eq!(item.available, 10);
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn late_bundle_shortage_rolls_back_all_prior_lines_holds_and_events(pool: PgPool) {
    let _metrics = SNAPSHOT_METRICS.write().await;
    let f = fixture(&pool, 3).await;
    let parent = bundle_parent(&pool, &f, &[2, 3, 4]).await;
    let product = domain_catalog::Service { pool: pool.clone() }
        .product(f.products[0])
        .await
        .unwrap();
    f.carts
        .set(Some(f.customer), "", product, 1, true)
        .await
        .unwrap();
    sqlx::query("UPDATE inventory.source_items SET quantity=0 WHERE product_id=$1")
        .bind(f.products[2])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("SELECT inventory.refresh_stock()")
        .execute(&pool)
        .await
        .unwrap();
    let before = state(&pool).await;
    let snapshots = snapshot_count("success").await;
    assert!(matches!(
        f.carts
            .bundle(Some(f.customer), "", parent, f.products.clone())
            .await,
        Err(Error::Invalid(_))
    ));
    assert_eq!(
        state(&pool).await,
        before,
        "late failure changed a preexisting line/hold or persisted an earlier child"
    );
    assert_eq!(
        snapshot_count("success").await,
        snapshots,
        "failed mutation should not assemble a response"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn multi_item_wishlist_transfer_builds_once_and_replays_the_exact_receipt(pool: PgPool) {
    let _metrics = SNAPSHOT_METRICS.write().await;
    let f = fixture(&pool, 21).await;
    sqlx::query("INSERT INTO reviews.wishlist(customer_id,product_id) SELECT $1,id FROM unnest($2::uuid[]) ids(id)")
        .bind(f.customer).bind(&f.products).execute(&pool).await.unwrap();
    let request = Uuid::new_v4();
    let snapshots = snapshot_count("success").await;
    let first = f
        .carts
        .transfer_wishlist_to_cart(f.customer, request, f.products.clone())
        .await
        .unwrap();
    assert!(!first.replayed);
    assert_eq!(snapshot_count("success").await, snapshots + 1);
    assert_eq!(first.result["items"].as_array().unwrap().len(), 21);
    assert_eq!(first.result["cart"]["items"].as_array().unwrap().len(), 21);
    assert_eq!(first.result["cart"]["fully_reserved"], true);
    assert_eq!(first.result["cart"]["subtotal"], "26.25");
    let expected: Vec<_> = f.products.iter().copied().map(|id| (id, 1)).collect();
    assert_eq!(
        event_quantities(&pool, f.cart, "cart.item_added").await,
        expected
    );
    assert_eq!(
        event_quantities(&pool, f.cart, "inventory.reserved").await,
        expected
    );
    let remaining: i64 =
        sqlx::query_scalar("SELECT count(*) FROM reviews.wishlist WHERE customer_id=$1")
            .bind(f.customer)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(remaining, 0);
    sqlx::query("UPDATE catalog.products SET price=9.50,active=false")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE inventory.reservations SET expires_at=clock_timestamp()-interval '1 hour' WHERE cart_id=$1")
        .bind(f.cart).execute(&pool).await.unwrap();
    let before = state(&pool).await;
    let mut reverse = f.products.clone();
    reverse.reverse();
    let replay = f
        .carts
        .transfer_wishlist_to_cart(f.customer, request, reverse)
        .await
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.result, first.result);
    assert_eq!(
        snapshot_count("success").await,
        snapshots + 1,
        "saved receipt replay must not reproject the cart"
    );
    assert_eq!(state(&pool).await, before);
    let receipts: i64 = sqlx::query_scalar("SELECT count(*) FROM cart_checkout.assistant_wishlist_transfers WHERE customer_id=$1 AND request_id=$2")
        .bind(f.customer).bind(request).fetch_one(&pool).await.unwrap();
    assert_eq!(receipts, 1);
}
