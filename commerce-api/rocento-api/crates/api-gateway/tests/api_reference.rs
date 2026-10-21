use api_gateway::{api_reference, identity};
use axum::{
    body::Body,
    http::{HeaderMap, Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::Value;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

struct Fixture {
    app: identity::App,
    router: Router,
    actor: Uuid,
    role: Uuid,
    token: String,
}

async fn fixture(pool: &PgPool, permissions: &[&str]) -> Fixture {
    let actor = Uuid::new_v4();
    let role = Uuid::new_v4();
    let token = format!("synthetic-docs-session-{}", Uuid::new_v4());
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,$2,$3)")
        .bind(role)
        .bind(format!("Docs {role}"))
        .bind(permissions)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,$2,'Documentation reviewer','unused',$3)")
        .bind(actor).bind(format!("{actor}@example.test")).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')")
        .bind(infra_auth::digest(&token)).bind(actor).execute(pool).await.unwrap();
    // Share only immutable crypto setup, never a database or session. This
    // avoids concurrently consuming the password hasher's admission budget.
    static SECURITY: tokio::sync::OnceCell<infra_auth::Security> =
        tokio::sync::OnceCell::const_new();
    let security = SECURITY
        .get_or_init(|| async {
            infra_auth::Security::new(
                "api-docs-test-secret-at-least-32-characters".into(),
                "http://localhost:5173".into(),
                false,
            )
            .await
            .unwrap()
        })
        .await
        .clone();
    let app = identity::App::new(pool.clone(), security, vec!["http://localhost:5173".into()]);
    let router = api_gateway::router()
        .merge(identity::router(app.clone()))
        .merge(api_reference::router(app.clone()));
    Fixture {
        app,
        router,
        actor,
        role,
        token,
    }
}

async fn request(
    router: &Router,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut request = Request::builder().method(method).uri(path);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    (status, headers, body)
}

