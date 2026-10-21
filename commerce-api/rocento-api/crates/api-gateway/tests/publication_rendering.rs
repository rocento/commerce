use api_gateway::{discoverability, identity, public_commerce::policy::Deployment};
use infra_auth::Security;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::io::{BufRead, BufReader};
use uuid::Uuid;

struct Renderer(std::process::Child);
impl Drop for Renderer {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
async fn fixture(
    pool: &PgPool,
    host: &str,
) -> (String, String, Renderer, tokio::task::JoinHandle<()>) {
    let id: Uuid =
        sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
            .fetch_one(pool)
            .await
            .unwrap();
    sqlx::query("UPDATE cms.discoverability_settings SET site_name=$1,enabled=true,indexing_enabled=true,canonical_url=$2").bind(format!("Merchant {host}")).bind(format!("https://{host}/")).execute(pool).await.unwrap();
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../commerce-web/apps/storefront");
    let security = Security::new(
        "publication-secret".repeat(4),
        format!("https://{host}"),
        false,
    )
    .await
    .unwrap();
    let router = discoverability::router_with_deployment(
        identity::App::new(pool.clone(), security, vec![format!("https://{host}")]),
        Deployment {
            installation_id: Some(id),
            environment: "production".into(),
            approved_origin: Some(format!("https://{host}/")),
            header_override: false,
            html: Some(
                std::fs::read_to_string(
                    std::env::var("PUBLICATION_ARTIFACT_DIR")
                        .map(std::path::PathBuf::from)
                        .unwrap_or_else(|_| root.join("dist"))
                        .join("index.html"),
                )
                .expect("Build storefront first"),
            ),
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gateway = format!("http://{}/", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let child = std::process::Command::new("node")
        .arg("server/start.mjs")
        .current_dir(&root)
        .env("PUBLICATION_APPROVED_ORIGIN", format!("https://{host}/"))
        .env("PUBLICATION_INSTALLATION_ID", id.to_string())
        .env("NODE_ENV", "production")
        .env("PUBLICATION_GATEWAY", &gateway)
        .env("PUBLICATION_PORT", "0")
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut child = Renderer(child);
    let mut line = String::new();
    let mut stdout = BufReader::new(child.0.stdout.take().unwrap());
    stdout.read_line(&mut line).unwrap();
    // Keep the child log pipe open: runtime observations must not trigger EPIPE.
    std::thread::spawn(move || {
        for line in stdout.lines() {
            if line.is_err() {
                break;
            }
        }
    });
    let data: Value = serde_json::from_str(&line).expect("Renderer startup");
    (
        format!("http://127.0.0.1:{}", data["port"]),
        gateway,
        child,
        task,
    )
}
async fn seed(pool: &PgPool, name: &str) {
    let actor = Uuid::new_v4();
    let theme = Uuid::new_v4();
    let version = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'publisher@example.test','Publisher','!', $2)").bind(actor).bind(domain_admin_iam::SUPER).execute(pool).await.unwrap();
    let mut published =
        serde_json::to_value(domain_theme::domain::default_configuration()).unwrap();
    published["tokens"]["color.primary"] = json!("#175C39");
    published["global"]["top"][0]["settings"]["text"] = json!("Published merchant announcement");
    let mut draft = published.clone();
    draft["global"]["top"][0]["settings"]["text"] = json!("DO-NOT-PUBLISH draft theme");
    sqlx::query("INSERT INTO theme.themes(id,name,owner_channel,configuration,created_by) VALUES($1,'Public theme','storefront',$2,$3)").bind(theme).bind(draft).bind(actor).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO theme.versions(id,theme_id,number,configuration,created_by) VALUES($1,$2,1,$3,$4)").bind(version).bind(theme).bind(published).bind(actor).execute(pool).await.unwrap();
    sqlx::query("UPDATE theme.themes SET published_version=$2 WHERE id=$1")
        .bind(theme)
        .bind(version)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO theme.assignments(channel,theme_id) VALUES('storefront',$1) ON CONFLICT(channel) DO UPDATE SET theme_id=$1").bind(theme).execute(pool).await.unwrap();

    sqlx::query("INSERT INTO catalog.categories(id,name,slug,attributes) VALUES('00000000-0000-0000-0000-000000000001','Fresh fruit','fruit','{\"description\":\"Seasonal fruit selected by our store\"}')").execute(pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,attributes) VALUES('00000000-0000-0000-0000-000000000002','APPLE','apples',$1,'Crisp orchard apples, sold by the kilogram.',3.25,'USD','kg','00000000-0000-0000-0000-000000000001','{\"color\":\"Red\",\"secret\":\"DO-NOT-PUBLISH\",\"unknown\":\"DO-NOT-PUBLISH\"}')").bind(name).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO attributes.definitions(id,entity_type,attribute_code,label,input_type,is_visible_on_front) VALUES(gen_random_uuid(),'product','color','Color','text',true),(gen_random_uuid(),'product','secret','Secret','text',false)").execute(pool).await.unwrap();
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km) VALUES(gen_random_uuid(),'Cairo',30,31,10)").execute(pool).await.unwrap();
    sqlx::query("INSERT INTO cms.documents(id,key,kind) VALUES('00000000-0000-0000-0000-000000000003','about','page')").execute(pool).await.unwrap();
    sqlx::query("INSERT INTO cms.revisions(id,document_id,version,title,blocks,created_by) VALUES('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000003',1,'About our store',$1,gen_random_uuid())").bind(json!([{"kind":"text","heading":"Our produce","text":"We select fresh produce every morning.","image_id":null,"link_label":"Browse fruit","link_url":"/categories/fruit"}])).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO cms.releases(id,document_id,revision_id,starts_at) VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',now()-interval '1 hour')").execute(pool).await.unwrap();
    sqlx::query("INSERT INTO platform.publication_routes(path,status,target,reason) VALUES('/products/old-apples',301,'/products/apples','Approved rename'),('/products/retired',410,NULL,'Approved permanent removal')").execute(pool).await.unwrap();
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}
async fn get(base: &str, host: &str, path: &str) -> reqwest::Response {
    client()
        .get(format!("{base}{path}"))
        .header("host", host)
        .send()
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn built_renderer_real_http_status_content_freshness_and_isolation(pool: PgPool) {
    seed(&pool, "Orchard apples").await;
    let (base, gateway, _renderer, task) = fixture(&pool, "shop.example.test").await;
    for (path, expected) in [
        ("/", "Orchard apples"),
        ("/products/apples", "Crisp orchard apples"),
        ("/categories/fruit", "Seasonal fruit"),
        ("/pages/about", "We select fresh produce"),
    ] {
        let response = get(&base, "shop.example.test", path).await;
        assert_eq!(response.status(), 200, "{path}");
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.headers()["x-robots-tag"], "index, follow");
        let html = response.text().await.unwrap();
        assert!(html.contains(expected), "{path}");
        assert!(!html.contains("DO-NOT-PUBLISH"));
        assert!(html.contains("Published merchant announcement"));
        assert!(html.contains("--theme-color-primary:#175C39"));
        assert!(!html.contains("Loading your account"));
        let body = html
            .split("<script id=\"publication-state\"")
            .next()
            .unwrap();
        assert!(
            body.contains(expected),
            "Content must be visible HTML, not only embedded JSON"
        );
        if let Ok(output) = std::env::var("PUBLICATION_EVIDENCE_DIR") {
            std::fs::create_dir_all(&output).unwrap();
            let result = tokio::process::Command::new("curl")
                .args([
                    "--silent",
                    "--show-error",
                    "--include",
                    "--noproxy",
                    "*",
                    "-H",
                    "Host: shop.example.test",
                    &format!("{base}{path}"),
                ])
                .output()
                .await
                .unwrap();
            assert!(result.status.success());
            std::fs::write(
                format!(
                    "{output}/{}.http",
                    (if path == "/" {
                        "home"
                    } else {
                        path.trim_matches('/')
                    })
                    .replace('/', "-")
                    .replace('.', "_")
                ),
                result.stdout,
            )
            .unwrap();
        }
    }
    let anonymous = get(&base, "shop.example.test", "/products/apples")
        .await
        .text()
        .await
        .unwrap();
    let session = client()
        .get(format!("{base}/products/apples"))
        .header("host", "shop.example.test")
        .header("cookie", "customer_session=private; admin_session=private")
        .header("authorization", "Bearer private")
        .header("x-delivery-location", "private")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(anonymous, session);
    assert!(anonymous.contains("Availability varies by delivery location"));
    assert!(!anonymous.contains("InStock"));
    assert!(anonymous.contains("<dt>Color</dt><dd>Red</dd>"));
    for path in [
        "/unknown",
        "/products/missing",
        "/products/missing?shop=1",
        "/categories/missing",
        "/pages/draft",
        "/products/apples/extra",
        "/categories/fruit?page=999",
    ] {
        assert_eq!(
            get(&base, "shop.example.test", path).await.status(),
            404,
            "{path}"
        );
    }
    assert_eq!(
        get(&base, "shop.example.test", "/products/retired")
            .await
            .status(),
        410
    );
    let redirect = get(&base, "shop.example.test", "/products/old-apples").await;
    assert_eq!(redirect.status(), 301);
    assert_eq!(redirect.headers()["location"], "/products/apples");
    assert_eq!(get(&base, "attacker.example.test", "/").await.status(), 421);
    for path in [
        "/cart",
        "/account",
        "/search",
        "/login",
        "/products/00000000-0000-0000-0000-000000000002?shop=1",
    ] {
        let r = get(&base, "shop.example.test", path).await;
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["x-robots-tag"], "noindex, nofollow");
    }
    assert_eq!(
        get(
            gateway.trim_end_matches('/'),
            "shop.example.test",
            "/unknown"
        )
        .await
        .status(),
        404
    );
    assert_eq!(
        get(
            gateway.trim_end_matches('/'),
            "shop.example.test",
            "/products/apples"
        )
        .await
        .status(),
        503
    );
    // Optional real-browser proof against this same built renderer + live database.
    if std::env::var_os("PUBLICATION_BROWSER_CHECK").is_some() {
        let result = tokio::process::Command::new("node")
            .arg("e2e/publication-check.mjs")
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../commerce-web"))
            .env("PUBLICATION_TEST_URL", &base)
            .env("PUBLICATION_TEST_GATEWAY", &gateway)
            .output()
            .await
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
    let media = Uuid::new_v4();
    sqlx::query("INSERT INTO catalog.media(id,content_type,alt,object_key,size_bytes) VALUES($1,'image/png','Fresh orchard apples','PRIVATE_OBJECT_KEY',12)").bind(media).execute(&pool).await.unwrap();
    sqlx::query("UPDATE catalog.products SET media_ids=ARRAY[$1] WHERE slug='apples'")
        .bind(media)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO catalog.publication_images(media_id,width,height) VALUES($1,1200,800)",
    )
    .bind(media)
    .execute(&pool)
    .await
    .unwrap();
    let image_html = get(&base, "shop.example.test", "/products/apples")
        .await
        .text()
        .await
        .unwrap();
    assert!(image_html.contains("alt=\"Fresh orchard apples\""));
    assert!(image_html.contains(&format!("/api/v1/catalog/media/{media}/content")));
    assert!(!image_html.contains("PRIVATE_OBJECT_KEY"));
    sqlx::query("UPDATE cms.releases SET ends_at=now()-interval '1 minute'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        get(&base, "shop.example.test", "/pages/about")
            .await
            .status(),
        404
    );
    if let Ok(output) = std::env::var("PUBLICATION_EVIDENCE_DIR") {
        for (path, name) in [
            ("/products/missing", "unknown-404"),
            ("/products/retired", "retired-410"),
            ("/products/old-apples", "renamed-301"),
        ] {
            let result = tokio::process::Command::new("curl")
                .args([
                    "--silent",
                    "--show-error",
                    "--include",
                    "--noproxy",
                    "*",
                    "-H",
                    "Host: shop.example.test",
                    &format!("{base}{path}"),
                ])
                .output()
                .await
                .unwrap();
            assert!(result.status.success());
            std::fs::write(format!("{output}/{name}.http"), result.stdout).unwrap();
        }
    }
    sqlx::query("UPDATE catalog.products SET name='Updated apples',price=4.50 WHERE slug='apples'")
        .execute(&pool)
        .await
        .unwrap();
    let fresh = get(&base, "shop.example.test", "/products/apples")
        .await
        .text()
        .await
        .unwrap();
    assert!(fresh.contains("Updated apples"));
    assert!(fresh.contains("4.50"));
    sqlx::query("UPDATE catalog.products SET active=false WHERE slug='apples'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        get(&base, "shop.example.test", "/products/apples")
            .await
            .status(),
        404
    );
    assert_eq!(
        get(&base, "shop.example.test", "/products/old-apples")
            .await
            .status(),
        404
    );
    let name = format!("publication_{}", Uuid::new_v4().simple());
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
    seed(&other, "Second merchant apples").await;
    let (second, _, _other_renderer, other_task) = fixture(&other, "other.example.test").await;
    let html = get(&second, "other.example.test", "/products/apples")
        .await
        .text()
        .await
        .unwrap();
    assert!(html.contains("Second merchant apples"));
    assert!(html.contains("rel=\"canonical\" href=\"https://other.example.test/products/apples\""));
    assert!(!html.contains("https://shop.example.test/products/apples"));
    assert!(!html.contains("Updated apples"));
    canonical_evidence(
        &second,
        "other.example.test",
        "/products/apples",
        "tenant-b-canonical-200",
    )
    .await;
    assert_eq!(
        get(&second, "shop.example.test", "/products/apples")
            .await
            .status(),
        421
    );
    other_task.abort();
    other.close().await;
    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .execute(&pool)
        .await
        .unwrap();
    task.abort();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        get(&base, "shop.example.test", "/products/apples")
            .await
            .status(),
        503
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn canonical_lifecycle_single_hop_and_query_policy(pool: PgPool) {
    seed(&pool, "Orchard apples").await;
    let (base, gateway, _renderer, task) = fixture(&pool, "shop.example.test").await;
    let id = "00000000-0000-0000-0000-000000000002";
    let initial = get(&base, "shop.example.test", "/products/apples")
        .await
        .text()
        .await
        .unwrap();
    assert!(
        initial.contains("rel=\"canonical\" href=\"https://shop.example.test/products/apples\"")
    );
    assert!(initial.contains("href=\"/categories/fruit\""));
    // The product must not recommend itself; the category remains its crawlable entry.
    assert!(!initial.contains("href=\"/products/apples\""));
    let category_html = get(&base, "shop.example.test", "/categories/fruit")
        .await
        .text()
        .await
        .unwrap();
    assert!(category_html.contains("href=\"/products/apples\""));
    for path in [
        format!("/products/{id}"),
        "/PrOdUcTs/%61pples/?utm_source=email".into(),
        "/products/apples?campaign=mail".into(),
        "/products/apples?page=01".into(),
        "/products/apples?locale=en".into(),
    ] {
        let response = get(&base, "shop.example.test", &path).await;
        assert_eq!(response.status(), 301, "{path}");
        assert_eq!(response.headers()["location"], "/products/apples");
        assert_eq!(
            get(&base, "shop.example.test", "/products/apples")
                .await
                .status(),
            200
        );
    }
    for path in [
        "/products/apples?locale=ar",
        "/ar/products/apples",
        "/products/apples?sort=price",
        "/products/apples?filter=color",
        "/products/apples?variant=small",
        "/products/apples?x=1",
        "/products/apples?page=1&page=1",
        "/products/apples?utm_source=a&utm_source=b",
        "/products%2fapples",
        "/products/%2561pples",
    ] {
        assert_eq!(
            get(&base, "shop.example.test", path).await.status(),
            404,
            "{path}"
        );
    }
    sqlx::query("UPDATE catalog.products SET slug='Café Apples' WHERE id=$1::uuid")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE catalog.products SET slug='orchard-selection' WHERE id=$1::uuid")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    for path in [
        format!("/products/{id}"),
        "/products/apples".into(),
        "/products/cafe-apples".into(),
        "/products/old-apples".into(),
        "/PRODUCTS/APPLES/?utm_source=mail".into(),
    ] {
        let r = get(&base, "shop.example.test", &path).await;
        assert_eq!(r.status(), 301, "{path}");
        assert_eq!(r.headers()["location"], "/products/orchard-selection");
    }
    let current = get(&base, "shop.example.test", "/products/orchard-selection").await;
    assert_eq!(current.status(), 200);
    let snapshot: Value = get(
        gateway.trim_end_matches('/'),
        "shop.example.test",
        "/v1/publication/snapshot?path=%2Fproducts%2Forchard-selection",
    )
    .await
    .json()
    .await
    .unwrap();
    for adapter in ["url", "html", "json_ld", "sitemap", "feed"] {
        assert_eq!(
            snapshot["canonical"][adapter],
            "https://shop.example.test/products/orchard-selection"
        );
    }
    assert_eq!(snapshot["canonical"]["locale"], "en");
    for (path, name) in [
        (format!("/products/{id}"), "legacy-id-301"),
        ("/products/apples".into(), "history-first-301"),
        ("/products/cafe-apples".into(), "history-previous-301"),
        (
            "/PRODUCTS/APPLES/?utm_source=mail".into(),
            "normalized-history-301",
        ),
        (
            "/products/orchard-selection".into(),
            "canonical-product-200",
        ),
        (
            "/products/orchard-selection?sort=price".into(),
            "unsupported-sort-404",
        ),
    ] {
        canonical_evidence(&base, "shop.example.test", &path, name).await;
    }
    if let Ok(output) = std::env::var("PUBLICATION_EVIDENCE_DIR") {
        std::fs::write(
            format!("{output}/canonical-identities.json"),
            serde_json::to_vec_pretty(&snapshot["canonical"]).unwrap(),
        )
        .unwrap();
    }
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("UPDATE catalog.products SET slug='rolled-back' WHERE id=$1::uuid")
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(
        get(&base, "shop.example.test", "/products/rolled-back")
            .await
            .status(),
        404
    );
    let collision=sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) VALUES(gen_random_uuid(),'COLLIDE','apples','Other','Other',1,'USD','kg','00000000-0000-0000-0000-000000000001')").execute(&pool).await.unwrap_err();
    assert_eq!(
        collision.as_database_error().unwrap().code().unwrap(),
        "23505"
    );
    sqlx::query("INSERT INTO platform.publication_routes(path,status,target,reason) VALUES('/products/replace-one',301,'/products/replace-two','Approved'),('/products/replace-two',301,'/products/apples','Approved'),('/products/loop-one',301,'/products/loop-two','Fixture'),('/products/loop-two',301,'/products/loop-one','Fixture')").execute(&pool).await.unwrap();
    let replacement = get(&base, "shop.example.test", "/products/replace-one").await;
    assert_eq!(replacement.status(), 301);
    assert_eq!(
        replacement.headers()["location"],
        "/products/orchard-selection"
    );
    assert_eq!(
        get(&base, "shop.example.test", "/products/loop-one")
            .await
            .status(),
        404
    );
    let override_collision=sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) VALUES(gen_random_uuid(),'REDIRECT-COLLISION','replace-one','Other','Other',1,'USD','kg','00000000-0000-0000-0000-000000000001')").execute(&pool).await.unwrap_err();
    assert_eq!(
        override_collision
            .as_database_error()
            .unwrap()
            .code()
            .unwrap(),
        "23505"
    );
    // Page two has its own canonical. Normalization + ID alias + tracking remains one hop.
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) SELECT gen_random_uuid(),'PAGE-'||n,'page-'||n,'Z fruit '||n,'Fruit',1,'USD','kg','00000000-0000-0000-0000-000000000001' FROM generate_series(1,25) n").execute(&pool).await.unwrap();
    let listing = get(
        &base,
        "shop.example.test",
        "/categories/00000000-0000-0000-0000-000000000001/?page=02&utm_source=test",
    )
    .await;
    assert_eq!(listing.status(), 301);
    assert_eq!(listing.headers()["location"], "/categories/fruit?page=2");
    let listing = get(&base, "shop.example.test", "/categories/fruit?page=2").await;
    assert_eq!(listing.status(), 200);
    assert!(listing
        .text()
        .await
        .unwrap()
        .contains("rel=\"canonical\" href=\"https://shop.example.test/categories/fruit?page=2\""));
    canonical_evidence(
        &base,
        "shop.example.test",
        "/categories/fruit?page=2",
        "canonical-pagination-200",
    )
    .await;
    // A configured second locale does not invent a second translated route.
    sqlx::query("UPDATE cms.discoverability_settings SET default_locale='ar'")
        .execute(&pool)
        .await
        .unwrap();
    let localized = get(&base, "shop.example.test", "/products/orchard-selection")
        .await
        .text()
        .await
        .unwrap();
    assert!(localized.contains("lang=\"ar\""));
    assert!(localized.contains("https://shop.example.test/products/orchard-selection"));
    assert_eq!(
        get(
            &base,
            "shop.example.test",
            "/products/orchard-selection?locale=en"
        )
        .await
        .status(),
        404
    );
    // Distinct published variants are individual resources; inactive parents hide all children.
    let child = Uuid::new_v4();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,parent_id) VALUES($1,'CHILD','small-apples','Small apples','Child',2,'USD','kg','00000000-0000-0000-0000-000000000001',$2::uuid)").bind(child).bind(id).execute(&pool).await.unwrap();
    assert!(get(&base, "shop.example.test", "/products/small-apples")
        .await
        .text()
        .await
        .unwrap()
        .contains("rel=\"canonical\" href=\"https://shop.example.test/products/small-apples\""));
    sqlx::query("UPDATE catalog.products SET active=false WHERE id=$1::uuid")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    for path in [
        "/products/apples",
        "/products/orchard-selection",
        "/products/small-apples",
    ] {
        assert_eq!(get(&base, "shop.example.test", path).await.status(), 404);
    }
    sqlx::query("INSERT INTO platform.publication_routes(path,status,reason) VALUES('/products/orchard-selection',410,'Approved retirement')").execute(&pool).await.unwrap();
    assert_eq!(
        get(&base, "shop.example.test", "/products/orchard-selection")
            .await
            .status(),
        410
    );
    // Physical deletion keeps reservations, without fabricating a 410 decision.
    sqlx::query("DELETE FROM catalog.products WHERE id=$1")
        .bind(child)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        get(&base, "shop.example.test", "/products/small-apples")
            .await
            .status(),
        404
    );
    task.abort();
}

