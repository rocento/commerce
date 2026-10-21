//! Checkout provenance, shared by browser, assistant and reorder purchases.
use super::*;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Context {
    pub id: Option<Uuid>,
    pub release_id: Option<Uuid>,
    pub revision: i64,
    pub store_revision: i64,
    pub country: String,
    pub currency: String,
}
#[derive(FromRow)]
struct ContextRow {
    cart_market: Option<Uuid>,
    currency: Option<String>,
    region: Option<String>,
    version: Option<i64>,
    release_id: Option<Uuid>,
    revision: Option<i64>,
    market_id: Option<Uuid>,
    country: Option<String>,
    market_currency: Option<String>,
}

pub async fn for_cart(tx: &mut Tx<'_>, cart: Uuid) -> Result<Context> {
    // All provenance comes from one statement snapshot. Keep the cart lookup
    // optional so a missing cart is still NotFound; missing singleton settings
    // retain their database-integrity failure rather than becoming defaults.
    let ContextRow { cart_market: id, currency, region, version, release_id, revision, market_id, country, market_currency } = sqlx::query_as::<_, ContextRow>(
        "SELECT c.market_id AS cart_market,cfg.currency,cfg.region,cfg.version,a.release_id,a.revision,r.market_id,r.country,r.currency AS market_currency \
         FROM cart_checkout.carts c \
         LEFT JOIN cart_checkout.market_configuration cfg ON cfg.singleton \
         LEFT JOIN cart_checkout.active_market a ON a.singleton \
         LEFT JOIN cart_checkout.market_releases r ON r.id=a.release_id WHERE c.id=$1"
    ).bind(cart).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)?;
    let currency = currency.ok_or(sqlx::Error::RowNotFound)?;
    let region = region.ok_or(sqlx::Error::RowNotFound)?;
    let version = version.ok_or(sqlx::Error::RowNotFound)?;
    let revision = revision.ok_or(sqlx::Error::RowNotFound)?;
    if id.is_some() && id != market_id {
        return Err(Error::Invalid(
            "MARKET_NOT_ACTIVE: review your cart in the current storefront market".into(),
        ));
    }
    if country.as_ref().is_some_and(|v| v != &region)
        || market_currency.as_ref().is_some_and(|v| v != &currency)
    {
        return Err(Error::Invalid("MARKET_CONFIGURATION_CHANGED: the active market does not match store checkout settings".into()));
    }
    Ok(Context {
        id: market_id,
        release_id,
        revision,
        store_revision: version,
        country: region,
        currency,
    })
}
