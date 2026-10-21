//! Installation-bound deletion admission, immutable retention policy, and durable receipts.
use crate::Service;
use chrono::{DateTime, Utc};
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyInput {
    pub legal_entity: String,
    pub jurisdictions: Vec<String>,
    pub financial_days: i32,
    pub retain_contact: bool,
    pub retain_address: bool,
}
impl PolicyInput {
    pub fn validate(&self) -> Result<()> {
        if self.legal_entity.trim().is_empty()
            || self.legal_entity.len() > 200
            || self.jurisdictions.is_empty()
            || self.jurisdictions.len() > 30
            || self
                .jurisdictions
                .iter()
                .any(|x| x.trim().is_empty() || x.len() > 120)
            || !(0..=36525).contains(&self.financial_days)
            || (self.financial_days == 0 && (self.retain_contact || self.retain_address))
        {
            return Err(Error::Invalid(
                "Provide a legal entity, jurisdictions and explicit retention rules".into(),
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, FromRow)]
pub struct Policy {
    pub id: Uuid,
    pub merchant_id: Uuid,
    pub legal_entity: String,
    pub jurisdictions: Vec<String>,
    pub financial_days: i32,
    pub retain_contact: bool,
    pub retain_address: bool,
    pub approved_by: Uuid,
    pub approved_at: DateTime<Utc>,
    pub active: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub request_id: Uuid,
    pub policy_id: Uuid,
    pub receipt_token: String,
    pub password: String,
    pub confirm: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub request_id: Uuid,
    pub receipt_token: String,
}
#[derive(Serialize, FromRow)]
pub struct Status {
    pub id: Uuid,
    pub state: String,
    pub waiting_reason: Option<String>,
    pub requested_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub retained_until: Option<DateTime<Utc>>,
}
#[derive(Clone, FromRow)]
pub struct Job {
    pub id: Uuid,
    pub customer_id: Uuid,
    pub order_ids: Vec<Uuid>,
    pub session_ids: Vec<Uuid>,
    pub cart_ids: Vec<Uuid>,
    pub commerce_erased_at: Option<DateTime<Utc>>,
    pub engagement_erased_at: Option<DateTime<Utc>>,
    pub assistant_erased_at: Option<DateTime<Utc>>,
    pub analytics_erased_at: Option<DateTime<Utc>>,
}
pub async fn merchant(pool: &PgPool) -> Result<Uuid> {
    Ok(sqlx::query_scalar(
        "SELECT installation_id FROM platform.publication_installation WHERE singleton",
    )
    .fetch_one(pool)
    .await?)
}
pub async fn policy(pool: &PgPool) -> Result<Option<Policy>> {
    Ok(sqlx::query_as("SELECT p.* FROM customers.retention_policies p JOIN platform.publication_installation i ON i.installation_id=p.merchant_id WHERE p.active AND i.singleton").fetch_optional(pool).await?)
}
pub async fn configure(pool: &PgPool, who: Uuid, input: PolicyInput) -> Result<Policy> {
    input.validate()?;
    let mut tx = pool.begin().await?;
    let merchant: Uuid = sqlx::query_scalar(
        "SELECT installation_id FROM platform.publication_installation WHERE singleton FOR UPDATE",
    )
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE customers.retention_policies SET active=false WHERE merchant_id=$1 AND active",
    )
    .bind(merchant)
    .execute(&mut *tx)
    .await?;
    let value = sqlx::query_as("INSERT INTO customers.retention_policies(id,merchant_id,legal_entity,jurisdictions,financial_days,retain_contact,retain_address,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *")
        .bind(Uuid::new_v4()).bind(merchant).bind(input.legal_entity.trim()).bind(input.jurisdictions).bind(input.financial_days).bind(input.retain_contact).bind(input.retain_address).bind(who).fetch_one(&mut *tx).await?;
    infra_events::record(
        &mut tx,
        "customer.retention_policy_configured",
        serde_json::json!({"merchant_id":merchant,"actor_id":who}),
    )
    .await?;
    tx.commit().await?;
    Ok(value)
}
fn receipt_hash(token: &str) -> Result<String> {
    if token.len() != 64 || !token.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(Error::Invalid("Invalid deletion receipt".into()));
    }
    Ok(infra_auth::digest(token))
}
pub async fn status(pool: &PgPool, receipt: &Receipt) -> Result<Status> {
    let hash = receipt_hash(&receipt.receipt_token)?;
    sqlx::query_as("SELECT r.id,r.state,r.waiting_reason,r.requested_at,r.completed_at,(SELECT max(expires_at) FROM customers.retained_transactions t WHERE t.request_id=r.id) AS retained_until FROM customers.deletion_requests r JOIN platform.publication_installation i ON i.installation_id=r.merchant_id WHERE r.id=$1 AND r.receipt_hash=$2")
        .bind(receipt.request_id).bind(hash).fetch_optional(pool).await?.ok_or(Error::NotFound)
}
impl Service {
    pub async fn request_deletion(&self, access: &str, request: Request) -> Result<Status> {
        let hash = receipt_hash(&request.receipt_token)?;
        if !request.confirm || request.request_id.is_nil() {
            return Err(Error::Invalid("Confirm permanent account deletion".into()));
        }
        // Exact replays work after revocation, using the independently persisted receipt.
        let receipt = Receipt {
            request_id: request.request_id,
            receipt_token: request.receipt_token,
        };
        match status(&self.pool, &receipt).await {
            Ok(existing) => return Ok(existing),
            Err(Error::NotFound) => {}
            Err(error) => return Err(error),
        }
        let customer = self.authenticate(access).await?;
        infra_auth::rate_limit(&self.pool, &format!("account-deletion:{}", customer.id), 5).await?;
        let password: String=sqlx::query_scalar("SELECT password_hash FROM customers.customers WHERE id=$1 AND deletion_requested_at IS NULL").bind(customer.id).fetch_optional(&self.pool).await?.ok_or(Error::Unauthorized)?;
        if !infra_auth::verify_password(request.password, password.clone()).await? {
            return Err(Error::Unauthorized);
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET LOCAL lock_timeout='2s'")
            .execute(&mut *tx)
            .await?;
        sqlx::query("SELECT pg_advisory_xact_lock(3003)")
            .execute(&mut *tx)
            .await?;
        let current: String=sqlx::query_scalar("SELECT password_hash FROM customers.customers WHERE id=$1 AND deletion_requested_at IS NULL FOR UPDATE").bind(customer.id).fetch_optional(&mut *tx).await?.ok_or(Error::Unauthorized)?;
        if current != password {
            return Err(Error::Unauthorized);
        }
        let merchant: Uuid=sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation WHERE singleton FOR SHARE").fetch_one(&mut *tx).await?;
        let active: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers.retention_policies WHERE id=$1 AND merchant_id=$2 AND active)").bind(request.policy_id).bind(merchant).fetch_one(&mut *tx).await?;
        if !active {
            return Err(Error::Invalid(
                "Retention policy changed or is not configured; review it before confirming".into(),
            ));
        }
        sqlx::query("INSERT INTO customers.deletion_requests(id,merchant_id,customer_id,policy_id,receipt_hash,state,order_ids,session_ids,cart_ids) VALUES($1,$2,$3,$4,$5,'requested',ARRAY(SELECT id FROM orders.orders WHERE customer_id=$3),ARRAY(SELECT id FROM customers.sessions WHERE customer_id=$3 UNION SELECT session_id FROM customers.journey_events WHERE customer_id=$3),ARRAY(SELECT id FROM cart_checkout.carts WHERE customer_id=$3))")
            .bind(request.request_id).bind(merchant).bind(customer.id).bind(request.policy_id).bind(hash).execute(&mut *tx).await?;
        sqlx::query(
            "UPDATE customers.customers SET deletion_requested_at=clock_timestamp() WHERE id=$1",
        )
        .bind(customer.id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM customers.sessions WHERE customer_id=$1")
            .bind(customer.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM customers.challenges WHERE customer_id=$1")
            .bind(customer.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM platform.notification_jobs WHERE customer_id=$1")
            .bind(customer.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE platform.customer_push_devices SET enabled=false WHERE customer_id=$1")
            .bind(customer.id)
            .execute(&mut *tx)
            .await?;
        infra_events::record(
            &mut tx,
            "customer.deletion_requested",
            serde_json::json!({"request_id":request.request_id}),
        )
        .await?;
        tx.commit().await?;
        status(&self.pool, &receipt).await
    }
}
pub async fn claim(pool: &PgPool) -> Result<Option<Job>> {
    Ok(sqlx::query_as("UPDATE customers.deletion_requests SET state='processing',attempts=attempts+1,next_attempt_at=clock_timestamp()+interval '5 minutes',last_error=NULL WHERE id=(SELECT id FROM customers.deletion_requests WHERE state<>'complete' AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *").fetch_optional(pool).await?)
}
pub async fn acknowledge(pool: &PgPool, id: Uuid, stage: &str) -> Result<()> {
    let query=match stage {
        "engagement"=>"UPDATE customers.deletion_requests SET engagement_erased_at=clock_timestamp() WHERE id=$1",
        "assistant"=>"UPDATE customers.deletion_requests SET assistant_erased_at=clock_timestamp() WHERE id=$1",
        "analytics"=>"UPDATE customers.deletion_requests SET analytics_erased_at=clock_timestamp() WHERE id=$1",
        _=>return Err(Error::Invalid("Unknown erasure processor".into())),
    };
    sqlx::query(query).bind(id).execute(pool).await?;
    Ok(())
}
pub async fn finish(pool: &PgPool, id: Uuid) -> Result<()> {
    sqlx::query("UPDATE customers.deletion_requests SET state='complete',completed_at=clock_timestamp(),waiting_reason=NULL,last_error=NULL,session_ids='{}',order_ids='{}',cart_ids='{}' WHERE id=$1 AND commerce_erased_at IS NOT NULL AND engagement_erased_at IS NOT NULL AND assistant_erased_at IS NOT NULL AND analytics_erased_at IS NOT NULL").bind(id).execute(pool).await?;
    Ok(())
}
pub async fn retry(pool: &PgPool, id: Uuid) -> Result<()> {
    sqlx::query("UPDATE customers.deletion_requests SET state='failed',last_error='processor_unavailable',next_attempt_at=clock_timestamp()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts,7)))::int) WHERE id=$1 AND state<>'complete'").bind(id).execute(pool).await?;
    Ok(())
}
pub async fn purge(pool: &PgPool) -> Result<u64> {
    Ok(sqlx::query("DELETE FROM customers.retained_transactions WHERE (request_id,order_id) IN (SELECT request_id,order_id FROM customers.retained_transactions WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)").execute(pool).await?.rows_affected())
}

/// Erases the primary store atomically, after outstanding obligations settle.
/// The exclusive inventory barrier serializes this with checkout and fulfillment.
pub async fn erase_commerce(pool: &PgPool, id: Uuid) -> Result<bool> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL lock_timeout='2s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(3003)")
        .execute(&mut *tx)
        .await?;
    let (customer,policy_id,done,held):(Uuid,Uuid,Option<DateTime<Utc>>,bool)=sqlx::query_as("SELECT customer_id,policy_id,commerce_erased_at,coalesce(hold_until>clock_timestamp(),false) FROM customers.deletion_requests WHERE id=$1 FOR UPDATE").bind(id).fetch_one(&mut *tx).await?;
    if done.is_some() {
        return Ok(true);
    }
    sqlx::query("SELECT id FROM customers.customers WHERE id=$1 FOR UPDATE")
        .bind(customer)
        .execute(&mut *tx)
        .await?;
    let obligations:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM orders.orders WHERE customer_id=$1 AND status NOT IN ('cash_collected','cancelled')) OR EXISTS(SELECT 1 FROM support.tickets WHERE customer_id=$1 AND category IN ('payment_dispute','order_issue') AND status IN ('open','in_progress'))").bind(customer).fetch_one(&mut *tx).await?;
    if held || obligations {
        sqlx::query("UPDATE customers.deletion_requests SET state='waiting',waiting_reason=$2,next_attempt_at=clock_timestamp()+interval '1 minute' WHERE id=$1").bind(id).bind(if held {"legal_hold"} else {"open_obligations"}).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(false);
    }
    sqlx::query("SELECT set_config('commerce.erasure','on',true)")
        .execute(&mut *tx)
        .await?;
    let products:Vec<Uuid>=sqlx::query_scalar("SELECT DISTINCT product_id FROM inventory.reservations WHERE cart_id IN (SELECT id FROM cart_checkout.carts WHERE customer_id=$1)").bind(customer).fetch_all(&mut *tx).await?;
    sqlx::query("INSERT INTO customers.erased_carts SELECT id FROM cart_checkout.carts WHERE customer_id=$1 ON CONFLICT DO NOTHING").bind(customer).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM platform.discovery_sessions WHERE id IN (SELECT session_id FROM platform.discovery_orders WHERE order_id IN (SELECT id FROM orders.orders WHERE customer_id=$1))").bind(customer).execute(&mut *tx).await?;
    // Only enumerated invoice facts are retained; never copy arbitrary order JSON.
    sqlx::query("INSERT INTO customers.retained_transactions(request_id,order_id,record,expires_at) SELECT $1,o.id,jsonb_build_object('number',o.number,'created_at',o.created_at,'status',o.status,'currency',o.currency,'subtotal',o.subtotal,'discount',o.discount_amount,'tax',o.tax_amount,'delivery_fee',o.delivery_fee,'total',o.total,'contact',CASE WHEN p.retain_contact THEN o.contact ELSE 'null'::jsonb END,'address',CASE WHEN p.retain_address THEN o.location - 'delivery_instructions' - 'label' - 'custom_label' ELSE 'null'::jsonb END),o.updated_at+make_interval(days=>p.financial_days) FROM orders.orders o CROSS JOIN customers.retention_policies p WHERE o.customer_id=$2 AND p.id=$3 AND p.financial_days>0 AND o.updated_at+make_interval(days=>p.financial_days)>clock_timestamp() ON CONFLICT DO NOTHING").bind(id).bind(customer).bind(policy_id).execute(&mut *tx).await?;
    for query in [
        "DELETE FROM customers.sessions WHERE customer_id=$1",
        "DELETE FROM customers.challenges WHERE customer_id=$1",
        "DELETE FROM platform.notification_jobs WHERE customer_id=$1",
        "DELETE FROM platform.outbox WHERE payload::text LIKE '%'||$1::text||'%'",
        "UPDATE admin_iam.audit_log SET details='{}' WHERE entity_id=$1 OR details::text LIKE '%'||$1::text||'%'",
        "DELETE FROM support.messages WHERE ticket_id IN (SELECT id FROM support.tickets WHERE customer_id=$1)",
        "DELETE FROM support.audit WHERE ticket_id IN (SELECT id FROM support.tickets WHERE customer_id=$1)",
        "DELETE FROM support.tickets WHERE customer_id=$1",
        "DELETE FROM cart_checkout.agent_actions WHERE grant_id IN (SELECT id FROM cart_checkout.delegation_grants WHERE customer_id=$1)",
        "DELETE FROM cart_checkout.delegation_grants WHERE customer_id=$1",
        "DELETE FROM fulfillment.capacity_consumption WHERE reservation_id IN (SELECT id FROM fulfillment.capacity_reservations WHERE customer_id=$1)",
        "DELETE FROM fulfillment.capacity_reservations WHERE customer_id=$1",
        "DELETE FROM fulfillment.plan_items WHERE group_id IN (SELECT g.id FROM fulfillment.plan_groups g JOIN fulfillment.plans p ON p.id=g.plan_id WHERE p.customer_id=$1)",
        "DELETE FROM fulfillment.plan_groups WHERE plan_id IN (SELECT id FROM fulfillment.plans WHERE customer_id=$1)",
        "DELETE FROM fulfillment.plans WHERE customer_id=$1",
        "DELETE FROM inventory.reservations WHERE cart_id IN (SELECT id FROM cart_checkout.carts WHERE customer_id=$1)",
        "DELETE FROM cart_checkout.assistant_wishlist_transfers WHERE customer_id=$1",
        "DELETE FROM cart_checkout.assistant_compound_requests WHERE customer_id=$1",
        "DELETE FROM cart_checkout.assistant_actions WHERE customer_id=$1",
        "DELETE FROM cart_checkout.quotes WHERE customer_id=$1",
        "DELETE FROM cart_checkout.carts WHERE customer_id=$1",
        "DELETE FROM reviews.reviews WHERE customer_id=$1",
        "DELETE FROM reviews.wishlist WHERE customer_id=$1",
        "DELETE FROM customers.customer_locations WHERE customer_id=$1",
        "DELETE FROM customers.memory_subjects WHERE customer_id=$1",
        "DELETE FROM customers.journey_events WHERE customer_id=$1",
        "DELETE FROM platform.order_push_jobs WHERE customer_id=$1",
        "DELETE FROM platform.customer_push_devices WHERE customer_id=$1",
        "DELETE FROM platform.storefront_notification_publications WHERE customer_id=$1",
        "DELETE FROM platform.storefront_notification_recipients WHERE customer_id=$1",
        "DELETE FROM platform.marketing_notification_requests WHERE customer_id=$1",
        "DELETE FROM platform.marketing_notification_records WHERE customer_id=$1",
        "DELETE FROM orders.order_comments WHERE order_id IN (SELECT id FROM orders.orders WHERE customer_id=$1)",
        "UPDATE orders.order_status_history SET reason='Account deleted',actor_id=NULL WHERE order_id IN (SELECT id FROM orders.orders WHERE customer_id=$1)",
        "UPDATE orders.status_label_history SET reason='Account deleted' WHERE order_id IN (SELECT id FROM orders.orders WHERE customer_id=$1)",
        "UPDATE payments.manual_refunds SET reason='Account deleted' WHERE order_id IN (SELECT id FROM orders.orders WHERE customer_id=$1)",
        "UPDATE fulfillment.shipments SET tracking_reference=CASE WHEN tracking_reference='' THEN '' ELSE 'deleted' END WHERE order_id IN (SELECT id FROM orders.orders WHERE customer_id=$1)",
        "UPDATE orders.order_items SET discount_snapshot='[]' WHERE order_id IN (SELECT id FROM orders.orders WHERE customer_id=$1)",
        "UPDATE orders.orders SET discount_snapshot='[]',customer_id=gen_random_uuid(),contact='{}',location='{}',gift_message=NULL,coupon_code=NULL,market_context=NULL,reordered_from=NULL WHERE customer_id=$1",
        "UPDATE customers.customers SET email=id::text||'@deleted.invalid',mobile_number=NULL,primary_identifier='email',password_hash='',verified=false,first_name='',last_name='',date_of_birth=NULL,gender='',company_id=NULL,negotiated_price_list_id=NULL,attributes='{}',customer_group='general',deleted_at=clock_timestamp() WHERE id=$1",
    ] { sqlx::query(query).bind(customer).execute(&mut *tx).await?; }
    for product in products {
        sqlx::query("SELECT inventory.refresh_availability($1)")
            .bind(product)
            .execute(&mut *tx)
            .await?;
        infra_events::record(
            &mut tx,
            "inventory.stock_updated",
            serde_json::json!({"id":product}),
        )
        .await?;
    }
    sqlx::query("UPDATE customers.deletion_requests SET commerce_erased_at=clock_timestamp(),waiting_reason=NULL WHERE id=$1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(true)
}
