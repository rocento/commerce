use std::{collections::BTreeMap, env};

use argon2::{password_hash::SaltString, Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::http::StatusCode;
use rand::Rng;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgConnection, PgPool, Row};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::{
    accounts::bearer,
    domain::{is_plan, require_organization, Principal},
    drafts::Drafts,
    error::{ApiError, ApiResult},
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaymentTerms {
    pub amount_minor: i64,
    pub currency: String,
    pub service_days: i32,
}

#[derive(Clone, Default)]
pub struct BillingConfig {
    pub instructions: String,
    pub terms: BTreeMap<String, PaymentTerms>,
    pub operator_id: String,
    pub operator_token: String,
}

impl BillingConfig {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let config = Self {
            instructions: env::var("ROCENTO_PAYMENT_INSTRUCTIONS")
                .unwrap_or_default()
                .trim()
                .to_owned(),
            terms: serde_json::from_str(
                &env::var("ROCENTO_PAYMENT_TERMS").unwrap_or_else(|_| "{}".to_owned()),
            )?,
            operator_id: env::var("ROCENTO_BILLING_OPERATOR_ID")
                .unwrap_or_default()
                .trim()
                .to_owned(),
            operator_token: env::var("ROCENTO_BILLING_OPERATOR_TOKEN").unwrap_or_default(),
        };
        config.validate().map_err(std::io::Error::other)?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.instructions.len() > 4000
            || self.terms.iter().any(|(plan, terms)| {
                !is_plan(plan)
                    || !(1..=1_000_000_000_000).contains(&terms.amount_minor)
                    || !(1..=3660).contains(&terms.service_days)
                    || !matches!(
                        terms.currency.as_str(),
                        "USD" | "EGP" | "SAR" | "AED" | "EUR" | "GBP"
                    )
            })
        {
            return Err("invalid Rocento payment instructions or terms");
        }
        if self.operator_id.is_empty() != self.operator_token.is_empty()
            || self.operator_id.len() > 128
            || (!self.operator_token.is_empty()
                && (self.operator_token.len() != 64
                    || !self
                        .operator_token
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit())))
        {
            return Err("billing operator requires an ID and a 64-character random hex token");
        }
        Ok(())
    }

    pub fn operator(&self, authorization: Option<&str>) -> ApiResult<&str> {
        let candidate = bearer(authorization);
        if self.operator_id.is_empty()
            || self.operator_token.len() != 64
            || candidate.len() != self.operator_token.len()
            || !bool::from(candidate.as_bytes().ct_eq(self.operator_token.as_bytes()))
        {
            return Err(ApiError::forbidden("BILLING_PERMISSION_REQUIRED"));
        }
        Ok(&self.operator_id)
    }
}

// Public projection intentionally excludes the operator credential and receipt.
const PUBLIC_PAYMENT: &str = "SELECT jsonb_build_object('id',id,'tenantId',tenant_id,'method',method, \
    'amountMinor',amount_minor,'currency',currency,'serviceDays',service_days,'serviceMonths',service_months,'instructions',instructions, \
    'status',CASE WHEN status='AWAITING_PAYMENT' AND expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE status END, \
    'expiresAt',expires_at,'confirmedAt',confirmed_at) FROM payment_requests WHERE id=$1";

async fn public_payment(db: &mut PgConnection, id: Uuid) -> ApiResult<Value> {
    Ok(sqlx::query_scalar(PUBLIC_PAYMENT)
        .bind(id)
        .fetch_one(db)
        .await?)
}

pub async fn inspect(db: &PgPool, id: Uuid) -> ApiResult<Value> {
    sqlx::query_scalar(PUBLIC_PAYMENT)
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(crate::domain::uuid_not_found)
}

