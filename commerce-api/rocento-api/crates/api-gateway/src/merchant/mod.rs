//! Authenticated, read-only merchant questions over authoritative PostgreSQL snapshots.
//! Intent dispatch is deliberately bounded: unsupported prose never becomes SQL or filters.
use crate::identity::{self, ApiError};
use axum::{
    extract::{DefaultBodyLimit, Query, State},
    http::HeaderMap,
    middleware,
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Question {
    Orders,
    LowStock,
    TopSellers,
    SlowStock,
    CategoryDecline,
    OrderStatus,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub request_id: Option<Uuid>,
    pub conversation_id: Option<Uuid>,
    pub question: Question,
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub currency: String,
    pub scope: String,
    pub order_id: Option<Uuid>,
    pub stock_threshold: i32,
    pub sales_threshold: i32,
}
#[derive(Serialize, Deserialize)]
pub struct Answer {
    pub request_id: Uuid,
    pub conversation_id: Uuid,
    pub helpful: Option<bool>,
    pub question: Question,
    pub title: String,
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub currency: String,
    pub scope: String,
    pub evaluated_at: DateTime<Utc>,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub notes: Vec<String>,
    pub truncated: bool,
}
impl Input {
    fn validate(&self, today: NaiveDate) -> Result<()> {
        if self.from > self.to
            || (self.to - self.from).num_days() > 365
            || self.to > today
            || self.from.year() < 2000
            || self.currency.len() != 3
            || !self.currency.bytes().all(|b| b.is_ascii_uppercase())
            || self.scope != "installation"
            || !(0..=1_000_000).contains(&self.stock_threshold)
            || !(0..=1_000_000).contains(&self.sales_threshold)
            || (self.question == Question::OrderStatus) != self.order_id.is_some()
        {
            return Err(Error::Invalid("Choose a valid UTC range (up to 366 days), three-letter currency, installation scope and appropriate order reference/thresholds".into()));
        }
        Ok(())
    }
    fn permissions(&self) -> &'static [&'static str] {
        match self.question {
            Question::OrderStatus => &["orders.read"],
            Question::LowStock => &["inventory.read", "catalog.read"],
            Question::SlowStock => &["reports.read", "inventory.read", "catalog.read"],
            Question::Orders | Question::TopSellers | Question::CategoryDecline => {
                &["reports.read"]
            }
        }
    }
}
use chrono::Datelike;
pub fn router(identity: identity::App) -> Router {
    maintenance(identity.customers.pool.clone());
    Router::new()
        .route("/v1/admin/assistant/query", post(query))
        .route("/v1/admin/assistant/history", get(history))
        .route("/v1/admin/assistant/feedback", post(feedback))
        .route("/v1/admin/assistant/metrics", get(metrics))
        .layer(DefaultBodyLimit::max(4096))
        .layer(middleware::from_fn_with_state(
            identity.clone(),
            identity::policy,
        ))
        .with_state(identity)
}
async fn query(
    State(app): State<identity::App>,
    headers: HeaderMap,
    Json(mut input): Json<Input>,
) -> std::result::Result<Json<Answer>, ApiError> {
    // Fresh session and role lookup on every execution, including repeat questions.
    let who = app
        .admins
        .authenticate(identity::cookie(&headers, "admin_session"))
        .await?;
    for permission in input.permissions() {
        who.require(permission)?;
    }
    input.validate(Utc::now().date_naive())?;
    input.request_id.get_or_insert_with(Uuid::new_v4);
    input.conversation_id.get_or_insert_with(Uuid::new_v4);
    let request_json = serde_json::to_value(&input).map_err(|_| Error::Internal)?;
    let started = std::time::Instant::now();
    let existing=sqlx::query("SELECT request,response,helpful FROM merchant_ai.messages WHERE admin_id=$1 AND request_id=$2 AND created_at>now()-interval '30 days'").bind(who.user.id).bind(input.request_id).fetch_optional(&app.customers.pool).await?;
    if let Some(row) = existing {
        let previous: serde_json::Value = row.try_get("request")?;
        if previous != request_json {
            return Err(Error::Conflict.into());
        }
        let mut answer: Answer =
            serde_json::from_value(row.try_get("response")?).map_err(|_| Error::Internal)?;
        answer.helpful = row.try_get("helpful")?;
        return Ok(Json(answer));
    }
    infra_auth::rate_limit(
        &app.customers.pool,
        &format!("merchant-query:{}", who.user.id),
        60,
    )
    .await?;
    static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
    let _permit = SLOTS.try_acquire().map_err(|_| Error::RateLimited)?;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        execute(&app.customers.pool, input),
    )
    .await
    .map_err(|_| Error::Internal)??;
    let mut tx = app.customers.pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='2s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,9009))")
        .bind(who.user.id.to_string())
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM merchant_ai.messages WHERE admin_id=$1 AND created_at<now()-interval '30 days'").bind(who.user.id).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO merchant_ai.conversations(admin_id,id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    )
    .bind(who.user.id)
    .bind(result.conversation_id)
    .execute(&mut *tx)
    .await?;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM merchant_ai.messages WHERE admin_id=$1 AND conversation_id=$2",
    )
    .bind(who.user.id)
    .bind(result.conversation_id)
    .fetch_one(&mut *tx)
    .await?;
    if count >= 30 {
        return Err(Error::Invalid("Start a new conversation after 30 questions".into()).into());
    }
    let saved=sqlx::query("INSERT INTO merchant_ai.messages(admin_id,conversation_id,request_id,question,request,response,latency_ms) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING")
        .bind(who.user.id).bind(result.conversation_id).bind(result.request_id).bind(format!("{:?}",result.question)).bind(request_json).bind(serde_json::to_value(&result).map_err(|_|Error::Internal)?).bind(started.elapsed().as_millis().min(60000) as i32).execute(&mut *tx).await?;
    if saved.rows_affected() != 1 {
        return Err(Error::Conflict.into());
    }
    tx.commit().await?;
    Ok(Json(result))
}

