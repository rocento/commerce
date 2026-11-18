//! Meta HTTP admission and delivery. Each App uses exactly one merchant database.
use crate::{
    discoverability,
    identity::{self, ApiError},
    public_commerce::policy::Deployment,
};
use axum::{
    body::Bytes,
    extract::{rejection::JsonRejection, DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use domain_admin_operations::meta::{Config, Input, Service};
use infra_auth::{
    secrets::{secure_equal, verify_meta_signature, Vault},
    Error,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use uuid::Uuid;
#[derive(Clone)]
pub struct App {
    pub identity: identity::App,
    pub service: Service,
    pub deployment: Deployment,
    client: reqwest::Client,
}
pub fn service(pool: sqlx::PgPool) -> Result<Service, Error> {
    let vault = std::env::var("META_CREDENTIAL_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|s| Vault::from_hex(&s))
        .transpose()?;
    Ok(Service { pool, vault })
}
impl App {
    pub fn new(identity: identity::App, deployment: Deployment) -> Result<Self, Error> {
        Ok(Self {
            service: service(identity.admins.pool.clone())?,
            identity,
            deployment,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(12))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| Error::Internal)?,
        })
    }
}
pub fn router(a: App) -> Router {
    let protected = Router::new()
        .route("/v1/admin/integrations/meta", get(read).put(save))
        .route("/v1/admin/integrations/meta/test/{kind}", post(test))
        .route("/v1/admin/integrations/meta/jobs", get(jobs))
        .route("/v1/admin/integrations/meta/whatsapp/test", post(send_test))
        .layer(middleware::from_fn_with_state(
            a.identity.clone(),
            identity::policy,
        ));
    protected
        .merge(
            Router::new()
                .route("/v1/integrations/meta/status", get(public_status))
                .route("/v1/integrations/meta/catalog.csv", get(catalog_feed))
                .route(
                    "/v1/integrations/meta/webhook",
                    get(verify_webhook).post(webhook),
                ),
        )
        .layer(DefaultBodyLimit::max(256 * 1024))
        .with_state(a)
}
fn no_store(value: impl IntoResponse) -> Response {
    let mut r = value.into_response();
    r.headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    r
}
async fn admin(a: &App, h: &HeaderMap, p: &str) -> Result<Uuid, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(h, "admin_session"))
        .await?;
    who.require(p)?;
    Ok(who.user.id)
}
async fn read(State(a): State<App>, h: HeaderMap) -> Result<Response, ApiError> {
    admin(&a, &h, "integrations.meta.read").await?;
    Ok(no_store(Json(a.service.status().await?)))
}
async fn save(
    State(a): State<App>,
    h: HeaderMap,
    i: Result<Json<Input>, JsonRejection>,
) -> Result<Response, ApiError> {
    let actor = admin(&a, &h, "integrations.meta.write").await?;
    infra_auth::rate_limit(&a.service.pool, &format!("meta-config:{actor}"), 30).await?;
    let Json(i) = i.map_err(|_| Error::Invalid("Invalid Meta configuration".into()))?;
    Ok(no_store(Json(a.service.save(actor, i).await?)))
}
async fn public_status(State(a): State<App>) -> Result<Response, ApiError> {
    let s = a.service.status().await?;
    Ok(no_store(Json(
        json!({"whatsapp":s.editable&&s.config.whatsapp_enabled,"conversions":s.editable&&s.config.conversions_enabled}),
    )))
}
fn asset<'a>(c: &'a Config, kind: &str) -> Result<(&'a str, &'static str), Error> {
    match kind {
        "whatsapp" => Ok((&c.phone_number_id, "whatsapp_token")),
        "catalog" => Ok((&c.catalog_id, "catalog_token")),
        "conversions" => Ok((&c.dataset_id, "conversions_token")),
        _ => Err(Error::NotFound),
    }
}
// Request/response bodies and bearer tokens never enter errors or logs.
async fn graph(
    a: &App,
    c: &Config,
    id: &str,
    edge: &str,
    token: &str,
    body: Option<Value>,
) -> Result<Value, &'static str> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("asset_not_configured");
    }
    let url = format!("https://graph.facebook.com/{}/{id}{edge}", c.api_version);
    let r = if let Some(body) = body {
        a.client.post(url).json(&body)
    } else {
        a.client.get(url).query(&[("fields", "id")])
    };
    let mut response = r
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "transport_unknown")?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => "permission_denied",
            429 => "rate_limited",
            400..=499 => "provider_rejected",
            _ => "provider_unavailable",
        });
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "transport_unknown")? {
        if data.len() + chunk.len() > 65536 {
            return Err("response_invalid");
        }
        data.extend(chunk);
    }
    serde_json::from_slice(&data).map_err(|_| "response_invalid")
}
async fn test(
    State(a): State<App>,
    h: HeaderMap,
    Path(kind): Path<String>,
) -> Result<Response, ApiError> {
    let actor = admin(&a, &h, "integrations.meta.write").await?;
    infra_auth::rate_limit(&a.service.pool, &format!("meta-test:{actor}"), 15).await?;
    let s = a.service.status().await?;
    let secrets = a.service.credentials().await?;
    let (id, key) = asset(&s.config, &kind)?;
    let token = secrets
        .get(key)
        .ok_or(Error::Invalid("Save credentials before testing".into()))?;
    let result = graph(&a, &s.config, id, "", token, None).await;
    let ok = result.as_ref().is_ok_and(|v| v["id"].as_str() == Some(id));
    Ok(no_store(Json(
        json!({"ok":ok,"message":if ok {"Asset is accessible. This does not verify message approval, feed ingestion or event delivery."} else {result.err().unwrap_or("asset_mismatch")}}),
    )))
}
async fn jobs(State(a): State<App>, h: HeaderMap) -> Result<Response, ApiError> {
    admin(&a, &h, "integrations.meta.read").await?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'kind',kind,'status',status,'attempts',attempts,'created_at',created_at,'delivery_status',delivery_status,'error_code',error_code) FROM platform.meta_jobs ORDER BY created_at DESC LIMIT 50").fetch_all(&a.service.pool).await?;
    Ok(no_store(Json(rows)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestMessage {
    phone: String,
    consent: bool,
    request_id: Uuid,
}
async fn send_test(
    State(a): State<App>,
    h: HeaderMap,
    i: Result<Json<TestMessage>, JsonRejection>,
) -> Result<Response, ApiError> {
    let actor = admin(&a, &h, "integrations.meta.send").await?;
    let Json(i) = i.map_err(|_| Error::Invalid("Invalid test message".into()))?;
    if !i.consent
        || !i.phone.starts_with('+')
        || !(9..=16).contains(&i.phone.len())
        || i.phone.as_bytes()[1] == b'0'
        || !i.phone[1..].bytes().all(|b| b.is_ascii_digit())
    {
        return Err(Error::Invalid(
            "Confirm recipient consent and use an international phone number".into(),
        )
        .into());
    }
    infra_auth::rate_limit(&a.service.pool, &format!("meta-send:{actor}"), 5).await?;
    let mut tx = a.service.pool.begin().await?;
    sqlx::query("SELECT singleton FROM platform.meta_settings FOR SHARE")
        .execute(&mut *tx)
        .await?;
    let s = a.service.status().await?;
    if !s.config.whatsapp_enabled {
        return Err(Error::Invalid("Enable WhatsApp first".into()).into());
    }
    let payload = template(&s.config, &i.phone, "TEST", "0.00", "USD");
    enqueue(
        &a.service,
        &mut tx,
        "whatsapp",
        &format!("test:{}:{}", actor, i.request_id),
        s.revision,
        payload,
    )
    .await?;
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(actor),
        "integrations.meta.test_message",
        i.request_id,
        json!({}),
    )
    .await?;
    tx.commit().await?;
    Ok(no_store((
        StatusCode::ACCEPTED,
        Json(json!({"queued":true})),
    )))
}
#[derive(Deserialize)]
struct Verify {
    #[serde(rename = "hub.mode")]
    mode: Option<String>,
    #[serde(rename = "hub.verify_token")]
    token: Option<String>,
    #[serde(rename = "hub.challenge")]
    challenge: Option<String>,
}
async fn verify_webhook(
    State(a): State<App>,
    Query(q): Query<Verify>,
) -> Result<Response, ApiError> {
    let secrets = a.service.credentials().await?;
    let expected = secrets
        .get("webhook_verify_token")
        .ok_or(Error::Forbidden)?;
    if q.mode.as_deref() != Some("subscribe")
        || !q
            .token
            .as_deref()
            .is_some_and(|s| secure_equal(s, expected))
        || q.challenge.as_ref().is_none_or(|s| s.len() > 256)
    {
        return Err(Error::Forbidden.into());
    }
    Ok(no_store(q.challenge.unwrap_or_default()))
}
async fn webhook(State(a): State<App>, h: HeaderMap, body: Bytes) -> Result<Response, ApiError> {
    let secrets = a.service.credentials().await?;
    let secret = secrets.get("app_secret").ok_or(Error::Forbidden)?;
    if !verify_meta_signature(
        secret,
        &body,
        h.get("x-hub-signature-256")
            .and_then(|s| s.to_str().ok())
            .unwrap_or(""),
    ) {
        return Err(Error::Forbidden.into());
    }
    let v: Value =
        serde_json::from_slice(&body).map_err(|_| Error::Invalid("Invalid webhook".into()))?;
    let settings = a.service.status().await?;
    if v["object"] != "whatsapp_business_account" {
        return Err(Error::Invalid("Unsupported webhook".into()).into());
    }
    let mut tx = a.service.pool.begin().await?;
    for entry in v["entry"].as_array().into_iter().flatten() {
        if entry["id"].as_str() != Some(&settings.config.waba_id) {
            continue;
        }
        for change in entry["changes"].as_array().into_iter().flatten() {
            let value = &change["value"];
            if value["metadata"]["phone_number_id"].as_str()
                != Some(&settings.config.phone_number_id)
            {
                continue;
            }
            for s in value["statuses"].as_array().into_iter().flatten() {
                if let (Some(id), Some(status)) = (s["id"].as_str(), s["status"].as_str()) {
                    if id.len() <= 256 && ["sent", "delivered", "read", "failed"].contains(&status)
                    {
                        sqlx::query("INSERT INTO platform.meta_delivery_receipts(provider_id,status) VALUES($1,$2) ON CONFLICT(provider_id) DO UPDATE SET status=excluded.status,received_at=now() WHERE (meta_delivery_receipts.status='sent' AND excluded.status IN ('delivered','read','failed')) OR (meta_delivery_receipts.status='delivered' AND excluded.status='read')").bind(id).bind(status).execute(&mut *tx).await?;
                        sqlx::query("UPDATE platform.meta_jobs SET delivery_status=$2 WHERE kind='whatsapp' AND provider_id=$1 AND (delivery_status IS NULL OR (delivery_status='sent' AND $2 IN ('delivered','read','failed')) OR (delivery_status='delivered' AND $2='read'))").bind(id).bind(status).execute(&mut *tx).await?;
                    }
                }
            }
            sqlx::query("UPDATE platform.meta_settings SET last_webhook_at=now() WHERE singleton")
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(no_store(StatusCode::OK))
}
fn template(c: &Config, phone: &str, number: &str, total: &str, currency: &str) -> Value {
    json!({"messaging_product":"whatsapp","to":phone.trim_start_matches('+'),"type":"template","template":{"name":c.confirmation_template,"language":{"code":c.template_language},"components":[{"type":"body","parameters":[{"type":"text","text":number},{"type":"text","text":total},{"type":"text","text":currency}]}]}})
}
async fn enqueue(
    s: &Service,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    kind: &str,
    key: &str,
    revision: i64,
    payload: Value,
) -> Result<(), Error> {
    let bytes = s
        .seal(&serde_json::to_vec(&payload).map_err(|_| Error::Internal)?)
        .await?;
    sqlx::query("INSERT INTO platform.meta_jobs(id,kind,dedupe_key,settings_revision,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(dedupe_key) DO NOTHING").bind(Uuid::new_v4()).bind(kind).bind(key).bind(revision).bind(bytes).execute(&mut **tx).await?;
    Ok(())
}
/// Receipts are saved before checkout; only successfully placed orders create jobs.
type ConsentOrder = (Uuid, Uuid, Uuid, bool, bool, Option<Vec<u8>>, i64);
type PendingJob = (
    Uuid,
    String,
    i64,
    Vec<u8>,
    i32,
    chrono::DateTime<chrono::Utc>,
);
pub async fn prepare_orders(a: &App) -> Result<(), Error> {
    let mut tx = a.service.pool.begin().await?;
    sqlx::query("SELECT singleton FROM platform.meta_settings FOR SHARE")
        .execute(&mut *tx)
        .await?;
    let s = a.service.status().await?;
    let rows:Vec<ConsentOrder>=sqlx::query_as("SELECT c.quote_id,o.id,c.customer_id,c.conversions,c.whatsapp,c.phone_ciphertext,c.settings_revision FROM platform.meta_checkout_consent c JOIN orders.orders o ON o.quote_id=c.quote_id AND o.customer_id=c.customer_id WHERE c.processed_at IS NULL ORDER BY c.created_at LIMIT 10 FOR UPDATE OF c SKIP LOCKED").fetch_all(&mut *tx).await?;
    for (quote, id, customer, conversion, whatsapp, phone, revision) in rows {
        if revision == s.revision && (conversion || whatsapp) {
            let order = domain_orders::Service {
                pool: a.service.pool.clone(),
            }
            .detail(id, Some(customer))
            .await?;
            if order.order.created_at > chrono::Utc::now() - chrono::Duration::days(6)
                && order.order.status != "cancelled"
            {
                if conversion && s.config.conversions_enabled {
                    let event_id = format!("purchase:{id}");
                    let mut payload = json!({"data":[{"event_name":"Purchase","event_time":order.order.created_at.timestamp(),"event_id":event_id,"action_source":"website","user_data":{"external_id":[infra_auth::digest(&format!("{}:{customer}",a.service.context().await?))]},"custom_data":{"currency":order.order.currency,"value":order.order.total.to_string().parse::<serde_json::Number>().map_err(|_|Error::Internal)?,"order_id":id,"content_type":"product","content_ids":order.items.iter().map(|i|i.product_id.to_string()).collect::<Vec<_>>()}}]});
                    if let Some(email) = order.order.contact["email"]
                        .as_str()
                        .filter(|s| !s.trim().is_empty())
                    {
                        payload["data"][0]["user_data"]["em"] =
                            json!([infra_auth::digest(&email.trim().to_lowercase())]);
                    }
                    if let Some(phone) = order.order.contact["mobile_number"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                    {
                        let normalized: String =
                            phone.chars().filter(|c| c.is_ascii_digit()).collect();
                        if !normalized.is_empty() {
                            payload["data"][0]["user_data"]["ph"] =
                                json!([infra_auth::digest(&normalized)]);
                        }
                    }
                    let origin = a
                        .deployment
                        .approved_origin
                        .as_deref()
                        .unwrap_or(&a.identity.customers.security.storefront_url);
                    payload["data"][0]["event_source_url"] =
                        json!(format!("{}/checkout", origin.trim_end_matches('/')));
                    if !s.config.test_event_code.is_empty() {
                        payload["test_event_code"] = json!(s.config.test_event_code);
                    }
                    enqueue(
                        &a.service,
                        &mut tx,
                        "conversions",
                        &event_id,
                        s.revision,
                        payload,
                    )
                    .await?;
                }
                if whatsapp && s.config.whatsapp_enabled {
                    if let Some(phone) = phone {
                        let phone = String::from_utf8(a.service.open(&phone).await?)
                            .map_err(|_| Error::Internal)?;
                        enqueue(
                            &a.service,
                            &mut tx,
                            "whatsapp",
                            &format!("confirmation:{id}"),
                            s.revision,
                            template(
                                &s.config,
                                &phone,
                                &order.order.number.to_string(),
                                &order.order.total.to_string(),
                                &order.order.currency,
                            ),
                        )
                        .await?;
                    }
                }
            }
        }
        sqlx::query("UPDATE platform.meta_checkout_consent SET processed_at=now(),phone_ciphertext=NULL WHERE quote_id=$1").bind(quote).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
pub async fn deliver_one(a: &App) -> Result<bool, Error> {
    let mut tx = a.service.pool.begin().await?;
    // Serialize credential changes against delivery; a save waits at most one request timeout.
    sqlx::query("SELECT singleton FROM platform.meta_settings FOR SHARE")
        .execute(&mut *tx)
        .await?;
    let job:Option<PendingJob>=sqlx::query_as("SELECT id,kind,settings_revision,payload,attempts,created_at FROM platform.meta_jobs WHERE status='pending' AND available_at<=now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED").fetch_optional(&mut *tx).await?;
    let Some((id, kind, revision, bytes, attempts, created)) = job else {
        return Ok(false);
    };
    let s = a.service.status().await?;
    if revision != s.revision
        || (kind == "whatsapp" && !s.config.whatsapp_enabled)
        || (kind == "conversions" && !s.config.conversions_enabled)
        || created < chrono::Utc::now() - chrono::Duration::days(6)
    {
        sqlx::query("UPDATE platform.meta_jobs SET status='cancelled',payload=''::bytea,completed_at=now(),error_code='disabled_changed_or_expired' WHERE id=$1").bind(id).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(true);
    }
    let payload: Value =
        serde_json::from_slice(&a.service.open(&bytes).await?).map_err(|_| Error::Internal)?;
    let secrets = a.service.credentials().await?;
    let (asset, key) = asset(&s.config, &kind)?;
    let token = secrets.get(key).ok_or(Error::Internal)?;
    // WhatsApp has no provider idempotency guarantee. Commit a one-attempt claim first;
    // a crash or timeout is 'unknown', never an automatic duplicate customer message.
    if kind == "whatsapp" {
        sqlx::query("UPDATE platform.meta_jobs SET status='unknown',attempts=attempts+1,error_code='delivery_unconfirmed',payload=''::bytea,completed_at=now() WHERE id=$1").bind(id).execute(&mut *tx).await?;
        tx.commit().await?;
        let result = graph(a, &s.config, asset, "/messages", token, Some(payload)).await;
        finish(&a.service.pool, id, &kind, attempts, result).await?;
    } else {
        let result = graph(a, &s.config, asset, "/events", token, Some(payload)).await;
        // Conversion event_id is stable across retries, enabling provider deduplication.
        finish_in(&mut tx, id, &kind, attempts, result).await?;
        tx.commit().await?;
    }
    Ok(true)
}
async fn finish(
    pool: &sqlx::PgPool,
    id: Uuid,
    kind: &str,
    attempts: i32,
    result: Result<Value, &str>,
) -> Result<(), Error> {
    let mut tx = pool.begin().await?;
    finish_in(&mut tx, id, kind, attempts, result).await?;
    tx.commit().await?;
    Ok(())
}
async fn finish_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    kind: &str,
    attempts: i32,
    result: Result<Value, &str>,
) -> Result<(), Error> {
    let (state, code, provider) = delivery_outcome(kind, attempts, result);
    sqlx::query("UPDATE platform.meta_jobs SET status=$2,error_code=$3,provider_id=$4,delivery_status=(SELECT status FROM platform.meta_delivery_receipts WHERE provider_id=$4),attempts=CASE WHEN kind='whatsapp' THEN attempts ELSE attempts+1 END,available_at=now()+make_interval(secs=>$5),completed_at=CASE WHEN $2='pending' THEN NULL ELSE now() END,payload=CASE WHEN $2='pending' THEN payload ELSE ''::bytea END WHERE id=$1").bind(id).bind(state).bind(code).bind(provider).bind((30_i32*2_i32.pow(attempts.min(7) as u32)) as f64).execute(&mut **tx).await?;
    Ok(())
}
fn delivery_outcome<'a>(
    kind: &str,
    attempts: i32,
    result: Result<Value, &'a str>,
) -> (&'static str, Option<&'a str>, Option<String>) {
    match result {
        Ok(v)
            if kind == "whatsapp"
                && v["messages"][0]["id"]
                    .as_str()
                    .is_some_and(|id| id.len() <= 256) =>
        {
            (
                "accepted",
                None,
                v["messages"][0]["id"].as_str().map(str::to_owned),
            )
        }
        Ok(v) if kind == "conversions" && v["events_received"].as_i64() == Some(1) => {
            ("accepted", None, None)
        }
        Ok(_) => ("unknown", Some("response_invalid"), None),
        Err(code)
            if kind == "conversions"
                && attempts < 7
                && ["transport_unknown", "rate_limited", "provider_unavailable"]
                    .contains(&code) =>
        {
            ("pending", Some(code), None)
        }
        Err(code)
            if kind == "whatsapp"
                && [
                    "transport_unknown",
                    "response_invalid",
                    "provider_unavailable",
                ]
                .contains(&code) =>
        {
            ("unknown", Some(code), None)
        }
        Err(code) => ("failed", Some(code), None),
    }
}
pub async fn worker(a: App) {
    loop {
        if a.service.vault.is_some() {
            if prepare_orders(&a).await.is_err() {
                tracing::warn!(
                    code = "meta_prepare_failed",
                    "Meta order preparation will retry"
                );
            }
            if deliver_one(&a).await.is_err() {
                tracing::warn!(code = "meta_delivery_failed", "Meta delivery cycle failed");
            }
        }
        // Remove abandoned consent and minimize retained diagnostics. No message bodies in history.
        let _=sqlx::query("DELETE FROM platform.meta_delivery_receipts WHERE received_at<now()-interval '30 days'").execute(&a.service.pool).await;
        let _ = sqlx::query(
            "DELETE FROM platform.meta_checkout_consent WHERE created_at<now()-interval '30 days'",
        )
        .execute(&a.service.pool)
        .await;
        let _=sqlx::query("DELETE FROM platform.meta_jobs WHERE created_at<now()-interval '30 days' AND status<>'pending'").execute(&a.service.pool).await;
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}
async fn catalog_feed(State(a): State<App>) -> Result<Response, ApiError> {
    let status = a.service.status().await?;
    if !status.config.catalog_enabled {
        return Err(Error::NotFound.into());
    }
    infra_auth::rate_limit(&a.service.pool, "meta-catalog-feed", 20).await?;
    let settings: discoverability::Settings = sqlx::query_as(discoverability::SELECT)
        .fetch_one(&a.service.pool)
        .await?;
    let installation: Uuid =
        sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
            .fetch_one(&a.service.pool)
            .await?;
    if a.deployment.installation_id != Some(installation) {
        return Err(Error::NotFound.into());
    }
    let effective = a.deployment.resolve(&settings);
    if effective.robots_meta != "index, follow" {
        return Err(Error::NotFound.into());
    }
    let rows:Vec<Value>=sqlx::query_scalar("SELECT f.payload || jsonb_build_object('catalog_in_stock',p.in_stock) FROM platform.publication_reference_feed f JOIN catalog.storefront_products p ON p.id=(f.payload->>'id')::uuid WHERE f.operation='upsert' AND f.payload->>'market'='default' ORDER BY f.item_key LIMIT 10001").fetch_all(&a.service.pool).await?;
    if rows.len() > 10000 {
        return Err(
            Error::Invalid("Catalog exceeds the supported 10000-item feed limit".into()).into(),
        );
    }
    let mut csv = csv::Writer::from_writer(Vec::new());
    csv.write_record([
        "id",
        "title",
        "description",
        "availability",
        "condition",
        "price",
        "link",
        "image_link",
    ])
    .map_err(|_| Error::Internal)?;
    for chunk in rows.chunks(20) {
        let ids: Vec<Uuid> = chunk
            .iter()
            .filter_map(|v| v["id"].as_str()?.parse().ok())
            .collect();
        let available = a.identity.cart.inventory.available_many(&ids, None).await?;
        for v in chunk {
            let Some(row) = catalog_row(v, &available) else {
                continue;
            };
            csv.write_record(row).map_err(|_| Error::Internal)?;
        }
    }
    let bytes = csv.into_inner().map_err(|_| Error::Internal)?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(Error::Invalid("Catalog feed is too large".into()).into());
    }
    sqlx::query("UPDATE platform.meta_settings SET last_feed_at=now() WHERE singleton")
        .execute(&a.service.pool)
        .await?;
    Ok(no_store((
        [
            ("content-type", "text/csv; charset=utf-8"),
            ("x-robots-tag", "noindex"),
        ],
        bytes,
    )))
}
fn catalog_row(
    v: &Value,
    availability: &std::collections::HashMap<Uuid, i64>,
) -> Option<Vec<String>> {
    if !matches!(v["product_type"].as_str()?, "simple" | "variant") {
        return None;
    }
    let id = v["id"].as_str()?;
    let uuid = id.parse::<Uuid>().ok()?;
    let price = v["price"].as_str()?;
    let currency = v["currency"].as_str()?;
    if price.parse::<rust_decimal::Decimal>().ok()? <= rust_decimal::Decimal::ZERO
        || currency.len() != 3
    {
        return None;
    }
    let url = v["url"].as_str()?;
    let image = v["image"]["url"].as_str()?;
    if !url.starts_with("https://") || !image.starts_with("https://") {
        return None;
    }
    Some(vec![
        id.into(),
        v["title"].as_str()?.chars().take(200).collect(),
        v["description"].as_str()?.chars().take(5000).collect(),
        if v["catalog_in_stock"] != false && availability.get(&uuid).copied().unwrap_or(0) > 0 {
            "in stock"
        } else {
            "out of stock"
        }
        .into(),
        "new".into(),
        format!("{price} {currency}"),
        url.into(),
        image.into(),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_omits_ineligible_products_and_preserves_exact_price_and_stock() {
        let id = Uuid::new_v4();
        let mut v = json!({"id":id,"product_type":"simple","title":"Tea, green","description":"Fresh tea","price":"12.50","currency":"EGP","url":"https://shop.example/products/tea","image":{"url":"https://shop.example/image.png"}});
        let available = [(id, 2)].into_iter().collect();
        let row = catalog_row(&v, &available).unwrap();
        assert_eq!(row[0], id.to_string());
        assert_eq!(row[3], "in stock");
        assert_eq!(row[5], "12.50 EGP");
        v["catalog_in_stock"] = json!(false);
        assert_eq!(catalog_row(&v, &available).unwrap()[3], "out of stock");
        v["product_type"] = json!("configurable");
        assert!(catalog_row(&v, &available).is_none());
        v["product_type"] = json!("simple");
        v["price"] = Value::Null;
        assert!(catalog_row(&v, &available).is_none());
        v["price"] = json!("12.50");
        v["image"] = Value::Null;
        assert!(catalog_row(&v, &available).is_none());
    }
    #[test]
    fn retries_do_not_duplicate_ambiguous_whatsapp_sends() {
        assert_eq!(
            delivery_outcome("whatsapp", 0, Err("transport_unknown")).0,
            "unknown"
        );
        assert_eq!(
            delivery_outcome("conversions", 0, Err("transport_unknown")).0,
            "pending"
        );
        assert_eq!(
            delivery_outcome("conversions", 7, Err("transport_unknown")).0,
            "failed"
        );
        assert_eq!(
            delivery_outcome("conversions", 0, Err("permission_denied")).0,
            "failed"
        );
        assert_eq!(
            delivery_outcome("conversions", 0, Ok(json!({"events_received":0}))).0,
            "unknown"
        );
        assert_eq!(
            delivery_outcome("conversions", 0, Ok(json!({"events_received":1}))).0,
            "accepted"
        );
    }
    #[test]
    fn template_is_bound_to_saved_template_and_exact_parameter_order() {
        let c = Config {
            confirmation_template: "order_confirmation".into(),
            template_language: "ar".into(),
            ..Default::default()
        };
        let payload = template(&c, "+201012345678", "123", "12.50", "EGP");
        assert_eq!(payload["to"], "201012345678");
        assert_eq!(payload["template"]["language"]["code"], "ar");
        let p = &payload["template"]["components"][0]["parameters"];
        assert_eq!(p[0]["text"], "123");
        assert_eq!(p[1]["text"], "12.50");
        assert_eq!(p[2]["text"], "EGP");
    }
}
