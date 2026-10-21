use crate::identity::{self, ApiError, App};
use axum::response::IntoResponse;
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::HeaderMap,
    middleware,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;
type ProvenanceRow = (
    Uuid,
    Uuid,
    String,
    Option<f64>,
    chrono::DateTime<chrono::Utc>,
);
type RankingRow = (
    Uuid,
    String,
    String,
    i32,
    i32,
    Value,
    bool,
    i32,
    chrono::DateTime<chrono::Utc>,
);
type Result<T> = std::result::Result<T, ApiError>;
fn catalog(a: &App) -> domain_catalog::Service {
    domain_catalog::Service {
        pool: a.customers.pool.clone(),
    }
}
fn definitions(a: &App) -> domain_attributes::Service {
    domain_attributes::Service {
        pool: a.customers.pool.clone(),
    }
}
fn orders(a: &App) -> domain_orders::Service {
    domain_orders::Service {
        pool: a.customers.pool.clone(),
    }
}
async fn admin(a: &App, h: &HeaderMap, p: &str) -> Result<domain_admin_iam::Identity> {
    let who = a
        .admins
        .authenticate(identity::cookie(h, "admin_session"))
        .await?;
    who.require(p)?;
    Ok(who)
}
#[derive(Deserialize)]
struct Entity {
    entity_type: String,
}
pub fn router(app: App) -> Router {
    Router::new()
        .route(
            "/v1/admin/catalog/discovery",
            get(discovery_coverage).put(discovery_configure),
        )
        .route(
            "/v1/admin/catalog/discovery/relationships",
            post(discovery_edge),
        )
        .route(
            "/v1/admin/catalog/discovery/relationships/{id}",
            axum::routing::delete(discovery_remove_edge),
        )
        .route(
            "/v1/admin/catalog/discovery/merchandising",
            axum::routing::put(discovery_merchandising),
        )
        .route(
            "/v1/admin/promotions/{id}/attribute-conditions",
            get(promo_conditions).put(save_promo_conditions),
        )
        .route("/v1/catalog/schema", get(public_schema))
        .route(
            "/v1/admin/catalog/industry-profiles",
            get(profiles).post(save_industry_profile),
        )
        .route(
            "/v1/admin/catalog/industry-profiles/{id}/preview",
            get(preview_industry),
        )
        .route(
            "/v1/admin/catalog/industry",
            get(industry_configuration).put(apply_industry),
        )
        .route(
            "/v1/admin/catalog/enrichment",
            get(enrichment).post(propose_enrichment),
        )
        .route(
            "/v1/admin/catalog/products/{id}/enrichment",
            post(generate_enrichment),
        )
        .route(
            "/v1/admin/catalog/enrichment/{id}",
            axum::routing::put(review_enrichment),
        )
        .route(
            "/v1/admin/catalog/products/{id}/attribute-values",
            get(attribute_values),
        )
        .route(
            "/v1/admin/catalog/attribute-relationships",
            get(relationships).post(save_relationship),
        )
        .route("/v1/catalog/attribute-definitions", get(public_definitions))
        .route("/v1/admin/attribute-definitions", get(list).post(save))
        .route(
            "/v1/admin/attribute-definitions/{id}",
            axum::routing::delete(delete),
        )
        .route("/v1/admin/attribute-sets", get(list_sets).post(save_set))
        .route(
            "/v1/admin/attribute-sets/{id}",
            axum::routing::delete(delete_set),
        )
        .route("/v1/catalog/products/{id}/family", get(family))
        .route(
            "/v1/admin/catalog/products/{id}/family",
            get(admin_family).put(structure),
        )
        .route(
            "/v1/admin/catalog/categories/{id}/attributes",
            get(category_values).put(save_category_values),
        )
        .route("/v1/customer/profile", get(profile).put(save_profile))
        .route(
            "/v1/customer/attribute-definitions",
            get(customer_definitions),
        )
        .route("/v1/admin/customers/{id}/profile", get(admin_profile))
        .route(
            "/v1/admin/customers/{id}/journey",
            get(crate::customer_journey::journey),
        )
        .route("/v1/cart/bundles/{id}", post(bundle))
        .route("/v1/customer/orders/{id}/extensions", get(extensions))
        .route("/v1/admin/orders/{id}/extensions", get(admin_extensions))
        .route(
            "/v1/admin/orders/{id}/comments",
            get(comments).post(comment),
        )
        .layer(DefaultBodyLimit::max(128 * 1024))
        .layer(middleware::from_fn_with_state(
            app.clone(),
            identity::policy,
        ))
        .with_state(app)
}
#[derive(Deserialize)]
struct AttributeLanguage {
    locale: Option<String>,
}