pub async fn list(db: &PgPool, principal: &Principal) -> ApiResult<Value> {
    let org = require_organization(principal)?;
    Drafts::new(db.clone())
        .reconcile_expired_reservations(Some(org))
        .await?;
    let org = Uuid::parse_str(org).map_err(|_| ApiError::forbidden("FORBIDDEN"))?;
    let rows: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT payment FROM payment_requests r JOIN tenants t ON t.id=r.tenant_id \
         CROSS JOIN LATERAL ({}) AS p(payment) WHERE t.org_id=$1 ORDER BY r.created_at DESC LIMIT 100",
        PUBLIC_PAYMENT.replace("WHERE id=$1", "WHERE id=r.id")))
        .bind(org).fetch_all(db).await?;
    Ok(json!({"items":rows}))
}

pub async fn request_calendar(
    db: &PgPool,
    config: &BillingConfig,
    principal: &Principal,
    draft: Uuid,
    months: i32,
) -> ApiResult<Value> {
    if !matches!(months, 1 | 12) {
        return Err(ApiError::bad("INVALID_BILLING_PERIOD"));
    }
    request_inner(db, config, principal, draft, Some(months)).await
}

pub async fn request(
    db: &PgPool,
    config: &BillingConfig,
    principal: &Principal,
    draft: Uuid,
) -> ApiResult<Value> {
    request_inner(db, config, principal, draft, None).await
}

