//! Anonymous publication projections. Never serialize the administrative Product model.
use serde::Serialize;
use serde_json::Value;
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

#[derive(Serialize, FromRow)]
pub struct Category {
    pub parent_id: Option<Uuid>,
    pub id: Uuid,
    pub entity_id: i64,
    pub slug: String,
    pub name: String,
    pub description: String,
    pub thumbnail: Option<Uuid>,
}
#[derive(Serialize, FromRow)]
pub struct Product {
    pub sku: String,
    pub parent_id: Option<Uuid>,
    #[sqlx(skip)]
    pub offer_eligible: bool,
    #[sqlx(skip)]
    pub price_diagnostic: String,
    pub id: Uuid,
    pub entity_id: i64,
    pub slug: String,
    pub name: String,
    pub description: String,
    pub price: String,
    #[sqlx(skip)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_price: Option<String>,
    pub product_type: String,
    pub currency: String,
    pub unit: String,
    pub category_id: Uuid,
    pub image_id: Option<Uuid>,
    pub image_alt: Option<String>,
    pub attributes: Value,
}
const PRODUCT: &str = "SELECT p.sku,p.parent_id,p.id,p.entity_id,p.slug,p.name,p.description,p.price::text AS price,p.product_type,p.currency,p.unit,p.category_id,m.id AS image_id,m.alt AS image_alt,COALESCE((SELECT jsonb_object_agg(d.label,p.attributes->d.attribute_code) FROM attributes.definitions d WHERE d.entity_type='product' AND (d.is_visible_on_front OR d.used_for_configurations) AND COALESCE(d.metadata->>'status','active')='active' AND d.input_type NOT IN ('media_image','file') AND NOT EXISTS(SELECT 1 FROM attributes.value_provenance provenance WHERE provenance.product_id=p.id AND provenance.definition_id=d.id AND provenance.source IN ('AI_INFERRED','DERIVED')) AND p.attributes ? d.attribute_code AND jsonb_typeof(p.attributes->d.attribute_code) IN ('string','number','boolean')), '{}'::jsonb) AS attributes FROM catalog.storefront_products p LEFT JOIN catalog.media m ON m.id=p.media_ids[1] AND m.content_type LIKE 'image/%' WHERE p.active AND (p.parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.storefront_products parent WHERE parent.id=p.parent_id AND parent.active))";

pub async fn categories(db: &mut PgConnection) -> Result<Vec<Category>, sqlx::Error> {
    sqlx::query_as("SELECT c.parent_id,c.id,c.entity_id,c.slug,c.name,COALESCE(c.attributes->>'description','') AS description,m.id AS thumbnail FROM catalog.storefront_categories c LEFT JOIN catalog.media m ON m.id::text=c.attributes->>'thumbnail' AND m.content_type LIKE 'image/%' ORDER BY c.name,c.id")
        .fetch_all(db).await
}
pub async fn product(db: &mut PgConnection, key: &str) -> Result<Option<Product>, sqlx::Error> {
    // Separate predicates retain UUID precedence without casting every catalog row.
    if let Ok(id) = key.parse::<Uuid>() {
        let found = sqlx::query_as(&format!("{PRODUCT} AND p.id=$1 LIMIT 1"))
            .bind(id)
            .fetch_optional(&mut *db)
            .await?;
        if found.is_some() {
            return Ok(found);
        }
    }
    sqlx::query_as(&format!("{PRODUCT} AND p.slug=$1 LIMIT 1"))
        .bind(key)
        .fetch_optional(db)
        .await
}
pub async fn products(
    db: &mut PgConnection,
    category: Option<Uuid>,
    page: u32,
) -> Result<Vec<Product>, sqlx::Error> {
    sqlx::query_as(&format!("{PRODUCT} AND p.parent_id IS NULL AND ($1::uuid IS NULL OR p.category_ids @> ARRAY[$1::uuid]) ORDER BY p.name,p.id LIMIT 25 OFFSET $2"))
        .bind(category).bind(i64::from(page - 1) * 24).fetch_all(db).await
}

/// Bounded anonymous theme collection, evaluated inside the page transaction.
pub async fn collection(
    db: &mut PgConnection,
    category: Option<Uuid>,
    query: &str,
    limit: i64,
) -> Result<Vec<Product>, sqlx::Error> {
    sqlx::query_as(&format!("{PRODUCT} AND p.parent_id IS NULL AND ($1::uuid IS NULL OR p.category_ids @> ARRAY[$1::uuid]) AND ($2='' OR position(lower($2) in lower(p.name || ' ' || p.description)) > 0) ORDER BY p.name,p.id LIMIT $3"))
        .bind(category).bind(query).bind(limit.clamp(1,24)).fetch_all(db).await
}

/// Bounded actual family links. The same active-parent visibility predicate applies.
pub async fn family(db: &mut PgConnection, id: Uuid) -> Result<Vec<Product>, sqlx::Error> {
    sqlx::query_as(&format!("{PRODUCT} AND EXISTS(SELECT 1 FROM catalog.product_links l WHERE l.parent_id=$1 AND l.child_id=p.id) ORDER BY p.name,p.id LIMIT 100")).bind(id).fetch_all(db).await
}
