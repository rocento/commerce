mod support;
use api_gateway::{identity, merchant};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use infra_auth::Security;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

async fn setup(pool: &PgPool) -> (Router, Uuid) {
    let security = Security::new(
        "merchant-test-secret-".repeat(3),
        "http://localhost:5174".into(),
        false,
    )
    .await
    .unwrap();
    let role = Uuid::new_v4();
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'merchant-test',ARRAY['reports.read','orders.read','catalog.read','inventory.read'])").bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'merchant@example.test','Merchant','!',$2)").bind(user).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest("merchant-test")).bind(user).execute(pool).await.unwrap();
    (
        merchant::router(identity::App::new(
            pool.clone(),
            security,
            vec!["http://localhost:5174".into()],
        )),
        role,
    )
}
fn input(question: &str) -> Value {
    let today = Utc::now().date_naive();
    json!({"question":question,"from":today.to_string(),"to":today.to_string(),"currency":"USD","scope":"installation","order_id":null,"stock_threshold":5,"sales_threshold":2})
}
async fn ask(router: &Router, data: Value, cookie: &str) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::post("/v1/admin/assistant/query")
                .header("content-type", "application/json")
                .header("x-commerce-request", "1")
                .header("cookie", cookie)
                .body(Body::from(data.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}
async fn product(pool: &PgPool, name: &str) -> Uuid {
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            domain_catalog::CategoryInput {
                name: name.into(),
                slug: name.to_lowercase(),
                parent_id: None,
            },
        )
        .await
        .unwrap();
    catalog.save_product(None,serde_json::from_value(json!({"sku":name,"slug":name.to_lowercase(),"name":name,"description":"fixture","price":"10","currency":"USD","unit":"each","category_id":category.id,"attributes":{},"media_ids":[],"active":true,"in_stock":true})).unwrap()).await.unwrap().id
}
async fn order(
    pool: &PgPool,
    p: Uuid,
    status: &str,
    days_ago: i64,
    quantity: i32,
    currency: &str,
) -> Uuid {
    let id = Uuid::new_v4();
    let at = (Utc::now().date_naive() - Duration::days(days_ago))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc();
    sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency,created_at) VALUES($1,$2,$3,$4,$5,'{}','{}',$6,0,$6,$7,$8)").bind(id).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(status).bind(quantity*10).bind(currency).bind(at).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO orders.order_items(order_id,product_id,sku,name,unit,quantity,price,line_total) VALUES($1,$2,'fixture','Name at sale','each',$3,10,$4)").bind(id).bind(p).bind(quantity).bind(quantity*10).execute(pool).await.unwrap();
    id
}
const COOKIE: &str = "admin_session=merchant-test";

