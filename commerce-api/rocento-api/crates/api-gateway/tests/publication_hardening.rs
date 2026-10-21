#[path = "support/publication_stage11.rs"]
mod support;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::time::Instant;
fn evidence(name: &str, value: Value) {
    if let Ok(dir) = std::env::var("PUBLICATION_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            format!("{dir}/{name}.json"),
            serde_json::to_string_pretty(&value).unwrap(),
        )
        .unwrap();
    }
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "explicit synthetic Stage 11 baseline; needs built renderer and isolated database"]
async fn measured_large_catalog(pool: PgPool) {
    support::seed(&pool, "Stage11 Apples").await;
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) SELECT md5(('stage11-'||i)::text)::uuid,'SCALE-'||i,'scale-'||i,'Scale product '||i,'Synthetic public product',10,'USD','ea','00000000-0000-0000-0000-000000000001' FROM generate_series(1,50000) i").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.product_links(parent_id,child_id,position) SELECT '00000000-0000-0000-0000-000000000002',id,1 FROM catalog.products WHERE sku LIKE 'SCALE-%' ORDER BY id LIMIT 100").execute(&pool).await.unwrap();
    sqlx::query("ANALYZE catalog.products")
        .execute(&pool)
        .await
        .unwrap();
    let (base, _, _renderer, task) = support::fixture(&pool, "shop.example.test").await;
    let mut results = vec![];
    for path in ["/", "/products/apples", "/categories/fruit", "/pages/about"] {
        support::get(&base, "shop.example.test", path).await;
        let mut samples = vec![];
        let mut bytes = 0;
        for _ in 0..15 {
            let start = Instant::now();
            let r = support::get(&base, "shop.example.test", path).await;
            assert_eq!(r.status(), 200);
            let ttfb = start.elapsed().as_secs_f64() * 1000.;
            assert_eq!(r.headers()["cache-control"], "no-store");
            let body = r.text().await.unwrap();
            bytes = body.len();
            samples.push(ttfb);
        }
        samples.sort_by(f64::total_cmp);
        results.push(json!({"path":path,"samples":samples,"median_ttfb_ms":samples[7],"p95_ttfb_ms":samples[14],"html_bytes":bytes,"cache_hit_ratio":0}));
    }
    let start = Instant::now();
    let r = support::get(&base, "shop.example.test", "/sitemap.xml").await;
    assert_eq!(r.status(), 200);
    let xml = r.text().await.unwrap();
    let index_ms = start.elapsed().as_secs_f64() * 1000.;
    let urls: Vec<_> = xml
        .split("<loc>")
        .skip(1)
        .map(|s| s.split("</loc>").next().unwrap())
        .collect();
    let mut partition_bytes = 0;
    let start = Instant::now();
    for url in urls.iter().take(3) {
        let path = url.strip_prefix("https://shop.example.test").unwrap();
        let r = support::get(&base, "shop.example.test", path).await;
        assert_eq!(r.status(), 200);
        partition_bytes += r.text().await.unwrap().len();
    }
    let partitions_ms = start.elapsed().as_secs_f64() * 1000.;
    let mut lookups = vec![];
    for key in ["apples", "00000000-0000-0000-0000-000000000002"] {
        let mut db = pool.acquire().await.unwrap();
        let start = Instant::now();
        for _ in 0..30 {
            assert!(domain_catalog::public::product(&mut db, key)
                .await
                .unwrap()
                .is_some());
        }
        lookups.push(json!({"key_kind":if key=="apples"{"slug"}else{"uuid"},"mean_ms":start.elapsed().as_secs_f64()*1000./30.,"samples":30}));
    }
    let metrics = if let Ok(file) = std::env::var("STAGE11_CONTROL_FILE") {
        let control: Value = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
        reqwest::get(format!("http://127.0.0.1:{}", control["port"]))
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()
    } else {
        Value::Null
    };
    let measurement_app = app(&pool, "shop.example.test").await;
    let rss = || {
        let output = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .unwrap();
        String::from_utf8(output.stdout)
            .unwrap()
            .trim()
            .parse::<u64>()
            .unwrap()
    };
    let mut peak_rss = rss();
    let start_feed = Instant::now();
    let mut resources = 0;
    for _ in 0..3 {
        sqlx::query(
            "UPDATE platform.publication_freshness SET next_batch_at=now(),next_delivery_at=now()",
        )
        .execute(&pool)
        .await
        .unwrap();
        let count = feeds::reconcile_batch(&measurement_app).await.unwrap();
        assert!(count <= 10);
        resources += count;
        feeds::deliver_batch(&measurement_app, &ReferenceAdapter)
            .await
            .unwrap();
        peak_rss = peak_rss.max(rss());
    }
    let feed_ms = start_feed.elapsed().as_secs_f64() * 1000.;
    if let Ok(script) = std::env::var("STAGE11_BROWSER_SCRIPT") {
        let output = format!(
            "{}/browser-{}.json",
            std::env::var("PUBLICATION_EVIDENCE_DIR").unwrap(),
            std::env::var("STAGE11_LABEL").unwrap()
        );
        assert!(tokio::process::Command::new("node")
            .args([script, base.clone(), output])
            .status()
            .await
            .unwrap()
            .success());
    }
    evidence(
        &std::env::var("STAGE11_LABEL").unwrap_or("performance".into()),
        json!({"synthetic":true,"catalog_products":50001,"family_links":100,"warmups_per_path":1,"samples_per_path":15,"build":if cfg!(debug_assertions){"Rust test dev profile; Node production-built React"}else{"Rust release profile; Node production-built React"},"pages":results,"product_lookup":lookups,"feed_sample":{"batches":3,"resources":resources,"elapsed_ms":feed_ms,"resources_per_second":resources as f64*1000./feed_ms,"sampled_test_process_peak_rss_kib":peak_rss,"scope":"three bounded reconciliation/delivery batches, not full catalog rebuild; test-process RSS sampled after each batch"},"sitemap":{"index_ms":index_ms,"index_bytes":xml.len(),"partitions":urls.len(),"sampled_partitions":3,"sampled_bytes":partition_bytes,"sampled_ms":partitions_ms},"renderer":metrics}),
    );
    task.abort();
}
use api_gateway::{
    discoverability::{self, App},
    identity,
    public_commerce::{
        feeds::{self, ReferenceAdapter},
        health,
        policy::Deployment,
    },
};
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use tower::ServiceExt;
use uuid::Uuid;
async fn app(pool: &PgPool, host: &str) -> App {
    let id: Uuid =
        sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
            .fetch_one(pool)
            .await
            .unwrap();
    let actor: Uuid = sqlx::query_scalar("SELECT id FROM admin_iam.admin_users LIMIT 1")
        .fetch_one(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest(&format!("stage11-{id}"))).bind(actor).execute(pool).await.unwrap();
    App {
        identity: identity::App::new(
            pool.clone(),
            infra_auth::Security::new(
                "stage11-synthetic-secret".repeat(4),
                format!("https://{host}"),
                false,
            )
            .await
            .unwrap(),
            vec![format!("https://{host}")],
        ),
        deployment: Deployment {
            installation_id: Some(id),
            environment: "production".into(),
            approved_origin: Some(format!("https://{host}/")),
            header_override: false,
            html: Some("built".into()),
        },
    }
}
async fn api(a: &App, method: &str, path: &str, body: Value, token: Option<Uuid>) -> (u16, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header(
            "origin",
            a.deployment
                .approved_origin
                .as_ref()
                .unwrap()
                .trim_end_matches('/'),
        )
        .header("x-commerce-request", "1")
        .header("content-type", "application/json");
    if let Some(id) = token {
        req = req.header("cookie", format!("admin_session=stage11-{id}"));
    }
    let r = discoverability::router_with_deployment(a.identity.clone(), a.deployment.clone())
        .oneshot(
            req.body(if method == "GET" {
                Body::empty()
            } else {
                Body::from(body.to_string())
            })
            .unwrap(),
        )
        .await
        .unwrap();
    let status = r.status().as_u16();
    let b = r.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&b).unwrap_or(Value::Null))
}
async fn drain(a: &App) {
    for _ in 0..20 {
        sqlx::query(
            "UPDATE platform.publication_freshness SET next_batch_at=now(),next_delivery_at=now()",
        )
        .execute(&a.identity.admins.pool)
        .await
        .unwrap();
        feeds::reconcile_batch(a).await.unwrap();
        feeds::deliver_batch(a, &ReferenceAdapter).await.unwrap();
        let done:bool=sqlx::query_scalar("SELECT completed_generation=generation AND cursor_kind='' FROM platform.publication_freshness").fetch_one(&a.identity.admins.pool).await.unwrap();
        if done {
            return;
        }
    }
    panic!("feed failed to converge")
}
async fn tenant_seed(pool: &PgPool, label: &str) {
    support::seed(
        pool,
        &format!("PUBLIC-{label} </script><script>globalThis.PWNED=1</script>"),
    )
    .await;
    sqlx::query("INSERT INTO catalog.media(id,content_type,alt,object_key,size_bytes) VALUES('00000000-0000-0000-0000-000000000030','image/png',$1,'PRIVATE-OBJECT-KEY',10),('00000000-0000-0000-0000-000000000031','image/png','PRIVATE-UNPUBLISHED','PRIVATE-UNPUBLISHED-KEY',10)").bind(format!("PUBLIC-{label}-IMAGE")).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.publication_images(media_id,width,height,variants) VALUES('00000000-0000-0000-0000-000000000030',100,100,'[]')").execute(pool).await.unwrap();
    sqlx::query("UPDATE catalog.products SET media_ids=ARRAY['00000000-0000-0000-0000-000000000030'::uuid],description=$1").bind(format!("PUBLIC-{label}-DESCRIPTION <img src=x onerror=globalThis.PWNED=2>")).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,active,media_ids) VALUES('00000000-0000-0000-0000-000000000099','PRIVATE-SKU','unpublished','PRIVATE-DRAFT','PRIVATE-DESCRIPTION',999,'USD','ea','00000000-0000-0000-0000-000000000001',false,ARRAY['00000000-0000-0000-0000-000000000031'::uuid])").execute(pool).await.unwrap();
    sqlx::query("UPDATE cms.publication_entity SET configuration=$1").bind(json!({"published":true,"legal_name":format!("PUBLIC-{label}-LEGAL"),"description":format!("PUBLIC-{label}-MERCHANT"),"contact_published":false,"email":"PRIVATE-CUSTOMER@example.test","telephone":"PRIVATE-PHONE","locations_published":false,"locations":["PRIVATE-ADDRESS"],"pages":[{"document_id":"00000000-0000-0000-0000-000000000003","revision_id":"00000000-0000-0000-0000-000000000004","purpose":"shipping","locale":"en","effective_date":null,"comparison_products":[]}]})).execute(pool).await.unwrap();
}
#[sqlx::test(migrations = "../../migrations")]
async fn complete_tenant_matrix_xss_privacy_and_background_restart(pool: PgPool) {
    let name = format!("stage11_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&pool)
        .await
        .unwrap();
    let other = sqlx::postgres::PgPoolOptions::new()
        .connect_with(pool.connect_options().as_ref().clone().database(&name))
        .await
        .unwrap();
    sqlx::migrate!("../../migrations")
        .run(&other)
        .await
        .unwrap();
    tenant_seed(&pool, "A").await;
    tenant_seed(&other, "B").await;
    let (base_a, _, _ra, ta) = support::fixture(&pool, "a.example.test").await;
    let (base_b, _, _rb, tb) = support::fixture(&other, "b.example.test").await;
    let a = app(&pool, "a.example.test").await;
    let b = app(&other, "b.example.test").await;
    let mut rows = vec![];
    for (base, host, label, foreign, a, other_id) in [
        (
            &base_a,
            "a.example.test",
            "A",
            "B",
            &a,
            b.deployment.installation_id,
        ),
        (
            &base_b,
            "b.example.test",
            "B",
            "A",
            &b,
            a.deployment.installation_id,
        ),
    ] {
        for path in ["/", "/products/apples", "/categories/fruit", "/pages/about"] {
            let r = reqwest::Client::new()
                .get(format!("{base}{path}"))
                .header("host", host)
                .header("x-forwarded-host", "attacker.example")
                .header("forwarded", "host=attacker.example;proto=http")
                .header("cookie", "customer=PRIVATE-COOKIE")
                .header("authorization", "Bearer PRIVATE-TOKEN")
                .send()
                .await
                .unwrap();
            assert_eq!(r.status(), 200);
            assert_eq!(r.headers()["cache-control"], "no-store");
            let body = r.text().await.unwrap();
            assert!(body.contains(&format!("PUBLIC-{label}")));
            for forbidden in [
                format!("PUBLIC-{foreign}"),
                format!("{}.example.test", foreign.to_lowercase()),
                "PRIVATE-".into(),
                "DO-NOT-PUBLISH".into(),
                "<script>globalThis.PWNED".into(),
                "<img src=x onerror".into(),
                "attacker.example".into(),
            ] {
                assert!(!body.contains(&forbidden), "{path}: {forbidden}");
            }
            assert!(body.contains(&format!("https://{host}")));
            rows.push(json!({"tenant":label,"surface":path,"status":200,"isolated":true,"xss_escaped":true}));
            if path == "/products/apples" {
                evidence(
                    &format!("tenant-{label}-snapshot"),
                    serde_json::from_str(
                        body.split("id=\"publication-state\" type=\"application/json\">")
                            .nth(1)
                            .unwrap()
                            .split("</script>")
                            .next()
                            .unwrap(),
                    )
                    .unwrap(),
                );
            }
        }
        let xml = support::get(base, host, "/sitemap.xml")
            .await
            .text()
            .await
            .unwrap();
        assert!(!xml.contains("unpublished"));
        assert!(!xml.contains(&format!("{}.example.test", foreign.to_lowercase())));
        for url in xml
            .split("<loc>")
            .skip(1)
            .map(|s| s.split("</loc>").next().unwrap())
        {
            assert!(url.starts_with(&format!("https://{host}/")));
            let part = support::get(
                base,
                host,
                url.strip_prefix(&format!("https://{host}")).unwrap(),
            )
            .await
            .text()
            .await
            .unwrap();
            assert!(!part.contains("unpublished"));
            assert!(!part.contains("PRIVATE"));
            for loc in part
                .split("<loc>")
                .skip(1)
                .map(|v| v.split("</loc>").next().unwrap())
            {
                assert!(loc.starts_with(&format!("https://{host}/")));
            }
        }
        let robots = support::get(base, host, "/robots.txt")
            .await
            .text()
            .await
            .unwrap();
        assert!(robots.contains(&format!("https://{host}/sitemap.xml")));
        let redirect = support::get(base, host, "/products/old-apples").await;
        assert_eq!(redirect.status(), 301);
        assert_eq!(redirect.headers()["location"], "/products/apples");
        assert_eq!(
            support::get(base, "foreign.example.test", "/products/apples")
                .await
                .status(),
            421
        );
        assert_eq!(
            support::get(base, host, "/products/unpublished")
                .await
                .status(),
            404
        );
        let mut db = a.identity.admins.pool.acquire().await.unwrap();
        let public = "00000000-0000-0000-0000-000000000030".parse().unwrap();
        assert!(
            api_gateway::public_commerce::images::is_public(&mut db, public)
                .await
                .unwrap()
        );
        assert!(!api_gateway::public_commerce::images::is_public(
            &mut db,
            "00000000-0000-0000-0000-000000000031".parse().unwrap()
        )
        .await
        .unwrap());
        drop(db);
        verify_media_bytes(a, label).await;
        let channel = if label == "A" {
            "chatgpt.com"
        } else {
            "claude.ai"
        };
        let event = json!({"id":Uuid::from_u128(400),"session_id":Uuid::from_u128(401),"path":"/products/apples","evidence":{"referrer":format!("https://{channel}/PRIVATE-CONVERSATION")}});
        assert_eq!(
            api(a, "POST", "/v1/discovery/attribution", event, None)
                .await
                .0,
            200
        );
        for route in [
            "analytics",
            "health",
            "entity",
            "metadata",
            "crawlers",
            "feeds",
            "config",
        ] {
            let path = format!("/v1/admin/discovery/{route}");
            assert_eq!(api(a, "GET", &path, Value::Null, other_id).await.0, 401);
            assert_eq!(api(a, "GET", &path, Value::Null, None).await.0, 401);
            let (status, own) =
                api(a, "GET", &path, Value::Null, a.deployment.installation_id).await;
            assert_eq!(status, 200);
            assert!(!own.to_string().contains(&format!("PUBLIC-{foreign}")));
            assert!(!own
                .to_string()
                .contains(&format!("{}.example.test", foreign.to_lowercase())));
        }
        let (_, analytics) = api(
            a,
            "GET",
            "/v1/admin/discovery/analytics",
            Value::Null,
            a.deployment.installation_id,
        )
        .await;
        assert_eq!(
            analytics["channels"][0]["channel"],
            if label == "A" {
                "ai_chatgpt"
            } else {
                "ai_claude"
            }
        );
        assert_eq!(analytics["channels"][0]["sessions"], 1);
        drain(a).await;
        let (_, feed) = api(
            a,
            "GET",
            "/v1/admin/discovery/feeds/export?full=true",
            Value::Null,
            a.deployment.installation_id,
        )
        .await;
        let text = feed.to_string();
        assert!(text.contains(&format!("PUBLIC-{label}")));
        assert!(!text.contains(&format!("PUBLIC-{foreign}")));
        assert!(!text.contains("PRIVATE"));
        rows.push(json!({"tenant":label,"surfaces":["metadata/canonical","JSON-LD","robots","sitemap/partitions","redirect","feed/export","media references, identical-key isolated object-store bytes and authorization","merchant/policies","health","analytics","no-store responses","durable background jobs"],"isolated":true,"identical":"product/category/media/CMS IDs, slug, SKU, locale, event/session IDs"}));
    }
    // A stopped/recreated worker keeps durable state; B is unaffected by A withdrawal.
    sqlx::query("UPDATE catalog.products SET active=false WHERE sku='APPLE'")
        .execute(&pool)
        .await
        .unwrap();
    let restarted = tokio::spawn(feeds::worker(a.clone()));
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    restarted.abort();
    let _ = restarted.await;
    drain(&a.clone()).await;
    assert_eq!(
        support::get(&base_a, "a.example.test", "/products/apples")
            .await
            .status(),
        404
    );
    assert_eq!(
        support::get(&base_b, "b.example.test", "/products/apples")
            .await
            .status(),
        200
    );
    let (_, f) = api(
        &a,
        "GET",
        "/v1/admin/discovery/feeds/export?full=true",
        Value::Null,
        a.deployment.installation_id,
    )
    .await;
    assert!(!f.to_string().contains("PUBLIC-A"));
    evidence(
        "tenant-matrix",
        json!({"synthetic":true,"rows":rows,"withdrawal_and_worker_restart_isolated":true}),
    );
    ta.abort();
    tb.abort();
    other.close().await;
    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .execute(&pool)
        .await
        .unwrap();
}
#[sqlx::test(migrations = "../../migrations")]
async fn database_timeout_and_recovery(pool: PgPool) {
    support::seed(&pool, "Apples").await;
    let (base, _, _r, task) = support::fixture(&pool, "shop.example.test").await;
    let mut lock = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE catalog.products IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *lock)
        .await
        .unwrap();
    let start = Instant::now();
    let r = support::get(&base, "shop.example.test", "/products/apples").await;
    assert_eq!(r.status(), 503);
    let ms = start.elapsed().as_millis();
    assert!(ms < 5500);
    let body = r.text().await.unwrap();
    assert!(!body.contains("SELECT"));
    assert!(!body.contains("Apples"));
    lock.rollback().await.unwrap();
    assert_eq!(
        support::get(&base, "shop.example.test", "/products/apples")
            .await
            .status(),
        200
    );
    evidence(
        "database-timeout",
        json!({"synthetic":true,"blocked_table":"catalog.products","status":503,"elapsed_ms":ms,"recovery_status":200,"stale_html_served":false}),
    );
    task.abort();
}
#[sqlx::test(migrations = "../../migrations")]
async fn admin_authorization_audit_and_fixed_probe_target(pool: PgPool) {
    support::seed(&pool, "Apples").await;
    let (_, _, _r, task) = support::fixture(&pool, "shop.example.test").await;
    let a = app(&pool, "shop.example.test").await;
    let id = a.deployment.installation_id;
    for route in ["metadata", "entity"] {
        let path = format!("/v1/admin/discovery/{route}");
        let (_, stored) = api(&a, "GET", &path, Value::Null, id).await;
        let input =
            json!({"expected_revision":stored["revision"],"configuration":stored["configuration"]});
        assert_eq!(api(&a, "PUT", &path, input.clone(), None).await.0, 401);
        assert_eq!(api(&a, "PUT", &path, input.clone(), id).await.0, 200);
        assert_eq!(api(&a, "PUT", &path, input, id).await.0, 409);
    }
    let n:i64=sqlx::query_scalar("SELECT count(*) FROM admin_iam.audit_log WHERE action IN ('discovery.entity.updated','discovery.metadata.updated')").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 2);
    for target in [
        "file:///etc/passwd",
        "http://user:secret@127.0.0.1/",
        "http://127.0.0.1/?target=http://169.254.169.254/",
    ] {
        let v = health::assess(&a, Some(target), Some(&"x".repeat(32)))
            .await
            .unwrap();
        assert!(v["findings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["code"] == "renderer_probe" && v["severity"] == "Warning"));
        assert!(!v.to_string().contains("secret@"));
    }
    task.abort();
}
async fn verify_media_bytes(a: &App, label: &str) {
    use axum::{body::Bytes, extract::State, Router};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let color = if label == "A" {
        [255, 0, 0]
    } else {
        [0, 0, 255]
    };
    let mut png = std::io::Cursor::new(vec![]);
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(100, 100, image::Rgb(color)))
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let state = (Bytes::from(png.into_inner()), calls.clone());
    async fn object(State((bytes, calls)): State<(Bytes, Arc<AtomicUsize>)>) -> Bytes {
        calls.fetch_add(1, Ordering::SeqCst);
        bytes
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, Router::new().fallback(object).with_state(state))
            .await
            .unwrap()
    });
    let router = api_gateway::catalog::router(api_gateway::catalog::App {
        identity: a.identity.clone(),
        catalog: domain_catalog::Service {
            pool: a.identity.admins.pool.clone(),
        },
        media: infra_media::Store::new(endpoint, "test", "test").unwrap(),
        search: domain_search_client::Client::new("http://localhost:1".into(), "test".into()),
        analytics: api_gateway::analytics::Client::new(
            "http://localhost:1".into(),
            "test".into(),
            "test".into(),
        ),
    });
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/catalog/media/00000000-0000-0000-0000-000000000030/content")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let decoded = image::load_from_memory(&bytes).unwrap().into_rgb8();
    assert_eq!(decoded.get_pixel(0, 0).0, color);
    let read_count = calls.load(Ordering::SeqCst);
    let denied = router
        .oneshot(
            Request::builder()
                .uri("/v1/catalog/media/00000000-0000-0000-0000-000000000031/content")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), 401);
    assert_eq!(calls.load(Ordering::SeqCst), read_count);
    task.abort();
}
