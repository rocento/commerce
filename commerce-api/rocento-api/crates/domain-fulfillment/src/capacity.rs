//! Database-authoritative admission ledger, bound to existing customer/cart/source identities.
use crate::scheduling::{self, Config, Schedule, Slot};
use chrono::{DateTime, NaiveDate, Utc};
use domain_inventory::Tx;
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};
use std::collections::BTreeMap;
use uuid::Uuid;
pub type Dimensions = BTreeMap<String, i64>;
fn fail(code: &str) -> Error {
    Error::Invalid(code.into())
}
#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    #[serde(skip_deserializing)]
    pub entity_id: i64,
    pub id: Uuid,
    #[serde(default)]
    pub overrides_rule_id: Option<Uuid>,
    pub source_id: Option<Uuid>,
    pub area_id: Option<Uuid>,
    pub method: Option<String>,
    pub timezone: String,
    pub local_start: Option<chrono::NaiveTime>,
    pub period: String,
    pub limits: Value,
    pub overflow_percent: i32,
    pub starts_on: Option<NaiveDate>,
    pub ends_on: Option<NaiveDate>,
    pub enabled: bool,
}
impl Rule {
    pub fn validate(&self) -> Result<()> {
        let limits: Dimensions = serde_json::from_value(self.limits.clone())
            .map_err(|_| fail("Invalid capacity dimensions"))?;
        if limits.is_empty()
            || limits.iter().any(|(k, v)| {
                ![
                    "orders",
                    "stops",
                    "items",
                    "units",
                    "weight_grams",
                    "volume_ml",
                    "workload",
                ]
                .contains(&k.as_str())
                    || !(0..=1_000_000_000).contains(v)
            })
            || !(0..=100).contains(&self.overflow_percent)
            || !["day", "hour", "slot"].contains(&self.period.as_str())
            || self.starts_on.zip(self.ends_on).is_some_and(|(a, b)| a > b)
        {
            return Err(fail("Invalid capacity rule"));
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
pub struct Reservation {
    pub entity_id: i64,
    pub id: Uuid,
    pub customer_id: Uuid,
    pub cart_id: Uuid,
    pub location_id: Uuid,
    pub schedule_id: Uuid,
    pub source_id: Uuid,
    pub area_id: Option<Uuid>,
    pub method: String,
    pub timezone: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub fingerprint: Value,
    pub requirement: Value,
    pub status: String,
    pub expires_at: DateTime<Utc>,
    pub order_id: Option<Uuid>,
    pub idempotency_key: Uuid,
    pub release_before: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub schedule_id: Uuid,
    pub location_id: Uuid,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub idempotency_key: Uuid,
}
struct Context {
    cart: Uuid,
    area: Option<Uuid>,
    configured: bool,
    global_delivery: bool,
    fingerprint: Value,
    requirement: Dimensions,
}
/// Replaceable deterministic workload calculator; catalog physical facts are trusted server data.
pub trait RequirementCalculator {
    fn calculate(&self, lines: &[(Uuid, i32, Value)]) -> Result<Dimensions>;
}
pub struct StandardRequirement;
impl RequirementCalculator for StandardRequirement {
    fn calculate(&self, lines: &[(Uuid, i32, Value)]) -> Result<Dimensions> {
        if lines.is_empty() || lines.len() > 500 || lines.iter().any(|(_, q, _)| *q <= 0) {
            return Err(fail("CART_INVALID"));
        }
        let units: i64 = lines.iter().map(|(_, q, _)| i64::from(*q)).sum();
        let mut result = BTreeMap::from([
            ("orders".into(), 1),
            ("stops".into(), 1),
            ("items".into(), lines.len() as i64),
            ("units".into(), units),
            ("workload".into(), (units + 19) / 20),
        ]);
        for dimension in ["weight_grams", "volume_ml"] {
            let value = lines.iter().try_fold(0i64, |sum, (_, q, attributes)| {
                let n = attributes.get(dimension)?.as_i64()?;
                if n < 0 {
                    return None;
                }
                sum.checked_add(n.checked_mul(i64::from(*q))?)
            });
            if let Some(n) = value {
                result.insert(dimension.into(), n);
            }
        }
        Ok(result)
    }
}
async fn context(tx: &mut Tx<'_>, customer: Uuid, location: Uuid) -> Result<Context> {
    let (cart,address,area,cart_area,configured):(Uuid,Value,Option<Uuid>,Option<Uuid>,bool)=sqlx::query_as(r#"
      SELECT c.id,(to_jsonb(l)-'entity_id'),inventory.resolve_delivery_area(l.latitude,l.longitude),
        inventory.resolve_delivery_area(c.delivery_latitude,c.delivery_longitude),EXISTS(SELECT 1 FROM inventory.delivery_areas)
      FROM cart_checkout.carts c JOIN customers.customer_locations l ON l.customer_id=c.customer_id
      WHERE c.customer_id=$1 AND l.id=$2
    "#).bind(customer).bind(location).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)?;
    let cap = crate::capabilities::for_cart(tx, cart).await?;
    cap.require(cap.scheduled_delivery_enabled, "scheduled_delivery")?;
    let configured = configured && cap.geofencing();
    let area = if cap.geofencing() { area } else { None };
    if configured && (area.is_none() || area != cart_area) {
        return Err(fail("OUTSIDE_DELIVERY_AREA"));
    }
    let lines:Vec<(Uuid,i32,Value)>=sqlx::query_as("SELECT i.product_id,i.quantity,p.attributes FROM cart_checkout.items i JOIN catalog.products p ON p.id=i.product_id AND p.active AND p.in_stock WHERE i.cart_id=$1 ORDER BY i.product_id LIMIT 501").bind(cart).fetch_all(&mut **tx).await?;
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM cart_checkout.items WHERE cart_id=$1")
            .bind(cart)
            .fetch_one(&mut **tx)
            .await?;
    if count != lines.len() as i64 {
        return Err(fail("INVENTORY_UNAVAILABLE"));
    }
    let requirement = StandardRequirement.calculate(&lines)?;
    Ok(Context {
        cart,
        area,
        configured,
        global_delivery: cap.global_delivery(),
        fingerprint: json!({"address":address,"lines":lines}),
        requirement,
    })
}
// All products must fit one source for this milestone. Alternative sources are evaluated with
// this cart's own holds excluded, allowing atomic rerouting without over-reserving stock.
async fn eligible_sources(tx: &mut Tx<'_>, c: &Context) -> Result<Vec<(Uuid, Uuid)>> {
    Ok(sqlx::query_as(r#"
      SELECT DISTINCT ON(s.id) s.id,l.stock_id FROM inventory.inventory_sources s
      JOIN inventory.source_stock_links l ON l.source_id=s.id JOIN inventory.stocks st ON st.id=l.stock_id
      WHERE s.is_enabled AND (($3 AND EXISTS(SELECT 1 FROM inventory.area_stock_links al WHERE al.stock_id=l.stock_id AND al.area_id=$2)) OR (NOT $3 AND (st.is_default OR ($4 AND st.is_global))))
      AND NOT EXISTS(SELECT 1 FROM cart_checkout.items c WHERE c.cart_id=$1 AND NOT EXISTS(
        SELECT 1 FROM inventory.source_items i WHERE i.source_id=s.id AND i.product_id=c.product_id AND i.status='in_stock'
        AND i.quantity-COALESCE((SELECT SUM(a.quantity) FROM inventory.reservation_allocations a
          JOIN inventory.reservations r USING(cart_id,product_id) WHERE a.source_id=s.id AND a.product_id=c.product_id AND a.cart_id<>$1 AND r.expires_at>clock_timestamp()),0)>=c.quantity))
      ORDER BY s.id,l.priority,l.stock_id LIMIT 100
    "#).bind(c.cart).bind(c.area).bind(c.configured).bind(c.global_delivery).fetch_all(&mut **tx).await?)
}
async fn schedules(tx: &mut Tx<'_>, area: Option<Uuid>) -> Result<Vec<Schedule>> {
    Ok(sqlx::query_as("SELECT DISTINCT ON(source_id,method) * FROM fulfillment.schedules WHERE area_id IS NULL OR area_id=$1 ORDER BY source_id,method,area_id NULLS LAST LIMIT 200").bind(area).fetch_all(&mut **tx).await?)
}
#[derive(Clone)]
pub(crate) struct Bucket {
    pub(crate) rule: Rule,
    pub(crate) key: String,
}
pub(crate) async fn buckets(
    tx: &mut Tx<'_>,
    slot: &Slot,
    area: Option<Uuid>,
) -> Result<Vec<Bucket>> {
    let rules:Vec<Rule>=sqlx::query_as(r#"SELECT r.* FROM fulfillment.capacity_rules r WHERE enabled AND NOT EXISTS(SELECT 1 FROM fulfillment.capacity_rules o WHERE o.enabled AND o.overrides_rule_id=r.id AND (o.starts_on IS NULL OR o.starts_on<=($4 AT TIME ZONE o.timezone)::date) AND (o.ends_on IS NULL OR o.ends_on>=($4 AT TIME ZONE o.timezone)::date) AND (o.local_start IS NULL OR o.local_start=($4 AT TIME ZONE o.timezone)::time)) AND (source_id IS NULL OR source_id=$1)
      AND (area_id IS NULL OR area_id=$2) AND (method IS NULL OR method=$3)
      AND (starts_on IS NULL OR starts_on<=($4 AT TIME ZONE timezone)::date)
      AND (ends_on IS NULL OR ends_on>=($4 AT TIME ZONE timezone)::date)
      AND (local_start IS NULL OR local_start=($4 AT TIME ZONE timezone)::time) ORDER BY id LIMIT 101"#)
      .bind(slot.source_id).bind(area).bind(&slot.method).bind(slot.starts_at).fetch_all(&mut **tx).await?;
    if rules.len() > 100 {
        return Err(fail("Too many applicable capacity rules"));
    }
    let mut result = vec![];
    for rule in rules {
        let keys: Vec<String> = if rule.period == "slot" {
            vec![format!(
                "{}/{}",
                slot.starts_at.to_rfc3339(),
                slot.ends_at.to_rfc3339()
            )]
        } else {
            sqlx::query_scalar("SELECT to_char(t,'YYYY-MM-DD HH24:MI:SS') FROM generate_series(date_trunc($1,$2 AT TIME ZONE $4),date_trunc($1,($3-interval '1 microsecond') AT TIME ZONE $4),CASE WHEN $1='day' THEN interval '1 day' ELSE interval '1 hour' END) t")
            .bind(&rule.period).bind(slot.starts_at).bind(slot.ends_at).bind(&rule.timezone).fetch_all(&mut **tx).await?
        };
        for key in keys {
            result.push(Bucket {
                rule: rule.clone(),
                key,
            });
        }
    }
    result.sort_by(|a, b| (a.rule.id, &a.key).cmp(&(b.rule.id, &b.key)));
    Ok(result)
}
pub fn fits(
    limits: &Dimensions,
    used: &Dimensions,
    need: &Dimensions,
    overflow: i32,
) -> Result<bool> {
    for (dimension, limit) in limits {
        let n = need
            .get(dimension)
            .ok_or_else(|| fail("CAPACITY_FACTS_MISSING"))?;
        let maximum = i128::from(*limit) * (100 + i128::from(overflow)) / 100;
        if i128::from(*used.get(dimension).unwrap_or(&0)) + i128::from(*n) > maximum {
            return Ok(false);
        }
    }
    Ok(true)
}
async fn usage(tx: &mut Tx<'_>, bucket: &Bucket, exclude: Option<Uuid>) -> Result<Dimensions> {
    // Include demand booked before a rule was introduced or its scope changed.
    let (start, end): (DateTime<Utc>, DateTime<Utc>) = if bucket.rule.period == "slot" {
        let (a, b) = bucket.key.split_once('/').ok_or(Error::Internal)?;
        (
            a.parse().map_err(|_| Error::Internal)?,
            b.parse().map_err(|_| Error::Internal)?,
        )
    } else {
        sqlx::query_as("SELECT $1::timestamp AT TIME ZONE $2,($1::timestamp+CASE WHEN $3='day' THEN interval '1 day' ELSE interval '1 hour' END) AT TIME ZONE $2")
          .bind(&bucket.key).bind(&bucket.rule.timezone).bind(&bucket.rule.period).fetch_one(&mut **tx).await?
    };
    let rows:Vec<(String,i64)>=sqlx::query_as(r#"
      SELECT d.key,CASE WHEN COUNT(*) FILTER(WHERE NOT r.requirement ? d.key)>0 THEN 9223372036854775807 ELSE SUM((r.requirement->>d.key)::bigint)::bigint END FROM fulfillment.capacity_reservations r CROSS JOIN LATERAL jsonb_object_keys($7::jsonb) d(key)
      WHERE r.status IN ('HELD','CONFIRMED') AND tstzrange(r.starts_at,r.ends_at,'[)') && tstzrange($1,$2,'[)') AND ($3::uuid IS NULL OR r.id<>$3)
      AND ($4::uuid IS NULL OR r.source_id=$4) AND ($5::uuid IS NULL OR r.area_id=$5) AND ($6::text IS NULL OR r.method=$6)
      AND (r.status='CONFIRMED' OR (r.status='HELD' AND r.expires_at>clock_timestamp())) GROUP BY d.key
    "#).bind(start).bind(end).bind(exclude).bind(bucket.rule.source_id).bind(bucket.rule.area_id).bind(&bucket.rule.method).bind(&bucket.rule.limits).fetch_all(&mut **tx).await?;
    Ok(rows.into_iter().collect())
}
pub(crate) async fn admit(
    tx: &mut Tx<'_>,
    bs: &[Bucket],
    requirement: &Dimensions,
    exclude: Option<Uuid>,
    lock: bool,
) -> Result<bool> {
    if lock {
        // Overlapping slot shapes must serialize too, even when their exact window keys differ.
        let mut stripes = std::collections::BTreeSet::new();
        for b in bs.iter().filter(|b| b.rule.period == "slot") {
            let (a, z) = b.key.split_once('/').ok_or(Error::Internal)?;
            let a: DateTime<Utc> = a.parse().map_err(|_| Error::Internal)?;
            let z: DateTime<Utc> = z.parse().map_err(|_| Error::Internal)?;
            let mut day = a.date_naive();
            let last = (z - chrono::Duration::microseconds(1)).date_naive();
            while day <= last {
                stripes.insert(format!("fulfillment/{}/{}", b.rule.id, day));
                day = day.succ_opt().ok_or(Error::Internal)?;
            }
        }
        for key in stripes {
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
                .bind(key)
                .execute(&mut **tx)
                .await?;
        }
    }
    for b in bs {
        if lock {
            sqlx::query("INSERT INTO fulfillment.capacity_buckets(rule_id,bucket_key) VALUES($1,$2) ON CONFLICT DO NOTHING").bind(b.rule.id).bind(&b.key).execute(&mut **tx).await?;
            sqlx::query("SELECT rule_id FROM fulfillment.capacity_buckets WHERE rule_id=$1 AND bucket_key=$2 FOR UPDATE").bind(b.rule.id).bind(&b.key).execute(&mut **tx).await?;
        }
        let limits: Dimensions =
            serde_json::from_value(b.rule.limits.clone()).map_err(|_| Error::Internal)?;
        if !fits(
            &limits,
            &usage(tx, b, exclude).await?,
            requirement,
            b.rule.overflow_percent,
        )? {
            return Ok(false);
        }
    }
    Ok(true)
}
impl Service {
    /// Capacity-only mode: allocate the earliest feasible window before checkout review.
    /// Manual schedules retain explicit customer selection. Placement never refreshes a hold.
    pub async fn ensure_automatic(&self, customer: Uuid, location: Uuid) -> Result<()> {
        let mut policy_tx = self.pool.begin().await?;
        let cart: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM cart_checkout.carts WHERE customer_id=$1")
                .bind(customer)
                .fetch_optional(&mut *policy_tx)
                .await?;
        if let Some(cart) = cart {
            if !crate::capabilities::for_cart(&mut policy_tx, cart)
                .await?
                .scheduled_delivery_enabled
            {
                return Ok(());
            }
        }
        policy_tx.commit().await?;
        let automatic:bool=sqlx::query_scalar("SELECT (SELECT enabled FROM fulfillment.capacity_settings WHERE id) AND EXISTS(SELECT 1 FROM fulfillment.schedules WHERE enabled AND config->>'selection_required'='false') AND NOT EXISTS(SELECT 1 FROM fulfillment.schedules WHERE enabled AND COALESCE(config->>'selection_required','true')='true')").fetch_one(&self.pool).await?;
        if !automatic {
            return Ok(());
        }
        let mut tx = self.pool.begin().await?;
        let c = context(&mut tx, customer, location).await?;
        let fresh:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fulfillment.capacity_reservations WHERE cart_id=$1 AND location_id=$2 AND fingerprint=$3 AND status='HELD' AND expires_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM inventory.reservation_allocations a WHERE a.cart_id=$1 AND a.source_id<>fulfillment.capacity_reservations.source_id))").bind(c.cart).bind(location).bind(&c.fingerprint).fetch_one(&mut *tx).await?;
        if fresh {
            tx.commit().await?;
            return Ok(());
        }
        // At most 61 distinct local dates across configured horizons; no future slots are persisted.
        let dates:Vec<NaiveDate>=sqlx::query_scalar("SELECT DISTINCT (clock_timestamp() AT TIME ZONE timezone)::date+d.n FROM fulfillment.schedules CROSS JOIN LATERAL generate_series((config->>'min_days')::integer,(config->>'max_days')::integer) d(n) WHERE enabled ORDER BY 1 LIMIT 62").fetch_all(&mut *tx).await?;
        tx.commit().await?;
        for date in dates {
            let candidates = self.options(customer, location, date).await?;
            for slot in candidates.into_iter().take(5) {
                match self
                    .reserve(
                        customer,
                        Selection {
                            schedule_id: slot.schedule_id,
                            location_id: location,
                            starts_at: slot.starts_at,
                            ends_at: slot.ends_at,
                            idempotency_key: Uuid::new_v4(),
                        },
                    )
                    .await
                {
                    Ok(_) => return Ok(()),
                    Err(Error::Invalid(code))
                        if ["SLOT_FULL", "INVENTORY_UNAVAILABLE", "SLOT_UNAVAILABLE"]
                            .contains(&code.as_str()) =>
                    {
                        continue;
                    }
                    Err(e) => return Err(e),
                }
            }
        }
        Err(fail("SLOT_FULL"))
    }
    /// Bounded deterministic recommendations; later rankers may reorder eligible results only.
    pub async fn alternatives(
        &self,
        customer: Uuid,
        location: Uuid,
        date: NaiveDate,
    ) -> Result<Vec<Slot>> {
        let mut result = vec![];
        for offset in 0..3 {
            let day = date
                .checked_add_signed(chrono::Duration::days(offset))
                .ok_or_else(|| fail("Invalid delivery date"))?;
            result.extend(self.options(customer, location, day).await?);
            if result.len() >= 5 {
                break;
            }
        }
        result.truncate(5);
        Ok(result)
    }
    pub async fn options(
        &self,
        customer: Uuid,
        location: Uuid,
        date: NaiveDate,
    ) -> Result<Vec<Slot>> {
        let mut tx = self.pool.begin().await?;
        let c = context(&mut tx, customer, location).await?;
        let sources = eligible_sources(&mut tx, &c).await?;
        let existing: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM fulfillment.capacity_reservations WHERE cart_id=$1 AND status='HELD' AND group_id IS NULL",
        )
        .bind(c.cart)
        .fetch_optional(&mut *tx)
        .await?;
        let mut result = vec![];
        for schedule in schedules(&mut tx, c.area).await? {
            if ["pickup", "curbside"].contains(&schedule.method.as_str()) {
                continue;
            }
            if !sources.iter().any(|(id, _)| *id == schedule.source_id) {
                continue;
            }
            result.extend(scheduling::generate(&mut tx, &schedule, date).await?);
            if result.len() > 2000 {
                return Err(fail(
                    "Too many delivery candidates; narrow scheduling configuration",
                ));
            }
        }
        if !crate::capabilities::for_cart(&mut tx, c.cart)
            .await?
            .capacity_management_enabled
        {
            tx.commit().await?;
            return Ok(result);
        }
        let availability: Vec<(i64, bool, bool)> = sqlx::query_as(&format!(
            "{}{}",
            include_str!("capacity_snapshot.sql"),
            include_str!("availability.sql")
        ))
        .bind(json!(result))
        .bind(c.area)
        .bind(json!(c.requirement))
        .bind(existing)
        .fetch_all(&mut *tx)
        .await?;
        result = result
            .into_iter()
            .enumerate()
            .filter_map(|(i, mut slot)| {
                let (_, available, limited) = availability[i];
                if !available {
                    return None;
                }
                if limited {
                    slot.availability = "LIMITED".into();
                }
                Some(slot)
            })
            .collect();
        result.sort_by_key(|s| (s.starts_at, s.source_id));
        tx.commit().await?;
        Ok(result)
    }
    pub async fn reserve(&self, customer: Uuid, selection: Selection) -> Result<Reservation> {
        let mut tx = domain_inventory::begin(&self.pool).await?;
        let enabled: bool =
            sqlx::query_scalar("SELECT enabled FROM fulfillment.capacity_settings WHERE id")
                .fetch_one(&mut *tx)
                .await?;
        if !enabled {
            return Err(fail("SLOT_DISABLED"));
        }
        let managed:bool=sqlx::query_scalar("SELECT s.capabilities<>'{}'::jsonb OR d.capabilities<>'{}'::jsonb OR NOT s.is_default FROM cart_checkout.carts c JOIN fulfillment.stores s ON s.id=c.fulfillment_store_id CROSS JOIN fulfillment.system_capabilities d WHERE c.customer_id=$1").bind(customer).fetch_one(&mut *tx).await?;
        if managed {
            return Err(fail("FULFILLMENT_PLAN_REQUIRED"));
        }
        // Configuration writes also use the inventory lock, so rules cannot change during admission.
        let c = context(&mut tx, customer, selection.location_id).await?;
        let planned: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM fulfillment.plans WHERE cart_id=$1 AND status='HELD')",
        )
        .bind(c.cart)
        .fetch_one(&mut *tx)
        .await?;
        if planned {
            return Err(fail("FULFILLMENT_PLAN_REQUIRED"));
        }
        let previous:Option<Reservation>=sqlx::query_as("SELECT * FROM fulfillment.capacity_reservations WHERE customer_id=$1 AND idempotency_key=$2").bind(customer).bind(selection.idempotency_key).fetch_optional(&mut *tx).await?;
        if let Some(r) = previous {
            if r.schedule_id != selection.schedule_id
                || r.location_id != selection.location_id
                || r.starts_at != selection.starts_at
                || r.ends_at != selection.ends_at
                || r.fingerprint != c.fingerprint
            {
                return Err(fail("IDEMPOTENCY_CONFLICT"));
            }
            if r.status != "HELD" || r.expires_at <= database_now(&mut tx).await? {
                return Err(fail("RESERVATION_EXPIRED"));
            }
            tx.commit().await?;
            return Ok(r);
        }
        let schedule = schedules(&mut tx, c.area)
            .await?
            .into_iter()
            .find(|s| s.id == selection.schedule_id && s.enabled)
            .ok_or_else(|| fail("SLOT_DISABLED"))?;
        if ["pickup", "curbside"].contains(&schedule.method.as_str()) {
            return Err(fail("FULFILLMENT_PLAN_REQUIRED"));
        }
        let date: NaiveDate = sqlx::query_scalar("SELECT ($1 AT TIME ZONE $2)::date")
            .bind(selection.starts_at)
            .bind(&schedule.timezone)
            .fetch_one(&mut *tx)
            .await?;
        let slot = scheduling::generate(&mut tx, &schedule, date)
            .await?
            .into_iter()
            .find(|s| s.starts_at == selection.starts_at && s.ends_at == selection.ends_at)
            .ok_or_else(|| fail("SLOT_UNAVAILABLE"))?;
        let stock = eligible_sources(&mut tx, &c)
            .await?
            .into_iter()
            .find(|(s, _)| *s == slot.source_id)
            .map(|(_, stock)| stock)
            .ok_or_else(|| fail("INVENTORY_UNAVAILABLE"))?;
        let config: Config =
            serde_json::from_value(schedule.config).map_err(|_| Error::Internal)?;
        // Replacement is atomic: if the new window fails, the old hold survives rollback.
        sqlx::query("UPDATE fulfillment.capacity_reservations SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE 'RELEASED' END WHERE cart_id=$1 AND status='HELD'").bind(c.cart).execute(&mut *tx).await?;
        let bs = if crate::capabilities::for_cart(&mut tx, c.cart)
            .await?
            .capacity_management_enabled
        {
            buckets(&mut tx, &slot, c.area).await?
        } else {
            vec![]
        };
        if !admit(&mut tx, &bs, &c.requirement, None, true).await? {
            tracing::info!(source_id=%slot.source_id,schedule_id=%slot.schedule_id,metric="fulfillment_capacity_rejected_total","capacity admission rejected");
            infra_observability::fulfillment_metric("fulfillment_capacity_rejected_total", 1);
            return Err(fail("SLOT_FULL"));
        }
        let id = Uuid::new_v4();
        let r:Reservation=sqlx::query_as(r#"INSERT INTO fulfillment.capacity_reservations
          (id,customer_id,cart_id,location_id,schedule_id,source_id,area_id,method,starts_at,ends_at,fingerprint,requirement,status,expires_at,idempotency_key,release_before,timezone)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'HELD',LEAST(clock_timestamp()+make_interval(mins=>$13),$9),$14,$15,$16) RETURNING *"#)
          .bind(id).bind(customer).bind(c.cart).bind(selection.location_id).bind(slot.schedule_id).bind(slot.source_id).bind(c.area).bind(&slot.method).bind(slot.starts_at).bind(slot.ends_at).bind(c.fingerprint).bind(json!(c.requirement)).bind(config.ttl_minutes as i32).bind(selection.idempotency_key).bind(config.release_before).bind(&slot.timezone).fetch_one(&mut *tx).await?;
        for b in bs {
            sqlx::query("INSERT INTO fulfillment.capacity_consumption VALUES($1,$2,$3)")
                .bind(id)
                .bind(b.rule.id)
                .bind(b.key)
                .execute(&mut *tx)
                .await?;
        }
        // Reuse inventory's reservations and projections; one allocation per product at selected source.
        sqlx::query("INSERT INTO inventory.reservations(cart_id,product_id,quantity,expires_at) SELECT cart_id,product_id,quantity,$2 FROM cart_checkout.items WHERE cart_id=$1 ON CONFLICT(cart_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity,expires_at=EXCLUDED.expires_at").bind(c.cart).bind(r.expires_at).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM inventory.reservation_allocations WHERE cart_id=$1")
            .bind(c.cart)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO inventory.reservation_allocations(cart_id,product_id,source_id,stock_id,quantity) SELECT cart_id,product_id,$2,$3,quantity FROM cart_checkout.items WHERE cart_id=$1").bind(c.cart).bind(slot.source_id).bind(stock).execute(&mut *tx).await?;
        sqlx::query("SELECT inventory.refresh_availability(product_id) FROM cart_checkout.items WHERE cart_id=$1").bind(c.cart).execute(&mut *tx).await?;
        // Keep the existing search/availability consumers informed after source rerouting.
        sqlx::query("INSERT INTO platform.outbox(id,event_type,payload) SELECT gen_random_uuid(),'inventory.stock_updated',jsonb_build_object('id',product_id) FROM cart_checkout.items WHERE cart_id=$1").bind(c.cart).execute(&mut *tx).await?;
        infra_events::record(
            &mut tx,
            "fulfillment.capacity_reserved",
            json!({"reservation_id":id,"source_id":slot.source_id,"schedule_id":slot.schedule_id}),
        )
        .await?;
        tx.commit().await?;
        infra_observability::fulfillment_metric("fulfillment_capacity_reserved_total", 1);
        Ok(r)
    }
    pub async fn release(&self, customer: Uuid, id: Uuid) -> Result<()> {
        let mut tx = domain_inventory::begin(&self.pool).await?;
        let r:Reservation=sqlx::query_as("SELECT * FROM fulfillment.capacity_reservations WHERE id=$1 AND customer_id=$2 AND group_id IS NULL FOR UPDATE").bind(id).bind(customer).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
        if r.status == "CONFIRMED" {
            return Err(fail("RESERVATION_CONFIRMED"));
        }
        let changed=sqlx::query("UPDATE fulfillment.capacity_reservations SET status='RELEASED' WHERE id=$1 AND status='HELD'").bind(id).execute(&mut *tx).await?.rows_affected();
        if changed > 0 {
            infra_events::record(
                &mut tx,
                "fulfillment.capacity_released",
                json!({"reservation_id":id}),
            )
            .await?;
        }
        tx.commit().await?;
        infra_observability::fulfillment_metric("fulfillment_capacity_released_total", changed);
        Ok(())
    }
    pub async fn expire(&self) -> Result<u64> {
        let mut tx = domain_inventory::begin(&self.pool).await?;
        crate::plans::recover(&mut tx).await?;
        let n=sqlx::query("UPDATE fulfillment.capacity_reservations SET status='EXPIRED' WHERE id IN (SELECT id FROM fulfillment.capacity_reservations WHERE status='HELD' AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT 500 FOR UPDATE SKIP LOCKED)").execute(&mut *tx).await?.rows_affected();
        tx.commit().await?;
        infra_observability::fulfillment_metric("fulfillment_reservation_expired_total", n);
        if n > 0 {
            tracing::info!(
                count = n,
                metric = "reservation_expired",
                "capacity holds expired"
            );
        }
        Ok(n)
    }
    pub async fn worker(self) {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            tick.tick().await;
            if let Err(error) = self.expire().await {
                tracing::error!(%error,"capacity expiration failed; retrying next sweep");
            }
        }
    }
}
pub(crate) async fn database_now(tx: &mut Tx<'_>) -> Result<DateTime<Utc>> {
    Ok(sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut **tx)
        .await?)
}

/// Called under the existing inventory transaction lock, before quote and order placement.
pub async fn checkout_selection(
    tx: &mut Tx<'_>,
    customer: Uuid,
    cart: Uuid,
    location: Uuid,
) -> Result<Option<Value>> {
    let cap = crate::capabilities::for_cart(tx, cart).await?;
    if !cap.scheduled_delivery_enabled {
        return Ok(None);
    }
    let r: Option<Reservation> = sqlx::query_as(
        "SELECT * FROM fulfillment.capacity_reservations WHERE cart_id=$1 AND status='HELD' AND group_id IS NULL",
    )
    .bind(cart)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(r) = r {
        if r.expires_at <= database_now(tx).await? {
            return Err(fail("RESERVATION_EXPIRED"));
        }
        let c = context(tx, customer, location).await?;
        if r.customer_id != customer
            || r.location_id != location
            || r.fingerprint != c.fingerprint
            || r.requirement != json!(c.requirement)
        {
            return Err(fail("RESERVATION_STALE"));
        }
        let valid:bool=sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM inventory.reservation_allocations WHERE cart_id=$1 AND source_id<>$2)").bind(cart).bind(r.source_id).fetch_one(&mut **tx).await?;
        if !valid {
            return Err(fail("RESERVATION_STALE"));
        }
        // Existing holds are contractual: admin closures/cap reductions do not invalidate them.
        return Ok(Some(
            json!({"id":r.id,"source_id":r.source_id,"area_id":r.area_id,"method":r.method,"timezone":r.timezone,"starts_at":r.starts_at,"ends_at":r.ends_at,"requirement":r.requirement}),
        ));
    }
    let required: bool =
        sqlx::query_scalar("SELECT enabled FROM fulfillment.capacity_settings WHERE id")
            .fetch_one(&mut **tx)
            .await?;
    if required {
        return Err(fail("SLOT_SELECTION_REQUIRED"));
    }
    Ok(None)
}
pub async fn confirm(tx: &mut Tx<'_>, cart: Uuid, order: Uuid) -> Result<()> {
    // checkout_selection and inventory revalidation run in this same transaction before this call.
    let held: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM fulfillment.capacity_reservations WHERE cart_id=$1 AND status='HELD'",
    )
    .bind(cart)
    .fetch_one(&mut **tx)
    .await?;
    let changed=sqlx::query("UPDATE fulfillment.capacity_reservations SET status='CONFIRMED',order_id=$2 WHERE cart_id=$1 AND status='HELD' AND expires_at>clock_timestamp()").bind(cart).bind(order).execute(&mut **tx).await?.rows_affected();
    if changed != held as u64 {
        infra_observability::fulfillment_metric(
            "fulfillment_reservation_confirmation_failure_total",
            1,
        );
        return Err(fail("RESERVATION_EXPIRED"));
    }
    if changed > 0 {
        infra_events::record(
            tx,
            "fulfillment.capacity_confirmed",
            json!({"order_id":order}),
        )
        .await?;
    }
    Ok(())
}
pub async fn cancel(tx: &mut Tx<'_>, order: Uuid, previous_status: &str) -> Result<()> {
    sqlx::query(
        "UPDATE fulfillment.plans SET status='CANCELLED' WHERE order_id=$1 AND status='CONFIRMED'",
    )
    .bind(order)
    .execute(&mut **tx)
    .await?;
    let stage = match previous_status {
        "placed" => 0,
        "confirmed" => 1,
        "fulfilling" => 2,
        _ => 3,
    };
    sqlx::query("UPDATE fulfillment.capacity_reservations SET status='CANCELLED' WHERE order_id=$1 AND status='CONFIRMED' AND $2 < CASE release_before WHEN 'confirmed' THEN 1 WHEN 'fulfilling' THEN 2 WHEN 'shipped' THEN 3 ELSE 0 END").bind(order).bind(stage).execute(&mut **tx).await?;
    Ok(())
}

