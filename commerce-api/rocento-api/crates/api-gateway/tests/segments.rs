use api_gateway::{identity, segments};
use axum::{body::Body, http::Request, Router};
use domain_customers::segments::{Input, Rule, Service};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

fn input(family: &str, attribute: &str, operator: &str, value: &str) -> Input {
    Input {
        name: "Test audience".into(),
        description: "Synthetic".into(),
        status: "active".into(),
        website: "Main Website".into(),
        apply_to: "registered".into(),
        matching: "all".into(),
        revision: 0,
        rules: vec![Rule {
            id: "one".into(),
            family: family.into(),
            attribute: attribute.into(),
            operator: operator.into(),
            value: value.into(),
        }],
    }
}
async fn fixture(pool: &PgPool) -> (Service, Router, Uuid, Uuid) {
    let actor = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'segments@example.test','Segments','unused',$2)")
        .bind(actor).bind(domain_admin_iam::SUPER).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest("segment-session")).bind(actor).execute(pool).await.unwrap();
    let first = Uuid::new_v4();
    for (id, email, group, attributes) in [
        (first, "alice@example.test", "gold", json!({"tier":"gold"})),
        (Uuid::new_v4(), "bob@example.test", "general", json!({})),
    ] {
        sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash,customer_group,attributes) VALUES($1,$2,'email','unused',$3,$4)").bind(id).bind(email).bind(group).bind(attributes).execute(pool).await.unwrap();
    }
    let security = infra_auth::Security::new(
        "segments-test-secret-at-least-32-characters".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    (
        Service { pool: pool.clone() },
        segments::router(identity::App::new(
            pool.clone(),
            security,
            vec!["http://localhost:5173".into()],
        )),
        actor,
        first,
    )
}
async fn request(
    router: &Router,
    method: &str,
    path: &str,
    body: Value,
    token: &str,
    csrf: bool,
) -> (u16, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("cookie", format!("admin_session={token}"));
    if csrf {
        request = request.header("x-commerce-request", "1");
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        },
    )
}

