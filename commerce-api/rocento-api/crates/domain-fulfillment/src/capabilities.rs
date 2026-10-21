//! Store-scoped policy resolution. No cache: every checkout transaction observes current policy.
use domain_inventory::Tx;
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Capabilities {
    pub delivery_enabled: bool,
    pub pickup_enabled: bool,
    pub scheduled_delivery_enabled: bool,
    pub asap_delivery_enabled: bool,
    pub capacity_management_enabled: bool,
    pub checkout_capacity_holds_enabled: bool,
    pub geo_fencing_enabled: bool,
    #[serde(default)]
    pub global_delivery_enabled: bool,
    pub multi_source_fulfillment_enabled: bool,
    pub split_order_scheduling_enabled: bool,
    pub automatic_source_routing_enabled: bool,
    pub customer_delivery_slot_selection_enabled: bool,
    pub admin_manual_scheduling_enabled: bool,
    pub pickup_scheduling_enabled: bool,
    pub split_delivery_mode: String,
    /// Explicit non-polygon eligibility, matched against saved address geography.city_id.
    pub delivery_city_ids: Vec<String>,
}
impl Capabilities {
    pub fn legacy(enabled: bool) -> Self {
        Self {
            delivery_enabled: true,
            pickup_enabled: false,
            scheduled_delivery_enabled: enabled,
            asap_delivery_enabled: !enabled,
            capacity_management_enabled: enabled,
            checkout_capacity_holds_enabled: enabled,
            geo_fencing_enabled: true,
            global_delivery_enabled: false,
            multi_source_fulfillment_enabled: true,
            split_order_scheduling_enabled: false,
            automatic_source_routing_enabled: true,
            customer_delivery_slot_selection_enabled: enabled,
            admin_manual_scheduling_enabled: true,
            pickup_scheduling_enabled: false,
            split_delivery_mode: "same_window_required".into(),
            delivery_city_ids: vec![],
        }
    }
    pub fn global_delivery(&self) -> bool {
        self.delivery_enabled && self.global_delivery_enabled
    }
    pub fn geofencing(&self) -> bool {
        self.geo_fencing_enabled && !self.global_delivery()
    }
    pub fn validate(&self) -> Result<()> {
        if (!self.delivery_enabled && !self.pickup_enabled)
            || (self.delivery_enabled
                && !self.scheduled_delivery_enabled
                && !self.asap_delivery_enabled)
            || (self.scheduled_delivery_enabled && !self.delivery_enabled)
            || (self.pickup_scheduling_enabled && !self.pickup_enabled)
            || (self.customer_delivery_slot_selection_enabled && !self.scheduled_delivery_enabled)
            || (self.checkout_capacity_holds_enabled && !self.capacity_management_enabled)
            || (self.split_order_scheduling_enabled
                && (!self.multi_source_fulfillment_enabled || !self.scheduled_delivery_enabled))
            || !["same_window_required", "independent_windows"]
                .contains(&self.split_delivery_mode.as_str())
            || self.delivery_city_ids.len() > 500
        {
            return Err(Error::Invalid("INVALID_FULFILLMENT_CAPABILITIES".into()));
        }
        Ok(())
    }
    pub fn require(&self, enabled: bool, name: &str) -> Result<()> {
        if !enabled {
            tracing::info!(capability = name, "fulfillment.capability.disabled_request");
            return Err(Error::Invalid(format!(
                "FULFILLMENT_CAPABILITY_DISABLED:{name}"
            )));
        }
        Ok(())
    }
    pub fn scheduled(&self, method: &str) -> bool {
        if method == "pickup" {
            self.pickup_scheduling_enabled
        } else {
            self.scheduled_delivery_enabled
        }
    }
}
pub async fn resolve(tx: &mut Tx<'_>, store: Uuid) -> Result<Capabilities> {
    let enabled: bool =
        sqlx::query_scalar("SELECT enabled FROM fulfillment.capacity_settings WHERE id")
            .fetch_one(&mut **tx)
            .await?;
    let manual:bool=sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM fulfillment.schedules WHERE enabled AND method<>'pickup') OR EXISTS(SELECT 1 FROM fulfillment.schedules WHERE enabled AND method<>'pickup' AND COALESCE(config->>'selection_required','true')='true')").fetch_one(&mut **tx).await?;
    let mut defaults = Capabilities::legacy(enabled);
    defaults.customer_delivery_slot_selection_enabled = enabled && manual;
    let mut merged = json!(defaults);
    let system: Value =
        sqlx::query_scalar("SELECT capabilities FROM fulfillment.system_capabilities WHERE id")
            .fetch_one(&mut **tx)
            .await?;
    let local: Value =
        sqlx::query_scalar("SELECT capabilities FROM fulfillment.stores WHERE id=$1 AND enabled")
            .bind(store)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or(Error::NotFound)?;
    for patch in [system, local] {
        for (key, value) in patch.as_object().ok_or(Error::Internal)? {
            merged[key] = value.clone();
        }
    }
    let c: Capabilities = serde_json::from_value(merged)
        .map_err(|_| Error::Invalid("INVALID_FULFILLMENT_CAPABILITIES".into()))?;
    c.validate()?;
    Ok(c)
}
pub async fn for_cart(tx: &mut Tx<'_>, cart: Uuid) -> Result<Capabilities> {
    let store =
        sqlx::query_scalar("SELECT fulfillment_store_id FROM cart_checkout.carts WHERE id=$1")
            .bind(cart)
            .fetch_one(&mut **tx)
            .await?;
    resolve(tx, store).await
}
pub async fn save(
    tx: &mut Tx<'_>,
    store: Option<Uuid>,
    patch: Value,
    reason: &str,
    who: &domain_admin_iam::Identity,
) -> Result<()> {
    who.require("fulfillment.settings.manage")?;
    if reason.trim().is_empty() || reason.len() > 300 || !patch.is_object() {
        return Err(Error::Invalid(
            "A change reason and capability object are required".into(),
        ));
    }
    // Reject unknown keys and type errors even when a store overrides the system value.
    let mut probe = json!(Capabilities::legacy(false));
    for (k, v) in patch.as_object().ok_or(Error::Internal)? {
        if probe.get(k).is_none() {
            return Err(Error::Invalid("Unknown fulfillment capability".into()));
        }
        probe[k] = v.clone();
    }
    let _: Capabilities = serde_json::from_value(probe)
        .map_err(|_| Error::Invalid("Invalid capability type".into()))?;
    let before: Value = if let Some(id) = store {
        let old = sqlx::query_scalar(
            "SELECT capabilities FROM fulfillment.stores WHERE id=$1 FOR UPDATE",
        )
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
        sqlx::query("UPDATE fulfillment.stores SET capabilities=$2 WHERE id=$1")
            .bind(id)
            .bind(&patch)
            .execute(&mut **tx)
            .await?;
        old
    } else {
        let old = sqlx::query_scalar(
            "SELECT capabilities FROM fulfillment.system_capabilities WHERE id FOR UPDATE",
        )
        .fetch_one(&mut **tx)
        .await?;
        sqlx::query("UPDATE fulfillment.system_capabilities SET capabilities=$1 WHERE id")
            .bind(&patch)
            .execute(&mut **tx)
            .await?;
        old
    };
    let stores: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM fulfillment.stores WHERE enabled AND ($1::uuid IS NULL OR id=$1)",
    )
    .bind(store)
    .fetch_all(&mut **tx)
    .await?;
    for id in stores {
        if resolve(tx, id).await?.capacity_management_enabled {
            backfill_confirmed(tx, id).await?;
        }
    }
    // Configuration revisions invalidate temporary plans atomically; confirmed orders keep snapshots.
    sqlx::query("UPDATE fulfillment.capacity_reservations r SET status='RELEASED' FROM cart_checkout.carts c WHERE r.cart_id=c.id AND r.status='HELD' AND ($1::uuid IS NULL OR c.fulfillment_store_id=$1)").bind(store).execute(&mut **tx).await?;
    sqlx::query("UPDATE fulfillment.plans SET status='RELEASED' WHERE status='HELD' AND ($1::uuid IS NULL OR store_id=$1)").bind(store).execute(&mut **tx).await?;
    domain_admin_iam::Service::audit(
        tx,
        Some(who.user.id),
        "fulfillment.settings.changed",
        store.unwrap_or(Uuid::nil()),
        json!({"store_id":store,"before":before,"after":patch,"reason":reason}),
    )
    .await?;
    Ok(())
}
/// Shared calendars/rules are editable when an affected store uses that capability.
pub async fn require_for_source(
    tx: &mut Tx<'_>,
    source: Option<Uuid>,
    capability: &str,
) -> Result<()> {
    let ids:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM fulfillment.stores s WHERE enabled AND ($1::uuid IS NULL OR is_default OR EXISTS(SELECT 1 FROM fulfillment.store_sources ss WHERE ss.store_id=s.id AND ss.source_id=$1))").bind(source).fetch_all(&mut **tx).await?;
    for id in ids {
        let legacy:bool=sqlx::query_scalar("SELECT s.is_default AND s.capabilities='{}'::jsonb AND d.capabilities='{}'::jsonb FROM fulfillment.stores s CROSS JOIN fulfillment.system_capabilities d WHERE s.id=$1").bind(id).fetch_one(&mut **tx).await?;
        if legacy && capability == "capacity_management" {
            return Ok(());
        }
        let c = resolve(tx, id).await?;
        let enabled = match capability {
            "admin_manual_scheduling" => c.admin_manual_scheduling_enabled,
            "capacity_management" => c.capacity_management_enabled,
            "pickup" => c.pickup_enabled,
            _ => false,
        };
        if enabled {
            return Ok(());
        }
    }
    Err(Error::Invalid(format!(
        "FULFILLMENT_CAPABILITY_DISABLED:{capability}"
    )))
}

