//! Capability-aware stock routing and destination eligibility shared by plan reads and admission.
use crate::{
    capabilities::{self, Capabilities},
    capacity::{RequirementCalculator, StandardRequirement},
    plans::{Group, Line, Request},
};
use domain_inventory::Tx;
use infra_auth::{Error, Result};
use serde_json::{json, Value};
use uuid::Uuid;
fn invalid(code: &str) -> Error {
    Error::Invalid(code.into())
}
pub(crate) struct Context {
    pub(crate) cart: Uuid,
    pub(crate) store: Uuid,
    pub(crate) area: Option<Uuid>,
    pub(crate) fingerprint: Value,
    pub(crate) cap: Capabilities,
    pub(crate) lines: Vec<(Uuid, i32, Value)>,
}
pub(crate) async fn context(tx: &mut Tx<'_>, customer: Uuid, r: &Request) -> Result<Context> {
    let (cart, store): (Uuid, Uuid) = sqlx::query_as(
        "SELECT id,fulfillment_store_id FROM cart_checkout.carts WHERE customer_id=$1",
    )
    .bind(customer)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(Error::NotFound)?;
    let cap = capabilities::resolve(tx, store).await?;
    if r.method == "pickup" && r.asap && cap.pickup_scheduling_enabled {
        return Err(invalid("PICKUP_WINDOW_REQUIRED"));
    }
    if !["delivery", "pickup"].contains(&r.method.as_str()) {
        return Err(invalid("INVALID_FULFILLMENT_METHOD"));
    }
    cap.require(
        if r.method == "pickup" {
            cap.pickup_enabled
        } else {
            cap.delivery_enabled
        },
        &r.method,
    )?;
    let mut area = None;
    let address = if r.method == "delivery" {
        let address: Value = sqlx::query_scalar(
            "SELECT (to_jsonb(l)-'entity_id') FROM customers.customer_locations l WHERE id=$1 AND customer_id=$2",
        )
        .bind(
            r.location_id
                .ok_or_else(|| invalid("DELIVERY_ADDRESS_REQUIRED"))?,
        )
        .bind(customer)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)?;
        if cap.geofencing() {
            let (configured,resolved):(bool,Option<Uuid>)=sqlx::query_as("SELECT EXISTS(SELECT 1 FROM inventory.delivery_areas),inventory.resolve_delivery_area($1,$2)").bind(address["latitude"].as_f64()).bind(address["longitude"].as_f64()).fetch_one(&mut **tx).await?;
            if configured && resolved.is_none() {
                return Err(invalid("OUTSIDE_DELIVERY_AREA"));
            }
            area = resolved;
        } else if !cap.global_delivery()
            && !cap.delivery_city_ids.is_empty()
            && !cap
                .delivery_city_ids
                .iter()
                .any(|id| address["geography"]["city_id"].as_str() == Some(id))
        {
            return Err(invalid("OUTSIDE_DELIVERY_AREA"));
        }
        address
    } else {
        if r.location_id.is_some() {
            return Err(invalid("PICKUP_DOES_NOT_USE_DELIVERY_ADDRESS"));
        }
        Value::Null
    };
    let lines:Vec<(Uuid,i32,Value)>=sqlx::query_as("SELECT i.product_id,i.quantity,p.attributes FROM cart_checkout.items i JOIN catalog.products p ON p.id=i.product_id AND p.active AND p.in_stock WHERE cart_id=$1 ORDER BY i.product_id LIMIT 501").bind(cart).fetch_all(&mut **tx).await?;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM cart_checkout.items WHERE cart_id=$1")
            .bind(cart)
            .fetch_one(&mut **tx)
            .await?;
    if count != lines.len() as i64 {
        return Err(invalid("INVENTORY_UNAVAILABLE"));
    }
    StandardRequirement.calculate(&lines)?;
    let fingerprint = json!({"address":address,"lines":lines,"method":r.method,"source_id":r.source_id,"store_id":store,"area_id":area});
    Ok(Context {
        cart,
        store,
        area,
        fingerprint,
        cap,
        lines,
    })
}
pub(crate) async fn route(tx: &mut Tx<'_>, c: &Context, r: &Request) -> Result<Vec<Group>> {
    if (r.method == "pickup" || !c.cap.automatic_source_routing_enabled) && r.source_id.is_none() {
        return Err(invalid("FULFILLMENT_SOURCE_REQUIRED"));
    }
    let sources:Vec<(Uuid,String,Uuid)>=sqlx::query_as(r#"SELECT DISTINCT ON(s.id) s.id,s.name,l.stock_id FROM inventory.inventory_sources s
        JOIN inventory.source_stock_links l ON l.source_id=s.id JOIN inventory.stocks st ON st.id=l.stock_id
        JOIN fulfillment.stores store ON store.id=$1 LEFT JOIN fulfillment.store_sources ss ON ss.store_id=store.id AND ss.source_id=s.id
        WHERE s.is_enabled AND ($2::uuid IS NULL OR s.id=$2) AND (ss.source_id IS NOT NULL OR store.is_default)
        AND ($3<>'pickup' OR ss.pickup_enabled) AND ($3='pickup' OR ($4::uuid IS NULL AND (st.is_default OR ($5 AND st.is_global))) OR EXISTS(SELECT 1 FROM inventory.area_stock_links al WHERE al.stock_id=l.stock_id AND al.area_id=$4))
        ORDER BY s.id,l.priority,l.stock_id LIMIT 101"#).bind(c.store).bind(r.source_id).bind(&r.method).bind(c.area).bind(c.cap.global_delivery()).fetch_all(&mut **tx).await?;
    if sources.len() > 100 {
        return Err(invalid("TOO_MANY_FULFILLMENT_SOURCES"));
    }
    let source_ids: Vec<Uuid> = sources.iter().map(|(id, _, _)| *id).collect();
    let product_ids: Vec<Uuid> = c.lines.iter().map(|(id, _, _)| *id).collect();
    let stock:Vec<(Uuid,Uuid,i64)>=sqlx::query_as("SELECT i.source_id,i.product_id,i.quantity::bigint-COALESCE((SELECT SUM(a.quantity)::bigint FROM inventory.reservation_allocations a JOIN inventory.reservations r USING(cart_id,product_id) WHERE a.source_id=i.source_id AND a.product_id=i.product_id AND a.cart_id<>$3 AND r.expires_at>clock_timestamp()),0) FROM inventory.source_items i WHERE i.source_id=ANY($1) AND i.product_id=ANY($2) AND i.status='in_stock'").bind(&source_ids).bind(&product_ids).bind(c.cart).fetch_all(&mut **tx).await?;
    let quantities: std::collections::BTreeMap<_, _> =
        stock.into_iter().map(|(s, p, q)| ((s, p), q)).collect();
    let mut candidates = vec![];
    for (source, name, stock) in sources {
        let lines = c
            .lines
            .iter()
            .map(|(p, q, _)| Line {
                product_id: *p,
                quantity: quantities
                    .get(&(source, *p))
                    .copied()
                    .unwrap_or(0)
                    .max(0)
                    .min(i64::from(*q)) as i32,
                stock_id: stock,
            })
            .collect::<Vec<_>>();
        candidates.push((source, name, lines));
    }
    // A complete source with an open calendar/capacity is preferable to one that cannot book.
    if c.cap.scheduled(&r.method) && !r.asap && r.source_id.is_none() {
        let mut preferred = vec![];
        let mut remaining = vec![];
        for candidate in candidates {
            let facts: Vec<_> = candidate
                .2
                .iter()
                .filter(|l| l.quantity > 0)
                .map(|l| {
                    (
                        l.product_id,
                        l.quantity,
                        c.lines
                            .iter()
                            .find(|(p, _, _)| *p == l.product_id)
                            .unwrap()
                            .2
                            .clone(),
                    )
                })
                .collect();
            if facts.is_empty() {
                continue;
            }
            let mut probe = [Group {
                source_id: candidate.0,
                source_name: candidate.1.clone(),
                items: vec![],
                requirement: StandardRequirement.calculate(&facts)?,
                slots: vec![],
            }];
            crate::plans::automatic_slots(tx, c, r, &mut probe).await?;
            if !probe[0].slots.is_empty() {
                preferred.push(candidate);
            } else {
                remaining.push(candidate);
            }
        }
        if !preferred.is_empty() {
            candidates = preferred;
        } else {
            candidates = remaining;
        }
    }
    // Prefer a complete source, otherwise deterministically partition quantities across sources.
    let complete = candidates.iter().position(|(_, _, ls)| {
        ls.iter()
            .zip(&c.lines)
            .all(|(l, (_, q, _))| l.quantity == *q)
    });
    if let Some(index) = complete {
        let one = candidates.remove(index);
        candidates = vec![one];
    } else if r.method == "pickup" || !c.cap.multi_source_fulfillment_enabled {
        return Err(invalid("SINGLE_SOURCE_UNAVAILABLE"));
    }
    let mut remaining: Vec<i32> = c.lines.iter().map(|(_, q, _)| *q).collect();
    let mut groups = vec![];
    for (source, name, ls) in candidates {
        let items: Vec<Line> = ls
            .into_iter()
            .enumerate()
            .filter_map(|(i, mut l)| {
                l.quantity = l.quantity.min(remaining[i]);
                remaining[i] -= l.quantity;
                (l.quantity > 0).then_some(l)
            })
            .collect();
        if items.is_empty() {
            continue;
        }
        let facts: Vec<_> = items
            .iter()
            .map(|i| {
                (
                    i.product_id,
                    i.quantity,
                    c.lines
                        .iter()
                        .find(|(p, _, _)| *p == i.product_id)
                        .unwrap()
                        .2
                        .clone(),
                )
            })
            .collect();
        groups.push(Group {
            source_id: source,
            source_name: name,
            requirement: StandardRequirement.calculate(&facts)?,
            items,
            slots: vec![],
        });
    }
    if remaining.iter().any(|q| *q > 0) {
        return Err(invalid("INVENTORY_UNAVAILABLE"));
    }
    if groups.len() > 1
        && c.cap.scheduled(&r.method)
        && !r.asap
        && !c.cap.split_order_scheduling_enabled
    {
        return Err(invalid("SPLIT_SCHEDULING_DISABLED"));
    }
    Ok(groups)
}
