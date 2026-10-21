//! Atomic merchandising batches, CSV round trips and per-admin saved catalog filters.
pub mod csv_cells;
use csv_cells::{escape, unescape};
use domain_catalog::{Product, ProductInput, Service as Catalog};
use infra_auth::{Error, Result};
use rust_decimal::{Decimal, RoundingStrategy};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;
#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
}
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(deny_unknown_fields)]
pub struct Filter {
    #[serde(default)]
    pub q: String,
    pub category_id: Option<Uuid>,
    pub active: Option<bool>,
    #[serde(default)]
    pub offset: i64,
}
#[derive(Serialize)]
pub struct Page {
    pub items: Vec<Product>,
    pub total: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bulk {
    pub ids: Vec<Uuid>,
    pub category_id: Option<Uuid>,
    pub active: Option<bool>,
    pub price_adjustment_pct: Option<String>,
    pub reason: String,
}
#[derive(Serialize)]
pub struct Batch {
    pub count: usize,
    pub operation_id: Uuid,
    pub preview: bool,
    pub skus: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Import {
    pub csv: String,
    pub preview: bool,
    pub reason: String,
}
#[derive(Serialize, FromRow)]
pub struct SavedFilter {
    pub id: Uuid,
    pub admin_id: Uuid,
    pub name: String,
    pub filters: Value,
}
fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn valid_filter(f: &Filter) -> Result<()> {
    if f.q.len() > 200 || !(0..=1000000).contains(&f.offset) {
        return Err(invalid("Invalid search or offset"));
    }
    Ok(())
}
fn reason(s: &str) -> Result<()> {
    if s.trim().is_empty() || s.len() > 300 {
        return Err(invalid("Enter a reason (up to 300 characters)"));
    }
    Ok(())
}
fn input(p: Product) -> ProductInput {
    ProductInput {
        sku: p.sku,
        slug: p.slug,
        name: p.name,
        description: p.description,
        price: p.price,
        currency: p.currency,
        unit: p.unit,
        category_id: p.category_id,
        category_ids: Some(p.category_ids),
        attribute_set_id: p.attribute_set_id,
        attributes: p.attributes,
        media_ids: p.media_ids,
        active: p.active,
        in_stock: p.in_stock,
    }
}
async fn lock(pool: &PgPool) -> Result<domain_inventory::Tx<'_>> {
    let mut tx = domain_inventory::begin(pool).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(2002)")
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}
async fn filtered(
    tx: &mut domain_inventory::Tx<'_>,
    f: &Filter,
    limit: i64,
    offset: i64,
) -> Result<Vec<Product>> {
    Ok(sqlx::query_as("SELECT * FROM catalog.products WHERE ($1='' OR strpos(lower(name),lower($1))>0 OR strpos(lower(sku),lower($1))>0) AND ($2::uuid IS NULL OR category_ids @> ARRAY[$2::uuid]) AND ($3::boolean IS NULL OR active=$3) ORDER BY sku,id LIMIT $4 OFFSET $5").bind(&f.q).bind(f.category_id).bind(f.active).bind(limit).bind(offset).fetch_all(&mut **tx).await?)
}
impl Service {
    pub async fn products(&self, f: Filter) -> Result<Page> {
        valid_filter(&f)?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            .execute(&mut *tx)
            .await?;
        let total=sqlx::query_scalar("SELECT count(*) FROM catalog.products WHERE ($1='' OR strpos(lower(name),lower($1))>0 OR strpos(lower(sku),lower($1))>0) AND ($2::uuid IS NULL OR category_ids @> ARRAY[$2::uuid]) AND ($3::boolean IS NULL OR active=$3)").bind(&f.q).bind(f.category_id).bind(f.active).fetch_one(&mut *tx).await?;
        let items = filtered(&mut tx, &f, 100, f.offset).await?;
        tx.commit().await?;
        Ok(Page { items, total })
    }
    pub async fn ids(&self, f: Filter) -> Result<Vec<Uuid>> {
        valid_filter(&f)?;
        let mut tx = self.pool.begin().await?;
        let rows = filtered(&mut tx, &f, 501, 0).await?;
        if rows.len() > 500 {
            return Err(invalid(
                "Narrow your filters to at most 500 products before selecting all",
            ));
        }
        Ok(rows.into_iter().map(|p| p.id).collect())
    }
    pub async fn bulk(&self, mut i: Bulk, who: &domain_admin_iam::Identity) -> Result<Batch> {
        who.require("catalog.bulk")?;
        reason(&i.reason)?;
        i.ids.sort();
        i.ids.dedup();
        if i.ids.is_empty()
            || i.ids.len() > 500
            || (i.category_id.is_none() && i.active.is_none() && i.price_adjustment_pct.is_none())
        {
            return Err(invalid("Select 1–500 products and at least one change"));
        }
        let pct: Option<Decimal> = i
            .price_adjustment_pct
            .as_ref()
            .map(|v| v.parse().map_err(|_| invalid("Invalid percentage")))
            .transpose()?;
        if pct.is_some_and(|v| v < Decimal::from(-100) || v > Decimal::from(1000) || v.scale() > 2)
        {
            return Err(invalid(
                "Price adjustment must be −100 to 1000 percent, up to two decimal places",
            ));
        }
        let mut tx = lock(&self.pool).await?;
        let mut changes = vec![];
        let mut skus = vec![];
        for id in &i.ids {
            let before: Product = sqlx::query_as("SELECT * FROM catalog.products WHERE id=$1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(Error::NotFound)?;
            let mut p = input(before.clone());
            if let Some(c) = i.category_id {
                p.category_id = c;
            }
            if let Some(a) = i.active {
                p.active = a;
            }
            if let Some(pct) = pct {
                p.price = (p.price * (Decimal::ONE + pct / Decimal::from(100)))
                    .round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero);
            }
            let after = Catalog::save_product_in(&mut tx, Some(*id), p).await?;
            skus.push(after.sku.clone());
            changes.push(json!({"id":id,"before":{"category_id":before.category_id,"price":before.price.to_string(),"active":before.active},"after":{"category_id":after.category_id,"price":after.price.to_string(),"active":after.active}}));
        }
        let id = Uuid::new_v4();
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "admin.catalog.bulk_updated",
            id,
            json!({"reason":i.reason,"count":i.ids.len(),"changes":changes}),
        )
        .await?;
        tx.commit().await?;
        Ok(Batch {
            count: i.ids.len(),
            operation_id: id,
            preview: false,
            skus,
        })
    }
    pub async fn export(
        &self,
        kind: &str,
        f: Filter,
        who: &domain_admin_iam::Identity,
    ) -> Result<String> {
        who.require(if kind == "catalog" {
            "catalog.export"
        } else {
            "inventory.export"
        })?;
        valid_filter(&f)?;
        let mut tx = lock(&self.pool).await?;
        let rows = filtered(&mut tx, &f, 501, 0).await?;
        if rows.len() > 500 {
            return Err(invalid(
                "Narrow the filter to at most 500 products per CSV export",
            ));
        }
        let mut w = csv::WriterBuilder::new().from_writer(vec![]);
        let headers = if kind == "catalog" {
            vec![
                "sku",
                "slug",
                "name",
                "description",
                "price",
                "currency",
                "unit",
                "category_id",
                "attributes",
                "media_ids",
                "active",
            ]
        } else {
            vec!["sku", "on_hand", "reason"]
        };
        w.write_record(headers).map_err(|_| Error::Internal)?;
        for p in rows {
            let cells = if kind == "catalog" {
                vec![
                    p.sku,
                    p.slug,
                    p.name,
                    p.description,
                    p.price.to_string(),
                    p.currency,
                    p.unit,
                    p.category_id.to_string(),
                    p.attributes.to_string(),
                    json!(p.media_ids).to_string(),
                    p.active.to_string(),
                ]
            } else {
                let stock = domain_inventory::Service::stock_in(&mut tx, p.id).await?;
                vec![p.sku, stock.on_hand.to_string(), "CSV stock update".into()]
            };
            w.write_record(cells.iter().map(|s| escape(s)))
                .map_err(|_| Error::Internal)?;
        }
        String::from_utf8(w.into_inner().map_err(|_| Error::Internal)?).map_err(|_| Error::Internal)
    }
    pub async fn import(
        &self,
        kind: &str,
        i: Import,
        who: &domain_admin_iam::Identity,
    ) -> Result<Batch> {
        who.require(if kind == "catalog" {
            "catalog.import"
        } else {
            "inventory.import"
        })?;
        reason(&i.reason)?;
        if i.csv.len() > 2 * 1024 * 1024 {
            return Err(invalid("CSV must be at most 2 MB"));
        }
        let expected = if kind == "catalog" {
            vec![
                "sku",
                "slug",
                "name",
                "description",
                "price",
                "currency",
                "unit",
                "category_id",
                "attributes",
                "media_ids",
                "active",
            ]
        } else {
            vec!["sku", "on_hand", "reason"]
        };
        let mut reader =
            csv::ReaderBuilder::new().from_reader(i.csv.trim_start_matches('\u{feff}').as_bytes());
        let h = reader
            .headers()
            .map_err(|_| invalid("Invalid CSV header"))?
            .clone();
        if h.iter().collect::<Vec<_>>() != expected {
            return Err(invalid(&format!(
                "CSV headers must be: {}",
                expected.join(",")
            )));
        }
        let mut rows = vec![];
        let mut seen = std::collections::HashSet::new();
        for (n, row) in reader.records().enumerate() {
            let r = row.map_err(|_| invalid(&format!("Invalid CSV at row {}", n + 2)))?;
            let values: Vec<String> = r.iter().map(unescape).collect();
            if rows.len() >= 500 || !seen.insert(values[0].clone()) {
                return Err(invalid("Use at most 500 rows, each with a unique SKU"));
            }
            rows.push(values);
        }
        if rows.is_empty() {
            return Err(invalid("CSV has no data rows"));
        }
        let mut tx = lock(&self.pool).await?;
        let mut changes = vec![];
        let mut skus = vec![];
        for (n, r) in rows.iter().enumerate() {
            let before: Option<Product> =
                sqlx::query_as("SELECT * FROM catalog.products WHERE sku=$1")
                    .bind(&r[0])
                    .fetch_optional(&mut *tx)
                    .await?;
            let err = || invalid(&format!("Invalid values in CSV row {} ({})", n + 2, r[0]));
            if kind == "catalog" {
                let p = ProductInput {
                    sku: r[0].clone(),
                    slug: r[1].clone(),
                    name: r[2].clone(),
                    description: r[3].clone(),
                    price: r[4].parse().map_err(|_| err())?,
                    currency: r[5].clone(),
                    unit: r[6].clone(),
                    category_id: r[7].parse().map_err(|_| err())?,
                    category_ids: None,
                    attribute_set_id: before.as_ref().and_then(|p| p.attribute_set_id),
                    attributes: serde_json::from_str(&r[8]).map_err(|_| err())?,
                    media_ids: serde_json::from_str(&r[9]).map_err(|_| err())?,
                    active: r[10].parse().map_err(|_| err())?,
                    in_stock: before.as_ref().is_some_and(|p| p.in_stock),
                };
                let after =
                    Catalog::save_product_in(&mut tx, before.as_ref().map(|p| p.id), p).await?;
                changes.push(json!({"before":before,"after":after}));
            } else {
                let p = before.ok_or_else(err)?;
                let old = domain_inventory::Service::stock_in(&mut tx, p.id).await?;
                let stock = domain_inventory::Service::adjust_in(
                    &mut tx,
                    p.id,
                    r[1].parse().map_err(|_| err())?,
                    who.user.id,
                    r[2].clone(),
                )
                .await?;
                changes.push(json!({"product_id":p.id,"before":old,"after":stock}));
            }
            skus.push(r[0].clone());
        }
        let id = Uuid::new_v4();
        if i.preview {
            tx.rollback().await?;
        } else {
            domain_admin_iam::Service::audit(
                &mut tx,
                Some(who.user.id),
                &format!("admin.{kind}.csv_imported"),
                id,
                json!({"reason":i.reason,"count":rows.len(),"changes":changes}),
            )
            .await?;
            tx.commit().await?;
        }
        Ok(Batch {
            count: rows.len(),
            operation_id: id,
            preview: i.preview,
            skus,
        })
    }
    pub async fn filters(&self, owner: Uuid) -> Result<Vec<SavedFilter>> {
        Ok(
            sqlx::query_as("SELECT * FROM admin_iam.saved_filters WHERE admin_id=$1 ORDER BY name")
                .bind(owner)
                .fetch_all(&self.pool)
                .await?,
        )
    }
    pub async fn save_filter(&self, owner: Uuid, name: &str, mut f: Filter) -> Result<SavedFilter> {
        valid_filter(&f)?;
        if name.trim().is_empty() || name.len() > 100 {
            return Err(invalid("Name your saved filter (up to 100 characters)"));
        }
        f.offset = 0;
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(7009)")
            .execute(&mut *tx)
            .await?;
        let n: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM admin_iam.saved_filters WHERE admin_id=$1 AND name<>$2",
        )
        .bind(owner)
        .bind(name.trim())
        .fetch_one(&mut *tx)
        .await?;
        if n >= 20 {
            return Err(invalid("At most 20 saved filters per admin"));
        }
        let r=sqlx::query_as("INSERT INTO admin_iam.saved_filters(id,admin_id,name,filters) VALUES($1,$2,$3,$4) ON CONFLICT(admin_id,name) DO UPDATE SET filters=$4 RETURNING *").bind(Uuid::new_v4()).bind(owner).bind(name.trim()).bind(json!(f)).fetch_one(&mut *tx).await?;
        tx.commit().await?;
        Ok(r)
    }
    pub async fn delete_filter(&self, owner: Uuid, id: Uuid) -> Result<()> {
        sqlx::query("DELETE FROM admin_iam.saved_filters WHERE id=$1 AND admin_id=$2")
            .bind(id)
            .bind(owner)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}
