//! Provider-free marketing programs. Only deliberate generation persists content; no delivery
//! queue, contact address, transport, or commerce notification worker is used here.
use crate::identity::{self, ApiError, App};
use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{types::Json as DbJson, FromRow, PgConnection};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[path = "notification_conditions.rs"]
pub mod conditions;

const CHANNELS: &[(&str, &str)] = &[
    ("in_app", "In-app"),
    ("email", "Email"),
    ("sms", "SMS"),
    ("whatsapp", "WhatsApp"),
    ("push", "Push"),
];
const TRIGGERS: &[(&str, &str, bool)] = &[
    ("visit", "Store visit", false),
    ("product_view", "Product viewed", false),
    ("category_view", "Category viewed", false),
    ("page_view", "Page viewed", false),
    ("search", "Search performed", false),
    ("cart.item_added", "Item added to cart", false),
    ("cart.item_removed", "Item removed from cart", false),
    (
        "shopping.proposal_created",
        "Shopping proposal created",
        false,
    ),
    ("shopping.cart_applied", "Shopping proposal applied", false),
    ("checkout", "Checkout quoted", true),
    ("purchase", "Order placed", true),
    ("order_status", "Order status changed", true),
];
const TOKENS: &[(&str, &str)] = &[
    ("customer.first_name", "Customer first name"),
    ("customer.name", "Customer name"),
    ("customer.id", "Customer ID"),
    ("event.kind", "Journey event kind"),
    ("event.occurred_at", "Journey event time (UTC)"),
    ("product.name", "Product name"),
    ("order.number", "Order number"),
    ("order.status", "Order status"),
    ("order.total", "Order total"),
    ("order.currency", "Order currency"),
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProgramInput {
    pub name: String,
    pub description: String,
    pub channel: String,
    pub trigger_kind: String,
    pub title_template: String,
    pub body_template: String,
    pub status: String,
    pub delay_minutes: i64,
    pub lookback_days: i64,
    pub cooldown_hours: i64,
    pub suppress_after_purchase: bool,
    #[serde(default)]
    pub conditions: conditions::Conditions,
}

#[derive(Clone, Debug, Serialize, FromRow)]
struct Program {
    id: Uuid,
    #[serde(flatten)]
    config: DbJson<ProgramInput>,
    version: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveInput {
    #[serde(flatten)]
    program: ProgramInput,
    version: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewInput {
    program: ProgramInput,
    customer_id: Uuid,
    program_id: Option<Uuid>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GenerateInput {
    customer_id: Uuid,
    version: i64,
    idempotency_key: Uuid,
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListQuery {
    offset: Option<i64>,
    limit: Option<i64>,
    search: Option<String>,
    status: Option<String>,
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordsQuery {
    offset: Option<i64>,
    limit: Option<i64>,
    program_id: Option<Uuid>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuditQuery {
    offset: Option<i64>,
    limit: Option<i64>,
}
#[derive(Serialize, FromRow)]
struct GeneratedRecord {
    id: Uuid,
    program_id: Uuid,
    program_name: String,
    program_version: i64,
    customer_id: Uuid,
    event_id: String,
    channel: String,
    title: String,
    body: String,
    status: String,
    created_at: DateTime<Utc>,
}
#[derive(Serialize)]
struct Preview {
    title: String,
    body: String,
    event_id: Option<String>,
    event_kind: Option<String>,
    eligible: bool,
    reasons: Vec<String>,
    missing_tokens: Vec<String>,
    context: BTreeMap<String, String>,
    condition_match: String,
    conditions_matched: bool,
    condition_results: Vec<conditions::ConditionResult>,
}
#[derive(Serialize)]
struct Generation {
    outcome: String,
    reason: Option<String>,
    record: Option<GeneratedRecord>,
}
struct NotificationError(Error);
impl From<Error> for NotificationError {
    fn from(value: Error) -> Self {
        Self(value)
    }
}
impl From<sqlx::Error> for NotificationError {
    fn from(value: sqlx::Error) -> Self {
        Self(value.into())
    }
}
impl IntoResponse for NotificationError {
    fn into_response(self) -> Response {
        if matches!(self.0, Error::Conflict) {
            response(
                StatusCode::CONFLICT,
                json!({"error":"This program changed, or the idempotency key belongs to another request. Reload the program and use a new key for a new request.","code":"notification_conflict"}),
            )
        } else {
            ApiError::from(self.0).into_response()
        }
    }
}
type ApiResult = Result<Response, NotificationError>;
fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn response(status: StatusCode, value: impl Serialize) -> Response {
    let mut response = (status, Json(value)).into_response();
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response
}
fn input<T>(value: Result<Json<T>, JsonRejection>) -> infra_auth::Result<T> {
    value
        .map(|v| v.0)
        .map_err(|_| invalid("Invalid notification request"))
}
fn text_field(value: &str, max: usize, multiline: bool, required: bool) -> infra_auth::Result<()> {
    if (required && value.trim().is_empty())
        || value.chars().count() > max
        || value
            .chars()
            .any(|c| c.is_control() && !(multiline && matches!(c, '\n' | '\t')))
    {
        return Err(invalid(
            "Notification text is empty, too long, or contains invalid control characters",
        ));
    }
    Ok(())
}

/// Strict, non-recursive plain-text substitution. Replacements are always untrusted data.
fn render(
    value: &str,
    context: &BTreeMap<String, String>,
) -> infra_auth::Result<(String, BTreeSet<String>)> {
    let mut rest = value;
    let mut output = String::new();
    let mut missing = BTreeSet::new();
    let mut count = 0;
    while let Some(start) = rest.find("{{") {
        if rest[..start].contains(['{', '}']) {
            return Err(invalid(
                "Use exact named placeholders such as {{customer.first_name}}",
            ));
        }
        output.push_str(&rest[..start]);
        rest = &rest[start + 2..];
        let end = rest
            .find("}}")
            .ok_or_else(|| invalid("A notification placeholder is incomplete"))?;
        let token = &rest[..end];
        if !TOKENS.iter().any(|(key, _)| *key == token) {
            return Err(invalid("Notification contains an unknown placeholder"));
        }
        count += 1;
        if count > 40 {
            return Err(invalid("Use no more than 40 placeholders per field"));
        }
        if let Some(replacement) = context.get(token).filter(|v| !v.trim().is_empty()) {
            output.push_str(replacement);
        } else {
            missing.insert(token.to_owned());
            output.push_str(&format!("{{{{{token}}}}}"));
        }
        rest = &rest[end + 2..];
    }
    if rest.contains(['{', '}']) {
        return Err(invalid(
            "Use exact named placeholders such as {{customer.first_name}}",
        ));
    }
    output.push_str(rest);
    Ok((output, missing))
}
fn validate(p: &ProgramInput) -> infra_auth::Result<()> {
    text_field(&p.name, 120, false, true)?;
    text_field(&p.description, 1000, true, false)?;
    text_field(&p.title_template, 200, false, true)?;
    text_field(&p.body_template, 8000, true, true)?;
    if !CHANNELS.iter().any(|(id, _)| *id == p.channel)
        || !TRIGGERS.iter().any(|(id, _, _)| *id == p.trigger_kind)
        || !["draft", "active", "paused", "archived"].contains(&p.status.as_str())
        || !(0..=129600).contains(&p.delay_minutes)
        || !(1..=90).contains(&p.lookback_days)
        || p.delay_minutes >= p.lookback_days * 1440
        || !(0..=2160).contains(&p.cooldown_hours)
    {
        return Err(invalid("Choose a supported channel, trigger and status; a 1–90 day lookback; a delay shorter than the lookback; and a 0–2160 hour cooldown"));
    }
    render(&p.title_template, &BTreeMap::new())?;
    render(&p.body_template, &BTreeMap::new())?;
    conditions::validate(&p.conditions, &p.trigger_kind)?;
    Ok(())
}
fn page(offset: Option<i64>, limit: Option<i64>) -> infra_auth::Result<(i64, i64)> {
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(25);
    if !(0..=100000).contains(&offset) || !(1..=100).contains(&limit) {
        return Err(invalid(
            "Use an offset from 0 to 100000 and a limit from 1 to 100",
        ));
    }
    Ok((offset, limit))
}
async fn authorize(
    a: &App,
    h: &HeaderMap,
    permission: &str,
    journey: bool,
) -> infra_auth::Result<Uuid> {
    let who = crate::engagement::admin(a, identity::cookie(h, "admin_session")).await?;
    who.require("notifications.read")?;
    who.require(permission)?;
    if journey {
        who.require("customers.read")?;
        who.require("orders.read")?;
    }
    Ok(who.user.id)
}

pub fn router(app: App) -> Router {
    Router::new()
        .route("/v1/admin/marketing/notifications", get(list).post(create))
        .route("/v1/admin/marketing/notifications/metadata", get(metadata))
        .route("/v1/admin/marketing/notifications/preview", post(preview))
        .route("/v1/admin/marketing/notifications/records", get(records))
        .route(
            "/v1/admin/marketing/notifications/{id}",
            get(detail).put(save),
        )
        .route(
            "/v1/admin/marketing/notifications/{id}/generate",
            post(generate),
        )
        .route("/v1/admin/marketing/notifications/{id}/audit", get(audit))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn_with_state(
            app.clone(),
            identity::policy,
        ))
        .with_state(app)
}
async fn metadata(State(a): State<App>, h: HeaderMap) -> ApiResult {
    authorize(&a, &h, "notifications.read", false).await?;
    Ok(response(
        StatusCode::OK,
        json!({
            "delivery_mode":"generation_only",
            "channels":CHANNELS.iter().map(|(id,label)|json!({"id":id,"label":label,"delivery_enabled":false})).collect::<Vec<_>>(),
            "triggers":TRIGGERS.iter().map(|(id,label,requires_orders)|json!({"id":id,"label":label,"requires_orders":requires_orders})).collect::<Vec<_>>(),
            "tokens":TOKENS.iter().map(|(key,label)|json!({"key":key,"label":label})).collect::<Vec<_>>(),
            "condition_fields":conditions::metadata()
        }),
    ))
}
async fn program(
    connection: &mut PgConnection,
    id: Uuid,
    lock: &str,
) -> infra_auth::Result<Program> {
    // `lock` is an internal literal, never request input.
    sqlx::query_as(&format!("SELECT id,config,version,created_at,updated_at FROM platform.marketing_notification_programs WHERE id=$1 {lock}"))
        .bind(id).fetch_optional(connection).await?.ok_or(Error::NotFound)
}
async fn list(State(a): State<App>, h: HeaderMap, Query(q): Query<ListQuery>) -> ApiResult {
    authorize(&a, &h, "notifications.read", false).await?;
    let (offset, limit) = page(q.offset, q.limit)?;
    let search = q.search.unwrap_or_default().trim().to_owned();
    text_field(&search, 120, false, false)?;
    if q.status
        .as_ref()
        .is_some_and(|s| !["draft", "active", "paused", "archived"].contains(&s.as_str()))
    {
        return Err(invalid("Invalid program status filter").into());
    }
    let condition = "WHERE ($1::text IS NULL OR config->>'status'=$1) AND ($2='' OR strpos(lower(config->>'name'),lower($2))>0)";
    let mut tx = a.engagement.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '3s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout = '10s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let total: i64 = sqlx::query_scalar(&format!(
        "SELECT count(*) FROM platform.marketing_notification_programs {condition}"
    ))
    .bind(&q.status)
    .bind(&search)
    .fetch_one(&mut *tx)
    .await?;
    let programs: Vec<Program> = sqlx::query_as(&format!("SELECT id,config,version,created_at,updated_at FROM platform.marketing_notification_programs {condition} ORDER BY updated_at DESC,id DESC LIMIT $3 OFFSET $4"))
        .bind(&q.status).bind(&search).bind(limit).bind(offset).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(response(
        StatusCode::OK,
        json!({"programs":programs,"total":total}),
    ))
}
async fn detail(State(a): State<App>, h: HeaderMap, Path(id): Path<Uuid>) -> ApiResult {
    authorize(&a, &h, "notifications.read", false).await?;
    Ok(response(
        StatusCode::OK,
        program(&mut *a.engagement.acquire().await?, id, "").await?,
    ))
}
async fn create(
    State(a): State<App>,
    h: HeaderMap,
    body: Result<Json<ProgramInput>, JsonRejection>,
) -> ApiResult {
    let actor = authorize(&a, &h, "notifications.write", false).await?;
    let body = input(body)?;
    validate(&body)?;
    infra_auth::rate_limit(&a.engagement, &format!("notification-edit:{actor}"), 120).await?;
    let mut tx = a.engagement.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '3s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout = '10s'")
        .execute(&mut *tx)
        .await?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO platform.marketing_notification_programs(id,config,created_by,updated_by) VALUES($1,$2,$3,$3)")
        .bind(id).bind(DbJson(&body)).bind(actor).execute(&mut *tx).await?;
    crate::engagement::audit(
        &mut tx,
        Some(actor),
        "notifications.created",
        id,
        json!({"version":1,"status":body.status}),
    )
    .await?;
    let result = program(&mut tx, id, "").await?;
    tx.commit().await?;
    Ok(response(StatusCode::CREATED, result))
}
async fn save(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    body: Result<Json<SaveInput>, JsonRejection>,
) -> ApiResult {
    let actor = authorize(&a, &h, "notifications.write", false).await?;
    let body = input(body)?;
    validate(&body.program)?;
    infra_auth::rate_limit(&a.engagement, &format!("notification-edit:{actor}"), 120).await?;
    let mut tx = a.engagement.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '3s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout = '10s'")
        .execute(&mut *tx)
        .await?;
    let current = program(&mut tx, id, "FOR UPDATE").await?;
    if current.version != body.version {
        return Err(Error::Conflict.into());
    }
    if current.config.status == "archived" && body.program.status != "archived" {
        return Err(
            invalid("Archived programs cannot be reactivated; create a new program").into(),
        );
    }
    sqlx::query("UPDATE platform.marketing_notification_programs SET config=$2,version=version+1,updated_at=clock_timestamp(),updated_by=$3 WHERE id=$1")
        .bind(id).bind(DbJson(&body.program)).bind(actor).execute(&mut *tx).await?;
    crate::engagement::audit(&mut tx, Some(actor), "notifications.updated", id, json!({"version":current.version+1,"previous_status":current.config.status,"status":body.program.status})).await?;
    let result = program(&mut tx, id, "").await?;
    tx.commit().await?;
    Ok(response(StatusCode::OK, result))
}

#[derive(FromRow)]
struct CustomerContext {
    first_name: String,
    name: String,
    verified: bool,
    created_at: DateTime<Utc>,
}
fn insert_detail(context: &mut BTreeMap<String, String>, key: &str, details: &Value, field: &str) {
    if let Some(value) = details.get(field).filter(|v| !v.is_null()) {
        let value = value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string());
        // A source field may be malformed or exceptionally large. Never truncate personalization.
        if !value.trim().is_empty()
            && value.chars().count() <= 1000
            && !value.chars().any(char::is_control)
        {
            context.insert(key.to_owned(), value);
        }
    }
}
async fn evaluate(
    connection: &mut PgConnection,
    a: &App,
    p: &ProgramInput,
    id: Option<Uuid>,
    customer: Uuid,
) -> infra_auth::Result<Preview> {
    conditions::validate(&p.conditions, &p.trigger_kind)?;
    let now = Utc::now();
    let mut commerce = a.engagement_commerce.acquire().await?;
    let customer_info: CustomerContext = sqlx::query_as("SELECT first_name,COALESCE(NULLIF(trim(first_name || ' ' || last_name),''),'Customer') AS name,verified,created_at FROM customers.customers WHERE id=$1")
        .bind(customer).fetch_optional(&mut *commerce).await?.ok_or(Error::NotFound)?;
    let mut context = BTreeMap::from([("customer.id".to_owned(), customer.to_string())]);
    for (key, value) in [
        ("customer.first_name", customer_info.first_name),
        ("customer.name", customer_info.name),
    ] {
        if !value.trim().is_empty()
            && value.chars().count() <= 1000
            && !value.chars().any(char::is_control)
        {
            context.insert(key.to_owned(), value);
        }
    }
    // Reuse the authoritative customer journey CTE and select the latest matching event directly.
    // $4/$5 retain the shared query's cursor types; $6 always requires orders.read at the handler.
    let source = include_str!("customer_journey.sql")
        .split("SELECT * FROM activity")
        .next()
        .unwrap();
    let source = source.replace(
        "customers.journey_events e",
        &crate::engagement::browser_source(9),
    );
    let browser = crate::engagement::browser_page(
        &a.engagement,
        customer,
        now - Duration::days(p.lookback_days),
        now,
        None,
        None,
        Some(&p.trigger_kind),
    )
    .await?;
    let query = format!("{source} SELECT * FROM activity WHERE kind=$8 AND ($4::timestamptz IS NULL OR (occurred_at,id)<($4::timestamptz,$5::text)) ORDER BY occurred_at DESC,id DESC LIMIT $7");
    let event = sqlx::query_as::<_, crate::customer_journey::Event>(&query)
        .bind(customer)
        .bind(now - Duration::days(p.lookback_days))
        .bind(now)
        .bind(None::<DateTime<Utc>>)
        .bind(None::<String>)
        .bind(true)
        .bind(1_i64)
        .bind(&p.trigger_kind)
        .bind(browser)
        .fetch_optional(&mut *commerce)
        .await?;
    let mut reasons = Vec::new();
    if id.is_none() {
        reasons.push("Save this program before generating notifications.".to_owned());
    }
    if p.status != "active" {
        reasons.push(format!(
            "Program is {}. Activate it before generation.",
            p.status
        ));
    }
    if let Some(event) = &event {
        context.insert("event.kind".into(), event.kind.clone());
        context.insert("event.occurred_at".into(), event.occurred_at.to_rfc3339());
        insert_detail(&mut context, "product.name", &event.details, "product_name");
        for (token, field) in [
            ("order.number", "order_number"),
            ("order.status", "status"),
            ("order.total", "amount"),
            ("order.currency", "currency"),
        ] {
            insert_detail(&mut context, token, &event.details, field);
        }
        if event.occurred_at + Duration::minutes(p.delay_minutes) > now {
            reasons.push(
                "The configured delay has not elapsed since the matching journey event.".into(),
            );
        }
        if p.suppress_after_purchase {
            let purchased: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM orders.orders WHERE customer_id=$1 AND created_at > $2 AND created_at <= $3)")
                .bind(customer).bind(event.occurred_at).bind(now).fetch_one(&mut *commerce).await?;
            if purchased {
                reasons.push("A purchase was recorded after this journey event.".into());
            }
        }
        if let Some(id) = id {
            let duplicate: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform.marketing_notification_records WHERE program_id=$1 AND customer_id=$2 AND event_id=$3)")
                .bind(id).bind(customer).bind(&event.id).fetch_one(&mut *connection).await?;
            if duplicate {
                reasons.push(
                    "A notification has already been generated for this program and journey event."
                        .into(),
                );
            }
        }
    } else {
        reasons.push("No matching journey event was recorded inside the lookback window.".into());
    }
    if let Some(id) = id {
        if p.cooldown_hours > 0 {
            let cooling: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform.marketing_notification_records WHERE program_id=$1 AND customer_id=$2 AND created_at > $3)")
                .bind(id).bind(customer).bind(now - Duration::hours(p.cooldown_hours)).fetch_one(&mut *connection).await?;
            if cooling {
                reasons.push("The customer is within this program's frequency cooldown.".into());
            }
        }
    }
    let (title, mut missing) = render(&p.title_template, &context)?;
    let (body, body_missing) = render(&p.body_template, &context)?;
    missing.extend(body_missing);
    if !missing.is_empty() {
        reasons.push(
            "Required personalization values are missing from the selected journey event.".into(),
        );
    }
    if title.chars().count() > 2000 || body.chars().count() > 32000 {
        reasons.push("Rendered content exceeds the supported size; shorten the template.".into());
    }
    let mut facts = context.clone();
    facts.insert(
        "customer.verified".into(),
        customer_info.verified.to_string(),
    );
    if customer_info.created_at <= now {
        facts.insert(
            "customer.account_age_days".into(),
            now.signed_duration_since(customer_info.created_at)
                .num_days()
                .to_string(),
        );
    }
    if p.conditions
        .rules
        .iter()
        .any(|rule| rule.field == "customer.order_count")
    {
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM orders.orders WHERE customer_id=$1")
                .bind(customer)
                .fetch_one(&mut *commerce)
                .await?;
        facts.insert("customer.order_count".into(), count.to_string());
    }
    let condition_evaluation = conditions::evaluate(&p.conditions, &facts);
    if !condition_evaluation.matched {
        reasons.push(
            "Notification conditions did not match the customer and selected journey event.".into(),
        );
    }
    Ok(Preview {
        title,
        body,
        event_id: event.as_ref().map(|e| e.id.clone()),
        event_kind: event.map(|e| e.kind),
        eligible: reasons.is_empty(),
        reasons,
        missing_tokens: missing.into_iter().collect(),
        context,
        condition_match: p.conditions.mode.clone(),
        conditions_matched: condition_evaluation.matched,
        condition_results: condition_evaluation.results,
    })
}
async fn preview(
    State(a): State<App>,
    h: HeaderMap,
    body: Result<Json<PreviewInput>, JsonRejection>,
) -> ApiResult {
    let actor = authorize(&a, &h, "notifications.read", true).await?;
    let body = input(body)?;
    validate(&body.program)?;
    infra_auth::rate_limit(&a.engagement, &format!("notification-preview:{actor}"), 120).await?;
    let mut tx = a.engagement.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '3s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout = '10s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let changed = if let Some(id) = body.program_id {
        program(&mut tx, id, "").await?.config.0 != body.program
    } else {
        false
    };
    let mut result = evaluate(
        &mut tx,
        &a,
        &body.program,
        body.program_id,
        body.customer_id,
    )
    .await?;
    if changed {
        result.eligible = false;
        result
            .reasons
            .push("Save these program changes before generation.".into());
    }
    tx.commit().await?;
    Ok(response(StatusCode::OK, result))
}
const RECORD_SELECT: &str = "SELECT id,program_id,program_name,program_version,customer_id,event_id,channel,title,body,status,created_at FROM platform.marketing_notification_records";
#[derive(FromRow)]
struct RequestRecord {
    customer_id: Uuid,
    program_version: i64,
    outcome: String,
    reason: Option<String>,
    record_id: Option<Uuid>,
}
async fn generated_record(
    connection: &mut PgConnection,
    id: Uuid,
) -> infra_auth::Result<GeneratedRecord> {
    Ok(sqlx::query_as(&format!("{RECORD_SELECT} WHERE id=$1"))
        .bind(id)
        .fetch_one(connection)
        .await?)
}
async fn generate(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    body: Result<Json<GenerateInput>, JsonRejection>,
) -> ApiResult {
    let actor = authorize(&a, &h, "notifications.generate", true).await?;
    let body = input(body)?;
    if body.version < 1 || body.idempotency_key.is_nil() {
        return Err(invalid(
            "A current program version and a nonempty idempotency key are required",
        )
        .into());
    }
    infra_auth::rate_limit(
        &a.engagement,
        &format!("notification-generate:{actor}"),
        120,
    )
    .await?;
    let mut tx = a.engagement.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '3s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout = '10s'")
        .execute(&mut *tx)
        .await?;
    // Lock order is constant: request key, program, customer. Different customers can generate
    // concurrently while edits wait for in-flight generation to preserve the captured version.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,10405))")
        .bind(format!("{id}:request:{}", body.idempotency_key))
        .execute(&mut *tx)
        .await?;
    let current = program(&mut tx, id, "FOR SHARE").await?;
    let previous: Option<RequestRecord> = sqlx::query_as("SELECT customer_id,program_version,outcome,reason,record_id FROM platform.marketing_notification_requests WHERE program_id=$1 AND idempotency_key=$2")
        .bind(id).bind(body.idempotency_key).fetch_optional(&mut *tx).await?;
    if let Some(previous) = previous {
        if previous.customer_id != body.customer_id || previous.program_version != body.version {
            return Err(Error::Conflict.into());
        }
        let record = match previous.record_id {
            Some(id) => Some(generated_record(&mut tx, id).await?),
            None => None,
        };
        let outcome = if record.is_some() {
            "duplicate".into()
        } else {
            previous.outcome
        };
        tx.commit().await?;
        return Ok(response(
            StatusCode::OK,
            Generation {
                outcome,
                reason: previous
                    .reason
                    .or_else(|| Some("This generation request was already processed.".into())),
                record,
            },
        ));
    }
    if current.version != body.version {
        return Err(Error::Conflict.into());
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,10406))")
        .bind(format!("{id}:customer:{}", body.customer_id))
        .execute(&mut *tx)
        .await?;
    let evaluated = evaluate(&mut tx, &a, &current.config, Some(id), body.customer_id).await?;
    let duplicate: Option<GeneratedRecord> = if let Some(event) = &evaluated.event_id {
        sqlx::query_as(&format!(
            "{RECORD_SELECT} WHERE program_id=$1 AND customer_id=$2 AND event_id=$3"
        ))
        .bind(id)
        .bind(body.customer_id)
        .bind(event)
        .fetch_optional(&mut *tx)
        .await?
    } else {
        None
    };
    let result = if let Some(record) = duplicate {
        Generation {
            outcome: "duplicate".into(),
            reason: Some(
                "A notification already exists for this program and journey event.".into(),
            ),
            record: Some(record),
        }
    } else if !evaluated.eligible {
        Generation {
            outcome: "suppressed".into(),
            reason: Some(evaluated.reasons.join(" ")),
            record: None,
        }
    } else {
        let record_id = Uuid::new_v4();
        sqlx::query("INSERT INTO platform.marketing_notification_records(id,program_id,program_name,program_version,customer_id,event_id,channel,title,body,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
            .bind(record_id).bind(id).bind(&current.config.name).bind(current.version).bind(body.customer_id)
            .bind(&evaluated.event_id).bind(&current.config.channel).bind(evaluated.title).bind(evaluated.body).bind(actor).execute(&mut *tx).await?;
        Generation {
            outcome: "generated".into(),
            reason: None,
            record: Some(generated_record(&mut tx, record_id).await?),
        }
    };
    sqlx::query("INSERT INTO platform.marketing_notification_requests(program_id,idempotency_key,customer_id,program_version,outcome,reason,record_id) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(id).bind(body.idempotency_key).bind(body.customer_id).bind(body.version).bind(&result.outcome).bind(&result.reason).bind(result.record.as_ref().map(|r|r.id)).execute(&mut *tx).await?;
    crate::engagement::audit(&mut tx,Some(actor),&format!("notifications.{}",result.outcome),id,json!({"version":current.version,"record_id":result.record.as_ref().map(|r|r.id),"customer_id":body.customer_id,"reason":result.reason})).await?;
    tx.commit().await?;
    Ok(response(StatusCode::OK, result))
}
async fn records(State(a): State<App>, h: HeaderMap, Query(q): Query<RecordsQuery>) -> ApiResult {
    authorize(&a, &h, "notifications.read", true).await?;
    let (offset, limit) = page(q.offset, q.limit)?;
    let mut tx = a.engagement.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '3s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout = '10s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let total:i64=sqlx::query_scalar("SELECT count(*) FROM platform.marketing_notification_records WHERE ($1::uuid IS NULL OR program_id=$1)")
        .bind(q.program_id).fetch_one(&mut *tx).await?;
    let records:Vec<GeneratedRecord>=sqlx::query_as(&format!("{RECORD_SELECT} WHERE ($1::uuid IS NULL OR program_id=$1) ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3"))
        .bind(q.program_id).bind(limit).bind(offset).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(response(
        StatusCode::OK,
        json!({"records":records,"total":total}),
    ))
}
#[derive(Serialize, FromRow)]
struct AuditEvent {
    id: Uuid,
    action: String,
    actor_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    version: i64,
}
async fn audit(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<AuditQuery>,
) -> ApiResult {
    authorize(&a, &h, "notifications.read", false).await?;
    let (offset, limit) = page(q.offset, q.limit)?;
    let mut connection = a.engagement.acquire().await?;
    program(&mut connection, id, "").await?;
    let events:Vec<AuditEvent>=sqlx::query_as("SELECT id,action,actor_id,created_at,(details->>'version')::bigint AS version FROM admin_iam.audit_log WHERE entity_id=$1 AND action LIKE 'notifications.%' ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3")
        .bind(id).bind(limit).bind(offset).fetch_all(&mut *connection).await?;
    Ok(response(StatusCode::OK, json!({"events":events})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn multilingual_fields_are_counted_as_unicode_characters() {
        assert!(text_field(&"م".repeat(120), 120, false, true).is_ok());
        assert!(text_field(&"م".repeat(121), 120, false, true).is_err());
        assert!(text_field(&"🌍".repeat(8000), 8000, true, true).is_ok());
    }
    #[test]
    fn save_input_accepts_version_and_rejects_unknown_fields() {
        let mut input = json!({"name":"test","description":"","channel":"in_app","trigger_kind":"visit","title_template":"Hello","body_template":"Welcome","status":"draft","delay_minutes":0,"lookback_days":30,"cooldown_hours":24,"suppress_after_purchase":true,"version":1});
        assert!(serde_json::from_value::<SaveInput>(input.clone()).is_ok());
        input["delivery_enabled"] = json!(true);
        assert!(serde_json::from_value::<SaveInput>(input).is_err());
    }
    #[test]
    fn templates_allow_only_known_tokens_and_do_not_evaluate_customer_data() {
        for value in [
            "{{unknown}}",
            "{{ customer.name }}",
            "{{customer.name",
            "{customer.name}",
            "{{customer.name}}}",
        ] {
            assert!(render(value, &BTreeMap::new()).is_err(), "{value}");
        }
        let values = BTreeMap::from([("customer.name".into(), "{{order.total}} <script>".into())]);
        assert_eq!(
            render("Hi {{customer.name}}", &values).unwrap().0,
            "Hi {{order.total}} <script>"
        );
        assert_eq!(
            render("{{product.name}} {{product.name}}", &BTreeMap::new())
                .unwrap()
                .1
                .len(),
            1
        );
        assert!(render(&"{{customer.name}}".repeat(41), &values).is_err());
    }
    #[test]
    fn paging_is_bounded() {
        assert_eq!(page(None, None).unwrap(), (0, 25));
        for (offset, limit) in [(-1, 10), (0, 101), (0, 0), (100001, 25)] {
            assert!(page(Some(offset), Some(limit)).is_err());
        }
    }
}
