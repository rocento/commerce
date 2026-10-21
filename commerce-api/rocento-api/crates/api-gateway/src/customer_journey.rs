//! Customer-scoped recorded activity. Browser observations never stand in for commerce writes.
use crate::identity::{self, ApiError, App};
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Filters {
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
    pub before: Option<DateTime<Utc>>,
    pub before_id: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Customer {
    pub id: Uuid,
    pub name: String,
    pub email: Option<String>,
}
#[derive(Serialize, sqlx::FromRow)]
pub struct Event {
    pub id: String,
    pub occurred_at: DateTime<Utc>,
    pub kind: String,
    pub source: String,
    pub session_id: Option<Uuid>,
    pub details: Value,
}
#[derive(Serialize)]
pub struct Cursor {
    pub before: DateTime<Utc>,
    pub before_id: String,
}
#[derive(Serialize)]
pub struct Journey {
    pub customer: Customer,
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub includes_orders: bool,
    pub events: Vec<Event>,
    pub next_cursor: Option<Cursor>,
}

/// Called by the normal analytics endpoint after input validation. No anonymous session stitching.
pub async fn record_browser(
    app: &App,
    headers: &HeaderMap,
    event: &crate::analytics::Event,
) -> Result<(), Error> {
    event.validate()?;
    if !headers.contains_key("authorization") {
        return Ok(());
    }
    let customer = app
        .customers
        .authenticate(identity::bearer(headers)?)
        .await?;
    // Cart/checkout/purchase are sourced from their committed server records, not browser claims.
    if !matches!(event.event_type.as_str(), "page_view" | "search_query") {
        return Ok(());
    }
    infra_auth::rate_limit(
        &app.customers.pool,
        &format!("journey:{}", customer.id),
        1000,
    )
    .await?;
    sqlx::query("INSERT INTO customers.journey_events(customer_id,id,session_id,event_type,path,query,result_count,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(customer_id,id) DO NOTHING")
        .bind(customer.id).bind(event.id).bind(event.session_id).bind(&event.event_type)
        .bind(&event.path).bind(&event.query).bind(event.result_count.map(i64::from))
        .bind(event.source.as_deref().unwrap_or("unknown")).execute(&app.customers.pool).await?;
    Ok(())
}

pub async fn enqueue_browser(
    app: &App,
    headers: &HeaderMap,
    event: crate::analytics::Event,
) -> Result<(), Error> {
    event.validate()?;
    let customer = if headers.contains_key("authorization") {
        Some(crate::engagement::customer(app, identity::bearer(headers)?).await?)
    } else {
        None
    };
    // Authentication remains authoritative; browsing/history writes never touch
    // the transaction database. The event is acknowledged only after durable enqueue.
    let key = format!(
        "browser:{}:{}",
        customer.map(|id| id.to_string()).unwrap_or_default(),
        event.id
    );
    crate::engagement::enqueue(
        &app.engagement,
        key,
        "browser",
        serde_json::json!({"customer":customer,"event":event}),
    )
    .await?;
    Ok(())
}

pub async fn journey(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(filters): Query<Filters>,
) -> Result<Json<Journey>, ApiError> {
    let who = crate::engagement::admin(&app, identity::cookie(&headers, "admin_session")).await?;
    who.require("customers.read")?;
    // Customer-profile access does not grant access to private order records.
    let includes_orders = who.require("orders.read").is_ok();
    let to = filters.to.unwrap_or_else(|| Utc::now().date_naive());
    let from = match filters.from {
        Some(from) => from,
        None => to
            .checked_sub_signed(Duration::days(29))
            .ok_or_else(|| Error::Invalid("Invalid start date".into()))?,
    };
    let limit = filters.limit.unwrap_or(50);
    if from > to
        || to.signed_duration_since(from).num_days() > 89
        || !(1..=100).contains(&limit)
        || filters.before.is_some() != filters.before_id.is_some()
        || filters.before_id.as_ref().is_some_and(|id| id.len() > 100)
    {
        return Err(Error::Invalid(
            "Choose a range of up to 90 days and a valid pagination cursor".into(),
        )
        .into());
    }
    let until = to
        .succ_opt()
        .ok_or_else(|| Error::Invalid("Invalid end date".into()))?;
    let customer = sqlx::query_as::<_, Customer>("SELECT id,COALESCE(NULLIF(trim(first_name || ' ' || last_name),''),email,mobile_number,'Unnamed customer') AS name,email FROM customers.customers WHERE id=$1")
        .bind(id).fetch_optional(&app.engagement_commerce).await?.ok_or(Error::NotFound)?;
    let browser = crate::engagement::browser_page(
        &app.engagement,
        id,
        from.and_hms_opt(0, 0, 0).unwrap().and_utc(),
        until.and_hms_opt(0, 0, 0).unwrap().and_utc(),
        filters.before,
        filters.before_id.as_deref(),
        None,
    )
    .await?;
    let query = include_str!("customer_journey.sql").replace(
        "customers.journey_events e",
        &crate::engagement::browser_source(8),
    );
    let mut events = sqlx::query_as::<_, Event>(&query)
        .bind(id)
        .bind(from.and_hms_opt(0, 0, 0).unwrap().and_utc())
        .bind(until.and_hms_opt(0, 0, 0).unwrap().and_utc())
        .bind(filters.before)
        .bind(filters.before_id)
        .bind(includes_orders)
        .bind(limit + 1)
        .bind(browser)
        .fetch_all(&app.engagement_commerce)
        .await?;
    let next_cursor = if events.len() > limit as usize {
        events.truncate(limit as usize);
        events.last().map(|event| Cursor {
            before: event.occurred_at,
            before_id: event.id.clone(),
        })
    } else {
        None
    };
    Ok(Json(Journey {
        customer,
        from,
        to,
        includes_orders,
        events,
        next_cursor,
    }))
}

/// Shared server-owned event selection for manual programs and automatic campaigns.
/// Product filtering still selects the latest event, never an older event that
/// happens to satisfy a condition.
pub async fn latest_event(
    engagement: &sqlx::PgPool,
    commerce: &sqlx::PgPool,
    customer: Uuid,
    from: DateTime<Utc>,
    now: DateTime<Utc>,
    kind: &str,
    product: Option<Uuid>,
) -> Result<Option<Event>, Error> {
    let source = include_str!("customer_journey.sql")
        .split("SELECT * FROM activity")
        .next()
        .unwrap()
        .replace(
            "customers.journey_events e",
            &crate::engagement::browser_source(9),
        );
    let browser =
        crate::engagement::browser_page(engagement, customer, from, now, None, None, Some(kind))
            .await?;
    let query = format!("{source} SELECT * FROM activity WHERE kind=$8 AND ($4::timestamptz IS NULL OR (occurred_at,id)<($4::timestamptz,$5::text)) ORDER BY occurred_at DESC,id DESC LIMIT $7");
    let event = sqlx::query_as::<_, Event>(&query)
        .bind(customer)
        .bind(from)
        .bind(now)
        .bind(None::<DateTime<Utc>>)
        .bind(None::<String>)
        .bind(true)
        .bind(1_i64)
        .bind(kind)
        .bind(browser)
        .fetch_optional(commerce)
        .await?;
    Ok(event.filter(|event| {
        product.is_none_or(|id| {
            event.details.get("product_id").and_then(Value::as_str) == Some(id.to_string().as_str())
        })
    }))
}
