use sqlx::PgPool;

// Captured from all three deployed stores and verified against the prior gateway binary.
const DEPLOYED_DISCOVERY_CHECKSUM: &str = "e94cb98ffaf356326c1e526759e48f1863c62737b08dfae4f70607f7614ebea622a4e9ad8419dffd19a0f9702d760feb";

#[sqlx::test(migrations = false)]
async fn upgrades_deployed_discovery_without_rewriting_migration_history(pool: PgPool) {
    let mut previous = sqlx::migrate!("../../migrations");
    previous
        .migrations
        .to_mut()
        .retain(|m| m.version <= 20260921180000 || m.version == 20260921200000);
    previous.run(&pool).await.unwrap();
    let before: String = sqlx::query_scalar(
        "SELECT encode(checksum,'hex') FROM _sqlx_migrations WHERE version=20260921180000",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(before, DEPLOYED_DISCOVERY_CHECKSUM);
    let has_route_key: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='platform' AND table_name='publication_sitemap_resources' AND column_name='route_key')")
        .fetch_one(&pool).await.unwrap();
    assert!(!has_route_key);

    sqlx::query("INSERT INTO catalog.categories(id,name,slug) VALUES('00000000-0000-0000-0000-000000000001','Upgrade category','upgrade-category')").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) VALUES('00000000-0000-0000-0000-000000000002','UPGRADE-1','upgrade-product','Upgrade product','Preserve this product',10,'USD','ea','00000000-0000-0000-0000-000000000001')").execute(&pool).await.unwrap();
    sqlx::query(
        "UPDATE cms.publication_crawlers SET revision=7,openai_search=false,openai_training=true",
    )
    .execute(&pool)
    .await
    .unwrap();
    let product_before: serde_json::Value =
        sqlx::query_scalar("SELECT to_jsonb(p) FROM catalog.products p WHERE sku='UPGRADE-1'")
            .fetch_one(&pool)
            .await
            .unwrap();

    infra_db::migrate(&pool).await.unwrap();
    // A second normal startup must also succeed without replaying DDL.
    infra_db::migrate(&pool).await.unwrap();
    let after: String = sqlx::query_scalar(
        "SELECT encode(checksum,'hex') FROM _sqlx_migrations WHERE version=20260921180000",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(after, DEPLOYED_DISCOVERY_CHECKSUM);
    let product_after: serde_json::Value =
        sqlx::query_scalar("SELECT to_jsonb(p) FROM catalog.products p WHERE sku='UPGRADE-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    // The category membership migration adds the legacy primary category while
    // preserving every pre-existing product field.
    let mut expected_product = product_before.clone();
    expected_product["category_ids"] = serde_json::json!([product_before["category_id"]]);
    // The later numeric identifier migration assigns the fixture's first
    // product ID while retaining its original UUID and every business field.
    expected_product["entity_id"] = serde_json::json!(1);
    assert_eq!(expected_product, product_after);
    let preferences: (i32, bool, bool) = sqlx::query_as(
        "SELECT revision,openai_search,openai_training FROM cms.publication_crawlers",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(preferences, (7, false, true));
    let route_key: String = sqlx::query_scalar("SELECT route_key FROM platform.publication_sitemap_resources WHERE kind='products' AND id='00000000-0000-0000-0000-000000000002'").fetch_one(&pool).await.unwrap();
    assert_eq!(route_key, "upgrade-product");
    let new_tables: bool = sqlx::query_scalar("SELECT to_regclass('cms.publication_entity') IS NOT NULL AND to_regclass('platform.publication_freshness') IS NOT NULL AND to_regclass('customers.journey_events') IS NOT NULL").fetch_one(&pool).await.unwrap();
    assert!(new_tables);
}
