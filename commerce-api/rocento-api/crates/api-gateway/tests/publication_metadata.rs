use sqlx::PgPool;
use uuid::Uuid;
#[sqlx::test(migrations = "../../migrations")]
async fn image_eligibility_is_reference_based_and_revocable(pool: PgPool) {
    let category = Uuid::new_v4();
    let product = Uuid::new_v4();
    let public = Uuid::new_v4();
    let private = Uuid::new_v4();
    sqlx::query("INSERT INTO catalog.categories(id,slug,name) VALUES($1,'fruit','Fruit')")
        .bind(category)
        .execute(&pool)
        .await
        .unwrap();
    for id in [public, private] {
        sqlx::query("INSERT INTO catalog.media(id,content_type,alt,object_key,size_bytes) VALUES($1,'image/png','Fruit',$2,10)").bind(id).bind(id.to_string()).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,media_ids) VALUES($1,'fruit','fruit','Fruit','Fresh fruit',1,'USD','kg',$2,ARRAY[$3])").bind(product).bind(category).bind(public).execute(&pool).await.unwrap();
    let mut db = pool.acquire().await.unwrap();
    assert!(
        api_gateway::public_commerce::images::is_public(&mut db, public)
            .await
            .unwrap()
    );
    assert!(
        !api_gateway::public_commerce::images::is_public(&mut db, private)
            .await
            .unwrap()
    );
    sqlx::query("UPDATE catalog.products SET active=false WHERE id=$1")
        .bind(product)
        .execute(&mut *db)
        .await
        .unwrap();
    assert!(
        !api_gateway::public_commerce::images::is_public(&mut db, public)
            .await
            .unwrap()
    );
    sqlx::query("UPDATE cms.publication_metadata SET configuration=jsonb_build_object('social_image',$1::text)").bind(private.to_string()).execute(&mut *db).await.unwrap();
    assert!(
        api_gateway::public_commerce::images::is_public(&mut db, private)
            .await
            .unwrap()
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn real_media_bytes_variants_and_private_authorization(pool: PgPool) {
    use axum::{
        body::{Body, Bytes},
        extract::{Request, State},
        http::StatusCode,
        Router,
    };
    use http_body_util::BodyExt;
    use std::{collections::HashMap, sync::Arc};
    use tower::ServiceExt;
    type Objects = Arc<tokio::sync::RwLock<HashMap<String, Bytes>>>;
    async fn object(State(objects): State<Objects>, request: Request) -> (StatusCode, Bytes) {
        let key = request.uri().path().to_owned();
        if request.method() == "PUT" {
            let bytes = request.into_body().collect().await.unwrap().to_bytes();
            objects.write().await.insert(key, bytes);
            (StatusCode::OK, Bytes::new())
        } else {
            match objects.read().await.get(&key) {
                Some(bytes) => (StatusCode::OK, bytes.clone()),
                None => (StatusCode::NOT_FOUND, Bytes::new()),
            }
        }
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let objects: Objects = Default::default();
    let server = tokio::spawn(async move {
        axum::serve(listener, Router::new().fallback(object).with_state(objects))
            .await
            .unwrap()
    });
    let store = infra_media::Store::new(endpoint, "test", "test").unwrap();
    let image = Uuid::new_v4();
    let private = Uuid::new_v4();
    let mut buffer = std::io::Cursor::new(vec![]);
    image::DynamicImage::new_rgb8(1200, 800)
        .write_to(&mut buffer, image::ImageFormat::Png)
        .unwrap();
    for id in [image, private] {
        let key = format!("catalog/{id}");
        store
            .put(&key, buffer.get_ref(), "image/png")
            .await
            .unwrap();
        sqlx::query("INSERT INTO catalog.media(id,content_type,alt,object_key,size_bytes) VALUES($1,'image/png','Apples',$2,$3)").bind(id).bind(key).bind(buffer.get_ref().len() as i64).execute(&pool).await.unwrap();
    }
    api_gateway::public_commerce::images::store_derived(&pool, &store, image, buffer.into_inner())
        .await
        .unwrap();
    sqlx::query("UPDATE cms.publication_metadata SET configuration=jsonb_build_object('social_image',$1::text)").bind(image.to_string()).execute(&pool).await.unwrap();
    let security = infra_auth::Security::new(
        "publication-test-secret".repeat(3),
        "https://shop.example.test".into(),
        false,
    )
    .await
    .unwrap();
    let identity = api_gateway::identity::App::new(
        pool.clone(),
        security,
        vec!["https://admin.example.test".into()],
    );
    let role = Uuid::new_v4();
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'Media reader',ARRAY['catalog.read'])").bind(role).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'reader@example.test','Reader','!',$2)").bind(user).bind(role).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest(&user.to_string())).bind(user).execute(&pool).await.unwrap();
    let app = api_gateway::catalog::router(api_gateway::catalog::App {
        identity,
        catalog: domain_catalog::Service { pool: pool.clone() },
        media: store,
        search: domain_search_client::Client::new("http://localhost:1".into(), "test".into()),
        analytics: api_gateway::analytics::Client::new(
            "http://localhost:1".into(),
            "test".into(),
            "test".into(),
        ),
    });
    for width in [None, Some(480), Some(960), Some(1200)] {
        let path = format!(
            "/v1/catalog/media/{image}/content{}",
            width.map(|v| format!("?width={v}")).unwrap_or_default()
        );
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!(decoded.width(), width.unwrap_or(1200));
    }
    for width in [123, 12001] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/catalog/media/{image}/content?width={width}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            404,
            "Only prepared image candidates are served"
        );
    }
    for suffix in ["", "/content", "/content?width=480", "/content?width=1200"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/catalog/media/{private}{suffix}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 401);
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/v1/catalog/media/{image}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["object_key"], "");
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/v1/catalog/media/{private}/content"))
                .header("cookie", format!("admin_session={user}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    sqlx::query("UPDATE cms.publication_metadata SET configuration='{}'")
        .execute(&pool)
        .await
        .unwrap();
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/v1/catalog/media/{image}/content"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    server.abort();
}