#[sqlx::test(migrations = "../../migrations")]
async fn generated_slugs_unicode_collisions_and_deleted_categories(pool: PgPool) {
    let service = domain_catalog::Service { pool: pool.clone() };
    let create = |name: &str, slug: &str| {
        serde_json::from_value::<domain_catalog::CategoryInput>(
            json!({"name":name,"slug":slug,"parent_id":null}),
        )
        .unwrap()
    };
    let a = service
        .save_category(None, create("Café Fruit", ""))
        .await
        .unwrap();
    assert_eq!(a.slug, "cafe-fruit");
    let b = service
        .save_category(None, create("Cafe\u{301} Fruit", ""))
        .await
        .unwrap();
    assert_eq!(b.slug, format!("cafe-fruit-{}", b.id.simple()));
    let arabic = service
        .save_category(None, create("تفاح أحمر", ""))
        .await
        .unwrap();
    assert_eq!(arabic.slug, "tfah-ahmr");
    let reserved = service
        .save_category(None, create("New", "new"))
        .await
        .unwrap();
    assert_eq!(reserved.slug, "category-new");
    let unsupported = service
        .save_category(None, create("苹果", ""))
        .await
        .unwrap();
    assert_eq!(
        unsupported.slug,
        format!("category-{}", unsupported.id.simple())
    );
    let (left, right) = tokio::join!(
        service.save_category(None, create("Concurrent", "")),
        service.save_category(None, create("Concurrent", ""))
    );
    assert_ne!(left.unwrap().slug, right.unwrap().slug);
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("UPDATE catalog.categories SET slug='renamed-fruit' WHERE id=$1")
        .bind(a.id)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let route = api_gateway::public_commerce::canonical::resolve(
        &mut pool.acquire().await.unwrap(),
        "/categories/cafe-fruit",
    )
    .await
    .unwrap();
    assert_eq!(route.status, 301);
    assert_eq!(route.path.as_deref(), Some("/categories/renamed-fruit"));
    service.delete_category(a.id).await.unwrap();
    for key in [
        "cafe-fruit".to_owned(),
        "renamed-fruit".to_owned(),
        a.id.to_string(),
    ] {
        assert_eq!(
            api_gateway::public_commerce::canonical::resolve(
                &mut pool.acquire().await.unwrap(),
                &format!("/categories/{key}")
            )
            .await
            .unwrap()
            .status,
            404
        );
    }
    assert!(service
        .save_category(None, create("Other", "cafe-fruit"))
        .await
        .is_err());
}

