//! Aggregate completed-order units; never expose customer or order identities.
use chrono::{DateTime, Utc};
use infra_auth::Result;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection, PgPool};
use uuid::Uuid;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Period {
    Today,
    LastWeek,
    LastMonth,
    LastYear,
}

#[derive(FromRow)]
pub struct RankedProduct {
    pub product_id: Uuid,
    pub units: i64,
}

pub struct Ranking {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub products: Vec<RankedProduct>,
    pub scope: Scope,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    DeliveryArea,
    Global,
}

pub async fn rank(pool: &PgPool, period: Period, now: DateTime<Utc>) -> Result<Ranking> {
    rank_for_area(pool, period, now, None).await
}

/// Prefer completed sales from the shopper's delivery area. Missing location or
/// no local sales of current products falls back to the store-wide ranking.
pub async fn rank_for_area(
    pool: &PgPool,
    period: Period,
    now: DateTime<Utc>,
    area: Option<Uuid>,
) -> Result<Ranking> {
    let mut db = pool.acquire().await?;
    Ok(rank_on_for_area(&mut db, period, now, area).await?)
}

/// Share the same ranking inside an anonymous page snapshot transaction.
pub async fn rank_on(
    db: &mut PgConnection,
    period: Period,
    now: DateTime<Utc>,
) -> std::result::Result<Ranking, sqlx::Error> {
    rank_on_for_area(db, period, now, None).await
}

pub async fn rank_on_for_area(
    db: &mut PgConnection,
    period: Period,
    now: DateTime<Utc>,
    area: Option<Uuid>,
) -> std::result::Result<Ranking, sqlx::Error> {
    let (unit, previous) = match period {
        Period::Today => ("day", false),
        Period::LastWeek => ("week", true),
        Period::LastMonth => ("month", true),
        Period::LastYear => ("year", true),
    };
    let (start, end): (DateTime<Utc>, DateTime<Utc>) = sqlx::query_as(
        "SELECT (date_trunc($1, $2::timestamptz AT TIME ZONE 'UTC') - CASE WHEN $3 THEN ('1 ' || $1)::interval ELSE interval '0' END) AT TIME ZONE 'UTC', CASE WHEN $3 THEN date_trunc($1, $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' ELSE $2::timestamptz END"
    ).bind(unit).bind(now).bind(previous).fetch_one(&mut *db).await?;
    if let Some(area) = area {
        // Match the immutable checkout area, rather than a customer's current
        // address. Filter hidden products before deciding whether to fall back.
        let products: Vec<RankedProduct> = sqlx::query_as(include_str!("bestsellers_local.sql"))
            .bind(start)
            .bind(end)
            .bind(area.to_string())
            .fetch_all(&mut *db)
            .await?;
        if !products.is_empty() {
            return Ok(Ranking {
                start,
                end,
                products,
                scope: Scope::DeliveryArea,
            });
        }
    }
    let products = sqlx::query_as(
        "SELECT i.product_id, SUM(i.quantity)::bigint AS units FROM orders.order_items i JOIN orders.orders o ON o.id=i.order_id WHERE o.created_at >= $1 AND o.created_at < $2 AND o.status IN ('delivered','cash_collected') GROUP BY i.product_id ORDER BY units DESC,i.product_id ASC LIMIT 50"
    ).bind(start).bind(end).fetch_all(&mut *db).await?;
    Ok(Ranking {
        start,
        end,
        products,
        scope: Scope::Global,
    })
}
