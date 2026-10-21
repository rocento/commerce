//! Revocable R2 authority. Confirmation, spend and the cart effect share one transaction.
use crate::{shopping::Proposal, *};
use chrono::{DateTime, Duration, Utc};
use serde_json::Value;
pub const VERSION: &str = "1.0.0";
pub const BROWSER_AGENT: Uuid = Uuid::from_u128(9);
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Scope {
    #[serde(rename = "cart.read")]
    Read,
    #[serde(rename = "cart.propose")]
    Propose,
    #[serde(rename = "cart.apply")]
    Apply,
    #[serde(rename = "order.place")]
    Place,
    #[serde(rename = "payment.authorize")]
    Payment,
    #[serde(rename = "order.refund")]
    Refund,
}
impl Scope {
    pub fn code(self) -> &'static str {
        match self {
            Self::Read => "cart.read",
            Self::Propose => "cart.propose",
            Self::Apply => "cart.apply",
            Self::Place => "order.place",
            Self::Payment => "payment.authorize",
            Self::Refund => "order.refund",
        }
    }
    pub fn supported(self) -> bool {
        matches!(self, Self::Read | Self::Propose | Self::Apply)
    }
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct Configuration {
    pub tenant_id: Option<Uuid>,
    pub enabled: bool,
    pub signed_http_enabled: bool,
    pub denied_scopes: Vec<String>,
    pub policy_version: String,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct Agent {
    pub entity_id: i64,
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub name: String,
    pub protocol: String,
    pub enabled: bool,
    #[serde(skip_serializing)]
    pub public_key: Option<String>,
    pub key_fingerprint: String,
    pub allowed_scopes: Vec<String>,
    pub max_requests: i32,
    pub max_daily_actions: i32,
    #[serde(with = "rust_decimal::serde::str")]
    pub max_daily_amount: Decimal,
    pub currency: String,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub agent_id: Uuid,
    pub customer_id: Option<Uuid>,
    pub session_id: Option<Uuid>,
    pub cart_id: Uuid,
    pub channel: String,
    pub nonce: Uuid,
    pub key_fingerprint: String,
    pub allowed_scopes: Vec<String>,
    pub denied_scopes: Vec<String>,
    pub product_ids: Vec<Uuid>,
    pub category_ids: Vec<Uuid>,
    pub location_id: Option<Uuid>,
    #[serde(with = "rust_decimal::serde::str")]
    pub max_amount: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub max_total: Decimal,
    pub currency: String,
    pub max_actions: i32,
    pub used_actions: i32,
    #[serde(with = "rust_decimal::serde::str")]
    pub spent: Decimal,
    pub confirmation_required: bool,
    pub policy_version: String,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct Action {
    pub id: Uuid,
    pub grant_id: Uuid,
    pub tenant_id: Uuid,
    pub agent_id: Uuid,
    pub cart_id: Uuid,
    pub proposal_id: Uuid,
    pub idempotency_key: Uuid,
    pub action: String,
    pub risk: String,
    pub fingerprint: String,
    pub expected_revision: i64,
    pub state: String,
    #[serde(with = "rust_decimal::serde::str")]
    pub amount: Decimal,
    pub currency: String,
    pub confirmed_at: DateTime<Utc>,
    pub confirmation_session: Option<Uuid>,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub failure_code: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GrantInput {
    pub agent_id: Uuid,
    pub allowed_scopes: Vec<Scope>,
    pub denied_scopes: Vec<Scope>,
    pub product_ids: Vec<Uuid>,
    pub category_ids: Vec<Uuid>,
    pub location_id: Option<Uuid>,
    #[serde(with = "rust_decimal::serde::str")]
    pub max_amount: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub max_total: Decimal,
    pub currency: String,
    pub max_actions: i32,
    pub duration_seconds: i64,
}
pub async fn configuration(pool: &PgPool) -> Result<Configuration> {
    Ok(sqlx::query_as("SELECT tenant_id,enabled,signed_http_enabled,denied_scopes,policy_version FROM cart_checkout.trust_configuration WHERE singleton").fetch_one(pool).await?)
}
pub async fn config_in(tx: &mut Tx<'_>) -> Result<Configuration> {
    Ok(sqlx::query_as("SELECT tenant_id,enabled,signed_http_enabled,denied_scopes,policy_version FROM cart_checkout.trust_configuration WHERE singleton FOR SHARE").fetch_one(&mut **tx).await?)
}
pub async fn agent(tx: &mut Tx<'_>, tenant: Uuid, id: Uuid) -> Result<Agent> {
    sqlx::query_as("SELECT id,entity_id,tenant_id,name,protocol,enabled,public_key,key_fingerprint,allowed_scopes,max_requests,max_daily_actions,max_daily_amount,currency FROM cart_checkout.trust_agents WHERE id=$1 AND tenant_id=$2 FOR UPDATE").bind(id).bind(tenant).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}
pub async fn grant(tx: &mut Tx<'_>, id: Uuid) -> Result<Grant> {
    sqlx::query_as("SELECT * FROM cart_checkout.delegation_grants WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
pub async fn validate(tx: &mut Tx<'_>, g: &Grant, a: &Agent, scope: Scope) -> Result<()> {
    let config = config_in(tx).await?;
    if !scope.supported()
        || !config.enabled
        || config.tenant_id != Some(g.tenant_id)
        || config.policy_version != g.policy_version
        || !a.enabled
        || a.tenant_id != g.tenant_id
        || a.id != g.agent_id
        || a.key_fingerprint != g.key_fingerprint
        || a.protocol != g.channel
        || g.expires_at <= Utc::now()
        || g.revoked_at.is_some()
        || !g.allowed_scopes.iter().any(|v| v == scope.code())
        || !a.allowed_scopes.iter().any(|v| v == scope.code())
        || g.denied_scopes
            .iter()
            .chain(&config.denied_scopes)
            .any(|v| v == scope.code())
        || (g.channel == "signed_http" && !config.signed_http_enabled)
    {
        return Err(Error::Forbidden);
    }
    if let (Some(customer), Some(session)) = (g.customer_id, g.session_id) {
        // A concurrent logout and execution serialize on the same live session row.
        sqlx::query("SELECT id FROM customers.sessions WHERE id=$1 AND customer_id=$2 AND expires_at>now() FOR SHARE").bind(session).bind(customer).fetch_optional(&mut **tx).await?.ok_or(Error::Unauthorized)?;
    } else if g.customer_id.is_some() || g.session_id.is_some() || g.channel != "browser" {
        return Err(Error::Forbidden);
    }
    Ok(())
}
pub fn fingerprint(p: &Proposal) -> String {
    // Fixed, canonical material projection excludes timestamps, reasoning and volatile availability counts.
    infra_auth::digest(&json!({"version":VERSION,"proposal":p.id,"task":p.draft.task_id,"task_revision":p.draft.task_revision,"cart_revision":p.draft.source_revision,"location":p.draft.location_id,"goal":p.draft.goal,"selections":p.draft.selections,"items":p.resulting_items,"market_facts":p.market_facts,"totals":p.after,"recurring":false,"payment_commitment":false}).to_string())
}
pub async fn material(
    tx: &mut Tx<'_>,
    cart: Uuid,
    customer: Option<Uuid>,
    p: &Proposal,
) -> Result<String> {
    let location: Value = if let Some(id) = p.draft.location_id {
        sqlx::query_scalar("SELECT to_jsonb(l)-'updated_at'-'created_at'-'is_default'-'entity_id' FROM customers.customer_locations l WHERE id=$1 AND customer_id=$2 FOR SHARE").bind(id).bind(customer).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)?
    } else {
        sqlx::query_scalar("SELECT jsonb_build_object('latitude',delivery_latitude,'longitude',delivery_longitude) FROM cart_checkout.carts WHERE id=$1").bind(cart).fetch_one(&mut **tx).await?
    };
    Ok(infra_auth::digest(
        &json!({"proposal":fingerprint(p),"destination":location}).to_string(),
    ))
}
pub async fn record_proposal(
    tx: &mut Tx<'_>,
    cart: Uuid,
    customer: Option<Uuid>,
    p: &Proposal,
) -> Result<()> {
    if config_in(tx).await?.enabled {
        let digest = material(tx, cart, customer, p).await?;
        sqlx::query("UPDATE cart_checkout.basket_proposals SET trust_fingerprint=$2 WHERE id=$1")
            .bind(p.id)
            .bind(digest)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}
pub async fn limits(tx: &mut Tx<'_>, g: &Grant, a: &Agent, p: &Proposal) -> Result<Decimal> {
    let amount: Decimal = p
        .after
        .merchandise_total
        .parse()
        .map_err(|_| Error::Internal)?;
    if amount < Decimal::ZERO
        || amount > g.max_amount
        || g.spent + amount > g.max_total
        || g.used_actions >= g.max_actions
        || p.after.currency != g.currency
        || a.currency != g.currency
        || g.location_id
            .is_some_and(|v| p.draft.location_id != Some(v))
    {
        return Err(Error::Forbidden);
    }
    for item in &p.resulting_items {
        if item.currency != g.currency
            || (!g.product_ids.is_empty() && !g.product_ids.contains(&item.product_id))
        {
            return Err(Error::Forbidden);
        }
        if !g.category_ids.is_empty() {
            let category: Uuid = sqlx::query_scalar(
                "SELECT category_id FROM catalog.storefront_products WHERE id=$1 AND active",
            )
            .bind(item.product_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or(Error::NotFound)?;
            if !g.category_ids.contains(&category) {
                return Err(Error::Forbidden);
            }
        }
    }
    let (count,spent):(i64,Decimal)=sqlx::query_as("SELECT count(*),COALESCE(sum(amount) FILTER (WHERE currency=$3),0) FROM cart_checkout.agent_actions WHERE tenant_id=$1 AND agent_id=$2 AND state='committed' AND updated_at>=date_trunc('day',now())").bind(g.tenant_id).bind(a.id).bind(&a.currency).fetch_one(&mut **tx).await?;
    if count >= a.max_daily_actions as i64 || spent + amount > a.max_daily_amount {
        return Err(Error::Forbidden);
    }
    Ok(amount)
}
pub async fn issue(
    tx: &mut Tx<'_>,
    tenant: Uuid,
    cart: Uuid,
    customer: Option<Uuid>,
    session: Option<Uuid>,
    input: GrantInput,
) -> Result<Grant> {
    let config = config_in(tx).await?;
    let a = agent(tx, tenant, input.agent_id).await?;
    if !config.enabled
        || config.tenant_id != Some(tenant)
        || !a.enabled
        || input.allowed_scopes.is_empty()
        || input.allowed_scopes.len() > 3
        || input.denied_scopes.len() > 6
        || input.allowed_scopes.iter().any(|s| {
            !s.supported()
                || !a.allowed_scopes.iter().any(|v| v == s.code())
                || config.denied_scopes.iter().any(|v| v == s.code())
        })
        || input.product_ids.len() > 100
        || input.category_ids.len() > 50
        || !(1..=100).contains(&input.max_actions)
        || !(30..=900).contains(&input.duration_seconds)
        || input.max_amount < Decimal::ZERO
        || input.max_total < input.max_amount
        || input.max_total > a.max_daily_amount
        || input.currency != a.currency
        || input.max_amount.scale() > 2
        || input.max_total.scale() > 2
        || (a.protocol == "signed_http"
            && (!config.signed_http_enabled || customer.is_none() || session.is_none()))
    {
        return Err(Error::Forbidden);
    }
    if let Some(location) = input.location_id {
        let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers.customer_locations WHERE id=$1 AND customer_id=$2)").bind(location).bind(customer).fetch_one(&mut **tx).await?;
        if !valid {
            return Err(Error::NotFound);
        }
    }
    crate::Service::shopping_owner(tx, cart, customer).await?;
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM cart_checkout.delegation_grants WHERE cart_id=$1 AND revoked_at IS NULL AND expires_at>now()").bind(cart).fetch_one(&mut **tx).await?;
    if count >= 100 {
        return Err(Error::RateLimited);
    }
    let id = Uuid::new_v4();
    let now = Utc::now();
    let g:Grant=sqlx::query_as("INSERT INTO cart_checkout.delegation_grants(id,tenant_id,agent_id,customer_id,session_id,cart_id,channel,nonce,key_fingerprint,allowed_scopes,denied_scopes,product_ids,category_ids,location_id,max_amount,max_total,currency,max_actions,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *")
 .bind(id).bind(tenant).bind(a.id).bind(customer).bind(session).bind(cart).bind(&a.protocol).bind(Uuid::new_v4()).bind(&a.key_fingerprint).bind(input.allowed_scopes.iter().map(|s|s.code().to_string()).collect::<Vec<_>>()).bind(input.denied_scopes.iter().map(|s|s.code().to_string()).collect::<Vec<_>>()).bind(input.product_ids).bind(input.category_ids).bind(input.location_id).bind(input.max_amount).bind(input.max_total).bind(input.currency).bind(input.max_actions).bind(now).bind(now+Duration::seconds(input.duration_seconds)).fetch_one(&mut **tx).await?;
    infra_events::record(
        tx,
        "trust.grant_issued",
        json!({"grant_id":id,"agent_id":a.id,"tenant_id":tenant,"policy_version":VERSION}),
    )
    .await?;
    Ok(g)
}
pub struct ConfirmationRequest {
    pub tenant: Uuid,
    pub cart: Uuid,
    pub customer: Option<Uuid>,
    pub session: Option<Uuid>,
    pub proposal: Uuid,
    pub key: Uuid,
    pub external: Option<Uuid>,
}

pub async fn confirm(pool: &PgPool, request: ConfirmationRequest) -> Result<Option<Action>> {
    let ConfirmationRequest {
        tenant,
        cart,
        customer,
        session,
        proposal,
        key,
        external,
    } = request;
    let mut tx = domain_inventory::begin(pool).await?;
    let timer = infra_observability::OperationTimer::new(
        infra_observability::Operation::InventoryTransaction,
    );
    let config = config_in(&mut tx).await?;
    if !config.enabled {
        if external.is_some() {
            return Err(Error::Forbidden);
        }
        return Ok(None);
    }
    if config.tenant_id != Some(tenant) {
        return Err(Error::Forbidden);
    }
    crate::Service::shopping_owner(&mut tx, cart, customer).await?;
    let quote: Value = sqlx::query_scalar(
        "SELECT quote FROM cart_checkout.basket_proposals WHERE id=$1 AND cart_id=$2 FOR UPDATE",
    )
    .bind(proposal)
    .bind(cart)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;
    let p: Proposal = serde_json::from_value(quote).map_err(|_| Error::Internal)?;
    let existing: Option<Action> = sqlx::query_as(
        "SELECT * FROM cart_checkout.agent_actions WHERE cart_id=$1 AND proposal_id=$2",
    )
    .bind(cart)
    .bind(proposal)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(action) = existing {
        if action.idempotency_key != key
            || action.fingerprint != material(&mut tx, cart, customer, &p).await?
            || external.is_some_and(|g| g != action.grant_id)
        {
            return Err(Error::Conflict);
        }
        return Ok(Some(action));
    }
    let digest = material(&mut tx, cart, customer, &p).await?;
    let stored: Option<String> = sqlx::query_scalar(
        "SELECT trust_fingerprint FROM cart_checkout.basket_proposals WHERE id=$1",
    )
    .bind(p.id)
    .fetch_one(&mut *tx)
    .await?;
    if stored.as_deref() != Some(&digest) {
        return Err(Error::Invalid("Delivery terms changed or this quote predates trust controls. Review a fresh proposal.".into()));
    }
    if !p.can_apply || p.applied || p.expires_at <= Utc::now() {
        return Err(Error::Conflict);
    }
    let g = if let Some(id) = external {
        let g = grant(&mut tx, id).await?;
        if g.tenant_id != tenant || g.cart_id != cart || g.customer_id != customer {
            return Err(Error::NotFound);
        }
        g
    } else {
        sqlx::query("INSERT INTO cart_checkout.trust_agents(id,tenant_id,name,protocol,enabled,key_fingerprint,allowed_scopes,max_requests,max_daily_actions,max_daily_amount,currency) VALUES($1,$2,'Rocento shopping assistant','browser',true,'browser-session-v1',ARRAY['cart.read','cart.propose','cart.apply'],120,1000,1000000000000,$3) ON CONFLICT(id) DO NOTHING").bind(BROWSER_AGENT).bind(tenant).bind(&p.after.currency).execute(&mut *tx).await?;
        let amount: Decimal = p
            .after
            .merchandise_total
            .parse()
            .map_err(|_| Error::Internal)?;
        issue(
            &mut tx,
            tenant,
            cart,
            customer,
            session,
            GrantInput {
                agent_id: BROWSER_AGENT,
                allowed_scopes: vec![Scope::Apply],
                denied_scopes: vec![Scope::Place, Scope::Payment, Scope::Refund],
                product_ids: p.resulting_items.iter().map(|v| v.product_id).collect(),
                category_ids: vec![],
                location_id: p.draft.location_id,
                max_amount: amount,
                max_total: amount,
                currency: p.after.currency.clone(),
                max_actions: 1,
                duration_seconds: 300,
            },
        )
        .await?
    };
    let a = agent(&mut tx, tenant, g.agent_id).await?;
    validate(&mut tx, &g, &a, Scope::Apply).await?;
    let amount = limits(&mut tx, &g, &a, &p).await?;
    let action:Action=sqlx::query_as("INSERT INTO cart_checkout.agent_actions(id,grant_id,tenant_id,agent_id,cart_id,proposal_id,idempotency_key,action,risk,fingerprint,expected_revision,state,amount,currency,confirmed_at,confirmation_session,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'cart.apply','R2',$8,$9,'authorized',$10,$11,now(),$12,$13) RETURNING *").bind(Uuid::new_v4()).bind(g.id).bind(tenant).bind(a.id).bind(cart).bind(proposal).bind(key).bind(digest).bind(p.draft.source_revision).bind(amount).bind(&p.after.currency).bind(session).bind(p.expires_at.min(g.expires_at)).fetch_one(&mut *tx).await?;
    infra_events::record(&mut tx,"trust.action_confirmed",json!({"action_id":action.id,"grant_id":g.id,"agent_id":a.id,"tenant_id":tenant,"fingerprint":action.fingerprint,"risk":"R2","policy_version":VERSION})).await?;
    let committed = tx.commit().await;
    timer.finish(if committed.is_ok() {
        infra_observability::OperationResult::Success
    } else {
        infra_observability::OperationResult::Error
    });
    committed?;
    Ok(Some(action))
}
/// Called under the existing inventory lock, before checking an already-applied proposal.
pub async fn authorize(
    tx: &mut Tx<'_>,
    cart: Uuid,
    customer: Option<Uuid>,
    proposal: Uuid,
    key: Uuid,
    strict: bool,
) -> Result<Option<Action>> {
    let config = config_in(tx).await?;
    if !config.enabled {
        return if strict {
            Err(Error::Forbidden)
        } else {
            Ok(None)
        };
    }
    let action:Action=sqlx::query_as("SELECT * FROM cart_checkout.agent_actions WHERE cart_id=$1 AND proposal_id=$2 AND idempotency_key=$3 FOR UPDATE").bind(cart).bind(proposal).bind(key).fetch_optional(&mut **tx).await?.ok_or(Error::Forbidden)?;
    let g = grant(tx, action.grant_id).await?;
    let a = agent(tx, action.tenant_id, action.agent_id).await?;
    if g.cart_id != cart
        || g.customer_id != customer
        || action.tenant_id != g.tenant_id
        || !["authorized", "committed"].contains(&action.state.as_str())
    {
        return Err(Error::Forbidden);
    }
    validate(tx, &g, &a, Scope::Apply).await?;
    if action.state == "committed" {
        return Ok(Some(action));
    }
    if action.expires_at <= Utc::now() {
        return Err(Error::Invalid(
            "Confirmation expired. Review and confirm a fresh proposal.".into(),
        ));
    }
    let quote: Value = sqlx::query_scalar(
        "SELECT quote FROM cart_checkout.basket_proposals WHERE id=$1 AND cart_id=$2",
    )
    .bind(proposal)
    .bind(cart)
    .fetch_one(&mut **tx)
    .await?;
    let p: Proposal = serde_json::from_value(quote).map_err(|_| Error::Internal)?;
    if action.fingerprint != material(tx, cart, customer, &p).await?
        || action.expected_revision != p.draft.source_revision
    {
        return Err(Error::Conflict);
    }
    limits(tx, &g, &a, &p).await?;
    sqlx::query(
        "UPDATE cart_checkout.agent_actions SET state='executing',updated_at=now() WHERE id=$1",
    )
    .bind(action.id)
    .execute(&mut **tx)
    .await?;
    Ok(Some(action))
}
pub async fn committed(tx: &mut Tx<'_>, action: Option<&Action>) -> Result<()> {
    if let Some(a) = action {
        sqlx::query("UPDATE cart_checkout.delegation_grants SET spent=spent+$2,used_actions=used_actions+1 WHERE id=$1").bind(a.grant_id).bind(a.amount).execute(&mut **tx).await?;
        sqlx::query("UPDATE cart_checkout.agent_actions SET state='committed',updated_at=now(),failure_code=NULL WHERE id=$1 AND state='executing'").bind(a.id).execute(&mut **tx).await?;
        infra_events::record(tx,"trust.action_committed",json!({"action_id":a.id,"grant_id":a.grant_id,"tenant_id":a.tenant_id,"fingerprint":a.fingerprint})).await?;
    }
    Ok(())
}
fn known_failure(error: &Error) -> bool {
    matches!(
        error,
        Error::Invalid(_)
            | Error::Conflict
            | Error::Forbidden
            | Error::Unauthorized
            | Error::NotFound
    ) || crate::error::StaleProposal::from_error(error).is_some()
}

pub async fn failed(
    pool: &PgPool,
    cart: Uuid,
    customer: Option<Uuid>,
    proposal: Uuid,
    key: Uuid,
    error: &Error,
) {
    let known = known_failure(error);
    // The effect and committed marker are atomic. Never overwrite a successful commit after a lost response.
    if let Ok(mut tx) = pool.begin().await {
        let changed=sqlx::query_as::<_,(Uuid,Uuid)>("UPDATE cart_checkout.agent_actions SET state=$3,failure_code=$4,updated_at=now() WHERE cart_id=$1 AND idempotency_key=$2 AND state IN ('authorized','executing') AND proposal_id=$5 AND EXISTS(SELECT 1 FROM cart_checkout.delegation_grants g WHERE g.id=grant_id AND g.customer_id IS NOT DISTINCT FROM $6) RETURNING id,tenant_id").bind(cart).bind(key).bind(if known{"failed"}else{"indeterminate"}).bind(if known{"authorization_or_material_terms_changed"}else{"outcome_requires_status_lookup"}).bind(proposal).bind(customer).fetch_optional(&mut *tx).await;
        if let Ok(Some((id, tenant))) = changed {
            if infra_events::record(&mut tx,"trust.action_stopped",json!({"action_id":id,"tenant_id":tenant,"state":if known{"failed"}else{"indeterminate"}})).await.is_ok(){let _=tx.commit().await;}
        }
    }
}

/// Inventory serialization prevents a status lookup racing a transaction whose response was lost.
pub async fn status(pool: &PgPool, tenant: Uuid, cart: Uuid, id: Uuid) -> Result<Action> {
    let mut tx = domain_inventory::begin(pool).await?;
    let timer = infra_observability::OperationTimer::new(
        infra_observability::Operation::InventoryTransaction,
    );
    let mut a:Action=sqlx::query_as("SELECT * FROM cart_checkout.agent_actions WHERE id=$1 AND tenant_id=$2 AND cart_id=$3 FOR UPDATE").bind(id).bind(tenant).bind(cart).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    let applied: Option<Uuid> = sqlx::query_scalar(
        "SELECT applied_key FROM cart_checkout.basket_proposals WHERE id=$1 AND cart_id=$2",
    )
    .bind(a.proposal_id)
    .bind(cart)
    .fetch_one(&mut *tx)
    .await?;
    let next = if applied == Some(a.idempotency_key) {
        "committed"
    } else if a.state == "indeterminate" || a.state == "executing" {
        "failed"
    } else if a.state == "authorized" && a.expires_at <= Utc::now() {
        "expired"
    } else {
        &a.state
    };
    if next != a.state {
        a=sqlx::query_as("UPDATE cart_checkout.agent_actions SET state=$2,updated_at=now() WHERE id=$1 RETURNING *").bind(a.id).bind(next).fetch_one(&mut *tx).await?;
        infra_events::record(
            &mut tx,
            "trust.action_reconciled",
            json!({"action_id":a.id,"state":a.state,"tenant_id":tenant}),
        )
        .await?;
    }
    let committed = tx.commit().await;
    timer.finish(if committed.is_ok() {
        infra_observability::OperationResult::Success
    } else {
        infra_observability::OperationResult::Error
    });
    committed?;
    Ok(a)
}

#[cfg(test)]
mod failure_tests {
    use super::*;
    use crate::error::StaleProposal;

    #[test]
    fn typed_stale_failures_remain_definite_delegation_failures() {
        for cause in [
            StaleProposal::CartRevisionChanged,
            StaleProposal::ProposalUnavailable,
            StaleProposal::QuoteFactsChanged,
        ] {
            assert!(known_failure(&cause.into()));
        }
        assert!(known_failure(&Error::Invalid("invalid action".into())));
        assert!(!known_failure(&Error::Internal));
        assert!(!known_failure(&Error::Business(Box::new(
            std::io::Error::other("unrecognized business failure"),
        ))));
    }
}
