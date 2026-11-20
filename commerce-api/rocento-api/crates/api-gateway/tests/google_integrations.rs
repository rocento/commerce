use api_gateway::{google, identity, public_commerce::policy::Deployment};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use domain_admin_operations::google::{Config, Input, Service};
use http_body_util::BodyExt;
use infra_auth::{secrets::Vault, Security};
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;
async fn setup(pool: &PgPool, permissions: Vec<&str>) -> Router {
    let security = Security::new(
        "google-test-secret-".repeat(4),
        "https://store.example.test".into(),
        false,
    )
    .await
    .unwrap();
    let role = Uuid::new_v4();
    let actor = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'Google test role',$2)",
    )
    .bind(role)
    .bind(permissions)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'google@example.test','Google admin','!',$2)").bind(actor).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest("google-session")).bind(actor).execute(pool).await.unwrap();
    let mut app = google::App::new(
        identity::App::new(
            pool.clone(),
            security,
            vec!["https://admin.example.test".into()],
        ),
        Deployment::default(),
    )
    .unwrap();
    app.service.vault = Some(Vault::from_hex(&"ab".repeat(32)).unwrap());
    google::router(app)
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    session: bool,
    marker: bool,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if session {
        req = req.header("cookie", "admin_session=google-session");
    }
    if marker {
        req = req.header("x-commerce-request", "1");
    }
    let r = app
        .clone()
        .oneshot(
            req.body(if method == "GET" {
                Body::empty()
            } else {
                Body::from(body.to_string())
            })
            .unwrap(),
        )
        .await
        .unwrap();
    let status = r.status();
    let bytes = r.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
fn input(revision: i64) -> Value {
    json!({"expected_revision":revision,"enabled":true,"config":{"account_id":"","data_source_id":"","language":"","feed_label":"","measurement_id":""},"credential":"maps-secret-canary"})
}
#[sqlx::test(migrations = "../../migrations")]
async fn credentials_revision_disconnect_and_public_projection(pool: PgPool) {
    let app = setup(&pool, vec!["*"]).await;
    let path = "/v1/admin/integrations/google/maps";
    assert_eq!(
        call(&app, "PUT", path, input(1), true, false).await.0,
        StatusCode::FORBIDDEN
    );
    let (status, body) = call(&app, "PUT", path, input(1), true, true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!body.to_string().contains("canary"));
    let ciphertext: Vec<u8> = sqlx::query_scalar(
        "SELECT credentials FROM platform.google_connections WHERE service='maps'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!String::from_utf8_lossy(&ciphertext).contains("canary"));
    assert_eq!(
        call(&app, "PUT", path, input(1), true, true).await.0,
        StatusCode::CONFLICT
    );
    let (_, public) = call(
        &app,
        "GET",
        "/v1/integrations/google/public",
        Value::Null,
        false,
        false,
    )
    .await;
    assert_eq!(public["maps_browser_key"], "maps-secret-canary");
    assert_eq!(public.as_object().unwrap().len(), 2);
    let (_, body) = call(
        &app,
        "POST",
        &format!("{path}/disconnect"),
        json!({"expected_revision":2}),
        true,
        true,
    )
    .await;
    assert!(!body.to_string().contains("canary"));
    let (_, public) = call(
        &app,
        "GET",
        "/v1/integrations/google/public",
        Value::Null,
        false,
        false,
    )
    .await;
    assert!(public["maps_browser_key"].is_null());
    let exists: bool = sqlx::query_scalar(
        "SELECT credentials IS NOT NULL FROM platform.google_connections WHERE service='maps'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!exists);
}
#[sqlx::test(migrations = "../../migrations")]
async fn read_only_admin_and_anonymous_cannot_write(pool: PgPool) {
    let app = setup(&pool, vec!["integrations.google.read"]).await;
    assert_eq!(
        call(
            &app,
            "GET",
            "/v1/admin/integrations/google",
            Value::Null,
            true,
            false
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "GET",
            "/v1/admin/integrations/google",
            Value::Null,
            false,
            false
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    for action in ["", "/disconnect", "/test"] {
        assert_eq!(
            call(
                &app,
                if action.is_empty() { "PUT" } else { "POST" },
                &format!("/v1/admin/integrations/google/maps{action}"),
                if action.is_empty() {
                    input(1)
                } else {
                    json!({"expected_revision":1})
                },
                true,
                true
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
}
#[sqlx::test(migrations = "../../migrations")]
async fn ciphertext_cannot_cross_installation_or_service(pool: PgPool) {
    let _app = setup(&pool, vec!["*"]).await;
    let actor: Uuid = sqlx::query_scalar(
        "SELECT id FROM admin_iam.admin_users WHERE email='google@example.test'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let svc = Service {
        pool: pool.clone(),
        vault: Some(Vault::from_hex(&"ab".repeat(32)).unwrap()),
    };
    svc.save(
        actor,
        "maps",
        Input {
            expected_revision: 1,
            enabled: true,
            config: Config::default(),
            credential: Some("isolation-canary".into()),
            clear_credential: false,
        },
    )
    .await
    .unwrap();
    let bytes: Vec<u8> = sqlx::query_scalar(
        "SELECT credentials FROM platform.google_connections WHERE service='maps'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(svc.decode("merchant", &bytes).await.is_err());
    sqlx::query("UPDATE platform.publication_installation SET installation_id=$1")
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .unwrap();
    assert!(svc.decode("maps", &bytes).await.is_err());
}

#[sqlx::test(migrations = false)]
async fn google_upgrade_preserves_existing_installation_and_migration_history(pool: PgPool) {
    use std::borrow::Cow;
    let all = sqlx::migrate!("../../migrations");
    let baseline = sqlx::migrate::Migrator {
        migrations: Cow::Owned(
            all.iter()
                .filter(|m| m.version < 20261112020000)
                .cloned()
                .collect(),
        ),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    baseline.run(&pool).await.unwrap();
    let installation: Uuid =
        sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
            .fetch_one(&pool)
            .await
            .unwrap();
    let role = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'Existing Google manager',ARRAY['integrations.google.read'])")
        .bind(role).execute(&pool).await.unwrap();
    let history: Vec<(i64, Vec<u8>)> =
        sqlx::query_as("SELECT version,checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
    all.run(&pool).await.unwrap();
    all.run(&pool).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, Uuid>(
            "SELECT installation_id FROM platform.publication_installation"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        installation
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT name FROM admin_iam.roles WHERE id=$1")
            .bind(role)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "Existing Google manager"
    );
    let after: Vec<(i64,Vec<u8>)> = sqlx::query_as("SELECT version,checksum FROM _sqlx_migrations WHERE version<20261112020000 ORDER BY version")
        .fetch_all(&pool).await.unwrap();
    assert_eq!(history, after);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM platform.google_connections WHERE NOT enabled AND credentials IS NULL").fetch_one(&pool).await.unwrap(),3);
}
