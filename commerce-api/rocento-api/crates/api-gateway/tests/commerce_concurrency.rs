use domain_cart_checkout::Service as Carts;
use domain_catalog::{Product, Service as Catalog};
use domain_inventory::Service as Inventory;
use serde_json::json;
use sqlx::PgPool;
use std::time::Duration;
use uuid::Uuid;

async fn fixture(pool: PgPool) -> (Carts, Product, Product, String, String) {
    let catalog = Catalog { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            serde_json::from_value(json!({
                "name":"Concurrency", "slug":"concurrency", "parent_id":null
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let mut products = Vec::new();
    for sku in ["first", "second"] {
        products.push(
            catalog
                .save_product(
                    None,
                    serde_json::from_value(json!({
                        "sku":sku,"name":sku,"slug":sku,"description":"Fixture",
                        "price":"1.00","currency":"USD","unit":"each","category_id":category.id,
                        "attributes":{},"media_ids":[],"active":true,"in_stock":true
                    }))
                    .unwrap(),
                )
                .await
                .unwrap(),
        );
    }
    let carts = Carts {
        pool: pool.clone(),
        inventory: Inventory::new(pool, 900).unwrap(),
    };
    for product in &products {
        carts
            .inventory
            .adjust(product.id, 1, Uuid::new_v4(), "Fixture".into())
            .await
            .unwrap();
    }
    let a = carts.open(None, "").await.unwrap().guest_token.unwrap();
    let b = carts.open(None, "").await.unwrap().guest_token.unwrap();
    (carts, products.remove(0), products.remove(0), a, b)
}

#[sqlx::test(migrations = "../../migrations")]
async fn independent_cart_mutations_progress_while_another_cart_transaction_is_open(pool: PgPool) {
    let (carts, first, second, a, b) = fixture(pool.clone()).await;
    let mut held = domain_inventory::begin_cart(&pool, None, &a, &[first.id])
        .await
        .unwrap();
    carts
        .set_in(&mut held, None, &a, first, 1, true)
        .await
        .unwrap();
    let other = tokio::time::timeout(Duration::from_secs(1), carts.set(None, &b, second, 1, true))
        .await
        .expect("unrelated product/cart was serialized behind another transaction")
        .unwrap();
    assert!(other.fully_reserved);
    held.commit().await.unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn competing_cart_waits_then_cannot_oversell_the_last_unit(pool: PgPool) {
    let (carts, first, _, a, b) = fixture(pool.clone()).await;
    let mut held = domain_inventory::begin_cart(&pool, None, &a, &[first.id])
        .await
        .unwrap();
    carts
        .set_in(&mut held, None, &a, first.clone(), 1, true)
        .await
        .unwrap();
    let competitor = carts.clone();
    let product = first.clone();
    let mut task = tokio::spawn(async move { competitor.set(None, &b, product, 1, true).await });
    assert!(tokio::time::timeout(Duration::from_millis(100), &mut task)
        .await
        .is_err());
    held.commit().await.unwrap();
    assert!(task.await.unwrap().is_err());
    let stock = carts.inventory.stock(first.id).await.unwrap();
    assert_eq!(stock.reserved, 1);
    assert_eq!(stock.available, 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn maintenance_still_excludes_scoped_mutations_and_resumes_after_commit(pool: PgPool) {
    let (_, first, _, a, _) = fixture(pool.clone()).await;
    let held = domain_inventory::begin_cart(&pool, None, &a, &[first.id])
        .await
        .unwrap();
    let other_pool = pool.clone();
    let mut maintenance = tokio::spawn(async move {
        let tx = domain_inventory::begin(&other_pool).await.unwrap();
        tx.commit().await.unwrap();
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut maintenance)
            .await
            .is_err()
    );
    held.commit().await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), maintenance)
        .await
        .unwrap()
        .unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn stalled_product_lock_times_out_without_changing_stock(pool: PgPool) {
    let (carts, first, _, a, b) = fixture(pool.clone()).await;
    let held = domain_inventory::begin_cart(&pool, None, &a, &[first.id])
        .await
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(4),
        carts.set(None, &b, first.clone(), 1, true),
    )
    .await
    .expect("lock wait must be bounded");
    assert!(
        matches!(result, Err(infra_auth::Error::Database(sqlx::Error::Database(ref e))) if e.code().as_deref()==Some("55P03"))
    );
    held.rollback().await.unwrap();
    assert_eq!(carts.inventory.stock(first.id).await.unwrap().reserved, 0);
    assert!(
        carts
            .set(None, &b, first, 1, true)
            .await
            .unwrap()
            .fully_reserved
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn wishlist_transfer_rechecks_membership_after_concurrent_removal(pool: PgPool) {
    let (carts, first, _, _, _) = fixture(pool.clone()).await;
    let customer = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash) VALUES($1,$2,'email','test-unused')")
        .bind(customer).bind(format!("{customer}@example.test")).execute(&pool).await.unwrap();
    carts.open(Some(customer), "").await.unwrap();
    let wishlist = domain_reviews::Service { pool: pool.clone() };
    wishlist.wish(customer, first.id, true).await.unwrap();
    let mut removal = pool.begin().await.unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *removal)
        .await
        .unwrap();
    wishlist
        .wish_in(&mut removal, customer, first.id, false)
        .await
        .unwrap();
    let task_carts = carts.clone();
    let request = Uuid::new_v4();
    let transfer = tokio::spawn(async move {
        task_carts
            .transfer_wishlist_to_cart(customer, request, vec![first.id])
            .await
    });
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)))")
                .bind(blocker).fetch_one(&pool).await.unwrap();
            if blocked { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("transfer must coordinate with the live wishlist mutation");
    removal.commit().await.unwrap();
    assert!(
        matches!(transfer.await.unwrap(), Err(infra_auth::Error::Invalid(message)) if message.contains("still be in"))
    );
    assert!(carts
        .open(Some(customer), "")
        .await
        .unwrap()
        .cart
        .items
        .is_empty());
    let receipts: i64 = sqlx::query_scalar("SELECT count(*) FROM cart_checkout.assistant_wishlist_transfers WHERE customer_id=$1 AND request_id=$2")
        .bind(customer).bind(request).fetch_one(&pool).await.unwrap();
    assert_eq!(receipts, 0);
}
