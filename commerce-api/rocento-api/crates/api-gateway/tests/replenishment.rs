use api_gateway::{identity, replenishment};
use axum::{body::Body, http::Request, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

async fn fixture(pool: &PgPool) -> (Router, Uuid) {
    let security = infra_auth::Security::new(
        "replenishment-test-secret-at-least-32-characters".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let actor = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'planner@example.test','Planner','unused',$2)")
        .bind(actor).bind(domain_admin_iam::SUPER).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')")
        .bind(infra_auth::digest("planner-test-session")).bind(actor).execute(pool).await.unwrap();
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            domain_catalog::CategoryInput {
                name: "Planner".into(),
                slug: "planner".into(),
                parent_id: None,
            },
        )
        .await
        .unwrap();
    let input = serde_json::from_value(json!({"sku":"PLAN-1","slug":"planner-item","name":"Planner item","description":"Fixture","price":"2.00","currency":"USD","unit":"each","category_id":category.id,"attributes":{},"media_ids":[],"active":true,"in_stock":true})).unwrap();
    let product = catalog.save_product(None, input).await.unwrap();
    let app = replenishment::App {
        identity: identity::App::new(pool.clone(), security, vec!["http://localhost:5173".into()]),
        pool: pool.clone(),
    };
    (replenishment::router(app), product.id)
}

async fn save(router: &Router, product: Uuid, supplier: &str) -> (u16, Value) {
    let body = json!({"supplier":supplier,"planning_group":"A","lead_time_days":7,"target_cover_days":30,"safety_stock_days":3,"minimum_order_qty":1,"order_multiple":1,"enabled":true});
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/v1/admin/replenishment/{product}"))
                .header("content-type", "application/json")
                .header("x-commerce-request", "1")
                .header("cookie", "admin_session=planner-test-session")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[sqlx::test(migrations = "../../migrations")]
async fn policy_and_event_rollback_together(pool: PgPool) {
    let (router, product) = fixture(&pool).await;
    // Fail only policy events, inside the disposable test database.
    sqlx::query("ALTER TABLE platform.outbox ADD CONSTRAINT reject_policy_event CHECK (event_type <> 'inventory.replenishment_policy_updated')")
        .execute(&pool).await.unwrap();
    assert_eq!(save(&router, product, "Failed insert").await.0, 500);
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM inventory.replenishment_policies WHERE product_id=$1",
    )
    .bind(product)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 0, "failed event must roll back a new policy");

    sqlx::query("ALTER TABLE platform.outbox DROP CONSTRAINT reject_policy_event")
        .execute(&pool)
        .await
        .unwrap();
    let (status, saved) = save(&router, product, "Original").await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["supplier"], "Original");
    sqlx::query("ALTER TABLE platform.outbox ADD CONSTRAINT reject_policy_event CHECK (event_type <> 'inventory.replenishment_policy_updated') NOT VALID")
        .execute(&pool).await.unwrap();
    assert_eq!(save(&router, product, "Failed update").await.0, 500);
    let supplier: String = sqlx::query_scalar(
        "SELECT supplier FROM inventory.replenishment_policies WHERE product_id=$1",
    )
    .bind(product)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        supplier, "Original",
        "failed event must preserve the prior policy"
    );
    let events: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.outbox WHERE event_type='inventory.replenishment_policy_updated' AND payload->>'id'=$1")
        .bind(product.to_string()).fetch_one(&pool).await.unwrap();
    assert_eq!(events, 1, "only the successful save should emit an event");
}

async fn recommendations(router: &Router) -> Value {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/admin/replenishment")
                .header("cookie", "admin_session=planner-test-session")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn planner_rounds_minimum_order_up_to_pack_multiple(pool: PgPool) {
    let (router, product) = fixture(&pool).await;
    let no_sales = recommendations(&router).await;
    assert_eq!(no_sales[0]["replenishment_qty"], 0);
    assert!(no_sales[0]["days_of_stock"].is_null());
    let order = Uuid::new_v4();
    sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency) VALUES($1,$2,$3,$4,'delivered','{}','{}',60,0,60,'USD')")
        .bind(order).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO orders.order_items(order_id,product_id,sku,name,unit,quantity,price,line_total) VALUES($1,$2,'PLAN-1','Planner item','each',30,2,60)")
        .bind(order).bind(product).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.replenishment_policies(product_id,minimum_order_qty,order_multiple) VALUES($1,43,10)").bind(product).execute(&pool).await.unwrap();
    let rows = recommendations(&router).await;
    assert_eq!(rows[0]["sales_velocity"], 1.0);
    assert_eq!(
        rows[0]["replenishment_qty"], 50,
        "43 minimum must round up to five packs of ten"
    );
    sqlx::query("UPDATE inventory.replenishment_policies SET enabled=false WHERE product_id=$1")
        .bind(product)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(recommendations(&router).await[0]["replenishment_qty"], 0);
    sqlx::query("UPDATE inventory.replenishment_policies SET enabled=true WHERE product_id=$1")
        .bind(product)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE orders.orders SET status='cancelled' WHERE id=$1")
        .bind(order)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        recommendations(&router).await[0]["replenishment_qty"],
        0,
        "cancelled demand is excluded"
    );
}
