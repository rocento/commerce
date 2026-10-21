use api_gateway::{identity, relationships};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use domain_catalog::{
    relationships::{Input, Kind},
    Service,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;
fn input() -> Input {
    serde_json::from_value(json!({"name":"Complements","kind":"related","active":true,"priority":1,"starts_at":null,"ends_at":null,"result_limit":20,"stop_processing":false,"source":{"any":false,"conditions":[]},"target":{"any":false,"conditions":[]},"manual_ids":[],"segment_ids":[],"revision":0})).unwrap()
}
async fn fixture(pool: &PgPool) -> (Service, Uuid, Uuid, Vec<Uuid>) {
    let actor = Uuid::new_v4();
    let role = Uuid::new_v4();
    let category = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'Relationship test',ARRAY['catalog.read','catalog.write'])").bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'relationships@example.test','Merchandiser','!',$2)").bind(actor).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest("relationship-session")).bind(actor).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.categories(id,name,slug) VALUES($1,'Category','relationship-category')").bind(category).execute(pool).await.unwrap();
    let mut ids = Vec::new();
    for i in 1..=5 {
        let id = Uuid::from_u128(i);
        sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,active,in_stock) VALUES($1,$2,$2,$2,'',10,'USD','ea',$3,$4,true)").bind(id).bind(format!("relationship-{i}")).bind(category).bind(i!=5).execute(pool).await.unwrap();
        ids.push(id);
    }
    (Service { pool: pool.clone() }, actor, role, ids)
}
#[sqlx::test(migrations = "../../migrations")]
async fn rules_order_manual_exclusion_audit_and_revision(pool: PgPool) {
    let (s, actor, _, ids) = fixture(&pool).await;
    let mut i = input();
    i.manual_ids = vec![ids[3], ids[2]];
    let saved = s.save_relationship_rule(None, i, actor).await.unwrap();
    let results = s
        .relationship_candidates(&[ids[0]], Kind::Related, &[])
        .await
        .unwrap();
    assert_eq!(
        results.iter().map(|p| p.id).collect::<Vec<_>>(),
        vec![ids[3], ids[2], ids[1]]
    );
    assert!(s
        .relationship_candidates(&[ids[0]], Kind::CrossSell, &[])
        .await
        .unwrap()
        .is_empty());
    let mut update = saved.definition.clone();
    update.name = "Updated".into();
    let next = s
        .save_relationship_rule(Some(saved.id), update.clone(), actor)
        .await
        .unwrap();
    assert_eq!(next.definition.revision, 2);
    assert!(matches!(
        s.save_relationship_rule(Some(saved.id), update, actor)
            .await,
        Err(infra_auth::Error::Conflict)
    ));
    assert!(matches!(
        s.delete_relationship_rule(saved.id, 1, actor).await,
        Err(infra_auth::Error::Conflict)
    ));
    s.delete_relationship_rule(saved.id, 2, actor)
        .await
        .unwrap();
    let audit: i64 =
        sqlx::query_scalar("SELECT count(*) FROM admin_iam.audit_log WHERE entity_id=$1")
            .bind(saved.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(audit, 3);
    assert!(s.relationship_rules().await.unwrap().is_empty());
}
#[sqlx::test(migrations = "../../migrations")]
async fn conditions_stop_and_concurrent_updates(pool: PgPool) {
    let (s, actor, _, ids) = fixture(&pool).await;
    let mut i = input();
    i.source.conditions =
        serde_json::from_value(json!([{"field":"sku","operator":"eq","value":"relationship-1"}]))
            .unwrap();
    i.target.conditions =
        serde_json::from_value(json!([{"field":"sku","operator":"eq","value":"relationship-2"}]))
            .unwrap();
    i.stop_processing = true;
    let saved = s.save_relationship_rule(None, i, actor).await.unwrap();
    let mut fallback = input();
    fallback.priority = 2;
    s.save_relationship_rule(None, fallback, actor)
        .await
        .unwrap();
    assert_eq!(
        s.relationship_candidates(&[ids[0]], Kind::Related, &[])
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        s.relationship_candidates(&[ids[1]], Kind::Related, &[])
            .await
            .unwrap()
            .len(),
        3
    );
    assert!(s
        .relationship_candidates(&[ids[4]], Kind::Related, &[])
        .await
        .unwrap()
        .is_empty());
    let (a, b) = tokio::join!(
        s.save_relationship_rule(Some(saved.id), saved.definition.clone(), actor),
        s.save_relationship_rule(Some(saved.id), saved.definition.clone(), actor)
    );
    assert_ne!(a.is_ok(), b.is_ok());
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    cookie: bool,
    csrf: bool,
) -> StatusCode {
    let mut r = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if cookie {
        r = r.header("cookie", "admin_session=relationship-session");
    }
    if csrf {
        r = r.header("x-commerce-request", "1");
    }
    let response = app
        .clone()
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
    let status = response.status();
    let _ = response.into_body().collect().await.unwrap();
    status
}
#[sqlx::test(migrations = "../../migrations")]
async fn admin_auth_permission_and_csrf(pool: PgPool) {
    let (_, _, role, _) = fixture(&pool).await;
    let security = infra_auth::Security::new(
        "relationship-tests-".repeat(4),
        "https://store.example.test".into(),
        false,
    )
    .await
    .unwrap();
    let app = relationships::router(identity::App::new(
        pool.clone(),
        security,
        vec!["https://admin.example.test".into()],
    ));
    let path = "/v1/admin/catalog/relationship-rules";
    let body = serde_json::to_value(input()).unwrap();
    assert_eq!(
        call(&app, "GET", path, Value::Null, false, false).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&app, "POST", path, body.clone(), true, false).await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&app, "POST", path, body.clone(), true, true).await,
        StatusCode::OK
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['catalog.read'] WHERE id=$1")
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        call(&app, "GET", path, Value::Null, true, false).await,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "POST", path, body, true, true).await,
        StatusCode::FORBIDDEN
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn promotion_attributes_require_opt_in_and_revocation_is_immediate(pool: PgPool) {
    let (s, actor, _, ids) = fixture(&pool).await;
    let mut rule = input();
    rule.target.conditions = serde_json::from_value(
        json!([{"field":"attribute","attribute_code":"brand","operator":"eq","value":"Acme"}]),
    )
    .unwrap();
    assert!(s
        .save_relationship_rule(None, rule.clone(), actor)
        .await
        .is_err());
    sqlx::query("INSERT INTO attributes.definitions(id,entity_type,attribute_code,label,input_type,used_for_promo_rules) VALUES($1,'product','brand','Brand','select',true)").bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    sqlx::query("UPDATE catalog.products SET attributes='{\"brand\":\"Acme\"}' WHERE id=$1")
        .bind(ids[1])
        .execute(&pool)
        .await
        .unwrap();
    s.save_relationship_rule(None, rule, actor).await.unwrap();
    assert_eq!(
        s.relationship_candidates(&[ids[0]], Kind::Related, &[])
            .await
            .unwrap()
            .len(),
        1
    );
    sqlx::query(
        "UPDATE attributes.definitions SET used_for_promo_rules=false WHERE attribute_code='brand'",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert!(s
        .relationship_candidates(&[ids[0]], Kind::Related, &[])
        .await
        .unwrap()
        .is_empty());
    let mut invalid = input();
    invalid.manual_ids = vec![Uuid::new_v4()];
    assert!(s
        .save_relationship_rule(None, invalid, actor)
        .await
        .is_err());
    assert_eq!(s.relationship_rules().await.unwrap().len(), 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn storefront_batches_stock_checks_and_uses_private_priced_projection(pool: PgPool) {
    let (s, actor, _, ids) = fixture(&pool).await;
    let mut first = input();
    first.target.conditions =
        serde_json::from_value(json!([{"field":"price","operator":"lte","value":"10"}])).unwrap();
    s.save_relationship_rule(None, first, actor).await.unwrap();
    let category = s.product(ids[0]).await.unwrap().category_id;
    for i in 10..35 {
        sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,active,in_stock) VALUES($1,$2,$2,$2,'',20,'USD','ea',$3,true,true)").bind(Uuid::from_u128(i)).bind(format!("extra-{i}")).bind(category).execute(&pool).await.unwrap();
    }
    let mut second = input();
    second.priority = 2;
    second.target.conditions =
        serde_json::from_value(json!([{"field":"price","operator":"gte","value":"20"}])).unwrap();
    s.save_relationship_rule(None, second, actor).await.unwrap();
    assert_eq!(
        s.relationship_candidates(&[ids[0]], Kind::Related, &[])
            .await
            .unwrap()
            .len(),
        23
    );
    let identity = identity::App::new(
        pool.clone(),
        infra_auth::Security::new(
            "relationship-public-tests-".repeat(4),
            "http://localhost".into(),
            false,
        )
        .await
        .unwrap(),
        vec![],
    );
    for id in [ids[1], Uuid::from_u128(10)] {
        identity
            .cart
            .inventory
            .adjust(id, 10, actor, "Relationship fixture".into())
            .await
            .unwrap();
    }
    let customer_security = identity.customers.security.clone();
    let router = api_gateway::catalog::router(api_gateway::catalog::App {
        identity,
        catalog: s,
        search: domain_search_client::Client::new("http://localhost:1".into(), "test".into()),
        media: infra_media::Store::new("http://localhost:1".into(), "test", "test").unwrap(),
        analytics: api_gateway::analytics::Client::new(
            "http://localhost:1".into(),
            "test".into(),
            "test".into(),
        ),
    });
    let uri = format!("/v1/catalog/relationships?sources={}&kind=related", ids[0]);
    let response = router
        .clone()
        .oneshot(Request::get(&uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers()["cache-control"]
        .to_str()
        .unwrap()
        .contains("no-store"));
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body.as_array().unwrap().len(), 2);
    assert_eq!(body[0]["id"], ids[1].to_string());
    assert_eq!(body[0]["price"], "10.00");
    assert_eq!(body[0]["in_stock"], true);
    // Audience membership is computed from authenticated identity, never caller-supplied IDs.
    let customer = Uuid::new_v4();
    let session = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash) VALUES($1,'relationship-shopper@example.test','email','!')").bind(customer).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO customers.sessions(id,customer_id,refresh_hash,expires_at) VALUES($1,$2,'relationship-refresh',now()+interval '1 hour')").bind(session).bind(customer).execute(&pool).await.unwrap();
    let segment=domain_customers::segments::Service{pool:pool.clone()}.save(None,serde_json::from_value(json!({"name":"Relationship audience","description":"Fixture","status":"active","website":"Main Website","applyTo":"registered","match":"all","rules":[{"id":"1","type":"customer","attribute":"email","operator":"is","value":"relationship-shopper@example.test"}],"revision":0})).unwrap(),actor).await.unwrap();
    let service = Service { pool: pool.clone() };
    for rule in service.relationship_rules().await.unwrap() {
        let mut definition = rule.definition;
        definition.segment_ids = vec![segment.id];
        service
            .save_relationship_rule(Some(rule.id), definition, actor)
            .await
            .unwrap();
    }
    let response = router
        .clone()
        .oneshot(Request::get(&uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body, json!([]));
    let token = customer_security.access_token(customer, session).unwrap();
    let response = router
        .clone()
        .oneshot(
            Request::get(&uri)
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body.as_array().unwrap().len(), 2);

    let response = router
        .clone()
        .oneshot(
            Request::get(&uri)
                .header("authorization", "Bearer invalid")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = router
        .oneshot(
            Request::get("/v1/catalog/relationships?sources=bad&kind=related")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}
