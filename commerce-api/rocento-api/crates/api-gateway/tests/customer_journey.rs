mod support;
use api_gateway::{analytics::Event, customer_journey::record_browser, identity::App};
use axum::{
    body::Body,
    http::{HeaderMap, Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

struct Fixture {
    app: App,
    customers: [Uuid; 2],
    tokens: [String; 2],
    locations: [Uuid; 2],
    admin: Uuid,
    product: domain_catalog::Product,
}
async fn setup(pool: PgPool) -> Fixture {
    let security = infra_auth::Security::new(
        "journey-test-secret-at-least-32-characters".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let app = App::new(
        pool.clone(),
        security.clone(),
        vec!["http://localhost:5173".into()],
    );
    let customers = [Uuid::new_v4(), Uuid::new_v4()];
    let mut tokens = [String::new(), String::new()];
    let mut locations = [Uuid::nil(), Uuid::nil()];
    for (i, customer) in customers.iter().enumerate() {
        sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash,verified,first_name) VALUES($1,$2,'email','unused',true,$3)").bind(customer).bind(format!("journey-{i}@example.test")).bind(format!("Customer {i}")).execute(&pool).await.unwrap();
        let session = Uuid::new_v4();
        sqlx::query("INSERT INTO customers.sessions(id,customer_id,refresh_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(session).bind(customer).bind(format!("journey-{i}")).execute(&pool).await.unwrap();
        tokens[i] = security.access_token(*customer, session).unwrap();
        locations[i] = app.customers.save_location(*customer, None, serde_json::from_value(json!({"label":"home","latitude":30,"longitude":31,"formatted_address":format!("Private address {i}")})).unwrap()).await.unwrap().id;
    }
    let admin = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'journey-admin@example.test','Journey admin','unused',$2)").bind(admin).bind(domain_admin_iam::SUPER).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest("journey-admin")).bind(admin).execute(&pool).await.unwrap();
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            serde_json::from_value(json!({"name":"Fruit","slug":"fruit","parent_id":null}))
                .unwrap(),
        )
        .await
        .unwrap();
    let product = catalog.save_product(None, serde_json::from_value(json!({"sku":"JOURNEY-APPLE","slug":"journey-apple","name":"Journey apples","description":"Synthetic product","price":"3.00","currency":"USD","unit":"kg","category_id":category.id,"attributes":{},"media_ids":[],"active":true,"in_stock":true})).unwrap()).await.unwrap();
    app.cart
        .inventory
        .adjust(product.id, 100, admin, "Journey test stock".into())
        .await
        .unwrap();
    Fixture {
        app,
        customers,
        tokens,
        locations,
        admin,
        product,
    }
}
fn headers(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
    headers
}
fn event(session: Uuid, kind: &str, path: &str) -> Event {
    serde_json::from_value(json!({"id":Uuid::new_v4(),"session_id":session,"event_type":kind,"path":path,"query":if kind=="search_query" {Some("apples")} else {None},"result_count":if kind=="search_query" {Some(0)} else {None},"source":"direct"})).unwrap()
}
async fn get(f: &Fixture, customer: Uuid, query: &str, authenticated: bool) -> (StatusCode, Value) {
    let mut request =
        Request::builder().uri(format!("/v1/admin/customers/{customer}/journey{query}"));
    if authenticated {
        request = request.header("cookie", "admin_session=journey-admin");
    }
    let response = api_gateway::attributes::router(f.app.clone())
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn order(f: &Fixture, i: usize) -> Uuid {
    f.app.cart.open(Some(f.customers[i]), "").await.unwrap();
    f.app
        .cart
        .set(Some(f.customers[i]), "", f.product.clone(), 2, true)
        .await
        .unwrap();
    let quote = f
        .app
        .cart
        .quote(f.customers[i], f.locations[i])
        .await
        .unwrap();
    f.app
        .cart
        .place(f.customers[i], quote.id, Uuid::new_v4())
        .await
        .unwrap()
        .order
        .id
}
async fn role(f: &Fixture, permissions: Vec<&str>) {
    let role = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,$2,$3)")
        .bind(role)
        .bind(role.to_string())
        .bind(permissions)
        .execute(&f.app.customers.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE admin_iam.admin_users SET role_id=$1 WHERE id=$2")
        .bind(role)
        .bind(f.admin)
        .execute(&f.app.customers.pool)
        .await
        .unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn journey_uses_real_records_scoped_to_customer_and_excludes_private_snapshots(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let session = Uuid::new_v4();
    let view = event(session, "page_view", &format!("/products/{}", f.product.id));
    record_browser(&f.app, &headers(&f.tokens[0]), &view)
        .await
        .unwrap();
    record_browser(&f.app, &headers(&f.tokens[0]), &view)
        .await
        .unwrap(); // Retry is deduplicated.
    record_browser(
        &f.app,
        &headers(&f.tokens[0]),
        &event(session, "search_query", "/search"),
    )
    .await
    .unwrap();
    record_browser(
        &f.app,
        &headers(&f.tokens[1]),
        &event(session, "page_view", "/"),
    )
    .await
    .unwrap(); // Shared browser/session does not join accounts.
    let first = order(&f, 0).await;
    let other = order(&f, 1).await;
    sqlx::query("INSERT INTO orders.order_status_history(id,order_id,status,reason) VALUES($1,$2,'confirmed','Private staff note')").bind(Uuid::new_v4()).bind(first).execute(&pool).await.unwrap();
    let (status, body) = get(&f, f.customers[0], "", true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["customer"]["id"], f.customers[0].to_string());
    assert_eq!(body["customer"]["name"], "Customer 0");
    let events = body["events"].as_array().unwrap();
    for kind in [
        "product_view",
        "search",
        "cart.item_added",
        "checkout",
        "purchase",
        "order_status",
    ] {
        assert!(events.iter().any(|e| e["kind"] == kind), "missing {kind}");
    }
    assert_eq!(
        events
            .iter()
            .filter(|e| e["kind"] == "product_view")
            .count(),
        1
    );
    let purchase = events.iter().find(|e| e["kind"] == "purchase").unwrap();
    assert_eq!(purchase["details"]["order_id"], first.to_string());
    assert_eq!(purchase["details"]["payment_method"], "cod");
    assert!(!body.to_string().contains(&other.to_string()));
    for private in [
        "Private address",
        "Private staff note",
        "password",
        "refresh_hash",
        "Private address 1",
        "Visa",
    ] {
        assert!(!body.to_string().contains(private));
    }
    let contract: Value = serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &body,
        &contract["components"]["schemas"]["CustomerJourney"],
        &contract,
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn journey_enforces_permissions_unknown_customer_and_date_validation(pool: PgPool) {
    let f = setup(pool).await;
    order(&f, 0).await;
    assert_eq!(
        get(&f, f.customers[0], "", false).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        get(&f, Uuid::new_v4(), "", true).await.0,
        StatusCode::NOT_FOUND
    );
    for query in [
        "?from=2026-01-01&to=2026-05-01",
        "?from=2026-09-20&to=2026-09-01",
        "?limit=101",
        "?before_id=only-one-half",
    ] {
        assert_eq!(
            get(&f, f.customers[0], query, true).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    role(&f, vec!["customers.read"]).await;
    let (status, body) = get(&f, f.customers[0], "", true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["includes_orders"], false);
    assert!(body["events"].as_array().unwrap().iter().all(|e| ![
        "purchase",
        "checkout",
        "order_status"
    ]
    .contains(&e["kind"].as_str().unwrap())));
    assert!(!body.to_string().contains("order_number"));
    role(&f, vec!["orders.read"]).await;
    assert_eq!(
        get(&f, f.customers[0], "", true).await.0,
        StatusCode::FORBIDDEN
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn journey_cursor_handles_equal_timestamps_date_boundaries_and_empty_activity(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let session = Uuid::new_v4();
    for _ in 0..5 {
        record_browser(
            &f.app,
            &headers(&f.tokens[0]),
            &event(session, "page_view", "/"),
        )
        .await
        .unwrap();
    }
    sqlx::query("UPDATE customers.journey_events SET occurred_at='2026-09-20T23:59:59Z'")
        .execute(&pool)
        .await
        .unwrap();
    record_browser(
        &f.app,
        &headers(&f.tokens[0]),
        &event(session, "page_view", "/search"),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE customers.journey_events SET occurred_at='2026-09-21T00:00:00Z' WHERE path='/search'").execute(&pool).await.unwrap();
    let base = "?from=2026-09-20&to=2026-09-20&limit=2";
    let mut cursor = String::new();
    let mut ids = std::collections::HashSet::new();
    loop {
        let (status, body) = get(&f, f.customers[0], &format!("{base}{cursor}"), true).await;
        assert_eq!(status, StatusCode::OK);
        for event in body["events"].as_array().unwrap() {
            assert!(ids.insert(event["id"].as_str().unwrap().to_string()));
        }
        if body["next_cursor"].is_null() {
            break;
        }
        cursor = format!(
            "&before={}&before_id={}",
            body["next_cursor"]["before"]
                .as_str()
                .unwrap()
                .replace('+', "%2B"),
            body["next_cursor"]["before_id"].as_str().unwrap()
        );
    }
    assert_eq!(ids.len(), 5);
    let (_, empty) = get(&f, f.customers[1], base, true).await;
    assert!(empty["events"].as_array().unwrap().is_empty());
    assert!(empty["next_cursor"].is_null());
}

#[sqlx::test(migrations = "../../migrations")]
async fn browser_attribution_rejects_forgery_and_revocation_without_linking_anonymous_events(
    pool: PgPool,
) {
    let f = setup(pool.clone()).await;
    let e = event(Uuid::new_v4(), "page_view", "/");
    record_browser(&f.app, &HeaderMap::new(), &e).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM customers.journey_events")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let mut forged = json!({"id":Uuid::new_v4(),"session_id":Uuid::new_v4(),"event_type":"page_view","path":"/","customer_id":f.customers[1]});
    assert!(serde_json::from_value::<Event>(forged.clone()).is_err());
    forged.as_object_mut().unwrap().remove("customer_id");
    forged["occurred_at"] = json!("2020-01-01T00:00:00Z");
    assert!(serde_json::from_value::<Event>(forged).is_err());
    assert!(record_browser(
        &f.app,
        &headers(&f.tokens[0]),
        &event(Uuid::new_v4(), "page_view", "/reset-password?token=secret")
    )
    .await
    .is_err());
    record_browser(
        &f.app,
        &headers(&f.tokens[0]),
        &event(Uuid::new_v4(), "order_placed", "/checkout/complete"),
    )
    .await
    .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM customers.journey_events")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "Browser purchase claims cannot become commerce events"
    );
    sqlx::query("DELETE FROM customers.sessions WHERE customer_id=$1")
        .bind(f.customers[0])
        .execute(&pool)
        .await
        .unwrap();
    assert!(record_browser(&f.app, &headers(&f.tokens[0]), &e)
        .await
        .is_err());
}

/// Opt-in browser acceptance uses the real HTTP routers and PostgreSQL records above.
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "requires JOURNEY_PREVIEW_URL pointing to a built admin preview and installed Playwright"]
async fn customer_profile_opens_real_customer_journey_in_browser(pool: PgPool) {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let f = setup(pool).await;
    let session = Uuid::new_v4();
    for (kind, path) in [
        ("page_view", "/".to_string()),
        (
            "page_view",
            format!("/categories/{}", f.product.category_id),
        ),
        ("search_query", "/search".to_string()),
        ("page_view", format!("/products/{}", f.product.id)),
    ] {
        record_browser(&f.app, &headers(&f.tokens[0]), &event(session, kind, &path))
            .await
            .unwrap();
    }
    let order_id = order(&f, 0).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend = format!("http://{}", listener.local_addr().unwrap());
    let router = api_gateway::identity::router(f.app.clone())
        .merge(api_gateway::attributes::router(f.app.clone()))
        .merge(api_gateway::orders::router(f.app.clone()));
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../commerce-web/e2e/customer-journey/live-check.mjs");
    let mut child = tokio::process::Command::new("node")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let fixture = json!({"backend":backend,"origin":std::env::var("JOURNEY_PREVIEW_URL").expect("Set JOURNEY_PREVIEW_URL"),"customers":f.customers,"order_id":order_id});
    child
        .stdin
        .take()
        .unwrap()
        .write_all(fixture.to_string().as_bytes())
        .await
        .unwrap();
    let result = child.wait_with_output().await.unwrap();
    server.abort();
    println!("{}", String::from_utf8_lossy(&result.stdout));
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
