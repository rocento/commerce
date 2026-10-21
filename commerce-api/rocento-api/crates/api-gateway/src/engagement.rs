//! Isolated journey/inbox storage and durable asynchronous jobs. Never falls back
//! to the commerce pool if a configured engagement database is unavailable.
use chrono::{DateTime, Utc};
use infra_auth::{Error, Result};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub async fn connect(url: &str, connections: u32) -> Result<PgPool> {
    Ok(sqlx::postgres::PgPoolOptions::new()
        .max_connections(connections)
        .acquire_timeout(std::time::Duration::from_secs(2))
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query("SET statement_timeout='5s'")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect(url)
        .await?)
}

pub async fn migrate(pool: &PgPool) -> Result<()> {
    sqlx::migrate!("../../engagement-migrations")
        .run(pool)
        .await
        .map_err(|_| Error::Invalid("Engagement database migration failed".into()))
}

// The source tables remain intact for backup/recovery. Import once, under source
// write locks, in FK order. An interrupted import rolls back in the destination.
// Deployment stops the old gateway before invoking this cutover.
pub async fn import(commerce: &PgPool, target: &PgPool) -> Result<()> {
    let source_id: Uuid =
        sqlx::query_scalar("SELECT installation_id FROM platform.publication_installation LIMIT 1")
            .fetch_one(commerce)
            .await?;
    let mut destination = target.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(106001)")
        .execute(&mut *destination)
        .await?;
    let installed: Option<Uuid> = sqlx::query_scalar(
        "SELECT source_id FROM platform.engagement_installation WHERE singleton",
    )
    .fetch_optional(&mut *destination)
    .await?;
    if let Some(installed) = installed {
        if installed != source_id {
            return Err(Error::Invalid(
                "Engagement database belongs to a different store".into(),
            ));
        }
        return Ok(());
    }
    let tables = [
        ("customers.journey_events", "true"),
        ("platform.marketing_notification_programs", "true"),
        ("platform.marketing_notification_records", "true"),
        ("platform.marketing_notification_requests", "true"),
        ("platform.storefront_notification_publications", "true"),
        ("platform.storefront_notification_publish_requests", "true"),
        ("platform.storefront_notification_recipients", "true"),
        ("platform.storefront_notification_read_states", "true"),
        ("platform.storefront_notification_deliveries", "true"),
        ("platform.notification_campaigns", "true"),
        ("platform.notification_campaign_events", "true"),
        ("admin_iam.audit_log", "action LIKE 'notifications.%'"),
    ];
    let mut source = commerce.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='120s'")
        .execute(&mut *source)
        .await?;
    sqlx::query("SET LOCAL lock_timeout='10s'")
        .execute(&mut *source)
        .await?;
    let names = tables
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(",");
    sqlx::query(&format!("LOCK TABLE {names} IN SHARE MODE"))
        .execute(&mut *source)
        .await?;
    for (table, filter) in tables {
        let existing: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&mut *destination)
            .await?;
        if existing != 0 {
            return Err(Error::Invalid(format!(
                "Uninitialized engagement database is not empty: {table}"
            )));
        }
        let mut offset = 0_i64;
        loop {
            // Fixed table names only. Holding table locks makes ctid paging stable.
            let rows: Vec<Value> = sqlx::query_scalar(&format!("SELECT to_jsonb(t) FROM {table} t WHERE {filter} ORDER BY ctid LIMIT 500 OFFSET $1"))
                .bind(offset).fetch_all(&mut *source).await?;
            if rows.is_empty() {
                break;
            }
            let count = rows.len();
            sqlx::query(&format!("INSERT INTO {table} SELECT * FROM jsonb_populate_recordset(NULL::{table},$1) ON CONFLICT DO NOTHING"))
                .bind(json!(rows)).execute(&mut *destination).await?;
            offset += count as i64;
        }
        let source_count: i64 =
            sqlx::query_scalar(&format!("SELECT count(*) FROM {table} WHERE {filter}"))
                .fetch_one(&mut *source)
                .await?;
        let target_count: i64 =
            sqlx::query_scalar(&format!("SELECT count(*) FROM {table} WHERE {filter}"))
                .fetch_one(&mut *destination)
                .await?;
        if source_count != target_count {
            return Err(Error::Invalid(format!(
                "Engagement import count mismatch: {table}"
            )));
        }
    }
    sqlx::query(
        "INSERT INTO platform.engagement_installation(singleton,source_id) VALUES(true,$1)",
    )
    .bind(source_id)
    .execute(&mut *destination)
    .await?;
    destination.commit().await?;
    source.commit().await?;
    Ok(())
}