fn assert_private(headers: &HeaderMap) {
    assert_eq!(headers["cache-control"], "private, no-store");
    assert_eq!(headers["vary"], "Cookie");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(headers["cross-origin-resource-policy"], "same-origin");
    assert!(headers["x-robots-tag"]
        .to_str()
        .unwrap()
        .contains("noindex"));
    assert!(!headers.contains_key("access-control-allow-origin"));
    assert!(!headers.contains_key("set-cookie"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn anonymous_customer_and_unprivileged_admin_cannot_read(pool: PgPool) {
    let t = fixture(&pool, &["catalog.read", "iam.users.read"]).await;
    let cookie = format!("admin_session={}", t.token);
    let fake_bearer = format!("Bearer {}", t.token);
    for headers in [
        vec![],
        vec![("cookie", "admin_session=not-a-session")],
        vec![(
            "cookie",
            "customer_refresh=customer-session; guest_cart=guest-session",
        )],
        vec![("authorization", fake_bearer.as_str())],
    ] {
        for method in ["GET", "HEAD"] {
            let (status, headers, body) =
                request(&t.router, method, api_reference::PATH, &headers).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert_private(&headers);
            assert!(!String::from_utf8_lossy(&body).contains("openapi"));
        }
    }
    let (status, headers, body) = request(
        &t.router,
        "GET",
        api_reference::PATH,
        &[("cookie", &cookie)],
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_private(&headers);
    assert!(!String::from_utf8_lossy(&body).contains("openapi"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn dedicated_read_permission_returns_only_reviewed_contract_and_grants_no_execution(
    pool: PgPool,
) {
    let t = fixture(&pool, &["api.docs.read"]).await;
    let cookie = format!("admin_session={}", t.token);
    let (status, headers, body) = request(
        &t.router,
        "GET",
        api_reference::PATH,
        &[("cookie", &cookie)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_private(&headers);
    assert_eq!(headers["content-type"], "application/json");
    let contract: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        contract,
        serde_json::from_str::<Value>(include_str!("../../../merchant-openapi.json")).unwrap()
    );
    assert!(contract["paths"]["/v1/admin/orders"].is_object());
    assert!(contract["paths"]["/v1/assistant-tools/shopper"].is_null());
    assert!(contract["paths"]["/v1/admin/assistant/settings"].is_null());
    assert!(contract["components"]["securitySchemes"]["agentProof"].is_null());
    assert_eq!(
        request(&t.router, "GET", "/v1/admin/users", &[("cookie", &cookie)])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(&t.router, "GET", "/openapi.json", &[("cookie", &cookie)])
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &t.router,
            "POST",
            api_reference::PATH,
            &[("cookie", &cookie)]
        )
        .await
        .0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    let tampered = format!(
        "{}?url=https://untrusted.example/full.json&spec=/openapi.json&tenant=other",
        api_reference::PATH
    );
    let other = request(
        &t.router,
        "GET",
        &tampered,
        &[
            ("cookie", &cookie),
            ("x-tenant-id", "another-merchant"),
            ("origin", "https://untrusted.example"),
        ],
    )
    .await;
    assert_eq!(other.0, StatusCode::OK);
    assert_private(&other.1);
    assert_eq!(body, other.2);
    let identity = t.app.admins.authenticate(&t.token).await.unwrap();
    assert_eq!(identity.permissions, ["api.docs.read"]);
    assert!(identity.require("catalog.write").is_err());
    assert!(identity.require("iam.roles.write").is_err());
}

#[sqlx::test(migrations = "../../migrations")]
async fn each_read_rechecks_role_account_expiry_and_revocation(pool: PgPool) {
    let t = fixture(&pool, &["api.docs.read"]).await;
    let cookie = format!("admin_session={}", t.token);
    let headers = [("cookie", cookie.as_str())];
    assert_eq!(
        request(&t.router, "GET", api_reference::PATH, &headers)
            .await
            .0,
        StatusCode::OK
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY[]::text[] WHERE id=$1")
        .bind(t.role)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(&t.router, "GET", api_reference::PATH, &headers)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['*'] WHERE id=$1")
        .bind(t.role)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(&t.router, "GET", api_reference::PATH, &headers)
            .await
            .0,
        StatusCode::OK
    );
    sqlx::query("UPDATE admin_iam.admin_users SET active=false WHERE id=$1")
        .bind(t.actor)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(&t.router, "GET", api_reference::PATH, &headers)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    sqlx::query("UPDATE admin_iam.admin_users SET active=true WHERE id=$1")
        .bind(t.actor)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE admin_iam.sessions SET expires_at=now()-interval '1 second' WHERE admin_id=$1",
    )
    .bind(t.actor)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        request(&t.router, "GET", api_reference::PATH, &headers)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    sqlx::query(
        "UPDATE admin_iam.sessions SET expires_at=now()+interval '1 hour' WHERE admin_id=$1",
    )
    .bind(t.actor)
    .execute(&pool)
    .await
    .unwrap();
    t.app.admins.logout(&t.token).await.unwrap();
    assert_eq!(
        request(&t.router, "GET", api_reference::PATH, &headers)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn sessions_do_not_cross_merchant_databases_even_with_tenant_headers(pool: PgPool) {
    // Both databases are synthetic and disposable; SQLx already requires a
    // CREATEDB test user. Never obtain a tenant database from HTTP input.
    let options: sqlx::postgres::PgConnectOptions =
        std::env::var("DATABASE_URL").unwrap().parse().unwrap();
    let control = PgPool::connect_with(options.clone()).await.unwrap();
    let name = format!("api_docs_isolation_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&control)
        .await
        .unwrap();
    let other_pool = PgPool::connect_with(options.database(&name)).await.unwrap();
    sqlx::migrate!("../../migrations")
        .run(&other_pool)
        .await
        .unwrap();
    let a = fixture(&pool, &["api.docs.read"]).await;
    let b = fixture(&other_pool, &["api.docs.read"]).await;
    let a_cookie = format!("admin_session={}", a.token);
    let b_cookie = format!("admin_session={}", b.token);
    let a_own = request(
        &a.router,
        "GET",
        api_reference::PATH,
        &[("cookie", &a_cookie)],
    )
    .await
    .0;
    let b_own = request(
        &b.router,
        "GET",
        api_reference::PATH,
        &[("cookie", &b_cookie)],
    )
    .await
    .0;
    let a_cross = request(
        &a.router,
        "GET",
        api_reference::PATH,
        &[
            ("cookie", &b_cookie),
            ("x-tenant-id", &name),
            ("x-forwarded-host", "other.example.test"),
        ],
    )
    .await
    .0;
    let b_cross = request(
        &b.router,
        "GET",
        api_reference::PATH,
        &[("cookie", &a_cookie), ("x-tenant-id", "first-merchant")],
    )
    .await
    .0;
    other_pool.close().await;
    sqlx::query(&format!("DROP DATABASE {name}"))
        .execute(&control)
        .await
        .unwrap();
    control.close().await;
    assert_eq!(a_own, StatusCode::OK);
    assert_eq!(b_own, StatusCode::OK);
    assert_eq!(a_cross, StatusCode::UNAUTHORIZED);
    assert_eq!(b_cross, StatusCode::UNAUTHORIZED);
}

#[sqlx::test(migrations = "../../migrations")]
async fn only_an_authorized_grantor_can_assign_the_documentation_permission(pool: PgPool) {
    let owner = fixture(&pool, &["*"]).await;
    let manager = fixture(&pool, &["iam.roles.write"]).await;
    let owner_identity = owner.app.admins.authenticate(&owner.token).await.unwrap();
    let manager_identity = manager
        .app
        .admins
        .authenticate(&manager.token)
        .await
        .unwrap();
    let input = || domain_admin_iam::RoleInput {
        name: "Documentation readers".into(),
        permissions: vec!["api.docs.read".into()],
    };
    let denied = manager
        .app
        .admins
        .save_role(&manager_identity, None, input())
        .await;
    assert!(matches!(denied, Err(infra_auth::Error::Forbidden)));
    let granted = owner
        .app
        .admins
        .save_role(&owner_identity, None, input())
        .await
        .unwrap();
    assert_eq!(granted.permissions, ["api.docs.read"]);
    let invalid = domain_admin_iam::RoleInput {
        name: "Invalid documentation operator".into(),
        permissions: vec!["api.docs.write".into()],
    };
    assert!(matches!(
        owner
            .app
            .admins
            .save_role(&owner_identity, None, invalid)
            .await,
        Err(infra_auth::Error::Invalid(_))
    ));
}

#[sqlx::test(migrations = "../../migrations")]
async fn removed_raw_contract_uses_real_unbound_discovery_fallback_without_affecting_protected_docs(
    pool: PgPool,
) {
    let t = fixture(&pool, &["api.docs.read"]).await;
    // Match main.rs composition, including discoverability's real catch-all
    // and its identity::policy layer. With no approved publication origin the
    // fallback rejects every Host before unknown-path resolution. That denial
    // is normalized by policy into the JSON response observed on the wire.
    let router = t
        .router
        .merge(api_gateway::discoverability::router_with_deployment(
            t.app.clone(),
            api_gateway::public_commerce::policy::Deployment::default(),
        ))
        .layer(axum::middleware::from_fn(
            api_gateway::public_commerce::policy::api_headers,
        ));
    for host in ["127.0.0.1", "grocery.example.com", "admin.example.com"] {
        for path in ["/openapi.json", "/documentation-verification-unknown-route"] {
            let (status, headers, body) = request(&router, "GET", path, &[("host", host)]).await;
            assert_eq!(status, StatusCode::MISDIRECTED_REQUEST);
            assert_eq!(headers["content-type"], "application/json");
            assert_eq!(headers["cache-control"], "no-store");
            assert_eq!(headers["x-content-type-options"], "nosniff");
            let error: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(
                error,
                serde_json::json!({"error": "Invalid request body or route parameters"})
            );
            assert!(error.get("openapi").is_none());
            assert!(error.get("paths").is_none());
        }
    }
    let (status, headers, _) = request(
        &router,
        "GET",
        api_reference::PATH,
        &[("host", "admin.example.com")],
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_private(&headers);
    let cookie = format!("admin_session={}", t.token);
    let (status, headers, body) = request(
        &router,
        "GET",
        api_reference::PATH,
        &[("host", "admin.example.com"), ("cookie", &cookie)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_private(&headers);
    let contract: Value = serde_json::from_slice(&body).unwrap();
    let count: usize = contract["paths"]
        .as_object()
        .unwrap()
        .values()
        .map(|methods| methods.as_object().unwrap().len())
        .sum();
    assert_eq!(count, 277);
    assert!(contract["paths"]["/openapi.json"].is_null());
}