/// Activating caps accounts for already-promised groups without revoking them or over-admitting new work.
pub(crate) async fn backfill_confirmed(tx: &mut Tx<'_>, store: Uuid) -> Result<()> {
    sqlx::query(r#"INSERT INTO fulfillment.capacity_reservations(id,customer_id,cart_id,location_id,schedule_id,source_id,area_id,method,timezone,starts_at,ends_at,fingerprint,requirement,status,expires_at,order_id,idempotency_key,release_before,group_id)
        SELECT gen_random_uuid(),p.customer_id,p.cart_id,COALESCE(p.location_id,g.source_id),g.schedule_id,g.source_id,g.area_id,COALESCE(s.method,g.method),g.timezone,g.starts_at,g.ends_at,p.fingerprint,g.requirement,'CONFIRMED',p.expires_at,p.order_id,gen_random_uuid(),g.release_before,g.id
        FROM fulfillment.plans p JOIN fulfillment.plan_groups g ON g.plan_id=p.id LEFT JOIN fulfillment.schedules s ON s.id=g.schedule_id
        WHERE p.store_id=$1 AND p.status='CONFIRMED' AND NOT EXISTS(SELECT 1 FROM fulfillment.capacity_reservations r WHERE r.group_id=g.id)"#).bind(store).execute(&mut **tx).await?;
    Ok(())
}