#[sqlx::test(migrations = "../../migrations")]
async fn migration_backfills_legacy_rows_and_rejects_ambiguous_ownership(pool: PgPool) {
    const REVERT_FIXTURE: &str = "DROP FUNCTION platform.reserve_public_slug() CASCADE; DROP FUNCTION platform.public_slug(text); DROP TABLE platform.publication_aliases;";
    // Recreate the pre-Stage-04 boundary inside a rolled-back, isolated transaction.
    let mut tx = pool.begin().await.unwrap();
    sqlx::raw_sql(REVERT_FIXTURE)
        .execute(&mut *tx)
        .await
        .unwrap();
    let category = Uuid::new_v4();
    let product = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO catalog.categories(id,name,slug) VALUES($1,'Legacy fruit','Legacy--Fruit')",
    )
    .bind(category)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) VALUES($1,'LEGACY','legacy-apples','Legacy apples','Legacy',1,'USD','kg',$2)").bind(product).bind(category).execute(&mut *tx).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../migrations/20260921110000_publication_slug_history.sql"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    for (path, expected) in [
        (
            format!("/categories/{category}"),
            "/categories/legacy-fruit",
        ),
        (
            "/categories/legacy--fruit".into(),
            "/categories/legacy-fruit",
        ),
        (format!("/products/{product}"), "/products/legacy-apples"),
    ] {
        let route = api_gateway::public_commerce::canonical::resolve(&mut tx, &path)
            .await
            .unwrap();
        assert_eq!(route.status, 301);
        assert_eq!(route.path.as_deref(), Some(expected));
    }
    tx.rollback().await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::raw_sql(REVERT_FIXTURE)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO catalog.categories(id,name,slug) VALUES(gen_random_uuid(),'First','FRUIT'),(gen_random_uuid(),'Second','fruit')").execute(&mut *tx).await.unwrap();
    let conflict = sqlx::raw_sql(include_str!(
        "../../../migrations/20260921110000_publication_slug_history.sql"
    ))
    .execute(&mut *tx)
    .await
    .unwrap_err();
    assert_eq!(
        conflict.as_database_error().unwrap().code().unwrap(),
        "23505"
    );
    tx.rollback().await.unwrap();
    let present: bool =
        sqlx::query_scalar("SELECT to_regclass('platform.publication_aliases') IS NOT NULL")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(present);
}

