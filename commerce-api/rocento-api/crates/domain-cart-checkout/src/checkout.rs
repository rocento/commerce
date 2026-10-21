//! Server quotes bind reviewed prices, quantities and location to an idempotent order.
use super::*;
use domain_orders::{Detail, Item as OrderItem};
use domain_payments::{CashOnDelivery, PaymentProvider};
use serde_json::Value;
#[derive(Serialize, Deserialize, PartialEq)]
pub struct Snapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub market: Option<market_context::Context>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_delivery: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fulfillment_plan: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gift_message: Option<String>,
    pub items: Vec<OrderItem>,
    #[serde(with = "rust_decimal::serde::str")]
    pub discount_amount: Decimal,
    pub discount_snapshot: Vec<domain_pricing_promotions::Applied>,
    pub coupon_code: Option<String>,
    pub location: Value,
    pub contact: Value,
    #[serde(with = "rust_decimal::serde::str")]
    pub subtotal: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub delivery_fee: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub total: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub tax_amount: Decimal,
    pub tax_snapshot: domain_tax::Assessment,
    pub currency: String,
    pub payment_method: String,
}
#[derive(Serialize, Deserialize)]
pub struct Quote {
    #[serde(default, skip_serializing_if = "entity_id_missing")]
    pub entity_id: i64,
    pub id: Uuid,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    pub snapshot: Snapshot,
}
impl Service {
    async fn checkout_snapshot(
        tx: &mut domain_inventory::Tx<'_>,
        customer: Uuid,
        location: Uuid,
    ) -> Result<(Uuid, Snapshot)> {
        let cart = Self::resolve(tx, Some(customer), "").await?;
        Self::checkout_snapshot_for_cart(tx, customer, location, cart).await
    }
    pub(super) async fn checkout_snapshot_for_cart(
        tx: &mut domain_inventory::Tx<'_>,
        customer: Uuid,
        location: Uuid,
        cart: Uuid,
    ) -> Result<(Uuid, Snapshot)> {
        let market_context = market_context::for_cart(tx, cart).await?;
        let capabilities = domain_fulfillment::capabilities::for_cart(tx, cart).await?;
        let fulfillment_plan =
            domain_fulfillment::plans::checkout(tx, customer, cart, location).await?;
        let managed:bool=sqlx::query_scalar("SELECT s.capabilities<>'{}'::jsonb OR d.capabilities<>'{}'::jsonb OR NOT s.is_default FROM cart_checkout.carts c JOIN fulfillment.stores s ON s.id=c.fulfillment_store_id CROSS JOIN fulfillment.system_capabilities d WHERE c.id=$1").bind(cart).fetch_one(&mut **tx).await?;
        if managed && fulfillment_plan.is_none() {
            return Err(Error::Invalid("FULFILLMENT_PLAN_REQUIRED".into()));
        }
        let pickup = fulfillment_plan
            .as_ref()
            .is_some_and(|p| p["method"] == "pickup");
        if !pickup {
            capabilities.require(capabilities.delivery_enabled, "delivery")?;
        }
        let (c, l) = if pickup {
            let c:domain_customers::Customer=sqlx::query_as("SELECT id,entity_id,email,mobile_number,primary_identifier,verified,created_at FROM customers.customers WHERE id=$1 FOR SHARE").bind(customer).fetch_one(&mut **tx).await?;
            if !c.verified {
                return Err(Error::Forbidden);
            }
            let source: Uuid = serde_json::from_value(
                fulfillment_plan.as_ref().unwrap()["groups"][0]["source_id"].clone(),
            )
            .map_err(|_| Error::Internal)?;
            let l=sqlx::query_as("SELECT 'pickup'::text location_method,NULL::jsonb geography,id,entity_id,'other'::text label,name custom_label,COALESCE(latitude,0) latitude,COALESCE(longitude,0) longitude,address formatted_address,''::text building,''::text floor,''::text apartment,''::text delivery_instructions,false is_default,NULL::uuid area_id,to_timestamp(0) created_at,to_timestamp(0) updated_at FROM inventory.inventory_sources WHERE id=$1").bind(source).fetch_one(&mut **tx).await?;
            (c, l)
        } else {
            domain_customers::Service::checkout_location(tx, customer, location).await?
        };
        if market_context.id.is_some()
            && !pickup
            && l.geography
                .as_ref()
                .is_some_and(|g| g.country_code != market_context.country)
        {
            return Err(Error::Invalid(
                "MARKET_DESTINATION_MISMATCH: select an address in the storefront country".into(),
            ));
        }
        let configured: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM inventory.delivery_areas)")
                .fetch_one(&mut **tx)
                .await?;
        if configured && capabilities.geofencing() && !pickup && fulfillment_plan.is_none() {
            let area: Option<Uuid> =
                sqlx::query_scalar("SELECT inventory.resolve_delivery_area($1,$2)")
                    .bind(l.latitude)
                    .bind(l.longitude)
                    .fetch_one(&mut **tx)
                    .await?;
            let cart_area:Option<Uuid>=sqlx::query_scalar("SELECT inventory.resolve_delivery_area(delivery_latitude,delivery_longitude) FROM cart_checkout.carts WHERE id=$1").bind(cart).fetch_one(&mut **tx).await?;
            if area.is_none() || area != cart_area {
                return Err(Error::Invalid("Delivery area changed or is not covered. Select this location and reserve your cart again.".into()));
            }
            let invalid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM inventory.reservation_allocations a WHERE a.cart_id=$1 AND NOT EXISTS(SELECT 1 FROM inventory.area_stock_links l JOIN inventory.source_stock_links s ON s.stock_id=l.stock_id JOIN inventory.inventory_sources src ON src.id=s.source_id AND src.is_enabled WHERE l.area_id=$2 AND l.stock_id=a.stock_id AND s.source_id=a.source_id))").bind(cart).bind(area).fetch_one(&mut **tx).await?;
            if invalid {
                return Err(Error::Invalid(
                    "Delivery coverage changed. Reserve your cart again.".into(),
                ));
            }
        }
        if !capabilities.multi_source_fulfillment_enabled {
            let sources:i64=sqlx::query_scalar("SELECT count(DISTINCT source_id) FROM inventory.reservation_allocations WHERE cart_id=$1").bind(cart).fetch_one(&mut **tx).await?;
            if sources > 1 {
                return Err(Error::Invalid("SINGLE_SOURCE_UNAVAILABLE".into()));
            }
        }
        if !capabilities.global_delivery()
            && !capabilities.geofencing()
            && !capabilities.delivery_city_ids.is_empty()
            && !pickup
            && !l
                .geography
                .as_ref()
                .is_some_and(|g| capabilities.delivery_city_ids.contains(&g.city_id))
        {
            return Err(Error::Invalid("OUTSIDE_DELIVERY_AREA".into()));
        }
        let rows = Self::rows(tx, cart).await?;
        if rows.is_empty() {
            return Err(Error::Invalid("Your cart is empty".into()));
        }
        let mut items = Vec::new();
        let mut pricing_lines = Vec::new();
        let currency = market::currency(tx).await?;
        let mut subtotal = Decimal::ZERO;
        for row in rows {
            let p = domain_catalog::Service::checkout_product(tx, row.product_id).await?;
            market::validate_product(tx, &p, row.quantity).await?;
            let hold = Inventory::hold(tx, cart, p.id).await?;
            if hold.is_none_or(|h| h.quantity != row.quantity) {
                return Err(Error::Invalid(
                    "Reservation expired or incomplete. Return to your cart and reserve again."
                        .into(),
                ));
            }
            let line_total = p.price * Decimal::from(row.quantity);
            subtotal += line_total;
            pricing_lines.push(domain_pricing_promotions::Line {
                product_id: p.id,
                sku: p.sku.clone(),
                category_id: Some(p.category_id),
                price: p.price,
                quantity: row.quantity,
            });
            items.push(OrderItem {
                market_facts: Some(market::facts(tx, &p).await?),
                discount_amount: Decimal::ZERO,
                discount_snapshot: json!([]),
                product_id: p.id,
                sku: p.sku,
                name: p.name,
                unit: p.unit,
                quantity: row.quantity,
                price: p.price,
                line_total,
            });
        }
        let code: Option<String> =
            sqlx::query_scalar("SELECT coupon_code FROM cart_checkout.carts WHERE id=$1")
                .bind(cart)
                .fetch_one(&mut **tx)
                .await?;
        let discounts = domain_pricing_promotions::Service::assess(
            tx,
            Some(customer),
            &pricing_lines,
            code,
            true,
        )
        .await?;
        for (item, line) in items.iter_mut().zip(&discounts.lines) {
            item.discount_amount = line.iter().map(|a| a.amount).sum();
            item.discount_snapshot = json!(line);
        }
        let delivery_fee = if pickup {
            Decimal::ZERO
        } else {
            let geography = l.geography.as_ref().map(|g| json!(g));
            domain_fulfillment::fees::cart_fee(tx, cart, l.area_id, geography.as_ref()).await?
        };
        let tax_snapshot = domain_tax::Service::assess(
            tx,
            l.latitude,
            l.longitude,
            subtotal - discounts.amount,
            delivery_fee,
        )
        .await?;
        let tax_amount = tax_snapshot.amount;
        domain_fulfillment::market_delivery::revalidate(tx, cart).await?;
        Ok((
            cart,
            Snapshot {
                market: Some(market_context),
                scheduled_delivery: if fulfillment_plan.is_some() {
                    None
                } else {
                    domain_fulfillment::capacity::checkout_selection(tx, customer, cart, location)
                        .await?
                },
                fulfillment_plan,
                gift_message: None,
                items,
                location: json!(l),
                contact: json!({"email":c.email,"mobile_number":c.mobile_number,"primary_identifier":c.primary_identifier}),
                subtotal,
                delivery_fee,
                total: subtotal - discounts.amount + delivery_fee + tax_amount,
                discount_amount: discounts.amount,
                discount_snapshot: discounts.applied,
                coupon_code: discounts.coupon_code,
                tax_amount,
                tax_snapshot,
                currency,
                payment_method: "cod".into(),
            },
        ))
    }
    #[tracing::instrument(skip_all, name = "checkout.quote")]
    pub async fn quote(&self, customer: Uuid, location: Uuid) -> Result<Quote> {
        self.quote_with_gift(customer, location, None).await
    }
    pub async fn quote_with_gift(
        &self,
        customer: Uuid,
        location: Uuid,
        gift: Option<String>,
    ) -> Result<Quote> {
        if gift.as_ref().is_some_and(|s| s.len() > 500) {
            return Err(Error::Invalid(
                "Gift message must be at most 500 characters".into(),
            ));
        }
        if location != Uuid::nil() && !sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM fulfillment.plans p JOIN cart_checkout.carts c ON c.id=p.cart_id WHERE c.customer_id=$1 AND p.status='HELD')").bind(customer).fetch_one(&self.pool).await? {
        domain_fulfillment::capacity::Service {
            pool: self.pool.clone(),
        }
        .ensure_automatic(customer, location)
        .await?;
        }
        let mut tx = domain_inventory::begin_cart(&self.pool, Some(customer), "", &[]).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        let (cart, mut snapshot) = Self::checkout_snapshot(&mut tx, customer, location).await?;
        snapshot.gift_message = gift.filter(|s| !s.trim().is_empty());
        let id = Uuid::new_v4();
        let (entity_id, expires_at)=sqlx::query_as("INSERT INTO cart_checkout.quotes(id,customer_id,cart_id,location_id,snapshot,expires_at) VALUES($1,$2,$3,$4,$5,LEAST(clock_timestamp()+interval '5 minutes',COALESCE((SELECT min(expires_at) FROM (SELECT expires_at FROM fulfillment.capacity_reservations WHERE cart_id=$3 AND status='HELD' UNION ALL SELECT expires_at FROM fulfillment.plans WHERE cart_id=$3 AND status='HELD') holds),'infinity'::timestamptz))) RETURNING entity_id,expires_at").bind(id).bind(customer).bind(cart).bind(location).bind(json!(snapshot)).fetch_one(&mut *tx).await?;
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        Ok(Quote {
            id,
            entity_id,
            expires_at,
            snapshot,
        })
    }
    #[tracing::instrument(skip_all, name = "checkout.place")]
    pub async fn place(&self, customer: Uuid, quote_id: Uuid, key: Uuid) -> Result<Detail> {
        let mut tx = domain_inventory::begin_cart(&self.pool, Some(customer), "", &[]).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        let existing: Option<(Uuid, Uuid)> = sqlx::query_as(
            "SELECT id,quote_id FROM orders.orders WHERE customer_id=$1 AND idempotency_key=$2",
        )
        .bind(customer)
        .bind(key)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some((id, original)) = existing {
            if original != quote_id {
                return Err(Error::Invalid(
                    "Idempotency key was already used for another checkout".into(),
                ));
            }
            // Lifecycle mutations use an order scope and may proceed independently
            // of this now-empty cart. Release cart/product locks before opening a
            // repeatable-read detail snapshot; taking an order lock here would
            // invert the order-before-products locking discipline.
            let committed = tx.commit().await;
            timer.finish(if committed.is_ok() {
                infra_observability::OperationResult::Success
            } else {
                infra_observability::OperationResult::Error
            });
            committed?;
            return domain_orders::Service {
                pool: self.pool.clone(),
            }
            .detail(id, Some(customer))
            .await;
        }
        let (location,stored):(Uuid,Value)=sqlx::query_as("SELECT location_id,snapshot FROM cart_checkout.quotes WHERE id=$1 AND customer_id=$2 AND expires_at>clock_timestamp()").bind(quote_id).bind(customer).fetch_optional(&mut *tx).await?.ok_or_else(||Error::Invalid("Checkout review expired or unavailable. Review your order again.".into()))?;
        let (cart, mut snapshot) = Self::checkout_snapshot(&mut tx, customer, location).await?;
        snapshot.gift_message = stored
            .get("gift_message")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if commercial_snapshot(stored) != commercial_snapshot(json!(snapshot)) {
            return Err(Error::Invalid(
                "Your cart, prices or delivery details changed. Review your order again.".into(),
            ));
        }
        let d = Self::place_snapshot(&mut tx, customer, cart, quote_id, key, snapshot).await?;
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        Ok(d)
    }

    /// Both reviewed checkout and direct reorder commit through the same commerce path.
    pub(super) async fn place_snapshot(
        tx: &mut domain_inventory::Tx<'_>,
        customer: Uuid,
        cart: Uuid,
        quote_id: Uuid,
        key: Uuid,
        snapshot: Snapshot,
    ) -> Result<Detail> {
        let current_market = market_context::for_cart(tx, cart).await?;
        if snapshot.market.as_ref() != Some(&current_market) {
            return Err(Error::Invalid(
                "MARKET_CHANGED: review your order again".into(),
            ));
        }
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency,tax_amount,tax_snapshot,discount_amount,discount_snapshot,coupon_code) VALUES($1,$2,$3,$4,'placed',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)").bind(id).bind(customer).bind(quote_id).bind(key).bind(&snapshot.location).bind(&snapshot.contact).bind(snapshot.subtotal).bind(snapshot.delivery_fee).bind(snapshot.total).bind(&snapshot.currency).bind(snapshot.tax_amount).bind(json!(snapshot.tax_snapshot)).bind(snapshot.discount_amount).bind(json!(snapshot.discount_snapshot)).bind(&snapshot.coupon_code).execute(&mut **tx).await?;
        sqlx::query("UPDATE orders.orders SET gift_message=$2 WHERE id=$1")
            .bind(id)
            .bind(&snapshot.gift_message)
            .execute(&mut **tx)
            .await?;
        sqlx::query("UPDATE orders.orders SET market_context=$2 WHERE id=$1")
            .bind(id)
            .bind(json!(snapshot.market))
            .execute(&mut **tx)
            .await?;
        for item in &snapshot.items {
            let allocations =
                Inventory::consume_reserved(tx, cart, item.product_id, item.quantity).await?;
            for a in allocations {
                sqlx::query("INSERT INTO inventory.order_allocations(order_id,product_id,source_id,quantity) VALUES($1,$2,$3,$4)").bind(id).bind(item.product_id).bind(a.source_id).bind(a.quantity).execute(&mut **tx).await?;
            }
            sqlx::query("INSERT INTO orders.order_items(order_id,product_id,sku,name,unit,quantity,price,line_total,discount_amount,discount_snapshot,market_facts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(id).bind(item.product_id).bind(&item.sku).bind(&item.name).bind(&item.unit).bind(item.quantity).bind(item.price).bind(item.line_total).bind(item.discount_amount).bind(&item.discount_snapshot).bind(&item.market_facts).execute(&mut **tx).await?;
        }
        domain_fulfillment::plans::confirm(tx, cart, id).await?;
        domain_fulfillment::capacity::confirm(tx, cart, id).await?;
        domain_fulfillment::Service::plan(tx, id).await?;
        CashOnDelivery
            .create(tx, id, snapshot.total, &snapshot.currency)
            .await?;
        domain_orders::history(tx, id, "placed", None, "Customer placed order").await?;
        sqlx::query("DELETE FROM cart_checkout.items WHERE cart_id=$1")
            .bind(cart)
            .execute(&mut **tx)
            .await?;
        sqlx::query(
            "UPDATE cart_checkout.carts SET coupon_code=NULL,market_delivery_date=NULL WHERE id=$1",
        )
        .bind(cart)
        .execute(&mut **tx)
        .await?;
        let d = domain_orders::Service::detail_in(tx, id, Some(customer)).await?;
        // Analytics excludes contact/address. Notification consumer resolves those from order storage.
        infra_events::record(tx,"order.placed",json!({"order_id":id,"customer_id":customer,"number":d.order.number,"total":snapshot.total.to_string(),"currency":snapshot.currency,"item_count":snapshot.items.iter().map(|i|i.quantity as i64).sum::<i64>()})).await?;
        Ok(d)
    }
}

