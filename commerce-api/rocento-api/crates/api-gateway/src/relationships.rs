use crate::identity::{self, ApiError, App};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    middleware,
    routing::get,
    Json, Router,
};
use domain_catalog::{
    relationships::{Input, Rule},
    Service,
};
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
    who.require("catalog.read")?;
    if write {
        who.require("catalog.write")?;
    }
    Ok(who.user.id)
}
pub fn router(a: App) -> Router {
    Router::new()
        .route(
            "/v1/admin/catalog/relationship-rules",
            get(list).post(create),
        )
        .route(
            "/v1/admin/catalog/relationship-rules/{id}",
            axum::routing::put(save).delete(delete),
        )
        .route(
            "/v1/admin/catalog/relationship-rules/attributes",
            get(attributes),
        )
        .layer(DefaultBodyLimit::max(32 * 1024))
        .layer(middleware::from_fn_with_state(a.clone(), identity::policy))
        .with_state(a)
}
async fn list(State(a): State<App>, h: HeaderMap) -> Result<Json<Vec<Rule>>> {
    authorize(&a, &h, false).await?;
    Ok(Json(service(&a).relationship_rules().await?))
}
async fn create(State(a): State<App>, h: HeaderMap, Json(i): Json<Input>) -> Result<Json<Rule>> {
    let actor = authorize(&a, &h, true).await?;
    Ok(Json(
        service(&a).save_relationship_rule(None, i, actor).await?,
    ))
}
async fn save(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<Input>,
) -> Result<Json<Rule>> {
    let actor = authorize(&a, &h, true).await?;
    Ok(Json(
        service(&a)
            .save_relationship_rule(Some(id), i, actor)
            .await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Revision {
    revision: i32,
}
async fn delete(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Query(r): Query<Revision>,
) -> Result<StatusCode> {
    let actor = authorize(&a, &h, true).await?;
    service(&a)
        .delete_relationship_rule(id, r.revision, actor)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Serialize, sqlx::FromRow)]
struct AttributeField {
    attribute_code: String,
    label: String,
}
async fn attributes(State(a): State<App>, h: HeaderMap) -> Result<Json<Vec<AttributeField>>> {
    authorize(&a, &h, false).await?;
    Ok(Json(sqlx::query_as("SELECT attribute_code,label FROM attributes.definitions WHERE entity_type='product' AND used_for_promo_rules AND COALESCE(metadata->>'status','active')='active' AND input_type IN ('text','textarea','single_select','select','boolean','integer','decimal','price','date','datetime','long_text') ORDER BY label,attribute_code").fetch_all(&a.customers.pool).await.map_err(infra_auth::Error::from)?))
}
