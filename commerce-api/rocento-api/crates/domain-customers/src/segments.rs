//! Persisted, bounded customer audiences. All SQL identifiers come from allowlists.
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, QueryBuilder};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub id: String,
    #[serde(rename = "type")]
    pub family: String,
    pub attribute: String,
    pub operator: String,
    pub value: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub name: String,
    pub description: String,
    pub status: String,
    pub website: String,
    pub apply_to: String,
    #[serde(rename = "match")]
    pub matching: String,
    pub rules: Vec<Rule>,
    pub revision: i32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub entity_id: i64,
    pub id: Uuid,
    #[serde(flatten)]
    pub definition: Input,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub matched_customers: i64,
    pub evaluated_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Clone, Serialize)]
pub struct Field {
    pub family: String,
    pub attribute: String,
    pub operators: Vec<String>,
}
#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
}

const TEXT_OPS: &[&str] = &["is", "is not", "contains", "does not contain"];
const NUMBER_OPS: &[&str] = &[
    "is",
    "is not",
    "equals or greater than",
    "equals or less than",
];
fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}

impl Service {
    /// Evaluate only the requested audiences for the authenticated customer.
    pub async fn matching_ids(&self, customer: Uuid, ids: &[Uuid]) -> Result<Vec<Uuid>> {
        let rows: Vec<(Uuid, Value)> =
            sqlx::query_as("SELECT id,definition FROM customers.segments WHERE id=ANY($1)")
                .bind(ids)
                .fetch_all(&self.pool)
                .await?;
        // Validation reads field metadata. Do it before holding a connection so
        // the bounded engagement worker can use a one-connection commerce pool.
        let mut definitions = Vec::new();
        for (id, definition) in rows {
            let input: Input = serde_json::from_value(definition).map_err(|_| Error::Internal)?;
            if input.status == "active" {
                self.validate(&input).await?;
                definitions.push((id, input));
            }
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET LOCAL statement_timeout='5s'")
            .execute(&mut *tx)
            .await?;
        let mut matched = Vec::new();
        for (id, input) in definitions {
            let mut q = QueryBuilder::<Postgres>::new(
                "SELECT EXISTS(SELECT 1 FROM customers.customers c WHERE c.id=",
            );
            q.push_bind(customer).push(" AND (");
            for (index, rule) in input.rules.iter().enumerate() {
                if index > 0 {
                    q.push(if input.matching == "all" {
                        " AND "
                    } else {
                        " OR "
                    });
                }
                Self::predicate(&mut q, rule);
            }
            q.push("))");
            if q.build_query_scalar::<bool>().fetch_one(&mut *tx).await? {
                matched.push(id);
            }
        }
        tx.commit().await?;
        Ok(matched)
    }

    pub async fn fields(&self) -> Result<Vec<Field>> {
        let mut fields = Vec::new();
        for (family, names, ops) in [
            (
                "customer",
                &[
                    "email",
                    "first_name",
                    "last_name",
                    "gender",
                    "customer_group",
                ][..],
                TEXT_OPS,
            ),
            (
                "order",
                &["orders_count", "orders_total", "average_order_value"][..],
                NUMBER_OPS,
            ),
            ("order", &["last_order_date"][..], &["after", "before"][..]),
            (
                "cart",
                &["cart_items_qty", "cart_line_count", "cart_subtotal"][..],
                NUMBER_OPS,
            ),
        ] {
            for name in names {
                fields.push(Field {
                    family: family.into(),
                    attribute: (*name).into(),
                    operators: ops.iter().map(|v| (*v).into()).collect(),
                });
            }
        }
        // Scalar custom attributes only. Multi-select and rich structured values need
        // an explicit membership operator before they can become segment rules.
        let custom:Vec<(String,String)>=sqlx::query_as("SELECT attribute_code,input_type FROM attributes.definitions WHERE entity_type='customer' AND used_for_promo_rules AND input_type IN ('text','textarea','select','boolean','number','date') ORDER BY attribute_code")
            .fetch_all(&self.pool).await?;
        for (code, input_type) in custom {
            let ops = match input_type.as_str() {
                "number" => NUMBER_OPS,
                "date" => &["after", "before"][..],
                _ => TEXT_OPS,
            };
            fields.push(Field {
                family: "customer".into(),
                attribute: format!("attribute:{code}"),
                operators: ops.iter().map(|v| (*v).into()).collect(),
            });
        }
        Ok(fields)
    }
    async fn validate(&self, input: &Input) -> Result<()> {
        infra_auth::bounded(&input.name, "Segment name", 160, true)?;
        infra_auth::bounded(&input.description, "Description", 2000, false)?;
        if !matches!(input.status.as_str(), "active" | "inactive")
            || !matches!(input.matching.as_str(), "all" | "any")
            || input.apply_to != "registered"
            || input.website != "Main Website"
            || input.rules.is_empty()
            || input.rules.len() > 20
            || input.revision < 0
        {
            return Err(invalid(
                "Use registered customers, Main Website, active/inactive status and 1–20 conditions",
            ));
        }
        let fields = self.fields().await?;
        let mut ids = std::collections::HashSet::new();
        for rule in &input.rules {
            if rule.id.is_empty() || rule.id.len() > 80 || !ids.insert(&rule.id) {
                return Err(invalid("Condition IDs must be unique"));
            }
            infra_auth::bounded(&rule.value, "Condition value", 500, true)?;
            let field = fields
                .iter()
                .find(|f| f.family == rule.family && f.attribute == rule.attribute)
                .ok_or_else(|| {
                    invalid("This condition field is not supported or no longer eligible")
                })?;
            if !field.operators.contains(&rule.operator) {
                return Err(invalid("Unsupported operator for this field"));
            }
            let numeric_field = field.family == "cart"
                || matches!(
                    field.attribute.as_str(),
                    "orders_count" | "orders_total" | "average_order_value"
                )
                || (field.attribute.starts_with("attribute:")
                    && field.operators
                        == NUMBER_OPS
                            .iter()
                            .map(|v| (*v).to_string())
                            .collect::<Vec<String>>());
            if numeric_field
                && (rule.value.len() > 32
                    || !rule.value.bytes().all(|b| b.is_ascii_digit() || b == b'.')
                    || rule
                        .value
                        .parse::<f64>()
                        .ok()
                        .filter(|v| v.is_finite() && *v >= 0.0)
                        .is_none())
            {
                return Err(invalid("Numeric conditions require a nonnegative decimal"));
            }
            if (field.attribute == "last_order_date"
                || (field.attribute.starts_with("attribute:")
                    && field.operators == ["after".to_string(), "before".to_string()]))
                && chrono::DateTime::parse_from_rfc3339(&rule.value).is_err()
            {
                return Err(invalid(
                    "Date conditions require an RFC3339 timestamp with timezone",
                ));
            }
        }
        Ok(())
    }

    fn predicate<'a>(query: &mut QueryBuilder<'a, Postgres>, rule: &'a Rule) {
        let expression = match (rule.family.as_str(), rule.attribute.as_str()) {
            ("customer", "email") => "c.email",
            ("customer", "first_name") => "c.first_name",
            ("customer", "last_name") => "c.last_name",
            ("customer", "gender") => "c.gender",
            ("customer", "customer_group") => "c.customer_group",
            ("order", "orders_count") => {
                "(SELECT count(*) FROM orders.orders o WHERE o.customer_id=c.id AND o.status IN ('delivered','cash_collected'))"
            }
            ("order", "orders_total") => {
                "(SELECT COALESCE(sum(o.total),0) FROM orders.orders o WHERE o.customer_id=c.id AND o.status IN ('delivered','cash_collected'))"
            }
            ("order", "average_order_value") => {
                "(SELECT COALESCE(avg(o.total),0) FROM orders.orders o WHERE o.customer_id=c.id AND o.status IN ('delivered','cash_collected'))"
            }
            ("order", "last_order_date") => {
                "(SELECT max(o.created_at) FROM orders.orders o WHERE o.customer_id=c.id AND o.status IN ('delivered','cash_collected'))"
            }
            ("cart", "cart_items_qty") => {
                "(SELECT COALESCE(sum(i.quantity),0) FROM cart_checkout.carts t JOIN cart_checkout.items i ON i.cart_id=t.id WHERE t.customer_id=c.id)"
            }
            ("cart", "cart_line_count") => {
                "(SELECT count(*) FROM cart_checkout.carts t JOIN cart_checkout.items i ON i.cart_id=t.id WHERE t.customer_id=c.id)"
            }
            ("cart", "cart_subtotal") => {
                "(SELECT COALESCE(sum(i.quantity*i.price),0) FROM cart_checkout.carts t JOIN cart_checkout.items i ON i.cart_id=t.id WHERE t.customer_id=c.id)"
            }
            _ => "",
        };
        query.push("COALESCE((");
        if expression.is_empty() {
            let code = rule.attribute.trim_start_matches("attribute:");
            if matches!(
                rule.operator.as_str(),
                "equals or greater than" | "equals or less than"
            ) {
                query
                    .push("NULLIF(c.attributes ->> ")
                    .push_bind(code)
                    .push(", '')::numeric");
            } else if matches!(rule.operator.as_str(), "after" | "before") {
                query
                    .push("NULLIF(c.attributes ->> ")
                    .push_bind(code)
                    .push(", '')::timestamptz");
            } else {
                query.push("c.attributes ->> ").push_bind(code);
            }
        } else {
            query.push(expression);
        }
        if rule.operator == "contains" || rule.operator == "does not contain" {
            // Escape SQL wildcard syntax so customer text is matched literally.
            query.push(if rule.operator == "contains" {
                " LIKE "
            } else {
                " NOT LIKE "
            });
            let value = rule
                .value
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            query.push_bind(format!("%{value}%"));
        } else {
            query.push(match rule.operator.as_str() {
                "is" => " = ",
                "is not" => " <> ",
                "equals or greater than" => " >= ",
                "equals or less than" => " <= ",
                "after" => " > ",
                "before" => " < ",
                _ => unreachable!("validated operator"),
            });
            query.push_bind(&rule.value);
            if rule.family == "cart"
                || matches!(
                    rule.attribute.as_str(),
                    "orders_count" | "orders_total" | "average_order_value"
                )
                || (rule.attribute.starts_with("attribute:")
                    && matches!(
                        rule.operator.as_str(),
                        "equals or greater than" | "equals or less than"
                    ))
            {
                query.push("::numeric");
            }
            if rule.attribute == "last_order_date"
                || (rule.attribute.starts_with("attribute:")
                    && matches!(rule.operator.as_str(), "after" | "before"))
            {
                query.push("::timestamptz");
            }
        }
        query.push("),false)");
    }
    pub async fn evaluate(&self, input: &Input) -> Result<(i64, chrono::DateTime<chrono::Utc>)> {
        self.validate(input).await?;
        let mut q = QueryBuilder::<Postgres>::new(
            "SELECT count(*)::bigint, statement_timestamp() FROM customers.customers c WHERE ",
        );
        for (index, rule) in input.rules.iter().enumerate() {
            if index > 0 {
                q.push(if input.matching == "all" {
                    " AND "
                } else {
                    " OR "
                });
            }
            Self::predicate(&mut q, rule);
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET LOCAL statement_timeout='5s'")
            .execute(&mut *tx)
            .await?;
        let result = q.build_query_as().fetch_one(&mut *tx).await?;
        tx.commit().await?;
        Ok(result)
    }
    pub async fn get(&self, id: Uuid) -> Result<Segment> {
        let (entity_id, definition, revision, updated_at): (
            i64,
            Value,
            i32,
            chrono::DateTime<chrono::Utc>,
        ) = sqlx::query_as(
            "SELECT entity_id,definition,revision,updated_at FROM customers.segments WHERE id=$1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(Error::NotFound)?;
        let mut input: Input = serde_json::from_value(definition).map_err(|_| Error::Internal)?;
        input.revision = revision;
        let (matched_customers, evaluated_at) = self.evaluate(&input).await?;
        Ok(Segment {
            id,
            entity_id,
            definition: input,
            updated_at,
            matched_customers,
            evaluated_at,
        })
    }
    pub async fn list(&self, offset: i64) -> Result<Vec<Segment>> {
        if !(0..=1_000_000).contains(&offset) {
            return Err(invalid("Invalid offset"));
        }
        let ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM customers.segments ORDER BY updated_at DESC,id LIMIT 50 OFFSET $1",
        )
        .bind(offset)
        .fetch_all(&self.pool)
        .await?;
        let mut rows = Vec::new();
        for id in ids {
            rows.push(self.get(id).await?);
        }
        Ok(rows)
    }
    pub async fn save(&self, id: Option<Uuid>, input: Input, actor: Uuid) -> Result<Segment> {
        self.validate(&input).await?;
        let definition = serde_json::to_value(&input).map_err(|_| Error::Internal)?;
        let mut tx = self.pool.begin().await?;
        let saved = match id {
            Some(id) => {
                let changed=sqlx::query("UPDATE customers.segments SET definition=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND revision=$3")
                    .bind(id).bind(definition).bind(input.revision).execute(&mut *tx).await?.rows_affected();
                if changed == 0 {
                    return Err(Error::Conflict);
                }
                id
            }
            None => {
                if input.revision != 0 {
                    return Err(invalid("New segments require revision 0"));
                }
                let id = Uuid::new_v4();
                sqlx::query("INSERT INTO customers.segments(id,definition) VALUES($1,$2)")
                    .bind(id)
                    .bind(definition)
                    .execute(&mut *tx)
                    .await?;
                id
            }
        };
        Self::audit(&mut tx, saved, actor, "customer.segment_saved").await?;
        tx.commit().await?;
        self.get(saved).await
    }
    pub async fn delete(&self, id: Uuid, revision: i32, actor: Uuid) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        if sqlx::query("DELETE FROM customers.segments WHERE id=$1 AND revision=$2")
            .bind(id)
            .bind(revision)
            .execute(&mut *tx)
            .await?
            .rows_affected()
            == 0
        {
            return Err(Error::Conflict);
        }
        Self::audit(&mut tx, id, actor, "customer.segment_deleted").await?;
        tx.commit().await?;
        Ok(())
    }
    async fn audit(
        tx: &mut sqlx::Transaction<'_, Postgres>,
        id: Uuid,
        actor: Uuid,
        action: &str,
    ) -> Result<()> {
        sqlx::query("INSERT INTO admin_iam.audit_log(id,actor_id,action,entity_id,details) VALUES($1,$2,$3,$4,'{}')")
            .bind(Uuid::new_v4()).bind(actor).bind(action).bind(id).execute(&mut **tx).await?;
        infra_events::record(tx, action, json!({"id":id,"actor_id":actor})).await?;
        Ok(())
    }
}
