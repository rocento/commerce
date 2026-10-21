use api_gateway::{identity, marketing_notifications, storefront_notifications};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use infra_auth::Security;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

#[derive(Clone)]
struct Fixture {
    state: identity::App,
    app: Router,
    role: Uuid,
    customers: [Uuid; 2],
    tokens: [String; 2],
}
struct Reply {
    status: StatusCode,
    body: Value,
    cookie: Option<String>,
}
async fn setup(pool: &PgPool) -> Fixture {
    static SECURITY: tokio::sync::OnceCell<Security> = tokio::sync::OnceCell::const_new();
    let security = SECURITY
        .get_or_init(|| async {
            Security::new(
                "native-inbox-test-secret-".repeat(3),
                "https://store.example.test".into(),
                true,
            )
            .await
            .unwrap()
        })
        .await
        .clone();
    let role = Uuid::new_v4();
    let actor = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'Inbox publishers',ARRAY['*'])",
    )
    .bind(role)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'inbox-admin@example.test','Inbox admin','!',$2)").bind(actor).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest("inbox-admin")).bind(actor).execute(pool).await.unwrap();
    let customers = [Uuid::new_v4(), Uuid::new_v4()];
    let mut tokens = [String::new(), String::new()];
    for (i, customer) in customers.iter().enumerate() {
        sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash,first_name,last_name) VALUES($1,$2,'email','!',$3,'Customer')")
            .bind(customer).bind(format!("native-customer-{i}@example.test")).bind(if i==0{"First"}else{"Second"}).execute(pool).await.unwrap();
        let session = Uuid::new_v4();
        sqlx::query("INSERT INTO customers.sessions(id,customer_id,refresh_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(session).bind(customer).bind(format!("native-{i}")).execute(pool).await.unwrap();
        tokens[i] = security.access_token(*customer, session).unwrap();
        sqlx::query("INSERT INTO customers.journey_events(customer_id,id,session_id,event_type,path,source,occurred_at) VALUES($1,$2,$3,'page_view','/','test',now()-interval '5 minutes')").bind(customer).bind(Uuid::new_v4()).bind(session).execute(pool).await.unwrap();
    }
    let state = identity::App::new(
        pool.clone(),
        security,
        vec![
            "https://store.example.test".into(),
            "https://admin.example.test".into(),
        ],
    );
    Fixture {
        state: state.clone(),
        app: marketing_notifications::router(state.clone())
            .merge(storefront_notifications::router(state)),
        role,
        customers,
        tokens,
    }
}
async fn call(
    f: &Fixture,
    method: &str,
    path: &str,
    body: Value,
    cookie: Option<&str>,
    token: Option<&str>,
) -> Reply {
    call_at(f, method, path, body, cookie, token, None).await
}
async fn call_at(
    f: &Fixture,
    method: &str,
    path: &str,
    body: Value,
    cookie: Option<&str>,
    token: Option<&str>,
    pin: Option<(f64, f64)>,
) -> Reply {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("x-commerce-request", "1");
    if let Some((lat, lng)) = pin {
        request = request
            .header("x-delivery-latitude", lat.to_string())
            .header("x-delivery-longitude", lng.to_string());
    }
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let reply = f
        .app
        .clone()
        .oneshot(
            request
                .body(if method == "GET" {
                    Body::empty()
                } else {
                    Body::from(body.to_string())
                })
                .unwrap(),
        )
        .await
        .unwrap();
    let status = reply.status();
    let cookie = reply
        .headers()
        .get("set-cookie")
        .map(|h| h.to_str().unwrap().to_owned());
    assert_eq!(reply.headers()["cache-control"], "no-store");
    let bytes = reply.into_body().collect().await.unwrap().to_bytes();
    Reply {
        status,
        body: serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))),
        cookie,
    }
}
async fn admin(f: &Fixture, method: &str, suffix: &str, body: Value) -> Reply {
    call(
        f,
        method,
        &format!("/v1/admin/marketing/notifications{suffix}"),
        body,
        Some("admin_session=inbox-admin"),
        None,
    )
    .await
}
fn announcement(audience: &str) -> Value {
    json!({"title":format!("For {audience}"),"body":"A plain storefront announcement.","audience":audience,"cta_label":"Browse products","cta_path":"/search","starts_at":null,"expires_at":Utc::now()+Duration::days(7),"idempotency_key":Uuid::new_v4()})
}
fn publish_options() -> Value {
    json!({"cta_label":"View your account","cta_path":"/account","starts_at":null,"expires_at":Utc::now()+Duration::days(7),"idempotency_key":Uuid::new_v4()})
}
async fn broadcast(f: &Fixture, audience: &str) -> Value {
    let r = admin(f, "POST", "/publications", announcement(audience)).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    r.body
}
async fn generated(f: &Fixture, channel: &str) -> Value {
    let p=admin(f,"POST","",json!({"name":"Personal welcome","description":"Test","channel":channel,"trigger_kind":"visit","title_template":"Hello {{customer.first_name}}","body_template":"A private welcome for {{customer.name}}.","status":"active","delay_minutes":0,"lookback_days":30,"cooldown_hours":0,"suppress_after_purchase":false})).await;
    assert_eq!(p.status, StatusCode::CREATED, "{}", p.body);
    let r = admin(
        f,
        "POST",
        &format!("/{}/generate", p.body["id"].as_str().unwrap()),
        json!({"customer_id":f.customers[0],"version":1,"idempotency_key":Uuid::new_v4()}),
    )
    .await;
    assert_eq!(r.body["outcome"], "generated", "{}", r.body);
    r.body["record"].clone()
}
fn cookie_value(reply: &Reply) -> String {
    reply
        .cookie
        .as_ref()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}
fn ids(body: &Value) -> Vec<String> {
    body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].as_str().unwrap().to_owned())
        .collect()
}

