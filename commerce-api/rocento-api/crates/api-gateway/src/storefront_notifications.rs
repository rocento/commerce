//! Native customer and guest inbox. Publication is an explicit, audited admin action;
//! snapshots never enter the external notification transport queue.
use crate::identity::{self, ApiError, App};
use crate::notification_campaigns::AudienceRules;
use axum::{
    extract::{
        rejection::JsonRejection, ConnectInfo, DefaultBodyLimit, Path, Query, Request, State,
    },
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgConnection, Postgres, Transaction};
use std::net::SocketAddr;
use uuid::Uuid;

const GUEST_COOKIE: &str = "inbox_guest";
const GUEST_SECONDS: u32 = 90 * 86400;
const PUBLICATION_SELECT: &str = "SELECT id,source_record_id,customer_id,audience,area_ids,trigger_product_id,audience_rules,title,body,cta_label,cta_path,published_at,expires_at,withdrawn_at,version,created_at FROM platform.storefront_notification_publications";
// All inbox reads and writes share exactly the same active/audience predicate. $1 is
// a verified customer UUID, never a request parameter; NULL means a registered guest.
const VISIBLE: &str = "((n.trigger_product_id IS NULL AND n.audience_rules IS NULL) OR EXISTS (SELECT 1 FROM platform.storefront_notification_deliveries d WHERE d.publication_id=n.id AND d.recipient_id=$4 AND d.delivered_at<=$2)) AND (cardinality(n.area_ids)=0 OR $3::uuid=ANY(n.area_ids)) AND n.withdrawn_at IS NULL AND n.published_at <= $2 AND n.expires_at > $2 AND (($1::uuid IS NULL AND n.audience IN ('all','guests')) OR ($1::uuid IS NOT NULL AND (n.audience IN ('all','customers') OR (n.audience='customer' AND n.customer_id=$1))))";

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AnnouncementInput {
    title: String,
    body: String,
    audience: String,
    #[serde(default)]
    area_ids: Vec<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    trigger_product_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    audience_rules: Option<AudienceRules>,
    cta_label: Option<String>,
    cta_path: Option<String>,
    starts_at: Option<DateTime<Utc>>,
    expires_at: DateTime<Utc>,
    idempotency_key: Uuid,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PublishInput {
    cta_label: Option<String>,
    cta_path: Option<String>,
    starts_at: Option<DateTime<Utc>>,
    expires_at: DateTime<Utc>,
    idempotency_key: Uuid,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WithdrawInput {
    version: i64,
}
#[derive(Serialize, FromRow)]
struct Publication {
    id: Uuid,
    source_record_id: Option<Uuid>,
    customer_id: Option<Uuid>,
    audience: String,
    area_ids: Vec<Uuid>,
    trigger_product_id: Option<Uuid>,
    audience_rules: Option<sqlx::types::Json<AudienceRules>>,
    title: String,
    body: String,
    cta_label: Option<String>,
    cta_path: Option<String>,
    published_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    withdrawn_at: Option<DateTime<Utc>>,
    version: i64,
    created_at: DateTime<Utc>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AdminQuery {
    search: Option<String>,
    status: Option<String>,
    offset: Option<i64>,
    limit: Option<i64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InboxQuery {
    filter: Option<String>,
    limit: Option<i64>,
    before: Option<DateTime<Utc>>,
    before_id: Option<Uuid>,
}
#[derive(Serialize, FromRow)]
struct InboxItem {
    id: Uuid,
    title: String,
    body: String,
    kind: String,
    cta_label: Option<String>,
    cta_path: Option<String>,
    published_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    read_at: Option<DateTime<Utc>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProductViewInput {
    product: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadInput {
    read: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadAllInput {
    through: DateTime<Utc>,
}
struct Recipient {
    id: Uuid,
    customer: Option<Uuid>,
    area: Option<Uuid>,
    new_cookie: Option<String>,
}
type ApiResult = Result<Response, ApiError>;
fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn input<T>(value: Result<Json<T>, JsonRejection>) -> infra_auth::Result<T> {
    value
        .map(|v| v.0)
        .map_err(|_| invalid("Invalid storefront notification request"))
}
fn response(status: StatusCode, body: impl Serialize) -> Response {
    let mut response = (status, Json(body)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response.headers_mut().insert(
        header::VARY,
        "Cookie, Authorization, X-Delivery-Latitude, X-Delivery-Longitude"
            .parse()
            .unwrap(),
    );
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
}
fn text(value: &str, max: usize, multiline: bool) -> infra_auth::Result<()> {
    if value.trim().is_empty()
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
fn safe_path(path: &str) -> bool {
    if path.chars().count() > 300
        || !path.starts_with('/')
        || path.contains(['\\', '?', '#', '%', '.'])
    {
        return false;
    }
    if [
        "/",
        "/search",
        "/cart",
        "/support",
        "/account",
        "/account/orders",
    ]
    .contains(&path)
    {
        return true;
    }
    if let Some(id) = path.strip_prefix("/account/orders/") {
        return Uuid::parse_str(id).is_ok() && id.len() == 36;
    }
    for prefix in ["/products/", "/categories/", "/pages/"] {
        if let Some(slug) = path.strip_prefix(prefix) {
            return !slug.is_empty()
                && slug
                    .chars()
                    .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_'));
        }
    }
    false
}
fn cta(label: &Option<String>, path: &Option<String>) -> infra_auth::Result<()> {
    match (label,path) {
        (None,None)=>Ok(()),
        (Some(label),Some(path)) if safe_path(path)=>text(label,80,false),
        _=>Err(invalid("Provide both a CTA label and a supported internal storefront path, or leave both empty")),
    }
}
fn schedule(
    starts: Option<DateTime<Utc>>,
    expires: DateTime<Utc>,
    now: DateTime<Utc>,
) -> infra_auth::Result<DateTime<Utc>> {
    let starts = starts.unwrap_or(now);
    if starts < now - Duration::minutes(5)
        || starts > now + Duration::days(90)
        || expires <= now
        || expires <= starts
        || expires > starts + Duration::days(90)
    {
        return Err(invalid(
            "Start within the next 90 days and expire after the start, within 90 days of it",
        ));
    }
    Ok(starts)
}
async fn begin(a: &App) -> infra_auth::Result<Transaction<'_, Postgres>> {
    let mut tx = a.engagement.begin().await?;
    sqlx::query("SET LOCAL lock_timeout='3s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='10s'")
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}
// A snapshot waits for earlier publications to commit. Creation timestamps can then
// safely distinguish later arrivals, including deliberately backdated announcements.
async fn timeline(connection: &mut PgConnection, publish: bool) -> infra_auth::Result<()> {
    sqlx::query(if publish {
        "SELECT pg_advisory_xact_lock(1040701)"
    } else {
        "SELECT pg_advisory_xact_lock_shared(1040701)"
    })
    .execute(connection)
    .await?;
    Ok(())
}
async fn lock_recipient(connection: &mut PgConnection, id: Uuid) -> infra_auth::Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,10409))")
        .bind(id.to_string())
        .execute(connection)
        .await?;
    Ok(())
}
async fn admin(
    a: &App,
    h: &HeaderMap,
    publish: bool,
) -> infra_auth::Result<domain_admin_iam::Identity> {
    let who = crate::engagement::admin(a, identity::cookie(h, "admin_session")).await?;
    who.require("notifications.read")?;
    if publish {
        who.require("notifications.publish")?;
    }
    Ok(who)
}
fn private_access(who: &domain_admin_iam::Identity) -> infra_auth::Result<()> {
    who.require("customers.read")?;
    who.require("orders.read")
}

pub fn router(app: App) -> Router {
    Router::new()
        .route("/v1/notifications", get(inbox))
        .route(
            "/v1/admin/marketing/notifications/campaigns",
            get(campaigns).post(create_campaign),
        )
        .route(
            "/v1/admin/marketing/notifications/campaigns/{id}",
            get(get_campaign).put(save_campaign),
        )
        .route(
            "/v1/admin/marketing/notifications/campaigns/{id}/activate",
            post(activate_campaign),
        )
        .route("/v1/notifications/product-view", post(product_view))
        .route("/v1/notifications/{id}/read", put(mark_read))
        .route("/v1/notifications/read-all", post(mark_all))
        .route(
            "/v1/admin/marketing/notifications/publications",
            get(publications).post(announce),
        )
        .route(
            "/v1/admin/marketing/notifications/records/{id}/publish",
            post(publish_record),
        )
        .route(
            "/v1/admin/marketing/notifications/publications/{id}/withdraw",
            post(withdraw),
        )
        .route(
            "/v1/admin/marketing/notifications/publications/{id}",
            delete(delete_publication),
        )
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn_with_state(app.clone(), admission))
        .layer(middleware::from_fn_with_state(
            app.clone(),
            identity::policy,
        ))
        .with_state(app)
}
async fn admission(State(a): State<App>, request: Request, next: Next) -> Response {
    if request.uri().path().starts_with("/v1/notifications") {
        let source = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|peer| peer.0.ip().to_string())
            .unwrap_or_else(|| "in-process".into());
        let subject = if let Some(claims) = identity::bearer(request.headers())
            .ok()
            .and_then(|token| a.customers.security.decode(token).ok())
        {
            format!("customer:{}", claims.sub)
        } else {
            let token = identity::cookie(request.headers(), GUEST_COOKIE);
            if token.len() == 48 && token.bytes().all(|b| b.is_ascii_alphanumeric()) {
                format!("guest:{}", infra_auth::digest(token))
            } else {
                format!("new:{source}")
            }
        };
        if let Err(error) = infra_auth::admit(
            &a.engagement,
            &[
                (format!("inbox:subject:{subject}"), 600),
                (format!("inbox:source:{source}"), 3000),
                ("inbox:installation".into(), 50000),
            ],
        )
        .await
        {
            return ApiError::from(error).into_response();
        }
    }
    let mut result = next.run(request).await;
    result
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    result.headers_mut().insert(
        header::VARY,
        "Cookie, Authorization, X-Delivery-Latitude, X-Delivery-Longitude"
            .parse()
            .unwrap(),
    );
    result
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    result
}
async fn recipient(a: &App, h: &HeaderMap, issue: bool) -> Result<Recipient, ApiError> {
    let pin = crate::areas::pin(h)?;
    let area: Option<Uuid> = sqlx::query_scalar("SELECT inventory.resolve_delivery_area($1,$2)")
        .bind(pin.map(|p| p.latitude))
        .bind(pin.map(|p| p.longitude))
        .fetch_one(&a.engagement)
        .await?;
    let area = if a.engagement_isolated {
        let fresh: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform.engagement_worker_state WHERE projection_at>clock_timestamp()-interval '2 minutes')").fetch_one(&a.engagement).await?;
        if fresh {
            area
        } else {
            None
        }
    } else {
        area
    };
    if h.contains_key(header::AUTHORIZATION) {
        let customer = crate::engagement::customer(a, identity::bearer(h)?).await?;
        sqlx::query("INSERT INTO platform.storefront_notification_recipients(id,customer_id) VALUES($1,$2) ON CONFLICT(customer_id) DO NOTHING")
            .bind(Uuid::new_v4()).bind(customer).execute(&a.engagement).await?;
        let id = sqlx::query_scalar(
            "SELECT id FROM platform.storefront_notification_recipients WHERE customer_id=$1",
        )
        .bind(customer)
        .fetch_one(&a.engagement)
        .await?;
        return Ok(Recipient {
            id,
            customer: Some(customer),
            area,
            new_cookie: None,
        });
    }
    let cookie = identity::cookie(h, GUEST_COOKIE);
    if cookie.len() == 48 && cookie.bytes().all(|b| b.is_ascii_alphanumeric()) {
        let id=sqlx::query_scalar("SELECT id FROM platform.storefront_notification_recipients WHERE guest_hash=$1 AND expires_at>clock_timestamp()")
            .bind(infra_auth::digest(cookie)).fetch_optional(&a.engagement).await?;
        if let Some(id) = id {
            return Ok(Recipient {
                id,
                customer: None,
                area,
                new_cookie: None,
            });
        }
    }
    if !issue {
        return Err(Error::Unauthorized.into());
    }
    // A request-supplied random value is never adopted as a new guest identity.
    let token = infra_auth::token();
    let id = Uuid::new_v4();
    let mut tx = begin(a).await?;
    sqlx::query("DELETE FROM platform.storefront_notification_recipients WHERE id IN (SELECT id FROM platform.storefront_notification_recipients WHERE guest_hash IS NOT NULL AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100)").execute(&mut *tx).await?;
    sqlx::query("INSERT INTO platform.storefront_notification_recipients(id,guest_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '90 days')")
        .bind(id).bind(infra_auth::digest(&token)).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Recipient {
        id,
        customer: None,
        area,
        new_cookie: Some(token),
    })
}
async fn unread(
    connection: &mut PgConnection,
    r: &Recipient,
    now: DateTime<Utc>,
) -> infra_auth::Result<i64> {
    Ok(sqlx::query_scalar(&format!("SELECT count(*) FROM platform.storefront_notification_publications n LEFT JOIN platform.storefront_notification_read_states s ON s.publication_id=n.id AND s.recipient_id=$4 WHERE {VISIBLE} AND s.read_at IS NULL"))
        .bind(r.customer).bind(now).bind(r.area).bind(r.id).fetch_one(connection).await?)
}
async fn inbox(State(a): State<App>, h: HeaderMap, Query(q): Query<InboxQuery>) -> ApiResult {
    let filter = q.filter.as_deref().unwrap_or("all");
    let limit = q.limit.unwrap_or(20);
    if !["all", "unread"].contains(&filter)
        || !(1..=50).contains(&limit)
        || q.before.is_some() != q.before_id.is_some()
    {
        return Err(invalid(
            "Use all or unread, a limit from 1 to 50, and a complete pagination cursor",
        )
        .into());
    }
    let r = recipient(&a, &h, true).await?;
    crate::notification_campaigns::touch(&a, r.id, r.area).await?;
    let mut tx = begin(&a).await?;
    // READ COMMITTED is deliberate: a repeatable-read snapshot established by the
    // advisory-lock statement could omit the transaction we just waited to commit.
    sqlx::query("SET TRANSACTION READ ONLY")
        .execute(&mut *tx)
        .await?;
    timeline(&mut tx, false).await?;
    lock_recipient(&mut tx, r.id).await?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    let count = unread(&mut tx, &r, now).await?;
    let mut items:Vec<InboxItem>=sqlx::query_as(&format!("SELECT n.id,n.title,n.body,CASE WHEN n.source_record_id IS NULL AND n.trigger_product_id IS NULL AND n.audience_rules IS NULL THEN 'announcement' ELSE 'journey' END AS kind,n.cta_label,n.cta_path,COALESCE(d.delivered_at,n.published_at) AS published_at,n.expires_at,s.read_at FROM platform.storefront_notification_publications n LEFT JOIN platform.storefront_notification_read_states s ON s.publication_id=n.id AND s.recipient_id=$4 LEFT JOIN platform.storefront_notification_deliveries d ON d.publication_id=n.id AND d.recipient_id=$4 WHERE {VISIBLE} AND ($5='all' OR s.read_at IS NULL) AND ($6::timestamptz IS NULL OR (COALESCE(d.delivered_at,n.published_at),n.id)<($6,$7::uuid)) ORDER BY COALESCE(d.delivered_at,n.published_at) DESC,n.id DESC LIMIT $8"))
        .bind(r.customer).bind(now).bind(r.area).bind(r.id).bind(filter).bind(q.before).bind(q.before_id).bind(limit+1).fetch_all(&mut *tx).await?;
    let next = if items.len() > limit as usize {
        items.truncate(limit as usize);
        items
            .last()
            .map(|item| json!({"before":item.published_at,"before_id":item.id}))
    } else {
        None
    };
    tx.commit().await?;
    let mut result = response(
        StatusCode::OK,
        json!({"items":items,"unread_count":count,"snapshot_at":now,"next_cursor":next,"audience":if r.customer.is_some(){"customer"}else{"guest"}}),
    );
    if let Some(cookie) = r.new_cookie {
        result.headers_mut().insert(
            header::SET_COOKIE,
            identity::session_cookie(GUEST_COOKIE, &cookie, GUEST_SECONDS, &a.customers.security)
                .parse()
                .unwrap(),
        );
    }
    Ok(result)
}
// A visit grants this immutable campaign only to the resolved inbox identity.
// Unique grants make repeat visits and concurrent/retried requests harmless.
async fn product_view(
    State(a): State<App>,
    h: HeaderMap,
    body: Result<Json<ProductViewInput>, JsonRejection>,
) -> ApiResult {
    let body = input(body)?;
    if body.product.is_empty()
        || body.product.len() > 300
        || !body
            .product
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err(invalid("Provide a product ID or slug").into());
    }
    // The initial list establishes the guest cookie. Never accept recipient IDs
    // from callers, and never downgrade invalid customer credentials to guests.
    let r = recipient(&a, &h, false).await?;
    if a.engagement_isolated {
        let key = format!(
            "visit:{}:{}:{}",
            r.id,
            body.product,
            Utc::now().timestamp() / 60
        );
        let id = crate::engagement::enqueue(
            &a.engagement,
            key,
            "product_view",
            json!({"recipient":r.id,"area":r.area,"product":body.product}),
        )
        .await?;
        return Ok(response(
            StatusCode::ACCEPTED,
            json!({"queued":true,"event_id":id,"delivered":0,"notification_ids":[]}),
        ));
    }
    crate::notification_campaigns::record_event(
        &a.engagement,
        r.id,
        "product_view",
        &body.product,
        Uuid::new_v4(),
        Utc::now(),
    )
    .await?;
    crate::notification_campaigns::touch(&a, r.id, r.area).await?;
    let mut tx = begin(&a).await?;
    timeline(&mut tx, false).await?;
    lock_recipient(&mut tx, r.id).await?;
    let product: Option<Uuid> = sqlx::query_scalar("SELECT id FROM catalog.products WHERE active AND (id=$1 OR slug=$2) ORDER BY (id=$1) DESC NULLS LAST LIMIT 1 FOR SHARE")
        .bind(Uuid::parse_str(&body.product).ok()).bind(&body.product).fetch_optional(&mut *tx).await?;
    let product = product.ok_or(Error::NotFound)?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    let ids: Vec<Uuid> = sqlx::query_scalar("INSERT INTO platform.storefront_notification_deliveries(recipient_id,publication_id,delivered_at) SELECT $1,n.id,$2 FROM platform.storefront_notification_publications n WHERE n.trigger_product_id=$3 AND n.audience_rules IS NULL AND n.withdrawn_at IS NULL AND n.published_at<=$2 AND n.expires_at>$2 AND (cardinality(n.area_ids)=0 OR $4::uuid=ANY(n.area_ids)) AND (($5::uuid IS NULL AND n.audience IN ('all','guests')) OR ($5::uuid IS NOT NULL AND n.audience IN ('all','customers'))) ON CONFLICT(recipient_id,publication_id) DO NOTHING RETURNING publication_id")
        .bind(r.id).bind(now).bind(product).bind(r.area).bind(r.customer).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(response(
        StatusCode::OK,
        json!({"delivered":ids.len(),"notification_ids":ids}),
    ))
}
async fn mark_read(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    body: Result<Json<ReadInput>, JsonRejection>,
) -> ApiResult {
    let body = input(body)?;
    let r = recipient(&a, &h, false).await?;
    let mut tx = begin(&a).await?;
    timeline(&mut tx, false).await?;
    lock_recipient(&mut tx, r.id).await?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    let visible:Option<Uuid>=sqlx::query_scalar(&format!("SELECT n.id FROM platform.storefront_notification_publications n WHERE {VISIBLE} AND n.id=$5 FOR SHARE"))
        .bind(r.customer).bind(now).bind(r.area).bind(r.id).bind(id).fetch_optional(&mut *tx).await?;
    if visible.is_none() {
        return Err(Error::NotFound.into());
    }
    let read_at = if body.read { Some(now) } else { None };
    let persisted:Option<DateTime<Utc>>=sqlx::query_scalar("INSERT INTO platform.storefront_notification_read_states(recipient_id,publication_id,read_at) VALUES($1,$2,$3) ON CONFLICT(recipient_id,publication_id) DO UPDATE SET read_at=CASE WHEN EXCLUDED.read_at IS NULL THEN NULL ELSE COALESCE(platform.storefront_notification_read_states.read_at,EXCLUDED.read_at) END RETURNING read_at")
        .bind(r.id).bind(id).bind(read_at).fetch_one(&mut *tx).await?;
    let count = unread(&mut tx, &r, now).await?;
    tx.commit().await?;
    Ok(response(
        StatusCode::OK,
        json!({"id":id,"read_at":persisted,"unread_count":count}),
    ))
}
async fn mark_all(
    State(a): State<App>,
    h: HeaderMap,
    body: Result<Json<ReadAllInput>, JsonRejection>,
) -> ApiResult {
    let body = input(body)?;
    let r = recipient(&a, &h, false).await?;
    let mut tx = begin(&a).await?;
    timeline(&mut tx, false).await?;
    lock_recipient(&mut tx, r.id).await?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    if body.through > now {
        return Err(invalid("The mark-all cutoff cannot be in the future").into());
    }
    let updated=sqlx::query(&format!("INSERT INTO platform.storefront_notification_read_states(recipient_id,publication_id,read_at) SELECT $4,n.id,$2 FROM platform.storefront_notification_publications n LEFT JOIN platform.storefront_notification_read_states s ON s.publication_id=n.id AND s.recipient_id=$4 WHERE {VISIBLE} AND n.published_at <= $5 AND n.created_at <= $5 AND ((n.trigger_product_id IS NULL AND n.audience_rules IS NULL) OR EXISTS (SELECT 1 FROM platform.storefront_notification_deliveries d WHERE d.publication_id=n.id AND d.recipient_id=$4 AND d.delivered_at <= $5)) AND s.read_at IS NULL ON CONFLICT(recipient_id,publication_id) DO UPDATE SET read_at=EXCLUDED.read_at WHERE platform.storefront_notification_read_states.read_at IS NULL"))
        .bind(r.customer).bind(now).bind(r.area).bind(r.id).bind(body.through).execute(&mut *tx).await?.rows_affected();
    let count = unread(&mut tx, &r, now).await?;
    tx.commit().await?;
    Ok(response(
        StatusCode::OK,
        json!({"updated":updated,"unread_count":count}),
    ))
}
async fn publication(
    connection: &mut PgConnection,
    id: Uuid,
    lock: bool,
) -> infra_auth::Result<Publication> {
    sqlx::query_as(&format!(
        "{PUBLICATION_SELECT} WHERE id=$1 {}",
        if lock { "FOR UPDATE" } else { "" }
    ))
    .bind(id)
    .fetch_optional(connection)
    .await?
    .ok_or(Error::NotFound)
}
async fn publications(
    State(a): State<App>,
    h: HeaderMap,
    Query(q): Query<AdminQuery>,
) -> ApiResult {
    let who = admin(&a, &h, false).await?;
    let private = private_access(&who).is_ok();
    let limit = q.limit.unwrap_or(25);
    let offset = q.offset.unwrap_or(0);
    if !(1..=100).contains(&limit) || !(0..=100000).contains(&offset) {
        return Err(invalid("Use a limit from 1 to 100 and an offset from 0 to 100000").into());
    }
    let mut tx = begin(&a).await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let search = q.search.unwrap_or_default().trim().to_owned();
    let status = q.status.unwrap_or_else(|| "all".to_owned());
    if search.chars().count() > 200
        || !["all", "live", "scheduled", "expired", "withdrawn"].contains(&status.as_str())
    {
        return Err(invalid("Use a valid status and a search of at most 200 characters").into());
    }
    let predicate = "deleted_at IS NULL AND ($1 OR (audience<>'customer' AND NOT (audience='customers' AND audience_rules IS NOT NULL))) AND ($2='' OR strpos(lower(title || ' ' || body),lower($2))>0) AND ($3='all' OR ($3='withdrawn' AND withdrawn_at IS NOT NULL) OR (withdrawn_at IS NULL AND (($3='expired' AND expires_at<=now()) OR ($3='scheduled' AND published_at>now() AND expires_at>now()) OR ($3='live' AND published_at<=now() AND expires_at>now()))))";
    let total: i64 = sqlx::query_scalar(&format!(
        "SELECT count(*) FROM platform.storefront_notification_publications WHERE {predicate}"
    ))
    .bind(private)
    .bind(&search)
    .bind(&status)
    .fetch_one(&mut *tx)
    .await?;
    let publications: Vec<Publication> = sqlx::query_as(&format!("{PUBLICATION_SELECT} WHERE {predicate} ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5"))
        .bind(private).bind(&search).bind(&status).bind(limit).bind(offset).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(response(
        StatusCode::OK,
        json!({"publications":publications,"total":total}),
    ))
}
fn request_hash(value: Value, source: Option<Uuid>) -> String {
    let mut value = value;
    value.as_object_mut().unwrap().remove("idempotency_key");
    infra_auth::digest(&json!({"source_record_id":source,"input":value}).to_string())
}
async fn replay(
    tx: &mut Transaction<'_, Postgres>,
    actor: Uuid,
    key: Uuid,
    hash: &str,
) -> infra_auth::Result<Option<Publication>> {
    if key.is_nil() {
        return Err(invalid("A nonempty idempotency key is required"));
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,10407))")
        .bind(format!("{actor}:{key}"))
        .execute(&mut **tx)
        .await?;
    let previous:Option<(Uuid,String)>=sqlx::query_as("SELECT publication_id,request_hash FROM platform.storefront_notification_publish_requests WHERE actor_id=$1 AND idempotency_key=$2").bind(actor).bind(key).fetch_optional(&mut **tx).await?;
    match previous {
        Some((id, previous)) if previous == hash => Ok(Some(publication(tx, id, false).await?)),
        Some(_) => Err(Error::Conflict),
        None => Ok(None),
    }
}
async fn remember(
    tx: &mut Transaction<'_, Postgres>,
    actor: Uuid,
    key: Uuid,
    hash: &str,
    id: Uuid,
) -> infra_auth::Result<()> {
    sqlx::query("INSERT INTO platform.storefront_notification_publish_requests(actor_id,idempotency_key,request_hash,publication_id) VALUES($1,$2,$3,$4)")
        .bind(actor).bind(key).bind(hash).bind(id).execute(&mut **tx).await?;
    Ok(())
}
async fn announce(
    State(a): State<App>,
    h: HeaderMap,
    body: Result<Json<AnnouncementInput>, JsonRejection>,
) -> ApiResult {
    let who = admin(&a, &h, true).await?;
    let body = input(body)?;
    let mut tx = begin(&a).await?;
    let (status, result) = publish_announcement(&a, &who, body, &mut tx).await?;
    tx.commit().await?;
    Ok(response(status, result))
}
async fn publish_announcement(
    a: &App,
    who: &domain_admin_iam::Identity,
    body: AnnouncementInput,
    tx: &mut Transaction<'_, Postgres>,
) -> infra_auth::Result<(StatusCode, Publication)> {
    text(&body.title, 200, false)?;
    text(&body.body, 8000, true)?;
    cta(&body.cta_label, &body.cta_path)?;
    if !["all", "guests", "customers"].contains(&body.audience.as_str())
        || body.title.contains(['{', '}'])
        || body.body.contains(['{', '}'])
    {
        return Err(invalid("Announcements use plain text without dynamic placeholders and target all, guests, or customers"));
    }
    infra_auth::rate_limit(
        &a.engagement,
        &format!("inbox-publish:{}", who.user.id),
        120,
    )
    .await?;
    if body.audience_rules.is_some() && body.audience == "customers" {
        private_access(who)?;
    }
    let hash = request_hash(
        serde_json::to_value(&body).map_err(|_| Error::Internal)?,
        None,
    );
    if let Some(result) = replay(tx, who.user.id, body.idempotency_key, &hash).await? {
        return Ok((StatusCode::OK, result));
    }
    if let Some(rules) = &body.audience_rules {
        rules.validate(&body.audience, body.trigger_product_id)?;
        if body.audience == "customers" {
            private_access(who)?;
        }
        rules.validate_segments(&a.engagement_commerce).await?;
    }
    if body.area_ids.len() > 100 {
        return Err(invalid("Choose at most 100 delivery areas"));
    }
    let valid_areas: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM inventory.delivery_areas WHERE is_active AND id=ANY($1)",
    )
    .bind(&body.area_ids)
    .fetch_one(&a.engagement_commerce)
    .await?;
    if valid_areas as usize != body.area_ids.len() {
        return Err(invalid("Choose distinct, active delivery areas"));
    }
    if let Some(product) = body.trigger_product_id {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM catalog.products WHERE id=$1 AND active)",
        )
        .bind(product)
        .fetch_one(&a.engagement_commerce)
        .await?;
        if !exists {
            return Err(invalid("Choose an active product for the visit trigger"));
        }
    }
    timeline(tx, true).await?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut **tx)
        .await?;
    let starts = schedule(body.starts_at, body.expires_at, now)?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO platform.storefront_notification_publications(id,audience,title,body,cta_label,cta_path,published_at,expires_at,created_by,request_hash,area_ids,trigger_product_id,audience_rules) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)")
        .bind(id).bind(&body.audience).bind(body.title).bind(body.body).bind(body.cta_label).bind(body.cta_path).bind(starts).bind(body.expires_at).bind(who.user.id).bind(&hash).bind(&body.area_ids).bind(body.trigger_product_id).bind(body.audience_rules.as_ref().map(sqlx::types::Json)).execute(&mut **tx).await?;
    remember(tx, who.user.id, body.idempotency_key, &hash, id).await?;
    crate::engagement::audit(
        tx,
        Some(who.user.id),
        "notifications.published",
        id,
        json!({"version":1,"audience":body.audience,"area_ids":body.area_ids,"trigger_product_id":body.trigger_product_id}),
    )
    .await?;
    let result = publication(tx, id, false).await?;
    Ok((StatusCode::CREATED, result))
}
#[derive(FromRow)]
struct Source {
    customer_id: Uuid,
    channel: String,
    title: String,
    body: String,
}
async fn publish_record(
    State(a): State<App>,
    h: HeaderMap,
    Path(source): Path<Uuid>,
    body: Result<Json<PublishInput>, JsonRejection>,
) -> ApiResult {
    let who = admin(&a, &h, true).await?;
    private_access(&who)?;
    let body = input(body)?;
    cta(&body.cta_label, &body.cta_path)?;
    infra_auth::rate_limit(
        &a.engagement,
        &format!("inbox-publish:{}", who.user.id),
        120,
    )
    .await?;
    let hash = request_hash(
        serde_json::to_value(&body).map_err(|_| Error::Internal)?,
        Some(source),
    );
    let mut tx = begin(&a).await?;
    if let Some(result) = replay(&mut tx, who.user.id, body.idempotency_key, &hash).await? {
        tx.commit().await?;
        return Ok(response(StatusCode::OK, result));
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,10408))")
        .bind(source.to_string())
        .execute(&mut *tx)
        .await?;
    let existing:Option<(Uuid,String)>=sqlx::query_as("SELECT id,request_hash FROM platform.storefront_notification_publications WHERE source_record_id=$1").bind(source).fetch_optional(&mut *tx).await?;
    if let Some((id, previous)) = existing {
        if previous != hash {
            return Err(Error::Conflict.into());
        }
        remember(&mut tx, who.user.id, body.idempotency_key, &hash, id).await?;
        let result = publication(&mut tx, id, false).await?;
        tx.commit().await?;
        return Ok(response(StatusCode::OK, result));
    }
    let record:Source=sqlx::query_as("SELECT customer_id,channel,title,body FROM platform.marketing_notification_records WHERE id=$1 FOR SHARE")
        .bind(source).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    if record.channel != "in_app" {
        return Err(invalid(
            "Only generated in-app records can be published to the storefront inbox",
        )
        .into());
    }
    timeline(&mut tx, true).await?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    let starts = schedule(body.starts_at, body.expires_at, now)?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO platform.storefront_notification_publications(id,source_record_id,customer_id,audience,title,body,cta_label,cta_path,published_at,expires_at,created_by,request_hash) VALUES($1,$2,$3,'customer',$4,$5,$6,$7,$8,$9,$10,$11)")
        .bind(id).bind(source).bind(record.customer_id).bind(record.title).bind(record.body).bind(body.cta_label).bind(body.cta_path).bind(starts).bind(body.expires_at).bind(who.user.id).bind(&hash).execute(&mut *tx).await?;
    remember(&mut tx, who.user.id, body.idempotency_key, &hash, id).await?;
    crate::engagement::audit(
        &mut tx,
        Some(who.user.id),
        "notifications.published",
        id,
        json!({"version":1,"audience":"customer","source_record_id":source}),
    )
    .await?;
    let result = publication(&mut tx, id, false).await?;
    tx.commit().await?;
    Ok(response(StatusCode::CREATED, result))
}
async fn withdraw(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    body: Result<Json<WithdrawInput>, JsonRejection>,
) -> ApiResult {
    let who = admin(&a, &h, true).await?;
    let body = input(body)?;
    if body.version < 1 {
        return Err(invalid("A current publication version is required").into());
    }
    infra_auth::rate_limit(
        &a.engagement,
        &format!("inbox-publish:{}", who.user.id),
        120,
    )
    .await?;
    let mut tx = begin(&a).await?;
    timeline(&mut tx, true).await?;
    let current = publication(&mut tx, id, true).await?;
    if current.customer_id.is_some()
        || (current.audience == "customers" && current.audience_rules.is_some())
    {
        private_access(&who)?;
    }
    if current.version != body.version {
        return Err(Error::Conflict.into());
    }
    if current.withdrawn_at.is_some() {
        tx.commit().await?;
        return Ok(response(StatusCode::OK, current));
    }
    sqlx::query("UPDATE platform.storefront_notification_publications SET withdrawn_at=clock_timestamp(),withdrawn_by=$2,version=version+1 WHERE id=$1")
        .bind(id).bind(who.user.id).execute(&mut *tx).await?;
    crate::engagement::audit(
        &mut tx,
        Some(who.user.id),
        "notifications.withdrawn",
        id,
        json!({"version":current.version+1,"audience":current.audience}),
    )
    .await?;
    let result = publication(&mut tx, id, false).await?;
    tx.commit().await?;
    Ok(response(StatusCode::OK, result))
}

