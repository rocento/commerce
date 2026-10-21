//! Login merges preserve bounded carts and reservations in the destination source scope.
use domain_cart_checkout::Service as Carts;
use domain_inventory::{areas::Pin, Service as Inventory};
use infra_auth::Error;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

struct Fixture {
    carts: Carts,
    customer: Uuid,
    account: Uuid,
    products: Vec<Uuid>,
}

async fn fixture(pool: &PgPool, count: usize) -> Fixture {
    let category = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO catalog.categories(id,name,slug) VALUES($1,'Merge fixtures','merge-fixtures')",
    )
    .bind(category)
    .execute(pool)
    .await
    .unwrap();
    let products: Vec<_> = (0..count)
        .map(|n| Uuid::from_u128(1000 + n as u128))
        .collect();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) SELECT id,'MERGE-'||ordinal,'merge-'||ordinal,'Merge product '||ordinal,'Fixture',1.25,'USD','each',$2 FROM unnest($1::uuid[]) WITH ORDINALITY ids(id,ordinal)")
        .bind(&products).bind(category).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.stock(product_id,on_hand) SELECT id,10 FROM unnest($1::uuid[]) ids(id)")
        .bind(&products).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.source_items(source_id,product_id,quantity) SELECT $2,id,10 FROM unnest($1::uuid[]) ids(id)")
        .bind(&products).bind(Uuid::from_u128(1)).execute(pool).await.unwrap();
    let customer = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash) VALUES($1,$2,'email','test-unused')")
        .bind(customer).bind(format!("{customer}@example.test")).execute(pool).await.unwrap();
    let carts = Carts {
        pool: pool.clone(),
        inventory: Inventory::new(pool.clone(), 900).unwrap(),
    };
    let account = carts.open(Some(customer), "").await.unwrap().cart.id;
    Fixture {
        carts,
        customer,
        account,
        products,
    }
}

async fn seed_cart(pool: &PgPool, cart: Uuid, products: &[Uuid]) {
    sqlx::query("INSERT INTO cart_checkout.items(cart_id,product_id,sku,name,unit,price,currency,quantity) SELECT $2,id,sku,name,unit,price,currency,1 FROM catalog.products WHERE id=ANY($1)")
        .bind(products).bind(cart).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.reservations(cart_id,product_id,quantity,expires_at) SELECT $2,id,1,clock_timestamp()+interval '1 hour' FROM unnest($1::uuid[]) ids(id)")
        .bind(products).bind(cart).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.reservation_allocations(cart_id,product_id,source_id,stock_id,quantity) SELECT cart_id,product_id,$2,$2,quantity FROM inventory.reservations WHERE cart_id=$1")
        .bind(cart).bind(Uuid::from_u128(1)).execute(pool).await.unwrap();
}

async fn state(pool: &PgPool) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_object('carts',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM cart_checkout.carts c),'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY cart_id,product_id) FROM cart_checkout.items i),'reservations',(SELECT jsonb_agg(to_jsonb(r) ORDER BY cart_id,product_id) FROM inventory.reservations r),'allocations',(SELECT jsonb_agg(to_jsonb(a) ORDER BY cart_id,product_id,source_id) FROM inventory.reservation_allocations a),'outbox',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM platform.outbox e))")
        .fetch_one(pool).await.unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn oversized_merge_rejects_before_changing_carts_holds_or_events(pool: PgPool) {
    let f = fixture(&pool, 400).await;
    let guest = f.carts.open(None, "").await.unwrap();
    seed_cart(&pool, f.account, &f.products[..200]).await;
    seed_cart(&pool, guest.cart.id, &f.products[200..]).await;
    let before = state(&pool).await;
    let result = f
        .carts
        .open(Some(f.customer), guest.guest_token.as_deref().unwrap())
        .await;
    assert!(matches!(result, Err(Error::Invalid(message)) if message.contains("at most 200")));
    assert_eq!(state(&pool).await, before);
}

