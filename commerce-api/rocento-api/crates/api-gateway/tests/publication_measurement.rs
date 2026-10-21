use api_gateway::{
    discoverability::{self, App},
    identity,
    public_commerce::{
        attribution::{self, Evidence},
        health,
        policy::Deployment,
    },
};
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;
const ORIGIN: &str = "https://shop.example.test";
async fn fixture(pool: &PgPool) -> App {
    sqlx::query("UPDATE cms.discoverability_settings SET enabled=true,indexing_enabled=true,canonical_url='https://shop.example.test/'").execute(pool).await.unwrap();
    let id = sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
        .fetch_one(pool)
        .await
        .unwrap();
    let a = App {
        identity: identity::App::new(
            pool.clone(),
            infra_auth::Security::new("measurement-fixture-secret".repeat(3), ORIGIN.into(), false)
                .await
                .unwrap(),
            vec![ORIGIN.into()],
        ),
        deployment: Deployment {
            installation_id: Some(id),
            environment: "production".into(),
            approved_origin: Some(format!("{ORIGIN}/")),
            header_override: false,
            html: Some("built".into()),
        },
    };
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES('00000000-0000-0000-0000-000000000010','operator@example.test','Operator','!',$1)").bind(domain_admin_iam::SUPER).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,'00000000-0000-0000-0000-000000000010',now()+interval '1 hour')").bind(infra_auth::digest(&format!("measurement-admin-{id}"))).execute(pool).await.unwrap();
    a
}
async fn request(
    a: &App,
    method: &str,
    path: &str,
    body: Value,
    bearer: Option<&str>,
    admin: bool,
) -> (u16, Value) {
    let mut r = Request::builder()
        .method(method)
        .uri(path)
        .header("origin", ORIGIN)
        .header("x-commerce-request", "1")
        .header("content-type", "application/json");
    if admin {
        let actual: Uuid =
            sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
                .fetch_one(&a.identity.admins.pool)
                .await
                .unwrap();
        r = r.header(
            "cookie",
            format!("admin_session=measurement-admin-{actual}"),
        );
    }
    if let Some(b) = bearer {
        r = r.header("authorization", format!("Bearer {b}"));
    }
    let r = discoverability::router_with_deployment(a.identity.clone(), a.deployment.clone())
        .oneshot(
            r.body(if method == "GET" {
                Body::empty()
            } else {
                Body::from(body.to_string())
            })
            .unwrap(),
        )
        .await
        .unwrap();
    let status = r.status().as_u16();
    let bytes = r.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
fn event(session: Uuid, evidence: Value) -> Value {
    json!({"id":Uuid::new_v4(),"session_id":session,"path":"/","evidence":evidence})
}
#[test]
fn classifications_precedence_spoofs_and_unknown_providers() {
    let cases = [
        (json!({}), "direct"),
        (
            json!({"referrer":"https://www.google.com/search?q=private"}),
            "organic_search",
        ),
        (
            json!({"referrer":"https://chatgpt.com/c/private","medium":"cpc"}),
            "paid_search",
        ),
        (json!({"medium":"email"}), "email"),
        (json!({"referrer":"https://www.instagram.com/"}), "social"),
        (json!({"referrer":"https://publisher.example/"}), "referral"),
        (json!({"source":"unrecognized"}), "unknown"),
        (json!({"referrer":"https://chatgpt.com/"}), "ai_chatgpt"),
        (json!({"source":"chatgpt.com"}), "ai_chatgpt"),
        (
            json!({"referrer":"https://gemini.google.com/app"}),
            "ai_google",
        ),
        (
            json!({"referrer":"https://www.perplexity.ai/"}),
            "ai_perplexity",
        ),
        (json!({"referrer":"https://claude.ai/"}), "ai_claude"),
        (json!({"source":"new-provider","medium":"ai"}), "ai_other"),
        (json!({"source":"claude.ai"}), "unknown"),
        (
            json!({"referrer":"https://chatgpt.com.attacker.test/"}),
            "referral",
        ),
        (
            json!({"referrer":"https://chatgpt.com@attacker.test/"}),
            "unknown",
        ),
        (json!({"referrer":"javascript:secret"}), "unknown"),
        (
            json!({"referrer":"https://www.google.com/","source":"chatgpt.com"}),
            "organic_search",
        ),
        (
            json!({"referrer":"https://shop.example.test/products/apple"}),
            "direct",
        ),
    ];
    let mut evidence = vec![];
    for (input, expected) in cases {
        let e: Evidence = serde_json::from_value(input.clone()).unwrap();
        let t = attribution::classify(&e, &format!("{ORIGIN}/"), "/");
        assert_eq!(t.channel, expected, "{input}");
        let value = serde_json::to_value(t).unwrap();
        assert!(!value.to_string().contains("q=private"));
        evidence.push(json!({"synthetic_input":input,"expected":expected,"classification":value}));
    }
    if let Ok(dir) = std::env::var("PUBLICATION_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            format!("{dir}/synthetic-classification.json"),
            serde_json::to_string_pretty(&evidence).unwrap(),
        )
        .unwrap();
    }
}
#[sqlx::test(migrations = "../../migrations")]
async fn persistence_first_last_touch_dedup_and_privacy(pool: PgPool) {
    let a = fixture(&pool).await;
    let session = Uuid::new_v4();
    let first = event(
        session,
        json!({"referrer":"https://chatgpt.com/c/PRIVATE?secret=TOKEN","campaign":"spring"}),
    );
    assert_eq!(
        request(
            &a,
            "POST",
            "/v1/discovery/attribution",
            first.clone(),
            None,
            false
        )
        .await
        .0,
        200
    );
    assert_eq!(
        request(&a, "POST", "/v1/discovery/attribution", first, None, false)
            .await
            .0,
        200
    );
    assert_eq!(
        request(
            &a,
            "POST",
            "/v1/discovery/attribution",
            event(session, json!({})),
            None,
            false
        )
        .await
        .0,
        200
    );
    let row: Value = sqlx::query_scalar("SELECT to_jsonb(s) FROM platform.discovery_sessions s")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row["first_touch"]["channel"], "ai_chatgpt");
    assert_eq!(row["last_touch"]["channel"], "ai_chatgpt");
    assert!(!row.to_string().contains("TOKEN"));
    assert!(!row.to_string().contains("PRIVATE"));
    assert_eq!(
        request(
            &a,
            "POST",
            "/v1/discovery/attribution",
            event(
                session,
                json!({"source":"newsletter","medium":"email","campaign":"customer@example.test"})
            ),
            None,
            false
        )
        .await
        .0,
        200
    );
    let row: Value = sqlx::query_scalar("SELECT to_jsonb(s) FROM platform.discovery_sessions s")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row["first_touch"]["channel"], "ai_chatgpt");
    assert_eq!(row["last_touch"]["channel"], "email");
    assert_eq!(row["ai_seen"], true);
    assert_eq!(row["last_touch"]["campaign"], "");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.discovery_events")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 3);
    let mut bad = event(session, json!({}));
    bad["path"] = json!("/account?token=secret");
    assert_eq!(
        request(&a, "POST", "/v1/discovery/attribution", bad, None, false)
            .await
            .0,
        400
    );
    let (status, data) = request(
        &a,
        "GET",
        "/v1/admin/discovery/analytics?days=30",
        Value::Null,
        None,
        true,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(data["channels"][0]["sessions"], 1);
    assert_eq!(data["channels"][0]["channel"], "ai_chatgpt");
    assert_eq!(data["trend"].as_array().unwrap().len(), 1);
    assert_eq!(
        request(
            &a,
            "GET",
            "/v1/admin/discovery/analytics",
            Value::Null,
            None,
            false
        )
        .await
        .0,
        401
    );
    assert_eq!(
        request(
            &a,
            "GET",
            "/v1/admin/discovery/analytics?days=91",
            Value::Null,
            None,
            true
        )
        .await
        .0,
        400
    );
}
async fn customer_token(a: &App) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let sid = Uuid::new_v4();
    let pool = &a.identity.admins.pool;
    sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash,verified) VALUES($1,$2,'email','!',true)").bind(id).bind(format!("{id}@example.test")).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO customers.sessions(id,customer_id,refresh_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(sid).bind(id).bind(sid.to_string()).execute(pool).await.unwrap();
    (
        id,
        a.identity.customers.security.access_token(id, sid).unwrap(),
    )
}
#[sqlx::test(migrations = "../../migrations")]
async fn verified_revenue_linkage_no_double_count_refunds_and_permissions(pool: PgPool) {
    let a = fixture(&pool).await;
    let (customer, token) = customer_token(&a).await;
    let session = Uuid::new_v4();
    request(
        &a,
        "POST",
        "/v1/discovery/attribution",
        event(session, json!({"referrer":"https://perplexity.ai/"})),
        None,
        false,
    )
    .await;
    let order = Uuid::new_v4();
    sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency) VALUES($1,$2,gen_random_uuid(),gen_random_uuid(),'cash_collected','{}','{}',100,5,105,'USD')").bind(order).bind(customer).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO payments.payment_transactions(order_id,method,amount_due,currency,collected_at,collected_by) VALUES($1,'cod',105,'USD',now(),gen_random_uuid())").bind(order).execute(&pool).await.unwrap();
    let input = json!({"id":Uuid::new_v4(),"session_id":session,"path":"/checkout/complete","order_id":order,"evidence":{}});
    assert_eq!(
        request(
            &a,
            "POST",
            "/v1/discovery/attribution",
            input.clone(),
            None,
            false
        )
        .await
        .0,
        401
    );
    let (_, other_token) = customer_token(&a).await;
    assert_eq!(
        request(
            &a,
            "POST",
            "/v1/discovery/attribution",
            input.clone(),
            Some(&other_token),
            false
        )
        .await
        .0,
        404
    );
    for _ in 0..2 {
        assert_eq!(
            request(
                &a,
                "POST",
                "/v1/discovery/attribution",
                input.clone(),
                Some(&token),
                false
            )
            .await
            .0,
            200
        );
    }
    let (_, data) = request(
        &a,
        "GET",
        "/v1/admin/discovery/analytics",
        Value::Null,
        None,
        true,
    )
    .await;
    assert_eq!(data["conversions"][0]["orders"], 1);
    assert_eq!(data["conversions"][0]["channel"], "ai_perplexity");
    assert_eq!(data["conversions"][0]["collected_net_revenue"], "105.00");
    sqlx::query("INSERT INTO payments.manual_refunds(id,order_id,amount,reason,actor_id) VALUES(gen_random_uuid(),$1,25,'Synthetic fixture',gen_random_uuid())").bind(order).execute(&pool).await.unwrap();
    let (_, data) = request(
        &a,
        "GET",
        "/v1/admin/discovery/analytics",
        Value::Null,
        None,
        true,
    )
    .await;
    assert_eq!(data["conversions"][0]["collected_net_revenue"], "80.00");
    let role = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'Discovery only',ARRAY['discovery.read'])").bind(role).execute(&pool).await.unwrap();
    sqlx::query("UPDATE admin_iam.admin_users SET role_id=$1")
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    let (_, data) = request(
        &a,
        "GET",
        "/v1/admin/discovery/analytics",
        Value::Null,
        None,
        true,
    )
    .await;
    assert!(data["conversions"].is_null());
    assert_eq!(data["revenue_authorized"], false);
    if let Ok(dir) = std::env::var("PUBLICATION_EVIDENCE_DIR") {
        std::fs::write(
            format!("{dir}/revenue-redacted.json"),
            serde_json::to_string_pretty(&data).unwrap(),
        )
        .unwrap();
    }
}
#[sqlx::test(migrations = "../../migrations")]
async fn health_policy_feeds_loops_missing_probe_and_recovery(pool: PgPool) {
    let a = fixture(&pool).await;
    let healthy = health::assess(&a, None, None).await.unwrap();
    assert!(healthy["findings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["code"] == "renderer_probe" && v["severity"] == "Warning"));
    sqlx::query("INSERT INTO platform.publication_routes(path,status,target,reason) VALUES('/products/a',301,'/products/b','fixture'),('/products/b',301,'/products/a','fixture')").execute(&pool).await.unwrap();
    sqlx::query("UPDATE platform.publication_freshness SET last_error='publication_batch_failed'")
        .execute(&pool)
        .await
        .unwrap();
    let failed = health::assess(&a, None, None).await.unwrap();
    assert!(failed["findings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["code"] == "feed_freshness" && v["severity"] == "Warning"));
    assert!(failed["findings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["code"] == "redirect_target" && v["severity"] == "Error"));
    sqlx::query("DELETE FROM platform.publication_routes")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE platform.publication_freshness SET last_error=NULL,completed_generation=generation",
    )
    .execute(&pool)
    .await
    .unwrap();
    let recovered = health::assess(&a, None, None).await.unwrap();
    assert!(!recovered["findings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["severity"] == "Error"));
    let mut staging = a.clone();
    staging.deployment.environment = "staging".into();
    let protected = health::assess(&staging, None, None).await.unwrap();
    assert!(protected["findings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["code"] == "effective_indexing" && v["severity"] == "Healthy"));
    if let Ok(dir) = std::env::var("PUBLICATION_EVIDENCE_DIR") {
        for (label, v) in [("failed", failed), ("recovered", recovered)] {
            std::fs::write(
                format!("{dir}/health-{label}.json"),
                serde_json::to_string_pretty(&v).unwrap(),
            )
            .unwrap();
        }
    }
}
#[sqlx::test(migrations = "../../migrations")]
async fn retention_binding_and_cross_installation_sessions(pool: PgPool) {
    let a = fixture(&pool).await;
    let session = Uuid::new_v4();
    request(
        &a,
        "POST",
        "/v1/discovery/attribution",
        event(session, json!({})),
        None,
        false,
    )
    .await;
    sqlx::query("UPDATE platform.discovery_sessions SET created_at=now()-interval '91 days'")
        .execute(&pool)
        .await
        .unwrap();
    attribution::purge(&pool).await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.discovery_events")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    let mut wrong = a.clone();
    wrong.deployment.installation_id = Some(Uuid::new_v4());
    assert_eq!(
        request(
            &wrong,
            "GET",
            "/v1/admin/discovery/analytics",
            Value::Null,
            None,
            true
        )
        .await
        .0,
        403
    );
    assert_eq!(
        request(
            &wrong,
            "POST",
            "/v1/discovery/attribution",
            event(session, json!({})),
            None,
            false
        )
        .await
        .0,
        403
    );
    let name = format!("measure_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&pool)
        .await
        .unwrap();
    let other = sqlx::postgres::PgPoolOptions::new()
        .connect_with(pool.connect_options().as_ref().clone().database(&name))
        .await
        .unwrap();
    sqlx::migrate!("../../migrations")
        .run(&other)
        .await
        .unwrap();
    let mut b = fixture(&other).await;
    let bad_request = Request::builder()
        .uri("/v1/admin/discovery/analytics")
        .header(
            "cookie",
            format!(
                "admin_session=measurement-admin-{}",
                a.deployment.installation_id.unwrap()
            ),
        )
        .body(Body::empty())
        .unwrap();
    let response =
        discoverability::router_with_deployment(b.identity.clone(), b.deployment.clone())
            .oneshot(bad_request)
            .await
            .unwrap();
    assert_eq!(response.status(), 401);

    b.deployment.approved_origin = Some("https://other.example.test/".into());
    assert_eq!(
        request(
            &b,
            "POST",
            "/v1/discovery/attribution",
            event(session, json!({"referrer":"https://chatgpt.com/"})),
            None,
            false
        )
        .await
        .0,
        403
    );
    let (_, data) = request(
        &b,
        "GET",
        "/v1/admin/discovery/analytics",
        Value::Null,
        None,
        true,
    )
    .await;
    assert!(data["channels"].as_array().unwrap().is_empty());
    other.close().await;
    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .execute(&pool)
        .await
        .unwrap();
}
