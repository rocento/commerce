use crate::identity::{self, ApiError, App};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, put},
    Json, Router,
};
use domain_inventory::areas::{AreaInput, Pin};
use serde_json::{json, Value};
use uuid::Uuid;
type Result<T> = std::result::Result<T, ApiError>;
pub fn pin(h: &HeaderMap) -> Result<Option<Pin>> {
    let parse = |key: &str| -> Result<Option<f64>> {
        h.get(key)
            .map(|v| {
                v.to_str()
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .ok_or_else(|| infra_auth::Error::Invalid("Invalid delivery pin".into()).into())
            })
            .transpose()
    };
    match (
        parse("x-delivery-latitude")?,
        parse("x-delivery-longitude")?,
    ) {
        (None, None) => Ok(None),
        (Some(latitude), Some(longitude)) => Ok(Some(
            Pin {
                latitude,
                longitude,
            }
            .validate()?,
        )),
        _ => {
            Err(infra_auth::Error::Invalid("Both delivery coordinates are required".into()).into())
        }
    }
}
pub fn routes() -> Router<App> {
    Router::new()
        .route("/v1/delivery-area", get(resolve))
        .route("/v1/delivery-areas", get(choices))
        .route("/v1/admin/inventory/delivery-areas", get(list).post(create))
        .route("/v1/admin/inventory/delivery-areas/{id}", put(update))
}
async fn who(a: &App, h: &HeaderMap, p: &str) -> Result<Uuid> {
    let w = a
        .admins
        .authenticate(identity::cookie(h, "admin_session"))
        .await?;
    w.require(p)?;
    Ok(w.user.id)
}
async fn resolve(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let c = crate::capacity::resolved_capabilities(&a, &h).await?;
    if !c.geofencing() || !c.delivery_enabled {
        return Ok(Json(
            json!({"configured":false,"deliverable":c.delivery_enabled,"area_id":null}),
        ));
    }
    Ok(Json(json!(a.cart.inventory.delivery(pin(&h)?).await?)))
}
async fn choices(State(a): State<App>) -> Result<Json<Value>> {
    Ok(Json(json!(a.cart.inventory.delivery_choices().await?)))
}
async fn list(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    who(&a, &h, "inventory.read").await?;
    Ok(Json(json!(a.cart.inventory.areas().await?)))
}
async fn create(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<AreaInput>,
) -> Result<Json<Value>> {
    Ok(Json(
        json!({"id":a.cart.inventory.save_area(None,i,who(&a,&h,"inventory.write").await?).await?}),
    ))
}
async fn update(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<AreaInput>,
) -> Result<Json<Value>> {
    Ok(Json(
        json!({"id":a.cart.inventory.save_area(Some(id),i,who(&a,&h,"inventory.write").await?).await?}),
    ))
}