#[sqlx::test(migrations = "../../migrations")]
async fn shared_products_count_once_at_the_cart_limit(pool: PgPool) {
    let f = fixture(&pool, 200).await;
    let guest = f.carts.open(None, "").await.unwrap();
    seed_cart(&pool, f.account, &f.products[..199]).await;
    seed_cart(&pool, guest.cart.id, &f.products[198..]).await;
    let merged = f
        .carts
        .open(Some(f.customer), guest.guest_token.as_deref().unwrap())
        .await
        .unwrap()
        .cart;
    assert_eq!(merged.items.len(), 200);
    assert!(merged.fully_reserved);
    let overlapping = merged
        .items
        .iter()
        .find(|i| i.product_id == f.products[198])
        .unwrap();
    assert_eq!(overlapping.quantity, 2);
    assert_eq!(overlapping.reserved_quantity, 2);
    assert!(!sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM cart_checkout.carts WHERE id=$1)"
    )
    .bind(guest.cart.id)
    .fetch_one(&pool)
    .await
    .unwrap());
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_merges_cannot_both_take_the_last_cart_slot(pool: PgPool) {
    let f = fixture(&pool, 201).await;
    let first = f.carts.open(None, "").await.unwrap();
    let second = f.carts.open(None, "").await.unwrap();
    seed_cart(&pool, f.account, &f.products[..199]).await;
    seed_cart(&pool, first.cart.id, &f.products[199..200]).await;
    seed_cart(&pool, second.cart.id, &f.products[200..]).await;
    let (one, two) = tokio::join!(
        f.carts
            .open(Some(f.customer), first.guest_token.as_deref().unwrap()),
        f.carts
            .open(Some(f.customer), second.guest_token.as_deref().unwrap()),
    );
    assert_ne!(one.is_ok(), two.is_ok());
    let (failed, guest, product) = if one.is_err() {
        (one, first.cart.id, f.products[199])
    } else {
        (two, second.cart.id, f.products[200])
    };
    assert!(matches!(failed, Err(Error::Invalid(message)) if message.contains("at most 200")));
    assert_eq!(
        f.carts
            .read_customer(f.customer)
            .await
            .unwrap()
            .unwrap()
            .items
            .len(),
        200
    );
    assert_eq!(
        sqlx::query_scalar::<_, i32>(
            "SELECT quantity FROM inventory.reservations WHERE cart_id=$1 AND product_id=$2"
        )
        .bind(guest)
        .bind(product)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
}

async fn nondefault_source(pool: &PgPool, f: &Fixture, global: bool, quantity: i32) -> Uuid {
    let source = Uuid::from_u128(2);
    sqlx::query("UPDATE inventory.source_items SET quantity=0 WHERE product_id=$1")
        .bind(f.products[0])
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE inventory.stock SET on_hand=0 WHERE product_id=$1")
        .bind(f.products[0])
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO inventory.inventory_sources(id,code,name) VALUES($1,'secondary','Secondary')",
    )
    .bind(source)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO inventory.stocks(id,code,name,is_global) VALUES($1,'secondary','Secondary',$2)")
        .bind(source).bind(global).execute(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO inventory.source_stock_links(stock_id,source_id,priority) VALUES($1,$1,0)",
    )
    .bind(source)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO inventory.source_items(source_id,product_id,quantity) VALUES($1,$2,$3)",
    )
    .bind(source)
    .bind(f.products[0])
    .bind(quantity)
    .execute(pool)
    .await
    .unwrap();
    if global {
        sqlx::query("UPDATE fulfillment.system_capabilities SET capabilities=$1")
            .bind(json!({"global_delivery_enabled":true}))
            .execute(pool)
            .await
            .unwrap();
    }
    source
}

