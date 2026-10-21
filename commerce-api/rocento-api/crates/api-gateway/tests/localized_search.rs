//! Reviewed copy admission and durable index invalidation use the production catalog reader.
use domain_catalog::{CatalogReader, CategoryInput, ProductInput, Service};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrations = "../../migrations")]
async fn localized_search_copy_requires_current_review_and_refreshes_on_deletion(pool: PgPool) {
    let actor = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'search-reviewer@example.test','Search reviewer','unused',$2)")
        .bind(actor).bind(domain_admin_iam::SUPER).execute(&pool).await.unwrap();
    sqlx::query("UPDATE cms.language_settings SET source_locale='en'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO cms.storefront_languages(locale,name,native_name,direction) VALUES('ar','Arabic','العربية','rtl')").execute(&pool).await.unwrap();
    let catalog = Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            CategoryInput {
                name: "Tea".into(),
                slug: "tea".into(),
                parent_id: None,
            },
        )
        .await
        .unwrap();
    let input = |name: &str| -> ProductInput {
        serde_json::from_value(json!({
        "sku":"TEA-1","slug":"tea","name":name,"description":"Loose leaf tea","price":"10.00",
        "currency":"EGP","unit":"each","category_id":category.id,"attributes":{},"media_ids":[],"active":true,"in_stock":true
    })).unwrap()
    };
    let product = catalog
        .save_product(None, input("Green tea"))
        .await
        .unwrap();
    sqlx::query("INSERT INTO cms.catalog_translations(locale,entity_type,entity_id,source,fields,reviewed,updated_by) SELECT 'ar','product',entity_id,source,$2,false,$3 FROM cms.translation_sources WHERE entity_type='product' AND entity_id=$1")
        .bind(product.id).bind(json!({"name":"شاي أخضر","description":"أوراق شاي"})).bind(actor).execute(&pool).await.unwrap();
    assert!(catalog
        .search_translations("product", &[product.id])
        .await
        .unwrap()
        .is_empty());
    sqlx::query("UPDATE cms.catalog_translations SET reviewed=true WHERE entity_id=$1")
        .bind(product.id)
        .execute(&pool)
        .await
        .unwrap();
    let copy = catalog
        .search_translations("product", &[product.id])
        .await
        .unwrap();
    assert_eq!(copy.len(), 1);
    assert_eq!(copy[0].fields["name"], "شاي أخضر");

    catalog
        .save_product(Some(product.id), input("New green tea"))
        .await
        .unwrap();
    assert!(catalog
        .search_translations("product", &[product.id])
        .await
        .unwrap()
        .is_empty());
    sqlx::query("UPDATE cms.catalog_translations t SET source=s.source FROM cms.translation_sources s WHERE t.entity_type=s.entity_type AND t.entity_id=s.entity_id AND t.entity_id=$1")
        .bind(product.id).execute(&pool).await.unwrap();
    assert_eq!(
        catalog
            .search_translations("product", &[product.id])
            .await
            .unwrap()
            .len(),
        1
    );
    let event_count = || {
        sqlx::query_scalar::<_,i64>("SELECT count(*) FROM platform.outbox WHERE event_type='catalog.product_translation_updated' AND payload->>'id'=$1").bind(product.id.to_string())
    };
    let before = event_count().fetch_one(&pool).await.unwrap();
    sqlx::query(
        "DELETE FROM cms.catalog_translations WHERE entity_type='product' AND entity_id=$1",
    )
    .bind(product.id)
    .execute(&pool)
    .await
    .unwrap();
    assert!(catalog
        .search_translations("product", &[product.id])
        .await
        .unwrap()
        .is_empty());
    assert_eq!(event_count().fetch_one(&pool).await.unwrap(), before + 1);
}
