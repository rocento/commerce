//! Replaceable Meilisearch adapter and durable, sequential catalog event consumer.
mod category_counts;
use domain_catalog::{CatalogReader, Product, Service};
use futures_util::StreamExt;
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use uuid::Uuid;
mod localized;
// Version 3 adds stored numeric identities to every indexed product document.
const SEARCH_INDEX_SCHEMA_VERSION: i32 = 3;
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    url: String,
    key: String,
    remote: bool,
    sort_schema: std::sync::Arc<tokio::sync::Mutex<Option<Vec<String>>>>,
}
#[derive(Default, Serialize, Deserialize)]
pub struct Search {
    #[serde(skip)]
    pub stock_ids: Option<Vec<Uuid>>,
    pub attribute_filters: Option<String>,
    pub q: Option<String>,
    pub category_id: Option<Uuid>,
    /// Comma-separated category UUIDs; alternatives within this filter are ORed.
    pub category_ids: Option<String>,
    pub min_price: Option<String>,
    #[serde(default)]
    pub exclusive_min: bool,
    pub max_price: Option<String>,
    pub in_stock: Option<bool>,
    pub offset: Option<u32>,
    pub sort_by: Option<String>,
    pub sort_order: Option<String>,
}
#[derive(Serialize, Deserialize)]
pub struct Results {
    pub hits: Vec<Product>,
    pub total: u64,
    pub offset: u32,
    pub limit: u32,
    #[serde(default)]
    pub facets: std::collections::BTreeMap<String, std::collections::BTreeMap<String, u64>>,
}
/// Search capability boundary; provider-specific filtering stays inside the adapter.
pub trait SearchProvider: Send + Sync {
    fn search(&self, input: Search) -> impl std::future::Future<Output = Result<Results>> + Send;
}
impl SearchProvider for Client {
    async fn search(&self, input: Search) -> Result<Results> {
        if self.remote {
            let stock_ids = input.stock_ids.clone();
            let response = self
                .http
                .post(format!("{}/internal/search", self.url))
                .bearer_auth(&self.key)
                .json(&json!({"input": input, "stock_ids": stock_ids}))
                .send()
                .await
                .map_err(failure)?;
            if response.status() == reqwest::StatusCode::BAD_REQUEST {
                return Err(domain_catalog::invalid("Invalid search request"));
            }
            response
                .error_for_status()
                .map_err(failure)?
                .json()
                .await
                .map_err(failure)
        } else {
            self.query(input).await
        }
    }
}
fn failure(e: impl std::fmt::Display) -> Error {
    tracing::error!(error=%e,"search provider failed");
    Error::Internal
}
fn parse_facets(
    result: &Value,
) -> std::collections::BTreeMap<String, std::collections::BTreeMap<String, u64>> {
    let mut facets: std::collections::BTreeMap<String, std::collections::BTreeMap<String, u64>> =
        Default::default();
    if let Some(tokens) = result["facetDistribution"]["facet_tokens"].as_object() {
        for (token, count) in tokens {
            if let Some((code, value)) = token.split_once('=') {
                if let Some(count) = count.as_u64() {
                    facets.entry(code.into()).or_default().insert(
                        serde_json::from_str::<String>(value).unwrap_or_else(|_| value.into()),
                        count,
                    );
                }
            }
        }
    }
    facets
}

