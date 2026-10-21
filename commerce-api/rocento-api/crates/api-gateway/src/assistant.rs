//! Deployment-scoped assistant delegation. No Commerce bearer tokens leave Rust.
#[path = "assistant_compound.rs"]
pub mod compound;
#[path = "assistant_memory.rs"]
pub mod memory;
#[path = "assistant_reorder.rs"]
pub mod reorder;
#[path = "assistant_trust.rs"]
pub mod trust;
use crate::identity::{self, ApiError, App as Identity};
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use uuid::Uuid;

#[derive(Clone)]
pub struct App {
    pub identity: Identity,
    pub tenant: Uuid,
    pub signing: Arc<jsonwebtoken::EncodingKey>,
    pub verifying: Arc<jsonwebtoken::DecodingKey>,
    pub client: reqwest::Client,
    pub slots: Arc<tokio::sync::Semaphore>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Claims {
    pub iss: String,
    pub aud: String,
    pub tenant: Uuid,
    pub sub: Option<Uuid>,
    pub sid: Option<Uuid>,
    pub request_id: Uuid,
    pub iat: i64,
    pub exp: i64,
    pub scope: String,
}
impl App {
    pub fn environment(identity: Identity) -> Result<Self, Box<dyn std::error::Error>> {
        let tenant: Uuid = std::env::var("ASSISTANT_TENANT_ID")?.parse()?;
        if tenant.is_nil() {
            return Err("Assistant tenant must not be nil".into());
        }
        let signing = jsonwebtoken::EncodingKey::from_rsa_pem(&std::fs::read(std::env::var(
            "ASSISTANT_PRIVATE_KEY_FILE",
        )?)?)?;
        let verifying = jsonwebtoken::DecodingKey::from_rsa_pem(&std::fs::read(std::env::var(
            "ASSISTANT_PUBLIC_KEY_FILE",
        )?)?)?;
        Ok(Self {
            identity,
            tenant,
            signing: Arc::new(signing),
            verifying: Arc::new(verifying),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(1))
                .timeout(Duration::from_secs(30))
                .build()?,
            slots: Arc::new(tokio::sync::Semaphore::new(8)),
        })
    }
    pub fn sign(&self, claims: &Claims) -> Result<String, Error> {
        jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
            claims,
            &self.signing,
        )
        .map_err(|_| Error::Internal)
    }
    pub fn decode(&self, token: &str, scope: &str) -> Result<Claims, Error> {
        let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
        validation.set_issuer(&["commerce-assistant"]);
        validation.set_audience(&["assistant-tools"]);
        validation.leeway = 0;
        let c = jsonwebtoken::decode::<Claims>(token, &self.verifying, &validation)
            .map_err(|_| Error::Unauthorized)?
            .claims;
        if c.tenant != self.tenant
            || c.scope != scope
            || c.exp - c.iat > 60
            || c.iat > chrono::Utc::now().timestamp()
            || c.sub.is_none() != c.sid.is_none()
        {
            return Err(Error::Forbidden);
        }
        Ok(c)
    }
    pub async fn customer(&self, c: &Claims) -> Result<Uuid, Error> {
        let owner = c.sub.ok_or(Error::Unauthorized)?;
        // Delegate session lookup to the owning customer service, never trust an asserted sub alone.
        self.identity
            .customers
            .authorize_session(owner, c.sid.ok_or(Error::Unauthorized)?)
            .await?;
        Ok(owner)
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClarificationKind {
    Shopping,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Clarification {
    pub original_message: String,
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<Uuid>,
    // Echo the public question metadata; the AI service resolves replies only
    // against its stored, scoped question, never these client-supplied choices.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ClarificationKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub optional: Option<bool>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ChatInput {
    pub request_id: Uuid,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cart_context: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticket: Option<domain_support::TicketInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    // Accepted for older clients only; language-engine routing owns journey selection.
    pub shopping_mode: Option<domain_cart_checkout::shopping::Mode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clarification: Option<Clarification>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WishlistTransferInput {
    product_ids: Vec<Uuid>,
}

pub fn router(identity: Identity, configured: Option<App>) -> Router {
    let settings_router = crate::assistant_settings::router(identity.clone(), configured.clone())
        .merge(crate::assistant_baseline::router(
            identity.clone(),
            configured.clone(),
        ))
        .merge(crate::assistant_tracking::router(
            identity.clone(),
            configured.clone(),
        ));
    let public = if let Some(app) = configured {
        memory::maintenance(&app);
        Router::new()
            .merge(memory::routes())
            .merge(trust::routes())
            .route("/v1/assistant/chat", post(chat))
            .route("/v1/assistant/history", get(history))
            .route("/v1/assistant/delivery-event", post(delivery_event))
            .route("/v1/assistant/feedback", post(feedback))
            .route("/v1/admin/assistant/usage", get(usage))
            .with_state(app.clone())
            .merge(
                Router::new()
                    .route(
                        "/v1/assistant-tools/shopper",
                        post(crate::assistant_catalog::execute),
                    )
                    .route("/v1/assistant-tools/cart", get(cart).post(change_cart))
                    .route(
                        "/v1/assistant-tools/compound-actions",
                        post(compound::apply),
                    )
                    .route(
                        "/v1/assistant-tools/compound-actions/receipt",
                        post(compound::receipt),
                    )
                    .route(
                        "/v1/assistant-tools/cart/wishlist-transfer",
                        post(transfer_wishlist_to_cart),
                    )
                    .route(
                        "/v1/assistant-tools/wishlist",
                        get(wishlist)
                            .post(add_wishlist_item)
                            .delete(remove_wishlist_item),
                    )
                    .route("/v1/assistant-tools/orders", get(order_history))
                    .route("/v1/assistant-tools/locations", get(saved_locations))
                    .route(
                        "/v1/assistant-tools/support/tickets",
                        get(support_tickets).post(ticket),
                    )
                    .route(
                        "/v1/assistant-tools/support/tickets/{id}",
                        get(support_ticket_detail),
                    )
                    .route("/v1/assistant-tools/reorder", post(reorder::execute))
                    .route(
                        "/v1/assistant-tools/baskets/{cart}",
                        get(crate::shopping::tool_context).post(crate::shopping::tool_propose),
                    )
                    .route("/v1/assistant-tools/delivery", get(delivery))
                    .route("/v1/assistant-tools/orders/{id}", get(order))
                    .route(
                        "/v1/assistant-tools/orders/by-number/{number}",
                        get(order_by_number),
                    )
                    .with_state(app),
            )
    } else {
        Router::new()
            .route("/v1/assistant/chat", post(|| async { unavailable() }))
            .route("/v1/admin/assistant/usage", get(unavailable_usage))
            .with_state(identity.clone())
    };
    public
        .layer(middleware::from_fn(request_deadline))
        .merge(settings_router)
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(middleware::from_fn_with_state(identity, identity::policy))
}
fn unavailable() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({"error":"Assistant temporarily unavailable. You can still contact support."}))).into_response()
}

