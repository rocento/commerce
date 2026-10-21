use std::time::Duration;

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::Row;
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::{
    accounts::{bearer, Accounts},
    domain::{normalize_slug, plans, require_organization, themes, valid_uuid, Principal},
    drafts::Drafts,
    error::{ApiError, ApiResult},
    AppState, RequestWindow,
};

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/plans", get(get_plans))
        .route("/api/v1/public/storefront-themes", get(get_themes))
        .route("/api/v1/customer/auth/register", post(register))
        .route("/api/v1/customer/auth/login", post(login))
        .route(
            "/api/v1/customer/auth/request-verification",
            post(request_verification),
        )
        .route(
            "/api/v1/customer/auth/forgot-password",
            post(forgot_password),
        )
        .route("/api/v1/customer/auth/verify", post(verify_account))
        .route("/api/v1/customer/auth/reset-password", post(reset_password))
        .route("/api/v1/customer/auth/logout", post(logout))
        .route("/api/v1/me", get(me))
        .route("/api/v1/onboarding/draft", get(get_draft))
        .route("/api/v1/onboarding/drafts/{id}", put(save_draft))
        .route(
            "/api/v1/onboarding/drafts/{id}/reserve",
            post(reserve_draft),
        )
        .route("/api/v1/registrations", post(legacy_registration))
        .route("/api/v1/slugs/check", post(check_slug))
        .route("/api/v1/stores", get(stores))
        .route("/api/v1/stores/{id}", get(store))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), hardening))
        .with_state(state)
}

async fn hardening(State(state): State<AppState>, request: Request<Body>, next: Next) -> Response {
    let limited = if request.uri().path().contains("/auth/") {
        let mut window = state
            .request_window
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if window.started.elapsed() > Duration::from_secs(60) {
            *window = RequestWindow::default();
        }
        window.requests += 1;
        window.requests > 120
    } else {
        false
    };
    let mut response = if limited {
        (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"code":"TOO_MANY_ATTEMPTS"})),
        )
            .into_response()
    } else {
        next.run(request).await
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "no-store".parse().expect("static header"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        "nosniff".parse().expect("static header"),
    );
    response
}

fn account(state: &AppState) -> ApiResult<&Accounts> {
    state
        .accounts
        .as_ref()
        .ok_or_else(|| ApiError::new("AUTH_NOT_CONFIGURED", StatusCode::SERVICE_UNAVAILABLE))
}

fn authorization(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
}

async fn principal(state: &AppState, authorization: Option<&str>) -> ApiResult<Principal> {
    if state.local_auth_enabled && !state.production {
        let expected = state
            .local_customer_token
            .as_deref()
            .filter(|token| token.len() >= 32)
            .ok_or_else(|| ApiError::unauthorized("UNAUTHENTICATED"))?;
        let candidate = bearer(authorization);
        let matches = candidate.len() == expected.len()
            && bool::from(candidate.as_bytes().ct_eq(expected.as_bytes()));
        if matches {
            return Ok(Principal::customer(
                "local-customer",
                "00000000-0000-4000-8000-000000000001",
            ));
        }
        return Err(ApiError::unauthorized("UNAUTHENTICATED"));
    }
    Ok(account(state)?.session(authorization).await?.1)
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "status":"ok",
        "mode":"onboarding",
        "provisioningEnabled":false,
        "authenticationConfigured":state.accounts.is_some()
    }))
}

async fn get_plans() -> Json<Value> {
    Json(plans())
}

async fn get_themes() -> Json<Value> {
    Json(json!({
        "items":themes(),
        "checkoutEnabled":false,
        "reason":"Approved artifacts and payment integration pending"
    }))
}

async fn register(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    Ok(Json(account(&state)?.register(&body).await?))
}

async fn login(State(state): State<AppState>, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    Ok(Json(account(&state)?.login(&body).await?))
}

async fn request_verification(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    Ok(Json(account(&state)?.request(&body, "verify").await?))
}

async fn forgot_password(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    Ok(Json(account(&state)?.request(&body, "reset").await?))
}

async fn verify_account(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    Ok(Json(account(&state)?.consume(&body, "verify").await?))
}

async fn reset_password(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    Ok(Json(account(&state)?.consume(&body, "reset").await?))
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    Ok(Json(
        account(&state)?.logout(authorization(&headers)).await?,
    ))
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    Ok(Json(
        account(&state)?.session(authorization(&headers)).await?.0,
    ))
}

async fn get_draft(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let principal = principal(&state, authorization(&headers)).await?;
    Ok(Json(Drafts::new(state.db.clone()).get(&principal).await?))
}

