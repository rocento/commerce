//! Cart snapshots load bounded sets of facts before assembling lines in memory.
use super::*;
use std::collections::HashMap;

const FACT_BATCH_SIZE: usize = 20;

#[derive(Default, FromRow)]
struct Facts {
    product_id: Uuid,
    price: Option<Decimal>,
    category_id: Option<Uuid>,
    sku: Option<String>,
    currency: Option<String>,
    reserved_quantity: Option<i32>,
    expires_at: Option<chrono::DateTime<chrono::Utc>>,
    selling_rule: Option<serde_json::Value>,
}

impl Facts {
    // Match the existing label path: deserialize a configured rule, without
    // revalidating selling quantities while reading an existing cart.
    fn unit_label(self, legacy: &str) -> Result<String> {
        let Some(value) = self.selling_rule else {
            return Ok(legacy.into());
        };
        let rule: market::SellingRule = serde_json::from_value(value)
            .map_err(|_| Error::Invalid("SELLING_RULE_INVALID".into()))?;
        Ok(format!(
            "units of {} {}",
            rule.measure_per_unit,
            match rule.measure_unit {
                market::MeasureUnit::Piece => "pieces",
                market::MeasureUnit::Kg => "kg",
                market::MeasureUnit::Litre => "litres",
            }
        ))
    }
}

impl Service {
    pub(super) async fn view(
        tx: &mut Tx<'_>,
        cart: Uuid,
        customer_id: Option<Uuid>,
    ) -> Result<Cart> {
        let timer =
            infra_observability::OperationTimer::new(infra_observability::Operation::CartSnapshot);
        let result = Self::snapshot(tx, cart, customer_id).await;
        timer.finish(if result.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        result
    }

    async fn snapshot(tx: &mut Tx<'_>, cart: Uuid, customer_id: Option<Uuid>) -> Result<Cart> {
        // Keep market validation before the existing pricing lock, and pricing
        // assessment once after every line has been checked and assembled.
        let market_context = market_context::for_cart(tx, cart).await?;
        sqlx::query("SELECT pg_advisory_xact_lock_shared(2002)")
            .execute(&mut **tx)
            .await?;
        let currency = market::currency(tx).await?;
        let rows = Self::rows(tx, cart).await?;
        let (configured, area, global): (bool, Option<Uuid>, bool) = if rows.is_empty() {
            (false, None, false)
        } else {
            sqlx::query_as(
                "SELECT fulfillment.cart_geofencing(id) \
                  AND EXISTS(SELECT 1 FROM inventory.delivery_areas), \
                 inventory.resolve_delivery_area(delivery_latitude,delivery_longitude), fulfillment.cart_global_delivery(id) \
                 FROM cart_checkout.carts WHERE id=$1",
            )
            .bind(cart)
            .fetch_one(&mut **tx)
            .await?
        };
        let ids: Vec<Uuid> = rows.iter().map(|row| row.product_id).collect();
        let mut facts = HashMap::with_capacity(ids.len());
        let mut available = HashMap::with_capacity(ids.len());
        for batch in ids.chunks(FACT_BATCH_SIZE) {
            let current: Vec<Facts> = sqlx::query_as(
                "SELECT requested.id product_id,p.price,p.category_id,p.sku,p.currency, \
                  r.quantity reserved_quantity,r.expires_at,s.rule selling_rule \
                 FROM unnest($1::uuid[]) requested(id) \
                 LEFT JOIN catalog.storefront_products p ON p.id=requested.id \
                 LEFT JOIN inventory.reservations r \
                  ON r.product_id=requested.id AND r.cart_id=$2 \
                   AND r.expires_at>clock_timestamp() \
                 LEFT JOIN cart_checkout.selling_rules s ON s.product_id=requested.id",
            )
            .bind(batch)
            .bind(cart)
            .fetch_all(&mut **tx)
            .await?;
            facts.extend(current.into_iter().map(|row| (row.product_id, row)));
            if global {
                available.extend(Inventory::global_available_many_in(tx, batch).await?);
            } else if !configured || area.is_some() {
                available.extend(
                    Inventory::available_many_in(tx, batch, configured.then_some(area).flatten())
                        .await?,
                );
            }
        }

        let mut items = Vec::with_capacity(rows.len());
        let mut pricing_lines = Vec::with_capacity(rows.len());
        let mut subtotal = Decimal::ZERO;
        let mut fully_reserved = true;
        for mut row in rows {
            let current = facts.remove(&row.product_id).unwrap_or_default();
            if let Some(price) = current.price {
                row.price = price;
                if let Some(code) = &current.currency {
                    row.currency.clone_from(code);
                }
                if let Some(sku) = &current.sku {
                    row.sku.clone_from(sku);
                }
            }
            pricing_lines.push(domain_pricing_promotions::Line {
                product_id: row.product_id,
                sku: row.sku.clone(),
                category_id: current.category_id,
                price: row.price,
                quantity: row.quantity,
            });
            let reserved_quantity = current.reserved_quantity.unwrap_or(0);
            let expires_at = current.expires_at;
            if row.currency != currency {
                return Err(Error::Invalid("CURRENCY_MISMATCH".into()));
            }
            market::exact_money(row.price, &currency)?;
            let line_total = row.price * Decimal::from(row.quantity);
            subtotal += line_total;
            fully_reserved &= reserved_quantity == row.quantity;
            items.push(Item {
                product_id: row.product_id,
                sku: row.sku,
                name: row.name,
                unit: current.unit_label(&row.unit)?,
                price: row.price,
                currency: row.currency,
                quantity: row.quantity,
                reserved_quantity,
                available: available.get(&row.product_id).copied().unwrap_or(0)
                    + i64::from(reserved_quantity),
                expires_at,
                line_total,
            });
        }
        let (entity_id, code): (i64, Option<String>) =
            sqlx::query_as("SELECT entity_id,coupon_code FROM cart_checkout.carts WHERE id=$1")
                .bind(cart)
                .fetch_one(&mut **tx)
                .await?;
        let discounts = domain_pricing_promotions::Service::assess(
            tx,
            customer_id,
            &pricing_lines,
            code,
            false,
        )
        .await?;
        Ok(Cart {
            market: market_context,
            discount_amount: discounts.amount,
            discount_snapshot: discounts.applied,
            coupon_code: discounts.coupon_code,
            coupon_error: discounts.coupon_error,
            id: cart,
            entity_id,
            customer_id,
            fully_reserved: fully_reserved && !items.is_empty(),
            items,
            subtotal,
            currency,
        })
    }
}