async fn localized_definitions(
    a: &App,
    entity: &str,
    locale: Option<&str>,
) -> Result<Vec<domain_attributes::Definition>> {
    let mut result = definitions(a).list(entity).await?;
    let Some(locale) = locale else {
        return Ok(result);
    };
    // Serve reviewed, current translations only. Missing fields inherit source copy.
    let rows: Vec<(Uuid, Value)> = sqlx::query_as(
        "SELECT d.id,t.fields FROM attributes.definitions d JOIN cms.catalog_translations t ON t.entity_type='attribute' AND t.entity_id=d.id JOIN cms.storefront_languages l ON l.locale=t.locale JOIN cms.language_settings s ON s.singleton WHERE d.entity_type=$1 AND t.locale=$2 AND t.locale<>s.source_locale AND t.reviewed AND t.source=cms.attribute_translation_source(d.label,d.metadata,d.options)"
    ).bind(entity).bind(locale).fetch_all(&a.customers.pool).await?;
    for d in &mut result {
        if let Some((_, fields)) = rows.iter().find(|(id, _)| *id == d.id) {
            apply_attribute_translation(d, fields);
        }
    }
    Ok(result)
}

fn apply_attribute_translation(d: &mut domain_attributes::Definition, fields: &Value) {
    let translated = |key: &str| {
        fields
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .map(str::to_owned)
    };
    if let Some(label) = translated("label") {
        d.label = label;
    }
    if let Some(description) = translated("description") {
        d.metadata.description = description;
    }
    if let Some(options) = d.options.as_array_mut() {
        for option in options {
            if let Some(value) = option.get("value").and_then(Value::as_str) {
                if let Some(label) = translated(&format!("option.{value}")) {
                    option["label"] = Value::String(label);
                }
            }
        }
    }
}

