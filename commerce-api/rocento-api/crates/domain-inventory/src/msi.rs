//! Physical source management and deterministic allocation under the inventory transaction lock.
use super::*;

pub const DEFAULT_SOURCE: Uuid = Uuid::from_u128(1);
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Source {
    pub entity_id: i64,
    pub id: Uuid,
    pub code: String,
    pub name: String,
    pub is_enabled: bool,
    pub address: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub contact_name: String,
    pub contact_phone: String,
    pub priority: i32,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceInput {
    pub code: String,
    pub name: String,
    pub is_enabled: bool,
    pub address: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub contact_name: String,
    pub contact_phone: String,
    pub priority: i32,
}
#[derive(Serialize, Deserialize, FromRow)]
pub struct SourceLink {
    pub source_id: Uuid,
    pub priority: i32,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StockInput {
    pub code: String,
    pub name: String,
    pub is_default: bool,
    #[serde(default)]
    pub is_global: bool,
    pub sources: Vec<SourceLink>,
}
#[derive(Serialize, Deserialize)]
pub struct StockPool {
    pub entity_id: i64,
    pub id: Uuid,
    pub code: String,
    pub name: String,
    pub is_default: bool,
    #[serde(default)]
    pub is_global: bool,
    pub sources: Vec<SourceLink>,
}
#[derive(Serialize, FromRow)]
pub struct SourceItem {
    /// Distinguishes an unassigned source from an assigned, sold-out source.
    pub is_assigned: bool,
    pub source_id: Uuid,
    pub name: String,
    pub product_id: Uuid,
    pub quantity: i32,
    pub status: String,
    pub notify_stock_qty: i32,
    pub reserved: i64,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceItemInput {
    pub source_id: Uuid,
    pub quantity: i32,
    pub status: String,
    pub notify_stock_qty: i32,
    pub reason: String,
}
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, FromRow)]
pub struct SourceAllocation {
    pub source_id: Uuid,
    pub quantity: i32,
}
#[derive(Debug, FromRow)]
pub struct Candidate {
    pub source_id: Uuid,
    pub priority: i32,
    pub available: i64,
}
/// Candidates are read in the same transaction as the reservation write.
/// A future zone-aware implementation can filter this list before selecting.
pub trait SourceSelectionAlgorithm {
    fn select(&self, candidates: Vec<Candidate>, quantity: i32) -> Result<Vec<SourceAllocation>>;
}
/// Only candidates resolved from the delivery area may enter this algorithm.
pub struct ZoneAware;
impl SourceSelectionAlgorithm for ZoneAware {
    fn select(&self, candidates: Vec<Candidate>, quantity: i32) -> Result<Vec<SourceAllocation>> {
        PriorityDeduction.select(candidates, quantity)
    }
}
pub struct PriorityDeduction;
impl SourceSelectionAlgorithm for PriorityDeduction {
    fn select(
        &self,
        mut candidates: Vec<Candidate>,
        quantity: i32,
    ) -> Result<Vec<SourceAllocation>> {
        if quantity < 0 {
            return Err(invalid("Invalid quantity"));
        }
        candidates.sort_by_key(|c| (c.priority, c.source_id));
        let mut remaining = quantity;
        let mut allocations = Vec::new();
        for c in candidates {
            let take = c.available.max(0).min(i64::from(remaining)) as i32;
            if take > 0 {
                allocations.push(SourceAllocation {
                    source_id: c.source_id,
                    quantity: take,
                });
                remaining -= take;
            }
            if remaining == 0 {
                break;
            }
        }
        if remaining > 0 {
            return Err(invalid("Insufficient available source stock"));
        }
        Ok(allocations)
    }
}
fn names(code: &str, name: &str) -> Result<()> {
    if code.is_empty()
        || code.len() > 64
        || !code
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        || name.trim().is_empty()
        || name.len() > 100
    {
        return Err(invalid(
            "Code must be 1–64 letters, digits, hyphens or underscores; name must be 1–100 characters",
        ));
    }
    Ok(())
}
impl Service {
    pub async fn sources(&self) -> Result<Vec<Source>> {
        Ok(
            sqlx::query_as("SELECT * FROM inventory.inventory_sources ORDER BY priority,code")
                .fetch_all(&self.pool)
                .await?,
        )
    }
    async fn refresh_sources(tx: &mut Tx<'_>) -> Result<()> {
        sqlx::query("SELECT inventory.refresh_stock()")
            .execute(&mut **tx)
            .await?;
        let ids: Vec<Uuid> =
            sqlx::query_scalar("SELECT product_id FROM inventory.stock ORDER BY product_id")
                .fetch_all(&mut **tx)
                .await?;
        for id in ids {
            changed(tx, id).await?;
        }
        Ok(())
    }
    pub async fn save_source(
        &self,
        id: Option<Uuid>,
        i: SourceInput,
        actor: Uuid,
    ) -> Result<Source> {
        names(&i.code, &i.name)?;
        if i.address.len() > 500
            || i.contact_name.len() > 100
            || i.contact_phone.len() > 100
            || i.latitude.is_some() != i.longitude.is_some()
            || i.latitude
                .is_some_and(|x| !x.is_finite() || !(-90.0..=90.0).contains(&x))
            || i.longitude
                .is_some_and(|x| !x.is_finite() || !(-180.0..=180.0).contains(&x))
        {
            return Err(invalid("Invalid source address, contact or coordinates"));
        }
        let mut tx = begin(&self.pool).await?;
        if let Some(id) = id {
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM inventory.inventory_sources WHERE id=$1)",
            )
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
            if !exists {
                return Err(Error::NotFound);
            }
            if !i.is_enabled {
                let held: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM inventory.reservation_allocations a JOIN inventory.reservations r USING(cart_id,product_id) WHERE a.source_id=$1 AND r.expires_at>clock_timestamp())").bind(id).fetch_one(&mut *tx).await?;
                if held {
                    return Err(invalid(
                        "Source has active reservations; release or wait for them before disabling",
                    ));
                }
            }
        }
        let id = id.unwrap_or_else(Uuid::new_v4);
        let result=sqlx::query_as("INSERT INTO inventory.inventory_sources(id,code,name,is_enabled,address,latitude,longitude,contact_name,contact_phone,priority) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET code=$2,name=$3,is_enabled=$4,address=$5,latitude=$6,longitude=$7,contact_name=$8,contact_phone=$9,priority=$10 RETURNING *")
            .bind(id).bind(&i.code).bind(i.name.trim()).bind(i.is_enabled).bind(&i.address).bind(i.latitude).bind(i.longitude).bind(&i.contact_name).bind(&i.contact_phone).bind(i.priority).fetch_one(&mut *tx).await?;
        infra_events::record(
            &mut tx,
            "inventory.source_saved",
            json!({"id":id,"actor_id":actor}),
        )
        .await?;
        Self::refresh_sources(&mut tx).await?;
        tx.commit().await?;
        Ok(result)
    }
    pub async fn delete_source(&self, id: Uuid, actor: Uuid) -> Result<()> {
        let mut tx = begin(&self.pool).await?;
        if id == DEFAULT_SOURCE {
            return Err(invalid("The migrated default source cannot be deleted"));
        }
        // Physical allocation references remain protected until expiry cleanup.
        let used:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM inventory.source_items WHERE source_id=$1 AND quantity>0) OR EXISTS(SELECT 1 FROM inventory.reservation_allocations WHERE source_id=$1) OR EXISTS(SELECT 1 FROM inventory.order_allocations WHERE source_id=$1) OR EXISTS(SELECT 1 FROM inventory.adjustments WHERE source_id=$1)").bind(id).fetch_one(&mut *tx).await?;
        if used {
            return Err(invalid("Source has stock or history; disable it instead"));
        }
        sqlx::query("DELETE FROM inventory.source_stock_links WHERE source_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM inventory.source_items WHERE source_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        if sqlx::query("DELETE FROM inventory.inventory_sources WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?
            .rows_affected()
            == 0
        {
            return Err(Error::NotFound);
        }
        infra_events::record(
            &mut tx,
            "inventory.source_deleted",
            json!({"id":id,"actor_id":actor}),
        )
        .await?;
        Self::refresh_sources(&mut tx).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn stocks(&self) -> Result<Vec<StockPool>> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            .execute(&mut *tx)
            .await?;
        let rows: Vec<(Uuid, i64, String, String, bool, bool)> = sqlx::query_as(
            "SELECT id,entity_id,code,name,is_default,is_global FROM inventory.stocks ORDER BY code",
        )
        .fetch_all(&mut *tx)
        .await?;
        let mut out = Vec::new();
        for (id, entity_id, code, name, is_default, is_global) in rows {
            let sources=sqlx::query_as("SELECT source_id,priority FROM inventory.source_stock_links WHERE stock_id=$1 ORDER BY priority,source_id").bind(id).fetch_all(&mut *tx).await?;
            out.push(StockPool {
                id,
                entity_id,
                code,
                name,
                is_default,
                is_global,
                sources,
            });
        }
        tx.commit().await?;
        Ok(out)
    }
    pub async fn save_stock(&self, id: Option<Uuid>, i: StockInput, actor: Uuid) -> Result<Uuid> {
        names(&i.code, &i.name)?;
        if i.sources.is_empty()
            || i.sources.len() > 100
            || i.sources
                .iter()
                .map(|s| s.source_id)
                .collect::<std::collections::HashSet<_>>()
                .len()
                != i.sources.len()
        {
            return Err(invalid("Assign 1–100 distinct sources"));
        }
        let mut tx = begin(&self.pool).await?;
        let id = if let Some(id) = id {
            let old: Option<bool> =
                sqlx::query_scalar("SELECT is_default FROM inventory.stocks WHERE id=$1")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?;
            let was_default = old.ok_or(Error::NotFound)?;
            if was_default && !i.is_default {
                return Err(invalid(
                    "Choose another default stock before clearing this one",
                ));
            }
            id
        } else {
            Uuid::new_v4()
        };
        // Configuration changes cannot invalidate in-flight holds. Priority-only edits are safe,
        // but use the same conservative boundary for a predictable admin workflow.
        let held:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM inventory.reservation_allocations a JOIN inventory.reservations r USING(cart_id,product_id) WHERE r.expires_at>clock_timestamp() AND (a.stock_id=$1 OR ($2 AND a.stock_id IN (SELECT id FROM inventory.stocks WHERE is_default))))").bind(id).bind(i.is_default).fetch_one(&mut *tx).await?;
        if held {
            return Err(invalid(
                "Stock has active reservations; wait for or release them before changing its sources",
            ));
        }
        if i.is_default {
            sqlx::query("UPDATE inventory.stocks SET is_default=false WHERE is_default")
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("INSERT INTO inventory.stocks(id,code,name,is_default,is_global) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET code=$2,name=$3,is_default=$4,is_global=$5").bind(id).bind(&i.code).bind(i.name.trim()).bind(i.is_default).bind(i.is_global).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM inventory.source_stock_links WHERE stock_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for s in i.sources {
            sqlx::query("INSERT INTO inventory.source_stock_links(stock_id,source_id,priority) VALUES($1,$2,$3)").bind(id).bind(s.source_id).bind(s.priority).execute(&mut *tx).await?;
        }
        if i.is_default {
            sqlx::query("UPDATE inventory.sales_channel_stock_links SET stock_id=$1 WHERE channel_id='storefront'").bind(id).execute(&mut *tx).await?;
        }
        infra_events::record(
            &mut tx,
            "inventory.stock_pool_saved",
            json!({"id":id,"actor_id":actor}),
        )
        .await?;
        Self::refresh_sources(&mut tx).await?;
        tx.commit().await?;
        Ok(id)
    }
    pub async fn delete_stock(&self, id: Uuid, actor: Uuid) -> Result<()> {
        let mut tx = begin(&self.pool).await?;
        // Expired allocations still reference the stock until cleanup commits.
        let used:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM inventory.stocks WHERE id=$1 AND is_default) OR EXISTS(SELECT 1 FROM inventory.reservation_allocations WHERE stock_id=$1) OR EXISTS(SELECT 1 FROM inventory.sales_channel_stock_links WHERE stock_id=$1)").bind(id).fetch_one(&mut *tx).await?;
        if used {
            return Err(invalid("Default or reserved stocks cannot be deleted"));
        }
        if sqlx::query("DELETE FROM inventory.stocks WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?
            .rows_affected()
            == 0
        {
            return Err(Error::NotFound);
        }
        infra_events::record(
            &mut tx,
            "inventory.stock_pool_deleted",
            json!({"id":id,"actor_id":actor}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn source_items(&self, product: Uuid) -> Result<Vec<SourceItem>> {
        Ok(sqlx::query_as("SELECT (i.product_id IS NOT NULL) is_assigned,s.id source_id,s.name,$1::uuid product_id,COALESCE(i.quantity,0) quantity,COALESCE(i.status,'in_stock') status,COALESCE(i.notify_stock_qty,0) notify_stock_qty,COALESCE((SELECT SUM(a.quantity) FROM inventory.reservation_allocations a JOIN inventory.reservations r USING(cart_id,product_id) WHERE a.product_id=$1 AND a.source_id=s.id AND r.expires_at>clock_timestamp()),0)::bigint reserved FROM inventory.inventory_sources s LEFT JOIN inventory.source_items i ON i.source_id=s.id AND i.product_id=$1 ORDER BY s.priority,s.code").bind(product).fetch_all(&self.pool).await?)
    }
    pub async fn adjust_source(
        &self,
        product: Uuid,
        i: SourceItemInput,
        actor: Uuid,
    ) -> Result<()> {
        let mut tx = begin(&self.pool).await?;
        Self::adjust_source_in(&mut tx, product, i, actor).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn adjust_source_in(
        tx: &mut Tx<'_>,
        product: Uuid,
        i: SourceItemInput,
        actor: Uuid,
    ) -> Result<()> {
        if !(0..=1000000).contains(&i.quantity)
            || !(0..=1000000).contains(&i.notify_stock_qty)
            || !["in_stock", "out_of_stock"].contains(&i.status.as_str())
            || i.reason.trim().is_empty()
            || i.reason.len() > 300
        {
            return Err(invalid(
                "Invalid quantity, status, threshold or adjustment reason",
            ));
        }
        let reserved:i64=sqlx::query_scalar("SELECT COALESCE(SUM(a.quantity),0)::bigint FROM inventory.reservation_allocations a JOIN inventory.reservations r USING(cart_id,product_id) WHERE a.product_id=$1 AND a.source_id=$2 AND r.expires_at>clock_timestamp()").bind(product).bind(i.source_id).fetch_one(&mut **tx).await?;
        if i64::from(i.quantity) < reserved || (reserved > 0 && i.status != "in_stock") {
            return Err(invalid("Cannot reduce or disable reserved source stock"));
        }
        let before:i32=sqlx::query_scalar("SELECT COALESCE((SELECT quantity FROM inventory.source_items WHERE product_id=$1 AND source_id=$2),0)").bind(product).bind(i.source_id).fetch_one(&mut **tx).await?;
        sqlx::query(
            "INSERT INTO inventory.stock(product_id,on_hand) VALUES($1,0) ON CONFLICT DO NOTHING",
        )
        .bind(product)
        .execute(&mut **tx)
        .await?;
        sqlx::query("INSERT INTO inventory.source_items(source_id,product_id,quantity,status,notify_stock_qty) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_id,product_id) DO UPDATE SET quantity=$3,status=$4,notify_stock_qty=$5").bind(i.source_id).bind(product).bind(i.quantity).bind(&i.status).bind(i.notify_stock_qty).execute(&mut **tx).await?;
        sqlx::query("INSERT INTO inventory.adjustments(id,product_id,actor_id,before_quantity,after_quantity,reason,source_id) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(Uuid::new_v4()).bind(product).bind(actor).bind(before).bind(i.quantity).bind(&i.reason).bind(i.source_id).execute(&mut **tx).await?;
        sqlx::query("SELECT inventory.refresh_stock_product($1)")
            .bind(product)
            .execute(&mut **tx)
            .await?;
        changed(tx, product).await
    }
    /// Saleable units in the same source scope used by allocation, excluding
    /// this cart's own hold. Partial guest merges must not use default-stock
    /// totals when their destination cart can use area or global pools.
    pub async fn reservable_quantity(
        tx: &mut Tx<'_>,
        cart: Uuid,
        product: Uuid,
        desired: i32,
    ) -> Result<i32> {
        if desired < 0 {
            return Err(invalid("Invalid quantity"));
        }
        let rows = Self::allocation_candidates(tx, cart, product).await?;
        let available = rows.iter().fold(0i64, |available, (_, _, quantity)| {
            available.saturating_add((*quantity).max(0))
        });
        Ok(available.min(i64::from(desired)) as i32)
    }

    async fn allocation_candidates(
        tx: &mut Tx<'_>,
        cart: Uuid,
        product: Uuid,
    ) -> Result<Vec<(Uuid, Uuid, i64)>> {
        let (configured,area,global):(bool,Option<Uuid>,bool)=sqlx::query_as("SELECT fulfillment.cart_geofencing(id) AND EXISTS(SELECT 1 FROM inventory.delivery_areas),inventory.resolve_delivery_area(delivery_latitude,delivery_longitude),fulfillment.cart_global_delivery(id) FROM cart_checkout.carts WHERE id=$1").bind(cart).fetch_one(&mut **tx).await?;
        if configured && area.is_none() {
            return Err(invalid(
                "Not yet deliverable to this location. Choose a covered delivery pin.",
            ));
        }
        // DISTINCT ON prevents a source shared by multiple area stocks being counted twice.
        let rows:Vec<(Uuid,Uuid,i64)>=sqlx::query_as("SELECT source_id,stock_id,available FROM (SELECT DISTINCT ON(i.source_id) i.source_id,l.stock_id,COALESCE(al.priority,0) area_priority,l.priority,(i.quantity-COALESCE((SELECT SUM(a.quantity) FROM inventory.reservation_allocations a JOIN inventory.reservations r USING(cart_id,product_id) WHERE a.source_id=i.source_id AND a.product_id=i.product_id AND a.cart_id<>$3 AND r.expires_at>clock_timestamp()),0))::bigint available FROM inventory.source_items i JOIN inventory.inventory_sources s ON s.id=i.source_id AND s.is_enabled JOIN inventory.source_stock_links l ON l.source_id=i.source_id JOIN inventory.stocks st ON st.id=l.stock_id LEFT JOIN inventory.area_stock_links al ON al.stock_id=l.stock_id AND al.area_id=$1 WHERE i.product_id=$2 AND i.status='in_stock' AND (($4 AND al.area_id IS NOT NULL) OR (NOT $4 AND (st.is_default OR ($5 AND st.is_global)))) ORDER BY i.source_id,COALESCE(al.priority,0),l.priority,l.stock_id) candidates ORDER BY area_priority,priority,source_id").bind(area).bind(product).bind(cart).bind(configured).bind(global).fetch_all(&mut **tx).await?;
        Ok(rows)
    }

    pub async fn allocate(
        tx: &mut Tx<'_>,
        cart: Uuid,
        product: Uuid,
        quantity: i32,
    ) -> Result<Vec<(Uuid, SourceAllocation)>> {
        let rows = Self::allocation_candidates(tx, cart, product).await?;
        let candidates = rows
            .iter()
            .enumerate()
            .map(|(rank, (source_id, _, available))| Candidate {
                source_id: *source_id,
                priority: rank as i32,
                available: *available,
            })
            .collect();
        let allocations = ZoneAware.select(candidates, quantity)?;
        Ok(allocations
            .into_iter()
            .map(|a| (rows.iter().find(|r| r.0 == a.source_id).unwrap().1, a))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn candidate(id: u128, priority: i32, available: i64) -> Candidate {
        Candidate {
            source_id: Uuid::from_u128(id),
            priority,
            available,
        }
    }
    #[test]
    fn priority_split_and_shortage_are_deterministic() {
        let result = PriorityDeduction
            .select(vec![candidate(2, 20, 20), candidate(1, 10, 5)], 8)
            .unwrap();
        assert_eq!(
            result,
            vec![
                SourceAllocation {
                    source_id: Uuid::from_u128(1),
                    quantity: 5
                },
                SourceAllocation {
                    source_id: Uuid::from_u128(2),
                    quantity: 3
                }
            ]
        );
        assert!(PriorityDeduction
            .select(vec![candidate(1, 0, 5)], 6)
            .is_err());
        assert!(PriorityDeduction.select(vec![], 0).unwrap().is_empty());
        assert!(PriorityDeduction.select(vec![], -1).is_err());
        assert_eq!(
            PriorityDeduction
                .select(vec![candidate(2, 0, 2), candidate(1, 0, 2)], 2)
                .unwrap()[0]
                .source_id,
            Uuid::from_u128(1)
        );
    }
}
