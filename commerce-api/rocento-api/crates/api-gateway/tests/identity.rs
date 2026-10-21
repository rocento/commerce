mod support;
use api_gateway::identity::{router, App};
use axum::{body::Body, http::Request, Router};
use http_body_util::BodyExt;
use infra_auth::{Notification, NotificationSink, Security};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::{Arc, Mutex};
use support::validate_shape;
use tower::ServiceExt;

use uuid::Uuid;
const PASSWORD: &str = "Testing Password 123!";

async fn auth_from_peer(router: Router, action: &str, peer: &str, body: Value) -> u16 {
    let request = Request::builder()
        .method("POST")
        .uri(format!("/v1/customer/auth/{action}"))
        .header("content-type", "application/json")
        .header("x-commerce-request", "1")
        .header("x-forwarded-for", "203.0.113.200")
        .header("cf-connecting-ip", "203.0.113.201")
        .extension(axum::extract::ConnectInfo(
            peer.parse::<std::net::SocketAddr>().unwrap(),
        ))
        .body(Body::from(body.to_string()))
        .unwrap();
    router.oneshot(request).await.unwrap().status().as_u16()
}

#[sqlx::test(migrations = "../../migrations")]
async fn peer_auth_throttling_ignores_spoofed_headers_and_isolates_peers(pool: PgPool) {
    let t = Test::new(pool.clone()).await;
    sqlx::query("INSERT INTO platform.rate_limits(key,attempts,window_start) VALUES($1,100,now())")
        .bind(infra_auth::digest("http:auth:198.51.100.10"))
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        auth_from_peer(t.router.clone(), "logout", "198.51.100.10:1234", json!({})).await,
        429
    );
    assert_eq!(
        auth_from_peer(t.router, "logout", "198.51.100.11:1234", json!({})).await,
        200
    );
    let attempts: i32 =
        sqlx::query_scalar("SELECT attempts FROM platform.rate_limits WHERE key=$1")
            .bind(infra_auth::digest("http:auth:198.51.100.11"))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(attempts, 1);
    let forged: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM platform.rate_limits WHERE key=$1 OR key=$2)",
    )
    .bind(infra_auth::digest("http:auth:203.0.113.200"))
    .bind(infra_auth::digest("http:auth:203.0.113.201"))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!forged);
}

#[sqlx::test(migrations = "../../migrations")]
async fn ingress_mode_avoids_shared_peer_limits_but_preserves_account_limits(pool: PgPool) {
    let mut t = Test::new(pool.clone()).await;
    t.app.auth_ip_rate_limit = api_gateway::auth_ip::AuthIpRateLimit::Ingress;
    let router = router(t.app);
    sqlx::query("INSERT INTO platform.rate_limits(key,attempts,window_start) VALUES($1,100,now()),($2,10,now())")
        .bind(infra_auth::digest("http:auth:172.18.0.1"))
        .bind(infra_auth::digest("login:limited@example.test"))
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        auth_from_peer(router.clone(), "logout", "172.18.0.1:1234", json!({})).await,
        200
    );
    assert_eq!(
        auth_from_peer(
            router,
            "login",
            "172.18.0.1:1234",
            json!({"identifier":"limited@example.test","password":PASSWORD})
        )
        .await,
        429
    );
    let attempts: i32 =
        sqlx::query_scalar("SELECT attempts FROM platform.rate_limits WHERE key=$1")
            .bind(infra_auth::digest("http:auth:172.18.0.1"))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(attempts, 100);
}

