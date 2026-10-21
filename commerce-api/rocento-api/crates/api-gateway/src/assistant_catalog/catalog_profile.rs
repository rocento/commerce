//! Scoped facts for clarification, independent of the eight display cards and
//! search-index parent aggregates. Lexical-only requests deliberately have no
//! profile: provider facets cannot prove current sellable-SKU eligibility.
use super::{App, SearchArgs};
use domain_attributes::Definition;
use infra_auth::Error;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use uuid::Uuid;

const ROW_LIMIT: usize = 1000;
const FACET_LIMIT: usize = 30;
const VALUE_LIMIT: usize = 24;

#[derive(Debug, Serialize)]
pub struct Profile {
    #[serde(skip)]
    pub eligible_product_ids: Vec<Uuid>,
    pub revision: String,
    pub scope: String,
    pub complete: bool,
    pub candidate_count: usize,
    pub matched_count: usize,
    pub facets: Vec<Facet>,
    pub facets_complete: bool,
    pub prices: Vec<PriceRange>,
}
#[derive(Debug, Serialize)]
pub struct Facet {
    pub code: String,
    pub label: String,
    pub data_type: String,
    pub unit: Option<String>,
    pub covered_count: usize,
    pub values: Vec<FacetValue>,
    pub values_complete: bool,
}
#[derive(Debug, Serialize)]
pub struct FacetValue {
    pub value: Value,
    pub label: String,
    pub count: usize,
}
#[derive(Debug, Serialize)]
pub struct PriceRange {
    pub currency: String,
    pub min: String,
    pub max: String,
    pub count: usize,
}

