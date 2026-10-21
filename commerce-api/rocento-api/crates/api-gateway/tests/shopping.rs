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

#[sqlx::test(migrations = "../../migrations")]
async fn typed_stale_proposal_failure_is_opt_in_and_does_not_change_cart(pool: PgPool) {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let f = setup(pool.clone()).await;
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
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    sqlx::query("UPDATE cart_checkout.basket_proposals SET expires_at=now()-interval '1 second' WHERE id=$1").bind(p.id).execute(&pool).await.unwrap();
    let router = api_gateway::cart::router(f.app.clone());
    let before = json!(cart(&f).await);
    for typed in [false, true] {
        let reference = Uuid::new_v4();
        let mut request = Request::post(format!("/v1/cart/proposals/{}/apply", p.id))
            .header("content-type", "application/json")
            .header("x-commerce-request", "1")
            .header("authorization", format!("Bearer {token}"));
        if typed {
            request = request
                .header("x-commerce-assistant-errors", "1")
                .header("x-commerce-request-reference", reference.to_string());
        }
        let response = router
            .clone()
            .oneshot(
                request
                    .body(Body::from(json!({"idempotency_key":p.id}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 400);
        let value: serde_json::Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(value.get("failure").is_some(), typed);
        if typed {
            assert_eq!(value["failure"]["code"], "stale_proposal");
            assert_eq!(value["failure"]["recovery"], "refresh_proposal");
            assert_eq!(value["failure"]["request_reference"], reference.to_string());
        }
    }
    assert_eq!(json!(cart(&f).await)["items"], before["items"]);
}

#[sqlx::test(migrations = "../../migrations")]
async fn proposal_is_read_only_and_apply_is_atomic_idempotent_and_preserves_cart(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let before = json!(cart(&f).await);
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    assert!(p.can_apply, "{:?}", p.issues);
    assert_eq!(before, json!(cart(&f).await));
    let key = Uuid::new_v4();
    let (a, b) = tokio::join!(
        f.app
            .cart
            .apply_proposal(f.cart, Some(f.customer), "", p.id, key),
        f.app
            .cart
            .apply_proposal(f.cart, Some(f.customer), "", p.id, key)
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(json!(a), json!(b));
    assert_eq!(
        a.items
            .iter()
            .find(|i| i.product_id == f.a.id)
            .unwrap()
            .quantity,
        2
    );
    assert_eq!(
        a.items
            .iter()
            .find(|i| i.product_id == f.b.id)
            .unwrap()
            .quantity,
        1
    );
    assert!(a.fully_reserved);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM orders.orders")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(
        f.app
            .cart
            .shopping_proposal(f.cart, p.id)
            .await
            .unwrap()
            .applied
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn budgets_fees_currencies_slots_and_quantity_constraints_are_honest(pool: PgPool) {
    let f = setup(pool).await;
    for case in 0..5 {
        let mut d = draft(&f, Mode::Shop).await;
        match case {
            0 => {
                d.goal.budget = Some("5".into());
            }
            1 => {
                d.location_id = None;
                d.goal.all_inclusive = true;
                d.goal.budget = Some("999".into());
            }
            2 => d.goal.currency = Some("EGP".into()),
            3 => d.goal.delivery_date = Some("today".into()),
            _ => {
                d.selections[0]
                    .required_attributes
                    .insert("material".into(), json!("silver"));
            }
        }
        let p = f
            .app
            .cart
            .propose(f.cart, Some(f.customer), d)
            .await
            .unwrap();
        assert!(!p.can_apply);
        assert!(!p.issues.is_empty());
        assert!(f
            .app
            .cart
            .apply_proposal(f.cart, Some(f.customer), "", p.id, Uuid::new_v4())
            .await
            .is_err());
        if case == 1 {
            assert!(p.after.payable.is_none());
        }
    }
    let mut d = draft(&f, Mode::Shop).await;
    d.selections[0].quantity = 0;
    assert!(f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d)
        .await
        .is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn optimize_respects_locks_quantities_and_requotes_a_selected_subset(pool: PgPool) {
    let f = setup(pool).await;
    let mut d = draft(&f, Mode::Optimize).await;
    d.goal.allow_substitutions = true;
    d.selections = vec![selection(f.b.id, 2, Some(f.a.id))];
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d.clone())
        .await
        .unwrap();
    assert!(p.can_apply, "{:?}", p.issues);
    assert_eq!(p.savings.as_deref(), Some("8.00"));
    let mut subset = p.draft.clone();
    subset.selections.clear();
    let q = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), subset)
        .await
        .unwrap();
    assert_ne!(q.id, p.id);
    assert!(!q.can_apply);
    assert_eq!(q.after.subtotal, "20.00");
    assert!(f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, Uuid::new_v4())
        .await
        .is_err());
    d.task_id = Uuid::new_v4();
    d.goal.locked_products = vec![f.a.id];
    let locked = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d.clone())
        .await
        .unwrap();
    assert!(!locked.can_apply);
    d.task_id = Uuid::new_v4();
    d.goal.locked_products.clear();
    d.selections[0].quantity = 1;
    let reduced = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d)
        .await
        .unwrap();
    assert!(!reduced.can_apply);
}
#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_cart_edits_expired_quotes_and_inventory_changes_never_overwrite(pool: PgPool) {
    use domain_cart_checkout::error::StaleProposal;

    let f = setup(pool.clone()).await;
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    f.app
        .cart
        .set(Some(f.customer), "", f.a.clone(), 3, false)
        .await
        .unwrap();
    let result = f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, Uuid::new_v4())
        .await;
    assert!(matches!(result, Err(ref error)
        if StaleProposal::from_error(error) == Some(&StaleProposal::CartRevisionChanged)));
    assert_eq!(cart(&f).await.items[0].quantity, 3);
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    sqlx::query("UPDATE cart_checkout.basket_proposals SET expires_at=now()-interval '1 second' WHERE id=$1").bind(p.id).execute(&pool).await.unwrap();
    let result = f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, Uuid::new_v4())
        .await;
    assert!(matches!(result, Err(ref error)
        if StaleProposal::from_error(error) == Some(&StaleProposal::ProposalUnavailable)));
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    f.app
        .cart
        .inventory
        .adjust(f.b.id, 0, Uuid::new_v4(), "Test unavailable".into())
        .await
        .unwrap();
    let result = f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, Uuid::new_v4())
        .await;
    assert!(matches!(result, Err(ref error)
        if StaleProposal::from_error(error) == Some(&StaleProposal::QuoteFactsChanged)));
    assert_eq!(cart(&f).await.items.len(), 1);
}
#[sqlx::test(migrations = "../../migrations")]
async fn buy_again_uses_current_prices_and_enforces_order_ownership(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let order = f
        .app
        .cart
        .place(f.customer, quote.id, Uuid::new_v4())
        .await
        .unwrap();
    sqlx::query("UPDATE catalog.products SET price=12 WHERE id=$1")
        .bind(f.a.id)
        .execute(&pool)
        .await
        .unwrap();
    let mut d = draft(&f, Mode::BuyAgain).await;
    d.order_id = Some(order.order.id);
    d.auto_select = true;
    d.selections.clear();
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d.clone())
        .await
        .unwrap();
    assert!(p.can_apply, "{:?}", p.issues);
    assert_eq!(p.lines[0].historical_price.as_deref(), Some("10.00"));
    assert_eq!(p.after.subtotal, "24.00");
    assert!(cart(&f).await.items.is_empty());
    d.task_id = Uuid::new_v4();
    d.order_id = Some(Uuid::new_v4());
    assert!(f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d)
        .await
        .is_err());
    let guest = f.app.cart.open(None, "").await.unwrap();
    let mut stolen = p.draft.clone();
    stolen.task_id = Uuid::new_v4();
    stolen.task_revision = 0;
    stolen.source_revision = 0;
    stolen.location_id = None;
    assert!(f
        .app
        .cart
        .propose(guest.cart.id, None, stolen)
        .await
        .is_err());
    assert!(f
        .app
        .cart
        .shopping_proposal(guest.cart.id, p.id)
        .await
        .is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn partial_failure_rolls_back_all_cart_inventory_and_action_changes(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    let before = json!(cart(&f).await);
    sqlx::query(&format!("ALTER TABLE cart_checkout.items ADD CONSTRAINT simulated_write_failure CHECK(product_id<>'{}')",f.b.id)).execute(&pool).await.unwrap();
    assert!(f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, Uuid::new_v4())
        .await
        .is_err());
    assert_eq!(before, json!(cart(&f).await));
    assert!(
        !f.app
            .cart
            .shopping_proposal(f.cart, p.id)
            .await
            .unwrap()
            .applied
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn cancelled_tasks_and_changed_product_facts_require_new_review(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    f.app
        .cart
        .cancel_shopping(f.cart, p.draft.task_id)
        .await
        .unwrap();
    assert!(f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, Uuid::new_v4())
        .await
        .is_err());
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    sqlx::query("UPDATE catalog.products SET price=9 WHERE id=$1")
        .bind(f.b.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, Uuid::new_v4())
        .await
        .is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn installment_and_bnpl_methods_are_rejected_by_payment_storage(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let quote = f.app.cart.quote(f.customer, f.location).await.unwrap();
    let order = f
        .app
        .cart
        .place(f.customer, quote.id, Uuid::new_v4())
        .await
        .unwrap();
    for method in ["bnpl", "installment", "installments", "klarna", "afterpay"] {
        assert!(sqlx::query(
            "UPDATE payments.payment_transactions SET method=$2 WHERE order_id=$1"
        )
        .bind(order.order.id)
        .bind(method)
        .execute(&pool)
        .await
        .is_err());
    }
    assert!(order.payment.collected_at.is_none());
    assert_eq!(order.payment.method, "cod");
}

#[sqlx::test(migrations = "../../migrations")]
async fn early_cancellation_and_exclusive_budgets_fail_closed(pool: PgPool) {
    let f = setup(pool).await;
    let d = draft(&f, Mode::Shop).await;
    f.app.cart.cancel_shopping(f.cart, d.task_id).await.unwrap();
    let ctx = f
        .app
        .cart
        .shopping_context(f.cart, Some(f.customer), d.task_id)
        .await
        .unwrap();
    assert_eq!(ctx["cancelled"], true);
    assert!(ctx["draft"].is_null());
    assert!(f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d)
        .await
        .is_err());
    let mut d = draft(&f, Mode::Shop).await;
    d.goal.budget = Some("26.00".into());
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d.clone())
        .await
        .unwrap();
    assert!(p.can_apply);
    d.task_id = Uuid::new_v4();
    d.goal.budget_exclusive = true;
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d)
        .await
        .unwrap();
    assert!(!p.can_apply);
    let mut d = draft(&f, Mode::Shop).await;
    d.selections[0].max_price = Some("5.00".into());
    assert!(
        !f.app
            .cart
            .propose(f.cart, Some(f.customer), d)
            .await
            .unwrap()
            .can_apply
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn equal_totals_do_not_hide_changed_item_prices_and_unknown_pack_sizes(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    // Two original units fall by one each, while the new unit rises by two: total unchanged.
    sqlx::query(
        "UPDATE catalog.products SET price=CASE WHEN id=$1 THEN 9 ELSE 8 END WHERE id=ANY($2)",
    )
    .bind(f.a.id)
    .bind(vec![f.a.id, f.b.id])
    .execute(&pool)
    .await
    .unwrap();
    assert!(f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, Uuid::new_v4())
        .await
        .is_err());
    sqlx::query("UPDATE catalog.products SET unit='pack' WHERE id=ANY($1)")
        .bind(vec![f.a.id, f.b.id])
        .execute(&pool)
        .await
        .unwrap();
    let mut d = draft(&f, Mode::Optimize).await;
    d.goal.allow_substitutions = true;
    d.selections = vec![selection(f.b.id, 2, Some(f.a.id))];
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d)
        .await
        .unwrap();
    assert!(
        !p.can_apply,
        "Unknown pack sizes cannot prove equivalent quantities"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn unserviceable_locations_block_apply_and_other_locations_are_private(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let mut d = draft(&f, Mode::Shop).await;
    d.location_id = Some(Uuid::new_v4());
    assert!(f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d)
        .await
        .is_err());
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km) VALUES($1,'Outside test location',0,0,1)").bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    assert!(!p.can_apply);
    assert!(p.after.payable.is_none());
    assert!(f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, Uuid::new_v4())
        .await
        .is_err());
}

