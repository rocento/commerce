//! Allowlisted, filtered keyset grids shared by interactive pages and export workers.
use crate::identity::{self, ApiError, App};
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    middleware,
    routing::get,
    Json, Router,
};
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgConnection, Postgres, QueryBuilder};
use uuid::Uuid;
#[derive(Clone)]
pub struct Grid {
    pub table: &'static str,
    pub columns: &'static str,
    pub permission: &'static str,
    pub search: &'static str,
    pub filters: &'static [&'static str],
}
pub fn definition(name: &str) -> Result<Grid> {
    let (table, columns, permission, search, filters): (_,_,_,_,&[&str]) = match name {
 "catalog" => ("catalog.products", "id,entity_id,sku,slug,name,description,price,currency,unit,category_id,attributes,media_ids,active,in_stock,updated_at,product_type,parent_id,variant_attributes", "catalog.read", "name || ' ' || sku", &["category_id","active"]),
 "inventory" => ("catalog.products", "id,entity_id,sku,name,category_id,active", "inventory.read", "name || ' ' || sku", &["category_id","active"]),
 "categories" => ("catalog.categories", "id,entity_id,name,slug,parent_id,attributes", "catalog.read", "name", &[]),
 "attributes" => ("catalog.attributes", "id,entity_id,code,name,kind,required", "catalog.read", "name", &[]),
 "media" => ("catalog.media", "id,entity_id,content_type,alt,object_key,size_bytes,created_at", "catalog.read", "alt", &[]),
 "orders" => ("orders.orders_with_status", "id,entity_id,number,customer_id,contact,status,status_code,status_display,subtotal,delivery_fee,total,currency,created_at,updated_at,tax_amount,discount_amount", "orders.read", "status || ' ' || status_code || ' ' || (status_display->>'label')", &["status"]),
 "customers" => ("customers.customers", "id,entity_id,email,mobile_number,primary_identifier,verified,created_at,first_name,last_name,customer_group", "customers.read", "coalesce(email,'') || ' ' || coalesce(mobile_number,'') || ' ' || first_name || ' ' || last_name", &[]),
 "users" => ("admin_iam.admin_users", "id,entity_id,email,name,role_id,active,created_at", "iam.users.read", "name || ' ' || email", &["active","role_id"]),
 "roles" => ("admin_iam.roles", "id,entity_id,name,permissions,system", "iam.roles.read", "name", &["system"]),
 "audit" => ("admin_iam.audit_log", "id,actor_id,action,entity_id,details,created_at", "iam.audit.read", "action || ' ' || coalesce(actor_id::text,'') || ' ' || entity_id::text || ' ' || details::text", &["action","actor_id","entity_id","created_from","created_to"]),
 "content" => ("cms.documents", "id,entity_id,key,kind,version,updated_at", "cms.read", "key", &["kind"]),
 "reviews" => ("reviews.reviews", "id,entity_id,product_id,customer_id,display_name,rating,title,body,status,version,moderation_reason,created_at,updated_at", "reviews.read", "title", &["status"]),
 "promotions" => ("pricing_promotions.rules", "id,entity_id,name,scope,kind,value,coupon_code,min_subtotal,skus,category_ids,customer_group,priority,active,starts_at,ends_at,updated_at", "promotions.read", "name", &["active"]),
 "tax" => ("tax.rules", "id,entity_id,name,min_lat,max_lat,min_lon,max_lon,rate_bps,tax_delivery,priority,active,updated_at", "tax.read", "name", &["active"]),
 "support" => ("support.tickets", "id,entity_id,number,subject,category,status,priority,order_id,created_at,resolved_at", "support.read", "subject", &["status"]),
 "attribute-definitions" => ("attributes.definitions", "id,entity_id,entity_type,attribute_code,label,input_type,scope,is_required,is_unique,is_searchable,is_filterable,is_comparable,is_visible_on_front,used_for_promo_rules,used_for_configurations,swatch_type,options,version", "catalog.read", "label", &["entity_type"]),
 "adjustments" => ("inventory.adjustments", "id,product_id,actor_id,before_quantity,after_quantity,reason,created_at", "inventory.read", "reason", &["product_id"]),
 "reservations" => ("(SELECT cart_id AS id,cart_id,product_id,quantity,expires_at FROM inventory.reservations WHERE expires_at>statement_timestamp()) records", "id,cart_id,product_id,quantity,expires_at", "inventory.read", "cart_id::text", &["product_id"]),
 "order-comments" => ("orders.order_comments", "id,order_id,admin_id,body,created_at", "orders.read", "body", &["order_id"]),
 "sources" | "source-items" => ("inventory.inventory_sources", "id,entity_id,code,name,is_enabled,address,latitude,longitude,contact_name,contact_phone,priority", "inventory.read", "name", if name=="source-items" {&["product_id"]}else{&[]}),
 "stocks" => ("inventory.stocks", "id,entity_id,code,name,is_default,is_global", "inventory.read", "name", &[]),
 "delivery-areas" => ("inventory.delivery_areas", "id,entity_id,name,center_lat,center_lng,radius_km,priority,is_active,boundary", "inventory.read", "name", &[]),
 "cms-revisions" => ("cms.revisions", "id,entity_id,document_id,version,title,blocks,created_by,created_at", "cms.read", "title", &["document_id"]),
 "cms-releases" => ("cms.releases", "id,entity_id,document_id,revision_id,starts_at,ends_at,cancelled,created_at", "cms.read", "id::text", &["document_id"]),
 _ => return Err(Error::NotFound),
 };
    Ok(Grid {
        table,
        columns,
        permission,
        search,
        filters,
    })
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub action: Option<String>,
    pub actor_id: Option<Uuid>,
    pub entity_id: Option<Uuid>,
    pub created_from: Option<chrono::DateTime<chrono::Utc>>,
    pub created_to: Option<chrono::DateTime<chrono::Utc>>,
    pub system: Option<bool>,
    pub document_id: Option<Uuid>,
    pub entity_type: Option<String>,
    pub product_id: Option<Uuid>,
    pub order_id: Option<Uuid>,
    pub sort: Option<String>,
    #[serde(default)]
    pub q: String,
    pub status: Option<String>,
    pub category_id: Option<Uuid>,
    pub role_id: Option<Uuid>,
    pub active: Option<bool>,
    pub kind: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
    #[serde(default)]
    pub descending: bool,
}
#[derive(Serialize, Deserialize)]
struct Cursor {
    value: Option<String>,
    id: Uuid,
    scope: String,
}
#[derive(Serialize)]
pub struct Page {
    pub items: Vec<Value>,
    pub next_cursor: Option<String>,
    pub total_count: i64,
}
fn scope(name: &str, r: &Request) -> String {
    let mut r = r.clone();
    r.cursor = None;
    r.limit = None;
    format!("{}:{}", name, serde_json::to_string(&r).unwrap())
}
pub fn sorts(name: &str) -> Result<Vec<&'static str>> {
    definition(name)?;
    let mut columns = match name {
        "catalog" | "inventory" => vec!["id", "sku", "name"],
        "orders" | "support" => vec!["id", "number", "created_at"],
        "customers" => vec!["id", "email", "created_at"],
        "audit" | "media" | "reviews" | "adjustments" | "order-comments" => {
            vec!["id", "created_at"]
        }
        "promotions" | "tax" => vec!["id", "name", "priority"],
        "cms-revisions" => vec!["id", "version"],
        "cms-releases" => vec!["id", "created_at"],
        "attribute-definitions" => vec!["id", "label"],
        "reservations" => vec!["id"],
        "content" => vec!["id", "key"],
        _ => vec!["id", "name"],
    };
    if definition(name)?
        .columns
        .split(',')
        .any(|c| c == "entity_id")
        && name != "audit"
    {
        columns.push("entity_id");
    }
    Ok(columns)
}
fn sort_type(sort: &str) -> &'static str {
    match sort {
        "entity_id" | "number" | "priority" | "version" => "bigint",
        "created_at" => "timestamptz",
        _ => "text",
    }
}
pub fn validate(name: &str, r: &Request) -> Result<()> {
    let g = definition(name)?;
    if !sorts(name)?.contains(&r.sort.as_deref().unwrap_or("id")) {
        return Err(Error::Invalid("Unsupported sort column".into()));
    }
    if r.q.len() > 200 || !(1..=200).contains(&r.limit.unwrap_or(50)) {
        return Err(Error::Invalid("Invalid search or page size (1–200)".into()));
    }
    if ((name == "adjustments" || name == "reservations" || name == "source-items")
        && r.product_id.is_none())
        || (name == "order-comments" && r.order_id.is_none())
        || (["cms-revisions", "cms-releases"].contains(&name) && r.document_id.is_none())
    {
        return Err(Error::Invalid("Record scope is required".into()));
    }
    if r.action
        .as_ref()
        .is_some_and(|v| v.trim().is_empty() || v.len() > 200)
    {
        return Err(Error::Invalid("Invalid audit action".into()));
    }
    if matches!((r.created_from, r.created_to), (Some(from), Some(to)) if from >= to) {
        return Err(Error::Invalid("Start time must precede end time".into()));
    }
    for (key, present) in [
        ("action", r.action.is_some()),
        ("actor_id", r.actor_id.is_some()),
        ("entity_id", r.entity_id.is_some()),
        ("created_from", r.created_from.is_some()),
        ("created_to", r.created_to.is_some()),
        ("system", r.system.is_some()),
        ("document_id", r.document_id.is_some()),
        ("entity_type", r.entity_type.is_some()),
        ("product_id", r.product_id.is_some()),
        ("order_id", r.order_id.is_some()),
        ("status", r.status.is_some()),
        ("category_id", r.category_id.is_some()),
        ("role_id", r.role_id.is_some()),
        ("active", r.active.is_some()),
        ("kind", r.kind.is_some()),
    ] {
        if present && !g.filters.contains(&key) {
            return Err(Error::Invalid("Unsupported filter".into()));
        }
    }
    if let Some(c) = &r.cursor {
        let c: Cursor =
            serde_json::from_str(c).map_err(|_| Error::Invalid("Invalid cursor".into()))?;
        if r.sort.as_deref().unwrap_or("id") != "id" {
            let value = c
                .value
                .as_deref()
                .ok_or_else(|| Error::Invalid("Missing cursor value".into()))?;
            let valid = match sort_type(r.sort.as_deref().unwrap()) {
                "bigint" => value.parse::<i64>().is_ok(),
                "timestamptz" => chrono::DateTime::parse_from_rfc3339(value).is_ok(),
                _ => value.len() <= 4096,
            };
            if !valid {
                return Err(Error::Invalid("Invalid cursor value".into()));
            }
        }
        if c.scope != scope(name, r) {
            return Err(Error::Invalid(
                "Cursor does not match filters or sort".into(),
            ));
        }
    }
    Ok(())
}
pub async fn page(
    conn: &mut PgConnection,
    name: &str,
    r: &Request,
    tenant: Option<Uuid>,
) -> Result<Page> {
    page_with_count(conn, name, r, tenant, true).await
}

