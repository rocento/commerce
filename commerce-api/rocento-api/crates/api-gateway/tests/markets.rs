use api_gateway::identity;
use axum::{body::Body, http::Request, Router};
use http_body_util::BodyExt;
use infra_auth::Security;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

async fn fixture(pool: &PgPool) -> (Router, Uuid) {
    let security = Security::new(
        "languages-test-secret-".repeat(3),
        "http://localhost:5174".into(),
        false,
    )
    .await
    .unwrap();
    let role = Uuid::new_v4();
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'translator',ARRAY['markets.read','markets.write','catalog.read','catalog.write','cms.read','cms.write'])").bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'translator@test.local','Translator','!',$2)").bind(user).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest("translation-test")).bind(user).execute(pool).await.unwrap();
    (
        router(identity::App::new(
            pool.clone(),
            security,
            vec!["http://localhost:5174".into()],
        )),
        role,
    )
}
async fn request(
    app: &Router,
    method: &str,
    path: &str,
    body: Option<Value>,
    session: bool,
    csrf: bool,
) -> (u16, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if session {
        req = req.header("cookie", "admin_session=translation-test");
    }
    if csrf {
        req = req.header("x-commerce-request", "1");
    }
    let response = app
        .clone()
        .oneshot(
            req.body(Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
fn router(app: identity::App) -> Router {
    api_gateway::cart::router(app)
}
fn market(id: Uuid) -> Value {
    json!({"id":id,"name":"Egypt","country":"EG","currency":"EGP","locales":["en"],"default_locale":"en","expected_revision":0})
}
#[sqlx::test(migrations = "../../migrations")]
async fn drafts_permissions_conflicts_and_checkout_isolation(pool: PgPool) {
    let (app, role) = fixture(&pool).await;
    let id = Uuid::new_v4();
    assert_eq!(
        request(&app, "GET", "/v1/admin/markets", None, false, false)
            .await
            .0,
        401
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/v1/admin/markets",
            Some(market(id)),
            true,
            false
        )
        .await
        .0,
        403
    );
    let live: Value =
        sqlx::query_scalar("SELECT to_jsonb(m) FROM cart_checkout.market_configuration m")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        request(
            &app,
            "POST",
            "/v1/admin/markets",
            Some(market(id)),
            true,
            true
        )
        .await
        .0,
        200
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/v1/admin/markets",
            Some(market(id)),
            true,
            true
        )
        .await
        .0,
        409
    );
    let mut update = market(id);
    update["expected_revision"] = json!(1);
    update["locales"] = json!(["xx"]);
    update["default_locale"] = json!("xx");
    assert_eq!(
        request(&app, "POST", "/v1/admin/markets", Some(update), true, true)
            .await
            .0,
        400
    );
    let (_, list) = request(&app, "GET", "/v1/admin/markets", None, true, false).await;
    assert_eq!(list["source_locale"], "en");
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    assert_eq!(list["activation_available"], true);
    let after: Value =
        sqlx::query_scalar("SELECT to_jsonb(m) FROM cart_checkout.market_configuration m")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(live, after);
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['markets.read'] WHERE id=$1")
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            "POST",
            "/v1/admin/markets",
            Some(market(Uuid::new_v4())),
            true,
            true
        )
        .await
        .0,
        403
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn exact_price_overrides_inheritance_and_currency_guard(pool: PgPool) {
    let (app, role) = fixture(&pool).await;
    let id = Uuid::new_v4();
    let product = Uuid::new_v4();
    sqlx::query("INSERT INTO catalog.categories(id,name,slug) VALUES($1,'Product category','product-category')").bind(product).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,active) VALUES($1,'market-test','market-test','Market test','',10,'USD','each',$1,true)").bind(product).execute(&pool).await.unwrap();
    assert_eq!(
        request(
            &app,
            "POST",
            "/v1/admin/markets",
            Some(market(id)),
            true,
            true
        )
        .await
        .0,
        200
    );
    let path = format!("/v1/admin/markets/{id}/product/{product}");
    let (_, initial) = request(&app, "GET", &path, None, true, false).await;
    assert_eq!(initial["override"]["revision"], 0);
    assert_eq!(initial["source"]["currency"], "USD");
    let input = json!({"available":false,"price":"100.25","currency":"EGP","expected_revision":0});
    assert_eq!(
        request(&app, "PUT", &path, Some(input.clone()), true, true)
            .await
            .0,
        200
    );
    assert_eq!(
        request(&app, "PUT", &path, Some(input), true, true).await.0,
        409
    );
    let (_, loaded) = request(&app, "GET", &path, None, true, false).await;
    assert_eq!(loaded["override"]["price"], "100.25");
    assert_eq!(loaded["override"]["available"], false);
    let mut update = market(id);
    update["expected_revision"] = json!(1);
    update["currency"] = json!("SAR");
    assert_eq!(
        request(
            &app,
            "POST",
            "/v1/admin/markets",
            Some(update.clone()),
            true,
            true
        )
        .await
        .0,
        400
    );
    assert_eq!(
        request(
            &app,
            "PUT",
            &path,
            Some(json!({"available":null,"price":null,"currency":"EGP","expected_revision":1})),
            true,
            true
        )
        .await
        .0,
        200
    );
    assert_eq!(
        request(&app, "POST", "/v1/admin/markets", Some(update), true, true)
            .await
            .0,
        200
    );
    assert_eq!(
        request(
            &app,
            "PUT",
            &path,
            Some(json!({"available":true,"price":"100","currency":"EGP","expected_revision":2})),
            true,
            true
        )
        .await
        .0,
        409
    );
    let source:Value=sqlx::query_scalar("SELECT jsonb_build_object('active',active,'price',price::text,'currency',currency) FROM catalog.products WHERE id=$1").bind(product).fetch_one(&pool).await.unwrap();
    assert_eq!(
        source,
        json!({"active":true,"price":"10.00","currency":"USD"})
    );
    sqlx::query(
        "UPDATE admin_iam.roles SET permissions=ARRAY['markets.read','markets.write'] WHERE id=$1",
    )
    .bind(role)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(request(&app, "GET", &path, None, true, false).await.0, 403);
    assert_eq!(
        request(
            &app,
            "PUT",
            &path,
            Some(json!({"available":true,"price":"1","currency":"SAR","expected_revision":2})),
            true,
            true
        )
        .await
        .0,
        403
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn categories_navigation_and_invalid_entities(pool: PgPool) {
    let (app, _) = fixture(&pool).await;
    let id = Uuid::new_v4();
    let category = Uuid::new_v4();
    let menu = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO catalog.categories(id,name,slug) VALUES($1,'Category','market-category')",
    )
    .bind(category)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO cms.documents(id,kind,key) VALUES($1,'navigation','navigation')")
        .bind(menu)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            "POST",
            "/v1/admin/markets",
            Some(market(id)),
            true,
            true
        )
        .await
        .0,
        200
    );
    for (kind, entity) in [("category", category), ("navigation", menu)] {
        let path = format!("/v1/admin/markets/{id}/{kind}/{entity}");
        assert_eq!(
            request(
                &app,
                "PUT",
                &path,
                Some(json!({"available":false,"price":"1","currency":"EGP","expected_revision":0})),
                true,
                true
            )
            .await
            .0,
            400
        );
        assert_eq!(
            request(
                &app,
                "PUT",
                &path,
                Some(
                    json!({"available":false,"price":null,"currency":"EGP","expected_revision":0})
                ),
                true,
                true
            )
            .await
            .0,
            200
        );
        assert_eq!(
            request(&app, "GET", &path, None, true, false).await.1["override"]["available"],
            false
        );
    }
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/v1/admin/markets/{id}/product/{}", Uuid::new_v4()),
            None,
            true,
            false
        )
        .await
        .0,
        404
    );
}

