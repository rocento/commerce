use crate::identity::{self, ApiError, App};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;
type Result<T> = std::result::Result<T, ApiError>;
pub(crate) async fn customer(a: &App, h: &HeaderMap) -> Result<Option<Uuid>> {
    if h.contains_key(header::AUTHORIZATION) {
        Ok(Some(
            a.customers.authenticate(identity::bearer(h)?).await?.id,
        ))
    } else {
        Ok(None)
    }
}
pub fn router(app: App) -> Router {
    Router::new()
        .merge(crate::msi::routes())
        .merge(crate::areas::routes())
        .merge(crate::capacity::routes())
        .merge(crate::shopping::routes())
        .merge(crate::market::routes())
        .merge(crate::markets::routes())
        .route("/v1/cart", post(open))
        .route("/v1/cart/coupon", put(coupon))
        .route("/v1/cart/items", post(add))
        .route("/v1/cart/items/{id}", put(update).delete(remove))
        .route("/v1/inventory/{id}", get(availability))
        .route("/v1/admin/inventory", get(inventory_list))
        .route("/v1/admin/inventory/{id}", get(inventory).put(adjust))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(middleware::from_fn_with_state(
            app.clone(),
            identity::policy,
        ))
        .with_state(app)
}
async fn open(State(a): State<App>, h: HeaderMap) -> Result<Response> {
    let mut session = a
        .cart
        .open(customer(&a, &h).await?, identity::cookie(&h, "guest_cart"))
        .await?;
    if h.contains_key("x-delivery-context") {
        let guest = session.guest_token.as_deref().unwrap_or("");
        session.cart = a
            .cart
            .set_delivery(customer(&a, &h).await?, guest, crate::areas::pin(&h)?)
            .await?;
    }
    let mut response = Json(session.cart).into_response();
    let value = session.guest_token.unwrap_or_default();
    response.headers_mut().insert(
        header::SET_COOKIE,
        identity::session_cookie(
            "guest_cart",
            &value,
            if value.is_empty() { 0 } else { 2592000 },
            &a.customers.security,
        )
        .parse()
        .unwrap(),
    );
    Ok(response)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Add {
    product_id: Uuid,
    quantity: i32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Quantity {
    quantity: i32,
}
async fn add(State(a): State<App>, h: HeaderMap, Json(i): Json<Add>) -> Result<impl IntoResponse> {
    let c = customer(&a, &h).await?;
    if h.contains_key("x-delivery-context") {
        a.cart
            .set_delivery(
                c,
                identity::cookie(&h, "guest_cart"),
                crate::areas::pin(&h)?,
            )
            .await?;
    }
    let product = domain_catalog::Service {
        pool: a.customers.pool.clone(),
    }
    .product(i.product_id)
    .await?;
    Ok(Json(
        a.cart
            .set(
                c,
                identity::cookie(&h, "guest_cart"),
                product,
                i.quantity,
                true,
            )
            .await?,
    ))
}
async fn update(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<Quantity>,
) -> Result<impl IntoResponse> {
    let c = customer(&a, &h).await?;
    if h.contains_key("x-delivery-context") {
        a.cart
            .set_delivery(
                c,
                identity::cookie(&h, "guest_cart"),
                crate::areas::pin(&h)?,
            )
            .await?;
    }
    let product = domain_catalog::Service {
        pool: a.customers.pool.clone(),
    }
    .product(id)
    .await?;
    Ok(Json(
        a.cart
            .set(
                c,
                identity::cookie(&h, "guest_cart"),
                product,
                i.quantity,
                false,
            )
            .await?,
    ))
}
async fn remove(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse> {
    Ok(Json(
        a.cart
            .remove(
                customer(&a, &h).await?,
                identity::cookie(&h, "guest_cart"),
                id,
            )
            .await?,
    ))
}
async fn availability(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse> {
    let p = domain_catalog::Service {
        pool: a.customers.pool.clone(),
    }
    .product(id)
    .await?;
    if !p.active {
        return Err(infra_auth::Error::NotFound.into());
    }
    let d = a.cart.inventory.delivery(crate::areas::pin(&h)?).await?;
    let mut stock = a.cart.inventory.stock(id).await?;
    let cap = crate::capacity::resolved_capabilities(&a, &h).await?;
    if cap.global_delivery() {
        let stocks = a.cart.inventory.browsing_stocks(None, true).await?;
        stock.available = a
            .cart
            .inventory
            .browsing_available_many(&[id], &stocks, None)
            .await?
            .get(&id)
            .copied()
            .unwrap_or(0);
        stock.on_hand = 0;
        stock.reserved = 0;
    } else if d.configured && cap.geofencing() && !(cap.pickup_enabled && d.area_id.is_none()) {
        stock.available = if let Some(area) = d.area_id {
            a.cart.inventory.area_available(area, id).await?
        } else {
            0
        };
        stock.on_hand = 0;
        stock.reserved = 0;
    }
    Ok(Json(stock))
}
async fn inventory(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse> {
    a.admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?
        .require("inventory.read")?;
    let product = domain_catalog::Service {
        pool: a.customers.pool.clone(),
    }
    .product(id)
    .await?;
    Ok(Json(
        json!({"product":product,"stock":a.cart.inventory.stock(id).await?,"reservations":a.cart.inventory.reservations(id).await?,"adjustments":a.cart.inventory.adjustments(id).await?}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Adjust {
    on_hand: i32,
    reason: String,
}
async fn adjust(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<Adjust>,
) -> Result<impl IntoResponse> {
    let who = a
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?;
    who.require("inventory.write")?;
    domain_catalog::Service {
        pool: a.customers.pool.clone(),
    }
    .product(id)
    .await?;
    Ok(Json(
        a.cart
            .inventory
            .adjust(id, i.on_hand, who.user.id, i.reason)
            .await?,
    ))
}

#[derive(Deserialize)]
struct InventoryPage {
    offset: Option<i64>,
}
async fn inventory_list(
    State(a): State<App>,
    h: HeaderMap,
    Query(page): Query<InventoryPage>,
) -> Result<impl IntoResponse> {
    a.admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?
        .require("inventory.read")?;
    let offset = page.offset.unwrap_or(0);
    if !(0..=1000000).contains(&offset) {
        return Err(domain_inventory::invalid("Invalid offset").into());
    }
    let products = domain_catalog::Service {
        pool: a.customers.pool.clone(),
    }
    .products(offset)
    .await?;
    let mut rows = Vec::new();
    for p in products {
        rows.push(json!({"product_id":p.id,"sku":p.sku,"name":p.name,"stock":a.cart.inventory.stock(p.id).await?}));
    }
    Ok(Json(rows))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Coupon {
    code: String,
}
async fn coupon(
    State(a): State<App>,
    h: HeaderMap,
    Json(i): Json<Coupon>,
) -> Result<impl IntoResponse> {
    Ok(Json(
        a.cart
            .coupon(
                customer(&a, &h).await?,
                identity::cookie(&h, "guest_cart"),
                &i.code,
            )
            .await?,
    ))
}
