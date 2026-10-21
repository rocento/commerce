use super::*;
use serde::Serialize;

#[derive(Serialize, Deserialize)]
pub struct AssistantReport {
    pub configured: bool,
    pub window_hours: u32,
    pub evaluated_at: chrono::DateTime<Utc>,
    pub total: u64,
    pub completed: u64,
    pub unavailable: u64,
    pub disconnected: u64,
    pub average_latency_ms: Option<f64>,
}
impl AssistantReport {
    fn empty(configured: bool) -> Self {
        Self {
            configured,
            window_hours: 24,
            evaluated_at: Utc::now(),
            total: 0,
            completed: 0,
            unavailable: 0,
            disconnected: 0,
            average_latency_ms: None,
        }
    }
}
pub(super) async fn report(
    State(a): State<App>,
    h: HeaderMap,
) -> std::result::Result<Json<AssistantReport>, ApiError> {
    a.identity
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await?
        .require("reports.read")?;
    let tenant = std::env::var("ASSISTANT_TENANT_ID")
        .ok()
        .and_then(|s| s.parse::<Uuid>().ok());
    let Some(tenant) = tenant else {
        return Ok(Json(AssistantReport::empty(false)));
    };
    Ok(Json(a.analytics.assistant_report(tenant).await?))
}
impl Client {
    pub async fn assistant_report(&self, tenant: Uuid) -> Result<AssistantReport> {
        let exists=self.rows("SELECT count() AS tables FROM system.tables WHERE database='commerce_analytics' AND name='assistant_events'").await?;
        if exists.first().and_then(|v| v["tables"].as_u64()) == Some(0) {
            return Ok(AssistantReport::empty(true));
        }
        // UUID formatting is server-validated, never a client supplied SQL fragment.
        let rows=self.rows(&format!("SELECT count() AS total,countIf(outcome='completed') AS completed,countIf(outcome='unavailable') AS unavailable,countIf(outcome='disconnected') AS disconnected,if(count()=0,NULL,avg(latency_ms)) AS average_latency_ms FROM assistant_events FINAL WHERE tenant_id=toUUID('{tenant}') AND created_at>=now64(3)-INTERVAL 24 HOUR AND created_at<=now64(3)" )).await?;
        let mut row = rows.into_iter().next().ok_or(Error::Internal)?;
        row["configured"] = json!(true);
        row["window_hours"] = json!(24);
        row["evaluated_at"] = json!(Utc::now());
        serde_json::from_value(row).map_err(|_| Error::Internal)
    }
}
