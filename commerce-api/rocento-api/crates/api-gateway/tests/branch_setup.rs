use api_gateway::identity::App;
use axum::{body::Body, http::Request, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;

use uuid::Uuid;
async fn request(
    router: &Router,
    method: &str,
    path: &str,
    body: Value,
    token: &str,
) -> (u16, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("x-commerce-request", "1")
                .header("cookie", format!("admin_session={token}"))
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn setup(pool: &PgPool) -> Router {
    let security = infra_auth::Security::new(
        "msi-test-secret-at-least-32-characters".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let app = App::new(pool.clone(), security, vec!["http://localhost:5173".into()]);
    let actor = Uuid::new_v4();
    let token = "m12-admin-test";
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'msi@example.test','MSI','unused',$2)").bind(actor).bind(domain_admin_iam::SUPER).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest(token)).bind(actor).execute(pool).await.unwrap();
    api_gateway::cart::router(app)
}
fn branch(id: Uuid, stock: Uuid) -> Value {
    json!({"id":id,"name":"Ismailia branch","reason":"Open branch",
        "branch":{"address":"Ismailia","delivery_enabled":true,"pickup_enabled":true,"stock_id":stock}})
}
async fn create(router: &Router, body: Value) -> (u16, Value) {
    request(
        router,
        "POST",
        "/v1/admin/fulfillment/stores",
        body,
        "m12-admin-test",
    )
    .await
}
#[sqlx::test(migrations = "../../migrations")]
async fn branch_concurrent_retries_and_changed_payload(pool: PgPool) {
    let router = setup(&pool).await;
    let id = Uuid::new_v4();
    let body = branch(id, Uuid::from_u128(1));
    let (first, second) =
        tokio::join!(create(&router, body.clone()), create(&router, body.clone()));
    assert_eq!(first.0, 200, "{first:?}");
    assert_eq!(second, first);
    assert_eq!(create(&router, body.clone()).await, first);
    let counts:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM fulfillment.store_sources WHERE store_id=$1), (SELECT count(*) FROM inventory.inventory_sources WHERE code=$2), (SELECT count(*) FROM fulfillment.branch_creation_receipts WHERE store_id=$1)")
        .bind(id).bind(format!("branch-{id}")).fetch_one(&pool).await.unwrap();
    assert_eq!(counts, (1, 1, 1));
    let linked:i64=sqlx::query_scalar("SELECT count(*) FROM inventory.source_stock_links l JOIN fulfillment.store_sources s ON s.source_id=l.source_id WHERE s.store_id=$1 AND l.stock_id=$2")
        .bind(id).bind(Uuid::from_u128(1)).fetch_one(&pool).await.unwrap();
    assert_eq!(linked, 1);
    let audits:i64=sqlx::query_scalar("SELECT count(*) FROM admin_iam.audit_log WHERE entity_id=$1 AND action='fulfillment.branch.created'").bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(audits, 1);
    let mut changed = body;
    changed["branch"]["pickup_enabled"] = json!(false);
    assert_ne!(create(&router, changed).await.0, 200);
    let pickup: bool = sqlx::query_scalar(
        "SELECT pickup_enabled FROM fulfillment.store_sources WHERE store_id=$1",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(pickup);
}
#[sqlx::test(migrations = "../../migrations")]
async fn branch_failure_rolls_back_and_corrected_request_can_retry(pool: PgPool) {
    let router = setup(&pool).await;
    let id = Uuid::new_v4();
    assert_ne!(create(&router, branch(id, Uuid::new_v4())).await.0, 200);
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fulfillment.stores WHERE id=$1)")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!exists);
    // Fail after source and stock link creation, to verify the entire transaction rolls back.
    sqlx::raw_sql("CREATE FUNCTION fulfillment.reject_branch_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test late failure'; END $$; CREATE TRIGGER reject_branch BEFORE INSERT ON fulfillment.branch_creation_receipts FOR EACH ROW EXECUTE FUNCTION fulfillment.reject_branch_receipt();").execute(&pool).await.unwrap();
    let body = branch(id, Uuid::from_u128(1));
    assert_ne!(create(&router, body.clone()).await.0, 200);
    let remaining:i64=sqlx::query_scalar("SELECT (SELECT count(*) FROM fulfillment.stores WHERE id=$1)+(SELECT count(*) FROM inventory.inventory_sources WHERE code=$2)+(SELECT count(*) FROM fulfillment.branch_creation_receipts WHERE store_id=$1)")
        .bind(id).bind(format!("branch-{id}")).fetch_one(&pool).await.unwrap();
    assert_eq!(remaining, 0);
    sqlx::query("DROP TRIGGER reject_branch ON fulfillment.branch_creation_receipts")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(create(&router, body).await.0, 200);
}

#[sqlx::test(migrations = "../../migrations")]
async fn branch_permissions_are_checked_on_creation_and_replay(pool: PgPool) {
    let router = setup(&pool).await;
    let id = Uuid::new_v4();
    let body = branch(id, Uuid::from_u128(1));
    assert_eq!(create(&router, body.clone()).await.0, 200);
    let role = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'Branch manager',ARRAY['fulfillment.settings.manage'])").bind(role).execute(&pool).await.unwrap();
    sqlx::query("UPDATE admin_iam.admin_users SET role_id=$1 WHERE email='msi@example.test'")
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(create(&router, body).await.0, 403);
    let second = Uuid::new_v4();
    assert_eq!(
        create(&router, branch(second, Uuid::from_u128(1))).await.0,
        403
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['fulfillment.settings.manage','inventory.write'] WHERE id=$1").bind(role).execute(&pool).await.unwrap();
    assert_eq!(
        create(&router, branch(second, Uuid::from_u128(1))).await.0,
        403
    );
    let mut delivery = branch(second, Uuid::from_u128(1));
    delivery["branch"]["pickup_enabled"] = json!(false);
    assert_eq!(create(&router, delivery).await.0, 200);
}