// Export workers only need rows; avoid recounting the collection for every batch.
pub async fn export_page(
    conn: &mut PgConnection,
    name: &str,
    r: &Request,
    tenant: Option<Uuid>,
) -> Result<Page> {
    page_with_count(conn, name, r, tenant, false).await
}

async fn page_with_count(
    conn: &mut PgConnection,
    name: &str,
    r: &Request,
    tenant: Option<Uuid>,
    include_total: bool,
) -> Result<Page> {
    validate(name, r)?;
    let sort = r.sort.as_deref().unwrap_or("id");
    let g = definition(name)?;
    let projection = if name == "audit" {
        "to_jsonb(t) || jsonb_build_object('actor_name',audit_actor.name,'actor_email',audit_actor.email,'entity_name',audit_entity.name,'entity_type',audit_entity.kind)"
    } else if name == "inventory" {
        "to_jsonb(t) || jsonb_build_object('product_id',t.id,'on_hand',coalesce(st.on_hand,0),'reserved',rs.quantity,'available',coalesce(st.on_hand,0)-rs.quantity,'stock',jsonb_build_object('product_id',t.id,'on_hand',coalesce(st.on_hand,0),'reserved',rs.quantity,'available',coalesce(st.on_hand,0)-rs.quantity))"
    } else if name == "stocks" {
        "to_jsonb(t) || jsonb_build_object('sources',coalesce((SELECT jsonb_agg(jsonb_build_object('source_id',l.source_id,'priority',l.priority) ORDER BY l.priority,l.source_id) FROM inventory.source_stock_links l WHERE l.stock_id=t.id),'[]'::jsonb))"
    } else if name == "delivery-areas" {
        "to_jsonb(t) || jsonb_build_object('stocks',coalesce((SELECT jsonb_agg(jsonb_build_object('stock_id',l.stock_id,'priority',l.priority) ORDER BY l.priority,l.stock_id) FROM inventory.area_stock_links l WHERE l.area_id=t.id),'[]'::jsonb))"
    } else if name == "source-items" {
        "to_jsonb(t) || jsonb_build_object('source_id',t.id,'product_id',selected.product_id,'quantity',coalesce(si.quantity,0),'status',coalesce(si.status,'in_stock'),'notify_stock_qty',coalesce(si.notify_stock_qty,0),'reserved',rs.quantity)"
    } else {
        "to_jsonb(t)"
    };
    // Money stays decimal text all the way to the browser and export file.
    let columns = g
        .columns
        .split(',')
        .map(|c| {
            if [
                "price",
                "subtotal",
                "delivery_fee",
                "total",
                "tax_amount",
                "discount_amount",
                "value",
                "min_subtotal",
            ]
            .contains(&c)
            {
                format!("{c}::text AS {c}")
            } else {
                c.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(",");
    let mut b = QueryBuilder::<Postgres>::new(format!(
        "SELECT {projection} FROM (SELECT {} FROM {} WHERE true",
        columns, g.table
    ));
    let mut count_query =
        QueryBuilder::<Postgres>::new(format!("SELECT count(*) FROM {} WHERE true", g.table));
    for b in [&mut b, &mut count_query] {
        if name == "support" {
            b.push(" AND tenant_id=")
                .push_bind(tenant.ok_or(Error::Forbidden)?);
        }
        if !r.q.is_empty() {
            // Literal substring search; trigram expression indexes support selective searches.
            let escaped =
                r.q.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_");
            b.push(format!(" AND (({}) ILIKE ", g.search))
                .push_bind(format!("%{}%", escaped));
            // Numeric IDs are exact indexed lookups; ordinary text keeps literal substring search.
            if name != "audit" && g.columns.split(',').any(|c| c == "entity_id") {
                if let Ok(entity_id) = r.q.trim().trim_start_matches('#').parse::<i64>() {
                    b.push(" OR entity_id=").push_bind(entity_id);
                }
            }
            b.push(")");
        }
        if let Some(v) = &r.action {
            b.push(" AND action=").push_bind(v);
        }
        if let Some(v) = r.actor_id {
            b.push(" AND actor_id=").push_bind(v);
        }
        if let Some(v) = r.entity_id {
            b.push(" AND entity_id=").push_bind(v);
        }
        if let Some(v) = r.created_from {
            b.push(" AND created_at>=").push_bind(v);
        }
        if let Some(v) = r.created_to {
            b.push(" AND created_at<").push_bind(v);
        }
        if let Some(v) = r.system {
            b.push(" AND system=").push_bind(v);
        }
        if let Some(v) = r.document_id {
            b.push(" AND document_id=").push_bind(v);
        }
        if let Some(v) = &r.entity_type {
            b.push(" AND entity_type=").push_bind(v);
        }
        if name != "source-items" {
            if let Some(v) = r.product_id {
                b.push(" AND product_id=").push_bind(v);
            }
        }
        if let Some(v) = r.order_id {
            b.push(" AND order_id=").push_bind(v);
        }
        if let Some(v) = r.category_id {
            b.push(" AND category_id=").push_bind(v);
        }
        if let Some(v) = r.role_id {
            b.push(" AND role_id=").push_bind(v);
        }
        if let Some(v) = r.active {
            b.push(" AND active=").push_bind(v);
        }
        if let Some(v) = &r.status {
            b.push(" AND status=").push_bind(v);
        }
        if let Some(v) = &r.kind {
            b.push(" AND kind=").push_bind(v);
        }
    }
    let total_count: i64 = if include_total {
        count_query
            .build_query_scalar()
            .fetch_one(&mut *conn)
            .await?
    } else {
        0
    };
    if let Some(c) = &r.cursor {
        let c: Cursor =
            serde_json::from_str(c).map_err(|_| Error::Invalid("Invalid cursor".into()))?;
        let op = if r.descending { " < " } else { " > " };
        if sort == "id" {
            b.push(format!(" AND id{op}")).push_bind(c.id);
        } else {
            b.push(format!(" AND ({sort},id){op}("))
                .push_bind(
                    c.value
                        .ok_or_else(|| Error::Invalid("Missing cursor value".into()))?,
                )
                .push(format!("::{},", sort_type(sort)))
                .push_bind(c.id)
                .push(")");
        }
    }
    let direction = if r.descending { "DESC" } else { "ASC" };
    b.push(format!(
        " ORDER BY {sort} {direction}{} LIMIT ",
        if sort == "id" {
            String::new()
        } else {
            format!(",id {direction}")
        }
    ))
    .push_bind(r.limit.unwrap_or(50) + 1)
    .push(") t");
    if name == "audit" {
        // Resolve only the selected page. UUIDs remain the filter/cursor identity;
        // names are display metadata and do not require separate UI permissions.
        b.push(" LEFT JOIN admin_iam.admin_users audit_actor ON audit_actor.id=t.actor_id
            LEFT JOIN LATERAL (
                SELECT coalesce(nullif(name,''),email) AS name,'Administrator' AS kind FROM admin_iam.admin_users WHERE id=t.entity_id
                UNION ALL SELECT name,'Role' FROM admin_iam.roles WHERE id=t.entity_id
                UNION ALL SELECT name,'Product' FROM catalog.products WHERE id=t.entity_id
                UNION ALL SELECT name,'Category' FROM catalog.categories WHERE id=t.entity_id
                UNION ALL SELECT 'Order #' || number::text,'Order' FROM orders.orders WHERE id=t.entity_id
                UNION ALL SELECT key,'Content' FROM cms.documents WHERE id=t.entity_id
                UNION ALL SELECT name,'Promotion' FROM pricing_promotions.rules WHERE id=t.entity_id
                UNION ALL SELECT subject,'Support ticket' FROM support.tickets WHERE id=t.entity_id
                LIMIT 1
            ) audit_entity ON true");
    }
    if name == "inventory" {
        b.push(" LEFT JOIN inventory.stock st ON st.product_id=t.id CROSS JOIN LATERAL (SELECT coalesce(sum(quantity),0)::bigint AS quantity FROM inventory.reservations WHERE product_id=t.id AND expires_at>statement_timestamp()) rs");
    }
    if name == "source-items" {
        b.push(" CROSS JOIN (SELECT ").push_bind(r.product_id).push("::uuid AS product_id) selected LEFT JOIN inventory.source_items si ON si.source_id=t.id AND si.product_id=selected.product_id CROSS JOIN LATERAL (SELECT coalesce(sum(a.quantity),0)::bigint quantity FROM inventory.reservation_allocations a JOIN inventory.reservations r USING(cart_id,product_id) WHERE a.source_id=t.id AND a.product_id=selected.product_id AND r.expires_at>statement_timestamp()) rs");
    }
    let mut items: Vec<Value> = b.build_query_scalar().fetch_all(&mut *conn).await?;
    let more = items.len() > r.limit.unwrap_or(50) as usize;
    if more {
        items.pop();
    }
    let next_cursor = if more {
        Some(
            serde_json::to_string(&Cursor {
                id: serde_json::from_value(items.last().unwrap()["id"].clone())
                    .map_err(|_| Error::Internal)?,
                scope: scope(name, r),
                value: if sort == "id" {
                    None
                } else {
                    let v = &items.last().unwrap()[sort];
                    Some(
                        v.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| v.to_string()),
                    )
                },
            })
            .unwrap(),
        )
    } else {
        None
    };
    Ok(Page {
        items,
        next_cursor,
        total_count,
    })
}
pub fn tenant() -> Option<Uuid> {
    std::env::var("ASSISTANT_TENANT_ID")
        .ok()
        .and_then(|v| v.parse().ok())
}
pub fn router(a: App) -> Router {
    Router::new()
        .route("/v1/admin/grids/{name}", get(list))
        .route("/v1/admin/grids/{name}/sorts", get(sort_metadata))
        .layer(middleware::from_fn_with_state(a.clone(), identity::policy))
        .with_state(a)
}
async fn list(
    State(a): State<App>,
    h: HeaderMap,
    Path(name): Path<String>,
    Query(r): Query<Request>,
) -> std::result::Result<Json<Page>, ApiError> {
    let who = a
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?;
    who.require(definition(&name)?.permission)?;
    let mut conn = a.customers.pool.acquire().await.map_err(Error::from)?;
    let mut tx = sqlx::Connection::begin(&mut *conn)
        .await
        .map_err(Error::from)?;
    sqlx::query("SET LOCAL statement_timeout='5s'")
        .execute(&mut *tx)
        .await
        .map_err(Error::from)?;
    Ok(Json(page(&mut tx, &name, &r, tenant()).await?))
}

async fn sort_metadata(
    State(a): State<App>,
    h: HeaderMap,
    Path(name): Path<String>,
) -> std::result::Result<Json<Vec<&'static str>>, ApiError> {
    a.admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?
        .require(definition(&name)?.permission)?;
    Ok(Json(sorts(&name)?))
}
