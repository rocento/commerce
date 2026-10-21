//! Deterministic merchandising rules. Money stays decimal, discounts never exceed eligible items.
pub mod recommendations;
use chrono::{DateTime, Utc};
use domain_inventory::Tx;
use infra_auth::{Error, Result};
use rust_decimal::{prelude::ToPrimitive, Decimal, RoundingStrategy};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;
#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
}
#[derive(Serialize, Deserialize, FromRow, Clone)]
pub struct Rule {
    pub entity_id: i64,
    pub id: Uuid,
    pub name: String,
    pub scope: String,
    pub kind: String,
    #[serde(with = "rust_decimal::serde::str")]
    pub value: Decimal,
    pub coupon_code: Option<String>,
    #[serde(with = "rust_decimal::serde::str")]
    pub min_subtotal: Decimal,
    pub skus: Vec<String>,
    pub category_ids: Vec<Uuid>,
    pub customer_group: String,
    pub priority: i32,
    pub active: bool,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleInput {
    pub name: String,
    pub scope: String,
    pub kind: String,
    #[serde(with = "rust_decimal::serde::str")]
    pub value: Decimal,
    pub coupon_code: Option<String>,
    #[serde(with = "rust_decimal::serde::str")]
    pub min_subtotal: Decimal,
    pub skus: Vec<String>,
    pub category_ids: Vec<Uuid>,
    pub customer_group: String,
    pub priority: i32,
    pub active: bool,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
}
#[derive(Serialize, Deserialize, PartialEq, Clone)]
pub struct Applied {
    pub rule_id: Uuid,
    pub name: String,
    pub scope: String,
    pub kind: String,
    #[serde(with = "rust_decimal::serde::str")]
    pub value: Decimal,
    pub coupon_code: Option<String>,
    #[serde(with = "rust_decimal::serde::str")]
    pub amount: Decimal,
}
pub struct Line {
    pub product_id: Uuid,
    pub sku: String,
    pub category_id: Option<Uuid>,
    pub price: Decimal,
    pub quantity: i32,
}
#[derive(Serialize, Deserialize)]
pub struct Assessment {
    #[serde(with = "rust_decimal::serde::str")]
    pub amount: Decimal,
    pub applied: Vec<Applied>,
    pub lines: Vec<Vec<Applied>>,
    pub coupon_code: Option<String>,
    pub coupon_error: Option<String>,
}
pub fn normalize_code(code: &str) -> Result<Option<String>> {
    let c = code.trim().to_ascii_uppercase();
    if c.is_empty() {
        return Ok(None);
    }
    if c.len() > 40
        || !c
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
    {
        return Err(Error::Invalid(
            "Coupon codes use 1–40 letters, numbers, hyphens or underscores".into(),
        ));
    }
    Ok(Some(c))
}
fn cents(d: Decimal) -> Decimal {
    d.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
}
fn discount(r: &Rule, base: Decimal, quantity: i32) -> Decimal {
    cents(if r.kind == "percentage" {
        base * r.value / Decimal::from(100)
    } else {
        r.value * Decimal::from(quantity)
    })
    .min(base)
}
// Compute floor(a*b/divisor) in integer cents without a potentially overflowing product.
fn allocate(amount: Decimal, line: Decimal, base: Decimal) -> Decimal {
    let a = (amount * Decimal::from(100))
        .to_u128()
        .expect("nonnegative money");
    let b = (line * Decimal::from(100))
        .to_u128()
        .expect("nonnegative money");
    let divisor = (base * Decimal::from(100))
        .to_u128()
        .expect("positive money");
    let mut quotient = 0u128;
    let mut remainder = 0u128;
    for bit in (0..128).rev() {
        quotient *= 2;
        remainder = remainder * 2 + if (b >> bit) & 1 == 1 { a } else { 0 };
        quotient += remainder / divisor;
        remainder %= divisor;
    }
    Decimal::from_i128_with_scale(quotient as i128, 2)
}
fn matches(r: &Rule, l: &Line) -> bool {
    (r.skus.is_empty() || r.skus.contains(&l.sku))
        && (r.category_ids.is_empty() || l.category_id.is_some_and(|c| r.category_ids.contains(&c)))
}
fn applied(r: &Rule, amount: Decimal) -> Applied {
    Applied {
        rule_id: r.id,
        name: r.name.clone(),
        scope: r.scope.clone(),
        kind: r.kind.clone(),
        value: r.value,
        coupon_code: r.coupon_code.clone(),
        amount,
    }
}
fn group_matches(r: &Rule, group: &str) -> bool {
    r.customer_group == "all"
        || r.customer_group == group
        || (r.customer_group == "registered" && group == "verified")
}
impl Service {
    pub async fn list(&self) -> Result<Vec<Rule>> {
        Ok(sqlx::query_as(
            "SELECT * FROM pricing_promotions.rules ORDER BY priority DESC,id LIMIT 100",
        )
        .fetch_all(&self.pool)
        .await?)
    }
    pub async fn save(
        &self,
        id: Option<Uuid>,
        mut i: RuleInput,
        who: &domain_admin_iam::Identity,
    ) -> Result<Rule> {
        who.require("promotions.write")?;
        i.coupon_code = normalize_code(i.coupon_code.as_deref().unwrap_or(""))?;
        i.name = i.name.trim().to_owned();
        if i.name.is_empty()
            || i.name.len() > 100
            || !["catalog", "cart"].contains(&i.scope.as_str())
            || !["percentage", "fixed"].contains(&i.kind.as_str())
            || i.value <= Decimal::ZERO
            || i.value > Decimal::from(1000000)
            || i.value.scale() > 2
            || (i.kind == "percentage" && i.value > Decimal::from(100))
            || i.min_subtotal < Decimal::ZERO
            || i.min_subtotal > Decimal::from(1000000000)
            || i.min_subtotal.scale() > 2
            || (i.scope == "catalog" && i.coupon_code.is_some())
            || !(0..=10000).contains(&i.priority)
            || !["all", "guest", "registered", "verified"].contains(&i.customer_group.as_str())
            || i.skus.len() > 100
            || i.category_ids.len() > 100
            || i.skus.iter().any(|s| s.trim().is_empty() || s.len() > 100)
            || i.starts_at.zip(i.ends_at).is_some_and(|(s, e)| s >= e)
        {
            return Err(Error::Invalid(
                "Invalid promotion: check name, discount, conditions and schedule".into(),
            ));
        }
        i.skus.sort();
        i.skus.dedup();
        i.category_ids.sort();
        i.category_ids.dedup();
        let mut tx = domain_inventory::begin(&self.pool).await?;
        let before: Option<Rule> = if let Some(id) = id {
            sqlx::query_as("SELECT * FROM pricing_promotions.rules WHERE id=$1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
        } else {
            None
        };
        if id.is_some() && before.is_none() {
            return Err(Error::NotFound);
        }
        if id.is_none() {
            let n: i64 = sqlx::query_scalar("SELECT count(*) FROM pricing_promotions.rules")
                .fetch_one(&mut *tx)
                .await?;
            if n >= 100 {
                return Err(Error::Invalid(
                    "At most 100 promotions are supported".into(),
                ));
            }
        }
        let id = id.unwrap_or_else(Uuid::new_v4);
        let duplicate: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM pricing_promotions.rules WHERE coupon_code=$1 AND id<>$2)",
        )
        .bind(&i.coupon_code)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        if duplicate {
            return Err(Error::Invalid("That coupon code is already in use".into()));
        }
        let r=sqlx::query_as("INSERT INTO pricing_promotions.rules(id,name,scope,kind,value,coupon_code,min_subtotal,skus,category_ids,customer_group,priority,active,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO UPDATE SET name=$2,scope=$3,kind=$4,value=$5,coupon_code=$6,min_subtotal=$7,skus=$8,category_ids=$9,customer_group=$10,priority=$11,active=$12,starts_at=$13,ends_at=$14,updated_at=clock_timestamp() RETURNING *")
            .bind(id).bind(&i.name).bind(&i.scope).bind(&i.kind).bind(i.value).bind(&i.coupon_code).bind(i.min_subtotal).bind(&i.skus).bind(&i.category_ids).bind(&i.customer_group).bind(i.priority).bind(i.active).bind(i.starts_at).bind(i.ends_at).fetch_one(&mut *tx).await?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "admin.promotion.saved",
            id,
            json!({"before":before,"after":i}),
        )
        .await?;
        tx.commit().await?;
        Ok(r)
    }
    pub async fn delete(&self, id: Uuid, who: &domain_admin_iam::Identity) -> Result<()> {
        who.require("promotions.write")?;
        let mut tx = domain_inventory::begin(&self.pool).await?;
        let old: Rule =
            sqlx::query_as("DELETE FROM pricing_promotions.rules WHERE id=$1 RETURNING *")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(Error::NotFound)?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "admin.promotion.deleted",
            id,
            json!(old),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn assess(
        tx: &mut Tx<'_>,
        customer: Option<Uuid>,
        lines: &[Line],
        code: Option<String>,
        strict: bool,
    ) -> Result<Assessment> {
        let context = AssessmentContext::load(tx, customer).await?;
        let mut values = std::collections::HashMap::new();
        if context.needs_values() {
            let ids: Vec<Uuid> = lines.iter().map(|l| l.product_id).collect();
            let rows: Vec<(Uuid, Value)> =
                sqlx::query_as("SELECT id,attributes FROM catalog.products WHERE id=ANY($1)")
                    .bind(ids)
                    .fetch_all(&mut **tx)
                    .await?;
            values.extend(rows);
        }
        let result = context.assess(lines, &values, code);
        if strict {
            if let Some(e) = &result.coupon_error {
                return Err(Error::Invalid(e.clone()));
            }
        }
        Ok(result)
    }
}
/// One policy snapshot, reusable across independent single-product assessments.
pub(crate) struct AssessmentContext {
    group: String,
    rules: Vec<Rule>,
    defs: Vec<domain_attributes::Definition>,
    conditions: Vec<(Uuid, Value)>,
}
impl AssessmentContext {
    pub(crate) async fn load(tx: &mut Tx<'_>, customer: Option<Uuid>) -> Result<Self> {
        let verified: bool = if let Some(id) = customer {
            sqlx::query_scalar("SELECT verified FROM customers.customers WHERE id=$1")
                .bind(id)
                .fetch_one(&mut **tx)
                .await?
        } else {
            false
        };
        let group = if verified {
            "verified"
        } else if customer.is_some() {
            "registered"
        } else {
            "guest"
        };
        let rules:Vec<Rule>=sqlx::query_as("SELECT * FROM pricing_promotions.rules WHERE active AND (starts_at IS NULL OR starts_at<=clock_timestamp()) AND (ends_at IS NULL OR ends_at>clock_timestamp()) ORDER BY priority DESC,id LIMIT 100").fetch_all(&mut **tx).await?;
        let defs = domain_attributes::definitions(tx, "product").await?;
        let conditions: Vec<(Uuid, Value)> = sqlx::query_as(
            "SELECT rule_id,conditions FROM pricing_promotions.attribute_conditions",
        )
        .fetch_all(&mut **tx)
        .await?;
        Ok(Self {
            group: group.into(),
            rules,
            defs,
            conditions,
        })
    }
    fn needs_values(&self) -> bool {
        self.conditions
            .iter()
            .any(|(_, v)| v.as_object().is_some_and(|o| !o.is_empty()))
    }
    pub(crate) fn assess(
        &self,
        lines: &[Line],
        values: &std::collections::HashMap<Uuid, Value>,
        code: Option<String>,
    ) -> Assessment {
        let mut rules = self.rules.clone();
        let conditions = &self.conditions;
        let defs = &self.defs;
        rules.retain_mut(|r| {
            if let Some((_, condition)) = conditions.iter().find(|(id, _)| *id == r.id) {
                if let Some(object) = condition.as_object().filter(|o| !o.is_empty()) {
                    let eligible: Vec<String> = lines
                        .iter()
                        .filter(|l| {
                            matches(r, l)
                                && object.iter().all(|(code, expected)| {
                                    defs.iter().any(|d| {
                                        d.attribute_code == *code && d.used_for_promo_rules
                                    }) && values
                                        .get(&l.product_id)
                                        .and_then(|v| v.get(code))
                                        .is_some_and(|v| {
                                            v == expected
                                                || v.as_array()
                                                    .is_some_and(|a| a.contains(expected))
                                        })
                                })
                        })
                        .map(|l| l.sku.clone())
                        .collect();
                    if eligible.is_empty() {
                        return false;
                    }
                    r.skus = eligible;
                }
            }
            true
        });
        evaluate(&rules, &self.group, lines, code)
    }
}
// Rules arrive in priority DESC, UUID ASC order. No best-price search or same-stage stacking.
pub fn evaluate(rules: &[Rule], group: &str, lines: &[Line], code: Option<String>) -> Assessment {
    let gross: Decimal = lines
        .iter()
        .map(|l| l.price * Decimal::from(l.quantity))
        .sum();
    let mut result = Assessment {
        amount: Decimal::ZERO,
        applied: vec![],
        lines: vec![vec![]; lines.len()],
        coupon_code: code.clone(),
        coupon_error: None,
    };
    let mut net: Vec<Decimal> = lines
        .iter()
        .map(|l| l.price * Decimal::from(l.quantity))
        .collect();
    for (n, l) in lines.iter().enumerate() {
        if let Some(r) = rules.iter().find(|r| {
            r.scope == "catalog"
                && group_matches(r, group)
                && gross >= r.min_subtotal
                && matches(r, l)
        }) {
            let amount = discount(r, net[n], l.quantity);
            if amount > Decimal::ZERO {
                result.lines[n].push(applied(r, amount));
                net[n] -= amount;
            }
        }
    }
    let subtotal: Decimal = net.iter().copied().sum();
    let eligible = |r: &Rule| {
        group_matches(r, group)
            && subtotal >= r.min_subtotal
            && lines
                .iter()
                .enumerate()
                .any(|(n, l)| matches(r, l) && net[n] > Decimal::ZERO)
    };
    let selected = if let Some(code) = code {
        let rule = rules
            .iter()
            .find(|r| r.scope == "cart" && r.coupon_code.as_deref() == Some(&code));
        match rule {
            None => {
                result.coupon_error =
                    Some("Coupon is unavailable, inactive or outside its schedule".into());
                None
            }
            Some(r) if !group_matches(r, group) => {
                result.coupon_error =
                    Some("Coupon is not available for your customer group".into());
                None
            }
            Some(r) if subtotal < r.min_subtotal => {
                result.coupon_error = Some(format!(
                    "Minimum cart value not met: ${:.2} required after catalog discounts",
                    r.min_subtotal
                ));
                None
            }
            Some(r) if !eligible(r) => {
                result.coupon_error = Some("Coupon has no eligible items in this cart".into());
                None
            }
            Some(r) => Some(r),
        }
    } else {
        rules
            .iter()
            .find(|r| r.scope == "cart" && r.coupon_code.is_none() && eligible(r))
    };
    if let Some(r) = selected {
        let mut base: Decimal = lines
            .iter()
            .enumerate()
            .filter(|(_, l)| matches(r, l))
            .map(|(n, _)| net[n])
            .sum();
        let mut remaining = discount(r, base, 1);
        for (n, l) in lines.iter().enumerate() {
            if !matches(r, l) || net[n] == Decimal::ZERO {
                continue;
            }
            // Proportional allocation in stable product order; last eligible line absorbs cents.
            let amount = if base == net[n] {
                remaining
            } else {
                allocate(remaining, net[n], base)
            };
            base -= net[n];
            remaining -= amount;
            if amount > Decimal::ZERO {
                result.lines[n].push(applied(r, amount));
            }
        }
    }
    for line in &result.lines {
        for a in line {
            result.amount += a.amount;
            if let Some(existing) = result.applied.iter_mut().find(|e| e.rule_id == a.rule_id) {
                existing.amount += a.amount;
            } else {
                result.applied.push(a.clone());
            }
        }
    }
    result
}