async fn canonical_evidence(base: &str, host: &str, path: &str, name: &str) {
    if let Ok(output) = std::env::var("PUBLICATION_EVIDENCE_DIR") {
        std::fs::create_dir_all(&output).unwrap();
        let result = tokio::process::Command::new("curl")
            .args([
                "--silent",
                "--show-error",
                "--include",
                "--noproxy",
                "*",
                "-H",
                &format!("Host: {host}"),
                &format!("{base}{path}"),
            ])
            .output()
            .await
            .unwrap();
        assert!(result.status.success());
        std::fs::write(format!("{output}/{name}.http"), result.stdout).unwrap();
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn metadata_raw_html_semantics_and_revisioned_admin_preview(pool: PgPool) {
    seed(&pool, "تفاح & <Orchard>").await;
    let (base, gateway, _renderer, task) = fixture(&pool, "shop.example.test").await;
    let image = Uuid::new_v4();
    sqlx::query("INSERT INTO catalog.media(id,content_type,alt,object_key,size_bytes) VALUES($1,'image/webp','Orchard apples','PRIVATE_KEY',12)").bind(image).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.publication_images(media_id,width,height,variants) VALUES($1,1200,800,'[{\"width\":480,\"height\":320},{\"width\":960,\"height\":640}]')").bind(image).execute(&pool).await.unwrap();
    sqlx::query("UPDATE catalog.products SET media_ids=ARRAY[$1] WHERE sku='APPLE'")
        .bind(image)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO catalog.categories(id,slug,name,parent_id) VALUES(gen_random_uuid(),'citrus','Citrus','00000000-0000-0000-0000-000000000001')").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) VALUES(gen_random_uuid(),'PEAR','pears','Pears','Orchard pears',2,'USD','kg','00000000-0000-0000-0000-000000000001')").execute(&pool).await.unwrap();
    sqlx::query("UPDATE cms.revisions SET blocks=jsonb_set(blocks,'{0,image_id}',to_jsonb($1::text)) WHERE document_id='00000000-0000-0000-0000-000000000003'").bind(image.to_string()).execute(&pool).await.unwrap();
    let mut titles = std::collections::BTreeSet::new();
    for path in ["/", "/products/apples", "/categories/fruit", "/pages/about"] {
        let response = get(&base, "shop.example.test", path).await;
        assert_eq!(response.status(), 200);
        let html = response.text().await.unwrap();
        let head = html.split("</head>").next().unwrap();
        let body = html
            .split("<script id=\"publication-state\"")
            .next()
            .unwrap();
        for marker in [
            "<title>",
            "name=\"description\"",
            "name=\"robots\"",
            "rel=\"canonical\"",
            "property=\"og:title\"",
            "property=\"og:description\"",
            "property=\"og:url\"",
            "property=\"og:type\"",
            "name=\"twitter:card\"",
        ] {
            assert_eq!(head.matches(marker).count(), 1, "{path}: {marker}");
        }
        assert_eq!(body.matches("<h1").count(), 1, "{path}");
        for tag in body
            .split("<img ")
            .skip(1)
            .map(|tail| tail.split('>').next().unwrap())
        {
            for attribute in ["width=", "height=", "alt=", "srcSet=", "sizes="] {
                assert!(tag.contains(attribute), "{path}: {tag}");
            }
        }

        assert!(head.contains("content=\"index, follow\""));
        assert!(head.contains(&format!("href=\"https://shop.example.test{path}\"")));
        let graph = jsonld(&html);
        let nodes = graph["@graph"].as_array().unwrap();
        let page = nodes.iter().find(|v| v["@type"] == "WebPage").unwrap();
        assert_eq!(page["url"], format!("https://shop.example.test{path}"));
        if path == "/products/apples" {
            let product = nodes.iter().find(|v| v["@type"] == "Product").unwrap();
            assert_eq!(product["image"]["@type"], "ImageObject");
            assert_eq!(product["image"]["width"], 1200);
            assert_eq!(product["image"]["height"], 800);
        }
        titles.insert(
            head.split("<title>")
                .nth(1)
                .unwrap()
                .split("</title>")
                .next()
                .unwrap()
                .to_owned(),
        );
        assert!(!head.contains("PRIVATE_KEY"));
        assert!(!head.contains("<Orchard>"));
        if path == "/products/apples" {
            assert!(body.contains("width=\"1200\" height=\"800\""));
            assert!(body.contains("?width=480 480w"));
            assert!(body.contains("loading=\"eager\""));
            assert!(body.contains("alt=\"Orchard apples\""));
            assert!(body.contains("href=\"/categories/fruit\""));
            assert!(head.contains("property=\"og:image\""));
            assert!(body.contains("href=\"/products/pears\""));
        }
        if path == "/categories/fruit" {
            assert!(body.contains("href=\"/categories/citrus\""));
            assert!(body.contains("href=\"/pages/about\""));
        }
        if path == "/pages/about" {
            assert!(body.contains("href=\"/categories/fruit\""));
        }
        if let Ok(dir) = std::env::var("PUBLICATION_EVIDENCE_DIR") {
            std::fs::write(
                format!(
                    "{dir}/metadata-{}.html",
                    path.replace('/', "_").trim_matches('_')
                ),
                html,
            )
            .unwrap();
        }
    }
    assert_eq!(titles.len(), 4);
    let user = Uuid::new_v4();
    let role = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'Metadata publisher',ARRAY['discovery.read','discovery.write'])").bind(role).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'metadata@example.test','Publisher','!',$2)").bind(user).bind(role).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest(&user.to_string())).bind(user).execute(&pool).await.unwrap();
    let endpoint = format!("{gateway}v1/admin/discovery/metadata");
    assert_eq!(client().get(&endpoint).send().await.unwrap().status(), 401);
    let config = json!({"templates":{"product":{"title":"{product_name} — {merchant_name}","description":"{description}"}},"overrides":{"product:00000000-0000-0000-0000-000000000002":{"title":"تفاح \"خاص\" <script> & café","description":"Unicode محفوظ — fresh orchard apples."}},"social_image":image});
    let send = |method: reqwest::Method, url: String, data: Value| {
        client()
            .request(method, url)
            .header("cookie", format!("admin_session={user}"))
            .header("x-commerce-request", "1")
            .header("origin", "https://shop.example.test")
            .json(&data)
            .send()
    };
    let response = send(
        reqwest::Method::POST,
        format!("{endpoint}/preview"),
        json!({"path":"/products/apples","configuration":config}),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    let preview: Value = response.json().await.unwrap();
    let data = json!({"expected_revision":1,"configuration":config});
    assert_eq!(
        send(reqwest::Method::PUT, endpoint.clone(), data.clone())
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        send(reqwest::Method::PUT, endpoint.clone(), data)
            .await
            .unwrap()
            .status(),
        409
    );
    let live: Value = get(
        gateway.trim_end_matches('/'),
        "shop.example.test",
        "/v1/publication/snapshot?path=/products/apples",
    )
    .await
    .json()
    .await
    .unwrap();
    assert_eq!(preview["metadata"], live["metadata"]);
    let html = get(&base, "shop.example.test", "/products/apples")
        .await
        .text()
        .await
        .unwrap();
    assert!(html.contains("تفاح &quot;خاص&quot; &lt;script&gt; &amp; café"));
    sqlx::query("UPDATE catalog.products SET slug='fresh-apples' WHERE sku='APPLE'")
        .execute(&pool)
        .await
        .unwrap();
    let renamed: Value = get(
        gateway.trim_end_matches('/'),
        "shop.example.test",
        "/v1/publication/snapshot?path=/products/fresh-apples",
    )
    .await
    .json()
    .await
    .unwrap();
    assert_eq!(renamed["metadata"]["title"], preview["metadata"]["title"]);
    let audit:i64=sqlx::query_scalar("SELECT count(*) FROM admin_iam.audit_log WHERE actor_id=$1 AND action='discovery.metadata.updated'").bind(user).fetch_one(&pool).await.unwrap();
    assert_eq!(audit, 1);
    for (path, key, title) in [
        (
            "/categories/fruit",
            "category:00000000-0000-0000-0000-000000000001",
            "Fruit selection",
        ),
        (
            "/pages/about",
            "content:00000000-0000-0000-0000-000000000003",
            "Our produce guide",
        ),
    ] {
        let mut proposed = config.clone();
        proposed["overrides"][key] = json!({"title":title,"description":""});
        let response = send(
            reqwest::Method::POST,
            format!("{endpoint}/preview"),
            json!({"path":path,"configuration":proposed}),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), 200);
        let preview: Value = response.json().await.unwrap();
        assert_eq!(preview["metadata"]["title"], title);
        assert!(!preview["metadata"]["description"]
            .as_str()
            .unwrap()
            .is_empty());
    }
    let response=send(reqwest::Method::POST,format!("{endpoint}/preview"),json!({"path":"/products/fresh-apples","configuration":{"templates":{},"overrides":{},"social_image":null}})).await.unwrap();
    let fallback: Value = response.json().await.unwrap();
    assert!(fallback["metadata"]["title"]
        .as_str()
        .unwrap()
        .contains("تفاح"));
    assert_eq!(
        fallback["metadata"]["description"],
        "Crisp orchard apples, sold by the kilogram."
    );
    let mut invalid = config.clone();
    invalid["templates"]["home"] = json!({"title":"{unknown}","description":""});
    assert_eq!(
        send(
            reqwest::Method::PUT,
            endpoint.clone(),
            json!({"expected_revision":2,"configuration":invalid})
        )
        .await
        .unwrap()
        .status(),
        400
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['discovery.read'] WHERE id=$1")
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        send(
            reqwest::Method::PUT,
            endpoint.clone(),
            json!({"expected_revision":2,"configuration":config})
        )
        .await
        .unwrap()
        .status(),
        403
    );
    task.abort();
}

