//! Read-only shopper projections. All persistence and business rules stay in domain services.
use crate::{
    assistant::App,
    identity::{self, ApiError},
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use domain_search_client::SearchProvider;
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(tag = "name", content = "arguments", deny_unknown_fields)]
pub enum Request {
    #[serde(rename = "get_discount_recommendations")]
    Discounts(EmptyArgs),
    #[serde(rename = "get_bestsellers")]
    Bestsellers(BestsellerArgs),
    #[serde(rename = "get_catalog_schema")]
    Schema(EmptyArgs),
    #[serde(rename = "search_products")]
    Search(SearchArgs),
    #[serde(rename = "get_product")]
    Product(ProductArgs),
    #[serde(rename = "get_product_attributes")]
    Attributes(ProductArgs),
    #[serde(rename = "get_product_price")]
    Price(ProductArgs),
    #[serde(rename = "get_product_inventory")]
    Inventory(ProductArgs),
    #[serde(rename = "compare_products")]
    Compare(CompareArgs),
    #[serde(rename = "get_category")]
    Category(CategoryArgs),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BestsellerArgs {
    pub period: domain_orders::bestsellers::Period,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyArgs {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProductArgs {
    pub product_id: Uuid,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CategoryArgs {
    pub category_id: Uuid,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompareArgs {
    pub product_ids: Vec<Uuid>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SearchArgs {
    pub query: String,
    pub category_id: Option<Uuid>,
    #[serde(default)]
    pub currency: Option<String>,
    pub min_price: Option<String>,
    #[serde(default)]
    pub exclusive_min: bool,
    pub max_price: Option<String>,
    #[serde(default)]
    pub exclusive_max: bool,
    #[serde(default)]
    pub in_stock: bool,
    #[serde(default)]
    pub excluded_product_ids: Vec<Uuid>,
    #[serde(default)]
    pub predicates: Vec<domain_attributes::schema::SearchPredicate>,
    #[serde(default)]
    pub attributes: std::collections::BTreeMap<String, serde_json::Value>,
}
#[derive(Serialize)]
pub struct Attribute {
    pub name: String,
    pub value: String,
    pub label: String,
    pub source: String,
    pub confidence: Option<f64>,
    pub comparable: bool,
}
#[derive(Serialize)]
pub struct Product {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discovery: Option<domain_search_client::discovery::Projection>,
    pub id: Uuid,
    pub image_id: Option<Uuid>,
    pub name: String,
    pub sku: String,
    pub price: String,
    pub currency: String,
    pub category_id: Uuid,
    pub category_ids: Vec<Uuid>,
    pub category_name: String,
    pub category_names: Vec<String>,
    pub product_type: String,
    pub attributes: Vec<Attribute>,
    pub in_stock: Option<bool>,
    pub route: String,
}
#[derive(Serialize)]
pub struct Category {
    pub id: Uuid,
    pub name: String,
    pub parent_id: Option<Uuid>,
}
#[derive(Serialize)]
pub struct ResultBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discovery: Option<domain_search_client::discovery::Report>,
    pub products: Vec<Product>,
    pub category: Option<Category>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog_schema: Option<domain_attributes::schema::CatalogSchema>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog_profile: Option<catalog_profile::Profile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_currency: Option<String>,
}
pub mod catalog_profile;

async fn project_products(
    a: &App,
    ids: &[Uuid],
    delivery: &domain_inventory::areas::Delivery,
    defs: &[domain_attributes::Definition],
    comparison: bool,
) -> Result<Vec<Product>, Error> {
    let pool = &a.identity.customers.pool;
    let current: Vec<domain_catalog::Product> =
        sqlx::query_as("SELECT * FROM catalog.products WHERE id=ANY($1) AND active AND (parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.products parent WHERE parent.id=catalog.products.parent_id AND parent.active))")
            .bind(ids)
            .fetch_all(pool)
            .await?;
    let categories: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT id,name FROM catalog.categories WHERE id=ANY($1)")
            .bind(
                current
                    .iter()
                    .flat_map(|p| {
                        p.category_ids
                            .iter()
                            .copied()
                            .chain(std::iter::once(p.category_id))
                    })
                    .collect::<Vec<_>>(),
            )
            .fetch_all(pool)
            .await?;
    let sources:Vec<(Uuid,Uuid,String,Option<f64>)>=sqlx::query_as("SELECT product_id,definition_id,source,confidence FROM attributes.value_provenance WHERE product_id=ANY($1)").bind(ids).fetch_all(pool).await?;
    let inventory = &a.identity.cart.inventory;
    let stocks = inventory
        .browsing_stocks(delivery.area_id, !delivery.configured)
        .await?;
    // Discovery can expand parent hits into forty variants; inventory reads are
    // bounded to twenty candidates and must retain the same delivery scope.
    let mut availability = std::collections::HashMap::new();
    for batch in ids.chunks(20) {
        availability.extend(
            inventory
                .browsing_available_many(batch, &stocks, delivery.area_id)
                .await?,
        );
    }
    let mut projected = Vec::new();
    for id in ids {
        let Some(p) = current.iter().find(|p| p.id == *id) else {
            continue;
        };
        let in_stock = if !delivery.deliverable && stocks.is_empty() {
            None
        } else {
            Some(availability.get(id).copied().unwrap_or(0) > 0)
        };
        let attributes = defs
            .iter()
            .filter(|d| {
                domain_attributes::schema::eligible(d, true) && (!comparison || d.is_comparable)
            })
            .filter_map(|d| {
                let value = p.attributes.get(&d.attribute_code)?;
                if value.to_string().chars().count() > 250 {
                    return None;
                }
                let provenance = sources.iter().find(|v| v.0 == *id && v.1 == d.id);
                Some(Attribute {
                    name: d.attribute_code.clone(),
                    label: d.label.clone(),
                    value: value.to_string(),
                    source: provenance
                        .map(|v| v.2.clone())
                        .unwrap_or_else(|| "MERCHANT".into()),
                    confidence: provenance.and_then(|v| v.3),
                    comparable: d.is_comparable,
                })
            })
            .take(20)
            .collect();
        projected.push(Product {
            discovery: None,
            id: *id,
            image_id: p.media_ids.first().copied(),
            name: p.name.clone(),
            sku: p.sku.clone(),
            price: p.price.to_string(),
            currency: p.currency.clone(),
            category_id: p.category_id,
            category_ids: p.category_ids.clone(),
            category_name: categories
                .iter()
                .find(|c| c.0 == p.category_id)
                .map(|c| c.1.clone())
                .unwrap_or_default(),
            category_names: categories
                .iter()
                .filter(|c| c.0 == p.category_id || p.category_ids.contains(&c.0))
                .map(|c| c.1.clone())
                .collect(),
            product_type: p.product_type.clone(),
            attributes,
            in_stock,
            route: format!("/products/{id}"),
        });
    }
    Ok(projected)
}

pub async fn execute(
    State(a): State<App>,
    headers: HeaderMap,
    Json(input): Json<Request>,
) -> Result<Response, ApiError> {
    // Bind tracing to the already signed request scope, never a browser header.
    let context = if headers.contains_key("x-commerce-trace-request") {
        identity::bearer(&headers)
            .ok()
            .and_then(|token| a.decode(token, "shopper_read").ok())
            .and_then(|claims| crate::assistant_trace::context(&headers, claims.request_id))
    } else {
        None
    };
    let started = std::time::Instant::now();
    let mut result = execute_inner(State(a), headers, Json(input)).await;
    if let (Some(context), Ok(response)) = (context, &mut result) {
        if let Ok(value) = crate::assistant_trace::reply(&context, started.elapsed()).parse() {
            response
                .headers_mut()
                .insert("x-commerce-trace-response", value);
        }
    }
    result
}

async fn execute_inner(
    State(a): State<App>,
    headers: HeaderMap,
    Json(input): Json<Request>,
) -> Result<Response, ApiError> {
    let _permit = super::assistant::TOOL_SLOTS
        .try_acquire()
        .map_err(|_| Error::RateLimited)?;
    let claims = a.decode(identity::bearer(&headers)?, "shopper_read")?;
    if claims.sub.is_some() {
        a.customer(&claims).await?;
    }
    infra_auth::rate_limit(
        &a.identity.customers.pool,
        &format!(
            "assistant-catalog:{}:{}",
            a.tenant,
            claims
                .sub
                .map(|id| id.to_string())
                .unwrap_or_else(|| "guest".into())
        ),
        120,
    )
    .await?;
    let catalog = domain_catalog::Service {
        pool: a.identity.customers.pool.clone(),
    };
    let delivery = a
        .identity
        .cart
        .inventory
        .delivery(crate::areas::pin(&headers)?)
        .await?;
    let attributes = domain_attributes::Service {
        pool: a.identity.customers.pool.clone(),
    };
    let defs = attributes.list("product").await?;
    let mut discovery = None;
    let mut schema = None;
    let mut catalog_profile = None;
    let mut default_currency = None;
    let mut products = Vec::new();
    let mut category = None;
    match input {
        Request::Discounts(_) => {
            let offers = domain_pricing_promotions::recommendations::rank(
                &a.identity.customers.pool,
                claims.sub,
            )
            .await?;
            let mut rows = Vec::new();
            for batch in offers.chunks(20) {
                let ids: Vec<_> = batch.iter().map(|o| o.product_id).collect();
                let projected = project_products(&a, &ids, &delivery, &defs, false).await?;
                rows.extend(
                    batch
                        .iter()
                        .filter_map(|offer| {
                            projected
                                .iter()
                                .find(|p| {
                                    p.id == offer.product_id
                                        && p.currency == offer.currency
                                        && p.price == offer.original_price.to_string()
                                })
                                .map(|product| serde_json::json!({"product":product,"offer":offer}))
                        })
                        .take(8 - rows.len()),
                );
                if rows.len() == 8 {
                    break;
                }
            }
            return Ok(([("cache-control", "private, no-store")], Json(serde_json::json!({"offers":rows,"candidate_limit":null,"scope":"all_eligible_catalog_products","metric":"catalog_discount_percent","quantity":1}))).into_response());
        }
        Request::Bestsellers(i) => {
            let ranking = domain_orders::bestsellers::rank_for_area(
                &a.identity.customers.pool,
                i.period,
                chrono::Utc::now(),
                delivery.area_id,
            )
            .await?;
            let ids: Vec<_> = ranking.products.iter().map(|row| row.product_id).collect();
            let projected = project_products(&a, &ids, &delivery, &defs, false).await?;
            let products: Vec<_> = projected.into_iter().take(8).collect();
            return Ok(([("cache-control", "private, no-store")], Json(serde_json::json!({
                "products": products, "period": i.period, "start": ranking.start, "end": ranking.end,
                "timezone": "UTC", "metric": "completed_order_units", "ranked_limit": 50,
                "scope": ranking.scope
            }))).into_response());
        }
        Request::Schema(_) => {
            schema = Some(attributes.catalog_schema(true).await?);
            let mut tx = a.identity.customers.pool.begin().await?;
            default_currency = Some(
                domain_cart_checkout::market::configuration(&mut tx)
                    .await?
                    .currency,
            );
        }
        Request::Product(i)
        | Request::Attributes(i)
        | Request::Price(i)
        | Request::Inventory(i) => {
            products = project_products(&a, &[i.product_id], &delivery, &defs, false).await?;
            if products.is_empty() {
                return Err(Error::NotFound.into());
            }
        }
        Request::Compare(i) => {
            if !(2..=5).contains(&i.product_ids.len())
                || i.product_ids
                    .iter()
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    != i.product_ids.len()
            {
                return Err(Error::Invalid("Compare two to five distinct products".into()).into());
            }
            products = project_products(&a, &i.product_ids, &delivery, &defs, true).await?;
            if products.len() != i.product_ids.len() {
                return Err(Error::NotFound.into());
            }
        }
        Request::Category(i) => {
            let c = catalog.category(i.category_id).await?;
            category = Some(Category {
                id: c.id,
                name: c.name,
                parent_id: c.parent_id,
            });
        }
        Request::Search(i) => {
            catalog_profile = catalog_profile::scoped_profile(&a, &i, &delivery, &defs).await?;
            let search =
                domain_search_client::Client::serving_environment().map_err(|_| Error::Internal)?;
            (products, discovery) = search_with_profile(
                &a,
                i,
                &delivery,
                &search,
                &domain_search_client::discovery::DeterministicRanker,
                catalog_profile
                    .as_ref()
                    .map(|profile| profile.eligible_product_ids.as_slice()),
            )
            .await?;
        }
    }
    let result = ResultBody {
        discovery,
        products,
        category,
        catalog_schema: schema,
        catalog_profile,
        default_currency,
    };
    if serde_json::to_vec(&result)
        .map_err(|_| Error::Internal)?
        .len()
        > 131072
    {
        return Err(Error::Internal.into());
    }
    // Validate authorization and current catalog/stock on every request before
    // acknowledging a cached public projection. No stale-while-revalidate path.
    let serialized = serde_json::to_string(&result).map_err(|_| Error::Internal)?;
    let revision = format!("\"{}\"", infra_auth::digest(&serialized));
    if headers.get("if-none-match").and_then(|v| v.to_str().ok()) == Some(revision.as_str()) {
        return Ok((
            StatusCode::NOT_MODIFIED,
            [
                ("etag", revision),
                ("cache-control", "private, no-cache".into()),
            ],
        )
            .into_response());
    }
    Ok((
        [
            ("etag", revision),
            ("cache-control", "private, no-cache".into()),
        ],
        Json(result),
    )
        .into_response())
}

/// Bounded search orchestration over an existing provider, with domain revalidation.
pub async fn search_products(
    a: &App,
    i: SearchArgs,
    delivery: &domain_inventory::areas::Delivery,
    search: &impl SearchProvider,
) -> Result<Vec<Product>, Error> {
    Ok(search_with_ranker(
        a,
        i,
        delivery,
        search,
        &domain_search_client::discovery::DeterministicRanker,
    )
    .await?
    .0)
}

pub async fn search_with_ranker(
    a: &App,
    i: SearchArgs,
    delivery: &domain_inventory::areas::Delivery,
    search: &impl SearchProvider,
    ranker: &impl domain_search_client::discovery::Reranker,
) -> Result<
    (
        Vec<Product>,
        Option<domain_search_client::discovery::Report>,
    ),
    Error,
> {
    search_with_profile(a, i, delivery, search, ranker, None).await
}

async fn search_with_profile(
    a: &App,
    mut i: SearchArgs,
    delivery: &domain_inventory::areas::Delivery,
    search: &impl SearchProvider,
    ranker: &impl domain_search_client::discovery::Reranker,
    profile_ids: Option<&[Uuid]>,
) -> Result<
    (
        Vec<Product>,
        Option<domain_search_client::discovery::Report>,
    ),
    Error,
> {
    use domain_search_client::discovery as d;
    let pool = &a.identity.customers.pool;
    let enabled = d::enabled(pool).await?;
    let query = d::normalize(&i.query);
    let mut products = Vec::new();
    infra_auth::bounded(&i.query, "query", 200, true)?;
    let parse = |v: &Option<String>| -> Result<Option<sqlx::types::Decimal>, Error> {
        v.as_ref()
            .map(|s| {
                s.parse::<sqlx::types::Decimal>()
                    .ok()
                    .filter(|d| *d >= sqlx::types::Decimal::ZERO)
                    .ok_or_else(|| Error::Invalid("Invalid price constraint".into()))
            })
            .transpose()
    };
    let min = parse(&i.min_price)?;
    let max = parse(&i.max_price)?;
    if (i.exclusive_min && min.is_none())
        || (i.exclusive_max && max.is_none())
        || i.excluded_product_ids.len() > 20
        || i.currency.as_ref().is_some_and(|currency| {
            currency.len() != 3 || !currency.bytes().all(|letter| letter.is_ascii_uppercase())
        })
        || min
            .zip(max)
            .is_some_and(|(lo, hi)| lo > hi || (lo == hi && (i.exclusive_min || i.exclusive_max)))
    {
        return Err(Error::Invalid("Invalid price range".into()));
    }
    let mut defs = domain_attributes::Service {
        pool: a.identity.customers.pool.clone(),
    }
    .list("product")
    .await?;
    domain_attributes::schema::validate_filters(&defs, &i.attributes, true)?;
    domain_attributes::schema::validate_predicates(&defs, &i.predicates, true)?;
    // Keep hard-match evidence visible inside the bounded product projection,
    // rather than filling all twenty slots with unrelated optional attributes.
    defs.sort_by_key(|d| {
        !i.attributes.contains_key(&d.attribute_code)
            && !i.predicates.iter().any(|p| p.name == d.attribute_code)
    });
    // Full merchant names and SKUs resolve from the catalog, independent of search ranking.
    // Keep duplicate names visible so the caller can request disambiguation.
    if i.category_id.is_none()
        && min.is_none()
        && max.is_none()
        && i.attributes.is_empty()
        && i.predicates.is_empty()
        && i.currency.is_none()
        && !i.in_stock
        && i.excluded_product_ids.is_empty()
    {
        let exact: Vec<Uuid> = sqlx::query_scalar("SELECT p.id FROM catalog.products p WHERE p.active AND p.product_type='simple' AND (p.parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.products parent WHERE parent.id=p.parent_id AND parent.active)) AND (lower(btrim(p.sku))=lower(btrim($1)) OR lower(regexp_replace(btrim(p.name), '\\s+', ' ', 'g'))=lower(regexp_replace(btrim($1), '\\s+', ' ', 'g'))) ORDER BY p.id LIMIT 5")
            .bind(&i.query).fetch_all(pool).await?;
        if !exact.is_empty() {
            return Ok((
                project_products(a, &exact, delivery, &defs, false).await?,
                None,
            ));
        }
    }
    // A unique merchant category name/slug is a category browse, not a product-name query.
    // Exact product names/SKUs above retain precedence; ambiguous categories stay lexical.
    if i.category_id.is_none() && i.query != "*" {
        let categories: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM catalog.categories WHERE lower(btrim(name))=lower(btrim($1)) OR lower(slug)=lower(btrim($1)) ORDER BY id LIMIT 2",
        ).bind(&i.query).fetch_all(pool).await?;
        if categories.len() == 1 {
            i.category_id = Some(categories[0]);
            i.query = "*".into();
        }
    }
    let include_relations = enabled && i.query != "*";
    let attribute_filters = serde_json::to_string(&i.attributes).map_err(|_| Error::Internal)?;
    let found = search
        .search(domain_search_client::Search {
            q: Some(if i.query == "*" {
                String::new()
            } else if enabled {
                query.clone()
            } else {
                i.query
            }),
            attribute_filters: Some(attribute_filters),
            category_id: i.category_id,
            min_price: i.min_price,
            exclusive_min: i.exclusive_min,
            max_price: i.max_price,
            ..Default::default()
        })
        .await?;
    // Resolve configurable listings to current simple SKUs. Aggregate variant attributes
    // never prove that a single sellable combination exists. Bound the entire expansion.
    let lexical_ids: Vec<Uuid> = found.hits.into_iter().take(20).map(|p| p.id).collect();
    let relation_ids = if include_relations {
        d::relation_candidates(pool, &query).await?
    } else {
        vec![]
    };
    // A category profile has already validated full-scope simple SKU facts;
    // seed those eligible IDs before stale provider hits. Still revalidate
    // every selected SKU below and retain the same bounded ranker boundary.
    let hit_ids: Vec<Uuid> = profile_ids
        .unwrap_or_default()
        .iter()
        .chain(lexical_ids.iter())
        .chain(relation_ids.iter())
        .copied()
        .collect();
    let cap = if enabled { d::CANDIDATE_LIMIT } else { 20 };
    let mut ids: Vec<Uuid> = sqlx::query_scalar("SELECT chosen.id FROM unnest($1::uuid[]) WITH ORDINALITY h(id,rank) JOIN catalog.products p ON p.id=h.id AND p.active CROSS JOIN LATERAL (SELECT p.id,0 AS position WHERE p.product_type='simple' UNION ALL (SELECT c.id,l.position FROM catalog.product_links l JOIN catalog.products c ON c.id=l.child_id AND c.active AND c.product_type='simple' WHERE p.product_type='configurable' AND l.parent_id=p.id ORDER BY l.position,c.id LIMIT 20)) chosen ORDER BY h.rank,chosen.position,chosen.id LIMIT $2").bind(hit_ids).bind(cap as i64).fetch_all(&a.identity.customers.pool).await?;
    let mut seen = std::collections::HashSet::new();
    ids.retain(|id| seen.insert(*id));
    ids.truncate(cap);
    let evaluated = ids.len();
    let raw: Vec<domain_catalog::Product> = {
        sqlx::query_as("SELECT * FROM catalog.products WHERE id=ANY($1) AND active AND (parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.products parent WHERE parent.id=catalog.products.parent_id AND parent.active))")
            .bind(&ids)
            .fetch_all(pool)
            .await?
    };
    let provenance: Vec<(Uuid,Uuid,String)> = sqlx::query_as("SELECT product_id,definition_id,source FROM attributes.value_provenance WHERE product_id=ANY($1)")
        .bind(&ids).fetch_all(pool).await?;
    let categories: Vec<Uuid> = if i.category_id.is_some() {
        if let Some(category) = i.category_id {
            sqlx::query_scalar("WITH RECURSIVE tree AS (SELECT id FROM catalog.categories WHERE id=$1 UNION SELECT c.id FROM catalog.categories c JOIN tree t ON c.parent_id=t.id) SELECT id FROM tree").bind(category).fetch_all(pool).await?
        } else {
            vec![]
        }
    } else {
        vec![]
    };
    for p in project_products(a, &ids, delivery, &defs, false).await? {
        if i.currency
            .as_ref()
            .is_some_and(|currency| *currency != p.currency)
        {
            continue;
        }
        if i.excluded_product_ids.contains(&p.id) || (i.in_stock && p.in_stock != Some(true)) {
            continue;
        }
        if i.category_id.is_some()
            && !raw.iter().find(|r| r.id == p.id).is_some_and(|r| {
                categories.contains(&r.category_id)
                    || r.category_ids.iter().any(|id| categories.contains(id))
            })
        {
            continue;
        }
        let price = p
            .price
            .parse::<sqlx::types::Decimal>()
            .map_err(|_| Error::Internal)?;
        if min.is_some_and(|v| price < v || (i.exclusive_min && price == v))
            || max.is_some_and(|v| price > v || (i.exclusive_max && price == v))
        {
            continue;
        }
        let matches = i.attributes.iter().all(|(code, want)| {
            let Some(definition) = defs.iter().find(|d| d.attribute_code == *code) else {
                return false;
            };
            catalog_profile::authoritative(p.id, definition.id, &provenance)
                && raw.iter().find(|r| r.id == p.id).is_some_and(|r| {
                    domain_attributes::schema::matches_filters(
                        &r.attributes,
                        &std::collections::BTreeMap::from([(code.clone(), want.clone())]),
                    )
                })
        });
        let predicates_match = i.predicates.iter().all(|predicate| {
            let Some(definition) = defs.iter().find(|d| d.attribute_code == predicate.name) else {
                return false;
            };
            catalog_profile::authoritative(p.id, definition.id, &provenance)
                && raw.iter().find(|row| row.id == p.id).is_some_and(|row| {
                    domain_attributes::schema::matches_predicates(
                        &row.attributes,
                        std::slice::from_ref(predicate),
                    )
                })
        });
        if !matches || !predicates_match {
            continue;
        }
        products.push(p);
        if !enabled && products.len() == 8 {
            break;
        }
    }
    if !enabled {
        return Ok((products, None));
    }
    let rules:Vec<(Uuid,i32,bool)>=sqlx::query_as("SELECT product_id,boost,sponsored FROM catalog.discovery_merchandising WHERE product_id=ANY($1) AND expires_at>now()")
        .bind(&ids).fetch_all(pool).await?;
    let inputs: Vec<_> = products
        .iter()
        .map(|p| {
            let parent = raw.iter().find(|r| r.id == p.id).and_then(|r| r.parent_id);
            let rule = rules.iter().find(|r| r.0 == p.id);
            d::RankInput {
                id: p.id,
                family: parent.unwrap_or(p.id),
                lexical_position: lexical_ids
                    .iter()
                    .position(|id| *id == p.id || Some(*id) == parent),
                reviewed_relation: relation_ids.contains(&p.id)
                    || parent.is_some_and(|id| relation_ids.contains(&id)),
                in_stock: p.in_stock,
                boost: rule.map(|r| r.1).unwrap_or(0),
                sponsored: rule.is_some_and(|r| r.2),
            }
        })
        .collect();
    let ranked = d::checked_rank(&inputs, ranker)?;
    let relationships = d::edges(pool, &ids).await?;
    let eligible = products.len();
    let mut output = Vec::new();
    let now = chrono::Utc::now();
    for (position, r) in ranked.into_iter().take(8).enumerate() {
        let index = products
            .iter()
            .position(|p| p.id == r.id)
            .ok_or(Error::Internal)?;
        let mut p = products.remove(index);
        let record = raw.iter().find(|v| v.id == p.id).ok_or(Error::Internal)?;
        let input = inputs
            .iter()
            .find(|v| v.id == p.id)
            .ok_or(Error::Internal)?;
        p.discovery = Some(d::Projection {
            schema_version: d::VERSION.into(),
            rank: position + 1,
            score: r.score,
            contributions: r.contributions,
            sponsored: input.sponsored,
            merchant_boost: input.boost,
            offer: d::Offer {
                product_id: p.id,
                parent_id: record.parent_id,
                category_id: p.category_id,
                price: p.price.clone(),
                currency: p.currency.clone(),
                selling_unit: record.unit.clone(),
                in_stock: p.in_stock,
                observed_at: now,
                expires_at: now + chrono::Duration::seconds(30),
            },
            relationships: relationships
                .iter()
                .filter(|e| e.product_id == p.id)
                .take(10)
                .cloned()
                .collect(),
        });
        output.push(p);
    }
    // Observability is bounded and stores no customer query or profile. Failure to
    // record a diagnostic cannot change eligibility or the served ranking.
    for p in &output {
        if let Some(rank) = &p.discovery {
            if let Err(error)=sqlx::query("INSERT INTO catalog.discovery_rank_observations(product_id,ranker,rank,score,contributions,sponsored,merchant_boost) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(product_id) DO UPDATE SET ranker=$2,rank=$3,score=$4,contributions=$5,sponsored=$6,merchant_boost=$7,observed_at=now()")
                .bind(p.id).bind(ranker.version()).bind(rank.rank as i32).bind(rank.score).bind(serde_json::json!(rank.contributions)).bind(rank.sponsored).bind(rank.merchant_boost).execute(pool).await {
                tracing::warn!(error=%error,"discovery ranking diagnostic was not recorded");
            }
        }
    }
    let report = d::Report {
        schema_version: d::VERSION.into(),
        retrieval: if profile_ids.is_some() {
            "retrieval://scoped-catalog-lexical-reviewed-relations@1.0.0"
        } else {
            "retrieval://lexical-reviewed-relations@1.0.0"
        }
        .into(),
        ranker: ranker.version().into(),
        lexical_candidates: lexical_ids.len(),
        relation_candidates: relation_ids.len(),
        evaluated,
        eligible,
        returned: output.len(),
        exhaustive: false,
        semantic_enabled: false,
        outcome: if evaluated == 0 {
            "bounded_no_candidates"
        } else if eligible == 0 {
            "current_facts_filtered"
        } else if !delivery.deliverable {
            "availability_unknown"
        } else {
            "matches"
        }
        .into(),
    };
    Ok((output, Some(report)))
}
