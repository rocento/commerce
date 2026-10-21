use crate::identity::{self, ApiError, App};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    middleware,
    routing::get,
    Json, Router,
};
use domain_customers::segments::{Field, Input, Segment, Service};
use serde::Deserialize;
use uuid::Uuid;
type Result<T> = std::result::Result<T, ApiError>;
fn service(a: &App) -> Service {
    Service {
        pool: a.customers.pool.clone(),
    }
}
async fn authorize(a: &App, h: &HeaderMap, write: bool) -> Result<Uuid> {
    let who = a
        .admins
        .authenticate(identity::cookie(h, "admin_session"))
        .await?;
    who.require("customers.read")?;
    if write {
        who.require("customers.segments.write")?;
    }
    Ok(who.user.id)
}
pub fn router(app: App) -> Router {
    Router::new()
        .route("/v1/admin/customer-segments", get(list).post(create))
        .route("/v1/admin/customer-segments/fields", get(fields))
        .route("/v1/admin/customer-segments/count", get(count))
        .route(
            "/v1/admin/customer-segments/{id}",
            get(detail).put(save).delete(delete),
        )
        .layer(DefaultBodyLimit::max(32 * 1024))
        .layer(middleware::from_fn_with_state(
            app.clone(),
            identity::policy,
        ))
        .with_state(app)
}
#[derive(Deserialize, Default)]
struct Page {
    #[serde(default)]
    offset: i64,
}
#[derive(Deserialize)]
struct Revision {
    revision: i32,
}
async fn fields(State(a): State<App>, h: HeaderMap) -> Result<Json<Vec<Field>>> {
    authorize(&a, &h, false).await?;
    Ok(Json(service(&a).fields().await?))
}
async fn list(
    State(a): State<App>,
    h: HeaderMap,
    Query(p): Query<Page>,
) -> Result<Json<Vec<Segment>>> {
    authorize(&a, &h, false).await?;
    Ok(Json(service(&a).list(p.offset).await?))
}
async fn detail(State(a): State<App>, h: HeaderMap, Path(id): Path<Uuid>) -> Result<Json<Segment>> {
    authorize(&a, &h, false).await?;
    Ok(Json(service(&a).get(id).await?))
}
async fn create(State(a): State<App>, h: HeaderMap, Json(i): Json<Input>) -> Result<Json<Segment>> {
    let actor = authorize(&a, &h, true).await?;
    Ok(Json(service(&a).save(None, i, actor).await?))
}
async fn save(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<Input>,
) -> Result<Json<Segment>> {
    let actor = authorize(&a, &h, true).await?;
    Ok(Json(service(&a).save(Some(id), i, actor).await?))
}
async fn delete(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Query(r): Query<Revision>,
) -> Result<StatusCode> {
    let actor = authorize(&a, &h, true).await?;
    service(&a).delete(id, r.revision, actor).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn count(State(a): State<App>, h: HeaderMap) -> Result<Json<i64>> {
    authorize(&a, &h, false).await?;
    let total = sqlx::query_scalar("SELECT count(*) FROM customers.segments")
        .fetch_one(&a.customers.pool)
        .await
        .map_err(infra_auth::Error::from)?;
    Ok(Json(total))
}
