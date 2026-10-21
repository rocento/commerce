//! Deterministic local-calendar rules. UTC conversion is delegated to PostgreSQL tzdata.
use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, Timelike, Utc};
use domain_inventory::Tx;
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Window {
    pub weekday: u32,
    pub start: NaiveTime,
    pub end: NaiveTime,
    pub cutoff: Option<NaiveTime>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Exception {
    pub from: NaiveDate,
    pub through: NaiveDate,
    pub closed: bool,
    pub windows: Vec<Window>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default = "selection_required_default")]
    pub selection_required: bool,
    pub windows: Vec<Window>,
    /// None means each operating window is a fixed delivery slot.
    pub duration_minutes: Option<i64>,
    pub spacing_minutes: i64,
    pub lead_minutes: i64,
    pub cutoff: Option<NaiveTime>,
    pub min_days: i64,
    pub max_days: i64,
    pub ttl_minutes: i64,
    pub release_before: String,
    pub exceptions: Vec<Exception>,
}
fn selection_required_default() -> bool {
    true
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        if self.windows.len() > 28
            || self.exceptions.len() > 100
            || !(0..=30).contains(&self.min_days)
            || !(self.min_days..=60).contains(&self.max_days)
            || !(0..=10080).contains(&self.lead_minutes)
            || !(0..=1440).contains(&self.spacing_minutes)
            || !(1..=30).contains(&self.ttl_minutes)
            || self
                .duration_minutes
                .is_some_and(|n| !(15..=1440).contains(&n))
            || !["never", "confirmed", "fulfilling", "shipped"]
                .contains(&self.release_before.as_str())
        {
            return Err(Error::Invalid("Invalid scheduling limits".into()));
        }
        for windows in
            std::iter::once(&self.windows).chain(self.exceptions.iter().map(|e| &e.windows))
        {
            if windows.len() > 28
                || windows.iter().any(|w| {
                    w.weekday > 6
                        || w.start >= w.end
                        || (w.end - w.start).num_minutes() < 15
                        || w.start.second() != 0
                        || w.end.second() != 0
                        || w.start.nanosecond() != 0
                        || w.end.nanosecond() != 0
                })
            {
                return Err(Error::Invalid(
                    "Operating windows must be ordered within a day; weekday is Monday=0".into(),
                ));
            }
            for (i, w) in windows.iter().enumerate() {
                if windows[i + 1..]
                    .iter()
                    .any(|v| v.weekday == w.weekday && w.start < v.end && v.start < w.end)
                {
                    return Err(Error::Invalid("Operating windows overlap".into()));
                }
            }
        }
        for (i, e) in self.exceptions.iter().enumerate() {
            if e.from > e.through
                || self.exceptions[i + 1..]
                    .iter()
                    .any(|v| e.from <= v.through && v.from <= e.through)
            {
                return Err(Error::Invalid(
                    "Calendar exceptions overlap or have invalid dates".into(),
                ));
            }
        }
        Ok(())
    }
    pub fn windows_for(&self, date: NaiveDate) -> Vec<&Window> {
        let windows = match self
            .exceptions
            .iter()
            .find(|e| e.from <= date && date <= e.through)
        {
            Some(e) if e.closed => return vec![],
            Some(e) => &e.windows,
            None => &self.windows,
        };
        windows
            .iter()
            .filter(|w| w.weekday == date.weekday().num_days_from_monday())
            .collect()
    }
}
#[derive(Clone, Serialize, Deserialize, FromRow)]
pub struct Schedule {
    #[serde(skip_deserializing)]
    pub entity_id: i64,
    pub id: Uuid,
    pub source_id: Uuid,
    pub area_id: Option<Uuid>,
    pub method: String,
    pub enabled: bool,
    pub timezone: String,
    pub config: serde_json::Value,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Slot {
    pub schedule_id: Uuid,
    pub source_id: Uuid,
    pub method: String,
    pub timezone: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub availability: String,
}
pub async fn timezone_valid(tx: &mut Tx<'_>, zone: &str) -> Result<()> {
    let valid: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=$1)")
            .bind(zone)
            .fetch_one(&mut **tx)
            .await?;
    if !valid {
        return Err(Error::Invalid("Unknown IANA timezone".into()));
    }
    Ok(())
}
pub async fn generate(tx: &mut Tx<'_>, schedule: &Schedule, date: NaiveDate) -> Result<Vec<Slot>> {
    generate_mode(tx, schedule, date, false).await
}
pub async fn generate_operational(
    tx: &mut Tx<'_>,
    schedule: &Schedule,
    date: NaiveDate,
) -> Result<Vec<Slot>> {
    generate_mode(tx, schedule, date, true).await
}
async fn generate_mode(
    tx: &mut Tx<'_>,
    schedule: &Schedule,
    date: NaiveDate,
    operational: bool,
) -> Result<Vec<Slot>> {
    if !operational && !schedule.enabled {
        return Ok(vec![]);
    }
    let c: Config = serde_json::from_value(schedule.config.clone()).map_err(|_| Error::Internal)?;
    c.validate()?;
    let (now,today,time):(DateTime<Utc>,NaiveDate,NaiveTime)=sqlx::query_as("SELECT clock_timestamp(),(clock_timestamp() AT TIME ZONE $1)::date,(clock_timestamp() AT TIME ZONE $1)::time").bind(&schedule.timezone).fetch_one(&mut **tx).await?;
    let days = (date - today).num_days();
    if !operational
        && (days < c.min_days
            || days > c.max_days
            || (days == 0 && c.cutoff.is_some_and(|t| time >= t)))
    {
        return Ok(vec![]);
    }
    let mut local_starts = vec![];
    let mut local_ends = vec![];
    for w in c.windows_for(date) {
        if !operational && days == 0 && w.cutoff.is_some_and(|t| time >= t) {
            continue;
        }
        let mut start = date.and_time(w.start);
        let end = date.and_time(w.end);
        let duration = Duration::minutes(c.duration_minutes.unwrap_or((end - start).num_minutes()));
        while start + duration <= end {
            local_starts.push(start);
            local_ends.push(start + duration);
            start += duration + Duration::minutes(c.spacing_minutes);
        }
    }
    // One conversion query per schedule, not per window. Reject gaps and repeated local hours.
    let rows: Vec<(DateTime<Utc>, DateTime<Utc>)> = sqlx::query_as(
        r#"
      SELECT a AT TIME ZONE $3,b AT TIME ZONE $3 FROM unnest($1::timestamp[],$2::timestamp[]) t(a,b)
      WHERE (a AT TIME ZONE $3) AT TIME ZONE $3=a AND (b AT TIME ZONE $3) AT TIME ZONE $3=b
      AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY[-120,-60,-30,30,60,120]) m
        WHERE ((a AT TIME ZONE $3)+m*interval '1 minute') AT TIME ZONE $3=a
           OR ((b AT TIME ZONE $3)+m*interval '1 minute') AT TIME ZONE $3=b)
    "#,
    )
    .bind(local_starts)
    .bind(local_ends)
    .bind(&schedule.timezone)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|(start, end)| {
            (operational || *start >= now + Duration::minutes(c.lead_minutes)) && end > start
        })
        .map(|(starts_at, ends_at)| Slot {
            schedule_id: schedule.id,
            source_id: schedule.source_id,
            method: schedule.method.clone(),
            timezone: schedule.timezone.clone(),
            starts_at,
            ends_at,
            availability: "AVAILABLE".into(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        serde_json::from_value(serde_json::json!({"windows":[{"weekday":0,"start":"09:00:00","end":"13:00:00","cutoff":null}],"duration_minutes":60,"spacing_minutes":0,"lead_minutes":120,"cutoff":null,"min_days":0,"max_days":14,"ttl_minutes":10,"release_before":"fulfilling","exceptions":[]})).unwrap()
    }
    #[test]
    fn calendar_closures_and_split_windows() {
        let mut c = config();
        c.validate().unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 9, 28).unwrap();
        assert_eq!(c.windows_for(date).len(), 1);
        c.exceptions.push(Exception {
            from: date,
            through: date,
            closed: true,
            windows: vec![],
        });
        assert!(c.windows_for(date).is_empty());
    }
    #[test]
    fn rejects_unbounded_and_overlapping_rules() {
        let mut c = config();
        c.duration_minutes = Some(0);
        assert!(c.validate().is_err());
        c = config();
        c.windows.push(c.windows[0].clone());
        assert!(c.validate().is_err());
        c = config();
        c.max_days = 1000;
        assert!(c.validate().is_err());
    }
}
