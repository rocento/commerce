//! Evidence-based, anonymous session attribution. Browser evidence is observational, not identity.
use crate::{
    discoverability::App,
    identity::{self, ApiError},
};
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Evidence {
    pub referrer: String,
    pub source: String,
    pub medium: String,
    pub campaign: String,
}
#[derive(Serialize)]
pub struct Touch {
    pub channel: &'static str,
    pub evidence: &'static str,
    pub referrer_host: String,
    pub source: String,
    pub medium: String,
    pub campaign: String,
    pub landing: String,
}
fn token(s: &str) -> String {
    if s.len() <= 80
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        s.to_lowercase()
    } else {
        String::new()
    }
}
fn host(value: &str) -> Option<String> {
    let u = reqwest::Url::parse(value).ok()?;
    if !["http", "https"].contains(&u.scheme())
        || !u.username().is_empty()
        || u.password().is_some()
        || u.port().is_some()
    {
        return None;
    }
    Some(u.host_str()?.trim_end_matches('.').to_lowercase())
}
fn ai(h: &str) -> Option<&'static str> {
    match h {
        "chatgpt.com" | "www.chatgpt.com" | "chat.openai.com" => Some("ai_chatgpt"),
        "gemini.google.com" => Some("ai_google"),
        "perplexity.ai" | "www.perplexity.ai" => Some("ai_perplexity"),
        "claude.ai" | "www.claude.ai" => Some("ai_claude"),
        _ => None,
    }
}
pub fn classify(e: &Evidence, own_origin: &str, path: &str) -> Touch {
    let source = token(&e.source);
    let medium = token(&e.medium);
    let campaign = token(&e.campaign);
    let parsed = host(&e.referrer);
    let own = host(own_origin);
    let referral = parsed.as_deref().filter(|h| Some(*h) != own.as_deref());
    let (channel, proof) = if ["cpc", "ppc", "paidsearch"].contains(&medium.as_str()) {
        ("paid_search", "campaign")
    } else if medium == "email" {
        ("email", "campaign")
    } else if ["social", "social-paid", "social-organic"].contains(&medium.as_str()) {
        ("social", "campaign")
    } else if let Some(provider) = referral.and_then(ai) {
        (provider, "referrer_host")
    }
    // Only the documented ChatGPT UTM is provider-specific without a referral host.
    else if referral.is_none()
        && (e.referrer.is_empty() || parsed.is_some())
        && source == "chatgpt.com"
        && ["", "referral", "ai"].contains(&medium.as_str())
    {
        ("ai_chatgpt", "utm_claim")
    } else if medium == "ai" {
        ("ai_other", "utm_claim")
    } else if medium == "organic" {
        ("organic_search", "campaign")
    } else if let Some(h) = referral {
        if [
            "google.com",
            "www.google.com",
            "google.co.uk",
            "www.google.co.uk",
            "google.com.eg",
            "www.google.com.eg",
            "bing.com",
            "www.bing.com",
            "duckduckgo.com",
            "www.duckduckgo.com",
        ]
        .contains(&h)
        {
            ("organic_search", "referrer_host")
        } else if [
            "facebook.com",
            "www.facebook.com",
            "m.facebook.com",
            "l.facebook.com",
            "instagram.com",
            "www.instagram.com",
            "t.co",
            "x.com",
            "www.x.com",
            "tiktok.com",
            "www.tiktok.com",
        ]
        .contains(&h)
        {
            ("social", "referrer_host")
        } else {
            ("referral", "referrer_host")
        }
    } else if !e.referrer.is_empty() && parsed.is_none()
        || !source.is_empty()
        || !medium.is_empty()
        || !e.source.is_empty()
        || !e.medium.is_empty()
    {
        ("unknown", "unrecognized")
    } else {
        ("direct", "no_external_evidence")
    };
    Touch {
        channel,
        evidence: proof,
        referrer_host: referral.unwrap_or_default().into(),
        source,
        medium,
        campaign,
        landing: path.into(),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub id: Uuid,
    pub session_id: Uuid,
    pub path: String,
    #[serde(default)]
    pub evidence: Evidence,
    pub order_id: Option<Uuid>,
}
pub async fn ingest(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<Input>,
) -> Result<Json<Value>, ApiError> {
    let origin = a
        .deployment
        .approved_origin
        .as_deref()
        .ok_or(Error::Forbidden)?;
    let actual: Uuid =
        sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
            .fetch_one(&a.identity.admins.pool)
            .await?;
    if a.deployment.installation_id != Some(actual) {
        return Err(Error::Forbidden.into());
    }
    // Browser evidence stays on its configured merchant origin; request Host is not a tenant selector.
    if h.get("origin").and_then(|v| v.to_str().ok()) != Some(origin.trim_end_matches('/')) {
        return Err(Error::Forbidden.into());
    }
    if i.evidence.referrer.len() > 2048
        || i.evidence.source.len() > 80
        || i.evidence.medium.len() > 80
        || i.evidence.campaign.len() > 80
        || i.path.len() > 250
        || !(super::snapshot::valid_path(&i.path)
            || i.path == "/checkout/complete" && i.order_id.is_some())
    {
        return Err(Error::Invalid("Invalid discovery observation".into()).into());
    }
    let customer = if i.order_id.is_some() {
        Some(
            a.identity
                .customers
                .require_verified(identity::bearer(&h)?)
                .await?
                .id,
        )
    } else {
        None
    };
    infra_auth::rate_limit(
        &a.identity.admins.pool,
        &format!("discovery:{}", i.session_id),
        300,
    )
    .await?;
    let t = classify(&i.evidence, origin, &i.path);
    let ai = t.channel.starts_with("ai_");
    let direct = t.channel == "direct";
    let touch = serde_json::to_value(t).map_err(|_| Error::Internal)?;
    let mut tx = a.identity.admins.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,10010))")
        .bind(i.id.to_string())
        .execute(&mut *tx)
        .await?;
    let duplicate: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform.discovery_events WHERE id=$1)")
            .bind(i.id)
            .fetch_one(&mut *tx)
            .await?;
    if duplicate {
        return Ok(Json(json!({"accepted":true})));
    }

    if i.order_id.is_none() && super::canonical::resolve(&mut tx, &i.path).await?.status != 200 {
        return Err(Error::NotFound.into());
    }
    sqlx::query("INSERT INTO platform.discovery_sessions(id,first_touch,last_touch,ai_seen) VALUES($1,$2,$2,$3) ON CONFLICT(id) DO NOTHING").bind(i.session_id).bind(&touch).bind(ai).execute(&mut *tx).await?;
    let fresh=sqlx::query("INSERT INTO platform.discovery_events(id,session_id,path) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING").bind(i.id).bind(i.session_id).bind(&i.path).execute(&mut *tx).await?.rows_affected()>0;
    if fresh {
        sqlx::query("UPDATE platform.discovery_sessions SET last_seen_at=clock_timestamp(),last_touch=CASE WHEN $3 THEN last_touch ELSE $2 END,ai_seen=ai_seen OR $4 WHERE id=$1").bind(i.session_id).bind(&touch).bind(direct).bind(ai).execute(&mut *tx).await?;
    }
    if let Some(order) = i.order_id {
        let owned:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM orders.orders WHERE id=$1 AND customer_id=$2 AND created_at>=now()-interval '24 hours')").bind(order).bind(customer).fetch_one(&mut *tx).await?;
        if !owned {
            return Err(Error::NotFound.into());
        }
        sqlx::query("INSERT INTO platform.discovery_orders(order_id,session_id,first_touch,last_touch,ai_assisted) SELECT $1,id,first_touch,last_touch,ai_seen FROM platform.discovery_sessions WHERE id=$2 ON CONFLICT(order_id) DO NOTHING").bind(order).bind(i.session_id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"accepted":true})))
}
pub async fn authorize(a: &App, h: &HeaderMap) -> Result<bool, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(h, "admin_session"))
        .await?;
    who.require("discovery.read")?;
    let id: Uuid =
        sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
            .fetch_one(&a.identity.admins.pool)
            .await?;
    if a.deployment.installation_id != Some(id) {
        return Err(Error::Forbidden.into());
    }
    Ok(who.require("reports.read").is_ok())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Window {
    pub days: Option<i32>,
}
pub async fn analytics(
    State(a): State<App>,
    h: HeaderMap,
    Query(w): Query<Window>,
) -> Result<Json<Value>, ApiError> {
    let finance = authorize(&a, &h).await?;
    let days = w.days.unwrap_or(30);
    if !(1..=90).contains(&days) {
        return Err(Error::Invalid("Use 1 to 90 days".into()).into());
    }
    let mut tx = a.identity.admins.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='3000ms'")
        .execute(&mut *tx)
        .await?;
    let from = chrono::Utc::now() - chrono::Duration::days(days.into());
    let channels:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('channel',first_touch->>'channel','sessions',count(*),'referrer_sessions',count(*) FILTER(WHERE first_touch->>'evidence'='referrer_host'),'campaign_claim_sessions',count(*) FILTER(WHERE first_touch->>'evidence' IN ('campaign','utm_claim')),'ai_assisted_sessions',count(*) FILTER(WHERE ai_seen)) FROM platform.discovery_sessions WHERE created_at>=$1 GROUP BY first_touch->>'channel' ORDER BY count(*) DESC").bind(from).fetch_all(&mut *tx).await?;
    let landing:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('path',first_touch->>'landing','sessions',count(*)) FROM platform.discovery_sessions WHERE created_at>=$1 GROUP BY first_touch->>'landing' ORDER BY count(*) DESC,first_touch->>'landing' LIMIT 20").bind(from).fetch_all(&mut *tx).await?;
    let products:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('path',path,'sessions',count(DISTINCT session_id)) FROM platform.discovery_events WHERE occurred_at>=$1 AND path LIKE '/products/%' GROUP BY path ORDER BY count(DISTINCT session_id) DESC,path LIMIT 20").bind(from).fetch_all(&mut *tx).await?;
    let trend:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('day',(created_at AT TIME ZONE 'UTC')::date,'sessions',count(*),'recognized_ai_sessions',count(*) FILTER(WHERE first_touch->>'channel' LIKE 'ai_%')) FROM platform.discovery_sessions WHERE created_at>=$1 GROUP BY (created_at AT TIME ZONE 'UTC')::date ORDER BY (created_at AT TIME ZONE 'UTC')::date").bind(from).fetch_all(&mut *tx).await?;
    let conversions: Option<Vec<Value>> = if finance {
        Some(sqlx::query_scalar("SELECT jsonb_build_object('channel',d.last_touch->>'channel','currency',o.currency,'orders',count(*) FILTER(WHERE o.status NOT IN ('cancelled','delivery_failed')),'ai_assisted_orders',count(*) FILTER(WHERE d.ai_assisted AND o.status NOT IN ('cancelled','delivery_failed')),'collected_net_revenue',coalesce(sum(CASE WHEN p.collected_at IS NOT NULL THEN p.amount_due-coalesce(r.amount,0) ELSE 0 END),0)::text) FROM platform.discovery_orders d JOIN orders.orders o ON o.id=d.order_id LEFT JOIN payments.payment_transactions p ON p.order_id=o.id LEFT JOIN payments.manual_refunds r ON r.order_id=o.id WHERE o.created_at>=$1 GROUP BY d.last_touch->>'channel',o.currency ORDER BY d.last_touch->>'channel',o.currency").bind(from).fetch_all(&mut *tx).await?)
    } else {
        None
    };
    tx.commit().await?;
    Ok(Json(
        json!({"timezone":"UTC","from":from,"days":days,"sampling":"All accepted browser observations; ad blockers, disabled JS and missing purchase callbacks cause undercounting.","session_model":"first touch; last non-direct touch frozen at verified purchase callback","channels":channels,"top_landings":landing,"top_products":products,"trend":trend,"conversions":conversions,"revenue_authorized":finance}),
    ))
}
pub async fn purge(pool: &sqlx::PgPool) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM platform.discovery_events WHERE occurred_at<now()-interval '90 days'")
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM platform.discovery_orders WHERE recorded_at<now()-interval '90 days'")
        .execute(pool)
        .await?;
    sqlx::query(
        "DELETE FROM platform.discovery_sessions WHERE created_at<now()-interval '90 days'",
    )
    .execute(pool)
    .await?;
    Ok(())
}
