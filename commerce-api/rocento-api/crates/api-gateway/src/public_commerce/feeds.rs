//! Durable, installation-local publication reconciliation and a reference adapter.
//! No remote provider or customer context is involved in this module.
use super::snapshot::{self, Request, Snapshot};
use crate::{
    discoverability::{App, Settings, SELECT},
    identity::{self, ApiError},
};
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

const BATCH: i64 = 10;
#[derive(Serialize, FromRow)]
pub struct Event {
    pub version: i64,
    pub installation_id: Uuid,
    pub item_key: String,
    pub product_id: Uuid,
    pub operation: String,
    pub payload: Value,
}
const EVENT_COLUMNS: &str = "version,installation_id,item_key,product_id,operation,payload";
/// Adapters must use item_key + version as an idempotency key and reject older versions.
/// Errors are fixed codes: provider responses and credentials never enter persisted diagnostics.
#[allow(async_fn_in_trait)]
pub trait FeedAdapter {
    async fn deliver(&self, db: &mut PgConnection, event: &Event) -> Result<(), &'static str>;
}
pub struct ReferenceAdapter;
impl FeedAdapter for ReferenceAdapter {
    async fn deliver(&self, db: &mut PgConnection, e: &Event) -> Result<(), &'static str> {
        if !matches!(e.operation.as_str(), "upsert" | "delete")
            || e.version <= 0
            || e.payload["id"].as_str() != Some(e.product_id.to_string().as_str())
            || e.payload["installation_id"].as_str() != Some(e.installation_id.to_string().as_str())
            || e.payload["market"] != "default"
            || (e.operation == "upsert"
                && (e.payload["title"]
                    .as_str()
                    .is_none_or(|v| v.trim().is_empty())
                    || e.payload["representation_version"]
                        .as_str()
                        .is_none_or(|v| v.len() != 64)))
        {
            return Err("invalid_item");
        }
        sqlx::query("INSERT INTO platform.publication_reference_feed(item_key,version,operation,payload) VALUES($1,$2,$3,$4) ON CONFLICT(item_key) DO UPDATE SET version=excluded.version,operation=excluded.operation,payload=excluded.payload WHERE publication_reference_feed.version<excluded.version")
            .bind(&e.item_key).bind(e.version).bind(&e.operation).bind(&e.payload).execute(db).await.map_err(|_| "reference_storage_unavailable")?;
        Ok(())
    }
}
/// Submission adapters are deliberately separate from feed adapters and domain transactions.
/// A future transport must validate provider ownership, credentials and limits before enqueueing.
#[derive(Serialize)]
pub struct SubmissionIntent {
    pub installation_id: Uuid,
    pub approved_origin: String,
    pub sitemap_url: String,
    pub representation_version: String,
}