#[sqlx::test(migrations = "../../migrations")]
async fn merchant_answers_match_order_values_statuses_currency_dates_and_refunds(pool: PgPool) {
    let (router, _) = setup(&pool).await;
    let p = product(&pool, "Shoes").await;
    let id = order(&pool, p, "cash_collected", 0, 3, "USD").await;
    order(&pool, p, "cancelled", 0, 20, "USD").await;
    order(&pool, p, "delivery_failed", 0, 10, "USD").await;
    order(&pool, p, "placed", 1, 12, "USD").await;
    order(&pool, p, "placed", 0, 15, "EUR").await;
    order(&pool, p, "placed", -1, 17, "USD").await;
    sqlx::query("UPDATE orders.order_items SET discount_amount=3 WHERE order_id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE orders.orders SET discount_amount=3,total=27 WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO payments.payment_transactions(order_id,method,amount_due,currency) VALUES($1,'cod',27,'USD')").bind(id).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO payments.manual_refunds(id,order_id,amount,reason,actor_id) VALUES($1,$2,5,'fixture',$3)").bind(Uuid::new_v4()).bind(id).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    let (status, result) = ask(&router, input("orders"), COOKIE).await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(
        result["rows"],
        json!([
            ["cancelled", "1", "200.00", "0", "200.00"],
            ["cash_collected", "1", "27.00", "5.00", "22.00"],
            ["delivery_failed", "1", "100.00", "0", "100.00"]
        ])
    );
    let (_, top) = ask(&router, input("top_sellers"), COOKIE).await;
    assert_eq!(
        top["rows"],
        json!([[p.to_string(), "Name at sale", "3", "27.00"]])
    );
    assert!(top["notes"].to_string().contains("not deducted"));
    let mut lookup = input("order_status");
    lookup["order_id"] = json!(id);
    let (status, detail) = ask(&router, lookup.clone(), COOKIE).await;
    assert_eq!(status, 200, "{detail}");
    assert_eq!(detail["rows"][0][2], "cash_collected");
    assert_eq!(detail["rows"][0][4], "27.00");
    assert!(!detail.to_string().contains("customer_id"));
    lookup["currency"] = json!("EUR");
    assert_eq!(ask(&router, lookup, COOKIE).await.1["rows"], json!([]));
    let contract: Value = serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &result,
        &contract["components"]["schemas"]["MerchantAnswer"],
        &contract,
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn merchant_inventory_uses_live_reservations_and_zero_sales_products(pool: PgPool) {
    let (router, _) = setup(&pool).await;
    let low = product(&pool, "Low").await;
    let high = product(&pool, "High").await;
    sqlx::query("INSERT INTO inventory.stock(product_id,on_hand) VALUES($1,8),($2,80) ON CONFLICT(product_id) DO UPDATE SET on_hand=EXCLUDED.on_hand").bind(low).bind(high).execute(&pool).await.unwrap();
    for (qty, hours) in [(5, 1), (100, -1)] {
        sqlx::query("INSERT INTO inventory.reservations(cart_id,product_id,quantity,expires_at) VALUES($1,$2,$3,now()+$4*interval '1 hour')").bind(Uuid::new_v4()).bind(low).bind(qty).bind(hours).execute(&pool).await.unwrap();
    }
    order(&pool, high, "cancelled", 0, 100, "USD").await;
    let (status, low_result) = ask(&router, input("low_stock"), COOKIE).await;
    assert_eq!(status, 200, "{low_result}");
    let stock = domain_inventory::Service {
        pool: pool.clone(),
        ttl_seconds: 900,
    }
    .stock(low)
    .await
    .unwrap();
    assert_eq!(low_result["rows"][0][5], stock.available.to_string());
    assert_eq!(low_result["rows"].as_array().unwrap().len(), 1);
    let mut query = input("slow_stock");
    query["stock_threshold"] = json!(50);
    let (status, slow) = ask(&router, query, COOKIE).await;
    assert_eq!(status, 200, "{slow}");
    assert_eq!(slow["rows"], json!([[high.to_string(), "High", "80", "0"]]));
}

#[sqlx::test(migrations = "../../migrations")]
async fn category_decline_compares_equal_periods_and_includes_disappearing_sales(pool: PgPool) {
    let (router, _) = setup(&pool).await;
    let p = product(&pool, "Declining").await;
    order(&pool, p, "delivered", 1, 10, "USD").await;
    order(&pool, p, "delivered", 0, 4, "USD").await;
    order(&pool, p, "cancelled", 0, 100, "USD").await;
    order(&pool, p, "delivered", 2, 50, "USD").await;
    let disappeared = product(&pool, "NoCurrentSales").await;
    order(&pool, disappeared, "delivered", 1, 8, "USD").await;
    let (status, result) = ask(&router, input("category_decline"), COOKIE).await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["rows"][0][1], "NoCurrentSales");
    assert_eq!(result["rows"][0][2], "80.00");
    assert_eq!(result["rows"][0][3], "0");
    assert_eq!(result["rows"][1][2], "100.00");
    assert_eq!(result["rows"][1][3], "40.00");
    assert_eq!(result["rows"][1][4], "-60.00");
}