async fn unavailable_usage(
    State(a): State<Identity>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    a.admins
        .authenticate(identity::cookie(&headers, "admin_session"))
        .await?
        .require("reports.read")?;
    Ok(unavailable())
}
async fn chat(
    State(a): State<App>,
    headers: HeaderMap,
    Json(input): Json<ChatInput>,
) -> Result<Response, ApiError> {
    let permit = match a.slots.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            return Ok((
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::json!({"error":"Assistant is busy. Please retry."})),
            )
                .into_response());
        }
    };
    infra_auth::bounded(&input.message, "message", 4000, true)?;
    if [
        input.order_id.is_some(),
        input.product_id.is_some(),
        input.cart_context.unwrap_or(false),
    ]
    .into_iter()
    .filter(|selected| *selected)
    .count()
        > 1
    {
        return Err(Error::Invalid("Choose only one conversation context".into()).into());
    }
    if let Some(ref clarification) = input.clarification {
        infra_auth::bounded(
            &clarification.original_message,
            "original_message",
            4000,
            true,
        )?;
        infra_auth::bounded(&clarification.question, "question", 1000, true)?;
        if let Some(choices) = &clarification.choices {
            if choices.len() > 8 || choices.iter().any(|choice| choice.chars().count() > 120) {
                return Err(Error::Invalid(
                    "Clarification choices exceed the allowed bounds".into(),
                )
                .into());
            }
        }
        if input.ticket.is_some() {
            return Err(Error::Invalid(
                "Clarification cannot be combined with another journey".into(),
            )
            .into());
        }
    }
    let (sub, sid) = if headers.contains_key("authorization") {
        let token = identity::bearer(&headers)?;
        let customer = a.identity.customers.authenticate(token).await?;
        (
            Some(customer.id),
            Some(a.identity.customers.security.decode(token)?.sid),
        )
    } else {
        (None, None)
    };
    // Subject, source and installation admission is enforced by identity::policy.
    let now = chrono::Utc::now().timestamp();
    let mut claims = Claims {
        iss: "commerce-assistant".into(),
        aud: "ai-service".into(),
        tenant: a.tenant,
        sub,
        sid,
        request_id: input.request_id,
        iat: now,
        exp: now + 45,
        scope: "chat".into(),
    };
    let context = a.sign(&claims)?;
    claims.aud = "assistant-tools".into();
    claims.scope = if input.ticket.is_some() {
        "support_create"
    } else {
        "order_status"
    }
    .into();
    let tool = a.sign(&claims)?;
    claims.scope = "shopper_read".into();
    let catalog_tool = a.sign(&claims)?;
    claims.scope = "cart_read".into();
    let cart_tool = a.sign(&claims)?;
    claims.scope = "cart_write".into();
    let cart_write_tool = a.sign(&claims)?;
    claims.scope = "wishlist_cart_transfer".into();
    let wishlist_cart_transfer_tool = a.sign(&claims)?;
    claims.scope = "wishlist_read".into();
    let wishlist_tool = a.sign(&claims)?;
    claims.scope = "wishlist_write".into();
    let wishlist_write_tool = a.sign(&claims)?;
    claims.scope = "locations_read".into();
    let locations_tool = a.sign(&claims)?;
    claims.scope = "support_read".into();
    let support_tool = a.sign(&claims)?;
    // Validate location syntax before forwarding. The model never supplies these headers.
    crate::areas::pin(&headers)?;
    let mut delegated = HeaderMap::new();
    if let Some(conversation) = input.conversation_id.filter(|id| !id.is_nil()) {
        if sub.is_some() && input.ticket.is_none() {
            claims.scope = format!("compound_read:{conversation}");
            delegated.insert(
                "x-commerce-compound-read-token",
                a.sign(&claims)?.parse().map_err(|_| Error::Internal)?,
            );
            if compound::writes_enabled() {
                claims.scope = format!("compound_write:{conversation}");
                delegated.insert(
                    "x-commerce-compound-write-token",
                    a.sign(&claims)?.parse().map_err(|_| Error::Internal)?,
                );
            }
        }
    }
    if input.clarification.is_none() && sub.is_some() && input.ticket.is_none() {
        if let Some(number) = reorder::command_order_number(&input.message) {
            claims.scope = format!("order_reorder:{number}");
            delegated.insert(
                "x-commerce-reorder-token",
                a.sign(&claims)?.parse().map_err(|_| Error::Internal)?,
            );
        }
    }

    if headers
        .get("x-commerce-personalize")
        .is_some_and(|v| v == "0")
    {
        delegated.insert("x-commerce-personalize", "0".parse().unwrap());
    }
    if domain_customers::memory::safe_text(&input.message) {
        if let Ok(Some(token)) = memory::delegate(&a, &headers, &claims).await {
            delegated.insert(
                "x-commerce-memory-token",
                token.parse().map_err(|_| Error::Internal)?,
            );
        }
    }
    for key in ["x-delivery-latitude", "x-delivery-longitude"] {
        if let Some(value) = headers.get(key) {
            delegated.insert(key, value.clone());
        }
    }
    let response = match a
        .client
        .post("http://assistant-ingress:8080/v1/chat")
        .header(
            "x-commerce-trace-gateway",
            crate::assistant_trace::dispatch(input.request_id),
        )
        .bearer_auth(context)
        .header("x-commerce-tool-token", tool)
        .header("x-commerce-catalog-token", catalog_tool)
        .header("x-commerce-cart-token", cart_tool)
        .header("x-commerce-cart-write-token", cart_write_tool)
        .header(
            "x-commerce-wishlist-cart-transfer-token",
            wishlist_cart_transfer_tool,
        )
        .header("x-commerce-wishlist-token", wishlist_tool)
        .header("x-commerce-wishlist-write-token", wishlist_write_tool)
        .header("x-commerce-locations-token", locations_tool)
        .header("x-commerce-support-token", support_tool)
        .headers(delegated)
        .json(&input)
        .send()
        .await
    {
        Ok(r)
            if r.status().is_success()
                && r.headers()
                    .get("content-type")
                    .is_some_and(|h| h.as_bytes().starts_with(b"text/event-stream")) =>
        {
            r
        }
        Ok(r) if r.status() == StatusCode::TOO_MANY_REQUESTS => {
            return Ok((
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::json!({"error":"Assistant is busy. Please retry."})),
            )
                .into_response());
        }
        Err(e) if e.is_timeout() => {
            return Ok((
                StatusCode::GATEWAY_TIMEOUT,
                Json(serde_json::json!({"error":"Assistant request timed out."})),
            )
                .into_response());
        }
        _ => return Ok(unavailable()),
    };
    // Keep the bulkhead permit for the stream lifetime and bound downstream bytes.
    let stream = futures_util::stream::try_unfold(
        (response.bytes_stream(), permit, 0usize),
        |(mut stream, permit, count)| async move {
            use futures_util::StreamExt;
            match stream.next().await {
                Some(Ok(bytes)) if count + bytes.len() <= 65536 => {
                    let count = count + bytes.len();
                    Ok(Some((bytes, (stream, permit, count))))
                }
                Some(_) => Err(std::io::Error::other("Assistant stream interrupted")),
                None => Ok(None),
            }
        },
    );
    Ok((
        [
            ("content-type", "text/event-stream"),
            ("cache-control", "no-store"),
            ("x-accel-buffering", "no"),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}
pub(crate) static TOOL_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

async fn cart(
    State(a): State<App>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _permit = TOOL_SLOTS.try_acquire().map_err(|_| Error::RateLimited)?;
    let claims = a.decode(identity::bearer(&headers)?, "cart_read")?;
    let owner = a.customer(&claims).await?;
    tracing::info!(target: "assistant_audit", action = "cart_read", outcome = "started", request_id = %claims.request_id, tenant = %a.tenant);
    let cart = a.identity.cart.read_customer(owner).await?;
    tracing::info!(target: "assistant_audit", action = "cart_read", outcome = "completed", request_id = %claims.request_id, tenant = %a.tenant);
    let Some(cart) = cart else {
        return Ok(Json(
            serde_json::json!({"items":[],"subtotal":"0","discount_amount":"0","currency":"USD","fully_reserved":false}),
        ));
    };
    let items: Vec<_> = cart.items.iter().map(|item| serde_json::json!({
        "product_id":item.product_id,"name":item.name,"price":item.price.to_string(),
        "currency":item.currency,"quantity":item.quantity,"line_total":item.line_total.to_string()
    })).collect();
    Ok(Json(
        serde_json::json!({"items":items,"subtotal":cart.subtotal.to_string(),
        "discount_amount":cart.discount_amount.to_string(),"currency":cart.currency,"fully_reserved":cart.fully_reserved}),
    ))
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum CartChange {
    Add {
        product_id: Uuid,
        quantity: i32,
    },
    Set {
        product_id: Uuid,
        quantity: i32,
    },
    Remove {
        product_id: Uuid,
        quantity: Option<i32>,
    },
    Clear,
}

async fn change_cart(
    State(a): State<App>,
    headers: HeaderMap,
    Json(change): Json<CartChange>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _permit = TOOL_SLOTS.try_acquire().map_err(|_| Error::RateLimited)?;
    let claims = a.decode(identity::bearer(&headers)?, "cart_write")?;
    let owner = a.customer(&claims).await?;
    let claimed = sqlx::query("INSERT INTO cart_checkout.assistant_actions(customer_id,request_id) VALUES($1,$2) ON CONFLICT DO NOTHING")
        .bind(owner).bind(claims.request_id).execute(&a.identity.customers.pool).await?;
    if claimed.rows_affected() == 0 {
        return Err(Error::Invalid(
            "This cart action was already attempted. Read the cart before sending a new request."
                .into(),
        )
        .into());
    }
    let cart = match change {
        CartChange::Clear => a.identity.cart.clear(owner).await?,
        CartChange::Remove {
            product_id,
            quantity,
        } => {
            a.identity
                .cart
                .remove_amount(Some(owner), "", product_id, quantity)
                .await?
        }
        CartChange::Add {
            product_id,
            quantity,
        }
        | CartChange::Set {
            product_id,
            quantity,
        } => {
            let add = matches!(change, CartChange::Add { .. });
            let product = domain_catalog::Service {
                pool: a.identity.customers.pool.clone(),
            }
            .product(product_id)
            .await?;
            a.identity
                .cart
                .set(Some(owner), "", product, quantity, add)
                .await?
        }
    };
    tracing::info!(target: "assistant_audit", action = "cart_write", outcome = "completed", request_id = %claims.request_id, tenant = %a.tenant);
    let items: Vec<_> = cart.items.iter().map(|item| serde_json::json!({
        "product_id":item.product_id,"name":item.name,"price":item.price.to_string(),
        "currency":item.currency,"quantity":item.quantity,"line_total":item.line_total.to_string()
    })).collect();
    Ok(Json(
        serde_json::json!({"items":items,"subtotal":cart.subtotal.to_string(),
        "discount_amount":cart.discount_amount.to_string(),"currency":cart.currency,"fully_reserved":cart.fully_reserved}),
    ))
}

async fn transfer_wishlist_to_cart(
    State(a): State<App>,
    headers: HeaderMap,
    Json(input): Json<WishlistTransferInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _permit = TOOL_SLOTS.try_acquire().map_err(|_| Error::RateLimited)?;
    let claims = a.decode(identity::bearer(&headers)?, "wishlist_cart_transfer")?;
    let owner = a.customer(&claims).await?;
    let item_count = input.product_ids.len();
    let receipt = a
        .identity
        .cart
        .transfer_wishlist_to_cart(owner, claims.request_id, input.product_ids)
        .await?;
    if !receipt.replayed {
        tracing::info!(target: "assistant_audit", action = "wishlist_cart_transfer", outcome = "completed", request_id = %claims.request_id, tenant = %a.tenant, item_count);
    }
    Ok(Json(receipt.result))
}

async fn wishlist(State(a): State<App>, headers: HeaderMap) -> Result<Json<Vec<Uuid>>, ApiError> {
    let _permit = TOOL_SLOTS.try_acquire().map_err(|_| Error::RateLimited)?;
    let claims = a.decode(identity::bearer(&headers)?, "wishlist_read")?;
    let owner = a.customer(&claims).await?;
    tracing::info!(target: "assistant_audit", action = "wishlist_read", outcome = "started", request_id = %claims.request_id, tenant = %a.tenant);
    let result = domain_reviews::Service {
        pool: a.identity.customers.pool.clone(),
    }
    .wishlist_ids(owner)
    .await;
    tracing::info!(target: "assistant_audit", action = "wishlist_read", outcome = if result.is_ok() { "completed" } else { "failed" }, request_id = %claims.request_id, tenant = %a.tenant);
    Ok(Json(result?))
}

async fn remove_wishlist_item(
    State(a): State<App>,
    headers: HeaderMap,
    Json(input): Json<serde_json::Value>,
) -> Result<StatusCode, ApiError> {
    let _permit = TOOL_SLOTS.try_acquire().map_err(|_| Error::RateLimited)?;
    let claims = a.decode(identity::bearer(&headers)?, "wishlist_write")?;
    let owner = a.customer(&claims).await?;
    let product = input
        .get("product_id")
        .and_then(|v| v.as_str())
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or(Error::Invalid("Invalid product id".into()))?;
    domain_reviews::Service {
        pool: a.identity.customers.pool.clone(),
    }
    .wish(owner, product, false)
    .await?;
    tracing::info!(target: "assistant_audit", action = "wishlist_remove", outcome = "completed", request_id = %claims.request_id, tenant = %a.tenant);
    Ok(StatusCode::OK)
}

async fn add_wishlist_item(
    State(a): State<App>,
    headers: HeaderMap,
    Json(input): Json<serde_json::Value>,
) -> Result<StatusCode, ApiError> {
    let _permit = TOOL_SLOTS.try_acquire().map_err(|_| Error::RateLimited)?;
    let claims = a.decode(identity::bearer(&headers)?, "wishlist_write")?;
    let owner = a.customer(&claims).await?;
    let product = input
        .get("product_id")
        .and_then(|v| v.as_str())
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or(Error::Invalid("Invalid product id".into()))?;
    domain_reviews::Service {
        pool: a.identity.customers.pool.clone(),
    }
    .wish(owner, product, true)
    .await?;
    tracing::info!(target: "assistant_audit", action = "wishlist_add", outcome = "completed", request_id = %claims.request_id, tenant = %a.tenant);
    Ok(StatusCode::NO_CONTENT)
}

async fn saved_locations(
    State(a): State<App>,
    headers: HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let _permit = TOOL_SLOTS.try_acquire().map_err(|_| Error::RateLimited)?;
    let claims = a.decode(identity::bearer(&headers)?, "locations_read")?;
    let owner = a.customer(&claims).await?;
    let locations = a.identity.customers.locations(owner).await?;
    Ok(Json(
        locations
            .into_iter()
            .map(|location| {
                serde_json::json!({
                    "id": location.id,
                    "label": location.label,
                    "formatted_address": location.formatted_address,
                    "is_default": location.is_default
                })
            })
            .collect(),
    ))
}

async fn support_tickets(
    State(a): State<App>,
    headers: HeaderMap,
) -> Result<Json<Vec<domain_support::Ticket>>, ApiError> {
    let _permit = TOOL_SLOTS.try_acquire().map_err(|_| Error::RateLimited)?;
    let claims = a.decode(identity::bearer(&headers)?, "support_read")?;
    let owner = a.customer(&claims).await?;
    let service = domain_support::Service {
        pool: a.identity.customers.pool.clone(),
        tenant: a.tenant,
    };
    Ok(Json(
        service
            .list(&domain_support::Actor::Customer(owner))
            .await?,
    ))
}

async fn support_ticket_detail(
    State(a): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<domain_support::Detail>, ApiError> {
    let _permit = TOOL_SLOTS.try_acquire().map_err(|_| Error::RateLimited)?;
    let claims = a.decode(identity::bearer(&headers)?, "support_read")?;
    let owner = a.customer(&claims).await?;
    let service = domain_support::Service {
        pool: a.identity.customers.pool.clone(),
        tenant: a.tenant,
    };
    Ok(Json(
        service
            .detail(id, &domain_support::Actor::Customer(owner))
            .await?,
    ))
}

async fn delivery(
    State(a): State<App>,
    headers: HeaderMap,
) -> Result<Json<domain_inventory::areas::Delivery>, ApiError> {
    let _permit = TOOL_SLOTS.try_acquire().map_err(|_| Error::RateLimited)?;
    let claims = a.decode(identity::bearer(&headers)?, "shopper_read")?;
    if claims.sub.is_some() {
        a.customer(&claims).await?;
    }
    Ok(Json(
        a.identity
            .cart
            .inventory
            .delivery(crate::areas::pin(&headers)?)
            .await?,
    ))
}

async fn order(
    State(a): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _permit = TOOL_SLOTS.try_acquire().map_err(|_| Error::RateLimited)?;
    let c = a.decode(identity::bearer(&headers)?, "order_status")?;
    let owner = a.customer(&c).await?;
    tracing::info!(target: "assistant_audit", action = "order_status", outcome = "started", request_id = %c.request_id, tenant = %a.tenant);
    let result = domain_orders::Service {
        pool: a.identity.customers.pool.clone(),
    }
    .detail(id, Some(owner))
    .await;
    tracing::info!(target: "assistant_audit", action = "order_status", outcome = if result.is_ok() { "completed" } else { "denied_or_failed" }, request_id = %c.request_id, tenant = %a.tenant);
    let detail = result?;
    let o = detail.order;
    let shipments: Vec<_> = detail.shipments.into_iter().map(|d| serde_json::json!({"tracking_reference":d.shipment.tracking_reference,"status":d.shipment.status})).collect();
    Ok(Json(
        serde_json::json!({"id":o.id,"number":o.number,"status":o.status,"subtotal":o.subtotal.to_string(),"discount_amount":o.discount_amount.to_string(),"tax_amount":o.tax_amount.to_string(),"delivery_fee":o.delivery_fee.to_string(),"total":o.total.to_string(),"currency":o.currency,"cancellation_available":domain_orders::transitions(&o.status).contains(&"cancelled"),"shipments":shipments}),
    ))
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum OrderHistorySelection {
    #[default]
    Recent,
    Oldest,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct OrderHistoryQuery {
    #[serde(default)]
    selection: OrderHistorySelection,
}

async fn order_history(
    State(a): State<App>,
    Query(query): Query<OrderHistoryQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let _permit = TOOL_SLOTS.try_acquire().map_err(|_| Error::RateLimited)?;
    let claims = a.decode(identity::bearer(&headers)?, "order_status")?;
    let owner = a.customer(&claims).await?;
    let service = domain_orders::Service {
        pool: a.identity.customers.pool.clone(),
    };
    let orders = match query.selection {
        OrderHistorySelection::Recent => service.list(Some(owner), 0).await?,
        OrderHistorySelection::Oldest => service.oldest(owner).await?,
    };
    Ok(Json(
        orders
            .into_iter()
            .take(5)
            .map(|order| {
                serde_json::json!({
                    "id": order.id,
                    "number": order.number,
                    "status": order.status,
                    "subtotal": order.subtotal.to_string(),
                    "discount_amount": order.discount_amount.to_string(),
                    "tax_amount": order.tax_amount.to_string(),
                    "delivery_fee": order.delivery_fee.to_string(),
                    "total": order.total.to_string(),
                    "currency": order.currency,
                    "cancellation_available": domain_orders::transitions(&order.status).contains(&"cancelled"),
                    "shipments": []
                })
            })
            .collect(),
    ))
}

async fn order_by_number(
    State(a): State<App>,
    headers: HeaderMap,
    Path(number): Path<i64>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _permit = TOOL_SLOTS.try_acquire().map_err(|_| Error::RateLimited)?;
    let claims = a.decode(identity::bearer(&headers)?, "order_status")?;
    let owner = a.customer(&claims).await?;
    let detail = domain_orders::Service {
        pool: a.identity.customers.pool.clone(),
    }
    .detail_by_number(number, owner)
    .await?;
    let order = detail.order;
    let shipments: Vec<_> = detail
        .shipments
        .into_iter()
        .map(|shipment| {
            serde_json::json!({
                "tracking_reference": shipment.shipment.tracking_reference,
                "status": shipment.shipment.status
            })
        })
        .collect();
    Ok(Json(serde_json::json!({
        "id": order.id,
        "number": order.number,
        "status": order.status,
        "subtotal": order.subtotal.to_string(),
        "discount_amount": order.discount_amount.to_string(),
        "tax_amount": order.tax_amount.to_string(),
        "delivery_fee": order.delivery_fee.to_string(),
        "total": order.total.to_string(),
        "currency": order.currency,
        "cancellation_available": domain_orders::transitions(&order.status).contains(&"cancelled"),
        "shipments": shipments
    })))
}

async fn ticket(
    State(a): State<App>,
    headers: HeaderMap,
    Json(input): Json<domain_support::TicketInput>,
) -> Result<(StatusCode, Json<domain_support::Detail>), ApiError> {
    let _permit = TOOL_SLOTS.try_acquire().map_err(|_| Error::RateLimited)?;
    let claims = a.decode(identity::bearer(&headers)?, "support_create")?;
    let owner = a.customer(&claims).await?;
    if input.request_id != claims.request_id {
        return Err(Error::Forbidden.into());
    }
    infra_auth::rate_limit(
        &a.identity.customers.pool,
        &format!("support:{}:{owner}", a.tenant),
        20,
    )
    .await?;
    let result = domain_support::Service {
        pool: a.identity.customers.pool.clone(),
        tenant: a.tenant,
    }
    .create(&domain_support::Actor::Customer(owner), &input)
    .await?;
    Ok((StatusCode::CREATED, Json(result)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryQuery {
    conversation_id: Option<Uuid>,
}
async fn history(
    State(a): State<App>,
    headers: HeaderMap,
    Query(query): Query<HistoryQuery>,
) -> Result<Response, ApiError> {
    let token = identity::bearer(&headers)?;
    let customer = a.identity.customers.authenticate(token).await?;
    let sid = a.identity.customers.security.decode(token)?.sid;
    infra_auth::rate_limit(
        &a.identity.customers.pool,
        &format!("assistant-history:{}:{}", a.tenant, customer.id),
        100,
    )
    .await?;
    let now = chrono::Utc::now().timestamp();
    let c = Claims {
        iss: "commerce-assistant".into(),
        aud: "ai-service".into(),
        tenant: a.tenant,
        sub: Some(customer.id),
        sid: Some(sid),
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: "history".into(),
    };
    let mut response = match a
        .client
        .get("http://assistant-ingress:8080/v1/history")
        .query(
            &query
                .conversation_id
                .map(|id| vec![("conversation_id", id.to_string())])
                .unwrap_or_default(),
        )
        .bearer_auth(a.sign(&c)?)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return Ok(unavailable()),
    };
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= 4 * 1024 * 1024 => bytes.extend(chunk),
            Ok(None) => break,
            _ => return Ok(unavailable()),
        }
    }
    Ok((
        [
            ("content-type", "application/json"),
            ("cache-control", "no-store"),
        ],
        bytes,
    )
        .into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Metric {
    pub request_id: Uuid,
    pub outcome: String,
    pub latency_ms: u32,
    pub created_at: chrono::DateTime<chrono::Utc>,
}
/// Metrics-only client: no commerce identity, session, or general database capability.
#[derive(Clone)]
pub struct Telemetry {
    tenant: Uuid,
    signing: Arc<jsonwebtoken::EncodingKey>,
    client: reqwest::Client,
}
impl Telemetry {
    pub fn environment() -> Result<Option<Self>, Box<dyn std::error::Error + Send + Sync>> {
        let Ok(path) = std::env::var("ASSISTANT_PRIVATE_KEY_FILE") else {
            return Ok(None);
        };
        let tenant: Uuid = std::env::var("ASSISTANT_TENANT_ID")?.parse()?;
        if tenant.is_nil() {
            return Err("Assistant tenant must not be nil".into());
        }
        Ok(Some(Self {
            tenant,
            signing: Arc::new(jsonwebtoken::EncodingKey::from_rsa_pem(&std::fs::read(
                path,
            )?)?),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(1))
                .timeout(Duration::from_secs(30))
                .build()?,
        }))
    }
    fn sign(&self, claims: &Claims) -> Result<String, Error> {
        jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
            claims,
            &self.signing,
        )
        .map_err(|_| Error::Internal)
    }
}
/// Retry the AI-owned durable telemetry spool asynchronously; core requests never wait here.
pub async fn telemetry(app: Telemetry, analytics: crate::analytics::Client) {
    loop {
        if collect_metrics(&app, &analytics).await.is_err() {
            tracing::warn!("assistant telemetry unavailable; retrying");
        }
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
}
async fn collect_metrics(a: &Telemetry, analytics: &crate::analytics::Client) -> Result<(), Error> {
    let now = chrono::Utc::now().timestamp();
    let claims = Claims {
        iss: "commerce-assistant".into(),
        aud: "ai-service".into(),
        tenant: a.tenant,
        sub: None,
        sid: None,
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: "metrics".into(),
    };
    let mut response = a
        .client
        .get("http://assistant-ingress:8080/v1/metrics")
        .bearer_auth(a.sign(&claims)?)
        .send()
        .await
        .map_err(|_| Error::Internal)?
        .error_for_status()
        .map_err(|_| Error::Internal)?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Internal)? {
        if bytes.len() + chunk.len() > 262144 {
            return Err(Error::Internal);
        }
        bytes.extend(chunk);
    }
    let rows: Vec<Metric> = serde_json::from_slice(&bytes).map_err(|_| Error::Internal)?;
    if rows.len() > 1000 {
        return Err(Error::Internal);
    }
    let ids: Vec<Uuid> = rows.iter().map(|r| r.request_id).collect();
    analytics.assistant_metrics(a.tenant, rows).await?;
    a.client
        .post("http://assistant-ingress:8080/v1/metrics/ack")
        .bearer_auth(a.sign(&claims)?)
        .json(&ids)
        .send()
        .await
        .map_err(|_| Error::Internal)?
        .error_for_status()
        .map_err(|_| Error::Internal)?;
    Ok(())
}

pub(crate) async fn request_deadline(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    match tokio::time::timeout(Duration::from_secs(5), next.run(request)).await {
        Ok(response) => response,
        Err(_) => unavailable(),
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Feedback {
    request_id: Uuid,
    helpful: bool,
}
async fn feedback(
    State(a): State<App>,
    headers: HeaderMap,
    Json(body): Json<Feedback>,
) -> Result<Response, ApiError> {
    let token = identity::bearer(&headers)?;
    let customer = a.identity.customers.authenticate(token).await?;
    let sid = a.identity.customers.security.decode(token)?.sid;
    infra_auth::rate_limit(
        &a.identity.customers.pool,
        &format!("assistant-feedback:{}:{}", a.tenant, customer.id),
        100,
    )
    .await?;
    let now = chrono::Utc::now().timestamp();
    let claims = Claims {
        iss: "commerce-assistant".into(),
        aud: "ai-service".into(),
        tenant: a.tenant,
        sub: Some(customer.id),
        sid: Some(sid),
        request_id: body.request_id,
        iat: now,
        exp: now + 45,
        scope: "feedback".into(),
    };
    let result = a
        .client
        .post("http://assistant-ingress:8080/v1/feedback")
        .bearer_auth(a.sign(&claims)?)
        .json(&body)
        .send()
        .await;
    match result {
        Ok(r) if r.status().is_success() => {
            Ok(Json(serde_json::json!({"status":"ok"})).into_response())
        }
        Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => Err(Error::NotFound.into()),
        _ => Ok(unavailable()),
    }
}
async fn usage(State(a): State<App>, headers: HeaderMap) -> Result<Response, ApiError> {
    a.identity
        .admins
        .authenticate(identity::cookie(&headers, "admin_session"))
        .await?
        .require("reports.read")?;
    let now = chrono::Utc::now().timestamp();
    let claims = Claims {
        iss: "commerce-assistant".into(),
        aud: "ai-service".into(),
        tenant: a.tenant,
        sub: None,
        sid: None,
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: "metrics".into(),
    };
    let mut response = match a
        .client
        .get("http://assistant-ingress:8080/v1/insights")
        .bearer_auth(a.sign(&claims)?)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return Ok(unavailable()),
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Internal)? {
        if bytes.len() + chunk.len() > 8192 {
            return Err(Error::Internal.into());
        }
        bytes.extend(chunk);
    }
    Ok((
        [
            ("content-type", "application/json"),
            ("cache-control", "no-store"),
        ],
        bytes,
    )
        .into_response())
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DeliveryEvent {
    conversation_id: Uuid,
    request_id: Uuid,
    location_id: Uuid,
}
async fn delivery_event(
    State(a): State<App>,
    headers: HeaderMap,
    Json(body): Json<DeliveryEvent>,
) -> Result<Response, ApiError> {
    let token = identity::bearer(&headers)?;
    let customer = a.identity.customers.authenticate(token).await?;
    let sid = a.identity.customers.security.decode(token)?.sid;
    infra_auth::rate_limit(
        &a.identity.customers.pool,
        &format!("assistant-delivery-event:{}:{}", a.tenant, customer.id),
        30,
    )
    .await?;
    // Only record a selection of an address owned by the authenticated customer.
    let locations = a.identity.customers.locations(customer.id).await?;
    if !locations
        .iter()
        .any(|location| location.id == body.location_id)
    {
        return Err(Error::Invalid("Delivery address unavailable".into()).into());
    }
    let now = chrono::Utc::now().timestamp();
    let claims = Claims {
        iss: "commerce-assistant".into(),
        aud: "ai-service".into(),
        tenant: a.tenant,
        sub: Some(customer.id),
        sid: Some(sid),
        request_id: body.request_id,
        iat: now,
        exp: now + 45,
        scope: "delivery_event".into(),
    };
    match a
        .client
        .post("http://assistant-ingress:8080/v1/delivery-event")
        .bearer_auth(a.sign(&claims)?)
        .json(&serde_json::json!({"conversation_id":body.conversation_id}))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            Ok(Json(serde_json::json!({"saved":true})).into_response())
        }
        _ => Ok(unavailable()),
    }
}

#[cfg(test)]
mod clarification_tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use serde_json::json;
    use tower::ServiceExt;

    // Exercise the same JSON extractor and serialization used by chat's proxy.
    // Previously, the shopping fields caused a 422 before chat was called.
    #[tokio::test]
    async fn shopping_budget_reply_survives_gateway_extraction_and_forwarding() {
        let clarification = json!({
            "original_message": "I need luxury rings",
            "question": "What is your budget? You can give a maximum amount, or show the available options.",
            "revision": Uuid::new_v4(),
            "kind": "shopping",
            "choices": ["Up to 234.00 USD"],
            "optional": true
        });
        let payload = json!({
            "request_id": Uuid::new_v4(),
            "conversation_id": Uuid::new_v4(),
            "message": "Up to 234.00 USD",
            "clarification": clarification
        });
        let router = Router::new().route(
            "/v1/assistant/chat",
            post(|Json(input): Json<ChatInput>| async move { Json(input) }),
        );
        let response = router
            .oneshot(
                Request::post("/v1/assistant/chat")
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let forwarded: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(forwarded, payload);
    }

    #[test]
    fn legacy_clarifications_remain_compatible_and_unknown_fields_are_rejected() {
        for revision in [None, Some(Uuid::new_v4())] {
            let mut value = json!({"original_message": "find rings", "question": "Which style?"});
            if let Some(revision) = revision {
                value["revision"] = json!(revision);
            }
            let parsed: Clarification = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), value);
            value["frame"] = json!({"query": "forged"});
            assert!(serde_json::from_value::<Clarification>(value).is_err());
        }
        let value = json!({
            "original_message": "find rings", "question": "Which style?", "kind": "unknown"
        });
        assert!(serde_json::from_value::<Clarification>(value).is_err());
    }
}
