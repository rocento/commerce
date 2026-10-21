//! Browser-controlled approvals are deliberately separate from assistant capabilities.
use crate::identity::{self, ApiError, App};
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use domain_cart_checkout::shopping::{Draft, Proposal};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

pub fn routes() -> Router<App> {
    Router::new()
        .route("/v1/cart/saved-goals", get(saved_goals))
        .route(
            "/v1/cart/saved-goals/{task}",
            axum::routing::put(manage_saved_goal).delete(forget_saved_goal),
        )
        .route("/v1/cart/shopping/{task}", get(context).delete(cancel))
        .route("/v1/cart/shopping/{task}/goal", get(goal).post(save_goal))
        .route("/v1/cart/shopping/{task}/resume", post(resume_goal))
        .route("/v1/cart/proposals", post(propose))
        .route("/v1/cart/proposals/{id}", get(read))
        .route("/v1/cart/proposals/{id}/apply", post(apply))
}
async fn owner(a: &App, h: &HeaderMap) -> Result<(Uuid, Option<Uuid>), ApiError> {
    let customer = crate::cart::customer(a, h).await?;
    let cart = a
        .cart
        .shopping_cart(customer, identity::cookie(h, "guest_cart"))
        .await?;
    Ok((cart, customer))
}
async fn context(
    State(a): State<App>,
    h: HeaderMap,
    Path(task): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let (cart, customer) = owner(&a, &h).await?;
    Ok(Json(a.cart.shopping_context(cart, customer, task).await?))
}
async fn cancel(
    State(a): State<App>,
    h: HeaderMap,
    Path(task): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let (cart, _) = owner(&a, &h).await?;
    a.cart.cancel_shopping(cart, task).await?;
    Ok(Json(json!({"status":"cancelled"})))
}
async fn propose(
    State(a): State<App>,
    h: HeaderMap,
    Json(d): Json<Draft>,
) -> Result<Json<Proposal>, ApiError> {
    let (cart, customer) = owner(&a, &h).await?;
    infra_auth::rate_limit(&a.customers.pool, &format!("basket:{cart}"), 30).await?;
    Ok(Json(a.cart.propose(cart, customer, d).await?))
}
async fn read(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Proposal>, ApiError> {
    let (cart, _) = owner(&a, &h).await?;
    Ok(Json(a.cart.shopping_proposal(cart, id).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Apply {
    idempotency_key: Uuid,
}
async fn apply(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<Apply>,
) -> Result<Json<domain_cart_checkout::Cart>, ApiError> {
    let (cart, customer) = owner(&a, &h).await?;
    Ok(Json(
        a.cart
            .apply_proposal(
                cart,
                customer,
                identity::cookie(&h, "guest_cart"),
                id,
                i.idempotency_key,
            )
            .await?,
    ))
}
#[derive(Deserialize)]
pub struct Task {
    task_id: Uuid,
}
pub async fn tool_context(
    State(a): State<crate::assistant::App>,
    h: HeaderMap,
    Path(cart): Path<Uuid>,
    Query(t): Query<Task>,
) -> Result<Json<Value>, ApiError> {
    let _permit = crate::assistant::TOOL_SLOTS
        .try_acquire()
        .map_err(|_| infra_auth::Error::RateLimited)?;
    let c = a.decode(identity::bearer(&h)?, &format!("basket:{cart}"))?;
    if c.sub.is_some() {
        a.customer(&c).await?;
    }
    Ok(Json(
        a.identity
            .cart
            .shopping_context(cart, c.sub, t.task_id)
            .await?,
    ))
}
pub async fn tool_propose(
    State(a): State<crate::assistant::App>,
    h: HeaderMap,
    Path(cart): Path<Uuid>,
    Json(d): Json<Draft>,
) -> Result<Json<Proposal>, ApiError> {
    let _permit = crate::assistant::TOOL_SLOTS
        .try_acquire()
        .map_err(|_| infra_auth::Error::RateLimited)?;
    let c = a.decode(identity::bearer(&h)?, &format!("basket:{cart}"))?;
    if c.sub.is_some() {
        a.customer(&c).await?;
    }
    // This capability cannot apply a proposal, place an order or select a payment provider.
    Ok(Json(a.identity.cart.propose(cart, c.sub, d).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GoalRevision {
    revision: i64,
}
async fn goal(
    State(a): State<App>,
    h: HeaderMap,
    Path(task): Path<Uuid>,
) -> Result<Json<domain_cart_checkout::execution::Checkpoint>, ApiError> {
    let (cart, customer) = owner(&a, &h).await?;
    Ok(Json(a.cart.execution_goal(cart, customer, task).await?))
}
async fn save_goal(
    State(a): State<App>,
    h: HeaderMap,
    Path(task): Path<Uuid>,
    Json(body): Json<GoalRevision>,
) -> Result<Json<domain_cart_checkout::execution::Checkpoint>, ApiError> {
    let (cart, customer) = owner(&a, &h).await?;
    Ok(Json(
        a.cart
            .save_execution_goal(cart, customer, task, body.revision)
            .await?,
    ))
}
async fn resume_goal(
    State(a): State<App>,
    h: HeaderMap,
    Path(task): Path<Uuid>,
    Json(body): Json<GoalRevision>,
) -> Result<Json<Proposal>, ApiError> {
    let (cart, customer) = owner(&a, &h).await?;
    infra_auth::rate_limit(&a.customers.pool, &format!("basket:{cart}"), 30).await?;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        a.cart
            .resume_execution_goal(cart, customer, task, body.revision),
    )
    .await
    .map_err(|_| infra_auth::Error::Internal)?;
    Ok(Json(result?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GoalMetadata {
    expected_version: i64,
    name: String,
    archived: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GoalVersion {
    version: i64,
}
async fn saved_goals(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>, ApiError> {
    if !domain_customers::memory::configuration(&a.customers.pool)
        .await?
        .enabled
    {
        return Err(infra_auth::Error::NotFound.into());
    }
    let (cart, customer) = owner(&a, &h).await?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('task_id',g.task_id,'name',CASE WHEN g.display_name='' THEN 'Saved shopping goal' ELSE g.display_name END,'archived',g.archived,'version',g.metadata_revision,'revision',g.revision,'mode',t.draft->>'mode','expires_at',g.checkpoint->>'goal_expires_at','state',g.checkpoint->'receipt'->>'state') FROM cart_checkout.goal_checkpoints g JOIN cart_checkout.shopping_tasks t ON t.id=g.task_id WHERE g.cart_id=$1 AND (g.checkpoint->>'saved_by_customer')::boolean AND g.checkpoint->'envelope'->>'customer_id' IS NOT DISTINCT FROM $2 ORDER BY g.updated_at DESC LIMIT 50").bind(cart).bind(customer.map(|id|id.to_string())).fetch_all(&a.customers.pool).await?;
    Ok(Json(json!({"goals":rows})))
}
async fn manage_saved_goal(
    State(a): State<App>,
    h: HeaderMap,
    Path(task): Path<Uuid>,
    Json(i): Json<GoalMetadata>,
) -> Result<Json<Value>, ApiError> {
    if !domain_customers::memory::configuration(&a.customers.pool)
        .await?
        .enabled
    {
        return Err(infra_auth::Error::NotFound.into());
    }
    let (cart, customer) = owner(&a, &h).await?;
    if i.name.trim().is_empty()
        || i.name.chars().count() > 100
        || i.name.chars().any(|c| c.is_control())
    {
        return Err(
            infra_auth::Error::Invalid("Choose a goal name of 1–100 characters".into()).into(),
        );
    }
    let count=sqlx::query("UPDATE cart_checkout.goal_checkpoints SET display_name=$4,archived=$5,metadata_revision=metadata_revision+1 WHERE task_id=$1 AND cart_id=$2 AND metadata_revision=$3 AND (checkpoint->>'saved_by_customer')::boolean AND checkpoint->'envelope'->>'customer_id' IS NOT DISTINCT FROM $6").bind(task).bind(cart).bind(i.expected_version).bind(i.name.trim()).bind(i.archived).bind(customer.map(|id|id.to_string())).execute(&a.customers.pool).await?.rows_affected();
    if count != 1 {
        return Err(infra_auth::Error::Conflict.into());
    }
    Ok(Json(json!({"status":"ok"})))
}
async fn forget_saved_goal(
    State(a): State<App>,
    h: HeaderMap,
    Path(task): Path<Uuid>,
    Query(q): Query<GoalVersion>,
) -> Result<Json<Value>, ApiError> {
    if !domain_customers::memory::configuration(&a.customers.pool)
        .await?
        .enabled
    {
        return Err(infra_auth::Error::NotFound.into());
    }
    let (cart, customer) = owner(&a, &h).await?;
    let count=sqlx::query("DELETE FROM cart_checkout.goal_checkpoints WHERE task_id=$1 AND cart_id=$2 AND metadata_revision=$3 AND (checkpoint->>'saved_by_customer')::boolean AND checkpoint->'envelope'->>'customer_id' IS NOT DISTINCT FROM $4").bind(task).bind(cart).bind(q.version).bind(customer.map(|id|id.to_string())).execute(&a.customers.pool).await?.rows_affected();
    if count != 1 {
        return Err(infra_auth::Error::Conflict.into());
    }
    Ok(Json(json!({"status":"ok"})))
}