async fn enable_execution(pool: &PgPool) {
    sqlx::query("UPDATE cart_checkout.execution_config SET enabled=true")
        .execute(pool)
        .await
        .unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn execution_complex_goal_resumes_current_facts_and_preserves_every_constraint(pool: PgPool) {
    use domain_cart_checkout::execution::{State, Verdict};
    let f = setup(pool.clone()).await;
    enable_execution(&pool).await;
    let mut d = draft(&f, Mode::Shop).await;
    d.goal.purpose = "Weekly fruit within a fixed budget".into();
    d.goal.budget = Some("30.00".into());
    d.goal.currency = Some("USD".into());
    d.goal.locked_products = vec![f.a.id];
    d.goal.excluded_products = vec![Uuid::new_v4()];
    d.selections[0].max_price = Some("7.00".into());
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), d)
        .await
        .unwrap();
    assert!(p.can_apply);
    assert_eq!(
        p.execution.as_ref().unwrap().state,
        State::AwaitingConfirmation
    );
    let c = f
        .app
        .cart
        .execution_goal(f.cart, Some(f.customer), p.draft.task_id)
        .await
        .unwrap();
    assert!(!c.saved_by_customer);
    assert_eq!(c.observations.len(), 2);
    assert!(c.transitions.ends_with(&[
        State::Planned,
        State::Executing,
        State::Verifying,
        State::AwaitingConfirmation
    ]));
    assert!(f
        .app
        .cart
        .resume_execution_goal(
            f.cart,
            Some(f.customer),
            p.draft.task_id,
            c.receipt.revision
        )
        .await
        .is_err());
    let saved = f
        .app
        .cart
        .save_execution_goal(
            f.cart,
            Some(f.customer),
            p.draft.task_id,
            c.receipt.revision,
        )
        .await
        .unwrap();
    // New service instance has no in-memory execution state to carry across a restart.
    let recovered = domain_cart_checkout::Service {
        pool: pool.clone(),
        inventory: f.app.cart.inventory.clone(),
    };
    sqlx::query("UPDATE catalog.products SET price=8 WHERE id=$1")
        .bind(f.b.id)
        .execute(&pool)
        .await
        .unwrap();
    let fresh = recovered
        .resume_execution_goal(
            f.cart,
            Some(f.customer),
            p.draft.task_id,
            saved.receipt.revision,
        )
        .await
        .unwrap();
    assert!(!fresh.can_apply);
    assert_eq!(
        fresh.execution.as_ref().unwrap().verdict,
        Verdict::NeedsInput
    );
    assert_eq!(json!(fresh.draft.goal), json!(p.draft.goal));
    assert_eq!(json!(fresh.draft.selections), json!(p.draft.selections));
    assert_ne!(fresh.id, p.id);
    assert_eq!(
        fresh.lines[0].product.as_ref().unwrap().price.to_string(),
        "8.00"
    );
    assert!(recovered
        .apply_proposal(f.cart, Some(f.customer), "", fresh.id, fresh.id)
        .await
        .is_err());
    assert_eq!(cart(&f).await.items.len(), 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn execution_revalidation_loops_stop_and_never_substitute_unavailable_items(pool: PgPool) {
    use domain_cart_checkout::execution::State;
    let f = setup(pool.clone()).await;
    enable_execution(&pool).await;
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    let task = p.draft.task_id;
    let c = f
        .app
        .cart
        .save_execution_goal(
            f.cart,
            Some(f.customer),
            task,
            p.execution.as_ref().unwrap().revision,
        )
        .await
        .unwrap();
    f.app
        .cart
        .inventory
        .adjust(f.b.id, 0, Uuid::new_v4(), "Test stock change".into())
        .await
        .unwrap();
    let a = f
        .app
        .cart
        .resume_execution_goal(f.cart, Some(f.customer), task, c.receipt.revision)
        .await
        .unwrap();
    assert!(!a.can_apply);
    assert_eq!(a.draft.selections[0].product_id, f.b.id);
    assert!(a
        .execution
        .as_ref()
        .unwrap()
        .reasons
        .contains(&"unavailable_item".into()));
    let b = f
        .app
        .cart
        .resume_execution_goal(
            f.cart,
            Some(f.customer),
            task,
            a.execution.unwrap().revision,
        )
        .await
        .unwrap();
    assert!(!b.can_apply);
    assert!(f
        .app
        .cart
        .resume_execution_goal(
            f.cart,
            Some(f.customer),
            task,
            b.execution.unwrap().revision
        )
        .await
        .is_err());
    let stopped = f
        .app
        .cart
        .execution_goal(f.cart, Some(f.customer), task)
        .await
        .unwrap();
    assert_eq!(stopped.receipt.state, State::Blocked);
    assert_eq!(stopped.revalidations, 2);
    assert!(stopped.transitions.len() <= 16);
    assert_eq!(cart(&f).await.items.len(), 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn execution_all_journeys_use_versioned_authoritative_verification(pool: PgPool) {
    use domain_cart_checkout::execution::Verdict;
    let f = setup(pool.clone()).await;
    enable_execution(&pool).await;
    for mode in [Mode::Shop, Mode::Optimize, Mode::BuyAgain] {
        let mut d = draft(&f, mode.clone()).await;
        if mode == Mode::Optimize {
            d.auto_select = true;
            d.goal.allow_substitutions = true;
            d.selections.clear();
        }
        if mode == Mode::BuyAgain {
            let q = f.app.cart.quote(f.customer, f.location).await.unwrap();
            let order = f
                .app
                .cart
                .place(f.customer, q.id, Uuid::new_v4())
                .await
                .unwrap();
            d = draft(&f, Mode::BuyAgain).await;
            d.order_id = Some(order.order.id);
            d.auto_select = true;
            d.selections.clear();
        }
        let p = f
            .app
            .cart
            .propose(f.cart, Some(f.customer), d)
            .await
            .unwrap();
        assert!(p.can_apply, "{:?}", p.issues);
        let e = p.execution.as_ref().unwrap();
        assert_eq!(e.version, "1.0.0");
        assert_eq!(e.verdict, Verdict::Pass);
        let c = f
            .app
            .cart
            .save_execution_goal(f.cart, Some(f.customer), p.draft.task_id, e.revision)
            .await
            .unwrap();
        let resumed = f
            .app
            .cart
            .resume_execution_goal(
                f.cart,
                Some(f.customer),
                p.draft.task_id,
                c.receipt.revision,
            )
            .await
            .unwrap();
        assert!(resumed.can_apply);
        assert_eq!(json!(resumed.draft.goal), json!(p.draft.goal));
        assert_eq!(resumed.resulting_items.len(), p.resulting_items.len());
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn execution_concurrent_resume_and_confirmation_recovery_are_not_duplicate_actions(
    pool: PgPool,
) {
    use domain_cart_checkout::execution::State;
    let f = setup(pool.clone()).await;
    enable_execution(&pool).await;
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    let task = p.draft.task_id;
    let c = f
        .app
        .cart
        .save_execution_goal(
            f.cart,
            Some(f.customer),
            task,
            p.execution.unwrap().revision,
        )
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        f.app
            .cart
            .resume_execution_goal(f.cart, Some(f.customer), task, c.receipt.revision),
        f.app
            .cart
            .resume_execution_goal(f.cart, Some(f.customer), task, c.receipt.revision)
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let p = a.or(b).unwrap();
    assert!(f
        .app
        .cart
        .apply_proposal(
            f.cart,
            Some(f.customer),
            "",
            c.receipt.proposal_id,
            Uuid::new_v4()
        )
        .await
        .is_err());
    let applied = f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, p.id)
        .await
        .unwrap();
    let before: i64 = sqlx::query_scalar("SELECT revision FROM cart_checkout.carts WHERE id=$1")
        .bind(f.cart)
        .fetch_one(&pool)
        .await
        .unwrap();
    let recovered = domain_cart_checkout::Service {
        pool: pool.clone(),
        inventory: f.app.cart.inventory.clone(),
    };
    let again = recovered
        .apply_proposal(f.cart, Some(f.customer), "", p.id, p.id)
        .await
        .unwrap();
    assert_eq!(json!(applied), json!(again));
    let after: i64 = sqlx::query_scalar("SELECT revision FROM cart_checkout.carts WHERE id=$1")
        .bind(f.cart)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(before, after);
    let completed = recovered
        .execution_goal(f.cart, Some(f.customer), task)
        .await
        .unwrap();
    assert_eq!(completed.receipt.state, State::Completed);
    assert_eq!(completed.envelope.confirmation, "consumed");
    assert!(recovered
        .resume_execution_goal(f.cart, Some(f.customer), task, completed.receipt.revision)
        .await
        .is_err());
}

#[sqlx::test(migrations = "../../migrations")]
async fn execution_guest_customer_store_and_expiry_boundaries_are_enforced(pool: PgPool) {
    let f = setup(pool.clone()).await;
    enable_execution(&pool).await;
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    let task = p.draft.task_id;
    let guest = f.app.cart.open(None, "").await.unwrap();
    assert!(f
        .app
        .cart
        .execution_goal(guest.cart.id, None, task)
        .await
        .is_err());
    assert!(f
        .app
        .cart
        .execution_goal(f.cart, Some(Uuid::new_v4()), task)
        .await
        .is_err());
    let c = f
        .app
        .cart
        .save_execution_goal(
            f.cart,
            Some(f.customer),
            task,
            p.execution.unwrap().revision,
        )
        .await
        .unwrap();
    let original: Uuid = sqlx::query_scalar("SELECT store_id FROM cart_checkout.execution_config")
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE cart_checkout.execution_config SET store_id=$1")
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .unwrap();
    assert!(f
        .app
        .cart
        .execution_goal(f.cart, Some(f.customer), task)
        .await
        .is_err());
    sqlx::query("UPDATE cart_checkout.execution_config SET store_id=$1")
        .bind(original)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE cart_checkout.goal_checkpoints SET checkpoint=jsonb_set(checkpoint,'{goal_expires_at}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE task_id=$1").bind(task).execute(&pool).await.unwrap();
    assert!(f
        .app
        .cart
        .resume_execution_goal(f.cart, Some(f.customer), task, c.receipt.revision)
        .await
        .is_err());
    assert!(f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, p.id)
        .await
        .is_err());
    assert_eq!(
        f.app
            .cart
            .execution_goal(f.cart, Some(f.customer), task)
            .await
            .unwrap()
            .receipt
            .state,
        domain_cart_checkout::execution::State::Expired
    );
    assert_eq!(cart(&f).await.items.len(), 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn execution_stale_apply_retains_verifier_failure_and_requires_new_review(pool: PgPool) {
    use domain_cart_checkout::execution::{State, Verdict};
    let f = setup(pool.clone()).await;
    enable_execution(&pool).await;
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    sqlx::query("UPDATE catalog.products SET price=7 WHERE id=$1")
        .bind(f.b.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, p.id)
        .await
        .is_err());
    let c = f
        .app
        .cart
        .execution_goal(f.cart, Some(f.customer), p.draft.task_id)
        .await
        .unwrap();
    assert_eq!(c.receipt.state, State::NeedsInput);
    assert_eq!(c.receipt.verdict, Verdict::Stale);
    assert!(f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, p.id)
        .await
        .is_err());
    assert_eq!(cart(&f).await.items.len(), 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn execution_flag_defaults_off_and_cancel_is_terminal(pool: PgPool) {
    use domain_cart_checkout::execution::State;
    let f = setup(pool.clone()).await;
    let old = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    assert!(old.execution.is_none());
    assert!(f
        .app
        .cart
        .execution_goal(f.cart, Some(f.customer), old.draft.task_id)
        .await
        .is_err());
    enable_execution(&pool).await;
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    let task = p.draft.task_id;
    f.app.cart.cancel_shopping(f.cart, task).await.unwrap();
    let c = f
        .app
        .cart
        .execution_goal(f.cart, Some(f.customer), task)
        .await
        .unwrap();
    assert_eq!(c.receipt.state, State::Cancelled);
    assert!(f
        .app
        .cart
        .save_execution_goal(f.cart, Some(f.customer), task, c.receipt.revision)
        .await
        .is_err());
    assert!(f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, p.id)
        .await
        .is_err());
    assert!(f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", old.id, old.id)
        .await
        .is_ok());
}

#[sqlx::test(migrations = "../../migrations")]
async fn execution_read_budget_guest_isolation_and_rollback_survive_recreation(pool: PgPool) {
    let f = setup(pool.clone()).await;
    enable_execution(&pool).await;
    let guest = f.app.cart.open(None, "").await.unwrap();
    let other = f.app.cart.open(None, "").await.unwrap();
    let mut d = draft(&f, Mode::Shop).await;
    d.source_revision = 0;
    d.location_id = None;
    let p = f.app.cart.propose(guest.cart.id, None, d).await.unwrap();
    let task = p.draft.task_id;
    let mut c = f
        .app
        .cart
        .save_execution_goal(guest.cart.id, None, task, p.execution.unwrap().revision)
        .await
        .unwrap();
    assert!(f
        .app
        .cart
        .resume_execution_goal(other.cart.id, None, task, c.receipt.revision)
        .await
        .is_err());
    for _ in 0..3 {
        let fresh = f
            .app
            .cart
            .resume_execution_goal(guest.cart.id, None, task, c.receipt.revision)
            .await
            .unwrap();
        assert!(fresh.can_apply);
        c = f
            .app
            .cart
            .execution_goal(guest.cart.id, None, task)
            .await
            .unwrap();
    }
    assert_eq!(c.revalidations, c.max_revalidations);
    assert!(f
        .app
        .cart
        .resume_execution_goal(guest.cart.id, None, task, c.receipt.revision)
        .await
        .is_err());
    // A failed transaction cannot leave an advanced checkpoint or consumed approval.
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    let old = f
        .app
        .cart
        .execution_goal(f.cart, Some(f.customer), p.draft.task_id)
        .await
        .unwrap();
    sqlx::query(&format!(
        "ALTER TABLE cart_checkout.items ADD CONSTRAINT m06_failure CHECK(product_id<>'{}')",
        f.b.id
    ))
    .execute(&pool)
    .await
    .unwrap();
    assert!(f
        .app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, p.id)
        .await
        .is_err());
    let after = f
        .app
        .cart
        .execution_goal(f.cart, Some(f.customer), p.draft.task_id)
        .await
        .unwrap();
    assert_eq!(json!(old), json!(after));
    assert!(
        !f.app
            .cart
            .shopping_proposal(f.cart, p.id)
            .await
            .unwrap()
            .applied
    );
    sqlx::query("ALTER TABLE cart_checkout.items DROP CONSTRAINT m06_failure")
        .execute(&pool)
        .await
        .unwrap();
    f.app
        .cart
        .apply_proposal(f.cart, Some(f.customer), "", p.id, p.id)
        .await
        .unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn execution_http_goal_requires_owner_and_rejects_model_supplied_changes(pool: PgPool) {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;
    let f = setup(pool.clone()).await;
    enable_execution(&pool).await;
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
    let p = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    let router = api_gateway::cart::router(f.app.clone());
    let route = format!("/v1/cart/shopping/{}/goal", p.draft.task_id);
    let revision = p.execution.unwrap().revision;
    for (authorized, extra, expected) in
        [(false, false, 404), (true, true, 422), (true, false, 200)]
    {
        let mut request = Request::post(&route)
            .header("content-type", "application/json")
            .header("x-commerce-request", "1");
        if authorized {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let mut body = json!({"revision":revision});
        if extra {
            body["goal"] = json!({"budget":null});
        }
        let result = router
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        assert_eq!(result.status().as_u16(), expected);
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn memory_saved_goal_metadata_is_owned_versioned_and_archive_blocks_resume(pool: PgPool) {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let f = setup(pool.clone()).await;
    sqlx::query("UPDATE cart_checkout.execution_config SET enabled=true")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE customers.memory_configuration SET enabled=true")
        .execute(&pool)
        .await
        .unwrap();
    let proposal = f
        .app
        .cart
        .propose(f.cart, Some(f.customer), draft(&f, Mode::Shop).await)
        .await
        .unwrap();
    let task = proposal.draft.task_id;
    let checkpoint = f
        .app
        .cart
        .save_execution_goal(
            f.cart,
            Some(f.customer),
            task,
            proposal.execution.unwrap().revision,
        )
        .await
        .unwrap();
    let login = f
        .app
        .customers
        .login(domain_customers::Credentials {
            identifier: "basket@example.test".into(),
            password: "Shopping test password!".into(),
        })
        .await
        .unwrap();
    let router = api_gateway::shopping::routes().with_state(f.app.clone());
    let req = |method: &str, path: String, body: serde_json::Value| {
        Request::builder()
            .method(method)
            .uri(path)
            .header(
                "authorization",
                format!("Bearer {}", login.body.access_token),
            )
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let response = router
        .clone()
        .oneshot(req("GET", "/v1/cart/saved-goals".into(), json!(null)))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["goals"][0]["task_id"], task.to_string());
    assert_eq!(body["goals"][0]["mode"], "shop");
    let data = json!({"expected_version":1,"name":"Coffee next week","archived":true});
    assert_eq!(
        router
            .clone()
            .oneshot(req(
                "PUT",
                format!("/v1/cart/saved-goals/{task}"),
                data.clone()
            ))
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        router
            .clone()
            .oneshot(req("PUT", format!("/v1/cart/saved-goals/{task}"), data))
            .await
            .unwrap()
            .status(),
        409
    );
    assert!(f
        .app
        .cart
        .resume_execution_goal(f.cart, Some(f.customer), task, checkpoint.receipt.revision)
        .await
        .is_err());
    assert_eq!(
        router
            .clone()
            .oneshot(req(
                "PUT",
                format!("/v1/cart/saved-goals/{task}"),
                json!({"expected_version":2,"name":"Coffee next week","archived":false})
            ))
            .await
            .unwrap()
            .status(),
        200
    );
    let fresh = f
        .app
        .cart
        .resume_execution_goal(f.cart, Some(f.customer), task, checkpoint.receipt.revision)
        .await
        .unwrap();
    assert_ne!(fresh.id, proposal.id);
    assert_eq!(
        router
            .clone()
            .oneshot(req(
                "DELETE",
                format!("/v1/cart/saved-goals/{task}?version=2"),
                json!(null)
            ))
            .await
            .unwrap()
            .status(),
        409
    );
    assert_eq!(
        router
            .clone()
            .oneshot(req(
                "DELETE",
                format!("/v1/cart/saved-goals/{task}?version=3"),
                json!(null)
            ))
            .await
            .unwrap()
            .status(),
        200
    );
    assert!(f
        .app
        .cart
        .execution_goal(f.cart, Some(f.customer), task)
        .await
        .is_err());
    let retained: i64 =
        sqlx::query_scalar("SELECT count(*) FROM cart_checkout.basket_proposals WHERE task_id=$1")
            .bind(task)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(retained >= 2);
}
