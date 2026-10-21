use api_gateway::identity::App;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use sqlx::PgPool;
use tower::ServiceExt;

#[sqlx::test(migrations = "../../migrations")]
async fn public_fallback_and_private_preview(pool: PgPool) {
    let security = infra_auth::Security::new(
        "theme-tests-secret-at-least-32-characters".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let app = api_gateway::themes::router(App::new(
        pool,
        security,
        vec!["http://localhost:5173".into()],
    ));
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/theme/storefront")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "private, no-cache");
    let etag = response.headers()["etag"].clone();
    let bytes = axum::body::to_bytes(response.into_body(), 200000)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(body["version_id"].is_null());
    assert_eq!(body["configuration"]["schema_version"], "theme/v1");
    let cached = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/theme/storefront")
                .header("if-none-match", etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(cached.headers()["cache-control"], "private, no-cache");
    for path in [
        "/v1/admin/themes",
        "/v1/admin/themes/00000000-0000-0000-0000-000000000001/preview",
        "/v1/admin/themes/00000000-0000-0000-0000-000000000001/versions/00000000-0000-0000-0000-000000000002",
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(response.headers()["cache-control"], "no-store");
    }
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/admin/themes")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[sqlx::test(migrations = "../../migrations")]
async fn themes_target_real_segments_zone_stocks_and_manual_city(pool: PgPool) {
    use domain_theme::{application::*, postgres::PostgresRepository};
    use serde_json::json;
    use uuid::Uuid;
    let actor = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'target@example.test','Target admin','unused',$2)").bind(actor).bind(domain_admin_iam::SUPER).execute(&pool).await.unwrap();
    let service = Service {
        repository: PostgresRepository::new(pool.clone()),
    };
    let who = Actor {
        id: actor,
        permissions: vec!["*".into()],
    };
    let mut published = Vec::new();
    for name in ["Local VIP", "City"] {
        let t = service
            .create(
                Create {
                    name: name.into(),
                    owner_channel: "storefront".into(),
                    source: None,
                },
                &who,
            )
            .await
            .unwrap();
        let v = service
            .publish(
                t.id,
                Publish {
                    expected_revision: t.revision,
                    source_version: None,
                },
                &who,
            )
            .await
            .unwrap();
        published.push((t.id, v.id));
    }
    let customer = Uuid::new_v4();
    let session = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash,customer_group) VALUES($1,'vip@example.test','email','unused','vip')").bind(customer).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO customers.sessions(id,customer_id,refresh_hash,expires_at) VALUES($1,$2,'theme-refresh',now()+interval '1 hour')").bind(session).bind(customer).execute(&pool).await.unwrap();
    let segment = domain_customers::segments::Service { pool: pool.clone() }.save(None, serde_json::from_value(json!({"name":"VIP","description":"","status":"active","website":"Main Website","applyTo":"registered","match":"all","revision":0,"rules":[{"id":"group","type":"customer","attribute":"customer_group","operator":"is","value":"vip"}]})).unwrap(), actor).await.unwrap();
    let area = Uuid::new_v4();
    let stock = Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap();
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km) VALUES($1,'Cairo zone',30,31,5)").bind(area).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.area_stock_links(area_id,stock_id) VALUES($1,$2)")
        .bind(area)
        .bind(stock)
        .execute(&pool)
        .await
        .unwrap();
    let mut rules = vec![
        TargetRule {
            id: Uuid::new_v4(),
            theme_id: published[0].0,
            enabled: true,
            segment_id: Some(segment.id),
            area_id: Some(area),
            stock_id: Some(stock),
            city: None,
        },
        TargetRule {
            id: Uuid::new_v4(),
            theme_id: published[1].0,
            enabled: true,
            segment_id: None,
            area_id: None,
            stock_id: None,
            city: Some("Cairo".into()),
        },
    ];
    service
        .assign(
            "storefront",
            Assign {
                theme_id: None,
                expected_revision: 0,
                rules: rules.clone(),
            },
            &who,
        )
        .await
        .unwrap();
    let security = infra_auth::Security::new(
        "theme-target-test-secret-at-least-32-characters".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let token = security.access_token(customer, session).unwrap();
    let app = api_gateway::themes::router(App::new(
        pool.clone(),
        security,
        vec!["http://localhost:5173".into()],
    ));
    async fn resolve(
        app: &axum::Router,
        token: Option<&str>,
        pin: bool,
        city: Option<&str>,
    ) -> serde_json::Value {
        let mut req = Request::builder().uri(format!(
            "/v1/theme/storefront{}",
            city.map(|v| format!("?city={}", v.replace(' ', "%20")))
                .unwrap_or_default()
        ));
        if let Some(token) = token {
            req = req.header("authorization", format!("Bearer {token}"));
        }
        if pin {
            req = req
                .header("x-delivery-latitude", "30")
                .header("x-delivery-longitude", "31");
        }
        let res = app
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()["cache-control"], "private, no-cache");
        assert!(res.headers()["vary"]
            .to_str()
            .unwrap()
            .contains("Authorization"));
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 200000).await.unwrap())
            .unwrap()
    }
    assert!(
        resolve(&app, None, true, None).await["version_id"].is_null(),
        "Guests cannot claim segment membership"
    );
    assert!(
        resolve(&app, Some(&token), false, None).await["version_id"].is_null(),
        "No pin must not use channel stock as a geofence match"
    );
    assert_eq!(
        resolve(&app, Some(&token), true, Some("Cairo")).await["version_id"],
        json!(published[0].1),
        "First matching rule wins"
    );
    assert_eq!(
        resolve(&app, None, false, Some(" cairo ")).await["version_id"],
        json!(published[1].1)
    );
    sqlx::query("UPDATE customers.customers SET customer_group='general' WHERE id=$1")
        .bind(customer)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        resolve(&app, Some(&token), true, None).await["version_id"].is_null(),
        "Membership is evaluated live"
    );
    sqlx::query("UPDATE customers.customers SET customer_group='vip' WHERE id=$1")
        .bind(customer)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM inventory.area_stock_links WHERE area_id=$1")
        .bind(area)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        resolve(&app, Some(&token), true, None).await["version_id"].is_null(),
        "Unlinked stock invalidates geofence targeting"
    );
    // Invalid links must also be rejected when configuring a rule.
    assert!(service
        .assign(
            "storefront",
            Assign {
                theme_id: None,
                expected_revision: 1,
                rules: rules.clone()
            },
            &who
        )
        .await
        .is_err());
    rules.remove(0);
    rules[0].enabled = false;
    service
        .assign(
            "storefront",
            Assign {
                theme_id: None,
                expected_revision: 1,
                rules,
            },
            &who,
        )
        .await
        .unwrap();
    let disabled = resolve(&app, None, false, Some("Cairo")).await;
    assert!(disabled["version_id"].is_null());
    assert_eq!(disabled["cities"], json!([]));
}