impl Service {
    pub async fn set_enabled(
        &self,
        enabled: bool,
        reason: &str,
        who: &domain_admin_iam::Identity,
    ) -> Result<()> {
        who.require("fulfillment.capacity.manage")?;
        who.require("fulfillment.schedule.manage")?;
        if reason.trim().is_empty() || reason.len() > 300 {
            return Err(fail("A change reason is required"));
        }
        let mut tx = domain_inventory::begin(&self.pool).await?;
        let configured:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fulfillment.stores WHERE capabilities<>'{}'::jsonb) OR EXISTS(SELECT 1 FROM fulfillment.system_capabilities WHERE capabilities<>'{}'::jsonb)").fetch_one(&mut *tx).await?;
        if configured {
            return Err(fail(
                "Use store fulfillment settings to change configured capabilities",
            ));
        }
        let before: bool =
            sqlx::query_scalar("SELECT enabled FROM fulfillment.capacity_settings WHERE id")
                .fetch_one(&mut *tx)
                .await?;
        sqlx::query("UPDATE fulfillment.capacity_settings SET enabled=$1 WHERE id")
            .bind(enabled)
            .execute(&mut *tx)
            .await?;
        if enabled {
            let stores: Vec<Uuid> =
                sqlx::query_scalar("SELECT id FROM fulfillment.stores WHERE enabled")
                    .fetch_all(&mut *tx)
                    .await?;
            for store in stores {
                crate::capabilities::backfill_confirmed(&mut tx, store).await?;
            }
        }
        if !enabled {
            sqlx::query("UPDATE fulfillment.plans SET status='RELEASED' WHERE status='HELD'")
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE fulfillment.capacity_reservations SET status='RELEASED' WHERE status='HELD'").execute(&mut *tx).await?;
        }
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "fulfillment.capacity.activation",
            Uuid::nil(),
            json!({"before":before,"after":enabled,"reason":reason}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn configuration(&self) -> Result<Value> {
        let schedules: Vec<Schedule> = sqlx::query_as(
            "SELECT * FROM fulfillment.schedules ORDER BY source_id,method LIMIT 200",
        )
        .fetch_all(&self.pool)
        .await?;
        let rules: Vec<Rule> =
            sqlx::query_as("SELECT * FROM fulfillment.capacity_rules ORDER BY id LIMIT 200")
                .fetch_all(&self.pool)
                .await?;
        let sources:Vec<(Uuid,String)>=sqlx::query_as("SELECT id,name FROM inventory.inventory_sources WHERE is_enabled ORDER BY name LIMIT 100").fetch_all(&self.pool).await?;
        let areas: Vec<(Uuid, String)> = sqlx::query_as(
            "SELECT id,name FROM inventory.delivery_areas WHERE is_active ORDER BY name LIMIT 200",
        )
        .fetch_all(&self.pool)
        .await?;
        let enabled: bool =
            sqlx::query_scalar("SELECT enabled FROM fulfillment.capacity_settings WHERE id")
                .fetch_one(&self.pool)
                .await?;
        let mut tx = self.pool.begin().await?;
        let stores: Vec<Uuid> =
            sqlx::query_scalar("SELECT id FROM fulfillment.stores WHERE enabled")
                .fetch_all(&mut *tx)
                .await?;
        let legacy_controls:bool=sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM fulfillment.stores WHERE capabilities<>'{}'::jsonb) AND NOT EXISTS(SELECT 1 FROM fulfillment.system_capabilities WHERE capabilities<>'{}'::jsonb)").fetch_one(&mut *tx).await?;
        let mut controls =
            json!({"capacity":false,"scheduling":false,"pickup":false,"geofencing":false});
        for store in stores {
            let c = crate::capabilities::resolve(&mut tx, store).await?;
            for (k, v) in [
                ("capacity", c.capacity_management_enabled),
                ("scheduling", c.admin_manual_scheduling_enabled),
                ("pickup", c.pickup_enabled),
                ("geofencing", c.geofencing()),
            ] {
                if v {
                    controls[k] = json!(true);
                }
            }
        }
        Ok(
            json!({"enabled":enabled,"legacy_controls":legacy_controls,"controls":controls,"schedules":schedules,"rules":rules,"sources":sources,"areas":areas}),
        )
    }
    pub async fn save_schedule(
        &self,
        schedule: Schedule,
        reason: &str,
        who: &domain_admin_iam::Identity,
    ) -> Result<()> {
        who.require("fulfillment.schedule.manage")?;
        let config: Config = serde_json::from_value(schedule.config.clone())
            .map_err(|_| fail("Invalid scheduling configuration"))?;
        config.validate()?;
        if !config.exceptions.is_empty() {
            who.require("fulfillment.override.manage")?;
        }
        if reason.trim().is_empty()
            || reason.len() > 300
            || schedule.method.trim().is_empty()
            || schedule.method.len() > 60
        {
            return Err(fail("Method and change reason are required"));
        }
        let mut tx = domain_inventory::begin(&self.pool).await?;
        crate::capabilities::require_for_source(
            &mut tx,
            Some(schedule.source_id),
            "admin_manual_scheduling",
        )
        .await?;
        if schedule.method == "pickup" {
            crate::capabilities::require_for_source(&mut tx, Some(schedule.source_id), "pickup")
                .await?;
        }
        scheduling::timezone_valid(&mut tx, &schedule.timezone).await?;
        let old: Option<Value> =
            sqlx::query_scalar("SELECT to_jsonb(s) FROM fulfillment.schedules s WHERE id=$1")
                .bind(schedule.id)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(ref old) = old {
            if old["config"]["exceptions"] != json!(config.exceptions) {
                who.require("fulfillment.override.manage")?;
            }
            if old["source_id"] != json!(schedule.source_id)
                || old["method"] != json!(schedule.method)
                || old["area_id"] != json!(schedule.area_id)
            {
                return Err(fail("Schedule scope is immutable; create a new schedule"));
            }
        }
        sqlx::query("INSERT INTO fulfillment.schedules(id,source_id,area_id,method,enabled,timezone,config) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET enabled=$5,timezone=$6,config=$7,updated_at=clock_timestamp()")
            .bind(schedule.id).bind(schedule.source_id).bind(schedule.area_id).bind(&schedule.method).bind(schedule.enabled).bind(&schedule.timezone).bind(&schedule.config).execute(&mut *tx).await?;
        let legacy:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fulfillment.stores s CROSS JOIN fulfillment.system_capabilities d WHERE s.is_default AND s.capabilities='{}'::jsonb AND d.capabilities='{}'::jsonb)").fetch_one(&mut *tx).await?;
        if schedule.enabled && schedule.method != "pickup" && legacy {
            sqlx::query("UPDATE fulfillment.capacity_settings SET enabled=true WHERE id")
                .execute(&mut *tx)
                .await?;
        }
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "fulfillment.schedule.changed",
            schedule.id,
            json!({"before":old,"after":schedule,"reason":reason}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn save_rule(
        &self,
        rule: Rule,
        reason: &str,
        acknowledge: bool,
        who: &domain_admin_iam::Identity,
    ) -> Result<()> {
        who.require("fulfillment.capacity.manage")?;
        if rule.starts_on.is_some() || rule.ends_on.is_some() || rule.local_start.is_some() {
            who.require("fulfillment.override.manage")?;
        }
        rule.validate()?;
        if reason.trim().is_empty() || reason.len() > 300 {
            return Err(fail("A change reason is required"));
        }
        let mut tx = domain_inventory::begin(&self.pool).await?;
        crate::capabilities::require_for_source(&mut tx, rule.source_id, "capacity_management")
            .await?;
        scheduling::timezone_valid(&mut tx, &rule.timezone).await?;
        let old: Option<Value> =
            sqlx::query_scalar("SELECT to_jsonb(r) FROM fulfillment.capacity_rules r WHERE id=$1")
                .bind(rule.id)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(parent_id) = rule.overrides_rule_id {
            who.require("fulfillment.override.manage")?;
            let parent: Rule =
                sqlx::query_as("SELECT * FROM fulfillment.capacity_rules WHERE id=$1")
                    .bind(parent_id)
                    .fetch_optional(&mut *tx)
                    .await?
                    .ok_or(Error::NotFound)?;
            if parent.overrides_rule_id.is_some()
                || parent.id == rule.id
                || rule.starts_on.is_none()
                || rule.ends_on.is_none()
                || parent.source_id != rule.source_id
                || parent.area_id != rule.area_id
                || parent.method != rule.method
                || parent.timezone != rule.timezone
                || parent.period != rule.period
            {
                return Err(fail(
                    "An override must retain its parent scope and specify a date range",
                ));
            }
            let overlaps:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fulfillment.capacity_rules WHERE overrides_rule_id=$1 AND id<>$2 AND enabled AND $3 AND starts_on<=$5 AND ends_on>=$4 AND (local_start IS NULL OR $6::time IS NULL OR local_start=$6))")
              .bind(parent_id).bind(rule.id).bind(rule.enabled).bind(rule.starts_on).bind(rule.ends_on).bind(rule.local_start).fetch_one(&mut *tx).await?;
            if overlaps {
                return Err(fail("Capacity overrides overlap"));
            }
        }
        if let Some(ref old) = old {
            if !old["starts_on"].is_null()
                || !old["ends_on"].is_null()
                || !old["local_start"].is_null()
            {
                who.require("fulfillment.override.manage")?;
            }
            if old["source_id"] != json!(rule.source_id)
                || old["area_id"] != json!(rule.area_id)
                || old["method"] != json!(rule.method)
                || old["period"] != json!(rule.period)
                || old["timezone"] != json!(rule.timezone)
                || old["overrides_rule_id"] != json!(rule.overrides_rule_id)
            {
                return Err(fail("Capacity rule scope is immutable; create a new rule"));
            }
        }
        let booked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fulfillment.capacity_reservations WHERE ends_at>clock_timestamp() AND (status='CONFIRMED' OR (status='HELD' AND expires_at>clock_timestamp())) AND ($1::uuid IS NULL OR source_id=$1) AND ($2::uuid IS NULL OR area_id=$2) AND ($3::text IS NULL OR method=$3))").bind(rule.source_id).bind(rule.area_id).bind(&rule.method).fetch_one(&mut *tx).await?;
        if booked && !acknowledge {
            return Err(fail("CAPACITY_CHANGE_ACKNOWLEDGEMENT_REQUIRED"));
        }
        sqlx::query("INSERT INTO fulfillment.capacity_rules(id,source_id,area_id,method,timezone,local_start,period,limits,overflow_percent,starts_on,ends_on,enabled,overrides_rule_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO UPDATE SET source_id=$2,area_id=$3,method=$4,timezone=$5,local_start=$6,period=$7,limits=$8,overflow_percent=$9,starts_on=$10,ends_on=$11,enabled=$12")
          .bind(rule.id).bind(rule.source_id).bind(rule.area_id).bind(&rule.method).bind(&rule.timezone).bind(rule.local_start).bind(&rule.period).bind(&rule.limits).bind(rule.overflow_percent).bind(rule.starts_on).bind(rule.ends_on).bind(rule.enabled).bind(rule.overrides_rule_id).execute(&mut *tx).await?;
        domain_admin_iam::Service::audit(&mut tx,Some(who.user.id),"fulfillment.capacity.changed",rule.id,json!({"before":old,"after":rule,"reason":reason,"existing_bookings_acknowledged":acknowledge})).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn overview(&self, date: NaiveDate) -> Result<Value> {
        let mut tx = self.pool.begin().await?;
        let schedules: Vec<Schedule> = sqlx::query_as(
            "SELECT * FROM fulfillment.schedules ORDER BY source_id,method LIMIT 200",
        )
        .fetch_all(&mut *tx)
        .await?;
        let booked:Vec<(Uuid,DateTime<Utc>,DateTime<Utc>)>=sqlx::query_as("SELECT DISTINCT r.schedule_id,r.starts_at,r.ends_at FROM fulfillment.capacity_reservations r JOIN fulfillment.schedules s ON s.id=r.schedule_id WHERE r.starts_at>=($1::date::timestamp AT TIME ZONE 'UTC')-interval '2 days' AND r.starts_at<($1::date::timestamp AT TIME ZONE 'UTC')+interval '2 days' AND (r.starts_at AT TIME ZONE s.timezone)::date=$1 ORDER BY r.schedule_id,r.starts_at LIMIT 20000").bind(date).fetch_all(&mut *tx).await?;
        let mut inputs = vec![];
        let mut windows = vec![];
        for schedule in schedules {
            let mut slots = scheduling::generate_operational(&mut tx, &schedule, date).await?;
            for (_, starts_at, ends_at) in booked.iter().filter(|(id, _, _)| *id == schedule.id) {
                if !slots
                    .iter()
                    .any(|s| s.starts_at == *starts_at && s.ends_at == *ends_at)
                {
                    slots.push(Slot {
                        schedule_id: schedule.id,
                        source_id: schedule.source_id,
                        method: schedule.method.clone(),
                        timezone: schedule.timezone.clone(),
                        starts_at: *starts_at,
                        ends_at: *ends_at,
                        availability: "UNAVAILABLE".into(),
                    });
                }
            }
            for slot in slots {
                let mut input = json!(slot);
                input["area_id"] = json!(schedule.area_id);
                inputs.push(input);
                windows.push((slot, schedule.area_id, schedule.enabled));
            }
        }
        let rows: Vec<(i64, Value, i64, i64)> = sqlx::query_as(&format!(
            "{}{}",
            include_str!("capacity_snapshot.sql"),
            include_str!("overview.sql")
        ))
        .bind(json!(inputs))
        .bind(None::<Uuid>)
        .bind(json!({}))
        .bind(None::<Uuid>)
        .fetch_all(&mut *tx)
        .await?;
        let mut result = vec![];
        for ((slot, area, enabled), (_, caps, held, confirmed)) in windows.into_iter().zip(rows) {
            let mut ratio = 0f64;
            let mut full = false;
            for cap in caps.as_array().ok_or(Error::Internal)? {
                let used = cap["used"].as_f64().ok_or(Error::Internal)?;
                let limit = cap["limit"].as_f64().ok_or(Error::Internal)?;
                let effective = cap["effective"].as_f64().ok_or(Error::Internal)?;
                ratio = ratio.max(if limit == 0.0 {
                    if used == 0.0 {
                        0.0
                    } else {
                        2.0
                    }
                } else {
                    used / limit
                });
                full |= used >= effective;
            }
            let status = if !enabled {
                "Disabled"
            } else if ratio > 1.0 {
                "Over Capacity"
            } else if full {
                "Full"
            } else if ratio >= 0.9 {
                "Near Capacity"
            } else if ratio >= 0.5 {
                "Filling"
            } else {
                "Available"
            };
            result.push(json!({"slot":slot,"area_id":area,"reserved":held,"confirmed":confirmed,"utilization":ratio,"status":status,"caps":caps}));
        }
        tx.commit().await?;
        Ok(json!({"date":date,"slots":result}))
    }
}
