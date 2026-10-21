mod support;
use api_gateway::{discoverability, identity, public_commerce::policy::Deployment};
use infra_auth::Security;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

async fn fixture(
    pool: &PgPool,
    environment: &str,
    blocked: bool,
) -> (String, Uuid, tokio::task::JoinHandle<()>) {
    fixture_at(pool, environment, blocked, "shop.example.test").await
}
async fn fixture_at(
    pool: &PgPool,
    environment: &str,
    blocked: bool,
    host: &str,
) -> (String, Uuid, tokio::task::JoinHandle<()>) {
    let role = Uuid::new_v4();
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,$2,ARRAY['discovery.read','discovery.write'])")
        .bind(role).bind(role.to_string()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,$2,'Publisher','!',$3)")
        .bind(user).bind(format!("{user}@example.test")).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')")
        .bind(infra_auth::digest(&user.to_string())).bind(user).execute(pool).await.unwrap();
    let id: Uuid =
        sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
            .fetch_one(pool)
            .await
            .unwrap();
    let security = Security::new(
        "publication-test-secret".repeat(3),
        "https://shop.example.test".into(),
        false,
    )
    .await
    .unwrap();
    let router = discoverability::router_with_deployment(
        identity::App::new(
            pool.clone(),
            security,
            vec!["https://admin.example.test".into()],
        ),
        Deployment {
            installation_id: Some(id),
            environment: environment.into(),
            approved_origin: Some(format!("https://{host}/")),
            header_override: blocked,
            html: Some(
                std::env::var("PUBLICATION_TEST_INDEX")
                    .ok()
                    .map(std::fs::read_to_string)
                    .transpose()
                    .unwrap()
                    .unwrap_or_else(|| {
                        include_str!("../../../../../commerce-web/apps/storefront/index.html").into()
                    }),
            ),
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (base, user, task)
}
fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}
async fn get(base: &str, path: &str) -> reqwest::Response {
    client()
        .get(format!("{base}{path}"))
        .header("host", "shop.example.test")
        .send()
        .await
        .unwrap()
}
async fn effective(base: &str, user: Uuid) -> Value {
    let response = client()
        .get(format!("{base}/v1/admin/discovery/effective"))
        .header("cookie", format!("admin_session={user}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["x-robots-tag"], "noindex, nofollow");
    let result: Value = response.json().await.unwrap();
    let schema: Value = serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &result,
        &schema["components"]["schemas"]["EffectiveIndexingPolicy"],
        &schema,
    );
    result
}
async fn input(base: &str) -> Value {
    let mut v: Value = get(base, "/v1/discovery/config")
        .await
        .json()
        .await
        .unwrap();
    let revision = v["revision"].clone();
    v.as_object_mut().unwrap().remove("revision");
    v.as_object_mut().unwrap().remove("updated_at");
    v["expected_revision"] = revision;
    v["enabled"] = json!(true);
    v["indexing_enabled"] = json!(true);
    v["canonical_url"] = json!("https://shop.example.test/");
    v
}
async fn save(base: &str, user: Uuid, data: &Value) -> reqwest::Response {
    client()
        .put(format!("{base}/v1/admin/discovery/config"))
        .header("cookie", format!("admin_session={user}"))
        .header("x-commerce-request", "1")
        .header("origin", "https://admin.example.test")
        .json(data)
        .send()
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn real_http_policy_preferences_override_hosts_and_permissions(pool: PgPool) {
    let (base, user, task) = fixture(&pool, "production", false).await;
    let data = input(&base).await;
    let csrf = client()
        .put(format!("{base}/v1/admin/discovery/config"))
        .header("cookie", format!("admin_session={user}"))
        .json(&data)
        .send()
        .await
        .unwrap();
    assert_eq!(csrf.status(), 403);
    let origin = client()
        .put(format!("{base}/v1/admin/discovery/config"))
        .header("cookie", format!("admin_session={user}"))
        .header("x-commerce-request", "1")
        .header("origin", "https://attacker.example")
        .json(&data)
        .send()
        .await
        .unwrap();
    assert_eq!(origin.status(), 403);
    assert_eq!(save(&base, user, &data).await.status(), 200);
    let p = effective(&base, user).await;
    assert_eq!(p["state"], "INDEXABLE");
    let response = get(&base, "/v1/publication/snapshot?path=%2F").await;
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["x-robots-tag"], "noindex, nofollow");
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(
        response.json::<Value>().await.unwrap()["robots"],
        "index, follow"
    );
    assert!(get(&base, "/robots.txt")
        .await
        .text()
        .await
        .unwrap()
        .contains("Allow: /"));
    for path in [
        "/account",
        "/cart",
        "/checkout",
        "/?theme_preview=secret",
        "/v1/discovery/config",
    ] {
        assert_eq!(
            get(&base, path).await.headers()["x-robots-tag"],
            "noindex, nofollow"
        );
    }
    let unknown = client()
        .get(format!("{base}/"))
        .header("host", "other.example.test")
        .header("x-forwarded-host", "shop.example.test")
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), 421);
    let spoof = client()
        .get(format!("{base}/"))
        .header("host", "shop.example.test")
        .header("x-forwarded-host", "other.example.test")
        .send()
        .await
        .unwrap();
    assert_eq!(spoof.status(), 503);
    assert!(!spoof.text().await.unwrap().contains("other.example"));
    assert_eq!(save(&base, user, &data).await.status(), 409);
    let mut changed = input(&base).await;
    changed["canonical_url"] = json!("https://other.example.test/");
    assert_eq!(save(&base, user, &changed).await.status(), 400);
    changed["canonical_url"] = json!("https://admin.example.test/");
    assert_eq!(save(&base, user, &changed).await.status(), 400);
    changed["canonical_url"] = json!("https://shop.example.test/");
    changed["indexing_enabled"] = json!(false);
    assert_eq!(save(&base, user, &changed).await.status(), 200);
    assert_eq!(effective(&base, user).await["state"], "MERCHANT_DISABLED");
    let response = get(&base, "/v1/publication/snapshot?path=%2F").await;
    assert_eq!(response.headers()["x-robots-tag"], "noindex, nofollow");
    assert_eq!(
        response.json::<Value>().await.unwrap()["robots"],
        "noindex, nofollow"
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM admin_iam.audit_log WHERE action='discovery.settings.updated'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 2);
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM platform.outbox WHERE event_type='discovery.settings.updated'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 2);
    assert_eq!(
        get(&base, "/v1/admin/discovery/effective").await.status(),
        401
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['discovery.read'] WHERE id=(SELECT role_id FROM admin_iam.admin_users WHERE id=$1)").bind(user).execute(&pool).await.unwrap();
    assert_eq!(save(&base, user, &input(&base).await).await.status(), 403);
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY[]::text[] WHERE id=(SELECT role_id FROM admin_iam.admin_users WHERE id=$1)").bind(user).execute(&pool).await.unwrap();
    let forbidden = client()
        .get(format!("{base}/v1/admin/discovery/effective"))
        .header("cookie", format!("admin_session={user}"))
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden.status(), 403);
    task.abort();
}

