//! Authenticated operational findings. Fixed operator-configured probe target; no URL input.
use crate::{
    discoverability::{App, Settings, SELECT},
    identity::ApiError,
};
use axum::{extract::State, http::HeaderMap, Json};
use serde_json::{json, Value};
use uuid::Uuid;
pub fn finding(
    code: &str,
    severity: &str,
    resource: &str,
    evidence: Value,
    remediation: &str,
) -> Value {
    json!({"code":code,"severity":severity,"resource":resource,"evidence":evidence,"remediation":remediation,"observed_at":chrono::Utc::now()})
}
pub async fn read(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>, ApiError> {
    super::attribution::authorize(&a, &h).await?;
    infra_auth::rate_limit(
        &a.identity.admins.pool,
        &format!(
            "discovery-health:{}",
            infra_auth::digest(crate::identity::cookie(&h, "admin_session"))
        ),
        30,
    )
    .await?;
    let target = std::env::var("PUBLICATION_RENDERER_URL").ok();
    let token = std::env::var("PUBLICATION_OBSERVATION_TOKEN").ok();
    Ok(Json(assess(&a, target.as_deref(), token.as_deref()).await?))
}
pub async fn assess(
    a: &App,
    target: Option<&str>,
    token: Option<&str>,
) -> Result<Value, sqlx::Error> {
    let pool = &a.identity.admins.pool;
    let settings: Settings = sqlx::query_as(SELECT).fetch_one(pool).await?;
    let policy = a.deployment.resolve(&settings);
    let actual: Uuid =
        sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
            .fetch_one(pool)
            .await?;
    let bound = a.deployment.installation_id == Some(actual);
    let resource = policy.canonical_origin.as_deref().unwrap_or("installation");
    let expected = policy.state == "INDEXABLE" || policy.state == "BLOCKED_BY_ENVIRONMENT";
    let mut findings=vec![finding("installation_binding",if bound{"Healthy"}else{"Error"},"installation",json!({"matched":bound}),"Correct the operator's installation binding."),finding("effective_indexing",if expected{"Healthy"}else if policy.state=="MERCHANT_DISABLED"{"Warning"}else{"Error"},resource,json!({"state":policy.state,"environment":policy.environment}),"Review approved canonical origin, production environment, merchant preference and deployment noindex override.")];
    let feed:Value=sqlx::query_scalar("SELECT jsonb_build_object('generation',generation,'completed_generation',completed_generation,'last_completed_at',last_completed_at,'last_error',last_error,'lag_seconds',CASE WHEN generation>completed_generation THEN extract(epoch FROM now()-coalesce(last_completed_at,next_scan_at)) ELSE 0 END) FROM platform.publication_freshness").fetch_one(pool).await?;
    let (failed,stale):(i64,i64)=sqlx::query_as("SELECT count(*) FILTER(WHERE status='failed'),count(*) FILTER(WHERE status IN ('queued','retry') AND created_at<now()-interval '15 minutes') FROM platform.publication_feed_events").fetch_one(pool).await?;
    let lag = feed["lag_seconds"].as_f64().unwrap_or(0.0);
    let unhealthy = failed > 0 || stale > 0 || lag > 900.0 || !feed["last_error"].is_null();
    findings.push(finding("feed_freshness",if unhealthy{"Warning"}else{"Healthy"},"reference-v1",json!({"failed_items":failed,"stale_items":stale,"freshness":feed,"threshold_seconds":900}),"Inspect feed item errors, worker availability and catalog throughput; repair and request reconciliation."));
    if unhealthy {
        tracing::warn!(event="publication_alert",code="feed_lag_or_failure",installation_id=%actual,failed_items=failed,stale_items=stale);
    }
    let routes:Vec<(String,Option<String>)>=sqlx::query_as("SELECT path,target FROM platform.publication_routes WHERE status=301 ORDER BY path LIMIT 100").fetch_all(pool).await?;
    let mut db = pool.acquire().await?;
    let mut bad = 0;
    for (path, _) in &routes {
        let r = super::canonical::resolve(&mut db, path).await?;
        if r.status != 301 {
            bad += 1;
            findings.push(finding(
                "redirect_target",
                "Error",
                path,
                json!({"resolved_status":r.status}),
                "Repair a loop, overlong chain, or unavailable redirect target.",
            ));
        }
    }
    if bad > 0 {
        tracing::warn!(event="publication_alert",code="redirect_loop_or_unavailable_target",installation_id=%actual,count=bad);
    }
    drop(db);
    let mut observations = Value::Null;
    if bound && policy.state == "INDEXABLE" {
        match (target,token.filter(|v|v.len()>=32)) {
            (Some(target),Some(token))=>{
                let report=probe(a,target,token,routes.first().map(|r|r.0.as_str())).await;
                match report {
                    Some(v) if v["installation_id"]==actual.to_string() && v["origin"]==a.deployment.approved_origin.clone().unwrap_or_default()=>{
                        if let Some(list)=v["findings"].as_array(){findings.extend(list.iter().take(30).cloned());}observations=v["observations"].clone();
                    },
                    _=>{findings.push(finding("renderer_probe","Warning",resource,json!("Fixed renderer probe unavailable, timed out, or returned a mismatched binding."),"Configure the fixed renderer URL and matching observation token; verify process reachability."));tracing::warn!(event="publication_probe",code="renderer_probe_unavailable",installation_id=%actual);}
                }
            },
            _=>findings.push(finding("renderer_probe","Warning",resource,json!("Not observed: private renderer probe URL/token is not configured."),"Configure PUBLICATION_RENDERER_URL and PUBLICATION_OBSERVATION_TOKEN through operator-managed secrets."))
        }
    } else {
        findings.push(finding("renderer_probe","Warning",resource,json!("Indexable-page probes skipped because publication is protected or installation binding is invalid."),"Keep intended protection; run public probes after approved production activation."));
    }
    findings.push(finding("external_edge","Warning",resource,json!("External CDN responses and verified crawler identity have not been observed by this local probe."),"Review CDN access logs and externally probe the approved merchant domain."));
    Ok(
        json!({"installation_id":actual,"observed_at":chrono::Utc::now(),"scope":"Current database state; at most 100 redirects and a bounded local renderer sample. No score or ranking.","findings":findings,"observations":observations}),
    )
}
async fn probe(a: &App, target: &str, token: &str, redirect: Option<&str>) -> Option<Value> {
    let mut url = reqwest::Url::parse(target).ok()?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    url.set_path("/__publication/health");
    if let Some(path) = redirect {
        url.query_pairs_mut().append_pair("redirect", path);
    }
    let host = reqwest::Url::parse(a.deployment.approved_origin.as_deref()?)
        .ok()?
        .host_str()?
        .to_owned();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .ok()?;
    let mut r = client
        .get(url)
        .header("host", host)
        .header("x-publication-observation-token", token)
        .send()
        .await
        .ok()?;
    if !r.status().is_success() {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = r.chunk().await.ok()? {
        if bytes.len() + chunk.len() > 128 * 1024 {
            return None;
        }
        bytes.extend(chunk);
    }
    serde_json::from_slice(&bytes).ok()
}
pub async fn maintenance(pool: sqlx::PgPool) {
    let mut ticks = tokio::time::interval(std::time::Duration::from_secs(3600));
    loop {
        ticks.tick().await;
        if super::attribution::purge(&pool).await.is_err() {
            tracing::warn!(event = "publication_retention", code = "purge_failed");
        }
    }
}
