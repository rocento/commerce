mod support;

// Tool handlers share a process-wide two-slot budget. Ordinary fixtures may run
// together; the fixture issuing two concurrent requests excludes other fixtures
// so an unrelated database does not contribute an unintended third request.
static TOOL_ADMISSION_TESTS: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

#[sqlx::test(migrations = "../../migrations")]
async fn strategy_cart_and_delivery_are_scoped_read_only_projections(pool: sqlx::PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let identity = identity(pool.clone()).await;
    let (owner, token) = customer(&identity, "strategy@example.test").await;
    let a = app(identity.clone(), uuid::Uuid::new_v4());
    let router = assistant::router(identity.clone(), Some(a.clone()));
    let now = chrono::Utc::now().timestamp();
    let mut claims = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "assistant-tools".into(),
        tenant: a.tenant,
        sub: Some(owner),
        sid: Some(identity.customers.security.decode(&token).unwrap().sid),
        request_id: uuid::Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: "cart_read".into(),
    };
    let request = |path: &str, claims: &assistant::Claims| {
        Request::get(path)
            .header(
                "authorization",
                format!("Bearer {}", a.sign(claims).unwrap()),
            )
            .body(Body::empty())
            .unwrap()
    };
    let response = router
        .clone()
        .oneshot(request("/v1/assistant-tools/cart", &claims))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let value: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &value,
        &contract["components"]["schemas"]["AssistantCart"],
        &contract,
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM cart_checkout.carts WHERE customer_id=$1")
            .bind(owner)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0, "Assistant reads must not create a cart");
    identity.cart.open(Some(owner), "").await.unwrap();
    let response = router
        .clone()
        .oneshot(request("/v1/assistant-tools/cart", &claims))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    claims.scope = "shopper_read".into();
    assert_eq!(
        router
            .clone()
            .oneshot(request("/v1/assistant-tools/cart", &claims))
            .await
            .unwrap()
            .status(),
        403
    );
    let response = router
        .clone()
        .oneshot(request("/v1/assistant-tools/delivery", &claims))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let value: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    support::validate_shape(
        &value,
        &contract["components"]["schemas"]["AssistantDelivery"],
        &contract,
    );
    claims.scope = "cart_read".into();
    claims.sub = None;
    claims.sid = None;
    assert_eq!(
        router
            .oneshot(request("/v1/assistant-tools/cart", &claims))
            .await
            .unwrap()
            .status(),
        401
    );
}
use api_gateway::{assistant, identity};
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use infra_auth::{Error, Security};
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;

