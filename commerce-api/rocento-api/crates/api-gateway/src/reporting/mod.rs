//! Versioned reporting snapshots: a run becomes visible only after every aggregate succeeds.
pub mod assistant;
use crate::{
    analytics::Client,
    identity::{self, ApiError},
};
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    middleware,
    routing::get,
    Json, Router,
};
use chrono::{NaiveDate, Utc};
use infra_auth::{Error, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use tracing::Instrument;
use uuid::Uuid;

#[derive(Clone)]
pub struct App {
    pub identity: identity::App,
    pub analytics: Client,
}
pub fn router(app: App) -> Router {
    Router::new()
        .route("/v1/admin/reports/dashboard", get(dashboard))
        .route("/v1/admin/reports/assistant", get(assistant::report))
        .route("/v1/admin/reports/trace-probe", get(trace_probe))
        .layer(middleware::from_fn_with_state(
            app.identity.clone(),
            identity::policy,
        ))
        .with_state(app)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DateRange {
    pub from: NaiveDate,
    pub to: NaiveDate,
}
impl DateRange {
    fn validate(&self) -> Result<()> {
        if self.from > self.to
            || (self.to - self.from).num_days() > 365
            || self.to > Utc::now().date_naive()
        {
            return Err(Error::Invalid(
                "Choose a UTC date range of at most 366 days, ending today or earlier".into(),
            ));
        }
        Ok(())
    }
}
async fn dashboard(
    State(a): State<App>,
    h: HeaderMap,
    Query(range): Query<DateRange>,
) -> std::result::Result<Json<Value>, ApiError> {
    a.identity
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?
        .require("reports.read")?;
    range.validate()?;
    Ok(Json(a.analytics.report(&range).await?))
}

async fn trace_probe(
    State(a): State<App>,
    h: HeaderMap,
) -> std::result::Result<Json<Value>, ApiError> {
    if std::env::var("APP_ENV").as_deref() != Ok("development") {
        return Err(Error::NotFound.into());
    }
    a.identity
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?
        .require("reports.read")?;
    static PROBES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    let _permit = PROBES.try_acquire().map_err(|_| Error::RateLimited)?;
    async {
        sqlx::query("SELECT pg_sleep(0.25)")
            .execute(&a.identity.customers.pool)
            .instrument(tracing::info_span!(
                "db.query",
                db.system = "postgresql",
                db.operation.name = "SELECT",
                db.collection.name = "diagnostic_delay"
            ))
            .await
            .map_err(Error::from)?;
        Ok(Json(json!({"status":"ok"})))
    }
    .instrument(tracing::info_span!("diagnostics.database"))
    .await
}
impl Client {
    pub async fn initialize_reports(&self) -> Result<()> {
        for sql in include_str!("schema.sql")
            .split(';')
            .filter(|s| !s.trim().is_empty())
        {
            self.execute(sql, String::new()).await?;
        }
        Ok(())
    }
    #[tracing::instrument(skip_all, name = "analytics.read")]
    pub async fn rows(&self, sql: &str) -> Result<Vec<Value>> {
        let response = self
            .http
            .post(&self.url)
            .basic_auth(&self.user, Some(&self.password))
            .query(&[
                ("database", "commerce_analytics"),
                ("max_execution_time", "15"),
                ("prefer_column_name_to_alias", "1"),
                ("max_memory_usage", "268435456"),
                ("output_format_json_quote_64bit_integers", "0"),
            ])
            .body(format!("{sql} FORMAT JSONEachRow"))
            .send()
            .instrument(tracing::info_span!(
                "db.query",
                db.system = "clickhouse",
                db.operation.name = "SELECT"
            ))
            .await
            .map_err(super::analytics::failure)?
            .error_for_status()
            .map_err(super::analytics::failure)?
            .text()
            .await
            .map_err(super::analytics::failure)?;
        response
            .lines()
            .map(|s| serde_json::from_str(s).map_err(super::analytics::failure))
            .collect()
    }
    pub async fn report(&self, range: &DateRange) -> Result<Value> {
        let runs=self.rows("SELECT toString(generation) generation,formatDateTime(started_at,'%Y-%m-%dT%H:%i:%SZ','UTC') started_at,formatDateTime(completed_at,'%Y-%m-%dT%H:%i:%SZ','UTC') completed_at,dateDiff('second',r.started_at,now()) age_seconds FROM reporting_runs r ORDER BY r.started_at DESC LIMIT 1").await?;
        let run = runs
            .first()
            .ok_or_else(|| Error::Business(Box::new(super::analytics::Unavailable)))?;
        let generation: Uuid = run["generation"]
            .as_str()
            .ok_or(Error::Internal)?
            .parse()
            .map_err(|_| Error::Internal)?;
        let filter = format!(
            "generation='{generation}' AND day BETWEEN '{}' AND '{}'",
            range.from, range.to
        );
        let sales=self.rows(&format!("SELECT toString(day) day,currency,orders,cancelled,toString(gross) gross,toString(refunds) refunds,toString(net) net FROM sales_daily WHERE {filter} ORDER BY day,currency")).await?;
        let products=self.rows(&format!("SELECT toString(product_id) product_id,any(sku) sku,any(name) name,currency,sum(units) units,toString(sum(revenue)) revenue FROM product_performance_daily WHERE {filter} GROUP BY product_id,currency ORDER BY sum(revenue) DESC LIMIT 20")).await?;
        let funnel=self.rows(&format!("SELECT sum(visitors) visitors,sum(carts) carts,sum(checkouts) checkouts,sum(purchases) purchases FROM funnel_daily WHERE {filter}")).await?;
        let traffic=self.rows(&format!("SELECT source,sum(sessions) sessions FROM traffic_daily WHERE {filter} GROUP BY source ORDER BY sum(sessions) DESC")).await?;
        let cohorts=self.rows(&format!("SELECT toString(cohort) cohort,month,customers,returning FROM retention_cohorts WHERE generation='{generation}' AND cohort BETWEEN toStartOfMonth(toDate('{}')) AND toDate('{}') ORDER BY cohort,month",range.from,range.to)).await?;
        let ltv=self.rows(&format!("SELECT currency,count() customers,toString(sum(l.value)) value,toString(round(avg(l.value),2)) average FROM customer_ltv l WHERE generation='{generation}' AND first_order BETWEEN '{}' AND '{}' GROUP BY currency",range.from,range.to)).await?;
        Ok(
            json!({"from":range.from,"to":range.to,"run":run,"sales":sales,"products":products,"funnel":funnel[0],"traffic":traffic,"cohorts":cohorts,"ltv":ltv}),
        )
    }
    /// Independent connection pool and transaction snapshot. A failure leaves the previous generation intact.
    #[tracing::instrument(skip_all, name = "analytics.sync")]
    pub async fn sync_reports(&self, pool: &PgPool) -> Result<bool> {
        use futures_util::TryStreamExt;
        let mut tx = pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            .execute(&mut *tx)
            .await?;
        sqlx::query("SET LOCAL statement_timeout='60s'")
            .execute(&mut *tx)
            .await?;
        let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(88008)")
            .fetch_one(&mut *tx)
            .await?;
        if !locked {
            return Ok(false);
        }
        let generation = Uuid::new_v4();
        let started_at = Utc::now().to_rfc3339();
        let queries=[
            ("reporting_order_facts", "SELECT json_build_object('order_id',o.id,'customer_id',o.customer_id,'day',to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD'),'status',o.status,'currency',o.currency,'total',o.total::text,'refunded',coalesce(r.amount,0)::text) FROM orders.orders o LEFT JOIN payments.manual_refunds r ON r.order_id=o.id"),
            ("reporting_order_items", "SELECT json_build_object('order_id',i.order_id,'product_id',i.product_id,'sku',i.sku,'name',i.name,'day',to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD'),'currency',o.currency,'quantity',i.quantity,'net',(i.line_total-i.discount_amount)::text) FROM orders.order_items i JOIN orders.orders o ON o.id=i.order_id"),
            ("product_dimensions", "SELECT json_build_object('product_id',id,'sku',sku,'name',name) FROM catalog.products"),
            ("customer_dimensions", "SELECT json_build_object('customer_id',id,'registered_on',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD')) FROM customers.customers WHERE deleted_at IS NULL"),
            ("inventory_snapshot_history", "SELECT json_build_object('product_id',s.product_id,'on_hand',s.on_hand,'reserved',coalesce(sum(r.quantity),0)) FROM inventory.stock s LEFT JOIN inventory.reservations r ON r.product_id=s.product_id AND r.expires_at>now() GROUP BY s.product_id,s.on_hand"),
        ];
        for (table, sql) in queries {
            let mut stream = sqlx::query(sql).fetch(&mut *tx);
            let mut batch = String::new();
            let mut count = 0;
            while let Some(row) = stream.try_next().await? {
                let mut value: Value = row.try_get(0)?;
                value["generation"] = json!(generation);
                if table == "inventory_snapshot_history" {
                    value["captured_at"] = json!(started_at);
                }
                batch.push_str(&value.to_string());
                batch.push('\n');
                count += 1;
                if count == 500 {
                    self.insert_report_batch(table, std::mem::take(&mut batch))
                        .await?;
                    count = 0;
                }
            }
            if !batch.is_empty() {
                self.insert_report_batch(table, batch).await?;
            }
        }
        for sql in include_str!("aggregate.sql")
            .split(';')
            .filter(|s| !s.trim().is_empty())
        {
            self.execute(
                &sql.replace("{generation}", &generation.to_string())
                    .replace("{started_at}", &started_at),
                String::new(),
            )
            .await?;
        }
        self.execute("INSERT INTO reporting_runs (generation,started_at) SETTINGS date_time_input_format='best_effort' FORMAT JSONEachRow",json!({"generation":generation,"started_at":started_at}).to_string()).await?;
        tx.commit().await?;
        let counts=self.rows(&format!("SELECT sum(visitors) visitors,sum(purchases) purchases FROM funnel_daily WHERE generation='{generation}' AND day=yesterday()")).await?;
        infra_observability::reporting_metrics(
            Utc::now().timestamp() as u64,
            counts[0]["visitors"].as_u64().unwrap_or(0),
            counts[0]["purchases"].as_u64().unwrap_or(0),
        );
        tracing::info!(%generation,"analytics reporting snapshot published");
        Ok(true)
    }
    async fn insert_report_batch(&self, table: &str, body: String) -> Result<()> {
        self.execute(&format!("INSERT INTO {table} SETTINGS date_time_input_format='best_effort' FORMAT JSONEachRow"),body).await
    }
    pub async fn reporting_worker(self, pool: PgPool) {
        let seconds = std::env::var("REPORTING_INTERVAL_SECONDS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(900)
            .clamp(30, 1800);
        loop {
            let delay = match self.sync_reports(&pool).await {
                Ok(true) => seconds,
                // Replay consumers can briefly hold the snapshot lock during recovery.
                // A skipped or failed attempt must not delay recovery for a full interval.
                Ok(false) => 5,
                Err(error) => {
                    tracing::error!(%error,"analytics sync failed; previous reports retained");
                    5
                }
            };
            tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn range_boundaries() {
        let today = Utc::now().date_naive();
        assert!(DateRange {
            from: today,
            to: today
        }
        .validate()
        .is_ok());
        assert!(DateRange {
            from: today - chrono::Duration::days(366),
            to: today
        }
        .validate()
        .is_err());
        assert!(DateRange {
            from: today,
            to: today - chrono::Duration::days(1)
        }
        .validate()
        .is_err());
        assert!(DateRange {
            from: today,
            to: today + chrono::Duration::days(1)
        }
        .validate()
        .is_err());
    }
}
