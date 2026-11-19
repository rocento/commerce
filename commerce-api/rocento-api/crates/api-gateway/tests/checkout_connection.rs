//! Full HTTP checkout connection ownership and transaction-boundary regressions.
use api_gateway::identity::App;
use axum::{body::Body, http::Request, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tower::ServiceExt;
use uuid::Uuid;
struct Fixture {
    app: App,
    customer: Uuid,
    location: Uuid,
    product: domain_catalog::Product,
    token: String,
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
    }
}

async fn route(f: &Fixture) -> (Router, PgPool, Arc<AtomicUsize>) {
    let count = Arc::new(AtomicUsize::new(0));
    let observed = count.clone();
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(2))
        .before_acquire(move |_, _| {
            observed.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(true) })
        })
        .connect_with((*f.app.customers.pool.connect_options()).clone())
        .await
        .unwrap();
    drop(pool.acquire().await.unwrap());
    count.store(0, Ordering::SeqCst);
    let app = App::new(
        pool.clone(),
        f.app.customers.security.clone(),
        vec!["http://localhost:5173".into()],
    );
    (api_gateway::orders::router(app), pool, count)
}
async fn request(router: &Router, token: &str, quote: Uuid, key: Uuid) -> (u16, Value) {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/v1/customer/checkout/place")
        .header("content-type", "application/json")
        .header("x-commerce-request", "1");
    if !token.is_empty() {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let response = router
        .clone()
        .oneshot(
            builder
                .body(Body::from(
                    json!({"quote_id":quote,"idempotency_key":key}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn assert_rolled_back(pool: &PgPool, f: &Fixture, quote: Uuid) {
    let receipts: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.meta_checkout_consent WHERE quote_id=$1 AND NOT conversions AND NOT whatsapp")
        .bind(quote).fetch_one(pool).await.unwrap();
    assert_eq!(receipts, 1, "consent must remain independently committed");
    let orders: i64 = sqlx::query_scalar("SELECT count(*) FROM orders.orders")
        .fetch_one(pool)
        .await
        .unwrap();
    let payments: i64 = sqlx::query_scalar("SELECT count(*) FROM payments.payment_transactions")
        .fetch_one(pool)
        .await
        .unwrap();
    let events: i64 =
        sqlx::query_scalar("SELECT count(*) FROM platform.outbox WHERE event_type='order.placed'")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!((orders, payments, events), (0, 0, 0));
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
    let cart = f.app.cart.open(Some(f.customer), "").await.unwrap().cart;
    assert_eq!(cart.items[0].quantity, 2);
    assert!(cart.fully_reserved);
}
#[sqlx::test(migrations = "../../migrations")]
async fn fresh_checkout_acquires_once_and_replay_releases_before_detail(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap().id;
    let key = Uuid::new_v4();
    let (router, limited, count) = route(&f).await;
    let first = tokio::time::timeout(
        Duration::from_secs(5),
        request(&router, &f.token, quote, key),
    )
    .await
    .unwrap();
    assert_eq!(first.0, 200, "{:?}", first.1);
    let fresh = count.swap(0, Ordering::SeqCst);
    let replay = tokio::time::timeout(
        Duration::from_secs(5),
        request(&router, &f.token, quote, key),
    )
    .await
    .unwrap();
    assert_eq!(replay, first);
    let repeated = count.load(Ordering::SeqCst);
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
    limited.close().await;
    assert_eq!(
        (fresh, repeated),
        (1, 2),
        "fresh checkout enters once; replay releases before its independent detail snapshot"
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn invalid_tokens_precede_pool_wait_and_valid_tokens_recheck_live_authority(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap().id;
    let (router, limited, count) = route(&f).await;
    let mut claims = f.app.customers.security.decode(&f.token).unwrap();
    claims.exp = 1;
    let expired = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(f.app.customers.security.secret.as_bytes()),
    )
    .unwrap();
    let held = limited.acquire().await.unwrap();
    count.store(0, Ordering::SeqCst);
    for token in ["", "invalid", expired.as_str()] {
        let result = tokio::time::timeout(
            Duration::from_millis(250),
            request(&router, token, quote, Uuid::new_v4()),
        )
        .await
        .expect("invalid token waited for the exhausted pool");
        assert_eq!(result.0, 401);
    }
    assert_eq!(count.load(Ordering::SeqCst), 0);
    drop(held);
    for (sql,status) in [
        ("UPDATE customers.customers SET verified=false",403),
        ("UPDATE customers.customers SET verified=true,deletion_requested_at=now()",401),
        ("UPDATE customers.customers SET deletion_requested_at=NULL; UPDATE customers.sessions SET expires_at=now()-interval '1 hour'",401),
        ("UPDATE customers.sessions SET expires_at=now()+interval '1 hour'; DELETE FROM customers.sessions",401),
    ] {
        sqlx::raw_sql(sql).execute(&pool).await.unwrap();
        assert_eq!(request(&router,&f.token,quote,Uuid::new_v4()).await.0,status);
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM orders.orders")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM platform.meta_checkout_consent")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    limited.close().await;
}
#[sqlx::test(migrations = "../../migrations")]
async fn checkout_failure_preserves_consent_and_returns_a_clean_connection(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap().id;
    let (router, limited, count) = route(&f).await;
    sqlx::query(
        "ALTER TABLE payments.payment_transactions ADD CONSTRAINT test_failure CHECK(amount_due<0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        request(&router, &f.token, quote, Uuid::new_v4()).await.0,
        500
    );
    let failed_count = count.load(Ordering::SeqCst);
    // This acquisition waits for SQLx's asynchronous rollback before reuse.
    assert_eq!(
        sqlx::query_scalar::<_, i32>("SELECT 1")
            .fetch_one(&limited)
            .await
            .unwrap(),
        1
    );
    assert_rolled_back(&pool, &f, quote).await;
    sqlx::query("ALTER TABLE payments.payment_transactions DROP CONSTRAINT test_failure")
        .execute(&pool)
        .await
        .unwrap();
    count.store(0, Ordering::SeqCst);
    assert_eq!(
        request(&router, &f.token, quote, Uuid::new_v4()).await.0,
        200
    );
    assert_eq!((failed_count, count.load(Ordering::SeqCst)), (1, 1));
    limited.close().await;
}
#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_http_retries_create_one_order_and_consume_stock_once(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap().id;
    let (router, limited, _) = route(&f).await;
    let key = Uuid::new_v4();
    let (a, b) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(
            request(&router, &f.token, quote, key),
            request(&router, &f.token, quote, key)
        )
    })
    .await
    .unwrap();
    assert_eq!(a.0, 200);
    assert_eq!(a, b);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM orders.orders")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
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
    limited.close().await;
}
#[sqlx::test(migrations = "../../migrations")]
async fn cancelled_checkout_rolls_back_and_releases_owned_connection(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap().id;
    let (router, limited, count) = route(&f).await;
    sqlx::raw_sql("CREATE FUNCTION payments.test_block() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(983217); RETURN NEW; END $$; CREATE TRIGGER test_block BEFORE INSERT ON payments.payment_transactions FOR EACH ROW EXECUTE FUNCTION payments.test_block();").execute(&pool).await.unwrap();
    let mut blocker = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(983217)")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let task_router = router.clone();
    let token = f.token.clone();
    let task =
        tokio::spawn(async move { request(&task_router, &token, quote, Uuid::new_v4()).await });
    tokio::time::timeout(Duration::from_secs(1),async {
        loop {
            let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE 'INSERT INTO payments.payment_transactions%')").fetch_one(&pool).await.unwrap();
            if waiting {break;} tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("checkout did not reach the late payment block");
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    blocker.rollback().await.unwrap();
    assert_eq!(
        tokio::time::timeout(
            Duration::from_secs(3),
            sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&limited)
        )
        .await
        .unwrap()
        .unwrap(),
        1
    );
    assert_rolled_back(&pool, &f, quote).await;
    sqlx::raw_sql("DROP TRIGGER test_block ON payments.payment_transactions; DROP FUNCTION payments.test_block();").execute(&pool).await.unwrap();
    count.store(0, Ordering::SeqCst);
    assert_eq!(
        request(&router, &f.token, quote, Uuid::new_v4()).await.0,
        200
    );
    assert_eq!(count.load(Ordering::SeqCst), 1);
    limited.close().await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn foreign_quote_and_mismatched_idempotency_are_rejected(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap().id;
    let (router, limited, _) = route(&f).await;
    let foreign = Uuid::new_v4();
    let session = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash,verified) VALUES($1,$2,'email','!',true)").bind(foreign).bind(format!("{foreign}@example.test")).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO customers.sessions(id,customer_id,refresh_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(session).bind(foreign).bind(session.to_string()).execute(&pool).await.unwrap();
    let foreign_token = f
        .app
        .customers
        .security
        .access_token(foreign, session)
        .unwrap();
    assert_eq!(
        request(&router, &foreign_token, quote, Uuid::new_v4())
            .await
            .0,
        404
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM platform.meta_checkout_consent")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    let key = Uuid::new_v4();
    assert_eq!(request(&router, &f.token, quote, key).await.0, 200);
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO cart_checkout.quotes(id,customer_id,cart_id,location_id,snapshot,expires_at) SELECT $1,customer_id,cart_id,location_id,snapshot,expires_at FROM cart_checkout.quotes WHERE id=$2").bind(other).bind(quote).execute(&pool).await.unwrap();
    assert_eq!(request(&router, &f.token, other, key).await.0, 400);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM orders.orders")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
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
    limited.close().await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn order_insert_preserves_gift_market_status_and_durable_receipts(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let (router, limited, _) = route(&f).await;
    sqlx::raw_sql("CREATE TABLE orders.test_insert_observations(order_id uuid,operation text,gift text,market jsonb); CREATE FUNCTION orders.test_observe_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO orders.test_insert_observations VALUES(NEW.id,TG_OP,NEW.gift_message,NEW.market_context); RETURN NEW; END $$; CREATE TRIGGER test_observe_insert AFTER INSERT OR UPDATE ON orders.orders FOR EACH ROW EXECUTE FUNCTION orders.test_observe_insert();").execute(&pool).await.unwrap();
    for gift in [None, Some("Happy birthday — مرحباً".to_owned())] {
        f.app
            .cart
            .set(Some(f.customer), "", f.product.clone(), 2, false)
            .await
            .unwrap();
        let quote = f
            .app
            .cart
            .quote_with_gift(f.customer, f.location, gift.clone())
            .await
            .unwrap();
        let expected_market = json!(quote.snapshot.market);
        let key = Uuid::new_v4();
        let first = request(&router, &f.token, quote.id, key).await;
        assert_eq!(first.0, 200, "{:?}", first.1);
        assert_eq!(request(&router, &f.token, quote.id, key).await, first);
        let id: Uuid = serde_json::from_value(first.1["order"]["id"].clone()).unwrap();
        let stored:(Option<String>,Option<Value>,i64,bool)=sqlx::query_as("SELECT gift_message,market_context,status_revision,status_code=(SELECT code FROM orders.status_definitions WHERE state='placed' AND is_default) FROM orders.orders WHERE id=$1").bind(id).fetch_one(&pool).await.unwrap();
        assert_eq!(
            stored,
            (gift.clone(), Some(expected_market.clone()), 1, true)
        );
        let observed: Vec<(String, Option<String>, Option<Value>)> = sqlx::query_as(
            "SELECT operation,gift,market FROM orders.test_insert_observations WHERE order_id=$1",
        )
        .bind(id)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            observed,
            vec![("INSERT".into(), gift, Some(expected_market))]
        );
        let receipts:Value=sqlx::query_scalar("SELECT jsonb_build_object('history',(SELECT count(*) FROM orders.order_status_history WHERE order_id=$1),'events',(SELECT count(*) FROM platform.outbox WHERE event_type='order.placed' AND payload->>'order_id'=$1::text),'allocations',(SELECT sum(quantity) FROM inventory.order_allocations WHERE order_id=$1),'payments',(SELECT count(*) FROM payments.payment_transactions p JOIN orders.orders o ON o.id=p.order_id WHERE o.id=$1 AND p.amount_due=o.total AND p.currency=o.currency))").bind(id).fetch_one(&pool).await.unwrap();
        assert_eq!(
            receipts,
            json!({"history":1,"events":1,"allocations":2,"payments":1})
        );
        // Historical SQL NULL is a persisted receipt shape, never a new checkout input.
        sqlx::query("UPDATE orders.orders SET market_context=NULL WHERE id=$1")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        let replay = request(&router, &f.token, quote.id, key).await;
        assert_eq!(replay.0, 200);
        assert!(replay.1["order"]["market_context"].is_null());
        assert_eq!(replay.1["order"]["id"], first.1["order"]["id"]);
        assert!(sqlx::query_scalar::<_, bool>(
            "SELECT market_context IS NULL FROM orders.orders WHERE id=$1"
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap());
    }
    limited.close().await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn direct_placement_keeps_deleted_owner_guard(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let quote = f
        .app
        .cart
        .quote_with_gift(f.customer, f.location, Some("Do not place".into()))
        .await
        .unwrap();
    sqlx::query("UPDATE customers.customers SET deletion_requested_at=now() WHERE id=$1")
        .bind(f.customer)
        .execute(&pool)
        .await
        .unwrap();
    assert!(f
        .app
        .cart
        .place(f.customer, quote.id, Uuid::new_v4())
        .await
        .is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM orders.orders")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
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
