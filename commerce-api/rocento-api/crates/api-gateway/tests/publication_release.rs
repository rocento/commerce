#[path = "support/publication_stage11.rs"]
mod support;
use api_gateway::{
    discoverability::App,
    identity,
    public_commerce::{
        feeds::{self, ReferenceAdapter},
        policy::Deployment,
    },
};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::time::Instant;
use uuid::Uuid;
fn save(name: &str, value: Value) {
    let dir = std::env::var("PUBLICATION_EVIDENCE_DIR").unwrap();
    std::fs::write(
        format!("{dir}/{name}.json"),
        serde_json::to_vec_pretty(&value).unwrap(),
    )
    .unwrap();
}
async fn app(pool: &PgPool) -> App {
    let id = sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
        .fetch_one(pool)
        .await
        .unwrap();
    App {
        identity: identity::App::new(
            pool.clone(),
            infra_auth::Security::new(
                "release-test-secret".repeat(4),
                "https://shop.example.test".into(),
                false,
            )
            .await
            .unwrap(),
            vec!["https://shop.example.test".into()],
        ),
        deployment: Deployment {
            installation_id: Some(id),
            environment: "production".into(),
            approved_origin: Some("https://shop.example.test/".into()),
            header_override: false,
            html: Some("built".into()),
        },
    }
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "explicit Linux release rehearsal; requires sealed artifacts and evidence directory"]
async fn release_catalog_concurrency_and_full_feed(pool: PgPool) {
    support::seed(&pool, "Release configurable apples").await;
    sqlx::query("INSERT INTO catalog.categories(id,name,slug) SELECT md5(('category-'||i)::text)::uuid,'Category '||i,'category-'||i FROM generate_series(1,200) i").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) SELECT md5(('release-'||i)::text)::uuid,'RELEASE-'||i,'release-'||i,'Product '||i,'Representative public catalog product',10,'USD','ea',md5(('category-'||(1+i%200))::text)::uuid FROM generate_series(1,2000) i").execute(&pool).await.unwrap();
    sqlx::query("UPDATE catalog.products SET product_type='configurable' WHERE sku='APPLE'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE attributes.definitions SET used_for_configurations=true WHERE attribute_code='color'").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.product_configurations(id,parent_product_id,configurable_attributes) VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000002',ARRAY['color'])").execute(&pool).await.unwrap();
    sqlx::query("UPDATE catalog.products SET parent_id='00000000-0000-0000-0000-000000000002',attributes=jsonb_build_object('color',sku),variant_attributes=jsonb_build_object('color',sku) WHERE sku IN (SELECT 'RELEASE-'||i FROM generate_series(1,20)i)").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.product_links(parent_id,child_id,position) SELECT parent_id,id,1 FROM catalog.products WHERE parent_id IS NOT NULL").execute(&pool).await.unwrap();
    // Real processed image bytes served through an isolated object-store fixture.
    use axum::{
        body::Bytes,
        extract::{Request, State},
        http::StatusCode,
        Router,
    };
    use http_body_util::BodyExt;
    use std::{collections::HashMap, sync::Arc};
    type Objects = Arc<tokio::sync::RwLock<HashMap<String, Bytes>>>;
    async fn object(State(objects): State<Objects>, request: Request) -> (StatusCode, Bytes) {
        let key = request.uri().path().to_owned();
        if request.method() == "PUT" {
            let b = request.into_body().collect().await.unwrap().to_bytes();
            objects.write().await.insert(key, b);
            (StatusCode::OK, Bytes::new())
        } else {
            match objects.read().await.get(&key) {
                Some(b) => (StatusCode::OK, b.clone()),
                None => (StatusCode::NOT_FOUND, Bytes::new()),
            }
        }
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let objects: Objects = Default::default();
    let object_task = tokio::spawn(async move {
        axum::serve(listener, Router::new().fallback(object).with_state(objects))
            .await
            .unwrap()
    });
    let store = infra_media::Store::new(endpoint, "test", "test").unwrap();
    let id = Uuid::from_u128(100);
    let key = format!("catalog/{id}");
    let mut pixels = image::RgbImage::new(1200, 800);
    for (x, y, p) in pixels.enumerate_pixels_mut() {
        *p = image::Rgb([(x % 251) as u8, (y % 241) as u8, ((x * y) % 239) as u8]);
    }
    let mut png = std::io::Cursor::new(vec![]);
    image::DynamicImage::ImageRgb8(pixels)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    store.put(&key, png.get_ref(), "image/png").await.unwrap();
    sqlx::query("INSERT INTO catalog.media(id,content_type,alt,object_key,size_bytes) VALUES($1,'image/png','Synthetic colorful product image',$2,$3)").bind(id).bind(key).bind(png.get_ref().len()as i64).execute(&pool).await.unwrap();
    api_gateway::public_commerce::images::store_derived(&pool, &store, id, png.into_inner())
        .await
        .unwrap();
    sqlx::query("UPDATE catalog.products SET media_ids=ARRAY[$1]")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let (base, gateway, _r, task) = support::fixture(&pool, "shop.example.test").await;
    let (base_b, _, _r_b, task_b) = support::fixture(&pool, "shop.example.test").await;
    let a = app(&pool).await;
    let media_api = api_gateway::catalog::router(api_gateway::catalog::App {
        identity: a.identity.clone(),
        catalog: domain_catalog::Service { pool: pool.clone() },
        media: store,
        search: domain_search_client::Client::new("http://localhost:1".into(), "test".into()),
        analytics: api_gateway::analytics::Client::new(
            "http://localhost:1".into(),
            "test".into(),
            "test".into(),
        ),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let media_gateway = format!("http://{}", listener.local_addr().unwrap());
    let media_task = tokio::spawn(async move { axum::serve(listener, media_api).await.unwrap() });
    if let Ok(script) = std::env::var("STAGE11_RELEASE_BROWSER") {
        assert!(tokio::process::Command::new("node")
            .args([
                script,
                base.clone(),
                media_gateway.clone(),
                std::env::var("PUBLICATION_EVIDENCE_DIR").unwrap()
            ])
            .status()
            .await
            .unwrap()
            .success());
    }
    if let Ok(script) = std::env::var("STAGE11_PROXY_REHEARSAL") {
        assert!(tokio::process::Command::new("node")
            .args([
                script,
                base.clone(),
                base_b.clone(),
                gateway.clone(),
                std::env::var("PUBLICATION_EVIDENCE_DIR").unwrap()
            ])
            .status()
            .await
            .unwrap()
            .success());
    }
    let mut runs = vec![];
    for concurrency in [1, 8, 32, 80] {
        let start = Instant::now();
        let mut work = tokio::task::JoinSet::new();
        for i in 0..concurrency {
            let base = if i % 2 == 0 {
                base.clone()
            } else {
                base_b.clone()
            };
            work.spawn(async move {
                let mut samples = vec![];
                for _ in 0..5 {
                    let s = Instant::now();
                    let r = support::get(&base, "shop.example.test", "/products/apples").await;
                    let status = r.status().as_u16();
                    let body = r.text().await.unwrap();
                    assert!([200, 503].contains(&status));
                    if status == 200 {
                        assert!(body.contains("Release configurable apples"));
                        assert!(body.contains("Available variants"));
                    }
                    samples.push((status, s.elapsed().as_secs_f64() * 1000., body.len()));
                }
                samples
            });
        }
        let mut samples = vec![];
        while let Some(r) = work.join_next().await {
            samples.extend(r.unwrap());
        }
        let elapsed = start.elapsed().as_secs_f64();
        let successes = samples.iter().filter(|r| r.0 == 200).count();
        let rejected = samples.len() - successes;
        runs.push(json!({"concurrency":concurrency,"requests":samples.len(),"success":successes,"retryable_503":rejected,"seconds":elapsed,"requests_per_second":samples.len()as f64/elapsed,"samples":samples}));
        if concurrency <= 8 {
            assert_eq!(rejected, 0);
        }
    }
    let sustained_start = Instant::now();
    let mut workers = tokio::task::JoinSet::new();
    for i in 0..16 {
        let base = if i % 2 == 0 {
            base.clone()
        } else {
            base_b.clone()
        };
        workers.spawn(async move {
            let until = Instant::now() + std::time::Duration::from_secs(60);
            let mut samples = vec![];
            while Instant::now() < until {
                let started = Instant::now();
                let r = support::get(&base, "shop.example.test", "/products/apples").await;
                assert_eq!(r.status(), 200);
                let _ = r.bytes().await.unwrap();
                samples.push(started.elapsed().as_secs_f64() * 1000.);
            }
            samples
        });
    }
    let mut sustained_samples = vec![];
    while let Some(r) = workers.join_next().await {
        sustained_samples.extend(r.unwrap());
    }
    sustained_samples.sort_by(f64::total_cmp);
    let count = sustained_samples.len();
    let p95 = sustained_samples[(count * 95 / 100).min(count - 1)];
    assert!(p95 < 1000., "local release p95 exceeded 1s");
    let sustained = json!({"seconds":sustained_start.elapsed().as_secs_f64(),"concurrency":16,"requests":count,"errors":0,"p50_ms":sustained_samples[count/2],"p95_ms":p95,"p99_ms":sustained_samples[(count*99/100).min(count-1)]});
    println!("sustained load passed: {count} requests, p95 {p95:.1} ms");
    let start = Instant::now();
    let mut batches = 0;
    let mut processed = 0;
    let mut mem = vec![];
    let paced = std::env::var("STAGE11_REAL_PACING").as_deref() == Ok("1");
    let mut active_seconds = 0.;
    loop {
        if paced {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        } else {
            sqlx::query("UPDATE platform.publication_freshness SET next_batch_at=now(),next_delivery_at=now()").execute(&pool).await.unwrap();
        }
        let active_start = Instant::now();
        let n = feeds::reconcile_batch(&a).await.unwrap();
        assert!(n <= 10);
        processed += n;
        feeds::deliver_batch(&a, &ReferenceAdapter).await.unwrap();
        active_seconds += active_start.elapsed().as_secs_f64();
        batches += 1;
        if batches % 10 == 0 {
            println!("feed progress: {processed} resources, {batches} bounded batches");
            let rss = std::process::Command::new("ps")
                .args(["-o", "rss=", "-p", &std::process::id().to_string()])
                .output()
                .unwrap();
            mem.push(
                String::from_utf8(rss.stdout)
                    .unwrap()
                    .trim()
                    .parse::<u64>()
                    .unwrap(),
            );
        }
        let done:bool=sqlx::query_scalar("SELECT completed_generation=generation AND cursor_kind='' FROM platform.publication_freshness").fetch_one(&pool).await.unwrap();
        if done {
            break;
        }
        assert!(batches < 300);
    }
    let items: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM platform.publication_reference_feed WHERE operation='upsert'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(items, 2001);
    save(
        "release-workload",
        json!({"synthetic":true,"products":2001,"categories":201,"configurable_variants":20,"processed_image":"1200x800 PNG plus derived WebP variants","replicas":2,"build":"Rust release and Node 22 Linux","gateway":gateway,"load_runs":runs,"sustained":sustained,"full_feed":{"items":items,"resources":processed,"batches":batches,"active_seconds":active_seconds,"wall_seconds":start.elapsed().as_secs_f64(),"rss_kib_samples":mem,"pacing":if paced{"actual one-second scheduler pacing"}else{"scheduler gates advanced for active-work measurement"}}}),
    );
    task.abort();
    task_b.abort();
    media_task.abort();
    object_task.abort();
}
