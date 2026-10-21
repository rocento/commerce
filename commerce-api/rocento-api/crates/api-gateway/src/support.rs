use crate::identity::{self, ApiError, App as Identity};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::HeaderMap,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use domain_support::{Actor, Reply, Service, TicketInput};
use uuid::Uuid;
#[derive(Clone)]
pub struct App {
    pub identity: Identity,
    pub tenant: Uuid,
}
impl App {
    fn service(&self) -> Service {
        Service {
            pool: self.identity.customers.pool.clone(),
            tenant: self.tenant,
        }
    }
}
pub fn router(a: App) -> Router {
    Router::new()
        .route("/v1/support/session", post(session))
        .route("/v1/support/tickets", post(create))
        .route("/v1/customer/support/tickets", get(customer_list))
        .route("/v1/customer/support/tickets/{id}", get(customer_detail))
        .route(
            "/v1/customer/support/tickets/{id}/messages",
            post(customer_reply),
        )
        .route("/v1/admin/support/tickets", get(admin_list))
        .route("/v1/admin/support/tickets/{id}", get(admin_detail))
        .route("/v1/admin/support/tickets/{id}/messages", post(admin_reply))
        .layer(middleware::from_fn(crate::assistant::request_deadline))
        .layer(DefaultBodyLimit::max(16384))
        .layer(middleware::from_fn_with_state(
            a.identity.clone(),
            identity::policy,
        ))
        .with_state(a)
}
async fn create(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<TicketInput>,
) -> Result<Response, ApiError> {
    let customer = if h.contains_key("authorization") {
        Some(
            a.identity
                .customers
                .authenticate(identity::bearer(&h)?)
                .await?
                .id,
        )
    } else {
        None
    };
    let current = identity::cookie(&h, "support_guest");
    if customer.is_none()
        && !(current.len() == 48 && current.bytes().all(|c| c.is_ascii_alphanumeric()))
    {
        return Err(infra_auth::Error::Invalid(
            "Initialize a support session before submitting".into(),
        )
        .into());
    }
    let guest = current.to_owned();
    // Subject, source and installation admission is enforced by identity::policy.
    let actor = customer
        .map(Actor::Customer)
        .unwrap_or(Actor::Guest(&guest));
    let detail = a.service().create(&actor, &i).await?;
    let mut response = (axum::http::StatusCode::CREATED, Json(detail)).into_response();
    if customer.is_none() {
        response.headers_mut().insert(
            "set-cookie",
            identity::session_cookie(
                "support_guest",
                &guest,
                86400,
                &a.identity.customers.security,
            )
            .parse()
            .map_err(|_| infra_auth::Error::Internal)?,
        );
    }
    Ok(response)
}
async fn customer_list(State(a): State<App>, h: HeaderMap) -> Result<impl IntoResponse, ApiError> {
    let c = a
        .identity
        .customers
        .authenticate(identity::bearer(&h)?)
        .await?;
    Ok(Json(a.service().list(&Actor::Customer(c.id)).await?))
}
async fn customer_detail(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    let c = a
        .identity
        .customers
        .authenticate(identity::bearer(&h)?)
        .await?;
    Ok(Json(a.service().detail(id, &Actor::Customer(c.id)).await?))
}
async fn customer_reply(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<Reply>,
) -> Result<impl IntoResponse, ApiError> {
    let c = a
        .identity
        .customers
        .authenticate(identity::bearer(&h)?)
        .await?;
    Ok(Json(
        a.service().reply(id, &Actor::Customer(c.id), &i).await?,
    ))
}
async fn admin_list(State(a): State<App>, h: HeaderMap) -> Result<impl IntoResponse, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?;
    Ok(Json(a.service().list(&Actor::Admin(&who)).await?))
}
async fn admin_detail(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?;
    Ok(Json(a.service().detail(id, &Actor::Admin(&who)).await?))
}
async fn admin_reply(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<Reply>,
) -> Result<impl IntoResponse, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?;
    Ok(Json(a.service().reply(id, &Actor::Admin(&who), &i).await?))
}

async fn session(State(a): State<App>, h: HeaderMap) -> Result<Response, ApiError> {
    let current = identity::cookie(&h, "support_guest");
    let token = if current.len() == 48 && current.bytes().all(|c| c.is_ascii_alphanumeric()) {
        current.to_owned()
    } else {
        infra_auth::token()
    };
    let mut response = Json(serde_json::json!({"status":"ok"})).into_response();
    response.headers_mut().insert(
        "set-cookie",
        identity::session_cookie(
            "support_guest",
            &token,
            86400,
            &a.identity.customers.security,
        )
        .parse()
        .map_err(|_| infra_auth::Error::Internal)?,
    );
    Ok(response)
}