fn parse_category_ids(raw: &str) -> Result<Vec<Uuid>> {
    if raw.is_empty() || raw.len() > 50 * 37 {
        return Err(domain_catalog::invalid(
            "Select between 1 and 50 categories",
        ));
    }
    let parts: Vec<_> = raw.split(',').collect();
    if parts.len() > 50 {
        return Err(domain_catalog::invalid("At most 50 category filters"));
    }
    let mut ids = parts
        .into_iter()
        .map(|part| {
            Uuid::parse_str(part).map_err(|_| domain_catalog::invalid("Invalid category filter"))
        })
        .collect::<Result<Vec<_>>>()?;
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn stock_filter(in_stock: bool, stock_ids: Option<&[Uuid]>) -> String {
    if let Some(stocks) = stock_ids {
        let ids = stocks
            .iter()
            .map(|id| format!("'{id}'"))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "available_stock_ids {}IN [{ids}]",
            if in_stock { "" } else { "NOT " }
        )
    } else {
        format!("in_stock = {in_stock}")
    }
}
impl Client {
    pub fn new(url: String, key: String) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .expect("HTTP client"),
            url,
            key,
            remote: false,
            sort_schema: Default::default(),
        }
    }
    /// Request-serving adapter; the indexing worker always uses `new` directly.
    pub fn serving_environment() -> std::result::Result<Self, Box<dyn std::error::Error>> {
        let Ok(url) = std::env::var("SEARCH_SERVICE_URL") else {
            return Ok(Self::new(
                std::env::var("MEILI_URL")?,
                std::env::var("MEILI_MASTER_KEY")?,
            ));
        };
        if !url.starts_with("https://") {
            return Err("SEARCH_SERVICE_URL must use HTTPS with mutual TLS".into());
        }
        let ca = std::fs::read(std::env::var("SEARCH_SERVICE_CA")?)?;
        let identity = std::fs::read(std::env::var("SEARCH_SERVICE_IDENTITY")?)?;
        let key = std::env::var("SEARCH_SERVICE_TOKEN")?;
        if key.len() < 32 {
            return Err("SEARCH_SERVICE_TOKEN must contain at least 32 characters".into());
        }
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .add_root_certificate(reqwest::Certificate::from_pem(&ca)?)
                .identity(reqwest::Identity::from_pem(&identity)?)
                .build()?,
            url: url.trim_end_matches('/').to_owned(),
            key,
            remote: true,
            sort_schema: Default::default(),
        })
    }

    async fn request(&self, method: reqwest::Method, path: &str, body: Value) -> Result<Value> {
        self.http
            .request(method, format!("{}{path}", self.url))
            .bearer_auth(&self.key)
            .json(&body)
            .send()
            .await
            .map_err(failure)?
            .error_for_status()
            .map_err(failure)?
            .json()
            .await
            .map_err(failure)
    }
    async fn task(&self, method: reqwest::Method, path: &str, body: Value) -> Result<()> {
        let response = self.request(method, path, body).await?;
        let id = response["taskUid"].as_u64().ok_or(Error::Internal)?;
        for _ in 0..100 {
            let task = self
                .request(reqwest::Method::GET, &format!("/tasks/{id}"), Value::Null)
                .await?;
            match task["status"].as_str() {
                Some("succeeded") => return Ok(()),
                Some("failed" | "canceled") => return Err(failure(task)),
                _ => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
        Err(failure("Index task timeout"))
    }
    pub async fn initialize(&self) -> Result<()> {
        // Settings auto-create this index, then documents explicitly use the UUID primary key.
        self.task(reqwest::Method::PATCH,"/indexes/products/settings",json!({"searchableAttributes":["name","localized_names","sku","description","localized_descriptions","search_attributes"],"filterableAttributes":["category_ids","price_minor","in_stock","attribute_tokens","facet_tokens","available_stock_ids"],"pagination":{"maxTotalHits":10000}})).await
    }
    pub async fn sync(
        &self,
        catalog: &impl CatalogReader,
        inventory: &impl domain_inventory::InventoryReader,
        id: Uuid,
    ) -> Result<()> {
        self.sync_batch(catalog, inventory, &[id]).await
    }

    /// Bounded provider batches preserve sequential event ordering and replay safety.
    pub async fn sync_batch(
        &self,
        catalog: &impl CatalogReader,
        inventory: &impl domain_inventory::InventoryReader,
        ids: &[Uuid],
    ) -> Result<()> {
        let definitions = catalog.definitions().await?;
        let categories = catalog.categories().await?;
        let definition_ids: Vec<_> = definitions.iter().map(|d| d.id).collect();
        let definition_translations = catalog
            .search_translations("attribute", &definition_ids)
            .await?;
        let sort_fields: Vec<String> = definitions
            .iter()
            .filter(|d| d.metadata.active() && d.is_visible_on_front && d.metadata.sortable)
            .map(|d| format!("attribute_sort.{}", d.attribute_code))
            .chain(["price_minor".to_owned(), "name".to_owned()])
            .collect();
        let mut configured = self.sort_schema.lock().await;
        if configured.as_ref() != Some(&sort_fields) {
            self.task(
                reqwest::Method::PATCH,
                "/indexes/products/settings",
                json!({"sortableAttributes":sort_fields}),
            )
            .await?;
            *configured = Some(sort_fields);
        }
        drop(configured);
        for chunk in ids.chunks(INDEX_BATCH_SIZE) {
            let mut documents = Vec::new();
            let mut deleted = Vec::new();
            for &id in chunk {
                match self
                    .document(
                        catalog,
                        inventory,
                        id,
                        &definitions,
                        &categories,
                        &definition_translations,
                    )
                    .await?
                {
                    Some(document) => documents.push(document),
                    None => deleted.push(id),
                }
            }
            self.write_batch(documents, deleted).await?;
        }
        Ok(())
    }

    async fn write_batch(&self, documents: Vec<Value>, deleted: Vec<Uuid>) -> Result<()> {
        if !documents.is_empty() {
            self.task(
                reqwest::Method::PUT,
                "/indexes/products/documents?primaryKey=id",
                json!(documents),
            )
            .await?;
        }
        if !deleted.is_empty() {
            self.task(
                reqwest::Method::POST,
                "/indexes/products/documents/delete-batch",
                json!(deleted),
            )
            .await?;
        }
        Ok(())
    }

    async fn document(
        &self,
        catalog: &impl CatalogReader,
        inventory: &impl domain_inventory::InventoryReader,
        id: Uuid,
        defs: &[domain_catalog::Definition],
        categories: &[domain_catalog::Category],
        definition_translations: &[domain_catalog::SearchTranslation],
    ) -> Result<Option<Value>> {
        // Read current domain state on every delivery; replayed old events cannot resurrect deleted data.
        match catalog.product(id).await {
            Ok(product) if product.active && product.parent_id.is_none() => {
                let ids =
                    category_memberships(product.category_id, &product.category_ids, categories);
                let mut doc = serde_json::to_value(&product).map_err(failure)?;
                let children = if product.product_type != "simple" {
                    catalog.children(id).await?
                } else {
                    vec![]
                };
                let source_ids: Vec<_> = std::iter::once(&product)
                    .chain(children.iter())
                    .map(|p| p.id)
                    .collect();
                let translations = catalog.search_translations("product", &source_ids).await?;
                let copy = localized::search_copy(
                    &product,
                    &children,
                    defs,
                    &translations,
                    definition_translations,
                );
                doc["localized_names"] = json!(copy.names);
                doc["localized_descriptions"] = json!(copy.descriptions);
                let mut tokens = vec![];
                let mut searchable = copy.attributes;
                let mut facets = vec![];
                let mut sort_values = serde_json::Map::new();
                for d in defs {
                    if d.metadata.active() && d.is_visible_on_front && d.metadata.sortable {
                        if let Some(value) = product.attributes.get(&d.attribute_code) {
                            let normalized = match d.input_type.as_str() {
                                "price" => value
                                    .as_str()
                                    .and_then(|v| v.parse::<f64>().ok())
                                    .map(|v| json!(v)),
                                "datetime" => value
                                    .as_str()
                                    .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
                                    .map(|v| json!(v.timestamp_millis())),
                                _ => Some(value.clone()),
                            };
                            if let Some(value) = normalized {
                                sort_values.insert(d.attribute_code.clone(), value);
                            }
                        }
                    }
                    for source in std::iter::once(&product).chain(children.iter()) {
                        if let Some(v) = source.attributes.get(&d.attribute_code) {
                            if d.metadata.active() && d.is_filterable && d.is_visible_on_front {
                                for value in
                                    v.as_array().cloned().unwrap_or_else(|| vec![v.clone()])
                                {
                                    tokens.push(format!("{}={}", d.attribute_code, value));
                                    if d.metadata.facetable {
                                        facets.push(format!("{}={}", d.attribute_code, value));
                                    }
                                }
                            }
                            if d.metadata.active() && d.is_searchable && d.is_visible_on_front {
                                searchable.push(v.to_string());
                                for o in d.options.as_array().unwrap() {
                                    if v == &o["value"]
                                        || v.as_array().is_some_and(|a| a.contains(&o["value"]))
                                    {
                                        searchable.push(o["label"].as_str().unwrap_or("").into());
                                    }
                                }
                            }
                        }
                    }
                    if !d.metadata.active()
                        || (!d.is_visible_on_front && !d.used_for_configurations)
                    {
                        doc["attributes"]
                            .as_object_mut()
                            .unwrap()
                            .remove(&d.attribute_code);
                    }
                }
                let mut stocks = if product.product_type == "simple" {
                    inventory.available_stocks(id).await?
                } else {
                    vec![]
                };
                for child in &children {
                    stocks.extend(inventory.available_stocks(child.id).await?);
                }
                stocks.sort();
                stocks.dedup();
                let in_stock = !stocks.is_empty();
                doc["available_stock_ids"] = json!(stocks);
                doc["attribute_tokens"] = json!(tokens);
                doc["facet_tokens"] = json!(facets);
                doc["attribute_sort"] = json!(sort_values);
                doc["search_attributes"] = json!(searchable
                    .iter()
                    .map(|text| localized::normalize_arabic(text))
                    .collect::<Vec<_>>());
                doc["assigned_category_ids"] = json!(product.category_ids);
                doc["category_ids"] = json!(ids);
                doc["in_stock"] = json!(in_stock);
                // Decimal price -> integer cents, with no binary floating-point rounding.
                let listing_price = children
                    .iter()
                    .map(|p| p.price)
                    .min()
                    .unwrap_or(product.price);
                doc["price_minor"] = json!(price_minor(&listing_price.to_string())?);
                Ok(Some(doc))
            }
            Ok(_) | Err(Error::NotFound) => Ok(None),
            Err(e) => Err(e),
        }
    }
    async fn query(&self, input: Search) -> Result<Results> {
        let q = input.q.unwrap_or_default();
        if q.chars().count() > 200 {
            return Err(domain_catalog::invalid("Search is too long"));
        }
        let q = localized::normalize_arabic(&q);
        let offset = input.offset.unwrap_or(0);
        if offset > 9999 {
            return Err(domain_catalog::invalid("Search offset exceeds limit"));
        }
        let mut filters = Vec::new();
        let mut alternative_facets = Vec::new();
        if let Some(raw) = input.attribute_filters {
            if raw.len() > 4000 {
                return Err(domain_catalog::invalid("Too many attribute filters"));
            }
            let values: std::collections::BTreeMap<String, Value> = serde_json::from_str(&raw)
                .map_err(|_| domain_catalog::invalid("Invalid attribute filters"))?;
            if values.len() > 20 {
                return Err(domain_catalog::invalid("At most 20 attribute filters"));
            }
            for (code, value) in values {
                let alternatives = value
                    .as_array()
                    .cloned()
                    .unwrap_or_else(|| vec![value.clone()]);
                if alternatives.is_empty() || alternatives.len() > 50 {
                    return Err(domain_catalog::invalid(
                        "Select between 1 and 50 attribute values",
                    ));
                }
                let mut expressions = Vec::new();
                for alternative in alternatives {
                    if alternative.is_object() || alternative.is_array() || alternative.is_null() {
                        return Err(domain_catalog::invalid(
                            "Filter alternatives must be scalar",
                        ));
                    }
                    let token = format!("{code}={alternative}");
                    expressions.push(format!(
                        "attribute_tokens = {}",
                        serde_json::to_string(&token).map_err(failure)?
                    ));
                }
                if value.is_array() {
                    alternative_facets.push((code, filters.len()));
                }
                filters.push(if expressions.len() == 1 {
                    expressions.remove(0)
                } else {
                    format!("({})", expressions.join(" OR "))
                });
            }
        }
        if let Some(id) = input.category_id {
            filters.push(format!("category_ids = '{id}'"));
        }
        if let Some(raw) = input.category_ids.as_deref() {
            let ids = parse_category_ids(raw)?;
            filters.push(format!(
                "category_ids IN [{}]",
                ids.iter()
                    .map(|id| format!("'{id}'"))
                    .collect::<Vec<_>>()
                    .join(",")
            ));
        }
        let min = input.min_price.as_deref().map(price_minor).transpose()?;
        let max = input.max_price.as_deref().map(price_minor).transpose()?;
        if (input.exclusive_min && min.is_none())
            || min
                .zip(max)
                .is_some_and(|(a, b)| a > b || (a == b && input.exclusive_min))
        {
            return Err(domain_catalog::invalid("Minimum price exceeds maximum"));
        }
        if let Some(v) = min {
            filters.push(format!(
                "price_minor {} {v}",
                if input.exclusive_min { ">" } else { ">=" }
            ));
        }
        if let Some(v) = max {
            filters.push(format!("price_minor <= {v}"));
        }
        if let Some(v) = input.in_stock {
            filters.push(stock_filter(v, input.stock_ids.as_deref()));
        }
        let sort = if let Some(code) = input.sort_by {
            if code.is_empty()
                || code.len() > 64
                || !code
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
            {
                return Err(domain_catalog::invalid("Invalid attribute sort"));
            }
            let order = input.sort_order.unwrap_or_else(|| "asc".into());
            if !["asc", "desc"].contains(&order.as_str()) {
                return Err(domain_catalog::invalid("Invalid sort order"));
            }
            let field = match code.as_str() {
                "price" => "price_minor".to_owned(),
                "name" => "name".to_owned(),
                _ => format!("attribute_sort.{code}"),
            };
            vec![format!("{field}:{order}")]
        } else {
            vec![]
        };
        let result=self.request(reqwest::Method::POST,"/indexes/products/search",json!({"q":q,"filter":filters,"sort":sort,"facets":["facet_tokens"],"offset":offset,"limit":24,"attributesToRetrieve":["id","entity_id","sku","slug","name","description","price","currency","unit","category_id","assigned_category_ids","attributes","media_ids","active","in_stock","updated_at","product_type","parent_id","variant_attributes"]})).await?;
        let mut facets = parse_facets(&result);
        if !alternative_facets.is_empty() {
            // Within one attribute, counts ignore its own selections, so shoppers
            // can add alternatives while category, stock, price and other attributes still apply.
            let queries: Vec<_> = alternative_facets.iter().map(|(_, excluded)| json!({
                "indexUid":"products", "q":q, "limit":0, "facets":["facet_tokens"],
                "filter":filters.iter().enumerate().filter(|(i, _)| i != excluded).map(|(_, v)| v).collect::<Vec<_>>()
            })).collect();
            let response = self
                .request(
                    reqwest::Method::POST,
                    "/multi-search",
                    json!({"queries":queries}),
                )
                .await?;
            let results = response["results"]
                .as_array()
                .filter(|r| r.len() == alternative_facets.len())
                .ok_or_else(|| failure("Invalid attribute facet response"))?;
            for ((code, _), result) in alternative_facets.iter().zip(results) {
                if !result["facetDistribution"]["facet_tokens"].is_object() {
                    return Err(failure("Missing attribute facet distribution"));
                }
                let counts = parse_facets(result).remove(code).unwrap_or_default();
                facets.insert(code.clone(), counts);
            }
        }
        Ok(Results {
            facets,
            hits: serde_json::from_value(result["hits"].clone()).map_err(failure)?,
            total: result["estimatedTotalHits"].as_u64().unwrap_or(0),
            offset,
            limit: 24,
        })
    }
}
pub fn price_minor(value: &str) -> Result<i64> {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
        || fraction.len() > 2
    {
        return Err(domain_catalog::invalid(
            "Price must be a non-negative decimal with at most two fractional digits",
        ));
    }
    let major: i64 = whole
        .parse()
        .map_err(|_| domain_catalog::invalid("Invalid price"))?;
    if major > 9999999999 {
        return Err(domain_catalog::invalid("Price is too large"));
    }
    let minor = if fraction.is_empty() {
        0
    } else {
        fraction.parse::<i64>().map_err(|_| Error::Internal)?
            * if fraction.len() == 1 { 10 } else { 1 }
    };
    Ok(major * 100 + minor)
}
pub async fn consume(
    catalog: Service,
    inventory: domain_inventory::Service,
    client: Client,
    url: String,
) {
    loop {
        if let Err(e) = consume_loop(&catalog, &inventory, &client, &url).await {
            tracing::warn!(error=%e,"catalog indexer retrying");
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}
// Keep provider payloads and outstanding durable deliveries bounded together.
const INDEX_BATCH_SIZE: usize = 128;

#[derive(Debug, PartialEq)]
enum IndexWork {
    Products(Vec<Uuid>),
    Reindex(Option<Uuid>),
}

fn index_work(events: &[infra_events::EventEnvelope]) -> Result<Vec<IndexWork>> {
    let mut work = Vec::new();
    let mut ids = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for event in events {
        if matches!(
            event.event_type.as_str(),
            "catalog.product_updated"
                | "catalog.product_translation_updated"
                | "inventory.stock_updated"
        ) {
            let id: Uuid = serde_json::from_value(event.payload["id"].clone()).map_err(failure)?;
            if seen.insert(id) {
                ids.push(id);
            }
            continue;
        }
        // Never coalesce across a category/schema event: finish earlier products first.
        if !ids.is_empty() {
            work.push(IndexWork::Products(std::mem::take(&mut ids)));
            seen.clear();
        }
        match event.event_type.as_str() {
            "catalog.market_published" | "catalog.search_translations_updated" => {
                work.push(IndexWork::Reindex(None))
            }
            "catalog.category_updated" => work.push(IndexWork::Reindex(Some(
                serde_json::from_value(event.payload["id"].clone()).map_err(failure)?,
            ))),
            "catalog.attribute_definition_updated"
                if event
                    .payload
                    .get("entity_type")
                    .and_then(Value::as_str)
                    .is_none_or(|entity| entity == "product") =>
            {
                work.push(IndexWork::Reindex(None));
            }
            _ => {}
        }
    }
    if !ids.is_empty() {
        work.push(IndexWork::Products(ids));
    }
    Ok(work)
}

async fn process_events(
    catalog: &Service,
    inventory: &impl domain_inventory::InventoryReader,
    client: &Client,
    events: &[infra_events::EventEnvelope],
) -> Result<()> {
    for work in index_work(events)? {
        match work {
            IndexWork::Products(mut ids) => {
                let mut seen: std::collections::HashSet<_> = ids.iter().copied().collect();
                let mut parents = Vec::new();
                for &id in &ids {
                    match catalog.product(id).await {
                        Ok(product) => {
                            if let Some(parent) = product.parent_id {
                                if seen.insert(parent) {
                                    parents.push(parent);
                                }
                            }
                        }
                        Err(Error::NotFound) => {} // sync_batch removes stale documents.
                        Err(error) => return Err(error),
                    }
                }
                ids.extend(parents);
                client.sync_batch(catalog, inventory, &ids).await?;
            }
            IndexWork::Reindex(category) => {
                reindex(catalog, inventory, client, category).await?;
            }
        }
    }
    Ok(())
}

async fn reindex(
    catalog: &Service,
    inventory: &impl domain_inventory::InventoryReader,
    client: &Client,
    category: Option<Uuid>,
) -> Result<()> {
    let mut after = Uuid::nil();
    loop {
        let products = catalog.index_page(category, after).await?;
        if products.is_empty() {
            break;
        }
        for chunk in products.chunks(INDEX_BATCH_SIZE) {
            let ids: Vec<_> = chunk.iter().map(|p| p.id).collect();
            client.sync_batch(catalog, inventory, &ids).await?;
            after = *ids.last().expect("nonempty index page chunk");
        }
    }
    Ok(())
}

fn consumer_config() -> async_nats::jetstream::consumer::pull::Config {
    async_nats::jetstream::consumer::pull::Config {
        durable_name: Some("catalog-search-v2".into()),
        filter_subjects: vec![
            "commerce.catalog.>".into(),
            "commerce.inventory.stock_updated".into(),
        ],
        ack_policy: async_nats::jetstream::consumer::AckPolicy::Explicit,
        max_ack_pending: INDEX_BATCH_SIZE as i64,
        ack_wait: Duration::from_secs(120),
        ..Default::default()
    }
}

async fn complete_batch(
    messages: &[async_nats::jetstream::Message],
    apply: impl std::future::Future<Output = ()>,
    heartbeat_every: Duration,
) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tokio::pin!(apply);
    let mut heartbeat = tokio::time::interval(heartbeat_every);
    loop {
        tokio::select! {
            _ = &mut apply => break,
            _ = heartbeat.tick() => {
                // Includes deliveries behind a slow category/schema rebuild.
                for message in messages {
                    message.ack_with(async_nats::jetstream::AckKind::Progress).await?;
                }
            }
        }
    }
    for message in messages {
        message.double_ack().await?;
    }
    Ok(())
}

// One writer across gateway replicas, not merely one task per process. Session
// locks must never return to the pool; close_on_drop releases them on all exits.
const INDEX_WRITER_LOCK: i64 = 73191;

async fn index_lease(
    pool: &sqlx::PgPool,
) -> std::result::Result<sqlx::pool::PoolConnection<sqlx::Postgres>, sqlx::Error> {
    let mut connection = pool.acquire().await?;
    connection.close_on_drop();
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(INDEX_WRITER_LOCK)
        .execute(&mut *connection)
        .await?;
    Ok(connection)
}

async fn watch_index_lease(
    connection: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        tokio::time::timeout(
            Duration::from_secs(5),
            sqlx::query("SELECT 1").execute(&mut **connection),
        )
        .await??;
    }
}

async fn consume_loop(
    catalog: &Service,
    inventory: &impl domain_inventory::InventoryReader,
    client: &Client,
    url: &str,
) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut lease = index_lease(&catalog.pool).await?;
    // Losing the lock's connection cancels in-flight processing. Unacknowledged
    // deliveries remain durable and are rebuilt from canonical state on retry.
    tokio::select! {
        result = consume_as_leader(catalog, inventory, client, url) => result,
        result = watch_index_lease(&mut lease) => result,
    }
}

