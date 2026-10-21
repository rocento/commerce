//! Simple SKU catalog. All writes serialize tree/definition validation and commit an outbox event.
mod visibility;
use infra_auth::{Error, Result};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use tracing::Instrument;
use uuid::Uuid;

#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
}
#[derive(Clone, Debug, Serialize, Deserialize, FromRow)]
pub struct Category {
    pub id: Uuid,
    pub entity_id: i64,
    pub name: String,
    pub slug: String,
    pub parent_id: Option<Uuid>,
    pub thumbnail: Option<String>,
    pub banner: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CategoryInput {
    pub name: String,
    pub slug: String,
    pub parent_id: Option<Uuid>,
}
#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct Attribute {
    pub id: Uuid,
    pub entity_id: i64,
    pub code: String,
    pub name: String,
    pub kind: String,
    pub required: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttributeInput {
    pub code: String,
    pub name: String,
    pub kind: String,
    pub required: bool,
}
#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct Media {
    pub id: Uuid,
    pub entity_id: i64,
    pub content_type: String,
    pub alt: String,
    pub object_key: String,
    pub size_bytes: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize, FromRow)]
pub struct Product {
    #[serde(default = "simple_type")]
    pub product_type: String,
    #[serde(default)]
    pub parent_id: Option<Uuid>,
    #[serde(default = "empty_attributes")]
    pub variant_attributes: Value,
    #[serde(default)]
    pub attribute_set_id: Option<Uuid>,
    pub id: Uuid,
    // Older search documents predate numeric identity; HTTP projections refresh it from SQL.
    #[serde(default, skip_serializing_if = "missing_entity_id")]
    pub entity_id: i64,
    pub sku: String,
    pub slug: String,
    pub name: String,
    pub description: String,
    #[serde(with = "rust_decimal::serde::str")]
    pub price: Decimal,
    pub currency: String,
    pub unit: String,
    pub category_id: Uuid,
    #[serde(default, alias = "assigned_category_ids")]
    #[sqlx(default)]
    pub category_ids: Vec<Uuid>,
    pub attributes: Value,
    pub media_ids: Vec<Uuid>,
    pub active: bool,
    pub in_stock: bool,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProductInput {
    pub sku: String,
    pub slug: String,
    pub name: String,
    pub description: String,
    #[serde(with = "rust_decimal::serde::str")]
    pub price: Decimal,
    pub currency: String,
    pub unit: String,
    pub category_id: Uuid,
    #[serde(default)]
    pub category_ids: Option<Vec<Uuid>>,
    #[serde(default)]
    pub attribute_set_id: Option<Uuid>,
    pub attributes: Value,
    pub media_ids: Vec<Uuid>,
    pub active: bool,
    pub in_stock: bool,
}
fn missing_entity_id(value: &i64) -> bool {
    *value == 0
}
fn simple_type() -> String {
    "simple".into()
}
fn empty_attributes() -> Value {
    json!({})
}
pub mod media_library;
pub mod types;
pub fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn text(value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > max {
        return Err(invalid("Text is empty or too long"));
    }
    Ok(())
}
fn slug(value: &str) -> Result<()> {
    text(value, 120)?;
    if !value
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(invalid(
            "Use lowercase letters, numbers and hyphens for slugs/codes",
        ));
    }
    Ok(())
}
pub fn validate_attributes(value: &Value, definitions: &[Attribute]) -> Result<()> {
    let values = value
        .as_object()
        .ok_or_else(|| invalid("Attributes must be an object"))?;
    if values.len() > 100 {
        return Err(invalid("Too many attributes"));
    }
    for (key, value) in values {
        let def = definitions
            .iter()
            .find(|a| a.code == *key)
            .ok_or_else(|| invalid("Unknown attribute code"))?;
        let valid = match def.kind.as_str() {
            "text" => value
                .as_str()
                .is_some_and(|s| s.len() <= 2000 && (!def.required || !s.trim().is_empty())),
            "number" => value.is_number(),
            "boolean" => value.is_boolean(),
            _ => false,
        };
        if !valid {
            return Err(invalid(&format!("Invalid value for attribute {key}")));
        }
    }
    for def in definitions.iter().filter(|a| a.required) {
        if !values.contains_key(&def.code) {
            return Err(invalid(&format!("Missing required attribute {}", def.code)));
        }
    }
    Ok(())
}
impl Service {
    async fn transaction(&self) -> Result<Transaction<'_, Postgres>> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(2002)")
            .execute(&mut *tx)
            .await?;
        Ok(tx)
    }
    async fn changed(tx: &mut Transaction<'_, Postgres>, event: &str, id: Uuid) -> Result<()> {
        infra_events::record(tx, event, json!({"id":id})).await?;
        Ok(())
    }
    pub async fn category(&self, id: Uuid) -> Result<Category> {
        sqlx::query_as("SELECT *, attributes->>'thumbnail' AS thumbnail, attributes->>'banner' AS banner FROM catalog.categories WHERE id=$1")
            .bind(id).fetch_optional(&self.pool).await?.ok_or(Error::NotFound)
    }
    pub async fn categories(&self) -> Result<Vec<Category>> {
        Ok(
            sqlx::query_as("SELECT *, attributes->>'thumbnail' AS thumbnail, attributes->>'banner' AS banner FROM catalog.categories ORDER BY name,id")
                .fetch_all(&self.pool)
                .await?,
        )
    }
    pub async fn attributes(&self) -> Result<Vec<Attribute>> {
        Ok(
            sqlx::query_as("SELECT * FROM catalog.attributes ORDER BY name,id")
                .fetch_all(&self.pool)
                .await?,
        )
    }
    pub async fn media(&self) -> Result<Vec<Media>> {
        Ok(sqlx::query_as("SELECT id,entity_id,content_type,alt,object_key,size_bytes FROM catalog.media ORDER BY created_at DESC LIMIT 500").fetch_all(&self.pool).await?)
    }
    pub async fn media_by_id(&self, id: Uuid) -> Result<Media> {
        sqlx::query_as(
            "SELECT id,entity_id,content_type,alt,object_key,size_bytes FROM catalog.media WHERE id=$1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(Error::NotFound)
    }
    pub async fn products(&self, offset: i64) -> Result<Vec<Product>> {
        Ok(sqlx::query_as(
            "SELECT * FROM catalog.products ORDER BY updated_at DESC,id LIMIT 50 OFFSET $1",
        )
        .bind(offset)
        .fetch_all(&self.pool)
        .await?)
    }
    #[tracing::instrument(skip_all, name = "catalog.product")]
    pub async fn product(&self, id: Uuid) -> Result<Product> {
        sqlx::query_as("SELECT * FROM catalog.products WHERE id=$1")
            .bind(id)
            .fetch_optional(&self.pool)
            .instrument(tracing::info_span!(
                "db.query",
                db.system = "postgresql",
                db.operation.name = "SELECT",
                db.collection.name = "catalog.products"
            ))
            .await?
            .ok_or(Error::NotFound)
    }
    /// Shopper projection; administration always reads the source catalog.
    pub async fn storefront_product(&self, id: Uuid) -> Result<Product> {
        sqlx::query_as("SELECT * FROM catalog.storefront_products WHERE id=$1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(Error::NotFound)
    }
    pub async fn storefront_categories(&self) -> Result<Vec<Category>> {
        Ok(sqlx::query_as("SELECT *, attributes->>'thumbnail' AS thumbnail, attributes->>'banner' AS banner FROM catalog.storefront_categories ORDER BY name,id").fetch_all(&self.pool).await?)
    }
    pub async fn save_category(&self, id: Option<Uuid>, input: CategoryInput) -> Result<Category> {
        text(&input.name, 120)?;
        if input.slug.len() > 400 {
            return Err(invalid("Slug is too long"));
        }
        let mut tx = self.transaction().await?;
        let actual = id.unwrap_or_else(Uuid::new_v4);
        if let Some(parent) = input.parent_id {
            let mut next = Some(parent);
            let mut ancestors = std::collections::HashSet::new();
            while let Some(current) = next {
                if current == actual || !ancestors.insert(current) {
                    return Err(invalid("Category hierarchy would create a cycle"));
                }
                next = sqlx::query_scalar::<_, Option<Uuid>>(
                    "SELECT parent_id FROM catalog.categories WHERE id=$1",
                )
                .bind(current)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| invalid("Parent category does not exist"))?;
            }
        }
        let row = if id.is_some() {
            sqlx::query_as("UPDATE catalog.categories SET name=$2,slug=$3,parent_id=$4 WHERE id=$1 RETURNING *, attributes->>'thumbnail' AS thumbnail, attributes->>'banner' AS banner").bind(actual).bind(input.name).bind(input.slug).bind(input.parent_id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?
        } else {
            sqlx::query_as("INSERT INTO catalog.categories(id,name,slug,parent_id) VALUES($1,$2,$3,$4) RETURNING *, attributes->>'thumbnail' AS thumbnail, attributes->>'banner' AS banner").bind(actual).bind(input.name).bind(input.slug).bind(input.parent_id).fetch_one(&mut *tx).await?
        };
        // Only this category and its descendants need reindexing.
        Self::changed(&mut tx, "catalog.category_updated", actual).await?;
        tx.commit().await?;
        Ok(row)
    }
    pub async fn delete_category(&self, id: Uuid) -> Result<()> {
        let mut tx = self.transaction().await?;
        if sqlx::query("DELETE FROM catalog.categories WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?
            .rows_affected()
            == 0
        {
            return Err(Error::NotFound);
        }
        Self::changed(&mut tx, "catalog.category_deleted", id).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn save_attribute(
        &self,
        id: Option<Uuid>,
        input: AttributeInput,
    ) -> Result<Attribute> {
        slug(&input.code)?;
        text(&input.name, 120)?;
        if !["text", "number", "boolean"].contains(&input.kind.as_str()) {
            return Err(invalid("Invalid attribute kind"));
        }
        let mut tx = self.transaction().await?;
        let clash:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attributes.definitions WHERE entity_type='product' AND attribute_code=$1)").bind(&input.code).fetch_one(&mut *tx).await?;
        if clash {
            return Err(invalid("This code belongs to a typed attribute"));
        }
        let actual = id.unwrap_or_else(Uuid::new_v4);
        if let Some(id) = id {
            let old: Attribute = sqlx::query_as("SELECT * FROM catalog.attributes WHERE id=$1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(Error::NotFound)?;
            let used: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM catalog.products WHERE attributes ? $1)",
            )
            .bind(&old.code)
            .fetch_one(&mut *tx)
            .await?;
            if used && (old.code != input.code || old.kind != input.kind) {
                return Err(invalid(
                    "Cannot change code/type while products use this attribute",
                ));
            }
        }
        let row:Attribute=sqlx::query_as("INSERT INTO catalog.attributes(id,code,name,kind,required) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET code=$2,name=$3,kind=$4,required=$5 RETURNING *").bind(actual).bind(input.code).bind(input.name).bind(input.kind).bind(input.required).fetch_one(&mut *tx).await?;
        // A required definition must remain valid for every existing product.
        if row.required {
            let values: Vec<Value> = sqlx::query_scalar("SELECT attributes FROM catalog.products")
                .fetch_all(&mut *tx)
                .await?;
            for values in values {
                let mut selected = serde_json::Map::new();
                if let Some(v) = values.get(&row.code) {
                    selected.insert(row.code.clone(), v.clone());
                }
                validate_attributes(&Value::Object(selected), std::slice::from_ref(&row))?;
            }
        }
        Self::changed(&mut tx, "catalog.attribute_updated", actual).await?;
        tx.commit().await?;
        Ok(row)
    }
    pub async fn delete_attribute(&self, id: Uuid) -> Result<()> {
        let mut tx = self.transaction().await?;
        let code: String = sqlx::query_scalar("SELECT code FROM catalog.attributes WHERE id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::NotFound)?;
        let used: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM catalog.products WHERE attributes ? $1)",
        )
        .bind(code)
        .fetch_one(&mut *tx)
        .await?;
        if used {
            return Err(Error::Conflict);
        }
        sqlx::query("DELETE FROM catalog.attributes WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        Self::changed(&mut tx, "catalog.attribute_deleted", id).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn save_product(&self, id: Option<Uuid>, input: ProductInput) -> Result<Product> {
        let mut tx = self.transaction().await?;
        let row = Self::save_product_in(&mut tx, id, input).await?;
        tx.commit().await?;
        Ok(row)
    }
    /// Caller holds catalog advisory lock 2002, after inventory 3003 when both are needed.
    pub async fn save_product_in(
        tx: &mut Transaction<'_, Postgres>,
        id: Option<Uuid>,
        mut input: ProductInput,
    ) -> Result<Product> {
        text(&input.name, 200)?;
        text(&input.sku, 80)?;
        if input.slug.len() > 400 {
            return Err(invalid("Slug is too long"));
        }
        if input.description.len() > 10000
            || input.price.is_sign_negative()
            || input.price > Decimal::from(9999999999u64)
            || input.price.scale() > 2
            || !["USD", "EGP"].contains(&input.currency.as_str())
            || !["each", "lb", "kg", "oz", "pack", "L"].contains(&input.unit.as_str())
            || input.media_ids.len() > 10
        {
            return Err(invalid(
                "Invalid price, currency, unit, description or media count",
            ));
        }
        let definitions = sqlx::query_as("SELECT * FROM catalog.attributes")
            .fetch_all(&mut **tx)
            .await?;
        let actual = id.unwrap_or_else(Uuid::new_v4);
        let modern = domain_attributes::definitions(tx, "product").await?;
        if id.is_none() {
            let members: Vec<Uuid> = if let Some(set) = input.attribute_set_id {
                sqlx::query_scalar(
                    "SELECT definition_id FROM attributes.set_members WHERE set_id=$1",
                )
                .bind(set)
                .fetch_all(&mut **tx)
                .await?
            } else {
                modern.iter().map(|d| d.id).collect()
            };
            let values = input
                .attributes
                .as_object_mut()
                .ok_or_else(|| invalid("Attributes must be an object"))?;
            for definition in &modern {
                if definition.metadata.active() && members.contains(&definition.id) {
                    if let Some(value) = &definition.metadata.default_value {
                        values
                            .entry(definition.attribute_code.clone())
                            .or_insert_with(|| value.clone());
                    }
                }
            }
        }
        let mut legacy = input
            .attributes
            .as_object()
            .ok_or_else(|| invalid("Attributes must be an object"))?
            .clone();
        for d in modern {
            legacy.remove(&d.attribute_code);
        }
        validate_attributes(&Value::Object(legacy), &definitions)?;
        domain_attributes::validate_set(tx, input.attribute_set_id, &input.attributes).await?;
        domain_attributes::validate_product(tx, actual, &input.attributes, input.attribute_set_id)
            .await?;
        // A linked variant's option tuple can only change through the structure editor.
        if id.is_some() {
            let tuple: Value =
                sqlx::query_scalar("SELECT variant_attributes FROM catalog.products WHERE id=$1")
                    .bind(actual)
                    .fetch_optional(&mut **tx)
                    .await?
                    .unwrap_or(json!({}));
            if tuple
                .as_object()
                .is_some_and(|v| v.iter().any(|(k, v)| input.attributes.get(k) != Some(v)))
            {
                return Err(invalid(
                    "Variant option values must match the parent configuration",
                ));
            }
        }
        for media in &input.media_ids {
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.media WHERE id=$1)")
                    .bind(media)
                    .fetch_one(&mut **tx)
                    .await?;
            if !exists {
                return Err(invalid("Media does not exist"));
            }
        }
        if id.is_some() {
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.products WHERE id=$1)")
                    .bind(actual)
                    .fetch_one(&mut **tx)
                    .await?;
            if !exists {
                return Err(Error::NotFound);
            }
        }
        let previous: Option<Value> =
            sqlx::query_scalar("SELECT attributes FROM catalog.products WHERE id=$1")
                .bind(actual)
                .fetch_optional(&mut **tx)
                .await?;
        let mut category_ids = match input.category_ids.take() {
            Some(ids) => ids,
            None => sqlx::query_scalar::<_, Vec<Uuid>>(
                "SELECT category_ids FROM catalog.products WHERE id=$1",
            )
            .bind(actual)
            .fetch_optional(&mut **tx)
            .await?
            .unwrap_or_default(),
        };
        category_ids.push(input.category_id);
        category_ids.sort();
        category_ids.dedup();
        if category_ids.len() > 50 {
            return Err(invalid("A product may have at most 50 categories"));
        }
        let existing: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM catalog.categories WHERE id=ANY($1) ORDER BY id FOR KEY SHARE",
        )
        .bind(&category_ids)
        .fetch_all(&mut **tx)
        .await?;
        if existing != category_ids {
            return Err(invalid("One or more categories do not exist"));
        }
        let incoming_attributes = input.attributes.clone();
        let row=sqlx::query_as("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,attribute_set_id,attributes,media_ids,active,in_stock,category_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(id) DO UPDATE SET sku=$2,slug=$3,name=$4,description=$5,price=$6,currency=$7,unit=$8,category_id=$9,attribute_set_id=$10,attributes=$11,media_ids=$12,active=$13,in_stock=$14,category_ids=$15,updated_at=now() RETURNING *")
   .bind(actual).bind(input.sku).bind(input.slug).bind(input.name).bind(input.description).bind(input.price).bind(input.currency).bind(input.unit).bind(input.category_id).bind(input.attribute_set_id).bind(input.attributes).bind(input.media_ids).bind(input.active).bind(input.in_stock).bind(category_ids).fetch_one(&mut **tx).await?;
        domain_attributes::enrichment::record_merchant(
            tx,
            actual,
            previous.as_ref(),
            &incoming_attributes,
        )
        .await?;
        Self::changed(tx, "catalog.product_updated", actual).await?;
        Ok(row)
    }
    pub async fn delete_product(&self, id: Uuid) -> Result<()> {
        let mut tx = self.transaction().await?;
        if sqlx::query("DELETE FROM catalog.products WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?
            .rows_affected()
            == 0
        {
            return Err(Error::NotFound);
        }
        Self::changed(&mut tx, "catalog.product_updated", id).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn add_media(&self, media: Media) -> Result<Media> {
        text(&media.alt, 300)?;
        let mut tx = self.transaction().await?;
        let media: Media = sqlx::query_as("INSERT INTO catalog.media(id,content_type,alt,object_key,size_bytes) VALUES($1,$2,$3,$4,$5) RETURNING id,entity_id,content_type,alt,object_key,size_bytes").bind(media.id).bind(&media.content_type).bind(&media.alt).bind(&media.object_key).bind(media.size_bytes).fetch_one(&mut *tx).await?;
        Self::changed(&mut tx, "catalog.media_created", media.id).await?;
        tx.commit().await?;
        Ok(media)
    }
    pub async fn update_media(&self, id: Uuid, alt: String) -> Result<Media> {
        text(&alt, 300)?;
        let mut tx = self.transaction().await?;
        let media=sqlx::query_as("UPDATE catalog.media SET alt=$2 WHERE id=$1 RETURNING id,entity_id,content_type,alt,object_key,size_bytes").bind(id).bind(alt).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
        Self::changed(&mut tx, "catalog.media_updated", id).await?;
        tx.commit().await?;
        Ok(media)
    }
    pub async fn delete_media(&self, id: Uuid) -> Result<Media> {
        let mut tx = self.transaction().await?;
        let used: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM catalog.products WHERE $1=ANY(media_ids)) OR EXISTS(SELECT 1 FROM catalog.products p, attributes.definitions d WHERE d.entity_type='product' AND d.input_type='media_image' AND p.attributes->>d.attribute_code=$1::text) OR EXISTS(SELECT 1 FROM catalog.categories p, attributes.definitions d WHERE d.entity_type='category' AND d.input_type='media_image' AND p.attributes->>d.attribute_code=$1::text) OR EXISTS(SELECT 1 FROM customers.customers p, attributes.definitions d WHERE d.entity_type='customer' AND d.input_type='media_image' AND p.attributes->>d.attribute_code=$1::text)",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        if used {
            return Err(Error::Conflict);
        }
        let media=sqlx::query_as("DELETE FROM catalog.media WHERE id=$1 RETURNING id,entity_id,content_type,alt,object_key,size_bytes").bind(id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
        Self::changed(&mut tx, "catalog.media_deleted", id).await?;
        tx.commit().await?;
        Ok(media)
    }
}