// Older persisted receipts may predate numeric entity identifiers.
fn entity_id_missing(value: &i64) -> bool {
    *value == 0
}

// Read-only identifiers do not change the commercial terms of an existing review.
// Keep this path-specific: freeform attributes and UUID references remain facts.
fn commercial_snapshot(mut value: Value) -> Value {
    fn remove_number(value: &mut Value) {
        if value.get("entity_id").is_some_and(Value::is_number) {
            if let Some(object) = value.as_object_mut() {
                object.remove("entity_id");
            }
        }
    }
    for property in ["location", "scheduled_delivery"] {
        if let Some(part) = value.get_mut(property) {
            remove_number(part);
        }
    }
    if let Some(plan) = value.get_mut("fulfillment_plan") {
        remove_number(plan);
        if let Some(groups) = plan.get_mut("groups").and_then(Value::as_array_mut) {
            for group in groups {
                remove_number(group);
            }
        }
    }
    value
}

#[cfg(test)]
mod entity_identifier_tests {
    use super::*;

    #[test]
    fn reviews_ignore_only_entity_metadata_and_preserve_commercial_changes() {
        let old = json!({"location":{"id":"uuid-address","formatted_address":"12 Main Street"},"scheduled_delivery":{"id":"uuid-hold","starts_at":"2026-10-03T12:00:00Z"},"fulfillment_plan":{"id":"uuid-plan","groups":[{"id":"uuid-group","items":[{"product_id":"uuid-product","quantity":2}]}]},"total":"10.00","attributes":{"entity_id":87}});
        let mut new = old.clone();
        new["location"]["entity_id"] = json!(12);
        new["scheduled_delivery"]["entity_id"] = json!(13);
        new["fulfillment_plan"]["entity_id"] = json!(14);
        new["fulfillment_plan"]["groups"][0]["entity_id"] = json!(15);
        assert_eq!(commercial_snapshot(new.clone()), old);
        new["total"] = json!("11.00");
        assert_ne!(commercial_snapshot(new.clone()), old);
        new["total"] = json!("10.00");
        new["attributes"]["entity_id"] = json!(88);
        assert_ne!(commercial_snapshot(new.clone()), old);
        new["attributes"]["entity_id"] = json!(87);
        new["location"]["entity_id"] = json!("uuid-reference");
        assert_ne!(commercial_snapshot(new), old);
    }

    #[test]
    fn legacy_cart_receipt_deserializes_without_fabricating_a_number() {
        let mut receipt = json!({"id":"00000000-0000-0000-0000-000000000001","customer_id":null,"items":[],"subtotal":"0","currency":"USD","fully_reserved":false,"discount_amount":"0","discount_snapshot":[],"coupon_code":null,"coupon_error":null});
        // Use the current context fixture to focus this test on identifier compatibility.
        receipt["market"] = json!(market_context::Context {
            id: None,
            release_id: None,
            revision: 0,
            store_revision: 1,
            country: "US".into(),
            currency: "USD".into()
        });
        let cart: Cart = serde_json::from_value(receipt.clone()).unwrap();
        assert_eq!(cart.entity_id, 0);
        assert_eq!(json!(cart), receipt);
    }
}