#[derive(Default)]
struct Inbox(Mutex<Vec<Notification>>);
impl NotificationSink for Inbox {
    fn send(&self, n: Notification) {
        self.0.lock().unwrap().push(n);
    }
}
struct Test {
    app: App,
    router: Router,
    inbox: Arc<Inbox>,
}
struct Reply {
    status: u16,
    body: Value,
    cookie: String,
}
impl Test {
    async fn new(pool: PgPool) -> Self {
        let inbox = Arc::new(Inbox::default());
        let mut security = Security::new(
            "integration-secret-".repeat(4),
            "http://localhost:5173".into(),
            false,
        )
        .await
        .unwrap();
        security.notifications = inbox.clone();
        let app = App::new(pool, security, vec!["http://localhost:5173".into()]);
        Self {
            router: router(app.clone()),
            app,
            inbox,
        }
    }
    async fn request(&self, method: &str, path: &str, body: Value, auth: &str) -> Reply {
        self.request_headers(method, path, body, auth, true, None)
            .await
    }
    async fn request_headers(
        &self,
        method: &str,
        path: &str,
        body: Value,
        auth: &str,
        csrf: bool,
        origin: Option<&str>,
    ) -> Reply {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if csrf {
            request = request.header("x-commerce-request", "1");
        }
        if let Some(o) = origin {
            request = request.header("origin", o);
        }
        if auth.starts_with("Bearer ") {
            request = request.header("authorization", auth);
        } else {
            request = request.header("cookie", auth);
        }
        let res = self
            .router
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = res.status().as_u16();
        let cookie = res
            .headers()
            .get("set-cookie")
            .map(|v| v.to_str().unwrap().to_string())
            .unwrap_or_default();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"raw":String::from_utf8_lossy(&bytes)}));
        let contract: Value = serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
        let contract_path = if path.starts_with("/v1/customer/locations/") {
            "/v1/customer/locations/{id}"
        } else if path.starts_with("/v1/admin/users/") {
            "/v1/admin/users/{id}"
        } else if path.starts_with("/v1/admin/roles/") {
            "/v1/admin/roles/{id}"
        } else {
            path
        };
        let responses = &contract["paths"][contract_path][method.to_lowercase()]["responses"];
        let response = responses
            .get(status.to_string())
            .unwrap_or(&responses["default"]);
        if status == 204 {
            assert!(bytes.is_empty());
            assert!(response.get("content").is_none());
        } else {
            validate_shape(
                &body,
                &response["content"]["application/json"]["schema"],
                &contract,
            );
        }
        Reply {
            status,
            body,
            cookie,
        }
    }
    fn code(&self, id: &str, purpose: &str) -> String {
        self.inbox
            .0
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|n| n.identifier == id && n.purpose == purpose)
            .unwrap()
            .code
            .clone()
    }
    async fn register(&self, id: &str) {
        let r = self
            .request(
                "POST",
                "/v1/customer/auth/register",
                json!({"identifier":id,"password":PASSWORD}),
                "",
            )
            .await;
        assert_eq!(r.status, 201, "{}", r.body);
        assert_eq!(r.body["verified"], false);
        assert!(r.body.get("password_hash").is_none());
    }
    async fn login(&self, id: &str) -> Reply {
        let r = self
            .request(
                "POST",
                "/v1/customer/auth/login",
                json!({"identifier":id,"password":PASSWORD}),
                "",
            )
            .await;
        assert_eq!(r.status, 200, "{}", r.body);
        assert!(r.cookie.contains("HttpOnly"));
        assert!(r.cookie.contains("SameSite=Strict"));
        r
    }
    async fn admin(&self) -> String {
        self.app
            .admins
            .seed("admin@test.local", PASSWORD.into())
            .await
            .unwrap();
        let r = self
            .request(
                "POST",
                "/v1/admin/auth/login",
                json!({"email":"admin@test.local","password":PASSWORD}),
                "",
            )
            .await;
        assert_eq!(r.status, 200, "{}", r.body);
        r.cookie
    }
}
fn bearer(reply: &Reply) -> String {
    format!("Bearer {}", reply.body["access_token"].as_str().unwrap())
}

