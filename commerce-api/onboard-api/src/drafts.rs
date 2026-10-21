use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::{postgres::PgRow, PgPool, Row};
use uuid::Uuid;

use crate::{
    domain::{hostnames, is_plan, is_theme, normalize_slug, require_organization, Principal},
    error::{ApiError, ApiResult},
};

#[derive(Clone)]
pub struct Drafts {
    db: PgPool,
}

impl Drafts {
    pub fn new(db: PgPool) -> Self {
        Self { db }
    }

    pub async fn reconcile_expired_reservations(&self, org_id: Option<&str>) -> ApiResult<usize> {
        let mut tx = self.db.begin().await?;
        let expired = if let Some(org_id) = org_id {
            let org_id = Uuid::parse_str(org_id).map_err(|_| ApiError::forbidden("FORBIDDEN"))?;
            sqlx::query(
                "SELECT t.id,t.org_id FROM onboarding_drafts d JOIN tenants t ON t.id=d.tenant_id \
                 WHERE t.lifecycle_status='SLUG_RESERVED' AND t.slug_reserved_until<=clock_timestamp() \
                 AND t.org_id=$1 ORDER BY t.id LIMIT 100 FOR UPDATE OF d SKIP LOCKED",
            )
            .bind(org_id)
            .fetch_all(&mut *tx)
            .await?
        } else {
            sqlx::query(
                "SELECT t.id,t.org_id FROM onboarding_drafts d JOIN tenants t ON t.id=d.tenant_id \
                 WHERE t.lifecycle_status='SLUG_RESERVED' AND t.slug_reserved_until<=clock_timestamp() \
                 ORDER BY t.id LIMIT 100 FOR UPDATE OF d SKIP LOCKED",
            )
            .fetch_all(&mut *tx)
            .await?
        };

        let mut released = 0usize;
        for tenant in expired {
            let id: Uuid = tenant.try_get("id").map_err(|_| ApiError::unavailable())?;
            let org: Uuid = tenant
                .try_get("org_id")
                .map_err(|_| ApiError::unavailable())?;
            let updated = sqlx::query(
                "UPDATE tenants SET lifecycle_status='RESERVATION_EXPIRED' WHERE id=$1 \
                 AND lifecycle_status='SLUG_RESERVED' AND slug_reserved_until<=clock_timestamp() RETURNING id",
            )
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
            if updated.is_none() {
                continue;
            }
            sqlx::query("UPDATE tenant_domains SET route_status='EXPIRED' WHERE tenant_id=$1 AND route_status='RESERVED'")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "UPDATE onboarding_drafts SET tenant_id=NULL,version=version+1,updated_at=clock_timestamp() \
                 WHERE tenant_id=$1 AND org_id=$2",
            )
            .bind(id)
            .bind(org)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO audit_events(actor_id,action,target_id) \
                 VALUES('system:reservation-expiry','domains.reservation_expired',$1)",
            )
            .bind(id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO outbox_events(aggregate_id,subject,payload) \
                 VALUES($1,'rocento.control.domains.reservation_expired',$2)",
            )
            .bind(id)
            .bind(json!({"tenantId":id,"schemaVersion":1}))
            .execute(&mut *tx)
            .await?;
            released += 1;
        }
        tx.commit().await?;
        Ok(released)
    }

    pub async fn get(&self, principal: &Principal) -> ApiResult<Value> {
        let org = require_organization(principal)?;
        self.reconcile_expired_reservations(Some(org)).await?;
        let org_id = Uuid::parse_str(org).map_err(|_| ApiError::forbidden("FORBIDDEN"))?;
        let draft = sqlx::query(
            "INSERT INTO onboarding_drafts(id,org_id) VALUES($1,$2) \
             ON CONFLICT(org_id) DO UPDATE SET org_id=EXCLUDED.org_id RETURNING *",
        )
        .bind(Uuid::new_v4())
        .bind(org_id)
        .fetch_one(&self.db)
        .await?;
        let tenant_id: Option<Uuid> = draft
            .try_get("tenant_id")
            .map_err(|_| ApiError::unavailable())?;
        if let Some(tenant_id) = tenant_id {
            let tenant =
                sqlx::query("SELECT slug_reserved_until FROM tenants WHERE id=$1 AND org_id=$2")
                    .bind(tenant_id)
                    .bind(org_id)
                    .fetch_optional(&self.db)
                    .await?;
            let expiry: Option<DateTime<Utc>> = tenant
                .as_ref()
                .and_then(|row| row.try_get("slug_reserved_until").ok());
            let mut value = draft_value(&draft)?;
            value["reservation_expires_at"] = json!(expiry);
            Ok(value)
        } else {
            let mut value = draft_value(&draft)?;
            value["reservation_expires_at"] = Value::Null;
            Ok(value)
        }
    }

    pub async fn save(&self, principal: &Principal, id: Uuid, body: &Value) -> ApiResult<Value> {
        let org = require_organization(principal)?;
        let org_id = Uuid::parse_str(org).map_err(|_| ApiError::forbidden("FORBIDDEN"))?;
        let version = body
            .get("version")
            .and_then(Value::as_i64)
            .filter(|value| (0..=i32::MAX as i64).contains(value))
            .ok_or_else(|| ApiError::bad("INVALID_VERSION"))? as i32;
        let brand = body
            .get("brand")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::bad("INVALID_INPUT"))?;
        let slug_value = body
            .get("slug")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::bad("INVALID_INPUT"))?;
        if brand.trim().len() > 100 || slug_value.len() > 40 {
            return Err(ApiError::bad("INVALID_INPUT"));
        }
        let slug = if slug_value.is_empty() {
            String::new()
        } else {
            normalize_slug(slug_value)?
        };
        let plan = body.get("plan").and_then(Value::as_str).unwrap_or_default();
        let payment = body
            .get("payment")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let theme = body
            .get("theme")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !is_plan(plan)
            || !matches!(payment, "PADDLE" | "MANUAL_CASH")
            || (!theme.is_empty() && !is_theme(theme))
        {
            return Err(ApiError::bad("INVALID_INPUT"));
        }

        let mut tx = self.db.begin().await?;
        let current =
            sqlx::query("SELECT * FROM onboarding_drafts WHERE id=$1 AND org_id=$2 FOR UPDATE")
                .bind(id)
                .bind(org_id)
                .fetch_optional(&mut *tx)
                .await?;
        let Some(current) = current else {
            return Err(ApiError::new(
                "NOT_FOUND",
                axum::http::StatusCode::NOT_FOUND,
            ));
        };
        let current_version: i32 = current
            .try_get("version")
            .map_err(|_| ApiError::unavailable())?;
        if current_version != version {
            return Err(ApiError::conflict("DRAFT_CHANGED"));
        }
        let tenant_id: Option<Uuid> = current
            .try_get("tenant_id")
            .map_err(|_| ApiError::unavailable())?;
        if tenant_id.is_some() {
            let current_brand: String = current
                .try_get("brand")
                .map_err(|_| ApiError::unavailable())?;
            let current_slug: String = current
                .try_get("slug")
                .map_err(|_| ApiError::unavailable())?;
            let current_plan: String = current
                .try_get("plan")
                .map_err(|_| ApiError::unavailable())?;
            if current_brand != brand.trim() || current_slug != slug || current_plan != plan {
                return Err(ApiError::conflict("RESERVATION_LOCKED"));
            }
        }
        let updated = sqlx::query(
            "UPDATE onboarding_drafts SET brand=$3,slug=$4,plan=$5,theme=$6,payment=$7, \
             version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND org_id=$2 RETURNING *",
        )
        .bind(id)
        .bind(org_id)
        .bind(brand.trim())
        .bind(&slug)
        .bind(plan)
        .bind(if theme.is_empty() { None } else { Some(theme) })
        .bind(payment)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        draft_value(&updated)
    }

    pub async fn reserve(
        &self,
        principal: &Principal,
        id: Uuid,
        version: Option<i32>,
    ) -> ApiResult<Value> {
        let org = require_organization(principal)?;
        let org_id = Uuid::parse_str(org).map_err(|_| ApiError::forbidden("FORBIDDEN"))?;
        if principal.email_verified != Some(true) {
            return Err(ApiError::forbidden("EMAIL_VERIFICATION_REQUIRED"));
        }
        let version = version.ok_or_else(|| ApiError::bad("INVALID_VERSION"))?;
        self.reconcile_expired_reservations(Some(org)).await?;

        let result = self
            .reserve_transaction(principal, org_id, id, version)
            .await;
        match result {
            Err(error) if error.code == "UNIQUE_VIOLATION" => {
                Err(ApiError::conflict("SLUG_UNAVAILABLE"))
            }
            other => other,
        }
    }

    async fn reserve_transaction(
        &self,
        principal: &Principal,
        org: Uuid,
        id: Uuid,
        version: i32,
    ) -> ApiResult<Value> {
        let mut tx = self.db.begin().await?;
        let draft =
            sqlx::query("SELECT * FROM onboarding_drafts WHERE id=$1 AND org_id=$2 FOR UPDATE")
                .bind(id)
                .bind(org)
                .fetch_optional(&mut *tx)
                .await?;
        let Some(draft) = draft else {
            return Err(ApiError::new(
                "NOT_FOUND",
                axum::http::StatusCode::NOT_FOUND,
            ));
        };
        let tenant_id: Option<Uuid> = draft
            .try_get("tenant_id")
            .map_err(|_| ApiError::unavailable())?;
        if let Some(tenant_id) = tenant_id {
            let tenant = sqlx::query("SELECT * FROM tenants WHERE id=$1 AND org_id=$2")
                .bind(tenant_id)
                .bind(org)
                .fetch_optional(&mut *tx)
                .await?;
            let Some(tenant) = tenant else {
                return Err(ApiError::new(
                    "NOT_FOUND",
                    axum::http::StatusCode::NOT_FOUND,
                ));
            };
            let status: String = tenant
                .try_get("lifecycle_status")
                .map_err(|_| ApiError::unavailable())?;
            let expires_at: DateTime<Utc> = tenant
                .try_get("slug_reserved_until")
                .map_err(|_| ApiError::unavailable())?;
            if status == "SLUG_RESERVED" && expires_at <= Utc::now() {
                return Err(ApiError::conflict("RESERVATION_EXPIRED"));
            }
            let slug: String = tenant
                .try_get("store_slug")
                .map_err(|_| ApiError::unavailable())?;
            let result = json!({"draft":draft_value(&draft)?,"tenant":tenant_value(&tenant)?,"domains":hostnames(&slug)});
            tx.commit().await?;
            return Ok(result);
        }

        let current_version: i32 = draft
            .try_get("version")
            .map_err(|_| ApiError::unavailable())?;
        if current_version != version {
            return Err(ApiError::conflict("DRAFT_CHANGED"));
        }
        let brand: String = draft
            .try_get("brand")
            .map_err(|_| ApiError::unavailable())?;
        let theme: Option<String> = draft
            .try_get("theme")
            .map_err(|_| ApiError::unavailable())?;
        let slug_value: String = draft.try_get("slug").map_err(|_| ApiError::unavailable())?;
        let plan: String = draft.try_get("plan").map_err(|_| ApiError::unavailable())?;
        if brand.trim().is_empty() {
            return Err(ApiError::bad("BRAND_REQUIRED"));
        }
        if theme.is_none() {
            return Err(ApiError::bad("THEME_REQUIRED"));
        }
        let slug = normalize_slug(&slug_value)?;
        let domains = hostnames(&slug);
        let tenant_id = Uuid::new_v4();
        let tenant = match sqlx::query(
            "INSERT INTO tenants(id,org_id,brand_display_name,store_slug,plan_id) \
             VALUES($1,$2,$3,$4,$5) RETURNING *",
        )
        .bind(tenant_id)
        .bind(org)
        .bind(brand.trim())
        .bind(&slug)
        .bind(plan)
        .fetch_one(&mut *tx)
        .await
        {
            Ok(row) => row,
            Err(sqlx::Error::Database(error)) if error.code().as_deref() == Some("23505") => {
                return Err(ApiError::conflict("UNIQUE_VIOLATION"));
            }
            Err(error) => return Err(error.into()),
        };
        let storefront = domains["storefront"].as_str().unwrap_or_default();
        let admin = domains["admin"].as_str().unwrap_or_default();
        sqlx::query(
            "INSERT INTO tenant_domains(tenant_id,hostname,domain_type) \
             VALUES($1,$2,'STOREFRONT'),($1,$3,'ADMIN')",
        )
        .bind(tenant_id)
        .bind(storefront)
        .bind(admin)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO outbox_events(aggregate_id,subject,payload) \
             VALUES($1,'rocento.control.domains.reserved',$2)",
        )
        .bind(tenant_id)
        .bind(json!({"tenantId":tenant_id,"schemaVersion":1}))
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO audit_events(actor_id,action,target_id) VALUES($1,'domains.reserved',$2)",
        )
        .bind(&principal.subject)
        .bind(tenant_id)
        .execute(&mut *tx)
        .await?;
        let updated_draft = sqlx::query(
            "UPDATE onboarding_drafts SET tenant_id=$2,version=version+1,updated_at=clock_timestamp() \
             WHERE id=$1 RETURNING *",
        )
        .bind(id)
        .bind(tenant_id)
        .fetch_one(&mut *tx)
        .await?;
        let response = json!({
            "draft":draft_value(&updated_draft)?,
            "tenant":tenant_value(&tenant)?,
            "domains":domains
        });
        tx.commit().await?;
        Ok(response)
    }
}

