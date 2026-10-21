use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    routing::post,
    Json, Router,
};
use domain_catalog::{CategoryInput, Service};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::future::IntoFuture;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;
use uuid::Uuid;

#[derive(Clone)]
struct Provider {
    available_category: Uuid,
    requests: Arc<Mutex<Vec<Value>>>,
}

async fn counts(State(provider): State<Provider>, Json(body): Json<Value>) -> Json<Value> {
    provider.requests.lock().unwrap().push(body.clone());
    let results = body["queries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|query| {
            let available = query["filter"][0]
                .as_str()
                .unwrap()
                .contains(&provider.available_category.to_string())
                && query["filter"][1] != "available_stock_ids IN []";
            json!({"hits": [], "estimatedTotalHits": if available { 7 } else { 0 }})
        })
        .collect::<Vec<_>>();
    Json(json!({"results": results}))
}

#[sqlx::test(migrations = "../../migrations")]
async fn public_counts_preserve_zero_categories_and_delivery_scope(pool: PgPool) {
    let catalog = Service { pool: pool.clone() };
    let mut categories = Vec::new();
    for name in ["Available", "Empty"] {
        categories.push(
            catalog
                .save_category(
                    None,
                    CategoryInput {
                        name: name.into(),
                        slug: name.to_lowercase(),
                        parent_id: None,
                    },
                )
                .await
                .unwrap()
                .id,
        );
    }
    let stock = Uuid::new_v4();
    let area = Uuid::new_v4();
    sqlx::query("INSERT INTO inventory.stocks(id,code,name) VALUES($1,'count-test','Count stock')")
        .bind(stock)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km) VALUES($1,'Count area',30,31,10)")
        .bind(area).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.area_stock_links(area_id,stock_id) VALUES($1,$2)")
        .bind(area)
        .bind(stock)
        .execute(&pool)
        .await
        .unwrap();

    let provider = Provider {
        available_category: categories[0],
        requests: Default::default(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new()
                .route("/multi-search", post(counts))
                .with_state(provider.clone()),
        )
        .into_future(),
    );
    let security = infra_auth::Security::new(
        "category-count-test-secret".repeat(4),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let router = api_gateway::catalog::router(api_gateway::catalog::App {
        identity: api_gateway::identity::App::new(pool, security, vec![]),
        catalog,
        search: domain_search_client::Client::new(url, "test".into()),
        media: infra_media::Store::new("http://localhost:1".into(), "test", "test").unwrap(),
        analytics: api_gateway::analytics::Client::new(
            "http://localhost:1".into(),
            "test".into(),
            "test".into(),
        ),
    });
    for latitude in [None, Some("30")] {
        let mut request = Request::builder().uri("/v1/catalog/category-availability");
        if let Some(latitude) = latitude {
            request = request
                .header("x-delivery-latitude", latitude)
                .header("x-delivery-longitude", "31");
        }
        let response = router
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(
            body,
            json!({categories[0].to_string(): 7, categories[1].to_string(): 0})
        );
    }
    // A valid pin outside local delivery coverage has no local stock; global
    // browsing remains a valid request, even when no global pool exists.
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/catalog/category-availability")
                .header("x-delivery-latitude", "-20")
                .header("x-delivery-longitude", "31")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        body,
        json!({categories[0].to_string(): 0, categories[1].to_string(): 0})
    );
    for latitude in ["NaN", "91", "-91", "invalid"] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/catalog/category-availability")
                    .header("x-delivery-latitude", latitude)
                    .header("x-delivery-longitude", "31")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    let requests = provider.requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        3,
        "invalid delivery pins must not reach search"
    );
    for (request, filter) in requests.iter().zip([
        format!("available_stock_ids IN ['{}']", Uuid::from_u128(1)),
        format!("available_stock_ids IN ['{stock}']"),
        "available_stock_ids IN []".to_owned(),
    ]) {
        let queries = request["queries"].as_array().unwrap();
        assert_eq!(queries.len(), categories.len());
        for query in queries {
            assert_eq!(query["filter"][1], filter);
            assert_eq!(query["limit"], 0);
        }
    }
    server.abort();
}