async fn save_draft(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    if !valid_uuid(&id) {
        return Err(crate::domain::uuid_not_found());
    }
    let principal = principal(&state, authorization(&headers)).await?;
    let saved = Drafts::new(state.db.clone())
        .save(
            &principal,
            Uuid::parse_str(&id).map_err(|_| crate::domain::uuid_not_found())?,
            &body,
        )
        .await?;
    Ok(Json(saved))
}

async fn reserve_draft(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    if !valid_uuid(&id) {
        return Err(crate::domain::uuid_not_found());
    }
    let version = body
        .get("version")
        .and_then(Value::as_i64)
        .filter(|value| (0..=i32::MAX as i64).contains(value))
        .map(|value| value as i32);
    let principal = principal(&state, authorization(&headers)).await?;
    let result = Drafts::new(state.db.clone())
        .reserve(
            &principal,
            Uuid::parse_str(&id).map_err(|_| crate::domain::uuid_not_found())?,
            version,
        )
        .await?;
    Ok(Json(result))
}

async fn legacy_registration(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let _ = principal(&state, authorization(&headers)).await?;
    Err(ApiError::new("USE_DRAFT_RESERVATION", StatusCode::GONE))
}

async fn check_slug(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let principal = principal(&state, authorization(&headers)).await?;
    require_organization(&principal)?;
    let slug = body
        .get("slug")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad("INVALID_SLUG"))?;
    let slug = normalize_slug(slug)?;
    Drafts::new(state.db.clone())
        .reconcile_expired_reservations(None)
        .await?;
    let rows = sqlx::query(
        "SELECT 1 FROM tenants WHERE store_slug=$1 AND lifecycle_status<>'RESERVATION_EXPIRED' \
         UNION ALL SELECT 1 FROM reserved_slugs WHERE slug=$1",
    )
    .bind(&slug)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        json!({"slug":slug,"available":rows.is_empty(),"advisory":true}),
    ))
}

async fn stores(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let principal = principal(&state, authorization(&headers)).await?;
    let org = require_organization(&principal)?;
    let org = Uuid::parse_str(org).map_err(|_| ApiError::forbidden("FORBIDDEN"))?;
    let rows = sqlx::query(
        "SELECT id,brand_display_name,store_slug,lifecycle_status FROM tenants \
         WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100",
    )
    .bind(org)
    .fetch_all(&state.db)
    .await?;
    let items = rows
        .iter()
        .map(|row| {
            Ok(json!({
                "id":row.try_get::<Uuid,_>("id").map_err(|_| ApiError::unavailable())?,
                "brand_display_name":row.try_get::<String,_>("brand_display_name").map_err(|_| ApiError::unavailable())?,
                "store_slug":row.try_get::<String,_>("store_slug").map_err(|_| ApiError::unavailable())?,
                "lifecycle_status":row.try_get::<String,_>("lifecycle_status").map_err(|_| ApiError::unavailable())?
            }))
        })
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(Json(json!(items)))
}

async fn store(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    if !valid_uuid(&id) {
        return Err(crate::domain::uuid_not_found());
    }
    let principal = principal(&state, authorization(&headers)).await?;
    let org = require_organization(&principal)?;
    let org = Uuid::parse_str(org).map_err(|_| ApiError::forbidden("FORBIDDEN"))?;
    let id = Uuid::parse_str(&id).map_err(|_| crate::domain::uuid_not_found())?;
    let row = sqlx::query("SELECT * FROM tenants WHERE id=$1 AND org_id=$2")
        .bind(id)
        .bind(org)
        .fetch_optional(&state.db)
        .await?;
    let Some(row) = row else {
        return Err(crate::domain::uuid_not_found());
    };
    let value = json!({
        "id":row.try_get::<Uuid,_>("id").map_err(|_| ApiError::unavailable())?,
        "org_id":row.try_get::<Uuid,_>("org_id").map_err(|_| ApiError::unavailable())?,
        "brand_display_name":row.try_get::<String,_>("brand_display_name").map_err(|_| ApiError::unavailable())?,
        "store_slug":row.try_get::<String,_>("store_slug").map_err(|_| ApiError::unavailable())?,
        "plan_id":row.try_get::<String,_>("plan_id").map_err(|_| ApiError::unavailable())?,
        "lifecycle_status":row.try_get::<String,_>("lifecycle_status").map_err(|_| ApiError::unavailable())?,
        "slug_reserved_until":row.try_get::<chrono::DateTime<chrono::Utc>,_>("slug_reserved_until").map_err(|_| ApiError::unavailable())?,
        "created_at":row.try_get::<chrono::DateTime<chrono::Utc>,_>("created_at").map_err(|_| ApiError::unavailable())?
    });
    Ok(Json(value))
}