#[sqlx::test(migrations = "../../migrations")]
async fn guest_refresh_is_empty_without_granting_access_or_relaxing_policy(pool: PgPool) {
    let t = Test::new(pool).await;
    let path = "/v1/customer/auth/refresh";
    for cookie in ["", "guest_cart=guest", "customer_refresh="] {
        let guest = t.request("POST", path, json!(null), cookie).await;
        assert_eq!(guest.status, 204);
        assert!(guest.cookie.is_empty());
        assert_eq!(guest.body, json!({"raw":""}));
    }
    assert_eq!(
        t.request("POST", path, json!(null), "customer_refresh=invalid")
            .await
            .status,
        401
    );
    assert_eq!(
        t.request("GET", "/v1/customer/me", json!(null), "")
            .await
            .status,
        401
    );
    assert_eq!(
        t.request_headers("POST", path, json!(null), "", false, None)
            .await
            .status,
        403
    );
    assert_eq!(
        t.request_headers(
            "POST",
            path,
            json!(null),
            "",
            true,
            Some("https://untrusted.example"),
        )
        .await
        .status,
        403
    );
}
fn location(default: bool) -> Value {
    json!({"label":"home","latitude":30.0,"longitude":31.0,"formatted_address":"12 Test Street","building":"12","floor":"2","apartment":"3","delivery_instructions":"Ring once","is_default":default})
}

