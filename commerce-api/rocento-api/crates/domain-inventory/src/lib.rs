//! Multi-source inventory with scoped commerce locks and an exclusive maintenance barrier.
pub mod areas;
mod availability;
mod expiry;
mod locking;
pub use expiry::EXPIRY_BATCH_SIZE;
pub use locking::{begin_cart, begin_order};
pub mod msi;
use chrono::{DateTime, Utc};
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;
pub type Tx<'a> = Transaction<'a, Postgres>;
#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
    pub ttl_seconds: i64,
}
#[derive(Serialize, Deserialize, FromRow, Debug)]
pub struct Stock {
    pub product_id: Uuid,
    pub on_hand: i32,
    pub reserved: i64,
    pub available: i64,
}
#[derive(Serialize, Deserialize, FromRow)]
pub struct Reservation {
    pub cart_id: Uuid,
    pub product_id: Uuid,
    pub quantity: i32,
    pub expires_at: DateTime<Utc>,
}
#[derive(Serialize, FromRow)]
pub struct Adjustment {
    pub id: Uuid,
    pub product_id: Uuid,
    pub actor_id: Uuid,
    pub before_quantity: i32,
    pub after_quantity: i32,
    pub reason: String,
    pub created_at: DateTime<Utc>,
}
pub fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
pub async fn begin(pool: &PgPool) -> Result<Tx<'_>> {
    let mut tx = infra_db::begin_transaction(pool).await?;
    locking::budgets(&mut tx).await?;
    let timer =
        infra_observability::OperationTimer::new(infra_observability::Operation::InventoryLockWait);
    let result = sqlx::query("SELECT pg_advisory_xact_lock(3003)")
        .execute(&mut *tx)
        .await;
    timer.finish(if result.is_ok() {
        infra_observability::OperationResult::Success
    } else {
        infra_observability::OperationResult::Error
    });
    result?;
    Ok(tx)
}
async fn changed(tx: &mut Tx<'_>, product_id: Uuid) -> Result<()> {
    sqlx::query("SELECT inventory.refresh_availability($1)")
        .bind(product_id)
        .execute(&mut **tx)
        .await?;
    infra_events::record(tx, "inventory.stock_updated", json!({"id":product_id})).await?;
    Ok(())
}
impl Service {
    pub fn new(pool: PgPool, ttl_seconds: i64) -> Result<Self> {
        if !(1..=86400).contains(&ttl_seconds) {
            return Err(invalid("Reservation TTL must be 1–86400 seconds"));
        }
        Ok(Self { pool, ttl_seconds })
    }
    /// Bounded batch with the same live-reservation/area semantics as single-SKU reads.
    pub async fn available_many(
        &self,
        ids: &[Uuid],
        area: Option<Uuid>,
    ) -> Result<std::collections::HashMap<Uuid, i64>> {
        if ids.len() > 20 {
            return Err(invalid("At most 20 stock candidates"));
        }
        let rows: Vec<(Uuid, i64)> = if let Some(area) = area {
            return self.area_available_many(ids, area).await;
        } else {
            sqlx::query_as("SELECT i.id,COALESCE(s.on_hand,0)::bigint-COALESCE(r.reserved,0)::bigint FROM unnest($1::uuid[]) i(id) LEFT JOIN inventory.stock s ON s.product_id=i.id LEFT JOIN (SELECT product_id,SUM(quantity) reserved FROM inventory.reservations WHERE product_id=ANY($1) AND expires_at>clock_timestamp() GROUP BY product_id) r ON r.product_id=i.id").bind(ids).fetch_all(&self.pool).await?
        };
        Ok(rows.into_iter().collect())
    }
    pub async fn stock(&self, id: Uuid) -> Result<Stock> {
        let (on_hand,reserved):(i32,i64)=sqlx::query_as("SELECT COALESCE((SELECT on_hand FROM inventory.stock WHERE product_id=$1),0),COALESCE((SELECT SUM(quantity) FROM inventory.reservations WHERE product_id=$1 AND expires_at>clock_timestamp()),0)::bigint").bind(id).fetch_one(&self.pool).await?;
        Ok(Stock {
            product_id: id,
            on_hand,
            reserved,
            available: i64::from(on_hand) - reserved,
        })
    }
    pub async fn stock_in(tx: &mut Tx<'_>, id: Uuid) -> Result<Stock> {
        let (on_hand,reserved):(i32,i64)=sqlx::query_as("SELECT COALESCE((SELECT on_hand FROM inventory.stock WHERE product_id=$1),0),COALESCE((SELECT SUM(quantity) FROM inventory.reservations WHERE product_id=$1 AND expires_at>clock_timestamp()),0)::bigint").bind(id).fetch_one(&mut **tx).await?;
        Ok(Stock {
            product_id: id,
            on_hand,
            reserved,
            available: i64::from(on_hand) - reserved,
        })
    }
    pub async fn adjust(
        &self,
        id: Uuid,
        on_hand: i32,
        actor: Uuid,
        reason: String,
    ) -> Result<Stock> {
        let mut tx = begin(&self.pool).await?;
        let stock = Self::adjust_in(&mut tx, id, on_hand, actor, reason).await?;
        tx.commit().await?;
        Ok(stock)
    }
    pub async fn adjust_in(
        tx: &mut Tx<'_>,
        id: Uuid,
        on_hand: i32,
        actor: Uuid,
        reason: String,
    ) -> Result<Stock> {
        let sources: Vec<Uuid> = sqlx::query_scalar("SELECT l.source_id FROM inventory.source_stock_links l JOIN inventory.stocks s ON s.id=l.stock_id WHERE s.is_default").fetch_all(&mut **tx).await?;
        if sources.len() != 1 {
            return Err(invalid("Use per-source quantities for multi-source stock"));
        }
        Self::adjust_source_in(
            tx,
            id,
            msi::SourceItemInput {
                source_id: sources[0],
                quantity: on_hand,
                status: "in_stock".into(),
                notify_stock_qty: 0,
                reason,
            },
            actor,
        )
        .await?;
        Self::stock_in(tx, id).await
    }
    pub async fn reservations(&self, id: Uuid) -> Result<Vec<Reservation>> {
        Ok(sqlx::query_as("SELECT * FROM inventory.reservations WHERE product_id=$1 AND expires_at>clock_timestamp() ORDER BY expires_at LIMIT 500").bind(id).fetch_all(&self.pool).await?)
    }
    pub async fn adjustments(&self, id: Uuid) -> Result<Vec<Adjustment>> {
        Ok(sqlx::query_as("SELECT * FROM inventory.adjustments WHERE product_id=$1 ORDER BY created_at DESC LIMIT 100").bind(id).fetch_all(&self.pool).await?)
    }
    pub async fn hold(tx: &mut Tx<'_>, cart: Uuid, id: Uuid) -> Result<Option<Reservation>> {
        Ok(sqlx::query_as("SELECT * FROM inventory.reservations WHERE cart_id=$1 AND product_id=$2 AND expires_at>clock_timestamp()").bind(cart).bind(id).fetch_optional(&mut **tx).await?)
    }
    pub async fn reserve(
        &self,
        tx: &mut Tx<'_>,
        cart: Uuid,
        id: Uuid,
        quantity: i32,
    ) -> Result<()> {
        if quantity < 0 {
            return Err(invalid("Invalid quantity"));
        }
        if quantity == 0 {
            return Self::release(tx, cart, id, "removed").await;
        }
        // Allocation is read-only and excludes this cart's existing hold.
        // Expected shortages must leave that hold intact: merge/re-reserve
        // callers can intentionally catch Invalid and commit their transaction.
        let allocations = Self::allocate(tx, cart, id, quantity).await?;
        // Classify and remove the previous hold in one statement. A hold that
        // expires during this command cannot disappear without its expiry event.
        let previous: Option<(i32, bool)> = sqlx::query_as(
            "DELETE FROM inventory.reservations WHERE cart_id=$1 AND product_id=$2
             RETURNING quantity,expires_at<=clock_timestamp()",
        )
        .bind(cart)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
        let old = match previous {
            Some((quantity, true)) => {
                Self::record_expired_key(tx, cart, id, quantity).await?;
                0
            }
            Some((quantity, false)) => quantity,
            None => 0,
        };
        sqlx::query("INSERT INTO inventory.reservations(cart_id,product_id,quantity,expires_at) VALUES($1,$2,$3,clock_timestamp()+make_interval(secs=>$4)) ON CONFLICT(cart_id,product_id) DO UPDATE SET quantity=$3,expires_at=clock_timestamp()+make_interval(secs=>$4)").bind(cart).bind(id).bind(quantity).bind(self.ttl_seconds as f64).execute(&mut **tx).await?;
        for (stock_id, a) in allocations {
            sqlx::query("INSERT INTO inventory.reservation_allocations(cart_id,product_id,source_id,stock_id,quantity) VALUES($1,$2,$3,$4,$5)").bind(cart).bind(id).bind(a.source_id).bind(stock_id).bind(a.quantity).execute(&mut **tx).await?;
        }
        if old > quantity {
            infra_events::record(tx,"inventory.released",json!({"cart_id":cart,"product_id":id,"quantity":old-quantity,"reason":"quantity_reduced"})).await?;
        }
        if quantity > old {
            infra_events::record(
                tx,
                "inventory.reserved",
                json!({"cart_id":cart,"product_id":id,"quantity":quantity-old}),
            )
            .await?;
        }
        changed(tx, id).await?;
        Ok(())
    }
    pub async fn release(tx: &mut Tx<'_>, cart: Uuid, id: Uuid, reason: &str) -> Result<()> {
        let previous: Option<(i32, bool)> = sqlx::query_as(
            "DELETE FROM inventory.reservations WHERE cart_id=$1 AND product_id=$2
             RETURNING quantity,expires_at<=clock_timestamp()",
        )
        .bind(cart)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
        if let Some((quantity, expired)) = previous {
            infra_events::record(
                tx,
                "inventory.released",
                json!({"cart_id":cart,"product_id":id,"quantity":quantity,"reason":if expired {"expired"} else {reason}}),
            )
            .await?;
            changed(tx, id).await?;
        }
        Ok(())
    }
}
/// Inventory read capability for search projection and future checkout callers.
pub trait InventoryReader: Send + Sync {
    fn available_stocks(
        &self,
        _id: Uuid,
    ) -> impl std::future::Future<Output = Result<Vec<Uuid>>> + Send {
        async { Ok(vec![]) }
    }
    fn stock(&self, id: Uuid) -> impl std::future::Future<Output = Result<Stock>> + Send;
}
impl InventoryReader for Service {
    async fn available_stocks(&self, id: Uuid) -> Result<Vec<Uuid>> {
        Service::available_stocks(self, id).await
    }
    async fn stock(&self, id: Uuid) -> Result<Stock> {
        Service::stock(self, id).await
    }
}

