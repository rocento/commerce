use domain_cart_checkout::Service as Carts;
use domain_catalog::{CategoryInput, Product, Service as Catalog};
use domain_inventory::{Service as Inventory, EXPIRY_BATCH_SIZE};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

struct Fixture {
    carts: Carts,
    products: Vec<Product>,
    area: Uuid,
}

async fn fixture(pool: &PgPool, quantities: &[i32]) -> Fixture {
    let catalog = Catalog { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            CategoryInput {
                name: "Expiry regression".into(),
                slug: "expiry-regression".into(),
                parent_id: None,
            },
        )
        .await
        .unwrap();
    let mut products = Vec::new();
    for (index, quantity) in quantities.iter().enumerate() {
        let product = catalog
            .save_product(
                None,
                serde_json::from_value(json!({
                    "sku": format!("EXPIRY-{index}"), "slug": format!("expiry-{index}"),
                    "name": format!("Expiry product {index}"), "description": "Expiry regression",
                    "price": "2.50", "currency": "USD", "unit": "each", "category_id": category.id,
                    "attributes": {}, "media_ids": [], "active": true, "in_stock": true
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        sqlx::query("INSERT INTO inventory.stock(product_id,on_hand) VALUES($1,$2)")
            .bind(product.id)
            .bind(quantity)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO inventory.source_items(source_id,product_id,quantity) VALUES($1,$2,$3)",
        )
        .bind(Uuid::from_u128(1))
        .bind(product.id)
        .bind(quantity)
        .execute(pool)
        .await
        .unwrap();
        refresh(pool, product.id).await;
        products.push(product);
    }
    let area = Uuid::new_v4();
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km) VALUES($1,'Expiry area',30,31,10)")
        .bind(area).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.area_stock_links(area_id,stock_id) VALUES($1,$2)")
        .bind(area)
        .bind(Uuid::from_u128(1))
        .execute(pool)
        .await
        .unwrap();
    Fixture {
        carts: Carts {
            pool: pool.clone(),
            inventory: Inventory::new(pool.clone(), 900).unwrap(),
        },
        products,
        area,
    }
}

async fn refresh(pool: &PgPool, product: Uuid) {
    sqlx::query("SELECT inventory.refresh_availability($1)")
        .bind(product)
        .execute(pool)
        .await
        .unwrap();
}

// Bulk fixtures first maintain the projection while holds are live, then age
// those holds. This reproduces a cache that has not yet seen TTL expiration.
async fn holds(pool: &PgPool, product: Uuid, carts: &[Uuid], quantity: i32) {
    sqlx::query("INSERT INTO inventory.reservations(cart_id,product_id,quantity,expires_at) SELECT id,$2,$3,clock_timestamp()+interval '1 hour' FROM unnest($1::uuid[]) ids(id)")
        .bind(carts).bind(product).bind(quantity).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.reservation_allocations(cart_id,product_id,source_id,stock_id,quantity) SELECT id,$2,$3,$3,$4 FROM unnest($1::uuid[]) ids(id)")
        .bind(carts).bind(product).bind(Uuid::from_u128(1)).bind(quantity)
        .execute(pool).await.unwrap();
    refresh(pool, product).await;
}

async fn age(pool: &PgPool, carts: &[Uuid], seconds: f64) {
    sqlx::query("UPDATE inventory.reservations SET expires_at=clock_timestamp()-make_interval(secs=>$2) WHERE cart_id=ANY($1)")
        .bind(carts).bind(seconds).execute(pool).await.unwrap();
}

async fn expired(pool: &PgPool, product: Uuid, count: usize, seconds: f64) -> Vec<Uuid> {
    let carts: Vec<_> = (0..count).map(|_| Uuid::new_v4()).collect();
    holds(pool, product, &carts, 1).await;
    age(pool, &carts, seconds).await;
    carts
}

async fn remaining(pool: &PgPool) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM inventory.reservations WHERE expires_at<=clock_timestamp()",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn event_count(pool: &PgPool, event: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM platform.outbox WHERE event_type=$1")
        .bind(event)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn cached_available(pool: &PgPool, product: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT available FROM inventory.source_availability WHERE product_id=$1 AND source_id=$2",
    )
    .bind(product)
    .bind(Uuid::from_u128(1))
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn customer_cart(pool: &PgPool, carts: &Carts) -> (Uuid, Uuid) {
    let customer = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash) VALUES($1,$2,'email','test-unused')")
        .bind(customer).bind(format!("{customer}@example.test"))
        .execute(pool).await.unwrap();
    let cart = carts.open(Some(customer), "").await.unwrap().cart.id;
    pin(pool, cart).await;
    (customer, cart)
}

