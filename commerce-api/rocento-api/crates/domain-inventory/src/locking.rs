//! Fine-grained commerce transactions coexist with the exclusive maintenance barrier.
//! Lock order: maintenance barrier, catalog read barrier, owner identities, cart/order
//! rows, sorted product keys. Reads used for allocation run only after these locks.
use super::*;
use std::collections::BTreeSet;

async fn scoped(tx: &mut Tx<'_>) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock_shared(3003)")
        .execute(&mut **tx)
        .await?;
    // Catalog writers keep their exclusive lock; readers never upgrade it.
    sqlx::query("SELECT pg_advisory_xact_lock_shared(2002)")
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub(super) async fn budgets(tx: &mut Tx<'_>) -> Result<()> {
    sqlx::query("SET LOCAL lock_timeout = '2s'")
        .execute(&mut **tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout = '15s'")
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn key(tx: &mut Tx<'_>, value: &str) -> Result<()> {
    // Hash collisions only introduce conservative serialization, never bypass a lock.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(value)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn products(tx: &mut Tx<'_>, ids: impl IntoIterator<Item = Uuid>) -> Result<()> {
    for id in ids.into_iter().collect::<BTreeSet<_>>() {
        key(tx, &format!("commerce:product:{id}")).await?;
    }
    Ok(())
}

/// Serialize a cart owner even before their cart exists, then lock all products
/// already in either merging cart, plus every product this command may add.
/// Unconverted bulk/configuration commands use `begin` and exclude these scopes.
pub async fn begin_cart<'a>(
    pool: &'a PgPool,
    customer: Option<Uuid>,
    guest: &str,
    additional_products: &[Uuid],
) -> Result<Tx<'a>> {
    let mut tx = infra_db::begin_transaction(pool).await?;
    budgets(&mut tx).await?;
    let timer =
        infra_observability::OperationTimer::new(infra_observability::Operation::InventoryLockWait);
    let result = async {
        scoped(&mut tx).await?;
        let guest_hash = (!guest.is_empty()).then(|| infra_auth::digest(guest));
        let mut owners = BTreeSet::new();
        if let Some(customer) = customer {
            owners.insert(format!("commerce:customer-cart:{customer}"));
        }
        if let Some(hash) = &guest_hash {
            owners.insert(format!("commerce:guest-cart:{hash}"));
        }
        for owner in owners {
            key(&mut tx, &owner).await?;
        }
        let carts: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM cart_checkout.carts
             WHERE customer_id=$1 OR guest_hash=$2 ORDER BY id FOR UPDATE",
        )
        .bind(customer)
        .bind(guest_hash)
        .fetch_all(&mut *tx)
        .await?;
        let mut ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT product_id FROM cart_checkout.items WHERE cart_id=ANY($1)
             UNION SELECT product_id FROM inventory.reservations WHERE cart_id=ANY($1)",
        )
        .bind(carts)
        .fetch_all(&mut *tx)
        .await?;
        ids.extend_from_slice(additional_products);
        products(&mut tx, ids).await?;
        Ok(tx)
    }
    .await;
    timer.finish(if result.is_ok() {
        infra_observability::OperationResult::Success
    } else {
        infra_observability::OperationResult::Error
    });
    result
}

/// Lock an order and its products before lifecycle, payment or restock work.
pub async fn begin_order(pool: &PgPool, order: Uuid) -> Result<Tx<'_>> {
    let mut tx = infra_db::begin_transaction(pool).await?;
    budgets(&mut tx).await?;
    scoped(&mut tx).await?;
    sqlx::query("SELECT id FROM orders.orders WHERE id=$1 FOR UPDATE")
        .bind(order)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::NotFound)?;
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT product_id FROM inventory.order_allocations WHERE order_id=$1
         UNION SELECT product_id FROM orders.order_items WHERE order_id=$1",
    )
    .bind(order)
    .fetch_all(&mut *tx)
    .await?;
    products(&mut tx, ids).await?;
    Ok(tx)
}
