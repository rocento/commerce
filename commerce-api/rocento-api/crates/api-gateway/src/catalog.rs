use crate::identity::{self, ApiError};
use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{HeaderMap, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use domain_catalog::{self as catalog, Service};
use domain_search_client::{Client, Search, SearchProvider};
use infra_auth::Error;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;
type Result<T> = std::result::Result<T, ApiError>;
fn browsing_pin(
    h: &HeaderMap,
    full_catalog: bool,
    has_global_stock: bool,
) -> Result<Option<domain_inventory::areas::Pin>> {
    // Demo browsing is independent of delivery coverage; checkout still uses areas::pin.
    if full_catalog && !has_global_stock {
        Ok(None)
    } else {
        crate::areas::pin(h)
    }
}

#[test]
fn demo_catalog_ignores_location_but_normal_catalog_preserves_it() {
    let mut headers = HeaderMap::new();
    for (latitude, longitude) in [
        ("30.0444", "31.2357"),
        ("31.2001", "29.9187"),
        ("24.0889", "32.8998"),
    ] {
        headers.insert("x-delivery-latitude", latitude.parse().unwrap());
        headers.insert("x-delivery-longitude", longitude.parse().unwrap());
        assert!(matches!(browsing_pin(&headers, true, false), Ok(None)));
        assert!(matches!(browsing_pin(&headers, false, false), Ok(Some(_))));
        assert!(matches!(browsing_pin(&headers, true, true), Ok(Some(_))));
        assert!(matches!(crate::areas::pin(&headers), Ok(Some(_))));
    }
}
#[derive(Clone)]
pub struct App {
    pub identity: identity::App,
    pub catalog: Service,
    pub search: Client,
    pub media: infra_media::Store,
    pub analytics: crate::analytics::Client,
}
impl App {
    async fn authorize(&self, h: &HeaderMap, permission: &str) -> Result<()> {
        self.identity
            .admins
            .authenticate(identity::cookie(h, "admin_session"))
            .await?
            .require(permission)?;
        Ok(())
    }
}
pub fn router(app: App) -> Router {
    Router::new()
        .route("/v1/catalog/categories", get(categories))
        .route(
            "/v1/catalog/category-availability",
            get(category_availability),
        )
        .route("/v1/catalog/bestsellers", get(bestsellers))
        .route("/v1/catalog/relationships", get(relationships))
        .route("/v1/catalog/products/{id}", get(product))
        .route("/v1/catalog/media/{id}", get(media_info))
        .route("/v1/catalog/media/{id}/content", get(media_content))
        .route(
            "/v1/admin/catalog/media/{id}/publication",
            post(process_image),
        )
        .route("/v1/search", get(search))
        .route("/v1/analytics/events", post(analytics))
        .route(
            "/v1/admin/catalog/products",
            get(products).post(create_product),
        )
        .route(
            "/v1/admin/catalog/products/{id}",
            get(admin_product)
                .put(update_product)
                .delete(delete_product),
        )
        .route(
            "/v1/admin/catalog/categories",
            get(admin_categories).post(create_category),
        )
        .route(
            "/v1/admin/catalog/categories/{id}",
            put(update_category).delete(delete_category),
        )
        .route(
            "/v1/admin/catalog/attributes",
            get(attributes).post(create_attribute),
        )
        .route(
            "/v1/admin/catalog/attributes/{id}",
            put(update_attribute).delete(delete_attribute),
        )
        .route(
            "/v1/admin/catalog/media/{id}",
            put(update_media).delete(delete_media),
        )
        .route(
            "/v1/admin/catalog/media/folders",
            get(media_folders).post(create_media_folder),
        )
        .route(
            "/v1/admin/catalog/media/folders/{id}",
            put(update_media_folder).delete(delete_media_folder),
        )
        .route("/v1/admin/catalog/media/library", get(media_library))
        .route("/v1/admin/catalog/media/move", post(move_media))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .route(
            "/v1/admin/catalog/media",
            get(media_list)
                .post(upload)
                .layer(DefaultBodyLimit::max(6 * 1024 * 1024)),
        )
        .layer(middleware::from_fn_with_state(
            app.identity.clone(),
            identity::policy,
        ))
        .with_state(app)
}
async fn categories(State(a): State<App>, h: HeaderMap) -> Result<impl IntoResponse> {
    let categories = a.catalog.storefront_categories().await?;
    let image_ids: Vec<_> = categories
        .iter()
        .flat_map(|category| {
            [&category.thumbnail, &category.banner]
                .into_iter()
                .filter_map(|id| id.as_deref().and_then(|id| Uuid::parse_str(id).ok()))
        })
        .collect();
    let images =
        crate::public_commerce::images::for_ids(&mut *a.catalog.pool.acquire().await?, image_ids)
            .await?;
    let ids: Vec<_> = categories.iter().map(|category| category.id).collect();
    let translations: Vec<(Uuid, serde_json::Value)> = if let Some(locale) =
        h.get("x-storefront-locale").and_then(|v| v.to_str().ok())
    {
        sqlx::query_as("SELECT t.entity_id,t.fields FROM cms.catalog_translations t JOIN cms.translation_sources s ON s.entity_type=t.entity_type AND s.entity_id=t.entity_id JOIN cms.storefront_languages l ON l.locale=t.locale JOIN cms.language_settings settings ON settings.singleton WHERE t.entity_type='category' AND t.entity_id=ANY($1) AND t.locale=$2 AND t.locale<>settings.source_locale AND t.reviewed AND t.source=s.source")
                .bind(&ids).bind(locale).fetch_all(&a.catalog.pool).await?
    } else {
        Vec::new()
    };
    let categories: Vec<_> = categories
        .iter()
        .map(|category| {
            let mut value = json!(category);
            value["images"] = json!(referenced_images(
                &images,
                [&category.thumbnail, &category.banner]
                    .into_iter()
                    .filter_map(|id| id.as_deref().and_then(|id| Uuid::parse_str(id).ok()))
            ));
            if let Some((_, fields)) = translations.iter().find(|(id, _)| *id == category.id) {
                apply_product_translation(&mut value, fields);
            }
            value
        })
        .collect();
    Ok(([("cache-control", "private, no-store")], Json(categories)))
}
async fn admin_categories(State(a): State<App>, h: HeaderMap) -> Result<impl IntoResponse> {
    a.authorize(&h, "catalog.read").await?;
    Ok(Json(a.catalog.categories().await?))
}
async fn admin_product(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse> {
    a.authorize(&h, "catalog.read").await?;
    Ok(Json(a.catalog.product(id).await?))
}
pub(crate) async fn priced_products(
    a: &identity::App,
    h: &HeaderMap,
    products: &[catalog::Product],
) -> Result<Vec<serde_json::Value>> {
    let customer = crate::cart::customer(a, h).await?;
    let ids: Vec<_> = products.iter().map(|p| p.id).collect();
    let images = crate::public_commerce::images::for_ids(
        &mut *a.customers.pool.acquire().await?,
        products
            .iter()
            .flat_map(product_image_ids)
            .collect::<Vec<_>>(),
    )
    .await?;
    let offers =
        domain_pricing_promotions::recommendations::for_products(&a.customers.pool, customer, &ids)
            .await?;
    let effective: Vec<(Uuid, i64, rust_decimal::Decimal, String, bool)> = sqlx::query_as(
        "SELECT id,entity_id,price,currency,active FROM catalog.storefront_products WHERE id=ANY($1)",
    )
    .bind(&ids)
    .fetch_all(&a.customers.pool)
    .await?;
    // Localize only reviewed copy whose source still matches the catalog.
    // Prices, identifiers, stock, and stable option values remain shared.
    let locale = h.get("x-storefront-locale").and_then(|v| v.to_str().ok());
    let translations: Vec<(Uuid, serde_json::Value)> = if let Some(locale) = locale {
        sqlx::query_as("SELECT t.entity_id,t.fields FROM cms.catalog_translations t JOIN cms.translation_sources s ON s.entity_type=t.entity_type AND s.entity_id=t.entity_id JOIN cms.storefront_languages l ON l.locale=t.locale JOIN cms.language_settings settings ON settings.singleton WHERE t.entity_type='product' AND t.entity_id=ANY($1) AND t.locale=$2 AND t.locale<>settings.source_locale AND t.reviewed AND t.source=s.source")
            .bind(&ids).bind(locale).fetch_all(&a.customers.pool).await?
    } else {
        Vec::new()
    };
    Ok(products
        .iter()
        .filter_map(|p| {
            let (_, entity_id, price, currency, active) = effective.iter().find(|v| v.0 == p.id)?;
            if !active {
                return None;
            }
            let mut value = json!(p);
            value["entity_id"] = json!(entity_id);
            value["images"] = json!(referenced_images(&images, product_image_ids(p)));
            if let Some((_, fields)) = translations.iter().find(|(id, _)| *id == p.id) {
                apply_product_translation(&mut value, fields);
            }
            value["price"] = json!(price.to_string());
            value["currency"] = json!(currency);
            if let Some(offer) = offers.iter().find(|o| {
                o.product_id == p.id && o.original_price == *price && o.currency == *currency
            }) {
                value["catalog_offer"] = json!(offer);
            }
            Some(value)
        })
        .collect())
}
fn product_image_ids(product: &catalog::Product) -> impl Iterator<Item = Uuid> + '_ {
    product.media_ids.iter().copied().chain(
        product
            .attributes
            .get("demo-thumbnail")
            .and_then(|id| id.as_str())
            .and_then(|id| Uuid::parse_str(id).ok()),
    )
}
fn referenced_images(
    images: &std::collections::BTreeMap<Uuid, crate::public_commerce::images::PublicImage>,
    ids: impl IntoIterator<Item = Uuid>,
) -> std::collections::BTreeMap<Uuid, &crate::public_commerce::images::PublicImage> {
    ids.into_iter()
        .filter_map(|id| images.get(&id).map(|image| (id, image)))
        .collect()
}
#[test]
fn shopper_image_projection_only_advertises_referenced_manifests() {
    use crate::public_commerce::images::{PublicImage, Variant};
    let selected = Uuid::new_v4();
    let unrelated = Uuid::new_v4();
    let unprocessed = Uuid::new_v4();
    let images = [selected, unrelated]
        .into_iter()
        .map(|id| {
            (
                id,
                PublicImage {
                    id,
                    alt: "Ring".into(),
                    width: 1024,
                    height: 1024,
                    variants: sqlx::types::Json(vec![Variant {
                        width: 480,
                        height: 480,
                    }]),
                },
            )
        })
        .collect();
    let projection = json!(referenced_images(
        &images,
        [selected, unprocessed, selected]
    ));
    assert_eq!(projection.as_object().unwrap().len(), 1);
    assert_eq!(
        projection[selected.to_string()]["variants"][0]["width"],
        480
    );
    assert!(projection.get(unrelated.to_string()).is_none());
    assert!(projection.get(unprocessed.to_string()).is_none());
}
fn apply_product_translation(product: &mut serde_json::Value, fields: &serde_json::Value) {
    let Some(fields) = fields.as_object() else {
        return;
    };
    for (key, value) in fields {
        let Some(text) = value.as_str().filter(|s| !s.trim().is_empty()) else {
            continue;
        };
        if key == "name" || key == "description" {
            product[key] = json!(text);
        } else if let Some(code) = key.strip_prefix("attribute.") {
            // Do not expose hidden attributes through a translation.
            if product["attributes"]
                .get(code)
                .is_some_and(|v| v.is_string())
            {
                product["attributes"][code] = json!(text);
            }
        }
    }
}

async fn product(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<([(&'static str, &'static str); 1], Json<serde_json::Value>)> {
    let mut p = a.catalog.storefront_product(id).await?;
    let inventory = &a.identity.cart.inventory;
    let (area, stocks) = browsing_scope(&a, &h).await?;
    p.in_stock = inventory
        .browsing_available_many(&[id], &stocks, area)
        .await?
        .get(&id)
        .copied()
        .unwrap_or(0)
        > 0;
    if !p.active {
        return Err(Error::NotFound.into());
    }
    a.catalog.visible_attributes(&mut p).await?;
    let priced = priced_products(&a.identity, &h, &[p]).await?;
    Ok((
        [("cache-control", "private, no-store")],
        Json(priced.into_iter().next().ok_or(Error::NotFound)?),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BestsellerQuery {
    #[serde(default = "default_bestseller_period")]
    period: domain_orders::bestsellers::Period,
    #[serde(default = "default_bestseller_limit")]
    limit: usize,
}
fn default_bestseller_period() -> domain_orders::bestsellers::Period {
    domain_orders::bestsellers::Period::LastMonth
}
fn default_bestseller_limit() -> usize {
    8
}
async fn bestsellers(
    State(a): State<App>,
    h: HeaderMap,
    Query(q): Query<BestsellerQuery>,
) -> Result<impl IntoResponse> {
    if !(1..=24).contains(&q.limit) {
        return Err(catalog::invalid("Choose between 1 and 24 best sellers").into());
    }
    let delivery = a
        .identity
        .cart
        .inventory
        .delivery(crate::areas::pin(&h)?)
        .await?;
    let ranking = domain_orders::bestsellers::rank_for_area(
        &a.catalog.pool,
        q.period,
        chrono::Utc::now(),
        delivery.area_id,
    )
    .await?;
    let mut products = Vec::new();
    for ranked in &ranking.products {
        if !a.catalog.storefront_visible(ranked.product_id).await? {
            continue;
        }
        // Reuse the shopper projection, including visible attributes and delivery checks.
        let (_, Json(p)) = product(State(a.clone()), h.clone(), Path(ranked.product_id)).await?;
        products.push(p);
        if products.len() == q.limit {
            break;
        }
    }
    Ok((
        [("cache-control", "private, no-store")],
        Json(json!({
            "products": products, "period": q.period, "start": ranking.start, "end": ranking.end,
            "timezone": "UTC", "metric": "completed_order_units", "ranked_limit": 50,
            "scope": ranking.scope
        })),
    ))
}
async fn search(
    State(a): State<App>,
    h: HeaderMap,
    Query(mut q): Query<Search>,
) -> Result<impl IntoResponse> {
    if let Some(code) = &q.sort_by {
        let definitions = domain_attributes::Service {
            pool: a.catalog.pool.clone(),
        }
        .list("product")
        .await?;
        if !matches!(code.as_str(), "price" | "name")
            && !definitions.iter().any(|d| {
                d.attribute_code == *code
                    && d.metadata.active()
                    && d.is_visible_on_front
                    && d.metadata.sortable
            })
        {
            return Err(catalog::invalid("Attribute is not available for sorting").into());
        }
    }
    if let Some(raw) = &q.attribute_filters {
        let filters: std::collections::BTreeMap<String, serde_json::Value> =
            serde_json::from_str(raw).map_err(|_| catalog::invalid("Invalid attribute filters"))?;
        let defs = domain_attributes::Service {
            pool: a.catalog.pool.clone(),
        }
        .list("product")
        .await?;
        domain_attributes::schema::validate_filters(&defs, &filters, false)?;
    }
    let inventory = &a.identity.cart.inventory;
    let (area, stocks) = browsing_scope(&a, &h).await?;
    q.stock_ids = Some(stocks.clone());
    if area.is_some() {
        // Demo city browsing includes local and global stock.
        if std::env::var("DEMO_CITY_CATALOG").as_deref() == Ok("true") {
            q.in_stock = Some(true);
        }
    }
    let mut result = a.search.search(q).await?;
    for hits in result.hits.chunks_mut(20) {
        let ids: Vec<_> = hits.iter().map(|p| p.id).collect();
        let available = inventory
            .browsing_available_many(&ids, &stocks, area)
            .await?;
        for p in hits {
            p.in_stock = available.get(&p.id).copied().unwrap_or(0) > 0;
        }
    }
    let priced = priced_products(&a.identity, &h, &result.hits).await?;
    let mut result = json!(result);
    result["hits"] = json!(priced);
    Ok(([("cache-control", "private, no-store")], Json(result)))
}
async fn browsing_scope(a: &App, h: &HeaderMap) -> Result<(Option<Uuid>, Vec<Uuid>)> {
    let full_catalog = std::env::var("DEMO_FULL_CATALOG").as_deref() == Ok("true");
    // Once a global pool exists, its quantities govern worldwide availability.
    // Keep the legacy demo fallback only for installations without global stock.
    let has_global_stock = if full_catalog {
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM inventory.stocks WHERE is_global)")
            .fetch_one(&a.catalog.pool)
            .await
            .map_err(Error::from)?
    } else {
        false
    };
    let pin = browsing_pin(h, full_catalog, has_global_stock)?;
    let inventory = &a.identity.cart.inventory;
    let delivery = inventory.delivery(pin).await?;
    let stocks = inventory
        .browsing_stocks(delivery.area_id, pin.is_none() || !delivery.configured)
        .await?;
    Ok((delivery.area_id, stocks))
}
async fn category_availability(State(a): State<App>, h: HeaderMap) -> Result<impl IntoResponse> {
    let (_, stocks) = browsing_scope(&a, &h).await?;
    let categories = a
        .catalog
        .categories()
        .await?
        .into_iter()
        .map(|c| c.id)
        .collect::<Vec<_>>();
    let counts = a.search.category_counts(&categories, Some(stocks)).await?;
    Ok(([("cache-control", "private, no-store")], Json(counts)))
}
#[derive(Default, Deserialize)]
pub struct Page {
    offset: Option<i64>,
}
async fn products(
    State(a): State<App>,
    h: HeaderMap,
    Query(q): Query<Page>,
) -> Result<impl IntoResponse> {
    a.authorize(&h, "catalog.read").await?;
    let offset = q.offset.unwrap_or(0);
    if !(0..=1000000).contains(&offset) {
        return Err(catalog::invalid("Invalid offset").into());
    }
    Ok(Json(a.catalog.products(offset).await?))
}
async fn attributes(State(a): State<App>, h: HeaderMap) -> Result<impl IntoResponse> {
    a.authorize(&h, "catalog.read").await?;
    Ok(Json(a.catalog.attributes().await?))
}
macro_rules! crud {($create:ident,$update:ident,$delete:ident,$input:ty,$save:ident,$remove:ident)=>{
 async fn $create(State(a):State<App>,h:HeaderMap,Json(i):Json<$input>)->Result<impl IntoResponse>{a.authorize(&h,"catalog.write").await?;Ok((StatusCode::CREATED,Json(a.catalog.$save(None,i).await?)))}
 async fn $update(State(a):State<App>,h:HeaderMap,Path(id):Path<Uuid>,Json(i):Json<$input>)->Result<impl IntoResponse>{a.authorize(&h,"catalog.write").await?;Ok(Json(a.catalog.$save(Some(id),i).await?))}
 async fn $delete(State(a):State<App>,h:HeaderMap,Path(id):Path<Uuid>)->Result<impl IntoResponse>{a.authorize(&h,"catalog.write").await?;a.catalog.$remove(id).await?;Ok(Json(json!({"status":"ok"})))}
}}
crud!(
    create_product,
    update_product,
    delete_product,
    catalog::ProductInput,
    save_product,
    delete_product
);
crud!(
    create_category,
    update_category,
    delete_category,
    catalog::CategoryInput,
    save_category,
    delete_category
);
crud!(
    create_attribute,
    update_attribute,
    delete_attribute,
    catalog::AttributeInput,
    save_attribute,
    delete_attribute
);
async fn media_list(State(a): State<App>, h: HeaderMap) -> Result<impl IntoResponse> {
    a.authorize(&h, "catalog.read").await?;
    Ok(Json(a.catalog.media().await?))
}
async fn media_info(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse> {
    let public =
        crate::public_commerce::images::is_public(&mut *a.catalog.pool.acquire().await?, id)
            .await?;
    if !public {
        a.authorize(&h, "catalog.read").await?;
    }
    let mut media = a.catalog.media_by_id(id).await?;
    if public {
        media.object_key.clear();
    }
    Ok(([("cache-control", "no-store")], Json(media)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImageQuery {
    width: Option<u32>,
}
async fn media_content(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<ImageQuery>,
) -> Result<Response> {
    let public =
        crate::public_commerce::images::is_public(&mut *a.catalog.pool.acquire().await?, id)
            .await?;
    if !public {
        a.authorize(&h, "catalog.read").await?;
    }
    let m = a.catalog.media_by_id(id).await?;
    let (key, content_type) = if let Some(width) = q.width {
        if !(1..=12000).contains(&width) {
            return Err(Error::NotFound.into());
        }
        let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.publication_images WHERE media_id=$1 AND variants @> $2)").bind(id).bind(json!([{"width":width}])).fetch_one(&a.catalog.pool).await?;
        if !exists {
            return Err(Error::NotFound.into());
        }
        (
            format!("catalog/{id}/publication-{width}.webp"),
            "image/webp".to_string(),
        )
    } else {
        (m.object_key, m.content_type)
    };
    let bytes = a.media.get(&key).await.map_err(provider)?;
    Ok((
        [
            ("content-type", content_type),
            ("cache-control", "no-store".into()),
            ("x-content-type-options", "nosniff".into()),
        ],
        bytes,
    )
        .into_response())
}
fn provider(e: impl std::fmt::Display) -> ApiError {
    tracing::error!(error=%e,"catalog provider failed");
    Error::Internal.into()
}
async fn upload(
    State(a): State<App>,
    h: HeaderMap,
    mut multipart: Multipart,
) -> Result<impl IntoResponse> {
    a.authorize(&h, "catalog.write").await?;
    let mut image = None;
    let mut alt = None;
    let mut folder_id = None;
    let mut file_name = String::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| catalog::invalid("Invalid multipart upload"))?
    {
        match field.name() {
            Some("folder_id") => {
                let value = field
                    .text()
                    .await
                    .map_err(|_| catalog::invalid("Invalid upload folder"))?;
                folder_id = if value.is_empty() {
                    None
                } else {
                    Some(
                        Uuid::parse_str(&value)
                            .map_err(|_| catalog::invalid("Invalid upload folder"))?,
                    )
                };
            }
            Some("alt") => {
                alt = Some(
                    field
                        .text()
                        .await
                        .map_err(|_| catalog::invalid("Invalid image description"))?,
                );
            }
            Some("file") => {
                file_name = field.file_name().unwrap_or("").to_owned();
                if image.is_some() {
                    return Err(catalog::invalid("Upload one image at a time").into());
                }
                image = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|_| catalog::invalid("Invalid image file"))?,
                );
            }
            _ => return Err(catalog::invalid("Unexpected upload field").into()),
        }
    }
    let bytes = image.ok_or_else(|| catalog::invalid("Image file required"))?;
    if bytes.len() > 5 * 1024 * 1024 {
        return Err(catalog::invalid("Images must be at most 5 MB").into());
    }
    let content_type = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        return Err(catalog::invalid("Use a PNG, JPEG or WebP image").into());
    };
    let alt = alt.unwrap_or_default();
    if alt.trim().is_empty() || alt.len() > 300 {
        return Err(catalog::invalid("Image description is required (max 300 characters)").into());
    }
    let id = Uuid::new_v4();
    let key = format!("catalog/{id}");
    a.media
        .put(&key, &bytes, content_type)
        .await
        .map_err(provider)?;
    let media = catalog::Media {
        id,
        entity_id: 0,
        content_type: content_type.into(),
        alt,
        object_key: key.clone(),
        size_bytes: bytes.len() as i64,
    };
    match a
        .catalog
        .add_media_to_folder(media, folder_id, file_name)
        .await
    {
        Ok(media) => {
            if let Err(error) = crate::public_commerce::images::store_derived(
                &a.catalog.pool,
                &a.media,
                id,
                bytes.to_vec(),
            )
            .await
            {
                tracing::warn!(media_id=%id,error=%error,"Image rendition unavailable; original retained for retry");
            }
            Ok((StatusCode::CREATED, Json(media)))
        }
        Err(e) => {
            let _ = a.media.delete(&key).await;
            Err(e.into())
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MediaInput {
    alt: String,
}
async fn update_media(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<MediaInput>,
) -> Result<impl IntoResponse> {
    a.authorize(&h, "catalog.write").await?;
    Ok(Json(a.catalog.update_media(id, i.alt).await?))
}
async fn delete_media(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse> {
    a.authorize(&h, "catalog.write").await?;
    let variants: Option<serde_json::Value> =
        sqlx::query_scalar("SELECT variants FROM catalog.publication_images WHERE media_id=$1")
            .bind(id)
            .fetch_optional(&a.catalog.pool)
            .await?;
    let mut widths = std::collections::BTreeSet::from([480u32, 960u32]);
    if let Some(variants) = variants.and_then(|v| v.as_array().cloned()) {
        widths.extend(
            variants
                .iter()
                .filter_map(|v| v["width"].as_u64())
                .filter(|w| (1..=12000).contains(w))
                .map(|w| w as u32),
        );
    }
    let m = a.catalog.delete_media(id).await?;
    if let Err(e) = a.media.delete(&m.object_key).await {
        tracing::warn!(error=%e,key=%m.object_key,"unreferenced media object requires cleanup");
    }
    for width in widths {
        if let Err(e) = a
            .media
            .delete(&format!("catalog/{id}/publication-{width}.webp"))
            .await
        {
            tracing::warn!(error=%e,media_id=%id,"derived media object requires cleanup");
        }
    }
    Ok(Json(json!({"status":"ok"})))
}
async fn analytics(
    State(a): State<App>,
    headers: HeaderMap,
    Json(i): Json<crate::analytics::Event>,
) -> Result<impl IntoResponse> {
    if a.identity.engagement_isolated {
        crate::customer_journey::enqueue_browser(&a.identity, &headers, i).await?;
        return Ok((StatusCode::ACCEPTED, Json(json!({"status":"queued"}))));
    }
    crate::customer_journey::record_browser(&a.identity, &headers, &i).await?;
    a.analytics.ingest(i).await.map_err(ApiError::from)?;
    Ok((StatusCode::CREATED, Json(json!({"status":"ok"}))))
}

async fn media_folders(State(a): State<App>, h: HeaderMap) -> Result<impl IntoResponse> {
    a.authorize(&h, "catalog.read").await?;
    Ok(Json(a.catalog.media_folders().await?))
}
async fn create_media_folder(
    State(a): State<App>,
    h: HeaderMap,
    Json(input): Json<catalog::media_library::FolderInput>,
) -> Result<impl IntoResponse> {
    a.authorize(&h, "catalog.write").await?;
    Ok((
        StatusCode::CREATED,
        Json(a.catalog.save_media_folder(None, input).await?),
    ))
}
async fn update_media_folder(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<catalog::media_library::FolderInput>,
) -> Result<impl IntoResponse> {
    a.authorize(&h, "catalog.write").await?;
    Ok(Json(a.catalog.save_media_folder(Some(id), input).await?))
}
async fn delete_media_folder(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse> {
    a.authorize(&h, "catalog.write").await?;
    a.catalog.delete_media_folder(id).await?;
    Ok(Json(json!({"status":"ok"})))
}
async fn media_library(
    State(a): State<App>,
    h: HeaderMap,
    Query(query): Query<catalog::media_library::LibraryQuery>,
) -> Result<impl IntoResponse> {
    a.authorize(&h, "catalog.read").await?;
    Ok(Json(a.catalog.media_library(query).await?))
}
async fn move_media(
    State(a): State<App>,
    h: HeaderMap,
    Json(input): Json<catalog::media_library::MoveMediaInput>,
) -> Result<impl IntoResponse> {
    a.authorize(&h, "catalog.write").await?;
    a.catalog.move_media(input).await?;
    Ok(Json(json!({"status":"ok"})))
}

/// Explicit retry/backfill for media uploaded before dimensioned publication existed.
async fn process_image(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse> {
    a.authorize(&h, "catalog.write").await?;
    let media = a.catalog.media_by_id(id).await?;
    if media.size_bytes > 5 * 1024 * 1024 {
        return Err(catalog::invalid("Images must be at most 5 MB").into());
    }
    let bytes = a.media.get(&media.object_key).await.map_err(provider)?;
    if bytes.len() > 5 * 1024 * 1024 {
        return Err(catalog::invalid("Images must be at most 5 MB").into());
    }
    crate::public_commerce::images::store_derived(&a.catalog.pool, &a.media, id, bytes)
        .await
        .map_err(|e| catalog::invalid(&e))?;
    Ok(Json(json!({"status":"processed"})))
}

#[cfg(test)]
mod product_translation_tests {
    use super::*;
    #[test]
    fn translated_copy_preserves_commerce_and_hidden_fields() {
        let mut product = json!({"name":"Dates","description":"Original","price":"5.00","sku":"DATES","attributes":{"short_description":"Sweet","group":["fruit"]}});
        apply_product_translation(
            &mut product,
            &json!({"name":"تمر","description":" ","price":"0","attribute.short_description":"حلو","attribute.hidden":"secret","attribute.group":"فاكهة"}),
        );
        assert_eq!(product["name"], "تمر");
        assert_eq!(product["description"], "Original");
        assert_eq!(product["price"], "5.00");
        assert_eq!(product["sku"], "DATES");
        assert_eq!(product["attributes"]["short_description"], "حلو");
        assert_eq!(product["attributes"]["group"], json!(["fruit"]));
        assert!(product["attributes"].get("hidden").is_none());
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RelationshipQuery {
    sources: String,
    kind: catalog::relationships::Kind,
}
async fn relationships(
    State(a): State<App>,
    h: HeaderMap,
    Query(q): Query<RelationshipQuery>,
) -> Result<impl IntoResponse> {
    let sources: Vec<Uuid> = q
        .sources
        .split(',')
        .map(|s| {
            s.parse()
                .map_err(|_| catalog::invalid("Invalid source product"))
        })
        .collect::<std::result::Result<_, _>>()?;
    if sources.is_empty() || sources.len() > 50 {
        return Err(catalog::invalid("Provide 1–50 source products").into());
    }
    let work = async {
        let rules = a.catalog.relationship_rules().await?;
        let ids: Vec<Uuid> = rules
            .iter()
            .filter(|r| {
                r.definition
                    .eligible(&q.kind, chrono::Utc::now(), &r.definition.segment_ids)
            })
            .flat_map(|r| r.definition.segment_ids.clone())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        let segments = if ids.is_empty() {
            Vec::new()
        } else if let Some(customer) = crate::cart::customer(&a.identity, &h).await? {
            domain_customers::segments::Service {
                pool: a.catalog.pool.clone(),
            }
            .matching_ids(customer, &ids)
            .await?
        } else {
            Vec::new()
        };
        let mut candidates = a
            .catalog
            .relationship_candidates(&sources, q.kind, &segments)
            .await?;
        let (area, stocks) = browsing_scope(&a, &h).await?;
        let ids: Vec<_> = candidates.iter().map(|p| p.id).collect();
        let mut available = std::collections::HashMap::new();
        for batch in ids.chunks(20) {
            available.extend(
                a.identity
                    .cart
                    .inventory
                    .browsing_available_many(batch, &stocks, area)
                    .await?,
            );
        }
        candidates.retain(|p| available.get(&p.id).copied().unwrap_or(0) > 0);
        candidates.truncate(20);
        for p in &mut candidates {
            p.in_stock = true;
            a.catalog.visible_attributes(p).await?;
        }
        priced_products(&a.identity, &h, &candidates).await
    };
    let products = tokio::time::timeout(std::time::Duration::from_secs(5), work)
        .await
        .map_err(|_| ApiError::from(Error::Busy))??;
    Ok(([("cache-control", "private, no-store")], Json(products)))
}
