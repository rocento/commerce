//! Per-installation public discovery identity and publication controls.
use crate::identity::{self, ApiError};
use axum::{
    extract::{rejection::JsonRejection, State},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use infra_auth::Error;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

const SETTINGS_ID: Uuid = Uuid::from_u128(0xd15c0);
#[derive(Clone)]
pub struct App {
    pub identity: identity::App,
    pub deployment: crate::public_commerce::policy::Deployment,
}

#[derive(Clone, Serialize, Deserialize, FromRow)]
pub struct Settings {
    pub revision: i32,
    pub enabled: bool,
    pub indexing_enabled: bool,
    pub llms_txt_enabled: bool,
    pub site_name: String,
    pub organization_name: String,
    pub canonical_url: Option<String>,
    pub description: String,
    pub default_locale: String,
    pub feature_pages_enabled: bool,
    pub industry_pages_enabled: bool,
    pub docs_enabled: bool,
    pub pricing_page_enabled: bool,
    pub security_page_enabled: bool,
    pub integrations_page_enabled: bool,
    pub changelog_enabled: bool,
    pub grocery_demo_url: Option<String>,
    pub jewelry_demo_url: Option<String>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub expected_revision: i32,
    pub enabled: bool,
    pub indexing_enabled: bool,
    pub llms_txt_enabled: bool,
    pub site_name: String,
    pub organization_name: String,
    pub canonical_url: Option<String>,
    pub description: String,
    pub default_locale: String,
    pub feature_pages_enabled: bool,
    pub industry_pages_enabled: bool,
    pub docs_enabled: bool,
    pub pricing_page_enabled: bool,
    pub security_page_enabled: bool,
    pub integrations_page_enabled: bool,
    pub changelog_enabled: bool,
    pub grocery_demo_url: Option<String>,
    pub jewelry_demo_url: Option<String>,
}
impl Input {
    fn validate(&mut self) -> Result<(), Error> {
        self.site_name = self.site_name.trim().to_owned();
        self.organization_name = self.organization_name.trim().to_owned();
        self.description = self.description.trim().to_owned();
        self.canonical_url = clean_url(self.canonical_url.take())?;
        self.grocery_demo_url = clean_url(self.grocery_demo_url.take())?;
        self.jewelry_demo_url = clean_url(self.jewelry_demo_url.take())?;
        if self.expected_revision < 1
            || self.site_name.is_empty()
            || self.site_name.len() > 120
            || self.organization_name.is_empty()
            || self.organization_name.len() > 120
            || self.description.len() > 500
            || !valid_locale(&self.default_locale)
        {
            return Err(Error::Invalid(
                "Check the discovery identity, locale, description and revision".into(),
            ));
        }
        if self.indexing_enabled && (!self.enabled || self.canonical_url.is_none()) {
            return Err(Error::Invalid(
                "Enable discoverability and set a canonical HTTPS URL before allowing indexing"
                    .into(),
            ));
        }
        Ok(())
    }
}
fn valid_locale(v: &str) -> bool {
    let b = v.as_bytes();
    (b.len() == 2 && b.iter().all(u8::is_ascii_lowercase))
        || (b.len() == 5
            && b[0..2].iter().all(u8::is_ascii_lowercase)
            && b[2] == b'-'
            && b[3..5].iter().all(u8::is_ascii_uppercase))
}
fn clean_url(value: Option<String>) -> Result<Option<String>, Error> {
    let Some(v) = value.map(|x| x.trim().to_owned()).filter(|x| !x.is_empty()) else {
        return Ok(None);
    };
    if v.len() > 2048 {
        return Err(Error::Invalid(
            "Discovery URLs must be shorter than 2048 characters".into(),
        ));
    }
    let url =
        Url::parse(&v).map_err(|_| Error::Invalid("Enter a valid HTTPS discovery URL".into()))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::Invalid("Discovery URLs must be public HTTPS URLs without credentials, query strings or fragments".into()));
    }
    Ok(Some(url.to_string()))
}
pub(crate) const SELECT:&str="SELECT revision,enabled,indexing_enabled,llms_txt_enabled,site_name,organization_name,canonical_url,description,default_locale,feature_pages_enabled,industry_pages_enabled,docs_enabled,pricing_page_enabled,security_page_enabled,integrations_page_enabled,changelog_enabled,grocery_demo_url,jewelry_demo_url,updated_at FROM cms.discoverability_settings WHERE singleton";
pub fn router(identity: identity::App) -> Router {
    router_with_deployment(identity, Default::default())
}
pub fn router_with_deployment(
    identity: identity::App,
    deployment: crate::public_commerce::policy::Deployment,
) -> Router {
    Router::new()
        .route(
            "/v1/discovery/attribution",
            axum::routing::post(crate::public_commerce::attribution::ingest)
                .layer(axum::extract::DefaultBodyLimit::max(4096)),
        )
        .route(
            "/v1/admin/discovery/analytics",
            get(crate::public_commerce::attribution::analytics),
        )
        .route(
            "/v1/admin/discovery/health",
            get(crate::public_commerce::health::read),
        )
        .route(
            "/v1/admin/discovery/feeds",
            get(crate::public_commerce::feeds::status),
        )
        .route(
            "/v1/admin/discovery/feeds/export",
            get(crate::public_commerce::feeds::export),
        )
        .route(
            "/v1/admin/discovery/feeds/reconcile",
            axum::routing::post(crate::public_commerce::feeds::rebuild),
        )
        .route("/v1/discovery/config", get(public))
        .route(
            "/v1/admin/discovery/entity",
            get(crate::public_commerce::entity::read).put(crate::public_commerce::entity::save),
        )
        .route("/v1/admin/discovery/config", get(read).put(save))
        .route("/v1/admin/discovery/effective", get(effective))
        .route(
            "/v1/admin/discovery/metadata",
            get(crate::public_commerce::metadata::read).put(crate::public_commerce::metadata::save),
        )
        .route(
            "/v1/admin/discovery/metadata/preview",
            axum::routing::post(crate::public_commerce::metadata::preview),
        )
        .route(
            "/robots.txt",
            get(crate::public_commerce::discovery::handler),
        )
        .route(
            "/sitemap.xml",
            get(crate::public_commerce::discovery::handler),
        )
        .route(
            "/sitemaps/{partition}",
            get(crate::public_commerce::discovery::handler),
        )
        .route("/llms.txt", get(crate::public_commerce::discovery::handler))
        .route(
            "/v1/admin/discovery/crawlers",
            get(crate::public_commerce::discovery::read)
                .put(crate::public_commerce::discovery::save),
        )
        .route(
            "/v1/publication/snapshot",
            get(crate::public_commerce::snapshot::handler),
        )
        .fallback(shell)
        .layer(axum::middleware::from_fn_with_state(
            identity.clone(),
            identity::policy,
        ))
        .layer(axum::middleware::from_fn(publication_headers))
        .with_state(App {
            identity,
            deployment,
        })
}
async fn publication_headers(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert("cache-control", "no-store".parse().unwrap());
    if !headers.contains_key("x-robots-tag") {
        headers.insert("x-robots-tag", "noindex, nofollow".parse().unwrap());
    }
    response
}
async fn effective(
    State(a): State<App>,
    headers: HeaderMap,
) -> Result<Json<crate::public_commerce::policy::EffectivePolicy>, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(&headers, "admin_session"))
        .await?;
    who.require("discovery.read")?;
    let Json(settings) = public(State(a.clone())).await?;
    let preferences = sqlx::query_as(crate::public_commerce::discovery::PREFS)
        .fetch_one(&a.identity.admins.pool)
        .await?;
    let mut policy = a.deployment.resolve(&settings);
    policy.robots_txt = crate::public_commerce::discovery::robots(&policy, &preferences);
    Ok(Json(policy))
}
fn blocked(status: axum::http::StatusCode) -> axum::response::Response {
    use axum::response::IntoResponse;
    (
        status,
        [
            ("x-robots-tag", "noindex, nofollow"),
            ("cache-control", "no-store"),
        ],
        "Publication unavailable",
    )
        .into_response()
}
async fn shell(State(a): State<App>, request: axum::extract::Request) -> axum::response::Response {
    use axum::{http::StatusCode, response::IntoResponse};
    if !a.deployment.accepts_host(request.headers()) {
        return blocked(StatusCode::MISDIRECTED_REQUEST);
    }
    if request.method() != axum::http::Method::GET && request.method() != axum::http::Method::HEAD {
        return blocked(StatusCode::METHOD_NOT_ALLOWED);
    }
    // Never turn an unknown API request into a storefront document.
    if request.uri().path().starts_with("/v1/") || request.uri().path().starts_with("/api/") {
        return blocked(StatusCode::NOT_FOUND);
    }
    let path = request.uri().path();
    let private = private_page(path);
    let interactive = crate::public_commerce::snapshot::valid_path(path)
        && request.uri().query().is_some_and(|query| {
            reqwest::Url::parse(&format!("https://placeholder.test/?{query}")).is_ok_and(|url| {
                url.query_pairs().any(|(key, value)| {
                    key == "theme_preview"
                        || key == "interface_preview"
                        || (key == "shop" && value == "1")
                })
            })
        });
    if !private && !interactive {
        // Anonymous documents must be served by the bound Node renderer, never an empty 200 shell.
        return blocked(if crate::public_commerce::snapshot::valid_path(path) {
            StatusCode::SERVICE_UNAVAILABLE
        } else {
            StatusCode::NOT_FOUND
        });
    }
    let Some(template) = &a.deployment.html else {
        return blocked(StatusCode::SERVICE_UNAVAILABLE);
    };
    let html = template.replacen(
        "</head>",
        "<meta name=\"robots\" content=\"noindex, nofollow\"/></head>",
        1,
    );
    (
        [
            ("content-type", "text/html; charset=utf-8"),
            ("x-robots-tag", "noindex, nofollow"),
        ],
        html,
    )
        .into_response()
}
fn private_page(path: &str) -> bool {
    if [
        "/search",
        "/compare",
        "/cart",
        "/checkout",
        "/delivery-location",
        "/login",
        "/register",
        "/verify",
        "/forgot-password",
        "/reset-password",
        "/assistant",
        "/support",
        "/account",
    ]
    .contains(&path)
    {
        return true;
    }
    path.strip_prefix("/account/").is_some_and(|rest| {
        let parts: Vec<_> = rest.split('/').collect();
        !parts.is_empty()
            && parts.len() <= 2
            && ["wishlist", "tickets", "orders", "locations", "addresses"].contains(&parts[0])
            && parts.iter().all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
    })
}

