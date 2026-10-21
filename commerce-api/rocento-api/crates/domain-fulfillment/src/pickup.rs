//! ASAP pickup uses location preparation time and optional operating hours, never delivery areas.
use crate::scheduling::{self, Config, Schedule, Slot};
use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use domain_inventory::Tx;
use infra_auth::{Error, Result};
use uuid::Uuid;
pub(crate) async fn asap(
    tx: &mut Tx<'_>,
    store: Uuid,
    source: Uuid,
    method: &str,
    now: DateTime<Utc>,
) -> Result<Slot> {
    let minutes:Option<i32>=sqlx::query_scalar("SELECT preparation_minutes FROM fulfillment.store_sources WHERE store_id=$1 AND source_id=$2").bind(store).bind(source).fetch_optional(&mut **tx).await?;
    let mut minutes = i64::from(minutes.unwrap_or(30));
    let mut timezone = "UTC".to_owned();
    if method == "pickup" {
        let schedule:Option<Schedule>=sqlx::query_as("SELECT * FROM fulfillment.schedules WHERE source_id=$1 AND method='pickup' AND area_id IS NULL").bind(source).fetch_optional(&mut **tx).await?;
        if let Some(mut s) = schedule {
            let local: NaiveDateTime = sqlx::query_scalar("SELECT $1 AT TIME ZONE $2")
                .bind(now)
                .bind(&s.timezone)
                .fetch_one(&mut **tx)
                .await?;
            let mut config: Config =
                serde_json::from_value(s.config.clone()).map_err(|_| Error::Internal)?;
            minutes = minutes.max(config.lead_minutes);
            if !s.enabled || config.cutoff.is_some_and(|cutoff| local.time() >= cutoff) {
                return Err(Error::Invalid("PICKUP_LOCATION_CLOSED".into()));
            }
            // Whole operating periods matter for ASAP; generated appointment boundaries do not.
            config.windows = config
                .windows_for(local.date())
                .into_iter()
                .filter(|w| w.cutoff.is_none_or(|cutoff| local.time() < cutoff))
                .cloned()
                .collect();
            config.exceptions.clear();
            config.duration_minutes = None;
            config.spacing_minutes = 0;
            s.config = serde_json::json!(config);
            if !scheduling::generate_operational(tx, &s, local.date())
                .await?
                .iter()
                .any(|w| w.starts_at <= now && w.ends_at >= now + Duration::minutes(minutes))
            {
                return Err(Error::Invalid("PICKUP_LOCATION_CLOSED".into()));
            }
            timezone = s.timezone;
        }
    }
    Ok(Slot {
        schedule_id: Uuid::nil(),
        source_id: source,
        method: method.into(),
        timezone,
        starts_at: now,
        ends_at: now + Duration::minutes(minutes),
        availability: "AVAILABLE".into(),
    })
}
