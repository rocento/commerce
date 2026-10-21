use domain_inventory::{begin, msi::*, Service};
use sqlx::PgPool;
use uuid::Uuid;
async fn cart(pool: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO cart_checkout.carts(id,guest_hash) VALUES($1,$2)")
        .bind(id)
        .bind(id.to_string())
        .execute(pool)
        .await
        .unwrap();
    id
}
async fn setup(pool: &PgPool) -> (Service, Uuid, Uuid) {
    let service = Service::new(pool.clone(), 900).unwrap();
    let source = service
        .save_source(
            None,
            SourceInput {
                code: "warehouse-b".into(),
                name: "Warehouse B".into(),
                is_enabled: true,
                address: "Test".into(),
                latitude: Some(30.0),
                longitude: Some(31.0),
                contact_name: "".into(),
                contact_phone: "".into(),
                priority: 1,
            },
            Uuid::nil(),
        )
        .await
        .unwrap();
    service
        .save_stock(
            Some(DEFAULT_SOURCE),
            StockInput {
                code: "default".into(),
                name: "Default stock".into(),
                is_default: true,
                is_global: false,
                sources: vec![
                    SourceLink {
                        source_id: source.id,
                        priority: 20,
                    },
                    SourceLink {
                        source_id: DEFAULT_SOURCE,
                        priority: 10,
                    },
                ],
            },
            Uuid::nil(),
        )
        .await
        .unwrap();
    let product = Uuid::new_v4();
    for (source_id, quantity) in [(DEFAULT_SOURCE, 5), (source.id, 20)] {
        service
            .adjust_source(
                product,
                SourceItemInput {
                    source_id,
                    quantity,
                    status: "in_stock".into(),
                    notify_stock_qty: 0,
                    reason: "Received stock".into(),
                },
                Uuid::nil(),
            )
            .await
            .unwrap();
    }
    (service, product, source.id)
}
#[sqlx::test(migrations = "../../migrations")]
async fn priority_split_reallocation_release_and_consume(pool: PgPool) {
    let (service, product, b) = setup(&pool).await;
    let cart = cart(&pool).await;
    let mut tx = begin(&pool).await.unwrap();
    service.reserve(&mut tx, cart, product, 8).await.unwrap();
    tx.commit().await.unwrap();
    let rows:Vec<(Uuid,i32)>=sqlx::query_as("SELECT source_id,quantity FROM inventory.reservation_allocations WHERE cart_id=$1 ORDER BY source_id").bind(cart).fetch_all(&pool).await.unwrap();
    assert_eq!(rows, vec![(DEFAULT_SOURCE, 5), (b, 3)]);
    assert_eq!(service.stock(product).await.unwrap().available, 17);
    assert!(service
        .adjust_source(
            product,
            SourceItemInput {
                source_id: DEFAULT_SOURCE,
                quantity: 4,
                status: "in_stock".into(),
                notify_stock_qty: 0,
                reason: "Shrink".into()
            },
            Uuid::nil()
        )
        .await
        .is_err());
    assert!(service
        .adjust_source(
            product,
            SourceItemInput {
                source_id: b,
                quantity: 20,
                status: "out_of_stock".into(),
                notify_stock_qty: 0,
                reason: "Disable".into()
            },
            Uuid::nil()
        )
        .await
        .is_err());
    let mut tx = begin(&pool).await.unwrap();
    service.reserve(&mut tx, cart, product, 4).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        service
            .source_items(product)
            .await
            .unwrap()
            .iter()
            .find(|i| i.source_id == b)
            .unwrap()
            .reserved,
        0
    );
    let mut tx = begin(&pool).await.unwrap();
    let split = Service::consume_reserved(&mut tx, cart, product, 4)
        .await
        .unwrap();
    assert_eq!(split.len(), 1);
    tx.rollback().await.unwrap();
    assert_eq!(service.stock(product).await.unwrap().on_hand, 25);
    let mut tx = begin(&pool).await.unwrap();
    Service::consume_reserved(&mut tx, cart, product, 4)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(service.stock(product).await.unwrap().on_hand, 21);
    let mut tx = begin(&pool).await.unwrap();
    assert!(Service::consume_reserved(&mut tx, cart, product, 4)
        .await
        .is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_holds_do_not_oversell_and_expiry_cascades(pool: PgPool) {
    let (service, product, _) = setup(&pool).await;
    let a = cart(&pool).await;
    let b = cart(&pool).await;
    let hold = |cart| {
        let service = service.clone();
        async move {
            let mut tx = begin(&service.pool).await?;
            service.reserve(&mut tx, cart, product, 20).await?;
            tx.commit().await?;
            Ok::<_, infra_auth::Error>(())
        }
    };
    let (one, two) = tokio::join!(hold(a), hold(b));
    assert_ne!(one.is_ok(), two.is_ok());
    assert_eq!(service.stock(product).await.unwrap().reserved, 20);
    sqlx::query("UPDATE inventory.reservations SET expires_at=now()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(service.expire().await.unwrap(), 1);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM inventory.reservation_allocations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(service.stock(product).await.unwrap().available, 25);
}
#[sqlx::test(migrations = "../../migrations")]
async fn unavailable_sources_and_configuration_guards(pool: PgPool) {
    let (service, product, b) = setup(&pool).await;
    service
        .save_source(
            Some(b),
            SourceInput {
                code: "warehouse-b".into(),
                name: "Warehouse B".into(),
                is_enabled: false,
                address: "".into(),
                latitude: None,
                longitude: None,
                contact_name: "".into(),
                contact_phone: "".into(),
                priority: 1,
            },
            Uuid::nil(),
        )
        .await
        .unwrap();
    assert_eq!(service.stock(product).await.unwrap().available, 5);
    let cart = cart(&pool).await;
    let mut tx = begin(&pool).await.unwrap();
    assert!(service.reserve(&mut tx, cart, product, 6).await.is_err());
    tx.rollback().await.unwrap();
    let mut tx = begin(&pool).await.unwrap();
    service.reserve(&mut tx, cart, product, 5).await.unwrap();
    tx.commit().await.unwrap();
    assert!(service
        .save_stock(
            Some(DEFAULT_SOURCE),
            StockInput {
                code: "default".into(),
                name: "Default".into(),
                is_default: true,
                is_global: false,
                sources: vec![SourceLink {
                    source_id: b,
                    priority: 0
                }]
            },
            Uuid::nil()
        )
        .await
        .is_err());
    assert!(service.delete_source(b, Uuid::nil()).await.is_err());
    assert!(service
        .delete_stock(DEFAULT_SOURCE, Uuid::nil())
        .await
        .is_err());
}

#[sqlx::test(migrations = false)]
async fn legacy_stock_reservations_and_shipments_migrate_without_loss(pool: PgPool) {
    let migrations = sqlx::migrate!("../../migrations");
    for migration in migrations.iter().filter(|m| m.version < 20260914120000) {
        sqlx::raw_sql(&migration.sql).execute(&pool).await.unwrap();
    }
    let product = Uuid::new_v4();
    let cart = cart(&pool).await;
    sqlx::query("INSERT INTO inventory.stock(product_id,on_hand) VALUES($1,8)")
        .bind(product)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO inventory.reservations(cart_id,product_id,quantity,expires_at) VALUES($1,$2,3,now()+interval '15 minutes')").bind(cart).bind(product).execute(&pool).await.unwrap();
    let placed = Uuid::new_v4();
    let shipped = Uuid::new_v4();
    let shipment = Uuid::new_v4();
    for (order, status) in [(placed, "placed"), (shipped, "shipped")] {
        sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency) VALUES($1,$2,$3,$4,$5,'{}','{}',2,3,5,'USD')").bind(order).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(status).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO orders.order_items(order_id,product_id,sku,name,unit,quantity,price,line_total) VALUES($1,$2,'LEGACY','Saved name','each',2,1,2)").bind(order).bind(product).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO fulfillment.shipments(id,order_id,tracking_reference,status,dispatched_by) VALUES($1,$2,'LEGACY-REF','shipped',$3)").bind(shipment).bind(shipped).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO fulfillment.shipment_items(shipment_id,product_id,quantity) VALUES($1,$2,2)",
    )
    .bind(shipment)
    .bind(product)
    .execute(&pool)
    .await
    .unwrap();
    for migration in migrations.iter().filter(|m| m.version >= 20260914120000) {
        sqlx::raw_sql(&migration.sql).execute(&pool).await.unwrap();
    }
    let service = Service::new(pool.clone(), 900).unwrap();
    let stock = service.stock(product).await.unwrap();
    assert_eq!((stock.on_hand, stock.reserved, stock.available), (8, 3, 5));
    let allocation: (Uuid, i32) = sqlx::query_as(
        "SELECT source_id,quantity FROM inventory.reservation_allocations WHERE cart_id=$1",
    )
    .bind(cart)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(allocation, (DEFAULT_SOURCE, 3));
    let old: (Uuid, String, String) = sqlx::query_as(
        "SELECT id,tracking_reference,status FROM fulfillment.shipments WHERE order_id=$1",
    )
    .bind(shipped)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(old, (shipment, "LEGACY-REF".into(), "shipped".into()));
    let pending:(String,i32)=sqlx::query_as("SELECT s.status,i.quantity FROM fulfillment.shipments s JOIN fulfillment.shipment_items i ON i.shipment_id=s.id WHERE order_id=$1").bind(placed).fetch_one(&pool).await.unwrap();
    assert_eq!(pending, ("pending".into(), 2));
    let mut tx = begin(&pool).await.unwrap();
    Service::consume_reserved(&mut tx, cart, product, 3)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(service.stock(product).await.unwrap().on_hand, 5);
}

