use serde_json::Value;
use sqlx::PgPool;

async fn catalog(pool: &PgPool, count: i32) {
    sqlx::query("INSERT INTO catalog.categories(id,name,slug) VALUES(md5('scale-category')::uuid,'Scale category','scale-category')")
        .execute(pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) SELECT md5('scale-product-'||n)::uuid,'SCALE-'||n,'scale-'||n,'Scale '||n,'Description',10,'USD','ea',md5('scale-category')::uuid FROM generate_series(1,$1) n")
        .bind(count).execute(pool).await.unwrap();
}

async fn snapshot(pool: &PgPool) -> Value {
    sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(p)-'entity_id' ORDER BY id) FROM catalog.storefront_products p",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrations = false)]
async fn upgrade_preserves_published_and_default_catalog(pool: PgPool) {
    let mut previous = sqlx::migrate!("../../migrations");
    previous
        .migrations
        .to_mut()
        .retain(|m| m.version < 20261002190000);
    previous.run(&pool).await.unwrap();
    catalog(&pool, 6).await;
    sqlx::raw_sql("
        UPDATE catalog.products SET product_type='configurable' WHERE sku='SCALE-1';
        UPDATE catalog.products SET parent_id=md5('scale-product-1')::uuid WHERE sku='SCALE-2';
        UPDATE catalog.products SET active=false WHERE sku='SCALE-3';
        INSERT INTO admin_iam.roles(id,name,permissions) VALUES(md5('scale-role')::uuid,'Scale',ARRAY[]::text[]);
        INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id)
          VALUES(md5('scale-admin')::uuid,'scale@test.local','Scale','!',md5('scale-role')::uuid);
        INSERT INTO cart_checkout.market_drafts(id,name,country,currency,locales,default_locale)
          VALUES(md5('scale-market')::uuid,'Scale market','US','USD',ARRAY['en','ar'],'en');
        INSERT INTO cart_checkout.market_releases(id,market_id,name,country,currency,source_locale,draft_revision,created_by)
          VALUES(md5('scale-release')::uuid,md5('scale-market')::uuid,'Scale market','US','USD','en',1,md5('scale-admin')::uuid);
        INSERT INTO cart_checkout.market_release_overrides(release_id,entity_type,entity_id,available,price) VALUES
          (md5('scale-release')::uuid,'product',md5('scale-product-1')::uuid,false,NULL),
          (md5('scale-release')::uuid,'product',md5('scale-product-3')::uuid,true,12.34),
          (md5('scale-release')::uuid,'product',md5('scale-product-4')::uuid,NULL,0),
          (md5('scale-release')::uuid,'product',md5('scale-product-5')::uuid,NULL,9999999999.99);
    ").execute(&pool).await.unwrap();
    let defaults = snapshot(&pool).await;
    sqlx::query("UPDATE cart_checkout.active_market SET release_id=md5('scale-release')::uuid")
        .execute(&pool)
        .await
        .unwrap();
    let published = snapshot(&pool).await;
    let preflight = include_str!("../../../../scripts/maintenance/market-language-preflight.sql")
        .split("BEGIN READ ONLY;")
        .nth(1)
        .unwrap()
        .trim()
        .trim_end_matches("COMMIT;");
    let checks: Vec<(String, i64)> = sqlx::query_as(preflight).fetch_all(&pool).await.unwrap();
    assert!(checks.iter().all(|(_, count)| *count == 0), "{checks:?}");
    infra_db::migrate(&pool).await.unwrap();
    infra_db::migrate(&pool).await.unwrap();
    assert_eq!(published, snapshot(&pool).await);
    sqlx::query("UPDATE cart_checkout.active_market SET release_id=NULL")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(defaults, snapshot(&pool).await);
    for (revision, actor, expected_code) in
        [(0, "scale-admin", "23514"), (1, "missing-admin", "23503")]
    {
        let error = sqlx::query("INSERT INTO cart_checkout.market_releases(id,market_id,name,country,currency,source_locale,draft_revision,created_by) VALUES(gen_random_uuid(),md5('scale-market')::uuid,'Invalid','US','USD','en',$1,md5($2)::uuid)")
            .bind(revision).bind(actor).execute(&pool).await.unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some(expected_code)
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn storefront_point_lookups_use_catalog_indexes(pool: PgPool) {
    catalog(&pool, 10_000).await;
    sqlx::query("ANALYZE catalog.products")
        .execute(&pool)
        .await
        .unwrap();
    // Freeze the observed baseline: other work can independently optimize an older migration.
    sqlx::raw_sql(include_str!("fixtures/storefront-products-json-view.sql"))
        .execute(&pool)
        .await
        .unwrap();
    for (predicate, index) in [
        ("id=md5('scale-product-9999')::uuid", "products_pkey"),
        ("slug='scale-9999'", "products_slug_key"),
    ] {
        let plan: Value = sqlx::query_scalar(&format!(
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM catalog.storefront_products WHERE {predicate}"
        )).fetch_one(&pool).await.unwrap();
        assert!(plan.to_string().contains(index), "Expected {index}: {plan}");
        let old_plan: Value = sqlx::query_scalar(&format!(
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM catalog.legacy_storefront_products WHERE {predicate}"
        )).fetch_one(&pool).await.unwrap();
        println!(
            "{index}: before {} ms, after {} ms",
            old_plan[0]["Execution Time"], plan[0]["Execution Time"]
        );
    }
    // Cursor-based indexing/export queries must also retain the underlying ID index.
    let plan: Value = sqlx::query_scalar("EXPLAIN (FORMAT JSON) SELECT * FROM catalog.storefront_products WHERE id>'ffffffff-0000-0000-0000-000000000000' ORDER BY id LIMIT 10")
        .fetch_one(&pool).await.unwrap();
    assert!(plan.to_string().contains("products_pkey"), "{plan}");
}

#[sqlx::test(migrations = "../../migrations")]
async fn fresh_store_visibility_checks_do_not_trigger_expensive_jit(pool: PgPool) {
    // Deliberately do not ANALYZE singleton tables: this is a freshly migrated store.
    catalog(&pool, 1).await;
    let plan: Value = sqlx::query_scalar("EXPLAIN (ANALYZE, FORMAT JSON) SELECT EXISTS(SELECT 1 FROM catalog.storefront_products p LEFT JOIN catalog.storefront_products parent ON parent.id=p.parent_id WHERE p.id=md5('scale-product-1')::uuid AND p.active AND (p.parent_id IS NULL OR parent.active) AND NOT EXISTS(SELECT 1 FROM platform.publication_routes r WHERE r.path='/products/'||p.slug))")
        .fetch_one(&pool).await.unwrap();
    assert!(
        plan[0].get("JIT").is_none(),
        "Unexpected JIT for a point visibility check: {plan}"
    );
    assert!(
        plan[0]["Plan"]["Total Cost"].as_f64().unwrap() < 100_000.0,
        "Inflated singleton cardinality: {plan}"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn database_rejects_ambiguous_locales_and_invalid_market_revisions(pool: PgPool) {
    for locale in ["ar", "en-GB", "zh-Hant", "zh-Hant-TW", "es-419"] {
        sqlx::query("INSERT INTO cms.storefront_languages(locale,name,native_name,direction) VALUES($1,$1,$1,'ltr')")
            .bind(locale).execute(&pool).await.unwrap();
    }
    for locale in ["EN", "en-us", "en_US", "en/GB", "en--GB", " en", "en\n"] {
        let error = sqlx::query("INSERT INTO cms.storefront_languages(locale,name,native_name,direction) VALUES($1,$1,$1,'ltr')")
            .bind(locale).execute(&pool).await.unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("23514")
        );
    }
    for locales in [
        "ARRAY['en','en']",
        "ARRAY['en',NULL]",
        "ARRAY[NULL]::text[]",
        "ARRAY[['en','ar']]",
        "ARRAY['EN']",
        "ARRAY[]::text[]",
    ] {
        let error = sqlx::query(&format!("INSERT INTO cart_checkout.market_drafts(id,name,country,currency,locales,default_locale) VALUES(gen_random_uuid(),'Invalid','US','USD',{locales},'en')"))
            .execute(&pool).await.unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("23514")
        );
    }
    sqlx::query("INSERT INTO cart_checkout.market_drafts(id,name,country,currency,locales,default_locale) VALUES(gen_random_uuid(),'Valid','US','USD',ARRAY['en','ar','zh-Hant-TW'],'en')")
        .execute(&pool).await.unwrap();
    let error = sqlx::query("UPDATE cart_checkout.active_market SET revision=0")
        .execute(&pool)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23514")
    );
}