#[sqlx::test(migrations = "../../migrations")]
async fn customer_lifecycle_and_verification_gate(pool: PgPool) {
    let t = Test::new(pool).await;
    for id in ["person@test.local", "+201012345678"] {
        t.register(id).await;
        let login = t.login(id).await;
        let auth = bearer(&login);
        assert_eq!(
            t.request(
                "GET",
                "/v1/customer/checkout-eligibility",
                json!(null),
                &auth
            )
            .await
            .status,
            403
        );
        let code = t.code(id, "verify");
        if id.starts_with('+') {
            assert_eq!(code.len(), 6);
        }
        assert_eq!(
            t.request(
                "POST",
                "/v1/customer/auth/verify",
                json!({"identifier":id,"token":code}),
                ""
            )
            .await
            .status,
            200
        );
        assert_eq!(
            t.request(
                "POST",
                "/v1/customer/auth/verify",
                json!({"identifier":id,"token":code}),
                ""
            )
            .await
            .status,
            401
        );
        assert_eq!(
            t.request(
                "GET",
                "/v1/customer/checkout-eligibility",
                json!(null),
                &auth
            )
            .await
            .status,
            200
        );
        let refreshed = t
            .request(
                "POST",
                "/v1/customer/auth/refresh",
                json!(null),
                &login.cookie,
            )
            .await;
        assert_eq!(refreshed.status, 200);
        assert_ne!(login.cookie, refreshed.cookie);
        assert_eq!(
            t.request(
                "POST",
                "/v1/customer/auth/refresh",
                json!(null),
                &login.cookie
            )
            .await
            .status,
            401
        );
        assert_eq!(
            t.request(
                "POST",
                "/v1/customer/auth/logout",
                json!(null),
                &refreshed.cookie
            )
            .await
            .status,
            200
        );
        assert_eq!(
            t.request("GET", "/v1/customer/me", json!(null), &auth)
                .await
                .status,
            401
        );
    }
    assert_eq!(
        t.request("GET", "/v1/customer/checkout-eligibility", json!(null), "")
            .await
            .status,
        401
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn password_reset_revokes_all_sessions_and_is_single_use(pool: PgPool) {
    let t = Test::new(pool).await;
    t.register("reset@test.local").await;
    let one = t.login("reset@test.local").await;
    let two = t.login("reset@test.local").await;
    let path = "/v1/customer/auth/forgot-password";
    let found = t
        .request("POST", path, json!({"identifier":"reset@test.local"}), "")
        .await;
    let missing = t
        .request("POST", path, json!({"identifier":"absent@test.local"}), "")
        .await;
    assert_eq!(found.status, missing.status);
    assert_eq!(found.body, missing.body);
    let body = json!({"identifier":"reset@test.local","token":t.code("reset@test.local","reset"),"password":"Replacement Password 456!"});
    assert_eq!(
        t.request("POST", "/v1/customer/auth/reset-password", body.clone(), "")
            .await
            .status,
        200
    );
    assert_eq!(
        t.request("POST", "/v1/customer/auth/reset-password", body, "")
            .await
            .status,
        401
    );
    for session in [one, two] {
        assert_eq!(
            t.request("GET", "/v1/customer/me", json!(null), &bearer(&session))
                .await
                .status,
            401
        );
        assert_eq!(
            t.request(
                "POST",
                "/v1/customer/auth/refresh",
                json!(null),
                &session.cookie
            )
            .await
            .status,
            401
        );
    }
    assert_eq!(
        t.request(
            "POST",
            "/v1/customer/auth/login",
            json!({"identifier":"reset@test.local","password":PASSWORD}),
            ""
        )
        .await
        .status,
        401
    );
    assert_eq!(
        t.request(
            "POST",
            "/v1/customer/auth/login",
            json!({"identifier":"reset@test.local","password":"Replacement Password 456!"}),
            ""
        )
        .await
        .status,
        200
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn ownership_defaults_and_concurrent_locations(pool: PgPool) {
    let t = Test::new(pool).await;
    t.register("a@test.local").await;
    t.register("b@test.local").await;
    let a = bearer(&t.login("a@test.local").await);
    let b = bearer(&t.login("b@test.local").await);
    let one = t
        .request("POST", "/v1/customer/locations", location(false), &a)
        .await;
    assert_eq!(one.status, 201, "{}", one.body);
    assert_eq!(one.body["is_default"], true);
    let path = format!(
        "/v1/customer/locations/{}",
        one.body["id"].as_str().unwrap()
    );
    assert_eq!(
        t.request("PUT", &path, location(false), &b).await.status,
        404
    );
    assert_eq!(
        t.request("DELETE", &path, json!(null), &b).await.status,
        404
    );
    let (x, y) = tokio::join!(
        t.request("POST", "/v1/customer/locations", location(true), &a),
        t.request("POST", "/v1/customer/locations", location(true), &a)
    );
    assert_eq!(x.status, 201);
    assert_eq!(y.status, 201);
    let all = t
        .request("GET", "/v1/customer/locations", json!(null), &a)
        .await;
    assert_eq!(
        all.body
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["is_default"] == true)
            .count(),
        1
    );
    let id = all.body[0]["id"].as_str().unwrap();
    assert_eq!(
        t.request(
            "DELETE",
            &format!("/v1/customer/locations/{id}"),
            json!(null),
            &a
        )
        .await
        .status,
        200
    );
    let all = t
        .request("GET", "/v1/customer/locations", json!(null), &a)
        .await;
    assert_eq!(all.body.as_array().unwrap().len(), 2);
    assert_eq!(all.body[0]["is_default"], true);
    let mut bad = location(false);
    bad["latitude"] = json!(91);
    assert_eq!(
        t.request("POST", "/v1/customer/locations", bad, &a)
            .await
            .status,
        400
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn csrf_rate_limits_expiry_and_validation(pool: PgPool) {
    let t = Test::new(pool).await;
    let data = json!({"identifier":"a@test.local","password":PASSWORD});
    assert_eq!(
        t.request_headers(
            "POST",
            "/v1/customer/auth/register",
            data.clone(),
            "",
            false,
            None
        )
        .await
        .status,
        403
    );
    assert_eq!(
        t.request_headers(
            "POST",
            "/v1/customer/auth/register",
            data,
            "",
            true,
            Some("https://evil.example")
        )
        .await
        .status,
        403
    );
    assert_eq!(
        t.request(
            "POST",
            "/v1/customer/auth/register",
            json!({"identifier":"not-an-email","password":PASSWORD}),
            ""
        )
        .await
        .status,
        400
    );
    assert_eq!(
        t.request(
            "POST",
            "/v1/customer/auth/register",
            json!({"identifier":"a@test.local","password":"short"}),
            ""
        )
        .await
        .status,
        400
    );
    t.register("a@test.local").await;
    sqlx::query("UPDATE customers.challenges SET expires_at=now()-interval '1 second'")
        .execute(&t.app.customers.pool)
        .await
        .unwrap();
    assert_eq!(
        t.request(
            "POST",
            "/v1/customer/auth/verify",
            json!({"identifier":"a@test.local","token":t.code("a@test.local","verify")}),
            ""
        )
        .await
        .status,
        401
    );
    for _ in 0..10 {
        assert_eq!(
            t.request(
                "POST",
                "/v1/customer/auth/login",
                json!({"identifier":"rate@test.local","password":"wrong"}),
                ""
            )
            .await
            .status,
            401
        );
    }
    assert_eq!(
        t.request(
            "POST",
            "/v1/customer/auth/login",
            json!({"identifier":"rate@test.local","password":"wrong"}),
            ""
        )
        .await
        .status,
        429
    );
    let login = t.login("a@test.local").await;
    assert_eq!(
        t.request("GET", "/v1/admin/me", json!(null), &bearer(&login))
            .await
            .status,
        401
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn admin_rbac_audit_and_last_admin_protection(pool: PgPool) {
    let t = Test::new(pool).await;
    let cookie = t.admin().await;
    let who = t.request("GET", "/v1/admin/me", json!(null), &cookie).await;
    let own = who.body["user"]["id"].as_str().unwrap();
    assert_eq!(
        t.request(
            "DELETE",
            &format!("/v1/admin/users/{own}"),
            json!(null),
            &cookie
        )
        .await
        .status,
        400
    );
    assert!(t
        .app
        .admins
        .seed("second@test.local", PASSWORD.into())
        .await
        .is_err());
    let role = t
        .request(
            "POST",
            "/v1/admin/roles",
            json!({"name":"Read users","permissions":["iam.users.read"]}),
            &cookie,
        )
        .await;
    assert_eq!(role.status, 201, "{}", role.body);
    let rid = role.body["id"].as_str().unwrap();
    let user=t.request("POST","/v1/admin/users",json!({"email":"reader@test.local","name":"Reader","password":PASSWORD,"role_id":rid,"active":true}),&cookie).await;
    assert_eq!(user.status, 201, "{}", user.body);
    let uid = user.body["id"].as_str().unwrap();
    let login = t
        .request(
            "POST",
            "/v1/admin/auth/login",
            json!({"email":"reader@test.local","password":PASSWORD}),
            "",
        )
        .await;
    assert_eq!(login.status, 200);
    assert_eq!(
        t.request("GET", "/v1/admin/users", json!(null), &login.cookie)
            .await
            .status,
        200
    );
    assert_eq!(
        t.request("GET", "/v1/admin/audit", json!(null), &login.cookie)
            .await
            .status,
        403
    );
    assert_eq!(
        t.request(
            "POST",
            "/v1/admin/roles",
            json!({"name":"Escalate","permissions":["iam.users.write"]}),
            &login.cookie
        )
        .await
        .status,
        403
    );
    assert_eq!(
        t.request(
            "PUT",
            &format!("/v1/admin/roles/{rid}"),
            json!({"name":"No access","permissions":[]}),
            &cookie
        )
        .await
        .status,
        200
    );
    assert_eq!(
        t.request("GET", "/v1/admin/users", json!(null), &login.cookie)
            .await
            .status,
        403
    );
    assert_eq!(
        t.request(
            "DELETE",
            &format!("/v1/admin/roles/{rid}"),
            json!(null),
            &cookie
        )
        .await
        .status,
        409
    );
    assert_eq!(
        t.request(
            "DELETE",
            &format!("/v1/admin/users/{uid}"),
            json!(null),
            &cookie
        )
        .await
        .status,
        200
    );
    assert_eq!(
        t.request("GET", "/v1/admin/me", json!(null), &login.cookie)
            .await
            .status,
        401
    );
    // Reassign the inactive account; soft-deleted audit actors remain intact.
    assert_eq!(t.request("PUT",&format!("/v1/admin/users/{uid}"),json!({"email":"reader@test.local","name":"Reader","role_id":Uuid::from_u128(2),"active":false}),&cookie).await.status,200);
    assert_eq!(
        t.request(
            "DELETE",
            &format!("/v1/admin/roles/{rid}"),
            json!(null),
            &cookie
        )
        .await
        .status,
        200
    );
    let audits = t
        .request("GET", "/v1/admin/audit", json!(null), &cookie)
        .await;
    for action in [
        "admin.user_created",
        "admin.user_updated",
        "admin.user_deleted",
        "admin.role_created",
        "admin.role_updated",
        "admin.role_deleted",
    ] {
        assert!(
            audits
                .body
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["action"] == action),
            "missing {action}"
        );
    }
    assert!(!audits.body.to_string().contains("password_hash"));
    let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.outbox")
        .fetch_one(&t.app.admins.pool)
        .await
        .unwrap();
    assert!(pending >= 8);
}

#[sqlx::test(migrations = "../../migrations")]
async fn logout_revokes_session_during_refresh(pool: PgPool) {
    let t = Test::new(pool).await;
    t.register("race@test.local").await;
    let login = t.login("race@test.local").await;
    let token = login.body["access_token"].as_str().unwrap().to_owned();
    let cookie_value = login
        .cookie
        .split(';')
        .next()
        .unwrap()
        .split_once('=')
        .unwrap()
        .1
        .to_owned();
    let (refresh, logout) = tokio::join!(
        t.app.customers.refresh(&cookie_value),
        t.app.customers.logout(&cookie_value, Some(&token))
    );
    assert!(logout.is_ok());
    assert!(t.app.customers.authenticate(&token).await.is_err());
    if let Ok(refresh) = refresh {
        assert!(t.app.customers.refresh(&refresh.refresh).await.is_err());
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn neighborhood_selection_roundtrips_and_is_exclusive_with_pin(pool: PgPool) {
    let t = Test::new(pool).await;
    t.register("neighborhood@test.local").await;
    let auth = bearer(&t.login("neighborhood@test.local").await);
    let mut input = location(false);
    input["location_method"] = json!("neighborhood");
    input["geography"] = json!({"country_code":"EG","state_code":"11","state_name":"Cairo","city_id":"7799991","city_name":"New Cairo"});
    let reply = t
        .request("POST", "/v1/customer/locations", input.clone(), &auth)
        .await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(reply.body["geography"], input["geography"]);
    assert_eq!(reply.body["location_method"], "neighborhood");
    let all = t
        .request("GET", "/v1/customer/locations", json!(null), &auth)
        .await;
    assert_eq!(all.body[0]["geography"], input["geography"]);
    let mut incomplete = input.clone();
    incomplete["geography"]["city_id"] = json!("");
    assert_eq!(
        t.request("POST", "/v1/customer/locations", incomplete, &auth)
            .await
            .status,
        400
    );
    let mut both = input.clone();
    both["location_method"] = json!("pin");
    assert_eq!(
        t.request("POST", "/v1/customer/locations", both, &auth)
            .await
            .status,
        400
    );
    let path = format!(
        "/v1/customer/locations/{}",
        reply.body["id"].as_str().unwrap()
    );
    // Legacy pin clients omit the new fields and remain compatible.
    let pin = t.request("PUT", &path, location(false), &auth).await;
    assert_eq!(pin.status, 200, "{}", pin.body);
    assert_eq!(pin.body["location_method"], "pin");
    assert!(pin.body["geography"].is_null());
}
