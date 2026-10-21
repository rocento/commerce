//! Read-only proposed-basket date admission using the existing schedule and capacity ports.
use crate::{
    capacity::{self, RequirementCalculator, StandardRequirement},
    scheduling::{self, Schedule},
};
use domain_inventory::Tx;
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Available,
    DateRequired,
    SignInAndAddressRequired,
    SchedulingDisabled,
    OutsideDeliveryArea,
    HandlingUnverified,
    NoCapacity,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct DateCheck {
    pub available: bool,
    pub reason: Reason,
    pub date: String,
    pub reservation_required: bool,
}
fn result(date: &str, reason: Reason) -> DateCheck {
    DateCheck {
        available: matches!(reason, Reason::Available),
        reason,
        date: date.into(),
        reservation_required: true,
    }
}
pub async fn check(
    tx: &mut Tx<'_>,
    cart: Uuid,
    customer: Option<Uuid>,
    location: Option<Uuid>,
    rows: &BTreeMap<Uuid, i32>,
    date: &str,
) -> Result<DateCheck> {
    let Ok(day) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") else {
        return Ok(result(date, Reason::DateRequired));
    };
    if day.to_string() != date {
        return Ok(result(date, Reason::DateRequired));
    }
    let (Some(customer), Some(location)) = (customer, location) else {
        return Ok(result(date, Reason::SignInAndAddressRequired));
    };
    let cap = crate::capabilities::for_cart(tx, cart).await?;
    if !cap.scheduled_delivery_enabled || !cap.capacity_management_enabled {
        return Ok(result(date, Reason::SchedulingDisabled));
    }
    let address:Option<(Option<Uuid>,Option<Value>)>=sqlx::query_as("SELECT inventory.resolve_delivery_area(l.latitude,l.longitude),l.geography FROM customers.customer_locations l JOIN cart_checkout.carts c ON c.customer_id=l.customer_id WHERE c.id=$1 AND l.customer_id=$2 AND l.id=$3").bind(cart).bind(customer).bind(location).fetch_optional(&mut **tx).await?;
    let (mut area, geography) = address.ok_or(Error::NotFound)?;
    let configured: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM inventory.delivery_areas)")
            .fetch_one(&mut **tx)
            .await?;
    if cap.geofencing() && configured && area.is_none()
        || !cap.global_delivery()
            && !cap.geofencing()
            && !cap.delivery_city_ids.is_empty()
            && !geography
                .as_ref()
                .and_then(|g| g["city_id"].as_str())
                .is_some_and(|c| cap.delivery_city_ids.iter().any(|s| s == c))
    {
        return Ok(result(date, Reason::OutsideDeliveryArea));
    }
    if !cap.geofencing() {
        area = None;
    }
    let mut lines = vec![];
    for (id, q) in rows {
        let attrs: Value = sqlx::query_scalar(
            "SELECT attributes FROM catalog.products WHERE id=$1 AND active AND in_stock",
        )
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)?;
        if ["requires_cold_chain", "restricted", "perishable"]
            .iter()
            .any(|k| attrs.get(k).is_some_and(|v| v != &Value::Bool(false)))
        {
            return Ok(result(date, Reason::HandlingUnverified));
        }
        lines.push((*id, *q, attrs));
    }
    let requirement = StandardRequirement.calculate(&lines)?;
    let cart_lines = json!(rows
        .iter()
        .map(|(id, q)| json!({"product_id":id,"quantity":q}))
        .collect::<Vec<_>>());
    let sources:Vec<Uuid>=sqlx::query_scalar("SELECT s.id FROM inventory.inventory_sources s WHERE s.is_enabled AND EXISTS(SELECT 1 FROM cart_checkout.carts c JOIN fulfillment.stores st ON st.id=c.fulfillment_store_id WHERE c.id=$1 AND st.enabled AND (st.is_default OR EXISTS(SELECT 1 FROM fulfillment.store_sources ss WHERE ss.store_id=st.id AND ss.source_id=s.id))) AND EXISTS(SELECT 1 FROM inventory.source_stock_links l JOIN inventory.stocks st ON st.id=l.stock_id WHERE l.source_id=s.id AND (($3 AND EXISTS(SELECT 1 FROM inventory.area_stock_links al WHERE al.stock_id=l.stock_id AND al.area_id=$2)) OR (NOT $3 AND (st.is_default OR ($5 AND st.is_global))))) AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($4) AS c(product_id uuid,quantity integer) WHERE NOT EXISTS(SELECT 1 FROM inventory.source_items i WHERE i.source_id=s.id AND i.product_id=c.product_id AND i.status='in_stock' AND i.quantity-COALESCE((SELECT SUM(a.quantity) FROM inventory.reservation_allocations a JOIN inventory.reservations r USING(cart_id,product_id) WHERE a.source_id=s.id AND a.product_id=c.product_id AND a.cart_id<>$1 AND r.expires_at>clock_timestamp()),0)>=c.quantity)) ORDER BY s.id LIMIT 100").bind(cart).bind(area).bind(configured&&cap.geofencing()).bind(cart_lines).bind(cap.global_delivery()).fetch_all(&mut **tx).await?;
    let schedules:Vec<Schedule>=sqlx::query_as("SELECT DISTINCT ON(source_id,method) * FROM fulfillment.schedules WHERE (area_id IS NULL OR area_id=$1) AND method IN ('delivery','scheduled_delivery') ORDER BY source_id,method,area_id NULLS LAST LIMIT 200").bind(area).fetch_all(&mut **tx).await?;
    let mut evaluated = 0;
    for schedule in schedules {
        if !sources.contains(&schedule.source_id) {
            continue;
        }
        for slot in scheduling::generate(tx, &schedule, day).await? {
            evaluated += 1;
            if evaluated > 200 {
                return Ok(result(date, Reason::NoCapacity));
            }
            let buckets = capacity::buckets(tx, &slot, area).await?;
            // A date is capacity-backed only when a reviewed capacity rule actually covers it.
            if !buckets.is_empty()
                && capacity::admit(tx, &buckets, &requirement, None, false).await?
            {
                return Ok(result(date, Reason::Available));
            }
        }
    }
    Ok(result(date, Reason::NoCapacity))
}
/// Quote and placement run under the inventory transaction. Every group must have a live hold on the requested local date.
pub async fn revalidate(tx: &mut Tx<'_>, cart: Uuid) -> Result<()> {
    let requested: Option<String> =
        sqlx::query_scalar("SELECT market_delivery_date FROM cart_checkout.carts WHERE id=$1")
            .bind(cart)
            .fetch_one(&mut **tx)
            .await?;
    if let Some(date) = requested {
        let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fulfillment.capacity_reservations WHERE cart_id=$1 AND status='HELD') AND NOT EXISTS(SELECT 1 FROM fulfillment.capacity_reservations WHERE cart_id=$1 AND status='HELD' AND (expires_at<=clock_timestamp() OR method NOT IN ('delivery','scheduled_delivery') OR to_char(starts_at AT TIME ZONE timezone,'YYYY-MM-DD')<>$2))").bind(cart).bind(date).fetch_one(&mut **tx).await?;
        if !valid {
            return Err(Error::Invalid(
                "REQUESTED_DELIVERY_DATE_REQUIRES_MATCHING_LIVE_RESERVATION".into(),
            ));
        }
    }
    Ok(())
}