async fn execute(pool: &PgPool, input: Input) -> Result<Answer> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='5s'")
        .execute(&mut *tx)
        .await?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    let previous_from = input.from - Duration::days((input.to - input.from).num_days() + 1);
    let (title, columns, sql, accounting): (&str, &[&str], &str, &str) = match input.question {
        Question::Orders => ("Orders by current status", &["Status", "Orders", "Order value", "Recorded refunds", "Value less refunds"], include_str!("orders.sql"), "All current statuses are shown separately, including cancelled and delivery_failed. Values include order discounts, tax and delivery; these are booked order values, not collected revenue. Refunds are recorded as of this snapshot, attributed to the original order date. Do not count cancelled or failed orders as sales."),
        Question::LowStock => ("Low-stock products", &["Product ID", "Product", "SKU", "On hand", "Reserved", "Available"], include_str!("low_stock.sql"), "Current active simple products in the selected catalog currency. Available = default-stock on hand minus unexpired reservations, matching the inventory service. Missing stock is zero. This is current default-stock availability, not a delivery-area or channel promise; date filters do not apply to stock."),
        Question::TopSellers => ("Top sellers by ordered units", &["Product ID", "Product at order time", "Units", "Merchandise value"], include_str!("top_sellers.sql"), "Excludes cancelled and delivery_failed orders. Units are ordered units, not confirmed deliveries. Merchandise value subtracts line discounts and excludes tax/delivery. Refunds cannot be allocated to items in this schema and are not deducted; this is not net realized sales."),
        Question::SlowStock => ("High stock with low ordered units", &["Product ID", "Product", "Available", "Ordered units"], include_str!("slow_stock.sql"), "Active simple products in the selected catalog currency; current default-stock availability minus unexpired reservations. Period units exclude cancelled and delivery_failed orders. Returns/refunds do not adjust item units because item allocations are unavailable. Date filters apply to orders only."),
        Question::CategoryDecline => ("Categories with declining merchandise value", &["Category ID", "Current category", "Previous value", "Current value", "Change"], include_str!("category_decline.sql"), "Compares equal-length UTC periods by order creation date. Excludes cancelled and delivery_failed orders; subtracts line discounts, excludes tax/delivery. Refunds are not item/category allocated and are not deducted. Uses current product categories, not historical taxonomy; deleted products are excluded."),
        Question::OrderStatus => ("Current order status", &["Order ID", "Order number", "Status", "Created UTC", "Order value", "Recorded refunds"], include_str!("order_status.sql"), "Exact order ID within this installation, currency and UTC creation-date range. Current status and recorded order-level refunds are read from the database. No customer contact, address or payment credentials are returned."),
    };
    // Fixed SQL, bound values only. No LLM, browser or database string can alter query structure.
    let records = sqlx::query(sql)
        .bind(input.from)
        .bind(input.to)
        .bind(&input.currency)
        .bind(previous_from)
        .bind(input.stock_threshold)
        .bind(input.sales_threshold)
        .bind(input.order_id)
        .fetch_all(&mut *tx)
        .await?;
    let mut rows: Vec<Vec<String>> = records
        .iter()
        .map(|row| row.try_get("cells"))
        .collect::<std::result::Result<_, _>>()?;
    let truncated = rows.len() > 20;
    rows.truncate(20);
    let mut notes = vec![
        "Source: authoritative commerce database, one read-only snapshot. Scope: this installation; orders have no store/channel dimension, so channel or cross-store breakdowns are unsupported. Currency is never converted or mixed.".into(),
        format!("UTC order dates {} through {} inclusive (end exclusive at the next midnight).", input.from, input.to),
        accounting.into(),
    ];
    if input.question == Question::CategoryDecline {
        notes.push(format!(
            "Previous period: {} through {} UTC.",
            previous_from,
            input.from - Duration::days(1)
        ));
    }
    if matches!(input.question, Question::LowStock | Question::SlowStock) {
        notes.push(format!(
            "Available stock threshold: {} ({}).",
            input.stock_threshold,
            if input.question == Question::LowStock {
                "at most"
            } else {
                "at least"
            }
        ));
    }
    if input.question == Question::SlowStock {
        notes.push(format!(
            "Period ordered units: at most {}.",
            input.sales_threshold
        ));
    }
    if rows.is_empty() {
        notes.push("No matching records. This does not imply a zero value for an unobserved product, order or category.".into());
    }
    if truncated {
        notes.push("Showing the first 20 results; additional matching records exist.".into());
    }
    if rows
        .iter()
        .any(|r| r.len() != columns.len() || r.iter().any(|v| v.len() > 4000))
    {
        return Err(Error::Internal);
    }
    tx.commit().await?;
    Ok(Answer {
        request_id: input.request_id.unwrap_or_else(Uuid::new_v4),
        conversation_id: input.conversation_id.unwrap_or_else(Uuid::new_v4),
        helpful: None,
        question: input.question,
        title: title.into(),
        from: input.from,
        to: input.to,
        currency: input.currency,
        scope: input.scope,
        evaluated_at: now,
        columns: columns.iter().map(|s| (*s).into()).collect(),
        rows,
        notes,
        truncated,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryQuery {
    conversation_id: Option<Uuid>,
}
async fn history(
    State(app): State<identity::App>,
    headers: HeaderMap,
    Query(query): Query<HistoryQuery>,
) -> std::result::Result<Json<Vec<Answer>>, ApiError> {
    let who = app
        .admins
        .authenticate(identity::cookie(&headers, "admin_session"))
        .await?;
    let rows = if let Some(id) = query.conversation_id {
        sqlx::query("SELECT request,response,helpful FROM merchant_ai.messages WHERE admin_id=$1 AND conversation_id=$2 AND created_at>now()-interval '30 days' ORDER BY created_at DESC,request_id DESC LIMIT 30").bind(who.user.id).bind(id).fetch_all(&app.customers.pool).await?
    } else {
        sqlx::query("SELECT request,response,helpful FROM (SELECT DISTINCT ON(conversation_id) request,response,helpful,created_at FROM merchant_ai.messages WHERE admin_id=$1 AND created_at>now()-interval '30 days' ORDER BY conversation_id,created_at DESC,request_id DESC) recent ORDER BY created_at DESC LIMIT 20").bind(who.user.id).fetch_all(&app.customers.pool).await?
    };
    let mut result = Vec::new();
    for row in rows {
        let input: Input =
            serde_json::from_value(row.try_get("request")?).map_err(|_| Error::Internal)?;
        if input.permissions().iter().any(|p| who.require(p).is_err()) {
            continue;
        }
        let mut answer: Answer =
            serde_json::from_value(row.try_get("response")?).map_err(|_| Error::Internal)?;
        answer.helpful = row.try_get("helpful")?;
        result.push(answer);
    }
    Ok(Json(result))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Feedback {
    request_id: Uuid,
    helpful: bool,
}
async fn feedback(
    State(app): State<identity::App>,
    headers: HeaderMap,
    Json(body): Json<Feedback>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    let who = app
        .admins
        .authenticate(identity::cookie(&headers, "admin_session"))
        .await?;
    let request:Option<serde_json::Value>=sqlx::query_scalar("SELECT request FROM merchant_ai.messages WHERE admin_id=$1 AND request_id=$2 AND created_at>now()-interval '30 days'").bind(who.user.id).bind(body.request_id).fetch_optional(&app.customers.pool).await?;
    let input: Input =
        serde_json::from_value(request.ok_or(Error::NotFound)?).map_err(|_| Error::Internal)?;
    for p in input.permissions() {
        who.require(p)?;
    }
    sqlx::query("UPDATE merchant_ai.messages SET helpful=$1 WHERE admin_id=$2 AND request_id=$3")
        .bind(body.helpful)
        .bind(who.user.id)
        .bind(body.request_id)
        .execute(&app.customers.pool)
        .await?;
    Ok(Json(serde_json::json!({"status":"ok"})))
}
async fn metrics(
    State(app): State<identity::App>,
    headers: HeaderMap,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    app.admins
        .authenticate(identity::cookie(&headers, "admin_session"))
        .await?
        .require("reports.read")?;
    let row:serde_json::Value=sqlx::query_scalar("SELECT json_build_object('turns',count(*),'conversations',count(DISTINCT (admin_id,conversation_id)),'helpful',count(*) FILTER(WHERE helpful=true),'not_helpful',count(*) FILTER(WHERE helpful=false),'latency_ms',coalesce(avg(latency_ms),0)::float) FROM merchant_ai.messages WHERE created_at>now()-interval '24 hours'").fetch_one(&app.customers.pool).await?;
    Ok(Json(row))
}

pub fn maintenance(pool: PgPool) {
    tokio::spawn(async move {
        loop {
            if sqlx::query(
                "DELETE FROM merchant_ai.conversations WHERE created_at<now()-interval '30 days'",
            )
            .execute(&pool)
            .await
            .is_err()
            {
                tracing::warn!("merchant history retention unavailable");
            }
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
}
