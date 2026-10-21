use serde_json::Value;
use sqlx::PgPool;

const ENTITY_ID_MIGRATION: i64 = 20261003020000;
const MAX_ENTITY_ID: i64 = 9_007_199_254_740_991;
const ENTITIES: &[&str] = &[
    "admin_iam.admin_users",
    "admin_iam.roles",
    "attributes.definitions",
    "attributes.sets",
    "attributes.industry_profiles",
    "attributes.value_relationships",
    "attributes.enrichment_suggestions",
    "catalog.products",
    "catalog.categories",
    "catalog.attributes",
    "catalog.media",
    "catalog.media_folders",
    "catalog.product_configurations",
    "customers.customers",
    "customers.customer_locations",
    "customers.segments",
    "inventory.inventory_sources",
    "inventory.stocks",
    "inventory.delivery_areas",
    "cart_checkout.carts",
    "cart_checkout.quotes",
    "cart_checkout.market_drafts",
    "cart_checkout.market_releases",
    "cart_checkout.trust_agents",
    "orders.orders",
    "payments.manual_refunds",
    "tax.rules",
    "pricing_promotions.rules",
    "fulfillment.shipments",
    "fulfillment.stores",
    "fulfillment.schedules",
    "fulfillment.capacity_rules",
    "fulfillment.capacity_reservations",
    "fulfillment.plans",
    "fulfillment.plan_groups",
    "support.tickets",
    "support.messages",
    "cms.documents",
    "cms.revisions",
    "cms.releases",
    "reviews.reviews",
    "theme.themes",
    "theme.versions",
];

async fn business_facts(pool: &PgPool) -> Vec<Value> {
    let mut facts = Vec::new();
    for table in ENTITIES {
        // Strip the additive identifier so every pre-existing fact, including
        // timestamps, published versions and foreign keys, must remain identical.
        let query = format!(
            "SELECT COALESCE(jsonb_agg(to_jsonb(e)-'entity_id' ORDER BY id),'[]'::jsonb) FROM {table} e"
        );
        facts.push(sqlx::query_scalar(&query).fetch_one(pool).await.unwrap());
    }
    facts
}

async fn reference_facts(pool: &PgPool) -> Vec<Value> {
    let mut facts = Vec::new();
    for table in [
        "admin_iam.audit_log",
        "cms.catalog_translations",
        "cart_checkout.market_overrides",
        "cart_checkout.market_release_overrides",
    ] {
        let query = format!(
            "SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY to_jsonb(e)::text),'[]'::jsonb) FROM {table} e"
        );
        facts.push(sqlx::query_scalar(&query).fetch_one(pool).await.unwrap());
    }
    facts
}

async fn assert_identifier_schema(pool: &PgPool) {
    let actual: Vec<String> = sqlx::query_scalar(
        "SELECT table_schema||'.'||table_name FROM information_schema.columns WHERE column_name='entity_id' AND data_type='bigint' AND table_schema NOT IN ('pg_catalog','information_schema') AND table_name NOT IN ('storefront_products','storefront_categories') ORDER BY 1",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    let mut expected: Vec<String> = ENTITIES.iter().map(|table| (*table).to_owned()).collect();
    expected.sort();
    assert_eq!(actual, expected);
    for table in ENTITIES {
        let (schema, name) = table.split_once('.').unwrap();
        let identity: (String, String) = sqlx::query_as(
            "SELECT identity_generation,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name='entity_id'",
        )
        .bind(schema)
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(identity, ("ALWAYS".to_owned(), "NO".to_owned()), "{table}");
        let sequence: String = sqlx::query_scalar("SELECT pg_get_serial_sequence($1,'entity_id')")
            .bind(table)
            .fetch_one(pool)
            .await
            .unwrap();
        let bounds: (i64, i64, bool) = sqlx::query_as(
            "SELECT seqmin,seqmax,seqcycle FROM pg_sequence WHERE seqrelid=$1::regclass",
        )
        .bind(sequence)
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(bounds, (1, MAX_ENTITY_ID, false), "{table}");
        let query = format!(
            "SELECT count(*)=count(DISTINCT entity_id) AND COALESCE(bool_and(entity_id BETWEEN 1 AND {MAX_ENTITY_ID}),true) FROM {table}"
        );
        assert!(
            sqlx::query_scalar::<_, bool>(&query)
                .fetch_one(pool)
                .await
                .unwrap(),
            "{table}"
        );
        let id_type: String = sqlx::query_scalar(
            "SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name='id'",
        )
        .bind(schema)
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(id_type, "uuid", "{table}");
    }
    for table in [
        "admin_iam.audit_log",
        "cms.catalog_translations",
        "cart_checkout.market_overrides",
        "cart_checkout.market_release_overrides",
    ] {
        let (schema, name) = table.split_once('.').unwrap();
        let data_type: String = sqlx::query_scalar(
            "SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name='entity_id'",
        )
        .bind(schema)
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(data_type, "uuid", "{table} remains a UUID reference");
    }
}

fn assert_sqlstate(error: sqlx::Error, expected: &str) {
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some(expected)
    );
}