async fn guest_cart(pool: &PgPool, carts: &Carts) -> String {
    let session = carts.open(None, "").await.unwrap();
    pin(pool, session.cart.id).await;
    session.guest_token.unwrap()
}

async fn pin(pool: &PgPool, cart: Uuid) {
    sqlx::query(
        "UPDATE cart_checkout.carts SET delivery_latitude=30,delivery_longitude=31 WHERE id=$1",
    )
    .bind(cart)
    .execute(pool)
    .await
    .unwrap();
}

async fn cart_item(pool: &PgPool, cart: Uuid, product: &Product) {
    sqlx::query("INSERT INTO cart_checkout.items(cart_id,product_id,sku,name,unit,price,currency,quantity) VALUES($1,$2,$3,$4,$5,$6,$7,1)")
        .bind(cart).bind(product.id).bind(&product.sku).bind(&product.name)
        .bind(&product.unit).bind(product.price).bind(&product.currency)
        .execute(pool).await.unwrap();
}

async fn install_refresh_audit(pool: &PgPool) {
    // The fixture has one enabled source per product. Every availability refresh
    // reinserts exactly one row, so this counts actual refresh execution.
    sqlx::raw_sql(
        "CREATE TABLE public.expiry_refresh_audit(product_id uuid NOT NULL);
         CREATE FUNCTION public.audit_expiry_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN INSERT INTO public.expiry_refresh_audit VALUES(NEW.product_id); RETURN NEW; END;
         $$;
         CREATE TRIGGER expiry_refresh_audit AFTER INSERT ON inventory.source_availability
         FOR EACH ROW EXECUTE FUNCTION public.audit_expiry_refresh();",
    )
    .execute(pool)
    .await
    .unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn expiry_drains_bounded_batches_with_events_and_one_refresh_per_product(pool: PgPool) {
    let f = fixture(&pool, &[500, 500]).await;
    let batch = EXPIRY_BATCH_SIZE;
    let live = Uuid::new_v4();
    holds(&pool, f.products[0].id, &[live], 3).await;
    // The first batch affects only product 0, the second affects both, and the
    // final batch affects only product 1. Repeated holds cannot multiply refreshes.
    let mut expired_carts = expired(&pool, f.products[0].id, batch + 7, 180.0).await;
    expired_carts.extend(expired(&pool, f.products[1].id, batch, 120.0).await);
    install_refresh_audit(&pool).await;

    assert_eq!(f.carts.inventory.expire().await.unwrap(), batch as u64);
    assert_eq!(remaining(&pool).await, (batch + 7) as i64);
    assert_eq!(event_count(&pool, "inventory.released").await, batch as i64);
    assert_eq!(
        event_count(&pool, "inventory.stock_updated").await,
        batch as i64
    );
    let first_refreshes: i64 =
        sqlx::query_scalar("SELECT count(*) FROM public.expiry_refresh_audit")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(first_refreshes, 1);
    assert_eq!(cached_available(&pool, f.products[0].id).await, 497);

    assert_eq!(f.carts.inventory.expire().await.unwrap(), batch as u64);
    assert_eq!(remaining(&pool).await, 7);
    assert_eq!(f.carts.inventory.expire().await.unwrap(), 7);
    assert_eq!(f.carts.inventory.expire().await.unwrap(), 0);
    assert_eq!(remaining(&pool).await, 0);
    let refreshes: Vec<(Uuid, i64)> = sqlx::query_as(
        "SELECT product_id,count(*) FROM public.expiry_refresh_audit GROUP BY product_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(refreshes.len(), 2);
    assert!(refreshes.iter().all(|(_, count)| *count == 2));
    let total = expired_carts.len() as i64;
    assert_eq!(event_count(&pool, "inventory.released").await, total);
    assert_eq!(event_count(&pool, "inventory.stock_updated").await, total);
    let releases: (i64, i64) = sqlx::query_as("SELECT count(*),count(DISTINCT payload->>'cart_id') FROM platform.outbox WHERE event_type='inventory.released' AND payload->>'reason'='expired' AND payload->>'quantity'='1'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(releases, (total, total));
    let allocations: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM inventory.reservation_allocations WHERE cart_id=ANY($1)",
    )
    .bind(&expired_carts)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(allocations, 0);
    assert_eq!(
        f.carts
            .inventory
            .stock(f.products[0].id)
            .await
            .unwrap()
            .reserved,
        3
    );
    assert_eq!(
        f.carts
            .inventory
            .area_available(f.area, f.products[0].id)
            .await
            .unwrap(),
        497
    );
    assert_eq!(cached_available(&pool, f.products[1].id).await, 500);
}

#[sqlx::test(migrations = "../../migrations")]
async fn expiry_rollback_restores_holds_allocations_projection_and_outbox(pool: PgPool) {
    let f = fixture(&pool, &[500]).await;
    let batch = EXPIRY_BATCH_SIZE;
    let expired_carts = expired(&pool, f.products[0].id, batch + 1, 120.0).await;
    let cached_before = cached_available(&pool, f.products[0].id).await;
    install_refresh_audit(&pool).await;

    let mut tx = domain_inventory::begin(&pool).await.unwrap();
    assert_eq!(Inventory::expire_in(&mut tx).await.unwrap(), batch as u64);
    let deleted: i64 =
        sqlx::query_scalar("SELECT count(*) FROM inventory.reservations WHERE cart_id=ANY($1)")
            .bind(&expired_carts)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(deleted, 1);
    let refreshed: i64 = sqlx::query_scalar("SELECT count(*) FROM public.expiry_refresh_audit")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(refreshed, 1);
    tx.rollback().await.unwrap();

    assert_eq!(remaining(&pool).await, (batch + 1) as i64);
    let allocations: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM inventory.reservation_allocations WHERE cart_id=ANY($1)",
    )
    .bind(&expired_carts)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(allocations, (batch + 1) as i64);
    assert_eq!(
        cached_available(&pool, f.products[0].id).await,
        cached_before
    );
    assert_eq!(event_count(&pool, "inventory.released").await, 0);
    assert_eq!(event_count(&pool, "inventory.stock_updated").await, 0);
    let committed_refreshes: i64 =
        sqlx::query_scalar("SELECT count(*) FROM public.expiry_refresh_audit")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(committed_refreshes, 0);
    assert_eq!(f.carts.inventory.expire().await.unwrap(), batch as u64);
    assert_eq!(event_count(&pool, "inventory.released").await, batch as i64);
}

#[sqlx::test(migrations = "../../migrations")]
async fn unprocessed_expiry_remainder_has_live_area_batch_and_read_only_cart_stock(pool: PgPool) {
    let f = fixture(&pool, &[500, 5]).await;
    let shared_stock = Uuid::new_v4();
    sqlx::query("INSERT INTO inventory.stocks(id,code,name) VALUES($1,'expiry-shared','Shared source stock')")
        .bind(shared_stock).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.source_stock_links(stock_id,source_id) VALUES($1,$2)")
        .bind(shared_stock)
        .bind(Uuid::from_u128(1))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO inventory.area_stock_links(area_id,stock_id) VALUES($1,$2)")
        .bind(f.area)
        .bind(shared_stock)
        .execute(&pool)
        .await
        .unwrap();
    let (customer, cart) = customer_cart(&pool, &f.carts).await;
    cart_item(&pool, cart, &f.products[1]).await;
    expired(&pool, f.products[0].id, EXPIRY_BATCH_SIZE, 180.0).await;
    holds(&pool, f.products[1].id, &[Uuid::new_v4()], 2).await;
    holds(&pool, f.products[1].id, &[cart], 1).await;
    age(&pool, &[cart], 60.0).await;
    assert_eq!(cached_available(&pool, f.products[1].id).await, 2);

    assert_eq!(
        f.carts.inventory.expire().await.unwrap(),
        EXPIRY_BATCH_SIZE as u64
    );
    assert_eq!(remaining(&pool).await, 1);
    // Product 1 was not in the batch. Live readers must ignore its expired hold
    // even though the asynchronous materialized projection still includes it.
    assert_eq!(cached_available(&pool, f.products[1].id).await, 2);
    assert_eq!(
        f.carts
            .inventory
            .area_available(f.area, f.products[1].id)
            .await
            .unwrap(),
        3
    );
    let batch = f
        .carts
        .inventory
        .available_many(&[f.products[1].id, f.products[1].id], Some(f.area))
        .await
        .unwrap();
    assert_eq!(batch.get(&f.products[1].id), Some(&3));
    assert_eq!(batch.len(), 1);
    let stocks = f
        .carts
        .inventory
        .available_stocks(f.products[1].id)
        .await
        .unwrap();
    assert_eq!(stocks.len(), 2);
    assert!(stocks.contains(&Uuid::from_u128(1)));
    assert!(stocks.contains(&shared_stock));
    let view = f.carts.read_customer(customer).await.unwrap().unwrap();
    assert_eq!(view.items.len(), 1);
    assert_eq!(view.items[0].reserved_quantity, 0);
    assert_eq!(view.items[0].available, 3);
    assert!(!view.fully_reserved);
    assert_eq!(remaining(&pool).await, 1);
    assert_eq!(
        event_count(&pool, "inventory.released").await,
        EXPIRY_BATCH_SIZE as i64
    );

    sqlx::query("UPDATE inventory.inventory_sources SET is_enabled=false WHERE id=$1")
        .bind(Uuid::from_u128(1))
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        f.carts
            .inventory
            .area_available(f.area, f.products[1].id)
            .await
            .unwrap(),
        0
    );
    let unavailable = f
        .carts
        .inventory
        .available_many(&[f.products[1].id], Some(f.area))
        .await
        .unwrap();
    assert_eq!(unavailable.get(&f.products[1].id).copied().unwrap_or(0), 0);
    assert!(f
        .carts
        .inventory
        .available_stocks(f.products[1].id)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        f.carts
            .read_customer(customer)
            .await
            .unwrap()
            .unwrap()
            .items[0]
            .available,
        0
    );
    sqlx::query("UPDATE inventory.inventory_sources SET is_enabled=true WHERE id=$1")
        .bind(Uuid::from_u128(1))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE inventory.source_items SET status='out_of_stock' WHERE product_id=$1")
        .bind(f.products[1].id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        f.carts
            .inventory
            .area_available(f.area, f.products[1].id)
            .await
            .unwrap(),
        0
    );
    assert!(f
        .carts
        .inventory
        .available_stocks(f.products[1].id)
        .await
        .unwrap()
        .is_empty());
    sqlx::query("UPDATE inventory.source_items SET status='in_stock' WHERE product_id=$1")
        .bind(f.products[1].id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE inventory.delivery_areas SET is_active=false WHERE id=$1")
        .bind(f.area)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        f.carts
            .inventory
            .area_available(f.area, f.products[1].id)
            .await
            .unwrap(),
        0
    );
    let inactive = f
        .carts
        .inventory
        .available_many(&[f.products[1].id], Some(f.area))
        .await
        .unwrap();
    assert_eq!(inactive.get(&f.products[1].id).copied().unwrap_or(0), 0);
    assert_eq!(remaining(&pool).await, 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn exact_expired_hold_is_released_before_reserving_or_removing_without_global_sweep(
    pool: PgPool,
) {
    let f = fixture(&pool, &[500, 2]).await;
    let (customer, cart) = customer_cart(&pool, &f.carts).await;
    cart_item(&pool, cart, &f.products[1]).await;
    expired(&pool, f.products[0].id, EXPIRY_BATCH_SIZE, 180.0).await;
    holds(&pool, f.products[1].id, &[cart], 1).await;
    age(&pool, &[cart], 60.0).await;

    let updated = f
        .carts
        .set(Some(customer), "", f.products[1].clone(), 1, false)
        .await
        .unwrap();
    assert_eq!(updated.items[0].reserved_quantity, 1);
    assert_eq!(remaining(&pool).await, EXPIRY_BATCH_SIZE as i64);
    assert_eq!(event_count(&pool, "inventory.released").await, 1);
    assert_eq!(event_count(&pool, "inventory.reserved").await, 1);
    let release: (String, String, String) = sqlx::query_as("SELECT payload->>'reason',payload->>'cart_id',payload->>'quantity' FROM platform.outbox WHERE event_type='inventory.released'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(release, ("expired".into(), cart.to_string(), "1".into()));

    age(&pool, &[cart], 60.0).await;
    f.carts
        .remove(Some(customer), "", f.products[1].id)
        .await
        .unwrap();
    assert_eq!(remaining(&pool).await, EXPIRY_BATCH_SIZE as i64);
    assert_eq!(event_count(&pool, "inventory.released").await, 2);
    let non_expired_releases: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.outbox WHERE event_type='inventory.released' AND payload->>'reason'<>'expired'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(non_expired_releases, 0);
    assert_eq!(
        f.carts
            .inventory
            .area_available(f.area, f.products[1].id)
            .await
            .unwrap(),
        2
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn caught_allocation_failure_preserves_active_hold_when_outer_transaction_commits(
    pool: PgPool,
) {
    let f = fixture(&pool, &[3]).await;
    let (_, cart) = customer_cart(&pool, &f.carts).await;
    let product = f.products[0].id;
    let mut tx = domain_inventory::begin(&pool).await.unwrap();
    f.carts
        .inventory
        .reserve(&mut tx, cart, product, 2)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let hold_before: (i32, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
        "SELECT quantity,expires_at FROM inventory.reservations WHERE cart_id=$1 AND product_id=$2",
    )
    .bind(cart)
    .bind(product)
    .fetch_one(&pool)
    .await
    .unwrap();
    let allocations_before: Vec<(Uuid, Uuid, i32)> = sqlx::query_as(
        "SELECT source_id,stock_id,quantity FROM inventory.reservation_allocations
         WHERE cart_id=$1 AND product_id=$2 ORDER BY source_id",
    )
    .bind(cart)
    .bind(product)
    .fetch_all(&pool)
    .await
    .unwrap();
    let available_before = cached_available(&pool, product).await;
    assert_eq!(available_before, 1);
    assert_eq!(
        f.carts
            .inventory
            .area_available(f.area, product)
            .await
            .unwrap(),
        available_before
    );
    let events = [
        "inventory.reserved",
        "inventory.released",
        "inventory.stock_updated",
    ];
    let mut counts_before = Vec::new();
    for event in events {
        counts_before.push(event_count(&pool, event).await);
    }

    // Guest merge intentionally catches an allocation rejection and commits
    // its other cart changes. A failed renewal must leave the old hold intact.
    let mut tx = domain_inventory::begin(&pool).await.unwrap();
    let result = f.carts.inventory.reserve(&mut tx, cart, product, 4).await;
    assert!(matches!(result, Err(infra_auth::Error::Invalid(_))));
    tx.commit().await.unwrap();

    let hold_after: (i32, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
        "SELECT quantity,expires_at FROM inventory.reservations WHERE cart_id=$1 AND product_id=$2",
    )
    .bind(cart)
    .bind(product)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(hold_after, hold_before);
    let allocations_after: Vec<(Uuid, Uuid, i32)> = sqlx::query_as(
        "SELECT source_id,stock_id,quantity FROM inventory.reservation_allocations
         WHERE cart_id=$1 AND product_id=$2 ORDER BY source_id",
    )
    .bind(cart)
    .bind(product)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(allocations_after, allocations_before);
    assert_eq!(cached_available(&pool, product).await, available_before);
    assert_eq!(
        f.carts
            .inventory
            .area_available(f.area, product)
            .await
            .unwrap(),
        available_before
    );
    let stock = f.carts.inventory.stock(product).await.unwrap();
    assert_eq!((stock.reserved, stock.available), (2, available_before));
    for (event, before) in events.into_iter().zip(counts_before) {
        assert_eq!(event_count(&pool, event).await, before, "{event}");
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_cleanup_and_last_unit_allocations_preserve_one_winner(pool: PgPool) {
    let f = fixture(&pool, &[500, 1]).await;
    let first = guest_cart(&pool, &f.carts).await;
    let second = guest_cart(&pool, &f.carts).await;
    expired(&pool, f.products[0].id, EXPIRY_BATCH_SIZE, 180.0).await;
    expired(&pool, f.products[1].id, 1, 60.0).await;
    assert_eq!(cached_available(&pool, f.products[1].id).await, 0);

    let (cleanup, one, two) = tokio::join!(
        f.carts.inventory.expire(),
        f.carts.set(None, &first, f.products[1].clone(), 1, true),
        f.carts.set(None, &second, f.products[1].clone(), 1, true),
    );
    assert_eq!(cleanup.unwrap(), EXPIRY_BATCH_SIZE as u64);
    assert_ne!(one.is_ok(), two.is_ok());
    assert_eq!(remaining(&pool).await, 1);
    let stock = f.carts.inventory.stock(f.products[1].id).await.unwrap();
    assert_eq!(stock.on_hand, 1);
    assert_eq!(stock.reserved, 1);
    assert_eq!(stock.available, 0);
    assert_eq!(
        f.carts
            .inventory
            .area_available(f.area, f.products[1].id)
            .await
            .unwrap(),
        0
    );
    assert_eq!(event_count(&pool, "inventory.reserved").await, 1);
    assert_eq!(f.carts.inventory.expire().await.unwrap(), 1);
    assert_eq!(
        f.carts
            .inventory
            .stock(f.products[1].id)
            .await
            .unwrap()
            .reserved,
        1
    );
    assert_eq!(
        event_count(&pool, "inventory.released").await,
        EXPIRY_BATCH_SIZE as i64 + 1
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_expiry_and_wishlist_retries_preserve_exact_receipt_and_single_claim(
    pool: PgPool,
) {
    let f = fixture(&pool, &[500, 1]).await;
    let (customer, cart) = customer_cart(&pool, &f.carts).await;
    sqlx::query("INSERT INTO reviews.wishlist(customer_id,product_id) VALUES($1,$2)")
        .bind(customer)
        .bind(f.products[1].id)
        .execute(&pool)
        .await
        .unwrap();
    expired(&pool, f.products[0].id, 2 * EXPIRY_BATCH_SIZE + 1, 180.0).await;
    expired(&pool, f.products[1].id, 1, 60.0).await;
    let request = Uuid::new_v4();
    let ids = vec![f.products[1].id];
    let (cleanup, first, retry) = tokio::join!(
        f.carts.inventory.expire(),
        f.carts
            .transfer_wishlist_to_cart(customer, request, ids.clone()),
        f.carts
            .transfer_wishlist_to_cart(customer, request, ids.clone()),
    );
    assert_eq!(cleanup.unwrap(), EXPIRY_BATCH_SIZE as u64);
    let first = first.unwrap();
    let retry = retry.unwrap();
    assert_ne!(first.replayed, retry.replayed);
    assert_eq!(first.result, retry.result);
    assert_eq!(first.result["cart"]["items"][0]["quantity"], 1);
    assert_eq!(event_count(&pool, "inventory.reserved").await, 1);

    // A saved receipt remains exact after its reservation expires. Replaying
    // must not add quantity, refresh the hold, or recreate wishlist membership.
    age(&pool, &[cart], 30.0).await;
    let (cleanup, replay) = tokio::join!(
        f.carts.inventory.expire(),
        f.carts.transfer_wishlist_to_cart(customer, request, ids),
    );
    assert_eq!(cleanup.unwrap(), EXPIRY_BATCH_SIZE as u64);
    let replay = replay.unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.result, first.result);
    assert_eq!(event_count(&pool, "inventory.reserved").await, 1);
    let receipt_count: i64 = sqlx::query_scalar("SELECT count(*) FROM cart_checkout.assistant_wishlist_transfers WHERE customer_id=$1 AND request_id=$2")
        .bind(customer).bind(request).fetch_one(&pool).await.unwrap();
    let claim_count: i64 = sqlx::query_scalar("SELECT count(*) FROM cart_checkout.assistant_actions WHERE customer_id=$1 AND request_id=$2")
        .bind(customer).bind(request).fetch_one(&pool).await.unwrap();
    let wishlist_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM reviews.wishlist WHERE customer_id=$1")
            .bind(customer)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!((receipt_count, claim_count, wishlist_count), (1, 1, 0));
    let view = f.carts.read_customer(customer).await.unwrap().unwrap();
    assert_eq!(view.items[0].quantity, 1);
    assert_eq!(view.items[0].reserved_quantity, 0);
    assert!(!view.fully_reserved);
}
