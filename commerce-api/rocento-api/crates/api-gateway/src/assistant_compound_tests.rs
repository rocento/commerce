use super::*;
use std::sync::Arc;

fn fixture() -> Dispatch {
    serde_json::from_str(include_str!(
        "../../../../../commerce-assistant-platform/contracts/commerce-planning/v1/compound-dispatch.json"
    ))
    .unwrap()
}

#[test]
fn contract_shared_python_fixture_is_accepted() {
    let input = fixture();
    assert_eq!(input.index().unwrap(), 0);
    assert_eq!(input.command.actions[0].quantity, 2);
    assert_eq!(input.command.actions[1].quantity, 1);
}

#[test]
fn contract_rejects_unsupported_or_incomplete_commands() {
    for mutate in [
        |d: &mut Dispatch| d.command.actions[1].quantity = 2,
        |d: &mut Dispatch| d.command.actions[0].quantity = 0,
        |d: &mut Dispatch| d.command.actions[0].quantity = 1_000_001,
        |d: &mut Dispatch| d.command.actions[1].destination = Destination::Cart,
        |d: &mut Dispatch| d.command.actions[1].action_id = d.command.actions[0].action_id,
        |d: &mut Dispatch| d.command.actions[1].operation_id = d.command.actions[0].operation_id,
        |d: &mut Dispatch| d.command.actions[0].expires_at += 1,
        |d: &mut Dispatch| d.command.scope.customer_id = Uuid::nil(),
        |d: &mut Dispatch| d.command.schema_version = "2.0".into(),
        |d: &mut Dispatch| d.action_id = Uuid::new_v4(),
    ] {
        let mut input = fixture();
        mutate(&mut input);
        assert!(input.index().is_err());
    }
    let mut value: Value = serde_json::from_str(include_str!(
        "../../../../../commerce-assistant-platform/contracts/commerce-planning/v1/compound-dispatch.json"
    ))
    .unwrap();
    value["command"]["actions"][0]["model_permission"] = json!(true);
    assert!(serde_json::from_value::<Dispatch>(value).is_err());
}