fn jsonld(html: &str) -> Value {
    let raw = html
        .split("<script id=\"publication-jsonld\" type=\"application/ld+json\">")
        .nth(1)
        .expect("initial HTML JSON-LD")
        .split("</script>")
        .next()
        .unwrap();
    serde_json::from_str(raw).unwrap()
}
#[sqlx::test(migrations = "../../migrations")]
async fn structured_data_matches_public_facts_across_industries_and_pricing(pool: PgPool) {
    seed(&pool, "Orchard apples").await;
    let (base, gateway, _renderer, task) = fixture(&pool, "shop.example.test").await;
    for (industry, field, value) in [
        ("grocery", "Ingredients", "Apples"),
        ("jewelry", "Purity", "18 karat"),
        ("fashion", "Material", "Cotton"),
        ("skincare", "Usage", "Follow merchant label"),
        ("electronics", "Compatibility", "USB-C"),
        ("retail", "Capacity", "2 litres"),
    ] {
        sqlx::query("INSERT INTO attributes.definitions(id,entity_type,attribute_code,label,input_type,is_visible_on_front) VALUES(gen_random_uuid(),'product',$1,$2,'text',true)").bind(industry).bind(field).execute(&pool).await.unwrap();
        sqlx::query("UPDATE catalog.products SET attributes=attributes||jsonb_build_object($1::text,$2::text) WHERE sku='APPLE'").bind(industry).bind(value).execute(&pool).await.unwrap();
        let html = get(&base, "shop.example.test", "/products/apples")
            .await
            .text()
            .await
            .unwrap();
        let data = jsonld(&html);
        let graph = data["@graph"].as_array().unwrap();
        let product = graph.iter().find(|v| v["@type"] == "Product").unwrap();
        assert!(html.contains("<h1>Orchard apples</h1>"));
        assert_eq!(product["name"], "Orchard apples");
        assert_eq!(product["offers"]["price"], "3.25");
        assert_eq!(product["offers"]["priceCurrency"], "USD");
        assert!(html.contains("$3.25"));
        assert_eq!(product["url"], "https://shop.example.test/products/apples");
        // Translation interpolation may render one text node instead of React's
        // adjacent-node separator; the visible seller fact must stay identical.
        assert!(html
            .replace("<!-- -->", "")
            .contains("Sold by Merchant shop.example.test"));
        assert!(html.contains(field) && html.contains(value));
        assert!(product["additionalProperty"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["name"] == field && p["value"] == value));
        for missing in ["brand", "gtin", "mpn", "image", "aggregateRating", "review"] {
            assert!(product.get(missing).is_none());
        }
        assert!(product["offers"].get("availability").is_none());
        assert!(!data.to_string().contains("DO-NOT-PUBLISH"));
        if let Ok(dir) = std::env::var("PUBLICATION_EVIDENCE_DIR") {
            std::fs::write(format!("{dir}/structured-{industry}.html"), html).unwrap();
        }
    }
    sqlx::query("INSERT INTO pricing_promotions.rules(id,name,scope,kind,value,min_subtotal,skus,category_ids,customer_group,priority,active) VALUES(gen_random_uuid(),'Public catalog discount','catalog','percentage',10,0,'{}','{}','all',10,true)").execute(&pool).await.unwrap();
    let html = get(&base, "shop.example.test", "/products/apples")
        .await
        .text()
        .await
        .unwrap();
    let data = jsonld(&html);
    let product = &data["@graph"][2];
    assert_eq!(product["offers"]["price"], "2.92");
    assert!(html.contains("$2.92"));
    assert!(html.contains("<del>$3.25</del>"));
    // React may separate the translated label and whitespace with hydration markers.
    assert!(html.replace("<!-- -->", "").contains("You save "));
    if let Ok(dir) = std::env::var("PUBLICATION_EVIDENCE_DIR") {
        std::fs::write(format!("{dir}/structured-discounted.html"), &html).unwrap();
    }
    sqlx::query("UPDATE pricing_promotions.rules SET min_subtotal=100")
        .execute(&pool)
        .await
        .unwrap();
    let html = get(&base, "shop.example.test", "/products/apples")
        .await
        .text()
        .await
        .unwrap();
    assert!(jsonld(&html)["@graph"][2].get("offers").is_none());
    assert!(html.contains("$3.25"));
    sqlx::query("UPDATE pricing_promotions.rules SET active=false")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE catalog.products SET in_stock=false,name='تفاح </script><script>alert(1)</script>' WHERE sku='APPLE'").execute(&pool).await.unwrap();
    let html = get(&base, "shop.example.test", "/products/apples")
        .await
        .text()
        .await
        .unwrap();
    let data = jsonld(&html);
    assert_eq!(
        data["@graph"][2]["name"],
        "تفاح </script><script>alert(1)</script>"
    );
    assert!(!html.contains("</script><script>alert(1)</script>"));
    assert!(data["@graph"][2]["offers"].get("availability").is_none());
    let invalid_currency =
        sqlx::query("UPDATE catalog.products SET currency='EUR' WHERE sku='APPLE'")
            .execute(&pool)
            .await
            .unwrap_err();
    assert_eq!(
        invalid_currency
            .as_database_error()
            .unwrap()
            .code()
            .as_deref(),
        Some("23514")
    );
    // Free-text published policies do not constitute validated shipping/return facts.
    sqlx::query("UPDATE cms.documents SET key='returns' WHERE key='about'")
        .execute(&pool)
        .await
        .unwrap();
    let data: Value = get(
        gateway.trim_end_matches('/'),
        "shop.example.test",
        "/v1/publication/snapshot?path=/products/apples",
    )
    .await
    .json()
    .await
    .unwrap();
    assert!(!data["structured_data"]
        .to_string()
        .contains("MerchantReturnPolicy"));
    assert!(!data["structured_data"]
        .to_string()
        .contains("OfferShippingDetails"));
    assert!(!get(&base, "shop.example.test", "/unknown")
        .await
        .text()
        .await
        .unwrap()
        .contains("application/ld+json"));
    task.abort();
}