async fn request_inner(
    db: &PgPool,
    config: &BillingConfig,
    principal: &Principal,
    draft: Uuid,
    months: Option<i32>,
) -> ApiResult<Value> {
    if principal.email_verified != Some(true) {
        return Err(ApiError::forbidden("EMAIL_VERIFICATION_REQUIRED"));
    }
    let org = require_organization(principal)?;
    Drafts::new(db.clone())
        .reconcile_expired_reservations(Some(org))
        .await?;
    let org = Uuid::parse_str(org).map_err(|_| ApiError::forbidden("FORBIDDEN"))?;
    let mut tx = db.begin().await?;
    let row =
        sqlx::query("SELECT tenant_id FROM onboarding_drafts WHERE id=$1 AND org_id=$2 FOR UPDATE")
            .bind(draft)
            .bind(org)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(crate::domain::uuid_not_found)?;
    let tenant: Option<Uuid> = row.try_get("tenant_id")?;
    let tenant = tenant.ok_or_else(|| ApiError::conflict("RESERVATION_REQUIRED"))?;
    let existing: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM payment_requests WHERE tenant_id=$1")
            .bind(tenant)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(id) = existing {
        let response = public_payment(&mut tx, id).await?;
        tx.commit().await?;
        return Ok(response);
    }
    let row = sqlx::query(
        "SELECT plan_id,slug_reserved_until, \
        management_state='ENABLED' AND lifecycle_status='SLUG_RESERVED' AND slug_reserved_until>clock_timestamp() AS valid \
        FROM tenants WHERE id=$1 AND org_id=$2 FOR UPDATE",
    )
    .bind(tenant)
    .bind(org)
    .fetch_one(&mut *tx)
    .await?;
    if !row.try_get::<bool, _>("valid")? {
        return Err(ApiError::conflict("RESERVATION_EXPIRED"));
    }
    let plan: String = row.try_get("plan_id")?;
    let approved;
    let terms = if let Some(months) = months {
        let monthly = match plan.as_str() {
            "STARTER" => 2900,
            "LAUNCH" => 7900,
            "GROWTH" => 30000,
            "ENTERPRISE" => 250000,
            _ => return Err(ApiError::bad("INVALID_PLAN")),
        };
        approved = PaymentTerms {
            amount_minor: monthly * i64::from(months),
            currency: "USD".into(),
            service_days: months * 30,
        };
        &approved
    } else {
        config
            .terms
            .get(&plan)
            .filter(|_| {
                !config.instructions.trim().is_empty()
                    && !config.operator_id.is_empty()
                    && config.operator_token.len() == 64
            })
            .ok_or_else(|| {
                ApiError::new("PAYMENT_NOT_CONFIGURED", StatusCode::SERVICE_UNAVAILABLE)
            })?
    };
    let instructions = if months.is_some() {
        "Arrange offline payment with Rocento. After verifying your payment, Rocento will send you a six-digit confirmation code. Enter it here to continue."
    } else {
        &config.instructions
    };
    let id = Uuid::new_v4();
    let expiry: chrono::DateTime<chrono::Utc> = row.try_get("slug_reserved_until")?;
    sqlx::query("INSERT INTO payment_requests(id,tenant_id,amount_minor,currency,service_days,instructions,expires_at,service_months) \
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(id).bind(tenant).bind(terms.amount_minor).bind(&terms.currency).bind(terms.service_days)
        .bind(instructions).bind(expiry).bind(months).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO audit_events(actor_id,action,target_id) VALUES($1,'billing.requested',$2)",
    )
    .bind(&principal.subject)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let response = public_payment(&mut tx, id).await?;
    tx.commit().await?;
    Ok(response)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Confirmation {
    pub receipt_reference: String,
    pub amount_minor: i64,
    pub currency: String,
    pub service_days: i32,
}

pub async fn confirm(
    db: &PgPool,
    operator: &str,
    id: Uuid,
    body: Confirmation,
) -> ApiResult<Value> {
    let mut tx = db.begin().await?;
    let result = confirm_transaction(&mut tx, operator, id, body).await?;
    tx.commit().await?;
    Ok(result)
}

async fn confirm_transaction(
    tx: &mut PgConnection,
    operator: &str,
    id: Uuid,
    body: Confirmation,
) -> ApiResult<Value> {
    let receipt = body.receipt_reference.trim();
    if !(3..=200).contains(&receipt.len()) || receipt.chars().any(char::is_control) {
        return Err(ApiError::bad("INVALID_RECEIPT_REFERENCE"));
    }
    let tenant: Uuid = sqlx::query_scalar("SELECT tenant_id FROM payment_requests WHERE id=$1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(crate::domain::uuid_not_found)?;
    // Same lock order as reservation expiry: draft first, then its related state.
    let draft: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM onboarding_drafts WHERE tenant_id=$1 FOR UPDATE")
            .bind(tenant)
            .fetch_optional(&mut *tx)
            .await?;
    let row = sqlx::query("SELECT *,expires_at>clock_timestamp() AS unexpired FROM payment_requests WHERE id=$1 FOR UPDATE")
        .bind(id).fetch_one(&mut *tx).await?;
    if row.try_get::<i64, _>("amount_minor")? != body.amount_minor
        || row.try_get::<String, _>("currency")? != body.currency
        || row.try_get::<i32, _>("service_days")? != body.service_days
    {
        return Err(ApiError::conflict("PAYMENT_TERMS_MISMATCH"));
    }
    let status: String = row.try_get("status")?;
    if status == "CONFIRMED" {
        if row.try_get::<String, _>("receipt_reference")? != receipt {
            return Err(ApiError::conflict("PAYMENT_ALREADY_CONFIRMED"));
        }
        let response = public_payment(&mut *tx, id).await?;
        return Ok(response);
    }
    if draft.is_none() || status != "AWAITING_PAYMENT" || !row.try_get::<bool, _>("unexpired")? {
        return Err(ApiError::conflict("PAYMENT_EXPIRED"));
    }
    let updated = sqlx::query(
        "UPDATE tenants SET lifecycle_status='QUEUED' WHERE id=$1 \
        AND management_state='ENABLED' AND lifecycle_status='SLUG_RESERVED' AND slug_reserved_until>clock_timestamp()",
    )
    .bind(tenant)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(ApiError::conflict("PAYMENT_EXPIRED"));
    }
    let result = sqlx::query(
        "UPDATE payment_requests SET status='CONFIRMED',confirmed_at=clock_timestamp(), \
        confirmed_by=$2,receipt_reference=$3 WHERE id=$1",
    )
    .bind(id)
    .bind(operator)
    .bind(receipt)
    .execute(&mut *tx)
    .await;
    if let Err(error) = result {
        if matches!(&error, sqlx::Error::Database(e) if e.code().as_deref()==Some("23505")) {
            return Err(ApiError::conflict("RECEIPT_ALREADY_USED"));
        }
        return Err(error.into());
    }
    sqlx::query("INSERT INTO payment_confirmations(payment_request_id,receipt_reference,operator_id,amount_minor,currency,service_days) \
        VALUES($1,$2,$3,$4,$5,$6)")
        .bind(id).bind(receipt).bind(operator).bind(body.amount_minor).bind(&body.currency).bind(body.service_days)
        .execute(&mut *tx).await?;
    sqlx::query("INSERT INTO billing_entitlements(payment_request_id,tenant_id,service_days,service_months) SELECT $1,$2,$3,service_months FROM payment_requests WHERE id=$1")
        .bind(id).bind(tenant).bind(body.service_days).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO audit_events(actor_id,action,target_id) VALUES($1,'billing.confirmed',$2)",
    )
    .bind(operator)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO outbox_events(aggregate_id,subject,payload) VALUES($1,'rocento.control.billing.confirmed',$2)")
        .bind(tenant).bind(json!({"schemaVersion":1,"tenantId":tenant,"paymentRequestId":id}))
        .execute(&mut *tx).await?;
    let response = public_payment(&mut *tx, id).await?;
    Ok(response)
}

