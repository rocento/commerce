use crate::identity::{self, ApiError, App};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::HeaderMap,
    middleware,
    routing::{get, post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;
type Result<T> = std::result::Result<T, ApiError>;
pub fn router(a: App) -> Router {
    Router::new()
        .route("/v1/content/{key}", get(content))
        .route("/v1/admin/content/media", get(content_media))
        .route("/v1/admin/content", get(documents).post(save_document))
        .route("/v1/admin/content/{id}", get(document))
        .route("/v1/admin/content/{id}/releases", post(publish))
        .route("/v1/products/{id}/reviews", get(public_reviews))
        .route(
            "/v1/customer/products/{id}/review",
            get(own_review).put(submit_review),
        )
        .route("/v1/admin/reviews", get(review_queue))
        .route("/v1/admin/reviews/{id}", put(moderate))
        .route("/v1/customer/wishlist", get(wishlist))
        .route(
            "/v1/customer/wishlist/{id}",
            put(add_wish).delete(remove_wish),
        )
        .route("/v1/admin/operations/products", get(products))
        .route("/v1/admin/operations/product-ids", get(product_ids))
        .route("/v1/admin/operations/bulk", post(bulk))
        .route("/v1/admin/operations/{kind}/export", get(export))
        .route("/v1/admin/filters", get(filters).post(save_filter))
        .route(
            "/v1/admin/filters/{id}",
            axum::routing::delete(delete_filter),
        )
        .layer(DefaultBodyLimit::max(400 * 1024))
        .route(
            "/v1/admin/operations/{kind}/import",
            post(import).layer(DefaultBodyLimit::max(4 * 1024 * 1024)),
        )
        .layer(middleware::from_fn_with_state(a.clone(), identity::policy))
        .with_state(a)
}
fn cms(a: &App) -> domain_cms::Service {
    domain_cms::Service {
        pool: a.customers.pool.clone(),
    }
}
fn reviews(a: &App) -> domain_reviews::Service {
    domain_reviews::Service {
        pool: a.customers.pool.clone(),
    }
}
fn ops(a: &App) -> domain_admin_operations::Service {
    domain_admin_operations::Service {
        pool: a.customers.pool.clone(),
    }
}
async fn admin(a: &App, h: &HeaderMap) -> Result<domain_admin_iam::Identity> {
    Ok(a.admins
        .authenticate(identity::cookie(h, "admin_session"))
        .await?)
}
async fn customer(a: &App, h: &HeaderMap) -> Result<Uuid> {
    Ok(a.customers.authenticate(identity::bearer(h)?).await?.id)
}
#[derive(Deserialize, Default)]
struct ContentQuery {
    locale: Option<String>,
}
async fn content(
    State(a): State<App>,
    Path(key): Path<String>,
    Query(query): Query<ContentQuery>,
) -> Result<Json<Option<domain_cms::Published>>> {
    Ok(Json(
        cms(&a)
            .published_localized(&key, query.locale.as_deref())
            .await?,
    ))
}
async fn documents(State(a): State<App>, h: HeaderMap) -> Result<Json<Vec<domain_cms::Document>>> {
    admin(&a, &h).await?.require("cms.read")?;
    Ok(Json(cms(&a).list().await?))
}
async fn document(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<domain_cms::Detail>> {
    admin(&a, &h).await?.require("cms.read")?;
    Ok(Json(cms(&a).detail(id).await?))
}
async fn save_document(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<domain_cms::Input>,
) -> Result<Json<domain_cms::Revision>> {
    Ok(Json(cms(&a).save(i, &admin(&a, &h).await?).await?))
}
async fn publish(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<domain_cms::Publish>,
) -> Result<Json<domain_cms::Release>> {
    Ok(Json(cms(&a).publish(id, i, &admin(&a, &h).await?).await?))
}
#[derive(Deserialize, Default)]
struct Page {
    offset: Option<i64>,
    status: Option<String>,
}
async fn public_reviews(
    State(a): State<App>,
    Path(id): Path<Uuid>,
    Query(p): Query<Page>,
) -> Result<Json<Vec<domain_reviews::PublicReview>>> {
    Ok(Json(reviews(&a).public(id, p.offset.unwrap_or(0)).await?))
}
async fn own_review(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Option<domain_reviews::Review>>> {
    Ok(Json(reviews(&a).own(customer(&a, &h).await?, id).await?))
}
async fn submit_review(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<domain_reviews::Input>,
) -> Result<Json<domain_reviews::Review>> {
    let c = a.customers.require_verified(identity::bearer(&h)?).await?;
    infra_auth::rate_limit(&a.customers.pool, &format!("review:{}", c.id), 30).await?;
    Ok(Json(reviews(&a).submit(c.id, id, i).await?))
}
async fn review_queue(
    State(a): State<App>,
    h: HeaderMap,
    Query(p): Query<Page>,
) -> Result<Json<Vec<domain_reviews::Review>>> {
    Ok(Json(
        reviews(&a)
            .queue(
                p.status.as_deref().unwrap_or("pending"),
                p.offset.unwrap_or(0),
                &admin(&a, &h).await?,
            )
            .await?,
    ))
}
async fn moderate(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<domain_reviews::Moderation>,
) -> Result<Json<domain_reviews::Review>> {
    Ok(Json(
        reviews(&a).moderate(id, i, &admin(&a, &h).await?).await?,
    ))
}
async fn wishlist(State(a): State<App>, h: HeaderMap) -> Result<Json<Vec<Uuid>>> {
    Ok(Json(
        reviews(&a).wishlist_ids(customer(&a, &h).await?).await?,
    ))
}
async fn add_wish(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    reviews(&a).wish(customer(&a, &h).await?, id, true).await?;
    Ok(Json(json!({"status":"ok"})))
}
async fn remove_wish(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    reviews(&a).wish(customer(&a, &h).await?, id, false).await?;
    Ok(Json(json!({"status":"ok"})))
}
async fn products(
    State(a): State<App>,
    h: HeaderMap,
    Query(f): Query<domain_admin_operations::Filter>,
) -> Result<Json<domain_admin_operations::Page>> {
    admin(&a, &h).await?.require("catalog.read")?;
    Ok(Json(ops(&a).products(f).await?))
}
async fn product_ids(
    State(a): State<App>,
    h: HeaderMap,
    Query(f): Query<domain_admin_operations::Filter>,
) -> Result<Json<Vec<Uuid>>> {
    admin(&a, &h).await?.require("catalog.read")?;
    Ok(Json(ops(&a).ids(f).await?))
}
async fn bulk(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<domain_admin_operations::Bulk>,
) -> Result<Json<domain_admin_operations::Batch>> {
    Ok(Json(ops(&a).bulk(i, &admin(&a, &h).await?).await?))
}
fn kind(k: &str) -> Result<()> {
    if !["catalog", "inventory"].contains(&k) {
        return Err(infra_auth::Error::NotFound.into());
    }
    Ok(())
}
async fn export(
    State(a): State<App>,
    h: HeaderMap,
    Path(k): Path<String>,
    Query(f): Query<domain_admin_operations::Filter>,
) -> Result<Json<serde_json::Value>> {
    kind(&k)?;
    Ok(Json(
        json!({"csv":ops(&a).export(&k,f,&admin(&a,&h).await?).await?}),
    ))
}
async fn import(
    State(a): State<App>,
    h: HeaderMap,
    Path(k): Path<String>,
    Json(i): Json<domain_admin_operations::Import>,
) -> Result<Json<domain_admin_operations::Batch>> {
    kind(&k)?;
    Ok(Json(ops(&a).import(&k, i, &admin(&a, &h).await?).await?))
}
async fn filters(
    State(a): State<App>,
    h: HeaderMap,
) -> Result<Json<Vec<domain_admin_operations::SavedFilter>>> {
    let who = admin(&a, &h).await?;
    who.require("catalog.read")?;
    Ok(Json(ops(&a).filters(who.user.id).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    name: String,
    filters: domain_admin_operations::Filter,
}
async fn save_filter(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<Saved>,
) -> Result<Json<domain_admin_operations::SavedFilter>> {
    let who = admin(&a, &h).await?;
    who.require("catalog.read")?;
    Ok(Json(
        ops(&a).save_filter(who.user.id, &i.name, i.filters).await?,
    ))
}
async fn delete_filter(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let who = admin(&a, &h).await?;
    who.require("catalog.read")?;
    ops(&a).delete_filter(who.user.id, id).await?;
    Ok(Json(json!({"status":"ok"})))
}

async fn content_media(
    State(a): State<App>,
    h: HeaderMap,
) -> Result<Json<Vec<domain_catalog::Media>>> {
    admin(&a, &h).await?.require("cms.read")?;
    Ok(Json(
        domain_catalog::Service {
            pool: a.customers.pool.clone(),
        }
        .media()
        .await?,
    ))
}
