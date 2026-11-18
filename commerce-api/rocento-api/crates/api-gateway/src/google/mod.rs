//! Google HTTP admission and fixed-host provider adapters.
mod merchant;
use crate::identity::{self, ApiError};
use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use domain_admin_operations::google::{Config, Input, Service};
use infra_auth::{secrets::Vault, Error};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
#[derive(Clone)]
pub struct App {
    pub identity: identity::App,
    pub service: Service,
    pub publication: crate::discoverability::App,
    pub http: reqwest::Client,
}
impl App {
    pub fn new(
        identity: identity::App,
        deployment: crate::public_commerce::policy::Deployment,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let vault = match std::env::var("GOOGLE_CREDENTIAL_KEY") {
            Ok(s) if s.is_empty() => None,
            Ok(s) => Some(
                Vault::from_hex(&s)
                    .map_err(|_| "GOOGLE_CREDENTIAL_KEY must contain 64 hexadecimal characters")?,
            ),
            Err(std::env::VarError::NotPresent) => None,
            Err(_) => return Err("Invalid GOOGLE_CREDENTIAL_KEY".into()),
        };
        Ok(Self {
            service: Service {
                pool: identity.admins.pool.clone(),
                vault,
            },
            publication: crate::discoverability::App {
                identity: identity.clone(),
                deployment,
            },
            identity,
            http: reqwest::Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(12))
                .build()?,
        })
    }
}
fn response(v: impl serde::Serialize) -> Response {
    let mut r = Json(v).into_response();
    r.headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    r
}
pub fn router(a: App) -> Router {
    Router::new()
        .route("/v1/admin/integrations/google", get(list))
        .route(
            "/v1/admin/integrations/google/{service}",
            axum::routing::put(save),
        )
        .route(
            "/v1/admin/integrations/google/{service}/disconnect",
            post(disconnect),
        )
        .route("/v1/admin/integrations/google/{service}/test", post(test))
        .route("/v1/admin/integrations/google/merchant/sync", post(sync))
        .route("/v1/integrations/google/public", get(public))
        .layer(axum::extract::DefaultBodyLimit::max(24576))
        .layer(axum::middleware::from_fn_with_state(
            a.identity.clone(),
            identity::policy,
        ))
        .with_state(a)
}
async fn authorize(a: &App, h: &HeaderMap, write: bool) -> Result<uuid::Uuid, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(h, "admin_session"))
        .await?;
    who.require(if write {
        "integrations.google.write"
    } else {
        "integrations.google.read"
    })?;
    if write {
        infra_auth::rate_limit(
            &a.service.pool,
            &format!("google-settings:{}", who.user.id),
            30,
        )
        .await?;
    }
    Ok(who.user.id)
}
async fn list(State(a): State<App>, h: HeaderMap) -> Result<Response, ApiError> {
    authorize(&a, &h, false).await?;
    Ok(response(a.service.list().await?))
}
async fn save(
    State(a): State<App>,
    Path(service): Path<String>,
    h: HeaderMap,
    input: Result<Json<Input>, JsonRejection>,
) -> Result<Response, ApiError> {
    let actor = authorize(&a, &h, true).await?;
    let Json(input) = input.map_err(|_| Error::Invalid("Invalid Google settings".into()))?;
    // Validate the actual signing key before persisting, without echoing parser errors.
    if service == "merchant" {
        if let Some(s) = input.credential.as_ref().filter(|s| !s.is_empty()) {
            merchant::signing_key(s)
                .map_err(|_| Error::Invalid("Invalid Google service account signing key".into()))?;
        }
    }
    Ok(response(a.service.save(actor, &service, input).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Revision {
    expected_revision: i64,
}
async fn disconnect(
    State(a): State<App>,
    Path(service): Path<String>,
    h: HeaderMap,
    Json(i): Json<Revision>,
) -> Result<Response, ApiError> {
    let actor = authorize(&a, &h, true).await?;
    Ok(response(
        a.service
            .disconnect(actor, &service, i.expected_revision)
            .await?,
    ))
}
async fn test(
    State(a): State<App>,
    Path(service): Path<String>,
    h: HeaderMap,
    Json(i): Json<Revision>,
) -> Result<Response, ApiError> {
    let actor = authorize(&a, &h, true).await?;
    let mut tx = a.service.pool.begin().await?;
    let (revision,config,secret):(i64,Value,Option<Vec<u8>>)=sqlx::query_as("SELECT revision,config,credentials FROM platform.google_connections WHERE service=$1 FOR UPDATE").bind(&service).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    if revision != i.expected_revision {
        return Err(Error::Conflict.into());
    }
    let config: Config = serde_json::from_value(config).map_err(|_| Error::Internal)?;
    let (ok, code, message) = if service == "merchant" {
        let result = if let Some(bytes) = secret {
            match a.service.decode(&service, &bytes).await {
                Ok(key) => merchant::test(&a, &config, &key).await,
                Err(_) => Err("credential_unavailable"),
            }
        } else {
            Err("credential_missing")
        };
        match result {Ok(())=>(true,"verified","Merchant account and API data source are accessible. Product approval is managed by Google."),Err(code)=>(false,code,"Google could not verify this connection. Check the key, account access, API data source and developer registration.")}
    } else if service == "ga4" {
        (!config.measurement_id.is_empty(),"configuration_checked","Measurement ID format checked. Verify real events in GA4 DebugView after allowing analytics in the storefront.")
    } else {
        (secret.is_some(),"browser_test_required","Maps browser keys must be tested on an allowed storefront domain. Open address search there to verify API access and referrer restrictions.")
    };
    sqlx::query(
        "UPDATE platform.google_connections SET checked_at=now(),check_code=$2 WHERE service=$1",
    )
    .bind(&service)
    .bind(code)
    .execute(&mut *tx)
    .await?;
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(actor),
        "integrations.google.tested",
        uuid::Uuid::nil(),
        json!({"service":service,"code":code}),
    )
    .await?;
    tx.commit().await?;
    Ok(response(json!({"ok":ok,"code":code,"message":message})))
}
async fn sync(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<Revision>,
) -> Result<Response, ApiError> {
    let actor = authorize(&a, &h, true).await?;
    let mut tx = a.service.pool.begin().await?;
    let changed=sqlx::query("UPDATE platform.google_connections SET next_sync_at=now(),sync_code='queued' WHERE service='merchant' AND enabled AND revision=$1").bind(i.expected_revision).execute(&mut *tx).await?.rows_affected();
    if changed != 1 {
        return Err(Error::Conflict.into());
    }
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(actor),
        "integrations.google.sync_requested",
        uuid::Uuid::nil(),
        json!({}),
    )
    .await?;
    tx.commit().await?;
    Ok(response(
        json!({"ok":true,"code":"queued","message":"Catalog sync queued. Check sync status for completion."}),
    ))
}
async fn public(State(a): State<App>) -> Result<Response, ApiError> {
    let rows:Vec<(String,Value,Option<Vec<u8>>)>=sqlx::query_as("SELECT service,config,credentials FROM platform.google_connections WHERE enabled AND service IN ('ga4','maps')").fetch_all(&a.service.pool).await?;
    let mut id = None;
    let mut key = None;
    for (service, config, secret) in rows {
        if service == "ga4" {
            id = config["measurement_id"].as_str().map(str::to_owned);
        } else if let Some(bytes) = secret {
            key = a.service.decode("maps", &bytes).await.ok();
        }
    }
    // A Maps browser API key is intentionally public, never a server/service-account key.
    Ok(response(
        json!({"measurement_id":id,"maps_browser_key":key}),
    ))
}
pub async fn worker(a: App) {
    loop {
        if merchant::step(&a).await.is_err() {
            tracing::warn!("Google Merchant sync temporarily unavailable");
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