async fn public(State(a): State<App>) -> Result<Json<Settings>, ApiError> {
    Ok(Json(
        sqlx::query_as(SELECT)
            .fetch_one(&a.identity.admins.pool)
            .await?,
    ))
}
async fn read(State(a): State<App>, headers: HeaderMap) -> Result<Json<Settings>, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(&headers, "admin_session"))
        .await?;
    who.require("discovery.read")?;
    public(State(a)).await
}
async fn save(
    State(a): State<App>,
    headers: HeaderMap,
    input: Result<Json<Input>, JsonRejection>,
) -> Result<Json<Settings>, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(&headers, "admin_session"))
        .await?;
    who.require("discovery.write")?;
    let Json(mut i) =
        input.map_err(|_| Error::Invalid("Invalid discoverability settings".into()))?;
    i.validate()?;
    if !a.deployment.validate_canonical(i.canonical_url.as_deref()) {
        return Err(Error::Invalid(
            "Canonical URL must be a root HTTPS public DNS origin approved for this installation"
                .into(),
        )
        .into());
    }
    let mut tx = a.identity.admins.pool.begin().await?;
    let saved:Option<Settings>=sqlx::query_as("UPDATE cms.discoverability_settings SET revision=revision+1,enabled=$1,indexing_enabled=$2,llms_txt_enabled=$3,site_name=$4,organization_name=$5,canonical_url=$6,description=$7,default_locale=$8,feature_pages_enabled=$9,industry_pages_enabled=$10,docs_enabled=$11,pricing_page_enabled=$12,security_page_enabled=$13,integrations_page_enabled=$14,changelog_enabled=$15,grocery_demo_url=$16,jewelry_demo_url=$17,updated_by=$18,updated_at=clock_timestamp() WHERE singleton AND revision=$19 RETURNING revision,enabled,indexing_enabled,llms_txt_enabled,site_name,organization_name,canonical_url,description,default_locale,feature_pages_enabled,industry_pages_enabled,docs_enabled,pricing_page_enabled,security_page_enabled,integrations_page_enabled,changelog_enabled,grocery_demo_url,jewelry_demo_url,updated_at")
 .bind(i.enabled).bind(i.indexing_enabled).bind(i.llms_txt_enabled).bind(i.site_name).bind(i.organization_name).bind(i.canonical_url).bind(i.description).bind(i.default_locale).bind(i.feature_pages_enabled).bind(i.industry_pages_enabled).bind(i.docs_enabled).bind(i.pricing_page_enabled).bind(i.security_page_enabled).bind(i.integrations_page_enabled).bind(i.changelog_enabled).bind(i.grocery_demo_url).bind(i.jewelry_demo_url).bind(who.user.id).bind(i.expected_revision).fetch_optional(&mut *tx).await?;
    let saved = saved.ok_or(Error::Conflict)?;
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(who.user.id),
        "discovery.settings.updated",
        SETTINGS_ID,
        serde_json::json!({"revision":saved.revision,"indexing_enabled":saved.indexing_enabled}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(saved))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validation_requires_canonical_url_for_indexing() {
        let mut i = Input {
            expected_revision: 1,
            enabled: true,
            indexing_enabled: true,
            llms_txt_enabled: true,
            site_name: "Client".into(),
            organization_name: "Client".into(),
            canonical_url: None,
            description: "".into(),
            default_locale: "en".into(),
            feature_pages_enabled: true,
            industry_pages_enabled: true,
            docs_enabled: true,
            pricing_page_enabled: false,
            security_page_enabled: true,
            integrations_page_enabled: true,
            changelog_enabled: true,
            grocery_demo_url: None,
            jewelry_demo_url: None,
        };
        assert!(i.validate().is_err());
        i.canonical_url = Some("https://shop.example/".into());
        assert!(i.validate().is_ok())
    }
}

#[test]
fn comparison_is_an_interactive_shopper_page() {
    assert!(private_page("/compare"));
    assert!(!private_page("/compare/unknown"));
}