#[sqlx::test(migrations = "../../migrations")]
async fn global_browsing_deduplicates_sources_and_respects_live_holds(pool: PgPool) {
    let (service, product, source) = setup(&pool).await;
    for code in ["global", "global-shared"] {
        service
            .save_stock(
                None,
                StockInput {
                    code: code.into(),
                    name: code.into(),
                    is_default: false,
                    is_global: true,
                    sources: vec![SourceLink {
                        source_id: source,
                        priority: 0,
                    }],
                },
                Uuid::nil(),
            )
            .await
            .unwrap();
    }
    assert_eq!(
        service
            .stocks()
            .await
            .unwrap()
            .iter()
            .filter(|s| s.is_global)
            .count(),
        2
    );
    let global = service.browsing_stocks(None, false).await.unwrap();
    let default_and_global = service.browsing_stocks(None, true).await.unwrap();
    assert_eq!(
        service
            .browsing_available_many(&[product], &global, None)
            .await
            .unwrap()[&product],
        20
    );
    assert_eq!(
        service
            .browsing_available_many(&[product], &default_and_global, None)
            .await
            .unwrap()[&product],
        25
    );
    let cart = cart(&pool).await;
    let mut tx = begin(&pool).await.unwrap();
    service.reserve(&mut tx, cart, product, 8).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        service
            .browsing_available_many(&[product], &global, None)
            .await
            .unwrap()[&product],
        17
    );
    sqlx::query(
        "UPDATE inventory.reservations SET expires_at=now()-interval '1 second' WHERE cart_id=$1",
    )
    .bind(cart)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        service
            .browsing_available_many(&[product], &global, None)
            .await
            .unwrap()[&product],
        20
    );
    sqlx::query("UPDATE inventory.source_items SET status='out_of_stock' WHERE source_id=$1")
        .bind(source)
        .execute(&pool)
        .await
        .unwrap();
    assert!(service
        .browsing_available_many(&[product], &global, None)
        .await
        .unwrap()
        .is_empty());
    sqlx::query(
        "UPDATE inventory.source_items SET status='in_stock',quantity=0 WHERE source_id=$1",
    )
    .bind(source)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        service
            .browsing_available_many(&[product], &global, None)
            .await
            .unwrap()[&product],
        0
    );
    sqlx::query("UPDATE inventory.source_items SET quantity=20 WHERE source_id=$1")
        .bind(source)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE inventory.inventory_sources SET is_enabled=false WHERE id=$1")
        .bind(source)
        .execute(&pool)
        .await
        .unwrap();
    assert!(service
        .browsing_available_many(&[product], &global, None)
        .await
        .unwrap()
        .is_empty());
}