#[sqlx::test(migrations = "../../migrations")]
async fn structured_variants_are_visible_independently_canonical_and_parent_scoped(pool: PgPool) {
    seed(&pool, "Cotton shirt").await;
    let (base, _gateway, _renderer, task) = fixture(&pool, "shop.example.test").await;
    sqlx::query("UPDATE catalog.products SET product_type='configurable' WHERE sku='APPLE'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE attributes.definitions SET used_for_configurations=true,is_visible_on_front=false,input_type='select',options='[{\"value\":\"blue\",\"label\":\"Blue\"}]' WHERE attribute_code='color'").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.product_configurations(id,parent_product_id,configurable_attributes) VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000002',ARRAY['color'])").execute(&pool).await.unwrap();
    let child = Uuid::new_v4();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,parent_id) VALUES($1,'BLUE','blue-shirt','Blue shirt','Blue cotton shirt',12,'USD','each','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002')").bind(child).execute(&pool).await.unwrap();
    sqlx::query("UPDATE catalog.products SET attributes='{\"color\":\"blue\"}',variant_attributes='{\"color\":\"blue\"}' WHERE id=$1").bind(child).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.product_links(parent_id,child_id,position) VALUES('00000000-0000-0000-0000-000000000002',$1,0)").bind(child).execute(&pool).await.unwrap();
    let html = get(&base, "shop.example.test", "/products/apples")
        .await
        .text()
        .await
        .unwrap();
    let data = jsonld(&html);
    let group = &data["@graph"][2];
    assert_eq!(group["variesBy"][0], "Color");
    assert!(html.contains("Variants vary by:"));
    assert_eq!(group["@type"], "ProductGroup");
    if let Ok(dir) = std::env::var("PUBLICATION_EVIDENCE_DIR") {
        std::fs::write(format!("{dir}/structured-variants.html"), &html).unwrap();
    }
    assert!(group.get("offers").is_none());
    assert_eq!(group["hasVariant"][0]["offers"]["price"], "12.00");
    assert_eq!(
        group["hasVariant"][0]["additionalProperty"][0]["value"],
        "blue"
    );
    assert!(html.contains("href=\"/products/blue-shirt\""));
    assert!(html.contains("$12.00"));
    assert!(html.contains("Blue cotton shirt"));
    let html = get(&base, "shop.example.test", "/products/blue-shirt")
        .await
        .text()
        .await
        .unwrap();
    let data = jsonld(&html);
    assert_eq!(
        data["@graph"][2]["url"],
        "https://shop.example.test/products/blue-shirt"
    );
    assert_eq!(
        data["@graph"][2]["isVariantOf"]["url"],
        "https://shop.example.test/products/apples"
    );
    assert!(
        html.contains("rel=\"canonical\" href=\"https://shop.example.test/products/blue-shirt\"")
    );
    sqlx::query("UPDATE catalog.products SET active=false WHERE sku='BLUE'")
        .execute(&pool)
        .await
        .unwrap();
    let html = get(&base, "shop.example.test", "/products/apples")
        .await
        .text()
        .await
        .unwrap();
    assert!(jsonld(&html)["@graph"][2].get("hasVariant").is_none());
    assert_eq!(
        get(&base, "shop.example.test", "/products/blue-shirt")
            .await
            .status(),
        404
    );
    sqlx::query("UPDATE catalog.products SET active=(sku='BLUE')")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        get(&base, "shop.example.test", "/products/blue-shirt")
            .await
            .status(),
        404
    );
    task.abort();
}

