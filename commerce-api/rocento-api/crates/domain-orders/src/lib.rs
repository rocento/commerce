//! Immutable order snapshots and audited COD lifecycle.
pub mod bestsellers;
pub mod statuses;
use domain_inventory::Tx;
use infra_auth::{Error, Result};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;
#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
}
#[derive(Serialize, Deserialize, FromRow)]
pub struct Order {
    #[serde(default, skip_serializing_if = "entity_id_missing")]
    pub entity_id: i64,
    #[serde(default)]
    pub market_context: Option<Value>,
    #[serde(default)]
    pub gift_message: Option<String>,
    pub id: Uuid,
    pub number: i64,
    pub customer_id: Uuid,
    pub quote_id: Uuid,
    pub idempotency_key: Uuid,
    pub status: String,
    #[serde(default)]
    #[sqlx(default)]
    pub status_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub status_display: Option<Value>,
    #[serde(skip)]
    #[sqlx(default)]
    pub customer_status_display: Option<Value>,
    pub location: Value,
    pub contact: Value,
    #[serde(with = "rust_decimal::serde::str")]
    pub subtotal: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub discount_amount: Decimal,
    pub discount_snapshot: Value,
    pub coupon_code: Option<String>,
    #[serde(with = "rust_decimal::serde::str")]
    pub delivery_fee: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub total: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub tax_amount: Decimal,
    pub tax_snapshot: Value,
    pub currency: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Serialize, Deserialize, FromRow, PartialEq)]
pub struct Item {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub market_facts: Option<Value>,
    pub product_id: Uuid,
    pub sku: String,
    pub name: String,
    pub unit: String,
    pub quantity: i32,
    #[serde(with = "rust_decimal::serde::str")]
    pub price: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub line_total: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub discount_amount: Decimal,
    pub discount_snapshot: Value,
}
#[derive(Serialize, Deserialize, FromRow)]
pub struct History {
    pub id: Uuid,
    pub order_id: Uuid,
    pub status: String,
    pub actor_id: Option<Uuid>,
    pub reason: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Serialize, Deserialize)]
