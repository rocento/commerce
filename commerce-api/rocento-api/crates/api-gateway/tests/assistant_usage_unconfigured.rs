//! An absent assistant must not send its admin usage route to public publication.
use api_gateway::{assistant, identity};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    response::Response,
    Router,
};
use infra_auth::Security;
use serde_json::json;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

async fn router(pool: PgPool, permissions: Vec<&str>) -> Router {
    let security = Security::new(
        "unconfigured-assistant-usage-qa-".repeat(3),
        "http://localhost:5174".into(),
        false,
    )
    .await
    .unwrap();
    let role = Uuid::new_v4();
    let admin = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'usage-qa',$2)")
        .bind(role)
        .bind(permissions)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'usage-qa@example.test','Usage QA','!',$2)")
        .bind(admin).bind(role).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')")
        .bind(infra_auth::digest("usage-qa-session")).bind(admin).execute(&pool).await.unwrap();
    assistant::router(
        identity::App::new(pool, security, vec!["http://localhost:5174".into()]),
        None,
    )
    // In the full gateway, an unknown host reaches this publication fallback.
    // The admin API must remain registered and authenticate before reporting503.
    .fallback(|| async { StatusCode::MISDIRECTED_REQUEST })
}

async fn usage(router: Router, cookie: &str) -> Response {
    router
        .oneshot(
            Request::get("/v1/admin/assistant/usage")
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn unavailable_assistant_usage_requires_an_admin_session(pool: PgPool) {
    let app = router(pool, vec!["reports.read"]).await;
    for cookie in ["", "admin_session=invalid"] {
        assert_eq!(
            usage(app.clone(), cookie).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn unavailable_assistant_usage_preserves_reports_permission(pool: PgPool) {
    let response = usage(
        router(pool, vec!["catalog.read"]).await,
        "admin_session=usage-qa-session",
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[sqlx::test(migrations = "../../migrations")]
async fn unavailable_assistant_usage_returns_503_without_fake_metrics(pool: PgPool) {
    let response = usage(
        router(pool, vec!["reports.read"]).await,
        "admin_session=usage-qa-session",
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()["content-type"], "application/json");
    let body: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(
        body,
        json!({"error":"Assistant temporarily unavailable. You can still contact support."})
    );
}
