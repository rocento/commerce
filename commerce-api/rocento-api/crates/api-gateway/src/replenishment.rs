use crate::identity::{self, ApiError};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post, put},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

type Result<T> = std::result::Result<T, ApiError>;
fn db(error: sqlx::Error) -> ApiError {
    infra_auth::Error::from(error).into()
}

#[derive(Clone)]
pub struct App {
    pub identity: identity::App,
    pub pool: PgPool,
}
impl App {
    async fn authorize(&self, h: &HeaderMap, permission: &str) -> Result<Uuid> {
        let admin = self
            .identity
            .admins
            .authenticate(identity::cookie(h, "admin_session"))
            .await?;
        admin.require(permission)?;
        Ok(admin.user.id)
    }
}

#[derive(Serialize, FromRow)]
pub struct Recommendation {
    pub product_id: Uuid,
    pub sku: String,
    pub product: String,
    pub image_id: Option<Uuid>,
    pub supplier: String,
    pub planning_group: String,
    pub on_hand: i64,
    pub reserved: i64,
    pub saleable_qty: i64,
    pub is_in_stock: bool,
    pub sales_velocity: f64,
    pub sells_out_in_days: Option<f64>,
    pub days_of_stock: Option<f64>,
    pub replenishment_qty: i64,
    pub replenishment_in_days: Option<i32>,
    pub recommended_date: Option<DateTime<Utc>>,
    pub overstock_qty: i64,
    pub last_sold_at: Option<DateTime<Utc>>,
    pub sales_7_days: i64,
    pub sales_30_days: i64,
    pub sales_90_days: i64,
    pub total_sales: i64,
    pub lead_time_days: i32,
    pub target_cover_days: i32,
    pub safety_stock_days: i32,
    pub minimum_order_qty: i32,
    pub order_multiple: i32,
    pub enabled: bool,
    pub warehouse_quantities: Value,
}

#[derive(Deserialize)]
pub struct PolicyInput {
    pub supplier: String,
    pub planning_group: String,
    pub lead_time_days: i32,
    pub target_cover_days: i32,
    pub safety_stock_days: i32,
    pub minimum_order_qty: i32,
    pub order_multiple: i32,
    pub enabled: bool,
}

#[derive(Serialize)]
pub struct Refresh {
    pub refreshed_at: DateTime<Utc>,
}

pub fn router(app: App) -> Router {
    Router::new()
        .route("/v1/admin/replenishment", get(list))
        .route("/v1/admin/replenishment/refresh", post(refresh))
        .route("/v1/admin/replenishment/{id}", put(save_policy))
        .with_state(app)
}

const QUERY: &str = r#"
WITH sales AS (
 SELECT i.product_id,
  COALESCE(SUM(i.quantity) FILTER (WHERE o.created_at >= now()-interval '7 days'),0)::bigint sales_7_days,
  COALESCE(SUM(i.quantity) FILTER (WHERE o.created_at >= now()-interval '30 days'),0)::bigint sales_30_days,
  COALESCE(SUM(i.quantity) FILTER (WHERE o.created_at >= now()-interval '90 days'),0)::bigint sales_90_days,
  COALESCE(SUM(i.quantity),0)::bigint total_sales, MAX(o.created_at) last_sold_at
 FROM orders.order_items i JOIN orders.orders o ON o.id=i.order_id
 WHERE o.status NOT IN ('cancelled','delivery_failed') GROUP BY i.product_id
), source_holds AS (
 SELECT a.source_id,a.product_id,SUM(a.quantity)::bigint reserved
 FROM inventory.reservation_allocations a
 JOIN inventory.reservations r USING(cart_id,product_id)
 WHERE r.expires_at>clock_timestamp()
 GROUP BY a.source_id,a.product_id
), quantities AS (
 SELECT p.id product_id, COALESCE(SUM(si.quantity) FILTER (WHERE src.is_enabled),0)::bigint on_hand,
  COALESCE(jsonb_agg(jsonb_build_object('source_id',src.id,'source',src.name,'on_hand',COALESCE(si.quantity,0),'saleable',CASE WHEN src.is_enabled AND si.status='in_stock' THEN GREATEST(si.quantity-COALESCE(sh.reserved,0),0) ELSE 0 END) ORDER BY src.name) FILTER (WHERE src.id IS NOT NULL),'[]') warehouse_quantities
 FROM catalog.products p LEFT JOIN inventory.source_items si ON si.product_id=p.id
 LEFT JOIN inventory.inventory_sources src ON src.id=si.source_id
 LEFT JOIN source_holds sh ON sh.source_id=si.source_id AND sh.product_id=p.id GROUP BY p.id
), base AS (
 SELECT p.id product_id,p.sku,p.name product,p.media_ids[1] image_id,
  COALESCE(pol.supplier,'') supplier,COALESCE(pol.planning_group,'') planning_group,
  q.on_hand,COALESCE(r.reserved,0)::bigint reserved,GREATEST(q.on_hand-COALESCE(r.reserved,0),0)::bigint saleable_qty,
  COALESCE(s.sales_7_days,0) sales_7_days,COALESCE(s.sales_30_days,0) sales_30_days,
  COALESCE(s.sales_90_days,0) sales_90_days,COALESCE(s.total_sales,0) total_sales,s.last_sold_at,
  COALESCE(pol.lead_time_days,7) lead_time_days,COALESCE(pol.target_cover_days,30) target_cover_days,
  COALESCE(pol.safety_stock_days,3) safety_stock_days,COALESCE(pol.minimum_order_qty,1) minimum_order_qty,
  COALESCE(pol.order_multiple,1) order_multiple,COALESCE(pol.enabled,true) enabled,q.warehouse_quantities,
  CASE WHEN COALESCE(s.sales_30_days,0)>0 THEN s.sales_30_days::float8/30
       WHEN COALESCE(s.sales_90_days,0)>0 THEN s.sales_90_days::float8/90 ELSE 0 END sales_velocity
 FROM catalog.products p JOIN quantities q ON q.product_id=p.id
 LEFT JOIN sales s ON s.product_id=p.id LEFT JOIN inventory.replenishment_policies pol ON pol.product_id=p.id
 LEFT JOIN (SELECT product_id,SUM(quantity) reserved FROM inventory.reservations WHERE expires_at>clock_timestamp() GROUP BY product_id) r ON r.product_id=p.id
), calculated AS (
 SELECT *, CASE WHEN sales_velocity>0 THEN saleable_qty/sales_velocity END days_stock,
  CASE WHEN sales_velocity>0 THEN GREATEST(FLOOR((saleable_qty-sales_velocity*(lead_time_days+safety_stock_days))/sales_velocity),0)::int END replenish_in,
  GREATEST(CEIL(sales_velocity*(lead_time_days+target_cover_days+safety_stock_days)-saleable_qty),0)::bigint raw_replenish,
  GREATEST(saleable_qty-CEIL(sales_velocity*(lead_time_days+target_cover_days+safety_stock_days)*2),0)::bigint overstock_qty
 FROM base
)
SELECT product_id,sku,product,image_id,supplier,planning_group,on_hand,reserved,saleable_qty,(saleable_qty>0) is_in_stock,
 sales_velocity,days_stock sells_out_in_days,days_stock days_of_stock,
 CASE WHEN raw_replenish=0 OR NOT enabled THEN 0 ELSE (CEIL(GREATEST(minimum_order_qty::numeric,raw_replenish::numeric)/order_multiple)*order_multiple)::bigint END replenishment_qty,
 replenish_in replenishment_in_days,CASE WHEN replenish_in IS NULL THEN NULL ELSE now()+make_interval(days=>replenish_in) END recommended_date,
 overstock_qty,last_sold_at,sales_7_days,sales_30_days,sales_90_days,total_sales,lead_time_days,target_cover_days,
 safety_stock_days,minimum_order_qty,order_multiple,enabled,warehouse_quantities