pub struct Detail {
    pub scheduled_deliveries: Vec<Value>,
    pub order: Order,
    pub items: Vec<Item>,
    pub history: Vec<History>,
    pub payment: domain_payments::Payment,
    pub refunds: Vec<domain_payments::Refund>,
    pub dispatch: Option<domain_fulfillment::Dispatch>,
    pub shipments: Vec<domain_fulfillment::Dispatch>,
    pub fulfillment_plan: Option<Value>,
}
/// A read-only sales projection; historical/imported orders need not have a
/// payment, dispatch or fulfillment record to appear in catalog reporting.
#[derive(Serialize)]
pub struct SalesOrder {
    pub order: Order,
    pub items: Vec<Item>,
}
#[derive(FromRow)]
struct SalesItem {
    order_id: Uuid,
    #[sqlx(flatten)]
    item: Item,
}
pub fn transitions(status: &str) -> &'static [&'static str] {
    match status {
        "placed" => &["confirmed", "cancelled"],
        "confirmed" => &["fulfilling", "cancelled"],
        "fulfilling" => &["shipped", "cancelled"],
        "shipped" => &["delivered", "delivery_failed"],
        "delivered" | "picked_up" => &["cash_collected"],
        "pickup_ready" => &["picked_up", "cancelled"],
        _ => &[],
    }
}
pub async fn history(
    tx: &mut Tx<'_>,
    order: Uuid,
    status: &str,
    actor: Option<Uuid>,
    reason: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO orders.order_status_history(id,order_id,status,actor_id,reason) VALUES($1,$2,$3,$4,$5)").bind(Uuid::new_v4()).bind(order).bind(status).bind(actor).bind(reason).execute(&mut **tx).await?;
    Ok(())
}
impl Service {
    pub async fn detail_in(tx: &mut Tx<'_>, id: Uuid, customer: Option<Uuid>) -> Result<Detail> {
        let mut order: Order = sqlx::query_as(
            "SELECT * FROM orders.orders_with_status WHERE id=$1 AND ($2::uuid IS NULL OR customer_id=$2)",
        )
        .bind(id)
        .bind(customer)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)?;
        if customer.is_some() {
            order.status_display = order.customer_status_display.take();
        }
        let items=sqlx::query_as("SELECT product_id,sku,name,unit,quantity,price,line_total,discount_amount,discount_snapshot,market_facts FROM orders.order_items WHERE order_id=$1 ORDER BY product_id").bind(id).fetch_all(&mut **tx).await?;
        let history = sqlx::query_as(
            "SELECT * FROM orders.order_status_history WHERE order_id=$1 ORDER BY created_at,id",
        )
        .bind(id)
        .fetch_all(&mut **tx)
        .await?;
        Ok(Detail {
            fulfillment_plan: domain_fulfillment::plans::order_snapshot(tx,id).await?,
            scheduled_deliveries: sqlx::query_scalar("SELECT jsonb_build_object('id',r.id,'entity_id',r.entity_id,'source_id',r.source_id,'source_name',s.name,'area_id',r.area_id,'method',r.method,'starts_at',r.starts_at,'ends_at',r.ends_at,'requirement',r.requirement,'status',r.status,'timezone',r.timezone) FROM fulfillment.capacity_reservations r JOIN inventory.inventory_sources s ON s.id=r.source_id LEFT JOIN fulfillment.schedules sc ON sc.id=r.schedule_id WHERE r.order_id=$1 ORDER BY r.starts_at,r.source_id").bind(id).fetch_all(&mut **tx).await?,
            dispatch: domain_fulfillment::Service::read(tx, id).await?,
            shipments: domain_fulfillment::Service::read_all(tx, id).await?,
            order,
            items,
            history,
            payment: domain_payments::read(tx, id).await?,
            refunds: domain_payments::refunds(tx, id).await?,
        })
    }
    pub async fn detail(&self, id: Uuid, customer: Option<Uuid>) -> Result<Detail> {
        let mut tx = self.pool.begin().await?;
        // A single stable snapshot keeps order state, history and payment collection consistent.
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            .execute(&mut *tx)
            .await?;
        let d = Self::detail_in(&mut tx, id, customer).await?;
        tx.commit().await?;
        Ok(d)
    }
    pub async fn detail_by_number(&self, number: i64, customer: Uuid) -> Result<Detail> {
        if number <= 0 {
            return Err(Error::NotFound);
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            .execute(&mut *tx)
            .await?;
        let id: Uuid =
            sqlx::query_scalar("SELECT id FROM orders.orders WHERE number=$1 AND customer_id=$2")
                .bind(number)
                .bind(customer)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(Error::NotFound)?;
        let detail = Self::detail_in(&mut tx, id, Some(customer)).await?;
        tx.commit().await?;
        Ok(detail)
    }
    pub async fn list(&self, customer: Option<Uuid>, offset: i64) -> Result<Vec<Order>> {
        if !(0..=1000000).contains(&offset) {
            return Err(Error::Invalid("Invalid offset".into()));
        }
        let mut rows: Vec<Order> = sqlx::query_as("SELECT * FROM orders.orders_with_status WHERE ($1::uuid IS NULL OR customer_id=$1) ORDER BY created_at DESC,id LIMIT 50 OFFSET $2").bind(customer).bind(offset).fetch_all(&self.pool).await?;
        if customer.is_some() {
            for row in &mut rows {
                row.status_display = row.customer_status_display.take();
            }
        }
        Ok(rows)
    }
    pub async fn sales_page(&self, offset: i64) -> Result<Vec<SalesOrder>> {
        if !(0..=1000000).contains(&offset) {
            return Err(Error::Invalid("Invalid offset".into()));
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *tx)
            .await?;
        let orders: Vec<Order> = sqlx::query_as(
            "SELECT * FROM orders.orders_with_status ORDER BY created_at DESC,id LIMIT 50 OFFSET $1",
        )
        .bind(offset)
        .fetch_all(&mut *tx)
        .await?;
        let ids: Vec<Uuid> = orders.iter().map(|order| order.id).collect();
        let items: Vec<SalesItem> = sqlx::query_as("SELECT order_id,product_id,sku,name,unit,quantity,price,line_total,discount_amount,discount_snapshot,market_facts FROM orders.order_items WHERE order_id=ANY($1) ORDER BY order_id,product_id")
            .bind(&ids).fetch_all(&mut *tx).await?;
        let mut by_order = std::collections::HashMap::<Uuid, Vec<Item>>::new();
        for row in items {
            by_order.entry(row.order_id).or_default().push(row.item);
        }
        tx.commit().await?;
        Ok(orders
            .into_iter()
            .map(|order| SalesOrder {
                items: by_order.remove(&order.id).unwrap_or_default(),
                order,
            })
            .collect())
    }
    pub async fn oldest(&self, customer: Uuid) -> Result<Vec<Order>> {
        let mut rows: Vec<Order> = sqlx::query_as("SELECT * FROM orders.orders_with_status WHERE customer_id=$1 ORDER BY created_at ASC,id ASC LIMIT 1").bind(customer).fetch_all(&self.pool).await?;
        for row in &mut rows {
            row.status_display = row.customer_status_display.take();
        }
        Ok(rows)
    }
    pub async fn transition(
        &self,
        id: Uuid,
        who: &domain_admin_iam::Identity,
        status: &str,
        reason: &str,
    ) -> Result<Detail> {
        who.require(if status == "cash_collected" {
            "payments.collect"
        } else {
            "orders.write"
        })?;
        if reason.trim().is_empty() || reason.len() > 300 {
            return Err(Error::Invalid(
                "A reason of 1–300 characters is required".into(),
            ));
        }
        if status == "shipped" {
            return Err(Error::Invalid(
                "Use Dispatch with a tracking reference to ship this order".into(),
            ));
        }
        let mut tx = domain_inventory::begin_order(&self.pool, id).await?;
        let old = Self::detail_in(&mut tx, id, None).await?;
        let pickup = old.shipments.iter().any(|s| s.shipment.method == "pickup");
        let allowed = if pickup && old.order.status == "fulfilling" {
            ["pickup_ready", "cancelled"].contains(&status)
        } else {
            transitions(&old.order.status).contains(&status)
        };
        if !allowed || (!pickup && ["pickup_ready", "picked_up"].contains(&status)) {
            return Err(Error::Invalid(format!(
                "Cannot move {} to {status}",
                old.order.status
            )));
        }
        if ["delivered", "delivery_failed"].contains(&status) && old.shipments.len() > 1 {
            return Err(Error::Invalid("Update each shipment independently".into()));
        }
        if status == "cash_collected" {
            domain_payments::collect(&mut tx, id, who.user.id).await?;
        }
        if status == "cancelled" {
            domain_fulfillment::capacity::cancel(&mut tx, id, &old.order.status).await?;
            domain_inventory::Service::restock_order(&mut tx, id).await?;
        }
        sqlx::query("UPDATE orders.orders SET status=$2,updated_at=clock_timestamp() WHERE id=$1")
            .bind(id)
            .bind(status)
            .execute(&mut *tx)
            .await?;
        domain_fulfillment::Service::update_status(&mut tx, id, status).await?;
        history(&mut tx, id, status, Some(who.user.id), reason).await?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "admin.order.status_changed",
            id,
            json!({"from":old.order.status,"to":status,"reason":reason}),
        )
        .await?;
        infra_events::record(
            &mut tx,
            "order.status_changed",
            json!({"order_id":id,"status":status}),
        )
        .await?;
        let d = Self::detail_in(&mut tx, id, None).await?;
        tx.commit().await?;
        Ok(d)
    }
    pub async fn refund(
        &self,
        id: Uuid,
        who: &domain_admin_iam::Identity,
        reason: &str,
    ) -> Result<Detail> {
        who.require("payments.refund")?;
        if reason.trim().is_empty() || reason.len() > 300 {
            return Err(Error::Invalid(
                "A reason of 1–300 characters is required".into(),
            ));
        }
        let mut tx = domain_inventory::begin_order(&self.pool, id).await?;
        Self::detail_in(&mut tx, id, None).await?;
        domain_payments::refund(&mut tx, id, who.user.id, reason).await?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "admin.order.manual_refund",
            id,
            json!({"reason":reason}),
        )
        .await?;
        infra_events::record(&mut tx, "order.refunded", json!({"order_id":id})).await?;
        let d = Self::detail_in(&mut tx, id, None).await?;
        tx.commit().await?;
        Ok(d)
    }
}

