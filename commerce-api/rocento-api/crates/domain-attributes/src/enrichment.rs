//! Proposal-only enrichment boundary. No model invocation or unrestricted catalog writes.
use crate::{bad, Definition, Service};
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;
mod extraction;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub field: String,
    pub quote: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SuggestionQuery {
    pub status: Option<String>,
    pub before: Option<Uuid>,
    pub limit: Option<i64>,
    pub product_id: Option<Uuid>,
}

#[derive(Debug, sqlx::FromRow)]
struct ProductBasis {
    name: String,
    description: String,
    attributes: Value,
    attribute_set_id: Option<Uuid>,
}
impl ProductBasis {
    fn snapshot(&self, code: &str) -> Value {
        json!({"name":self.name,"description":self.description,
            "attribute_set_id":self.attribute_set_id,
            "present":self.attributes.get(code).is_some(),"value":self.attributes.get(code)})
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SuggestionInput {
    pub product_id: Uuid,
    pub definition_id: Uuid,
    pub value: Value,
    pub source: String,
    pub confidence: f64,
    pub model_version: String,
    pub evidence: Evidence,
}
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Suggestion {
    pub id: Uuid,
    pub entity_id: i64,
    pub product_id: Uuid,
    pub definition_id: Uuid,
    pub value: Value,
    pub source: String,
    pub confidence: f64,
    pub model_version: String,
    pub status: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub reviewed_at: Option<chrono::DateTime<chrono::Utc>>,
    pub reviewed_by: Option<Uuid>,
    pub evidence: Option<sqlx::types::Json<Evidence>>,
    #[serde(skip_serializing)]
    basis: Option<Value>,
    #[serde(skip_serializing)]
    definition_version: Option<i32>,
}
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ValueRecord {
    pub code: String,
    pub value: Value,
    pub source: String,
    pub confidence: Option<f64>,
    pub model_version: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Review {
    pub approve: bool,
}
/// External enrichment implementations return these proposals; only the domain persists/reviews them.
pub trait CatalogEnrichmentService: Send + Sync {
    fn suggest(
        &self,
        product: Value,
        schema: super::schema::CatalogSchema,
    ) -> impl std::future::Future<Output = Result<Vec<SuggestionInput>>> + Send;
}
pub fn can_enrich(d: &Definition) -> bool {
    d.metadata.active()
        && d.metadata.ai_enrichable
        && d.metadata.source_policy == "semantic"
        && !d.used_for_configurations
}
impl Service {
    pub async fn suggestions(&self) -> Result<Vec<Suggestion>> {
        self.suggestion_page(SuggestionQuery::default()).await
    }
    pub async fn suggestion_page(&self, query: SuggestionQuery) -> Result<Vec<Suggestion>> {
        let limit = query.limit.unwrap_or(50);
        if !(1..=100).contains(&limit)
            || query
                .status
                .as_deref()
                .is_some_and(|s| !["pending", "approved", "rejected"].contains(&s))
        {
            return Err(bad("Invalid suggestion filter or page size"));
        }
        let before: Option<(chrono::DateTime<chrono::Utc>, Uuid)> = if let Some(id) = query.before {
            Some(
                sqlx::query_as(
                    "SELECT created_at,id FROM attributes.enrichment_suggestions WHERE id=$1",
                )
                .bind(id)
                .fetch_optional(&self.pool)
                .await?
                .ok_or_else(|| bad("Suggestion cursor no longer exists; refresh the queue"))?,
            )
        } else {
            None
        };
        Ok(sqlx::query_as("SELECT * FROM attributes.enrichment_suggestions WHERE ($1::text IS NULL OR status=$1) AND ($2::uuid IS NULL OR product_id=$2) AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$4)) ORDER BY created_at DESC,id DESC LIMIT $5")
            .bind(query.status).bind(query.product_id).bind(before.map(|b| b.0)).bind(before.map(|b| b.1)).bind(limit).fetch_all(&self.pool).await?)
    }
    pub async fn value_records(&self, id: Uuid) -> Result<Vec<ValueRecord>> {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.products WHERE id=$1)")
                .bind(id)
                .fetch_one(&self.pool)
                .await?;
        if !exists {
            return Err(Error::NotFound);
        }
        Ok(sqlx::query_as("SELECT d.attribute_code AS code,p.attributes->d.attribute_code AS value,COALESCE(v.source,'MERCHANT') AS source,v.confidence,v.model_version FROM catalog.products p JOIN attributes.definitions d ON d.entity_type='product' AND p.attributes ? d.attribute_code LEFT JOIN attributes.value_provenance v ON v.product_id=p.id AND v.definition_id=d.id WHERE p.id=$1 ORDER BY d.attribute_code").bind(id).fetch_all(&self.pool).await?)
    }
    pub async fn propose(&self, input: SuggestionInput) -> Result<Suggestion> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(2002)")
            .execute(&mut *tx)
            .await?;
        let row = propose_in(&mut tx, input).await?;
        tx.commit().await?;
        Ok(row)
    }

    /// Bounded, local extraction. No external model, automatic publishing, or image inference.
    pub async fn generate_enrichment(&self, product_id: Uuid) -> Result<Vec<Suggestion>> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(2002)")
            .execute(&mut *tx)
            .await?;
        let product = load_product(&mut tx, product_id).await?;
        let definitions: Vec<Definition> = sqlx::query_as("SELECT d.* FROM attributes.definitions d WHERE d.entity_type='product' AND ($1::uuid IS NULL OR EXISTS(SELECT 1 FROM attributes.set_members m WHERE m.definition_id=d.id AND m.set_id=$1)) ORDER BY d.id LIMIT 1001")
            .bind(product.attribute_set_id).fetch_all(&mut *tx).await?;
        if definitions.len() > 1000 || product.description.len() > 100_000 {
            return Err(bad("Product exceeds the supported enrichment size"));
        }
        let mut rows = Vec::new();
        for definition in definitions.iter().filter(|d| can_enrich(d)) {
            // Generation fills gaps only; replacing an existing value needs an explicit proposal.
            if product.attributes.get(&definition.attribute_code).is_some() {
                continue;
            }
            if let Some((value, evidence)) = extraction::extract(definition, &product.description) {
                rows.push(
                    propose_in(
                        &mut tx,
                        SuggestionInput {
                            product_id,
                            definition_id: definition.id,
                            value,
                            source: "DERIVED".into(),
                            confidence: 1.0,
                            model_version: "labelled-description-v1".into(),
                            evidence,
                        },
                    )
                    .await?,
                );
            }
            if rows.len() == 50 {
                break;
            }
        }
        tx.commit().await?;
        Ok(rows)
    }

