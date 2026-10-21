use domain_cart_checkout::Service as Carts;
use domain_catalog::{CategoryInput, ProductInput, Service as Catalog};
use domain_inventory::Service as Inventory;
use serde_json::json;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;
async fn customer(pool: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash) VALUES($1,$2,'email','test-unused')").bind(id).bind(format!("{id}@example.test")).execute(pool).await.unwrap();
    id
}
async fn setup(pool: PgPool, ttl: i64) -> (Carts, domain_catalog::Product) {
    let catalog = Catalog { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            CategoryInput {
                name: "Fruit".into(),
                slug: "fruit".into(),
                parent_id: None,
            },
        )
        .await
        .unwrap();
    let input:ProductInput=serde_json::from_value(json!({"sku":"BANANA","slug":"banana","name":"Bananas","description":"Test","price":"1.20","currency":"USD","unit":"lb","category_id":category.id,"attributes":{},"media_ids":[],"active":true,"in_stock":true})).unwrap();
    let product = catalog.save_product(None, input).await.unwrap();
    let inventory = Inventory::new(pool.clone(), ttl).unwrap();
    (Carts { pool, inventory }, product)
}
#[sqlx::test(migrations = "../../migrations")]
async fn last_unit_race_release_and_adjustment_protection(pool: PgPool) {
    let (c, p) = setup(pool.clone(), 900).await;
    let actor = Uuid::new_v4();
    c.inventory
        .adjust(p.id, 1, actor, "Initial stock".into())
        .await
        .unwrap();
    let a = c.open(None, "").await.unwrap().guest_token.unwrap();
    let b = c.open(None, "").await.unwrap().guest_token.unwrap();
    let (one, two) = tokio::join!(
        c.set(None, &a, p.clone(), 1, true),
        c.set(None, &b, p.clone(), 1, true)
    );
    assert_ne!(one.is_ok(), two.is_ok());
    let (winner, loser) = if one.is_ok() { (&a, &b) } else { (&b, &a) };
    let stock = c.inventory.stock(p.id).await.unwrap();
    assert_eq!(stock.available, 0);
    assert_eq!(stock.reserved, 1);
    assert!(c
        .inventory
        .adjust(p.id, 0, actor, "Invalid shrink".into())
        .await
        .is_err());
    assert_eq!(c.open(None, loser).await.unwrap().cart.items.len(), 0);
    c.remove(None, winner, p.id).await.unwrap();
    c.set(None, loser, p.clone(), 1, true).await.unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM platform.outbox WHERE event_type='inventory.reserved'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 2);
    let view = c.open(None, loser).await.unwrap().cart;
    assert_eq!(view.subtotal.to_string(), "1.20");
    assert!(view.fully_reserved);
}
#[sqlx::test(migrations = "../../migrations")]
async fn ttl_expiry_preserves_items_and_releases_stock(pool: PgPool) {
    let (c, p) = setup(pool, 1).await;
    c.inventory
        .adjust(p.id, 3, Uuid::new_v4(), "Test".into())
        .await
        .unwrap();
    let customer = customer(&c.pool).await;
    c.open(Some(customer), "").await.unwrap();
    c.set(Some(customer), "", p.clone(), 2, true).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1150)).await;
    assert_eq!(c.inventory.expire().await.unwrap(), 1);
    assert_eq!(c.inventory.stock(p.id).await.unwrap().available, 3);
    let view = c.open(Some(customer), "").await.unwrap().cart;
    assert_eq!(view.items[0].quantity, 2);
    assert_eq!(view.items[0].reserved_quantity, 0);
    assert!(!view.fully_reserved);
    let view = c.set(Some(customer), "", p, 2, false).await.unwrap();
    assert!(view.fully_reserved);
    assert_eq!(view.subtotal.to_string(), "2.40");
}
#[sqlx::test(migrations = "../../migrations")]
async fn merge_once_preserves_holds_and_account_cart(pool: PgPool) {
    let (c, p) = setup(pool, 900).await;
    c.inventory
        .adjust(p.id, 5, Uuid::new_v4(), "Test".into())
        .await
        .unwrap();
    let customer = customer(&c.pool).await;
    c.open(Some(customer), "").await.unwrap();
    c.set(Some(customer), "", p.clone(), 2, true).await.unwrap();
    let guest = c.open(None, "").await.unwrap().guest_token.unwrap();
    c.set(None, &guest, p.clone(), 3, true).await.unwrap();
    let session = c.open(Some(customer), &guest).await.unwrap();
    assert!(session.guest_token.is_none());
    assert_eq!(session.cart.items[0].quantity, 5);
    assert_eq!(session.cart.items[0].reserved_quantity, 5);
    assert_eq!(session.cart.subtotal.to_string(), "6.00");
    let again = c.open(Some(customer), &guest).await.unwrap();
    assert_eq!(again.cart.items[0].quantity, 5);
    assert!(c.open(None, &guest).await.unwrap().cart.items.is_empty());
    assert_eq!(c.inventory.stock(p.id).await.unwrap().reserved, 5);
}
#[sqlx::test(migrations = "../../migrations")]
async fn expired_guest_merge_reports_unreserved_items(pool: PgPool) {
    let (c, p) = setup(pool.clone(), 900).await;
    c.inventory
        .adjust(p.id, 1, Uuid::new_v4(), "Test".into())
        .await
        .unwrap();
    let guest = c.open(None, "").await.unwrap().guest_token.unwrap();
    let first = c.set(None, &guest, p.clone(), 1, true).await.unwrap();
    sqlx::query(
        "UPDATE inventory.reservations SET expires_at=now()-interval '1 second' WHERE cart_id=$1",
    )
    .bind(first.id)
    .execute(&pool)
    .await
    .unwrap();
    let other = c.open(None, "").await.unwrap().guest_token.unwrap();
    c.set(None, &other, p.clone(), 1, true).await.unwrap();
    let merged = c
        .open(Some(customer(&c.pool).await), &guest)
        .await
        .unwrap()
        .cart;
    assert_eq!(merged.items[0].quantity, 1);
    assert_eq!(merged.items[0].reserved_quantity, 0);
    assert!(!merged.fully_reserved);
    assert_eq!(c.inventory.stock(p.id).await.unwrap().reserved, 1);
}
#[sqlx::test(migrations = "../../migrations")]
async fn reserved_stock_commit_is_transactional_and_single_use(pool: PgPool) {
    let (c, p) = setup(pool.clone(), 900).await;
    c.inventory
        .adjust(p.id, 3, Uuid::new_v4(), "Test".into())
        .await
        .unwrap();
    let guest = c.open(None, "").await.unwrap().guest_token.unwrap();
    let cart = c.set(None, &guest, p.clone(), 2, true).await.unwrap();
    let mut tx = domain_inventory::begin(&pool).await.unwrap();
    Inventory::consume_reserved(&mut tx, cart.id, p.id, 2)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(c.inventory.stock(p.id).await.unwrap().on_hand, 3);
    let mut tx = domain_inventory::begin(&pool).await.unwrap();
    Inventory::consume_reserved(&mut tx, cart.id, p.id, 2)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(c.inventory.stock(p.id).await.unwrap().on_hand, 1);
    let mut tx = domain_inventory::begin(&pool).await.unwrap();
    assert!(Inventory::consume_reserved(&mut tx, cart.id, p.id, 2)
        .await
        .is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn http_guest_isolation_and_automatic_login_merge(pool: PgPool) {
    use axum::{body::Body, http::Request, Router};
    use http_body_util::BodyExt;

    let (c, p) = setup(pool.clone(), 900).await;
    c.inventory
        .adjust(p.id, 10, Uuid::new_v4(), "Test".into())
        .await
        .unwrap();
    let security = infra_auth::Security::new(
        "test-cart-secret".repeat(4),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let app = api_gateway::identity::App::new(pool, security, vec!["http://localhost:5173".into()]);
    let router = api_gateway::identity::router(app.clone()).merge(api_gateway::cart::router(app));
    async fn req(
        r: &Router,
        method: &str,
        path: &str,
        body: serde_json::Value,
        cookie: &str,
        token: &str,
    ) -> (u16, serde_json::Value, String) {
        let mut b = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .header("x-commerce-request", "1")
            .header("cookie", cookie);
        if !token.is_empty() {
            b = b.header("authorization", format!("Bearer {token}"));
        }
        let res = r
            .clone()
            .oneshot(b.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = res.status().as_u16();
        let cookie = res
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .collect::<Vec<_>>()
            .join("; ");
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap(), cookie)
    }
    let (_, _, guest) = req(&router, "POST", "/v1/cart", json!({}), "", "").await;
    assert_eq!(
        req(
            &router,
            "POST",
            "/v1/cart/items",
            json!({"product_id":p.id,"quantity":2}),
            &guest,
            ""
        )
        .await
        .0,
        200
    );
    let (_, other, _) = req(&router, "POST", "/v1/cart", json!({}), "", "").await;
    assert!(other["items"].as_array().unwrap().is_empty());
    let body = json!({"identifier":"cart@example.test","password":"Testing password 123!"});
    assert_eq!(
        req(
            &router,
            "POST",
            "/v1/customer/auth/register",
            body.clone(),
            "",
            ""
        )
        .await
        .0,
        201
    );
    let (status, login, cookies) =
        req(&router, "POST", "/v1/customer/auth/login", body, &guest, "").await;
    assert_eq!(status, 200);
    assert!(cookies.contains("guest_cart=;"));
    let token = login["access_token"].as_str().unwrap();
    let (_, view, _) = req(&router, "POST", "/v1/cart", json!({}), "", token).await;
    assert_eq!(view["items"][0]["quantity"], 2);
    assert_eq!(view["subtotal"], "2.40");
    assert_eq!(
        req(&router, "POST", "/v1/cart", json!({}), &guest, "bad-token")
            .await
            .0,
        401
    );
    assert_eq!(
        req(
            &router,
            "PUT",
            &format!("/v1/admin/inventory/{}", p.id),
            json!({"on_hand":0,"reason":"Forbidden"}),
            &guest,
            ""
        )
        .await
        .0,
        401
    );
    assert_eq!(
        req(
            &router,
            "POST",
            "/v1/cart/items",
            json!({"product_id":p.id,"quantity":-1}),
            "",
            token
        )
        .await
        .0,
        400
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn assistant_clear_releases_inventory_and_preserves_other_customers(pool: PgPool) {
    let (c, p) = setup(pool.clone(), 900).await;
    c.inventory
        .adjust(p.id, 10, Uuid::new_v4(), "Test stock".into())
        .await
        .unwrap();
    let owner = customer(&pool).await;
    let other = customer(&pool).await;
    c.open(Some(owner), "").await.unwrap();
    c.open(Some(other), "").await.unwrap();
    c.set(Some(owner), "", p.clone(), 2, true).await.unwrap();
    c.set(Some(other), "", p.clone(), 3, true).await.unwrap();
    let empty = c.clear(owner).await.unwrap();
    assert!(empty.items.is_empty());
    assert_eq!(empty.subtotal.to_string(), "0");
    assert_eq!(c.inventory.stock(p.id).await.unwrap().reserved, 3);
    let other_cart = c.read_customer(other).await.unwrap().unwrap();
    assert_eq!(other_cart.items[0].quantity, 3);
    assert!(c.clear(owner).await.unwrap().items.is_empty());
}

#[sqlx::test(migrations = "../../migrations")]
async fn assistant_remove_amount_preserves_remaining_units(pool: PgPool) {
    let (c, p) = setup(pool.clone(), 900).await;
    c.inventory
        .adjust(p.id, 10, Uuid::new_v4(), "Test stock".into())
        .await
        .unwrap();
    let owner = customer(&pool).await;
    c.open(Some(owner), "").await.unwrap();
    c.set(Some(owner), "", p.clone(), 3, true).await.unwrap();
    let remaining = c
        .remove_amount(Some(owner), "", p.id, Some(1))
        .await
        .unwrap();
    assert_eq!(remaining.items[0].quantity, 2);
    assert_eq!(c.inventory.stock(p.id).await.unwrap().reserved, 2);
    assert!(c
        .remove_amount(Some(owner), "", p.id, Some(3))
        .await
        .is_err());
    assert_eq!(
        c.read_customer(owner).await.unwrap().unwrap().items[0].quantity,
        2
    );
    assert!(c
        .remove_amount(Some(owner), "", p.id, Some(2))
        .await
        .unwrap()
        .items
        .is_empty());
}
