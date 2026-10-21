use api_gateway::{
    discoverability::{self, App},
    identity,
    public_commerce::{
        feeds::{self, Event, FeedAdapter, ReferenceAdapter},
        policy::Deployment,
        snapshot::{self, Request},
    },
};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;
async fn app(pool: &PgPool) -> App {
    sqlx::query("UPDATE cms.discoverability_settings SET enabled=true,indexing_enabled=true,canonical_url='https://shop.example.test/'").execute(pool).await.unwrap();
    let id = sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
        .fetch_one(pool)
        .await
        .unwrap();
    App {
        identity: identity::App::new(
            pool.clone(),
            infra_auth::Security::new(
                "test-secret-must-not-leak".repeat(3),
                "https://shop.example.test".into(),
                false,
            )
            .await
            .unwrap(),
            vec!["https://admin.example.test".into()],
        ),
        deployment: Deployment {
            installation_id: Some(id),
            environment: "production".into(),
            approved_origin: Some("https://shop.example.test/".into()),
            header_override: false,
            html: Some("<html></html>".into()),
        },
    }
}
async fn seed(pool: &PgPool) {
    sqlx::query("INSERT INTO catalog.categories(id,name,slug) VALUES('00000000-0000-0000-0000-000000000001','Fruit','fruit')").execute(pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,attributes) VALUES('00000000-0000-0000-0000-000000000002','APPLE','apples','Apples','Public apples',3.25,'USD','kg','00000000-0000-0000-0000-000000000001','{\"private\":\"SECRET-CUSTOMER-PRICE\"}')").execute(pool).await.unwrap();
}
async fn drain(a: &App) {
    for _ in 0..100 {
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
    panic!("reconciliation did not converge");
}
async fn current(a: &App) -> Value {
    sqlx::query_scalar("SELECT payload FROM platform.publication_reference_feed WHERE operation='upsert' ORDER BY version DESC LIMIT 1").fetch_one(&a.identity.admins.pool).await.unwrap()
}
async fn snapshot(a: &App) -> Value {
    serde_json::to_value(
        snapshot::assemble(
            a,
            Request {
                path: "/products/apples".into(),
                page: 1,
            },
            None,
        )
        .await
        .unwrap(),
    )
    .unwrap()
}
async fn parity(a: &App, label: &str) {
    drain(a).await;
    let s = snapshot(a).await;
    let f = current(a).await;
    assert_eq!(s["representation_version"], f["representation_version"]);
    assert_eq!(s["canonical"]["feed"], f["url"]);
    assert_eq!(s["product"]["price"], f["price"]);
    let graph = s["structured_data"]["@graph"].as_array().unwrap();
    let product = graph.iter().find(|v| v["@type"] == "Product").unwrap();
    assert_eq!(product["offers"]["price"], f["price"]);
    assert_eq!(product["offers"]["priceCurrency"], f["currency"]);
    let modified: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        "SELECT lastmod FROM platform.publication_sitemap_resources WHERE kind='products'",
    )
    .fetch_one(&a.identity.admins.pool)
    .await
    .unwrap();
    assert!(modified.is_some());
    assert!(!f.to_string().contains("SECRET"));
    assert!(!f.to_string().contains("object_key"));
    if let Ok(dir) = std::env::var("PUBLICATION_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            format!("{dir}/{label}.json"),
            serde_json::to_string_pretty(
                &json!({"snapshot":s,"reference_feed":f,"sitemap_lastmod":modified}),
            )
            .unwrap(),
        )
        .unwrap();
    }
}
#[sqlx::test(migrations = "../../migrations")]
async fn creation_price_availability_image_deletion_and_private_noop(pool: PgPool) {
    let a = app(&pool).await;
    seed(&pool).await;
    parity(&a, "created").await;
    let first: Value = sqlx::query_scalar(
        "SELECT to_jsonb(s) FROM platform.publication_state s WHERE kind='products'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE catalog.products SET updated_at=now(),attributes='{\"private\":\"NEW-SECRET\"}',in_stock=false").execute(&pool).await.unwrap();
    drain(&a).await;
    let noop: Value = sqlx::query_scalar(
        "SELECT to_jsonb(s) FROM platform.publication_state s WHERE kind='products'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(first, noop);
    sqlx::query("UPDATE catalog.products SET price=4.75")
        .execute(&pool)
        .await
        .unwrap();
    parity(&a, "price-changed").await;
    assert_eq!(current(&a).await["price"], "4.75");
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km) VALUES(gen_random_uuid(),'Cairo',30,31,10)").execute(&pool).await.unwrap();
    parity(&a, "availability-changed").await;
    assert!(current(&a).await["availability"]["description"]
        .as_str()
        .unwrap()
        .contains("delivery location"));
    sqlx::query("INSERT INTO catalog.media(id,content_type,alt,object_key,size_bytes) VALUES('00000000-0000-0000-0000-000000000003','image/png','Apple photo','PRIVATE-OBJECT-KEY',20)").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.publication_images(media_id,width,height) VALUES('00000000-0000-0000-0000-000000000003',32,32)").execute(&pool).await.unwrap();
    sqlx::query(
        "UPDATE catalog.products SET media_ids=ARRAY['00000000-0000-0000-0000-000000000003'::uuid]",
    )
    .execute(&pool)
    .await
    .unwrap();
    parity(&a, "image-changed").await;
    assert_eq!(current(&a).await["image"]["width"], 32);
    sqlx::query("UPDATE catalog.products SET active=false")
        .execute(&pool)
        .await
        .unwrap();
    drain(&a).await;
    assert_eq!(snapshot(&a).await["status"], 404);
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM platform.publication_sitemap_resources WHERE kind='products'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(n, 0);
    let op: String =
        sqlx::query_scalar("SELECT operation FROM platform.publication_reference_feed")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(op, "delete");
    sqlx::query("DELETE FROM catalog.products")
        .execute(&pool)
        .await
        .unwrap();
    drain(&a).await;
}
struct Failing;
impl FeedAdapter for Failing {
    async fn deliver(&self, _: &mut sqlx::PgConnection, _: &Event) -> Result<(), &'static str> {
        Err("TOKEN=must-not-persist")
    }
}
#[sqlx::test(migrations = "../../migrations")]
async fn retries_idempotency_out_of_order_loss_and_tombstone_recovery(pool: PgPool) {
    let a = app(&pool).await;
    seed(&pool).await;
    feeds::reconcile_batch(&a).await.unwrap();
    feeds::deliver_batch(&a, &Failing).await.unwrap();
    let (status,attempts,error,future):(String,i32,String,bool)=sqlx::query_as("SELECT status,attempts,error_code,next_attempt_at>now() FROM platform.publication_feed_events").fetch_one(&pool).await.unwrap();
    assert_eq!(
        (status.as_str(), attempts, error.as_str(), future),
        ("retry", 1, "adapter_delivery_failed", true)
    );
    assert_eq!(
        feeds::deliver_batch(&a, &ReferenceAdapter).await.unwrap(),
        0
    );
    sqlx::query("UPDATE platform.publication_feed_events SET next_attempt_at=now()")
        .execute(&pool)
        .await
        .unwrap();
    feeds::deliver_batch(&a, &ReferenceAdapter).await.unwrap();
    sqlx::query("UPDATE platform.publication_freshness SET next_delivery_at=now()")
        .execute(&pool)
        .await
        .unwrap();
    feeds::deliver_batch(&a, &ReferenceAdapter).await.unwrap();
    let old:Event=sqlx::query_as("SELECT version,installation_id,item_key,product_id,operation,payload FROM platform.publication_feed_events").fetch_one(&pool).await.unwrap();
    sqlx::query("UPDATE catalog.products SET price=8")
        .execute(&pool)
        .await
        .unwrap();
    drain(&a).await;
    let mut conn = pool.acquire().await.unwrap();
    ReferenceAdapter.deliver(&mut conn, &old).await.unwrap();
    ReferenceAdapter.deliver(&mut conn, &old).await.unwrap();
    drop(conn);
    assert_eq!(current(&a).await["price"], "8.00");
    let lastmod: chrono::DateTime<chrono::Utc> = sqlx::query_scalar(
        "SELECT changed_at FROM platform.publication_state WHERE kind='products'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM platform.publication_feed_events")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM platform.publication_reference_feed")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE platform.publication_freshness SET generation=generation+1")
        .execute(&pool)
        .await
        .unwrap();
    drain(&a).await;
    assert_eq!(current(&a).await["price"], "8.00");
    let repaired: chrono::DateTime<chrono::Utc> = sqlx::query_scalar(
        "SELECT changed_at FROM platform.publication_state WHERE kind='products'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(lastmod, repaired);
    // Simulate a lost domain invalidation. Periodic full comparison still discovers the edit.
    sqlx::query("ALTER TABLE catalog.products DISABLE TRIGGER publication_changed")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE catalog.products SET price=9")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE catalog.products ENABLE TRIGGER publication_changed")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE platform.publication_freshness SET next_scan_at=now()")
        .execute(&pool)
        .await
        .unwrap();
    drain(&a).await;
    assert_eq!(current(&a).await["price"], "9.00");
    sqlx::query("UPDATE catalog.products SET active=false")
        .execute(&pool)
        .await
        .unwrap();
    drain(&a).await;
    sqlx::query("DELETE FROM platform.publication_feed_events WHERE operation='delete'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE platform.publication_reference_feed SET operation='upsert'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE platform.publication_freshness SET generation=generation+1")
        .execute(&pool)
        .await
        .unwrap();
    drain(&a).await;
    let op: String =
        sqlx::query_scalar("SELECT operation FROM platform.publication_reference_feed")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(op, "delete");
}
#[sqlx::test(migrations = "../../migrations")]
async fn variants_locale_currency_guard_and_binding(pool: PgPool) {
    let a = app(&pool).await;
    seed(&pool).await;
    drain(&a).await;
    assert!(sqlx::query("UPDATE catalog.products SET currency='EUR'")
        .execute(&pool)
        .await
        .is_err());
    sqlx::query("UPDATE catalog.products SET product_type='configurable'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,parent_id) SELECT '00000000-0000-0000-0000-000000000004','GREEN','green-apples','Green apples','Variant',5,'USD','kg',category_id,id FROM catalog.products").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.product_links(parent_id,child_id,position) VALUES('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000004',0)").execute(&pool).await.unwrap();
    drain(&a).await;
    let child: Value = sqlx::query_scalar(
        "SELECT payload FROM platform.publication_reference_feed WHERE payload->>'sku'='GREEN'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(child["parent_id"], Uuid::from_u128(2).to_string());
    assert_eq!(child["price"], "5.00");
    sqlx::query("UPDATE cms.discoverability_settings SET default_locale='ar-EG'")
        .execute(&pool)
        .await
        .unwrap();
    drain(&a).await;
    let counts:Vec<(String,String,i64)>=sqlx::query_as("SELECT payload->>'locale',operation,count(*) FROM platform.publication_reference_feed GROUP BY 1,2 ORDER BY 1").fetch_all(&pool).await.unwrap();
    assert!(counts.contains(&("en".into(), "delete".into(), 2)));
    assert!(counts.contains(&("ar-EG".into(), "upsert".into(), 2)));
    let mut wrong = a.clone();
    wrong.deployment.installation_id = Some(Uuid::new_v4());
    assert!(feeds::reconcile_batch(&wrong).await.is_err());
    assert!(feeds::deliver_batch(&wrong, &ReferenceAdapter)
        .await
        .is_err());
    sqlx::query(
        "UPDATE catalog.products SET active=false WHERE id='00000000-0000-0000-0000-000000000002'",
    )
    .execute(&pool)
    .await
    .unwrap();
    drain(&a).await;
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM platform.publication_reference_feed WHERE operation='upsert'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(n, 0);
}
async fn server(a: &App) -> (String, Uuid, tokio::task::JoinHandle<()>) {
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,$2,'Publisher','!',$3)").bind(user).bind(format!("{user}@example.test")).bind(domain_admin_iam::SUPER).execute(&a.identity.admins.pool).await.unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest(&user.to_string())).bind(user).execute(&a.identity.admins.pool).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = discoverability::router_with_deployment(a.identity.clone(), a.deployment.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (base, user, task)
}
#[sqlx::test(migrations = "../../migrations")]
async fn export_http_auth_csrf_full_incremental_watermarks_and_unpublication(pool: PgPool) {
    let a = app(&pool).await;
    seed(&pool).await;
    drain(&a).await;
    let (base, user, task) = server(&a).await;
    let c = reqwest::Client::builder().no_proxy().build().unwrap();
    let url = format!("{base}/v1/admin/discovery/feeds");
    let cookie = format!("admin_session={user}");
    assert_eq!(c.get(&url).send().await.unwrap().status(), 401);
    assert_eq!(
        c.post(format!("{url}/reconcile"))
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let r = c
        .get(format!("{url}/export?full=true"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["cache-control"], "no-store");
    let full: Value = r.json().await.unwrap();
    assert_eq!(full["items"].as_array().unwrap().len(), 1);
    let watermark = full["until"].as_i64().unwrap();
    sqlx::query("UPDATE catalog.products SET price=7")
        .execute(&pool)
        .await
        .unwrap();
    drain(&a).await;
    let next: Value = c
        .get(format!("{url}/export?after={watermark}"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(next["items"][0]["payload"]["price"], "7.00");
    let frozen: Value = c
        .get(format!("{url}/export?full=true&until={watermark}"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(frozen["items"][0]["payload"]["price"], "3.25");
    sqlx::query("UPDATE catalog.products SET active=false")
        .execute(&pool)
        .await
        .unwrap();
    let redacted: Value = c
        .get(format!("{url}/export?full=true"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(redacted["items"][0]["operation"], "delete");
    assert!(redacted["items"][0]["payload"].get("title").is_none());
    for expected in [200, 429] {
        let r = c
            .post(format!("{url}/reconcile"))
            .header("cookie", &cookie)
            .header("origin", "https://admin.example.test")
            .header("x-commerce-request", "1")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), expected);
    }
    task.abort();
}
#[sqlx::test(migrations = "../../migrations")]
async fn bounded_large_journal_pages(pool: PgPool) {
    let a = app(&pool).await;
    seed(&pool).await;
    drain(&a).await;
    sqlx::query("INSERT INTO platform.publication_feed_events(installation_id,item_key,product_id,operation,payload) SELECT installation_id,'synthetic-'||lpad(n::text,8,'0'),'00000000-0000-0000-0000-000000000002','delete','{\"fixture\":true}'::jsonb FROM platform.publication_installation CROSS JOIN generate_series(1,10000) n").execute(&pool).await.unwrap();
    let (base, user, task) = server(&a).await;
    let c = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut key = String::new();
    let mut until = None;
    let mut total = 0;
    loop {
        let url = format!(
            "{base}/v1/admin/discovery/feeds/export?full=true&key={key}{}",
            until
                .map(|v: i64| format!("&until={v}"))
                .unwrap_or_default()
        );
        let r: Value = c
            .get(url)
            .header("cookie", format!("admin_session={user}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let items = r["items"].as_array().unwrap();
        assert!(items.len() <= 100);
        total += items.len();
        until = r["until"].as_i64();
        key = r["next_key"].as_str().unwrap().into();
        if r["has_more"] == false {
            break;
        }
    }
    assert_eq!(total, 10001);
    task.abort();
}

#[sqlx::test(migrations = "../../migrations")]
async fn automatic_worker_and_two_installation_isolation(pool: PgPool) {
    let a = app(&pool).await;
    seed(&pool).await;
    let db = format!("feeds_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {db}"))
        .execute(&pool)
        .await
        .unwrap();
    let other = sqlx::postgres::PgPoolOptions::new()
        .connect_with(pool.connect_options().as_ref().clone().database(&db))
        .await
        .unwrap();
    sqlx::migrate!("../../migrations")
        .run(&other)
        .await
        .unwrap();
    let b = app(&other).await;
    seed(&other).await;
    sqlx::query("UPDATE catalog.products SET name='Other merchant apples',price=99")
        .execute(&other)
        .await
        .unwrap();
    let worker = tokio::spawn(feeds::worker(a.clone()));
    let worker_b = tokio::spawn(feeds::worker(b.clone()));
    for _ in 0..50 {
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.publication_reference_feed")
            .fetch_one(&pool)
            .await
            .unwrap();
        let m: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.publication_reference_feed")
            .fetch_one(&other)
            .await
            .unwrap();
        if n == 1 && m == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(current(&a).await["title"], "Apples");
    assert_eq!(current(&b).await["title"], "Other merchant apples");
    assert_ne!(
        current(&a).await["installation_id"],
        current(&b).await["installation_id"]
    );
    let (base, user, server_a) = server(&a).await;
    let (second, _, server_b) = server(&b).await;
    let c = reqwest::Client::builder().no_proxy().build().unwrap();
    assert_eq!(
        c.get(format!("{second}/v1/admin/discovery/feeds"))
            .header("cookie", format!("admin_session={user}"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let first: Value = c
        .get(format!("{base}/v1/admin/discovery/feeds/export?full=true"))
        .header("cookie", format!("admin_session={user}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!first.to_string().contains("Other merchant"));
    worker.abort();
    worker_b.abort();
    server_a.abort();
    server_b.abort();
    other.close().await;
    sqlx::query(&format!("DROP DATABASE {db} WITH (FORCE)"))
        .execute(&pool)
        .await
        .unwrap();
}
#[sqlx::test(migrations = "../../migrations")]
async fn bounded_catalog_scan_reaches_every_product(pool: PgPool) {
    let a = app(&pool).await;
    seed(&pool).await;
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) SELECT md5(n::text)::uuid,'SKU-'||n,'product-'||n,'Product '||n,'Fixture',5,'USD','each','00000000-0000-0000-0000-000000000001' FROM generate_series(1,257)n").execute(&pool).await.unwrap();
    for _ in 0..100 {
        sqlx::query(
            "UPDATE platform.publication_freshness SET next_batch_at=now(),next_delivery_at=now()",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert!(feeds::reconcile_batch(&a).await.unwrap() <= 10);
        feeds::deliver_batch(&a, &ReferenceAdapter).await.unwrap();
        let done:bool=sqlx::query_scalar("SELECT completed_generation=generation AND cursor_kind='' FROM platform.publication_freshness").fetch_one(&pool).await.unwrap();
        if done {
            break;
        }
    }
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM platform.publication_reference_feed WHERE operation='upsert'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(n, 258);
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_change_fences_stale_snapshot(pool: PgPool) {
    let a = app(&pool).await;
    seed(&pool).await;
    // Empty media lists intentionally skip the image query. Reference a real
    // fixture image so this table lock actually controls snapshot assembly.
    let media = Uuid::new_v4();
    sqlx::query("INSERT INTO catalog.media(id,content_type,alt,object_key,size_bytes) VALUES($1,'image/png','Race fixture','fixture-only',20)")
        .bind(media).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.publication_images(media_id,width,height) VALUES($1,32,32)")
        .bind(media)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE catalog.products SET media_ids=ARRAY[$1]")
        .bind(media)
        .execute(&pool)
        .await
        .unwrap();
    let mut lock = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE catalog.publication_images IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *lock)
        .await
        .unwrap();
    let copy = a.clone();
    let run = tokio::spawn(async move { feeds::reconcile_batch(&copy).await });
    let mut waiting = false;
    for _ in 0..50 {
        waiting=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation='catalog.publication_images'::regclass AND NOT granted)").fetch_one(&pool).await.unwrap();
        if waiting {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(waiting, "snapshot must reach controlled interleaving");
    sqlx::query("UPDATE catalog.products SET price=6.50")
        .execute(&pool)
        .await
        .unwrap();
    lock.commit().await.unwrap();
    assert_eq!(run.await.unwrap().unwrap(), 0);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.publication_state")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    drain(&a).await;
    assert_eq!(current(&a).await["price"], "6.50");
}
#[sqlx::test(migrations = "../../migrations")]
async fn permanent_item_error_does_not_stop_valid_delivery_and_retry_ceiling(pool: PgPool) {
    let a = app(&pool).await;
    seed(&pool).await;
    sqlx::query("UPDATE catalog.products SET name=''")
        .execute(&pool)
        .await
        .unwrap();
    feeds::reconcile_batch(&a).await.unwrap();
    feeds::deliver_batch(&a, &ReferenceAdapter).await.unwrap();
    let (status, code): (String, String) =
        sqlx::query_as("SELECT status,error_code FROM platform.publication_feed_events")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!((status.as_str(), code.as_str()), ("failed", "invalid_item"));
    sqlx::query("UPDATE catalog.products SET name='Repaired apples'")
        .execute(&pool)
        .await
        .unwrap();
    drain(&a).await;
    assert_eq!(current(&a).await["title"], "Repaired apples");
    sqlx::query("UPDATE catalog.products SET price=10")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE platform.publication_freshness SET next_batch_at=now()")
        .execute(&pool)
        .await
        .unwrap();
    feeds::reconcile_batch(&a).await.unwrap();
    for _ in 0..8 {
        sqlx::query("UPDATE platform.publication_freshness SET next_delivery_at=now()")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE platform.publication_feed_events SET next_attempt_at=now() WHERE status IN ('queued','retry')").execute(&pool).await.unwrap();
        feeds::deliver_batch(&a, &Failing).await.unwrap();
    }
    let (status,attempts):(String,i32)=sqlx::query_as("SELECT status,attempts FROM platform.publication_feed_events ORDER BY version DESC LIMIT 1").fetch_one(&pool).await.unwrap();
    assert_eq!((status.as_str(), attempts), ("failed", 8));
}

#[sqlx::test(migrations = "../../migrations")]
async fn published_best_seller_collection_uses_sales_not_catalog_order(pool: PgPool) {
    seed(&pool).await;
    let a = app(&pool).await;
    let actor = Uuid::new_v4();
    let theme = Uuid::new_v4();
    let version = Uuid::new_v4();
    let mut config = serde_json::to_value(domain_theme::domain::default_configuration()).unwrap();
    config["pages"]["product"].as_array_mut().unwrap().push(json!({"id":"sales","component":"best_sellers","version":1,"enabled":true,"settings":{"heading":"Best sellers","period":"today","limit":8}}));
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'sales@example.test','Publisher','!', $2)").bind(actor).bind(domain_admin_iam::SUPER).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO theme.themes(id,name,owner_channel,configuration,created_by) VALUES($1,'Sales theme','storefront',$2,$3)").bind(theme).bind(&config).bind(actor).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO theme.versions(id,theme_id,number,configuration,created_by) VALUES($1,$2,1,$3,$4)").bind(version).bind(theme).bind(config).bind(actor).execute(&pool).await.unwrap();
    sqlx::query("UPDATE theme.themes SET published_version=$2 WHERE id=$1")
        .bind(theme)
        .bind(version)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO theme.assignments(channel,theme_id) VALUES('storefront',$1) ON CONFLICT(channel) DO UPDATE SET theme_id=$1").bind(theme).execute(&pool).await.unwrap();
    assert_eq!(snapshot(&a).await["collections"]["sales"], json!([]));
    let order = Uuid::new_v4();
    sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency,created_at) VALUES($1,$2,$3,$4,'delivered','{}','{}',10,0,10,'USD',date_trunc('day',now()))")
        .bind(order).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO orders.order_items(order_id,product_id,sku,name,unit,quantity,price,line_total) VALUES($1,'00000000-0000-0000-0000-000000000002','APPLE','Apples','kg',2,5,10)").bind(order).execute(&pool).await.unwrap();
    let result = snapshot(&a).await;
    assert_eq!(result["collections"]["sales"].as_array().unwrap().len(), 1);
    assert_eq!(result["collections"]["sales"][0]["name"], "Apples");
    assert!(!result["collections"]
        .to_string()
        .contains("SECRET-CUSTOMER-PRICE"));
    sqlx::query("UPDATE orders.orders SET status='cancelled' WHERE id=$1")
        .bind(order)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(snapshot(&a).await["collections"]["sales"], json!([]));
}
