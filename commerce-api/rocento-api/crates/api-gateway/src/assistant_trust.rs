//! Browser consent and a separately signed, cart-only external-agent protocol.
use super::App;
use crate::identity::{self, ApiError};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use domain_cart_checkout::{shopping::Draft, trust as t};
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;
type Result<T> = std::result::Result<T, ApiError>;
pub fn routes() -> Router<App> {
    Router::new()
        .route("/v1/cart/trust", get(history))
        .route("/v1/cart/trust/confirm", post(confirm))
        .route("/v1/cart/trust/grants", post(issue))
        .route("/v1/cart/trust/grants/{id}", axum::routing::delete(revoke))
        .route("/v1/cart/trust/actions/{id}", get(status))
        .route("/v1/agents/capabilities", get(capabilities))
        .route("/v1/agents/actions", post(external))
        .route(
            "/v1/admin/assistant/trust",
            get(admin_read).put(admin_write),
        )
        .route(
            "/v1/admin/assistant/trust/agents/{id}",
            axum::routing::put(register),
        )
}
fn response(v: impl Serialize) -> Response {
    let mut r = Json(v).into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    r
}
async fn owner(a: &App, h: &HeaderMap) -> Result<(Uuid, Option<Uuid>, Option<Uuid>)> {
    let customer = crate::cart::customer(&a.identity, h).await?;
    let session = if customer.is_some() {
        Some(
            a.identity
                .customers
                .security
                .decode(identity::bearer(h)?)?
                .sid,
        )
    } else {
        None
    };
    let cart = a
        .identity
        .cart
        .shopping_cart(customer, identity::cookie(h, "guest_cart"))
        .await?;
    infra_auth::rate_limit(
        &a.identity.customers.pool,
        &format!("trust-browser:{}:{cart}", a.tenant),
        120,
    )
    .await?;
    Ok((cart, customer, session))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Confirmation {
    proposal_id: Uuid,
    idempotency_key: Uuid,
    grant_id: Option<Uuid>,
}
async fn confirm(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<Confirmation>,
) -> Result<Response> {
    let (cart, customer, session) = owner(&a, &h).await?;
    let action = t::confirm(
        &a.identity.customers.pool,
        t::ConfirmationRequest {
            tenant: a.tenant,
            cart,
            customer,
            session,
            proposal: i.proposal_id,
            key: i.idempotency_key,
            external: i.grant_id,
        },
    )
    .await?;
    Ok(response(
        json!({"schema_version":t::VERSION,"enabled":action.is_some(),"action":action}),
    ))
}
async fn history(State(a): State<App>, h: HeaderMap) -> Result<Response> {
    let (cart, _, _) = owner(&a, &h).await?;
    let pool = &a.identity.customers.pool;
    let config = t::configuration(pool).await?;
    let grants:Vec<t::Grant>=sqlx::query_as("SELECT * FROM cart_checkout.delegation_grants WHERE tenant_id=$1 AND cart_id=$2 ORDER BY issued_at DESC LIMIT 100").bind(a.tenant).bind(cart).fetch_all(pool).await?;
    let actions:Vec<t::Action>=sqlx::query_as("SELECT * FROM cart_checkout.agent_actions WHERE tenant_id=$1 AND cart_id=$2 ORDER BY created_at DESC LIMIT 100").bind(a.tenant).bind(cart).fetch_all(pool).await?;
    Ok(response(
        json!({"schema_version":t::VERSION,"enabled":config.enabled && config.tenant_id==Some(a.tenant),"grants":grants,"actions":actions}),
    ))
}
async fn issue(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<t::GrantInput>,
) -> Result<Response> {
    let (cart, customer, session) = owner(&a, &h).await?;
    if customer.is_none() || i.agent_id == t::BROWSER_AGENT {
        return Err(Error::Forbidden.into());
    }
    let mut tx = domain_inventory::begin(&a.identity.customers.pool).await?;
    let g = t::issue(&mut tx, a.tenant, cart, customer, session, i).await?;
    let agent = t::agent(&mut tx, a.tenant, g.agent_id).await?;
    let scope = if g.allowed_scopes.contains(&"cart.read".into()) {
        t::Scope::Read
    } else if g.allowed_scopes.contains(&"cart.propose".into()) {
        t::Scope::Propose
    } else {
        t::Scope::Apply
    };
    t::validate(&mut tx, &g, &agent, scope).await?;
    tx.commit().await?;
    Ok(response(g))
}
async fn revoke(State(a): State<App>, h: HeaderMap, Path(id): Path<Uuid>) -> Result<Response> {
    let (cart, _, _) = owner(&a, &h).await?;
    let mut tx = domain_inventory::begin(&a.identity.customers.pool).await?;
    let changed=sqlx::query("UPDATE cart_checkout.delegation_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND tenant_id=$2 AND cart_id=$3").bind(id).bind(a.tenant).bind(cart).execute(&mut *tx).await?.rows_affected();
    if changed == 0 {
        return Err(Error::NotFound.into());
    }
    infra_events::record(
        &mut tx,
        "trust.grant_revoked",
        json!({"grant_id":id,"tenant_id":a.tenant}),
    )
    .await?;
    tx.commit().await?;
    Ok(response(json!({"status":"revoked"})))
}
async fn status(State(a): State<App>, h: HeaderMap, Path(id): Path<Uuid>) -> Result<Response> {
    let (cart, _, _) = owner(&a, &h).await?;
    Ok(response(
        t::status(&a.identity.customers.pool, a.tenant, cart, id).await?,
    ))
}
async fn capabilities(State(a): State<App>) -> Result<Response> {
    let c = t::configuration(&a.identity.customers.pool).await?;
    let agents:Vec<(Uuid,String,Vec<String>)>=sqlx::query_as("SELECT id,name,allowed_scopes FROM cart_checkout.trust_agents WHERE tenant_id=$1 AND enabled AND protocol='signed_http' ORDER BY name LIMIT 100").bind(a.tenant).fetch_all(&a.identity.customers.pool).await?;
    Ok(response(
        json!({"schema_version":t::VERSION,"enabled":c.enabled && c.signed_http_enabled && c.tenant_id==Some(a.tenant),"supported_scopes":["cart.read","cart.propose","cart.apply"],"denied_scopes":c.denied_scopes,"protocol":"signed_http","confirmation_required":true,"financial_actions_enabled":false,"agents":agents.into_iter().map(|(id,name,scopes)|json!({"id":id,"name":name,"allowed_scopes":scopes})).collect::<Vec<_>>()}),
    ))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Proof {
    pub iss: String,
    pub aud: String,
    pub tenant_id: Uuid,
    pub agent_id: Uuid,
    pub grant_id: Uuid,
    pub grant_nonce: Uuid,
    pub jti: Uuid,
    pub iat: i64,
    pub exp: i64,
    pub body_sha256: String,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    Read,
    Propose { draft: Box<Draft> },
    Apply { action_id: Uuid },
    Status { action_id: Uuid },
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub grant_id: Uuid,
    pub request: Operation,
}
async fn external(State(a): State<App>, h: HeaderMap, body: Bytes) -> Result<Response> {
    let i: Request =
        serde_json::from_slice(&body).map_err(|_| Error::Invalid("Invalid agent action".into()))?;
    let scope = match i.request {
        Operation::Read | Operation::Status { .. } => t::Scope::Read,
        Operation::Propose { .. } => t::Scope::Propose,
        Operation::Apply { .. } => t::Scope::Apply,
    };
    let pool = &a.identity.customers.pool;
    let mut tx = domain_inventory::begin(pool).await?;
    let g = t::grant(&mut tx, i.grant_id).await?;
    if g.tenant_id != a.tenant || g.channel != "signed_http" {
        return Err(Error::Forbidden.into());
    }
    let agent = t::agent(&mut tx, a.tenant, g.agent_id).await?;
    let key = jsonwebtoken::DecodingKey::from_rsa_pem(
        agent
            .public_key
            .as_ref()
            .ok_or(Error::Forbidden)?
            .as_bytes(),
    )
    .map_err(|_| Error::Forbidden)?;
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_issuer(&["rocento-registered-agent"]);
    validation.set_audience(&["rocento-cart-actions-v1"]);
    validation.leeway = 0;
    let proof = jsonwebtoken::decode::<Proof>(identity::bearer(&h)?, &key, &validation)
        .map_err(|_| Error::Unauthorized)?
        .claims;
    let now = chrono::Utc::now().timestamp();
    if proof.tenant_id != a.tenant
        || proof.agent_id != agent.id
        || proof.grant_id != g.id
        || proof.grant_nonce != g.nonce
        || proof.iat > now
        || proof.iat < now - 60
        || proof.exp <= proof.iat
        || proof.exp - proof.iat > 60
        || proof.body_sha256
            != infra_auth::digest(std::str::from_utf8(&body).map_err(|_| Error::Forbidden)?)
    {
        return Err(Error::Forbidden.into());
    }
    t::validate(&mut tx, &g, &agent, scope).await?;
    // Rate counters use their own transaction; no grant/customer credentials enter logs.
    infra_auth::rate_limit(
        pool,
        &format!("trust-agent:{}:{}", a.tenant, agent.id),
        agent.max_requests,
    )
    .await?;
    sqlx::query("DELETE FROM cart_checkout.agent_request_nonces WHERE expires_at<now()")
        .execute(&mut *tx)
        .await?;
    let fresh=sqlx::query("INSERT INTO cart_checkout.agent_request_nonces(agent_id,nonce,expires_at) VALUES($1,$2,to_timestamp($3)) ON CONFLICT DO NOTHING").bind(agent.id).bind(proof.jti).bind(proof.exp as f64).execute(&mut *tx).await?.rows_affected();
    if fresh != 1 {
        return Err(Error::Conflict.into());
    }
    infra_events::record(&mut tx,"trust.agent_request_authorized",json!({"tenant_id":a.tenant,"agent_id":agent.id,"grant_id":g.id,"request_id":proof.jti,"scope":scope.code()})).await?;
    let action = if let Operation::Apply { action_id } | Operation::Status { action_id } = i.request
    {
        Some(sqlx::query_as::<_,t::Action>("SELECT * FROM cart_checkout.agent_actions WHERE id=$1 AND grant_id=$2 AND tenant_id=$3 AND cart_id=$4").bind(action_id).bind(g.id).bind(a.tenant).bind(g.cart_id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?)
    } else {
        None
    };
    tx.commit().await?;
    let result = match i.request {
        Operation::Read => {
            json!({"cart":a.identity.cart.read_customer(g.customer_id.ok_or(Error::Forbidden)?).await?})
        }
        Operation::Propose { draft } => {
            let draft = *draft;
            let p = a
                .identity
                .cart
                .propose(g.cart_id, g.customer_id, draft)
                .await?;
            let mut tx = domain_inventory::begin(pool).await?;
            let fresh = t::grant(&mut tx, g.id).await?;
            let agent = t::agent(&mut tx, a.tenant, g.agent_id).await?;
            t::validate(&mut tx, &fresh, &agent, t::Scope::Propose).await?;
            t::limits(&mut tx, &fresh, &agent, &p).await?;
            tx.commit().await?;
            json!({"proposal":p})
        }
        Operation::Apply { .. } => {
            let action = action.ok_or(Error::Internal)?;
            json!({"cart":a.identity.cart.apply_delegated_proposal(g.cart_id,g.customer_id,"",action.proposal_id,action.idempotency_key,true).await?})
        }
        Operation::Status { .. } => {
            json!({"action":t::status(pool,a.tenant,g.cart_id,action.ok_or(Error::Internal)?.id).await?})
        }
    };
    Ok(response(
        json!({"schema_version":t::VERSION,"result":result}),
    ))
}
async fn admin_read(State(a): State<App>, h: HeaderMap) -> Result<Response> {
    a.identity
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?
        .require("assistant.settings.read")?;
    Ok(response(
        t::configuration(&a.identity.customers.pool).await?,
    ))
}
async fn admin_write(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<t::Configuration>,
) -> Result<Response> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?;
    who.require("assistant.settings.write")?;
    if i.tenant_id != Some(a.tenant)
        || i.policy_version != t::VERSION
        || i.denied_scopes.len() > 6
        || i.denied_scopes
            .iter()
            .any(|s| serde_json::from_value::<t::Scope>(json!(s)).is_err())
    {
        return Err(Error::Invalid("Invalid trust policy".into()).into());
    }
    let mut tx = domain_inventory::begin(&a.identity.customers.pool).await?;
    sqlx::query("UPDATE cart_checkout.trust_configuration SET tenant_id=$1,enabled=$2,signed_http_enabled=$3,denied_scopes=$4 WHERE singleton").bind(a.tenant).bind(i.enabled).bind(i.signed_http_enabled).bind(&i.denied_scopes).execute(&mut *tx).await?;
    domain_admin_iam::Service::audit(&mut tx,Some(who.user.id),"assistant.trust.configuration_changed",a.tenant,json!({"enabled":i.enabled,"signed_http_enabled":i.signed_http_enabled,"denied_scopes":i.denied_scopes})).await?;
    tx.commit().await?;
    Ok(response(i))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Registration {
    name: String,
    enabled: bool,
    public_key: Option<String>,
    allowed_scopes: Vec<t::Scope>,
    max_requests: i32,
    max_daily_actions: i32,
    #[serde(with = "rust_decimal::serde::str")]
    max_daily_amount: rust_decimal::Decimal,
    currency: String,
}
async fn register(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<Registration>,
) -> Result<Response> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?;
    who.require("assistant.settings.write")?;
    infra_auth::bounded(&i.name, "agent name", 100, true)?;
    if i.allowed_scopes.len() > 3
        || i.allowed_scopes.iter().any(|s| !s.supported())
        || !(1..=120).contains(&i.max_requests)
        || !(1..=1000).contains(&i.max_daily_actions)
        || i.max_daily_amount < rust_decimal::Decimal::ZERO
        || i.max_daily_amount.scale() > 2
        || i.currency.len() != 3
        || !i.currency.bytes().all(|c| c.is_ascii_uppercase())
    {
        return Err(Error::Invalid("Invalid agent limits".into()).into());
    }
    let fingerprint = if id == t::BROWSER_AGENT {
        if i.public_key.is_some() {
            return Err(Error::Invalid("Browser agent uses customer sessions".into()).into());
        }
        "browser-session-v1".to_owned()
    } else {
        let key = i
            .public_key
            .as_ref()
            .ok_or(Error::Invalid("Public RSA key required".into()))?;
        if key.contains("PRIVATE KEY") || key.len() > 8192 {
            return Err(Error::Invalid("Public key too large".into()).into());
        }
        jsonwebtoken::DecodingKey::from_rsa_pem(key.as_bytes())
            .map_err(|_| Error::Invalid("Invalid RSA public key".into()))?;
        infra_auth::digest(key)
    };
    let protocol = if id == t::BROWSER_AGENT {
        "browser"
    } else {
        "signed_http"
    };
    let mut tx = domain_inventory::begin(&a.identity.customers.pool).await?;
    let result:t::Agent=sqlx::query_as("INSERT INTO cart_checkout.trust_agents(id,tenant_id,name,protocol,enabled,public_key,key_fingerprint,allowed_scopes,max_requests,max_daily_actions,max_daily_amount,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,enabled=EXCLUDED.enabled,public_key=EXCLUDED.public_key,key_fingerprint=EXCLUDED.key_fingerprint,allowed_scopes=EXCLUDED.allowed_scopes,max_requests=EXCLUDED.max_requests,max_daily_actions=EXCLUDED.max_daily_actions,max_daily_amount=EXCLUDED.max_daily_amount,currency=EXCLUDED.currency WHERE trust_agents.tenant_id=EXCLUDED.tenant_id RETURNING id,entity_id,tenant_id,name,protocol,enabled,public_key,key_fingerprint,allowed_scopes,max_requests,max_daily_actions,max_daily_amount,currency").bind(id).bind(a.tenant).bind(i.name).bind(protocol).bind(i.enabled).bind(i.public_key).bind(fingerprint).bind(i.allowed_scopes.iter().map(|s|s.code().to_string()).collect::<Vec<_>>()).bind(i.max_requests).bind(i.max_daily_actions).bind(i.max_daily_amount).bind(i.currency).fetch_optional(&mut *tx).await?.ok_or(Error::Forbidden)?;
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(who.user.id),
        "assistant.trust.agent_changed",
        id,
        json!({"tenant_id":a.tenant,"enabled":i.enabled,"key_fingerprint":result.key_fingerprint}),
    )
    .await?;
    tx.commit().await?;
    Ok(response(result))
}