async fn set(f: &Fixture, customer: Option<Uuid>, guest: &str, quantity: i32) {
    let product = domain_catalog::Service {
        pool: f.carts.pool.clone(),
    }
    .product(f.products[0])
    .await
    .unwrap();
    f.carts
        .set(customer, guest, product, quantity, false)
        .await
        .unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn global_stock_reservations_survive_login_merge(pool: PgPool) {
    let f = fixture(&pool, 1).await;
    let source = nondefault_source(&pool, &f, true, 6).await;
    let guest = f.carts.open(None, "").await.unwrap();
    set(&f, Some(f.customer), "", 2).await;
    set(&f, None, guest.guest_token.as_deref().unwrap(), 2).await;
    let merged = f
        .carts
        .open(Some(f.customer), guest.guest_token.as_deref().unwrap())
        .await
        .unwrap()
        .cart;
    assert!(merged.fully_reserved);
    assert_eq!(merged.items[0].quantity, 4);
    assert_eq!(merged.items[0].reserved_quantity, 4);
    assert_eq!(
        sqlx::query_as::<_, (Uuid, i32)>(
            "SELECT source_id,quantity FROM inventory.reservation_allocations WHERE cart_id=$1"
        )
        .bind(f.account)
        .fetch_one(&pool)
        .await
        .unwrap(),
        (source, 4)
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn partial_global_merge_excludes_other_carts_and_counts_shared_sources_once(pool: PgPool) {
    let f = fixture(&pool, 1).await;
    let source = nondefault_source(&pool, &f, true, 6).await;
    let second_pool = Uuid::from_u128(3);
    sqlx::query("INSERT INTO inventory.stocks(id,code,name,is_global) VALUES($1,'shared','Shared source',true)")
        .bind(second_pool).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO inventory.source_stock_links(stock_id,source_id,priority) VALUES($1,$2,0)",
    )
    .bind(second_pool)
    .bind(source)
    .execute(&pool)
    .await
    .unwrap();
    let guest = f.carts.open(None, "").await.unwrap();
    set(&f, Some(f.customer), "", 2).await;
    set(&f, None, guest.guest_token.as_deref().unwrap(), 2).await;
    sqlx::query("UPDATE inventory.reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE cart_id=$1")
        .bind(guest.cart.id).execute(&pool).await.unwrap();
    let other = f.carts.open(None, "").await.unwrap();
    set(&f, None, other.guest_token.as_deref().unwrap(), 3).await;
    let merged = f
        .carts
        .open(Some(f.customer), guest.guest_token.as_deref().unwrap())
        .await
        .unwrap()
        .cart;
    assert!(!merged.fully_reserved);
    assert_eq!(merged.items[0].quantity, 4);
    assert_eq!(merged.items[0].reserved_quantity, 3);
    assert_eq!(
        sqlx::query_scalar::<_, i32>(
            "SELECT quantity FROM inventory.reservations WHERE cart_id=$1"
        )
        .bind(other.cart.id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        3
    );
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT SUM(quantity)::bigint FROM inventory.reservations WHERE product_id=$1 AND expires_at>clock_timestamp()").bind(f.products[0]).fetch_one(&pool).await.unwrap(), 6);
}

#[sqlx::test(migrations = "../../migrations")]
async fn area_stock_survives_merge_without_default_stock(pool: PgPool) {
    let f = fixture(&pool, 1).await;
    let source = nondefault_source(&pool, &f, false, 3).await;
    let area = Uuid::new_v4();
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km) VALUES($1,'Local delivery',30,31,5)")
        .bind(area).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.area_stock_links(area_id,stock_id) VALUES($1,$2)")
        .bind(area)
        .bind(source)
        .execute(&pool)
        .await
        .unwrap();
    let guest = f.carts.open(None, "").await.unwrap();
    let pin = Some(Pin {
        latitude: 30.,
        longitude: 31.,
    });
    f.carts
        .set_delivery(Some(f.customer), "", pin)
        .await
        .unwrap();
    f.carts
        .set_delivery(None, guest.guest_token.as_deref().unwrap(), pin)
        .await
        .unwrap();
    set(&f, Some(f.customer), "", 1).await;
    set(&f, None, guest.guest_token.as_deref().unwrap(), 2).await;
    let merged = f
        .carts
        .open(Some(f.customer), guest.guest_token.as_deref().unwrap())
        .await
        .unwrap()
        .cart;
    assert!(merged.fully_reserved);
    assert_eq!(merged.items[0].quantity, 3);
    assert_eq!(merged.items[0].reserved_quantity, 3);
}

#[sqlx::test(migrations = "../../migrations")]
async fn invalid_destination_scope_preserves_existing_account_hold(pool: PgPool) {
    let f = fixture(&pool, 1).await;
    let source = nondefault_source(&pool, &f, false, 4).await;
    let area = Uuid::new_v4();
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km) VALUES($1,'Local delivery',30,31,5)")
        .bind(area).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.area_stock_links(area_id,stock_id) VALUES($1,$2)")
        .bind(area)
        .bind(source)
        .execute(&pool)
        .await
        .unwrap();
    let guest = f.carts.open(None, "").await.unwrap();
    let pin = Some(Pin {
        latitude: 30.,
        longitude: 31.,
    });
    f.carts
        .set_delivery(Some(f.customer), "", pin)
        .await
        .unwrap();
    f.carts
        .set_delivery(None, guest.guest_token.as_deref().unwrap(), pin)
        .await
        .unwrap();
    set(&f, Some(f.customer), "", 1).await;
    set(&f, None, guest.guest_token.as_deref().unwrap(), 2).await;
    // Model a topology change: the held source remains, but this cart's pin is
    // no longer covered. A failed allocation must not erase its existing hold.
    sqlx::query(
        "UPDATE cart_checkout.carts SET delivery_latitude=0,delivery_longitude=0 WHERE id=$1",
    )
    .bind(f.account)
    .execute(&pool)
    .await
    .unwrap();
    let merged = f
        .carts
        .open(Some(f.customer), guest.guest_token.as_deref().unwrap())
        .await
        .unwrap()
        .cart;
    assert!(!merged.fully_reserved);
    assert_eq!(merged.items[0].quantity, 3);
    assert_eq!(merged.items[0].reserved_quantity, 1);
    assert_eq!(
        sqlx::query_as::<_, (Uuid, i32)>(
            "SELECT source_id,quantity FROM inventory.reservation_allocations WHERE cart_id=$1"
        )
        .bind(f.account)
        .fetch_one(&pool)
        .await
        .unwrap(),
        (source, 1)
    );
}
