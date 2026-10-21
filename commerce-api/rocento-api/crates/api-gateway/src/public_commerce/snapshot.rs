//! A single repeatable-read snapshot; customer cookies and forwarded location are never inputs.
use crate::discoverability::{App, Settings, SELECT};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use domain_catalog::public::{self as catalog, Category, Product};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub path: String,
    #[serde(default = "first")]
    pub page: u32,
}
fn first() -> u32 {
    1
}
#[derive(Serialize, FromRow)]
pub struct Content {
    pub revision_id: Uuid,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub id: Uuid,
    pub title: String,
    pub blocks: sqlx::types::Json<Vec<domain_cms::Block>>,
}
#[derive(Serialize, FromRow)]
pub struct Guide {
    pub path: String,
    pub title: String,
}
#[derive(Serialize)]
pub struct Snapshot {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub representation_version: String,
    pub merchant: Option<super::entity::PublicEntity>,
    pub comparisons: Vec<Product>,
    pub schema_version: u32,
    pub discovery_attribution_enabled: bool,
    pub structured_data: Option<Value>,
    pub related_canonicals: std::collections::BTreeMap<Uuid, super::canonical::Identity>,
    pub family: Vec<Product>,
    pub variant_dimensions: Vec<String>,
    pub parent_product: Option<Product>,
    pub metadata: super::metadata::Resolved,
    pub guides: Vec<Guide>,
    pub images: std::collections::BTreeMap<Uuid, super::images::PublicImage>,
    pub installation_id: Uuid,
    pub origin: String,
    pub locale: String,
    pub site_name: String,
    pub description: String,
    pub path: String,
    pub kind: &'static str,
    pub status: u16,
    pub location: Option<String>,
    pub canonical: Option<super::canonical::Identity>,
    pub robots: &'static str,
    pub theme: domain_theme::domain::Configuration,
    pub categories: Vec<Category>,
    pub category_id: Option<Uuid>,
    pub products: Vec<Product>,
    pub collections: std::collections::BTreeMap<String, Vec<Product>>,
    pub product: Option<Product>,
    pub content: Option<Content>,
    pub page: u32,
    pub has_next: bool,
    pub availability: &'static str,
}
pub async fn handler(
    State(app): State<App>,
    headers: HeaderMap,
    Query(request): Query<Request>,
) -> Response {
    if !app.deployment.accepts_host(&headers) {
        tracing::warn!(event="publication_response",code="unknown_canonical_host",installation_id=?app.deployment.installation_id);
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    }
    if request.page == 0 || request.page > 10000 || !valid_path(&request.path) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match tokio::time::timeout(
        std::time::Duration::from_secs(4),
        assemble(&app, request, None),
    )
    .await
    {
        Ok(Ok(snapshot)) => Json(snapshot).into_response(),
        _ => {
            tracing::warn!(event="publication_response",code="snapshot_failure",installation_id=?app.deployment.installation_id);
            (StatusCode::SERVICE_UNAVAILABLE, "Publication unavailable").into_response()
        }
    }
}
pub fn valid_path(path: &str) -> bool {
    path == "/"
        || ["/products/", "/categories/", "/pages/"]
            .iter()
            .any(|prefix| {
                path.strip_prefix(prefix).is_some_and(|key| {
                    !key.is_empty()
                        && key.len() <= 200
                        && key
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                })
            })
}
pub async fn assemble(
    app: &App,
    request: Request,
    preview: Option<super::metadata::Configuration>,
) -> Result<Snapshot, sqlx::Error> {
    let mut tx = app.identity.admins.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout = '3000ms'")
        .execute(&mut *tx)
        .await?;
    let settings: Settings = sqlx::query_as(SELECT).fetch_one(&mut *tx).await?;
    let installation_id: Uuid = sqlx::query_scalar(
        "SELECT installation_id FROM platform.publication_installation WHERE singleton",
    )
    .fetch_one(&mut *tx)
    .await?;
    if app.deployment.installation_id != Some(installation_id) {
        return Err(sqlx::Error::Protocol(
            "installation binding mismatch".into(),
        ));
    }
    let policy = app.deployment.resolve(&settings);
    let canonical_context =
        super::canonical::Context::from_installation(&app.deployment, &settings, installation_id);
    let configuration: Option<Value> = sqlx::query_scalar("SELECT v.configuration FROM theme.assignments a JOIN theme.themes t ON t.id=a.theme_id JOIN theme.versions v ON v.id=t.published_version WHERE a.channel='storefront'").fetch_optional(&mut *tx).await?;
    let theme = match configuration {
        Some(value) => serde_json::from_value(value)
            .map_err(|_| sqlx::Error::Protocol("invalid published theme".into()))?,
        None => domain_theme::domain::default_configuration(),
    };
    theme
        .validate()
        .map_err(|_| sqlx::Error::Protocol("invalid published theme".into()))?;
    let regional: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM inventory.delivery_areas)")
            .fetch_one(&mut *tx)
            .await?;
    let categories = catalog::categories(&mut tx).await?;
    let mut result = Snapshot {
        representation_version: String::new(),
        merchant: None,
        comparisons: vec![],
        schema_version: 1,
        discovery_attribution_enabled: app.deployment.allows_attribution(installation_id),
        structured_data: None,
        related_canonicals: Default::default(),
        family: vec![],
        variant_dimensions: vec![],
        parent_product: None,
        metadata: Default::default(),
        guides: vec![],
        images: Default::default(),
        installation_id,
        origin: app.deployment.approved_origin.clone().unwrap_or_default(),
        locale: settings.default_locale,
        site_name: settings.site_name,
        description: settings.description,
        path: request.path.clone(),
        kind: "missing",
        status: 404,
        location: None,
        canonical: None,
        robots: "noindex, nofollow",
        theme,
        categories,
        category_id: None,
        products: vec![],
        collections: Default::default(),
        product: None,
        content: None,
        page: request.page,
        has_next: false,
        availability: if regional {
            "Availability varies by delivery location. Choose a delivery location to confirm eligibility and stock."
        } else {
            "Stock and final availability are confirmed when you shop."
        },
    };
    let route = super::canonical::resolve(&mut tx, &request.path).await?;
    let resolved_path = route.path.as_deref().unwrap_or(&request.path);
    if ![200, 301].contains(&route.status) {
        result.status = route.status;
    } else if resolved_path == "/" {
        result.kind = "home";
        result.status = 200;
        result.products = catalog::products(&mut tx, None, request.page).await?;
        result.content = content(&mut tx, "home").await?;
    } else if let Some(key) = resolved_path.strip_prefix("/products/") {
        result.product = catalog::product(&mut tx, key).await?;
        if let Some(p) = &result.product {
            result.category_id = Some(p.category_id);
            result.kind = "product";
            result.status = 200;
            result.products = catalog::products(&mut tx, Some(p.category_id), 1).await?;
        }
    } else if let Some(key) = resolved_path.strip_prefix("/categories/") {
        result.category_id = result
            .categories
            .iter()
            .find(|c| c.slug == key || c.id.to_string() == key)
            .map(|c| c.id);
        if let Some(id) = result.category_id {
            result.kind = "category";
            result.status = 200;
            result.products = catalog::products(&mut tx, Some(id), request.page).await?;
        }
    } else if let Some(key) = resolved_path.strip_prefix("/pages/") {
        result.content = content(&mut tx, key).await?;
        if result.content.is_some() {
            result.kind = "content";
            result.status = 200;
        }
    }
    if result.status == 200 && route.status == 301 {
        result.status = 301;
        result.location = Some(if request.page > 1 {
            format!("{resolved_path}?page={}", request.page)
        } else {
            resolved_path.to_owned()
        });
    }
    result.has_next = result.products.len() > 24;
    result.products.truncate(24);
    if request.page > 1
        && (result.products.is_empty() || !["home", "category"].contains(&result.kind))
    {
        result.status = 404;
    }
    if [200, 301].contains(&result.status) {
        result.canonical = canonical_context
            .as_ref()
            .and_then(|context| context.resource(resolved_path, request.page));
    }
    if result.status == 200 {
        result.robots = policy.robots_meta;
    }
    if result.status == 200 {
        let sections = result
            .theme
            .global
            .values()
            .flatten()
            .chain(result.theme.pages.get(result.kind).into_iter().flatten());
        for section in sections.filter(|section| {
            section.enabled
                && [
                    "product_collection",
                    "featured_products",
                    "recommendations",
                    "best_sellers",
                ]
                .contains(&section.component.as_str())
        }) {
            let key = section
                .settings
                .get("category")
                .and_then(Value::as_str)
                .unwrap_or("");
            let category = if key.is_empty() {
                None
            } else {
                match key.parse::<Uuid>() {
                    Ok(id) => Some(id),
                    Err(_) => continue,
                }
            };
            let query = section
                .settings
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("");
            let limit = section
                .settings
                .get("limit")
                .and_then(Value::as_i64)
                .unwrap_or(8);
            let products = if section.component == "best_sellers" {
                let period = serde_json::from_value(
                    section
                        .settings
                        .get("period")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!("last_month")),
                )
                .map_err(|_| sqlx::Error::Protocol("Invalid bestseller period".into()))?;
                let ranking =
                    domain_orders::bestsellers::rank_on(&mut tx, period, chrono::Utc::now())
                        .await?;
                let mut products = Vec::new();
                for row in ranking.products {
                    if let Some(product) =
                        catalog::product(&mut tx, &row.product_id.to_string()).await?
                    {
                        products.push(product);
                        if products.len() >= limit.clamp(1, 24) as usize {
                            break;
                        }
                    }
                }
                products
            } else {
                catalog::collection(&mut tx, category, query, limit).await?
            };
            result.collections.insert(section.id.clone(), products);
        }
    }
    if result.status == 200 && ["product", "category"].contains(&result.kind) {
        let id = result.product.as_ref().map(|p| p.id).or(result.category_id);
        let id_path = id
            .map(|id| format!("/{}s/{id}", result.kind))
            .unwrap_or_default();
        result.guides=sqlx::query_as("SELECT '/pages/'||d.key AS path,r.title FROM cms.documents d JOIN LATERAL (SELECT * FROM cms.releases WHERE document_id=d.id AND NOT cancelled AND starts_at<=transaction_timestamp() ORDER BY starts_at DESC,created_at DESC LIMIT 1) l ON true JOIN cms.revisions r ON r.id=l.revision_id WHERE d.key<>'home' AND (l.ends_at IS NULL OR l.ends_at>transaction_timestamp()) AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.blocks) b WHERE b->>'link_url' IN ($1,$2)) ORDER BY d.key LIMIT 6").bind(resolved_path).bind(id_path).fetch_all(&mut *tx).await?;
    }
    if result.status == 200 {
        if let Some(product) = &result.product {
            if product.product_type == "configurable" {
                result.variant_dimensions=sqlx::query_scalar("SELECT d.label FROM catalog.product_configurations c JOIN attributes.definitions d ON d.attribute_code=ANY(c.configurable_attributes) WHERE c.parent_product_id=$1 AND d.entity_type='product' AND d.used_for_configurations AND COALESCE(d.metadata->>'status','active')='active' ORDER BY array_position(c.configurable_attributes,d.attribute_code)").bind(product.id).fetch_all(&mut *tx).await?;
            }
            result.family = catalog::family(&mut tx, product.id).await?;
            if let Some(parent) = product.parent_id {
                result.parent_product = catalog::product(&mut tx, &parent.to_string()).await?;
            }
        }
        let pricing = super::facts::Pricing::load(&mut tx).await?;
        for product in result
            .products
            .iter_mut()
            .chain(result.product.iter_mut())
            .chain(result.family.iter_mut())
            .chain(result.parent_product.iter_mut())
            .chain(result.collections.values_mut().flatten())
        {
            pricing.apply(product)?;
        }
    }
    if let Some(context) = &canonical_context {
        let (merchant, comparison_ids) =
            super::entity::project(&mut tx, context, &result.locale).await?;
        if let Some(content) = &result.content {
            if let Some(ids) = comparison_ids.get(&content.id) {
                let pricing = super::facts::Pricing::load(&mut tx).await?;
                for id in ids {
                    if let Some(mut p) = catalog::product(&mut tx, &id.to_string()).await? {
                        if super::canonical::resolve(&mut tx, &format!("/products/{}", p.slug))
                            .await?
                            .status
                            == 200
                        {
                            pricing.apply(&mut p)?;
                            result.comparisons.push(p);
                        }
                    }
                }
            }
        }
        result.merchant = merchant;
    }
    if let Some(content) = &mut result.content {
        for block in &mut content.blocks.0 {
            let link = block.link_url.clone();
            if link.starts_with('/') {
                let route = super::canonical::resolve(&mut tx, &link).await?;
                block.link_url = if [200, 301].contains(&route.status) {
                    route.path.unwrap_or_default()
                } else {
                    String::new()
                };
            } else if !link.is_empty()
                && !reqwest::Url::parse(&link).is_ok_and(|u| {
                    u.scheme() == "https"
                        && u.host_str().is_some()
                        && u.username().is_empty()
                        && u.password().is_none()
                })
            {
                block.link_url.clear();
            }
        }
    }
    let config: super::metadata::Settings = sqlx::query_as(super::metadata::SELECT)
        .fetch_one(&mut *tx)
        .await?;
    let config = preview.unwrap_or(config.configuration.0);
    result.images = super::images::for_snapshot(&mut tx, &result, config.social_image).await?;
    result.metadata = super::metadata::resolve(&result, &config);
    if let Some(context) = &canonical_context {
        for p in result.family.iter().chain(result.parent_product.iter()) {
            if let Some(identity) = context.resource(&format!("/products/{}", p.slug), 1) {
                result.related_canonicals.insert(p.id, identity);
            }
        }
    }
    result.structured_data = super::facts::structured_data(&result);
    result.representation_version = infra_auth::digest(
        &serde_json::to_string(&result)
            .map_err(|_| sqlx::Error::Protocol("publication serialization".into()))?,
    );
    tx.commit().await?;
    Ok(result)
}
async fn content(db: &mut sqlx::PgConnection, key: &str) -> Result<Option<Content>, sqlx::Error> {
    sqlx::query_as("SELECT d.id,r.id AS revision_id,l.starts_at AS updated_at,r.title,r.blocks FROM cms.documents d JOIN LATERAL (SELECT * FROM cms.releases WHERE document_id=d.id AND NOT cancelled AND starts_at<=transaction_timestamp() ORDER BY starts_at DESC,created_at DESC LIMIT 1) l ON true JOIN cms.revisions r ON r.id=l.revision_id WHERE d.key=$1 AND cms.market_content_available(d.id) AND (l.ends_at IS NULL OR l.ends_at>transaction_timestamp())")
        .bind(key).fetch_optional(db).await
}