impl Service {
    /// M4 uses this inside the order transaction after validating every expected cart line.
    /// A missing/expired hold fails, so retries cannot decrement the same reservation twice.
    pub async fn consume_reserved(
        tx: &mut Tx<'_>,
        cart: Uuid,
        id: Uuid,
        quantity: i32,
    ) -> Result<Vec<msi::SourceAllocation>> {
        let hold = Self::hold(tx, cart, id)
            .await?
            .ok_or_else(|| invalid("Reservation expired or already consumed"))?;
        if quantity <= 0 || hold.quantity != quantity {
            return Err(invalid("Reservation quantity does not match order"));
        }
        let allocations: Vec<msi::SourceAllocation> = sqlx::query_as("SELECT source_id,quantity FROM inventory.reservation_allocations WHERE cart_id=$1 AND product_id=$2 ORDER BY source_id").bind(cart).bind(id).fetch_all(&mut **tx).await?;
        if allocations
            .iter()
            .map(|a| i64::from(a.quantity))
            .sum::<i64>()
            != i64::from(quantity)
        {
            return Err(invalid("Reservation source quantities do not match order"));
        }
        for a in &allocations {
            if sqlx::query("UPDATE inventory.source_items SET quantity=quantity-$3 WHERE product_id=$1 AND source_id=$2 AND quantity>=$3 AND status='in_stock'").bind(id).bind(a.source_id).bind(a.quantity).execute(&mut **tx).await?.rows_affected()!=1 { return Err(invalid("Reserved source stock is unavailable")); }
        }
        sqlx::query("SELECT inventory.refresh_stock_product($1)")
            .bind(id)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM inventory.reservations WHERE cart_id=$1 AND product_id=$2")
            .bind(cart)
            .bind(id)
            .execute(&mut **tx)
            .await?;
        infra_events::record(
            tx,
            "inventory.committed",
            json!({"cart_id":cart,"product_id":id,"quantity":quantity}),
        )
        .await?;
        changed(tx, id).await?;
        Ok(allocations)
    }
}

impl Service {
    /// Return units to their original sources, including disabled sources.
    pub async fn restock_order(tx: &mut Tx<'_>, order: Uuid) -> Result<()> {
        let rows:Vec<(Uuid,Uuid,i32)>=sqlx::query_as("SELECT product_id,source_id,quantity FROM inventory.order_allocations WHERE order_id=$1 ORDER BY product_id,source_id").bind(order).fetch_all(&mut **tx).await?;
        for (product, source, quantity) in rows {
            sqlx::query("INSERT INTO inventory.source_items(source_id,product_id,quantity) VALUES($1,$2,$3) ON CONFLICT(source_id,product_id) DO UPDATE SET quantity=inventory.source_items.quantity+$3").bind(source).bind(product).bind(quantity).execute(&mut **tx).await?;
            sqlx::query("SELECT inventory.refresh_stock_product($1)")
                .bind(product)
                .execute(&mut **tx)
                .await?;
            changed(tx, product).await?;
        }
        Ok(())
    }
}
