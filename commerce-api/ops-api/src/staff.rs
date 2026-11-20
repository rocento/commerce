//! Explicit staff membership and audience-separated sessions. No self-enrolment.
use crate::{
    accounts::{bearer, digest, Accounts},
    error::{ApiError, ApiResult},
};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub async fn login(db: &PgPool, accounts: &Accounts, body: &Value) -> ApiResult<Value> {
    let result = accounts.login(body).await?;
    let parent = result["sessionToken"]
        .as_str()
        .ok_or_else(ApiError::unavailable)?;
    let id = Uuid::parse_str(
        result["user"]["id"]
            .as_str()
            .ok_or_else(ApiError::unavailable)?,
    )
    .map_err(|_| ApiError::unavailable())?;
    let mut tx = db.begin().await?;
    let role:Option<String>=sqlx::query_scalar("SELECT m.role FROM staff_members m JOIN customer_accounts a ON a.id=m.account_id JOIN customer_sessions s ON s.account_id=a.id WHERE m.account_id=$1 AND m.enabled AND a.verified AND NOT a.disabled AND s.token_hash=$2 AND s.expires_at>clock_timestamp() FOR UPDATE OF m,a,s")
        .bind(id).bind(digest(parent)).fetch_optional(&mut *tx).await?;
    let Some(role) = role else {
        tx.rollback().await?;
        accounts.logout(Some(&format!("Bearer {parent}"))).await?;
        return Err(ApiError::forbidden("STAFF_ACCESS_REQUIRED"));
    };
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    sqlx::query("INSERT INTO staff_sessions(token_hash,parent_token_hash,account_id,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '4 hours')")
        .bind(digest(&token)).bind(digest(parent)).bind(id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO audit_events(actor_id,action,target_id) VALUES($1,'staff.login',$2)")
        .bind(format!("staff:{id}"))
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(json!({"sessionToken":token,"user":{"id":id,"email":result["user"]["email"],"role":role}}))
}

pub async fn authorize(db: &PgPool, header: Option<&str>, write: bool) -> ApiResult<Value> {
    let token = bearer(header);
    if token.len() != 64 {
        return Err(ApiError::unauthorized("STAFF_SESSION_REQUIRED"));
    }
    let row=sqlx::query("SELECT a.id,a.email,m.role FROM staff_sessions s JOIN staff_members m ON m.account_id=s.account_id JOIN customer_accounts a ON a.id=m.account_id JOIN customer_sessions p ON p.token_hash=s.parent_token_hash WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp() AND p.expires_at>clock_timestamp() AND m.enabled AND a.verified AND NOT a.disabled")
        .bind(digest(token)).fetch_optional(db).await?.ok_or_else(||ApiError::unauthorized("STAFF_SESSION_REQUIRED"))?;
    let role: String = row.try_get("role")?;
    if write && role != "OWNER" {
        return Err(ApiError::forbidden("STAFF_WRITE_REQUIRED"));
    }
    Ok(
        json!({"id":row.try_get::<Uuid,_>("id")?,"email":row.try_get::<String,_>("email")?,"role":role}),
    )
}
pub async fn logout(db: &PgPool, header: Option<&str>) -> ApiResult<Value> {
    sqlx::query("DELETE FROM customer_sessions WHERE token_hash IN (SELECT parent_token_hash FROM staff_sessions WHERE token_hash=$1)").bind(digest(bearer(header))).execute(db).await?;
    Ok(json!({"status":"OK"}))
}

#[derive(Deserialize, Default)]
pub struct Filter {
    pub search: Option<String>,
    pub page: Option<i64>,
}
pub async fn clients(db: &PgPool, filter: Filter) -> ApiResult<Value> {
    let search = filter.search.unwrap_or_default();
    if search.len() > 200 {
        return Err(ApiError::bad("INVALID_SEARCH"));
    }
    let page = filter.page.unwrap_or(0).clamp(0, 100000);
    let pattern = format!(
        "%{}%",
        search
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let condition="FROM customer_accounts a JOIN organizations o ON o.id=a.org_id WHERE NOT EXISTS (SELECT 1 FROM staff_members m WHERE m.account_id=a.id AND m.enabled) AND (a.email ILIKE $1 OR o.name ILIKE $1 OR EXISTS(SELECT 1 FROM tenants t WHERE t.org_id=a.org_id AND (t.store_slug ILIKE $1 OR t.brand_display_name ILIKE $1)))";
    let total: i64 = sqlx::query_scalar(&format!("SELECT count(*) {condition}"))
        .bind(&pattern)
        .fetch_one(db)
        .await?;
    let items:Vec<Value>=sqlx::query_scalar(&format!("SELECT jsonb_build_object('id',a.id,'email',a.email,'verified',a.verified,'disabled',a.disabled,'organization',o.name,'createdAt',a.created_at,'stores',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id,'brand',t.brand_display_name,'slug',t.store_slug,'plan',t.plan_id,'hostingProvider',t.hosting_provider,'lifecycle',t.lifecycle_status,'managementState',t.management_state) ORDER BY t.created_at DESC) FROM tenants t WHERE t.org_id=a.org_id),'[]'::jsonb)) {condition} ORDER BY a.created_at DESC,a.id LIMIT 50 OFFSET $2"))
        .bind(&pattern).bind(page*50).fetch_all(db).await?;
    Ok(json!({"items":items,"total":total,"page":page,"pageSize":50}))
}
pub async fn dashboard(db: &PgPool) -> ApiResult<Value> {
    let counts:Value=sqlx::query_scalar("SELECT jsonb_build_object('clients',(SELECT count(*) FROM customer_accounts a WHERE NOT EXISTS (SELECT 1 FROM staff_members m WHERE m.account_id=a.id AND m.enabled)),'active',(SELECT count(*) FROM tenants WHERE lifecycle_status='ACTIVE' AND management_state='ENABLED'),'awaitingPayment',(SELECT count(*) FROM payment_requests WHERE status='AWAITING_PAYMENT' AND expires_at>clock_timestamp()),'setupAttention',(SELECT count(*) FROM provisioning_jobs WHERE status IN ('BLOCKED','FAILED')))").fetch_one(db).await?;
    let jobs:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',j.id,'tenantId',t.id,'slug',t.store_slug,'brand',t.brand_display_name,'hostingProvider',t.hosting_provider,'preferredHostId',t.preferred_host_id,'hostId',(SELECT host_id FROM merchant_placements WHERE tenant_id=t.id),'status',j.status,'step',j.step,'reason',j.last_error,'attempts',j.attempts,'updatedAt',j.updated_at,'managementState',t.management_state) FROM provisioning_jobs j JOIN tenants t ON t.id=j.tenant_id ORDER BY j.updated_at DESC LIMIT 200").fetch_all(db).await?;
    let payments:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',p.id,'tenantId',t.id,'slug',t.store_slug,'email',a.email,'amountMinor',p.amount_minor,'currency',p.currency,'serviceDays',p.service_days,'serviceMonths',p.service_months,'status',CASE WHEN p.status='AWAITING_PAYMENT' AND p.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE p.status END,'confirmedAt',p.confirmed_at,'receiptReference',p.receipt_reference,'managementState',t.management_state) FROM payment_requests p JOIN tenants t ON t.id=p.tenant_id JOIN customer_accounts a ON a.org_id=t.org_id ORDER BY p.created_at DESC LIMIT 200").fetch_all(db).await?;
    let activity:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'actor',actor_id,'action',action,'targetId',target_id,'occurredAt',occurred_at) FROM audit_events ORDER BY id DESC LIMIT 100").fetch_all(db).await?;
    let hosts:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',h.id,'provider',h.provider,'reference',h.provider_reference,'state',h.state,'address',host(h.address),'error',h.error_code,'updatedAt',h.updated_at,'usedSlots',(SELECT count(*) FROM merchant_placements WHERE host_id=h.id),'maxSlots',3) FROM merchant_hosts h ORDER BY h.created_at,h.id").fetch_all(db).await?;
    Ok(json!({"counts":counts,"jobs":jobs,"payments":payments,"activity":activity,"hosts":hosts}))
}
pub async fn store(db: &PgPool, id: Uuid) -> ApiResult<Value> {
    let detail:Value=sqlx::query_scalar("SELECT jsonb_build_object('id',t.id,'slug',t.store_slug,'brand',t.brand_display_name,'plan',t.plan_id,'hostingProvider',t.hosting_provider,'preferredHostId',t.preferred_host_id,'hostId',(SELECT host_id FROM merchant_placements WHERE tenant_id=t.id),'hostState',(SELECT h.state FROM merchant_placements p JOIN merchant_hosts h ON h.id=p.host_id WHERE p.tenant_id=t.id),'hostingLocked',(EXISTS(SELECT 1 FROM merchant_placements WHERE tenant_id=t.id) OR EXISTS(SELECT 1 FROM provisioning_jobs WHERE tenant_id=t.id AND (status='RUNNING' OR step<>'RELEASE'))),'email',a.email,'lifecycle',t.lifecycle_status,'managementState',t.management_state,'createdAt',t.created_at,'activatedAt',t.activated_at,'archivedAt',t.archived_at,'serviceStartsAt',b.starts_at,'serviceEndsAt',b.ends_at,'theme',d.theme,'storefrontUrl','https://'||t.store_slug||'.rocento.com','adminUrl','https://'||t.store_slug||'-admin.rocento.com') FROM tenants t JOIN customer_accounts a ON a.org_id=t.org_id LEFT JOIN billing_entitlements b ON b.tenant_id=t.id LEFT JOIN onboarding_drafts d ON d.tenant_id=t.id WHERE t.id=$1").bind(id).fetch_optional(db).await?.ok_or_else(crate::domain::uuid_not_found)?;
    let commands:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'action',action,'reason',reason,'status',status,'error',error_code,'requestedAt',requested_at,'completedAt',completed_at) FROM tenant_control_commands WHERE tenant_id=$1 ORDER BY requested_at DESC LIMIT 50").bind(id).fetch_all(db).await?;
    let steps:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('step',s.step,'completedAt',s.completed_at) FROM provisioning_steps s JOIN provisioning_jobs j ON j.id=s.job_id WHERE j.tenant_id=$1 ORDER BY s.completed_at").bind(id).fetch_all(db).await?;
    let hosts:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',h.id,'provider',h.provider,'reference',h.provider_reference,'state',h.state,'usedSlots',(SELECT count(*) FROM merchant_placements WHERE host_id=h.id),'maxSlots',3) FROM merchant_hosts h ORDER BY h.created_at,h.id").fetch_all(db).await?;
    let job:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'tenantId',tenant_id,'status',status,'step',step,'reason',last_error,'attempts',attempts,'updatedAt',updated_at) FROM provisioning_jobs WHERE tenant_id=$1").bind(id).fetch_optional(db).await?;
    Ok(json!({"store":detail,"commands":commands,"steps":steps,"hosts":hosts,"job":job}))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Control {
    pub action: String,
    pub reason: String,
    pub confirm_slug: String,
}
pub async fn control(db: &PgPool, actor: Uuid, id: Uuid, body: Control) -> ApiResult<Value> {
    if !matches!(body.action.as_str(), "SUSPEND" | "ARCHIVE")
        || body.reason.trim().len() < 3
        || body.reason.len() > 1000
    {
        return Err(ApiError::bad("INVALID_CONTROL_REQUEST"));
    }
    let mut tx = db.begin().await?;
    // Same lock order as provisioning commits: job first, then tenant.
    sqlx::query("SELECT id FROM provisioning_jobs WHERE tenant_id=$1 FOR UPDATE")
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
    let row = sqlx::query("SELECT store_slug,management_state FROM tenants WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(crate::domain::uuid_not_found)?;
    if row.try_get::<String, _>("store_slug")? != body.confirm_slug {
        return Err(ApiError::conflict("STORE_CONFIRMATION_MISMATCH"));
    }
    let current: String = row.try_get("management_state")?;
    let desired = if body.action == "ARCHIVE" {
        "ARCHIVE_REQUESTED"
    } else {
        "SUSPEND_REQUESTED"
    };
    if current == "ARCHIVED"
        || current == "ARCHIVE_REQUESTED"
        || (body.action == "SUSPEND" && current == "SUSPENDED")
    {
        return Err(ApiError::conflict("STORE_ALREADY_RESTRICTED"));
    }
    let pending:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'status',status,'action',action) FROM tenant_control_commands WHERE tenant_id=$1 AND status IN ('PENDING','APPLYING')").bind(id).fetch_optional(&mut *tx).await?;
    if let Some(pending) = pending {
        if pending["action"] == body.action {
            return Ok(pending);
        }
        return Err(ApiError::conflict("CONTROL_IN_PROGRESS"));
    }
    let command = Uuid::new_v4();
    sqlx::query("INSERT INTO tenant_control_commands(id,tenant_id,action,requested_by,reason) VALUES($1,$2,$3,$4,$5)").bind(command).bind(id).bind(&body.action).bind(actor).bind(body.reason.trim()).execute(&mut *tx).await?;
    sqlx::query("UPDATE tenants SET management_state=$2 WHERE id=$1")
        .bind(id)
        .bind(desired)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO audit_events(actor_id,action,target_id) VALUES($1,$2,$3)")
        .bind(format!("staff:{actor}"))
        .bind(format!("store.{}.requested", body.action.to_lowercase()))
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(json!({"id":command,"status":"PENDING","action":body.action}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hosting {
    pub provider: String,
    pub host_id: Option<Uuid>,
}

pub async fn hosting(db: &PgPool, actor: Uuid, id: Uuid, body: Hosting) -> ApiResult<Value> {
    if !matches!(body.provider.as_str(), "aws" | "gcp" | "hetzner") {
        return Err(ApiError::bad("INVALID_HOSTING_PROVIDER"));
    }
    let mut tx = db.begin().await?;
    let job =
        sqlx::query("SELECT status,step FROM provisioning_jobs WHERE tenant_id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let row = sqlx::query("SELECT hosting_provider,preferred_host_id,management_state,lifecycle_status FROM tenants WHERE id=$1 FOR UPDATE")
        .bind(id).fetch_optional(&mut *tx).await?.ok_or_else(crate::domain::uuid_not_found)?;
    if row.try_get::<String, _>("management_state")? != "ENABLED" {
        return Err(ApiError::conflict("STORE_ALREADY_RESTRICTED"));
    }
    if row
        .try_get::<Option<String>, _>("hosting_provider")?
        .as_deref()
        == Some(&body.provider)
        && row.try_get::<Option<Uuid>, _>("preferred_host_id")? == body.host_id
    {
        return Ok(json!({"provider":body.provider,"hostId":body.host_id}));
    }
    let placed: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM merchant_placements WHERE tenant_id=$1)")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    let locked = if let Some(j) = job {
        j.try_get::<String, _>("status")? == "RUNNING"
            || j.try_get::<String, _>("step")? != "RELEASE"
    } else {
        false
    };
    if placed
        || locked
        || !matches!(
            row.try_get::<String, _>("lifecycle_status")?.as_str(),
            "SLUG_RESERVED" | "QUEUED"
        )
    {
        return Err(ApiError::conflict("HOSTING_PLACEMENT_LOCKED"));
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('merchant-fleet:'||$1,0))")
        .bind(&body.provider)
        .execute(&mut *tx)
        .await?;
    if let Some(host) = body.host_id {
        let available:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM merchant_hosts h WHERE h.id=$1 AND h.provider=$2 AND h.state IN ('REQUESTED','CREATING','BOOTING','READY') AND (SELECT count(*) FROM merchant_placements WHERE host_id=h.id)<3)")
            .bind(host).bind(&body.provider).fetch_one(&mut *tx).await?;
        if !available {
            return Err(ApiError::conflict("HOST_UNAVAILABLE_OR_FULL"));
        }
    }
    sqlx::query("UPDATE tenants SET hosting_provider=$2,preferred_host_id=$3 WHERE id=$1")
        .bind(id)
        .bind(&body.provider)
        .bind(body.host_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE provisioning_jobs SET next_run_at=clock_timestamp() WHERE tenant_id=$1 AND status='BLOCKED'").bind(id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO audit_events(actor_id,action,target_id) VALUES($1,$2,$3)")
        .bind(format!("staff:{actor}"))
        .bind(format!("store.hosting.{}", body.provider))
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(json!({"provider":body.provider,"hostId":body.host_id}))
}