async fn delete_publication(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    body: Result<Json<WithdrawInput>, JsonRejection>,
) -> ApiResult {
    let who = admin(&a, &h, true).await?;
    let body = input(body)?;
    if body.version < 1 {
        return Err(invalid("A current publication version is required").into());
    }
    infra_auth::rate_limit(
        &a.engagement,
        &format!("inbox-publish:{}", who.user.id),
        120,
    )
    .await?;
    let mut tx = begin(&a).await?;
    timeline(&mut tx, true).await?;
    let current = publication(&mut tx, id, true).await?;
    if current.customer_id.is_some()
        || (current.audience == "customers" && current.audience_rules.is_some())
    {
        private_access(&who)?;
    }
    let deleted: bool = sqlx::query_scalar("SELECT deleted_at IS NOT NULL FROM platform.storefront_notification_publications WHERE id=$1").bind(id).fetch_one(&mut *tx).await?;
    if !deleted {
        if current.version != body.version {
            return Err(Error::Conflict.into());
        }
        sqlx::query("UPDATE platform.storefront_notification_publications SET deleted_at=clock_timestamp(),withdrawn_at=COALESCE(withdrawn_at,clock_timestamp()),withdrawn_by=COALESCE(withdrawn_by,$2),version=version+1 WHERE id=$1")
            .bind(id).bind(who.user.id).execute(&mut *tx).await?;
        crate::engagement::audit(
            &mut tx,
            Some(who.user.id),
            "notifications.deleted",
            id,
            json!({"version":current.version+1,"audience":current.audience}),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(response(StatusCode::OK, json!({"id":id,"deleted":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cta_routes_are_explicit_and_never_external_or_encoded() {
        for path in [
            "/",
            "/products/organic-apple",
            "/products/تفاح",
            "/categories/fruit",
            "/pages/privacy",
            "/support",
            "/account/orders/550e8400-e29b-41d4-a716-446655440000",
        ] {
            assert!(safe_path(path), "{path}");
        }
        for path in [
            "//evil.example",
            "https://evil.example",
            "javascript:alert(1)",
            "/\\evil.example",
            "/products/%2e%2e",
            "/products/../account",
            "/account?next=https://evil.example",
            "/orders",
            "/admin",
            "/pages/",
            "/products",
            "/categories",
        ] {
            assert!(!safe_path(path), "{path}");
        }
    }
    #[test]
    fn schedules_are_bounded_and_unicode_text_uses_characters() {
        let now = Utc::now();
        assert!(schedule(None, now + Duration::days(90), now).is_ok());
        assert!(schedule(None, now + Duration::days(91), now).is_err());
        assert!(schedule(
            Some(now + Duration::days(91)),
            now + Duration::days(92),
            now
        )
        .is_err());
        assert!(text(&"م".repeat(200), 200, false).is_ok());
        assert!(text(&"م".repeat(201), 200, false).is_err());
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CampaignInput {
    name: String,
    description: String,
    announcement: Value,
    version: i64,
}
#[derive(Serialize, FromRow)]
struct Campaign {
    id: Uuid,
    name: String,
    description: String,
    announcement: Value,
    version: i64,
    status: String,
    publication_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ActivateCampaign {
    version: i64,
    idempotency_key: Uuid,
}
const CAMPAIGN_SELECT: &str = "SELECT id,name,description,announcement,version,CASE WHEN publication_id IS NULL THEN 'draft' ELSE 'published' END AS status,publication_id,created_at,updated_at FROM platform.notification_campaigns";
fn draft_announcement(value: &Value, key: Uuid) -> infra_auth::Result<AnnouncementInput> {
    let mut value = value.clone();
    let object = value
        .as_object_mut()
        .ok_or_else(|| invalid("Provide a campaign announcement"))?;
    if object.contains_key("idempotency_key") {
        return Err(invalid("Draft content must not contain an idempotency key"));
    }
    object.insert("idempotency_key".into(), json!(key));
    serde_json::from_value(value).map_err(|_| invalid("Invalid campaign announcement"))
}
fn campaign_private(announcement: &Value) -> bool {
    announcement
        .get("audience_rules")
        .is_some_and(|rules| !rules.is_null())
        && announcement["audience"] == "customers"
}
async fn validate_draft(
    a: &App,
    who: &domain_admin_iam::Identity,
    body: &CampaignInput,
) -> infra_auth::Result<()> {
    text(&body.name, 200, false)?;
    if body.description.chars().count() > 2000
        || body
            .description
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
    {
        return Err(invalid("Description supports up to 2000 characters"));
    }
    let announcement = draft_announcement(&body.announcement, Uuid::new_v4())?;
    text(&announcement.title, 200, false)?;
    text(&announcement.body, 8000, true)?;
    cta(&announcement.cta_label, &announcement.cta_path)?;
    if !["all", "guests", "customers"].contains(&announcement.audience.as_str())
        || announcement.title.contains(['{', '}'])
        || announcement.body.contains(['{', '}'])
    {
        return Err(invalid(
            "Campaigns use plain text and target everyone, guests, or signed-in customers",
        ));
    }
    schedule(announcement.starts_at, announcement.expires_at, Utc::now())?;
    if announcement.area_ids.len() > 100 {
        return Err(invalid("Choose at most 100 delivery areas"));
    }
    let valid_areas: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM inventory.delivery_areas WHERE is_active AND id=ANY($1)",
    )
    .bind(&announcement.area_ids)
    .fetch_one(&a.engagement_commerce)
    .await?;
    if valid_areas as usize != announcement.area_ids.len() {
        return Err(invalid("Choose distinct, active delivery areas"));
    }
    if let Some(product) = announcement.trigger_product_id {
        let active: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM catalog.products WHERE id=$1 AND active)",
        )
        .bind(product)
        .fetch_one(&a.engagement_commerce)
        .await?;
        if !active {
            return Err(invalid("Choose an active product"));
        }
    }
    if let Some(rules) = &announcement.audience_rules {
        rules.validate(&announcement.audience, announcement.trigger_product_id)?;
        if announcement.audience == "customers" {
            private_access(who)?;
        }
        rules.validate_segments(&a.engagement_commerce).await?;
    }
    Ok(())
}
async fn campaign(
    connection: &mut PgConnection,
    id: Uuid,
    lock: bool,
) -> infra_auth::Result<Campaign> {
    sqlx::query_as(&format!(
        "{CAMPAIGN_SELECT} WHERE id=$1{}",
        if lock { " FOR UPDATE" } else { "" }
    ))
    .bind(id)
    .fetch_optional(connection)
    .await?
    .ok_or(Error::NotFound)
}
async fn campaigns(State(a): State<App>, h: HeaderMap, Query(q): Query<AdminQuery>) -> ApiResult {
    let who = admin(&a, &h, false).await?;
    let offset = q.offset.unwrap_or(0);
    let limit = q.limit.unwrap_or(20);
    if !(0..=1_000_000).contains(&offset)
        || !(1..=100).contains(&limit)
        || q.status
            .as_ref()
            .is_some_and(|s| !["all", "draft", "published"].contains(&s.as_str()))
        || q.search.as_ref().is_some_and(|s| s.chars().count() > 200)
    {
        return Err(invalid("Choose a valid campaign status and page").into());
    }
    let private = private_access(&who).is_ok();
    let predicate="($1::boolean OR NOT (announcement->>'audience'='customers' AND announcement->'audience_rules' IS NOT NULL AND announcement->'audience_rules'<>'null'::jsonb)) AND ($2::text IS NULL OR name ILIKE '%'||$2||'%') AND ($3::text IS NULL OR $3='all' OR CASE WHEN publication_id IS NULL THEN 'draft' ELSE 'published' END=$3)";
    let count: i64 = sqlx::query_scalar(&format!(
        "SELECT count(*) FROM platform.notification_campaigns WHERE {predicate}"
    ))
    .bind(private)
    .bind(&q.search)
    .bind(&q.status)
    .fetch_one(&a.engagement)
    .await?;
    let items: Vec<Campaign> = sqlx::query_as(&format!(
        "{CAMPAIGN_SELECT} WHERE {predicate} ORDER BY updated_at DESC,id LIMIT $4 OFFSET $5"
    ))
    .bind(private)
    .bind(q.search)
    .bind(q.status)
    .bind(limit)
    .bind(offset)
    .fetch_all(&a.engagement)
    .await?;
    Ok(response(
        StatusCode::OK,
        json!({"items":items,"total":count,"offset":offset,"limit":limit}),
    ))
}
async fn get_campaign(State(a): State<App>, h: HeaderMap, Path(id): Path<Uuid>) -> ApiResult {
    let who = admin(&a, &h, false).await?;
    let row = campaign(&mut *a.engagement.acquire().await?, id, false).await?;
    if campaign_private(&row.announcement) {
        private_access(&who)?;
    }
    Ok(response(StatusCode::OK, row))
}
async fn create_campaign(
    State(a): State<App>,
    h: HeaderMap,
    body: Result<Json<CampaignInput>, JsonRejection>,
) -> ApiResult {
    let who = admin(&a, &h, false).await?;
    who.require("notifications.write")?;
    let body = input(body)?;
    if body.version != 0 {
        return Err(invalid("New campaign drafts require version 0").into());
    }
    validate_draft(&a, &who, &body).await?;
    infra_auth::rate_limit(
        &a.engagement,
        &format!("campaign-write:{}", who.user.id),
        120,
    )
    .await?;
    let mut tx = begin(&a).await?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO platform.notification_campaigns(id,name,description,announcement,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5)").bind(id).bind(body.name).bind(body.description).bind(body.announcement).bind(who.user.id).execute(&mut *tx).await?;
    crate::engagement::audit(
        &mut tx,
        Some(who.user.id),
        "notifications.campaign_created",
        id,
        json!({"version":1}),
    )
    .await?;
    let result = campaign(&mut tx, id, false).await?;
    tx.commit().await?;
    Ok(response(StatusCode::CREATED, result))
}
async fn save_campaign(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    body: Result<Json<CampaignInput>, JsonRejection>,
) -> ApiResult {
    let who = admin(&a, &h, false).await?;
    who.require("notifications.write")?;
    let body = input(body)?;
    validate_draft(&a, &who, &body).await?;
    let mut tx = begin(&a).await?;
    let previous = campaign(&mut tx, id, true).await?;
    if campaign_private(&previous.announcement) {
        private_access(&who)?;
    }
    if previous.version != body.version || previous.publication_id.is_some() {
        return Err(Error::Conflict.into());
    }
    sqlx::query("UPDATE platform.notification_campaigns SET name=$2,description=$3,announcement=$4,version=version+1,updated_by=$5,updated_at=clock_timestamp() WHERE id=$1").bind(id).bind(body.name).bind(body.description).bind(body.announcement).bind(who.user.id).execute(&mut *tx).await?;
    crate::engagement::audit(
        &mut tx,
        Some(who.user.id),
        "notifications.campaign_saved",
        id,
        json!({"version":body.version+1}),
    )
    .await?;
    let result = campaign(&mut tx, id, false).await?;
    tx.commit().await?;
    Ok(response(StatusCode::OK, result))
}
async fn activate_campaign(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    body: Result<Json<ActivateCampaign>, JsonRejection>,
) -> ApiResult {
    let who = admin(&a, &h, true).await?;
    let body = input(body)?;
    if body.version < 1 || body.idempotency_key.is_nil() {
        return Err(invalid("A current version and idempotency key are required").into());
    }
    let mut tx = begin(&a).await?;
    let draft = campaign(&mut tx, id, true).await?;
    if campaign_private(&draft.announcement) {
        private_access(&who)?;
    }
    let announcement = draft_announcement(&draft.announcement, body.idempotency_key)?;
    if let Some(published) = draft.publication_id {
        let hash = request_hash(
            serde_json::to_value(&announcement).map_err(|_| Error::Internal)?,
            None,
        );
        if draft.version != body.version + 1 {
            return Err(Error::Conflict.into());
        }
        let replayed = replay(&mut tx, who.user.id, body.idempotency_key, &hash)
            .await?
            .filter(|p| p.id == published)
            .ok_or(Error::Conflict)?;
        tx.commit().await?;
        return Ok(response(StatusCode::OK, replayed));
    }
    if draft.version != body.version {
        return Err(Error::Conflict.into());
    }
    let (status, published) = publish_announcement(&a, &who, announcement, &mut tx).await?;
    let linked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform.notification_campaigns WHERE publication_id=$1 AND id<>$2)").bind(published.id).bind(id).fetch_one(&mut *tx).await?;
    if linked {
        return Err(Error::Conflict.into());
    }
    sqlx::query("UPDATE platform.notification_campaigns SET publication_id=$2,version=version+1,updated_by=$3,updated_at=clock_timestamp() WHERE id=$1").bind(id).bind(published.id).bind(who.user.id).execute(&mut *tx).await?;
    crate::engagement::audit(
        &mut tx,
        Some(who.user.id),
        "notifications.campaign_activated",
        id,
        json!({"version":body.version+1,"publication_id":published.id}),
    )
    .await?;
    tx.commit().await?;
    Ok(response(status, published))
}
