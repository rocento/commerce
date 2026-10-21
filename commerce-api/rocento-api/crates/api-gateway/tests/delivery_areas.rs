use domain_cart_checkout::Service as Carts;
use domain_inventory::{
    areas::{AreaInput, AreaLink, Pin},
    msi::{SourceInput, SourceItemInput, SourceLink, StockInput},
    Service as Inventory,
};
use serde_json::json;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;
async fn fixture(pool: PgPool) -> (Carts, domain_catalog::Product, Uuid, Uuid, Uuid) {
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            serde_json::from_value(json!({"name":"Fruit","slug":"fruit","parent_id":null}))
                .unwrap(),
        )
        .await
        .unwrap();
    let product=catalog.save_product(None,serde_json::from_value(json!({"sku":"M13","name":"Local fruit","slug":"local-fruit","description":"Test","price":"2.00","currency":"USD","unit":"each","category_id":category.id,"attributes":{},"media_ids":[],"active":true,"in_stock":true})).unwrap()).await.unwrap();
    let inventory = Inventory::new(pool.clone(), 900).unwrap();
    let actor = Uuid::new_v4();
    let source = inventory
        .save_source(
            None,
            SourceInput {
                code: "zone_b".into(),
                name: "B warehouse".into(),
                is_enabled: true,
                address: "".into(),
                latitude: Some(31.),
                longitude: Some(31.),
                contact_name: "".into(),
                contact_phone: "".into(),
                priority: 0,
            },
            actor,
        )
        .await
        .unwrap();
    let stock = inventory
        .save_stock(
            None,
            StockInput {
                code: "zone_b".into(),
                name: "B stock".into(),
                is_default: false,
                is_global: false,
                sources: vec![SourceLink {
                    source_id: source.id,
                    priority: 0,
                }],
            },
            actor,
        )
        .await
        .unwrap();
    inventory
        .adjust(product.id, 3, actor, "A fixture".into())
        .await
        .unwrap();
    let before = inventory.source_items(product.id).await.unwrap();
    assert!(
        !before
            .iter()
            .find(|i| i.source_id == source.id)
            .unwrap()
            .is_assigned
    );
    inventory
        .adjust_source(
            product.id,
            SourceItemInput {
                source_id: source.id,
                quantity: 0,
                status: "in_stock".into(),
                notify_stock_qty: 0,
                reason: "B fixture".into(),
            },
            actor,
        )
        .await
        .unwrap();
    let after = inventory.source_items(product.id).await.unwrap();
    let assigned = after.iter().find(|i| i.source_id == source.id).unwrap();
    assert!(
        assigned.is_assigned,
        "Zero quantity is still a persisted assignment"
    );
    assert_eq!(assigned.quantity, 0);
    let a = inventory
        .save_area(None, area("A", 30., vec![Uuid::from_u128(1)]), actor)
        .await
        .unwrap();
    let b = inventory
        .save_area(None, area("B", 31., vec![stock]), actor)
        .await
        .unwrap();
    (Carts { pool, inventory }, product, a, b, source.id)
}
fn area(name: &str, lat: f64, stocks: Vec<Uuid>) -> AreaInput {
    AreaInput {
        name: name.into(),
        center_lat: lat,
        center_lng: 31.,
        radius_km: 10.,
        boundary: None,
        priority: 0,
        is_active: true,
        stocks: stocks
            .into_iter()
            .enumerate()
            .map(|(i, stock_id)| AreaLink {
                stock_id,
                priority: i as i32,
            })
            .collect(),
    }
}
fn pin(lat: f64) -> Option<Pin> {
    Some(Pin {
        latitude: lat,
        longitude: 31.,
    })
}
#[sqlx::test(migrations = "../../migrations")]
async fn pin_switch_releases_holds_and_blocks_uncovered_cart(pool: PgPool) {
    let (c, p, a, b, _) = fixture(pool.clone()).await;
    assert_eq!(c.inventory.area_available(a, p.id).await.unwrap(), 3);
    assert_eq!(c.inventory.area_available(b, p.id).await.unwrap(), 0);
    let guest = c.open(None, "").await.unwrap().guest_token.unwrap();
    assert!(c.set(None, &guest, p.clone(), 1, true).await.is_err());
    c.set_delivery(None, &guest, pin(30.)).await.unwrap();
    assert!(
        c.set(None, &guest, p.clone(), 2, true)
            .await
            .unwrap()
            .fully_reserved
    );
    assert_eq!(c.inventory.area_available(a, p.id).await.unwrap(), 1);
    assert_eq!(
        c.inventory.available_stocks(p.id).await.unwrap(),
        vec![Uuid::from_u128(1)]
    );
    let cart = c.set_delivery(None, &guest, pin(31.)).await.unwrap();
    assert!(!cart.fully_reserved);
    assert_eq!(cart.items[0].reserved_quantity, 0);
    assert_eq!(cart.items[0].available, 0);
    assert_eq!(c.inventory.area_available(a, p.id).await.unwrap(), 3);
    assert!(c.set(None, &guest, p.clone(), 1, false).await.is_err());
    c.set_delivery(None, &guest, pin(-20.)).await.unwrap();
    assert!(c.set(None, &guest, p.clone(), 1, false).await.is_err());
    assert!(!c.inventory.delivery(pin(-20.)).await.unwrap().deliverable);
    c.set_delivery(None, &guest, pin(30.)).await.unwrap();
    assert!(c.open(None, &guest).await.unwrap().cart.fully_reserved);
}
#[sqlx::test(migrations = "../../migrations")]
async fn shared_sources_not_double_counted_and_stock_priority_preserved(pool: PgPool) {
    let (c, p, a, _, source) = fixture(pool.clone()).await;
    let actor = Uuid::new_v4();
    c.inventory
        .adjust_source(
            p.id,
            SourceItemInput {
                source_id: source,
                quantity: 4,
                status: "in_stock".into(),
                notify_stock_qty: 0,
                reason: "B stock".into(),
            },
            actor,
        )
        .await
        .unwrap();
    let bstock: Uuid = sqlx::query_scalar("SELECT id FROM inventory.stocks WHERE code='zone_b'")
        .fetch_one(&pool)
        .await
        .unwrap();
    let shared = c
        .inventory
        .save_stock(
            None,
            StockInput {
                code: "shared".into(),
                name: "Shared".into(),
                is_default: false,
                is_global: false,
                sources: vec![SourceLink {
                    source_id: source,
                    priority: 0,
                }],
            },
            actor,
        )
        .await
        .unwrap();
    c.inventory
        .save_area(
            Some(a),
            area("A", 30., vec![bstock, shared, Uuid::from_u128(1)]),
            actor,
        )
        .await
        .unwrap();
    assert_eq!(c.inventory.area_available(a, p.id).await.unwrap(), 7);
    let session = c.open(None, "").await.unwrap();
    let guest = session.guest_token.unwrap();
    c.set_delivery(None, &guest, pin(30.)).await.unwrap();
    assert!(c.set(None, &guest, p.clone(), 8, true).await.is_err());
    c.set(None, &guest, p.clone(), 5, true).await.unwrap();
    let allocations:Vec<(Uuid,Uuid,i32)>=sqlx::query_as("SELECT source_id,stock_id,quantity FROM inventory.reservation_allocations WHERE cart_id=$1 ORDER BY quantity DESC").bind(session.cart.id).fetch_all(&pool).await.unwrap();
    assert_eq!(
        allocations,
        vec![
            (source, bstock, 4),
            (Uuid::from_u128(1), Uuid::from_u128(1), 1)
        ]
    );
    assert_eq!(c.inventory.area_available(a, p.id).await.unwrap(), 2);
}
#[sqlx::test(migrations = "../../migrations")]
async fn checkout_revalidates_owned_destination_and_changed_coverage(pool: PgPool) {
    let (c, p, a, _, _) = fixture(pool.clone()).await;
    let customer = Uuid::new_v4();
    let location = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash,verified) VALUES($1,'m13@example.test','email','unused',true)").bind(customer).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO customers.customer_locations(id,customer_id,label,latitude,longitude,formatted_address) VALUES($1,$2,'home',30,31,'Test destination')").bind(location).bind(customer).execute(&pool).await.unwrap();
    c.open(Some(customer), "").await.unwrap();
    c.set_delivery(Some(customer), "", pin(30.)).await.unwrap();
    c.set(Some(customer), "", p.clone(), 1, true).await.unwrap();
    let quote = c.quote(customer, location).await.unwrap();
    let mut changed = area("A", 30., vec![Uuid::from_u128(1)]);
    changed.is_active = false;
    c.inventory
        .save_area(Some(a), changed, Uuid::new_v4())
        .await
        .unwrap();
    assert!(c.place(customer, quote.id, Uuid::new_v4()).await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM orders.orders")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    c.inventory
        .save_area(
            Some(a),
            area("A", 30., vec![Uuid::from_u128(1)]),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    sqlx::query("UPDATE customers.customer_locations SET latitude=31 WHERE id=$1")
        .bind(location)
        .execute(&pool)
        .await
        .unwrap();
    assert!(c.quote(customer, location).await.is_err());
    sqlx::query("UPDATE customers.customer_locations SET latitude=30 WHERE id=$1")
        .bind(location)
        .execute(&pool)
        .await
        .unwrap();
    let quote = c.quote(customer, location).await.unwrap();
    let key = Uuid::new_v4();
    let order = c.place(customer, quote.id, key).await.unwrap();
    assert_eq!(
        c.place(customer, quote.id, key).await.unwrap().order.id,
        order.order.id
    );
    assert_eq!(c.inventory.area_available(a, p.id).await.unwrap(), 2);
}
#[sqlx::test(migrations = "../../migrations")]
async fn area_resolver_http_and_admin_permission_boundary(pool: PgPool) {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;

    let (c, _, a, _, _) = fixture(pool.clone()).await;
    let security = infra_auth::Security::new(
        "test-secret-at-least-32-characters-long".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let app = api_gateway::identity::App::new(pool, security, vec!["http://localhost:5173".into()]);
    let router = api_gateway::cart::router(app);
    let r = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/delivery-area")
                .header("x-delivery-latitude", "30")
                .header("x-delivery-longitude", "31")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["area_id"], a.to_string());
    let r = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/delivery-area")
                .header("x-delivery-latitude", "NaN")
                .header("x-delivery-longitude", "31")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    let r = router
        .oneshot(
            Request::builder()
                .uri("/v1/admin/inventory/delivery-areas")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    assert!(!c.inventory.delivery(None).await.unwrap().deliverable);
}

#[sqlx::test(migrations = "../../migrations")]
async fn catalog_product_is_browsable_without_a_delivery_pin(pool: PgPool) {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        Router,
    };

    let (_, product, _, _, _) = fixture(pool.clone()).await;
    let security = infra_auth::Security::new(
        "test-secret-at-least-32-characters-long".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let identity = api_gateway::identity::App::new(
        pool.clone(),
        security,
        vec!["http://localhost:5173".into()],
    );
    let router: Router = api_gateway::catalog::router(api_gateway::catalog::App {
        identity,
        catalog: domain_catalog::Service { pool },
        search: domain_search_client::Client::new("http://localhost:1".into(), "test".into()),
        media: infra_media::Store::new("http://localhost:1".into(), "test", "test").unwrap(),
        analytics: api_gateway::analytics::Client::new(
            "http://localhost:1".into(),
            "test".into(),
            "test".into(),
        ),
    });
    let path = format!("/v1/catalog/products/{}", product.id);
    let without_pin = router
        .clone()
        .oneshot(Request::builder().uri(&path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(without_pin.status(), StatusCode::OK);
    let outside_area = router
        .oneshot(
            Request::builder()
                .uri(path)
                .header("x-delivery-latitude", "-20")
                .header("x-delivery-longitude", "31")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(outside_area.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(
        &http_body_util::BodyExt::collect(outside_area.into_body())
            .await
            .unwrap()
            .to_bytes(),
    )
    .unwrap();
    assert_eq!(body["in_stock"], false);
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "requires scripts/m13-search-test.py and local Meilisearch"]
async fn real_search_stock_facet_and_catalog_area_annotations(pool: PgPool) {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use domain_search_client::{Client, Search, SearchProvider};
    use http_body_util::BodyExt;

    let (c, p, a, b, _) = fixture(pool.clone()).await;
    let search = Client::new(
        std::env::var("M13_SEARCH_URL").unwrap(),
        std::env::var("MEILI_MASTER_KEY").unwrap(),
    );
    search.initialize().await.unwrap();
    let catalog = domain_catalog::Service { pool: pool.clone() };
    search.sync(&catalog, &c.inventory, p.id).await.unwrap();
    let bstock: Uuid =
        sqlx::query_scalar("SELECT stock_id FROM inventory.area_stock_links WHERE area_id=$1")
            .bind(b)
            .fetch_one(&pool)
            .await
            .unwrap();
    let filter = |stock| Search {
        in_stock: Some(true),
        stock_ids: Some(vec![stock]),
        ..Default::default()
    };
    assert_eq!(
        search
            .search(filter(Uuid::from_u128(1)))
            .await
            .unwrap()
            .total,
        1
    );
    assert_eq!(search.search(filter(bstock)).await.unwrap().total, 0);
    let security = infra_auth::Security::new(
        "test-secret-at-least-32-characters-long".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let identity = api_gateway::identity::App::new(
        pool.clone(),
        security,
        vec!["http://localhost:5173".into()],
    );
    let app = api_gateway::catalog::App {
        identity,
        catalog: catalog.clone(),
        search: search.clone(),
        media: infra_media::Store::new("http://localhost:9000".into(), "unused", "unused").unwrap(),
        analytics: api_gateway::analytics::Client::new(
            "http://localhost:8123".into(),
            "unused".into(),
            "unused".into(),
        ),
    };
    let router = api_gateway::catalog::router(app);
    for (lat, expected) in [(30., true), (31., false)] {
        for path in [
            "/v1/search".to_string(),
            format!("/v1/catalog/products/{}", p.id),
        ] {
            let r = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(&path)
                        .header("x-delivery-latitude", lat.to_string())
                        .header("x-delivery-longitude", "31")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(r.status(), StatusCode::OK);
            let body: serde_json::Value =
                serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap();
            let product = if path == "/v1/search" {
                &body["hits"][0]
            } else {
                &body
            };
            assert_eq!(product["in_stock"], expected);
        }
    }
    let r = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/search")
                .header("x-delivery-latitude", "-20")
                .header("x-delivery-longitude", "31")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // Global browsing accepts valid pins outside local coverage, but must not
    // advertise local inventory at that destination.
    assert_eq!(r.status(), StatusCode::OK);
    let outside: serde_json::Value =
        serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(outside["hits"].as_array().unwrap().len(), 1);
    assert_eq!(outside["hits"][0]["id"], json!(p.id));
    assert_eq!(outside["hits"][0]["in_stock"], false);
    let guest = c.open(None, "").await.unwrap().guest_token.unwrap();
    c.set_delivery(None, &guest, pin(30.)).await.unwrap();
    c.set(None, &guest, p.clone(), 3, true).await.unwrap();
    assert_eq!(c.inventory.area_available(a, p.id).await.unwrap(), 0);
    search.sync(&catalog, &c.inventory, p.id).await.unwrap();
    assert_eq!(
        search
            .search(filter(Uuid::from_u128(1)))
            .await
            .unwrap()
            .total,
        0
    );
    c.remove(None, &guest, p.id).await.unwrap();
    search.sync(&catalog, &c.inventory, p.id).await.unwrap();
    assert_eq!(
        search
            .search(filter(Uuid::from_u128(1)))
            .await
            .unwrap()
            .total,
        1
    );
    let mut hidden:domain_catalog::ProductInput=serde_json::from_value(json!({"sku":p.sku,"name":p.name,"slug":p.slug,"description":p.description,"price":"2.00","currency":"USD","unit":"each","category_id":p.category_id,"attributes":{},"media_ids":[],"active":false,"in_stock":true})).unwrap();
    hidden.active = false;
    catalog.save_product(Some(p.id), hidden).await.unwrap();
    search.sync(&catalog, &c.inventory, p.id).await.unwrap();
    assert_eq!(search.search(Search::default()).await.unwrap().total, 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn polygon_delivery_boundaries_and_validation(pool: PgPool) {
    let (c, _, existing, _, _) = fixture(pool.clone()).await;
    let stock: Uuid = sqlx::query_scalar(
        "SELECT stock_id FROM inventory.area_stock_links WHERE area_id=$1 LIMIT 1",
    )
    .bind(existing)
    .fetch_one(&pool)
    .await
    .unwrap();
    let boundary = serde_json::json!([
        {"latitude":30.0,"longitude":31.0},{"latitude":30.0,"longitude":31.2},
        {"latitude":30.1,"longitude":31.2},{"latitude":30.1,"longitude":31.1},
        {"latitude":30.2,"longitude":31.1},{"latitude":30.2,"longitude":31.0}
    ]);
    let input: AreaInput = serde_json::from_value(serde_json::json!({"name":"Custom boundary","boundary":boundary,"priority":-10,"is_active":true,"stocks":[{"stock_id":stock,"priority":0}]})).unwrap();
    let id = c
        .inventory
        .save_area(None, input, Uuid::new_v4())
        .await
        .unwrap();
    for (latitude, longitude, inside) in [
        (30.05, 31.15, true),
        (30.15, 31.05, true),
        (30.15, 31.15, false),
        (30.0, 31.0, true),
        (30.0, 31.1, true),
        (30.3, 31.3, false),
    ] {
        let result = c
            .inventory
            .delivery(Some(Pin {
                latitude,
                longitude,
            }))
            .await
            .unwrap();
        assert_eq!(
            result.area_id == Some(id),
            inside,
            "{latitude}, {longitude}"
        );
    }
    let saved = c
        .inventory
        .areas()
        .await
        .unwrap()
        .into_iter()
        .find(|a| a.id == id)
        .unwrap();
    assert_eq!(
        serde_json::to_value(saved.input.boundary).unwrap(),
        boundary
    );
    for boundary in [
        serde_json::json!([]),
        serde_json::json!([{"latitude":30.,"longitude":31.},{"latitude":30.,"longitude":31.1}]),
        serde_json::json!([{"latitude":30.,"longitude":31.},{"latitude":30.2,"longitude":31.2},{"latitude":30.,"longitude":31.2},{"latitude":30.2,"longitude":31.}]),
        serde_json::json!([{"latitude":30.,"longitude":31.},{"latitude":30.,"longitude":31.1},{"latitude":30.,"longitude":31.2}]),
        serde_json::json!([{"latitude":91.,"longitude":31.},{"latitude":30.,"longitude":31.1},{"latitude":30.1,"longitude":31.2}]),
    ] {
        let input:AreaInput=serde_json::from_value(serde_json::json!({"name":"Invalid boundary","boundary":boundary,"priority":0,"is_active":false,"stocks":[]})).unwrap();
        assert!(c
            .inventory
            .save_area(None, input, Uuid::new_v4())
            .await
            .is_err());
    }
}
