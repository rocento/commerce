mod support;
use api_gateway::identity::App;
use domain_admin_iam::Identity;
use serde_json::json;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;
struct Fixture {
    app: App,
    who: Identity,
    customer: Uuid,
    other: Uuid,
    category: Uuid,
    product: domain_catalog::Product,
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
    let actor = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'m7-admin@example.test','M7 Admin','unused',$2)").bind(actor).bind(domain_admin_iam::SUPER).execute(&pool).await.unwrap();
    let user = sqlx::query_as(
        "SELECT id,entity_id,email,name,role_id,active,created_at FROM admin_iam.admin_users WHERE id=$1",
    )
    .bind(actor)
    .fetch_one(&pool)
    .await
    .unwrap();
    let who = Identity {
        user,
        permissions: vec!["*".into()],
    };
    let customer = Uuid::new_v4();
    let other = Uuid::new_v4();
    for id in [customer, other] {
        sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash,verified) VALUES($1,$2,'email','unused',true)").bind(id).bind(format!("{id}@example.test")).execute(&pool).await.unwrap();
    }
    let c = domain_catalog::Service { pool: pool.clone() };
    let category = c
        .save_category(
            None,
            serde_json::from_value(json!({"name":"M7 category","slug":"m7","parent_id":null}))
                .unwrap(),
        )
        .await
        .unwrap()
        .id;
    let product = c
        .save_product(None, product_input(category, "BASE", "10.00"))
        .await
        .unwrap();
    Fixture {
        app,
        who,
        customer,
        other,
        category,
        product,
    }
}
fn product_input(category: Uuid, sku: &str, price: &str) -> domain_catalog::ProductInput {
    serde_json::from_value(json!({"sku":sku,"slug":sku.to_ascii_lowercase(),"name":sku,"description":"Test","price":price,"currency":"USD","unit":"each","category_id":category,"attributes":{},"media_ids":[],"active":true,"in_stock":true})).unwrap()
}
fn definition(entity: &str, code: &str, kind: &str) -> domain_attributes::Definition {
    serde_json::from_value(json!({"id":Uuid::new_v4(),"entity_type":entity,"attribute_code":code,"label":code,"input_type":kind,"scope":"global","is_required":false,"is_unique":false,"is_searchable":false,"is_filterable":false,"is_comparable":false,"is_visible_on_front":false,"used_for_promo_rules":false,"used_for_configurations":false,"swatch_type":"none","options":[],"version":0})).unwrap()
}
async fn sized(
    f: &Fixture,
    pool: &PgPool,
    code: &str,
    value: &str,
    price: &str,
) -> domain_catalog::Product {
    let mut input = product_input(f.category, code, price);
    input.attributes = json!({"pack_size":value});
    domain_catalog::Service { pool: pool.clone() }
        .save_product(None, input)
        .await
        .unwrap()
}
async fn pack(pool: &PgPool) {
    let mut d = definition("product", "pack_size", "select");
    d.options = json!([{"value":"500ml","label":"500 ml"},{"value":"1l","label":"1 L"},{"value":"2l","label":"2 L"}]);
    d.used_for_configurations = true;
    d.is_filterable = true;
    domain_attributes::Service { pool: pool.clone() }
        .save(d)
        .await
        .unwrap();
}
fn link(id: Uuid, group: &str) -> domain_catalog::types::Link {
    domain_catalog::types::Link {
        child_id: id,
        option_label: group.into(),
        quantity: 1,
    }
}
#[sqlx::test(migrations = "../../migrations")]
async fn attribute_sets_group_product_definitions_and_enforce_versions(pool: PgPool) {
    let service = domain_attributes::Service { pool: pool.clone() };
    let material = service
        .save(definition("product", "material", "text"))
        .await
        .unwrap();
    service
        .save(definition("product", "care_note", "text"))
        .await
        .unwrap();
    let customer = service
        .save(definition("customer", "company_role", "text"))
        .await
        .unwrap();
    let set = domain_attributes::AttributeSet {
        id: Uuid::new_v4(),
        entity_id: 0,
        name: "Apparel".into(),
        description: "Fields used by apparel products".into(),
        version: 0,
        members: vec![domain_attributes::SetMember {
            definition_id: material.id,
            group_name: "Product details".into(),
            position: 0,
        }],
    };
    let saved = service.save_set(set).await.unwrap();
    assert_eq!(saved.version, 1);
    assert!(saved.entity_id > 0 && material.entity_id > 0);
    assert_eq!(service.sets().await.unwrap()[0].entity_id, saved.entity_id);
    assert_eq!(service.sets().await.unwrap()[0].members.len(), 1);
    let mut tx = pool.begin().await.unwrap();
    domain_attributes::validate_set(&mut tx, Some(saved.id), &json!({"material":"cotton"}))
        .await
        .unwrap();
    assert!(
        domain_attributes::validate_set(&mut tx, Some(saved.id), &json!({"care_note":"wash"}))
            .await
            .is_err()
    );
    tx.rollback().await.unwrap();
    let mut stale = saved.clone();
    stale.version = 0;
    assert!(service.save_set(stale).await.is_err());
    let mut invalid = saved;
    invalid.id = Uuid::new_v4();
    invalid.version = 0;
    invalid.members[0].definition_id = customer.id;
    assert!(service.save_set(invalid).await.is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn typed_values_unique_required_and_definition_versions(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let service = domain_attributes::Service { pool: pool.clone() };
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let mut d = definition("product", "spice_level", "select");
    d.options = json!([{"value":"mild","label":"Mild"},{"value":"hot","label":"Hot"}]);
    d.is_unique = true;
    d.is_filterable = true;
    d.is_visible_on_front = true;
    let saved = service.save(d).await.unwrap();
    let mut i = product_input(f.category, "SPICE-A", "2.00");
    i.attributes = json!({"spice_level":"mild"});
    let p = catalog.save_product(None, i).await.unwrap();
    let mut duplicate = product_input(f.category, "SPICE-B", "3.00");
    duplicate.attributes = json!({"spice_level":"mild"});
    assert!(catalog.save_product(None, duplicate).await.is_err());
    let mut invalid = product_input(f.category, "SPICE-C", "3.00");
    invalid.attributes = json!({"spice_level":"unknown"});
    assert!(catalog.save_product(None, invalid).await.is_err());
    let mut changed = saved.clone();
    changed.label = "Heat".into();
    let latest = service.save(changed.clone()).await.unwrap();
    assert_eq!(latest.version, 2);
    assert!(service.save(changed).await.is_err());
    let mut required = latest;
    required.is_required = true;
    assert!(service.save(required).await.is_err());
    assert!(service.delete(saved.id).await.is_err());
    assert_eq!(
        catalog.product(f.product.id).await.unwrap().attributes,
        json!({})
    );
    catalog.delete_product(p.id).await.unwrap();
    service.delete(saved.id).await.unwrap();
}
#[sqlx::test(migrations = "../../migrations")]
async fn configurable_skus_stock_cart_and_duplicate_tuple_guards(pool: PgPool) {
    let f = setup(pool.clone()).await;
    pack(&pool).await;
    let c = domain_catalog::Service { pool: pool.clone() };
    let a = sized(&f, &pool, "OIL-500", "500ml", "4.00").await;
    let b = sized(&f, &pool, "OIL-1L", "1l", "7.00").await;
    let d = sized(&f, &pool, "OIL-2L", "2l", "12.00").await;
    let structure = domain_catalog::types::Structure {
        product_type: "configurable".into(),
        configurable_attributes: vec!["pack_size".into()],
        children: vec![link(a.id, ""), link(b.id, ""), link(d.id, "")],
    };
    c.structure(f.product.id, structure.clone()).await.unwrap();
    assert_eq!(c.product(a.id).await.unwrap().parent_id, Some(f.product.id));
    for p in [&a, &b, &d] {
        f.app
            .cart
            .inventory
            .adjust(p.id, 5, f.who.user.id, "M11 fixture".into())
            .await
            .unwrap();
    }
    f.app.cart.open(Some(f.customer), "").await.unwrap();
    assert!(f
        .app
        .cart
        .set(
            Some(f.customer),
            "",
            c.product(f.product.id).await.unwrap(),
            1,
            true
        )
        .await
        .is_err());
    f.app
        .cart
        .set(Some(f.customer), "", a.clone(), 1, true)
        .await
        .unwrap();
    let cart = f
        .app
        .cart
        .set(Some(f.customer), "", b.clone(), 2, true)
        .await
        .unwrap();
    assert_eq!(cart.subtotal.to_string(), "18.00");
    assert_eq!(cart.items.len(), 2);
    let duplicate = sized(&f, &pool, "OIL-DUP", "500ml", "5.00").await;
    let mut bad = structure;
    bad.children.push(link(duplicate.id, ""));
    assert!(c.structure(f.product.id, bad).await.is_err());
    assert_eq!(c.family(f.product.id).await.unwrap().children.len(), 3);
    let mut update = product_input(f.category, "OIL-500", "4.00");
    update.attributes = json!({"pack_size":"2l"});
    assert!(c.save_product(Some(a.id), update).await.is_err());
    assert!(c.delete_product(a.id).await.is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn grouped_and_bundle_atomic_reservations(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let c = domain_catalog::Service { pool: pool.clone() };
    let a = c
        .save_product(None, product_input(f.category, "BREAD", "2.00"))
        .await
        .unwrap();
    let b = c
        .save_product(None, product_input(f.category, "EGGS", "3.00"))
        .await
        .unwrap();
    let d = c
        .save_product(None, product_input(f.category, "MILK", "4.00"))
        .await
        .unwrap();
    c.structure(
        f.product.id,
        domain_catalog::types::Structure {
            product_type: "grouped".into(),
            configurable_attributes: vec![],
            children: vec![link(a.id, ""), link(b.id, ""), link(d.id, "")],
        },
    )
    .await
    .unwrap();
    assert_eq!(c.family(f.product.id).await.unwrap().children.len(), 3);
    let bundle = c
        .save_product(None, product_input(f.category, "BASKET", "0.00"))
        .await
        .unwrap();
    c.structure(
        bundle.id,
        domain_catalog::types::Structure {
            product_type: "bundle".into(),
            configurable_attributes: vec![],
            children: vec![
                link(a.id, "Bread"),
                link(b.id, "Protein"),
                link(d.id, "Protein"),
            ],
        },
    )
    .await
    .unwrap();
    f.app
        .cart
        .inventory
        .adjust(a.id, 5, f.who.user.id, "Fixture".into())
        .await
        .unwrap();
    f.app
        .cart
        .inventory
        .adjust(b.id, 0, f.who.user.id, "Fixture".into())
        .await
        .unwrap();
    f.app.cart.open(Some(f.customer), "").await.unwrap();
    assert!(f
        .app
        .cart
        .bundle(Some(f.customer), "", bundle.id, vec![a.id, b.id])
        .await
        .is_err());
    assert_eq!(f.app.cart.inventory.stock(a.id).await.unwrap().reserved, 0);
    f.app
        .cart
        .inventory
        .adjust(b.id, 5, f.who.user.id, "Fixture".into())
        .await
        .unwrap();
    let cart = f
        .app
        .cart
        .bundle(Some(f.customer), "", bundle.id, vec![a.id, b.id])
        .await
        .unwrap();
    assert_eq!(cart.items.len(), 2);
    assert_eq!(cart.subtotal.to_string(), "5.00");
    assert!(f
        .app
        .cart
        .bundle(Some(f.customer), "", bundle.id, vec![b.id, d.id])
        .await
        .is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn customer_category_typed_values_and_reserved_profile_fields(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let service = domain_attributes::Service { pool: pool.clone() };
    service
        .save(definition("customer", "preferred_brand", "text"))
        .await
        .unwrap();
    service
        .save(definition("category", "seasonal", "boolean"))
        .await
        .unwrap();
    let profile=serde_json::from_value(json!({"first_name":"Sam","last_name":"Test","date_of_birth":"1990-01-01","gender":"prefer_not_to_say","attributes":{"preferred_brand":"Local"}})).unwrap();
    let p = f
        .app
        .customers
        .save_profile(f.customer, profile)
        .await
        .unwrap();
    assert_eq!(p.customer_group, "general");
    assert!(p.company_id.is_none());
    assert_eq!(
        f.app.customers.profile(f.other).await.unwrap().first_name,
        ""
    );
    let forged = serde_json::from_value::<domain_customers::ProfileInput>(
        json!({"first_name":"Sam","last_name":"Test","date_of_birth":null,"gender":"","attributes":{},"customer_group":"wholesale"}),
    );
    assert!(forged.is_err());
    let c = domain_catalog::Service { pool: pool.clone() };
    assert!(c
        .category_values(f.category, json!({"seasonal":"yes"}))
        .await
        .is_err());
    assert_eq!(
        c.category_values(f.category, json!({"seasonal":true}))
            .await
            .unwrap(),
        json!({"seasonal":true})
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn gift_snapshot_order_state_notes_and_legacy_compatibility(pool: PgPool) {
    let f = setup(pool.clone()).await;
    f.app
        .cart
        .inventory
        .adjust(f.product.id, 10, f.who.user.id, "M11 order".into())
        .await
        .unwrap();
    f.app.cart.open(Some(f.customer), "").await.unwrap();
    f.app
        .cart
        .set(Some(f.customer), "", f.product.clone(), 1, true)
        .await
        .unwrap();
    let l=f.app.customers.save_location(f.customer,None,serde_json::from_value(json!({"label":"home","latitude":1.0,"longitude":1.0,"formatted_address":"M11 test address","is_default":true})).unwrap()).await.unwrap();
    let q = f
        .app
        .cart
        .quote_with_gift(f.customer, l.id, Some("Happy birthday".into()))
        .await
        .unwrap();
    let key = Uuid::new_v4();
    let d = f.app.cart.place(f.customer, q.id, key).await.unwrap();
    let orders = domain_orders::Service { pool: pool.clone() };
    assert_eq!(d.order.status, "placed");
    assert_eq!(d.order.gift_message.as_deref(), Some("Happy birthday"));
    let ext = orders
        .extensions(d.order.id, Some(f.customer))
        .await
        .unwrap();
    assert_eq!(ext.state, "new");
    assert_eq!(ext.delivery_location_snapshot, d.order.location);
    orders
        .comment(d.order.id, &f.who, "Internal handling note")
        .await
        .unwrap();
    assert_eq!(orders.comments(d.order.id, &f.who).await.unwrap().len(), 1);
    assert!(
        !serde_json::to_string(&orders.detail(d.order.id, Some(f.customer)).await.unwrap())
            .unwrap()
            .contains("Internal handling note")
    );
    assert!(orders.extensions(d.order.id, Some(f.other)).await.is_err());
    assert_eq!(
        f.app
            .cart
            .place(f.customer, q.id, key)
            .await
            .unwrap()
            .order
            .gift_message,
        d.order.gift_message
    );
    let mut denied = f.who;
    denied.permissions = vec!["orders.read".into()];
    assert!(orders
        .comment(d.order.id, &denied, "No access")
        .await
        .is_err());
}

#[sqlx::test(migrations = "../../migrations")]
async fn attribute_http_permissions_and_contract(pool: PgPool) {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;

    let f = setup(pool.clone()).await;
    pack(&pool).await;
    let router = api_gateway::attributes::router(f.app.clone());
    for path in [
        "/v1/admin/attribute-definitions?entity_type=product",
        "/v1/customer/profile",
        "/v1/customer/attribute-definitions",
    ] {
        let response = router
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), 401);
    }
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/admin/attribute-definitions")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    let response = router
        .oneshot(
            Request::builder()
                .uri("/v1/catalog/attribute-definitions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let value: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &value[0],
        &contract["components"]["schemas"]["AttributeDefinition"],
        &contract,
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn promotion_attributes_filter_real_lines(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let attrs = domain_attributes::Service { pool: pool.clone() };
    let mut definition = definition("product", "organic", "boolean");
    definition.used_for_promo_rules = true;
    attrs.save(definition).await.unwrap();
    let mut input = product_input(f.category, "ORGANIC", "10.00");
    input.attributes = json!({"organic":true});
    let product = domain_catalog::Service { pool: pool.clone() }
        .save_product(None, input)
        .await
        .unwrap();
    let promotions = domain_pricing_promotions::Service { pool: pool.clone() };
    let rule=promotions.save(None,serde_json::from_value(json!({"name":"Organic offer","scope":"catalog","kind":"percentage","value":"10","coupon_code":null,"min_subtotal":"0","skus":[],"category_ids":[],"customer_group":"all","priority":1,"active":true,"starts_at":null,"ends_at":null})).unwrap(),&f.who).await.unwrap();
    promotions
        .save_conditions(rule.id, json!({"organic":true}), &f.who)
        .await
        .unwrap();
    let lines = vec![
        domain_pricing_promotions::Line {
            product_id: product.id,
            sku: product.sku,
            category_id: Some(product.category_id),
            price: product.price,
            quantity: 1,
        },
        domain_pricing_promotions::Line {
            product_id: f.product.id,
            sku: f.product.sku,
            category_id: Some(f.category),
            price: f.product.price,
            quantity: 1,
        },
    ];
    let mut tx = domain_inventory::begin(&pool).await.unwrap();
    let assessment =
        domain_pricing_promotions::Service::assess(&mut tx, Some(f.customer), &lines, None, true)
            .await
            .unwrap();
    assert_eq!(assessment.amount.to_string(), "1.00");
    assert!(assessment.lines[1].is_empty());
}

#[sqlx::test(migrations = "../../migrations")]
async fn admin_profile_has_account_and_owned_addresses_and_requires_permission(pool: PgPool) {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    let f = setup(pool.clone()).await;
    for customer in [f.customer, f.other] {
        f.app.customers.save_location(customer, None, serde_json::from_value(json!({
            "label":"home","custom_label":"","latitude":30.0,"longitude":31.0,
            "formatted_address":format!("Address for {customer}"),"building":"1","floor":"2",
            "apartment":"3","delivery_instructions":"","is_default":true
        })).unwrap()).await.unwrap();
    }
    let role = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'profile-reader',ARRAY['customers.read'])").bind(role).execute(&pool).await.unwrap();
    sqlx::query("UPDATE admin_iam.admin_users SET role_id=$1 WHERE id=$2")
        .bind(role)
        .bind(f.who.user.id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest("profile-test")).bind(f.who.user.id).execute(&pool).await.unwrap();
    let router = api_gateway::attributes::router(f.app.clone());
    let uri = format!("/v1/admin/customers/{}/profile", f.customer);
    let response = router
        .clone()
        .oneshot(Request::builder().uri(&uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(&uri)
                .header("cookie", "admin_session=profile-test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let value: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(value["account"]["id"], f.customer.to_string());
    assert_eq!(value["account"]["verified"], true);
    assert_eq!(value["locations"].as_array().unwrap().len(), 1);
    assert_eq!(
        value["locations"][0]["formatted_address"],
        format!("Address for {}", f.customer)
    );
    assert!(value["account"].get("password_hash").is_none());
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &value,
        &contract["components"]["schemas"]["AdminCustomerProfile"],
        &contract,
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['catalog.read'] WHERE id=$1")
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    let response = router
        .oneshot(
            Request::builder()
                .uri(&uri)
                .header("cookie", "admin_session=profile-test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
}
