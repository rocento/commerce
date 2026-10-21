use api_gateway::identity::App;
use axum::{body::Body, http::Request};
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

#[sqlx::test(migrations = "../../migrations")]
async fn editing_pickup_details_preserves_configuration_while_store_is_off(pool: PgPool) {
    let security = infra_auth::Security::new(
        "test-secret-at-least-32-characters-long".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let app = App::new(pool.clone(), security, vec!["http://localhost:5173".into()]);
    let admin = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'fulfillment@example.test','Operator','unused',$2)")
        .bind(admin).bind(domain_admin_iam::SUPER).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')")
        .bind(infra_auth::digest("fulfillment-test-session")).bind(admin).execute(&pool).await.unwrap();
    let store: Uuid = sqlx::query_scalar("SELECT id FROM fulfillment.stores WHERE is_default")
        .fetch_one(&pool)
        .await
        .unwrap();
    let source = Uuid::from_u128(1);
    sqlx::query("UPDATE fulfillment.stores SET capabilities=capabilities||'{\"pickup_enabled\":false}'::jsonb WHERE id=$1").bind(store).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO fulfillment.store_sources(store_id,source_id,pickup_enabled) VALUES($1,$2,true)").bind(store).bind(source).execute(&pool).await.unwrap();
    let router = api_gateway::capacity::routes().with_state(app);
    let body = json!({"store_id":store,"source_id":source,"pickup_enabled":true,"pickup_instructions":"Side entrance","preparation_minutes":45,"reason":"Entrance moved"});
    let request = |body: Value| {
        Request::builder()
            .method("POST")
            .uri("/v1/admin/fulfillment/store-sources")
            .header("content-type", "application/json")
            .header("cookie", "admin_session=fulfillment-test-session")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    assert!(router
        .clone()
        .oneshot(request(body.clone()))
        .await
        .unwrap()
        .status()
        .is_success());
    let saved: (bool, String, i32) = sqlx::query_as("SELECT pickup_enabled,pickup_instructions,preparation_minutes FROM fulfillment.store_sources WHERE store_id=$1 AND source_id=$2")
        .bind(store).bind(source).fetch_one(&pool).await.unwrap();
    assert_eq!(saved, (true, "Side entrance".into(), 45));
    let mut disabled = body.clone();
    disabled["pickup_enabled"] = json!(false);
    assert!(router
        .clone()
        .oneshot(request(disabled))
        .await
        .unwrap()
        .status()
        .is_success());
    // Preserving a configuration does not authorize activating pickup while the store is off.
    assert!(!router
        .oneshot(request(body))
        .await
        .unwrap()
        .status()
        .is_success());
    let enabled: bool = sqlx::query_scalar(
        "SELECT pickup_enabled FROM fulfillment.store_sources WHERE store_id=$1 AND source_id=$2",
    )
    .bind(store)
    .bind(source)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!enabled);
}
