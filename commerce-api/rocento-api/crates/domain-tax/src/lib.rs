//! Configured geographic tax rules. No statutory rates are assumed.
use domain_inventory::Tx;
use infra_auth::{Error, Result};
use rust_decimal::{Decimal, RoundingStrategy};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;
#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
}
#[derive(Serialize, Deserialize, FromRow)]
pub struct Rule {
    pub entity_id: i64,
    pub id: Uuid,
    pub name: String,
    pub min_lat: f64,
    pub max_lat: f64,
    pub min_lon: f64,
    pub max_lon: f64,
    pub rate_bps: i32,
    pub tax_delivery: bool,
    pub priority: i32,
    pub active: bool,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleInput {
    pub name: String,
    pub min_lat: f64,
    pub max_lat: f64,
    pub min_lon: f64,
    pub max_lon: f64,
    pub rate_bps: i32,
    pub tax_delivery: bool,
    pub priority: i32,
    pub active: bool,
}
#[derive(Serialize, Deserialize, PartialEq)]
pub struct Assessment {
    pub rule_id: Option<Uuid>,
    pub name: String,
    pub rate_bps: i32,
    pub tax_delivery: bool,
    #[serde(with = "rust_decimal::serde::str")]
    pub taxable_base: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub amount: Decimal,
}
impl Service {
    pub async fn list(&self) -> Result<Vec<Rule>> {
        Ok(
            sqlx::query_as("SELECT * FROM tax.rules ORDER BY priority DESC,id LIMIT 100")
                .fetch_all(&self.pool)
                .await?,
        )
    }
    pub async fn save(
        &self,
        id: Option<Uuid>,
        i: RuleInput,
        who: &domain_admin_iam::Identity,
    ) -> Result<Rule> {
        who.require("tax.write")?;
        if i.name.trim().is_empty()
            || i.name.len() > 100
            || !i.min_lat.is_finite()
            || !i.max_lat.is_finite()
            || !i.min_lon.is_finite()
            || !i.max_lon.is_finite()
            || i.min_lat < -90.0
            || i.max_lat > 90.0
            || i.min_lon < -180.0
            || i.max_lon > 180.0
            || i.min_lat >= i.max_lat
            || i.min_lon >= i.max_lon
            || !(0..=10000).contains(&i.rate_bps)
            || !(0..=10000).contains(&i.priority)
        {
            return Err(Error::Invalid(
                "Invalid tax rule: check name, geographic bounds, rate and priority".into(),
            ));
        }
        let mut tx = domain_inventory::begin(&self.pool).await?;
        if let Some(id) = id {
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tax.rules WHERE id=$1)")
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await?;
            if !exists {
                return Err(Error::NotFound);
            }
        } else {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM tax.rules")
                .fetch_one(&mut *tx)
                .await?;
            if count >= 100 {
                return Err(Error::Invalid("At most 100 tax rules are supported".into()));
            }
        }
        let id = id.unwrap_or_else(Uuid::new_v4);
        let r=sqlx::query_as("INSERT INTO tax.rules(id,name,min_lat,max_lat,min_lon,max_lon,rate_bps,tax_delivery,priority,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET name=$2,min_lat=$3,max_lat=$4,min_lon=$5,max_lon=$6,rate_bps=$7,tax_delivery=$8,priority=$9,active=$10,updated_at=clock_timestamp() RETURNING *").bind(id).bind(i.name.trim()).bind(i.min_lat).bind(i.max_lat).bind(i.min_lon).bind(i.max_lon).bind(i.rate_bps).bind(i.tax_delivery).bind(i.priority).bind(i.active).fetch_one(&mut *tx).await?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "admin.tax_rule.saved",
            id,
            json!(i),
        )
        .await?;
        tx.commit().await?;
        Ok(r)
    }
    pub async fn assess(
        tx: &mut Tx<'_>,
        lat: f64,
        lon: f64,
        subtotal: Decimal,
        delivery: Decimal,
    ) -> Result<Assessment> {
        let rule:Option<Rule>=sqlx::query_as("SELECT * FROM tax.rules WHERE active AND $1 BETWEEN min_lat AND max_lat AND $2 BETWEEN min_lon AND max_lon ORDER BY priority DESC LIMIT 1").bind(lat).bind(lon).fetch_optional(&mut **tx).await?;
        let Some(r) = rule else {
            return Ok(Assessment {
                rule_id: None,
                name: "No tax applied".into(),
                rate_bps: 0,
                tax_delivery: false,
                taxable_base: Decimal::new(0, 2),
                amount: Decimal::new(0, 2),
            });
        };
        let base = subtotal
            + if r.tax_delivery {
                delivery
            } else {
                Decimal::ZERO
            };
        let amount = (base * Decimal::from(r.rate_bps) / Decimal::from(10000))
            .round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero);
        Ok(Assessment {
            rule_id: Some(r.id),
            name: r.name,
            rate_bps: r.rate_bps,
            tax_delivery: r.tax_delivery,
            taxable_base: base,
            amount,
        })
    }
}