    pub async fn review_suggestion(
        &self,
        id: Uuid,
        review: Review,
        actor: Uuid,
    ) -> Result<Suggestion> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(2002)")
            .execute(&mut *tx)
            .await?;
        let suggestion: Suggestion = sqlx::query_as(
            "SELECT * FROM attributes.enrichment_suggestions WHERE id=$1 FOR UPDATE",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::NotFound)?;
        if suggestion.status != "pending" {
            return Err(Error::Conflict);
        }
        if review.approve {
            let d: Definition = sqlx::query_as(
                "SELECT * FROM attributes.definitions WHERE id=$1 AND entity_type='product'",
            )
            .bind(suggestion.definition_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::NotFound)?;
            if !can_enrich(&d) {
                return Err(bad("This attribute no longer permits inference"));
            }
            let product = load_product(&mut tx, suggestion.product_id).await?;
            if suggestion.definition_version != Some(d.version)
                || suggestion.basis.as_ref() != Some(&product.snapshot(&d.attribute_code))
                || suggestion.evidence.is_none()
            {
                return Err(bad("Suggestion is stale or lacks source evidence. Reject it and generate a new suggestion."));
            }
            let mut values = product.attributes;
            let source:Option<String>=sqlx::query_scalar("SELECT source FROM attributes.value_provenance WHERE product_id=$1 AND definition_id=$2").bind(suggestion.product_id).bind(d.id).fetch_optional(&mut *tx).await?;
            if values.get(&d.attribute_code).is_some()
                && !matches!(source.as_deref(), Some("AI_INFERRED" | "DERIVED"))
            {
                return Err(bad(
                    "Enrichment cannot overwrite authoritative catalog values",
                ));
            }
            crate::validate_value(&d, &suggestion.value)?;
            values[&d.attribute_code] = suggestion.value.clone();
            crate::validate_set(&mut tx, product.attribute_set_id, &values).await?;
            crate::validate_product(
                &mut tx,
                suggestion.product_id,
                &values,
                product.attribute_set_id,
            )
            .await?;
            sqlx::query("UPDATE catalog.products SET attributes=$2,updated_at=clock_timestamp() WHERE id=$1").bind(suggestion.product_id).bind(values).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO attributes.value_provenance(product_id,definition_id,source,confidence,model_version) VALUES($1,$2,$3,$4,$5) ON CONFLICT(product_id,definition_id) DO UPDATE SET source=$3,confidence=$4,model_version=$5,updated_at=clock_timestamp()")
                .bind(suggestion.product_id).bind(d.id).bind(&suggestion.source).bind(suggestion.confidence).bind(&suggestion.model_version).execute(&mut *tx).await?;
            infra_events::record(
                &mut tx,
                "catalog.product_updated",
                json!({"id":suggestion.product_id}),
            )
            .await?;
        }
        let row=sqlx::query_as("UPDATE attributes.enrichment_suggestions SET status=$2,reviewed_at=clock_timestamp(),reviewed_by=$3 WHERE id=$1 RETURNING *").bind(id).bind(if review.approve{"approved"}else{"rejected"}).bind(actor).fetch_one(&mut *tx).await?;
        sqlx::query("INSERT INTO admin_iam.audit_log(id,actor_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)")
            .bind(Uuid::new_v4()).bind(actor).bind(if review.approve {"catalog.enrichment_approved"} else {"catalog.enrichment_rejected"})
            .bind(id).bind(json!({"product_id":suggestion.product_id,"definition_id":suggestion.definition_id})).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(row)
    }
}