/// Read contract used by other domains; catalog table access stays within this crate.
pub use domain_attributes::Definition;
#[derive(Clone, Debug, FromRow)]
pub struct SearchTranslation {
    pub entity_id: Uuid,
    pub fields: Value,
}
pub trait CatalogReader: Send + Sync {
    /// Reviewed, current copy only; stable commerce/filter values stay in the source catalog.
    fn search_translations(
        &self,
        _entity_type: &str,
        _ids: &[Uuid],
    ) -> impl std::future::Future<Output = Result<Vec<SearchTranslation>>> + Send {
        async { Ok(vec![]) }
    }
    fn children(
        &self,
        _id: Uuid,
    ) -> impl std::future::Future<Output = Result<Vec<Product>>> + Send {
        async { Ok(vec![]) }
    }

    fn definitions(&self) -> impl std::future::Future<Output = Result<Vec<Definition>>> + Send {
        async { Ok(vec![]) }
    }

    fn product(&self, id: Uuid) -> impl std::future::Future<Output = Result<Product>> + Send;
    fn categories(&self) -> impl std::future::Future<Output = Result<Vec<Category>>> + Send;
    fn products(
        &self,
        offset: i64,
    ) -> impl std::future::Future<Output = Result<Vec<Product>>> + Send;
}
impl CatalogReader for Service {
    async fn search_translations(
        &self,
        entity_type: &str,
        ids: &[Uuid],
    ) -> Result<Vec<SearchTranslation>> {
        Ok(sqlx::query_as("SELECT t.entity_id,t.fields FROM cms.catalog_translations t JOIN cms.translation_sources s ON s.entity_type=t.entity_type AND s.entity_id=t.entity_id JOIN cms.storefront_languages l ON l.locale=t.locale JOIN cms.language_settings settings ON settings.singleton WHERE t.entity_type=$1 AND t.entity_id=ANY($2) AND t.locale<>settings.source_locale AND t.reviewed AND t.source=s.source ORDER BY t.entity_id,t.locale")
            .bind(entity_type).bind(ids).fetch_all(&self.pool).await?)
    }
    async fn children(&self, id: Uuid) -> Result<Vec<Product>> {
        Ok(sqlx::query_as("SELECT p.* FROM catalog.storefront_products p JOIN catalog.product_links l ON l.child_id=p.id WHERE l.parent_id=$1 AND p.active ORDER BY l.position").bind(id).fetch_all(&self.pool).await?)
    }