#[sqlx::test(migrations = "../../migrations")]
async fn merchant_entity_policies_guides_comparisons_and_revocation(pool: PgPool) {
    seed(&pool, "Apples").await;
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,attributes) VALUES('00000000-0000-0000-0000-000000000010','SILVER','silver-ring','Silver ring','Merchant supplied silver ring',125,'USD','each','00000000-0000-0000-0000-000000000001','{\"material\":\"Silver\",\"health-claim\":\"Cures illness\"}')").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO attributes.definitions(id,entity_type,attribute_code,label,input_type,is_visible_on_front) VALUES('00000000-0000-0000-0000-000000000011','product','material','Material','text',true),('00000000-0000-0000-0000-000000000012','product','health-claim','Health claim','text',true)").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO attributes.value_provenance(product_id,definition_id,source) VALUES('00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000012','AI_INFERRED')").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.categories(id,name,slug) VALUES('00000000-0000-0000-0000-000000000019','Jewelry','jewelry')").execute(&pool).await.unwrap();
    sqlx::query("UPDATE catalog.products SET category_id='00000000-0000-0000-0000-000000000019' WHERE sku='SILVER'").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,attributes) VALUES('00000000-0000-0000-0000-000000000011','GOLD','gold-ring','Gold ring','Merchant supplied gold ring',200,'USD','each','00000000-0000-0000-0000-000000000019','{\"material\":\"Gold\",\"purity\":\"18 karat\"}')").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO attributes.definitions(id,entity_type,attribute_code,label,input_type,is_visible_on_front) VALUES(gen_random_uuid(),'product','purity','Purity','text',true)").execute(&pool).await.unwrap();
    let mut pages = vec![];
    for (n, purpose) in [
        "shipping",
        "returns",
        "warranty",
        "payment",
        "buying-guide",
        "comparison",
    ]
    .iter()
    .enumerate()
    {
        let document = Uuid::from_u128(100 + n as u128);
        let revision = Uuid::from_u128(200 + n as u128);
        sqlx::query("INSERT INTO cms.documents(id,key,kind) VALUES($1,$2,'page')")
            .bind(document)
            .bind(purpose)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO cms.revisions(id,document_id,version,title,blocks,created_by) VALUES($1,$2,1,$3,$4,gen_random_uuid())").bind(revision).bind(document).bind(format!("Merchant {purpose}")).bind(json!([
            {"kind":"text","heading":"Merchant approved explanation","text":format!("{} <script>do-not-execute</script>",match *purpose {
                "shipping" => "Synthetic merchant policy: Cairo delivery is offered at checkout. The confirmed address, delivery charge and available slot are shown before payment.",
                "returns" => "Synthetic merchant policy: request a return through public customer service within seven days of receipt. Keep the receipt and original packaging; perishable items require review.",
                "warranty" => "Synthetic merchant policy: jewelry workmanship issues are reviewed by customer service with proof of purchase. Normal wear and accidental damage are excluded.",
                "payment" => "Synthetic merchant policy: use the payment methods offered at checkout. Never send payment-card details to customer service.",
                "buying-guide" => "For ring selection, compare the merchant-listed material and purity, check the size before ordering, and read the warranty. A missing specification is not evidence of equivalence.",
                _ => "Compare these two rings using their current public catalog facts. Material and purity describe different properties; missing values are not inferred."
            }),"image_id":null,"link_label":if n>=4{"See silver ring"}else{"See apples"},"link_url":if n>=4{"/products/silver-ring"}else{"/products/old-apples"}},
            {"kind":"link","heading":"","text":"","image_id":null,"link_label":"Private route must not be linked","link_url":"/account"}
        ])).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO cms.releases(id,document_id,revision_id,starts_at) VALUES(gen_random_uuid(),$1,$2,'2026-01-01T00:00:00Z')").bind(document).bind(revision).execute(&pool).await.unwrap();
        pages.push(json!({"document_id":document,"revision_id":revision,"purpose":purpose,"locale":"en","effective_date":if n<4{Some("2026-01-01")}else{None},"comparison_products":if *purpose=="comparison"{vec![Uuid::from_u128(16),Uuid::from_u128(17)]}else{vec![]}}));
    }
    let logo = Uuid::from_u128(900);
    sqlx::query("INSERT INTO catalog.media(id,content_type,alt,object_key,size_bytes) VALUES($1,'image/png','Approved merchant logo','private-admin-object-key',100)").bind(logo).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.publication_images(media_id,width,height) VALUES($1,32,32)")
        .bind(logo)
        .execute(&pool)
        .await
        .unwrap();
    assert!(!api_gateway::public_commerce::images::is_public(
        &mut pool.acquire().await.unwrap(),
        logo
    )
    .await
    .unwrap());
    let profile = json!({"published":true,"logo_id":logo,"legal_name":"Approved Merchant Ltd","description":"Merchant-approved public description","contact_published":false,"email":"PRIVATE-CONTACT@example.test","telephone":"PRIVATE-PHONE","locations_published":false,"locations":["PRIVATE-LOCATION"],"country":"Egypt","region":"Cairo","delivery_areas":["Merchant-approved Cairo service area"],"social_profiles":["https://social.example.test/merchant"],"pages":pages});
    sqlx::query("UPDATE cms.publication_entity SET configuration=$1")
        .bind(&profile)
        .execute(&pool)
        .await
        .unwrap();
    let (base, _, _renderer, task) = fixture(&pool, "entity.example.test").await;
    for path in [
        "/",
        "/products/apples",
        "/products/silver-ring",
        "/pages/shipping",
        "/pages/buying-guide",
        "/pages/comparison",
    ] {
        let r = get(&base, "entity.example.test", path).await;
        assert_eq!(r.status(), 200);
        let html = r.text().await.unwrap();
        assert!(html.contains("Approved Merchant Ltd"));
        assert!(html.contains("Approved merchant logo") || html.contains(" logo"));
        assert!(!html.contains("private-admin-object-key"));
        assert!(html.contains("Merchant-approved Cairo service area"));
        assert!(!html.contains("PRIVATE-CONTACT"));
        assert!(!html.contains("PRIVATE-LOCATION"));
        assert!(!html.contains("PRIVATE-PHONE"));
        assert!(!html.contains("Cures illness"));
        assert!(html.contains("https://entity.example.test/pages/shipping"));
        assert!(html.contains("https://entity.example.test/pages/returns"));
        if path.starts_with("/pages/") {
            assert!(html.contains("2026-01-01"));
            assert!(!html.contains("<script>do-not-execute</script>"));
            assert!(html.contains("&lt;script&gt;do-not-execute&lt;/script&gt;"));
            assert!(html.contains(
                if path == "/pages/buying-guide" || path == "/pages/comparison" {
                    "href=\"/products/silver-ring\""
                } else {
                    "href=\"/products/apples\""
                }
            ));
        }
        if path == "/pages/comparison" {
            assert!(html.contains("Catalog comparison"));
            assert!(html.contains("Silver ring"));
            assert!(html.contains("$125.00"));
            assert!(html.contains("Material"));
            assert!(html.contains("Not provided"));
        }
        if let Ok(dir) = std::env::var("PUBLICATION_EVIDENCE_DIR") {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                format!(
                    "{dir}/entity-{}.html",
                    path.trim_matches('/').replace('/', "_")
                ),
                html,
            )
            .unwrap();
        }
    }
    let snapshot = get(&base, "entity.example.test", "/pages/shipping")
        .await
        .text()
        .await
        .unwrap();
    assert!(snapshot.contains("\"legalName\":\"Approved Merchant Ltd\""));
    assert!(!snapshot.contains("contactPoint"));
    sqlx::query("UPDATE cms.publication_entity SET configuration=jsonb_set(jsonb_set(configuration,'{contact_published}','true'),'{email}','\"public-support@example.test\"')").execute(&pool).await.unwrap();
    let html = get(&base, "entity.example.test", "/")
        .await
        .text()
        .await
        .unwrap();
    assert!(html.contains("public-support@example.test"));
    assert!(html.contains("contactPoint"));
    assert!(api_gateway::public_commerce::images::is_public(
        &mut pool.acquire().await.unwrap(),
        logo
    )
    .await
    .unwrap());
    let changed_revision = Uuid::from_u128(999);
    sqlx::query("INSERT INTO cms.revisions(id,document_id,version,title,blocks,created_by) VALUES($1,$2,2,'Updated warranty','[]',gen_random_uuid())").bind(changed_revision).bind(Uuid::from_u128(102)).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO cms.releases(id,document_id,revision_id,starts_at) VALUES(gen_random_uuid(),$1,$2,now())").bind(Uuid::from_u128(102)).bind(changed_revision).execute(&pool).await.unwrap();
    let html = get(&base, "entity.example.test", "/")
        .await
        .text()
        .await
        .unwrap();
    assert!(!html.contains("https://entity.example.test/pages/warranty"));
    // Published text remains owned by CMS, but incomplete/revised/wrong-locale policy approvals cannot advertise dates/links.
    sqlx::query("UPDATE cms.publication_entity SET configuration=jsonb_set(configuration,'{pages,0,effective_date}','null')").execute(&pool).await.unwrap();
    let html = get(&base, "entity.example.test", "/")
        .await
        .text()
        .await
        .unwrap();
    assert!(!html.contains("https://entity.example.test/pages/shipping"));
    sqlx::query("INSERT INTO cms.releases(id,document_id,revision_id,starts_at) VALUES(gen_random_uuid(),$1,NULL,now())").bind(Uuid::from_u128(101)).execute(&pool).await.unwrap();
    assert_eq!(
        get(&base, "entity.example.test", "/pages/returns")
            .await
            .status(),
        404
    );
    let index = get(&base, "entity.example.test", "/sitemap.xml")
        .await
        .text()
        .await
        .unwrap();
    let content = index
        .split("<loc>")
        .skip(1)
        .map(|v| v.split("</loc>").next().unwrap())
        .find(|v| v.contains("content-"))
        .unwrap();
    let sitemap = get(
        &base,
        "entity.example.test",
        content.strip_prefix("https://entity.example.test").unwrap(),
    )
    .await
    .text()
    .await
    .unwrap();
    assert!(sitemap.contains("/pages/buying-guide"));
    assert!(!sitemap.contains("/pages/returns"));
    sqlx::query("UPDATE cms.discoverability_settings SET default_locale='ar-EG'")
        .execute(&pool)
        .await
        .unwrap();
    let html = get(&base, "entity.example.test", "/")
        .await
        .text()
        .await
        .unwrap();
    assert!(html.contains("lang=\"ar-EG\""));
    assert!(!html.contains("https://entity.example.test/pages/warranty"));
    sqlx::query("UPDATE cms.publication_entity SET configuration=jsonb_set(configuration,'{published}','false')").execute(&pool).await.unwrap();
    let html = get(&base, "entity.example.test", "/")
        .await
        .text()
        .await
        .unwrap();
    assert!(!html.contains("Approved Merchant Ltd"));
    assert!(!html.contains("public-support@example.test"));
    assert!(!api_gateway::public_commerce::images::is_public(
        &mut pool.acquire().await.unwrap(),
        logo
    )
    .await
    .unwrap());
    task.abort();
}