async fn load_product(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<ProductBasis> {
    sqlx::query_as("SELECT name,description,attributes,attribute_set_id FROM catalog.products WHERE id=$1 FOR UPDATE")
        .bind(id).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
}

async fn propose_in(
    tx: &mut Transaction<'_, Postgres>,
    input: SuggestionInput,
) -> Result<Suggestion> {
    if !["AI_INFERRED", "DERIVED"].contains(&input.source.as_str())
        || !input.confidence.is_finite()
        || !(0.0..=1.0).contains(&input.confidence)
        || input.model_version.trim().is_empty()
        || input.model_version.len() > 200
    {
        return Err(bad("Invalid enrichment provenance"));
    }
    let d: Definition = sqlx::query_as(
        "SELECT * FROM attributes.definitions WHERE id=$1 AND entity_type='product'",
    )
    .bind(input.definition_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(Error::NotFound)?;
    if !can_enrich(&d) {
        return Err(bad("This attribute does not permit inference"));
    }
    crate::validate_value(&d, &input.value)?;
    let product = load_product(tx, input.product_id).await?;
    let evidence_source = match input.evidence.field.as_str() {
        "name" => &product.name,
        "description" => &product.description,
        _ => {
            return Err(bad(
                "Evidence must reference the product name or description",
            ))
        }
    };
    if input.evidence.quote.trim().is_empty()
        || input.evidence.quote.len() > 4000
        || !evidence_source.contains(&input.evidence.quote)
    {
        return Err(bad(
            "Evidence must be an exact excerpt of the current product source",
        ));
    }
    let basis = product.snapshot(&d.attribute_code);
    let evidence = sqlx::types::Json(input.evidence);
    let existing: Option<Suggestion> = sqlx::query_as("SELECT * FROM attributes.enrichment_suggestions WHERE product_id=$1 AND definition_id=$2 AND value=$3 AND source=$4 AND model_version=$5 AND basis=$6 AND definition_version=$7 AND evidence=$8 ORDER BY created_at DESC,id DESC LIMIT 1")
            .bind(input.product_id).bind(d.id).bind(&input.value).bind(&input.source).bind(&input.model_version).bind(&basis).bind(d.version).bind(&evidence).fetch_optional(&mut **tx).await?;
    if let Some(existing) = existing {
        return Ok(existing);
    }
    let mut values = product.attributes;
    values[&d.attribute_code] = input.value.clone();
    crate::validate_set(tx, product.attribute_set_id, &values).await?;
    let row=sqlx::query_as("INSERT INTO attributes.enrichment_suggestions(id,product_id,definition_id,value,source,confidence,model_version,evidence,basis,definition_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *")
            .bind(Uuid::new_v4()).bind(input.product_id).bind(input.definition_id).bind(input.value).bind(input.source).bind(input.confidence).bind(input.model_version).bind(evidence).bind(basis).bind(d.version).fetch_one(&mut **tx).await?;
    Ok(row)
}
/// Only changed values become merchant-authored; unchanged inferred/verified records retain provenance.
pub async fn record_merchant(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    previous: Option<&Value>,
    values: &Value,
) -> Result<()> {
    let old = previous.cloned().unwrap_or(json!({}));
    sqlx::query("INSERT INTO attributes.value_provenance(product_id,definition_id,source) SELECT $1,d.id,'MERCHANT' FROM attributes.definitions d WHERE d.entity_type='product' AND $2::jsonb ? d.attribute_code AND ($3::jsonb->d.attribute_code IS DISTINCT FROM $2::jsonb->d.attribute_code) ON CONFLICT(product_id,definition_id) DO UPDATE SET source='MERCHANT',confidence=NULL,model_version=NULL,updated_at=clock_timestamp()")
        .bind(id).bind(values).bind(old).execute(&mut **tx).await?;
    sqlx::query("DELETE FROM attributes.value_provenance v USING attributes.definitions d WHERE v.product_id=$1 AND v.definition_id=d.id AND NOT($2::jsonb ? d.attribute_code)").bind(id).bind(values).execute(&mut **tx).await?;
    Ok(())
}
