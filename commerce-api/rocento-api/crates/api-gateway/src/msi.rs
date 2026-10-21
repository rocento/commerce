use crate::identity::{self, ApiError, App};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, put},
    Json, Router,
};
use domain_inventory::msi::{SourceInput, SourceItemInput, StockInput};
use serde_json::{json, Value};
use uuid::Uuid;
type Result<T> = std::result::Result<T, ApiError>;
pub fn routes() -> Router<App> {
    Router::new()
        .route(
            "/v1/admin/inventory/sources",
            get(sources).post(create_source),
        )
        .route(
            "/v1/admin/inventory/sources/{id}",
            put(update_source).delete(delete_source),
        )
        .route("/v1/admin/inventory/stocks", get(stocks).post(create_stock))
        .route(
            "/v1/admin/inventory/stocks/{id}",
            put(update_stock).delete(delete_stock),
        )
        .route("/v1/admin/inventory/{id}/sources", get(items).put(adjust))
}
async fn who(a: &App, h: &HeaderMap, permission: &str) -> Result<Uuid> {
    let who = a
        .admins
        .authenticate(identity::cookie(h, "admin_session"))
        .await?;
    who.require(permission)?;
    Ok(who.user.id)
}
async fn sources(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    who(&a, &h, "inventory.read").await?;
    Ok(Json(json!(a.cart.inventory.sources().await?)))
}
async fn create_source(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<SourceInput>,
) -> Result<Json<Value>> {
    Ok(Json(json!(
        a.cart
            .inventory
            .save_source(None, i, who(&a, &h, "inventory.write").await?)
            .await?
    )))
}
async fn update_source(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<SourceInput>,
) -> Result<Json<Value>> {
    Ok(Json(json!(
        a.cart
            .inventory
            .save_source(Some(id), i, who(&a, &h, "inventory.write").await?)
            .await?
    )))
}
async fn delete_source(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.cart
        .inventory
        .delete_source(id, who(&a, &h, "inventory.write").await?)
        .await?;
    Ok(Json(json!({"status":"ok"})))
}
async fn stocks(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    who(&a, &h, "inventory.read").await?;
    Ok(Json(json!(a.cart.inventory.stocks().await?)))
}
async fn create_stock(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<StockInput>,
) -> Result<Json<Value>> {
    let id = a
        .cart
        .inventory
        .save_stock(None, i, who(&a, &h, "inventory.write").await?)
        .await?;
    Ok(Json(json!({"id":id})))
}
async fn update_stock(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<StockInput>,
) -> Result<Json<Value>> {
    a.cart
        .inventory
        .save_stock(Some(id), i, who(&a, &h, "inventory.write").await?)
        .await?;
    Ok(Json(json!({"id":id})))
}
async fn delete_stock(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.cart
        .inventory
        .delete_stock(id, who(&a, &h, "inventory.write").await?)
        .await?;
    Ok(Json(json!({"status":"ok"})))
}
async fn items(State(a): State<App>, h: HeaderMap, Path(id): Path<Uuid>) -> Result<Json<Value>> {
    who(&a, &h, "inventory.read").await?;
    Ok(Json(json!(a.cart.inventory.source_items(id).await?)))
}
async fn adjust(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<SourceItemInput>,
) -> Result<Json<Value>> {
    let actor = who(&a, &h, "inventory.write").await?;
    domain_catalog::Service {
        pool: a.customers.pool.clone(),
    }
    .product(id)
    .await?;
    a.cart.inventory.adjust_source(id, i, actor).await?;
    Ok(Json(json!({"status":"ok"})))
}