impl Service {
    pub async fn dispatch(
        &self,
        id: Uuid,
        who: &domain_admin_iam::Identity,
        reference: &str,
        reason: &str,
    ) -> Result<Detail> {
        self.dispatch_shipment(id, None, who, reference, reason)
            .await
    }
    pub async fn dispatch_shipment(
        &self,
        id: Uuid,
        shipment: Option<Uuid>,
        who: &domain_admin_iam::Identity,
        reference: &str,
        reason: &str,
    ) -> Result<Detail> {
        who.require("fulfillment.dispatch")?;
        if reason.trim().is_empty() || reason.len() > 300 {
            return Err(Error::Invalid(
                "A dispatch reason of 1–300 characters is required".into(),
            ));
        }
        let mut tx = domain_inventory::begin_order(&self.pool, id).await?;
        let old = Self::detail_in(&mut tx, id, None).await?;
        let selected = if let Some(s) = shipment {
            old.shipments
                .iter()
                .find(|d| d.shipment.id == s)
                .ok_or(Error::NotFound)?
        } else {
            if old.shipments.len() != 1 {
                return Err(Error::Invalid("Choose a shipment to dispatch".into()));
            }
            &old.shipments[0]
        };
        if selected.shipment.status != "pending" {
            if selected.shipment.tracking_reference == reference.trim()
                && !reference.trim().is_empty()
            {
                tx.commit().await?;
                return Ok(old);
            }
            return Err(Error::Conflict);
        }
        if !["fulfilling", "shipped"].contains(&old.order.status.as_str()) {
            return Err(Error::Invalid(
                "Only fulfilling orders can be dispatched".into(),
            ));
        }
        let shipment = selected.shipment.id;
        let first_dispatch = old.order.status != "shipped";
        domain_fulfillment::Service::dispatch(&mut tx, shipment, who.user.id, reference).await?;
        infra_events::record(
            &mut tx,
            "shipment.dispatched",
            json!({"order_id":id,"shipment_id":shipment,"tracking_reference":reference.trim(),"notified_via_order_event":first_dispatch}),
        )
        .await?;
        if first_dispatch {
            sqlx::query("UPDATE orders.orders SET status='shipped',updated_at=clock_timestamp() WHERE id=$1").bind(id).execute(&mut *tx).await?;
            history(&mut tx, id, "shipped", Some(who.user.id), reason).await?;
            infra_events::record(
                &mut tx,
                "order.shipped",
                // First-dispatch notifications retain their original event and
                // durable consumer, including during mixed-version rollouts.
                json!({"order_id":id,"shipment_id":shipment,"tracking_reference":reference.trim()}),
            )
            .await?;
        }
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "admin.order.dispatched",
            id,
            json!({"shipment_id":shipment,"tracking_reference":reference.trim(),"reason":reason}),
        )
        .await?;
        let detail = Self::detail_in(&mut tx, id, None).await?;
        tx.commit().await?;
        Ok(detail)
    }
    pub async fn shipment_status(
        &self,
        shipment: Uuid,
        who: &domain_admin_iam::Identity,
        status: &str,
        reason: &str,
    ) -> Result<Detail> {
        who.require("orders.write")?;
        if !["delivered", "delivery_failed"].contains(&status)
            || reason.trim().is_empty()
            || reason.len() > 300
        {
            return Err(Error::Invalid(
                "Choose delivered or delivery failed and provide a reason".into(),
            ));
        }
        let mut tx = domain_inventory::begin(&self.pool).await?;
        let (order, old): (Uuid, String) =
            sqlx::query_as("SELECT order_id,status FROM fulfillment.shipments WHERE id=$1")
                .bind(shipment)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(Error::NotFound)?;
        if old == status {
            let d = Self::detail_in(&mut tx, order, None).await?;
            tx.commit().await?;
            return Ok(d);
        }
        if old != "shipped" {
            return Err(Error::Invalid(
                "Only dispatched shipments can be completed".into(),
            ));
        }
        sqlx::query(
            "UPDATE fulfillment.shipments SET status=$2,updated_at=clock_timestamp() WHERE id=$1",
        )
        .bind(shipment)
        .bind(status)
        .execute(&mut *tx)
        .await?;
        let statuses: Vec<String> =
            sqlx::query_scalar("SELECT status FROM fulfillment.shipments WHERE order_id=$1")
                .bind(order)
                .fetch_all(&mut *tx)
                .await?;
        let aggregate = if statuses.iter().all(|s| s == "delivered") {
            Some("delivered")
        } else if statuses
            .iter()
            .all(|s| ["delivered", "delivery_failed"].contains(&s.as_str()))
        {
            Some("delivery_failed")
        } else {
            None
        };
        if let Some(next) = aggregate {
            sqlx::query(
                "UPDATE orders.orders SET status=$2,updated_at=clock_timestamp() WHERE id=$1",
            )
            .bind(order)
            .bind(next)
            .execute(&mut *tx)
            .await?;
            history(&mut tx, order, next, Some(who.user.id), reason).await?;
            infra_events::record(
                &mut tx,
                "order.status_changed",
                json!({"order_id":order,"status":next}),
            )
            .await?;
        }
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "admin.shipment.status_changed",
            shipment,
            json!({"order_id":order,"from":old,"to":status,"reason":reason}),
        )
        .await?;
        let d = Self::detail_in(&mut tx, order, None).await?;
        tx.commit().await?;
        Ok(d)
    }
}

