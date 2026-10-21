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
async fn cart(f: &Fixture) -> domain_cart_checkout::Cart {
    f.app.cart.read_customer(f.customer).await.unwrap().unwrap()
}

async fn egp(f: &Fixture) {
    let pool = &f.app.customers.pool;
    sqlx::query("UPDATE cart_checkout.market_configuration SET enabled=true,currency='EGP'")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE fulfillment.delivery_fee_settings SET currency='EGP'")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE catalog.products SET currency='EGP',price=10.01")
        .execute(pool)
        .await
        .unwrap();
}
#[sqlx::test(migrations = "../../migrations")]
async fn egp_quote_tax_discount_snapshot_and_reorder(pool: PgPool) {
    let f = setup(pool.clone()).await;
    egp(&f).await;
    sqlx::query("INSERT INTO pricing_promotions.rules(id,name,scope,kind,value,min_subtotal,skus,category_ids,customer_group,priority,active) VALUES($1,'Test discount','catalog','percentage',10,0,'{}','{}','all',1,true)").bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO tax.rules(id,name,min_lat,max_lat,min_lon,max_lon,rate_bps,tax_delivery,priority,active) VALUES($1,'Test rate',29,31,30,32,1400,true,1,true)").bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    assert_eq!(quote.snapshot.currency, "EGP");
    assert_eq!(quote.snapshot.subtotal.to_string(), "20.02");
    assert_eq!(quote.snapshot.discount_amount.to_string(), "2.00");
    assert_eq!(quote.snapshot.tax_amount.to_string(), "2.94");
    assert_eq!(quote.snapshot.total.to_string(), "23.96");
    let placed = f
        .app
        .cart
        .place(f.customer, quote.id, Uuid::new_v4())
        .await
        .unwrap();
    assert_eq!(placed.payment.currency, "EGP");
    assert_eq!(
        placed.items[0].market_facts.as_ref().unwrap()["currency"],
        "EGP"
    );
    let mut d = draft(&f, Mode::BuyAgain).await;
    d.order_id = Some(placed.order.id);
    d.selections = vec![selection(f.a.id, 2, None)];
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d.clone())
        .await
        .unwrap();
    assert!(p.can_apply, "{:?}", p.issues);
    assert!(p
        .notes
        .iter()
        .any(|s| s.contains("immutable order snapshot")));
    sqlx::query(
        "UPDATE catalog.products SET variant_attributes='{\"size\":\"changed\"}' WHERE id=$1",
    )
    .bind(f.a.id)
    .execute(&pool)
    .await
    .unwrap();
    let mut next = draft(&f, Mode::BuyAgain).await;
    next.order_id = d.order_id;
    next.selections = d.selections;
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), next)
        .await
        .unwrap();
    assert!(!p.can_apply);
    assert!(p.issues.iter().any(|s| s.contains("historical options")));
}
fn weight() -> serde_json::Value {
    json!({"kind":"weight","measure_unit":"kg","measure_per_unit":"0.25","minimum":1,"maximum":40,"increment":1,"estimated_weight":null,"final_weight":null,"regulated":false})
}
#[sqlx::test(migrations = "../../migrations")]
async fn exact_measure_stale_pack_and_unsupported_weight(pool: PgPool) {
    let f = setup(pool.clone()).await;
    sqlx::query("UPDATE cart_checkout.market_configuration SET enabled=true")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE catalog.products SET unit='pack' WHERE id=$1")
        .bind(f.b.id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO cart_checkout.selling_rules(product_id,rule) VALUES($1,$2)")
        .bind(f.b.id)
        .bind(weight())
        .execute(&pool)
        .await
        .unwrap();
    let context = f
        .app
        .cart
        .shopping_context(f.cart, Some(f.customer), Uuid::new_v4())
        .await
        .unwrap();
    assert_eq!(context["market"]["enabled"], true);
    assert_eq!(
        context["selling_units"][0]["rule"]["measure_per_unit"],
        "0.25"
    );
    let c = f
        .app
        .cart
        .set_measure(Some(f.customer), "", f.b.id, "0.75")
        .await
        .unwrap();
    assert_eq!(
        c.items
            .iter()
            .find(|i| i.product_id == f.b.id)
            .unwrap()
            .quantity,
        3
    );
    assert!(f
        .app
        .cart
        .set_measure(Some(f.customer), "", f.b.id, "0.76")
        .await
        .is_err());
    let before = cart(&f).await.subtotal;
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    assert!(p.can_apply);
    sqlx::query("UPDATE cart_checkout.selling_rules SET rule=jsonb_set(rule,'{measure_per_unit}','\"0.5\"') WHERE product_id=$1").bind(f.b.id).execute(&pool).await.unwrap();
    assert!(f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, Uuid::new_v4())
        .await
        .is_err());
    assert_eq!(cart(&f).await.subtotal, before);
    sqlx::query("UPDATE cart_checkout.selling_rules SET rule=jsonb_set(rule,'{kind}','\"variable_weight\"') WHERE product_id=$1").bind(f.b.id).execute(&pool).await.unwrap();
    assert!(f
        .app
        .cart
        .set_measure(Some(f.customer), "", f.b.id, "1.0")
        .await
        .is_err());
    assert!(f.app.cart.quote(f.customer, f.location).await.is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn mismatched_currency_and_unqualified_egp_budget_never_apply(pool: PgPool) {
    let f = setup(pool.clone()).await;
    sqlx::query("UPDATE catalog.products SET currency='EGP' WHERE id=$1")
        .bind(f.b.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(f
        .app
        .cart
        .set(Some(f.customer), "", f.b.clone(), 1, true)
        .await
        .is_err());
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    assert!(!p.can_apply);
    assert_eq!(cart(&f).await.items.len(), 1);
    egp(&f).await;
    let mut d = draft(&f, Mode::Shop).await;
    d.goal.budget = Some("100.00".into());
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d)
        .await
        .unwrap();
    assert!(!p.can_apply);
    assert!(p.issues.iter().any(|s| s.contains("currency explicitly")));
    sqlx::query(
        "UPDATE catalog.products SET attributes='{\"requires_prescription\":true}' WHERE id=$1",
    )
    .bind(f.a.id)
    .execute(&pool)
    .await
    .unwrap();
    assert!(f
        .app
        .cart
        .set(Some(f.customer), "", f.a.clone(), 1, false)
        .await
        .is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn legacy_snapshot_and_dates_remain_honest(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let order = f
        .app
        .cart
        .place(f.customer, q.id, Uuid::new_v4())
        .await
        .unwrap();
    sqlx::query("UPDATE orders.order_items SET market_facts=NULL WHERE order_id=$1")
        .bind(order.order.id)
        .execute(&pool)
        .await
        .unwrap();
    let mut d = draft(&f, Mode::BuyAgain).await;
    d.order_id = Some(order.order.id);
    d.selections = vec![selection(f.a.id, 1, None)];
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d)
        .await
        .unwrap();
    assert!(p.notes.iter().any(|s| s.contains("Legacy order")));
    let mut d = draft(&f, Mode::Shop).await;
    d.goal.delivery_date = Some("tomorrow".into());
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d)
        .await
        .unwrap();
    assert!(!p.can_apply);
    assert!(!p.delivery_check.unwrap().available);
}
#[sqlx::test(migrations = "../../migrations")]
async fn different_pack_counts_require_equal_physical_amount_and_cheaper_total(pool: PgPool) {
    let f = setup(pool.clone()).await;
    sqlx::query("UPDATE cart_checkout.market_configuration SET enabled=true")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE catalog.products SET unit='pack'")
        .execute(&pool)
        .await
        .unwrap();
    for (id, amount) in [(f.a.id, "1"), (f.b.id, "0.5")] {
        let mut r = weight();
        r["measure_per_unit"] = json!(amount);
        sqlx::query("INSERT INTO cart_checkout.selling_rules(product_id,rule) VALUES($1,$2)")
            .bind(id)
            .bind(r)
            .execute(&pool)
            .await
            .unwrap();
    }
    let mut d = draft(&f, Mode::Optimize).await;
    d.goal.allow_substitutions = true;
    d.selections = vec![selection(f.b.id, 4, Some(f.a.id))];
    let expensive = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d)
        .await
        .unwrap();
    assert!(!expensive.can_apply);
    assert!(expensive.issues.iter().any(|s| s.contains("saving")));
    sqlx::query("UPDATE catalog.products SET price=4 WHERE id=$1")
        .bind(f.b.id)
        .execute(&pool)
        .await
        .unwrap();
    let mut d = draft(&f, Mode::Optimize).await;
    d.goal.allow_substitutions = true;
    d.selections = vec![selection(f.b.id, 4, Some(f.a.id))];
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d)
        .await
        .unwrap();
    assert!(p.can_apply, "{:?}", p.issues);
    assert_eq!(p.after.merchandise_total, "16.00");
    let result = f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, Uuid::new_v4())
        .await
        .unwrap();
    assert_eq!(result.items[0].quantity, 4);
    assert!(result.items[0].unit.contains("0.5 kg"));
}
#[sqlx::test(migrations = "../../migrations")]
async fn measured_http_is_owned_closed_and_currency_confirmation_is_bound(pool: PgPool) {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let f = setup(pool.clone()).await;
    egp(&f).await;
    sqlx::query("UPDATE catalog.products SET unit='pack' WHERE id=$1")
        .bind(f.b.id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO cart_checkout.selling_rules(product_id,rule) VALUES($1,$2)")
        .bind(f.b.id)
        .bind(weight())
        .execute(&pool)
        .await
        .unwrap();
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
    let app = api_gateway::cart::router(f.app.clone());
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/v1/cart/items/{}/measure", f.b.id))
                .header("Content-Type", "application/json")
                .header("X-Commerce-Request", "1")
                .header("Origin", "http://localhost:5173")
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::from(r#"{"quantity":"0.75"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: serde_json::Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["currency"], "EGP");
    let tenant = Uuid::new_v4();
    sqlx::query("UPDATE cart_checkout.trust_configuration SET enabled=true,tenant_id=$1")
        .bind(tenant)
        .execute(&pool)
        .await
        .unwrap();
    let mut d = draft(&f, Mode::Shop).await;
    d.goal.currency = Some("EGP".into());
    d.goal.budget = Some("100.00".into());
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d)
        .await
        .unwrap();
    assert!(p.can_apply);
    let session = f.app.customers.security.decode(&token).unwrap().sid;
    let action = domain_cart_checkout::trust::confirm(
        &pool,
        domain_cart_checkout::trust::ConfirmationRequest {
            tenant,
            cart: f.cart,
            customer: Some(f.customer),
            session: Some(session),
            proposal: p.id,
            key: Uuid::new_v4(),
            external: None,
        },
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(action.currency, "EGP");
    let res=app.oneshot(Request::builder().method("PUT").uri("/v1/admin/market").header("Content-Type","application/json").header("X-Commerce-Request","1").header("Origin","http://localhost:5173").body(Body::from(r#"{"enabled":true,"currency":"USD","region":"US","industry":"general","expected_version":1,"delivery_fee":"3.00","reason":"unauthorized"}"#)).unwrap()).await.unwrap();
    assert_eq!(res.status(), 401);
}
#[sqlx::test(migrations = "../../migrations")]
async fn daily_spend_is_currency_specific_but_action_count_is_shared(pool: PgPool) {
    use domain_cart_checkout::trust as t;
    let f = setup(pool.clone()).await;
    let tenant = Uuid::new_v4();
    sqlx::query("UPDATE cart_checkout.trust_configuration SET enabled=true,tenant_id=$1")
        .bind(tenant)
        .execute(&pool)
        .await
        .unwrap();
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
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    let key = Uuid::new_v4();
    t::confirm(
        &pool,
        t::ConfirmationRequest {
            tenant,
            cart: f.cart,
            customer: Some(f.customer),
            session: Some(sid),
            proposal: p.id,
            key,
            external: None,
        },
    )
    .await
    .unwrap()
    .unwrap();
    f.app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, key)
        .await
        .unwrap();
    for item in cart(&f).await.items {
        f.app
            .cart
            .remove(Some(f.customer), "", item.product_id)
            .await
            .unwrap();
    }
    egp(&f).await;
    sqlx::query("UPDATE cart_checkout.trust_agents SET currency='EGP',max_daily_actions=2,max_daily_amount=30 WHERE id=$1").bind(t::BROWSER_AGENT).execute(&pool).await.unwrap();
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    let key = Uuid::new_v4();
    let action = t::confirm(
        &pool,
        t::ConfirmationRequest {
            tenant,
            cart: f.cart,
            customer: Some(f.customer),
            session: Some(sid),
            proposal: p.id,
            key,
            external: None,
        },
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(action.currency, "EGP");
    f.app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, key)
        .await
        .unwrap();
    sqlx::query("UPDATE cart_checkout.trust_agents SET max_daily_amount=1000 WHERE id=$1")
        .bind(t::BROWSER_AGENT)
        .execute(&pool)
        .await
        .unwrap();
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    assert!(t::confirm(
        &pool,
        t::ConfirmationRequest {
            tenant,
            cart: f.cart,
            customer: Some(f.customer),
            session: Some(sid),
            proposal: p.id,
            key: Uuid::new_v4(),
            external: None
        }
    )
    .await
    .is_err());
}
