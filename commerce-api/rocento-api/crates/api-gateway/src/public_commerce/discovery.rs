//! Bounded, installation-bound discovery artifacts. No request host becomes an output URL.
use super::{canonical::Context, policy::EffectivePolicy};
use crate::{
    discoverability::{App, Settings, SELECT},
    identity::{self, ApiError},
};
use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

pub const REGISTRY: &str = include_str!("crawlers.json");
pub const PREFS: &str =
    "SELECT revision,openai_search,openai_training FROM cms.publication_crawlers WHERE singleton";
const ELIGIBLE: &str = "FROM platform.publication_sitemap_resources s WHERE kind=$1 AND length(route_key) BETWEEN 1 AND 200 AND route_key !~ '[^A-Za-z0-9_-]' AND NOT EXISTS(SELECT 1 FROM platform.publication_routes r WHERE r.path=s.path)";
const PAGE: i64 = 1000;
#[derive(Serialize, Deserialize, FromRow)]
pub struct Preferences {
    pub revision: i32,
    pub openai_search: bool,
    pub openai_training: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub expected_revision: i32,
    pub openai_search: bool,
    pub openai_training: bool,
}
pub async fn read(State(a): State<App>, h: HeaderMap) -> Result<Json<Preferences>, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?;
    who.require("discovery.read")?;
    Ok(Json(
        sqlx::query_as(PREFS)
            .fetch_one(&a.identity.admins.pool)
            .await?,
    ))
}
pub async fn save(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<Input>,
) -> Result<Json<Preferences>, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?;
    who.require("discovery.write")?;
    let mut tx = a.identity.admins.pool.begin().await?;
    let result:Preferences=sqlx::query_as("UPDATE cms.publication_crawlers SET revision=revision+1,openai_search=$1,openai_training=$2 WHERE singleton AND revision=$3 RETURNING revision,openai_search,openai_training")
 .bind(i.openai_search).bind(i.openai_training).bind(i.expected_revision).fetch_optional(&mut *tx).await?.ok_or(Error::Conflict)?;
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(who.user.id),
        "discovery.crawlers.updated",
        Uuid::from_u128(0xd15c0),
        serde_json::to_value(&result).unwrap(),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(result))
}
const PUBLIC_RULES:&str="Allow: /\nDisallow: /api/\nDisallow: /v1/\nDisallow: /health\nDisallow: /ready\nDisallow: /metrics\nDisallow: /openapi\nAllow: /api/v1/catalog/media/*/content\nDisallow: /compare\nDisallow: /cart\nDisallow: /checkout\nDisallow: /account\nDisallow: /admin\nDisallow: /preview\nDisallow: /search\nDisallow: /assistant\nDisallow: /support\nDisallow: /login\nDisallow: /register\nDisallow: /verify\nDisallow: /forgot-password\nDisallow: /reset-password\nDisallow: /delivery-location\nDisallow: /*?*theme_preview=\nDisallow: /*?*shop=\n";
pub fn robots(policy: &EffectivePolicy, p: &Preferences) -> String {
    if policy.environment != "production" {
        return "User-agent: *\nDisallow: /\n".into();
    }
    // Keep public documents fetchable when noindex applies, allowing removal from an old index.
    let mut out = format!("User-agent: *\n{PUBLIC_RULES}");
    let registry: Vec<serde_json::Value> =
        serde_json::from_str(REGISTRY).expect("validated bundled crawler registry");
    for rule in registry.iter().filter(|r| r["agent"] != "*") {
        let agent = rule["agent"].as_str().expect("registry agent");
        let enabled = match rule["control"].as_str() {
            Some("openai_search") => p.openai_search,
            Some("openai_training") => p.openai_training,
            _ => false,
        };
        out.push_str(&format!(
            "\nUser-agent: {agent}\n{}",
            if policy.state == "INDEXABLE" && enabled {
                PUBLIC_RULES
            } else {
                "Disallow: /\n"
            }
        ));
    }
    if policy.state == "INDEXABLE" {
        if let Some(origin) = &policy.canonical_origin {
            out.push_str(&format!("\nSitemap: {}sitemap.xml\n", origin));
        }
    }
    out
}
fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn document(root: &str, entries: String) -> String {
    format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<{root} xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">{entries}</{root}>\n")
}
fn response(status: StatusCode, body: String, mime: &str, id: Uuid) -> Response {
    (
        status,
        [
            ("content-type", mime),
            ("cache-control", "no-store"),
            ("x-robots-tag", "noindex, nofollow"),
            ("x-publication-installation-id", &id.to_string()),
        ],
        body,
    )
        .into_response()
}
pub async fn handler(State(a): State<App>, req: Request) -> Response {
    if !a.deployment.accepts_host(req.headers()) {
        tracing::warn!(event="publication_response",code="unknown_canonical_host",installation_id=?a.deployment.installation_id);
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    }
    if req.uri().query().is_some() {
        return StatusCode::NOT_FOUND.into_response();
    }
    match tokio::time::timeout(
        std::time::Duration::from_secs(20),
        generate(&a, req.uri().path()),
    )
    .await
    {
        Ok(Ok(r)) => r,
        _ => {
            tracing::warn!(event="publication_response",code="sitemap_generation_failure",installation_id=?a.deployment.installation_id);
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        }
    }
}
async fn generate(a: &App, path: &str) -> Result<Response, sqlx::Error> {
    let mut tx = a.identity.admins.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='15000ms'")
        .execute(&mut *tx)
        .await?;
    let settings: Settings = sqlx::query_as(SELECT).fetch_one(&mut *tx).await?;
    let id: Uuid = sqlx::query_scalar(
        "SELECT installation_id FROM platform.publication_installation WHERE singleton",
    )
    .fetch_one(&mut *tx)
    .await?;
    if a.deployment.installation_id != Some(id) {
        return Ok(StatusCode::SERVICE_UNAVAILABLE.into_response());
    }
    let policy = a.deployment.resolve(&settings);
    if path == "/robots.txt" {
        let prefs: Preferences = sqlx::query_as(PREFS).fetch_one(&mut *tx).await?;
        return Ok(response(
            StatusCode::OK,
            robots(&policy, &prefs),
            "text/plain; charset=utf-8",
            id,
        ));
    }
    let Some(context) = Context::from_installation(&a.deployment, &settings, id)
        .filter(|_| policy.state == "INDEXABLE")
    else {
        return Ok(response(
            StatusCode::NOT_FOUND,
            "Discovery is disabled\n".into(),
            "text/plain",
            id,
        ));
    };
    let origin = context.resource("/", 1).unwrap().url;
    if path == "/llms.txt" {
        return Ok(response(
            StatusCode::NOT_FOUND,
            "llms.txt is not published by this installation\n".into(),
            "text/plain",
            id,
        ));
    }
    if path == "/sitemap.xml" {
        let mut entries = format!(
            "<sitemap><loc>{}sitemaps/home.xml</loc></sitemap>",
            xml(&origin)
        );
        let mut total = 1;
        for kind in ["products", "categories", "content"] {
            // Windowing stays in PostgreSQL; only bounded partition anchors enter application memory.
            let query=format!("SELECT id FROM (SELECT id,row_number() OVER(ORDER BY id) AS n {ELIGIBLE}) q WHERE (n-1)%$2=0 ORDER BY id LIMIT 20001");
            let anchors: Vec<Uuid> = sqlx::query_scalar(&query)
                .bind(kind)
                .bind(PAGE)
                .fetch_all(&mut *tx)
                .await?;
            if anchors.len() > 20000 {
                return Ok(StatusCode::SERVICE_UNAVAILABLE.into_response());
            }
            total += anchors.len();
            if total > 50_000 {
                return Ok(StatusCode::SERVICE_UNAVAILABLE.into_response());
            }
            for (index, anchor) in anchors.iter().enumerate() {
                let upper = anchors
                    .get(index + 1)
                    .map(|v| v.simple().to_string())
                    .unwrap_or_else(|| "end".into());
                let anchor = anchor.simple();
                entries.push_str(&format!(
                    "<sitemap><loc>{}sitemaps/{kind}-{anchor}-{upper}.xml</loc></sitemap>",
                    xml(&origin)
                ));
            }
        }
        if entries.len() > 3_500_000 {
            return Ok(StatusCode::SERVICE_UNAVAILABLE.into_response());
        }
        return Ok(response(
            StatusCode::OK,
            document("sitemapindex", entries),
            "application/xml; charset=utf-8",
            id,
        ));
    }
    if path == "/sitemaps/home.xml" {
        let route = super::canonical::resolve(&mut tx, "/").await?;
        let entries = if route.status == 200 {
            let lastmod: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar("SELECT changed_at FROM platform.publication_state WHERE kind='home' AND fingerprint<>'deleted'").fetch_optional(&mut *tx).await?;
            format!(
                "<url><loc>{}</loc>{}</url>",
                xml(&origin),
                lastmod
                    .map(|t| format!("<lastmod>{}</lastmod>", t.to_rfc3339()))
                    .unwrap_or_default()
            )
        } else {
            String::new()
        };
        return Ok(response(
            StatusCode::OK,
            document("urlset", entries),
            "application/xml; charset=utf-8",
            id,
        ));
    }
    let Some(part) = path
        .strip_prefix("/sitemaps/")
        .and_then(|s| s.strip_suffix(".xml"))
    else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };
    let Some((kind, key)) = part.split_once('-') else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };
    if !["products", "categories", "content"].contains(&kind) {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let Some((lower, upper)) = key.split_once('-') else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };
    let Ok(anchor) = Uuid::parse_str(lower) else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };
    if lower != anchor.simple().to_string() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let end = if upper == "end" {
        None
    } else {
        let Ok(value) = Uuid::parse_str(upper) else {
            return Ok(StatusCode::NOT_FOUND.into_response());
        };
        if upper != value.simple().to_string() || value <= anchor {
            return Ok(StatusCode::NOT_FOUND.into_response());
        }
        Some(value)
    };
    let query = format!("SELECT path,lastmod {ELIGIBLE} AND id >= $2 AND ($3::uuid IS NULL OR id < $3) ORDER BY id LIMIT $4");
    let rows: Vec<(String, Option<chrono::DateTime<chrono::Utc>>)> = sqlx::query_as(&query)
        .bind(kind)
        .bind(anchor)
        .bind(end)
        .bind(PAGE + 1)
        .fetch_all(&mut *tx)
        .await?;
    // Stale boundaries after catalogue growth must fail explicitly, never silently omit URLs.
    if rows.len() > PAGE as usize {
        return Ok(StatusCode::SERVICE_UNAVAILABLE.into_response());
    }
    let mut entries = String::new();
    for (path, lastmod) in rows {
        if let Some(c) = context.resource(&path, 1) {
            entries.push_str(&format!(
                "<url><loc>{}</loc>{}</url>",
                xml(&c.sitemap),
                lastmod
                    .map(|t| format!("<lastmod>{}</lastmod>", t.to_rfc3339()))
                    .unwrap_or_default()
            ));
        }
    }
    Ok(response(
        StatusCode::OK,
        document("urlset", entries),
        "application/xml; charset=utf-8",
        id,
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registry_has_separate_verified_controls() {
        let v: serde_json::Value = serde_json::from_str(REGISTRY).unwrap();
        assert_eq!(v.as_array().unwrap().len(), 3);
        assert_eq!(v[1]["agent"], "OAI-SearchBot");
        assert_eq!(v[2]["purpose"], "training");
        for r in v.as_array().unwrap() {
            assert!(r["source"].as_str().unwrap().starts_with("https://"));
            assert_eq!(r["verified"], "2026-09-21");
        }
    }
    #[test]
    fn escapes_xml() {
        assert_eq!(xml("<&\"'>"), "&lt;&amp;&quot;&apos;&gt;");
    }
}