async fn setup(pool: sqlx::PgPool) -> (App, Dispatch, super::super::Claims) {
    let identity = identity::App::new(
        pool.clone(),
        infra_auth::Security::new(
            "compound-test-key-".repeat(4),
            "http://localhost".into(),
            false,
        )
        .await
        .unwrap(),
        vec![],
    );
    let credentials = || domain_customers::Credentials {
        identifier: "compound@example.test".into(),
        password: "Compound tests password!".into(),
    };
    let owner = identity.customers.register(credentials()).await.unwrap().id;
    let token = identity
        .customers
        .login(credentials())
        .await
        .unwrap()
        .body
        .access_token;
    let session = identity.customers.security.decode(&token).unwrap().sid;
    identity.cart.open(Some(owner), "").await.unwrap();
    let app = App {
        identity,
        tenant: Uuid::new_v4(),
        signing: Arc::new(
            jsonwebtoken::EncodingKey::from_rsa_pem(crate::test_signing::assistant_private_key())
                .unwrap(),
        ),
        verifying: Arc::new(
            jsonwebtoken::DecodingKey::from_rsa_pem(crate::test_signing::assistant_public_key())
                .unwrap(),
        ),
        client: reqwest::Client::new(),
        slots: Arc::new(tokio::sync::Semaphore::new(8)),
    };
    let mut input = fixture();
    input.command.scope.tenant_id = app.tenant;
    input.command.scope.customer_id = owner;
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            domain_catalog::CategoryInput {
                name: "Compound fruit".into(),
                slug: "compound-fruit".into(),
                parent_id: None,
            },
        )
        .await
        .unwrap();
    for (i, op) in input.command.actions.iter_mut().enumerate() {
        let product = catalog
            .save_product(
                None,
                serde_json::from_value(json!({
                    "sku":format!("COMPOUND-{i}"), "slug":format!("compound-{i}"),
                    "name":format!("Compound fruit {i}"), "description":"Fruit",
                    "price":"2.50", "currency":"USD", "unit":"each", "category_id":category.id,
                    "attributes":{}, "media_ids":[], "active":true, "in_stock":true,
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
        op.product_id = product.id;
        op.observed_at = chrono::Utc::now().timestamp();
        op.expires_at = op.observed_at + 30;
    }
    let now = chrono::Utc::now().timestamp();
    let claims = super::super::Claims {
        iss: "commerce-assistant".into(),
        aud: "assistant-tools".into(),
        tenant: app.tenant,
        sub: Some(owner),
        sid: Some(session),
        request_id: input.command.request_id,
        iat: now,
        exp: now + 45,
        scope: format!("compound_read:{}", input.command.scope.conversation_id),
    };
    (app, input, claims)
}

fn headers(app: &App, claims: &super::super::Claims) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        format!("Bearer {}", app.sign(claims).unwrap())
            .parse()
            .unwrap(),
    );
    headers
}

#[sqlx::test(migrations = "../../migrations")]
async fn postgres_concurrent_replay_partial_failure_and_read_recovery(pool: sqlx::PgPool) {
    let (a, mut input, claims) = setup(pool.clone()).await;
    let (one, duplicate) = tokio::join!(execute(&a, &input), execute(&a, &input));
    let first = one.unwrap();
    assert_eq!(first, duplicate.unwrap());
    assert_eq!(first["outcome"], "succeeded");
    // The response can be lost; read-only reconciliation returns the committed proof.
    authorize(&a, &headers(&a, &claims), &input, true)
        .await
        .unwrap();
    assert!(authorize(&a, &headers(&a, &claims), &input, false)
        .await
        .is_err());
    let recovered = receipt(
        State(a.clone()),
        headers(&a, &claims),
        Json(fixture_with_command(&input)),
    )
    .await
    .ok()
    .expect("receipt lookup")
    .0;
    assert_eq!(recovered["receipt"], first);
    input.action_id = input.command.actions[1].action_id;
    sqlx::query("UPDATE catalog.products SET active=false WHERE id=$1")
        .bind(input.command.actions[1].product_id)
        .execute(&pool)
        .await
        .unwrap();
    let second = execute(&a, &input).await.unwrap();
    assert_eq!(second["outcome"], "failed");
    assert_eq!(execute(&a, &input).await.unwrap(), second);
    let cart = a
        .identity
        .cart
        .read_customer(input.command.scope.customer_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(cart.items.len(), 1);
    assert_eq!(cart.items[0].quantity, 2);
    let saved: Value =
        sqlx::query_scalar("SELECT receipts FROM cart_checkout.assistant_compound_requests")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(saved[input.command.actions[0].action_id.to_string()], first);
    input.command.actions[0].quantity = 3;
    assert!(matches!(execute(&a, &input).await, Err(Error::Conflict)));
}

fn fixture_with_command(input: &Dispatch) -> Dispatch {
    Dispatch {
        schema_version: "1.0".into(),
        command: input.command.clone(),
        action_id: input.action_id,
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn postgres_success_ordering_expiry_scope_and_legacy_claim(pool: sqlx::PgPool) {
    let (a, mut input, claims) = setup(pool.clone()).await;
    input.action_id = input.command.actions[1].action_id;
    assert!(execute(&a, &input).await.is_err());
    input.action_id = input.command.actions[0].action_id;
    let observed = input.command.actions[0].observed_at;
    input.command.actions[0].observed_at = observed - 60;
    input.command.actions[0].expires_at = observed - 30;
    assert!(execute(&a, &input).await.is_err());
    input.command.actions[0].observed_at = observed;
    input.command.actions[0].expires_at = observed + 30;
    for mutate in [
        |d: &mut Dispatch| d.command.scope.tenant_id = Uuid::new_v4(),
        |d: &mut Dispatch| d.command.scope.customer_id = Uuid::new_v4(),
        |d: &mut Dispatch| d.command.scope.conversation_id = Uuid::new_v4(),
        |d: &mut Dispatch| d.command.request_id = Uuid::new_v4(),
    ] {
        let mut bad = fixture_with_command(&input);
        mutate(&mut bad);
        assert!(authorize(&a, &headers(&a, &claims), &bad, true)
            .await
            .is_err());
    }
    assert_eq!(execute(&a, &input).await.unwrap()["outcome"], "succeeded");
    input.action_id = input.command.actions[1].action_id;
    assert_eq!(execute(&a, &input).await.unwrap()["outcome"], "succeeded");
    let wishlist = domain_reviews::Service { pool: pool.clone() }
        .wishlist_ids(input.command.scope.customer_id)
        .await
        .unwrap();
    assert_eq!(wishlist, vec![input.command.actions[1].product_id]);
    input.command.request_id = Uuid::new_v4();
    input.command.revision = Uuid::new_v4();
    input.action_id = input.command.actions[0].action_id;
    sqlx::query(
        "INSERT INTO cart_checkout.assistant_actions(customer_id,request_id) VALUES($1,$2)",
    )
    .bind(input.command.scope.customer_id)
    .bind(input.command.request_id)
    .execute(&pool)
    .await
    .unwrap();
    assert!(matches!(execute(&a, &input).await, Err(Error::Conflict)));
}

#[sqlx::test(migrations = "../../migrations")]
async fn postgres_receipt_storage_error_rolls_back_write_and_claim(pool: sqlx::PgPool) {
    let (a, input, _) = setup(pool.clone()).await;
    sqlx::raw_sql("CREATE FUNCTION cart_checkout.reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt unavailable'; END $$; CREATE TRIGGER reject_receipt BEFORE UPDATE ON cart_checkout.assistant_compound_requests FOR EACH ROW EXECUTE FUNCTION cart_checkout.reject_receipt();")
        .execute(&pool).await.unwrap();
    assert!(execute(&a, &input).await.is_err());
    assert!(a
        .identity
        .cart
        .read_customer(input.command.scope.customer_id)
        .await
        .unwrap()
        .unwrap()
        .items
        .is_empty());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM cart_checkout.assistant_actions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    sqlx::query("DROP TRIGGER reject_receipt ON cart_checkout.assistant_compound_requests")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(execute(&a, &input).await.unwrap()["outcome"], "succeeded");
    assert_eq!(
        a.identity
            .cart
            .read_customer(input.command.scope.customer_id)
            .await
            .unwrap()
            .unwrap()
            .items[0]
            .quantity,
        2
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn postgres_first_failure_stops_next_and_wishlist_first_preserves_success(
    pool: sqlx::PgPool,
) {
    let (a, mut input, _) = setup(pool.clone()).await;
    let cart_product = input.command.actions[0].product_id;
    let wishlist_product = input.command.actions[1].product_id;
    sqlx::query("UPDATE catalog.products SET active=false WHERE id=$1")
        .bind(wishlist_product)
        .execute(&pool)
        .await
        .unwrap();
    let failed = execute(&a, &input).await.unwrap();
    assert_eq!(failed["outcome"], "failed");
    assert_eq!(execute(&a, &input).await.unwrap(), failed);
    input.action_id = input.command.actions[1].action_id;
    assert!(execute(&a, &input).await.is_err());
    assert!(a
        .identity
        .cart
        .read_customer(input.command.scope.customer_id)
        .await
        .unwrap()
        .unwrap()
        .items
        .is_empty());

    // A genuinely new request can explicitly order wishlist before cart.
    sqlx::query("UPDATE catalog.products SET active=true WHERE id=$1")
        .bind(wishlist_product)
        .execute(&pool)
        .await
        .unwrap();
    input.command.request_id = Uuid::new_v4();
    input.command.revision = Uuid::new_v4();
    input.command.actions.swap(0, 1);
    for op in &mut input.command.actions {
        op.action_id = Uuid::new_v4();
        op.operation_id = Uuid::new_v4();
    }
    input.action_id = input.command.actions[0].action_id;
    assert_eq!(execute(&a, &input).await.unwrap()["outcome"], "succeeded");
    sqlx::query("UPDATE catalog.products SET active=false WHERE id=$1")
        .bind(cart_product)
        .execute(&pool)
        .await
        .unwrap();
    input.action_id = input.command.actions[1].action_id;
    assert_eq!(execute(&a, &input).await.unwrap()["outcome"], "failed");
    assert_eq!(
        domain_reviews::Service { pool }
            .wishlist_ids(input.command.scope.customer_id)
            .await
            .unwrap(),
        vec![wishlist_product]
    );
}
