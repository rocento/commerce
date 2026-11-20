//! Durable, single-database provisioning orchestration. Execution is delegated
//! only to an installed trusted host executor; this module never simulates a deployment.
use crate::{
    domain::Principal,
    error::{ApiError, ApiResult},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::{future::Future, time::Duration};
use uuid::Uuid;

const MAX_ATTEMPTS: i32 = 5;
pub const EXECUTION_TIMEOUT_SECONDS: u64 = 130;
pub const CHECKPOINTS: &[&str] = &[
    "RELEASE",
    "ALLOCATE",
    "DATABASE",
    "MIGRATE",
    "SERVICES",
    "BOOTSTRAP",
    "INGRESS",
    "VALIDATE",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub payment_request_id: Uuid,
    pub theme_id: String,
    pub step: String,
    pub lease_token: Uuid,
    pub release_version: Option<String>,
    pub artifact_digest: Option<String>,
    pub storefront_host: String,
    pub admin_host: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidence {
    pub job_id: Uuid,
    pub tenant_id: Uuid,
    pub lease_token: Uuid,
    pub step: String,
    pub artifact_digest: String,
    pub checks: Vec<String>,
}

#[derive(Clone, Debug)]
pub enum Failure {
    Blocked(&'static str),
    Retry(&'static str),
    Review(&'static str),
}
impl Failure {
    fn code(&self) -> &'static str {
        match self {
            Self::Blocked(c) | Self::Retry(c) | Self::Review(c) => c,
        }
    }
}

pub trait Executor {
    fn execute(&self, job: &Job) -> impl Future<Output = Result<Evidence, Failure>> + Send;
    // Read-only recovery. Implementations must never execute a missing checkpoint.
    fn reconcile(&self, _job: &Job) -> impl Future<Output = Result<Evidence, Failure>> + Send {
        async { Err(Failure::Review("EXECUTION_REQUIRES_REVIEW")) }
    }
}

/// Transactional local subscription: one job per confirmed payment/tenant,
/// including payments confirmed before this worker was deployed.
pub async fn ingest(db: &PgPool) -> Result<usize, sqlx::Error> {
    let mut tx = db.begin().await?;
    let rows=sqlx::query("SELECT e.id AS event_id,t.id AS tenant_id,r.id AS payment_id,d.theme \
        FROM outbox_events e JOIN tenants t ON t.id=e.aggregate_id \
        JOIN payment_requests r ON r.tenant_id=t.id \
        JOIN billing_entitlements b ON b.payment_request_id=r.id AND b.tenant_id=t.id \
        JOIN payment_confirmations c ON c.payment_request_id=r.id \
        JOIN onboarding_drafts d ON d.tenant_id=t.id \
        WHERE e.subject='rocento.control.billing.confirmed' \
        AND e.payload->>'paymentRequestId'=r.id::text AND r.status='CONFIRMED' \
        AND t.lifecycle_status IN ('QUEUED','ALLOCATING','DEPLOYING','VALIDATING') AND d.theme IS NOT NULL \
        AND NOT EXISTS(SELECT 1 FROM provisioning_event_receipts x WHERE x.event_id=e.id) \
        ORDER BY e.id LIMIT 100 FOR UPDATE OF e SKIP LOCKED")
        .fetch_all(&mut *tx).await?;
    for row in &rows {
        let id = Uuid::new_v4();
        let inserted=sqlx::query("INSERT INTO provisioning_jobs(id,tenant_id,payment_request_id,theme_id) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id) DO NOTHING")
            .bind(id).bind(row.try_get::<Uuid,_>("tenant_id")?).bind(row.try_get::<Uuid,_>("payment_id")?)
            .bind(row.try_get::<String,_>("theme")?).execute(&mut *tx).await?.rows_affected();
        if inserted == 1 {
            sqlx::query("INSERT INTO audit_events(actor_id,action,target_id) VALUES('provisioning-worker','provisioning.queued',$1)")
                .bind(id).execute(&mut *tx).await?;
        }
        sqlx::query(
            "INSERT INTO provisioning_event_receipts(event_id) VALUES($1) ON CONFLICT DO NOTHING",
        )
        .bind(row.try_get::<i64, _>("event_id")?)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(rows.len())
}

/// An expired execution lease is ambiguous: never launch a second external
/// operation automatically. An operator must reconcile the installed runtime.
pub async fn recover_expired(db: &PgPool) -> Result<u64, sqlx::Error> {
    let mut tx = db.begin().await?;
    let rows=sqlx::query("SELECT id,tenant_id,step,lease_token FROM provisioning_jobs WHERE status='RUNNING' AND lease_until<=clock_timestamp() FOR UPDATE SKIP LOCKED")
        .fetch_all(&mut *tx).await?;
    for row in &rows {
        let id: Uuid = row.try_get("id")?;
        sqlx::query("UPDATE provisioning_jobs SET status='FAILED',last_error='EXECUTION_LEASE_EXPIRED',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1")
            .bind(id).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO provisioning_attempts(job_id,step,lease_token,outcome,error_code) VALUES($1,$2,$3,'FAILED','EXECUTION_LEASE_EXPIRED')")
            .bind(id).bind(row.try_get::<String,_>("step")?).bind(row.try_get::<Uuid,_>("lease_token")?).execute(&mut *tx).await?;
        sqlx::query("UPDATE tenants SET lifecycle_status='FAILED_REQUIRES_REVIEW' WHERE id=$1 AND lifecycle_status IN ('QUEUED','ALLOCATING','DEPLOYING','VALIDATING')")
            .bind(row.try_get::<Uuid,_>("tenant_id")?).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(rows.len() as u64)
}

pub async fn claim(db: &PgPool) -> Result<Option<Job>, sqlx::Error> {
    let mut tx = db.begin().await?;
    let row = sqlx::query(
        "SELECT j.*,t.store_slug FROM provisioning_jobs j JOIN tenants t ON t.id=j.tenant_id \
        WHERE t.management_state='ENABLED' AND j.status IN ('QUEUED','RETRY','BLOCKED') AND j.next_run_at<=clock_timestamp() \
        ORDER BY j.next_run_at,j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED",
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let token = Uuid::new_v4();
    let id: Uuid = row.try_get("id")?;
    sqlx::query("UPDATE provisioning_jobs SET status='RUNNING',lease_token=$2,lease_until=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp() WHERE id=$1")
        .bind(id).bind(token).execute(&mut *tx).await?;
    let slug: String = row.try_get("store_slug")?;
    let job = Job {
        id,
        tenant_id: row.try_get("tenant_id")?,
        payment_request_id: row.try_get("payment_request_id")?,
        theme_id: row.try_get("theme_id")?,
        step: row.try_get("step")?,
        lease_token: token,
        release_version: row.try_get("release_version")?,
        artifact_digest: row.try_get("artifact_digest")?,
        storefront_host: format!("{slug}.rocento.com"),
        admin_host: format!("{slug}-admin.rocento.com"),
    };
    tx.commit().await?;
    Ok(Some(job))
}

async fn prerequisites(db: &PgPool, job: &mut Job) -> Result<Option<Failure>, sqlx::Error> {
    let row=sqlx::query("SELECT t.management_state,t.lifecycle_status,r.status AS payment_status,b.service_days,c.payment_request_id AS confirmation, (b.service_days=r.service_days AND c.service_days=r.service_days AND c.amount_minor=r.amount_minor AND c.currency=r.currency) AS terms_match, \
        d.theme,s.status AS release_status,s.version,s.artifact_digest \
        FROM tenants t JOIN payment_requests r ON r.tenant_id=t.id AND r.id=$2 \
        LEFT JOIN billing_entitlements b ON b.payment_request_id=r.id AND b.tenant_id=t.id \
        LEFT JOIN payment_confirmations c ON c.payment_request_id=r.id \
        LEFT JOIN onboarding_drafts d ON d.tenant_id=t.id \
        LEFT JOIN storefront_themes s ON s.id=d.theme WHERE t.id=$1")
        .bind(job.tenant_id).bind(job.payment_request_id).fetch_optional(db).await?;
    let Some(row) = row else {
        return Ok(Some(Failure::Review("PAYMENT_ENTITLEMENT_INVALID")));
    };
    if row.try_get::<String, _>("management_state")? != "ENABLED" {
        return Ok(Some(Failure::Blocked("STORE_RESTRICTED")));
    }
    let life: String = row.try_get("lifecycle_status")?;
    if life != expected_lifecycle(&job.step) {
        return Ok(Some(Failure::Review("TENANT_STATE_CHANGED")));
    }
    if row.try_get::<String, _>("payment_status")? != "CONFIRMED"
        || row.try_get::<Option<i32>, _>("service_days")?.is_none()
        || row.try_get::<Option<Uuid>, _>("confirmation")?.is_none()
        || row.try_get::<Option<bool>, _>("terms_match")? != Some(true)
    {
        return Ok(Some(Failure::Review("PAYMENT_ENTITLEMENT_INVALID")));
    }
    if row.try_get::<Option<String>, _>("theme")?.as_deref() != Some(&job.theme_id) {
        return Ok(Some(Failure::Review("THEME_CHANGED")));
    }
    if row
        .try_get::<Option<String>, _>("release_status")?
        .as_deref()
        != Some("APPROVED")
    {
        return Ok(Some(Failure::Blocked("APPROVED_RELEASE_REQUIRED")));
    }
    let version: Option<String> = row.try_get("version")?;
    let digest: Option<String> = row.try_get("artifact_digest")?;
    if version.as_ref().is_none_or(|v| v.is_empty())
        || digest
            .as_ref()
            .is_none_or(|d| !d.starts_with("sha256:") || d.len() != 71)
    {
        return Ok(Some(Failure::Blocked("APPROVED_RELEASE_REQUIRED")));
    }
    if job.artifact_digest.is_some()
        && (job.artifact_digest != digest || job.release_version != version)
    {
        return Ok(Some(Failure::Review("RELEASE_CHANGED")));
    }
    let updated=sqlx::query("UPDATE provisioning_jobs SET release_version=$3,artifact_digest=$4 WHERE id=$1 AND status='RUNNING' AND lease_token=$2 AND lease_until>clock_timestamp()")
        .bind(job.id).bind(job.lease_token).bind(&version).bind(&digest).execute(db).await?.rows_affected();
    if updated != 1 {
        return Ok(Some(Failure::Review("LEASE_LOST")));
    }
    job.release_version = version;
    job.artifact_digest = digest;
    Ok(None)
}

pub async fn fail(db: &PgPool, job: &Job, failure: Failure) -> Result<bool, sqlx::Error> {
    let mut tx = db.begin().await?;
    let prior=sqlx::query("SELECT attempts,last_error FROM provisioning_jobs WHERE id=$1 AND status='RUNNING' AND lease_token=$2 AND lease_until>clock_timestamp() FOR UPDATE")
        .bind(job.id).bind(job.lease_token).fetch_optional(&mut *tx).await?;
    let Some(prior) = prior else { return Ok(false) };
    let old_error: Option<String> = prior.try_get("last_error")?;
    let attempts: i32 = prior.try_get::<i32, _>("attempts")?
        + if matches!(failure, Failure::Blocked(_)) {
            0
        } else {
            1
        };
    let status = match failure {
        Failure::Blocked(_) => "BLOCKED",
        Failure::Retry(_) if attempts < MAX_ATTEMPTS => "RETRY",
        _ => "FAILED",
    };
    let delay = if failure.code() == "HOST_EXECUTION_BUSY" {
        1
    } else if status == "BLOCKED" {
        60
    } else {
        (5_i32 * 2_i32.pow(attempts.clamp(0, 6) as u32)).min(300)
    };
    sqlx::query("UPDATE provisioning_jobs SET status=$3,last_error=$4,attempts=$6,lease_token=NULL,lease_until=NULL,next_run_at=clock_timestamp()+$5*interval '1 second',updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2")
        .bind(job.id).bind(job.lease_token).bind(status).bind(failure.code()).bind(delay).bind(attempts).execute(&mut *tx).await?;
    if status != "BLOCKED" || old_error.as_deref() != Some(failure.code()) {
        sqlx::query("INSERT INTO provisioning_attempts(job_id,step,lease_token,outcome,error_code) VALUES($1,$2,$3,$4,$5)")
        .bind(job.id).bind(&job.step).bind(job.lease_token).bind(status).bind(failure.code()).execute(&mut *tx).await?;
    }
    if status == "FAILED" {
        sqlx::query("UPDATE tenants SET lifecycle_status='FAILED_REQUIRES_REVIEW' WHERE id=$1 AND lifecycle_status IN ('QUEUED','ALLOCATING','DEPLOYING','VALIDATING')")
            .bind(job.tenant_id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(true)
}

fn expected_lifecycle(step: &str) -> &'static str {
    match step {
        "RELEASE" => "QUEUED",
        "ALLOCATE" => "ALLOCATING",
        "DATABASE" | "MIGRATE" | "SERVICES" | "BOOTSTRAP" | "INGRESS" => "DEPLOYING",
        "VALIDATE" => "VALIDATING",
        _ => "INVALID",
    }
}

fn valid_evidence(job: &Job, e: &Evidence) -> bool {
    let required: &[&str] = match job.step.as_str() {
        "RELEASE" => &[
            "release_authorized",
            "architecture_compatible",
            "artifact_present",
        ],
        "ALLOCATE" => &["capacity_reserved", "tenant_isolated"],
        "DATABASE" => &["database_ready"],
        "MIGRATE" => &["migrations_applied", "installation_identity"],
        "SERVICES" => &["runtime_healthy"],
        "BOOTSTRAP" => &["admin_access_ready", "theme_ready"],
        "INGRESS" => &["ingress_configured", "tenant_isolation"],
        "VALIDATE" => &[
            "storefront_https",
            "admin_https",
            "tenant_identity",
            "release_identity",
            "dns_routing",
            "tenant_isolation",
        ],
        _ => return false,
    };
    e.job_id == job.id
        && e.tenant_id == job.tenant_id
        && e.lease_token == job.lease_token
        && e.step == job.step
        && Some(&e.artifact_digest) == job.artifact_digest.as_ref()
        && required.iter().all(|c| e.checks.iter().any(|x| x == c))
}

pub async fn complete_step(
    db: &PgPool,
    job: &Job,
    evidence: Evidence,
) -> Result<bool, sqlx::Error> {
    if !valid_evidence(job, &evidence) {
        return fail(db, job, Failure::Review("INVALID_EXECUTOR_EVIDENCE"))
            .await
            .map(|_| false);
    }
    let mut tx = db.begin().await?;
    let held:Option<Uuid>=sqlx::query_scalar("SELECT id FROM provisioning_jobs WHERE id=$1 AND status='RUNNING' AND step=$3 AND lease_token=$2 AND lease_until>clock_timestamp() FOR UPDATE")
        .bind(job.id).bind(job.lease_token).bind(&job.step).fetch_optional(&mut *tx).await?;
    if held.is_none() {
        return Ok(false);
    }
    // Lock eligibility and approval through activation, so revocation cannot
    // race the final commit. No event or executor response is sufficient alone.
    let eligible=sqlx::query("SELECT t.id FROM tenants t JOIN payment_requests r ON r.tenant_id=t.id \
        JOIN billing_entitlements b ON b.payment_request_id=r.id AND b.tenant_id=t.id \
        JOIN payment_confirmations c ON c.payment_request_id=r.id \
        JOIN onboarding_drafts d ON d.tenant_id=t.id JOIN storefront_themes s ON s.id=d.theme \
        WHERE t.id=$1 AND r.id=$2 AND r.status='CONFIRMED' \
        AND t.management_state='ENABLED' AND t.lifecycle_status=$6 AND b.service_days=r.service_days AND c.service_days=r.service_days AND c.amount_minor=r.amount_minor AND c.currency=r.currency \
        AND d.theme=$3 AND s.status='APPROVED' AND s.version=$4 AND s.artifact_digest=$5 \
        FOR UPDATE OF t,r,b,d,s")
        .bind(job.tenant_id).bind(job.payment_request_id).bind(&job.theme_id).bind(&job.release_version).bind(&job.artifact_digest).bind(expected_lifecycle(&job.step))
        .fetch_optional(&mut *tx).await?;
    if eligible.is_none() {
        tx.rollback().await?;
        fail(db, job, Failure::Review("ELIGIBILITY_CHANGED")).await?;
        return Ok(false);
    }
    let prior: Vec<String> =
        sqlx::query_scalar("SELECT step FROM provisioning_steps WHERE job_id=$1 ORDER BY step")
            .bind(job.id)
            .fetch_all(&mut *tx)
            .await?;
    let position = CHECKPOINTS.iter().position(|step| *step == job.step);
    let mut expected: Vec<&str> = position
        .map(|i| CHECKPOINTS[..i].to_vec())
        .unwrap_or_default();
    expected.sort_unstable();
    let legacy_validation = job.step == "VALIDATE" && prior == ["ALLOCATE", "DEPLOY", "RELEASE"];
    if position.is_none() || (prior != expected && !legacy_validation) {
        tx.rollback().await?;
        fail(db, job, Failure::Review("STEP_ORDER_INVALID")).await?;
        return Ok(false);
    }
    sqlx::query("INSERT INTO provisioning_steps(job_id,step,evidence) VALUES($1,$2,$3)")
        .bind(job.id)
        .bind(&job.step)
        .bind(serde_json::to_value(evidence).expect("serializable evidence"))
        .execute(&mut *tx)
        .await?;
    let (next, life) = match job.step.as_str() {
        "RELEASE" => ("ALLOCATE", "ALLOCATING"),
        "ALLOCATE" => ("DATABASE", "DEPLOYING"),
        "DATABASE" => ("MIGRATE", "DEPLOYING"),
        "MIGRATE" => ("SERVICES", "DEPLOYING"),
        "SERVICES" => ("BOOTSTRAP", "DEPLOYING"),
        "BOOTSTRAP" => ("INGRESS", "DEPLOYING"),
        "INGRESS" => ("VALIDATE", "VALIDATING"),
        _ => ("DONE", "ACTIVE"),
    };
    if next == "DONE" {
        let routes=sqlx::query("UPDATE tenant_domains SET route_status='ACTIVE' WHERE tenant_id=$1 AND route_status='RESERVED' AND ((domain_type='STOREFRONT' AND hostname=$2) OR (domain_type='ADMIN' AND hostname=$3))")
            .bind(job.tenant_id).bind(&job.storefront_host).bind(&job.admin_host).execute(&mut *tx).await?.rows_affected();
        if routes != 2 {
            tx.rollback().await?;
            fail(db, job, Failure::Review("DOMAIN_STATE_CHANGED")).await?;
            return Ok(false);
        }
        let coverage=sqlx::query("UPDATE billing_entitlements SET starts_at=statement_timestamp(),ends_at=statement_timestamp()+CASE WHEN service_months IS NOT NULL THEN service_months*interval '1 month' ELSE service_days*interval '1 day' END WHERE payment_request_id=$1 AND starts_at IS NULL")
            .bind(job.payment_request_id).execute(&mut *tx).await?.rows_affected();
        if coverage != 1 {
            tx.rollback().await?;
            fail(db, job, Failure::Review("COVERAGE_ALREADY_STARTED")).await?;
            return Ok(false);
        }
        sqlx::query("INSERT INTO audit_events(actor_id,action,target_id) VALUES('provisioning-worker','tenant.activated',$1)")
            .bind(job.tenant_id).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO outbox_events(aggregate_id,subject,payload) VALUES($1,'rocento.control.tenant.activated',$2)")
            .bind(job.tenant_id).bind(json!({"schemaVersion":1,"tenantId":job.tenant_id,"jobId":job.id})).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE tenants SET lifecycle_status=$2,activated_at=CASE WHEN $2='ACTIVE' THEN clock_timestamp() ELSE activated_at END WHERE id=$1")
        .bind(job.tenant_id).bind(life).execute(&mut *tx).await?;
    sqlx::query("UPDATE provisioning_jobs SET step=$3,status=$4,attempts=0,last_error=NULL,lease_token=NULL,lease_until=NULL,next_run_at=clock_timestamp(),updated_at=clock_timestamp(),completed_at=CASE WHEN $3='DONE' THEN clock_timestamp() ELSE NULL END WHERE id=$1 AND lease_token=$2")
        .bind(job.id).bind(job.lease_token).bind(next).bind(if next=="DONE"{"SUCCEEDED"}else{"QUEUED"}).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO provisioning_attempts(job_id,step,lease_token,outcome) VALUES($1,$2,$3,'SUCCEEDED')")
        .bind(job.id).bind(&job.step).bind(job.lease_token).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(true)
}

pub async fn run_once(db: &PgPool, executor: &impl Executor) -> Result<bool, sqlx::Error> {
    ingest(db).await?;
    recover_expired(db).await?;
    let Some(mut job) = claim(db).await? else {
        return Ok(false);
    };
    if let Some(failure) = prerequisites(db, &mut job).await? {
        fail(db, &job, failure).await?;
        return Ok(true);
    }
    let held=sqlx::query("UPDATE provisioning_jobs SET updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND status='RUNNING' AND lease_until>clock_timestamp()")
        .bind(job.id).bind(job.lease_token).execute(db).await?.rows_affected();
    if held != 1 {
        return Ok(true);
    }
    let outcome = tokio::time::timeout(
        Duration::from_secs(EXECUTION_TIMEOUT_SECONDS),
        executor.execute(&job),
    )
    .await;
    let failure = match outcome {
        Ok(Ok(e)) => {
            complete_step(db, &job, e).await?;
            return Ok(true);
        }
        Ok(Err(e)) => e,
        Err(_) => Failure::Review("EXECUTION_TIMEOUT"),
    };
    // There is still lease headroom after the execution deadline. Only a verified
    // completed receipt may resolve an ambiguous response; never repeat mutations.
    if matches!(
        failure,
        Failure::Review("EXECUTION_TIMEOUT" | "EXECUTOR_FAILED" | "EXECUTOR_IO_FAILED")
    ) {
        if let Ok(Ok(evidence)) =
            tokio::time::timeout(Duration::from_secs(20), executor.reconcile(&job)).await
        {
            complete_step(db, &job, evidence).await?;
            return Ok(true);
        }
    }
    fail(db, &job, failure).await?;
    Ok(true)
}

pub async fn status(db: &PgPool, principal: &Principal, tenant: Uuid) -> ApiResult<Value> {
    let org = Uuid::parse_str(crate::domain::require_organization(principal)?)
        .map_err(|_| ApiError::forbidden("FORBIDDEN"))?;
    let row=sqlx::query("SELECT t.lifecycle_status,t.store_slug,t.activated_at,j.id,j.status,j.step,j.last_error,j.updated_at,b.starts_at,b.ends_at \
        FROM tenants t LEFT JOIN provisioning_jobs j ON j.tenant_id=t.id \
        LEFT JOIN billing_entitlements b ON b.tenant_id=t.id WHERE t.id=$1 AND t.org_id=$2")
        .bind(tenant).bind(org).fetch_optional(db).await?.ok_or_else(crate::domain::uuid_not_found)?;
    let state: String = row.try_get("lifecycle_status")?;
    let slug: String = row.try_get("store_slug")?;
    Ok(
        json!({"tenantId":tenant,"lifecycleStatus":state,"jobId":row.try_get::<Option<Uuid>,_>("id")?,
        "status":row.try_get::<Option<String>,_>("status")?,"step":row.try_get::<Option<String>,_>("step")?,
        "reason":row.try_get::<Option<String>,_>("last_error")?,
        "activatedAt":row.try_get::<Option<chrono::DateTime<chrono::Utc>>,_>("activated_at")?,
        "serviceStartsAt":row.try_get::<Option<chrono::DateTime<chrono::Utc>>,_>("starts_at")?,
        "serviceEndsAt":row.try_get::<Option<chrono::DateTime<chrono::Utc>>,_>("ends_at")?,
        "storefrontUrl":if state=="ACTIVE"{Some(format!("https://{slug}.rocento.com"))}else{None},
        "adminUrl":if state=="ACTIVE"{Some(format!("https://{slug}-admin.rocento.com"))}else{None}}),
    )
}
