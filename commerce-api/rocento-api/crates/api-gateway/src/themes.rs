use crate::identity::{self, App};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use domain_theme::{application::*, domain::*, postgres::PostgresRepository};
use serde_json::json;
use uuid::Uuid;

#[derive(Clone)]
struct ThemeApp {
    identity: App,
    service: Service<PostgresRepository>,
    deployment: crate::public_commerce::policy::Deployment,
}
struct ThemeError(Error);
impl From<Error> for ThemeError {
    fn from(e: Error) -> Self {
        Self(e)
    }
}
impl IntoResponse for ThemeError {
    fn into_response(self) -> Response {
        let status = match &self.0 {
            Error::NotFound => StatusCode::NOT_FOUND,
            Error::Conflict => StatusCode::CONFLICT,
            Error::Forbidden => StatusCode::FORBIDDEN,
            Error::Invalid(_) => StatusCode::BAD_REQUEST,
            Error::Storage => StatusCode::SERVICE_UNAVAILABLE,
        };
        (status, Json(json!({"error":self.0.to_string()}))).into_response()
    }
}
type ApiResult<T> = std::result::Result<T, ThemeError>;
impl ThemeApp {
    async fn actor(&self, h: &HeaderMap) -> ApiResult<Actor> {
        let who = self
            .identity
            .admins
            .authenticate(identity::cookie(h, "admin_session"))
            .await
            .map_err(|_| Error::Forbidden)?;
        Ok(Actor {
            id: who.user.id,
            permissions: who.permissions,
        })
    }
}
pub fn router(identity: App) -> Router {
    router_with_deployment(
        identity,
        crate::public_commerce::policy::Deployment::default(),
    )
}
pub fn router_with_deployment(
    identity: App,
    deployment: crate::public_commerce::policy::Deployment,
) -> Router {
    let state = ThemeApp {
        service: Service {
            repository: PostgresRepository::new(identity.customers.pool.clone()),
        },
        identity: identity.clone(),
        deployment,
    };
    let admin = Router::new()
        .route("/v1/admin/themes", get(list).post(create))
        .route("/v1/admin/themes/contract", get(definitions))
        .route("/v1/admin/themes/assignments", get(assignments))
        .route(
            "/v1/admin/themes/target-options/{channel}",
            get(target_options),
        )
        .route("/v1/admin/themes/assignments/{channel}", put(assign))
        .route("/v1/admin/themes/{id}", get(detail).put(save))
        .route("/v1/admin/themes/{id}/validate", post(validate))
        .route("/v1/admin/themes/{id}/preview", get(preview))
        .route("/v1/admin/themes/{id}/publish", post(publish))
        .route("/v1/admin/themes/{id}/versions", get(versions))
        .route("/v1/admin/themes/{id}/versions/{version}", get(version))
        .layer(DefaultBodyLimit::max(MAX_BYTES + 4096))
        .layer(middleware::from_fn_with_state(identity, identity::policy));
    admin
        .route("/v1/theme/{channel}", get(resolve))
        .with_state(state)
}
async fn list(State(a): State<ThemeApp>, h: HeaderMap) -> ApiResult<Json<Vec<Theme>>> {
    Ok(Json(a.service.list(&a.actor(&h).await?).await?))
}
async fn create(
    State(a): State<ThemeApp>,
    h: HeaderMap,
    Json(i): Json<Create>,
) -> ApiResult<Json<Theme>> {
    Ok(Json(a.service.create(i, &a.actor(&h).await?).await?))
}
async fn detail(
    State(a): State<ThemeApp>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Theme>> {
    Ok(Json(a.service.get(id, &a.actor(&h).await?, "read").await?))
}
async fn save(
    State(a): State<ThemeApp>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<Update>,
) -> ApiResult<Json<Theme>> {
    Ok(Json(a.service.save(id, i, &a.actor(&h).await?).await?))
}
async fn preview(
    State(a): State<ThemeApp>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Configuration>> {
    Ok(Json(a.service.preview(id, &a.actor(&h).await?).await?))
}
async fn validate(
    State(a): State<ThemeApp>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    a.service.validate(id, &a.actor(&h).await?).await?;
    Ok(Json(json!({"valid":true})))
}
async fn publish(
    State(a): State<ThemeApp>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<Publish>,
) -> ApiResult<Json<Version>> {
    Ok(Json(a.service.publish(id, i, &a.actor(&h).await?).await?))
}
async fn versions(
    State(a): State<ThemeApp>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Vec<Version>>> {
    Ok(Json(a.service.versions(id, &a.actor(&h).await?).await?))
}
async fn assignments(State(a): State<ThemeApp>, h: HeaderMap) -> ApiResult<Json<Vec<Assignment>>> {
    Ok(Json(a.service.assignments(&a.actor(&h).await?).await?))
}
async fn version(
    State(a): State<ThemeApp>,
    h: HeaderMap,
    Path((id, version)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<Version>> {
    Ok(Json(
        a.service.version(id, version, &a.actor(&h).await?).await?,
    ))
}
async fn assign(
    State(a): State<ThemeApp>,
    h: HeaderMap,
    Path(channel): Path<String>,
    Json(i): Json<Assign>,
) -> ApiResult<Json<Assignment>> {
    Ok(Json(
        a.service.assign(&channel, i, &a.actor(&h).await?).await?,
    ))
}
async fn definitions(
    State(a): State<ThemeApp>,
    h: HeaderMap,
) -> ApiResult<Json<&'static Contract>> {
    a.actor(&h).await?;
    Ok(Json(contract()))
}
async fn target_options(
    State(a): State<ThemeApp>,
    h: HeaderMap,
    Path(channel): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    a.actor(&h).await?.require("read", &channel)?;
    let pool = &a.identity.customers.pool;
    let segments: Vec<serde_json::Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name',definition->>'name') FROM customers.segments WHERE definition->>'status'='active' ORDER BY definition->>'name'").fetch_all(pool).await.map_err(|_| Error::Storage)?;
    let stocks: Vec<serde_json::Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('id',id,'name',name) FROM inventory.stocks ORDER BY name",
    )
    .fetch_all(pool)
    .await
    .map_err(|_| Error::Storage)?;
    let areas = a
        .identity
        .cart
        .inventory
        .areas()
        .await
        .map_err(|_| Error::Storage)?;
    Ok(Json(
        json!({"segments":segments,"stocks":stocks,"areas":areas}),
    ))
}
#[derive(serde::Deserialize, Default)]
struct ThemeQuery {
    city: Option<String>,
}
async fn resolve(
    State(a): State<ThemeApp>,
    Path(channel): Path<String>,
    Query(query): Query<ThemeQuery>,
    h: HeaderMap,
) -> ApiResult<Response> {
    if channel.is_empty() || channel.len() > 100 {
        return Err(Error::NotFound.into());
    }
    let rules: Option<serde_json::Value> =
        sqlx::query_scalar("SELECT rules FROM theme.assignments WHERE channel=$1")
            .bind(&channel)
            .fetch_optional(&a.identity.customers.pool)
            .await
            .map_err(|_| Error::Storage)?;
    let rules: Vec<TargetRule> =
        serde_json::from_value(rules.unwrap_or(json!([]))).map_err(|_| Error::Storage)?;
    let mut context = TargetContext::default();
    let city = query.city.as_deref().map(str::trim);
    if city.is_some_and(|v| v.len() > 100 || v.chars().any(|c| c.is_control())) {
        return Err(Error::Invalid("Invalid city".into()).into());
    }
    context.city = city.filter(|v| !v.is_empty()).map(str::to_owned);
    let pin =
        crate::areas::pin(&h).map_err(|_| Error::Invalid("Invalid delivery coordinates".into()))?;
    context.area_id = a
        .identity
        .cart
        .inventory
        .delivery(pin)
        .await
        .map_err(|_| Error::Storage)?
        .area_id;
    if let Some(area) = context.area_id {
        context.stocks = sqlx::query_scalar("SELECT stock_id FROM inventory.area_stock_links WHERE area_id=$1 ORDER BY priority,stock_id")
            .bind(area).fetch_all(&a.identity.customers.pool).await.map_err(|_| Error::Storage)?;
    }
    if h.contains_key("authorization") {
        let token = identity::bearer(&h).unwrap_or("");
        let customer = match a.identity.customers.authenticate(token).await {
            Ok(customer) => customer,
            Err(infra_auth::Error::Unauthorized) => {
                return Ok((
                    StatusCode::UNAUTHORIZED,
                    [("cache-control", "private, no-store")],
                    Json(json!({"error":"Customer session expired"})),
                )
                    .into_response())
            }
            Err(_) => return Err(Error::Storage.into()),
        };
        let ids: Vec<Uuid> = rules
            .iter()
            .filter(|r| r.enabled)
            .filter_map(|r| r.segment_id)
            .collect();
        context.segments = domain_customers::segments::Service {
            pool: a.identity.customers.pool.clone(),
        }
        .matching_ids(customer.id, &ids)
        .await
        .map_err(|_| Error::Storage)?;
    }
    let cities: Vec<String> = rules
        .iter()
        .filter(|r| r.enabled)
        .filter_map(|r| r.city.as_ref())
        .map(|v| v.trim().to_owned())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let (id, configuration) = a
        .service
        .repository
        .resolve_targeted(&channel, &context)
        .await?
        .map(|v| (Some(v.id), v.configuration))
        .unwrap_or_else(|| (None, default_configuration()));
    let images = crate::public_commerce::images::for_ids(
        &mut *a
            .identity
            .customers
            .pool
            .acquire()
            .await
            .map_err(|_| Error::Storage)?,
        configuration.assets(),
    )
    .await
    .map_err(|_| Error::Storage)?;
    let discovery_attribution_enabled = if a.deployment.approved_origin.is_some() {
        let installation_id: Uuid = sqlx::query_scalar(
            "SELECT installation_id FROM platform.publication_installation WHERE singleton",
        )
        .fetch_one(&a.identity.customers.pool)
        .await
        .map_err(|_| Error::Storage)?;
        a.deployment.allows_attribution(installation_id)
    } else {
        false
    };
    let etag = format!(
        "W/\"{}\"",
        infra_auth::digest(
            &json!({"version":id,"configuration":configuration,"cities":cities,"images":images,"discovery_attribution_enabled":discovery_attribution_enabled}).to_string()
        )
    );
    let unchanged = h
        .get("if-none-match")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|value| {
            value.split(',').any(|value| {
                let value = value.trim();
                value == "*" || value.trim_start_matches("W/") == etag.trim_start_matches("W/")
            })
        });
    let mut response = if unchanged {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        Json(json!({"version_id":id,"configuration":configuration,"cities":cities,"images":images,"discovery_attribution_enabled":discovery_attribution_enabled})).into_response()
    };
    let headers = response.headers_mut();
    headers.insert("cache-control", "private, no-cache".parse().unwrap());
    headers.insert(
        "vary",
        "Authorization, Cookie, X-Delivery-Latitude, X-Delivery-Longitude"
            .parse()
            .unwrap(),
    );
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("etag", etag.parse().unwrap());
    Ok(response)
}
