mod support;
use domain_catalog::{AttributeInput, CategoryInput, ProductInput, Service};
use infra_auth::Error;
use serde_json::json;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;
fn input(category_id: Uuid) -> ProductInput {
    serde_json::from_value(json!({"sku":"BAN-001","slug":"organic-bananas","name":"Organic Bananas","description":"Fresh bananas","price":"1.20","currency":"USD","unit":"lb","category_id":category_id,"attributes":{"organic":true},"media_ids":[],"active":true,"in_stock":true})).unwrap()
}
async fn category(s: &Service, name: &str, parent_id: Option<Uuid>) -> Uuid {
    s.save_category(
        None,
        CategoryInput {
            name: name.into(),
            slug: name.to_lowercase(),
            parent_id,
        },
    )
    .await
    .unwrap()
    .id
}
#[sqlx::test(migrations = "../../migrations")]
async fn catalog_invariants_and_outbox(pool: PgPool) {
    let s = Service { pool: pool.clone() };
    let root = category(&s, "Produce", None).await;
    let child = category(&s, "Fruits", Some(root)).await;
    assert!(s
        .save_category(
            Some(root),
            CategoryInput {
                name: "Produce".into(),
                slug: "produce".into(),
                parent_id: Some(child)
            }
        )
        .await
        .is_err());
    assert!(s.delete_category(root).await.is_err());
    let attr = s
        .save_attribute(
            None,
            AttributeInput {
                code: "organic".into(),
                name: "Organic".into(),
                kind: "boolean".into(),
                required: true,
            },
        )
        .await
        .unwrap();
    let p = s.save_product(None, input(child)).await.unwrap();
    assert!(p.entity_id > 0 && attr.entity_id > 0);
    assert_eq!(s.product(p.id).await.unwrap().entity_id, p.entity_id);
    assert_eq!(p.price.to_string(), "1.20");
    let mut i = input(child);
    i.price = "1.234".parse().unwrap();
    assert!(s.save_product(Some(p.id), i).await.is_err());
    let mut i = input(child);
    i.attributes = json!({"organic":"yes"});
    assert!(s.save_product(Some(p.id), i).await.is_err());
    let mut i = input(child);
    i.attributes = json!({});
    assert!(s.save_product(Some(p.id), i).await.is_err());
    let mut i = input(child);
    i.media_ids = vec![Uuid::new_v4()];
    assert!(s.save_product(Some(p.id), i).await.is_err());
    assert!(s.save_product(None, input(child)).await.is_err());
    assert!(matches!(
        s.delete_attribute(attr.id).await,
        Err(Error::Conflict)
    ));
    assert!(s
        .save_attribute(
            Some(attr.id),
            AttributeInput {
                code: "organic".into(),
                name: "Organic".into(),
                kind: "text".into(),
                required: true
            }
        )
        .await
        .is_err());
    assert!(s
        .save_attribute(
            None,
            AttributeInput {
                code: "brand".into(),
                name: "Brand".into(),
                kind: "text".into(),
                required: true
            }
        )
        .await
        .is_err());
    assert_eq!(s.attributes().await.unwrap().len(), 1);
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM platform.outbox WHERE event_type='catalog.product_updated'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
    s.delete_product(p.id).await.unwrap();
    assert!(matches!(s.product(p.id).await, Err(Error::NotFound)));
    s.delete_attribute(attr.id).await.unwrap();
    s.delete_category(child).await.unwrap();
    s.delete_category(root).await.unwrap();
}
#[sqlx::test(migrations = "../../migrations")]
async fn media_reference_protection(pool: PgPool) {
    let s = Service { pool };
    let cat = category(&s, "Fruit", None).await;
    let id = Uuid::new_v4();
    s.add_media(domain_catalog::Media {
        id,
        entity_id: 0,
        content_type: "image/png".into(),
        alt: "Bananas".into(),
        object_key: format!("catalog/{id}"),
        size_bytes: 100,
    })
    .await
    .unwrap();
    let mut i = input(cat);
    i.attributes = json!({});
    i.media_ids = vec![id];
    let p = s.save_product(None, i).await.unwrap();
    assert!(matches!(s.delete_media(id).await, Err(Error::Conflict)));
    s.update_media(id, "Organic bananas".into()).await.unwrap();
    s.delete_product(p.id).await.unwrap();
    s.delete_media(id).await.unwrap();
    assert!(matches!(s.media_by_id(id).await, Err(Error::NotFound)));
}
#[sqlx::test(migrations = "../../migrations")]
async fn category_concurrent_cycle_rejected(pool: PgPool) {
    let s = Service { pool };
    let a = category(&s, "A", None).await;
    let b = category(&s, "B", None).await;
    let (one, two) = tokio::join!(
        s.save_category(
            Some(a),
            CategoryInput {
                name: "A".into(),
                slug: "a".into(),
                parent_id: Some(b)
            }
        ),
        s.save_category(
            Some(b),
            CategoryInput {
                name: "B".into(),
                slug: "b".into(),
                parent_id: Some(a)
            }
        )
    );
    assert_ne!(one.is_ok(), two.is_ok());
}
#[sqlx::test(migrations = "../../migrations")]
async fn catalog_http_authorization_and_public_visibility(pool: PgPool) {
    use axum::{body::Body, http::Request, Router};
    use http_body_util::BodyExt;

    let security = infra_auth::Security::new(
        "catalog-test-secret".repeat(4),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let identity = api_gateway::identity::App::new(
        pool.clone(),
        security,
        vec!["http://localhost:5174".into()],
    );
    identity
        .admins
        .seed("admin@example.test", "Testing password 123!".into())
        .await
        .unwrap();
    let (who, token) = identity
        .admins
        .login(domain_admin_iam::Credentials {
            email: "admin@example.test".into(),
            password: "Testing password 123!".into(),
        })
        .await
        .unwrap();
    let s = Service { pool: pool.clone() };
    let cat = category(&s, "Fruit", None).await;
    let mut i = input(cat);
    i.attributes = json!({});
    i.active = false;
    let p = s.save_product(None, i).await.unwrap();
    let router: Router = api_gateway::catalog::router(api_gateway::catalog::App {
        identity: identity.clone(),
        catalog: s,
        search: domain_search_client::Client::new("http://localhost:1".into(), "test".into()),
        media: infra_media::Store::new("http://localhost:1".into(), "test", "test").unwrap(),
        analytics: api_gateway::analytics::Client::new(
            "http://localhost:1".into(),
            "test".into(),
            "test".into(),
        ),
    });
    async fn request(
        r: &Router,
        method: &str,
        path: &str,
        token: &str,
        body: serde_json::Value,
        csrf: bool,
    ) -> (u16, serde_json::Value) {
        let mut b = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .header("cookie", format!("admin_session={token}"));
        if csrf {
            b = b.header("x-commerce-request", "1");
        }
        let response = r
            .clone()
            .oneshot(b.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status().as_u16();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
        let contract_path = if path.starts_with("/v1/catalog/products/") {
            "/v1/catalog/products/{id}"
        } else {
            path
        };
        let responses = &contract["paths"][contract_path][method.to_lowercase()]["responses"];
        let response = responses
            .get(status.to_string())
            .unwrap_or(&responses["default"]);
        support::validate_shape(
            &body,
            &response["content"]["application/json"]["schema"],
            &contract,
        );
        (status, body)
    }
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/admin/catalog/products",
            "",
            json!({}),
            true
        )
        .await
        .0,
        401
    );
    assert_eq!(
        request(
            &router,
            "GET",
            &format!("/v1/catalog/products/{}", p.id),
            "",
            json!({}),
            true
        )
        .await
        .0,
        404
    );
    let list = request(
        &router,
        "GET",
        "/v1/admin/catalog/products",
        &token,
        json!({}),
        true,
    )
    .await;
    assert_eq!(list.0, 200);
    assert_eq!(list.1[0]["price"], "1.20");
    let body = json!({"name":"Dairy","slug":"dairy","parent_id":null});
    assert_eq!(
        request(
            &router,
            "POST",
            "/v1/admin/catalog/categories",
            &token,
            body.clone(),
            false
        )
        .await
        .0,
        403
    );
    let role = identity
        .admins
        .save_role(
            &who,
            None,
            domain_admin_iam::RoleInput {
                name: "Catalog reader".into(),
                permissions: vec!["catalog.read".into()],
            },
        )
        .await
        .unwrap();
    identity
        .admins
        .save_user(
            &who,
            None,
            domain_admin_iam::UserInput {
                email: "reader@example.test".into(),
                name: "Reader".into(),
                role_id: role.id,
                password: Some("Testing password 123!".into()),
                active: true,
            },
        )
        .await
        .unwrap();
    let (_, reader) = identity
        .admins
        .login(domain_admin_iam::Credentials {
            email: "reader@example.test".into(),
            password: "Testing password 123!".into(),
        })
        .await
        .unwrap();
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/admin/catalog/products",
            &reader,
            json!({}),
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
            "/v1/admin/catalog/categories",
            &reader,
            body.clone(),
            true
        )
        .await
        .0,
        403
    );
    assert_eq!(
        request(
            &router,
            "POST",
            "/v1/admin/catalog/categories",
            &token,
            body,
            true
        )
        .await
        .0,
        201
    );
    // Requests larger than the JSON limit reach image validation on the upload route.
    let boundary = "catalog-test-upload";
    let body=format!("--{boundary}\r\nContent-Disposition: form-data; name=\"alt\"\r\n\r\nTest\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"bad.png\"\r\nContent-Type: image/png\r\n\r\n{}\r\n--{boundary}--\r\n", "x".repeat(32000));
    let request = Request::builder()
        .method("POST")
        .uri("/v1/admin/catalog/media")
        .header("cookie", format!("admin_session={token}"))
        .header("x-commerce-request", "1")
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))
        .unwrap();
    let response = router.oneshot(request).await.unwrap();
    assert_eq!(response.status(), 400);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(body["error"].as_str().unwrap().contains("Use a PNG"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn category_images_are_validated_exposed_and_clearable(pool: PgPool) {
    let s = Service { pool };
    let cat = category(&s, "Images", None).await;
    let thumbnail = Uuid::new_v4();
    let banner = Uuid::new_v4();
    for id in [thumbnail, banner] {
        s.add_media(domain_catalog::Media {
            id,
            entity_id: 0,
            content_type: "image/png".into(),
            alt: "Category image".into(),
            object_key: format!("catalog/{id}"),
            size_bytes: 100,
        })
        .await
        .unwrap();
    }
    assert!(s
        .category_values(cat, json!({"banner": Uuid::new_v4()}))
        .await
        .is_err());
    s.category_values(cat, json!({"thumbnail": thumbnail, "banner": banner}))
        .await
        .unwrap();
    let categories = s.categories().await.unwrap();
    let saved = categories.iter().find(|c| c.id == cat).unwrap();
    assert_eq!(saved.thumbnail, Some(thumbnail.to_string()));
    assert_eq!(saved.banner, Some(banner.to_string()));
    assert!(matches!(s.delete_media(banner).await, Err(Error::Conflict)));
    let updated = s
        .save_category(
            Some(cat),
            CategoryInput {
                name: "Updated".into(),
                slug: "updated".into(),
                parent_id: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(updated.banner, Some(banner.to_string()));
    s.category_values(cat, json!({})).await.unwrap();
    let categories = s.categories().await.unwrap();
    let cleared = categories.iter().find(|c| c.id == cat).unwrap();
    assert!(cleared.thumbnail.is_none());
    assert!(cleared.banner.is_none());
    s.delete_media(banner).await.unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn storefront_bestsellers_use_completed_sales_and_hide_inactive_products(pool: PgPool) {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    let service = Service { pool: pool.clone() };
    let category_id = category(&service, "Best sellers", None).await;
    let mut expected = Vec::new();
    for (index, quantity, status, active) in [
        (0, 4, "delivered", true),
        (1, 8, "cash_collected", true),
        (2, 100, "cancelled", true),
        (3, 200, "delivered", false),
    ] {
        let mut value = input(category_id);
        value.sku = format!("bestseller-{index}");
        value.slug = value.sku.clone();
        value.active = active;
        value.attributes = json!({});
        let product = service.save_product(None, value).await.unwrap();
        if index < 2 {
            expected.insert(0, product.id);
        }
        let order = Uuid::new_v4();
        sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency,created_at) VALUES($1,$2,$3,$4,$5,'{}','{}',1000,0,1000,'USD',date_trunc('day',now()))")
            .bind(order).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(status).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO orders.order_items(order_id,product_id,sku,name,unit,quantity,price,line_total) VALUES($1,$2,'fixture','Fixture','each',$3,1,$3)")
            .bind(order).bind(product.id).bind(quantity).execute(&pool).await.unwrap();
    }
    let security = infra_auth::Security::new(
        "bestseller-test-secret".repeat(4),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let router = api_gateway::catalog::router(api_gateway::catalog::App {
        identity: api_gateway::identity::App::new(pool, security, vec![]),
        catalog: service,
        search: domain_search_client::Client::new("http://localhost:1".into(), "test".into()),
        media: infra_media::Store::new("http://localhost:1".into(), "test", "test").unwrap(),
        analytics: api_gateway::analytics::Client::new(
            "http://localhost:1".into(),
            "test".into(),
            "test".into(),
        ),
    });
    for (query, status, count) in [
        ("period=today", 200, 2),
        ("period=today&limit=1", 200, 1),
        ("period=last_year", 200, 0),
        ("period=today&limit=25", 400, 0),
        ("period=forever", 400, 0),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::get(format!("/v1/catalog/bestsellers?{query}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), status, "{query}");
        if status != 200 {
            continue;
        }
        assert!(response.headers()["cache-control"]
            .to_str()
            .unwrap()
            .contains("no-store"));
        let body: serde_json::Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        let ids: Vec<_> = body["products"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["id"].as_str().unwrap().parse::<Uuid>().unwrap())
            .collect();
        assert_eq!(ids, expected[..count]);
        assert_eq!(body["metric"], "completed_order_units");
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
        support::validate_shape(
            &body,
            &contract["components"]["schemas"]["BestsellerResults"],
            &contract,
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn storefront_prices_use_live_catalog_promotions_without_changing_base_price(pool: PgPool) {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    let service = Service { pool: pool.clone() };
    let category_id = category(&service, "Sale", None).await;
    let mut value = input(category_id);
    value.attributes = json!({});
    let product = service.save_product(None, value).await.unwrap();
    let rule = Uuid::new_v4();
    sqlx::query("INSERT INTO pricing_promotions.rules(id,name,scope,kind,value,min_subtotal,skus,category_ids,customer_group,priority,active) VALUES($1,'Sale','catalog','percentage',25,0,'{}','{}','all',1,true)").bind(rule).execute(&pool).await.unwrap();
    let security = infra_auth::Security::new(
        "promotion-display-test".repeat(4),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let router = api_gateway::catalog::router(api_gateway::catalog::App {
        identity: api_gateway::identity::App::new(pool.clone(), security, vec![]),
        catalog: service,
        search: domain_search_client::Client::new("http://localhost:1".into(), "test".into()),
        media: infra_media::Store::new("http://localhost:1".into(), "test", "test").unwrap(),
        analytics: api_gateway::analytics::Client::new(
            "http://localhost:1".into(),
            "test".into(),
            "test".into(),
        ),
    });
    for (update, expected) in [
        ("UPDATE pricing_promotions.rules SET value=25", Some("0.90")),
        ("UPDATE pricing_promotions.rules SET value=50", Some("0.60")),
        ("UPDATE pricing_promotions.rules SET customer_group='registered'", None),
        ("UPDATE pricing_promotions.rules SET customer_group='all',ends_at=now()-interval '1 minute'", None),
        ("UPDATE pricing_promotions.rules SET ends_at=NULL,scope='cart'", None),
    ] {
        sqlx::query(update).execute(&pool).await.unwrap();
        let response = router.clone().oneshot(Request::get(format!("/v1/catalog/products/{}", product.id)).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), 200);
        assert!(response.headers()["cache-control"].to_str().unwrap().contains("no-store"));
        let body: serde_json::Value = serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(body["price"], "1.20");
        if let Some(price) = expected {
            assert_eq!(body["catalog_offer"]["discounted_price"], price);
            assert_eq!(body["catalog_offer"]["original_price"], "1.20");
        } else { assert!(body.get("catalog_offer").is_none()); }
        let contract: serde_json::Value = serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
        support::validate_shape(&body, &contract["components"]["schemas"]["Product"], &contract);
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn product_multiple_categories_are_validated_preserved_and_removable(pool: PgPool) {
    let s = Service { pool: pool.clone() };
    let input = |id| {
        let mut value = input(id);
        value.attributes = json!({});
        value
    };
    let primary = category(&s, "Bakery", None).await;
    let secondary = category(&s, "Breakfast", None).await;
    let mut value = input(primary);
    value.category_ids = Some(vec![secondary, secondary]);
    let p = s.save_product(None, value).await.unwrap();
    assert_eq!(p.category_ids.len(), 2);
    assert!(p.category_ids.contains(&primary) && p.category_ids.contains(&secondary));
    assert_eq!(
        s.index_page(Some(secondary), Uuid::nil())
            .await
            .unwrap()
            .len(),
        1
    );
    let mut connection = pool.acquire().await.unwrap();
    assert_eq!(
        domain_catalog::public::products(&mut connection, Some(secondary), 1)
            .await
            .unwrap()
            .len(),
        1
    );
    drop(connection);
    let memberships: i64 =
        sqlx::query_scalar("SELECT count(*) FROM catalog.product_categories WHERE product_id=$1")
            .bind(p.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(memberships, 2);
    assert!(s.delete_category(secondary).await.is_err());
    let unchanged = s.save_product(Some(p.id), input(primary)).await.unwrap();
    assert_eq!(unchanged.category_ids, p.category_ids);
    let mut invalid = input(primary);
    invalid.category_ids = Some(vec![Uuid::new_v4()]);
    assert!(matches!(
        s.save_product(Some(p.id), invalid).await,
        Err(Error::Invalid(_))
    ));
    assert_eq!(s.product(p.id).await.unwrap().category_ids, p.category_ids);
    let mut clear = input(primary);
    clear.category_ids = Some(vec![]);
    let cleared = s.save_product(Some(p.id), clear).await.unwrap();
    assert_eq!(cleared.category_ids, vec![primary]);
    s.delete_category(secondary).await.unwrap();
    // Older integrations writing only category_id still get the same invariant.
    let stored: Vec<Uuid> =
        sqlx::query_scalar("SELECT category_ids FROM catalog.products WHERE id=$1")
            .bind(p.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored, vec![primary]);
}
