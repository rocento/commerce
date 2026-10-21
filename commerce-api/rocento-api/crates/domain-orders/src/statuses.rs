//! Display-status configuration cannot perform financial or fulfillment transitions.
use crate::Service;
use domain_admin_iam::Identity;
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use std::collections::BTreeMap;
use uuid::Uuid;

pub const STATES: &[&str] = &[
    "placed",
    "confirmed",
    "fulfilling",
    "shipped",
    "delivered",
    "cash_collected",
    "cancelled",
    "delivery_failed",
    "pickup_ready",
    "picked_up",
];
#[derive(Serialize, FromRow)]
pub struct Definition {
    pub id: Uuid,
    pub code: String,
    pub state: String,
    pub label: String,
    pub translations: Value,
    pub description: String,
    pub tone: String,
    pub customer_visible: bool,
    pub is_default: bool,
    pub is_system: bool,
    pub active: bool,
    pub revision: i64,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub code: String,
    pub state: String,
    pub label: String,
    #[serde(default)]
    pub translations: BTreeMap<String, String>,
    #[serde(default)]
    pub description: String,
    pub tone: String,
    pub customer_visible: bool,
    pub is_default: bool,
    pub active: bool,
    pub expected_revision: i64,
    pub reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Assignment {
    pub code: String,
    pub expected_revision: i64,
    pub reason: String,
}
#[derive(Serialize, FromRow)]
pub struct LabelHistory {
    pub id: Uuid,
    pub order_id: Uuid,
    pub actor_id: Uuid,
    pub state: String,
    pub previous_code: String,
    pub code: String,
    pub previous_label: String,
    pub label: String,
    pub reason: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}
fn reason(value: &str) -> Result<()> {
    if !(3..=500).contains(&value.trim().chars().count()) {
        return Err(Error::Invalid("Enter a reason of 3–500 characters".into()));
    }
    Ok(())
}
fn validate(i: &Input) -> Result<()> {
    reason(&i.reason)?;
    if !(2..=48).contains(&i.code.len())
        || !i.code.as_bytes()[0].is_ascii_lowercase()
        || !i
            .code
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
    {
        return Err(Error::Invalid("Use a stable lowercase status code of 2–48 letters, digits or underscores, starting with a letter".into()));
    }
    if !STATES.contains(&i.state.as_str()) {
        return Err(Error::Invalid("Choose a supported workflow stage".into()));
    }
    if !(1..=80).contains(&i.label.trim().chars().count()) || i.description.chars().count() > 500 {
        return Err(Error::Invalid(
            "Enter a label of 1–80 characters and a description of at most 500 characters".into(),
        ));
    }
    if !["neutral", "info", "success", "warning", "danger"].contains(&i.tone.as_str()) {
        return Err(Error::Invalid("Invalid status color".into()));
    }
    if i.is_default && (!i.active || !i.customer_visible) {
        return Err(Error::Invalid(
            "A default status must be active and visible to customers".into(),
        ));
    }
    if i.translations.len() > 50
        || i.translations.iter().any(|(k, v)| {
            k.len() < 2
                || k.len() > 16
                || !k.bytes().all(|c| c.is_ascii_alphabetic() || c == b'-')
                || v.trim().is_empty()
                || v.chars().count() > 80
        })
    {
        return Err(Error::Invalid("Invalid translated label or locale".into()));
    }
    Ok(())
}
impl Service {
    pub async fn status_definitions(&self, who: &Identity) -> Result<Vec<Definition>> {
        if who.require("orders.statuses.read").is_err() {
            who.require("orders.read")?;
        }
        Ok(sqlx::query_as(
            "SELECT * FROM orders.status_definitions ORDER BY state,is_default DESC,label,code",
        )
        .fetch_all(&self.pool)
        .await?)
    }
    pub async fn save_status_definition(
        &self,
        code: Option<&str>,
        i: Input,
        who: &Identity,
    ) -> Result<Definition> {
        who.require("orders.statuses.manage")?;
        who.require("orders.statuses.read")?;
        validate(&i)?;
        let mut tx = self.pool.begin().await?;
        // Serialize registry changes and assignments to prevent default/archive races.
        sqlx::query("SELECT pg_advisory_xact_lock(7060040600)")
            .execute(&mut *tx)
            .await?;
        let old: Option<Definition> = if let Some(code) = code {
            Some(
                sqlx::query_as("SELECT * FROM orders.status_definitions WHERE code=$1 FOR UPDATE")
                    .bind(code)
                    .fetch_optional(&mut *tx)
                    .await?
                    .ok_or(Error::NotFound)?,
            )
        } else {
            None
        };
        if let Some(old) = &old {
            if old.revision != i.expected_revision {
                return Err(Error::Conflict);
            }
            if old.code != i.code || old.state != i.state {
                return Err(Error::Invalid(
                    "Status code and workflow stage cannot be changed after creation".into(),
                ));
            }
            if old.is_system && !i.active {
                return Err(Error::Invalid(
                    "Built-in statuses cannot be archived".into(),
                ));
            }
            if old.is_default && !i.is_default {
                return Err(Error::Invalid(
                    "Choose another default for this stage before changing this status".into(),
                ));
            }
        } else {
            if i.expected_revision != 0 {
                return Err(Error::Conflict);
            }
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM orders.status_definitions WHERE code=$1)",
            )
            .bind(&i.code)
            .fetch_one(&mut *tx)
            .await?;
            if exists {
                return Err(Error::Conflict);
            }
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM orders.status_definitions")
                .fetch_one(&mut *tx)
                .await?;
            if count >= 200 {
                return Err(Error::Invalid("At most 200 statuses are supported".into()));
            }
        }
        if i.is_default {
            sqlx::query("UPDATE orders.status_definitions SET is_default=false,revision=revision+1,updated_at=clock_timestamp() WHERE state=$1 AND is_default AND code<>$2").bind(&i.state).bind(&i.code).execute(&mut *tx).await?;
        }
        let saved:Definition=sqlx::query_as("INSERT INTO orders.status_definitions(code,state,label,translations,description,tone,customer_visible,is_default,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(code) DO UPDATE SET label=excluded.label,translations=excluded.translations,description=excluded.description,tone=excluded.tone,customer_visible=excluded.customer_visible,is_default=excluded.is_default,active=excluded.active,revision=orders.status_definitions.revision+1,updated_at=clock_timestamp() RETURNING *")
   .bind(&i.code).bind(&i.state).bind(i.label.trim()).bind(json!(i.translations)).bind(i.description.trim()).bind(&i.tone).bind(i.customer_visible).bind(i.is_default).bind(i.active).fetch_one(&mut *tx).await?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "admin.order_status.saved",
            saved.id,
            json!({"before":old,"after":saved,"reason":i.reason.trim()}),
        )
        .await?;
        tx.commit().await?;
        Ok(saved)
    }
    pub async fn assign_order_status(&self, id: Uuid, i: Assignment, who: &Identity) -> Result<()> {
        who.require("orders.write")?;
        reason(&i.reason)?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(7060040600)")
            .execute(&mut *tx)
            .await?;
        let (state, previous, revision): (String, String, i64) = sqlx::query_as(
            "SELECT status,status_code,status_revision FROM orders.orders WHERE id=$1 FOR UPDATE",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::NotFound)?;
        if revision != i.expected_revision {
            return Err(Error::Conflict);
        }
        let target: Definition =
            sqlx::query_as("SELECT * FROM orders.status_definitions WHERE code=$1")
                .bind(&i.code)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(Error::NotFound)?;
        if !target.active || target.state != state {
            return Err(Error::Invalid("Choose an active status in the order's current workflow stage. Use order actions to change stages.".into()));
        }
        if previous == i.code {
            tx.commit().await?;
            return Ok(());
        }
        let previous_label: String =
            sqlx::query_scalar("SELECT label FROM orders.status_definitions WHERE code=$1")
                .bind(&previous)
                .fetch_one(&mut *tx)
                .await?;
        sqlx::query(
            "UPDATE orders.orders SET status_code=$2,updated_at=clock_timestamp() WHERE id=$1",
        )
        .bind(id)
        .bind(&i.code)
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO orders.status_label_history(order_id,actor_id,state,previous_code,code,previous_label,label,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(id).bind(who.user.id).bind(&state).bind(&previous).bind(&i.code).bind(&previous_label).bind(&target.label).bind(i.reason.trim()).execute(&mut *tx).await?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "admin.order.status_label_changed",
            id,
            json!({"state":state,"from":previous,"to":i.code,"reason":i.reason.trim()}),
        )
        .await?;
        infra_events::record(
            &mut tx,
            "order.status_label_changed",
            json!({"order_id":id,"state":state,"status_code":i.code}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn order_status_history(
        &self,
        id: Uuid,
        who: &Identity,
    ) -> Result<Vec<LabelHistory>> {
        who.require("orders.read")?;
        Ok(sqlx::query_as("SELECT * FROM orders.status_label_history WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200").bind(id).fetch_all(&self.pool).await?)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Input {
        Input {
            code: "picking".into(),
            state: "fulfilling".into(),
            label: "Picking".into(),
            translations: BTreeMap::new(),
            description: String::new(),
            tone: "info".into(),
            customer_visible: true,
            is_default: false,
            active: true,
            expected_revision: 0,
            reason: "Warehouse progress".into(),
        }
    }
    #[test]
    fn rejects_invalid_definitions() {
        for code in ["", "a", "Picking", "../paid"] {
            let mut i = input();
            i.code = code.into();
            assert!(validate(&i).is_err());
        }
        let mut i = input();
        i.state = "paid".into();
        assert!(validate(&i).is_err());
    }
    #[test]
    fn defaults_must_be_visible_and_active() {
        let mut i = input();
        i.is_default = true;
        i.customer_visible = false;
        assert!(validate(&i).is_err());
        i.customer_visible = true;
        i.active = false;
        assert!(validate(&i).is_err());
    }
    #[test]
    fn validates_translations_and_reason() {
        let mut i = input();
        i.translations.insert("ar".into(), "جارٍ التجهيز".into());
        assert!(validate(&i).is_ok());
        i.reason = " ".into();
        assert!(validate(&i).is_err());
    }
}