#[sqlx::test(migrations = "../../migrations")]
async fn feed_freshness_real_html_jsonld_sitemap_pipeline(pool: PgPool) {
    use api_gateway::public_commerce::feeds;
    seed(&pool, "Stage nine apples").await;
    let (base, _, _renderer, task) = fixture(&pool, "shop.example.test").await;
    let id = sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
        .fetch_one(&pool)
        .await
        .unwrap();
    let a = discoverability::App {
        identity: identity::App::new(
            pool.clone(),
            Security::new(
                "feed-fixture-secret".repeat(4),
                "https://shop.example.test".into(),
                false,
            )
            .await
            .unwrap(),
            vec![],
        ),
        deployment: Deployment {
            installation_id: Some(id),
            environment: "production".into(),
            approved_origin: Some("https://shop.example.test/".into()),
            header_override: false,
            html: Some("built".into()),
        },
    };
    for (label,statement) in [
        ("create","SELECT 1"),
        ("price","UPDATE catalog.products SET price=6.75"),
        ("availability","DELETE FROM inventory.delivery_areas"),
        ("image","INSERT INTO catalog.media(id,content_type,alt,object_key,size_bytes) VALUES('00000000-0000-0000-0000-000000000999','image/png','Fresh apple','private-object-key',64); INSERT INTO catalog.publication_images(media_id,width,height) VALUES('00000000-0000-0000-0000-000000000999',32,32); UPDATE catalog.products SET media_ids=ARRAY['00000000-0000-0000-0000-000000000999'::uuid]"),
        ("delete","UPDATE catalog.products SET active=false")
    ] {
        sqlx::raw_sql(statement).execute(&pool).await.unwrap();
        sqlx::query("UPDATE platform.publication_freshness SET next_batch_at=now(),next_delivery_at=now()").execute(&pool).await.unwrap();
        feeds::reconcile_batch(&a).await.unwrap();feeds::deliver_batch(&a,&feeds::ReferenceAdapter).await.unwrap();
        let response=get(&base,"shop.example.test","/products/apples").await;
        assert_eq!(response.status(),if label=="delete"{404}else{200});
        assert_eq!(response.headers()["cache-control"],"no-store");
        let html=response.text().await.unwrap();
        let feed:Value=sqlx::query_scalar("SELECT jsonb_build_object('operation',operation,'payload',payload,'version',version) FROM platform.publication_reference_feed").fetch_one(&pool).await.unwrap();
        let index=get(&base,"shop.example.test","/sitemap.xml").await.text().await.unwrap();
        let xml=if label=="delete"{assert!(!index.contains("/sitemaps/products-"));index.clone()}else{
            let marker="https://shop.example.test/sitemaps/products-";let at=index.find(marker).unwrap();let tail=&index[at..];let end=tail.find("</loc>").unwrap();let path=tail[..end].strip_prefix("https://shop.example.test").unwrap();
            let xml=get(&base,"shop.example.test",path).await.text().await.unwrap();assert!(xml.contains("<lastmod>"));assert!(xml.contains(feed["payload"]["url"].as_str().unwrap()));xml
        };
        if label=="delete"{assert_eq!(feed["operation"],"delete");assert!(!html.contains("application/ld+json"));}else{
            let state_start=html.find("<script id=\"publication-state\" type=\"application/json\">").unwrap()+"<script id=\"publication-state\" type=\"application/json\">".len();let state_end=html[state_start..].find("</script>").unwrap()+state_start;let state:Value=serde_json::from_str(&html[state_start..state_end]).unwrap();
            assert_eq!(state["representation_version"],feed["payload"]["representation_version"]);
            assert_eq!(state["product"]["price"],feed["payload"]["price"]);
            assert!(html.contains("Stage nine apples"));assert!(html.contains(feed["payload"]["price"].as_str().unwrap()));
            let graph=state["structured_data"]["@graph"].as_array().unwrap();let product=graph.iter().find(|v|v["@type"]=="Product").unwrap();assert_eq!(product["offers"]["price"],feed["payload"]["price"]);assert_eq!(state["availability"],feed["payload"]["availability"]["description"]);
            if label=="image" {assert_eq!(product["image"]["contentUrl"],feed["payload"]["image"]["url"]);assert!(html.contains("/api/v1/catalog/media/00000000-0000-0000-0000-000000000999/content"));}
        }
        if let Ok(dir)=std::env::var("PUBLICATION_EVIDENCE_DIR") {std::fs::create_dir_all(&dir).unwrap();std::fs::write(format!("{dir}/pipeline-{label}.html"),html).unwrap();std::fs::write(format!("{dir}/pipeline-{label}-sitemap.xml"),xml).unwrap();std::fs::write(format!("{dir}/pipeline-{label}-feed.json"),serde_json::to_string_pretty(&feed).unwrap()).unwrap();}
    }
    task.abort();
}