#[sqlx::test(migrations = false)]
async fn upgrade_backfills_identifiers_without_changing_uuid_business_facts(pool: PgPool) {
    let mut previous = sqlx::migrate!("../../migrations");
    previous
        .migrations
        .to_mut()
        .retain(|migration| migration.version < ENTITY_ID_MIGRATION);
    previous.run(&pool).await.unwrap();
    sqlx::raw_sql(
        r#"
        INSERT INTO catalog.categories(id,name,slug)
          VALUES(md5('entity-category')::uuid,'Identifier category','identifier-category');
        INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id)
          VALUES(md5('entity-product')::uuid,'ENTITY-1','identifier-product','Identifier product','Original facts',10,'USD','ea',md5('entity-category')::uuid);
        INSERT INTO customers.customers(id,email,primary_identifier,password_hash)
          VALUES(md5('entity-customer')::uuid,'entity@test.local','email','!');
        INSERT INTO customers.customer_locations(id,customer_id,label,latitude,longitude,formatted_address)
          VALUES(md5('entity-location')::uuid,md5('entity-customer')::uuid,'home',30,31,'Original address');
        INSERT INTO cart_checkout.carts(id,customer_id)
          VALUES(md5('entity-cart')::uuid,md5('entity-customer')::uuid);
        INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id)
          VALUES(md5('entity-admin')::uuid,'entity-admin@test.local','Identifier admin','!','00000000-0000-0000-0000-000000000001');
        INSERT INTO theme.themes(id,name,owner_channel,configuration,created_by)
          VALUES(md5('entity-theme')::uuid,'Identifier theme','storefront','{}',md5('entity-admin')::uuid);
        INSERT INTO theme.versions(id,theme_id,number,configuration,created_by)
          VALUES(md5('entity-theme-version')::uuid,md5('entity-theme')::uuid,1,'{}',md5('entity-admin')::uuid);
        UPDATE theme.themes SET published_version=md5('entity-theme-version')::uuid WHERE id=md5('entity-theme')::uuid;
        INSERT INTO cart_checkout.market_drafts(id,name,country,currency,locales,default_locale)
          VALUES(md5('entity-market')::uuid,'Identifier market','US','USD',ARRAY['en','ar'],'en');
        INSERT INTO cart_checkout.market_releases(id,market_id,name,country,currency,source_locale,draft_revision,created_by)
          VALUES(md5('entity-market-release')::uuid,md5('entity-market')::uuid,'Identifier market','US','USD','en',1,md5('entity-admin')::uuid);
        INSERT INTO cart_checkout.market_overrides(market_id,entity_type,entity_id,price)
          VALUES(md5('entity-market')::uuid,'product',md5('entity-product')::uuid,11);
        INSERT INTO cart_checkout.market_release_overrides(release_id,entity_type,entity_id,price)
          VALUES(md5('entity-market-release')::uuid,'product',md5('entity-product')::uuid,12.34);
        UPDATE cart_checkout.active_market SET release_id=md5('entity-market-release')::uuid;
        INSERT INTO admin_iam.audit_log(id,action,entity_id,details)
          VALUES(md5('entity-audit')::uuid,'Identifier test',md5('entity-product')::uuid,'{}');
        INSERT INTO cms.storefront_languages(locale,name,native_name,direction)
          VALUES('ar','Arabic','Arabic','rtl');
        INSERT INTO cms.catalog_translations(locale,entity_type,entity_id,source,fields,updated_by)
          VALUES('ar','product',md5('entity-product')::uuid,'{}','{}',md5('entity-admin')::uuid);
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let before = business_facts(&pool).await;
    let references_before = reference_facts(&pool).await;
    let before_view: Value = sqlx::query_scalar(
        "SELECT to_jsonb(p) FROM catalog.storefront_products p WHERE sku='ENTITY-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let view_columns_before: Vec<String> = sqlx::query_scalar(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='catalog' AND table_name='storefront_products' ORDER BY ordinal_position",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    // Verify this additive migration in isolation. Later migrations may add
    // legitimate business columns (for example stocks.is_global), which are
    // not part of the identifier migration's no-other-facts-changed guarantee.
    let mut identifiers = sqlx::migrate!("../../migrations");
    identifiers
        .migrations
        .to_mut()
        .retain(|migration| migration.version <= ENTITY_ID_MIGRATION);
    identifiers.run(&pool).await.unwrap();
    identifiers.run(&pool).await.unwrap();
    assert_identifier_schema(&pool).await;
    assert_eq!(before, business_facts(&pool).await);
    assert_eq!(references_before, reference_facts(&pool).await);
    let after_view: Value = sqlx::query_scalar(
        "SELECT to_jsonb(p)-'entity_id' FROM catalog.storefront_products p WHERE sku='ENTITY-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(before_view, after_view);
    let view_columns_after: Vec<String> = sqlx::query_scalar(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='catalog' AND table_name='storefront_products' ORDER BY ordinal_position",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let mut expected_columns = view_columns_before;
    expected_columns.push("entity_id".to_owned());
    assert_eq!(expected_columns, view_columns_after);
    let projection_matches: bool = sqlx::query_scalar(
        "SELECT (SELECT p.entity_id=v.entity_id FROM catalog.products p JOIN catalog.storefront_products v USING(id) WHERE p.sku='ENTITY-1') AND (SELECT c.entity_id=v.entity_id FROM catalog.categories c JOIN catalog.storefront_categories v USING(id) WHERE c.slug='identifier-category')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(projection_matches);
    let first_id: i64 =
        sqlx::query_scalar("SELECT entity_id FROM catalog.products WHERE sku='ENTITY-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    let next_id: i64 = sqlx::query_scalar(
        "INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) VALUES(md5('entity-product-2')::uuid,'ENTITY-2','identifier-product-2','Next identifier product','New facts',10,'USD','ea',md5('entity-category')::uuid) RETURNING entity_id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(next_id > first_id);
    assert_sqlstate(
        sqlx::query("UPDATE catalog.products SET entity_id=DEFAULT WHERE sku='ENTITY-1'")
            .execute(&pool)
            .await
            .unwrap_err(),
        "23514",
    );
    assert_sqlstate(
        sqlx::query("INSERT INTO catalog.categories(id,name,slug,entity_id) VALUES(md5('entity-explicit')::uuid,'Explicit','entity-explicit',1)")
            .execute(&pool).await.unwrap_err(),
        "428C9",
    );
    let category_id: i64 = sqlx::query_scalar(
        "SELECT entity_id FROM catalog.categories WHERE slug='identifier-category'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_sqlstate(
        sqlx::query("INSERT INTO catalog.categories(id,name,slug,entity_id) OVERRIDING SYSTEM VALUE VALUES(md5('entity-duplicate')::uuid,'Duplicate','entity-duplicate',$1)")
            .bind(category_id).execute(&pool).await.unwrap_err(),
        "23505",
    );
    for invalid in [0, MAX_ENTITY_ID + 1] {
        assert_sqlstate(
            sqlx::query("INSERT INTO catalog.categories(id,name,slug,entity_id) OVERRIDING SYSTEM VALUE VALUES(md5('entity-invalid')::uuid,'Invalid','entity-invalid',$1)")
                .bind(invalid).execute(&pool).await.unwrap_err(),
            "23514",
        );
    }
    let retained_id: i64 =
        sqlx::query_scalar("SELECT entity_id FROM catalog.products WHERE sku='ENTITY-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(retained_id, first_id);

    // The sequence must stop instead of emitting a value JavaScript rounds or
    // wrapping back to identifiers which previously belonged to other records.
    sqlx::query("SELECT setval(pg_get_serial_sequence('catalog.categories','entity_id'),$1,false)")
        .bind(MAX_ENTITY_ID)
        .execute(&pool)
        .await
        .unwrap();
    let last_id: i64 = sqlx::query_scalar("INSERT INTO catalog.categories(id,name,slug) VALUES(md5('entity-last')::uuid,'Last safe identifier','entity-last') RETURNING entity_id")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(last_id, MAX_ENTITY_ID);
    assert_sqlstate(
        sqlx::query("INSERT INTO catalog.categories(id,name,slug) VALUES(md5('entity-exhausted')::uuid,'Exhausted','entity-exhausted')")
            .execute(&pool).await.unwrap_err(),
        "2200H",
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn fresh_install_uses_bounded_identifiers_and_keeps_reference_columns_uuid(pool: PgPool) {
    assert_identifier_schema(&pool).await;
}
