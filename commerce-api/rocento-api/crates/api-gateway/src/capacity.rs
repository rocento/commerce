use crate::identity::{self, ApiError, App};
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::{delete, get, post},
    Json, Router,
};
use domain_fulfillment::{
    capacity::{Rule, Selection, Service},
    scheduling::Schedule,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;
type Result<T> = std::result::Result<T, ApiError>;
pub fn routes() -> Router<App> {
    Router::new()
        .route("/v1/fulfillment/capabilities", get(public_capabilities))
        .route("/v1/fulfillment/availability", get(availability))
        .route("/v1/fulfillment/plan-options", post(plan_options))
        .route("/v1/fulfillment/plans", post(plan_reserve))
        .route("/v1/fulfillment/plans/{id}", delete(plan_release))
        .route("/v1/fulfillment/stores", get(stores))
        .route("/v1/fulfillment/store", post(select_store))
        .route(
            "/v1/admin/fulfillment/capabilities",
            get(capabilities_read).post(capabilities_save),
        )
        .route("/v1/admin/fulfillment/stores", post(store_save))
        .route("/v1/admin/fulfillment/store-sources", post(source_save))
        .route("/v1/fulfillment/delivery-options", get(options))
        .route("/v1/fulfillment/reservations", post(reserve))
        .route("/v1/fulfillment/reservations/{id}", delete(release))
        .route("/v1/admin/fulfillment/configuration", get(configuration))
        .route("/v1/admin/fulfillment/settings", post(settings))
        .route("/v1/admin/fulfillment/capacity", get(overview))
        .route("/v1/admin/fulfillment/schedules", post(schedule))
        .route("/v1/admin/fulfillment/capacity-rules", post(rule))
}
fn service(a: &App) -> Service {
    Service {
        pool: a.cart.pool.clone(),
    }
}
async fn customer(a: &App, h: &HeaderMap) -> Result<Uuid> {
    Ok(a.customers.require_verified(identity::bearer(h)?).await?.id)
}
async fn admin(a: &App, h: &HeaderMap, p: &str) -> Result<domain_admin_iam::Identity> {
    let who = a
        .admins
        .authenticate(identity::cookie(h, "admin_session"))
        .await?;
    who.require(p)?;
    Ok(who)
}
#[derive(Deserialize)]
struct Options {
    location_id: Uuid,
    date: chrono::NaiveDate,
}
#[derive(Deserialize)]
struct Day {
    date: chrono::NaiveDate,
}
async fn options(
    State(a): State<App>,
    h: HeaderMap,
    Query(q): Query<Options>,
) -> Result<Json<Value>> {
    let customer = customer(&a, &h).await?;
    let enabled: bool =
        sqlx::query_scalar("SELECT (SELECT enabled FROM fulfillment.capacity_settings WHERE id) AND (NOT EXISTS(SELECT 1 FROM fulfillment.schedules WHERE enabled) OR EXISTS(SELECT 1 FROM fulfillment.schedules WHERE enabled AND COALESCE(config->>'selection_required','true')='true'))")
            .fetch_one(&a.cart.pool)
            .await?;
    let mut tx = a.cart.pool.begin().await?;
    let cart: Uuid = sqlx::query_scalar("SELECT id FROM cart_checkout.carts WHERE customer_id=$1")
        .bind(customer)
        .fetch_one(&mut *tx)
        .await?;
    let cap = domain_fulfillment::capabilities::for_cart(&mut tx, cart).await?;
    let enabled =
        enabled && cap.scheduled_delivery_enabled && cap.customer_delivery_slot_selection_enabled;
    tx.commit().await?;
    let slots = if enabled {
        service(&a).options(customer, q.location_id, q.date).await?
    } else {
        vec![]
    };
    Ok(Json(json!({"enabled":enabled,"slots":slots})))
}
async fn reserve(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<Selection>,
) -> Result<axum::response::Response> {
    use axum::response::IntoResponse;
    let customer = customer(&a, &h).await?;
    let cap = resolved_capabilities(&a, &h).await?;
    cap.require(
        cap.customer_delivery_slot_selection_enabled,
        "customer_delivery_slot_selection",
    )?;
    match service(&a).reserve(customer,i.clone()).await {
        Ok(r)=>Ok(Json(json!({"id":r.id,"status":r.status,"expires_at":r.expires_at,"source_id":r.source_id,"method":r.method,"starts_at":r.starts_at,"ends_at":r.ends_at})).into_response()),
        Err(infra_auth::Error::Invalid(code)) if ["SLOT_FULL","SLOT_UNAVAILABLE","SLOT_DISABLED","INVENTORY_UNAVAILABLE"].contains(&code.as_str())=>{
            let alternatives=service(&a).alternatives(customer,i.location_id,i.starts_at.date_naive()).await.unwrap_or_default();
            Ok((axum::http::StatusCode::CONFLICT,Json(json!({"code":code,"error":"That delivery window is no longer available. Please choose another window.","alternatives":alternatives}))).into_response())
        }
        Err(e)=>Err(e.into()),
    }
}
async fn release(State(a): State<App>, h: HeaderMap, Path(id): Path<Uuid>) -> Result<Json<Value>> {
    service(&a).release(customer(&a, &h).await?, id).await?;
    Ok(Json(json!({"status":"ok"})))
}
async fn configuration(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    admin(&a, &h, "fulfillment.schedule.view").await?;
    admin(&a, &h, "fulfillment.capacity.view").await?;
    Ok(Json(service(&a).configuration().await?))
}
async fn overview(State(a): State<App>, h: HeaderMap, Query(q): Query<Day>) -> Result<Json<Value>> {
    admin(&a, &h, "fulfillment.capacity.view").await?;
    Ok(Json(service(&a).overview(q.date).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScheduleInput {
    schedule: Schedule,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuleInput {
    rule: Rule,
    reason: String,
    #[serde(default)]
    acknowledge_existing_bookings: bool,
}
async fn schedule(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<ScheduleInput>,
) -> Result<Json<Value>> {
    let who = admin(&a, &h, "fulfillment.schedule.manage").await?;
    service(&a)
        .save_schedule(i.schedule, &i.reason, &who)
        .await?;
    Ok(Json(json!({"status":"ok"})))
}
async fn rule(State(a): State<App>, h: HeaderMap, Json(i): Json<RuleInput>) -> Result<Json<Value>> {
    let who = admin(&a, &h, "fulfillment.capacity.manage").await?;
    service(&a)
        .save_rule(i.rule, &i.reason, i.acknowledge_existing_bookings, &who)
        .await?;
    Ok(Json(json!({"status":"ok"})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    enabled: bool,
    reason: String,
}
async fn settings(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<Settings>,
) -> Result<Json<Value>> {
    let who = admin(&a, &h, "fulfillment.capacity.manage").await?;
    service(&a).set_enabled(i.enabled, &i.reason, &who).await?;
    Ok(Json(json!({"status":"ok"})))
}

async fn availability(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    Ok(Json(
        domain_fulfillment::plans::availability(&a.cart.pool, customer(&a, &h).await?).await?,
    ))
}
async fn plan_options(
    State(a): State<App>,
    h: HeaderMap,
    Json(r): Json<domain_fulfillment::plans::Request>,
) -> Result<Json<domain_fulfillment::plans::Options>> {
    Ok(Json(
        domain_fulfillment::plans::options(&a.cart.pool, customer(&a, &h).await?, r).await?,
    ))
}
async fn plan_reserve(
    State(a): State<App>,
    h: HeaderMap,
    Json(r): Json<domain_fulfillment::plans::Selection>,
) -> Result<axum::response::Response> {
    use axum::response::IntoResponse;
    match domain_fulfillment::plans::reserve(&a.cart.pool,customer(&a,&h).await?,r).await {
        Ok(plan)=>Ok(Json(plan).into_response()),
        Err(infra_auth::Error::Invalid(code)) if ["SLOT_FULL","SLOT_UNAVAILABLE","SINGLE_SOURCE_UNAVAILABLE","INVENTORY_UNAVAILABLE","COMMON_WINDOW_REQUIRED"].contains(&code.as_str())=>Ok((axum::http::StatusCode::CONFLICT,Json(json!({"code":code,"error":"Availability changed. Recalculate your fulfillment choices and try again."}))).into_response()),
        Err(e)=>Err(e.into())
    }
}
async fn plan_release(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    domain_fulfillment::plans::release(&a.cart.pool, customer(&a, &h).await?, id).await?;
    Ok(Json(json!({"status":"ok"})))
}
async fn stores(State(a): State<App>) -> Result<Json<Value>> {
    let stores:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'entity_id',entity_id,'name',name,'is_default',is_default) FROM fulfillment.stores WHERE enabled ORDER BY name").fetch_all(&a.cart.pool).await?;
    Ok(Json(json!(stores)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoreChoice {
    store_id: Uuid,
}
async fn select_store(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<StoreChoice>,
) -> Result<Json<Value>> {
    let customer = customer(&a, &h).await?;
    let mut tx = domain_inventory::begin(&a.cart.pool).await?;
    domain_fulfillment::capabilities::resolve(&mut tx, i.store_id).await?;
    let cart: Uuid = sqlx::query_scalar("SELECT id FROM cart_checkout.carts WHERE customer_id=$1")
        .bind(customer)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("UPDATE fulfillment.capacity_reservations SET status='RELEASED' WHERE cart_id=$1 AND status='HELD'").bind(cart).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE fulfillment.plans SET status='RELEASED' WHERE cart_id=$1 AND status='HELD'",
    )
    .bind(cart)
    .execute(&mut *tx)
    .await?;
    let products: Vec<Uuid> =
        sqlx::query_scalar("SELECT product_id FROM cart_checkout.items WHERE cart_id=$1")
            .bind(cart)
            .fetch_all(&mut *tx)
            .await?;
    for p in products {
        domain_inventory::Service::release(&mut tx, cart, p, "store_changed").await?;
    }
    sqlx::query(
        "UPDATE cart_checkout.carts SET fulfillment_store_id=$2,revision=revision+1 WHERE id=$1",
    )
    .bind(cart)
    .bind(i.store_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"status":"ok"})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CapInput {
    store_id: Option<Uuid>,
    capabilities: Value,
    reason: String,
}
async fn capabilities_save(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<CapInput>,
) -> Result<Json<Value>> {
    let who = admin(&a, &h, "fulfillment.settings.manage").await?;
    let mut tx = domain_inventory::begin(&a.cart.pool).await?;
    domain_fulfillment::capabilities::save(&mut tx, i.store_id, i.capabilities, &i.reason, &who)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"status":"ok"})))
}
async fn capabilities_read(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    admin(&a, &h, "fulfillment.settings.view").await?;
    let mut tx = a.cart.pool.begin().await?;
    let stores: Vec<(Uuid, i64, String, Value)> = sqlx::query_as(
        "SELECT id,entity_id,name,capabilities FROM fulfillment.stores WHERE enabled ORDER BY name",
    )
    .fetch_all(&mut *tx)
    .await?;
    let mut result = vec![];
    for (id, entity_id, name, overrides) in stores {
        let resolved = domain_fulfillment::capabilities::resolve(&mut tx, id).await?;
        result.push(json!({"id":id,"entity_id":entity_id,"name":name,"overrides":overrides,"resolved":resolved}));
    }
    let sources: Vec<Value> =
        sqlx::query_scalar("SELECT to_jsonb(s) FROM fulfillment.store_sources s")
            .fetch_all(&mut *tx)
            .await?;
    let locations:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name',name) FROM inventory.inventory_sources WHERE is_enabled ORDER BY name").fetch_all(&mut *tx).await?;
    let system: Value =
        sqlx::query_scalar("SELECT capabilities FROM fulfillment.system_capabilities WHERE id")
            .fetch_one(&mut *tx)
            .await?;
    Ok(Json(
        json!({"stores":result,"system":system,"sources":sources,"locations":locations}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoreInput {
    id: Uuid,
    name: String,
    reason: String,
    branch: Option<BranchInput>,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct BranchInput {
    address: String,
    delivery_enabled: bool,
    pickup_enabled: bool,
    stock_id: Option<Uuid>,
}
impl BranchInput {
    fn validate(&self) -> infra_auth::Result<()> {
        if self.address.trim().is_empty()
            || self.address.len() > 500
            || (!self.delivery_enabled && !self.pickup_enabled)
        {
            return Err(infra_auth::Error::Invalid(
                "Branch address and at least one fulfillment method required".into(),
            ));
        }
        Ok(())
    }
}
async fn store_save(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<StoreInput>,
) -> Result<Json<Value>> {
    let who = admin(&a, &h, "fulfillment.settings.manage").await?;
    if i.name.trim().is_empty()
        || i.name.len() > 100
        || i.reason.trim().is_empty()
        || i.reason.len() > 300
    {
        return Err(infra_auth::Error::Invalid("Name and reason required".into()).into());
    }
    if let Some(branch) = &i.branch {
        who.require("inventory.write")?;
        if branch.pickup_enabled {
            who.require("fulfillment.pickup.manage")?;
        }
        branch.validate()?;
    }
    let mut tx = domain_inventory::begin(&a.cart.pool).await?;
    let request = json!({"name":i.name.trim(),"reason":i.reason.trim(),"branch":i.branch});
    if i.branch.is_some() {
        let saved: Option<Value> = sqlx::query_scalar(
            "SELECT request FROM fulfillment.branch_creation_receipts WHERE store_id=$1",
        )
        .bind(i.id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(saved) = saved {
            if saved != request {
                return Err(infra_auth::Error::Invalid("This branch request ID was already used with different details. Refresh the saved branch before making changes.".into()).into());
            }
            tx.commit().await?;
            return Ok(Json(json!({"status":"ok"})));
        }
    }
    let before: Option<Value> =
        sqlx::query_scalar("SELECT to_jsonb(s) FROM fulfillment.stores s WHERE id=$1")
            .bind(i.id)
            .fetch_optional(&mut *tx)
            .await?;
    if i.branch.is_some() && before.is_some() {
        return Err(infra_auth::Error::Invalid(
            "Store already exists. Check the saved branch before retrying.".into(),
        )
        .into());
    }
    sqlx::query("INSERT INTO fulfillment.stores(id,name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET name=$2").bind(i.id).bind(&i.name).execute(&mut *tx).await?;
    if let Some(branch) = &i.branch {
        if let Some(stock) = branch.stock_id {
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM inventory.stocks WHERE id=$1)")
                    .bind(stock)
                    .fetch_one(&mut *tx)
                    .await?;
            if !exists {
                return Err(infra_auth::Error::Invalid(
                    "Selected stock pool no longer exists".into(),
                )
                .into());
            }
        }
        let source = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO inventory.inventory_sources(id,code,name,address) VALUES($1,$2,$3,$4)",
        )
        .bind(source)
        .bind(format!("branch-{}", i.id))
        .bind(i.name.trim())
        .bind(branch.address.trim())
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO fulfillment.store_sources(store_id,source_id,pickup_enabled) VALUES($1,$2,$3)")
            .bind(i.id).bind(source).bind(branch.pickup_enabled).execute(&mut *tx).await?;
        if let Some(stock) = branch.stock_id {
            sqlx::query("INSERT INTO inventory.source_stock_links(stock_id,source_id,priority) VALUES($1,$2,0)")
                .bind(stock).bind(source).execute(&mut *tx).await?;
        }
        let policy = json!({"delivery_enabled":branch.delivery_enabled,"asap_delivery_enabled":branch.delivery_enabled,
            "scheduled_delivery_enabled":false,"customer_delivery_slot_selection_enabled":false,
            "split_order_scheduling_enabled":false,"pickup_enabled":branch.pickup_enabled,"pickup_scheduling_enabled":false});
        sqlx::query("UPDATE fulfillment.stores SET capabilities=$2 WHERE id=$1")
            .bind(i.id)
            .bind(policy)
            .execute(&mut *tx)
            .await?;
        domain_fulfillment::capabilities::resolve(&mut tx, i.id)
            .await?
            .validate()?;
        infra_events::record(
            &mut tx,
            "inventory.source_saved",
            json!({"id":source,"actor_id":who.user.id}),
        )
        .await?;
        domain_admin_iam::Service::audit(&mut tx,Some(who.user.id),"fulfillment.branch.created",i.id,
            json!({"source_id":source,"stock_id":branch.stock_id,"address":branch.address,"delivery_enabled":branch.delivery_enabled,"pickup_enabled":branch.pickup_enabled,"reason":i.reason})).await?;
    }
    if i.branch.is_some() {
        sqlx::query(
            "INSERT INTO fulfillment.branch_creation_receipts(store_id,request) VALUES($1,$2)",
        )
        .bind(i.id)
        .bind(request)
        .execute(&mut *tx)
        .await?;
    }
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(who.user.id),
        "fulfillment.store.changed",
        i.id,
        json!({"before":before,"name":i.name,"reason":i.reason}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"status":"ok"})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceInput {
    store_id: Uuid,
    source_id: Uuid,
    pickup_enabled: bool,
    pickup_instructions: String,
    preparation_minutes: i32,
    reason: String,
}
async fn source_save(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<SourceInput>,
) -> Result<Json<Value>> {
    let who = admin(&a, &h, "fulfillment.settings.manage").await?;
    who.require("fulfillment.pickup.manage")?;
    if i.reason.trim().is_empty()
        || i.reason.len() > 300
        || i.pickup_instructions.len() > 1000
        || !(1..=1440).contains(&i.preparation_minutes)
    {
        return Err(infra_auth::Error::Invalid("Invalid location settings".into()).into());
    }
    let mut tx = domain_inventory::begin(&a.cart.pool).await?;
    let cap = domain_fulfillment::capabilities::resolve(&mut tx, i.store_id).await?;
    let before: Option<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(s) FROM fulfillment.store_sources s WHERE store_id=$1 AND source_id=$2",
    )
    .bind(i.store_id)
    .bind(i.source_id)
    .fetch_optional(&mut *tx)
    .await?;
    // Preserve a configured pickup location while the store temporarily disables pickup.
    // Enabling pickup on a new or previously disabled location still requires the capability.
    if i.pickup_enabled && before.as_ref().and_then(|v| v["pickup_enabled"].as_bool()) != Some(true)
    {
        cap.require(cap.pickup_enabled, "pickup")?;
    }
    sqlx::query("INSERT INTO fulfillment.store_sources VALUES($1,$2,$3,$4,$5) ON CONFLICT(store_id,source_id) DO UPDATE SET pickup_enabled=$3,pickup_instructions=$4,preparation_minutes=$5").bind(i.store_id).bind(i.source_id).bind(i.pickup_enabled).bind(&i.pickup_instructions).bind(i.preparation_minutes).execute(&mut *tx).await?;
    domain_admin_iam::Service::audit(&mut tx,Some(who.user.id),"fulfillment.source.changed",i.source_id,json!({"store_id":i.store_id,"before":before,"pickup_enabled":i.pickup_enabled,"pickup_instructions":i.pickup_instructions,"preparation_minutes":i.preparation_minutes,"reason":i.reason})).await?;
    tx.commit().await?;
    Ok(Json(json!({"status":"ok"})))
}

pub(crate) async fn resolved_capabilities(
    a: &App,
    h: &HeaderMap,
) -> Result<domain_fulfillment::capabilities::Capabilities> {
    let owner = crate::cart::customer(a, h).await?;
    let mut tx = a.cart.pool.begin().await?;
    let store:Uuid=sqlx::query_scalar("SELECT COALESCE((SELECT fulfillment_store_id FROM cart_checkout.carts WHERE customer_id=$1),fulfillment.default_store())").bind(owner).fetch_one(&mut *tx).await?;
    Ok(domain_fulfillment::capabilities::resolve(&mut tx, store).await?)
}
async fn public_capabilities(
    State(a): State<App>,
    h: HeaderMap,
) -> Result<Json<domain_fulfillment::capabilities::Capabilities>> {
    Ok(Json(resolved_capabilities(&a, &h).await?))
}

#[cfg(test)]
mod branch_setup_tests {
    use super::*;

    #[test]
    fn branch_requires_address_and_a_fulfillment_method() {
        for (address, delivery, pickup, valid) in [
            ("Ismailia branch", true, false, true),
            ("Ismailia branch", false, true, true),
            ("Ismailia branch", true, true, true),
            ("Ismailia branch", false, false, false),
            ("   ", true, false, false),
        ] {
            assert_eq!(
                BranchInput {
                    address: address.into(),
                    delivery_enabled: delivery,
                    pickup_enabled: pickup,
                    stock_id: None
                }
                .validate()
                .is_ok(),
                valid
            );
        }
        assert!(BranchInput {
            address: "x".repeat(501),
            delivery_enabled: true,
            pickup_enabled: false,
            stock_id: None
        }
        .validate()
        .is_err());
    }

    #[test]
    fn existing_store_clients_remain_compatible_and_branch_input_is_strict() {
        let base = json!({"id":Uuid::new_v4(),"name":"Online store","reason":"Setup"});
        assert!(serde_json::from_value::<StoreInput>(base.clone())
            .unwrap()
            .branch
            .is_none());
        let mut invalid = base;
        invalid["branch"] = json!({"address":"Branch","delivery_enabled":true,"pickup_enabled":false,"stock_quantity":100});
        assert!(serde_json::from_value::<StoreInput>(invalid).is_err());
    }
}
