use api_gateway::identity::App;
use domain_cart_checkout::shopping::{Draft, Goal, Mode, Selection};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

struct Fixture {
    app: App,
    customer: Uuid,
    location: Uuid,
    cart: Uuid,
    a: domain_catalog::Product,
    b: domain_catalog::Product,
}
async fn setup(pool: PgPool) -> Fixture {
    let security = infra_auth::Security::new(
        "test-secret-at-least-32-characters-long".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let app = App::new(pool.clone(), security, vec!["http://localhost:5173".into()]);
    let c = app
        .customers
        .register(domain_customers::Credentials {
            identifier: "basket@example.test".into(),
            password: "Shopping test password!".into(),
        })
        .await
        .unwrap();
    sqlx::query("UPDATE customers.customers SET verified=true WHERE id=$1")
        .bind(c.id)
        .execute(&pool)
        .await
        .unwrap();
    let location=app.customers.save_location(c.id,None,serde_json::from_value(json!({"label":"home","latitude":30.0,"longitude":31.0,"formatted_address":"Synthetic test address"})).unwrap()).await.unwrap();
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            serde_json::from_value(
                json!({"name":"Test groceries","slug":"test-groceries","parent_id":null}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let mut products = Vec::new();
    for (sku, price) in [("ORIGINAL", "10.00"), ("ALTERNATIVE", "6.00")] {
        let p=catalog.save_product(None,serde_json::from_value(json!({"sku":sku,"name":"Apples one kg","slug":sku.to_lowercase(),"description":"Test only","price":price,"currency":"USD","unit":"kg","category_id":category.id,"attributes":{},"media_ids":[],"active":true,"in_stock":true})).unwrap()).await.unwrap();
        app.cart
            .inventory
            .adjust(p.id, 100, Uuid::new_v4(), "Isolated test stock".into())
            .await
            .unwrap();
        products.push(p);
    }
    let cart = app.cart.open(Some(c.id), "").await.unwrap().cart.id;
    app.cart
        .set(Some(c.id), "", products[0].clone(), 2, true)
        .await
        .unwrap();
    Fixture {
        app,
        customer: c.id,
        location: location.id,
        cart,
        a: products.remove(0),
        b: products.remove(0),
    }
}
async fn draft(f: &Fixture, mode: Mode) -> Draft {
    let task = Uuid::new_v4();
    let context = f
        .app
        .cart
        .shopping_context(f.cart, Some(f.customer), task)
        .await
        .unwrap();
    Draft {
        task_id: task,
        task_revision: 0,
        source_revision: context["source_revision"].as_i64().unwrap(),
        mode,
        auto_select: false,
        goal: Goal::default(),
        location_id: Some(f.location),
        order_id: None,
        selections: vec![selection(f.b.id, 1, None)],
    }
}
fn selection(product_id: Uuid, quantity: i32, replaces: Option<Uuid>) -> Selection {
    Selection {
        product_id,
        quantity,
        replaces,
        min_price: None,
        max_price: None,
        exclusive_max: false,
        exclusive_min: false,
        required_attributes: Default::default(),
        reason: "Synthetic selection".into(),
    }
}
use api_gateway::assistant;
use axum::{body::Body, http::Request};
use domain_cart_checkout::trust as t;
use http_body_util::BodyExt;
use std::sync::Arc;
use tower::ServiceExt;
fn assistant_app(identity: App, tenant: Uuid) -> assistant::App {
    assistant::App {
        identity,
        tenant,
        signing: Arc::new(
            jsonwebtoken::EncodingKey::from_rsa_pem(support::assistant_private_key()).unwrap(),
        ),
        verifying: Arc::new(
            jsonwebtoken::DecodingKey::from_rsa_pem(support::assistant_public_key()).unwrap(),
        ),
        client: reqwest::Client::new(),
        slots: Arc::new(tokio::sync::Semaphore::new(8)),
    }
}
async fn enable(f: &Fixture) -> (Uuid, Uuid, String) {
    let tenant = Uuid::new_v4();
    sqlx::query("UPDATE cart_checkout.trust_configuration SET enabled=true,signed_http_enabled=true,tenant_id=$1").bind(tenant).execute(&f.app.customers.pool).await.unwrap();
    let token = f
        .app
        .customers
        .login(domain_customers::Credentials {
            identifier: "basket@example.test".into(),
            password: "Shopping test password!".into(),
        })
        .await
        .unwrap()
        .body
        .access_token;
    let sid = f.app.customers.security.decode(&token).unwrap().sid;
    (tenant, sid, token)
}
async fn proposal(f: &Fixture) -> domain_cart_checkout::shopping::Proposal {
    f.app
        .cart
        .propose(f.cart, Some(f.customer), draft(f, Mode::Shop).await)
        .await
        .unwrap()
}
async fn confirm(f: &Fixture, tenant: Uuid, sid: Uuid, p: Uuid) -> t::Action {
    t::confirm(
        &f.app.customers.pool,
        t::ConfirmationRequest {
            tenant,
            cart: f.cart,
            customer: Some(f.customer),
            session: Some(sid),
            proposal: p,
            key: p,
            external: None,
        },
    )
    .await
    .unwrap()
    .unwrap()
}
async fn snapshot(f: &Fixture) -> serde_json::Value {
    json!(f.app.cart.read_customer(f.customer).await.unwrap().unwrap())
}
async fn call(
    router: axum::Router,
    path: &str,
    method: &str,
    token: &str,
    value: serde_json::Value,
) -> (u16, serde_json::Value) {
    let response = router
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("x-commerce-request", "1")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(value.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}
#[sqlx::test(migrations = "../../migrations")]
async fn trust_confirmation_commit_replay_and_lost_response_are_atomic(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let (tenant, sid, _) = enable(&f).await;
    let p = proposal(&f).await;
    let before = snapshot(&f).await;
    assert!(f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, p.id)
        .await
        .is_err());
    assert_eq!(before, snapshot(&f).await);
    let a = confirm(&f, tenant, sid, p.id).await;
    assert_eq!(a.state, "authorized");
    assert_eq!(confirm(&f, tenant, sid, p.id).await.id, a.id);
    let (first, second) = tokio::join!(
        f.app
            .cart
            .apply_proposal(f.cart, Some(f.customer), "", p.id, p.id),
        f.app
            .cart
            .apply_proposal(f.cart, Some(f.customer), "", p.id, p.id)
    );
    assert_eq!(json!(first.unwrap()), json!(second.unwrap()));
    let status = t::status(&pool, tenant, f.cart, a.id).await.unwrap();
    assert_eq!(status.state, "committed");
    let (used, spent): (i32, rust_decimal::Decimal) = sqlx::query_as(
        "SELECT used_actions,spent FROM cart_checkout.delegation_grants WHERE id=$1",
    )
    .bind(a.grant_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(used, 1);
    assert_eq!(spent, a.amount);
    assert!(t::status(&pool, Uuid::new_v4(), f.cart, a.id)
        .await
        .is_err());
    assert!(t::status(&pool, tenant, Uuid::new_v4(), a.id)
        .await
        .is_err());
    let committed = snapshot(&f).await;
    sqlx::query("UPDATE cart_checkout.delegation_grants SET revoked_at=now() WHERE id=$1")
        .bind(a.grant_id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, p.id)
        .await
        .is_err());
    assert_eq!(committed, snapshot(&f).await);
    assert_eq!(
        t::status(&pool, tenant, f.cart, a.id).await.unwrap().state,
        "committed"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM orders.orders")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM payments.manual_refunds")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn trust_live_revocation_and_material_changes_never_mutate_cart(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let (tenant, sid, _) = enable(&f).await;
    for change in [
        "price",
        "address",
        "quantity",
        "revocation",
        "expiry",
        "session",
        "agent",
        "scope",
        "tenant",
        "fingerprint",
        "indeterminate",
    ] {
        let p = proposal(&f).await;
        let a = confirm(&f, tenant, sid, p.id).await;
        let original = snapshot(&f).await;
        match change {
            "price" => {
                sqlx::query("UPDATE catalog.products SET price=7 WHERE id=$1")
                    .bind(f.b.id)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            "address" => {
                sqlx::query("UPDATE customers.customer_locations SET formatted_address='Changed address' WHERE id=$1").bind(f.location).execute(&pool).await.unwrap();
            }
            "quantity" => {
                f.app
                    .cart
                    .set(Some(f.customer), "", f.a.clone(), 3, false)
                    .await
                    .unwrap();
            }
            "revocation" => {
                sqlx::query(
                    "UPDATE cart_checkout.delegation_grants SET revoked_at=now() WHERE id=$1",
                )
                .bind(a.grant_id)
                .execute(&pool)
                .await
                .unwrap();
            }
            "expiry" => {
                sqlx::query("UPDATE cart_checkout.delegation_grants SET issued_at=now()-interval '20 minutes',expires_at=now()-interval '10 minutes' WHERE id=$1").bind(a.grant_id).execute(&pool).await.unwrap();
            }
            "session" => {
                sqlx::query("UPDATE customers.sessions SET expires_at=now()-interval '1 second' WHERE id=$1").bind(sid).execute(&pool).await.unwrap();
            }
            "agent" => {
                sqlx::query("UPDATE cart_checkout.trust_agents SET enabled=false")
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            "scope" => {
                sqlx::query("UPDATE cart_checkout.trust_configuration SET denied_scopes=ARRAY['cart.apply']").execute(&pool).await.unwrap();
            }
            "tenant" => {
                sqlx::query("UPDATE cart_checkout.trust_configuration SET tenant_id=$1")
                    .bind(Uuid::new_v4())
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            "fingerprint" => {
                sqlx::query("UPDATE cart_checkout.basket_proposals SET quote=jsonb_set(quote,'{resulting_items,0,quantity}','900') WHERE id=$1").bind(p.id).execute(&pool).await.unwrap();
            }
            "indeterminate" => {
                sqlx::query(
                    "UPDATE cart_checkout.agent_actions SET state='indeterminate' WHERE id=$1",
                )
                .bind(a.id)
                .execute(&pool)
                .await
                .unwrap();
                assert_eq!(
                    t::status(&pool, tenant, f.cart, a.id).await.unwrap().state,
                    "failed"
                );
            }
            _ => unreachable!(),
        }
        let before = snapshot(&f).await;
        assert!(
            f.app
                .cart
                .apply_proposal(f.cart, Some(f.customer), "", p.id, p.id)
                .await
                .is_err(),
            "{change}"
        );
        assert_eq!(before, snapshot(&f).await, "{change}");
        assert_eq!(
            sqlx::query_scalar::<_, i32>(
                "SELECT used_actions FROM cart_checkout.delegation_grants WHERE id=$1"
            )
            .bind(a.grant_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
        if change != "quantity" {
            assert_eq!(original["items"], before["items"]);
        }
        sqlx::query("UPDATE catalog.products SET price=6 WHERE id=$1")
            .bind(f.b.id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE customers.customer_locations SET formatted_address='Synthetic test address' WHERE id=$1").bind(f.location).execute(&pool).await.unwrap();
        sqlx::query("UPDATE customers.sessions SET expires_at=now()+interval '1 day' WHERE id=$1")
            .bind(sid)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE cart_checkout.trust_agents SET enabled=true")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE cart_checkout.trust_configuration SET tenant_id=$1,denied_scopes=ARRAY['order.place','payment.authorize','order.refund']").bind(tenant).execute(&pool).await.unwrap();
    }
}
async fn external_grant(f: &Fixture, tenant: Uuid, sid: Uuid, scopes: Vec<t::Scope>) -> t::Grant {
    let id = Uuid::new_v4();
    let key = std::str::from_utf8(support::assistant_public_key()).unwrap();
    sqlx::query("INSERT INTO cart_checkout.trust_agents(id,tenant_id,name,protocol,enabled,public_key,key_fingerprint,allowed_scopes,max_requests,max_daily_amount,currency) VALUES($1,$2,'Synthetic cart agent','signed_http',true,$3,$4,ARRAY['cart.read','cart.propose','cart.apply'],120,1000,'USD')").bind(id).bind(tenant).bind(key).bind(infra_auth::digest(key)).execute(&f.app.customers.pool).await.unwrap();
    let mut tx = domain_inventory::begin(&f.app.customers.pool)
        .await
        .unwrap();
    let g = t::issue(
        &mut tx,
        tenant,
        f.cart,
        Some(f.customer),
        Some(sid),
        t::GrantInput {
            agent_id: id,
            allowed_scopes: scopes,
            denied_scopes: vec![t::Scope::Place, t::Scope::Payment, t::Scope::Refund],
            product_ids: vec![],
            category_ids: vec![],
            location_id: Some(f.location),
            max_amount: 100.into(),
            max_total: 100.into(),
            currency: "USD".into(),
            max_actions: 2,
            duration_seconds: 300,
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    g
}
fn proof(g: &t::Grant, body: &serde_json::Value) -> String {
    let now = chrono::Utc::now().timestamp();
    jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
        &assistant::trust::Proof {
            iss: "rocento-registered-agent".into(),
            aud: "rocento-cart-actions-v1".into(),
            tenant_id: g.tenant_id,
            agent_id: g.agent_id,
            grant_id: g.id,
            grant_nonce: g.nonce,
            jti: Uuid::new_v4(),
            iat: now,
            exp: now + 45,
            body_sha256: infra_auth::digest(&body.to_string()),
        },
        &jsonwebtoken::EncodingKey::from_rsa_pem(support::assistant_private_key()).unwrap(),
    )
    .unwrap()
}
#[sqlx::test(migrations = "../../migrations")]
async fn signed_agents_are_least_privileged_bound_and_replay_safe(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let (tenant, sid, customer_token) = enable(&f).await;
    let router = assistant::router(f.app.clone(), Some(assistant_app(f.app.clone(), tenant)));
    let g = external_grant(&f, tenant, sid, vec![t::Scope::Read]).await;
    let body = json!({"grant_id":g.id,"request":{"operation":"read"}});
    let token = proof(&g, &body);
    let before = snapshot(&f).await;
    assert_eq!(
        call(
            router.clone(),
            "/v1/agents/actions",
            "POST",
            &token,
            body.clone()
        )
        .await
        .0,
        200
    );
    assert_eq!(
        call(
            router.clone(),
            "/v1/agents/actions",
            "POST",
            &token,
            body.clone()
        )
        .await
        .0,
        409
    );
    assert_eq!(
        call(
            router.clone(),
            "/v1/agents/actions",
            "POST",
            &customer_token,
            body.clone()
        )
        .await
        .0,
        401
    );
    let mutation = json!({"grant_id":g.id,"request":{"operation":"propose","draft":draft(&f,Mode::Shop).await}});
    assert_eq!(
        call(
            router.clone(),
            "/v1/agents/actions",
            "POST",
            &token,
            mutation.clone()
        )
        .await
        .0,
        403
    );
    assert_eq!(
        call(
            router.clone(),
            "/v1/agents/actions",
            "POST",
            &proof(&g, &mutation),
            mutation
        )
        .await
        .0,
        403
    );
    for operation in ["order.place", "payment.authorize", "order.refund"] {
        let input = json!({"grant_id":g.id,"request":{"operation":operation}});
        assert_eq!(
            call(
                router.clone(),
                "/v1/agents/actions",
                "POST",
                &proof(&g, &input),
                input
            )
            .await
            .0,
            400
        );
    }
    assert_eq!(before, snapshot(&f).await);
    let g = external_grant(
        &f,
        tenant,
        sid,
        vec![t::Scope::Read, t::Scope::Propose, t::Scope::Apply],
    )
    .await;
    let propose_input = json!({"grant_id":g.id,"request":{"operation":"propose","draft":draft(&f,Mode::Shop).await}});
    let (code, result) = call(
        router.clone(),
        "/v1/agents/actions",
        "POST",
        &proof(&g, &propose_input),
        propose_input,
    )
    .await;
    assert_eq!(code, 200, "{result}");
    let p: domain_cart_checkout::shopping::Proposal =
        serde_json::from_value(result["result"]["proposal"].clone()).unwrap();
    let a = t::confirm(
        &pool,
        t::ConfirmationRequest {
            tenant,
            cart: f.cart,
            customer: Some(f.customer),
            session: Some(sid),
            proposal: p.id,
            key: p.id,
            external: Some(g.id),
        },
    )
    .await
    .unwrap()
    .unwrap();
    let input = json!({"grant_id":g.id,"request":{"operation":"apply","action_id":a.id}});
    let token = proof(&g, &input);
    assert_eq!(
        call(
            router.clone(),
            "/v1/cart/trust/confirm",
            "POST",
            &token,
            json!({"proposal_id":p.id,"idempotency_key":p.id})
        )
        .await
        .0,
        401
    );
    let (code, result) = call(
        router.clone(),
        "/v1/agents/actions",
        "POST",
        &token,
        input.clone(),
    )
    .await;
    assert_eq!(code, 200, "{result}");
    assert_eq!(
        call(
            router.clone(),
            "/v1/agents/actions",
            "POST",
            &token,
            input.clone()
        )
        .await
        .0,
        409
    );
    assert_eq!(
        call(
            router.clone(),
            "/v1/agents/actions",
            "POST",
            &proof(&g, &input),
            input.clone()
        )
        .await
        .0,
        200
    );
    let status = json!({"grant_id":g.id,"request":{"operation":"status","action_id":a.id}});
    let (code, result) = call(
        router.clone(),
        "/v1/agents/actions",
        "POST",
        &proof(&g, &status),
        status,
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(result["result"]["action"]["state"], "committed");
    let (_, history) = call(
        router.clone(),
        "/v1/cart/trust",
        "GET",
        &customer_token,
        json!(null),
    )
    .await;
    assert_eq!(history["actions"].as_array().unwrap().len(), 1);
    assert_eq!(
        call(
            router.clone(),
            &format!("/v1/cart/trust/grants/{}", g.id),
            "DELETE",
            &customer_token,
            json!(null)
        )
        .await
        .0,
        200
    );
    assert_eq!(
        call(
            router.clone(),
            "/v1/agents/actions",
            "POST",
            &proof(&g, &input),
            input
        )
        .await
        .0,
        403
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn grants_enforce_resources_limits_protocol_and_key_rotation(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let (tenant, sid, _) = enable(&f).await;
    for restriction in [
        "product", "category", "location", "amount", "total", "actions", "daily", "currency",
        "protocol", "rotation",
    ] {
        let g = external_grant(&f, tenant, sid, vec![t::Scope::Read, t::Scope::Apply]).await;
        let p = proposal(&f).await;
        match restriction {
            "product" => {
                sqlx::query(
                    "UPDATE cart_checkout.delegation_grants SET product_ids=ARRAY[$2] WHERE id=$1",
                )
                .bind(g.id)
                .bind(Uuid::new_v4())
                .execute(&pool)
                .await
                .unwrap();
            }
            "category" => {
                sqlx::query(
                    "UPDATE cart_checkout.delegation_grants SET category_ids=ARRAY[$2] WHERE id=$1",
                )
                .bind(g.id)
                .bind(Uuid::new_v4())
                .execute(&pool)
                .await
                .unwrap();
            }
            "location" => {
                sqlx::query(
                    "UPDATE cart_checkout.delegation_grants SET location_id=$2 WHERE id=$1",
                )
                .bind(g.id)
                .bind(Uuid::new_v4())
                .execute(&pool)
                .await
                .unwrap();
            }
            "amount" => {
                sqlx::query("UPDATE cart_checkout.delegation_grants SET max_amount=1 WHERE id=$1")
                    .bind(g.id)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            "total" => {
                sqlx::query("UPDATE cart_checkout.delegation_grants SET spent=99 WHERE id=$1")
                    .bind(g.id)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            "actions" => {
                sqlx::query(
                    "UPDATE cart_checkout.delegation_grants SET used_actions=2 WHERE id=$1",
                )
                .bind(g.id)
                .execute(&pool)
                .await
                .unwrap();
            }
            "daily" => {
                sqlx::query("UPDATE cart_checkout.trust_agents SET max_daily_amount=1 WHERE id=$1")
                    .bind(g.agent_id)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            "currency" => {
                sqlx::query(
                    "UPDATE cart_checkout.delegation_grants SET currency='EUR' WHERE id=$1",
                )
                .bind(g.id)
                .execute(&pool)
                .await
                .unwrap();
            }
            "protocol" => {
                sqlx::query(
                    "UPDATE cart_checkout.trust_configuration SET signed_http_enabled=false",
                )
                .execute(&pool)
                .await
                .unwrap();
            }
            "rotation" => {
                sqlx::query(
                    "UPDATE cart_checkout.trust_agents SET key_fingerprint='rotated' WHERE id=$1",
                )
                .bind(g.agent_id)
                .execute(&pool)
                .await
                .unwrap();
            }
            _ => unreachable!(),
        }
        let before = snapshot(&f).await;
        assert!(
            t::confirm(
                &pool,
                t::ConfirmationRequest {
                    tenant,
                    cart: f.cart,
                    customer: Some(f.customer),
                    session: Some(sid),
                    proposal: p.id,
                    key: p.id,
                    external: Some(g.id)
                }
            )
            .await
            .is_err(),
            "{restriction}"
        );
        assert_eq!(before, snapshot(&f).await);
        sqlx::query("UPDATE cart_checkout.trust_configuration SET signed_http_enabled=true")
            .execute(&pool)
            .await
            .unwrap();
    }
    let p = proposal(&f).await;
    confirm(&f, tenant, sid, p.id).await;
    sqlx::query("UPDATE cart_checkout.trust_configuration SET enabled=false")
        .execute(&pool)
        .await
        .unwrap();
    assert!(f
        .app
        .cart
        .apply_delegated_proposal(f.cart, Some(f.customer), "", p.id, p.id, true)
        .await
        .is_err());
}

mod support;
fn normalize_nullable_refs(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            if let Some(serde_json::Value::Array(mut values)) = object.remove("allOf") {
                assert_eq!(values.len(), 1);
                for (key, value) in values.remove(0).as_object().unwrap() {
                    object.insert(key.clone(), value.clone());
                }
            }
            for value in object.values_mut() {
                normalize_nullable_refs(value);
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                normalize_nullable_refs(value);
            }
        }
        _ => {}
    }
}
#[sqlx::test(migrations = "../../migrations")]
async fn trust_contracts_browser_ownership_and_mixed_rollout_fail_closed(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let tenant = Uuid::new_v4();
    let old = proposal(&f).await;
    assert!(!t::configuration(&pool).await.unwrap().enabled);
    assert!(t::confirm(
        &pool,
        t::ConfirmationRequest {
            tenant,
            cart: f.cart,
            customer: Some(f.customer),
            session: None,
            proposal: old.id,
            key: old.id,
            external: None
        }
    )
    .await
    .unwrap()
    .is_none());
    let (tenant, sid, token) = enable(&f).await;
    // Quotes created by older code cannot silently acquire new material authority.
    assert!(t::confirm(
        &pool,
        t::ConfirmationRequest {
            tenant,
            cart: f.cart,
            customer: Some(f.customer),
            session: Some(sid),
            proposal: old.id,
            key: old.id,
            external: None
        }
    )
    .await
    .is_err());
    let p = proposal(&f).await;
    let action = confirm(&f, tenant, sid, p.id).await;
    let router = assistant::router(f.app.clone(), Some(assistant_app(f.app.clone(), tenant)));
    let mut contract: serde_json::Value =
        serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    normalize_nullable_refs(&mut contract);
    support::validate_shape(
        &json!(p),
        &contract["components"]["schemas"]["BasketProposal"],
        &contract,
    );
    for (path, schema) in [
        ("/v1/cart/trust".to_owned(), "TrustHistory"),
        (
            format!("/v1/cart/trust/actions/{}", action.id),
            "TrustAction",
        ),
        ("/v1/agents/capabilities".into(), "TrustCapabilities"),
    ] {
        let (code, value) = call(router.clone(), &path, "GET", &token, json!(null)).await;
        assert_eq!(code, 200);
        support::validate_shape(
            &value,
            &contract["components"]["schemas"][schema],
            &contract,
        );
    }
    let credentials = domain_customers::Credentials {
        identifier: "other-trust@example.test".into(),
        password: "Another synthetic password!".into(),
    };
    let other = f
        .app
        .customers
        .register(domain_customers::Credentials {
            identifier: credentials.identifier.clone(),
            password: credentials.password.clone(),
        })
        .await
        .unwrap();
    let other_token = f
        .app
        .customers
        .login(credentials)
        .await
        .unwrap()
        .body
        .access_token;
    f.app.cart.open(Some(other.id), "").await.unwrap();
    let (code, history) = call(
        router.clone(),
        "/v1/cart/trust",
        "GET",
        &other_token,
        json!(null),
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(history["actions"], json!([]));
    assert_eq!(history["grants"], json!([]));
    assert_eq!(
        call(
            router.clone(),
            &format!("/v1/cart/trust/actions/{}", action.id),
            "GET",
            &other_token,
            json!(null)
        )
        .await
        .0,
        404
    );
    assert_eq!(
        call(
            router.clone(),
            &format!("/v1/cart/trust/grants/{}", action.grant_id),
            "DELETE",
            &other_token,
            json!(null)
        )
        .await
        .0,
        404
    );
    assert_eq!(
        call(
            router.clone(),
            "/v1/cart/trust/confirm",
            "POST",
            &other_token,
            json!({"proposal_id":p.id,"idempotency_key":p.id})
        )
        .await
        .0,
        404
    );
    assert_eq!(
        call(
            router.clone(),
            "/v1/admin/assistant/trust",
            "GET",
            &token,
            json!(null)
        )
        .await
        .0,
        401
    );
    assert_eq!(
        call(
            router,
            "/v1/cart/trust/confirm",
            "POST",
            &token,
            json!({"proposal_id":p.id,"idempotency_key":p.id,"amount":"0"})
        )
        .await
        .0,
        422
    );
    assert_eq!(
        t::status(&pool, tenant, f.cart, action.id)
            .await
            .unwrap()
            .state,
        "authorized"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn numeric_identifier_metadata_preserves_confirmed_proposal_authority(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let (tenant, sid, _) = enable(&f).await;
    let p = proposal(&f).await;
    let destination: serde_json::Value = sqlx::query_scalar("SELECT to_jsonb(l)-'updated_at'-'created_at'-'is_default'-'entity_id' FROM customers.customer_locations l WHERE id=$1")
        .bind(f.location).fetch_one(&pool).await.unwrap();
    let legacy_fingerprint = infra_auth::digest(
        &json!({"proposal":t::fingerprint(&p),"destination":destination}).to_string(),
    );
    let mut tx = pool.begin().await.unwrap();
    assert_eq!(
        t::material(&mut tx, f.cart, Some(f.customer), &p)
            .await
            .unwrap(),
        legacy_fingerprint
    );
    tx.rollback().await.unwrap();
    // A proposal already signed under the previous schema retains the same authority.
    let mut legacy_quote = json!(p);
    for line in legacy_quote["lines"].as_array_mut().unwrap() {
        for field in ["product", "previous"] {
            if let Some(product) = line
                .get_mut(field)
                .and_then(serde_json::Value::as_object_mut)
            {
                product.remove("entity_id");
            }
        }
    }
    sqlx::query(
        "UPDATE cart_checkout.basket_proposals SET trust_fingerprint=$2,quote=$3 WHERE id=$1",
    )
    .bind(p.id)
    .bind(&legacy_fingerprint)
    .bind(legacy_quote)
    .execute(&pool)
    .await
    .unwrap();
    let action = confirm(&f, tenant, sid, p.id).await;
    assert_eq!(action.fingerprint, legacy_fingerprint);
    f.app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, p.id)
        .await
        .unwrap();
    assert_eq!(
        t::status(&pool, tenant, f.cart, action.id)
            .await
            .unwrap()
            .state,
        "committed"
    );
}
