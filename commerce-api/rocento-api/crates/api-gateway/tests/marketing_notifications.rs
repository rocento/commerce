use api_gateway::{identity, marketing_notifications};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use infra_auth::Security;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

async fn setup(pool: &PgPool, permissions: Vec<&str>) -> (Router, Uuid, [Uuid; 2]) {
    static SECURITY: tokio::sync::OnceCell<Security> = tokio::sync::OnceCell::const_new();
    let security = SECURITY
        .get_or_init(|| async {
            Security::new(
                "notification-test-secret-".repeat(3),
                "https://store.example.test".into(),
                false,
            )
            .await
            .unwrap()
        })
        .await
        .clone();
    let role = Uuid::new_v4();
    let actor = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'Notification operators',$2)",
    )
    .bind(role)
    .bind(permissions)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'notifications@example.test','Notification operator','!',$2)").bind(actor).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest("notifications-session")).bind(actor).execute(pool).await.unwrap();
    let customers = [Uuid::new_v4(), Uuid::new_v4()];
    for (i, id) in customers.iter().enumerate() {
        sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash,first_name,last_name) VALUES($1,$2,'email','!',$3,'Customer')")
            .bind(id).bind(format!("customer-{i}@example.test")).bind(if i==0 {"First"} else {"Second"}).execute(pool).await.unwrap();
    }
    (
        marketing_notifications::router(identity::App::new(
            pool.clone(),
            security,
            vec!["https://admin.example.test".into()],
        )),
        role,
        customers,
    )
}
async fn call(app: &Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(format!("/v1/admin/marketing/notifications{path}"))
                .header("cookie", "admin_session=notifications-session")
                .header("content-type", "application/json")
                .header("x-commerce-request", "1")
                .body(if method == "GET" {
                    Body::empty()
                } else {
                    Body::from(body.to_string())
                })
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    assert_eq!(response.headers()["cache-control"], "no-store");
    (
        status,
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap(),
    )
}
fn config() -> Value {
    json!({"name":"Welcome back","description":"A journey-aware welcome","channel":"email","trigger_kind":"visit","title_template":"Hello {{customer.first_name}}","body_template":"Welcome back, {{customer.name}}. Event: {{event.kind}}.","status":"active","delay_minutes":0,"lookback_days":30,"cooldown_hours":24,"suppress_after_purchase":true})
}
async fn visit(pool: &PgPool, customer: Uuid, minutes_ago: i64) -> String {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.journey_events(customer_id,id,session_id,event_type,path,source,occurred_at) VALUES($1,$2,$3,'page_view','/','test',clock_timestamp()-make_interval(mins=>$4::int))")
        .bind(customer).bind(id).bind(Uuid::new_v4()).bind(minutes_ago as i32).execute(pool).await.unwrap();
    format!("browser:{id}")
}
async fn create(app: &Router, program: Value) -> Value {
    let (status, value) = call(app, "POST", "", program).await;
    assert_eq!(status, StatusCode::CREATED, "{value}");
    value
}
async fn purchase(pool: &PgPool, customer: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency) VALUES($1,$2,$3,$4,'placed','{}','{}',10,0,10,'USD')")
        .bind(id).bind(customer).bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(pool).await.unwrap();
    id
}