pub async fn issue_code(
    db: &PgPool,
    operator: &str,
    id: Uuid,
    body: Confirmation,
) -> ApiResult<Value> {
    let receipt = body.receipt_reference.trim();
    if !(3..=200).contains(&receipt.len()) || receipt.chars().any(char::is_control) {
        return Err(ApiError::bad("INVALID_RECEIPT_REFERENCE"));
    }
    let mut tx = db.begin().await?;
    sqlx::query("SELECT d.id FROM onboarding_drafts d JOIN payment_requests p ON p.tenant_id=d.tenant_id WHERE p.id=$1 FOR UPDATE OF d").bind(id).fetch_optional(&mut *tx).await?;
    let row = sqlx::query("SELECT p.*, p.expires_at>clock_timestamp() AND t.management_state='ENABLED' AND t.lifecycle_status='SLUG_RESERVED' AND t.slug_reserved_until>clock_timestamp() AS eligible FROM payment_requests p JOIN tenants t ON t.id=p.tenant_id WHERE p.id=$1 FOR UPDATE OF p,t").bind(id).fetch_optional(&mut *tx).await?.ok_or_else(crate::domain::uuid_not_found)?;
    if row.try_get::<String, _>("status")? != "AWAITING_PAYMENT"
        || !row.try_get::<bool, _>("eligible")?
    {
        return Err(ApiError::conflict("PAYMENT_EXPIRED"));
    }
    if row.try_get::<i64, _>("amount_minor")? != body.amount_minor
        || row.try_get::<String, _>("currency")? != body.currency
        || row.try_get::<i32, _>("service_days")? != body.service_days
    {
        return Err(ApiError::conflict("PAYMENT_TERMS_MISMATCH"));
    }
    let used: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM payment_confirmations WHERE receipt_reference=$1 AND payment_request_id<>$2)").bind(receipt).bind(id).fetch_one(&mut *tx).await?;
    if used {
        return Err(ApiError::conflict("RECEIPT_ALREADY_USED"));
    }
    let recent: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM payment_codes WHERE payment_request_id=$1 AND issued_at>clock_timestamp()-interval '60 seconds')").bind(id).fetch_one(&mut *tx).await?;
    if recent {
        return Err(ApiError::conflict("CODE_RECENTLY_ISSUED"));
    }
    let code = format!("{:06}", rand::rngs::OsRng.gen_range(0..1_000_000u32));
    let result=sqlx::query("INSERT INTO payment_codes(payment_request_id,code_hash,operator_id,receipt_reference) VALUES($1,$2,$3,$4) ON CONFLICT(payment_request_id) DO UPDATE SET code_hash=EXCLUDED.code_hash,operator_id=EXCLUDED.operator_id,receipt_reference=EXCLUDED.receipt_reference,failed_attempts=0,issued_at=clock_timestamp(),redeemed_at=NULL")
        .bind(id).bind(Argon2::default().hash_password(code.as_bytes(), &SaltString::generate(&mut rand::rngs::OsRng)).map_err(|_| ApiError::unavailable())?.to_string()).bind(operator).bind(receipt).execute(&mut *tx).await;
    if let Err(error) = result {
        if matches!(&error,sqlx::Error::Database(e) if e.code().as_deref()==Some("23505")) {
            return Err(ApiError::conflict("RECEIPT_ALREADY_USED"));
        }
        return Err(error.into());
    }
    sqlx::query(
        "INSERT INTO audit_events(actor_id,action,target_id) VALUES($1,'billing.code_issued',$2)",
    )
    .bind(operator)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(
        json!({"code":code,"paymentRequestId":id,"expiresAt":row.try_get::<chrono::DateTime<chrono::Utc>,_>("expires_at")?}),
    )
}

