use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    routing::post,
    Json, Router,
};
use domain_catalog::{CategoryInput, Product, Service};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::{
    future::IntoFuture,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tower::ServiceExt;
use uuid::Uuid;

#[derive(Clone)]
struct Provider {
    hits: Vec<Product>,
    pool: PgPool,
    area: Uuid,
    deactivate_area: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<Value>>>,
}

async fn search(State(provider): State<Provider>, Json(body): Json<Value>) -> Json<Value> {
    provider.requests.lock().unwrap().push(body);
    // Change coverage after the gateway resolves the browsing area. Live stock
    // annotation must still apply the active-area predicate when reading stock.
    if provider.deactivate_area.swap(false, Ordering::SeqCst) {
        sqlx::query("UPDATE inventory.delivery_areas SET is_active=false WHERE id=$1")
            .bind(provider.area)
            .execute(&provider.pool)
            .await
            .unwrap();
    }
    Json(json!({"hits": provider.hits, "estimatedTotalHits": 24}))
}

async fn search_response(router: &Router, with_pin: bool) -> Value {
    let mut request = Request::builder()
        .uri("/v1/search")
        .header("x-storefront-locale", "ar");
    if with_pin {
        request = request
            .header("x-delivery-latitude", "30")
            .header("x-delivery-longitude", "31");
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

#[sqlx::test(migrations = "../../migrations")]
async fn search_stock_batches_preserve_order_and_live_area_projection(pool: PgPool) {
    let catalog = Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            CategoryInput {
                name: "Search stock".into(),
                slug: "search-stock".into(),
                parent_id: None,
            },
        )
        .await
        .unwrap();
    let area = Uuid::new_v4();
    let selected_stock = Uuid::new_v4();
    let selected_source = Uuid::new_v4();
    let other_stock = Uuid::new_v4();
    let other_source = Uuid::new_v4();
    let disabled_source = Uuid::new_v4();
    for (stock, source, code) in [
        (selected_stock, selected_source, "search-local"),
        (other_stock, other_source, "search-other"),
    ] {
        sqlx::query("INSERT INTO inventory.inventory_sources(id,code,name) VALUES($1,$2,$2)")
            .bind(source)
            .bind(code)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO inventory.stocks(id,code,name) VALUES($1,$2,$2)")
            .bind(stock)
            .bind(code)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO inventory.source_stock_links(stock_id,source_id) VALUES($1,$2)")
            .bind(stock)
            .bind(source)
            .execute(&pool)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO inventory.inventory_sources(id,code,name,is_enabled) VALUES($1,'search-disabled','Disabled source',false)")
        .bind(disabled_source).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.source_stock_links(stock_id,source_id) VALUES($1,$2)")
        .bind(selected_stock)
        .bind(disabled_source)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km) VALUES($1,'Search area',30,31,10)")
        .bind(area).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.area_stock_links(area_id,stock_id) VALUES($1,$2)")
        .bind(area)
        .bind(selected_stock)
        .execute(&pool)
        .await
        .unwrap();

    let mut products = Vec::new();
    for index in 0..24 {
        let mut product = catalog
            .save_product(
                None,
                serde_json::from_value(json!({
                    "sku": format!("SEARCH-{index}"), "slug": format!("search-{index}"),
                    "name": format!("Product {index}"), "description": "Current catalog copy",
                    "price": "2.50", "currency": "USD", "unit": "each", "category_id": category.id,
                    "attributes": {}, "media_ids": [], "active": true, "in_stock": true
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        sqlx::query("INSERT INTO inventory.stock(product_id) VALUES($1)")
            .bind(product.id)
            .execute(&pool)
            .await
            .unwrap();
        // Cover positive local stock, local zero with stock elsewhere, stock
        // outside the area, missing availability rows, and disabled sources.
        let assignments = match index % 5 {
            0 => vec![(selected_source, 3)],
            1 => vec![(selected_source, 0), (other_source, 9)],
            2 => vec![(other_source, 9)],
            4 => vec![(disabled_source, 9)],
            _ => vec![],
        };
        for (source, quantity) in assignments {
            sqlx::query("INSERT INTO inventory.source_items(source_id,product_id,quantity) VALUES($1,$2,$3)")
                .bind(source).bind(product.id).bind(quantity).execute(&pool).await.unwrap();
        }
        sqlx::query("SELECT inventory.refresh_availability($1)")
            .bind(product.id)
            .execute(&pool)
            .await
            .unwrap();
        // Simulate stale indexed stock and price; the gateway must replace both
        // from authoritative data while retaining the provider's hit order.
        product.in_stock = index % 5 != 0;
        product.price = "99.00".parse().unwrap();
        products.push(product);
    }
    let translated_product = products[2].id;
    let actor = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'search-stock@example.test','Search reviewer','unused',$2)")
        .bind(actor).bind(domain_admin_iam::SUPER).execute(&pool).await.unwrap();
    sqlx::query("UPDATE cms.language_settings SET source_locale='en'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO cms.storefront_languages(locale,name,native_name,direction) VALUES('ar','Arabic','العربية','rtl')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO cms.catalog_translations(locale,entity_type,entity_id,source,fields,reviewed,updated_by) SELECT 'ar','product',entity_id,source,$2,true,$3 FROM cms.translation_sources WHERE entity_type='product' AND entity_id=$1")
        .bind(translated_product).bind(json!({"name": "منتج مترجم"})).bind(actor).execute(&pool).await.unwrap();
    products.reverse();
    let expected_ids: Vec<_> = products.iter().map(|p| json!(p.id)).collect();
    let expected_entity_ids: Vec<_> = products.iter().map(|p| json!(p.entity_id)).collect();
    // Older provider documents omit entity_id; SQL must still supply the real identity.
    for product in &mut products {
        product.entity_id = 0;
    }
    let provider = Provider {
        hits: products,
        pool: pool.clone(),
        area,
        deactivate_area: Default::default(),
        requests: Default::default(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new()
                .route("/indexes/products/search", post(search))
                .with_state(provider.clone()),
        )
        .into_future(),
    );
    let security = infra_auth::Security::new(
        "search-stock-test-secret".repeat(4),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let router = api_gateway::catalog::router(api_gateway::catalog::App {
        identity: api_gateway::identity::App::new(pool.clone(), security, vec![]),
        catalog,
        search: domain_search_client::Client::new(url, "test".into()),
        media: infra_media::Store::new("http://localhost:1".into(), "test", "test").unwrap(),
        analytics: api_gateway::analytics::Client::new(
            "http://localhost:1".into(),
            "test".into(),
            "test".into(),
        ),
    });

    let body = search_response(&router, true).await;
    let hits = body["hits"].as_array().unwrap();
    assert_eq!(hits.len(), 24, "the search page exceeds one stock batch");
    assert_eq!(
        hits.iter().map(|hit| hit["id"].clone()).collect::<Vec<_>>(),
        expected_ids
    );
    assert_eq!(
        hits.iter()
            .map(|hit| hit["entity_id"].clone())
            .collect::<Vec<_>>(),
        expected_entity_ids
    );
    for (hit, indexed) in hits.iter().zip(&provider.hits) {
        assert_eq!(hit["in_stock"], !indexed.in_stock, "{}", indexed.sku);
        assert_eq!(hit["price"], "2.50");
        assert_eq!(hit["currency"], "USD");
    }
    assert_eq!(hits[21]["id"], json!(translated_product));
    assert_eq!(hits[21]["name"], "منتج مترجم");

    provider.deactivate_area.store(true, Ordering::SeqCst);
    let inactive = search_response(&router, true).await;
    assert!(inactive["hits"]
        .as_array()
        .unwrap()
        .iter()
        .all(|hit| hit["in_stock"] == false));

    // Without a pin, default/global availability still replaces stale indexed flags.
    let unscoped = search_response(&router, false).await;
    for (hit, indexed) in unscoped["hits"]
        .as_array()
        .unwrap()
        .iter()
        .zip(&provider.hits)
    {
        assert_eq!(hit["in_stock"], false, "{}", indexed.sku);
    }
    assert_eq!(provider.requests.lock().unwrap().len(), 3);
    sqlx::query("UPDATE inventory.stocks SET is_global=true WHERE id=$1")
        .bind(other_stock)
        .execute(&pool)
        .await
        .unwrap();
    let worldwide = search_response(&router, true).await;
    for hit in worldwide["hits"].as_array().unwrap() {
        let index: usize = hit["sku"]
            .as_str()
            .unwrap()
            .trim_start_matches("SEARCH-")
            .parse()
            .unwrap();
        assert_eq!(hit["in_stock"], index % 5 == 1 || index % 5 == 2);
    }
    // A pin in London is outside the configured Egyptian area, but global stock
    // remains visible on both product details and stock-filtered search.
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/v1/catalog/products/{translated_product}"))
                .header("x-delivery-latitude", "51.5074")
                .header("x-delivery-longitude", "-0.1278")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let product: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(product["in_stock"], true);
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/search?in_stock=true")
                .header("x-delivery-latitude", "51.5074")
                .header("x-delivery-longitude", "-0.1278")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let requests = provider.requests.lock().unwrap();
    assert!(requests.last().unwrap()["filter"]
        .to_string()
        .contains(&other_stock.to_string()));
    assert!(!requests.last().unwrap()["filter"]
        .to_string()
        .contains(&selected_stock.to_string()));
    server.abort();
}
