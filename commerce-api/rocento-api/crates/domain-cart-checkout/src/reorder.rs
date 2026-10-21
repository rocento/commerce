//! Explicit numbered reorders: current facts, isolated basket, one atomic COD commit.
use super::*;
use domain_orders::Detail;

impl Service {
    pub async fn reorder_number(&self, customer: Uuid, number: i64, key: Uuid) -> Result<Detail> {
        if number <= 0 || key.is_nil() {
            return Err(Error::Invalid("REORDER_INVALID_REQUEST".into()));
        }
        // The shared inventory lock serializes stock allocation and duplicate requests.
        let mut tx = domain_inventory::begin(&self.pool).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        let source: Uuid =
            sqlx::query_scalar("SELECT id FROM orders.orders WHERE customer_id=$1 AND number=$2")
                .bind(customer)
                .bind(number)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(Error::NotFound)?;
        let existing: Option<(Uuid, Option<Uuid>)> = sqlx::query_as("SELECT id,reordered_from FROM orders.orders WHERE customer_id=$1 AND idempotency_key=$2")
            .bind(customer).bind(key).fetch_optional(&mut *tx).await?;
        if let Some((id, origin)) = existing {
            if origin != Some(source) {
                return Err(Error::Invalid("REORDER_REQUEST_ALREADY_USED".into()));
            }
            let detail = domain_orders::Service::detail_in(&mut tx, id, Some(customer)).await?;
            let committed = tx.commit().await;
            timer.finish(if committed.is_ok() {
                infra_observability::OperationResult::Success
            } else {
                infra_observability::OperationResult::Error
            });
            committed?;
            return Ok(detail);
        }
        let old = domain_orders::Service::detail_in(&mut tx, source, Some(customer)).await?;
        if old.payment.method != "cod" {
            return Err(Error::Invalid("REORDER_PAYMENT_REQUIRED".into()));
        }
        if old.items.is_empty() || old.items.len() > 200 {
            return Err(Error::Invalid("REORDER_ITEMS_UNAVAILABLE".into()));
        }
        let location: Uuid = old
            .order
            .location
            .get("id")
            .and_then(serde_json::Value::as_str)
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| Error::Invalid("REORDER_ADDRESS_REQUIRED".into()))?;
        let (_, address) =
            domain_customers::Service::checkout_location(&mut tx, customer, location)
                .await
                .map_err(|e| match e {
                    Error::NotFound => Error::Invalid("REORDER_ADDRESS_REQUIRED".into()),
                    other => other,
                })?;
        let current_address = json!(address);
        for field in [
            "location_method",
            "geography",
            "latitude",
            "longitude",
            "formatted_address",
            "building",
            "floor",
            "apartment",
            "delivery_instructions",
        ] {
            if current_address.get(field) != old.order.location.get(field) {
                return Err(Error::Invalid("REORDER_ADDRESS_CHANGED".into()));
            }
        }
        // A private basket protects the customer's existing cart and reservations.
        let cart = Uuid::new_v4();
        let store = old
            .fulfillment_plan
            .as_ref()
            .and_then(|p| p.get("store_id"))
            .and_then(serde_json::Value::as_str)
            .and_then(|v| v.parse::<Uuid>().ok());
        sqlx::query("INSERT INTO cart_checkout.carts(id,guest_hash,delivery_latitude,delivery_longitude,fulfillment_store_id) VALUES($1,$2,$3,$4,COALESCE($5,fulfillment.default_store()))")
            .bind(cart).bind(infra_auth::digest(&infra_auth::token())).bind(address.latitude).bind(address.longitude).bind(store).execute(&mut *tx).await?;
        let context = market_context::for_cart(&mut tx, cart).await?;
        let old_market = old
            .order
            .market_context
            .as_ref()
            .and_then(|v| v.get("id"))
            .and_then(|v| v.as_str())
            .and_then(|v| v.parse::<Uuid>().ok());
        if old_market != context.id {
            return Err(Error::Invalid(
                "REORDER_MARKET_CHANGED: review a new cart in the current market".into(),
            ));
        }
        for item in &old.items {
            let p = domain_catalog::Service::checkout_product(&mut tx, item.product_id).await?;
            market::validate_product(&mut tx, &p, item.quantity).await?;
            let facts = market::facts(&mut tx, &p).await?;
            if p.sku != item.sku
                || p.unit != item.unit
                || item
                    .market_facts
                    .as_ref()
                    .is_none_or(|old| !market::equivalent_facts(old, &facts))
            {
                return Err(Error::Invalid("REORDER_PRODUCT_CHANGED".into()));
            }
            self.inventory
                .reserve(&mut tx, cart, p.id, item.quantity)
                .await?;
            Self::save(
                &mut tx,
                cart,
                &Stored {
                    product_id: p.id,
                    sku: p.sku,
                    name: p.name,
                    unit: p.unit,
                    price: p.price,
                    currency: p.currency,
                    quantity: item.quantity,
                },
            )
            .await?;
        }
        let (_, mut snapshot) =
            Self::checkout_snapshot_for_cart(&mut tx, customer, location, cart).await?;
        snapshot.gift_message = old.order.gift_message.clone();
        if snapshot.currency != old.order.currency || snapshot.total > old.order.total {
            return Err(Error::Invalid("REORDER_PRICE_CHANGED".into()));
        }
        let quote = Uuid::new_v4();
        sqlx::query("INSERT INTO cart_checkout.quotes(id,customer_id,cart_id,location_id,snapshot,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '5 minutes')")
            .bind(quote).bind(customer).bind(cart).bind(location).bind(json!(snapshot)).execute(&mut *tx).await?;
        let detail = Self::place_snapshot(&mut tx, customer, cart, quote, key, snapshot).await?;
        sqlx::query("UPDATE orders.orders SET reordered_from=$2 WHERE id=$1")
            .bind(detail.order.id)
            .bind(source)
            .execute(&mut *tx)
            .await?;
        domain_orders::history(
            &mut tx,
            detail.order.id,
            "placed",
            Some(customer),
            &format!("Assistant reordered order #{number}"),
        )
        .await?;
        // The quote retains the basket identifier for audit; no session can access this basket.
        sqlx::query("DELETE FROM cart_checkout.carts WHERE id=$1")
            .bind(cart)
            .execute(&mut *tx)
            .await?;
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        Ok(detail)
    }
}