async fn public_definitions(
    State(a): State<App>,
    Query(language): Query<AttributeLanguage>,
) -> Result<Json<Vec<domain_attributes::Definition>>> {
    Ok(Json(
        localized_definitions(&a, "product", language.locale.as_deref())
            .await?
            .into_iter()
            .filter(|d| d.metadata.active() && (d.is_visible_on_front || d.used_for_configurations))
            .collect(),
    ))
}
async fn list(
    State(a): State<App>,
    h: HeaderMap,
    Query(e): Query<Entity>,
) -> Result<Json<Vec<domain_attributes::Definition>>> {
    admin(&a, &h, "attributes.read").await?;
    Ok(Json(definitions(&a).list(&e.entity_type).await?))
}
async fn save(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<domain_attributes::Definition>,
) -> Result<Json<domain_attributes::Definition>> {
    admin(&a, &h, "attributes.write").await?;
    Ok(Json(definitions(&a).save(i).await?))
}
async fn delete(State(a): State<App>, h: HeaderMap, Path(id): Path<Uuid>) -> Result<Json<Value>> {
    admin(&a, &h, "attributes.write").await?;
    definitions(&a).delete(id).await?;
    Ok(Json(json!({"status":"ok"})))
}
async fn list_sets(
    State(a): State<App>,
    h: HeaderMap,
) -> Result<Json<Vec<domain_attributes::AttributeSet>>> {
    admin(&a, &h, "attributes.read").await?;
    Ok(Json(definitions(&a).sets().await?))
}
async fn save_set(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<domain_attributes::AttributeSet>,
) -> Result<Json<domain_attributes::AttributeSet>> {
    admin(&a, &h, "attributes.write").await?;
    Ok(Json(definitions(&a).save_set(i).await?))
}
async fn delete_set(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    admin(&a, &h, "attributes.write").await?;
    definitions(&a).delete_set(id).await?;
    Ok(Json(json!({"status":"ok"})))
}
async fn admin_family(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<domain_catalog::types::ProductFamily>> {
    admin(&a, &h, "catalog.read").await?;
    Ok(Json(catalog(&a).family(id).await?))
}
async fn family(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse> {
    let c = catalog(&a);
    if !c.storefront_product(id).await?.active {
        return Err(infra_auth::Error::NotFound.into());
    }
    let mut f = c.family(id).await?;
    let delivery = a.cart.inventory.delivery(crate::areas::pin(&h)?).await?;
    if !delivery.deliverable {
        return Err(domain_catalog::invalid("Choose a covered delivery pin").into());
    }
    f.children.retain(|c| c.active);
    for p in &mut f.children {
        p.in_stock = if let Some(area) = delivery.area_id {
            a.cart.inventory.area_available(area, p.id).await? > 0
        } else {
            a.cart.inventory.stock(p.id).await?.available > 0
        };
        c.visible_attributes(p).await?;
    }
    let children = crate::catalog::priced_products(&a, &h, &f.children).await?;
    let mut value = serde_json::json!(f);
    value["children"] = serde_json::json!(children);
    Ok(([("cache-control", "private, no-store")], Json(value)))
}
async fn structure(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<domain_catalog::types::Structure>,
) -> Result<Json<domain_catalog::types::ProductFamily>> {
    admin(&a, &h, "catalog.write").await?;
    Ok(Json(catalog(&a).structure(id, i).await?))
}
async fn category_values(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    admin(&a, &h, "catalog.read").await?;
    Ok(Json(catalog(&a).category_attributes(id).await?))
}
async fn save_category_values(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    admin(&a, &h, "catalog.write").await?;
    Ok(Json(catalog(&a).category_values(id, v).await?))
}
async fn profile(State(a): State<App>, h: HeaderMap) -> Result<Json<domain_customers::Profile>> {
    let c = a.customers.authenticate(identity::bearer(&h)?).await?;
    Ok(Json(a.customers.profile(c.id).await?))
}
async fn save_profile(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<domain_customers::ProfileInput>,
) -> Result<Json<domain_customers::Profile>> {
    let c = a.customers.authenticate(identity::bearer(&h)?).await?;
    Ok(Json(a.customers.save_profile(c.id, i).await?))
}
async fn customer_definitions(
    State(a): State<App>,
    h: HeaderMap,
    Query(language): Query<AttributeLanguage>,
) -> Result<Json<Vec<domain_attributes::Definition>>> {
    a.customers.authenticate(identity::bearer(&h)?).await?;
    Ok(Json(
        localized_definitions(&a, "customer", language.locale.as_deref()).await?,
    ))
}
#[derive(serde::Serialize)]
struct AdminCustomerProfile {
    #[serde(flatten)]
    profile: domain_customers::Profile,
    account: domain_customers::Customer,
    locations: Vec<domain_customers::Location>,
}
async fn admin_profile(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<AdminCustomerProfile>> {
    admin(&a, &h, "customers.read").await?;
    let profile = a.customers.profile(id).await?;
    let account = sqlx::query_as::<_, domain_customers::Customer>(
        "SELECT id,entity_id,email,mobile_number,primary_identifier,verified,created_at FROM customers.customers WHERE id=$1",
    ).bind(id).fetch_one(&a.customers.pool).await?;
    let locations = a.customers.locations(id).await?;
    Ok(Json(AdminCustomerProfile {
        profile,
        account,
        locations,
    }))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bundle {
    selected: Vec<Uuid>,
}
async fn bundle(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<Bundle>,
) -> Result<Json<domain_cart_checkout::Cart>> {
    let c = if h.contains_key("authorization") {
        Some(a.customers.authenticate(identity::bearer(&h)?).await?.id)
    } else {
        None
    };
    Ok(Json(
        a.cart
            .bundle(c, identity::cookie(&h, "guest_cart"), id, i.selected)
            .await?,
    ))
}
async fn extensions(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<domain_orders::Extensions>> {
    let c = a.customers.authenticate(identity::bearer(&h)?).await?;
    Ok(Json(orders(&a).extensions(id, Some(c.id)).await?))
}
async fn admin_extensions(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<domain_orders::Extensions>> {
    admin(&a, &h, "orders.read").await?;
    Ok(Json(orders(&a).extensions(id, None).await?))
}
async fn comments(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<domain_orders::Comment>>> {
    Ok(Json(
        orders(&a)
            .comments(id, &admin(&a, &h, "orders.read").await?)
            .await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Note {
    body: String,
}
async fn comment(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<Note>,
) -> Result<Json<domain_orders::Comment>> {
    Ok(Json(
        orders(&a)
            .comment(id, &admin(&a, &h, "orders.write").await?, &i.body)
            .await?,
    ))
}

async fn promo_conditions(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    Ok(Json(
        domain_pricing_promotions::Service {
            pool: a.customers.pool.clone(),
        }
        .conditions(id, &admin(&a, &h, "promotions.read").await?)
        .await?,
    ))
}
async fn save_promo_conditions(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    Ok(Json(
        domain_pricing_promotions::Service {
            pool: a.customers.pool.clone(),
        }
        .save_conditions(id, v, &admin(&a, &h, "promotions.write").await?)
        .await?,
    ))
}

async fn public_schema(
    State(a): State<App>,
) -> Result<Json<domain_attributes::schema::CatalogSchema>> {
    Ok(Json(definitions(&a).catalog_schema(false).await?))
}
async fn profiles(
    State(a): State<App>,
    h: HeaderMap,
) -> Result<Json<Vec<domain_attributes::industry::IndustryProfile>>> {
    admin(&a, &h, "attributes.read").await?;
    Ok(Json(definitions(&a).profiles().await?))
}
async fn save_industry_profile(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<domain_attributes::industry::IndustryProfile>,
) -> Result<Json<domain_attributes::industry::IndustryProfile>> {
    admin(&a, &h, "attributes.write").await?;
    Ok(Json(definitions(&a).save_profile(i).await?))
}
async fn preview_industry(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<domain_attributes::industry::Preview>> {
    admin(&a, &h, "attributes.read").await?;
    Ok(Json(definitions(&a).preview_industry(id).await?))
}
async fn industry_configuration(
    State(a): State<App>,
    h: HeaderMap,
) -> Result<Json<domain_attributes::industry::Configuration>> {
    admin(&a, &h, "attributes.read").await?;
    Ok(Json(definitions(&a).configuration().await?))
}
async fn apply_industry(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<domain_attributes::industry::Apply>,
) -> Result<Json<domain_attributes::industry::Configuration>> {
    admin(&a, &h, "attributes.write").await?;
    Ok(Json(definitions(&a).apply_industry(i).await?))
}
async fn enrichment(
    State(a): State<App>,
    h: HeaderMap,
    Query(query): Query<domain_attributes::enrichment::SuggestionQuery>,
) -> Result<Json<Vec<domain_attributes::enrichment::Suggestion>>> {
    admin(&a, &h, "attributes.read").await?;
    admin(&a, &h, "catalog.read").await?;
    Ok(Json(definitions(&a).suggestion_page(query).await?))
}
async fn generate_enrichment(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<domain_attributes::enrichment::Suggestion>>> {
    admin(&a, &h, "attributes.write").await?;
    admin(&a, &h, "catalog.read").await?;
    Ok(Json(definitions(&a).generate_enrichment(id).await?))
}
async fn propose_enrichment(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<domain_attributes::enrichment::SuggestionInput>,
) -> Result<Json<domain_attributes::enrichment::Suggestion>> {
    admin(&a, &h, "attributes.write").await?;
    admin(&a, &h, "catalog.read").await?;
    Ok(Json(definitions(&a).propose(i).await?))
}
async fn review_enrichment(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<domain_attributes::enrichment::Review>,
) -> Result<Json<domain_attributes::enrichment::Suggestion>> {
    let who = admin(&a, &h, "attributes.write").await?;
    admin(&a, &h, "catalog.write").await?;
    Ok(Json(
        definitions(&a)
            .review_suggestion(id, i, who.user.id)
            .await?,
    ))
}
async fn attribute_values(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<domain_attributes::enrichment::ValueRecord>>> {
    admin(&a, &h, "catalog.read").await?;
    Ok(Json(definitions(&a).value_records(id).await?))
}
async fn relationships(
    State(a): State<App>,
    h: HeaderMap,
) -> Result<Json<Vec<domain_attributes::schema::Relationship>>> {
    admin(&a, &h, "attributes.read").await?;
    Ok(Json(definitions(&a).relationships().await?))
}
async fn save_relationship(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<domain_attributes::schema::Relationship>,
) -> Result<Json<domain_attributes::schema::Relationship>> {
    admin(&a, &h, "attributes.write").await?;
    Ok(Json(definitions(&a).save_relationship(i).await?))
}

// Discovery administration uses the same catalog permissions, CSRF policy and store pool.
async fn discovery_coverage(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    admin(&a, &h, "attributes.read").await?;
    let defs = definitions(&a)
        .list("product")
        .await?
        .into_iter()
        .filter(|d| domain_attributes::schema::eligible(d, true))
        .collect::<Vec<_>>();
    let pool = &a.customers.pool;
    let mut products:Vec<domain_catalog::Product>=sqlx::query_as("SELECT * FROM catalog.products WHERE active AND product_type='simple' AND (parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.products p WHERE p.id=catalog.products.parent_id AND p.active)) ORDER BY id LIMIT 5001").fetch_all(pool).await.map_err(infra_auth::Error::from)?;
    let bounded = products.len() > 5000;
    products.truncate(5000);
    let ids: Vec<_> = products.iter().map(|p| p.id).collect();
    let provenance:Vec<ProvenanceRow>=sqlx::query_as("SELECT product_id,definition_id,source,confidence,updated_at FROM attributes.value_provenance WHERE product_id=ANY($1)").bind(&ids).fetch_all(pool).await.map_err(infra_auth::Error::from)?;
    let provenance = provenance
        .into_iter()
        .map(|v| ((v.0, v.1), (v.2, v.3, v.4)))
        .collect::<std::collections::BTreeMap<_, _>>();
    let names: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT id,name FROM catalog.categories WHERE id=ANY($1)")
            .bind(products.iter().map(|p| p.category_id).collect::<Vec<_>>())
            .fetch_all(pool)
            .await
            .map_err(infra_auth::Error::from)?;
    let mut rows = Vec::new();
    for (id, name) in names {
        let group = products
            .iter()
            .filter(|p| p.category_id == id || p.category_ids.contains(&id))
            .collect::<Vec<_>>();
        let mut present = 0;
        let mut factual = 0;
        let mut fresh = 0;
        let mut confidence = 0.0;
        let mut known = 0;
        let mut invalid = 0;
        let mut missing = std::collections::BTreeMap::<String, usize>::new();
        for p in &group {
            for d in &defs {
                let Some(v) = p.attributes.get(&d.attribute_code).filter(|v| !v.is_null()) else {
                    *missing.entry(d.attribute_code.clone()).or_default() += 1;
                    continue;
                };
                if domain_attributes::validate_value(d, v).is_err() {
                    invalid += 1;
                    continue;
                }
                present += 1;
                let source = provenance.get(&(p.id, d.id));
                if source.is_none_or(|v| !["AI_INFERRED", "DERIVED"].contains(&v.0.as_str())) {
                    factual += 1;
                }
                if source.map(|v| v.2).unwrap_or(p.updated_at)
                    > chrono::Utc::now() - chrono::Duration::days(30)
                {
                    fresh += 1;
                }
                if let Some(c) = source.and_then(|v| v.1) {
                    confidence += c;
                    known += 1;
                }
            }
        }
        rows.push(json!({"category_id":id,"category_name":name,"products":group.len(),"expected_values":group.len()*defs.len(),"present_values":present,"factual_values":factual,"fresh_values":fresh,"invalid_values":invalid,"confidence_known":known,"mean_confidence":if known==0 {None} else {Some(confidence/known as f64)},"missing":missing}));
    }
    rows.sort_by_key(|v| v["category_name"].as_str().unwrap_or_default().to_string());
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM catalog.discovery_edges WHERE NOT reviewed AND expires_at>now()",
    )
    .fetch_one(pool)
    .await
    .map_err(infra_auth::Error::from)?;
    let rankings:Vec<RankingRow>=sqlx::query_as("SELECT r.product_id,p.name,r.ranker,r.rank,r.score,r.contributions,r.sponsored,r.merchant_boost,r.observed_at FROM catalog.discovery_rank_observations r JOIN catalog.products p ON p.id=r.product_id AND p.active ORDER BY r.observed_at DESC,r.product_id LIMIT 20").fetch_all(pool).await.map_err(infra_auth::Error::from)?;
    let rankings=rankings.into_iter().map(|r|json!({"product_id":r.0,"name":r.1,"ranker":r.2,"rank":r.3,"score":r.4,"contributions":r.5,"sponsored":r.6,"merchant_boost":r.7,"observed_at":r.8})).collect::<Vec<_>>();
    Ok(Json(
        json!({"schema_version":"1.0.0","enabled":domain_search_client::discovery::enabled(pool).await?,"semantic_enabled":false,"bounded":bounded,"products_evaluated":products.len(),"attribute_scope":"all visible AI-queryable store definitions","freshness_days":30,"pending_relationships":pending,"categories":rows,"rankings":rankings}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiscoveryConfiguration {
    enabled: bool,
}
async fn discovery_configure(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<DiscoveryConfiguration>,
) -> Result<Json<Value>> {
    let who = admin(&a, &h, "attributes.write").await?;
    let mut tx = a
        .customers
        .pool
        .begin()
        .await
        .map_err(infra_auth::Error::from)?;
    sqlx::query("UPDATE catalog.discovery_configuration SET enabled=$1 WHERE singleton")
        .bind(i.enabled)
        .execute(&mut *tx)
        .await
        .map_err(infra_auth::Error::from)?;
    infra_events::record(
        &mut tx,
        "catalog.discovery_configuration",
        json!({"enabled":i.enabled,"actor":who.user.id}),
    )
    .await?;
    tx.commit().await.map_err(infra_auth::Error::from)?;
    Ok(Json(json!({"enabled":i.enabled})))
}
async fn discovery_edge(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<domain_search_client::discovery::EdgeInput>,
) -> Result<Json<domain_search_client::discovery::Edge>> {
    let who = admin(&a, &h, "catalog.write").await?;
    Ok(Json(
        domain_search_client::discovery::save_edge(&a.customers.pool, i, who.user.id).await?,
    ))
}
async fn discovery_remove_edge(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let who = admin(&a, &h, "catalog.write").await?;
    let mut tx = a
        .customers
        .pool
        .begin()
        .await
        .map_err(infra_auth::Error::from)?;
    sqlx::query("DELETE FROM catalog.discovery_edges WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(infra_auth::Error::from)?;
    infra_events::record(
        &mut tx,
        "catalog.relationship_removed",
        json!({"id":id,"actor":who.user.id}),
    )
    .await?;
    tx.commit().await.map_err(infra_auth::Error::from)?;
    Ok(Json(json!({"status":"ok"})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Merchandising {
    product_id: Uuid,
    boost: i32,
    sponsored: bool,
    expires_at: chrono::DateTime<chrono::Utc>,
}
async fn discovery_merchandising(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<Merchandising>,
) -> Result<Json<Value>> {
    let who = admin(&a, &h, "catalog.write").await?;
    if !(0..=10).contains(&i.boost)
        || i.expires_at <= chrono::Utc::now()
        || i.expires_at > chrono::Utc::now() + chrono::Duration::days(365)
    {
        return Err(infra_auth::Error::Invalid("Invalid boost or expiry".into()).into());
    }
    let mut tx = a
        .customers
        .pool
        .begin()
        .await
        .map_err(infra_auth::Error::from)?;
    let result=sqlx::query("INSERT INTO catalog.discovery_merchandising(product_id,boost,sponsored,expires_at,updated_by) SELECT id,$2,$3,$4,$5 FROM catalog.products WHERE id=$1 AND active ON CONFLICT(product_id) DO UPDATE SET boost=$2,sponsored=$3,expires_at=$4,updated_by=$5").bind(i.product_id).bind(i.boost).bind(i.sponsored).bind(i.expires_at).bind(who.user.id).execute(&mut *tx).await.map_err(infra_auth::Error::from)?;
    if result.rows_affected() == 0 {
        return Err(infra_auth::Error::NotFound.into());
    }
    infra_events::record(&mut tx,"catalog.merchandising_changed",json!({"product_id":i.product_id,"boost":i.boost,"sponsored":i.sponsored,"actor":who.user.id})).await?;
    tx.commit().await.map_err(infra_auth::Error::from)?;
    Ok(Json(json!({"status":"ok"})))
}

#[cfg(test)]
mod translation_tests {
    use super::*;

    #[test]
    fn localized_labels_preserve_values_and_source_fallback() {
        let mut d: domain_attributes::Definition = serde_json::from_value(json!({
            "id":Uuid::new_v4(),"entity_type":"customer","attribute_code":"color",
            "label":"Color","input_type":"select","scope":"global",
            "is_required":false,"is_unique":false,"is_searchable":false,
            "is_filterable":false,"is_comparable":false,"is_visible_on_front":false,
            "used_for_promo_rules":false,"used_for_configurations":false,
            "swatch_type":"none","version":1,
            "options":[{"value":"red.dark","label":"Dark red"},{"value":"blue","label":"Blue"}]
        }))
        .unwrap();
        apply_attribute_translation(
            &mut d,
            &json!({"label":"اللون","option.red.dark":"أحمر داكن","option.blue":" "}),
        );
        assert_eq!(d.label, "اللون");
        assert_eq!(d.options[0]["value"], "red.dark");
        assert_eq!(d.options[0]["label"], "أحمر داكن");
        assert_eq!(d.options[1]["label"], "Blue");
    }
}