FROM calculated ORDER BY enabled DESC,replenish_in ASC NULLS LAST,replenishment_qty DESC,product
"#;

async fn list(State(a): State<App>, h: HeaderMap) -> Result<impl IntoResponse> {
    a.authorize(&h, "inventory.read").await?;
    Ok(Json(
        sqlx::query_as::<_, Recommendation>(QUERY)
            .fetch_all(&a.pool)
            .await
            .map_err(db)?,
    ))
}

fn validate(i: &PolicyInput) -> Result<()> {
    if i.supplier.len() > 160 || i.planning_group.len() > 120 {
        return Err(domain_inventory::invalid("Supplier or group is too long").into());
    }
    if !(0..=3650).contains(&i.lead_time_days)
        || !(1..=3650).contains(&i.target_cover_days)
        || !(0..=3650).contains(&i.safety_stock_days)
        || !(1..=1_000_000).contains(&i.minimum_order_qty)
        || !(1..=1_000_000).contains(&i.order_multiple)
    {
        return Err(domain_inventory::invalid("Invalid replenishment policy values").into());
    }
    Ok(())
}
async fn save_policy(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<PolicyInput>,
) -> Result<impl IntoResponse> {
    let actor = a.authorize(&h, "inventory.write").await?;
    validate(&i)?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.products WHERE id=$1)")
            .bind(id)
            .fetch_one(&a.pool)
            .await
            .map_err(db)?;
    if !exists {
        return Err(infra_auth::Error::NotFound.into());
    }
    let mut tx = a.pool.begin().await.map_err(db)?;
    sqlx::query("INSERT INTO inventory.replenishment_policies(product_id,supplier,planning_group,lead_time_days,target_cover_days,safety_stock_days,minimum_order_qty,order_multiple,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(product_id) DO UPDATE SET supplier=$2,planning_group=$3,lead_time_days=$4,target_cover_days=$5,safety_stock_days=$6,minimum_order_qty=$7,order_multiple=$8,enabled=$9,updated_at=clock_timestamp()")
      .bind(id).bind(i.supplier.trim()).bind(i.planning_group.trim()).bind(i.lead_time_days).bind(i.target_cover_days).bind(i.safety_stock_days).bind(i.minimum_order_qty).bind(i.order_multiple).bind(i.enabled).execute(&mut *tx).await.map_err(db)?;
    infra_events::record(
        &mut tx,
        "inventory.replenishment_policy_updated",
        serde_json::json!({"id":id,"actor_id":actor}),
    )
    .await
    .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok((
        StatusCode::OK,
        Json(
            sqlx::query_as::<_, Recommendation>(&format!(
                "SELECT * FROM ({QUERY}) x WHERE product_id=$1"
            ))
            .bind(id)
            .fetch_one(&a.pool)
            .await
            .map_err(db)?,
        ),
    ))
}
async fn refresh(State(a): State<App>, h: HeaderMap) -> Result<impl IntoResponse> {
    let actor = a.authorize(&h, "inventory.write").await?;
    let refreshed_at:DateTime<Utc>=sqlx::query_scalar("UPDATE inventory.replenishment_refreshes SET refreshed_at=clock_timestamp(),refreshed_by=$1 WHERE id RETURNING refreshed_at").bind(actor).fetch_one(&a.pool).await.map_err(db)?;
    Ok(Json(Refresh { refreshed_at }))
}
