//! Durable job queue; artifacts are served one bounded database chunk at a time.
use crate::{
    grids,
    identity::{self, ApiError, App},
};
use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    middleware,
    response::Response,
    routing::get,
    Json, Router,
};
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub grid: String,
    pub request: grids::Request,
    pub columns: Vec<String>,
    pub format: String,
}
pub fn columns(grid: &str) -> Result<Vec<String>> {
    let mut cols: Vec<String> = grids::definition(grid)?
        .columns
        .split(',')
        .map(str::to_owned)
        .collect();
    if grid == "inventory" {
        cols = ["sku", "name", "on_hand", "reserved", "available", "reason"]
            .map(str::to_owned)
            .to_vec();
    }
    if grid == "stocks" {
        cols.push("sources".into());
    }
    if grid == "delivery-areas" {
        cols.push("stocks".into());
    }
    if grid == "source-items" {
        cols = [
            "source_id",
            "product_id",
            "name",
            "quantity",
            "status",
            "notify_stock_qty",
            "reserved",
        ]
        .map(str::to_owned)
        .to_vec();
    }
    Ok(cols)
}
pub fn permission(grid: &str) -> Result<&'static str> {
    Ok(match grid {
        "catalog" => "catalog.export",
        "inventory" => "inventory.export",
        _ => grids::definition(grid)?.permission,
    })
}
pub fn validate(i: &Input) -> Result<()> {
    grids::validate(&i.grid, &i.request)?;
    let allowed = columns(&i.grid)?;
    if !["csv", "xlsx"].contains(&i.format.as_str())
        || i.columns.is_empty()
        || i.columns.len() > allowed.len()
        || i.columns.iter().any(|c| !allowed.contains(c))
        || i.columns
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != i.columns.len()
    {
        return Err(Error::Invalid(
            "Select unique supported columns and CSV or XLSX format".into(),
        ));
    }
    Ok(())
}
pub fn router(a: App) -> Router {
    Router::new()
        .route("/v1/admin/exports", get(list).post(create))
        .route("/v1/admin/exports/columns/{grid}", get(metadata))
        .route("/v1/admin/exports/{id}", get(status).delete(cancel))
        .route("/v1/admin/exports/{id}/download", get(download))
        .layer(middleware::from_fn_with_state(a.clone(), identity::policy))
        .with_state(a)
}
async fn who(a: &App, h: &HeaderMap) -> Result<domain_admin_iam::Identity> {
    a.admins
        .authenticate(identity::cookie(h, "admin_session"))
        .await
}
async fn metadata(
    State(a): State<App>,
    h: HeaderMap,
    Path(grid): Path<String>,
) -> std::result::Result<Json<Value>, ApiError> {
    who(&a, &h).await?.require(permission(&grid)?)?;
    Ok(Json(json!({"columns":columns(&grid)?})))
}
async fn create(
    State(a): State<App>,
    h: HeaderMap,
    Json(mut i): Json<Input>,
) -> std::result::Result<(StatusCode, Json<Value>), ApiError> {
    let who = who(&a, &h).await?;
    who.require(grids::definition(&i.grid)?.permission)?;
    who.require(permission(&i.grid)?)?;
    i.request.cursor = None;
    i.request.limit = Some(200);
    validate(&i)?;
    let tenant = grids::tenant();
    if i.grid == "support" && tenant.is_none() {
        return Err(Error::Forbidden.into());
    }
    let mut tx = a.customers.pool.begin().await.map_err(Error::from)?;
    // Serialize admission for this owner, including requests to different gateway replicas.
    sqlx::query("SELECT id FROM admin_iam.admin_users WHERE id=$1 FOR UPDATE")
        .bind(who.user.id)
        .execute(&mut *tx)
        .await
        .map_err(Error::from)?;
    let pending:i64=sqlx::query_scalar("SELECT count(*) FROM admin_iam.export_jobs WHERE owner_id=$1 AND status IN ('queued','running') AND expires_at>now()").bind(who.user.id).fetch_one(&mut *tx).await.map_err(Error::from)?;
    if pending >= 3 {
        return Err(Error::RateLimited.into());
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.export_jobs(id,owner_id,grid,request,columns,format,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(id).bind(who.user.id).bind(i.grid).bind(serde_json::to_value(i.request).map_err(|_|Error::Internal)?).bind(json!(i.columns)).bind(i.format).bind(tenant).execute(&mut *tx).await.map_err(Error::from)?;
    tx.commit().await.map_err(Error::from)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"id":id,"status":"queued"})),
    ))
}
async fn job(a: &App, h: &HeaderMap, id: Uuid) -> Result<Value> {
    let who = who(a, h).await?;
    let v:Value=sqlx::query_scalar("SELECT to_jsonb(j)-'request'-'tenant_id' FROM admin_iam.export_jobs j WHERE id=$1 AND owner_id=$2 AND expires_at>now()").bind(id).bind(who.user.id).fetch_optional(&a.customers.pool).await?.ok_or(Error::NotFound)?;
    who.require(grids::definition(v["grid"].as_str().ok_or(Error::Internal)?)?.permission)?;
    who.require(permission(v["grid"].as_str().ok_or(Error::Internal)?)?)?;
    Ok(v)
}
async fn list(
    State(a): State<App>,
    h: HeaderMap,
) -> std::result::Result<Json<Vec<Value>>, ApiError> {
    let who = who(&a, &h).await?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(j)-'request'-'tenant_id' FROM admin_iam.export_jobs j WHERE owner_id=$1 AND expires_at>now() ORDER BY created_at DESC LIMIT 50").bind(who.user.id).fetch_all(&a.customers.pool).await.map_err(Error::from)?;
    Ok(Json(rows))
}
async fn status(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> std::result::Result<Json<Value>, ApiError> {
    Ok(Json(job(&a, &h, id).await?))
}
async fn cancel(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> std::result::Result<Json<Value>, ApiError> {
    job(&a, &h, id).await?;
    sqlx::query("UPDATE admin_iam.export_jobs SET status='cancelled' WHERE id=$1 AND status IN ('queued','running')").bind(id).execute(&a.customers.pool).await.map_err(Error::from)?;
    Ok(Json(json!({"id":id})))
}
async fn download(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> std::result::Result<Response, ApiError> {
    let j = job(&a, &h, id).await?;
    if j["status"] != "completed" {
        return Err(Error::Conflict.into());
    }
    let format = j["format"].as_str().ok_or(Error::Internal)?;
    let content_type = if format == "csv" {
        "text/csv; charset=utf-8"
    } else {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    };
    let leased=sqlx::query("UPDATE admin_iam.export_jobs SET download_until=now()+interval '1 hour' WHERE id=$1 AND status='completed' AND expires_at>now()").bind(id).execute(&a.customers.pool).await.map_err(Error::from)?;
    if leased.rows_affected() != 1 {
        return Err(Error::NotFound.into());
    }
    let bytes = j["bytes_written"].as_u64().ok_or(Error::Internal)?;
    let stream = futures_util::stream::try_unfold(
        (a.customers.pool.clone(), 0i32, bytes),
        move |(pool, n, remaining)| async move {
            if remaining == 0 {
                return Ok(None);
            }
            if n % 64 == 0 {
                sqlx::query("UPDATE admin_iam.export_jobs SET download_until=now()+interval '1 hour' WHERE id=$1").bind(id).execute(&pool).await?;
            }
            let data: Vec<u8> = sqlx::query_scalar(
                "SELECT data FROM admin_iam.export_chunks WHERE job_id=$1 AND sequence=$2",
            )
            .bind(id)
            .bind(n)
            .fetch_one(&pool)
            .await?;
            let remaining = remaining
                .checked_sub(data.len() as u64)
                .ok_or(sqlx::Error::RowNotFound)?;
            Ok::<_, sqlx::Error>(Some((Bytes::from(data), (pool, n + 1, remaining))))
        },
    );
    Ok(Response::builder()
        .header("content-type", content_type)
        .header(
            "content-disposition",
            format!("attachment; filename=export-{id}.{format}"),
        )
        .header("content-length", j["bytes_written"].to_string())
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .body(Body::from_stream(stream))
        .map_err(|_| Error::Internal)?)
}
#[derive(sqlx::FromRow, Serialize)]
pub struct Job {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub grid: String,
    pub request: Value,
    pub columns: Value,
    pub format: String,
    pub tenant_id: Option<Uuid>,
}
pub async fn claim(pool: &PgPool) -> Result<Option<Job>> {
    // Remove abandoned chunks in bounded batches, including cancelled final uploads.
    sqlx::query("DELETE FROM admin_iam.export_chunks WHERE (job_id,sequence) IN (SELECT c.job_id,c.sequence FROM admin_iam.export_chunks c JOIN admin_iam.export_jobs j ON j.id=c.job_id WHERE j.status IN ('failed','cancelled') LIMIT 100)").execute(pool).await?;
    // Dead workers become explicit failures; partial files are never downloadable.
    sqlx::query("UPDATE admin_iam.export_jobs SET status='failed',error='Worker stopped; please retry' WHERE status='running' AND heartbeat_at<now()-interval '10 minutes'").execute(pool).await?;
    sqlx::query("DELETE FROM admin_iam.export_jobs WHERE expires_at<now() AND (download_until IS NULL OR download_until<now())")
        .execute(pool)
        .await?;
    Ok(sqlx::query_as("UPDATE admin_iam.export_jobs SET status='running',heartbeat_at=now() WHERE id=(SELECT id FROM admin_iam.export_jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,owner_id,grid,request,columns,format,tenant_id").fetch_optional(pool).await?)
}
