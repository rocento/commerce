//! Bounded, parameterized merchandising rules over the published catalog.
use crate::{invalid, Product, Service};
use chrono::{DateTime, Utc};
use infra_auth::{Error, Result};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, QueryBuilder};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Related,
    Upsell,
    CrossSell,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Field {
    Sku,
    Category,
    ProductType,
    Price,
    Attribute,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operator {
    Eq,
    Ne,
    Gte,
    Lte,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Condition {
    pub field: Field,
    pub operator: Operator,
    pub value: String,
    #[serde(default)]
    pub attribute_code: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Conditions {
    pub any: bool,
    pub conditions: Vec<Condition>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub name: String,
    pub kind: Kind,
    pub active: bool,
    pub priority: i32,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
    pub result_limit: i32,
    pub stop_processing: bool,
    pub source: Conditions,
    pub target: Conditions,
    pub manual_ids: Vec<Uuid>,
    pub segment_ids: Vec<Uuid>,
    pub revision: i32,
}
#[derive(Serialize, Deserialize)]
pub struct Rule {
    pub id: Uuid,
    #[serde(flatten)]
    pub definition: Input,
    pub updated_at: DateTime<Utc>,
}
impl Conditions {
    fn validate(&self) -> Result<()> {
        if self.conditions.len() > 20 {
            return Err(invalid("At most 20 conditions per group"));
        }
        for c in &self.conditions {
            if c.value.trim().is_empty() || c.value.len() > 128 {
                return Err(invalid("Condition values must be 1–128 bytes"));
            }
            if !matches!(c.field, Field::Price)
                && !matches!(c.operator, Operator::Eq | Operator::Ne)
            {
                return Err(invalid("Only prices support range operators"));
            }
            if matches!(c.field, Field::Attribute) {
                if !c.attribute_code.as_ref().is_some_and(|code| {
                    !code.is_empty()
                        && code.len() <= 64
                        && code
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                }) {
                    return Err(invalid("Choose a valid promotion attribute"));
                }
            } else if c.attribute_code.is_some() {
                return Err(invalid(
                    "Attribute code is only valid for attribute conditions",
                ));
            }
            match c.field {
                Field::Price => {
                    let p = c
                        .value
                        .parse::<Decimal>()
                        .map_err(|_| invalid("Invalid price"))?;
                    if p < Decimal::ZERO {
                        return Err(invalid("Price cannot be negative"));
                    }
                }
                Field::Category => {
                    c.value
                        .parse::<Uuid>()
                        .map_err(|_| invalid("Category must be a UUID"))?;
                }
                Field::ProductType => {
                    if !["simple", "configurable", "bundle", "grouped"].contains(&c.value.as_str())
                    {
                        return Err(invalid("Invalid product type"));
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
    fn sql(&self, q: &mut QueryBuilder<'_, Postgres>) {
        q.push("(");
        if self.conditions.is_empty() {
            q.push("TRUE");
        }
        for (i, c) in self.conditions.iter().enumerate() {
            if i > 0 {
                q.push(if self.any { " OR " } else { " AND " });
            }
            if matches!(c.field, Field::Attribute) {
                // Recheck opt-in at evaluation time so revoked/disabled attributes fail closed.
                q.push("EXISTS(SELECT 1 FROM attributes.definitions d WHERE d.entity_type='product' AND d.used_for_promo_rules AND COALESCE(d.metadata->>'status','active')='active' AND d.input_type IN ('text','textarea','single_select','select','boolean','integer','decimal','price','date','datetime','long_text') AND d.attribute_code=")
                    .push_bind(c.attribute_code.clone().expect("validated code"))
                    .push(" AND jsonb_typeof(p.attributes->d.attribute_code) IN ('string','number','boolean') AND p.attributes->>d.attribute_code ")
                    .push(if matches!(c.operator,Operator::Ne){"<> "}else{"= "})
                    .push_bind(c.value.clone()).push(")");
            } else if matches!(c.field, Field::Category) {
                if matches!(c.operator, Operator::Ne) {
                    q.push("NOT ");
                }
                q.push("(")
                    .push_bind(c.value.parse::<Uuid>().expect("validated category"))
                    .push("=ANY(p.category_ids))");
            } else {
                q.push(match c.field {
                    Field::Sku => "p.sku",
                    Field::ProductType => "p.product_type",
                    Field::Price => "p.price",
                    _ => unreachable!(),
                });
                q.push(match c.operator {
                    Operator::Eq => " = ",
                    Operator::Ne => " <> ",
                    Operator::Gte => " >= ",
                    Operator::Lte => " <= ",
                });
                if matches!(c.field, Field::Price) {
                    q.push_bind(c.value.parse::<Decimal>().expect("validated price"));
                } else {
                    q.push_bind(c.value.clone());
                }
            }
        }
        q.push(")");
    }
}
impl Input {
    pub fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty()
            || self.name.len() > 120
            || self.priority < 1
            || !(1..=20).contains(&self.result_limit)
            || self.revision < 0
        {
            return Err(invalid(
                "Provide a name, positive priority, and result limit from 1 to 20",
            ));
        }
        if self
            .starts_at
            .zip(self.ends_at)
            .is_some_and(|(s, e)| s >= e)
        {
            return Err(invalid("End must be after start"));
        }
        if self.manual_ids.len() > 20 || self.segment_ids.len() > 20 {
            return Err(invalid("At most 20 manual products and segments"));
        }
        if self
            .manual_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != self.manual_ids.len()
        {
            return Err(invalid("Manual products must be unique"));
        }
        self.source.validate()?;
        self.target.validate()
    }
    pub fn eligible(&self, kind: &Kind, now: DateTime<Utc>, segments: &[Uuid]) -> bool {
        self.active
            && &self.kind == kind
            && self.starts_at.is_none_or(|s| s <= now)
            && self.ends_at.is_none_or(|e| now < e)
            && (self.segment_ids.is_empty()
                || self.segment_ids.iter().any(|id| segments.contains(id)))
    }
}
fn decode(
    (id, definition, revision, updated_at): (Uuid, Value, i32, DateTime<Utc>),
) -> Result<Rule> {
    let mut definition: Input = serde_json::from_value(definition).map_err(|_| Error::Internal)?;
    definition.revision = revision;
    definition.validate()?;
    Ok(Rule {
        id,
        definition,
        updated_at,
    })
}
impl Service {
    pub async fn relationship_rules(&self) -> Result<Vec<Rule>> {
        sqlx::query_as("SELECT id,definition,revision,updated_at FROM catalog.relationship_rules ORDER BY (definition->>'priority')::int,id LIMIT 201")
   .fetch_all(&self.pool).await?.into_iter().map(decode).collect()
    }
    pub async fn save_relationship_rule(
        &self,
        id: Option<Uuid>,
        mut input: Input,
        actor: Uuid,
    ) -> Result<Rule> {
        input.validate()?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(73190512)")
            .execute(&mut *tx)
            .await?;
        for (table, ids) in [
            ("catalog.products", &input.manual_ids),
            ("customers.segments", &input.segment_ids),
        ] {
            let count: i64 =
                sqlx::query_scalar(&format!("SELECT count(*) FROM {table} WHERE id=ANY($1)"))
                    .bind(ids)
                    .fetch_one(&mut *tx)
                    .await?;
            if count as usize != ids.iter().collect::<std::collections::HashSet<_>>().len() {
                return Err(invalid("A selected product or segment no longer exists"));
            }
        }
        for c in input
            .source
            .conditions
            .iter()
            .chain(&input.target.conditions)
        {
            if let Some(code) = &c.attribute_code {
                let allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attributes.definitions WHERE entity_type='product' AND attribute_code=$1 AND used_for_promo_rules AND COALESCE(metadata->>'status','active')='active' AND input_type IN ('text','textarea','single_select','select','boolean','integer','decimal','price','date','datetime','long_text'))").bind(code).fetch_one(&mut *tx).await?;
                if !allowed {
                    return Err(invalid(
                        "Attribute must be active, scalar, and enabled for promotion rules",
                    ));
                }
            }
        }
        let rule_id = id.unwrap_or_else(Uuid::new_v4);
        let before: Option<Value> =
            sqlx::query_scalar("SELECT definition FROM catalog.relationship_rules WHERE id=$1")
                .bind(rule_id)
                .fetch_optional(&mut *tx)
                .await?;
        if id.is_none() {
            if input.revision != 0 {
                return Err(Error::Conflict);
            }
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM catalog.relationship_rules")
                .fetch_one(&mut *tx)
                .await?;
            if count >= 200 {
                return Err(invalid("At most 200 relationship rules per catalog"));
            }
        }
        let expected = input.revision;
        input.revision = if id.is_some() {
            expected.checked_add(1).ok_or(Error::Conflict)?
        } else {
            1
        };
        let definition = serde_json::to_value(&input).map_err(|_| Error::Internal)?;
        let row = if id.is_some() {
            sqlx::query_as("UPDATE catalog.relationship_rules SET definition=$2,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$3 RETURNING id,definition,revision,updated_at")
    .bind(rule_id).bind(&definition).bind(expected).fetch_optional(&mut *tx).await?.ok_or(Error::Conflict)?
        } else {
            sqlx::query_as("INSERT INTO catalog.relationship_rules(id,definition) VALUES($1,$2) RETURNING id,definition,revision,updated_at").bind(rule_id).bind(&definition).fetch_one(&mut *tx).await?
        };
        sqlx::query("INSERT INTO admin_iam.audit_log(id,actor_id,action,entity_id,details) VALUES($1,$2,'catalog.relationship_saved',$3,$4)")
   .bind(Uuid::new_v4()).bind(actor).bind(rule_id).bind(json!({"before":before,"after":definition})).execute(&mut *tx).await?;
        infra_events::record(
            &mut tx,
            "catalog.relationship_saved",
            json!({"id":rule_id,"revision":input.revision}),
        )
        .await?;
        tx.commit().await?;
        decode(row)
    }
    pub async fn delete_relationship_rule(
        &self,
        id: Uuid,
        revision: i32,
        actor: Uuid,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let before:Value=sqlx::query_scalar("DELETE FROM catalog.relationship_rules WHERE id=$1 AND revision=$2 RETURNING definition").bind(id).bind(revision).fetch_optional(&mut *tx).await?.ok_or(Error::Conflict)?;
        sqlx::query("INSERT INTO admin_iam.audit_log(id,actor_id,action,entity_id,details) VALUES($1,$2,'catalog.relationship_deleted',$3,$4)").bind(Uuid::new_v4()).bind(actor).bind(id).bind(json!({"before":before})).execute(&mut *tx).await?;
        infra_events::record(&mut tx, "catalog.relationship_deleted", json!({"id":id})).await?;
        tx.commit().await?;
        Ok(())
    }
    /// Published products only. All source/cart IDs are excluded, manual picks precede rules.
    pub async fn relationship_candidates(
        &self,
        sources: &[Uuid],
        kind: Kind,
        segments: &[Uuid],
    ) -> Result<Vec<Product>> {
        if sources.is_empty() || sources.len() > 50 {
            return Err(invalid("Provide 1–50 source products"));
        }
        let rules = self.relationship_rules().await?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET LOCAL statement_timeout='2s'")
            .execute(&mut *tx)
            .await?;
        let mut automatic = Vec::new();
        let mut manual = Vec::new();
        let now = Utc::now();
        for rule in rules {
            let r = rule.definition;
            if !r.eligible(&kind, now, segments) {
                continue;
            }
            let mut q=QueryBuilder::new("SELECT EXISTS(SELECT 1 FROM catalog.storefront_products p WHERE p.active AND p.id=ANY(");
            q.push_bind(sources.to_vec()).push(") AND ");
            r.source.sql(&mut q);
            q.push(")");
            if !q.build_query_scalar::<bool>().fetch_one(&mut *tx).await? {
                continue;
            }
            let mut q=QueryBuilder::new("SELECT p.* FROM catalog.storefront_products p WHERE p.active AND p.parent_id IS NULL AND p.currency=(SELECT currency FROM catalog.storefront_products WHERE id=");
            q.push_bind(sources[0])
                .push(") AND NOT(p.id=ANY(")
                .push_bind(sources.to_vec())
                .push(")) AND (p.id=ANY(")
                .push_bind(r.manual_ids.clone())
                .push(") OR ");
            r.target.sql(&mut q);
            q.push(") ORDER BY array_position(")
                .push_bind(r.manual_ids.clone())
                .push(",p.id) NULLS LAST,p.id LIMIT ")
                .push_bind(r.result_limit);
            for p in q.build_query_as::<Product>().fetch_all(&mut *tx).await? {
                if r.manual_ids.contains(&p.id) {
                    manual.push(p);
                } else {
                    automatic.push(p);
                }
            }
            if r.stop_processing {
                break;
            }
        }
        tx.commit().await?;
        let mut seen = std::collections::HashSet::new();
        Ok(manual
            .into_iter()
            .chain(automatic)
            .filter(|p| seen.insert(p.id))
            .take(100)
            .collect())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Input {
        serde_json::from_value(json!({"name":"Related","kind":"related","active":true,"priority":1,"starts_at":null,"ends_at":null,"result_limit":4,"stop_processing":false,"source":{"any":false,"conditions":[]},"target":{"any":false,"conditions":[]},"manual_ids":[],"segment_ids":[],"revision":0})).unwrap()
    }
    #[test]
    fn limits_and_dates() {
        let mut r = input();
        assert!(r.validate().is_ok());
        r.result_limit = 21;
        assert!(r.validate().is_err());
        r.result_limit = 1;
        r.starts_at = Some(Utc::now());
        r.ends_at = r.starts_at;
        assert!(r.validate().is_err());
    }
    #[test]
    fn guest_cannot_match_segments() {
        let mut r = input();
        r.segment_ids = vec![Uuid::new_v4()];
        assert!(!r.eligible(&Kind::Related, Utc::now(), &[]));
        assert!(r.eligible(&Kind::Related, Utc::now(), &r.segment_ids));
        assert!(!r.eligible(&Kind::Upsell, Utc::now(), &r.segment_ids));
    }
    #[test]
    fn boundaries() {
        let mut r = input();
        let now = Utc::now();
        r.starts_at = Some(now);
        assert!(r.eligible(&Kind::Related, now, &[]));
        r.ends_at = Some(now);
        assert!(!r.eligible(&Kind::Related, now, &[]));
    }
    #[test]
    fn rejects_invalid_operands() {
        let mut r = input();
        r.target.conditions.push(Condition {
            field: Field::Sku,
            operator: Operator::Gte,
            value: "x".into(),
            attribute_code: None,
        });
        assert!(r.validate().is_err());
        r.target.conditions[0].field = Field::Price;
        assert!(r.validate().is_err());
    }
    #[test]
    fn values_are_bound() {
        let mut c = Conditions::default();
        c.conditions.push(Condition {
            field: Field::Sku,
            operator: Operator::Eq,
            value: "' OR TRUE --".into(),
            attribute_code: None,
        });
        assert!(c.validate().is_ok());
        let mut q = QueryBuilder::new("");
        c.sql(&mut q);
        assert_eq!(q.sql(), "(p.sku = $1)");
    }
}