impl Service {
    pub async fn conditions(&self, id: Uuid, who: &domain_admin_iam::Identity) -> Result<Value> {
        who.require("promotions.read")?;
        Ok(sqlx::query_scalar(
            "SELECT conditions FROM pricing_promotions.attribute_conditions WHERE rule_id=$1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .unwrap_or(json!({})))
    }
    pub async fn save_conditions(
        &self,
        id: Uuid,
        value: Value,
        who: &domain_admin_iam::Identity,
    ) -> Result<Value> {
        who.require("promotions.write")?;
        let object = value
            .as_object()
            .filter(|o| o.len() <= 20)
            .ok_or_else(|| Error::Invalid("At most 20 attribute conditions".into()))?;
        let mut tx = domain_inventory::begin(&self.pool).await?;
        sqlx::query("SELECT pg_advisory_xact_lock(2002)")
            .execute(&mut *tx)
            .await?;
        let defs = domain_attributes::definitions(&mut tx, "product").await?;
        for (code, v) in object {
            let d = defs
                .iter()
                .find(|d| d.attribute_code == *code && d.used_for_promo_rules)
                .ok_or_else(|| Error::Invalid("Attribute is not enabled for promotions".into()))?;
            if d.input_type == "multiselect" {
                domain_attributes::validate_value(d, &json!([v]))?;
            } else {
                domain_attributes::validate_value(d, v)?;
            }
        }
        sqlx::query("INSERT INTO pricing_promotions.attribute_conditions(rule_id,conditions) VALUES($1,$2) ON CONFLICT(rule_id) DO UPDATE SET conditions=$2").bind(id).bind(&value).execute(&mut *tx).await?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "admin.promotion.attributes_updated",
            id,
            json!({"conditions":value}),
        )
        .await?;
        tx.commit().await?;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allocation_preserves_exact_cent_boundaries_and_large_values() {
        let d = |s: &str| s.parse::<Decimal>().unwrap();
        assert_eq!(allocate(d("0.03"), d("0.03"), d("0.09")), d("0.01"));
        assert_eq!(allocate(d("0.02"), d("0.03"), d("0.09")), d("0"));
        assert_eq!(
            allocate(
                d("1000000000000000000"),
                d("9999999999000000"),
                d("2000000000000000000")
            ),
            d("4999999999500000")
        );
    }
}
