use axum::{
    extract::{ConnectInfo, DefaultBodyLimit, Path, Query, Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use domain_admin_iam as admins;
use domain_customers as customers;
use infra_auth::{Error, Security};
use std::net::SocketAddr;
use uuid::Uuid;
#[derive(Clone)]
pub struct App {
    pub engagement: sqlx::PgPool,
    pub engagement_isolated: bool,
    pub engagement_commerce: sqlx::PgPool,
    pub customers: customers::Service,
    pub admins: admins::Service,
    pub origins: Vec<String>,
    pub auth_ip_rate_limit: crate::auth_ip::AuthIpRateLimit,
    pub public_admission: crate::auth_ip::PublicAdmission,
    pub cart: domain_cart_checkout::Service,
}
impl App {
    pub fn new(pool: sqlx::PgPool, security: Security, origins: Vec<String>) -> Self {
        let inventory = domain_inventory::Service {
            pool: pool.clone(),
            ttl_seconds: 900,
        };
        Self {
            engagement: pool.clone(),
            engagement_isolated: false,
            engagement_commerce: pool.clone(),
            cart: domain_cart_checkout::Service {
                pool: pool.clone(),
                inventory,
            },
            customers: customers::Service {
                pool: pool.clone(),
                security: security.clone(),
            },
            admins: admins::Service { pool, security },
            origins,
            auth_ip_rate_limit: crate::auth_ip::AuthIpRateLimit::default(),
            public_admission: crate::auth_ip::PublicAdmission::default(),
        }
    }
}
pub struct ApiError(Error);
impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        Self(Error::from(error))
    }
}
impl From<Error> for ApiError {
    fn from(error: Error) -> Self {
        Self(error)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let stale = domain_cart_checkout::error::StaleProposal::from_error(&self.0).is_some();
        let analytics_unavailable = matches!(&self.0, Error::Business(error)
            if error.is::<crate::analytics::Unavailable>());
        let database_busy = matches!(&self.0, Error::Database(sqlx::Error::PoolTimedOut))
            || matches!(&self.0, Error::Database(sqlx::Error::Database(error))
                if error.code().is_some_and(|code| matches!(code.as_ref(), "55P03" | "57014")));
        let status = match &self.0 {
            Error::Invalid(_) => StatusCode::BAD_REQUEST,
            Error::Unauthorized => StatusCode::UNAUTHORIZED,
            Error::Forbidden => StatusCode::FORBIDDEN,
            Error::NotFound => StatusCode::NOT_FOUND,
            Error::Conflict => StatusCode::CONFLICT,
            Error::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            Error::Busy => StatusCode::SERVICE_UNAVAILABLE,
            _ if analytics_unavailable => StatusCode::SERVICE_UNAVAILABLE,
            _ if database_busy => StatusCode::SERVICE_UNAVAILABLE,
            Error::Business(_) if stale => StatusCode::BAD_REQUEST,
            Error::Database(sqlx::Error::Database(e))
                if e.is_unique_violation() || e.is_foreign_key_violation() =>
            {
                StatusCode::CONFLICT
            }
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let message = if database_busy {
            "Service is busy. Please try again shortly.".into()
        } else if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!(error=%self.0,"request failed");
            "Internal service error".into()
        } else if status == StatusCode::CONFLICT {
            "Record already exists or is still in use".into()
        } else {
            self.0.to_string()
        };
        let capacity_code = match &self.0 {
            Error::Invalid(code)
                if [
                    "SLOT_FULL",
                    "SLOT_DISABLED",
                    "SLOT_UNAVAILABLE",
                    "INVENTORY_UNAVAILABLE",
                    "OUTSIDE_DELIVERY_AREA",
                    "RESERVATION_EXPIRED",
                    "RESERVATION_STALE",
                    "RESERVATION_CONFIRMED",
                    "SLOT_SELECTION_REQUIRED",
                    "IDEMPOTENCY_CONFLICT",
                    "CAPACITY_FACTS_MISSING",
                    "CAPACITY_CHANGE_ACKNOWLEDGEMENT_REQUIRED",
                ]
                .contains(&code.as_str()) =>
            {
                Some(code.as_str())
            }
            _ => None,
        };
        let payload = if stale {
            serde_json::json!({"code":message,"error":message})
        } else if let Error::Invalid(code) = &self.0 {
            if let Some(capability) = code.strip_prefix("FULFILLMENT_CAPABILITY_DISABLED:") {
                serde_json::json!({"code":"FULFILLMENT_CAPABILITY_DISABLED","capability":capability,"error":"This fulfillment option is disabled for this store."})
            } else if let Some(code) = capacity_code {
                serde_json::json!({"code":code,"error":"Fulfillment selection is unavailable or has changed. Please review your options."})
            } else {
                serde_json::json!({"code":code,"error":message})
            }
        } else if let Some(code) = capacity_code {
            serde_json::json!({"code":code,"error":"Delivery selection is unavailable or has changed. Please review delivery options."})
        } else {
            serde_json::json!({"error":message})
        };
        let mut response = (status, Json(payload)).into_response();
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
        response
            .headers_mut()
            .insert("x-content-type-options", "nosniff".parse().unwrap());
        if stale {
            response
                .extensions_mut()
                .insert(crate::assistant_failures::StaleProposal);
        }
        if status == StatusCode::TOO_MANY_REQUESTS {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, "900".parse().unwrap());
        } else if matches!(self.0, Error::Busy) || database_busy || analytics_unavailable {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, "3".parse().unwrap());
        }
        response
    }
}
type Result<T> = std::result::Result<T, ApiError>;
pub(crate) fn cookie<'a>(h: &'a HeaderMap, name: &str) -> &'a str {
    h.get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| {
            s.split(';').find_map(|p| {
                p.trim()
                    .split_once('=')
                    .filter(|(n, _)| *n == name)
                    .map(|(_, v)| v)
            })
        })
        .unwrap_or("")
}
pub(crate) fn bearer(h: &HeaderMap) -> std::result::Result<&str, Error> {
    h.get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(Error::Unauthorized)
}
pub(crate) fn session_cookie(name: &str, value: &str, seconds: u32, security: &Security) -> String {
    format!(
        "{name}={value}; HttpOnly; SameSite=Strict; Path=/; Max-Age={seconds}{}",
        if security.secure_cookies {
            "; Secure"
        } else {
            ""
        }
    )
}
fn with_cookie<T: serde::Serialize>(
    body: T,
    name: &str,
    value: &str,
    seconds: u32,
    security: &Security,
) -> Response {
    let mut response = Json(body).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        session_cookie(name, value, seconds, security)
            .parse()
            .unwrap(),
    );
    response
}
fn ok() -> Json<serde_json::Value> {
    Json(serde_json::json!({"status":"ok"}))
}
pub(crate) async fn policy(State(app): State<App>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let proposal = path == "/v1/cart/proposals"
        || path.starts_with("/v1/cart/proposals/")
        || path.starts_with("/v1/cart/shopping/")
        || path.starts_with("/v1/assistant-tools/baskets/");
    let typed = (proposal || path == "/v1/assistant/chat")
        && request
            .headers()
            .get("x-commerce-assistant-errors")
            .is_some_and(|v| v == "1");
    let reference = request
        .headers()
        .get("x-commerce-request-reference")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| Uuid::parse_str(v).ok())
        .unwrap_or_else(Uuid::new_v4);
    let response = policy_inner(app, request, next).await;
    if typed {
        crate::assistant_failures::decorate(response, reference, proposal)
    } else {
        response
    }
}
async fn policy_inner(app: App, request: Request, next: Next) -> Response {
    if ![
        axum::http::Method::GET,
        axum::http::Method::HEAD,
        axum::http::Method::OPTIONS,
    ]
    .contains(request.method())
    {
        if request
            .headers()
            .get("x-commerce-request")
            .and_then(|v| v.to_str().ok())
            != Some("1")
        {
            return ApiError(Error::Forbidden).into_response();
        }
        if let Some(origin) = request.headers().get(header::ORIGIN) {
            if !origin
                .to_str()
                .is_ok_and(|o| app.origins.iter().any(|a| a == o))
            {
                return ApiError(Error::Forbidden).into_response();
            }
        }
    }
    if request.uri().path().contains("/auth/")
        && app.auth_ip_rate_limit == crate::auth_ip::AuthIpRateLimit::Peer
    {
        // Default direct-peer mode never trusts caller-supplied proxy headers.
        // Managed ingress mode enforces client-IP limits before Docker proxying;
        // per-account throttles remain in the domain services in either mode.
        let peer = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|v| v.0.ip().to_string())
            .unwrap_or_else(|| "in-process".into());
        let key = format!("http:auth:{peer}");
        if let Err(error) = infra_auth::rate_limit(&app.customers.pool, &key, 100).await {
            return ApiError(error).into_response();
        }
    }
    let mut visitor_cookie = None;
    if let Some((service, budget, cookie_name)) = app
        .public_admission
        .route(request.uri().path(), request.method())
    {
        // Peer mode never trusts forwarded headers. Ingress mode delegates the
        // source budget to managed Nginx, whose real-IP trust is explicitly configured.
        let source = (app.auth_ip_rate_limit == crate::auth_ip::AuthIpRateLimit::Peer).then(|| {
            request
                .extensions()
                .get::<ConnectInfo<SocketAddr>>()
                .map(|peer| {
                    match peer.0.ip() {
                        std::net::IpAddr::V6(ip) => ip
                            .to_ipv4_mapped()
                            .map(std::net::IpAddr::V4)
                            .unwrap_or(std::net::IpAddr::V6(ip)),
                        ip => ip,
                    }
                    .to_string()
                })
                .unwrap_or_else(|| "in-process".into())
        });
        let subject = if let Some(claims) = bearer(request.headers())
            .ok()
            .and_then(|token| app.customers.security.decode(token).ok())
        {
            // This key grants no authority: the handler still checks the live session.
            format!("customer:{}", claims.sub)
        } else {
            let current = cookie(request.headers(), cookie_name);
            let token = if current.len() == 48 && current.bytes().all(|b| b.is_ascii_alphanumeric())
            {
                current.to_owned()
            } else {
                let token = infra_auth::token();
                visitor_cookie = Some((cookie_name, token.clone()));
                token
            };
            format!("guest:{}", infra_auth::digest(&token))
        };
        let mut buckets = vec![
            (
                format!("public:{service}:subject:{subject}"),
                budget.subject,
            ),
            (format!("public:{service}:installation"), budget.aggregate),
        ];
        if let Some(source) = source {
            buckets.push((format!("public:{service}:source:{source}"), budget.source));
        }
        if let Err(error) = infra_auth::admit(
            if request.uri().path() == "/v1/analytics/events" {
                &app.engagement
            } else {
                &app.customers.pool
            },
            &buckets,
        )
        .await
        {
            return ApiError(error).into_response();
        }
    }
    let mut response = next.run(request).await;
    if let Some((name, token)) = visitor_cookie {
        response.headers_mut().append(
            header::SET_COOKIE,
            session_cookie(name, &token, 86400, &app.customers.security)
                .parse()
                .unwrap(),
        );
    }
    if response.status().is_client_error()
        && response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            != Some("application/json")
    {
        response = (
            response.status(),
            Json(serde_json::json!({"error":"Invalid request body or route parameters"})),
        )
            .into_response();
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response
}
pub fn router(app: App) -> Router {
    Router::new()
        .route("/v1/customer/auth/register", post(register))
        .route("/v1/customer/auth/login", post(login))
        .route("/v1/customer/auth/refresh", post(refresh))
        .route("/v1/customer/auth/logout", post(logout))
        .route(
            "/v1/customer/auth/request-verification",
            post(request_verify),
        )
        .route("/v1/customer/auth/verify", post(verify))
        .route("/v1/customer/auth/forgot-password", post(forgot))
        .route("/v1/customer/auth/reset-password", post(reset))
        .route("/v1/customer/me", get(me))
        .route("/v1/customer/checkout-eligibility", get(eligible))
        .route(
            "/v1/customer/locations",
            get(locations).post(create_location),
        )
        .route(
            "/v1/customer/locations/{id}",
            axum::routing::put(update_location).delete(delete_location),
        )
        .route("/v1/admin/auth/login", post(admin_login))
        .route("/v1/admin/auth/logout", post(admin_logout))
        .route("/v1/admin/me", get(admin_me))
        .route("/v1/admin/users", get(users).post(create_user))
        .route(
            "/v1/admin/users/{id}",
            axum::routing::put(update_user).delete(delete_user),
        )
        .route("/v1/admin/roles", get(roles).post(create_role))
        .route(
            "/v1/admin/roles/{id}",
            axum::routing::put(update_role).delete(delete_role),
        )
        .route("/v1/admin/audit", get(audit))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(middleware::from_fn_with_state(app.clone(), policy))
        .with_state(app)
}
async fn register(
    State(a): State<App>,
    Json(i): Json<customers::Credentials>,
) -> Result<impl IntoResponse> {
    Ok((StatusCode::CREATED, Json(a.customers.register(i).await?)))
}
async fn login(
    State(a): State<App>,
    h: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    Json(i): Json<customers::Credentials>,
) -> Result<Response> {
    let l = a.customers.login(i).await?;
    domain_customers::memory::revoke_guest(&a.customers.pool, cookie(&h, "assistant_guest"))
        .await?;
    a.cart
        .open(Some(l.body.customer.id), cookie(&h, "guest_cart"))
        .await?;
    crate::login_alerts::enqueue(
        &a.customers.pool,
        l.body.customer.email.as_deref().unwrap_or(""),
        "customer",
        &a.customers.security.storefront_url,
        a.auth_ip_rate_limit,
        &h,
        peer.map(|p| p.0 .0.ip()),
    )
    .await?;
    let mut response = with_cookie(
        l.body,
        "customer_refresh",
        &l.refresh,
        2592000,
        &a.customers.security,
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        session_cookie("guest_cart", "", 0, &a.customers.security)
            .parse()
            .unwrap(),
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        session_cookie("assistant_guest", "", 0, &a.customers.security)
            .parse()
            .unwrap(),
    );
    Ok(response)
}
async fn refresh(State(a): State<App>, h: HeaderMap) -> Result<Response> {
    let refresh = cookie(&h, "customer_refresh");
    // A storefront checks for an existing session on first load. A guest has
    // no credential to refresh; do not report this normal state as an HTTP
    // authentication failure. Supplied credentials still receive full validation.
    if refresh.is_empty() {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let l = a.customers.refresh(refresh).await?;
    Ok(with_cookie(
        l.body,
        "customer_refresh",
        &l.refresh,
        2592000,
        &a.customers.security,
    ))
}
async fn logout(State(a): State<App>, h: HeaderMap) -> Result<Response> {
    a.customers
        .logout(cookie(&h, "customer_refresh"), bearer(&h).ok())
        .await?;
    Ok(with_cookie(
        serde_json::json!({"status":"ok"}),
        "customer_refresh",
        "",
        0,
        &a.customers.security,
    ))
}
async fn request_verify(
    State(a): State<App>,
    Json(i): Json<customers::ChallengeRequest>,
) -> Result<impl IntoResponse> {
    a.customers.request_challenge(i, "verify").await?;
    Ok(ok())
}
async fn forgot(
    State(a): State<App>,
    Json(i): Json<customers::ChallengeRequest>,
) -> Result<impl IntoResponse> {
    a.customers.request_challenge(i, "reset").await?;
    Ok(ok())
}
async fn verify(
    State(a): State<App>,
    Json(i): Json<customers::Verify>,
) -> Result<impl IntoResponse> {
    a.customers.verify(i).await?;
    Ok(ok())
}
async fn reset(State(a): State<App>, Json(i): Json<customers::Reset>) -> Result<impl IntoResponse> {
    a.customers.reset(i).await?;
    Ok(ok())
}
async fn me(State(a): State<App>, h: HeaderMap) -> Result<impl IntoResponse> {
    Ok(Json(a.customers.authenticate(bearer(&h)?).await?))
}
async fn eligible(State(a): State<App>, h: HeaderMap) -> Result<impl IntoResponse> {
    a.customers.require_verified(bearer(&h)?).await?;
    Ok(ok())
}
async fn locations(State(a): State<App>, h: HeaderMap) -> Result<impl IntoResponse> {
    let c = a.customers.authenticate(bearer(&h)?).await?;
    Ok(Json(a.customers.locations(c.id).await?))
}
async fn create_location(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<customers::LocationInput>,
) -> Result<impl IntoResponse> {
    let c = a.customers.authenticate(bearer(&h)?).await?;
    Ok((
        StatusCode::CREATED,
        Json(a.customers.save_location(c.id, None, i).await?),
    ))
}
async fn update_location(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<customers::LocationInput>,
) -> Result<impl IntoResponse> {
    let c = a.customers.authenticate(bearer(&h)?).await?;
    Ok(Json(a.customers.save_location(c.id, Some(id), i).await?))
}
async fn delete_location(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse> {
    let c = a.customers.authenticate(bearer(&h)?).await?;
    a.customers.delete_location(c.id, id).await?;
    Ok(ok())
}
async fn admin_login(
    State(a): State<App>,
    h: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    Json(i): Json<admins::Credentials>,
) -> Result<Response> {
    let (who, token) = a.admins.login(i).await?;
    crate::login_alerts::enqueue(
        &a.customers.pool,
        &who.user.email,
        "admin",
        &a.customers.security.storefront_url,
        a.auth_ip_rate_limit,
        &h,
        peer.map(|p| p.0 .0.ip()),
    )
    .await?;
    Ok(with_cookie(
        who,
        "admin_session",
        &token,
        28800,
        &a.admins.security,
    ))
}
async fn admin_logout(State(a): State<App>, h: HeaderMap) -> Result<Response> {
    a.admins.logout(cookie(&h, "admin_session")).await?;
    Ok(with_cookie(
        serde_json::json!({"status":"ok"}),
        "admin_session",
        "",
        0,
        &a.admins.security,
    ))
}
async fn admin_me(State(a): State<App>, h: HeaderMap) -> Result<impl IntoResponse> {
    Ok(Json(
        a.admins.authenticate(cookie(&h, "admin_session")).await?,
    ))
}
async fn users(State(a): State<App>, h: HeaderMap) -> Result<impl IntoResponse> {
    let who = a.admins.authenticate(cookie(&h, "admin_session")).await?;
    Ok(Json(a.admins.users(&who).await?))
}
async fn roles(State(a): State<App>, h: HeaderMap) -> Result<impl IntoResponse> {
    let who = a.admins.authenticate(cookie(&h, "admin_session")).await?;
    Ok(Json(a.admins.roles(&who).await?))
}
#[derive(serde::Deserialize, Default)]
struct AuditQuery {
    q: Option<String>,
    offset: Option<i64>,
}
async fn audit(
    State(a): State<App>,
    h: HeaderMap,
    Query(p): Query<AuditQuery>,
) -> Result<impl IntoResponse> {
    let who = a.admins.authenticate(cookie(&h, "admin_session")).await?;
    Ok(Json(
        a.admins
            .search_audits(&who, p.q.as_deref().unwrap_or(""), p.offset.unwrap_or(0))
            .await?,
    ))
}
async fn create_user(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<admins::UserInput>,
) -> Result<impl IntoResponse> {
    let who = a.admins.authenticate(cookie(&h, "admin_session")).await?;
    Ok((
        StatusCode::CREATED,
        Json(a.admins.save_user(&who, None, i).await?),
    ))
}
async fn update_user(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<admins::UserInput>,
) -> Result<impl IntoResponse> {
    let who = a.admins.authenticate(cookie(&h, "admin_session")).await?;
    Ok(Json(a.admins.save_user(&who, Some(id), i).await?))
}
async fn delete_user(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse> {
    let who = a.admins.authenticate(cookie(&h, "admin_session")).await?;
    a.admins.delete_user(&who, id).await?;
    Ok(ok())
}
async fn create_role(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<admins::RoleInput>,
) -> Result<impl IntoResponse> {
    let who = a.admins.authenticate(cookie(&h, "admin_session")).await?;
    Ok((
        StatusCode::CREATED,
        Json(a.admins.save_role(&who, None, i).await?),
    ))
}
async fn update_role(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<admins::RoleInput>,
) -> Result<impl IntoResponse> {
    let who = a.admins.authenticate(cookie(&h, "admin_session")).await?;
    Ok(Json(a.admins.save_role(&who, Some(id), i).await?))
}
async fn delete_role(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse> {
    let who = a.admins.authenticate(cookie(&h, "admin_session")).await?;
    a.admins.delete_role(&who, id).await?;
    Ok(ok())
}

#[cfg(test)]
mod error_tests {
    use super::*;
    use domain_cart_checkout::error::StaleProposal;
    use http_body_util::BodyExt;

    async fn payload(response: Response) -> serde_json::Value {
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }

    #[tokio::test]
    async fn typed_stale_errors_preserve_http_and_assistant_contracts() {
        for cause in [
            StaleProposal::CartRevisionChanged,
            StaleProposal::ProposalUnavailable,
            StaleProposal::QuoteFactsChanged,
        ] {
            let response = ApiError::from(Error::from(cause)).into_response();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert!(response
                .extensions()
                .get::<crate::assistant_failures::StaleProposal>()
                .is_some());
            assert!(response.headers().get(header::RETRY_AFTER).is_none());
            assert_eq!(
                payload(response).await,
                serde_json::json!({"code":cause.to_string(),"error":cause.to_string()})
            );
        }
    }

    #[tokio::test]
    async fn matching_english_message_does_not_classify_a_failure_as_stale() {
        let message = StaleProposal::CartRevisionChanged.to_string();
        let response = ApiError::from(Error::Invalid(message.clone())).into_response();
        assert!(response
            .extensions()
            .get::<crate::assistant_failures::StaleProposal>()
            .is_none());
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            payload(response).await,
            serde_json::json!({"code":message,"error":message})
        );
    }

    #[tokio::test]
    async fn unknown_business_errors_are_sanitized() {
        let response = ApiError::from(Error::Business(Box::new(std::io::Error::other(
            "private domain details",
        ))))
        .into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(response
            .extensions()
            .get::<crate::assistant_failures::StaleProposal>()
            .is_none());
        assert_eq!(
            payload(response).await,
            serde_json::json!({"error":"Internal service error"})
        );
    }

    #[tokio::test]
    async fn hashing_overload_has_a_short_retry_without_changing_account_throttle() {
        let response = ApiError::from(Error::Busy).into_response();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[header::RETRY_AFTER], "3");
        assert_eq!(
            payload(response).await,
            serde_json::json!({"error":"Authentication is busy. Please try again shortly."})
        );
        let response = ApiError::from(Error::RateLimited).into_response();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()[header::RETRY_AFTER], "900");
    }
}