fn item(s: &Snapshot) -> Option<Value> {
    if s.status != 200 || s.robots != "index, follow" {
        return None;
    }
    let p = s.product.as_ref()?;
    let canonical = s.canonical.as_ref()?;
    let image = p.image_id.and_then(|id| s.images.get(&id)).map(|i| {
        json!({
            "url":format!("{}api/v1/catalog/media/{}/content",s.origin,i.id),
            "width":i.width,"height":i.height,"alt":i.alt
        })
    });
    Some(json!({
        "schema_version":1,"installation_id":s.installation_id,"id":p.id,
        "locale":s.locale,"market":"default","url":canonical.feed,
        "representation_version":s.representation_version,
        "title":p.name,"description":p.description,"sku":p.sku,
        "product_type":p.product_type,"parent_id":p.parent_id,
        "variant_dimensions":s.variant_dimensions,"attributes":p.attributes,
        "price":if p.offer_eligible {Some(&p.price)} else {None},
        "currency":p.currency,"price_diagnostic":p.price_diagnostic,
        "availability":{"status":"unresolved","description":s.availability},"image":image
    }))
}
fn key(body: &Value) -> String {
    format!(
        "{}:{}:{}:{}",
        body["installation_id"].as_str().unwrap_or_default(),
        body["locale"].as_str().unwrap_or_default(),
        body["market"].as_str().unwrap_or_default(),
        body["id"].as_str().unwrap_or_default()
    )
}
async fn emit(
    db: &mut PgConnection,
    installation: Uuid,
    id: Uuid,
    body: &Value,
    operation: &str,
) -> Result<(), sqlx::Error> {
    let payload = if operation == "delete" {
        json!({"id":id,"installation_id":installation,"locale":body["locale"],"market":body["market"]})
    } else {
        body.clone()
    };
    sqlx::query("INSERT INTO platform.publication_feed_events(installation_id,item_key,product_id,operation,payload) VALUES($1,$2,$3,$4,$5)")
        .bind(installation).bind(key(body)).bind(id).bind(operation).bind(payload).execute(db).await?;
    Ok(())
}
// Compare both journal and receiver. Reconciliation repairs lost events/receiver rows
// without advancing semantic lastmod when the public representation did not change.
async fn ensure_event(
    db: &mut PgConnection,
    installation: Uuid,
    id: Uuid,
    body: &Value,
    operation: &str,
) -> Result<(), sqlx::Error> {
    let latest:Option<(String,Value,String)>=sqlx::query_as("SELECT operation,payload,status FROM platform.publication_feed_events WHERE item_key=$1 ORDER BY version DESC LIMIT 1").bind(key(body)).fetch_optional(&mut *db).await?;
    let expected = if operation == "delete" {
        json!({"id":id,"installation_id":installation,"locale":body["locale"],"market":body["market"]})
    } else {
        body.clone()
    };
    let mut healthy = false;
    if let Some((op, payload, status)) = latest {
        if op == operation && payload == expected {
            healthy = if status == "delivered" {
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform.publication_reference_feed WHERE item_key=$1 AND operation=$2 AND payload=$3)").bind(key(body)).bind(operation).bind(&expected).fetch_one(&mut *db).await?
            } else {
                true
            };
        }
    }
    if !healthy {
        emit(db, installation, id, body, operation).await?;
    }
    Ok(())
}
#[derive(FromRow)]
struct Resource {
    kind: String,
    id: Uuid,
    path: String,
}
#[derive(FromRow)]
struct Previous {
    fingerprint: String,
    feed: Option<Value>,
}
/// One keyset page. A transaction-scoped advisory lock prevents competing reconcilers.
/// Domain transactions are not locked while snapshots are assembled.
pub async fn reconcile_batch(a: &App) -> Result<usize, sqlx::Error> {
    let pool = &a.identity.admins.pool;
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='5000ms'")
        .execute(&mut *tx)
        .await?;
    let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(902109)")
        .fetch_one(&mut *tx)
        .await?;
    if !locked {
        return Ok(0);
    }
    let installation: Uuid =
        sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
            .fetch_one(&mut *tx)
            .await?;
    if a.deployment.installation_id != Some(installation) {
        return Err(sqlx::Error::Protocol(
            "installation binding mismatch".into(),
        ));
    }
    let (generation,scan,completed,cursor_kind,cursor_id,due,allowed):(i64,i64,i64,String,Uuid,bool,bool)=sqlx::query_as("SELECT generation,scan_generation,completed_generation,cursor_kind,cursor_id,next_scan_at<=now(),next_batch_at<=now() FROM platform.publication_freshness WHERE singleton").fetch_one(&mut *tx).await?;
    if !allowed || (cursor_kind.is_empty() && generation == completed && !due) {
        return Ok(0);
    }
    let scan = if cursor_kind.is_empty() {
        generation
    } else {
        scan
    };
    let rows:Vec<Resource>=sqlx::query_as("SELECT * FROM (SELECT 'products'::text kind,id,'/products/'||slug path FROM catalog.storefront_products WHERE ('products',id)>($1,$2) UNION ALL SELECT 'categories',id,'/categories/'||slug FROM catalog.storefront_categories WHERE ('categories',id)>($1,$2) UNION ALL SELECT 'content',id,'/pages/'||key FROM cms.documents WHERE key<>'home' AND ('content',id)>($1,$2) UNION ALL SELECT 'home','00000000-0000-0000-0000-000000000000'::uuid,'/' WHERE ('home','00000000-0000-0000-0000-000000000000'::uuid)>($1,$2) UNION ALL SELECT kind,id,path FROM platform.publication_state s WHERE (kind,id)>($1,$2) AND ((kind='products' AND NOT EXISTS(SELECT 1 FROM catalog.storefront_products p WHERE p.id=s.id)) OR (kind='categories' AND NOT EXISTS(SELECT 1 FROM catalog.storefront_categories c WHERE c.id=s.id)) OR (kind='content' AND NOT EXISTS(SELECT 1 FROM cms.documents d WHERE d.id=s.id)))) resources ORDER BY kind,id LIMIT $3")
        .bind(&cursor_kind).bind(cursor_id).bind(BATCH).fetch_all(&mut *tx).await?;
    let mut projected = Vec::with_capacity(rows.len());
    for r in &rows {
        let s = tokio::time::timeout(
            std::time::Duration::from_secs(4),
            snapshot::assemble(
                a,
                Request {
                    path: r.path.clone(),
                    page: 1,
                },
                None,
            ),
        )
        .await
        .map_err(|_| sqlx::Error::Protocol("publication timeout".into()))??;
        let fingerprint = if s.status == 200 {
            s.representation_version.clone()
        } else {
            "deleted".into()
        };
        projected.push((fingerprint, item(&s)));
    }
    // Fence against a domain change that committed while any snapshot was being built.
    let current: i64 = sqlx::query_scalar(
        "SELECT generation FROM platform.publication_freshness WHERE singleton FOR UPDATE",
    )
    .fetch_one(&mut *tx)
    .await?;
    if current != generation {
        return Ok(0);
    }
    for (r, (fingerprint, body)) in rows.iter().zip(projected) {
        let old: Option<Previous> = sqlx::query_as(
            "SELECT fingerprint,feed FROM platform.publication_state WHERE kind=$1 AND id=$2",
        )
        .bind(&r.kind)
        .bind(r.id)
        .fetch_optional(&mut *tx)
        .await?;
        let unchanged = old
            .as_ref()
            .is_some_and(|o| o.fingerprint == fingerprint && (o.feed == body || body.is_none()));
        let previous = old.as_ref().and_then(|o| o.feed.as_ref());
        if let Some(previous) = previous {
            if body.as_ref().is_none_or(|b| key(b) != key(previous)) {
                ensure_event(&mut tx, installation, r.id, previous, "delete").await?;
            }
        }
        if let Some(body) = &body {
            ensure_event(&mut tx, installation, r.id, body, "upsert").await?;
        }
        if unchanged {
            continue;
        }
        let retained = body.or_else(|| previous.cloned());
        sqlx::query("INSERT INTO platform.publication_state(kind,id,path,fingerprint,version,changed_at,feed) VALUES($1,$2,$3,$4,nextval('platform.publication_version'),clock_timestamp(),$5) ON CONFLICT(kind,id) DO UPDATE SET path=excluded.path,fingerprint=excluded.fingerprint,version=excluded.version,changed_at=excluded.changed_at,feed=excluded.feed")
            .bind(&r.kind).bind(r.id).bind(&r.path).bind(fingerprint).bind(retained).execute(&mut *tx).await?;
    }
    if rows.len() < BATCH as usize {
        sqlx::query("UPDATE platform.publication_freshness SET completed_generation=$1,scan_generation=$1,cursor_kind='',cursor_id='00000000-0000-0000-0000-000000000000',last_completed_at=now(),next_scan_at=now()+interval '5 minutes',next_batch_at=now()+interval '1 second',last_error=NULL WHERE singleton").bind(scan).execute(&mut *tx).await?;
    } else {
        let last = rows.last().unwrap();
        sqlx::query("UPDATE platform.publication_freshness SET scan_generation=$1,cursor_kind=$2,cursor_id=$3,next_batch_at=now()+interval '1 second',last_error=NULL WHERE singleton").bind(scan).bind(&last.kind).bind(last.id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(rows.len())
}
/// Atomic local receiver + acknowledgement. Remote adapters must provide the same idempotency
/// across their network boundary (at-least-once delivery, never an exactly-once promise).
pub async fn deliver_batch(a: &App, adapter: &impl FeedAdapter) -> Result<usize, sqlx::Error> {
    let mut tx = a.identity.admins.pool.begin().await?;
    let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(902110)")
        .fetch_one(&mut *tx)
        .await?;
    if !locked {
        return Ok(0);
    }
    let installation: Uuid =
        sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
            .fetch_one(&mut *tx)
            .await?;
    if a.deployment.installation_id != Some(installation) {
        return Err(sqlx::Error::Protocol(
            "installation binding mismatch".into(),
        ));
    }
    let allowed: bool = sqlx::query_scalar(
        "SELECT next_delivery_at<=now() FROM platform.publication_freshness WHERE singleton",
    )
    .fetch_one(&mut *tx)
    .await?;
    if !allowed {
        return Ok(0);
    }
    let events:Vec<Event>=sqlx::query_as(&format!("SELECT {EVENT_COLUMNS} FROM platform.publication_feed_events WHERE installation_id=$1 AND status IN ('queued','retry') AND next_attempt_at<=now() ORDER BY version LIMIT 10 FOR UPDATE SKIP LOCKED")).bind(installation).fetch_all(&mut *tx).await?;
    for e in &events {
        // Never deliver a stale upsert after unpublication or a policy change.
        let settings: Settings = sqlx::query_as(SELECT).fetch_one(&mut *tx).await?;
        let live:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.storefront_products p LEFT JOIN catalog.storefront_products parent ON parent.id=p.parent_id WHERE p.id=$1 AND p.active AND (p.parent_id IS NULL OR parent.active) AND NOT EXISTS(SELECT 1 FROM platform.publication_routes r WHERE r.path='/products/'||p.slug) AND ($2::text IS NULL OR $2=$3||'products/'||p.slug))").bind(e.product_id).bind(e.payload["url"].as_str()).bind(a.deployment.approved_origin.as_deref()).fetch_one(&mut *tx).await?;
        let mut safe = Event {
            version: e.version,
            installation_id: e.installation_id,
            item_key: e.item_key.clone(),
            product_id: e.product_id,
            operation: e.operation.clone(),
            payload: e.payload.clone(),
        };
        if safe.operation == "upsert"
            && (!live
                || a.deployment.resolve(&settings).state != "INDEXABLE"
                || safe.payload["locale"] != settings.default_locale)
        {
            safe.operation = "delete".into();
            safe.payload = json!({"id":e.product_id,"installation_id":installation,"locale":e.payload["locale"],"market":e.payload["market"]});
        }
        // Savepoint contains a failing adapter SQL statement so retry bookkeeping can commit.
        sqlx::query("SAVEPOINT feed_delivery")
            .execute(&mut *tx)
            .await?;
        match adapter.deliver(&mut tx, &safe).await {
            Ok(()) => {
                sqlx::query("RELEASE SAVEPOINT feed_delivery")
                    .execute(&mut *tx)
                    .await?;
                sqlx::query("UPDATE platform.publication_feed_events SET status='delivered',attempts=attempts+1,error_code=NULL WHERE version=$1").bind(e.version).execute(&mut *tx).await?;
            }
            Err(code) => {
                sqlx::query("ROLLBACK TO SAVEPOINT feed_delivery")
                    .execute(&mut *tx)
                    .await?;
                sqlx::query("UPDATE platform.publication_feed_events SET attempts=attempts+1,status=CASE WHEN attempts>=7 OR $2='invalid_item' THEN 'failed' ELSE 'retry' END,error_code=$2,next_attempt_at=now()+make_interval(secs=>LEAST(3600,power(2,LEAST(attempts+1,12)))::double precision) WHERE version=$1").bind(e.version).bind(if code=="invalid_item" {"invalid_item"} else {"adapter_delivery_failed"}).execute(&mut *tx).await?;
            }
        }
    }
    sqlx::query("UPDATE platform.publication_freshness SET next_delivery_at=now()+interval '1 second' WHERE singleton").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(events.len())
}
pub async fn worker(a: App) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
    loop {
        tick.tick().await;
        let reconciliation = reconcile_batch(&a).await;
        let delivery = deliver_batch(&a, &ReferenceAdapter).await;
        if reconciliation.is_err() || delivery.is_err() {
            tracing::warn!(event="publication_feed",code="feed_batch_failed",installation_id=?a.deployment.installation_id,"Publication feed batch failed; retry scheduled");
            let _=sqlx::query("UPDATE platform.publication_freshness SET last_error='publication_batch_failed' WHERE singleton").execute(&a.identity.admins.pool).await;
        }
    }
}
async fn authorize(a: &App, h: &HeaderMap, permission: &str) -> Result<Uuid, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(h, "admin_session"))
        .await?;
    who.require(permission)?;
    let id: Uuid =
        sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation")
            .fetch_one(&a.identity.admins.pool)
            .await?;
    if a.deployment.installation_id != Some(id) {
        return Err(Error::Forbidden.into());
    }
    Ok(who.user.id)
}
pub async fn status(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>, ApiError> {
    authorize(&a, &h, "discovery.read").await?;
    let state: Value = sqlx::query_scalar(
        "SELECT to_jsonb(f) FROM platform.publication_freshness f WHERE singleton",
    )
    .fetch_one(&a.identity.admins.pool)
    .await?;
    let counts: Vec<(String, i64)> = sqlx::query_as(
        "SELECT status,count(*) FROM platform.publication_feed_events GROUP BY status",
    )
    .fetch_all(&a.identity.admins.pool)
    .await?;
    let errors:Vec<(i64,Uuid,Option<String>)>=sqlx::query_as("SELECT version,product_id,error_code FROM platform.publication_feed_events WHERE status IN ('retry','failed') ORDER BY version DESC LIMIT 50").fetch_all(&a.identity.admins.pool).await?;
    Ok(Json(
        json!({"adapter":"reference-v1","freshness":state,"jobs":counts,"errors":errors,"batch_size":BATCH,"market":"default","external_submission":"not_configured"}),
    ))
}
pub async fn rebuild(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>, ApiError> {
    let who = authorize(&a, &h, "discovery.write").await?;
    let mut tx = a.identity.admins.pool.begin().await?;
    // One rebuild request per minute per installation; worker progress is never reset by callers.
    let allowed: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(902111)")
        .fetch_one(&mut *tx)
        .await?;
    if !allowed {
        return Err(Error::RateLimited.into());
    }
    let recent:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM admin_iam.audit_log WHERE action='discovery.feeds.reconcile' AND created_at>now()-interval '1 minute')").fetch_one(&mut *tx).await?;
    if recent {
        return Err(Error::RateLimited.into());
    }
    sqlx::query("UPDATE platform.publication_freshness SET generation=generation+1,next_scan_at=now() WHERE singleton").execute(&mut *tx).await?;
    sqlx::query("UPDATE platform.publication_feed_events SET status='retry',attempts=0,next_attempt_at=now(),error_code=NULL WHERE status='failed'").execute(&mut *tx).await?;
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(who),
        "discovery.feeds.reconcile",
        Uuid::from_u128(0xd15c0),
        json!({"adapter":"reference-v1"}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"queued":true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Export {
    #[serde(default)]
    pub after: i64,
    pub until: Option<i64>,
    #[serde(default)]
    pub full: bool,
    #[serde(default)]
    pub key: String,
}
/// Bounded pages, pinned journal watermark. Full mode gives the latest event per item at that
/// watermark; clients start with an empty map and then follow incremental versions.
pub async fn export(
    State(a): State<App>,
    h: HeaderMap,
    Query(q): Query<Export>,
) -> Result<Json<Value>, ApiError> {
    authorize(&a, &h, "discovery.read").await?;
    if q.after < 0 || q.until.is_some_and(|v| v < 0) || q.key.len() > 200 {
        return Err(Error::Invalid("Invalid feed cursor".into()).into());
    }
    let mut tx = a.identity.admins.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='5000ms'")
        .execute(&mut *tx)
        .await?;
    let settings: Settings = sqlx::query_as(SELECT).fetch_one(&mut *tx).await?;
    if a.deployment.resolve(&settings).state != "INDEXABLE" {
        return Err(Error::Forbidden.into());
    }
    let high: i64 =
        sqlx::query_scalar("SELECT coalesce(max(version),0) FROM platform.publication_feed_events")
            .fetch_one(&mut *tx)
            .await?;
    let until = q.until.unwrap_or(high).min(high);
    let mut events: Vec<Event> = if q.full {
        sqlx::query_as(&format!("SELECT {EVENT_COLUMNS} FROM (SELECT DISTINCT ON(item_key) {EVENT_COLUMNS} FROM platform.publication_feed_events WHERE version<=$1 AND item_key>$2 ORDER BY item_key,version DESC) latest ORDER BY item_key LIMIT 101")).bind(until).bind(&q.key).fetch_all(&mut *tx).await?
    } else {
        sqlx::query_as(&format!("SELECT {EVENT_COLUMNS} FROM platform.publication_feed_events WHERE version>$1 AND version<=$2 ORDER BY version LIMIT 101")).bind(q.after).bind(until).fetch_all(&mut *tx).await?
    };
    let more = events.len() > 100;
    events.truncate(100);
    for e in &mut events {
        let live:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.storefront_products p LEFT JOIN catalog.storefront_products parent ON parent.id=p.parent_id WHERE p.id=$1 AND p.active AND (p.parent_id IS NULL OR parent.active) AND NOT EXISTS(SELECT 1 FROM platform.publication_routes r WHERE r.path='/products/'||p.slug) AND ($2::text IS NULL OR $2=$3||'products/'||p.slug))").bind(e.product_id).bind(e.payload["url"].as_str()).bind(a.deployment.approved_origin.as_deref()).fetch_one(&mut *tx).await?;
        if e.operation == "upsert" && (!live || e.payload["locale"] != settings.default_locale) {
            e.operation = "delete".into();
            e.payload = json!({"id":e.product_id,"installation_id":e.installation_id,"locale":e.payload["locale"],"market":e.payload["market"]});
        }
    }
    let next = events.last().map(|e| e.version).unwrap_or(q.after);
    let next_key = events.last().map(|e| e.item_key.clone()).unwrap_or(q.key);
    tx.commit().await?;
    Ok(Json(
        json!({"schema_version":1,"until":until,"next":next,"next_key":next_key,"has_more":more,"items":events}),
    ))
}
