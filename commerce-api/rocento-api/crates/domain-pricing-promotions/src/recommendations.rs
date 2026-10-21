//! Read-only single-unit catalog offers; never infer a discount from a low price.
use crate::{AssessmentContext, Line};
use infra_auth::Result;
use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

#[derive(FromRow)]
struct Candidate {
    id: Uuid,
    sku: String,
    category_id: Option<Uuid>,
    price: Decimal,
    currency: String,
    attributes: serde_json::Value,
}
#[derive(Serialize)]
pub struct Offer {
    pub product_id: Uuid,
    pub currency: String,
    #[serde(with = "rust_decimal::serde::str")]
    pub original_price: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub discounted_price: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub savings: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub discount_percent: Decimal,
}

pub async fn rank(pool: &PgPool, customer: Option<Uuid>) -> Result<Vec<Offer>> {
    rank_selected(pool, customer, None).await
}

/// Evaluate only the visible page using authoritative prices and the same policy as checkout.
pub async fn for_products(
    pool: &PgPool,
    customer: Option<Uuid>,
    ids: &[Uuid],
) -> Result<Vec<Offer>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    rank_selected(pool, customer, Some(ids)).await
}

async fn rank_selected(
    pool: &PgPool,
    customer: Option<Uuid>,
    ids: Option<&[Uuid]>,
) -> Result<Vec<Offer>> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let context = AssessmentContext::load(&mut tx, customer).await?;
    let mut after: Option<Uuid> = None;
    let mut offers = Vec::new();
    loop {
        let candidates: Vec<Candidate> = sqlx::query_as("SELECT p.id,p.sku,p.category_id,p.price,p.currency,p.attributes FROM catalog.storefront_products p WHERE ($1::uuid IS NULL OR p.id>$1) AND ($2::uuid[] IS NULL OR p.id=ANY($2)) AND p.active AND p.price>0 AND (p.parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.storefront_products parent WHERE parent.id=p.parent_id AND parent.active)) AND EXISTS(SELECT 1 FROM pricing_promotions.rules r WHERE r.active AND r.scope='catalog' AND (r.starts_at IS NULL OR r.starts_at<=CURRENT_TIMESTAMP) AND (r.ends_at IS NULL OR r.ends_at>CURRENT_TIMESTAMP) AND (cardinality(r.skus)=0 OR p.sku=ANY(r.skus)) AND (cardinality(r.category_ids)=0 OR p.category_id=ANY(r.category_ids))) ORDER BY p.id LIMIT 200").bind(after).bind(ids).fetch_all(&mut *tx).await?;
        if candidates.is_empty() {
            break;
        }
        after = candidates.last().map(|p| p.id);
        for p in candidates {
            let result = context.assess(
                &[Line {
                    product_id: p.id,
                    sku: p.sku,
                    category_id: p.category_id,
                    price: p.price,
                    quantity: 1,
                }],
                &std::collections::HashMap::from([(p.id, p.attributes)]),
                None,
            );
            let savings: Decimal = result.lines[0]
                .iter()
                .filter(|r| r.scope == "catalog")
                .map(|r| r.amount)
                .sum();
            if savings > Decimal::ZERO {
                offers.push(Offer {
                    product_id: p.id,
                    currency: p.currency,
                    original_price: p.price,
                    discounted_price: p.price - savings,
                    savings,
                    discount_percent: savings / p.price * Decimal::from(100),
                });
            }
        }
    }
    offers.sort_by(|a, b| {
        b.discount_percent
            .cmp(&a.discount_percent)
            .then(a.product_id.cmp(&b.product_id))
    });
    tx.commit().await?;
    Ok(offers)
}