pub async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    actor: Option<Uuid>,
    action: &str,
    id: Uuid,
    details: Value,
) -> Result<()> {
    // Notification audit belongs to the same transaction as the isolated mutation.
    sqlx::query("INSERT INTO admin_iam.audit_log(id,actor_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)")
        .bind(Uuid::new_v4()).bind(actor).bind(action).bind(id).bind(details).execute(&mut **tx).await?;
    infra_events::record(tx, action, json!({"actor_id":actor,"entity_id":id})).await?;
    Ok(())
}

pub async fn enqueue(pool: &PgPool, key: String, kind: &str, payload: Value) -> Result<Uuid> {
    let id = Uuid::new_v4();
    // Installation admission limits live in the isolated database too.
    infra_auth::admit(pool, &[("engagement:enqueue".into(), 100000)]).await?;
    let id = sqlx::query_scalar("INSERT INTO platform.engagement_jobs(id,dedupe_key,kind,payload) VALUES($1,$2,$3,$4) ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING id")
        .bind(id).bind(key).bind(kind).bind(payload).fetch_one(pool).await?;
    Ok(id)
}

pub async fn browser_rows(
    pool: &PgPool,
    customer: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Value> {
    browser_page(pool, customer, from, to, None, None, None).await
}
pub async fn browser_page(
    pool: &PgPool,
    customer: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    before: Option<DateTime<Utc>>,
    before_id: Option<&str>,
    kind: Option<&str>,
) -> Result<Value> {
    // Page in the isolated database BEFORE joining commerce facts. 101 rows
    // suffice for the maximum 100-item merged journey page plus its cursor.
    let rows: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(e) FROM customers.journey_events e WHERE customer_id=$1 AND occurred_at >= $2 AND occurred_at < $3 AND ($4::timestamptz IS NULL OR (occurred_at,'browser:'||id::text)<($4,$5::text)) AND ($6::text IS NULL OR CASE WHEN event_type='search_query' THEN 'search' WHEN path='/' THEN 'visit' WHEN path LIKE '/products/%' THEN 'product_view' WHEN path LIKE '/categories/%' THEN 'category_view' ELSE 'page_view' END=$6) ORDER BY occurred_at DESC,id DESC LIMIT 101")
        .bind(customer).bind(from).bind(to).bind(before).bind(before_id).bind(kind).fetch_all(pool).await?;
    Ok(json!(rows))
}
pub fn browser_source(parameter: usize) -> String {
    format!("jsonb_to_recordset(${parameter}) AS e(customer_id uuid,id uuid,session_id uuid,event_type text,path text,query text,result_count bigint,source text,occurred_at timestamptz)")
}

/// Refresh only public product references and zone geometry; no customer secrets,
/// orders, cart contents or payment data are replicated into engagement storage.
pub async fn project(commerce: &PgPool, target: &PgPool) -> Result<()> {
    let mut tx = target.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(106002)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE catalog.products SET active=false WHERE active")
        .execute(&mut *tx)
        .await?;
    let mut after = Uuid::nil();
    loop {
        let rows: Vec<(Uuid, String, String, bool)> = sqlx::query_as("SELECT p.id,p.slug,p.name,p.active AND (p.parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.products parent WHERE parent.id=p.parent_id AND parent.active)) FROM catalog.products p WHERE p.id>$1 ORDER BY p.id LIMIT 500")
            .bind(after).fetch_all(commerce).await?;
        if rows.is_empty() {
            break;
        }
        after = rows.last().unwrap().0;
        let data: Vec<Value> = rows
            .into_iter()
            .map(
                |(id, slug, name, active)| json!({"id":id,"slug":slug,"name":name,"active":active}),
            )
            .collect();
        sqlx::query("INSERT INTO catalog.products SELECT * FROM jsonb_populate_recordset(NULL::catalog.products,$1) ON CONFLICT(id) DO UPDATE SET slug=EXCLUDED.slug,name=EXCLUDED.name,active=EXCLUDED.active")
            .bind(json!(data)).execute(&mut *tx).await?;
    }
    let areas: Vec<Value> =
        sqlx::query_scalar("SELECT to_jsonb(a) FROM inventory.delivery_areas a")
            .fetch_all(commerce)
            .await?;
    let links: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('area_id',area_id,'stock_id',stock_id) FROM inventory.area_stock_links").fetch_all(commerce).await?;
    sqlx::query("DELETE FROM inventory.area_stock_links")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM inventory.delivery_areas")
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO inventory.delivery_areas SELECT * FROM jsonb_populate_recordset(NULL::inventory.delivery_areas,$1)").bind(json!(areas)).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO inventory.area_stock_links SELECT * FROM jsonb_populate_recordset(NULL::inventory.area_stock_links,$1)").bind(json!(links)).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO platform.engagement_worker_state(singleton,heartbeat_at,projection_at) VALUES(true,clock_timestamp(),clock_timestamp()) ON CONFLICT(singleton) DO UPDATE SET projection_at=EXCLUDED.projection_at").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn process_one(
    pool: &PgPool,
    analytics: Option<&crate::analytics::Client>,
) -> Result<bool> {
    process_one_with_commerce(pool, pool, analytics).await
}
pub async fn process_one_with_commerce(
    pool: &PgPool,
    commerce: &PgPool,
    analytics: Option<&crate::analytics::Client>,
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let row: Option<(Uuid,String,Value,DateTime<Utc>,i32)> = sqlx::query_as("SELECT id,kind,payload,created_at,attempts FROM platform.engagement_jobs WHERE completed_at IS NULL AND failed_at IS NULL AND available_at<=clock_timestamp() ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1")
        .fetch_optional(&mut *tx).await?;
    let Some((id, kind, payload, occurred, attempts)) = row else {
        return Ok(false);
    };
    let mut privacy = commerce.begin().await?;
    if kind == "browser" {
        if let Some(customer) = payload["customer"]
            .as_str()
            .and_then(|s| s.parse::<Uuid>().ok())
        {
            let deleted:Option<bool>=sqlx::query_scalar("SELECT deletion_requested_at IS NOT NULL FROM customers.customers WHERE id=$1 FOR SHARE").bind(customer).fetch_optional(&mut *privacy).await?;
            if deleted != Some(false) {
                sqlx::query("DELETE FROM platform.engagement_jobs WHERE id=$1")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                tx.commit().await?;
                return Ok(true);
            }
        }
    }
    let result: Result<()> = async {
        if kind == "campaign_evaluate" {
            let recipient = payload["recipient"].as_str().and_then(|s|Uuid::parse_str(s).ok()).ok_or(Error::Invalid("Missing queued recipient".into()))?;
            let area = payload["area"].as_str().and_then(|s|Uuid::parse_str(s).ok());
            let fresh: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform.engagement_worker_state WHERE singleton AND projection_at>clock_timestamp()-interval '2 minutes')").fetch_one(&mut *tx).await?;
            if !fresh { return Err(Error::Busy); }
            let after=payload["after"].as_str().and_then(|s|Uuid::parse_str(s).ok());
            let campaign=payload["campaign"].as_str().and_then(|s|Uuid::parse_str(s).ok());
            let run_id=payload["run_id"].as_str().and_then(|s|Uuid::parse_str(s).ok()).unwrap_or(id);
            crate::notification_campaigns::evaluate(crate::notification_campaigns::CampaignDatabases { engagement: pool, commerce },recipient,area,true,after,campaign,Some(run_id)).await?;
        } else if kind == "browser" {
            let event: crate::analytics::Event = serde_json::from_value(payload["event"].clone()).map_err(|_| Error::Invalid("Invalid queued browser event".into()))?;
            event.validate()?;
            if let Some(customer) = payload["customer"].as_str().and_then(|s|Uuid::parse_str(s).ok()) {
                if matches!(event.event_type.as_str(), "page_view" | "search_query") {
                    sqlx::query("INSERT INTO customers.journey_events(customer_id,id,session_id,event_type,path,query,result_count,source,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(customer_id,id) DO NOTHING")
                        .bind(customer).bind(event.id).bind(event.session_id).bind(&event.event_type).bind(&event.path).bind(&event.query).bind(event.result_count.map(i64::from)).bind(event.source.as_deref().unwrap_or("unknown")).bind(occurred).execute(&mut *tx).await?;
                }
            }
            if let Some(analytics) = analytics {
                tokio::time::timeout(std::time::Duration::from_secs(3), analytics.ingest_at(event, occurred)).await.map_err(|_|Error::Busy)??;
            }
        } else {
            let recipient = payload["recipient"].as_str().and_then(|s|Uuid::parse_str(s).ok()).ok_or(Error::Invalid("Missing queued recipient".into()))?;
            let area = payload["area"].as_str().and_then(|s|Uuid::parse_str(s).ok());
            let reference = payload["product"].as_str().ok_or(Error::Invalid("Missing queued product".into()))?;
            let fresh: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform.engagement_worker_state WHERE singleton AND projection_at>clock_timestamp()-interval '2 minutes')").fetch_one(&mut *tx).await?;
            if !fresh { return Err(Error::Busy); }
            sqlx::query("INSERT INTO platform.notification_campaign_events(recipient_id,kind,reference,event_id,occurred_at) SELECT id,'product_view',$2,$3,$4 FROM platform.storefront_notification_recipients WHERE id=$1 AND (expires_at IS NULL OR expires_at>clock_timestamp()) ON CONFLICT(recipient_id,kind,reference) DO UPDATE SET event_id=EXCLUDED.event_id,occurred_at=EXCLUDED.occurred_at WHERE platform.notification_campaign_events.occurred_at<EXCLUDED.occurred_at AND platform.notification_campaign_events.event_id<>EXCLUDED.event_id")
                .bind(recipient).bind(reference).bind(id).bind(occurred).execute(&mut *tx).await?;
            sqlx::query("DELETE FROM platform.notification_campaign_events WHERE recipient_id=$1 AND kind='product_view' AND reference IN (SELECT reference FROM platform.notification_campaign_events WHERE recipient_id=$1 AND kind='product_view' ORDER BY occurred_at DESC OFFSET 100)").bind(recipient).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO platform.engagement_jobs(id,dedupe_key,kind,payload) SELECT $1,$2,'campaign_evaluate',$3 WHERE EXISTS(SELECT 1 FROM platform.storefront_notification_publications WHERE audience_rules IS NOT NULL AND withdrawn_at IS NULL AND expires_at>clock_timestamp()) ON CONFLICT(dedupe_key) DO NOTHING")
                .bind(Uuid::new_v4()).bind(format!("campaign-product:{id}")).bind(json!({"recipient":recipient,"area":area})).execute(&mut *tx).await?;
            sqlx::query("SELECT pg_advisory_xact_lock_shared(1040701)").execute(&mut *tx).await?;
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,10409))").bind(recipient.to_string()).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO platform.storefront_notification_deliveries(recipient_id,publication_id,delivered_at) SELECT r.id,n.id,clock_timestamp() FROM platform.storefront_notification_recipients r JOIN platform.storefront_notification_publications n ON n.trigger_product_id IS NOT NULL JOIN catalog.products p ON p.id=n.trigger_product_id WHERE r.id=$1 AND (r.expires_at IS NULL OR r.expires_at>clock_timestamp()) AND p.active AND (p.id=$2 OR p.slug=$3) AND n.audience_rules IS NULL AND n.withdrawn_at IS NULL AND n.published_at<=$4 AND n.expires_at>clock_timestamp() AND (cardinality(n.area_ids)=0 OR $5::uuid=ANY(n.area_ids)) AND ((r.customer_id IS NULL AND n.audience IN ('all','guests')) OR (r.customer_id IS NOT NULL AND n.audience IN ('all','customers'))) ON CONFLICT(recipient_id,publication_id) DO NOTHING")
                .bind(recipient).bind(Uuid::parse_str(reference).ok()).bind(reference).bind(occurred).bind(area).execute(&mut *tx).await?;
        }
        Ok(())
    }.await;
    match result {
        Ok(()) => {
            sqlx::query("UPDATE platform.engagement_jobs SET completed_at=clock_timestamp(),payload='{}'::jsonb,last_error=NULL WHERE id=$1").bind(id).execute(&mut *tx).await?;
            tx.commit().await?;
        }
        Err(_) => {
            // Roll back domain writes before scheduling a retry. An unexpected
            // database failure cannot strand a job in an in-progress state.
            tx.rollback().await?;
            sqlx::query("UPDATE platform.engagement_jobs SET attempts=attempts+1,available_at=clock_timestamp()+make_interval(secs=>$2),failed_at=CASE WHEN attempts>=9 THEN clock_timestamp() ELSE NULL END,last_error='Processing failed; inspect worker health' WHERE id=$1 AND completed_at IS NULL")
                .bind(id).bind((2_f64.powi(attempts.min(8)+1)).min(300.)).execute(pool).await?;
        }
    }
    Ok(true)
}

pub async fn health(pool: &PgPool) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform.engagement_worker_state WHERE singleton AND heartbeat_at>clock_timestamp()-interval '30 seconds' AND projection_at>clock_timestamp()-interval '2 minutes') AND NOT EXISTS(SELECT 1 FROM platform.engagement_jobs WHERE failed_at IS NOT NULL OR (completed_at IS NULL AND available_at<clock_timestamp()-interval '5 minutes'))").fetch_one(pool).await?)
}

pub async fn customer(app: &crate::identity::App, token: &str) -> Result<Uuid> {
    let claims = app.customers.security.decode(token)?;
    let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers.sessions WHERE id=$1 AND customer_id=$2 AND expires_at>now())")
        .bind(claims.sid).bind(claims.sub).fetch_one(&app.engagement_commerce).await?;
    if !valid {
        return Err(Error::Unauthorized);
    }
    Ok(claims.sub)
}
pub async fn admin(app: &crate::identity::App, token: &str) -> Result<domain_admin_iam::Identity> {
    domain_admin_iam::Service {
        pool: app.engagement_commerce.clone(),
        security: app.admins.security.clone(),
    }
    .authenticate(token)
    .await
}