#[sqlx::test(migrations = "../../migrations")]
async fn protected_environments_and_header_override_win_on_real_http(pool: PgPool) {
    sqlx::query("UPDATE cms.discoverability_settings SET enabled=true,indexing_enabled=true,canonical_url='https://shop.example.test/'").execute(&pool).await.unwrap();
    for environment in ["production", "demo", "staging", "admin", "development"] {
        let (base, user, task) = fixture(&pool, environment, true).await;
        let p = effective(&base, user).await;
        assert_eq!(
            p["state"],
            if environment == "production" {
                "BLOCKED_BY_HEADER"
            } else {
                "BLOCKED_BY_ENVIRONMENT"
            }
        );
        let response = get(&base, "/v1/publication/snapshot?path=%2F").await;
        assert_eq!(response.headers()["x-robots-tag"], "noindex, nofollow");
        assert_eq!(
            response.json::<Value>().await.unwrap()["robots"],
            "noindex, nofollow"
        );
        assert_eq!(p["deployment_override"], true);
        task.abort();
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn two_installations_cannot_change_each_others_policy(pool: PgPool) {
    let name = format!("seo_isolation_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&pool)
        .await
        .unwrap();
    let options = pool.connect_options().as_ref().clone().database(&name);
    let other = sqlx::postgres::PgPoolOptions::new()
        .connect_with(options)
        .await
        .unwrap();
    sqlx::migrate!("../../migrations")
        .run(&other)
        .await
        .unwrap();
    let (a, ua, ta) = fixture(&pool, "production", false).await;
    let (b, ub, tb) = fixture_at(&other, "production", false, "other.example.test").await;
    let data = input(&a).await;
    assert_eq!(save(&a, ua, &data).await.status(), 200);
    let mut data = input(&b).await;
    data["canonical_url"] = json!("https://other.example.test/");
    data["indexing_enabled"] = json!(false);
    assert_eq!(save(&b, ub, &data).await.status(), 200);
    let pa = effective(&a, ua).await;
    let pb = effective(&b, ub).await;
    assert_ne!(pa["installation_id"], pb["installation_id"]);
    assert_eq!(pa["state"], "INDEXABLE");
    assert_eq!(pb["state"], "MERCHANT_DISABLED");
    assert_eq!(pb["canonical_origin"], "https://other.example.test/");
    assert_eq!(get(&b, "/").await.status(), 421); // A's host cannot select B's data.
    let response = client()
        .get(format!("{b}/"))
        .header("host", "other.example.test")
        .send()
        .await
        .unwrap();
    assert_eq!(response.headers()["x-robots-tag"], "noindex, nofollow");
    let mut attack = input(&a).await;
    attack["canonical_url"] = json!("https://other.example.test/");
    assert_eq!(save(&a, ua, &attack).await.status(), 400);
    assert_eq!(save(&b, ua, &data).await.status(), 401); // A's session cannot mutate B.
    assert_eq!(
        effective(&b, ub).await["settings_revision"],
        pb["settings_revision"]
    );
    sqlx::query("UPDATE cms.publication_entity SET configuration=jsonb_build_object('published',true,'legal_name','Tenant A Only')").execute(&pool).await.unwrap();
    let response = client()
        .get(format!("{b}/v1/admin/discovery/entity"))
        .header("cookie", format!("admin_session={ua}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let response = client()
        .get(format!("{b}/v1/admin/discovery/entity"))
        .header("cookie", format!("admin_session={ub}"))
        .send()
        .await
        .unwrap();
    assert!(!response.text().await.unwrap().contains("Tenant A Only"));
    ta.abort();
    tb.abort();
    other.close().await;
    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .execute(&pool)
        .await
        .unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn merchant_profile_permissions_validation_revisions_and_isolation(pool: PgPool) {
    let (base, user, task) = fixture(&pool, "production", false).await;
    assert_eq!(get(&base, "/v1/admin/discovery/entity").await.status(), 401);
    let input = json!({"expected_revision":1,"configuration":{"published":true,"legal_name":"Approved Seller","contact_published":false,"email":"private@example.test","locations":["Private location"]}});
    let response = client()
        .put(format!("{base}/v1/admin/discovery/entity"))
        .header("cookie", format!("admin_session={user}"))
        .json(&input)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    for expected in [200, 409] {
        let response = client()
            .put(format!("{base}/v1/admin/discovery/entity"))
            .header("cookie", format!("admin_session={user}"))
            .header("origin", "https://admin.example.test")
            .header("X-Commerce-Request", "1")
            .json(&input)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
    let response = client()
        .get(format!("{base}/v1/admin/discovery/entity"))
        .header("cookie", format!("admin_session={user}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let v: Value = response.json().await.unwrap();
    assert_eq!(v["revision"], 2);
    assert_eq!(v["configuration"]["email"], "private@example.test");
    assert!(v["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("shipping")));
    let invalid = json!({"expected_revision":2,"configuration":{"published":true,"social_profiles":["javascript:alert(1)"]}});
    let response = client()
        .put(format!("{base}/v1/admin/discovery/entity"))
        .header("cookie", format!("admin_session={user}"))
        .header("origin", "https://admin.example.test")
        .header("X-Commerce-Request", "1")
        .json(&invalid)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM admin_iam.audit_log WHERE action='discovery.entity.updated'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
    task.abort();
}
