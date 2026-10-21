mod support;
use api_gateway::identity::App;
use axum::{body::Body, http::Request, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;

use uuid::Uuid;
struct Fixture {
    app: App,
    customer: Uuid,
    location: Uuid,
    product: domain_catalog::Product,
    token: String,
    admin: domain_admin_iam::Identity,
}
async fn setup(pool: PgPool) -> Fixture {
    let security = infra_auth::Security::new(
        "test-secret-at-least-32-characters-long".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let app = App::new(pool.clone(), security, vec!["http://localhost:5173".into()]);
    let credentials = || domain_customers::Credentials {
        identifier: "orders@example.test".into(),
        password: "Order test password!".into(),
    };
    let c = app.customers.register(credentials()).await.unwrap();
    sqlx::query("UPDATE customers.customers SET verified=true WHERE id=$1")
        .bind(c.id)
        .execute(&pool)
        .await
        .unwrap();
    let token = app
        .customers
        .login(credentials())
        .await
        .unwrap()
        .body
        .access_token;
    let l=app.customers.save_location(c.id,None,serde_json::from_value(json!({"label":"home","latitude":30.0,"longitude":31.0,"formatted_address":"Test address"})).unwrap()).await.unwrap();
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            serde_json::from_value(json!({"name":"Fruit","slug":"fruit","parent_id":null}))
                .unwrap(),
        )
        .await
        .unwrap();
    let p=catalog.save_product(None,serde_json::from_value(json!({"sku":"TEST","name":"Bananas","slug":"bananas","description":"Test","price":"1.20","currency":"USD","unit":"lb","category_id":category.id,"attributes":{},"media_ids":[],"active":true,"in_stock":true})).unwrap()).await.unwrap();
    let actor = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'admin@example.test','Admin','unused',$2)").bind(actor).bind(domain_admin_iam::SUPER).execute(&pool).await.unwrap();
    let user = sqlx::query_as(
        "SELECT id,entity_id,email,name,role_id,active,created_at FROM admin_iam.admin_users WHERE id=$1",
    )
    .bind(actor)
    .fetch_one(&pool)
    .await
    .unwrap();
    let admin = domain_admin_iam::Identity {
        user,
        permissions: vec!["*".into()],
    };
    app.cart
        .inventory
        .adjust(p.id, 10, actor, "Test stock".into())
        .await
        .unwrap();
    app.cart.open(Some(c.id), "").await.unwrap();
    app.cart
        .set(Some(c.id), "", p.clone(), 2, true)
        .await
        .unwrap();
    Fixture {
        app,
        customer: c.id,
        location: l.id,
        product: p,
        token,
        admin,
    }
}
async fn count(pool: &PgPool, table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
        .fetch_one(pool)
        .await
        .unwrap()
}
#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_idempotent_checkout_is_atomic(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let key = Uuid::new_v4();
    let (a, b) = tokio::join!(
        f.app.cart.place(f.customer, q.id, key),
        f.app.cart.place(f.customer, q.id, key)
    );
    let a = a.unwrap();
    assert_eq!(a.order.id, b.unwrap().order.id);
    assert_eq!(a.order.total.to_string(), "5.40");
    assert_eq!(a.payment.amount_due, a.order.total);
    assert!(a.payment.collected_at.is_none());
    assert_eq!(count(&pool, "orders.orders").await, 1);
    assert_eq!(count(&pool, "payments.payment_transactions").await, 1);
    assert_eq!(
        f.app
            .cart
            .inventory
            .stock(f.product.id)
            .await
            .unwrap()
            .on_hand,
        8
    );
    assert!(f
        .app
        .cart
        .open(Some(f.customer), "")
        .await
        .unwrap()
        .cart
        .items
        .is_empty());
    assert!(f
        .app
        .cart
        .place(f.customer, Uuid::new_v4(), key)
        .await
        .is_err());
    assert!(f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .is_err());
    let contract: Value = serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &json!(a),
        &contract["components"]["schemas"]["OrderDetail"],
        &contract,
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM platform.outbox WHERE event_type='order.placed'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn stale_review_and_expiry_cannot_place(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    sqlx::query("UPDATE catalog.products SET price=2.00 WHERE id=$1")
        .bind(f.product.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .is_err());
    assert_eq!(count(&pool, "orders.orders").await, 0);
    assert_eq!(
        f.app
            .cart
            .inventory
            .stock(f.product.id)
            .await
            .unwrap()
            .on_hand,
        10
    );
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    assert_eq!(q.snapshot.total.to_string(), "7.00");
    sqlx::query(
        "UPDATE inventory.reservations SET expires_at=clock_timestamp()-interval '1 second'",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert!(f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .is_err());
    assert_eq!(count(&pool, "payments.payment_transactions").await, 0);
    f.app
        .cart
        .set(Some(f.customer), "", f.product.clone(), 2, false)
        .await
        .unwrap();
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    sqlx::query("UPDATE cart_checkout.quotes SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn payment_failure_rolls_back_order_stock_cart_and_events(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    sqlx::query(
        "ALTER TABLE payments.payment_transactions ADD CONSTRAINT test_failure CHECK(amount_due<0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert!(f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .is_err());
    assert_eq!(count(&pool, "orders.orders").await, 0);
    assert_eq!(count(&pool, "orders.order_items").await, 0);
    let cart = f.app.cart.open(Some(f.customer), "").await.unwrap().cart;
    assert_eq!(cart.items[0].quantity, 2);
    assert!(cart.fully_reserved);
    assert_eq!(
        f.app
            .cart
            .inventory
            .stock(f.product.id)
            .await
            .unwrap()
            .on_hand,
        10
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM platform.outbox WHERE event_type='order.placed'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn cod_lifecycle_permissions_audit_and_refund(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let d = f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .unwrap();
    let id = d.order.id;
    let orders = domain_orders::Service { pool: pool.clone() };
    assert!(orders
        .transition(id, &f.admin, "cash_collected", "Too early")
        .await
        .is_err());
    let mut admin = f.admin;
    admin.permissions = vec!["orders.read".into()];
    assert!(orders
        .transition(id, &admin, "confirmed", "Forbidden")
        .await
        .is_err());
    admin.permissions = vec!["orders.write".into()];
    for s in ["confirmed", "fulfilling", "shipped", "delivered"] {
        if s == "shipped" {
            admin.permissions.push("fulfillment.dispatch".into());
            orders
                .dispatch(id, &admin, "M5-TEST", "Dispatch")
                .await
                .unwrap();
            continue;
        }
        orders
            .transition(id, &admin, s, "Test transition")
            .await
            .unwrap();
    }
    assert!(orders
        .transition(id, &admin, "cash_collected", "No permission")
        .await
        .is_err());
    admin.permissions = vec!["payments.collect".into()];
    let d = orders
        .transition(id, &admin, "cash_collected", "Received full cash")
        .await
        .unwrap();
    assert_eq!(d.payment.collected_by, Some(admin.user.id));
    assert!(orders
        .transition(id, &admin, "cash_collected", "Duplicate")
        .await
        .is_err());
    assert!(orders.refund(id, &admin, "No permission").await.is_err());
    admin.permissions = vec!["payments.refund".into()];
    let d = orders
        .refund(id, &admin, "Cash returned manually")
        .await
        .unwrap();
    assert_eq!(d.refunds[0].amount, d.order.total);
    assert!(orders.refund(id, &admin, "Duplicate").await.is_err());
    assert_eq!(count(&pool, "admin_iam.audit_log").await, 6);
    assert_eq!(
        f.app
            .cart
            .inventory
            .stock(f.product.id)
            .await
            .unwrap()
            .on_hand,
        8
    );
    sqlx::query("UPDATE customers.customer_locations SET formatted_address='Changed' WHERE id=$1")
        .bind(f.location)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        orders
            .detail(id, Some(f.customer))
            .await
            .unwrap()
            .order
            .location["formatted_address"],
        "Test address"
    );
    assert!(orders.detail(id, Some(Uuid::new_v4())).await.is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn cancellation_restocks_once_but_failed_delivery_does_not(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let orders = domain_orders::Service { pool: pool.clone() };
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let d = f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .unwrap();
    orders
        .transition(d.order.id, &f.admin, "cancelled", "Before dispatch")
        .await
        .unwrap();
    assert!(orders
        .transition(d.order.id, &f.admin, "cancelled", "Again")
        .await
        .is_err());
    assert_eq!(
        f.app
            .cart
            .inventory
            .stock(f.product.id)
            .await
            .unwrap()
            .on_hand,
        10
    );
    f.app
        .cart
        .set(Some(f.customer), "", f.product.clone(), 2, true)
        .await
        .unwrap();
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let d = f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .unwrap();
    for s in ["confirmed", "fulfilling", "shipped", "delivery_failed"] {
        if s == "shipped" {
            orders
                .dispatch(d.order.id, &f.admin, "M5-FAILED", "Dispatch")
                .await
                .unwrap();
            continue;
        }
        orders
            .transition(d.order.id, &f.admin, s, "Test")
            .await
            .unwrap();
    }
    assert_eq!(
        f.app
            .cart
            .inventory
            .stock(f.product.id)
            .await
            .unwrap()
            .on_hand,
        8
    );
    assert!(orders
        .transition(d.order.id, &f.admin, "cancelled", "Too late")
        .await
        .is_err());
}
async fn request(r: &Router, path: &str, body: Value, token: &str) -> u16 {
    let mut b = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .header("x-commerce-request", "1");
    if !token.is_empty() {
        b = b.header("authorization", format!("Bearer {token}"));
    }
    let response = r
        .clone()
        .oneshot(b.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    let _ = response.into_body().collect().await.unwrap();
    status
}
#[sqlx::test(migrations = "../../migrations")]
async fn http_checkout_auth_verification_and_location_ownership(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let r = api_gateway::orders::router(f.app.clone());
    let body = json!({"quote_id":Uuid::new_v4(),"idempotency_key":Uuid::new_v4()});
    assert_eq!(
        request(&r, "/v1/customer/checkout/place", body.clone(), "").await,
        401
    );
    assert_eq!(
        request(&r, "/v1/customer/checkout/place", body.clone(), "invalid").await,
        401
    );
    assert_eq!(
        request(
            &r,
            "/v1/customer/checkout/quote",
            json!({"location_id":Uuid::new_v4()}),
            &f.token
        )
        .await,
        404
    );
    sqlx::query("UPDATE customers.customers SET verified=false WHERE id=$1")
        .bind(f.customer)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(&r, "/v1/customer/checkout/place", body, &f.token).await,
        403
    );
    assert!(f.app.cart.quote(f.customer, f.location).await.is_err());
    assert_eq!(count(&pool, "orders.orders").await, 0);
}

fn tax_input(rate: i32, priority: i32) -> domain_tax::RuleInput {
    serde_json::from_value(json!({"name":"Synthetic zone","min_lat":29.0,"max_lat":31.0,"min_lon":30.0,"max_lon":32.0,"rate_bps":rate,"priority":priority,"tax_delivery":false,"active":true})).unwrap()
}
#[sqlx::test(migrations = "../../migrations")]
async fn m5_tax_fee_snapshots_and_location_rates(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let taxes = domain_tax::Service { pool: pool.clone() };
    let fees = domain_fulfillment::Service { pool: pool.clone() };
    let r = taxes
        .save(None, tax_input(1400, 1), &f.admin)
        .await
        .unwrap();
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    assert_eq!(q.snapshot.tax_amount.to_string(), "0.34");
    assert_eq!(q.snapshot.total.to_string(), "5.74");
    let old = f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .unwrap();
    f.app
        .cart
        .set(Some(f.customer), "", f.product.clone(), 2, true)
        .await
        .unwrap();
    let stale = f.app.cart.quote(f.customer, f.location).await.unwrap();
    fees.set_fee("4.00", "New fee", &f.admin).await.unwrap();
    assert!(f
        .app
        .cart
        .place(f.customer, stale.id, Uuid::new_v4())
        .await
        .is_err());
    let stale = f.app.cart.quote(f.customer, f.location).await.unwrap();
    taxes
        .save(Some(r.id), tax_input(2000, 1), &f.admin)
        .await
        .unwrap();
    assert!(f
        .app
        .cart
        .place(f.customer, stale.id, Uuid::new_v4())
        .await
        .is_err());
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let new = f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .unwrap();
    assert_eq!(new.order.total.to_string(), "6.88");
    assert_eq!(new.payment.amount_due.to_string(), "6.88");
    let original = domain_orders::Service { pool: pool.clone() }
        .detail(old.order.id, Some(f.customer))
        .await
        .unwrap();
    assert_eq!(original.order.total.to_string(), "5.74");
    assert_eq!(original.order.delivery_fee.to_string(), "3.00");
    assert_eq!(original.order.tax_snapshot["rate_bps"], 1400);
    let work=f.app.customers.save_location(f.customer,None,serde_json::from_value(json!({"label":"work","latitude":40.0,"longitude":40.0,"formatted_address":"Outside tax zone","is_default":true})).unwrap()).await.unwrap();
    f.app
        .cart
        .set(Some(f.customer), "", f.product.clone(), 1, true)
        .await
        .unwrap();
    let q = f.app.cart.quote(f.customer, work.id).await.unwrap();
    assert_eq!(q.snapshot.tax_amount.to_string(), "0.00");
    assert_eq!(q.snapshot.delivery_fee.to_string(), "4.00");
    let contract: Value = serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &json!(q),
        &contract["components"]["schemas"]["CheckoutQuote"],
        &contract,
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn m5_tax_priority_rounding_and_validation(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let taxes = domain_tax::Service { pool: pool.clone() };
    taxes
        .save(None, tax_input(1000, 1), &f.admin)
        .await
        .unwrap();
    let mut input = tax_input(1250, 2);
    input.tax_delivery = true;
    let rule = taxes.save(None, input, &f.admin).await.unwrap();
    let mut tx = domain_inventory::begin(&pool).await.unwrap();
    let a = domain_tax::Service::assess(
        &mut tx,
        29.0,
        30.0,
        "0.03".parse().unwrap(),
        "0.01".parse().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(a.amount.to_string(), "0.01");
    assert_eq!(a.rule_id, Some(rule.id));
    let b = domain_tax::Service::assess(
        &mut tx,
        28.99,
        30.0,
        "1.00".parse().unwrap(),
        "3.00".parse().unwrap(),
    )
    .await
    .unwrap();
    assert!(b.rule_id.is_none());
    tx.commit().await.unwrap();
    let mut bad = tax_input(10001, 3);
    assert!(taxes.save(None, bad, &f.admin).await.is_err());
    bad = tax_input(1000, 3);
    bad.min_lon = 50.0;
    bad.max_lon = 20.0;
    assert!(taxes.save(None, bad, &f.admin).await.is_err());
    assert!(taxes
        .save(None, tax_input(1000, 2), &f.admin)
        .await
        .is_err());
    let fees = domain_fulfillment::Service { pool: pool.clone() };
    assert!(fees.set_fee("1.001", "Invalid", &f.admin).await.is_err());
    assert!(fees.set_fee("-1", "Invalid", &f.admin).await.is_err());
    let mut admin = f.admin;
    admin.permissions = vec!["tax.read".into(), "fulfillment.settings.read".into()];
    assert!(taxes.save(None, tax_input(1000, 3), &admin).await.is_err());
    assert!(fees.set_fee("4.00", "Forbidden", &admin).await.is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn m5_dispatch_atomic_idempotent_and_separate_from_cash(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let orders = domain_orders::Service { pool: pool.clone() };
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let d = f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .unwrap();
    let id = d.order.id;
    assert!(orders
        .dispatch(id, &f.admin, "REF-1", "Too early")
        .await
        .is_err());
    orders
        .transition(id, &f.admin, "confirmed", "Accepted")
        .await
        .unwrap();
    orders
        .transition(id, &f.admin, "fulfilling", "Packed")
        .await
        .unwrap();
    assert!(orders
        .transition(id, &f.admin, "shipped", "Bypass")
        .await
        .is_err());
    let (a, b) = tokio::join!(
        orders.dispatch(id, &f.admin, "REF-1", "Dispatched"),
        orders.dispatch(id, &f.admin, "REF-1", "Dispatched")
    );
    let a = a.unwrap();
    assert_eq!(
        a.dispatch.as_ref().unwrap().shipment.id,
        b.unwrap().dispatch.unwrap().shipment.id
    );
    assert_eq!(count(&pool, "fulfillment.shipments").await, 1);
    assert_eq!(count(&pool, "fulfillment.shipment_items").await, 1);
    assert_eq!(a.dispatch.as_ref().unwrap().items[0].quantity, 2);
    assert_eq!(a.order.status, "shipped");
    assert!(a.payment.collected_at.is_none());
    assert!(orders
        .dispatch(id, &f.admin, "OTHER", "Duplicate")
        .await
        .is_err());
    let d = orders
        .transition(id, &f.admin, "delivered", "Delivered")
        .await
        .unwrap();
    assert_eq!(d.dispatch.unwrap().shipment.status, "delivered");
    assert!(d.payment.collected_at.is_none());
    let d = orders
        .transition(id, &f.admin, "cash_collected", "Received cash")
        .await
        .unwrap();
    assert_eq!(d.dispatch.as_ref().unwrap().shipment.status, "delivered");
    let contract: Value = serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &json!(d),
        &contract["components"]["schemas"]["OrderDetail"],
        &contract,
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM platform.outbox WHERE event_type='order.shipped'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn m5_failed_dispatch_does_not_advance_order(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let orders = domain_orders::Service { pool: pool.clone() };
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let d = f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .unwrap();
    let id = d.order.id;
    orders
        .transition(id, &f.admin, "confirmed", "Accepted")
        .await
        .unwrap();
    orders
        .transition(id, &f.admin, "fulfilling", "Packed")
        .await
        .unwrap();
    let mut admin = f.admin;
    admin.permissions = vec!["orders.write".into()];
    assert!(orders
        .dispatch(id, &admin, "REF", "Forbidden")
        .await
        .is_err());
    admin.permissions = vec!["fulfillment.dispatch".into()];
    sqlx::query(
        "ALTER TABLE fulfillment.shipments ADD CONSTRAINT forced_failure CHECK(status<>'shipped')",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert!(orders
        .dispatch(id, &admin, "REF", "Rollback")
        .await
        .is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM fulfillment.shipments WHERE status='shipped'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        orders.detail(id, None).await.unwrap().order.status,
        "fulfilling"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM platform.outbox WHERE event_type='order.shipped'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
}

fn promotion(
    scope: &str,
    kind: &str,
    value: &str,
    code: Option<&str>,
) -> domain_pricing_promotions::RuleInput {
    serde_json::from_value(json!({"name":"Test offer","scope":scope,"kind":kind,"value":value,"coupon_code":code,"min_subtotal":"0","skus":[],"category_ids":[],"customer_group":"all","priority":10,"active":true,"starts_at":null,"ends_at":null})).unwrap()
}
#[sqlx::test(migrations = "../../migrations")]
async fn m6_coupon_minimum_snapshot_tax_and_deletion(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let svc = domain_pricing_promotions::Service { pool: pool.clone() };
    let mut input = promotion("cart", "percentage", "10", Some("save10"));
    input.min_subtotal = "3".parse().unwrap();
    let r = svc.save(None, input, &f.admin).await.unwrap();
    assert_eq!(r.coupon_code.as_deref(), Some("SAVE10"));
    let e = f
        .app
        .cart
        .coupon(Some(f.customer), "", "SAVE10")
        .await
        .err()
        .unwrap();
    assert!(e.to_string().contains("Minimum cart value"));
    assert!(f
        .app
        .cart
        .open(Some(f.customer), "")
        .await
        .unwrap()
        .cart
        .coupon_code
        .is_none());
    f.app
        .cart
        .set(Some(f.customer), "", f.product.clone(), 3, false)
        .await
        .unwrap();
    let cart = f
        .app
        .cart
        .coupon(Some(f.customer), "", " save10 ")
        .await
        .unwrap();
    assert_eq!(cart.discount_amount.to_string(), "0.36");
    let tax = domain_tax::Service { pool: pool.clone() };
    tax.save(None,serde_json::from_value(json!({"name":"Tax","min_lat":-90,"max_lat":90,"min_lon":-180,"max_lon":180,"rate_bps":1000,"tax_delivery":false,"priority":0,"active":true})).unwrap(),&f.admin).await.unwrap();
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    assert_eq!(q.snapshot.tax_amount.to_string(), "0.32");
    assert_eq!(q.snapshot.total.to_string(), "6.56");
    let key = Uuid::new_v4();
    let d = f.app.cart.place(f.customer, q.id, key).await.unwrap();
    assert_eq!(d.items[0].discount_amount.to_string(), "0.36");
    assert_eq!(d.payment.amount_due, d.order.total);
    svc.delete(r.id, &f.admin).await.unwrap();
    let old = f.app.cart.place(f.customer, q.id, key).await.unwrap();
    assert_eq!(json!(old), json!(d));
    assert!(f
        .app
        .cart
        .open(Some(f.customer), "")
        .await
        .unwrap()
        .cart
        .coupon_code
        .is_none());
    let contract: Value = serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &json!(d),
        &contract["components"]["schemas"]["OrderDetail"],
        &contract,
    );
    support::validate_shape(
        &json!(cart),
        &contract["components"]["schemas"]["Cart"],
        &contract,
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn m6_precedence_filters_allocation_and_caps(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let svc = domain_pricing_promotions::Service { pool: pool.clone() };
    let mut cat = promotion("catalog", "percentage", "10", None);
    cat.category_ids = vec![f.product.category_id];
    svc.save(None, cat, &f.admin).await.unwrap();
    let mut higher = promotion("catalog", "fixed", "0.50", None);
    higher.skus = vec![f.product.sku.clone()];
    higher.priority = 20;
    svc.save(None, higher, &f.admin).await.unwrap();
    let mut auto = promotion("cart", "percentage", "50", None);
    auto.priority = 100;
    svc.save(None, auto, &f.admin).await.unwrap();
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    assert_eq!(q.snapshot.discount_amount.to_string(), "1.70"); // $1 per two units then half of $1.40
    svc.save(
        None,
        promotion("cart", "fixed", "0.25", Some("EXPLICIT")),
        &f.admin,
    )
    .await
    .unwrap();
    f.app
        .cart
        .coupon(Some(f.customer), "", "EXPLICIT")
        .await
        .unwrap();
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    assert_eq!(q.snapshot.discount_amount.to_string(), "1.25");
    let mut all = promotion("cart", "fixed", "1000000", Some("FREE"));
    all.customer_group = "verified".into();
    svc.save(None, all, &f.admin).await.unwrap();
    f.app
        .cart
        .coupon(Some(f.customer), "", "FREE")
        .await
        .unwrap();
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    assert_eq!(q.snapshot.discount_amount, q.snapshot.subtotal);
    assert_eq!(q.snapshot.total.to_string(), "3.00");
    // Exact cent conservation across different lines, and no overflow at supported high prices.
    let r = svc
        .list()
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.coupon_code.as_deref() == Some("FREE"))
        .unwrap();
    let lines = vec![
        domain_pricing_promotions::Line {
            product_id: Uuid::new_v4(),
            sku: "A".into(),
            category_id: None,
            price: "9999999999".parse().unwrap(),
            quantity: 1000000,
        },
        domain_pricing_promotions::Line {
            product_id: Uuid::new_v4(),
            sku: "B".into(),
            category_id: None,
            price: "0.01".parse().unwrap(),
            quantity: 1,
        },
    ];
    let a = domain_pricing_promotions::evaluate(&[r], "verified", &lines, Some("FREE".into()));
    assert_eq!(a.amount, "1000000".parse().unwrap());
    assert_eq!(
        a.lines
            .iter()
            .flatten()
            .map(|a| a.amount)
            .sum::<sqlx::types::Decimal>(),
        a.amount
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn m6_rule_changes_expiry_and_invalid_coupon_fail_closed(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let svc = domain_pricing_promotions::Service { pool: pool.clone() };
    let r = svc
        .save(
            None,
            promotion("cart", "percentage", "10", Some("TEMP")),
            &f.admin,
        )
        .await
        .unwrap();
    f.app
        .cart
        .coupon(Some(f.customer), "", "TEMP")
        .await
        .unwrap();
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    svc.save(
        Some(r.id),
        promotion("cart", "percentage", "20", Some("TEMP")),
        &f.admin,
    )
    .await
    .unwrap();
    assert!(f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .is_err());
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    sqlx::query("UPDATE pricing_promotions.rules SET ends_at=clock_timestamp()-interval '1 second' WHERE id=$1").bind(r.id).execute(&pool).await.unwrap();
    assert!(f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .is_err());
    let cart = f.app.cart.open(Some(f.customer), "").await.unwrap().cart;
    assert!(cart.coupon_error.is_some());
    assert_eq!(cart.discount_amount, sqlx::types::Decimal::ZERO);
    assert!(f.app.cart.quote(f.customer, f.location).await.is_err());
    f.app.cart.coupon(Some(f.customer), "", "").await.unwrap();
    assert!(f.app.cart.quote(f.customer, f.location).await.is_ok());
    assert_eq!(count(&pool, "orders.orders").await, 0);
    assert_eq!(
        f.app
            .cart
            .inventory
            .stock(f.product.id)
            .await
            .unwrap()
            .on_hand,
        10
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn m6_schedule_group_validation_permissions_and_guest_merge(pool: PgPool) {
    let mut f = setup(pool.clone()).await;
    let svc = domain_pricing_promotions::Service { pool: pool.clone() };
    let mut i = promotion("cart", "percentage", "101", None);
    assert!(svc.save(None, i, &f.admin).await.is_err());
    i = promotion("catalog", "fixed", "1", Some("BAD"));
    assert!(svc.save(None, i, &f.admin).await.is_err());
    i = promotion("cart", "fixed", "1", Some("FUTURE"));
    i.starts_at = Some(chrono::Utc::now() + chrono::Duration::hours(1));
    let r = svc.save(None, i, &f.admin).await.unwrap();
    assert!(f
        .app
        .cart
        .coupon(Some(f.customer), "", "FUTURE")
        .await
        .is_err());
    assert!(svc
        .save(
            None,
            promotion("cart", "fixed", "1", Some("future")),
            &f.admin
        )
        .await
        .is_err());
    f.admin.permissions = vec!["promotions.read".into()];
    assert!(svc.delete(r.id, &f.admin).await.is_err());
    assert!(svc
        .save(None, promotion("cart", "fixed", "1", None), &f.admin)
        .await
        .is_err());
    f.admin.permissions = vec!["*".into()];
    let mut i = promotion("cart", "fixed", "0.10", Some("GUEST"));
    i.customer_group = "guest".into();
    svc.save(None, i, &f.admin).await.unwrap();
    let g = f.app.cart.open(None, "").await.unwrap();
    let token = g.guest_token.unwrap();
    f.app
        .cart
        .set(None, &token, f.product.clone(), 1, true)
        .await
        .unwrap();
    assert_eq!(
        f.app
            .cart
            .coupon(None, &token, "GUEST")
            .await
            .unwrap()
            .discount_amount
            .to_string(),
        "0.10"
    );
    let merged = f
        .app
        .cart
        .open(Some(f.customer), &token)
        .await
        .unwrap()
        .cart;
    assert_eq!(merged.coupon_code.as_deref(), Some("GUEST"));
    assert!(merged.coupon_error.unwrap().contains("customer group"));
    f.app.cart.coupon(Some(f.customer), "", "").await.unwrap();
    let mut i = promotion("cart", "fixed", "0.10", Some("FILTER"));
    i.skus = vec!["OTHER".into()];
    svc.save(None, i, &f.admin).await.unwrap();
    assert!(f
        .app
        .cart
        .coupon(Some(f.customer), "", "FILTER")
        .await
        .is_err());
}

#[sqlx::test(migrations = "../../migrations")]
async fn assistant_order_tool_uses_real_owned_snapshot(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let placed = f
        .app
        .cart
        .place(f.customer, quote.id, Uuid::new_v4())
        .await
        .unwrap();
    let tenant = Uuid::new_v4();
    let app = api_gateway::assistant::App {
        identity: f.app.clone(),
        tenant,
        signing: std::sync::Arc::new(
            jsonwebtoken::EncodingKey::from_rsa_pem(support::assistant_private_key()).unwrap(),
        ),
        verifying: std::sync::Arc::new(
            jsonwebtoken::DecodingKey::from_rsa_pem(support::assistant_public_key()).unwrap(),
        ),
        client: reqwest::Client::new(),
        slots: std::sync::Arc::new(tokio::sync::Semaphore::new(8)),
    };
    let now = chrono::Utc::now().timestamp();
    let mut claims = api_gateway::assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "assistant-tools".into(),
        tenant,
        sub: Some(f.customer),
        sid: Some(f.app.customers.security.decode(&f.token).unwrap().sid),
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: "order_status".into(),
    };
    let router = api_gateway::assistant::router(f.app.clone(), Some(app.clone()));
    let uri = format!("/v1/assistant-tools/orders/{}", placed.order.id);
    let request = |token: String| {
        Request::builder()
            .uri(&uri)
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    let response = router
        .clone()
        .oneshot(request(app.sign(&claims).unwrap()))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let value: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let contract: Value = serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &value,
        &contract["components"]["schemas"]["AssistantOrder"],
        &contract,
    );
    assert_eq!(value["total"], placed.order.total.to_string());
    for field in ["customer_id", "contact", "location", "payment", "history"] {
        assert!(value.get(field).is_none());
    }
    let credentials = || domain_customers::Credentials {
        identifier: "other-assistant@example.test".into(),
        password: "Assistant owner test!".into(),
    };
    let other = f.app.customers.register(credentials()).await.unwrap();
    let login = f.app.customers.login(credentials()).await.unwrap();
    claims.sub = Some(other.id);
    claims.sid = Some(
        f.app
            .customers
            .security
            .decode(&login.body.access_token)
            .unwrap()
            .sid,
    );
    assert_eq!(
        router
            .clone()
            .oneshot(request(app.sign(&claims).unwrap()))
            .await
            .unwrap()
            .status(),
        404
    );
    claims.tenant = Uuid::new_v4();
    assert_eq!(
        router
            .oneshot(request(app.sign(&claims).unwrap()))
            .await
            .unwrap()
            .status(),
        403
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn m12_split_shipments_dispatch_independently_and_cancel_to_original_sources(pool: PgPool) {
    use domain_inventory::msi::*;
    let f = setup(pool.clone()).await;
    let inventory = &f.app.cart.inventory;
    f.app
        .cart
        .remove(Some(f.customer), "", f.product.id)
        .await
        .unwrap();
    let b = inventory
        .save_source(
            None,
            SourceInput {
                code: "b".into(),
                name: "Warehouse B".into(),
                is_enabled: true,
                address: "Test".into(),
                latitude: Some(30.0),
                longitude: Some(31.0),
                contact_name: "".into(),
                contact_phone: "".into(),
                priority: 1,
            },
            f.admin.user.id,
        )
        .await
        .unwrap();
    inventory
        .save_stock(
            Some(DEFAULT_SOURCE),
            StockInput {
                code: "default".into(),
                name: "Default".into(),
                is_default: true,
                is_global: false,
                sources: vec![
                    SourceLink {
                        source_id: DEFAULT_SOURCE,
                        priority: 0,
                    },
                    SourceLink {
                        source_id: b.id,
                        priority: 10,
                    },
                ],
            },
            f.admin.user.id,
        )
        .await
        .unwrap();
    for (source_id, quantity) in [(DEFAULT_SOURCE, 5), (b.id, 20)] {
        inventory
            .adjust_source(
                f.product.id,
                SourceItemInput {
                    source_id,
                    quantity,
                    status: "in_stock".into(),
                    notify_stock_qty: 0,
                    reason: "M12 fixture".into(),
                },
                f.admin.user.id,
            )
            .await
            .unwrap();
    }
    f.app
        .cart
        .set(Some(f.customer), "", f.product.clone(), 8, false)
        .await
        .unwrap();
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let d = f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .unwrap();
    assert_eq!(d.shipments.len(), 2);
    assert_eq!(d.shipments[0].items[0].quantity, 5);
    assert_eq!(d.shipments[1].items[0].quantity, 3);
    assert!(d.shipments.iter().all(|s| s.shipment.status == "pending"));
    let orders = domain_orders::Service { pool: pool.clone() };
    let cancelled = orders
        .transition(
            d.order.id,
            &f.admin,
            "cancelled",
            "Cancel split before dispatch",
        )
        .await
        .unwrap();
    assert!(cancelled
        .shipments
        .iter()
        .all(|s| s.shipment.status == "cancelled"));
    let items = inventory.source_items(f.product.id).await.unwrap();
    assert_eq!(
        items
            .iter()
            .find(|s| s.source_id == DEFAULT_SOURCE)
            .unwrap()
            .quantity,
        5
    );
    assert_eq!(
        items.iter().find(|s| s.source_id == b.id).unwrap().quantity,
        20
    );
    assert!(orders
        .transition(d.order.id, &f.admin, "cancelled", "Retry")
        .await
        .is_err());
    f.app
        .cart
        .set(Some(f.customer), "", f.product.clone(), 8, false)
        .await
        .unwrap();
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let key = Uuid::new_v4();
    let d = f.app.cart.place(f.customer, q.id, key).await.unwrap();
    assert_eq!(
        f.app
            .cart
            .place(f.customer, q.id, key)
            .await
            .unwrap()
            .shipments
            .len(),
        2
    );
    orders
        .transition(d.order.id, &f.admin, "confirmed", "Confirm")
        .await
        .unwrap();
    orders
        .transition(d.order.id, &f.admin, "fulfilling", "Pack")
        .await
        .unwrap();
    assert!(orders
        .dispatch(d.order.id, &f.admin, "ALL", "Ambiguous")
        .await
        .is_err());
    let a = d.shipments[0].shipment.id;
    let b = d.shipments[1].shipment.id;
    orders
        .dispatch_shipment(d.order.id, Some(a), &f.admin, "M12-A", "Dispatch A")
        .await
        .unwrap();
    assert!(orders
        .transition(d.order.id, &f.admin, "cancelled", "Too late")
        .await
        .is_err());
    let partial = orders
        .shipment_status(a, &f.admin, "delivered", "A delivered")
        .await
        .unwrap();
    assert_eq!(partial.order.status, "shipped");
    assert!(orders
        .transition(d.order.id, &f.admin, "cash_collected", "Too early")
        .await
        .is_err());
    assert!(orders
        .dispatch_shipment(
            d.order.id,
            Some(b),
            &f.admin,
            "M12-A",
            "Duplicate reference"
        )
        .await
        .is_err());
    orders
        .dispatch_shipment(d.order.id, Some(b), &f.admin, "M12-B", "Dispatch B")
        .await
        .unwrap();
    let completed = orders
        .shipment_status(b, &f.admin, "delivered", "B delivered")
        .await
        .unwrap();
    assert_eq!(completed.order.status, "delivered");
    assert!(completed
        .shipments
        .iter()
        .all(|s| s.shipment.status == "delivered"));
    orders
        .transition(d.order.id, &f.admin, "cash_collected", "Received cash")
        .await
        .unwrap();
    assert_eq!(inventory.stock(f.product.id).await.unwrap().on_hand, 17);
}

async fn scheduled_hold(f: &Fixture) -> domain_fulfillment::capacity::Reservation {
    use chrono::{Datelike, Duration, Utc};
    let date = (Utc::now() + Duration::days(2)).date_naive();
    let schedule = Uuid::new_v4();
    let service = domain_fulfillment::capacity::Service {
        pool: f.app.cart.pool.clone(),
    };
    let config = json!({"windows":[{"weekday":date.weekday().num_days_from_monday(),"start":"09:00:00","end":"13:00:00","cutoff":null}],"duration_minutes":60,"spacing_minutes":0,"lead_minutes":60,"cutoff":null,"min_days":0,"max_days":14,"ttl_minutes":10,"release_before":"fulfilling","exceptions":[]});
    service
        .save_schedule(
            domain_fulfillment::scheduling::Schedule {
                entity_id: 0,
                id: schedule,
                source_id: Uuid::from_u128(1),
                area_id: None,
                method: "scheduled_delivery".into(),
                enabled: true,
                timezone: "UTC".into(),
                config,
            },
            "Enable test scheduling",
            &f.admin,
        )
        .await
        .unwrap();
    assert!(f.app.cart.quote(f.customer, f.location).await.is_err());
    service
        .reserve(
            f.customer,
            domain_fulfillment::capacity::Selection {
                schedule_id: schedule,
                location_id: f.location,
                starts_at: date.and_hms_opt(9, 0, 0).unwrap().and_utc(),
                ends_at: date.and_hms_opt(10, 0, 0).unwrap().and_utc(),
                idempotency_key: Uuid::new_v4(),
            },
        )
        .await
        .unwrap()
}
#[sqlx::test(migrations = "../../migrations")]
async fn scheduled_checkout_confirmation_retry_and_cancellation_policy(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let hold = scheduled_hold(&f).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    assert_eq!(
        quote.snapshot.scheduled_delivery.as_ref().unwrap()["id"],
        json!(hold.id)
    );
    let key = Uuid::new_v4();
    let order = f.app.cart.place(f.customer, quote.id, key).await.unwrap();
    assert_eq!(order.scheduled_deliveries[0]["status"], "CONFIRMED");
    assert_eq!(
        f.app
            .cart
            .place(f.customer, quote.id, key)
            .await
            .unwrap()
            .order
            .id,
        order.order.id
    );
    let orders = domain_orders::Service { pool: pool.clone() };
    let cancelled = orders
        .transition(order.order.id, &f.admin, "cancelled", "Customer request")
        .await
        .unwrap();
    assert_eq!(cancelled.scheduled_deliveries[0]["status"], "CANCELLED");
    let contract: Value = serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &json!(cancelled),
        &contract["components"]["schemas"]["OrderDetail"],
        &contract,
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn scheduled_capacity_preserved_after_fulfillment_stage(pool: PgPool) {
    let f = setup(pool.clone()).await;
    scheduled_hold(&f).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let order = f
        .app
        .cart
        .place(f.customer, quote.id, Uuid::new_v4())
        .await
        .unwrap();
    let orders = domain_orders::Service { pool: pool.clone() };
    orders
        .transition(order.order.id, &f.admin, "confirmed", "Confirmed")
        .await
        .unwrap();
    orders
        .transition(order.order.id, &f.admin, "fulfilling", "Picking")
        .await
        .unwrap();
    let cancelled = orders
        .transition(order.order.id, &f.admin, "cancelled", "Late cancellation")
        .await
        .unwrap();
    assert_eq!(cancelled.scheduled_deliveries[0]["status"], "CONFIRMED");
}
#[sqlx::test(migrations = "../../migrations")]
async fn scheduled_payment_failure_rolls_back_capacity_confirmation(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let hold = scheduled_hold(&f).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    sqlx::query("ALTER TABLE payments.payment_transactions ADD CONSTRAINT scheduled_failure CHECK(amount_due<0)").execute(&pool).await.unwrap();
    assert!(f
        .app
        .cart
        .place(f.customer, quote.id, Uuid::new_v4())
        .await
        .is_err());
    let status: String =
        sqlx::query_scalar("SELECT status FROM fulfillment.capacity_reservations WHERE id=$1")
            .bind(hold.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "HELD");
    assert_eq!(count(&pool, "orders.orders").await, 0);
}
#[sqlx::test(migrations = "../../migrations")]
async fn capacity_api_requires_customer_and_granular_admin_permission(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let router = api_gateway::cart::router(f.app.clone());
    let response = router
        .oneshot(
            Request::builder()
                .uri("/v1/admin/fulfillment/configuration")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let mut who = f.admin;
    who.permissions = vec!["inventory.write".into()];
    let service = domain_fulfillment::capacity::Service { pool };
    let input = domain_fulfillment::scheduling::Schedule {
        entity_id: 0,
        id: Uuid::new_v4(),
        source_id: Uuid::from_u128(1),
        area_id: None,
        method: "scheduled_delivery".into(),
        enabled: false,
        timezone: "UTC".into(),
        config: json!({}),
    };
    assert!(matches!(
        service.save_schedule(input, "test", &who).await,
        Err(infra_auth::Error::Forbidden)
    ));
}

#[sqlx::test(migrations = "../../migrations")]
async fn automatic_capacity_allocation_requires_no_customer_slot_selection(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let held = scheduled_hold(&f).await;
    let service = domain_fulfillment::capacity::Service { pool: pool.clone() };
    service.release(f.customer, held.id).await.unwrap();
    sqlx::query(
        "UPDATE fulfillment.schedules SET config=jsonb_set(config,'{selection_required}','false')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    assert!(quote.snapshot.scheduled_delivery.is_some());
    let again = f.app.cart.quote(f.customer, f.location).await.unwrap();
    assert_eq!(
        again.snapshot.scheduled_delivery,
        quote.snapshot.scheduled_delivery
    );
    let order = f
        .app
        .cart
        .place(f.customer, quote.id, Uuid::new_v4())
        .await
        .unwrap();
    assert_eq!(order.scheduled_deliveries[0]["status"], "CONFIRMED");
}

#[sqlx::test(migrations = "../../migrations")]
async fn schedule_override_removal_requires_override_permission(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let held = scheduled_hold(&f).await;
    let service = domain_fulfillment::capacity::Service { pool: pool.clone() };
    let mut schedule: domain_fulfillment::scheduling::Schedule =
        sqlx::query_as("SELECT * FROM fulfillment.schedules WHERE id=$1")
            .bind(held.schedule_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    schedule.config["exceptions"] =
        json!([{"from":"2026-12-25","through":"2026-12-25","closed":true,"windows":[]}]);
    service
        .save_schedule(schedule.clone(), "Holiday", &f.admin)
        .await
        .unwrap();
    let mut restricted = f.admin;
    restricted.permissions = vec!["fulfillment.schedule.manage".into()];
    schedule.config["exceptions"] = json!([]);
    assert!(matches!(
        service
            .save_schedule(schedule, "Remove holiday", &restricted)
            .await,
        Err(infra_auth::Error::Forbidden)
    ));
}

#[sqlx::test(migrations = "../../migrations")]
async fn additive_capacity_migration_preserves_existing_orders(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let before = f
        .app
        .cart
        .place(f.customer, quote.id, Uuid::new_v4())
        .await
        .unwrap();
    assert!(before.order.entity_id > 0);
    sqlx::raw_sql("ALTER TABLE fulfillment.plan_groups DROP CONSTRAINT plan_groups_schedule_id_fkey; DROP TABLE fulfillment.capacity_settings,fulfillment.capacity_consumption,fulfillment.capacity_buckets,fulfillment.capacity_reservations,fulfillment.capacity_rules,fulfillment.schedules").execute(&pool).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../migrations/20260922120000_fulfillment_capacity.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../migrations/20260922121000_fulfillment_capacity_extensions.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql("ALTER TABLE fulfillment.capacity_reservations ADD COLUMN group_id uuid REFERENCES fulfillment.plan_groups(id); ALTER TABLE fulfillment.plan_groups ADD FOREIGN KEY(schedule_id) REFERENCES fulfillment.schedules(id)").execute(&pool).await.unwrap();
    // The replay reconstructs the older capacity schema. Restore the additive
    // identifier metadata before exercising the current order reader.
    for table in ["schedules", "capacity_rules", "capacity_reservations"] {
        sqlx::raw_sql(&format!(
            "ALTER TABLE fulfillment.{table} ADD COLUMN entity_id bigint GENERATED ALWAYS AS IDENTITY (MINVALUE 1 MAXVALUE 9007199254740991 NO CYCLE) UNIQUE CHECK(entity_id BETWEEN 1 AND 9007199254740991);
             CREATE TRIGGER entity_id_immutable BEFORE UPDATE OF entity_id ON fulfillment.{table} FOR EACH ROW EXECUTE FUNCTION platform.immutable_entity_id();"
        ))
        .execute(&pool)
        .await
        .unwrap();
    }
    let after = domain_orders::Service { pool }
        .detail(before.order.id, Some(f.customer))
        .await
        .unwrap();
    assert_eq!(before.order.entity_id, after.order.entity_id);
    assert_eq!(json!(before), json!(after));
}

#[sqlx::test(migrations = "../../migrations")]
async fn disabling_last_schedule_does_not_bypass_capacity_controls(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let hold = scheduled_hold(&f).await;
    let service = domain_fulfillment::capacity::Service { pool: pool.clone() };
    service.release(f.customer, hold.id).await.unwrap();
    let mut schedule: domain_fulfillment::scheduling::Schedule =
        sqlx::query_as("SELECT * FROM fulfillment.schedules WHERE id=$1")
            .bind(hold.schedule_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    schedule.enabled = false;
    service
        .save_schedule(schedule, "Close location", &f.admin)
        .await
        .unwrap();
    assert!(f.app.cart.quote(f.customer, f.location).await.is_err());
    assert!(service
        .options(f.customer, f.location, hold.starts_at.date_naive())
        .await
        .unwrap()
        .is_empty());
    service
        .set_enabled(false, "Return to ordinary fulfillment", &f.admin)
        .await
        .unwrap();
    assert!(f
        .app
        .cart
        .quote(f.customer, f.location)
        .await
        .unwrap()
        .snapshot
        .scheduled_delivery
        .is_none());
}

async fn policy(f: &Fixture, patch: Value) {
    let mut tx = domain_inventory::begin(&f.app.cart.pool).await.unwrap();
    let store: Uuid = sqlx::query_scalar("SELECT id FROM fulfillment.stores WHERE is_default")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    domain_fulfillment::capabilities::save(&mut tx, Some(store), patch, "Milestone test", &f.admin)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}
fn asap_request(
    location: Option<Uuid>,
    source: Option<Uuid>,
) -> domain_fulfillment::plans::Request {
    domain_fulfillment::plans::Request {
        method: if location.is_some() {
            "delivery"
        } else {
            "pickup"
        }
        .into(),
        location_id: location,
        source_id: source,
        date: chrono::Utc::now().date_naive(),
        asap: true,
    }
}
async fn plan_hold(
    f: &Fixture,
    r: domain_fulfillment::plans::Request,
    windows: Vec<domain_fulfillment::plans::Window>,
) -> Value {
    domain_fulfillment::plans::reserve(
        &f.app.cart.pool,
        f.customer,
        domain_fulfillment::plans::Selection {
            request: r,
            windows,
            idempotency_key: Uuid::new_v4(),
        },
    )
    .await
    .unwrap()
}
async fn pickup_policy(f: &Fixture, capacity: bool, holds: bool) {
    policy(f,json!({"pickup_enabled":true,"capacity_management_enabled":capacity,"checkout_capacity_holds_enabled":holds,"geo_fencing_enabled":false})).await;
    sqlx::query("INSERT INTO fulfillment.store_sources(store_id,source_id,pickup_enabled) SELECT id,$1,true FROM fulfillment.stores WHERE is_default").bind(Uuid::from_u128(1)).execute(&f.app.cart.pool).await.unwrap();
}
#[sqlx::test(migrations = "../../migrations")]
async fn pickup_without_address_zero_fee_lifecycle_and_retry(pool: PgPool) {
    let f = setup(pool.clone()).await;
    pickup_policy(&f, false, false).await;
    sqlx::query("DELETE FROM customers.customer_locations WHERE customer_id=$1")
        .bind(f.customer)
        .execute(&pool)
        .await
        .unwrap();
    let options = domain_fulfillment::plans::availability(&pool, f.customer)
        .await
        .unwrap();
    assert_eq!(
        options["methods"][1]["locations"].as_array().unwrap().len(),
        1
    );
    plan_hold(&f, asap_request(None, Some(Uuid::from_u128(1))), vec![]).await;
    let quote = f.app.cart.quote(f.customer, Uuid::nil()).await.unwrap();
    assert_eq!(quote.snapshot.delivery_fee, rust_decimal::Decimal::ZERO);
    let key = Uuid::new_v4();
    let order = f.app.cart.place(f.customer, quote.id, key).await.unwrap();
    let contract: Value = serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &json!(order),
        &contract["components"]["schemas"]["OrderDetail"],
        &contract,
    );
    assert_eq!(order.shipments[0].shipment.method, "pickup");
    assert!(order.scheduled_deliveries.is_empty());
    assert_eq!(order.fulfillment_plan.as_ref().unwrap()["method"], "pickup");
    assert_eq!(
        f.app
            .cart
            .place(f.customer, quote.id, key)
            .await
            .unwrap()
            .order
            .id,
        order.order.id
    );
    let svc = domain_orders::Service { pool: pool.clone() };
    for status in ["confirmed", "fulfilling"] {
        svc.transition(order.order.id, &f.admin, status, "Test pickup")
            .await
            .unwrap();
    }
    assert!(svc
        .dispatch(
            order.order.id,
            &f.admin,
            "tracking",
            "Invalid pickup dispatch"
        )
        .await
        .is_err());
    for status in ["pickup_ready", "picked_up", "cash_collected"] {
        svc.transition(order.order.id, &f.admin, status, "Test pickup")
            .await
            .unwrap();
    }
    assert_eq!(count(&pool, "fulfillment.capacity_reservations").await, 0);
}
#[sqlx::test(migrations = "../../migrations")]
async fn pickup_disabled_invalid_source_and_stock_fail_closed(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let r = asap_request(None, Some(Uuid::from_u128(1)));
    assert!(
        domain_fulfillment::plans::options(&pool, f.customer, r.clone())
            .await
            .is_err()
    );
    pickup_policy(&f, false, false).await;
    let mut invalid = r.clone();
    invalid.source_id = Some(Uuid::new_v4());
    assert!(
        domain_fulfillment::plans::options(&pool, f.customer, invalid)
            .await
            .is_err()
    );
    sqlx::query("UPDATE inventory.source_items SET quantity=0")
        .execute(&pool)
        .await
        .unwrap();
    assert!(domain_fulfillment::plans::options(&pool, f.customer, r)
        .await
        .is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn pickup_capacity_without_checkout_holds_admits_at_placement(pool: PgPool) {
    let f = setup(pool.clone()).await;
    pickup_policy(&f, true, false).await;
    sqlx::query("INSERT INTO fulfillment.capacity_rules(id,source_id,method,period,limits) VALUES($1,$2,'pickup','day','{\"orders\":0}')").bind(Uuid::new_v4()).bind(Uuid::from_u128(1)).execute(&pool).await.unwrap();
    plan_hold(&f, asap_request(None, Some(Uuid::from_u128(1))), vec![]).await;
    assert_eq!(count(&pool, "fulfillment.capacity_reservations").await, 0);
    let q = f.app.cart.quote(f.customer, Uuid::nil()).await.unwrap();
    assert!(f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .is_err());
    assert_eq!(count(&pool, "orders.orders").await, 0);
    sqlx::query("UPDATE fulfillment.capacity_rules SET limits='{\"orders\":1}'")
        .execute(&pool)
        .await
        .unwrap();
    f.app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .unwrap();
    assert_eq!(count(&pool, "fulfillment.capacity_reservations").await, 1);
}
#[sqlx::test(migrations = "../../migrations")]
async fn disabled_geofencing_and_scheduling_do_not_block_delivery(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let hold = scheduled_hold(&f).await;
    policy(&f,json!({"scheduled_delivery_enabled":false,"asap_delivery_enabled":true,"customer_delivery_slot_selection_enabled":false,"capacity_management_enabled":false,"checkout_capacity_holds_enabled":false,"geo_fencing_enabled":false})).await;
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km) VALUES($1,'Remote',10,10,1)").bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    // A stale legacy slot is no longer required, and old rules cannot cap the new ASAP plan.
    sqlx::query("UPDATE fulfillment.capacity_rules SET limits='{\"orders\":0}'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(domain_fulfillment::capacity::Service { pool: pool.clone() }
        .options(f.customer, f.location, hold.starts_at.date_naive())
        .await
        .is_err());
    plan_hold(&f, asap_request(Some(f.location), None), vec![]).await;
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    assert!(q.snapshot.scheduled_delivery.is_none());
    f.app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .unwrap();
    let held:i64=sqlx::query_scalar("SELECT count(*) FROM fulfillment.capacity_reservations WHERE status IN ('HELD','CONFIRMED')").fetch_one(&pool).await.unwrap();
    assert_eq!(held, 0);
}
async fn split_fixture(f: &Fixture) -> domain_fulfillment::plans::Request {
    let pool = &f.app.cart.pool;
    let held = scheduled_hold(f).await;
    let second = Uuid::from_u128(2);
    sqlx::query(
        "INSERT INTO inventory.inventory_sources(id,code,name) VALUES($1,'split','Second source')",
    )
    .bind(second)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO inventory.source_stock_links(source_id,stock_id,priority) SELECT $1,id,2 FROM inventory.stocks WHERE is_default").bind(second).execute(pool).await.unwrap();
    sqlx::query("UPDATE inventory.source_items SET quantity=1 WHERE product_id=$1")
        .bind(f.product.id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO inventory.source_items(source_id,product_id,quantity) VALUES($1,$2,100)",
    )
    .bind(second)
    .bind(f.product.id)
    .execute(pool)
    .await
    .unwrap();
    // Different products force both sources (rather than routing all units to the second source).
    let product = Uuid::new_v4();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) SELECT $1,'SECOND','second','Second','',1,'USD','each',category_id FROM catalog.products WHERE id=$2").bind(product).bind(f.product.id).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.stock(product_id,on_hand) VALUES($1,100)")
        .bind(product)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO inventory.source_items(source_id,product_id,quantity) VALUES($1,$2,100)",
    )
    .bind(Uuid::from_u128(1))
    .bind(product)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO cart_checkout.items(cart_id,product_id,sku,name,unit,price,quantity) SELECT id,$1,'SECOND','Second','each',1,1 FROM cart_checkout.carts WHERE customer_id=$2").bind(product).bind(f.customer).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO fulfillment.schedules(id,source_id,method,enabled,timezone,config) SELECT $1,$2,method,enabled,timezone,config FROM fulfillment.schedules WHERE id=$3").bind(Uuid::new_v4()).bind(second).bind(held.schedule_id).execute(pool).await.unwrap();
    policy(f, json!({"split_order_scheduling_enabled":true})).await;
    domain_fulfillment::plans::Request {
        method: "delivery".into(),
        location_id: Some(f.location),
        source_id: None,
        date: held.starts_at.date_naive(),
        asap: false,
    }
}
fn first_windows(
    options: &domain_fulfillment::plans::Options,
) -> Vec<domain_fulfillment::plans::Window> {
    options
        .groups
        .iter()
        .map(|g| {
            let s = &g.slots[0];
            domain_fulfillment::plans::Window {
                source_id: g.source_id,
                schedule_id: s.schedule_id,
                starts_at: s.starts_at,
                ends_at: s.ends_at,
            }
        })
        .collect()
}
#[sqlx::test(migrations = "../../migrations")]
async fn split_same_window_atomic_confirm_and_idempotent_retry(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let r = split_fixture(&f).await;
    let options = domain_fulfillment::plans::options(&pool, f.customer, r.clone())
        .await
        .unwrap();
    assert_eq!(options.groups.len(), 2);
    assert!(!options.common_windows.is_empty());
    let selection = domain_fulfillment::plans::Selection {
        request: r,
        windows: first_windows(&options),
        idempotency_key: Uuid::new_v4(),
    };
    let held = domain_fulfillment::plans::reserve(&pool, f.customer, selection.clone())
        .await
        .unwrap();
    assert_eq!(
        held,
        domain_fulfillment::plans::reserve(&pool, f.customer, selection)
            .await
            .unwrap()
    );
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    sqlx::query("DELETE FROM inventory.source_stock_links WHERE source_id=$1")
        .bind(Uuid::from_u128(2))
        .execute(&pool)
        .await
        .unwrap();
    assert!(f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .is_err());
    sqlx::query("INSERT INTO inventory.source_stock_links(source_id,stock_id,priority) SELECT $1,id,2 FROM inventory.stocks WHERE is_default").bind(Uuid::from_u128(2)).execute(&pool).await.unwrap();
    let order = f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .unwrap();
    assert_eq!(order.shipments.len(), 2);
    assert_eq!(order.scheduled_deliveries.len(), 2);
    assert_eq!(
        order.scheduled_deliveries[0]["starts_at"],
        order.scheduled_deliveries[1]["starts_at"]
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn split_shared_capacity_failure_rolls_back_every_group(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let r = split_fixture(&f).await;
    let options = domain_fulfillment::plans::options(&pool, f.customer, r.clone())
        .await
        .unwrap();
    // Each group fits individually, but their shared one-order bucket cannot admit both.
    sqlx::query("DELETE FROM fulfillment.capacity_rules WHERE id NOT IN (SELECT rule_id FROM fulfillment.capacity_consumption)").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO fulfillment.capacity_rules(id,period,limits) VALUES($1,'day','{\"orders\":1}')").bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    let result = domain_fulfillment::plans::reserve(
        &pool,
        f.customer,
        domain_fulfillment::plans::Selection {
            request: r,
            windows: first_windows(&options),
            idempotency_key: Uuid::new_v4(),
        },
    )
    .await;
    assert!(result.is_err());
    assert_eq!(count(&pool, "fulfillment.plans").await, 0);
    let held: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM fulfillment.capacity_reservations WHERE status='HELD'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(held, 0);
}
#[sqlx::test(migrations = "../../migrations")]
async fn split_independent_windows_and_single_source_policy(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let r = split_fixture(&f).await;
    policy(&f, json!({"multi_source_fulfillment_enabled":false})).await;
    assert!(
        domain_fulfillment::plans::options(&pool, f.customer, r.clone())
            .await
            .is_err()
    );
    policy(
        &f,
        json!({"split_order_scheduling_enabled":true,"split_delivery_mode":"independent_windows"}),
    )
    .await;
    let mut config: Value =
        sqlx::query_scalar("SELECT config FROM fulfillment.schedules WHERE source_id=$1")
            .bind(Uuid::from_u128(2))
            .fetch_one(&pool)
            .await
            .unwrap();
    for w in config["windows"].as_array_mut().unwrap() {
        w["start"] = json!("18:00:00");
        w["end"] = json!("20:00:00");
    }
    sqlx::query("UPDATE fulfillment.schedules SET config=$2 WHERE source_id=$1")
        .bind(Uuid::from_u128(2))
        .bind(config)
        .execute(&pool)
        .await
        .unwrap();
    let opts = domain_fulfillment::plans::options(&pool, f.customer, r.clone())
        .await
        .unwrap();
    assert!(opts.common_windows.is_empty());
    plan_hold(&f, r, first_windows(&opts)).await;
}
#[sqlx::test(migrations = "../../migrations")]
async fn plan_expiry_recalculation_configuration_and_store_isolation(pool: PgPool) {
    let f = setup(pool.clone()).await;
    pickup_policy(&f, false, false).await;
    let r = asap_request(None, Some(Uuid::from_u128(1)));
    let first = plan_hold(&f, r.clone(), vec![]).await;
    sqlx::query("UPDATE fulfillment.plans SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    domain_fulfillment::capacity::Service { pool: pool.clone() }
        .expire()
        .await
        .unwrap();
    assert!(f.app.cart.quote(f.customer, Uuid::nil()).await.is_err());
    let second = plan_hold(&f, r, vec![]).await;
    assert_ne!(first["id"], second["id"]);
    policy(&f, json!({"pickup_enabled":false})).await;
    assert!(f.app.cart.quote(f.customer, Uuid::nil()).await.is_err());
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO fulfillment.stores(id,name,capabilities) VALUES($1,'Other','{\"pickup_enabled\":true,\"geo_fencing_enabled\":false}')").bind(other).execute(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    let other_cap = domain_fulfillment::capabilities::resolve(&mut tx, other)
        .await
        .unwrap();
    assert!(other_cap.pickup_enabled);
    tx.commit().await.unwrap();
    sqlx::query("UPDATE cart_checkout.carts SET fulfillment_store_id=$1 WHERE customer_id=$2")
        .bind(other)
        .bind(f.customer)
        .execute(&pool)
        .await
        .unwrap();
    let options = domain_fulfillment::plans::availability(&pool, f.customer)
        .await
        .unwrap();
    assert!(options["methods"][1]["locations"]
        .as_array()
        .unwrap()
        .is_empty());
}
#[sqlx::test(migrations = "../../migrations")]
async fn bounded_split_contention_never_overbooks_either_source(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let request = split_fixture(&f).await;
    sqlx::query(
        "UPDATE inventory.source_items SET quantity=0 WHERE source_id=$1 AND product_id=$2",
    )
    .bind(Uuid::from_u128(1))
    .bind(f.product.id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO fulfillment.capacity_rules(id,source_id,period,limits) SELECT gen_random_uuid(),id,'slot','{\"orders\":1}' FROM inventory.inventory_sources").execute(&pool).await.unwrap();
    let opts = domain_fulfillment::plans::options(&pool, f.customer, request.clone())
        .await
        .unwrap();
    let windows = first_windows(&opts);
    let template_cart: Uuid =
        sqlx::query_scalar("SELECT id FROM cart_checkout.carts WHERE customer_id=$1")
            .bind(f.customer)
            .fetch_one(&pool)
            .await
            .unwrap();
    let mut jobs = tokio::task::JoinSet::new();
    for n in 0..12 {
        let customer = Uuid::new_v4();
        let cart = Uuid::new_v4();
        let location = Uuid::new_v4();
        sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash,verified) VALUES($1,$2,'email','unused',true)").bind(customer).bind(format!("split{n}@example.test")).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO cart_checkout.carts(id,customer_id) VALUES($1,$2)")
            .bind(cart)
            .bind(customer)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO cart_checkout.items(cart_id,product_id,sku,name,unit,price,quantity) SELECT $1,product_id,sku,name,unit,price,quantity FROM cart_checkout.items WHERE cart_id=$2").bind(cart).bind(template_cart).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO customers.customer_locations(id,customer_id,label,latitude,longitude,formatted_address) VALUES($1,$2,'home',30,31,'Test')").bind(location).bind(customer).execute(&pool).await.unwrap();
        let mut r = request.clone();
        r.location_id = Some(location);
        let windows = windows.clone();
        let pool = pool.clone();
        jobs.spawn(async move {
            domain_fulfillment::plans::reserve(
                &pool,
                customer,
                domain_fulfillment::plans::Selection {
                    request: r,
                    windows,
                    idempotency_key: Uuid::new_v4(),
                },
            )
            .await
        });
    }
    let mut success = 0;
    while let Some(result) = jobs.join_next().await {
        match result.unwrap() {
            Ok(_) => success += 1,
            Err(infra_auth::Error::Invalid(code)) => {
                assert!(["SLOT_UNAVAILABLE", "SLOT_FULL"].contains(&code.as_str()))
            }
            Err(e) => panic!("Unexpected error {e}"),
        }
    }
    assert_eq!(success, 1);
    let counts:Vec<i64>=sqlx::query_scalar("SELECT count(*) FROM fulfillment.capacity_reservations WHERE status='HELD' GROUP BY source_id").fetch_all(&pool).await.unwrap();
    assert_eq!(counts, vec![1, 1]);
}
#[sqlx::test(migrations = "../../migrations")]
async fn capability_inheritance_validation_rbac_and_immediate_refresh(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let store: Uuid = sqlx::query_scalar("SELECT id FROM fulfillment.stores WHERE is_default")
        .fetch_one(&pool)
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    let before = domain_fulfillment::capabilities::resolve(&mut tx, store)
        .await
        .unwrap();
    assert!(
        before.delivery_enabled
            && before.geo_fencing_enabled
            && before.multi_source_fulfillment_enabled
    );
    assert!(!before.pickup_enabled && !before.scheduled_delivery_enabled);
    let mut restricted = domain_admin_iam::Identity {
        user: sqlx::query_as(
            "SELECT id,entity_id,email,name,role_id,active,created_at FROM admin_iam.admin_users WHERE id=$1",
        )
        .bind(f.admin.user.id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        permissions: vec![],
    };
    assert!(matches!(
        domain_fulfillment::capabilities::save(
            &mut tx,
            Some(store),
            json!({}),
            "Denied",
            &restricted
        )
        .await,
        Err(infra_auth::Error::Forbidden)
    ));
    restricted
        .permissions
        .push("fulfillment.settings.manage".into());
    domain_fulfillment::capabilities::save(
        &mut tx,
        None,
        json!({"pickup_enabled":true,"geo_fencing_enabled":false}),
        "Defaults",
        &restricted,
    )
    .await
    .unwrap();
    let inherited = domain_fulfillment::capabilities::resolve(&mut tx, store)
        .await
        .unwrap();
    assert!(inherited.pickup_enabled && !inherited.geo_fencing_enabled);
    domain_fulfillment::capabilities::save(
        &mut tx,
        Some(store),
        json!({"pickup_enabled":false}),
        "Override",
        &restricted,
    )
    .await
    .unwrap();
    assert!(
        !domain_fulfillment::capabilities::resolve(&mut tx, store)
            .await
            .unwrap()
            .pickup_enabled
    );
    tx.commit().await.unwrap();
    for invalid in [
        json!({"pickup_enabled":false,"pickup_scheduling_enabled":true}),
        json!({"scheduled_delivery_enabled":false,"customer_delivery_slot_selection_enabled":true}),
        json!({"capacity_management_enabled":false,"checkout_capacity_holds_enabled":true}),
        json!({"split_order_scheduling_enabled":true,"multi_source_fulfillment_enabled":false}),
        json!({"split_delivery_mode":"unknown"}),
        json!({"mystery":true}),
    ] {
        let mut tx = pool.begin().await.unwrap();
        assert!(domain_fulfillment::capabilities::save(
            &mut tx,
            Some(store),
            invalid,
            "Invalid",
            &f.admin
        )
        .await
        .is_err());
        tx.rollback().await.unwrap();
    }
}
#[sqlx::test(migrations = "../../migrations")]
async fn scheduled_pickup_capacity_expiry_and_cancellation(pool: PgPool) {
    use chrono::Datelike;
    let f = setup(pool.clone()).await;
    pickup_policy(&f, true, true).await;
    policy(&f,json!({"pickup_enabled":true,"pickup_scheduling_enabled":true,"capacity_management_enabled":true,"checkout_capacity_holds_enabled":true})).await;
    let date = (chrono::Utc::now() + chrono::Duration::days(1)).date_naive();
    let schedule = domain_fulfillment::scheduling::Schedule {
        entity_id: 0,
        id: Uuid::new_v4(),
        source_id: Uuid::from_u128(1),
        area_id: None,
        method: "pickup".into(),
        enabled: true,
        timezone: "UTC".into(),
        config: json!({"windows":[{"weekday":date.weekday().num_days_from_monday(),"start":"10:00:00","end":"12:00:00","cutoff":null}],"duration_minutes":60,"spacing_minutes":0,"lead_minutes":0,"cutoff":null,"min_days":0,"max_days":14,"ttl_minutes":10,"release_before":"fulfilling","exceptions":[]}),
    };
    domain_fulfillment::capacity::Service { pool: pool.clone() }
        .save_schedule(schedule, "Pickup hours", &f.admin)
        .await
        .unwrap();
    let r = domain_fulfillment::plans::Request {
        method: "pickup".into(),
        location_id: None,
        source_id: Some(Uuid::from_u128(1)),
        date,
        asap: false,
    };
    let opts = domain_fulfillment::plans::options(&pool, f.customer, r.clone())
        .await
        .unwrap();
    plan_hold(&f, r, first_windows(&opts)).await;
    let q = f.app.cart.quote(f.customer, Uuid::nil()).await.unwrap();
    let order = f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .unwrap();
    domain_orders::Service { pool: pool.clone() }
        .transition(order.order.id, &f.admin, "cancelled", "Cancel pickup")
        .await
        .unwrap();
    let state: String = sqlx::query_scalar(
        "SELECT status FROM fulfillment.capacity_reservations WHERE order_id=$1",
    )
    .bind(order.order.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(state, "CANCELLED");
}
#[sqlx::test(migrations = "../../migrations")]
async fn partial_plan_recovery_releases_remaining_group_and_stock_hold(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let r = split_fixture(&f).await;
    let opts = domain_fulfillment::plans::options(&pool, f.customer, r.clone())
        .await
        .unwrap();
    let plan = plan_hold(&f, r, first_windows(&opts)).await;
    let missing: Uuid = sqlx::query_scalar(
        "SELECT id FROM fulfillment.capacity_reservations WHERE status='HELD' LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM fulfillment.capacity_consumption WHERE reservation_id=$1")
        .bind(missing)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM fulfillment.capacity_reservations WHERE id=$1")
        .bind(missing)
        .execute(&pool)
        .await
        .unwrap();
    // A fresh service instance discovers durable inconsistency without process memory.
    domain_fulfillment::capacity::Service { pool: pool.clone() }
        .expire()
        .await
        .unwrap();
    let status: String = sqlx::query_scalar("SELECT status FROM fulfillment.plans WHERE id=$1")
        .bind(Uuid::parse_str(plan["id"].as_str().unwrap()).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "EXPIRED");
    let held: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM fulfillment.capacity_reservations WHERE status='HELD'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(held, 0);
    let stock: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM inventory.reservations WHERE expires_at>clock_timestamp()",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stock, 0);
}
#[sqlx::test(migrations = "../../migrations")]
async fn automatic_routing_and_admin_scheduling_guards_are_authoritative(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let hold = scheduled_hold(&f).await;
    policy(&f,json!({"admin_manual_scheduling_enabled":false,"automatic_source_routing_enabled":false,"customer_delivery_slot_selection_enabled":false})).await;
    let svc = domain_fulfillment::capacity::Service { pool: pool.clone() };
    let schedule: domain_fulfillment::scheduling::Schedule =
        sqlx::query_as("SELECT * FROM fulfillment.schedules WHERE id=$1")
            .bind(hold.schedule_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(svc
        .save_schedule(schedule, "Should be disabled", &f.admin)
        .await
        .is_err());
    let mut request = domain_fulfillment::plans::Request {
        method: "delivery".into(),
        location_id: Some(f.location),
        source_id: None,
        date: hold.starts_at.date_naive(),
        asap: false,
    };
    assert!(
        domain_fulfillment::plans::options(&pool, f.customer, request.clone())
            .await
            .is_err()
    );
    request.source_id = Some(Uuid::from_u128(1));
    // Server chooses the first window; no customer-supplied window is required.
    let plan = plan_hold(&f, request, vec![]).await;
    assert_eq!(plan["groups"].as_array().unwrap().len(), 1);
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    f.app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .unwrap();
}
#[sqlx::test(migrations = "../../migrations")]
async fn pickup_basket_and_checkout_ignore_delivery_polygons(pool: PgPool) {
    let f = setup(pool.clone()).await;
    pickup_policy(&f, false, false).await;
    policy(
        &f,
        json!({"pickup_enabled":true,"geo_fencing_enabled":true}),
    )
    .await;
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km) VALUES($1,'Remote',10,10,1)").bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM customers.customer_locations WHERE customer_id=$1")
        .bind(f.customer)
        .execute(&pool)
        .await
        .unwrap();
    f.app
        .cart
        .set(Some(f.customer), "", f.product.clone(), 3, false)
        .await
        .unwrap();
    plan_hold(&f, asap_request(None, Some(Uuid::from_u128(1))), vec![]).await;
    let q = f.app.cart.quote(f.customer, Uuid::nil()).await.unwrap();
    f.app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .unwrap();
}
#[sqlx::test(migrations = "../../migrations")]
async fn fulfillment_plan_upgrade_preserves_existing_cart_order_and_allocation(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let before = f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .unwrap();
    // Reconstruct the immediately preceding schema around real legacy order data.
    sqlx::raw_sql(r#"
        ALTER TABLE fulfillment.capacity_reservations DROP COLUMN group_id;
        ALTER TABLE fulfillment.capacity_reservations ALTER COLUMN schedule_id SET NOT NULL;
        CREATE UNIQUE INDEX capacity_one_cart_hold ON fulfillment.capacity_reservations(cart_id) WHERE status='HELD';
        ALTER TABLE cart_checkout.carts DROP COLUMN fulfillment_store_id;
        DROP FUNCTION fulfillment.cart_geofencing(uuid),fulfillment.geofencing(uuid),fulfillment.default_store();
        DROP TABLE fulfillment.branch_creation_receipts;
        DROP TABLE fulfillment.plan_items,fulfillment.plan_groups,fulfillment.plans,fulfillment.store_sources,fulfillment.stores,fulfillment.system_capabilities;
        ALTER TABLE fulfillment.shipments DROP COLUMN method;
        ALTER TABLE fulfillment.shipments RENAME CONSTRAINT shipments_status_check TO shipment_status;
    "#).execute(&pool).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../migrations/20260922160000_fulfillment_plans.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    // This test changes result-column layouts underneath an existing pool.
    // Reconnect as the application does after a migration so SQLx cannot reuse
    // prepared SELECT * statements from the pre-upgrade schema.
    let upgraded_pool = PgPool::connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    let after = domain_orders::Service {
        pool: upgraded_pool,
    }
    .detail(before.order.id, Some(f.customer))
    .await
    .unwrap();
    assert_eq!(json!(before), json!(after));
    let assigned:bool=sqlx::query_scalar("SELECT c.fulfillment_store_id=s.id FROM cart_checkout.carts c CROSS JOIN fulfillment.stores s WHERE s.is_default AND c.customer_id=$1").bind(f.customer).fetch_one(&pool).await.unwrap();
    assert!(assigned);
}
#[sqlx::test(migrations = "../../migrations")]
async fn asap_pickup_honors_operating_cutoff_without_enabling_delivery_scheduling(pool: PgPool) {
    use chrono::Datelike;
    let f = setup(pool.clone()).await;
    pickup_policy(&f, false, false).await;
    let date = chrono::Utc::now().date_naive();
    let schedule = domain_fulfillment::scheduling::Schedule {
        entity_id: 0,
        id: Uuid::new_v4(),
        source_id: Uuid::from_u128(1),
        area_id: None,
        method: "pickup".into(),
        enabled: true,
        timezone: "UTC".into(),
        config: json!({"windows":[{"weekday":date.weekday().num_days_from_monday(),"start":"00:00:00","end":"23:59:00","cutoff":null}],"duration_minutes":60,"spacing_minutes":0,"lead_minutes":30,"cutoff":"00:00:00","min_days":0,"max_days":14,"ttl_minutes":10,"release_before":"fulfilling","exceptions":[]}),
    };
    domain_fulfillment::capacity::Service { pool: pool.clone() }
        .save_schedule(schedule, "Daily pickup cutoff", &f.admin)
        .await
        .unwrap();
    let availability = domain_fulfillment::plans::availability(&pool, f.customer)
        .await
        .unwrap();
    assert_eq!(
        availability["capabilities"]["scheduled_delivery_enabled"],
        false
    );
    assert!(availability["methods"][1]["locations"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(domain_fulfillment::plans::options(
        &pool,
        f.customer,
        asap_request(None, Some(Uuid::from_u128(1)))
    )
    .await
    .is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn enabling_capacity_accounts_for_previously_unlimited_confirmed_groups(pool: PgPool) {
    let f = setup(pool.clone()).await;
    pickup_policy(&f, false, false).await;
    let r = asap_request(None, Some(Uuid::from_u128(1)));
    plan_hold(&f, r.clone(), vec![]).await;
    let q = f.app.cart.quote(f.customer, Uuid::nil()).await.unwrap();
    f.app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .unwrap();
    assert_eq!(count(&pool, "fulfillment.capacity_reservations").await, 0);
    policy(&f,json!({"pickup_enabled":true,"capacity_management_enabled":true,"checkout_capacity_holds_enabled":true})).await;
    assert_eq!(count(&pool, "fulfillment.capacity_reservations").await, 1);
    sqlx::query("INSERT INTO fulfillment.capacity_rules(id,source_id,method,period,limits) VALUES($1,$2,'pickup','day','{\"orders\":1}')").bind(Uuid::new_v4()).bind(Uuid::from_u128(1)).execute(&pool).await.unwrap();
    f.app
        .cart
        .set(Some(f.customer), "", f.product.clone(), 2, false)
        .await
        .unwrap();
    assert!(domain_fulfillment::plans::reserve(
        &pool,
        f.customer,
        domain_fulfillment::plans::Selection {
            request: r,
            windows: vec![],
            idempotency_key: Uuid::new_v4()
        }
    )
    .await
    .is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn scheduled_plan_routes_to_an_open_alternative_source(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let held = scheduled_hold(&f).await;
    let source = Uuid::from_u128(2);
    sqlx::query("INSERT INTO inventory.inventory_sources(id,code,name) VALUES($1,'alternate','Alternative')").bind(source).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.source_stock_links(source_id,stock_id,priority) SELECT $1,id,2 FROM inventory.stocks WHERE is_default").bind(source).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO inventory.source_items(source_id,product_id,quantity) VALUES($1,$2,10)",
    )
    .bind(source)
    .bind(f.product.id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO fulfillment.schedules(id,source_id,method,enabled,timezone,config) SELECT $1,$2,method,true,timezone,config FROM fulfillment.schedules WHERE id=$3").bind(Uuid::new_v4()).bind(source).bind(held.schedule_id).execute(&pool).await.unwrap();
    sqlx::query("UPDATE fulfillment.schedules SET enabled=false WHERE id=$1")
        .bind(held.schedule_id)
        .execute(&pool)
        .await
        .unwrap();
    policy(&f, json!({"multi_source_fulfillment_enabled":false})).await;
    let r = domain_fulfillment::plans::Request {
        method: "delivery".into(),
        location_id: Some(f.location),
        source_id: None,
        date: held.starts_at.date_naive(),
        asap: false,
    };
    let opts = domain_fulfillment::plans::options(&pool, f.customer, r.clone())
        .await
        .unwrap();
    assert_eq!(opts.groups[0].source_id, source);
    plan_hold(&f, r, first_windows(&opts)).await;
    // Mobile checkout sends its selected address on the next cart refresh.
    // This must preserve the source admitted by the scheduled plan.
    for _ in 0..3 {
        f.app.cart.open(Some(f.customer), "").await.unwrap();
        f.app
            .cart
            .set_delivery(
                Some(f.customer),
                "",
                Some(domain_inventory::areas::Pin {
                    latitude: 30.0,
                    longitude: 31.0,
                }),
            )
            .await
            .unwrap();
        f.app.cart.quote(f.customer, f.location).await.unwrap();
    }
}
#[sqlx::test(migrations = "../../migrations")]
async fn pickup_only_store_omits_delivery_from_checkout_and_assistant_context(pool: PgPool) {
    let f = setup(pool.clone()).await;
    pickup_policy(&f, false, false).await;
    policy(
        &f,
        json!({"delivery_enabled":false,"pickup_enabled":true,"asap_delivery_enabled":false}),
    )
    .await;
    let availability = domain_fulfillment::plans::availability(&pool, f.customer)
        .await
        .unwrap();
    assert_eq!(availability["methods"].as_array().unwrap().len(), 1);
    assert_eq!(availability["methods"][0]["type"], "pickup");
    let delivery =
        domain_fulfillment::plans::options(&pool, f.customer, asap_request(Some(f.location), None))
            .await;
    assert!(
        matches!(delivery,Err(infra_auth::Error::Invalid(code)) if code=="FULFILLMENT_CAPABILITY_DISABLED:delivery")
    );
    let cart: Uuid = sqlx::query_scalar("SELECT id FROM cart_checkout.carts WHERE customer_id=$1")
        .bind(f.customer)
        .fetch_one(&pool)
        .await
        .unwrap();
    let context = f
        .app
        .cart
        .shopping_context(cart, Some(f.customer), Uuid::new_v4())
        .await
        .unwrap();
    assert_eq!(
        context["fulfillment_capabilities"]["delivery_enabled"],
        false
    );
    assert_eq!(
        context["fulfillment_availability"]["methods"][0]["type"],
        "pickup"
    );
    assert_eq!(context["delivery_slots_available"], false);
}

#[sqlx::test(migrations = "../../migrations")]
async fn assistant_reorder_is_atomic_idempotent_and_preserves_current_cart(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let original = f
        .app
        .cart
        .place(f.customer, quote.id, Uuid::new_v4())
        .await
        .unwrap();
    f.app
        .cart
        .set(Some(f.customer), "", f.product.clone(), 1, true)
        .await
        .unwrap();
    let key = Uuid::new_v4();
    let (a, b) = tokio::join!(
        f.app
            .cart
            .reorder_number(f.customer, original.order.number, key),
        f.app
            .cart
            .reorder_number(f.customer, original.order.number, key)
    );
    let new = a.unwrap();
    assert_eq!(new.order.id, b.unwrap().order.id);
    assert_ne!(new.order.number, original.order.number);
    assert_eq!(new.items[0].quantity, 2);
    assert_eq!(new.payment.method, "cod");
    assert_eq!(new.order.total, original.order.total);
    assert_eq!(count(&pool, "orders.orders").await, 2);
    assert_eq!(count(&pool, "payments.payment_transactions").await, 2);
    assert_eq!(
        f.app
            .cart
            .inventory
            .stock(f.product.id)
            .await
            .unwrap()
            .on_hand,
        6
    );
    let cart = f.app.cart.read_customer(f.customer).await.unwrap().unwrap();
    assert_eq!(cart.items.len(), 1);
    assert_eq!(cart.items[0].quantity, 1);
    assert_eq!(cart.items[0].reserved_quantity, 1);
    let source: Uuid = sqlx::query_scalar("SELECT reordered_from FROM orders.orders WHERE id=$1")
        .bind(new.order.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(source, original.order.id);
    assert!(f
        .app
        .cart
        .reorder_number(f.customer, new.order.number, key)
        .await
        .is_err());
}

#[sqlx::test(migrations = "../../migrations")]
async fn assistant_reorder_failures_leave_no_partial_order_or_stock_changes(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let original = f
        .app
        .cart
        .place(f.customer, quote.id, Uuid::new_v4())
        .await
        .unwrap();
    let carts = count(&pool, "cart_checkout.carts").await;
    let quotes = count(&pool, "cart_checkout.quotes").await;
    assert!(f
        .app
        .cart
        .reorder_number(Uuid::new_v4(), original.order.number, Uuid::new_v4())
        .await
        .is_err());
    sqlx::query("UPDATE catalog.products SET price=price+10 WHERE id=$1")
        .bind(f.product.id)
        .execute(&pool)
        .await
        .unwrap();
    let e = f
        .app
        .cart
        .reorder_number(f.customer, original.order.number, Uuid::new_v4())
        .await
        .err()
        .unwrap();
    assert!(e.to_string().contains("REORDER_PRICE_CHANGED"), "{e}");
    sqlx::query("UPDATE catalog.products SET price=1.20 WHERE id=$1")
        .bind(f.product.id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE customers.customer_locations SET apartment='changed' WHERE id=$1")
        .bind(f.location)
        .execute(&pool)
        .await
        .unwrap();
    assert!(f
        .app
        .cart
        .reorder_number(f.customer, original.order.number, Uuid::new_v4())
        .await
        .err()
        .unwrap()
        .to_string()
        .contains("REORDER_ADDRESS_CHANGED"));
    sqlx::query("UPDATE customers.customer_locations SET apartment='' WHERE id=$1")
        .bind(f.location)
        .execute(&pool)
        .await
        .unwrap();
    f.app
        .cart
        .inventory
        .adjust(
            f.product.id,
            1,
            f.admin.user.id,
            "Test insufficient stock".into(),
        )
        .await
        .unwrap();
    assert!(f
        .app
        .cart
        .reorder_number(f.customer, original.order.number, Uuid::new_v4())
        .await
        .is_err());
    assert_eq!(count(&pool, "orders.orders").await, 1);
    assert_eq!(count(&pool, "payments.payment_transactions").await, 1);
    assert_eq!(count(&pool, "cart_checkout.carts").await, carts);
    assert_eq!(count(&pool, "cart_checkout.quotes").await, quotes);
    assert_eq!(count(&pool, "inventory.reservations").await, 0);
    assert_eq!(
        f.app
            .cart
            .inventory
            .stock(f.product.id)
            .await
            .unwrap()
            .on_hand,
        1
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn assistant_reorder_tool_requires_exact_scope_and_live_session(pool: PgPool) {
    use api_gateway::assistant;
    use std::sync::Arc;
    let f = setup(pool.clone()).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let old = f
        .app
        .cart
        .place(f.customer, quote.id, Uuid::new_v4())
        .await
        .unwrap();
    let a = assistant::App {
        identity: f.app.clone(),
        tenant: Uuid::new_v4(),
        signing: Arc::new(
            jsonwebtoken::EncodingKey::from_rsa_pem(support::assistant_private_key()).unwrap(),
        ),
        verifying: Arc::new(
            jsonwebtoken::DecodingKey::from_rsa_pem(support::assistant_public_key()).unwrap(),
        ),
        client: reqwest::Client::new(),
        slots: Arc::new(tokio::sync::Semaphore::new(8)),
    };
    let router = assistant::router(f.app.clone(), Some(a.clone()));
    let now = chrono::Utc::now().timestamp();
    let mut claims = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "assistant-tools".into(),
        tenant: a.tenant,
        sub: Some(f.customer),
        sid: Some(f.app.customers.security.decode(&f.token).unwrap().sid),
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: "order_status".into(),
    };
    let request = |c: &assistant::Claims, number: i64| {
        Request::post("/v1/assistant-tools/reorder")
            .header("authorization", format!("Bearer {}", a.sign(c).unwrap()))
            .header("x-commerce-request", "1")
            .header("content-type", "application/json")
            .body(Body::from(json!({"order_number":number}).to_string()))
            .unwrap()
    };
    assert_eq!(
        router
            .clone()
            .oneshot(request(&claims, old.order.number))
            .await
            .unwrap()
            .status(),
        403
    );
    claims.scope = format!("order_reorder:{}", old.order.number);
    assert_eq!(
        router
            .clone()
            .oneshot(request(&claims, old.order.number + 1))
            .await
            .unwrap()
            .status(),
        403
    );
    let original_sid = claims.sid;
    claims.sid = Some(Uuid::new_v4());
    assert!(!router
        .clone()
        .oneshot(request(&claims, old.order.number))
        .await
        .unwrap()
        .status()
        .is_success());
    claims.sid = original_sid;
    let response = router
        .clone()
        .oneshot(request(&claims, old.order.number))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let value: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_ne!(value["number"], json!(old.order.number));
    assert_eq!(value["status"], "placed");
    let repeated = router
        .oneshot(request(&claims, old.order.number))
        .await
        .unwrap();
    let repeated: Value =
        serde_json::from_slice(&repeated.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(value["id"], repeated["id"]);
    assert_eq!(count(&pool, "orders.orders").await, 2);
}

#[sqlx::test(migrations = "../../migrations")]
async fn assistant_reorder_rolls_back_after_late_payment_failure(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let old = f
        .app
        .cart
        .place(f.customer, quote.id, Uuid::new_v4())
        .await
        .unwrap();
    let carts = count(&pool, "cart_checkout.carts").await;
    let quotes = count(&pool, "cart_checkout.quotes").await;
    sqlx::raw_sql("CREATE FUNCTION payments.reject_test_payment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test payment failure'; END $$; CREATE TRIGGER reject_test_payment BEFORE INSERT ON payments.payment_transactions FOR EACH ROW EXECUTE FUNCTION payments.reject_test_payment();").execute(&pool).await.unwrap();
    assert!(f
        .app
        .cart
        .reorder_number(f.customer, old.order.number, Uuid::new_v4())
        .await
        .is_err());
    assert_eq!(count(&pool, "orders.orders").await, 1);
    assert_eq!(count(&pool, "payments.payment_transactions").await, 1);
    assert_eq!(count(&pool, "cart_checkout.carts").await, carts);
    assert_eq!(count(&pool, "cart_checkout.quotes").await, quotes);
    assert_eq!(count(&pool, "inventory.reservations").await, 0);
    assert_eq!(
        f.app
            .cart
            .inventory
            .stock(f.product.id)
            .await
            .unwrap()
            .on_hand,
        8
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn pre_identifier_checkout_review_and_receipt_remain_usable(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    assert!(quote.entity_id > 0);
    assert!(quote.snapshot.location["entity_id"].as_i64().unwrap() > 0);
    // An already-reviewed quote from the preceding release lacks only ID metadata.
    sqlx::query("UPDATE cart_checkout.quotes SET snapshot=jsonb_set(snapshot,'{location}',(snapshot->'location')-'entity_id') WHERE id=$1")
        .bind(quote.id).execute(&pool).await.unwrap();
    let detail = f
        .app
        .cart
        .place(f.customer, quote.id, Uuid::new_v4())
        .await
        .unwrap();
    assert!(detail.order.entity_id > 0);
    let mut legacy = json!(detail);
    legacy["order"].as_object_mut().unwrap().remove("entity_id");
    for shipment in legacy["shipments"].as_array_mut().unwrap() {
        shipment.as_object_mut().unwrap().remove("entity_id");
    }
    if let Some(dispatch) = legacy["dispatch"].as_object_mut() {
        if let Some(shipment) = dispatch.get_mut("shipment").and_then(Value::as_object_mut) {
            shipment.remove("entity_id");
        }
    }
    // Rehydrating old order receipts does not manufacture a numeric identifier.
    let restored: domain_orders::Detail = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(restored.order.entity_id, 0);
    assert_eq!(json!(restored), legacy);
}

async fn global_delivery_fixture(f: &Fixture) -> Uuid {
    let pool = &f.app.cart.pool;
    f.app.cart.clear(f.customer).await.unwrap();
    f.app
        .cart
        .set_delivery(
            Some(f.customer),
            "",
            Some(domain_inventory::areas::Pin {
                latitude: 51.5074,
                longitude: -0.1278,
            }),
        )
        .await
        .unwrap();
    f.app
        .cart
        .inventory
        .adjust(
            f.product.id,
            0,
            f.admin.user.id,
            "Use global stock only".into(),
        )
        .await
        .unwrap();
    let source = Uuid::new_v4();
    let stock = Uuid::new_v4();
    sqlx::query("INSERT INTO inventory.inventory_sources(id,code,name) VALUES($1,'world','Global warehouse')").bind(source).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.stocks(id,code,name,is_global) VALUES($1,'world','Global stock',true)").bind(stock).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.source_stock_links(source_id,stock_id) VALUES($1,$2)")
        .bind(source)
        .bind(stock)
        .execute(pool)
        .await
        .unwrap();
    // The same source linked twice must never double availability.
    sqlx::query("INSERT INTO inventory.stocks(id,code,name,is_global) VALUES($1,'world-duplicate','Shared global stock',true)").bind(Uuid::new_v4()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.source_stock_links(source_id,stock_id) SELECT $1,id FROM inventory.stocks WHERE code='world-duplicate'").bind(source).execute(pool).await.unwrap();
    f.app
        .cart
        .inventory
        .adjust_source(
            f.product.id,
            domain_inventory::msi::SourceItemInput {
                source_id: source,
                quantity: 5,
                status: "in_stock".into(),
                notify_stock_qty: 0,
                reason: "Global test stock".into(),
            },
            f.admin.user.id,
        )
        .await
        .unwrap();
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km) VALUES($1,'Cairo only',30,31,1)").bind(Uuid::new_v4()).execute(pool).await.unwrap();
    sqlx::query(
        "UPDATE customers.customer_locations SET latitude=51.5074,longitude=-0.1278 WHERE id=$1",
    )
    .bind(f.location)
    .execute(pool)
    .await
    .unwrap();
    source
}

#[sqlx::test(migrations = "../../migrations")]
async fn global_delivery_toggle_reserves_global_stock_and_revalidates_checkout(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let source = global_delivery_fixture(&f).await;
    assert!(
        !f.app
            .cart
            .inventory
            .delivery(Some(domain_inventory::areas::Pin {
                latitude: 51.5074,
                longitude: -0.1278
            }))
            .await
            .unwrap()
            .deliverable
    );
    assert!(f
        .app
        .cart
        .set(Some(f.customer), "", f.product.clone(), 2, true)
        .await
        .is_err());
    policy(
        &f,
        json!({"global_delivery_enabled":true,"delivery_city_ids":["restricted-city"]}),
    )
    .await;
    let router = api_gateway::cart::router(f.app.clone());
    let response = router
        .oneshot(
            Request::builder()
                .uri("/v1/delivery-area")
                .header("x-delivery-latitude", "51.5074")
                .header("x-delivery-longitude", "-0.1278")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["deliverable"], true);
    assert_eq!(body["configured"], false);
    let cart = f
        .app
        .cart
        .set(Some(f.customer), "", f.product.clone(), 2, true)
        .await
        .unwrap();
    assert!(cart.fully_reserved);
    assert_eq!(cart.items[0].available, 5);
    let guest = f
        .app
        .cart
        .open(None, "")
        .await
        .unwrap()
        .guest_token
        .unwrap();
    assert!(
        f.app
            .cart
            .set(None, &guest, f.product.clone(), 4, true)
            .await
            .is_err(),
        "Other shoppers cannot reserve units already held"
    );
    let plan = plan_hold(&f, asap_request(Some(f.location), None), vec![]).await;
    assert_eq!(plan["groups"][0]["source_id"], json!(source));
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    policy(&f, json!({"global_delivery_enabled":false})).await;
    assert!(
        f.app
            .cart
            .place(f.customer, quote.id, Uuid::new_v4())
            .await
            .is_err(),
        "Disabling worldwide delivery must reject the old checkout"
    );
    assert!(domain_fulfillment::plans::options(
        &pool,
        f.customer,
        asap_request(Some(f.location), None)
    )
    .await
    .is_err());
    // City restrictions are also bypassed only while the global switch is on.
    policy(&f,json!({"global_delivery_enabled":false,"geo_fencing_enabled":false,"delivery_city_ids":["restricted-city"]})).await;
    assert!(domain_fulfillment::plans::options(
        &pool,
        f.customer,
        asap_request(Some(f.location), None)
    )
    .await
    .is_err());
    policy(&f,json!({"global_delivery_enabled":true,"geo_fencing_enabled":false,"delivery_city_ids":["restricted-city"]})).await;
    plan_hold(&f, asap_request(Some(f.location), None), vec![]).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    f.app
        .cart
        .place(f.customer, quote.id, Uuid::new_v4())
        .await
        .unwrap();
    let left: i32 = sqlx::query_scalar(
        "SELECT quantity FROM inventory.source_items WHERE source_id=$1 AND product_id=$2",
    )
    .bind(source)
    .bind(f.product.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(left, 3);
}

#[sqlx::test(migrations = "../../migrations")]
async fn global_delivery_scheduling_uses_global_source_and_keeps_capacity_limits(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let original = scheduled_hold(&f).await;
    let source = global_delivery_fixture(&f).await;
    sqlx::query("UPDATE fulfillment.schedules SET source_id=$1 WHERE id=$2")
        .bind(source)
        .bind(original.schedule_id)
        .execute(&pool)
        .await
        .unwrap();
    policy(&f, json!({"global_delivery_enabled":true})).await;
    f.app
        .cart
        .set(Some(f.customer), "", f.product.clone(), 2, true)
        .await
        .unwrap();
    let service = domain_fulfillment::capacity::Service { pool: pool.clone() };
    let rule = Uuid::new_v4();
    sqlx::query("INSERT INTO fulfillment.capacity_rules(id,source_id,period,limits) VALUES($1,$2,'slot',$3)").bind(rule).bind(source).bind(json!({"orders":0})).execute(&pool).await.unwrap();
    assert!(service
        .options(f.customer, f.location, original.starts_at.date_naive())
        .await
        .unwrap()
        .iter()
        .all(|s| s.availability != "AVAILABLE"));
    let cart: Uuid = sqlx::query_scalar("SELECT id FROM cart_checkout.carts WHERE customer_id=$1")
        .bind(f.customer)
        .fetch_one(&pool)
        .await
        .unwrap();
    for (limit, expected) in [(0, false), (2, true)] {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("UPDATE fulfillment.capacity_rules SET limits=$2 WHERE id=$1")
            .bind(rule)
            .bind(json!({"orders":limit}))
            .execute(&mut *tx)
            .await
            .unwrap();
        let check = domain_fulfillment::market_delivery::check(
            &mut tx,
            cart,
            Some(f.customer),
            Some(f.location),
            &std::collections::BTreeMap::from([(f.product.id, 2)]),
            &original.starts_at.date_naive().to_string(),
        )
        .await
        .unwrap();
        assert_eq!(check.available, expected);
        tx.commit().await.unwrap();
    }
    let options = service
        .options(f.customer, f.location, original.starts_at.date_naive())
        .await
        .unwrap();
    assert!(!options.is_empty());
    assert_eq!(options[0].source_id, source);
    let request = domain_fulfillment::plans::Request {
        asap: false,
        date: original.starts_at.date_naive(),
        ..asap_request(Some(f.location), None)
    };
    let options = domain_fulfillment::plans::options(&pool, f.customer, request.clone())
        .await
        .unwrap();
    assert_eq!(options.groups[0].source_id, source);
    let slot = &options.groups[0].slots[0];
    let window = domain_fulfillment::plans::Window {
        source_id: slot.source_id,
        schedule_id: slot.schedule_id,
        starts_at: slot.starts_at,
        ends_at: slot.ends_at,
    };
    plan_hold(&f, request, vec![window]).await;
    assert!(f.app.cart.quote(f.customer, f.location).await.is_ok());
    policy(&f, json!({"global_delivery_enabled":false})).await;
    assert!(service
        .options(f.customer, f.location, original.starts_at.date_naive())
        .await
        .is_err());
}

#[sqlx::test(migrations = "../../migrations")]
async fn global_delivery_policy_inheritance_and_store_override(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let store: Uuid = sqlx::query_scalar("SELECT id FROM fulfillment.stores WHERE is_default")
        .fetch_one(&pool)
        .await
        .unwrap();
    let mut tx = domain_inventory::begin(&pool).await.unwrap();
    assert!(!domain_fulfillment::capabilities::resolve(&mut tx, store)
        .await
        .unwrap()
        .global_delivery());
    domain_fulfillment::capabilities::save(
        &mut tx,
        None,
        json!({"global_delivery_enabled":true}),
        "Enable inherited global delivery",
        &f.admin,
    )
    .await
    .unwrap();
    assert!(domain_fulfillment::capabilities::resolve(&mut tx, store)
        .await
        .unwrap()
        .global_delivery());
    assert!(
        !sqlx::query_scalar::<_, bool>("SELECT fulfillment.geofencing($1)")
            .bind(store)
            .fetch_one(&mut *tx)
            .await
            .unwrap()
    );
    domain_fulfillment::capabilities::save(
        &mut tx,
        Some(store),
        json!({"global_delivery_enabled":false}),
        "Restrict this store",
        &f.admin,
    )
    .await
    .unwrap();
    assert!(!domain_fulfillment::capabilities::resolve(&mut tx, store)
        .await
        .unwrap()
        .global_delivery());
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT fulfillment.geofencing($1)")
            .bind(store)
            .fetch_one(&mut *tx)
            .await
            .unwrap()
    );
    let mut denied = f.admin;
    denied.permissions = vec!["fulfillment.settings.view".into()];
    assert!(domain_fulfillment::capabilities::save(
        &mut tx,
        Some(store),
        json!({"global_delivery_enabled":true}),
        "Not allowed",
        &denied
    )
    .await
    .is_err());
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn global_delivery_upgrade_keeps_preexisting_local_checkout_valid(pool: PgPool) {
    let f = setup(pool.clone()).await;
    policy(&f, json!({"geo_fencing_enabled":false})).await;
    let plan = plan_hold(&f, asap_request(Some(f.location), None), vec![]).await;
    let id: Uuid = serde_json::from_value(plan["id"].clone()).unwrap();
    sqlx::query("UPDATE fulfillment.plans SET capabilities=capabilities-'global_delivery_enabled' WHERE id=$1").bind(id).execute(&pool).await.unwrap();
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    f.app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn split_dispatch_events_cover_every_shipment_and_ignore_retries(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let request = split_fixture(&f).await;
    let options = domain_fulfillment::plans::options(&pool, f.customer, request.clone())
        .await
        .unwrap();
    plan_hold(&f, request, first_windows(&options)).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let detail = f
        .app
        .cart
        .place(f.customer, quote.id, Uuid::new_v4())
        .await
        .unwrap();
    let order = detail.order.id;
    assert_eq!(detail.shipments.len(), 2);
    let first = detail.shipments[0].shipment.id;
    let second = detail.shipments[1].shipment.id;
    let orders = domain_orders::Service { pool: pool.clone() };
    orders
        .transition(order, &f.admin, "confirmed", "Confirmed")
        .await
        .unwrap();
    orders
        .transition(order, &f.admin, "fulfilling", "Packed")
        .await
        .unwrap();
    let (one, two) = tokio::join!(
        orders.dispatch_shipment(
            order,
            Some(first),
            &f.admin,
            " FIRST-REF ",
            "First dispatch"
        ),
        orders.dispatch_shipment(
            order,
            Some(second),
            &f.admin,
            "SECOND-REF",
            "Second dispatch"
        ),
    );
    one.unwrap();
    two.unwrap();
    let events: Vec<(Uuid, String, Value)> = sqlx::query_as(
        "SELECT id,event_type,payload FROM platform.outbox WHERE event_type IN ('order.shipped','shipment.dispatched') ORDER BY event_type,payload->>'shipment_id'",
    ).fetch_all(&pool).await.unwrap();
    assert_eq!(events.len(), 3);
    let dispatches: Vec<_> = events
        .iter()
        .filter(|(_, kind, _)| kind == "shipment.dispatched")
        .collect();
    assert_eq!(dispatches.len(), 2);
    let aggregates: Vec<_> = events
        .iter()
        .filter(|(_, kind, _)| kind == "order.shipped")
        .collect();
    assert_eq!(aggregates.len(), 1);
    for (shipment, reference) in [(first, "FIRST-REF"), (second, "SECOND-REF")] {
        let notified_via_order_event = aggregates[0].2["shipment_id"] == json!(shipment);
        assert!(dispatches.iter().any(|(_, _, payload)| *payload
            == json!({"order_id":order,"shipment_id":shipment,"tracking_reference":reference,"notified_via_order_event":notified_via_order_event})));
        if notified_via_order_event {
            assert_eq!(
                aggregates[0].2,
                json!({"order_id":order,"shipment_id":shipment,"tracking_reference":reference})
            );
        }
    }
    assert_eq!(
        dispatches
            .iter()
            .filter(|(_, _, payload)| payload["notified_via_order_event"] == true)
            .count(),
        1
    );
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM orders.order_status_history WHERE order_id=$1 AND status='shipped'").bind(order).fetch_one(&pool).await.unwrap(),1);
    // Parallel request retries and an attempted reference change must not add
    // another event for either successful physical dispatch.
    let (one, two) = tokio::join!(
        orders.dispatch_shipment(order, Some(first), &f.admin, "FIRST-REF", "Retry first"),
        orders.dispatch_shipment(order, Some(second), &f.admin, "SECOND-REF", "Retry second"),
    );
    one.unwrap();
    two.unwrap();
    assert!(orders
        .dispatch_shipment(
            order,
            Some(second),
            &f.admin,
            "DIFFERENT",
            "Conflicting retry"
        )
        .await
        .is_err());
    let after: Vec<(Uuid, String, Value)> = sqlx::query_as(
        "SELECT id,event_type,payload FROM platform.outbox WHERE event_type IN ('order.shipped','shipment.dispatched') ORDER BY event_type,payload->>'shipment_id'",
    ).fetch_all(&pool).await.unwrap();
    assert_eq!(after, events);
}

#[sqlx::test(migrations = "../../migrations")]
async fn dispatch_event_failure_rolls_back_shipment_order_and_history(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let detail = f
        .app
        .cart
        .place(f.customer, quote.id, Uuid::new_v4())
        .await
        .unwrap();
    let order = detail.order.id;
    let orders = domain_orders::Service { pool: pool.clone() };
    orders
        .transition(order, &f.admin, "confirmed", "Confirmed")
        .await
        .unwrap();
    orders
        .transition(order, &f.admin, "fulfilling", "Packed")
        .await
        .unwrap();
    let before = json!(orders.detail(order, None).await.unwrap());
    let before_events = count(&pool, "platform.outbox").await;
    // Fail the aggregate event after shipment.dispatched was inserted: its
    // first-dispatch marker is safe only when the matching v1 event commits too.
    sqlx::raw_sql("CREATE FUNCTION platform.reject_dispatch_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Dispatch outbox failure fixture'; END $$; CREATE TRIGGER reject_dispatch_event BEFORE INSERT ON platform.outbox FOR EACH ROW WHEN (NEW.event_type='order.shipped') EXECUTE FUNCTION platform.reject_dispatch_event()")
        .execute(&pool).await.unwrap();
    assert!(orders
        .dispatch(order, &f.admin, "RETRY-REF", "Dispatch")
        .await
        .is_err());
    assert_eq!(json!(orders.detail(order, None).await.unwrap()), before);
    assert_eq!(count(&pool, "platform.outbox").await, before_events);
    sqlx::query("DROP TRIGGER reject_dispatch_event ON platform.outbox")
        .execute(&pool)
        .await
        .unwrap();
    orders
        .dispatch(order, &f.admin, "RETRY-REF", "Retry dispatch")
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM platform.outbox WHERE event_type='shipment.dispatched'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM platform.outbox WHERE event_type='order.shipped'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn idempotent_checkout_replay_keeps_status_and_history_in_one_snapshot(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let key = Uuid::new_v4();
    let placed = f.app.cart.place(f.customer, quote.id, key).await.unwrap();
    let order = placed.order.id;
    let expected = json!(&placed);
    let mut blocker = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE orders.order_items IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let blocker_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    let carts = f.app.cart.clone();
    let customer = f.customer;
    let quote_id = quote.id;
    let replay = tokio::spawn(async move { carts.place(customer, quote_id, key).await });
    // The detail reader fetches the order row first, then order_items. Waiting
    // for this exact table lock makes the lifecycle race deterministic.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT product_id,sku,%FROM orders.order_items WHERE order_id=%')")
                .bind(blocker_pid).fetch_one(&pool).await.unwrap();
            if blocked { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.expect("replay must reach its order-items read");
    sqlx::query(
        "UPDATE orders.orders SET status='confirmed',updated_at=clock_timestamp() WHERE id=$1",
    )
    .bind(order)
    .execute(&mut *blocker)
    .await
    .unwrap();
    domain_orders::history(
        &mut blocker,
        order,
        "confirmed",
        Some(f.admin.user.id),
        "Concurrent confirmation",
    )
    .await
    .unwrap();
    blocker.commit().await.unwrap();
    let replayed = tokio::time::timeout(std::time::Duration::from_secs(5), replay)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        json!(replayed),
        expected,
        "replay must not combine the placed order row with later confirmed history"
    );
    let current = domain_orders::Service { pool }
        .detail(order, Some(customer))
        .await
        .unwrap();
    assert_eq!(current.order.status, "confirmed");
    assert_eq!(current.history.len(), placed.history.len() + 1);
}
