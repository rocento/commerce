//! Fresh, bounded inventory reads independent of the expiry worker's backlog.
use crate::{invalid, Service, Tx};
use infra_auth::Result;
use std::collections::HashMap;
use uuid::Uuid;

// Restrict aggregation to the requested products before joining source items.
// An expired allocation may still exist until cleanup, but cannot reduce stock.
const LIVE_SOURCES: &str = r#"
WITH held AS (
 SELECT a.source_id,a.product_id,SUM(a.quantity)::bigint reserved
 FROM inventory.reservation_allocations a
 JOIN inventory.reservations r USING(cart_id,product_id)
 WHERE a.product_id=ANY($1) AND r.expires_at>clock_timestamp()
 GROUP BY a.source_id,a.product_id
), live_sources AS (
 SELECT i.source_id,i.product_id,
  GREATEST(0,i.quantity-COALESCE(h.reserved,0))::bigint available
 FROM inventory.source_items i
 JOIN inventory.inventory_sources s ON s.id=i.source_id AND s.is_enabled
 LEFT JOIN held h ON h.source_id=i.source_id AND h.product_id=i.product_id
 WHERE i.product_id=ANY($1) AND i.status='in_stock'
)
"#;

// A source linked to two stocks in the same area contributes once.
const AREA_SOURCE: &str = r#"
EXISTS (
 SELECT 1 FROM inventory.source_stock_links s
 JOIN inventory.area_stock_links l ON l.stock_id=s.stock_id
 JOIN inventory.delivery_areas d ON d.id=l.area_id AND d.is_active
 WHERE l.area_id=$2 AND s.source_id=a.source_id
)
"#;

fn area_query(many: bool) -> String {
    if many {
        format!(
            "{LIVE_SOURCES} SELECT a.product_id,COALESCE(SUM(a.available),0)::bigint \
             FROM live_sources a WHERE {AREA_SOURCE} GROUP BY a.product_id"
        )
    } else {
        format!(
            "{LIVE_SOURCES} SELECT COALESCE(SUM(a.available),0)::bigint \
             FROM live_sources a WHERE {AREA_SOURCE}"
        )
    }
}

impl Service {
    /// Worldwide delivery draws from default and global pools. A shared source
    /// contributes once, and current reservations are subtracted at read time.
    pub async fn global_available_many_in(
        tx: &mut Tx<'_>,
        ids: &[Uuid],
    ) -> Result<HashMap<Uuid, i64>> {
        if ids.len() > 20 {
            return Err(invalid("At most 20 stock candidates"));
        }
        let query = format!(
            "{LIVE_SOURCES} SELECT a.product_id,SUM(a.available)::bigint FROM live_sources a WHERE EXISTS(SELECT 1 FROM inventory.source_stock_links l JOIN inventory.stocks st ON st.id=l.stock_id WHERE l.source_id=a.source_id AND (st.is_global OR st.is_default)) GROUP BY a.product_id"
        );
        Ok(sqlx::query_as::<_, (Uuid, i64)>(&query)
            .bind(ids)
            .fetch_all(&mut **tx)
            .await?
            .into_iter()
            .collect())
    }
    /// Global pools are visible at every pin; local pools are visible in their
    /// area, or through the default pool when browsing without a delivery pin.
    /// This scope is for catalog reads and does not grant delivery eligibility.
    pub async fn browsing_stocks(
        &self,
        area: Option<Uuid>,
        include_default: bool,
    ) -> Result<Vec<Uuid>> {
        Ok(sqlx::query_scalar("SELECT s.id FROM inventory.stocks s WHERE s.is_global OR ($2 AND s.is_default) OR EXISTS(SELECT 1 FROM inventory.area_stock_links l JOIN inventory.delivery_areas d ON d.id=l.area_id AND d.is_active WHERE l.stock_id=s.id AND l.area_id=$1) ORDER BY s.id")
            .bind(area).bind(include_default).fetch_all(&self.pool).await?)
    }

