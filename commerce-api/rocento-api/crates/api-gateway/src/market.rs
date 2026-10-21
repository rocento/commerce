//! Tenant database market administration and exact measured quantities.
use crate::identity::{self, ApiError, App};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::{get, put},
    Json, Router,
};
use domain_cart_checkout::market as m;
use infra_auth::Error;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;
type Result<T> = std::result::Result<T, ApiError>;
pub fn routes() -> Router<App> {
    Router::new()
        .route("/v1/market", get(read))
        .route("/v1/market/products/{id}", get(product))
        .route("/v1/cart/items/{id}/measure", put(measure))
        .route("/v1/admin/market", put(configure))
        .route("/v1/admin/market/products/{id}", put(rule))
}
fn response(v: impl serde::Serialize) -> Response {
    let mut r = Json(v).into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    r
}
async fn read(State(a): State<App>) -> Result<Response> {
    let mut tx = a.customers.pool.begin().await?;
    Ok(response(m::configuration(&mut tx).await?))
}
async fn product(State(a): State<App>, Path(id): Path<Uuid>) -> Result<Response> {
    let mut tx = a.customers.pool.begin().await?;
    domain_catalog::Service::checkout_product(&mut tx, id).await?;
    Ok(response(
        json!({"product_id":id,"rule":m::rule(&mut tx,id).await?,"price_basis":"per_sellable_unit"}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Measure {
    quantity: String,
}
async fn measure(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<Measure>,
) -> Result<Response> {
    let customer = crate::cart::customer(&a, &h).await?;
    Ok(response(
        a.cart
            .set_measure(
                customer,
                identity::cookie(&h, "guest_cart"),
                id,
                &i.quantity,
            )
            .await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configure {
    enabled: bool,
    currency: String,
    expected_version: i64,
    region: String,
    industry: String,
    delivery_fee: String,
    reason: String,
}
async fn configure(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<Configure>,
) -> Result<Response> {
    let who = a
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?;
    who.require("assistant.settings.write")?;
    if !["US", "EG"].contains(&i.region.as_str())
        || !["general", "grocery"].contains(&i.industry.as_str())
        || !["USD", "EGP"].contains(&i.currency.as_str())
        || i.reason.trim().is_empty()
        || i.reason.len() > 300
    {
        return Err(Error::Invalid("MARKET_CONFIGURATION_INVALID".into()).into());
    }
    let delivery_fee = i
        .delivery_fee
        .parse()
        .map_err(|_| Error::Invalid("MARKET_MONEY_INVALID".into()))?;
    m::exact_money(delivery_fee, &i.currency)?;
    let mut tx = domain_inventory::begin(&a.customers.pool).await?;
    let old = m::configuration(&mut tx).await?;
    if old.version != i.expected_version {
        return Err(Error::Invalid("MARKET_CONFIGURATION_STALE".into()).into());
    }
    let active: bool = sqlx::query_scalar(
        "SELECT release_id IS NOT NULL FROM cart_checkout.active_market WHERE singleton",
    )
    .fetch_one(&mut *tx)
    .await?;
    if active && (old.currency != i.currency || old.region != i.region) {
        return Err(Error::Invalid(
            "Restore market defaults before changing the store country or currency".into(),
        )
        .into());
    }
    if old.currency != i.currency {
        let unsafe_change:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cart_checkout.items) OR EXISTS(SELECT 1 FROM catalog.products WHERE active AND currency<>$1) OR EXISTS(SELECT 1 FROM pricing_promotions.rules) OR EXISTS(SELECT 1 FROM cart_checkout.quotes WHERE expires_at>clock_timestamp())").bind(&i.currency).fetch_one(&mut *tx).await?;
        if unsafe_change {
            return Err(Error::Invalid("MARKET_CURRENCY_CHANGE_REQUIRES_EMPTY_CARTS_NO_LIVE_QUOTES_AND_REVIEWED_CATALOG_PROMOTIONS".into()).into());
        }
    }
    sqlx::query("UPDATE cart_checkout.market_configuration SET enabled=$1,currency=$2,region=$3,industry=$4,version=version+1 WHERE singleton").bind(i.enabled).bind(&i.currency).bind(&i.region).bind(&i.industry).execute(&mut *tx).await?;
    sqlx::query("UPDATE fulfillment.delivery_fee_settings SET amount=$1,currency=$2,updated_at=clock_timestamp() WHERE id").bind(delivery_fee).bind(&i.currency).execute(&mut *tx).await?;
    domain_admin_iam::Service::audit(&mut tx,Some(who.user.id),"market.configuration.changed",Uuid::nil(),json!({"before":old,"currency":i.currency,"enabled":i.enabled,"region":i.region,"industry":i.industry,"delivery_fee":i.delivery_fee,"reason":i.reason})).await?;
    if old.currency != i.currency {
        sqlx::query("UPDATE cart_checkout.delegation_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE revoked_at IS NULL").execute(&mut *tx).await?;
        sqlx::query(
            "UPDATE cart_checkout.trust_agents SET currency=$1 WHERE id=$2 AND protocol='browser'",
        )
        .bind(&i.currency)
        .bind(domain_cart_checkout::trust::BROWSER_AGENT)
        .execute(&mut *tx)
        .await?;
    }
    let result = m::configuration(&mut tx).await?;
    tx.commit().await?;
    Ok(response(result))
}
async fn rule(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<m::SellingRule>,
) -> Result<Response> {
    let who = a
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?;
    who.require("assistant.settings.write")?;
    i.validate()?;
    let mut tx = domain_inventory::begin(&a.customers.pool).await?;
    let product = domain_catalog::Service::checkout_product(&mut tx, id).await?;
    m::validate_basis(&product, &i)?;
    sqlx::query("INSERT INTO cart_checkout.selling_rules(product_id,rule) VALUES($1,$2) ON CONFLICT(product_id) DO UPDATE SET rule=$2,updated_at=now()").bind(id).bind(json!(i)).execute(&mut *tx).await?;
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(who.user.id),
        "market.selling_rule.changed",
        id,
        json!(i),
    )
    .await?;
    tx.commit().await?;
    Ok(response(
        json!({"product_id":id,"rule":i,"price_basis":"per_sellable_unit"}),
    ))
}
