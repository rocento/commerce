//! DTO projections and deterministic filters, shared by storefront and shopper tools.
use crate::{bad, metadata, Definition, Service};
use infra_auth::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SchemaAttribute {
    pub code: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
    pub data_type: String,
    pub options: Vec<SchemaOption>,
    pub filterable: bool,
    pub searchable: bool,
    pub facetable: bool,
    pub sortable: bool,
    pub comparable: bool,
    pub variant_axis: bool,
    pub source_policy: String,
    pub semantic_role: Option<String>,
    pub unit: Option<String>,
    pub min: Option<f64>,
    pub max: Option<f64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SchemaOption {
    pub code: String,
    pub label: String,
    pub labels: BTreeMap<String, String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogSchema {
    pub industry: Option<String>,
    pub version: String,
    pub attributes: Vec<SchemaAttribute>,
    #[serde(default)]
    pub categories: Vec<SchemaCategory>,
    #[serde(default = "complete_categories")]
    pub categories_complete: bool,
}
fn complete_categories() -> bool {
    true
}
/// Merchant names, slugs and reviewed current translations are aliases, not
/// model-generated category equivalences. Counts refer to active simple SKUs.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(deny_unknown_fields)]
pub struct SchemaCategory {
    pub id: uuid::Uuid,
    pub name: String,
    pub parent_id: Option<uuid::Uuid>,
    pub aliases: Vec<String>,
    pub sellable_count: i64,
}
impl Service {
    pub async fn catalog_schema(&self, ai: bool) -> Result<CatalogSchema> {
        let config = self.configuration().await?;
        let industry = if let Some(id) = config.industry_profile_id {
            self.profiles()
                .await?
                .into_iter()
                .find(|p| p.id == id)
                .map(|p| p.code)
        } else {
            None
        };
        let defs = self.list("product").await?;
        let version = format!(
            "{}:{}",
            config.version,
            defs.iter().map(|d| d.version as i64).sum::<i64>()
        );
        let attributes = defs
            .into_iter()
            .filter(|d| eligible(d, ai))
            .map(|d| SchemaAttribute {
                code: d.attribute_code,
                label: d.label,
                description: d.metadata.description.chars().take(500).collect(),
                data_type: metadata::canonical_type(&d.input_type).into(),
                options: d
                    .options
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|o| SchemaOption {
                        code: o["value"].as_str().unwrap_or_default().into(),
                        label: o["label"].as_str().unwrap_or_default().into(),
                        labels: serde_json::from_value(
                            o.get("labels").cloned().unwrap_or(serde_json::json!({})),
                        )
                        .unwrap_or_default(),
                    })
                    .collect(),
                filterable: d.is_filterable,
                searchable: d.is_searchable,
                facetable: d.metadata.facetable,
                sortable: d.metadata.sortable,
                comparable: d.is_comparable,
                variant_axis: d.used_for_configurations,
                source_policy: d.metadata.source_policy.clone(),
                unit: d.metadata.unit.clone(),
                semantic_role: d.metadata.semantic_role.clone(),
                min: d.metadata.min,
                max: d.metadata.max,
            })
            .collect();
        let mut categories: Vec<SchemaCategory> = sqlx::query_as(
            "WITH RECURSIVE descendants(root,id) AS (SELECT id,id FROM catalog.categories UNION SELECT d.root,c.id FROM descendants d JOIN catalog.categories c ON c.parent_id=d.id) SELECT c.id,c.name,c.parent_id,ARRAY[c.slug]::text[] AS aliases,count(DISTINCT p.id)::bigint AS sellable_count FROM catalog.categories c LEFT JOIN descendants d ON d.root=c.id LEFT JOIN catalog.products p ON (p.category_id=d.id OR d.id=ANY(p.category_ids)) AND p.active AND p.product_type='simple' AND (p.parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.products parent WHERE parent.id=p.parent_id AND parent.active)) GROUP BY c.id ORDER BY c.name,c.id LIMIT 201",
        ).fetch_all(&self.pool).await?;
        let categories_complete = categories.len() <= 200;
        categories.truncate(200);
        let ids: Vec<_> = categories.iter().map(|c| c.id).collect();
        let translations: Vec<(uuid::Uuid, Value)> = sqlx::query_as(
            "SELECT t.entity_id,t.fields FROM cms.catalog_translations t JOIN cms.translation_sources s ON s.entity_type=t.entity_type AND s.entity_id=t.entity_id JOIN cms.storefront_languages l ON l.locale=t.locale WHERE t.entity_type='category' AND t.entity_id=ANY($1) AND t.reviewed AND t.source=s.source ORDER BY t.entity_id,t.locale",
        ).bind(&ids).fetch_all(&self.pool).await?;
        for category in &mut categories {
            for (_, fields) in translations.iter().filter(|t| t.0 == category.id) {
                if let Some(name) = fields.get("name").and_then(Value::as_str) {
                    if !name.is_empty()
                        && name.chars().count() <= 1000
                        && !category.aliases.iter().any(|v| v == name)
                    {
                        category.aliases.push(name.into());
                    }
                }
            }
            category.aliases.truncate(12);
        }
        let mut schema = CatalogSchema {
            industry,
            version,
            attributes,
            categories,
            categories_complete,
        };
        // A pending choice must also be invalidated by product/category changes,
        // not only by a sum of definition versions.
        let catalog_revision: (i64, Option<chrono::DateTime<chrono::Utc>>) =
            sqlx::query_as("SELECT count(*),max(updated_at) FROM catalog.products")
                .fetch_one(&self.pool)
                .await?;
        let provenance_revision: (i64, Option<chrono::DateTime<chrono::Utc>>) =
            sqlx::query_as("SELECT count(*),max(updated_at) FROM attributes.value_provenance")
                .fetch_one(&self.pool)
                .await?;
        let market_revision: (String, i64) = sqlx::query_as(
            "SELECT currency,version FROM cart_checkout.market_configuration WHERE singleton",
        )
        .fetch_one(&self.pool)
        .await?;
        schema.version = infra_auth::digest(
            &serde_json::to_string(&(
                &schema,
                catalog_revision,
                provenance_revision,
                market_revision,
            ))
            .map_err(|_| infra_auth::Error::Internal)?,
        );
        Ok(schema)
    }
}
pub fn eligible(d: &Definition, ai: bool) -> bool {
    d.metadata.active() && d.is_visible_on_front && (!ai || d.metadata.ai_queryable)
}
pub fn validate_filters(
    defs: &[Definition],
    filters: &BTreeMap<String, Value>,
    ai: bool,
) -> Result<()> {
    if filters.len() > 20 || serde_json::to_vec(filters).map_or(true, |v| v.len() > 4000) {
        return Err(bad("Too many attribute filters"));
    }
    for (code, value) in filters {
        let d = defs
            .iter()
            .find(|d| d.attribute_code == *code && eligible(d, ai) && d.is_filterable)
            .ok_or_else(|| bad("Attribute is not available for filtering"))?;
        metadata::filter_value(d, value)?;
    }
    Ok(())
}
pub fn matches_filters(values: &Value, filters: &BTreeMap<String, Value>) -> bool {
    filters.iter().all(|(code, want)| {
        values.get(code).is_some_and(|v| {
            let matches = |wanted: &Value| {
                equal_scalar(v, wanted)
                    || v.as_array()
                        .is_some_and(|vs| vs.iter().any(|value| equal_scalar(value, wanted)))
            };
            want.as_array().map_or_else(
                || matches(want),
                |alternatives| alternatives.iter().any(matches),
            )
        })
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchPredicate {
    pub name: String,
    pub operator: String,
    pub value: Value,
}
pub fn validate_predicates(
    defs: &[Definition],
    predicates: &[SearchPredicate],
    ai: bool,
) -> Result<()> {
    if predicates.len() > 20 || serde_json::to_vec(predicates).map_or(true, |v| v.len() > 4000) {
        return Err(bad("Too many attribute predicates"));
    }
    for predicate in predicates {
        let definition = defs
            .iter()
            .find(|d| d.attribute_code == predicate.name && eligible(d, ai) && d.is_filterable)
            .ok_or_else(|| bad("Attribute is not available for filtering"))?;
        if !["eq", "neq", "lt", "lte", "gt", "gte", "contains"]
            .contains(&predicate.operator.as_str())
            || predicate.value.is_null()
            || predicate.value.is_array()
            || predicate.value.is_object()
            || (["lt", "lte", "gt", "gte"].contains(&predicate.operator.as_str())
                && (!["integer", "decimal", "measurement", "price"]
                    .contains(&metadata::canonical_type(&definition.input_type))
                    || !predicate.value.is_number()))
            || (predicate.operator == "contains"
                && !["select", "multiselect", "text"]
                    .contains(&metadata::canonical_type(&definition.input_type)))
        {
            return Err(bad(
                "Predicate operator is not supported for this attribute",
            ));
        }
        metadata::filter_value(definition, &predicate.value)?;
    }
    Ok(())
}

fn number(value: &Value) -> Option<rust_decimal::Decimal> {
    value
        .is_number()
        .then(|| value.to_string().parse().ok())
        .flatten()
}
fn equal_scalar(actual: &Value, wanted: &Value) -> bool {
    match (number(actual), number(wanted)) {
        (Some(actual), Some(wanted)) => actual == wanted,
        _ => actual == wanted,
    }
}
pub fn matches_predicates(values: &Value, predicates: &[SearchPredicate]) -> bool {
    predicates.iter().all(|predicate| {
        let Some(actual) = values.get(&predicate.name).filter(|value| !value.is_null()) else {
            return false;
        };
        let present = equal_scalar(actual, &predicate.value)
            || actual.as_array().is_some_and(|values| {
                values
                    .iter()
                    .any(|value| equal_scalar(value, &predicate.value))
            });
        match predicate.operator.as_str() {
            "eq" | "contains" => present,
            "neq" => !present,
            "lt" | "lte" | "gt" | "gte" => number(actual)
                .zip(number(&predicate.value))
                .is_some_and(|(actual, wanted)| match predicate.operator.as_str() {
                    "lt" => actual < wanted,
                    "lte" => actual <= wanted,
                    "gt" => actual > wanted,
                    "gte" => actual >= wanted,
                    _ => false,
                }),
            _ => false,
        }
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(deny_unknown_fields)]
pub struct Relationship {
    pub id: uuid::Uuid,
    #[serde(default, skip_serializing_if = "crate::missing_entity_id")]
    pub entity_id: i64,
    pub definition_id: uuid::Uuid,
    pub value_code: String,
    pub target_definition_id: uuid::Uuid,
    pub target_value_code: String,
    pub relation: String,
}
impl Service {
    pub async fn relationships(&self) -> Result<Vec<Relationship>> {
        Ok(
            sqlx::query_as("SELECT * FROM attributes.value_relationships ORDER BY id LIMIT 1000")
                .fetch_all(&self.pool)
                .await?,
        )
    }
    pub async fn save_relationship(&self, r: Relationship) -> Result<Relationship> {
        if ![
            "synonym",
            "parent",
            "child",
            "related",
            "equivalent",
            "broader_than",
            "narrower_than",
        ]
        .contains(&r.relation.as_str())
            || (r.definition_id == r.target_definition_id && r.value_code == r.target_value_code)
        {
            return Err(bad("Invalid attribute relationship"));
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(2002)")
            .execute(&mut *tx)
            .await?;
        let defs = crate::definitions(&mut tx, "product").await?;
        for (id, value) in [
            (r.definition_id, &r.value_code),
            (r.target_definition_id, &r.target_value_code),
        ] {
            let d = defs
                .iter()
                .find(|d| d.id == id && d.metadata.active())
                .ok_or_else(|| bad("Unknown relationship attribute"))?;
            if !d
                .options
                .as_array()
                .is_some_and(|opts| opts.iter().any(|o| o["value"].as_str() == Some(value)))
            {
                return Err(bad("Relationships require managed option codes"));
            }
        }
        let row=sqlx::query_as("INSERT INTO attributes.value_relationships(id,definition_id,value_code,target_definition_id,target_value_code,relation) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET definition_id=$2,value_code=$3,target_definition_id=$4,target_value_code=$5,relation=$6 RETURNING *").bind(r.id).bind(r.definition_id).bind(r.value_code).bind(r.target_definition_id).bind(r.target_value_code).bind(r.relation).fetch_one(&mut *tx).await?;
        tx.commit().await?;
        Ok(row)
    }
}

#[cfg(test)]
mod filter_tests {
    use super::*;
    use serde_json::json;
    fn definition(kind: &str) -> Definition {
        serde_json::from_value(json!({"id":uuid::Uuid::nil(),"entity_type":"product","attribute_code":"color","label":"Color","input_type":kind,"scope":"global","is_required":false,"is_unique":false,"is_searchable":true,"is_filterable":true,"is_comparable":false,"is_visible_on_front":true,"used_for_promo_rules":false,"used_for_configurations":false,"swatch_type":"none","options":[{"value":"red","label":"Red"},{"value":"blue","label":"Blue"}],"version":1})).unwrap()
    }
    #[test]
    fn numeric_and_negative_predicates_use_typed_values_and_require_known_facts() {
        let mut numeric = definition("decimal");
        numeric.options = json!([]);
        let at_least = SearchPredicate {
            name: "color".into(),
            operator: "gte".into(),
            value: json!(128),
        };
        assert!(validate_predicates(
            std::slice::from_ref(&numeric),
            std::slice::from_ref(&at_least),
            false
        )
        .is_ok());
        assert!(matches_predicates(
            &json!({"color":128.0}),
            std::slice::from_ref(&at_least)
        ));
        assert!(!matches_predicates(
            &json!({"color":"256"}),
            std::slice::from_ref(&at_least)
        ));
        assert!(!matches_predicates(
            &json!({}),
            std::slice::from_ref(&at_least)
        ));
        let negative = SearchPredicate {
            name: "color".into(),
            operator: "neq".into(),
            value: json!("red"),
        };
        let categorical = definition("multiselect");
        assert!(validate_predicates(
            std::slice::from_ref(&categorical),
            std::slice::from_ref(&negative),
            false
        )
        .is_ok());
        assert!(
            !matches_predicates(&json!({}), std::slice::from_ref(&negative)),
            "missing does not prove an exclusion"
        );
        assert!(!matches_predicates(
            &json!({"color":["red","blue"]}),
            std::slice::from_ref(&negative)
        ));
        assert!(matches_predicates(
            &json!({"color":["blue"]}),
            std::slice::from_ref(&negative)
        ));
        for invalid in [
            SearchPredicate {
                value: json!("128"),
                ..at_least.clone()
            },
            SearchPredicate {
                operator: "where".into(),
                ..at_least.clone()
            },
            SearchPredicate {
                value: json!([128]),
                ..at_least.clone()
            },
            SearchPredicate {
                name: "unknown".into(),
                ..at_least.clone()
            },
        ] {
            assert!(
                validate_predicates(std::slice::from_ref(&numeric), &[invalid], false).is_err()
            );
        }
        assert!(
            validate_predicates(&[categorical], &[at_least], false).is_err(),
            "ordering cannot compare category labels"
        );
    }
    #[test]
    fn filter_alternatives_validate_each_option_and_preserve_legacy_values() {
        for kind in ["select", "single_select", "multiselect", "multi_select"] {
            let d = definition(kind);
            for value in [json!("red"), json!(["red", "blue"])] {
                assert!(validate_filters(
                    std::slice::from_ref(&d),
                    &BTreeMap::from([("color".into(), value)]),
                    false
                )
                .is_ok());
            }
            for value in [
                json!([]),
                json!(["red", "missing"]),
                json!([["red"]]),
                json!([null]),
                json!([true]),
                json!(vec!["red"; 51]),
            ] {
                assert!(validate_filters(
                    std::slice::from_ref(&d),
                    &BTreeMap::from([("color".into(), value)]),
                    false
                )
                .is_err());
            }
        }
        let d = definition("boolean");
        assert!(metadata::filter_value(&d, &json!([false])).is_ok());
        assert!(metadata::filter_value(&d, &json!(["false"])).is_err());
    }
    #[test]
    fn alternatives_or_within_attributes_and_and_across_attributes() {
        let filters = BTreeMap::from([
            ("color".into(), json!(["red", "blue"])),
            ("organic".into(), json!([false])),
        ]);
        assert!(matches_filters(
            &json!({"color":"blue","organic":false}),
            &filters
        ));
        assert!(matches_filters(
            &json!({"color":["green","red"],"organic":false}),
            &filters
        ));
        assert!(!matches_filters(
            &json!({"color":"green","organic":false}),
            &filters
        ));
        assert!(!matches_filters(
            &json!({"color":"blue","organic":true}),
            &filters
        ));
        assert!(!matches_filters(&json!({"organic":false}), &filters));
    }
}