    /// Live holds, disabled sources, and out-of-stock assignments are respected.
    /// EXISTS counts a physical source once even when several pools share it.
    pub async fn browsing_available_many(
        &self,
        ids: &[Uuid],
        stocks: &[Uuid],
        area: Option<Uuid>,
    ) -> Result<HashMap<Uuid, i64>> {
        if ids.len() > 20 {
            return Err(invalid("At most 20 stock candidates"));
        }
        if ids.is_empty() || stocks.is_empty() {
            return Ok(HashMap::new());
        }
        let query = format!(
            "{LIVE_SOURCES} SELECT a.product_id,SUM(a.available)::bigint FROM live_sources a WHERE EXISTS(SELECT 1 FROM inventory.source_stock_links l WHERE l.source_id=a.source_id AND l.stock_id=ANY($2) AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM inventory.stocks st WHERE st.id=l.stock_id AND st.is_global) OR EXISTS(SELECT 1 FROM inventory.area_stock_links al JOIN inventory.delivery_areas d ON d.id=al.area_id AND d.is_active WHERE al.stock_id=l.stock_id AND al.area_id=$3))) GROUP BY a.product_id"
        );
        Ok(sqlx::query_as::<_, (Uuid, i64)>(&query)
            .bind(ids)
            .bind(stocks)
            .bind(area)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .collect())
    }

    /// Bounded, fresh availability using the caller's transaction rather than a
    /// second pool connection. `None` selects the default stock, as in
    /// `available_many`; configured carts without an area must use zero instead.
    pub async fn available_many_in(
        tx: &mut Tx<'_>,
        ids: &[Uuid],
        area: Option<Uuid>,
    ) -> Result<HashMap<Uuid, i64>> {
        if ids.len() > 20 {
            return Err(invalid("At most 20 stock candidates"));
        }
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<(Uuid, i64)> = if let Some(area) = area {
            sqlx::query_as(&area_query(true))
                .bind(ids)
                .bind(area)
                .fetch_all(&mut **tx)
                .await?
        } else {
            sqlx::query_as(
                "SELECT i.id,COALESCE(s.on_hand,0)::bigint-COALESCE(r.reserved,0)::bigint \
                 FROM unnest($1::uuid[]) i(id) \
                 LEFT JOIN inventory.stock s ON s.product_id=i.id \
                 LEFT JOIN (SELECT product_id,SUM(quantity) reserved \
                  FROM inventory.reservations WHERE product_id=ANY($1) \
                   AND expires_at>clock_timestamp() GROUP BY product_id) r \
                  ON r.product_id=i.id",
            )
            .bind(ids)
            .fetch_all(&mut **tx)
            .await?
        };
        Ok(rows.into_iter().collect())
    }

    pub async fn area_available(&self, area: Uuid, product: Uuid) -> Result<i64> {
        let available = self.area_available_many(&[product], area).await?;
        Ok(available.get(&product).copied().unwrap_or(0))
    }

    /// Resolve availability within the caller's transaction, including read-only
    /// cart snapshots. A missing or inactive area has no deliverable inventory.
    pub async fn area_available_in(
        tx: &mut Tx<'_>,
        area: Option<Uuid>,
        product: Uuid,
    ) -> Result<i64> {
        if area.is_none() {
            return Ok(0);
        }
        let products = [product];
        Ok(sqlx::query_scalar(&area_query(false))
            .bind(&products[..])
            .bind(area)
            .fetch_one(&mut **tx)
            .await?)
    }

    pub(crate) async fn area_available_many(
        &self,
        ids: &[Uuid],
        area: Uuid,
    ) -> Result<HashMap<Uuid, i64>> {
        if ids.len() > 20 {
            return Err(invalid("At most 20 stock candidates"));
        }
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<(Uuid, i64)> = sqlx::query_as(&area_query(true))
            .bind(ids)
            .bind(area)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().collect())
    }

    pub async fn available_stocks(&self, product: Uuid) -> Result<Vec<Uuid>> {
        let products = [product];
        let query = format!(
            "{LIVE_SOURCES} SELECT l.stock_id FROM live_sources a \
             JOIN inventory.source_stock_links l USING(source_id) \
             GROUP BY l.stock_id HAVING SUM(a.available)>0 ORDER BY l.stock_id"
        );
        Ok(sqlx::query_scalar(&query)
            .bind(&products[..])
            .fetch_all(&self.pool)
            .await?)
    }
}