#[sqlx::test(migrations = "../../migrations")]
async fn merchant_permissions_revocation_scope_and_validation_are_enforced(pool: PgPool) {
    let (router, role) = setup(&pool).await;
    assert_eq!(ask(&router, input("orders"), "").await.0, 401);
    for (field, value) in [
        ("scope", json!("other-store")),
        ("currency", json!("USD' OR 1=1")),
        ("from", json!("1900-01-01")),
        ("to", json!("2099-01-01")),
        ("stock_threshold", json!(-1)),
        ("order_id", json!(Uuid::new_v4())),
    ] {
        let mut q = input("orders");
        q[field] = value;
        assert_eq!(ask(&router, q, COOKIE).await.0, 400, "{field}");
    }
    let mut q = input("orders");
    q["channel"] = json!("storefront");
    assert_eq!(ask(&router, q, COOKIE).await.0, 422);
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['reports.read'] WHERE id=$1")
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    for kind in ["order_status", "low_stock", "slow_stock"] {
        assert_eq!(ask(&router, input(kind), COOKIE).await.0, 403);
    }
    assert_eq!(ask(&router, input("orders"), COOKIE).await.0, 200);
    sqlx::query("UPDATE admin_iam.roles SET permissions='{}' WHERE id=$1")
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(ask(&router, input("orders"), COOKIE).await.0, 403);
    sqlx::query("UPDATE admin_iam.sessions SET expires_at=now()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(ask(&router, input("orders"), COOKIE).await.0, 401);
}

#[sqlx::test(migrations = "../../migrations")]
async fn merchant_bounds_lists_and_rejects_reversed_or_overlong_ranges(pool: PgPool) {
    let (router, _) = setup(&pool).await;
    for n in 0..21 {
        product(&pool, &format!("Stock{n:02}")).await;
    }
    let (status, result) = ask(&router, input("low_stock"), COOKIE).await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["rows"].as_array().unwrap().len(), 20);
    assert_eq!(result["truncated"], true);
    let today = Utc::now().date_naive();
    let mut q = input("orders");
    q["from"] = json!((today + Duration::days(1)).to_string());
    assert_eq!(ask(&router, q, COOKIE).await.0, 400);
    let mut q = input("orders");
    q["from"] = json!((today - Duration::days(366)).to_string());
    assert_eq!(ask(&router, q, COOKIE).await.0, 400);
    let mut q = input("orders");
    q["from"] = json!((today - Duration::days(365)).to_string());
    assert_eq!(ask(&router, q, COOKIE).await.0, 200);
    let response = router
        .oneshot(
            Request::post("/v1/admin/assistant/query")
                .header("content-type", "application/json")
                .header("cookie", COOKIE)
                .body(Body::from(input("orders").to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        403,
        "anti-CSRF header required even for read-only POST"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn merchant_history_feedback_and_request_replays_are_owned(pool: PgPool) {
    let (router, role) = setup(&pool).await;
    let mut q = input("orders");
    q["request_id"] = json!(Uuid::new_v4());
    q["conversation_id"] = json!(Uuid::new_v4());
    let (status, answer) = ask(&router, q.clone(), COOKIE).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(
        ask(&router, q.clone(), COOKIE).await.1["evaluated_at"],
        answer["evaluated_at"]
    );
    q["currency"] = json!("EUR");
    assert_eq!(ask(&router, q, COOKIE).await.0, 409);
    async fn history(router: &Router) -> Value {
        let r = router
            .clone()
            .oneshot(
                Request::get("/v1/admin/assistant/history")
                    .header("cookie", COOKIE)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }
    assert_eq!(history(&router).await.as_array().unwrap().len(), 1);
    for (id, status) in [
        (answer["request_id"].as_str().unwrap().to_string(), 200),
        (Uuid::new_v4().to_string(), 404),
    ] {
        let r = router
            .clone()
            .oneshot(
                Request::post("/v1/admin/assistant/feedback")
                    .header("cookie", COOKIE)
                    .header("x-commerce-request", "1")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"request_id":id,"helpful":true}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status(), status);
    }
    assert_eq!(history(&router).await[0]["helpful"], true);
    sqlx::query("UPDATE admin_iam.roles SET permissions='{}' WHERE id=$1")
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        history(&router).await,
        json!([]),
        "revoked report access hides old answers"
    );
}
