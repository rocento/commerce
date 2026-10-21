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

async fn send(app: &Router, method: &str, path: &str, body: Value) -> (u16, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("cookie", COOKIE)
                .header("content-type", "application/json")
                .header("x-commerce-request", "1")
                .body(Body::from(body.to_string()))
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
fn input(code: &str, state: &str) -> Value {
    serde_json::json!({"code":code,"state":state,"label":"Picking","translations":{"ar":"جارٍ التجهيز"},"description":"Warehouse progress","tone":"info","customer_visible":false,"is_default":false,"active":true,"expected_revision":0,"reason":"Configure warehouse workflow"})
}
#[sqlx::test(migrations = "../../migrations")]
async fn custom_labels_preserve_workflow_privacy_and_audit(pool: PgPool) {
    let app = app(&pool, vec!["*"]).await;
    let (status, defs) = get(&app, "/v1/admin/order-statuses", COOKIE).await;
    assert_eq!(status, 200);
    assert_eq!(defs.as_array().unwrap().len(), 10);
    let (status, custom) = send(
        &app,
        "POST",
        "/v1/admin/order-statuses",
        input("picking", "fulfilling"),
    )
    .await;
    assert_eq!(status, 200, "{custom}");
    let id = Uuid::new_v4();
    let customer = Uuid::new_v4();
    sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency) VALUES($1,$2,gen_random_uuid(),gen_random_uuid(),'fulfilling','{}','{}',10,0,10,'USD')").bind(id).bind(customer).execute(&pool).await.unwrap();
    let path = format!("/v1/admin/orders/{id}/status-label");
    let assign =
        serde_json::json!({"code":"picking","expected_revision":1,"reason":"Team started picking"});
    assert_eq!(send(&app, "POST", &path, assign.clone()).await.0, 200);
    assert_eq!(send(&app, "POST", &path, assign).await.0, 409);
    let service = domain_orders::Service { pool: pool.clone() };
    let admin = service.list(None, 0).await.unwrap();
    assert_eq!(admin[0].status, "fulfilling");
    assert_eq!(admin[0].status_display.as_ref().unwrap()["code"], "picking");
    let public = service.list(Some(customer), 0).await.unwrap();
    let json = serde_json::to_value(&public[0]).unwrap();
    assert_eq!(json["status_display"]["code"], "processing");
    assert!(!json.to_string().contains("picking"));
    assert_eq!(
        get(&app, &path, COOKIE).await.1.as_array().unwrap().len(),
        1
    );
    let wrong = serde_json::json!({"code":"complete","expected_revision":2,"reason":"Cannot bypass collection"});
    assert_eq!(send(&app, "POST", &path, wrong).await.0, 400);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM payments.payment_transactions")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    // Every writer of the existing engine state gets the new stage's default and revision.
    sqlx::query("UPDATE orders.orders SET status='shipped' WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let order = service.list(None, 0).await.unwrap();
    assert_eq!(order[0].status_display.as_ref().unwrap()["code"], "shipped");
    assert_eq!(order[0].status_revision, 3);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM admin_iam.audit_log WHERE action='admin.order.status_label_changed' AND entity_id=$1").bind(id).fetch_one(&pool).await.unwrap(),1);
    let history = get(&app, &path, COOKIE).await.1;
    assert_eq!(history[0]["previous_label"], "Processing");
    assert_eq!(history[0]["label"], "Picking");
    assert_eq!(history[0]["reason"], "Team started picking");
}
#[sqlx::test(migrations = "../../migrations")]
async fn defaults_archiving_and_optimistic_updates(pool: PgPool) {
    let app = app(&pool, vec!["*"]).await;
    let previous = Uuid::new_v4();
    sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency) VALUES($1,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'fulfilling','{}','{}',10,0,10,'USD')").bind(previous).execute(&pool).await.unwrap();
    let mut custom = input("warehouse", "fulfilling");
    custom["customer_visible"] = true.into();
    custom["is_default"] = true.into();
    let (status, saved) = send(&app, "POST", "/v1/admin/order-statuses", custom.clone()).await;
    assert_eq!(status, 200, "{saved}");
    let defs = get(&app, "/v1/admin/order-statuses", COOKIE).await.1;
    assert_eq!(
        defs.as_array()
            .unwrap()
            .iter()
            .filter(|d| d["state"] == "fulfilling" && d["is_default"] == true)
            .count(),
        1
    );
    assert_eq!(
        defs.as_array()
            .unwrap()
            .iter()
            .find(|d| d["code"] == "processing")
            .unwrap()["revision"],
        2
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status_code FROM orders.orders WHERE id=$1")
            .bind(previous)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "processing"
    );
    let future = Uuid::new_v4();
    sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency) VALUES($1,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'fulfilling','{}','{}',10,0,10,'USD')").bind(future).execute(&pool).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status_code FROM orders.orders WHERE id=$1")
            .bind(future)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "warehouse"
    );
    custom["expected_revision"] = 1.into();
    custom["active"] = false.into();
    assert_eq!(
        send(
            &app,
            "PUT",
            "/v1/admin/order-statuses/warehouse",
            custom.clone()
        )
        .await
        .0,
        400
    );
    custom["active"] = true.into();
    custom["is_default"] = false.into();
    assert_eq!(
        send(
            &app,
            "PUT",
            "/v1/admin/order-statuses/warehouse",
            custom.clone()
        )
        .await
        .0,
        400
    );
    custom["is_default"] = true.into();
    custom["expected_revision"] = 0.into();
    assert_eq!(
        send(
            &app,
            "PUT",
            "/v1/admin/order-statuses/warehouse",
            custom.clone()
        )
        .await
        .0,
        409
    );
    let mut built = input("processing", "fulfilling");
    built["expected_revision"] = 2.into();
    built["active"] = false.into();
    assert_eq!(
        send(
            &app,
            "PUT",
            "/v1/admin/order-statuses/processing",
            built.clone()
        )
        .await
        .0,
        400
    );
    built["active"] = true.into();
    built["is_default"] = true.into();
    built["customer_visible"] = true.into();
    assert_eq!(
        send(&app, "PUT", "/v1/admin/order-statuses/processing", built)
            .await
            .0,
        200
    );
    custom["expected_revision"] = 2.into();
    custom["is_default"] = false.into();
    custom["active"] = false.into();
    assert_eq!(
        send(&app, "PUT", "/v1/admin/order-statuses/warehouse", custom)
            .await
            .0,
        200
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn management_permission_does_not_grant_order_updates(pool: PgPool) {
    let app = app(&pool, vec!["orders.statuses.read"]).await;
    assert_eq!(get(&app, "/v1/admin/order-statuses", COOKIE).await.0, 200);
    assert_eq!(get(&app, "/v1/admin/order-statuses", "").await.0, 401);
    assert_eq!(
        send(
            &app,
            "POST",
            "/v1/admin/order-statuses",
            input("picking", "fulfilling")
        )
        .await
        .0,
        403
    );
    let path = format!("/v1/admin/orders/{}/status-label", Uuid::new_v4());
    assert_eq!(
        send(
            &app,
            "POST",
            &path,
            serde_json::json!({"code":"pending","expected_revision":1,"reason":"No permission"})
        )
        .await
        .0,
        403
    );
}
