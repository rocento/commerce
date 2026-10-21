use crate::identity::{self, ApiError, App};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::HeaderMap,
    middleware,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use uuid::Uuid;
type Result<T> = std::result::Result<T, ApiError>;
pub fn router(app: App) -> Router {
    Router::new()
        .route("/v1/customer/checkout/quote", post(quote))
        .route("/v1/customer/checkout/place", post(place))
        .route("/v1/customer/orders", get(list))
        .route("/v1/customer/orders/{id}", get(detail))
        .route(
            "/v1/admin/order-statuses",
            get(status_definitions).post(create_status_definition),
        )
        .route(
            "/v1/admin/order-statuses/{code}",
            axum::routing::put(update_status_definition),
        )
        .route(
            "/v1/admin/orders/{id}/status-label",
            post(assign_status_label).get(status_label_history),
        )
        .route("/v1/admin/orders", get(admin_list))
        .route("/v1/admin/orders/sales", get(admin_sales))
        .route("/v1/admin/orders/{id}", get(admin_detail))
        .route("/v1/admin/orders/{id}/status", post(transition))
        .route("/v1/admin/orders/{id}/refund", post(refund))
        .route("/v1/admin/orders/{id}/dispatch", post(dispatch))
        .route("/v1/admin/shipments/{id}/status", post(shipment_status))
        .route("/v1/admin/settings/delivery-fee", get(fee).put(set_fee))
        .route(
            "/v1/admin/settings/delivery-fee-rules",
            get(fee_rules).put(save_fee_rule),
        )
        .route("/v1/admin/settings/delivery-fee-choices", get(fee_choices))
        .route("/v1/admin/promotions", get(promotions).post(save_promotion))
        .route(
            "/v1/admin/promotions/{id}",
            axum::routing::put(update_promotion).delete(delete_promotion),
        )
        .route("/v1/admin/tax/rules", get(tax_rules).post(save_tax))
        .route("/v1/admin/tax/rules/{id}", axum::routing::put(update_tax))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(middleware::from_fn_with_state(
            app.clone(),
            identity::policy,
        ))
        .with_state(app)
}
fn orders(a: &App) -> domain_orders::Service {
    domain_orders::Service {
        pool: a.customers.pool.clone(),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QuoteInput {
    location_id: Option<Uuid>,
    gift_message: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlaceInput {
    quote_id: Uuid,
    idempotency_key: Uuid,
}
async fn quote(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<QuoteInput>,
) -> Result<Json<domain_cart_checkout::checkout::Quote>> {
    let c = a.customers.require_verified(identity::bearer(&h)?).await?;
    Ok(Json(
        a.cart
            .quote_with_gift(c.id, i.location_id.unwrap_or(Uuid::nil()), i.gift_message)
            .await?,
    ))
}
async fn place(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<PlaceInput>,
) -> Result<Json<domain_orders::Detail>> {
    let c = a.customers.require_verified(identity::bearer(&h)?).await?;
    Ok(Json(
        a.cart.place(c.id, i.quote_id, i.idempotency_key).await?,
    ))
}
#[derive(Deserialize)]
struct Page {
    offset: Option<i64>,
}
async fn list(
    State(a): State<App>,
    h: HeaderMap,
    Query(p): Query<Page>,
) -> Result<Json<Vec<domain_orders::Order>>> {
    let c = a.customers.authenticate(identity::bearer(&h)?).await?;
    Ok(Json(
        orders(&a).list(Some(c.id), p.offset.unwrap_or(0)).await?,
    ))
}
async fn detail(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<domain_orders::Detail>> {
    let c = a.customers.authenticate(identity::bearer(&h)?).await?;
    Ok(Json(orders(&a).detail(id, Some(c.id)).await?))
}
async fn admin(a: &App, h: &HeaderMap) -> Result<domain_admin_iam::Identity> {
    Ok(a.admins
        .authenticate(identity::cookie(h, "admin_session"))
        .await?)
}
async fn admin_list(
    State(a): State<App>,
    h: HeaderMap,
    Query(p): Query<Page>,
) -> Result<Json<Vec<domain_orders::Order>>> {
    admin(&a, &h).await?.require("orders.read")?;
    Ok(Json(orders(&a).list(None, p.offset.unwrap_or(0)).await?))
}
async fn admin_detail(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<domain_orders::Detail>> {
    admin(&a, &h).await?.require("orders.read")?;
    Ok(Json(orders(&a).detail(id, None).await?))
}
async fn admin_sales(
    State(a): State<App>,
    h: HeaderMap,
    Query(p): Query<Page>,
) -> Result<Json<Vec<domain_orders::SalesOrder>>> {
    admin(&a, &h).await?.require("orders.read")?;
    Ok(Json(orders(&a).sales_page(p.offset.unwrap_or(0)).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Transition {
    status: String,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reason {
    reason: String,
}
async fn transition(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<Transition>,
) -> Result<Json<domain_orders::Detail>> {
    Ok(Json(
        orders(&a)
            .transition(id, &admin(&a, &h).await?, &i.status, &i.reason)
            .await?,
    ))
}
async fn refund(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<Reason>,
) -> Result<Json<domain_orders::Detail>> {
    Ok(Json(
        orders(&a)
            .refund(id, &admin(&a, &h).await?, &i.reason)
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DispatchInput {
    shipment_id: Option<Uuid>,
    tracking_reference: String,
    reason: String,
}
async fn dispatch(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<DispatchInput>,
) -> Result<Json<domain_orders::Detail>> {
    Ok(Json(
        orders(&a)
            .dispatch_shipment(
                id,
                i.shipment_id,
                &admin(&a, &h).await?,
                &i.tracking_reference,
                &i.reason,
            )
            .await?,
    ))
}
async fn fee(State(a): State<App>, h: HeaderMap) -> Result<Json<domain_fulfillment::Fee>> {
    admin(&a, &h).await?.require("fulfillment.settings.read")?;
    Ok(Json(
        domain_fulfillment::Service {
            pool: a.customers.pool.clone(),
        }
        .fee()
        .await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FeeInput {
    amount: String,
    reason: String,
}
async fn set_fee(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<FeeInput>,
) -> Result<Json<domain_fulfillment::Fee>> {
    Ok(Json(
        domain_fulfillment::Service {
            pool: a.customers.pool.clone(),
        }
        .set_fee(&i.amount, &i.reason, &admin(&a, &h).await?)
        .await?,
    ))
}
async fn tax_rules(State(a): State<App>, h: HeaderMap) -> Result<Json<Vec<domain_tax::Rule>>> {
    admin(&a, &h).await?.require("tax.read")?;
    Ok(Json(
        domain_tax::Service {
            pool: a.customers.pool.clone(),
        }
        .list()
        .await?,
    ))
}
async fn save_tax(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<domain_tax::RuleInput>,
) -> Result<Json<domain_tax::Rule>> {
    Ok(Json(
        domain_tax::Service {
            pool: a.customers.pool.clone(),
        }
        .save(None, i, &admin(&a, &h).await?)
        .await?,
    ))
}
async fn update_tax(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<domain_tax::RuleInput>,
) -> Result<Json<domain_tax::Rule>> {
    Ok(Json(
        domain_tax::Service {
            pool: a.customers.pool.clone(),
        }
        .save(Some(id), i, &admin(&a, &h).await?)
        .await?,
    ))
}

fn pricing(a: &App) -> domain_pricing_promotions::Service {
    domain_pricing_promotions::Service {
        pool: a.customers.pool.clone(),
    }
}
async fn promotions(
    State(a): State<App>,
    h: HeaderMap,
) -> Result<Json<Vec<domain_pricing_promotions::Rule>>> {
    admin(&a, &h).await?.require("promotions.read")?;
    Ok(Json(pricing(&a).list().await?))
}
async fn save_promotion(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<domain_pricing_promotions::RuleInput>,
) -> Result<Json<domain_pricing_promotions::Rule>> {
    Ok(Json(
        pricing(&a).save(None, i, &admin(&a, &h).await?).await?,
    ))
}
async fn update_promotion(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<domain_pricing_promotions::RuleInput>,
) -> Result<Json<domain_pricing_promotions::Rule>> {
    Ok(Json(
        pricing(&a).save(Some(id), i, &admin(&a, &h).await?).await?,
    ))
}
async fn delete_promotion(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    pricing(&a).delete(id, &admin(&a, &h).await?).await?;
    Ok(Json(serde_json::json!({"status":"ok"})))
}

async fn shipment_status(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<Transition>,
) -> Result<Json<domain_orders::Detail>> {
    Ok(Json(
        orders(&a)
            .shipment_status(id, &admin(&a, &h).await?, &i.status, &i.reason)
            .await?,
    ))
}

async fn status_definitions(
    State(a): State<App>,
    h: HeaderMap,
) -> Result<Json<Vec<domain_orders::statuses::Definition>>> {
    Ok(Json(
        orders(&a).status_definitions(&admin(&a, &h).await?).await?,
    ))
}
async fn create_status_definition(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<domain_orders::statuses::Input>,
) -> Result<Json<domain_orders::statuses::Definition>> {
    Ok(Json(
        orders(&a)
            .save_status_definition(None, i, &admin(&a, &h).await?)
            .await?,
    ))
}
async fn update_status_definition(
    State(a): State<App>,
    h: HeaderMap,
    Path(code): Path<String>,
    Json(i): Json<domain_orders::statuses::Input>,
) -> Result<Json<domain_orders::statuses::Definition>> {
    Ok(Json(
        orders(&a)
            .save_status_definition(Some(&code), i, &admin(&a, &h).await?)
            .await?,
    ))
}
async fn assign_status_label(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<domain_orders::statuses::Assignment>,
) -> Result<Json<serde_json::Value>> {
    orders(&a)
        .assign_order_status(id, i, &admin(&a, &h).await?)
        .await?;
    Ok(Json(serde_json::json!({"status":"ok"})))
}
async fn status_label_history(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<domain_orders::statuses::LabelHistory>>> {
    Ok(Json(
        orders(&a)
            .order_status_history(id, &admin(&a, &h).await?)
            .await?,
    ))
}

async fn fee_rules(
    State(a): State<App>,
    h: HeaderMap,
) -> Result<Json<Vec<domain_fulfillment::fees::Rule>>> {
    admin(&a, &h).await?.require("fulfillment.settings.read")?;
    Ok(Json(
        domain_fulfillment::Service {
            pool: a.customers.pool.clone(),
        }
        .fee_rules()
        .await?,
    ))
}
async fn save_fee_rule(
    State(a): State<App>,
    h: HeaderMap,
    Json(input): Json<domain_fulfillment::fees::Input>,
) -> Result<Json<serde_json::Value>> {
    domain_fulfillment::Service {
        pool: a.customers.pool.clone(),
    }
    .save_fee_rule(input, &admin(&a, &h).await?)
    .await?;
    Ok(Json(serde_json::json!({"ok":true})))
}

async fn fee_choices(State(a): State<App>, h: HeaderMap) -> Result<Json<serde_json::Value>> {
    admin(&a, &h).await?.require("fulfillment.settings.read")?;
    let data:serde_json::Value=sqlx::query_scalar("SELECT jsonb_build_object('areas',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name) FROM inventory.delivery_areas),'[]'::jsonb),'sources',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name) FROM inventory.inventory_sources),'[]'::jsonb))").fetch_one(&a.customers.pool).await?;
    Ok(Json(data))
}
