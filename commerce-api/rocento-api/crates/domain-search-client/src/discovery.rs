//! Bounded, provider-independent candidate ranking and reviewed relational evidence.
use chrono::{DateTime, Utc};
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub const CANDIDATE_LIMIT: usize = 40;
pub const VERSION: &str = "1.0.0";
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EdgeInput {
    pub product_id: Uuid,
    pub relation: String,
    pub target_product_id: Option<Uuid>,
    pub value: String,
    pub dimensions: BTreeMap<String, String>,
    pub source: String,
    pub reviewed: bool,
    pub expires_at: DateTime<Utc>,
}
#[derive(Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(deny_unknown_fields)]
pub struct Edge {
    pub id: Uuid,
    pub product_id: Uuid,
    pub relation: String,
    pub target_product_id: Option<Uuid>,
    pub value: String,
    pub dimensions: serde_json::Value,
    pub source: String,
    pub reviewed: bool,
    pub updated_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Offer {
    pub product_id: Uuid,
    pub parent_id: Option<Uuid>,
    pub category_id: Uuid,
    pub price: String,
    pub currency: String,
    pub selling_unit: String,
    pub in_stock: Option<bool>,
    pub observed_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contribution {
    pub code: String,
    pub points: i32,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Projection {
    pub schema_version: String,
    pub rank: usize,
    pub score: i32,
    pub contributions: Vec<Contribution>,
    pub sponsored: bool,
    pub merchant_boost: i32,
    pub offer: Offer,
    pub relationships: Vec<Edge>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub schema_version: String,
    pub retrieval: String,
    pub ranker: String,
    pub lexical_candidates: usize,
    pub relation_candidates: usize,
    pub evaluated: usize,
    pub eligible: usize,
    pub returned: usize,
    pub exhaustive: bool,
    pub semantic_enabled: bool,
    pub outcome: String,
}
#[derive(Clone)]
pub struct RankInput {
    pub id: Uuid,
    pub family: Uuid,
    pub lexical_position: Option<usize>,
    pub reviewed_relation: bool,
    pub in_stock: Option<bool>,
    pub boost: i32,
    pub sponsored: bool,
}
#[derive(Clone)]
pub struct Ranked {
    pub id: Uuid,
    pub score: i32,
    pub contributions: Vec<Contribution>,
}
pub trait Reranker {
    fn version(&self) -> &'static str;
    fn rank(&self, eligible: &[RankInput]) -> Vec<Ranked>;
}
pub struct DeterministicRanker;
impl Reranker for DeterministicRanker {
    fn version(&self) -> &'static str {
        "ranker://commerce/relevance-diversity@1.0.0"
    }
    fn rank(&self, eligible: &[RankInput]) -> Vec<Ranked> {
        let mut remaining = eligible.to_vec();
        let mut output = Vec::new();
        let mut families = BTreeMap::<Uuid, i32>::new();
        while !remaining.is_empty() {
            let score = |p: &RankInput| {
                let lexical = p
                    .lexical_position
                    .map(|n| 200 - (n.min(39) as i32) * 2)
                    .unwrap_or(0);
                let relation = if p.reviewed_relation { 160 } else { 0 };
                let availability = if p.in_stock == Some(true) { 20 } else { 0 };
                let diversity = -40 * families.get(&p.family).copied().unwrap_or(0);
                vec![
                    Contribution {
                        code: "lexical_relevance".into(),
                        points: lexical,
                    },
                    Contribution {
                        code: "reviewed_relation".into(),
                        points: relation,
                    },
                    Contribution {
                        code: "verified_availability".into(),
                        points: availability,
                    },
                    Contribution {
                        code: "merchant_boost".into(),
                        points: p.boost.clamp(0, 10),
                    },
                    Contribution {
                        code: "family_diversity".into(),
                        points: diversity,
                    },
                ]
            };
            remaining.sort_by_key(|p| (-score(p).iter().map(|s| s.points).sum::<i32>(), p.id));
            let p = remaining.remove(0);
            let contributions = score(&p);
            let total = contributions.iter().map(|s| s.points).sum();
            *families.entry(p.family).or_default() += 1;
            output.push(Ranked {
                id: p.id,
                score: total,
                contributions,
            });
        }
        output
    }
}
pub fn checked_rank(eligible: &[RankInput], ranker: &impl Reranker) -> Result<Vec<Ranked>> {
    if eligible.len() > CANDIDATE_LIMIT {
        return Err(Error::Invalid("Candidate budget exceeded".into()));
    }
    let output = ranker.rank(eligible);
    let expected: BTreeSet<_> = eligible.iter().map(|p| p.id).collect();
    if output.len() != expected.len()
        || output.iter().map(|p| p.id).collect::<BTreeSet<_>>() != expected
        || output.iter().any(|p| {
            p.contributions.len() > 10
                || p.contributions.iter().any(|v| {
                    !(-10000..=10000).contains(&v.points)
                        || v.code.is_empty()
                        || v.code.len() > 64
                        || !v.code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                })
                || p.score != p.contributions.iter().map(|v| v.points).sum::<i32>()
        })
    {
        return Err(Error::Internal);
    }
    Ok(output)
}
pub fn normalize(query: &str) -> String {
    // Exact words/units are preserved. No hard constraint or product name is removed.
    query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
pub async fn enabled(pool: &PgPool) -> Result<bool> {
    Ok(
        sqlx::query_scalar("SELECT enabled FROM catalog.discovery_configuration WHERE singleton")
            .fetch_one(pool)
            .await?,
    )
}
pub async fn relation_candidates(pool: &PgPool, query: &str) -> Result<Vec<Uuid>> {
    let query = normalize(query);
    if query == "*" {
        return Ok(vec![]);
    }
    Ok(sqlx::query_scalar("SELECT DISTINCT e.product_id FROM catalog.discovery_edges e JOIN catalog.products p ON p.id=e.product_id AND p.active WHERE e.reviewed AND e.expires_at>now() AND e.relation IN ('used_for','occasion','synonym') AND lower(e.value)=$1 ORDER BY e.product_id LIMIT 20")
        .bind(query).fetch_all(pool).await?)
}
pub async fn edges(pool: &PgPool, ids: &[Uuid]) -> Result<Vec<Edge>> {
    Ok(sqlx::query_as("SELECT e.id,e.product_id,e.relation,e.target_product_id,e.value,e.dimensions,e.source,e.reviewed,e.updated_at,e.expires_at FROM unnest($1::uuid[]) requested(id) CROSS JOIN LATERAL (SELECT e.* FROM catalog.discovery_edges e JOIN catalog.products p ON p.id=e.product_id AND p.active LEFT JOIN catalog.products t ON t.id=e.target_product_id WHERE e.product_id=requested.id AND e.reviewed AND e.expires_at>now() AND (e.target_product_id IS NULL OR t.active) ORDER BY e.id LIMIT 10) e LIMIT 400")
        .bind(ids).fetch_all(pool).await?)
}
pub async fn save_edge(pool: &PgPool, input: EdgeInput, actor: Uuid) -> Result<Edge> {
    let relations = [
        "belongs_to",
        "variant_of",
        "compatible_with",
        "incompatible_with",
        "substitutes",
        "complements",
        "required_accessory",
        "used_for",
        "occasion",
        "contains",
        "excludes",
        "selling_unit",
        "policy_restriction",
        "synonym",
    ];
    if !relations.contains(&input.relation.as_str())
        || !["merchant", "imported", "generated"].contains(&input.source.as_str())
        || input.value.trim().is_empty()
        || input.value.chars().count() > 160
        || input.dimensions.len() > 10
        || input
            .dimensions
            .iter()
            .any(|(k, v)| k.len() > 64 || v.len() > 160)
        || input.target_product_id == Some(input.product_id)
        || input.expires_at <= Utc::now()
        || input.expires_at > Utc::now() + chrono::Duration::days(365)
    {
        return Err(Error::Invalid(
            "Invalid relationship, evidence dimensions or expiry".into(),
        ));
    }
    if [
        "variant_of",
        "compatible_with",
        "incompatible_with",
        "substitutes",
        "complements",
        "required_accessory",
    ]
    .contains(&input.relation.as_str())
        && input.target_product_id.is_none()
    {
        return Err(Error::Invalid("A target product is required".into()));
    }
    if input.relation == "substitutes" && input.dimensions.is_empty() {
        return Err(Error::Invalid("Equivalence dimensions are required".into()));
    }
    let id = Uuid::new_v4();
    let mut tx = pool.begin().await?;
    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.products WHERE id=$1 AND active) AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM catalog.products WHERE id=$2 AND active))").bind(input.product_id).bind(input.target_product_id).fetch_one(&mut *tx).await?;
    if !exists {
        return Err(Error::NotFound);
    }
    let e=sqlx::query_as("INSERT INTO catalog.discovery_edges(id,product_id,relation,target_product_id,value,dimensions,source,reviewed,reviewed_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,product_id,relation,target_product_id,value,dimensions,source,reviewed,updated_at,expires_at")
        .bind(id).bind(input.product_id).bind(input.relation).bind(input.target_product_id).bind(input.value.split_whitespace().collect::<Vec<_>>().join(" ")).bind(serde_json::json!(input.dimensions)).bind(input.source).bind(input.reviewed).bind(input.reviewed.then_some(actor)).bind(input.expires_at).fetch_one(&mut *tx).await?;
    infra_events::record(
        &mut tx,
        "catalog.relationship_reviewed",
        serde_json::json!({"id":id,"actor":actor,"reviewed":input.reviewed}),
    )
    .await?;
    tx.commit().await?;
    Ok(e)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn candidate(id: u128, family: u128, position: usize, boost: i32) -> RankInput {
        RankInput {
            id: Uuid::from_u128(id),
            family: Uuid::from_u128(family),
            lexical_position: Some(position),
            reviewed_relation: false,
            in_stock: Some(true),
            boost,
            sponsored: boost > 0,
        }
    }
    #[test]
    fn ranking_diversifies_families_and_caps_commercial_pressure() {
        let input = vec![
            candidate(1, 1, 0, 0),
            candidate(2, 1, 1, 0),
            candidate(3, 3, 2, 0),
            candidate(4, 4, 19, 10000),
        ];
        let result = checked_rank(&input, &DeterministicRanker).unwrap();
        assert_eq!(
            result.iter().map(|v| v.id.as_u128()).collect::<Vec<_>>(),
            vec![1, 3, 4, 2]
        );
        assert_eq!(
            result[2]
                .contributions
                .iter()
                .find(|v| v.code == "merchant_boost")
                .unwrap()
                .points,
            10
        );
    }
    struct Poison;
    impl Reranker for Poison {
        fn version(&self) -> &'static str {
            "invalid"
        }
        fn rank(&self, _: &[RankInput]) -> Vec<Ranked> {
            vec![Ranked {
                id: Uuid::from_u128(99),
                score: 0,
                contributions: vec![],
            }]
        }
    }
    #[test]
    fn ranker_cannot_inject_ids_or_exceed_candidate_budget() {
        assert!(checked_rank(&[candidate(1, 1, 0, 0)], &Poison).is_err());
        assert!(checked_rank(&vec![candidate(1, 1, 0, 0); 41], &DeterministicRanker).is_err());
    }
    #[test]
    fn normalization_preserves_exclusions_units_and_spelling() {
        assert_eq!(
            normalize("  Gold  18K \n without Nickel 0.5 g "),
            "gold 18k without nickel 0.5 g"
        );
    }
}
