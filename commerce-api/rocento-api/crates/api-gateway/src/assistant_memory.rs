//! Browser consent controls and signed, bounded catalog context capability.
use super::{App, Claims};
use crate::identity::{self, ApiError};
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use domain_customers::memory as m;
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;
type Result<T> = std::result::Result<T, ApiError>;
const COOKIE: &str = "assistant_guest";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Conversation {
    pub conversation_id: Option<Uuid>,
}
#[derive(Serialize, Deserialize, sqlx::FromRow)]
#[serde(deny_unknown_fields)]
pub struct Signal {
    pub product_id: Uuid,
    pub category_id: Uuid,
    pub name: String,
    pub kind: String,
    pub weight: i32,
    pub observed_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Serialize)]
pub struct View {
    pub schema_version: String,
    pub enabled: bool,
    pub guest: bool,
    pub personalized: bool,
    pub journey_consent: bool,
    pub consent_version: i32,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
    pub half_life_days: i32,
    pub preferences: Vec<m::Evidence>,
    pub signals: Vec<Signal>,
    pub context: m::Context,
    pub categories: Vec<Value>,
    pub products: Vec<Value>,
}
pub fn routes() -> Router<App> {
    Router::new()
        .route(
            "/v1/assistant/memory",
            get(read).put(consent).delete(delete),
        )
        .route("/v1/assistant/memory/export", get(export))
        .route("/v1/assistant/memory/preferences", post(preference))
        .route(
            "/v1/assistant/memory/preferences/{id}",
            axum::routing::delete(remove_preference),
        )
        .route(
            "/v1/assistant/memory/context/{id}",
            axum::routing::delete(clear_context),
        )
        .route("/v1/assistant-tools/memory", get(tool_read).put(tool_write))
        .route(
            "/v1/admin/assistant/memory",
            get(admin_read).put(admin_write),
        )
}
async fn browser(
    a: &App,
    h: &HeaderMap,
    require_enabled: bool,
) -> Result<(m::Subject, Option<String>)> {
    if require_enabled && !m::configuration(&a.identity.customers.pool).await?.enabled {
        return Err(Error::NotFound.into());
    }
    let customer = if h.contains_key("authorization") {
        Some(
            a.identity
                .customers
                .authenticate(identity::bearer(h)?)
                .await?
                .id,
        )
    } else {
        None
    };
    // Browser memory routes share the session/source/installation admission middleware.
    Ok(m::resolve(
        &a.identity.customers.pool,
        a.tenant,
        customer,
        Some(identity::cookie(h, COOKIE)).filter(|v| !v.is_empty()),
    )
    .await?)
}
fn response(a: &App, data: impl Serialize, cookie: Option<String>) -> Result<Response> {
    let mut result = Json(data).into_response();
    result
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    if let Some(cookie) = cookie {
        result.headers_mut().insert(
            header::SET_COOKIE,
            identity::session_cookie(
                COOKIE,
                &cookie,
                if cookie.is_empty() { 0 } else { 3600 },
                &a.identity.customers.security,
            )
            .parse()
            .map_err(|_| Error::Internal)?,
        );
    }
    Ok(result)
}
async fn view(a: &App, subject: &m::Subject, conversation: Option<Uuid>) -> Result<View> {
    let pool = &a.identity.customers.pool;
    let config = m::configuration(pool).await?;
    let mut context = if let Some(id) = conversation {
        m::context(pool, subject, id).await?
    } else {
        m::Context {
            revision: 0,
            snapshot: None,
        }
    };
    let preferences = m::preferences(pool, subject).await?;
    let categories: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT id,name FROM catalog.categories WHERE id=ANY($1) ORDER BY name")
            .bind(&config.allowed_categories)
            .fetch_all(pool)
            .await?;
    let mut signals = Vec::new();
    if subject.personalized && subject.journey_consent {
        if let Some(customer) = subject.customer_id {
            // Only observations made after the most recent consent version are eligible.
            let since:Option<chrono::DateTime<chrono::Utc>>=sqlx::query_scalar("SELECT created_at FROM customers.memory_consents WHERE subject_id=$1 AND version=$2 AND journey AND personalized").bind(subject.id).bind(subject.consent_version).fetch_optional(pool).await?;
            if let Some(since) = since {
                let since = since
                    .max(chrono::Utc::now() - chrono::Duration::days(config.retention_days as i64));
                // Browser records are weak observations, never verified purchases.
                let browser_rows = crate::engagement::browser_rows(
                    &a.identity.engagement,
                    customer,
                    since,
                    chrono::Utc::now(),
                )
                .await
                .unwrap_or(json!([]));
                let browser_source = crate::engagement::browser_source(5);
                signals=sqlx::query_as(&format!("SELECT p.id AS product_id,p.category_id,p.name,'view'::text AS kind,LEAST(count(*)::integer,3)*$4::integer AS weight,max(e.occurred_at) AS observed_at FROM {browser_source} JOIN catalog.products p ON e.path='/products/'||p.id::text OR e.path='/products/'||p.slug WHERE e.customer_id=$1 AND e.occurred_at>=$2 AND e.event_type='page_view' AND p.active AND (p.parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.products parent WHERE parent.id=p.parent_id AND parent.active)) AND p.category_id=ANY($3) GROUP BY p.id ORDER BY max(e.occurred_at) DESC LIMIT 20")).bind(customer).bind(since).bind(&config.allowed_categories).bind(config.view_weight).bind(browser_rows).fetch_all(pool).await.unwrap_or_default();
                let purchases:Vec<Signal>=sqlx::query_as("SELECT p.id AS product_id,p.category_id,p.name,'purchase'::text AS kind,$4::integer AS weight,max(o.created_at) AS observed_at FROM orders.orders o JOIN orders.order_items i ON i.order_id=o.id JOIN catalog.products p ON p.id=i.product_id WHERE o.customer_id=$1 AND o.created_at>=$2 AND o.status NOT IN ('cancelled','delivery_failed') AND NOT EXISTS(SELECT 1 FROM payments.manual_refunds r WHERE r.order_id=o.id) AND p.active AND (p.parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.products parent WHERE parent.id=p.parent_id AND parent.active)) AND p.category_id=ANY($3) GROUP BY p.id ORDER BY max(o.created_at) DESC LIMIT 10").bind(customer).bind(since).bind(&config.allowed_categories).bind(config.purchase_weight).fetch_all(pool).await.unwrap_or_default();
                signals.extend(purchases);
                signals.retain(|s| m::safe_text(&s.name));
                signals.truncate(20);
            }
        }
    }
    let ids = context
        .snapshot
        .as_ref()
        .map(|s| s.product_ids.clone())
        .unwrap_or_default();
    let products:Vec<(Uuid,String,Uuid)>=sqlx::query_as("SELECT id,name,category_id FROM catalog.products WHERE id=ANY($1) AND active AND (parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.products p WHERE p.id=catalog.products.parent_id AND p.active)) AND category_id=ANY($2)").bind(ids).bind(&config.allowed_categories).fetch_all(pool).await?;
    if context
        .snapshot
        .as_ref()
        .is_some_and(|s| s.product_ids.len() != products.len())
        || products.iter().any(|p| !m::safe_text(&p.1))
    {
        context.snapshot = None;
    }
    Ok(View {
        schema_version: m::VERSION.into(),
        enabled: config.enabled,
        guest: subject.customer_id.is_none(),
        personalized: subject.personalized,
        journey_consent: subject.journey_consent,
        consent_version: subject.consent_version,
        expires_at: Some(subject.expires_at),
        half_life_days: config.half_life_days,
        preferences,
        signals,
        context,
        categories: categories
            .into_iter()
            .map(|(id, name)| json!({"id":id,"name":name}))
            .collect(),
        products: products
            .into_iter()
            .map(|(id, name, category_id)| json!({"id":id,"name":name,"category_id":category_id}))
            .collect(),
    })
}
async fn read(
    State(a): State<App>,
    h: HeaderMap,
    Query(q): Query<Conversation>,
) -> Result<Response> {
    if !m::configuration(&a.identity.customers.pool).await?.enabled {
        return response(
            &a,
            json!({"schema_version":"1.0.0","enabled":false,"guest":true,"personalized":false,"journey_consent":false,"consent_version":0,"expires_at":null,"half_life_days":14,"preferences":[],"signals":[],"context":{"revision":0,"snapshot":null},"categories":[],"products":[]}),
            None,
        );
    }
    let (subject, cookie) = browser(&a, &h, true).await?;
    response(&a, view(&a, &subject, q.conversation_id).await?, cookie)
}
async fn export(State(a): State<App>, h: HeaderMap) -> Result<Response> {
    let (subject, cookie) = browser(&a, &h, false).await?;
    let pool = &a.identity.customers.pool;
    let contexts:Vec<(Uuid,Value)>=sqlx::query_as("SELECT conversation_id,snapshot FROM customers.memory_contexts WHERE subject_id=$1 AND expires_at>now() ORDER BY updated_at DESC LIMIT 10").bind(subject.id).fetch_all(pool).await?;
    let consents:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('version',version,'personalized',personalized,'journey',journey,'purpose',purpose,'created_at',created_at) FROM customers.memory_consents WHERE subject_id=$1 ORDER BY version DESC LIMIT 100").bind(subject.id).fetch_all(pool).await?;
    response(
        &a,
        json!({"schema_version":"1.0.0","memory":view(&a,&subject,None).await?,"contexts":contexts.into_iter().map(|(conversation_id,snapshot)|json!({"conversation_id":conversation_id,"snapshot":snapshot})).collect::<Vec<_>>(),"consents":consents}),
        cookie,
    )
}
async fn consent(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<m::Consent>,
) -> Result<Response> {
    let (subject, cookie) = browser(&a, &h, true).await?;
    m::consent(&a.identity.customers.pool, &subject, i).await?;
    let fresh = m::authorized(
        &a.identity.customers.pool,
        a.tenant,
        subject.id,
        subject.customer_id,
    )
    .await?;
    response(&a, view(&a, &fresh, None).await?, cookie)
}
async fn preference(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<m::PreferenceInput>,
) -> Result<Response> {
    let (subject, cookie) = browser(&a, &h, true).await?;
    response(
        &a,
        m::save_preference(&a.identity.customers.pool, &subject, i).await?,
        cookie,
    )
}
async fn remove_preference(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let (subject, cookie) = browser(&a, &h, false).await?;
    sqlx::query("DELETE FROM customers.preference_evidence WHERE id=$1 AND subject_id=$2")
        .bind(id)
        .bind(subject.id)
        .execute(&a.identity.customers.pool)
        .await?;
    response(&a, json!({"status":"ok"}), cookie)
}
async fn clear_context(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let (subject, cookie) = browser(&a, &h, false).await?;
    sqlx::query("DELETE FROM customers.memory_contexts WHERE subject_id=$1 AND conversation_id=$2")
        .bind(subject.id)
        .bind(id)
        .execute(&a.identity.customers.pool)
        .await?;
    response(&a, json!({"status":"ok"}), cookie)
}
async fn delete(State(a): State<App>, h: HeaderMap) -> Result<Response> {
    let (subject, _) = browser(&a, &h, false).await?;
    sqlx::query("DELETE FROM customers.memory_subjects WHERE id=$1 AND tenant_id=$2")
        .bind(subject.id)
        .bind(a.tenant)
        .execute(&a.identity.customers.pool)
        .await?;
    response(&a, json!({"status":"ok"}), Some(String::new()))
}
pub async fn delegate(
    a: &App,
    h: &HeaderMap,
    claims: &Claims,
) -> std::result::Result<Option<String>, Error> {
    if !m::configuration(&a.identity.customers.pool).await?.enabled {
        return Ok(None);
    }
    // Guest creation happens on the browser memory endpoint so Set-Cookie is explicit.
    let subject = if let Some(customer) = claims.sub {
        Some(
            m::resolve(
                &a.identity.customers.pool,
                a.tenant,
                Some(customer),
                Some(identity::cookie(h, COOKIE)).filter(|v| !v.is_empty()),
            )
            .await?
            .0,
        )
    } else if let Some(cookie) = Some(identity::cookie(h, COOKIE)).filter(|v| !v.is_empty()) {
        let id:Option<Uuid>=sqlx::query_scalar("SELECT id FROM customers.memory_subjects WHERE tenant_id=$1 AND guest_hash=$2 AND expires_at>now()").bind(a.tenant).bind(infra_auth::digest(cookie)).fetch_optional(&a.identity.customers.pool).await?;
        match id {
            Some(id) => Some(m::authorized(&a.identity.customers.pool, a.tenant, id, None).await?),
            None => None,
        }
    } else {
        None
    };
    if let Some(subject) = subject {
        let mut c = claims.clone();
        c.scope = format!("memory:{}", subject.id);
        c.aud = "assistant-tools".into();
        Ok(Some(a.sign(&c)?))
    } else {
        Ok(None)
    }
}
async fn tool_subject(a: &App, h: &HeaderMap) -> Result<m::Subject> {
    let token = identity::bearer(h)?;
    // Decode with the exact server-issued scope; signature, tenant and session still validate.
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_audience(&["assistant-tools"]);
    validation.set_issuer(&["commerce-assistant"]);
    validation.leeway = 0;
    let c = jsonwebtoken::decode::<Claims>(token, &a.verifying, &validation)
        .map_err(|_| Error::Unauthorized)?
        .claims;
    let id = c
        .scope
        .strip_prefix("memory:")
        .and_then(|v| v.parse::<Uuid>().ok())
        .ok_or(Error::Forbidden)?;
    let c = a.decode(token, &format!("memory:{id}"))?;
    if c.sub.is_some() {
        a.customer(&c).await?;
    }
    if !m::configuration(&a.identity.customers.pool).await?.enabled {
        return Err(Error::Forbidden.into());
    }
    Ok(m::authorized(&a.identity.customers.pool, a.tenant, id, c.sub).await?)
}
async fn tool_read(
    State(a): State<App>,
    h: HeaderMap,
    Query(q): Query<Conversation>,
) -> Result<Response> {
    let s = tool_subject(&a, &h).await?;
    response(&a, view(&a, &s, q.conversation_id).await?, None)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Update {
    conversation_id: Uuid,
    expected_revision: i64,
    snapshot: m::Snapshot,
}
async fn tool_write(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<Update>,
) -> Result<Json<Value>> {
    let s = tool_subject(&a, &h).await?;
    m::save_context(
        &a.identity.customers.pool,
        &s,
        i.conversation_id,
        i.expected_revision,
        i.snapshot,
    )
    .await?;
    Ok(Json(json!({"status":"ok"})))
}
async fn admin_read(State(a): State<App>, h: HeaderMap) -> Result<Json<m::Configuration>> {
    a.identity
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?
        .require("assistant.settings.read")?;
    Ok(Json(m::configuration(&a.identity.customers.pool).await?))
}
async fn admin_write(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<m::Configuration>,
) -> Result<Json<m::Configuration>> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?;
    who.require("assistant.settings.write")?;
    if i.allowed_categories.len() > 100
        || !(0..=20).contains(&i.view_weight)
        || !(0..=20).contains(&i.purchase_weight)
        || !(-20..=0).contains(&i.return_weight)
        || !(1..=90).contains(&i.half_life_days)
        || !(1..=90).contains(&i.retention_days)
    {
        return Err(Error::Invalid("Invalid memory configuration".into()).into());
    }
    let pool = &a.identity.customers.pool;
    let categories: Vec<String> =
        sqlx::query_scalar("SELECT name FROM catalog.categories WHERE id=ANY($1)")
            .bind(&i.allowed_categories)
            .fetch_all(pool)
            .await?;
    if categories.len() != i.allowed_categories.len()
        || categories.iter().any(|name| !m::safe_text(name))
    {
        return Err(Error::Invalid("Choose existing, non-sensitive categories".into()).into());
    }
    let mut tx = pool.begin().await?;
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(who.user.id),
        "assistant.memory.configuration_changed",
        a.tenant,
        json!({"enabled":i.enabled,"category_count":i.allowed_categories.len()}),
    )
    .await?;
    sqlx::query("UPDATE customers.memory_configuration SET enabled=$1,allowed_categories=$2,view_weight=$3,purchase_weight=$4,return_weight=$5,half_life_days=$6,retention_days=$7 WHERE singleton").bind(i.enabled).bind(&i.allowed_categories).bind(i.view_weight).bind(i.purchase_weight).bind(i.return_weight).bind(i.half_life_days).bind(i.retention_days).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(i))
}

pub fn maintenance(a: &App) {
    let pool = a.identity.customers.pool.clone();
    let tenant = a.tenant;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            if pool.is_closed() {
                break;
            }
            if m::purge(&pool, tenant).await.is_err() {
                tracing::warn!("memory retention cleanup unavailable");
            }
        }
    });
}
