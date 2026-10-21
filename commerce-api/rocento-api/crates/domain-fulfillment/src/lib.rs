pub mod capabilities;
pub mod capacity;
pub mod fees;
mod pickup;
pub mod plans;
mod routing;
pub mod scheduling;
// Flat delivery fee and independently tracked shipments per inventory source.
use domain_inventory::Tx;
use infra_auth::{Error, Result};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;
#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
}
#[derive(Serialize, Deserialize, FromRow)]
pub struct Fee {
    #[serde(with = "rust_decimal::serde::str")]
    pub amount: Decimal,
    pub currency: String,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Serialize, Deserialize, FromRow)]
pub struct Shipment {
    #[serde(default, skip_serializing_if = "entity_id_missing")]
    pub entity_id: i64,
    pub id: Uuid,
    pub order_id: Uuid,
    pub source_id: Uuid,
    pub source_name: String,
    pub tracking_reference: String,
    pub status: String,
    pub method: String,
    pub dispatched_by: Option<Uuid>,
    pub dispatched_at: Option<chrono::DateTime<chrono::Utc>>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Serialize, Deserialize, FromRow)]
pub struct ShipmentItem {
    pub product_id: Uuid,
    pub quantity: i32,
}
#[derive(Serialize, Deserialize)]
pub struct Dispatch {
    pub shipment: Shipment,
    pub items: Vec<ShipmentItem>,
}
pub struct Destination {
    pub latitude: f64,
    pub longitude: f64,
    pub area_id: Option<Uuid>,
}
pub trait FulfillmentProvider {
    fn fee(
        &self,
        tx: &mut Tx<'_>,
        destination: &Destination,
    ) -> impl std::future::Future<Output = Result<Decimal>> + Send;
}
pub struct FlatRateFulfillment;
impl FulfillmentProvider for FlatRateFulfillment {
    async fn fee(&self, tx: &mut Tx<'_>, _destination: &Destination) -> Result<Decimal> {
        Ok(
            sqlx::query_scalar(
                "SELECT amount FROM fulfillment.delivery_fee_settings WHERE id=true",
            )
            .fetch_one(&mut **tx)
            .await?,
        )
    }
}
impl Service {
    pub async fn fee(&self) -> Result<Fee> {
        Ok(sqlx::query_as("SELECT amount,currency,updated_at FROM fulfillment.delivery_fee_settings WHERE id=true").fetch_one(&self.pool).await?)
    }
    pub async fn set_fee(
        &self,
        amount: &str,
        reason: &str,
        who: &domain_admin_iam::Identity,
    ) -> Result<Fee> {
        who.require("fulfillment.settings.write")?;
        let value: Decimal = amount
            .parse()
            .map_err(|_| Error::Invalid("Invalid delivery fee".into()))?;
        if value < Decimal::ZERO
            || value > Decimal::from(1000000)
            || value.scale() > 2
            || reason.trim().is_empty()
            || reason.len() > 300
        {
            return Err(Error::Invalid(
                "Fee must be 0–1000000 with at most two decimals; a reason is required".into(),
            ));
        }
        let mut tx = domain_inventory::begin(&self.pool).await?;
        let old: Decimal = sqlx::query_scalar(
            "SELECT amount FROM fulfillment.delivery_fee_settings WHERE id=true",
        )
        .fetch_one(&mut *tx)
        .await?;
        let fee=sqlx::query_as("UPDATE fulfillment.delivery_fee_settings SET amount=$1,updated_at=clock_timestamp() WHERE id=true RETURNING amount,currency,updated_at").bind(value).fetch_one(&mut *tx).await?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "admin.delivery_fee.updated",
            Uuid::nil(),
            json!({"before":old.to_string(),"after":value.to_string(),"reason":reason}),
        )
        .await?;
        tx.commit().await?;
        Ok(fee)
    }
    pub async fn read(tx: &mut Tx<'_>, order: Uuid) -> Result<Option<Dispatch>> {
        Ok(Self::read_all(tx, order)
            .await?
            .into_iter()
            .find(|d| !["pending", "cancelled"].contains(&d.shipment.status.as_str())))
    }
    pub async fn read_all(tx: &mut Tx<'_>, order: Uuid) -> Result<Vec<Dispatch>> {
        let shipments:Vec<Shipment>=sqlx::query_as("SELECT s.*,src.name source_name FROM fulfillment.shipments s JOIN inventory.inventory_sources src ON src.id=s.source_id WHERE order_id=$1 ORDER BY s.source_id").bind(order).fetch_all(&mut **tx).await?;
        let mut result = Vec::new();
        for shipment in shipments {
            let items=sqlx::query_as("SELECT product_id,quantity FROM fulfillment.shipment_items WHERE shipment_id=$1 ORDER BY product_id").bind(shipment.id).fetch_all(&mut **tx).await?;
            result.push(Dispatch { shipment, items });
        }
        Ok(result)
    }
    /// Called inside placement, after the original-source allocations are committed.
    pub async fn plan(tx: &mut Tx<'_>, order: Uuid) -> Result<()> {
        let sources:Vec<Uuid>=sqlx::query_scalar("SELECT DISTINCT source_id FROM inventory.order_allocations WHERE order_id=$1 ORDER BY source_id").bind(order).fetch_all(&mut **tx).await?;
        for source in sources {
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO fulfillment.shipments(id,order_id,source_id,tracking_reference,status) VALUES($1,$2,$3,'','pending')").bind(id).bind(order).bind(source).execute(&mut **tx).await?;
            sqlx::query("UPDATE fulfillment.shipments SET method=COALESCE((SELECT method FROM fulfillment.plans WHERE order_id=$2),'delivery') WHERE id=$1").bind(id).bind(order).execute(&mut **tx).await?;
            sqlx::query("INSERT INTO fulfillment.shipment_items(shipment_id,product_id,quantity) SELECT $1,product_id,quantity FROM inventory.order_allocations WHERE order_id=$2 AND source_id=$3").bind(id).bind(order).bind(source).execute(&mut **tx).await?;
        }
        Ok(())
    }
    pub async fn dispatch(
        tx: &mut Tx<'_>,
        shipment: Uuid,
        actor: Uuid,
        reference: &str,
    ) -> Result<()> {
        if reference.trim().is_empty()
            || reference.len() > 100
            || reference.chars().any(char::is_control)
        {
            return Err(Error::Invalid(
                "Tracking reference must contain 1–100 printable characters".into(),
            ));
        }
        if sqlx::query("UPDATE fulfillment.shipments SET tracking_reference=$2,status='shipped',dispatched_by=$3,dispatched_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND status='pending' AND method='delivery'").bind(shipment).bind(reference.trim()).bind(actor).execute(&mut **tx).await?.rows_affected()!=1 {return Err(Error::Conflict);}
        Ok(())
    }
    pub async fn update_status(tx: &mut Tx<'_>, order: Uuid, status: &str) -> Result<()> {
        if [
            "delivered",
            "delivery_failed",
            "cancelled",
            "pickup_ready",
            "picked_up",
        ]
        .contains(&status)
        {
            sqlx::query("UPDATE fulfillment.shipments SET status=$2,updated_at=clock_timestamp() WHERE order_id=$1").bind(order).bind(status).execute(&mut **tx).await?;
        }
        Ok(())
    }
}

pub mod market_delivery;

// Older persisted receipts may predate numeric entity identifiers.
fn entity_id_missing(value: &i64) -> bool {
    *value == 0
}
