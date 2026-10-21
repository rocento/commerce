use crate::routing::{context, route, Context};
// A fulfillment plan owns groups; all stock routing and capacity admission commit together.
use crate::{
    capabilities::{self, Capabilities},
    capacity::{self, Dimensions},
    scheduling::{self, Config, Schedule, Slot},
};
use chrono::{DateTime, NaiveDate, Utc};
use domain_inventory::Tx;
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;
fn invalid(code: &str) -> Error {
    Error::Invalid(code.into())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub method: String,
    pub location_id: Option<Uuid>,
    pub source_id: Option<Uuid>,
    pub date: NaiveDate,
    #[serde(default)]
    pub asap: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Window {
    pub source_id: Uuid,
    pub schedule_id: Uuid,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub request: Request,
    pub windows: Vec<Window>,
    pub idempotency_key: Uuid,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Line {
    pub product_id: Uuid,
    pub quantity: i32,
    pub stock_id: Uuid,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Group {
    pub source_id: Uuid,
    pub source_name: String,
    pub items: Vec<Line>,
    pub requirement: Dimensions,
    pub slots: Vec<Slot>,
}
#[derive(Serialize)]
pub struct Options {
    pub capabilities: Capabilities,
    pub groups: Vec<Group>,
    pub common_windows: Vec<(DateTime<Utc>, DateTime<Utc>)>,
}
async fn slots(tx: &mut Tx<'_>, c: &Context, r: &Request, groups: &mut [Group]) -> Result<()> {
    if r.asap || !c.cap.scheduled(&r.method) {
        if r.method == "delivery" {
            c.cap
                .require(c.cap.asap_delivery_enabled, "asap_delivery")?;
        }
        if r.method == "pickup" {
            let now = capacity::database_now(tx).await?;
            for group in groups {
                crate::pickup::asap(tx, c.store, group.source_id, &r.method, now).await?;
            }
        }
        return Ok(());
    }
    for group in groups {
        let calendars:Vec<Schedule>=sqlx::query_as("SELECT DISTINCT ON(method) * FROM fulfillment.schedules WHERE source_id=$1 AND (method=$2 OR ($2='delivery' AND method NOT IN ('pickup','curbside'))) AND (area_id IS NULL OR area_id=$3) ORDER BY method,area_id NULLS LAST LIMIT 201").bind(group.source_id).bind(&r.method).bind(c.area).fetch_all(&mut **tx).await?;
        if calendars.len() > 200 {
            return Err(invalid("TOO_MANY_FULFILLMENT_CALENDARS"));
        }
        group.slots.clear();
        for schedule in calendars {
            group
                .slots
                .extend(scheduling::generate(tx, &schedule, r.date).await?);
        }
        group
            .slots
            .sort_by_key(|s| (s.starts_at, s.ends_at, s.schedule_id));
        if group.slots.len() > 2000 {
            return Err(invalid("TOO_MANY_FULFILLMENT_WINDOWS"));
        }
        if c.cap.capacity_management_enabled {
            let rows: Vec<(i64, bool, bool)> = sqlx::query_as(&format!(
                "{}{}",
                include_str!("capacity_snapshot.sql"),
                include_str!("availability.sql")
            ))
            .bind(json!(group.slots))
            .bind(c.area)
            .bind(json!(group.requirement))
            .bind(Option::<Uuid>::None)
            .fetch_all(&mut **tx)
            .await?;
            group.slots = group
                .slots
                .drain(..)
                .enumerate()
                .filter_map(|(i, mut s)| {
                    let (_, available, limited) = rows[i];
                    if limited {
                        s.availability = "LIMITED".into();
                    }
                    available.then_some(s)
                })
                .collect();
        }
    }
    Ok(())
}
pub(crate) async fn automatic_slots(
    tx: &mut Tx<'_>,
    c: &Context,
    r: &Request,
    groups: &mut [Group],
) -> Result<()> {
    if r.method != "delivery"
        || c.cap.customer_delivery_slot_selection_enabled
        || !c.cap.scheduled_delivery_enabled
        || r.asap
    {
        return slots(tx, c, r, groups).await;
    }
    let mut candidate = r.clone();
    for offset in 0..=60 {
        candidate.date = r.date + chrono::Duration::days(offset);
        slots(tx, c, &candidate, groups).await?;
        let compatible = if c.cap.split_delivery_mode == "same_window_required" {
            groups.first().is_some_and(|g| {
                g.slots.iter().any(|s| {
                    groups.iter().all(|g| {
                        g.slots
                            .iter()
                            .any(|x| x.starts_at == s.starts_at && x.ends_at == s.ends_at)
                    })
                })
            })
        } else {
            groups.iter().all(|g| !g.slots.is_empty())
        };
        if compatible {
            return Ok(());
        }
    }
    Ok(())
}

pub async fn options(pool: &PgPool, customer: Uuid, r: Request) -> Result<Options> {
    let mut tx = domain_inventory::begin(pool).await?;
    let c = context(&mut tx, customer, &r).await?;
    // Own holds are excluded while recalculating; rollback restores them after this read.
    sqlx::query("UPDATE fulfillment.capacity_reservations SET status='RELEASED' WHERE cart_id=$1 AND status='HELD'").bind(c.cart).execute(&mut *tx).await?;
    let mut groups = route(&mut tx, &c, &r).await?;
    automatic_slots(&mut tx, &c, &r, &mut groups).await?;
    let mut common: Vec<_> = groups
        .first()
        .map(|g| {
            g.slots
                .iter()
                .filter(|s| {
                    groups.iter().all(|g| {
                        g.slots
                            .iter()
                            .any(|x| x.starts_at == s.starts_at && x.ends_at == s.ends_at)
                    })
                })
                .map(|s| (s.starts_at, s.ends_at))
                .collect()
        })
        .unwrap_or_default();
    common.sort();
    common.dedup();
    tx.rollback().await?;
    Ok(Options {
        capabilities: c.cap,
        groups,
        common_windows: common,
    })
}
async fn snapshot(tx: &mut Tx<'_>, id: Uuid) -> Result<Value> {
    Ok(sqlx::query_scalar(r#"SELECT jsonb_build_object('id',p.id,'entity_id',p.entity_id,'method',p.method,'store_id',p.store_id,'location_id',p.location_id,'expires_at',p.expires_at,'status',p.status,'groups',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',g.id,'entity_id',g.entity_id,'source_id',g.source_id,'source_name',s.name,'method',g.method,'schedule_id',g.schedule_id,'starts_at',g.starts_at,'ends_at',g.ends_at,'timezone',g.timezone,'items',(SELECT jsonb_agg(jsonb_build_object('product_id',i.product_id,'quantity',i.quantity)) FROM fulfillment.plan_items i WHERE i.group_id=g.id)) ORDER BY g.source_id) FROM fulfillment.plan_groups g JOIN inventory.inventory_sources s ON s.id=g.source_id WHERE g.plan_id=p.id),'[]'::jsonb)) FROM fulfillment.plans p WHERE id=$1"#).bind(id).fetch_one(&mut **tx).await?)
}
async fn ledger(
    tx: &mut Tx<'_>,
    c: &Context,
    identity: (Uuid, Uuid),
    slot: &Slot,
    requirement: &Dimensions,
    release: &str,
    expires: DateTime<Utc>,
) -> Result<()> {
    let (plan, group) = identity;
    let bs = capacity::buckets(tx, slot, c.area).await?;
    if !capacity::admit(tx, &bs, requirement, None, true).await? {
        tracing::info!(%plan,"fulfillment.split.reservation_failed");
        return Err(invalid("SLOT_FULL"));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO fulfillment.capacity_reservations(id,customer_id,cart_id,location_id,schedule_id,source_id,area_id,method,timezone,starts_at,ends_at,fingerprint,requirement,status,expires_at,idempotency_key,release_before,group_id) SELECT $1,customer_id,cart_id,COALESCE(location_id,$3),$4,$3,$5,$13,$6,$7,$8,fingerprint,$9,'HELD',$10,$1,$11,$12 FROM fulfillment.plans WHERE id=$2")
        .bind(id).bind(plan).bind(slot.source_id).bind((slot.schedule_id!=Uuid::nil()).then_some(slot.schedule_id)).bind(c.area).bind(&slot.timezone).bind(slot.starts_at).bind(slot.ends_at).bind(json!(requirement)).bind(expires).bind(release).bind(group).bind(&slot.method).execute(&mut **tx).await?;
    for b in bs {
        sqlx::query("INSERT INTO fulfillment.capacity_consumption VALUES($1,$2,$3)")
            .bind(id)
            .bind(b.rule.id)
            .bind(b.key)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}
pub async fn reserve(pool: &PgPool, customer: Uuid, selection: Selection) -> Result<Value> {
    let mut tx = domain_inventory::begin(pool).await?;
    let r = &selection.request;
    let c = context(&mut tx, customer, r).await?;
    let old:Option<(Uuid,Value,Value,String,bool)>=sqlx::query_as("SELECT id,request,fingerprint,status,expires_at>clock_timestamp() FROM fulfillment.plans WHERE customer_id=$1 AND idempotency_key=$2").bind(customer).bind(selection.idempotency_key).fetch_optional(&mut *tx).await?;
    if let Some((id, request, fp, status, fresh)) = old {
        if request != json!(selection) || fp != c.fingerprint {
            return Err(invalid("IDEMPOTENCY_CONFLICT"));
        }
        if !fresh || status != "HELD" {
            return Err(invalid("RESERVATION_EXPIRED"));
        }
        let result = snapshot(&mut tx, id).await?;
        tx.commit().await?;
        return Ok(result);
    }
    // Admit the destination and its source allocations atomically. A later cart
    // refresh with this address must not reroute the scheduled hold as a pin change.
    if r.method == "delivery" {
        sqlx::query("UPDATE cart_checkout.carts SET delivery_latitude=$2,delivery_longitude=$3 WHERE id=$1 AND (delivery_latitude,delivery_longitude) IS DISTINCT FROM ($2,$3)")
            .bind(c.cart)
            .bind(c.fingerprint["address"]["latitude"].as_f64())
            .bind(c.fingerprint["address"]["longitude"].as_f64())
            .execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE fulfillment.capacity_reservations SET status='RELEASED' WHERE cart_id=$1 AND status='HELD'").bind(c.cart).execute(&mut *tx).await?;
    let replaced = sqlx::query(
        "UPDATE fulfillment.plans SET status='RELEASED' WHERE cart_id=$1 AND status='HELD'",
    )
    .bind(c.cart)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;
    let mut groups = route(&mut tx, &c, r).await?;
    automatic_slots(&mut tx, &c, r, &mut groups).await?;
    let scheduled = c.cap.scheduled(&r.method) && !r.asap;
    let automatic =
        scheduled && r.method == "delivery" && !c.cap.customer_delivery_slot_selection_enabled;
    let mut windows = selection.windows.clone();
    if automatic {
        if !windows.is_empty() {
            return Err(invalid("AUTOMATIC_WINDOW_SELECTION_REQUIRED"));
        }
        let common = groups.first().and_then(|g| {
            g.slots.iter().find(|s| {
                groups.iter().all(|g| {
                    g.slots
                        .iter()
                        .any(|x| x.starts_at == s.starts_at && x.ends_at == s.ends_at)
                })
            })
        });
        for g in &groups {
            let slot = if c.cap.split_delivery_mode == "same_window_required" {
                common.and_then(|s| {
                    g.slots
                        .iter()
                        .find(|x| x.starts_at == s.starts_at && x.ends_at == s.ends_at)
                })
            } else {
                g.slots.first()
            }
            .ok_or_else(|| invalid("SLOT_UNAVAILABLE"))?;
            windows.push(Window {
                source_id: g.source_id,
                schedule_id: slot.schedule_id,
                starts_at: slot.starts_at,
                ends_at: slot.ends_at,
            });
        }
    }
    if (!scheduled && !windows.is_empty()) || (scheduled && windows.len() != groups.len()) {
        return Err(invalid("INVALID_GROUP_SELECTION"));
    }
    if scheduled
        && groups.len() > 1
        && c.cap.split_delivery_mode == "same_window_required"
        && windows
            .iter()
            .any(|w| w.starts_at != windows[0].starts_at || w.ends_at != windows[0].ends_at)
    {
        return Err(invalid("COMMON_WINDOW_REQUIRED"));
    }
    let now = capacity::database_now(&mut tx).await?;
    let mut expires = now + chrono::Duration::minutes(10);
    let mut chosen = vec![];
    for group in &groups {
        let (slot, release) = if scheduled {
            let window = windows
                .iter()
                .find(|w| w.source_id == group.source_id)
                .ok_or_else(|| invalid("INVALID_GROUP_SELECTION"))?;
            let slot = group
                .slots
                .iter()
                .find(|s| {
                    s.schedule_id == window.schedule_id
                        && s.starts_at == window.starts_at
                        && s.ends_at == window.ends_at
                })
                .cloned()
                .ok_or_else(|| invalid("SLOT_UNAVAILABLE"))?;
            let config: Value =
                sqlx::query_scalar("SELECT config FROM fulfillment.schedules WHERE id=$1")
                    .bind(slot.schedule_id)
                    .fetch_one(&mut *tx)
                    .await?;
            let config: Config = serde_json::from_value(config).map_err(|_| Error::Internal)?;
            expires = expires
                .min(now + chrono::Duration::minutes(config.ttl_minutes))
                .min(slot.starts_at);
            (slot, config.release_before)
        } else {
            let slot =
                crate::pickup::asap(&mut tx, c.store, group.source_id, &r.method, now).await?;
            expires = expires.min(slot.ends_at);
            (slot, "fulfilling".into())
        };
        chosen.push((slot, release));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO fulfillment.plans(id,customer_id,cart_id,store_id,method,location_id,fingerprint,capabilities,request,status,expires_at,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'HELD',$10,$11)").bind(id).bind(customer).bind(c.cart).bind(c.store).bind(&r.method).bind(r.location_id).bind(&c.fingerprint).bind(json!(c.cap)).bind(json!(selection)).bind(expires).bind(selection.idempotency_key).execute(&mut *tx).await?;
    for (group, (slot, release)) in groups.iter().zip(&chosen) {
        let gid = Uuid::new_v4();
        sqlx::query("INSERT INTO fulfillment.plan_groups(id,plan_id,source_id,method,schedule_id,starts_at,ends_at,timezone,requirement,release_before,area_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(gid).bind(id).bind(group.source_id).bind(&r.method).bind(scheduled.then_some(slot.schedule_id)).bind(slot.starts_at).bind(slot.ends_at).bind(&slot.timezone).bind(json!(group.requirement)).bind(release).bind(c.area).execute(&mut *tx).await?;
        for item in &group.items {
            sqlx::query("INSERT INTO fulfillment.plan_items VALUES($1,$2,$3,$4)")
                .bind(gid)
                .bind(item.product_id)
                .bind(item.stock_id)
                .bind(item.quantity)
                .execute(&mut *tx)
                .await?;
        }
        if c.cap.capacity_management_enabled && c.cap.checkout_capacity_holds_enabled {
            ledger(
                &mut tx,
                &c,
                (id, gid),
                slot,
                &group.requirement,
                release,
                expires,
            )
            .await?;
        }
    }
    sqlx::query("INSERT INTO inventory.reservations(cart_id,product_id,quantity,expires_at) SELECT cart_id,product_id,quantity,$2 FROM cart_checkout.items WHERE cart_id=$1 ON CONFLICT(cart_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity,expires_at=EXCLUDED.expires_at").bind(c.cart).bind(expires).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM inventory.reservation_allocations WHERE cart_id=$1")
        .bind(c.cart)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO inventory.reservation_allocations(cart_id,product_id,source_id,stock_id,quantity) SELECT $1,i.product_id,g.source_id,i.stock_id,i.quantity FROM fulfillment.plan_groups g JOIN fulfillment.plan_items i ON i.group_id=g.id WHERE g.plan_id=$2").bind(c.cart).bind(id).execute(&mut *tx).await?;
    sqlx::query("SELECT inventory.refresh_availability(product_id) FROM cart_checkout.items WHERE cart_id=$1").bind(c.cart).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO platform.outbox(id,event_type,payload) SELECT gen_random_uuid(),'inventory.stock_updated',jsonb_build_object('id',product_id) FROM cart_checkout.items WHERE cart_id=$1").bind(c.cart).execute(&mut *tx).await?;
    infra_events::record(
        &mut tx,
        if replaced {
            "fulfillment.plan.recalculated"
        } else {
            "fulfillment.plan.created"
        },
        json!({"plan_id":id,"store_id":c.store,"method":r.method,"groups":groups.len()}),
    )
    .await?;
    if r.method == "pickup" {
        infra_events::record(
            &mut tx,
            "fulfillment.pickup.selected",
            json!({"plan_id":id}),
        )
        .await?;
    }
    let result = snapshot(&mut tx, id).await?;
    tx.commit().await?;
    Ok(result)
}
pub async fn checkout(
    tx: &mut Tx<'_>,
    customer: Uuid,
    cart: Uuid,
    location: Uuid,
) -> Result<Option<Value>> {
    let row:Option<(Uuid,Value,Value,Value,bool)>=sqlx::query_as("SELECT id,request,fingerprint,capabilities,expires_at>clock_timestamp() FROM fulfillment.plans WHERE cart_id=$1 AND status='HELD'").bind(cart).fetch_optional(&mut **tx).await?;
    let Some((id, request, fp, cap, fresh)) = row else {
        return Ok(None);
    };
    if !fresh {
        return Err(invalid("RESERVATION_EXPIRED"));
    }
    let selection: Selection = serde_json::from_value(request).map_err(|_| Error::Internal)?;
    let c = context(tx, customer, &selection.request).await?;
    // Older held plans predate the optional global-delivery policy and mean false.
    let stored_cap: capabilities::Capabilities =
        serde_json::from_value(cap).map_err(|_| Error::Internal)?;
    if selection.request.location_id.unwrap_or(Uuid::nil()) != location
        || fp != c.fingerprint
        || stored_cap != c.cap
    {
        return Err(invalid("RESERVATION_STALE"));
    }
    let changed:bool=sqlx::query_scalar(r#"SELECT EXISTS((SELECT product_id,source_id,stock_id,quantity FROM inventory.reservation_allocations WHERE cart_id=$1 EXCEPT SELECT i.product_id,g.source_id,i.stock_id,i.quantity FROM fulfillment.plan_items i JOIN fulfillment.plan_groups g ON g.id=i.group_id WHERE g.plan_id=$2) UNION ALL (SELECT i.product_id,g.source_id,i.stock_id,i.quantity FROM fulfillment.plan_items i JOIN fulfillment.plan_groups g ON g.id=i.group_id WHERE g.plan_id=$2 EXCEPT SELECT product_id,source_id,stock_id,quantity FROM inventory.reservation_allocations WHERE cart_id=$1))"#).bind(cart).bind(id).fetch_one(&mut **tx).await?;
    let disabled:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fulfillment.plan_groups g JOIN inventory.inventory_sources s ON s.id=g.source_id JOIN fulfillment.stores store ON store.id=$2 LEFT JOIN fulfillment.store_sources ss ON ss.source_id=s.id AND ss.store_id=store.id WHERE g.plan_id=$1 AND (NOT s.is_enabled OR (NOT store.is_default AND ss.source_id IS NULL) OR (g.method='pickup' AND NOT COALESCE(ss.pickup_enabled,false)) OR EXISTS(SELECT 1 FROM fulfillment.plan_items i WHERE i.group_id=g.id AND (NOT EXISTS(SELECT 1 FROM inventory.source_stock_links l WHERE l.source_id=g.source_id AND l.stock_id=i.stock_id) OR (g.method='delivery' AND ((g.area_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inventory.area_stock_links al WHERE al.area_id=g.area_id AND al.stock_id=i.stock_id)) OR (g.area_id IS NULL AND NOT EXISTS(SELECT 1 FROM inventory.stocks st WHERE st.id=i.stock_id AND (st.is_default OR ($3 AND st.is_global))))))))))").bind(id).bind(c.store).bind(c.cap.global_delivery()).fetch_one(&mut **tx).await?;
    let incomplete:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fulfillment.plan_groups g WHERE g.plan_id=$1 AND NOT EXISTS(SELECT 1 FROM fulfillment.capacity_reservations r WHERE r.group_id=g.id AND r.status='HELD' AND r.expires_at>clock_timestamp()))").bind(id).fetch_one(&mut **tx).await?;
    if changed
        || disabled
        || (c.cap.capacity_management_enabled
            && c.cap.checkout_capacity_holds_enabled
            && incomplete)
    {
        return Err(invalid("RESERVATION_STALE"));
    }
    Ok(Some(snapshot(tx, id).await?))
}
pub async fn confirm(tx: &mut Tx<'_>, cart: Uuid, order: Uuid) -> Result<()> {
    let row:Option<(Uuid,Uuid,Value,DateTime<Utc>)>=sqlx::query_as("SELECT id,customer_id,request,expires_at FROM fulfillment.plans WHERE cart_id=$1 AND status='HELD'").bind(cart).fetch_optional(&mut **tx).await?;
    let Some((id, customer, request, expires)) = row else {
        return Ok(());
    };
    if expires <= capacity::database_now(tx).await? {
        return Err(invalid("RESERVATION_EXPIRED"));
    }
    let selection: Selection = serde_json::from_value(request).map_err(|_| Error::Internal)?;
    let c = context(tx, customer, &selection.request).await?;
    if c.cap.capacity_management_enabled && !c.cap.checkout_capacity_holds_enabled {
        // Independent split windows can visit shared capacity buckets in opposite
        // orders even when their sources are sorted. Serialize only this deferred
        // admission path before taking any bucket locks; callers already own the
        // cart/product locks. Pre-held plans and ordinary carts avoid this guard.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('fulfillment:no-prehold-capacity-confirm',0))")
            .execute(&mut **tx)
            .await?;
        type Booking = (
            Uuid,
            Uuid,
            Option<Uuid>,
            String,
            DateTime<Utc>,
            DateTime<Utc>,
            String,
            Value,
            String,
        );
        let groups:Vec<Booking>=sqlx::query_as("SELECT g.id,g.source_id,g.schedule_id,COALESCE(s.method,g.method),g.starts_at,g.ends_at,g.timezone,g.requirement,g.release_before FROM fulfillment.plan_groups g LEFT JOIN fulfillment.schedules s ON s.id=g.schedule_id WHERE g.plan_id=$1 ORDER BY g.source_id").bind(id).fetch_all(&mut **tx).await?;
        for (gid, source, schedule, method, start, end, tz, req, release) in groups {
            let slot = Slot {
                schedule_id: schedule.unwrap_or(Uuid::nil()),
                source_id: source,
                method,
                starts_at: start,
                ends_at: end,
                timezone: tz,
                availability: "AVAILABLE".into(),
            };
            ledger(
                tx,
                &c,
                (id, gid),
                &slot,
                &serde_json::from_value(req).map_err(|_| Error::Internal)?,
                &release,
                expires,
            )
            .await?;
        }
    }
    sqlx::query("UPDATE fulfillment.plans SET status='CONFIRMED',order_id=$2 WHERE id=$1")
        .bind(id)
        .bind(order)
        .execute(&mut **tx)
        .await?;
    infra_events::record(
        tx,
        "fulfillment.plan.confirmed",
        json!({"plan_id":id,"order_id":order,"method":selection.request.method}),
    )
    .await?;
    Ok(())
}
pub async fn release(pool: &PgPool, customer: Uuid, id: Uuid) -> Result<()> {
    let mut tx = domain_inventory::begin(pool).await?;
    let status: String =
        sqlx::query_scalar("SELECT status FROM fulfillment.plans WHERE id=$1 AND customer_id=$2")
            .bind(id)
            .bind(customer)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::NotFound)?;
    if status == "CONFIRMED" {
        return Err(invalid("RESERVATION_CONFIRMED"));
    }
    sqlx::query("UPDATE fulfillment.capacity_reservations SET status='RELEASED' WHERE group_id IN (SELECT id FROM fulfillment.plan_groups WHERE plan_id=$1) AND status='HELD'").bind(id).execute(&mut *tx).await?;
    sqlx::query("UPDATE fulfillment.plans SET status='RELEASED' WHERE id=$1 AND status='HELD'")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    infra_events::record(&mut tx, "fulfillment.plan.released", json!({"plan_id":id})).await?;
    tx.commit().await?;
    Ok(())
}
pub async fn availability(pool: &PgPool, customer: Uuid) -> Result<Value> {
    let mut tx = pool.begin().await?;
    let store: Uuid = sqlx::query_scalar(
        "SELECT fulfillment_store_id FROM cart_checkout.carts WHERE customer_id=$1",
    )
    .bind(customer)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;
    let c = capabilities::resolve(&mut tx, store).await?;
    let mut methods = vec![];
    if c.delivery_enabled {
        let locations:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',s.id,'name',s.name,'instructions','', 'preparation_minutes',30) FROM inventory.inventory_sources s JOIN fulfillment.stores store ON store.id=$1 WHERE s.is_enabled AND (store.is_default OR EXISTS(SELECT 1 FROM fulfillment.store_sources ss WHERE ss.store_id=store.id AND ss.source_id=s.id)) ORDER BY s.name").bind(store).fetch_all(&mut *tx).await?;
        methods.push(json!({"type":"delivery","scheduling":c.scheduled_delivery_enabled,"asap":c.asap_delivery_enabled,"locations":locations}));
    }
    if c.pickup_enabled {
        let locations:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',s.id,'name',s.name,'instructions',ss.pickup_instructions,'preparation_minutes',ss.preparation_minutes) FROM fulfillment.store_sources ss JOIN inventory.inventory_sources s ON s.id=ss.source_id WHERE ss.store_id=$1 AND ss.pickup_enabled AND s.is_enabled ORDER BY s.name").bind(store).fetch_all(&mut *tx).await?;
        let mut eligible = vec![];
        for location in locations {
            let source =
                serde_json::from_value(location["id"].clone()).map_err(|_| Error::Internal)?;
            let r = Request {
                method: "pickup".into(),
                location_id: None,
                source_id: Some(source),
                date: Utc::now().date_naive(),
                asap: !c.pickup_scheduling_enabled,
            };
            let ctx = match context(&mut tx, customer, &r).await {
                Ok(c) => c,
                Err(Error::Invalid(_)) => continue,
                Err(e) => return Err(e),
            };
            match route(&mut tx, &ctx, &r).await {
                Ok(_) => {
                    if !c.pickup_scheduling_enabled {
                        match crate::pickup::asap(&mut tx, store, source, "pickup", Utc::now())
                            .await
                        {
                            Ok(_) => (),
                            Err(Error::Invalid(_)) => continue,
                            Err(e) => return Err(e),
                        }
                    }
                    eligible.push(location)
                }
                Err(Error::Invalid(_)) => (),
                Err(e) => return Err(e),
            }
        }
        methods.push(
            json!({"type":"pickup","scheduling":c.pickup_scheduling_enabled,"locations":eligible}),
        );
    }
    Ok(json!({"store_id":store,"capabilities":c,"methods":methods}))
}

pub async fn order_snapshot(tx: &mut Tx<'_>, order: Uuid) -> Result<Option<Value>> {
    let id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM fulfillment.plans WHERE order_id=$1")
        .bind(order)
        .fetch_optional(&mut **tx)
        .await?;
    match id {
        Some(id) => Ok(Some(snapshot(tx, id).await?)),
        None => Ok(None),
    }
}
/// PostgreSQL prevents partially committed plans; also retire inconsistent imported/repaired state.
pub async fn recover(tx: &mut Tx<'_>) -> Result<()> {
    sqlx::query(r#"WITH expired AS (
        UPDATE fulfillment.plans SET status='EXPIRED' WHERE id IN (
            SELECT p.id FROM fulfillment.plans p WHERE p.status='HELD' AND (
                p.expires_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM fulfillment.plan_groups g WHERE g.plan_id=p.id) OR
                ((p.capabilities->>'capacity_management_enabled')::boolean AND (p.capabilities->>'checkout_capacity_holds_enabled')::boolean
                 AND EXISTS(SELECT 1 FROM fulfillment.plan_groups g WHERE g.plan_id=p.id AND NOT EXISTS(
                     SELECT 1 FROM fulfillment.capacity_reservations r WHERE r.group_id=g.id AND r.status='HELD' AND r.expires_at>clock_timestamp()))))
            ORDER BY p.expires_at,p.id LIMIT 500 FOR UPDATE) RETURNING cart_id
        ) UPDATE inventory.reservations SET expires_at=LEAST(expires_at,clock_timestamp()) WHERE cart_id IN (SELECT cart_id FROM expired)"#).execute(&mut **tx).await?;
    sqlx::query("UPDATE fulfillment.capacity_reservations SET status='EXPIRED' WHERE status='HELD' AND group_id IN (SELECT g.id FROM fulfillment.plan_groups g JOIN fulfillment.plans p ON p.id=g.plan_id WHERE p.status='EXPIRED')").execute(&mut **tx).await?;
    Ok(())
}