fn draft_value(row: &PgRow) -> ApiResult<Value> {
    let id: Uuid = row.try_get("id").map_err(|_| ApiError::unavailable())?;
    let org_id: Uuid = row.try_get("org_id").map_err(|_| ApiError::unavailable())?;
    let brand: String = row.try_get("brand").map_err(|_| ApiError::unavailable())?;
    let slug: String = row.try_get("slug").map_err(|_| ApiError::unavailable())?;
    let plan: String = row.try_get("plan").map_err(|_| ApiError::unavailable())?;
    let theme: Option<String> = row.try_get("theme").map_err(|_| ApiError::unavailable())?;
    let payment: String = row
        .try_get("payment")
        .map_err(|_| ApiError::unavailable())?;
    let version: i32 = row
        .try_get("version")
        .map_err(|_| ApiError::unavailable())?;
    let tenant_id: Option<Uuid> = row
        .try_get("tenant_id")
        .map_err(|_| ApiError::unavailable())?;
    let updated_at: DateTime<Utc> = row
        .try_get("updated_at")
        .map_err(|_| ApiError::unavailable())?;
    Ok(json!({
        "id":id,"org_id":org_id,"brand":brand,"slug":slug,"plan":plan,"theme":theme,
        "payment":payment,"version":version,"tenant_id":tenant_id,"updated_at":updated_at
    }))
}

fn tenant_value(row: &PgRow) -> ApiResult<Value> {
    let id: Uuid = row.try_get("id").map_err(|_| ApiError::unavailable())?;
    let org_id: Uuid = row.try_get("org_id").map_err(|_| ApiError::unavailable())?;
    let brand: String = row
        .try_get("brand_display_name")
        .map_err(|_| ApiError::unavailable())?;
    let slug: String = row
        .try_get("store_slug")
        .map_err(|_| ApiError::unavailable())?;
    let plan: String = row
        .try_get("plan_id")
        .map_err(|_| ApiError::unavailable())?;
    let lifecycle_status: String = row
        .try_get("lifecycle_status")
        .map_err(|_| ApiError::unavailable())?;
    let slug_reserved_until: DateTime<Utc> = row
        .try_get("slug_reserved_until")
        .map_err(|_| ApiError::unavailable())?;
    let created_at: DateTime<Utc> = row
        .try_get("created_at")
        .map_err(|_| ApiError::unavailable())?;
    Ok(json!({
        "id":id,"org_id":org_id,"brand_display_name":brand,"store_slug":slug,"plan_id":plan,
        "lifecycle_status":lifecycle_status,"slug_reserved_until":slug_reserved_until,"created_at":created_at
    }))
}