#[sqlx::test(migrations = "../../migrations")]
async fn customer_and_guest_bells_have_isolated_audiences_and_read_state(pool: PgPool) {
    let f = setup(&pool).await;
    let all = broadcast(&f, "all").await;
    let guests = broadcast(&f, "guests").await;
    let customers = broadcast(&f, "customers").await;
    let record = generated(&f, "in_app").await;
    let personal = admin(
        &f,
        "POST",
        &format!("/records/{}/publish", record["id"].as_str().unwrap()),
        publish_options(),
    )
    .await;
    assert_eq!(personal.status, StatusCode::CREATED, "{}", personal.body);
    let guest = call(&f, "GET", "/v1/notifications", Value::Null, None, None).await;
    assert_eq!(guest.status, StatusCode::OK, "{}", guest.body);
    assert_eq!(guest.body["audience"], "guest");
    assert_eq!(guest.body["unread_count"], 2);
    assert!(guest.cookie.as_ref().unwrap().contains("HttpOnly"));
    assert!(guest.cookie.as_ref().unwrap().contains("SameSite=Strict"));
    assert!(guest.cookie.as_ref().unwrap().contains("Secure"));
    let cookie = cookie_value(&guest);
    let seen = ids(&guest.body);
    assert!(seen.contains(&all["id"].as_str().unwrap().to_owned()));
    assert!(seen.contains(&guests["id"].as_str().unwrap().to_owned()));
    assert!(!guest.body.to_string().contains("First"));
    assert!(!guest.body.to_string().contains(&f.customers[0].to_string()));
    let repeated = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        Some(&cookie),
        None,
    )
    .await;
    assert!(repeated.cookie.is_none());
    let mark = call(
        &f,
        "PUT",
        &format!("/v1/notifications/{}/read", all["id"].as_str().unwrap()),
        json!({"read":true}),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(mark.body["unread_count"], 1);
    let stranger = call(&f, "GET", "/v1/notifications", Value::Null, None, None).await;
    assert_eq!(stranger.body["unread_count"], 2);
    let owner = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        Some(&cookie),
        Some(&f.tokens[0]),
    )
    .await;
    assert_eq!(owner.body["audience"], "customer");
    assert_eq!(owner.body["unread_count"], 3);
    assert!(owner.cookie.is_none());
    assert!(ids(&owner.body).contains(&personal.body["id"].as_str().unwrap().to_owned()));
    assert!(ids(&owner.body).contains(&customers["id"].as_str().unwrap().to_owned()));
    assert!(!ids(&owner.body).contains(&guests["id"].as_str().unwrap().to_owned()));
    let other = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        None,
        Some(&f.tokens[1]),
    )
    .await;
    assert_eq!(other.body["unread_count"], 2);
    assert!(!other.body.to_string().contains("First"));
    for (cookie, token) in [
        (Some(cookie.as_str()), None),
        (None, Some(f.tokens[1].as_str())),
    ] {
        let r = call(
            &f,
            "PUT",
            &format!(
                "/v1/notifications/{}/read",
                personal.body["id"].as_str().unwrap()
            ),
            json!({"read":true}),
            cookie,
            token,
        )
        .await;
        assert_eq!(r.status, StatusCode::NOT_FOUND);
    }
    let raw = cookie.strip_prefix("inbox_guest=").unwrap();
    let stored: String = sqlx::query_scalar(
        "SELECT guest_hash FROM platform.storefront_notification_recipients WHERE guest_hash=$1",
    )
    .bind(infra_auth::digest(raw))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_ne!(stored, raw);
    let deliveries: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.notification_jobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(deliveries, 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn invalid_bearer_never_falls_back_and_guest_secrets_are_server_issued(pool: PgPool) {
    let f = setup(&pool).await;
    let notice = broadcast(&f, "all").await;
    let forged = format!("inbox_guest={}", "A".repeat(48));
    let guest = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        Some(&forged),
        None,
    )
    .await;
    let cookie = cookie_value(&guest);
    assert_ne!(cookie, forged);
    let forged_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM platform.storefront_notification_recipients WHERE guest_hash=$1",
    )
    .bind(infra_auth::digest(&"A".repeat(48)))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(forged_count, 0);
    for cookie in [None, Some(forged.as_str())] {
        assert_eq!(
            call(
                &f,
                "PUT",
                &format!("/v1/notifications/{}/read", notice["id"].as_str().unwrap()),
                json!({"read":true}),
                cookie,
                None
            )
            .await
            .status,
            StatusCode::UNAUTHORIZED
        );
    }
    let bad = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        Some(&cookie),
        Some("invalid-token"),
    )
    .await;
    assert_eq!(bad.status, StatusCode::UNAUTHORIZED);
    assert!(bad.cookie.is_none());
    sqlx::query("UPDATE platform.storefront_notification_recipients SET expires_at=now()-interval '1 minute' WHERE guest_hash=$1").bind(infra_auth::digest(cookie.strip_prefix("inbox_guest=").unwrap())).execute(&pool).await.unwrap();
    assert_eq!(
        call(
            &f,
            "POST",
            "/v1/notifications/read-all",
            json!({"through":Utc::now()}),
            Some(&cookie),
            None
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    let fresh = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        Some(&cookie),
        None,
    )
    .await;
    assert_ne!(cookie_value(&fresh), cookie);
    assert_eq!(fresh.body["unread_count"], 1);
    assert_eq!(
        call(
            &f,
            "GET",
            &format!("/v1/notifications?customer_id={}", f.customers[0]),
            Value::Null,
            None,
            None
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn publications_are_idempotent_immutable_and_withdrawn_by_version(pool: PgPool) {
    let f = setup(&pool).await;
    let record = generated(&f, "in_app").await;
    let path = format!("/records/{}/publish", record["id"].as_str().unwrap());
    let options = publish_options();
    let (first, second) = tokio::join!(
        admin(&f, "POST", &path, options.clone()),
        admin(&f, "POST", &path, options.clone())
    );
    assert!([first.status, second.status].contains(&StatusCode::CREATED));
    assert!(
        [first.status, second.status].contains(&StatusCode::OK),
        "first {} {}, second {} {}",
        first.status,
        first.body,
        second.status,
        second.body
    );
    assert_eq!(first.body["id"], second.body["id"]);
    let mut another_key = options.clone();
    another_key["idempotency_key"] = json!(Uuid::new_v4());
    let same_source = admin(&f, "POST", &path, another_key.clone()).await;
    assert_eq!(same_source.status, StatusCode::OK);
    assert_eq!(same_source.body["id"], first.body["id"]);
    another_key["cta_path"] = json!("/cart");
    assert_eq!(
        admin(&f, "POST", &path, another_key).await.status,
        StatusCode::CONFLICT
    );
    let id = Uuid::parse_str(first.body["id"].as_str().unwrap()).unwrap();
    assert!(sqlx::query(
        "UPDATE platform.storefront_notification_publications SET title='Changed' WHERE id=$1"
    )
    .bind(id)
    .execute(&pool)
    .await
    .is_err());
    assert_eq!(
        admin(
            &f,
            "POST",
            &format!("/publications/{id}/withdraw"),
            json!({"version":2})
        )
        .await
        .status,
        StatusCode::CONFLICT
    );
    let withdrawn = admin(
        &f,
        "POST",
        &format!("/publications/{id}/withdraw"),
        json!({"version":1}),
    )
    .await;
    assert_eq!(withdrawn.status, StatusCode::OK, "{}", withdrawn.body);
    assert_eq!(withdrawn.body["version"], 2);
    let owner = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        None,
        Some(&f.tokens[0]),
    )
    .await;
    assert_eq!(owner.body["unread_count"], 0);
    assert_eq!(
        call(
            &f,
            "PUT",
            &format!("/v1/notifications/{id}/read"),
            json!({"read":true}),
            None,
            Some(&f.tokens[0])
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    let replay = admin(&f, "POST", &path, options).await;
    assert_eq!(replay.body["version"], 2);
    assert!(!replay.body["withdrawn_at"].is_null());
    let email = generated(&f, "email").await;
    assert_eq!(
        admin(
            &f,
            "POST",
            &format!("/records/{}/publish", email["id"].as_str().unwrap()),
            publish_options()
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    let announcement = announcement("all");
    let broad = admin(&f, "POST", "/publications", announcement.clone()).await;
    assert_eq!(
        admin(&f, "POST", "/publications", announcement.clone())
            .await
            .body["id"],
        broad.body["id"]
    );
    let mut changed = announcement;
    changed["title"] = json!("Different");
    assert_eq!(
        admin(&f, "POST", "/publications", changed).await.status,
        StatusCode::CONFLICT
    );
    let audits:i64=sqlx::query_scalar("SELECT count(*) FROM admin_iam.audit_log WHERE entity_id=$1 AND action IN ('notifications.published','notifications.withdrawn')").bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(audits, 2);
}

#[sqlx::test(migrations = "../../migrations")]
async fn read_all_uses_snapshot_cutoff_and_excludes_scheduled_expired_or_other_audiences(
    pool: PgPool,
) {
    let f = setup(&pool).await;
    let first = broadcast(&f, "all").await;
    let second = broadcast(&f, "guests").await;
    broadcast(&f, "customers").await;
    let mut scheduled = announcement("all");
    scheduled["starts_at"] = json!(Utc::now() + Duration::hours(1));
    let scheduled = admin(&f, "POST", "/publications", scheduled).await;
    assert_eq!(scheduled.status, StatusCode::CREATED);
    sqlx::query("INSERT INTO platform.storefront_notification_publications(id,audience,title,body,published_at,expires_at,created_by,request_hash) VALUES($1,'all','Expired','Old content',now()-interval '2 days',now()-interval '1 day',$2,'test')").bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    let initial = call(
        &f,
        "GET",
        "/v1/notifications?limit=1",
        Value::Null,
        None,
        None,
    )
    .await;
    let cookie = cookie_value(&initial);
    assert_eq!(initial.body["items"].as_array().unwrap().len(), 1);
    assert_eq!(initial.body["unread_count"], 2);
    let cursor = &initial.body["next_cursor"];
    let page = call(
        &f,
        "GET",
        &format!(
            "/v1/notifications?limit=1&before={}&before_id={}",
            cursor["before"].as_str().unwrap(),
            cursor["before_id"].as_str().unwrap()
        ),
        Value::Null,
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(page.body["items"].as_array().unwrap().len(), 1);
    assert_ne!(ids(&page.body), ids(&initial.body));
    assert!(page.body["next_cursor"].is_null());
    let newer = broadcast(&f, "all").await;
    let mut backdated = announcement("all");
    backdated["starts_at"] = json!(Utc::now() - Duration::minutes(1));
    let backdated = admin(&f, "POST", "/publications", backdated).await;
    assert_eq!(backdated.status, StatusCode::CREATED);
    let marked = call(
        &f,
        "POST",
        "/v1/notifications/read-all",
        json!({"through":initial.body["snapshot_at"]}),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(marked.status, StatusCode::OK, "{}", marked.body);
    assert_eq!(marked.body["updated"], 2);
    assert_eq!(marked.body["unread_count"], 2);
    let unread = call(
        &f,
        "GET",
        "/v1/notifications?filter=unread",
        Value::Null,
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(
        ids(&unread.body),
        vec![
            newer["id"].as_str().unwrap(),
            backdated.body["id"].as_str().unwrap()
        ]
    );
    let again = call(
        &f,
        "POST",
        "/v1/notifications/read-all",
        json!({"through":initial.body["snapshot_at"]}),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(again.body["updated"], 0);
    let reopened = call(
        &f,
        "PUT",
        &format!("/v1/notifications/{}/read", first["id"].as_str().unwrap()),
        json!({"read":false}),
        Some(&cookie),
        None,
    )
    .await;
    assert!(reopened.body["read_at"].is_null());
    assert_eq!(reopened.body["unread_count"], 3);
    assert_eq!(
        call(
            &f,
            "POST",
            "/v1/notifications/read-all",
            json!({"through":Utc::now()+Duration::days(1)}),
            Some(&cookie),
            None
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    for path in [
        "/v1/notifications?limit=51",
        "/v1/notifications?filter=bad",
        "/v1/notifications?before_id=550e8400-e29b-41d4-a716-446655440000",
    ] {
        assert_eq!(
            call(&f, "GET", path, Value::Null, Some(&cookie), None)
                .await
                .status,
            StatusCode::BAD_REQUEST
        );
    }
    let hidden = call(
        &f,
        "PUT",
        &format!(
            "/v1/notifications/{}/read",
            scheduled.body["id"].as_str().unwrap()
        ),
        json!({"read":true}),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(hidden.status, StatusCode::NOT_FOUND);
    assert_ne!(first["id"], second["id"]);
}

#[sqlx::test(migrations = "../../migrations")]
async fn publishing_permissions_customer_privacy_and_guest_csrf_are_enforced(pool: PgPool) {
    let f = setup(&pool).await;
    let general = broadcast(&f, "all").await;
    let record = generated(&f, "in_app").await;
    let target_path = format!("/records/{}/publish", record["id"].as_str().unwrap());
    let personal = admin(&f, "POST", &target_path, publish_options()).await;
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['notifications.read','notifications.publish'] WHERE id=$1").bind(f.role).execute(&pool).await.unwrap();
    let list = admin(&f, "GET", "/publications", Value::Null).await;
    assert_eq!(list.body["total"], 1);
    assert!(!list.body.to_string().contains("First"));
    assert_eq!(
        admin(&f, "POST", &target_path, publish_options())
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        admin(
            &f,
            "POST",
            &format!(
                "/publications/{}/withdraw",
                personal.body["id"].as_str().unwrap()
            ),
            json!({"version":1})
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        admin(&f, "POST", "/publications", announcement("guests"))
            .await
            .status,
        StatusCode::CREATED
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['notifications.read'] WHERE id=$1")
        .bind(f.role)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        admin(&f, "POST", "/publications", announcement("all"))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let guest = call(&f, "GET", "/v1/notifications", Value::Null, None, None).await;
    let cookie = cookie_value(&guest);
    for (flag, origin) in [(false, None), (true, Some("https://evil.example"))] {
        let mut request = Request::builder()
            .method("PUT")
            .uri(format!(
                "/v1/notifications/{}/read",
                general["id"].as_str().unwrap()
            ))
            .header("cookie", &cookie)
            .header("content-type", "application/json");
        if flag {
            request = request.header("x-commerce-request", "1");
        }
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let result = f
            .app
            .clone()
            .oneshot(request.body(Body::from("{\"read\":true}")).unwrap())
            .await
            .unwrap();
        assert_eq!(result.status(), StatusCode::FORBIDDEN);
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn broad_content_links_and_publication_windows_are_validated(pool: PgPool) {
    let f = setup(&pool).await;
    for (field, value) in [
        ("title", json!("{{customer.name}}")),
        ("body", json!("A {placeholder}")),
        ("audience", json!("customer")),
        ("cta_path", json!("https://evil.example")),
        ("cta_path", Value::Null),
        ("customer_id", json!(f.customers[0])),
        ("expires_at", json!(Utc::now() + Duration::days(91))),
        ("starts_at", json!(Utc::now() + Duration::days(91))),
        ("idempotency_key", json!(Uuid::nil())),
    ] {
        let mut body = announcement("all");
        body[field] = value;
        let result = admin(&f, "POST", "/publications", body).await;
        assert_eq!(
            result.status,
            StatusCode::BAD_REQUEST,
            "{field}: {}",
            result.body
        );
    }
    let mut valid = announcement("all");
    valid["title"] = json!("م".repeat(200));
    valid["cta_path"] = json!("/pages/privacy");
    assert_eq!(
        admin(&f, "POST", "/publications", valid.clone())
            .await
            .status,
        StatusCode::CREATED
    );
    valid["idempotency_key"] = json!(Uuid::new_v4());
    valid["title"] = json!("م".repeat(201));
    assert_eq!(
        admin(&f, "POST", "/publications", valid).await.status,
        StatusCode::BAD_REQUEST
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn inbox_snapshot_waits_for_prior_publication_commit(pool: PgPool) {
    let f = setup(&pool).await;
    let guest = call(&f, "GET", "/v1/notifications", Value::Null, None, None).await;
    let cookie = cookie_value(&guest);
    let mut publishing = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(1040701)")
        .execute(&mut *publishing)
        .await
        .unwrap();
    let notice = Uuid::new_v4();
    sqlx::query("INSERT INTO platform.storefront_notification_publications(id,audience,title,body,published_at,expires_at,created_by,request_hash) VALUES($1,'all','Committing notice','Visible after the snapshot waits',clock_timestamp(),clock_timestamp()+interval '1 day',$2,'commit-race-test')")
        .bind(notice).bind(Uuid::new_v4()).execute(&mut *publishing).await.unwrap();
    let browser = f.clone();
    let browser_cookie = cookie.clone();
    let pending = tokio::spawn(async move {
        call(
            &browser,
            "GET",
            "/v1/notifications",
            Value::Null,
            Some(&browser_cookie),
            None,
        )
        .await
    });
    // Allow admission/recipient round trips over a remote test database before
    // observing the actual publication lock; the gateway lock timeout is unchanged.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=1040701 AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND NOT granted)").fetch_one(&pool).await.unwrap();
        if waiting {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Inbox did not wait for publication commit"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(!pending.is_finished());
    publishing.commit().await.unwrap();
    let snapshot = pending.await.unwrap();
    assert_eq!(snapshot.status, StatusCode::OK, "{}", snapshot.body);
    assert_eq!(ids(&snapshot.body), vec![notice.to_string()]);
    let marked = call(
        &f,
        "POST",
        "/v1/notifications/read-all",
        json!({"through":snapshot.body["snapshot_at"]}),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(marked.body["updated"], 1);
    assert_eq!(marked.body["unread_count"], 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn area_targeting_filters_inbox_counts_and_all_read_actions(pool: PgPool) {
    let f = setup(&pool).await;
    let area = Uuid::new_v4();
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km) VALUES($1,'Cairo',30,31,5)")
        .bind(area).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.area_stock_links(area_id,stock_id) SELECT $1,id FROM inventory.stocks WHERE is_default")
        .bind(area).execute(&pool).await.unwrap();
    let mut input = announcement("all");
    input["area_ids"] = json!([area]);
    let published = admin(&f, "POST", "/publications", input.clone()).await;
    assert_eq!(published.status, StatusCode::CREATED, "{}", published.body);
    assert_eq!(published.body["area_ids"], json!([area]));
    let replay = admin(&f, "POST", "/publications", input.clone()).await;
    assert_eq!(replay.body["id"], published.body["id"]);
    input["area_ids"] = json!([]);
    assert_eq!(
        admin(&f, "POST", "/publications", input).await.status,
        StatusCode::CONFLICT
    );
    broadcast(&f, "all").await;
    let path = format!(
        "/v1/notifications/{}/read",
        published.body["id"].as_str().unwrap()
    );
    for token in [None, Some(f.tokens[0].as_str())] {
        let initial = call_at(
            &f,
            "GET",
            "/v1/notifications",
            Value::Null,
            None,
            token,
            Some((30., 31.)),
        )
        .await;
        assert_eq!(initial.status, StatusCode::OK, "{}", initial.body);
        assert_eq!(initial.body["unread_count"], 2);
        let cookie = initial.cookie.as_deref();
        for pin in [None, Some((0., 0.))] {
            let outside = call_at(
                &f,
                "GET",
                "/v1/notifications",
                Value::Null,
                cookie,
                token,
                pin,
            )
            .await;
            assert_eq!(outside.body["items"].as_array().unwrap().len(), 1);
            assert_eq!(outside.body["unread_count"], 1);
            assert_eq!(
                call_at(&f, "PUT", &path, json!({"read":true}), cookie, token, pin)
                    .await
                    .status,
                StatusCode::NOT_FOUND
            );
        }
        let all = call_at(
            &f,
            "POST",
            "/v1/notifications/read-all",
            json!({"through":initial.body["snapshot_at"]}),
            cookie,
            token,
            None,
        )
        .await;
        assert_eq!(all.body["updated"], 1);
        let inside = call_at(
            &f,
            "GET",
            "/v1/notifications",
            Value::Null,
            cookie,
            token,
            Some((30., 31.)),
        )
        .await;
        assert_eq!(inside.body["unread_count"], 1);
        let read = call_at(
            &f,
            "PUT",
            &path,
            json!({"read":true}),
            cookie,
            token,
            Some((30., 31.)),
        )
        .await;
        assert_eq!(read.status, StatusCode::OK);
        assert_eq!(read.body["unread_count"], 0);
    }
    for ids in [json!([Uuid::new_v4()]), json!([area, area])] {
        let mut input = announcement("all");
        input["area_ids"] = ids;
        assert_eq!(
            admin(&f, "POST", "/publications", input).await.status,
            StatusCode::BAD_REQUEST
        );
    }
    sqlx::query("UPDATE inventory.delivery_areas SET is_active=false WHERE id=$1")
        .bind(area)
        .execute(&pool)
        .await
        .unwrap();
    let mut input = announcement("all");
    input["area_ids"] = json!([area]);
    assert_eq!(
        admin(&f, "POST", "/publications", input).await.status,
        StatusCode::BAD_REQUEST
    );
    let disabled = call_at(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        None,
        Some(&f.tokens[0]),
        Some((30., 31.)),
    )
    .await;
    assert_eq!(disabled.body["items"].as_array().unwrap().len(), 1);
}

async fn visit_product(pool: &PgPool) -> Uuid {
    let category = Uuid::new_v4();
    let product = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO catalog.categories(id,name,slug) VALUES($1,'Visit test','visit-test')",
    )
    .bind(category)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) VALUES($1,'VISIT-TEST','visit-tomatoes','Tomatoes','Test',1.50,'USD','each',$2)").bind(product).bind(category).execute(pool).await.unwrap();
    product
}

#[sqlx::test(migrations = "../../migrations")]
async fn product_visits_deliver_once_to_guests_and_customers_without_broadcasting(pool: PgPool) {
    let f = setup(&pool).await;
    let product = visit_product(&pool).await;
    let mut input = announcement("all");
    input["trigger_product_id"] = json!(product);
    let published = admin(&f, "POST", "/publications", input.clone()).await;
    assert_eq!(published.status, StatusCode::CREATED, "{}", published.body);
    let id = published.body["id"].as_str().unwrap();
    let replay = admin(&f, "POST", "/publications", input.clone()).await;
    assert_eq!(replay.body["id"], id);
    input["trigger_product_id"] = Value::Null;
    assert_eq!(
        admin(&f, "POST", "/publications", input).await.status,
        StatusCode::CONFLICT
    );
    let guest = call(&f, "GET", "/v1/notifications", Value::Null, None, None).await;
    assert_eq!(guest.body["unread_count"], 0);
    let cookie = cookie_value(&guest);
    let read_path = format!("/v1/notifications/{id}/read");
    assert_eq!(
        call(
            &f,
            "PUT",
            &read_path,
            json!({"read":true}),
            Some(&cookie),
            None
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &f,
            "POST",
            "/v1/notifications/product-view",
            json!({"product":product}),
            None,
            None
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &f,
            "POST",
            "/v1/notifications/product-view",
            json!({"product":product}),
            Some(&cookie),
            Some("invalid")
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &f,
            "POST",
            "/v1/notifications/product-view",
            json!({"product":Uuid::new_v4()}),
            Some(&cookie),
            None
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    let visit = json!({"product":"visit-tomatoes"});
    let (first, second) = tokio::join!(
        call(
            &f,
            "POST",
            "/v1/notifications/product-view",
            visit.clone(),
            Some(&cookie),
            None
        ),
        call(
            &f,
            "POST",
            "/v1/notifications/product-view",
            visit,
            Some(&cookie),
            None
        )
    );
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);
    assert_eq!(second.status, StatusCode::OK, "{}", second.body);
    assert_eq!(
        first.body["delivered"].as_u64().unwrap() + second.body["delivered"].as_u64().unwrap(),
        1
    );
    // The old snapshot must not mark an offer delivered after that snapshot read.
    let marked = call(
        &f,
        "POST",
        "/v1/notifications/read-all",
        json!({"through":guest.body["snapshot_at"]}),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(marked.body["updated"], 0, "{}", marked.body);
    assert_eq!(marked.body["unread_count"], 1);
    let inbox = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(ids(&inbox.body), vec![id.to_string()]);
    assert_eq!(inbox.body["items"][0]["kind"], "journey");
    let read = call(
        &f,
        "PUT",
        &read_path,
        json!({"read":true}),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(read.body["unread_count"], 0, "{}", read.body);
    let again = call(
        &f,
        "POST",
        "/v1/notifications/product-view",
        json!({"product":product}),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(again.body["delivered"], 0);
    let stranger = call(&f, "GET", "/v1/notifications", Value::Null, None, None).await;
    assert_eq!(stranger.body["unread_count"], 0);
    // Signing in never transfers a guest's offer or read state; each account qualifies itself.
    let customer = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        Some(&cookie),
        Some(&f.tokens[0]),
    )
    .await;
    assert_eq!(customer.body["unread_count"], 0);
    let signed = call(
        &f,
        "POST",
        "/v1/notifications/product-view",
        json!({"product":product}),
        Some(&cookie),
        Some(&f.tokens[0]),
    )
    .await;
    assert_eq!(signed.body["delivered"], 1, "{}", signed.body);
    let other = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        None,
        Some(&f.tokens[1]),
    )
    .await;
    assert_eq!(other.body["unread_count"], 0);
    admin(
        &f,
        "POST",
        &format!("/publications/{id}/withdraw"),
        json!({"version":1}),
    )
    .await;
    assert_eq!(
        call(
            &f,
            "GET",
            "/v1/notifications",
            Value::Null,
            None,
            Some(&f.tokens[0])
        )
        .await
        .body["unread_count"],
        0
    );
    assert_eq!(
        call(
            &f,
            "POST",
            "/v1/notifications/product-view",
            json!({"product":product}),
            None,
            Some(&f.tokens[1])
        )
        .await
        .body["delivered"],
        0
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn product_campaigns_enforce_schedule_audience_area_and_active_products(pool: PgPool) {
    let f = setup(&pool).await;
    let product = visit_product(&pool).await;
    let mut invalid = announcement("all");
    invalid["trigger_product_id"] = json!(Uuid::new_v4());
    assert_eq!(
        admin(&f, "POST", "/publications", invalid).await.status,
        StatusCode::BAD_REQUEST
    );
    let area = Uuid::new_v4();
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km) VALUES($1,'Cairo visit',30,31,5)").bind(area).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.area_stock_links(area_id,stock_id) SELECT $1,id FROM inventory.stocks WHERE is_default").bind(area).execute(&pool).await.unwrap();
    let mut input = announcement("guests");
    input["trigger_product_id"] = json!(product);
    input["area_ids"] = json!([area]);
    let publication = admin(&f, "POST", "/publications", input.clone()).await;
    assert_eq!(
        publication.status,
        StatusCode::CREATED,
        "{}",
        publication.body
    );
    input["idempotency_key"] = json!(Uuid::new_v4());
    input["starts_at"] = json!(Utc::now() + Duration::days(1));
    let future = admin(&f, "POST", "/publications", input).await;
    assert_eq!(future.status, StatusCode::CREATED, "{}", future.body);
    let guest = call(&f, "GET", "/v1/notifications", Value::Null, None, None).await;
    let cookie = cookie_value(&guest);
    let visit = json!({"product":product});
    assert_eq!(
        call(
            &f,
            "POST",
            "/v1/notifications/product-view",
            visit.clone(),
            Some(&cookie),
            None
        )
        .await
        .body["delivered"],
        0
    );
    assert_eq!(
        call_at(
            &f,
            "POST",
            "/v1/notifications/product-view",
            visit.clone(),
            None,
            Some(&f.tokens[0]),
            Some((30., 31.))
        )
        .await
        .body["delivered"],
        0
    );
    assert_eq!(
        call_at(
            &f,
            "POST",
            "/v1/notifications/product-view",
            visit.clone(),
            Some(&cookie),
            None,
            Some((30., 31.))
        )
        .await
        .body["delivered"],
        1
    );
    assert_eq!(
        call(
            &f,
            "GET",
            "/v1/notifications",
            Value::Null,
            Some(&cookie),
            None
        )
        .await
        .body["unread_count"],
        0
    );
    let visible = call_at(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        Some(&cookie),
        None,
        Some((30., 31.)),
    )
    .await;
    assert_eq!(visible.body["unread_count"], 1);
    // Seed a historical expired campaign and its old delivery without mutating
    // the immutable publication snapshot.
    admin(
        &f,
        "POST",
        &format!(
            "/publications/{}/withdraw",
            publication.body["id"].as_str().unwrap()
        ),
        json!({"version":1}),
    )
    .await;
    let expired = Uuid::new_v4();
    sqlx::query("INSERT INTO platform.storefront_notification_publications(id,audience,title,body,published_at,expires_at,created_by,request_hash,trigger_product_id) VALUES($1,'all','Expired offer','Old coupon',now()-interval '2 days',now()-interval '1 day',$2,'expired-visit',$3)")
        .bind(expired).bind(Uuid::new_v4()).bind(product).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO platform.storefront_notification_deliveries(recipient_id,publication_id,delivered_at) SELECT id,$1,now()-interval '2 days' FROM platform.storefront_notification_recipients WHERE guest_hash=$2")
        .bind(expired).bind(infra_auth::digest(cookie.strip_prefix("inbox_guest=").unwrap())).execute(&pool).await.unwrap();
    assert_eq!(
        call_at(
            &f,
            "GET",
            "/v1/notifications",
            Value::Null,
            Some(&cookie),
            None,
            Some((30., 31.))
        )
        .await
        .body["unread_count"],
        0
    );
    let stranger = call(&f, "GET", "/v1/notifications", Value::Null, None, None).await;
    assert_eq!(
        call_at(
            &f,
            "POST",
            "/v1/notifications/product-view",
            visit.clone(),
            Some(&cookie_value(&stranger)),
            None,
            Some((30., 31.))
        )
        .await
        .body["delivered"],
        0
    );
    sqlx::query("UPDATE catalog.products SET active=false WHERE id=$1")
        .bind(product)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        call(
            &f,
            "POST",
            "/v1/notifications/product-view",
            visit,
            Some(&cookie),
            None
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn deletion_removes_history_and_inbox_and_search_precedes_pagination(pool: PgPool) {
    let f = setup(&pool).await;
    let first = broadcast(&f, "all").await;
    broadcast(&f, "guests").await;
    let found = admin(
        &f,
        "GET",
        "/publications?search=For%20all&status=live&limit=1",
        Value::Null,
    )
    .await;
    assert_eq!(found.status, StatusCode::OK);
    assert_eq!(found.body["total"], 1);
    let id = first["id"].as_str().unwrap();
    let path = format!("/publications/{id}");
    assert_eq!(
        admin(&f, "DELETE", &path, json!({"version":99}))
            .await
            .status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        admin(&f, "DELETE", &path, json!({"version":1}))
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        admin(&f, "DELETE", &path, json!({"version":1}))
            .await
            .status,
        StatusCode::OK
    );
    let history = admin(&f, "GET", "/publications?search=For%20all", Value::Null).await;
    assert_eq!(history.body["total"], 0);
    let inbox = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        None,
        Some(&f.tokens[0]),
    )
    .await;
    assert!(!ids(&inbox.body).contains(&id.to_owned()));
    let retained: bool = sqlx::query_scalar("SELECT deleted_at IS NOT NULL AND withdrawn_at IS NOT NULL FROM platform.storefront_notification_publications WHERE id=$1").bind(Uuid::parse_str(id).unwrap()).fetch_one(&pool).await.unwrap();
    assert!(retained);
}

async fn isolated_fixture(source: &PgPool, mut f: Fixture) -> (Fixture, PgPool, String) {
    let name = format!("engagement_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(source)
        .await
        .unwrap();
    let options = (*source.connect_options()).clone().database(&name);
    let target = sqlx::postgres::PgPoolOptions::new()
        .max_connections(6)
        .connect_with(options)
        .await
        .unwrap();
    api_gateway::engagement::migrate(&target).await.unwrap();
    api_gateway::engagement::import(source, &target)
        .await
        .unwrap();
    api_gateway::engagement::project(source, &target)
        .await
        .unwrap();
    f.state.engagement = target.clone();
    f.state.engagement_isolated = true;
    f.app = marketing_notifications::router(f.state.clone())
        .merge(storefront_notifications::router(f.state.clone()));
    (f, target, name)
}
async fn remove_isolated(source: &PgPool, target: PgPool, name: String, f: Fixture) {
    drop(f);
    target.close().await;
    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .execute(source)
        .await
        .unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn isolated_cutover_preserves_publications_guests_read_states_and_retries(pool: PgPool) {
    let f = setup(&pool).await;
    let published = broadcast(&f, "all").await;
    let guest = call(&f, "GET", "/v1/notifications", Value::Null, None, None).await;
    let cookie = cookie_value(&guest);
    call(
        &f,
        "PUT",
        &format!(
            "/v1/notifications/{}/read",
            published["id"].as_str().unwrap()
        ),
        json!({"read":true}),
        Some(&cookie),
        None,
    )
    .await;
    let (f, target, name) = isolated_fixture(&pool, f).await;
    let inbox = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(inbox.status, StatusCode::OK, "{}", inbox.body);
    assert_eq!(inbox.body["unread_count"], 0);
    assert_eq!(inbox.body["items"][0]["id"], published["id"]);
    assert!(!inbox.body["items"][0]["read_at"].is_null());
    assert!(inbox.cookie.is_none());
    api_gateway::engagement::import(&pool, &target)
        .await
        .unwrap();
    let new = broadcast(&f, "all").await;
    let source_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM platform.storefront_notification_publications")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(source_count, 1, "New campaigns must not write to commerce");
    let private_record = generated(&f, "in_app").await;
    assert_eq!(private_record["customer_id"], json!(f.customers[0]));
    let record_source_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM platform.marketing_notification_records")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(record_source_count, 0);
    assert_ne!(new["id"], published["id"]);
    remove_isolated(&pool, target, name, f).await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn isolated_product_queue_is_durable_and_matching_never_writes_commerce(pool: PgPool) {
    let f = setup(&pool).await;
    let product = visit_product(&pool).await;
    let (f, target, name) = isolated_fixture(&pool, f).await;
    let mut input = announcement("all");
    input["trigger_product_id"] = json!(product);
    let published = admin(&f, "POST", "/publications", input).await;
    assert_eq!(published.status, StatusCode::CREATED, "{}", published.body);
    let guest = call(&f, "GET", "/v1/notifications", Value::Null, None, None).await;
    let cookie = cookie_value(&guest);
    let visit = call(
        &f,
        "POST",
        "/v1/notifications/product-view",
        json!({"product":product}),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(visit.status, StatusCode::ACCEPTED, "{}", visit.body);
    assert_eq!(visit.body["queued"], true);
    assert_eq!(
        call(
            &f,
            "GET",
            "/v1/notifications",
            Value::Null,
            Some(&cookie),
            None
        )
        .await
        .body["unread_count"],
        0,
        "No inline matching before worker runs"
    );
    let duplicate = call(
        &f,
        "POST",
        "/v1/notifications/product-view",
        json!({"product":product}),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(duplicate.body["event_id"], visit.body["event_id"]);
    assert!(api_gateway::engagement::process_one(&target, None)
        .await
        .unwrap());
    assert!(!api_gateway::engagement::process_one(&target, None)
        .await
        .unwrap());
    let inbox = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(inbox.body["unread_count"], 1, "{}", inbox.body);
    let source_grants: i64 =
        sqlx::query_scalar("SELECT count(*) FROM platform.storefront_notification_deliveries")
            .fetch_one(&pool)
            .await
            .unwrap();
    let source_recipients: i64 =
        sqlx::query_scalar("SELECT count(*) FROM platform.storefront_notification_recipients")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!((source_grants, source_recipients), (0, 0));
    // The production worker refreshes projection and heartbeat independently of
    // process_one. Advance that fixture state after slow remote test round trips.
    api_gateway::engagement::project(&pool, &target)
        .await
        .unwrap();
    sqlx::query("UPDATE platform.engagement_worker_state SET heartbeat_at=clock_timestamp() WHERE singleton")
        .execute(&target).await.unwrap();
    assert!(api_gateway::engagement::health(&target).await.unwrap());
    remove_isolated(&pool, target, name, f).await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn isolated_browser_queue_and_failed_target_never_fall_back_to_commerce(pool: PgPool) {
    let f = setup(&pool).await;
    let (f, target, name) = isolated_fixture(&pool, f).await;
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        "authorization",
        format!("Bearer {}", f.tokens[0]).parse().unwrap(),
    );
    let id = Uuid::new_v4();
    let event = || api_gateway::analytics::Event {
        id,
        session_id: Uuid::new_v4(),
        event_type: "page_view".into(),
        path: "/products/visit-tomatoes".into(),
        query: None,
        result_count: None,
        source: Some("direct".into()),
    };
    api_gateway::customer_journey::enqueue_browser(&f.state, &headers, event())
        .await
        .unwrap();
    assert!(api_gateway::engagement::process_one(&target, None)
        .await
        .unwrap());
    let source_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM customers.journey_events WHERE id=$1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let target_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM customers.journey_events WHERE id=$1")
            .bind(id)
            .fetch_one(&target)
            .await
            .unwrap();
    assert_eq!((source_count, target_count), (0, 1));
    target.close().await;
    assert!(
        api_gateway::customer_journey::enqueue_browser(&f.state, &headers, event())
            .await
            .is_err()
    );
    let source_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM customers.journey_events WHERE id=$1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(source_count, 0);
    let inbox = call(&f, "GET", "/v1/notifications", Value::Null, None, None).await;
    assert!(inbox.status.is_server_error());
    remove_isolated(&pool, target, name, f).await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn isolated_worker_retries_stale_projection_and_rechecks_withdrawal(pool: PgPool) {
    let f = setup(&pool).await;
    let product = visit_product(&pool).await;
    let (f, target, name) = isolated_fixture(&pool, f).await;
    let mut input = announcement("all");
    input["trigger_product_id"] = json!(product);
    let published = admin(&f, "POST", "/publications", input).await;
    assert_eq!(published.status, StatusCode::CREATED);
    let guest = call(&f, "GET", "/v1/notifications", Value::Null, None, None).await;
    let cookie = cookie_value(&guest);
    let visit = call(
        &f,
        "POST",
        "/v1/notifications/product-view",
        json!({"product":product}),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(visit.status, StatusCode::ACCEPTED);
    sqlx::query("UPDATE platform.engagement_worker_state SET projection_at=clock_timestamp()-interval '3 minutes'").execute(&target).await.unwrap();
    assert!(api_gateway::engagement::process_one(&target, None)
        .await
        .unwrap());
    let attempts: i32 = sqlx::query_scalar("SELECT attempts FROM platform.engagement_jobs")
        .fetch_one(&target)
        .await
        .unwrap();
    assert_eq!(attempts, 1);
    assert!(!api_gateway::engagement::health(&target).await.unwrap());
    let path = format!(
        "/publications/{}/withdraw",
        published.body["id"].as_str().unwrap()
    );
    assert_eq!(
        admin(&f, "POST", &path, json!({"version":1})).await.status,
        StatusCode::OK
    );
    api_gateway::engagement::project(&pool, &target)
        .await
        .unwrap();
    sqlx::query("UPDATE platform.engagement_jobs SET available_at=clock_timestamp()")
        .execute(&target)
        .await
        .unwrap();
    assert!(api_gateway::engagement::process_one(&target, None)
        .await
        .unwrap());
    let result: (bool, Value) =
        sqlx::query_as("SELECT completed_at IS NOT NULL,payload FROM platform.engagement_jobs")
            .fetch_one(&target)
            .await
            .unwrap();
    assert_eq!(
        result,
        (true, json!({})),
        "Completed job payload must be scrubbed"
    );
    assert_eq!(
        call(
            &f,
            "GET",
            "/v1/notifications",
            Value::Null,
            Some(&cookie),
            None
        )
        .await
        .body["unread_count"],
        0,
        "Withdrawn campaign must not deliver after retry"
    );
    let deleted = admin(
        &f,
        "DELETE",
        &format!("/publications/{}", published.body["id"].as_str().unwrap()),
        json!({"version":2}),
    )
    .await;
    assert_eq!(deleted.status, StatusCode::OK, "{}", deleted.body);
    remove_isolated(&pool, target, name, f).await;
}

fn campaign_rules(trigger: Option<&str>) -> Value {
    json!({"segment_ids":[],"segment_match":"any","trigger_kind":trigger,"conditions":{"match":"all","rules":[]},"delay_minutes":0,"lookback_days":30,"cooldown_hours":0,"max_deliveries":1,"suppress_after_purchase":false})
}
fn campaign_input(audience: &str, rules: Value) -> Value {
    let mut message = announcement(audience);
    message.as_object_mut().unwrap().remove("idempotency_key");
    message["audience_rules"] = rules;
    json!({"name":"Unified customer campaign","description":"Audience, journey and time","version":0,"announcement":message})
}
#[sqlx::test(migrations = "../../migrations")]
async fn campaign_drafts_are_versioned_and_activation_is_atomic_idempotent_and_private(
    pool: PgPool,
) {
    let f = setup(&pool).await;
    let input = campaign_input("customers", campaign_rules(None));
    let draft = admin(&f, "POST", "/campaigns", input.clone()).await;
    assert_eq!(draft.status, StatusCode::CREATED, "{}", draft.body);
    let id = draft.body["id"].as_str().unwrap();
    assert_eq!(draft.body["status"], "draft");
    let initial = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        None,
        Some(&f.tokens[0]),
    )
    .await;
    assert_eq!(initial.body["unread_count"], 0);
    let mut update = input.clone();
    update["version"] = json!(1);
    update["name"] = json!("Revised campaign");
    assert_eq!(
        admin(&f, "PUT", &format!("/campaigns/{id}"), update.clone())
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        admin(&f, "PUT", &format!("/campaigns/{id}"), update)
            .await
            .status,
        StatusCode::CONFLICT
    );
    let key = json!({"version":2,"idempotency_key":Uuid::new_v4()});
    let activated = admin(
        &f,
        "POST",
        &format!("/campaigns/{id}/activate"),
        key.clone(),
    )
    .await;
    assert_eq!(activated.status, StatusCode::CREATED, "{}", activated.body);
    let replay = admin(
        &f,
        "POST",
        &format!("/campaigns/{id}/activate"),
        key.clone(),
    )
    .await;
    assert_eq!(replay.status, StatusCode::OK, "{}", replay.body);
    assert_eq!(activated.body["id"], replay.body["id"]);
    let guest = call(&f, "GET", "/v1/notifications", Value::Null, None, None).await;
    assert_eq!(guest.body["unread_count"], 0);
    let customer = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        None,
        Some(&f.tokens[0]),
    )
    .await;
    assert_eq!(customer.body["unread_count"], 1, "{}", customer.body);
    let other = admin(&f, "POST", "/campaigns", input).await;
    let samekey = json!({"version":1,"idempotency_key":key["idempotency_key"]});
    assert_eq!(
        admin(
            &f,
            "POST",
            &format!("/campaigns/{}/activate", other.body["id"].as_str().unwrap()),
            samekey
        )
        .await
        .status,
        StatusCode::CONFLICT
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['notifications.read','notifications.publish','notifications.write'] WHERE id=$1").bind(f.role).execute(&pool).await.unwrap();
    assert_eq!(
        admin(&f, "GET", "/campaigns?status=all", Value::Null)
            .await
            .body["total"],
        0
    );
    assert_eq!(
        admin(&f, "GET", "/publications", Value::Null).await.body["total"],
        0
    );
    assert_eq!(
        admin(&f, "GET", &format!("/campaigns/{id}"), Value::Null)
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        admin(&f, "POST", &format!("/campaigns/{id}/activate"), key)
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        admin(
            &f,
            "POST",
            &format!(
                "/publications/{}/withdraw",
                activated.body["id"].as_str().unwrap()
            ),
            json!({"version":1})
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn campaign_segments_and_conditions_match_registered_audiences_without_guest_leaks(
    pool: PgPool,
) {
    let f = setup(&pool).await;
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    for (id, name) in [(first, "First"), (second, "Second")] {
        let definition = json!({"name":format!("{name} customers"),"description":"","status":"active","website":"Main Website","applyTo":"registered","match":"all","rules":[{"id":"name","type":"customer","attribute":"first_name","operator":"is","value":name}],"revision":0});
        sqlx::query("INSERT INTO customers.segments(id,definition) VALUES($1,$2)")
            .bind(id)
            .bind(definition)
            .execute(&pool)
            .await
            .unwrap();
    }
    let mut rules = campaign_rules(None);
    rules["segment_ids"] = json!([first, second]);
    rules["conditions"] = json!({"match":"all","rules":[{"field":"customer.order_count","operator":"eq","value":"0"}]});
    let mut any = announcement("customers");
    any["audience_rules"] = rules.clone();
    let published = admin(&f, "POST", "/publications", any.clone()).await;
    assert_eq!(published.status, StatusCode::CREATED, "{}", published.body);
    for token in &f.tokens {
        let result = call(
            &f,
            "GET",
            "/v1/notifications",
            Value::Null,
            None,
            Some(token),
        )
        .await;
        assert_eq!(result.body["unread_count"], 1, "{}", result.body);
    }
    rules["segment_match"] = json!("all");
    let mut all = announcement("customers");
    all["audience_rules"] = rules.clone();
    assert_eq!(
        admin(&f, "POST", "/publications", all).await.status,
        StatusCode::CREATED
    );
    let result = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        None,
        Some(&f.tokens[0]),
    )
    .await;
    assert_eq!(result.body["unread_count"], 1);
    let mut invalid = announcement("guests");
    invalid["audience_rules"] = rules.clone();
    assert_eq!(
        admin(&f, "POST", "/publications", invalid).await.status,
        StatusCode::BAD_REQUEST
    );
    rules["segment_ids"] = json!([Uuid::new_v4()]);
    let mut missing = announcement("customers");
    missing["audience_rules"] = rules;
    assert_eq!(
        admin(&f, "POST", "/publications", missing).await.status,
        StatusCode::BAD_REQUEST
    );
    let guest = call(&f, "GET", "/v1/notifications", Value::Null, None, None).await;
    assert_eq!(guest.body["unread_count"], 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn campaign_product_reentry_requires_new_event_cooldown_and_delivery_budget(pool: PgPool) {
    let f = setup(&pool).await;
    let product = visit_product(&pool).await;
    let mut rules = campaign_rules(Some("product_view"));
    rules["max_deliveries"] = json!(2);
    rules["cooldown_hours"] = json!(1);
    rules["conditions"] = json!({"match":"all","rules":[{"field":"product.name","operator":"contains","value":"tomato"}]});
    let mut input = announcement("all");
    input["trigger_product_id"] = json!(product);
    input["audience_rules"] = rules;
    let publication = admin(&f, "POST", "/publications", input).await;
    assert_eq!(
        publication.status,
        StatusCode::CREATED,
        "{}",
        publication.body
    );
    let id = publication.body["id"].as_str().unwrap();
    let guest = call(&f, "GET", "/v1/notifications", Value::Null, None, None).await;
    let cookie = cookie_value(&guest);
    assert_eq!(guest.body["unread_count"], 0);
    call(
        &f,
        "POST",
        "/v1/notifications/product-view",
        json!({"product":product}),
        Some(&cookie),
        None,
    )
    .await;
    let inbox = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(inbox.body["unread_count"], 1, "{}", inbox.body);
    call(
        &f,
        "PUT",
        &format!("/v1/notifications/{id}/read"),
        json!({"read":true}),
        Some(&cookie),
        None,
    )
    .await;
    sqlx::query("UPDATE platform.storefront_notification_deliveries SET delivered_at=clock_timestamp()-interval '2 hours'").execute(&pool).await.unwrap();
    let unchanged = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(
        unchanged.body["unread_count"], 0,
        "Same event must not repeat after cooldown"
    );
    call(
        &f,
        "POST",
        "/v1/notifications/product-view",
        json!({"product":product}),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(
        call(
            &f,
            "GET",
            "/v1/notifications",
            Value::Null,
            Some(&cookie),
            None
        )
        .await
        .body["unread_count"],
        1
    );
    call(
        &f,
        "PUT",
        &format!("/v1/notifications/{id}/read"),
        json!({"read":true}),
        Some(&cookie),
        None,
    )
    .await;
    sqlx::query("UPDATE platform.storefront_notification_deliveries SET delivered_at=clock_timestamp()-interval '2 hours'").execute(&pool).await.unwrap();
    call(
        &f,
        "POST",
        "/v1/notifications/product-view",
        json!({"product":product}),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(
        call(
            &f,
            "GET",
            "/v1/notifications",
            Value::Null,
            Some(&cookie),
            None
        )
        .await
        .body["unread_count"],
        0
    );
    let count: i32 = sqlx::query_scalar(
        "SELECT delivery_count FROM platform.storefront_notification_deliveries",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 2);
    let changed=sqlx::query("UPDATE platform.storefront_notification_publications SET audience_rules='{}'::jsonb WHERE id=$1").bind(Uuid::parse_str(id).unwrap()).execute(&pool).await;
    assert!(changed.is_err(), "Audience snapshots must stay immutable");
}

#[sqlx::test(migrations = "../../migrations")]
async fn campaign_worker_schedules_delays_and_rechecks_withdrawal_without_commerce_writes(
    pool: PgPool,
) {
    let f = setup(&pool).await;
    let product = visit_product(&pool).await;
    let (f, target, name) = isolated_fixture(&pool, f).await;
    let mut rules = campaign_rules(Some("product_view"));
    rules["delay_minutes"] = json!(1);
    let mut input = announcement("all");
    input["trigger_product_id"] = json!(product);
    input["audience_rules"] = rules;
    let published = admin(&f, "POST", "/publications", input).await;
    assert_eq!(published.status, StatusCode::CREATED, "{}", published.body);
    let guest = call(&f, "GET", "/v1/notifications", Value::Null, None, None).await;
    let cookie = cookie_value(&guest);
    call(
        &f,
        "POST",
        "/v1/notifications/product-view",
        json!({"product":product}),
        Some(&cookie),
        None,
    )
    .await;
    for _ in 0..10 {
        if !api_gateway::engagement::process_one_with_commerce(&target, &pool, None)
            .await
            .unwrap()
        {
            break;
        }
    }
    let scheduled:i64=sqlx::query_scalar("SELECT count(*) FROM platform.engagement_jobs WHERE completed_at IS NULL AND available_at>clock_timestamp() AND kind='campaign_evaluate'").fetch_one(&target).await.unwrap();
    assert_eq!(
        scheduled, 1,
        "A durable due job should survive leaving the storefront"
    );
    sqlx::query("UPDATE platform.engagement_jobs SET created_at=clock_timestamp()-interval '10 minutes' WHERE completed_at IS NULL").execute(&target).await.unwrap();
    assert!(
        api_gateway::engagement::health(&target).await.unwrap(),
        "Scheduled jobs are not overdue before available_at"
    );
    assert_eq!(
        admin(
            &f,
            "POST",
            &format!(
                "/publications/{}/withdraw",
                published.body["id"].as_str().unwrap()
            ),
            json!({"version":1})
        )
        .await
        .status,
        StatusCode::OK
    );
    sqlx::query("UPDATE platform.engagement_jobs SET available_at=clock_timestamp() WHERE completed_at IS NULL").execute(&target).await.unwrap();
    assert!(
        api_gateway::engagement::process_one_with_commerce(&target, &pool, None)
            .await
            .unwrap()
    );
    let grants: i64 =
        sqlx::query_scalar("SELECT count(*) FROM platform.storefront_notification_deliveries")
            .fetch_one(&target)
            .await
            .unwrap();
    assert_eq!(grants, 0);
    let commerce_grants: i64 =
        sqlx::query_scalar("SELECT count(*) FROM platform.storefront_notification_deliveries")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(commerce_grants, 0);
    remove_isolated(&pool, target, name, f).await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn campaign_worker_continues_past_one_hundred_and_due_jobs_revisit_the_exact_campaign(
    pool: PgPool,
) {
    let f = setup(&pool).await;
    let product = visit_product(&pool).await;
    let (f, target, name) = isolated_fixture(&pool, f).await;
    let plain = campaign_rules(None);
    let mut no_match = campaign_rules(Some("product_view"));
    no_match["conditions"] = json!({"match":"all","rules":[{"field":"product.name","operator":"eq","value":"Never match"}]});
    let mut delayed = campaign_rules(Some("product_view"));
    delayed["delay_minutes"] = json!(1);
    let first = Uuid::from_u128(1);
    let last = Uuid::from_u128(u128::MAX);
    sqlx::query("INSERT INTO platform.storefront_notification_publications(id,audience,title,body,published_at,expires_at,created_by,request_hash,audience_rules) SELECT md5(g::text)::uuid,'guests','Other campaign','No eligible event',clock_timestamp()-interval '2 minutes',clock_timestamp()+interval '1 day',$1,'test',$2 FROM generate_series(1,99) g")
        .bind(Uuid::new_v4()).bind(no_match).execute(&target).await.unwrap();
    // The final campaign lies beyond the first bounded page and needs no event.
    for (id, rules) in [(first, delayed), (last, plain)] {
        sqlx::query("INSERT INTO platform.storefront_notification_publications(id,audience,title,body,published_at,expires_at,created_by,request_hash,audience_rules) VALUES($1,'guests','Paging campaign','Bounded queue',clock_timestamp()-interval '2 minutes',clock_timestamp()+interval '1 day',$2,'test',$3)")
            .bind(id).bind(Uuid::new_v4()).bind(rules).execute(&target).await.unwrap();
    }
    let guest = call(&f, "GET", "/v1/notifications", Value::Null, None, None).await;
    let cookie = cookie_value(&guest);
    call(
        &f,
        "POST",
        "/v1/notifications/product-view",
        json!({"product":product}),
        Some(&cookie),
        None,
    )
    .await;
    for _ in 0..12 {
        if !api_gateway::engagement::process_one_with_commerce(&target, &pool, None)
            .await
            .unwrap()
        {
            break;
        }
    }
    let granted: Vec<Uuid> = sqlx::query_scalar(
        "SELECT publication_id FROM platform.storefront_notification_deliveries",
    )
    .fetch_all(&target)
    .await
    .unwrap();
    assert_eq!(
        granted,
        vec![last],
        "Bounded continuation must visit campaign 101 without another browser poll"
    );
    let due:Value=sqlx::query_scalar("SELECT payload FROM platform.engagement_jobs WHERE completed_at IS NULL AND dedupe_key LIKE 'campaign-due:%'").fetch_one(&target).await.unwrap();
    assert_eq!(due["campaign"], json!(first));
    sqlx::query("UPDATE platform.notification_campaign_events SET occurred_at=clock_timestamp()-interval '61 seconds' WHERE kind='product_view'").execute(&target).await.unwrap();
    sqlx::query("UPDATE platform.engagement_jobs SET available_at=clock_timestamp() WHERE completed_at IS NULL").execute(&target).await.unwrap();
    assert!(
        api_gateway::engagement::process_one_with_commerce(&target, &pool, None)
            .await
            .unwrap()
    );
    let granted:Vec<Uuid>=sqlx::query_scalar("SELECT publication_id FROM platform.storefront_notification_deliveries ORDER BY publication_id").fetch_all(&target).await.unwrap();
    assert_eq!(
        granted,
        vec![first, last],
        "Due job must return to its own campaign after pagination"
    );
    remove_isolated(&pool, target, name, f).await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn campaign_authoritative_purchase_events_and_future_start_jobs_use_isolated_storage(
    pool: PgPool,
) {
    let f = setup(&pool).await;
    let (f, target, name) = isolated_fixture(&pool, f).await;
    let mut rules = campaign_rules(Some("purchase"));
    rules["conditions"] = json!({"match":"all","rules":[{"field":"order.total","operator":"gte","value":"10.00","currency":"USD"}]});
    let mut input = announcement("customers");
    input["audience_rules"] = rules;
    let published = admin(&f, "POST", "/publications", input).await;
    assert_eq!(published.status, StatusCode::CREATED, "{}", published.body);
    let first = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        None,
        Some(&f.tokens[0]),
    )
    .await;
    assert_eq!(first.body["unread_count"], 0);
    for _ in 0..4 {
        if !api_gateway::engagement::process_one_with_commerce(&target, &pool, None)
            .await
            .unwrap()
        {
            break;
        }
    }
    let before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM platform.storefront_notification_deliveries")
            .fetch_one(&target)
            .await
            .unwrap();
    assert_eq!(
        before, 0,
        "Browser visits cannot manufacture a purchase event"
    );
    sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency) VALUES($1,$2,$3,$4,'placed','{}','{}',10,0,10,'USD')")
        .bind(Uuid::new_v4()).bind(f.customers[0]).bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    let recipient: Uuid = sqlx::query_scalar(
        "SELECT id FROM platform.storefront_notification_recipients WHERE customer_id=$1",
    )
    .bind(f.customers[0])
    .fetch_one(&target)
    .await
    .unwrap();
    api_gateway::engagement::enqueue(
        &target,
        format!("test-purchase:{}", Uuid::new_v4()),
        "campaign_evaluate",
        json!({"recipient":recipient,"area":null}),
    )
    .await
    .unwrap();
    assert!(
        api_gateway::engagement::process_one_with_commerce(&target, &pool, None)
            .await
            .unwrap()
    );
    let inbox = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        None,
        Some(&f.tokens[0]),
    )
    .await;
    assert_eq!(inbox.body["unread_count"], 1, "{}", inbox.body);
    assert_eq!(inbox.body["items"][0]["id"], published.body["id"]);
    let starts = Utc::now() + Duration::hours(1);
    let mut future = announcement("customers");
    future["audience_rules"] = campaign_rules(None);
    future["starts_at"] = json!(starts);
    let future = admin(&f, "POST", "/publications", future).await;
    assert_eq!(future.status, StatusCode::CREATED, "{}", future.body);
    let other = call(
        &f,
        "GET",
        "/v1/notifications",
        Value::Null,
        None,
        Some(&f.tokens[1]),
    )
    .await;
    assert_eq!(other.body["unread_count"], 0);
    for _ in 0..4 {
        if !api_gateway::engagement::process_one_with_commerce(&target, &pool, None)
            .await
            .unwrap()
        {
            break;
        }
    }
    let due:Option<chrono::DateTime<Utc>>=sqlx::query_scalar("SELECT available_at FROM platform.engagement_jobs WHERE completed_at IS NULL AND payload->>'campaign'=$1 LIMIT 1").bind(future.body["id"].as_str().unwrap()).fetch_optional(&target).await.unwrap();
    assert!(
        due.is_some_and(|due| (due - starts).num_milliseconds().abs() < 1),
        "A recipient seen before the scheduled start gets a durable start-time evaluation"
    );
    let source: i64 =
        sqlx::query_scalar("SELECT count(*) FROM platform.storefront_notification_deliveries")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(source, 0);
    remove_isolated(&pool, target, name, f).await;
}
