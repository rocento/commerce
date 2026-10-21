use api_gateway::{identity, orders};
use axum::{
    body::{to_bytes, Body},
    http::Request,
    Router,
};
use serde_json::Value;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

async fn app(pool: &PgPool, permissions: Vec<&str>) -> Router {
    let security = infra_auth::Security::new(
        "geography-regression-".repeat(3),
        "http://localhost:5174".into(),
        false,
    )
    .await
    .unwrap();
    let role = Uuid::new_v4();
    let admin = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'geo-qa',$2)")
        .bind(role)
        .bind(permissions)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'geo@example.test','Geo QA','!',$2)").bind(admin).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest("geo-session")).bind(admin).execute(pool).await.unwrap();
    orders::router(identity::App::new(
        pool.clone(),
        security,
        vec!["http://localhost:5174".into()],
    ))
}
async fn get(app: &Router, path: &str, cookie: &str) -> (u16, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::get(path)
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), 2_000_000).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
const COOKIE: &str = "admin_session=geo-session";

#[sqlx::test(migrations = "../../migrations")]
async fn sales_page_reads_real_bestseller_seed_without_fabricating_payments(pool: PgPool) {
    sqlx::raw_sql("INSERT INTO catalog.categories(id,name,slug) VALUES(md5('geo-category')::uuid,'Geo','geo'); INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,active,in_stock) SELECT md5('geo-product-'||g)::uuid,'GEO-'||g,'geo-'||g,'Product '||g,'Test',10,'USD','each',md5('geo-category')::uuid,true,true FROM generate_series(1,8) g;").execute(&pool).await.unwrap();
    sqlx::raw_sql(include_str!("../../../../../commerce-assets/demo/seed-bestsellers.sql"))
        .execute(&pool)
        .await
        .unwrap();
    let app = app(&pool, vec!["orders.read"]).await;
    let (status, body) = get(&app, "/v1/admin/orders/sales?offset=0", COOKIE).await;
    assert_eq!(status, 200, "{body}");
    let rows = body.as_array().unwrap();
    assert_eq!(rows.len(), 8);
    assert_eq!(
        rows.iter()
            .map(|row| row["items"][0]["quantity"].as_i64().unwrap())
            .sum::<i64>(),
        180
    );
    assert!(rows
        .iter()
        .all(|row| row.get("payment").is_none() && row["items"][0]["price"] == "10.00"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM payments.payment_transactions")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn sales_page_is_bounded_ordered_and_preserves_unmapped_orders(pool: PgPool) {
    sqlx::raw_sql("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency,created_at) SELECT md5('geo-order-'||g)::uuid,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'delivered',CASE WHEN g%2=0 THEN '{\"latitude\":30,\"longitude\":31}'::jsonb ELSE '{}'::jsonb END,'{}',10,0,10,'USD','2026-01-01'::timestamptz+g*interval '1 minute' FROM generate_series(1,51) g; INSERT INTO orders.order_items(order_id,product_id,sku,name,unit,quantity,price,line_total) SELECT id,gen_random_uuid(),'GEO','Historical product','each',1,10,10 FROM orders.orders;").execute(&pool).await.unwrap();
    let app = app(&pool, vec!["orders.read"]).await;
    let (status, first) = get(&app, "/v1/admin/orders/sales", COOKIE).await;
    assert_eq!(status, 200);
    let (status, last) = get(&app, "/v1/admin/orders/sales?offset=50", COOKIE).await;
    assert_eq!(status, 200);
    let first = first.as_array().unwrap();
    let last = last.as_array().unwrap();
    assert_eq!(first.len(), 50);
    assert_eq!(last.len(), 1);
    assert_eq!(first[0]["order"]["created_at"], "2026-01-01T00:51:00Z");
    assert_eq!(last[0]["order"]["created_at"], "2026-01-01T00:01:00Z");
    assert!(first
        .iter()
        .all(|row| row["items"].as_array().unwrap().len() == 1));
    assert_eq!(
        first
            .iter()
            .filter(|row| row["order"]["location"].get("latitude").is_none())
            .count(),
        25
    );
    assert_eq!(
        get(&app, "/v1/admin/orders/sales?offset=51", COOKIE).await,
        (200, serde_json::json!([]))
    );
    for offset in ["-1", "1000001"] {
        assert_eq!(
            get(
                &app,
                &format!("/v1/admin/orders/sales?offset={offset}"),
                COOKIE
            )
            .await
            .0,
            400
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn sales_page_requires_order_read_permission(pool: PgPool) {
    let app = app(&pool, vec!["catalog.read"]).await;
    assert_eq!(get(&app, "/v1/admin/orders/sales", "").await.0, 401);
    assert_eq!(get(&app, "/v1/admin/orders/sales", COOKIE).await.0, 403);
}
