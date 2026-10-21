mod support;
use api_gateway::identity::App;
use domain_admin_iam::Identity;
use serde_json::{json, Value};
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
fn content(version: i32, title: &str) -> domain_cms::Input {
    serde_json::from_value(json!({"key":"home","kind":"home","expected_version":version,"title":title,"blocks":[{"kind":"hero","heading":title,"text":"Hello <script>alert(1)</script>","image_id":null,"link_label":"Shop","link_url":"/search"}]})).unwrap()
}
#[sqlx::test(migrations = "../../migrations")]
async fn cms_versions_scheduling_expiry_and_permissions(pool: PgPool) {
    let mut f = setup(pool.clone()).await;
    let s = domain_cms::Service { pool: pool.clone() };
    let a = s.save(content(0, "First"), &f.who).await.unwrap();
    assert!(s.published("home").await.unwrap().is_none());
    let publish = |r, start, end| domain_cms::Publish {
        revision_id: r,
        starts_at: start,
        ends_at: end,
    };
    s.publish(a.document_id, publish(Some(a.id), None, None), &f.who)
        .await
        .unwrap();
    assert_eq!(s.published("home").await.unwrap().unwrap().title, "First");
    let b = s.save(content(1, "Second"), &f.who).await.unwrap();
    assert_eq!(s.published("home").await.unwrap().unwrap().title, "First");
    assert!(s.save(content(1, "Stale"), &f.who).await.is_err());
    let start = chrono::Utc::now() + chrono::Duration::hours(1);
    let end = start + chrono::Duration::hours(1);
    let release = s
        .publish(
            a.document_id,
            publish(Some(b.id), Some(start), Some(end)),
            &f.who,
        )
        .await
        .unwrap();
    assert_eq!(s.published("home").await.unwrap().unwrap().title, "First");
    // Advance the second release while keeping the first activation earlier.
    sqlx::query("UPDATE cms.releases SET starts_at=clock_timestamp()-interval '1 day' WHERE document_id=$1 AND id<>$2").bind(a.document_id).bind(release.id).execute(&pool).await.unwrap();
    sqlx::query("UPDATE cms.releases SET starts_at=clock_timestamp()-interval '1 second',ends_at=clock_timestamp()+interval '1 hour' WHERE id=$1").bind(release.id).execute(&pool).await.unwrap();
    assert_eq!(s.published("home").await.unwrap().unwrap().title, "Second");
    sqlx::query(
        "UPDATE cms.releases SET ends_at=clock_timestamp()-interval '0.5 seconds' WHERE id=$1",
    )
    .bind(release.id)
    .execute(&pool)
    .await
    .unwrap();
    assert!(s.published("home").await.unwrap().is_none());
    s.publish(a.document_id, publish(Some(a.id), None, None), &f.who)
        .await
        .unwrap();
    s.publish(a.document_id, publish(None, None, None), &f.who)
        .await
        .unwrap();
    assert!(s.published("home").await.unwrap().is_none());
    assert_eq!(s.detail(a.document_id).await.unwrap().revisions.len(), 2);
    let mut bad = content(2, "Bad link");
    bad.blocks[0].link_url = "javascript:alert(1)".into();
    assert!(s.save(bad, &f.who).await.is_err());
    f.who.permissions = vec!["cms.read".into()];
    assert!(s.save(content(2, "No access"), &f.who).await.is_err());
    assert!(s
        .publish(a.document_id, publish(Some(a.id), None, None), &f.who)
        .await
        .is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn cms_drafts_protect_media_and_pending_release_replacement(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let s = domain_cms::Service { pool: pool.clone() };
    let media = Uuid::new_v4();
    sqlx::query("INSERT INTO catalog.media(id,content_type,alt,object_key,size_bytes) VALUES($1,'image/png','test','test',10)").bind(media).execute(&pool).await.unwrap();
    let mut i = content(0, "Image");
    i.blocks[0].image_id = Some(media);
    let r = s.save(i, &f.who).await.unwrap();
    assert!(domain_catalog::Service { pool: pool.clone() }
        .delete_media(media)
        .await
        .is_err());
    let start = chrono::Utc::now() + chrono::Duration::hours(1);
    s.publish(
        r.document_id,
        domain_cms::Publish {
            revision_id: Some(r.id),
            starts_at: Some(start),
            ends_at: None,
        },
        &f.who,
    )
    .await
    .unwrap();
    s.publish(
        r.document_id,
        domain_cms::Publish {
            revision_id: None,
            starts_at: None,
            ends_at: None,
        },
        &f.who,
    )
    .await
    .unwrap();
    let d = s.detail(r.document_id).await.unwrap();
    assert_eq!(d.releases.iter().filter(|r| r.cancelled).count(), 1);
    assert!(s.published("home").await.unwrap().is_none());
    let contract: Value = serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &json!(d),
        &contract["components"]["schemas"]["ContentDetail"],
        &contract,
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn bulk_120_products_one_audit_exact_prices_and_rollback(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let s = domain_admin_operations::Service { pool: pool.clone() };
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let mut ids = vec![];
    for n in 0..120 {
        ids.push(
            catalog
                .save_product(
                    None,
                    product_input(f.category, &format!("BULK-{n:03}"), "1.05"),
                )
                .await
                .unwrap()
                .id,
        );
    }
    let batch=s.bulk(serde_json::from_value(json!({"ids":ids,"category_id":null,"active":false,"price_adjustment_pct":"10","reason":"120 item test"})).unwrap(),&f.who).await.unwrap();
    assert_eq!(batch.count, 120);
    let rows = s
        .products(serde_json::from_value(json!({"q":"BULK-","active":false})).unwrap())
        .await
        .unwrap();
    assert_eq!(rows.total, 120);
    assert_eq!(rows.items.len(), 100);
    assert!(rows.items.iter().all(|p| p.price.to_string() == "1.16"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM admin_iam.audit_log WHERE action='admin.catalog.bulk_updated'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    let failure=s.bulk(serde_json::from_value(json!({"ids":ids,"category_id":Uuid::new_v4(),"active":true,"price_adjustment_pct":null,"reason":"Invalid category"})).unwrap(),&f.who).await;
    assert!(failure.is_err());
    assert!(!catalog.product(ids[0]).await.unwrap().active);
    let audits = f
        .app
        .admins
        .search_audits(&f.who, "120 item test", 0)
        .await
        .unwrap();
    assert_eq!(audits.len(), 1);
    assert_eq!(audits[0].entity_id, batch.operation_id);
}
#[sqlx::test(migrations = "../../migrations")]
async fn csv_preview_roundtrip_create_update_formula_and_atomic_failure(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let s = domain_admin_operations::Service { pool: pool.clone() };
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let mut p = product_input(f.category, "FORMULA", "2.00");
    p.name = "=not-a-formula".into();
    p.description = "Two lines\nwith a comma, and \"quotes\"".into();
    let p = catalog.save_product(None, p).await.unwrap();
    let csv = s
        .export(
            "catalog",
            domain_admin_operations::Filter::default(),
            &f.who,
        )
        .await
        .unwrap();
    assert!(csv.contains("'=not-a-formula"));
    let before_events: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.outbox")
        .fetch_one(&pool)
        .await
        .unwrap();
    let request = |csv: String, preview| domain_admin_operations::Import {
        csv,
        preview,
        reason: "CSV test".into(),
    };
    let preview = s
        .import("catalog", request(csv.clone(), true), &f.who)
        .await
        .unwrap();
    assert_eq!(preview.count, 2);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM platform.outbox")
            .fetch_one(&pool)
            .await
            .unwrap(),
        before_events
    );
    s.import("catalog", request(csv, false), &f.who)
        .await
        .unwrap();
    let after = catalog.product(p.id).await.unwrap();
    assert_eq!(after.name, p.name);
    assert_eq!(after.description, p.description);
    let valid=format!("sku,slug,name,description,price,currency,unit,category_id,attributes,media_ids,active\nNEW,new,New,New,5.00,USD,each,{},{{}},[],true\n",f.category);
    let bad=valid.clone()+"BASE,base,Base,Test,not-money,USD,each,00000000-0000-0000-0000-000000000000,{},[],true\n";
    assert!(s
        .import("catalog", request(bad, false), &f.who)
        .await
        .is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM catalog.products WHERE sku='NEW'")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    s.import("catalog", request(valid, false), &f.who)
        .await
        .unwrap();
}
#[sqlx::test(migrations = "../../migrations")]
async fn inventory_csv_reservation_protection_and_saved_filter_ownership(pool: PgPool) {
    let mut f = setup(pool.clone()).await;
    let s = domain_admin_operations::Service { pool: pool.clone() };
    f.app
        .cart
        .inventory
        .adjust(f.product.id, 10, f.who.user.id, "Stock".into())
        .await
        .unwrap();
    f.app.cart.open(Some(f.customer), "").await.unwrap();
    f.app
        .cart
        .set(Some(f.customer), "", f.product.clone(), 4, true)
        .await
        .unwrap();
    let i = |amount, preview| domain_admin_operations::Import {
        csv: format!("sku,on_hand,reason\nBASE,{amount},Counted\n"),
        preview,
        reason: "Count".into(),
    };
    assert!(s.import("inventory", i(3, false), &f.who).await.is_err());
    assert_eq!(
        f.app
            .cart
            .inventory
            .stock(f.product.id)
            .await
            .unwrap()
            .on_hand,
        10
    );
    s.import("inventory", i(9, true), &f.who).await.unwrap();
    assert_eq!(
        f.app
            .cart
            .inventory
            .stock(f.product.id)
            .await
            .unwrap()
            .on_hand,
        10
    );
    s.import("inventory", i(9, false), &f.who).await.unwrap();
    assert_eq!(
        f.app
            .cart
            .inventory
            .stock(f.product.id)
            .await
            .unwrap()
            .on_hand,
        9
    );
    let saved = s
        .save_filter(
            f.who.user.id,
            "My filter",
            domain_admin_operations::Filter {
                q: "BASE".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(s.filters(f.other).await.unwrap().is_empty());
    s.delete_filter(f.other, saved.id).await.unwrap();
    assert_eq!(s.filters(f.who.user.id).await.unwrap().len(), 1);
    f.who.permissions = vec!["catalog.read".into()];
    assert!(s.import("inventory", i(8, false), &f.who).await.is_err());
    assert!(s
        .export("catalog", Default::default(), &f.who)
        .await
        .is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn review_moderation_edit_race_and_wishlist_isolation(pool: PgPool) {
    let mut f = setup(pool.clone()).await;
    let s = domain_reviews::Service { pool: pool.clone() };
    let i = || domain_reviews::Input {
        display_name: "Tester".into(),
        rating: 5,
        title: "Fresh".into(),
        body: "Very fresh".into(),
    };
    let r = s.submit(f.customer, f.product.id, i()).await.unwrap();
    assert!(s.public(f.product.id, 0).await.unwrap().is_empty());
    let edit = s.submit(f.customer, f.product.id, i()).await.unwrap();
    let mod_input = |v, status: &str| domain_reviews::Moderation {
        status: status.into(),
        reason: "Reviewed".into(),
        expected_version: v,
    };
    assert!(s
        .moderate(r.id, mod_input(r.version, "approved"), &f.who)
        .await
        .is_err());
    s.moderate(r.id, mod_input(edit.version, "approved"), &f.who)
        .await
        .unwrap();
    let public = s.public(f.product.id, 0).await.unwrap();
    assert_eq!(public.len(), 1);
    assert!(json!(public[0]).get("customer_id").is_none());
    let second = s.submit(f.other, f.product.id, i()).await.unwrap();
    s.moderate(second.id, mod_input(second.version, "rejected"), &f.who)
        .await
        .unwrap();
    assert_eq!(s.public(f.product.id, 0).await.unwrap().len(), 1);
    s.submit(f.customer, f.product.id, i()).await.unwrap();
    assert!(s.public(f.product.id, 0).await.unwrap().is_empty());
    s.wish(f.customer, f.product.id, true).await.unwrap();
    s.wish(f.customer, f.product.id, true).await.unwrap();
    assert_eq!(
        s.wishlist_ids(f.customer).await.unwrap(),
        vec![f.product.id]
    );
    assert!(s.wishlist_ids(f.other).await.unwrap().is_empty());
    s.wish(f.other, f.product.id, false).await.unwrap();
    assert_eq!(s.wishlist_ids(f.customer).await.unwrap().len(), 1);
    f.who.permissions = vec!["reviews.read".into()];
    assert!(s
        .moderate(second.id, mod_input(second.version + 1, "approved"), &f.who)
        .await
        .is_err());
    let contract: Value = serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &json!(public[0]),
        &contract["components"]["schemas"]["PublicReview"],
        &contract,
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn m7_http_auth_policy_and_public_contract(pool: PgPool) {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;

    let f = setup(pool.clone()).await;
    let router = api_gateway::admin_depth::router(f.app.clone());
    for path in [
        "/v1/admin/content",
        "/v1/admin/reviews",
        "/v1/admin/operations/products",
        "/v1/customer/wishlist",
    ] {
        let res = router
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), 401, "{path}");
    }
    let res = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/admin/content")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    let response = router
        .oneshot(
            Request::builder()
                .uri("/v1/content/home")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap(),
        Value::Null
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn csv_rejects_malformed_duplicates_and_limits_without_writes(pool: PgPool) {
    let f = setup(pool.clone()).await;
    let service = domain_admin_operations::Service { pool: pool.clone() };
    let header =
        "sku,slug,name,description,price,currency,unit,category_id,attributes,media_ids,active\n";
    let row = format!(
        "NEW,new,New,Description,5.00,USD,each,{},{{}},[],true\n",
        f.category
    );
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.outbox")
        .fetch_one(&pool)
        .await
        .unwrap();
    for data in [
        header.to_string(),
        format!("{header}{row}{row}"),
        format!("{header}missing,columns\n"),
        format!(
            "{header}{row}bad,bad,Bad,Description,5.00,USD,each,{},invalid-json,[],true\n",
            f.category
        ),
        format!("{header}{}", "x".repeat(2 * 1024 * 1024)),
        format!("{}{}", header.replace("slug", "sku"), row),
        format!(
            "{header}{}",
            (0..501)
                .map(|i| row
                    .replace("NEW", &format!("SKU{i}"))
                    .replace(",new,", &format!(",slug{i},")))
                .collect::<String>()
        ),
    ] {
        assert!(service
            .import(
                "catalog",
                domain_admin_operations::Import {
                    csv: data,
                    preview: false,
                    reason: "Validation regression".into()
                },
                &f.who
            )
            .await
            .is_err());
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM catalog.products WHERE sku='NEW'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 0);
        let events: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.outbox")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(events, before);
    }
    let preview = service
        .import(
            "catalog",
            domain_admin_operations::Import {
                csv: format!("\u{feff}{header}{row}"),
                preview: true,
                reason: "BOM input".into(),
            },
            &f.who,
        )
        .await
        .unwrap();
    assert_eq!(preview.count, 1);
}
