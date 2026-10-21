use api_gateway::identity::App;
use axum::{
    body::{to_bytes, Body},
    http::{HeaderMap, Request, StatusCode},
    Router,
};
use domain_mobile::{checksum, token_hash};
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

struct Fixture {
    app: Router,
    pool: PgPool,
    merchant: Uuid,
    other: Uuid,
    owner: String,
    designer: String,
    outsider: String,
    mobile: String,
    config: Value,
}
async fn admin(pool: &PgPool, merchant: Option<Uuid>, role: &str) -> String {
    let id = Uuid::new_v4();
    let token = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,$2,'Mobile test','unused',$3)").bind(id).bind(format!("{id}@mobile.test")).bind(domain_admin_iam::SUPER).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest(&token)).bind(id).execute(pool).await.unwrap();
    if let Some(merchant) = merchant {
        sqlx::query("INSERT INTO mobile.memberships(merchant_id,admin_id,role) VALUES($1,$2,$3)")
            .bind(merchant)
            .bind(id)
            .bind(role)
            .execute(pool)
            .await
            .unwrap();
    }
    token
}
async fn fixture(pool: PgPool) -> Fixture {
    let config: Value = serde_json::from_str(include_str!(
        "../../domain-mobile/contract/v1/fixtures/merchant-1.json"
    ))
    .unwrap();
    let merchant = Uuid::parse_str(config["tenantId"].as_str().unwrap()).unwrap();
    let other = Uuid::parse_str("00000000-0000-0000-0000-000000000002").unwrap();
    for id in [merchant, other] {
        sqlx::query("INSERT INTO mobile.merchants(id,name,entitlements) VALUES($1,'Test', $2)")
            .bind(id)
            .bind(json!({"wishlist":true,"locationPicker":true}))
            .execute(&pool)
            .await
            .unwrap();
        let asset = if id == merchant {
            "10000000-0000-0000-0000-000000000001"
        } else {
            "10000000-0000-0000-0000-000000000002"
        };
        sqlx::query("INSERT INTO mobile.assets(id,merchant_id,url,kind,verified,checksum) VALUES($1,$2,'https://assets.example.test/fixture.png','image',true,$3)").bind(Uuid::parse_str(asset).unwrap()).bind(id).bind("a".repeat(64)).execute(&pool).await.unwrap();
    }
    let owner = admin(&pool, Some(merchant), "owner").await;
    let designer = admin(&pool, Some(merchant), "designer").await;
    let outsider = admin(&pool, None, "owner").await;
    let identity = Uuid::new_v4();
    let mobile = "mobile-test-session-00000000000000000000000001".to_string();
    sqlx::query("INSERT INTO mobile.app_identities(id,merchant_id,environment,platform,identifier,store_account_ref) VALUES($1,$2,'staging','ios','com.rocento.test','store-account/test')").bind(identity).bind(merchant).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO mobile.app_sessions(token_hash,identity_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')").bind(token_hash(&mobile)).bind(identity).execute(&pool).await.unwrap();
    let security = infra_auth::Security::new(
        "mobile-fixture-secret-at-least-32-characters".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let app = api_gateway::mobile::router(App::new(
        pool.clone(),
        security,
        vec!["http://localhost:5173".into()],
    ));
    Fixture {
        app,
        pool,
        merchant,
        other,
        owner,
        designer,
        outsider,
        mobile,
        config,
    }
}
async fn request(
    app: &Router,
    method: &str,
    path: &str,
    admin: Option<&str>,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> (StatusCode, HeaderMap, Value) {
    let mut r = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("x-commerce-request", "1");
    if let Some(token) = admin {
        r = r.header("cookie", format!("admin_session={token}"));
    }
    for (key, value) in headers {
        r = r.header(*key, *value);
    }
    let response = app
        .clone()
        .oneshot(
            r.body(body.map_or(Body::empty(), |v| Body::from(v.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"raw":String::from_utf8_lossy(&bytes)}))
    };
    (status, headers, value)
}
impl Fixture {
    fn path(&self, suffix: &str) -> String {
        format!(
            "/v1/merchants/{}/app-config/{suffix}?environment=staging",
            self.merchant
        )
    }
    async fn save(&self, config: Value, revision: i64) -> (StatusCode, HeaderMap, Value) {
        request(
            &self.app,
            "PUT",
            &self.path("draft"),
            Some(&self.designer),
            Some(json!({"expectedRevision":revision,"config":config})),
            &[],
        )
        .await
    }
    async fn publish(&self, revision: i64, key: &str) -> (StatusCode, HeaderMap, Value) {
        request(
            &self.app,
            "POST",
            &self.path("publish"),
            Some(&self.owner),
            Some(json!({"expectedRevision":revision})),
            &[("idempotency-key", key)],
        )
        .await
    }
}
#[sqlx::test(migrations = "../../migrations")]
async fn mobile_rbac_and_cross_tenant_fail_closed(pool: PgPool) {
    let f = fixture(pool).await;
    assert_eq!(f.save(f.config.clone(), 0).await.0, StatusCode::OK);
    for suffix in ["draft", "versions"] {
        for token in [None, Some(f.outsider.as_str())] {
            let result = request(&f.app, "GET", &f.path(suffix), token, None, &[]).await;
            assert_eq!(
                result.0,
                if token.is_none() {
                    StatusCode::UNAUTHORIZED
                } else {
                    StatusCode::FORBIDDEN
                }
            );
        }
        let other = f
            .path(suffix)
            .replace(&f.merchant.to_string(), &f.other.to_string());
        assert_eq!(
            request(&f.app, "GET", &other, Some(&f.owner), None, &[])
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    for suffix in ["publish", "rollback"] {
        let body = if suffix == "publish" {
            json!({"expectedRevision":1})
        } else {
            json!({"expectedRevision":1,"targetVersion":1})
        };
        assert_eq!(
            request(
                &f.app,
                "POST",
                &f.path(suffix),
                Some(&f.designer),
                Some(body.clone()),
                &[("idempotency-key", "designer-denied")]
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let other = f
            .path(suffix)
            .replace(&f.merchant.to_string(), &f.other.to_string());
        assert_eq!(
            request(
                &f.app,
                "POST",
                &other,
                Some(&f.owner),
                Some(body),
                &[("idempotency-key", "cross-tenant-denied")]
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    let mut wrong = f.config.clone();
    wrong["tenantId"] = json!(f.other);
    assert_eq!(f.save(wrong, 1).await.0, StatusCode::FORBIDDEN);
    let result = request(
        &f.app,
        "PUT",
        &f.path("draft"),
        Some(&f.owner),
        Some(json!({"expectedRevision":1,"config":f.config})),
        &[("origin", "https://evil.test")],
    )
    .await;
    assert_eq!(result.0, StatusCode::FORBIDDEN);
}
#[sqlx::test(migrations = "../../migrations")]
async fn mobile_invalid_configs_and_assets_cannot_publish(pool: PgPool) {
    let f = fixture(pool).await;
    for (path, bad) in [
        ("/screens/home/sections/0/type", json!("webView")),
        ("/brand/light/text", json!("#FFFFFF")),
        ("/compatibility/minAndroidRuntime", json!("9.0.0")),
    ] {
        let mut config = f.config.clone();
        *config.pointer_mut(path).unwrap() = bad;
        assert_eq!(f.save(config, 0).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    }
    let mut config = f.config.clone();
    config["brand"]["logoAssetId"] = json!("10000000-0000-0000-0000-000000000002");
    assert_eq!(f.save(config, 0).await.0, StatusCode::OK);
    assert_eq!(
        f.publish(1, "foreign-asset").await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut config = f.config.clone();
    config["features"]["reviews"] = json!(true);
    assert_eq!(f.save(config, 1).await.0, StatusCode::OK);
    assert_eq!(
        f.publish(2, "feature-denied").await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM mobile.config_versions")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}
#[sqlx::test(migrations = "../../migrations")]
async fn mobile_publish_rollback_cache_and_replay(pool: PgPool) {
    let f = fixture(pool).await;
    assert_eq!(f.save(f.config.clone(), 0).await.0, StatusCode::OK);
    assert_eq!(f.save(f.config.clone(), 0).await.0, StatusCode::CONFLICT);
    let first = f.publish(1, "publish-first").await;
    assert_eq!(first.0, StatusCode::OK, "{:?}", first.2);
    assert_eq!(first.2["version"], 1);
    assert_eq!(first.2, f.publish(1, "publish-first").await.2);
    assert_eq!(f.publish(2, "publish-first").await.0, StatusCode::CONFLICT);
    let path = "/v1/mobile/config?platform=ios&runtimeVersion=1.0.0&locale=en";
    let bearer = format!("Bearer {}", f.mobile);
    let response = request(
        &f.app,
        "GET",
        path,
        None,
        None,
        &[("authorization", &bearer)],
    )
    .await;
    assert_eq!(response.0, StatusCode::OK);
    assert_eq!(response.2["tenantId"], f.merchant.to_string());
    assert_eq!(response.1["x-config-checksum"], checksum(&response.2));
    assert_eq!(response.1["cache-control"], "private, no-cache");
    let etag = response.1["etag"].to_str().unwrap();
    assert_eq!(
        request(
            &f.app,
            "GET",
            path,
            None,
            None,
            &[("authorization", &bearer), ("if-none-match", etag)]
        )
        .await
        .0,
        StatusCode::NOT_MODIFIED
    );
    assert_eq!(
        request(&f.app, "GET", path, None, None, &[("if-none-match", etag)])
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &f.app,
            "GET",
            &path.replace("ios", "android"),
            None,
            None,
            &[("authorization", &bearer)]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &f.app,
            "GET",
            &path.replace("1.0.0", "2.0.0"),
            None,
            None,
            &[("authorization", &bearer)]
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &f.app,
            "GET",
            &format!("{path}&tenantId={}", f.other),
            None,
            None,
            &[("authorization", &bearer)]
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let mut config = f.config.clone();
    config["brand"]["displayName"] = json!("Updated");
    assert_eq!(f.save(config, 2).await.0, StatusCode::OK);
    assert_eq!(f.publish(3, "publish-second").await.2["version"], 2);
    let rollback = request(
        &f.app,
        "POST",
        &f.path("rollback"),
        Some(&f.owner),
        Some(json!({"expectedRevision":4,"targetVersion":1})),
        &[("idempotency-key", "rollback-first")],
    )
    .await;
    assert_eq!(rollback.0, StatusCode::OK);
    assert_eq!(rollback.2["version"], 3);
    assert_eq!(rollback.2["rollbackTarget"], 2);
    assert_eq!(
        rollback.2["config"]["brand"]["displayName"],
        f.config["brand"]["displayName"]
    );
    assert!(sqlx::query("UPDATE mobile.config_versions SET checksum=$1")
        .bind("b".repeat(64))
        .execute(&f.pool)
        .await
        .is_err());
    assert!(sqlx::query("DELETE FROM mobile.audit_events")
        .execute(&f.pool)
        .await
        .is_err());
    sqlx::query("UPDATE mobile.app_sessions SET expires_at=now()-interval '1 second',created_at=now()-interval '1 hour'").execute(&f.pool).await.unwrap();
    assert_eq!(
        request(
            &f.app,
            "GET",
            path,
            None,
            None,
            &[("authorization", &bearer), ("if-none-match", etag)]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM mobile.audit_events WHERE action IN ('config.published','config.rolled_back')").fetch_one(&f.pool).await.unwrap();
    assert_eq!(count, 3);
}
#[sqlx::test(migrations = "../../migrations")]
async fn mobile_concurrent_publication_has_one_winner(pool: PgPool) {
    let f = fixture(pool).await;
    f.save(f.config.clone(), 0).await;
    let (a, b) = tokio::join!(
        f.publish(1, "concurrent-one"),
        f.publish(1, "concurrent-two")
    );
    assert!(
        (a.0 == StatusCode::OK && b.0 == StatusCode::CONFLICT)
            || (b.0 == StatusCode::OK && a.0 == StatusCode::CONFLICT)
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM mobile.config_versions")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}
#[sqlx::test(migrations = "../../migrations")]
async fn mobile_build_queue_is_scoped_idempotent_and_secret_free(pool: PgPool) {
    let f = fixture(pool).await;
    let icon = Uuid::new_v4();
    let splash = Uuid::new_v4();
    for (id, kind) in [(icon, "icon"), (splash, "splash")] {
        sqlx::query("INSERT INTO mobile.assets(id,merchant_id,url,kind,verified,checksum) VALUES($1,$2,'https://assets.example.test/test.png',$3,true,$4)").bind(id).bind(f.merchant).bind(kind).bind("a".repeat(64)).execute(&f.pool).await.unwrap();
    }
    let body = json!({"platform":"ios","manifest":{"merchantId":f.merchant,"appDisplayName":"Demo","iosBundleId":"com.rocento.test","androidApplicationId":"com.rocento.test","iconAssetId":icon,"splashAssetId":splash,"associatedDomains":["shop.example.test"],"environment":"staging","storeAccountRef":"store-account/test","sourceCommit":"a".repeat(40),"runtimeVersion":"1.0.0"}});
    let path = format!(
        "/v1/merchants/{}/app-builds?environment=staging",
        f.merchant
    );
    let result = request(
        &f.app,
        "POST",
        &path,
        Some(&f.owner),
        Some(body.clone()),
        &[("idempotency-key", "queue-build-first")],
    )
    .await;
    assert_eq!(result.0, StatusCode::ACCEPTED, "{:?}", result.2);
    assert_eq!(result.2["status"], "queued");
    assert!(result.2.get("manifest").is_none());
    assert_eq!(
        result.2,
        request(
            &f.app,
            "POST",
            &path,
            Some(&f.owner),
            Some(body.clone()),
            &[("idempotency-key", "queue-build-first")]
        )
        .await
        .2
    );
    assert_eq!(
        request(
            &f.app,
            "POST",
            &path,
            Some(&f.designer),
            Some(body),
            &[("idempotency-key", "designer-no-build")]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let other = path.replace(&f.merchant.to_string(), &f.other.to_string());
    assert_eq!(
        request(&f.app, "GET", &other, Some(&f.owner), None, &[])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let id = result.2["id"].as_str().unwrap();
    let detail = format!(
        "/v1/merchants/{}/app-builds/{id}?environment=staging",
        f.other
    );
    assert_eq!(
        request(&f.app, "GET", &detail, Some(&f.owner), None, &[])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn mobile_production_publishes_directly_and_keeps_merchants_and_environments_separate(
    pool: PgPool,
) {
    let f = fixture(pool).await;
    let prod = f.path("draft").replace("staging", "production");
    let prod_publish = f.path("publish").replace("staging", "production");
    assert_eq!(
        request(
            &f.app,
            "PUT",
            &prod,
            Some(&f.owner),
            Some(json!({"expectedRevision":0,"config":f.config})),
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &f.app,
            "POST",
            &prod_publish,
            Some(&f.owner),
            Some(json!({"expectedRevision":1})),
            &[("idempotency-key", "production-first")]
        )
        .await
        .0,
        StatusCode::OK
    );
    f.save(f.config.clone(), 0).await;
    assert_eq!(f.publish(1, "staging-first").await.0, StatusCode::OK);
    assert_eq!(
        request(
            &f.app,
            "POST",
            &prod_publish,
            Some(&f.owner),
            Some(json!({"expectedRevision":1})),
            &[("idempotency-key", "production-first")]
        )
        .await
        .0,
        StatusCode::OK
    );
    // A second owner and enrolled app receive only their own config.
    let owner = admin(&f.pool, Some(f.other), "owner").await;
    let config: Value = serde_json::from_str(include_str!(
        "../../domain-mobile/contract/v1/fixtures/merchant-2.json"
    ))
    .unwrap();
    let draft = f
        .path("draft")
        .replace(&f.merchant.to_string(), &f.other.to_string());
    let publish = f
        .path("publish")
        .replace(&f.merchant.to_string(), &f.other.to_string());
    assert_eq!(
        request(
            &f.app,
            "PUT",
            &draft,
            Some(&owner),
            Some(json!({"expectedRevision":0,"config":config})),
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &f.app,
            "POST",
            &publish,
            Some(&owner),
            Some(json!({"expectedRevision":1})),
            &[("idempotency-key", "staging-first")]
        )
        .await
        .0,
        StatusCode::OK
    );
    let identity = Uuid::new_v4();
    let token = "merchant-two-session-000000000000000000000000";
    sqlx::query("INSERT INTO mobile.app_identities(id,merchant_id,environment,platform,identifier,store_account_ref) VALUES($1,$2,'staging','ios','com.rocento.second','store-account/second')").bind(identity).bind(f.other).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO mobile.app_sessions(token_hash,identity_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')").bind(token_hash(token)).bind(identity).execute(&f.pool).await.unwrap();
    for (token, merchant, name) in [
        (f.mobile.as_str(), f.merchant, "Demo Market"),
        (token, f.other, "Demo Boutique"),
    ] {
        let bearer = format!("Bearer {token}");
        let response = request(
            &f.app,
            "GET",
            "/v1/mobile/config?platform=ios&runtimeVersion=1.0.0&locale=ar",
            None,
            None,
            &[("authorization", &bearer)],
        )
        .await;
        assert_eq!(response.0, StatusCode::OK);
        assert_eq!(response.2["tenantId"], merchant.to_string());
        assert_eq!(response.2["brand"]["displayName"], name);
    }
    // Direct production publication does not change either enrolled staging app.
    let mut changed = f.config.clone();
    changed["brand"]["displayName"] = json!("Direct production change");
    assert_eq!(
        request(
            &f.app,
            "PUT",
            &prod,
            Some(&f.owner),
            Some(json!({"expectedRevision":2,"config":changed})),
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &f.app,
            "POST",
            &prod_publish,
            Some(&f.owner),
            Some(json!({"expectedRevision":3})),
            &[("idempotency-key", "production-changed")]
        )
        .await
        .0,
        StatusCode::OK
    );
    let bearer = format!("Bearer {}", f.mobile);
    let response = request(
        &f.app,
        "GET",
        "/v1/mobile/config?platform=ios&runtimeVersion=1.0.0&locale=ar",
        None,
        None,
        &[("authorization", &bearer)],
    )
    .await;
    assert_eq!(response.0, StatusCode::OK);
    assert_eq!(response.2["brand"]["displayName"], "Demo Market");
}

#[sqlx::test(migrations = "../../migrations")]
async fn studio_memberships_assets_and_audits_are_scoped(pool: PgPool) {
    let f = fixture(pool).await;
    for (token, count) in [(&f.owner, 1), (&f.designer, 1), (&f.outsider, 0)] {
        let (status, _, rows) = request(
            &f.app,
            "GET",
            "/v1/mobile/merchants",
            Some(token),
            None,
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(rows.as_array().unwrap().len(), count);
        if count == 1 {
            assert_eq!(rows[0]["id"], f.merchant.to_string());
        }
    }
    assert_eq!(
        request(&f.app, "GET", "/v1/mobile/merchants", None, None, &[])
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    f.save(f.config.clone(), 0).await;
    let assets = format!("/v1/merchants/{}/assets?environment=staging", f.merchant);
    let (_, _, rows) = request(&f.app, "GET", &assets, Some(&f.owner), None, &[]).await;
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["id"], f.config["brand"]["logoAssetId"]);
    let (_, _, empty) = request(
        &f.app,
        "GET",
        &format!("{assets}&beforeId={}", rows[0]["id"].as_str().unwrap()),
        Some(&f.owner),
        None,
        &[],
    )
    .await;
    assert!(empty.as_array().unwrap().is_empty());
    for path in [assets.clone(), f.path("audit")] {
        assert_eq!(
            request(&f.app, "GET", &path, Some(&f.outsider), None, &[])
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request(
                &f.app,
                "GET",
                &path.replace(&f.merchant.to_string(), &f.other.to_string()),
                Some(&f.owner),
                None,
                &[]
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    let (_, _, log) = request(&f.app, "GET", &f.path("audit"), Some(&f.owner), None, &[]).await;
    assert_eq!(log[0]["action"], "config.draft_saved");
    assert_eq!(log[0]["details"]["after"], f.config);
    let (_, _, empty) = request(
        &f.app,
        "GET",
        &format!(
            "{}&beforeId={}",
            f.path("audit"),
            log[0]["id"].as_str().unwrap()
        ),
        Some(&f.owner),
        None,
        &[],
    )
    .await;
    assert!(empty.as_array().unwrap().is_empty());
    let (_, _, empty) = request(
        &f.app,
        "GET",
        &f.path("audit").replace("staging", "production"),
        Some(&f.owner),
        None,
        &[],
    )
    .await;
    assert!(empty.as_array().unwrap().is_empty());
    sqlx::query("UPDATE mobile.merchants SET active=false WHERE id=$1")
        .bind(f.merchant)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        request(&f.app, "GET", &assets, Some(&f.owner), None, &[])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert!(request(
        &f.app,
        "GET",
        "/v1/mobile/merchants",
        Some(&f.owner),
        None,
        &[]
    )
    .await
    .2
    .as_array()
    .unwrap()
    .is_empty());
}

#[sqlx::test(migrations = "../../migrations")]
async fn studio_upload_roundtrip_sanitizes_bytes_and_restricts_reads(pool: PgPool) {
    use axum::{extract::State, http::Method, response::IntoResponse, routing::any};
    use std::{collections::HashMap, sync::Arc};
    let f = fixture(pool).await;
    type Objects = Arc<tokio::sync::Mutex<HashMap<String, Vec<u8>>>>;
    async fn storage(
        State(objects): State<Objects>,
        req: axum::extract::Request,
    ) -> axum::response::Response {
        let path = req.uri().path().to_string();
        match *req.method() {
            Method::PUT => {
                let bytes = to_bytes(req.into_body(), 6 * 1024 * 1024).await.unwrap();
                objects.lock().await.insert(path, bytes.to_vec());
                StatusCode::OK.into_response()
            }
            Method::GET => objects.lock().await.get(&path).cloned().map_or_else(
                || StatusCode::NOT_FOUND.into_response(),
                IntoResponse::into_response,
            ),
            Method::DELETE => {
                objects.lock().await.remove(&path);
                StatusCode::NO_CONTENT.into_response()
            }
            _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
        }
    }
    let objects: Objects = Default::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().fallback(any(storage)).with_state(objects),
        )
        .await
        .unwrap();
    });
    let media = infra_media::Store::new(endpoint, "fixture", "fixture-secret").unwrap();
    let security = infra_auth::Security::new(
        "mobile-fixture-secret-at-least-32-characters".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let app = api_gateway::mobile::router_with_media(
        App::new(
            f.pool.clone(),
            security,
            vec!["http://localhost:5173".into()],
        ),
        Some(media),
    );
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(16, 12)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    png.get_mut().resize(200_000, 0); // Exceeds the config body limit; upload has its own bounded limit.
    png.get_mut()
        .extend_from_slice(b"<script>discard metadata</script>");
    async fn upload(
        app: &Router,
        merchant: Uuid,
        token: &str,
        bytes: &[u8],
    ) -> (StatusCode, Value) {
        let mut body=b"--mobile-fixture\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\nStore logo\r\n--mobile-fixture\r\nContent-Disposition: form-data; name=\"file\"; filename=\"logo.png\"\r\nContent-Type: image/png\r\n\r\n".to_vec();
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n--mobile-fixture--\r\n");
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/v1/merchants/{merchant}/assets?environment=staging"
                    ))
                    .header(
                        "content-type",
                        "multipart/form-data; boundary=mobile-fixture",
                    )
                    .header("x-commerce-request", "1")
                    .header("cookie", format!("admin_session={token}"))
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = res.status();
        let body = to_bytes(res.into_body(), 10000).await.unwrap();
        (
            status,
            serde_json::from_slice(&body)
                .unwrap_or_else(|_| json!({"raw":String::from_utf8_lossy(&body)})),
        )
    }
    let operator = admin(&f.pool, Some(f.merchant), "operator").await;
    assert_eq!(
        upload(&app, f.merchant, &operator, png.get_ref()).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        upload(&app, f.other, &f.owner, png.get_ref()).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        upload(&app, f.merchant, &f.owner, b"<svg onload='alert(1)'/>")
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let (status, asset) = upload(&app, f.merchant, &f.designer, png.get_ref()).await;
    assert_eq!(status, StatusCode::CREATED, "{asset}");
    assert_eq!(asset["width"], 16);
    assert_eq!(asset["height"], 12);
    assert!(asset["url"].is_null());
    let id = asset["id"].as_str().unwrap();
    let path = format!("/v1/merchants/{}/assets/{id}/content", f.merchant);
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&path)
                .header("cookie", format!("admin_session={operator}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["content-type"], "image/png");
    assert!(res.headers()["cache-control"]
        .to_str()
        .unwrap()
        .contains("no-store"));
    let bytes = to_bytes(res.into_body(), 10000).await.unwrap();
    assert_eq!(asset["checksum"], domain_mobile::bytes_checksum(&bytes));
    assert!(!String::from_utf8_lossy(&bytes).contains("script"));
    assert_eq!(
        request(&app, "GET", &path, Some(&f.outsider), None, &[])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    // Membership in the URL merchant cannot grant access to another merchant's object.
    let other_owner = admin(&f.pool, Some(f.other), "owner").await;
    assert_eq!(
        request(
            &app,
            "GET",
            &path.replace(&f.merchant.to_string(), &f.other.to_string()),
            Some(&other_owner),
            None,
            &[]
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let mut config = f.config.clone();
    config["brand"]["logoAssetId"] = asset["id"].clone();
    config["screens"]["home"]["sections"][0]["props"]["imageAssetId"] = asset["id"].clone();
    assert_eq!(f.save(config, 0).await.0, StatusCode::OK);
    assert_eq!(
        f.publish(1, "studio-upload-release").await.0,
        StatusCode::OK
    );
    assert_eq!(
        request(&app, "GET", &f.path("audit"), Some(&operator), None, &[])
            .await
            .2
            .as_array()
            .unwrap()
            .len(),
        3
    );
    let native_path =
        format!("/v1/mobile/assets/{id}/content?platform=ios&runtimeVersion=1.0.0&locale=en");
    let native = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&native_path)
                .header("authorization", format!("Bearer {}", f.mobile))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(native.status(), StatusCode::OK);
    assert_eq!(native.headers()["content-type"], "image/png");
    assert_eq!(native.headers()["cache-control"], "private, no-store");
    assert_eq!(native.headers()["vary"], "Authorization");
    assert_eq!(
        native.headers()["x-asset-checksum"],
        asset["checksum"].as_str().unwrap()
    );
    assert_eq!(to_bytes(native.into_body(), 10000).await.unwrap(), bytes);
    assert_eq!(
        request(&app, "GET", &native_path, Some(&f.owner), None, &[])
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    server.abort();
}

async fn production_identity(f: &Fixture, platform: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO mobile.app_identities(id,merchant_id,environment,platform,identifier,store_account_ref) VALUES($1,$2,'production',$3,$4,'internal-test-only')")
        .bind(id).bind(f.merchant).bind(platform).bind(format!("com.rocento.enrollment.{platform}")).execute(&f.pool).await.unwrap();
    id
}
async fn invitation(f: &Fixture, id: Uuid) -> String {
    let r = request(
        &f.app,
        "POST",
        &format!("/v1/merchants/{}/app-devices/invitations", f.merchant),
        Some(&f.owner),
        Some(json!({"identityId":id})),
        &[],
    )
    .await;
    assert_eq!(r.0, StatusCode::OK, "{}", r.2);
    assert_eq!(r.1["cache-control"], "no-store");
    r.2["code"].as_str().unwrap().into()
}
fn enrollment(f: &Fixture, code: &str) -> Value {
    json!({"code":code,"merchantId":f.merchant,"platform":"ios","identifier":"com.rocento.enrollment.ios"})
}
#[sqlx::test(migrations = "../../migrations")]
async fn mobile_enrollment_binding_single_use_renewal_and_revocation(pool: PgPool) {
    let f = fixture(pool).await;
    let identity = production_identity(&f, "ios").await;
    let code = invitation(&f, identity).await;
    for (field, value) in [
        ("merchantId", json!(f.other)),
        ("platform", json!("android")),
        ("identifier", json!("com.other.app")),
    ] {
        let mut body = enrollment(&f, &code);
        body[field] = value;
        assert_eq!(
            request(&f.app, "POST", "/v1/mobile/enroll", None, Some(body), &[])
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    let body = enrollment(&f, &code);
    let (a, b) = tokio::join!(
        request(
            &f.app,
            "POST",
            "/v1/mobile/enroll",
            None,
            Some(body.clone()),
            &[]
        ),
        request(&f.app, "POST", "/v1/mobile/enroll", None, Some(body), &[])
    );
    let (session, denied) = if a.0 == StatusCode::OK {
        (a, b)
    } else {
        (b, a)
    };
    assert_eq!(session.0, StatusCode::OK, "{}", session.2);
    assert_eq!(denied.0, StatusCode::UNAUTHORIZED);
    let credential = session.2["deviceToken"].as_str().unwrap();
    let mut renew = json!({"deviceToken":credential,"merchantId":f.merchant,"platform":"ios","identifier":"com.rocento.enrollment.ios"});
    renew["merchantId"] = json!(f.other);
    assert_eq!(
        request(
            &f.app,
            "POST",
            "/v1/mobile/session",
            None,
            Some(renew.clone()),
            &[]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    renew["merchantId"] = json!(f.merchant);
    let renewed = request(
        &f.app,
        "POST",
        "/v1/mobile/session",
        None,
        Some(renew.clone()),
        &[],
    )
    .await;
    assert_eq!(renewed.0, StatusCode::OK);
    assert!(renewed.2["deviceToken"].is_null());
    let url = "/v1/mobile/config?platform=ios&runtimeVersion=1.0.0&locale=en";
    let bearer = format!("Bearer {}", session.2["accessToken"].as_str().unwrap());
    assert_eq!(
        request(
            &f.app,
            "GET",
            url,
            None,
            None,
            &[("authorization", &bearer)]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let bearer = format!("Bearer {}", renewed.2["accessToken"].as_str().unwrap());
    assert_eq!(
        request(
            &f.app,
            "GET",
            url,
            None,
            None,
            &[("authorization", &bearer)]
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let path = format!(
        "/v1/merchants/{}/app-devices/{}/revoke",
        f.merchant,
        session.2["deviceId"].as_str().unwrap()
    );
    assert_eq!(
        request(&f.app, "POST", &path, Some(&f.designer), None, &[])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &f.app,
            "POST",
            &path.replace(&f.merchant.to_string(), &f.other.to_string()),
            Some(&f.owner),
            None,
            &[]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(&f.app, "POST", &path, Some(&f.owner), None, &[])
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &f.app,
            "GET",
            url,
            None,
            None,
            &[("authorization", &bearer), ("if-none-match", "*")]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&f.app, "POST", "/v1/mobile/session", None, Some(renew), &[])
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let audit: String = sqlx::query_scalar(
        "SELECT string_agg(details::text,' ') FROM mobile.audit_events WHERE merchant_id=$1",
    )
    .bind(f.merchant)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(!audit.contains(&code));
    assert!(!audit.contains(credential));
}
#[sqlx::test(migrations = "../../migrations")]
async fn mobile_enrollment_expiry_roles_and_issuer_revocation(pool: PgPool) {
    let f = fixture(pool).await;
    let id = production_identity(&f, "ios").await;
    for suffix in ["identities", "invitations", ""] {
        let path = format!(
            "/v1/merchants/{}/app-devices{}",
            f.merchant,
            if suffix.is_empty() {
                String::new()
            } else {
                format!("/{suffix}")
            }
        );
        let method = if suffix == "invitations" {
            "POST"
        } else {
            "GET"
        };
        assert_eq!(
            request(
                &f.app,
                method,
                &path,
                Some(&f.designer),
                Some(json!({"identityId":id})),
                &[]
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    let code = invitation(&f, id).await;
    sqlx::query("UPDATE mobile.device_invitations SET created_at=now()-interval '20 minutes',expires_at=now()-interval '5 minutes' WHERE token_hash=$1").bind(token_hash(&code)).execute(&f.pool).await.unwrap();
    assert_eq!(
        request(
            &f.app,
            "POST",
            "/v1/mobile/enroll",
            None,
            Some(enrollment(&f, &code)),
            &[]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let code = invitation(&f, id).await;
    sqlx::query(
        "UPDATE mobile.memberships SET role='designer' WHERE merchant_id=$1 AND role='owner'",
    )
    .bind(f.merchant)
    .execute(&f.pool)
    .await
    .unwrap();
    assert_eq!(
        request(
            &f.app,
            "POST",
            "/v1/mobile/enroll",
            None,
            Some(enrollment(&f, &code)),
            &[]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn mobile_native_asset_requires_current_publication_and_device(pool: PgPool) {
    let f = fixture(pool).await;
    let id = production_identity(&f, "ios").await;
    let code = invitation(&f, id).await;
    let s = request(
        &f.app,
        "POST",
        "/v1/mobile/enroll",
        None,
        Some(enrollment(&f, &code)),
        &[],
    )
    .await
    .2;
    let token = s["accessToken"].as_str().unwrap();
    let service = domain_mobile::service::Service {
        pool: f.pool.clone(),
    };
    let asset = Uuid::parse_str("10000000-0000-0000-0000-000000000001").unwrap();
    sqlx::query("UPDATE mobile.assets SET url=NULL,object_key=$1,content_type='image/png',width=1,height=1,size_bytes=100 WHERE id=$2").bind(format!("mobile/{}/{asset}",f.merchant)).bind(asset).execute(&f.pool).await.unwrap();
    let draft = f.path("draft").replace("staging", "production");
    assert_eq!(
        request(
            &f.app,
            "PUT",
            &draft,
            Some(&f.owner),
            Some(json!({"expectedRevision":0,"config":f.config})),
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(matches!(
        service
            .native_asset(token, domain_mobile::Platform::Ios, "1.0.0", asset)
            .await,
        Err(domain_mobile::Error::NotFound)
    ));
    assert_eq!(
        request(
            &f.app,
            "POST",
            &f.path("publish").replace("staging", "production"),
            Some(&f.owner),
            Some(json!({"expectedRevision":1})),
            &[("idempotency-key", "native-publish-001")]
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        service
            .native_asset(token, domain_mobile::Platform::Ios, "1.0.0", asset)
            .await
            .unwrap()
            .0,
        format!("mobile/{}/{asset}", f.merchant)
    );
    assert!(matches!(
        service
            .native_asset(token, domain_mobile::Platform::Android, "1.0.0", asset)
            .await,
        Err(domain_mobile::Error::Unauthorized)
    ));
    assert!(matches!(
        service
            .native_asset(
                token,
                domain_mobile::Platform::Ios,
                "1.0.0",
                Uuid::parse_str("10000000-0000-0000-0000-000000000002").unwrap()
            )
            .await,
        Err(domain_mobile::Error::NotFound)
    ));
    sqlx::query("UPDATE mobile.devices SET revoked_at=now() WHERE id=$1")
        .bind(Uuid::parse_str(s["deviceId"].as_str().unwrap()).unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        service
            .native_asset(token, domain_mobile::Platform::Ios, "1.0.0", asset)
            .await,
        Err(domain_mobile::Error::Unauthorized)
    ));
}

#[sqlx::test(migrations = "../../migrations")]
async fn preview_catalog_checks_membership_before_binding_or_network(pool: PgPool) {
    let f = fixture(pool).await;
    let path = format!("/v1/merchants/{}/app-preview/catalog?locale=en", f.merchant);
    assert_eq!(
        request(&f.app, "GET", &path, None, None, &[]).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&f.app, "GET", &path, Some(&f.outsider), None, &[])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let other = format!("/v1/merchants/{}/app-preview/catalog?locale=en", f.other);
    assert_eq!(
        request(&f.app, "GET", &other, Some(&f.owner), None, &[])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (status, headers, body) = request(&f.app, "GET", &path, Some(&f.owner), None, &[]).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["issues"][0]["code"], "CATALOG_NOT_CONNECTED");
    assert_eq!(headers["cache-control"], "no-store");
}

#[sqlx::test(migrations = "../../migrations")]
async fn category_choices_require_merchant_membership(pool: PgPool) {
    let f = fixture(pool).await;
    let path = format!("/v1/merchants/{}/app-preview/categories", f.merchant);
    assert_eq!(
        request(&f.app, "GET", &path, None, None, &[]).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&f.app, "GET", &path, Some(&f.outsider), None, &[])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let foreign = format!("/v1/merchants/{}/app-preview/categories", f.other);
    assert_eq!(
        request(&f.app, "GET", &foreign, Some(&f.owner), None, &[])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn preview_variant_product_checks_membership_before_network(pool: PgPool) {
    let f = fixture(pool).await;
    let path = format!(
        "/v1/merchants/{}/app-preview/products/{}?locale=en&latitude=30&longitude=31",
        f.merchant,
        Uuid::new_v4()
    );
    assert_eq!(
        request(&f.app, "GET", &path, None, None, &[]).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&f.app, "GET", &path, Some(&f.outsider), None, &[])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let other = path.replace(&f.merchant.to_string(), &f.other.to_string());
    assert_eq!(
        request(&f.app, "GET", &other, Some(&f.owner), None, &[])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn preview_sessions_isolate_tenants_recover_revisions_and_expire(pool: PgPool) {
    let f = fixture(pool).await;
    assert_eq!(f.save(f.config.clone(), 0).await.0, StatusCode::OK);
    let start = format!(
        "/v1/merchants/{}/app-preview/sessions?environment=staging",
        f.merchant
    );
    assert_eq!(
        request(&f.app, "POST", &start, Some(&f.outsider), None, &[])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (status, _, session) = request(&f.app, "POST", &start, Some(&f.designer), None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    let id = session["id"].as_str().unwrap();
    let secret = session["code"].as_str().unwrap().split('.').nth(1).unwrap();
    let bearer = format!("Bearer {secret}");
    let query = format!(
        "merchantId={}&environment=staging&runtimeVersion=1.2.0",
        f.merchant
    );
    let path = format!("/v1/mobile/preview/{id}?{query}");
    assert_eq!(
        request(
            &f.app,
            "GET",
            &path,
            None,
            None,
            &[("authorization", &format!("Bearer {}", f.mobile))]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let cross_tenant = path.replace(&f.merchant.to_string(), &f.other.to_string());
    assert_eq!(
        request(
            &f.app,
            "GET",
            &cross_tenant,
            None,
            None,
            &[("authorization", &bearer)]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &f.app,
            "GET",
            &path.replace("staging", "production"),
            None,
            None,
            &[("authorization", &bearer)]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, headers, config) = request(
        &f.app,
        "GET",
        &path,
        None,
        None,
        &[("authorization", &bearer)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["x-preview-revision"], "1");
    assert_eq!(config["configVersion"], 0);
    let ack_path = format!("/v1/mobile/preview/{id}/ack?{query}");
    let ack = json!({"revision":1,"checksum":checksum(&config)});
    assert_eq!(
        request(
            &f.app,
            "POST",
            &ack_path,
            None,
            Some(json!({"revision":2,"checksum":checksum(&config)})),
            &[("authorization", &bearer)]
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &f.app,
            "POST",
            &ack_path,
            None,
            Some(ack),
            &[("authorization", &bearer)]
        )
        .await
        .0,
        StatusCode::OK
    );
    let status_path = format!("/v1/merchants/{}/app-preview/sessions/{id}", f.merchant);
    let result = request(&f.app, "GET", &status_path, Some(&f.designer), None, &[]).await;
    assert_eq!(result.2["appliedRevision"], 1);
    assert_eq!(
        request(&f.app, "GET", &status_path, Some(&f.owner), None, &[])
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let mut next = f.config.clone();
    next["brand"]["radiusToken"] = json!("large");
    assert_eq!(f.save(next.clone(), 1).await.0, StatusCode::OK);
    assert_eq!(f.save(next, 2).await.0, StatusCode::OK);
    let (_, h, c) = request(
        &f.app,
        "GET",
        &path,
        None,
        None,
        &[("authorization", &bearer)],
    )
    .await;
    assert_eq!(h["x-preview-revision"], "3");
    assert_eq!(c["brand"]["radiusToken"], "large");
    assert_eq!(
        request(
            &f.app,
            "POST",
            &ack_path,
            None,
            Some(json!({"revision":3,"checksum":checksum(&c)})),
            &[("authorization", &bearer)]
        )
        .await
        .0,
        StatusCode::OK
    );
    sqlx::query(
        "UPDATE mobile.preview_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
    )
    .bind(Uuid::parse_str(id).unwrap())
    .execute(&f.pool)
    .await
    .unwrap();
    assert_eq!(
        request(
            &f.app,
            "GET",
            &path,
            None,
            None,
            &[("authorization", &bearer)]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (_, _, session2) = request(&f.app, "POST", &start, Some(&f.designer), None, &[]).await;
    let id2 = session2["id"].as_str().unwrap();
    let bearer2 = format!(
        "Bearer {}",
        session2["code"]
            .as_str()
            .unwrap()
            .split('.')
            .nth(1)
            .unwrap()
    );
    let stop_path = format!("/v1/merchants/{}/app-preview/sessions/{id2}", f.merchant);
    assert_eq!(
        request(&f.app, "DELETE", &stop_path, Some(&f.designer), None, &[])
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &f.app,
            "GET",
            &format!("/v1/mobile/preview/{id2}?{query}"),
            None,
            None,
            &[("authorization", &bearer2)]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn preview_sessions_validate_capabilities_assets_and_issuer_access(pool: PgPool) {
    let f = fixture(pool).await;
    let mut config = f.config.clone();
    config["compatibility"]["minIosRuntime"] = json!("1.2.0");
    assert_eq!(f.save(config.clone(), 0).await.0, StatusCode::OK);
    let service = domain_mobile::service::Service {
        pool: f.pool.clone(),
    };
    let actor: Uuid =
        sqlx::query_scalar("SELECT admin_id FROM admin_iam.sessions WHERE token_hash=$1")
            .bind(infra_auth::digest(&f.designer))
            .fetch_one(&f.pool)
            .await
            .unwrap();
    let session = service
        .start_preview(f.merchant, domain_mobile::Environment::Staging, actor)
        .await
        .unwrap();
    let id = Uuid::parse_str(session["id"].as_str().unwrap()).unwrap();
    let token = session["code"].as_str().unwrap().split('.').nth(1).unwrap();
    let env = domain_mobile::Environment::Staging;
    assert!(matches!(
        service
            .preview_snapshot(id, token, f.merchant, env, "1.0.0")
            .await,
        Err(domain_mobile::Error::Incompatible)
    ));
    service
        .preview_snapshot(id, token, f.merchant, env, "1.2.0")
        .await
        .unwrap();
    assert!(matches!(
        service
            .acknowledge_preview(
                id,
                token,
                f.merchant,
                env,
                domain_mobile::preview::PreviewAck {
                    revision: 1,
                    checksum: "wrong".into()
                }
            )
            .await,
        Err(domain_mobile::Error::Conflict)
    ));
    config["brand"]["logoAssetId"] = json!("10000000-0000-0000-0000-000000000002");
    assert_eq!(f.save(config, 1).await.0, StatusCode::OK);
    assert!(matches!(
        service
            .preview_snapshot(id, token, f.merchant, env, "1.2.0")
            .await,
        Err(domain_mobile::Error::Invalid(_))
    ));
    assert!(matches!(
        service
            .preview_asset(
                id,
                token,
                f.merchant,
                env,
                Uuid::parse_str("10000000-0000-0000-0000-000000000002").unwrap()
            )
            .await,
        Err(domain_mobile::Error::NotFound)
    ));
    sqlx::query("DELETE FROM mobile.memberships WHERE merchant_id=$1 AND admin_id=$2")
        .bind(f.merchant)
        .bind(actor)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        service
            .preview_snapshot(id, token, f.merchant, env, "1.2.0")
            .await,
        Err(domain_mobile::Error::Unauthorized)
    ));
}

#[sqlx::test(migrations = "../../migrations")]
async fn worker_frames_require_session_creator_tenant_and_active_lease(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let start = format!(
        "/v1/merchants/{}/app-preview/sessions?environment=staging",
        f.merchant
    );
    let (_, _, session) = request(&f.app, "POST", &start, Some(&f.designer), None, &[]).await;
    let id = session["id"].as_str().unwrap();
    let frame = format!(
        "/v1/merchants/{}/app-preview/sessions/{id}/frame",
        f.merchant
    );
    assert_eq!(
        request(&f.app, "GET", &frame, None, None, &[]).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&f.app, "GET", &frame, Some(&f.outsider), None, &[])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(&f.app, "GET", &frame, Some(&f.owner), None, &[])
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let other = frame.replace(&f.merchant.to_string(), &f.other.to_string());
    assert_eq!(
        request(&f.app, "GET", &other, Some(&f.designer), None, &[])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    sqlx::query(
        "UPDATE mobile.preview_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
    )
    .bind(Uuid::parse_str(id).unwrap())
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        request(&f.app, "GET", &frame, Some(&f.designer), None, &[])
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn interactive_preview_rejects_cross_tenant_creator_and_expired_access(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let start = format!(
        "/v1/merchants/{}/app-preview/sessions?environment=staging",
        f.merchant
    );
    let (_, _, session) = request(&f.app, "POST", &start, Some(&f.designer), None, &[]).await;
    let id = session["id"].as_str().unwrap();
    for (suffix, method, body) in [
        ("video", "GET", None),
        (
            "input",
            "POST",
            Some(json!({"sequence":1,"kind":"tap","x":0.5,"y":0.5})),
        ),
    ] {
        let path = format!(
            "/v1/merchants/{}/app-preview/sessions/{id}/{suffix}",
            f.merchant
        );
        assert_eq!(
            request(&f.app, method, &path, None, body.clone(), &[])
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(&f.app, method, &path, Some(&f.outsider), body.clone(), &[])
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request(&f.app, method, &path, Some(&f.owner), body.clone(), &[])
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        let other = path.replace(&f.merchant.to_string(), &f.other.to_string());
        assert_eq!(
            request(&f.app, method, &other, Some(&f.designer), body.clone(), &[])
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    sqlx::query("UPDATE mobile.preview_sessions SET revoked_at=now() WHERE id=$1")
        .bind(Uuid::parse_str(id).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    for (suffix, method, body) in [
        ("video", "GET", None),
        (
            "input",
            "POST",
            Some(json!({"sequence":2,"kind":"text","text":"milk"})),
        ),
    ] {
        let path = format!(
            "/v1/merchants/{}/app-preview/sessions/{id}/{suffix}",
            f.merchant
        );
        assert_eq!(
            request(&f.app, method, &path, Some(&f.designer), body, &[])
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn android_preview_persists_platform_and_checks_android_runtime(pool: PgPool) {
    let f = fixture(pool).await;
    let mut config = f.config.clone();
    config["compatibility"]["minIosRuntime"] = json!("1.0.0");
    config["compatibility"]["minAndroidRuntime"] = json!("1.2.0");
    assert_eq!(f.save(config, 0).await.0, StatusCode::OK);
    let service = domain_mobile::service::Service {
        pool: f.pool.clone(),
    };
    let actor: Uuid =
        sqlx::query_scalar("SELECT admin_id FROM admin_iam.sessions WHERE token_hash=$1")
            .bind(infra_auth::digest(&f.designer))
            .fetch_one(&f.pool)
            .await
            .unwrap();
    let env = domain_mobile::Environment::Staging;
    let session = service
        .start_platform_preview(f.merchant, env, actor, domain_mobile::Platform::Android)
        .await
        .unwrap();
    let id = Uuid::parse_str(session["id"].as_str().unwrap()).unwrap();
    let token = session["code"].as_str().unwrap().split('.').nth(1).unwrap();
    assert_eq!(
        service
            .preview_status(f.merchant, actor, id)
            .await
            .unwrap()
            .platform,
        "android"
    );
    assert!(matches!(
        service
            .preview_snapshot(id, token, f.merchant, env, "1.0.0")
            .await,
        Err(domain_mobile::Error::Incompatible)
    ));
    service
        .preview_snapshot(id, token, f.merchant, env, "1.2.0")
        .await
        .unwrap();
    service.stop_preview(f.merchant, actor, id).await.unwrap();
    assert!(service
        .preview_snapshot(id, token, f.merchant, env, "1.2.0")
        .await
        .is_err());
}

#[sqlx::test(migrations = "../../migrations")]
async fn react_native_preview_persists_implementation_and_revokes_previous_session(pool: PgPool) {
    let f = fixture(pool).await;
    assert_eq!(f.save(f.config.clone(), 0).await.0, StatusCode::OK);
    let service = domain_mobile::service::Service {
        pool: f.pool.clone(),
    };
    let actor: Uuid =
        sqlx::query_scalar("SELECT admin_id FROM admin_iam.sessions WHERE token_hash=$1")
            .bind(infra_auth::digest(&f.designer))
            .fetch_one(&f.pool)
            .await
            .unwrap();
    let env = domain_mobile::Environment::Staging;
    let first = service
        .start_platform_preview(f.merchant, env, actor, domain_mobile::Platform::Ios)
        .await
        .unwrap();
    let second = service
        .start_implementation_preview(
            f.merchant,
            env,
            actor,
            domain_mobile::Platform::Android,
            "react-native",
        )
        .await
        .unwrap();
    let id = Uuid::parse_str(second["id"].as_str().unwrap()).unwrap();
    let status = service.preview_status(f.merchant, actor, id).await.unwrap();
    assert_eq!(status.platform, "android");
    assert_eq!(status.implementation, "react-native");
    let previous = Uuid::parse_str(first["id"].as_str().unwrap()).unwrap();
    assert!(service
        .preview_status(f.merchant, actor, previous)
        .await
        .unwrap()
        .revoked_at
        .is_some());
    assert!(service
        .start_implementation_preview(
            f.merchant,
            env,
            actor,
            domain_mobile::Platform::Ios,
            "arbitrary-code"
        )
        .await
        .is_err());
}

#[sqlx::test(migrations = "../../migrations")]
async fn android_ec2_controls_require_owner_and_fixed_merchant(pool: PgPool) {
    let f = fixture(pool).await;
    std::env::set_var("MOBILE_ANDROID_PREVIEW_MERCHANT", f.merchant.to_string());
    let path = format!("/v1/merchants/{}/app-preview/instance", f.merchant);
    for (token, expected) in [
        (None, StatusCode::UNAUTHORIZED),
        (Some(f.designer.as_str()), StatusCode::FORBIDDEN),
        (Some(f.outsider.as_str()), StatusCode::FORBIDDEN),
    ] {
        assert_eq!(
            request(
                &f.app,
                "POST",
                &path,
                token,
                Some(json!({"action":"stop"})),
                &[]
            )
            .await
            .0,
            expected
        );
    }
    assert_eq!(
        request(
            &f.app,
            "POST",
            &path.replace(&f.merchant.to_string(), &f.other.to_string()),
            Some(&f.owner),
            Some(json!({"action":"start"})),
            &[]
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &f.app,
            "POST",
            &path,
            Some(&f.owner),
            Some(json!({"action":"terminate"})),
            &[]
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &f.app,
            "POST",
            &path,
            Some(&f.owner),
            Some(json!({"action":"start","instanceId":"i-other"})),
            &[]
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let request_without_csrf = Request::builder()
        .method("POST")
        .uri(&path)
        .header("content-type", "application/json")
        .header("cookie", format!("admin_session={}", f.owner))
        .body(Body::from(r#"{"action":"start"}"#))
        .unwrap();
    assert_eq!(
        f.app
            .clone()
            .oneshot(request_without_csrf)
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    std::env::remove_var("MOBILE_ANDROID_PREVIEW_MERCHANT");
}

#[sqlx::test(migrations = "../../migrations")]
async fn worker_preview_concurrent_starts_preserve_winning_capability(pool: PgPool) {
    let f = fixture(pool).await;
    let service = domain_mobile::service::Service {
        pool: f.pool.clone(),
    };
    let actor: Uuid =
        sqlx::query_scalar("SELECT admin_id FROM admin_iam.sessions WHERE token_hash=$1")
            .bind(infra_auth::digest(&f.designer))
            .fetch_one(&f.pool)
            .await
            .unwrap();
    let env = domain_mobile::Environment::Staging;
    let (a, b) = tokio::join!(
        service.start_worker_preview(
            f.merchant,
            env,
            actor,
            domain_mobile::Platform::Android,
            "native"
        ),
        service.start_worker_preview(
            f.merchant,
            env,
            actor,
            domain_mobile::Platform::Android,
            "native"
        )
    );
    let winner = match (a, b) {
        (Ok(value), Err(domain_mobile::Error::Conflict))
        | (Err(domain_mobile::Error::Conflict), Ok(value)) => value,
        other => panic!("Expected one successful reservation and one conflict: {other:?}"),
    };
    let id = Uuid::parse_str(winner["id"].as_str().unwrap()).unwrap();
    assert!(service
        .preview_status(f.merchant, actor, id)
        .await
        .unwrap()
        .revoked_at
        .is_none());
    assert!(matches!(
        service
            .start_worker_preview(
                f.merchant,
                env,
                actor,
                domain_mobile::Platform::Android,
                "native"
            )
            .await,
        Err(domain_mobile::Error::Conflict)
    ));
    let token = winner["code"].as_str().unwrap().split_once('.').unwrap().1;
    let valid: bool = sqlx::query_scalar(
        "SELECT token_hash=$2 AND revoked_at IS NULL FROM mobile.preview_sessions WHERE id=$1",
    )
    .bind(id)
    .bind(token_hash(token))
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(
        valid,
        "Rejected starts must not revoke the existing capability"
    );
    service.stop_preview(f.merchant, actor, id).await.unwrap();
    assert!(service
        .start_worker_preview(
            f.merchant,
            env,
            actor,
            domain_mobile::Platform::Android,
            "native"
        )
        .await
        .is_ok());
}

#[sqlx::test(migrations = "../../migrations")]
async fn preview_polling_budget_is_bounded_and_does_not_block_cleanup(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let start = format!(
        "/v1/merchants/{}/app-preview/sessions?environment=staging",
        f.merchant
    );
    let (_, _, session) = request(&f.app, "POST", &start, Some(&f.designer), None, &[]).await;
    let id = session["id"].as_str().unwrap();
    let path = format!("/v1/merchants/{}/app-preview/sessions/{id}", f.merchant);
    let actor: Uuid =
        sqlx::query_scalar("SELECT admin_id FROM admin_iam.sessions WHERE token_hash=$1")
            .bind(infra_auth::digest(&f.designer))
            .fetch_one(&pool)
            .await
            .unwrap();
    let reader = infra_auth::digest(&format!("mobile-preview-read:{actor}"));
    sqlx::query(
        "INSERT INTO platform.rate_limits(key,attempts,window_start) VALUES($1,1799,now())",
    )
    .bind(&reader)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        request(&f.app, "GET", &path, Some(&f.designer), None, &[])
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&f.app, "GET", &path, Some(&f.designer), None, &[])
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    let edits: i32 = sqlx::query_scalar("SELECT attempts FROM platform.rate_limits WHERE key=$1")
        .bind(infra_auth::digest(&format!("mobile-admin:{actor}")))
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        edits, 1,
        "Preview polling must not consume the editor budget"
    );
    assert_eq!(
        request(&f.app, "DELETE", &path, Some(&f.designer), None, &[])
            .await
            .0,
        StatusCode::OK
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn preview_native_polling_budgets_are_independent_and_bounded(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    assert_eq!(f.save(f.config.clone(), 0).await.0, StatusCode::OK);
    let start = format!(
        "/v1/merchants/{}/app-preview/sessions?environment=staging",
        f.merchant
    );
    let (_, _, session) = request(&f.app, "POST", &start, Some(&f.designer), None, &[]).await;
    let id = session["id"].as_str().unwrap();
    let secret = session["code"].as_str().unwrap().split_once('.').unwrap().1;
    let bearer = format!("Bearer {secret}");
    let auth = [("authorization", bearer.as_str())];
    let query = format!(
        "merchantId={}&environment=staging&runtimeVersion=1.2.0",
        f.merchant
    );
    let path = format!("/v1/mobile/preview/{id}?{query}");
    let ack_path = format!("/v1/mobile/preview/{id}/ack?{query}");
    let ack = json!({"revision":1,"checksum":checksum(&f.config)});
    // Simulate a full 15-minute poll window: 450 reads and ACKs, plus images.
    for (bucket, attempts) in [("snapshot", 450), ("ack", 450), ("assets", 13950)] {
        sqlx::query(
            "INSERT INTO platform.rate_limits(key,attempts,window_start) VALUES($1,$2,now())",
        )
        .bind(infra_auth::digest(&format!(
            "mobile-preview:{bucket}:{}",
            token_hash(secret)
        )))
        .bind(attempts)
        .execute(&pool)
        .await
        .unwrap();
    }
    assert_eq!(
        request(&f.app, "GET", &path, None, None, &auth).await.0,
        StatusCode::OK
    );
    assert_eq!(
        request(&f.app, "POST", &ack_path, None, Some(ack.clone()), &auth)
            .await
            .0,
        StatusCode::OK
    );
    let read_key = infra_auth::digest(&format!("mobile-preview:snapshot:{}", token_hash(secret)));
    sqlx::query("UPDATE platform.rate_limits SET attempts=600 WHERE key=$1")
        .bind(&read_key)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(&f.app, "GET", &path, None, None, &auth).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        request(&f.app, "POST", &ack_path, None, Some(ack.clone()), &auth)
            .await
            .0,
        StatusCode::OK
    );
    let asset = Uuid::new_v4();
    let asset_path = format!("/v1/mobile/preview/{id}/assets/{asset}?{query}");
    sqlx::query("INSERT INTO platform.rate_limits(key,attempts,window_start) VALUES($1,600,now())")
        .bind(infra_auth::digest(&format!(
            "mobile-preview:asset:{asset}:{}",
            token_hash(secret)
        )))
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(&f.app, "GET", &asset_path, None, None, &auth)
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    sqlx::query("UPDATE platform.rate_limits SET attempts=18600 WHERE key=$1")
        .bind(infra_auth::digest(&format!(
            "mobile-preview:assets:{}",
            token_hash(secret)
        )))
        .execute(&pool)
        .await
        .unwrap();
    let other_asset = format!("/v1/mobile/preview/{id}/assets/{}?{query}", Uuid::new_v4());
    assert_eq!(
        request(&f.app, "GET", &other_asset, None, None, &auth)
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    // The next window allows another 15 minutes without a new capability.
    sqlx::query(
        "UPDATE platform.rate_limits SET window_start=now()-interval '16 minutes' WHERE key=$1",
    )
    .bind(&read_key)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        request(&f.app, "GET", &path, None, None, &auth).await.0,
        StatusCode::OK
    );
    assert_eq!(
        request(&f.app, "POST", &ack_path, None, Some(ack), &auth)
            .await
            .0,
        StatusCode::OK
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn asset_folders_preserve_images_and_enforce_ownership(pool: PgPool) {
    let f = fixture(pool).await;
    let path = |suffix: &str| {
        format!(
            "/v1/merchants/{}/{suffix}?environment=production",
            f.merchant
        )
    };
    let create = |name: &str, parent: Value| json!({"name":name,"parentId":parent});
    let (status, _, root) = request(
        &f.app,
        "POST",
        &path("asset-folders"),
        Some(&f.owner),
        Some(create("Campaigns", Value::Null)),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, _, child) = request(
        &f.app,
        "POST",
        &path("asset-folders"),
        Some(&f.designer),
        Some(create("Summer", root["id"].clone())),
        &[],
    )
    .await;
    assert!(child["id"].is_string());
    assert_eq!(
        request(
            &f.app,
            "POST",
            &path("asset-folders"),
            Some(&f.owner),
            Some(create(" campaigns ", Value::Null)),
            &[]
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let root_path = path(&format!("asset-folders/{}", root["id"].as_str().unwrap()));
    assert_eq!(
        request(
            &f.app,
            "PUT",
            &root_path,
            Some(&f.owner),
            Some(create("Campaigns", child["id"].clone())),
            &[]
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let operator = admin(&f.pool, Some(f.merchant), "operator").await;
    assert_eq!(
        request(
            &f.app,
            "POST",
            &path("asset-folders"),
            Some(&operator),
            Some(create("Denied", Value::Null)),
            &[]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &f.app,
            "GET",
            &path("asset-folders"),
            Some(&f.outsider),
            None,
            &[]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let asset = f.config["brand"]["logoAssetId"].clone();
    assert_eq!(
        request(
            &f.app,
            "POST",
            &path("assets/move"),
            Some(&f.designer),
            Some(json!({"ids":[asset],"folderId":child["id"]})),
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );
    let foreign: Uuid =
        sqlx::query_scalar("SELECT id FROM mobile.assets WHERE merchant_id=$1 LIMIT 1")
            .bind(f.other)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(
        request(
            &f.app,
            "POST",
            &path("assets/move"),
            Some(&f.owner),
            Some(json!({"ids":[asset,foreign],"folderId":null})),
            &[]
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let library = format!(
        "{}&folder={}",
        path("asset-library"),
        child["id"].as_str().unwrap()
    );
    let listed = request(&f.app, "GET", &library, Some(&f.owner), None, &[]).await;
    assert_eq!(listed.0, StatusCode::OK);
    assert_eq!(listed.2["total"], 1);
    assert_eq!(listed.2["items"][0]["id"], asset);
    assert_eq!(
        request(&f.app, "DELETE", &root_path, Some(&f.owner), None, &[])
            .await
            .0,
        StatusCode::OK
    );
    let unfiled = request(
        &f.app,
        "GET",
        &(path("asset-library") + "&folder=unfiled"),
        Some(&f.owner),
        None,
        &[],
    )
    .await;
    assert_eq!(unfiled.2["items"][0]["id"], asset);
    assert!(unfiled.2["items"][0]["folderId"].is_null());
    assert_eq!(unfiled.2["items"][0]["url"], listed.2["items"][0]["url"]);
    assert_eq!(
        request(
            &f.app,
            "GET",
            &path("asset-folders"),
            Some(&f.owner),
            None,
            &[]
        )
        .await
        .2,
        json!([])
    );
    let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM mobile.audit_events WHERE merchant_id=$1 AND environment='production' AND action LIKE 'asset.%'").bind(f.merchant).fetch_one(&f.pool).await.unwrap();
    assert_eq!(audits, 4);
}

#[sqlx::test(migrations = "../../migrations")]
async fn asset_library_search_pagination_and_foreign_folders(pool: PgPool) {
    let f = fixture(pool).await;
    let path = |suffix: &str| {
        format!(
            "/v1/merchants/{}/{suffix}?environment=production",
            f.merchant
        )
    };
    let foreign_folder = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO mobile.asset_folders(id,merchant_id,name) VALUES($1,$2,'Other merchant')",
    )
    .bind(foreign_folder)
    .bind(f.other)
    .execute(&f.pool)
    .await
    .unwrap();
    assert_eq!(
        request(
            &f.app,
            "POST",
            &path("asset-folders"),
            Some(&f.owner),
            Some(json!({"name":"Child","parentId":foreign_folder})),
            &[]
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let asset = f.config["brand"]["logoAssetId"].clone();
    assert_eq!(
        request(
            &f.app,
            "POST",
            &path("assets/move"),
            Some(&f.owner),
            Some(json!({"ids":[asset],"folderId":foreign_folder})),
            &[]
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    for i in 0..55 {
        sqlx::query("INSERT INTO mobile.assets(id,merchant_id,kind,verified,url,checksum,name) VALUES($1,$2,'image',true,'https://example.com/asset.png',$3,$4)")
            .bind(Uuid::new_v4()).bind(f.merchant).bind("a".repeat(64)).bind(format!("Campaign {i:02}"))
            .execute(&f.pool).await.unwrap();
    }
    let page1 = request(
        &f.app,
        "GET",
        &(path("asset-library") + "&q=Campaign&sort=name"),
        Some(&f.owner),
        None,
        &[],
    )
    .await;
    assert_eq!(page1.0, StatusCode::OK);
    assert_eq!(page1.2["total"], 55);
    assert_eq!(page1.2["items"].as_array().unwrap().len(), 48);
    assert_eq!(page1.2["items"][0]["name"], "Campaign 00");
    let page2 = request(
        &f.app,
        "GET",
        &(path("asset-library") + "&q=Campaign&sort=name&offset=48"),
        Some(&f.owner),
        None,
        &[],
    )
    .await;
    assert_eq!(page2.2["items"].as_array().unwrap().len(), 7);
    assert_eq!(page2.2["items"][0]["name"], "Campaign 48");
    let rename = path(&format!("assets/{}", asset.as_str().unwrap()));
    assert_eq!(
        request(
            &f.app,
            "PUT",
            &rename,
            Some(&f.designer),
            Some(json!({"name":"100% Summer"})),
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );
    let literal = request(
        &f.app,
        "GET",
        &(path("asset-library") + "&q=%25"),
        Some(&f.owner),
        None,
        &[],
    )
    .await;
    assert_eq!(literal.2["total"], 1);
    assert_eq!(literal.2["items"][0]["name"], "100% Summer");
    let invalid = request(
        &f.app,
        "GET",
        &(path("asset-library") + "&offset=-1"),
        Some(&f.owner),
        None,
        &[],
    )
    .await;
    assert_eq!(invalid.0, StatusCode::UNPROCESSABLE_ENTITY);
}
