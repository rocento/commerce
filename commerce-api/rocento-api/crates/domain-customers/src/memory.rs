//! Private, bounded shopping context. No merchant knowledge or authorization lives here.
use chrono::{DateTime, Duration, Utc};
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use std::collections::BTreeMap;
use uuid::Uuid;
pub const VERSION: &str = "1.0.0";
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct Configuration {
    pub enabled: bool,
    pub allowed_categories: Vec<Uuid>,
    pub view_weight: i32,
    pub purchase_weight: i32,
    pub return_weight: i32,
    pub half_life_days: i32,
    pub retention_days: i32,
}
pub async fn configuration(pool: &PgPool) -> Result<Configuration> {
    Ok(sqlx::query_as("SELECT enabled,allowed_categories,view_weight,purchase_weight,return_weight,half_life_days,retention_days FROM customers.memory_configuration WHERE singleton").fetch_one(pool).await?)
}
#[derive(Clone, FromRow)]
pub struct Subject {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub customer_id: Option<Uuid>,
    pub personalized: bool,
    pub journey_consent: bool,
    pub consent_version: i32,
    pub expires_at: DateTime<Utc>,
}
const SUBJECT: &str =
    "id,tenant_id,customer_id,personalized,journey_consent,consent_version,expires_at";
pub async fn resolve(
    pool: &PgPool,
    tenant: Uuid,
    customer: Option<Uuid>,
    cookie: Option<&str>,
) -> Result<(Subject, Option<String>)> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM customers.memory_subjects WHERE id IN (SELECT id FROM customers.memory_subjects WHERE tenant_id=$1 AND expires_at<=now() LIMIT 500)").bind(tenant).execute(&mut *tx).await?;
    let hash = cookie.filter(|v| v.len() <= 128).map(infra_auth::digest);
    let result = if let Some(customer) = customer {
        sqlx::query("DELETE FROM customers.memory_subjects WHERE tenant_id=$1 AND customer_id=$2 AND expires_at<=now()").bind(tenant).bind(customer).execute(&mut *tx).await?;
        // Explicit no-merge policy. A signed-in session revokes its previous guest memory.
        if let Some(hash) = &hash {
            sqlx::query(
                "DELETE FROM customers.memory_subjects WHERE tenant_id=$1 AND guest_hash=$2",
            )
            .bind(tenant)
            .bind(hash)
            .execute(&mut *tx)
            .await?;
        }
        let q=format!("INSERT INTO customers.memory_subjects(id,tenant_id,customer_id,expires_at) VALUES($1,$2,$3,now()+interval '90 days') ON CONFLICT(tenant_id,customer_id) DO UPDATE SET customer_id=excluded.customer_id RETURNING {SUBJECT}");
        (
            sqlx::query_as(&q)
                .bind(Uuid::new_v4())
                .bind(tenant)
                .bind(customer)
                .fetch_one(&mut *tx)
                .await?,
            Some(String::new()),
        )
    } else {
        let q=format!("SELECT {SUBJECT} FROM customers.memory_subjects WHERE tenant_id=$1 AND guest_hash=$2 AND expires_at>now()");
        let found = sqlx::query_as(&q)
            .bind(tenant)
            .bind(hash)
            .fetch_optional(&mut *tx)
            .await?;
        if let Some(subject) = found {
            (subject, None)
        } else {
            let token = infra_auth::token();
            let q=format!("INSERT INTO customers.memory_subjects(id,tenant_id,guest_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour') RETURNING {SUBJECT}");
            (
                sqlx::query_as(&q)
                    .bind(Uuid::new_v4())
                    .bind(tenant)
                    .bind(infra_auth::digest(&token))
                    .fetch_one(&mut *tx)
                    .await?,
                Some(token),
            )
        }
    };
    tx.commit().await?;
    Ok(result)
}
pub async fn authorized(
    pool: &PgPool,
    tenant: Uuid,
    id: Uuid,
    customer: Option<Uuid>,
) -> Result<Subject> {
    let q=format!("SELECT {SUBJECT} FROM customers.memory_subjects WHERE tenant_id=$1 AND id=$2 AND customer_id IS NOT DISTINCT FROM $3 AND expires_at>now()");
    sqlx::query_as(&q)
        .bind(tenant)
        .bind(id)
        .bind(customer)
        .fetch_optional(pool)
        .await?
        .ok_or(Error::NotFound)
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub query: String,
    pub attributes: BTreeMap<String, String>,
    pub min_price: Option<String>,
    pub max_price: Option<String>,
    pub currency: Option<String>,
    pub brand: Option<String>,
    pub category: Option<String>,
    #[serde(default)]
    pub exclusive_max: bool,
    #[serde(default)]
    pub exclusive_min: bool,
    #[serde(default)]
    pub in_stock: bool,
    pub intended_use: Option<String>,
    pub recipient: Option<String>,
    pub occasion: Option<String>,
    #[serde(default)]
    pub excluded_brands: Vec<String>,
    #[serde(default)]
    pub shown_brands: Vec<String>,
    pub product_ids: Vec<Uuid>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Context {
    pub revision: i64,
    pub snapshot: Option<Snapshot>,
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub id: Uuid,
    pub attribute: String,
    pub value: String,
    pub category_id: Uuid,
    pub occasion: String,
    pub recipient: String,
    pub goal_id: Option<Uuid>,
    pub signal: String,
    pub weight: i32,
    pub provenance: String,
    pub consent_version: i32,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreferenceInput {
    pub attribute: String,
    pub value: String,
    pub category_id: Uuid,
    pub occasion: String,
    pub recipient: String,
    pub goal_id: Option<Uuid>,
    pub dislike: bool,
    pub replaces: Option<Uuid>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Consent {
    pub personalized: bool,
    pub journey: bool,
    pub expected_version: i32,
}
pub fn safe_text(value: &str) -> bool {
    let words = value.to_lowercase();
    ![
        "pregnan",
        "diabet",
        "religio",
        "politic",
        "sexual",
        "fertility",
        "cancer",
        "depression",
        "hiv",
        "disabil",
        "ethnic",
        "medical",
        "diagnos",
    ]
    .iter()
    .any(|word| words.contains(word))
        && !value.chars().any(|c| c.is_control())
}
pub async fn consent(pool: &PgPool, subject: &Subject, input: Consent) -> Result<()> {
    if input.journey && (!input.personalized || subject.customer_id.is_none()) {
        return Err(Error::Invalid(
            "Journey personalization requires sign-in and consent".into(),
        ));
    }
    let mut tx = pool.begin().await?;
    let count=sqlx::query("UPDATE customers.memory_subjects SET personalized=$2,journey_consent=$3,consent_version=consent_version+1 WHERE id=$1 AND consent_version=$4 AND expires_at>now()").bind(subject.id).bind(input.personalized).bind(input.journey).bind(input.expected_version).execute(&mut *tx).await?.rows_affected();
    if count != 1 {
        return Err(Error::Conflict);
    }
    sqlx::query("INSERT INTO customers.memory_consents(subject_id,version,personalized,journey) VALUES($1,$2,$3,$4)").bind(subject.id).bind(input.expected_version+1).bind(input.personalized).bind(input.journey).execute(&mut *tx).await?;
    if !input.personalized {
        sqlx::query("DELETE FROM customers.preference_evidence WHERE subject_id=$1")
            .bind(subject.id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("DELETE FROM customers.memory_consents WHERE subject_id=$1 AND (created_at<now()-interval '90 days' OR version <= (SELECT consent_version-100 FROM customers.memory_subjects WHERE id=$1))").bind(subject.id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
pub async fn preferences(pool: &PgPool, subject: &Subject) -> Result<Vec<Evidence>> {
    sqlx::query(
        "DELETE FROM customers.preference_evidence WHERE subject_id=$1 AND expires_at<=now()",
    )
    .bind(subject.id)
    .execute(pool)
    .await?;
    if !subject.personalized {
        return Ok(vec![]);
    }
    Ok(sqlx::query_as("SELECT id,attribute,value,category_id,occasion,recipient,goal_id,signal,weight,provenance,consent_version,created_at,expires_at FROM customers.preference_evidence WHERE subject_id=$1 ORDER BY created_at DESC,id LIMIT 100").bind(subject.id).fetch_all(pool).await?)
}
pub async fn save_preference(
    pool: &PgPool,
    subject: &Subject,
    input: PreferenceInput,
) -> Result<Evidence> {
    if !subject.personalized {
        return Err(Error::Forbidden);
    }
    let config = configuration(pool).await?;
    if !config.allowed_categories.contains(&input.category_id)
        || !["product", "brand", "color", "style", "metal", "material"]
            .contains(&input.attribute.as_str())
        || input.value.trim().is_empty()
        || input.value.chars().count() > 100
        || !safe_text(&input.value)
        || !["any", "everyday", "gift", "work", "travel"].contains(&input.occasion.as_str())
        || !["self", "other"].contains(&input.recipient.as_str())
    {
        return Err(Error::Invalid(
            "Choose an allowed catalog preference and context".into(),
        ));
    }
    if input.attribute == "product" {
        let id = input
            .value
            .parse::<Uuid>()
            .map_err(|_| Error::Invalid("Choose a product".into()))?;
        let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.products WHERE id=$1 AND category_id=$2 AND active AND (parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.products p WHERE p.id=catalog.products.parent_id AND p.active)))").bind(id).bind(input.category_id).fetch_one(pool).await?;
        if !exists {
            return Err(Error::NotFound);
        }
    } else {
        let defs = domain_attributes::Service { pool: pool.clone() }
            .list("product")
            .await?;
        let def = defs
            .iter()
            .find(|d| {
                d.attribute_code == input.attribute && domain_attributes::schema::eligible(d, true)
            })
            .ok_or(Error::Invalid("Preference attribute is not public".into()))?;
        domain_attributes::validate_value(def, &serde_json::json!(input.value))?;
    }
    let mut tx = pool.begin().await?;
    let allowed:bool=sqlx::query_scalar("SELECT personalized AND consent_version=$2 FROM customers.memory_subjects WHERE id=$1 AND expires_at>now() FOR UPDATE").bind(subject.id).bind(subject.consent_version).fetch_optional(&mut *tx).await?.unwrap_or(false);
    if !allowed {
        return Err(Error::Forbidden);
    }
    if let Some(id) = input.replaces {
        if sqlx::query("DELETE FROM customers.preference_evidence WHERE subject_id=$1 AND id=$2")
            .bind(subject.id)
            .bind(id)
            .execute(&mut *tx)
            .await?
            .rows_affected()
            != 1
        {
            return Err(Error::NotFound);
        }
    }
    sqlx::query("DELETE FROM customers.preference_evidence WHERE subject_id=$1 AND attribute=$2 AND lower(value)=lower($3) AND category_id=$4 AND occasion=$5 AND recipient=$6 AND goal_id IS NOT DISTINCT FROM $7").bind(subject.id).bind(&input.attribute).bind(input.value.trim()).bind(input.category_id).bind(&input.occasion).bind(&input.recipient).bind(input.goal_id).execute(&mut *tx).await?;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM customers.preference_evidence WHERE subject_id=$1",
    )
    .bind(subject.id)
    .fetch_one(&mut *tx)
    .await?;
    if count >= 100 {
        return Err(Error::Invalid(
            "Remove a preference before adding another".into(),
        ));
    }
    let expires = subject
        .expires_at
        .min(Utc::now() + Duration::days(config.retention_days as i64));
    let row=sqlx::query_as("INSERT INTO customers.preference_evidence(id,subject_id,attribute,value,category_id,occasion,recipient,goal_id,signal,weight,consent_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,attribute,value,category_id,occasion,recipient,goal_id,signal,weight,provenance,consent_version,created_at,expires_at")
        .bind(Uuid::new_v4()).bind(subject.id).bind(input.attribute).bind(input.value.trim()).bind(input.category_id).bind(input.occasion).bind(input.recipient).bind(input.goal_id).bind(if input.dislike {"explicit_dislike"}else{"explicit_like"}).bind(if input.dislike {-100}else{100}).bind(subject.consent_version).bind(expires).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(row)
}
pub async fn context(pool: &PgPool, subject: &Subject, conversation: Uuid) -> Result<Context> {
    let row:Option<(i64,serde_json::Value)>=sqlx::query_as("SELECT revision,snapshot FROM customers.memory_contexts WHERE subject_id=$1 AND conversation_id=$2 AND expires_at>now()").bind(subject.id).bind(conversation).fetch_optional(pool).await?;
    Ok(match row {
        Some((revision, snapshot)) => Context {
            revision,
            snapshot: Some(serde_json::from_value(snapshot).map_err(|_| Error::Internal)?),
        },
        None => Context {
            revision: 0,
            snapshot: None,
        },
    })
}
pub async fn save_context(
    pool: &PgPool,
    subject: &Subject,
    conversation: Uuid,
    expected: i64,
    snapshot: Snapshot,
) -> Result<()> {
    if snapshot.query.len() > 200
        || !safe_text(&snapshot.query)
        || snapshot.attributes.len() > 10
        || snapshot.attributes.iter().any(|(k, v)| {
            ![
                "brand",
                "color",
                "style",
                "metal",
                "material",
                "size",
                "roast",
                "product-kind",
            ]
            .contains(&k.as_str())
                || v.len() > 100
                || !safe_text(v)
        })
        || [&snapshot.brand, &snapshot.category, &snapshot.intended_use]
            .iter()
            .any(|v| v.as_ref().is_some_and(|v| v.len() > 100 || !safe_text(v)))
        || [&snapshot.min_price, &snapshot.max_price].iter().any(|v| {
            v.as_ref().is_some_and(|v| {
                v.len() > 20
                    || v.parse::<rust_decimal::Decimal>()
                        .map_or(true, |d| d.is_sign_negative())
            })
        })
        || snapshot
            .currency
            .as_ref()
            .is_some_and(|v| v.len() != 3 || !v.bytes().all(|c| c.is_ascii_uppercase()))
        || snapshot
            .recipient
            .as_ref()
            .is_some_and(|v| !["self", "other"].contains(&v.as_str()))
        || snapshot
            .occasion
            .as_ref()
            .is_some_and(|v| !["everyday", "gift", "work", "travel"].contains(&v.as_str()))
        || snapshot.excluded_brands.len() > 10
        || snapshot.shown_brands.len() > 5
        || snapshot
            .excluded_brands
            .iter()
            .chain(&snapshot.shown_brands)
            .any(|v| v.len() > 100 || !safe_text(v))
        || snapshot.product_ids.is_empty()
        || snapshot.product_ids.len() > 5
        || serde_json::to_vec(&snapshot)
            .map_err(|_| Error::Internal)?
            .len()
            > 4096
    {
        return Err(Error::Invalid(
            "Invalid or sensitive catalog context".into(),
        ));
    }
    let config = configuration(pool).await?;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM catalog.products WHERE id=ANY($1) AND category_id=ANY($2) AND active AND (parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.products p WHERE p.id=catalog.products.parent_id AND p.active))",
    )
    .bind(&snapshot.product_ids)
    .bind(config.allowed_categories)
    .fetch_one(pool)
    .await?;
    if count != snapshot.product_ids.len() as i64 {
        return Err(Error::Invalid(
            "Context products are not approved for memory".into(),
        ));
    }
    let mut tx = pool.begin().await?;
    sqlx::query(
        "SELECT id FROM customers.memory_subjects WHERE id=$1 AND expires_at>now() FOR UPDATE",
    )
    .bind(subject.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;
    sqlx::query("DELETE FROM customers.memory_contexts WHERE subject_id=$1 AND expires_at<=now()")
        .bind(subject.id)
        .execute(&mut *tx)
        .await?;
    let current: i64 = sqlx::query_scalar(
        "SELECT revision FROM customers.memory_contexts WHERE subject_id=$1 AND conversation_id=$2",
    )
    .bind(subject.id)
    .bind(conversation)
    .fetch_optional(&mut *tx)
    .await?
    .unwrap_or(0);
    if current != expected {
        return Err(Error::Conflict);
    }
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM customers.memory_contexts WHERE subject_id=$1")
            .bind(subject.id)
            .fetch_one(&mut *tx)
            .await?;
    if current == 0 && count >= 10 {
        return Err(Error::Invalid(
            "Context limit reached; clear an old conversation".into(),
        ));
    }
    sqlx::query("INSERT INTO customers.memory_contexts(subject_id,conversation_id,revision,snapshot,expires_at) VALUES($1,$2,1,$3,$4) ON CONFLICT(subject_id,conversation_id) DO UPDATE SET snapshot=$3,revision=memory_contexts.revision+1,expires_at=$4,updated_at=now()")
        .bind(subject.id).bind(conversation).bind(serde_json::json!(snapshot)).bind(subject.expires_at.min(Utc::now()+Duration::days(1))).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn revoke_guest(pool: &PgPool, cookie: &str) -> Result<()> {
    if !cookie.is_empty() && cookie.len() <= 128 {
        sqlx::query("DELETE FROM customers.memory_subjects WHERE guest_hash=$1")
            .bind(infra_auth::digest(cookie))
            .execute(pool)
            .await?;
    }
    Ok(())
}

pub async fn purge(pool: &PgPool, tenant: Uuid) -> Result<()> {
    sqlx::query("DELETE FROM customers.memory_subjects WHERE id IN (SELECT id FROM customers.memory_subjects WHERE tenant_id=$1 AND expires_at<=now() LIMIT 1000)").bind(tenant).execute(pool).await?;
    sqlx::query("DELETE FROM customers.memory_contexts WHERE (subject_id,conversation_id) IN (SELECT c.subject_id,c.conversation_id FROM customers.memory_contexts c JOIN customers.memory_subjects s ON s.id=c.subject_id WHERE s.tenant_id=$1 AND c.expires_at<=now() LIMIT 1000)").bind(tenant).execute(pool).await?;
    sqlx::query("DELETE FROM customers.preference_evidence WHERE id IN (SELECT e.id FROM customers.preference_evidence e JOIN customers.memory_subjects s ON s.id=e.subject_id WHERE s.tenant_id=$1 AND e.expires_at<=now() LIMIT 1000)").bind(tenant).execute(pool).await?;
    sqlx::query("DELETE FROM customers.memory_consents WHERE (subject_id,version) IN (SELECT c.subject_id,c.version FROM customers.memory_consents c JOIN customers.memory_subjects s ON s.id=c.subject_id WHERE s.tenant_id=$1 AND c.created_at<now()-interval '90 days' LIMIT 1000)").bind(tenant).execute(pool).await?;
    Ok(())
}
