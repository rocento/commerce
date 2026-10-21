use api_gateway::{discoverability, identity, public_commerce::policy::Deployment};
use infra_auth::Security;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;
async fn fixture(
    pool: &PgPool,
    environment: &str,
    wrong_binding: bool,
) -> (String, tokio::task::JoinHandle<()>) {
    let id: Uuid =
        sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
            .fetch_one(pool)
            .await
            .unwrap();
    sqlx::query("UPDATE cms.discoverability_settings SET enabled=true,indexing_enabled=true,canonical_url='https://shop.example.test/'").execute(pool).await.unwrap();
    let security = Security::new(
        "discovery-test".repeat(6),
        "https://shop.example.test".into(),
        false,
    )
    .await
    .unwrap();
    let router = discoverability::router_with_deployment(
        identity::App::new(
            pool.clone(),
            security,
            vec!["https://shop.example.test".into()],
        ),
        Deployment {
            installation_id: Some(if wrong_binding { Uuid::new_v4() } else { id }),
            environment: environment.into(),
            approved_origin: Some("https://shop.example.test/".into()),
            header_override: false,
            html: Some("<html><head></head></html>".into()),
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (base, task)
}
async fn get(base: &str, path: &str) -> reqwest::Response {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("{base}{path}"))
        .header("host", "shop.example.test")
        .send()
        .await
        .unwrap()
}
fn locations(xml: &str) -> Vec<String> {
    xml.split("<loc>")
        .skip(1)
        .map(|s| s.split("</loc>").next().unwrap().into())
        .collect()
}
async fn seed(pool: &PgPool, n: i32) {
    sqlx::query("INSERT INTO catalog.categories(id,name,slug) VALUES('00000000-0000-0000-0000-000000000001','Category','category')").execute(pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) SELECT md5(i::text)::uuid,'SKU-'||i,'product-'||i,'Product '||i,'Public description',10,'USD','ea','00000000-0000-0000-0000-000000000001' FROM generate_series(1,$1) i").bind(n).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO cms.documents(id,key,kind) VALUES('00000000-0000-0000-0000-000000000003','about','page'),('00000000-0000-0000-0000-000000000005','draft','page')").execute(pool).await.unwrap();
    sqlx::query("INSERT INTO cms.revisions(id,document_id,version,title,blocks,created_by) VALUES('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000003',1,'About','[]',gen_random_uuid())").execute(pool).await.unwrap();
    sqlx::query("INSERT INTO cms.releases(id,document_id,revision_id,starts_at) VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','2026-01-01T00:00:00Z')").execute(pool).await.unwrap();
}
#[sqlx::test(migrations = "../../migrations")]
async fn partitions_eligibility_freshness_and_xml(pool: PgPool) {
    seed(&pool, 2105).await;
    sqlx::query("UPDATE catalog.products SET active=false WHERE sku='SKU-1'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE catalog.products SET parent_id=md5('1')::uuid WHERE sku='SKU-2'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO platform.publication_routes(path,status,target,reason) VALUES('/products/product-3',410,NULL,'Removed'),('/products/product-4',301,'/products/product-5','Replacement')").execute(&pool).await.unwrap();
    let (base, task) = fixture(&pool, "production", false).await;
    let index = get(&base, "/sitemap.xml").await;
    assert_eq!(index.status(), 200);
    assert_eq!(index.headers()["cache-control"], "no-store");
    assert_eq!(index.headers()["x-robots-tag"], "noindex, nofollow");
    let index = index.text().await.unwrap();
    let partitions = locations(&index);
    assert_eq!(partitions.len(), 6);
    let mut urls = std::collections::BTreeSet::new();
    let mut files = vec![index.clone()];
    for url in partitions {
        assert!(url.starts_with("https://shop.example.test/sitemaps/"));
        let path = url.strip_prefix("https://shop.example.test").unwrap();
        let response = get(&base, path).await;
        assert_eq!(response.status(), 200);
        let body = response.text().await.unwrap();
        assert_eq!(get(&base, path).await.text().await.unwrap(), body);
        let locs = locations(&body);
        assert!(locs.len() <= 1000);
        for loc in locs {
            assert!(urls.insert(loc));
        }
        if path.contains("content-") {
            assert!(body.contains("<lastmod>2026-01-01T00:00:00+00:00</lastmod>"));
        } else {
            assert!(!body.contains("lastmod"));
        }
        files.push(body);
    }
    assert_eq!(urls.len(), 2104);
    for n in 1..=4 {
        assert!(!urls.contains(&format!("https://shop.example.test/products/product-{n}")));
    }
    assert!(urls.contains("https://shop.example.test/categories/category"));
    assert!(urls.contains("https://shop.example.test/pages/about"));
    assert!(!urls.iter().any(|s| s.contains("draft") || s.contains('?')));
    // Parse with an independent XML implementation, checking namespace and both document types.
    let mut child=std::process::Command::new("python3").args(["-c","import json,sys,xml.etree.ElementTree as E\nfor doc in json.load(sys.stdin):\n r=E.fromstring(doc); assert r.tag in ['{http://www.sitemaps.org/schemas/sitemap/0.9}urlset','{http://www.sitemaps.org/schemas/sitemap/0.9}sitemapindex']; assert all(e.find('{http://www.sitemaps.org/schemas/sitemap/0.9}loc') is not None for e in r)"]).stdin(std::process::Stdio::piped()).spawn().unwrap();
    use std::io::Write;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&files).unwrap().as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success());
    if let Ok(dir) = std::env::var("PUBLICATION_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            format!("{dir}/sitemap-samples.json"),
            serde_json::to_string_pretty(&files).unwrap(),
        )
        .unwrap();
    }
    assert_eq!(get(&base, "/llms.txt").await.status(), 404);
    assert_eq!(get(&base, "/sitemap.xml?preview=1").await.status(), 404);
    task.abort();
}
#[sqlx::test(migrations = "../../migrations")]
async fn policy_matrix_binding_and_provider_controls(pool: PgPool) {
    for env in ["production", "demo", "staging", "admin", "development"] {
        let (base, task) = fixture(&pool, env, false).await;
        let robots = get(&base, "/robots.txt").await;
        assert_eq!(robots.status(), 200);
        assert_eq!(robots.headers()["x-robots-tag"], "noindex, nofollow");
        let body = robots.text().await.unwrap();
        if let Ok(dir) = std::env::var("PUBLICATION_EVIDENCE_DIR") {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(format!("{dir}/robots-{env}.txt"), &body).unwrap();
        }
        if env == "production" {
            assert!(body.contains("Sitemap: https://shop.example.test/sitemap.xml"));
            assert!(body.contains("User-agent: GPTBot\nDisallow: /"));
            assert!(body.contains("User-agent: OAI-SearchBot\nAllow: /"));
            assert!(body.contains("Allow: /api/v1/catalog/media/*/content"));
            assert!(body.contains("Disallow: /checkout"));
        } else {
            assert_eq!(body, "User-agent: *\nDisallow: /\n");
            assert_eq!(get(&base, "/sitemap.xml").await.status(), 404);
        }
        task.abort();
    }
    let (base, task) = fixture(&pool, "production", false).await;
    sqlx::query("UPDATE cms.publication_crawlers SET openai_search=false,openai_training=true")
        .execute(&pool)
        .await
        .unwrap();
    let body = get(&base, "/robots.txt").await.text().await.unwrap();
    assert!(body.contains("User-agent: OAI-SearchBot\nDisallow: /"));
    assert!(body.contains("User-agent: GPTBot\nAllow: /"));
    sqlx::query("UPDATE cms.discoverability_settings SET indexing_enabled=false")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(get(&base, "/sitemap.xml").await.status(), 404);
    let body = get(&base, "/robots.txt").await.text().await.unwrap();
    assert!(!body.contains("Sitemap:"));
    assert!(body.contains("User-agent: *\nAllow: /"));
    assert!(body.contains("User-agent: GPTBot\nDisallow: /"));
    let wrong = reqwest::Client::new()
        .get(format!("{base}/sitemap.xml"))
        .header("host", "foreign.example.test")
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 421);
    task.abort();
    let (base, task) = fixture(&pool, "production", true).await;
    for path in ["/robots.txt", "/sitemap.xml"] {
        assert_eq!(get(&base, path).await.status(), 503);
    }
    task.abort();
}
#[sqlx::test(migrations = "../../migrations")]
async fn crawler_permissions_revision_and_audit(pool: PgPool) {
    let (base, task) = fixture(&pool, "production", false).await;
    assert_eq!(
        get(&base, "/v1/admin/discovery/crawlers").await.status(),
        401
    );
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'crawler@example.test','Publisher','!',$2)").bind(user).bind(domain_admin_iam::SUPER).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest(&user.to_string())).bind(user).execute(&pool).await.unwrap();
    let client = reqwest::Client::new();
    let input = json!({"expected_revision":1,"openai_search":false,"openai_training":false});
    for expected in [200, 409] {
        let r = client
            .put(format!("{base}/v1/admin/discovery/crawlers"))
            .header("cookie", format!("admin_session={user}"))
            .header("origin", "https://shop.example.test")
            .header("X-Commerce-Request", "1")
            .json(&input)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), expected);
    }
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM admin_iam.audit_log WHERE action='discovery.crawlers.updated'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audits, 1);
    task.abort();
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "explicit two-million-product capacity check"]
async fn two_million_product_capacity(pool: PgPool) {
    seed(&pool, 0).await;
    // Bulk fixture setup bypasses only per-row slug normalization; equivalent normalized
    // slugs and both alias reservations are inserted below before restoring the trigger.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("ALTER TABLE catalog.products DISABLE TRIGGER publication_product_slug")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) SELECT md5(i::text)::uuid,'SKU-'||i,'product-'||i,'Product '||i,'Public description',10,'USD','ea','00000000-0000-0000-0000-000000000001' FROM generate_series(1,2000000) i").execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO platform.publication_aliases(resource_kind,route_key,resource_id) SELECT 'products',slug,id FROM catalog.products UNION ALL SELECT 'products',id::text,id FROM catalog.products").execute(&mut *tx).await.unwrap();
    sqlx::query("ALTER TABLE catalog.products ENABLE TRIGGER publication_product_slug")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM catalog.products")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 2_000_000);
    sqlx::query("ANALYZE catalog.products")
        .execute(&pool)
        .await
        .unwrap();
    let (base, task) = fixture(&pool, "production", false).await;
    let start = std::time::Instant::now();
    let r = get(&base, "/sitemap.xml").await;
    assert_eq!(r.status(), 200);
    let body = r.text().await.unwrap();
    let partitions = locations(&body);
    assert_eq!(partitions.len(), 2003);
    let mut sizes = Vec::new();
    for index in [1, 1000, 2000] {
        let path = partitions[index]
            .strip_prefix("https://shop.example.test")
            .unwrap();
        let r = get(&base, path).await;
        assert_eq!(r.status(), 200);
        let xml = r.text().await.unwrap();
        sizes.push(locations(&xml).len());
        assert_eq!(locations(&xml).len(), 1000);
    }
    let result = json!({"products":2_000_000,"index_entries":partitions.len(),"index_bytes":body.len(),"index_plus_three_partitions_ms":start.elapsed().as_millis(),"sample_partition_sizes":sizes});
    println!("{result}");
    if let Ok(dir) = std::env::var("PUBLICATION_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            format!("{dir}/scale.json"),
            serde_json::to_string_pretty(&result).unwrap(),
        )
        .unwrap();
    }
    task.abort();
}

#[sqlx::test(migrations = "../../migrations")]
async fn stale_partition_growth_fails_instead_of_truncating(pool: PgPool) {
    seed(&pool, 1000).await;
    let (base, task) = fixture(&pool, "production", false).await;
    let index = get(&base, "/sitemap.xml").await.text().await.unwrap();
    let partition = locations(&index)
        .into_iter()
        .find(|s| s.contains("products-"))
        .unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) VALUES('ffffffff-ffff-ffff-ffff-ffffffffffff','NEW','new','New','New',1,'USD','ea','00000000-0000-0000-0000-000000000001')").execute(&pool).await.unwrap();
    assert_eq!(
        get(
            &base,
            partition.strip_prefix("https://shop.example.test").unwrap()
        )
        .await
        .status(),
        503
    );
    let index = get(&base, "/sitemap.xml").await.text().await.unwrap();
    assert_eq!(
        locations(&index)
            .iter()
            .filter(|s| s.contains("products-"))
            .count(),
        2
    );
    task.abort();
}