/// Only a typed category/browse scope can claim full eligibility. No filtering
/// is dropped to widen choices. Missing/inferred facts never become hard matches.
pub async fn scoped_profile(
    a: &App,
    request: &SearchArgs,
    delivery: &domain_inventory::areas::Delivery,
    defs: &[Definition],
) -> Result<Option<Profile>, Error> {
    infra_auth::bounded(&request.query, "query", 200, true)?;
    domain_attributes::schema::validate_filters(defs, &request.attributes, true)?;
    domain_attributes::schema::validate_predicates(defs, &request.predicates, true)?;
    let parse = |raw: &Option<String>| -> Result<Option<sqlx::types::Decimal>, Error> {
        raw.as_ref()
            .map(|raw| {
                raw.parse::<sqlx::types::Decimal>()
                    .ok()
                    .filter(|value| *value >= sqlx::types::Decimal::ZERO)
                    .ok_or_else(|| Error::Invalid("Invalid price constraint".into()))
            })
            .transpose()
    };
    let min = parse(&request.min_price)?;
    let max = parse(&request.max_price)?;
    if request.excluded_product_ids.len() > 20
        || request.currency.as_ref().is_some_and(|currency| {
            currency.len() != 3 || !currency.bytes().all(|letter| letter.is_ascii_uppercase())
        })
        || (request.exclusive_min && min.is_none())
        || (request.exclusive_max && max.is_none())
        || min.zip(max).is_some_and(|(lo, hi)| {
            lo > hi || (lo == hi && (request.exclusive_min || request.exclusive_max))
        })
    {
        return Err(Error::Invalid("Invalid search constraints".into()));
    }
    let pool = &a.identity.customers.pool;
    let mut category = request.category_id;
    if request.query != "*" {
        // A category plus residual product text is still lexical, so do not
        // broaden its profile to unrelated products in that category.
        if category.is_some() {
            return Ok(None);
        }
        let categories: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM catalog.categories WHERE lower(btrim(name))=lower(btrim($1)) OR lower(slug)=lower(btrim($1)) ORDER BY id LIMIT 2",
        ).bind(&request.query).fetch_all(pool).await?;
        if categories.len() != 1 {
            return Ok(None);
        }
        // Exact names/SKUs take precedence over category aliases, as in search.
        let exact: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM catalog.products p WHERE p.active AND p.product_type='simple' AND (lower(btrim(p.sku))=lower(btrim($1)) OR lower(regexp_replace(btrim(p.name), '\\s+', ' ', 'g'))=lower(regexp_replace(btrim($1), '\\s+', ' ', 'g'))))",
        ).bind(&request.query).fetch_one(pool).await?;
        if exact {
            return Ok(None);
        }
        category = Some(categories[0]);
    }
    let categories: Vec<Uuid> = if let Some(id) = category {
        sqlx::query_scalar("WITH RECURSIVE tree AS (SELECT id FROM catalog.categories WHERE id=$1 UNION SELECT c.id FROM catalog.categories c JOIN tree t ON c.parent_id=t.id) SELECT id FROM tree")
            .bind(id).fetch_all(pool).await?
    } else {
        vec![]
    };
    // Limit+1 makes truncation explicit. Parents are never an eligible SKU and
    // two sibling variants never combine their facts into one sellable offer.
    let mut rows: Vec<domain_catalog::Product> = sqlx::query_as(
        "SELECT p.* FROM catalog.products p WHERE p.active AND p.product_type='simple' AND (p.parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.products parent WHERE parent.id=p.parent_id AND parent.active)) AND ($1::uuid IS NULL OR p.category_id=ANY($2) OR p.category_ids && $2) AND ($3::numeric IS NULL OR p.price>$3 OR (p.price=$3 AND NOT $4)) AND ($5::numeric IS NULL OR p.price<$5 OR (p.price=$5 AND NOT $6)) AND NOT p.id=ANY($7) AND ($9::text IS NULL OR p.currency=$9) ORDER BY p.id LIMIT $8",
    ).bind(category).bind(&categories).bind(min).bind(request.exclusive_min)
        .bind(max).bind(request.exclusive_max).bind(&request.excluded_product_ids)
        .bind((ROW_LIMIT + 1) as i64).bind(&request.currency).fetch_all(pool).await?;
    let complete = rows.len() <= ROW_LIMIT;
    rows.truncate(ROW_LIMIT);
    let candidate_count = rows.len();
    let ids: Vec<_> = rows.iter().map(|p| p.id).collect();
    let provenance: Vec<(Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT product_id,definition_id,source FROM attributes.value_provenance WHERE product_id=ANY($1) ORDER BY product_id,definition_id",
    ).bind(&ids).fetch_all(pool).await?;
    let unverified: HashSet<_> = provenance
        .iter()
        .filter(|(_, _, source)| ["AI_INFERRED", "DERIVED"].contains(&source.as_str()))
        .map(|(product, definition, _)| (*product, *definition))
        .collect();
    let mut stocks: HashMap<Uuid, i64> = HashMap::new();
    if request.in_stock {
        let inventory = &a.identity.cart.inventory;
        let scoped_stocks = inventory
            .browsing_stocks(delivery.area_id, !delivery.configured)
            .await?;
        for batch in ids.chunks(20) {
            stocks.extend(
                inventory
                    .browsing_available_many(batch, &scoped_stocks, delivery.area_id)
                    .await?,
            );
        }
        rows.retain(|p| stocks.get(&p.id).copied().unwrap_or_default() > 0);
    }
    rows.retain(|p| {
        request.attributes.iter().all(|(code, value)| {
            let Some(definition) = defs.iter().find(|d| d.attribute_code == *code) else {
                return false;
            };
            !unverified.contains(&(p.id, definition.id))
                && domain_attributes::schema::matches_filters(
                    &p.attributes,
                    &BTreeMap::from([(code.clone(), value.clone())]),
                )
        }) && request.predicates.iter().all(|predicate| {
            let Some(definition) = defs.iter().find(|d| d.attribute_code == predicate.name) else {
                return false;
            };
            !unverified.contains(&(p.id, definition.id))
                && domain_attributes::schema::matches_predicates(
                    &p.attributes,
                    std::slice::from_ref(predicate),
                )
        })
    });
    let mut profile = project(&rows, defs, &unverified, candidate_count, complete);
    profile.scope = if category.is_some() {
        "current_sellable_category"
    } else {
        "current_sellable_catalog"
    }
    .into();
    profile.revision = domain_attributes::Service { pool: pool.clone() }
        .catalog_schema(true)
        .await?
        .version;
    Ok(Some(profile))
}

