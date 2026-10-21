mod support;
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
#[sqlx::test(migrations = "../../migrations")]
async fn m12_admin_crud_permissions_and_contract(pool: PgPool) {
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
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'msi@example.test','MSI','unused',$2)").bind(actor).bind(domain_admin_iam::SUPER).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest(token)).bind(actor).execute(&pool).await.unwrap();
    let router = api_gateway::cart::router(app);
    assert_eq!(
        request(&router, "GET", "/v1/admin/inventory/sources", json!({}), "")
            .await
            .0,
        401
    );
    let body = json!({"code":"test-source","name":"Test source","is_enabled":true,"address":"Test address","latitude":30.0,"longitude":31.0,"contact_name":"Test","contact_phone":"","priority":10});
    let (status, source) =
        request(&router, "POST", "/v1/admin/inventory/sources", body, token).await;
    assert_eq!(status, 200, "{source}");
    let contract: Value = serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &source,
        &contract["components"]["schemas"]["InventorySource"],
        &contract,
    );
    let source_id = source["id"].as_str().unwrap();
    let (status,stock)=request(&router,"POST","/v1/admin/inventory/stocks",json!({"code":"test-stock","name":"Test pool","is_default":false,"sources":[{"source_id":source_id,"priority":5}]}),token).await;
    assert_eq!(status, 200, "{stock}");
    let (_, stocks) = request(
        &router,
        "GET",
        "/v1/admin/inventory/stocks",
        json!({}),
        token,
    )
    .await;
    for stock in stocks.as_array().unwrap() {
        support::validate_shape(
            stock,
            &contract["components"]["schemas"]["StockPool"],
            &contract,
        );
    }
    assert_eq!(
        request(
            &router,
            "DELETE",
            &format!(
                "/v1/admin/inventory/stocks/{}",
                stock["id"].as_str().unwrap()
            ),
            json!({}),
            token
        )
        .await
        .0,
        200
    );
    assert_eq!(
        request(
            &router,
            "DELETE",
            &format!("/v1/admin/inventory/sources/{source_id}"),
            json!({}),
            token
        )
        .await
        .0,
        200
    );
    let role = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'Inventory reader',ARRAY['inventory.read'])").bind(role).execute(&pool).await.unwrap();
    sqlx::query("UPDATE admin_iam.admin_users SET role_id=$2 WHERE id=$1")
        .bind(actor)
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/admin/inventory/sources",
            json!({}),
            token
        )
        .await
        .0,
        200
    );
    assert_eq!(
        request(
            &router,
            "DELETE",
            "/v1/admin/inventory/sources/00000000-0000-0000-0000-000000000001",
            json!({}),
            token
        )
        .await
        .0,
        403
    );
}