async fn egypt_checkout(pool: &PgPool) -> (identity::App, Uuid, Uuid, domain_catalog::Product) {
    sqlx::query("UPDATE cart_checkout.market_configuration SET currency='EGP',region='EG'")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE fulfillment.delivery_fee_settings SET currency='EGP',amount=3")
        .execute(pool)
        .await
        .unwrap();
    let security = Security::new(
        "market-checkout-secret-".repeat(3),
        "http://localhost:5174".into(),
        false,
    )
    .await
    .unwrap();
    let app = identity::App::new(pool.clone(), security, vec!["http://localhost:5174".into()]);
    let customer = app
        .customers
        .register(domain_customers::Credentials {
            identifier: "market-buyer@test.local".into(),
            password: "Market test password!".into(),
        })
        .await
        .unwrap();
    sqlx::query("UPDATE customers.customers SET verified=true WHERE id=$1")
        .bind(customer.id)
        .execute(pool)
        .await
        .unwrap();
    let location=app.customers.save_location(customer.id,None,serde_json::from_value(json!({"label":"home","latitude":30.0,"longitude":31.0,"formatted_address":"Synthetic Egypt address"})).unwrap()).await.unwrap();
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            serde_json::from_value(
                json!({"name":"Egypt fruit","slug":"egypt-fruit","parent_id":null}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let product=catalog.save_product(None,serde_json::from_value(json!({"sku":"EG-APPLE","slug":"eg-apple","name":"Egypt apples","description":"","price":"10.00","currency":"EGP","unit":"each","category_id":category.id,"attributes":{},"media_ids":[],"active":true,"in_stock":true})).unwrap()).await.unwrap();
    app.cart
        .inventory
        .adjust(product.id, 100, Uuid::new_v4(), "Test stock".into())
        .await
        .unwrap();
    app.cart.open(Some(customer.id), "").await.unwrap();
    app.cart
        .set(Some(customer.id), "", product.clone(), 2, true)
        .await
        .unwrap();
    (app, customer.id, location.id, product)
}
async fn publish_review(app: &Router, id: Uuid) -> (u16, Value) {
    let (status, review) = request(
        app,
        "GET",
        &format!("/v1/admin/markets/{id}/readiness"),
        None,
        true,
        false,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(review["ready"], true, "{review}");
    request(
        app,
        "POST",
        &format!("/v1/admin/markets/{id}/publish"),
        Some(json!({"token":review["token"],"reason":"Reviewed Egypt rollout"})),
        true,
        true,
    )
    .await
}
#[sqlx::test(migrations = "../../migrations")]
async fn egypt_publication_reprices_checkout_keeps_drafts_private_and_restores_defaults(
    pool: PgPool,
) {
    let (router, role) = fixture(&pool).await;
    let (app, customer, location, product) = egypt_checkout(&pool).await;
    let id = Uuid::new_v4();
    assert_eq!(
        request(
            &router,
            "POST",
            "/v1/admin/markets",
            Some(market(id)),
            true,
            true
        )
        .await
        .0,
        200
    );
    let override_path = format!("/v1/admin/markets/{id}/product/{}", product.id);
    assert_eq!(
        request(
            &router,
            "PUT",
            &override_path,
            Some(json!({"available":null,"price":"25.50","currency":"EGP","expected_revision":0})),
            true,
            true
        )
        .await
        .0,
        200
    );
    let before = app.cart.quote(customer, location).await.unwrap();
    assert_eq!(before.snapshot.subtotal.to_string(), "20.00");
    assert_eq!(publish_review(&router, id).await.0, 403);
    sqlx::query("UPDATE admin_iam.roles SET permissions=permissions||ARRAY['markets.publish','cms.publish'] WHERE id=$1").bind(role).execute(&pool).await.unwrap();
    let (status, published) = publish_review(&router, id).await;
    assert_eq!(status, 200, "{published}");
    assert!(app
        .cart
        .place(customer, before.id, Uuid::new_v4())
        .await
        .is_err());
    let cart = app.cart.open(Some(customer), "").await.unwrap().cart;
    assert_eq!(cart.market.id, Some(id));
    assert_eq!(cart.subtotal.to_string(), "51.00");
    use domain_cart_checkout::shopping::{Draft, Goal, Mode, Selection};
    let task = Uuid::new_v4();
    let context = app
        .cart
        .shopping_context(cart.id, Some(customer), task)
        .await
        .unwrap();
    let proposal = app
        .cart
        .propose(
            cart.id,
            Some(customer),
            Draft {
                task_id: task,
                task_revision: 0,
                source_revision: context["source_revision"].as_i64().unwrap(),
                mode: Mode::Shop,
                auto_select: false,
                goal: Goal::default(),
                location_id: Some(location),
                order_id: None,
                selections: vec![Selection {
                    product_id: product.id,
                    quantity: 1,
                    replaces: None,
                    min_price: None,
                    max_price: None,
                    exclusive_max: false,
                    exclusive_min: false,
                    required_attributes: Default::default(),
                    reason: "Market price check".into(),
                }],
            },
        )
        .await
        .unwrap();
    assert_eq!(proposal.before.subtotal, "51.00");
    assert_eq!(
        proposal.lines[0]
            .product
            .as_ref()
            .unwrap()
            .price
            .to_string(),
        "25.50"
    );
    let catalog = domain_catalog::Service { pool: pool.clone() };
    assert_eq!(
        catalog.product(product.id).await.unwrap().price.to_string(),
        "10.00"
    );
    assert_eq!(
        catalog
            .storefront_product(product.id)
            .await
            .unwrap()
            .price
            .to_string(),
        "25.50"
    );
    // Editing the draft does not change the published product or the current quote.
    assert_eq!(
        request(
            &router,
            "PUT",
            &override_path,
            Some(json!({"available":null,"price":"90.00","currency":"EGP","expected_revision":1})),
            true,
            true
        )
        .await
        .0,
        200
    );
    let quote = app.cart.quote(customer, location).await.unwrap();
    assert_eq!(quote.snapshot.subtotal.to_string(), "51.00");
    let order = app
        .cart
        .place(customer, quote.id, Uuid::new_v4())
        .await
        .unwrap();
    assert_eq!(order.order.total.to_string(), "54.00");
    assert_eq!(order.payment.currency, "EGP");
    assert_eq!(
        order.order.market_context.as_ref().unwrap()["id"],
        json!(id)
    );
    assert_eq!(
        order.order.market_context.as_ref().unwrap()["release_id"],
        published["release_id"]
    );
    let restore =
        json!({"expected_revision":published["revision"],"reason":"Rollback to store defaults"});
    assert_eq!(
        request(
            &router,
            "POST",
            "/v1/admin/markets/restore-defaults",
            Some(restore.clone()),
            true,
            true
        )
        .await
        .0,
        200
    );
    assert_eq!(
        request(
            &router,
            "POST",
            "/v1/admin/markets/restore-defaults",
            Some(restore),
            true,
            true
        )
        .await
        .0,
        409
    );
    assert_eq!(
        catalog
            .storefront_product(product.id)
            .await
            .unwrap()
            .price
            .to_string(),
        "10.00"
    );
    let historical: Value =
        sqlx::query_scalar("SELECT market_context FROM orders.orders WHERE id=$1")
            .bind(order.order.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(historical["release_id"], published["release_id"]);
}
#[sqlx::test(migrations = "../../migrations")]
async fn market_review_tokens_availability_and_inactive_cart_scope_fail_closed(pool: PgPool) {
    let (router, role) = fixture(&pool).await;
    let (app, customer, location, product) = egypt_checkout(&pool).await;
    let id = Uuid::new_v4();
    sqlx::query("UPDATE admin_iam.roles SET permissions=permissions||ARRAY['markets.publish','cms.publish'] WHERE id=$1").bind(role).execute(&pool).await.unwrap();
    request(
        &router,
        "POST",
        "/v1/admin/markets",
        Some(market(id)),
        true,
        true,
    )
    .await;
    let (_, review) = request(
        &router,
        "GET",
        &format!("/v1/admin/markets/{id}/readiness"),
        None,
        true,
        false,
    )
    .await;
    sqlx::query("UPDATE catalog.products SET price=12 WHERE id=$1")
        .bind(product.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(
            &router,
            "POST",
            &format!("/v1/admin/markets/{id}/publish"),
            Some(json!({"token":review["token"],"reason":"Stale review"})),
            true,
            true
        )
        .await
        .0,
        409
    );
    let cart = app.cart.open(Some(customer), "").await.unwrap().cart;
    sqlx::query("UPDATE cart_checkout.carts SET market_id=$2 WHERE id=$1")
        .bind(cart.id)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(app.cart.quote(customer, location).await.is_err());
    assert!(app
        .cart
        .set(Some(customer), "", product.clone(), 1, true)
        .await
        .is_err());
    sqlx::query("UPDATE cart_checkout.carts SET market_id=NULL WHERE id=$1")
        .bind(cart.id)
        .execute(&pool)
        .await
        .unwrap();
    let menu = Uuid::new_v4();
    sqlx::query("INSERT INTO cms.documents(id,kind,key) VALUES($1,'navigation','navigation')")
        .bind(menu)
        .execute(&pool)
        .await
        .unwrap();
    for (kind, entity) in [("category", product.category_id), ("navigation", menu)] {
        assert_eq!(
            request(
                &router,
                "PUT",
                &format!("/v1/admin/markets/{id}/{kind}/{entity}"),
                Some(
                    json!({"available":false,"price":null,"currency":"EGP","expected_revision":0})
                ),
                true,
                true
            )
            .await
            .0,
            200
        );
    }
    assert_eq!(publish_review(&router, id).await.0, 200);
    let categories = domain_catalog::Service { pool: pool.clone() }
        .storefront_categories()
        .await
        .unwrap();
    assert!(categories.iter().all(|c| c.id != product.category_id));
    let visible: bool = sqlx::query_scalar("SELECT cms.market_content_available($1)")
        .bind(menu)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!visible);
    let mut foreign = market(Uuid::new_v4());
    foreign["country"] = json!("SA");
    foreign["currency"] = json!("SAR");
    let foreign_id = foreign["id"].as_str().unwrap().to_owned();
    request(
        &router,
        "POST",
        "/v1/admin/markets",
        Some(foreign),
        true,
        true,
    )
    .await;
    let (_, blocked) = request(
        &router,
        "GET",
        &format!("/v1/admin/markets/{foreign_id}/readiness"),
        None,
        true,
        false,
    )
    .await;
    assert_eq!(blocked["ready"], false);
    assert_eq!(
        request(
            &router,
            "POST",
            &format!("/v1/admin/markets/{foreign_id}/publish"),
            Some(json!({"token":blocked["token"],"reason":"Must not launch unconfigured market"})),
            true,
            true
        )
        .await
        .0,
        400
    );
}
