//! Minimal anonymous browser analytics. Successful responses mean ClickHouse accepted the row.
use infra_auth::{Error, Result};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

mod consumers;
#[derive(Clone)]
pub struct Client {
    ingestion: std::sync::Arc<tokio::sync::Semaphore>,
    pub(crate) http: reqwest::Client,
    pub(crate) url: String,
    pub(crate) user: String,
    pub(crate) password: String,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub id: Uuid,
    pub session_id: Uuid,
    pub event_type: String,
    pub path: String,
    pub query: Option<String>,
    pub result_count: Option<u32>,
    pub source: Option<String>,
}
impl Event {
    pub fn validate(&self) -> Result<()> {
        if ![
            "page_view",
            "search_query",
            "cart_added",
            "checkout_started",
            "order_placed",
        ]
        .contains(&self.event_type.as_str())
            || self.path.len() > 300
            || !self.path.starts_with('/')
            || self.path.contains(['?', '#'])
            || self.query.as_ref().is_some_and(|s| s.len() > 200)
            || self.source.as_ref().is_some_and(|s| {
                !["direct", "search", "social", "email", "referral", "unknown"]
                    .contains(&s.as_str())
            })
        {
            return Err(domain_catalog::invalid("Invalid analytics event"));
        }
        // Restrict page capture to browse paths; verification/reset query strings are never recorded.
        if !(self.path == "/"
            || self.path == "/search"
            || self.path == "/cart"
            || self.path == "/checkout"
            || self.path == "/checkout/complete"
            || self.path.starts_with("/products/")
            || self.path.starts_with("/categories/"))
        {
            return Err(domain_catalog::invalid(
                "Only catalog navigation is tracked",
            ));
        }
        if self.event_type == "search_query"
            && (self.query.is_none() || self.result_count.is_none())
        {
            return Err(domain_catalog::invalid(
                "Search analytics requires query and result count",
            ));
        }
        Ok(())
    }
}
#[derive(Debug)]
pub struct Unavailable;
impl std::fmt::Display for Unavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(
            "Analytics and reporting are temporarily unavailable. Please try again shortly.",
        )
    }
}
impl std::error::Error for Unavailable {}

pub(crate) fn failure(e: impl std::fmt::Display) -> Error {
    tracing::error!(error=%e,"analytics database failed");
    Error::Business(Box::new(Unavailable))
}
impl Client {
    pub fn new(url: String, user: String, password: String) -> Self {
        Self {
            ingestion: std::sync::Arc::new(tokio::sync::Semaphore::new(64)),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("HTTP client"),
            url,
            user,
            password,
        }
    }
    pub(crate) async fn execute(&self, query: &str, body: String) -> Result<()> {
        self.http
            .post(&self.url)
            .basic_auth(&self.user, Some(&self.password))
            .query(&[("database", "commerce_analytics"), ("query", query)])
            .header(reqwest::header::CONTENT_LENGTH, body.len())
            .body(body)
            .send()
            .await
            .map_err(failure)?
            .error_for_status()
            .map_err(failure)?;
        Ok(())
    }
    pub async fn initialize(&self) -> Result<()> {
        for table in ["page_view_events", "search_query_events"] {
            self.execute(&format!("CREATE TABLE IF NOT EXISTS {table} (id UUID, session_id UUID, occurred_at DateTime64(3) DEFAULT now64(3), path String, query String, result_count UInt32) ENGINE = ReplacingMergeTree ORDER BY id TTL toDateTime(occurred_at) + INTERVAL 90 DAY"),String::new()).await?;
        }
        for table in ["add_to_cart_events", "checkout_funnel_events"] {
            self.execute(&format!("CREATE TABLE IF NOT EXISTS {table} (id UUID, cart_id UUID, product_id UUID, event_type String, quantity UInt32, reason String, occurred_at DateTime64(3) DEFAULT now64(3)) ENGINE=ReplacingMergeTree ORDER BY id TTL toDateTime(occurred_at)+INTERVAL 90 DAY"),String::new()).await?;
        }
        self.execute("CREATE TABLE IF NOT EXISTS order_facts (id UUID, order_id UUID, customer_id UUID, number Int64, total Decimal(24,2), currency String, item_count Int64, occurred_at DateTime64(3) DEFAULT now64(3)) ENGINE=ReplacingMergeTree ORDER BY order_id", String::new()).await?;
        self.initialize_reports().await?;
        Ok(())
    }
    pub async fn ingest(&self, event: Event) -> Result<()> {
        self.ingest_at(event, chrono::Utc::now()).await
    }
    pub async fn ingest_at(
        &self,
        event: Event,
        occurred_at: chrono::DateTime<chrono::Utc>,
    ) -> Result<()> {
        let occurred_at = occurred_at.format("%Y-%m-%d %H:%M:%S%.3f").to_string();
        let _permit = self
            .ingestion
            .try_acquire()
            .map_err(|_| Error::RateLimited)?;
        event.validate()?;
        self.execute("INSERT INTO browser_events (id,session_id,event_type,path,source,occurred_at) SETTINGS async_insert=1,wait_for_async_insert=1,async_insert_busy_timeout_max_ms=50 FORMAT JSONEachRow",json!({"id":event.id,"session_id":event.session_id,"event_type":event.event_type,"path":event.path,"source":event.source.as_deref().unwrap_or("unknown"),"occurred_at":occurred_at}).to_string()).await?;
        if !["page_view", "search_query"].contains(&event.event_type.as_str()) {
            return Ok(());
        }
        let table = if event.event_type == "page_view" {
            "page_view_events"
        } else {
            "search_query_events"
        };
        self.execute(&format!("INSERT INTO {table} (id,session_id,path,query,result_count,occurred_at) SETTINGS async_insert=1,wait_for_async_insert=1,async_insert_busy_timeout_max_ms=50 FORMAT JSONEachRow"),json!({"id":event.id,"session_id":event.session_id,"path":event.path,"query":event.query.unwrap_or_default(),"result_count":event.result_count.unwrap_or(0),"occurred_at":occurred_at}).to_string()).await
    }
}

impl Client {
    /// Assistant telemetry contains bounded metadata only, never questions, replies or tokens.
    pub async fn assistant_metrics(
        &self,
        tenant: Uuid,
        rows: Vec<crate::assistant::Metric>,
    ) -> Result<()> {
        self.execute("CREATE TABLE IF NOT EXISTS assistant_events (tenant_id UUID, request_id UUID, outcome String, latency_ms UInt32, created_at DateTime64(3)) ENGINE=ReplacingMergeTree ORDER BY (tenant_id,request_id) TTL toDateTime(created_at)+INTERVAL 90 DAY",String::new()).await?;
        let mut body = String::new();
        for row in rows {
            if !["completed", "unavailable", "disconnected"].contains(&row.outcome.as_str())
                || row.latency_ms > 60000
            {
                return Err(Error::Invalid("Invalid assistant metric".into()));
            }
            body.push_str(&json!({"tenant_id":tenant,"request_id":row.request_id,"outcome":row.outcome,"latency_ms":row.latency_ms,"created_at":row.created_at.format("%Y-%m-%d %H:%M:%S%.3f").to_string()}).to_string());
            body.push('\n');
        }
        if !body.is_empty() {
            self.execute("INSERT INTO assistant_events FORMAT JSONEachRow", body)
                .await?;
        }
        Ok(())
    }
}