#[derive(Serialize, FromRow)]
pub struct Comment {
    pub id: Uuid,
    pub order_id: Uuid,
    pub admin_id: Uuid,
    pub body: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Serialize)]
pub struct Extensions {
    pub state: String,
    pub delivery_location_snapshot: Value,
    pub gift_message: Option<String>,
}
impl Service {
    pub async fn extensions(&self, id: Uuid, customer: Option<Uuid>) -> Result<Extensions> {
        let d = self.detail(id, customer).await?;
        let state = match d.order.status.as_str() {
            "placed" => "new",
            "cash_collected" => "complete",
            "cancelled" => "canceled",
            "delivery_failed" => "holded",
            _ => "processing",
        };
        Ok(Extensions {
            state: state.into(),
            delivery_location_snapshot: d.order.location,
            gift_message: d.order.gift_message,
        })
    }
    pub async fn comments(
        &self,
        id: Uuid,
        who: &domain_admin_iam::Identity,
    ) -> Result<Vec<Comment>> {
        who.require("orders.read")?;
        self.detail(id, None).await?;
        Ok(sqlx::query_as("SELECT * FROM orders.order_comments WHERE order_id=$1 ORDER BY created_at,id LIMIT 500").bind(id).fetch_all(&self.pool).await?)
    }
    pub async fn comment(
        &self,
        id: Uuid,
        who: &domain_admin_iam::Identity,
        body: &str,
    ) -> Result<Comment> {
        who.require("orders.write")?;
        if body.trim().is_empty() || body.len() > 4000 {
            return Err(Error::Invalid("Enter a note of 1–4000 characters".into()));
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT id FROM orders.orders WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::NotFound)?;
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM orders.order_comments WHERE order_id=$1")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
        if count >= 500 {
            return Err(Error::Invalid("At most 500 notes per order".into()));
        }
        let note=sqlx::query_as("INSERT INTO orders.order_comments(id,order_id,admin_id,body) VALUES($1,$2,$3,$4) RETURNING *").bind(Uuid::new_v4()).bind(id).bind(who.user.id).bind(body.trim()).fetch_one(&mut *tx).await?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "admin.order.comment_added",
            id,
            json!({"note_added":true}),
        )
        .await?;
        tx.commit().await?;
        Ok(note)
    }
}

// Older persisted receipts may predate numeric entity identifiers.
fn entity_id_missing(value: &i64) -> bool {
    *value == 0
}
