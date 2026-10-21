//! Location preference is shared by storefront and assistant sales rankings.
mod support;

use api_gateway::{assistant, catalog, identity};
use axum::{body::Body, http::Request};
use domain_orders::bestsellers::{rank_for_area, Period, Scope};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

async fn sale(pool: &PgPool, product: Uuid, quantity: i32, area: Option<Uuid>, status: &str) {
    let order = Uuid::new_v4();
    sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency,created_at) VALUES($1,$2,$3,$4,$5,$6,'{}',1000,0,1000,'USD',date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')")
        .bind(order).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(Uuid::new_v4())
        .bind(status).bind(json!({"area_id":area})).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO orders.order_items(order_id,product_id,sku,name,unit,quantity,price,line_total) VALUES($1,$2,'fixture','Fixture','each',$3,1,$3)")
        .bind(order).bind(product).bind(quantity).execute(pool).await.unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn bestsellers_prefer_local_sales_and_fall_back_globally_on_both_surfaces(pool: PgPool) {
    let service = domain_catalog::Service { pool: pool.clone() };
    let category = service
        .save_category(
            None,
            serde_json::from_value(json!({
                "name":"Best sellers", "slug":"best-sellers", "parent_id":null
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let mut products = Vec::new();
    for (name, active) in [("Local", true), ("Global", true), ("Hidden", false)] {
        let product = service
            .save_product(
                None,
                serde_json::from_value(json!({
                    "name":name,"sku":name,"slug":name.to_lowercase(),"description":"Fixture",
                    "category_id":category.id,"price":"1","currency":"USD","unit":"each",
                    "active":active,"in_stock":true,"attributes":{},"media_ids":[]
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        products.push(product.id);
    }
    let (local, global, hidden) = (products[0], products[1], products[2]);
    let mut areas = Vec::new();
    for (name, latitude) in [("Local", 30.), ("Empty", 31.), ("Hidden only", 32.)] {
        let area = Uuid::new_v4();
        sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km) VALUES($1,$2,$3,31,5)")
            .bind(area).bind(name).bind(latitude).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO inventory.area_stock_links(area_id,stock_id) VALUES($1,$2)")
            .bind(area)
            .bind(Uuid::from_u128(1))
            .execute(&pool)
            .await
            .unwrap();
        areas.push(area);
    }
    sale(&pool, local, 2, Some(areas[0]), "delivered").await;
    sale(&pool, local, 3, Some(areas[0]), "cash_collected").await;
    sale(&pool, global, 100, None, "delivered").await;
    sale(&pool, global, 1000, Some(areas[0]), "cancelled").await;
    sale(&pool, hidden, 200, Some(areas[2]), "delivered").await;
    sale(&pool, global, 1000, Some(areas[1]), "placed").await;
    // A product sold elsewhere must not inflate its local sales total.
    sale(&pool, local, 20, Some(areas[1]), "delivered").await;
    let now = chrono::Utc::now();
    let ranked = rank_for_area(&pool, Period::Today, now, Some(areas[0]))
        .await
        .unwrap();
    assert_eq!(ranked.scope, Scope::DeliveryArea);
    assert_eq!(
        ranked
            .products
            .iter()
            .map(|p| (p.product_id, p.units))
            .collect::<Vec<_>>(),
        vec![(local, 5)]
    );
    // Remove the only qualifying sale in the otherwise-empty area.
    sqlx::query("DELETE FROM orders.order_items WHERE order_id IN (SELECT id FROM orders.orders WHERE location->>'area_id'=$1 AND status='delivered')")
        .bind(areas[1].to_string()).execute(&pool).await.unwrap();
    for area in [None, Some(areas[1]), Some(areas[2]), Some(Uuid::new_v4())] {
        let ranked = rank_for_area(&pool, Period::Today, now, area)
            .await
            .unwrap();
        assert_eq!(ranked.scope, Scope::Global);
        assert_eq!(
            ranked
                .products
                .iter()
                .find(|p| p.product_id == global)
                .unwrap()
                .units,
            100
        );
    }
    let identity = identity::App::new(
        pool.clone(),
        infra_auth::Security::new(
            "bestseller-location-test-secret".repeat(3),
            "http://localhost".into(),
            false,
        )
        .await
        .unwrap(),
        vec![],
    );
    let storefront = catalog::router(catalog::App {
        identity: identity.clone(),
        catalog: service,
        search: domain_search_client::Client::new("http://localhost:1".into(), "test".into()),
        media: infra_media::Store::new("http://localhost:1".into(), "test", "test").unwrap(),
        analytics: api_gateway::analytics::Client::new(
            "http://localhost:1".into(),
            "test".into(),
            "test".into(),
        ),
    });
    let app = assistant::App {
        identity: identity.clone(),
        tenant: Uuid::new_v4(),
        signing: Arc::new(
            jsonwebtoken::EncodingKey::from_rsa_pem(support::assistant_private_key()).unwrap(),
        ),
        verifying: Arc::new(
            jsonwebtoken::DecodingKey::from_rsa_pem(support::assistant_public_key()).unwrap(),
        ),
        client: reqwest::Client::new(),
        slots: Arc::new(tokio::sync::Semaphore::new(8)),
    };
    let assistant = assistant::router(identity, Some(app.clone()));
    let timestamp = chrono::Utc::now().timestamp();
    let token = app
        .sign(&assistant::Claims {
            iss: "commerce-assistant".into(),
            aud: "assistant-tools".into(),
            tenant: app.tenant,
            sub: None,
            sid: None,
            request_id: Uuid::new_v4(),
            iat: timestamp,
            exp: timestamp + 45,
            scope: "shopper_read".into(),
        })
        .unwrap();
    for (latitude, expected_scope, expected_products) in [
        (Some("30"), "delivery_area", vec![local]),
        (Some("31"), "global", vec![global, local]),
        (Some("32"), "global", vec![global, local]),
        (None, "global", vec![global, local]),
        (Some("40"), "global", vec![global, local]),
    ] {
        for is_assistant in [false, true] {
            let mut request = if is_assistant {
                Request::post("/v1/assistant-tools/shopper")
                    .header("authorization", format!("Bearer {token}"))
                    .header("x-commerce-request", "1")
                    .header("content-type", "application/json")
            } else {
                Request::get("/v1/catalog/bestsellers?period=today")
            };
            if let Some(latitude) = latitude {
                request = request
                    .header("x-delivery-latitude", latitude)
                    .header("x-delivery-longitude", "31");
            }
            let body = if is_assistant {
                Body::from(
                    json!({"name":"get_bestsellers","arguments":{"period":"today"}}).to_string(),
                )
            } else {
                Body::empty()
            };
            let router = if is_assistant {
                assistant.clone()
            } else {
                storefront.clone()
            };
            let response = router.oneshot(request.body(body).unwrap()).await.unwrap();
            assert_eq!(
                response.status(),
                200,
                "assistant={is_assistant}, latitude={latitude:?}"
            );
            let result: Value =
                serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            assert_eq!(result["scope"], expected_scope);
            let ids: Vec<Uuid> = result["products"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p["id"].as_str().unwrap().parse().unwrap())
                .collect();
            assert_eq!(
                ids, expected_products,
                "assistant={is_assistant}, latitude={latitude:?}"
            );
            if !is_assistant && latitude == Some("40") {
                assert!(result["products"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|p| p["in_stock"] == false));
            }
            assert_eq!(result["metric"], "completed_order_units");
        }
    }
}
