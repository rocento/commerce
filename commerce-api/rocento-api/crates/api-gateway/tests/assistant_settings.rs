use api_gateway::{assistant, identity};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use infra_auth::Security;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

#[sqlx::test(migrations = "../../migrations")]
async fn provider_settings_require_admin_permissions_and_csrf(pool: PgPool) {
    let security = Security::new(
        "settings-test-secret-".repeat(3),
        "http://localhost:5174".into(),
        false,
    )
    .await
    .unwrap();
    let role = Uuid::new_v4();
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'settings-test',ARRAY['reports.read'])").bind(role).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'settings@example.test','Settings','!',$2)").bind(user).bind(role).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest("settings-test")).bind(user).execute(&pool).await.unwrap();
    let app = assistant::router(
        identity::App::new(pool.clone(), security, vec!["http://localhost:5174".into()]),
        None,
    );
    for (cookie, expected) in [
        ("", StatusCode::UNAUTHORIZED),
        ("admin_session=settings-test", StatusCode::FORBIDDEN),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::get("/v1/admin/assistant/settings")
                    .header("cookie", cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
    // Baseline diagnostics use the same admin permission boundary, not shopper auth.
    for (path, method, body) in [
        ("/v1/admin/assistant/readiness", "GET", ""),
        ("/v1/admin/assistant/tracking", "GET", ""),
        ("/v1/admin/assistant/tracking/live", "GET", ""),
        ("/v1/admin/assistant/tracking/settings", "GET", ""),
        (
            "/v1/admin/assistant/tracking/settings",
            "PUT",
            r#"{"enabled":false}"#,
        ),
        (
            "/v1/admin/assistant/tracking/00000000-0000-0000-0000-000000000001",
            "GET",
            "",
        ),
        (
            "/v1/admin/assistant/tracking/00000000-0000-0000-0000-000000000001/export",
            "GET",
            "",
        ),
        (
            "/v1/admin/assistant/acceptance",
            "POST",
            r#"{"query":"milk"}"#,
        ),
    ] {
        for (cookie, expected) in [
            ("", StatusCode::UNAUTHORIZED),
            ("admin_session=settings-test", StatusCode::FORBIDDEN),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .header("cookie", cookie)
                        .header("content-type", "application/json")
                        .header("x-commerce-request", "1")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
    }
    sqlx::query(
        "UPDATE admin_iam.roles SET permissions=ARRAY['assistant.settings.read'] WHERE id=$1",
    )
    .bind(role)
    .execute(&pool)
    .await
    .unwrap();
    let request = || {
        Request::put("/v1/admin/assistant/settings")
            .header("cookie", "admin_session=settings-test")
            .header("content-type", "application/json")
    };
    let body = || Body::from(r#"{"enabled":true,"model":"test-model","api_key":"test-secret"}"#);
    assert_eq!(
        app.clone()
            .oneshot(
                request()
                    .header("x-commerce-request", "1")
                    .body(body())
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['assistant.settings.read','assistant.settings.write'] WHERE id=$1").bind(role).execute(&pool).await.unwrap();
    assert_eq!(
        app.clone()
            .oneshot(request().body(body()).unwrap())
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.clone()
            .oneshot(
                request()
                    .header("x-commerce-request", "1")
                    .header("origin", "https://untrusted.example")
                    .body(body())
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    // An authorized operation reaches the disabled-service boundary, never a public fallback.
    assert_eq!(
        app.clone()
            .oneshot(
                request()
                    .header("x-commerce-request", "1")
                    .body(body())
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        app.clone()
            .oneshot(
                Request::post("/v1/admin/assistant/acceptance")
                    .header("cookie", "admin_session=settings-test")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"query":"milk"}"#))
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
}
