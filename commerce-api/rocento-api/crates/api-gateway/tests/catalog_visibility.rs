use domain_catalog::Service;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrations = "../../migrations")]
async fn published_visibility_requires_active_product_and_parent(pool: PgPool) {
    let catalog = Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            serde_json::from_value(json!({
                "name":"Visibility", "slug":"visibility", "parent_id":null
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let mut ids = Vec::new();
    for name in ["parent", "child", "standalone"] {
        let product = catalog
            .save_product(
                None,
                serde_json::from_value(json!({
                    "name":name, "sku":name, "slug":name, "description":"Fixture",
                    "category_id":category.id, "price":"1", "currency":"USD", "unit":"each",
                    "active":true, "in_stock":true, "attributes":{}, "media_ids":[]
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        ids.push(product.id);
    }
    let (parent, child, standalone) = (ids[0], ids[1], ids[2]);
    sqlx::query("UPDATE catalog.products SET parent_id=$1 WHERE id=$2")
        .bind(parent)
        .bind(child)
        .execute(&pool)
        .await
        .unwrap();
    assert!(catalog.storefront_visible(child).await.unwrap());
    assert!(catalog.storefront_visible(standalone).await.unwrap());
    assert!(!catalog.storefront_visible(Uuid::new_v4()).await.unwrap());
    sqlx::query("UPDATE catalog.products SET active=false WHERE id=$1")
        .bind(parent)
        .execute(&pool)
        .await
        .unwrap();
    assert!(!catalog.storefront_visible(child).await.unwrap());
    assert!(!catalog.storefront_visible(parent).await.unwrap());
    assert!(catalog.storefront_visible(standalone).await.unwrap());
    sqlx::query("UPDATE catalog.products SET active=true WHERE id=$1")
        .bind(parent)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE catalog.products SET active=false WHERE id=$1")
        .bind(child)
        .execute(&pool)
        .await
        .unwrap();
    assert!(!catalog.storefront_visible(child).await.unwrap());
}