fn condition(field: &str, operator: &str, value: &str) -> Value {
    json!({"field":field,"operator":operator,"value":value})
}
async fn conditions_preview(app: &Router, customer: Uuid, program: Value) -> Value {
    let saved = create(app, program.clone()).await;
    let (status, preview) = call(
        app,
        "POST",
        "/preview",
        json!({"program":program,"program_id":saved["id"],"customer_id":customer}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    preview
}

#[sqlx::test(migrations = "../../migrations")]
async fn generates_customer_scoped_content_without_enqueuing_delivery_and_replays_idempotently(
    pool: PgPool,
) {
    let (app, _, customers) = setup(&pool, vec!["*"]).await;
    let source = visit(&pool, customers[0], 5).await;
    visit(&pool, customers[1], 1).await;
    let p = create(&app, config()).await;
    let id = p["id"].as_str().unwrap();
    let (status, preview) = call(
        &app,
        "POST",
        "/preview",
        json!({"program":config(),"program_id":id,"customer_id":customers[0]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["title"], "Hello First");
    assert_eq!(preview["event_id"], source);
    assert_eq!(preview["eligible"], true);
    assert!(!preview.to_string().contains("Second"));
    assert!(!preview.to_string().contains("example.test"));
    let mut edited = config();
    edited["title_template"] = json!("An unsaved title");
    let (_, unsaved_changes) = call(
        &app,
        "POST",
        "/preview",
        json!({"program":edited,"program_id":id,"customer_id":customers[0]}),
    )
    .await;
    assert_eq!(unsaved_changes["title"], "An unsaved title");
    assert_eq!(unsaved_changes["eligible"], false);
    assert!(unsaved_changes["reasons"]
        .to_string()
        .contains("Save these program changes"));
    let request = json!({"customer_id":customers[0],"version":1,"idempotency_key":Uuid::new_v4()});
    let (status, result) = call(&app, "POST", &format!("/{id}/generate"), request.clone()).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["outcome"], "generated");
    assert_eq!(result["record"]["status"], "generated");
    assert_eq!(result["record"]["event_id"], source);
    let (_, retry) = call(&app, "POST", &format!("/{id}/generate"), request.clone()).await;
    assert_eq!(retry["outcome"], "duplicate");
    assert_eq!(retry["record"]["id"], result["record"]["id"]);
    let (_, duplicate) = call(
        &app,
        "POST",
        &format!("/{id}/generate"),
        json!({"customer_id":customers[0],"version":1,"idempotency_key":Uuid::new_v4()}),
    )
    .await;
    assert_eq!(duplicate["outcome"], "duplicate");
    let mut wrong = request.clone();
    wrong["customer_id"] = json!(customers[1]);
    assert_eq!(
        call(&app, "POST", &format!("/{id}/generate"), wrong)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let (_, records) = call(
        &app,
        "GET",
        &format!("/records?program_id={id}"),
        Value::Null,
    )
    .await;
    assert_eq!(records["total"], 1);
    let (_, audit) = call(&app, "GET", &format!("/{id}/audit"), Value::Null).await;
    assert!(audit["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["action"] == "notifications.generated"));
    let outbox: Vec<String> = sqlx::query_scalar("SELECT event_type FROM platform.outbox")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(outbox.iter().any(|kind| kind == "notifications.generated"));
    let delivery_jobs: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.notification_jobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        delivery_jobs, 0,
        "Marketing generation must never create a delivery job"
    );
    let mut changed = config();
    changed["version"] = json!(1);
    changed["title_template"] = json!("New template revision");
    assert_eq!(
        call(&app, "PUT", &format!("/{id}"), changed).await.0,
        StatusCode::OK
    );
    let (_, replay_after_edit) = call(&app, "POST", &format!("/{id}/generate"), request).await;
    assert_eq!(replay_after_edit["record"]["title"], "Hello First");
    assert_eq!(replay_after_edit["record"]["program_version"], 1);
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/{id}/generate"),
            json!({"customer_id":customers[0],"version":1,"idempotency_key":Uuid::new_v4()})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_generation_deduplicates_and_enforces_per_customer_cooldown(pool: PgPool) {
    let (app, _, customers) = setup(&pool, vec!["*"]).await;
    visit(&pool, customers[0], 10).await;
    let p = create(&app, config()).await;
    let id = p["id"].as_str().unwrap();
    let path = format!("/{id}/generate");
    let (a, b) = tokio::join!(
        call(
            &app,
            "POST",
            &path,
            json!({"customer_id":customers[0],"version":1,"idempotency_key":Uuid::new_v4()})
        ),
        call(
            &app,
            "POST",
            &path,
            json!({"customer_id":customers[0],"version":1,"idempotency_key":Uuid::new_v4()})
        )
    );
    assert_eq!(a.0, StatusCode::OK, "{}", a.1);
    assert_eq!(b.0, StatusCode::OK, "{}", b.1);
    let outcomes = [
        a.1["outcome"].as_str().unwrap(),
        b.1["outcome"].as_str().unwrap(),
    ];
    assert!(outcomes.contains(&"generated") && outcomes.contains(&"duplicate"));
    visit(&pool, customers[0], 1).await;
    let request = json!({"customer_id":customers[0],"version":1,"idempotency_key":Uuid::new_v4()});
    let (_, result) = call(&app, "POST", &path, request.clone()).await;
    assert_eq!(result["outcome"], "suppressed");
    assert!(result["reason"].as_str().unwrap().contains("cooldown"));
    sqlx::query(
        "UPDATE platform.marketing_notification_records SET created_at=now()-interval '2 days'",
    )
    .execute(&pool)
    .await
    .unwrap();
    let (_, retry) = call(&app, "POST", &path, request).await;
    assert_eq!(retry["outcome"], "suppressed");
    assert_eq!(retry["reason"], result["reason"]);
    visit(&pool, customers[1], 1).await;
    let (_, other) = call(
        &app,
        "POST",
        &path,
        json!({"customer_id":customers[1],"version":1,"idempotency_key":Uuid::new_v4()}),
    )
    .await;
    assert_eq!(other["outcome"], "generated");
}

#[sqlx::test(migrations = "../../migrations")]
async fn eligibility_uses_journey_facts_missing_values_delay_and_purchase_suppression(
    pool: PgPool,
) {
    let (app, _, customers) = setup(&pool, vec!["*"]).await;
    let mut p = config();
    p["delay_minutes"] = json!(60);
    p["body_template"] = json!("Your product is {{product.name}}");
    let saved = create(&app, p.clone()).await;
    let id = saved["id"].as_str().unwrap();
    let (_, none) = call(
        &app,
        "POST",
        "/preview",
        json!({"program":p,"program_id":id,"customer_id":customers[0]}),
    )
    .await;
    assert_eq!(none["event_id"], Value::Null);
    assert_eq!(none["eligible"], false);
    visit(&pool, customers[0], 5).await;
    purchase(&pool, customers[0]).await;
    let (_, preview) = call(
        &app,
        "POST",
        "/preview",
        json!({"program":p,"program_id":id,"customer_id":customers[0]}),
    )
    .await;
    let reasons = preview["reasons"].to_string();
    assert!(reasons.contains("delay"));
    assert!(reasons.contains("purchase"));
    assert!(reasons.contains("missing"));
    assert_eq!(preview["missing_tokens"], json!(["product.name"]));
    let (_, result) = call(
        &app,
        "POST",
        &format!("/{id}/generate"),
        json!({"customer_id":customers[0],"version":1,"idempotency_key":Uuid::new_v4()}),
    )
    .await;
    assert_eq!(result["outcome"], "suppressed");
    assert_eq!(result["record"], Value::Null);
    let (_, unsaved) = call(
        &app,
        "POST",
        "/preview",
        json!({"program":config(),"customer_id":customers[1]}),
    )
    .await;
    assert_eq!(unsaved["eligible"], false);
    assert!(unsaved["reasons"].to_string().contains("Save this program"));
    p["status"] = json!("draft");
    let (_, draft) = call(
        &app,
        "POST",
        "/preview",
        json!({"program":p,"program_id":id,"customer_id":customers[0]}),
    )
    .await;
    assert!(draft["reasons"].to_string().contains("draft"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn lifecycle_versions_validation_and_bounded_queries_are_enforced(pool: PgPool) {
    let (app, _, _) = setup(&pool, vec!["*"]).await;
    let p = create(&app, config()).await;
    let id = p["id"].as_str().unwrap();
    let mut change = config();
    change["version"] = json!(1);
    change["status"] = json!("paused");
    let (status, saved) = call(&app, "PUT", &format!("/{id}"), change.clone()).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["version"], 2);
    assert_eq!(
        call(&app, "PUT", &format!("/{id}"), change.clone()).await.0,
        StatusCode::CONFLICT
    );
    change["version"] = json!(2);
    change["status"] = json!("archived");
    assert_eq!(
        call(&app, "PUT", &format!("/{id}"), change.clone()).await.0,
        StatusCode::OK
    );
    change["version"] = json!(3);
    change["status"] = json!("active");
    assert_eq!(
        call(&app, "PUT", &format!("/{id}"), change).await.0,
        StatusCode::BAD_REQUEST
    );
    let (_, list) = call(
        &app,
        "GET",
        "?status=archived&search=Welcome&limit=1",
        Value::Null,
    )
    .await;
    assert_eq!(list["total"], 1);
    assert_eq!(list["programs"].as_array().unwrap().len(), 1);
    for suffix in [
        "?limit=101",
        "?offset=-1",
        "?status=deleted",
        "/records?limit=0",
    ] {
        assert_eq!(
            call(&app, "GET", suffix, Value::Null).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    for (field, value) in [
        ("lookback_days", json!(91)),
        ("delay_minutes", json!(43200)),
        ("title_template", json!("{{customer.email}}")),
        ("delivery_enabled", json!(true)),
    ] {
        let mut p = config();
        p[field] = value;
        assert_eq!(
            call(&app, "POST", "", p).await.0,
            StatusCode::BAD_REQUEST,
            "{field}"
        );
    }
    let (_, metadata) = call(&app, "GET", "/metadata", Value::Null).await;
    assert_eq!(metadata["delivery_mode"], "generation_only");
    assert!(metadata["channels"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["delivery_enabled"] == false));
}

#[sqlx::test(migrations = "../../migrations")]
async fn permissions_and_csrf_protect_content_and_customer_journey(pool: PgPool) {
    let (app, role, customers) = setup(&pool, vec!["*"]).await;
    let p = create(&app, config()).await;
    let id = p["id"].as_str().unwrap();
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['notifications.read','notifications.write','notifications.generate','customers.read'] WHERE id=$1").bind(role).execute(&pool).await.unwrap();
    assert_eq!(call(&app, "GET", "", Value::Null).await.0, StatusCode::OK);
    assert_eq!(
        call(&app, "GET", "/records", Value::Null).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/preview",
            json!({"program":config(),"customer_id":customers[0]})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/{id}/generate"),
            json!({"customer_id":customers[0],"version":1,"idempotency_key":Uuid::new_v4()})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['notifications.read','customers.read','orders.read'] WHERE id=$1").bind(role).execute(&pool).await.unwrap();
    assert_eq!(
        call(&app, "POST", "", config()).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/{id}/generate"),
            json!({"customer_id":customers[0],"version":1,"idempotency_key":Uuid::new_v4()})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/admin/marketing/notifications")
                .header("cookie", "admin_session=notifications-session")
                .header("content-type", "application/json")
                .body(Body::from(config().to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/admin/marketing/notifications")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[sqlx::test(migrations = "../../migrations")]
async fn matching_event_is_not_limited_to_first_page_and_order_tokens_use_real_records(
    pool: PgPool,
) {
    let (app, _, customers) = setup(&pool, vec!["*"]).await;
    let matching = visit(&pool, customers[0], 20).await;
    sqlx::query("INSERT INTO customers.journey_events(customer_id,id,session_id,event_type,path,source,query,occurred_at) SELECT $1,gen_random_uuid(),gen_random_uuid(),'search_query','/search','test','Example',clock_timestamp()-interval '1 minute' FROM generate_series(1,120)")
        .bind(customers[0]).execute(&pool).await.unwrap();
    let p = create(&app, config()).await;
    let (_, preview) = call(
        &app,
        "POST",
        "/preview",
        json!({"program":config(),"program_id":p["id"],"customer_id":customers[0]}),
    )
    .await;
    assert_eq!(preview["eligible"], true);
    assert_eq!(preview["event_id"], matching);
    let order = purchase(&pool, customers[0]).await;
    let number: i64 = sqlx::query_scalar("SELECT number FROM orders.orders WHERE id=$1")
        .bind(order)
        .fetch_one(&pool)
        .await
        .unwrap();
    purchase(&pool, customers[1]).await;
    visit(&pool, customers[0], 0).await;
    let mut purchase_program = config();
    purchase_program["trigger_kind"] = json!("purchase");
    purchase_program["body_template"] =
        json!("Order {{order.number}}: {{order.total}} {{order.currency}}");
    let p = create(&app, purchase_program.clone()).await;
    let (_, preview) = call(
        &app,
        "POST",
        "/preview",
        json!({"program":purchase_program,"program_id":p["id"],"customer_id":customers[0]}),
    )
    .await;
    assert_eq!(preview["eligible"], true, "{preview}");
    assert_eq!(preview["event_id"], format!("order:{order}"));
    assert_eq!(preview["body"], format!("Order {number}: 10.00 USD"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn legacy_programs_default_to_all_without_rules_and_metadata_describes_real_fields(
    pool: PgPool,
) {
    let (app, _, customers) = setup(&pool, vec!["*"]).await;
    visit(&pool, customers[0], 1).await;
    let p = create(&app, config()).await;
    sqlx::query("UPDATE platform.marketing_notification_programs SET config=config-'conditions' WHERE id=$1")
        .bind(Uuid::parse_str(p["id"].as_str().unwrap()).unwrap()).execute(&pool).await.unwrap();
    let (_, saved) = call(
        &app,
        "GET",
        &format!("/{}", p["id"].as_str().unwrap()),
        Value::Null,
    )
    .await;
    assert_eq!(saved["conditions"], json!({"match":"all","rules":[]}));
    let (_, preview) = call(
        &app,
        "POST",
        "/preview",
        json!({"program":config(),"program_id":p["id"],"customer_id":customers[0]}),
    )
    .await;
    assert_eq!(preview["eligible"], true);
    assert_eq!(preview["conditions_matched"], true);
    assert_eq!(preview["condition_results"], json!([]));
    let (_, metadata) = call(&app, "GET", "/metadata", Value::Null).await;
    let fields = metadata["condition_fields"].as_array().unwrap();
    assert_eq!(fields.len(), 7);
    let status = fields
        .iter()
        .find(|field| field["key"] == "order.status")
        .unwrap();
    assert!(status["options"]
        .as_array()
        .unwrap()
        .iter()
        .any(|option| option["value"] == "pickup_ready"));
    assert!(!status["options"]
        .as_array()
        .unwrap()
        .iter()
        .any(|option| option["value"] == "placed"));
    let total = fields
        .iter()
        .find(|field| field["key"] == "order.total")
        .unwrap();
    assert_eq!(total["type"], "money");
    assert_eq!(total["triggers"], json!(["checkout", "purchase"]));
}

#[sqlx::test(migrations = "../../migrations")]
async fn customer_conditions_use_all_or_any_and_generation_rechecks_current_facts(pool: PgPool) {
    let (app, _, customers) = setup(&pool, vec!["*"]).await;
    visit(&pool, customers[0], 1).await;
    sqlx::query("UPDATE customers.customers SET verified=true,created_at=clock_timestamp()-interval '10 days 5 hours' WHERE id=$1").bind(customers[0]).execute(&pool).await.unwrap();
    let cancelled = purchase(&pool, customers[0]).await;
    sqlx::query("UPDATE orders.orders SET status='cancelled',status_code='cancelled' WHERE id=$1")
        .bind(cancelled)
        .execute(&pool)
        .await
        .unwrap();
    purchase(&pool, customers[1]).await;
    purchase(&pool, customers[1]).await;
    let mut p = config();
    p["suppress_after_purchase"] = json!(false);
    p["conditions"] = json!({"match":"all","rules":[condition("customer.verified","eq","true"),condition("customer.order_count","eq","1"),condition("customer.account_age_days","eq","10")]});
    let saved = create(&app, p.clone()).await;
    let (_, preview) = call(
        &app,
        "POST",
        "/preview",
        json!({"program":p,"program_id":saved["id"],"customer_id":customers[0]}),
    )
    .await;
    assert_eq!(preview["eligible"], true, "{preview}");
    assert_eq!(preview["condition_match"], "all");
    assert_eq!(preview["condition_results"][1]["actual"], "1");
    assert_eq!(preview["condition_results"][2]["actual"], "10");
    assert!(preview["condition_results"]
        .as_array()
        .unwrap()
        .iter()
        .all(|rule| rule["matched"] == true));
    sqlx::query("UPDATE customers.customers SET verified=false WHERE id=$1")
        .bind(customers[0])
        .execute(&pool)
        .await
        .unwrap();
    let (_, generated) = call(
        &app,
        "POST",
        &format!("/{}/generate", saved["id"].as_str().unwrap()),
        json!({"customer_id":customers[0],"version":1,"idempotency_key":Uuid::new_v4()}),
    )
    .await;
    assert_eq!(generated["outcome"], "suppressed");
    assert!(generated["reason"].as_str().unwrap().contains("conditions"));
    assert!(generated["record"].is_null());
    let all = conditions_preview(&app, customers[0], p.clone()).await;
    assert_eq!(all["conditions_matched"], false);
    p["conditions"]["match"] = json!("any");
    let any = conditions_preview(&app, customers[0], p).await;
    assert_eq!(any["eligible"], true);
    assert_eq!(any["condition_results"][0]["matched"], false);
    assert_eq!(any["condition_results"][1]["matched"], true);
    sqlx::query(
        "UPDATE customers.customers SET created_at=clock_timestamp()+interval '1 day' WHERE id=$1",
    )
    .bind(customers[0])
    .execute(&pool)
    .await
    .unwrap();
    let mut future = config();
    future["suppress_after_purchase"] = json!(false);
    future["conditions"] =
        json!({"match":"all","rules":[condition("customer.account_age_days","eq","0")]});
    let future = conditions_preview(&app, customers[0], future).await;
    assert_eq!(future["conditions_matched"], false);
    assert!(future["condition_results"][0]["actual"].is_null());
}

#[sqlx::test(migrations = "../../migrations")]
async fn new_orders_after_preview_are_counted_when_generating(pool: PgPool) {
    let (app, _, customers) = setup(&pool, vec!["*"]).await;
    visit(&pool, customers[0], 1).await;
    let mut p = config();
    p["suppress_after_purchase"] = json!(false);
    p["conditions"] = json!({"match":"all","rules":[condition("customer.order_count","eq","0")]});
    let saved = create(&app, p.clone()).await;
    let (_, preview) = call(
        &app,
        "POST",
        "/preview",
        json!({"program":p,"program_id":saved["id"],"customer_id":customers[0]}),
    )
    .await;
    assert_eq!(preview["eligible"], true);
    purchase(&pool, customers[0]).await;
    let (_, generated) = call(
        &app,
        "POST",
        &format!("/{}/generate", saved["id"].as_str().unwrap()),
        json!({"customer_id":customers[0],"version":1,"idempotency_key":Uuid::new_v4()}),
    )
    .await;
    assert_eq!(generated["outcome"], "suppressed");
    assert!(generated["reason"].as_str().unwrap().contains("conditions"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn conditions_use_latest_trigger_event_and_missing_facts_cannot_match(pool: PgPool) {
    let (app, _, customers) = setup(&pool, vec!["*"]).await;
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            serde_json::from_value(
                json!({"name":"Fruit","slug":"condition-fruit","parent_id":null}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let apple=catalog.save_product(None,serde_json::from_value(json!({"sku":"CONDITION-APPLE","slug":"condition-apple","name":"Organic Apple","description":"Test","price":"3.00","currency":"USD","unit":"kg","category_id":category.id,"attributes":{},"media_ids":[],"active":true,"in_stock":true})).unwrap()).await.unwrap();
    let old = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.journey_events(customer_id,id,session_id,event_type,path,source,occurred_at) VALUES($1,$2,$3,'page_view',$4,'test',clock_timestamp()-interval '2 minutes')")
        .bind(customers[0]).bind(old).bind(Uuid::new_v4()).bind(format!("/products/{}",apple.id)).execute(&pool).await.unwrap();
    let mut p = config();
    p["trigger_kind"] = json!("product_view");
    p["conditions"] = json!({"match":"all","rules":[condition("product.name","contains","APPLE")]});
    let matching = conditions_preview(&app, customers[0], p.clone()).await;
    assert_eq!(matching["conditions_matched"], true);
    assert_eq!(matching["condition_results"][0]["actual"], "Organic Apple");
    let pear=catalog.save_product(None,serde_json::from_value(json!({"sku":"CONDITION-PEAR","slug":"condition-pear","name":"Golden Pear","description":"Test","price":"3.00","currency":"USD","unit":"kg","category_id":category.id,"attributes":{},"media_ids":[],"active":true,"in_stock":true})).unwrap()).await.unwrap();
    let newer_nonmatch = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.journey_events(customer_id,id,session_id,event_type,path,source,occurred_at) VALUES($1,$2,$3,'page_view',$4,'test',clock_timestamp()-interval '90 seconds')")
        .bind(customers[0]).bind(newer_nonmatch).bind(Uuid::new_v4()).bind(format!("/products/{}",pear.id)).execute(&pool).await.unwrap();
    let nonmatch = conditions_preview(&app, customers[0], p.clone()).await;
    assert_eq!(nonmatch["event_id"], format!("browser:{newer_nonmatch}"));
    assert_eq!(nonmatch["conditions_matched"], false);
    assert_eq!(nonmatch["condition_results"][0]["actual"], "Golden Pear");
    let recent = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.journey_events(customer_id,id,session_id,event_type,path,source,occurred_at) VALUES($1,$2,$3,'page_view','/products/unavailable-product','test',clock_timestamp()-interval '1 minute')")
        .bind(customers[0]).bind(recent).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    let missing = conditions_preview(&app, customers[0], p).await;
    assert_eq!(missing["event_id"], format!("browser:{recent}"));
    assert_eq!(missing["conditions_matched"], false);
    assert!(missing["condition_results"][0]["actual"].is_null());
    let order = purchase(&pool, customers[0]).await;
    sqlx::query("INSERT INTO orders.order_status_history(id,order_id,status,reason) VALUES($1,$2,'unknown-display-label','Malformed historical fact')").bind(Uuid::new_v4()).bind(order).execute(&pool).await.unwrap();
    let mut status = config();
    status["trigger_kind"] = json!("order_status");
    status["conditions"] =
        json!({"match":"all","rules":[condition("order.status","neq","cancelled")]});
    let missing = conditions_preview(&app, customers[0], status).await;
    assert_eq!(missing["conditions_matched"], false);
    assert!(missing["condition_results"][0]["actual"].is_null());
}

#[sqlx::test(migrations = "../../migrations")]
async fn money_conditions_compare_exact_decimals_and_require_event_currency(pool: PgPool) {
    let (app, _, customers) = setup(&pool, vec!["*"]).await;
    let order = purchase(&pool, customers[0]).await;
    sqlx::query("UPDATE orders.orders SET subtotal=0.30,total=0.30 WHERE id=$1")
        .bind(order)
        .execute(&pool)
        .await
        .unwrap();
    let mut p = config();
    p["trigger_kind"] = json!("purchase");
    p["conditions"] = json!({"match":"all","rules":[{"field":"order.total","operator":"eq","value":"0.30","currency":"USD"},condition("order.currency","eq","USD")]});
    let equal = conditions_preview(&app, customers[0], p.clone()).await;
    assert_eq!(equal["eligible"], true, "{equal}");
    assert_eq!(equal["condition_results"][0]["expected"], "0.30 USD");
    assert_eq!(equal["condition_results"][0]["actual"], "0.30 USD");
    p["conditions"]["rules"][0]["currency"] = json!("EGP");
    let mismatch = conditions_preview(&app, customers[0], p.clone()).await;
    assert_eq!(mismatch["conditions_matched"], false);
    assert!(mismatch["condition_results"][0]["reason"]
        .as_str()
        .unwrap()
        .contains("currency"));
    p["trigger_kind"] = json!("checkout");
    p["conditions"]["rules"][0]["currency"] = json!("USD");
    sqlx::query("INSERT INTO cart_checkout.quotes(id,customer_id,cart_id,location_id,snapshot,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour')")
        .bind(Uuid::new_v4()).bind(customers[0]).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(json!({"total":"0.30","items":[]})).execute(&pool).await.unwrap();
    let missing = conditions_preview(&app, customers[0], p).await;
    assert_eq!(missing["conditions_matched"], false);
    assert!(missing["condition_results"][0]["actual"].is_null());
    assert!(missing["condition_results"][1]["actual"].is_null());
}

#[sqlx::test(migrations = "../../migrations")]
async fn malformed_or_unsupported_condition_programs_are_rejected(pool: PgPool) {
    let (app, _, customers) = setup(&pool, vec!["*"]).await;
    let invalid = vec![
        json!({"match":"any","rules":[]}),
        json!({"match":"none","rules":[]}),
        json!({"match":"all","rules":vec![condition("customer.verified","eq","true");11]}),
        json!({"match":"all","rules":[condition("customer.email","contains","@")]}),
        json!({"match":"all","rules":[condition("customer.order_count","contains","1")]}),
        json!({"match":"all","rules":[condition("customer.order_count","gte","01")]}),
        json!({"match":"all","rules":[condition("customer.order_count","gte","+1")]}),
        json!({"match":"all","rules":[condition("customer.order_count","gte","1e2")]}),
        json!({"match":"all","rules":[condition("product.name","eq","Apple")]}),
        json!({"match":"all","rules":[{"field":"customer.verified","operator":"eq","value":"true","currency":"USD"}]}),
        json!({"match":"all","rules":[{"field":"customer.verified","operator":"eq","value":"true","sql":"SELECT 1"}]}),
    ];
    for conditions in invalid {
        let mut p = config();
        p["conditions"] = conditions;
        let result = call(&app, "POST", "", p.clone()).await;
        assert_eq!(result.0, StatusCode::BAD_REQUEST, "{}", result.1);
        let result = call(
            &app,
            "POST",
            "/preview",
            json!({"program":p,"customer_id":customers[0]}),
        )
        .await;
        assert_eq!(result.0, StatusCode::BAD_REQUEST, "{}", result.1);
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_matching_any_group_cannot_bypass_base_generation_safeguards(pool: PgPool) {
    let (app, _, customers) = setup(&pool, vec!["*"]).await;
    visit(&pool, customers[0], 5).await;
    sqlx::query("UPDATE customers.customers SET verified=true WHERE id=$1")
        .bind(customers[0])
        .execute(&pool)
        .await
        .unwrap();
    for (field, value, reason) in [
        ("status", json!("paused"), "paused"),
        ("delay_minutes", json!(10), "delay"),
        (
            "body_template",
            json!("Your product: {{product.name}}"),
            "personalization",
        ),
    ] {
        let mut p = config();
        p[field] = value;
        p["conditions"] = json!({"match":"any","rules":[condition("customer.verified","eq","true"),condition("customer.order_count","gte","100")]});
        let saved = create(&app, p.clone()).await;
        let (_, preview) = call(
            &app,
            "POST",
            "/preview",
            json!({"program":p,"program_id":saved["id"],"customer_id":customers[0]}),
        )
        .await;
        assert_eq!(preview["conditions_matched"], true, "{preview}");
        assert_eq!(preview["eligible"], false, "{preview}");
        assert!(preview["reasons"].to_string().contains(reason), "{preview}");
        let (_, generated) = call(
            &app,
            "POST",
            &format!("/{}/generate", saved["id"].as_str().unwrap()),
            json!({"customer_id":customers[0],"version":1,"idempotency_key":Uuid::new_v4()}),
        )
        .await;
        assert_eq!(generated["outcome"], "suppressed", "{generated}");
        assert!(generated["record"].is_null());
        assert!(
            generated["reason"].as_str().unwrap().contains(reason),
            "{generated}"
        );
    }
}
