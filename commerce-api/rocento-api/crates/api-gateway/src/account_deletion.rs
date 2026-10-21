//! Privacy transport and durable cross-store erasure orchestration.
use crate::{
    analytics, assistant,
    identity::{self, ApiError, App},
};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::HeaderMap,
    middleware,
    routing::{get, post},
    Json, Router,
};
use domain_customers::deletion;
use infra_auth::{Error, Result};
use uuid::Uuid;
pub fn router(app: App) -> Router {
    Router::new()
        .route("/v1/customer/deletion-policy", get(customer_policy))
        .route("/v1/customer/account-deletion", post(request))
        .route("/v1/customer/account-deletion/status", post(status))
        .route(
            "/v1/admin/customer-retention",
            get(admin_policy).put(configure),
        )
        .route("/v1/admin/account-deletions/{id}/hold", post(hold))
        .route("/v1/admin/account-deletions/{id}/records", get(records))
        .layer(DefaultBodyLimit::max(8192))
        .layer(middleware::from_fn_with_state(
            app.clone(),
            identity::policy,
        ))
        .with_state(app)
}
async fn customer_policy(
    State(app): State<App>,
    h: HeaderMap,
) -> std::result::Result<Json<Option<deletion::Policy>>, ApiError> {
    app.customers.authenticate(identity::bearer(&h)?).await?;
    Ok(Json(deletion::policy(&app.customers.pool).await?))
}
async fn admin_policy(
    State(app): State<App>,
    h: HeaderMap,
) -> std::result::Result<Json<Option<deletion::Policy>>, ApiError> {
    app.admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?
        .require("customers.retention")?;
    Ok(Json(deletion::policy(&app.customers.pool).await?))
}
async fn configure(
    State(app): State<App>,
    h: HeaderMap,
    Json(input): Json<deletion::PolicyInput>,
) -> std::result::Result<Json<deletion::Policy>, ApiError> {
    let who = app
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?;
    who.require("customers.retention")?;
    Ok(Json(
        deletion::configure(&app.customers.pool, who.user.id, input).await?,
    ))
}
async fn request(
    State(app): State<App>,
    h: HeaderMap,
    Json(input): Json<deletion::Request>,
) -> std::result::Result<Json<deletion::Status>, ApiError> {
    Ok(Json(
        app.customers
            .request_deletion(identity::bearer(&h)?, input)
            .await?,
    ))
}
async fn status(
    State(app): State<App>,
    Json(input): Json<deletion::Receipt>,
) -> std::result::Result<Json<deletion::Status>, ApiError> {
    Ok(Json(deletion::status(&app.customers.pool, &input).await?))
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Hold {
    until: Option<chrono::DateTime<chrono::Utc>>,
    reason: String,
}
async fn hold(
    State(app): State<App>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(input): Json<Hold>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    let who = app
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?;
    who.require("customers.retention")?;
    let now = chrono::Utc::now();
    if input.reason.trim().len() < 3
        || input.reason.len() > 500
        || input
            .until
            .is_some_and(|v| v <= now || v > now + chrono::Duration::days(365))
    {
        return Err(Error::Invalid(
            "Provide a reason and a future hold of at most 365 days".into(),
        )
        .into());
    }
    let mut tx = app.customers.pool.begin().await?;
    let n=sqlx::query("UPDATE customers.deletion_requests SET hold_until=$2,hold_reason=$3,next_attempt_at=clock_timestamp() WHERE id=$1 AND commerce_erased_at IS NULL").bind(id).bind(input.until).bind(input.reason).execute(&mut *tx).await?.rows_affected();
    if n != 1 {
        return Err(Error::Conflict.into());
    }
    infra_events::record(
        &mut tx,
        "customer.deletion_hold_changed",
        serde_json::json!({"request_id":id,"actor_id":who.user.id,"until":input.until}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({"saved":true})))
}
async fn records(
    State(app): State<App>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> std::result::Result<Json<Vec<serde_json::Value>>, ApiError> {
    app.admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?
        .require("customers.retention")?;
    let rows=sqlx::query_scalar("SELECT record FROM customers.retained_transactions WHERE request_id=$1 AND expires_at>clock_timestamp() ORDER BY order_id LIMIT 1000").bind(id).fetch_all(&app.customers.pool).await?;
    Ok(Json(rows))
}
pub async fn worker(app: App, assistant: Option<assistant::App>, analytics: analytics::Client) {
    loop {
        if let Err(error) = tick(&app, assistant.as_ref(), &analytics).await {
            tracing::warn!(error=%error,"Account deletion worker will retry");
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}
async fn tick(
    app: &App,
    assistant: Option<&assistant::App>,
    analytics: &analytics::Client,
) -> Result<()> {
    deletion::purge(&app.customers.pool).await?;
    let Some(job) = deletion::claim(&app.customers.pool).await? else {
        return Ok(());
    };
    if let Err(error) = process(app, assistant, analytics, &job).await {
        deletion::retry(&app.customers.pool, job.id).await?;
        return Err(error);
    }
    Ok(())
}
async fn process(
    app: &App,
    assistant: Option<&assistant::App>,
    analytics: &analytics::Client,
    job: &deletion::Job,
) -> Result<()> {
    // Capture browser analytics identifiers from the live engagement store before erasure.
    let sessions: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT session_id FROM customers.journey_events WHERE customer_id=$1",
    )
    .bind(job.customer_id)
    .fetch_all(&app.engagement)
    .await?;
    sqlx::query("UPDATE customers.deletion_requests SET session_ids=ARRAY(SELECT DISTINCT unnest(session_ids||$2::uuid[])) WHERE id=$1").bind(job.id).bind(sessions).execute(&app.customers.pool).await?;
    let job: deletion::Job =
        sqlx::query_as("SELECT * FROM customers.deletion_requests WHERE id=$1")
            .bind(job.id)
            .fetch_one(&app.customers.pool)
            .await?;
    if !deletion::erase_commerce(&app.customers.pool, job.id).await? {
        return Ok(());
    }
    if job.engagement_erased_at.is_none() {
        if app.engagement_isolated {
            erase_engagement(&app.engagement, job.customer_id).await?;
        }
        deletion::acknowledge(&app.customers.pool, job.id, "engagement").await?;
    }
    if job.assistant_erased_at.is_none() {
        if std::env::var("ACCOUNT_DELETION_ASSISTANT_MODE").as_deref() != Ok("never-used") {
            let assistant = assistant.ok_or(Error::Busy)?;
            let now = chrono::Utc::now().timestamp();
            let token = assistant.sign(&assistant::Claims {
                iss: "commerce-assistant".into(),
                aud: "ai-service".into(),
                tenant: assistant.tenant,
                sub: Some(job.customer_id),
                sid: Some(job.id),
                request_id: job.id,
                iat: now,
                exp: now + 60,
                scope: "account_deletion".into(),
            })?;
            assistant
                .client
                .post("http://assistant-ingress:8080/v1/account-deletion")
                .bearer_auth(token)
                .send()
                .await
                .map_err(|_| Error::Busy)?
                .error_for_status()
                .map_err(|_| Error::Busy)?;
        }
        deletion::acknowledge(&app.customers.pool, job.id, "assistant").await?;
    }
    if job.analytics_erased_at.is_none() {
        // Serialize with full reporting snapshots so an older snapshot cannot restore identity.
        let mut tx = app.customers.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(88008)")
            .execute(&mut *tx)
            .await?;
        for table in [
            "order_facts",
            "reporting_order_facts",
            "customer_dimensions",
            "customer_ltv",
        ] {
            analytics.execute(&format!("ALTER TABLE {table} DELETE WHERE customer_id='{}' SETTINGS mutations_sync=2",job.customer_id),String::new()).await?;
        }
        for session in &job.session_ids {
            for table in ["browser_events", "page_view_events", "search_query_events"] {
                analytics.execute(&format!("ALTER TABLE {table} DELETE WHERE session_id='{session}' SETTINGS mutations_sync=2"),String::new()).await?;
            }
        }
        for cart in &job.cart_ids {
            for table in ["add_to_cart_events", "checkout_funnel_events"] {
                analytics.execute(&format!("ALTER TABLE {table} DELETE WHERE cart_id='{cart}' SETTINGS mutations_sync=2"),String::new()).await?;
            }
        }
        tx.commit().await?;
        deletion::acknowledge(&app.customers.pool, job.id, "analytics").await?;
    }
    deletion::finish(&app.customers.pool, job.id).await
}
pub async fn erase_engagement(pool: &sqlx::PgPool, customer: Uuid) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,71))")
        .bind(customer.to_string())
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO customers.deletion_tombstones(customer_id) VALUES($1) ON CONFLICT DO NOTHING",
    )
    .bind(customer)
    .execute(&mut *tx)
    .await?;
    for query in [
        "DELETE FROM customers.journey_events WHERE customer_id=$1",
        "DELETE FROM platform.storefront_notification_publications WHERE customer_id=$1",
        "DELETE FROM platform.storefront_notification_recipients WHERE customer_id=$1",
        "DELETE FROM platform.marketing_notification_requests WHERE customer_id=$1",
        "DELETE FROM platform.marketing_notification_records WHERE customer_id=$1",
        "DELETE FROM platform.engagement_jobs WHERE payload::text LIKE '%'||$1::text||'%'",
        "DELETE FROM platform.outbox WHERE payload::text LIKE '%'||$1::text||'%'",
        "UPDATE admin_iam.audit_log SET details='{}' WHERE entity_id=$1",
    ] {
        sqlx::query(query).bind(customer).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