    async fn definitions(&self) -> Result<Vec<Definition>> {
        domain_attributes::Service {
            pool: self.pool.clone(),
        }
        .list("product")
        .await
    }

    async fn product(&self, id: Uuid) -> Result<Product> {
        Service::storefront_product(self, id).await
    }
    async fn categories(&self) -> Result<Vec<Category>> {
        Service::storefront_categories(self).await
    }
    async fn products(&self, offset: i64) -> Result<Vec<Product>> {
        Ok(sqlx::query_as("SELECT * FROM catalog.storefront_products ORDER BY updated_at DESC,id LIMIT 50 OFFSET $1").bind(offset).fetch_all(&self.pool).await?)
    }
}

impl Service {
    /// Hold the catalog write boundary while a checkout validates current product data.
    pub async fn checkout_product(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        id: Uuid,
    ) -> Result<Product> {
        sqlx::query("SELECT pg_advisory_xact_lock_shared(2002)")
            .execute(&mut **tx)
            .await?;
        sqlx::query_as("SELECT * FROM catalog.storefront_products WHERE id=$1 AND active=true AND product_type='simple' AND (parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.storefront_products p WHERE p.id=catalog.storefront_products.parent_id AND p.active))")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or(Error::NotFound)
    }
}

impl Service {
    pub async fn index_page(&self, category: Option<Uuid>, after: Uuid) -> Result<Vec<Product>> {
        Ok(sqlx::query_as("WITH RECURSIVE tree AS (SELECT id FROM catalog.categories WHERE id=$1 UNION ALL SELECT c.id FROM catalog.categories c JOIN tree t ON c.parent_id=t.id) SELECT * FROM catalog.storefront_products WHERE id>$2 AND ($1::uuid IS NULL OR category_ids && ARRAY(SELECT id FROM tree)) ORDER BY id LIMIT 200").bind(category).bind(after).fetch_all(&self.pool).await?)
    }
    pub async fn visible_attributes(&self, p: &mut Product) -> Result<()> {
        let defs = domain_attributes::Service {
            pool: self.pool.clone(),
        }
        .list("product")
        .await?;
        if let Some(values) = p.attributes.as_object_mut() {
            for d in defs {
                if !d.metadata.active() || (!d.is_visible_on_front && !d.used_for_configurations) {
                    values.remove(&d.attribute_code);
                }
            }
        }
        Ok(())
    }
}

pub mod public;

pub mod relationships;