async fn consume_as_leader(
    catalog: &Service,
    inventory: &impl domain_inventory::InventoryReader,
    client: &Client,
    url: &str,
) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
    client.initialize().await?;
    // Apply built-in and merchant sort fields even when the durable queue is idle.
    client.sync_batch(catalog, inventory, &[]).await?;
    let version: i32 =
        sqlx::query_scalar("SELECT version FROM catalog.search_index_schema WHERE singleton")
            .fetch_one(&catalog.pool)
            .await?;
    if version < SEARCH_INDEX_SCHEMA_VERSION {
        reindex(catalog, inventory, client, None).await?;
        sqlx::query("UPDATE catalog.search_index_schema SET version=$1 WHERE singleton")
            .bind(SEARCH_INDEX_SCHEMA_VERSION)
            .execute(&catalog.pool)
            .await?;
    }
    let js = async_nats::jetstream::new(async_nats::connect(url).await?);
    let stream = js
        .get_or_create_stream(async_nats::jetstream::stream::Config {
            name: "COMMERCE_EVENTS".into(),
            subjects: vec!["commerce.>".into()],
            ..Default::default()
        })
        .await?;
    // Update the existing durable in place: retain its cursor and unacknowledged events.
    let consumer = stream.create_consumer(consumer_config()).await?;
    loop {
        let mut incoming = consumer
            .fetch()
            .max_messages(INDEX_BATCH_SIZE)
            .expires(Duration::from_secs(1))
            .messages()
            .await?;
        let mut messages = Vec::with_capacity(INDEX_BATCH_SIZE);
        while let Some(message) = incoming.next().await {
            messages.push(message?);
        }
        if messages.is_empty() {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        // Retry this exact batch before fetching anything newer. No acknowledgement
        // is sent until every provider task succeeds. Partial writes replay safely
        // because sync_batch reads current canonical state and upserts by product ID.
        let apply = async {
            loop {
                let events = messages
                    .iter()
                    .map(|message| serde_json::from_slice(&message.payload))
                    .collect::<std::result::Result<Vec<infra_events::EventEnvelope>, _>>();
                let result = match events {
                    Ok(events) => process_events(catalog, inventory, client, &events).await,
                    Err(error) => Err(failure(error)),
                };
                match result {
                    Ok(()) => break,
                    Err(error) => {
                        tracing::warn!(%error, batch_size=messages.len(), "catalog index batch retrying; deliveries retained");
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                }
            }
        };
        complete_batch(&messages, apply, Duration::from_secs(30)).await?;
    }
}
fn category_memberships(
    primary: Uuid,
    assigned: &[Uuid],
    categories: &[domain_catalog::Category],
) -> Vec<Uuid> {
    let mut ids = assigned.to_vec();
    if !ids.contains(&primary) {
        ids.push(primary);
    }
    for category in ids.clone() {
        let mut next = categories
            .iter()
            .find(|c| c.id == category)
            .and_then(|c| c.parent_id);
        let mut visited = std::collections::HashSet::new();
        while let Some(id) = next {
            if !visited.insert(id) {
                break;
            }
            if !ids.contains(&id) {
                ids.push(id);
            }
            next = categories
                .iter()
                .find(|c| c.id == id)
                .and_then(|c| c.parent_id);
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

#[test]
fn indexes_every_assigned_category_and_its_ancestors() {
    let primary = Uuid::new_v4();
    let extra = Uuid::new_v4();
    let root = Uuid::new_v4();
    let categories = vec![domain_catalog::Category {
        id: extra,
        entity_id: 1,
        name: "Breakfast".into(),
        slug: "breakfast".into(),
        parent_id: Some(root),
        thumbnail: None,
        banner: None,
    }];
    let ids = category_memberships(primary, &[primary, extra, extra], &categories);
    assert_eq!(ids.len(), 3);
    assert!(ids.contains(&primary) && ids.contains(&extra) && ids.contains(&root));
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(kind: &str, payload: Value) -> infra_events::EventEnvelope {
        infra_events::EventEnvelope {
            id: Uuid::new_v4().to_string(),
            event_type: kind.into(),
            schema_version: 1,
            payload,
        }
    }

    #[test]
    fn market_publication_is_a_full_reindex_barrier() {
        let id = Uuid::new_v4();
        assert_eq!(
            index_work(&[
                event("catalog.product_updated", json!({"id":id})),
                event("catalog.market_published", json!({})),
                event("inventory.stock_updated", json!({"id":id}))
            ])
            .unwrap(),
            vec![
                IndexWork::Products(vec![id]),
                IndexWork::Reindex(None),
                IndexWork::Products(vec![id])
            ]
        );
    }
    #[test]
    fn translation_events_refresh_products_and_preserve_rebuild_barriers() {
        let id = Uuid::new_v4();
        assert_eq!(
            index_work(&[
                event("catalog.product_translation_updated", json!({"id":id})),
                event("catalog.search_translations_updated", json!({})),
                event("catalog.product_translation_updated", json!({"id":id})),
            ])
            .unwrap(),
            vec![
                IndexWork::Products(vec![id]),
                IndexWork::Reindex(None),
                IndexWork::Products(vec![id])
            ]
        );
    }
    #[test]
    fn coalesces_products_without_crossing_schema_barriers() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let category = Uuid::new_v4();
        let events = vec![
            event("catalog.product_updated", json!({"id":a})),
            event("inventory.stock_updated", json!({"id":a})),
            event("catalog.product_updated", json!({"id":b})),
            event("catalog.category_updated", json!({"id":category})),
            event("inventory.stock_updated", json!({"id":a})),
            event(
                "catalog.attribute_definition_updated",
                json!({"entity_type":"product"}),
            ),
            event("catalog.product_updated", json!({"id":b})),
        ];
        assert_eq!(
            index_work(&events).unwrap(),
            vec![
                IndexWork::Products(vec![a, b]),
                IndexWork::Reindex(Some(category)),
                IndexWork::Products(vec![a]),
                IndexWork::Reindex(None),
                IndexWork::Products(vec![b]),
            ]
        );
    }

    #[test]
    fn non_product_definitions_are_ignored_and_malformed_updates_fail() {
        assert!(index_work(&[event(
            "catalog.attribute_definition_updated",
            json!({"entity_type":"customer"})
        )])
        .unwrap()
        .is_empty());
        assert!(index_work(&[event("inventory.stock_updated", json!({"id":"broken"}))]).is_err());
    }

    #[tokio::test]
    #[ignore = "requires a disposable loopback NATS server via NATS_TEST_URL"]
    async fn durable_upgrade_preserves_cursor_and_acks_only_after_completion() {
        let url = std::env::var("NATS_TEST_URL").expect("NATS_TEST_URL");
        assert!(url.starts_with("nats://127.0.0.1:"));
        let connection = async_nats::connect(url).await.unwrap();
        let js = async_nats::jetstream::new(connection);
        let stream_name = format!("QUALITY_TEST_{}", Uuid::new_v4().simple());
        let subject = format!("quality.test.{}", Uuid::new_v4().simple());
        let stream = js
            .create_stream(async_nats::jetstream::stream::Config {
                name: stream_name.clone(),
                subjects: vec![subject.clone()],
                ..Default::default()
            })
            .await
            .unwrap();
        let mut config = consumer_config();
        config.filter_subjects = vec![subject.clone()];
        config.max_ack_pending = 1;
        let old = stream.create_consumer(config.clone()).await.unwrap();
        for n in 0..3 {
            js.publish(subject.clone(), n.to_string().into())
                .await
                .unwrap()
                .await
                .unwrap();
        }
        let mut first = old.fetch().max_messages(1).messages().await.unwrap();
        first
            .next()
            .await
            .unwrap()
            .unwrap()
            .double_ack()
            .await
            .unwrap();
        // The same durable is updated, not deleted/recreated at a fresh cursor.
        config.max_ack_pending = INDEX_BATCH_SIZE as i64;
        config.ack_wait = Duration::from_millis(200);
        let mut upgraded = stream.create_consumer(config).await.unwrap();
        let mut fetched = upgraded
            .fetch()
            .max_messages(INDEX_BATCH_SIZE)
            .messages()
            .await
            .unwrap();
        let mut messages = Vec::new();
        while let Some(message) = fetched.next().await {
            messages.push(message.unwrap());
        }
        assert_eq!(
            messages
                .iter()
                .map(|m| m.payload.to_vec())
                .collect::<Vec<_>>(),
            vec![b"1".to_vec(), b"2".to_vec()]
        );
        let (release, wait) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            complete_batch(
                &messages,
                async {
                    wait.await.unwrap();
                },
                Duration::from_millis(30),
            )
            .await
            .unwrap();
        });
        tokio::time::sleep(Duration::from_millis(400)).await;
        let info = upgraded.info().await.unwrap();
        assert_eq!(info.num_ack_pending, 2);
        assert_eq!(info.ack_floor.stream_sequence, 1);
        // Progress acknowledgements prevent redelivery even beyond ack_wait.
        let mut none = upgraded.fetch().max_messages(1).messages().await.unwrap();
        assert!(none.next().await.is_none());
        release.send(()).unwrap();
        worker.await.unwrap();
        let info = upgraded.info().await.unwrap();
        assert_eq!(info.num_ack_pending, 0);
        assert_eq!(info.ack_floor.stream_sequence, 3);
        assert_eq!(info.num_redelivered, 0);
        // Simulate a process dying during provider work: no final ACK escapes,
        // and the same durable redelivers both events for idempotent replay.
        for n in 3..5 {
            js.publish(subject.clone(), n.to_string().into())
                .await
                .unwrap()
                .await
                .unwrap();
        }
        let mut incoming = upgraded
            .fetch()
            .max_messages(INDEX_BATCH_SIZE)
            .messages()
            .await
            .unwrap();
        let mut uncommitted = Vec::new();
        while let Some(message) = incoming.next().await {
            uncommitted.push(message.unwrap());
        }
        assert_eq!(uncommitted.len(), 2);
        let stalled = tokio::spawn(async move {
            complete_batch(
                &uncommitted,
                std::future::pending(),
                Duration::from_millis(30),
            )
            .await
            .unwrap();
        });
        tokio::time::sleep(Duration::from_millis(60)).await;
        stalled.abort();
        let _ = stalled.await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        let mut replay = upgraded
            .fetch()
            .max_messages(INDEX_BATCH_SIZE)
            .messages()
            .await
            .unwrap();
        let mut replayed = Vec::new();
        while let Some(message) = replay.next().await {
            let message = message.unwrap();
            assert!(message.info().unwrap().delivered >= 2);
            replayed.push(message.payload.to_vec());
            message.double_ack().await.unwrap();
        }
        assert_eq!(replayed, vec![b"3".to_vec(), b"4".to_vec()]);
        assert_eq!(upgraded.info().await.unwrap().ack_floor.stream_sequence, 5);
        js.delete_stream(stream_name).await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires a disposable loopback PostgreSQL via INDEX_TEST_DATABASE_URL"]
    async fn writer_lease_is_exclusive_released_and_detects_disconnect() {
        let url = std::env::var("INDEX_TEST_DATABASE_URL").expect("INDEX_TEST_DATABASE_URL");
        assert!(url.contains("@127.0.0.1:"));
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(3)
            .connect(&url)
            .await
            .unwrap();
        let first = index_lease(&pool).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), index_lease(&pool))
                .await
                .is_err()
        );
        drop(first);
        let mut next = tokio::time::timeout(Duration::from_secs(3), index_lease(&pool))
            .await
            .unwrap()
            .unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *next)
            .await
            .unwrap();
        sqlx::query("SELECT pg_terminate_backend($1)")
            .bind(pid)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(3), watch_index_lease(&mut next))
                .await
                .unwrap()
                .is_err()
        );
        drop(next);
        let replacement = tokio::time::timeout(Duration::from_secs(3), index_lease(&pool))
            .await
            .unwrap()
            .unwrap();
        drop(replacement);
        pool.close().await;
    }

    // Tiny scripted HTTP peer verifies asynchronous provider tasks and exact batch payloads.
    async fn provider(
        script: Vec<(&'static str, Value, Value)>,
    ) -> (Client, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = Client::new(
            format!("http://{}", listener.local_addr().unwrap()),
            "test-key".into(),
        );
        let task = tokio::spawn(async move {
            for (request_line, expected_body, response) in script {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let header_end = loop {
                    let mut buffer = [0; 4096];
                    let n = socket.read(&mut buffer).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(offset) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        break offset + 4;
                    }
                };
                let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
                assert_eq!(headers.lines().next().unwrap(), request_line);
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap_or(0);
                while bytes.len() < header_end + length {
                    let mut buffer = [0; 4096];
                    let n = socket.read(&mut buffer).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                }
                assert_eq!(
                    serde_json::from_slice::<Value>(&bytes[header_end..header_end + length])
                        .unwrap(),
                    expected_body
                );
                let body = response.to_string();
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes()).await.unwrap();
            }
        });
        (client, task)
    }

    #[tokio::test]
    async fn mixed_batch_waits_for_both_tasks() {
        let id = Uuid::new_v4();
        let documents = vec![
            json!({"id": Uuid::new_v4(), "name": "one"}),
            json!({"id": Uuid::new_v4(), "name": "two"}),
        ];
        let (client, server) = provider(vec![
            (
                "PUT /indexes/products/documents?primaryKey=id HTTP/1.1",
                json!(documents),
                json!({"taskUid": 1}),
            ),
            (
                "GET /tasks/1 HTTP/1.1",
                Value::Null,
                json!({"status": "processing"}),
            ),
            (
                "GET /tasks/1 HTTP/1.1",
                Value::Null,
                json!({"status": "succeeded"}),
            ),
            (
                "POST /indexes/products/documents/delete-batch HTTP/1.1",
                json!([id]),
                json!({"taskUid": 2}),
            ),
            (
                "GET /tasks/2 HTTP/1.1",
                Value::Null,
                json!({"status": "succeeded"}),
            ),
        ])
        .await;
        client.write_batch(documents, vec![id]).await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn failed_batch_is_not_reported_as_success() {
        let documents = vec![json!({"id": Uuid::new_v4()})];
        let (client, server) = provider(vec![
            (
                "PUT /indexes/products/documents?primaryKey=id HTTP/1.1",
                json!(documents),
                json!({"taskUid": 1}),
            ),
            (
                "GET /tasks/1 HTTP/1.1",
                Value::Null,
                json!({"status": "failed"}),
            ),
        ])
        .await;
        assert!(client
            .write_batch(documents, vec![Uuid::new_v4()])
            .await
            .is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn empty_batch_needs_no_provider() {
        Client::new("http://127.0.0.1:1".into(), "test".into())
            .write_batch(vec![], vec![])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn category_counts_preserve_zeroes_and_delivery_stock_scope() {
        let a = Uuid::from_u128(1);
        let b = Uuid::from_u128(2);
        let stock = Uuid::from_u128(3);
        for (stocks, filter) in [
            (None, "in_stock = true".to_string()),
            (
                Some(vec![stock]),
                format!("available_stock_ids IN ['{stock}']"),
            ),
            (Some(vec![]), "available_stock_ids IN []".to_string()),
        ] {
            let (client, server) = provider(vec![(
                "POST /multi-search HTTP/1.1",
                json!({"queries":[
                    {"indexUid":"products","q":"","limit":0,"filter":[format!("category_ids = '{a}'"),filter]},
                    {"indexUid":"products","q":"","limit":0,"filter":[format!("category_ids = '{b}'"),filter]}
                ]}),
                json!({"results":[{"estimatedTotalHits":17},{"estimatedTotalHits":0}]}),
            )]).await;
            let counts = client.category_counts(&[b, a, a], stocks).await.unwrap();
            assert_eq!(counts.len(), 2);
            assert_eq!(counts[&a], 17);
            assert_eq!(counts[&b], 0);
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn category_counts_reject_missing_or_invalid_provider_results() {
        let id = Uuid::from_u128(1);
        for response in [
            json!({}),
            json!({"results":[]}),
            json!({"results":[{"estimatedTotalHits":"17"}]}),
        ] {
            let (client, server) = provider(vec![(
                "POST /multi-search HTTP/1.1",
                json!({"queries":[{"indexUid":"products","q":"","limit":0,"filter":[format!("category_ids = '{id}'"),"in_stock = true"]}]}),
                response,
            )]).await;
            assert!(client.category_counts(&[id], None).await.is_err());
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn category_counts_batch_every_category_without_a_display_limit() {
        let ids = (1..=201).map(Uuid::from_u128).collect::<Vec<_>>();
        let script = ids.chunks(100).map(|batch| (
            "POST /multi-search HTTP/1.1",
            json!({"queries":batch.iter().map(|id| json!({"indexUid":"products","q":"","limit":0,"filter":[format!("category_ids = '{id}'"),"in_stock = true"]})).collect::<Vec<_>>()}),
            json!({"results":batch.iter().map(|id| json!({"estimatedTotalHits":id.as_u128() as u64})).collect::<Vec<_>>()})
        )).collect();
        let (client, server) = provider(script).await;
        let counts = client.category_counts(&ids, None).await.unwrap();
        assert_eq!(counts.len(), 201);
        assert_eq!(counts[&ids[200]], 201);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn empty_category_counts_need_no_provider() {
        let counts = Client::new("http://127.0.0.1:1".into(), "test".into())
            .category_counts(&[], None)
            .await
            .unwrap();
        assert!(counts.is_empty());
    }

    #[tokio::test]
    async fn delegated_category_counts_preserve_stock_context() {
        let id = Uuid::from_u128(1);
        let stock = Uuid::from_u128(2);
        let input = Search {
            category_id: Some(id),
            in_stock: Some(true),
            ..Default::default()
        };
        let (mut client, server) = provider(vec![(
            "POST /internal/search HTTP/1.1",
            json!({"input": input, "stock_ids": [stock]}),
            json!({"hits":[],"total":8,"offset":0,"limit":24,"facets":{}}),
        )])
        .await;
        client.remote = true;
        assert_eq!(
            client
                .category_counts(&[id], Some(vec![stock]))
                .await
                .unwrap()[&id],
            8
        );
        server.await.unwrap();
    }

    #[test]
    fn category_filters_validate_deduplicate_and_bound_input() {
        let id = Uuid::from_u128(1);
        assert_eq!(parse_category_ids(&format!("{id},{id}")).unwrap(), vec![id]);
        for raw in [
            "",
            "not-a-uuid",
            "' OR true",
            &format!("{id},"),
            &vec![id.to_string(); 51].join(","),
        ] {
            assert!(parse_category_ids(raw).is_err());
        }
    }

    #[tokio::test]
    async fn selected_categories_are_ored_with_other_filters() {
        let a = Uuid::from_u128(1);
        let b = Uuid::from_u128(2);
        let (client, server) = provider(vec![("POST /indexes/products/search HTTP/1.1",
            json!({"q":"tea","filter":[format!("category_ids IN ['{a}','{b}']"),"price_minor >= 500","in_stock = true"],"sort":["price_minor:desc"],"facets":["facet_tokens"],"offset":24,"limit":24,"attributesToRetrieve":["id","entity_id","sku","slug","name","description","price","currency","unit","category_id","assigned_category_ids","attributes","media_ids","active","in_stock","updated_at","product_type","parent_id","variant_attributes"]}),
            json!({"hits":[],"estimatedTotalHits":7}))]).await;
        let result = client
            .search(Search {
                q: Some("tea".into()),
                category_ids: Some(format!("{b},{a},{b}")),
                min_price: Some("5".into()),
                in_stock: Some(true),
                sort_by: Some("price".into()),
                sort_order: Some("desc".into()),
                offset: Some(24),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result.total, 7);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn checkbox_alternatives_keep_other_filters_and_disjunctive_counts() {
        let expression = |code: &str, value: Value| {
            format!(
                "attribute_tokens = {}",
                serde_json::to_string(&format!("{code}={value}")).unwrap()
            )
        };
        let color = format!(
            "({} OR {})",
            expression("color", json!("red")),
            expression("color", json!("blue"))
        );
        let organic = expression("organic", json!(false));
        let category = Uuid::from_u128(1);
        let stock = Uuid::from_u128(2);
        let scope = vec![
            format!("category_ids = '{category}'"),
            "price_minor >= 500".into(),
            stock_filter(true, Some(&[stock])),
        ];
        let mut filters = vec![color.clone(), organic.clone()];
        filters.extend(scope.clone());
        let without_color: Vec<_> = std::iter::once(organic.clone())
            .chain(scope.clone())
            .collect();
        let without_organic: Vec<_> = std::iter::once(color.clone()).chain(scope).collect();
        let (client, server) = provider(vec![
            ("POST /indexes/products/search HTTP/1.1",json!({"q":"tea","filter":filters,"sort":[],"facets":["facet_tokens"],"offset":24,"limit":24,"attributesToRetrieve":["id","entity_id","sku","slug","name","description","price","currency","unit","category_id","assigned_category_ids","attributes","media_ids","active","in_stock","updated_at","product_type","parent_id","variant_attributes"]}),json!({"hits":[],"estimatedTotalHits":3,"facetDistribution":{"facet_tokens":{"color=\"red\"":2,"organic=false":3}}})),
            ("POST /multi-search HTTP/1.1",json!({"queries":[
                {"indexUid":"products","q":"tea","limit":0,"facets":["facet_tokens"],"filter":without_color},
                {"indexUid":"products","q":"tea","limit":0,"facets":["facet_tokens"],"filter":without_organic}
            ]}),json!({"results":[{"facetDistribution":{"facet_tokens":{"color=\"red\"":2,"color=\"blue\"":1,"color=\"green\"":4}}},{"facetDistribution":{"facet_tokens":{"organic=false":3,"organic=true":5}}}]}))
        ]).await;
        let result = client
            .search(Search {
                q: Some("tea".into()),
                attribute_filters: Some(
                    json!({"color":["red","blue"],"organic":[false]}).to_string(),
                ),
                category_id: Some(category),
                min_price: Some("5".into()),
                in_stock: Some(true),
                stock_ids: Some(vec![stock]),
                offset: Some(24),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result.total, 3);
        assert_eq!(result.facets["color"]["green"], 4);
        assert_eq!(result.facets["organic"]["true"], 5);
        server.await.unwrap();
    }
    #[tokio::test]
    async fn invalid_checkbox_alternatives_fail_before_network() {
        let client = Client::new("http://127.0.0.1:1".into(), "test".into());
        for value in [
            json!([]),
            json!([null]),
            json!([["red"]]),
            json!([{}]),
            json!(vec!["red"; 51]),
        ] {
            assert!(client
                .search(Search {
                    attribute_filters: Some(json!({"color":value}).to_string()),
                    ..Default::default()
                })
                .await
                .is_err());
        }
    }

    #[tokio::test]
    async fn schema_filters_sort_and_facets_reach_provider() {
        let token = serde_json::to_string("metal=\"gold\"").unwrap();
        let (client,server)=provider(vec![("POST /indexes/products/search HTTP/1.1",json!({"q":"ring","filter":[format!("attribute_tokens = {token}"),"price_minor <= 200000"],"sort":["attribute_sort.carat_weight:desc"],"facets":["facet_tokens"],"offset":0,"limit":24,"attributesToRetrieve":["id","entity_id","sku","slug","name","description","price","currency","unit","category_id","assigned_category_ids","attributes","media_ids","active","in_stock","updated_at","product_type","parent_id","variant_attributes"]}),json!({"hits":[],"estimatedTotalHits":0,"facetDistribution":{"facet_tokens":{"metal=\"gold\"":3}}}))]).await;
        let result = client
            .search(Search {
                q: Some("ring".into()),
                attribute_filters: Some(json!({"metal":"gold"}).to_string()),
                max_price: Some("2000".into()),
                sort_by: Some("carat_weight".into()),
                sort_order: Some("desc".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result.facets["metal"]["gold"], 3);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn strict_minimum_reaches_search_before_candidate_window() {
        for (strict, operator) in [(false, ">="), (true, ">")] {
            let (client, server) = provider(vec![(
                "POST /indexes/products/search HTTP/1.1",
                json!({"q":"shoes", "filter":[format!("price_minor {operator} 10001"), "price_minor <= 20000"], "sort":[], "facets":["facet_tokens"], "offset":0, "limit":24, "attributesToRetrieve":["id","entity_id","sku","slug","name","description","price","currency","unit","category_id","assigned_category_ids","attributes","media_ids","active","in_stock","updated_at","product_type","parent_id","variant_attributes"]}),
                json!({"hits":[],"estimatedTotalHits":0})
            )]).await;
            client
                .search(Search {
                    q: Some("shoes".into()),
                    min_price: Some("100.01".into()),
                    max_price: Some("200".into()),
                    exclusive_min: strict,
                    ..Default::default()
                })
                .await
                .unwrap();
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn strict_empty_range_is_rejected_before_network() {
        let client = Client::new("http://127.0.0.1:1".into(), "test".into());
        assert!(client
            .search(Search {
                min_price: Some("100".into()),
                max_price: Some("100".into()),
                exclusive_min: true,
                ..Default::default()
            })
            .await
            .is_err());
    }

    #[tokio::test]
    async fn arabic_search_keeps_all_filters_sorts_facets_and_pagination() {
        let category = Uuid::new_v4();
        let stock = Uuid::new_v4();
        let token = serde_json::to_string("brand=\"garden\"").unwrap();
        let (client, server) = provider(vec![(
            "POST /indexes/products/search HTTP/1.1",
            json!({"q":"شاي اخضر 123", "filter":[format!("attribute_tokens = {token}"),format!("category_ids = '{category}'"),"price_minor >= 500","price_minor <= 2000",format!("available_stock_ids IN ['{stock}']")], "sort":["price_minor:asc"],"facets":["facet_tokens"],"offset":24,"limit":24,"attributesToRetrieve":["id","entity_id","sku","slug","name","description","price","currency","unit","category_id","assigned_category_ids","attributes","media_ids","active","in_stock","updated_at","product_type","parent_id","variant_attributes"]}),
            json!({"hits":[],"estimatedTotalHits":30,"facetDistribution":{"facet_tokens":{"brand=\"garden\"":30}}}),
        )]).await;
        let result = client
            .search(Search {
                q: Some("شَـاي أَخْضَر ١٢٣".into()),
                category_id: Some(category),
                stock_ids: Some(vec![stock]),
                attribute_filters: Some(json!({"brand":"garden"}).to_string()),
                min_price: Some("5".into()),
                max_price: Some("20".into()),
                in_stock: Some(true),
                sort_by: Some("price".into()),
                sort_order: Some("asc".into()),
                offset: Some(24),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result.offset, 24);
        assert_eq!(result.total, 30);
        assert_eq!(result.facets["brand"]["garden"], 30);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn arabic_limit_counts_characters_instead_of_utf8_bytes() {
        let text = "ش".repeat(200);
        let (client, server) = provider(vec![(
            "POST /indexes/products/search HTTP/1.1",
            json!({"q":text,"filter":[],"sort":[],"facets":["facet_tokens"],"offset":0,"limit":24,"attributesToRetrieve":["id","entity_id","sku","slug","name","description","price","currency","unit","category_id","assigned_category_ids","attributes","media_ids","active","in_stock","updated_at","product_type","parent_id","variant_attributes"]}),
            json!({"hits":[],"estimatedTotalHits":0}),
        )]).await;
        client
            .search(Search {
                q: Some(text),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(client
            .search(Search {
                q: Some("ش".repeat(201)),
                ..Default::default()
            })
            .await
            .is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn builtin_sorts_use_catalog_fields() {
        for (code, field, order) in [
            ("price", "price_minor", "asc"),
            ("price", "price_minor", "desc"),
            ("name", "name", "asc"),
        ] {
            let (client, server) = provider(vec![("POST /indexes/products/search HTTP/1.1", json!({"q":"", "filter":[], "sort":[format!("{field}:{order}")], "facets":["facet_tokens"], "offset":0, "limit":24, "attributesToRetrieve":["id","entity_id","sku","slug","name","description","price","currency","unit","category_id","assigned_category_ids","attributes","media_ids","active","in_stock","updated_at","product_type","parent_id","variant_attributes"]}), json!({"hits":[],"estimatedTotalHits":0}))]).await;
            client
                .search(Search {
                    sort_by: Some(code.into()),
                    sort_order: Some(order.into()),
                    ..Default::default()
                })
                .await
                .unwrap();
            server.await.unwrap();
        }
    }

    #[test]
    fn exact_price_filters() {
        assert_eq!(price_minor("1.20").unwrap(), 120);
        assert_eq!(price_minor("0.01").unwrap(), 1);
        for s in ["-1", "NaN", "1.234", "1 OR true", "1e2"] {
            assert!(price_minor(s).is_err());
        }
    }
}

pub mod discovery;