pub(super) fn authoritative(
    product: Uuid,
    definition: Uuid,
    provenance: &[(Uuid, Uuid, String)],
) -> bool {
    !provenance.iter().any(|(p, d, source)| {
        *p == product && *d == definition && ["AI_INFERRED", "DERIVED"].contains(&source.as_str())
    })
}

fn project(
    rows: &[domain_catalog::Product],
    defs: &[Definition],
    unverified: &HashSet<(Uuid, Uuid)>,
    candidate_count: usize,
    complete: bool,
) -> Profile {
    let mut facets = Vec::new();
    for definition in defs
        .iter()
        .filter(|d| domain_attributes::schema::eligible(d, true) && d.is_filterable)
    {
        let mut covered_count = 0;
        let mut values: BTreeMap<String, (Value, usize)> = BTreeMap::new();
        for product in rows {
            if unverified.contains(&(product.id, definition.id)) {
                continue;
            }
            let Some(value) = product.attributes.get(&definition.attribute_code) else {
                continue;
            };
            if domain_attributes::metadata::filter_value(definition, value).is_err() {
                continue;
            }
            let scalars = value
                .as_array()
                .map_or_else(|| vec![value], |vs| vs.iter().collect());
            let mut seen = HashSet::new();
            for scalar in scalars {
                if scalar.is_array()
                    || scalar.is_object()
                    || scalar.is_null()
                    || scalar.to_string().chars().count() > 120
                {
                    continue;
                }
                // Numeric equality uses exact Decimal semantics throughout the
                // hard predicate path. Equivalent JSON spellings are one choice.
                let key = if scalar.is_number() {
                    match scalar.to_string().parse::<sqlx::types::Decimal>() {
                        Ok(number) => format!("number:{}", number.normalize()),
                        Err(_) => continue,
                    }
                } else {
                    scalar.to_string()
                };
                if seen.insert(key.clone()) {
                    let entry = values.entry(key).or_insert_with(|| (scalar.clone(), 0));
                    entry.1 += 1;
                }
            }
            if !seen.is_empty() {
                covered_count += 1;
            }
        }
        if values.is_empty() {
            continue;
        }
        let values_complete = values.len() <= VALUE_LIMIT;
        let mut values: Vec<_> = values
            .into_values()
            .map(|(value, count)| {
                let label = definition
                    .options
                    .as_array()
                    .and_then(|options| options.iter().find(|option| option["value"] == value))
                    .and_then(|option| option["label"].as_str())
                    .map(String::from)
                    .unwrap_or_else(|| {
                        value
                            .as_str()
                            .map(String::from)
                            .unwrap_or_else(|| value.to_string())
                    });
                FacetValue {
                    value,
                    label: label.chars().take(120).collect(),
                    count,
                }
            })
            .collect();
        values.sort_by(|a, b| {
            b.count
                .cmp(&a.count)
                .then_with(|| a.value.to_string().cmp(&b.value.to_string()))
        });
        values.truncate(VALUE_LIMIT);
        facets.push(Facet {
            code: definition.attribute_code.clone(),
            label: definition.label.clone(),
            data_type: domain_attributes::metadata::canonical_type(&definition.input_type).into(),
            unit: definition.metadata.unit.clone(),
            covered_count,
            values,
            values_complete,
        });
    }
    let facets_complete = facets.len() <= FACET_LIMIT;
    facets.truncate(FACET_LIMIT);
    let mut ranges: BTreeMap<String, (sqlx::types::Decimal, sqlx::types::Decimal, usize)> =
        BTreeMap::new();
    for product in rows {
        let range =
            ranges
                .entry(product.currency.clone())
                .or_insert((product.price, product.price, 0));
        range.0 = range.0.min(product.price);
        range.1 = range.1.max(product.price);
        range.2 += 1;
    }
    let prices = ranges
        .into_iter()
        .take(20)
        .map(|(currency, (min, max, count))| PriceRange {
            currency,
            min: min.to_string(),
            max: max.to_string(),
            count,
        })
        .collect();
    Profile {
        eligible_product_ids: rows.iter().map(|p| p.id).take(40).collect(),
        revision: String::new(),
        scope: String::new(),
        complete,
        candidate_count,
        matched_count: rows.len(),
        facets,
        facets_complete,
        prices,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn definition(code: &str, kind: &str) -> Definition {
        serde_json::from_value(json!({"id":Uuid::new_v4(),"entity_type":"product","attribute_code":code,"label":code,
            "input_type":kind,"scope":"global","is_required":false,"is_unique":false,"is_searchable":true,
            "is_filterable":true,"is_comparable":true,"is_visible_on_front":true,"used_for_promo_rules":false,
            "used_for_configurations":false,"swatch_type":"none","options":[],"version":1,"metadata":{"ai_queryable":true}})).unwrap()
    }
    fn row(index: u128, attributes: Value) -> domain_catalog::Product {
        serde_json::from_value(json!({"id":Uuid::from_u128(index),"sku":format!("p-{index}"),"slug":format!("p-{index}"),
            "name":"Product","description":"","price":"100.25","currency":"USD","unit":"each",
            "category_id":Uuid::nil(),"attributes":attributes,"media_ids":[],"active":true,"in_stock":true,
            "updated_at":"2026-10-07T00:00:00Z"})).unwrap()
    }

    #[test]
    fn typed_numeric_choices_and_missing_coverage_are_current_sku_counts() {
        let numeric = definition("capacity", "integer");
        let mut color = definition("color", "multiselect");
        color.options = json!([{"value":"red","label":"Red"},{"value":"blue","label":"Blue"}]);
        let rows = vec![
            row(1, json!({"capacity":128,"color":["red","blue"]})),
            row(2, json!({"capacity":256,"color":["blue"]})),
            row(3, json!({})),
        ];
        let unverified = HashSet::from([(rows[1].id, numeric.id)]);
        let profile = project(&rows, &[numeric, color], &unverified, 3, true);
        let capacity = profile
            .facets
            .iter()
            .find(|f| f.code == "capacity")
            .unwrap();
        assert_eq!(capacity.covered_count, 1);
        assert_eq!(capacity.values[0].value, json!(128));
        let color = profile.facets.iter().find(|f| f.code == "color").unwrap();
        assert_eq!(color.covered_count, 2);
        assert_eq!(
            color.values.iter().map(|v| v.count).sum::<usize>(),
            3,
            "multiselect counts overlap rather than being a probability partition"
        );
        assert_eq!(profile.matched_count, 3);
        assert_eq!(profile.prices[0].count, 3);
    }

    #[test]
    fn limits_never_claim_complete_values_or_candidate_scope() {
        let rows: Vec<_> = (1..=25)
            .map(|index| row(index, json!({"identifier":format!("value-{index}")})))
            .collect();
        let profile = project(
            &rows,
            &[definition("identifier", "text")],
            &HashSet::new(),
            25,
            false,
        );
        assert!(!profile.complete);
        assert!(!profile.facets[0].values_complete);
        assert_eq!(profile.facets[0].values.len(), VALUE_LIMIT);
        assert_eq!(profile.facets[0].covered_count, 25);
    }

    #[test]
    fn equivalent_decimal_facts_are_one_clarification_choice() {
        let rows = vec![
            row(1, json!({"weight":200})),
            row(2, json!({"weight":200.0})),
            row(3, json!({"weight":200.5})),
        ];
        let profile = project(
            &rows,
            &[definition("weight", "decimal")],
            &HashSet::new(),
            3,
            true,
        );
        let facet = &profile.facets[0];
        assert_eq!(facet.covered_count, 3);
        assert_eq!(facet.values.len(), 2);
        assert_eq!(facet.values[0].count, 2);
    }
}