use uuid::Uuid;
#[sqlx::test(migrations = "../../migrations")]
async fn typed_http_failures_cover_disabled_store_and_policy_rejection(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let router = assistant::router(identity(pool).await, None);
    for (csrf, typed, status, code) in [
        (true, false, 503, ""),
        (true, true, 503, "tool_unavailable"),
        (false, true, 403, "unsupported_action"),
    ] {
        let reference = Uuid::new_v4();
        let mut request =
            Request::post("/v1/assistant/chat").header("content-type", "application/json");
        if csrf {
            request = request.header("x-commerce-request", "1");
        }
        if typed {
            request = request
                .header("x-commerce-assistant-errors", "1")
                .header("x-commerce-request-reference", reference.to_string());
        }
        let response = router
            .clone()
            .oneshot(
                request
                    .body(Body::from(
                        json!({"request_id":reference,"message":"Hello"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
        let value: serde_json::Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(value.get("failure").is_some(), typed);
        if typed {
            assert_eq!(value["failure"]["code"], code);
            assert_eq!(value["failure"]["request_reference"], reference.to_string());
        }
    }
}
async fn identity(pool: PgPool) -> identity::App {
    identity::App::new(
        pool,
        Security::new(
            "assistant-test-key-".repeat(4),
            "http://localhost".into(),
            false,
        )
        .await
        .unwrap(),
        vec![],
    )
}
async fn customer(a: &identity::App, email: &str) -> (Uuid, String) {
    let i = || domain_customers::Credentials {
        identifier: email.into(),
        password: "Assistant tests password!".into(),
    };
    let c = a.customers.register(i()).await.unwrap();
    let token = a.customers.login(i()).await.unwrap().body.access_token;
    (c.id, token)
}
fn app(identity: identity::App, tenant: Uuid) -> assistant::App {
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
#[sqlx::test(migrations = "../../migrations")]
async fn delegated_context_reauthorizes_and_rejects_tenants(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let identity = identity(pool.clone()).await;
    let (owner, token) = customer(&identity, "assistant@example.test").await;
    let sid = identity.customers.security.decode(&token).unwrap().sid;
    let a = app(identity, Uuid::new_v4());
    let now = chrono::Utc::now().timestamp();
    let mut c = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "assistant-tools".into(),
        tenant: a.tenant,
        sub: Some(owner),
        sid: Some(sid),
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: "order_status".into(),
    };
    assert_eq!(
        a.customer(&a.decode(&a.sign(&c).unwrap(), "order_status").unwrap())
            .await
            .unwrap(),
        owner
    );
    c.tenant = Uuid::new_v4();
    assert!(a.decode(&a.sign(&c).unwrap(), "order_status").is_err());
    c.tenant = a.tenant;
    c.aud = "customer".into();
    assert!(a.decode(&a.sign(&c).unwrap(), "order_status").is_err());
    c.aud = "assistant-tools".into();
    c.scope = "refund".into();
    assert!(a.decode(&a.sign(&c).unwrap(), "order_status").is_err());
    c.scope = "order_status".into();
    c.sub = Some(Uuid::new_v4());
    assert!(a.customer(&c).await.is_err());
    c.sub = Some(owner);
    sqlx::query("DELETE FROM customers.sessions WHERE id=$1")
        .bind(sid)
        .execute(&pool)
        .await
        .unwrap();
    assert!(a.customer(&c).await.is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn tickets_atomic_idempotent_isolated_and_audited(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let a = identity(pool.clone()).await;
    let (owner, _) = customer(&a, "tickets@example.test").await;
    let (other, _) = customer(&a, "other@example.test").await;
    let service = domain_support::Service {
        pool: pool.clone(),
        tenant: Uuid::new_v4(),
    };
    let actor = domain_support::Actor::Customer(owner);
    let mut input:domain_support::TicketInput=serde_json::from_value(json!({"request_id":Uuid::new_v4(),"subject":"Missing item","category":"order_issue","body":"Please help"})).unwrap();
    let (one, two) = tokio::join!(
        service.create(&actor, &input),
        service.create(&actor, &input)
    );
    let one = one.unwrap();
    assert_eq!(one.ticket.id, two.unwrap().ticket.id);
    assert_eq!(
        one.ticket.id,
        service.create(&actor, &input).await.unwrap().ticket.id
    ); // response lost, retry
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &serde_json::to_value(&one).unwrap(),
        &contract["components"]["schemas"]["AssistantTicketDetail"],
        &contract,
    );
    for table in ["support.tickets", "support.messages", "support.audit"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM platform.outbox WHERE event_type='support.ticket_created'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
    assert!(matches!(
        service
            .detail(one.ticket.id, &domain_support::Actor::Customer(other))
            .await,
        Err(Error::NotFound)
    ));
    let foreign = domain_support::Service {
        pool: pool.clone(),
        tenant: Uuid::new_v4(),
    };
    assert!(matches!(
        foreign.detail(one.ticket.id, &actor).await,
        Err(Error::NotFound)
    ));
    assert!(foreign.list(&actor).await.unwrap().is_empty());
    input.body = "changed".into();
    assert!(matches!(
        service.create(&actor, &input).await,
        Err(Error::Conflict)
    ));
    let reply = domain_support::Reply {
        request_id: Uuid::new_v4(),
        body: "More details".into(),
        status: Some("closed".into()),
    };
    assert!(matches!(
        service.reply(one.ticket.id, &actor, &reply).await,
        Err(Error::Forbidden)
    ));
    let reply = domain_support::Reply {
        status: None,
        ..reply
    };
    let d = service.reply(one.ticket.id, &actor, &reply).await.unwrap();
    assert_eq!(d.messages.len(), 2);
    assert_eq!(
        service
            .reply(one.ticket.id, &actor, &reply)
            .await
            .unwrap()
            .messages
            .len(),
        2
    );
    input.request_id = Uuid::new_v4();
    input.order_id = Some(Uuid::new_v4());
    assert!(matches!(
        service.create(&actor, &input).await,
        Err(Error::NotFound)
    ));
}
#[sqlx::test(migrations = "../../migrations")]
async fn guest_support_validation_and_ownership(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let service = domain_support::Service {
        pool,
        tenant: Uuid::new_v4(),
    };
    let actor = domain_support::Actor::Guest("server-generated-guest-session");
    let mut input:domain_support::TicketInput=serde_json::from_value(json!({"request_id":Uuid::new_v4(),"subject":"Help","category":"payment_dispute","body":"Follow up"})).unwrap();
    assert!(service.create(&actor, &input).await.is_err());
    input.contact = Some("guest@example.test".into());
    input.contact_name = Some("Guest".into());
    let ticket = service.create(&actor, &input).await.unwrap();
    assert_eq!(ticket.ticket.priority, "high");
    assert!(ticket.contact.is_none());
    assert!(service
        .detail(
            ticket.ticket.id,
            &domain_support::Actor::Guest("other-session")
        )
        .await
        .is_err());
    input.request_id = Uuid::new_v4();
    input.order_id = Some(Uuid::new_v4());
    assert!(matches!(
        service.create(&actor, &input).await,
        Err(Error::Forbidden)
    ));
}
#[sqlx::test(migrations = "../../migrations")]
async fn gateway_rejects_spoofing_and_ai_outage_is_bounded(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let a = identity(pool).await;
    let assistant = app(a.clone(), Uuid::new_v4());
    let router = assistant::router(a.clone(), Some(assistant));
    for extra in [
        json!({"tenant_id":Uuid::new_v4()}),
        json!({"customer_id":Uuid::new_v4()}),
        json!({"url":"http://postgres:5432"}),
    ] {
        let mut input = json!({"request_id":Uuid::new_v4(),"message":"hello"});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/assistant/chat")
                    .header("content-type", "application/json")
                    .header("x-commerce-request", "1")
                    .body(Body::from(input.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 422);
    }
    let disabled = assistant::router(a, None)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/assistant/chat")
                .header("x-commerce-request", "1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(disabled.status(), 503);
    let data = disabled.into_body().collect().await.unwrap().to_bytes();
    assert!(String::from_utf8_lossy(&data).contains("support"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn support_admin_permissions_and_customer_resolution_visibility(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let a = identity(pool.clone()).await;
    let (owner, _) = customer(&a, "resolution@example.test").await;
    let service = domain_support::Service {
        pool: pool.clone(),
        tenant: Uuid::new_v4(),
    };
    let actor = domain_support::Actor::Customer(owner);
    let input=serde_json::from_value(json!({"request_id":Uuid::new_v4(),"subject":"Help","category":"other","body":"Please reply"})).unwrap();
    let ticket = service.create(&actor, &input).await.unwrap();
    let mut who = domain_admin_iam::Identity {
        user: domain_admin_iam::Admin {
            entity_id: 1,
            id: Uuid::new_v4(),
            email: "support@example.test".into(),
            name: "Support".into(),
            role_id: domain_admin_iam::SUPER,
            active: true,
            created_at: chrono::Utc::now(),
        },
        permissions: vec!["support.read".into()],
    };
    let reply = domain_support::Reply {
        request_id: Uuid::new_v4(),
        body: "Resolved by phone".into(),
        status: Some("resolved".into()),
    };
    assert!(matches!(
        service
            .reply(
                ticket.ticket.id,
                &domain_support::Actor::Admin(&who),
                &reply
            )
            .await,
        Err(Error::Forbidden)
    ));
    who.permissions.push("support.write".into());
    service
        .reply(
            ticket.ticket.id,
            &domain_support::Actor::Admin(&who),
            &reply,
        )
        .await
        .unwrap();
    let visible = service.detail(ticket.ticket.id, &actor).await.unwrap();
    assert_eq!(visible.ticket.status, "resolved");
    assert_eq!(visible.messages[1].body, "Resolved by phone");
    let audit: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM support.audit WHERE action='support.ticket_replied'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit, 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn shopper_catalog_is_scoped_and_reads_authoritative_domain_data(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let identity = identity(pool.clone()).await;
    let a = app(identity.clone(), Uuid::new_v4());
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            domain_catalog::CategoryInput {
                name: "Tools fruit".into(),
                slug: "tools-fruit".into(),
                parent_id: None,
            },
        )
        .await
        .unwrap();
    let image_id = Uuid::new_v4();
    catalog
        .add_media(domain_catalog::Media {
            id: image_id,
            entity_id: 0,
            content_type: "image/png".into(),
            alt: "Fresh fruit".into(),
            object_key: format!("catalog/{image_id}"),
            size_bytes: 100,
        })
        .await
        .unwrap();
    let product = catalog
        .save_product(
            None,
            serde_json::from_value(json!({
                "sku":"TOOLS-001","slug":"tools-fruit","name":"Fresh fruit","description":"Fruit",
                "price":"12.50","currency":"USD","unit":"kg","category_id":category.id,
                "attributes":{},"media_ids":[image_id],"active":true,"in_stock":true
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let now = chrono::Utc::now().timestamp();
    let mut claims = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "assistant-tools".into(),
        tenant: a.tenant,
        sub: None,
        sid: None,
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: "shopper_read".into(),
    };
    let router = assistant::router(identity, Some(a.clone()));
    for name in [
        "get_product",
        "get_product_attributes",
        "get_product_price",
        "get_product_inventory",
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::post("/v1/assistant-tools/shopper")
                    .header(
                        "authorization",
                        format!("Bearer {}", a.sign(&claims).unwrap()),
                    )
                    .header("content-type", "application/json")
                    .header("x-commerce-request", "1")
                    .body(Body::from(
                        json!({"name":name,"arguments":{"product_id":product.id}}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let revision = response.headers()["etag"].to_str().unwrap().to_owned();
        let conditional = || {
            Request::post("/v1/assistant-tools/shopper")
                .header(
                    "authorization",
                    format!("Bearer {}", a.sign(&claims).unwrap()),
                )
                .header("content-type", "application/json")
                .header("x-commerce-request", "1")
                .header("if-none-match", &revision)
                .body(Body::from(
                    json!({"name":name,"arguments":{"product_id":product.id}}).to_string(),
                ))
                .unwrap()
        };
        let unchanged = router.clone().oneshot(conditional()).await.unwrap();
        assert_eq!(unchanged.status(), 304);
        assert_eq!(unchanged.headers()["etag"], revision);
        sqlx::query("UPDATE catalog.products SET price=13 WHERE id=$1")
            .bind(product.id)
            .execute(&pool)
            .await
            .unwrap();
        let changed = router.clone().oneshot(conditional()).await.unwrap();
        assert_eq!(changed.status(), 200);
        assert_ne!(changed.headers()["etag"], revision);
        sqlx::query("UPDATE catalog.products SET price=12.50 WHERE id=$1")
            .bind(product.id)
            .execute(&pool)
            .await
            .unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
        support::validate_shape(
            &value,
            &contract["components"]["schemas"]["ShopperCatalogResult"],
            &contract,
        );
        assert_eq!(value["products"][0]["image_id"], image_id.to_string());
        assert_eq!(value["products"][0]["price"], "12.50");
        assert_eq!(value["products"][0]["id"], product.id.to_string());
        assert_eq!(
            value["products"][0]["route"],
            format!("/products/{}", product.id)
        );
        assert!(value["products"][0].get("description").is_none());
    }
    for scope in ["order_status", "support_create", "merchant_read"] {
        claims.scope = scope.into();
        let response = router
            .clone()
            .oneshot(
                Request::post("/v1/assistant-tools/shopper")
                    .header(
                        "authorization",
                        format!("Bearer {}", a.sign(&claims).unwrap()),
                    )
                    .header("content-type", "application/json")
                    .header("x-commerce-request", "1")
                    .body(Body::from(
                        json!({"name":"get_product","arguments":{"product_id":product.id}})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 403);
    }
    claims.scope = "shopper_read".into();
    for body in [
        json!({"name":"sql","arguments":{}}),
        json!({"name":"get_product","arguments":{"product_id":product.id,"url":"http://postgres"}}),
        json!({"name":"compare_products","arguments":{"product_ids":[product.id,product.id]}}),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::post("/v1/assistant-tools/shopper")
                    .header(
                        "authorization",
                        format!("Bearer {}", a.sign(&claims).unwrap()),
                    )
                    .header("content-type", "application/json")
                    .header("x-commerce-request", "1")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_client_error());
    }
    struct StaleSearch(domain_catalog::Product);
    impl domain_search_client::SearchProvider for StaleSearch {
        async fn search(
            &self,
            _: domain_search_client::Search,
        ) -> Result<domain_search_client::Results, Error> {
            Ok(domain_search_client::Results {
                facets: Default::default(),
                hits: vec![self.0.clone()],
                total: 1,
                offset: 0,
                limit: 20,
            })
        }
    }
    sqlx::query("UPDATE catalog.products SET price=15 WHERE id=$1")
        .bind(product.id)
        .execute(&pool)
        .await
        .unwrap();
    let delivery = a.identity.cart.inventory.delivery(None).await.unwrap();
    let search = StaleSearch(product.clone());
    let query = |max: &str| api_gateway::assistant_catalog::SearchArgs {
        currency: None,
        predicates: vec![],
        exclusive_max: false,
        in_stock: false,
        excluded_product_ids: vec![],
        exclusive_min: false,
        query: "fruit".into(),
        category_id: None,
        min_price: None,
        max_price: Some(max.into()),
        attributes: Default::default(),
    };
    let filtered =
        api_gateway::assistant_catalog::search_products(&a, query("13"), &delivery, &search)
            .await
            .unwrap();
    assert!(
        filtered.is_empty(),
        "stale search price must not bypass current budget"
    );
    let current =
        api_gateway::assistant_catalog::search_products(&a, query("20"), &delivery, &search)
            .await
            .unwrap();
    assert_eq!(current.len(), 1);
    assert_eq!(
        current[0].price.parse::<sqlx::types::Decimal>().unwrap(),
        sqlx::types::Decimal::from(15)
    );
    assert_eq!(current[0].category_name, category.name);
    let stock_ids = [product.id, Uuid::new_v4()];
    for area in [None, Some(Uuid::new_v4())] {
        let batch = a
            .identity
            .cart
            .inventory
            .available_many(&stock_ids, area)
            .await
            .unwrap();
        for id in stock_ids {
            let expected = if let Some(area) = area {
                a.identity
                    .cart
                    .inventory
                    .area_available(area, id)
                    .await
                    .unwrap()
            } else {
                a.identity.cart.inventory.stock(id).await.unwrap().available
            };
            assert_eq!(batch.get(&id).copied().unwrap_or(0), expected);
        }
    }
    assert!(a
        .identity
        .cart
        .inventory
        .available_many(&[product.id; 21], None)
        .await
        .is_err());

    // Only explicitly exposed schema attributes are projected to shopper tools.
    sqlx::query("INSERT INTO attributes.definitions(id,entity_type,attribute_code,label,input_type,is_visible_on_front,is_comparable,metadata) VALUES($1,'product','size','Size','number',true,true,'{\"ai_queryable\":true}') ON CONFLICT(entity_type,attribute_code) DO UPDATE SET is_visible_on_front=true,is_comparable=true,metadata=attributes.definitions.metadata || '{\"ai_queryable\":true}'::jsonb")
        .bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    // A search hit can be a configurable parent with aggregate attributes. The assistant
    // receives real child combinations, current prices and stock, never the aggregate.
    let parent = catalog
        .save_product(
            None,
            serde_json::from_value(json!({
                "sku":"M05-PARENT","slug":"m05-parent","name":"Running shoes","description":"",
                "price":"10","currency":"USD","unit":"each","category_id":category.id,
                "attributes":{},"media_ids":[],"active":true,"in_stock":true
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let mut children = Vec::new();
    for (sku, size, active) in [
        ("M05-41", 41, true),
        ("M05-42", 42, true),
        ("M05-HIDDEN", 43, false),
    ] {
        let child = catalog.save_product(None, serde_json::from_value(json!({
            "sku":sku,"slug":sku.to_lowercase(),"name":format!("Black shoes {size}"),"description":"",
            "price":"99","currency":"USD","unit":"each","category_id":category.id,
            "attributes":{},"media_ids":[],"active":active,"in_stock":true
        })).unwrap()).await.unwrap();
        sqlx::query("UPDATE catalog.products SET parent_id=$2, attributes=$3 WHERE id=$1")
            .bind(child.id)
            .bind(parent.id)
            .bind(json!({"color":"black","size":size}))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO catalog.product_links(parent_id,child_id,position) VALUES($1,$2,$3)",
        )
        .bind(parent.id)
        .bind(child.id)
        .bind(size)
        .execute(&pool)
        .await
        .unwrap();
        children.push(child.id);
    }
    sqlx::query("UPDATE catalog.products SET product_type='configurable' WHERE id=$1")
        .bind(parent.id)
        .execute(&pool)
        .await
        .unwrap();
    let variants = api_gateway::assistant_catalog::search_products(
        &a,
        query("120"),
        &delivery,
        &StaleSearch(parent.clone()),
    )
    .await
    .unwrap();
    assert_eq!(variants.len(), 2);
    assert_eq!(variants[1].id, children[1]);
    assert_eq!(variants[1].product_type, "simple");
    assert!(variants[1]
        .attributes
        .iter()
        .any(|a| a.name == "size" && a.value == "42"));
    assert!(variants
        .iter()
        .all(|p| p.id != parent.id && p.id != children[2]));
    assert!(
        api_gateway::assistant_catalog::search_products(
            &a,
            query("50"),
            &delivery,
            &StaleSearch(parent)
        )
        .await
        .unwrap()
        .is_empty(),
        "parent price must not be presented as a variant price"
    );
    let response = router
        .clone()
        .oneshot(
            Request::post("/v1/assistant-tools/shopper")
                .header(
                    "authorization",
                    format!("Bearer {}", a.sign(&claims).unwrap()),
                )
                .header("content-type", "application/json")
                .header("x-commerce-request", "1")
                .body(Body::from(
                    json!({"name":"get_category","arguments":{"category_id":category.id}})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let category_value: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(category_value["category"]["id"], category.id.to_string());
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km,priority,is_active) VALUES($1,'Unknown location',30,31,5,0,false)")
        .bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    let unknown = a.identity.cart.inventory.delivery(None).await.unwrap();
    let current =
        api_gateway::assistant_catalog::search_products(&a, query("20"), &unknown, &search)
            .await
            .unwrap();
    assert_eq!(current[0].in_stock, None);
    // Global stock remains visible without local delivery coverage.
    a.identity
        .cart
        .inventory
        .adjust(product.id, 1000, Uuid::nil(), "Global demo test".into())
        .await
        .unwrap();
    sqlx::query("UPDATE inventory.stocks SET is_global=true WHERE is_default")
        .execute(&pool)
        .await
        .unwrap();
    let worldwide =
        api_gateway::assistant_catalog::search_products(&a, query("20"), &unknown, &search)
            .await
            .unwrap();
    assert_eq!(worldwide[0].in_stock, Some(true));

    sqlx::query("UPDATE catalog.products SET active=false WHERE id=$1")
        .bind(product.id)
        .execute(&pool)
        .await
        .unwrap();
    let response = router
        .oneshot(
            Request::post("/v1/assistant-tools/shopper")
                .header(
                    "authorization",
                    format!("Bearer {}", a.sign(&claims).unwrap()),
                )
                .header("content-type", "application/json")
                .header("x-commerce-request", "1")
                .body(Body::from(
                    json!({"name":"get_product","arguments":{"product_id":product.id}}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
}

#[sqlx::test(migrations = "../../migrations")]
async fn shopper_schema_tracks_store_currency_and_invalidates_cached_revision(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let identity = identity(pool.clone()).await;
    let a = app(identity.clone(), Uuid::new_v4());
    let router = assistant::router(identity, Some(a.clone()));
    let now = chrono::Utc::now().timestamp();
    let claims = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "assistant-tools".into(),
        tenant: a.tenant,
        sub: None,
        sid: None,
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: "shopper_read".into(),
    };
    let request = |etag: &str| {
        Request::post("/v1/assistant-tools/shopper")
            .header(
                "authorization",
                format!("Bearer {}", a.sign(&claims).unwrap()),
            )
            .header("content-type", "application/json")
            .header("x-commerce-request", "1")
            .header("if-none-match", etag)
            .body(Body::from(
                json!({"name":"get_catalog_schema","arguments":{}}).to_string(),
            ))
            .unwrap()
    };
    let first = router.clone().oneshot(request("")).await.unwrap();
    assert_eq!(first.status(), 200);
    let first_revision = first.headers()["etag"].to_str().unwrap().to_owned();
    let value: serde_json::Value =
        serde_json::from_slice(&first.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(value["default_currency"], "USD");
    sqlx::query("UPDATE cart_checkout.market_configuration SET currency='EGP',version=version+1 WHERE singleton")
        .execute(&pool).await.unwrap();
    let changed = router
        .clone()
        .oneshot(request(&first_revision))
        .await
        .unwrap();
    assert_eq!(changed.status(), 200);
    let changed_revision = changed.headers()["etag"].to_str().unwrap().to_owned();
    assert_ne!(first_revision, changed_revision);
    let value: serde_json::Value =
        serde_json::from_slice(&changed.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(value["default_currency"], "EGP");
    assert_eq!(
        router
            .oneshot(request(&changed_revision))
            .await
            .unwrap()
            .status(),
        304
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn m10_order_tool_enforces_owner_scope_and_live_session(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let identity = identity(pool.clone()).await;
    let (owner, token) = customer(&identity, "m10-owner@example.test").await;
    let (other, other_token) = customer(&identity, "m10-other@example.test").await;
    let order = Uuid::new_v4();
    sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency) VALUES($1,$2,$3,$4,'placed','{}','{}',10,0,10,'USD')")
        .bind(order).bind(owner).bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    let a = app(identity.clone(), Uuid::new_v4());
    sqlx::query("INSERT INTO payments.payment_transactions(order_id,method,amount_due,currency) VALUES($1,'cod',10,'USD')").bind(order).execute(&pool).await.unwrap();
    domain_orders::Service { pool: pool.clone() }
        .detail(order, Some(owner))
        .await
        .unwrap();
    let router = assistant::router(identity.clone(), Some(a.clone()));
    let now = chrono::Utc::now().timestamp();
    for (subject, session_token, scope, expected) in [
        (owner, &token, "order_status", 200),
        (other, &other_token, "order_status", 404),
        (owner, &token, "shopper_read", 403),
    ] {
        let claims = assistant::Claims {
            iss: "commerce-assistant".into(),
            aud: "assistant-tools".into(),
            tenant: a.tenant,
            sub: Some(subject),
            sid: Some(
                identity
                    .customers
                    .security
                    .decode(session_token)
                    .unwrap()
                    .sid,
            ),
            request_id: Uuid::new_v4(),
            iat: now,
            exp: now + 45,
            scope: scope.into(),
        };
        let response = router
            .clone()
            .oneshot(
                Request::get(format!("/v1/assistant-tools/orders/{order}"))
                    .header(
                        "authorization",
                        format!("Bearer {}", a.sign(&claims).unwrap()),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), expected);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body = String::from_utf8_lossy(&bytes);
        assert!(
            !body.contains("m10-owner")
                && !body.contains("customer_id")
                && !body.contains("contact")
        );
    }
    let sid = identity.customers.security.decode(&token).unwrap().sid;
    let claims = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "assistant-tools".into(),
        tenant: a.tenant,
        sub: Some(owner),
        sid: Some(sid),
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: "order_status".into(),
    };
    let signed = a.sign(&claims).unwrap();
    sqlx::query("DELETE FROM customers.sessions WHERE id=$1")
        .bind(sid)
        .execute(&pool)
        .await
        .unwrap();
    let response = router
        .oneshot(
            Request::get(format!("/v1/assistant-tools/orders/{order}"))
                .header("authorization", format!("Bearer {signed}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(!response.status().is_success());
}

#[sqlx::test(migrations = "../../migrations")]
async fn m10_feedback_rate_limit_rejects_before_upstream(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let identity = identity(pool.clone()).await;
    let (owner, token) = customer(&identity, "m10-feedback@example.test").await;
    let a = app(identity.clone(), Uuid::new_v4());
    sqlx::query("INSERT INTO platform.rate_limits(key,attempts,window_start) VALUES($1,100,now())")
        .bind(infra_auth::digest(&format!(
            "assistant-feedback:{}:{}",
            a.tenant, owner
        )))
        .execute(&pool)
        .await
        .unwrap();
    let response = assistant::router(identity, Some(a))
        .oneshot(
            Request::post("/v1/assistant/feedback")
                .header("authorization", format!("Bearer {token}"))
                .header("x-commerce-request", "1")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"request_id":Uuid::new_v4(),"helpful":true}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 429);
}

#[sqlx::test(migrations = "../../migrations")]
async fn basket_capability_is_bound_to_cart_tenant_session_and_read_propose_only(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let identity = identity(pool).await;
    let (owner, token) = customer(&identity, "basket-capability@example.test").await;
    let cart = identity.cart.open(Some(owner), "").await.unwrap().cart.id;
    let a = app(identity.clone(), Uuid::new_v4());
    let router = assistant::router(identity.clone(), Some(a.clone()));
    let now = chrono::Utc::now().timestamp();
    let claims = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "assistant-tools".into(),
        tenant: a.tenant,
        sub: Some(owner),
        sid: Some(identity.customers.security.decode(&token).unwrap().sid),
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: format!("basket:{cart}"),
    };
    let path = format!(
        "/v1/assistant-tools/baskets/{cart}?task_id={}",
        Uuid::new_v4()
    );
    let request = |path: &str, c: &assistant::Claims| {
        Request::get(path)
            .header("authorization", format!("Bearer {}", a.sign(c).unwrap()))
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        router
            .clone()
            .oneshot(request(&path, &claims))
            .await
            .unwrap()
            .status(),
        200
    );
    let other = format!(
        "/v1/assistant-tools/baskets/{}?task_id={}",
        Uuid::new_v4(),
        Uuid::new_v4()
    );
    assert_eq!(
        router
            .clone()
            .oneshot(request(&other, &claims))
            .await
            .unwrap()
            .status(),
        403
    );
    let mut wrong = claims.clone();
    wrong.tenant = Uuid::new_v4();
    assert_eq!(
        router
            .clone()
            .oneshot(request(&path, &wrong))
            .await
            .unwrap()
            .status(),
        403
    );
    wrong = claims.clone();
    wrong.scope = "shopper_read".into();
    assert_eq!(
        router
            .clone()
            .oneshot(request(&path, &wrong))
            .await
            .unwrap()
            .status(),
        403
    );
    let response = router
        .clone()
        .oneshot(
            Request::post(format!("/v1/assistant-tools/baskets/{cart}/apply"))
                .header(
                    "authorization",
                    format!("Bearer {}", a.sign(&claims).unwrap()),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(matches!(response.status().as_u16(), 403 | 404));
    wrong = claims;
    wrong.sub = Some(Uuid::new_v4());
    assert!(router
        .oneshot(request(&path, &wrong))
        .await
        .unwrap()
        .status()
        .is_client_error());
}

#[sqlx::test(migrations = "../../migrations")]
async fn discovery_hydrates_before_ranking_and_keeps_hard_constraints(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    use domain_search_client::discovery as d;
    let a = app(identity(pool.clone()).await, Uuid::new_v4());
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            domain_catalog::CategoryInput {
                name: "M07 Grocery".into(),
                slug: "m07-grocery".into(),
                parent_id: None,
            },
        )
        .await
        .unwrap();
    let other = catalog
        .save_category(
            None,
            domain_catalog::CategoryInput {
                name: "M07 Jewelry".into(),
                slug: "m07-jewelry".into(),
                parent_id: None,
            },
        )
        .await
        .unwrap();
    let mut records = Vec::new();
    for (sku, price, cat) in [
        ("coffee", "10", category.id),
        ("tea", "7", category.id),
        ("ring", "5", other.id),
    ] {
        records.push(catalog.save_product(None,serde_json::from_value(json!({"sku":sku,"slug":sku,"name":sku,"description":sku,"price":price,"currency":"USD","unit":"pack","category_id":cat,"attributes":{},"media_ids":[],"active":true,"in_stock":true})).unwrap()).await.unwrap());
    }
    struct Fake(Vec<domain_catalog::Product>);
    impl domain_search_client::SearchProvider for Fake {
        async fn search(
            &self,
            _: domain_search_client::Search,
        ) -> Result<domain_search_client::Results, Error> {
            Ok(domain_search_client::Results {
                hits: self.0.clone(),
                total: 1000,
                offset: 0,
                limit: 20,
                facets: Default::default(),
            })
        }
    }
    struct Reverse;
    impl d::Reranker for Reverse {
        fn version(&self) -> &'static str {
            "ranker://test/reverse@1"
        }
        fn rank(&self, eligible: &[d::RankInput]) -> Vec<d::Ranked> {
            eligible
                .iter()
                .rev()
                .map(|p| d::Ranked {
                    id: p.id,
                    score: 0,
                    contributions: vec![],
                })
                .collect()
        }
    }
    let delivery = a.identity.cart.inventory.delivery(None).await.unwrap();
    let args = |query: &str, max: &str| api_gateway::assistant_catalog::SearchArgs {
        currency: None,
        predicates: vec![],
        exclusive_max: false,
        in_stock: false,
        excluded_product_ids: vec![],
        exclusive_min: false,
        query: query.into(),
        category_id: Some(category.id),
        min_price: None,
        max_price: Some(max.into()),
        attributes: Default::default(),
    };
    assert!(!d::enabled(&pool).await.unwrap());
    let (_, report) = api_gateway::assistant_catalog::search_with_ranker(
        &a,
        args("coffee", "20"),
        &delivery,
        &Fake(records.clone()),
        &d::DeterministicRanker,
    )
    .await
    .unwrap();
    assert!(report.is_none(), "compatibility mode omits new metadata");
    sqlx::query("UPDATE catalog.discovery_configuration SET enabled=true")
        .execute(&pool)
        .await
        .unwrap();
    let actor = Uuid::new_v4();
    let edge = |reviewed: bool, value: &str| d::EdgeInput {
        product_id: records[1].id,
        relation: "synonym".into(),
        target_product_id: None,
        value: value.into(),
        dimensions: Default::default(),
        source: "generated".into(),
        reviewed,
        expires_at: chrono::Utc::now() + chrono::Duration::days(1),
    };
    d::save_edge(&pool, edge(false, "morning cup"), actor)
        .await
        .unwrap();
    assert!(d::relation_candidates(&pool, "morning cup")
        .await
        .unwrap()
        .is_empty());
    let saved = d::save_edge(&pool, edge(true, "morning cup"), actor)
        .await
        .unwrap();
    let mut outside_category = edge(true, "morning cup");
    outside_category.product_id = records[2].id;
    d::save_edge(&pool, outside_category, actor).await.unwrap();
    let (related, r) = api_gateway::assistant_catalog::search_with_ranker(
        &a,
        args(" MORNING  cup ", "20"),
        &delivery,
        &Fake(vec![]),
        &d::DeterministicRanker,
    )
    .await
    .unwrap();
    assert_eq!(related.len(), 1);
    assert_eq!(related[0].id, records[1].id);
    assert_eq!(
        related[0].discovery.as_ref().unwrap().relationships[0].id,
        saved.id
    );
    assert_eq!(r.unwrap().relation_candidates, 2);
    let mut invalid = edge(true, "equivalent");
    invalid.relation = "substitutes".into();
    invalid.target_product_id = Some(records[0].id);
    assert!(
        d::save_edge(&pool, invalid, actor).await.is_err(),
        "substitution needs named dimensions"
    );
    sqlx::query("INSERT INTO catalog.discovery_merchandising(product_id,boost,sponsored,expires_at,updated_by) VALUES($1,10,true,now()+interval '1 day',$2)").bind(records[0].id).bind(actor).execute(&pool).await.unwrap();
    sqlx::query("UPDATE catalog.products SET price=100 WHERE id=$1")
        .bind(records[0].id)
        .execute(&pool)
        .await
        .unwrap();
    let mut foreign = records[0].clone();
    foreign.id = Uuid::new_v4();
    let search = Fake(vec![
        foreign,
        records[0].clone(),
        records[2].clone(),
        records[1].clone(),
    ]);
    let (products, report) = api_gateway::assistant_catalog::search_with_ranker(
        &a,
        args("coffee", "20"),
        &delivery,
        &search,
        &d::DeterministicRanker,
    )
    .await
    .unwrap();
    assert_eq!(products.len(), 1);
    assert_eq!(
        products[0].id, records[1].id,
        "stale boosted price, wrong category and foreign ID must fail"
    );
    let report = report.unwrap();
    assert_eq!(report.evaluated, 3);
    assert_eq!(report.eligible, 1);
    assert!(!report.exhaustive);
    assert!(!report.semantic_enabled);
    assert_eq!(
        products[0].discovery.as_ref().unwrap().offer.selling_unit,
        "pack"
    );
    let (swapped, _) = api_gateway::assistant_catalog::search_with_ranker(
        &a,
        args("coffee", "200"),
        &delivery,
        &search,
        &Reverse,
    )
    .await
    .unwrap();
    assert_eq!(
        swapped[0].id, records[1].id,
        "replacement ranker needs no playbook change"
    );
    let promoted = swapped
        .iter()
        .find(|p| p.id == records[0].id)
        .unwrap()
        .discovery
        .as_ref()
        .unwrap();
    assert!(promoted.sponsored);
    assert_eq!(promoted.merchant_boost, 10);
    assert_eq!(
        promoted
            .offer
            .price
            .parse::<sqlx::types::Decimal>()
            .unwrap(),
        sqlx::types::Decimal::from(100)
    );
    let (_, report) = api_gateway::assistant_catalog::search_with_ranker(
        &a,
        args("coffee", "1"),
        &delivery,
        &search,
        &d::DeterministicRanker,
    )
    .await
    .unwrap();
    assert_eq!(report.unwrap().outcome, "current_facts_filtered");
    sqlx::query("UPDATE catalog.discovery_edges SET expires_at=now()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(d::relation_candidates(&pool, "morning cup")
        .await
        .unwrap()
        .is_empty());
    assert!(
        sqlx::query("UPDATE catalog.discovery_configuration SET semantic_enabled=true")
            .execute(&pool)
            .await
            .is_err()
    );
    let observed: i64 =
        sqlx::query_scalar("SELECT count(*) FROM catalog.discovery_rank_observations")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(observed, 2, "only presented IDs have bounded diagnostics");
    let def:domain_attributes::Definition=serde_json::from_value(json!({"id":Uuid::new_v4(),"entity_type":"product","attribute_code":"contains_nuts","label":"Contains nuts","input_type":"boolean","scope":"global","is_required":false,"is_unique":false,"is_searchable":true,"is_filterable":true,"is_comparable":true,"is_visible_on_front":true,"used_for_promo_rules":false,"used_for_configurations":false,"swatch_type":"none","options":[],"version":0,"metadata":{"ai_queryable":true}})).unwrap();
    let def = domain_attributes::Service { pool: pool.clone() }
        .save(def)
        .await
        .unwrap();
    sqlx::query("UPDATE catalog.products SET attributes='{\"contains_nuts\":false}' WHERE id=$1")
        .bind(records[1].id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO attributes.value_provenance(product_id,definition_id,source) VALUES($1,$2,'AI_INFERRED')").bind(records[1].id).bind(def.id).execute(&pool).await.unwrap();
    let constrained = || {
        let mut i = args("tea", "20");
        i.attributes.insert("contains_nuts".into(), json!(false));
        i
    };
    let (inferred, _) = api_gateway::assistant_catalog::search_with_ranker(
        &a,
        constrained(),
        &delivery,
        &search,
        &d::DeterministicRanker,
    )
    .await
    .unwrap();
    assert!(
        inferred.is_empty(),
        "generated exclusion never proves a hard constraint"
    );
    sqlx::query("UPDATE attributes.value_provenance SET source='MERCHANT' WHERE product_id=$1")
        .bind(records[1].id)
        .execute(&pool)
        .await
        .unwrap();
    let (factual, _) = api_gateway::assistant_catalog::search_with_ranker(
        &a,
        constrained(),
        &delivery,
        &search,
        &d::DeterministicRanker,
    )
    .await
    .unwrap();
    assert_eq!(factual.len(), 1);
    sqlx::query("UPDATE attributes.definitions SET is_visible_on_front=false WHERE id=$1")
        .bind(def.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(api_gateway::assistant_catalog::search_with_ranker(
        &a,
        constrained(),
        &delivery,
        &search,
        &d::DeterministicRanker
    )
    .await
    .is_err());
    sqlx::query("UPDATE catalog.products SET active=false,product_type='configurable' WHERE id=$1")
        .bind(records[2].id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE catalog.products SET parent_id=$2 WHERE id=$1")
        .bind(records[1].id)
        .bind(records[2].id)
        .execute(&pool)
        .await
        .unwrap();
    let (hidden_parent, _) = api_gateway::assistant_catalog::search_with_ranker(
        &a,
        args("tea", "20"),
        &delivery,
        &search,
        &d::DeterministicRanker,
    )
    .await
    .unwrap();
    assert!(
        hidden_parent.is_empty(),
        "an inactive family cannot be revived by indexed child IDs"
    );
    sqlx::query("UPDATE catalog.products SET active=false WHERE id=$1")
        .bind(records[1].id)
        .execute(&pool)
        .await
        .unwrap();
    let (products, _) = api_gateway::assistant_catalog::search_with_ranker(
        &a,
        args("coffee", "20"),
        &delivery,
        &search,
        &d::DeterministicRanker,
    )
    .await
    .unwrap();
    assert!(products.is_empty());
}

#[sqlx::test(migrations = "../../migrations")]
async fn memory_guest_customer_consent_expiry_and_context_cas_are_isolated(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    use domain_customers::memory as m;
    let tenant = Uuid::new_v4();
    let other = Uuid::new_v4();
    assert!(!m::configuration(&pool).await.unwrap().enabled);
    let (guest, cookie) = m::resolve(&pool, tenant, None, None).await.unwrap();
    let cookie = cookie.unwrap();
    assert_ne!(cookie, guest.id.to_string());
    assert!(cookie.len() >= 40);
    let stored: String =
        sqlx::query_scalar("SELECT guest_hash FROM customers.memory_subjects WHERE id=$1")
            .bind(guest.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_ne!(stored, cookie);
    let (same, rotated) = m::resolve(&pool, tenant, None, Some(&cookie))
        .await
        .unwrap();
    assert_eq!(same.id, guest.id);
    assert!(rotated.is_none());
    assert_eq!(same.expires_at, guest.expires_at);
    let (separate, _) = m::resolve(&pool, other, None, Some(&cookie)).await.unwrap();
    assert_ne!(separate.id, guest.id);
    assert!(m::authorized(&pool, other, guest.id, None).await.is_err());
    assert!(m::consent(
        &pool,
        &guest,
        m::Consent {
            personalized: true,
            journey: true,
            expected_version: 0
        }
    )
    .await
    .is_err());
    m::consent(
        &pool,
        &guest,
        m::Consent {
            personalized: true,
            journey: false,
            expected_version: 0,
        },
    )
    .await
    .unwrap();
    assert!(m::consent(
        &pool,
        &guest,
        m::Consent {
            personalized: false,
            journey: false,
            expected_version: 0
        }
    )
    .await
    .is_err());
    let current = m::authorized(&pool, tenant, guest.id, None).await.unwrap();
    assert_eq!(current.consent_version, 1);
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            domain_catalog::CategoryInput {
                name: "Memory groceries".into(),
                slug: "memory-groceries".into(),
                parent_id: None,
            },
        )
        .await
        .unwrap();
    let product=catalog.save_product(None,serde_json::from_value(json!({"sku":"MEMORY-001","slug":"memory-coffee","name":"Memory Coffee","description":"Coffee","price":"6","currency":"USD","unit":"pack","category_id":category.id,"attributes":{},"media_ids":[],"active":true,"in_stock":true})).unwrap()).await.unwrap();
    sqlx::query("UPDATE customers.memory_configuration SET enabled=true,allowed_categories=$1")
        .bind(vec![category.id])
        .execute(&pool)
        .await
        .unwrap();
    let preference = || m::PreferenceInput {
        attribute: "product".into(),
        value: product.id.to_string(),
        category_id: category.id,
        occasion: "any".into(),
        recipient: "self".into(),
        goal_id: None,
        dislike: false,
        replaces: None,
    };
    let first = m::save_preference(&pool, &current, preference())
        .await
        .unwrap();
    assert_eq!(first.weight, 100);
    let mut dislike = preference();
    dislike.dislike = true;
    dislike.replaces = Some(first.id);
    let second = m::save_preference(&pool, &current, dislike).await.unwrap();
    assert_eq!(second.weight, -100);
    assert_ne!(first.id, second.id);
    assert_eq!(m::preferences(&pool, &current).await.unwrap().len(), 1);
    let mut sensitive = preference();
    sensitive.attribute = "religion".into();
    assert!(m::save_preference(&pool, &current, sensitive)
        .await
        .is_err());
    let task = Uuid::new_v4();
    let snapshot = || m::Snapshot {
        query: "coffee".into(),
        product_ids: vec![product.id],
        ..Default::default()
    };
    m::save_context(&pool, &current, task, 0, snapshot())
        .await
        .unwrap();
    assert!(
        m::save_context(&pool, &current, task, 0, snapshot())
            .await
            .is_err(),
        "stale tab cannot overwrite context"
    );
    assert_eq!(m::context(&pool, &current, task).await.unwrap().revision, 1);
    assert!(m::context(&pool, &separate, task)
        .await
        .unwrap()
        .snapshot
        .is_none());
    let mut unsafe_context = snapshot();
    unsafe_context.query = "pregnancy medication".into();
    assert!(m::save_context(&pool, &current, task, 1, unsafe_context)
        .await
        .is_err());
    m::consent(
        &pool,
        &current,
        m::Consent {
            personalized: false,
            journey: false,
            expected_version: 1,
        },
    )
    .await
    .unwrap();
    assert!(m::preferences(&pool, &current).await.unwrap().is_empty());
    assert!(
        m::save_preference(&pool, &current, preference())
            .await
            .is_err(),
        "revocation rejects an in-flight stale subject"
    );
    let customer_service = identity(pool.clone()).await;
    let (customer_id, _) = customer(&customer_service, "memory-owner@example.test").await;
    let (signed_in, clear) = m::resolve(&pool, tenant, Some(customer_id), Some(&cookie))
        .await
        .unwrap();
    assert!(clear.unwrap().is_empty());
    assert_ne!(signed_in.id, current.id);
    assert!(!signed_in.personalized);
    assert!(m::authorized(&pool, tenant, current.id, None)
        .await
        .is_err());
    assert!(m::context(&pool, &signed_in, task)
        .await
        .unwrap()
        .snapshot
        .is_none());
    let (new_guest, new_cookie) = m::resolve(&pool, tenant, None, Some(&cookie))
        .await
        .unwrap();
    assert_ne!(new_guest.id, guest.id);
    assert!(new_cookie.is_some());
    sqlx::query(
        "UPDATE customers.memory_subjects SET expires_at=now()-interval '1 second' WHERE id=$1",
    )
    .bind(new_guest.id)
    .execute(&pool)
    .await
    .unwrap();
    m::purge(&pool, tenant).await.unwrap();
    assert!(m::authorized(&pool, tenant, new_guest.id, None)
        .await
        .is_err());
    let records: i64 =
        sqlx::query_scalar("SELECT count(*) FROM customers.memory_consents WHERE subject_id=$1")
            .bind(current.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(records, 0, "deleted guest consent and evidence cascade");
}

#[sqlx::test(migrations = "../../migrations")]
async fn memory_http_scope_cookie_export_and_login_do_not_merge_guests(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    use domain_customers::memory as m;
    let identity = identity(pool.clone()).await;
    let a = app(identity.clone(), Uuid::new_v4());
    let router = assistant::router(identity.clone(), Some(a.clone()));
    sqlx::query("UPDATE customers.memory_configuration SET enabled=true")
        .execute(&pool)
        .await
        .unwrap();
    let response = router
        .clone()
        .oneshot(
            Request::get("/v1/assistant/memory")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    assert!(response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .contains("HttpOnly"));
    let body: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["guest"], true);
    assert_eq!(body["personalized"], false);
    let token = cookie.strip_prefix("assistant_guest=").unwrap();
    let (subject, _) = m::resolve(&pool, a.tenant, None, Some(token))
        .await
        .unwrap();
    let now = chrono::Utc::now().timestamp();
    let mut claims = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "assistant-tools".into(),
        tenant: a.tenant,
        sub: None,
        sid: None,
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: format!("memory:{}", subject.id),
    };
    let request = |token: String| {
        Request::get("/v1/assistant-tools/memory")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        router
            .clone()
            .oneshot(request(a.sign(&claims).unwrap()))
            .await
            .unwrap()
            .status(),
        200
    );
    claims.tenant = Uuid::new_v4();
    assert_eq!(
        router
            .clone()
            .oneshot(request(a.sign(&claims).unwrap()))
            .await
            .unwrap()
            .status(),
        403
    );
    claims.tenant = a.tenant;
    claims.scope = "shopper_read".into();
    assert_eq!(
        router
            .clone()
            .oneshot(request(a.sign(&claims).unwrap()))
            .await
            .unwrap()
            .status(),
        403
    );
    let export = router
        .clone()
        .oneshot(
            Request::get("/v1/assistant/memory/export")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(export.status(), 200);
    let data: serde_json::Value =
        serde_json::from_slice(&export.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(data.get("guest_hash").is_none());
    assert!(data.get("customer_id").is_none());
    let removed = router
        .clone()
        .oneshot(
            Request::delete("/v1/assistant/memory")
                .header("cookie", &cookie)
                .header("x-commerce-request", "1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(removed.status(), 200);
    claims.scope = format!("memory:{}", subject.id);
    assert_eq!(
        router
            .clone()
            .oneshot(request(a.sign(&claims).unwrap()))
            .await
            .unwrap()
            .status(),
        404
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn memory_customer_capability_rejects_other_owner_and_revoked_session(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    use domain_customers::memory as m;
    let identity = identity(pool.clone()).await;
    let (owner, token) = customer(&identity, "memory-owner@example.test").await;
    let (other, other_token) = customer(&identity, "memory-other@example.test").await;
    let a = app(identity.clone(), Uuid::new_v4());
    let router = assistant::router(identity.clone(), Some(a.clone()));
    sqlx::query("UPDATE customers.memory_configuration SET enabled=true")
        .execute(&pool)
        .await
        .unwrap();
    let (subject, _) = m::resolve(&pool, a.tenant, Some(owner), None)
        .await
        .unwrap();
    let now = chrono::Utc::now().timestamp();
    for (who, session, expected) in [(owner, &token, 200), (other, &other_token, 404)] {
        let claims = assistant::Claims {
            iss: "commerce-assistant".into(),
            aud: "assistant-tools".into(),
            tenant: a.tenant,
            sub: Some(who),
            sid: Some(identity.customers.security.decode(session).unwrap().sid),
            request_id: Uuid::new_v4(),
            iat: now,
            exp: now + 45,
            scope: format!("memory:{}", subject.id),
        };
        let signed = a.sign(&claims).unwrap();
        let request = || {
            Request::get("/v1/assistant-tools/memory")
                .header("authorization", format!("Bearer {signed}"))
                .body(Body::empty())
                .unwrap()
        };
        assert_eq!(
            router
                .clone()
                .oneshot(request())
                .await
                .unwrap()
                .status()
                .as_u16(),
            expected
        );
        if who == owner {
            sqlx::query("DELETE FROM customers.sessions WHERE id=$1")
                .bind(claims.sid)
                .execute(&pool)
                .await
                .unwrap();
            assert_eq!(
                router.clone().oneshot(request()).await.unwrap().status(),
                401
            );
        }
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn cart_mutations_require_write_scope_and_reject_replays(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let identity = identity(pool.clone()).await;
    let (owner, token) = customer(&identity, "cart-actions@example.test").await;
    identity.cart.open(Some(owner), "").await.unwrap();
    let a = app(identity.clone(), Uuid::new_v4());
    let router = assistant::router(identity.clone(), Some(a.clone()));
    let now = chrono::Utc::now().timestamp();
    let mut claims = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "assistant-tools".into(),
        tenant: a.tenant,
        sub: Some(owner),
        sid: Some(identity.customers.security.decode(&token).unwrap().sid),
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: "cart_read".into(),
    };
    let request = |claims: &assistant::Claims| {
        Request::post("/v1/assistant-tools/cart")
            .header(
                "authorization",
                format!("Bearer {}", a.sign(claims).unwrap()),
            )
            .header("content-type", "application/json")
            .header("x-commerce-request", "1")
            .body(Body::from(r#"{"action":"clear"}"#))
            .unwrap()
    };
    assert_eq!(
        router
            .clone()
            .oneshot(request(&claims))
            .await
            .unwrap()
            .status(),
        403
    );
    claims.scope = "cart_write".into();
    assert_eq!(
        router
            .clone()
            .oneshot(request(&claims))
            .await
            .unwrap()
            .status(),
        200
    );
    assert!(!router
        .clone()
        .oneshot(request(&claims))
        .await
        .unwrap()
        .status()
        .is_success());
    claims.request_id = Uuid::new_v4();
    claims.sub = None;
    claims.sid = None;
    assert_eq!(
        router.oneshot(request(&claims)).await.unwrap().status(),
        401
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn wishlist_transfer_is_atomic_replay_safe_and_payload_bound(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.write().await;
    let identity = identity(pool.clone()).await;
    let (owner, token) = customer(&identity, "wishlist-transfer@example.test").await;
    identity.cart.open(Some(owner), "").await.unwrap();
    let a = app(identity.clone(), Uuid::new_v4());
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            domain_catalog::CategoryInput {
                name: "Wishlist transfer fruit".into(),
                slug: "wishlist-transfer-fruit".into(),
                parent_id: None,
            },
        )
        .await
        .unwrap();
    let mut products = Vec::new();
    for (sku, slug, name) in [
        ("WL-TRANSFER-1", "wishlist-transfer-1", "Transfer apple"),
        ("WL-TRANSFER-2", "wishlist-transfer-2", "Transfer pear"),
    ] {
        let product = catalog
            .save_product(
                None,
                serde_json::from_value(json!({
                    "sku":sku,"slug":slug,"name":name,"description":"Fruit",
                    "price":"2.50","currency":"USD","unit":"each","category_id":category.id,
                    "attributes":{},"media_ids":[],"active":true,"in_stock":true
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        sqlx::query("INSERT INTO inventory.stock(product_id,on_hand) VALUES($1,100)")
            .bind(product.id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO inventory.source_items(source_id,product_id,quantity) VALUES($1,$2,100)",
        )
        .bind(Uuid::from_u128(1))
        .bind(product.id)
        .execute(&pool)
        .await
        .unwrap();
        products.push(product);
    }
    let reviews = domain_reviews::Service { pool: pool.clone() };
    for product in &products {
        reviews.wish(owner, product.id, true).await.unwrap();
    }

    let router = assistant::router(identity.clone(), Some(a.clone()));
    let claims_from_session = identity.customers.security.decode(&token).unwrap();
    let request_id = Uuid::new_v4();
    let mut claims = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "assistant-tools".into(),
        tenant: a.tenant,
        sub: Some(owner),
        sid: Some(claims_from_session.sid),
        request_id,
        iat: chrono::Utc::now().timestamp(),
        exp: chrono::Utc::now().timestamp() + 45,
        scope: "cart_write".into(),
    };
    let product_ids: Vec<_> = products.iter().map(|product| product.id).collect();
    let request = |claims: &assistant::Claims, ids: &[Uuid]| {
        Request::post("/v1/assistant-tools/cart/wishlist-transfer")
            .header(
                "authorization",
                format!("Bearer {}", a.sign(claims).unwrap()),
            )
            .header("content-type", "application/json")
            .header("x-commerce-request", "1")
            .body(Body::from(json!({"product_ids": ids}).to_string()))
            .unwrap()
    };
    assert_eq!(
        router
            .clone()
            .oneshot(request(&claims, &product_ids))
            .await
            .unwrap()
            .status(),
        403
    );

    claims.scope = "wishlist_cart_transfer".into();
    for invalid_ids in [
        vec![],
        vec![product_ids[0], product_ids[0]],
        vec![Uuid::new_v4(); 201],
    ] {
        assert_eq!(
            router
                .clone()
                .oneshot(request(&claims, &invalid_ids))
                .await
                .unwrap()
                .status(),
            400,
            "application validation rejects invalid transfer payloads"
        );
    }
    // The application sorts IDs. Fail the second item after the first has been
    // added and removed from the wishlist inside the transaction.
    let unavailable = *product_ids.iter().max().unwrap();
    sqlx::query("UPDATE catalog.products SET active=false WHERE id=$1")
        .bind(unavailable)
        .execute(&pool)
        .await
        .unwrap();
    let rejected = router
        .clone()
        .oneshot(request(&claims, &product_ids))
        .await
        .unwrap();
    assert_eq!(rejected.status(), 404);
    let after_failure = identity.cart.read_customer(owner).await.unwrap();
    assert!(after_failure.is_none_or(|cart| cart.items.is_empty()));
    let mut saved = reviews.wishlist_ids(owner).await.unwrap();
    saved.sort_unstable();
    let mut expected = product_ids.clone();
    expected.sort_unstable();
    assert_eq!(
        saved, expected,
        "failed transfer restores every wishlist item"
    );
    let claims_after_failure: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM cart_checkout.assistant_actions WHERE customer_id=$1 AND request_id=$2",
    )
    .bind(owner)
    .bind(request_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        claims_after_failure, 0,
        "failed transaction releases the replay claim"
    );
    sqlx::query("UPDATE catalog.products SET active=true WHERE id=$1")
        .bind(unavailable)
        .execute(&pool)
        .await
        .unwrap();

    // Identical concurrent HTTP requests must share one committed action and
    // receipt rather than transferring quantity one twice.
    let (first, concurrent) = tokio::join!(
        router.clone().oneshot(request(&claims, &product_ids)),
        router.clone().oneshot(request(&claims, &product_ids)),
    );
    let first = first.unwrap();
    assert_eq!(first.status(), 200);
    let first: serde_json::Value =
        serde_json::from_slice(&first.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let concurrent = concurrent.unwrap();
    assert_eq!(concurrent.status(), 200);
    let concurrent: serde_json::Value =
        serde_json::from_slice(&concurrent.into_body().collect().await.unwrap().to_bytes())
            .unwrap();
    assert_eq!(concurrent, first, "concurrent retries share the receipt");
    assert_eq!(first["items"].as_array().unwrap().len(), 2);
    assert!(first["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["status"] == "transferred"));

    let mut reordered_ids = product_ids.clone();
    reordered_ids.reverse();
    let replay = router
        .clone()
        .oneshot(request(&claims, &reordered_ids))
        .await
        .unwrap();
    assert_eq!(replay.status(), 200);
    let replay: serde_json::Value =
        serde_json::from_slice(&replay.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(replay, first, "exact retries return the committed receipt");

    let different_ids = [Uuid::new_v4()];
    let different = router
        .clone()
        .oneshot(request(&claims, &different_ids))
        .await
        .unwrap();
    assert_eq!(
        different.status(),
        400,
        "a request id cannot change payload"
    );

    let cart = identity.cart.read_customer(owner).await.unwrap().unwrap();
    assert_eq!(cart.items.len(), 2);
    assert!(cart.items.iter().all(|item| item.quantity == 1));
    assert!(reviews.wishlist_ids(owner).await.unwrap().is_empty());
    let actions: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM cart_checkout.assistant_actions WHERE customer_id=$1 AND request_id=$2",
    )
    .bind(owner)
    .bind(request_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(actions, 1);
    let (saved_ids, saved_receipt): (Vec<Uuid>, serde_json::Value) = sqlx::query_as(
        "SELECT product_ids,result FROM cart_checkout.assistant_wishlist_transfers WHERE customer_id=$1 AND request_id=$2",
    )
    .bind(owner)
    .bind(request_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(saved_ids, expected, "receipt payloads are canonical");
    assert_eq!(saved_receipt, first);
    for product in &products {
        assert_eq!(
            identity
                .cart
                .inventory
                .stock(product.id)
                .await
                .unwrap()
                .reserved,
            1,
            "concurrent retries reserve each product exactly once"
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn wishlist_transfer_replays_older_receipts_without_reprojecting(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let identity = identity(pool.clone()).await;
    let (owner, token) = customer(&identity, "wishlist-old-receipt@example.test").await;
    let a = app(identity.clone(), Uuid::new_v4());
    let router = assistant::router(identity.clone(), Some(a.clone()));
    let request_id = Uuid::new_v4();
    // An old receipt can outlive wishlist entries, product visibility, and the
    // current cart. Returning stored JSON must not require a current projection.
    let product_id = Uuid::new_v4();
    let receipt = json!({
        "items": [{"product_id": product_id, "name": "Saved product", "status": "transferred",
            "detail": "Quantity 1 added to cart and removed from your wishlist."}],
        "cart": {"items": [], "subtotal": "2.50", "discount_amount": "0.00",
            "currency": "USD", "fully_reserved": true},
        "legacy_extension": {"preserve": true}
    });
    sqlx::query(
        "INSERT INTO cart_checkout.assistant_actions(customer_id,request_id) VALUES($1,$2)",
    )
    .bind(owner)
    .bind(request_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO cart_checkout.assistant_wishlist_transfers(customer_id,request_id,product_ids,result) VALUES($1,$2,$3,$4)")
        .bind(owner).bind(request_id).bind(vec![product_id]).bind(&receipt).execute(&pool).await.unwrap();
    let now = chrono::Utc::now().timestamp();
    let claims = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "assistant-tools".into(),
        tenant: a.tenant,
        sub: Some(owner),
        sid: Some(identity.customers.security.decode(&token).unwrap().sid),
        request_id,
        iat: now,
        exp: now + 45,
        scope: "wishlist_cart_transfer".into(),
    };
    let response = router
        .oneshot(
            Request::post("/v1/assistant-tools/cart/wishlist-transfer")
                .header(
                    "authorization",
                    format!("Bearer {}", a.sign(&claims).unwrap()),
                )
                .header("content-type", "application/json")
                .header("x-commerce-request", "1")
                .body(Body::from(json!({"product_ids": [product_id]}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let replay: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(replay, receipt, "legacy receipt JSON is returned intact");
    assert!(identity.cart.read_customer(owner).await.unwrap().is_none());
}

#[sqlx::test(migrations = "../../migrations")]
async fn oldest_order_history_is_customer_scoped_and_not_recent_page(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let identity = identity(pool.clone()).await;
    let (owner, token) = customer(&identity, "oldest-owner@example.test").await;
    let (other, _) = customer(&identity, "oldest-other@example.test").await;
    let mut ids = Vec::new();
    for index in 0..8 {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency,created_at) VALUES($1,$2,$3,$4,'placed','{}','{}',10,0,10,'USD',TIMESTAMPTZ '2025-01-01' + $5 * INTERVAL '1 day')")
            .bind(id).bind(if index == 0 { other } else { owner })
            .bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(index as f64)
            .execute(&pool).await.unwrap();
        ids.push(id);
    }
    let a = app(identity.clone(), Uuid::new_v4());
    let router = assistant::router(identity.clone(), Some(a.clone()));
    let now = chrono::Utc::now().timestamp();
    let claims = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "assistant-tools".into(),
        tenant: a.tenant,
        sub: Some(owner),
        sid: Some(identity.customers.security.decode(&token).unwrap().sid),
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: "order_status".into(),
    };
    for (suffix, expected) in [
        ("?selection=oldest", vec![ids[1]]),
        ("", ids[3..].iter().rev().copied().collect()),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::get(format!("/v1/assistant-tools/orders{suffix}"))
                    .header(
                        "authorization",
                        format!("Bearer {}", a.sign(&claims).unwrap()),
                    )
                    .header("x-commerce-request", "1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let rows: Vec<serde_json::Value> =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(
            rows.iter()
                .map(|row| row["id"].as_str().unwrap().parse::<Uuid>().unwrap())
                .collect::<Vec<_>>(),
            expected
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn bestseller_calendar_periods_rank_completed_units_with_exclusive_end(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    use domain_orders::bestsellers::{rank, Period};
    let now = chrono::DateTime::parse_from_rfc3339("2026-09-23T12:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let first = Uuid::from_u128(1);
    let second = Uuid::from_u128(2);
    let excluded = Uuid::from_u128(3);
    for (period, start, end) in [
        (
            Period::Today,
            "2026-09-23T00:00:00Z",
            "2026-09-23T12:00:00Z",
        ),
        (
            Period::LastWeek,
            "2026-09-14T00:00:00Z",
            "2026-09-21T00:00:00Z",
        ),
        (
            Period::LastMonth,
            "2026-08-01T00:00:00Z",
            "2026-09-01T00:00:00Z",
        ),
        (
            Period::LastYear,
            "2025-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        ),
    ] {
        let start = chrono::DateTime::parse_from_rfc3339(start)
            .unwrap()
            .with_timezone(&chrono::Utc);
        let end = chrono::DateTime::parse_from_rfc3339(end)
            .unwrap()
            .with_timezone(&chrono::Utc);
        for (product, quantity, status, at) in [
            (first, 2, "delivered", start),
            (first, 3, "cash_collected", start),
            (second, 5, "delivered", start),
            (second, 100, "cancelled", start),
            (second, 100, "delivery_failed", start),
            (second, 100, "placed", start),
            (excluded, 100, "delivered", end),
            (
                excluded,
                100,
                "delivered",
                start - chrono::Duration::seconds(1),
            ),
        ] {
            let order = Uuid::new_v4();
            sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency,created_at) VALUES($1,$2,$3,$4,$5,'{}','{}',1000,0,1000,'USD',$6)")
                .bind(order).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(status).bind(at)
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO orders.order_items(order_id,product_id,sku,name,unit,quantity,price,line_total) VALUES($1,$2,'fixture','Fixture','each',$3,1,$3)")
                .bind(order).bind(product).bind(quantity).execute(&pool).await.unwrap();
        }
        let result = rank(&pool, period, now).await.unwrap();
        assert_eq!(result.start, start);
        assert_eq!(result.end, end);
        assert_eq!(
            result
                .products
                .iter()
                .map(|row| (row.product_id, row.units))
                .collect::<Vec<_>>(),
            vec![(first, 5), (second, 5)]
        );
        sqlx::query("DELETE FROM orders.order_items")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM orders.orders")
            .execute(&pool)
            .await
            .unwrap();
    }
    assert!(rank(&pool, Period::Today, now)
        .await
        .unwrap()
        .products
        .is_empty());
    assert!(
        serde_json::from_value::<api_gateway::assistant_catalog::Request>(
            json!({"name":"get_bestsellers","arguments":{"period":"last_365_days"}})
        )
        .is_err()
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn bestseller_projection_requires_shopper_scope_and_reports_calendar_metadata(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let identity = identity(pool).await;
    let a = app(identity.clone(), Uuid::new_v4());
    let router = assistant::router(identity, Some(a.clone()));
    let now = chrono::Utc::now().timestamp();
    let mut claims = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "assistant-tools".into(),
        tenant: a.tenant,
        sub: None,
        sid: None,
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: "shopper_read".into(),
    };
    for (period, scope, expected) in [
        ("today", "shopper_read", 200),
        ("last_week", "shopper_read", 200),
        ("last_month", "shopper_read", 200),
        ("last_year", "shopper_read", 200),
        ("today", "order_status", 403),
        ("last_365_days", "shopper_read", 422),
    ] {
        claims.scope = scope.into();
        let response = router
            .clone()
            .oneshot(
                Request::post("/v1/assistant-tools/shopper")
                    .header(
                        "authorization",
                        format!("Bearer {}", a.sign(&claims).unwrap()),
                    )
                    .header("content-type", "application/json")
                    .header("x-commerce-request", "1")
                    .body(Body::from(
                        json!({"name":"get_bestsellers","arguments":{"period":period}}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), expected);
        if expected == 200 {
            let value: serde_json::Value =
                serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            assert_eq!(value["products"], json!([]));
            assert_eq!(value["period"], period);
            assert_eq!(value["timezone"], "UTC");
            assert_eq!(value["metric"], "completed_order_units");
            assert_eq!(value["ranked_limit"], 50);
            assert!(value["start"].as_str().unwrap() <= value["end"].as_str().unwrap());
        }
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn discount_recommendations_verify_live_rules_and_shopper_scope(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    use domain_pricing_promotions::recommendations::rank;
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            domain_catalog::CategoryInput {
                name: "Offers".into(),
                slug: "offers".into(),
                parent_id: None,
            },
        )
        .await
        .unwrap();
    for (sku, price) in [("offer-tea", "10"), ("offer-coffee", "20")] {
        catalog.save_product(None,serde_json::from_value(json!({"sku":sku,"slug":sku,"name":sku,"description":sku,"price":price,"currency":"USD","unit":"pack","category_id":category.id,"attributes":{},"media_ids":[],"active":true,"in_stock":true})).unwrap()).await.unwrap();
    }
    let rule = Uuid::new_v4();
    sqlx::query("INSERT INTO pricing_promotions.rules(id,name,scope,kind,value,min_subtotal,skus,category_ids,customer_group,priority,active) VALUES($1,'Offer','catalog','fixed',2,0,'{}','{}','all',1,true)").bind(rule).execute(&pool).await.unwrap();
    let offers = rank(&pool, None).await.unwrap();
    assert_eq!(offers.len(), 2);
    assert_eq!(offers[0].discount_percent, rust_decimal::Decimal::from(20));
    assert_eq!(offers[0].discounted_price, rust_decimal::Decimal::from(8));
    for update in [
        "active=false",
        "active=true,ends_at=now()-interval '1 minute'",
        "ends_at=NULL,starts_at=now()+interval '1 day'",
        "starts_at=NULL,customer_group='registered'",
        "customer_group='all',min_subtotal=100",
        "min_subtotal=0,scope='cart'",
    ] {
        sqlx::query(&format!(
            "UPDATE pricing_promotions.rules SET {update} WHERE id=$1"
        ))
        .bind(rule)
        .execute(&pool)
        .await
        .unwrap();
        assert!(rank(&pool, None).await.unwrap().is_empty(), "{update}");
    }
    sqlx::query("UPDATE pricing_promotions.rules SET scope='catalog' WHERE id=$1")
        .bind(rule)
        .execute(&pool)
        .await
        .unwrap();
    // Unverifiable attribute conditions must not produce an offer.
    sqlx::query("INSERT INTO pricing_promotions.attribute_conditions(rule_id,conditions) VALUES($1,'{\"unknown_attribute\":\"yes\"}')").bind(rule).execute(&pool).await.unwrap();
    assert!(rank(&pool, None).await.unwrap().is_empty());
    sqlx::query("DELETE FROM pricing_promotions.attribute_conditions WHERE rule_id=$1")
        .bind(rule)
        .execute(&pool)
        .await
        .unwrap();
    let identity = identity(pool.clone()).await;
    let a = app(identity.clone(), Uuid::new_v4());
    let router = assistant::router(identity, Some(a.clone()));
    let now = chrono::Utc::now().timestamp();
    for (scope, expected) in [("shopper_read", 200), ("order_status", 403)] {
        let claims = assistant::Claims {
            iss: "commerce-assistant".into(),
            aud: "assistant-tools".into(),
            tenant: a.tenant,
            sub: None,
            sid: None,
            request_id: Uuid::new_v4(),
            iat: now,
            exp: now + 45,
            scope: scope.into(),
        };
        let response = router
            .clone()
            .oneshot(
                Request::post("/v1/assistant-tools/shopper")
                    .header(
                        "authorization",
                        format!("Bearer {}", a.sign(&claims).unwrap()),
                    )
                    .header("content-type", "application/json")
                    .header("x-commerce-request", "1")
                    .body(Body::from(
                        json!({"name":"get_discount_recommendations","arguments":{}}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), expected);
        if expected == 200 {
            let value: serde_json::Value =
                serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            assert_eq!(value["offers"].as_array().unwrap().len(), 2);
            assert_eq!(value["metric"], "catalog_discount_percent");
            assert!(value["candidate_limit"].is_null());
            assert_eq!(value["scope"], "all_eligible_catalog_products");
        }
    }
    let carts: i64 = sqlx::query_scalar("SELECT count(*) FROM cart_checkout.carts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(carts, 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn discounts_scan_all_pages_and_project_bounded_catalog_batches(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    use domain_pricing_promotions::recommendations::rank;
    let category = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO catalog.categories(id,name,slug) VALUES($1,'Discount pages','discount-pages')",
    )
    .bind(category)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'page-'||n,'page-'||n,'Product '||n,'Page test',CASE WHEN n=205 THEN 2 ELSE 10 END,'USD','each',$1 FROM generate_series(1,205) n").bind(category).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO pricing_promotions.rules(id,name,scope,kind,value,min_subtotal,skus,category_ids,customer_group,priority,active) VALUES($1,'All catalog','catalog','fixed',1,0,'{}','{}','all',1,true)").bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    let offers = rank(&pool, None).await.unwrap();
    assert_eq!(offers.len(), 205);
    assert_eq!(
        offers[0].product_id,
        Uuid::parse_str("00000000-0000-0000-0000-000000000205").unwrap()
    );
    assert_eq!(offers[0].discount_percent, rust_decimal::Decimal::from(50));
    let identity = identity(pool.clone()).await;
    let a = app(identity.clone(), Uuid::new_v4());
    let router = assistant::router(identity, Some(a.clone()));
    let now = chrono::Utc::now().timestamp();
    let claims = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "assistant-tools".into(),
        tenant: a.tenant,
        sub: None,
        sid: None,
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: "shopper_read".into(),
    };
    let response = router
        .oneshot(
            Request::post("/v1/assistant-tools/shopper")
                .header(
                    "authorization",
                    format!("Bearer {}", a.sign(&claims).unwrap()),
                )
                .header("content-type", "application/json")
                .header("x-commerce-request", "1")
                .body(Body::from(
                    json!({"name":"get_discount_recommendations","arguments":{}}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let value: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(value["offers"].as_array().unwrap().len(), 8);
    assert_eq!(
        value["offers"][0]["offer"]["product_id"],
        offers[0].product_id.to_string()
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn demo_discounts_seed_is_repeat_safe_and_preserves_base_prices(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let category = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO catalog.categories(id,name,slug) VALUES($1,'Demo discounts','demo-discounts')",
    )
    .bind(category)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) SELECT gen_random_uuid(),'DEMO-GRO-TEST-'||n,'discount-demo-'||n,'Demo '||n,'Demo test',10,'USD','each',$1 FROM generate_series(1,5) n").bind(category).execute(&pool).await.unwrap();
    let seed = include_str!("../../../../../commerce-assets/demo/seed-discounts.sql");
    for _ in 0..2 {
        sqlx::raw_sql(seed).execute(&pool).await.unwrap();
    }
    let offers = domain_pricing_promotions::recommendations::rank(&pool, None)
        .await
        .unwrap();
    assert_eq!(offers.len(), 5);
    assert_eq!(offers[0].discount_percent, rust_decimal::Decimal::from(30));
    assert!(offers
        .iter()
        .all(|o| o.original_price == rust_decimal::Decimal::from(10)));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM pricing_promotions.rules")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 5);
}

#[sqlx::test(migrations = "../../migrations")]
async fn exact_product_references_bypass_search_ranking_and_preserve_duplicate_names(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            domain_catalog::CategoryInput {
                name: "References".into(),
                slug: "references".into(),
                parent_id: None,
            },
        )
        .await
        .unwrap();
    let mut ids = Vec::new();
    for sku in ["FRUIT-001", "FRUIT-002"] {
        let p = catalog.save_product(None,serde_json::from_value(json!({"sku":sku,"slug":sku.to_lowercase(),"name":"Gala Apples 1kg","description":"Reference","price":"2","currency":"USD","unit":"pack","category_id":category.id,"attributes":{},"media_ids":[],"active":true,"in_stock":true})).unwrap()).await.unwrap();
        ids.push(p.id);
    }
    struct NoSearch;
    impl domain_search_client::SearchProvider for NoSearch {
        async fn search(
            &self,
            _: domain_search_client::Search,
        ) -> Result<domain_search_client::Results, Error> {
            panic!("Exact catalog identities must not depend on the search index")
        }
    }
    let a = app(identity(pool.clone()).await, Uuid::new_v4());
    let delivery = a.identity.cart.inventory.delivery(None).await.unwrap();
    for (query, count) in [
        ("fruit-001", 1),
        ("Gala Apples 1kg", 2),
        (" gala   apples 1kg ", 2),
    ] {
        let products = api_gateway::assistant_catalog::search_products(
            &a,
            api_gateway::assistant_catalog::SearchArgs {
                currency: None,
                predicates: vec![],
                exclusive_max: false,
                in_stock: false,
                excluded_product_ids: vec![],
                query: query.into(),
                category_id: None,
                min_price: None,
                max_price: None,
                exclusive_min: false,
                attributes: Default::default(),
            },
            &delivery,
            &NoSearch,
        )
        .await
        .unwrap();
        assert_eq!(products.len(), count);
        assert!(products.iter().all(|p| !p.sku.is_empty()));
        if count == 1 {
            assert_eq!(products[0].id, ids[0]);
        }
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn assistant_category_names_browse_products_and_enforce_membership(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let bakery = catalog
        .save_category(
            None,
            domain_catalog::CategoryInput {
                name: "Bakery".into(),
                slug: "bakery".into(),
                parent_id: None,
            },
        )
        .await
        .unwrap();
    let other = catalog
        .save_category(
            None,
            domain_catalog::CategoryInput {
                name: "Dairy".into(),
                slug: "dairy".into(),
                parent_id: None,
            },
        )
        .await
        .unwrap();
    let mut records = Vec::new();
    for (sku, name, category) in [
        ("bread", "White Bread", other.id),
        ("milk", "Milk", other.id),
    ] {
        records.push(catalog.save_product(None, serde_json::from_value(json!({"sku":sku,"slug":sku,"name":name,"description":"Demo","price":"2","currency":"USD","unit":"pack","category_id":category,"attributes":{},"media_ids":[],"active":true,"in_stock":true})).unwrap()).await.unwrap());
    }
    sqlx::query("UPDATE catalog.products SET category_ids=ARRAY[category_id,$2] WHERE id=$1")
        .bind(records[0].id)
        .bind(bakery.id)
        .execute(&pool)
        .await
        .unwrap();
    struct CategorySearch {
        category: Uuid,
        products: Vec<domain_catalog::Product>,
    }
    impl domain_search_client::SearchProvider for CategorySearch {
        async fn search(
            &self,
            args: domain_search_client::Search,
        ) -> Result<domain_search_client::Results, Error> {
            assert_eq!(args.q.as_deref(), Some(""));
            assert_eq!(args.category_id, Some(self.category));
            assert_eq!(args.max_price.as_deref(), Some("5"));
            // An unrelated stale search hit must not leak into category results.
            Ok(domain_search_client::Results {
                hits: self.products.clone(),
                total: 2,
                offset: 0,
                limit: 20,
                facets: Default::default(),
            })
        }
    }
    let a = app(identity(pool.clone()).await, Uuid::new_v4());
    let delivery = a.identity.cart.inventory.delivery(None).await.unwrap();
    let search = CategorySearch {
        category: bakery.id,
        products: records.clone(),
    };
    for query in ["Bakery", " bakery ", "BAKERY"] {
        let products = api_gateway::assistant_catalog::search_products(
            &a,
            api_gateway::assistant_catalog::SearchArgs {
                currency: None,
                predicates: vec![],
                exclusive_max: false,
                in_stock: false,
                excluded_product_ids: vec![],
                query: query.into(),
                category_id: None,
                min_price: None,
                max_price: Some("5".into()),
                exclusive_min: false,
                attributes: Default::default(),
            },
            &delivery,
            &search,
        )
        .await
        .unwrap();
        assert_eq!(products.len(), 1);
        assert_eq!(products[0].id, records[0].id);
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn discovery_batches_expanded_variants_and_records_all_eight_ranks(pool: PgPool) {
    let _tool_admission = TOOL_ADMISSION_TESTS.read().await;
    use domain_search_client::discovery as d;
    let a = app(identity(pool.clone()).await, Uuid::new_v4());
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            domain_catalog::CategoryInput {
                name: "Expanded variants".into(),
                slug: "expanded-variants".into(),
                parent_id: None,
            },
        )
        .await
        .unwrap();
    let mut parents = Vec::new();
    let mut stocked = Vec::new();
    for family in 0..2 {
        let parent = catalog.save_product(None, serde_json::from_value(json!({
            "sku":format!("EXPAND-{family}"),"slug":format!("expand-{family}"),"name":"Variant family",
            "description":"","price":"10","currency":"USD","unit":"each","category_id":category.id,
            "attributes":{},"media_ids":[],"active":true,"in_stock":true
        })).unwrap()).await.unwrap();
        for position in 0..21 {
            let child = catalog.save_product(None, serde_json::from_value(json!({
                "sku":format!("EXPAND-{family}-{position}"),"slug":format!("expand-{family}-{position}"),
                "name":format!("Variant {family} {position}"),"description":"","price":"10","currency":"USD",
                "unit":"each","category_id":category.id,"attributes":{},"media_ids":[],"active":true,"in_stock":true
            })).unwrap()).await.unwrap();
            sqlx::query("UPDATE catalog.products SET parent_id=$2 WHERE id=$1")
                .bind(child.id)
                .bind(parent.id)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO catalog.product_links(parent_id,child_id,position) VALUES($1,$2,$3)",
            )
            .bind(parent.id)
            .bind(child.id)
            .bind(position)
            .execute(&pool)
            .await
            .unwrap();
            // Only the second stock batch has available products.
            if family == 1 {
                a.identity
                    .cart
                    .inventory
                    .adjust(
                        child.id,
                        10,
                        Uuid::nil(),
                        "Variant regression fixture".into(),
                    )
                    .await
                    .unwrap();
                stocked.push(child.id);
            }
        }
        sqlx::query("UPDATE catalog.products SET product_type='configurable' WHERE id=$1")
            .bind(parent.id)
            .execute(&pool)
            .await
            .unwrap();
        parents.push(parent);
    }
    struct Search(Vec<domain_catalog::Product>);
    impl domain_search_client::SearchProvider for Search {
        async fn search(
            &self,
            query: domain_search_client::Search,
        ) -> Result<domain_search_client::Results, Error> {
            assert_eq!(query.q.as_deref(), Some(""));
            Ok(domain_search_client::Results {
                hits: self.0.clone(),
                total: 2,
                offset: 0,
                limit: 20,
                facets: Default::default(),
            })
        }
    }
    sqlx::query("UPDATE catalog.discovery_configuration SET enabled=true")
        .execute(&pool)
        .await
        .unwrap();
    let delivery = a.identity.cart.inventory.delivery(None).await.unwrap();
    let (products, report) = api_gateway::assistant_catalog::search_with_ranker(
        &a,
        api_gateway::assistant_catalog::SearchArgs {
            currency: None,
            predicates: vec![],
            exclusive_max: false,
            in_stock: false,
            excluded_product_ids: vec![],
            query: "*".into(),
            category_id: None,
            min_price: None,
            max_price: None,
            exclusive_min: false,
            attributes: Default::default(),
        },
        &delivery,
        &Search(parents),
        &d::DeterministicRanker,
    )
    .await
    .unwrap();
    let report = report.unwrap();
    assert_eq!(report.evaluated, 40, "variant expansion stays bounded");
    assert_eq!(report.returned, 8);
    assert_eq!(products.len(), 8);
    assert!(products.iter().any(|p| stocked.contains(&p.id)));
    assert!(products
        .iter()
        .all(|p| p.in_stock == Some(stocked.contains(&p.id))));
    assert_eq!(
        products
            .iter()
            .map(|p| p.discovery.as_ref().unwrap().rank)
            .collect::<Vec<_>>(),
        (1..=8).collect::<Vec<_>>()
    );
    let ranks: Vec<i32> =
        sqlx::query_scalar("SELECT rank FROM catalog.discovery_rank_observations ORDER BY rank")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(ranks, (1..=8).collect::<Vec<_>>());
    assert!(
        sqlx::query("UPDATE catalog.discovery_rank_observations SET rank=9")
            .execute(&pool)
            .await
            .is_err()
    );
    let body = json!({"products":products,"category":null,"discovery":report});
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &body,
        &contract["components"]["schemas"]["ShopperCatalogResult"],
        &contract,
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn scoped_catalog_profile_uses_all_validated_skus_and_retains_hard_predicates(pool: PgPool) {
    use api_gateway::assistant_catalog::{catalog_profile::scoped_profile, SearchArgs};
    let a = app(identity(pool.clone()).await, Uuid::new_v4());
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let attributes = domain_attributes::Service { pool: pool.clone() };
    let mut definition: domain_attributes::Definition = serde_json::from_value(json!({
        "id":Uuid::new_v4(),"entity_type":"product","attribute_code":"finish","label":"Finish",
        "input_type":"single_select","scope":"global","is_required":false,"is_unique":false,
        "is_searchable":true,"is_filterable":true,"is_comparable":true,"is_visible_on_front":true,
        "used_for_promo_rules":false,"used_for_configurations":false,"swatch_type":"none",
        "options":[{"value":"matte","label":"Matte"},{"value":"gloss","label":"Gloss"}],
        "version":0,"metadata":{"ai_queryable":true,"description":"Merchant finish"}
    }))
    .unwrap();
    definition.metadata.facetable = true;
    let definition = attributes.save(definition).await.unwrap();
    let mut capacity = definition.clone();
    capacity.id = Uuid::new_v4();
    capacity.attribute_code = "capacity".into();
    capacity.label = "Capacity".into();
    capacity.input_type = "integer".into();
    capacity.options = json!([]);
    capacity.version = 0;
    capacity.metadata.description = "Observed capacity".into();
    capacity.metadata.unit = Some("GB".into());
    attributes.save(capacity).await.unwrap();
    let mut optional_values = serde_json::Map::new();
    for index in 0..21 {
        let mut optional = definition.clone();
        optional.id = Uuid::new_v4();
        optional.version = 0;
        optional.attribute_code = format!("auxiliary_{index}");
        optional.label = format!("A Optional {index}");
        optional.input_type = "integer".into();
        optional.options = json!([]);
        attributes.save(optional).await.unwrap();
        optional_values.insert(format!("auxiliary_{index}"), json!(1));
    }
    let category = catalog
        .save_category(
            None,
            serde_json::from_value(json!({"name":"Devices","slug":"devices","parent_id":null}))
                .unwrap(),
        )
        .await
        .unwrap();
    let child_category = catalog
        .save_category(
            None,
            serde_json::from_value(
                json!({"name":"Wearables","slug":"wearables","parent_id":category.id}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let unrelated = catalog
        .save_category(
            None,
            serde_json::from_value(json!({"name":"Other","slug":"other","parent_id":null}))
                .unwrap(),
        )
        .await
        .unwrap();
    let mut ids = Vec::new();
    for index in 0..14 {
        let mut values = optional_values.clone();
        values.insert(
            "finish".into(),
            json!(if index % 2 == 0 { "matte" } else { "gloss" }),
        );
        values.insert("capacity".into(), json!(index * 64));
        let p = catalog.save_product(None, serde_json::from_value(json!({
            "sku":format!("PROFILE-{index}"),"slug":format!("profile-{index}"),"name":format!("Device {index}"),
            "description":"","price":if index==13 {"500"} else {"100"},"currency":if index==13 {"EGP"} else {"USD"},"unit":"each",
            "category_id":if index==12 {unrelated.id} else {child_category.id},
            "attributes":values,
            "media_ids":[],"active":true,"in_stock":true
        })).unwrap()).await.unwrap();
        a.identity
            .cart
            .inventory
            .adjust(p.id, 10, Uuid::nil(), "Profile fixture".into())
            .await
            .unwrap();
        ids.push(p.id);
    }
    // Primary and additional memberships both prove descendant category scope.
    sqlx::query("UPDATE catalog.products SET category_id=$2,category_ids=$3 WHERE id=$1")
        .bind(ids[3])
        .bind(unrelated.id)
        .bind(vec![unrelated.id, child_category.id])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE catalog.products SET product_type='configurable' WHERE id=$1")
        .bind(ids[11])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE attributes.value_provenance SET source='AI_INFERRED',confidence=0.9 WHERE product_id=$1 AND definition_id=$2").bind(ids[1]).bind(definition.id).execute(&pool).await.unwrap();
    let defs = attributes.list("product").await.unwrap();
    let delivery = a.identity.cart.inventory.delivery(None).await.unwrap();
    let mut args = SearchArgs {
        currency: None,
        predicates: vec![],
        query: "*".into(),
        category_id: Some(category.id),
        min_price: None,
        max_price: None,
        exclusive_min: false,
        exclusive_max: false,
        in_stock: false,
        excluded_product_ids: vec![],
        attributes: Default::default(),
    };
    let profile = scoped_profile(&a, &args, &delivery, &defs)
        .await
        .unwrap()
        .unwrap();
    assert!(profile.complete);
    assert_eq!(
        profile.matched_count, 12,
        "descendants count simple SKU rows beyond eight cards"
    );
    let facet = profile.facets.iter().find(|f| f.code == "finish").unwrap();
    assert_eq!(
        facet.covered_count, 11,
        "inferred values never become factual clarification choices"
    );
    assert_eq!(facet.values.iter().map(|v| v.count).sum::<usize>(), 11);
    args.currency = Some("USD".into());
    let dollars = scoped_profile(&a, &args, &delivery, &defs)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        dollars.matched_count, 11,
        "currency is part of eligible scope before statistics and browse seeding"
    );
    assert_eq!(dollars.prices.len(), 1);
    assert_eq!(dollars.prices[0].currency, "USD");
    assert!(!dollars.eligible_product_ids.contains(&ids[13]));
    args.currency = Some("EGP".into());
    assert_eq!(
        scoped_profile(&a, &args, &delivery, &defs)
            .await
            .unwrap()
            .unwrap()
            .matched_count,
        1
    );
    args.currency = None;
    let schema = attributes.catalog_schema(true).await.unwrap();
    assert_eq!(profile.revision, schema.version);
    let descriptor = schema
        .categories
        .iter()
        .find(|c| c.id == category.id)
        .unwrap();
    assert_eq!(descriptor.sellable_count, 12);
    assert!(descriptor.aliases.contains(&"devices".to_string()));
    assert_eq!(
        schema
            .attributes
            .iter()
            .find(|d| d.code == "finish")
            .unwrap()
            .description,
        "Merchant finish"
    );
    args.max_price = Some("500".into());
    args.exclusive_max = true;
    args.excluded_product_ids = vec![ids[0]];
    args.attributes.insert("finish".into(), json!("matte"));
    args.in_stock = true;
    let constrained = scoped_profile(&a, &args, &delivery, &defs)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(constrained.matched_count, 5);
    assert_eq!(
        constrained.revision, profile.revision,
        "filter refinements must not expire their own pending choice"
    );
    assert!(constrained
        .eligible_product_ids
        .iter()
        .all(|id| ![ids[0], ids[12], ids[13]].contains(id)));
    assert_eq!(
        constrained.prices[0]
            .max
            .parse::<sqlx::types::Decimal>()
            .unwrap(),
        sqlx::types::Decimal::from(100)
    );
    args.predicates = vec![domain_attributes::schema::SearchPredicate {
        name: "capacity".into(),
        operator: "gte".into(),
        value: json!(300),
    }];
    let numeric = scoped_profile(&a, &args, &delivery, &defs)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        numeric.matched_count, 3,
        "typed numeric ranges remain hard predicates in scoped statistics"
    );
    args.attributes.clear();
    args.predicates = vec![domain_attributes::schema::SearchPredicate {
        name: "finish".into(),
        operator: "neq".into(),
        value: json!("matte"),
    }];
    let negative = scoped_profile(&a, &args, &delivery, &defs)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        negative.matched_count, 4,
        "inferred values cannot prove a negative requirement"
    );
    struct AllProducts(Vec<domain_catalog::Product>);
    impl domain_search_client::SearchProvider for AllProducts {
        async fn search(
            &self,
            _: domain_search_client::Search,
        ) -> Result<domain_search_client::Results, Error> {
            Ok(domain_search_client::Results {
                hits: self.0.clone(),
                total: self.0.len() as u64,
                offset: 0,
                limit: 20,
                facets: Default::default(),
            })
        }
    }
    let found: Vec<domain_catalog::Product> =
        sqlx::query_as("SELECT * FROM catalog.products ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    let displayed = api_gateway::assistant_catalog::search_products(
        &a,
        SearchArgs {
            currency: Some("USD".into()),
            query: "*".into(),
            category_id: Some(category.id),
            min_price: None,
            max_price: None,
            exclusive_min: false,
            exclusive_max: false,
            in_stock: true,
            excluded_product_ids: vec![ids[0]],
            attributes: Default::default(),
            predicates: args.predicates.clone(),
        },
        &delivery,
        &AllProducts(found),
    )
    .await
    .unwrap();
    assert_eq!(
        displayed.len(),
        4,
        "normal final SKU validation applies the same negative predicates"
    );
    let secondary = displayed.iter().find(|p| p.id == ids[3]).unwrap();
    assert_eq!(secondary.category_id, unrelated.id);
    assert!(secondary.category_ids.contains(&child_category.id));
    assert!(
        displayed.iter().all(|product| product
            .attributes
            .iter()
            .any(|attribute| attribute.name == "finish")),
        "hard-match evidence outranks twenty optional projection fields"
    );
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &json!({"products":[],"category":null,"catalog_profile":negative}),
        &contract["components"]["schemas"]["ShopperCatalogResult"],
        &contract,
    );
    args.query = "matte watch".into();
    assert!(
        scoped_profile(&a, &args, &delivery, &defs)
            .await
            .unwrap()
            .is_none(),
        "lexical residuals must not receive broader category statistics"
    );
    sqlx::query("UPDATE catalog.products SET price=101,updated_at=clock_timestamp() WHERE id=$1")
        .bind(ids[2])
        .execute(&pool)
        .await
        .unwrap();
    let changed = attributes.catalog_schema(true).await.unwrap();
    assert_ne!(
        changed.version, schema.version,
        "product edits invalidate pending choices"
    );
    catalog
        .save_category(
            Some(category.id),
            serde_json::from_value(
                json!({"name":"Connected devices","slug":"connected-devices","parent_id":null}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    assert_ne!(
        attributes.catalog_schema(true).await.unwrap().version,
        changed.version,
        "category edits invalidate descriptors"
    );
}
