//! Read-only, membership-scoped preview of a trusted storefront's public catalog.
use super::*;
use futures_util::StreamExt;
use std::{collections::BTreeMap, time::Duration};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CatalogQuery {
    locale: String,
    collection: Option<String>,
    q: Option<String>,
    sort: Option<String>,
    in_stock: Option<bool>,
    min_price: Option<String>,
    max_price: Option<String>,
    offset: Option<u32>,
    attribute_filters: Option<String>,
}
fn origin(mapping: &str, merchant: Uuid) -> std::result::Result<reqwest::Url, Error> {
    let mappings: BTreeMap<Uuid, String> =
        serde_json::from_str(mapping).map_err(|_| Error::Storage)?;
    let value = mappings
        .get(&merchant)
        .ok_or_else(|| invalid("/merchant", "CATALOG_NOT_CONNECTED"))?;
    let url = reqwest::Url::parse(value).map_err(|_| Error::Storage)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::Storage);
    }
    Ok(url)
}
async fn fetch(
    client: &reqwest::Client,
    url: reqwest::Url,
    locale: &str,
) -> std::result::Result<Value, Error> {
    fetch_request(client.get(url).header("x-storefront-locale", locale), false).await
}
async fn fetch_request(
    request: reqwest::RequestBuilder,
    product_request: bool,
) -> std::result::Result<Value, Error> {
    let response = request.send().await.map_err(|_| Error::Storage)?;
    if product_request && response.status() == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
        return Err(invalid("/delivery", "DELIVERY_LOCATION_UNAVAILABLE"));
    }
    if product_request && response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(invalid("/product", "PRODUCT_NOT_FOUND"));
    }
    if !response.status().is_success() || response.content_length().is_some_and(|n| n > 2_000_000) {
        return Err(Error::Storage);
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| Error::Storage)?;
        if bytes.len() + chunk.len() > 2_000_000 {
            return Err(Error::Storage);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::Storage)
}
fn image(origin: &reqwest::Url, id: Option<&str>) -> Option<String> {
    let id = Uuid::parse_str(id?).ok()?;
    Some(
        origin
            .join(&format!("api/v1/catalog/media/{id}/content?width=480"))
            .ok()?
            .to_string(),
    )
}
fn category_id(categories: &[Value], collection: &str) -> Option<String> {
    categories
        .iter()
        .find(|c| c["id"].as_str() == Some(collection) || c["slug"].as_str() == Some(collection))?
        ["id"]
        .as_str()
        .map(str::to_owned)
}
fn products(origin: &reqwest::Url, values: &[Value], limit: usize) -> Vec<Value> {
    values.iter().filter(|p| p["active"].as_bool() != Some(false)).take(limit).map(|p| {
        let offer = &p["catalog_offer"];
        let base = p["price"].as_str().unwrap_or("");
        let discounted = offer["discounted_price"].as_str().unwrap_or("");
        let amounts = (base.parse::<rust_decimal::Decimal>(), offer["original_price"].as_str().unwrap_or("").parse::<rust_decimal::Decimal>(), discounted.parse::<rust_decimal::Decimal>());
        let valid_offer = matches!(amounts, (Ok(base), Ok(original), Ok(discount)) if base == original && discount >= rust_decimal::Decimal::ZERO && discount < base)
            && offer["product_id"] == p["id"] && offer["currency"] == p["currency"];
        let price = if valid_offer { discounted } else { base };
        let id = p["attributes"]["demo-thumbnail"].as_str().or_else(|| p["media_ids"].as_array()?.first()?.as_str());
        json!({"id":p["id"],"name":p["name"],"description":p["description"].as_str(),"price":price,"originalPrice":if valid_offer {Some(base)} else {None},"currency":p["currency"],"unit":p["unit"],"productType":p["product_type"].as_str().unwrap_or("simple"),"parentId":p["parent_id"].as_str(),"inStock":p["in_stock"],"imageUrl":image(origin,id)})
    }).collect()
}
fn validate_query(q: &CatalogQuery) -> std::result::Result<(), Error> {
    let invalid_query = || invalid("/query", "INVALID_CATALOG_QUERY");
    if !matches!(q.locale.as_str(), "en" | "ar")
        || q.collection.as_ref().is_some_and(|s| {
            s.is_empty()
                || s.len() > 128
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        || q.q
            .as_ref()
            .is_some_and(|s| s.chars().count() > 120 || s.chars().any(char::is_control))
        || q.offset.is_some_and(|offset| offset > 9999)
        || q.sort.as_ref().is_some_and(|s| {
            !matches!(
                s.as_str(),
                "relevance" | "price_asc" | "price_desc" | "name_asc" | "name_desc"
            ) && !s.split_once(':').is_some_and(|(code, order)| {
                !code.is_empty()
                    && code.len() <= 128
                    && code
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                    && matches!(order, "asc" | "desc")
            })
        })
    {
        return Err(invalid_query());
    }
    if let Some(raw) = &q.attribute_filters {
        if raw.len() > 8192 || !serde_json::from_str::<Value>(raw).is_ok_and(|v| v.is_object()) {
            return Err(invalid_query());
        }
    }
    let price =
        |raw: &Option<String>| -> std::result::Result<Option<rust_decimal::Decimal>, Error> {
            raw.as_ref()
                .map(|s| {
                    if s.len() > 16 {
                        return Err(invalid_query());
                    }
                    let value = s
                        .parse::<rust_decimal::Decimal>()
                        .map_err(|_| invalid_query())?;
                    if value < rust_decimal::Decimal::ZERO {
                        return Err(invalid_query());
                    }
                    Ok(value)
                })
                .transpose()
        };
    if matches!((price(&q.min_price)?, price(&q.max_price)?), (Some(min),Some(max)) if min > max) {
        return Err(invalid_query());
    }
    Ok(())
}
fn append_search_query(url: &mut reqwest::Url, q: &CatalogQuery) {
    let mut pairs = url.query_pairs_mut();
    pairs.append_pair("q", q.q.as_deref().unwrap_or("").trim());
    if let Some(offset) = q.offset {
        pairs.append_pair("offset", &offset.to_string());
    }
    if let Some(stock) = q.in_stock {
        pairs.append_pair("in_stock", if stock { "true" } else { "false" });
    }
    if let Some(price) = &q.min_price {
        pairs.append_pair("min_price", price);
    }
    if let Some(price) = &q.max_price {
        pairs.append_pair("max_price", price);
    }
    if let Some(attributes) = &q.attribute_filters {
        pairs.append_pair("attribute_filters", attributes);
    }
    match q.sort.as_deref() {
        Some("price_asc") => {
            pairs
                .append_pair("sort_by", "price")
                .append_pair("sort_order", "asc");
        }
        Some("price_desc") => {
            pairs
                .append_pair("sort_by", "price")
                .append_pair("sort_order", "desc");
        }
        Some("name_asc") => {
            pairs
                .append_pair("sort_by", "name")
                .append_pair("sort_order", "asc");
        }
        Some("name_desc") => {
            pairs
                .append_pair("sort_by", "name")
                .append_pair("sort_order", "desc");
        }
        Some(sort) if sort.contains(':') => {
            if let Some((code, order)) = sort.split_once(':') {
                pairs
                    .append_pair("sort_by", code)
                    .append_pair("sort_order", order);
            }
        }
        _ => {}
    }
}
// A feed references one enabled product section of this merchant's trusted storefront.
// Source URLs, query shapes and limits are never supplied by the browser.
fn demo_feed(
    theme: &Value,
    section_id: &str,
    origin: &reqwest::Url,
) -> std::result::Result<(reqwest::Url, usize, bool), Error> {
    let section = theme["configuration"]["pages"]["home"]
        .as_array()
        .and_then(|sections| {
            sections
                .iter()
                .find(|s| s["id"].as_str() == Some(section_id) && s["enabled"] == true)
        })
        .ok_or_else(|| invalid("/collection", "COLLECTION_NOT_FOUND"))?;
    let settings = &section["settings"];
    let limit = settings["limit"].as_u64().unwrap_or(8).clamp(1, 24) as usize;
    let bestsellers = section["component"] == "best_sellers";
    let mut url = origin
        .join(if bestsellers {
            "api/v1/catalog/bestsellers"
        } else {
            "api/v1/search"
        })
        .map_err(|_| Error::Storage)?;
    if bestsellers {
        let period = settings["period"].as_str().unwrap_or("last_month");
        if !["today", "last_week", "last_month", "last_year"].contains(&period) {
            return Err(Error::Storage);
        }
        url.query_pairs_mut()
            .append_pair("period", period)
            .append_pair("limit", &limit.to_string());
    } else {
        if !matches!(
            section["component"].as_str(),
            Some("featured_products" | "product_collection" | "recommendations")
        ) {
            return Err(invalid("/collection", "COLLECTION_NOT_FOUND"));
        }
        url.query_pairs_mut()
            .append_pair("q", settings["query"].as_str().unwrap_or(""));
        if let Some(category) = settings["category"].as_str().filter(|s| !s.is_empty()) {
            url.query_pairs_mut().append_pair("category_id", category);
        }
    }
    Ok((url, limit, bestsellers))
}
fn feed_choices(theme: &Value) -> Vec<Value> {
    theme["configuration"]["pages"]["home"].as_array().map(|sections| sections.iter().filter(|s| s["enabled"] == true && matches!(s["component"].as_str(), Some("featured_products" | "product_collection" | "recommendations" | "best_sellers"))).map(|s| json!({"id":format!("demo-feed-{}", s["id"].as_str().unwrap_or("")),"name":s["settings"]["heading"]})).collect()).unwrap_or_default()
}
pub(super) async fn preview(
    State(a): State<MobileApp>,
    Path(merchant): Path<Uuid>,
    Query(q): Query<CatalogQuery>,
    h: HeaderMap,
) -> ApiResult<Json<Value>> {
    let actor = a.actor(&h).await?;
    a.service
        .authorize(merchant, actor, domain_mobile::service::Access::Read)
        .await?;
    validate_query(&q)?;
    // Never accept an origin, credentials or forwarding headers from the browser.
    let origin = origin(
        &std::env::var("MOBILE_CATALOG_ORIGINS").unwrap_or_else(|_| "{}".into()),
        merchant,
    )?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| Error::Storage)?;
    let value = fetch(
        &client,
        origin
            .join("api/v1/catalog/categories")
            .map_err(|_| Error::Storage)?,
        &q.locale,
    )
    .await?;
    let categories = value.as_array().ok_or(Error::Storage)?;
    let needs_theme = q
        .collection
        .as_ref()
        .is_some_and(|id| id.starts_with("demo-feed-"))
        || (q.collection.is_none() && q.q.is_none());
    let theme = if needs_theme {
        let fetched = fetch(
            &client,
            origin
                .join("api/v1/theme/storefront")
                .map_err(|_| Error::Storage)?,
            &q.locale,
        )
        .await;
        if q.collection.is_some() {
            Some(fetched?)
        } else {
            fetched.ok()
        }
    } else {
        None
    };
    let (url, limit, bestsellers) = if let Some(id) = q
        .collection
        .as_deref()
        .and_then(|id| id.strip_prefix("demo-feed-"))
    {
        demo_feed(theme.as_ref().ok_or(Error::Storage)?, id, &origin)?
    } else {
        let mut url = origin.join("api/v1/search").map_err(|_| Error::Storage)?;
        append_search_query(&mut url, &q);
        if let Some(collection) = &q.collection {
            let id = category_id(categories, collection)
                .ok_or_else(|| invalid("/collection", "COLLECTION_NOT_FOUND"))?;
            url.query_pairs_mut().append_pair("category_id", &id);
        }
        (url, if q.q.is_some() { 24 } else { 12 }, false)
    };
    let found = fetch(&client, url, &q.locale).await?;
    let attributes = if q.q.is_some() {
        fetch(
            &client,
            origin
                .join("api/v1/catalog/attribute-definitions")
                .map_err(|_| Error::Storage)?,
            &q.locale,
        )
        .await?
    } else {
        json!([])
    };
    let hits = found[if bestsellers { "products" } else { "hits" }]
        .as_array()
        .ok_or(Error::Storage)?;
    let feeds = theme.as_ref().map(feed_choices).unwrap_or_default();
    let categories: Vec<_> = categories.iter().map(|c| json!({"id":c["id"],"slug":c["slug"],"name":c["name"],"imageUrl":image(&origin,c["thumbnail"].as_str())})).collect();
    Ok(Json(
        json!({"merchantId":merchant,"locale":q.locale,"source":origin.origin().ascii_serialization(),"categories":categories,"products":products(&origin,hits,limit),"feeds":feeds,"total":found["total"],"facets":found["facets"],"attributes":attributes,"nextOffset":if q.q.is_some() && !hits.is_empty() && (q.offset.unwrap_or(0) as u64 + 24) < found["total"].as_u64().unwrap_or(0) && q.offset.unwrap_or(0) + 24 <= 9999 { Some(q.offset.unwrap_or(0) + 24) } else { None }}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ProductQuery {
    locale: String,
    latitude: Option<f64>,
    longitude: Option<f64>,
}
impl ProductQuery {
    fn validate(&self) -> std::result::Result<(), Error> {
        if !matches!(self.locale.as_str(), "en" | "ar") {
            return Err(invalid("/locale", "INVALID_CATALOG_QUERY"));
        }
        match (self.latitude, self.longitude) {
            (None, None) => Ok(()),
            (Some(lat), Some(lng))
                if lat.is_finite()
                    && lng.is_finite()
                    && lat.abs() <= 90.0
                    && lng.abs() <= 180.0 =>
            {
                Ok(())
            }
            _ => Err(invalid("/delivery", "INVALID_DELIVERY_PIN")),
        }
    }
}
fn family_products(
    origin: &reqwest::Url,
    family: &Value,
) -> std::result::Result<Vec<Value>, Error> {
    let children = family["children"].as_array().ok_or(Error::Storage)?;
    let mut result = products(origin, children, children.len());
    for child in &mut result {
        child["optionLabel"] = family["structure"]["children"]
            .as_array()
            .and_then(|links| links.iter().find(|link| link["child_id"] == child["id"]))
            .and_then(|link| link["option_label"].as_str())
            .filter(|label| !label.trim().is_empty())
            .map(|label| json!(label))
            .unwrap_or_else(|| child["name"].clone());
    }
    Ok(result)
}
// Uses only the configured public storefront and explicit validated coordinates.
// No administrator/customer credentials or arbitrary request headers are forwarded.
pub(super) async fn product(
    State(a): State<MobileApp>,
    Path((merchant, id)): Path<(Uuid, Uuid)>,
    Query(q): Query<ProductQuery>,
    h: HeaderMap,
) -> ApiResult<Json<Value>> {
    a.service
        .authorize(
            merchant,
            a.actor(&h).await?,
            domain_mobile::service::Access::Read,
        )
        .await?;
    q.validate()?;
    let origin = origin(
        &std::env::var("MOBILE_CATALOG_ORIGINS").unwrap_or_else(|_| "{}".into()),
        merchant,
    )?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| Error::Storage)?;
    let request = |path: &str| -> std::result::Result<reqwest::RequestBuilder, Error> {
        let mut request = client
            .get(origin.join(path).map_err(|_| Error::Storage)?)
            .header("x-storefront-locale", &q.locale);
        if let (Some(lat), Some(lng)) = (q.latitude, q.longitude) {
            request = request
                .header("x-delivery-latitude", lat.to_string())
                .header("x-delivery-longitude", lng.to_string());
        }
        Ok(request)
    };
    let raw = fetch_request(request(&format!("api/v1/catalog/products/{id}"))?, true).await?;
    if raw["id"].as_str() != Some(id.to_string().as_str()) || raw["active"].as_bool() == Some(false)
    {
        return Err(invalid("/product", "PRODUCT_NOT_FOUND").into());
    }
    let product = products(&origin, std::slice::from_ref(&raw), 1)
        .pop()
        .ok_or(Error::Storage)?;
    let needs_location = raw["product_type"] == "configurable" && q.latitude.is_none();
    let variants = if raw["product_type"] == "configurable" && !needs_location {
        let family = fetch_request(
            request(&format!("api/v1/catalog/products/{id}/family"))?,
            true,
        )
        .await?;
        family_products(&origin, &family)?
    } else {
        vec![]
    };
    Ok(Json(
        json!({"merchantId":merchant,"locale":q.locale,"product":product,"variants":variants,"requiresDeliveryLocation":needs_location}),
    ))
}
// Category selection does not depend on product search availability.
pub(super) async fn categories(
    State(a): State<MobileApp>,
    Path(merchant): Path<Uuid>,
    h: HeaderMap,
) -> ApiResult<Json<Value>> {
    a.service
        .authorize(
            merchant,
            a.actor(&h).await?,
            domain_mobile::service::Access::Read,
        )
        .await?;
    let origin = origin(
        &std::env::var("MOBILE_CATALOG_ORIGINS").unwrap_or_else(|_| "{}".into()),
        merchant,
    )?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| Error::Storage)?;
    let value = fetch(
        &client,
        origin
            .join("api/v1/catalog/categories")
            .map_err(|_| Error::Storage)?,
        "en",
    )
    .await?;
    let values = value.as_array().ok_or(Error::Storage)?;
    let categories: Vec<_> = values
        .iter()
        .map(|c| json!({"id":c["id"],"parentId":c["parent_id"],"slug":c["slug"],"name":c["name"]}))
        .collect();
    Ok(Json(json!(categories)))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn variant_queries_require_complete_bounded_pins() {
        for raw in [
            json!({"locale":"en"}),
            json!({"locale":"ar","latitude":30.0,"longitude":31.0}),
        ] {
            assert!(serde_json::from_value::<ProductQuery>(raw)
                .unwrap()
                .validate()
                .is_ok());
        }
        for raw in [
            json!({"locale":"en","latitude":30.0}),
            json!({"locale":"en","latitude":91.0,"longitude":31.0}),
            json!({"locale":"fr"}),
        ] {
            assert!(serde_json::from_value::<ProductQuery>(raw)
                .unwrap()
                .validate()
                .is_err());
        }
        assert!(serde_json::from_value::<ProductQuery>(
            json!({"locale":"en","origin":"https://evil.test"})
        )
        .is_err());
    }
    #[test]
    fn family_preview_preserves_option_identity_stock_and_effective_price() {
        let origin = reqwest::Url::parse("https://store.test").unwrap();
        let family = json!({"structure":{"children":[{"child_id":"a","option_label":"500 g"}]},"children":[
            {"id":"a","name":"Apples small","product_type":"simple","parent_id":"parent","price":"5.00","currency":"EGP","unit":"pack","in_stock":true,"catalog_offer":{"product_id":"a","currency":"EGP","original_price":"5.00","discounted_price":"4.00"}},
            {"id":"b","name":"Apples large","price":"8.00","in_stock":false},
            {"id":"hidden","active":false,"name":"Hidden"}
        ]});
        let variants = family_products(&origin, &family).unwrap();
        assert_eq!(variants.len(), 2);
        assert_eq!(variants[0]["id"], "a");
        assert_eq!(variants[0]["parentId"], "parent");
        assert_eq!(variants[0]["optionLabel"], "500 g");
        assert_eq!(variants[0]["price"], "4.00");
        assert_eq!(variants[0]["originalPrice"], "5.00");
        assert_eq!(variants[1]["inStock"], false);
        assert_eq!(variants[1]["optionLabel"], "Apples large");
    }
    #[test]
    fn demo_feeds_match_storefront_sections_and_fail_closed() {
        let origin = reqwest::Url::parse("https://demo.test").unwrap();
        let theme = json!({"configuration":{"pages":{"home":[
            {"id":"audio","enabled":true,"component":"product_collection","settings":{"category":"audio-id","query":"wireless & small","limit":6}},
            {"id":"best","enabled":true,"component":"best_sellers","settings":{"period":"last_month","limit":8}},
            {"id":"hidden","enabled":false,"component":"product_collection","settings":{}},
            {"id":"hero","enabled":true,"component":"editorial_hero","settings":{}}
        ]}}});
        let (url, limit, best) = demo_feed(&theme, "audio", &origin).unwrap();
        assert_eq!(limit, 6);
        assert!(!best);
        let pairs: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs["category_id"], "audio-id");
        assert_eq!(pairs["q"], "wireless & small");
        assert!(demo_feed(&theme, "best", &origin).unwrap().2);
        for id in ["missing", "hidden", "hero", "https://evil.test"] {
            assert!(demo_feed(&theme, id, &origin).is_err());
        }
        assert_eq!(feed_choices(&theme).len(), 2);
    }
    #[test]
    fn attribute_filters_and_sort_are_forwarded_and_bounded() {
        let mut q: CatalogQuery = serde_json::from_value(
            json!({"locale":"en","sort":"origin:desc","attribute_filters":"{\"organic\":[true]}"}),
        )
        .unwrap();
        assert!(validate_query(&q).is_ok());
        let mut url = reqwest::Url::parse("https://store.test/api/v1/search").unwrap();
        append_search_query(&mut url, &q);
        let pairs: BTreeMap<_, _> = url.query_pairs().collect();
        assert_eq!(pairs["sort_by"], "origin");
        assert_eq!(pairs["attribute_filters"], "{\"organic\":[true]}");
        q.attribute_filters = Some("[]".into());
        assert!(validate_query(&q).is_err());
        q.attribute_filters = Some("x".repeat(8193));
        assert!(validate_query(&q).is_err());
        q.attribute_filters = None;
        q.sort = Some("origin:desc&private=true".into());
        assert!(validate_query(&q).is_err());
    }
    #[test]
    fn discovery_query_is_bounded_and_encoded() {
        let mut q: CatalogQuery = serde_json::from_value(json!({"locale":"ar","q":" تفاح & pear ","sort":"price_desc","in_stock":true,"min_price":"2.50","max_price":"10","offset":24})).unwrap();
        assert!(validate_query(&q).is_ok());
        let mut url = reqwest::Url::parse("https://grocery.rocento.com/api/v1/search").unwrap();
        append_search_query(&mut url, &q);
        let pairs: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs["q"], "تفاح & pear");
        assert_eq!(pairs["sort_by"], "price");
        assert_eq!(pairs["sort_order"], "desc");
        assert_eq!(pairs["offset"], "24");
        assert_eq!(pairs["in_stock"], "true");
        q.min_price = Some("11".into());
        assert!(validate_query(&q).is_err());
        q.min_price = Some("-1".into());
        assert!(validate_query(&q).is_err());
        q.min_price = None;
        q.sort = Some("secret".into());
        assert!(validate_query(&q).is_err());
        q.sort = None;
        q.offset = Some(10000);
        assert!(validate_query(&q).is_err());
        q.offset = None;
        q.q = Some("x".repeat(121));
        assert!(validate_query(&q).is_err());
    }
    #[test]
    fn binding_is_explicit_and_rejects_non_origins() {
        let id = Uuid::new_v4();
        assert!(origin("{}", id).is_err());
        for value in [
            "http://example.com",
            "https://user:pass@example.com",
            "https://example.com/path",
            "https://example.com/?url=other",
        ] {
            assert!(origin(&json!({id.to_string():value}).to_string(), id).is_err());
        }
        assert_eq!(
            origin(
                &json!({id.to_string():"https://grocery.rocento.com"}).to_string(),
                id
            )
            .unwrap()
            .host_str(),
            Some("grocery.rocento.com")
        );
    }
    #[test]
    fn collection_resolution_never_falls_back_to_unfiltered_products() {
        let categories = vec![
            json!({"id":"id-a","slug":"fruit"}),
            json!({"id":"id-b","slug":"bread"}),
        ];
        assert_eq!(category_id(&categories, "fruit").as_deref(), Some("id-a"));
        assert_eq!(category_id(&categories, "id-b").as_deref(), Some("id-b"));
        assert_eq!(category_id(&categories, "featured"), None);
    }
    #[test]
    fn images_are_built_from_catalog_ids_only() {
        let origin = reqwest::Url::parse("https://grocery.rocento.com").unwrap();
        assert_eq!(image(&origin, Some("https://evil.test/image")), None);
        assert!(image(&origin, Some(&Uuid::new_v4().to_string()))
            .unwrap()
            .starts_with("https://grocery.rocento.com/api/v1/catalog/media/"));
        let output = products(
            &origin,
            &[
                json!({"id":"hidden","active":false}),
                json!({"id":"visible","active":true,"name":"Apple","description":"Fresh apple","price":"10.00","currency":"EGP","in_stock":true,"secret":"not exposed"}),
            ],
            12,
        );
        assert_eq!(output[0]["description"], "Fresh apple");
        assert_eq!(output.len(), 1);
        assert!(output[0].get("secret").is_none());
        assert_eq!(output[0]["price"], "10.00");
    }
}
