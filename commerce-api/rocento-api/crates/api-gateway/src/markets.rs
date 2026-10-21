//! Draft international markets; intentionally isolated from live checkout policy.
use crate::identity::{self, ApiError, App};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    middleware,
    routing::get,
    Json, Router,
};
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;
mod publication;
type Result<T> = std::result::Result<T, ApiError>;
pub fn routes() -> Router<App> {
    Router::new()
        .merge(publication::routes())
        .route("/v1/admin/markets", get(list).post(save))
        .route(
            "/v1/admin/markets/{market}/{kind}/{id}",
            get(entity).put(save_entity),
        )
        .layer(middleware::map_response(
            |mut response: axum::response::Response| async {
                response
                    .headers_mut()
                    .insert("cache-control", "private, no-store".parse().unwrap());
                response
            },
        ))
}
async fn actor(a: &App, h: &HeaderMap, permission: &str, kind: Option<&str>) -> Result<Uuid> {
    let who = a
        .admins
        .authenticate(identity::cookie(h, "admin_session"))
        .await?;
    who.require(permission)?;
    if let Some(kind) = kind {
        let write = permission == "markets.write";
        who.require(match (kind, write) {
            ("product" | "category", false) => "catalog.read",
            ("product" | "category", true) => "catalog.write",
            ("navigation", false) => "cms.read",
            ("navigation", true) => "cms.write",
            _ => return Err(Error::Invalid("Unknown market content type".into()).into()),
        })?;
    }
    Ok(who.user.id)
}
#[derive(Serialize, FromRow)]
struct Market {
    entity_id: i64,
    id: Uuid,
    name: String,
    country: String,
    currency: String,
    locales: Vec<String>,
    default_locale: String,
    revision: i32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    id: Uuid,
    name: String,
    country: String,
    currency: String,
    locales: Vec<String>,
    default_locale: String,
    expected_revision: i32,
}
fn validate(i: &Input) -> Result<()> {
    if i.name.trim().is_empty()
        || i.name.chars().count() > 80
        || i.expected_revision < 0
        || !["EG", "US", "SA", "AE"].contains(&i.country.as_str())
        || !["EGP", "USD", "SAR", "AED"].contains(&i.currency.as_str())
        || i.locales.is_empty()
        || i.locales.len() > 20
        || !i.locales.contains(&i.default_locale)
        || i.locales
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != i.locales.len()
    {
        return Err(Error::Invalid("Provide a market name, supported country/currency and unique languages including the default".into()).into());
    }
    Ok(())
}
async fn list(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    actor(&a, &h, "markets.read", None).await?;
    let items: Vec<Market> = sqlx::query_as("SELECT id,entity_id,name,country,currency,locales,default_locale,revision FROM cart_checkout.market_drafts ORDER BY name,id").fetch_all(&a.admins.pool).await?;
    let mut tx = a.admins.pool.begin().await?;
    let live = domain_cart_checkout::market::configuration(&mut tx).await?;
    let active:Value=sqlx::query_scalar("SELECT jsonb_build_object('revision',a.revision,'release_id',r.id,'market_id',r.market_id,'name',r.name,'created_at',r.created_at) FROM cart_checkout.active_market a LEFT JOIN cart_checkout.market_releases r ON r.id=a.release_id").fetch_one(&mut *tx).await?;
    let source_locale: String =
        sqlx::query_scalar("SELECT source_locale FROM cms.language_settings WHERE singleton")
            .fetch_one(&mut *tx)
            .await?;
    let locales: Vec<String> = sqlx::query_scalar("SELECT source_locale FROM cms.language_settings UNION SELECT locale FROM cms.storefront_languages ORDER BY 1").fetch_all(&mut *tx).await?;
    Ok(Json(
        json!({"items":items,"live":live,"locales":locales,"source_locale":source_locale,"activation_available":true,"active":active}),
    ))
}
async fn save(
    State(a): State<App>,
    h: HeaderMap,
    Json(mut i): Json<Input>,
) -> Result<Json<Market>> {
    let who = actor(&a, &h, "markets.write", None).await?;
    i.name = i.name.trim().to_owned();
    validate(&i)?;
    let mut tx = a.admins.pool.begin().await?;
    let known: Vec<String> = sqlx::query_scalar("SELECT source_locale FROM cms.language_settings UNION SELECT locale FROM cms.storefront_languages").fetch_all(&mut *tx).await?;
    if i.locales.iter().any(|locale| !known.contains(locale)) {
        return Err(
            Error::Invalid("Add each language in Storefront languages first".into()).into(),
        );
    }
    // Lock before checking currency and revision, shared by override writes.
    let previous: Option<Market> = sqlx::query_as("SELECT id,entity_id,name,country,currency,locales,default_locale,revision FROM cart_checkout.market_drafts WHERE id=$1 FOR UPDATE").bind(i.id).fetch_optional(&mut *tx).await?;
    if previous.as_ref().map_or(0, |m| m.revision) != i.expected_revision {
        return Err(Error::Conflict.into());
    }
    if previous.as_ref().is_some_and(|m| m.currency != i.currency) {
        let priced: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cart_checkout.market_overrides WHERE market_id=$1 AND price IS NOT NULL)").bind(i.id).fetch_one(&mut *tx).await?;
        if priced {
            return Err(Error::Invalid(
                "Clear this market's product price overrides before changing currency".into(),
            )
            .into());
        }
    }
    let saved: Option<Market>=sqlx::query_as("INSERT INTO cart_checkout.market_drafts(id,name,country,currency,locales,default_locale) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET name=$2,country=$3,currency=$4,locales=$5,default_locale=$6,revision=market_drafts.revision+1,updated_at=now() WHERE market_drafts.revision=$7 AND $7>0 RETURNING id,entity_id,name,country,currency,locales,default_locale,revision")
        .bind(i.id).bind(i.name).bind(i.country).bind(i.currency).bind(i.locales).bind(i.default_locale).bind(i.expected_revision).fetch_optional(&mut *tx).await?;
    let saved = saved.ok_or(Error::Conflict)?;
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(who),
        "markets.draft.saved",
        saved.id,
        json!({"before":previous,"after":saved}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(saved))
}
async fn source(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    kind: &str,
    id: Uuid,
) -> Result<Value> {
    let value: Option<Value>=match kind {
        "product"=>sqlx::query_scalar("SELECT jsonb_build_object('name',name,'available',active,'price',price::text,'currency',currency) FROM catalog.products WHERE id=$1 FOR SHARE").bind(id).fetch_optional(&mut **tx).await?,
        "category"=>sqlx::query_scalar("SELECT jsonb_build_object('name',name,'available',true) FROM catalog.categories WHERE id=$1 FOR SHARE").bind(id).fetch_optional(&mut **tx).await?,
        "navigation"=>sqlx::query_scalar("SELECT jsonb_build_object('name',COALESCE((SELECT title FROM cms.revisions WHERE document_id=d.id AND version=d.version),d.key),'available',true) FROM cms.documents d WHERE id=$1 AND kind='navigation' FOR SHARE").bind(id).fetch_optional(&mut **tx).await?,
        _=>return Err(Error::Invalid("Unknown market content type".into()).into()),
    };
    value.ok_or_else(|| Error::NotFound.into())
}
async fn entity(
    State(a): State<App>,
    h: HeaderMap,
    Path((market, kind, id)): Path<(Uuid, String, Uuid)>,
) -> Result<Json<Value>> {
    actor(&a, &h, "markets.read", Some(&kind)).await?;
    let mut tx = a.admins.pool.begin().await?;
    let currency: Option<String> = sqlx::query_scalar(
        "SELECT currency FROM cart_checkout.market_drafts WHERE id=$1 FOR SHARE",
    )
    .bind(market)
    .fetch_optional(&mut *tx)
    .await?;
    let currency = currency.ok_or(Error::NotFound)?;
    let base = source(&mut tx, &kind, id).await?;
    let value: Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('available',available,'price',price::text,'revision',revision) FROM cart_checkout.market_overrides WHERE market_id=$1 AND entity_type=$2 AND entity_id=$3").bind(market).bind(kind).bind(id).fetch_optional(&mut *tx).await?;
    Ok(Json(
        json!({"source":base,"currency":currency,"override":value.unwrap_or(json!({"available":null,"price":null,"revision":0}))}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Override {
    available: Option<bool>,
    price: Option<String>,
    expected_revision: i32,
    currency: String,
}
fn valid_price(value: &str) -> bool {
    let parts: Vec<_> = value.split('.').collect();
    !parts[0].is_empty()
        && parts[0].len() <= 10
        && parts[0].bytes().all(|b| b.is_ascii_digit())
        && parts.len() <= 2
        && (parts.len() == 1
            || (!parts[1].is_empty()
                && parts[1].len() <= 2
                && parts[1].bytes().all(|b| b.is_ascii_digit())))
}
async fn save_entity(
    State(a): State<App>,
    h: HeaderMap,
    Path((market, kind, id)): Path<(Uuid, String, Uuid)>,
    Json(i): Json<Override>,
) -> Result<Json<Value>> {
    let who = actor(&a, &h, "markets.write", Some(&kind)).await?;
    if i.expected_revision < 0
        || i.price
            .as_ref()
            .is_some_and(|p| kind != "product" || !valid_price(p))
    {
        return Err(Error::Invalid(
            "Enter a non-negative price with up to two decimal places for products only".into(),
        )
        .into());
    }
    let mut tx = a.admins.pool.begin().await?;
    let currency: Option<String> = sqlx::query_scalar(
        "SELECT currency FROM cart_checkout.market_drafts WHERE id=$1 FOR UPDATE",
    )
    .bind(market)
    .fetch_optional(&mut *tx)
    .await?;
    if currency.ok_or(Error::NotFound)? != i.currency {
        return Err(Error::Conflict.into());
    }
    source(&mut tx, &kind, id).await?;
    let before: Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('available',available,'price',price::text,'revision',revision) FROM cart_checkout.market_overrides WHERE market_id=$1 AND entity_type=$2 AND entity_id=$3").bind(market).bind(&kind).bind(id).fetch_optional(&mut *tx).await?;
    if before
        .as_ref()
        .and_then(|v| v["revision"].as_i64())
        .unwrap_or(0)
        != i.expected_revision as i64
    {
        return Err(Error::Conflict.into());
    }
    let revision: i32=sqlx::query_scalar("INSERT INTO cart_checkout.market_overrides(market_id,entity_type,entity_id,available,price) VALUES($1,$2,$3,$4,$5::text::numeric) ON CONFLICT(market_id,entity_type,entity_id) DO UPDATE SET available=$4,price=$5::text::numeric,revision=market_overrides.revision+1,updated_at=now() RETURNING revision").bind(market).bind(&kind).bind(id).bind(i.available).bind(&i.price).fetch_one(&mut *tx).await?;
    domain_admin_iam::Service::audit(&mut tx,Some(who),"markets.override.saved",id,json!({"market_id":market,"kind":kind,"before":before,"available":i.available,"price":i.price,"currency":i.currency,"revision":revision})).await?;
    tx.commit().await?;
    Ok(Json(json!({"revision":revision})))
}
#[cfg(test)]
mod tests {
    use super::valid_price;
    #[test]
    fn exact_prices() {
        for v in ["0", "0.00", "9999999999.99", "12.5"] {
            assert!(valid_price(v));
        }
        for v in [
            "",
            "-1",
            "1e2",
            "NaN",
            "1.001",
            "1.",
            ".1",
            "10000000000",
            " 12",
            "1.2.3",
        ] {
            assert!(!valid_price(v));
        }
    }
}