#[sqlx::test(migrations = "../../migrations")]
async fn segments_persist_evaluate_and_reject_stale_writes(pool: PgPool) {
    let (service, router, actor, _) = fixture(&pool).await;
    let saved = service
        .save(
            None,
            input("customer", "customer_group", "is", "gold"),
            actor,
        )
        .await
        .unwrap();
    assert_eq!(saved.matched_customers, 1);
    let path = format!("/v1/admin/customer-segments/{}", saved.id);
    // A separate service instance and HTTP request read the same persisted definition.
    assert_eq!(
        Service { pool: pool.clone() }
            .get(saved.id)
            .await
            .unwrap()
            .matched_customers,
        1
    );
    let (status, read) = request(&router, "GET", &path, json!({}), "segment-session", false).await;
    assert_eq!(status, 200);
    assert_eq!(read["matchedCustomers"], 1);
    let mut edit = saved.definition.clone();
    edit.name = "Renamed".into();
    let next = service
        .save(Some(saved.id), edit.clone(), actor)
        .await
        .unwrap();
    assert_eq!(next.definition.revision, 2);
    assert!(matches!(
        service.save(Some(saved.id), edit, actor).await,
        Err(infra_auth::Error::Conflict)
    ));
    assert!(service.delete(saved.id, 1, actor).await.is_err());
    service.delete(saved.id, 2, actor).await.unwrap();
    assert!(matches!(
        service.get(saved.id).await,
        Err(infra_auth::Error::NotFound)
    ));
    let audits: i64 =
        sqlx::query_scalar("SELECT count(*) FROM admin_iam.audit_log WHERE entity_id=$1")
            .bind(saved.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(audits, 3);
}

#[sqlx::test(migrations = "../../migrations")]
async fn segment_membership_uses_real_orders_carts_and_eligible_attributes(pool: PgPool) {
    let (s, _, _, customer) = fixture(&pool).await;
    for (status, total) in [
        ("delivered", 100),
        ("cash_collected", 50),
        ("cancelled", 900),
    ] {
        sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency,created_at) VALUES($1,$2,$3,$4,$5,'{}','{}',$6,0,$6,'USD','2026-09-01T12:00:00Z')")
            .bind(Uuid::new_v4()).bind(customer).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(status).bind(total).execute(&pool).await.unwrap();
    }
    for (field, op, value, expected) in [
        ("orders_count", "is", "2", 1),
        ("orders_count", "is", "0", 1),
        ("orders_total", "is", "150", 1),
        ("average_order_value", "is", "75", 1),
        ("last_order_date", "after", "2026-09-01T12:00:00Z", 0),
        ("last_order_date", "before", "2026-09-02T00:00:00Z", 1),
    ] {
        assert_eq!(
            s.evaluate(&input("order", field, op, value))
                .await
                .unwrap()
                .0,
            expected,
            "{field}"
        );
    }
    let cart = Uuid::new_v4();
    sqlx::query("INSERT INTO cart_checkout.carts(id,customer_id) VALUES($1,$2)")
        .bind(cart)
        .bind(customer)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO cart_checkout.items(cart_id,product_id,sku,name,unit,price,quantity) VALUES($1,$2,'TEST','Test','each',3.50,2)").bind(cart).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    assert_eq!(
        s.evaluate(&input("cart", "cart_subtotal", "is", "7.00"))
            .await
            .unwrap()
            .0,
        1
    );
    sqlx::query("INSERT INTO attributes.definitions(id,entity_type,attribute_code,label,input_type,used_for_promo_rules) VALUES($1,'customer','tier','Tier','text',true)").bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    assert_eq!(
        s.evaluate(&input("customer", "attribute:tier", "is", "gold"))
            .await
            .unwrap()
            .0,
        1
    );
    assert_eq!(
        s.evaluate(&input("customer", "attribute:tier", "is not", "silver"))
            .await
            .unwrap()
            .0,
        1,
        "missing attributes never match negative conditions"
    );
    let mut both = input("customer", "customer_group", "is", "gold");
    let mut second = input("customer", "email", "is", "bob@example.test")
        .rules
        .remove(0);
    second.id = "two".into();
    both.rules.push(second);
    assert_eq!(s.evaluate(&both).await.unwrap().0, 0);
    both.matching = "any".into();
    assert_eq!(s.evaluate(&both).await.unwrap().0, 2);
    assert_eq!(
        s.evaluate(&input("customer", "email", "contains", "%'"))
            .await
            .unwrap()
            .0,
        0,
        "wildcards and quotes are literal"
    );
    assert!(s
        .evaluate(&input("customer", "newsletter_subscription", "is", "yes"))
        .await
        .is_err());
    assert!(s
        .evaluate(&input("order", "orders_count", "is", "NaN"))
        .await
        .is_err());
    sqlx::query("UPDATE attributes.definitions SET used_for_promo_rules=false")
        .execute(&pool)
        .await
        .unwrap();
    assert!(s
        .evaluate(&input("customer", "attribute:tier", "is", "gold"))
        .await
        .is_err());
}

#[sqlx::test(migrations = "../../migrations")]
async fn segments_enforce_rbac_csrf_and_atomic_audits(pool: PgPool) {
    let (s, router, actor, _) = fixture(&pool).await;
    let body = serde_json::to_value(input("customer", "customer_group", "is", "gold")).unwrap();
    let path = "/v1/admin/customer-segments";
    assert_eq!(
        request(&router, "GET", path, json!({}), "", false).await.0,
        401
    );
    assert_eq!(
        request(
            &router,
            "POST",
            path,
            body.clone(),
            "segment-session",
            false
        )
        .await
        .0,
        403
    );
    let role = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'Segment reader',ARRAY['customers.read'])").bind(role).execute(&pool).await.unwrap();
    sqlx::query("UPDATE admin_iam.admin_users SET role_id=$1 WHERE id=$2")
        .bind(role)
        .bind(actor)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(&router, "GET", path, json!({}), "segment-session", false)
            .await
            .0,
        200
    );
    assert_eq!(
        request(&router, "POST", path, body.clone(), "segment-session", true)
            .await
            .0,
        403
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['customers.read','customers.segments.write'] WHERE id=$1").bind(role).execute(&pool).await.unwrap();
    let (status, saved) = request(&router, "POST", path, body, "segment-session", true).await;
    assert_eq!(status, 200, "{saved}");
    sqlx::query("ALTER TABLE platform.outbox ADD CONSTRAINT fail_segment_event CHECK (event_type <> 'customer.segment_saved') NOT VALID").execute(&pool).await.unwrap();
    assert!(s
        .save(None, input("customer", "email", "contains", "alice"), actor)
        .await
        .is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM customers.segments")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1, "event failure rolls back definition and audit");
}