pub async fn redeem_code(
    db: &PgPool,
    principal: &Principal,
    id: Uuid,
    code: &str,
) -> ApiResult<Value> {
    if principal.email_verified != Some(true) {
        return Err(ApiError::forbidden("EMAIL_VERIFICATION_REQUIRED"));
    }
    let org = Uuid::parse_str(require_organization(principal)?)
        .map_err(|_| ApiError::forbidden("FORBIDDEN"))?;
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ApiError::bad("INVALID_PAYMENT_CODE"));
    }
    let mut tx = db.begin().await?;
    sqlx::query("SELECT d.id FROM onboarding_drafts d JOIN payment_requests p ON p.tenant_id=d.tenant_id WHERE p.id=$1 AND d.org_id=$2 FOR UPDATE OF d").bind(id).bind(org).fetch_optional(&mut *tx).await?.ok_or_else(crate::domain::uuid_not_found)?;
    let row=sqlx::query("SELECT p.*,c.code_hash,c.operator_id,c.receipt_reference AS code_receipt,c.failed_attempts,c.redeemed_at FROM payment_requests p JOIN tenants t ON t.id=p.tenant_id JOIN payment_codes c ON c.payment_request_id=p.id WHERE p.id=$1 AND t.org_id=$2 FOR UPDATE OF p,c").bind(id).bind(org).fetch_optional(&mut *tx).await?.ok_or_else(||ApiError::bad("INVALID_PAYMENT_CODE"))?;
    if row.try_get::<i32, _>("failed_attempts")? >= 5 {
        return Err(ApiError::conflict("PAYMENT_CODE_LOCKED"));
    }
    let hash: String = row.try_get("code_hash")?;
    if Argon2::default()
        .verify_password(
            code.as_bytes(),
            &PasswordHash::new(&hash).map_err(|_| ApiError::unavailable())?,
        )
        .is_err()
    {
        sqlx::query("UPDATE payment_codes SET failed_attempts=failed_attempts+1 WHERE payment_request_id=$1").bind(id).execute(&mut *tx).await?;
        tx.commit().await?;
        return Err(ApiError::bad("INVALID_PAYMENT_CODE"));
    }
    let body = Confirmation {
        receipt_reference: row.try_get("code_receipt")?,
        amount_minor: row.try_get("amount_minor")?,
        currency: row.try_get("currency")?,
        service_days: row.try_get("service_days")?,
    };
    let operator: String = row.try_get("operator_id")?;
    let response = confirm_transaction(&mut tx, &operator, id, body).await?;
    sqlx::query("UPDATE payment_codes SET redeemed_at=COALESCE(redeemed_at,clock_timestamp()) WHERE payment_request_id=$1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(response)
}
