//! Atomic publication of one market to the existing storefront and checkout configuration.
use super::*;
use axum::{extract::Query, routing::post};
use sqlx::{Postgres, Transaction};
pub(super) fn routes() -> Router<App> {
    Router::new()
        .route("/v1/admin/markets/{id}/readiness", get(readiness))
        .route("/v1/admin/markets/{id}/preview", get(preview))
        .route("/v1/admin/markets/{id}/publish", post(publish))
        .route("/v1/admin/markets/restore-defaults", post(restore))
        .route("/v1/markets/current", get(current))
}
async fn current(State(a): State<App>) -> Result<Json<Value>> {
    Ok(Json(sqlx::query_scalar("SELECT jsonb_build_object('revision',a.revision,'release_id',r.id,'id',r.market_id,'name',COALESCE(r.name,c.region),'country',c.region,'currency',c.currency) FROM cart_checkout.active_market a CROSS JOIN cart_checkout.market_configuration c LEFT JOIN cart_checkout.market_releases r ON r.id=a.release_id").fetch_one(&a.admins.pool).await?))
}
#[derive(Serialize)]
struct Check {
    code: &'static str,
    ready: bool,
    message: String,
}
#[derive(Serialize)]
struct Readiness {
    token: String,
    ready: bool,
    active_revision: i64,
    checks: Vec<Check>,
    available_products: i64,
    missing_prices: i64,
    overridden_products: i64,
    source_locale: String,
    delivery: Value,
    tax: Value,
}
async fn assess(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<Readiness> {
    let m:Market=sqlx::query_as("SELECT id,entity_id,name,country,currency,locales,default_locale,revision FROM cart_checkout.market_drafts WHERE id=$1 FOR SHARE").bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)?;
    let config = domain_cart_checkout::market::configuration(tx).await?;
    let source: String =
        sqlx::query_scalar("SELECT source_locale FROM cms.language_settings WHERE singleton")
            .fetch_one(&mut **tx)
            .await?;
    let fee:Value=sqlx::query_scalar("SELECT jsonb_build_object('amount',amount::text,'currency',currency) FROM fulfillment.delivery_fee_settings WHERE id").fetch_one(&mut **tx).await?;
    let tax:Value=sqlx::query_scalar("SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'name',name,'rate_bps',rate_bps,'tax_delivery',tax_delivery,'min_lat',min_lat,'max_lat',max_lat,'min_lon',min_lon,'max_lon',max_lon,'priority',priority,'updated_at',updated_at) ORDER BY priority DESC,id),'[]') FROM tax.rules WHERE active").fetch_one(&mut **tx).await?;
    let overrides:Value=sqlx::query_scalar("SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY entity_type,entity_id),'[]') FROM cart_checkout.market_overrides o WHERE market_id=$1").bind(id).fetch_one(&mut **tx).await?;
    let (available,missing,overridden):(i64,i64,i64)=sqlx::query_as("SELECT count(*) FILTER(WHERE p.active AND COALESCE(o.available,true)),count(*) FILTER(WHERE p.active AND COALESCE(o.available,true) AND o.price IS NULL AND p.currency<>$2),count(*) FILTER(WHERE o.price IS NOT NULL OR o.available IS NOT NULL) FROM catalog.products p LEFT JOIN cart_checkout.market_overrides o ON o.market_id=$1 AND o.entity_type='product' AND o.entity_id=p.id").bind(id).bind(&m.currency).fetch_one(&mut **tx).await?;
    // Catalog source changes invalidate the review token, including inherited values.
    let catalog_hash:String=sqlx::query_scalar("SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(id,price,currency,active,product_type,parent_id,updated_at) ORDER BY id)::text,'')) FROM catalog.products").fetch_one(&mut **tx).await?;
    let active_revision: i64 =
        sqlx::query_scalar("SELECT revision FROM cart_checkout.active_market WHERE singleton")
            .fetch_one(&mut **tx)
            .await?;
    let parent_prices:i64=sqlx::query_scalar("SELECT count(*) FROM cart_checkout.market_overrides o JOIN catalog.products p ON p.id=o.entity_id WHERE o.market_id=$1 AND o.entity_type='product' AND o.price IS NOT NULL AND p.product_type<>'simple'").bind(id).fetch_one(&mut **tx).await?;
    let checks=vec![
        Check{code:"country",ready:m.country==config.region,message:format!("Uses existing {} delivery coverage and tax configuration; new countries need their own setup.",config.region)},
        Check{code:"currency",ready:m.currency==config.currency&&fee["currency"]==m.currency&&["EGP","USD"].contains(&m.currency.as_str()),message:format!("Checkout and delivery currently settle in {}. Prices are never automatically converted.",config.currency)},
        Check{code:"language",ready:m.default_locale==source,message:format!("The live storefront uses {source}. Other configured languages remain drafts; this release does not publish translations.")},
        Check{code:"prices",ready:missing==0,message:format!("{missing} available products need an explicit {} price.",m.currency)},
        Check{code:"catalog",ready:available>0,message:format!("{available} products are available after applying these overrides.")},
        Check{code:"composite_prices",ready:parent_prices==0,message:format!("{parent_prices} price overrides target composite listings. Set prices on their sellable child products instead.")},
        Check{code:"payment",ready:true,message:"Uses the existing cash-on-delivery payment method and geographic tax rules.".into()},
    ];
    let token=infra_auth::digest(&json!({"market":market_review_facts(&m),"config":config,"source":source,"fee":fee,"tax":tax,"overrides":overrides,"catalog":catalog_hash,"active":active_revision}).to_string());
    Ok(Readiness {
        token,
        ready: checks.iter().all(|c| c.ready),
        active_revision,
        checks,
        available_products: available,
        missing_prices: missing,
        overridden_products: overridden,
        source_locale: source,
        delivery: fee,
        tax,
    })
}
async fn readiness(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Readiness>> {
    actor(&a, &h, "markets.read", None).await?;
    let mut tx = a.admins.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    Ok(Json(assess(&mut tx, id).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Preview {
    #[serde(default)]
    offset: i64,
    #[serde(default)]
    q: String,
}
async fn preview(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<Preview>,
) -> Result<Json<Value>> {
    actor(&a, &h, "markets.read", Some("product")).await?;
    if q.offset < 0 || q.offset > 1000000 || q.q.len() > 200 {
        return Err(Error::Invalid("Invalid preview filter".into()).into());
    }
    let mut tx = a.admins.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let currency: String =
        sqlx::query_scalar("SELECT currency FROM cart_checkout.market_drafts WHERE id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::NotFound)?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',p.id,'sku',p.sku,'name',p.name,'available',p.active AND COALESCE(o.available,true),'source_price',p.price::text,'source_currency',p.currency,'price',CASE WHEN o.price IS NOT NULL THEN o.price::text WHEN p.currency=$2 THEN p.price::text ELSE NULL END,'currency',$2::text,'inherited',o.price IS NULL) FROM catalog.products p LEFT JOIN cart_checkout.market_overrides o ON o.market_id=$1 AND o.entity_type='product' AND o.entity_id=p.id WHERE position(lower($3) in lower(p.name||' '||p.sku))>0 ORDER BY p.name,p.id LIMIT 25 OFFSET $4").bind(id).bind(&currency).bind(q.q.trim()).bind(q.offset).fetch_all(&mut *tx).await?;
    let total:i64=sqlx::query_scalar("SELECT count(*) FROM catalog.products p WHERE position(lower($1) in lower(p.name||' '||p.sku))>0").bind(q.q.trim()).fetch_one(&mut *tx).await?;
    Ok(Json(
        json!({"items":items,"total":total,"offset":q.offset,"limit":25}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Publish {
    token: String,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Restore {
    expected_revision: i64,
    reason: String,
}
fn reason(value: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > 300 {
        return Err(
            Error::Invalid("Enter a publication reason (up to 300 characters)".into()).into(),
        );
    }
    Ok(())
}
async fn publisher(a: &App, h: &HeaderMap) -> Result<Uuid> {
    let who = a
        .admins
        .authenticate(identity::cookie(h, "admin_session"))
        .await?;
    for permission in ["markets.publish", "catalog.write", "cms.publish"] {
        who.require(permission)?;
    }
    Ok(who.user.id)
}
async fn refresh(tx: &mut Transaction<'_, Postgres>) -> Result<()> {
    // One bounded reindex job; no per-category duplicate full-catalog work.
    infra_events::record(tx, "catalog.market_published", json!({})).await?;
    sqlx::query("UPDATE cart_checkout.carts SET market_id=cart_checkout.current_market_id(),revision=revision+1 WHERE market_id IS DISTINCT FROM cart_checkout.current_market_id()").execute(&mut **tx).await?;
    // Invalidate normal, assistant and delegated proposal snapshots atomically.
    sqlx::query("UPDATE cart_checkout.quotes SET expires_at=LEAST(expires_at,clock_timestamp()) WHERE expires_at>clock_timestamp()").execute(&mut **tx).await?;
    sqlx::query("UPDATE cart_checkout.basket_proposals SET expires_at=LEAST(expires_at,clock_timestamp()) WHERE expires_at>clock_timestamp()").execute(&mut **tx).await?;
    Ok(())
}
async fn publish(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<Publish>,
) -> Result<Json<Value>> {
    let who = publisher(&a, &h).await?;
    reason(&i.reason)?;
    let mut tx = domain_inventory::begin(&a.admins.pool).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(2002)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT singleton FROM cart_checkout.active_market FOR UPDATE")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT id FROM cart_checkout.market_drafts WHERE id=$1 FOR UPDATE")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let readiness = assess(&mut tx, id).await?;
    if readiness.token != i.token {
        return Err(Error::Conflict.into());
    }
    if !readiness.ready {
        return Err(
            Error::Invalid("Resolve the market readiness checks before publishing".into()).into(),
        );
    }
    let release = Uuid::new_v4();
    let entity_id: i64 = sqlx::query_scalar("INSERT INTO cart_checkout.market_releases(id,market_id,name,country,currency,source_locale,draft_revision,created_by) SELECT $1,id,name,country,currency,$3,revision,$4 FROM cart_checkout.market_drafts WHERE id=$2 RETURNING entity_id").bind(release).bind(id).bind(&readiness.source_locale).bind(who).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO cart_checkout.market_release_overrides(release_id,entity_type,entity_id,available,price) SELECT $1,entity_type,entity_id,available,price FROM cart_checkout.market_overrides WHERE market_id=$2").bind(release).bind(id).execute(&mut *tx).await?;
    let revision:i64=sqlx::query_scalar("UPDATE cart_checkout.active_market SET release_id=$1,revision=revision+1 RETURNING revision").bind(release).fetch_one(&mut *tx).await?;
    refresh(&mut tx).await?;
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(who),
        "markets.published",
        id,
        json!({"release_id":release,"revision":revision,"reason":i.reason,"review":readiness}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"release_id":release,"entity_id":entity_id,"revision":revision}),
    ))
}
async fn restore(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<Restore>,
) -> Result<Json<Value>> {
    let who = publisher(&a, &h).await?;
    reason(&i.reason)?;
    let mut tx = domain_inventory::begin(&a.admins.pool).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(2002)")
        .execute(&mut *tx)
        .await?;
    let revision:Option<i64>=sqlx::query_scalar("UPDATE cart_checkout.active_market SET release_id=NULL,revision=revision+1 WHERE revision=$1 RETURNING revision").bind(i.expected_revision).fetch_optional(&mut *tx).await?;
    let revision = revision.ok_or(Error::Conflict)?;
    refresh(&mut tx).await?;
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(who),
        "markets.defaults_restored",
        Uuid::nil(),
        json!({"revision":revision,"reason":i.reason}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"revision":revision})))
}

// Preserve readiness tokens issued before the additive identifier migration.
fn market_review_facts(market: &Market) -> Value {
    let mut value = json!(market);
    value.as_object_mut().unwrap().remove("entity_id");
    value
}

#[cfg(test)]
mod entity_identifier_tests {
    use super::*;
    #[test]
    fn readiness_preserves_existing_material_without_read_only_number() {
        let market = Market {
            id: Uuid::nil(),
            entity_id: 123,
            name: "Egypt".into(),
            country: "EG".into(),
            currency: "EGP".into(),
            locales: vec!["en".into()],
            default_locale: "en".into(),
            revision: 1,
        };
        let expected = json!({"id":market.id,"name":"Egypt","country":"EG","currency":"EGP","locales":["en"],"default_locale":"en","revision":1});
        assert_eq!(market_review_facts(&market), expected);
    }
}
