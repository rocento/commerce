//! Bounded background expiry and exact-key cleanup before replacing a hold.
use super::*;
use infra_observability::{Operation, OperationResult, OperationTimer};
use std::collections::BTreeSet;

pub const EXPIRY_BATCH_SIZE: usize = 100;

impl Service {
    /// Delete one bounded batch under the shared inventory transaction lock.
    /// Request commands clean only the reservation they are replacing/removing.
    pub async fn expire_in(tx: &mut Tx<'_>) -> Result<u64> {
        let timer = OperationTimer::new(Operation::InventoryExpiry);
        let result = async {
            let rows: Vec<Reservation> = sqlx::query_as(
                "WITH expired AS (
                    SELECT cart_id,product_id FROM inventory.reservations
                    WHERE expires_at<=clock_timestamp()
                    ORDER BY expires_at,cart_id,product_id LIMIT $1 FOR UPDATE
                 ) DELETE FROM inventory.reservations r USING expired e
                   WHERE r.cart_id=e.cart_id AND r.product_id=e.product_id RETURNING r.*",
            )
            .bind(EXPIRY_BATCH_SIZE as i64)
            .fetch_all(&mut **tx)
            .await?;
            let count = rows.len() as u64;
            Self::record_expired(tx, rows).await?;
            infra_observability::inventory_expiry_batch_size(count);
            Ok(count)
        }
        .await;
        timer.finish(if result.is_ok() {
            OperationResult::Success
        } else {
            OperationResult::Error
        });
        result
    }

    pub(super) async fn record_expired_key(
        tx: &mut Tx<'_>,
        cart: Uuid,
        product: Uuid,
        quantity: i32,
    ) -> Result<()> {
        infra_events::record(
            tx,
            "inventory.released",
            json!({
                "cart_id":cart,"product_id":product,"quantity":quantity,"reason":"expired"
            }),
        )
        .await?;
        changed(tx, product).await
    }

    async fn record_expired(tx: &mut Tx<'_>, rows: Vec<Reservation>) -> Result<()> {
        let mut products = BTreeSet::new();
        for row in rows {
            products.insert(row.product_id);
            infra_events::record(
                tx,
                "inventory.released",
                json!({
                    "cart_id":row.cart_id,"product_id":row.product_id,
                    "quantity":row.quantity,"reason":"expired"
                }),
            )
            .await?;
            // Preserve the existing per-reservation event contract while
            // refreshing the read model just once for each affected product.
            infra_events::record(tx, "inventory.stock_updated", json!({"id":row.product_id}))
                .await?;
        }
        for product in products {
            sqlx::query("SELECT inventory.refresh_availability($1)")
                .bind(product)
                .execute(&mut **tx)
                .await?;
        }
        Ok(())
    }

    pub async fn expire(&self) -> Result<u64> {
        let mut tx = begin(&self.pool).await?;
        let timer = OperationTimer::new(Operation::InventoryTransaction);
        let count = Self::expire_in(&mut tx).await?;
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            OperationResult::Success
        } else {
            OperationResult::Error
        });
        committed?;
        Ok(count)
    }

    pub async fn worker(self) {
        loop {
            let delay = match self.expire().await {
                Ok(count) if count == EXPIRY_BATCH_SIZE as u64 => {
                    // Release the transaction and yield between full batches;
                    // a backlog should not be capped at 50 expired holds/sec.
                    std::time::Duration::from_millis(50)
                }
                Ok(_) => std::time::Duration::from_secs(2),
                Err(error) => {
                    tracing::warn!(error=%error,"reservation expiry retrying");
                    std::time::Duration::from_secs(2)
                }
            };
            tokio::time::sleep(delay).await;
        }
    }
}
